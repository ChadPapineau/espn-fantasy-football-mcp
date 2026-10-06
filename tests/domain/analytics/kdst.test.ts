// kdst.test.ts — the K/D-ST bracket model (plan 07 C5; research 05 §5 K and D/ST streaming): tier
// probabilities from the gamma CDF and tier points from the league's own S (a hand-built league
// that scores only "0 points allowed" gives exactly P(PA = 0)); monotone in the implied totals; the
// kicker's expected line scored linearly, the legacy 50+ items included; deterministic.
import { describe, expect, it } from "vitest";
import {
  dstExpectation,
  isKdst,
  kdstExpectation,
  kickerExpectation,
} from "../../../src/domain/analytics/kdst.js";
import { KDST } from "../../../src/domain/analytics/constants.js";
import { gammaCdfMeanCv } from "../../../src/domain/analytics/math.js";
import { normalizeSettings } from "../../../src/domain/scoring/settings.js";
import { referenceSettings } from "./helpers.js";

const only = (
  items: { statId: number; points: number; pointsOverrides?: Record<string, number> }[],
) => normalizeSettings({ scoringItems: items });

describe("D/ST", () => {
  it("brackets_e is the league's tier points weighted by the gamma tier probabilities", () => {
    const s = only([{ statId: 89, points: 0, pointsOverrides: { "16": 1 } }]);
    const e = dstExpectation(s, 20);
    expect(e.brackets_e).toBeCloseTo(gammaCdfMeanCv(0.5, 20, KDST.pointsAllowedCv), 3);
    expect(e.sacks_e).toBe(0);
    expect(e.e).toBeCloseTo(e.brackets_e, 6);
  });

  it("a lower opponent implied total gives more bracket points, sacks and takeaways", () => {
    const s = referenceSettings();
    const easy = dstExpectation(s, 14);
    const hard = dstExpectation(s, 30);
    expect(easy.brackets_e).toBeGreaterThan(hard.brackets_e);
    expect(easy.sacks_e ?? 0).toBeGreaterThan(hard.sacks_e ?? 0);
    expect(easy.takeaways_e ?? 0).toBeGreaterThan(hard.takeaways_e ?? 0);
    expect(easy.rare_c).toBe(hard.rare_c);
    expect(easy.e).toBeCloseTo(
      easy.brackets_e + (easy.sacks_e ?? 0) + (easy.takeaways_e ?? 0) + (easy.rare_c ?? 0),
      2,
    );
    expect(easy.opp_implied_total).toBe(14);
  });

  it("an unknown implied total reads the league average and says so (null in the detail)", () => {
    const s = referenceSettings();
    const unknown = dstExpectation(s, null);
    expect(unknown.opp_implied_total).toBeNull();
    expect(unknown.e).toBe(dstExpectation(s, KDST.leagueImplied).e);
    expect(dstExpectation(s, Number.NaN).e).toBe(unknown.e);
    expect(dstExpectation(s, -3).e).toBe(unknown.e);
  });

  it("is deterministic and memoised per settings object", () => {
    const s = referenceSettings();
    expect(dstExpectation(s, 21.5)).toEqual(dstExpectation(s, 21.5));
  });
});

describe("kickers", () => {
  it("more implied points → more expected kicker points; the distance items carry the brackets", () => {
    const s = referenceSettings();
    const hi = kickerExpectation(s, 30);
    const lo = kickerExpectation(s, 15);
    expect(hi.e).toBeGreaterThan(lo.e);
    expect(hi.brackets_e).toBeGreaterThan(0);
    expect(hi.e).toBeGreaterThan(hi.brackets_e);
    expect(hi.sacks_e).toBeNull();
    expect(hi.implied_total).toBe(30);
    expect(kickerExpectation(s, null).implied_total).toBeNull();
  });

  it("a league scoring only the legacy 50+ item (74) still values long kicks", () => {
    const legacy = only([{ statId: 74, points: 5 }]);
    const e = kickerExpectation(legacy, KDST.leagueImplied);
    const longMade = KDST.fgMix
      .filter((b) => b.distance >= 50)
      .reduce((a, b) => a + KDST.fgAttempts * b.share * b.make, 0);
    expect(e.e).toBeCloseTo(5 * longMade, 3);
  });

  it("kdstExpectation routes by position; isKdst names the streaming positions", () => {
    const s = referenceSettings();
    expect(kdstExpectation("K", s, 25, 20)).toEqual(kickerExpectation(s, 25, 20));
    expect(kdstExpectation("D/ST", s, 25, 20)).toEqual(dstExpectation(s, 20, 25));
    expect(isKdst("K")).toBe(true);
    expect(isKdst("D/ST")).toBe(true);
    expect(isKdst("QB")).toBe(false);
  });
});
