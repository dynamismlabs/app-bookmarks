import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, Route, Routes, useLocation, useNavigate } from "react-router";
import { Button, ConnectionSettings, ConsentScreen, Form, Modal, ViewCard, useAction, useAppClient } from "@app-builder/core/react";
import { appConfig } from "../app.config";
import { bookmarkletFor, reachableFromPhone, shortcutPrefix } from "./domain/client";
import type { BookmarkDetail, BookmarkList, BookmarkRecord, ImportPreview, ImportResult, ShowData, TagList, UpdateResult } from "./schemas";
import { copyText, download, errorMessage, fromBase64, initialOf, parseTags, plural, readSelectedFile, savedLabel, splitParts, VIA_LABELS } from "./view-util";

// ─── Shared pieces ──────────────────────────────────────────────────────────

/** The search words picked out in a passage, so a person sees why it matched. */
function Marked({ text, query }: { text: string; query: string }) {
  const words = query.normalize("NFKC").split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1).slice(0, 12);
  if (!words.length) return <>{text}</>;
  const pattern = new RegExp(`(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "giu");
  return <>{text.split(pattern).map((part, index) => (index % 2 ? <mark key={index}>{part}</mark> : part))}</>;
}

/** A link that opens in the person's browser. Inside an assistant's sandboxed view nothing opens, so it offers a copy. */
function OpenLink({ url, children, className }: { url: string; children: React.ReactNode; className?: string }) {
  const client = useAppClient();
  const [copied, setCopied] = useState("");
  if (!client.embedded) return <a className={className} href={url} target="_blank" rel="noopener noreferrer">{children}</a>;
  return <button type="button" className={className ? `${className} as-link` : "as-link"} title="Copy link" onClick={async () => setCopied(await copyText(url) ? "Link copied" : "Copy the link above")}>
    {children}{copied && <span className="copied" role="status"> · {copied}</span>}
  </button>;
}

function Header() {
  const client = useAppClient();
  return <header className="app-header">
    <Link to="/" className="brand"><span className="brand-mark" aria-hidden="true">◆</span>{appConfig.name}</Link>
    {!client.embedded && <nav className="header-links"><Link to="/connect">Connect</Link><Link to="/settings">Settings</Link></nav>}
  </header>;
}

// ─── The library ────────────────────────────────────────────────────────────

const PAGE = 50;

function StateNotice({ list }: { list: BookmarkList | undefined }) {
  const client = useAppClient();
  if (!list) return null;
  if (list.items.some((item) => item.fictional)) return <p className="notice">Fictional preview. These links and their text are examples. No page is requested.</p>;
  if (!list.setup.waiting) return null;
  if (list.setup.reading) return <p className="muted small">{plural(list.setup.waiting, "page is", "pages are")} waiting to be read. Search covers their titles and links until then.</p>;
  return <p className="notice">
    <strong>Search only covers titles and links for now.</strong> {plural(list.setup.waiting, "saved page hasn’t", "saved pages haven’t")} been read.
    {client.embedded ? " Connect Bookmarks to Ri in its Settings and allow it to read public web pages, and search will find what they say."
      : <> <Link to="/settings">Connect Bookmarks to Ri</Link> and allow it to read public web pages, and search will find what they say.</>}
  </p>;
}

function BookmarkRow({ item, query, selected, onSelect }: { item: BookmarkRecord; query: string; selected: boolean; onSelect(): void }) {
  const passage = item.snippet ?? item.excerpt;
  return <li className={selected ? "row selected" : "row"}>
    <span className="initial" aria-hidden="true">{initialOf(item.site)}</span>
    <button type="button" className="row-body" onClick={onSelect} aria-current={selected || undefined}>
      <strong className="row-title"><Marked text={item.title} query={query} /></strong>
      <span className="row-meta">{item.site} · {savedLabel(item.savedAt)}{item.tags.length ? <> · {item.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</> : null}</span>
      {passage && <span className="row-passage"><Marked text={passage} query={query} /></span>}
      {item.page.state !== "read" && <span className="row-state">{item.page.label}</span>}
    </button>
  </li>;
}

export function Library() {
  const client = useAppClient();
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const query = params.get("q") ?? "";
  const tag = params.get("tag") ?? "";
  const selectedId = /^\/bookmarks\/([^/]+)$/.exec(location.pathname)?.[1];
  const [typed, setTyped] = useState(query);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [extra, setExtra] = useState<{ items: BookmarkRecord[]; cursor: string | null; base: string } | null>(null);
  const input = useMemo(() => ({ limit: PAGE, ...(query ? { query } : {}), ...(tag ? { tag } : {}) }), [query, tag]);
  const list = useAction<BookmarkList>("list_bookmarks", input);
  const tags = useAction<TagList>("list_tags");
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (debounce.current) clearTimeout(debounce.current); }, []);
  useEffect(() => () => client.select(null), [client.select]);
  const go = (next: { q?: string; tag?: string; id?: string | null }) => {
    const search = new URLSearchParams();
    const q = next.q ?? query, t = next.tag ?? tag;
    if (q) search.set("q", q);
    if (t) search.set("tag", t);
    const id = next.id === undefined ? selectedId : next.id;
    navigate(`${id ? `/bookmarks/${encodeURIComponent(id)}` : "/"}${search.size ? `?${search}` : ""}`, { replace: next.id === undefined });
  };
  const onType = (value: string) => {
    setTyped(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => go({ q: value.trim(), id: null }), 200);
  };
  const base = JSON.stringify(input) + (list.data?.revision ?? "");
  const items = [...(list.data?.items ?? []), ...(extra?.base === base ? extra.items : [])];
  const cursor = extra?.base === base ? extra.cursor : list.data?.nextCursor ?? null;
  const more = async () => {
    if (!cursor) return;
    const next = await client.call<BookmarkList>("list_bookmarks", { ...input, cursor });
    setExtra({ items: [...(extra?.base === base ? extra.items : []), ...next.items], cursor: next.nextCursor, base });
  };
  const refresh = async () => { setExtra(null); await Promise.all([list.refresh(), tags.refresh()]); };
  const select = (item: BookmarkRecord | null) => {
    client.select(item ? { id: item.id, title: item.title } : null);
    go({ id: item?.id ?? null });
  };
  return <div className="workspace">
    <Header />
    <main className={selectedId ? "library with-inspector" : "library"}>
      <section className="list-pane">
        <div className="search-row">
          <input className="search" type="search" placeholder="Search what you saved" aria-label="Search bookmarks" value={typed} onChange={(event) => onType(event.target.value)} />
          <Button className="primary" onClick={() => setAdding(true)}>Add a link</Button>
          {!client.embedded && <Button className="secondary" onClick={() => setImporting(true)}>Import</Button>}
        </div>
        {!!tags.data?.items.length && <div className="tags" aria-label="Tags">
          {tag && <button type="button" className="chip active" onClick={() => go({ tag: "", id: null })}>All</button>}
          {tags.data.items.slice(0, 24).map((item) => <button type="button" key={item.tag} className={item.tag === tag ? "chip active" : "chip"} aria-pressed={item.tag === tag} onClick={() => go({ tag: item.tag === tag ? "" : item.tag, id: null })}>{item.tag}<span>{item.count}</span></button>)}
        </div>}
        <StateNotice list={list.data} />
        {list.data?.coverage.note && <p className="muted small">{list.data.coverage.note}</p>}
        {list.error && <p role="alert" className="error">{list.error} <button className="text-button" onClick={() => void refresh()}>Try again</button></p>}
        {list.loading && !list.data ? <p className="empty">Opening your bookmarks…</p>
          : items.length ? <ul className="rows">{items.map((item) => <BookmarkRow key={item.id} item={item} query={query} selected={item.id === selectedId} onSelect={() => select(item.id === selectedId ? null : item)} />)}</ul>
          : <div className="empty-state">
            <h2>{query || tag ? "Nothing matches." : "Save a link from anywhere."}</h2>
            <p>{query ? "Try a word the page itself would use, or a broader one." : tag ? "No links carry this tag." : "Add one here, connect your browser, or import the bookmarks you already have. There are no folders to keep up."}</p>
            {!query && !tag && <Button className="primary" onClick={() => setAdding(true)}>Add a link</Button>}
          </div>}
        {cursor && <Button className="secondary more" onClick={() => void more()}>Show more</Button>}
        <footer className="library-footer"><span>{list.data ? plural(list.data.setup.total, "link saved", "links saved") : ""}</span><span>{client.localOwner ? "Saved on this computer" : "Your private collection"}</span></footer>
      </section>
      {selectedId && <Inspector key={selectedId} id={selectedId} query={query} onClose={() => select(null)} onChanged={refresh} />}
    </main>
    {adding && <AddDialog onClose={() => setAdding(false)} onSaved={async (record) => { setAdding(false); await refresh(); select(record); }} />}
    {importing && <ImportDialog onClose={() => setImporting(false)} onApplied={refresh} />}
  </div>;
}

// ─── One link ───────────────────────────────────────────────────────────────

function Inspector({ id, query, onClose, onChanged }: { id: string; query: string; onClose(): void; onChanged(): Promise<void> }) {
  const client = useAppClient();
  const detail = useAction<BookmarkDetail>("get_bookmark", { id });
  const [record, setRecord] = useState<BookmarkRecord | null>(null);
  const [fields, setFields] = useState<{ title: string; note: string; tags: string } | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showText, setShowText] = useState(false);
  // Fill the form once. A refresh never overwrites what someone is typing.
  useEffect(() => {
    if (!detail.data) return;
    setRecord(detail.data.bookmark);
    setFields((current) => current ?? { title: detail.data!.bookmark.title, note: detail.data!.bookmark.note ?? "", tags: detail.data!.bookmark.tags.join(", ") });
  }, [detail.data]);
  if (detail.error) return <aside className="inspector"><button className="close" aria-label="Close" onClick={onClose}>×</button><p role="alert" className="error">{detail.error}</p></aside>;
  if (!record || !fields) return <aside className="inspector"><p className="empty">Opening…</p></aside>;
  const save = async () => {
    setBusy(true); setNotice("");
    try {
      const result = await client.call<UpdateResult>("update_bookmark", { id: record.id, expectedRevision: record.revision, title: fields.title, note: fields.note.trim() || null, tags: parseTags(fields.tags) });
      if (result.status === "conflict") {
        // Keep what was typed. Saving again applies it over the newer version.
        setRecord(result.current);
        setNotice("This link changed elsewhere while you were editing. Your changes are still here. Save again to keep them.");
        return;
      }
      setRecord(result.record);
      setFields({ title: result.record.title, note: result.record.note ?? "", tags: result.record.tags.join(", ") });
      client.select({ id: result.record.id, title: result.record.title });
      client.didChange(`Changed “${result.record.title}”`);
      setNotice("Saved.");
      await onChanged();
    } catch (error) { setNotice(errorMessage(error)); } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try {
      const result = await client.call<{ status: "deleted" } | { status: "conflict"; current: BookmarkRecord; message: string }>("delete_bookmark", { id: record.id, expectedRevision: record.revision });
      if (result.status === "conflict") { setRecord(result.current); setDeleting(false); setNotice(`${result.message}. Look it over, then delete it again if you still want to.`); return; }
      setDeleting(false);
      onClose();
      await onChanged();
    } catch (error) { setNotice(errorMessage(error)); } finally { setBusy(false); }
  };
  const text = detail.data?.pageText;
  return <aside className="inspector" aria-label={record.title}>
    <button className="close" aria-label="Close" onClick={onClose}>×</button>
    <p className="eyebrow">{record.site} · {VIA_LABELS[record.via] ?? "Saved"} {savedLabel(record.savedAt)}</p>
    <h2><OpenLink url={record.url}>{record.title}</OpenLink></h2>
    <p className="url">{record.url}</p>
    <p className={record.page.state === "read" ? "muted small" : "page-state"}>{record.page.label}{record.page.state === "read" && record.page.chars ? `, ${plural(record.page.chars, "character", "characters")}${record.page.source === "browser" ? " from your browser" : ""}` : ""}</p>
    <Form onSubmit={() => save()}>
      <label>Title<input value={fields.title} maxLength={500} onChange={(event) => setFields({ ...fields, title: event.target.value })} /></label>
      <label>Tags<input value={fields.tags} placeholder="Separate with commas" onChange={(event) => setFields({ ...fields, tags: event.target.value })} /></label>
      <label>Note<textarea rows={4} maxLength={4000} value={fields.note} onChange={(event) => setFields({ ...fields, note: event.target.value })} /></label>
      {notice && <p role="status" className="small">{notice}</p>}
      <div className="actions"><Button className="primary" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
        {!client.embedded && <Button type="button" className="danger" onClick={() => setDeleting(true)} disabled={busy}>Delete</Button>}</div>
    </Form>
    {client.embedded && <p className="muted small">To delete a link, open Bookmarks itself. Assistants can save and change links but never delete them.</p>}
    {text && <section className="page-text">
      <button type="button" className="text-button" aria-expanded={showText} onClick={() => setShowText(!showText)}>{showText ? "Hide what the page said" : "What the page said"}</button>
      {showText && <><p className="muted small">Saved from the web. Reference only.</p><div className="page-body"><Marked text={text.slice(0, 6000)} query={query} />{text.length > 6000 ? "…" : ""}</div></>}
    </section>}
    {deleting && <Modal open={deleting} onOpenChange={setDeleting} title="Delete this link?">
      <p>“{record.title}” goes, with its note, tags and the text saved from the page. This can’t be undone.</p>
      <div className="actions"><Button className="secondary" onClick={() => setDeleting(false)}>Keep it</Button><Button className="danger" disabled={busy} onClick={() => void remove()}>{busy ? "Deleting…" : "Delete"}</Button></div>
    </Modal>}
  </aside>;
}

function AddDialog({ onClose, onSaved }: { onClose(): void; onSaved(record: BookmarkRecord): Promise<void> }) {
  const client = useAppClient();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return <Modal open onOpenChange={(open) => { if (!open) onClose(); }} title="Add a link">
    <Form onSubmit={async (form) => {
      setBusy(true); setError("");
      try {
        const result = await client.call<{ created: boolean; record: BookmarkRecord }>("save_bookmark", {
          url: String(form.get("url") ?? ""), title: String(form.get("title") ?? "") || null, note: String(form.get("note") ?? "") || null, tags: parseTags(String(form.get("tags") ?? "")),
        });
        client.didChange(`${result.created ? "Saved" : "Updated"} “${result.record.title}”`);
        await onSaved(result.record);
      } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
    }}>
      <label>Link<input name="url" type="url" required maxLength={4096} autoFocus placeholder="https://" /></label>
      <label>Title <span className="muted">optional</span><input name="title" maxLength={500} placeholder="The page’s own title is used when it is read" /></label>
      <label>Tags <span className="muted">optional</span><input name="tags" placeholder="Separate with commas" /></label>
      <label>Note <span className="muted">optional</span><textarea name="note" rows={3} maxLength={4000} /></label>
      {error && <p role="alert" className="error">{error}</p>}
      <p className="muted small">Saving a link you already have adds its tags to the same record.</p>
      <Button className="primary" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
    </Form>
  </Modal>;
}

// ─── Import ─────────────────────────────────────────────────────────────────

const FORMATS: Record<ImportPreview["format"], string> = { browser_html: "Bookmarks file", csv: "CSV file", link_list: "List of links" };

export function ImportDialog({ onClose, onApplied }: { onClose(): void; onApplied(): Promise<void> | void }) {
  const client = useAppClient();
  const [mode, setMode] = useState<"file" | "paste">("file");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [reading, setReading] = useState("");
  const [problem, setProblem] = useState("");
  const chooseFile = async (file: File | undefined) => {
    if (!file) return;
    setProblem("");
    try {
      if (file.size > 32 * 1024 * 1024) throw new Error("This file is larger than 32 MB");
      setReading("Reading the file");
      const parts = splitParts(readSelectedFile(new Uint8Array(await file.arrayBuffer())));
      const uploadId = crypto.randomUUID();
      for (const [part, chunk] of parts.entries()) {
        if (parts.length > 1) setReading(`Reading the file, part ${part + 1} of ${parts.length}`);
        await client.call("upload_import_part", { uploadId, part, total: parts.length, text: chunk });
      }
      setReading("Looking through your links");
      setPreview(await client.call<ImportPreview>("preview_import", { uploadId, fileName: file.name.slice(0, 200) }));
    } catch (error) { setProblem(errorMessage(error, "This file could not be read. Choose it again.")); } finally { setReading(""); }
  };
  const readPasted = async () => {
    if (!text.trim()) return setProblem("Paste some links first");
    setProblem(""); setReading("Looking through your links");
    try { setPreview(await client.call<ImportPreview>("preview_import", { text })); }
    catch (error) { setProblem(errorMessage(error)); } finally { setReading(""); }
  };
  const confirm = async () => {
    if (!preview) return;
    setProblem(""); setReading("Importing");
    try {
      const applied = await client.call<ImportResult>("apply_import", { previewId: preview.previewId, digest: preview.digest });
      setResult(applied);
      await onApplied();
    } catch (error) { setProblem(errorMessage(error)); } finally { setReading(""); }
  };
  return <Modal open onOpenChange={(open) => { if (!open && !reading) onClose(); }} title="Import bookmarks">
    {result ? <div className="stack">
      <p role="status"><strong>Imported {plural(result.added, "new link", "new links")}.</strong> {[result.updated ? `${plural(result.updated, "link", "links")} you already had gained tags or dates.` : null, result.unchanged ? `${plural(result.unchanged, "link was", "links were")} already up to date.` : null].filter(Boolean).join(" ") || "Everything in the file is now in Bookmarks."}</p>
      <Button className="primary" onClick={onClose}>Done</Button>
    </div> : preview ? <div className="stack">
      <p className="muted small">{FORMATS[preview.format]}{preview.fileName ? `, ${preview.fileName}` : ""}</p>
      <div className="counts">
        <span><strong>{preview.fresh.toLocaleString()}</strong> new</span>
        <span><strong>{preview.known.toLocaleString()}</strong> already saved</span>
        {!!preview.skipped && <span><strong>{preview.skipped.toLocaleString()}</strong> not web links, left out</span>}
      </div>
      {preview.truncated && <p className="notice">This file holds more than 50,000 links. The first 50,000 are imported.</p>}
      {!!preview.tags.length && <p className="small">Folders become tags: {preview.tags.map((tag) => `${tag.tag} (${tag.count})`).join(", ")}</p>}
      <ul className="samples">{preview.samples.map((sample) => <li key={sample.url}><strong>{sample.title ?? sample.url}</strong><span className="muted small">{sample.url}</span></li>)}</ul>
      {problem && <p role="alert" className="error">{problem}</p>}
      <div className="actions"><Button className="secondary" disabled={!!reading} onClick={() => { setPreview(null); setProblem(""); }}>Back</Button>
        <Button className="primary" disabled={!!reading} onClick={() => void confirm()}>{reading || `Import ${plural(preview.total, "link", "links")}`}</Button></div>
    </div> : <div className="stack">
      <p className="muted">Nothing changes until you confirm. Links you already have merge, so importing twice is safe.</p>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={mode === "file"} className={mode === "file" ? "chip active" : "chip"} onClick={() => setMode("file")}>A file</button>
        <button type="button" role="tab" aria-selected={mode === "paste"} className={mode === "paste" ? "chip active" : "chip"} onClick={() => setMode("paste")}>Pasted links</button>
      </div>
      {mode === "file" ? <label className="file">Choose a browser bookmarks export, a Raindrop export, or a CSV with a url column
        <input type="file" accept=".html,.htm,.csv,.txt,text/html,text/csv,text/plain" disabled={!!reading} onChange={(event) => void chooseFile(event.target.files?.[0])} /></label>
        : <><label>Links<textarea rows={6} value={text} onChange={(event) => setText(event.target.value)} placeholder="Paste text with links in it" /></label>
          <Button className="primary" disabled={!!reading} onClick={() => void readPasted()}>{reading || "Continue"}</Button></>}
      {reading && mode === "file" && <p role="status" className="small">{reading}</p>}
      {problem && <p role="alert" className="error">{problem}</p>}
    </div>}
  </Modal>;
}

// ─── The bookmarklet's and Shortcut's save page ─────────────────────────────

/**
 * What the bookmarklet and the iPhone Shortcut open: it saves the link straight
 * away, then lets the person add tags or a note. A repeat merges, so a reload
 * changes nothing.
 */
export function SaveScreen() {
  const client = useAppClient();
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const link = params.get("url");
  const [record, setRecord] = useState<BookmarkRecord | null>(null);
  const [problem, setProblem] = useState("");
  const [tags, setTags] = useState("");
  const [note, setNote] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  useEffect(() => {
    if (!link || started.current) return;
    started.current = true;
    client.call<{ created: boolean; record: BookmarkRecord }>("save_bookmark", { url: link.slice(0, 4096), title: params.get("title")?.slice(0, 2000) || null, via: params.get("via") === "shortcut" ? "shortcut" : "bookmarklet" }).then((result) => {
      // The address names the saved link now, so Back or a reload never saves it again.
      navigate(`/save?saved=${encodeURIComponent(result.record.id)}`, { replace: true });
      setRecord(result.record);
      setTags(result.record.tags.join(", "));
      setNote(result.record.note ?? params.get("note") ?? "");
    }, (error) => setProblem(errorMessage(error)));
  }, [link]);
  const finish = async () => {
    if (!record) return;
    if (tags.trim() || note.trim()) {
      setBusy(true);
      const send = (expectedRevision: number) => client.call<UpdateResult>("update_bookmark", { id: record.id, expectedRevision, tags: parseTags(tags), note: note.trim() || null });
      try {
        // Only moments have passed, so what was just typed wins over a change made meanwhile.
        const first = await send(record.revision);
        if (first.status === "conflict" && (await send(first.current.revision)).status === "conflict") return setProblem("This link keeps changing. Add your tags from Bookmarks.");
      } catch (error) { return setProblem(errorMessage(error)); } finally { setBusy(false); }
    }
    setDone(true);
  };
  if (!link && !record) return <main className="save-page"><h1>Save a link</h1><p>Open this page from the bookmarklet or the iPhone Shortcut. <Link to="/connect">Set them up</Link>.</p></main>;
  return <main className="save-page">
    <p className="eyebrow">{appConfig.name}</p>
    {problem ? <><h1>This link could not be saved</h1><p role="alert" className="error">{problem}</p></>
      : !record ? <p aria-live="polite">Saving…</p>
      : done ? <><h1>Saved.</h1><p role="status">You can close this window.</p><Link className="secondary" to={`/bookmarks/${encodeURIComponent(record.id)}`}>See it in Bookmarks</Link></>
      : <Form onSubmit={() => finish()}>
        <h1>Saved.</h1>
        <p role="status"><strong>{record.title}</strong></p>
        <p className="url">{record.url}</p>
        <label>Tags <span className="muted">optional, separate with commas</span><input value={tags} onChange={(event) => setTags(event.target.value)} autoFocus /></label>
        <label>Note <span className="muted">optional</span><textarea rows={3} maxLength={4000} value={note} onChange={(event) => setNote(event.target.value)} /></label>
        <Button className="primary" disabled={busy}>{busy ? "Saving…" : "Done"}</Button>
      </Form>}
  </main>;
}

// ─── Connect a browser or phone ─────────────────────────────────────────────

function Bookmarklet({ code }: { code: string }) {
  // React refuses javascript: addresses in href, so the link gets it directly.
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => { ref.current?.setAttribute("href", code); }, [code]);
  return <a ref={ref} className="bookmarklet" onClick={(event) => event.preventDefault()} draggable>Save to Bookmarks</a>;
}

export function ConnectScreen() {
  const client = useAppClient();
  const [notice, setNotice] = useState("");
  const [importing, setImporting] = useState(false);
  const origin = client.url.origin;
  if (client.embedded) return <div className="workspace"><Header /><main className="connect-page"><h1>Connect a browser or phone</h1><p>Open Bookmarks in your browser at {origin} to connect the extension, the bookmarklet or an iPhone Shortcut.</p></main></div>;
  const phone = reachableFromPhone(origin);
  const getExtension = async () => {
    try {
      const pkg = await client.call<{ fileName: string; version: string; base64: string }>("get_extension_package");
      download(pkg.fileName, fromBase64(pkg.base64), "application/zip");
      setNotice(`Downloaded version ${pkg.version}.`);
    } catch (error) { setNotice(errorMessage(error)); }
  };
  const exportFile = async () => {
    try {
      const file = await client.call<{ fileName: string; text: string; count: number; truncated: boolean }>("export_bookmarks");
      download(file.fileName, file.text, "text/html");
      setNotice(`Exported ${plural(file.count, "link", "links")}.${file.truncated ? " The file reached its size limit, so the oldest links are left out." : ""}`);
    } catch (error) { setNotice(errorMessage(error)); }
  };
  return <div className="workspace"><Header />
    <main className="connect-page">
      <h1>Save from anywhere</h1>
      <p className="muted">Each way in saves to this app and nowhere else.</p>
      {notice && <p role="status" className="notice">{notice}</p>}
      <section>
        <h2>Your browser</h2>
        <p>The extension copies the bookmarks you make (Cmd+D) and saves the page you are reading with the text you can see, including behind a login. It can also bring in every bookmark already in the browser, with folders as tags.</p>
        <ol>
          <li><Button className="secondary" onClick={() => void getExtension()}>Download the extension</Button></li>
          <li>Unzip it. In Chrome, open <code>chrome://extensions</code>, turn on Developer mode and choose Load unpacked.</li>
          <li>In the extension’s options, enter <code>{origin}</code> and choose Connect. Bookmarks asks you here to allow it, the same way it asks any assistant.</li>
        </ol>
        <p className="muted small">Each connected browser is listed in <Link to="/settings">Settings</Link> under Connect your assistant, where you can disconnect it.</p>
      </section>
      <section>
        <h2>A bookmarklet</h2>
        <p>Drag this to your bookmarks bar. It opens a small window that saves the page, using this app’s own sign-in. It holds no key.</p>
        <Bookmarklet code={bookmarkletFor(origin)} />
      </section>
      <section>
        <h2>Your iPhone</h2>
        {phone ? <>
          <p>Make a Shortcut that appears in the share sheet:</p>
          <ol>
            <li>In Shortcuts, add <em>Receive URLs from Share Sheet</em>.</li>
            <li>Add <em>URL</em> with <code>{shortcutPrefix(origin)}</code> followed by <em>Shortcut Input</em> (URL-encoded).</li>
            <li>Add <em>Open URLs</em>. Safari opens the save page, where you’re already signed in.</li>
          </ol>
        </> : <p>Your phone can’t reach Bookmarks at <code>{origin}</code>, which is this computer’s own address. To save from your phone, run Bookmarks at an address the phone can reach, with sign-in on (its README covers Cloudflare and a private network). Then this section shows the Shortcut.</p>}
      </section>
      <section>
        <h2>Bring in and take out</h2>
        <p>Import a browser export, a Raindrop export, a CSV with a url column, or pasted links. Export makes a bookmarks file any browser or bookmark service can read.</p>
        <div className="actions"><Button className="secondary" onClick={() => setImporting(true)}>Import</Button><Button className="secondary" onClick={() => void exportFile()}>Export a bookmarks file</Button></div>
      </section>
    </main>
    {importing && <ImportDialog onClose={() => setImporting(false)} onApplied={() => setNotice("Imported.")} />}
  </div>;
}

// ─── The card show_bookmarks draws in a chat ────────────────────────────────

export function BookmarksCard({ data }: { data: ShowData }) {
  const client = useAppClient();
  const [items, setItems] = useState(data.items);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setItems(data.items); }, [data.items]);
  useEffect(() => () => client.select(null), [client.select]);
  return <ViewCard title={data.title} count={items.length ? `${items.length}${data.more ? "+" : ""}` : undefined} footer={data.more ? `More in ${client.config.name}.` : undefined}>
    {error && <p role="alert" className="error">{error}</p>}
    {items.length ? <ul className="view-list">{items.map((item) => <li key={item.id} className="view-row">
      <span className="initial small" aria-hidden="true">{initialOf(item.site)}</span>
      <div className="view-row-body">
        <button type="button" className="as-link" onClick={() => { const next = open === item.id ? null : item.id; setOpen(next); client.select(next ? { id: item.id, title: item.title } : null); }}><strong><Marked text={item.title} query={data.query} /></strong></button>
        <span className="row-meta">{item.site} · {savedLabel(item.savedAt)}{item.tags.length ? ` · ${item.tags.join(", ")}` : ""}</span>
        {(item.snippet ?? item.excerpt) && <span className="row-passage"><Marked text={(item.snippet ?? item.excerpt)!} query={data.query} /></span>}
        {open === item.id && <Form className="card-edit" onSubmit={async (form) => {
          setBusy(true); setError("");
          try {
            const result = await client.call<UpdateResult>("update_bookmark", { id: item.id, expectedRevision: item.revision, tags: parseTags(String(form.get("tags") ?? "")), note: String(form.get("note") ?? "").trim() || null });
            if (result.status === "conflict") { setItems((current) => current.map((row) => row.id === item.id ? result.current : row)); setError("This link changed elsewhere. Look again, then save."); return; }
            setItems((current) => current.map((row) => row.id === item.id ? result.record : row));
            client.didChange(`Changed tags or note on “${result.record.title}”`);
            setOpen(null);
          } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
        }}>
          <OpenLink url={item.url} className="small">{item.url}</OpenLink>
          <label>Tags<input name="tags" defaultValue={item.tags.join(", ")} /></label>
          <label>Note<textarea name="note" rows={2} defaultValue={item.note ?? ""} /></label>
          <Button className="primary" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
        </Form>}
      </div>
    </li>)}</ul> : <p className="view-empty">No saved links match.</p>}
  </ViewCard>;
}
/** Cards for the app's show_* tools. Anything else in an assistant draws the whole app. */
export const viewCards = { show_bookmarks: BookmarksCard };

export function AppScreens() {
  return <Routes>
    <Route path="/" element={<Library />} />
    <Route path="/bookmarks/:id" element={<Library />} />
    <Route path="/save" element={<SaveScreen />} />
    <Route path="/connect" element={<ConnectScreen />} />
    <Route path="/settings" element={<ConnectionSettings />} />
    <Route path="/oauth/consent" element={<ConsentScreen />} />
    <Route path="*" element={<Library />} />
  </Routes>;
}
