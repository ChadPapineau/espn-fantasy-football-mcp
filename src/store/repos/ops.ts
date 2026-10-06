// ops.ts — the operational tables: refresh_log (plan 01 §5.5 which dataset file version is current;
// plan 06 J2; the release age basis is `checked_at`), job_lock (single-flight jobs across processes,
// plan 06 §1.3) and write_journal (PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; owner decision
// D11): read-only counts for `espn_get_status.journal`; nothing in this build writes it). Ported from
// sibling @cf3b015, adapted (synchronous repositories; SourceErrorCode errors).
import {
  isDatasetSourceId,
  isSourceErrorCode,
  type DatasetSourceId,
} from "../../config/freshness.js";
import type { JournalState, WriteJournalRepository } from "../../domain/gate/types.js";
import { JOURNAL_STATES } from "../../domain/gate/types.js";
import { pidAlive } from "../lock.js";
import type { JobLockRepository, RefreshLogRepository, RefreshLogRow } from "../types.js";
import { intIn, isoMs, isoMsOrNull, keyString, num, parseJson, type RepoDeps } from "./common.js";

interface RefreshRow {
  source: string;
  file: string | null;
  file_version: string | null;
  release_updated_at: string | null;
  seasons_json: string;
  rows: number | null;
  columns_hash: string | null;
  started_at: string;
  finished_at: string;
  ok: number;
  error: string | null;
  checked_at: string;
}

const toRefresh = (r: RefreshRow): RefreshLogRow => ({
  source: r.source as DatasetSourceId,
  file: r.file,
  file_version: r.file_version,
  release_updated_at: r.release_updated_at,
  seasons: parseJson<number[]>(r.seasons_json),
  rows: r.rows === null ? null : num(r.rows),
  columns_hash: r.columns_hash,
  started_at: r.started_at,
  finished_at: r.finished_at,
  ok: num(r.ok) === 1,
  error: isSourceErrorCode(r.error) ? r.error : r.error === null ? null : "INTERNAL",
  checked_at: r.checked_at,
});

/** Longest file_version (a release stamp or a time bucket). */
export const VERSION_MAX = 128;

/** Validates a refresh_log row before it is written. */
export function checkRefreshRow(row: RefreshLogRow): void {
  if (typeof row.source !== "string" || !isDatasetSourceId(row.source))
    throw new RangeError("store: unknown dataset source");
  if (row.file !== null) keyString(row.file, "file", 4096);
  if (row.file_version !== null) keyString(row.file_version, "file_version", VERSION_MAX);
  isoMsOrNull(row.release_updated_at, "release_updated_at");
  if (!Array.isArray(row.seasons) || row.seasons.length > 64)
    throw new RangeError("store: seasons must be an array of at most 64 seasons");
  for (const s of row.seasons) intIn(s, 1990, 2100, "season");
  if (row.rows !== null) intIn(row.rows, 0, Number.MAX_SAFE_INTEGER, "rows");
  if (row.columns_hash !== null) keyString(row.columns_hash, "columns_hash", 128);
  isoMs(row.started_at, "started_at");
  isoMs(row.finished_at, "finished_at");
  isoMs(row.checked_at, "checked_at");
  if (typeof row.ok !== "boolean") throw new RangeError("store: ok must be a boolean");
  if (row.error !== null && !isSourceErrorCode(row.error))
    throw new RangeError("store: refresh_log error must be a SourceErrorCode");
  if (row.ok && (row.file === null || row.file_version === null))
    throw new RangeError("store: a successful refresh_log row names its file and version");
}

