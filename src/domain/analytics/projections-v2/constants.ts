// constants.ts — every constant of the `v2-opportunity` model in ONE place (plan 10 §3.3; plan 07
// E1; sibling research 05 §1 steps 0–9 and §1-Evaluation; research 05 §3.2, §5, §8.4). Values marked
// [V-data] were measured on the committed nflverse excerpt's TRAINING season (2023 — the held-out
// seasons 2024–2025 never set a constant; tests/domain/analytics/projections-v2/data/README.md);
// [fit] values were chosen by `fitV2Params` on 2023 weeks 4–17 (docs/evals/phase3-projections.md);
// [V-lit] carry the sibling's cited figure; [U] are unverified starting points the retrospective and
// `eff tune` may move (plan 10 C9 — a human applies them). Nothing is inline in the engines.
import type { V2Params, V2Position, V2PositionPriors, V2Priors } from "./types.js";

/** The model this module implements (plan 07 E1). */
export const MODEL_VERSION_V2 = "v2-opportunity" as const;
/** The canonical-line source tag of v2's simulated lines (plan 08 §2 StatLineSource). */
export const PROJECTION_SOURCE_V2 = "projection:v2-opportunity" as const;

/**
 * The ensemble weight on ESPN's mean that v2 ships with (plan 07 E1, ADV OBJ-02; plan 10 B14): 1.0 —
 * ESPN's mean is the point estimate; the opportunity simulation shapes the distribution and flags
 * disagreement. It moves below 1 only when a backtest under the league's scoring shows a shadow
 * mixture beats ESPN alone on CRPS and MAE. On league-b's recorded 2024–2025 box scores (game-day
 * values) the 0.75 mixture won MAE in both seasons and CRPS in 2025 but tied 2024's CRPS inside the
 * evaluation's Monte-Carlo noise, and 0.5 lost 2024's CRPS — so it stays 1.0 (docs/evals/
 * phase3-projections.md "Shadow weights"; the prospective B14 run on pre-game snapshots decides next).
 */
export const WEIGHT_ESPN_V2 = 1.0;
/** The shadow weights evaluated beside the shipped one (plan 10 B14). */
export const SHADOW_WEIGHTS = Object.freeze([0.5, 0.75] as const);

/** The positions modelled. */
export const V2_POSITIONS: readonly V2Position[] = Object.freeze(["QB", "RB", "WR", "TE"]);

/** ESPN position ids of the modelled positions (research 03 §B.2). */
export const V2_POSITION_IDS: Readonly<Record<V2Position, number>> = Object.freeze({
  QB: 1,
  RB: 2,
  WR: 3,
  TE: 4,
});

/** Fewest games before a player's own window is used at all (else: no v2 projection). */
export const V2_MIN_GAMES = 1;

/**
 * The default parameters [fit] (sib §1: h ≈ 3 games, k per stat, β_pos small; research 05 §8.4:
 * tuned on one season, tested on another): `fitV2Params` on the 2023 weeks 4–17 cases (2,694; mean
 * CRPS 3.582 → 3.547, helpers/run-fit.ts; docs/evals/phase3-projections.md "Tuning"). Several k's
 * ended at the grid's low edge — on this data efficiency persists more than sib §1 step 4's
 * stabilisation figures suggest against a positional prior; recorded, not extrapolated.
 */
export const DEFAULT_V2_PARAMS: V2Params = Object.freeze({
  half_life_games: 8,
  /** [U] untunable on 2023 (the excerpt holds no 2022): the prior-season weight stays a choice. */
  prior_season_weight: 0.6,
  max_games: 16,
  change_point: Object.freeze({
    snap_delta: 0.15,
    share_delta: 0.08,
    hold_games: 2,
    pre_weight: 0.1,
  }),
  team: Object.freeze({
    half_life_games: 6,
    shrink_games: 4,
    /** [V-data] 2023 team-games: dropbacks −0.094 and rushes +0.246 per point of team-side spread. */
    spread_db: 0.094,
    spread_ru: 0.246,
  }),
  k: Object.freeze({
    catch_rate: 10,
    yards_per_rec: 10,
    yards_per_carry: 30,
    cmp_rate: 50,
    yards_per_cmp: 50,
    int_rate: 800,
    sack_rate: 150,
    fumble_rate: 300,
    xtd: 40,
    share: 1,
  }),
  market_td_theta: 1.5,
  matchup_beta: Object.freeze({ QB: 0.25, RB: 0.25, WR: 0.5, TE: 0 }),
  matchup_full_games: 8,
  sim: Object.freeze({
    cv_common: 0.12,
    cv_pass: 0.12,
    cv_rush: 0.18,
    cv_share: 0.2,
    share_role_games: 2,
    cv_eff: 0.15,
    /**
     * [V-data] moment-matched on the 2023 QB cases (helpers/run-calibrate-qb.ts): the starter's role
     * draw at half the others', a small efficiency draw coupled to the pass-volume draw (within-QB
     * corr(attempts, yards per attempt) −0.16 in 2023), interceptions drawn from the incompletions
     * and costing their drive's remaining yards and touchdown chance (within-QB corr(INT, non-turnover
     * points) −0.13 in 2023; the simulation gives −0.13 at these values).
     */
    qb_role_scale: 0.5,
    cv_eff_qb: 0.05,
    int_eff_power: 1,
    int_drive_yards: 20,
    int_drive_td: 0.165,
    script_coupling: 1,
    cv_yds_catch: 0.7,
    cv_yds_carry: 1.8,
    cv_yds_cmp: 0.5,
    anchor_role_scale: 1,
  }),
});

