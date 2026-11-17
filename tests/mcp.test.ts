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
  it("lets an add-only connection save links and nothing else, and tells it nothing about what is saved", async () => {
    const h = await harness();
    const kept = await h.call("save_bookmark", { url: "https://harborlog.example/tide-tables", title: "My tide notes", note: "Check before sailing", tags: ["sailing"] });
    const mcp = await client(h, (await h.connect({ addOnly: true, name: "Bookmarks browser extension" })).token);
    // It is offered only the add action, described as everyone else sees it.
    const { tools } = await mcp.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["save_bookmarks"]);
    const writer = await client(h, (await h.connect()).token);
    expect(tools[0]).toEqual((await writer.listTools()).tools.find((tool) => tool.name === "save_bookmarks"));
    await writer.close();
    // Adding works, and a link already saved answers exactly like a new one.
    const add = (items: unknown[]) => mcp.callTool({ name: "save_bookmarks", arguments: { via: "extension", items } });
    expect((await add([{ url: "https://harborlog.example/tide-tables", title: "Tide tables", tags: ["tides"] }])).structuredContent).toEqual({ result: { saved: 1, invalid: 0 } });
    expect((await add([{ url: "https://breadnotes.example/sourdough", title: "Sourdough timing" }])).structuredContent).toEqual({ result: { saved: 1, invalid: 0 } });
    expect((await add([{ url: "about:blank" }])).structuredContent).toEqual({ result: { saved: 0, invalid: 1 } });
    // The merge keeps what the person wrote and adds the new tag.
    const merged = await h.t.bookmark(kept.record.id);
    expect(merged).toMatchObject({ title: "My tide notes", note: "Check before sailing", tags: ["sailing", "tides"] });
    // Every read and every other write is refused with the same reason.
    const refusal = "Bookmarks browser extension can only add, not read or change. Reconnect it and choose more access to do this.";
    const calls: [string, Record<string, unknown>][] = [
      ["list_bookmarks", {}], ["list_bookmarks", { query: "tide" }], ["get_bookmark", { id: kept.record.id }], ["list_tags", {}],
      ["save_bookmark", { url: "https://harborlog.example/tide-tables" }], ["update_bookmark", { id: kept.record.id, expectedRevision: kept.record.revision, note: "x" }],
      ["delete_bookmark", { id: kept.record.id, expectedRevision: kept.record.revision }], ["export_bookmarks", {}], ["get_extension_package", {}],
      ["show_bookmarks", { query: "tide" }], ["open_bookmarks", {}], ["search_mentions", { query: "tide" }],
    ];
    for (const [name, args] of calls) expect(await mcp.callTool({ name, arguments: args }), name).toMatchObject({ isError: true, content: [{ type: "text", text: refusal }] });
    await expect(mcp.readResource({ uri: `app://bookmarks/bookmarks/${kept.record.id}` })).rejects.toThrow(refusal);
    // Nothing it was refused changed anything.
    expect((await h.call("list_bookmarks", {})).items.map((item: { title: string }) => item.title).sort()).toEqual(["My tide notes", "Sourdough timing"]);
    await mcp.close();
  });
});
