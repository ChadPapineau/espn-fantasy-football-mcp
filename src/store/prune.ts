// prune.ts — `eff store prune` (plan 06 §1.3; plan 01 §5.5, §5.8): the ESPN cache past its longest
// finite hard limit, roster/pool snapshots older than 30 days, the bounded points_cache LRU,
// espn_requests past ESPN_REQUEST_ROW_TTL_MS (changelog V7), staging debris and dataset files
// refresh_log could never name, backups beyond two versions / four weeks, and the temp files of a
// killed run (`<cache>/tmp/<prefix>-XXXXXX` untouched for a day — Stage C, store-prune-skips-tmp-runs).
// NEVER touches the never-pruned tables (T-07): the only DELETE targets are the PRUNE_POLICY tables,
// asserted below.
import { lstatSync, readdirSync, rmSync, type Stats } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DATASET_SOURCE_IDS, type DatasetSourceId } from "../config/freshness.js";
import {
  backupDir as backupDirOf,
  datasetDir as datasetDirOf,
  datasetFileStem,
  ensureSecureDir,
  runTempDir as runTempDirOf,
  storePath as storePathOf,
} from "../config/paths.js";
import { ESPN_REQUEST_ROW_TTL_MS } from "../config/schema.js";
import type { IsoInstant } from "../domain/league/types.js";
import { prunePreMigrationBackups, pruneWeeklyBackups } from "./backup.js";
import { pidAlive } from "./lock.js";
import { publishJob, PUBLISH_LOCK_STALE_MS } from "./publisher.js";
import { intIn, isoMs, num } from "./repos/common.js";
import { storeInternalsOf } from "./store.js";
import { NEVER_PRUNED_TABLES, PRUNE_POLICY, type Store, type StoreTable } from "./types.js";

/** The longest finite ESPN hard limit (settings, season views: 7 days — plan 01 §5.4). */
export const ESPN_CACHE_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;
/** Roster and pool snapshots are kept 30 days (plan 06 §1.3). */
export const SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** The points_cache LRU bound (rows kept, newest by last write). */
export const POINTS_CACHE_MAX_ROWS = 50_000;
/**
 * A run directory under `<cache>/tmp` whose newest entry is older than this is the debris of a killed
 * run (SIGKILL, a launchd timeout, a reboot — the runner removes its directory on every path it
 * controls). A live refresh writes into its run directory as it downloads, and no run lasts a day.
 */
export const RUN_TEMP_STALE_MS = 24 * 60 * 60 * 1000;
/**
 * A run directory's name: `mkdtemp`'s `<prefix>-XXXXXX` (src/sources/runner.ts fsTempArea,
 * `eff backup --to`'s staging, the self-test) — the shape `eff uninstall` purges.
 */
export const RUN_TEMP_ENTRY_RE = /^[A-Za-z0-9_]{1,80}-[A-Za-z0-9]{6}$/;
/** Entries one run directory's freshness walk visits at most; past it the directory is kept. */
export const RUN_TEMP_WALK_MAX = 10_000;
/** Depth the freshness walk descends at most; deeper trees are kept. */
const RUN_TEMP_DEPTH_MAX = 8;

/** The tables `pruneStore` deletes from — exactly the PRUNE_POLICY tables. */
export const PRUNE_TARGETS = Object.freeze([
  "espn_cache",
  "points_cache",
  "roster_snapshot",
  "pool_snapshot",
  "espn_requests",
] as const satisfies readonly StoreTable[]);

for (const t of PRUNE_TARGETS) {
  if (PRUNE_POLICY[t] === undefined || NEVER_PRUNED_TABLES.includes(t))
    throw new Error(`store: ${t} is not a prunable table`);
}

/** What to prune (every field defaults to the plan's value). */
export interface PruneOptions {
  /** The instant ages are measured from (default: the store clock). */
  readonly now?: IsoInstant;
  readonly espnCacheMaxAgeMs?: number;
  readonly snapshotMaxAgeMs?: number;
  readonly requestRowTtlMs?: number;
  readonly pointsCacheMaxRows?: number;
  /** Also sweep dataset debris, old backups and stale run directories (default true). */
  readonly files?: boolean;
  /**
   * The run temp directory (`<cache>/tmp`) whose stale run directories are swept. Default: the one
   * of the cache directory that holds this store, its datasets and its backups in the config/paths
   * layout (none when the store is laid out otherwise); null skips the sweep.
   */
  readonly runTempDir?: string | null;
  /** How long a run directory must be untouched before it is swept (default RUN_TEMP_STALE_MS). */
  readonly runTempMaxAgeMs?: number;
}

