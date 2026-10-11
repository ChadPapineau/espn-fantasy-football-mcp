// types.ts — the inputs and outputs of the `v2-opportunity` projection model (plan 10 §3.3 C1; plan
// 07 E1 → `model_version: "v2-opportunity"`, `basis: "player_sim"`; sibling research 05 §1 steps
// 0–9; research 05 §3.2's turnover model, §5 Projections). Every input is a plain domain value the
// caller builds from the store (nflverse player-weeks, snap counts, pbp red-zone counts, ffopportunity
// expectations, schedules, injuries, weather) — this module reads nothing itself. Pure types. New here.
import type { Clock, Rng } from "../../clock.js";
import type { BareText, Week } from "../../league/types.js";
import type { Canonical, Dist, ScoringSettings } from "../../scoring/types.js";
import type { Pacer } from "../cooperative.js";
import type { Assumption, Driver, InputFreshness, PActiveBasis, ProjectionData } from "../types.js";
import type { AnyStamp } from "../inputs.js";
import type { V2Trace } from "./trace.js";

/** The positions the opportunity model covers (K and D/ST stream apart — research 05 §5 K/D-ST). */
export type V2Position = "QB" | "RB" | "WR" | "TE";

/**
 * One game a player played (an nflverse player-week, joined): the counts the model reads. Counts
 * are per game; a null context field means its source did not cover the game (never 0).
 */
export interface V2Game {
  readonly season: number;
  readonly week: Week;
  /** The player's NFL team that game (nflverse abbreviation). */
  readonly team: string;
  readonly opponent: string | null;
  readonly pass_att: number;
  readonly pass_cmp: number;
  readonly pass_yd: number;
  readonly pass_td: number;
  readonly pass_int: number;
  readonly sacks: number;
  readonly sack_fum_lost: number;
  readonly rush_att: number;
  readonly rush_yd: number;
  readonly rush_td: number;
  readonly rush_fum_lost: number;
  readonly targets: number;
  readonly rec: number;
  readonly rec_yd: number;
  readonly rec_td: number;
  readonly rec_fum_lost: number;
  /** Two-point conversions of every kind. */
  readonly two_pt: number;
  /** Offensive snap share in [0, 1] (nflverse snap_counts). */
  readonly snap_pct: number | null;
  /** Targets / carries inside the 20 and carries inside the 5 (nflverse pbp). */
  readonly rz_targets: number | null;
  readonly rz_carries: number | null;
  readonly gl_carries: number | null;
  /** Touchdowns on those red-zone targets / carries and goal-line carries (pbp; the league rates). */
  readonly rz_rec_td: number | null;
  readonly rz_rush_td: number | null;
  readonly gl_rush_td: number | null;
  /** ffopportunity's location-based expected touchdowns that game (sib §1 step 5). */
  readonly x_rec_td: number | null;
  readonly x_rush_td: number | null;
  readonly x_pass_td: number | null;
}

/** One team-game: the offence's volume and its market line (nflverse stats_team_week + schedules). */
export interface V2TeamGame {
  readonly team: string;
  readonly season: number;
  readonly week: Week;
  readonly opponent: string | null;
  /** Pass attempts + sacks. */
  readonly dropbacks: number | null;
  /** Rushing attempts (QB scrambles included, as nflverse counts them). */
  readonly rushes: number | null;
  /** Red-zone pass and rush plays (pbp). */
  readonly rz_plays: number | null;
  /** The team's implied total that game: (total ± spread) / 2. */
  readonly implied: number | null;
  /** The team-side spread, > 0 = favoured. */
  readonly spread: number | null;
  readonly total: number | null;
  readonly points_for: number | null;
}

/** The target week's market line for one team. */
export interface V2Market {
  readonly implied: number | null;
  /** Team-side, > 0 = favoured. */
  readonly spread: number | null;
  readonly total: number | null;
}

/** Roof kinds (nflverse `roof`). */
export type V2Roof = "outdoors" | "open" | "closed" | "dome";

/** Game-venue weather for the target week (a forecast live; the game's record in a backtest). */
export interface V2Weather {
  readonly roof: V2Roof | null;
  readonly temp_f: number | null;
  readonly wind_mph: number | null;
  /** Probability of precipitation in [0, 1]; null when the source has none. */
  readonly precip_prob: number | null;
}

/** Availability evidence for the target week (sib §1 step 8; plan 07 D2). */
export interface V2Availability {
  /**
   * The official game designation (nflverse wording: `Questionable`, `Doubtful`, `Out`) or ESPN's
   * `injuryStatus` enum (`QUESTIONABLE`, `DOUBTFUL`, `OUT`, `INJURY_RESERVE`, `SUSPENSION`, …).
   */
  readonly designation: string | null;
  /** The last practice participation (nflverse wording, or `DNP` / `LP` / `FP`). */
  readonly practice: string | null;
  /** Within the game-day window ESPN's status alone decides (plan 07 D2): set by the caller. */
  readonly game_day?: boolean;
}

