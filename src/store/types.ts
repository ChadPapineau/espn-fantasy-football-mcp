// types.ts — the store contract (plan 01 §5.1 one store file + immutable per-source dataset files
// opened as their OWN read-only connections — no attach loop, an 8-attachment ceiling for on-demand
// joins (§5.5; ADV OBJ-22); §5.3 the ESPN cache; §6 the cross-process limiter table; §9.2 the
// migration-001 table list incl. credential_state; plan 02 §2.1 credential observations; plan 03
// §1.1 busy_timeout 5000, §7 forward-only migrations with a VACUUM INTO backup; plan 06 §1.3 prune
// and never-prune lists). The store implements the domain's repository ports and the store-side
// ports below. Ported from sibling @d72e03b, adapted (ESPN tables; separate read-only connections).
import type { DatasetSourceId, SourceErrorCode } from "../config/freshness.js";
import type {
  CredentialState,
  CredentialStoreKind,
  DriftStatus,
  RequestOutcome,
  WeatherSource,
} from "../config/schema.js";
import type {
  BestEffortOutcome,
  DatasetReaders,
  EspnProjectionRepository,
  ProjectionRepository,
} from "../domain/analytics/types.js";
import type { Clock } from "../domain/clock.js";
import type {
  CrosswalkRepository,
  PlayerUniverseReader,
  RosterWeeklyReader,
} from "../domain/crosswalk/types.js";
import type { WriteJournalRepository } from "../domain/gate/types.js";
import type {
  IsoInstant,
  LeagueSettingsRepository,
  PoolSnapshotRepository,
  RosterSnapshotRepository,
  ScoreboardSnapshotRepository,
  TransactionsSeenRepository,
} from "../domain/league/types.js";
import type { RecommendationLogRepository } from "../domain/reclog/types.js";

export type { BestEffortOutcome } from "../domain/analytics/types.js";

// --- lock and write policy (plan 03 §1.1 step 3; plan 01 §5.1) ---------------------------------------

/** SQLite `busy_timeout` on every connection (plan 03 §1.1 step 3). */
export const BUSY_TIMEOUT_MS = 5000;
/** The two classes of server write: a best-effort cache write may be skipped; a required one may not. */
export type WriteClass = "best_effort" | "required";
/**
 * The most wall clock a BEST-EFFORT write waits for a busy writer lock before it becomes a counted
 * miss (`{ written: false, reason: "busy" }`) — a cache write never stalls the stdio loop for the
 * full BUSY_TIMEOUT_MS (plan 01 §5.3; T-15(c)). Required writes wait BUSY_TIMEOUT_MS.
 */
export const BEST_EFFORT_BUSY_MS = 100;

/** A REQUIRED write could not take the writer lock within BUSY_TIMEOUT_MS (fail closed). */
export class StoreBusyError extends Error {
  readonly effCode = "INTERNAL" as const;
  readonly table: string;
  constructor(table: string) {
    super(`store: the writer lock stayed busy; the ${table} write was not made`);
    this.name = "StoreBusyError";
    this.table = table;
  }
}

/** The store has pending migrations and was opened with `migrate: false` (exit 1). */
export class StoreMigrationPendingError extends Error {
  readonly effCode = "INTERNAL" as const;
  readonly exitCode = 1 as const;
  readonly storeVersion: number;
  readonly binaryVersion: number;
  constructor(storeVersion: number, binaryVersion: number) {
    super(
      `store.sqlite is at v${String(storeVersion)}; this binary needs v${String(binaryVersion)} and was opened without migrating.`,
    );
    this.name = "StoreMigrationPendingError";
    this.storeVersion = storeVersion;
    this.binaryVersion = binaryVersion;
  }
}

/** The store file was written by a newer binary: startup exits 1 (plan 03 §1.1 step 3, §7). */
export class StoreVersionError extends Error {
  readonly effCode = "INTERNAL" as const;
  readonly exitCode = 1 as const;
  readonly storeVersion: number;
  readonly binaryVersion: number;
  constructor(storeVersion: number, binaryVersion: number) {
    super(
      `store.sqlite was written by a newer version (v${String(storeVersion)}); this binary supports v${String(binaryVersion)}. Upgrade the package or restore the backup.`,
    );
    this.name = "StoreVersionError";
    this.storeVersion = storeVersion;
    this.binaryVersion = binaryVersion;
  }
}

// --- tables (plan 01 §9.2, T-07) -----------------------------------------------------------------------

