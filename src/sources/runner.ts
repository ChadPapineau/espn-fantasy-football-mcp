// runner.ts — the refresh runner behind `eff refresh <job>` (plan 01 §5.5 refresh execution model,
// §5.7 "retry 3× with jitter inside one run, then stop and report"; plan 06 §1.3 per-job pipeline,
// season awareness, J2 one refresh_log row per run, J3 file-release polls; plan 05 §4.1 refresh rows).
// version() → (version unchanged AND the current file present → recordUnchanged) → fetch →
// assertSchema → publisher.publish(fill via source.publish) → outcome. A failed run PUBLISHES
// NOTHING: no dataset file is written or renamed, the previous file stays current, and the run's
// only trace is one `ok = 0` refresh_log row with a fixed-vocabulary SourceErrorCode (the publisher
// writes the row of a publish it attempted). Pure orchestration over injected HttpGet / HttpDownload
// / Clock / Rng / publisher / temp area: no Date.now, no Math.random. Never throws.
// Ported from sibling @cf3b015, adapted (ESPN SourceContext: the pro schedule drives season gating
// and weather; a run-scoped temp dir; time-bucket versions short-circuit too, which keeps weather at
// ≤ 1 request per venue per hour; ESPN-scoped error codes; no dataset_meta repair path).
import { mkdtemp, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  isSourceErrorCode,
  type DatasetSourceId,
  type SourceErrorCode,
} from "../config/freshness.js";
import { ensureSecureDir } from "../config/paths.js";
import type { NflGamesReader, ProScheduleReader } from "../domain/analytics/types.js";
import type { Clock, Rng } from "../domain/clock.js";
import type { IsoInstant, Week } from "../domain/league/types.js";
import { HttpError, isNetworkFailure, isRetryableError } from "../http/errors.js";
import { createRateLimiter, limitDownload, limitGet } from "../http/limiter.js";
import { abortableSleep, type Sleep } from "../http/sleep.js";
import {
  PUBLISH_ALREADY_CURRENT,
  type DatasetPublisher,
  type PublishOutcome,
  type PublishStats,
  type RefreshLogRepository,
} from "../store/types.js";
import {
  REFRESH_MAX_ATTEMPTS,
  type DataSource,
  type HttpDownload,
  type HttpGet,
  type ReleaseVersion,
  type SchemaReport,
  type SourceContext,
  type TempFile,
} from "./source.js";

/** Attempts per network step (plan 01 §5.7: 3). */
export const DEFAULT_MAX_ATTEMPTS = REFRESH_MAX_ATTEMPTS;
/** Full-jitter backoff: delay = U[0,1) × min(cap, base × 2^(attempt−1)). */
export const DEFAULT_BASE_DELAY_MS = 1_000;
export const DEFAULT_MAX_DELAY_MS = 30_000;
/** "In season" = some game kicks off within ± this many days (plan 06: jobs are season-aware). */
export const SEASON_WINDOW_DAYS = 7;
/**
 * The PublishOutcome error prefix for "another refresh holds the source's job lock" (plan 06 §1.3
 * "never overlaps itself") — the store's PUBLISH_JOB_LOCKED; any error starting with it is a skip.
 */
export const JOB_LOCKED_ERROR = "job_locked";
/**
 * The PublishOutcome error for "renamed into place but its refresh_log row was not written": the new
 * file IS live (the store's PUBLISH_UNRECORDED) — never reported as "the previous file is intact".
 */
export const PUBLISH_UNRECORDED_ERROR = "publish_unrecorded";

/** The runner's own failure vocabulary (RefreshResult.error); refresh_log carries `source_error`. */
export type RefreshErrorCode =
  | "network"
  | "schema"
  | "publish"
  | "published_unrecorded"
  | "aborted"
  | "invalid_request"
  | "internal";

/** Why a run did nothing, successfully. */
export type SkipReason =
  /** An in-season source outside every game's ± SEASON_WINDOW_DAYS. */
  | "off_season"
  /** An in-season source before `espn:pro_schedule` was ever published (it is `always`-gated). */
  | "schedule_never_loaded"
  /** Another refresh holds the job lock (plan 06 §1.3). */
  | "locked"
  /** None of the run's seasons is published upstream yet (a new season's 404). */
  | "not_published";

/** The message of a `published_unrecorded` result. */
export const PUBLISHED_UNRECORDED_MESSAGE =
  "published: the new dataset file is live but its refresh_log row could not be written; the next refresh records it";

