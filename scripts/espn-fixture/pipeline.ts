// pipeline.ts — capture → scrub → freeze for the keyless public-league recording: plan 05 §3.1
// steps 1–4 (raw outside the repo, the scrub with its deny-list abort, determinism, the manifest
// with provenance hashes), plan 10 §3.0 Z7 / §3.1a (≥ 3 recorded final mBoxscore weeks with the
// league's own mSettings; scoring fields hash to the recorded original — ADV OBJ-01, OBJ-21).
// Shared by scripts/record-fixture.ts (network, then scrub) and scripts/scrub-fixture.ts (offline).
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  canonicalize,
  contentSha256,
  emptyObject,
  formatPath,
  isObject,
  parseJsonStrict,
  setOwn,
  type Json,
  type JsonObject,
} from "./canonical.js";
import { formatJson } from "./format-json.js";
import { pathsAtLines, segmentsAtLines, type Seg } from "./json-lines.js";
import { READ_HOST, leagueUrl, seasonUrl, type PoliteClient } from "./http.js";
import { leagueFormat, matchupPeriodOf, type LeagueFormat } from "./league-format.js";
import { scanWithRepoScanner } from "./scan.js";
import {
  SCRUB_RULES_VERSION,
  ScrubAbort,
  createLeagueContext,
  scoringProjection,
  scrubBody,
  verifyScrubbed,
  type BodyKind,
  type LeagueScrubContext,
} from "./scrub.js";

export const RAW_SCHEMA = 1;
/** Every committed fixture stays at or under this size (the brief; the engine fields are never cut). */
export const MAX_FIXTURE_BYTES = 1024 * 1024;
/** Response headers worth keeping with a fixture (no ETag — a raw-body fingerprint; no CDN POP). */
export const KEEP_HEADERS = [
  "cache-control",
  "content-type",
  "x-fantasy-filter-player-count",
  "x-fantasy-filter-schedule-count",
  "x-fantasy-filter-transaction-count",
  "x-fantasy-role",
] as const;
export const LEAGUE_SLOTS = ["league-a", "league-b", "league-c", "league-d", "league-e"] as const;
/** The views whose response order is the request's own sort (canonical.ts keepOrder). */
const KEEP_ORDER: Readonly<Record<string, ReadonlySet<string>>> = {
  kona_player_info: new Set(["players"]),
};

/** One raw capture as stored OUTSIDE the repo (it holds the real ids and names). */
export interface RawEnvelope {
  schema: number;
  slot: string;
  name: string;
  kind: BodyKind;
  route: "league" | "season";
  views: string[];
  params: Record<string, string>;
  filter: Json;
  url: string;
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  recorded_at: string;
  bytes: number;
  /** For mBoxscore: whether every NFL game of that scoring period had statsOfficial: true. */
  stats_official: boolean | null;
}

export interface RequestSpec {
  slot: string;
  name: string;
  kind: BodyKind;
  route: "league" | "season";
  views: string[];
  params: Record<string, string>;
  filter: Json;
  /** Expected status class: league/season bodies must be 200; error captures accept their 4xx. */
  expect: "ok" | "error";
  stats_official?: boolean | null;
}

export const KONA_FILTER_DEFAULT_LIMIT = 25;

/** The X-Fantasy-Filter of the one kona_player_info page (research 03 §A.3: a limit needs a sort). */
export function konaFilter(limit: number): Json {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new Error("kona limit must be 1–50");
  return {
    players: {
      filterStatus: { value: ["FREEAGENT", "WAIVERS"] },
      limit,
      offset: 0,
      sortPercOwned: { sortPriority: 1, sortAsc: false },
      sortDraftRanks: { sortPriority: 100, sortAsc: true, value: "STANDARD" },
    },
  };
}

/** Which scoring periods have every NFL game final (`statsOfficial: true`) — research 03 §B.5. */
export function officialWeeks(proTeamSchedules: Json): Map<number, boolean> {
  const out = new Map<number, boolean>();
  if (!isObject(proTeamSchedules) || !isObject(proTeamSchedules.settings)) return out;
  const teams = proTeamSchedules.settings.proTeams;
  if (!Array.isArray(teams)) return out;
  for (const t of teams) {
    if (!isObject(t) || !isObject(t.proGamesByScoringPeriod)) continue;
    for (const [wk, games] of Object.entries(t.proGamesByScoringPeriod)) {
      if (!/^\d+$/.test(wk) || !Array.isArray(games)) continue;
      const w = Number(wk);
      for (const g of games) {
        if (!isObject(g)) continue;
        out.set(w, (out.get(w) ?? true) && g.statsOfficial === true);
      }
    }
  }
  return out;
}

