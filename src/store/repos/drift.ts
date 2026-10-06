// drift.ts — `drift_state` (one row: status, since, last probe, manifest hash/version, host, the
// stored diff and additive-drift lists — plan 01 §7) and `probe_log` (one row per probe; `doctor` #9
// reads the last success). Both required writes; error fields are fixed-vocabulary codes only.
import { DRIFT_STATUSES } from "../../config/schema.js";
import type {
  DriftStateRepository,
  DriftStateRow,
  ProbeLogRepository,
  ProbeLogRow,
} from "../types.js";
import {
  bool,
  intIn,
  isoMs,
  isoMsOrNull,
  keyString,
  matching,
  num,
  oneOf,
  type RepoDeps,
} from "./common.js";

/** A host name as drift_state records it (lowercase DNS name). */
export const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
/** A fixed-vocabulary probe error summary (never upstream text). */
export const PROBE_ERROR_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
/** Largest stored diff / additive list (JSON). */
export const DRIFT_JSON_MAX = 1024 * 1024;
/** Largest `recent` page. */
export const PROBE_RECENT_MAX = 1000;

function checkJson(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length > DRIFT_JSON_MAX)
    throw new RangeError(`store: ${what} too large`);
  try {
    JSON.parse(v);
  } catch {
    throw new RangeError(`store: ${what} must be JSON`);
  }
  return v;
}

function checkDrift(row: DriftStateRow): void {
  oneOf(row.status, DRIFT_STATUSES, "drift status");
  isoMsOrNull(row.since, "since");
  isoMsOrNull(row.last_probe_at, "last_probe_at");
  if (row.manifest_hash !== null) keyString(row.manifest_hash, "manifest_hash", 128);
  if (row.manifest_version !== null) intIn(row.manifest_version, 0, 1_000_000, "manifest_version");
  matching(row.host, HOST_RE, "host");
  isoMsOrNull(row.host_moved_at, "host_moved_at");
  checkJson(row.diff_json, "diff_json");
  checkJson(row.additive_json, "additive_json");
  isoMs(row.updated_at, "updated_at");
}

interface DriftRow {
  status: string;
  since: string | null;
  last_probe_at: string | null;
  manifest_hash: string | null;
  manifest_version: number | null;
  host: string;
  host_moved_at: string | null;
  diff_json: string;
  additive_json: string;
  updated_at: string;
}

export function driftStateRepository({ db, writes }: RepoDeps): DriftStateRepository {
  return {
    get() {
      const r = db.prepare("SELECT * FROM drift_state WHERE id = 1").get() as DriftRow | undefined;
      if (r === undefined) return null;
      return {
        status: r.status as DriftStateRow["status"],
        since: r.since,
        last_probe_at: r.last_probe_at,
        manifest_hash: r.manifest_hash,
        manifest_version: r.manifest_version === null ? null : num(r.manifest_version),
        host: r.host,
        host_moved_at: r.host_moved_at,
        diff_json: r.diff_json,
        additive_json: r.additive_json,
        updated_at: r.updated_at,
      };
    },
    put(row) {
      checkDrift(row);
      writes.required("drift_state", () => {
        db.prepare(
          `INSERT OR REPLACE INTO drift_state (id, status, since, last_probe_at, manifest_hash, manifest_version,
             host, host_moved_at, diff_json, additive_json, updated_at)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          row.status,
          row.since,
          row.last_probe_at,
          row.manifest_hash,
          row.manifest_version,
          row.host,
          row.host_moved_at,
          row.diff_json,
          row.additive_json,
          row.updated_at,
        );
      });
    },
  };
}

interface ProbeRow {
  at: string;
  kind: string;
  ok: number;
  status: string;
  upstream_status: number | null;
  error: string | null;
}

const toProbe = (r: ProbeRow): ProbeLogRow => ({
  at: r.at,
  kind: r.kind as ProbeLogRow["kind"],
  ok: num(r.ok) === 1,
  status: r.status as ProbeLogRow["status"],
  upstream_status: r.upstream_status === null ? null : num(r.upstream_status),
  error: r.error,
});

export function probeLogRepository({ db, writes }: RepoDeps): ProbeLogRepository {
  return {
    record(row) {
      const ms = isoMs(row.at, "at");
      oneOf(row.kind, ["host", "shape"] as const, "probe kind");
      bool(row.ok, "ok");
      oneOf(row.status, DRIFT_STATUSES, "drift status");
      if (row.upstream_status !== null) intIn(row.upstream_status, 100, 599, "upstream_status");
      if (row.error !== null) matching(row.error, PROBE_ERROR_RE, "probe error");
      writes.required("probe_log", () => {
        db.prepare(
          "INSERT INTO probe_log (at, at_ms, kind, ok, status, upstream_status, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(row.at, ms, row.kind, row.ok ? 1 : 0, row.status, row.upstream_status, row.error);
      });
    },
    lastSuccess(kind) {
      const r = db
        .prepare(
          "SELECT * FROM probe_log WHERE kind = ? AND ok = 1 ORDER BY at_ms DESC, id DESC LIMIT 1",
        )
        .get(kind) as ProbeRow | undefined;
      return r === undefined ? null : toProbe(r);
    },
    recent(limit) {
      const lim = intIn(limit, 1, PROBE_RECENT_MAX, "limit");
      return (
        db
          .prepare("SELECT * FROM probe_log ORDER BY at_ms DESC, id DESC LIMIT ?")
          .all(lim) as unknown as ProbeRow[]
      ).map(toProbe);
    },
  };
}
