// plugin-eval-docs.test.ts — every documented `claude plugin eval` command is one the pinned CLI
// accepts, and the README runs the built suite the way the suite's own build prints it (Stage C
// finding docs-trust-plugin-flag-rejected; plan 09 §5.2; plan 10 B11 Lane 2, B15, D7; ruling R7-2).
// The README carried `claude plugin eval . … --trust-plugin …`: Claude Code 2.1.238 has no such
// option ("error: unknown option '--trust-plugin'", exit 1), and the repository root holds no cases —
// the suite is a build output (`npm run build:plugin-evals` → dist/plugin-evals, never committed)
// whose eval plugins run dist/cli.js in fixture mode. The accepted options are a snapshot of
// `claude plugin eval --help` at the version CI pins (.github/workflows/docs.yml); when that pin
// moves, the first test fails until the snapshot is re-taken from the new version's help.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OUT,
  mcpPrefix,
  planSuite,
  readme,
  run,
} from "../../scripts/skills/build-plugin-evals.mjs";
import { readManifest } from "../../scripts/skills/_lib.mjs";
import { commands, fences, readDoc, runnable, section, words } from "./docs-helpers.js";
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