export function requestUrl(spec: RequestSpec, season: number, leagueId: string | null): string {
  if (spec.route === "season") return seasonUrl(season, spec.views);
  if (leagueId === null) throw new Error("a league request needs a league id");
  return leagueUrl(season, leagueId, spec.views, spec.params);
}

/** The league-independent requests (one per run). */
export function seasonPlan(): RequestSpec[] {
  return [
    {
      slot: "season",
      name: "proTeamSchedules_wl",
      kind: "season",
      route: "season",
      views: ["proTeamSchedules_wl"],
      params: {},
      filter: null,
      expect: "ok",
    },
    // an unknown view on the season route: the skeleton the host probe must reject (research 03 §A.2)
    {
      slot: "season",
      name: "skeleton",
      kind: "season",
      route: "season",
      views: ["mBogusViewName"],
      params: {},
      filter: null,
      expect: "ok",
    },
  ];
}

/** Per-league requests after its mSettings is known (matchup periods, current week). */
export function leaguePlan(
  slot: string,
  settings: Json,
  official: Map<number, boolean>,
  weeks: readonly number[],
  opts: { probeExtras: boolean; konaLimit: number },
): RequestSpec[] {
  const status = isObject(settings) && isObject(settings.status) ? settings.status : {};
  const latest = typeof status.latestScoringPeriod === "number" ? status.latestScoringPeriod : null;
  const specs: RequestSpec[] = [
    {
      slot,
      name: "mTeam",
      kind: "league",
      route: "league",
      views: ["mTeam", "mStandings"],
      params: {},
      filter: null,
      expect: "ok",
    },
    {
      slot,
      name: "mMatchup",
      kind: "league",
      route: "league",
      views: ["mMatchup"],
      params: {},
      filter: null,
      expect: "ok",
    },
  ];
  for (const w of weeks)
    specs.push({
      slot,
      name: `mRoster.sp${String(w)}`,
      kind: "league",
      route: "league",
      views: ["mRoster"],
      params: { scoringPeriodId: String(w) },
      filter: null,
      expect: "ok",
    });
  for (const w of weeks) {
    const mp = matchupPeriodOf(settings, w);
    if (mp === null)
      throw new Error(`${slot}: scoring period ${String(w)} is in no matchup period`);
    if (latest !== null && w >= latest)
      throw new Error(
        `${slot}: scoring period ${String(w)} is not over (latest ${String(latest)})`,
      );
    if (official.get(w) !== true)
      throw new Error(
        `${slot}: scoring period ${String(w)} is not final (statsOfficial is not true for every game)`,
      );
    specs.push({
      slot,
      name: `mBoxscore.sp${String(w)}`,
      kind: "league",
      route: "league",
      views: ["mBoxscore"],
      params: { scoringPeriodId: String(w) },
      filter: { schedule: { filterMatchupPeriodIds: { value: [mp] } } },
      expect: "ok",
      stats_official: true,
    });
  }
  specs.push({
    slot,
    name: "kona_player_info",
    kind: "league",
    route: "league",
    views: ["kona_player_info"],
    params: latest !== null ? { scoringPeriodId: String(latest) } : {},
    filter: konaFilter(opts.konaLimit),
    expect: "ok",
  });
  if (opts.probeExtras) {
    specs.push({
      slot,
      name: "probe-shape",
      kind: "league",
      route: "league",
      views: ["mSettings", "mNav", "mTeam"],
      params: {},
      filter: null,
      expect: "ok",
    });
    specs.push({
      slot,
      name: "skeleton",
      kind: "league",
      route: "league",
      views: ["mBogusViewName"],
      params: {},
      filter: null,
      expect: "ok",
    });
  }
  return specs;
}

