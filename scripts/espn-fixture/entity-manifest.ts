// entity-manifest.ts — the per-view, per-entity drift manifest the in-call detector reads (plan 01 §7
// "the manifest": per view the top-level key set, per-entity key sets — team, rosterEntry, player,
// stats[], scheduleItem, settings.*, status — observed enum values and array-length ranges; plan 05
// §3.1 step 4, generated AFTER anonymisation from the committed recorded fixtures; research 03 §F.2,
// §F.3 step 4). Pure: no I/O (scripts/gen-manifest.ts reads, verifies provenance and writes).
import type { EnumValue } from "../../src/drift/types.js";
import { isObject, type Json } from "./canonical.js";
import {
  MAX_ENUM_VALUES,
  MAX_OBSERVE_DEPTH,
  isMapLike,
  observeBodies,
  parsePattern,
} from "./drift.js";

/** The entity manifest's format version (`version`). */
export const ENTITY_MANIFEST_VERSION = 1;
/** Where the generator writes it, relative to the repo root. */
export const ENTITY_MANIFEST_PATH = "fixtures/drift/entity-manifest.json";
/** More distinct keys than this in one map-like object pattern → its key set is not recorded. */
export const MAX_MAP_KEYS = 512;
/** Map keys are recorded only when every key is an integer of at most this magnitude. */
export const MAX_MAP_KEY_MAGNITUDE = 9999;

/**
 * Entity names (plan 01 §7) and the pattern shapes they cover. A pattern belongs to at most one
 * entity; a pattern no rule names stays pattern-level only (`observed`, `enums`, `array_lengths`).
 */
export const ENTITY_RULES: readonly { readonly entity: string; readonly test: RegExp }[] =
  Object.freeze([
    { entity: "root", test: /^\$$/ },
    { entity: "status", test: /^\$\.status$/ },
    { entity: "settings", test: /^\$\.settings$/ },
    { entity: "scoringItem", test: /\.scoringItems\[\]$/ },
    { entity: "proTeam", test: /^\$\.settings\.proTeams\[\]$/ },
    { entity: "proGame", test: /\.proGamesByScoringPeriod\{\}\[\]$/ },
    // `settings.<name>` — the direct object children of settings (settings.scoringSettings, …)
    { entity: "settings.*", test: /^\$\.settings\.[A-Za-z_$][\w$]*$/ },
    { entity: "team", test: /\.teams\[\]$/ },
    { entity: "member", test: /\.members\[\]$/ },
    { entity: "record", test: /\.teams\[\]\.record$/ },
    { entity: "recordSplit", test: /\.teams\[\]\.record\.[A-Za-z_$][\w$]*$/ },
    { entity: "transactionCounter", test: /\.transactionCounter$/ },
    {
      entity: "roster",
      test: /\.(?:roster|rosterForCurrentScoringPeriod|rosterForMatchupPeriod|rosterForMatchupPeriodDelayed)$/,
    },
    { entity: "rosterEntry", test: /\.entries\[\]$/ },
    { entity: "playerPoolEntry", test: /(?:\.playerPoolEntry|^\$\.players\[\])$/ },
    // the slim player rows of the season index (players_wl) are players too
    { entity: "player", test: /(?:\.player|^\$\[\])$/ },
    { entity: "stats", test: /\.stats\[\]$/ },
    { entity: "ownership", test: /\.ownership$/ },
    { entity: "scheduleItem", test: /^\$\.schedule\[\]$/ },
    { entity: "matchupSide", test: /^\$\.schedule\[\]\.(?:home|away)$/ },
    { entity: "cumulativeScore", test: /\.(?:cumulativeScore|cumulativeScoreLive)$/ },
    { entity: "draftDetail", test: /^\$\.draftDetail$/ },
    { entity: "transaction", test: /\.transactions\[\]$/ },
    { entity: "transactionItem", test: /\.transactions\[\]\.items\[\]$/ },
    { entity: "positionAgainstOpponent", test: /^\$\.positionAgainstOpponent$/ },
  ]);

/**
 * The entity a pattern names, or null. `settings.*` resolves to `settings.<name>`; the first rule
 * that matches wins (so `$.settings.proTeams[]` is a proTeam, `$.settings.scoringSettings` a
 * `settings.scoringSettings`).
 */
export function entityOf(pattern: string): string | null {
  for (const r of ENTITY_RULES) {
    if (!r.test.test(pattern)) continue;
    return r.entity === "settings.*" ? pattern.slice(2) : r.entity;
  }
  return null;
}

