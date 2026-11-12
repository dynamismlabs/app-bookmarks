/**
 * Forward-only schema. Applied migration SQL is immutable and checksum-checked
 * by the core: append a new entry instead of editing one. Policy values
 * (initial page state, via) come from the query layer, never SQL defaults.
 *
 * Tags and the search row follow each bookmark through triggers, so every
 * change to a bookmark is one statement and the three can't drift apart. The
 * page text lives only in the search row (bookmarks_fts.body), keyed by
 * bookmarks.seq, so deleting a bookmark removes its text with it.
 */
const TAG_TEXT = "(SELECT coalesce(group_concat(value, ' '), '') FROM json_each(new.tags))";

const V1 = [
  `CREATE TABLE bookmarks (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL,
    write_token TEXT NOT NULL,
    url TEXT NOT NULL, url_key TEXT NOT NULL, site TEXT NOT NULL,
    title TEXT NOT NULL, title_source TEXT NOT NULL CHECK (title_source IN ('link','page','given','edited')),
    note TEXT, tags TEXT NOT NULL, saved_at TEXT NOT NULL,
    via TEXT NOT NULL CHECK (via IN ('extension','bookmark','bookmarklet','shortcut','chat','added','import','fixture')),
    excerpt TEXT,
    page_state TEXT NOT NULL CHECK (page_state IN ('waiting','read','no_text','gone','needs_browser','failed')),
    page_source TEXT CHECK (page_source IN ('browser','home')),
    page_chars INTEGER NOT NULL, page_at TEXT, page_attempts INTEGER NOT NULL, page_next_at TEXT,
    fictional INTEGER NOT NULL,
    UNIQUE (user_id, url_key)
  )`,
  "CREATE INDEX bookmarks_saved ON bookmarks (user_id, saved_at DESC, id DESC)",
  "CREATE INDEX bookmarks_waiting ON bookmarks (user_id, page_next_at) WHERE page_state = 'waiting'",
  "CREATE INDEX bookmarks_page_state ON bookmarks (user_id, page_state)",
  `CREATE TABLE bookmark_tags (
    bookmark_id TEXT NOT NULL, user_id TEXT NOT NULL, tag TEXT NOT NULL,
    PRIMARY KEY (bookmark_id, tag)
  ) WITHOUT ROWID`,
  "CREATE INDEX bookmark_tags_tag ON bookmark_tags (user_id, tag, bookmark_id)",
  "CREATE VIRTUAL TABLE bookmarks_fts USING fts5(title, link, note, tags, body, tokenize='unicode61 remove_diacritics 2')",
  `CREATE TRIGGER bookmarks_after_insert AFTER INSERT ON bookmarks BEGIN
    INSERT INTO bookmark_tags (bookmark_id, user_id, tag) SELECT new.id, new.user_id, value FROM json_each(new.tags);
    INSERT INTO bookmarks_fts (rowid, title, link, note, tags, body) VALUES (new.seq, new.title, new.url, coalesce(new.note, ''), ${TAG_TEXT}, '');
  END`,
  `CREATE TRIGGER bookmarks_after_update_tags AFTER UPDATE OF tags ON bookmarks BEGIN
    DELETE FROM bookmark_tags WHERE bookmark_id = new.id;
    INSERT INTO bookmark_tags (bookmark_id, user_id, tag) SELECT new.id, new.user_id, value FROM json_each(new.tags);
  END`,
  `CREATE TRIGGER bookmarks_after_update_search AFTER UPDATE OF title, url, note, tags ON bookmarks BEGIN
    UPDATE bookmarks_fts SET title = new.title, link = new.url, note = coalesce(new.note, ''), tags = ${TAG_TEXT} WHERE rowid = new.seq;
  END`,
  `CREATE TRIGGER bookmarks_after_delete AFTER DELETE ON bookmarks BEGIN
    DELETE FROM bookmark_tags WHERE bookmark_id = old.id;
    DELETE FROM bookmarks_fts WHERE rowid = old.seq;
  END`,
  // A number that moves whenever any bookmark changes, so a screen knows to refresh.
  "CREATE TABLE bookmarks_revision (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)",
  "INSERT INTO bookmarks_revision (id, value) VALUES (1, 1)",
  ...["INSERT", "UPDATE", "DELETE"].map((event) =>
    `CREATE TRIGGER bookmarks_${event.toLowerCase()}_revision AFTER ${event} ON bookmarks BEGIN UPDATE bookmarks_revision SET value = value + 1 WHERE id = 1; END`),
  `CREATE TABLE bookmarks_state (
    user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  ) WITHOUT ROWID`,
  `CREATE TABLE import_parts (
    user_id TEXT NOT NULL, upload_id TEXT NOT NULL, part INTEGER NOT NULL,
    created_at TEXT NOT NULL, total INTEGER NOT NULL, text TEXT NOT NULL,
    PRIMARY KEY (user_id, upload_id, part)
  ) WITHOUT ROWID`,
  `CREATE TABLE import_previews (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    digest TEXT NOT NULL, file_name TEXT, format TEXT NOT NULL, items TEXT NOT NULL, skipped INTEGER NOT NULL,
    applied_at TEXT, result TEXT
  )`,
].join("\n-- statement-breakpoint\n");

export const migrations = [{ id: "app-0001", sql: V1 }];
