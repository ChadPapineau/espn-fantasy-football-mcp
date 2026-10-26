// job-state.ts — the small 0600 JSON file the launchd jobs share inside the cache dir (plan 06 §2:
// notifications rate-limited per job to one per 6 h, alarms "once per state change"; §1.4 the daily
// credential-check cap and the waiver-relative "working run"; ADV OBJ-16: the epoch-ms anchor is
// read at the previous run). Only numbers and fixed-vocabulary tokens are stored — never a value,
// a name or upstream text. A missing, foreign or malformed file reads as empty (fail open to "not
// notified yet", which can only repeat a notification, never hide one).
import { closeSync, constants as fsc, openSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { readSecureFile, writeSecureFileAtomic, ensureSecureDir } from "../config/paths.js";

/** The state file inside the cache dir. */
export const JOB_STATE_FILE = "job-state.json";
/** Largest state file read. */
export const JOB_STATE_MAX_BYTES = 64 * 1024;

const KEY_RE = /^[a-z0-9_.:-]{1,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_.:-]{0,64}$/;

/** One stored value: a finite number or a fixed-vocabulary token. */
export type JobStateValue = number | string;
/** The whole state: flat key → value. */
export type JobState = Readonly<Record<string, JobStateValue>>;

/** `<cache>/job-state.json`. */
export function jobStatePath(cacheDir: string): string {
  return path.join(cacheDir, JOB_STATE_FILE);
}

/** Reads the state (missing or malformed → {}); only valid keys and values survive. */
export function readJobState(cacheDir: string): Record<string, JobStateValue> {
  try {
    const text = readSecureFile(jobStatePath(cacheDir), {
      requirePrivate: true,
      maxBytes: JOB_STATE_MAX_BYTES,
      what: "job state",
    });
    if (text === null) return {};
    const v = JSON.parse(text) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    const out: Record<string, JobStateValue> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (!KEY_RE.test(k)) continue;
      if (typeof x === "number" && Number.isFinite(x)) out[k] = x;
      else if (typeof x === "string" && TOKEN_RE.test(x)) out[k] = x;
    }
    return out;
  } catch {
    return {};
  }
}

/** The lock file that serialises read-modify-write updates across concurrently running jobs. */
export const JOB_STATE_LOCK = `${JOB_STATE_FILE}.lock`;
/**
 * How long an update waits for the lock (an update holds it for one read plus one fsynced write —
 * milliseconds, more on a loaded or sleeping Mac), and when a lock is stale (a crashed writer).
 */
const LOCK_WAIT_MS = 15_000;
const LOCK_STALE_MS = 30_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs `fn` holding `<cache>/job-state.json.lock` (O_EXCL; a lock older than LOCK_STALE_MS is
 * broken). Several launchd jobs wake on the same minute (the hourly pool snapshot, the pre-kickoff
 * check and the game-day roster snapshot at :00): without the lock two read-modify-write updates
 * could interleave and one job's keys — a waiver anchor, a run record — be lost. Without the lock
 * after LOCK_WAIT_MS the update still runs (fail open: an update is never refused; a key lost then
 * is written again by the job's next run).
 */
function withStateLock<T>(cacheDir: string, fn: () => T): T {
  const lock = path.join(cacheDir, JOB_STATE_LOCK);
  const until = Date.now() + LOCK_WAIT_MS;
  let held = false;
  for (;;) {
    try {
      closeSync(openSync(lock, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600));
      held = true;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") break;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true });
      } catch {
        // gone in between: retry
      }
      if (Date.now() >= until) break;
      sleepSync(10);
    }
  }
  try {
    return fn();
  } finally {
    if (held) rmSync(lock, { force: true });
  }
}

/**
 * Merges `patch` into the state and writes it atomically (0600; the cache dir created 0700), under
 * the cross-process state lock. A key with `null` is removed. Invalid keys or values are dropped.
 * Never throws: a lost stamp can only repeat a notification or a working run's check.
 */
export function updateJobState(
  cacheDir: string,
  patch: Readonly<Record<string, JobStateValue | null>>,
): boolean {
  return updateJobStateWith(cacheDir, () => patch);
}

