// secret-fixtures.test.ts — the generated self-test fixtures (scripts/ci/secret-fixtures.mjs) against
// BOTH scanners: every .gitleaks.toml custom rule has a must-flag case and fires on it, the
// placeholders stay quiet, and scripts/dev/scan-secrets.mjs is never narrower than gitleaks on the
// ESPN rules (plan 04 §4.3; plan 10 §3.0 Z1). gitleaks itself only runs in CI, so its custom rules
// are EMULATED here from the TOML (RE2 → JS: the patterns use only the common subset).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  GITLEAKS_RULE_IDS,
  assertGitleaks,
  assertScan,
  fakeEspnS2,
  fakeGuid,
  fakeIpv4,
  fakeLeagueId,
  mustFlag,
  mustPass,
} from "../../scripts/ci/secret-fixtures.mjs";
import { entropy, scanText } from "../../scripts/dev/scan-secrets.mjs";
import { ROOT, tempDir } from "../lint/helpers.js";

interface GlRule {
  id: string;
  re: RegExp;
  group: number;
  entropy: number;
  keywords: string[];
  allow: RegExp[];
}

/** Parse the custom [[rules]] of .gitleaks.toml (this repo's own, simple TOML). */
function parseGitleaks(): GlRule[] {
  const toml = readFileSync(path.join(ROOT, ".gitleaks.toml"), "utf8");
  const toRe = (src: string, g = "") => {
    const ci = src.startsWith("(?i)");
    return new RegExp(ci ? src.slice(4) : src, `${g}${ci ? "i" : ""}`);
  };
  return toml
    .split(/^\[\[rules\]\]$/m)
    .slice(1)
    .map((block) => {
      const id = /^id = "([^"]+)"/m.exec(block)?.[1] ?? "";
      const regex = /^regex = '''(.*)'''$/m.exec(block)?.[1] ?? "";
      const allowSrc = /regexes = \[(.*)\]/.exec(block)?.[1] ?? "";
      return {
        id,
        re: toRe(regex, "g"),
        group: Number(/^secretGroup = (\d+)/m.exec(block)?.[1] ?? "0"),
        entropy: Number(/^entropy = ([\d.]+)/m.exec(block)?.[1] ?? "0"),
        keywords: [...(/^keywords = \[(.*)\]/m.exec(block)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
          (m) => m[1] ?? "",
        ),
        allow: [...allowSrc.matchAll(/'''(.*?)'''/g)].map((m) => toRe(m[1] ?? "")),
      };
    });
}
const GL = parseGitleaks();

/** The custom gitleaks rule ids that fire on `line` (emulated). */
function gitleaksFires(line: string): Set<string> {
  const fired = new Set<string>();
  for (const r of GL) {
    if (r.keywords.length && !r.keywords.some((k) => line.toLowerCase().includes(k))) continue;
    r.re.lastIndex = 0;
    for (const m of line.matchAll(r.re)) {
      const secret = r.group ? (m[r.group] ?? "") : m[0];
      if (r.allow.some((a) => a.test(secret))) continue;
      if (r.entropy && entropy(secret) < r.entropy) continue;
      fired.add(r.id);
    }
  }
  return fired;
}
const localRules = (line: string) =>
  scanText("x", line, []).map((f) => /\[([a-z0-9:-]+)\]$/.exec(f)?.[1] ?? "");

