// types.ts — the ESPN league model every provider read produces and every domain module and tool
// consumes (plan 01 §9 "what the interface abstracts": refs, League + clock, roster slots, rules
// with predicates, rosters, PlatformPlayer with ESPN-native extras, matchups, live and box scores,
// standings, transactions, the pro schedule; plan 07 §3.A–C `data` shapes), the `untrusted_text`
// mechanics the normaliser applies field by field (plan 01 §4.4; plan 02 §6.2; plan 07 C14), the
// provenance stamp of every seam read, and the league-side repository ports tools read.
// Wire-free: no ESPN JSON key appears here. Member GUIDs never enter the domain (`is_mine` is
// computed by the provider; plan 02 §2.4, plan 07 legend). Ported from sibling @d72e03b, adapted.
import type { FreshnessClassId } from "../../config/freshness.js";
import type { SeedingMode } from "../../config/schema.js";
import type {
  BracketFamilyName,
  Canonical,
  GoldenStatus,
  PositionId,
  ScoringSettings,
  StatSplit,
} from "../scoring/types.js";

export type { PositionId } from "../scoring/types.js";

/** An NFL week / ESPN scoring period number (plan 02 §5: 0–22 outer bound). */
export type Week = number;
/** An ISO-8601 UTC instant string. */
export type IsoInstant = string;

/**
 * An ESPN lineup-slot id (`lineupSlotId`, `eligibleSlots[]`, keys of `lineupSlotCounts`) — NOT a
 * position id (research 03 §B.2 trap). Branded: build with `asSlotId`.
 */
export type SlotId = number & { readonly __brand: "SlotId" };

/** Brands an integer 0..99 as a slot id; throws RangeError otherwise. */
export function asSlotId(n: number): SlotId {
  if (!Number.isInteger(n) || n < 0 || n > 99) throw new RangeError("league: invalid slot id");
  return n as SlotId;
}

// --- untrusted text (plan 01 §4.4; plan 02 §6.2; plan 07 C14, C15) -------------------------------
//
// Defined in the domain (not src/mcp) because the ESPN normaliser — a provider, which may not import
// src/mcp — is the code that wraps, and the domain types must make a bare string at a free-text
// position a compile error. src/mcp/envelope.ts re-exports all of it and adds the walkers/schemas.

/** Every class of third-party or model-authored text, with its cap in code points (plan 01 §4.4). */
export const TEXT_CAPS = Object.freeze({
  team_name: 64,
  team_abbrev: 8,
  team_location: 32,
  team_nickname: 32,
  team_logo_url: 256,
  member_name: 32,
  league_name: 64,
  division_name: 32,
  trade_block: 500,
  draft_strategy: 500,
  player_outlook: 1200,
  player_name: 64,
  board_text: 500,
  transaction_note: 200,
  news_title: 160,
  news_blurb: 400,
  news_url: 256,
  dataset_text: 200,
  rec_log_text: 200,
  claim_text: 400,
  claim_source: 64,
});
export type TextClass = keyof typeof TEXT_CAPS;

/**
 * Every provenance tag a wrapper or a path-listed field may carry, with its text class (plan 01
 * §4.4 "Source tag"). The Skills weight reliability by tag, so code may not invent tags.
 */
export const UNTRUSTED_SOURCE_CLASS = Object.freeze({
  "espn.team.name": "team_name",
  "espn.team.abbrev": "team_abbrev",
  "espn.team.location": "team_location",
  "espn.team.nickname": "team_nickname",
  "espn.team.logo_url": "team_logo_url",
  "espn.team.trade_block": "trade_block",
  "espn.team.draft_strategy": "draft_strategy",
  "espn.member.name": "member_name",
  "espn.league.name": "league_name",
  "espn.division.name": "division_name",
  "espn.player.name": "player_name",
  "espn.player.outlook": "player_outlook",
  "espn.player.season_outlook": "player_outlook",
  "espn.board.text": "board_text",
  "espn.transaction.note": "transaction_note",
  "nflverse.roster_weekly.name": "player_name",
  "nflverse.players.name": "player_name",
  "nflverse.depth_charts.name": "player_name",
  "nflverse.injuries.primary_injury": "dataset_text",
  "nflverse.injuries.secondary_injury": "dataset_text",
  "nflverse.injuries.report_status": "dataset_text",
  "nflverse.injuries.practice_status": "dataset_text",
  "nflverse.schedules.stadium": "dataset_text",
  "nflverse.pbp.desc": "dataset_text",
  "sleeper.player.name": "player_name",
  "rss.rotowire.title": "news_title",
  "rss.rotowire.blurb": "news_blurb",
  "rss.espn.title": "news_title",
  "rss.espn.blurb": "news_blurb",
  "rss.cbs.title": "news_title",
  "rss.cbs.blurb": "news_blurb",
  "rss.rotowire.url": "news_url",
  "rss.espn.url": "news_url",
  "rss.cbs.url": "news_url",
  "store.recommendation_log": "rec_log_text",
  "user.claim.text": "claim_text",
  "user.claim.source": "claim_source",
} satisfies Record<string, TextClass>);
export type UntrustedSource = keyof typeof UNTRUSTED_SOURCE_CLASS;
/** Every registered tag. */
export const UNTRUSTED_SOURCES = Object.freeze(
  Object.keys(UNTRUSTED_SOURCE_CLASS) as UntrustedSource[],
);
/** Whether `s` is a registered provenance tag. */
export function isUntrustedSource(s: string): s is UntrustedSource {
  return Object.prototype.hasOwnProperty.call(UNTRUSTED_SOURCE_CLASS, s);
}
/** Provenance-tag grammar: 2–6 dot-separated lowercase segments. */
export const SOURCE_TAG_RE = /^[a-z0-9_]+(?:\.[a-z0-9_]+){1,5}$/;

/** The deterministic injection flags (plan 07 C4/C14; research 06 §A.3 rule 4). Never from a model. */
export const INJECTION_FLAGS = ["imperative", "second_person", "json_like", "role_marker"] as const;
export type InjectionFlag = (typeof INJECTION_FLAGS)[number];

/** The `untrusted_text` wrapper (plan 01 §4.4); `flags` present only when non-empty (C14). */
export interface UntrustedText {
  readonly untrusted_text: {
    readonly value: string;
    readonly source: UntrustedSource;
    /** Length of `value` in code points. */
    readonly chars: number;
    readonly truncated: boolean;
    readonly flags?: readonly InjectionFlag[];
  };
}