/**
 * The store tables migration 001 creates. The `ds_*` tables are NOT here: they live in per-source
 * dataset files (plan 01 §5.1). `recommendation_outcome` is a recorded deviation (the scored
 * outcome beside the immutable log row). `write_journal` is created empty (PHASE W SEAM).
 */
export const MIGRATION_001_TABLES = [
  "schema_version",
  "espn_cache",
  "league_settings",
  "crosswalk",
  "drift_state",
  "probe_log",
  "refresh_log",
  "job_lock",
  "espn_requests",
  "credential_state",
  "roster_snapshot",
  "pool_snapshot",
  "espn_projection",
  "scoreboard_snapshot",
  "transactions_seen",
  "projection",
  "points_cache",
  "recommendation_log",
  "recommendation_outcome",
  "checks",
  "write_journal",
  /**
   * Recorded deviation (plan 02 §2.4 "one map per store"): the GUID pseudonym map — sha256 of the
   * upper-cased brace-GUID → its first-appearance number, so the map itself holds no real GUID.
   */
  "guid_pseudonym",
] as const;
export type StoreTable = (typeof MIGRATION_001_TABLES)[number];

/** Never pruned (plan 06 §1.3; plan 08 §9): the backtest corpus and the log's referents. */
export const NEVER_PRUNED_TABLES: readonly StoreTable[] = Object.freeze([
  "recommendation_log",
  "recommendation_outcome",
  "league_settings",
  "espn_projection",
  "scoreboard_snapshot",
  "projection",
  "write_journal",
  /** Pruning it would renumber the pseudonyms the never-pruned rows already carry. */
  "guid_pseudonym",
]);

/** What `store prune` removes, per table (plan 06 §1.3). */
export const PRUNE_POLICY: Readonly<Partial<Record<StoreTable, string>>> = Object.freeze({
  espn_cache: "rows past their class hard limit",
  points_cache: "bounded LRU",
  roster_snapshot: "older than 30 days",
  pool_snapshot: "older than 30 days",
  espn_requests:
    "older than 48 hours (ESPN_REQUEST_ROW_TTL_MS: the daily caps and the breaker/304 counters read them)",
});

/** The write class of each table (schema_version is migration-only). */
export const WRITE_CLASS: Readonly<Record<Exclude<StoreTable, "schema_version">, WriteClass>> =
  Object.freeze({
    espn_cache: "best_effort",
    points_cache: "best_effort",
    projection: "best_effort",
    league_settings: "required",
    crosswalk: "required",
    drift_state: "required",
    probe_log: "required",
    refresh_log: "required",
    job_lock: "required",
    /** Fail closed: a request whose row cannot be written is not sent (plan 01 §6). */
    espn_requests: "required",
    credential_state: "required",
    roster_snapshot: "required",
    pool_snapshot: "required",
    espn_projection: "required",
    scoreboard_snapshot: "required",
    transactions_seen: "required",
    recommendation_log: "required",
    recommendation_outcome: "required",
    checks: "required",
    write_journal: "required",
    guid_pseudonym: "required",
  });

// --- dataset files (plan 01 §5.5) -------------------------------------------------------------------

/** SQLite's attached-database limit as bundled in node:sqlite (ADV OBJ-22). */
export const SQLITE_ATTACH_LIMIT = 10;
/** The hard ceiling for an on-demand join connection, asserted in code (plan 01 §5.5). */
export const MAX_ON_DEMAND_ATTACHMENTS = 8;

/** SQLite column affinity. */
export type DatasetColumnType = "TEXT" | "INTEGER" | "REAL" | "BLOB";

/** One dataset column. */
export interface DatasetColumn {
  readonly name: string;
  readonly type: DatasetColumnType;
  readonly nullable: boolean;
}

/** One `ds_*` table a source publishes into its dataset file. */
export interface DatasetTableSpec {
  readonly name: `ds_${string}`;
  readonly columns: readonly DatasetColumn[];
  readonly primary_key: readonly string[] | null;
  readonly indexes: readonly (readonly string[])[];
}

/** One row to insert. */
export type DatasetRow = Readonly<Record<string, string | number | null | Uint8Array>>;

/** The fresh staging file a source fills (`journal_mode=DELETE`, no sidecars — R3 nit (a)). */
export interface DatasetWriter {
  readonly path: string;
  createTable(spec: DatasetTableSpec): void;
  /** Inserts rows in one transaction per call; returns the count inserted. */
  insert(table: string, rows: readonly DatasetRow[]): number;
}

