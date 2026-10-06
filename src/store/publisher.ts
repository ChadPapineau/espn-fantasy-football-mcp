// publisher.ts — StoreFactory.openPublisher → DatasetPublisher, the refresh process's only dataset
// writer (plan 01 §5.5; plan 06 §1.3; plan 03 §7): the source's job_lock (a second publisher SKIPS
// with `job_locked`), staging debris swept, a fresh 0600 staging file beside the target
// (journal_mode=DELETE: one file, no sidecars — R3 nit (a)) filled through a DatasetWriter, stamped
// with dataset_meta, fsynced and CLOSED, then ONE commit: the store's writer lock first, rename()
// onto `datasets/<stem>.sqlite`, the directory fsynced, the refresh_log row, COMMIT. A failure
// before the rename removes the staging file and leaves the previous dataset untouched; one after it
// is PUBLISH_UNRECORDED and the next publish records the live file first. The main store never
// receives a dataset write (ADV OBJ-09(a)). Ported from sibling @cf3b015, adapted.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsc,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  isDatasetSourceId,
  isSourceErrorCode,
  type DatasetSourceId,
  type SourceErrorCode,
} from "../config/freshness.js";
import { BACKUP_DIR_NAME, datasetFileStem, ensureSecureDir } from "../config/paths.js";
import {
  checkDatasetFile,
  datasetFileOf,
  DATASET_META_TABLE,
  DS_SCHEMA_VERSION,
} from "./datasets/connections.js";
import {
  columnsHash,
  columnsHashOf,
  ddlFor,
  isPhase1DatasetSource,
  quoteIdentifier,
  tablesFor,
} from "./datasets/tables.js";
import { MIGRATIONS, type Migration } from "./migrations/index.js";
import { createPseudonymizer } from "./pseudonym.js";
import { boundedArray, type RepoDeps } from "./repos/common.js";
import {
  checkRefreshRow,
  currentRefreshRow,
  insertRefreshRow,
  jobLockRepository,
  markCheckedRow,
  VERSION_MAX,
} from "./repos/ops.js";
import {
  createPrivateFile,
  immediate,
  openDatasetConnection,
  StatementGuard,
  WriteExecutor,
} from "./sqlite.js";
import { assertAbsolute, openMigrated } from "./store.js";
import {
  BUSY_TIMEOUT_MS,
  PUBLISH_ALREADY_CURRENT,
  PUBLISH_JOB_LOCKED,
  PUBLISH_UNRECORDED,
  StoreBusyError,
  type DatasetPublisher,
  type DatasetRow,
  type DatasetTableSpec,
  type DatasetWriter,
  type PublishErrorCode,
  type PublishOutcome,
  type PublishStats,
  type PublisherOpenOptions,
  type RefreshLogRow,
} from "./types.js";

/** A publish job lock older than this is broken (the largest Phase-1 publish takes seconds). */
export const PUBLISH_LOCK_STALE_MS = 15 * 60 * 1000;
/** Most rows one `insert` call takes (one transaction; the source batches). */
export const INSERT_MAX_ROWS = 1_000_000;
/** Most tables one dataset file holds. */
export const TABLES_MAX = 64;
/**
 * How long the publish commit (rename + refresh_log row) waits for the store's writer lock. The
 * refresh process is not interactive, so it outwaits a busy server instead of failing a finished
 * download on the server's 5-s budget.
 */
export const PUBLISH_COMMIT_BUSY_MS = 30_000;
/** A release version: printable ASCII, no NUL, ≤ VERSION_MAX. */
export const VERSION_RE = /^[\x20-\x7e]{1,128}$/;

/** The job name of a source's publish lock. */
export const publishJob = (source: DatasetSourceId): string => `publish:${source}`;

/** Jobs held by publishers of THIS process (job_lock is keyed by pid, so it cannot tell them apart). */
const heldInProcess = new Set<string>();

/** The staging path `<ds>/<stem>.<version>.<rand>.tmp` (config/paths datasetTempPath's pattern). */
export function stagingPath(datasetDir: string, source: DatasetSourceId, version: string): string {
  const safe = version.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "v";
  return path.join(
    datasetDir,
    `${datasetFileStem(source)}.${safe}.${randomBytes(6).toString("hex")}.tmp`,
  );
}