describe(".gitleaks.toml ↔ the generated self-test", () => {
  it("parses every custom rule (a regex, and a test case for each)", () => {
    expect(GL.length).toBeGreaterThanOrEqual(9);
    for (const r of GL) expect(r.id).not.toBe("");
    expect(GL.map((r) => r.id).sort()).toEqual([...GITLEAKS_RULE_IDS].sort());
  });

  it("needs no path allowlist (no fake secret is committed)", () => {
    expect(readFileSync(path.join(ROOT, ".gitleaks.toml"), "utf8")).not.toMatch(/^\s*paths\s*=/m);
  });

  it.each(mustFlag().map((c, i) => [i + 1, c] as const))(
    "must-flag line %i fires its gitleaks rules",
    (_i, c) => {
      const fired = gitleaksFires(c.line);
      for (const id of c.gitleaks) expect(fired, id).toContain(id);
    },
  );

  it.each(mustPass())("must-pass %j fires no custom gitleaks rule", (line) => {
    expect([...gitleaksFires(line)]).toEqual([]);
  });

  it("scan-secrets is never narrower: every line a custom gitleaks rule flags, it flags too", () => {
    for (const c of mustFlag()) {
      if (gitleaksFires(c.line).size)
        expect(localRules(c.line).length, c.line.slice(0, 30)).toBeGreaterThan(0);
    }
  });

  it("property: espn_s2 assignments gitleaks flags are flagged locally", () => {
    fc.assert(
      fc.property(
        fc.string({
          unit: fc.constantFrom(..."ABCabcXYZxyz0123456789%+/=._-".split("")),
          minLength: 79,
          maxLength: 299,
        }),
        fc.constantFrom("espn_s2=", '"espn_s2": "', "ESPN_S2: ", "espn-s2="),
        (s, key) => {
          const line = `${key}7${s}`;
          return (
            !gitleaksFires(line).has("espn-s2-cookie") ||
            localRules(line).includes("espn-s2-cookie")
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it("property: GUIDs and league ids gitleaks flags are flagged locally", () => {
    fc.assert(
      fc.property(fc.uuid(), fc.stringMatching(/^[0-9]{4,9}$/), (u, id) => {
        const a = `"id": "{${u}}"`;
        const b = `leagueId=${id}`;
        return (
          (!gitleaksFires(a).has("brace-guid") || localRules(a).includes("brace-guid")) &&
          (!gitleaksFires(b).has("espn-league-id") || localRules(b).includes("espn-league-id"))
        );
      }),
      { numRuns: 300 },
    );
  });
});

describe("the generators", () => {
  it("are deterministic and shaped as documented", () => {
    expect(fakeEspnS2("x", 120)).toBe(fakeEspnS2("x", 120));
    expect(fakeEspnS2("x", 120)).toMatch(/^AE[A-Za-z0-9%]+$/);
    expect(fakeEspnS2("x", 120).length).toBe(120);
    expect(fakeEspnS2("x", 120)).toContain("%2F");
    expect(fakeGuid("g")).toMatch(
      /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-A[0-9A-F]{3}-[0-9A-F]{12}$/,
    );
    for (const n of [4, 7, 9])
      expect(fakeLeagueId("l", n)).toMatch(new RegExp(`^[1-9]\\d{${String(n - 1)}}$`));
    const ip = fakeIpv4("i").split(".").map(Number);
    expect(ip).toHaveLength(4);
    expect(ip[0]).not.toBe(127);
  });

  it("Z1: the must-flag set holds a brace-GUID outside the range, a 7-digit leagueId= and a 100+ char espn_s2=", () => {
    const lines = mustFlag().map((c) => c.line);
    expect(lines.some((l) => /\{[0-9A-F-]{36}\}/.test(l))).toBe(true);
    expect(lines.some((l) => /leagueId=\d{7}$/.test(l))).toBe(true);
    expect(lines.some((l) => /^espn_s2=[A-Za-z0-9%]{100,}$/.test(l))).toBe(true);
  });

  it("assertScan: the real scanner reports every must-flag case and passes every placeholder", () => {
    const r = assertScan();
    expect(r.lines.join("\n")).toContain("must-flag lines reported with every expected rule");
    expect(r.ok).toBe(true);
  });
});

describe("assertGitleaks (the CI report check)", () => {
  const report = (ids: string[]) =>
    ids.map((RuleID, i) => ({ RuleID, File: "f", StartLine: i + 1, Secret: "S3CRET", Match: "M" }));
  it("expect-all passes only when every rule fired", () => {
    expect(
      assertGitleaks(report([...GITLEAKS_RULE_IDS, "generic-api-key"]), "--expect-all").ok,
    ).toBe(true);
    const missing = assertGitleaks(report(GITLEAKS_RULE_IDS.slice(1)), "--expect-all");
    expect(missing.ok).toBe(false);
    expect(missing.lines.join()).toContain(GITLEAKS_RULE_IDS[0]);
  });
  it("expect-none passes only on an empty report", () => {
    expect(assertGitleaks([], "--expect-none").ok).toBe(true);
    expect(assertGitleaks(report(["brace-guid"]), "--expect-none").ok).toBe(false);
  });
  it("never prints a Secret or Match value; refuses a non-array", () => {
    const out = assertGitleaks(report(["brace-guid"]), "--expect-all").lines.join("\n");
    expect(out).not.toContain("S3CRET");
    expect(assertGitleaks({ not: "an array" }, "--expect-all").ok).toBe(false);
  });
});

describe("CLI", () => {
  let tmp: ReturnType<typeof tempDir> | undefined;
  afterEach(() => tmp?.cleanup());
  const run = (args: string[]) =>
    spawnSync(process.execPath, [path.join(ROOT, "scripts/ci/secret-fixtures.mjs"), ...args], {
      encoding: "utf8",
    });

  it("write <dir> creates both files; usage errors exit 2; a missing report counts as empty", () => {
    tmp = tempDir();
    expect(run(["write", tmp.dir]).status).toBe(0);
    expect(existsSync(path.join(tmp.dir, "must-flag.txt"))).toBe(true);
    expect(readFileSync(path.join(tmp.dir, "must-pass.txt"), "utf8").split("\n").length).toBe(
      mustPass().length + 1,
    );
    expect(run([]).status).toBe(2);
    expect(
      run(["assert-gitleaks", path.join(tmp.dir, "absent.json"), "--expect-none"]).status,
    ).toBe(0);
    expect(run(["assert-gitleaks", path.join(tmp.dir, "absent.json"), "--expect-all"]).status).toBe(
      1,
    );
  });
});
