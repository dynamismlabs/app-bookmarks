/**
 * Bookmarks as `build`, `change` and the service load it: src/app.ts through tsx's tsImport, which
 * gives the app its own copy of zod. The other tests import the app directly and share the core's
 * zod, so they can't see this. Before core e44b499 a bad input refused by the app's own zod came
 * back to the person's browser as a 500, not a 400 that says the first issue (checked: this file
 * fails that way on the core from v0.1.4).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod/v3";
import { tsImport } from "tsx/esm/api";
import { createApp, type Application } from "@app-builder/core";
import { createTestConnection, openNodePlatform } from "@app-builder/core/node";

const ORIGIN = "http://127.0.0.1:4316";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bookmarks-cli-load-"));
let application: Application;
let opened: Awaited<ReturnType<typeof openNodePlatform>>;
let web: ReturnType<typeof createApp>;

describe("loaded the way the CLI loads it", () => {
  beforeAll(async () => {
    application = ((await tsImport(pathToFileURL(path.resolve(import.meta.dirname, "../src/app.ts")).href, import.meta.url)) as { application: Application }).application;
    opened = await openNodePlatform(application, { dataDir, localOwner: true, baseURL: ORIGIN });
    web = createApp({ ...application, viewHTML: '<!doctype html><html data-mode="mcp"></html>' }, () => opened.platform);
  });
  afterAll(() => {
    opened?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("has its own zod, as the service does", () => {
    // Without this, the test below would pass on any core.
    const input = application.actions.find((action) => action.name === "list_bookmarks")!.input;
    expect(input instanceof z.ZodType).toBe(false);
  });
  it("refuses a bad input with a 400 that says what is wrong", async () => {
    const response = await web.request(ORIGIN + "/api/trpc/run", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ name: "list_bookmarks", input: { limit: 0 } }) });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe("Number must be greater than or equal to 1");
  });
  // Over MCP this was already right on the older core. It stays here so both paths are checked the service's way.
  it("tells an assistant the same, not the issues as JSON", async () => {
    const { accessToken } = await createTestConnection(opened.platform);
    const response = await web.request(ORIGIN + "/mcp", {
      method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_bookmarks", arguments: { limit: 0 } } }),
      headers: { authorization: "Bearer " + accessToken, "content-type": "application/json", accept: "application/json, text/event-stream" },
    });
    const body = (await response.json()) as { result?: { isError?: boolean; content?: { text: string }[] }; error?: { message: string } };
    const said = body.result?.content?.[0]?.text ?? body.error?.message ?? "";
    expect(said).toContain("greater than or equal to 1");
    expect(said).not.toContain('"code"');
  });
});