/** The result of one refresh run. */
export type RefreshResult =
  | {
      readonly status: "published";
      readonly source: DatasetSourceId;
      readonly version: ReleaseVersion;
      readonly file: string;
      readonly file_version: string;
      readonly stats: PublishStats;
      readonly attempts: number;
      readonly warnings: readonly string[];
    }
  | {
      readonly status: "unchanged";
      readonly source: DatasetSourceId;
      readonly version: ReleaseVersion;
      readonly attempts: number;
    }
  | { readonly status: "skipped"; readonly source: DatasetSourceId; readonly reason: SkipReason }
  | {
      readonly status: "failed";
      readonly source: DatasetSourceId;
      readonly error: RefreshErrorCode;
      /** The refresh_log `error` (fixed vocabulary, plan 01 §4.3). */
      readonly source_error: SourceErrorCode;
      /** Server-authored, one line (names the column/codec on a schema failure). */
      readonly message: string;
      readonly version: ReleaseVersion | null;
      readonly attempts: number;
      readonly schema: SchemaReport | null;
    };

/** Whether a result is a success for the job's exit code (published, unchanged or skipped). */
export function isRefreshSuccess(r: RefreshResult): boolean {
  return r.status !== "failed";
}

/** Where a run's temp files live; the runner removes the run directory on every path. */
export interface TempArea {
  /** Creates a fresh private directory for one run of `source`. */
  create(source: DatasetSourceId): Promise<string>;
  /** Removes a directory or file recursively; never throws for a missing path. */
  remove(path: string): Promise<void>;
}

/** A TempArea under `root` (`<cache>/tmp`, created 0700): one `mkdtemp` directory per run. */
export function fsTempArea(root: string): TempArea {
  return {
    async create(source) {
      // owner-only, never a symlink, refusing a group/other-writable root
      ensureSecureDir(root, { create: true, what: "run temp directory" });
      return mkdtemp(join(root, `${source.replace(/[^a-z0-9_]/gi, "_")}-`));
    },
    async remove(path) {
      await rm(path, { recursive: true, force: true });
    },
  };
}

