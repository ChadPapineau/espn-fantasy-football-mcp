// brackets.test.ts — src/domain/scoring/brackets.ts (plan 08 §4.1: families from the ids present in S,
// overlap = error naming both ids, gap = complete_range false; bracketize for derived lines; P4).
import { describe, expect, it } from "vitest";
import {
  bracketize,
  buildFamilies,
  familyKey,
  familyKind,
} from "../../../src/domain/scoring/brackets.js";
import type { BracketFamily, ScoringRule } from "../../../src/domain/scoring/types.js";
import { item, settingsOf } from "./helpers.js";

const families = (ids: number[]) => settingsOf(ids.map((id) => item(id, 1))).families;
const only = (ids: number[]): BracketFamily => {
  const f = families(ids);
  expect(f).toHaveLength(1);
  return f[0]!;
};

describe("buildFamilies", () => {
  it("filters the registry members to the ids in S, sorted by bounds, with a complete range", () => {
    const pa = only([125, 89, 91, 90, 92, 121, 122, 123, 124]);
    expect(pa.members.map((m) => m.platform_id)).toEqual([
      "89",
      "90",
      "91",
      "92",
      "121",
      "122",
      "123",
      "124",
      "125",
    ]);
    expect(pa).toMatchObject({
      family: "dst_points_allowed",
      scalar: "dst_pa_raw",
      position_class: "DST",
      exclusive: true,
      complete_range: true,
    });
    expect(familyKind(pa)).toBe("tier");
    expect(familyKey(pa)).toBe("dst_points_allowed:dst_pa_raw");
  });
  it("records a gap, a late start and a closed top as complete_range: false (legal)", () => {
    expect(only([89, 90, 124, 125]).complete_range).toBe(false); // gap 7–34
    expect(only([91, 92, 121, 122, 123, 124, 125]).complete_range).toBe(false); // starts at 7
    expect(only([89, 90, 91]).complete_range).toBe(false); // no open-ended top
    expect(only([128, 129, 130, 131, 132, 133, 134, 135, 136]).complete_range).toBe(true);
  });
  it("FG buckets are counts (not exclusive); 0–39/40–49/50+ legacy is a complete partition", () => {
    const fg = only([80, 77, 74]);
    expect(fg).toMatchObject({ family: "fg_distance", exclusive: false, complete_range: true });
    expect(familyKind(fg)).toBe("count");
  });
  it.each([
    [
      [74, 198],
      ["198", "74"],
    ],
    [
      [74, 201],
      ["74", "201"],
    ],
    [
      [75, 199, 81],
      ["199", "75"],
    ],
    [
      [76, 203],
      ["76", "203"],
    ],
  ])("an overlap (%j) is a bracket_bounds error naming both ids", (ids, named) => {
    expect(() => families(ids)).toThrow(
      expect.objectContaining({ code: "bracket_bounds", detail: named }),
    );
  });
  it("threshold, length and per-N families never check a partition", () => {
    const [bonus] = families([17, 18]);
    expect(bonus).toMatchObject({
      family: "yardage_bonus",
      scalar: "pass_yd",
      exclusive: false,
      complete_range: true,
    });
    expect(only([15, 16])).toMatchObject({
      family: "long_td_bonus",
      scalar: "pass_td",
      complete_range: true,
    });
    const pern = only([8, 5]);
    expect(pern.members.map((m) => [m.platform_id, m.lower])).toEqual([
      ["5", 5],
      ["8", 25],
    ]);
    expect(pern).toMatchObject({ family: "per_n_yards", scalar: "pass_yd", complete_range: true });
  });
  it("orders families by class, then name, then scalar", () => {
    const f = families([89, 80, 17, 37, 56, 161, 167]);
    expect(f.map((x) => `${x.position_class}:${x.family}:${x.scalar}`)).toEqual([
      "O:yardage_bonus:pass_yd",
      "O:yardage_bonus:rec_yd",
      "O:yardage_bonus:rush_yd",
      "K:fg_distance:kick_distance",
      "DST:dst_points_allowed:dst_pa_raw",
      "HC:margin:team_loss_margin",
      "HC:margin:team_win_margin",
    ]);
  });
  it("skips unmapped rules, rules outside the registry and non-family rules", () => {
    const rules: ScoringRule[] = [
      {
        canonical: null,
        platform_id: "999",
        abbr: "#999",
        points: 1,
        overrides: {},
        is_reverse: false,
        applies_to: [],
        disputed: false,
      },
      {
        canonical: "custom_stat",
        platform_id: "998",
        abbr: "X",
        points: 1,
        overrides: {},
        is_reverse: false,
        applies_to: ["O"],
        disputed: false,
      },
      {
        canonical: "rec",
        platform_id: "53",
        abbr: "REC",
        points: 1,
        overrides: {},
        is_reverse: false,
        applies_to: ["O"],
        disputed: false,
      },
    ];
    expect(buildFamilies(rules)).toEqual([]);
  });
});

describe("bracketize (P4)", () => {
  const pa = only([89, 90, 91, 92, 121, 122, 123, 124, 125]);
  it("sets exactly one tier for any scalar inside a complete range (boundaries inclusive)", () => {
    expect(bracketize(pa, 0)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(bracketize(pa, 7)).toEqual([0, 0, 1, 0, 0, 0, 0, 0, 0]);
    expect(bracketize(pa, 17)).toEqual([0, 0, 0, 1, 0, 0, 0, 0, 0]);
    expect(bracketize(pa, 99)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1]);
  });
  it("sets none inside a recorded gap or outside the members", () => {
    const gappy = only([89, 90, 124, 125]);
    expect(bracketize(gappy, 20)).toEqual([0, 0, 0, 0]);
    expect(bracketize(only([129, 130]), 50)).toEqual([0, 0]);
    expect(bracketize(only([129, 130]), 350)).toEqual([0, 0]);
  });
  it("negative yards allowed fall in the open-low tier", () => {
    expect(bracketize(only([128, 129]), -12)).toEqual([1, 0]);
  });
  it("threshold bonuses are cumulative (A-2): a 412-yd game sets 300+ and 400+", () => {
    const [bonus] = families([17, 18]);
    expect(bracketize(bonus!, 412)).toEqual([1, 1]);
    expect(bracketize(bonus!, 300)).toEqual([1, 0]);
    expect(bracketize(bonus!, 299.9)).toEqual([0, 0]);
  });
  it("per-N is max(0, ⌊scalar/N⌋) — negative yards give 0 (recorded)", () => {
    const pern = only([5, 6, 8]);
    expect(bracketize(pern, 57)).toEqual([11, 5, 2]);
    expect(bracketize(pern, -5)).toEqual([0, 0, 0]);
    expect(bracketize(pern, 0)).toEqual([0, 0, 0]);
    expect(bracketize(pern, 75.78)).toEqual([15, 7, 3]);
  });
  it("long-TD lengths are underivable from a TD count except when it is zero", () => {
    const len = only([15, 16]);
    expect(bracketize(len, 0)).toEqual([0, 0]);
    expect(bracketize(len, 2)).toBeNull();
  });
  it("count families bin one kick into its bucket", () => {
    expect(bracketize(only([80, 77, 198, 201]), 52)).toEqual([0, 0, 1, 0]);
  });
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 2e9])(
    "refuses a non-finite or absurd scalar (%s)",
    (x) => {
      expect(() => bracketize(pa, x)).toThrow(expect.objectContaining({ code: "invalid_line" }));
    },
  );
});