/**
 * A sanitised, capped third-party string emitted BARE whose output path must be listed in
 * `meta.untrusted_fields[]` (player names — plan 01 §4.4 after A7a; recommendation-log text — C15).
 * Branded so a raw string cannot be assigned to it: build with `bareUntrusted`.
 */
export type BareText = string & { readonly __bareText: true };

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  eacute: "é",
  egrave: "è",
  aacute: "á",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  ntilde: "ñ",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
  ccedil: "ç",
};

function decodeEntities(s: string): string {
  return s.replace(
    /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g,
    (_m, dec?: string, hex?: string, name?: string) => {
      if (name !== undefined) return NAMED_ENTITIES[name] ?? "";
      const cp = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? "", 16);
      return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)
        ? String.fromCodePoint(cp)
        : "";
    },
  );
}

/** Removes script/style blocks, comments, and every tag; prose such as "3 < 4" survives. */
function stripTags(s: string): string {
  return s
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[A-Za-z/!?][^<>]*>/g, " ")
    .replace(/<[A-Za-z/!?][^<>]*$/, " ");
}

/**
 * Removed outright: controls, format characters (zero-width, bidi overrides, soft hyphen), private
 * use, U+FFFD, the Tags block, and every other default-ignorable code point (variation selectors,
 * Hangul fillers) — invisible carriers of hidden instructions.
 */
const REMOVE_RE = /[\p{Cc}\p{Cf}\p{Co}\p{Default_Ignorable_Code_Point}\uFFFD\u{E0000}-\u{E007F}]/gu;
const SPACE_LIKE_RE = /[\t\n\v\f\r\u0085\u2028\u2029]/g;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** More than four stacked combining marks ("zalgo") are cut to four. */
const MARK_FLOOD_RE = /(\p{M}{4})\p{M}+/gu;
const ANY_ENTITY_RE = /&#?[A-Za-z0-9]{1,32};/g;
const MAX_PASSES = 6;

function sanitizePass(input: string): string {
  let s = input
    .normalize("NFC")
    .replace(LONE_SURROGATE_RE, "")
    .replace(SPACE_LIKE_RE, " ")
    .replace(REMOVE_RE, "");
  for (let i = 0; i < 8; i++) {
    const next = stripTags(decodeEntities(s));
    if (next === s) break;
    s = next;
  }
  s = stripTags(s.replace(ANY_ENTITY_RE, " "));
  s = s.replace(LONE_SURROGATE_RE, "").replace(SPACE_LIKE_RE, " ").replace(REMOVE_RE, "");
  s = s.normalize("NFC").replace(MARK_FLOOD_RE, "$1");
  return s.replace(/\s+/gu, " ").trim();
}

/** The sanitiser's output. */
export interface SanitizedText {
  readonly value: string;
  readonly truncated: boolean;
}

/**
 * Sanitises third-party text (plan 02 §6.2): bounded pre-cut (a 1 MB input stays linear), lone
 * surrogates dropped, entities decoded and HTML removed to a fixed point (an encoded tag cannot
 * survive), controls/zero-width/bidi/tag characters removed, combining floods capped, NFC,
 * whitespace collapsed, then capped at `cap` code points. Idempotent on its own output.
 */
export function sanitizeText(raw: string, cap: number): SanitizedText {
  if (!Number.isInteger(cap) || cap < 1)
    throw new RangeError("text: cap must be a positive integer");
  const precut = Math.max(cap * 8, 2048);
  let truncated = raw.length > precut;
  let s = truncated ? raw.slice(0, precut) : raw;
  let stable = false;
  for (let i = 0; i < MAX_PASSES && !stable; i++) {
    const next = sanitizePass(s);
    stable = next === s;
    s = next;
  }
  if (!stable) s = sanitizePass(s.replace(/[&<>]/g, " "));
  const cps = Array.from(s);
  if (cps.length > cap) {
    s = cps.slice(0, cap).join("").trimEnd();
    truncated = true;
  }
  return { value: s, truncated };
}

