// refresh.ts — `eff refresh <job|source|all>` (plan 01 §5.5 refresh execution model, §5.7; plan 06
// J3 file-release polls, §1.3 the data-refresh rows, §2 season awareness / per-job lock /
// notifications; plan 10 §3.1a "Jobs"). Builds ONE http client (src/http, the read host from config),
// opens the store (refresh_log, the pro-schedule reader the season gate needs, nflverse schedules
// for retractable roofs) and a DatasetPublisher, then runs each source through src/sources/runner.ts
// in order (schedules first, so weather sees this run's schedule); a publish of `nflverse:daily` or
// `espn:players` chains the crosswalk rebuild. Exit 0 when every source published, was unchanged or
// skipped; 1 when any failed. Fixture mode makes no network call, so it refuses (decision recorded).
// Ported from sibling @5daa625, adapted (ESPN jobs, the players source, the chained rebuild).
import { randomInt } from "node:crypto";
import type { DatasetSourceId, RefreshJob } from "../config/freshness.js";
import {
  datasetDir,
  ensureSecureDir,
  PathSecurityError,
  runTempDir,
  storePath,
} from "../config/paths.js";
import type { LenientConfig } from "../config/schema.js";
import { MAX_SEED, seededRng } from "../domain/clock.js";
import { createHttpClient } from "../http/client.js";
import { NFLVERSE_SOURCES } from "../sources/nflverse/index.js";
import { fsTempArea, isRefreshSuccess, runRefresh, type RefreshResult } from "../sources/runner.js";
import type { DataSource } from "../sources/source.js";
import { weatherSourceFor } from "../sources/weather/index.js";
import { espnSeasonSources } from "../sources/espn_season/index.js";
import { ESPN_READ_HOST_DEFAULT } from "../config/schema.js";
import { seasonGet } from "./espn-http.js";
import type { ProScheduleReader } from "../domain/analytics/types.js";
import { storeFactory } from "../store/index.js";
import type { StoreFactory } from "../store/types.js";
import { runCrosswalkRebuild } from "./crosswalk.js";
import { EXIT, UsageError } from "./exit.js";
import { writeLine, type CliIo } from "./io.js";
import type { Logger } from "./log.js";
import { createNotifier } from "./notify.js";
import { errorText, openStore } from "./store-access.js";

/** The Phase-1a refresh jobs (plan 06 §1.3; plan 10 §3.1a "Jobs"). */
export const REFRESH_JOBS_1A = [
  "espn:schedule",
  "espn:players",
  "nflverse:schedules",
  "nflverse:daily",
  "nflverse:stats",
  "weather",
] as const satisfies readonly RefreshJob[];
/** The individual nflverse sources a target may name. */
export const SOURCE_TARGETS = [
  "nflverse:schedules",
  "nflverse:injuries",
  "nflverse:roster_weekly",
  "nflverse:players",
  "nflverse:stats_player_week",
] as const satisfies readonly DatasetSourceId[];
/** Every `eff refresh` target. */
export const REFRESH_TARGETS = ["all", ...REFRESH_JOBS_1A, ...SOURCE_TARGETS] as const;
export type RefreshTarget = (typeof REFRESH_TARGETS)[number];

/** Whether `s` is a refresh target. */
export function isRefreshTarget(s: string): s is RefreshTarget {
  return (REFRESH_TARGETS as readonly string[]).includes(s);
}

/**
 * The DataSources this build ships, per refresh job (the two keyless ESPN season sources —
 * `espn:pro_schedule`, `espn:players`, src/sources/espn_season/ — over the configured read host). A
 * job with no source reports `not available in this build`.
 */
export interface SourceRegistry {
  readonly byJob: (job: RefreshJob, config: RegistryConfig) => readonly DataSource[] | null;
}

/** What the registry reads of the config. */
export type RegistryConfig = Pick<LenientConfig, "weatherSource"> &
  Partial<Pick<LenientConfig, "espnReadHost">>;