/** One entity's observations within one view. */
export interface EntityObservation {
  /** The entity patterns of this view it was observed at (sorted). */
  readonly patterns: readonly string[];
  /** Object nodes observed (evidence weight). */
  readonly nodes: number;
  /** Every key seen on any node (a key outside it is additive drift). */
  readonly keys: readonly string[];
  /**
   * Keys seen on some nodes but not on every node of every pattern; every other key of `keys` was
   * on every node (a candidate for a required set — never more).
   */
  readonly optional: readonly string[];
  /** Key → enum values seen under it (UPPER_SNAKE strings, integer vocabularies). */
  readonly enums: Readonly<Record<string, readonly EnumValue[]>>;
  /** Key → length range of the arrays under it. */
  readonly array_lengths: Readonly<Record<string, { readonly min: number; readonly max: number }>>;
  /** Key → the integer keys of the map-like object under it (stat ids, slot ids, weeks…). */
  readonly map_keys: Readonly<Record<string, readonly string[]>>;
}

/**
 * One view (src/drift/types.ts ViewManifest is a structural subset: `sources`, `observed`,
 * `enums`, `array_lengths` — the same algorithm, drift.ts observeBodies — so a ViewManifest
 * reader reads this too). Observed over WHOLE responses: a split response is re-assembled first,
 * so `array_lengths` are true response lengths (the probe manifest's `views` reads parts).
 */
export interface EntityViewManifest {
  /** The recorded fixture files (parts included), relative to `fixtures/`, sorted. */
  readonly sources: readonly string[];
  /** Each source file's content sha256 (the recording manifest's, re-verified at generation). */
  readonly source_sha256: Readonly<Record<string, string>>;
  /** Whole responses observed (a split response counts once). */
  readonly responses: number;
  /** Union of the responses' top-level keys (empty for a root-array view). */
  readonly top_level_keys: readonly string[];
  /** Top-level keys some response lacks. */
  readonly top_level_optional: readonly string[];
  readonly observed: Readonly<Record<string, readonly string[]>>;
  readonly enums: Readonly<Record<string, readonly EnumValue[]>>;
  readonly array_lengths: Readonly<Record<string, { readonly min: number; readonly max: number }>>;
  /** Entity pattern → object nodes observed there. */
  readonly nodes: Readonly<Record<string, number>>;
  /** Entity pattern → keys some node there lacks (patterns where every key is on every node: absent). */
  readonly optional: Readonly<Record<string, readonly string[]>>;
  /** Map-like pattern (the object, not `{}`) → its integer keys (see MAX_MAP_KEYS). */
  readonly map_keys: Readonly<Record<string, readonly string[]>>;
  /** Entity name → its observations in this view. */
  readonly entities: Readonly<Record<string, EntityObservation>>;
}

export interface EntityManifest {
  readonly $comment: string;
  readonly version: number;
  readonly generator: string;
  readonly host: string;
  readonly season: number;
  readonly captured_at: string;
  /** sha256 of the recording manifest's canonical JSON — a re-recording makes this stale. */
  readonly recording_manifest_sha256: string;
  /** View → its manifest (whitelisted views with a 200 recording; solo first, else composite). */
  readonly views: Readonly<Record<string, EntityViewManifest>>;
  /** The recorded error bodies (status ≥ 400; synthetic bodies are never evidence and never here). */
  readonly errors: EntityViewManifest;
}

interface PatternStats {
  nodes: number;
  keys: Map<string, number>;
}