/** What was removed. */
export interface PruneReport {
  readonly rows: Readonly<Record<(typeof PRUNE_TARGETS)[number], number>>;
  /** Basenames removed from the dataset directory. */
  readonly files_removed: readonly string[];
  /** Basenames removed from the backup directory. */
  readonly backups_removed: readonly string[];
  /** Basenames of the stale run directories removed from the run temp directory (whole trees). */
  readonly temp_runs_removed: readonly string[];
}

const DAY = 24 * 60 * 60 * 1000;
const STEMS: ReadonlyMap<string, DatasetSourceId> = new Map(
  DATASET_SOURCE_IDS.map((s) => [datasetFileStem(s), s] as const),
);
const DATASET_FILE_RE = /^([a-z][a-z0-9_]*__[a-z][a-z0-9_]*)\.sqlite(-journal|-wal|-shm)?$/;
const DEBRIS_RE = /^([a-z][a-z0-9_]*__[a-z][a-z0-9_]*)\..*\.tmp(-journal)?$/;

/** Whether a publish of `source` may be in progress (its job lock is live and fresh). */
function publishInProgress(db: DatabaseSync, source: DatasetSourceId, nowMs: number): boolean {
  const r = db
    .prepare("SELECT pid, acquired_ms FROM job_lock WHERE job = ?")
    .get(publishJob(source)) as { pid: number; acquired_ms: number } | undefined;
  return (
    r !== undefined && pidAlive(num(r.pid)) && nowMs - num(r.acquired_ms) <= PUBLISH_LOCK_STALE_MS
  );
}

/** `<cache>/tmp` when the store, its datasets and its backups sit in one cache dir's layout. */
function layoutRunTempDir(store: string, datasets: string, backups: string): string | null {
  const cache = path.dirname(store);
  return storePathOf(cache) === store &&
    datasetDirOf(cache) === datasets &&
    backupDirOf(cache) === backups
    ? runTempDirOf(cache)
    : null;
}

/**
 * The newest mtime in the tree at `dir` (lstat: a symlink is judged by itself, never followed);
 * null when the walk passes RUN_TEMP_WALK_MAX entries or RUN_TEMP_DEPTH_MAX levels or any entry
 * cannot be read — the caller then keeps the directory (judged live).
 */
function newestMtimeMs(dir: string): number | null {
  let newest = 0;
  let visited = 0;
  const stack: { p: string; depth: number }[] = [{ p: dir, depth: 0 }];
  try {
    for (let cur = stack.pop(); cur !== undefined; cur = stack.pop()) {
      if (++visited > RUN_TEMP_WALK_MAX) return null;
      const st = lstatSync(cur.p);
      newest = Math.max(newest, st.mtimeMs);
      if (!st.isDirectory()) continue;
      if (cur.depth >= RUN_TEMP_DEPTH_MAX) return null;
      for (const n of readdirSync(cur.p))
        stack.push({ p: path.join(cur.p, n), depth: cur.depth + 1 });
    }
  } catch {
    return null;
  }
  return newest;
}

/** Whether `st` is a directory this user made private (mkdtemp's 0700), never a symlink. */
function isOwnPrivateDir(st: Stats): boolean {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  return st.isDirectory() && (uid === null || st.uid === uid) && (st.mode & 0o077) === 0;
}

/**
 * Removes the run directories under `tmp` untouched for `maxAgeMs` (plan 06 §1.3 "temp files"): a
 * name of the run shape, a private directory of this user, and no entry in its tree modified within
 * the bound (a live run's downloads keep it fresh; a future mtime counts as fresh). Never follows a
 * symlink, never touches another entry, and skips the sweep entirely when `tmp` is not this user's
 * private directory. Returns the basenames removed.
 */
function sweepRunTemp(tmp: string, nowMs: number, maxAgeMs: number): string[] {
  try {
    ensureSecureDir(tmp, { create: false, what: "run temp directory" });
  } catch {
    return []; // absent (no run ever made it), or not ours to judge
  }
  let names: string[];
  try {
    names = readdirSync(tmp);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const n of names) {
    if (!RUN_TEMP_ENTRY_RE.test(n)) continue;
    const p = path.join(tmp, n);
    let st: Stats;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (!isOwnPrivateDir(st)) continue;
    const newest = newestMtimeMs(p);
    if (newest === null || nowMs - newest <= maxAgeMs) continue;
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      continue; // a tree we cannot fully remove (a read-only subdirectory) never fails the prune
    }
    removed.push(n);
  }
  return removed.sort();
}

