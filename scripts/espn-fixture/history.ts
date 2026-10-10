// history.ts — the keyless recording of the public probe leagues' FINISHED previous seasons, the
// Phase 3 inputs: plan 10 §3.3 (C4 — the seeding simulator reproducing `playoffSeed` on finished
// seasons in `status.previousSeasons`; C1 — ESPN's weekly projections, `statSourceId 1`; C3 — the
// season replay; ≥ 3 historical seasons [A-3]), research 03 §A.1 (one league object per season; the
// modern route serves 2018+), §B.5 (weekly projection = statSourceId 1, statSplitTypeId 1, embedded
// per scoring period — on a previous season only the box score carries it, see docs/evals/
// phase3-data.md), §D.3 (polite: ≥ 1.2 s spacing, a request cap, no retry on a 4xx), §F.3 (the
// scrub, the deny-list abort), plan 05 §3.1 steps 1–4 (raw OUTSIDE the repo, determinism, provenance
// hashes). Committed under fixtures/espn/recorded/history/<season>/<slot>/ and indexed by
// fixtures/espn/recorded/history/manifest.json — never by fixtures/espn/manifest.json, whose
// canonical hash the drift entity manifest binds (scripts/gen-manifest.ts). Its `files[]` entries
// have the recording manifest's shape, so fixture mode can serve a previous season
// (src/providers/espn/fixture.ts `createFixtureFetch({ manifest: "recorded/history/manifest.json" })`).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  canonicalize,
  isObject,
  parseJsonStrict,
  type Json,
  type JsonObject,
} from "./canonical.js";
import { formatJson } from "./format-json.js";
import { findCookieMaterial, rawDirRefusal } from "./guards.js";
import {
  READ_HOST,
  REPO_ROOT,
  defaultSeason,
  isLeagueId,
  politeClient,
  userAgent,
  type FetchLike,
  type PoliteClient,
} from "./http.js";
import type { Seg } from "./json-lines.js";
import { leagueFormat, matchupPeriodOf, type LeagueFormat } from "./league-format.js";
import {
  DEFAULT_PRUNE,
  LEAGUE_SLOTS,
  MAX_FIXTURE_BYTES,
  annotateFindings,
  captureOne,
  freezeCaptures,
  officialWeeks,
  rawInventory,
  readRaw,
  seasonPlan,
  withholdUnit,
  type ManifestEntry,
  type PendingCapture,
  type RawEnvelope,
  type RequestSpec,
} from "./pipeline.js";
import { scanWithRepoScanner } from "./scan.js";
import {
  SCRUB_RULES_VERSION,
  ScrubAbort,
  createLeagueContext,
  scrubBody,
  type LeagueScrubContext,
} from "./scrub.js";

/** The most requests one history run may ever send (the Phase 3 recording brief: ≤ 90). */
export const HISTORY_HARD_REQUEST_CAP = 90;
/** The default cap: three seasons × three leagues + two projection seasons need ≤ 65. */
export const HISTORY_DEFAULT_MAX_REQUESTS = 70;
/** Seasons recorded by default: the three before the current one (plan 10 §3.3 "≥ 3" [A-3]). */
export const HISTORY_DEFAULT_SEASON_COUNT = 3;
/** Of those, the most recent this many carry the weekly box scores (ESPN's weekly projections). */
export const HISTORY_DEFAULT_PROJECTION_SEASON_COUNT = 2;
/**
 * The slot whose box scores carry the projections: the probe league closest to the reference
 * format (10 teams, half-PPR — D2). Raw projected `stats` re-score under any league's scoring.
 */
export const HISTORY_DEFAULT_PROJECTIONS_SLOT = "league-b";
/** The first season the modern route serves (research 03 §A.1; older ones need leagueHistory). */
export const MODERN_ROUTE_FIRST_SEASON = 2018;
/** At most this many box-score weeks per league-season (NFL scoring periods 1–18). */
export const MAX_BOX_WEEKS = 18;
/** Committed paths, relative to fixtures/espn. */
export const HISTORY_REL = "recorded/history";
export const HISTORY_MANIFEST_REL = `${HISTORY_REL}/manifest.json`;

/** The capture names a history run makes (anything else in a raw history dir is refused). */
const LEAGUE_NAME_RE = /^(?:mSettings|mTeam|mMatchup|mBoxscore\.sp(?:[1-9]|1[0-8]))$/;
const SEASON_NAMES = new Set(["proTeamSchedules_wl"]);

export interface HistoryOptions {
  /** Seasons to record, descending (the most valuable first if a run is cut short). */
  seasons: number[];
  /** League ids in slot order (league-a, league-b, …); never written into the repo. */
  leagues: string[];
  /** The slot whose box scores are recorded for the projection seasons; null = none. */
  projectionsSlot: string | null;
  projectionSeasons: number[];
  rawDir: string;
  /** fixtures/espn: the committed current-season mSettings bind each slot; outputs go below it. */
  outRoot: string;
  maxRequests: number;
  scrub: boolean;
  scrubOnly: boolean;
  withholdDenylisted: boolean;
  prune: string[];
}

export class HistoryRefusal extends Error {}

