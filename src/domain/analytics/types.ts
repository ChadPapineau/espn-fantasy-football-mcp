// types.ts — the analytics contract: plan 07 legend `Rec`/`Dist`/`PlayerSelector` targets, §2
// `data.inputs[]` + `data.rec` on every analytics result, and the `data` shapes of D1–D6 (dataset
// reads) and E1–E11 (the decision engines: E1 v1 `weight_espn = 1.0` (ADV OBJ-02); E2 objective by
// the seeding reading, ΔP(win) coarse under `position_cv` (sib ADV OBJ-04); E3 the two-reading
// seeding simulator; E5 the priority premium with its band and `marginal` (ADV OBJ-03, R2 nit 3);
// E6–E11 per plan 07). Also the wire-free dataset rows and read-only dataset ports with release
// stamps (plan 01 §5.4–§5.5) and the projection stores (plan 08 §5, §9). Deviation recorded:
// `Rec` carries structured `subjects`/`lineup` so the retrospective never parses model text
// (sibling critic C-01b). Ported from sibling @d72e03b, adapted to plan 07's ESPN shapes.
import type { DatasetSourceId, Freshness, FreshnessClassId } from "../../config/freshness.js";
import type { NflTeam, SeedingMode } from "../../config/schema.js";
import type {
  BareText,
  ClaimExtract,
  InjectionFlag,
  InjuryStatus,
  IsoInstant,
  LockScheduleEntry,
  PoolStatus,
  ProGame,
  ProTeam,
  UntrustedText,
  Week,
} from "../league/types.js";
import type { Canonical, Dist, DistBasis, StatLine } from "../scoring/types.js";

export type { Dist, DistBasis } from "../scoring/types.js";

// --- the recommendation contract (plan 07 legend `Rec`; research 05 §0) --------------------------

/** One driver of a recommendation and its signed contribution in points. Model-visible text. */
export interface Driver {
  readonly name: string;
  readonly contribution: number;
}

/** An assumption and what would make it worth revisiting (plan 01 §5.7: omitted inputs named). */
export interface Assumption {
  readonly text: string;
  readonly revisit_trigger: string;
}

/** One contributing input and its freshness (plan 07 §2 `data.inputs[]`). */
export interface InputFreshness {
  /** A provenance tag: `espn:mRoster`, `espn:projection`, `nflverse:injuries`, `store:pool_snapshot`. */
  readonly source: string;
  readonly as_of: IsoInstant;
  readonly age_s: number;
  readonly freshness: Freshness;
}

/** Confidence evidence: role games + input freshness. */
export interface Confidence {
  readonly role_games: number;
  readonly inputs: readonly InputFreshness[];
}

/** The gap to the next-best alternative. */
export interface DeltaVsNext {
  readonly value: number;
  readonly p10: number;
  readonly p90: number;
}

/** What a recommendation optimised (snake-case; never prose). */
export type DecisionMetric =
  | "expected_points"
  | "p_win"
  | "blend"
  | "points_for"
  | "marginal_value"
  | "weeks_of_value"
  | "surplus_vs_premium"
  | "vor"
  | "delta_u"
  | (string & {});

/** A subject's role in a recommendation. */
export type SubjectRole =
  "start" | "sit" | "add" | "drop" | "claim" | "stream" | "trade_in" | "trade_out" | "ir_move";

/**
 * A structured, server-authored subject: which ESPN player the call is about and in what role.
 * The retrospective computes regret/`followed` from these ONLY — never from the free-text `action`
 * (model-authored, untrusted on read — plan 07 C15). At least one of the ids is non-null.
 */
export interface RecSubject {
  readonly player_id: number | null;
  readonly gsis_id: string | null;
  readonly role: SubjectRole;
  /** The ESPN slot name for lineup roles (`FLEX`, `RB`); null otherwise. */
  readonly slot: string | null;
}

/** One slot of a recommended lineup (lineup recs only). */
export interface RecLineupSlot {
  readonly slot: string;
  readonly player_id: number;
}

/** The recommendation every analytics result carries as `data.rec` (plan 07 legend `Rec`). */
export interface Rec {
  readonly action: string;
  readonly subjects: readonly RecSubject[];
  readonly lineup: readonly RecLineupSlot[] | null;
  readonly point_estimate: number;
  readonly distribution: Dist;
  readonly delta_vs_next: DeltaVsNext;
  readonly decision_metric: DecisionMetric;
  readonly drivers: readonly Driver[];
  readonly assumptions: readonly Assumption[];
  readonly confidence: Confidence;
  readonly as_of: IsoInstant;
  /** The last moment the action can still be executed; null when not time-bound. */
  readonly latest_execution_time: IsoInstant | null;
  readonly no_move: boolean;
  /** Filled only by `espn_record_recommendation`; null in every analytics result. */
  readonly log_id: null;
}

/** The common tail of every analytics result (plan 07 §2). */
export interface AnalyticsResult {
  readonly inputs: readonly InputFreshness[];
}

/**
 * The seeding reading a result used and whether the operator has confirmed it (plan 07 C9, C12,
 * E2 objective resolution; ADV OBJ-13): `confirmed` stays false — a clean-negative field a test
 * asserts — until `onboard` records the reading (`eff setup --seeding` → config
 * `seeding_confirmed_at`). Carried by every result whose numbers depend on the reading: E2, E3
 * `season`, E6 evaluation (its `delta_u.reading`) and E8 (weighted by E3).
 */
export interface SeedingStatus {
  readonly mode_used: SeedingMode | "both";
  readonly confirmed: boolean;
}

/** Builds SeedingStatus from the mode a call used and config's `seedingConfirmedAt` (null = never). */
export function seedingStatus(
  modeUsed: SeedingMode | "both",
  seedingConfirmedAt: string | null,
): SeedingStatus {
  return Object.freeze({
    mode_used: modeUsed,
    confirmed: typeof seedingConfirmedAt === "string" && seedingConfirmedAt.length > 0,
  });
}

// --- constants the engines and tests share (plan 07 §0, E1, E2, E5; research 05) -----------------

/** v1 ships ESPN's mean as the point estimate (plan 01 D15; ADV OBJ-02). */
export const WEIGHT_ESPN_V1 = 1.0;
/** The ESPN-vs-ours disagreement flag (plan 07 C13, E1): > 25 %. */
export const DISAGREEMENT_FLAG_PCT = 0.25;
/** Cold-start PF-per-win exchange rate under reading (a) (plan 07 A-3; research 05 §2.4 90–200). */
export const PF_PER_WIN_COLD_START = 120;
/** The premium band: the DP re-solved at ×0.5 and ×1.5 surplus (plan 07 E5; ADV OBJ-03). */
export const PREMIUM_BAND_MULTIPLIERS = Object.freeze({ low: 0.5, high: 1.5 });
/** Analytics results are capped by construction (plan 07 C8). */
export const ANALYTICS_RESULT_CHARS = 10_000;
/** E10 shows a posterior only once the calibration table has ≥ 200 scored claims (sib ADV OBJ-21). */
export const EVIDENCE_POSTERIOR_MIN_N = 200;
/** Game-day availability window: a kickoff within 3 h (plan 07 D2; sib ADV OBJ-16). */
export const GAME_DAY_WINDOW_MS = 3 * 60 * 60 * 1000;

