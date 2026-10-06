// types.ts — the scoring-engine contract the engine, the translators, the tools and the tests share
// (plan 08 §2; §3.4 position gating; §4 families, E4 rounding with `verified`; §6 golden
// tolerances and the E6 refusal share; E9 103/104 disputed). Deviation recorded: `StatLine.present`
// is a sorted array (not a Set) so every type is plain, serialisable data; position ids are branded
// so a slot id can never be passed where a position id is meant (plan 01 §9; research 03 §B.2).
// Ported from sibling @d72e03b, adapted to plan 08 §2's ESPN shapes (overrides, families, verify).

/** A platform the seam knows (plan 01 §9). */
export type PlatformId = "espn" | "yahoo";

/** A canonical stat name — the hub every ESPN id and every nflverse column maps to (plan 08 E2). */
export type Canonical = string;
/** Canonical-name grammar: lowercase snake case, ≤ 40 chars. */
export const CANONICAL_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * An ESPN position id (`defaultPositionId`, keys of `pointsOverrides`/`positionLimits`) — a
 * DIFFERENT numbering from lineup-slot ids (research 03 §B.2). Branded: build with `asPositionId`.
 */
export type PositionId = number & { readonly __brand: "PositionId" };

/** Brands an integer 0..99 as a position id; throws RangeError otherwise. */
export function asPositionId(n: number): PositionId {
  if (!Number.isInteger(n) || n < 0 || n > 99) throw new RangeError("scoring: invalid position id");
  return n as PositionId;
}

/** Position class: offence, kicker, team defence/special teams, head coach, IDP (plan 08 §2). */
export type PositionClass = "O" | "K" | "DST" | "HC" | "IDP";
/** Every position class. */
export const POSITION_CLASSES: readonly PositionClass[] = Object.freeze([
  "O",
  "K",
  "DST",
  "HC",
  "IDP",
]);

/** One scoring rule — one `scoringItems[]` entry, normalised (plan 08 §2). */
export interface ScoringRule {
  /** null = the ESPN id is not in the registry (unmapped, logged once per settings_hash). */
  readonly canonical: Canonical | null;
  /** ESPN statId as a string, e.g. "53" — opaque to the engine. */
  readonly platform_id: string;
  /** ESPN's abbreviation from the registry (display only; server-authored, not third-party text). */
  readonly abbr: string;
  /** `scoringItems[].points`. */
  readonly points: number;
  /** `pointsOverrides` keyed by position id string, e.g. `{ "16": 5 }` (plan 08 §3.4). */
  readonly overrides: Readonly<Record<string, number>>;
  /** `isReverseItem` — display metadata until the golden test says otherwise [U]. */
  readonly is_reverse: boolean;
  /** Position classes the rule applies to, from the registry (a D/ST tier never scores an O line). */
  readonly applies_to: readonly PositionClass[];
  /** E9: 103/104. */
  readonly disputed: boolean;
}

/** The bracket families (plan 08 §2; plan 07 A1 `families`). */
export const BRACKET_FAMILY_NAMES = [
  "fg_distance",
  "fg_attempt",
  "fg_miss",
  "dst_points_allowed",
  "dst_yards_allowed",
  "yardage_bonus",
  "long_td_bonus",
  "per_n_yards",
  "margin",
] as const;
export type BracketFamilyName = (typeof BRACKET_FAMILY_NAMES)[number];

/** One member of a family: an indicator stat for an inclusive scalar range. */
export interface BracketMember {
  readonly canonical: Canonical;
  readonly platform_id: string;
  readonly lower: number;
  /** null = open-ended (`46+`). */
  readonly upper: number | null;
}

/** A family of bracket items built from the ids present in `S` (plan 08 §4.1). */
export interface BracketFamily {
  readonly family: BracketFamilyName;
  readonly position_class: PositionClass;
  /** The raw scalar the family brackets: `dst_pa_raw`, `kick_distance`, `pass_yd`, … */
  readonly scalar: Canonical;
  /** From the fixed bound table, filtered to the ids present in S, sorted by `lower`. */
  readonly members: readonly BracketMember[];
  /** True for distance / PA / YA tiers (one indicator per game); false for cumulative bonuses. */
  readonly exclusive: boolean;
  /** The members partition the scalar's range with no gap (a gap is legal and recorded). */
  readonly complete_range: boolean;
}

/** ESPN's rounding of `appliedTotal` (plan 08 E4): unknown until the first golden run pins it. */
export type RoundingMode = "exact" | "per_stat_2dp" | "per_total_2dp";

/** Matchup-level items applied after player scoring, by the matchup layer (plan 08 §4.5). */
export interface MatchupScoringRules {
  readonly tie_rule: string;
  readonly playoff_tie_rule: string;
  readonly home_bonus: number;
  readonly playoff_home_bonus: number;
}

/** Normalised league scoring settings (plan 08 §2), produced by the ESPN normaliser. */
export interface ScoringSettings {
  readonly platform: PlatformId;
  readonly rules: readonly ScoringRule[];
  readonly families: readonly BracketFamily[];
  readonly matchup: MatchupScoringRules;
  readonly rounding: { readonly mode: RoundingMode; readonly verified: boolean };
  /** sha256 of canonical JSON of rules + families (order-independent), excluding `verified`. */
  readonly settings_hash: string;
}

/** ESPN `statSourceId`: 0 actual, 1 projected (research 03 §B.2). */
export type StatSourceId = 0 | 1;
/** ESPN `statSplitTypeId`: 0 season, 1 one scoring period, 2 frozen preseason (projected only). */
export type StatSplitTypeId = 0 | 1 | 2;

