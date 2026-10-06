// verify.test.ts — src/domain/scoring/verify.ts (plan 08 §2 verify, §6 step 3 mismatch classes, E6
// > 10 % refusal share; P16). A 100 %-coverage module (plan 05 §7, T-10).
import { describe, expect, it } from "vitest";
import { renormalizeSettings } from "../../../src/domain/scoring/settings.js";
import type { AppliedReference, ScoringSettings } from "../../../src/domain/scoring/types.js";
import {
  classifyMismatch,
  isLeagueWideMismatch,
  statPointsMatch,
  totalPointsMatch,
  verify,
} from "../../../src/domain/scoring/verify.js";
import { espnLine, item, line, settingsOf } from "./helpers.js";

const s = settingsOf([
  item(53, 0.5),
  item(42, 0.1),
  item(89, 0, { "16": 5 }),
  item(103, 6, { "16": 6 }),
  item(104, 6, { "16": 3 }),
]);
const wr = espnLine({ 53: 4, 42: 31 }, 3);
const ok: AppliedReference = { total: 5.1, by_stat: { "53": 2, "42": 3.1 } };

describe("tolerances (never widened)", () => {
  it("per stat ≤ 0.005 and per total ≤ 0.01; non-finite never matches", () => {
    expect(statPointsMatch(1, 1.005)).toBe(true);
    expect(statPointsMatch(1, 1.0051)).toBe(false);
    expect(totalPointsMatch(10, 10.01)).toBe(true);
    expect(totalPointsMatch(10, 10.0101)).toBe(false);
    expect(statPointsMatch(Number.NaN, 1)).toBe(false);
    expect(statPointsMatch(1, Number.POSITIVE_INFINITY)).toBe(false);
    expect(totalPointsMatch(Number.NaN, 1)).toBe(false);
    expect(totalPointsMatch(1, Number.NaN)).toBe(false);
  });
  it("E6: league-wide only when strictly more than 10 % mismatch", () => {
    expect(isLeagueWideMismatch(11, 100)).toBe(true);
    expect(isLeagueWideMismatch(10, 100)).toBe(false);
    expect(isLeagueWideMismatch(0, 0)).toBe(false);
    for (const [m, t] of [
      [1.5, 10],
      [1, 10.5],
      [-1, 10],
      [1, -10],
    ] as const)
      expect(isLeagueWideMismatch(m, t)).toBe(false);
  });
});

describe("verify (P16)", () => {
  it("matches ESPN's applied values; delta_total is engine − ESPN", () => {
    expect(verify(wr, s, ok)).toEqual({ match: true, mismatch_stat_ids: [], delta_total: 0 });
    expect(verify(wr, s, { total: 5.1, by_stat: { "53": 2, "42": 3.1, "89": 0 } }).match).toBe(
      true,
    );
  });
  it("names a single perturbed stat and moves delta_total", () => {
    const v = verify(wr, s, { total: 5.6, by_stat: { "53": 2.5, "42": 3.1 } });
    expect(v).toEqual({ match: false, mismatch_stat_ids: ["53"], delta_total: -0.5 });
  });
  it("an ESPN-only id and an engine-only id are both mismatches (absent counts 0), sorted numerically", () => {
    const v = verify(wr, s, { total: 5.1, by_stat: { "53": 2, "120": 1 } });
    expect(v.mismatch_stat_ids).toEqual(["42", "120"]);
  });
  it("a total off by more than 0.01 fails even when every stat matches", () => {
    expect(verify(wr, s, { total: 5.12, by_stat: ok.by_stat }).match).toBe(false);
    expect(verify(wr, s, { total: 5.109, by_stat: ok.by_stat }).match).toBe(true);
  });
  it.each([
    ["applied null", null],
    ["total NaN", { total: Number.NaN, by_stat: {} }],
    ["total a string", { total: "5.1", by_stat: {} }],
    ["by_stat null", { total: 1, by_stat: null }],
    ["by_stat an array", { total: 1, by_stat: [1] }],
    ["a key that is not a statId", { total: 1, by_stat: { rec: 1 } }],
    ["a value that is not a number", { total: 1, by_stat: { "53": "2" } }],
    [
      "too many stats",
      {
        total: 1,
        by_stat: Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [String(i), 0])),
      },
    ],
  ])("ESPN applied values that are not numbers are drift (%s)", (_label, applied) => {
    expect(() => verify(wr, s, applied as unknown as AppliedReference)).toThrow(
      expect.objectContaining({ code: "drift" }),
    );
  });
});

