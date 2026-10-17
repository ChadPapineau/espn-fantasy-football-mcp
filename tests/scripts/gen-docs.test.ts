// gen-docs.test.ts — the docs-current generators (plan 04 §6: "Docs that are generated, not
// written"; plan 04 §4.2's `docs-current` job; Stage C finding docs-current-check-missing: README.md
// carried a stale toolset count, a test-key table and every tool marked 📋 planned while the
// registry served 34 — nothing held a document to the code). scripts/gen-config-docs.ts builds
// README.md's `config-keys` and `test-keys` regions from src/config/schema.ts; scripts/gen-tool-docs.ts
// builds the `tools` region from src/mcp/registry.ts, holds every catalog row's Status to the
// registry and every cheat-sheet field to its tool's output schema. The tree is current, and each
// check fails on a doctored copy (the positive controls the CI self-test also runs). No network.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TARGETS as CONFIG_TARGETS,
  configKeysTable,
  testKeysTable,
  unexplainedKeys,
} from "../../scripts/gen-config-docs.js";
import {
  TARGETS as TOOL_TARGETS,
  builtTools,
  cheatSheetProblems,
  statusProblems,
  toolsTable,
} from "../../scripts/gen-tool-docs.js";
import { ROOT, cli, regionBody, runTargets, withRegion } from "../../scripts/docs/regions.js";
import { CONFIG_KEY_SPECS } from "../../src/config/schema.js";
import { tempDir } from "../lint/helpers.js";

const README = readFileSync(path.join(ROOT, "README.md"), "utf8");
const SHEET_FILE = "skills/_shared/references/tool-outputs.md";
const SHEET = readFileSync(path.join(ROOT, SHEET_FILE), "utf8");

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** A copy of the two target files under a temp root, optionally doctored. */
function copyRoot(edit: { readme?: (s: string) => string; sheet?: (s: string) => string } = {}) {
  const t = tempDir("gen-docs-");
  cleanups.push(t.cleanup);
  mkdirSync(path.join(t.dir, path.dirname(SHEET_FILE)), { recursive: true });
  cpSync(path.join(ROOT, "README.md"), path.join(t.dir, "README.md"));
  cpSync(path.join(ROOT, SHEET_FILE), path.join(t.dir, SHEET_FILE));
  if (edit.readme) writeFileSync(path.join(t.dir, "README.md"), edit.readme(README));
  if (edit.sheet) writeFileSync(path.join(t.dir, SHEET_FILE), edit.sheet(SHEET));
  return t.dir;
}

function run(targets: Parameters<typeof runTargets>[1], mode: "check" | "write", root: string) {
  const lines: string[] = [];
  const code = runTargets("t", targets, mode, root, (l) => lines.push(l));
  return { code, lines };
}

const dropLine = (re: RegExp) => (s: string) =>
  s
    .split("\n")
    .filter((l) => !re.test(l))
    .join("\n");

describe("the tree is current (what CI's docs-current runs)", () => {
  it("gen-config-docs --check passes on the repository", () => {
    expect(run(CONFIG_TARGETS, "check", ROOT)).toEqual({
      code: 0,
      lines: ["t: ok — 1 file(s) current"],
    });
  });

  it("gen-tool-docs --check passes on the repository", () => {
    expect(run(TOOL_TARGETS, "check", ROOT)).toEqual({
      code: 0,
      lines: ["t: ok — 2 file(s) current"],
    });
  });

  it("the README carries all three regions, each equal to its generator's table", () => {
    expect(regionBody(README, "config-keys")).toBe(configKeysTable());
    expect(regionBody(README, "test-keys")).toBe(testKeysTable());
    expect(regionBody(README, "tools")).toBe(toolsTable());
  });

  it("package.json wires check:docs (both --check) and docs:gen (both --write)", () => {
    const scripts = (
      JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts["check:docs"]).toBe(
      "tsx scripts/gen-config-docs.ts --check && tsx scripts/gen-tool-docs.ts --check",
    );
    expect(scripts["docs:gen"]).toBe(
      "tsx scripts/gen-config-docs.ts --write && tsx scripts/gen-tool-docs.ts --write",
    );
  });
});

