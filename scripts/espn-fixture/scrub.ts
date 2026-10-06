// scrub.ts — deterministic anonymisation of recorded ESPN bodies: research 03 §F.3 (steps 1–3) as
// adapted by the build brief (placeholders "Example League N" / "Team A" / "TA" / "Member N"),
// plan 05 §3.1 step 2 (the rule table and the deny-list abort) and step 3 (determinism). Pure: no I/O
// (the repo scanner pass lives in scan.ts). Player names, ids, pro-team ids, stats and timestamps stay.
import {
  canonicalize,
  compareKeys,
  emptyObject,
  formatPath,
  hasOwn,
  isObject,
  setOwn,
  stableStringify,
  sha256Hex,
  type Json,
  type JsonObject,
} from "./canonical.js";

/** Bumped whenever a rule changes; recorded per file in fixtures/espn/manifest.json. */
export const SCRUB_RULES_VERSION = 1;

export type BodyKind = "league" | "season" | "error";
type Seg = string | number;

export class ScrubAbort extends Error {
  constructor(
    message: string,
    /** Where (JSON paths, rule names) — never the offending value. */
    readonly where: readonly string[] = [],
  ) {
    super(message);
  }
}

const GUID_RE = /([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})/g;
/** The fixture pseudonym range (CLAUDE.md): 00000000-0000-4000-8000-0000000000NN. */
export const FAKE_GUID_RE = /^0{8}-0{4}-4000-8000-0{10}[0-9A-Fa-f]{2}$/;
const IPV4_RE = /(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?!\.?\d)/g;
const ALLOWED_IPV4 = new Set(["0.0.0.0", "127.0.0.1"]);
const MAX_PSEUDONYMS = 255;

/** Keys removed wherever they appear (research 03 §F.3: notification settings, board text). */
export const REMOVE_KEYS = new Set([
  "notificationSettings",
  "topics",
  "messageBoard",
  "communication",
]);
/** Keys emptied wherever they appear (member-written free text). */
export const EMPTY_OBJECT_KEYS = new Set(["tradeBlock", "draftStrategy"]);
/** Direct string fields of a league team that are ESPN enums, kept as they are. */
const TEAM_SAFE_STRINGS = new Set(["logoType", "playoffClinchType", "primaryOwner"]);
/** Direct string fields of a member kept (after GUID mapping): only the id. */
const MEMBER_SAFE_STRINGS = new Set(["id"]);
/**
 * Paths whose strings are public entities and may legitimately equal a member-chosen name (a team
 * named after a player): the capture-time name check skips them; the repo deny-list does not.
 */
const PUBLIC_NAME_PATH =
  /(?:\.player\.(?:fullName|firstName|lastName)|\.proTeams\[\d+\]\.(?:name|location|abbrev))$/;

/** Fields whose values are the scoring evidence (plan 10 A1a; ADV OBJ-01): hashed, never altered. */
export const SCORING_KEYS = new Set([
  "appliedAverage",
  "appliedStatTotal",
  "appliedStats",
  "appliedTotal",
  "cumulativeScore",
  "points",
  "pointsAgainst",
  "pointsByScoringPeriod",
  "pointsFor",
  "scoringItems",
  "stats",
  "totalPoints",
  "totalPointsLive",
  "totalProjectedPoints",
  "totalProjectedPointsLive",
]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  quot: '"',
  lt: "<",
  gt: ">",
  nbsp: " ",
  rsquo: "'",
  lsquo: "'",
};

/**
 * Undoes the encodings a captured name can carry (S4; the scanner's `decodeLayers`): %XX (UTF-8
 * runs), \uXXXX, HTML entities — a bounded number of layers; what does not decode is kept.
 */
