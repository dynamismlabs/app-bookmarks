import { describe, expect, it } from "vitest";
import { actionContract } from "@app-builder/core";
import { application } from "../src/app";

const withView = { ...application, viewHTML: "<!doctype html><html></html>" };
const contract = actionContract(withView);
const tool = (name: string) => contract.mcp.tools.find((item: { name: string }) => item.name === name);
const action = (name: string) => contract.actions.find((item) => item.name === name)!;

describe("contract", () => {
  it("offers assistants the data tools, one card and the whole app", () => {
    expect(contract.mcp.tools.map((item: { name: string }) => item.name).sort()).toEqual(["get_bookmark", "list_bookmarks", "list_tags", "open_bookmarks", "save_bookmark", "save_bookmarks", "show_bookmarks", "update_bookmark"]);
    expect(tool("show_bookmarks")._meta.ui.resourceUri).toBe("ui://bookmarks/main");
    expect(tool("open_bookmarks")._meta["openai/ui"].entrypoints).toEqual([{ type: "global" }]);
    expect(contract.mcp.resources).toEqual([expect.objectContaining({ uri: "ui://bookmarks/main", mimeType: "text/html;profile=mcp-app" })]);
  });
  it("advertises an output schema on every tool", () => {
    for (const item of contract.mcp.tools) expect(item.outputSchema, item.name).toMatchObject({ type: "object" });
  });
  it("keeps management and destructive actions with the person and background work with the job", () => {
    for (const name of ["delete_bookmark", "upload_import_part", "preview_import", "apply_import", "export_bookmarks", "get_extension_package"]) expect(action(name).audience, name).toEqual(["user"]);
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
  it("follows the hosts' naming rules", () => {
    for (const item of contract.mcp.tools) {
      expect(item.name, item.name).not.toMatch(/__|\.\.|\._|_\./);
      expect((item.title ?? "").length, item.name).toBeLessThanOrEqual(60);
    }
  });
  it("uses copy without long dashes or semicolons in descriptions", () => {
    for (const item of [...contract.actions, ...contract.mcp.tools]) {
      expect(item.description, item.name).not.toMatch(/[—–]/);
      expect(item.description, item.name).not.toContain(";");
    }
  });
});