/** The registry of this build. */
export const DEFAULT_REGISTRY: SourceRegistry = {
  byJob: (job, config) => {
    const S = NFLVERSE_SOURCES;
    switch (job) {
      case "espn:schedule":
        return [espnSeasonSources(config.espnReadHost ?? ESPN_READ_HOST_DEFAULT).proSchedule];
      case "espn:players":
        return [espnSeasonSources(config.espnReadHost ?? ESPN_READ_HOST_DEFAULT).players];
      case "nflverse:schedules":
        return [S["nflverse:schedules"]];
      case "nflverse:daily":
        return [S["nflverse:injuries"], S["nflverse:roster_weekly"], S["nflverse:players"]];
      case "nflverse:stats":
        return [S["nflverse:stats_player_week"]];
      case "weather":
        return [weatherSourceFor(config.weatherSource)];
      default:
        return null;
    }
  },
};

/** The refresh jobs whose sources this build ships. */
export function availableRefreshJobs(registry: SourceRegistry = DEFAULT_REGISTRY): RefreshJob[] {
  return REFRESH_JOBS_1A.filter((j) => registry.byJob(j, { weatherSource: "open-meteo" }) !== null);
}

/** One planned step: a source to run, or a job this build cannot run. */
export type PlannedStep =
  | { readonly kind: "source"; readonly job: RefreshJob; readonly source: DataSource }
  | { readonly kind: "unavailable"; readonly job: RefreshJob };

/** The ordered steps of a target (the season sources first, then schedules, so weather sees them). */
export function planTarget(
  target: RefreshTarget,
  config: RegistryConfig,
  registry: SourceRegistry = DEFAULT_REGISTRY,
): PlannedStep[] {
  const ofJob = (job: RefreshJob): PlannedStep[] => {
    const list = registry.byJob(job, config);
    return list === null
      ? [{ kind: "unavailable", job }]
      : list.map((source) => ({ kind: "source", job, source }));
  };
  if (target === "all") return REFRESH_JOBS_1A.flatMap(ofJob);
  if ((REFRESH_JOBS_1A as readonly string[]).includes(target)) return ofJob(target as RefreshJob);
  const id = target as (typeof SOURCE_TARGETS)[number];
  const job: RefreshJob =
    id === "nflverse:schedules"
      ? "nflverse:schedules"
      : id === "nflverse:stats_player_week"
        ? "nflverse:stats"
        : "nflverse:daily";
  return [{ kind: "source", job, source: NFLVERSE_SOURCES[id] }];
}

/** Default seasons per source: stats and schedules carry the previous season too (E1's window). */
export function defaultSeasons(source: DataSource, season: number): number[] {
  return source.id === "nflverse:stats_player_week" || source.id === "nflverse:schedules"
    ? [season - 1, season]
    : [season];
}

/** Parses `--seasons 2025,2026` (1999–2100, ascending, de-duplicated, at most 30). */
export function parseSeasons(spec: string): number[] {
  const parts = spec
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (parts.length === 0 || parts.length > 30)
    throw new UsageError("--seasons takes 1-30 comma-separated years");
  const out = new Set<number>();
  for (const p of parts) {
    if (!/^[0-9]{4}$/.test(p)) throw new UsageError("--seasons: each season is a 4-digit year");
    const n = Number(p);
    if (n < 1999 || n > 2100) throw new UsageError("--seasons: each season must be 1999-2100");
    out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The coming week for weather (plan 06 §1.3 "outdoor games of the coming week"): the week of the
 * first game that kicks off at or after now; null when the schedule was never loaded or has none.
 */
export function comingWeek(
  schedule: ProScheduleReader,
  season: number,
  nowMs: number,
): number | null {
  let best: { at: number; week: number } | null = null;
  try {
    for (const g of schedule.games(season, null).rows) {
      if (g.kickoff === null || g.start_time_tbd) continue;
      const k = Date.parse(g.kickoff);
      if (!Number.isFinite(k) || k < nowMs) continue;
      if (best === null || k < best.at) best = { at: k, week: g.week };
    }
  } catch {
    return null;
  }
  return best?.week ?? null;
}

/** Most warning lines printed under one result; the rest are counted. */
export const MAX_WARNING_LINES = 5;
/** Longest warning line printed. */
export const WARNING_LINE_MAX = 200;
const UNPRINTABLE_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}]+/gu;

