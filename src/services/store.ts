/**
 * One person's bookmarks: every read and write of a record. Opening it does
 * nothing. Every change is guarded by the row's write token, so two saves that
 * race (two requests, or a save while a page is being read) never lose each
 * other's work: the loser reads again and merges. Tags and the search row
 * follow through triggers (db/migrations.ts).
 */
import type { Platform, Query, SqlValue } from "@app-builder/core";
import { clipText, excerptOf, MAX_EXCERPT } from "../domain/page";
import { cleanTags, parseLink, parseSavedAt } from "../domain/url";

export type Via = "extension" | "bookmark" | "bookmarklet" | "shortcut" | "chat" | "added" | "import" | "fixture";
export type PageState = "waiting" | "read" | "no_text" | "gone" | "needs_browser" | "failed";
export type TitleSource = "link" | "page" | "given" | "edited";

/** The app's clock. Tests move it. */
export const clock = { now: () => new Date() };
const stamp = () => clock.now().toISOString();

export interface BookmarkRow {
  seq: number; id: string; userId: string; createdAt: string; updatedAt: string; revision: number; writeToken: string;
  url: string; urlKey: string; site: string; title: string; titleSource: TitleSource;
  note: string | null; tags: string[]; savedAt: string; via: Via; excerpt: string | null;
  pageState: PageState; pageSource: "browser" | "home" | null; pageChars: number; pageAt: string | null;
  pageAttempts: number; pageNextAt: string | null; fictional: boolean;
}
/** List rows never carry the page text. */
const COLUMNS = "b.seq, b.id, b.user_id, b.created_at, b.updated_at, b.revision, b.write_token, b.url, b.url_key, b.site, b.title, b.title_source, b.note, b.tags, b.saved_at, b.via, b.excerpt, b.page_state, b.page_source, b.page_chars, b.page_at, b.page_attempts, b.page_next_at, b.fictional";
const COUNT = COLUMNS.split(",").length;
const rowOf = (r: unknown[]): BookmarkRow => ({
  seq: Number(r[0]), id: String(r[1]), userId: String(r[2]), createdAt: String(r[3]), updatedAt: String(r[4]), revision: Number(r[5]), writeToken: String(r[6]),
  url: String(r[7]), urlKey: String(r[8]), site: String(r[9]), title: String(r[10]), titleSource: r[11] as TitleSource,
  note: r[12] === null ? null : String(r[12]), tags: JSON.parse(String(r[13])), savedAt: String(r[14]), via: r[15] as Via,
  excerpt: r[16] === null ? null : String(r[16]), pageState: r[17] as PageState, pageSource: r[18] as BookmarkRow["pageSource"],
  pageChars: Number(r[19]), pageAt: r[20] === null ? null : String(r[20]), pageAttempts: Number(r[21]),
  pageNextAt: r[22] === null ? null : String(r[22]), fictional: Number(r[23]) === 1,
});

const PAGES_PER_SITE = 3;
const RETRIES = 6;

/** A title the person chose outranks one a save supplied, which outranks the page's, which outranks the link. The first given title stays. */
const TITLE_RANK: Record<TitleSource, number> = { link: 0, page: 1, given: 2, edited: 3 };

export interface SaveLink {
  url: string;
  title?: string | null;
  note?: string | null;
  tags?: readonly string[];
  savedAt?: string | number | null;
  excerpt?: string | null;
  /** The page's text, read by the browser that showed it. */
  pageText?: string | null;
}
export type SaveOutcome = { status: "created" | "updated" | "unchanged"; id: string } | { status: "invalid" };

/** A safe FTS5 query from typed text: each word a quoted prefix term, all required. Input is never interpreted. */
export function ftsQuery(text: string | null | undefined): string | null {
  const words = (text ?? "").normalize("NFKC").split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 12);
  return words.length ? words.map((word) => `"${word}"*`).join(" ") : null;
}

export class StaleWrite extends Error {
  constructor() { super("This link kept changing while it was saved. Try again."); }
}

