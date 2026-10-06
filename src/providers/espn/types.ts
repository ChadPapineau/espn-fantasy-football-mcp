// types.ts — ESPN wire-level vocabulary, constants only (no parsing, no I/O): the host and route
// constants, the view whitelist by route and the do-nothing views (research 03 §A.1–§A.2; plan 02
// §5), the TWO id spaces kept distinct — lineup-slot ids and position ids (research 03 §B.2; plan 01
// §9) — the pro-team table, injury/pool/acquisition/transaction enums with unknown-value tolerance,
// `statSourceId`/`statSplitTypeId` (meaning-changing: unknown values fail the entry — plan 01 §7),
// waiver and playoff-seeding enums, the filter keys and caps, and the upstream error-type allow-list
// (plan 01 §4.3). Consumed by path.ts, filter.ts, ids.ts, normalize.ts, errors.ts and src/drift.
import {
  ESPN_API_BASE_PATH,
  ESPN_READ_HOST_DEFAULT,
  ESPN_WRITE_HOST,
  SEASON_MIN,
} from "../../config/schema.js";
import {
  ESPN_INJURY_STATUSES,
  IR_ELIGIBLE_INJURY_STATUSES,
  POOL_STATUSES,
  TRANSACTION_TYPES,
  asSlotId,
  type SlotClass,
  type SlotId,
} from "../../domain/league/types.js";
import { asPositionId, type PositionClass, type PositionId } from "../../domain/scoring/types.js";

export {
  ESPN_API_BASE_PATH,
  ESPN_INJURY_STATUSES,
  ESPN_READ_HOST_DEFAULT,
  ESPN_WRITE_HOST,
  IR_ELIGIBLE_INJURY_STATUSES,
  POOL_STATUSES,
  TRANSACTION_TYPES,
};

/** A known value of an ESPN enum, or a string ESPN added (accepted, counted, logged once). */
export type KnownOr<T extends string> = T | (string & {});

/** Whether `v` is one of a known value set (unknown values are tolerated by callers, not coerced). */
export function isKnownValue<T extends string>(known: readonly T[], v: string): v is T {
  return (known as readonly string[]).includes(v);
}

// --- routes (research 03 §A.1) --------------------------------------------------------------------

/** The game code and segment every route uses. */
export const ESPN_GAME = "ffl";
export const ESPN_SEGMENT = 0;
/** The first season the modern league route serves; older seasons are refused (plan 02 §5). */
export const ESPN_FIRST_SEASON = SEASON_MIN;
/** The league sub-paths the path builder accepts (plan 02 §5): `""` or the board's `communication/`. */
export const LEAGUE_SUB_PATHS = ["", "communication/"] as const;
export type LeagueSubPath = (typeof LEAGUE_SUB_PATHS)[number];

// --- views (research 03 §A.2; plan 02 §5 whitelist) -------------------------------------------------

/** Views served on `…/leagues/{id}` that a tool or job uses. */
export const LEAGUE_VIEWS = [
  "mSettings",
  "mNav",
  "mTeam",
  "mStandings",
  "mRoster",
  "mMatchup",
  "mMatchupScore",
  "mBoxscore",
  "mScoreboard",
  "mDraftDetail",
  "mTransactions2",
  "mPendingTransactions",
  "mPositionalRatings",
  "kona_player_info",
  "kona_playercard",
] as const;
export type LeagueView = (typeof LEAGUE_VIEWS)[number];

/** The one view on `…/leagues/{id}/communication/` — the credential board probe only (plan 02 §2.1). */
export const COMMUNICATION_VIEWS = ["kona_league_communication"] as const;
export type CommunicationView = (typeof COMMUNICATION_VIEWS)[number];

/** Season-level views, keyless, no league id (`/seasons/{s}` and `/seasons/{s}/players`). */
export const SEASON_VIEWS = ["proTeamSchedules_wl"] as const;
export const SEASON_PLAYER_VIEWS = ["players_wl"] as const;
export type SeasonView = (typeof SEASON_VIEWS)[number];
export type SeasonPlayerView = (typeof SEASON_PLAYER_VIEWS)[number];

