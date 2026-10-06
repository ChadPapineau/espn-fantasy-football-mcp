// verification.test.ts — src/domain/scoring/verification.ts (plan 08 §6 step 6; plan 10 B13, D8):
// familyVerification on hand-built settings — the B13 families, the D8 members, zero-point members
// ignored, a hand-built family with no rule — plus the evidence tables' shape and a fast-check
// property tying `verified` to its two conditions. The recorded half is
// tests/golden/engine-families.test.ts (it re-derives both constants from the fixtures).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CANONICAL_DEFS, canonicalDef } from "../../../src/domain/scoring/registry.js";
import { espnIdOf, espnStat } from "../../../src/domain/scoring/stat_map.js";
import { BRACKET_FAMILY_NAMES, type ScoringSettings } from "../../../src/domain/scoring/types.js";
import {
  FAMILY_EVIDENCE,
  familyVerification,
  GOLDEN_COVERED_STAT_IDS,
  scoresForClass,
} from "../../../src/domain/scoring/verification.js";
import { item, reference, settingsOf } from "./helpers.js";

const rows = (s: ScoringSettings) =>
  familyVerification(s).map((v) => [
    `${v.family}:${v.scalar}`,
    v.verified,
    [...v.unverified_stat_ids],
  ]);

describe("the evidence tables", () => {
  it("FAMILY_EVIDENCE covers every family, frozen, with short server-authored text", () => {
    expect(Object.keys(FAMILY_EVIDENCE).sort()).toEqual([...BRACKET_FAMILY_NAMES].sort());
    expect(Object.isFrozen(FAMILY_EVIDENCE)).toBe(true);
    for (const [name, e] of Object.entries(FAMILY_EVIDENCE)) {
      expect(Object.isFrozen(e) && Object.isFrozen(e.derivation_open_stat_ids)).toBe(true);
      expect(e.basis.length).toBeGreaterThan(20);
      expect(e.basis.length).toBeLessThanOrEqual(240);
      expect(e.basis).toMatch(/^[\w ()/+−–=,;:.'0-9-]+$/);
      for (const id of e.derivation_open_stat_ids) {
        expect(canonicalDef(espnStat(id)!.canonical)?.family?.name, `${name} ${id}`).toBe(name);
      }
    }
  });
  it("GOLDEN_COVERED_STAT_IDS: frozen, unique, numerically sorted, every id a family member", () => {
    const ids = GOLDEN_COVERED_STAT_IDS;
    expect(Object.isFrozen(ids)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => Number(a) - Number(b))).toEqual(ids);
    for (const id of ids) expect(canonicalDef(espnStat(id)!.canonical)?.family, id).not.toBeNull();
  });
  it("the B13 members league-c carries are covered; the D8 ones are not", () => {
    for (const id of ["15", "16", "35", "36", "45", "46", "8", "28", "48"]) {
      expect(GOLDEN_COVERED_STAT_IDS, id).toContain(id);
    }
    for (const id of ["74", "5", "27", "47", "75", "121", "128", "161"]) {
      expect(GOLDEN_COVERED_STAT_IDS, id).not.toContain(id);
    }
  });
});

describe("scoresForClass (non-zero points for some position of the class)", () => {
  const rule = (points: number, overrides: Record<string, number> = {}) =>
    settingsOf([item(89, points, overrides)]).rules[0]!;
  it.each([
    [0, {}, "DST", false],
    [0, { "16": 5 }, "DST", true],
    [3, {}, "DST", true],
    [3, { "16": 0 }, "DST", false],
    [3, { "16": 0 }, "O", true],
    [0, { "1": 2 }, "O", true],
    [0, { "1": 2 }, "K", false],
  ] as const)("points %s overrides %j for %s → %s", (points, overrides, cls, want) => {
    expect(scoresForClass(rule(points, overrides), cls)).toBe(want);
  });
});

describe("familyVerification (what espn_get_league reports per family — plan 08 §6 step 6)", () => {
  it("the hand-written reference S: K and D/ST families verified; the 0-point 121 and 131 ignored", () => {
    expect(rows(reference())).toEqual([
      ["fg_distance:kick_distance", true, []],
      ["fg_miss:kick_distance", true, []],
      ["dst_points_allowed:dst_pa_raw", true, []],
      ["dst_yards_allowed:dst_ya_raw", true, []],
    ]);
  });
  it("B13: long-TD and the recorded per-N divisors are verified", () => {
    expect(rows(settingsOf([item(15, 1), item(16, 2), item(8, 1), item(28, 1)]))).toEqual([
      ["long_td_bonus:pass_td", true, []],
      ["per_n_yards:pass_yd", true, []],
      ["per_n_yards:rush_yd", true, []],
    ]);
  });
  it("D8: a per-N divisor no recorded league scores makes its family unverified, naming it", () => {
    expect(rows(settingsOf([item(5, 1), item(8, 1)]))).toEqual([
      ["per_n_yards:pass_yd", false, ["5"]],
    ]);
  });
  it("D8: the legacy 50+ item 74 makes fg_distance unverified [74]", () => {
    expect(rows(settingsOf([item(80, 3), item(77, 4), item(74, 5)]))).toEqual([
      ["fg_distance:kick_distance", false, ["74"]],
    ]);
  });
  it("A-2: 17 alone is open; 18 alone is verified", () => {
    expect(rows(settingsOf([item(17, 2)]))).toEqual([["yardage_bonus:pass_yd", false, ["17"]]]);
    expect(rows(settingsOf([item(18, 3)]))).toEqual([["yardage_bonus:pass_yd", true, []]]);
  });
  it("121 at 0 is ignored; 121 scored is unverified", () => {
    expect(rows(settingsOf([item(92, 0, { "16": 1 }), item(121, 0, { "16": 0 })]))).toEqual([
      ["dst_points_allowed:dst_pa_raw", true, []],
    ]);
    expect(rows(settingsOf([item(92, 0, { "16": 1 }), item(121, 0, { "16": -1 })]))).toEqual([
      ["dst_points_allowed:dst_pa_raw", false, ["121"]],
    ]);
  });
  it("HC margins: never verified (no recorded HC line); a scored member is named", () => {
    expect(rows(settingsOf([item(161, 10, { "14": 0 })]))).toEqual([
      ["margin:team_win_margin", false, []],
    ]);
    expect(rows(settingsOf([item(161, 0, { "14": 3 })]))).toEqual([
      ["margin:team_win_margin", false, ["161"]],
    ]);
  });
  it("no families → empty; the result is frozen", () => {
    const r = familyVerification(settingsOf([item(53, 0.5)]));
    expect(r).toEqual([]);
    expect(Object.isFrozen(r)).toBe(true);
    const one = familyVerification(settingsOf([item(15, 1)]));
    expect(Object.isFrozen(one[0]) && Object.isFrozen(one[0]?.unverified_stat_ids)).toBe(true);
  });
  it("a hand-built family member with no rule is ignored (nothing can score it)", () => {
    const s = settingsOf([item(5, 1)]);
    expect(rows({ ...s, rules: [] })).toEqual([["per_n_yards:pass_yd", true, []]]);
  });
  it("property: verified ⇔ the derivation is evidenced and no scored member is uncovered or open", () => {
    const ids = CANONICAL_DEFS.flatMap((d) => {
      const id = espnIdOf(d.canonical);
      return d.family === null || id === undefined ? [] : [Number(id)];
    }).filter((id) => ![74, 75, 76].includes(id)); // the legacy 50+ ids overlap 198–203 (a normaliser error)
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...ids), { maxLength: 12 }),
        fc.array(fc.constantFrom(0, 1, -2), { minLength: 12, maxLength: 12 }),
        (picked, pts) => {
          const s = settingsOf(
            picked.map((id, i) =>
              item(id, 0, { "1": pts[i]!, "5": pts[i]!, "14": pts[i]!, "16": pts[i]! }),
            ),
          );
          for (const v of familyVerification(s)) {
            const e = FAMILY_EVIDENCE[v.family];
            const bad = v.unverified_stat_ids.every(
              (id) =>
                !GOLDEN_COVERED_STAT_IDS.includes(id) || e.derivation_open_stat_ids.includes(id),
            );
            if (!bad) return false;
            if (v.verified !== (e.derivation === "verified" && v.unverified_stat_ids.length === 0))
              return false;
          }
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });
});