/** Projection model versions (plan 07 E1). */
export type ModelVersion = "v1-ensemble" | "v2-opportunity";

// --- E1 espn_project_players -----------------------------------------------------------------------

/** Where a `p_active` came from (plan 07 D2's vocabulary). */
export type PActiveBasis = "designation_base_rate" | "espn_gameday_status" | "trend_model" | "none";

/** One projected week for one player (plan 07 E1 `weeks[]`). */
export interface ProjectionWeek {
  readonly week: Week;
  readonly points: Dist;
  readonly p_active: number | null;
  readonly opponent: string | null;
  readonly implied_total: number | null;
  readonly inputs: {
    readonly espn: number | null;
    readonly own: number | null;
    readonly weight_espn: number;
  };
  readonly disagreement: { readonly pct: number | null; readonly flagged: boolean };
}

/** A player's projection (plan 07 E1 `projections[]`). */
export interface Projection {
  readonly player_id: number | null;
  readonly gsis_id: string | null;
  readonly name: BareText;
  readonly position: string;
  readonly weeks: readonly ProjectionWeek[];
  readonly ros_total: Dist | null;
  readonly stat_line_expectation?: Readonly<Record<Canonical, number>>;
  readonly drivers: readonly Driver[];
  readonly role_confidence_games: number;
  readonly assumptions: readonly Assumption[];
}

/** `espn_project_players` data (plan 07 E1); `meta.estimate: true`. */
export interface ProjectionData extends AnalyticsResult {
  readonly model_version: ModelVersion;
  readonly projections: readonly Projection[];
  /** Samples completed; below `n_sims` when the 8 s CPU deadline stopped the sampler (`partial`). */
  readonly completed_samples: number;
}

// --- E2 espn_analyze_lineup ------------------------------------------------------------------------

/** The objective argument (plan 07 E2). */
export type ObjectiveArg = "auto" | "mean" | "pwin" | "blend" | "points_only";
/** The objective actually used. */
export type Objective = Exclude<ObjectiveArg, "auto">;
/** The seeding-mode argument: `config` (the operator's reading) or an explicit one (`both` only when asked). */
export type SeedingModeArg = "config" | SeedingMode | "both";
/** The variance mode (research 05 §2.2). */
export type MatchupMode = "protect" | "chase" | "neutral" | "maximise_pf";

/** The coarse ΔP(win) reported under `position_cv` (never a two-decimal number). */
export interface CoarseDelta {
  readonly sign: "+" | "-" | "0";
  readonly band: "small" | "medium" | "large";
}

/** Coin-flip thresholds on |ΔP(win)| per basis (research 05 §3.2; sib plan 07 C11). */
export const COIN_FLIP_DPWIN: Readonly<Record<DistBasis, number>> = Object.freeze({
  position_cv: 0.04,
  player_sim: 0.02,
});
/** Coarse band cutoffs (the plan names bands, not cutoffs — sibling decision, adopted). */
export const COARSE_BAND_CUTOFFS = Object.freeze({ zero: 0.005, small: 0.04, medium: 0.1 });

/** The coarse form of a ΔP(win); NaN reads `0`/small. */
export function toCoarseDelta(delta: number): CoarseDelta {
  const a = Number.isFinite(delta) ? Math.abs(delta) : 0;
  const sign = a < COARSE_BAND_CUTOFFS.zero ? "0" : delta > 0 ? "+" : "-";
  const band =
    a < COARSE_BAND_CUTOFFS.small ? "small" : a < COARSE_BAND_CUTOFFS.medium ? "medium" : "large";
  return { sign, band };
}

/** Whether a swap is a coin flip (|ΔP(win)| under the basis threshold, or its interval spans 0). */
export function isCoinFlip(
  basis: DistBasis,
  deltaPwin: number,
  interval: readonly [number, number],
): boolean {
  if (!Number.isFinite(deltaPwin)) return true;
  return Math.abs(deltaPwin) < COIN_FLIP_DPWIN[basis] || (interval[0] <= 0 && interval[1] >= 0);
}

/** One slot assignment in a lineup. */
export interface LineupSlotAssignment {
  readonly slot: string;
  readonly player_id: number;
  readonly name: BareText;
  readonly points: Dist;
  readonly lock_at: IsoInstant | null;
  readonly percent_started: number | null;
}

/** Option value of holding a decision open (research 05 §3.4). */
export interface OptionValue {
  readonly kind: "thursday" | "monday" | "late_game";
  readonly value: number;
  readonly verdict: string;
}

/** One recommended swap; `D` is the ΔP(win) form its basis allows. */
export interface SwapOf<D extends number | CoarseDelta> {
  readonly out: number | null;
  readonly in: number;
  readonly slot: string;
  readonly delta_e: number;
  readonly delta_pwin: D;
  readonly delta_pf: number;
  readonly interval: readonly [number, number];
  readonly coin_flip: boolean;
  readonly option_value: OptionValue | null;
}

/** The inputs behind the variance mode (plan 07 E2 `mode_basis`). */
export interface ModeBasis {
  readonly mu_m: number;
  readonly mu_o: number;
  readonly sigma_m: number;
  readonly sigma_o: number;
  readonly rho_lineup: number;
  readonly pf_exchange_rate: {
    readonly pf_per_win: number | null;
    readonly source: "season_sim" | "cold_start" | null;
  };
  readonly pf_context: {
    readonly season_pf_rank: number;
    readonly pf_gap_to_cutoff: number;
    readonly tiebreak_in_play: boolean;
  } | null;
}

interface LineupDataBase extends AnalyticsResult {
  readonly objective_used: Objective;
  readonly objective_reason: string;
  /** Plan 07 E2's field; always equal to `seeding.mode_used`. */
  readonly seeding_mode_used: SeedingMode | "both";
  readonly seeding: SeedingStatus;
  readonly current_lineup: readonly LineupSlotAssignment[];
  readonly recommended_lineup: readonly LineupSlotAssignment[];
  readonly mode: MatchupMode;
  readonly mode_basis: ModeBasis;
  readonly e_points_before: number;
  readonly e_points_after: number;
  readonly p_win_before: number | null;
  readonly p_win_after: number | null;
  readonly p_win_interval: readonly [number, number] | null;
  readonly conditionals: readonly {
    readonly if: {
      readonly player_id: number;
      readonly event: "inactive";
      readonly decided_by: IsoInstant;
    };
    readonly then: { readonly slot: string; readonly in: number };
  }[];
  readonly stack_flags: readonly {
    readonly players: readonly number[];
    readonly effect: "ceiling+" | "floor-";
    readonly advice_under_reading: string;
  }[];
  readonly espn_cross_check: {
    readonly starter_disagreements: readonly {
      readonly player_id: number;
      readonly ours: number;
      readonly espn: number;
      readonly pct: number;
    }[];
  };
  readonly lock_schedule: readonly LockScheduleEntry[];
  readonly latest_execution_time: IsoInstant | null;
  readonly no_move: boolean;
  readonly rec: Rec;
}

