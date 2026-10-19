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
  isObject,
  parseJsonStrict,
  setOwn,
  type Json,
  type JsonObject,
} from "./canonical.js";
import { formatJson } from "./format-json.js";
import { pathsAtLines } from "./json-lines.js";
import {
  READ_HOST,
  communicationUrl,
  leagueUrl,
  playersUrl,
  seasonUrl,
  type PoliteClient,
} from "./http.js";
import { leagueFormat, matchupPeriodOf, type LeagueFormat } from "./league-format.js";
import { scanWithRepoScanner } from "./scan.js";
import { SYNTHETIC_ERRORS, type SyntheticError } from "./synthetic.js";
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

/**
 * The four read-host routes a capture can use (research 03 §A.1): a league, the season (no league
 * id), the season player index (`/seasons/{s}/players`, no league id) and the league's board
 * route (`…/communication/` — anonymously a typed 401, the one keyless 401 body).
 */
export type Route = "league" | "season" | "players" | "communication";

/** One raw capture as stored OUTSIDE the repo (it holds the real ids and names). */
export interface RawEnvelope {
  schema: number;
  slot: string;
  name: string;
  kind: BodyKind;
  route: Route;
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
  route: Route;
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
  if (spec.route === "players") return playersUrl(season, spec.views);
  if (leagueId === null) throw new Error("a league request needs a league id");
  if (spec.route === "communication") return communicationUrl(season, leagueId, spec.views);
  return leagueUrl(season, leagueId, spec.views, spec.params);
}

