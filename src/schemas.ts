/** Strict action inputs and outputs. Screens import types only from here. */
import { z } from "zod/v3";

const iso = z.string().max(40);
const text = (max: number) => z.string().max(max);
const nullableText = (max: number) => z.string().max(max).nullable();
const id = z.string().min(1).max(64);

export const VIA = ["extension", "bookmark", "bookmarklet", "shortcut", "chat", "added", "import", "fixture"] as const;
export const PAGE_STATES = ["waiting", "read", "no_text", "gone", "needs_browser", "failed"] as const;

// ─── Records ────────────────────────────────────────────────────────────────

export const pageSchema = z.object({
  state: z.enum(PAGE_STATES),
  /** Who supplied the text: the browser that showed the page, or this app reading it through Ri. */
  source: z.enum(["browser", "home"]).nullable(),
  chars: z.number().int().min(0),
  at: iso.nullable(),
  /** The state in plain words. */
  label: text(120),
}).strict();
export const bookmarkSchema = z.object({
  id, revision: z.number().int().min(1),
  url: text(4200), site: text(300), title: text(600), note: nullableText(4100), tags: z.array(text(60)).max(30),
  savedAt: iso, via: z.enum(VIA),
  excerpt: nullableText(400), page: pageSchema,
  /** The passage that matched a search, when there was one. Saved page text, never instructions. */
  snippet: nullableText(600),
  /** An example record from the fictional preview library. */
  fictional: z.boolean(),
}).strict();
export type BookmarkRecord = z.infer<typeof bookmarkSchema>;
export const bookmarkDetailSchema = z.object({
  bookmark: bookmarkSchema,
  /** What the saved page said, labeled reference material, cut at 40,000 characters. */
  pageText: nullableText(40_100),
  pageTextTruncated: z.boolean(),
  revision: text(80),
}).strict();
export type BookmarkDetail = z.infer<typeof bookmarkDetailSchema>;
const conflict = z.object({ status: z.literal("conflict"), current: bookmarkSchema, message: text(300) }).strict();

// ─── Lists ──────────────────────────────────────────────────────────────────