/** What a source reports after filling its staging file. */
export interface PublishStats {
  readonly rows: number;
  readonly tables: readonly { readonly name: string; readonly rows: number }[];
  readonly seasons: readonly number[];
  /** sha256 of the sorted column list — the `ds_schema` fingerprint (plan 03 §7). */
  readonly columns_hash: string;
}

/** The result of publishing a dataset file. */
export type PublishOutcome =
  | {
      readonly ok: true;
      readonly file: string;
      readonly file_version: string;
      readonly stats: PublishStats;
    }
  | { readonly ok: false; readonly error: string };

/** The `PublishOutcome` error when the version is already published (skip under the job lock). */
export const PUBLISH_ALREADY_CURRENT = "already_current";
/** Another publisher (this process or another) holds the source's job lock: nothing was done. */
export const PUBLISH_JOB_LOCKED = "job_locked";
/**
 * The file was renamed into place but its refresh_log row could not be written: the dataset IS
 * live; the next publish of the source records it from the file's own `dataset_meta` first.
 */
export const PUBLISH_UNRECORDED = "publish_unrecorded";
/** Refusals before the job lock is taken (bad arguments; nothing written, no refresh_log row). */
export const PUBLISH_REFUSALS = [
  "invalid_source",
  "invalid_version",
  "invalid_release_time",
] as const;
/**
 * Every `PublishOutcome.error` value: the refusals, the skip/lock/unrecorded outcomes, and the
 * fixed-vocabulary SourceErrorCode the failure's refresh_log row carries (never an exception text).
 */
export type PublishErrorCode =
  | (typeof PUBLISH_REFUSALS)[number]
  | typeof PUBLISH_ALREADY_CURRENT
  | typeof PUBLISH_JOB_LOCKED
  | typeof PUBLISH_UNRECORDED
  | SourceErrorCode;

/**
 * Publishes a dataset atomically (`eff refresh` only — the server never opens one): job lock →
 * staging file → `fill` → fsync → close → `rename()` onto `datasets/<stem>.sqlite` → refresh_log row.
 */
export interface DatasetPublisher {
  publish(
    sourceId: DatasetSourceId,
    version: string,
    releaseUpdatedAt: IsoInstant | null,
    fill: (writer: DatasetWriter) => Promise<PublishStats>,
    options?: { readonly skipIfCurrent?: boolean },
  ): Promise<PublishOutcome>;
  /** The skip path: version unchanged → only `checked_at` advances (the release age basis). */
  recordUnchanged(sourceId: DatasetSourceId, version: string, checkedAt: IsoInstant): void;
  close(): void;
}

/** One refresh_log row (plan 01 §5.5; plan 06 J2). */
export interface RefreshLogRow {
  readonly source: DatasetSourceId;
  readonly file: string | null;
  readonly file_version: string | null;
  readonly release_updated_at: IsoInstant | null;
  readonly seasons: readonly number[];
  readonly rows: number | null;
  readonly columns_hash: string | null;
  readonly started_at: IsoInstant;
  readonly finished_at: IsoInstant;
  readonly ok: boolean;
  /** Fixed-vocabulary error code (never an upstream body). */
  readonly error: SourceErrorCode | null;
  readonly checked_at: IsoInstant;
}

/** refresh_log (required). */
export interface RefreshLogRepository {
  record(row: RefreshLogRow): void;
  /** The newest successful row per source (what the server should have open). */
  current(): readonly RefreshLogRow[];
  latest(source: DatasetSourceId): RefreshLogRow | null;
  consecutiveFailures(source: DatasetSourceId): number;
}

/** One dataset file the server holds open read-only (re-opened when refresh_log names a new version). */
export interface OpenDataset {
  readonly source: DatasetSourceId;
  readonly file: string;
  readonly file_version: string;
  readonly inode: number;
  readonly opened_at: IsoInstant;
}

// --- store-side ports (consumers: providers, auth, drift, cli) ---------------------------------------

/** One ESPN cache entry (plan 01 §5.3): the parsed object, never the raw body outside recording. */
export interface EspnCacheEntry {
  /** Canonical request key: season, league, sorted views, scoringPeriodId, canonical filter. */
  readonly key: string;
  readonly parsed_json: string;
  readonly fetched_at: IsoInstant;
  /** `x-fantasy-server-time`, as ISO. */
  readonly server_time: IsoInstant | null;
  readonly etag: string | null;
  readonly http_status: number;
  /** The raw body — only when EFF_FIXTURE_RECORD=1 (plan 05 §2); null otherwise. */
  readonly raw_body: string | null;
}

