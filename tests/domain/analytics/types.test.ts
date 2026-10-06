// types.test.ts — src/domain/analytics/types.ts: the coarse ΔP(win) reported under `position_cv`
// (never a two-decimal number — research 05 §3.2), the coin-flip rule per basis (|ΔP| under the
// threshold or the interval spans 0), and the plan's constants (plan 07 E1–E11; research 05).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ANALYTICS_RESULT_CHARS,
  COARSE_BAND_CUTOFFS,
  COIN_FLIP_DPWIN,
  DISAGREEMENT_FLAG_PCT,
  EVIDENCE_POSTERIOR_MIN_N,
  GAME_DAY_WINDOW_MS,
  PF_PER_WIN_COLD_START,
  PREMIUM_BAND_MULTIPLIERS,
  WEIGHT_ESPN_V1,
  isCoinFlip,
  toCoarseDelta,
} from "../../../src/domain/analytics/types.js";
import { RESULT_BUDGET_CHARS } from "../../../src/mcp/envelope.js";

describe("toCoarseDelta", () => {
  it.each([
    [0, "0", "small"],
    [0.004, "0", "small"],
    [-0.004, "0", "small"],
    [0.005, "+", "small"],
    [-0.005, "-", "small"],
    [0.039, "+", "small"],
    [0.04, "+", "medium"],
    [-0.0999, "-", "medium"],
    [0.1, "+", "large"],
    [-0.75, "-", "large"],
    [1, "+", "large"],
  ] as const)("%s → %s/%s", (d, sign, band) => {
    expect(toCoarseDelta(d)).toEqual({ sign, band });
  });
  it.each([Number.NaN, Infinity, -Infinity])("non-finite %s reads 0/small", (d) => {
    expect(toCoarseDelta(d)).toEqual({ sign: "0", band: "small" });
  });
  it("property: sign follows the value beyond the zero band; band is monotone in |Δ|", () => {
    const rank = { small: 0, medium: 1, large: 2 } as const;
    fc.assert(
      fc.property(
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        (a, b) => {
          const ca = toCoarseDelta(a);
          if (Math.abs(a) >= COARSE_BAND_CUTOFFS.zero && ca.sign !== (a > 0 ? "+" : "-"))
            return false;
          const cb = toCoarseDelta(b);
          return Math.abs(a) <= Math.abs(b)
            ? rank[ca.band] <= rank[cb.band]
            : rank[ca.band] >= rank[cb.band];
        },
      ),
    );
  });
});

describe("isCoinFlip", () => {
  it("under the basis threshold is a coin flip whatever the interval", () => {
    expect(isCoinFlip("position_cv", 0.039, [0.01, 0.06])).toBe(true);
    expect(isCoinFlip("player_sim", -0.019, [-0.03, -0.01])).toBe(true);
  });
  it("at or over the threshold it is a coin flip only when the interval spans 0", () => {
    expect(isCoinFlip("position_cv", 0.04, [0.01, 0.07])).toBe(false);
    expect(isCoinFlip("position_cv", 0.04, [-0.01, 0.09])).toBe(true);
    expect(isCoinFlip("player_sim", 0.02, [0.001, 0.04])).toBe(false);
    expect(isCoinFlip("player_sim", -0.3, [-0.5, 0])).toBe(true);
    expect(isCoinFlip("player_sim", 0.3, [0, 0.5])).toBe(true);
  });
  it("the thresholds differ by basis (sim is sharper)", () => {
    expect(COIN_FLIP_DPWIN).toEqual({ position_cv: 0.04, player_sim: 0.02 });
    expect(isCoinFlip("position_cv", 0.03, [0.01, 0.05])).toBe(true);
    expect(isCoinFlip("player_sim", 0.03, [0.01, 0.05])).toBe(false);
  });
  it.each([Number.NaN, Infinity, -Infinity])(
    "a non-finite ΔP (%s) is a coin flip (never a confident call)",
    (d) => {
      expect(isCoinFlip("player_sim", d, [0.1, 0.2])).toBe(true);
    },
  );
});

describe("analytics constants", () => {
  it("match the plan", () => {
    expect(WEIGHT_ESPN_V1).toBe(1);
    expect(DISAGREEMENT_FLAG_PCT).toBe(0.25);
    expect(PF_PER_WIN_COLD_START).toBe(120);
    expect(PREMIUM_BAND_MULTIPLIERS).toEqual({ low: 0.5, high: 1.5 });
    expect(EVIDENCE_POSTERIOR_MIN_N).toBe(200);
    expect(GAME_DAY_WINDOW_MS).toBe(3 * 3_600_000);
    expect(COARSE_BAND_CUTOFFS.zero).toBeLessThan(COARSE_BAND_CUTOFFS.small);
    expect(COARSE_BAND_CUTOFFS.small).toBeLessThan(COARSE_BAND_CUTOFFS.medium);
  });
  it("the analytics budget is half the result budget", () => {
    expect(ANALYTICS_RESULT_CHARS).toBe(10_000);
    expect(ANALYTICS_RESULT_CHARS * 2).toBe(RESULT_BUDGET_CHARS);
  });
});
