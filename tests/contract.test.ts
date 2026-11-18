import { describe, expect, it } from "vitest";
import { actionContract } from "@app-builder/core";
import { application } from "../src/app";

const withView = { ...application, viewHTML: "<!doctype html><html></html>" };
const contract = actionContract(withView);
const tool = (name: string) => contract.mcp.tools.find((item: { name: string }) => item.name === name);
const action = (name: string) => contract.actions.find((item) => item.name === name)!;

describe("contract", () => {
  it("offers the model the data tools, one card and the whole app, and the view the person's own actions", () => {
    const shown = (item: { _meta?: { ui?: { visibility?: string[] } } }) => (item._meta?.ui?.visibility ?? ["model", "app"]).includes("model");
    expect(contract.mcp.tools.filter(shown).map((item: { name: string }) => item.name).sort()).toEqual(["get_bookmark", "list_bookmarks", "list_tags", "open_bookmarks", "save_bookmark", "save_bookmarks", "show_bookmarks", "update_bookmark"]);
    const viewOnly = contract.mcp.tools.filter((item: { _meta?: unknown }) => !shown(item as never));
    // The core adds search_mentions (the @ menu) and read_settings and change_settings (Settings inside the view).
    expect(viewOnly.map((item: { name: string }) => item.name).sort()).toEqual(["apply_import", "change_settings", "delete_bookmark", "export_bookmarks", "get_extension_package", "preview_import", "read_settings", "search_mentions", "upload_import_part"]);
    for (const item of viewOnly) expect(item._meta, item.name).toMatchObject({ ui: { visibility: ["app"] }, "openai/visibility": "private" });
    expect(tool("show_bookmarks")._meta.ui.resourceUri).toBe("ui://bookmarks/main");
    expect(tool("open_bookmarks")._meta["openai/ui"].entrypoints).toEqual([{ type: "global" }]);
    expect(tool("open_bookmarks").inputSchema.properties.path.description).toContain("/bookmarks/<id> opens a saved link");
    expect(contract.mcp.resources).toEqual([expect.objectContaining({ uri: "ui://bookmarks/main", mimeType: "text/html;profile=mcp-app" })]);
  });
  it("advertises an output schema on every tool", () => {
    for (const item of contract.mcp.tools) expect(item.outputSchema, item.name).toMatchObject({ type: "object" });
  });
  it("keeps management and destructive actions with the person and background work with the job", () => {
    for (const name of ["delete_bookmark", "upload_import_part", "preview_import", "apply_import", "export_bookmarks", "get_extension_package"])
      expect(action(name), name).toMatchObject({ audience: ["user", "agent"], visibility: ["app"] });
    for (const name of ["list_bookmarks", "save_bookmark", "update_bookmark", "save_bookmarks"]) expect(action(name).visibility ?? ["model", "app"], name).toContain("model");
    expect(action("delete_bookmark").effect).toBe("delete");
    expect(action("read_saved_pages").audience).toEqual([]);
    expect(contract.jobs).toEqual([{ name: "read_pages", title: "Read saved pages", schedule: "every 5 minutes", action: "read_saved_pages" }]);
  });
  it("asks the hub only to read public web pages, and says why", () => {
    expect(contract.connectors).toEqual({ purpose: "to read the pages you save, so you can search what they said", capabilities: [], tools: ["ri__read_web_page"] });
  });
  it("tells the extension's save nothing about what is already saved", () => {
    const output = JSON.stringify(action("save_bookmarks").outputSchema);
    for (const field of ["title", "url", "note", "tags", "items", "record"]) expect(output, field).not.toContain(`"${field}"`);
  });
  it("offers only the extension's save to a connection that may only add", () => {
    // save_bookmark answers with the merged record, so marking it would let an add-only connection read any saved link by saving it again.
    expect(contract.actions.filter((item) => item.adds).map((item) => item.name)).toEqual(["save_bookmarks"]);
  });
  it("follows the hosts' naming rules", () => {
    for (const item of contract.mcp.tools) {
      expect(item.name, item.name).not.toMatch(/__|\.\.|\._|_\./);
      expect((item.title ?? "").length, item.name).toBeLessThanOrEqual(60);
    }
  });
  it("uses copy without long dashes or semicolons in descriptions", () => {
    for (const item of [...contract.actions, ...contract.mcp.tools, { name: "instructions", description: application.config.instructions! }]) {
      expect(item.description, item.name).not.toMatch(/[—–]/);
      expect(item.description, item.name).not.toContain(";");
    }
  });
  it("tells assistants only what the tool descriptions don't", () => {
    const instructions = application.config.instructions!;
    expect(instructions.length).toBeLessThanOrEqual(600);
    // Each tool it names exists, and it repeats none of the search advice list_bookmarks and get_bookmark already give.
    for (const name of instructions.match(/\b[a-z]+_[a-z_]+\b/g) ?? []) expect(tool(name), name).toBeTruthy();
    for (const repeated of ["coverage", "the words the page itself would use", "before you quote"]) expect(instructions).not.toContain(repeated);
  });
});
