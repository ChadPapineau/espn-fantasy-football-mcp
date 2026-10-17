// plugin-eval-docs.test.ts — every documented `claude plugin eval` command is one the pinned CLI
// accepts, and the README runs the built suite the way the suite's own build prints it (Stage C
// finding docs-trust-plugin-flag-rejected; plan 09 §5.2; plan 10 B11 Lane 2, B15, D7; ruling R7-2).
// The README carried `claude plugin eval . … --trust-plugin …`: Claude Code 2.1.238 has no such
// option ("error: unknown option '--trust-plugin'", exit 1), and the repository root holds no cases —
// the suite is a build output (`npm run build:plugin-evals` → dist/plugin-evals, never committed)
// whose eval plugins run dist/cli.js in fixture mode. The accepted options are a snapshot of
// `claude plugin eval --help` at the version CI pins (.github/workflows/docs.yml); when that pin
// moves, the first test fails until the snapshot is re-taken from the new version's help.
// The plan half (attempt 2): plan 09 §5.2 gave the same runner, and the plan placed the suite in a
// committed root `evals/` answered by mocks (plan 04 §1, plan 05 §1, plan 09 §4 and §5.1 items 6
// and 9, plan 10 B15). The pinned harness has no MCP mock layer, so the suite's eval plugins run the built
// server in fixture mode; the plan's runner, layout trees and Lane 2 statements are held to that
// here (changelog §B4).
import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OUT,
  mcpPrefix,
  planSuite,
  readme,
  run,
} from "../../scripts/skills/build-plugin-evals.mjs";
import { readManifest } from "../../scripts/skills/_lib.mjs";
import { commands, fences, readDoc, runnable, section, tableRows, words } from "./docs-helpers.js";
import { ROOT } from "./helpers.js";

/** The Claude Code version the option snapshot below was taken from. */
const SNAPSHOT_VERSION = "2.1.238";
/** `claude plugin eval --help`, Claude Code 2.1.238 (the options, as listed). */
const PLUGIN_EVAL_OPTIONS: ReadonlySet<string> = new Set([
  "--ablation",
  "--allow-tools",
  "--case",
  "--eval-dir",
  "-h",
  "--help",
  "--json",
  "--judge-model",
  "--keep-temp",
  "--max-cost-usd",
  "--model",
  "--no-publish",
  "--no-scaffold",
  "--output-dir",
  "--publish-report",
  "--report",
  "--runs",
  "--scaffold",
  "--tag",
  "--threshold",
  "--verbose",
]);

/** The options a command line passes (`--name` or `--name=value`; `-h`). */
const optionsOf = (cmd: string): string[] =>
  words(cmd)
    .filter((w) => /^--?[a-z]/i.test(w))
    .map((w) => w.replace(/=.*$/, ""));
/** The options of `cmd` that the pinned CLI does not accept. */
const rejected = (cmd: string): string[] =>
  optionsOf(cmd).filter((o) => !PLUGIN_EVAL_OPTIONS.has(o));

const manifest = readManifest(ROOT);
const GRANT = `${mcpPrefix(manifest.plugin)}*`;
/** The README's placeholder for the clone, as in its launch configuration examples. */
const SUITE = `/absolute/path/to/espn-fantasy-football-mcp/${DEFAULT_OUT}`;
const README = readDoc("README.md");
const lane2Block = (): string[] => {
  const testing = section(README, "## Contributing");
  const f = fences(testing).find((x) => x.lang === "sh" && x.lines.join("\n").includes("Lane 2"));
  return f === undefined ? [] : runnable(f);
};

describe("the accepted options are the pinned CLI's", () => {
  it("the snapshot was taken from the Claude Code version CI pins", () => {
    const pin =
      /CLAUDE_CODE_PLATFORM_PKG:\s*"@anthropic-ai\/claude-code-[a-z0-9-]+@(\d+\.\d+\.\d+)"/.exec(
        readDoc(".github/workflows/docs.yml"),
      );
    expect(
      pin?.[1],
      "re-take PLUGIN_EVAL_OPTIONS from the new pin's `claude plugin eval --help`",
    ).toBe(SNAPSHOT_VERSION);
  });

  it("the check refuses the command the README used to document", () => {
    const former =
      "claude plugin eval . --json results.json --trust-plugin --model <pinned> --judge-model <pinned> --ablation none --max-cost-usd 20";
    expect(rejected(former)).toEqual(["--trust-plugin"]);
    expect(former).not.toBe(run(SUITE, GRANT, "results.json"));
  });
});

