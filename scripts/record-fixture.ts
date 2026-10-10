#!/usr/bin/env -S npx tsx
// record-fixture.ts — the keyless recording of public probe leagues: plan 05 §3.1 step 1 (`--public`:
// mSettings, mTeam+mStandings, mRoster, mMatchup, ≥ 3 final mBoxscore weeks; raw JSON + status +
// headers OUTSIDE the repo), plan 10 §3.0 Z7 and §3.1a/b (the recorded evidence of the 1a golden;
// ADV OBJ-01, OBJ-21; the B1 views: mMatchupScore current + final, solo mNav, kona_player_info and
// kona_playercard by filterIds, players_wl, the keyless 401), research 03 §D.3 (polite usage). Then
// it scrubs (scrub-fixture.ts). `--history` records the finished previous seasons instead (plan 10
// §3.3 C1/C3/C4 inputs; scripts/espn-fixture/history.ts).
//
// Usage:
//   EFF_PROBE_LEAGUE_IDS=<id>,<id>,… scripts/dev/with-node.sh npx tsx scripts/record-fixture.ts --public
//       [--season <year>] [--weeks 1,2,3] [--raw-dir <dir outside the repo>] [--out <fixtures/espn>]
//       [--max-requests <n ≤ 80>] [--kona-limit <n ≤ 50>] [--prune <key,…>] [--no-scrub]
//       [--withhold-denylisted]  (see scrub-fixture.ts)
//   League ids come from EFF_PROBE_LEAGUE_IDS (or --league <id>, repeatable); they map in order to
//   league-a, league-b, … and are NEVER written into the repo or printed. No cookie is ever sent:
//   the run refuses to start if any cookie variable or argument is present. A re-run reuses stored
//   raw captures (no request is repeated). Exit: 0 ok · 1 error · 2 usage/refused.
//
//   EFF_PROBE_LEAGUE_IDS=<id>,<id>,… scripts/dev/with-node.sh npx tsx scripts/record-fixture.ts --public
//       --history [--seasons 2025,2024,2023] [--projections <slot>|none] [--projection-seasons 2025,2024]
//       [--raw-dir <dir outside the repo>] [--out <fixtures/espn>] [--max-requests <n ≤ 90>]
//       [--prune <key,…>] [--no-scrub | --scrub-only] [--withhold-denylisted]
//   The finished previous seasons (default: the three before the current one) of every league:
//   mSettings, mTeam + mStandings, mMatchup, and every final week's mBoxscore (ESPN's weekly
//   projections) for the projections slot (default league-b) in the projection seasons (default the
//   two most recent). Each slot is bound to the committed current-season fixture by its
//   previousSeasons; a season ESPN does not serve keylessly is recorded as such, never retried.
//   Output: fixtures/espn/recorded/history/<season>/<slot>/ + recorded/history/manifest.json.
//   --scrub-only re-scrubs a stored raw run (no network, no league id needed).
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseJsonStrict } from "./espn-fixture/canonical.js";
import { findCookieMaterial, rawDirRefusal } from "./espn-fixture/guards.js";
import {
  REPO_ROOT,
  defaultSeason,
  isLeagueId,
  isSeason,
  politeClient,
  userAgent,
  type FetchLike,
} from "./espn-fixture/http.js";
import {
  KONA_FILTER_DEFAULT_LIMIT,
  LEAGUE_SLOTS,
  captureOne,
  cardIds,
  cardPlan,
  errorPlan,
  leaguePlan,
  officialWeeks,
  scrubRun,
  seasonPlan,
  type RequestSpec,
} from "./espn-fixture/pipeline.js";
import { HistoryRefusal, parseHistoryArgs, recordHistory } from "./espn-fixture/history.js";
import { ScrubAbort } from "./espn-fixture/scrub.js";

/** The most requests one run may ever send (the B1 recording brief: ≤ 80). */
export const HARD_REQUEST_CAP = 80;
/** The default cap: a three-league run with three weeks needs 53. */
export const DEFAULT_MAX_REQUESTS = 60;

