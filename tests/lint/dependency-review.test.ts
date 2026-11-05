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
// 3. The changelog's "Reviews" table — one GitHub table, its rows contiguous after its header (a blank
//    line ends a table, and rows after it render as a paragraph) — reviews every dependency it names
//    at the version the lockfile pins, with a passing verdict — so a bump without its review row
//    fails — and it names the SDK (server, core and the dev client, one version) and zod as well as
//    the keyring. A "Declined" row records a version evaluated and not taken: the lockfile may pin
//    it only once a passing row reviews it.
// 4. The majors declined on 2026-11-04 (Dependabot PRs 4 and 5) stay declined until their re-check
//    trigger: .github/dependabot.yml ignores @types/node's semver-major updates (its major is held to
//    the runtime's) and typescript's declined major only (a later major is proposed again).
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
  /** The dependency cell as written (the names it lists besides its `name@version` tokens). */
  dependency: string;
  deps: { name: string; version: string }[];
  verdict: string;
  evidence: string;
  /** The open-item cell (for a Declined row, its re-check trigger). */
  open: string;
  /** A version evaluated and not taken (verdict `**Declined…`). */
  declined: boolean;
}

const DEP_TOKEN = /`((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)@(\d+\.\d+\.\d+(?:-[\w.]+)?)`/gi;

const REVIEWS_HEADER = ["date", "dependency", "verdict", "evidence", "open item"];

/**
 * The rows of the `## Reviews` table (header and separator dropped). Throws when the section or its
 * header is missing, when a row comes before the header or its separator, and when a `|` line
 * follows the table's end: a GitHub table ends at its first non-table line, so a row after a blank
 * line renders as a paragraph, not as a row (2026-11-04 dependency-review finding RG-1).
 */
function reviewRows(changelog: string): ReviewRow[] {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((l) => /^## Reviews\b/.test(l));
  if (start === -1) throw new Error("docs/plan/changelog.md has no `## Reviews` section");
  const rows: ReviewRow[] = [];
  let seen = 0; // table lines read: the header, the separator, then the rows
  let ended = false;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2} /.test(line)) break;
    if (!line.startsWith("|")) {
      if (seen > 0) ended = true;
      continue;
    }
    if (ended)
      throw new Error(
        `a Reviews row after the table ended (a blank or text line splits it): ${line.slice(0, 80)}`,
      );
    // cells split on unescaped pipes (a cell may quote a regex with `\|`)
    const cells = line
      .split(/(?<!\\)\|/)
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length !== 5)
      throw new Error(`a Reviews row without five cells: ${line.slice(0, 80)}`);
    seen++;
    if (seen === 1) {
      if (cells.join("|") !== REVIEWS_HEADER.join("|"))
        throw new Error(`the Reviews table does not start with its header: ${line.slice(0, 80)}`);
      continue;
    }
    if (seen === 2) {
      if (!cells.every((c) => /^:?-+:?$/.test(c)))
        throw new Error(
          `the Reviews header is not followed by its separator: ${line.slice(0, 80)}`,
        );
      continue;
    }
    const [date = "", dependency = "", verdict = "", evidence = "", open = ""] = cells;
    const deps = [...dependency.matchAll(DEP_TOKEN)].map((m) => ({
      name: m[1] ?? "",
      version: m[2] ?? "",
    }));
    rows.push({
      date,
      dependency,
      deps,
      verdict,
      evidence,
      open,
      declined: /^\*\*Declined\b/.test(verdict),
    });
  }
  if (seen < 2) throw new Error("the Reviews section has no table (header and separator)");
  return rows;
}

