// boundaries.test.ts — proves the lint gate can FAIL (plan 10 §3.0 Z3; plan 04 R3, §3, A-4): the
// plan 01 §1.1 layer table, the two ESPN zones (keyring import site, wire-schema views), the
// child_process/eval bans (plan 02 §7) and stdout discipline (plan 01 §2), linted with the real
// eslint.config.js through the ESLint API on virtual files. Ported from sibling @d72e03b, adapted.
import path from "node:path";
import { ESLint, type Linter } from "eslint";
import tseslint from "typescript-eslint";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KEYRING_SITE, boundaryZones, layerOf } from "../../eslint.config.js";
import { ROOT, tempDir, writeTree } from "./helpers.js";

// Virtual files have no tsconfig program; boundary rules need no type information.
const noTypes: Linter.Config[] = [
  tseslint.configs.disableTypeChecked,
  { languageOptions: { parserOptions: { projectService: false, project: null } } },
];

const eslint = new ESLint({ cwd: ROOT, overrideConfig: noTypes });

async function lint(rel: string, code: string): Promise<Linter.LintMessage[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, rel) });
  if (!result) throw new Error("no lint result");
  return result.messages;
}

const rules = (msgs: Linter.LintMessage[]): (string | null)[] => msgs.map((m) => m.ruleId);
const errors = (msgs: Linter.LintMessage[]) => msgs.filter((m) => m.severity === 2);

const BOUNDARY_RULES = new Set([
  "eff/layer-boundaries",
  "import-x/no-restricted-paths",
  "no-restricted-imports",
  "no-restricted-globals",
  "no-restricted-properties",
  "no-restricted-syntax",
  "no-console",
  "no-eval",
  "no-new-func",
]);
const boundaryHits = (msgs: Linter.LintMessage[]) =>
  msgs.filter((m) => m.ruleId === null || BOUNDARY_RULES.has(m.ruleId));

describe("Z3: a src/domain file importing src/auth fails lint", () => {
  it("fails on `import … from '../auth/store.js'` and names the layer rule", async () => {
    const msgs = await lint(
      "src/domain/probe.ts",
      `import { x } from "../auth/store.js";\nexport const y = x;\n`,
    );
    expect(errors(msgs).length).toBeGreaterThan(0);
    expect(rules(msgs)).toContain("eff/layer-boundaries");
    expect(msgs.find((m) => m.ruleId === "eff/layer-boundaries")?.message).toContain("src/auth");
  });

  it("passes on a legal import (domain -> domain, domain -> root, domain -> config)", async () => {
    const msgs = await lint(
      "src/domain/probe.ts",
      `import { x } from "./league/model.js";\nimport { VERSION } from "../version.js";\nimport { T } from "../config/freshness.js";\nexport const y = [x, VERSION, T];\n`,
    );
    expect(boundaryHits(msgs)).toEqual([]);
  });
});

describe("ESPN zone: only src/auth/keychain.ts may import @napi-rs/keyring (plan 04 R3)", () => {
  const forms = [
    `import { Entry } from "@napi-rs/keyring"; export const e = Entry;`,
    `import * as k from "@napi-rs/keyring"; export const e = k;`,
    `export { Entry } from "@napi-rs/keyring";`,
    `export const m = () => import("@napi-rs/keyring");`,
    `import { createRequire } from "node:module"; export const k = createRequire(import.meta.url)("@napi-rs/keyring");`,
    `declare const require: (s: string) => unknown; export const k = require("@napi-rs/keyring");`,
    `import x from "@napi-rs/keyring-darwin-x64"; export const e = x;`,
    `import x from "@napi-rs/keyring/index.js"; export const e = x;`,
  ];
  for (const file of [
    "src/auth/store.ts",
    "src/auth/file.ts",
    "src/cli/setup.ts",
    "src/domain/probe.ts",
    "src/mcp/probe.ts",
    "src/providers/espn/provider.ts",
    "src/http/client.ts",
    "src/version.ts",
  ]) {
    it.each(forms)(`${file}: %s -> fails`, async (code) => {
      const msgs = await lint(file, code);
      expect(rules(msgs)).toContain("eff/layer-boundaries");
      expect(msgs.some((m) => m.message.includes("@napi-rs/keyring"))).toBe(true);
    });
  }

  it("scripts may not import it either (no-restricted-imports)", async () => {
    const msgs = await lint(
      "scripts/probe.mjs",
      `import { Entry } from "@napi-rs/keyring";\nexport const e = Entry;\n`,
    );
    expect(rules(msgs)).toContain("no-restricted-imports");
  });

  it(`${KEYRING_SITE} may import it, and tests may`, async () => {
    const code = `import { Entry } from "@napi-rs/keyring";\nexport const e = Entry;\n`;
    expect(boundaryHits(await lint(KEYRING_SITE, code))).toEqual([]);
    expect(boundaryHits(await lint("tests/auth/keychain.test.ts", code))).toEqual([]);
  });

  it("a look-alike package name is not the keyring", async () => {
    const code = `import { x } from "@napi-rs/keyringx"; export const y = x;`;
    expect(rules(await lint("src/auth/store.ts", code))).not.toContain("eff/layer-boundaries");
  });
});

