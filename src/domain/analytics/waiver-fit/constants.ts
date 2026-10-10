// constants.ts — the fitted waiver DP's settings (plan 10 §3.3 C5; research 05 §1.6 eval 3: "estimate
// the league's surplus distribution and c from history and re-solve Π"; §8.4 calibration checks: the
// retrospective refuses conclusions from fewer than ~30 calls of a type). Each value is a recorded
// decision where the plan is silent (docs/evals/phase3-waivers-seeding.md). New here (Phase 3).
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
});