const yearList = (text: string, flag: string, max: number): number[] => {
  const years = text.split(",").map((w) => Number(w.trim()));
  if (
    !years.length ||
    years.some((y) => !Number.isInteger(y) || y < MODERN_ROUTE_FIRST_SEASON || y > max) ||
    new Set(years).size !== years.length
  )
    throw new HistoryRefusal(
      `${flag} needs distinct finished seasons ${String(MODERN_ROUTE_FIRST_SEASON)}–${String(max)}`,
    );
  return years.sort((a, b) => b - a);
};

/**
 * Parses `record-fixture.ts --public --history …`; throws HistoryRefusal (exit 2) — on any cookie
 * material first, before anything else is looked at.
 */
export function parseHistoryArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  now: Date,
): HistoryOptions {
  const cookies = findCookieMaterial(env, argv);
  if (cookies.length)
    throw new HistoryRefusal(
      `refusing to run: cookie material is present (${cookies.join(", ")}). The recorder is keyless — unset it and re-run.`,
    );
  if (!argv.includes("--public") || !argv.includes("--history"))
    throw new HistoryRefusal("history recording needs --public --history (keyless)");
  const lastFinished = defaultSeason(now) - 1;
  let seasons: number[] | null = null;
  let projectionSeasons: number[] | null = null;
  let projectionsSlot: string | null = HISTORY_DEFAULT_PROJECTIONS_SLOT;
  let rawDir: string | null = null;
  let outRoot = path.join(REPO_ROOT, "fixtures", "espn");
  let maxRequests = HISTORY_DEFAULT_MAX_REQUESTS;
  let scrub = true;
  let scrubOnly = false;
  let withholdDenylisted = false;
  let prune: string[] = [];
  const leagues: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--"))
        throw new HistoryRefusal(`${String(a)} needs a value`);
      return v;
    };
    switch (a) {
      case "--public":
      case "--history":
        break;
      case "--seasons":
        seasons = yearList(val(), "--seasons", lastFinished);
        break;
      case "--projection-seasons":
        projectionSeasons = yearList(val(), "--projection-seasons", lastFinished);
        break;
      case "--projections": {
        const v = val();
        if (v === "none") projectionsSlot = null;
        else if ((LEAGUE_SLOTS as readonly string[]).includes(v)) projectionsSlot = v;
        else throw new HistoryRefusal("--projections takes a league slot (league-a…) or none");
        break;
      }
      case "--raw-dir":
        rawDir = path.resolve(val());
        break;
      case "--out":
        outRoot = path.resolve(val());
        break;
      case "--max-requests":
        maxRequests = Number(val());
        if (
          !Number.isInteger(maxRequests) ||
          maxRequests < 1 ||
          maxRequests > HISTORY_HARD_REQUEST_CAP
        )
          throw new HistoryRefusal(`--max-requests must be 1–${String(HISTORY_HARD_REQUEST_CAP)}`);
        break;
      case "--prune":
        prune = val()
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean);
        if (prune.some((k) => !/^[A-Za-z_]\w{0,63}$/.test(k)))
          throw new HistoryRefusal("--prune takes key names");
        break;
      case "--no-scrub":
        scrub = false;
        break;
      case "--scrub-only":
        scrubOnly = true;
        break;
      case "--withhold-denylisted":
        withholdDenylisted = true;
        break;
      case "--league": {
        const id = val();
        if (!isLeagueId(id)) throw new HistoryRefusal("--league needs a positive integer id");
        leagues.push(id);
        break;
      }
      default:
        throw new HistoryRefusal(`unknown argument #${String(i + 1)}`);
    }
  }
  if (scrubOnly && !scrub) throw new HistoryRefusal("--scrub-only and --no-scrub contradict");
  if (!scrubOnly && !leagues.length) {
    const fromEnv = (env.EFF_PROBE_LEAGUE_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (fromEnv.some((id) => !isLeagueId(id)))
      throw new HistoryRefusal("EFF_PROBE_LEAGUE_IDS must be comma-separated positive integers");
    leagues.push(...fromEnv);
  }
  if (!scrubOnly && !leagues.length)
    throw new HistoryRefusal(
      "no league: set EFF_PROBE_LEAGUE_IDS (comma-separated public league ids)",
    );
  if (new Set(leagues).size !== leagues.length)
    throw new HistoryRefusal("a league id is given twice");
  if (leagues.length > LEAGUE_SLOTS.length)
    throw new HistoryRefusal(`at most ${String(LEAGUE_SLOTS.length)} leagues per run`);
  const seasonsResolved =
    seasons ??
    Array.from({ length: HISTORY_DEFAULT_SEASON_COUNT }, (_, i) => lastFinished - i).filter(
      (y) => y >= MODERN_ROUTE_FIRST_SEASON,
    );
  const projResolved =
    projectionSeasons ?? seasonsResolved.slice(0, HISTORY_DEFAULT_PROJECTION_SEASON_COUNT);
  if (projResolved.some((y) => !seasonsResolved.includes(y)))
    throw new HistoryRefusal("--projection-seasons must be among --seasons");
  if (projectionsSlot !== null && !scrubOnly) {
    const slotIndex = (LEAGUE_SLOTS as readonly string[]).indexOf(projectionsSlot);
    if (slotIndex >= leagues.length)
      throw new HistoryRefusal(`--projections ${projectionsSlot}: no league is bound to that slot`);
  }
  const raw =
    rawDir ??
    path.join(
      homedir(),
      ".cache",
      "espn-fantasy-football-mcp",
      "recordings",
      `history-${now.toISOString().slice(0, 10)}`,
    );
  if (rawDirRefusal(raw, REPO_ROOT) !== null)
    throw new HistoryRefusal(
      "the raw directory must be OUTSIDE the repository and outside any git working tree (raw captures hold real names and ids)",
    );
  return {
    seasons: seasonsResolved,
    leagues,
    projectionsSlot,
    projectionSeasons: projectionsSlot === null ? [] : projResolved,
    rawDir: raw,
    outRoot,
    maxRequests,
    scrub,
    scrubOnly,
    withholdDenylisted,
    prune,
  };
}