describe("classifyMismatch (plan 08 §6 step 3)", () => {
  it("is empty on a match", () => {
    expect(classifyMismatch(wr, s, ok)).toEqual([]);
  });
  it("unmapped_id: ESPN scored an id S does not map, or a rule with no canonical", () => {
    expect(classifyMismatch(wr, s, { total: 6.1, by_stat: { ...ok.by_stat, "777": 1 } })).toEqual([
      "unmapped_id",
    ]);
    const withUnmapped = settingsOf([item(53, 0.5), item(999, 1)]);
    expect(
      classifyMismatch(espnLine({ 53: 2 }, 3), withUnmapped, {
        total: 2,
        by_stat: { "53": 1, "999": 1 },
      }),
    ).toEqual(["unmapped_id"]);
  });
  it("override_missed: ESPN's points per unit equal another of the rule's values", () => {
    const ovr = settingsOf([item(4, 4, { "15": 6 })]);
    expect(
      classifyMismatch(espnLine({ 4: 2 }, 15), ovr, { total: 8, by_stat: { "4": 8 } }),
    ).toEqual(["override_missed"]);
  });
  it("translator: ESPN scored a stat the line does not carry (or carries as 0)", () => {
    expect(
      classifyMismatch(espnLine({ 53: 4 }, 3), s, { total: 5.1, by_stat: { "53": 2, "42": 3.1 } }),
    ).toEqual(["translator"]);
    expect(
      classifyMismatch(espnLine({ 53: 4, 42: 0 }, 3), s, {
        total: 5.1,
        by_stat: { "53": 2, "42": 3.1 },
      }),
    ).toEqual(["translator"]);
  });
  it("bracket_bounds: a family member's points differ", () => {
    expect(
      classifyMismatch(espnLine({ 89: 1, 120: 0 }, 16), s, { total: 4, by_stat: { "89": 4 } }),
    ).toEqual(["bracket_bounds"]);
  });
  it("disputed_103_104: swapping the engine's 103 and 104 fixes both", () => {
    const d = espnLine({ 103: 1 }, 16);
    expect(classifyMismatch(d, s, { total: 6, by_stat: { "104": 6, "103": 0 } })).toEqual([
      "disputed_103_104",
      "translator",
    ]);
    expect(classifyMismatch(d, s, { total: 2, by_stat: { "103": 2 } })).toEqual([]);
    expect(classifyMismatch(d, s, { total: 6, by_stat: { "104": 6 } })).toEqual([
      "disputed_103_104",
      "translator",
    ]);
    const fr = espnLine({ 104: 1 }, 16);
    expect(classifyMismatch(fr, s, { total: 3, by_stat: { "103": 3 } })).toEqual([
      "disputed_103_104",
      "translator",
    ]);
  });
  it("rounding: every stat matches and the total is off by ≤ 0.02", () => {
    expect(classifyMismatch(wr, s, { total: 5.115, by_stat: ok.by_stat })).toEqual(["rounding"]);
    expect(classifyMismatch(wr, s, { total: 5.2, by_stat: ok.by_stat })).toEqual([]);
  });
  it("an engine-only stat ESPN did not score classifies by its per-unit value (0 here: nothing)", () => {
    expect(classifyMismatch(wr, s, { total: 2, by_stat: { "53": 2 } })).toEqual([]);
  });
  it("an unexplained per-unit difference and a custom canonical classify as nothing", () => {
    expect(classifyMismatch(wr, s, { total: 5.6, by_stat: { "53": 2.6, "42": 3.1 } })).toEqual([]);
    const m = JSON.parse(JSON.stringify(settingsOf([]))) as { rules: unknown[] };
    m.rules.push({
      canonical: "custom_stat",
      platform_id: "998",
      abbr: "X",
      points: 2,
      overrides: {},
      is_reverse: false,
      applies_to: ["O"],
      disputed: false,
    });
    const custom: ScoringSettings = renormalizeSettings(m);
    expect(
      classifyMismatch(line({ custom_stat: 1 }, 1, "espn"), custom, {
        total: 3,
        by_stat: { "998": 3 },
      }),
    ).toEqual([]);
  });
});
