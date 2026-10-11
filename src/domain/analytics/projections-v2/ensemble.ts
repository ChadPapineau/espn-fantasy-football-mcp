// ensemble.ts — the ensemble of ESPN's mean and the opportunity model (plan 07 E1: weight_espn; ADV
// OBJ-02; plan 10 B14): the served mean is weight_espn × ESPN + (1 − weight_espn) × own. The
// distribution around it is the opportunity simulation's AT that mean: the difference between the two
// means is attributed to volume (sib §1 step 0 — volume is the sticky, well-informed part: a
// projection that knows a teammate is out or a role has changed differs from a trailing window mainly
// in opportunities), so the expected opportunities are scaled by f = target / own-active-mean before
// simulating (counts are Poisson, so the spread grows like √f, not like f) and a final rescale of the
// simulated points pins the mean exactly. A factor outside [1/maxRescale, maxRescale], or no own
// volume at all, leaves the caller on the positional-CV gamma. The anchored expectation is marked
// `anchored`, so the own simulation's per-position dispersion (Stage C, `sim.position`) stays off it:
// that dispersion is the own mean's uncertainty, which ESPN's mean does not carry. Pure. New here.
import { score } from "../../scoring/engine.js";
import type { ScoringSettings } from "../../scoring/types.js";
import { V2_SIMS } from "./constants.js";
import { expectedLine } from "./simulate.js";
import type { V2Expectation } from "./types.js";

/** The expected points of an expectation if active (the engine on the expected line). */
export function activePoints(e: V2Expectation, settings: ScoringSettings): number {
  try {
    return score(expectedLine(e), settings).points_exact;
  } catch {
    return 0;
  }
}

/** The expectation with every opportunity scaled by f (rates unchanged). */
export function scaleVolume(e: V2Expectation, f: number): V2Expectation {
  return {
    ...e,
    team_dropbacks: e.team_dropbacks * f,
    pass_att: e.pass_att * f,
    targets: e.targets * f,
    carries: e.carries * f,
  };
}

/** An anchoring of the simulation to a target mean. */
export interface Anchor {
  /** The expectation to simulate (volume-scaled), or null: use the positional-CV gamma. */
  readonly expectation: V2Expectation | null;
  readonly factor: number;
}

/**
 * The expectation whose simulation carries `target` as its mean (P(active) applied by the
 * simulator), or `expectation: null` when it cannot (no own volume, or a factor outside the band).
 */
export function anchorExpectation(
  e: V2Expectation,
  pActive: number,
  target: number,
  settings: ScoringSettings,
  roleScale = 1,
): Anchor {
  const base = activePoints(e, settings) * Math.max(0, Math.min(1, pActive));
  if (!(target > 0) || !(base > 0)) return { expectation: null, factor: Number.NaN };
  const f = target / base;
  if (!(f >= 1 / V2_SIMS.maxRescale && f <= V2_SIMS.maxRescale))
    return { expectation: null, factor: f };
  const scaled = Math.abs(f - 1) < 1e-9 ? e : scaleVolume(e, f);
  // always a new expectation marked `anchored`: the own simulation's per-position dispersion is the
  // own mean's uncertainty, which an external mean does not carry (simulate.ts dispersionOf)
  return {
    expectation: {
      ...scaled,
      anchored: true,
      ...(roleScale === 1 ? {} : { role_cv_scale: roleScale }),
    },
    factor: f,
  };
}