/**
 * `espn_analyze_lineup` data (plan 07 E2), discriminated on `basis` so a two-decimal ΔP(win)
 * cannot type-check under `position_cv` (`p_win_reporting: "sign_and_band"`).
 */
export type LineupData =
  | (LineupDataBase & {
      readonly basis: "position_cv";
      readonly p_win_reporting: "sign_and_band";
      readonly swaps: readonly SwapOf<CoarseDelta>[];
    })
  | (LineupDataBase & {
      readonly basis: "player_sim";
      readonly p_win_reporting: "calibrated";
      readonly swaps: readonly SwapOf<number>[];
    });

// --- E3 espn_analyze_matchup -------------------------------------------------------------------------

/** E3 modes and methods. */
export type MatchupAnalysisMode = "pre" | "live" | "season";
export type WinProbMethod = "normal" | "mc";

/** E3 `pre`/`live` data (plan 07 E3). */
export interface MatchupWinData extends AnalyticsResult {
  readonly mode: "pre" | "live";
  readonly p_win: number;
  readonly interval: readonly [number, number];
  readonly mu_m: number;
  readonly sigma_m: number;
  readonly mu_o: number;
  readonly sigma_o: number;
  readonly cov: number;
  readonly method: WinProbMethod;
  readonly basis: DistBasis;
  readonly live: {
    readonly players_final: readonly number[];
    readonly players_live: readonly {
      readonly player_id: number;
      readonly points_so_far: number;
      readonly fraction_remaining: number;
    }[];
    readonly players_pending: readonly number[];
    readonly points_so_far: { readonly me: number; readonly opp: number };
  } | null;
  readonly espn_cross_check: {
    readonly win_probability_espn: number | null;
    readonly projected_live_espn: { readonly me: number | null; readonly opp: number | null };
  } | null;
  readonly actionable_slots: readonly {
    readonly slot: string;
    readonly lock_at: IsoInstant | null;
  }[];
  readonly rec: Rec;
}

/** Marginal values of the seeding simulator (plan 07 E3 `marginal_values`). */
export interface MarginalValue {
  readonly d_p_playoffs: number;
  readonly d_p_bye: number;
}

/** One seeding reading's season simulation (plan 07 E3 `season.readings[]`). */
export interface SeasonReading {
  readonly seeding_mode: SeedingMode;
  readonly p_playoffs: number;
  readonly p_bye: number;
  readonly p_champion: number | null;
  readonly seed_distribution: readonly { readonly seed: number; readonly p: number }[];
  readonly p_alive_by_week: readonly { readonly week: Week; readonly p: number }[];
  readonly tiebreak_chain: readonly string[];
  readonly cutoff: {
    readonly seed_line: number;
    readonly wins_gap: number;
    readonly pf_gap: number;
    readonly pf_rank_needed: number | null;
  };
  readonly marginal_values: {
    readonly plus_1_win: MarginalValue;
    readonly plus_pf_20: MarginalValue;
    readonly plus_pf_40: MarginalValue;
    readonly plus_pf_80: MarginalValue;
    readonly plus_3_ppw: MarginalValue;
    readonly sigma_x0_7: MarginalValue;
    readonly sigma_x1_4: MarginalValue;
  };
  readonly pf_per_win: number | null;
  readonly clinch: {
    readonly clinched: boolean;
    readonly eliminated: boolean;
    readonly magic_number: number | null;
  };
  readonly scenarios_applied: readonly string[];
}

/** A scenario input (plan 07 E3 `scenarios[]`, ≤ 10). */
export type SeasonScenario =
  | { readonly week: Week; readonly matchup_id: number; readonly winner: number | "me" }
  | { readonly team_id: number; readonly pf_delta: number };

/** E3 `season` data (plan 07 E3). The simulator itself is Phase 1a domain code (E2 needs it). */
export interface SeasonSimData extends AnalyticsResult {
  readonly mode: "season";
  readonly seeding: SeedingStatus;
  readonly readings: readonly SeasonReading[];
  readonly divergence: { readonly p_playoffs_delta_between_readings: number } | null;
  readonly playoff_pct_espn: number | null;
  readonly division_aware: boolean;
  readonly n_sims: number;
  readonly rec: Rec;
}

/** `espn_analyze_matchup` data. */
export type MatchupAnalysisData = MatchupWinData | SeasonSimData;

// --- E4 espn_analyze_replacement ------------------------------------------------------------------

/** `espn_analyze_replacement` data (plan 07 E4 = sib E4 with `player_id` + `format_notes`). */
export interface ReplacementData extends AnalyticsResult {
  readonly positions: readonly {
    readonly position: string;
    readonly starter_baseline_weekly: readonly { readonly week: Week; readonly points: number }[];
    readonly starter_baseline_ros: number;
    readonly stream_baseline_weekly: readonly { readonly week: Week; readonly points: number }[];
    readonly curve: readonly { readonly rank: number; readonly vor: number }[];
    readonly tiers: readonly { readonly tier: number; readonly player_ids: readonly number[] }[];
    readonly streamability: number;
    readonly effective_starters: number;
    readonly flex_allocation_trace?: readonly {
      readonly slot: string;
      readonly position_filled: string;
    }[];
  }[];
  readonly players: readonly {
    readonly player_id: number;
    readonly name: BareText;
    readonly position: string;
    readonly vor_weekly: number | null;
    readonly vor_ros: Dist;
    readonly xvbd: number;
    readonly tier: number | null;
  }[];
  readonly format_notes: {
    readonly flex_split: { readonly rb: number; readonly wr: number; readonly te: number };
    readonly qb_last_starter_vs_replacement_ppg: number | null;
    readonly streamable_positions: readonly string[];
  };
  readonly rec: Rec | null;
}

// --- E5 espn_analyze_waivers ----------------------------------------------------------------------

export type WaiverMode = "priority" | "faab";
export type WaiverPhase = "pre_run" | "post_run";
export type PremiumBasis = "cold_start_table" | "league_fitted";
export type ValueBasis = "espn_ros" | "ensemble";
export type WaiverVerdict = "claim" | "pass" | "marginal" | "fa_add_now" | "fa_add_after_run";
export type WaiverSignalKind =
  | "injury_cascade"
  | "snap_jump"
  | "target_share_jump"
  | "xfp_gap"
  | "rz_shift"
  | "depth_chart"
  | "implied_total"
  | "stream";

/** One detection signal (P1); text evidence is wrapped. */
export interface WaiverSignal {
  readonly kind: WaiverSignalKind;
  readonly value: number;
  readonly evidence?: number | UntrustedText;
}

/** K/D-ST streaming detail (research 05 §5 K/D-ST). */
export interface KdstDetail {
  readonly implied_total: number | null;
  readonly opp_implied_total: number | null;
  readonly brackets_e: number | null;
  readonly sacks_e: number | null;
  readonly takeaways_e: number | null;
  readonly rare_c: number | null;
  readonly next_week: {
    readonly opponent: string | null;
    readonly implied_total: number | null;
    readonly e: number | null;
  } | null;
}

/** Where a demand-model probability came from (cold-start table vs the league's own feed). */
export type DemandBasis = "cold_start" | "league_fitted";

