// secret-fixtures.test.ts — the generated self-test fixtures (scripts/ci/secret-fixtures.mjs) against
// BOTH scanners: every .gitleaks.toml custom rule has a must-flag case and fires on it, the
// placeholders stay quiet, and scripts/dev/scan-secrets.mjs is never narrower than gitleaks on the
// ESPN rules (plan 04 §4.3; plan 10 §3.0 Z1). gitleaks itself only runs in CI, so its custom rules
// are EMULATED here from the TOML (RE2 → JS: the patterns use only the common subset, plus the
// `(?-i:…)` flag group both engines read). The emulation is the rule alone: gitleaks' own decoder
// (--max-decode-depth, a CLI default) is not modelled, so an encoded case passes here only when
// the rule itself reads it.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  GITLEAKS_RULE_IDS,
  assertGitleaks,
  assertScan,
  crossLineCases,
  dashedHomePathCases,
  encodedLeagueIdCases,
  fakeEspnS2,
  fakeGuid,
  fakeIpv4,
  fakeLeagueId,
  mustFlag,
  mustFlagStartLines,
  mustPass,
} from "../../scripts/ci/secret-fixtures.mjs";
import { entropy, lineRuleIds, scanText } from "../../scripts/dev/scan-secrets.mjs";
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

// Stage C finding scan-league-envelope-per-line: scan-secrets matched each rule one line at a time,
// while gitleaks matches a whole file, where `\s` crosses line breaks — so a league body written one
// key per line passed the prevention layer and was flagged only after the push.
describe("across line breaks, scan-secrets is never narrower than gitleaks", () => {
  /** The scan-secrets rule that stands for a gitleaks rule. */
  const LOCAL: Record<string, string> = {
    "espn-s2-value-bare": "espn-s2-bare",
    "espn-s2-percent-encoded": "espn-s2-bare",
  };
  /** The offsets at which the emulated gitleaks rule `id` starts a (reported) match in `text`. */
  const gitleaksStarts = (text: string, id: string) => {
    const r = GL.find((x) => x.id === id);
    if (!r) return [];
    r.re.lastIndex = 0;
    return [...text.matchAll(r.re)]
      .filter((m) => {
        const secret = r.group ? (m[r.group] ?? "") : m[0];
        return !r.allow.some((a) => a.test(secret)) && !(r.entropy && entropy(secret) < r.entropy);
      })
      .map((m) => m.index);
  };

  it("the self-test's cross-line cases: each rule both scanners must report starts on the case's first line", () => {
    const cases = crossLineCases((...p) => p.join(""));
    expect(cases.length).toBeGreaterThanOrEqual(7);
    const flagged = new Map(mustFlag().map((c) => [c.line, c]));
    for (const c of cases) {
      expect(flagged.get(c.line), c.line.slice(0, 30)).toBeDefined();
      expect(c.line).toContain("\n");
      const firstBreak = c.line.indexOf("\n");
      for (const id of c.gitleaks) {
        const starts = gitleaksStarts(c.line, id);
        expect(
          starts.some((s) => s < firstBreak),
          `${id} on ${c.line.slice(0, 30)}`,
        ).toBe(true);
      }
      const local = scanText("x", c.line, []);
      for (const id of c.scan) expect(local, id).toContain(`x:1  [${id}]`);
      // no line of the case alone carries it (what the line-by-line scanner saw)
      for (const id of c.scan)
        for (const l of c.line.split("\n")) expect(lineRuleIds(l), `${id}: ${l}`).not.toContain(id);
    }
  });

  it("mustFlagStartLines: the line each case starts on in the written must-flag.txt", () => {
    const written = `${mustFlag()
      .map((c) => c.line)
      .join("\n")}\n`.split("\n");
    const starts = mustFlagStartLines();
    mustFlag().forEach((c, i) => {
      expect(written[(starts[i] ?? 0) - 1]).toBe(c.line.split("\n")[0]);
    });
    // the single-line cases before the first multi-line one keep their old numbering
    const firstMulti = mustFlag().findIndex((c) => c.line.includes("\n"));
    expect(firstMulti).toBeGreaterThan(40);
    for (let i = 0; i < firstMulti; i++) expect(starts[i]).toBe(i + 1);
  });

  it("the self-test carries the dash-spelled home paths (scan-secrets only)", () => {
    const flagged = new Map(mustFlag().map((c) => [c.line, c]));
    const cases = dashedHomePathCases((...p) => p.join(""));
    expect(cases.length).toBeGreaterThanOrEqual(5);
    for (const c of cases) {
      expect(flagged.get(c.line)?.scan).toEqual(["home-path"]);
      expect(localRules(c.line)).toContain("home-path");
      expect([...gitleaksFires(c.line)]).toEqual([]);
    }
  });

  it("property: a line break (and indentation) put where the rules let whitespace stand — gitleaks ⇒ scan-secrets, rule for rule", () => {
    const SEP = new Set([":", "=", ",", "[", "{", "|", '"', "'", " "]);
    const cases = mustFlag().filter((c) => c.gitleaks.length > 0 && !c.line.includes("\n"));
    fc.assert(
      fc.property(
        fc.constantFrom(...cases),
        fc.array(fc.nat(), { minLength: 1, maxLength: 3 }),
        fc.constantFrom("", "  ", "\t", "    "),
        (c, picks, indent) => {
          // code-unit offsets, as slice reads them
          const points: number[] = [];
          for (let i = 0; i < c.line.length; i++)
            if (SEP.has(c.line[i] ?? "")) points.push(i, i + 1);
          if (!points.length) return true;
          const at = [...new Set(picks.map((p) => points[p % points.length] ?? 0))].sort(
            (a, b) => b - a,
          );
          let text = c.line;
          for (const i of at) text = `${text.slice(0, i)}\n${indent}${text.slice(i)}`;
          const local = new Set(localRules(text));
          return [...gitleaksFires(text)].every((id) => local.has(LOCAL[id] ?? id));
        },
      ),
      { numRuns: 1500 },
    );
  });
});