/** The upper bound of requests a run makes (checked against the cap before the first request). */
export function plannedHistoryRequests(o: HistoryOptions): number {
  const perLeagueSeason = 3; /* mSettings, mTeam+mStandings, mMatchup */
  const projection = o.projectionsSlot === null ? 0 : o.projectionSeasons.length;
  return (
    o.seasons.length * o.leagues.length * perLeagueSeason +
    projection * (1 /* proTeamSchedules_wl */ + MAX_BOX_WEEKS)
  );
}

const leagueSpec = (
  slot: string,
  name: string,
  views: string[],
  params: Record<string, string> = {},
  filter: Json = null,
): RequestSpec => ({
  slot,
  name,
  kind: "league",
  route: "league",
  views,
  params,
  filter,
  expect: "ok",
});

export const historySettingsSpec = (slot: string): RequestSpec =>
  leagueSpec(slot, "mSettings", ["mSettings"]);

/**
 * The box-score weeks of a finished league-season: scoring periods 1 … status.finalScoringPeriod,
 * each in a matchup period and each final (every NFL game `statsOfficial: true`) — else it throws.
 */
export function boxScoreWeeks(settings: Json, official: ReadonlyMap<number, boolean>): number[] {
  const status = isObject(settings) && isObject(settings.status) ? settings.status : {};
  const final = typeof status.finalScoringPeriod === "number" ? status.finalScoringPeriod : null;
  if (final === null || !Number.isInteger(final) || final < 1 || final > MAX_BOX_WEEKS)
    throw new Error("mSettings has no usable status.finalScoringPeriod");
  const weeks = Array.from({ length: final }, (_, i) => i + 1);
  for (const w of weeks) {
    if (matchupPeriodOf(settings, w) === null)
      throw new Error(`scoring period ${String(w)} is in no matchup period`);
    if (official.get(w) !== true)
      throw new Error(
        `scoring period ${String(w)} is not final (statsOfficial is not true for every game)`,
      );
  }
  return weeks;
}

/** The per-league-season captures after its mSettings (mTeam + mStandings, mMatchup, box scores). */
export function historyLeagueSpecs(
  slot: string,
  settings: Json,
  boxWeeks: readonly number[],
): RequestSpec[] {
  const specs = [
    leagueSpec(slot, "mTeam", ["mTeam", "mStandings"]),
    leagueSpec(slot, "mMatchup", ["mMatchup"]),
  ];
  for (const w of boxWeeks) {
    const mp = matchupPeriodOf(settings, w);
    if (mp === null)
      throw new Error(`${slot}: scoring period ${String(w)} is in no matchup period`);
    specs.push({
      ...leagueSpec(
        slot,
        `mBoxscore.sp${String(w)}`,
        ["mBoxscore"],
        { scoringPeriodId: String(w) },
        {
          schedule: { filterMatchupPeriodIds: { value: [mp] } },
        },
      ),
      stats_official: true,
    });
  }
  return specs;
}

/** `status.previousSeasons` of a league body (integers only), or null. */
export function previousSeasonsOf(body: Json): number[] | null {
  if (!isObject(body) || !isObject(body.status)) return null;
  const prev = body.status.previousSeasons;
  if (!Array.isArray(prev) || !prev.every((s) => typeof s === "number" && Number.isInteger(s)))
    return null;
  return [...(prev as number[])].sort((a, b) => a - b);
}

/**
 * Why a fetched previous-season mSettings does not belong to the committed slot, or null: a league
 * object is per season (research 03 §B.1), so the season's `previousSeasons` must be exactly the
 * committed current season's list cut below it. Catches an id bound to the wrong slot before any
 * further request is made for it.
 */
export function slotBindingProblem(season: number, fetched: Json, committed: Json): string | null {
  if (!isObject(fetched) || fetched.seasonId !== season)
    return "the response is not that season's league object";
  const got = previousSeasonsOf(fetched);
  const want = previousSeasonsOf(committed);
  if (got === null) return "the response has no status.previousSeasons";
  if (want === null) return "the committed mSettings has no status.previousSeasons";
  const expected = want.filter((s) => s < season);
  return JSON.stringify(got) === JSON.stringify(expected)
    ? null
    : "its previousSeasons differ from the committed slot's (a different league)";
}

