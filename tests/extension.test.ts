/** The extension's logic, its OAuth connection to the real app, and that the copy the app offers matches the folder. */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { EXTENSION_PACKAGE } from "../src/extension-package.generated";
import { buildZip, generatedSource, listFiles } from "../scripts/package-extension";
// @ts-expect-error plain JavaScript, on purpose: the folder loads into a browser as it is.
import * as lib from "../extension/lib.js";
import { cleanup, harness, ORIGIN } from "./helpers";
import { approveInBrowser } from "./oauth";

afterEach(cleanup);
const root = path.resolve(import.meta.dirname, "..");
const extension = path.join(root, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(extension, "manifest.json"), "utf8"));
const REDIRECT = "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/bookmarks";

describe("manifest", () => {
  it("asks for no site access up front and no more than it uses", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
    expect([...manifest.permissions].sort()).toEqual(["activeTab", "alarms", "bookmarks", "identity", "scripting", "storage"]);
    expect(manifest.permissions).not.toContain("tabs");
    expect(manifest.version).toBe(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version);
  });
  it("names only files that exist", () => {
    for (const file of [...Object.values(manifest.icons), manifest.action.default_popup, manifest.background.service_worker, manifest.options_ui.page]) expect(fs.existsSync(path.join(extension, String(file))), String(file)).toBe(true);
  });
  it("uses copy without long dashes or semicolons", () => {
    for (const file of ["popup.html", "options.html"]) {
      const text = fs.readFileSync(path.join(extension, file), "utf8").replace(/<style>[\s\S]*?<\/style>/g, "").replace(/style="[^"]*"/g, "");
      expect(text, file).not.toMatch(/[—–]/);
      expect(text.replace(/<[^>]+>/g, ""), file).not.toContain(";");
    }
  });
});

describe("package", () => {
  /** Every file in a zip with its contents. Compressed bytes differ between zlib builds, so compare what unpacks. */
  const unpack = (zip: Buffer) => {
    const files = new Map<string, Buffer>();
    for (let offset = 0; zip.readUInt32LE(offset) === 0x04034b50; ) {
      const packed = zip.readUInt32LE(offset + 18), nameLength = zip.readUInt16LE(offset + 26);
      files.set(zip.subarray(offset + 30, offset + 30 + nameLength).toString(), inflateRawSync(zip.subarray(offset + 30 + nameLength, offset + 30 + nameLength + packed)));
      offset += 30 + nameLength + packed;
    }
    return files;
  };
  it("embeds exactly what is in the folder", () => {
    const embedded = unpack(Buffer.from(EXTENSION_PACKAGE.base64, "base64"));
    expect([...embedded.keys()], "Run pnpm extension:package").toEqual(listFiles(extension));
    for (const [name, data] of embedded) expect(data.equals(fs.readFileSync(path.join(extension, name))), `${name} changed. Run pnpm extension:package`).toBe(true);
    expect(EXTENSION_PACKAGE.version).toBe(manifest.version);
    expect(generatedSource(manifest.version, Buffer.from("x"))).toContain("export const EXTENSION_PACKAGE");
  });
  it("is a valid zip of every file", () => {
    const zip = buildZip(extension);
    const files = unpack(zip);
    expect([...files.keys()]).toEqual(listFiles(extension));
    for (const [name, data] of files) expect(data.equals(fs.readFileSync(path.join(extension, name))), name).toBe(true);
    expect(zip.length).toBeLessThan(500 * 1024);
  });
});

describe("the app's address", () => {
  it("takes what the app shows, and plain http only on this computer", () => {
    expect(lib.appOrigin(" http://127.0.0.1:4316/ ")).toBe("http://127.0.0.1:4316");
    expect(lib.appOrigin("localhost:4316")).toBe("http://localhost:4316");
    expect(lib.appOrigin("bookmarks.example")).toBe("https://bookmarks.example");
    for (const bad of ["", "http://bookmarks.example", "ftp://127.0.0.1", "https://user:pass@bookmarks.example", "not a url at all"]) expect(lib.appOrigin(bad), bad).toBeNull();
  });
  it("asks only for that one host", () => {
    expect(lib.originPattern("http://127.0.0.1:4316")).toBe("http://127.0.0.1/*");
    expect(lib.originPattern("https://bookmarks.example/some/path")).toBe("https://bookmarks.example/*");
  });
});

