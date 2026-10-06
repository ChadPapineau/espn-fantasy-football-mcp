// package.test.ts — scaffold invariants that must never silently drift: exact pins, the four runtime
// dependencies and the one zod, the runtime allow-list, no lifecycle scripts, .npmrc/.nvmrc, and one
// version across package.json, src/version.ts and the plugin manifests (plan 04 §1, §2, R11; plan 02
// §7; plan 09 K6; plan 10 §3.0 Z3). Ported from sibling @d72e03b, adapted.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseAllowlist } from "../../scripts/ci/check-runtime-tree.mjs";
import { classify, REQUIRED } from "../../scripts/ci/scan-tarball.mjs";
import { VERSION } from "../../src/version.js";
import { ROOT } from "./helpers.js";

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  type?: string;
  license?: string;
  bin?: Record<string, string>;
  files?: string[];
  engines?: Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
interface LockEntry {
  version?: string;
  dev?: boolean;
  devOptional?: boolean;
  optional?: boolean;
  hasInstallScript?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}
interface Lock {
  lockfileVersion: number;
  packages: Record<string, LockEntry>;
}

const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const pkg = JSON.parse(read("package.json")) as Manifest;
const lock = JSON.parse(read("package-lock.json")) as Lock;
const EXACT = /^\d+\.\d+\.\d+$/;
const RUNTIME = ["@modelcontextprotocol/server", "@napi-rs/keyring", "hyparquet", "zod"];

describe("package.json", () => {
  it("is private, ESM, MIT, with the planned name/bin/engines/files (plan 04 §2)", () => {
    expect(pkg.name).toBe("espn-fantasy-football-mcp");
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe("module");
    expect(pkg.license).toBe("MIT");
    expect(pkg.bin).toEqual({ eff: "dist/cli.js" });
    expect(pkg.engines).toEqual({ node: ">=24.15" });
    expect(pkg.files).toEqual([
      "dist",
      "scripts/eff-launch.sh",
      "skills",
      ".claude-plugin",
      ".mcp.json",
      "README.md",
      "LICENSE",
      "CHANGELOG.md",
    ]);
    // every plugin-root file a tarball install needs is covered by `files`
    for (const f of REQUIRED) expect(classify(f, pkg.files ?? []), f).toBeNull();
  });

  it("pins every dependency to an exact version (no ^ ~ * x ranges, tags, urls)", () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(all).length).toBeGreaterThan(0);
    for (const [name, spec] of Object.entries(all)) expect(spec, `${name}@${spec}`).toMatch(EXACT);
  });

  it("has exactly the four planned runtime dependencies at the plan 04 §2 versions", () => {
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(RUNTIME);
    expect(pkg.dependencies?.["@modelcontextprotocol/server"]).toBe("2.2.0");
    expect(pkg.dependencies?.hyparquet).toBe("1.31.2");
    expect(pkg.dependencies?.["@napi-rs/keyring"]).toBe("2.1.0");
  });

  it("never carries the sibling's yaml or fast-xml-parser, anywhere in the tree", () => {
    const everywhere = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(lock.packages),
    ];
    expect(everywhere.some((k) => /(^|\/)(yaml|fast-xml-parser)$/.test(k))).toBe(false);
  });

  it("pins zod to the one version the SDK resolves (a single zod in the whole tree)", () => {
    const zods = Object.entries(lock.packages).filter(([k]) => /(^|\/)node_modules\/zod$/.test(k));
    expect(zods).toHaveLength(1);
    expect(zods[0]?.[1].version).toBe(pkg.dependencies?.zod);
    expect(pkg.dependencies?.zod).toMatch(/^4\./);
    const sdkRange = lock.packages["node_modules/@modelcontextprotocol/server"]?.dependencies?.zod;
    expect(sdkRange).toMatch(/^\^4\./);
  });

  it("pins the MCP client (dev, for the in-memory gate tests) to the server SDK's version", () => {
    expect(pkg.devDependencies?.["@modelcontextprotocol/client"]).toBe(
      pkg.dependencies?.["@modelcontextprotocol/server"],
    );
    expect(pkg.devDependencies?.["@types/node"]).toMatch(/^24\./);
  });

  it("the lockfile agrees with package.json for every direct dependency", () => {
    expect(lock.lockfileVersion).toBe(3);
    for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(lock.packages[`node_modules/${name}`]?.version, name).toBe(spec);
    }
  });

  it("no runtime lockfile entry has an install script (dev-only ones never run: ignore-scripts)", () => {
    const runtime = Object.entries(lock.packages).filter(
      ([k, v]) => k !== "" && v.dev !== true && v.devOptional !== true,
    );
    expect(runtime.filter(([, v]) => v.hasInstallScript === true).map(([k]) => k)).toEqual([]);
  });

  it("defines no lifecycle script that npm would run on install or pack", () => {
    for (const s of [
      "preinstall",
      "install",
      "postinstall",
      "prepare",
      "prepack",
      "postpack",
      "prepublishOnly",
      "prepublish",
    ]) {
      expect(pkg.scripts?.[s], s).toBeUndefined();
    }
  });

  it("`npm test` and coverage run the unit project; process suites are their own script", () => {
    expect(pkg.scripts?.test).toBe("vitest run --project unit");
    expect(pkg.scripts?.["test:coverage"]).toBe("vitest run --project unit --coverage");
    expect(pkg.scripts?.["test:process"]).toBe("vitest run --project process --passWithNoTests");
  });

  it("the Skills scripts run the dependency-free tooling (plan 09 §4, §5.1)", () => {
    expect(pkg.scripts?.["build:skills"]).toBe("node scripts/skills/build-skills.mjs");
    expect(pkg.scripts?.["check:skills"]).toBe("node scripts/skills/check-skills.mjs");
    // the copy-install tree is the plan 09 §4 path; `npm run build` (tsc) never writes it
    expect(pkg.scripts?.["build:skills:copy"]).toBe(
      "node scripts/skills/build-skills.mjs --copy-out dist/skills-copy",
    );
    expect(pkg.scripts?.build).toBe("tsc -p tsconfig.build.json");
  });

  it("defines the scaffold scripts", () => {
    for (const s of [
      "build",
      "typecheck",
      "lint",
      "format",
      "format:check",
      "test",
      "test:coverage",
      "test:process",
      "check:no-scripts",
      "check:licenses",
      "check:runtime-tree",
      "check:coverage",
      "check:links",
      "check:skills-structure",
      "build:skills",
      "build:skills:copy",
      "check:skills",
      "pack:scan",
      "scan:secrets",
      "eff",
      "doctor",
    ]) {
      expect(pkg.scripts?.[s], s).toBeTypeOf("string");
    }
  });
});

