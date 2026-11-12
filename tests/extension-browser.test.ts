/**
 * The real extension in real Chromium, against the real app on a disposable
 * data directory. Run with `pnpm test:browser` (it needs Playwright's Chromium,
 * so the ordinary test run skips it).
 *
 * Headless automation can't answer the permission prompt, so this copy of the
 * extension is given 127.0.0.1 up front. Signing in from the extension is
 * refused by the kit today (docs/parity.md), so the first test shows that, and
 * the rest give the extension a connection made outside the browser, the way
 * it would hold one after Connect. An actual Cmd+D keystroke isn't covered:
 * creating a bookmark through the browser's API fires the same event.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page, type Worker } from "playwright-core";
import { serveApp, createTestConnection, type RunningApp } from "@app-builder/core/node";
import { application } from "../src/app";
import { bookmarksFor } from "../src/services/store";
import { EXTENSION_PACKAGE } from "../src/extension-package.generated";

/** The browser's extension API, inside the functions this test runs in the browser. */
declare const chrome: any;
const run = process.env.BROWSER_TESTS === "1" ? describe : describe.skip;
const source = path.resolve(import.meta.dirname, "../extension");
const dirs: string[] = [];
const temp = (prefix: string) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(dir); return dir; };

let app: RunningApp;
let origin: string;
let pages: http.Server;
let pagesOrigin: string;
let context: BrowserContext;
let worker: Worker;
let extensionId: string;