/** espn_cache (best-effort). */
export interface EspnCacheRepository {
  get(key: string): EspnCacheEntry | null;
  put(entry: EspnCacheEntry): BestEffortOutcome;
  /** Deletes entries fetched before `before`; returns rows removed. */
  prune(before: IsoInstant): number;
}

/** Who sent an ESPN request: the MCP server, or a scheduled job (plan 06 caps count jobs only). */
export type RequestOrigin = "server" | "job";

/** The espn_requests columns (migration 001 — fixed now so day one needs no migration 002). */
export const ESPN_REQUESTS_COLUMNS = ["id", "ts", "keyless", "origin", "outcome"] as const;

/**
 * One limiter check-and-record (plan 01 §6; plan 06 §1.4 + changelog V7): every window and the
 * daily cap are checked and the row inserted in ONE `BEGIN IMMEDIATE`, so two processes cannot
 * race past a cap. `windows` = the per-minute (ESPN_LIMITER.perMinute over 60 s) and per-second
 * (ESPN_LIMITER.perSecond over 1 s) buckets; `dailyCap` = the job fleet's cap for this kind
 * (ESPN_JOB_DAILY_CAPS), counted over JOB-origin rows of the same kind since `dayStart` — null for
 * server-origin requests (the caps bind jobs only).
 */
export interface LimiterRequest {
  readonly at: IsoInstant;
  readonly keyless: boolean;
  readonly origin: RequestOrigin;
  readonly windows: readonly { readonly start: IsoInstant; readonly max: number }[];
  readonly dailyCap: { readonly dayStart: IsoInstant; readonly max: number } | null;
}

/**
 * The verdict: recorded (the row id, outcome `pending` until `recordOutcome`), or refused with the
 * wait that frees a slot — `retry_after_ms` = (oldest row in the full window) + window − now, or
 * the time to the next day start for a daily cap — which RATE_LIMITED's `retry_after_s` carries.
 */
export type LimiterVerdict =
  | { readonly ok: true; readonly id: number }
  | {
      readonly ok: false;
      readonly reason: "window" | "daily_cap";
      readonly retry_after_ms: number;
    };

/** Today's requests by origin × kind (`eff status`, the job fleet, G1 `requests_today`). */
export interface RequestCounts {
  readonly server: { readonly cookie: number; readonly keyless: number };
  readonly job: { readonly cookie: number; readonly keyless: number };
}

/**
 * espn_requests: the cross-process token bucket (plan 01 §6) plus each request's outcome, from
 * which any process derives the breaker (platform.ts `breakerFromOutcomes`) and the 304 count.
 * Fail closed: a request whose row cannot be written is not sent (WRITE_CLASS `required`).
 */
export interface LimiterRepository {
  tryRecord(req: LimiterRequest): LimiterVerdict;
  /** Sets the outcome of a recorded row once the request finished (retries keep the same row). */
  recordOutcome(id: number, outcome: RequestOutcome): void;
  countSince(since: IsoInstant): number;
  countToday(dayStart: IsoInstant): RequestCounts;
  /** The newest outcomes, newest first (`breakerFromOutcomes` input), at most `limit`. */
  recentOutcomes(
    limit: number,
  ): readonly { readonly at: IsoInstant; readonly outcome: RequestOutcome }[];
  /** `not_modified` outcomes since `since` (G1 `etag_304_count`). */
  count304Since(since: IsoInstant): number;
  /** Deletes rows before `before` (ESPN_REQUEST_ROW_TTL_MS); returns rows removed. */
  prune(before: IsoInstant): number;
}

/**
 * The limiter's pure decision over the rows already inside each window (what the store runs
 * inside its BEGIN IMMEDIATE, and what tests check it against): refuse on the first full window
 * (wait = oldest-in-window + window length − now), then on a full daily cap (wait = to `nextDayStart`).
 * Times are epoch ms; `windowRows[i]` are the row times inside `windows[i]`, any order.
 */