describe("every documented `claude plugin eval` command uses only accepted options", () => {
  it.each(["README.md", "skills/README.md"])("%s", (doc) => {
    const found = commands(readDoc(doc), "claude plugin eval ");
    expect(found.length, `${doc} documents the Lane 2 run`).toBeGreaterThan(0);
    for (const c of found) expect(rejected(c.cmd), c.cmd).toEqual([]);
  });

  it("the suite's generated README (every step's command) and the build's run command", () => {
    const plan = planSuite(ROOT);
    const text = readme({ out: "/o", manifest, plan, seedNeeded: ["NC-INJ-2"] });
    const found = commands(text, "claude plugin eval ");
    expect(found.length).toBeGreaterThanOrEqual(2); // the base cases, then the suite
    for (const c of found) expect(rejected(c.cmd), c.cmd).toEqual([]);
    expect(rejected(run("/o", GRANT, "results.json"))).toEqual([]);
  });
});

describe("the README's Lane 2 run is the built suite, run the way its build prints it", () => {
  it("the suite command is the build's own, with the suite directory as the target", () => {
    const evals = lane2Block().filter((c) => c.startsWith("claude plugin eval "));
    expect(evals).toEqual([run(SUITE, GRANT, "results.json")]);
    expect(words(evals[0] ?? "")[3]).toMatch(new RegExp(`/${DEFAULT_OUT}$`));
  });

  it("the block builds the server and the suite before it runs it, with flags the build accepts", () => {
    const cmds = lane2Block();
    const at = (re: RegExp): number => cmds.findIndex((c) => re.test(c));
    const build = at(/^npm run build$/);
    const suite = at(/^npm run build:plugin-evals\b/);
    const evalAt = at(/^claude plugin eval /);
    expect(build).toBeGreaterThanOrEqual(0);
    expect(suite).toBeGreaterThan(build);
    expect(evalAt).toBeGreaterThan(suite);
    const pkg = JSON.parse(readDoc("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["build:plugin-evals"]).toBe("node scripts/skills/build-plugin-evals.mjs");
    const usage = /"usage: build-plugin-evals\.mjs ([^"]+)"/.exec(
      readDoc("scripts/skills/build-plugin-evals.mjs"),
    )?.[1];
    expect(usage).toBeDefined();
    const flags = optionsOf((cmds[suite] ?? "").split(" -- ")[1] ?? "");
    expect(flags.length).toBeGreaterThan(0);
    for (const f of flags) expect(usage, f).toContain(`[${f}]`);
  });
});

/** The numbered plan documents (`docs/plan/NN-*.md`): the spec the README's Lane 2 block follows. */
const PLAN_DOCS: readonly string[] = readdirSync(path.join(ROOT, "docs/plan"))
  .filter((f) => /^\d{2}-.+\.md$/.test(f))
  .sort()
  .map((f) => `docs/plan/${f}`);
const PLAN_09 = "docs/plan/09-skills-bundle.md";
const planLane2 = (): string => section(readDoc(PLAN_09), "### 5.2 Lane 2");
/** Plan 09 §5.2's Harness bullet (one line of the file). */
const planHarness = (): string =>
  planLane2()
    .split("\n")
    .find((l) => l.startsWith("- **Harness.**")) ?? "";
/** The lines of the layout tree in `heading`'s section of `doc` (its fenced block of `├── ` entries). */
const treeOf = (doc: string, heading: string): readonly string[] =>
  fences(section(readDoc(doc), heading)).find((f) => f.lines.some((l) => /^[├└]── /.test(l)))
    ?.lines ?? [];
/** A plan line about Lane 2's mocks: a mock, and the harness, its fixture league or its mock tree. */
const isLane2MockLine = (l: string): boolean =>
  /\bmocks?\b/i.test(l) && /`claude plugin eval`|fx-10h|evals\/mocks\//.test(l);