/** Search bounds `fitV2Params` respects (a proposal outside them is refused). */
export const V2_PARAM_BOUNDS = Object.freeze({
  half_life_games: Object.freeze([1, 12] as const),
  prior_season_weight: Object.freeze([0, 1] as const),
  market_td_theta: Object.freeze([0, 2] as const),
  matchup_beta: Object.freeze([0, 1] as const),
  k: Object.freeze([1, 5000] as const),
  cv: Object.freeze([0, 2] as const),
});

/** Positional priors [V-data, 2023 excerpt: QB/RB/WR/TE regular-season weeks 1–18]. */
const P = (x: V2PositionPriors): V2PositionPriors => Object.freeze(x);
export const DEFAULT_V2_PRIORS: V2Priors = Object.freeze({
  positions: Object.freeze({
    QB: P({
      target_share: 0.0003,
      carry_share: 0.1274,
      dropback_share: 0.8228,
      catch_rate: 0.6,
      yards_per_rec: 8,
      yards_per_carry: 4.13,
      cmp_rate: 0.645,
      yards_per_cmp: 10.88,
      int_rate: 0.0235,
      sack_rate: 0.0711,
      fumble_rate: 0.0377,
      xtd_per_target: 0.02,
      xtd_per_carry: 0.048,
      xtd_per_att: 0.0409,
      td_rz_target: 0.2,
      td_other_target: 0.02,
      td_gl_carry: 0.45,
      td_rz_carry: 0.12,
      td_other_carry: 0.015,
      two_pt_per_td: 0.02,
    }),
    RB: P({
      target_share: 0.0579,
      carry_share: 0.2766,
      dropback_share: 0.0002,
      catch_rate: 0.776,
      yards_per_rec: 7.16,
      yards_per_carry: 4.14,
      cmp_rate: 0.6,
      yards_per_cmp: 8,
      int_rate: 0.03,
      sack_rate: 0.07,
      fumble_rate: 0.0043,
      xtd_per_target: 0.0286,
      xtd_per_carry: 0.0284,
      xtd_per_att: 0.04,
      td_rz_target: 0.16,
      td_other_target: 0.012,
      td_gl_carry: 0.36,
      td_rz_carry: 0.09,
      td_other_carry: 0.008,
      two_pt_per_td: 0.02,
    }),
    WR: P({
      target_share: 0.1153,
      carry_share: 0.007,
      dropback_share: 0.0003,
      catch_rate: 0.63,
      yards_per_rec: 12.62,
      yards_per_carry: 6,
      cmp_rate: 0.6,
      yards_per_cmp: 10,
      int_rate: 0.03,
      sack_rate: 0.07,
      fumble_rate: 0.0061,
      xtd_per_target: 0.0464,
      xtd_per_carry: 0.0496,
      xtd_per_att: 0.04,
      td_rz_target: 0.22,
      td_other_target: 0.022,
      td_gl_carry: 0.4,
      td_rz_carry: 0.12,
      td_other_carry: 0.03,
      two_pt_per_td: 0.02,
    }),
    TE: P({
      target_share: 0.086,
      carry_share: 0.0033,
      dropback_share: 0.0003,
      catch_rate: 0.713,
      yards_per_rec: 10.22,
      yards_per_carry: 4.14,
      cmp_rate: 0.6,
      yards_per_cmp: 10,
      int_rate: 0.03,
      sack_rate: 0.07,
      fumble_rate: 0.0065,
      xtd_per_target: 0.0465,
      xtd_per_carry: 0.0381,
      xtd_per_att: 0.04,
      td_rz_target: 0.24,
      td_other_target: 0.018,
      td_gl_carry: 0.4,
      td_rz_carry: 0.1,
      td_other_carry: 0.02,
      two_pt_per_td: 0.02,
    }),
  }),
  team_dropbacks: 36.49,
  team_rushes: 26.76,
  team_implied: 21.53,
});

/**
 * The P(active) prior by designation (sibling research 05 §3.5 [V-lit]: Questionable on the final
 * report played 71 % of the time, Doubtful 5.9 % [Footballguys]; OUT never; no designation — the NFL
 * report's rule — is expected to play). `fitAvailability` shrinks the fitted cells toward it.
 */
export const P_ACTIVE_PRIOR: Readonly<Record<string, number>> = Object.freeze({
  "Questionable|": 0.71,
  "Doubtful|": 0.059,
  "Out|": 0,
  "|": 1,
});

