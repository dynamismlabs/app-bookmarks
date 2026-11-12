/**
 * A fictional preview, in place of Ri's old demo mode: a disposable data
 * directory with the fictional library, served by `app-builder dev` with the
 * fixture hub. No real page is requested and no personal data is opened.
 *
 *   pnpm preview            seed a fresh preview and start it
 *   pnpm preview --seed-only <dir>   only seed <dir> (for tests and screenshots)
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openNodePlatform } from "@app-builder/core/node";
import { application } from "../src/app";
import { seedFixtures } from "../src/services/fixtures";
import { bookmarksFor } from "../src/services/store";

export async function seedPreview(dataDir: string) {
  const opened = await openNodePlatform(application, { dataDir, localOwner: true });
  try {
    return await seedFixtures(bookmarksFor(opened.platform, "local-owner"));
  } finally {
    opened.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.dirname, "preview.ts")) {
  const seedOnly = process.argv.indexOf("--seed-only");
  const dataDir = seedOnly >= 0 ? path.resolve(process.argv[seedOnly + 1]) : await fs.mkdtemp(path.join(os.tmpdir(), "bookmarks-preview-"));
  await seedPreview(dataDir);
  console.log(`Fictional preview in ${dataDir}`);
  if (seedOnly < 0) {
    const child = spawn("pnpm", ["exec", "app-builder", "dev"], { stdio: "inherit", env: { ...process.env, APP_DATA_DIR: dataDir, APP_CONNECTORS: "fixtures" } });
    child.on("exit", (code) => process.exit(code ?? 0));
  }
}