/** The warnings behind a published result, terminal-safe and capped. */
export function describeWarnings(r: RefreshResult): string[] {
  if (r.status !== "published") return [];
  const out = r.warnings.slice(0, MAX_WARNING_LINES).map((w) => {
    const clean = w.replace(UNPRINTABLE_RE, " ").trim();
    const capped =
      clean.length > WARNING_LINE_MAX
        ? `${clean.slice(0, WARNING_LINE_MAX - 1).replace(/[\uD800-\uDBFF]$/, "")}…`
        : clean;
    return `  warning: ${capped}`;
  });
  const more = r.warnings.length - MAX_WARNING_LINES;
  if (more > 0) out.push(`  warning: … ${String(more)} more`);
  return out;
}

/** One line per result for the terminal. */
export function describeResult(r: RefreshResult): string {
  const id = r.source.padEnd(28);
  switch (r.status) {
    case "published": {
      const n = r.warnings.length;
      const w = n === 0 ? "" : `  (${String(n)} warning${n === 1 ? "" : "s"}, below)`;
      return `${id} published  version ${r.file_version}  ${String(r.stats.rows)} rows${w}`;
    }
    case "unchanged":
      return `${id} unchanged  version ${r.version.version}`;
    case "skipped":
      return `${id} skipped    ${r.reason}`;
    case "failed":
      return `${id} FAILED     ${r.source_error}: ${r.message}`;
  }
}

/** A JSON-safe summary of a result (fixed fields only; no upstream text). */
export function resultJson(r: RefreshResult): Record<string, unknown> {
  switch (r.status) {
    case "published":
      return {
        source: r.source,
        status: r.status,
        file_version: r.file_version,
        rows: r.stats.rows,
        seasons: r.stats.seasons,
        attempts: r.attempts,
        warnings: r.warnings.length,
      };
    case "unchanged":
      return {
        source: r.source,
        status: r.status,
        version: r.version.version,
        attempts: r.attempts,
      };
    case "skipped":
      return { source: r.source, status: r.status, reason: r.reason };
    case "failed":
      return {
        source: r.source,
        status: r.status,
        error: r.source_error,
        message: r.message,
        attempts: r.attempts,
      };
  }
}

/** The notification job name of a target. */
export function jobNameFor(target: RefreshTarget): string {
  return `refresh-${target.replace(":", "-")}`;
}

/** Options of one `eff refresh` run. */
export interface RefreshOptions {
  readonly target: string | undefined;
  readonly seasons?: string | undefined;
  readonly force: boolean;
  readonly notify: boolean;
  readonly json: boolean;
  /** Test hooks (never reachable from argv). */
  readonly factory?: StoreFactory;
  readonly registry?: SourceRegistry;
}

