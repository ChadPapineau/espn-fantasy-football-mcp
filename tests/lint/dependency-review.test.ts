// dependency-review.test.ts — the supply-chain gate's records, held offline by the unit suite (plan 02
// §7.1 "Audit gate" and "Update policy", §7.2 "re-run on every version bump"; plan 04 §2, §4.1
// `supply-chain`; Stage C finding deps-mcp-sdk-advisory-2-3-1).
//
// 1. No package in the committed lockfile, at any depth, sits in the version range of an advisory
//    that turned `npm audit --omit=dev --audit-level=high` red (or that the full report raised
//    against a direct dev dependency). A downgrade, a revert of the bump or a hand-edited lockfile
//    then fails here, offline, not only in CI's network audit. The ranges are the GitHub advisory
//    database's (read 2026-10-25). The list only grows: an advisory stays true of the versions it
//    names.
// 2. The installed zod has the fix GHSA-mrhx-c7xc-m3w5 names, on this server's own input schemas:
//    an over-long id list is refused on its size alone (zod ≤ 4.6.5 parsed every element first and
//    kept an issue per failing one — 100,001 issues for the list below).
// 3. The changelog's "Reviews" table reviews every dependency it names at the version the lockfile
//    pins, with a passing verdict — so a bump without its review row fails — and it names the SDK
//    (server, core and the dev client, one version) and zod as well as the keyring.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { playerIdsSchema } from "../../src/mcp/bounds.js";
import { ROOT } from "./helpers.js";

interface LockEntry {
  version?: string;
  dependencies?: Record<string, string>;
}
interface Lock {
  packages: Record<string, LockEntry>;
}
interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const lock = JSON.parse(read("package-lock.json")) as Lock;
const pkg = JSON.parse(read("package.json")) as Manifest;
const direct = { ...pkg.dependencies, ...pkg.devDependencies };