/** As `updateJobState`, with the patch computed from the current state inside the lock. */
export function updateJobStateWith(
  cacheDir: string,
  patchOf: (state: JobState) => Readonly<Record<string, JobStateValue | null>>,
): boolean {
  try {
    ensureSecureDir(cacheDir, { create: true, what: "cache dir" });
    return withStateLock(cacheDir, () => writePatch(cacheDir, patchOf(readJobState(cacheDir))));
  } catch {
    return false;
  }
}

function writePatch(
  cacheDir: string,
  patch: Readonly<Record<string, JobStateValue | null>>,
): boolean {
  try {
    const cur = new Map(Object.entries(readJobState(cacheDir)));
    for (const [k, v] of Object.entries(patch)) {
      if (!KEY_RE.test(k)) continue;
      if (v === null) cur.delete(k);
      else if (typeof v === "number" && Number.isFinite(v)) cur.set(k, v);
      else if (typeof v === "string" && TOKEN_RE.test(v)) cur.set(k, v);
    }
    ensureSecureDir(cacheDir, { create: true, what: "cache dir" });
    writeSecureFileAtomic(
      jobStatePath(cacheDir),
      `${JSON.stringify(Object.fromEntries(cur))}\n`,
      "job state",
    );
    return true;
  } catch {
    return false;
  }
}

/** A number from the state, or null. */
export function stateNumber(s: JobState, key: string): number | null {
  const v = s[key];
  return typeof v === "number" ? v : null;
}

/** A token from the state, or null. */
export function stateToken(s: JobState, key: string): string | null {
  const v = s[key];
  return typeof v === "string" ? v : null;
}

// --- the notification log (plan 06 §2: "Every notification's text is also a refresh_log.note so
// `eff status` shows what was said") -----------------------------------------------------------------
//
// refresh_log is keyed by dataset source and has no note column, so what the jobs said lives here:
// the newest NOTIFICATION_LOG_MAX notifications, each its server-authored, redacted text (fixed
// vocabulary and numbers — notify.ts safeNotificationText), its kind and whether it was shown. A
// notification the owner missed (Focus, notifications off for osascript, a sleeping Mac) is still in
// `eff status` (Stage C finding notify-text-not-recorded). Written under the job-state lock, 0600.

/** The notification log inside the cache dir. */
export const NOTIFICATION_LOG_FILE = "notifications.json";
/** How many notifications the log keeps (the newest). */
export const NOTIFICATION_LOG_MAX = 20;
/** The longest text kept (notify.ts NOTIFY_MAX_CHARS, plus the marker a cut text carries). */
const NOTE_MAX_CHARS = 256;
const NOTE_CONTROL_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}]/u;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/** One notification as the log keeps it. */
export interface NotificationRecord {
  readonly at: string;
  readonly kind: "info" | "alarm" | "failure";
  /** The text as it was sent (already redacted, control-free, capped). */
  readonly text: string;
  /** `shown`: osascript showed it; `not_shown`: it failed, or this platform has no channel. */
  readonly shown: "shown" | "not_shown";
}

/** `<cache>/notifications.json`. */
export function notificationLogPath(cacheDir: string): string {
  return path.join(cacheDir, NOTIFICATION_LOG_FILE);
}

function validRecord(x: unknown): NotificationRecord | null {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return null;
  const r = x as Record<string, unknown>;
  if (typeof r.at !== "string" || !ISO_RE.test(r.at)) return null;
  if (r.kind !== "info" && r.kind !== "alarm" && r.kind !== "failure") return null;
  if (typeof r.text !== "string" || r.text.length === 0 || r.text.length > NOTE_MAX_CHARS)
    return null;
  if (NOTE_CONTROL_RE.test(r.text)) return null;
  if (r.shown !== "shown" && r.shown !== "not_shown") return null;
  return { at: r.at, kind: r.kind, text: r.text, shown: r.shown };
}

/** The logged notifications, newest first (missing or malformed → []; a bad entry is dropped). */
export function readNotifications(cacheDir: string): NotificationRecord[] {
  try {
    const text = readSecureFile(notificationLogPath(cacheDir), {
      requirePrivate: true,
      maxBytes: JOB_STATE_MAX_BYTES,
      what: "notification log",
    });
    if (text === null) return [];
    const v = JSON.parse(text) as unknown;
    const items =
      typeof v === "object" && v !== null && !Array.isArray(v)
        ? (v as { items?: unknown }).items
        : null;
    if (!Array.isArray(items)) return [];
    return items
      .map(validRecord)
      .filter((r): r is NotificationRecord => r !== null)
      .slice(0, NOTIFICATION_LOG_MAX);
  } catch {
    return [];
  }
}