export function decodeLayers(s: string): string {
  let cur = s;
  for (let i = 0; i < 4; i++) {
    const next = cur
      .replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
        try {
          return decodeURIComponent(run);
        } catch {
          return run;
        }
      })
      .replace(/\\u([0-9A-Fa-f]{4})/g, (_m, h: string) =>
        String.fromCharCode(Number.parseInt(h, 16)),
      )
      .replace(/&#(?:x([0-9A-Fa-f]{1,6})|([0-9]{1,7}));/g, (m, hex?: string, dec?: string) => {
        const cp = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec ?? "", 10);
        return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)
          ? String.fromCodePoint(cp)
          : m;
      })
      .replace(/&([a-z]{2,6});/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

/** Letters and digits only (any script) — `gridiron.gang`, `Gridiron 🏈 Gang` → `gridirongang`. */
export function termSkeleton(s: string): string {
  return s.replace(/[^\p{L}\p{N}]/gu, "");
}
/** A captured term's skeleton is compared too when it has at least this many letters/digits. */
export const TERM_SKELETON_MIN = 6;

/** Decoded, NFKC, case-folded, invisible characters removed, whitespace collapsed (the scanner's rule). */
export function normaliseTerm(s: string): string {
  return decodeLayers(s)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[­᠎​-‏⁠-⁤﻿]/g, "")
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Spreadsheet letters: 1 → A, 26 → Z, 27 → AA. */
export function letters(n: number): string {
  if (!Number.isSafeInteger(n) || n < 1) throw new ScrubAbort("team id is not a positive integer");
  let s = "";
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

export function fakeGuid(ordinal: number): string {
  return `00000000-0000-4000-8000-0000000000${ordinal.toString(16).toUpperCase().padStart(2, "0")}`;
}

export function outlookPlaceholder(text: string): string {
  return `[outlook ${String(Array.from(text).length)} chars]`;
}

/** Our own placeholders — never a deny term (re-scrubbing scrubbed data must not abort). */
const PLACEHOLDER_TERM =
  /^(?:team [a-z]{1,3}|member \d{1,3}|example league \d{1,3}|division \d{1,3}|league)$/;

/** One per league: the GUID pseudonym map and the names captured from that league's raw bodies. */
export interface LeagueScrubContext {
  readonly ordinal: number;
  readonly guidMap: Map<string, number>;
  /** Normalised member-chosen names seen in the raw bodies (memory only, never written). */
  readonly denyTerms: Set<string>;
  /** The real league id(s) seen at the root of a league body (memory only). */
  readonly realLeagueIds: Set<string>;
  /** Key names (never values) of unknown free-text fields blanked on teams/members. */
  readonly blanked: Set<string>;
}

export function createLeagueContext(ordinal: number): LeagueScrubContext {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 999)
    throw new ScrubAbort("league ordinal must be 1–999");
  return {
    ordinal,
    guidMap: new Map(),
    denyTerms: new Set(),
    realLeagueIds: new Set(),
    blanked: new Set(),
  };
}

function addTerm(ctx: LeagueScrubContext, s: unknown): void {
  if (typeof s !== "string") return;
  const t = normaliseTerm(s);
  // ≥ 4 characters and at least one letter: shorter or letter-less strings ("TA", "2024") occur by
  // chance in ids and stats and would abort every scrub without identifying anyone
  if (t.length >= 4 && /\p{L}/u.test(t) && !PLACEHOLDER_TERM.test(t)) ctx.denyTerms.add(t);
}

/** Captures the member-chosen names of a raw league body into the context (research 03 §F.3 step 3). */
export function captureTerms(raw: Json, ctx: LeagueScrubContext): void {
  if (!isObject(raw)) return;
  const settings = raw.settings;
  if (isObject(settings)) {
    addTerm(ctx, settings.name);
    const sched = settings.scheduleSettings;
    if (isObject(sched) && Array.isArray(sched.divisions))
      for (const d of sched.divisions) if (isObject(d)) addTerm(ctx, d.name);
  }
  if (Array.isArray(raw.teams))
    for (const t of raw.teams) {
      if (!isObject(t)) continue;
      addTerm(ctx, t.name);
      addTerm(ctx, t.location);
      addTerm(ctx, t.nickname);
      if (typeof t.location === "string" && typeof t.nickname === "string")
        addTerm(ctx, `${t.location} ${t.nickname}`);
    }
  if (Array.isArray(raw.members))
    for (const m of raw.members) {
      if (!isObject(m)) continue;
      addTerm(ctx, m.displayName);
      if (typeof m.firstName === "string" && typeof m.lastName === "string")
        addTerm(ctx, `${m.firstName} ${m.lastName}`);
    }
  const id = raw.id;
  if (
    (typeof id === "number" && Number.isSafeInteger(id) && id > 0) ||
    (typeof id === "string" && /^[1-9]\d{0,11}$/.test(id))
  )
    ctx.realLeagueIds.add(String(id));
}

/** Replaces every GUID inside `s` with its pseudonym (braces, case of the surroundings kept). */
function mapGuids(s: string, ctx: LeagueScrubContext): string {
  if (!s.includes("-")) return s;
  return s.replace(GUID_RE, (g: string) => {
    const key = g.toLowerCase();
    let n = ctx.guidMap.get(key);
    if (n === undefined) {
      n = ctx.guidMap.size + 1;
      if (n > MAX_PSEUDONYMS)
        throw new ScrubAbort(
          `more than ${String(MAX_PSEUDONYMS)} distinct GUIDs in one league: the fixture range cannot hold them`,
        );
      ctx.guidMap.set(key, n);
    }
    return fakeGuid(n);
  });
}

export interface ScrubOptions {
  /** Keys emptied ({} / [] / null) to keep a file ≤ 1 MB (never a scoring key); recorded in the manifest. */
  prune?: readonly string[];
  /** Key paths whose arrays keep the response order (canonical.ts keepOrder). */
  keepOrder?: ReadonlySet<string>;
}

/**
 * Anonymises one body. League bodies get the league/team/member rules; every kind gets the generic
 * rules (GUIDs, IPs, outlooks, logos, removed/emptied keys). Returns canonical JSON (sorted keys,
 * arrays sorted by id). Throws ScrubAbort on any shape it cannot anonymise safely.
 */
export function scrubBody(
  raw: Json,
  kind: BodyKind,
  ctx: LeagueScrubContext,
  opts: ScrubOptions = {},
): Json {
  const prune = new Set(opts.prune ?? []);
  for (const k of prune)
    if (SCORING_KEYS.has(k)) throw new ScrubAbort(`refusing to prune scoring key ${k}`);
  if (kind === "league") captureTerms(raw, ctx);

  const walk = (v: Json, segs: Seg[], inOutlooks: boolean): Json => {
    if (typeof v === "string") return inOutlooks ? outlookPlaceholder(v) : mapGuids(v, ctx);
    if (Array.isArray(v)) return v.map((el, i) => walk(el, [...segs, i], inOutlooks));
    if (!isObject(v)) return v;
    const out = emptyObject();
    for (const k of Object.keys(v).sort(compareKeys)) {
      const val = v[k] as Json;
      if (REMOVE_KEYS.has(k)) continue;
      if (prune.has(k)) {
        // emptied, not removed: the key (and so the shape) stays
        setOwn(out, k, Array.isArray(val) ? [] : isObject(val) ? emptyObject() : null);
        continue;
      }
      const key = mapGuids(k, ctx);
      if (EMPTY_OBJECT_KEYS.has(k)) setOwn(out, key, emptyObject());
      else if (k === "clientAddress" && typeof val === "string") setOwn(out, key, "0.0.0.0");
      else if (k === "logo" && typeof val === "string") setOwn(out, key, "");
      else if (k === "seasonOutlook" && typeof val === "string")
        setOwn(out, key, outlookPlaceholder(val));
      else setOwn(out, key, walk(val, [...segs, k], inOutlooks || k === "outlooks"));
    }
    if (kind === "league") applyLeagueRules(out, segs, ctx);
    // a `leagueId` field carrying the real id, wherever it sits, becomes 0 like the root id
    for (const k of Object.keys(out)) {
      const v = out[k];
      if (
        /^league_?id$/i.test(k) &&
        (typeof v === "number" || typeof v === "string") &&
        ctx.realLeagueIds.has(String(v))
      )
        setOwn(out, k, typeof v === "string" ? "0" : 0);
    }
    return out;
  };
  const transformed = walk(raw, [], false);
  return canonicalize(transformed, opts.keepOrder ? { keepOrder: opts.keepOrder } : {});
}

function applyLeagueRules(obj: JsonObject, segs: Seg[], ctx: LeagueScrubContext): void {
  const depth = segs.length;
  if (depth === 0) {
    if (typeof obj.id === "number") setOwn(obj, "id", 0);
    else if (typeof obj.id === "string" && /^\d+$/.test(obj.id)) setOwn(obj, "id", "0");
    return;
  }
  if (depth === 1 && segs[0] === "settings" && hasOwn(obj, "name")) {
    setOwn(obj, "name", `Example League ${String(ctx.ordinal)}`);
    return;
  }
  if (
    depth >= 2 &&
    segs[depth - 2] === "divisions" &&
    typeof segs[depth - 1] === "number" &&
    hasOwn(obj, "name")
  ) {
    const id = obj.id;
    setOwn(
      obj,
      "name",
      typeof id === "number" && Number.isSafeInteger(id) && id >= 0
        ? `Division ${String(id + 1)}`
        : "Division",
    );
    return;
  }
  if (depth === 2 && segs[0] === "teams" && typeof segs[1] === "number") {
    const id = obj.id;
    if (typeof id !== "number")
      throw new ScrubAbort("a league team has no numeric id", [formatPath(segs)]);
    const L = letters(id);
    if (hasOwn(obj, "name")) setOwn(obj, "name", `Team ${L}`);
    if (hasOwn(obj, "abbrev")) setOwn(obj, "abbrev", `T${L}`);
    for (const k of ["location", "nickname", "logo"]) if (hasOwn(obj, k)) setOwn(obj, k, "");
    for (const k of Object.keys(obj)) {
      const val = obj[k];
      if (
        typeof val === "string" &&
        !["name", "abbrev", "location", "nickname", "logo"].includes(k)
      ) {
        if (k === "primaryOwner") {
          if (val !== "" && !/^\{?[0-9A-F-]{36}\}?$/i.test(val)) {
            ctx.blanked.add(`teams[].${k}`);
            setOwn(obj, k, "");
          }
        } else if (!TEAM_SAFE_STRINGS.has(k)) {
          ctx.blanked.add(`teams[].${k}`);
          setOwn(obj, k, "");
        }
      }
    }
    if (Array.isArray(obj.owners))
      setOwn(
        obj,
        "owners",
        obj.owners.map((o) => {
          if (typeof o === "string" && /^\{?[0-9A-F-]{36}\}?$/i.test(o)) return o;
          ctx.blanked.add("teams[].owners[]");
          return "";
        }),
      );
    return;
  }
  if (depth === 2 && segs[0] === "members" && typeof segs[1] === "number") {
    const id = obj.id;
    const m = typeof id === "string" ? /0{10}([0-9A-F]{2})\}?$/i.exec(id) : null;
    if (!m?.[1]) throw new ScrubAbort("a league member has no GUID id", [formatPath(segs)]);
    setOwn(obj, "displayName", `Member ${String(parseInt(m[1], 16))}`);
    for (const k of ["firstName", "lastName"]) if (hasOwn(obj, k)) setOwn(obj, k, "");
    for (const k of Object.keys(obj)) {
      if (
        typeof obj[k] === "string" &&
        !MEMBER_SAFE_STRINGS.has(k) &&
        !["displayName", "firstName", "lastName"].includes(k)
      ) {
        ctx.blanked.add(`members[].${k}`);
        setOwn(obj, k, "");
      }
    }
  }
}