describe("ESPN zone: only src/providers/espn/ may import the wire schemas in views/ (plan 04 R3)", () => {
  const outside: [string, string][] = [
    [
      "src/mcp/tools/probe.ts",
      `import { S } from "../../providers/espn/views/mSettings.js"; export const s = S;`,
    ],
    [
      "src/domain/probe.ts",
      `import type { S } from "../providers/espn/views/mTeam.js"; export type T = S;`,
    ],
    [
      "src/drift/probe.ts",
      `import { S } from "../providers/espn/views/mSettings.js"; export const s = S;`,
    ],
    [
      "src/providers/platform.ts",
      `import { S } from "./espn/views/mRoster.js"; export const s = S;`,
    ],
    [
      "src/providers/other/probe.ts",
      `import { S } from "../espn/views/mRoster.js"; export const s = S;`,
    ],
    ["src/cli/probe.ts", `export const m = () => import("../providers/espn/views/mSettings.js");`],
    ["src/sources/probe.ts", `export * from "../providers/espn/views/index.js";`],
    [
      "src/mcp/probe.ts",
      `import { S } from "../providers/espn/views/deep/x.js"; export const s = S;`,
    ],
    ["src/mcp/probe.ts", `import { S } from "../providers/espn/views"; export const s = S;`],
  ];
  it.each(outside)("%s: %s -> fails", async (file, code) => {
    const msgs = await lint(file, code);
    expect(rules(msgs)).toContain("eff/layer-boundaries");
    expect(msgs.some((m) => m.message.includes("wire schemas"))).toBe(true);
  });

  it.each([
    [
      "src/providers/espn/normalize.ts",
      `import { S } from "./views/mSettings.js"; export const s = S;`,
    ],
    ["src/providers/espn/sub/x.ts", `import { S } from "../views/mTeam.js"; export const s = S;`],
    [
      "src/providers/espn/views/mTeam.ts",
      `import { S } from "./mSettings.js"; export const s = S;`,
    ],
    [
      "tests/contract/mSettings.test.ts",
      `import { S } from "../../src/providers/espn/views/mSettings.js"; export const s = S;`,
    ],
  ])("%s: %s -> allowed", async (file, code) => {
    expect(boundaryHits(await lint(file, code))).toEqual([]);
  });

  it("a sibling directory whose name only starts with views is not the views zone", async () => {
    const code = `import { S } from "../providers/espn/viewsx/a.js"; export const s = S;`;
    const msgs = await lint("src/mcp/probe.ts", code);
    expect(msgs.some((m) => m.message.includes("wire schemas"))).toBe(false);
  });
});

