// types.ts — the start/sit replay's row contract (plan 10 C2; sib research 05 §3 Evaluation, §12.3):
// one team-week decision of a held-out season, the realised points of each decision rule's starters
// (the hindsight-best legal lineup, E2 under `auto`, `mean` and `pwin`, the two baselines plan 10
// A11a names — "start by ESPN's projection" and "start by last week's points" — and the manager's
// lineup as played), and the head-to-head facts the P(win) calibration and the "did it matter" share
// read — since Stage C (changelog R6-2) with each pair's projected and realised totals, so the
// margin calibration can read them. Types only (no runtime import of the engines, so lineup.ts can
// read the switch record). New here.
import type { DistBasis, Objective } from "../types.js";

/** The decision rules a replayed team-week records (plan 10 C2, A11a). */
export const START_SIT_RULES = Object.freeze([
  "hindsight",
  "auto",
  "mean",
  "pwin",
  "espn_projection",
  "last_week",
  "manager",
] as const);

/** One decision rule. */
export type StartSitRule = (typeof START_SIT_RULES)[number];

/**
 * One pair of lineups in a head-to-head — what a P(win) of the pair stands on (changelog R6-2,
 * Stage C: the margin calibration reads the margins, not only the binary result).
 */
export interface H2hPairFacts {
  /** My lineup's projected total (Σ served means). */
  readonly mu_m: number;
  /** The opponent lineup's projected total. */
  readonly mu_o: number;
  /** sd of M − O under the normal approximation (totals.ts `diffSd`). */
  readonly sd: number;
  /** My lineup's realised total. */
  readonly real_m: number;
  /** The opponent lineup's realised total. */
  readonly real_o: number;
}

/** The head-to-head facts of a team-week whose matchup is decided by this week's points. */
export interface StartSitH2h {
  /** My as-played starters out-scored the opponent's as-played starters; null on a tie. */
  readonly outcome_played: boolean | null;
  /** The model's P(win) of the two lineups as played (normal approximation, totals.ts). */
  readonly p_win_played: number;
  /** E2's `p_win_after` under `auto`: the recommended lineup vs the opponent's best-by-mean lineup. */
  readonly p_win_auto: number;
  /** The auto lineup's realised total beat the opponent's best-by-mean lineup's; null on a tie. */
  readonly outcome_auto: boolean | null;
  /** The opponent's realised as-played total. */
  readonly opponent_total: number;
  /** The opponent's team id — pairs a matchup's two mirrored sides; null when the caller gave none. */
  readonly opponent_id: number | null;
  /** The two lineups as played (the pair behind `p_win_played`). */
  readonly played: H2hPairFacts;
  /** The auto lineup vs the opponent's best-by-mean lineup (the pair behind `p_win_auto`). */
  readonly auto: H2hPairFacts;
}

/** One replayed team-week (every realised total rounded to 0.01 — ESPN's resolution). */
export interface StartSitRow {
  readonly season: number;
  readonly week: number;
  readonly team_id: number;
  /** E2's objective under `auto` for this team-week. */
  readonly objective_auto: Objective;
  /** E2's lineup basis (player_sim only when every rostered Dist is player_sim). */
  readonly basis: DistBasis;
  /** Share of the auto lineup's starters whose Dist is player_sim. */
  readonly player_sim_share: number;
  /** Realised points of each rule's starters; null when the rule is unavailable (last week in week 1). */
  readonly realised: Readonly<Record<StartSitRule, number | null>>;
  /** Each rule's starters as a sorted id key; null when unavailable. */
  readonly lineup_key: Readonly<Record<StartSitRule, string | null>>;
  /** Null when the matchup is not decided by this week's points or either side is incomplete. */
  readonly h2h: StartSitH2h | null;
}