export interface Violation {
  rule: "guid" | "ipv4" | "league-id" | "captured-name" | "team-placeholder" | "member-placeholder";
  path: string;
}

/**
 * The deny-list abort's in-process half (plan 05 §3.1 step 2; research 03 §F.3 step 3): every string
 * and key of a scrubbed body is checked for a GUID outside the fake range, an IPv4 address, the real
 * league id and every captured member-chosen name; league teams/members must carry placeholders.
 * Returns violations with JSON paths only (the repo scanner pass in scan.ts is the other half).
 */
export function verifyScrubbed(value: Json, kind: BodyKind, ctx: LeagueScrubContext): Violation[] {
  const out: Violation[] = [];
  const ids = [...ctx.realLeagueIds];
  const idRes = ids.map((id) => new RegExp(`(?<!\\d)${id}(?!\\d)`));
  const terms = [...ctx.denyTerms];
  const skels = [...new Set(terms.map(termSkeleton).filter((k) => k.length >= TERM_SKELETON_MIN))];
  const checkString = (s: string, segs: Seg[]) => {
    for (const m of s.matchAll(GUID_RE))
      if (!FAKE_GUID_RE.test(m[1] ?? "")) out.push({ rule: "guid", path: formatPath(segs) });
    for (const m of s.matchAll(IPV4_RE)) {
      const parts = (m[1] ?? "").split(".").map(Number);
      if (parts.every((p) => p <= 255) && !ALLOWED_IPV4.has(parts.join(".")))
        out.push({ rule: "ipv4", path: formatPath(segs) });
    }
    if (idRes.some((re) => re.test(s))) out.push({ rule: "league-id", path: formatPath(segs) });
    if (terms.length) {
      const p = formatPath(segs);
      if (!PUBLIC_NAME_PATH.test(p)) {
        const n = normaliseTerm(s);
        const k = termSkeleton(n);
        if (terms.some((t) => n.includes(t)) || skels.some((t) => k.includes(t)))
          out.push({ rule: "captured-name", path: p });
      }
    }
  };
  const walk = (v: Json, segs: Seg[]) => {
    if (typeof v === "string") checkString(v, segs);
    else if (typeof v === "number") {
      const last = segs[segs.length - 1];
      if (kind === "league" && segs.length === 1 && last === "id" && v !== 0)
        out.push({ rule: "league-id", path: formatPath(segs) });
      if (typeof last === "string" && /league/i.test(last) && ids.includes(String(v)))
        out.push({ rule: "league-id", path: formatPath(segs) });
    } else if (Array.isArray(v))
      v.forEach((el, i) => {
        walk(el, [...segs, i]);
      });
    else if (isObject(v))
      for (const k of Object.keys(v)) {
        checkString(k, [...segs, k]);
        walk(v[k] as Json, [...segs, k]);
      }
  };
  walk(value, []);
  if (kind === "league" && isObject(value)) {
    if (Array.isArray(value.teams))
      value.teams.forEach((t, i) => {
        if (!isObject(t)) return;
        const L =
          typeof t.id === "number" && Number.isSafeInteger(t.id) && t.id > 0 ? letters(t.id) : "?";
        const bad =
          (hasOwn(t, "name") && t.name !== `Team ${L}`) ||
          (hasOwn(t, "abbrev") && t.abbrev !== `T${L}`) ||
          ["location", "nickname", "logo"].some((k) => hasOwn(t, k) && t[k] !== "");
        if (bad) out.push({ rule: "team-placeholder", path: formatPath(["teams", i]) });
      });
    if (Array.isArray(value.members))
      value.members.forEach((m, i) => {
        if (!isObject(m)) return;
        const bad =
          (hasOwn(m, "displayName") &&
            !(typeof m.displayName === "string" && /^Member \d{1,3}$/.test(m.displayName))) ||
          ["firstName", "lastName"].some((k) => hasOwn(m, k) && m[k] !== "") ||
          hasOwn(m, "notificationSettings");
        if (bad) out.push({ rule: "member-placeholder", path: formatPath(["members", i]) });
      });
    if (
      isObject(value.settings) &&
      hasOwn(value.settings, "name") &&
      value.settings.name !== `Example League ${String(ctx.ordinal)}`
    )
      out.push({ rule: "captured-name", path: "$.settings.name" });
  }
  // one entry per (rule, path)
  const seen = new Set<string>();
  return out.filter((v) => {
    const k = `${v.rule}|${v.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The scoring evidence of a body (plan 10 A1a, ADV OBJ-01): every subtree under a SCORING_KEYS key,
 * with its path, in canonical order. Its hash is computed on the raw recording and must equal the
 * hash of the scrubbed file — the scrubber never touches scoring fields.
 */
export function scoringProjection(value: Json): { entries: number; sha256: string } {
  const entries: [string, Json][] = [];
  const walk = (v: Json, segs: Seg[]) => {
    if (Array.isArray(v))
      v.forEach((el, i) => {
        walk(el, [...segs, i]);
      });
    else if (isObject(v))
      for (const k of Object.keys(v).sort(compareKeys)) {
        if (SCORING_KEYS.has(k)) entries.push([formatPath([...segs, k]), v[k] as Json]);
        else walk(v[k] as Json, [...segs, k]);
      }
  };
  walk(value, []);
  return {
    entries: entries.length,
    sha256: sha256Hex(stableStringify(entries)),
  };
}
