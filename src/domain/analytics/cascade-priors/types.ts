// types.ts — the redistribution prior table's data model (plan 10 §3.3 "the redistribution prior
// table from pbp history", C6; plan 07 E7; sib research 05 §6.2 "a league-wide prior table by
// position pair, estimated from play-by-play history … rather than assume 1:1 inheritance"; research
// 05 §5 Injury cascade). Pure types: one team-week row per player (from nflverse pbp), the starter
// absences found in them, the table built from those absences, and the C6 evaluation's report. New
// here.

/** The opportunity components the cascade redistributes (plan 07 E7 `delta_opportunity`). */
export type PriorComponent = "targets" | "carries" | "rz";
export const PRIOR_COMPONENTS: readonly PriorComponent[] = Object.freeze([
  "targets",
  "carries",
  "rz",
]);

/** The skill positions the table reads; anything else in pbp is `OTHER` (counted in team totals). */
export type SkillPosition = "QB" | "RB" | "WR" | "TE";
export type UsagePosition = SkillPosition | "OTHER";
export const SKILL_POSITIONS: readonly SkillPosition[] = Object.freeze(["QB", "RB", "WR", "TE"]);

/** The positions whose absence the table models (a QB's absence is the backup's whole role: v1). */
export type InjuredPosition = "RB" | "WR" | "TE";
export const INJURED_POSITIONS: readonly InjuredPosition[] = Object.freeze(["RB", "WR", "TE"]);

/**
 * One player's opportunities in one team game (regular season), aggregated from nflverse pbp with
 * the store's own definitions (`PBP_TARGET_SQL`, `PBP_CARRY_SQL`, `redZoneFlag`): a target is a
 * pass attempt that is not a sack or a two-point try with a receiver; a carry a rush attempt that
 * is not a two-point try with a rusher; red-zone = `yardline_100 ≤ 20`. `depth` is his rank at his
 * position on that week's depth chart (1 = first; null = not listed). A player listed on the depth
 * chart with no opportunity has a row of zeros.
 */
export interface UsageRow {
  readonly season: number;
  readonly week: number;
  readonly team: string;
  /** A stable id within (season, team): a gsis id from pbp, or a pseudonym in a committed excerpt. */
  readonly player: string;
  readonly position: UsagePosition;
  readonly depth: number | null;
  readonly targets: number;
  readonly carries: number;
  readonly rz_targets: number;
  readonly rz_carries: number;
}

/** The starter roles whose absence is an event. */
export type StarterRole = "RB1" | "WR1" | "WR2" | "TE1";

/** A beneficiary's role: his position and rank among the REMAINING teammates at it (by opportunity). */
export type BeneficiaryRole =
  "QB1" | "QB2" | "RB1" | "RB2" | "RB3" | "WR1" | "WR2" | "WR3" | "WR4" | "TE1" | "TE2";
export const BENEFICIARY_ROLES: readonly BeneficiaryRole[] = Object.freeze([
  "QB1",
  "QB2",
  "RB1",
  "RB2",
  "RB3",
  "WR1",
  "WR2",
  "WR3",
  "WR4",
  "TE1",
  "TE2",
]);

/** Per-game opportunity shares of the team (each in [0, 1]). */
export interface ComponentShares {
  readonly targets: number;
  readonly carries: number;
  readonly rz: number;
}

/** A team's volume per game (targets, carries, red-zone opportunities). */
export interface ComponentVolume {
  readonly targets: number;
  readonly carries: number;
  readonly rz: number;
}

/**
 * The team context a cell is keyed by — computable at call time from E7's own inputs (the team's
 * volume and the injured player's shares), so the table never needs data E7 does not have.
 */
export interface TeamContext {
  /** The team's pass tilt: targets / (targets + carries) at or above the table's cut → "pass". */
  readonly tilt: "pass" | "run";
  /** The starter's hold on his main component (carries for an RB, targets otherwise). */
  readonly hold: "lead" | "share";
}
/** A cell key, `${tilt}|${hold}`. */
export type ContextKey = "pass|lead" | "pass|share" | "run|lead" | "run|share";
export const CONTEXT_KEYS: readonly ContextKey[] = Object.freeze([
  "pass|lead",
  "pass|share",
  "run|lead",
  "run|share",
]);

/** One teammate inside an absence event. */
export interface AbsenceTeammate {
  readonly player: string;
  readonly position: SkillPosition;
  readonly role: BeneficiaryRole;
  /** Depth-chart rank at his position in the first absence week (null = not listed). */
  readonly depth: number | null;
  /** Opportunities per game with the starter (the pre window's games he played). */
  readonly pre_opportunities: number;
  readonly pre: ComponentShares;
  readonly post: ComponentShares;
}

/** One starter absence of ≥ 2 consecutive team games (sib §6 Evaluation). */
export interface AbsenceEvent {
  readonly season: number;
  readonly team: string;
  /** The first week he missed. */
  readonly week: number;
  readonly injured: {
    readonly player: string;
    readonly position: InjuredPosition;
    readonly role: StarterRole;
    /** His shares in the pre window's games he played (the vacated shares). */
    readonly pre: ComponentShares;
  };
  /** The team's per-game volume in the pre window's games he played. */
  readonly team_pre: ComponentVolume;
  /** The team's per-game volume over the absence games evaluated (≤ 4). */
  readonly team_post: ComponentVolume;
  readonly pre_weeks: readonly number[];
  readonly post_weeks: readonly number[];
  /** Consecutive team games he missed (the post window is the first ≤ 4 of them). */
  readonly games_missed: number;
  readonly teammates: readonly AbsenceTeammate[];
}

