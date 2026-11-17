/**
 * Test harness: the real app over a disposable data directory. The person
 * calls actions the way their browser does (the app's own /api/trpc), an
 * assistant calls them over /mcp with a connection's token, and the reading
 * job runs against the kit's fixture source or a stand-in hub. All data is
 * fictional.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp, type ConnectorSource, type Platform } from "@app-builder/core";
import { createTestConnection, openNodePlatform } from "@app-builder/core/node";
import { users } from "@app-builder/core/schema";
import { application } from "../src/app";
import { readingStep, READ_WEB_PAGE, type WebPage } from "../src/services/reading";
import { bookmarksFor, clock } from "../src/services/store";

export const ORIGIN = "http://127.0.0.1:4316";
const opened: { close(): void; dir: string }[] = [];

export class CallError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Who is calling: the person in their own browser, or an assistant connection's token. */
export type Caller = "person" | { token: string };

export async function harness(options: { now?: string; dataDir?: string } = {}) {
  const dataDir = options.dataDir ?? await fs.mkdtemp(path.join(os.tmpdir(), "bookmarks-test-"));
  let now = new Date(options.now ?? "2026-10-15T12:00:00.000Z");
  clock.now = () => now;
  let current = await openNodePlatform(application, { dataDir, localOwner: true, baseURL: ORIGIN });
  const entry = { close: () => current.close(), dir: dataDir };
  opened.push(entry);
  // The built view (dist/mcp.html) turns on show_bookmarks and open_bookmarks. Tests stand in a page for it.
  const withView = { ...application, viewHTML: '<!doctype html><html data-mode="mcp"><body><div id="root"></div></body></html>' };
  let app = createApp(withView, () => current.platform);
  let rpc = 0;
  const h = {
    dataDir,
    get platform(): Platform { return current.platform; },
    get app() { return app; },
    /** The owner's store, for looking underneath. */
    get t() { return bookmarksFor(current.platform, "local-owner"); },
    setNow(iso: string) { now = new Date(iso); },
    request: (url: string, init?: RequestInit) => app.request(url.startsWith("http") ? url : ORIGIN + url, init),
    async call<T = any>(name: string, input: unknown = {}, caller: Caller = "person"): Promise<T> {
      if (caller === "person") {
        const response = await app.request(ORIGIN + "/api/trpc/run", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ name, input }) });
        const body = await response.json() as { result?: { data: T }; error?: { message?: string; json?: { message?: string } } };
        if (!response.ok || body.error) throw new CallError(body.error?.json?.message ?? body.error?.message ?? `Failed with ${response.status}`, response.status);
        return body.result!.data;
      }
      const response = await app.request(ORIGIN + "/mcp", {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + caller.token },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: input } }),
      });
      if (!response.ok) throw new CallError(`MCP answered ${response.status}`, response.status);
      const body = await response.json() as { result?: { isError?: boolean; content: { type: string; text?: string }[]; structuredContent?: { result?: T } }; error?: { message: string } };
      if (body.error) throw new CallError(body.error.message, 400);
      if (body.result?.isError) throw new CallError(body.result.content.find((part) => part.type === "text")?.text ?? "Tool failed", 400);
      return (body.result?.structuredContent?.result ?? body.result?.structuredContent) as T;
    },
    async tools(token: string) {
      const response = await app.request(ORIGIN + "/mcp", {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + token },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/list", params: {} }),
      });
      return ((await response.json()) as { result: { tools: { name: string; description: string; annotations: Record<string, boolean>; outputSchema?: unknown; _meta?: Record<string, unknown> }[] } }).result.tools;
    },
    /** An assistant connection, as if the person had allowed it on the consent screen. */
    connect: (access: { write?: boolean; addOnly?: boolean; name?: string; userId?: string } = {}) =>
      createTestConnection(current.platform, { name: access.name ?? "Test assistant", write: access.write ?? true, addOnly: access.addOnly, userId: access.userId }).then(({ accessToken, clientId }) => ({ token: accessToken, clientId })),
    /** Another person with an account on this installation. */
    async addPerson(id: string) {
      const time = new Date();
      await current.platform.db.insert(users).values({ id, name: id, email: `${id}@people.example`, emailVerified: false, createdAt: time, updatedAt: time } as never);
      return id;
    },
    /** One reading step, as the job runs it, against a given hub. */
    step(source: ConnectorSource) {
      current.platform.connectors = source;
      return readingStep({ platform: current.platform, viewer: { id: "local-owner", name: "You", email: "" }, request: new Request(ORIGIN + "/jobs/read_pages") });
    },
    /** Stop and start again on the same data. */
    async restart() {
      current.close();
      current = await openNodePlatform(application, { dataDir, localOwner: true, baseURL: ORIGIN });
      app = createApp(withView, () => current.platform);
    },
  };
  return h;
}
export type Harness = Awaited<ReturnType<typeof harness>>;

export async function cleanup() {
  clock.now = () => new Date();
  for (const entry of opened.splice(0)) {
    try { entry.close(); } catch { /* Already closed. */ }
    await fs.rm(entry.dir, { recursive: true, force: true });
  }
}

/** A stand-in for Ri's hub that answers read_web_page per address, and remembers what it was asked. */
export function webReader(handle: (url: string) => unknown): ConnectorSource & { urls: string[] } {
  const urls: string[] = [];
  return {
    kind: "fixtures", urls,
    async listTools() { return [READ_WEB_PAGE]; },
    async callTool(name, args) {
      if (name !== READ_WEB_PAGE) throw new Error(`No tool ${name}`);
      urls.push(String(args.url));
      const reply = await handle(String(args.url));
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}

/** What Ri's read_web_page returns for an HTML page. */
export const page = (url: string, text: string, title = "A page"): WebPage & { finalUrl: string; truncated: boolean } =>
  ({ outcome: "read", status: 200, finalUrl: url, contentType: "text/html", text: `<html><head><title>${title}</title></head><body><p>${text}</p></body></html>`, truncated: false });