/** Every whitelisted view. */
export type EspnView = LeagueView | CommunicationView | SeasonView | SeasonPlayerView;
export const ESPN_VIEWS: readonly EspnView[] = Object.freeze([
  ...LEAGUE_VIEWS,
  ...COMMUNICATION_VIEWS,
  ...SEASON_VIEWS,
  ...SEASON_PLAYER_VIEWS,
]);

/** Whether `v` is a whitelisted view of any route. */
export function isEspnView(v: string): v is EspnView {
  return (ESPN_VIEWS as readonly string[]).includes(v);
}

/**
 * Views that are refused even though they exist or circulate: the do-nothing views (a typo would
 * silently return a skeleton — research 03 §A.2), `mStatus` (carries `clientAddress`, an IP),
 * `allon` (4 MB), `mLiveScoring` (stripped anonymously; [U] with cookies), `mLeagueManager`,
 * `mTopPerformers`, and the message board (all member text; not in v1 — plan 01 §5.2).
 */
export const REFUSED_VIEWS = [
  "mRosterSettings",
  "mTeamsForWeek",
  "player_wl",
  "mSecondaryMatchupScore",
  "mLiveScoringDetail",
  "mNewspaper",
  "mDraftDetailForLM",
  "mPlayerHistory",
  "mStandingsRankings",
  "mLeagueHistory",
  "mLeagueSettings",
  "mSchedule",
  "modular",
  "mStatus",
  "allon",
  "mLiveScoring",
  "mLeagueManager",
  "mTopPerformers",
  "kona_league_messageboard",
] as const;

/** Views always requested alone (plan 01 §5.2: `mRoster` never composed — the 3.2 MB bootstrap). */
export const SOLO_VIEWS: readonly LeagueView[] = Object.freeze(["mRoster"]);

// --- headers, filter (research 03 §A.3–§A.4; plan 02 §5) ----------------------------------------

export const HEADER_FILTER = "X-Fantasy-Filter";
export const HEADER_PLAYER_COUNT = "x-fantasy-filter-player-count";
export const HEADER_TRANSACTION_COUNT = "x-fantasy-filter-transaction-count";
export const HEADER_SERVER_TIME = "x-fantasy-server-time";

/** Filter caps: `limit ≤ 100` with a mandatory sort; ≤ 50 ids per `filterIds` (plan 07 C3). */
export const FILTER_LIMIT_MAX = 100;
export const FILTER_OFFSET_MAX = 5000;
export const FILTER_IDS_MAX = 50;

/** Typed filter keys inside `players` (league paths) or at the root (`/players`). */
export const PLAYER_FILTER_KEYS = [
  "filterStatus",
  "filterSlotIds",
  "filterIds",
  "filterActive",
  "filterStatsForTopScoringPeriodIds",
  "limit",
  "offset",
] as const;
/** The sort keys (a `limit` requires one — `FILTER_LIMIT_MISSING_SORT`). */
export const PLAYER_SORT_KEYS = [
  "sortPercOwned",
  "sortPercChanged",
  "sortAppliedStatTotal",
  "sortDraftRanks",
] as const;
export type PlayerSortKey = (typeof PLAYER_SORT_KEYS)[number];

/** The plan 07 C2 `sort` values (`PlayerSort` in platform.ts; `playerSortSchema` in bounds.ts). */
export const PLAYER_SORTS = [
  "percOwned",
  "percChanged",
  "projection_week",
  "projection_ros",
  "draftRank",
  "name",
] as const;
export type PlayerSortName = (typeof PLAYER_SORTS)[number];