/** ESPN's position-vs-opponent rating (plan 07 D5) — a labelled comparator, never a driver. */
export interface V2EspnRating {
  readonly average: number;
  readonly rank: number;
}

/** Who to project. */
export interface V2Target {
  readonly player_id: number | null;
  readonly gsis_id: string | null;
  readonly name: BareText;
  /** ESPN display position; only QB/RB/WR/TE are modelled (others get no v2 projection). */
  readonly position: string;
  /** ESPN `defaultPositionId` (the scoring overrides key on it). */
  readonly position_id: number;
  /** The player's NFL team in the target week (null: none — no game). */
  readonly team: string | null;
  /** Games played, any order; only those before the target week are read. */
  readonly games: readonly V2Game[];
  /** ESPN's weekly projection under this league's S, or null. */
  readonly espn_mean: number | null;
  readonly availability: V2Availability;
}

/** Per-position defensive context (the regressed matchup — sib §1 step 6). */
export interface V2MatchupCell {
  /** Points the defence allowed to the position relative to what those offences score elsewhere. */
  readonly afpa: number;
  /** Relative to the defence's all-position figure (the market prices the total — sib §1 step 1). */
  readonly relative: number;
  /** Games behind it. */
  readonly games: number;
}

/** The matchup table, keyed `${defence}|${position}` (built by `buildMatchupTable`). */
export type V2MatchupTable = Readonly<Record<string, V2MatchupCell>>;

/** Positional rate priors (sib §1 step 4: the shrinkage targets) and league team means. */
export interface V2PositionPriors {
  /** A player-game's targets per team dropback, carries per team rush, dropbacks per team dropback. */
  readonly target_share: number;
  readonly carry_share: number;
  readonly dropback_share: number;
  readonly catch_rate: number;
  readonly yards_per_rec: number;
  readonly yards_per_carry: number;
  readonly cmp_rate: number;
  readonly yards_per_cmp: number;
  readonly int_rate: number;
  readonly sack_rate: number;
  /** Fumbles lost per touch (receptions + carries + sacks). */
  readonly fumble_rate: number;
  readonly xtd_per_target: number;
  readonly xtd_per_carry: number;
  readonly xtd_per_att: number;
  /** Touchdowns per red-zone target / other target; per goal-line, other red-zone and other carry. */
  readonly td_rz_target: number;
  readonly td_other_target: number;
  readonly td_gl_carry: number;
  readonly td_rz_carry: number;
  readonly td_other_carry: number;
  /** Two-point conversions per offensive touchdown. */
  readonly two_pt_per_td: number;
}

/** Every prior the model shrinks toward. */
export interface V2Priors {
  readonly positions: Readonly<Record<V2Position, V2PositionPriors>>;
  readonly team_dropbacks: number;
  readonly team_rushes: number;
  readonly team_implied: number;
}