/** The runner's logging surface (src/cli/log.ts's Logger satisfies it). */
export interface RunnerLog {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** Retry tuning (defaults per plan 01 §5.7). */
export interface RetryPolicy {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

/** Whether the file refresh_log names as current can be served (the unchanged short-circuit). */
export type DatasetCheck = (
  source: DatasetSourceId,
  file: string | null,
  version: string,
) => boolean;

/** The default check: the named file exists, is a regular file and is not empty. */
export const datasetFilePresent: DatasetCheck = (_source, file) => {
  if (file === null) return false;
  try {
    const st = statSync(file);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
};

/** Everything the runner is given; nothing is read from globals. */
export interface RefreshDeps {
  readonly http: HttpGet;
  readonly download: HttpDownload;
  readonly clock: Clock;
  readonly rng: Rng;
  readonly publisher: DatasetPublisher;
  /** Failures before publish are recorded here; the publisher records the rows of its publishes. */
  readonly refreshLog: Pick<RefreshLogRepository, "record" | "current">;
  /** The published ESPN pro schedule: season gating and the weather sources' game list. */
  readonly proSchedule: ProScheduleReader;
  /** nflverse schedules (optional): per-game roofs for retractable venues (weather). */
  readonly nflGames?: NflGamesReader;
  readonly temp: TempArea;
  readonly sleep?: Sleep;
  readonly log?: RunnerLog;
  readonly retry?: RetryPolicy;
  /** Default `datasetFilePresent`. A missing current file is republished, never "unchanged". */
  readonly checkDataset?: DatasetCheck;
}

/** One run's request. */
export interface RefreshRequest {
  readonly source: DataSource;
  /** Seasons the run covers, newest last (non-empty). */
  readonly seasons: readonly number[];
  readonly week: Week | null;
  readonly signal?: AbortSignal;
  /** Re-download even when the version equals the published one. */
  readonly force?: boolean;
}

/** Season state for the gate. */
export type SeasonState = "in_season" | "off_season" | "never_loaded";

/**
 * Whether any game of `season` kicks off within ±SEASON_WINDOW_DAYS of `nowMs`. A pro schedule that
 * was never loaded reads `never_loaded`. A TBD game's placeholder kickoff counts (it is hours off at
 * most — the window is days).
 */
export function seasonState(
  schedule: ProScheduleReader,
  season: number,
  nowMs: number,
): SeasonState {
  const res = schedule.games(season, null);
  if (res.stamp === null) return "never_loaded";
  const window = SEASON_WINDOW_DAYS * 86_400_000;
  for (const g of res.rows) {
    if (g.kickoff === null) continue;
    const k = Date.parse(g.kickoff);
    if (Number.isFinite(k) && Math.abs(k - nowMs) <= window) return "in_season";
  }
  return "off_season";
}

const SAFE_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const safeName = (s: string): string => (SAFE_NAME.test(s) ? s : "?");

/** One line naming what failed the schema assertion (column names and codecs, sanitised). */
export function describeSchemaFailure(r: SchemaReport): string {
  const parts: string[] = [];
  if (r.missing_columns.length > 0)
    parts.push(`missing column(s): ${r.missing_columns.slice(0, 10).map(safeName).join(", ")}`);
  if (r.bad_codecs.length > 0)
    parts.push(
      `unsupported codec(s): ${r.bad_codecs
        .slice(0, 10)
        .map((c) => `${safeName(c.column)}=${safeName(c.codec)}`)
        .join(", ")}`,
    );
  return parts.length > 0
    ? `schema assertion failed: ${parts.join("; ")}`
    : "schema assertion failed";
}

/** The refresh_log code of a schema failure: `codec` when only codecs failed, else `schema_mismatch`. */
export function schemaErrorCode(r: SchemaReport | null): SourceErrorCode {
  return r !== null && r.bad_codecs.length > 0 && r.missing_columns.length === 0
    ? "codec"
    : "schema_mismatch";
}

function validRequest(req: RefreshRequest): boolean {
  return (
    req.seasons.length > 0 &&
    req.seasons.every((s) => Number.isInteger(s) && s >= 1999 && s <= 2100) &&
    (req.week === null || (Number.isInteger(req.week) && req.week >= 1 && req.week <= 22))
  );
}

function isEspnSource(id: DatasetSourceId): boolean {
  return id.startsWith("espn:");
}

/** The refresh_log code of a fetch/version failure (an HttpError's own effCode wins). */
export function sourceErrorFor(e: unknown, id: DatasetSourceId): SourceErrorCode {
  if (e instanceof HttpError) {
    if (e.effCode === "INTERNAL") return "INTERNAL";
    if (e.effCode === "RATE_LIMITED" || e.effCode === "ESPN_HOST_MOVED") return e.effCode;
    return isEspnSource(id) ? "ESPN_UPSTREAM_UNAVAILABLE" : "UPSTREAM_UNAVAILABLE";
  }
  if (isNetworkFailure(e))
    return isEspnSource(id) ? "ESPN_UPSTREAM_UNAVAILABLE" : "UPSTREAM_UNAVAILABLE";
  return "INTERNAL";
}

function errorCodeFor(e: unknown, signal: AbortSignal): RefreshErrorCode {
  if (signal.aborted || (e instanceof HttpError && e.kind === "aborted")) return "aborted";
  return isNetworkFailure(e) ? "network" : "internal";
}

/** The warning a published result carries for a season dropped as not yet published. */
export function notPublishedWarning(id: DatasetSourceId, season: number): string {
  return `${id} season ${String(season)}: not published upstream yet — skipped (the other seasons were published)`;
}

function messageFor(e: unknown): string {
  if (e instanceof HttpError)
    return `${e.message}${e.host === null ? "" : ` (${e.host})`}${e.status === null ? "" : ` status ${String(e.status)}`}`;
  return "the source failed";
}

/**
 * Runs one refresh. Retries a RETRYABLE failure of `version()` or `fetch()` (5xx, 429, timeouts,
 * resets — never DNS / connection refused, plan 01 §6) up to `maxAttempts` with seeded full-jitter
 * backoff (Retry-After raises the delay, capped at maxDelayMs); a schema or publish failure is never
 * retried. The run's temp directory is removed on every path, as are TempFiles outside it.
 */
export async function runRefresh(req: RefreshRequest, deps: RefreshDeps): Promise<RefreshResult> {
  const { source } = req;
  const id = source.id;
  const signal = req.signal ?? new AbortController().signal;
  const started: IsoInstant = deps.clock.nowIso();
  const sleep = deps.sleep ?? abortableSleep;
  const maxAttempts = Math.max(1, Math.floor(deps.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const base = deps.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const cap = deps.retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const jitter = deps.rng.fork(`refresh:${id}`);
  let attempts = 0;
  let version: ReleaseVersion | null = null;
  let dir: string | null = null;
  let files: readonly TempFile[] = [];

  const previous = (): {
    file_version: string;
    file: string | null;
    checked_at: IsoInstant;
  } | null => {
    try {
      const rows = deps.refreshLog.current().filter((r) => r.source === id && r.ok);
      const row = rows[rows.length - 1];
      return row !== undefined && row.file_version !== null
        ? { file_version: row.file_version, file: row.file, checked_at: row.checked_at }
        : null;
    } catch {
      return null;
    }
  };

  const fail = (
    error: RefreshErrorCode,
    sourceError: SourceErrorCode,
    message: string,
    schema: SchemaReport | null = null,
    record = true,
  ): RefreshResult => {
    deps.log?.warn("refresh.failed", { source: id, error, source_error: sourceError, attempts });
    if (record) {
      try {
        deps.refreshLog.record({
          source: id,
          file: null,
          file_version: version?.version ?? null,
          release_updated_at: version?.released_at ?? null,
          seasons: [...req.seasons],
          rows: null,
          columns_hash: null,
          started_at: started,
          finished_at: deps.clock.nowIso(),
          ok: false,
          error: sourceError,
          checked_at: previous()?.checked_at ?? started,
        });
      } catch {
        deps.log?.warn("refresh.log_write_failed", { source: id });
      }
    }
    return {
      status: "failed",
      source: id,
      error,
      source_error: sourceError,
      message,
      version,
      attempts,
      schema,
    };
  };

  /** A failure of version()/fetch(): aborted runs are not recorded (a cancel is not a source error). */
  const failFrom = (e: unknown): RefreshResult => {
    const code = errorCodeFor(e, signal);
    return fail(code, sourceErrorFor(e, id), messageFor(e), null, code !== "aborted");
  };

  /** Runs `step` with retries on retryable failures. */
  const withRetry = async <T>(step: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      attempts++;
      try {
        return await step();
      } catch (e) {
        if (attempt >= maxAttempts || signal.aborted || !isRetryableError(e)) throw e;
        const backoff = Math.floor(jitter.next() * Math.min(cap, base * 2 ** (attempt - 1)));
        const hinted = e instanceof HttpError && e.retryAfterS !== null ? e.retryAfterS * 1000 : 0;
        const delay = Math.min(cap, Math.max(backoff, hinted));
        deps.log?.info("refresh.retry", { source: id, attempt, delay_ms: delay });
        await sleep(delay, signal);
      }
    }
  };

  const cleanup = async (): Promise<void> => {
    for (const f of files) {
      if (dir === null || !f.path.startsWith(`${dir}/`))
        await deps.temp.remove(f.path).catch(() => undefined);
    }
    files = [];
    if (dir !== null) await deps.temp.remove(dir).catch(() => undefined);
    dir = null;
  };

  try {
    if (!validRequest(req))
      return fail("invalid_request", "INTERNAL", "seasons/week out of range", null, false);

    if (source.seasonGate === "in_season") {
      const season = Math.max(...req.seasons);
      let state: SeasonState;
      try {
        state = seasonState(deps.proSchedule, season, deps.clock.nowMs());
      } catch {
        state = "never_loaded";
      }
      if (state !== "in_season") {
        const reason: SkipReason = state === "off_season" ? "off_season" : "schedule_never_loaded";
        deps.log?.info("refresh.skipped", { source: id, reason });
        return { status: "skipped", source: id, reason };
      }
    }

    const limiter = createRateLimiter(source.limiter, { nowMs: () => deps.clock.nowMs(), sleep });
    const notPublished = new Set<number>();
    const runDir = await deps.temp.create(id);
    dir = runDir;
    const ctx: SourceContext = {
      http: limitGet(deps.http, limiter),
      download: limitDownload(deps.download, limiter),
      signal,
      clock: deps.clock,
      seasons: req.seasons,
      week: req.week,
      datasets: {
        proSchedule: deps.proSchedule,
        ...(deps.nflGames === undefined ? {} : { nflGames: deps.nflGames }),
      },
      tempDir: runDir,
      notPublished: (season) => {
        if (req.seasons.includes(season)) notPublished.add(season);
      },
    };

    try {
      version = await withRetry(() => source.version(ctx));
    } catch (e) {
      return failFrom(e);
    }
    if (version === null) {
      const code: SourceErrorCode = isEspnSource(id)
        ? "ESPN_UPSTREAM_UNAVAILABLE"
        : "UPSTREAM_UNAVAILABLE";
      return fail("network", code, "the upstream version is unavailable");
    }
    const v: ReleaseVersion = version;

    // The version short-circuit (release AND time-bucket sources): the published version with its
    // file present → only `checked_at` advances. A missing file is republished.
    if (req.force !== true) {
      const prev = previous();
      if (prev?.file_version === v.version) {
        let present = false;
        try {
          present = (deps.checkDataset ?? datasetFilePresent)(id, prev.file, v.version);
        } catch {
          present = false;
        }
        if (present) {
          try {
            deps.publisher.recordUnchanged(id, v.version, deps.clock.nowIso());
            deps.log?.info("refresh.unchanged", { source: id, version: v.version });
            return { status: "unchanged", source: id, version: v, attempts };
          } catch {
            // the check could not be recorded: publishing is always a correct answer
            deps.log?.warn("refresh.unchanged_check_failed", { source: id });
          }
        } else {
          deps.log?.warn("refresh.dataset_missing", { source: id, version: v.version });
        }
      }
    }

    try {
      files = await withRetry(async () => {
        // a retried fetch starts from an empty run directory
        await cleanup();
        const fresh = await deps.temp.create(id);
        dir = fresh;
        notPublished.clear();
        return source.fetch(v, { ...ctx, tempDir: fresh });
      });
    } catch (e) {
      return failFrom(e);
    }

    // A new season before its first data: publish the seasons that exist; none yet → a skip.
    const seasonWarnings: string[] = [];
    if (notPublished.size > 0) {
      const published = [...new Set(req.seasons)].filter((s) => !notPublished.has(s));
      for (const s of [...notPublished].sort((a, b) => a - b)) {
        seasonWarnings.push(notPublishedWarning(id, s));
        deps.log?.warn("refresh.season_not_published", { source: id, season: s });
      }
      if (published.length === 0) {
        deps.log?.info("refresh.skipped", { source: id, reason: "not_published" });
        return { status: "skipped", source: id, reason: "not_published" };
      }
    }

    let report: SchemaReport;
    try {
      report = await source.assertSchema(files);
    } catch {
      return fail("schema", "schema_mismatch", "schema assertion could not read the download");
    }
    if (!report.ok)
      return fail("schema", schemaErrorCode(report), describeSchemaFailure(report), report);
    if (signal.aborted) return fail("aborted", "INTERNAL", "aborted before publish", null, false);

    let outcome: PublishOutcome;
    try {
      const staged = files;
      outcome = await deps.publisher.publish(
        id,
        v.version,
        v.released_at,
        (w) => source.publish(staged, w),
        {
          skipIfCurrent: req.force !== true,
        },
      );
    } catch {
      return fail(
        "publish",
        "INTERNAL",
        "the publisher failed; the previous dataset file is intact",
      );
    }
    if (!outcome.ok) {
      if (outcome.error === PUBLISH_ALREADY_CURRENT) {
        deps.log?.info("refresh.unchanged", { source: id, version: v.version });
        return { status: "unchanged", source: id, version: v, attempts };
      }
      if (outcome.error.startsWith(JOB_LOCKED_ERROR)) {
        deps.log?.info("refresh.skipped", { source: id, reason: "locked" });
        return { status: "skipped", source: id, reason: "locked" };
      }
      if (outcome.error === PUBLISH_UNRECORDED_ERROR)
        return fail("published_unrecorded", "INTERNAL", PUBLISHED_UNRECORDED_MESSAGE, null, false);
      // a SourceErrorCode: the publisher recorded the failure's row; anything else (a refusal
      // before its lock) wrote nothing, so the runner records it
      const recorded = isSourceErrorCode(outcome.error);
      return fail(
        "publish",
        recorded ? (outcome.error as SourceErrorCode) : "INTERNAL",
        "publish failed; the previous dataset file is intact",
        null,
        !recorded,
      );
    }
    deps.log?.info("refresh.published", {
      source: id,
      version: v.version,
      rows: outcome.stats.rows,
      attempts,
    });
    return {
      status: "published",
      source: id,
      version: v,
      file: outcome.file,
      file_version: outcome.file_version,
      stats: outcome.stats,
      attempts,
      warnings: [...seasonWarnings, ...report.warnings],
    };
  } catch {
    return fail("internal", "INTERNAL", "the refresh runner failed");
  } finally {
    await cleanup();
  }
}

/** Runs several sources of one job in order (plan 06 §1.3: a job may write several sources). */
export async function runRefreshJob(
  reqs: readonly RefreshRequest[],
  deps: RefreshDeps,
): Promise<readonly RefreshResult[]> {
  const out: RefreshResult[] = [];
  for (const r of reqs) out.push(await runRefresh(r, deps));
  return out;
}
