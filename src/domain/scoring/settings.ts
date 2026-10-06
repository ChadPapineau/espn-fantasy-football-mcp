// settings.ts — `normalizeSettings` (plan 08 §2, §3.1, §3.4, §4.1, E3, E7; plan 01 §9.1): ESPN
// `settings.scoringSettings` → canonical rules with ESPN ids as opaque `platform_id`, per-POSITION
// overrides, families from the ids present in S, the pinned rounding rule, and `settings_hash`
// (sha256 of canonical JSON, order-independent, `verified` excluded — P8). Ported from sibling
// @cf3b015 (canonical JSON, hash, deep freeze, once-per-hash unmapped log), adapted to ESPN ids.
import { createHash } from "node:crypto";
import { buildFamilies } from "./brackets.js";
import { ScoringError } from "./errors.js";
import { finiteWithin, MAX_ABS_MODIFIER } from "./numeric.js";
import { canonicalDef } from "./registry.js";
import { ESPN_ROUNDING } from "./rounding.js";
import { espnStat } from "./stat_map.js";
import type {
  MatchupScoringRules,
  PositionClass,
  RoundingMode,
  ScoringRule,
  ScoringSettings,
} from "./types.js";
import { CANONICAL_NAME_RE, POSITION_CLASSES } from "./types.js";

/** One `scoringItems[]` entry as ESPN sends it (research 03 §B.1); other keys are ignored. */
export interface EspnScoringItem {
  readonly statId: number;
  readonly points: number;
  readonly pointsOverrides?: Readonly<Record<string, number>>;
  readonly isReverseItem?: boolean;
}

/** `settings.scoringSettings` (research 03 §B.1) — the fields the engine reads. */
export interface EspnScoringSettings {
  readonly scoringItems: readonly EspnScoringItem[];
  readonly matchupTieRule?: string;
  readonly playoffMatchupTieRule?: string;
  readonly homeTeamBonus?: number;
  readonly playoffHomeTeamBonus?: number;
}

/** Most scoring items one league may carry (ESPN's whole id space is ≈ 240). */
export const MAX_RULES = 500;
/** Most overrides on one item (ESPN has ≈ 16 position ids). */
export const MAX_OVERRIDES = 100;
/** The rounding modes a settings object may name. */
export const ROUNDING_MODES: readonly RoundingMode[] = Object.freeze([
  "exact",
  "per_stat_2dp",
  "per_total_2dp",
]);
/** An ESPN statId: 0..9999. */
const STAT_ID_RE = /^(0|[1-9]\d{0,3})$/;
/** A position-id override key: 0..99, no leading zero (research 03 §B.1). */
const POSITION_KEY_RE = /^(0|[1-9]\d?)$/;
/** ESPN enum strings (`SLOT_POINTS`, `NONE`); anything else is kept as `UNKNOWN`, never echoed. */
const ENUM_RE = /^[A-Z][A-Z0-9_]{0,39}$/;