/** The tunable parameters (sib §1-Evaluation: tune `h`, `k` per stat, `β_pos`, the weather terms). */
export interface V2Params {
  /** Half-life of a player's share weights, in games (`h`). */
  readonly half_life_games: number;
  /** Weight multiplier per season back. */
  readonly prior_season_weight: number;
  /** Most games in a player's window. */
  readonly max_games: number;
  /** The change-point rule (sib §1 step 2). */
  readonly change_point: {
    readonly snap_delta: number;
    readonly share_delta: number;
    readonly hold_games: number;
    /** Weight multiplier of the games before a change point (a soft re-base). */
    readonly pre_weight: number;
  };
  /** Team volume (sib §1 step 1). */
  readonly team: {
    readonly half_life_games: number;
    readonly shrink_games: number;
    /** Dropbacks / rushes change per point of team-side spread above the window's mean. */
    readonly spread_db: number;
    readonly spread_ru: number;
  };
  /** Shrinkage strengths, in opportunities (sib §1 step 4: `k` per stat). */
  readonly k: {
    readonly catch_rate: number;
    readonly yards_per_rec: number;
    readonly yards_per_carry: number;
    readonly cmp_rate: number;
    readonly yards_per_cmp: number;
    readonly int_rate: number;
    readonly sack_rate: number;
    readonly fumble_rate: number;
    readonly xtd: number;
    readonly share: number;
  };
  /** Exponent of the implied-total ratio on touchdown rates (sib §1 step 1: the market anchor). */
  readonly market_td_theta: number;
  /** Matchup shrinkage `β_pos` and the games until `w(weeks)` reaches 1 (sib §1 step 6). */
  readonly matchup_beta: Readonly<Record<V2Position, number>>;
  readonly matchup_full_games: number;
  /** Simulation dispersions (sib §1 step 9). */
  readonly sim: {
    readonly cv_common: number;
    readonly cv_pass: number;
    readonly cv_rush: number;
    readonly cv_share: number;
    /** Added to the share CV as the role's games fall (cv_share × √(1 + this / role games)). */
    readonly share_role_games: number;
    /** The game's efficiency draw (yards per event and TD rates up, the INT rate down): RB/WR/TE. */
    readonly cv_eff: number;
    /** The QB's role draw relative to other positions' (a starter's dropback share barely moves). */
    readonly qb_role_scale: number;
    /** The QB's game-efficiency CV. */
    readonly cv_eff_qb: number;
    /** INT rate ∝ efficiency^(−power): how much harder a bad game turns the ball over. */
    readonly int_eff_power: number;
    /** Yards and touchdown expectation an interception's ended drive no longer produces. */
    readonly int_drive_yards: number;
    readonly int_drive_td: number;
    /** Pass efficiency ∝ (pass-volume draw)^(−coupling): game script (trailing → more, worse passes). */
    readonly script_coupling: number;
    readonly cv_yds_catch: number;
    readonly cv_yds_carry: number;
    readonly cv_yds_cmp: number;
    /** The role draw's CV multiplier when the simulation is anchored to the ensemble's mean. */
    readonly anchor_role_scale: number;
    /**
     * Per-position dispersion of the model's OWN simulation (Stage C; fitted on 2023 only — docs/
     * evals/phase3-projections.md "Per-position dispersion"): multipliers on the global CVs above.
     * The anchored (ensemble) simulation never reads them — its mean is ESPN's, not the model's own,
     * so the own estimate's uncertainty is not its to carry. Absent = 1 everywhere.
     */
    readonly position?: Readonly<Record<V2Position, V2PositionDispersion>>;
  };
}

/** One position's multipliers on the own simulation's CVs (1 = the global value). */
export interface V2PositionDispersion {
  /**
   * The role draw (the player's share of his team's volume — the own estimate's main uncertainty;
   * the game-script draws stay global: a team's game is not a position's).
   */
  readonly role: number;
  /** The per-event yardage CVs: per completion, per catch, per carry. */
  readonly yds_cmp: number;
  readonly yds_catch: number;
  readonly yds_carry: number;
}

/** One rate's shrinkage, as shown (sib §1 Output shape: "the shrinkage applied per rate (n, k)"). */
export interface V2Shrinkage {
  readonly rate: string;
  /** Weighted opportunities behind the observation. */
  readonly n: number;
  readonly k: number;
  readonly observed: number | null;
  readonly prior: number;
  readonly value: number;
}

/** The deterministic expectation of one player-week (the simulator's parameters). */
export interface V2Expectation {
  readonly position: V2Position;
  readonly position_id: number;
  /** Expected team dropbacks and rushes (step 1). */
  readonly team_dropbacks: number;
  readonly team_rushes: number;
  /** Shares (step 2). */
  readonly att_per_dropback: number;
  readonly sack_per_dropback: number;
  readonly target_per_dropback: number;
  readonly carry_share: number;
  /** Expected opportunities (step 3). */
  readonly pass_att: number;
  readonly targets: number;
  readonly carries: number;
  /** Rates (step 4) with the weather terms applied (step 7). */
  readonly cmp_rate: number;
  readonly yards_per_cmp: number;
  readonly catch_rate: number;
  readonly yards_per_rec: number;
  readonly yards_per_carry: number;
  /** Touchdowns per opportunity from location (step 5), market- and matchup-scaled. */
  readonly td_per_att: number;
  readonly td_per_target: number;
  readonly td_per_carry: number;
  /** The turnover model (research 05 §3.2). */
  readonly int_per_att: number;
  readonly fumble_per_touch: number;
  readonly two_pt_per_td: number;
  /** Multipliers actually used. */
  readonly market_mult: number;
  readonly matchup_mult: number;
  readonly weather: V2WeatherEffect;
  /** Games in the current role (since the last change point). */
  readonly role_games: number;
  /**
   * The role draw's CV multiplier (1 for the model's own projection; the ensemble's anchored
   * simulation sets `sim.anchor_role_scale` — an external mean already carries role information).
   */
  readonly role_cv_scale?: number;
  /**
   * The ensemble's anchored simulation (ensemble.ts anchorExpectation sets it): the own simulation's
   * per-position dispersion (`sim.position`) is not applied — the mean is an external one.
   */
  readonly anchored?: boolean;
  /** Games behind the window. */
  readonly games: number;
  readonly shrinkage: readonly V2Shrinkage[];
  /** Where the touchdown rates came from. */
  readonly td_basis: "ffopportunity" | "pbp_location" | "prior";
}