/** Presence counts per entity pattern and integer key sets per map-like pattern (drift.ts walk rules). */
export function observePresence(bodies: readonly Json[]): {
  nodes: Record<string, number>;
  optional: Record<string, string[]>;
  map_keys: Record<string, string[]>;
} {
  const stats = new Map<string, PatternStats>();
  const maps = new Map<string, Set<string> | null>();
  const walk = (v: Json, pattern: string, depth: number): void => {
    if (depth > MAX_OBSERVE_DEPTH) return;
    if (Array.isArray(v)) {
      for (const el of v) walk(el, `${pattern}[]`, depth + 1);
      return;
    }
    if (!isObject(v)) return;
    if (isMapLike(v)) {
      const keys = Object.keys(v);
      const prior = maps.get(pattern);
      const integerKeys = keys.every(
        (k) => /^-?\d{1,4}$/.test(k) && Math.abs(Number(k)) <= MAX_MAP_KEY_MAGNITUDE,
      );
      if (prior === null || !integerKeys) maps.set(pattern, null);
      else {
        const set = prior ?? new Set<string>();
        for (const k of keys) set.add(k);
        maps.set(pattern, set.size > MAX_MAP_KEYS ? null : set);
      }
      for (const x of Object.values(v)) walk(x, `${pattern}{}`, depth + 1);
      return;
    }
    const s = stats.get(pattern) ?? { nodes: 0, keys: new Map<string, number>() };
    s.nodes++;
    for (const [k, x] of Object.entries(v)) {
      s.keys.set(k, (s.keys.get(k) ?? 0) + 1);
      walk(x, `${pattern}.${k}`, depth + 1);
    }
    stats.set(pattern, s);
  };
  for (const b of bodies) walk(b, "$", 0);
  const nodes: Record<string, number> = {};
  const optional: Record<string, string[]> = {};
  for (const p of [...stats.keys()].sort()) {
    const s = stats.get(p);
    if (!s) continue;
    nodes[p] = s.nodes;
    const some = [...s.keys.entries()]
      .filter(([, n]) => n < s.nodes)
      .map(([k]) => k)
      .sort();
    if (some.length) optional[p] = some;
  }
  const mapKeys: Record<string, string[]> = {};
  for (const p of [...maps.keys()].sort()) {
    const set = maps.get(p);
    if (set) mapKeys[p] = [...set].sort((a, b) => Number(a) - Number(b));
  }
  return { nodes, optional, map_keys: mapKeys };
}

/** A record with sorted keys built by CreateDataProperty (a `__proto__` key stays plain data). */
function sortedRecord<T, U>(m: ReadonlyMap<string, T>, f: (v: T) => U): Record<string, U> {
  return Object.fromEntries([...m.keys()].sort().map((k) => [k, f(m.get(k) as T)]));
}

const sortVals = (xs: Iterable<EnumValue>): EnumValue[] =>
  [...xs].sort((a, b) =>
    typeof a === "number" && typeof b === "number"
      ? a - b
      : String(a) < String(b)
        ? -1
        : String(a) > String(b)
          ? 1
          : 0,
  );

/** The view manifest of `bodies` (WHOLE responses) recorded in `sources` (with their hashes). */
export function buildViewManifest(
  bodies: readonly Json[],
  sources: readonly { path: string; sha256: string }[],
): EntityViewManifest {
  const base = observeBodies(bodies);
  const presence = observePresence(bodies);
  const topKeys = new Set<string>();
  let topAlways: Set<string> | null = null;
  for (const b of bodies) {
    const keys = isObject(b) ? Object.keys(b) : [];
    for (const k of keys) topKeys.add(k);
    topAlways = topAlways === null ? new Set(keys) : new Set(keys.filter((k) => topAlways?.has(k)));
  }
  // entities: group the entity patterns; keys/enums/lengths/map keys relative to the entity node
  const groups = new Map<string, string[]>();
  for (const p of Object.keys(base.observed)) {
    const e = entityOf(p);
    if (e !== null) groups.set(e, [...(groups.get(e) ?? []), p]);
  }
  const entities: Record<string, EntityObservation> = {};
  for (const name of [...groups.keys()].sort()) {
    const patterns = (groups.get(name) ?? []).sort();
    const keys = new Set<string>();
    let always: Set<string> | null = null;
    let nodes = 0;
    const enums = new Map<string, Set<EnumValue>>();
    const lengths = new Map<string, { min: number; max: number }>();
    const mapKeys = new Map<string, Set<string>>();
    for (const p of patterns) {
      const ks = base.observed[p] ?? [];
      for (const k of ks) keys.add(k);
      const opt = new Set(presence.optional[p] ?? []);
      const al = ks.filter((k) => !opt.has(k));
      always = always === null ? new Set(al) : new Set(al.filter((k) => always?.has(k)));
      nodes += presence.nodes[p] ?? 0;
      for (const k of ks) {
        const child = `${p}.${k}`;
        const ev = base.enums[child];
        if (ev) enums.set(k, new Set([...(enums.get(k) ?? []), ...ev]));
        const r = base.array_lengths[child];
        if (r) {
          const prior = lengths.get(k);
          lengths.set(
            k,
            prior ? { min: Math.min(prior.min, r.min), max: Math.max(prior.max, r.max) } : { ...r },
          );
        }
        const mk = presence.map_keys[child];
        if (mk) mapKeys.set(k, new Set([...(mapKeys.get(k) ?? []), ...mk]));
      }
    }
    entities[name] = {
      patterns,
      nodes,
      keys: [...keys].sort(),
      optional: [...keys].filter((k) => !always?.has(k)).sort(),
      // an enum set too large to be an enum is dropped, as observeBodies drops it
      enums: sortedRecord(
        new Map([...enums].filter(([, set]) => set.size <= MAX_ENUM_VALUES)),
        sortVals,
      ),
      array_lengths: sortedRecord(lengths, (r) => r),
      map_keys: sortedRecord(mapKeys, (set) => [...set].sort((a, b) => Number(a) - Number(b))),
    };
  }
  const sorted = [...sources].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    sources: sorted.map((s) => s.path),
    source_sha256: Object.fromEntries(sorted.map((s) => [s.path, s.sha256])),
    responses: bodies.length,
    top_level_keys: [...topKeys].sort(),
    top_level_optional: [...topKeys].filter((k) => !topAlways?.has(k)).sort(),
    observed: base.observed,
    enums: base.enums,
    array_lengths: base.array_lengths,
    nodes: presence.nodes,
    optional: presence.optional,
    map_keys: presence.map_keys,
    entities,
  };
}

