// vitest.config.ts — test runner + coverage gate. Implements plan 05 §1 (the pyramid: tests/**) and
// §7 (coverage thresholds, read from scripts/ci/coverage-gate.json so vitest and
// scripts/ci/check-coverage.mjs can never disagree). Ported from sibling @d72e03b, adapted.
// Two projects: `unit` (everything in-process — `npm test` / `npm run test:coverage`) and `process`
// (tests/process + tests/e2e: real child processes, the built dist/, wall-clock latency —
// `npm run test:process`, plan 05 §4.2). Child processes add no coverage, so the gate is measured on
// `unit` alone.
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

interface Gate {
  global: { lines: number; branches: number; functions: number; statements: number };
  perFile100: string[];
  exclude: string[];
}

const gate = JSON.parse(
  readFileSync(new URL("./scripts/ci/coverage-gate.json", import.meta.url), "utf8"),
) as Gate;

// The plan 05 §7 modules must be 100 % lines + branches. They are globs, so each binds the moment
// its file exists; check-coverage.mjs re-checks per file from the summary.
const perFile = Object.fromEntries(gate.perFile100.map((g) => [g, { lines: 100, branches: 100 }]));

/**
 * The process-level suites (plan 05 §4.2): spawned servers, the built package, and wall-clock
 * budgets. A test asserting a latency budget is named `*.perf.test.ts` and runs here, never under
 * `test:coverage` (coverage instrumentation slows code ~3×; tests/lint/vitest-projects.test.ts
 * holds the partition).
 */
export const PROCESS_TESTS = [
  "tests/process/**/*.test.ts",
  "tests/e2e/**/*.test.ts",
  "tests/**/perf.test.ts",
  "tests/**/*.perf.test.ts",
];

/** The unit project's per-test hang detector (a timeout is not a budget; budgets live in `process`). */
export const UNIT_TEST_TIMEOUT_MS = 30_000;

/**
 * The unit project's forks: half the logical CPUs — one per physical core on a hyper-threaded
 * machine (this repo's Intel Mac: 6 of 12; a 4-vCPU CI runner: 2). Many unit tests spawn a child
 * process (the scanners over the whole tree, the CLIs, the fixture tools) and coverage adds CPU per
 * fork, so vitest's default of one fork per logical CPU less one oversubscribed the machine (11
 * forks, load ≈ 34 on 12 threads) until the hang detectors above tripped on healthy tests — the
 * documented local gate (`npm run test:coverage`) must reproduce, not depend on an idle machine.
 */
export const UNIT_MAX_WORKERS = "50%";

export default defineConfig({
  test: {
    environment: "node",
    pool: "forks",
    restoreMocks: true,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: [...PROCESS_TESTS, "**/node_modules/**"],
          testTimeout: UNIT_TEST_TIMEOUT_MS,
          maxWorkers: UNIT_MAX_WORKERS,
        },
      },
      {
        extends: true,
        // one file at a time (wall-clock latency is measured here); every test spawns processes
        test: {
          name: "process",
          include: PROCESS_TESTS,
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: gate.exclude,
      reporter: ["text", "json-summary", "json", "html"],
      reportsDirectory: "coverage",
      thresholds: { ...gate.global, ...perFile },
    },
  },
});