export function limiterDecision(input: {
  readonly nowMs: number;
  readonly windows: readonly { readonly startMs: number; readonly max: number }[];
  readonly windowRows: readonly (readonly number[])[];
  readonly dailyCap: {
    readonly max: number;
    readonly used: number;
    readonly nextDayStartMs: number;
  } | null;
}):
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "window" | "daily_cap";
      readonly retry_after_ms: number;
    } {
  for (const [i, w] of input.windows.entries()) {
    const rows = input.windowRows[i] ?? [];
    if (rows.length >= w.max) {
      const oldest = Math.min(...rows);
      const length = input.nowMs - w.startMs;
      return {
        ok: false,
        reason: "window",
        retry_after_ms: Math.max(1, Math.ceil(oldest + length - input.nowMs)),
      };
    }
  }
  const cap = input.dailyCap;
  if (cap !== null && cap.used >= cap.max)
    return {
      ok: false,
      reason: "daily_cap",
      retry_after_ms: Math.max(1, Math.ceil(cap.nextDayStartMs - input.nowMs)),
    };
  return { ok: true };
}

/** Who recorded a credential observation. */
export type CredentialObserver = "setup" | "server" | "doctor" | "check_auth" | "daily_job";

/**
 * The `credential_state` row (plan 02 §2.1; changelog V5, C1-8): the state and its observations,
 * never the secret. `stored_at` is a non-secret copy of the setup `storedAt`.
 */
export interface CredentialStateRow {
  /** The league the observations were made against (a change of league reads as `stored`). */
  readonly league_id: string;
  readonly state: CredentialState;
  readonly store: CredentialStoreKind;
  readonly stored_at: IsoInstant | null;
  readonly last_accepted_at: IsoInstant | null;
  readonly last_rejected_at: IsoInstant | null;
  readonly rejected_since: IsoInstant | null;
  readonly next_probe_at: IsoInstant | null;
  /** The view whose 401 caused the rejection — the daily job's discriminating probe (R3 nit (c)). */
  readonly rejected_view: string | null;
  /** The setup board-probe control: did the anonymous control answer 401 (ADV OBJ-26)? */
  readonly board_probe_discriminates: boolean | null;
  readonly updated_at: IsoInstant;
  readonly updated_by: CredentialObserver;
}

/** credential_state (required; one row — single-league posture). */
export interface CredentialStateRepository {
  get(): CredentialStateRow | null;
  /** Setup's first write only; every later change goes through `transition`. */
  put(row: CredentialStateRow): void;
  /**
   * Read-modify-write under ONE `BEGIN IMMEDIATE` (plan 02 §2.1: the state is recorded by whichever
   * process observes): `fn` gets the CURRENT row and returns the next (null = delete), so a
   * concurrent `validated` from the daily job and a `rejected` from the server serialise instead of
   * overwriting each other. src/auth/state.ts applies every observation through it
   * (`row => row && applyObservation(row, o)`). Returns the row written.
   */
  transition(
    fn: (row: CredentialStateRow | null) => CredentialStateRow | null,
  ): CredentialStateRow | null;
  /** `eff setup --reset`, `eff uninstall`, a setup that deleted the value. */
  clear(): void;
}

/** The drift_state row (plan 01 §7). The diff is stored as JSON (its type lives in src/drift). */
export interface DriftStateRow {
  readonly status: DriftStatus;
  readonly since: IsoInstant | null;
  readonly last_probe_at: IsoInstant | null;
  readonly manifest_hash: string | null;
  readonly manifest_version: number | null;
  readonly host: string;
  readonly host_moved_at: IsoInstant | null;
  readonly diff_json: string;
  readonly additive_json: string;
  readonly updated_at: IsoInstant;
}

/** drift_state (required; one row). */
export interface DriftStateRepository {
  get(): DriftStateRow | null;
  put(row: DriftStateRow): void;
}

/** One probe_log row (plan 01 §7; `doctor` #9 reads the last success). */
export interface ProbeLogRow {
  readonly at: IsoInstant;
  readonly kind: "host" | "shape";
  readonly ok: boolean;
  readonly status: DriftStatus;
  readonly upstream_status: number | null;
  /** Fixed-vocabulary error summary. */
  readonly error: string | null;
}

/** probe_log (required). */
export interface ProbeLogRepository {
  record(row: ProbeLogRow): void;
  lastSuccess(kind: ProbeLogRow["kind"]): ProbeLogRow | null;
  recent(limit: number): readonly ProbeLogRow[];
}

