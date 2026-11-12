/** How a stored row is shown to callers. */
import type { BookmarkRecord } from "../schemas";
import type { BookmarkRow, Bookmarks } from "./store";

export const PAGE_LABELS: Record<BookmarkRow["pageState"], string> = {
  waiting: "Waiting to be read",
  read: "Page text saved",
  no_text: "Saved without text, this link is a file",
  gone: "This page is gone",
  needs_browser: "Needs your browser. Save it with the extension to keep its text",
  failed: "Could not be read",
};

export function record(row: BookmarkRow, snippet: string | null = null): BookmarkRecord {
  return {
    id: row.id, revision: row.revision, url: row.url, site: row.site.slice(0, 300), title: row.title, note: row.note, tags: row.tags, savedAt: row.savedAt, via: row.via, excerpt: row.excerpt,
    page: { state: row.pageState, source: row.pageSource, chars: row.pageChars, at: row.pageAt, label: PAGE_LABELS[row.pageState] },
    snippet: snippet ? snippet.slice(0, 600) : null,
    fictional: row.fictional,
  };
}

export const revisionOf = async (t: Bookmarks) => `r${await t.dataRevision()}`;

/** How recently a reading step must have run for the screen to say pages are being read. */
const READING_RECENT_MS = 30 * 60_000;
export async function setupOf(t: Bookmarks, now: Date) {
  const counts = await t.counts();
  const lastStep = await t.getState("reading.lastStepAt");
  return { ...counts, reading: !!lastStep && now.getTime() - Date.parse(lastStep) < READING_RECENT_MS };
}

/** Opaque list cursors: base64url JSON. Never trusted beyond their parsed shape. */
export function encodeCursor(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function decodeCursor<T>(cursor: string | undefined, check: (value: unknown) => T | null): T | null {
  if (!cursor) return null;
  try {
    return check(JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/"))));
  } catch {
    return null;
  }
}