/**
 * Prepends one notification to the log (the newest NOTIFICATION_LOG_MAX kept), under the job-state
 * lock. `text` must already be the sent text (redacted, control-free); anything else is dropped.
 * Never throws: a lost record never stops a job.
 */
export function recordNotification(cacheDir: string, r: NotificationRecord): boolean {
  if (validRecord(r) === null) return false;
  try {
    ensureSecureDir(cacheDir, { create: true, what: "cache dir" });
    return withStateLock(cacheDir, () => {
      const items = [r, ...readNotifications(cacheDir)].slice(0, NOTIFICATION_LOG_MAX);
      writeSecureFileAtomic(
        notificationLogPath(cacheDir),
        `${JSON.stringify({ items })}\n`,
        "notification log",
      );
      return true;
    });
  } catch {
    return false;
  }
}

// --- job run records (plan 06 J2 "one … row per run … plus `eff status`": failure must be visible
// without reading logs; §1.4 a 401 is a recorded failure; §3 `eff status` / doctor #11) -------------
//
// The credentialed jobs have no dataset source, so refresh_log (keyed by dataset source) cannot hold
// their runs; each run is recorded here instead, under fixed keys: `run.<job>.at` (epoch ms of the
// last run that did work or failed), `.ok` (1/0), `.error` (a fixed-vocabulary code), `.fails`
// (consecutive failures) and `.idle_at` (the last wake that had nothing to do — proof the job runs).

/** One job's last recorded run (numbers and fixed-vocabulary codes only). */
export interface JobRunRecord {
  readonly job: string;
  readonly last_run_at: string | null;
  readonly ok: boolean | null;
  readonly error: string | null;
  readonly consecutive_failures: number;
  readonly last_idle_at: string | null;
}

const JOB_KEY_RE = /^[a-z][a-z0-9-]{0,40}$/;
const CODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Records one run of `job`: a worked run (ok) or a failure (with its code). Never throws. */
export function recordJobRun(
  cacheDir: string,
  job: string,
  atMs: number,
  outcome: { readonly ok: true } | { readonly ok: false; readonly error: string },
): boolean {
  if (!JOB_KEY_RE.test(job)) return false;
  return updateJobStateWith(cacheDir, (state) =>
    outcome.ok
      ? {
          [`run.${job}.at`]: atMs,
          [`run.${job}.ok`]: 1,
          [`run.${job}.error`]: null,
          [`run.${job}.fails`]: 0,
        }
      : {
          [`run.${job}.at`]: atMs,
          [`run.${job}.ok`]: 0,
          [`run.${job}.error`]: CODE_RE.test(outcome.error) ? outcome.error : "error",
          [`run.${job}.fails`]: (stateNumber(state, `run.${job}.fails`) ?? 0) + 1,
        },
  );
}

/** Records a wake of `job` that had nothing to do (the job is alive; the last run is kept). */
export function recordJobIdle(cacheDir: string, job: string, atMs: number): boolean {
  if (!JOB_KEY_RE.test(job)) return false;
  return updateJobState(cacheDir, { [`run.${job}.idle_at`]: atMs });
}

/** The recorded runs of `jobs` (a job never recorded has nulls). */
export function jobRunRecords(state: JobState, jobs: readonly string[]): JobRunRecord[] {
  const iso = (ms: number | null): string | null =>
    ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString();
  return jobs.map((job) => {
    const ok = stateNumber(state, `run.${job}.ok`);
    return {
      job,
      last_run_at: iso(stateNumber(state, `run.${job}.at`)),
      ok: ok === null ? null : ok === 1,
      error: stateToken(state, `run.${job}.error`),
      consecutive_failures: stateNumber(state, `run.${job}.fails`) ?? 0,
      last_idle_at: iso(stateNumber(state, `run.${job}.idle_at`)),
    };
  });
}
