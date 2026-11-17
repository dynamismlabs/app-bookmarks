import os from "node:os";
import { defineConfig } from "vitest/config";
// Timings only (pnpm test:perf). `pnpm test` never runs these: see tests/import.perf.ts.
// The load is read here, in the main process, so it prints whatever the tests do.
const [load] = os.loadavg();
const cpus = os.cpus().length;
/** Busier than one waiting task per CPU over the last minute. */
const busy = load > cpus;
console.log(`Load average ${load.toFixed(1)} on ${cpus} CPUs. ${busy ? "The machine is busy, so the times are not measured." : "Measuring."}`);
export default defineConfig({ test: { include: ["tests/**/*.perf.ts"], testTimeout: 120_000, hookTimeout: 60_000, fileParallelism: false, maxWorkers: 1, env: { PERF_BUSY: busy ? "1" : "" } } });