describe("bookmarks tree", () => {
  const tree = [{ id: "0", title: "", children: [
    { id: "1", title: "Bookmarks bar", children: [
      { id: "2", title: "Top", url: "https://example.test/top", dateAdded: 1670000000000 },
      { id: "3", title: "Sailing", children: [{ id: "4", title: "Tide", url: "https://harbor.example/tide" }, { id: "5", title: "Tools", children: [{ id: "6", title: "", url: "http://tools.example/" }] }] },
      { id: "7", title: "A script", url: "javascript:alert(1)" },
      { id: "8", title: "Settings", url: "chrome://settings" },
    ] },
    { id: "9", title: "Other bookmarks", children: [{ id: "10", title: "Other", url: "https://example.test/other" }] },
  ] }];
  it("flattens to web links with folders as tags", () => {
    expect(lib.flattenTree(tree)).toEqual([
      { url: "https://example.test/top", title: "Top", savedAt: 1670000000000, tags: [] },
      { url: "https://harbor.example/tide", title: "Tide", savedAt: null, tags: ["Sailing"] },
      { url: "http://tools.example/", title: null, savedAt: null, tags: ["Sailing", "Tools"] },
      { url: "https://example.test/other", title: "Other", savedAt: null, tags: [] },
    ]);
  });
  it("splits a large library into batches the app accepts", () => {
    const parts = lib.batches(Array.from({ length: 250 }, (_, index) => ({ url: `https://example.test/${index}` })));
    expect(parts.map((part: unknown[]) => part.length)).toEqual([100, 100, 50]);
  });
  it("keeps each request under the size limit, in any script", () => {
    const big = (text: string) => ({ url: "https://example.test/", pageText: text.repeat(lib.QUEUED_PAGE_CHARS) });
    for (const character of ["x", "漢"]) {
      const parts = lib.batches(Array.from({ length: 30 }, () => big(character)));
      expect(parts.flat()).toHaveLength(30);
      for (const part of parts) expect(new TextEncoder().encode(JSON.stringify({ via: "extension", items: part })).length).toBeLessThan(1024 * 1024);
    }
    expect(lib.batches([{ url: "https://example.test/", pageText: "漢".repeat(lib.MAX_PAGE_CHARS) }])).toHaveLength(1);
  });
  it("fits an item to what the app accepts, and leaves out a link it can't keep", () => {
    expect(lib.fitItem({ url: `https://example.test/${"a".repeat(5000)}` })).toBeNull();
    expect(lib.fitItem({ url: "javascript:alert(1)" })).toBeNull();
    const fitted = lib.fitItem({ url: "https://example.test/", title: "t".repeat(3000), excerpt: "e".repeat(3000), note: "n".repeat(9000), tags: Array.from({ length: 60 }, () => "f".repeat(300)), pageText: "p".repeat(300_000) });
    expect([fitted.title.length, fitted.excerpt.length, fitted.note.length, fitted.tags.length, fitted.tags[0].length, fitted.pageText.length]).toEqual([2000, 2000, 8000, 50, 200, lib.MAX_PAGE_CHARS]);
    expect(lib.flattenTree([{ url: `https://example.test/${"a".repeat(5000)}`, title: "Too long" }, { url: "https://example.test/ok", title: "Fine" }]).map((link: { title: string }) => link.title)).toEqual(["Fine"]);
  });
  it("keeps queued items small", () => {
    expect(lib.forQueue({ url: "u", pageText: "x".repeat(100_000) }).pageText).toHaveLength(lib.QUEUED_PAGE_CHARS);
    expect(lib.forQueue({ url: "u" })).toEqual({ url: "u" });
    expect(lib.clipText("x".repeat(300_000))).toHaveLength(lib.MAX_PAGE_CHARS);
    expect(lib.clipText("")).toBeNull();
    expect(lib.parseTags(" a, b\nc,,")).toEqual(["a", "b", "c"]);
  });
});

