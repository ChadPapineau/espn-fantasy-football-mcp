// types.test.ts — src/domain/scoring/types.ts (plan 08 §2 contract; §3.4 position ids distinct from
// slot ids; §4 families; §6 golden tolerances and the E6 refusal share; E9 disputed 103/104).
// A 100 %-coverage module (plan 05 §7: src/domain/scoring/**).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BRACKET_FAMILY_NAMES,
  CANONICAL_NAME_RE,
  DISPUTED_STAT_IDS,
  DIST_BASES,
  GOLDEN_TOLERANCE,
  LEAGUE_MISMATCH_REFUSAL_SHARE,
  POSITION_CLASSES,
  asPositionId,
} from "../../../src/domain/scoring/types.js";

describe("asPositionId (a position id is never a slot id — research 03 §B.2)", () => {
  it("brands every integer 0..99 unchanged", () => {
    for (const n of [0, 1, 15, 16, 99]) expect(asPositionId(n)).toBe(n);
  });
  it.each([-1, 100, 1.5, Number.NaN, Infinity, -Infinity, -0.5, 2 ** 53])("refuses %s", (n) => {
    expect(() => asPositionId(n)).toThrow(RangeError);
    expect(() => asPositionId(n)).toThrow("scoring: invalid position id");
  });
  it("property: accepts exactly the integers in range", () => {
    fc.assert(
      fc.property(fc.double({ min: -1000, max: 1000, noNaN: false }), (n) => {
        const ok = Number.isInteger(n) && n >= 0 && n <= 99;
        try {
          return asPositionId(n) === n && ok;
        } catch (e) {
          return e instanceof RangeError && !ok;
        }
      }),
    );
  });
});

describe("scoring vocabularies", () => {
  it("canonical names: lowercase snake, ≤ 40 chars, letter first", () => {
    for (const ok of ["pass_yds", "rec", "fg_made_50_plus", "a".repeat(40)])
      expect(CANONICAL_NAME_RE.test(ok), ok).toBe(true);
    for (const bad of ["", "Pass", "1st", "_x", "a".repeat(41), "pass-yds", "pass yds", "x\n"])
      expect(CANONICAL_NAME_RE.test(bad), bad).toBe(false);
  });
  it("position classes and distribution bases are frozen and complete", () => {
    expect(POSITION_CLASSES).toEqual(["O", "K", "DST", "HC", "IDP"]);
    expect(Object.isFrozen(POSITION_CLASSES)).toBe(true);
    expect(DIST_BASES).toEqual(["position_cv", "player_sim"]);
    expect(Object.isFrozen(DIST_BASES)).toBe(true);
  });
  it("the nine bracket families (plan 08 §4) are distinct canonical names", () => {
    expect(BRACKET_FAMILY_NAMES).toHaveLength(9);
    expect(new Set(BRACKET_FAMILY_NAMES).size).toBe(9);
    for (const f of BRACKET_FAMILY_NAMES) expect(CANONICAL_NAME_RE.test(f), f).toBe(true);
    expect(BRACKET_FAMILY_NAMES).toContain("dst_points_allowed");
    expect(BRACKET_FAMILY_NAMES).toContain("fg_distance");
  });
  it("golden tolerances, the refusal share and the disputed ids are plan 08's numbers", () => {
    expect(GOLDEN_TOLERANCE).toEqual({ per_stat: 0.005, per_total: 0.01 });
    expect(Object.isFrozen(GOLDEN_TOLERANCE)).toBe(true);
    expect(LEAGUE_MISMATCH_REFUSAL_SHARE).toBe(0.1);
    expect(DISPUTED_STAT_IDS).toEqual(["103", "104"]);
    expect(Object.isFrozen(DISPUTED_STAT_IDS)).toBe(true);
  });
});