describe("layer table (plan 01 §1.1), every import form", () => {
  const illegal: [string, string][] = [
    [
      "src/domain/league/probe.ts",
      `import { x } from "../../store/repos/x.js"; export const y = x;`,
    ],
    ["src/domain/probe.ts", `import { x } from "../mcp/x.js"; export const y = x;`],
    [
      "src/domain/probe.ts",
      `import { x } from "../providers/espn/provider.js"; export const y = x;`,
    ],
    ["src/domain/probe.ts", `import { x } from "../sources/nflverse/x.js"; export const y = x;`],
    ["src/domain/probe.ts", `import { x } from "../http/client.js"; export const y = x;`],
    ["src/domain/probe.ts", `import { x } from "../drift/probe.js"; export const y = x;`],
    ["src/domain/probe.ts", `export * from "../store/x.js";`],
    ["src/domain/probe.ts", `export { x } from "../store/x.js";`],
    ["src/domain/probe.ts", `import type { T } from "../store/x.js"; export type U = T;`],
    ["src/domain/probe.ts", `export type U = import("../store/x.js").T;`],
    ["src/domain/probe.ts", `export const m = () => import("../store/x.js");`],
    ["src/domain/probe.ts", `import "../store/x.js";`],
    ["src/mcp/probe.ts", `import { x } from "../store/db.js"; export const y = x;`],
    ["src/mcp/tools/probe.ts", `import { x } from "../../store/db.js"; export const y = x;`],
    ["src/mcp/probe.ts", `import { x } from "../auth/store.js"; export const y = x;`],
    ["src/providers/espn/probe.ts", `import { x } from "../../mcp/x.js"; export const y = x;`],
    ["src/drift/probe.ts", `import { x } from "../mcp/x.js"; export const y = x;`],
    ["src/sources/nflverse/probe.ts", `import { x } from "../../mcp/x.js"; export const y = x;`],
    [
      "src/sources/nflverse/probe.ts",
      `import { x } from "../../providers/platform.js"; export const y = x;`,
    ],
    ["src/store/probe.ts", `import { x } from "../mcp/x.js"; export const y = x;`],
    ["src/store/probe.ts", `import { x } from "../sources/x.js"; export const y = x;`],
    ["src/auth/probe.ts", `import { x } from "../domain/x.js"; export const y = x;`],
    ["src/http/probe.ts", `import { x } from "../domain/x.js"; export const y = x;`],
    ["src/config/probe.ts", `import { x } from "../store/x.js"; export const y = x;`],
    ["src/mcp/probe.ts", `import { x } from "../cli/log.js"; export const y = x;`],
    ["src/version.ts", `import { x } from "./cli/log.js"; export const y = x;`],
    ["src/mcp/probe.ts", `import { x } from "../cli.js"; export const y = x;`],
    ["src/domain/probe.ts", `import { x } from "../../tests/x.js"; export const y = x;`],
    ["src/mcp/probe.ts", `import { x } from "../../fixtures/x.js"; export const y = x;`],
    ["src/domain/probe.ts", `import { x } from "../domain/../auth/x.js"; export const y = x;`],
    ["src/domain/probe.ts", `import { x } from "#store/x.js"; export const y = x;`],
    ["src/domain/probe.ts", `import { x } from "/abs/src/store/x.js"; export const y = x;`],
  ];
  it.each(illegal)("%s: %s -> eff/layer-boundaries", async (file, code) => {
    expect(rules(await lint(file, code))).toContain("eff/layer-boundaries");
  });

  const legal: [string, string][] = [
    ["src/mcp/probe.ts", `import { x } from "../domain/x.js"; export const y = x;`],
    ["src/mcp/probe.ts", `import { x } from "../providers/platform.js"; export const y = x;`],
    ["src/store/probe.ts", `import type { T } from "../domain/x.js"; export type U = T;`],
    ["src/cli.ts", `import { x } from "./cli/serve.js"; export const y = x;`],
    ["src/cli/serve.ts", `import { x } from "../mcp/server.js"; export const y = x;`],
    ["src/cli/setup.ts", `import { x } from "../auth/store.js"; export const y = x;`],
    ["src/providers/espn/probe.ts", `import { x } from "../platform.js"; export const y = x;`],
    [
      "src/drift/probe.ts",
      `import { x } from "../providers/espn/provider.js"; export const y = x;`,
    ],
    ["src/domain/probe.ts", `import { z } from "zod"; export const y = z;`],
    ["tests/domain/probe.test.ts", `import { x } from "../../src/store/x.js"; export const y = x;`],
  ];
  it.each(legal)("%s: %s -> no boundary error", async (file, code) => {
    expect(boundaryHits(await lint(file, code))).toEqual([]);
  });
});