export interface RecordDeps {
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic milliseconds for request spacing (tests); defaults to Date.now. */
  clock?: () => number;
  log?: (s: string) => void;
  /** Injected scanner (tests); defaults to the repo scanner. */
  scan?: (text: string, label: string) => { clean: boolean; findings: string[]; error?: string };
}

export interface RecordOptions {
  season: number;
  leagues: string[];
  weeks: number[];
  rawDir: string;
  outRoot: string;
  maxRequests: number;
  konaLimit: number;
  prune: string[];
  scrub: boolean;
  withholdDenylisted: boolean;
}

export class Refusal extends Error {}

/** Parses and validates arguments; throws Refusal (exit 2) — including on any cookie material. */
export function parseArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  now: Date,
): RecordOptions {
  const cookies = findCookieMaterial(env, argv);
  if (cookies.length)
    throw new Refusal(
      `refusing to run: cookie material is present (${cookies.join(", ")}). The recorder is keyless — unset it and re-run.`,
    );
  if (!argv.includes("--public"))
    throw new Refusal("only --public (keyless) recording exists in Phase 0");
  let season: number | null = null;
  let weeks = [1, 2, 3];
  let rawDir: string | null = null;
  let outRoot = path.join(REPO_ROOT, "fixtures", "espn");
  let maxRequests = DEFAULT_MAX_REQUESTS;
  let konaLimit = KONA_FILTER_DEFAULT_LIMIT;
  let prune: string[] = [];
  let scrub = true;
  let withholdDenylisted = false;
  const leagues: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Refusal(`${String(a)} needs a value`);
      return v;
    };
    switch (a) {
      case "--public":
        break;
      case "--season":
        season = Number(val());
        if (!isSeason(season)) throw new Refusal("--season needs a year from 2018");
        break;
      case "--weeks":
        weeks = val()
          .split(",")
          .map((w) => Number(w.trim()));
        if (
          !weeks.length ||
          weeks.some((w) => !Number.isInteger(w) || w < 1 || w > 18) ||
          new Set(weeks).size !== weeks.length
        )
          throw new Refusal("--weeks needs distinct scoring periods 1–18");
        break;
      case "--raw-dir":
        rawDir = path.resolve(val());
        break;
      case "--out":
        outRoot = path.resolve(val());
        break;
      case "--max-requests":
        maxRequests = Number(val());
        if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > HARD_REQUEST_CAP)
          throw new Refusal(`--max-requests must be 1–${String(HARD_REQUEST_CAP)}`);
        break;
      case "--kona-limit":
        konaLimit = Number(val());
        if (!Number.isInteger(konaLimit) || konaLimit < 1 || konaLimit > 50)
          throw new Refusal("--kona-limit must be 1–50");
        break;
      case "--prune":
        prune = val()
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean);
        if (prune.some((k) => !/^[A-Za-z_]\w{0,63}$/.test(k)))
          throw new Refusal("--prune takes key names");
        break;
      case "--no-scrub":
        scrub = false;
        break;
      case "--withhold-denylisted":
        withholdDenylisted = true;
        break;
      case "--league": {
        const id = val();
        if (!isLeagueId(id)) throw new Refusal("--league needs a positive integer id");
        leagues.push(id);
        break;
      }
      default:
        throw new Refusal(`unknown argument #${String(i + 1)}`);
    }
  }
  if (!leagues.length) {
    const fromEnv = (env.EFF_PROBE_LEAGUE_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (fromEnv.some((id) => !isLeagueId(id)))
      throw new Refusal("EFF_PROBE_LEAGUE_IDS must be comma-separated positive integers");
    leagues.push(...fromEnv);
  }
  if (!leagues.length)
    throw new Refusal("no league: set EFF_PROBE_LEAGUE_IDS (comma-separated public league ids)");
  if (new Set(leagues).size !== leagues.length) throw new Refusal("a league id is given twice");
  if (leagues.length > LEAGUE_SLOTS.length)
    throw new Refusal(`at most ${String(LEAGUE_SLOTS.length)} leagues per run`);
  const resolvedSeason = season ?? (env.ESPN_SEASON ? Number(env.ESPN_SEASON) : defaultSeason(now));
  if (!isSeason(resolvedSeason)) throw new Refusal("ESPN_SEASON must be a year from 2018");
  const raw =
    rawDir ??
    path.join(
      homedir(),
      ".cache",
      "espn-fantasy-football-mcp",
      "recordings",
      now.toISOString().slice(0, 10),
    );
  if (rawDirRefusal(raw, REPO_ROOT) !== null)
    throw new Refusal(
      "the raw directory must be OUTSIDE the repository and outside any git working tree (raw captures hold real names and ids)",
    );
  return {
    season: resolvedSeason,
    leagues,
    weeks,
    rawDir: raw,
    outRoot,
    maxRequests,
    konaLimit,
    prune,
    scrub,
    withholdDenylisted,
  };
}