/** Runs one prune pass over an open store. */
export function pruneStore(store: Store, opts: PruneOptions = {}): PruneReport {
  const internals = storeInternalsOf(store);
  if (internals === null) throw new Error("store: not an open store");
  const { db, writes, deps } = internals;
  const nowMs = opts.now === undefined ? deps.clock.nowMs() : isoMs(opts.now, "now");
  const cacheAge = intIn(
    opts.espnCacheMaxAgeMs ?? ESPN_CACHE_PRUNE_MS,
    0,
    3650 * DAY,
    "espnCacheMaxAgeMs",
  );
  const snapAge = intIn(
    opts.snapshotMaxAgeMs ?? SNAPSHOT_RETENTION_MS,
    0,
    3650 * DAY,
    "snapshotMaxAgeMs",
  );
  const reqTtl = intIn(
    opts.requestRowTtlMs ?? ESPN_REQUEST_ROW_TTL_MS,
    0,
    3650 * DAY,
    "requestRowTtlMs",
  );
  const keep = intIn(
    opts.pointsCacheMaxRows ?? POINTS_CACHE_MAX_ROWS,
    0,
    100_000_000,
    "pointsCacheMaxRows",
  );
  const tempAge = intIn(
    opts.runTempMaxAgeMs ?? RUN_TEMP_STALE_MS,
    0,
    3650 * DAY,
    "runTempMaxAgeMs",
  );
  const tmp =
    opts.runTempDir === undefined
      ? layoutRunTempDir(store.path, internals.datasetDir, internals.backupDir)
      : opts.runTempDir;
  if (tmp !== null && (typeof tmp !== "string" || !path.isAbsolute(tmp)))
    throw new RangeError("store: runTempDir must be an absolute path or null");
  const del = (table: (typeof PRUNE_TARGETS)[number], sql: string, ...args: number[]): number =>
    writes.required(table, () => Number(db.prepare(sql).run(...args).changes));
  const rows = {
    espn_cache: del("espn_cache", "DELETE FROM espn_cache WHERE fetched_ms < ?", nowMs - cacheAge),
    points_cache: del(
      "points_cache",
      `DELETE FROM points_cache WHERE rowid NOT IN (
         SELECT rowid FROM points_cache ORDER BY used_ms DESC, rowid DESC LIMIT ?)`,
      keep,
    ),
    roster_snapshot: del(
      "roster_snapshot",
      "DELETE FROM roster_snapshot WHERE taken_ms < ?",
      nowMs - snapAge,
    ),
    pool_snapshot: del(
      "pool_snapshot",
      "DELETE FROM pool_snapshot WHERE taken_ms < ?",
      nowMs - snapAge,
    ),
    espn_requests: del("espn_requests", "DELETE FROM espn_requests WHERE ts < ?", nowMs - reqTtl),
  };
  const filesRemoved: string[] = [];
  const backupsRemoved: string[] = [];
  const tempRunsRemoved: string[] = [];
  if (opts.files !== false) {
    let names: string[] = [];
    try {
      names = readdirSync(internals.datasetDir);
    } catch {
      names = [];
    }
    for (const n of names) {
      const p = path.join(internals.datasetDir, n);
      let st: Stats;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (!st.isFile() && !st.isSymbolicLink()) continue; // never a directory
      const debris = DEBRIS_RE.exec(n);
      if (debris?.[1] !== undefined) {
        const source = STEMS.get(debris[1]);
        if (source === undefined || !publishInProgress(db, source, nowMs)) {
          rmSync(p, { force: true });
          filesRemoved.push(n);
        }
        continue;
      }
      const file = DATASET_FILE_RE.exec(n);
      if (file?.[1] === undefined) continue; // not ours to judge
      const known = STEMS.has(file[1]);
      // A dataset file of no known source can never be named by refresh_log; a sidecar beside a
      // published file never legitimately exists (published files are journal_mode=DELETE, closed).
      if (!known || file[2] !== undefined || st.isSymbolicLink()) {
        rmSync(p, { force: true });
        filesRemoved.push(n);
      }
    }
    backupsRemoved.push(...prunePreMigrationBackups(internals.backupDir));
    backupsRemoved.push(...pruneWeeklyBackups(internals.backupDir));
    if (tmp !== null) tempRunsRemoved.push(...sweepRunTemp(tmp, nowMs, tempAge));
  }
  return {
    rows,
    files_removed: filesRemoved.sort(),
    backups_removed: backupsRemoved.sort(),
    temp_runs_removed: tempRunsRemoved,
  };
}