/** E5 `p_clears_to_fa`: the point probability, its interval and the basis of `q_i`. */
export interface ClearsToFa {
  readonly p: number;
  readonly interval: readonly [number, number];
  readonly basis: DemandBasis;
}

/**
 * Whether a ClearsToFa is well-formed: probabilities in [0, 1], `lo ≤ p ≤ hi`, and — while the
 * basis is `cold_start` — a NON-degenerate interval (`hi − lo ≥ CLEARS_TO_FA_MIN_COLD_WIDTH`): a
 * cold-start number must never read as certain.
 */
export const CLEARS_TO_FA_MIN_COLD_WIDTH = 0.05;
export function isValidClearsToFa(c: ClearsToFa): boolean {
  const [lo, hi] = c.interval;
  const inUnit = (x: number) => Number.isFinite(x) && x >= 0 && x <= 1;
  if (!inUnit(c.p) || !inUnit(lo) || !inUnit(hi) || lo > c.p || c.p > hi) return false;
  return c.basis !== "cold_start" || hi - lo >= CLEARS_TO_FA_MIN_COLD_WIDTH;
}

/** One E5 candidate (plan 07 E5 `candidates[]`). */
export interface WaiverCandidate {
  readonly player_id: number;
  readonly name: BareText;
  readonly position: string;
  readonly status: Extract<PoolStatus, "FREEAGENT" | "WAIVERS">;
  readonly waiver_process_date: IsoInstant | null;
  readonly signals: readonly WaiverSignal[];
  readonly value: Dist;
  /** Surplus over the drop candidate. */
  readonly s: number;
  readonly s_with_ir_move: number | null;
  readonly p_role_holds: readonly { readonly week: Week; readonly p: number }[];
  readonly p_k_win: number | null;
  /**
   * P(the player clears waivers to free agency), with its own interval because `q_i` is cold-start
   * (plan 07 E5 clean negative; research 05 §1.3) — null when the player is already a free agent.
   */
  readonly p_clears_to_fa: ClearsToFa | null;
  readonly demand: {
    readonly rivals_upgraded: readonly number[];
    readonly q_i: readonly { readonly team_id: number; readonly p: number }[];
    readonly percent_change: number | null;
    readonly competition_signal: true;
    readonly sleeper_trend: number | null;
    readonly rivals_ir_blocked: readonly number[];
  };
  readonly verdict: WaiverVerdict;
  readonly claim_rank: number | null;
  readonly conditional_drop: {
    readonly player_id: number;
    readonly name: BareText;
    readonly value_ros: Dist;
    readonly re_add_risk: {
      readonly percent_owned: number | null;
      readonly rivals_claiming: number | null;
    };
    readonly is_ir_move: boolean;
    readonly activation_warning: string | null;
  } | null;
  readonly flip_driver: string;
  readonly invalidators: readonly string[];
  readonly kdst: KdstDetail | null;
  /**
   * FAAB mode only (P1, additive): the candidate's own bid `b*`, `P(win | b*)` and the expected net
   * value `P(win | b*) × (s − λ·b*)` it was ranked by (sib research 05 §4.3); absent in priority mode.
   */
  readonly bid?: {
    readonly b_star: number;
    readonly p_win: number;
    readonly expected_net: number;
  } | null;
}

/** `espn_analyze_waivers` data (plan 07 E5). Marginal candidates never enter `claim_list`. */
export interface WaiversData extends AnalyticsResult {
  readonly mode_used: WaiverMode;
  readonly phase: WaiverPhase;
  readonly next_run_at: IsoInstant | null;
  readonly last_run_at: IsoInstant | null;
  /** My waiver rank. */
  readonly k: number | null;
  /** Remaining weeks the priority can be used. */
  readonly W: number;
  readonly premium: number;
  readonly premium_band: { readonly low: number; readonly high: number };
  readonly premium_basis: PremiumBasis;
  readonly per_week_threshold: number;
  readonly value_basis: ValueBasis;
  readonly candidates: readonly WaiverCandidate[];
  readonly claim_list: readonly number[];
  readonly marginal: readonly number[];
  readonly scramble_list: readonly number[];
  readonly hold_vs_stream: {
    readonly streamability: number;
    readonly current_starter_delta: number;
  } | null;
  readonly adds_remaining: number | null;
  readonly faab: {
    readonly b_star: number;
    readonly p_win_curve: readonly { readonly bid: number; readonly p_win: number }[];
    readonly lambda: number;
    readonly dollars_per_point: { readonly value: number; readonly n: number };
  } | null;
  readonly learned: {
    readonly second_claim_at_new_position: boolean | null;
    readonly unowned_to_waivers_at_kickoff: boolean | null;
    readonly order_reset_rule: string | null;
  };
  readonly rec: Rec;
}

// --- E6 espn_analyze_trade -----------------------------------------------------------------------

/**
 * E6 `ΔU` under the recorded seeding reading (plan 07 E6). Additive (Phase 2): `basis` says whether
 * the conversion read the seeding simulator's marginal values (`season_sim`) or the cold-start
 * PF-per-win rate (`cold_start`, [A-3]); `by_reading` holds one row per reading simulated — both
 * when `seeding_mode: "both"` was passed explicitly (ADV OBJ-13) — and `me`/`partner` are the
 * configured reading's row.
 */
export interface DeltaU {
  readonly me: MarginalValue;
  readonly partner: MarginalValue;
  readonly reading: SeedingMode | "both";
  readonly basis: "season_sim" | "cold_start";
  readonly by_reading: readonly {
    readonly seeding_mode: SeedingMode;
    readonly me: MarginalValue;
    readonly partner: MarginalValue;
  }[];
}

/** E6 offer evaluation (plan 07 E6 = sib E6 + ESPN fields). */
export interface TradeEvaluationData extends AnalyticsResult {
  readonly kind: "evaluation";
  readonly delta_me: Dist;
  readonly delta_partner: Dist;
  /** `delta_u.reading` is always `seeding.mode_used`. */
  readonly delta_u: DeltaU;
  readonly seeding: SeedingStatus;
  readonly weekly_impact: readonly {
    readonly week: Week;
    readonly me: number;
    readonly partner: number;
  }[];
  readonly playoff_weeks_impact: { readonly me: number; readonly partner: number };
  /**
   * Every uneven trade carries one (plan 10 B5). Additive: `forced` is true when the receiving side's
   * active roster overflows (the drop is inside `Δ`), false when an open seat absorbs the extra
   * player (the named player is the one cut on that side's next add; `Δ` does not include it).
   */
  readonly implied_drop: {
    readonly side: "me" | "partner";
    readonly player_id: number;
    readonly name: BareText;
    readonly value: number;
    readonly forced: boolean;
  } | null;
  readonly health_adjustment: { readonly me: number; readonly partner: number };
  readonly bye_conflicts: readonly {
    readonly week: Week;
    readonly player_ids: readonly number[];
  }[];
  readonly why_they_accept: readonly string[];
  readonly veto: {
    readonly votes_required: number;
    readonly risk: "low" | "medium" | "high";
  } | null;
  readonly crowd_value_espn: {
    readonly auction_value_average: { readonly give: number; readonly get: number };
  } | null;
  readonly consolidation: { readonly is_2_for_1: boolean; readonly implied_drop: number | null };
  readonly counters: readonly {
    readonly give: readonly number[];
    readonly get: readonly number[];
    readonly delta_me: Dist;
    readonly delta_partner: Dist;
  }[];
  readonly verdict: "accept" | "counter" | "decline" | "fair";
  readonly deadline: IsoInstant | null;
  readonly rec: Rec;
}