/**
 * How one C2 `sort` becomes ESPN's filter (plan 07 C2; plan 01 §4.2: a `limit` always carries an
 * ESPN sort). `split` names the stat split an applied-stat sort ranks by — the filter builder
 * encodes it (the wire encoding is [V-community], research 03 §A.3). `name` has no ESPN key: it is
 * fetched by `sortPercOwned` and re-sorted by name WITHIN the one returned page, so `offset > 0` is
 * refused (VALIDATION, reason `name_sort_single_page`) and the tool adds PLAYER_LIST_WARNINGS
 * `name_sort_page_only` — offset paging over a client-side re-sort would be wrong (plan 07 C2).
 */
export interface PlayerSortSpec {
  readonly key: PlayerSortKey;
  readonly sort_asc: boolean;
  /** The sort object's `value` (`STANDARD` for draft ranks); null = none sent. */
  readonly value: string | null;
  /** The split an applied-stat sort ranks by; null for the other keys. */
  readonly split: "weekly_projection" | "ros_projection" | null;
  /** `verified` = observed on a recorded request (research 03 P09); else [V-community]. */
  readonly evidence: "verified" | "community";
  /** `name`: re-sorted by name inside the single returned page; null = ESPN's order is final. */
  readonly client_resort: "name" | null;
  /** Whether `offset > 0` is allowed with this sort. */
  readonly offset_allowed: boolean;
}

const sortSpec = (s: PlayerSortSpec): PlayerSortSpec => Object.freeze(s);

/** C2 `sort` → ESPN sort (frozen; the filter builder's only source). */
export const PLAYER_SORT_MAP: Readonly<Record<PlayerSortName, PlayerSortSpec>> = Object.freeze({
  percOwned: sortSpec({
    key: "sortPercOwned",
    sort_asc: false,
    value: null,
    split: null,
    evidence: "verified",
    client_resort: null,
    offset_allowed: true,
  }),
  percChanged: sortSpec({
    key: "sortPercChanged",
    sort_asc: false,
    value: null,
    split: null,
    evidence: "community",
    client_resort: null,
    offset_allowed: true,
  }),
  projection_week: sortSpec({
    key: "sortAppliedStatTotal",
    sort_asc: false,
    value: null,
    split: "weekly_projection",
    evidence: "community",
    client_resort: null,
    offset_allowed: true,
  }),
  projection_ros: sortSpec({
    key: "sortAppliedStatTotal",
    sort_asc: false,
    value: null,
    split: "ros_projection",
    evidence: "community",
    client_resort: null,
    offset_allowed: true,
  }),
  draftRank: sortSpec({
    key: "sortDraftRanks",
    sort_asc: true,
    value: "STANDARD",
    split: null,
    evidence: "verified",
    client_resort: null,
    offset_allowed: true,
  }),
  name: sortSpec({
    key: "sortPercOwned",
    sort_asc: false,
    value: null,
    split: null,
    evidence: "verified",
    client_resort: "name",
    offset_allowed: false,
  }),
});

/**
 * C2 `injured` is a POST-filter on the returned page (`filterInjured` is [U] — research 03 §A.3):
 * the page keeps ESPN's order, `page.total` becomes null (the count header counts the unfiltered
 * pool) and the tool adds PLAYER_LIST_WARNINGS `injured_post_filter`.
 */
export const INJURED_FILTER_MODE = "post_filter" as const;

/** The fixed warnings C2 emits for the two client-side behaviours above (never upstream text). */
export const PLAYER_LIST_WARNINGS = Object.freeze({
  name_sort_page_only:
    "sort name orders only this page (ESPN has no name sort): the page is the top players by ownership; use espn_search_players for a name",
  injured_post_filter:
    "injured filters this page after ESPN returned it, so page.total is unknown and the page may hold fewer than limit players",
});

// --- lineup-slot ids (research 03 §B.2 — NOT position ids) ------------------------------------------

/** One lineup-slot id. `eligible` lists POSITION ids the slot accepts (descriptive; per-player
 * `eligibleSlots` is authoritative). Flex combinations are [V-community]; IDP slots rarely used. */