/** The two recorded error bodies for the classifier (research 03 §A.4): 404 and 400. */
export function errorPlan(): RequestSpec[] {
  return [
    // league id 0 never exists: GENERAL_NOT_FOUND (P03/P22 shape)
    {
      slot: "errors",
      name: "404-league-not-found",
      kind: "error",
      route: "league",
      views: ["mSettings"],
      params: {},
      filter: null,
      expect: "error",
    },
    // a limit without a sort: FILTER_LIMIT_MISSING_SORT (P19 shape) — sent to the first league
    {
      slot: "errors",
      name: "400-limit-missing-sort",
      kind: "error",
      route: "league",
      views: ["kona_player_info"],
      params: {},
      filter: { players: { limit: 5 } },
      expect: "error",
    },
  ];
}

export function writeRaw(rawDir: string, env: RawEnvelope): void {
  const dir = path.join(rawDir, env.slot);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${env.name}.json`);
  writeFileSync(file, `${JSON.stringify(env)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function readRaw(rawDir: string, slot: string, name: string): RawEnvelope | null {
  const file = path.join(rawDir, slot, `${name}.json`);
  if (!existsSync(file)) return null;
  const env = JSON.parse(readFileSync(file, "utf8")) as RawEnvelope;
  if (env.schema !== RAW_SCHEMA || env.slot !== slot || env.name !== name)
    throw new Error(`raw capture ${slot}/${name} is malformed`);
  return env;
}

/** Fetches one spec (or reuses a stored capture of it) and stores the raw envelope. */
export async function captureOne(
  client: PoliteClient,
  rawDir: string,
  spec: RequestSpec,
  season: number,
  leagueId: string | null,
  now: () => Date,
  log: (s: string) => void,
): Promise<RawEnvelope> {
  const prior = readRaw(rawDir, spec.slot, spec.name);
  if (prior && statusOk(prior.status, spec.expect)) {
    log(`${spec.slot}/${spec.name}: reused stored capture (HTTP ${String(prior.status)})`);
    return prior;
  }
  const url = requestUrl(spec, season, leagueId);
  const res = await client.get(url, spec.filter === null ? {} : { filter: spec.filter });
  const env: RawEnvelope = {
    schema: RAW_SCHEMA,
    slot: spec.slot,
    name: spec.name,
    kind: spec.kind,
    route: spec.route,
    views: spec.views,
    params: spec.params,
    filter: spec.filter,
    url,
    status: res.status,
    headers: res.headers,
    bodyText: res.bodyText,
    recorded_at: now()
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z"),
    bytes: res.bytes,
    stats_official: spec.stats_official ?? null,
  };
  writeRaw(rawDir, env);
  log(
    `${spec.slot}/${spec.name}: HTTP ${String(res.status)} ${(res.bytes / 1024).toFixed(1)} KB in ${String(res.ms)} ms`,
  );
  if (!statusOk(res.status, spec.expect))
    throw new Error(
      `${spec.slot}/${spec.name}: unexpected HTTP ${String(res.status)} — stopping (no retry on a 4xx; research 03 §D.3)`,
    );
  return env;
}

function statusOk(status: number, expect: "ok" | "error"): boolean {
  return expect === "ok" ? status === 200 : status >= 400 && status < 500;
}

// --- scrub + freeze ---------------------------------------------------------------------------------

/**
 * Keys emptied (`{}` / `[]` / null — the key stays, so the shape stays) in league bodies to keep a
 * file ≤ 1 MB: `rankings` (ESPN analyst ranks per week — never a scoring input, and the bulk of every
 * roster and matchup body). kona_player_info keeps everything: it is the evidence of the full player
 * shape. Never a scoring key (scrub.ts refuses one).
 */
export const DEFAULT_PRUNE: readonly string[] = ["rankings"];
const PRUNE_EXEMPT_VIEWS = new Set(["kona_player_info"]);

export interface ManifestEntry {
  path: string;
  league: string | null;
  views: string[];
  scoringPeriodId: number | null;
  matchupPeriodId: number | null;
  request: { route: "league" | "season"; path: string; query: string; filter: Json };
  status: number;
  headers: Record<string, string>;
  recorded_at: string;
  derived: false;
  scrub_rules_version: number;
  pruned: string[];
  /** Set when one response was split into parts to stay ≤ 1 MB (concatenate `array` in index order). */
  part: { index: number; of: number; array: string } | null;
  /**
   * Units removed because a line of theirs matched the local repo deny-list (scan-secrets.mjs): JSON
   * paths into the scrubbed body as it stood before the removal. Never a value.
   */
  withheld: string[];
  stats_official: boolean | null;
  top_level_keys: string[];
  bytes: number;
  sha256: string;
  scoring: { entries: number; sha256: string };
  format: LeagueFormat | null;
}

export interface FixtureManifest {
  $comment: string;
  version: 1;
  host: string;
  season: number;
  captured_at: string;
  scrub_rules_version: number;
  leagues: Record<string, { format: LeagueFormat; final_boxscore_weeks: number[] }>;
  files: ManifestEntry[];
  /** Captures withheld whole (a deny-list match that no unit removal could clear). */
  withheld_files: string[];
}

export interface ScrubRunOptions {
  rawDir: string;
  /** fixtures/espn — files go to <outRoot>/recorded/<slot>/<name>.json, the manifest to <outRoot>/manifest.json. */
  outRoot: string;
  /** Extra keys to empty in league bodies (on top of DEFAULT_PRUNE). */
  prune?: readonly string[];
  log?: (s: string) => void;
  /** Injected for tests; defaults to the repo scanner (scan.ts). */
  scan?: (text: string, label: string) => { clean: boolean; findings: string[]; error?: string };
  /** Write nothing; return the would-be outputs (tests, dry runs). */
  dryRun?: boolean;
  /** Size cap per file (tests); defaults to MAX_FIXTURE_BYTES. */
  maxBytes?: number;
  /**
   * When the repo scanner's ONLY findings are local deny-list matches, remove the smallest
   * self-contained unit holding each matched line (withholdUnit) instead of refusing the run; the
   * file is re-scanned and must then be clean. Any other finding still refuses the run.
   */
  withholdDenylisted?: boolean;
}

const DENY_PREFIX = "deny-list match in ";

/**
 * The smallest self-contained unit holding a deny-listed line: a whole matchup row in a box score
 * (the golden's unit — never a partial row), else the roster entry, else a top-level element, else
 * (season body) the pro team's non-schedule property or the one game. null: withhold the file.
 */
export function withholdUnit(
  view: string,
  segs: readonly Seg[],
): { segs: Seg[]; action: "omit" | "empty" } | null {
  if (view === "mBoxscore") {
    return segs[0] === "schedule" && typeof segs[1] === "number"
      ? { segs: segs.slice(0, 2), action: "omit" }
      : null;
  }
  for (let k = segs.length - 2; k >= 0; k--)
    if (segs[k] === "entries" && typeof segs[k + 1] === "number")
      return { segs: segs.slice(0, k + 2), action: "omit" };
  if (["teams", "schedule", "players"].includes(String(segs[0])) && typeof segs[1] === "number")
    return { segs: segs.slice(0, 2), action: "omit" };
  if (
    segs[0] === "settings" &&
    segs[1] === "proTeams" &&
    typeof segs[2] === "number" &&
    typeof segs[3] === "string"
  ) {
    if (segs[3] === "proGamesByScoringPeriod")
      return typeof segs[4] === "string" && typeof segs[5] === "number"
        ? { segs: segs.slice(0, 6), action: "omit" }
        : null;
    if (["id", "abbrev", "byeWeek", "location", "name"].includes(segs[3])) return null;
    return { segs: segs.slice(0, 4), action: "empty" };
  }
  return null;
}

/** Removes (omit) or empties the given units; units index the same body, applied together. */
export function applyUnits(
  body: Json,
  units: readonly { segs: Seg[]; action: "omit" | "empty" }[],
): Json {
  const key = (segs: readonly Seg[]) => JSON.stringify(segs);
  const omit = new Set(units.filter((u) => u.action === "omit").map((u) => key(u.segs)));
  const empty = new Set(units.filter((u) => u.action === "empty").map((u) => key(u.segs)));
  const walk = (v: Json, segs: Seg[]): Json => {
    if (empty.has(key(segs))) return Array.isArray(v) ? [] : isObject(v) ? emptyObject() : null;
    if (Array.isArray(v)) {
      const out: Json[] = [];
      v.forEach((el, i) => {
        if (!omit.has(key([...segs, i]))) out.push(walk(el, [...segs, i]));
      });
      return out;
    }
    if (isObject(v)) {
      const out = emptyObject();
      for (const k of Object.keys(v)) setOwn(out, k, walk(v[k] as Json, [...segs, k]));
      return out;
    }
    return v;
  };
  return walk(body, []);
}

export interface ScrubRunResult {
  manifest: FixtureManifest;
  outputs: { rel: string; text: string }[];
  blanked: string[];
}

/** The slot order of a raw run (season, errors, then leagues in slot order) and each slot's captures in plan order. */
export function rawInventory(rawDir: string): { slot: string; names: string[] }[] {
  const order = ["season", "errors", ...LEAGUE_SLOTS];
  const nameOrder = (n: string): string => {
    const fixed = [
      "proTeamSchedules_wl",
      "skeleton",
      "404-league-not-found",
      "400-limit-missing-sort",
      "mSettings",
      "mTeam",
      "mMatchup",
    ];
    const i = fixed.indexOf(n);
    if (i >= 0) return `0${String(i).padStart(2, "0")}`;
    if (n.startsWith("mRoster.sp")) return `1${n.slice(10).padStart(3, "0")}`;
    if (n.startsWith("mBoxscore.sp")) return `2${n.slice(12).padStart(3, "0")}`;
    if (n === "kona_player_info") return "3";
    if (n === "probe-shape") return "4";
    return `9${n}`;
  };
  const out: { slot: string; names: string[] }[] = [];
  for (const slot of order) {
    const dir = path.join(rawDir, slot);
    if (!existsSync(dir)) continue;
    const names = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .sort((a, b) => (nameOrder(a) < nameOrder(b) ? -1 : nameOrder(a) > nameOrder(b) ? 1 : 0));
    out.push({ slot, names });
  }
  return out;
}

function leagueRequestPath(season: number, route: "league" | "season"): string {
  return route === "season"
    ? `/apis/v3/games/ffl/seasons/${String(season)}`
    : `/apis/v3/games/ffl/seasons/${String(season)}/segments/0/leagues/0`;
}

function keptHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of KEEP_HEADERS) {
    const v = h[k];
    if (typeof v === "string" && /^[\w\s.,;:=/+*-]{0,120}$/.test(v)) out[k] = v;
  }
  return out;
}

