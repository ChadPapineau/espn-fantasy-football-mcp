// rounding.ts — ESPN's rounding of points, pinned by the first golden run (plan 08 E4, §4.6; P9).
// The rule is ESPN's and never moves to fantasy-core (§10). The engine applies a mode only once
// verified; until then `points = points_exact`.
import { denoise, round2, stableSum } from "./numeric.js";
import type { RoundingMode } from "./types.js";

/**
 * ESPN's rule, discovered on fixtures/espn/recorded (league-a/b/c, weeks 1–3, 2026-10-06):
 * - `appliedStats{id}` is the plain double product `points × raw` — bit-identical on every one of
 *   the 2,788 recorded actual and projected lines (e.g. `12 × 0.1` → 1.2000000000000002);
 * - `appliedTotal` is their sum stored to 8 decimal places: on the 1,394 actual lines it equals the
 *   exact sum, Σ round2(stat) and round2(Σ) alike (all to 1e-9 — every actual product has ≤ 2 dp);
 *   on the 1,394 projected lines both 2-dp modes are refuted (|Δ| up to 0.005) and the exact sum
 *   agrees within 5e-9 (8-dp storage).
 * So no rounding is applied: mode `exact`, verified. Comparisons keep plan 08's 0.005 / 0.01.
 */
export const ESPN_ROUNDING: { readonly mode: RoundingMode; readonly verified: boolean } =
  Object.freeze({ mode: "exact", verified: true });

/** Decimal places ESPN stores `appliedTotal` with (observed; display storage, not a scoring rule). */
export const ESPN_APPLIED_TOTAL_DECIMALS = 8;

/** The three candidate totals of plan 08 §4.6 for one set of per-stat points. */
export interface RoundingCandidates {
  readonly exact: number;
  readonly per_stat_2dp: number;
  readonly per_total_2dp: number;
}

/** Σ points, Σ round2(points) and round2(Σ points) — what the golden compares with `appliedTotal`. */
export function roundingCandidates(perStat: readonly number[]): RoundingCandidates {
  const exact = denoise(stableSum(perStat));
  return Object.freeze({
    exact,
    per_stat_2dp: denoise(stableSum(perStat.map(round2))),
    per_total_2dp: round2(exact),
  });
}

/**
 * The points a rounding rule gives (P9): `exact` (or any unverified rule) leaves the exact total;
 * a verified `per_total_2dp` rounds the total; a verified `per_stat_2dp` sums the rounded
 * per-stat points. Idempotent on its own output for the total modes.
 */
export function applyRounding(
  exact: number,
  perStat: readonly number[],
  rounding: { readonly mode: RoundingMode; readonly verified: boolean },
): number {
  if (!rounding.verified) return exact;
  switch (rounding.mode) {
    case "exact":
      return exact;
    case "per_total_2dp":
      return round2(exact);
    case "per_stat_2dp":
      return denoise(stableSum(perStat.map(round2)));
  }
}