const FLAG_RES: readonly (readonly [InjectionFlag, RegExp])[] = [
  ["role_marker", /(?:^|[.!?:;]\s*)(?:system|assistant|user|developer)\s*:/i],
  [
    "imperative",
    /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|all|your)\s+(?:instructions|prompts|rules|directions|guidelines)\b/i,
  ],
  [
    "second_person",
    /\byou\s+(?:must|should|need\s+to|have\s+to|are\s+required\s+to|will\s+now)\b/i,
  ],
  ["json_like", /^\s*[{[]/],
];

/** The injection flags of an already-sanitised text, in INJECTION_FLAGS order. */
export function injectionFlags(text: string): InjectionFlag[] {
  const out: InjectionFlag[] = [];
  for (const f of INJECTION_FLAGS) {
    const re = FLAG_RES.find(([name]) => name === f)?.[1];
    if (re?.test(text) === true) out.push(f);
  }
  return out;
}

function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Wraps third-party text with the cap of its tag's class (plan 01 §4.4 `wrap(path, value, cap)`). */
export function wrapUntrusted(raw: string, source: UntrustedSource): UntrustedText {
  if (!isUntrustedSource(source)) throw new RangeError("text: unregistered untrusted source tag");
  const { value, truncated } = sanitizeText(raw, TEXT_CAPS[UNTRUSTED_SOURCE_CLASS[source]]);
  const flags = injectionFlags(value);
  const inner =
    flags.length > 0
      ? { value, source, chars: codePoints(value), truncated, flags }
      : { value, source, chars: codePoints(value), truncated };
  return { untrusted_text: inner };
}

/** `wrapUntrusted`, passing null/undefined through as null (absent text stays absent). */
export function wrapUntrustedOrNull(
  raw: string | null | undefined,
  source: UntrustedSource,
): UntrustedText | null {
  return raw === null || raw === undefined ? null : wrapUntrusted(raw, source);
}

/** A bare sanitised, capped string for a path-listed class; the caller lists its output path. */
export function bareUntrusted(raw: string, cls: TextClass): BareText {
  return sanitizeText(raw, TEXT_CAPS[cls]).value as BareText;
}

/** Whether a value is exactly an `untrusted_text` wrapper. */
export function isUntrustedText(v: unknown): v is UntrustedText {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (keys.length !== 1 || keys[0] !== "untrusted_text") return false;
  const inner = (v as { untrusted_text: unknown }).untrusted_text;
  if (typeof inner !== "object" || inner === null) return false;
  const i = inner as Record<string, unknown>;
  return (
    typeof i.value === "string" &&
    typeof i.source === "string" &&
    typeof i.chars === "number" &&
    typeof i.truncated === "boolean" &&
    (i.flags === undefined || Array.isArray(i.flags))
  );
}

// --- references --------------------------------------------------------------------------------

/** A league reference: ESPN leagues are per-season objects (research 03 §A.4). */
export interface LeagueRef {
  readonly platform: "espn";
  /** Canonical digits; operator config only, never model-set (plan 02 §5). */
  readonly league_id: string;
  readonly season: number;
}

/** A team reference. `team_id` is ESPN's team id (plan 02 §5: 1..20). */
export interface TeamRef {
  readonly league: LeagueRef;
  readonly team_id: number;
}

/**
 * A player reference (plan 01 §9): the only cross-platform identity is `gsis_id` via the crosswalk.
 * `id` is ESPN's player id — D/ST entries carry negative ids (−16000 − proTeamId) [A: verify on the
 * first recorded fixture].
 */
export interface PlayerRef {
  readonly platform: "espn";
  readonly id: number;
}

// --- provenance of platform facts (plan 01 §4.2 meta, §5.3, §5.4, §7) ------------------------------

/** How a read was served (plan 01 §8 log field `cache`). */
export type CacheOutcome = "hit" | "miss" | "stale" | "coalesced" | "breaker";

/** `meta.drift` when the detector is red for a view this result used (plan 01 §4.2). */
export interface DriftMeta {
  readonly views: readonly string[];
  readonly since: IsoInstant;
  readonly detail: "espn_get_status";
}

/**
 * Provenance of one platform read: enough for a tool to build its envelope without knowing the
 * provider. `source` is `espn:<view>` (or `espn:projection`); `as_of` is `x-fantasy-server-time`.
 */
export interface PlatformStamp {
  readonly source: string;
  readonly as_of: IsoInstant;
  readonly fetched_at: IsoInstant;
  readonly freshness: FreshnessClassId;
  readonly provisional: boolean;
  readonly cache: CacheOutcome;
  readonly drift: DriftMeta | null;
}

/** A platform value with its provenance: what every seam read resolves to. */
export interface Stamped<T> {
  readonly value: T;
  readonly stamp: PlatformStamp;
}

// --- league identity, clock, slots, rules (plan 01 §9; plan 07 A1) --------------------------------

/** The league clock from `status` (research 03 §A.4). */
export interface LeagueClock {
  readonly current_matchup_period: number;
  /** The top-level `scoringPeriodId`: the league's current period regardless of the request. */
  readonly current_scoring_period: number;
  readonly latest_scoring_period: number;
  readonly final_scoring_period: number;
  readonly first_scoring_period: number;
  readonly transaction_scoring_period: number | null;
  readonly is_active: boolean;
  readonly is_expired: boolean | null;
}

/** A division (names are commissioner-authored). */
export interface Division {
  readonly id: number;
  readonly name: UntrustedText;
  readonly size: number | null;
}

/** League identity and status (plan 01 §9 `getLeague`). */
export interface League {
  readonly ref: LeagueRef;
  readonly name: UntrustedText;
  readonly size: number;
  /** `scoringSettings.scoringType` (`H2H_POINTS`; others [U]). */
  readonly scoring_type: string;
  readonly is_public: boolean | null;
  readonly clock: LeagueClock;
  readonly previous_seasons: readonly number[];
  /** The team whose owners include the stored SWID (resolved by the provider). */
  readonly my_team: { readonly team_id: number; readonly name: UntrustedText } | null;
  /** The stored SWID is a commissioner (`isLeagueCreator || isLeagueManager`): a warning, never used. */
  readonly commissioner: boolean;
  readonly divisions: readonly Division[];
  readonly waiver_last_execution: IsoInstant | null;
  readonly waiver_next_execution: IsoInstant | null;
  readonly standings_updated_at: IsoInstant | null;
  readonly playoff_matchup_edited: boolean | null;
  readonly waiver_order_edited: boolean | null;
}

/** A roster slot's class (plan 01 §9). */
export type SlotClass = "starter" | "flex" | "bench" | "ir" | "other";
export const SLOT_CLASSES: readonly SlotClass[] = Object.freeze([
  "starter",
  "flex",
  "bench",
  "ir",
  "other",
]);

/** One slot type of the league (plan 07 A1 `roster.slots[]`). */
export interface RosterSlot {
  readonly slot_id: SlotId;
  /** ESPN's literal slot name (`FLEX`, `BE`, `IR`, `D/ST`). */
  readonly name: string;
  readonly class: SlotClass;
  readonly count: number;
  /** Position names the slot accepts (per-player `eligible_slots` stays authoritative). */
  readonly eligible_positions: readonly string[];
}

/** The league's roster configuration (plan 01 §9 `getRosterSlots`; plan 07 A1 `roster`). */
export interface RosterSlots {
  readonly slots: readonly RosterSlot[];
  /** Starter + flex slot count. */
  readonly starters: number;
  readonly bench: number;
  readonly ir: number;
  readonly total: number;
  readonly lineup_lock_type: string | null;
  readonly undroppable_list: boolean | null;
  /** Position name → max rostered; null = unlimited (ESPN −1). */
  readonly position_limits: Readonly<Record<string, number | null>>;
  readonly move_limit: number | null;
}

/** The waiver system (plan 07 G1 `capabilities.waiver_system`). */
export type WaiverSystem = "faab" | "priority_move_to_last" | "continuous" | "unknown";

/** Waiver and acquisition rules — ESPN's own enums as strings where unverified (plan 01 §9). */
export interface WaiverRules {
  /** `acquisitionType` (`WAIVERS_CONTINUOUS`; the non-FAAB value is [U]). */
  readonly type: string;
  readonly uses_budget: boolean | null;
  readonly budget: number | null;
  readonly min_bid: number | null;
  readonly waiver_hours: number | null;
  readonly process_days: readonly string[];
  /** `waiverProcessHour` — interpreted as ET, a fallback only (plan 06 §2; ADV OBJ-16). */
  readonly process_hour: number | null;
  /** `waiverOrderReset` — meaning [U]. */
  readonly order_reset: boolean | null;
  readonly next_execution: IsoInstant | null;
  readonly last_execution: IsoInstant | null;
  /** null = unlimited (ESPN −1). */
  readonly acquisition_limit: number | null;
  readonly matchup_acquisition_limit: number | null;
  /** Field names whose meaning is unverified (plan 07 A1 clean negative). */
  readonly unverified: readonly string[];
}

/** Trade rules (plan 07 A1 `rules.trade`). */
export interface TradeRules {
  readonly deadline: IsoInstant | null;
  readonly revision_hours: number | null;
  readonly veto_votes_required: number | null;
  /** null = unlimited (ESPN −1). */
  readonly max: number | null;
}

/** Playoff rules (plan 07 A1 `rules.playoffs`). */
export interface PlayoffRules {
  readonly team_count: number | null;
  /** `playoffSeedingRule` (`TOTAL_POINTS_SCORED` = win % first, PF tiebreak — research 05 §2.1). */
  readonly seeding_rule: string;
  readonly seeding_rule_by: number | null;
  readonly reseed: boolean | null;
  readonly matchup_period_length: number | null;
  readonly variable_length: boolean | null;
  readonly consolation: boolean | null;
  readonly regular_season_matchups: number | null;
  /** `matchupPeriods`: matchup period id → scoring periods. */
  readonly matchup_periods: Readonly<Record<string, readonly number[]>>;
  readonly playoff_weeks: readonly number[];
  readonly bye_seeds: number | null;
}

/** Tie rules (plan 07 A1 `rules.ties`). */
export interface TieRules {
  readonly matchup_tie_rule: string | null;
  readonly playoff_tie_rule: string | null;
}

/** The league's rules plus the derived predicates (plan 01 §9 `getLeagueRules`). */
export interface LeagueRules {
  readonly waiver: WaiverRules;
  readonly trade: TradeRules;
  readonly playoffs: PlayoffRules;
  readonly ties: TieRules;
  /** `financeSettings` amounts; null when absent. */
  readonly fees: Readonly<Record<string, number>> | null;
  readonly waiver_system: WaiverSystem;
  /** Conservative predicates: unknown enum values map to null, never to a guess. */
  readonly predicates: {
    readonly has_faab: boolean | null;
    readonly is_move_to_last: boolean | null;
  };
  readonly unverified_fields: readonly string[];
}

// --- players (plan 01 §9 PlatformPlayer; plan 07 B1/C1/C2 rows) -----------------------------------

/**
 * ESPN `player.injuryStatus` values observed (research 03 §B.2; `SUSPENSION` [U]). The domain owns
 * this vocabulary because IR eligibility is domain logic; unknown values are kept as strings.
 */
export const ESPN_INJURY_STATUSES = [
  "ACTIVE",
  "QUESTIONABLE",
  "DOUBTFUL",
  "OUT",
  "INJURY_RESERVE",
  "DAY_TO_DAY",
  "SUSPENSION",
] as const;
export type KnownInjuryStatus = (typeof ESPN_INJURY_STATUSES)[number];
/** A known status or an unknown one ESPN added (accepted, counted, logged once — plan 01 §7). */
export type InjuryStatus = KnownInjuryStatus | (string & {});
/** IR-eligible statuses: OUT or INJURY_RESERVE only (research 05 §4.3; plan 07 D2). */
export const IR_ELIGIBLE_INJURY_STATUSES: readonly KnownInjuryStatus[] = Object.freeze([
  "OUT",
  "INJURY_RESERVE",
]);
/** Whether a status makes a player IR-eligible (null/unknown → false: "not eligible per ESPN"). */
export function isIrEligible(status: InjuryStatus | null): boolean {
  return status !== null && (IR_ELIGIBLE_INJURY_STATUSES as readonly string[]).includes(status);
}

/** Player-pool status (research 03 §B.2). */
export const POOL_STATUSES = ["FREEAGENT", "WAIVERS", "ONTEAM"] as const;
export type PoolStatus = (typeof POOL_STATUSES)[number];

/** A game's state for a player (plan 07 B1). */
export type GameState = "pre" | "in" | "final" | "bye" | "tbd";

/** How a crosswalk pair was established (plan 07 C1 `crosswalk.method`). */
export type CrosswalkMethod = "id" | "match" | "override" | "none";
/** A player's crosswalk state as tools show it. */
export interface CrosswalkStatus {
  readonly method: CrosswalkMethod;
  readonly confidence: number;
}

/** ESPN ownership (`player.ownership`); a competition signal, never a detection signal (05 §1.3). */
export interface Ownership {
  readonly percent_owned: number | null;
  readonly percent_started: number | null;
  readonly percent_change: number | null;
  readonly average_draft_position: number | null;
  readonly auction_value_average: number | null;
  /** `ownership.date` when present (kona_player_info). */
  readonly as_of: IsoInstant | null;
}

/** ESPN editorial outlook text — tool-only (plan 07 C14). */
export interface PlayerOutlook {
  readonly season: UntrustedText | null;
  /** Week number (as a string key) → outlook text. */
  readonly weekly: Readonly<Record<string, UntrustedText>>;
}

/** ESPN's player record with the crosswalk fields and the ESPN-native extras (plan 01 §9). */
export interface PlatformPlayer {
  readonly ref: PlayerRef;
  readonly name: BareText;
  readonly position_id: PositionId;
  /** Display position from the POSITION map (QB, RB, WR, TE, K, D/ST, …) — never the slot map. */
  readonly position: string;
  readonly eligible_slot_ids: readonly SlotId[];
  /** Slot names of `eligible_slot_ids`. */
  readonly eligible_slots: readonly string[];
  readonly pro_team_id: number;
  /** ESPN's abbreviation (WSH, LAR — the crosswalk maps them to nflverse's WAS, LA). */
  readonly pro_team: string | null;
  readonly jersey: string | null;
  readonly bye_week: number | null;
  readonly injury_status: InjuryStatus | null;
  readonly injured: boolean;
  readonly droppable: boolean | null;
  readonly status: PoolStatus | null;
  readonly on_team_id: number | null;
  readonly waiver_process_date: IsoInstant | null;
  readonly ownership: Ownership | null;
  /** ESPN's weekly projection under this league's scoring (`appliedTotal`, split (1,1)). */
  readonly projection_week_espn: number | null;
  /** ESPN's rest-of-season projection (split (1,0); never the frozen preseason (1,2)). */
  readonly projection_ros_espn: number | null;
  readonly rank_week_espn: number | null;
  readonly draft_rank_espn: number | null;
  readonly last_news_at: IsoInstant | null;
  readonly has_outlook: boolean;
  /** Present only when a tool asked for outlook text (C4). */
  readonly outlook?: PlayerOutlook;
}

// --- rosters (plan 01 §9 getRoster; plan 07 B1) ----------------------------------------------------

/** One player on a roster in one week. */
export interface RosterEntry {
  readonly player: PlatformPlayer;
  readonly slot_id: SlotId;
  readonly slot: string;
  readonly slot_class: SlotClass;
  readonly is_flex: boolean;
  readonly lineup_locked: boolean;
  readonly acquisition: { readonly type: string | null; readonly date: IsoInstant | null };
  readonly points_week_espn: number | null;
  readonly pending_transaction: boolean;
}

/** A team's roster for a week. */
export interface Roster {
  readonly team: TeamRef;
  readonly team_name: UntrustedText;
  readonly week: Week;
  readonly is_mine: boolean;
  readonly entries: readonly RosterEntry[];
}

/** One lock instant and the players that lock at it (plan 07 B1 `lock_schedule[]`). */
export interface LockScheduleEntry {
  readonly lock_at: IsoInstant;
  readonly player_ids: readonly number[];
}

// --- matchups, live, box scores (plan 07 A3–A5) --------------------------------------------------

/** `schedule[].winner`. */
export type MatchupWinner = "HOME" | "AWAY" | "UNDECIDED";

/** One side of a season-schedule matchup (mMatchup). */
export interface MatchupSide {
  readonly team_id: number;
  readonly name: UntrustedText;
  readonly points: number | null;
  readonly points_by_week: Readonly<Record<string, number>>;
  readonly is_mine: boolean;
}

/** A season-schedule matchup; a bye is `home` without `away` (research 03 §B.4). */
export interface Matchup {
  readonly matchup_id: number;
  readonly matchup_period: number;
  readonly playoff_tier: string | null;
  readonly winner: MatchupWinner | null;
  readonly is_bye: boolean;
  readonly home: MatchupSide;
  readonly away: MatchupSide | null;
}

/** One side of a live matchup (mMatchupScore) — ESPN's numbers, labelled. */
export interface LiveSide {
  readonly team_id: number;
  readonly name: UntrustedText;
  readonly points_live: number | null;
  readonly projected_pre_espn: number | null;
  readonly projected_live_espn: number | null;
  readonly win_probability_espn: number | null;
  readonly players: {
    readonly final: number;
    readonly live: number;
    readonly pending: number;
  } | null;
}

/** A current-period matchup with live totals. */
export interface LiveMatchup {
  readonly matchup_id: number;
  readonly home: LiveSide;
  readonly away: LiveSide | null;
  readonly is_mine: boolean;
}

/** ESPN's stat line for one player-period as delivered (ESPN ids as strings). */
export interface PlatformStatLine {
  readonly player: PlayerRef;
  readonly split: StatSplit;
  /** `stats{statId: raw}`. */
  readonly raw: Readonly<Record<string, number>>;
  /** `appliedStats{statId: pts}` — carried beside the line, never into it (plan 08 §3.3). */
  readonly applied_stats: Readonly<Record<string, number>>;
  readonly applied_total: number | null;
  readonly provisional: boolean;
}

/** One rostered player in a box score (mBoxscore). */
export interface BoxScoreEntry {
  readonly player: PlatformPlayer;
  readonly slot_id: SlotId;
  readonly slot: string;
  readonly slot_class: SlotClass;
  readonly game_state: GameState;
  readonly actual: PlatformStatLine | null;
  readonly projected: PlatformStatLine | null;
}

/** One side of a box score. */
export interface BoxScoreSide {
  readonly team_id: number;
  readonly name: UntrustedText;
  readonly total_points: number | null;
  readonly entries: readonly BoxScoreEntry[];
}

/** One matchup's box score for a week (the golden's input — plan 07 C6). */
export interface BoxScoreMatchup {
  readonly matchup_id: number;
  readonly week: Week;
  readonly home: BoxScoreSide;
  readonly away: BoxScoreSide | null;
}

// --- standings (plan 07 A2) ------------------------------------------------------------------------

/** `transactionCounter` per team (plan 07 A2). */
export interface TransactionCounter {
  readonly acquisitions: number;
  readonly drops: number;
  readonly trades: number;
  readonly move_to_ir: number;
  readonly move_to_active: number;
  readonly budget_spent: number | null;
  readonly matchup_acquisitions: Readonly<Record<string, number>>;
}

/** One team's standing and the scalars the waiver and seeding engines depend on. */
export interface Standing {
  readonly team_id: number;
  readonly name: UntrustedText;
  readonly abbrev: UntrustedText;
  readonly division_id: number | null;
  readonly rank: number | null;
  readonly playoff_seed: number | null;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  readonly pct: number | null;
  readonly points_for: number;
  readonly points_against: number;
  readonly streak: { readonly type: string; readonly length: number } | null;
  readonly waiver_rank: number | null;
  readonly transaction_counter: TransactionCounter;
  readonly playoff_pct_espn: number | null;
  readonly projected_rank_espn: number | null;
  readonly clinch: string | null;
  readonly eliminated: boolean | null;
  readonly is_transaction_locked: boolean | null;
  readonly is_mine: boolean;
}

/** `espn_get_standings` data (plan 07 A2). */
export interface Standings {
  readonly teams: readonly Standing[];
  readonly waiver_order: readonly number[];
  readonly playoff_line: {
    readonly team_count: number | null;
    readonly seeding_rule: string;
    readonly bye_seeds: number | null;
  };
  readonly divisions: readonly {
    readonly id: number;
    readonly name: UntrustedText;
    readonly team_ids: readonly number[];
  }[];
}

// --- transactions (plan 07 A6; schema provisional until the 1b recording — ADV OBJ-19(c)) -----------

/** Transaction types (research 03 §B.2; `TRADE_ACCEPT` vs `TRADE_ACCEPTED` is [U]). */
export const TRANSACTION_TYPES = [
  "FREEAGENT",
  "WAIVER",
  "WAIVER_ERROR",
  "TRADE_ACCEPT",
  "TRADE_PROPOSAL",
  "TRADE_DECLINE",
  "TRADE_VETO",
  "TRADE_UPHOLD",
  "TRADE_ERROR",
  "ROSTER",
  "RETRO_ROSTER",
  "FUTURE_ROSTER",
  "DRAFT",
] as const;
export type KnownTransactionType = (typeof TRANSACTION_TYPES)[number];
export type TransactionType = KnownTransactionType | (string & {});
/** Item types inside a transaction. */
export type TransactionItemType = "ADD" | "DROP" | "LINEUP" | (string & {});

/** One player movement inside a transaction. */
export interface TransactionItem {
  readonly type: TransactionItemType;
  readonly player_id: number;
  readonly name: BareText | null;
  readonly from_team_id: number | null;
  readonly to_team_id: number | null;
  readonly from_slot: string | null;
  readonly to_slot: string | null;
}

/** A league transaction (persisted in `transactions_seen`; `memberId` dropped at the normaliser). */
export interface Transaction {
  readonly transaction_id: string;
  readonly type: TransactionType;
  readonly status: string | null;
  readonly team_id: number | null;
  readonly team_name: UntrustedText | null;
  readonly scoring_period: number | null;
  readonly process_date: IsoInstant | null;
  readonly proposed_date: IsoInstant | null;
  readonly bid_amount: number | null;
  readonly items: readonly TransactionItem[];
  readonly related_transaction_id: string | null;
  readonly note: UntrustedText | null;
}

// --- projections, ratings, pro schedule ---------------------------------------------------------

/** ESPN's native projection horizon (plan 07 C3). */
export type ProjectionHorizon = "week" | "ros" | "preseason";

/** ESPN's own projection for one player — labelled ESPN's, never ours (plan 01 D15; C13). */
export interface NativeProjection {
  readonly player: PlayerRef;
  readonly horizon: ProjectionHorizon;
  readonly season: number;
  /** The week for `week` horizon; null otherwise. */
  readonly week: Week | null;
  /** `appliedTotal` under this league's scoring. */
  readonly points: number;
  readonly raw: Readonly<Record<string, number>>;
  readonly as_of: IsoInstant | null;
}

/** One ESPN position-vs-opponent rating (mPositionalRatings; keyed by position ids 1–5, 16). */
export interface PositionalRating {
  readonly position_id: PositionId;
  readonly opponent_pro_team_id: number;
  readonly average: number | null;
  readonly rank: number | null;
}

/** One NFL game from `proTeamSchedules_wl` (the join key to nflverse `games.csv.espn`). */
export interface ProGame {
  readonly espn_game_id: number;
  readonly season: number;
  readonly week: Week;
  /** Never displayed when `start_time_tbd` (plan 07 D3). */
  readonly kickoff: IsoInstant | null;
  readonly start_time_tbd: boolean;
  readonly valid_for_locking: boolean;
  readonly stats_official: boolean;
  readonly home_pro_team_id: number;
  readonly away_pro_team_id: number;
}

/** One NFL team (public entity; ESPN-authored names are facts, not member text). */
export interface ProTeam {
  readonly id: number;
  readonly abbrev: string;
  readonly bye_week: number | null;
}

/** The season's pro schedule. */
export interface ProSchedule {
  readonly season: number;
  readonly teams: readonly ProTeam[];
  readonly games: readonly ProGame[];
}

/** Why `my_team` did or did not resolve (plan 03 §2.1 step 6; plan 02 §3.2 Own team). */
export interface OwnTeamResolution {
  readonly team_id: number | null;
  readonly reason: "resolved" | "no_credential" | "no_match" | "ambiguous";
}

// --- ESPN-fact tool `data` shapes (plan 07 §3.A–C) --------------------------------------------------

/** A1 `include` sections. */
export const LEAGUE_DIGEST_SECTIONS = [
  "league",
  "clock",
  "scoring",
  "roster",
  "rules",
  "seeding",
  "seeding_evidence",
] as const;
export type LeagueDigestSection = (typeof LEAGUE_DIGEST_SECTIONS)[number];

/** A1 `scoring` section. */
export interface ScoringDigest {
  readonly items: readonly {
    readonly stat_id: string;
    readonly abbr: string;
    readonly canonical: Canonical | null;
    readonly points: number;
    /** Position name → points (keys from the server's position table). */
    readonly overrides: Readonly<Record<string, number>>;
    readonly is_reverse: boolean;
  }[];
  readonly families: readonly {
    readonly family: BracketFamilyName;
    readonly members: readonly {
      readonly stat_id: string;
      readonly lower: number;
      readonly upper: number | null;
    }[];
  }[];
  readonly unmapped_stat_ids: readonly string[];
  readonly disputed_stat_ids: readonly string[];
  readonly settings_hash: string;
  readonly golden: {
    readonly last_checked_week: Week | null;
    readonly status: GoldenStatus;
    readonly mismatch_share: number | null;
  };
}

/** Last season's seed-vs-PF table — `onboard`'s one-time evidence (plan 07 C12; ADV OBJ-13). */
export interface SeedingEvidence {
  readonly season: number;
  readonly seed_order_matches_pf: boolean;
  readonly seed_order_matches_record: boolean;
  readonly playoff_edited: boolean | null;
  readonly suggests: SeedingMode | "unknown";
  readonly table: readonly {
    readonly team_id: number;
    readonly seed: number | null;
    readonly record_rank: number | null;
    readonly pf_rank: number | null;
  }[];
}

/** A1 `seeding` section (plan 07 C12): the operator's reading, flagged until confirmed. */
export interface SeedingDigest {
  readonly rule: string;
  readonly mode_configured: SeedingMode;
  readonly confirmed: boolean;
  readonly mode_in_use: SeedingMode;
  readonly evidence: SeedingEvidence | null;
}

/** `espn_get_league` data (plan 07 A1); a section is present only when included. */
export interface LeagueDigestData {
  readonly league?: {
    readonly season: number;
    readonly size: number;
    readonly scoring_type: string;
    readonly is_public: boolean | null;
    readonly name: UntrustedText;
    readonly my_team: { readonly team_id: number; readonly name: UntrustedText } | null;
    readonly commissioner: boolean;
  };
  readonly clock?: LeagueClock & {
    readonly current_week_final: boolean;
    readonly corrections_window_open: boolean;
  };
  readonly scoring?: ScoringDigest;
  readonly roster?: RosterSlots;
  readonly rules?: LeagueRules;
  readonly seeding?: SeedingDigest;
  readonly unverified_fields: readonly string[];
}

/** `espn_get_scoreboard` data (plan 07 A3). */
export interface ScoreboardData {
  readonly matchup_period: number;
  readonly weeks: readonly Week[];
  readonly matchups: readonly Matchup[];
}

/** `espn_get_live_scoreboard` data (plan 07 A4). */
export interface LiveScoreboardData {
  readonly week: Week;
  readonly game_window: {
    readonly open: boolean;
    readonly games_in_progress: readonly number[];
    readonly next_kickoff: IsoInstant | null;
  };
  readonly matchups: readonly LiveMatchup[];
  readonly my_matchup: number | null;
}

/** One player row of `espn_get_box_score` (plan 07 A5). */
export interface BoxScorePlayerRow {
  readonly player_id: number;
  readonly name: BareText;
  readonly position: string;
  readonly slot: string;
  readonly slot_class: SlotClass;
  readonly points_espn: number | null;
  readonly engine_points: number | null;
  readonly match: boolean | null;
  readonly mismatch_stat_ids: readonly string[];
  readonly projected_espn: number | null;
  readonly game_state: GameState;
  readonly stats?: Readonly<Record<string, number>>;
  readonly applied_stats?: Readonly<Record<string, number>>;
}

/** `espn_get_box_score` data (plan 07 A5). */
export interface BoxScoreData {
  readonly week: Week;
  readonly final: boolean;
  readonly matchups: readonly {
    readonly matchup_id: number;
    readonly home: BoxScoreSideRow;
    readonly away: BoxScoreSideRow | null;
  }[];
  readonly golden: {
    readonly checked: number;
    readonly matched: number;
    readonly mismatch_share: number | null;
    readonly settings_hash: string;
  };
}
/** One side of A5. */
export interface BoxScoreSideRow {
  readonly team_id: number;
  readonly name: UntrustedText;
  readonly total_points: number | null;
  readonly players: readonly BoxScorePlayerRow[];
}

/** `espn_list_transactions` data (plan 07 A6). */
export interface TransactionsData {
  readonly transactions: readonly Transaction[];
  readonly pending: readonly Transaction[] | null;
  readonly history_coverage: {
    readonly oldest_seen: IsoInstant | null;
    readonly gap_suspected: boolean;
  };
  readonly learned: {
    readonly second_claim_at_new_position: boolean | null;
    readonly waiver_rank_moves_on_success: boolean | null;
  };
}

/** Ownership as a roster/pool row shows it (plan 07 B1). */
export interface OwnershipRow {
  readonly percent_owned: number | null;
  readonly percent_started: number | null;
  readonly percent_change: number | null;
  /** Always true: ownership change is a competition signal (plan 07 E5; research 05 §1.3). */
  readonly competition_signal: true;
}

/** One player row of `espn_get_roster` (plan 07 B1). */
export interface RosterPlayerRow {
  readonly player_id: number;
  readonly gsis_id: string | null;
  readonly name: BareText;
  readonly position: string;
  readonly eligible_slots: readonly string[];
  readonly pro_team: string | null;
  readonly bye_week: number | null;
  readonly slot: string;
  readonly slot_id: SlotId;
  readonly slot_class: SlotClass;
  readonly is_flex: boolean;
  readonly lineup_locked: boolean;
  readonly kickoff: IsoInstant | null;
  readonly lock_at: IsoInstant | null;
  readonly game_state: GameState;
  readonly injury_status: InjuryStatus | null;
  readonly injured: boolean;
  readonly ir_eligible: boolean;
  readonly droppable: boolean | null;
  readonly ownership: OwnershipRow | null;
  readonly projection_week_espn: number | null;
  readonly points_week_espn: number | null;
  readonly last_news_at: IsoInstant | null;
  readonly has_outlook: boolean;
  readonly acquisition: { readonly type: string | null; readonly date: IsoInstant | null };
  readonly crosswalk: CrosswalkStatus;
}

/** The IR audit of a roster (plan 07 B1 `ir`; research 05 §4.3). */
export interface IrSection {
  readonly slots: number;
  readonly occupied: readonly {
    readonly player_id: number;
    readonly injury_status: InjuryStatus | null;
  }[];
  /** A player in IR who is not IR-eligible makes the roster invalid and blocks every add. */
  readonly invalid: boolean;
  readonly invalid_players: readonly number[];
  readonly eligible_now: readonly number[];
  readonly forced_drop_needed: boolean;
  readonly blocked: readonly "adds"[];
}

/** `espn_get_roster` data (plan 07 B1). */
export interface RosterData {
  readonly team_id: number;
  readonly name: UntrustedText;
  readonly week: Week;
  readonly is_mine: boolean;
  readonly lineup_editable: boolean;
  readonly players: readonly RosterPlayerRow[];
  readonly ir: IrSection;
  readonly empty_starting_slots: readonly string[];
  readonly lock_schedule: readonly LockScheduleEntry[];
  readonly latest_execution_time: IsoInstant | null;
  readonly counts: {
    readonly starters: number;
    readonly bench: number;
    readonly ir: number;
    readonly total: number;
  };
}

/** `espn_get_player_stats` data (plan 07 B2). */
export interface PlayerStatsData {
  readonly players: readonly {
    readonly player_id: number;
    readonly gsis_id: string | null;
    readonly name: BareText;
    readonly position: string;
    readonly splits: readonly {
      readonly season: number;
      readonly week: Week | null;
      readonly source: "actual" | "projected";
      readonly points_espn: number | null;
      readonly engine_points: number | null;
      readonly match: boolean | null;
      readonly mismatch_stat_ids: readonly string[];
      readonly complete: boolean;
      readonly stats?: Readonly<Record<string, number>>;
    }[];
  }[];
  readonly unmapped_stat_ids: readonly string[];
  readonly settings_hash: string;
}

/** One `espn_search_players` row (plan 07 C1). */
export interface PlayerSearchRow {
  readonly player_id: number;
  readonly gsis_id: string | null;
  readonly name: BareText;
  readonly position: string;
  readonly eligible_slots: readonly string[];
  readonly pro_team: string | null;
  readonly jersey: string | null;
  /** null when `kona_player_info` drifted (identity only, with a warning). */
  readonly status: PoolStatus | null;
  readonly on_team_id: number | null;
  readonly on_team_name: UntrustedText | null;
  readonly waiver_process_date: IsoInstant | null;
  readonly injury_status: InjuryStatus | null;
  readonly droppable: boolean | null;
  readonly ownership: OwnershipRow | null;
  readonly projection_week_espn: number | null;
  readonly projection_ros_espn: number | null;
  readonly last_news_at: IsoInstant | null;
  readonly has_outlook: boolean;
  readonly crosswalk: CrosswalkStatus;
}

/** `espn_search_players` data (plan 07 C1). */
export interface PlayerSearchData {
  readonly players: readonly PlayerSearchRow[];
}

/** One `espn_list_players` row (plan 07 C2): C1's fields plus market and schedule context. */
export interface PlayerListRow extends PlayerSearchRow {
  readonly bye_week: number | null;
  readonly next_opponent: string | null;
  readonly next_kickoff: IsoInstant | null;
  readonly rank_week_espn: number | null;
}

/** `espn_list_players` data (plan 07 C2) — never outlook text (C14). */
export interface PlayerListData {
  readonly players: readonly PlayerListRow[];
}

/** `espn_get_projections` data (plan 07 C3): ESPN's numbers, `meta.estimate: false`. */
export interface EspnProjectionsData {
  readonly source: "espn:projection";
  readonly projections: readonly {
    readonly player_id: number;
    readonly name: BareText;
    readonly position: string;
    readonly week: {
      readonly week: Week;
      readonly points: number;
      readonly stats?: Readonly<Record<string, number>>;
    } | null;
    readonly ros: {
      readonly points: number;
      readonly weeks_remaining: number;
      readonly weekly?: Readonly<Record<string, number>>;
    } | null;
    readonly preseason_full_season: number | null;
    readonly as_of: IsoInstant | null;
    readonly revised_recently: boolean;
  }[];
  readonly note: string;
}

/** A deterministic claim extract (plan 07 C4/D6/E10 `claim`; rules, never a model). */
export interface ClaimExtract {
  readonly type: "availability" | "role" | "health" | "coaching_intent" | "transaction" | "other";
  readonly direction: "up" | "down" | "neutral";
  readonly extractor: "rules_v1";
}

/** `espn_get_player_outlook` data (plan 07 C4) — all text wrapped. */
export interface PlayerOutlookData {
  readonly players: readonly {
    readonly player_id: number;
    readonly name: BareText;
    readonly last_news_at: IsoInstant | null;
    readonly season_outlook: UntrustedText | null;
    readonly weekly: Readonly<Record<string, UntrustedText>>;
    readonly flags: readonly InjectionFlag[];
    readonly claim: ClaimExtract | null;
  }[];
}

// --- league-side repository ports (implemented by src/store; read by tools and jobs) -------------

/** A normalised league-settings snapshot (plan 08 §9; referenced by the log — never pruned). */
export interface LeagueSettingsRow {
  readonly league_id: string;
  readonly season: number;
  readonly settings_hash: string;
  readonly scoring: ScoringSettings;
  readonly slots: RosterSlots;
  readonly rules: LeagueRules;
  readonly fetched_at: IsoInstant;
}

/** A health check row (plan 07 G1 `checks[]`; plan 06 §1.4 T-08). */
export interface CheckRow {
  readonly id:
    "scoring_mismatch" | "settings_changed" | "ir_invalid" | "stale_credential" | "drift";
  readonly status: "ok" | "warn" | "fail";
  /** Fixed-vocabulary detail codes and numbers — never platform text. */
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
  readonly raised_at: IsoInstant;
  readonly acknowledged: boolean;
}

/** league_settings + checks (required writes). */
export interface LeagueSettingsRepository {
  put(row: LeagueSettingsRow): void;
  byHash(settingsHash: string): LeagueSettingsRow | null;
  latest(leagueId: string, season: number): LeagueSettingsRow | null;
  raiseCheck(check: CheckRow): void;
  openChecks(): readonly CheckRow[];
}

/** A nightly roster snapshot (plan 06 §1.4; `espn-ff://roster/snapshot`). */
export interface RosterSnapshot {
  readonly team_id: number;
  readonly week: Week;
  readonly taken_at: IsoInstant;
  readonly roster: Roster;
}

/** roster_snapshot (pruned after 30 days — plan 06 §1.3). */
export interface RosterSnapshotRepository {
  put(s: RosterSnapshot): void;
  /** The newest two snapshots, newest first, for diffs. */
  latestTwo(teamId: number): readonly RosterSnapshot[];
}

/** A nightly free-agent pool snapshot (plan 06 §1.4 `snapshot pool`). */
export interface PoolSnapshot {
  readonly taken_at: IsoInstant;
  readonly week: Week;
  readonly players: readonly PlatformPlayer[];
}

/** pool_snapshot (pruned after 30 days). */
export interface PoolSnapshotRepository {
  put(s: PoolSnapshot): void;
  latestTwo(): readonly PoolSnapshot[];
}

/** The pre-week ESPN win probability and playoff % per matchup (plan 07 E13 comparators, T-07). */
export interface ScoreboardSnapshot {
  readonly week: Week;
  readonly taken_at: IsoInstant;
  readonly matchups: readonly LiveMatchup[];
  readonly playoff_pct_espn: Readonly<Record<string, number | null>>;
}

/** scoreboard_snapshot (never pruned). */
export interface ScoreboardSnapshotRepository {
  put(s: ScoreboardSnapshot): void;
  forWeek(week: Week): readonly ScoreboardSnapshot[];
}

/** transactions_seen (append-only): history from install day (plan 07 A6 `history_coverage`). */
export interface TransactionsSeenRepository {
  /** Appends unseen transactions (dedup by id); returns how many were new. */
  appendNew(txns: readonly Transaction[], seenAt: IsoInstant): number;
  list(since: IsoInstant | null, limit: number): readonly Transaction[];
  oldestSeen(): IsoInstant | null;
}