const DECIDED = new Set(["HOME", "AWAY", "TIE"]);

/** Whether a finished season: every schedule row decided, and the league's clock past its final period. */
export function seasonFinished(
  settings: Json,
  matchup: Json,
): { finished: boolean; undecided: number } {
  const status = isObject(settings) && isObject(settings.status) ? settings.status : {};
  const latest = typeof status.latestScoringPeriod === "number" ? status.latestScoringPeriod : null;
  const final = typeof status.finalScoringPeriod === "number" ? status.finalScoringPeriod : null;
  const rows = isObject(matchup) && Array.isArray(matchup.schedule) ? matchup.schedule : [];
  const undecided = rows.filter(
    (r) => !isObject(r) || typeof r.winner !== "string" || !DECIDED.has(r.winner),
  ).length;
  return {
    finished:
      rows.length > 0 && undecided === 0 && latest !== null && final !== null && latest > final,
    undecided,
  };
}

/** The committed current-season mSettings of a slot (the anchor of the slot binding). */
export function committedSettings(outRoot: string, slot: string): Json {
  const file = path.join(outRoot, "recorded", slot, "mSettings.json");
  if (!existsSync(file))
    throw new HistoryRefusal(
      `no committed ${slot}/mSettings.json to bind the history to — record the current season first`,
    );
  return parseJsonStrict(readFileSync(file, "utf8"));
}

/** A previous season ESPN would not serve keylessly (a typed 4xx; never retried). */
export interface NotServed {
  status: number;
  error_type: string | null;
}

