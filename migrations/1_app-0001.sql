CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
CREATE TABLE bookmarks (
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
  )


CREATE INDEX bookmarks_saved ON bookmarks (user_id, saved_at DESC, id DESC)


CREATE INDEX bookmarks_waiting ON bookmarks (user_id, page_next_at) WHERE page_state = 'waiting'


CREATE INDEX bookmarks_page_state ON bookmarks (user_id, page_state)


CREATE TABLE bookmark_tags (
    bookmark_id TEXT NOT NULL, user_id TEXT NOT NULL, tag TEXT NOT NULL,
    PRIMARY KEY (bookmark_id, tag)
  ) WITHOUT ROWID


CREATE INDEX bookmark_tags_tag ON bookmark_tags (user_id, tag, bookmark_id)


CREATE VIRTUAL TABLE bookmarks_fts USING fts5(title, link, note, tags, body, tokenize='unicode61 remove_diacritics 2')


CREATE TRIGGER bookmarks_after_insert AFTER INSERT ON bookmarks BEGIN
    INSERT INTO bookmark_tags (bookmark_id, user_id, tag) SELECT new.id, new.user_id, value FROM json_each(new.tags);
    INSERT INTO bookmarks_fts (rowid, title, link, note, tags, body) VALUES (new.seq, new.title, new.url, coalesce(new.note, ''), (SELECT coalesce(group_concat(value, ' '), '') FROM json_each(new.tags)), '');
  END


CREATE TRIGGER bookmarks_after_update_tags AFTER UPDATE OF tags ON bookmarks BEGIN
    DELETE FROM bookmark_tags WHERE bookmark_id = new.id;
    INSERT INTO bookmark_tags (bookmark_id, user_id, tag) SELECT new.id, new.user_id, value FROM json_each(new.tags);
  END


CREATE TRIGGER bookmarks_after_update_search AFTER UPDATE OF title, url, note, tags ON bookmarks BEGIN
    UPDATE bookmarks_fts SET title = new.title, link = new.url, note = coalesce(new.note, ''), tags = (SELECT coalesce(group_concat(value, ' '), '') FROM json_each(new.tags)) WHERE rowid = new.seq;
  END


CREATE TRIGGER bookmarks_after_delete AFTER DELETE ON bookmarks BEGIN
    DELETE FROM bookmark_tags WHERE bookmark_id = old.id;
    DELETE FROM bookmarks_fts WHERE rowid = old.seq;
  END


CREATE TABLE bookmarks_revision (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)


INSERT INTO bookmarks_revision (id, value) VALUES (1, 1)


CREATE TRIGGER bookmarks_insert_revision AFTER INSERT ON bookmarks BEGIN UPDATE bookmarks_revision SET value = value + 1 WHERE id = 1; END


CREATE TRIGGER bookmarks_update_revision AFTER UPDATE ON bookmarks BEGIN UPDATE bookmarks_revision SET value = value + 1 WHERE id = 1; END


CREATE TRIGGER bookmarks_delete_revision AFTER DELETE ON bookmarks BEGIN UPDATE bookmarks_revision SET value = value + 1 WHERE id = 1; END


CREATE TABLE bookmarks_state (
    user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  ) WITHOUT ROWID


CREATE TABLE import_parts (
    user_id TEXT NOT NULL, upload_id TEXT NOT NULL, part INTEGER NOT NULL,
    created_at TEXT NOT NULL, total INTEGER NOT NULL, text TEXT NOT NULL,
    PRIMARY KEY (user_id, upload_id, part)
  ) WITHOUT ROWID


CREATE TABLE import_previews (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    digest TEXT NOT NULL, file_name TEXT, format TEXT NOT NULL, items TEXT NOT NULL, skipped INTEGER NOT NULL,
    applied_at TEXT, result TEXT
  )
INSERT INTO _migrations (id,checksum,applied_at) VALUES ('app-0001','af610823081a9df3bac9fa823b3c0802377798057790c5c0202432394ebcc310',CURRENT_TIMESTAMP);
