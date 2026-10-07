// vitest-projects.test.ts — the unit/process partition of vitest.config.ts (plan 05 §1, §4.2, §7):
// every test file runs in exactly one project, and wall-clock budgets run in `process`, never under
// coverage; the coverage thresholds are the plan 05 §7 gate. Ported from sibling @d72e03b, adapted.
import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import config, {
  PROCESS_TESTS,
  UNIT_MAX_WORKERS,
  UNIT_TEST_TIMEOUT_MS,
} from "../../vitest.config.js";
import { ROOT } from "./helpers.js";

interface ProjectTest {
  name: string;
  include: string[];
  exclude?: string[];
  testTimeout?: number;
  fileParallelism?: boolean;
  maxWorkers?: number | string;
}
const projects = (config.test?.projects ?? []) as { test: ProjectTest }[];
const project = (name: string): ProjectTest => {
  const p = projects.find((x) => x.test.name === name)?.test;
  if (p === undefined) throw new Error(`no ${name} project`);
  return p;
};
const unit = project("unit");
const proc = project("process");

const matches = (file: string, globs: readonly string[]): boolean =>
  globs.some((g) => path.matchesGlob(file, g));
const runsIn = (file: string, p: ProjectTest): boolean =>
  matches(file, p.include) && !matches(file, p.exclude ?? []);
const where = (file: string): string[] =>
  [unit, proc].filter((p) => runsIn(file, p)).map((p) => p.name);

const ALL = globSync("tests/**/*.test.ts", { cwd: ROOT })
  .filter((f) => !f.includes("node_modules"))
  .map((f) => f.split(path.sep).join("/"));

describe("vitest projects partition the test files", () => {
  it("finds the suite (a vacuous glob would pass everything below)", () => {
    expect(ALL.length).toBeGreaterThan(5);
    expect(ALL).toContain("tests/lint/boundaries.test.ts");
  });

  it("every test file runs in exactly one project — none twice, none silently nowhere", () => {
    const wrong = ALL.map((f) => [f, where(f)] as const).filter(([, w]) => w.length !== 1);
    expect(wrong).toEqual([]);
  });

  it("the unit project excludes exactly the process globs", () => {
    for (const g of PROCESS_TESTS) expect(unit.exclude ?? []).toContain(g);
    expect(proc.include).toEqual(PROCESS_TESTS);
  });

  it("the naming rule, adversarially: *.perf.test.ts anywhere is a process test; look-alikes are not", () => {
    expect(where("tests/a/b/c/x.perf.test.ts")).toEqual(["process"]);
    expect(where("tests/x.perf.test.ts")).toEqual(["process"]);
    expect(where("tests/deep/perf.test.ts")).toEqual(["process"]);
    expect(where("tests/process/shutdown.test.ts")).toEqual(["process"]);
    expect(where("tests/e2e/stdio.test.ts")).toEqual(["process"]);
    for (const f of [
      "tests/store/perfect.test.ts",
      "tests/store/superf.test.ts",
      "tests/store/perf.test.tsx",
      "tests/store/contention.test.ts",
      "tests/store/x.perf.spec.ts",
      "tests/processx/a.test.ts",
    ])
      expect(where(f), f).not.toEqual(["process"]);
  });

  it("the process project runs one file at a time with a timeout sized for spawned processes", () => {
    expect(proc.fileParallelism).toBe(false);
    expect(proc.testTimeout).toBeGreaterThanOrEqual(30_000);
  });

  it("the unit hang detector is bounded", () => {
    expect(unit.testTimeout).toBe(UNIT_TEST_TIMEOUT_MS);
    expect(UNIT_TEST_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
    expect(UNIT_TEST_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });

  it("the unit project runs one fork per physical core, not one per logical CPU", () => {
    // its tests spawn child processes and coverage adds CPU per fork: the default oversubscribed a
    // hyper-threaded machine until healthy tests hit the hang detector (the B2a gate, round 1)
    expect(unit.maxWorkers).toBe(UNIT_MAX_WORKERS);
    expect(UNIT_MAX_WORKERS).toBe("50%");
  });
});

describe("coverage gate (plan 05 §7)", () => {
  const gate = JSON.parse(
    readFileSync(path.join(ROOT, "scripts/ci/coverage-gate.json"), "utf8"),
  ) as {
    global: Record<string, number>;
    perFile100: string[];
    exclude: string[];
  };
  const thresholds = (config.test?.coverage as { thresholds?: Record<string, unknown> } | undefined)
    ?.thresholds;

  it("vitest's thresholds are the gate file's: global 90/85/90/90 and every 100 % module", () => {
    expect(gate.global).toEqual({ lines: 90, branches: 85, functions: 90, statements: 90 });
    for (const [k, v] of Object.entries(gate.global)) expect(thresholds?.[k], k).toBe(v);
    for (const g of gate.perFile100)
      expect(thresholds?.[g], g).toEqual({ lines: 100, branches: 100 });
  });

  it("names every plan 05 §7 module (globs bind as each file lands)", () => {
    expect(gate.perFile100).toEqual(
      expect.arrayContaining([
        "src/domain/scoring/**",
        "src/domain/reclog/metrics.ts",
        "src/domain/gate/**",
        "src/providers/espn/path.ts",
        "src/providers/espn/filter.ts",
        "src/providers/espn/errors.ts",
        "src/providers/espn/ids.ts",
        "src/auth/file.ts",
        "src/auth/format.ts",
        "src/cli/log.ts",
        "src/drift/**",
      ]),
    );
    expect(gate.exclude).toContain("src/cli.ts");
  });

  it("writes the json-summary that check-coverage.mjs reads", () => {
    const reporter = (config.test?.coverage as { reporter?: string[] } | undefined)?.reporter;
    expect(reporter).toContain("json-summary");
  });
});
