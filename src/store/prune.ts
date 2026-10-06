// prune.ts — `eff store prune` (plan 06 §1.3; plan 01 §5.5, §5.8): the ESPN cache past its longest
// finite hard limit, roster/pool snapshots older than 30 days, the bounded points_cache LRU,
// espn_requests past ESPN_REQUEST_ROW_TTL_MS (changelog V7), staging debris and dataset files
// refresh_log could never name, and backups beyond two versions / four weeks. NEVER touches the
// never-pruned tables (T-07): the only DELETE targets are the PRUNE_POLICY tables, asserted below.
import { lstatSync, readdirSync, rmSync, type Stats } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DATASET_SOURCE_IDS, type DatasetSourceId } from "../config/freshness.js";
import { datasetFileStem } from "../config/paths.js";
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
  /** Also sweep dataset debris and old backups (default true). */
  readonly files?: boolean;
}

/** What was removed. */
export interface PruneReport {
  readonly rows: Readonly<Record<(typeof PRUNE_TARGETS)[number], number>>;
  /** Basenames removed from the dataset directory. */
  readonly files_removed: readonly string[];
  /** Basenames removed from the backup directory. */
  readonly backups_removed: readonly string[];
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
  }
  return { rows, files_removed: filesRemoved.sort(), backups_removed: backupsRemoved.sort() };
}