export interface EspnSlotInfo {
  readonly id: SlotId;
  readonly name: string;
  readonly class: SlotClass;
  readonly eligible: readonly PositionId[];
}

const slot = (
  id: number,
  name: string,
  cls: SlotClass,
  eligible: readonly number[],
): EspnSlotInfo =>
  Object.freeze({
    id: asSlotId(id),
    name,
    class: cls,
    eligible: Object.freeze(eligible.map(asPositionId)),
  });

const ALL_POSITIONS = [1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13, 14, 15, 16];

/** The lineup-slot table, keyed by slot id. */
// prettier-ignore
export const ESPN_SLOTS: Readonly<Record<number, EspnSlotInfo>> = Object.freeze({
  0: slot(0, "QB", "starter", [1]),
  1: slot(1, "TQB", "starter", [15]),
  2: slot(2, "RB", "starter", [2]),
  3: slot(3, "RB/WR", "flex", [2, 3]),
  4: slot(4, "WR", "starter", [3]),
  5: slot(5, "WR/TE", "flex", [3, 4]),
  6: slot(6, "TE", "starter", [4]),
  7: slot(7, "OP", "flex", [1, 2, 3, 4]),
  8: slot(8, "DT", "starter", [9]),
  9: slot(9, "DE", "starter", [10]),
  10: slot(10, "LB", "starter", [11]),
  11: slot(11, "DL", "flex", [9, 10]),
  12: slot(12, "CB", "starter", [12]),
  13: slot(13, "S", "starter", [13]),
  14: slot(14, "DB", "flex", [12, 13]),
  15: slot(15, "DP", "flex", [9, 10, 11, 12, 13]),
  16: slot(16, "D/ST", "starter", [16]),
  17: slot(17, "K", "starter", [5]),
  18: slot(18, "P", "starter", [7]),
  19: slot(19, "HC", "starter", [14]),
  20: slot(20, "BE", "bench", ALL_POSITIONS),
  21: slot(21, "IR", "ir", ALL_POSITIONS),
  22: slot(22, "", "other", []),
  23: slot(23, "FLEX", "flex", [2, 3, 4]),
  24: slot(24, "ER", "other", []),
  25: slot(25, "Rookie", "other", []),
});
/** The bench and IR slot ids (research 03 §B.2: `"20"` bench, `"21"` IR). */
export const SLOT_BENCH = asSlotId(20);
export const SLOT_IR = asSlotId(21);
export const SLOT_FLEX = asSlotId(23);

// --- position ids (research 03 §B.2 — NOT slot ids; 15 = TQB is an inference) ---------------------

/** One position id with its display name and scoring class (plan 08 §3.3). */
export interface EspnPositionInfo {
  readonly id: PositionId;
  readonly name: string;
  readonly class: PositionClass;
}

const pos = (id: number, name: string, cls: PositionClass): EspnPositionInfo =>
  Object.freeze({ id: asPositionId(id), name, class: cls });

/** The position table, keyed by position id. P (7) is classed `K` [A: no punting items in plan 08]. */
// prettier-ignore
export const ESPN_POSITIONS: Readonly<Record<number, EspnPositionInfo>> = Object.freeze({
  1: pos(1, "QB", "O"),
  2: pos(2, "RB", "O"),
  3: pos(3, "WR", "O"),
  4: pos(4, "TE", "O"),
  5: pos(5, "K", "K"),
  7: pos(7, "P", "K"),
  9: pos(9, "DT", "IDP"),
  10: pos(10, "DE", "IDP"),
  11: pos(11, "LB", "IDP"),
  12: pos(12, "CB", "IDP"),
  13: pos(13, "S", "IDP"),
  14: pos(14, "HC", "HC"),
  15: pos(15, "TQB", "O"),
  16: pos(16, "D/ST", "DST"),
});
/** `positionalRatings` keys (research 03 §A.2: 1, 2, 3, 4, 5, 16). */
export const POSITIONAL_RATING_POSITION_IDS: readonly PositionId[] = Object.freeze(
  [1, 2, 3, 4, 5, 16].map(asPositionId),
);