describe("reviewRows reads the Reviews table as GitHub renders it", () => {
  const HEAD =
    "## Reviews\n\n| date | dependency | verdict | evidence | open item |\n|---|---|---|---|---|";
  const row = (d: string, v = "**Safe — pin exact**") => `| ${d} | \`x@1.0.0\` | ${v} | e | — |`;

  it("reads contiguous rows, up to the next section", () => {
    const rows = reviewRows(
      `${HEAD}\n${row("2026-01-01")}\n${row("2026-01-02", "**Declined — no**")}\n\n## Next\n| a | b | c | d | e |`,
    );
    expect(rows.map((r) => [r.date, r.declined])).toEqual([
      ["2026-01-01", false],
      ["2026-01-02", true],
    ]);
  });

  it("throws on a row after a blank line (it would render as a paragraph)", () => {
    expect(() => reviewRows(`${HEAD}\n${row("2026-01-01")}\n\n${row("2026-01-02")}`)).toThrow(
      /after the table ended/,
    );
    expect(() => reviewRows(`${HEAD}\n${row("2026-01-01")}\nprose\n${row("2026-01-02")}`)).toThrow(
      /after the table ended/,
    );
  });

  it("throws on a table without its header or separator, and on a section without a table", () => {
    expect(() => reviewRows(`## Reviews\n\n${row("2026-01-01")}`)).toThrow(/header/);
    expect(() =>
      reviewRows(
        `## Reviews\n\n| date | dependency | verdict | evidence | open item |\n${row("2026-01-01")}`,
      ),
    ).toThrow(/separator/);
    expect(() => reviewRows("## Reviews\n\nnone yet\n")).toThrow(/no table/);
    expect(() => reviewRows("## Other\n")).toThrow(/no `## Reviews` section/);
  });
});

describe("the changelog's Reviews table (plan 02 §7.2: re-run on every version bump)", () => {
  const all = reviewRows(read("docs/plan/changelog.md"));
  const rows = all.filter((r) => !r.declined);
  const declined = all.filter((r) => r.declined);
  const named = [...new Set(rows.flatMap((r) => r.deps.map((d) => d.name)))].sort();
  const SDK = [
    "@modelcontextprotocol/server",
    "@modelcontextprotocol/core",
    "@modelcontextprotocol/client",
  ];

  it("every row names at least one exact `name@version` and is dated", () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const r of all) {
      expect(r.deps.length, r.date).toBeGreaterThan(0);
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.evidence.length, r.date).toBeGreaterThan(0);
    }
  });

  it("names the SDK (server, core, client), zod, the keyring and hyparquet", () => {
    for (const name of [...SDK, "zod", "@napi-rs/keyring", "hyparquet"])
      expect(named, name).toContain(name);
  });

  it("reviews the keyring together with every one of its platform packages, at the keyring's pin", () => {
    const pin = pkg.dependencies?.["@napi-rs/keyring"];
    const platforms = Object.keys(
      (lock.packages["node_modules/@napi-rs/keyring"] as { optionalDependencies?: object })
        .optionalDependencies ?? {},
    );
    expect(platforms).toHaveLength(12);
    const row = rows.find((r) =>
      r.deps.some((d) => d.name === "@napi-rs/keyring" && d.version === pin),
    );
    expect(row, `a Reviews row for @napi-rs/keyring@${String(pin)}`).toBeDefined();
    for (const name of platforms) {
      expect(lock.packages[`node_modules/${name}`]?.version, name).toBe(pin);
      expect(row?.dependency, name).toContain(name.replace("@napi-rs/keyring-", ""));
    }
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

  it("a Declined row names its re-check trigger, and its version is pinned only once a passing row reviews it", () => {
    for (const r of declined) {
      expect(r.open, r.date).not.toMatch(/^(—|-|)$/);
      for (const d of r.deps) {
        if (lock.packages[`node_modules/${d.name}`]?.version !== d.version) continue;
        const reviewed = rows.some((x) =>
          x.deps.some((y) => y.name === d.name && y.version === d.version),
        );
        expect(reviewed, `${d.name}@${d.version} is pinned but was declined`).toBe(true);
      }
    }
  });

  it("records the two majors declined on 2026-11-04 (Dependabot PRs 4 and 5)", () => {
    const ids = declined.flatMap((r) => r.deps.map((d) => `${d.name}@${d.version}`));
    expect(ids).toEqual(expect.arrayContaining(["@types/node@26.6.5", "typescript@7.0.2"]));
  });

  it("reviews the SDK's three packages together, at the server's pin", () => {
    const pin = pkg.dependencies?.["@modelcontextprotocol/server"];
    const row = rows.find((r) =>
      SDK.every((name) => r.deps.some((d) => d.name === name && d.version === pin)),
    );
    expect(row, `one Reviews row for the SDK at ${String(pin)}`).toBeDefined();
  });
});

