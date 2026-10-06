// types.test.ts — src/domain/analytics/types.ts: the coarse ΔP(win) reported under `position_cv`
// (never a two-decimal number — research 05 §3.2), the coin-flip rule per basis (|ΔP| under the
// threshold or the interval spans 0), and the plan's constants (plan 07 E1–E11; research 05).
import fc from "fast-check";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CLEARS_TO_FA_MIN_COLD_WIDTH,
  isValidClearsToFa,
  seedingStatus,
  type ClearsToFa,
  type LineupData,
  type ScheduleAnalysisData,
  type SeasonSimData,
  type SeedingStatus,
  type TradeEvaluationData,
  type WaiverCandidate,
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

describe("CAT-02: seeding.confirmed — a clean-negative field on every reading-dependent result", () => {
  it("is false until onboard records the reading (config seeding_confirmed_at)", () => {
    expect(seedingStatus("espn_rule", null)).toEqual({ mode_used: "espn_rule", confirmed: false });
    expect(seedingStatus("points_only", "")).toEqual({
      mode_used: "points_only",
      confirmed: false,
    });
    expect(seedingStatus("both", "2026-10-05T18:00:00.000Z")).toEqual({
      mode_used: "both",
      confirmed: true,
    });
    expect(Object.isFrozen(seedingStatus("espn_rule", null))).toBe(true);
  });
  it("E2, E3 season, E6 evaluation and E8 all carry it (type level)", () => {
    expectTypeOf<LineupData["seeding"]>().toEqualTypeOf<SeedingStatus>();
    expectTypeOf<SeasonSimData["seeding"]>().toEqualTypeOf<SeedingStatus>();
    expectTypeOf<TradeEvaluationData["seeding"]>().toEqualTypeOf<SeedingStatus>();
    expectTypeOf<ScheduleAnalysisData["seeding"]>().toEqualTypeOf<SeedingStatus>();
  });
});

describe("CAT-03: E5 p_clears_to_fa carries its own interval (q_i is cold-start)", () => {
  it("a cold-start result must have a non-degenerate interval containing p", () => {
    expect(isValidClearsToFa({ p: 0.4, interval: [0.2, 0.6], basis: "cold_start" })).toBe(true);
    expect(isValidClearsToFa({ p: 0.4, interval: [0.4, 0.4], basis: "cold_start" })).toBe(false);
    expect(isValidClearsToFa({ p: 0.4, interval: [0.38, 0.42], basis: "cold_start" })).toBe(false);
    expect(isValidClearsToFa({ p: 0.4, interval: [0.4, 0.4], basis: "league_fitted" })).toBe(true);
    expect(isValidClearsToFa({ p: 0.7, interval: [0.2, 0.6], basis: "league_fitted" })).toBe(false);
    expect(isValidClearsToFa({ p: Number.NaN, interval: [0, 1], basis: "cold_start" })).toBe(false);
    expect(isValidClearsToFa({ p: 0.5, interval: [-0.1, 1], basis: "cold_start" })).toBe(false);
    expect(CLEARS_TO_FA_MIN_COLD_WIDTH).toBe(0.05);
    expectTypeOf<WaiverCandidate["p_clears_to_fa"]>().toEqualTypeOf<ClearsToFa | null>();
  });
  it("property: valid iff 0 ≤ lo ≤ p ≤ hi ≤ 1 (and width ≥ 0.05 when cold-start)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -0.5, max: 1.5, noNaN: true }),
        fc.double({ min: -0.5, max: 1.5, noNaN: true }),
        fc.double({ min: -0.5, max: 1.5, noNaN: true }),
        fc.constantFrom<"cold_start" | "league_fitted">("cold_start", "league_fitted"),
        (p, lo, hi, basis) => {
          const unit = (x: number) => x >= 0 && x <= 1;
          const want =
            unit(p) &&
            unit(lo) &&
            unit(hi) &&
            lo <= p &&
            p <= hi &&
            (basis !== "cold_start" || hi - lo >= 0.05);
          return isValidClearsToFa({ p, interval: [lo, hi], basis }) === want;
        },
      ),
    );
  });
});