/**
 * P(active) by the official designation and the last practice [V-data, fitted by `fitAvailability`
 * (k = 10 toward P_ACTIVE_PRIOR) on the 2023 training cases: listed QB/RB/WR/TE player-weeks of the
 * backtest population (BACKTEST_V2.relevance) and whether each played; the row counts are in
 * docs/evals/phase3-projections.md]. OUT / IR / SUSPENSION never play (plan 07 D2's enum).
 */
export const P_ACTIVE_V2: Readonly<Record<string, number>> = Object.freeze({
  ...P_ACTIVE_PRIOR,
  "Questionable|": 0.689,
  "Questionable|FP": 0.82,
  "Questionable|LP": 0.672,
  "Questionable|DNP": 0.582,
  "Doubtful|": 0.055,
  "Doubtful|LP": 0.088,
  "Doubtful|DNP": 0.028,
  "|FP": 1,
  "|LP": 1,
  "|DNP": 1,
});

/** The ESPN injuryStatus enum read as an official designation (plan 07 D2). */
export const ESPN_DESIGNATION: Readonly<Record<string, string>> = Object.freeze({
  QUESTIONABLE: "Questionable",
  DAY_TO_DAY: "Questionable",
  DOUBTFUL: "Doubtful",
  OUT: "Out",
  INJURY_RESERVE: "Out",
  SUSPENSION: "Out",
  ACTIVE: "",
});

/**
 * Weather terms (sib §1 step 7 [V-lit]): PFF (Spratt 2018) — wind ≥ 10 mph: QB completion −1.8 pts,
 * −0.30 yards per attempt; temperature < 30 °F: completion −3.1 pts, RB +0.26 yards per carry;
 * light/moderate rain: completion −2.3 to −3.4 pts, catch rate −2.3 %; 4for4 — RB targets +7.7 % in
 * bad weather, deep passes −6.2 % in wind > 13 mph. Never applied to the implied total (the market
 * moves on forecasts) and never indoors.
 */
export const WEATHER_V2 = Object.freeze({
  windMph: 10,
  strongWindMph: 13,
  windCmpDelta: -0.018,
  /** −0.30 yards per attempt on ≈ 7 yards per attempt → yards per completion × (1 − 0.043). */
  windYardsMult: 0.957,
  /** Deep passes −6.2 % in wind > 13 mph → a further yards multiplier. */
  strongWindYardsMult: 0.97,
  coldF: 30,
  coldCmpDelta: -0.031,
  coldYpcDelta: 0.26,
  precipProb: 0.5,
  precipCmpDelta: -0.028,
  badWeatherRbTargetMult: 1.077,
});

/** The implied-total and matchup multipliers are held inside these bounds. */
export const MULT_BOUNDS = Object.freeze({
  market: [0.6, 1.6] as const,
  matchup: [0.8, 1.2] as const,
});

/** Samples per player-week of a v2 projection (plan 07 E1 n_sims is shared down to this ceiling). */
export const V2_SIMS = Object.freeze({
  default: 2000,
  min: 200,
  /** One scoreSamples call scores at most this many lines (a ≤ 20 ms cooperative slice). */
  max: 2000,
  /** Samples one call simulates in all (targets × samples): n is shared down past it. */
  maxTotalLines: 200_000,
  /** The ensemble rescale is applied only within [1/x, x] of the simulated mean. */
  maxRescale: 3,
});

/** The disagreement flag between ESPN's mean and v2's own (plan 07 C13, E1: > 25 %). */
export const V2_DISAGREEMENT_PCT = 0.25;

/**
 * The backtest's evaluation rules (plan 10 C1; sib §1-Evaluation; research 05 §8.4 "what good
 * looks like"): the relevance floor (trailing opportunity per game over the last 4 games played),
 * the samples per player-week, and the acceptance bands.
 */
export const BACKTEST_V2 = Object.freeze({
  relevance: Object.freeze({ QB: 15, RB: 6, WR: 3, TE: 3 } as Record<V2Position, number>),
  trailingGames: 4,
  samples: 200,
  /** The fantasy weeks scored (ESPN's finalScoringPeriod 17 — research 05 §3.1). */
  firstWeek: 1,
  lastWeek: 17,
  /** "The gain is not concentrated in weeks 1–3" (sib §1-Evaluation). */
  earlyWeeks: 3,
  /** Weeks 1–3 may carry at most this share of the total CRPS gain. */
  maxEarlyGainShare: 0.5,
  /** 80 % coverage within ±5 points (plan 10 C1). */
  coverageNominal: 0.8,
  coverageTolerance: 0.05,
  /**
   * The Monte-Carlo noise of a CRPS difference between two simulated forecasts over a season of
   * player-weeks at `samples` draws each (measured: the across-seed spread of the 0.75-vs-1.0
   * difference is ≈ 0.005 points at 200–400 draws, ≈ 0.002 at 1 000): a "win" must exceed it.
   */
  crpsNoise: 0.005,
});