describe("module bans per layer", () => {
  const cases: [string, string, string][] = [
    [
      "src/domain/probe.ts",
      `import { readFileSync } from "node:fs"; export const r = readFileSync;`,
      "no-restricted-imports",
    ],
    [
      "src/domain/probe.ts",
      `import { readFile } from "fs/promises"; export const r = readFile;`,
      "no-restricted-imports",
    ],
    [
      "src/domain/probe.ts",
      `import { execFile } from "node:child_process"; export const r = execFile;`,
      "no-restricted-imports",
    ],
    [
      "src/domain/probe.ts",
      `import { DatabaseSync } from "node:sqlite"; export const d = DatabaseSync;`,
      "no-restricted-imports",
    ],
    [
      "src/domain/probe.ts",
      `import { request } from "node:https"; export const r = request;`,
      "no-restricted-imports",
    ],
    [
      "src/domain/probe.ts",
      `import { McpServer } from "@modelcontextprotocol/server"; export const s = McpServer;`,
      "no-restricted-imports",
    ],
    [
      "src/domain/probe.ts",
      `import type { X } from "@modelcontextprotocol/core"; export type Y = X;`,
      "no-restricted-imports",
    ],
    [
      "src/domain/probe.ts",
      `export const f = () => fetch("https://example.com");`,
      "no-restricted-globals",
    ],
    ["src/domain/probe.ts", `export const r = Math.random();`, "no-restricted-properties"],
    ["src/domain/probe.ts", `export const t = Date.now();`, "no-restricted-properties"],
    [
      "src/mcp/probe.ts",
      `import { writeFileSync } from "node:fs"; export const w = writeFileSync;`,
      "no-restricted-imports",
    ],
    [
      "src/mcp/probe.ts",
      `export const f = () => globalThis.fetch("https://example.com");`,
      "no-restricted-properties",
    ],
    [
      "src/mcp/probe.ts",
      `export const w = () => process.stdout.write("x");`,
      "no-restricted-properties",
    ],
    ["src/domain/probe.ts", `console.log("x");`, "no-console"],
    ["src/store/probe.ts", `console.error("x");`, "no-console"],
  ];
  it.each(cases)("%s: %s -> %s", async (file, code, rule) => {
    expect(rules(await lint(file, code))).toContain(rule);
  });

  it("src/domain/clock.ts is the one sanctioned reader of time and entropy", async () => {
    const code = `export const now = () => Date.now();\nexport const rnd = () => Math.random();\n`;
    expect(boundaryHits(await lint("src/domain/clock.ts", code))).toEqual([]);
  });

  it("allows console and process.stdout in the CLI layer and in tests", async () => {
    expect(
      boundaryHits(await lint("src/cli/probe.ts", `console.log("x"); process.stdout.write("y");`)),
    ).toEqual([]);
    expect(boundaryHits(await lint("src/cli.ts", `console.log("x");`))).toEqual([]);
    expect(boundaryHits(await lint("tests/probe.test.ts", `console.log("x");`))).toEqual([]);
  });

  it("allows fs in the store, sources and auth layers", async () => {
    const code = `import { readFileSync } from "node:fs"; export const r = readFileSync;`;
    for (const f of ["src/store/probe.ts", "src/sources/probe.ts", "src/auth/file.ts"]) {
      expect(boundaryHits(await lint(f, code)), f).toEqual([]);
    }
  });
});