/** E6 partner search. */
export interface TradePartnersData extends AnalyticsResult {
  readonly kind: "partners";
  readonly partners: readonly {
    readonly team_id: number;
    readonly name: UntrustedText;
    readonly weakest_slot: string;
    readonly proposal: { readonly give: readonly number[]; readonly get: readonly number[] };
    readonly delta_me: Dist;
    readonly delta_partner: Dist;
  }[];
  readonly deadline: IsoInstant | null;
  readonly rec: Rec | null;
}

/** `espn_analyze_trade` data. */
export type TradeData = TradeEvaluationData | TradePartnersData;

// --- E7 espn_analyze_injury_cascade ------------------------------------------------------------------

/** `espn_analyze_injury_cascade` data (plan 07 E7). */
export interface InjuryCascadeData extends AnalyticsResult {
  readonly injured: {
    readonly player_id: number | null;
    readonly gsis_id: string | null;
    readonly name: BareText;
    readonly nfl_team: string | null;
    readonly position: string;
    readonly injury_status: InjuryStatus | null;
  };
  readonly expected_weeks: {
    readonly p25: number;
    readonly p50: number;
    readonly p75: number;
    readonly basis: "report" | "prior";
  };
  readonly beneficiaries: readonly {
    readonly player_id: number | null;
    readonly gsis_id: string | null;
    readonly name: BareText;
    readonly delta_opportunity: {
      readonly targets: number;
      readonly carries: number;
      readonly rz: number;
    };
    readonly delta_proj_by_week: readonly { readonly week: Week; readonly delta: number }[];
    readonly p_role_holds: number;
    readonly evidence: {
      readonly team_games: number;
      readonly usage_confirmed: boolean;
      readonly market_move: number | null;
    };
    readonly availability: {
      readonly status: PoolStatus | null;
      readonly waiver_process_date: IsoInstant | null;
    };
    readonly verdict: WaiverVerdict | null;
  }[];
  readonly team_volume_change: { readonly implied_total_delta: number | null };
  /**
   * Additive (Phase 2): the injured player's per-game opportunity the cascade redistributes (team
   * volume × his share, after the team-volume factor). Σ beneficiaries' `delta_opportunity` never
   * exceeds it, component by component (plan 10 B6).
   */
  readonly vacated: { readonly targets: number; readonly carries: number; readonly rz: number };
  readonly returning_ramp: { readonly weeks: number; readonly factor: number };
  readonly ir_consequence: {
    readonly on_my_roster: boolean;
    readonly ir_eligible: boolean;
    readonly move: { readonly from_slot: string; readonly to: "IR" } | null;
    readonly frees_bench_slot: boolean;
  } | null;
  readonly pass_down_back_note: string | null;
  readonly hypothesis_only: boolean;
  readonly rec: Rec;
}

// --- E8 espn_analyze_schedule -------------------------------------------------------------------------

/** `espn_analyze_schedule` data (plan 07 E8). */
export interface ScheduleAnalysisData extends AnalyticsResult {
  /** The reading E3's `p_alive` weights were simulated under. */
  readonly seeding: SeedingStatus;
  readonly weeks: readonly {
    readonly week: Week;
    readonly lineup_pts: Dist;
    readonly holes: readonly {
      readonly slot: string;
      readonly replacement_player_id: number | null;
      readonly cost: number;
    }[];
    readonly bye_cluster_cost: number;
    readonly weight: { readonly p_alive: number; readonly importance: number };
  }[];
  readonly worst_weeks: readonly Week[];
  readonly fixes: readonly {
    readonly action: string;
    readonly cost: number;
    readonly delta: number;
    readonly deadline: IsoInstant | null;
  }[];
  readonly playoff_weeks: {
    readonly weeks: readonly Week[];
    readonly bye_seeds: number | null;
    readonly matchup_multipliers: readonly {
      readonly player_id: number;
      readonly multiplier: number;
      readonly shrink_w: number;
    }[];
    readonly evidence_note: string;
    readonly week17_rest_risk: {
      readonly flagged_players: readonly number[];
      readonly note: string;
    };
  };
  readonly rec: Rec;
}

// --- E9 espn_analyze_roster ---------------------------------------------------------------------------

/** `espn_analyze_roster` data (plan 07 E9). */
export interface RosterAnalysisData extends AnalyticsResult {
  readonly phase: "early" | "mid" | "late";
  readonly competing: "yes" | "eliminated";
  readonly bench_template: {
    readonly derived: {
      readonly k: number;
      readonly dst: number;
      readonly qb_bench: number;
      readonly te_bench: number;
      readonly rb_wr_depth: number;
    };
    readonly basis: string;
    readonly streamability: Readonly<Record<string, number>>;
  };
  readonly bench_plan: readonly {
    readonly slot: string;
    readonly role: "bye_cover" | "injury_cover" | "upside" | "handcuff" | "stash";
    readonly player_id: number;
    readonly marginal_value: number;
  }[];
  readonly handcuff_values: readonly {
    readonly handcuff: number;
    readonly starter: number;
    readonly value: Dist;
    readonly verdict: string;
  }[];
  readonly stash_values: readonly {
    readonly player_id: number;
    readonly p_return_by_week: readonly { readonly week: Week; readonly p: number }[];
    readonly value: Dist;
    readonly verdict: string;
    readonly playoff_horizon_note: string | null;
  }[];
  readonly consolidation_candidates: readonly {
    readonly give: readonly number[];
    readonly target_profile: string;
  }[];
  readonly droppable: readonly {
    readonly player_id: number;
    readonly value_ros: Dist;
    readonly re_add_risk: {
      readonly percent_owned: number | null;
      readonly rivals_claiming: number | null;
    };
    readonly undroppable: boolean;
  }[];
  readonly ir: {
    readonly slots: number;
    readonly eligible_now: readonly {
      readonly player_id: number;
      readonly tag: InjuryStatus | null;
    }[];
    readonly invalid: boolean;
    readonly invalid_players: readonly number[];
    readonly forced_drop: number | null;
    readonly blocked_until: IsoInstant | null;
    readonly hidden_bench_play: {
      readonly available: boolean;
      readonly player_id: number | null;
      readonly risks: readonly [string, string, string];
    } | null;
    readonly activation_timing_warning: string | null;
    readonly effective_bench: number;
  };
  readonly adds_remaining: number | null;
  readonly rec: Rec;
}

// --- E10 espn_analyze_evidence -------------------------------------------------------------------------