/** Requests a run will make at most (the plan is checked against the cap before the first request). */
export function plannedRequests(o: RecordOptions): number {
  const perLeague =
    1 /* mSettings */ +
    2 /* mTeam, mMatchup */ +
    2 * o.weeks.length /* mRoster, mBoxscore */ +
    1 /* kona page */ +
    2 /* mMatchupScore current + final */ +
    1 /* mNav */ +
    2; /* kona_player_info + kona_playercard by filterIds */
  return (
    seasonPlan().length + errorPlan().length + o.leagues.length * perLeague + 2
  ); /* probe extras, first league */
}

/** The run's slot → league id map, stored in the raw dir (outside the repo) so a resume cannot mix leagues. */
function bindSlots(o: RecordOptions): Map<string, string> {
  const slots = new Map<string, string>();
  o.leagues.forEach((id, i) => slots.set(LEAGUE_SLOTS[i] as string, id));
  mkdirSync(o.rawDir, { recursive: true, mode: 0o700 });
  const runFile = path.join(o.rawDir, "run.json");
  const run = { season: o.season, slots: Object.fromEntries(slots) };
  if (existsSync(runFile)) {
    const prior = JSON.parse(readFileSync(runFile, "utf8")) as typeof run;
    if (prior.season !== run.season || JSON.stringify(prior.slots) !== JSON.stringify(run.slots))
      throw new Refusal(
        "the raw directory holds a different run (season or leagues differ) — use a fresh --raw-dir",
      );
  } else writeFileSync(runFile, `${JSON.stringify(run)}\n`, { mode: 0o600 });
  return slots;
}