describe("child_process / eval bans apply everywhere, including the CLI and scripts", () => {
  const banned: [string, string][] = [
    [`import { exec } from "node:child_process"; export const e = exec;`, "no-restricted-imports"],
    [
      `import { execSync as run } from "child_process"; export const e = run;`,
      "no-restricted-imports",
    ],
    [`import * as cp from "node:child_process"; export const e = cp;`, "no-restricted-syntax"],
    [`import cp from "child_process"; export const e = cp;`, "no-restricted-syntax"],
    [`export const m = () => import("node:child_process");`, "no-restricted-syntax"],
    [`declare const cp: { execSync(c: string): void }; cp.execSync("ls");`, "no-restricted-syntax"],
    [`declare function exec(c: string): void; exec("ls");`, "no-restricted-syntax"],
    [
      `import { spawn } from "node:child_process"; spawn("ls", [], { shell: true });`,
      "no-restricted-syntax",
    ],
    [
      `import { spawn } from "node:child_process"; spawn("ls", [], { shell: "/bin/sh" });`,
      "no-restricted-syntax",
    ],
    [`export const v = eval("1 + 1");`, "no-eval"],
    [`export const f = new Function("return 1");`, "no-new-func"],
    [
      `import { runInThisContext } from "node:vm"; export const r = runInThisContext;`,
      "no-restricted-imports",
    ],
  ];
  for (const file of ["src/cli/probe.ts", "src/sources/probe.ts", "scripts/probe.mjs"]) {
    it.each(banned)(`${file}: %s -> %s`, async (code, rule) => {
      // type-only syntax cannot appear in a .mjs file
      if (file.endsWith(".mjs") && /declare |: \{/.test(code)) return;
      expect(rules(await lint(file, code))).toContain(rule);
    });
  }

  it("allows argument-array execFile/spawn with shell: false, and RegExp#exec", async () => {
    const code = `import { execFile, spawn } from "node:child_process";\nexecFile("ls", ["-l"], () => undefined);\nspawn("ls", ["-l"], { shell: false });\nexport const m = /a/.exec("a");\n`;
    expect(boundaryHits(await lint("src/cli/probe.ts", code))).toEqual([]);
  });
});

describe("layerOf", () => {
  it.each([
    ["src/domain/x.ts", "domain"],
    ["src/cli.ts", "cli-entry"],
    ["src/cli/x.ts", "cli"],
    ["src/version.ts", "root"],
    ["src/providers/espn/views/mTeam.ts", "providers"],
    ["src/drift/x.ts", "drift"],
    ["tests/x.ts", null],
    ["srcx/y.ts", null],
    ["../src/domain/x.ts", null],
  ])("%s -> %s", (rel, layer) => {
    expect(layerOf(rel)).toBe(layer);
  });
});

// import-x/no-restricted-paths resolves through the filesystem, so it is exercised on a real
// temporary tree with the same zone table; it also pins WHY the lexical rule exists.
describe("import-x/no-restricted-paths on a real tree (same zone table)", () => {
  let tmp: { dir: string; cleanup: () => void };
  let linter: ESLint;
  beforeAll(() => {
    tmp = tempDir();
    writeTree(tmp.dir, {
      "src/auth/store.ts": "export const x = 1;\n",
      "src/providers/espn/views/mTeam.ts": "export const S = 1;\n",
      "src/domain/league/model.ts": "export const m = 1;\n",
      "src/version.ts": 'export const VERSION = "0.0.0";\n',
    });
    linter = new ESLint({
      cwd: tmp.dir,
      overrideConfigFile: path.join(ROOT, "eslint.config.js"),
      overrideConfig: [
        ...noTypes,
        {
          files: ["**/*.ts"],
          rules: {
            "import-x/no-restricted-paths": [
              "error",
              { basePath: tmp.dir, zones: boundaryZones() },
            ],
            "eff/layer-boundaries": ["error", { root: tmp.dir }],
          },
        },
      ],
    });
  });
  afterAll(() => {
    tmp.cleanup();
  });

  const lintTmp = async (rel: string, code: string) => {
    const [r] = await linter.lintText(code, { filePath: path.join(tmp.dir, rel) });
    return rules(r?.messages ?? []);
  };

  it("fires on a domain -> auth import whose .js specifier resolves to a .ts file", async () => {
    const hit = await lintTmp(
      "src/domain/probe.ts",
      `import { x } from "../auth/store.js";\nexport const y = x;\n`,
    );
    expect(hit).toContain("import-x/no-restricted-paths");
    expect(hit).toContain("eff/layer-boundaries");
  });

  it("fires on an mcp -> views import (the views zone)", async () => {
    const hit = await lintTmp(
      "src/mcp/probe.ts",
      `import { S } from "../providers/espn/views/mTeam.js";\nexport const y = S;\n`,
    );
    expect(hit).toContain("import-x/no-restricted-paths");
    expect(hit).toContain("eff/layer-boundaries");
  });

  it("stays quiet on legal imports", async () => {
    const hit = await lintTmp(
      "src/domain/probe.ts",
      `import { m } from "./league/model.js";\nimport { VERSION } from "../version.js";\nexport const y = [m, VERSION];\n`,
    );
    expect(hit).not.toContain("import-x/no-restricted-paths");
    expect(hit).not.toContain("eff/layer-boundaries");
  });

  it("silently skips an unresolvable target — the lexical rule still fires", async () => {
    const hit = await lintTmp(
      "src/domain/probe.ts",
      `import { x } from "../auth/missing.js";\nexport const y = x;\n`,
    );
    expect(hit).not.toContain("import-x/no-restricted-paths");
    expect(hit).toContain("eff/layer-boundaries");
  });

  it("zone table: every zone has targets and sources under src/", () => {
    for (const z of boundaryZones()) {
      expect(z.target.length).toBeGreaterThan(0);
      expect(z.from.length).toBeGreaterThan(0);
      expect(z.from.every((f) => f.startsWith("./src/"))).toBe(true);
    }
  });
});