// --- validation (a malformed manifest must never read as "no drift") -----------------------------

const SHA256_RE = /^[0-9a-f]{64}$/;
const isStrList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");
const isSortedUnique = (xs: readonly string[]): boolean =>
  xs.every((x, i) => i === 0 || (xs[i - 1] ?? "") < x);
const isRange = (r: unknown): boolean =>
  isObject(r) &&
  Number.isInteger(r.min) &&
  Number.isInteger(r.max) &&
  (r.min as number) >= 0 &&
  (r.min as number) <= (r.max as number);
const isEnumList = (v: unknown): boolean =>
  Array.isArray(v) &&
  v.length <= MAX_ENUM_VALUES &&
  v.every((x) => x === null || ["string", "number", "boolean"].includes(typeof x));

function validatePatternMap(
  where: string,
  m: unknown,
  check: (v: unknown) => boolean,
  patterns = true,
): void {
  if (!isObject(m)) throw new Error(`entity manifest: ${where} missing`);
  for (const [k, v] of Object.entries(m)) {
    if (patterns) parsePattern(k);
    if (!check(v)) throw new Error(`entity manifest: ${where} ${k} invalid`);
  }
}

function validateView(where: string, v: unknown): void {
  if (!isObject(v)) throw new Error(`entity manifest: ${where} invalid`);
  if (!isStrList(v.sources) || !v.sources.length || !isSortedUnique(v.sources))
    throw new Error(`entity manifest: ${where}.sources invalid`);
  for (const s of v.sources)
    if (!/^espn\/recorded\/[\w./-]+\.json$/.test(s) || s.includes(".."))
      throw new Error(`entity manifest: ${where}.sources must name recorded fixtures`);
  const sha = v.source_sha256;
  if (
    !isObject(sha) ||
    Object.keys(sha).sort().join("\n") !== [...v.sources].join("\n") ||
    !Object.values(sha).every((h) => typeof h === "string" && SHA256_RE.test(h))
  )
    throw new Error(`entity manifest: ${where}.source_sha256 invalid`);
  if (!Number.isInteger(v.responses) || (v.responses as number) < 1)
    throw new Error(`entity manifest: ${where}.responses invalid`);
  for (const f of ["top_level_keys", "top_level_optional"] as const)
    if (!isStrList(v[f]) || !isSortedUnique(v[f]))
      throw new Error(`entity manifest: ${where}.${f} invalid`);
  if (!(v.top_level_optional as string[]).every((k) => (v.top_level_keys as string[]).includes(k)))
    throw new Error(`entity manifest: ${where}.top_level_optional ⊄ top_level_keys`);
  validatePatternMap(`${where}.observed`, v.observed, (x) => isStrList(x) && isSortedUnique(x));
  validatePatternMap(`${where}.enums`, v.enums, isEnumList);
  validatePatternMap(`${where}.array_lengths`, v.array_lengths, isRange);
  validatePatternMap(`${where}.nodes`, v.nodes, (x) => Number.isInteger(x) && (x as number) >= 1);
  validatePatternMap(
    `${where}.optional`,
    v.optional,
    (x) => isStrList(x) && x.length > 0 && isSortedUnique(x),
  );
  validatePatternMap(
    `${where}.map_keys`,
    v.map_keys,
    (x) => isStrList(x) && x.length <= MAX_MAP_KEYS && x.every((k) => /^-?\d{1,4}$/.test(k)),
  );
  const observed = v.observed as Record<string, string[]>;
  for (const [p, keys] of Object.entries(v.optional as Record<string, string[]>))
    if (!keys.every((k) => observed[p]?.includes(k)))
      throw new Error(`entity manifest: ${where}.optional ${p} ⊄ observed`);
  if (!isObject(v.entities)) throw new Error(`entity manifest: ${where}.entities missing`);
  for (const [name, e] of Object.entries(v.entities)) {
    const w = `${where}.entities.${name}`;
    if (!/^[A-Za-z][\w.]{0,63}$/.test(name) || !isObject(e))
      throw new Error(`entity manifest: ${w} invalid`);
    if (!isStrList(e.patterns) || !e.patterns.length || !isSortedUnique(e.patterns))
      throw new Error(`entity manifest: ${w}.patterns invalid`);
    for (const p of e.patterns) {
      parsePattern(p);
      if (entityOf(p) !== name)
        throw new Error(`entity manifest: ${w} pattern ${p} is not ${name}`);
      if (!observed[p]) throw new Error(`entity manifest: ${w} pattern ${p} not observed`);
    }
    if (!Number.isInteger(e.nodes) || (e.nodes as number) < 1)
      throw new Error(`entity manifest: ${w}.nodes invalid`);
    for (const f of ["keys", "optional"] as const)
      if (!isStrList(e[f]) || !isSortedUnique(e[f]))
        throw new Error(`entity manifest: ${w}.${f} invalid`);
    if (!(e.optional as string[]).every((k) => (e.keys as string[]).includes(k)))
      throw new Error(`entity manifest: ${w}.optional ⊄ keys`);
    validatePatternMap(`${w}.enums`, e.enums, isEnumList, false);
    validatePatternMap(`${w}.array_lengths`, e.array_lengths, isRange, false);
    validatePatternMap(`${w}.map_keys`, e.map_keys, isStrList, false);
    for (const f of ["enums", "array_lengths", "map_keys"] as const)
      for (const k of Object.keys(e[f] as object))
        if (!(e.keys as string[]).includes(k))
          throw new Error(`entity manifest: ${w}.${f} names a key outside keys`);
  }
}