/** Weather terms applied (sib §1 step 7; PFF / 4for4 figures). */
export interface V2WeatherEffect {
  readonly applied: boolean;
  readonly cmp_delta: number;
  readonly yards_mult: number;
  readonly ypc_delta: number;
  readonly rb_target_mult: number;
  readonly reasons: readonly string[];
}

/** P(active) and its basis (sib §1 step 8). */
export interface V2ActiveEstimate {
  readonly p: number;
  readonly basis: PActiveBasis;
}

/** A v2 request (validated here; the tool's zod schema is stricter). */
export interface V2Request {
  readonly targets: readonly V2Target[];
  readonly season: number;
  /** The target week (the as-of: no game of it or later is read). */
  readonly week: Week;
  /** Null when the league's S is not available: no projection (plan 07 E1 degradation). */
  readonly settings: ScoringSettings | null;
  /** Team-games of every team (the volume windows and the matchup table read them). */
  readonly team_games: readonly V2TeamGame[];
  /** The target week's market line by team (absent: neutral, said). */
  readonly markets?: Readonly<Record<string, V2Market>>;
  /** The target week's venue weather by team (absent: none applied). */
  readonly weather?: Readonly<Record<string, V2Weather>>;
  /** The target week's opponent by team. */
  readonly opponents?: Readonly<Record<string, string | null>>;
  readonly matchup?: V2MatchupTable | null;
  /** ESPN's rating by `${defence}|${position}` (comparator only). */
  readonly espn_ratings?: Readonly<Record<string, V2EspnRating | null>>;
  readonly priors?: V2Priors;
  readonly params?: V2Params;
  /** The ensemble weight on ESPN's mean (default WEIGHT_ESPN_V2 — plan 07 E1, ADV OBJ-02). */
  readonly weight_espn?: number;
  readonly n_sims?: number;
  readonly clock: Clock;
  readonly rng: Rng;
  readonly pacer?: Pacer;
  /** The CPU deadline (default 8 s); null disables it (determinism tests). */
  readonly deadline_ms?: number | null;
  readonly include_stat_line?: boolean;
  readonly stamps?: readonly AnyStamp[];
  readonly inputs?: readonly InputFreshness[];
}

/** The v2 detail of one projected player (the fields plan 07 E1's Projection has no room for). */
export interface V2PlayerDetail {
  readonly player_id: number | null;
  readonly gsis_id: string | null;
  /** The model's own distribution (before the ensemble), `basis: "player_sim"`. */
  readonly own: Dist | null;
  /** The ensemble distribution served (ESPN's mean × weight_espn + own × (1 − weight_espn)). */
  readonly dist: Dist | null;
  readonly weight_espn: number;
  readonly p_active: number;
  readonly p_active_basis: PActiveBasis;
  readonly expectation: V2Expectation | null;
  readonly opportunity: {
    readonly pass_att: number;
    readonly targets: number;
    readonly carries: number;
    readonly rz_share: number | null;
  } | null;
  /** The matchup multiplier used and ESPN's rating beside it (a comparator, never a driver). */
  readonly matchup: {
    readonly opponent: string | null;
    readonly mult: number;
    readonly afpa: number | null;
    readonly espn_rating: V2EspnRating | null;
  } | null;
  /** The turnover model's left tail (research 05 §3.2). */
  readonly turnover: V2TurnoverTail | null;
  readonly stat_line_expectation?: Readonly<Record<Canonical, number>>;
  /**
   * The tuning trace (trace.ts; plan 10 C9 — the retrospective's re-fit reads it from the stored
   * projection). Absent on a skipped player.
   */
  readonly trace?: V2Trace;
  /** Why no v2 projection was made (position not modelled, no game history, no team). */
  readonly skipped: string | null;
}

/** The turnover model's summary for one player-week. */
export interface V2TurnoverTail {
  readonly int_per_att: number;
  readonly fumble_per_touch: number;
  /** E[turnover points] if active (≤ 0). */
  readonly expected_points: number;
  /** P(turnover points ≤ −4) if active — the left tail a −2/−2 format adds. */
  readonly p_minus4: number;
}

/** The v2 outcome: E1-shaped data (model_version "v2-opportunity") plus the per-player detail. */
export interface V2Outcome {
  readonly data: ProjectionData;
  readonly details: readonly V2PlayerDetail[];
  readonly partial: boolean;
  /** Fixed-vocabulary warnings (counts only — never third-party text). */
  readonly warnings: readonly string[];
}

/** Re-exported for the module's consumers. */
export type { Assumption, Driver };
