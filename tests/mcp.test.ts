/** A standard MCP client (the official SDK) using the app the way an assistant does. The SDK checks every result against the tool's advertised output schema. */
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { cleanup, harness, ORIGIN } from "./helpers";

afterEach(cleanup);

async function client(h: Awaited<ReturnType<typeof harness>>, token: string) {
  const mcp = new Client({ name: "test-host", version: "1.0.0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(ORIGIN + "/mcp"), {
    requestInit: { headers: { authorization: "Bearer " + token } },
    fetch: (url, init) => h.request(String(url), init as RequestInit),
  }));
  return mcp;
}

describe("over MCP", () => {
  it("lists, saves, finds and shows links, with results matching their schemas", async () => {
    const h = await harness();
    const mcp = await client(h, (await h.connect()).token);
    const { tools } = await mcp.listTools();
    expect(tools.map((tool) => tool.name)).toContain("show_bookmarks");
    const saved = await mcp.callTool({ name: "save_bookmark", arguments: { url: "https://harborlog.example/tide-tables", tags: ["sailing"], pageText: "Tide tables list the height of the water at each hour." } });
    const record = (saved.structuredContent as { result: { record: { id: string; via: string } } }).result.record;
    expect(record.via).toBe("chat");
    const found = await mcp.callTool({ name: "list_bookmarks", arguments: { query: "height of the water" } });
    expect((found.structuredContent as { result: { items: { id: string }[] } }).result.items.map((item) => item.id)).toEqual([record.id]);
    const card = await mcp.callTool({ name: "show_bookmarks", arguments: { query: "tide" } });
    expect(card.structuredContent).toMatchObject({ view: "show_bookmarks", data: { items: [{ id: record.id }], query: "tide" } });
    expect(card.content).toEqual([{ type: "text", text: "Showed 1 bookmark: harborlog.example." }]);
    expect((await mcp.callTool({ name: "open_bookmarks", arguments: {} })).structuredContent).toEqual({ view: "open_bookmarks" });
    const view = await mcp.readResource({ uri: "ui://bookmarks/main" });
    expect(view.contents[0]).toMatchObject({ mimeType: "text/html;profile=mcp-app" });
    await mcp.close();
  });
  it("refuses a read-only connection's save with a reason it can show", async () => {
    const h = await harness();
    const mcp = await client(h, (await h.connect({ write: false, name: "Ri · Family" })).token);
    const result = await mcp.callTool({ name: "save_bookmark", arguments: { url: "https://example.test/a" } });
    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "Ri · Family can read but not make changes. Reconnect it and allow changes to do this." }] });
    await mcp.close();
  });
});