// Stage C finding scan-league-id-url-encoded: .gitleaks.toml's espn-league-id read none of a league
// id's encoded spellings (leagueId%3D<id>, …%2Fleagues%2F<id>). In CI only gitleaks' own decoder —
// a CLI default, not this config — read the percent forms; nothing read HTML entities or backslash
// escapes. The rule now carries a twin for each encoding, bounded to what scan-secrets decodes.
describe("espn-league-id in encoded and escaped spellings (both scanners)", () => {
  const BS = "\\";
  const NAMED: Record<string, string[]> = { '"': ["&quot;"], "'": ["&apos;"], " ": ["&nbsp;"] };
  /**
   * The spellings of one separator character: literal, %XX under 0–3 extra %25 layers, \u00XX
   * behind one or two backslashes, decimal and hex HTML entities (zero-padded to the decoder's
   * limit), the named entity, and 1–3 backslashes before a quote or slash. `deep` goes past the
   * decoder's bounds (for the "never narrower" direction only).
   */
  const spellings = (ch: string, deep = false): string[] => {
    const code = ch.charCodeAt(0);
    const hh = code.toString(16).padStart(2, "0");
    const dec = String(code);
    const out = [ch];
    for (const k of deep ? [0, 1, 2, 3, 4, 5] : [0, 1, 2, 3])
      out.push(`%${"25".repeat(k)}${hh}`, `%${"25".repeat(k)}${hh.toUpperCase()}`);
    for (const n of deep ? [1, 2, 3, 4] : [1, 2]) out.push(`${BS.repeat(n)}u00${hh}`);
    for (const z of deep ? [0, 3, 5, 6, 8] : [0, 7 - dec.length])
      out.push(`&#${"0".repeat(z)}${dec};`);
    for (const z of deep ? [0, 4, 5, 8] : [0, 6 - hh.length])
      out.push(`&#x${"0".repeat(z)}${hh};`, `&#X${"0".repeat(z)}${hh.toUpperCase()};`);
    out.push(...(NAMED[ch] ?? []));
    if (`"'\`/`.includes(ch))
      for (const n of deep ? [1, 2, 3, 4, 5, 6] : [1, 2, 3]) out.push(`${BS.repeat(n)}${ch}`);
    return out;
  };
  type Enc = (ch: string) => string;
  /** Every literal form the rule names, its separators spelled by `e`. */
  const FORMS: readonly (readonly [string, (e: Enc, id: string) => string])[] = [
    ["a query value", (e, id) => `https://fantasy.espn.com/football/league?leagueId${e("=")}${id}`],
    ["a JSON field", (e, id) => `{${e('"')}leagueId${e('"')}${e(":")}${e(" ")}${id}}`],
    ["a JSON array", (e, id) => `${e('"')}leagueIds${e('"')}${e(":")}${e(" ")}${e("[")}${id}]`],
    ["prose", (e, id) => `league${e(" ")}id${e(":")}${e(" ")}${id}`],
    ["a quoted value", (e, id) => `league_id${e("=")}${e("'")}${id}${e("'")}`],
    ["a markdown cell", (e, id) => `| league id ${e("|")} ${id} |`],
    [
      "an API path",
      (e, id) =>
        `/apis/v3/games/ffl/seasons/2026/segments/0${e("/")}leagues${e("/")}${id}?view=mTeam`,
    ],
    ["a history path", (e, id) => `x${e("/")}leagueHistory${e("/")}${id}`],
    ["a flag", (e, id) => `run --league${e(" ")}${e("`")}${id}`],
    ["a flag with =", (e, id) => `--league-id${e("=")}${e('"')}${id}`],
    ["a form-encoded space", (e, id) => `league+id${e("=")}${id}`],
  ];
  /** The literal separator of each of a form's slots, in order. */
  const slotChars = (form: (e: Enc, id: string) => string) => {
    const chars: string[] = [];
    form((c) => (chars.push(c), c), "1");
    return chars;
  };
  /** The form with separator `slot` spelled `spelling`, every other one literal. */
  const oneSpelled = (
    form: (e: Enc, id: string) => string,
    slot: number,
    spelling: string,
    id: string,
  ) => {
    let k = 0;
    return form((c) => (k++ === slot ? spelling : c), id);
  };
  const leagueIdFires = (line: string) => gitleaksFires(line).has("espn-league-id");
  const localLeagueId = (line: string) => localRules(line).includes("espn-league-id");
  const ID = fc.stringMatching(/^\d{4,9}$/).filter((d) => !/^0+$/.test(d));
  const id7 = ["7", "3", "1", "9", "0", "4", "2"].join("");

  it("the generated self-test carries the encoded cases, each a gitleaks AND a scan-secrets line", () => {
    const flagged = new Map(mustFlag().map((c) => [c.line, c]));
    const encoded = encodedLeagueIdCases((...p) => p.join(""));
    expect(encoded.length).toBeGreaterThanOrEqual(12);
    for (const c of encoded) {
      expect(flagged.get(c.line)?.gitleaks, c.line.slice(0, 40)).toEqual(["espn-league-id"]);
      expect(flagged.get(c.line)?.scan).toEqual(["espn-league-id"]);
    }
  });

  it("every spelling of every separator, one at a time, is flagged by both scanners", () => {
    const misses: string[] = [];
    let checked = 0;
    for (const [name, form] of FORMS)
      slotChars(form).forEach((ch, slot) => {
        for (const s of spellings(ch)) {
          const line = oneSpelled(form, slot, s, id7);
          checked++;
          if (!leagueIdFires(line)) misses.push(`gitleaks: ${name} ${JSON.stringify(s)}`);
          if (!localLeagueId(line)) misses.push(`scan-secrets: ${name} ${JSON.stringify(s)}`);
        }
      });
    expect(misses).toEqual([]);
    expect(checked).toBeGreaterThan(300);
  });

  it("property: mixed spellings within the decoder's bounds are flagged by both", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FORMS),
        fc.array(fc.nat(), { minLength: 6, maxLength: 6 }),
        ID,
        ([, form], picks, id) => {
          let k = 0;
          const line = form((c) => {
            const s = spellings(c);
            return s[(picks[k++ % picks.length] ?? 0) % s.length] ?? c;
          }, id);
          return leagueIdFires(line) && localLeagueId(line);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("property: past the decoder's bounds too, scan-secrets is never narrower (gitleaks ⇒ scan-secrets)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FORMS),
        fc.array(fc.nat(), { minLength: 6, maxLength: 6 }),
        ID,
        ([, form], picks, id) => {
          let k = 0;
          const line = form((c) => {
            const s = spellings(c, true);
            return s[(picks[k++ % picks.length] ?? 0) % s.length] ?? c;
          }, id);
          return !leagueIdFires(line) || localLeagueId(line);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("the placeholder id 0 / 0000 stays quiet in every spelling, in both", () => {
    const hits: string[] = [];
    for (const [name, form] of FORMS)
      slotChars(form).forEach((ch, slot) => {
        for (const s of spellings(ch))
          for (const zero of ["0", "0000"]) {
            const line = oneSpelled(form, slot, s, zero);
            if (leagueIdFires(line) || localLeagueId(line))
              hits.push(`${name} ${JSON.stringify(s)}`);
          }
      });
    expect(hits).toEqual([]);
  });

  it("property: on text with no %, backslash or & the rule IS scan-secrets' literal espn-league-id", () => {
    // the twin never widens the literal reading (the history scan stays as it was) and never
    // narrows it: both directions, over a key / separator / glue / digits grammar and a free mix
    const KEY = ["league", "leagues", "leagueHistory", "LEAGUE", "--league", "--league-id", "x"];
    const MID = ["", " ", "  ", "_", "-", "+", "\t"];
    const IDS = ["", "id", "ids", "Id", "IDS", "-id"];
    const SEPS = [
      "",
      " ",
      "=",
      ":",
      ": ",
      " = ",
      '"',
      '":',
      '": "',
      "'",
      " | ",
      "=[",
      '": [',
      "`",
      "/",
    ];
    const DIGITS = ["1234", "98765", "0", "0000", "7", "123"];
    const agree = (line: string) =>
      leagueIdFires(line) === lineRuleIds(line).includes("espn-league-id");
    // every combination of the grammar, deterministically
    const disagree: string[] = [];
    for (const k of KEY)
      for (const m of MID)
        for (const i of IDS)
          for (const s of SEPS)
            for (const d of DIGITS) {
              const line = `/${k}${m}${i}${s}${d}`;
              if (!agree(line)) disagree.push(JSON.stringify(line));
            }
    expect(disagree).toEqual([]);
    // and a free mix of the same pieces plus stray glue
    const GLUE = [" ", "\t", ":", "=", "|", "[", "]", "{", '"', "'", "`", "/", ",", "."];
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...KEY, ...MID, ...IDS, ...SEPS, ...GLUE, ...DIGITS), {
          minLength: 1,
          maxLength: 12,
        }),
        (parts) => agree(parts.join("")),
      ),
      { numRuns: 3000 },
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
  /**
   * What a gitleaks run that meets every must-flag expectation reports (StartLine is 1-based: the
   * line its case starts on — a case may hold line breaks).
   */
  const perLine = () => {
    const starts = mustFlagStartLines();
    return mustFlag().flatMap((c, i) =>
      c.gitleaks.map((RuleID) => ({ RuleID, File: "must-flag.txt", StartLine: starts[i] ?? 0 })),
    );
  };
  /** The 1-based must-flag line of the first encoded league-id case. */
  const encodedLine = () =>
    mustFlagStartLines()[
      mustFlag().findIndex((c) => c.line === encodedLeagueIdCases((...p) => p.join(""))[0]?.line)
    ] ?? 0;

  it("expect-all passes when every must-flag line is reported by each rule it names, on that line", () => {
    const r = assertGitleaks(
      [...perLine(), { RuleID: "generic-api-key", File: "f", StartLine: 1 }],
      "--expect-all",
    );
    expect(r.ok, r.lines.join("\n")).toBe(true);
    expect(r.lines.join("\n")).toMatch(/per line: (\d+) of \1 expected findings/);
  });

  it("a rule that fires elsewhere never stands in for a line it misses (Stage C finding scan-league-id-url-encoded)", () => {
    const line = encodedLine();
    expect(line).toBeGreaterThan(1);
    // every rule still fires (espn-league-id on its literal lines): the old all-rules-fired check
    // passed exactly this report, with the encoded league-id line unreported
    const r = assertGitleaks(
      perLine().filter((f) => f.StartLine !== line),
      "--expect-all",
    );
    expect(r.lines.join("\n")).toContain(
      `expected ${String(GITLEAKS_RULE_IDS.length)} rule ids, fired ${String(GITLEAKS_RULE_IDS.length)}`,
    );
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain(`line ${String(line)} [espn-league-id]`);
    // a finding on the neighbouring line is not this line's finding
    const shifted = perLine().map((f) =>
      f.StartLine === line ? { ...f, StartLine: line + 50 } : f,
    );
    expect(assertGitleaks(shifted, "--expect-all").ok).toBe(false);
  });

  it("expect-all still names a rule that fired nowhere", () => {
    const missing = assertGitleaks(report(GITLEAKS_RULE_IDS.slice(1)), "--expect-all");
    expect(missing.ok).toBe(false);
    expect(missing.lines.join()).toContain(GITLEAKS_RULE_IDS[0]);
  });
  it("expect-none passes only on an empty report", () => {
    expect(assertGitleaks([], "--expect-none").ok).toBe(true);
    expect(assertGitleaks(report(["brace-guid"]), "--expect-none").ok).toBe(false);
  });
  it("names the commit of a history finding", () => {
    const out = assertGitleaks(
      [{ RuleID: "espn-league-id", File: "f", StartLine: 1, Commit: "3214f70048b63d92" }],
      "--expect-none",
    );
    expect(out.lines.join()).toContain("commit=3214f70048b6");
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
    expect(readFileSync(path.join(tmp.dir, "must-pass.txt"), "utf8")).toBe(
      `${mustPass().join("\n")}\n`,
    );
    expect(readFileSync(path.join(tmp.dir, "must-flag.txt"), "utf8").split("\n").length).toBe(
      (mustFlagStartLines().at(-1) ?? 0) + (mustFlag().at(-1)?.line.split("\n").length ?? 0),
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
