/**
 * The host grant (core 0.2.3): the host that installed Bookmarks on this computer (Ri) asks the
 * access question in its own UI and allows itself with the data directory's host key, so "Allow Ri
 * in Bookmarks" works from any device. The kit tests the grant itself. This checks what is
 * Bookmarks' own: its choices include only adding, and each choice gives the connection the
 * consent screen would.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
// @ts-expect-error plain JavaScript, on purpose: the folder loads into a browser as it is.
import * as lib from "../extension/lib.js";
import { application } from "../src/app";
import { cleanup, harness, ORIGIN } from "./helpers";

afterEach(cleanup);
// Ri's web callback, the address Ri registers for an app it installed.
const REDIRECT = "https://ri.example/api/integrations/mcp-oauth/bookmarks";
const saveTitle = application.actions.find((action) => action.name === "save_bookmarks")!.title;

type Harness = Awaited<ReturnType<typeof harness>>;
/** A request from the host, as Ri sends it: the key as a bearer token, no Origin. */
const fromHost = (h: Harness, route: string, init: { method?: string; body?: unknown } = {}) => h.app.request(new Request(ORIGIN + route, {
  method: init.method ?? "GET",
  headers: { authorization: `Bearer ${fs.readFileSync(path.join(h.dataDir, "host-key"), "utf8").trim()}`, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
  body: init.body ? JSON.stringify(init.body) : undefined,
}));

describe("the host grant", () => {
  it("offers the host the consent screen's choices, including only adding links", async () => {
    const h = await harness();
    const response = await fromHost(h, "/api/host/access-choices");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      choices: [
        { access: "write", label: "Read and make changes", description: "It can read and change what it can see." },
        { access: "read", label: "Read only", description: "It can only read what it can see." },
        { access: "add", label: `Only add: ${saveTitle}`, description: "It can only add, and can't read or change anything." },
      ],
      recommended: "write",
    });
  });
  for (const [access, tools] of [["write", ["list_bookmarks", "save_bookmark", "save_bookmarks"]], ["add", ["save_bookmarks"]]] as const) {
    it(`approves a connection to ${access === "add" ? "only add" : "read and make changes"} without a browser`, async () => {
      const h = await harness();
      const fetcher = (url: string, init?: RequestInit) => h.request(url, init);
      const meta = await lib.discover(fetcher, ORIGIN);
      const clientId = await lib.register(fetcher, meta, REDIRECT, "Ri");
      const { verifier, challenge } = await lib.pkcePair();
      const approved = await fromHost(h, "/api/host/approve", { method: "POST", body: { authorizationUrl: lib.authorizeUrl(meta, clientId, REDIRECT, challenge, "s"), access } });
      expect(approved.status).toBe(200);
      const { redirectTo } = await approved.json() as { redirectTo: string };
      expect(redirectTo.startsWith(REDIRECT + "?")).toBe(true);
      const tokens = await lib.exchangeCode(fetcher, meta, clientId, REDIRECT, lib.codeFrom(redirectTo, "s"), verifier);
      const listed = await h.request("/mcp", {
        method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        headers: { authorization: `Bearer ${tokens.accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      });
      const names = ((await listed.json()) as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
      for (const name of tools) expect(names, name).toContain(name);
      if (access === "add") expect(names).toEqual(["save_bookmarks"]);
      const settings = await (await h.request("/api/connections", { headers: { origin: ORIGIN } })).json() as { name: string; write: boolean }[];
      expect(settings).toEqual([expect.objectContaining({ name: "Ri", write: access === "write" })]);
    });
  }
});
