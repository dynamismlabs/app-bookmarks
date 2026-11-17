/**
 * How fast a large import and a search are, measured apart from `pnpm test`: the kit's safe-change
 * checks (change, upgrade, serve --install) run the test suite on machines that may be busy, and a
 * time limit there would refuse a good build. Run `pnpm test:perf` quietly before each tag.
 *
 * vitest.perf.config.ts prints the load average. On a busy machine it says the times are not measured, and they're skipped.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { cleanup, harness } from "./helpers";

/** Set by vitest.perf.config.ts, which prints the load average. */
const busy = process.env.PERF_BUSY === "1";

afterAll(cleanup);
describe("speed", () => {
  it.runIf(busy)("is not measured on a busy machine", () => undefined);
  it.skipIf(busy)("imports 20,000 links in under 30 seconds, then searches and lists them in under a second", async () => {
    const h = await harness();
    const rows = Array.from({ length: 20_000 }, (_, index) => `<DT><A HREF="https://site${index % 500}.example/page/${index}" ADD_DATE="${1600000000 + index}">Page ${index}</A>`);
    const text = `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL>${rows.join("\n")}</DL>`;
    const uploadId = randomUUID();
    const size = Math.ceil(text.length / 4);
    for (let part = 0; part < 4; part++) await h.call("upload_import_part", { uploadId, part, total: 4, text: text.slice(part * size, (part + 1) * size) });
    const preview = await h.call("preview_import", { uploadId, fileName: "bookmarks.html" });
    const started = Date.now();
    expect((await h.call("apply_import", { previewId: preview.previewId, digest: preview.digest })).added).toBe(20_000);
    const applied = Date.now() - started;
    const searchStarted = Date.now();
    expect((await h.call("list_bookmarks", { query: "Page 19999" })).items.length).toBeGreaterThan(0);
    expect((await h.call("list_bookmarks", { limit: 100 })).items[0].title).toBe("Page 19999");
    const searched = Date.now() - searchStarted;
    console.log(`Imported 20,000 links in ${(applied / 1000).toFixed(1)} s. Searched and listed in ${searched} ms.`);
    expect(applied).toBeLessThan(30_000);
    expect(searched).toBeLessThan(1000);
  }, 120_000);
});
