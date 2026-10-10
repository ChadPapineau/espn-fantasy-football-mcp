// attribution-helpers.ts — builders for the Phase 3 attribution and tune tests (plan 10 C9): an
// attribution row over the fixture roster's public ESPN ids, the reference league's scoring (fx-10h:
// half-PPR, 5-pt pass TD, −2 INT / fumble lost, 0.1 per rushing/receiving yard, 0.04 per passing
// yard — no points for targets or attempts), v2 traces, and attributed rows built directly for the
// fit tests. Placeholders only; nothing is fetched.
import type {
  PlayerWeekAttribution,
  ProjectionTrace,
} from "../../../src/domain/reclog/attribution.js";
import { ATTRIBUTION_LAYERS, type AttributionRow } from "../../../src/domain/reclog/attribution.js";
import type { ScoringSettings } from "../../../src/domain/scoring/index.js";
import { referenceSettings } from "../../backtest/helpers/waivers.js";
import { RB1 } from "./helpers.js";

let cached: ScoringSettings | null = null;
/** The reference league's scoring (fx-10h mSettings through the shipped normaliser). */
export function leagueScoring(): ScoringSettings {
  cached ??= referenceSettings();
  return cached;
}

/** ESPN position ids (research 03 §B.2). */
export const POS_ID = Object.freeze({ QB: 1, RB: 2, WR: 3, TE: 4, K: 5, "D/ST": 16 });

/** An RB row: expected 15 carries / 60 yd / 0.5 TD + 4 targets / 3 rec / 25 yd; realised richer. */
export function row(over: Partial<AttributionRow> = {}): AttributionRow {
  return {
    week: 5,
    player_id: RB1.id,
    gsis_id: RB1.gsis,
    position: "RB",
    position_id: POS_ID.RB,
    model_version: "v2-opportunity",
    reported_mean: 14,
    p_active: 0.9,
    expected: {
      rush_att: 15,
      rush_yd: 60,
      rush_td: 0.5,
      targets: 4,
      rec: 3,
      rec_yd: 25,
      rec_td: 0,
      fum_lost: 0,
    },
    active: true,
    realised: {
      rush_att: 20,
      rush_yd: 100,
      rush_td: 1,
      targets: 2,
      rec: 2,
      rec_yd: 10,
      rec_td: 0,
      fum_lost: 0,
    },
    realised_source: "espn",
    realised_points: 18,
    espn_mean: 14,
    trace: null,
    ...over,
  };
}

/** A v2 trace with one share window and one rate. */
export function trace(over: Partial<ProjectionTrace> = {}): ProjectionTrace {
  return {
    matchup: { z: 0.5, beta: 0.2 },
    weather_mult: null,
    shares: [{ name: "carry_share", history: [0.5, 0.55, 0.6], half_life: 3, realised: 0.62 }],
    rates: [
      {
        name: "yards_per_carry",
        n_obs: 60,
        observed: 4.8,
        prior: 4.2,
        k: 200,
        realised: 5,
        realised_n: 20,
      },
    ],
    ...over,
  };
}

const zeros = (): Record<(typeof ATTRIBUTION_LAYERS)[number], number> =>
  Object.fromEntries(ATTRIBUTION_LAYERS.map((l) => [l, 0])) as Record<
    (typeof ATTRIBUTION_LAYERS)[number],
    number
  >;

/** An attributed row built directly (the fit tests read only a few fields). */
export function attributed(over: Partial<PlayerWeekAttribution> = {}): PlayerWeekAttribution {
  return {
    week: 5,
    player_id: null,
    gsis_id: null,
    position: "RB",
    active: true,
    error: 0,
    layers: zeros(),
    reported_mean: 10,
    realised_points: 10,
    expected_points: 10,
    model_mean: 10,
    realised_engine: 10,
    espn_mean: null,
    matchup_lift: null,
    weather_lift: null,
    trace: null,
    ...over,
  };
}

/** A tiny deterministic LCG in [0, 1) for synthetic evidence (no Math.random in tests either). */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