function seasonOf(env: RawEnvelope): number {
  const m = /\/seasons\/(\d{4})(?:[/?]|$)/.exec(env.url);
  if (!m?.[1]) throw new Error(`${env.slot}/${env.name}: no season in the request URL`);
  return Number(m[1]);
}

/** Rewrites scanner findings ("…:<line> …") with the JSON path at that line — never a value. */
export function annotateFindings(findings: readonly string[], text: string): string[] {
  const lineOf = (f: string): number | null => {
    const m = /:(\d+)(?:\s|$)/.exec(f);
    return m?.[1] ? Number(m[1]) : null;
  };
  const lines = findings.map(lineOf).filter((n): n is number => n !== null);
  const paths = pathsAtLines(text, lines);
  return findings.map((f) => {
    const n = lineOf(f);
    return n === null ? f : `${f} at ${paths.get(n) ?? "$"}`;
  });
}

/** The top-level array a too-large body is split along: the largest one with ≥ 2 elements. */
function splitArrayKey(body: Json): string | null {
  if (!isObject(body)) return null;
  let best: string | null = null;
  let bestSize = 0;
  for (const k of Object.keys(body)) {
    const v = body[k];
    if (!Array.isArray(v) || v.length < 2) continue;
    const size = JSON.stringify(v).length;
    if (size > bestSize) {
      best = k;
      bestSize = size;
    }
  }
  return best;
}

