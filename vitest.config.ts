import { defineConfig } from "vitest/config";
// One test file at a time, in one worker: the suite shares a machine with other apps' checks.
export default defineConfig({ test: { include: ["tests/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 60_000, fileParallelism: false, maxWorkers: 1 } });