describe("calling the app", () => {
  const connection = { app: "https://bookmarks.example", accessToken: "t", refreshToken: "r", clientId: "c", tokenEndpoint: "https://bookmarks.example/api/auth/mcp/token", resource: "https://bookmarks.example/mcp", expiresAt: Date.now() + 3_600_000 };
  const rpc = (result: unknown, status = 200) => async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status });
  it("sends the token and a tools/call to the app's MCP address", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const result = await lib.callTool(async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [], structuredContent: { result: { saved: 1, invalid: 0 } } } })); }, connection, lib.SAVE_TOOL, { via: "extension", items: [] });
    expect(result).toEqual({ outcome: "ok", body: { saved: 1, invalid: 0 } });
    expect(seen!.url).toBe("https://bookmarks.example/mcp");
    expect(seen!.init.headers).toMatchObject({ authorization: "Bearer t" });
    expect(JSON.parse(String(seen!.init.body))).toMatchObject({ method: "tools/call", params: { name: "save_bookmarks" } });
  });
  it("tells an expired token from a read-only connection from a bad link from an unreachable app", async () => {
    expect((await lib.callTool(async () => new Response("{}", { status: 401 }), connection, "x", {})).outcome).toBe("expired");
    expect((await lib.callTool(async () => new Response('{"error":"Open this request from the app."}', { status: 403 }), connection, "x", {})).outcome).toBe("disconnected");
    expect((await lib.callTool(rpc({ isError: true, content: [{ type: "text", text: "Bookmarks browser extension can read but not make changes. Reconnect it and allow changes to do this." }] }), connection, "x", {})).outcome).toBe("disconnected");
    expect((await lib.callTool(rpc({ isError: true, content: [{ type: "text", text: "Invalid url" }] }), connection, "x", {})).outcome).toBe("rejected");
    expect((await lib.callTool(async () => new Response("{}", { status: 413 }), connection, "x", {})).outcome).toBe("rejected");
    expect((await lib.callTool(async () => new Response("<html>", { status: 502 }), connection, "x", {})).outcome).toBe("retry");
    expect((await lib.callTool(async () => { throw new Error("offline"); }, connection, "x", {})).outcome).toBe("retry");
  });
  it("drops only the item the app refuses, and stops without losing anything when it goes away", async () => {
    const items = ["a", "bad", "c"].map((name) => ({ url: `https://example.test/${name}` }));
    const sent: number[] = [];
    const session = lib.createSession({ load: async () => connection, save: async () => undefined, fetcher: async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      sent.push(body.params.arguments.items.length);
      const bad = body.params.arguments.items.some((item: { url: string }) => item.url.endsWith("bad"));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: bad ? { isError: true, content: [{ type: "text", text: "bad" }] } : { content: [], structuredContent: { result: { saved: 1, invalid: 0 } } } }));
    } });
    expect(await lib.sendItems(session, "bookmark", items)).toEqual({ outcome: "ok", done: 3, dropped: 1, invalid: 0, message: "bad" });
    expect(sent).toEqual([3, 1, 1, 1]);
    let calls = 0;
    const leaving = lib.createSession({ load: async () => connection, save: async () => undefined, fetcher: async () => {
      calls++;
      if (calls === 1) return new Response("{}", { status: 413 });
      if (calls === 2) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [], structuredContent: { result: { saved: 1, invalid: 0 } } } }));
      return new Response("{}", { status: 503 });
    } });
    expect(await lib.sendItems(leaving, "bookmark", items)).toMatchObject({ outcome: "retry", done: 1, dropped: 0 });
  });
  it("refreshes one at a time, because a refresh token works only once", async () => {
    let stored = { ...connection, expiresAt: 0 };
    let refreshes = 0;
    const session = lib.createSession({
      load: async () => stored, save: async (next: typeof stored) => { stored = next; },
      fetcher: async (url: string) => {
        if (url === connection.tokenEndpoint) { refreshes++; await new Promise((resolve) => setTimeout(resolve, 10)); return new Response(JSON.stringify({ access_token: `t${refreshes}`, refresh_token: `r${refreshes}`, expires_in: 3600 })); }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [], structuredContent: { result: { saved: 0, invalid: 0 } } } }));
      },
    });
    await Promise.all(Array.from({ length: 5 }, () => session.call("save_bookmarks", {})));
    expect(refreshes).toBe(1);
    expect(stored).toMatchObject({ accessToken: "t1", refreshToken: "r1" });
  });
  it("asks to connect again when the refresh token is refused", async () => {
    const session = lib.createSession({ load: async () => ({ ...connection, expiresAt: 0 }), save: async () => undefined, fetcher: async () => new Response('{"error":"invalid_grant"}', { status: 400 }) });
    expect((await session.call("save_bookmarks", {})).outcome).toBe("disconnected");
  });
  it("revokes its refresh token on Disconnect, and says when the app couldn't be told", async () => {
    const revocationEndpoint = "https://bookmarks.example/api/auth/mcp/revoke";
    let seen: { url: string; body: string } | null = null;
    const answer = (status: number) => async (url: string, init: RequestInit) => { seen = { url, body: String(init.body) }; return new Response(null, { status }); };
    expect(await lib.revoke(answer(200), { ...connection, revocationEndpoint })).toBe(true);
    expect(seen!.url).toBe(revocationEndpoint);
    expect(Object.fromEntries(new URLSearchParams(seen!.body))).toEqual({ token: "r", token_type_hint: "refresh_token", client_id: "c" });
    expect(await lib.revoke(answer(200), { ...connection, revocationEndpoint, refreshToken: null })).toBe(true);
    expect(Object.fromEntries(new URLSearchParams(seen!.body))).toMatchObject({ token: "t", token_type_hint: "access_token" });
    // Out of reach, refused, or a Bookmarks too old to offer revocation: the extension forgets its tokens anyway.
    expect(await lib.revoke(async () => { throw new TypeError("Failed to fetch"); }, { ...connection, revocationEndpoint })).toBe(false);
    expect(await lib.revoke(answer(400), { ...connection, revocationEndpoint })).toBe(false);
    const older = async (url: string) => new Response(JSON.stringify(url.endsWith("oauth-protected-resource")
      ? { resource: "https://bookmarks.example/mcp", authorization_servers: ["https://bookmarks.example"] }
      : { authorization_endpoint: "a", token_endpoint: "t", registration_endpoint: "r" }));
    expect(await lib.revoke(older, { ...connection, revocationEndpoint: null })).toBe(false);
    expect(await lib.revoke(answer(200), null)).toBe(false);
  });
});

