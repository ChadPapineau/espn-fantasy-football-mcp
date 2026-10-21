// types.ts — the seeding-reproduction contract (plan 10 §3.3 C4: "the implemented tiebreak chain
// reproduces `playoffSeed` exactly on ≥ 2 finished seasons … under reading (a); on points-only
// seasons the (b) chain reproduces them; a season neither reproduces is written up, not tolerated";
// research 05 §2.1, §2.4 "Evaluation", §8.4 #5). Inputs are structural picks of the provider's
// normalised `Standing`, `Matchup` and `PlayoffRules` (src/domain/league/types.ts), so a previous
// season read through the provider feeds it unchanged. Every string in an output is generated here
// from ids, codes and numbers — never third-party text. New here (Phase 3).
import type { SeedingMode } from "../../../config/schema.js";
import type { TieLevel } from "../seeding.js";

/** One team's final standing as ESPN reports it (a pick of the provider's `Standing`). */
export interface ReproduceTeam {
  readonly team_id: number;
  readonly division_id: number | null;
  /** ESPN `playoffSeed` (null when absent). */
  readonly playoff_seed: number | null;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  readonly points_for: number;
  readonly points_against: number;
}

/** One side of a schedule row (a pick of the provider's `MatchupSide`). */
export interface ReproduceSide {
  readonly team_id: number;
  readonly points: number | null;
}

/** One schedule row (a pick of the provider's `Matchup`; a finished tie arrives as `TIE`). */
export interface ReproduceMatchup {
  readonly matchup_period: number;
  readonly winner: "HOME" | "AWAY" | "TIE" | "UNDECIDED" | null;
  readonly is_bye: boolean;
  readonly home: ReproduceSide;
  readonly away: ReproduceSide | null;
}

/** The season's playoff settings (a pick of the provider's `PlayoffRules`). */
export interface ReproducePlayoff {
  readonly team_count: number | null;
  /** `playoffSeedingRule`. */
  readonly seeding_rule: string;
  /** `playoffSeedingRuleBy` (meaning [U]; 0 and −1 observed). */
  readonly seeding_rule_by: number | null;
  /** `matchupPeriodCount`: rows with a later period are playoff rows. */
  readonly regular_season_matchups: number | null;
}

/** One finished season to reproduce. */
export interface SeasonReproductionInput {
  readonly season: number;
  readonly teams: readonly ReproduceTeam[];
  readonly matchups: readonly ReproduceMatchup[];
  readonly playoff: ReproducePlayoff;
  /** `status.isPlayoffMatchupEdited` (a commissioner's edit of the bracket); null = unknown. */
  readonly playoff_edited: boolean | null;
}

/** Why a season does not reproduce, or what was noticed on the way (codes; `detail` is generated). */
export const REPRODUCTION_FINDINGS = [
  /** `matchupPeriodCount` is missing: playoff rows cannot be told apart, no game is read. */
  "regular_season_unknown",
  /** A regular-season row is undecided. */
  "season_unfinished",
  /** A schedule row names a team the standings do not carry (the row is skipped). */
  "schedule_unknown_team",
  /** A standing is non-finite or negative (nothing is ranked). */
  "standings_invalid",
  /** `playoffSeed` is missing or not a permutation of 1..N. */
  "seeds_incomplete",
  /** The standings' record or points differ from the recomputed regular-season results. */
  "records_disagree",
  /** The commissioner edited the bracket (`isPlayoffMatchupEdited`). */
  "playoff_edited",
  /** A tie survives every level above the coin flip: the order there cannot be reproduced. */
  "coin_flip_decides",
  /** `playoffSeedingRule` is not one ESPN is known to send (read as TOTAL_POINTS_SCORED). */
  "rule_unknown",
  /** The chain's order differs from `playoffSeed`. */
  "seed_mismatch",
] as const;
export type ReproductionFindingCode = (typeof REPRODUCTION_FINDINGS)[number];

/** One finding: a code and a generated one-line detail (ids and numbers only). */
export interface ReproductionFinding {
  readonly code: ReproductionFindingCode;
  readonly reading: SeedingMode | null;
  readonly detail: string;
}

/** One team whose predicted seed differs from ESPN's. */
export interface SeedMismatch {
  readonly team_id: number;
  readonly seed: number | null;
  readonly predicted: number;
}

/** The result of one reading on one season. */
export interface ReadingReproduction {
  readonly seeding_mode: SeedingMode;
  /** The chain applied, `division_winners_first` first when it applies. */
  readonly chain: readonly string[];
  /** Team ids in the chain's order (seed 1 first; a coin-decided tie in team-list order). */
  readonly order: readonly number[];
  /** Every team's seed equals its position, and no coin flip was needed. */
  readonly exact: boolean;
  /** Seeds 1..team_count equal the chain's first team_count positions (no coin flip needed). */
  readonly field_exact: boolean;
  /** ESPN's seeds agree with the chain at every level above the coin flip. */
  readonly consistent_up_to_coin: boolean;
  /** A tie survives every level above the coin flip. */
  readonly coin_flip_decides: boolean;
  /**
   * The deepest chain level that separated two teams (`null`: no level was needed — every team
   * was already apart, or one team); `coin_flip` when the coin decided.
   */
  readonly deciding_level: TieLevel | null;
  readonly mismatches: readonly SeedMismatch[];
}

/** One season's reproduction. */
export interface SeasonReproduction {
  readonly season: number;
  readonly teams: number;
  readonly playoff_team_count: number | null;
  readonly rule: string;
  readonly rule_by: number | null;
  readonly divisions: number;
  /** Decided regular-season games read (byes excluded). */
  readonly regular_games: number;
  readonly records_agree: boolean;
  readonly espn_rule: ReadingReproduction;
  readonly points_only: ReadingReproduction;
  readonly reproduced_by: "espn_rule" | "points_only" | "both" | "neither";
  readonly findings: readonly ReproductionFinding[];
  /** A generated one-line write-up of the season. */
  readonly note: string;
}

/** Many seasons (plan 10 C4's verdict). */
export interface ReproductionSummary {
  readonly seasons: readonly SeasonReproduction[];
  readonly reproduced_espn_rule: number;
  readonly reproduced_points_only: number;
  /** Seasons neither reading reproduces — each carries findings (never silent). */
  readonly neither: readonly number[];
  /** C4: ≥ `min_seasons` seasons reproduced exactly under reading (a) and every other one written up. */
  readonly c4_met: boolean;
  readonly min_seasons: number;
}
