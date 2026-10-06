// job-state.ts — the small 0600 JSON file the launchd jobs share inside the cache dir (plan 06 §2:
// notifications rate-limited per job to one per 6 h, alarms "once per state change"; §1.4 the daily
// credential-check cap and the waiver-relative "working run"; ADV OBJ-16: the epoch-ms anchor is
// read at the previous run). Only numbers and fixed-vocabulary tokens are stored — never a value,
// a name or upstream text. A missing, foreign or malformed file reads as empty (fail open to "not
// notified yet", which can only repeat a notification, never hide one).
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

/**
 * Merges `patch` into the state and writes it atomically (0600; the cache dir created 0700). A
 * key with `null` is removed. Invalid keys or values are dropped. Never throws: a lost stamp can
 * only repeat a notification or a working run's check.
 */
export function updateJobState(
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