/** `espn_analyze_evidence` data (plan 07 E10): structured fields win; the text never drives it. */
export interface EvidenceData extends AnalyticsResult {
  readonly flag:
    | "unconfirmed_narrative"
    | "quiet_role_change"
    | "availability_conflict"
    | "consistent"
    | "no_claim";
  readonly structured_disagrees: {
    readonly field:
      "injury_status" | "lineup_slot" | "stats" | "waiver_process_date" | "lineup_locked";
    readonly structured_value: string | number | boolean | null;
    readonly claim_value: string | number | boolean | null;
  } | null;
  readonly injection_flags: readonly InjectionFlag[];
  readonly prior: {
    readonly p_active: number | null;
    readonly role_shares: Readonly<Record<string, number>> | null;
  } | null;
  readonly evidence: readonly {
    readonly source: string;
    readonly claim: UntrustedText;
    readonly type: ClaimExtract["type"];
    readonly direction: ClaimExtract["direction"];
    readonly reliability: number;
    readonly time: IsoInstant | null;
    readonly official: boolean;
    readonly decayed: boolean;
  }[];
  /** null until the calibration table has EVIDENCE_POSTERIOR_MIN_N scored claims. */
  readonly posterior: {
    readonly p_active: number | null;
    readonly role_shares: Readonly<Record<string, number>> | null;
  } | null;
  readonly what_would_confirm: readonly string[];
  readonly consequence: {
    readonly affects: readonly ("lineup" | "waivers" | "trade")[];
    readonly re_run: readonly string[];
  };
  readonly calibration_state: {
    readonly table_n: number;
    readonly note: "priors are hand-set" | null;
  };
  readonly rec: Rec;
}

// --- E11 espn_analyze_league_activity ---------------------------------------------------------------

/** `espn_analyze_league_activity` data (plan 07 E11). */
export interface LeagueActivityData extends AnalyticsResult {
  readonly window: { readonly from: IsoInstant; readonly to: IsoInstant };
  readonly transactions: {
    readonly adds: number;
    readonly drops: number;
    readonly claims: number;
    readonly losing_claims: number;
    readonly trades: number;
    readonly by_team: readonly {
      readonly team_id: number;
      readonly name: UntrustedText;
      readonly adds: number;
      readonly drops: number;
      readonly claims_won: number;
      readonly claims_lost: number;
      readonly notable: readonly {
        readonly player_id: number;
        readonly name: BareText;
        readonly action: string;
      }[];
    }[];
  };
  readonly waiver_order_movement: readonly {
    readonly team_id: number;
    readonly rank_before: number | null;
    readonly rank_after: number | null;
    readonly cause: "successful_claim" | "reset" | null;
  }[];
  readonly claims_by_rank: readonly {
    readonly rank: number;
    readonly won: number;
    readonly lost: number;
  }[];
  readonly standings_movement: readonly {
    readonly team_id: number;
    readonly rank_before: number | null;
    readonly rank_after: number | null;
  }[];
  readonly top_added: readonly {
    readonly player_id: number;
    readonly name: BareText;
    readonly count: number;
  }[];
  readonly top_dropped: readonly {
    readonly player_id: number;
    readonly name: BareText;
    readonly count: number;
  }[];
  readonly rival_needs: readonly {
    readonly team_id: number;
    readonly weakest_slots: readonly string[];
    readonly likely_targets: readonly number[];
    readonly ir_blocked: boolean;
  }[];
  readonly learned: {
    readonly second_claim_at_new_position: boolean | null;
    readonly waiver_rank_moves_on_success: boolean | null;
  };
  readonly rec: Rec | null;
}

// --- D1–D6 dataset-read tool data (plan 07 §3.D) -------------------------------------------------

/** `espn_get_player_usage` data (plan 07 D1). */
export interface PlayerUsageData {
  readonly players: readonly {
    readonly player_id: number | null;
    readonly gsis_id: string | null;
    readonly name: BareText;
    readonly position: string;
    readonly nfl_team: string | null;
    readonly games?: readonly UsageGameRow[];
    readonly trailing: {
      readonly window_games: number;
      readonly snap_pct: number | null;
      readonly target_share: number | null;
      readonly carry_share: number | null;
      readonly rz_share: number | null;
      readonly wopr: number | null;
      readonly tprr_proxy: number | null;
      readonly xfp_gap_sum: number | null;
      readonly change_point: {
        readonly week: Week;
        readonly metric: string;
        readonly delta: number;
      } | null;
    };
    readonly role_confidence_games: number;
    readonly data_gaps: readonly string[];
  }[];
  readonly notes: readonly string[];
}

/** One per-game usage row (D1 `games[]`, `detail: full`). */
export interface UsageGameRow {
  readonly week: Week;
  readonly opponent: string | null;
  readonly snaps: number | null;
  readonly snap_pct: number | null;
  /** Routes have no free in-season source: a snap-share proxy, named so (research 04 #3). */
  readonly routes_proxy: number | null;
  readonly targets: number | null;
  readonly target_share: number | null;
  readonly air_yards: number | null;
  readonly air_yards_share: number | null;
  readonly adot: number | null;
  readonly wopr: number | null;
  readonly racr: number | null;
  readonly carries: number | null;
  readonly carry_share: number | null;
  readonly rz_targets: number | null;
  readonly rz_carries: number | null;
  readonly gl_carries: number | null;
  /**
   * The player's team's red-zone opportunities that week (its targets + carries inside the 20, nflverse
   * pbp) — the rz_share denominator; absent or null when the pbp file does not cover the week (added
   * in Phase 2 — plan 10 §3.2).
   */
  readonly rz_team?: number | null;
  readonly xfp_ep: number | null;
  readonly points_league: number | null;
  readonly xfp_gap: number | null;
}

/** `espn_get_injuries` data (plan 07 D2). */
export interface InjuriesData {
  readonly players: readonly {
    readonly player_id: number | null;
    readonly gsis_id: string | null;
    readonly name: BareText;
    readonly position: string;
    readonly pro_team: string | null;
    readonly espn: {
      readonly injury_status: InjuryStatus | null;
      readonly injured: boolean;
      readonly ir_eligible: boolean | null;
      readonly last_news_at: IsoInstant | null;
      /** ESPN's enum carries no timestamp — null is honest (research 04 §B.1.4). */
      readonly as_of: null;
    };
    readonly official: {
      readonly report_status: BareText | null;
      readonly practice: readonly { readonly day: string; readonly status: BareText }[];
      readonly primary_injury: UntrustedText | null;
      readonly secondary_injury: UntrustedText | null;
      readonly report_week: Week | null;
      readonly as_of: IsoInstant;
    } | null;
    readonly p_active: number | null;
    readonly p_active_basis: PActiveBasis;
    readonly trend: "improving" | "flat" | "worsening" | null;
    readonly sources_agree: boolean | null;
    readonly game_day: boolean;
  }[];
  readonly base_rates_note: string;
}

/** `espn_get_schedule` data (plan 07 D3). */
export interface ScheduleData {
  readonly games: readonly {
    readonly espn_game_id: number;
    readonly week: Week;
    readonly kickoff: IsoInstant | null;
    readonly start_time_tbd: boolean;
    readonly valid_for_locking: boolean;
    readonly stats_official: boolean;
    readonly state: "pre" | "in" | "final" | "tbd";
    readonly away: string;
    readonly home: string;
    readonly roof: string | null;
    readonly surface: string | null;
    readonly divisional: boolean | null;
    readonly rest_days: { readonly away: number | null; readonly home: number | null };
    readonly lines:
      | (GameLines & {
          readonly source: "nflverse:schedules";
          readonly secondary: GameLines | null;
        })
      | null;
    readonly weather: {
      readonly temp_f: number | null;
      readonly wind_mph: number | null;
      readonly gust_mph: number | null;
      readonly precip_prob: number | null;
      readonly as_of: IsoInstant;
      readonly source: string;
    } | null;
    readonly score: { readonly away: number; readonly home: number } | null;
  }[];
  readonly byes: Readonly<Record<string, readonly string[]>>;
  readonly lock_windows: readonly {
    readonly open_at: IsoInstant;
    readonly close_at: IsoInstant;
    readonly espn_game_ids: readonly number[];
  }[];
}

