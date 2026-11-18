/**
 * Bookmarks' assistant view in the kit's strict test host (tests/host/browser-host.ts, copied from
 * App Builder's packages/core/test/browser-host.ts): a scripts-only sandbox, a page that may not reach
 * the network, and a host that behaves like Ri. It keeps view-only tools from its model, drafts
 * ui/message, records links and downloads, and sends deep links. Each can be turned off to check the
 * view degrades. Mirrors the kit's AppBridge tests (tests/mcp-apps.ts, exerciseHostCalls).
 *
 * Run with `pnpm test:browser`, which builds first: the view is dist/mcp.html.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { createTestConnection, serveApp, type RunningApp } from "@app-builder/core/node";
import { application } from "../src/app";
import type { HostOptions } from "./host/browser-host";

const run = process.env.BROWSER_TESTS === "1" ? describe : describe.skip;
const root = path.resolve(import.meta.dirname, "..");
const VIEW_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";
type Result = { isError?: boolean; content: { type: string; text?: string }[]; structuredContent?: Record<string, any> };
type Message = { role: string; content: { type: string; text?: string }[]; _meta?: Record<string, unknown> };
type Download = { contents: { type: string; resource: { uri: string; mimeType: string; text?: string; blob?: string } }[] };

let app: RunningApp;
let origin: string;
let browser: Browser;
let hostBundle: string;
const dirs: string[] = [];

async function openHost() {
  const context = await browser.newContext();
  const page = await context.newPage();
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("console", (message) => { if (/Content Security Policy|Refused to/i.test(message.text())) failures.push(message.text()); });
  page.on("request", (request) => {
    if (request.frame().parentFrame() && !request.url().endsWith("/__mcp-view__")) failures.push("The view reached the network: " + request.url());
  });
  // The host connects the way any assistant does, with its own connection's token.
  const { accessToken: token } = await createTestConnection(app.platform, { name: "Qualification host" });
  const response = await page.request.post(origin + "/mcp", {
    headers: { accept: "application/json, text/event-stream", authorization: "Bearer " + token },
    data: { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "ui://bookmarks/main" } },
  });
  const resource = await response.json() as { result: { contents: { text: string; _meta: { ui: { csp: Record<string, string[]> } } }[] } };
  expect(resource.result.contents[0]._meta.ui.csp).toEqual({ connectDomains: [], resourceDomains: [] });
  await page.route("**/__mcp-view__", (route) => route.fulfill({ contentType: "text/html", headers: { "content-security-policy": VIEW_CSP }, body: resource.result.contents[0].text }));
  await page.route("**/__mcp-host__", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>MCP Apps qualification host</title><body style='margin:0'></body>" }));
  await page.goto(origin + "/__mcp-host__");
  await page.evaluate((value) => { (window as unknown as { mcpToken: string }).mcpToken = value; }, token);
  await page.addScriptTag({ content: hostBundle });
  const fixture = <T,>(fn: string, ...args: unknown[]) => page.evaluate(([fn, args]) => (window.mcpFixture as any)[fn as string](...(args as unknown[])), [fn, args] as const) as Promise<T>;
  return {
    page, failures,
    view: page.frameLocator("#app-frame"),
    mount: (tool: string, input: Record<string, unknown> = {}, options: HostOptions = {}) => fixture<Result>("mount", "/__mcp-view__", tool, input, options),
    /** The host's model calling a tool: view-only tools are refused. */
    call: (name: string, input: Record<string, unknown> = {}) => fixture<Result>("call", name, input),
    /** The host calling a tool for its own UI, such as its @ menu. */
    appCall: (name: string, input: Record<string, unknown> = {}) => fixture<Result>("appCall", name, input),
    modelTools: () => fixture<string[]>("modelTools"),
    deepLink: (url: string) => fixture<void>("deepLink", url),
    asked: () => page.evaluate(() => ({ messages: window.mcpFixture.messages, links: window.mcpFixture.links, downloads: window.mcpFixture.downloads })) as Promise<{ messages: Message[]; links: string[]; downloads: Download[] }>,
    modelContext: () => page.evaluate(() => ((window.mcpFixture.context as { content?: { text?: string }[] } | null)?.content ?? []).map((part) => part.text ?? "").join("\n")),
    displayMode: () => page.evaluate(() => window.mcpFixture.displayMode),
    close: () => context.close(),
  };
}
const poll = async <T,>(read: () => Promise<T>, check: (value: T) => boolean, timeout = 10_000) => {
  const until = Date.now() + timeout;
  let value = await read();
  while (!check(value) && Date.now() < until) { await new Promise((resolve) => setTimeout(resolve, 100)); value = await read(); }
  return value;
};