function withArray(body: JsonObject, key: string, items: Json[]): Json {
  const out = emptyObject();
  for (const k of Object.keys(body)) setOwn(out, k, k === key ? items : (body[k] as Json));
  return out;
}

/**
 * Splits a body along one top-level array into contiguous parts that each format to ≤ maxBytes
 * (greedy, lossless: concatenating the parts' arrays in index order restores the body). Returns the
 * index ranges, or null when a single element alone is over the cap.
 */
async function planSplit(
  body: JsonObject,
  key: string,
  maxBytes: number,
): Promise<{ from: number; to: number }[] | null> {
  const items = body[key] as Json[];
  const ranges: { from: number; to: number }[] = [];
  let from = 0;
  while (from < items.length) {
    let to = from + 1;
    if (
      Buffer.byteLength(await formatJson(withArray(body, key, items.slice(from, to)), "recorded")) >
      maxBytes
    )
      return null;
    // grow while the part still fits (one format per added element; parts are few and small)
    while (to < items.length) {
      const size = Buffer.byteLength(
        await formatJson(withArray(body, key, items.slice(from, to + 1)), "recorded"),
      );
      if (size > maxBytes) break;
      to++;
    }
    ranges.push({ from, to });
    from = to;
  }
  return ranges;
}

/**
 * Scrubs every capture of a raw run, verifies all of them (union of every league's captured names
 * and ids, the repo scanner with its local deny-list, the scoring-projection identity, the size cap)
 * and only then writes the fixtures and the manifest — an abort leaves the repo untouched.
 */