/** Removes a source's staging debris (`<stem>.*.tmp` and its `-journal`); returns names removed. */
export function sweepDebris(datasetDir: string, source: DatasetSourceId): string[] {
  const prefix = `${datasetFileStem(source)}.`;
  const removed: string[] = [];
  for (const n of readdirSync(datasetDir)) {
    if (!n.startsWith(prefix) || !(n.endsWith(".tmp") || n.endsWith(".tmp-journal"))) continue;
    const p = path.join(datasetDir, n);
    const st = lstatSync(p);
    if (st.isFile() || st.isSymbolicLink()) {
      rmSync(p, { force: true });
      removed.push(n);
    }
  }
  return removed.sort();
}

function fsyncPath(p: string): void {
  const fd = openSync(p, fsc.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** A publish failure carrying its fixed-vocabulary code. */
class PublishError extends Error {
  constructor(readonly code: SourceErrorCode | typeof PUBLISH_UNRECORDED) {
    super(code);
  }
}

/**
 * The SourceErrorCode of a failure: a PublishError's code, a source error's own `code` when it is in
 * SOURCE_ERROR_CODES (`{ code: "schema_mismatch" }`), else INTERNAL — never an exception message.
 */
export function errorCode(e: unknown): SourceErrorCode {
  if (e instanceof PublishError) return e.code === PUBLISH_UNRECORDED ? "INTERNAL" : e.code;
  if (e instanceof StoreBusyError) return "INTERNAL";
  let c: unknown;
  try {
    c = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  } catch {
    c = undefined;
  }
  return isSourceErrorCode(c) ? c : "INTERNAL";
}

/** The staging-file writer handed to `fill` (usable only until `fill` settles). */
class StagingWriter implements DatasetWriter {
  private readonly specs = new Map<string, { spec: DatasetTableSpec; insert: StatementSync }>();
  private live = true;
  readonly counts = new Map<string, number>();

  constructor(
    readonly path: string,
    private readonly db: DatabaseSync,
  ) {}

  close(): void {
    this.live = false;
  }

  get created(): readonly DatasetTableSpec[] {
    return [...this.specs.values()].map((s) => s.spec);
  }

  private check(): void {
    if (!this.live) throw new Error("store: the DatasetWriter is closed");
  }

  createTable(spec: DatasetTableSpec): void {
    this.check();
    if (typeof spec.name !== "string" || !spec.name.startsWith("ds_"))
      throw new RangeError("store: dataset tables must be named ds_*");
    if (this.specs.has(spec.name)) throw new RangeError(`store: table ${spec.name} created twice`);
    if (this.specs.size >= TABLES_MAX) throw new RangeError("store: too many tables");
    for (const sql of ddlFor(spec)) this.db.exec(sql);
    const cols = spec.columns.map((c) => quoteIdentifier(c.name)).join(", ");
    const params = spec.columns.map(() => "?").join(", ");
    const insert = this.db.prepare(
      `INSERT INTO ${quoteIdentifier(spec.name)} (${cols}) VALUES (${params})`,
    );
    this.specs.set(spec.name, { spec, insert });
    this.counts.set(spec.name, 0);
  }

  insert(table: string, rows: readonly DatasetRow[]): number {
    this.check();
    const t = this.specs.get(table);
    if (t === undefined) throw new RangeError("store: insert into a table that was not created");
    boundedArray(rows, INSERT_MAX_ROWS, "rows");
    const names = new Set(t.spec.columns.map((c) => c.name));
    this.db.exec("BEGIN");
    try {
      for (const row of rows) {
        for (const k of Object.keys(row))
          if (!names.has(k))
            throw new RangeError(`store: ${table} has no column ${JSON.stringify(k)}`);
        t.insert.run(
          ...t.spec.columns.map((c) => (Object.hasOwn(row, c.name) ? (row[c.name] ?? null) : null)),
        );
      }
      this.db.exec("COMMIT");
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
    this.counts.set(table, (this.counts.get(table) ?? 0) + rows.length);
    return rows.length;
  }
}

function checkStats(stats: unknown): PublishStats {
  const s = stats as PublishStats | null;
  if (
    s === null ||
    typeof s !== "object" ||
    !Number.isInteger(s.rows) ||
    s.rows < 0 ||
    !Array.isArray(s.tables) ||
    !Array.isArray(s.seasons) ||
    s.seasons.length > 64 ||
    !s.seasons.every((x) => Number.isInteger(x) && x >= 1990 && x <= 2100) ||
    typeof s.columns_hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(s.columns_hash)
  )
    throw new PublishError("INTERNAL");
  return s;
}

/** Test hooks for the publisher (fault injection). */
export interface PublisherInternals {
  readonly migrations?: readonly Migration[];
  /** Runs after fsync, before the commit (a crash here must leave the old file). */
  readonly beforeRename?: (stagingFile: string) => void;
  /** Runs right after the rename, inside the commit (fault injection: live but unrecorded). */
  readonly afterRename?: (finalFile: string) => void;
  /** Overrides PUBLISH_COMMIT_BUSY_MS (tests). */
  readonly commitBusyMs?: number;
}

/** The refresh_log row a live dataset file stands for, from its own dataset_meta (or null). */
function rowFromMeta(
  source: DatasetSourceId,
  file: string,
  meta: Readonly<Record<string, string>>,
): RefreshLogRow | null {
  const version = meta.file_version;
  const at = meta.published_at;
  if (version === undefined || at === undefined) return null;
  let seasons: number[] = [];
  try {
    const parsed: unknown = JSON.parse(meta.seasons ?? "[]");
    if (Array.isArray(parsed) && parsed.every((x) => Number.isInteger(x)))
      seasons = parsed as number[];
  } catch {
    seasons = [];
  }
  const release = meta.release_updated_at ?? null;
  const row: RefreshLogRow = {
    source,
    file,
    file_version: version,
    release_updated_at: release !== null && Number.isFinite(Date.parse(release)) ? release : null,
    seasons,
    rows: meta.rows !== undefined && /^[0-9]{1,15}$/.test(meta.rows) ? Number(meta.rows) : null,
    columns_hash: meta.columns_hash ?? null,
    started_at: at,
    finished_at: at,
    ok: true,
    error: null,
    checked_at: at,
  };
  try {
    checkRefreshRow(row);
  } catch {
    return null;
  }
  return row;
}

/** The served dataset_meta of the published file of `source`, or null (absent or not served). */
function liveMeta(file: string, source: DatasetSourceId): Readonly<Record<string, string>> | null {
  try {
    if (!lstatSync(file).isFile()) return null;
  } catch {
    return null;
  }
  let db: DatabaseSync | null = null;
  try {
    db = openDatasetConnection(file, null, source);
    const checked = checkDatasetFile(db, source);
    return checked.ok ? checked.meta : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export function openPublisher(
  opts: PublisherOpenOptions,
  internals: PublisherInternals = {},
): DatasetPublisher {
  assertAbsolute(opts.datasetDir, "dataset directory");
  const guard = new StatementGuard();
  const { db } = openMigrated({
    path: opts.storePath,
    backupDir: path.join(path.dirname(opts.storePath), BACKUP_DIR_NAME),
    clock: opts.clock,
    migrate: true,
    migrations: internals.migrations ?? MIGRATIONS,
    guard,
    busyMs: BUSY_TIMEOUT_MS,
  });
  try {
    ensureSecureDir(opts.datasetDir, { create: true, what: "dataset directory" });
  } catch (e) {
    db.close();
    throw e;
  }
  const writes = new WriteExecutor(db);
  const deps: RepoDeps = {
    db,
    writes,
    clock: opts.clock,
    pseudonyms: createPseudonymizer(db),
    recordRawBodies: false,
  };
  const jobLock = jobLockRepository(deps);
  const clock = opts.clock;
  const commitBusyMs = internals.commitBusyMs ?? PUBLISH_COMMIT_BUSY_MS;
  let closed = false;

  /** Runs `fn` with the long commit busy_timeout (the refresh process may outwait a busy server). */
  const patient = <T>(table: string, fn: () => T, tx = false): T => {
    db.exec(`PRAGMA busy_timeout = ${String(commitBusyMs)}`);
    try {
      return tx ? writes.requiredTx(table, fn) : writes.required(table, fn);
    } finally {
      db.exec(`PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
    }
  };

  const isCurrent = (source: DatasetSourceId, version: string): boolean => {
    const cur = currentRefreshRow(deps, source);
    if (cur?.file_version !== version) return false;
    return liveMeta(datasetFileOf(opts.datasetDir, source), source)?.file_version === version;
  };

  /**
   * Records the live file of `source` when refresh_log does not list its version as current — a
   * publish that renamed but could not record (PUBLISH_UNRECORDED), or crashed between its rename
   * and its commit. Under the source's job lock; a failure leaves things as they are.
   */
  const recordLiveFile = (source: DatasetSourceId, file: string): void => {
    try {
      const meta = liveMeta(file, source);
      const live = meta === null ? null : rowFromMeta(source, file, meta);
      if (live === null || currentRefreshRow(deps, source)?.file_version === live.file_version)
        return;
      patient("refresh_log", () => {
        insertRefreshRow(deps, live);
      });
    } catch {
      // left unrecorded: the publish below writes (and records) a file of its own
    }
  };

  function refuse(code: PublishErrorCode): PublishOutcome {
    return { ok: false, error: code };
  }

  async function publish(
    sourceId: DatasetSourceId,
    version: string,
    releaseUpdatedAt: string | null,
    fill: (writer: DatasetWriter) => Promise<PublishStats>,
    options?: { readonly skipIfCurrent?: boolean },
  ): Promise<PublishOutcome> {
    if (closed) throw new Error("store: the publisher is closed");
    if (typeof sourceId !== "string" || !isDatasetSourceId(sourceId))
      return refuse("invalid_source");
    if (typeof version !== "string" || version.length > VERSION_MAX || !VERSION_RE.test(version))
      return refuse("invalid_version");
    if (
      releaseUpdatedAt !== null &&
      (typeof releaseUpdatedAt !== "string" ||
        releaseUpdatedAt.length > 64 ||
        !Number.isFinite(Date.parse(releaseUpdatedAt)))
    )
      return refuse("invalid_release_time");
    const job = publishJob(sourceId);
    const lockKey = `${opts.storePath}|${job}`;
    if (heldInProcess.has(lockKey)) return refuse(PUBLISH_JOB_LOCKED);
    heldInProcess.add(lockKey);
    let acquired: boolean;
    try {
      acquired = jobLock.acquire(job, process.pid, clock.nowIso(), PUBLISH_LOCK_STALE_MS);
    } catch {
      heldInProcess.delete(lockKey);
      return refuse("INTERNAL");
    }
    if (!acquired) {
      heldInProcess.delete(lockKey);
      return refuse(PUBLISH_JOB_LOCKED);
    }
    const startedAt = clock.nowIso();
    const finalPath = datasetFileOf(opts.datasetDir, sourceId);
    let staging: string | null = null;
    let wdb: DatabaseSync | null = null;
    let writer: StagingWriter | null = null;
    let recordFailure = true;
    try {
      recordLiveFile(sourceId, finalPath);
      // single-flight (plan 01 §5.7): another refresh may have published this very release since
      // the caller's unchanged-check; only checked_at advances (the release age basis).
      if (options?.skipIfCurrent === true && isCurrent(sourceId, version)) {
        recordFailure = false; // a failed check write is not a failed publish
        patient(
          "refresh_log",
          () => {
            markCheckedRow(deps, sourceId, clock.nowIso());
          },
          true,
        );
        return refuse(PUBLISH_ALREADY_CURRENT);
      }
      sweepDebris(opts.datasetDir, sourceId);
      staging = stagingPath(opts.datasetDir, sourceId, version);
      if (!createPrivateFile(staging)) throw new PublishError("INTERNAL");
      wdb = new DatabaseSync(staging, { enableDoubleQuotedStringLiterals: false });
      wdb.exec(
        "PRAGMA journal_mode = DELETE; PRAGMA synchronous = OFF; PRAGMA trusted_schema = OFF",
      );
      writer = new StagingWriter(staging, wdb);
      const stats = checkStats(await fill(writer));
      writer.close();
      // A file the server would refuse is never published: every contract table, this layout.
      const created = writer.created;
      if (!tablesFor(sourceId).every((t) => writer?.counts.has(t.name) === true))
        throw new PublishError("schema_mismatch");
      const hash = columnsHashOf(created);
      if (isPhase1DatasetSource(sourceId) && hash !== columnsHash(sourceId))
        throw new PublishError("schema_mismatch");
      if (stats.columns_hash !== hash) throw new PublishError("schema_mismatch");
      let rows = 0;
      for (const n of writer.counts.values()) rows += n;
      const publishedAt = clock.nowIso();
      wdb.exec(
        `CREATE TABLE ${DATASET_META_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`,
      );
      const meta = wdb.prepare(`INSERT INTO ${DATASET_META_TABLE} (key, value) VALUES (?, ?)`);
      for (const [k, v] of [
        ["source", sourceId],
        ["file_version", version],
        ["release_updated_at", releaseUpdatedAt],
        ["published_at", publishedAt],
        ["ds_schema", String(DS_SCHEMA_VERSION)],
        ["columns_hash", hash],
        ["rows", String(rows)],
        ["seasons", JSON.stringify(stats.seasons)],
      ] as const)
        if (v !== null) meta.run(k, v);
      wdb.close();
      wdb = null;
      // journal_mode=DELETE leaves no sidecar once the last transaction committed (R3 nit (a)).
      let sidecar = false;
      try {
        lstatSync(`${staging}-journal`);
        sidecar = true;
      } catch {
        sidecar = false;
      }
      if (sidecar) throw new PublishError("INTERNAL");
      fsyncPath(staging);
      internals.beforeRename?.(staging);
      const success = (finishedAt: string): RefreshLogRow => ({
        source: sourceId,
        file: finalPath,
        file_version: version,
        release_updated_at: releaseUpdatedAt,
        seasons: [...stats.seasons],
        rows,
        columns_hash: hash,
        started_at: startedAt,
        finished_at: finishedAt,
        ok: true,
        error: null,
        checked_at: finishedAt,
      });
      checkRefreshRow(success(startedAt)); // nothing that can be refused is left past the rename
      // The commit point: the writer lock FIRST (a busy store fails here, before the rename — the
      // previous file really is intact), then rename + directory fsync + the row, one transaction.
      const from = staging;
      const commit = { renamed: false };
      try {
        patient("refresh_log", () => {
          immediate(db, () => {
            renameSync(from, finalPath);
            commit.renamed = true;
            staging = null;
            fsyncPath(opts.datasetDir);
            internals.afterRename?.(finalPath);
            insertRefreshRow(deps, success(clock.nowIso()));
          });
        });
      } catch (e) {
        if (commit.renamed) {
          recordFailure = false; // the file IS live: no failure row
          throw new PublishError(PUBLISH_UNRECORDED);
        }
        throw e;
      }
      return {
        ok: true,
        file: finalPath,
        file_version: version,
        stats: { ...stats, rows, columns_hash: hash },
      };
    } catch (e) {
      writer?.close();
      if (wdb !== null) {
        try {
          wdb.close();
        } catch {
          // already closed
        }
      }
      if (staging !== null) {
        rmSync(staging, { force: true });
        rmSync(`${staging}-journal`, { force: true });
      }
      if (e instanceof PublishError && e.code === PUBLISH_UNRECORDED)
        return refuse(PUBLISH_UNRECORDED);
      const code = errorCode(e);
      if (recordFailure) {
        const now = clock.nowIso();
        try {
          patient("refresh_log", () => {
            insertRefreshRow(deps, {
              source: sourceId,
              file: null,
              file_version: null,
              release_updated_at: releaseUpdatedAt,
              seasons: [],
              rows: null,
              columns_hash: null,
              started_at: startedAt,
              finished_at: now,
              ok: false,
              error: code,
              checked_at: now,
            });
          });
        } catch {
          // the failure row is best-effort once the publish itself failed
        }
      }
      return refuse(code);
    } finally {
      heldInProcess.delete(lockKey);
      try {
        jobLock.release(job, process.pid);
      } catch {
        // a lock we could not release goes stale after PUBLISH_LOCK_STALE_MS / when we exit
      }
    }
  }

  return {
    publish,
    recordUnchanged(sourceId, version, checkedAt) {
      if (closed) throw new Error("store: the publisher is closed");
      if (typeof sourceId !== "string" || !isDatasetSourceId(sourceId))
        throw new RangeError("store: unknown dataset source");
      if (typeof checkedAt !== "string" || !Number.isFinite(Date.parse(checkedAt)))
        throw new RangeError("store: checkedAt must be ISO-8601");
      if (!isCurrent(sourceId, version))
        throw new RangeError("store: the version is not the current, served, published one");
      patient(
        "refresh_log",
        () => {
          markCheckedRow(deps, sourceId, checkedAt);
        },
        true,
      );
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        // busy: the next opener checkpoints
      }
      guard.forget(db);
      db.close();
    },
  };
}
