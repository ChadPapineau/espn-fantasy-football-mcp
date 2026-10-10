// overrides.ts — applies the human-applied tuned parameters to v2 (plan 10 §3.3 and C9: the weekly
// re-fit is proposed by the retrospective and applied only by a human-run `eff tune --apply`, which
// writes `<config>/tuned-parameters.json`; src/domain/reclog/tune.ts owns that registry's names):
// each registry name maps to a V2Params path where the meaning is the same; a name with no v2
// counterpart, a non-finite value or one outside V2_PARAM_BOUNDS is ignored and listed — never
// guessed. `weight_espn` is the ensemble's request-level weight, returned apart. Pure. New here.
import { inBounds, withParam } from "./fit.js";
import type { V2Params } from "./types.js";

/**
 * The retrospective registry's names (src/domain/reclog/tune.ts TUNABLE_PARAMETERS) → V2Params
 * paths. `shrink_k.yards_per_target` and `shrink_k.yards_per_attempt` have no v2 counterpart (v2
 * shrinks yards per reception and per completion, with the catch and completion rates apart).
 */
export const TUNED_NAME_TO_V2_PATH: Readonly<Record<string, string>> = Object.freeze({
  ewm_half_life_games: "half_life_games",
  "shrink_k.catch_rate": "k.catch_rate",
  "shrink_k.yards_per_reception": "k.yards_per_rec",
  "shrink_k.yards_per_carry": "k.yards_per_carry",
  "shrink_k.completion_rate": "k.cmp_rate",
  "shrink_k.int_rate": "k.int_rate",
  "shrink_k.td_rate": "k.xtd",
  "matchup_beta.QB": "matchup_beta.QB",
  "matchup_beta.RB": "matchup_beta.RB",
  "matchup_beta.WR": "matchup_beta.WR",
  "matchup_beta.TE": "matchup_beta.TE",
});

/** What applying a set of tuned values did. */
export interface TunedApplication {
  readonly params: V2Params;
  /** The tuned ensemble weight, when one was applied and lies in [0, 1]. */
  readonly weight_espn: number | null;
  /** Registry names applied, sorted. */
  readonly applied: readonly string[];
  /** Registry names ignored (no v2 counterpart, non-finite, or out of bounds), sorted. */
  readonly ignored: readonly string[];
}

/** The parameters with every applicable tuned value set (the input is never mutated). */
export function applyTunedOverrides(
  base: V2Params,
  overrides: Readonly<Record<string, number>>,
): TunedApplication {
  let params = base;
  let weight: number | null = null;
  const applied: string[] = [];
  const ignored: string[] = [];
  for (const name of Object.keys(overrides).sort()) {
    const v = overrides[name];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      ignored.push(name);
      continue;
    }
    if (name === "weight_espn") {
      if (v >= 0 && v <= 1) {
        weight = v;
        applied.push(name);
      } else ignored.push(name);
      continue;
    }
    const path = Object.hasOwn(TUNED_NAME_TO_V2_PATH, name)
      ? TUNED_NAME_TO_V2_PATH[name]
      : undefined;
    if (path === undefined || !inBounds(path, v)) {
      ignored.push(name);
      continue;
    }
    params = withParam(params, path, v);
    applied.push(name);
  }
  return { params, weight_espn: weight, applied, ignored };
}