function bad(message: string, detail: readonly string[] = []): ScoringError {
  return new ScoringError("invalid_settings", message, detail);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Validates an overrides map: position-id keys, finite in-range values; keys sorted. */
function checkOverrides(raw: unknown, id: string): Readonly<Record<string, number>> {
  if (raw === undefined) return Object.freeze({});
  if (!isObject(raw)) throw bad("pointsOverrides must be an object", [id]);
  const keys = Object.keys(raw);
  if (keys.length > MAX_OVERRIDES) throw bad("too many pointsOverrides", [id]);
  const out: Record<string, number> = {};
  for (const k of keys.sort((a, b) => Number(a) - Number(b))) {
    const v = raw[k];
    if (!POSITION_KEY_RE.test(k)) throw bad("pointsOverrides key is not a position id", [id]);
    if (!finiteWithin(v, MAX_ABS_MODIFIER)) throw bad("override must be finite and in range", [id]);
    out[k] = v === 0 ? 0 : v;
  }
  return Object.freeze(out);
}

function enumOr(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  return typeof value === "string" && ENUM_RE.test(value) ? value : "UNKNOWN";
}

function bonusOf(value: unknown, what: string): number {
  if (value === undefined) return 0;
  if (!finiteWithin(value, MAX_ABS_MODIFIER)) throw bad(`${what} must be finite and in range`);
  return value === 0 ? 0 : value;
}

/** One ESPN item → a rule (canonical, abbr and classes from the registry; null when unmapped). */
function ruleOf(item: unknown): ScoringRule {
  if (!isObject(item)) throw bad("a scoring item must be an object");
  const statId = item.statId;
  if (typeof statId !== "number" || !Number.isInteger(statId) || !STAT_ID_RE.test(String(statId))) {
    throw bad("statId must be an integer 0..9999");
  }
  const id = String(statId);
  if (!finiteWithin(item.points, MAX_ABS_MODIFIER))
    throw bad("points must be finite and in range", [id]);
  const reverse = item.isReverseItem;
  if (reverse !== undefined && typeof reverse !== "boolean")
    throw bad("isReverseItem must be a boolean", [id]);
  const def = espnStat(id);
  const canonical = def === undefined ? null : def.canonical;
  const reg = canonical === null ? undefined : canonicalDef(canonical);
  return {
    canonical,
    platform_id: id,
    abbr: def === undefined ? `#${id}` : def.abbr,
    points: item.points === 0 ? 0 : item.points,
    overrides: checkOverrides(item.pointsOverrides, id),
    is_reverse: reverse === true,
    applies_to: reg === undefined ? [] : reg.classes,
    disputed: def === undefined ? false : def.disputed,
  };
}

/**
 * The union ids plan 08 §4.1/§4.4 forbids beside their parts on one class: 105 (total return TDs)
 * with 101/102 is an error naming both (never a double count). The FG legacy 50+ overlap (74/75/76
 * with 198–203) is caught by the family partition check.
 */
const UNION_CONFLICTS: readonly (readonly [string, readonly string[]])[] = [
  ["105", ["101", "102"]],
];
/** Unions that only warn (plan 08 §3.1): 62 beside 19/26/44; 94 beside 103/104. */
const UNION_WARNINGS: readonly (readonly [string, readonly string[]])[] = [
  ["62", ["19", "26", "44"]],
  ["94", ["103", "104"]],
];

function scored(rules: readonly ScoringRule[]): Set<string> {
  return new Set(rules.map((r) => r.platform_id));
}

function assertNoUnionConflict(rules: readonly ScoringRule[]): void {
  const ids = scored(rules);
  for (const [union, parts] of UNION_CONFLICTS) {
    const hit = parts.find((p) => ids.has(p));
    if (ids.has(union) && hit !== undefined) {
      throw new ScoringError("bracket_bounds", "a union stat is scored beside its part", [
        union,
        hit,
      ]);
    }
  }
}

/**
 * Normaliser warnings (plan 08 §3.1): a union id scored beside one of its parts that ESPN would
 * double count. Server-authored strings naming ids only; the provider logs them once per hash.
 */
export function settingsWarnings(settings: ScoringSettings): readonly string[] {
  const ids = scored(settings.rules);
  const out: string[] = [];
  for (const [union, parts] of UNION_WARNINGS) {
    const both = parts.filter((p) => ids.has(p));
    if (ids.has(union) && both.length > 0) {
      out.push(`stat ${union} is scored beside ${both.join("/")}: ESPN scores both`);
    }
  }
  return Object.freeze(out);
}

/** Two rules → one canonical in one class is a normaliser error naming both ids (§3.1). */
function assertNoDuplicates(rules: readonly ScoringRule[]): void {
  const seen = new Map<string, string>();
  for (const r of rules) {
    if (r.canonical === null) continue;
    for (const cls of r.applies_to) {
      const key = `${cls}:${r.canonical}`;
      const prior = seen.get(key);
      if (prior !== undefined) {
        throw new ScoringError(
          "duplicate_canonical",
          `two rules map to ${r.canonical} under ${cls}`,
          [prior, r.platform_id],
        );
      }
      seen.set(key, r.platform_id);
    }
  }
}

/** JSON with object keys sorted at every depth (the hash input; order-independent, P8). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * sha256 (64 lowercase hex) of the canonical JSON of the rules (sorted by id), the families and the
 * rounding mode — never `verified` or the matchup items (plan 08 §2; SETTINGS_HASH_RE).
 */
export function computeSettingsHash(s: Omit<ScoringSettings, "settings_hash">): string {
  const body = {
    platform: s.platform,
    rules: s.rules,
    families: s.families,
    rounding: s.rounding.mode,
  };
  return createHash("sha256").update(canonicalJson(body), "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Re-validates a hand-built or deserialised rule (the cached `league_settings` JSON path). */
function checkRule(raw: unknown): ScoringRule {
  if (!isObject(raw)) throw bad("a rule must be an object");
  const id = raw.platform_id;
  if (typeof id !== "string" || !STAT_ID_RE.test(id))
    throw bad("platform_id must be an ESPN statId");
  const canonical = raw.canonical;
  if (canonical !== null && (typeof canonical !== "string" || !CANONICAL_NAME_RE.test(canonical))) {
    throw bad("canonical must be null or a canonical name", [id]);
  }
  const abbr = raw.abbr;
  if (typeof abbr !== "string" || abbr.length > 16) throw bad("abbr must be ≤ 16 characters", [id]);
  if (!finiteWithin(raw.points, MAX_ABS_MODIFIER))
    throw bad("points must be finite and in range", [id]);
  if (typeof raw.is_reverse !== "boolean" || typeof raw.disputed !== "boolean") {
    throw bad("is_reverse / disputed must be booleans", [id]);
  }
  const classes = raw.applies_to;
  if (
    !Array.isArray(classes) ||
    !classes.every((c) => POSITION_CLASSES.includes(c as PositionClass))
  ) {
    throw bad("applies_to must list position classes", [id]);
  }
  return {
    canonical: canonical,
    platform_id: id,
    abbr,
    points: raw.points === 0 ? 0 : raw.points,
    overrides: checkOverrides(raw.overrides, id),
    is_reverse: raw.is_reverse,
    applies_to: POSITION_CLASSES.filter((c) => classes.includes(c)),
    disputed: raw.disputed,
  };
}

function checkMatchup(raw: unknown): MatchupScoringRules {
  if (!isObject(raw)) throw bad("matchup must be an object");
  return {
    tie_rule: enumOr(raw.tie_rule, "NONE"),
    playoff_tie_rule: enumOr(raw.playoff_tie_rule, "NONE"),
    home_bonus: bonusOf(raw.home_bonus, "home_bonus"),
    playoff_home_bonus: bonusOf(raw.playoff_home_bonus, "playoff_home_bonus"),
  };
}

function checkRounding(raw: unknown): ScoringSettings["rounding"] {
  if (
    !isObject(raw) ||
    !ROUNDING_MODES.includes(raw.mode as RoundingMode) ||
    typeof raw.verified !== "boolean"
  ) {
    throw bad("rounding must be { mode: exact | per_stat_2dp | per_total_2dp, verified: boolean }");
  }
  return { mode: raw.mode as RoundingMode, verified: raw.verified };
}

/**
 * Re-normalises a `ScoringSettings` (P8; the cached-JSON path): validates every field, sorts the
 * rules by id, refuses duplicate ids and two rules on one canonical per class, refuses a union
 * scored beside its part, REBUILDS the families from the rules (a supplied `families` is never
 * trusted) and recomputes the hash. Deeply frozen; idempotent.
 */
export function renormalizeSettings(settings: unknown): ScoringSettings {
  if (!isObject(settings)) throw bad("settings must be an object");
  if (settings.platform !== "espn") throw bad("platform must be espn");
  const rawRules = settings.rules;
  if (!Array.isArray(rawRules) || rawRules.length > MAX_RULES) {
    throw bad(`rules must be an array of at most ${String(MAX_RULES)}`);
  }
  const rules = rawRules
    .map(checkRule)
    .sort((a, b) => Number(a.platform_id) - Number(b.platform_id));
  const ids = rules.map((r) => r.platform_id);
  const dup = ids.find((id, i) => i > 0 && ids[i - 1] === id);
  if (dup !== undefined) throw bad("duplicate statId", [dup]);
  assertNoDuplicates(rules);
  assertNoUnionConflict(rules);
  const body: Omit<ScoringSettings, "settings_hash"> = {
    platform: "espn",
    rules,
    families: buildFamilies(rules),
    matchup: checkMatchup(settings.matchup),
    rounding: checkRounding(settings.rounding),
  };
  return deepFreeze({ ...body, settings_hash: computeSettingsHash(body) });
}

/** Options for `normalizeSettings`. */
export interface NormalizeOptions {
  /** Default ESPN_ROUNDING (the pinned rule). */
  readonly rounding?: ScoringSettings["rounding"];
}

/**
 * ESPN `settings.scoringSettings` → `ScoringSettings` (plan 08 §2): one rule per `scoringItems[]`
 * entry (`statId` → canonical by stat_map; an id with no row stays `canonical: null` — unmapped,
 * scores 0), `pointsOverrides` kept keyed by POSITION id, `isReverseItem` as display metadata,
 * matchup items for the matchup layer, the pinned rounding rule, families and hash. Throws
 * `invalid_settings` (malformed input, a duplicate statId), `bracket_bounds` (a family overlap or
 * a union beside its part). Unknown keys (`leagueRanking`, `leagueTotal`, …) are ignored.
 */
export function normalizeSettings(input: unknown, opts: NormalizeOptions = {}): ScoringSettings {
  if (!isObject(input)) throw bad("scoringSettings must be an object");
  const items = input.scoringItems;
  if (!Array.isArray(items) || items.length > MAX_RULES) {
    throw bad(`scoringItems must be an array of at most ${String(MAX_RULES)}`);
  }
  return renormalizeSettings({
    platform: "espn",
    rules: items.map(ruleOf),
    families: [],
    matchup: {
      tie_rule: enumOr(input.matchupTieRule, "NONE"),
      playoff_tie_rule: enumOr(input.playoffMatchupTieRule, "NONE"),
      home_bonus: bonusOf(input.homeTeamBonus, "homeTeamBonus"),
      playoff_home_bonus: bonusOf(input.playoffHomeTeamBonus, "playoffHomeTeamBonus"),
    },
    rounding: opts.rounding ?? ESPN_ROUNDING,
  });
}

/** ESPN ids of the unmapped rules (`canonical: null`), numerically sorted (plan 08 §3.1). */
export function unmappedIds(settings: ScoringSettings): readonly string[] {
  return Object.freeze(
    settings.rules
      .filter((r) => r.canonical === null)
      .map((r) => r.platform_id)
      .sort((a, b) => Number(a) - Number(b)),
  );
}

/** "Logged once per settings_hash" (plan 08 §3.1) without the engine doing I/O. */
export interface UnmappedLog {
  /** The unmapped ids the FIRST time a hash is seen with any, else null — the caller logs it. */
  firstReport(settings: ScoringSettings): readonly string[] | null;
}

/** A bounded once-per-hash reporter for unmapped ids; the oldest hash is forgotten past capacity. */
export function createUnmappedLog(capacity = 256): UnmappedLog {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError("unmapped log capacity must be a positive integer");
  }
  const seen = new Set<string>();
  return {
    firstReport(settings) {
      if (seen.has(settings.settings_hash)) return null;
      if (seen.size >= capacity) {
        for (const oldest of seen) {
          seen.delete(oldest);
          break;
        }
      }
      seen.add(settings.settings_hash);
      const ids = unmappedIds(settings);
      return ids.length > 0 ? ids : null;
    },
  };
}