/** Which ESPN `stats[]` entry a line came from (ESPN lines only; plan 08 §3.3). */
export interface StatSplit {
  readonly source_id: StatSourceId;
  readonly split_type: StatSplitTypeId;
  readonly season: number;
  /** The scoring period for weekly splits; null for season splits. */
  readonly week: number | null;
}

/** Provenance of a canonical line (plan 08 §2). */
export type StatLineSource =
  "espn" | "nflverse" | "projection:v1-ensemble" | "projection:v2-opportunity" | (string & {});

/** A canonical stat line (plan 08 §2). */
export interface StatLine {
  /** Only stats that were present (a present 0 is `0`; an absent stat has no key). */
  readonly values: Readonly<Record<Canonical, number>>;
  /** The present canonical names, sorted ascending (distinguishes 0 from "not reported"). */
  readonly present: readonly Canonical[];
  /** The player's `defaultPositionId` (overrides key on it; never the slot). */
  readonly position: PositionId;
  readonly position_class: PositionClass;
  /** Any game of the period has `statsOfficial: false` (research 04 §B.1.6). */
  readonly provisional: boolean;
  readonly source: StatLineSource;
  readonly split?: StatSplit;
}

/** How one rule contributed to a score (plan 08 §2 `contributions`). */
export interface ScoreContribution {
  readonly canonical: Canonical;
  readonly platform_id: string;
  readonly value: number;
  readonly points_per: number;
  readonly override_used: boolean;
  readonly points: number;
  readonly kind: "linear" | "bracket" | "bonus";
}

/** `score(line, settings)` result (plan 08 §2). */
export interface ScoreResult {
  /** After the verified rounding rule; exact until verified. */
  readonly points: number;
  readonly points_exact: number;
  /** False if provisional AND a scored stat is absent, or a family is underivable from the source. */
  readonly complete: boolean;
  /** ESPN ids in settings with canonical = null (reported once per settings_hash). */
  readonly unmapped: readonly string[];
  /** Stats in the line not in the settings. */
  readonly ignored: readonly Canonical[];
  /** Families the source cannot produce (nflverse weekly has no per-play TD length). */
  readonly underivable: readonly Canonical[];
  readonly contributions: readonly ScoreContribution[];
}

/** Where a distribution's width came from (plan 07 legend `Dist.basis`). */
export type DistBasis = "position_cv" | "player_sim";
/** Every basis. */
export const DIST_BASES: readonly DistBasis[] = Object.freeze(["position_cv", "player_sim"]);

/** A points distribution (plan 07 legend `Dist`); every Skill prints `basis`. */
export interface Dist {
  readonly mean: number;
  readonly p10: number;
  readonly p25: number;
  readonly p50: number;
  readonly p75: number;
  readonly p90: number;
  /** Probability of exactly zero points (inactive / did not play). */
  readonly p_zero: number;
  readonly basis: DistBasis;
}

/** `scoreSamples(lines, settings, basis)` result (plan 08 §2). */
export interface ScoreSamplesResult {
  readonly dist: Dist;
  /** Linear part + expected bonus/bracket terms; equals the sample mean within MC error (P13). */
  readonly mean_of_exact: number;
  readonly bonus_probability: Readonly<Record<Canonical, number>>;
  /** Per family: the probability of each member, in member order. */
  readonly bracket_probability: Readonly<Record<string, readonly number[]>>;
}

/** ESPN's own scored values for one line: `appliedTotal` and `appliedStats{statId: pts}`. */
export interface AppliedReference {
  readonly total: number;
  readonly by_stat: Readonly<Record<string, number>>;
}

/** `verify(line, settings, applied)` — the golden comparator (plan 08 §2, P16). */
export interface VerifyResult {
  readonly match: boolean;
  /** ESPN stat ids whose per-stat delta exceeds GOLDEN_TOLERANCE.per_stat. */
  readonly mismatch_stat_ids: readonly string[];
  readonly delta_total: number;
}

/** The engine's functions (plan 08 §2, E1). Pure; implemented in src/domain/scoring/. */
export interface ScoringEngine {
  score(line: StatLine, settings: ScoringSettings): ScoreResult;
  scoreSamples(
    lines: readonly StatLine[],
    settings: ScoringSettings,
    basis: DistBasis,
  ): ScoreSamplesResult;
  /** `score` with contributions rendered (A5/B2 mismatch diagnostics, `onboard`). */
  explain(line: StatLine, settings: ScoringSettings): ScoreResult;
  verify(line: StatLine, settings: ScoringSettings, applied: AppliedReference): VerifyResult;
}

/** The golden tolerances (plan 08 E4, §6): never widened to make a test pass. */
export const GOLDEN_TOLERANCE = Object.freeze({ per_stat: 0.005, per_total: 0.01 });
/** League-wide refusal threshold: > 10 % of the checked week's rostered player-weeks (plan 08 E6). */
export const LEAGUE_MISMATCH_REFUSAL_SHARE = 0.1;
/** The disputed ESPN stat ids (plan 08 E9; research 03 §B.2): INT- vs fumble-return TD. */
export const DISPUTED_STAT_IDS: readonly string[] = Object.freeze(["103", "104"]);

/** Classification of a golden mismatch (plan 08 §6 step 3). */
export type MismatchKind =
  | "unmapped_id"
  | "override_missed"
  | "bracket_bounds"
  | "disputed_103_104"
  | "rounding"
  | "translator";

/** The golden status A1 reports (plan 07 A1 `scoring.golden.status`). */
export type GoldenStatus = "match" | "mismatch" | "unchecked";