export async function record(o: RecordOptions, deps: RecordDeps = {}): Promise<void> {
  const log = deps.log ?? ((s: string) => process.stderr.write(`record: ${s}\n`));
  const now = deps.now ?? (() => new Date());
  const planned = plannedRequests(o);
  if (planned > o.maxRequests)
    throw new Refusal(
      `this run needs up to ${String(planned)} requests, over --max-requests ${String(o.maxRequests)}`,
    );
  const slots = bindSlots(o);
  const client = politeClient({
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.clock ? { now: deps.clock } : {}),
    maxRequests: o.maxRequests,
    userAgent: userAgent("fixture recorder; keyless"),
  });
  const first = o.leagues[0] ?? "";

  // 1. season-level captures (no league id)
  const season = new Map<string, string>();
  for (const spec of seasonPlan()) {
    const env = await captureOne(client, o.rawDir, spec, o.season, null, now, log);
    season.set(spec.name, env.bodyText);
  }
  const official = officialWeeks(parseJsonStrict(season.get("proTeamSchedules_wl") ?? "null"));

  // 2. each league: mSettings first (matchup periods, current week), then the rest
  for (const [slot, id] of slots) {
    const settingsSpec: RequestSpec = {
      slot,
      name: "mSettings",
      kind: "league",
      route: "league",
      views: ["mSettings"],
      params: {},
      filter: null,
      expect: "ok",
    };
    const settingsEnv = await captureOne(client, o.rawDir, settingsSpec, o.season, id, now, log);
    const settings = parseJsonStrict(settingsEnv.bodyText);
    const bodies = new Map<string, string>();
    for (const spec of leaguePlan(slot, settings, official, o.weeks, {
      probeExtras: id === first,
      konaLimit: o.konaLimit,
    }))
      bodies.set(
        spec.name,
        (await captureOne(client, o.rawDir, spec, o.season, id, now, log)).bodyText,
      );
    // the filterIds captures: ids spread over the last recorded week's roster + the kona page
    const ids = cardIds(
      parseJsonStrict(bodies.get(`mRoster.sp${String(Math.max(...o.weeks))}`) ?? "null"),
      parseJsonStrict(bodies.get("kona_player_info") ?? "null"),
    );
    for (const spec of cardPlan(slot, ids, settings, o.season))
      await captureOne(client, o.rawDir, spec, o.season, id, now, log);
  }

  // 3. the recorded error bodies (league 0 for the 404; the first league for the 400 and the 401)
  const [notFound, missingSort, notVisible] = errorPlan() as [
    RequestSpec,
    RequestSpec,
    RequestSpec,
  ];
  await captureOne(client, o.rawDir, notFound, o.season, "0", now, log);
  await captureOne(client, o.rawDir, missingSort, o.season, first, now, log);
  await captureOne(client, o.rawDir, notVisible, o.season, first, now, log);
  log(
    `${String(client.count())} request(s) sent this run (cap ${String(o.maxRequests)}); raw captures kept outside the repo`,
  );

  if (!o.scrub) return;
  const result = await scrubRun({
    rawDir: o.rawDir,
    outRoot: o.outRoot,
    prune: o.prune,
    withholdDenylisted: o.withholdDenylisted,
    log,
    ...(deps.scan ? { scan: deps.scan } : {}),
  });
  if (result.blanked.length) log(`blanked unknown free-text fields: ${result.blanked.join(", ")}`);
  for (const [slot, l] of Object.entries(result.manifest.leagues))
    log(
      `${slot}: ${String(l.format.teams)} teams, PPR ${String(l.format.reception_points)}, pass TD ${String(l.format.pass_td_points)}, ${l.format.waivers}, ${String(l.format.flex_slots)} FLEX, final box-score weeks ${l.final_boxscore_weeks.join(",")}`,
    );
}

/** `--history`: the finished previous seasons (scripts/espn-fixture/history.ts). */
export async function mainHistory(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  now: Date,
): Promise<number> {
  let o;
  try {
    o = parseHistoryArgs(argv, env, now);
  } catch (e) {
    process.stderr.write(`record: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  try {
    await recordHistory(o);
    return 0;
  } catch (e) {
    process.stderr.write(`record: ${e instanceof Error ? e.message : String(e)}\n`);
    if (e instanceof ScrubAbort) for (const w of e.where) process.stderr.write(`  ${w}\n`);
    return e instanceof HistoryRefusal ? 2 : 1;
  }
}

async function main(): Promise<void> {
  if (process.argv.slice(2).includes("--history")) {
    process.exitCode = await mainHistory(process.argv.slice(2), process.env, new Date());
    return;
  }
  let opts: RecordOptions;
  try {
    opts = parseArgs(process.argv.slice(2), process.env, new Date());
  } catch (e) {
    process.stderr.write(`record: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    await record(opts);
  } catch (e) {
    process.stderr.write(`record: ${e instanceof Error ? e.message : String(e)}\n`);
    if (e instanceof ScrubAbort) for (const w of e.where) process.stderr.write(`  ${w}\n`);
    process.exitCode = e instanceof Refusal ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  void main();