/** The season player index filter (research 03 §A.3: root-level on `/players`; P23). */
export const PLAYERS_WL_FILTER: Json = { filterActive: { value: true } };

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
    // the season player index (the C1 name index — plan 07 C1; research 03 §A.2 P23): a root array
    {
      slot: "season",
      name: "players_wl",
      kind: "season",
      route: "players",
      views: ["players_wl"],
      params: {},
      filter: PLAYERS_WL_FILTER,
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
  // mMatchupScore as the live scoreboard requests it (plan 07 A4: `mMatchupScore&scoringPeriodId=N`,
  // no filter): the current week (pre-kickoff or in-game) and the last recorded final week, whose
  // rows line up with that week's recorded box score (research 03 §B.4, §B.7)
  if (latest === null) throw new Error(`${slot}: mSettings has no status.latestScoringPeriod`);
  const finalWeek = Math.max(...weeks);
  for (const [w, isFinal] of [
    [latest, official.get(latest) === true],
    [finalWeek, true],
  ] as const)
    specs.push({
      slot,
      name: `mMatchupScore.sp${String(w)}`,
      kind: "league",
      route: "league",
      views: ["mMatchupScore"],
      params: { scoringPeriodId: String(w) },
      filter: null,
      expect: "ok",
      stats_official: isFinal,
    });
  // mNav alone (research 03 §A.2 P12): the commissioner flags members[].isLeagueCreator/Manager
  specs.push({
    slot,
    name: "mNav",
    kind: "league",
    route: "league",
    views: ["mNav"],
    params: {},
    filter: null,
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

/** The recorded error bodies for the classifier (research 03 §A.4): 404, 400 and the keyless 401. */
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
    // the board route answers anonymously with a typed 401 (P27 shape) — sent to the first league
    {
      slot: "errors",
      name: "401-communication-not-visible",
      kind: "error",
      route: "communication",
      views: ["kona_league_communication"],
      params: {},
      filter: null,
      expect: "error",
    },
  ];
}

/** At most this many player ids per `filterIds` capture (plan 07 B2/C1: ≤ 25 ids per call). */
export const CARD_IDS_MAX = 25;
/** Of those, this many are spread over the league's own roster; the rest come from the kona page. */
export const CARD_ROSTERED_IDS = 20;

/** Every integer `playerId` of a roster body (`teams[].roster.entries[]`), unique, ascending. */
export function rosteredPlayerIds(rosterBody: Json): number[] {
  const out = new Set<number>();
  const teams = isObject(rosterBody) && Array.isArray(rosterBody.teams) ? rosterBody.teams : [];
  for (const t of teams) {
    const roster = isObject(t) && isObject(t.roster) ? t.roster : null;
    const entries = roster && Array.isArray(roster.entries) ? roster.entries : [];
    for (const e of entries)
      if (isObject(e) && typeof e.playerId === "number" && Number.isSafeInteger(e.playerId))
        out.add(e.playerId);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The deterministic id set of the two `filterIds` captures: CARD_ROSTERED_IDS ids spread evenly
 * over the league's rostered ids (ascending, so the most negative — a D/ST or TQB unit — comes
 * first), then the kona page's ids in its order (free agents) until CARD_IDS_MAX; sorted ascending.
 */
export function cardIds(rosterBody: Json, konaBody: Json, max = CARD_IDS_MAX): number[] {
  if (!Number.isInteger(max) || max < 1 || max > CARD_IDS_MAX)
    throw new Error(`card id count must be 1–${String(CARD_IDS_MAX)}`);
  const rostered = rosteredPlayerIds(rosterBody);
  const want = Math.min(CARD_ROSTERED_IDS, max, rostered.length);
  const chosen = new Set<number>();
  for (let i = 0; i < want; i++) {
    const id = rostered[Math.floor((i * rostered.length) / want)];
    if (id !== undefined) chosen.add(id);
  }
  const page = isObject(konaBody) && Array.isArray(konaBody.players) ? konaBody.players : [];
  for (const p of page) {
    if (chosen.size >= max) break;
    if (isObject(p) && typeof p.id === "number" && Number.isSafeInteger(p.id)) chosen.add(p.id);
  }
  return [...chosen].sort((a, b) => a - b);
}

/**
 * The two per-league captures keyed on player ids (made after the roster and the kona page are
 * known): `kona_player_info` + `filterIds` (plan 07 C1/D2) and `kona_playercard` + `filterIds` +
 * `filterStatsForTopScoringPeriodIds` (plan 07 B2: weekly actuals; research 03 §A.3, §B.5 P21).
 */
export function cardPlan(
  slot: string,
  ids: readonly number[],
  settings: Json,
  season: number,
): RequestSpec[] {
  if (!ids.length || ids.length > CARD_IDS_MAX || !ids.every((i) => Number.isSafeInteger(i)))
    throw new Error(`${slot}: 1–${String(CARD_IDS_MAX)} integer player ids are needed`);
  const status = isObject(settings) && isObject(settings.status) ? settings.status : {};
  const latest = typeof status.latestScoringPeriod === "number" ? status.latestScoringPeriod : null;
  const finalPeriod =
    typeof status.finalScoringPeriod === "number" ? status.finalScoringPeriod : 17;
  return [
    {
      slot,
      name: "kona_player_info.ids",
      kind: "league",
      route: "league",
      views: ["kona_player_info"],
      params: latest !== null ? { scoringPeriodId: String(latest) } : {},
      filter: { players: { filterIds: { value: [...ids] } } },
      expect: "ok",
    },
    {
      slot,
      name: "kona_playercard",
      kind: "league",
      route: "league",
      views: ["kona_playercard"],
      params: {},
      filter: {
        players: {
          filterIds: { value: [...ids] },
          filterStatsForTopScoringPeriodIds: {
            value: finalPeriod,
            additionalValue: [
              `00${String(season)}`,
              `10${String(season)}`,
              `00${String(season - 1)}`,
            ],
          },
        },
      },
      expect: "ok",
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
const PRUNE_EXEMPT_VIEWS = new Set(["kona_player_info", "kona_playercard"]);

export interface ManifestEntry {
  path: string;
  league: string | null;
  views: string[];
  scoringPeriodId: number | null;
  matchupPeriodId: number | null;
  request: { route: Route; path: string; query: string; filter: Json };
  status: number;
  headers: Record<string, string>;
  recorded_at: string;
  derived: false;
  scrub_rules_version: number;
  pruned: string[];
  /**
   * Set when one response was split into parts to stay ≤ 1 MB (concatenate `array` in index order;
   * `array` is `$` when the body itself is the array — players_wl). `id_range`: the first and last
   * element `id` of this part when every element has a numeric id (the canonical order is by id).
   */
  part: {
    index: number;
    of: number;
    array: string;
    id_range?: { first: number; last: number } | null;
  } | null;
  /**
   * Units an EARLIER run removed because a line of theirs matched the local repo deny-list: JSON
   * paths into the scrubbed body as it stood before the removal, never a value. Always empty from
   * Stage C on: a deny-list match aborts the run instead (DENY_LIST_GATE) — it is never withheld.
   */
  withheld: string[];
  /**
   * Player-name leaves an EARLIER run replaced by `Player <id>` for a deny-list match (CAT-12).
   * Always empty from Stage C on, for the same reason as `withheld`.
   */
  replaced: string[];
  /**
   * What an earlier run's withheld units leave missing, value-free (CAT-12): the teams whose roster
   * lost an entry or whose matchup row was removed, and how many matchup rows are gone — so
   * fixture-mode tests never treat an artificial hole as a real empty slot or a missing game.
   * null = complete (always, for a run from Stage C on).
   */
  incomplete: Incomplete | null;
  stats_official: boolean | null;
  top_level_keys: string[];
  bytes: number;
  sha256: string;
  scoring: { entries: number; sha256: string };
  format: LeagueFormat | null;
}

/**
 * What withheld units leave missing, value-free (CAT-12): team ids whose roster lost an entry or
 * whose matchup row is gone, the count of removed matchup rows, and the count of removed player
 * rows (`$[n]` of players_wl, `$.players[n]` of the kona views) — a count, never an id (a row is
 * withheld because a line of it matched the local deny-list, which may be that very id).
 */
export interface Incomplete {
  team_ids: number[];
  matchups_missing: number;
  rows_missing?: number;
}

/**
 * A hand-written body (plan 05 §3 fixture law: synthetic is allowed ONLY for error bodies, never
 * for a scoring field): the shape comes from `basis` (research 03 §A.4), not from a recording.
 */
export interface SyntheticEntry {
  path: string;
  synthetic: true;
  kind: "error";
  views: string[];
  status: number;
  basis: string;
  headers: Record<string, string>;
  top_level_keys: string[];
  bytes: number;
  sha256: string;
  scoring: { entries: number; sha256: string };
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
  /** Captures an earlier run withheld whole for a deny-list match; always empty from Stage C on. */
  withheld_files: string[];
  /** Hand-written error bodies (never evidence), under `synthetic/`. */
  synthetic_files?: SyntheticEntry[];
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
  /** The hand-written error bodies to write under `synthetic/` (tests); defaults to SYNTHETIC_ERRORS. */
  synthetic?: readonly SyntheticError[];
}

const DENY_PREFIX = "deny-list match in ";

/**
 * Why a deny-list match aborts the run and is never withheld (plan 05 §3.1 step 2: "refuses to write
 * unless its deny-list check passes", "abort with the path"; plan 02 §8 threat #13; CLAUDE.md: never
 * the probe leagues' ids). The scrub has already replaced every league-private string, so a match in
 * a scrubbed capture is public ESPN data that coincides with a private term — a D/ST's or a player's
 * id equal to a deny-listed league id, a player named like a deny-listed member. Removing or
 * relabelling that unit cannot hide the term: the committed files, the manifest's paths and ESPN's
 * own public data show which public unit is missing (a players_wl row in id order, the one pro
 * team's emptied teamPlayersByPosition, a gap no other file has), so the gap itself publishes it
 * (Stage C finding fixtures-withheld-unit-discloses-term). The deny-list is therefore a gate, never
 * a filter: whatever it holds, a run writes the same bytes or nothing. Local output only.
 */
export const DENY_LIST_GATE =
  "a deny-list match is never withheld or replaced: the term coincides with public ESPN data (an id or a name), and the gap that hid it would show which public unit it is — nothing was written; resolve the coincidence (the deny-list term or the recorded league — the owner's decision), then re-run";

/** The refusal of the removed `--withhold-denylisted` option (exit 2): the reason, never a value. */
export const WITHHOLD_REMOVED =
  "--withhold-denylisted was removed: withholding a unit for a deny-list match publishes the term (the gap shows which public unit is missing), so a deny-list match now aborts the run (plan 05 §3.1 step 2)";

/**
 * The value-free incompleteness a set of withheld units leaves in a COMMITTED (post-withhold)
 * body (CAT-12) — the reader of what earlier runs committed; no run withholds any more:
 * `teams[i].roster.entries[j]` → teams[i].id; `schedule[k].<side>.….entries[j]` → that side's
 * teamId; a whole `schedule[k]` row (box scores) → every team of `teams[]` no remaining row
 * names, and one missing matchup per removed row. null when nothing was withheld.
 */
export function deriveIncomplete(body: Json, withheld: readonly string[]): Incomplete | null {
  if (!withheld.length) return null;
  const teamIds = new Set<number>();
  let matchupsMissing = 0;
  let rowsMissing = 0;
  const b = isObject(body) ? body : null;
  const teams = b && Array.isArray(b.teams) ? b.teams : [];
  const schedule = b && Array.isArray(b.schedule) ? b.schedule : [];
  for (const w of withheld) {
    let m = /^\$\.teams\[(\d+)\]\.roster\.entries\[\d+\]$/.exec(w);
    if (m) {
      const t = teams[Number(m[1])];
      if (isObject(t) && typeof t.id === "number") teamIds.add(t.id);
      continue;
    }
    m = /^\$\.schedule\[(\d+)\]\.(home|away)\.[A-Za-z]+\.entries\[\d+\]$/.exec(w);
    if (m) {
      const row = schedule[Number(m[1])];
      const side = isObject(row) ? row[m[2] ?? ""] : null;
      if (isObject(side) && typeof side.teamId === "number") teamIds.add(side.teamId);
      continue;
    }
    if (/^\$\.schedule\[\d+\]$/.test(w)) {
      matchupsMissing++;
      continue;
    }
    if (/^\$(?:\.players)?\[\d+\]$/.test(w)) rowsMissing++;
  }
  if (matchupsMissing > 0) {
    const playing = new Set<number>();
    for (const row of schedule)
      if (isObject(row))
        for (const side of ["home", "away"]) {
          const s = row[side];
          if (isObject(s) && typeof s.teamId === "number") playing.add(s.teamId);
        }
    for (const t of teams)
      if (isObject(t) && typeof t.id === "number" && !playing.has(t.id)) teamIds.add(t.id);
  }
  return {
    team_ids: [...teamIds].sort((x, y) => x - y),
    matchups_missing: matchupsMissing,
    ...(rowsMissing > 0 ? { rows_missing: rowsMissing } : {}),
  };
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
      "players_wl",
      "404-league-not-found",
      "400-limit-missing-sort",
      "401-communication-not-visible",
      "mSettings",
      "mTeam",
      "mMatchup",
    ];
    const i = fixed.indexOf(n);
    if (i >= 0) return `0${String(i).padStart(2, "0")}`;
    if (n.startsWith("mRoster.sp")) return `1${n.slice(10).padStart(3, "0")}`;
    if (n.startsWith("mBoxscore.sp")) return `2${n.slice(12).padStart(3, "0")}`;
    if (n === "kona_player_info") return "3";
    if (n.startsWith("mMatchupScore.sp")) return `4${n.slice(16).padStart(3, "0")}`;
    if (n === "mNav") return "5";
    if (n === "kona_player_info.ids") return "6";
    if (n === "kona_playercard") return "7";
    if (n === "probe-shape") return "8";
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

/** The scrubbed request path of a capture (the league id is always 0 here). */
export function leagueRequestPath(season: number, route: Route): string {
  const base = `/apis/v3/games/ffl/seasons/${String(season)}`;
  if (route === "season") return base;
  if (route === "players") return `${base}/players`;
  if (route === "communication") return `${base}/segments/0/leagues/0/communication/`;
  return `${base}/segments/0/leagues/0`;
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

/** The `part.array` of a body that is itself the array (players_wl). */
export const ROOT_ARRAY = "$";

/**
 * The array a too-large body is split along: the body itself when it is an array (≥ 2 elements),
 * else the largest top-level array with ≥ 2 elements.
 */
export function splitArrayKey(body: Json): string | null {
  if (Array.isArray(body)) return body.length >= 2 ? ROOT_ARRAY : null;
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

/** The array `key` of `body` (`$`: the body itself), or null. */
function arrayAt(body: Json, key: string): Json[] | null {
  if (key === ROOT_ARRAY) return Array.isArray(body) ? body : null;
  return isObject(body) && Array.isArray(body[key]) ? body[key] : null;
}

/** `body` with its array `key` replaced by `items` (`$`: the items themselves). */
export function withArray(body: Json, key: string, items: Json[]): Json {
  if (key === ROOT_ARRAY || !isObject(body)) return items;
  const out = emptyObject();
  for (const k of Object.keys(body)) setOwn(out, k, k === key ? items : (body[k] as Json));
  return out;
}

/** The first and last numeric `id` of `items` when every element has one, else null. */
export function idRange(items: readonly Json[]): { first: number; last: number } | null {
  const ids = items.map((el) => (isObject(el) && typeof el.id === "number" ? el.id : null));
  const first = ids[0];
  const last = ids[ids.length - 1];
  if (!ids.length || ids.some((i) => i === null) || typeof first !== "number") return null;
  return typeof last === "number" ? { first, last } : null;
}

/**
 * Splits a body along one array (`$` = the body itself) into contiguous parts that each format to
 * ≤ maxBytes, each part as long as it can be (lossless: concatenating the parts' arrays in index
 * order restores the body). The formatted size grows strictly with every added element, so a
 * binary search per part finds the same boundary the one-at-a-time growth would (a 2,663-row
 * index stays a few dozen formats). Returns the index ranges, or null when one element alone is
 * over the cap.
 */
export async function planSplit(
  body: Json,
  key: string,
  maxBytes: number,
): Promise<{ from: number; to: number }[] | null> {
  const items = arrayAt(body, key);
  if (!items) return null;
  const fits = async (from: number, to: number) =>
    Buffer.byteLength(await formatJson(withArray(body, key, items.slice(from, to)), "recorded")) <=
    maxBytes;
  const ranges: { from: number; to: number }[] = [];
  let from = 0;
  while (from < items.length) {
    if (!(await fits(from, from + 1))) return null;
    let lo = from + 1; // fits
    let hi = items.length; // may fit
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (await fits(from, mid)) lo = mid;
      else hi = mid - 1;
    }
    ranges.push({ from, to: lo });
    from = lo;
  }
  return ranges;
}

/** One scrubbed capture on its way to a committed file (scrubRun, history.ts). */
export interface PendingCapture {
  env: RawEnvelope;
  /** The output path without `.json`, relative to the fixtures root (`recorded/<slot>/<name>`). */
  base: string;
  /** The season of the request (the scrubbed request path names it). */
  season: number;
  scrubbed: Json;
  /** The raw body in canonical order (the scoring-projection identity is checked against it). */
  rawCanonical: Json;
  pruned: string[];
  /** The league's format summary for league bodies, else null. */
  format: LeagueFormat | null;
}

export interface FreezeOptions {
  scan: (text: string, label: string) => { clean: boolean; findings: string[]; error?: string };
  maxBytes: number;
  log: (s: string) => void;
  /** The verification context of a slot: its own GUID map, the run's union of names and ids. */
  verifyCtxOf: (slot: string) => LeagueScrubContext;
}

export interface FreezeResult {
  entries: ManifestEntry[];
  outputs: { rel: string; text: string }[];
  problems: string[];
}

/**
 * The freeze half of a scrub run (plan 05 §3.1 steps 2–4): per capture, the in-process verification,
 * the lossless split past the size cap, the scoring-projection identity, the repo scanner with its
 * local deny-list over exactly the text each file will hold (any finding — a deny-list match
 * included — is a problem: DENY_LIST_GATE) and the manifest entry with its provenance hashes. Writes
 * nothing: the caller writes only when `problems` is empty (an abort leaves the repo untouched).
 */
export async function freezeCaptures(
  pending: readonly PendingCapture[],
  opts: FreezeOptions,
): Promise<FreezeResult> {
  const { scan, maxBytes, log } = opts;
  const outputs: { rel: string; text: string }[] = [];
  const entries: ManifestEntry[] = [];
  const problems: string[] = [];
  let gateNoted = false;
  for (const p of pending) {
    const { env, base, season } = p;
    const verifyCtx = opts.verifyCtxOf(env.slot);
    for (const v of verifyScrubbed(p.scrubbed, env.kind, verifyCtx))
      problems.push(`${base}.json: ${v.rule} at ${v.path}`);

    // the body is frozen as scrubbed: no deny-list match ever removes or relabels a unit of it
    const body = p.scrubbed;
    const rawBody = p.rawCanonical;
    const whole = await formatJson(body, "recorded");

    // one file, or — when the body formats past the cap — lossless parts along one top-level array
    let parts: { rel: string; body: Json; raw: Json; part: ManifestEntry["part"] }[] = [
      { rel: `${base}.json`, body, raw: rawBody, part: null },
    ];
    if (Buffer.byteLength(whole, "utf8") > maxBytes) {
      const key = splitArrayKey(body);
      const ranges = key ? await planSplit(body, key, maxBytes) : null;
      const items = key ? arrayAt(body, key) : null;
      const rawItems = key ? arrayAt(rawBody, key) : null;
      if (!key || !ranges || !items) {
        problems.push(
          `${base}.json: over the ${String(maxBytes)}-byte cap and cannot be split along an array`,
        );
      } else if (rawItems?.length !== items.length) {
        problems.push(`${base}.json: raw and scrubbed ${key} arrays differ in length`);
      } else {
        parts = ranges.map((r, i) => {
          const slice = items.slice(r.from, r.to);
          return {
            rel: `${base}.p${String(i + 1)}.json`,
            body: withArray(body, key, slice),
            raw: withArray(rawBody, key, rawItems.slice(r.from, r.to)),
            part: { index: i + 1, of: ranges.length, array: key, id_range: idRange(slice) },
          };
        });
        log(`${base}: split into ${String(parts.length)} parts along ${key} (lossless)`);
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
        if (!gateNoted && scanned.findings.some((f) => f.startsWith(DENY_PREFIX))) {
          gateNoted = true;
          problems.push(`  ${DENY_LIST_GATE}`);
        }
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
        withheld: [],
        replaced: [],
        incomplete: null,
        stats_official: env.stats_official,
        top_level_keys: isObject(part.body) ? Object.keys(part.body).sort() : [],
        bytes,
        sha256: contentSha256(part.body),
        scoring,
        format: leagueSlot ? p.format : null,
      });
      outputs.push({ rel: part.rel, text });
    }
  }
  return { entries, outputs, problems };
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

  const frozen = await freezeCaptures(
    pending.map((p) => ({
      env: p.env,
      base: `recorded/${p.env.slot}/${p.env.name}`,
      season: season,
      scrubbed: p.scrubbed,
      rawCanonical: p.rawCanonical,
      pruned: p.pruned,
      format:
        p.env.kind === "league" && p.env.slot.startsWith("league-")
          ? (formats.get(p.env.slot) ?? null)
          : null,
    })),
    {
      scan,
      maxBytes,
      log,
      verifyCtxOf: (slot) => ({ ...ctxOf(slot), denyTerms: unionTerms, realLeagueIds: unionIds }),
    },
  );
  const { outputs, entries, problems } = frozen;
  const blanked = [...new Set([...contexts.values()].flatMap((c) => [...c.blanked]))].sort();
  const synthetic = await syntheticOutputs(opts.synthetic ?? SYNTHETIC_ERRORS, scan, problems);
  outputs.push(...synthetic.outputs);
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
      "Recorded ESPN fixtures (evidence, plan 05 §3 fixture law): keyless captures of public leagues, scrubbed by scripts/scrub-fixture.ts (research 03 §F.3). sha256 = sha256 of the canonical JSON (sorted keys, no whitespace) of the scrubbed body; scoring.sha256 = the same over every scoring field (scrub.ts SCORING_KEYS), computed on the raw recording and re-verified on the scrubbed file. `pruned` keys were emptied (never a scoring key); `part` marks one response split along `array` to stay ≤ 1 MB; `withheld` / `replaced` / `incomplete` / `withheld_files` are empty: a match of the local repo deny-list aborts the run, it is never withheld (a gap would show which public unit it is); `synthetic_files` are hand-written error bodies (never evidence, never a scoring field). No league id, team name or member name of any recorded league is stored anywhere in this repo.",
    version: 1,
    host: READ_HOST,
    season,
    captured_at: capturedAt,
    scrub_rules_version: SCRUB_RULES_VERSION,
    leagues,
    files: entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    withheld_files: [],
    synthetic_files: synthetic.entries,
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

/**
 * The hand-written error bodies (synthetic.ts) as files under `synthetic/errors/` and their
 * manifest entries. Refused (a problem) unless each is an error status with no scoring field and
 * the repo scanner passes it.
 */
export async function syntheticOutputs(
  list: readonly SyntheticError[],
  scan: (text: string, label: string) => { clean: boolean; findings: string[]; error?: string },
  problems: string[],
): Promise<{ outputs: { rel: string; text: string }[]; entries: SyntheticEntry[] }> {
  const outputs: { rel: string; text: string }[] = [];
  const entries: SyntheticEntry[] = [];
  const names = new Set<string>();
  for (const s of [...list].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const rel = `synthetic/errors/${s.name}.json`;
    if (!/^[\w.-]{1,80}$/.test(s.name) || names.has(s.name)) {
      problems.push(`${rel}: bad or duplicate synthetic name`);
      continue;
    }
    names.add(s.name);
    const body = canonicalize(s.body);
    const scoring = scoringProjection(body);
    if (!Number.isInteger(s.status) || s.status < 400 || s.status > 599)
      problems.push(`${rel}: a synthetic body must be an error (status ${String(s.status)})`);
    if (scoring.entries > 0)
      problems.push(`${rel}: a synthetic body may never carry a scoring field (fixture law)`);
    const text = await formatJson(body);
    const scanned = scan(text, rel);
    if (!scanned.clean) problems.push(`${rel}: the repo scanner refused it`);
    outputs.push({ rel, text });
    entries.push({
      path: rel,
      synthetic: true,
      kind: "error",
      views: [...s.views],
      status: s.status,
      basis: s.basis,
      headers: { "content-type": "application/json;charset=utf-8" },
      top_level_keys: isObject(body) ? Object.keys(body).sort() : [],
      bytes: Buffer.byteLength(text, "utf8"),
      sha256: contentSha256(body),
      scoring,
    });
  }
  return { outputs, entries };
}

/** Parses a JSON object from a file (manifest readers). */
export function readJsonObject(file: string): JsonObject {
  const v = parseJsonStrict(readFileSync(file, "utf8"));
  if (!isObject(v)) throw new Error(`${file}: not a JSON object`);
  return v;
}