/** Betting lines for one game (nflverse `schedules`; positive spread = home favoured). */
export interface GameLines {
  readonly spread_line: number | null;
  readonly total_line: number | null;
  readonly implied: { readonly away: number | null; readonly home: number | null };
  readonly moneyline: { readonly away: number | null; readonly home: number | null };
  readonly as_of: IsoInstant;
}

/** `espn_get_depth_chart` data (plan 07 D4 = sib D4 with `player_id`). */
export interface DepthChartData {
  readonly teams: readonly {
    readonly nfl_team: string;
    readonly as_of: IsoInstant;
    readonly groups: readonly {
      readonly pos_grp: string;
      readonly slots: readonly {
        readonly pos_abb: string;
        readonly rank: number;
        readonly gsis_id: string | null;
        readonly player_id: number | null;
        readonly name: BareText;
        readonly snap_pct_last3: number | null;
      }[];
    }[];
  }[];
  readonly sleeper_cross_check: "agree" | "disagree" | "unavailable";
}

/** `espn_get_defense_profile` data (plan 07 D5 = sib D5 + ESPN's rating as a labelled comparator). */
export interface DefenseProfileData {
  readonly defenses: readonly {
    readonly nfl_team: string;
    readonly window_games: number;
    readonly afpa: Readonly<
      Record<
        string,
        {
          readonly allowed_per_game: number;
          readonly league_mean: number;
          readonly adjusted: number;
          readonly shrink_w: number;
          readonly multiplier: number;
          readonly espn_positional_rating: {
            readonly average: number;
            readonly rank: number;
          } | null;
        }
      >
    >;
    readonly pace_plays_per_game: number | null;
    readonly pass_rate: number | null;
    readonly proe: number | null;
    readonly pressure_rate: number | null;
    readonly sack_rate: number | null;
    readonly takeaway_rate: number | null;
    readonly epa_allowed: { readonly pass: number; readonly rush: number } | null;
  }[];
  readonly evidence_note: string;
}

/** `espn_get_news` data (plan 07 D6) — all text wrapped. */
export interface NewsData {
  readonly items: readonly {
    readonly id: string;
    readonly source: "rotowire" | "espn" | "cbs";
    readonly published_at: IsoInstant;
    readonly players_matched: readonly {
      readonly gsis_id: string | null;
      readonly player_id: number | null;
      readonly name: BareText;
      readonly match_confidence: number;
    }[];
    readonly title: UntrustedText;
    readonly blurb: UntrustedText;
    /** Text only — never rendered as a link, never fetched. */
    readonly url: UntrustedText;
    readonly claim: ClaimExtract | null;
    readonly reliability_prior: number | null;
    readonly flags: readonly InjectionFlag[];
  }[];
}

// --- dataset provenance and read-only ports (plan 01 §5.4–§5.5) ------------------------------------

/**
 * How a dataset read reports its provenance. State is judged from `checked_at` (the last
 * successful release check) for release-basis classes, never from `fetched_at` alone.
 */
export interface DatasetStamp {
  readonly source: DatasetSourceId;
  /** Release `updated_at` / `timestamp.txt` of the open file version. */
  readonly as_of: IsoInstant;
  /** When `eff refresh` last downloaded it. */
  readonly fetched_at: IsoInstant;
  /** Last successful release check, even when unchanged (refresh_log `checked_at`). */
  readonly checked_at: IsoInstant;
  readonly freshness_class: FreshnessClassId;
  readonly file_version: string;
}

/**
 * Rows plus the stamp of the dataset they came from; `stamp` is null exactly when the dataset was
 * never loaded (the tool answers STALE_ONLY with the "run eff refresh" hint, never an empty success).
 */
export interface DatasetResult<T> {
  readonly rows: readonly T[];
  readonly stamp: DatasetStamp | null;
}

/** One nflverse schedule row, joined to ESPN by `espn_game_id` (research 04 §B.1.6). */
export interface NflGame {
  readonly game_id: string;
  readonly espn_game_id: number | null;
  readonly season: number;
  readonly week: Week;
  readonly kickoff: IsoInstant | null;
  readonly away: NflTeam;
  readonly home: NflTeam;
  readonly roof: string | null;
  readonly surface: string | null;
  readonly stadium: UntrustedText | null;
  readonly divisional: boolean | null;
  readonly rest_days: { readonly away: number | null; readonly home: number | null };
  readonly lines: GameLines | null;
  readonly is_final: boolean;
  readonly score: { readonly away: number; readonly home: number } | null;
}

/** One official injury-report row (nflverse `injuries`). */
export interface InjuryReport {
  readonly gsis_id: string;
  readonly season: number;
  readonly week: Week;
  readonly nfl_team: NflTeam;
  readonly report_status: BareText | null;
  readonly practice: readonly { readonly day: string; readonly status: BareText }[];
  readonly primary_injury: UntrustedText | null;
  readonly secondary_injury: UntrustedText | null;
  readonly as_of: IsoInstant;
}

/** One player-week of nflverse stats, translated to a canonical line, plus its usage fields. */
export interface PlayerWeekLine {
  readonly gsis_id: string;
  readonly season: number;
  readonly week: Week;
  readonly nfl_team: NflTeam;
  readonly opponent: NflTeam | null;
  readonly position: string;
  readonly line: StatLine;
  readonly usage: Omit<UsageGameRow, "week" | "opponent" | "points_league" | "xfp_gap"> | null;
}

/** One team-defence week (the DST line of a team, plan 08 §3.2). */
export interface TeamDefenseWeekLine {
  readonly nfl_team: NflTeam;
  readonly season: number;
  readonly week: Week;
  readonly opponent: NflTeam | null;
  readonly line: StatLine;
}

/** One depth-chart row (nflverse `depth_charts` — ESPN-keyed, research 04 §A #7). */
export interface DepthChartRow {
  readonly season: number;
  readonly week: Week | null;
  readonly nfl_team: NflTeam;
  readonly pos_grp: string;
  readonly pos_abb: string;
  readonly rank: number;
  readonly gsis_id: string | null;
  readonly espn_id: number | null;
  readonly name: BareText;
}

/** One expected-points row (ffopportunity `ep_weekly`). */
export interface EpWeeklyRow {
  readonly gsis_id: string;
  readonly season: number;
  readonly week: Week;
  readonly xfp_total: number | null;
}

/** Game-venue weather (Open-Meteo / NWS). */
export interface WeatherObservation {
  readonly game_id: string;
  readonly temp_f: number | null;
  readonly wind_mph: number | null;
  readonly gust_mph: number | null;
  readonly precip_prob: number | null;
  readonly as_of: IsoInstant;
  readonly source: "weather:open_meteo" | "weather:nws";
}