/** The rules an absence must meet (recorded in the table so a rebuild is reproducible). */
export interface AbsenceRules {
  readonly first_week: number;
  readonly last_week: number;
  /** Team games before the absence the pre window looks back over. */
  readonly pre_games: number;
  /** Games of those the starter must have played (the last one included). */
  readonly min_pre_games_played: number;
  /** Consecutive missed team games for an absence to count. */
  readonly min_games_missed: number;
  /** Absence games evaluated (sib §6 Evaluation: "over the next 1–4 weeks"). */
  readonly max_post_games: number;
  /** The starter's minimum share of his main component (carries for RB, targets otherwise). */
  readonly min_starter_share: Readonly<Record<InjuredPosition, number>>;
}

/** One estimated factor: the expected share gained per unit of vacated share. */
export interface PriorFactor {
  /** E[Δshare_j / vacated] — shrunk toward the position-level factor; clamped ≥ 0 when applied. */
  readonly f: number;
  /** Spread of the realised per-event ratio (sib §6.4 "the spread of the prior"). */
  readonly sd: number;
  /** Teammate observations in the cell. */
  readonly n: number;
}

/** A cell: one injured position × team context (or the position's pooled row), per role. */
export type PriorCell = Readonly<
  Record<PriorComponent, Readonly<Partial<Record<BeneficiaryRole, PriorFactor>>>>
>;

/** The redistribution prior table (sib §6.2), built from pbp history. */
export interface CascadePriorTable {
  readonly version: "cascade-priors-v2";
  readonly seasons: readonly number[];
  readonly absences: number;
  readonly absences_by_position: Readonly<Record<InjuredPosition, number>>;
  readonly rules: AbsenceRules;
  /** The team-tilt cut: targets / (targets + carries) at or above → "pass". */
  readonly tilt_cut: number;
  /** The starter-hold cut per injured position (his main share at or above → "lead"). */
  readonly hold_cut: Readonly<Record<InjuredPosition, number>>;
  /** Pseudo-observations the cell factor is shrunk with toward the position's pooled factor. */
  readonly shrink_events: number;
  /** How beneficiary roles were assigned (predict.ts `rolesOf`); E7 assigns them the same way. */
  readonly role_rule: "usage" | "successor";
  /** Pooled per injured position (all contexts). */
  readonly pooled: Readonly<Record<InjuredPosition, PriorCell>>;
  /** Per injured position and context, keyed `${tilt}|${hold}`. */
  readonly cells: Readonly<
    Record<InjuredPosition, Readonly<Partial<Record<ContextKey, PriorCell>>>>
  >;
  /** Where the data came from (upstream files; never an identifier). */
  readonly provenance: readonly string[];
}

/**
 * One method's errors on one absence set (C6). The HEADLINE pair is the beneficiary share — each
 * teammate's change in his share of the starter's opportunity mix, as a fraction of the starter's
 * share (`b_j = Σ_c α_c Δs_j(c) / Σ_c α_c v_c`, α = the starter's targets and carries as fractions
 * of his opportunities): its MAE and the hit rate of the top predicted beneficiary on it. The
 * opportunity-share pair (targets + carries over the team's, B6's measure) and the per-component
 * MAEs are reported beside it.
 */
export interface MethodScore {
  readonly mae_beneficiary_share: number;
  readonly hit_rate: number;
  readonly hits: number;
  /** MAE of the opportunity-share change ((targets + carries) / team (targets + carries)). */
  readonly mae_opportunity: number;
  /** Top predicted = top realised on the opportunity-share change. */
  readonly hit_rate_opportunity: number;
  readonly mae_targets: number;
  readonly mae_carries: number;
  readonly mae_rz: number;
}

/** The C6 report for one absence set. */
export interface CascadeEvaluation {
  readonly absences: number;
  readonly teammate_rows: number;
  readonly by_position: Readonly<Record<InjuredPosition, number>>;
  readonly methods: Readonly<Record<CascadeMethod, MethodScore>>;
  /** Per evaluated absence (in order): whether each method's top was the realised top. */
  readonly event_hits: readonly Readonly<Record<CascadeMethod, boolean>>[];
}

/** An exact McNemar test of two methods' paired hits. */
export interface PairedHits {
  /** Absences only the first method hit. */
  readonly only_first: number;
  /** Absences only the second method hit. */
  readonly only_second: number;
  /** Two-sided exact p-value (binomial, p = ½, over the discordant absences). */
  readonly p_value: number;
}

/** Leave-one-season-out C6: one fold per season, the rest build the table. */
export interface CascadeCrossValidation {
  readonly folds: readonly {
    readonly season: number;
    readonly shrink_events: number;
    readonly train_absences: number;
    readonly evaluation: CascadeEvaluation;
  }[];
  /** Every fold's absences together (MAEs weighted by teammate rows, hits summed). */
  readonly pooled: CascadeEvaluation;
}

/** The methods C6 compares: cascade v2 (the table), v1 (role affinity) and two next-man-up rules. */
export type CascadeMethod = "v2_table" | "v1_affinity" | "next_man_up_usage" | "next_man_up_depth";
export const CASCADE_METHODS: readonly CascadeMethod[] = Object.freeze([
  "v2_table",
  "v1_affinity",
  "next_man_up_usage",
  "next_man_up_depth",
]);