/** Inserts one refresh_log row (no validation, no busy mapping — callers wrap it). */
export function insertRefreshRow(deps: Pick<RepoDeps, "db">, row: RefreshLogRow): void {
  deps.db
    .prepare(
      `INSERT INTO refresh_log (source, file, file_version, release_updated_at, seasons_json, rows, columns_hash,
         started_at, finished_at, ok, error, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.source,
      row.file,
      row.file_version,
      row.release_updated_at,
      JSON.stringify(row.seasons),
      row.rows,
      row.columns_hash,
      row.started_at,
      row.finished_at,
      row.ok ? 1 : 0,
      row.error,
      row.checked_at,
    );
}

/** The newest successful refresh_log row of `source` (or null). */
export function currentRefreshRow(
  deps: Pick<RepoDeps, "db">,
  source: DatasetSourceId,
): RefreshLogRow | null {
  const r = deps.db
    .prepare("SELECT * FROM refresh_log WHERE source = ? AND ok = 1 ORDER BY id DESC LIMIT 1")
    .get(source) as RefreshRow | undefined;
  return r === undefined ? null : toRefresh(r);
}

/** The newest successful row of `source` naming `version` (the stamp of an open file). */
export function refreshRowFor(
  deps: Pick<RepoDeps, "db">,
  source: DatasetSourceId,
  version: string,
): RefreshLogRow | null {
  const r = deps.db
    .prepare(
      "SELECT * FROM refresh_log WHERE source = ? AND ok = 1 AND file_version = ? ORDER BY id DESC LIMIT 1",
    )
    .get(source, version) as RefreshRow | undefined;
  return r === undefined ? null : toRefresh(r);
}

/**
 * The unchanged-check write (plan 01 §5.5 skip path; the release age basis): advances `checked_at`
 * of the newest success row. When failures were recorded after it, the check is the recovery that
 * ends their streak: a copy of the success row with the new `checked_at` is appended, so
 * `consecutiveFailures` reads 0 and the newest row is a success (sib QA-1-037). No-op when the
 * source has no success row. Callers run it inside a required transaction.
 */
export function markCheckedRow(
  deps: Pick<RepoDeps, "db">,
  source: DatasetSourceId,
  checkedAt: string,
): void {
  const { db } = deps;
  const cur = db
    .prepare("SELECT id FROM refresh_log WHERE source = ? AND ok = 1 ORDER BY id DESC LIMIT 1")
    .get(source) as { id: number } | undefined;
  if (cur === undefined) return;
  const failedSince =
    db
      .prepare("SELECT 1 AS x FROM refresh_log WHERE source = ? AND id > ? LIMIT 1")
      .get(source, cur.id) !== undefined;
  if (failedSince)
    db.prepare(
      `INSERT INTO refresh_log (source, file, file_version, release_updated_at, seasons_json, rows,
         columns_hash, started_at, finished_at, ok, error, checked_at)
       SELECT source, file, file_version, release_updated_at, seasons_json, rows, columns_hash,
         started_at, finished_at, ok, error, ? FROM refresh_log WHERE id = ?`,
    ).run(checkedAt, cur.id);
  else db.prepare("UPDATE refresh_log SET checked_at = ? WHERE id = ?").run(checkedAt, cur.id);
}

export function refreshLogRepository(deps: RepoDeps): RefreshLogRepository {
  const { db, writes } = deps;
  return {
    record(row) {
      checkRefreshRow(row);
      writes.required("refresh_log", () => {
        insertRefreshRow(deps, row);
      });
    },
    current() {
      return (
        db
          .prepare(
            `SELECT r.* FROM refresh_log AS r
             WHERE r.ok = 1 AND r.id = (SELECT MAX(id) FROM refresh_log WHERE source = r.source AND ok = 1)
             ORDER BY r.source`,
          )
          .all() as unknown as RefreshRow[]
      )
        .filter((r) => isDatasetSourceId(r.source))
        .map(toRefresh);
    },
    latest(source) {
      const r = db
        .prepare("SELECT * FROM refresh_log WHERE source = ? ORDER BY id DESC LIMIT 1")
        .get(source) as RefreshRow | undefined;
      return r === undefined ? null : toRefresh(r);
    },
    consecutiveFailures(source) {
      return num(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM refresh_log WHERE source = :s AND ok = 0
               AND id > COALESCE((SELECT MAX(id) FROM refresh_log WHERE source = :s AND ok = 1), 0)`,
            )
            .get({ s: source }) as { n: number }
        ).n,
      );
    },
  };
}

/** Job names: `publish:<source>`, `snapshot:roster`, … (short codes, never free text). */
export const JOB_RE = /^[a-z][a-z0-9_:.-]{0,95}$/;
/** The longest staleness a caller may give (a week). */
export const JOB_STALE_MAX_MS = 7 * 86_400_000;

export function jobLockRepository({ db, writes }: RepoDeps): JobLockRepository {
  return {
    acquire(job, pid, now, staleAfterMs) {
      if (typeof job !== "string" || !JOB_RE.test(job))
        throw new RangeError("store: invalid job name");
      intIn(pid, 1, 2 ** 31 - 1, "pid");
      const nowMs = isoMs(now, "now");
      intIn(staleAfterMs, 0, JOB_STALE_MAX_MS, "staleAfterMs");
      return writes.requiredTx("job_lock", () => {
        const cur = db.prepare("SELECT pid, acquired_ms FROM job_lock WHERE job = ?").get(job) as
          { pid: number; acquired_ms: number } | undefined;
        const free =
          cur === undefined ||
          num(cur.pid) === pid ||
          nowMs - num(cur.acquired_ms) > staleAfterMs ||
          !pidAlive(num(cur.pid));
        if (!free) return false;
        db.prepare(
          "INSERT OR REPLACE INTO job_lock (job, pid, acquired_at, acquired_ms) VALUES (?, ?, ?, ?)",
        ).run(job, pid, now, nowMs);
        return true;
      });
    },
    release(job, pid) {
      if (typeof job !== "string" || !JOB_RE.test(job))
        throw new RangeError("store: invalid job name");
      intIn(pid, 1, 2 ** 31 - 1, "pid");
      writes.required("job_lock", () => {
        db.prepare("DELETE FROM job_lock WHERE job = ? AND pid = ?").run(job, pid);
      });
    },
  };
}

/** Journal states still awaiting an outcome (plan 02 §4.4): before a terminal state. */
export const PENDING_JOURNAL_STATES: readonly JournalState[] = Object.freeze([
  "prepared",
  "sent",
  "sent_unknown",
]);

/**
 * PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; owner decision D11). Reads of the empty
 * write_journal for `espn_get_status.journal`; this repository has no write method by design.
 */
export function writeJournalRepository({ db }: RepoDeps): WriteJournalRepository {
  return {
    countByStatus() {
      const rows = db
        .prepare("SELECT status, COUNT(*) AS n FROM write_journal GROUP BY status ORDER BY status")
        .all() as unknown as { status: string; n: number }[];
      const out: Partial<Record<JournalState, number>> = {};
      for (const r of rows)
        if ((JOURNAL_STATES as readonly string[]).includes(r.status))
          out[r.status as JournalState] = num(r.n);
      return out;
    },
    oldestPendingAgeSeconds(nowIso) {
      const nowMs = isoMs(nowIso, "now");
      const r = db
        .prepare(
          "SELECT MIN(created_ms) AS m FROM write_journal WHERE status IN (SELECT value FROM json_each(?))",
        )
        .get(JSON.stringify(PENDING_JOURNAL_STATES)) as { m: number | null };
      if (r.m === null) return null;
      return Math.max(0, Math.floor((nowMs - num(r.m)) / 1000));
    },
  };
}