/** One stored news item (`ds_news`; 30-day retention). */
export interface NewsItem {
  readonly id: string;
  readonly source: "rotowire" | "espn" | "cbs";
  readonly published_at: IsoInstant;
  readonly title: UntrustedText;
  readonly blurb: UntrustedText;
  readonly url: UntrustedText;
  readonly gsis_ids: readonly string[];
}

/** One trending row (Sleeper — secondary; ESPN `percentChange` is primary). */
export interface TrendingRow {
  readonly gsis_id: string | null;
  readonly sleeper_id: string;
  readonly kind: "add" | "drop";
  readonly count: number;
  readonly as_of: IsoInstant;
}

/** Read-only port over `espn:pro_schedule` (kickoffs, byes, lock/final flags). */
export interface ProScheduleReader {
  games(season: number, weeks: readonly Week[] | null): DatasetResult<ProGame>;
  teams(season: number): DatasetResult<ProTeam>;
}

/** Read-only port over `nflverse:schedules`. */
export interface NflGamesReader {
  games(season: number, weeks: readonly Week[]): DatasetResult<NflGame>;
  byEspnGameId(espnGameIds: readonly number[]): DatasetResult<NflGame>;
}

/** Read-only port over `nflverse:injuries`. */
export interface InjuryReader {
  reports(
    season: number,
    week: Week,
    gsisIds: readonly string[] | null,
  ): DatasetResult<InjuryReport>;
}

/** Read-only port over `nflverse:stats_player_week` (+ snaps) and team defence lines. */
export interface PlayerWeekReader {
  lines(
    gsisIds: readonly string[],
    season: number,
    weeks: readonly Week[],
  ): DatasetResult<PlayerWeekLine>;
  defenseLines(
    teams: readonly NflTeam[],
    season: number,
    weeks: readonly Week[],
  ): DatasetResult<TeamDefenseWeekLine>;
}

/** Read-only port over `nflverse:depth_charts`. */
export interface DepthChartReader {
  chart(season: number, teams: readonly NflTeam[]): DatasetResult<DepthChartRow>;
}

/** Read-only port over `ffopportunity:ep_weekly`. */
export interface EpWeeklyReader {
  rows(
    gsisIds: readonly string[],
    season: number,
    weeks: readonly Week[],
  ): DatasetResult<EpWeeklyRow>;
}

/** Read-only port over the weather datasets. */
export interface WeatherReader {
  forGames(gameIds: readonly string[]): DatasetResult<WeatherObservation>;
}

/** Read-only port over `news:*`. */
export interface NewsReader {
  recent(
    sinceIso: IsoInstant,
    limit: number,
    gsisIds: readonly string[] | null,
  ): DatasetResult<NewsItem>;
}

/** Read-only port over `sleeper:trending`. */
export interface TrendingReader {
  latest(): DatasetResult<TrendingRow>;
}

/**
 * One defence-week of the pbp team profile (nflverse pbp, by `defteam`; plan 07 D5): counts over the
 * run/pass plays it faced, and the sums the rates and EPA are built from (tables.ts
 * `PbpReader.teamProfile` — the shrinkage and windowing are the tool's).
 */
export interface PbpTeamProfileRow {
  readonly nfl_team: NflTeam;
  readonly season: number;
  readonly week: Week;
  readonly plays: number;
  readonly dropbacks: number;
  readonly sacks: number;
  readonly interceptions: number;
  readonly fumbles_lost: number;
  readonly epa_dropback_sum: number | null;
  readonly epa_rush_sum: number | null;
  readonly rushes: number;
  /** nflverse's pass rate over expectation, mean over the plays that carry it (percent points). */
  readonly pass_oe_mean: number | null;
  readonly pass_oe_n: number;
}

/** Read-only port over `nflverse:pbp` (the D5 team profile; added in Phase 2 — plan 10 §3.2). */
export interface PbpReader {
  teamProfile(
    teams: readonly NflTeam[],
    season: number,
    weeks: readonly Week[],
  ): DatasetResult<PbpTeamProfileRow>;
}

/** Every dataset port the analytics need, bundled for injection. */
export interface DatasetReaders {
  readonly proSchedule: ProScheduleReader;
  readonly nflGames: NflGamesReader;
  readonly injuries: InjuryReader;
  readonly playerWeeks: PlayerWeekReader;
  readonly depthCharts: DepthChartReader;
  readonly epWeekly: EpWeeklyReader;
  readonly weather: WeatherReader;
  readonly news: NewsReader;
  readonly trending: TrendingReader;
  /** The pbp team profile (optional: a reader bundle built before Phase 2 has none). */
  readonly pbp?: PbpReader;
}

// --- projection stores (plan 08 §5, §9; plan 01 §9.2 `projection`, `espn_projection`) ---------------

/** A best-effort write's outcome: a lock timeout is a counted miss, never an error. */
export type BestEffortOutcome =
  { readonly written: true } | { readonly written: false; readonly reason: "busy" };

/**
 * Our stored projection, format-agnostic, scored per league at read time (plan 08 §5, E7). Rows
 * are append-only per (player, season, week, model_version, made_at), so the retrospective reads
 * the newest projection made before lock and no post-kickoff run leaks the outcome.
 */
export interface StoredProjection {
  readonly player_id: number;
  readonly gsis_id: string | null;
  readonly season: number;
  readonly week: Week;
  readonly model_version: ModelVersion;
  readonly made_at: IsoInstant;
  /** The newest `as_of` among its inputs. */
  readonly inputs_as_of: IsoInstant;
  readonly expectation: Readonly<Record<Canonical, number>>;
  readonly samples: readonly StatLine[];
}

/** `projection` (best-effort, never pruned). */
export interface ProjectionRepository {
  put(p: StoredProjection): BestEffortOutcome;
  latest(
    playerId: number,
    season: number,
    week: Week,
    model: ModelVersion,
  ): StoredProjection | null;
  /** The newest projection made strictly before `before` — the only read the retrospective scores. */
  getAsOf(
    playerId: number,
    season: number,
    week: Week,
    model: ModelVersion,
    before: IsoInstant,
  ): StoredProjection | null;
}

/** One ESPN projection snapshot — the prospective backtest corpus (plan 06 §1.4; plan 08 §5). */
export interface EspnProjectionSnapshot {
  readonly player_id: number;
  readonly season: number;
  readonly week: Week | null;
  /** `weekly`, `ros` or `preseason` (the split, decoded). */
  readonly split: "weekly" | "ros" | "preseason";
  readonly applied_total: number;
  readonly stats_raw: Readonly<Record<string, number>>;
  readonly snapshot_at: IsoInstant;
}

/** `espn_projection` (required writes, never pruned). */
export interface EspnProjectionRepository {
  putMany(rows: readonly EspnProjectionSnapshot[]): number;
  /** The newest snapshot before `before` for each player of a week. */
  asOf(season: number, week: Week, before: IsoInstant): readonly EspnProjectionSnapshot[];
  lastSnapshotAt(): IsoInstant | null;
}
