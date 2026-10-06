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
  return capCodePoints(sanitizeUncapped(raw, cap), cap);
}

/** `sanitizeText` before the code-point cap: the bounded pre-cut and the fixed-point clean. */
function sanitizeUncapped(raw: string, cap: number): SanitizedText {
  if (!Number.isInteger(cap) || cap < 1)
    throw new RangeError("text: cap must be a positive integer");
  const precut = Math.max(cap * 8, 2048);
  const truncated = raw.length > precut;
  let s = truncated ? raw.slice(0, precut) : raw;
  let stable = false;
  for (let i = 0; i < MAX_PASSES && !stable; i++) {
    const next = sanitizePass(s);
    stable = next === s;
    s = next;
  }
  if (!stable) s = sanitizePass(s.replace(/[&<>]/g, " "));
  return { value: s, truncated };
}

/** Cuts a sanitised text to `cap` code points (a cut sets `truncated`). */
function capCodePoints(t: SanitizedText, cap: number): SanitizedText {
  const cps = Array.from(t.value);
  return cps.length > cap ? { value: cps.slice(0, cap).join("").trimEnd(), truncated: true } : t;
}

/** Each flag fires when any of its patterns matches (a flag may have several). */
const FLAG_RES: readonly (readonly [InjectionFlag, RegExp])[] = [
  ["role_marker", /(?:^|[.!?:;]\s*)(?:system|assistant|user|developer)\s*:/i],
  [
    "imperative",
    /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|all|your)\s+(?:instructions|prompts|rules|directions|guidelines)\b/i,
  ],
  // the terse override without its noun: "IGNORE ALL PRIOR — …", "disregard the above"
  [
    "imperative",
    /\b(?:ignore|disregard)\s+(?:(?:all|any|the|everything)\s+)?(?:previous|prior|above|earlier)\b/i,
  ],
  // the whole field is the bare verb: a team abbreviation "IGNORE" (research 05 §6 case 2)
  ["imperative", /^[^\p{L}\p{N}]*(?:ignore|disregard)[^\p{L}\p{N}]*$/iu],
  [
    "second_person",
    /\byou\s+(?:must|should|need\s+to|have\s+to|are\s+required\s+to|will\s+now)\b/i,
  ],
  ["json_like", /^\s*[{[]/],
];

/**
 * A small confusables fold: Cyrillic and Greek letters that render like Latin ones (a stylised
 * team name can spell "ignore" with Cyrillic о/е). Applied only to the copy the flags are
 * evaluated on — the wrapped `value` stays NFC.
 */
const CONFUSABLES: Readonly<Record<string, string>> = Object.freeze({
  а: "a",
  в: "b",
  е: "e",
  ё: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  і: "i",
  ї: "i",
  ј: "j",
  ѕ: "s",
  ԁ: "d",
  ԛ: "q",
  ԝ: "w",
  ɡ: "g",
  ı: "i",
  α: "a",
  β: "b",
  ε: "e",
  η: "n",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
});
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "gu");

/**
 * The copy the flag regexes see: NFKC (fullwidth `ｉｇｎｏｒｅ`, mathematical alphanumerics `𝐢𝐠𝐧𝐨𝐫𝐞`,
 * ligatures and compatibility forms fold to ASCII), lower-cased, confusables folded, any mark left
 * by decomposition removed, whitespace collapsed (plan 07 C4/C14, M8).
 */
export function flagFold(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(CONFUSABLE_RE, (c) => CONFUSABLES[c] ?? c)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/\s+/gu, " ");
}