export async function scrubRun(opts: ScrubRunOptions): Promise<ScrubRunResult> {
  const log = opts.log ?? (() => undefined);
  const scan = opts.scan ?? ((t: string, l: string) => scanWithRepoScanner(t, l));
  const maxBytes = opts.maxBytes ?? MAX_FIXTURE_BYTES;
  const inventory = rawInventory(opts.rawDir);
  if (!inventory.length) throw new ScrubAbort("the raw directory holds no captures");

  const contexts = new Map<string, LeagueScrubContext>();
  const ctxOf = (slot: string): LeagueScrubContext => {
    let c = contexts.get(slot);
    if (!c) {
      const i = LEAGUE_SLOTS.indexOf(slot as (typeof LEAGUE_SLOTS)[number]);
      c = createLeagueContext(i >= 0 ? i + 1 : 1);
      contexts.set(slot, c);
    }
    return c;
  };

  interface Pending {
    env: RawEnvelope;
    scrubbed: Json;
    rawCanonical: Json;
    pruned: string[];
  }
  const pending: Pending[] = [];
  const formats = new Map<string, LeagueFormat>();
  let season: number | null = null;
  let capturedAt = "";

  for (const { slot, names } of inventory) {
    for (const name of names) {
      const env = readRaw(opts.rawDir, slot, name);
      if (!env) continue;
      const s = seasonOf(env);
      if (season !== null && s !== season)
        throw new ScrubAbort("captures from more than one season in one run");
      season = s;
      if (env.recorded_at > capturedAt) capturedAt = env.recorded_at;
      let raw: Json;
      try {
        raw = parseJsonStrict(env.bodyText);
      } catch (e) {
        throw new ScrubAbort(
          `${slot}/${name}: body is not usable JSON (${e instanceof Error ? e.message : String(e)})`,
        );
      }
      const view = env.views[0] ?? "";
      const keepOrder = KEEP_ORDER[view];
      const pruned =
        env.kind === "league" && !PRUNE_EXEMPT_VIEWS.has(view)
          ? [...new Set([...DEFAULT_PRUNE, ...(opts.prune ?? [])])].sort()
          : [];
      const scrubbed = scrubBody(raw, env.kind, ctxOf(slot), {
        prune: pruned,
        ...(keepOrder ? { keepOrder } : {}),
      });
      const rawCanonical = canonicalize(raw, keepOrder ? { keepOrder } : {});
      if (name === "mSettings" && env.kind === "league") formats.set(slot, leagueFormat(raw));
      pending.push({ env, scrubbed, rawCanonical, pruned });
    }
  }
  if (season === null) throw new ScrubAbort("no captures");

  // the union of every league's captured names and ids applies to every file of the run
  const unionTerms = new Set<string>();
  const unionIds = new Set<string>();
  for (const c of contexts.values()) {
    for (const t of c.denyTerms) unionTerms.add(t);
    for (const id of c.realLeagueIds) unionIds.add(id);
  }

  const outputs: { rel: string; text: string }[] = [];
  const entries: ManifestEntry[] = [];
  const problems: string[] = [];
  const withheldFiles: string[] = [];
  for (const p of pending) {
    const { env } = p;
    const base = `recorded/${env.slot}/${env.name}`;
    const verifyCtx: LeagueScrubContext = {
      ...ctxOf(env.slot),
      denyTerms: unionTerms,
      realLeagueIds: unionIds,
    };
    for (const v of verifyScrubbed(p.scrubbed, env.kind, verifyCtx))
      problems.push(`${base}.json: ${v.rule} at ${v.path}`);

    // the repo scanner (with its local deny-list) over the whole body first; with
    // withholdDenylisted, deny-list-only findings remove their units and the body is re-scanned
    let body = p.scrubbed;
    let rawBody = p.rawCanonical;
    let whole = await formatJson(body, "recorded");
    const withheld: string[] = [];
    let withholdFile = false;
    for (let round = 0; round < 3; round++) {
      const r = scan(whole, `${base}.json`);
      if (r.clean) break;
      const others = r.findings.filter((f) => !f.startsWith(DENY_PREFIX));
      if (r.error || others.length || !opts.withholdDenylisted || round === 2) {
        problems.push(`${base}.json: the repo scanner refused it${r.error ? ` (${r.error})` : ""}`);
        for (const f of annotateFindings(r.findings.slice(0, 40), whole)) problems.push(`  ${f}`);
        break;
      }
      const lines = r.findings
        .map((f) => /:(\d+)$/.exec(f)?.[1])
        .filter((x): x is string => x !== undefined)
        .map(Number);
      const units: { segs: Seg[]; action: "omit" | "empty" }[] = [];
      for (const segs of segmentsAtLines(whole, lines).values()) {
        const u = withholdUnit(env.views[0] ?? "", segs);
        if (u === null) withholdFile = true;
        else if (!units.some((x) => JSON.stringify(x.segs) === JSON.stringify(u.segs)))
          units.push(u);
      }
      if (withholdFile || lines.length !== r.findings.length) {
        withholdFile = true;
        break;
      }
      for (const u of units) withheld.push(formatPath(u.segs));
      body = applyUnits(body, units);
      rawBody = applyUnits(rawBody, units);
      whole = await formatJson(body, "recorded");
    }
    if (withholdFile) {
      withheldFiles.push(`${base}.json`);
      log(`${base}: withheld whole (a deny-list match outside any removable unit)`);
      continue;
    }
    if (withheld.length)
      log(`${base}: withheld ${String(withheld.length)} unit(s) matching the local deny-list`);

    // one file, or — when the body formats past the cap — lossless parts along one top-level array
    let parts: { rel: string; body: Json; raw: Json; part: ManifestEntry["part"] }[] = [
      { rel: `${base}.json`, body, raw: rawBody, part: null },
    ];
    if (Buffer.byteLength(whole, "utf8") > maxBytes) {
      const key = splitArrayKey(body);
      const ranges =
        key && isObject(body) && isObject(rawBody) ? await planSplit(body, key, maxBytes) : null;
      if (!key || !ranges || !isObject(body) || !isObject(rawBody)) {
        problems.push(
          `${base}.json: over the ${String(maxBytes)}-byte cap and cannot be split along a top-level array`,
        );
      } else {
        const scrubbedObj = body;
        const rawObj = rawBody;
        const rawItems = rawObj[key];
        const items = scrubbedObj[key] as Json[];
        if (!Array.isArray(rawItems) || rawItems.length !== items.length) {
          problems.push(`${base}.json: raw and scrubbed ${key} arrays differ in length`);
        } else {
          parts = ranges.map((r, i) => ({
            rel: `${base}.p${String(i + 1)}.json`,
            body: withArray(scrubbedObj, key, items.slice(r.from, r.to)),
            raw: withArray(rawObj, key, rawItems.slice(r.from, r.to)),
            part: { index: i + 1, of: ranges.length, array: key },
          }));
          log(`${base}: split into ${String(parts.length)} parts along ${key} (lossless)`);
        }
      }
    }

    const leagueSlot = env.kind === "league" && env.slot.startsWith("league-") ? env.slot : null;
    const params = new URLSearchParams();
    for (const v of env.views) params.append("view", v);
    for (const [k, v] of Object.entries(env.params)) params.append(k, v);
    const sp = env.params.scoringPeriodId;
    const filterMp =
      isObject(env.filter) &&
      isObject(env.filter.schedule) &&
      isObject(env.filter.schedule.filterMatchupPeriodIds)
        ? env.filter.schedule.filterMatchupPeriodIds.value
        : null;

    for (const part of parts) {
      const text = part.part === null ? whole : await formatJson(part.body, "recorded");
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > maxBytes)
        problems.push(`${part.rel}: ${String(bytes)} bytes, over the ${String(maxBytes)}-byte cap`);
      const scoring = scoringProjection(part.body);
      const rawScoring = scoringProjection(part.raw);
      if (scoring.sha256 !== rawScoring.sha256 || scoring.entries !== rawScoring.entries)
        problems.push(
          `${part.rel}: the scoring fields changed during the scrub (they must hash to the recorded original)`,
        );
      const scanned = scan(text, part.rel);
      if (!scanned.clean) {
        problems.push(
          `${part.rel}: the repo scanner refused it${scanned.error ? ` (${scanned.error})` : ""}`,
        );
        for (const f of annotateFindings(scanned.findings.slice(0, 40), text))
          problems.push(`  ${f}`);
      }
      entries.push({
        path: part.rel,
        league: leagueSlot,
        views: env.views,
        scoringPeriodId: sp !== undefined ? Number(sp) : null,
        matchupPeriodId:
          Array.isArray(filterMp) && typeof filterMp[0] === "number" ? filterMp[0] : null,
        request: {
          route: env.route,
          path: leagueRequestPath(season, env.route),
          query: params.toString(),
          filter: env.filter,
        },
        status: env.status,
        headers: keptHeaders(env.headers),
        recorded_at: env.recorded_at,
        derived: false,
        scrub_rules_version: SCRUB_RULES_VERSION,
        pruned: p.pruned,
        part: part.part,
        withheld,
        stats_official: env.stats_official,
        top_level_keys: isObject(part.body) ? Object.keys(part.body).sort() : [],
        bytes,
        sha256: contentSha256(part.body),
        scoring,
        format: leagueSlot ? (formats.get(leagueSlot) ?? null) : null,
      });
      outputs.push({ rel: part.rel, text });
    }
  }
  const blanked = [...new Set([...contexts.values()].flatMap((c) => [...c.blanked]))].sort();
  if (problems.length)
    throw new ScrubAbort(`refusing to write: ${String(problems.length)} problem(s)`, problems);

  const leagues: FixtureManifest["leagues"] = {};
  for (const [slot, format] of [...formats.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const weeks = new Set<number>();
    for (const e of entries)
      if (
        e.league === slot &&
        e.views[0] === "mBoxscore" &&
        e.stats_official === true &&
        e.scoringPeriodId !== null
      )
        weeks.add(e.scoringPeriodId);
    leagues[slot] = { format, final_boxscore_weeks: [...weeks].sort((a, b) => a - b) };
  }
  const manifest: FixtureManifest = {
    $comment:
      "Recorded ESPN fixtures (evidence, plan 05 §3 fixture law): keyless captures of public leagues, scrubbed by scripts/scrub-fixture.ts (research 03 §F.3). sha256 = sha256 of the canonical JSON (sorted keys, no whitespace) of the scrubbed body; scoring.sha256 = the same over every scoring field (scrub.ts SCORING_KEYS), computed on the raw recording and re-verified on the scrubbed file. `pruned` keys were emptied (never a scoring key); `part` marks one response split along `array` to stay ≤ 1 MB; `withheld` lists units removed because a line of theirs matched the local repo deny-list (never committed). No league id, team name or member name of any recorded league is stored anywhere in this repo.",
    version: 1,
    host: READ_HOST,
    season,
    captured_at: capturedAt,
    scrub_rules_version: SCRUB_RULES_VERSION,
    leagues,
    files: entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    withheld_files: withheldFiles.sort(),
  };
  const manifestText = await formatJson(manifest as unknown as Json);
  const mScan = scan(manifestText, "manifest.json");
  if (!mScan.clean)
    throw new ScrubAbort(
      "refusing to write: the repo scanner refused the manifest",
      annotateFindings(mScan.findings, manifestText),
    );

  if (!opts.dryRun) {
    for (const o of outputs) {
      const file = path.join(opts.outRoot, o.rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, o.text);
    }
    writeFileSync(path.join(opts.outRoot, "manifest.json"), manifestText);
    log(`wrote ${String(outputs.length)} fixture(s) and manifest.json under ${opts.outRoot}`);
  }
  outputs.push({ rel: "manifest.json", text: manifestText });
  return { manifest, outputs, blanked };
}

/** Parses a JSON object from a file (manifest readers). */
export function readJsonObject(file: string): JsonObject {
  const v = parseJsonStrict(readFileSync(file, "utf8"));
  if (!isObject(v)) throw new Error(`${file}: not a JSON object`);
  return v;
}