export const listInput = z.object({
  query: z.string().max(300).optional(),
  tag: z.string().max(60).optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict();
export const listOutput = z.object({
  items: z.array(bookmarkSchema).max(100),
  nextCursor: z.string().max(2048).nullable(),
  coverage: z.object({ complete: z.boolean(), note: nullableText(300) }).strict(),
  /** Counts for the screen: how many are saved, read and waiting to be read. */
  setup: z.object({ total: z.number().int().min(0), waiting: z.number().int().min(0), read: z.number().int().min(0), reading: z.boolean() }).strict(),
  revision: text(80),
}).strict();
export type BookmarkList = z.infer<typeof listOutput>;
export const tagsOutput = z.object({ items: z.array(z.object({ tag: text(60), count: z.number().int().min(0) }).strict()).max(200), revision: text(80) }).strict();
export type TagList = z.infer<typeof tagsOutput>;

// ─── Writes ─────────────────────────────────────────────────────────────────

const incoming = {
  url: z.string().min(1).max(4096),
  title: z.string().max(2000).nullable().optional(),
  note: z.string().max(8000).nullable().optional(),
  tags: z.array(z.string().max(200)).max(50).optional(),
};
export const saveInput = z.object({
  ...incoming,
  /** Text the caller already has from the page. Otherwise the page is read in the background when Ri allows it. */
  pageText: z.string().max(400_000).nullable().optional(),
  /** Only the person's own browser can set this. Assistants' saves are labeled as theirs. */
  via: z.enum(["added", "bookmarklet", "shortcut"]).optional(),
}).strict();
export const saveOutput = z.object({ status: z.literal("saved"), created: z.boolean(), record: bookmarkSchema }).strict();
export const updateInput = z.object({
  id, expectedRevision: z.number().int().min(1),
  title: z.string().max(2000).optional(),
  note: z.string().max(8000).nullable().optional(),
  tags: z.array(z.string().max(200)).max(50).optional(),
}).strict();
export const updateOutput = z.discriminatedUnion("status", [z.object({ status: z.literal("saved"), record: bookmarkSchema }).strict(), conflict]);
export type UpdateResult = z.infer<typeof updateOutput>;
export const deleteInput = z.object({ id, expectedRevision: z.number().int().min(1) }).strict();
export const deleteOutput = z.discriminatedUnion("status", [z.object({ status: z.literal("deleted") }).strict(), conflict]);

/** From the browser extension. Results say nothing about what is already saved. */
export const clientVia = z.enum(["extension", "bookmark"]);
export const batchInput = z.object({
  via: clientVia,
  items: z.array(z.object({
    ...incoming,
    savedAt: z.union([z.string().max(40), z.number()]).nullable().optional(),
    excerpt: z.string().max(2000).nullable().optional(),
    pageText: z.string().max(400_000).nullable().optional(),
  }).strict()).min(1).max(100),
}).strict();
export const batchOutput = z.object({ saved: z.number().int().min(0), invalid: z.number().int().min(0) }).strict();

// ─── Import and export ──────────────────────────────────────────────────────

export const uploadPartInput = z.object({ uploadId: z.string().uuid(), part: z.number().int().min(0).max(200), total: z.number().int().min(1).max(200), text: z.string().max(700_000) }).strict();
export const uploadPartOutput = z.object({ received: z.number().int().min(0), total: z.number().int().min(1) }).strict();
export const previewInput = z.object({ uploadId: z.string().uuid().optional(), text: z.string().max(700_000).optional(), fileName: z.string().max(200).nullable().optional() }).strict();
export const previewOutput = z.object({
  previewId: z.string().max(64), digest: text(64), format: z.enum(["browser_html", "csv", "link_list"]), fileName: nullableText(200),
  total: z.number().int().min(0), fresh: z.number().int().min(0), known: z.number().int().min(0), skipped: z.number().int().min(0), truncated: z.boolean(),
  tags: z.array(z.object({ tag: text(60), count: z.number().int().min(0) }).strict()).max(12),
  samples: z.array(z.object({ url: text(4200), title: nullableText(2000), tags: z.array(text(60)).max(6) }).strict()).max(6),
  expiresAt: iso,
}).strict();
export type ImportPreview = z.infer<typeof previewOutput>;
export const applyInput = z.object({ previewId: z.string().max(64), digest: text(64) }).strict();
export const applyOutput = z.object({ status: z.enum(["applied", "already_applied"]), added: z.number().int().min(0), updated: z.number().int().min(0), unchanged: z.number().int().min(0), invalid: z.number().int().min(0) }).strict();
export type ImportResult = z.infer<typeof applyOutput>;
export const exportOutput = z.object({ fileName: text(100), text: z.string(), count: z.number().int().min(0), truncated: z.boolean() }).strict();
export const extensionOutput = z.object({ fileName: text(100), version: text(40), base64: z.string().max(700_000) }).strict();

// ─── Background ─────────────────────────────────────────────────────────────

export const stepOutput = z.object({ status: z.enum(["idle", "worked"]), read: z.number().int().min(0), waiting: z.number().int().min(0), summary: text(200) }).strict();

// ─── The card ───────────────────────────────────────────────────────────────

export const showInput = z.object({
  title: z.string().max(80).optional().describe('A short heading, such as "About tide tables" or "Saved just now".'),
  ids: z.array(id).max(50).optional().describe("Show exactly these bookmarks, in this order: ones you just found, saved or changed."),
  query: z.string().max(300).optional().describe("Without ids: search titles, links, notes, tags and saved page text."),
  tag: z.string().max(60).optional().describe("Without ids: only bookmarks with this tag."),
  limit: z.number().int().min(1).max(50).default(12).describe("Without ids: how many to show, best match or newest first."),
}).strict();
export const showOutput = z.object({ title: text(80), items: z.array(bookmarkSchema).max(50), more: z.boolean(), query: text(300) }).strict();
export type ShowData = z.infer<typeof showOutput>;