/** Validates an entity manifest's structure (throws, naming where; never returns on a bad one). */
export function validateEntityManifest(m: unknown): asserts m is EntityManifest {
  if (!isObject(m)) throw new Error("entity manifest: not an object");
  if (m.version !== ENTITY_MANIFEST_VERSION)
    throw new Error("entity manifest: unsupported version");
  if (typeof m.$comment !== "string" || !m.$comment)
    throw new Error("entity manifest: $comment missing");
  if (m.generator !== "scripts/gen-manifest.ts")
    throw new Error("entity manifest: generator must be scripts/gen-manifest.ts");
  if (typeof m.host !== "string" || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(m.host))
    throw new Error("entity manifest: host invalid");
  if (!Number.isInteger(m.season)) throw new Error("entity manifest: season invalid");
  if (typeof m.captured_at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(m.captured_at))
    throw new Error("entity manifest: captured_at invalid");
  if (
    typeof m.recording_manifest_sha256 !== "string" ||
    !SHA256_RE.test(m.recording_manifest_sha256)
  )
    throw new Error("entity manifest: recording_manifest_sha256 invalid");
  if (!isObject(m.views) || !Object.keys(m.views).length)
    throw new Error("entity manifest: views missing");
  for (const [name, v] of Object.entries(m.views)) {
    if (!/^[A-Za-z_]+$/.test(name)) throw new Error("entity manifest: bad view name");
    validateView(`views.${name}`, v);
  }
  validateView("errors", m.errors);
}

/** Every concrete key and enum value a manifest names is ESPN vocabulary: a cheap leak guard. */
export function vocabularyOf(m: EntityManifest): string[] {
  const out = new Set<string>();
  const add = (v: EntityViewManifest) => {
    for (const keys of Object.values(v.observed)) for (const k of keys) out.add(k);
    for (const vals of Object.values(v.enums)) for (const x of vals) out.add(String(x));
  };
  for (const v of Object.values(m.views)) add(v);
  add(m.errors);
  return [...out].sort();
}
