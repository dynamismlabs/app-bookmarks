/**
 * Two-step import. A file arrives in parts, because one request is capped.
 * Preview parses it and stores the result under an expiring ID and digest
 * without changing a record. Apply applies exactly that result, once.
 */
import { TRPCError } from "@trpc/server";
import { mergeDuplicates, parseImport, parseLinkList, type ImportedLink, type ParsedFile } from "../domain/parse";
import { clock, type Bookmarks } from "./store";

const PREVIEW_MS = 60 * 60_000;
const MAX_FILE_CHARS = 32 * 1024 * 1024;
export interface PreviewInput { uploadId?: string; text?: string; fileName?: string | null }

const invalid = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });
async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function importsFor(t: Bookmarks) {
  const stamp = () => clock.now().toISOString();
  async function sweep() {
    await t.run("DELETE FROM import_previews WHERE expires_at < ?", stamp());
    await t.run("DELETE FROM import_parts WHERE created_at < ?", new Date(clock.now().getTime() - PREVIEW_MS).toISOString());
  }
  async function addPart(input: { uploadId: string; part: number; total: number; text: string }) {
    await t.run(
      "INSERT INTO import_parts (user_id, upload_id, part, created_at, total, text) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, upload_id, part) DO UPDATE SET text = excluded.text, total = excluded.total",
      t.userId, input.uploadId, input.part, stamp(), input.total, input.text,
    );
    return { received: input.part + 1, total: input.total };
  }
  async function uploaded(uploadId: string): Promise<string> {
    const rows = await t.all("SELECT part, total, text FROM import_parts WHERE user_id = ? AND upload_id = ? ORDER BY part", t.userId, uploadId);
    const total = Number(rows[0]?.[1] ?? 0);
    if (!rows.length || rows.length !== total) throw invalid("The file did not finish uploading. Choose it again");
    const text = rows.map((row) => String(row[2])).join("");
    if (text.length > MAX_FILE_CHARS) throw invalid("This file is larger than 32 MB");
    return text;
  }
  async function preview(input: PreviewInput) {
    await sweep();
    const source = input.uploadId ? await uploaded(input.uploadId) : input.text;
    if (!source?.trim()) throw invalid("Choose a file or paste some links");
    const parsed: ParsedFile = input.uploadId ? parseImport(source) : parseLinkList(source);
    if (input.uploadId) await t.run("DELETE FROM import_parts WHERE user_id = ? AND upload_id = ?", t.userId, input.uploadId);
    const links = mergeDuplicates(parsed.links);
    if (!links.length) throw invalid(parsed.skipped ? "This file has no web links to import" : "No links were found. Export bookmarks as HTML from your browser, or use a CSV with a url column");
    const items = JSON.stringify(links);
    const digest = await sha256(items);
    const id = crypto.randomUUID();
    const time = stamp();
    const expiresAt = new Date(clock.now().getTime() + PREVIEW_MS).toISOString();
    await t.run("INSERT INTO import_previews (id, user_id, created_at, expires_at, digest, file_name, format, items, skipped, applied_at, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)",
      id, t.userId, time, expiresAt, digest, input.fileName?.slice(0, 200) ?? null, parsed.format, items, parsed.skipped);
    // Which links are already saved, by their keys, in bounded chunks.
    const known = new Set<string>();
    const keys = links.map((link) => link.key);
    for (let index = 0; index < keys.length; index += 90) {
      const chunk = keys.slice(index, index + 90);
      for (const row of await t.all(`SELECT url_key FROM bookmarks WHERE user_id = ? AND url_key IN (${chunk.map(() => "?").join(", ")})`, t.userId, ...chunk)) known.add(String(row[0]));
    }
    const tags = new Map<string, number>();
    for (const link of links) for (const tag of link.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1);
    return {
      previewId: id, digest, format: parsed.format, fileName: input.fileName?.slice(0, 200) ?? null, total: links.length, fresh: links.length - known.size, known: known.size, skipped: parsed.skipped, truncated: parsed.truncated,
      tags: [...tags.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12).map(([tag, count]) => ({ tag, count })),
      samples: links.slice(0, 6).map((link) => ({ url: link.url, title: link.title, tags: link.tags.slice(0, 6) })),
      expiresAt,
    };
  }
  async function apply(input: { previewId: string; digest: string }) {
    const row = await t.one("SELECT digest, items, expires_at, applied_at, result FROM import_previews WHERE id = ? AND user_id = ?", input.previewId, t.userId);
    if (!row || String(row[2]) < stamp()) throw new TRPCError({ code: "NOT_FOUND", message: "This preview expired. Choose the file again" });
    if (row[0] !== input.digest) throw new TRPCError({ code: "CONFLICT", message: "This preview changed. Choose the file again" });
    if (row[3]) return { ...JSON.parse(String(row[4])) as { added: number; updated: number; unchanged: number; invalid: number }, status: "already_applied" as const };
    // Claim the preview first, so a second click while this one runs gets the first result instead of a second import.
    const claimed = await t.all("UPDATE import_previews SET applied_at = ? WHERE id = ? AND user_id = ? AND applied_at IS NULL RETURNING id", stamp(), input.previewId, t.userId);
    if (!claimed.length) throw new TRPCError({ code: "CONFLICT", message: "This import is already running. Wait a moment and look again" });
    const links = JSON.parse(String(row[1])) as ImportedLink[];
    const counts = { added: 0, updated: 0, unchanged: 0, invalid: 0 };
    try {
      for (const link of links) {
        const outcome = await t.saveOne(link, "import");
        if (outcome.status === "created") counts.added++;
        else if (outcome.status === "updated") counts.updated++;
        else if (outcome.status === "unchanged") counts.unchanged++;
        else counts.invalid++;
      }
    } catch (error) {
      // Let it be applied again. Links already saved merge, so nothing doubles.
      await t.run("UPDATE import_previews SET applied_at = NULL WHERE id = ? AND user_id = ?", input.previewId, t.userId);
      throw error;
    }
    // The parsed list has done its work. Keep only what a repeat click needs to answer.
    await t.run("UPDATE import_previews SET items = '[]', result = ? WHERE id = ? AND user_id = ?", JSON.stringify(counts), input.previewId, t.userId);
    return { ...counts, status: "applied" as const };
  }
  return { addPart, preview, apply };
}