/** The ESPN error type of a 4xx body (`details[0].type`, an UPPER_SNAKE token), or null. */
export function errorTypeOf(bodyText: string): string | null {
  try {
    const b = parseJsonStrict(bodyText);
    const d = isObject(b) && Array.isArray(b.details) ? b.details[0] : null;
    const t = isObject(d) ? d.type : null;
    return typeof t === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * Captures one spec whose 4xx means "not served" (a previous season's mSettings): a stored 4xx is
 * reused (never re-requested), a fresh 4xx is stored and reported, anything else is captureOne's.
 */
async function captureOrNotServed(
  client: PoliteClient,
  seasonRaw: string,
  spec: RequestSpec,
  season: number,
  leagueId: string,
  now: () => Date,
  log: (s: string) => void,
): Promise<RawEnvelope | NotServed> {
  const prior = readRaw(seasonRaw, spec.slot, spec.name);
  if (prior && prior.status >= 400 && prior.status < 500) {
    log(
      `${String(season)} ${spec.slot}/${spec.name}: stored HTTP ${String(prior.status)} — not served (reused)`,
    );
    return { status: prior.status, error_type: errorTypeOf(prior.bodyText) };
  }
  try {
    return await captureOne(client, seasonRaw, spec, season, leagueId, now, log);
  } catch (e) {
    const stored = readRaw(seasonRaw, spec.slot, spec.name);
    if (stored && stored.status >= 400 && stored.status < 500)
      return { status: stored.status, error_type: errorTypeOf(stored.bodyText) };
    throw e;
  }
}

export interface HistoryDeps {
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
  log?: (s: string) => void;
  scan?: (text: string, label: string) => { clean: boolean; findings: string[]; error?: string };
}

interface HistoryRun {
  mode: "history";
  seasons: number[];
  slots: Record<string, string>;
  projections: { slot: string | null; seasons: number[] };
}

/** Binds the run (slots → ids, seasons) in the raw dir, outside the repo, so a resume cannot mix runs. */
function bindHistoryRun(o: HistoryOptions): Map<string, string> {
  const slots = new Map<string, string>();
  o.leagues.forEach((id, i) => slots.set(LEAGUE_SLOTS[i] as string, id));
  mkdirSync(o.rawDir, { recursive: true, mode: 0o700 });
  const runFile = path.join(o.rawDir, "run.json");
  const run: HistoryRun = {
    mode: "history",
    seasons: o.seasons,
    slots: Object.fromEntries(slots),
    projections: { slot: o.projectionsSlot, seasons: o.projectionSeasons },
  };
  if (existsSync(runFile)) {
    const prior = JSON.parse(readFileSync(runFile, "utf8")) as Partial<HistoryRun>;
    if (prior.mode !== "history" || JSON.stringify(prior.slots) !== JSON.stringify(run.slots))
      throw new HistoryRefusal(
        "the raw directory holds a different run (mode or leagues differ) — use a fresh --raw-dir",
      );
  }
  writeFileSync(runFile, `${JSON.stringify(run)}\n`, { mode: 0o600 });
  return slots;
}

export interface HistoryRecordSummary {
  requests: number;
  notServed: { slot: string; season: number; status: number }[];
  notListed: { slot: string; season: number }[];
}

/**
 * The network half: for each season (most recent first) the season schedule when it carries box
 * scores, then per league mSettings (a 4xx = not served, recorded, never retried; a slot whose
 * previousSeasons disagree with the committed slot stops the run), mTeam + mStandings, mMatchup and
 * — for the projections slot — every final week's box score. Keyless, read host only, ≥ 1.2 s apart,
 * capped. Then the scrub (scrubHistory) unless disabled.
 */
export async function recordHistory(
  o: HistoryOptions,
  deps: HistoryDeps = {},
): Promise<HistoryRecordSummary> {
  const log = deps.log ?? ((s: string) => process.stderr.write(`record: ${s}\n`));
  const now = deps.now ?? (() => new Date());
  const summary: HistoryRecordSummary = { requests: 0, notServed: [], notListed: [] };
  if (!o.scrubOnly) {
    const planned = plannedHistoryRequests(o);
    if (planned > o.maxRequests)
      throw new HistoryRefusal(
        `this run needs up to ${String(planned)} requests, over --max-requests ${String(o.maxRequests)}`,
      );
    // every slot must have its committed anchor before the first request
    const anchors = new Map<string, Json>();
    o.leagues.forEach((_, i) => {
      const slot = LEAGUE_SLOTS[i] as string;
      anchors.set(slot, committedSettings(o.outRoot, slot));
    });
    const slots = bindHistoryRun(o);
    const client = politeClient({
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.clock ? { now: deps.clock } : {}),
      maxRequests: o.maxRequests,
      userAgent: userAgent("fixture recorder; keyless"),
    });
    for (const season of o.seasons) {
      const seasonRaw = path.join(o.rawDir, String(season));
      const withBoxes = o.projectionsSlot !== null && o.projectionSeasons.includes(season);
      let official = new Map<number, boolean>();
      if (withBoxes) {
        const [schedSpec] = seasonPlan();
        if (!schedSpec) throw new Error("no season schedule spec");
        const sched = await captureOne(client, seasonRaw, schedSpec, season, null, now, log);
        official = officialWeeks(parseJsonStrict(sched.bodyText));
      }
      for (const [slot, id] of slots) {
        const anchor = anchors.get(slot) ?? null;
        if (!(previousSeasonsOf(anchor) ?? []).includes(season)) {
          log(`${String(season)} ${slot}: not in the slot's previousSeasons — not requested`);
          summary.notListed.push({ slot, season });
          continue;
        }
        const got = await captureOrNotServed(
          client,
          seasonRaw,
          historySettingsSpec(slot),
          season,
          id,
          now,
          log,
        );
        if (!("bodyText" in got)) {
          log(`${String(season)} ${slot}: not served keylessly (HTTP ${String(got.status)})`);
          summary.notServed.push({ slot, season, status: got.status });
          continue;
        }
        const settings = parseJsonStrict(got.bodyText);
        const problem = slotBindingProblem(season, settings, anchor);
        if (problem !== null)
          throw new HistoryRefusal(
            `${String(season)} ${slot}: ${problem} — stopping before any further request`,
          );
        const weeks =
          withBoxes && slot === o.projectionsSlot ? boxScoreWeeks(settings, official) : [];
        for (const spec of historyLeagueSpecs(slot, settings, weeks))
          await captureOne(client, seasonRaw, spec, season, id, now, log);
      }
    }
    summary.requests = client.count();
    log(
      `${String(client.count())} request(s) sent this run (cap ${String(o.maxRequests)}); raw captures kept outside the repo`,
    );
  }
  if (!o.scrub) return summary;
  const result = await scrubHistory({
    rawDir: o.rawDir,
    outRoot: o.outRoot,
    prune: o.prune,
    withholdDenylisted: o.withholdDenylisted,
    log,
    ...(deps.scan ? { scan: deps.scan } : {}),
  });
  for (const [slot, l] of Object.entries(result.manifest.leagues))
    for (const [season, s] of Object.entries(l.seasons))
      log(
        s.served
          ? `${season} ${slot}: ${String(s.teams)} teams, ${String(s.seeds)} playoff seeds, finished ${String(s.finished)}, box-score weeks ${s.box_score_weeks.join(",") || "none"}, ${String(s.projection_entries)} weekly projections`
          : `${season} ${slot}: not served (HTTP ${String(s.status)})`,
      );
  return summary;
}

// --- scrub + freeze ---------------------------------------------------------------------------------

/**
 * The unit a deny-listed line withholds in a history capture: inside a box score, the ROSTER ENTRY
 * holding the line (a projection corpus loses one player-week, not a whole matchup — the golden's
 * whole-row unit in withholdUnit protects totals the history corpus does not assert); else
 * withholdUnit's unit.
 */
export function historyWithholdUnit(
  view: string,
  segs: readonly Seg[],
): { segs: Seg[]; action: "omit" | "empty" } | null {
  if (view === "mBoxscore")
    for (let k = segs.length - 2; k >= 2; k--)
      if (segs[k] === "entries" && typeof segs[k + 1] === "number" && segs[0] === "schedule")
        return { segs: segs.slice(0, k + 2), action: "omit" };
  return withholdUnit(view, segs);
}

export interface HistorySeasonServed {
  served: true;
  finished: boolean;
  format: LeagueFormat;
  teams: number;
  /** Teams of mTeam with a playoffSeed ≥ 1 (C4's target). */
  seeds: number;
  final_scoring_period: number | null;
  box_score_weeks: number[];
  /** Weekly projections (statSourceId 1, statSplitTypeId 1, that week) across the box scores. */
  projection_entries: number;
}

export interface HistorySeasonNotServed {
  served: false;
  status: number;
  error_type: string | null;
}

export type HistorySeason = HistorySeasonServed | HistorySeasonNotServed;

export interface HistoryLeague {
  /** Every previous season ESPN lists for the slot (the latest recorded season's list + itself). */
  previous_seasons: number[];
  seasons: Record<string, HistorySeason>;
  /** Listed previous seasons this run did not request (outside --seasons; pre-2018 needs leagueHistory). */
  not_attempted: number[];
}

export interface HistoryManifest {
  $comment: string;
  version: 1;
  kind: "history";
  host: string;
  captured_at: string;
  scrub_rules_version: number;
  seasons: number[];
  projections: { slot: string | null; seasons: number[] };
  leagues: Record<string, HistoryLeague>;
  files: ManifestEntry[];
  withheld_files: string[];
}

export interface HistoryScrubOptions {
  rawDir: string;
  outRoot: string;
  prune?: readonly string[];
  log?: (s: string) => void;
  scan?: (text: string, label: string) => { clean: boolean; findings: string[]; error?: string };
  dryRun?: boolean;
  maxBytes?: number;
  withholdDenylisted?: boolean;
}

export interface HistoryScrubResult {
  manifest: HistoryManifest;
  outputs: { rel: string; text: string }[];
  blanked: string[];
}

/** The season a committed history entry belongs to (its path names it). */
const seasonOfEntry = (e: ManifestEntry): number =>
  Number(/^recorded\/history\/(\d{4})\//.exec(e.path)?.[1]);

/** The season directories of a raw history run, ascending (four-digit names only). */
export function historySeasonDirs(rawDir: string): number[] {
  if (!existsSync(rawDir)) return [];
  return readdirSync(rawDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}$/.test(d.name))
    .map((d) => Number(d.name))
    .sort((a, b) => a - b);
}

const countWeeklyProjections = (body: Json, week: number): number => {
  let n = 0;
  const rows = isObject(body) && Array.isArray(body.schedule) ? body.schedule : [];
  for (const row of rows) {
    if (!isObject(row)) continue;
    for (const side of ["home", "away"]) {
      const s = row[side];
      const roster =
        isObject(s) && isObject(s.rosterForCurrentScoringPeriod)
          ? s.rosterForCurrentScoringPeriod
          : null;
      const entries = roster && Array.isArray(roster.entries) ? roster.entries : [];
      for (const e of entries) {
        const ppe = isObject(e) && isObject(e.playerPoolEntry) ? e.playerPoolEntry : null;
        const player = ppe && isObject(ppe.player) ? ppe.player : null;
        const stats = player && Array.isArray(player.stats) ? player.stats : [];
        for (const st of stats)
          if (
            isObject(st) &&
            st.statSourceId === 1 &&
            st.statSplitTypeId === 1 &&
            st.scoringPeriodId === week
          )
            n++;
      }
    }
  }
  return n;
};

/** Reassembles one response's committed body from its outputs (split parts in index order). */
function wholeOf(
  entries: readonly ManifestEntry[],
  outputs: readonly { rel: string; text: string }[],
  base: string,
): Json {
  const parts = entries
    .filter((e) => e.path === `${base}.json` || e.path.replace(/\.p\d+\.json$/, "") === base)
    .sort((a, b) => (a.part?.index ?? 0) - (b.part?.index ?? 0));
  const bodies = parts.map((e) =>
    parseJsonStrict(outputs.find((o) => o.rel === e.path)?.text ?? "null"),
  );
  const first = parts[0];
  if (first?.part == null) return bodies[0] ?? null;
  const array = first.part.array;
  if (array === "$") return bodies.flatMap((b) => (Array.isArray(b) ? b : []));
  const out: JsonObject = { ...(bodies[0] as JsonObject) };
  out[array] = bodies.flatMap((b) => (isObject(b) && Array.isArray(b[array]) ? b[array] : []));
  return out;
}

/**
 * Scrubs every capture of a raw history run (all seasons in one pass: one GUID pseudonym map per
 * slot across seasons, so a member keeps one fake GUID from season to season; the union of every
 * captured name and id applies to every file), verifies all of them like scrubRun and only then
 * writes the files and recorded/history/manifest.json — an abort leaves the repo untouched.
 */
export async function scrubHistory(opts: HistoryScrubOptions): Promise<HistoryScrubResult> {
  const log = opts.log ?? (() => undefined);
  const scan = opts.scan ?? ((t: string, l: string) => scanWithRepoScanner(t, l));
  const maxBytes = opts.maxBytes ?? MAX_FIXTURE_BYTES;
  const seasons = historySeasonDirs(opts.rawDir);
  if (!seasons.length) throw new ScrubAbort("the raw directory holds no history season");

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

  const pending: PendingCapture[] = [];
  const formats = new Map<string, LeagueFormat>(); // `${season}|${slot}`
  const settingsBodies = new Map<string, Json>();
  const matchupBodies = new Map<string, Json>();
  const notServed = new Map<string, NotServed>();
  const attempted = new Map<string, Set<number>>();
  let capturedAt = "";
  const pruned = [...new Set([...DEFAULT_PRUNE, ...(opts.prune ?? [])])].sort();

  for (const season of seasons) {
    const seasonRaw = path.join(opts.rawDir, String(season));
    for (const { slot, names } of rawInventory(seasonRaw)) {
      if (slot === "errors")
        throw new ScrubAbort(`${String(season)}: an errors/ capture has no place in a history run`);
      for (const name of names) {
        const ok = slot === "season" ? SEASON_NAMES.has(name) : LEAGUE_NAME_RE.test(name);
        if (!ok) throw new ScrubAbort(`${String(season)} ${slot}/${name}: not a history capture`);
        const env = readRaw(seasonRaw, slot, name);
        if (!env) continue;
        const m = /\/seasons\/(\d{4})(?:[/?]|$)/.exec(env.url);
        if (Number(m?.[1]) !== season)
          throw new ScrubAbort(
            `${String(season)} ${slot}/${name}: its request names another season`,
          );
        if (slot !== "season") {
          const set = attempted.get(slot) ?? new Set<number>();
          set.add(season);
          attempted.set(slot, set);
        }
        if (env.status !== 200) {
          if (name === "mSettings" && env.status >= 400 && env.status < 500) {
            notServed.set(`${String(season)}|${slot}`, {
              status: env.status,
              error_type: errorTypeOf(env.bodyText),
            });
            continue;
          }
          throw new ScrubAbort(
            `${String(season)} ${slot}/${name}: HTTP ${String(env.status)} where 200 was required`,
          );
        }
        if (env.recorded_at > capturedAt) capturedAt = env.recorded_at;
        let raw: Json;
        try {
          raw = parseJsonStrict(env.bodyText);
        } catch (e) {
          throw new ScrubAbort(
            `${String(season)} ${slot}/${name}: body is not usable JSON (${e instanceof Error ? e.message : String(e)})`,
          );
        }
        const isLeague = env.kind === "league";
        const scrubbed = scrubBody(raw, env.kind, ctxOf(slot), { prune: isLeague ? pruned : [] });
        const key = `${String(season)}|${slot}`;
        if (isLeague && name === "mSettings") {
          formats.set(key, leagueFormat(raw));
          settingsBodies.set(key, scrubbed);
        }
        pending.push({
          env,
          base: `${HISTORY_REL}/${String(season)}/${slot}/${name}`,
          season,
          scrubbed,
          rawCanonical: canonicalize(raw),
          pruned: isLeague ? pruned : [],
          format: null,
        });
      }
    }
  }
  for (const p of pending) {
    const key = `${String(p.season)}|${p.env.slot}`;
    if (p.env.kind === "league") {
      const f = formats.get(key);
      if (!f)
        throw new ScrubAbort(`${key.replace("|", " ")}: captures without that season's mSettings`);
      p.format = f;
    }
  }

  const unionTerms = new Set<string>();
  const unionIds = new Set<string>();
  for (const c of contexts.values()) {
    for (const t of c.denyTerms) unionTerms.add(t);
    for (const id of c.realLeagueIds) unionIds.add(id);
  }
  const frozen = await freezeCaptures(pending, {
    scan,
    maxBytes,
    withholdDenylisted: opts.withholdDenylisted === true,
    log,
    verifyCtxOf: (slot) => ({ ...ctxOf(slot), denyTerms: unionTerms, realLeagueIds: unionIds }),
    unitOf: historyWithholdUnit,
  });
  const { outputs, entries, problems, withheldFiles } = frozen;
  if (problems.length)
    throw new ScrubAbort(`refusing to write: ${String(problems.length)} problem(s)`, problems);

  // per league: the served seasons' summaries (value-free counts) and the not-served ones
  for (const e of entries) {
    if (e.views[0] !== "mMatchup" || e.league === null) continue;
    const season = seasonOfEntry(e);
    matchupBodies.set(
      `${String(season)}|${e.league}`,
      wholeOf(entries, outputs, e.path.replace(/(?:\.p\d+)?\.json$/, "")),
    );
  }
  const leagues: Record<string, HistoryLeague> = {};
  for (const slot of [...attempted.keys()].sort()) {
    const seasonsOut: Record<string, HistorySeason> = {};
    let latestPrev: number[] = [];
    for (const season of [...(attempted.get(slot) ?? [])].sort((a, b) => a - b)) {
      const key = `${String(season)}|${slot}`;
      const ns = notServed.get(key);
      if (ns) {
        seasonsOut[String(season)] = {
          served: false,
          status: ns.status,
          error_type: ns.error_type,
        };
        continue;
      }
      const settings = settingsBodies.get(key) ?? null;
      const format = formats.get(key);
      if (!format || settings === null) continue;
      const prev = previousSeasonsOf(settings) ?? [];
      latestPrev = [...new Set([...prev, season])].sort((a, b) => a - b);
      const teamsBase = `${HISTORY_REL}/${String(season)}/${slot}/mTeam`;
      const teamBody = entries.some((x) => x.path.startsWith(`${teamsBase}.`))
        ? wholeOf(entries, outputs, teamsBase)
        : null;
      const teams = isObject(teamBody) && Array.isArray(teamBody.teams) ? teamBody.teams : [];
      const seeds = teams.filter(
        (t) => isObject(t) && typeof t.playoffSeed === "number" && t.playoffSeed >= 1,
      ).length;
      const status = isObject(settings) && isObject(settings.status) ? settings.status : {};
      const boxes = entries
        .filter(
          (x) =>
            x.league === slot &&
            x.views[0] === "mBoxscore" &&
            x.path.startsWith(`${HISTORY_REL}/${String(season)}/`),
        )
        .map((x) => x.scoringPeriodId)
        .filter((w): w is number => w !== null);
      const weeks = [...new Set(boxes)].sort((a, b) => a - b);
      let projections = 0;
      for (const w of weeks)
        projections += countWeeklyProjections(
          wholeOf(
            entries,
            outputs,
            `${HISTORY_REL}/${String(season)}/${slot}/mBoxscore.sp${String(w)}`,
          ),
          w,
        );
      seasonsOut[String(season)] = {
        served: true,
        finished: seasonFinished(settings, matchupBodies.get(key) ?? null).finished,
        format,
        teams: format.teams,
        seeds,
        final_scoring_period:
          typeof status.finalScoringPeriod === "number" ? status.finalScoringPeriod : null,
        box_score_weeks: weeks,
        projection_entries: projections,
      };
    }
    const tried = attempted.get(slot) ?? new Set<number>();
    leagues[slot] = {
      previous_seasons: latestPrev,
      seasons: seasonsOut,
      not_attempted: latestPrev.filter((s) => !tried.has(s)),
    };
  }
  // the projections are what the box scores hold (never a claim read back from the raw dir)
  const boxSlots = [
    ...new Set(entries.filter((e) => e.views[0] === "mBoxscore").map((e) => e.league)),
  ];
  if (boxSlots.length > 1 || boxSlots.includes(null))
    throw new ScrubAbort("box scores of more than one league slot in one history run");
  const boxSeasons = [
    ...new Set(entries.filter((e) => e.views[0] === "mBoxscore").map((e) => seasonOfEntry(e))),
  ].sort((a, b) => a - b);
  const manifest: HistoryManifest = {
    $comment:
      "Recorded ESPN fixtures of the probe leagues' finished PREVIOUS seasons (evidence, plan 05 §3 fixture law; plan 10 §3.3 C1/C3/C4 inputs): keyless captures, scrubbed by scripts/record-fixture.ts --history (research 03 §F.3), one GUID pseudonym map per league across seasons. `files[]` has the shape of fixtures/espn/manifest.json's entries (paths relative to fixtures/espn; sha256 = sha256 of the canonical JSON of the scrubbed body; scoring.sha256 over every scoring field, computed on the raw recording and re-verified on the scrubbed file; `withheld` lists units removed because a line of theirs matched the local deny-list — in a box score the roster entry, never a value). `leagues[slot].seasons[season]` summarises each attempted season value-free (served or the typed 4xx; finished; teams; playoff seeds; box-score weeks; weekly projections = statSourceId 1, statSplitTypeId 1); `not_attempted` lists the previous seasons ESPN lists that this run did not request. Kept apart from fixtures/espn/manifest.json, whose hash the drift entity manifest binds. No league id, team name or member name of any recorded league is stored anywhere in this repo.",
    version: 1,
    kind: "history",
    host: READ_HOST,
    captured_at: capturedAt,
    scrub_rules_version: SCRUB_RULES_VERSION,
    seasons: [...new Set(seasons)].sort((a, b) => a - b),
    projections: { slot: boxSlots[0] ?? null, seasons: boxSeasons },
    leagues,
    files: entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    withheld_files: withheldFiles.sort(),
  };
  // the manifest lives under recorded/, where prettier resolves the recorded profile (printWidth 1000)
  const manifestText = await formatJson(manifest as unknown as Json, "recorded");
  const mScan = scan(manifestText, HISTORY_MANIFEST_REL);
  if (!mScan.clean)
    throw new ScrubAbort(
      "refusing to write: the repo scanner refused the history manifest",
      annotateFindings(mScan.findings, manifestText),
    );
  if (!opts.dryRun) {
    for (const o of outputs) {
      const file = path.join(opts.outRoot, o.rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, o.text);
    }
    writeFileSync(path.join(opts.outRoot, HISTORY_MANIFEST_REL), manifestText);
    log(
      `wrote ${String(outputs.length)} history fixture(s) and ${HISTORY_MANIFEST_REL} under ${opts.outRoot}`,
    );
  }
  outputs.push({ rel: HISTORY_MANIFEST_REL, text: manifestText });
  const blanked = [...new Set([...contexts.values()].flatMap((c) => [...c.blanked]))].sort();
  return { manifest, outputs, blanked };
}