// --- team-unit player ids (research 03 §B.2; plan 02 §5 A-2 "widened on evidence") ---------------

/**
 * One family of team-unit "players" (a whole pro team occupying a slot): their ids are negative,
 * `base − proTeamId`, keyed by the unit's position id. `evidence` says whether a recorded fixture
 * carries such ids (`verified`) or the range is the same convention extended by assumption [A].
 */
export interface TeamUnitIdRange {
  readonly position_id: PositionId;
  readonly name: string;
  readonly base: number;
  readonly min: number;
  readonly max: number;
  readonly evidence: "verified" | "assumed";
}

const unit = (
  positionId: number,
  name: string,
  base: number,
  evidence: TeamUnitIdRange["evidence"],
): TeamUnitIdRange =>
  Object.freeze({
    position_id: asPositionId(positionId),
    name,
    base,
    min: base - 999,
    max: base - 1,
    evidence,
  });

/**
 * The team-unit id ranges. D/ST (16) and TQB (15) are verified on the recorded public leagues
 * (fixtures/espn/recorded: D/ST ids in every league, TQB ids −15000 − proTeamId in league-a's slot
 * 1); HC (14) is the same convention, unobserved [A].
 */
export const ESPN_TEAM_UNIT_ID_RANGES: readonly TeamUnitIdRange[] = Object.freeze([
  unit(16, "D/ST", -16000, "verified"),
  unit(15, "TQB", -15000, "verified"),
  unit(14, "HC", -14000, "assumed"),
]);

/** The team-unit range an id falls in, or null (every positive id is a person). */
export function teamUnitRangeOf(id: number): TeamUnitIdRange | null {
  if (!Number.isInteger(id)) return null;
  return ESPN_TEAM_UNIT_ID_RANGES.find((r) => id >= r.min && id <= r.max) ?? null;
}

/** Whether `id` is a team-unit player id (D/ST, TQB or HC). */
export function isTeamUnitPlayerId(id: number): boolean {
  return teamUnitRangeOf(id) !== null;
}

/** The pro-team id a team-unit player id stands for (`base − id`), or null for a person's id. */
export function teamUnitProTeamId(id: number): number | null {
  const r = teamUnitRangeOf(id);
  return r === null ? null : r.base - id;
}

/** The largest positive (person) ESPN player id accepted (plan 02 §5, A-2). */
export const ESPN_PERSON_PLAYER_ID_MAX = 99_999_999;

/** Whether `n` is an acceptable ESPN player id: a person 1..99 999 999 or a team-unit id. */
export function isEspnPlayerIdValue(n: number): boolean {
  return (
    Number.isInteger(n) && ((n >= 1 && n <= ESPN_PERSON_PLAYER_ID_MAX) || isTeamUnitPlayerId(n))
  );
}

/** D/ST player ids: −(16000 + proTeamId) — verified on the recorded fixtures. */
export const ESPN_DST_PLAYER_ID_BASE = -16000;
export const ESPN_DST_PLAYER_ID_MIN = -16999;
export const ESPN_DST_PLAYER_ID_MAX = -16001;
/** TQB (team quarterback) player ids: −(15000 + proTeamId) — verified on league-a. */
export const ESPN_TQB_PLAYER_ID_BASE = -15000;

// --- pro teams (research 03 §B.2, observed complete list; 31/32 unused) ----------------------------

