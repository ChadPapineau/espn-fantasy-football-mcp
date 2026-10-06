// store.ts — StoreFactory.open → Store (plan 01 §5.1 one store file, WAL; §5.3 write classes; §5.5
// dataset files as their own read-only connections, opened lazily; plan 03 §1.1 step 3 open →
// migrate, nothing attached at startup; §1.3 close with a WAL checkpoint; §7 forward-only migrations
// after a VACUUM INTO backup under the process lock; a newer store is refused). The cache directory
// is 0700 and store.sqlite 0600. Ported from sibling @cf3b015, adapted (no attach loop; ESPN tables).
import { lstatSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { assertSecureFile, ensureSecureDir, PathSecurityError } from "../config/paths.js";
import type { Clock } from "../domain/clock.js";
import type { NflPlayersReader } from "../domain/crosswalk/types.js";
import { preMigrationBackupPath, prunePreMigrationBackups, vacuumInto } from "./backup.js";
import { DatasetConnections } from "./datasets/connections.js";
import { createReaders } from "./datasets/readers.js";
import { acquireLock, acquireLockSync, lockPathOf } from "./lock.js";
import {
  applyMigrations,
  MIGRATIONS,
  readSchemaVersion,
  targetVersion,
  type Migration,
} from "./migrations/index.js";
import { createPseudonymizer } from "./pseudonym.js";
import { espnCacheRepository, pointsCacheRepository } from "./repos/caches.js";
import type { RepoDeps } from "./repos/common.js";
import { credentialStateRepository } from "./repos/credential.js";
import { crosswalkRepository } from "./repos/crosswalk.js";
import { driftStateRepository, probeLogRepository } from "./repos/drift.js";
import {
  leagueSettingsRepository,
  poolSnapshotRepository,
  rosterSnapshotRepository,
  scoreboardSnapshotRepository,
  transactionsSeenRepository,
} from "./repos/league.js";
import { limiterRepository } from "./repos/limiter.js";
import { jobLockRepository, refreshLogRepository, writeJournalRepository } from "./repos/ops.js";
import { espnProjectionRepository, projectionRepository } from "./repos/projection.js";
import { recommendationLogRepository } from "./repos/reclog.js";
import { createPrivateFile, openStoreConnection, StatementGuard, WriteExecutor } from "./sqlite.js";
import {
  BEST_EFFORT_BUSY_MS,
  BUSY_TIMEOUT_MS,
  StoreMigrationPendingError,
  StoreVersionError,
  type BackupResult,
  type Store,
  type StoreOpenOptions,
  type StoreRepositories,
} from "./types.js";

/** Test/tooling hooks (not part of the StoreFactory contract). */
export interface StoreInternals {
  /** The migration list (default MIGRATIONS); tests inject a synthetic 002. */
  readonly migrations?: readonly Migration[];
  /** busy_timeout for required writes (default BUSY_TIMEOUT_MS); tests shorten it. */
  readonly busyTimeoutMs?: number;
  /** The best-effort wait (default BEST_EFFORT_BUSY_MS). */
  readonly bestEffortMs?: number;
}

/** An open store's internals (diagnostics, prune and tests; never handed to src/mcp). */
export interface StoreInternalsView {
  readonly db: DatabaseSync;
  readonly guard: StatementGuard;
  readonly connections: DatasetConnections;
  readonly writes: WriteExecutor;
  readonly deps: RepoDeps;
  readonly datasetDir: string;
  readonly backupDir: string;
  readonly nflPlayers: NflPlayersReader;
}

const internalsByStore = new WeakMap<object, StoreInternalsView>();

/** The internals of an open store (null for anything else). */
export function storeInternalsOf(store: Store): StoreInternalsView | null {
  return internalsByStore.get(store) ?? null;
}

/** The statement guard of an open store — the statement trace (tests, `eff doctor`). */
export function statementGuardOf(store: Store): StatementGuard | null {
  return internalsByStore.get(store)?.guard ?? null;
}

/**
 * The nflverse players port of an open store (the crosswalk's id fallback, research 04 §C step 2;
 * READER_QUERIES["NflPlayersReader.byEspnIds"]). Structurally the crosswalk's NflPlayersReader.
 */
export function nflPlayersReaderOf(store: Store): NflPlayersReader | null {
  return internalsByStore.get(store)?.nflPlayers ?? null;
}

/** Refuses anything but an absolute path without NUL. */
export function assertAbsolute(p: unknown, what: string): string {
  if (typeof p !== "string" || !path.isAbsolute(p) || p.includes("\0"))
    throw new PathSecurityError("relative", String(p), what);
  return p;
}

/**
 * Prepares the store file: its directory 0700 (created), the file 0600 (created exclusively when
 * absent, else refused when a symlink, not regular, not ours or group/other-accessible); the -wal,
 * -shm and -journal sidecars must not be symlinks either.
 */
export function prepareStoreFile(storePath: string): void {
  assertAbsolute(storePath, "store file");
  ensureSecureDir(path.dirname(storePath), { create: true, what: "cache directory" });
  if (!createPrivateFile(storePath)) assertSecureFile(storePath, "store file");
  for (const side of ["-wal", "-shm", "-journal"]) {
    let link = false;
    try {
      link = lstatSync(storePath + side).isSymbolicLink();
    } catch {
      link = false;
    }
    if (link) throw new PathSecurityError("symlink", storePath + side, "store file");
  }
}

/**
 * Opens (and when asked, migrates) a store-role connection: refuses a newer schema, refuses a
 * pending migration without `migrate`, else — under the process lock — backs up (version > 0) by
 * VACUUM INTO and migrates forward, pruning backups beyond the last two versions.
 */
export function openMigrated(opts: {
  readonly path: string;
  readonly backupDir: string;
  readonly clock: Clock;
  readonly migrate: boolean;
  readonly migrations: readonly Migration[];
  readonly guard: StatementGuard;
  readonly busyMs: number;
}): { db: DatabaseSync; version: number } {
  prepareStoreFile(opts.path);
  const db = openStoreConnection(opts.path, opts.guard, opts.busyMs);
  try {
    const target = targetVersion(opts.migrations);
    let v = readSchemaVersion(db);
    if (v > target) throw new StoreVersionError(v, target);
    if (v < target) {
      if (!opts.migrate) throw new StoreMigrationPendingError(v, target);
      const lock = acquireLockSync(lockPathOf(opts.path));
      try {
        v = readSchemaVersion(db);
        if (v > target) throw new StoreVersionError(v, target);
        if (v < target) {
          if (v > 0) {
            ensureSecureDir(opts.backupDir, { create: true, what: "backup directory" });
            vacuumInto(
              db,
              preMigrationBackupPath(opts.backupDir, v, opts.clock.nowMs()),
              opts.guard,
            );
          }
          applyMigrations(db, opts.migrations, () => opts.clock.nowIso());
          if (v > 0) prunePreMigrationBackups(opts.backupDir);
          v = readSchemaVersion(db);
        }
      } finally {
        lock.release();
      }
    }
    return { db, version: v };
  } catch (e) {
    opts.guard.forget(db);
    db.close();
    throw e;
  }
}

function buildRepos(deps: RepoDeps): StoreRepositories {
  return Object.freeze({
    espnCache: espnCacheRepository(deps),
    limiter: limiterRepository(deps),
    credentialState: credentialStateRepository(deps),
    driftState: driftStateRepository(deps),
    probeLog: probeLogRepository(deps),
    refreshLog: refreshLogRepository(deps),
    jobLock: jobLockRepository(deps),
    pointsCache: pointsCacheRepository(deps),
    leagueSettings: leagueSettingsRepository(deps),
    crosswalk: crosswalkRepository(deps),
    rosterSnapshots: rosterSnapshotRepository(deps),
    poolSnapshots: poolSnapshotRepository(deps),
    scoreboardSnapshots: scoreboardSnapshotRepository(deps),
    transactionsSeen: transactionsSeenRepository(deps),
    projections: projectionRepository(deps),
    espnProjections: espnProjectionRepository(deps),
    recommendationLog: recommendationLogRepository(deps),
    // PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; owner decision D11): reads of an empty table.
    writeJournal: writeJournalRepository(deps),
  });
}

/** StoreFactory.open. */
export function openStore(opts: StoreOpenOptions, internals: StoreInternals = {}): Store {
  assertAbsolute(opts.datasetDir, "dataset directory");
  assertAbsolute(opts.backupDir, "backup directory");
  const busyMs = internals.busyTimeoutMs ?? BUSY_TIMEOUT_MS;
  const guard = new StatementGuard();
  const { db, version } = openMigrated({
    path: opts.path,
    backupDir: opts.backupDir,
    clock: opts.clock,
    migrate: opts.migrate,
    migrations: internals.migrations ?? MIGRATIONS,
    guard,
    busyMs,
  });
  try {
    ensureSecureDir(opts.datasetDir, { create: true, what: "dataset directory" });
  } catch (e) {
    guard.forget(db);
    db.close();
    throw e;
  }
  const warn = (code: string): void => {
    try {
      opts.onWarning?.(code);
    } catch {
      // a throwing warning sink must never break a read
    }
  };
  const writes = new WriteExecutor(db, busyMs, internals.bestEffortMs ?? BEST_EFFORT_BUSY_MS);
  const deps: RepoDeps = {
    db,
    writes,
    clock: opts.clock,
    pseudonyms: createPseudonymizer(db),
    recordRawBodies: opts.recordRawBodies === true,
  };
  const repos = buildRepos(deps);
  const connections = new DatasetConnections({
    storeDb: db,
    datasetDir: opts.datasetDir,
    clock: opts.clock,
    guard,
    warn,
  });
  const readers = createReaders({
    connections,
    weatherFirst: opts.weatherSource ?? "open-meteo",
    warn,
  });
  let closed = false;

  const store: Store = {
    path: opts.path,
    schemaVersion: version,
    repos,
    datasets: readers.datasets,
    rosterWeekly: readers.rosterWeekly,
    playerUniverse: readers.playerUniverse,
    nflPlayers: readers.nflPlayers,
    reopenChangedDatasets: () => connections.reopenChanged(),
    async backup(destPath): Promise<BackupResult> {
      if (closed) throw new Error("store: closed");
      assertAbsolute(destPath, "backup file");
      ensureSecureDir(path.dirname(destPath), { create: true, what: "backup directory" });
      const lock = await acquireLock(lockPathOf(opts.path));
      try {
        vacuumInto(db, destPath, guard);
        return { path: destPath, bytes: statSync(destPath).size, taken_at: opts.clock.nowIso() };
      } finally {
        lock.release();
      }
    },
    stats() {
      let size = 0;
      for (const f of [opts.path, `${opts.path}-wal`]) {
        try {
          size += statSync(f).size;
        } catch {
          // no -wal right after a checkpoint(TRUNCATE)
        }
      }
      return {
        path: opts.path,
        size_bytes: size,
        schema_version: version,
        open_datasets: connections.list(),
        cache_misses_busy: writes.cacheMissesBusy,
      };
    },
    close() {
      if (closed) return;
      closed = true;
      connections.closeAll();
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        // another process holds the lock: the next opener checkpoints
      }
      guard.forget(db);
      db.close();
    },
  };
  internalsByStore.set(store, {
    db,
    guard,
    connections,
    writes,
    deps,
    datasetDir: opts.datasetDir,
    backupDir: opts.backupDir,
    nflPlayers: readers.nflPlayers,
  });
  return store;
}