describe("the runtime allow-list (plan 04 §2, §4.1)", () => {
  const allow = parseAllowlist(JSON.parse(read("scripts/ci/runtime-allowlist.json")) as unknown);

  it("lists every direct runtime dependency at its pinned version", () => {
    for (const name of RUNTIME) {
      expect(allow.packages, name).toContain(`${name}@${pkg.dependencies?.[name] ?? "?"}`);
    }
    expect(allow.packages).toContain("@modelcontextprotocol/core@2.2.0");
  });

  it("oneOf is exactly the keyring's twelve optional platform packages, at its version", () => {
    const opt = lock.packages["node_modules/@napi-rs/keyring"]?.optionalDependencies ?? {};
    expect(Object.keys(opt)).toHaveLength(12);
    expect([...allow.oneOf].sort()).toEqual(
      Object.entries(opt)
        .map(([n, v]) => `${n}@${v}`)
        .sort(),
    );
    expect(allow.count).toBe(allow.packages.length + 1);
  });

  it("plan 04 §2 records the pinned versions and the runtime tree count", () => {
    const plan = read("docs/plan/04-repo-structure-and-ci.md");
    const section = plan.slice(plan.indexOf("## 2. Package layout"), plan.indexOf("## 3."));
    for (const name of RUNTIME) {
      expect(section, name).toContain(`\`${name}\``);
      expect(section, name).toContain(pkg.dependencies?.[name] ?? "?");
    }
    expect(section).toContain(`runtime tree: ${String(allow.count)} packages`);
  });
});

describe(".npmrc and .nvmrc", () => {
  const settings = Object.fromEntries(
    read(".npmrc")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split("=").map((s) => s.trim()) as [string, string]),
  );
  it.each([
    ["save-exact", "true"],
    ["ignore-scripts", "true"],
    ["fund", "false"],
    ["audit", "true"],
    ["engine-strict", "true"],
  ])("%s=%s", (key, value) => {
    expect(settings[key]).toBe(value);
  });

  it("sets no registry override or auth token", () => {
    expect(read(".npmrc")).not.toMatch(/registry\s*=|_authToken|_auth\b|always-auth/i);
  });

  it(".nvmrc is an exact Node version at or above the engines floor (24.15)", () => {
    const v = read(".nvmrc").trim();
    expect(v).toMatch(EXACT);
    const [major = 0, minor = 0] = v.split(".").map(Number);
    expect(major > 24 || (major === 24 && minor >= 15)).toBe(true);
  });
});

describe("one version (plan 09 K6)", () => {
  it("src/version.ts, package.json and the plugin manifests agree", () => {
    const plugin = JSON.parse(read(".claude-plugin/plugin.json")) as { version: string };
    const market = JSON.parse(read(".claude-plugin/marketplace.json")) as {
      plugins: { version?: string }[];
    };
    expect(VERSION).toBe(pkg.version);
    expect(plugin.version).toBe(pkg.version);
    expect(market.plugins[0]?.version).toBe(pkg.version);
  });
});