// --- majors declined on review (2026-11-04, Dependabot PRs 4 and 5) -----------------------------

describe("the declined majors stay declined until their re-check trigger (.github/dependabot.yml)", () => {
  const dependabot = read(".github/dependabot.yml");
  const major = (v: string | undefined): number => Number(/^v?(\d+)\./.exec(v ?? "")?.[1]);

  const npm = dependabot.slice(dependabot.indexOf('package-ecosystem: "npm"'));
  /** The ignore rule for `name` in the npm ecosystem: its dependency-name line and the lines under it. */
  const rule = (name: string): string => {
    const at = npm.indexOf(`- dependency-name: "${name}"\n`);
    if (at === -1) return "";
    const lines = npm.slice(at).split("\n");
    const body = lines
      .slice(1)
      .filter((_, i, a) => a.slice(0, i + 1).every((l) => /^ {8}\S/.test(l)));
    return [lines[0], ...body].join("\n");
  };
  const declinedMajor = (name: string): number => {
    const rows = reviewRows(read("docs/plan/changelog.md")).filter((r) => r.declined);
    const v = rows.flatMap((r) => r.deps).find((d) => d.name === name)?.version;
    return major(v);
  };

  it("ignores every semver-major update of @types/node (its major is held to the runtime's below)", () => {
    expect(npm.length).toBeLessThan(dependabot.length);
    expect(rule("@types/node")).toBe(
      '- dependency-name: "@types/node"\n        update-types: ["version-update:semver-major"]',
    );
  });

  it("ignores only typescript's declined major, so a later major is proposed and evaluated again", () => {
    const m = declinedMajor("typescript");
    expect(m).toBe(7);
    expect(rule("typescript")).toBe(
      `- dependency-name: "typescript"\n        versions: ["${String(m)}.x"]`,
    );
    expect(major(pkg.devDependencies?.typescript)).toBeLessThan(m);
  });

  it("@types/node's declined major is above the runtime's", () => {
    expect(declinedMajor("@types/node")).toBeGreaterThan(major(read(".nvmrc").trim()));
  });

  it("@types/node's major is the runtime's (.nvmrc), so tsc never accepts an API Node lacks", () => {
    const runtime = major(read(".nvmrc").trim());
    expect(runtime).toBeGreaterThanOrEqual(24);
    expect(major(pkg.devDependencies?.["@types/node"])).toBe(runtime);
    expect(major(lock.packages["node_modules/@types/node"]?.version)).toBe(runtime);
  });

  it("typescript stays inside typescript-eslint's supported peer range (the lint gate's parser)", () => {
    const peer = (
      lock.packages["node_modules/@typescript-eslint/typescript-estree"] as {
        peerDependencies?: Record<string, string>;
      }
    ).peerDependencies?.typescript;
    const ts = lock.packages["node_modules/typescript"]?.version ?? "";
    const m = /^>=(\S+?)\s*<(\S+)$/.exec(peer ?? "");
    expect(m, `typescript-estree's typescript peer range: ${String(peer)}`).not.toBeNull();
    expect(compareVersions(ts, m?.[1] ?? "")).toBeGreaterThanOrEqual(0);
    expect(compareVersions(ts, m?.[2] ?? "")).toBeLessThan(0);
  });
});