describe("gen-config-docs (plan 04 §6: the config table ← src/config/schema.ts, by scope)", () => {
  it("config-keys lists every server and launcher key in schema order; test-keys every test key", () => {
    const keysOf = (table: string) => [...table.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]);
    expect(keysOf(configKeysTable())).toEqual(
      CONFIG_KEY_SPECS.filter((s) => s.scope !== "test").map((s) => s.key),
    );
    expect(keysOf(testKeysTable())).toEqual(
      CONFIG_KEY_SPECS.filter((s) => s.scope === "test").map((s) => s.key),
    );
  });

  it("a cell keeps a pipe and a line break inside one cell", () => {
    const spec = CONFIG_KEY_SPECS.find((s) => s.key === "EFF_LOG_LEVEL");
    if (spec === undefined) throw new Error("EFF_LOG_LEVEL is not in the schema");
    const table = configKeysTable([{ ...spec, description: "a new | piped\nkey" }]);
    expect(table.split("\n")).toHaveLength(3);
    expect(table).toContain("| `EFF_LOG_LEVEL` | server |");
    expect(table).toContain("| a new \\| piped key |");
  });

  it("a schema key the .env.example table does not explain fails the check, naming the key", () => {
    expect(unexplainedKeys(README)).toEqual([]);
    const forgotten = dropLine(/^\| `(?:# )?EFF_LOG_LEVEL=/)(README);
    expect(forgotten).not.toBe(README);
    expect(unexplainedKeys(forgotten)).toEqual(["EFF_LOG_LEVEL"]);
    const r = run(CONFIG_TARGETS, "check", copyRoot({ readme: () => forgotten }));
    expect(r.code).toBe(1);
    expect(r.lines).toContain(
      't: README.md: EFF_LOG_LEVEL is in src/config/schema.ts but the ".env.example, line by line" table does not explain it',
    );
  });

  it("a stale config row fails --check, --write restores it, then --check passes", () => {
    const root = copyRoot({ readme: dropLine(/^\| `ESPN_SEASON` \| server \|/) });
    const stale = run(CONFIG_TARGETS, "check", root);
    expect(stale.code).toBe(1);
    expect(stale.lines.join("\n")).toContain("README.md: not current");
    expect(run(CONFIG_TARGETS, "write", root).code).toBe(0);
    expect(readFileSync(path.join(root, "README.md"), "utf8")).toBe(README);
    expect(run(CONFIG_TARGETS, "check", root).code).toBe(0);
  });

  it("a README that lost a region's markers fails, naming the region", () => {
    const root = copyRoot({
      readme: (s) => s.replace(/^<!-- END GENERATED: test-keys -->$/m, ""),
    });
    const r = run(CONFIG_TARGETS, "check", root);
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toContain('no "<!-- END GENERATED: test-keys -->" marker');
  });
});

describe("gen-tool-docs (plan 04 §6: the tool reference ← the registry)", () => {
  it("the tools region has one row per registered tool, in registry order", () => {
    const names = [...toolsTable().matchAll(/^\| [A-Z]\d+ \| `(espn_[a-z_]+)` \|/gm)].map(
      (m) => m[1],
    );
    expect(names).toEqual(builtTools().map((t) => t.tool.name));
    expect(names.length).toBeGreaterThan(0);
  });

  it("a stale tools row fails --check and --write restores it", () => {
    const root = copyRoot({ readme: dropLine(/^\| A1 \| `espn_get_league` \|/) });
    const r = run(TOOL_TARGETS, "check", root);
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toContain("README.md: not current");
    expect(run(TOOL_TARGETS, "write", root).code).toBe(0);
    expect(readFileSync(path.join(root, "README.md"), "utf8")).toBe(README);
  });

  it("every catalog Status agrees with the registry today", () => {
    expect(statusProblems(README)).toEqual([]);
  });

  it("a registered tool shown 📋, an unbuilt tool shown ✅, and a registered tool with no row all fail", () => {
    const planned = README.replace(
      /^(\| `espn_get_standings` \|.*\| )✅ \|$/m,
      (_, head: string) => `${head}📋 |`,
    );
    expect(statusProblems(planned)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^espn_get_standings: Status 📋, but the tool is registered/),
      ]),
    );
    const claimed = README.replace(
      /^(\| `espn_get_draft_results` \|.*\| )📋 \|$/m,
      (_, head: string) => `${head}✅ |`,
    );
    expect(claimed).not.toBe(README);
    expect(statusProblems(claimed)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^espn_get_draft_results: Status ✅, but the tool is not built/),
      ]),
    );
    const rowless = dropLine(/^\| `espn_check_auth`/)(README);
    expect(statusProblems(rowless)).toContain(
      "espn_check_auth: registered but no catalog row names it",
    );
  });

  it("the cheat-sheet's field lists name only output-schema fields, and every registered tool has a row", () => {
    expect(cheatSheetProblems(SHEET)).toEqual([]);
  });

  it("a renamed field, a missing row and a row for an unbuilt tool all fail", () => {
    const renamed = SHEET.replace(
      /^(\| `espn_get_league` \|[^\n]*)`scoring\.settings_hash`/m,
      "$1`scoring.settings_digest`",
    );
    expect(renamed).not.toBe(SHEET);
    expect(cheatSheetProblems(renamed)).toEqual([
      'espn_get_league: `scoring.settings_digest` — the output schema has no field or value "settings_digest"',
    ]);
    expect(cheatSheetProblems(dropLine(/^\| `espn_get_league` \|/)(SHEET))).toEqual([
      "espn_get_league: registered, but the cheat-sheet has no row for it",
    ]);
    expect(
      cheatSheetProblems(`${SHEET}\n| \`espn_get_draft_results\` | picks | \`picks[]\` |\n`),
    ).toEqual(["espn_get_draft_results: a row for a tool the registry does not build"]);
  });

  it("the CI self-test's doctored copy fails both generators with the messages it greps for", () => {
    const root = copyRoot({
      readme: (s) =>
        dropLine(/^\| A1 \| `espn_get_league` \|/)(dropLine(/^\| `ESPN_SEASON` \| server \|/)(s)),
      sheet: dropLine(/^\| `espn_get_league` \|/),
    });
    const config = run(CONFIG_TARGETS, "check", root);
    const tools = run(TOOL_TARGETS, "check", root);
    expect(config.code).toBe(1);
    expect(config.lines.join("\n")).toContain("README.md: not current");
    expect(tools.code).toBe(1);
    expect(tools.lines.join("\n")).toContain("README.md: not current");
    expect(tools.lines.join("\n")).toContain(
      "espn_get_league: registered, but the cheat-sheet has no row for it",
    );
  });
});

describe("regions.ts", () => {
  it("withRegion replaces only the body between the markers", () => {
    const text = "a\n<!-- BEGIN GENERATED: x (gen) -->\nold\n<!-- END GENERATED: x -->\nb\n";
    expect(withRegion(text, "x", "new")).toBe(
      "a\n<!-- BEGIN GENERATED: x (gen) -->\nnew\n<!-- END GENERATED: x -->\nb\n",
    );
    expect(() => withRegion("no markers", "x", "new")).toThrow(/BEGIN GENERATED: x/);
  });

  it("the CLI refuses an unknown argument with exit 2", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(cli("t", [], ["--frobnicate"])).toBe(2);
      expect(spy.mock.calls.map((c) => String(c[0])).join("")).toContain(
        "unexpected argument --frobnicate",
      );
    } finally {
      spy.mockRestore();
    }
  });
});
