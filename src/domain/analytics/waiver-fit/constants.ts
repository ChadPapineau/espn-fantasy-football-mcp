// constants.ts — the fitted waiver DP's settings (plan 10 §3.3 C5; research 05 §1.6 eval 3: "estimate
// the league's surplus distribution and c from history and re-solve Π"; §8.4 calibration checks: the
// retrospective refuses conclusions from fewer than ~30 calls of a type). Each value is a recorded
// decision where the plan is silent (docs/evals/phase3-waivers-seeding.md). New here (Phase 3).
// Stage C (changelog R6-3, additive): the previous-season feed's settings and the cold start's
// measured miss.
import { WAIVER_DP } from "../constants.js";

export const WAIVER_FIT = Object.freeze({
  /**
   * The rate support (points per week over the drop candidate) the fitted distribution lives on:
   * the cold-start table's six rates, extended upward because a league's own wire can be richer
   * (research 05 §1.6: the hindsight best claim runs 6–12 per week). An observation is split
   * linearly between its two neighbours (the mean is kept); above the top it is clamped (counted).
   */
  support: Object.freeze([0, 1, 2.5, 4.5, 7, 10, 14, 20]),
  /**
   * The cold-start distribution as a Dirichlet prior, worth this many runs (about half a regular
   * season): one season of runs outweighs it, a handful does not.
   */
  surplusPriorRuns: 8,
  /** Runs observed before `premium_basis` may become `league_fitted` (one regular season, weeks 2–14). */
  minRuns: 13,
  /** The cold-start drift c (research 05 §1.2) as a Beta prior, worth this many team-weeks. */
  driftPrior: WAIVER_DP.drift,
  driftPriorTeamWeeks: 40,
  /** Team-weeks observed before the drift leaves its prior (research 05 §8.4's ~30 floor). */
  minTeamWeeks: 30,
  /** z for the drift's 90 % interval. */
  z90: 1.6449,
  /** Reliability bins for P(clears_to_FA) (deciles of the predicted probability). */
  calibrationBins: 10,
  /** A bin is judged only with at least this many observations. */
  minBinN: 10,
  /** Below this many observations a calibration is soft (research 05 §8.4; plan 10 C5). */
  softBelow: 30,
  /** "Calibrated within ±10 points" (research 05 §1.6, §8.4; plan 10 C5). */
  tolerance: 0.1,
  /** The demand-scale search bounds (a multiplier on the cold-start q(r)). */
  demandScale: Object.freeze({ min: 0.05, max: 5 }),
  /**
   * The demand-curve search bounds (B2b fix: research 05 §1.3's intercept and slope fitted
   * separately, q(r) = min(qCap, q0 + q1·r) — a pure multiplier cannot fit both the near-zero demand
   * for a dropped bench player and the demand for a real target). q0 per rival per run; q1 per
   * point-per-week of surplus. Both bounds hold the cold start (0.05, 0.08) well inside.
   */
  demandCurve: Object.freeze({
    q0: Object.freeze({ min: 0.0005, max: 0.5 }),
    q1: Object.freeze({ min: 0.0005, max: 1 }),
  }),
  /**
   * The league's previous seasons as its own feed (changelog R6-3; plan 07 E5 "the league's own
   * feed"). Decisions fixed before any held-out season was read (docs/evals/phase3-waivers-seeding.md):
   */
  history: Object.freeze({
    /** Previous seasons read, newest first (plan 10 §3.2's "two prior seasons" history window). */
    maxSeasons: 2,
    /** Waiver candidates (drops with a visible fate) before the demand curve leaves the cold start (= softBelow). */
    minOutcomes: 30,
    /**
     * A "valued" candidate: his per-week value over replacement is at least this (research 05
     * §1.2's rate support — 2.5 is the first rate a real target carries).
     */
    valuedRate: 2.5,
    /** Valued candidates before the slope may be read from the data (= minBinN). */
    minValued: 10,
    /**
     * Valued candidates that were CLAIMED before the slope may be read from the data. R6-3: a slope
     * read off drops that cleared would call a starter-calibre drop near-certain to clear — the one
     * case the tool must get right — so a value slope needs claims at value, not only clears.
     */
    minValuedClaims: 3,
    /**
     * A drop counts as claimed when another team's won claim of him is processed within this window
     * after the drop (one weekly waiver cycle plus a day; 1-day waivers process the next morning).
     */
    fateWindowMs: 8 * 24 * 3600 * 1000,
  }),
  /**
   * What the cold start measured against real data (docs/evals/phase3-waivers-seeding.md, C5): E5
   * states it whenever it serves the cold start (changelog R6-3). Held equal to the generated
   * numbers by tests/backtest/waivers-clears.test.ts and tests/backtest/waivers-fitted.test.ts.
   */
  coldStartMiss: Object.freeze({
    /** P(clears_to_FA) too low, in percentage points (calibration in the large, league-b 2024 / 2025 drops). */
    clearsPoints: Object.freeze({ min: 46.6, max: 49.2 }),
    /** Π fitted / Π cold at W = 9, k = 1 and k = 10 (the replay league's pooled v2-opportunity feed). */
    premiumRatio: Object.freeze({ min: 0.96, max: 1.23 }),
    /**
     * P(clears_to_FA) still too low, in points, when the intercept is the league's own and the slope
     * the cold start's (league-b 2025 held out, the curve E5 serves fitted on 2024; R6-3 section).
     */
    slopeClearsPoints: 22.1,
    source: "docs/evals/phase3-waivers-seeding.md",
  }),
});
