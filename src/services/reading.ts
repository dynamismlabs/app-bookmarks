/**
 * Reading saved pages. The `read_pages` job runs one bounded step every five
 * minutes. Each page is read through the person's hub (Ri's read_web_page),
 * never with fetch in the app, so the hub's floor applies: no sign-ins, no
 * private networks. A record stays waiting until a step finishes it, so an
 * interrupted step just runs again. Saved text is for search and reference,
 * never instructions.
 */
import { connectors, SetupRequired, SourceUnavailable, type Context } from "@app-builder/core";
import { readHtml, readPlainText } from "../domain/page";
import { bookmarksFor, clock, type BookmarkRow, type Bookmarks } from "./store";

/** The hub tool this app reads pages with. */
export const READ_WEB_PAGE = "ri__read_web_page";
export const PAGES_PER_STEP = 12;
const BUDGET_MS = 20_000;
const CONCURRENT = 4;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];

/** What Ri's read_web_page returns. Failures are results, so the app can say why a page couldn't be read. */
export interface WebPage { outcome: string; status: number | null; contentType: string | null; text: string | null }
export interface StepResult { status: "idle" | "worked"; read: number; waiting: number; summary: string }

export async function applyPage(t: Bookmarks, row: BookmarkRow, page: WebPage) {
  const attempts = row.pageAttempts + 1;
  if (page.outcome === "read" && page.text !== null) {
    const content = /html|xml/i.test(page.contentType ?? "") ? readHtml(page.text) : readPlainText(page.text);
    if (content.text) return t.recordPage(row.id, { state: "read", title: content.title, excerpt: content.excerpt, text: content.text, attempts });
    // Almost certainly a page drawn by scripts. The browser button can still save it.
    return t.recordPage(row.id, { state: "needs_browser", title: content.title, excerpt: content.excerpt, attempts });
  }
  if (page.outcome === "not_text") return t.recordPage(row.id, { state: "no_text", attempts });
  if (page.outcome === "blocked") return t.recordPage(row.id, { state: "needs_browser", attempts });
  if (page.outcome === "invalid" || page.outcome === "too_many_redirects") return t.recordPage(row.id, { state: "failed", attempts });
  if (page.outcome === "http_error" && (page.status === 404 || page.status === 410)) return t.recordPage(row.id, { state: "gone", attempts });
  if (page.outcome === "http_error" && page.status !== null && page.status >= 400 && page.status < 500) return t.recordPage(row.id, { state: "needs_browser", attempts });
  if (attempts >= MAX_ATTEMPTS) return t.recordPage(row.id, { state: "failed", attempts });
  return t.recordPage(row.id, { state: "waiting", attempts, nextAt: new Date(clock.now().getTime() + BACKOFF_MS[attempts - 1]).toISOString() });
}

/** One step for the person the job runs as (the installation's owner). */
export async function readingStep(ctx: Context): Promise<StepResult> {
  const t = bookmarksFor(ctx.platform, ctx.viewer.id);
  await t.failExhausted(MAX_ATTEMPTS);
  const due = await t.dueForReading(PAGES_PER_STEP);
  await t.setState("reading.lastStepAt", clock.now().toISOString());
  if (!due.length) return { status: "idle", read: 0, waiting: (await t.counts()).waiting, summary: "Nothing is due to be read" };
  const hub = connectors(ctx);
  try {
    // Ask before the first read, so a missing grant is one clear message rather than twelve failures.
    if (!(await hub.tools()).includes(READ_WEB_PAGE))
      throw new SetupRequired("Bookmarks hasn't been allowed to read web pages. Allow \"Read public web pages\" for Bookmarks in Ri, then run this again from Settings.");
    const stopAt = Date.now() + BUDGET_MS;
    const queue = [...due];
    let read = 0;
    let stopped: unknown = null;
    const worker = async () => {
      for (let row = queue.shift(); row && !stopped && Date.now() < stopAt; row = queue.shift()) {
        // A hostile page can take the whole step down while it is parsed, and nothing after this line would run.
        await t.setAttempt(row.id, row.pageAttempts + 1, new Date(clock.now().getTime() + BACKOFF_MS[Math.min(row.pageAttempts, BACKOFF_MS.length - 1)]).toISOString());
        try {
          await applyPage(t, row, await hub.call(READ_WEB_PAGE, { url: row.url }) as WebPage);
          read++;
        } catch (error) {
          if (error instanceof SetupRequired || error instanceof SourceUnavailable) {
            // Not the page's fault, so it doesn't count against it. The run stops and says why.
            await t.setAttempt(row.id, row.pageAttempts, row.pageNextAt);
            stopped ??= error;
          } else await applyPage(t, row, { outcome: "unreachable", status: null, contentType: null, text: null });
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENT }, worker));
    if (stopped) throw stopped;
    const waiting = (await t.counts()).waiting;
    return { status: "worked", read, waiting, summary: `Read ${read} ${read === 1 ? "page" : "pages"}, ${waiting} waiting` };
  } finally {
    await hub.close();
  }
}