describe("the plan runs Lane 2 the way the build does, with options the pinned CLI accepts (the finding's plan half)", () => {
  it("every `claude plugin eval` command in the numbered plan documents uses only accepted options", () => {
    expect(PLAN_DOCS).toContain(PLAN_09);
    const found = PLAN_DOCS.flatMap((doc) =>
      commands(readDoc(doc), "claude plugin eval ").map((c) => ({ doc, cmd: c.cmd })),
    );
    expect(
      found.map((c) => c.doc),
      "plan 09 §5.2 documents the Lane 2 run",
    ).toContain(PLAN_09);
    for (const c of found) expect(rejected(c.cmd), `${c.doc}: ${c.cmd}`).toEqual([]);
  });

  it("plan 09 §5.2's runner is the build's own command, with the built suite as the target", () => {
    const runners = commands(planLane2(), "claude plugin eval ").map((c) => c.cmd);
    expect(runners).toHaveLength(1);
    const target = words(runners[0] ?? "")[3] ?? "";
    expect(target).toBe(`<clone>/${DEFAULT_OUT}`);
    expect(runners[0]).toBe(run(target, GRANT, "results.json"));
  });

  it("plan 09 §5.2 builds the suite with flags the build accepts, and says what answers a case's tools", () => {
    const harness = planHarness();
    const pkg = JSON.parse(readDoc("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["build:plugin-evals"]).toBe("node scripts/skills/build-plugin-evals.mjs");
    const build = /`npm run build:plugin-evals -- ([^`]+)`/.exec(harness)?.[1];
    expect(build, "§5.2 names the suite's build").toBeDefined();
    const usage = /"usage: build-plugin-evals\.mjs ([^"]+)"/.exec(
      readDoc("scripts/skills/build-plugin-evals.mjs"),
    )?.[1];
    expect(usage).toBeDefined();
    const flags = optionsOf(build ?? "");
    expect(flags.length).toBeGreaterThan(0);
    for (const f of flags) expect(usage, f).toContain(`[${f}]`);
    expect(harness).toContain("`npm run build`"); // the eval servers run dist/cli.js
    expect(harness).toContain(`\`${DEFAULT_OUT}/\``);
    expect(harness).toMatch(/\*\*eval plugins\*\*/);
    expect(harness).toContain("`dist/cli.js serve` in fixture mode");
  });

  it("no layout tree in the plan has a committed evals/ suite at the root; plan 09 §4's names the build output", () => {
    const trees = [
      {
        doc: "docs/plan/04-repo-structure-and-ci.md",
        lines: treeOf("docs/plan/04-repo-structure-and-ci.md", "## 1. Directory tree"),
      },
      { doc: PLAN_09, lines: treeOf(PLAN_09, "## 4. Directory layout") },
    ];
    for (const t of trees) {
      expect(t.lines.length, `${t.doc} has its tree`).toBeGreaterThan(0);
      expect(
        t.lines.filter((l) => /^[├└]── evals\//.test(l)),
        t.doc,
      ).toEqual([]);
    }
    const built = trees[1]?.lines.find((l) => l.startsWith(`├── ${DEFAULT_OUT}/ `)) ?? "";
    expect(built).toContain("NOT committed");
    // and it is not: the build output sits under dist/, which git ignores
    expect(DEFAULT_OUT.startsWith("dist/")).toBe(true);
    expect(readDoc(".gitignore").split("\n")).toContain("/dist/");
  });

  it("plan 05's pyramid row for Lane 2 places the suite where the build writes it", () => {
    const rows = tableRows(
      section(readDoc("docs/plan/05-testing-strategy.md"), "## 1. The pyramid"),
    );
    const header = rows[0] ?? [];
    const row = rows.find((r) => (r[0] ?? "").startsWith("Skills Lane 2"));
    expect(row, "the Lane 2 row").toBeDefined();
    const cell = (name: string): string => {
      const i = header.indexOf(name);
      expect(i, name).toBeGreaterThanOrEqual(0);
      return row?.[i] ?? "";
    };
    expect(cell("Where").startsWith(`\`${DEFAULT_OUT}/\``)).toBe(true);
    expect(cell("Tool")).toMatch(/eval plugins?/);
    expect(cell("Needs ESPN cookies")).toBe("no (fixture mode)");
  });

  it("every plan line about Lane 2's mocks says they are eval plugins running the built server in fixture mode", () => {
    const lines = PLAN_DOCS.flatMap((doc) =>
      readDoc(doc)
        .split("\n")
        .map((l, i) => ({ at: `${doc}:${String(i + 1)}`, l })),
    ).filter((x) => isLane2MockLine(x.l));
    expect(
      lines.length,
      "plan 09 §5.1 item 9, §5.2 and plan 10 B15 keep their wording",
    ).toBeGreaterThan(0);
    for (const x of lines) {
      expect(x.l, x.at).toMatch(/eval plugins?/);
      expect(x.l, x.at).toMatch(/fixture mode/);
    }
  });

  it("the mock-line reader finds the statements this finding corrected, and not the unit tests' mocks", () => {
    for (const before of [
      "| Skills Lane 2 (model-graded) — T-10 | `evals/` | `claude plugin eval` with mocks from `fx-10h` (plan 09 §5.2) | no — manual, pre-release | no (mocks) | **yes** |",
      "│   ├── mocks/espn-fantasy-football/     # one <tool>.md per tool with {{file:fixtures/espn/fx-10h/…}} substitution; _tools.json; .replay/",
      "- B15 **Plugin eval suite:** `claude plugin eval` runs all 13 Skills' cases with mocks generated from `fx-10h`; the free graders all pass.",
    ]) {
      expect(isLane2MockLine(before), before).toBe(true);
      expect(before).not.toMatch(/eval plugins?/);
    }
    for (const other of [
      "| `auth/keychain` (unit) | the addon is mocked; a test asserts the mock is not called at construction or at `tools/list` |",
      "`AP-3` (`writes-on`, commit mock returns `PRECONDITION_CHANGED`) → re-prepares, does not retry",
    ])
      expect(isLane2MockLine(other), other).toBe(false);
  });
});