describe("connecting to the real app", () => {
  // As measured in Chromium: the extension's GETs arrive without an Origin, its POSTs with one.
  const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  const fromExtension = (h: Awaited<ReturnType<typeof harness>>) => (url: string, init: RequestInit = {}) =>
    h.request(url, init.method === "POST" ? { ...init, headers: { ...(init.headers as Record<string, string>), origin: EXTENSION_ORIGIN } } : init);

  it("signs in from inside the browser as a public client with PKCE, allowed only to add, and saves", async () => {
    const h = await harness();
    const browser = fromExtension(h);
    const meta = await lib.discover(browser, ORIGIN);
    const clientId = await lib.register(browser, meta, REDIRECT, "Bookmarks browser extension on macOS");
    const { verifier, challenge } = await lib.pkcePair();
    const authorize = lib.authorizeUrl(meta, clientId, REDIRECT, challenge, "s");
    expect(new URL(authorize).searchParams.get("scope")!.split(" ")).toContain("add_only");
    const approved = await approveInBrowser(authorize, (request) => h.app.request(request), { write: false, addOnly: true });
    // It asked only to add, so the consent screen starts on "Only add", with the app's one add action.
    expect(approved.offered.requested).toEqual({ addOnly: true });
    expect(approved.offered.adds).toEqual([{ name: "save_bookmarks", title: "Save links from a browser" }]);
    const code = lib.codeFrom(approved.redirectURI, "s");
    // The token endpoint answers the extension's origin, with CORS and no credentials, and insists on the verifier.
    const wrong = await browser(meta.tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, redirect_uri: REDIRECT, code, code_verifier: "not-the-verifier", resource: meta.resource }).toString() });
    expect(wrong.ok).toBe(false);
    expect(wrong.headers.get("access-control-allow-origin")).toBe("*");
    expect(wrong.headers.get("access-control-allow-credentials")).toBeNull();
    const second = await approveInBrowser(lib.authorizeUrl(meta, clientId, REDIRECT, challenge, "t"), (request) => h.app.request(request), { write: false, addOnly: true });
    const tokens = await lib.exchangeCode(browser, meta, clientId, REDIRECT, lib.codeFrom(second.redirectURI, "t"), verifier);
    expect(tokens.refreshToken).toBeTruthy();
    let stored = lib.connectionFor(ORIGIN, meta, clientId, tokens);
    const session = lib.createSession({ fetcher: browser, load: async () => stored, save: async (next: typeof stored) => { stored = next; } });
    // Connect's check passes, and links save.
    expect(await session.call(lib.SAVE_TOOL, { via: "extension", items: [{ url: "about:blank" }] })).toEqual({ outcome: "ok", body: { saved: 0, invalid: 1 } });
    expect(await lib.sendItems(session, "extension", [{ url: "https://example.test/from-the-browser", title: "From the browser" }])).toMatchObject({ outcome: "ok", done: 1, dropped: 0 });
    // It refreshes from inside the browser too, and carries on.
    stored = { ...stored, expiresAt: 0 };
    expect((await lib.sendItems(session, "bookmark", [{ url: "https://example.test/after-refresh" }])).outcome).toBe("ok");
    expect(stored.accessToken).not.toBe(tokens.accessToken);
    // It is offered only the add action, and can't read what was saved.
    const listed = await browser(`${ORIGIN}/mcp`, { method: "POST", headers: { authorization: `Bearer ${stored.accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    expect(((await listed.json()) as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name)).toEqual(["save_bookmarks"]);
    expect(await session.call("list_bookmarks", {})).toMatchObject({ outcome: "rejected", message: expect.stringContaining("can only add, not read or change") });
    expect((await h.call("list_bookmarks", {})).items.map((item: { url: string }) => item.url).sort()).toEqual(["https://example.test/after-refresh", "https://example.test/from-the-browser"]);
    // Settings lists it as able only to add.
    const settings = await (await h.request("/api/connections", { headers: { origin: ORIGIN } })).json() as { name: string; write: boolean; addOnly: boolean }[];
    expect(settings).toEqual([expect.objectContaining({ name: "Bookmarks browser extension on macOS", write: false, addOnly: true })]);
  });
  it("registers only as a public client from inside the browser", async () => {
    const h = await harness();
    const meta = await lib.discover(fromExtension(h), ORIGIN);
    const withSecret = await fromExtension(h)(meta.registrationEndpoint, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Bookmarks browser extension", redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_post", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
    });
    expect(withSecret.ok).toBe(false);
  });

  // The rest of the flow, with the sign-in requests sent the way a server-side client sends them (no Origin),
  // and the person allowing more than the extension asked for: it works the same.
  it("registers, asks on the consent screen, saves, refreshes, and is listed in Settings", async () => {
    const h = await harness();
    const fetcher = (url: string, init?: RequestInit) => h.request(url, init);
    const meta = await lib.discover(fetcher, ORIGIN);
    // The app names itself as the protected resource, and where a client disconnects itself (RFC 7009).
    expect(meta).toMatchObject({ resource: ORIGIN, revocationEndpoint: `${ORIGIN}/api/auth/mcp/revoke`, authorizationEndpoint: expect.stringContaining("/api/auth/"), tokenEndpoint: expect.stringContaining("/api/auth/") });
    const clientId = await lib.register(fetcher, meta, REDIRECT, "Bookmarks browser extension on macOS");
    const { verifier, challenge } = await lib.pkcePair();
    const state = "state-1";
    const approved = await approveInBrowser(lib.authorizeUrl(meta, clientId, REDIRECT, challenge, state), (request) => h.app.request(request));
    expect(approved.offered.client.name).toBe("Bookmarks browser extension on macOS");
    expect(approved.redirectURI.startsWith(REDIRECT)).toBe(true);
    expect(() => lib.codeFrom(approved.redirectURI, "another-state")).toThrow(/different request/);
    const tokens = await lib.exchangeCode(fetcher, meta, clientId, REDIRECT, lib.codeFrom(approved.redirectURI, state), verifier);
    expect(tokens.refreshToken).toBeTruthy();
    let stored = lib.connectionFor(ORIGIN, meta, clientId, tokens);
    const session = lib.createSession({ fetcher, load: async () => stored, save: async (next: typeof stored) => { stored = next; } });
    expect(await lib.sendItems(session, "extension", [{ url: "https://harborlog.example/tide-tables", title: "Tide tables", pageText: "Tide tables list the height of the water at each hour." }])).toMatchObject({ outcome: "ok", done: 1 });
    // The extension's check that it may add links saves nothing: a page that isn't on the web only counts as invalid.
    expect(await session.call(lib.SAVE_TOOL, { via: "extension", items: [{ url: "about:blank" }] })).toEqual({ outcome: "ok", body: { saved: 0, invalid: 1 } });
    // The token runs out: the session refreshes it and carries on.
    stored = { ...stored, expiresAt: 0 };
    const before = stored.refreshToken;
    expect((await lib.sendItems(session, "bookmark", [{ url: "https://example.test/after-refresh" }])).outcome).toBe("ok");
    expect(stored.accessToken).not.toBe(tokens.accessToken);
    expect(stored.refreshToken).toBeTruthy();
    expect(before).toBeTruthy();
    const list = await h.call("list_bookmarks", {});
    expect(list.items.map((item: { via: string; page: { source: string | null } }) => [item.via, item.page.source]).sort()).toEqual([["bookmark", null], ["extension", "browser"]]);
    const settings = await (await h.request("/api/connections", { headers: { origin: ORIGIN } })).json() as { name: string; write: boolean }[];
    expect(settings).toEqual([expect.objectContaining({ name: "Bookmarks browser extension on macOS", write: true })]);
  });
  it("tells the person when they allowed reading only", async () => {
    const h = await harness();
    const fetcher = (url: string, init?: RequestInit) => h.request(url, init);
    const meta = await lib.discover(fetcher, ORIGIN);
    const clientId = await lib.register(fetcher, meta, REDIRECT);
    const { verifier, challenge } = await lib.pkcePair();
    const approved = await approveInBrowser(lib.authorizeUrl(meta, clientId, REDIRECT, challenge, "s"), (request) => h.app.request(request), { write: false });
    const tokens = await lib.exchangeCode(fetcher, meta, clientId, REDIRECT, lib.codeFrom(approved.redirectURI, "s"), verifier);
    const session = lib.createSession({ fetcher, load: async () => lib.connectionFor(ORIGIN, meta, clientId, tokens), save: async () => undefined });
    expect(await session.call(lib.SAVE_TOOL, { via: "extension", items: [{ url: "about:blank" }] })).toMatchObject({ outcome: "disconnected", message: expect.stringContaining("can read but not make changes") });
    // The extension's own words for it (background.js) point to the choice it needs.
    expect(fs.readFileSync(path.join(extension, "background.js"), "utf8")).toContain("Connect again and choose Only add.");
  });
  it("stops working once the person disconnects it in Settings", async () => {
    const h = await harness();
    const fetcher = (url: string, init?: RequestInit) => h.request(url, init);
    const meta = await lib.discover(fetcher, ORIGIN);
    const clientId = await lib.register(fetcher, meta, REDIRECT);
    const { verifier, challenge } = await lib.pkcePair();
    const approved = await approveInBrowser(lib.authorizeUrl(meta, clientId, REDIRECT, challenge, "s"), (request) => h.app.request(request));
    const tokens = await lib.exchangeCode(fetcher, meta, clientId, REDIRECT, lib.codeFrom(approved.redirectURI, "s"), verifier);
    let stored = lib.connectionFor(ORIGIN, meta, clientId, tokens);
    const session = lib.createSession({ fetcher, load: async () => stored, save: async (next: typeof stored) => { stored = next; } });
    expect((await lib.sendItems(session, "extension", [{ url: "https://example.test/a" }])).outcome).toBe("ok");
    expect((await h.request(`/api/connections/${clientId}`, { method: "DELETE", headers: { origin: ORIGIN } })).status).toBe(200);
    expect((await lib.sendItems(session, "extension", [{ url: "https://example.test/b" }])).outcome).toBe("disconnected");
  });

  /** Sign in as the extension does, from its origin, allowed only to add. */
  async function signIn(h: Awaited<ReturnType<typeof harness>>) {
    const browser = fromExtension(h);
    const meta = await lib.discover(browser, ORIGIN);
    const clientId = await lib.register(browser, meta, REDIRECT, "Bookmarks browser extension on macOS");
    const { verifier, challenge } = await lib.pkcePair();
    const approved = await approveInBrowser(lib.authorizeUrl(meta, clientId, REDIRECT, challenge, "s"), (request) => h.app.request(request), { write: false, addOnly: true });
    return lib.connectionFor(ORIGIN, meta, clientId, await lib.exchangeCode(browser, meta, clientId, REDIRECT, lib.codeFrom(approved.redirectURI, "s"), verifier));
  }
  const listed = async (h: Awaited<ReturnType<typeof harness>>) => (await (await h.request("/api/connections", { headers: { origin: ORIGIN } })).json() as { name: string }[]).map((item) => item.name);

  it("disconnects itself: once it revokes its refresh token, neither token works and Settings no longer lists it", async () => {
    const h = await harness();
    const browser = fromExtension(h);
    let stored = await signIn(h);
    const session = lib.createSession({ fetcher: browser, load: async () => stored, save: async (next: typeof stored) => { stored = next; } });
    expect((await lib.sendItems(session, "extension", [{ url: "https://example.test/before" }])).outcome).toBe("ok");
    expect(await listed(h)).toEqual(["Bookmarks browser extension on macOS"]);
    const held = { ...stored };
    expect(await lib.revoke(browser, held)).toBe(true);
    // The access token stops at once, though it had most of an hour left.
    expect(held.expiresAt).toBeGreaterThan(Date.now() + 60_000);
    const mcp = await browser(`${ORIGIN}/mcp`, { method: "POST", headers: { authorization: `Bearer ${held.accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    expect(mcp.status).toBe(401);
    // The refresh token is refused too, so the extension can't save even if it tried.
    const refreshed = await browser(held.tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: held.clientId, refresh_token: held.refreshToken, resource: held.resource }).toString() });
    expect(refreshed.ok).toBe(false);
    expect(await session.call(lib.SAVE_TOOL, { via: "extension", items: [{ url: "https://example.test/after" }] })).toMatchObject({ outcome: "disconnected" });
    expect((await h.call("list_bookmarks", {})).items.map((item: { url: string }) => item.url)).toEqual(["https://example.test/before"]);
    expect(await listed(h)).toEqual([]);
    // The endpoint answers the extension's origin like the token endpoint, and a second Disconnect is harmless.
    const again = await browser(held.revocationEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: held.refreshToken, token_type_hint: "refresh_token", client_id: held.clientId }).toString() });
    expect(again.status).toBe(200);
    expect(again.headers.get("access-control-allow-origin")).toBe("*");
    expect(again.headers.get("access-control-allow-credentials")).toBeNull();
  });
  it("revokes a connection kept by an earlier version, which doesn't know where to", async () => {
    const h = await harness();
    // Version 0.2.2 and earlier kept revocationEndpoint: null, from a Bookmarks that offered none.
    const kept = { ...(await signIn(h)), revocationEndpoint: null };
    expect(await lib.revoke(fromExtension(h), kept)).toBe(true);
    expect(await listed(h)).toEqual([]);
    expect((await h.request(`${ORIGIN}/mcp`, { method: "POST", headers: { authorization: `Bearer ${kept.accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) })).status).toBe(401);
  });
});