/** The injection flags of an already-sanitised text, in INJECTION_FLAGS order (on `flagFold`). */
export function injectionFlags(text: string): InjectionFlag[] {
  const folded = flagFold(text);
  const out: InjectionFlag[] = [];
  for (const f of INJECTION_FLAGS) {
    const hit = FLAG_RES.some(([name, re]) => name === f && (re.test(folded) || re.test(text)));
    if (hit) out.push(f);
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
  const cap = TEXT_CAPS[UNTRUSTED_SOURCE_CLASS[source]];
  const whole = sanitizeUncapped(raw, cap);
  const { value, truncated } = capCodePoints(whole, cap);
  // the flags read the whole sanitised text, not only the capped value: an instruction cut at the
  // cap still reaches the output in part ("Division 1. Ignore previous inst"), and plan 10 A8a
  // wants flags[] non-empty on every injected field
  const flags = injectionFlags(value);
  if (whole.value !== value) {
    const seen = new Set([...flags, ...injectionFlags(whole.value)]);
    flags.splice(0, flags.length, ...INJECTION_FLAGS.filter((f) => seen.has(f)));
  }
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

/** A team reference. `team_id` is ESPN's team id (a 1..999 grammar bound; membership checked against `teams[].id`). */
export interface TeamRef {
  readonly league: LeagueRef;
  readonly team_id: number;
}

/**
 * A player reference (plan 01 §9): the only cross-platform identity is `gsis_id` via the crosswalk.
 * `id` is ESPN's player id — team units carry negative ids `base − proTeamId`: D/ST −16000 and TQB
 * −15000 (both verified on the recorded fixtures), HC −14000 [A] (src/providers/espn/types.ts
 * ESPN_TEAM_UNIT_ID_RANGES). A team unit has no gsis id.
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

/** The codes a stale-cache answer carries into `warnings[]` (plan 01 §4.3, §5.7, §7). */
export const DEGRADED_CODES = [
  "ESPN_UPSTREAM_UNAVAILABLE",
  "ESPN_HOST_MOVED",
  "RATE_LIMITED",
] as const;
export type DegradedCode = (typeof DEGRADED_CODES)[number];

/**
 * Why a read was served from stale cache instead of failing (plan 01 §4.3 "stale cache within the
 * hard limit is returned as data with this code in warnings"): the tool copies `code` into
 * `warnings[]` (platform.ts `degradedWarning`). With NO usable cache the provider throws an Error
 * whose `effCode` is the code instead. While `ESPN_HOST_MOVED`, the hard limit is suspended.
 */
export interface DegradedRead {
  readonly code: DegradedCode;
  readonly served: "stale_cache";
  readonly hard_limit_suspended: boolean;
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
  /** Non-null exactly when the read was answered from stale cache because ESPN failed. */
  readonly degraded: DegradedRead | null;
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

/**
 * Waiver and acquisition rules — ESPN's own enums as strings where unverified (plan 01 §9).
 * Normalised by the helpers below; the recorded public leagues (research 03 §B.1, fixtures/espn/
 * recorded) ground every rule: a FAAB league on `WAIVERS_CONTINUOUS`, a FAAB league and a rolling
 * no-budget league on `WAIVERS_TRADITIONAL`.
 */
export interface WaiverRules {
  /** `acquisitionType`: `WAIVERS_CONTINUOUS` or `WAIVERS_TRADITIONAL` observed; others kept as-is. */
  readonly type: string;
  readonly uses_budget: boolean | null;
  /** FAAB budget — null unless `uses_budget` is true (a no-budget league still sends a number). */
  readonly budget: number | null;
  readonly min_bid: number | null;
  readonly waiver_hours: number | null;
  /** `waiverProcessDays[]` — may be EMPTY (the recorded rolling league sends `[]`). */
  readonly process_days: readonly string[];
  /** `waiverProcessHour` — interpreted as ET, a fallback only (plan 06 §2; ADV OBJ-16). */
  readonly process_hour: number | null;
  /** `waiverOrderReset` — false on the recorded rolling league, true on both FAAB leagues. */
  readonly order_reset: boolean | null;
  readonly next_execution: IsoInstant | null;
  readonly last_execution: IsoInstant | null;
  /** Season acquisitions cap; null = unlimited (ESPN −1). */
  readonly acquisition_limit: number | null;
  /**
   * Per-matchup acquisitions cap; null = unlimited. ESPN sends 0 for "no limit" (every recorded
   * league has 0 while teams made up to 4 adds in one matchup), and −1 elsewhere — both read null,
   * so `adds_remaining` (E5, E9) is null, never 0, on such a league.
   */
  readonly matchup_acquisition_limit: number | null;
  /** `matchupLimitPerScoringPeriod`: the cap counts per scoring period (true) or per matchup [U]. */
  readonly matchup_limit_per_period: boolean | null;
  /** Field names whose meaning is unverified (plan 07 A1 clean negative). */
  readonly unverified: readonly string[];
}

/** The raw acquisition settings the waiver normaliser reads (wire values, already type-checked). */
export interface AcquisitionSettingsInput {
  readonly acquisition_type: string | null;
  readonly uses_budget: boolean | null;
  readonly budget: number | null;
  readonly order_reset: boolean | null;
  readonly acquisition_limit: number | null;
  readonly matchup_acquisition_limit: number | null;
}

/** A season cap: −1 (and any negative) = unlimited → null; a finite non-negative integer is kept. */
export function normaliseAcquisitionLimit(raw: number | null): number | null {
  return raw === null || !Number.isInteger(raw) || raw < 0 ? null : raw;
}

/** A per-matchup cap: ≤ 0 = unlimited → null (ESPN sends 0 for "no limit" — recorded evidence). */
export function normaliseMatchupAcquisitionLimit(raw: number | null): number | null {
  return raw === null || !Number.isInteger(raw) || raw <= 0 ? null : raw;
}

/** The FAAB budget, or null unless the league uses one. */
export function normaliseAcquisitionBudget(
  usesBudget: boolean | null,
  budget: number | null,
): number | null {
  return usesBudget === true && budget !== null && Number.isFinite(budget) && budget >= 0
    ? budget
    : null;
}

/**
 * The waiver system (plan 07 G1 `capabilities.waiver_system`), conservatively: a budget → `faab`;
 * no budget on `WAIVERS_TRADITIONAL` without a weekly reset → `priority_move_to_last` (the recorded
 * rolling league); no budget on `WAIVERS_CONTINUOUS` → `continuous`; anything else (an unknown
 * type, a reset no-budget league, a null field) → `unknown`, never a guess.
 */
export function waiverSystemOf(a: AcquisitionSettingsInput): WaiverSystem {
  if (a.uses_budget === true) return "faab";
  if (a.uses_budget !== false) return "unknown";
  if (a.acquisition_type === "WAIVERS_TRADITIONAL" && a.order_reset === false)
    return "priority_move_to_last";
  if (a.acquisition_type === "WAIVERS_CONTINUOUS") return "continuous";
  return "unknown";
}

/** The conservative predicates of LeagueRules: unknown → null. */
export function waiverPredicatesOf(system: WaiverSystem): {
  readonly has_faab: boolean | null;
  readonly is_move_to_last: boolean | null;
} {
  switch (system) {
    case "faab":
      return { has_faab: true, is_move_to_last: false };
    case "priority_move_to_last":
      return { has_faab: false, is_move_to_last: true };
    case "continuous":
      return { has_faab: false, is_move_to_last: null };
    default:
      return { has_faab: null, is_move_to_last: null };
  }
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

/** Where a B2 split came from (plan 07 B2 incl. its degradation). */
export type StatSplitSource = "actual" | "projected" | "nflverse";
export const STAT_SPLIT_SOURCES: readonly StatSplitSource[] = Object.freeze([
  "actual",
  "projected",
  "nflverse",
]);

/**
 * Whether a B2 split is internally consistent: an `nflverse` split never carries an ESPN number
 * or a golden verdict (`points_espn` and `match` null); `match` is non-null only when both the
 * ESPN and the engine number exist.
 */
export function isConsistentStatSplit(s: {
  readonly source: StatSplitSource;
  readonly points_espn: number | null;
  readonly engine_points: number | null;
  readonly match: boolean | null;
}): boolean {
  if (s.source === "nflverse") return s.points_espn === null && s.match === null;
  return s.match === null || (s.points_espn !== null && s.engine_points !== null);
}

/**
 * B1 `all: true` (every team's roster from the same single mRoster request): the documented
 * compact field set per player — the facts a rival-roster read needs, nothing per-player-heavy.
 */
export const ROSTER_ALL_PLAYER_FIELDS = [
  "player_id",
  "name",
  "position",
  "pro_team",
  "slot",
  "slot_class",
  "lineup_locked",
  "injury_status",
  "projection_week_espn",
] as const;
export type RosterAllPlayerRow = Pick<RosterPlayerRow, (typeof ROSTER_ALL_PLAYER_FIELDS)[number]>;

/** One team inside B1 `all: true`. */
export interface RosterSummary {
  readonly team_id: number;
  readonly name: UntrustedText;
  readonly is_mine: boolean;
  readonly players: readonly RosterAllPlayerRow[];
  /** The IR audit's verdict only (`ir.invalid`) — the full section is the single-team read. */
  readonly ir_invalid: boolean;
  readonly counts: RosterData["counts"];
}

/** The array `fitToBudget` halves for B1 `all: true` (ten compact rosters can exceed 20 000 chars). */
export const ROSTER_ALL_LIST_KEY = "rosters";

/**
 * `espn_get_roster` data (plan 07 B1), discriminated on `scope`: one team in full, or — with
 * `all: true` — every team in the compact form (one outputSchema for both inputs).
 */
export type RosterToolData =
  | (RosterData & { readonly scope: "team" })
  | {
      readonly scope: "all";
      readonly week: Week;
      readonly rosters: readonly RosterSummary[];
    };

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
      /**
       * `nflverse`: B2's degradation when `kona_playercard` drifts — nflverse lines scored by the
       * engine, with `points_espn: null` and `match: null` (there is no ESPN number to match).
       */
      readonly source: StatSplitSource;
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

/** The health checks (plan 07 G1 `checks[].id`; plan 03 §5 #21–#23; plan 06 §1.4 T-08). */
export const CHECK_IDS = [
  "scoring_mismatch",
  "settings_changed",
  "ir_invalid",
  "stale_credential",
  "drift",
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

/**
 * Who may acknowledge a check — a human act in a terminal, never a model-callable tool (an
 * acknowledgement the model could make would let injected text silence a health check):
 * `eff doctor --ack <check>`, or `eff setup --seeding` (the step `onboard` ends with, which
 * acknowledges `settings_changed` up to the settings it showed the operator).
 */
export type CheckAcknowledger = "doctor" | "setup";

/** A health check row (plan 07 G1 `checks[]`; plan 06 §1.4 T-08). */
export interface CheckRow {
  readonly id: CheckId;
  readonly status: "ok" | "warn" | "fail";
  /** Fixed-vocabulary detail codes and numbers — never platform text. */
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
  /** With `id`, the check's key: a newer raise of the same id is a different check. */
  readonly raised_at: IsoInstant;
  /** The settings the check was raised against (`settings_changed`, `scoring_mismatch`); else null. */
  readonly settings_hash: string | null;
  readonly acknowledged: boolean;
  readonly acknowledged_at: IsoInstant | null;
  readonly acknowledged_by: CheckAcknowledger | null;
}

/** league_settings + checks (required writes). */
export interface LeagueSettingsRepository {
  put(row: LeagueSettingsRow): void;
  byHash(settingsHash: string): LeagueSettingsRow | null;
  latest(leagueId: string, season: number): LeagueSettingsRow | null;
  raiseCheck(check: CheckRow): void;
  openChecks(): readonly CheckRow[];
  /**
   * Acknowledges every open check of `id` raised at or before `upTo` (plan 03 §5 #22 "since the
   * last acknowledged settings_hash"); a check raised after `upTo` stays open. Returns the count.
   */
  acknowledgeChecks(id: CheckId, upTo: IsoInstant, by: CheckAcknowledger, at: IsoInstant): number;
}

/** Whether `check` is acknowledged by an `acknowledgeChecks(id, upTo, …)` call (the pure rule). */
export function acknowledgementCovers(
  check: Pick<CheckRow, "id" | "raised_at" | "acknowledged">,
  id: CheckId,
  upTo: IsoInstant,
): boolean {
  const raised = Date.parse(check.raised_at);
  const limit = Date.parse(upTo);
  return (
    !check.acknowledged &&
    check.id === id &&
    Number.isFinite(raised) &&
    Number.isFinite(limit) &&
    raised <= limit
  );
}

/** A nightly roster snapshot (plan 06 §1.4; `espn-ff://roster/snapshot`). */
export interface RosterSnapshot {
  readonly team_id: number;
  readonly week: Week;
  readonly taken_at: IsoInstant;
  readonly roster: Roster;
}

/** One player's movement between two snapshots (ids and slot/status vocabulary only). */
export interface RosterSnapshotDiff {
  readonly added: readonly { readonly player_id: number; readonly slot: string }[];
  readonly dropped: readonly { readonly player_id: number; readonly slot: string }[];
  readonly slot_changes: readonly {
    readonly player_id: number;
    readonly from: string;
    readonly to: string;
  }[];
  readonly injury_changes: readonly {
    readonly player_id: number;
    readonly from: InjuryStatus | null;
    readonly to: InjuryStatus | null;
  }[];
}

/** The diff from `prev` to `next` (`espn-ff://roster/snapshot`), each list sorted by player id. */
export function diffRosterSnapshots(
  prev: Pick<Roster, "entries">,
  next: Pick<Roster, "entries">,
): RosterSnapshotDiff {
  const byId = (r: Pick<Roster, "entries">) => {
    const m = new Map<number, RosterEntry>();
    for (const e of r.entries) m.set(e.player.ref.id, e);
    return m;
  };
  const a = byId(prev);
  const b = byId(next);
  const asc = <T extends { readonly player_id: number }>(xs: T[]): T[] =>
    xs.sort((x, y) => x.player_id - y.player_id);
  const added: { player_id: number; slot: string }[] = [];
  const dropped: { player_id: number; slot: string }[] = [];
  const slotChanges: { player_id: number; from: string; to: string }[] = [];
  const injuryChanges: {
    player_id: number;
    from: InjuryStatus | null;
    to: InjuryStatus | null;
  }[] = [];
  for (const [id, e] of b) {
    const before = a.get(id);
    if (before === undefined) {
      added.push({ player_id: id, slot: e.slot });
      continue;
    }
    if (before.slot !== e.slot) slotChanges.push({ player_id: id, from: before.slot, to: e.slot });
    if (before.player.injury_status !== e.player.injury_status)
      injuryChanges.push({
        player_id: id,
        from: before.player.injury_status,
        to: e.player.injury_status,
      });
  }
  for (const [id, e] of a) if (!b.has(id)) dropped.push({ player_id: id, slot: e.slot });
  return {
    added: asc(added),
    dropped: asc(dropped),
    slot_changes: asc(slotChanges),
    injury_changes: asc(injuryChanges),
  };
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

// --- the league model's input and digest (src/domain/league/*.ts; plan 01 §9 getRosterSlots /
// getLeagueRules; plan 07 A1 `roster` + `rules`; research 03 §B.1 — the ESPN path of each field is
// named in its comment). Additive (B1 league model): the provider maps a type-checked `mSettings`
// body onto these wire-free shapes; the league model validates every bound itself and labels what
// it cannot read in `unverified_fields` instead of guessing.

/** `settings.rosterSettings` as the slot model reads it. */
export interface RosterSettingsInput {
  /** `lineupSlotCounts` — lineup-SLOT id (string key, `"0"`…`"99"`) → seats (0 = slot unused). */
  readonly slot_counts: Readonly<Record<string, number>>;
  /** `positionLimits` — POSITION id (string key) → max rostered; −1 = unlimited. */
  readonly position_limits: Readonly<Record<string, number>>;
  /** `lineupLocktimeType` (`INDIVIDUAL_GAME` observed on every recorded league). */
  readonly lineup_lock_type: string | null;
  /** `isUsingUndroppableList`. */
  readonly undroppable_list: boolean | null;
  /** `moveLimit` (−1 = unlimited). */
  readonly move_limit: number | null;
}

/** `settings.acquisitionSettings` plus the two `status` waiver instants (epoch ms). */
export interface WaiverSettingsInput extends AcquisitionSettingsInput {
  /** `minimumBid` — meaningful only when a budget is used. */
  readonly min_bid: number | null;
  /** `waiverHours` — the waiver period a dropped player spends on waivers. */
  readonly waiver_hours: number | null;
  /** `waiverProcessDays[]` (may be empty — the recorded rolling league). */
  readonly process_days: readonly string[] | null;
  /** `waiverProcessHour` — read as ET, a fallback only (plan 06 §2; one recorded league contradicts it). */
  readonly process_hour: number | null;
  /** `matchupLimitPerScoringPeriod`. */
  readonly matchup_limit_per_period: boolean | null;
  /** `status.waiverNextExecutionDate` (absent on two of the three recorded leagues). */
  readonly next_execution_ms: number | null;
  /** `status.waiverLastExecutionDate`. */
  readonly last_execution_ms: number | null;
}

/** `settings.scheduleSettings` as the playoff model reads it. */
export interface ScheduleSettingsInput {
  /** `matchupPeriodCount` — the regular season's matchup periods. */
  readonly regular_season_matchups: number | null;
  /** `matchupPeriods` — matchup period id (string key) → scoring periods (NFL weeks). */
  readonly matchup_periods: Readonly<Record<string, readonly number[]>> | null;
  /** `playoffTeamCount`. */
  readonly playoff_team_count: number | null;
  /** `playoffMatchupPeriodLength` — weeks per playoff round. */
  readonly playoff_matchup_period_length: number | null;
  /** `variablePlayoffMatchupPeriodLength`. */
  readonly variable_playoff_length: boolean | null;
  /** `playoffReseed`. */
  readonly playoff_reseed: boolean | null;
  /** `playoffSeedingRule` (`TOTAL_POINTS_SCORED` observed). */
  readonly playoff_seeding_rule: string | null;
  /** `playoffSeedingRuleBy` (meaning [U]; 0 and −1 observed). */
  readonly playoff_seeding_rule_by: number | null;
  /** `consolationLadderDisabled`. */
  readonly consolation_ladder_disabled: boolean | null;
}

/** `settings.tradeSettings`. */
export interface TradeSettingsInput {
  /** `deadlineDate` (epoch ms). */
  readonly deadline_ms: number | null;
  readonly revision_hours: number | null;
  readonly veto_votes_required: number | null;
  /** `max` (−1 = unlimited). */
  readonly max: number | null;
}

/** `settings.scoringSettings.matchupTieRule` / `playoffMatchupTieRule`. */
export interface TieSettingsInput {
  readonly matchup_tie_rule: string | null;
  readonly playoff_tie_rule: string | null;
}

/** Everything the league model reads from one league's settings. */
export interface LeagueSettingsInput {
  readonly roster: RosterSettingsInput;
  readonly acquisition: WaiverSettingsInput;
  readonly schedule: ScheduleSettingsInput;
  readonly trade: TradeSettingsInput;
  readonly ties: TieSettingsInput;
  /** `financeSettings`, keys in snake_case (`entry_fee`, `player_move_to_ir`, …); null when absent. */
  readonly fees: Readonly<Record<string, number>> | null;
}

/** The league model's settings digest: A1's `roster` and `rules` plus its `unverified_fields`. */
export interface LeagueSettingsDigest {
  readonly roster: RosterSlots;
  readonly rules: LeagueRules;
  /** Sorted, fixed-vocabulary paths (never a raw input key or value). */
  readonly unverified_fields: readonly string[];
}
