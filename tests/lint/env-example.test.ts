// env-example.test.ts — `.env.example` sets nothing the server would otherwise work out for itself
// (Stage C round 3, finding docs-prebuild-markers-remain; area repo-root; plan 03 §3 "Season
// rollover: `ESPN_SEASON` unset → current season"; README "No season in a launch configuration").
// The file is a reference for the setting names with placeholder values (its header; README
// "Configuration"), and the README says a pinned ESPN_SEASON stays pinned when the next season starts
// while the eff CLI and the jobs move on — yet the file carried `ESPN_SEASON=2026` uncommented, the
// one line that modelled a pin, while the keys that are discovered or recorded (ESPN_TEAM_ID,
// EFF_CREDENTIAL_STORE) were already commented out. Nothing held the file's values. What holds now:
// 1. its uncommented lines, given as the environment, resolve to exactly the configuration the
//    defaults give, at any instant from 2018 on (fast-check) — apart from the required league id,
//    which has no default and carries the zero placeholder (never a real id: CLAUDE.md);
// 2. so a key whose default the schema states in words, because it is worked out when the process
//    runs ("the current NFL season"), is commented out;
// 3. the README's line-by-line table shows each key line exactly as the file has it.
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import type { XattrReader } from "../../src/config/paths.js";
import {
  CONFIG_KEY_SPECS,
  ConfigError,
  envExampleKeys,
  loadConfig,
  secretValues,
  type Config,
} from "../../src/config/schema.js";
import { readDoc, section, tableRows } from "./docs-helpers.js";
import { ROOT, tempDir } from "./helpers.js";

const ENV_EXAMPLE = readDoc(".env.example");
const README = readDoc("README.md");

/** A line that names a key: `KEY=value`, or commented out, `# KEY=value` (as `envExampleNames`). */
const KEY_LINE = /^(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/;

/** The values an env text sets: its uncommented `KEY=value` lines. */
function setValues(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = KEY_LINE.exec(line.trim());
    if (m !== null && m[1] === undefined) out.set(m[2] ?? "", m[3] ?? "");
  }
  return out;
}

/** A fresh install's home: no config.json, so only the environment and the defaults decide. */
const home = tempDir("eff-env-example-");
afterAll(() => {
  home.cleanup();
});
const noXattrs: XattrReader = (paths) => new Map(paths.map((p) => [p, []]));

/** The configuration `env` resolves to at `nowMs` on that install. */
const resolve = (env: Record<string, string>, nowMs: number): Config =>
  loadConfig({ env, file: undefined, home: home.dir, repoRoot: ROOT, nowMs, xattr: noXattrs });

/** The keys the loader will not start without: no default can stand in for them. */
function requiredKeys(): string[] {
  try {
    resolve({}, Date.UTC(2026, 9, 1));
    return [];
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return e.issues.filter((i) => i.reason.startsWith("is required")).map((i) => i.key);
  }
}
const REQUIRED = requiredKeys();
/** An accepted league id, standing in for each required key on both sides of a comparison. */
const STAND_IN = "0";

/** A resolved configuration as compared: every field but each value's origin, the secrets too. */
const compared = (c: Config): Record<string, unknown> => ({
  ...Object.fromEntries(Object.entries(c).filter(([k]) => k !== "origins")),
  secrets: secretValues(c),
});

/**
 * The fields in which an env text's set values change what a fresh install resolves at `nowMs`,
 * against the defaults (each required key stood in for on both sides); a value the loader refuses
 * is reported by its key.
 */
function divergence(text: string, nowMs: number): string[] {
  const stood = Object.fromEntries(REQUIRED.map((k) => [k, STAND_IN]));
  const env = Object.fromEntries([...setValues(text)].filter(([k]) => !REQUIRED.includes(k)));
  let withLines: Record<string, unknown>;
  try {
    withLines = compared(resolve({ ...env, ...stood }, nowMs));
  } catch (e) {
    if (e instanceof ConfigError) return e.issues.map((i) => i.key);
    throw e;
  }
  const defaults = compared(resolve(stood, nowMs));
  return Object.keys(defaults).filter(
    (k) => JSON.stringify(withLines[k]) !== JSON.stringify(defaults[k]),
  );
}

describe("`.env.example` sets nothing the defaults would not", () => {
  it("reads the file: the one required key, its placeholder, and what the file sets (the reader works)", () => {
    expect(REQUIRED).toEqual(["ESPN_LEAGUE_ID"]);
    const set = setValues(ENV_EXAMPLE);
    expect(set.get("ESPN_LEAGUE_ID")).toMatch(/^0+$/);
    expect(set.get("EFF_TOOLSET")).toBe("core");
    expect(setValues("A=1\n# B=2\n  C=3\n#D=\n")).toEqual(
      new Map([
        ["A", "1"],
        ["C", "3"],
      ]),
    );
  });

  it("the check can fail: a pinned season resolves another season once the next one starts", () => {
    const pinned = "ESPN_LEAGUE_ID=0000000\nESPN_SEASON=2026\n";
    expect(divergence(pinned, Date.UTC(2026, 8, 1))).toEqual([]);
    expect(divergence(pinned, Date.UTC(2027, 8, 1))).toEqual(["season"]);
    expect(divergence(pinned, Date.UTC(2025, 0, 1))).toEqual(["ESPN_SEASON"]);
    expect(divergence("EFF_TOOLSET=full\n", Date.UTC(2026, 8, 1))).toEqual(["toolset"]);
  });

  it("property: the file's set lines resolve to the defaults at any instant from 2018 on", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2018, 0, 1), max: Date.UTC(2045, 11, 31) }),
        (nowMs) => {
          expect(divergence(ENV_EXAMPLE, nowMs)).toEqual([]);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("a key whose default the schema states in words — worked out at run time — is commented out", () => {
    // a default reads as a literal value or it is prose (scripts/gen-config-docs.ts defaultCell)
    const computed = CONFIG_KEY_SPECS.filter(
      (s) =>
        envExampleKeys().includes(s.key) &&
        s.default !== null &&
        !/^[\w.<>/~:@-]+$/.test(s.default),
    ).map((s) => s.key);
    expect(computed).toContain("ESPN_SEASON");
    const set = setValues(ENV_EXAMPLE);
    expect(computed.filter((k) => set.has(k))).toEqual([]);
  });

  it("the README's line-by-line table shows each key line exactly as the file has it", () => {
    const lines = ENV_EXAMPLE.split("\n")
      .map((l) => l.trim())
      .filter((l) => KEY_LINE.test(l));
    const shown = tableRows(section(README, "### `.env.example`, line by line"))
      .map((cells) => /^`([^`]+)`$/.exec(cells[0] ?? "")?.[1] ?? "")
      .filter((c) => KEY_LINE.test(c));
    expect(lines).toHaveLength(envExampleKeys().length);
    expect(shown).toEqual(lines);
  });
});