/** ESPN pro-team id → abbreviation (0 = free agent). */
// prettier-ignore
export const ESPN_PRO_TEAMS: Readonly<Record<number, string>> = Object.freeze({
  0: "FA", 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET", 9: "GB",
  10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO",
  19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB",
  28: "WSH", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
});
/** The 32 NFL team abbreviations as ESPN spells them (no `FA`). */
export const ESPN_PRO_TEAM_ABBREVS: readonly string[] = Object.freeze(
  Object.entries(ESPN_PRO_TEAMS)
    .filter(([id]) => id !== "0")
    .map(([, abbr]) => abbr),
);

// --- enums with unknown-value tolerance (research 03 §B.2, §B.6) -----------------------------------

/** Roster-entry `injuryStatus`/`status` (observed `NORMAL`; others [U]). */
export const ROSTER_ENTRY_STATUSES = ["NORMAL"] as const;
/** Roster-entry `acquisitionType` (observed DRAFT, ADD, TRADE; others [U]). */
export const ROSTER_ACQUISITION_TYPES = ["DRAFT", "ADD", "TRADE"] as const;
/** Transaction item types. */
export const TRANSACTION_ITEM_TYPES = ["ADD", "DROP", "LINEUP"] as const;
/** PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; D11). Write `executionType`s; `VALIDATE` is a 400. */
export const EXECUTION_TYPES = ["EXECUTE", "CANCEL"] as const;
/**
 * `acquisitionSettings.acquisitionType`, both observed on the recorded public leagues: CONTINUOUS
 * on a FAAB league; TRADITIONAL on a FAAB league and on a rolling no-budget league (so the type
 * alone does not say FAAB — `isUsingAcquisitionBudget` does; league/types.ts `waiverSystemOf`).
 */
export const ACQUISITION_SETTING_TYPES = ["WAIVERS_CONTINUOUS", "WAIVERS_TRADITIONAL"] as const;
/** `waiverProcessDays[]` values. */
export const WAIVER_PROCESS_DAYS = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
] as const;
/** `playoffSeedingRule` (observed TOTAL_POINTS_SCORED; the others [V-community]). */
export const PLAYOFF_SEEDING_RULES = [
  "TOTAL_POINTS_SCORED",
  "H2H_RECORD",
  "INTRA_DIVISION_RECORD",
] as const;
/** `scoringType`, tie rules, lock type, winners, playoff tiers, streaks (others [U]). */
export const SCORING_TYPES = ["H2H_POINTS"] as const;
export const MATCHUP_TIE_RULES = ["SLOT_POINTS", "NONE"] as const;
export const LINEUP_LOCKTIME_TYPES = ["INDIVIDUAL_GAME"] as const;
export const MATCHUP_WINNERS = ["HOME", "AWAY", "UNDECIDED"] as const;
export const PLAYOFF_TIER_TYPES = ["NONE"] as const;
export const STREAK_TYPES = ["WIN", "LOSS"] as const;
/** `draftRanksByRankType` keys. */
export const DRAFT_RANK_TYPES = ["STANDARD", "PPR", "ELIMINATION", "SUPERFLEX"] as const;

// --- stat splits (research 03 §B.2; plan 08 §3.3) — meaning-changing ------------------------------

/** `statSourceId`: 0 actual, 1 projected. An unknown value FAILS the stat entry (plan 01 §7). */
export const STAT_SOURCE_IDS = [0, 1] as const;
/** `statSplitTypeId`: 0 season, 1 one scoring period, 2 frozen preseason (projected only). */
export const STAT_SPLIT_TYPE_IDS = [0, 1, 2] as const;

/** The five meaningful `(statSourceId, statSplitTypeId)` combinations (plan 08 §3.3). */
export const STAT_SPLITS = Object.freeze({
  weekly_actual: { source_id: 0, split_type: 1 },
  weekly_projection: { source_id: 1, split_type: 1 },
  season_actual: { source_id: 0, split_type: 0 },
  /** `(1,0)` — rest of season (sum of remaining weeks; research 04 §B.1.1). */
  ros_projection: { source_id: 1, split_type: 0 },
  /** `(1,2)` — frozen preseason; labelled, never called ROS. */
  preseason_projection: { source_id: 1, split_type: 2 },
} as const);
export type StatSplitName = keyof typeof STAT_SPLITS;