run("the view in a strict host", () => {
  beforeAll(async () => {
    if (!fs.existsSync(path.join(root, "dist/mcp.html"))) throw new Error("Build first: pnpm test:browser runs app-builder build.");
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bookmarks-host-")); dirs.push(dataDir);
    const port = 4800 + Math.floor(Math.random() * 400);
    app = await serveApp(application, { root, dataDir, port });
    origin = `http://127.0.0.1:${port}`;
    hostBundle = (await build({ entryPoints: [path.join(import.meta.dirname, "host/browser-host.ts")], bundle: true, write: false, format: "iife", platform: "browser" })).outputFiles[0].text;
    browser = await chromium.launch({ channel: "chromium", headless: true });
  }, 300_000);
  afterAll(async () => {
    await browser?.close();
    await app?.stop();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is the whole app: opens at a link, links out, drafts, saves files, imports, deletes, and follows host links", async () => {
    const host = await openHost();
    const { view } = host;
    try {
      // The model never sees the person's own actions, and the host refuses its call to one.
      const modelTools = await host.modelTools();
      expect(modelTools).toEqual(expect.arrayContaining(["list_bookmarks", "save_bookmark", "show_bookmarks", "open_bookmarks"]));
      for (const name of ["delete_bookmark", "upload_import_part", "preview_import", "apply_import", "export_bookmarks", "get_extension_package", "search_mentions", "read_settings", "change_settings"]) expect(modelTools, name).not.toContain(name);
      const tide = (await host.call("save_bookmark", { url: "https://harborlog.example/tide-tables", title: "Tide tables for small harbors", tags: ["sailing"], pageText: "Tide tables list the height of the water at each hour." })).structuredContent!.result.record;
      const bread = (await host.call("save_bookmark", { url: "https://breadnotes.example/sourdough", title: "Sourdough timing" })).structuredContent!.result.record;
      expect((await host.call("delete_bookmark", { id: tide.id, expectedRevision: tide.revision })).isError).toBe(true);
      // The host's @ menu finds bookmarks as links, and reads one as the connection.
      const found = await host.appCall("search_mentions", { query: "tide" });
      expect(found.structuredContent).toMatchObject({ items: [{ type: "resource_link", uri: `app://bookmarks/bookmarks/${tide.id}`, title: "Tide tables for small harbors" }] });

      // open_bookmarks at a link opens the whole app there, and the place reaches the assistant.
      const opened = await host.mount("open_bookmarks", { path: `/bookmarks/${tide.id}` });
      expect(opened.structuredContent).toEqual({ view: "open_bookmarks", path: `/bookmarks/${tide.id}` });
      expect(await poll(host.displayMode, (mode) => mode === "fullscreen")).toBe("fullscreen");
      await view.locator(".inspector h2").getByText("Tide tables for small harbors").waitFor();
      expect(await poll(host.modelContext, (text) => text.includes(`"path":"/bookmarks/${tide.id}"`))).toContain('"section":"All bookmarks"');
      // Open in browser opens the app's own address at the same link, through the host.
      await view.locator(".inspector").getByRole("button", { name: "Open in browser" }).click();
      expect((await poll(host.asked, (asked) => asked.links.length > 0)).links).toEqual([`${origin}/bookmarks/${tide.id}`]);
      // The saved page itself opens through the host's open-link.
      await view.locator(".inspector").getByRole("link", { name: "Tide tables for small harbors" }).click();
      expect((await poll(host.asked, (asked) => asked.links.length > 1)).links[1]).toBe("https://harborlog.example/tide-tables");
      // A question goes into the chat as a draft for the person to edit and send.
      await view.getByRole("button", { name: "Ask about this link" }).click();
      await view.getByText("It’s in the chat for you to edit and send.").waitFor();
      const [message] = (await host.asked()).messages;
      expect(message).toMatchObject({ role: "user", content: [{ type: "text", text: "Using my bookmark “Tide tables for small harbors”, " }] });
      expect(message._meta).toEqual({ "openai/message": { target: "active", send: false } });
      // A search reaches the assistant as the section's filters, and opens in the browser at the same search.
      await view.getByLabel("Search bookmarks").fill("sourdough");
      expect(await poll(host.modelContext, (text) => text.includes('"filters":{"Search":"sourdough"}'))).toContain('"section":"Search"');

      // Export saves a file through the host, with the file embedded.
      await host.mount("open_bookmarks", { path: "/connect" });
      await view.getByRole("button", { name: "Export a bookmarks file" }).click();
      const exported = (await poll(host.asked, (asked) => asked.downloads.length > 0)).downloads[0];
      expect(exported.contents[0]).toMatchObject({ type: "resource", resource: { uri: "file:///bookmarks.html", mimeType: "text/html" } });
      expect(exported.contents[0].resource.text).toContain("https://harborlog.example/tide-tables");
      // The browser extension downloads through the host as a zip.
      await view.getByRole("button", { name: "Download the extension" }).click();
      const zip = (await poll(host.asked, (asked) => asked.downloads.length > 1)).downloads[1];
      expect(zip.contents[0].resource).toMatchObject({ uri: "file:///bookmarks-extension.zip", mimeType: "application/zip" });
      expect(Buffer.from(zip.contents[0].resource.blob!, "base64").subarray(0, 2).toString()).toBe("PK");
      // Importing works in the view: pasted links, previewed, then applied once.
      await view.getByRole("button", { name: "Import" }).click();
      await view.getByRole("tab", { name: "Pasted links" }).click();
      await view.getByLabel("Links").fill("https://radio.example/antenna-basics and https://garden.example/winter-soil");
      await view.getByRole("button", { name: "Continue" }).click();
      await view.getByRole("button", { name: "Import 2 links" }).click();
      await view.getByText("Imported 2 new links.").waitFor();
      expect((await host.call("list_bookmarks", {})).structuredContent!.result.items).toHaveLength(4);

      // A host link moves the open app to another bookmark (Ri's links, OpenAI's deep links).
      await host.mount("open_bookmarks");
      await host.deepLink(`/bookmarks/${bread.id}`);
      await view.locator(".inspector h2").getByText("Sourdough timing").waitFor();
      // Deleting is the person's, from the view, though the model can't.
      await view.locator(".inspector").getByRole("button", { name: "Delete" }).click();
      await view.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
      await view.locator(".inspector").waitFor({ state: "detached" });
      const left = await poll(async () => (await host.call("list_bookmarks", {})).structuredContent!.result.items as { id: string }[], (items) => !items.some((item) => item.id === bread.id));
      expect(left.some((item) => item.id === bread.id)).toBe(false);
      expect(await poll(host.modelContext, (text) => text.includes("Deleted “Sourdough timing”"))).toContain("Deleted “Sourdough timing”");

      // A card opens the whole app at one link.
      await host.mount("show_bookmarks", { query: "tide" });
      await view.getByRole("button", { name: "Open Tide tables for small harbors" }).click();
      expect(await poll(host.displayMode, (mode) => mode === "fullscreen")).toBe("fullscreen");
      await view.locator(".inspector h2").getByText("Tide tables for small harbors").waitFor();

      // A host link at start opens there too.
      await host.mount("open_bookmarks", {}, { deepLink: `/bookmarks/${tide.id}` });
      await view.locator(".inspector h2").getByText("Tide tables for small harbors").waitFor();

      // Settings open inside the view (the core's view-only settings tools), with each connection and what it may do.
      await createTestConnection(app.platform, { name: "Bookmarks browser extension", addOnly: true });
      await host.mount("open_bookmarks");
      await view.getByLabel("Search bookmarks").waitFor();
      const linksBefore = (await host.asked()).links.length;
      await view.locator(".app-header").getByRole("link", { name: "Settings" }).click();
      await view.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
      await view.locator(".connection-row").filter({ hasText: "Qualification host (this one)" }).getByText("Can read and make changes").waitFor();
      await view.locator(".connection-row").filter({ hasText: "Bookmarks browser extension" }).getByText("Can only add").waitFor();
      await view.getByRole("heading", { name: "Your accounts through Ri" }).waitFor();
      // What it asks Ri for, in plain words from its hub declaration (kit #25), not "use your accounts".
      await view.getByText("Bookmarks asks Ri to read public web pages through Ri, to read the pages you save, so you can search what they said.", { exact: false }).waitFor();
      await view.getByRole("heading", { name: "Automations" }).waitFor();
      await view.getByText("Read saved pages").first().waitFor();
      expect(await poll(host.modelContext, (text) => text.includes('"path":"/settings"'))).toContain('"section":"Settings"');
      // The person removes the extension's connection here, without leaving the assistant.
      await view.locator(".connection-row").filter({ hasText: "Bookmarks browser extension" }).getByRole("button", { name: "Disconnect" }).click();
      await view.locator(".connection-row").filter({ hasText: "Bookmarks browser extension" }).waitFor({ state: "detached" });
      expect((await (await fetch(`${origin}/api/connections`, { headers: { origin } })).json() as { name: string }[]).map((row) => row.name)).toEqual(["Qualification host"]);
      await view.getByRole("button", { name: "← Back to Bookmarks" }).click();
      await view.getByLabel("Search bookmarks").waitFor();
      // None of it went through the host's open-link.
      expect((await host.asked()).links).toHaveLength(linksBefore);

      // A host without drafts, links or downloads: nothing is sent, and the view offers what it can.
      const before = await host.asked();
      await host.mount("open_bookmarks", { path: `/bookmarks/${tide.id}` }, { draft: false, openLinks: false, download: false });
      await view.locator(".inspector h2").getByText("Tide tables for small harbors").waitFor();
      expect(await view.getByRole("button", { name: "Open in browser" }).count()).toBe(0);
      expect(await view.locator(".inspector").getByRole("link", { name: "Tide tables for small harbors" }).count()).toBe(0);
      await view.locator(".inspector").getByText("https://harborlog.example/tide-tables").first().waitFor();
      await view.getByText("Ask about this link").click();
      expect(await view.locator(".inspector .ask-in-chat q").textContent()).toBe("Using my bookmark “Tide tables for small harbors”, ");
      await host.mount("open_bookmarks", { path: "/connect" }, { draft: false, openLinks: false, download: false });
      await view.getByRole("heading", { name: "Save from anywhere" }).waitFor();
      expect(await view.getByRole("button", { name: "Export a bookmarks file" }).count()).toBe(0);
      expect(await host.asked()).toEqual(before);
      expect(host.failures).toEqual([]);
    } finally { await host.close(); }
  }, 180_000);
});