export function bookmarksFor(platform: Platform, userId: string) {
  const query = (sql: string, params: SqlValue[], method: Query["method"]) => platform.driver.query({ sql, params, method });
  const run = (sql: string, ...params: SqlValue[]) => query(sql, params, "run");
  const one = async (sql: string, ...params: SqlValue[]) => {
    const rows = (await query(sql, params, "get")).rows;
    return rows.length ? rows : null;
  };
  const all = async (sql: string, ...params: SqlValue[]) => (await query(sql, params, "all")).rows as unknown[][];
  const token = () => crypto.randomUUID();
  /** Write the page text into the search row, only if this write still owns the record. */
  const bodyStatement = (id: string, writeToken: string, text: string): Query => ({
    sql: "UPDATE bookmarks_fts SET body = ? WHERE rowid = (SELECT seq FROM bookmarks WHERE id = ? AND write_token = ?)",
    params: [text, id, writeToken], method: "run",
  });

  async function bookmark(id: string): Promise<BookmarkRow | null> {
    const row = await one(`SELECT ${COLUMNS} FROM bookmarks b WHERE b.id = ? AND b.user_id = ?`, id, userId);
    return row ? rowOf(row) : null;
  }
  async function byKey(key: string): Promise<BookmarkRow | null> {
    const row = await one(`SELECT ${COLUMNS} FROM bookmarks b WHERE b.user_id = ? AND b.url_key = ?`, userId, key);
    return row ? rowOf(row) : null;
  }
  async function pageText(seq: number): Promise<string | null> {
    const row = await one("SELECT body FROM bookmarks_fts WHERE rowid = ?", seq);
    return row && row[0] ? String(row[0]) : null;
  }

  /** One link into the records. Repeats merge and never make a second record. */
  /** What a save holds once it is cleaned, or null when it isn't a web link. */
  function prepare(input: SaveLink) {
    const link = parseLink(input.url);
    if (!link) return null;
    const text = input.pageText ? clipText(input.pageText.replace(/\u0000/g, "").trim()) || null : null;
    return {
      link, text,
      given: input.title?.replace(/\s+/g, " ").trim().slice(0, 500) || null,
      note: input.note?.trim().slice(0, 4000) || null,
      tags: cleanTags(input.tags ?? []),
      savedAt: parseSavedAt(input.savedAt),
      excerpt: input.excerpt?.replace(/\s+/g, " ").trim().slice(0, MAX_EXCERPT) || (text ? excerptOf(text) : null),
    };
  }
  type Prepared = NonNullable<ReturnType<typeof prepare>>;
  /** A new record, and its page text if the caller had it. The insert does nothing if the page is already saved. */
  function insertQueries({ link, text, given, note, tags, savedAt, excerpt }: Prepared, via: Via, fictional: boolean) {
    const id = crypto.randomUUID(), writeToken = token(), time = stamp();
    const queries: Query[] = [
      {
        sql: `INSERT INTO bookmarks (id, user_id, created_at, updated_at, revision, write_token, url, url_key, site, title, title_source, note, tags, saved_at, via, excerpt, page_state, page_source, page_chars, page_at, page_attempts, page_next_at, fictional)
          VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?) ON CONFLICT (user_id, url_key) DO NOTHING RETURNING seq`,
        params: [id, userId, time, time, writeToken, link.url, link.key, link.site, given ?? link.site, given ? "given" : "link", note, JSON.stringify(tags), savedAt ?? time, via, excerpt,
          text ? "read" : "waiting", text ? "browser" : null, text?.length ?? 0, text ? time : null, text ? null : time, fictional ? 1 : 0],
        method: "all",
      },
      ...(text ? [bodyStatement(id, writeToken, text)] : []),
    ];
    return { id, queries };
  }

  /**
   * Many links at once (an import, or a batch from the browser). Links not yet
   * saved go in together, a few hundred per transaction. Anything already
   * saved, or saved by someone else meanwhile, merges one by one.
   */
  async function saveMany(inputs: readonly SaveLink[], via: Via, options: { fictional?: boolean } = {}): Promise<SaveOutcome[]> {
    const prepared = inputs.map(prepare);
    const outcomes: (SaveOutcome | undefined)[] = prepared.map((item) => (item ? undefined : { status: "invalid" as const }));
    const known = new Set<string>();
    const keys = [...new Set(prepared.flatMap((item) => (item ? [item.link.key] : [])))];
    for (let index = 0; index < keys.length; index += 90) {
      const chunk = keys.slice(index, index + 90);
      for (const row of await all(`SELECT url_key FROM bookmarks WHERE user_id = ? AND url_key IN (${chunk.map(() => "?").join(", ")})`, userId, ...chunk)) known.add(String(row[0]));
    }
    const fresh = prepared.flatMap((item, index) => (item && !known.has(item.link.key) ? [index] : []));
    for (let start = 0; start < fresh.length; start += 250) {
      const chunk = fresh.slice(start, start + 250).map((index) => ({ index, ...insertQueries(prepared[index]!, via, !!options.fictional) }));
      const results = await platform.driver.batch(chunk.flatMap((item) => item.queries));
      let at = 0;
      for (const item of chunk) {
        if (results[at].rows.length) outcomes[item.index] = { status: "created", id: item.id };
        at += item.queries.length;
      }
    }
    // Repeats within the batch, and pages already saved, merge in order.
    for (const [index, outcome] of outcomes.entries()) if (!outcome) outcomes[index] = await saveOne(inputs[index], via, options);
    return outcomes as SaveOutcome[];
  }

  async function saveOne(input: SaveLink, via: Via, options: { fictional?: boolean } = {}): Promise<SaveOutcome> {
    const item = prepare(input);
    if (!item) return { status: "invalid" };
    const { link, given, note, tags, savedAt, text, excerpt } = item;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const existing = await byKey(link.key);
      const time = stamp();
      const writeToken = token();
      if (!existing) {
        const { id, queries } = insertQueries(item, via, !!options.fictional);
        const [inserted] = await platform.driver.batch(queries);
        if (inserted.rows.length) return { status: "created", id };
        continue; // Saved by someone else a moment ago: merge into theirs.
      }
      const nextTags = cleanTags([...existing.tags, ...tags]);
      const useTitle = !!given && TITLE_RANK.given > TITLE_RANK[existing.titleSource];
      const nextTitle = useTitle ? given! : existing.title;
      const nextNote = existing.note ?? note;
      const nextSavedAt = savedAt && savedAt < existing.savedAt ? savedAt : existing.savedAt;
      // Saving again is a reason to try a page that could not be read before.
      const retry = !text && ["gone", "failed", "needs_browser"].includes(existing.pageState);
      const changed = useTitle || nextNote !== existing.note || nextTags.length !== existing.tags.length || nextSavedAt !== existing.savedAt || !!text || retry || (!existing.excerpt && !!excerpt);
      if (!changed) return { status: "unchanged", id: existing.id };
      const [updated] = await platform.driver.batch([
        {
          sql: `UPDATE bookmarks SET updated_at = ?, revision = revision + 1, write_token = ?, title = ?, title_source = ?, note = ?, tags = ?, saved_at = ?, excerpt = ?,
            page_state = ?, page_source = ?, page_chars = ?, page_at = ?, page_attempts = ?, page_next_at = ? WHERE id = ? AND write_token = ? RETURNING seq`,
          params: [time, writeToken, nextTitle, useTitle ? "given" : existing.titleSource, nextNote, JSON.stringify(nextTags), nextSavedAt, text ? excerpt : existing.excerpt ?? excerpt,
            text ? "read" : retry ? "waiting" : existing.pageState, text ? "browser" : existing.pageSource, text ? text.length : existing.pageChars, text ? time : existing.pageAt,
            text || retry ? 0 : existing.pageAttempts, text ? null : retry ? time : existing.pageNextAt, existing.id, existing.writeToken],
          method: "all",
        },
        ...(text ? [bodyStatement(existing.id, writeToken, text)] : []),
      ]);
      if (updated.rows.length) return { status: "updated", id: existing.id };
    }
    throw new StaleWrite();
  }

  /**
   * Change what a person edits, if the record is still at the revision they
   * read. Merges nothing: the values given are the values kept. Returns null
   * when the record moved on, so the caller can say so.
   */
  async function edit(id: string, expectedRevision: number, patch: { title?: string; note?: string | null; tags?: readonly string[] }): Promise<BookmarkRow | "conflict" | null> {
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const row = await bookmark(id);
      if (!row) return null;
      if (row.revision !== expectedRevision) return "conflict";
      const title = patch.title !== undefined ? patch.title.replace(/\s+/g, " ").trim().slice(0, 500) || row.site : row.title;
      const note = patch.note !== undefined ? patch.note?.trim().slice(0, 4000) || null : row.note;
      const tags = patch.tags !== undefined ? cleanTags(patch.tags) : row.tags;
      const updated = await all(`UPDATE bookmarks SET updated_at = ?, revision = revision + 1, write_token = ?, title = ?, title_source = ?, note = ?, tags = ? WHERE id = ? AND write_token = ? RETURNING id`,
        stamp(), token(), title, title !== row.title ? "edited" : row.titleSource, note, JSON.stringify(tags), row.id, row.writeToken);
      if (updated.length) return bookmark(id);
    }
    throw new StaleWrite();
  }

  /** Delete a record at the revision the person saw, with its tags, search row and page text. */
  async function remove(id: string, expectedRevision: number): Promise<"deleted" | "conflict"> {
    const removed = await all("DELETE FROM bookmarks WHERE id = ? AND user_id = ? AND revision = ? RETURNING id", id, userId, expectedRevision);
    if (removed.length) return "deleted";
    return (await bookmark(id)) ? "conflict" : "deleted";
  }

  /** Newest first, by the date each was saved. */
  async function newest(input: { tag?: string | null; after?: { savedAt: string; id: string } | null; limit: number }): Promise<BookmarkRow[]> {
    const where = ["b.user_id = ?"];
    const params: SqlValue[] = [userId];
    if (input.tag) { where.push("EXISTS (SELECT 1 FROM bookmark_tags t WHERE t.bookmark_id = b.id AND t.tag = ?)"); params.push(input.tag); }
    if (input.after) { where.push("(b.saved_at < ? OR (b.saved_at = ? AND b.id < ?))"); params.push(input.after.savedAt, input.after.savedAt, input.after.id); }
    return (await all(`SELECT ${COLUMNS} FROM bookmarks b WHERE ${where.join(" AND ")} ORDER BY b.saved_at DESC, b.id DESC LIMIT ?`, ...params, input.limit)).map(rowOf);
  }

  /** Best match first. A title or tag counts for more than a word deep in the page. */
  async function search(input: { query: string; tag?: string | null; offset: number; limit: number }): Promise<{ row: BookmarkRow; snippet: string | null }[]> {
    const match = ftsQuery(input.query);
    if (!match) return [];
    const tag = input.tag ? "AND EXISTS (SELECT 1 FROM bookmark_tags t WHERE t.bookmark_id = b.id AND t.tag = ?)" : "";
    const rows = await all(
      `SELECT ${COLUMNS}, snippet(bookmarks_fts, 4, '', '', '…', 28) AS snippet
       FROM bookmarks_fts JOIN bookmarks b ON b.seq = bookmarks_fts.rowid
       WHERE bookmarks_fts MATCH ? AND b.user_id = ? ${tag}
       ORDER BY bm25(bookmarks_fts, 10.0, 3.0, 6.0, 8.0, 1.0), b.saved_at DESC LIMIT ? OFFSET ?`,
      match, userId, ...(input.tag ? [input.tag] : []), input.limit, input.offset,
    );
    return rows.map((row) => ({ row: rowOf(row), snippet: row[COUNT] ? String(row[COUNT]).replace(/\s+/g, " ").trim() || null : null }));
  }

  async function tagCounts(limit: number): Promise<{ tag: string; count: number }[]> {
    return (await all("SELECT tag, COUNT(*) AS count FROM bookmark_tags WHERE user_id = ? GROUP BY tag ORDER BY count DESC, tag ASC LIMIT ?", userId, limit))
      .map((row) => ({ tag: String(row[0]), count: Number(row[1]) }));
  }
  async function counts() {
    const row = (await one("SELECT COUNT(*), COALESCE(SUM(page_state = 'waiting'), 0), COALESCE(SUM(page_state = 'read'), 0) FROM bookmarks WHERE user_id = ?", userId))!;
    return { total: Number(row[0]), waiting: Number(row[1]), read: Number(row[2]) };
  }
  /**
   * Links due to be read, oldest wait first: each site's first before any site's
   * second, and never more than a few from one site in a step. So a library that
   * is mostly one site still moves, and can't crowd out the rest.
   */
  async function dueForReading(limit: number): Promise<BookmarkRow[]> {
    return (await all(
      `SELECT ${COLUMNS} FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY site ORDER BY page_next_at, seq) AS site_turn FROM bookmarks WHERE user_id = ? AND page_state = 'waiting' AND page_next_at <= ?) b
       WHERE b.site_turn <= ? ORDER BY b.site_turn, b.page_next_at, b.seq LIMIT ?`,
      userId, stamp(), PAGES_PER_SITE, limit,
    )).map(rowOf);
  }
  /** Record what reading a page found. The title moves only if nothing better named it. */
  async function recordPage(id: string, result: { state: PageState; title?: string | null; excerpt?: string | null; text?: string | null; attempts?: number; nextAt?: string | null }) {
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const row = await bookmark(id);
      if (!row) return;
      // A person's browser may have supplied the text while this read was in flight. Keep theirs.
      if (row.pageState !== "waiting") return;
      const time = stamp();
      const writeToken = token();
      const title = result.title && TITLE_RANK.page >= TITLE_RANK[row.titleSource] ? result.title : row.title;
      // The revision guards what a person edits. Reading the page only conflicts with them if it changes the title.
      const [updated] = await platform.driver.batch([
        {
          sql: `UPDATE bookmarks SET updated_at = ?, revision = revision + ?, write_token = ?, title = ?, title_source = ?, excerpt = ?, page_state = ?, page_source = ?, page_chars = ?, page_at = ?, page_attempts = ?, page_next_at = ?
            WHERE id = ? AND write_token = ? RETURNING id`,
          params: [time, title !== row.title ? 1 : 0, writeToken, title, title !== row.title ? "page" : row.titleSource, result.excerpt ?? row.excerpt, result.state, result.text ? "home" : row.pageSource,
            result.text?.length ?? row.pageChars, time, result.attempts ?? row.pageAttempts, result.nextAt ?? null, id, row.writeToken],
          method: "all",
        },
        ...(result.text ? [bodyStatement(id, writeToken, result.text)] : []),
      ]);
      if (updated.rows.length) return;
    }
  }
  /** Note an attempt before it starts, so a read that takes the whole step down isn't due again straight away. */
  async function setAttempt(id: string, attempts: number, nextAt: string | null) {
    await run("UPDATE bookmarks SET page_attempts = ?, page_next_at = ? WHERE id = ? AND user_id = ? AND page_state = 'waiting'", attempts, nextAt, id, userId);
  }
  /** Give up on a page whose attempts all ended without an answer. */
  async function failExhausted(maxAttempts: number) {
    const time = stamp();
    await run(`UPDATE bookmarks SET page_state = 'failed', page_next_at = NULL, page_at = ?, updated_at = ?, write_token = lower(hex(randomblob(16)))
      WHERE user_id = ? AND page_state = 'waiting' AND page_attempts >= ? AND page_next_at <= ?`, time, time, userId, maxAttempts, time);
  }
  async function dataRevision(): Promise<number> {
    return Number((await one("SELECT value FROM bookmarks_revision WHERE id = 1"))?.[0] ?? 0);
  }
  async function getState(key: string): Promise<string | null> {
    const row = await one("SELECT value FROM bookmarks_state WHERE user_id = ? AND key = ?", userId, key);
    return row ? String(row[0]) : null;
  }
  async function setState(key: string, value: string) {
    await run("INSERT INTO bookmarks_state (user_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", userId, key, value, stamp());
  }

  return {
    platform, userId, run, one, all,
    bookmark, byKey, pageText, saveOne, saveMany, edit, remove, newest, search, tagCounts, counts, dueForReading, recordPage, setAttempt, failExhausted, dataRevision, getState, setState,
  };
}
export type Bookmarks = ReturnType<typeof bookmarksFor>;