/** job_lock (required): single-flight for jobs across processes. */
export interface JobLockRepository {
  /** True when acquired; a lock older than `staleAfterMs` or owned by a dead pid is broken. */
  acquire(job: string, pid: number, now: IsoInstant, staleAfterMs: number): boolean;
  release(job: string, pid: number): void;
}

/** points_cache (best-effort): `ScoreResult` memo by line hash + settings hash (plan 08 §9). */
export interface PointsCacheRepository {
  get(lineHash: string, settingsHash: string): string | null;
  put(lineHash: string, settingsHash: string, resultJson: string): BestEffortOutcome;
}

/** Every repository the store serves. */
export interface StoreRepositories {
  readonly espnCache: EspnCacheRepository;
  readonly limiter: LimiterRepository;
  readonly credentialState: CredentialStateRepository;
  readonly driftState: DriftStateRepository;
  readonly probeLog: ProbeLogRepository;
  readonly refreshLog: RefreshLogRepository;
  readonly jobLock: JobLockRepository;
  readonly pointsCache: PointsCacheRepository;
  readonly leagueSettings: LeagueSettingsRepository;
  readonly crosswalk: CrosswalkRepository;
  readonly rosterSnapshots: RosterSnapshotRepository;
  readonly poolSnapshots: PoolSnapshotRepository;
  readonly scoreboardSnapshots: ScoreboardSnapshotRepository;
  readonly transactionsSeen: TransactionsSeenRepository;
  readonly projections: ProjectionRepository;
  readonly espnProjections: EspnProjectionRepository;
  readonly recommendationLog: RecommendationLogRepository;
  /** PHASE W SEAM — the empty table's counts (G1 `journal` is null in this build). */
  readonly writeJournal: WriteJournalRepository;
}

// --- the store -------------------------------------------------------------------------------------

/** How to open the store. */
export interface StoreOpenOptions {
  readonly path: string;
  readonly datasetDir: string;
  readonly backupDir: string;
  readonly clock: Clock;
  /** Run pending migrations (under BEGIN IMMEDIATE, after a VACUUM INTO backup). */
  readonly migrate: boolean;
  /** Receives fixed-vocabulary warning codes; the store itself never logs. */
  readonly onWarning?: (code: string) => void;
  /** Which weather table `WeatherReader.forGames` consults first (EFF_WEATHER_SOURCE; default open-meteo). */
  readonly weatherSource?: WeatherSource;
  /**
   * Keep `espn_cache.raw_body` (EFF_FIXTURE_RECORD=1 only — plan 01 §5.3, plan 05 §2). Default
   * false: a raw body handed to `put` is dropped, so the cache never becomes a PII store.
   */
  readonly recordRawBodies?: boolean;
}

/** A consistent backup (plan 03 §7: `VACUUM INTO` under the process lock, never a file copy). */
export interface BackupResult {
  readonly path: string;
  readonly bytes: number;
  readonly taken_at: IsoInstant;
}

/** Store health for `eff status` / `espn_get_status.store`. */
export interface StoreStats {
  readonly path: string;
  readonly size_bytes: number;
  readonly schema_version: number;
  readonly open_datasets: readonly OpenDataset[];
  /** Best-effort writes skipped because the writer lock was busy (since open). */
  readonly cache_misses_busy?: number;
}

/** An open store (one main connection, WAL, busy_timeout 5000). */
export interface Store {
  readonly path: string;
  readonly schemaVersion: number;
  readonly repos: StoreRepositories;
  /** Read-only dataset ports, each over its own read-only connection. */
  readonly datasets: DatasetReaders;
  readonly rosterWeekly: RosterWeeklyReader;
  readonly playerUniverse: PlayerUniverseReader;
  /** Re-opens any dataset whose refresh_log version changed (never an attach loop). */
  reopenChangedDatasets(): readonly DatasetSourceId[];
  backup(destPath: string): Promise<BackupResult>;
  stats(): StoreStats;
  /** Checkpoints WAL (TRUNCATE) and closes every connection; idempotent. */
  close(): void;
}

/** Options for the refresh process's publisher. */
export interface PublisherOpenOptions {
  readonly storePath: string;
  readonly datasetDir: string;
  readonly clock: Clock;
}

/** Opens stores and publishers (the one place that touches `node:sqlite`). */
export interface StoreFactory {
  open(opts: StoreOpenOptions): Store;
  /** The refresh-process role: the server never opens one. */
  openPublisher(opts: PublisherOpenOptions): DatasetPublisher;
}