run("the extension in Chromium", () => {
  beforeAll(async () => {
    const port = 4400 + Math.floor(Math.random() * 400);
    app = await serveApp(application, { root: path.resolve(import.meta.dirname, ".."), dataDir: temp("bookmarks-browser-data-"), port });
    origin = `http://127.0.0.1:${port}`;
    // A page that only shows its text to someone signed in, as far as the extension can tell.
    pages = http.createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(`<html><head><title>A logged-in page</title><meta name="description" content="Short description"></head><body><nav>Menu</nav><article><p>${"Only people signed in can read this sentence about marmalade. ".repeat(10)}</p></article></body></html>`);
    });
    await new Promise<void>((resolve) => pages.listen(0, "127.0.0.1", resolve));
    pagesOrigin = `http://127.0.0.1:${(pages.address() as { port: number }).port}`;
    // The extension exactly as the app offers it, unzipped by the system's unzip, with the test's host allowed up front.
    const zip = path.join(temp("bookmarks-zip-"), "extension.zip");
    fs.writeFileSync(zip, Buffer.from(EXTENSION_PACKAGE.base64, "base64"));
    const copy = temp("bookmarks-ext-");
    (await import("node:child_process")).execFileSync("unzip", ["-q", zip, "-d", copy]);
    const manifest = JSON.parse(fs.readFileSync(path.join(copy, "manifest.json"), "utf8"));
    manifest.host_permissions = ["http://127.0.0.1/*"];
    fs.writeFileSync(path.join(copy, "manifest.json"), JSON.stringify(manifest));
    context = await chromium.launchPersistentContext(temp("bookmarks-profile-"), { channel: "chromium", headless: true, args: [`--disable-extensions-except=${copy}`, `--load-extension=${copy}`] });
    context.setDefaultTimeout(20_000);
    worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    extensionId = new URL(worker.url()).host;
  }, 300_000);
  afterAll(async () => {
    await context?.close();
    await app?.stop();
    pages?.closeAllConnections();
    await new Promise((resolve) => pages?.close(resolve));
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await worker.evaluate(async () => {
      await chrome.storage.local.clear();
      for (const node of (await chrome.bookmarks.getChildren("1"))) await chrome.bookmarks.removeTree(node.id);
      await chrome.action.setBadgeText({ text: "" });
    });
    await app.platform.driver.query({ sql: "DELETE FROM bookmarks", params: [], method: "run" });
  });

  const saved = async () => (await bookmarksFor(app.platform, "local-owner").newest({ limit: 100 })).map((row) => ({ url: row.url, title: row.title, tags: row.tags, via: row.via, source: row.pageSource }));
  const until = async <T,>(check: () => Promise<T>, done: (value: T) => boolean) => {
    for (let tries = 0; tries < 100; tries++) { const value = await check(); if (done(value)) return value; await new Promise((resolve) => setTimeout(resolve, 100)); }
    return check();
  };
  /** What the extension holds after Connect: its own connection, with a token from the app. */
  async function connected(overrides: Record<string, unknown> = {}) {
    const { accessToken, clientId } = await createTestConnection(app.platform, { name: "Bookmarks browser extension" });
    const connection = { app: origin, clientId, accessToken, refreshToken: null, tokenEndpoint: `${origin}/api/auth/mcp/token`, revocationEndpoint: null, resource: origin, expiresAt: Date.now() + 3_600_000, ...overrides };
    await worker.evaluate(async (value) => { await chrome.storage.local.set({ connection: value, mirror: true }); }, connection);
    return connection;
  }
  async function extensionPage(file: string): Promise<Page> {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/${file}`);
    return page;
  }
  const addBookmark = (input: { title: string; url: string; folder?: string }) => worker.evaluate(async ({ title, url, folder }) => {
    const parentId = folder ? (await chrome.bookmarks.create({ parentId: "1", title: folder })).id : "1";
    await chrome.bookmarks.create({ parentId, title, url });
  }, input);

  it("is refused when it signs in from the options page today, and says why", async () => {
    const page = await extensionPage("options.html");
    await page.getByLabel("Bookmarks address").fill(origin);
    await page.getByRole("button", { name: "Connect" }).click();
    await expect(page.getByRole("alert").textContent()).resolves.toMatch(/needs an update before a browser extension can sign in/);
    await page.close();
  });
  it("copies a bookmark to Bookmarks, with its folder as a tag", async () => {
    await connected();
    await addBookmark({ title: "Tide tables", url: "https://harbor.example/tide", folder: "Sailing" });
    expect(await until(saved, (rows) => rows.length > 0)).toEqual([{ url: "https://harbor.example/tide", title: "Tide tables", tags: ["sailing"], via: "bookmark", source: null }]);
  });
  it("ignores folders, browser pages and everything while switched off", async () => {
    await connected();
    await worker.evaluate(async () => {
      await chrome.bookmarks.create({ parentId: "1", title: "Just a folder" });
      await chrome.bookmarks.create({ parentId: "1", title: "Settings", url: "chrome://settings/" });
      await chrome.storage.local.set({ mirror: false });
    });
    await addBookmark({ title: "Off", url: "https://example.test/off" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await saved()).toEqual([]);
  });
  it("saves the tab with the text you can see", async () => {
    await connected();
    const tab = await context.newPage();
    await tab.goto(`${pagesOrigin}/article`);
    const popup = await extensionPage("options.html");
    const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url: url + "/*" }))[0].id, pagesOrigin);
    const result = await popup.evaluate((id) => chrome.runtime.sendMessage({ type: "save-tab", tab: { id, url: location.href, title: "" } }).catch(String), tabId);
    expect(result).toMatchObject({ outcome: "rejected" }); // An extension page isn't a web page.
    const real = await popup.evaluate(({ id, url }) => chrome.runtime.sendMessage({ type: "save-tab", tab: { id, url, title: "A logged-in page" } }), { id: tabId, url: `${pagesOrigin}/article` });
    expect(real).toMatchObject({ outcome: "ok", hasText: true });
    const [row] = await saved();
    expect(row).toMatchObject({ url: `${pagesOrigin}/article`, title: "A logged-in page", via: "extension", source: "browser" });
    const found = await bookmarksFor(app.platform, "local-owner").search({ query: "marmalade", offset: 0, limit: 5 });
    expect(found).toHaveLength(1);
    await tab.close();
    await popup.close();
  });
  it("keeps links while the app is away and sends them when it answers, losing nothing", async () => {
    const connection = await connected({ app: "http://127.0.0.1:9" });
    await addBookmark({ title: "Queued", url: "https://example.test/queued" });
    const queue = await until(() => worker.evaluate(async () => (await chrome.storage.local.get("queue")).queue ?? []), (items: unknown[]) => items.length > 0);
    expect(queue).toHaveLength(1);
    expect(await saved()).toEqual([]);
    await worker.evaluate(async (value) => { await chrome.storage.local.set({ connection: value }); }, { ...connection, app: origin });
    const page = await extensionPage("options.html");
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "flush" }));
    expect((await until(saved, (rows) => rows.length > 0)).map((row) => row.url)).toEqual(["https://example.test/queued"]);
    expect(await worker.evaluate(async () => (await chrome.storage.local.get("queue")).queue)).toEqual([]);
    await page.close();
  });
  it("says when its connection stops working, and keeps what it couldn't send", async () => {
    const connection = await connected();
    await app.platform.driver.query({ sql: "DELETE FROM oauth_access_tokens WHERE client_id = ?", params: [connection.clientId], method: "run" });
    await addBookmark({ title: "After", url: "https://example.test/after" });
    const state = await until(() => worker.evaluate(async () => chrome.storage.local.get(["disconnected", "queue"])), (value: { disconnected?: boolean }) => !!value.disconnected);
    expect(state).toMatchObject({ disconnected: true, queue: [expect.objectContaining({ url: "https://example.test/after" })] });
    expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe("!");
  });
  it("can't refresh an expired token from inside the browser today, and asks to connect again", async () => {
    // A real connection, made the way a server-side client makes one (no Origin), so the refresh token is good.
    const lib = await import("../extension/lib.js" as string);
    const { approveInBrowser } = await import("./oauth");
    const redirect = `https://${extensionId}.chromiumapp.org/bookmarks`;
    const meta = await lib.discover(fetch, origin);
    const clientId = await lib.register(fetch, meta, redirect);
    const { verifier, challenge } = await lib.pkcePair();
    const approved = await approveInBrowser(lib.authorizeUrl(meta, clientId, redirect, challenge, "s"), (request: Request) => fetch(request));
    const tokens = await lib.exchangeCode(fetch, meta, clientId, redirect, lib.codeFrom(approved.redirectURI, "s"), verifier);
    await worker.evaluate(async (value) => { await chrome.storage.local.set({ connection: value, mirror: true }); }, { ...lib.connectionFor(origin, meta, clientId, tokens), expiresAt: 0 });
    await addBookmark({ title: "Expired", url: "https://example.test/expired" });
    const state = await until(() => worker.evaluate(async () => chrome.storage.local.get(["disconnected", "lastError"])), (value: { disconnected?: boolean }) => !!value.disconnected);
    expect(state).toMatchObject({ disconnected: true, lastError: "Connect this browser to Bookmarks again" });
    // The same refresh token still works from outside the browser: the refusal was the origin check, not the token.
    const refreshed = await fetch(meta.tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refreshToken, resource: meta.resource }) });
    expect(refreshed.status).toBe(200);
  });
  it("imports every bookmark in batches, with folders as tags, and can repeat", async () => {
    await connected({});
    await worker.evaluate(async () => {
      await chrome.storage.local.set({ mirror: false });
      const folder = (await chrome.bookmarks.create({ parentId: "1", title: "Reading" })).id;
      for (let index = 0; index < 230; index++) await chrome.bookmarks.create({ parentId: folder, title: `Page ${index}`, url: `https://site${index % 7}.example/${index}` });
    });
    const page = await extensionPage("options.html");
    await page.getByRole("button", { name: /Import 230 bookmarks/ }).click();
    await expect(page.getByText("Sent 230 bookmarks to Bookmarks.").waitFor()).resolves.toBeUndefined();
    await page.getByRole("button", { name: /Import 230 bookmarks/ }).click();
    await page.getByText("Sent 230 bookmarks to Bookmarks.").waitFor();
    const rows = await bookmarksFor(app.platform, "local-owner").newest({ limit: 500 });
    expect(rows).toHaveLength(230);
    expect(rows.every((row) => row.tags.join() === "reading" && row.via === "bookmark")).toBe(true);
    await page.close();
  });
});