// --- semver precedence (semver 2.0.0 §11), exact versions only ---------------------------------

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** -1, 0 or 1 as `a` has lower, equal or higher precedence than `b`; throws on a non-version. */
function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) throw new Error(`not an exact semver version: ${!pa ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return Math.sign(d);
  }
  const ra = pa[4];
  const rb = pb[4];
  // a pre-release ranks below its release
  if (ra === undefined || rb === undefined) return ra === rb ? 0 : ra === undefined ? 1 : -1;
  const ia = ra.split(".");
  const ib = rb.split(".");
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const x = ia[i];
    const y = ib[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return Math.sign(d);
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** An advisory's affected range for one package: `introduced` ≤ version < `fixed`. */
interface Advisory {
  id: string;
  pkg: string;
  introduced: string;
  fixed: string;
  severity: "critical" | "high" | "moderate" | "low";
}

/** True when `version` is affected (a pre-release of `fixed` counts as affected: conservative). */
function affected(version: string, adv: Advisory): boolean {
  return compareVersions(version, adv.introduced) >= 0 && compareVersions(version, adv.fixed) < 0;
}

/**
 * The advisories behind the red `supply-chain` job of 2026-10-21..25, as the GitHub advisory
 * database states them. The SDK's three are HTTP-transport and bearer-auth code this stdio server
 * never runs; zod's is in the validator every tool, resource and prompt argument goes through.
 */
const GATE_ADVISORIES: readonly Advisory[] = Object.freeze([
  {
    id: "GHSA-jm63-cq47-j5jp",
    pkg: "@modelcontextprotocol/server",
    introduced: "2.0.0",
    fixed: "2.3.0",
    severity: "high",
  },
  {
    id: "GHSA-46jr-4wx8-v453",
    pkg: "@modelcontextprotocol/server",
    introduced: "2.0.0",
    fixed: "2.3.0",
    severity: "high",
  },
  {
    id: "GHSA-rvq5-wwqv-78pq",
    pkg: "@modelcontextprotocol/server",
    introduced: "2.0.0",
    fixed: "2.3.0",
    severity: "moderate",
  },
  {
    id: "GHSA-6prh-2h8m-c8cw",
    pkg: "@modelcontextprotocol/client",
    introduced: "2.0.0",
    fixed: "2.3.0",
    severity: "moderate",
  },
  { id: "GHSA-mrhx-c7xc-m3w5", pkg: "zod", introduced: "0.0.0", fixed: "4.6.6", severity: "high" },
]);

/** The advisory with this id (the table above), or a thrown error. */
function advisory(id: string): Advisory {
  const adv = GATE_ADVISORIES.find((a) => a.id === id);
  if (adv === undefined) throw new Error(`no advisory ${id}`);
  return adv;
}

/** Every `[lockfile key, version]` of `name`, at any depth of the tree. */
function locked(name: string): [string, string][] {
  return Object.entries(lock.packages)
    .filter(([k]) => k === `node_modules/${name}` || k.endsWith(`/node_modules/${name}`))
    .map(([k, v]) => [k, v.version ?? ""]);
}

describe("semver precedence (the range check's own arithmetic)", () => {
  it.each([
    ["2.2.0", "2.3.0", -1],
    ["2.3.0", "2.3.0", 0],
    ["2.3.1", "2.3.0", 1],
    ["2.10.0", "2.9.9", 1],
    ["10.0.0", "9.99.99", 1],
    ["2.3.0-beta.1", "2.3.0", -1],
    ["2.3.0-alpha", "2.3.0-alpha.1", -1],
    ["2.3.0-alpha.1", "2.3.0-alpha.beta", -1],
    ["2.3.0-beta.2", "2.3.0-beta.11", -1],
    ["2.3.0-rc.1", "2.3.0-beta.11", 1],
  ])("%s vs %s → %i", (a, b, want) => {
    expect(compareVersions(a, b)).toBe(want);
    expect(compareVersions(b, a)).toBe(-want || 0);
  });

  it("refuses a range or a tag instead of guessing", () => {
    for (const bad of ["^2.3.1", "2.3", "latest", "v2.3.1", "2.3.1 ", ""]) {
      expect(() => compareVersions(bad, "1.0.0"), bad).toThrow(/not an exact semver/);
    }
  });
});

describe("no locked package is in the range of an advisory that failed the supply-chain gate", () => {
  it("the check is not vacuous: the versions the advisories were filed against are affected", () => {
    const server = advisory("GHSA-jm63-cq47-j5jp");
    const client = advisory("GHSA-6prh-2h8m-c8cw");
    const zod = advisory("GHSA-mrhx-c7xc-m3w5");
    expect(affected("2.2.0", server)).toBe(true);
    expect(affected("2.0.0", server)).toBe(true);
    expect(affected("2.3.0-beta.1", server)).toBe(true);
    expect(affected("2.3.0", server)).toBe(false);
    expect(affected("1.31.0", server)).toBe(false);
    expect(affected("2.2.0", client)).toBe(true);
    expect(affected("4.6.5", zod)).toBe(true);
    expect(affected("3.25.76", zod)).toBe(true);
    expect(affected("4.6.6", zod)).toBe(false);
  });

  it.each(GATE_ADVISORIES.map((a) => [a.id, a.pkg, a.fixed, a] as const))(
    "%s: no %s below %s",
    (_id, name, _fixed, adv) => {
      const entries = locked(name);
      // a direct dependency must be found, or the check would pass on a renamed key
      if (name in direct) expect(entries.length, `${name} in package-lock.json`).toBeGreaterThan(0);
      for (const [key, version] of entries) {
        expect(affected(version, adv), `${key}@${version} is affected by ${adv.id}`).toBe(false);
      }
    },
  );
});

describe("the installed zod refuses an over-long input on its size alone (GHSA-mrhx-c7xc-m3w5)", () => {
  it("an id list far over its bound gets one too_big issue, no per-element work", () => {
    const huge = Array.from({ length: 100_000 }, () => "x");
    const r = playerIdsSchema.safeParse(huge);
    expect(r.success).toBe(false);
    // zod ≤ 4.6.5: 100,000 invalid_type issues, then the too_big one
    expect(r.error?.issues.map((i) => i.code)).toEqual(["too_big"]);
  });

  it("a list within its bound is still checked element by element (positive control)", () => {
    const r = playerIdsSchema.safeParse(["x", "y"]);
    expect(r.success).toBe(false);
    const paths = (r.error?.issues ?? []).map((i) => JSON.stringify(i.path));
    expect(paths).toContain("[0]");
    expect(paths).toContain("[1]");
    expect(r.error?.issues.some((i) => i.code === "too_big")).toBe(false);
  });
});

// --- the changelog's "Reviews" table --------------------------------------------------------------

interface ReviewRow {
  date: string;
  deps: { name: string; version: string }[];
  verdict: string;
  evidence: string;
}

const DEP_TOKEN = /`((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)@(\d+\.\d+\.\d+(?:-[\w.]+)?)`/gi;

/** The rows of the `## Reviews` table (header and separator dropped); throws when it is missing. */
function reviewRows(changelog: string): ReviewRow[] {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((l) => /^## Reviews\b/.test(l));
  if (start === -1) throw new Error("docs/plan/changelog.md has no `## Reviews` section");
  const rows: ReviewRow[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2} /.test(line)) break;
    if (!line.startsWith("|")) continue;
    // cells split on unescaped pipes (a cell may quote a regex with `\|`)
    const cells = line
      .split(/(?<!\\)\|/)
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length !== 5)
      throw new Error(`a Reviews row without five cells: ${line.slice(0, 80)}`);
    const [date = "", dependency = "", verdict = "", evidence = ""] = cells;
    if (date === "date" || /^-+$/.test(date)) continue;
    const deps = [...dependency.matchAll(DEP_TOKEN)].map((m) => ({
      name: m[1] ?? "",
      version: m[2] ?? "",
    }));
    rows.push({ date, deps, verdict, evidence });
  }
  return rows;
}