/** `eff refresh`. */
export async function refresh(
  io: CliIo,
  config: LenientConfig,
  log: Logger,
  opts: RefreshOptions,
  signal: AbortSignal,
): Promise<number> {
  const target = opts.target;
  if (target === undefined || !isRefreshTarget(target))
    throw new UsageError(`refresh needs a target: ${REFRESH_TARGETS.join(" | ")}`);
  if (config.fixtureDir !== null) {
    await writeLine(
      io.stderr,
      "eff refresh: fixture mode (EFF_FIXTURE_DIR) serves recorded ESPN views only; refresh needs the network — unset EFF_FIXTURE_DIR",
    );
    return EXIT.usage;
  }
  const seasonsOverride = opts.seasons === undefined ? null : parseSeasons(opts.seasons);
  const registry = opts.registry ?? DEFAULT_REGISTRY;
  const steps = planTarget(target, config, registry);
  const notifier = createNotifier({
    platform: io.platform,
    exec: io.exec,
    clock: io.clock,
    cacheDir: config.cacheDir,
  });
  const job = jobNameFor(target);

  const factory = opts.factory ?? storeFactory;
  let store;
  let publisher;
  try {
    store = openStore(config, io.clock, log, { migrate: true, factory });
    publisher = factory.openPublisher({
      storePath: storePath(config.cacheDir),
      datasetDir: datasetDir(config.cacheDir),
      clock: io.clock,
    });
  } catch (e) {
    store?.close();
    await writeLine(io.stderr, `eff refresh: the store could not be opened: ${errorText(e)}`);
    if (opts.notify) await notifier.failure(job, "store");
    return EXIT.error;
  }

  const http = createHttpClient({
    ...(io.fetch === null ? {} : { fetch: io.fetch }),
    espnReadHost: config.espnReadHost,
    log,
  });
  const rng = seededRng(randomInt(0, MAX_SEED));
  const tmpDir = runTempDir(config.cacheDir);
  try {
    ensureSecureDir(tmpDir, { create: true, what: "run temp directory" });
  } catch (e) {
    publisher.close();
    store.close();
    await writeLine(
      io.stderr,
      `eff refresh: ${e instanceof PathSecurityError ? `${e.name}: ${e.message}` : errorText(e)}`,
    );
    if (opts.notify) await notifier.failure(job, "temp_dir");
    return EXIT.error;
  }
  const temp = fsTempArea(tmpDir);
  // the keyless ESPN season views go through the cross-process limiter (the jobs' keyless cap,
  // plan 06 §1.4): one row per request, its outcome recorded — like every other ESPN request
  const espnGet = seasonGet({
    http,
    limiter: store.repos.limiter,
    clock: io.clock,
    origin: "job",
  });
  const results: RefreshResult[] = [];
  const lines: string[] = [];
  const unavailable: RefreshJob[] = [];
  let chainCrosswalk = false;
  try {
    for (const step of steps) {
      if (step.kind === "unavailable") {
        unavailable.push(step.job);
        lines.push(`${step.job.padEnd(28)} skipped    not available in this build`);
        continue;
      }
      store.reopenChangedDatasets();
      const week =
        step.source.job === "weather"
          ? comingWeek(store.datasets.proSchedule, config.season, io.clock.nowMs())
          : null;
      const r = await runRefresh(
        {
          source: step.source,
          seasons: seasonsOverride ?? defaultSeasons(step.source, config.season),
          week,
          signal,
          ...(opts.force ? { force: true } : {}),
        },
        {
          http: step.source.id.startsWith("espn:") ? espnGet : http.get,
          download: http.download,
          clock: io.clock,
          rng,
          publisher,
          refreshLog: store.repos.refreshLog,
          proSchedule: store.datasets.proSchedule,
          nflGames: store.datasets.nflGames,
          temp,
          log,
        },
      );
      results.push(r);
      lines.push(describeResult(r), ...describeWarnings(r));
      if (
        r.status === "published" &&
        (step.job === "nflverse:daily" || step.job === "espn:players")
      )
        chainCrosswalk = true;
      if (signal.aborted) break;
    }
    if (chainCrosswalk && !signal.aborted) {
      store.reopenChangedDatasets();
      const cw = await runCrosswalkRebuild(io, config, store, log, opts.notify ? notifier : null);
      lines.push(...cw.lines);
    }
  } finally {
    publisher.close();
    store.close();
  }

  if (opts.json) {
    await writeLine(
      io.stdout,
      JSON.stringify(
        { target, results: results.map(resultJson), unavailable, crosswalk: chainCrosswalk },
        null,
        2,
      ),
    );
  } else {
    for (const l of lines) await writeLine(io.stdout, l);
  }
  const failed = results.filter((r) => !isRefreshSuccess(r));
  const first = failed[0];
  if (first?.status === "failed" && opts.notify) await notifier.failure(job, first.source_error);
  // a job this build cannot run at all (no source) is a failure for that job's own target
  const onlyUnavailable = results.length === 0 && unavailable.length > 0;
  return failed.length === 0 && !signal.aborted && !onlyUnavailable ? EXIT.ok : EXIT.error;
}