/** The split's name, or null for a combination that is drift (e.g. `(0,2)`, or an unknown id). */
export function statSplitName(sourceId: number, splitType: number): StatSplitName | null {
  for (const [name, s] of Object.entries(STAT_SPLITS) as [
    StatSplitName,
    { source_id: number; split_type: number },
  ][])
    if (s.source_id === sourceId && s.split_type === splitType) return name;
  return null;
}

// --- upstream error types (plan 01 §4.3: the only upstream strings that may appear) ----------------

/** Typed `details[].type` values known to the classifier (research 03 §A.4, §E.3). */
export const KNOWN_UPSTREAM_TYPES = [
  "GENERAL_NOT_FOUND",
  "FILTER_LIMIT_MISSING_SORT",
  "AUTH_LEAGUE_NOT_VISIBLE",
  "AUTH_COMMUNICATION_NOT_VISIBLE",
  "AUTH_MISSING_CREDENTIALS",
  "HTTP_METHOD_NOT_SUPPORTED",
  "TRAN_ROSTER_SAME_SLOT",
  "TRAN_LINEUP_LOCKED",
  "TRAN_ROSTER_SLOT_LIMIT_EXCEEDED",
  "TRAN_INVALID_SCORINGPERIOD_NOT_CURRENT",
  "TRAN_ROSTER_LIMIT_EXCEEDED",
  "TRAN_ROSTER_POSITION_LIMIT_EXCEEDED",
] as const;
/** The families allowed verbatim (`AUTH_*`, `TRAN_*`): uppercase snake, bounded. */
export const UPSTREAM_TYPE_FAMILY_RE = /^(?:AUTH|TRAN)_[A-Z0-9_]{2,60}$/;

/** The allow-listed `upstream_type`, or `UNKNOWN` (an unknown type is logged, never surfaced). */
export function upstreamTypeOrUnknown(v: unknown): string {
  if (typeof v !== "string") return "UNKNOWN";
  if ((KNOWN_UPSTREAM_TYPES as readonly string[]).includes(v) || UPSTREAM_TYPE_FAMILY_RE.test(v))
    return v;
  return "UNKNOWN";
}

// --- provider ports (additive, B1: the scoring translator and the credential probe seam) ----------

/**
 * The league's scoring items as ESPN sends them, value-checked by the normaliser (research 03 §B.1:
 * `pointsOverrides` keyed by POSITION id strings). The scoring module's translator turns this into
 * `ScoringSettings` with canonical names, families and the settings hash (plan 08 §2–§4; the ESPN
 * stat table `stat_map.ts` is the scoring module's).
 */
export interface EspnScoringInput {
  readonly scoring_type: string;
  readonly items: readonly {
    readonly stat_id: number;
    readonly points: number;
    readonly overrides: Readonly<Record<string, number>>;
    readonly is_reverse: boolean;
  }[];
  readonly matchup_tie_rule: string | null;
  readonly playoff_tie_rule: string | null;
  readonly home_bonus: number;
  readonly playoff_home_bonus: number;
}

/** The scoring module's normaliser, injected into the provider (plan 08 §1 `normalizeSettings()`). */
export type ScoringSettingsTranslator = (
  input: EspnScoringInput,
) => import("../../domain/scoring/types.js").ScoringSettings;

/**
 * The explicit probe's cookie access (plan 02 §2.1: the probe — `espn_check_auth`, `eff doctor
 * --online`, the daily job — is the one request exempt from the `rejected` short-circuit). A
 * CredentialAuthority MAY implement it; without it a probe in the `rejected` state reports the
 * short-circuit (no request) instead of re-checking.
 */
export interface CredentialProbeAccess {
  getCookieHeaderForProbe(): Promise<import("../../auth/types.js").CookieHeaderResult>;
}