describe("the changelog's Reviews table (plan 02 §7.2: re-run on every version bump)", () => {
  const rows = reviewRows(read("docs/plan/changelog.md"));
  const named = [...new Set(rows.flatMap((r) => r.deps.map((d) => d.name)))].sort();
  const SDK = [
    "@modelcontextprotocol/server",
    "@modelcontextprotocol/core",
    "@modelcontextprotocol/client",
  ];

  it("every row names at least one exact `name@version` and is dated", () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.deps.length, r.date).toBeGreaterThan(0);
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.evidence.length, r.date).toBeGreaterThan(0);
    }
  });

  it("names the SDK (server, core, client), zod and the keyring", () => {
    for (const name of [...SDK, "zod", "@napi-rs/keyring"]) expect(named, name).toContain(name);
  });

  it("reviews every named dependency at the version the lockfile pins, with a passing verdict", () => {
    for (const name of named) {
      const version = lock.packages[`node_modules/${name}`]?.version;
      expect(version, `${name} in package-lock.json`).toBeTypeOf("string");
      const row = rows.find((r) => r.deps.some((d) => d.name === name && d.version === version));
      expect(row, `a Reviews row for ${name}@${String(version)}`).toBeDefined();
      expect(row?.verdict, `${name}@${String(version)}`).toMatch(/^\*\*Safe\b/);
    }
  });

  it("reviews the SDK's three packages together, at the server's pin", () => {
    const pin = pkg.dependencies?.["@modelcontextprotocol/server"];
    const row = rows.find((r) =>
      SDK.every((name) => r.deps.some((d) => d.name === name && d.version === pin)),
    );
    expect(row, `one Reviews row for the SDK at ${String(pin)}`).toBeDefined();
  });
});
