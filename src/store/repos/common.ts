// common.ts — shared input checks for the store repositories (plan 01 §5.3: the store is the last
// line before disk — a malformed instant, key or number is a programming error and is refused, never
// silently stored). Ported from sibling @cf3b015, adapted (ESPN bounds; the pseudonymiser hook).
import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../../domain/clock.js";
import type { Pseudonymizer } from "../pseudonym.js";
import type { WriteExecutor } from "../sqlite.js";

/** What every repository is built from. */
export interface RepoDeps {
  readonly db: DatabaseSync;
  readonly writes: WriteExecutor;
  readonly clock: Clock;
  /** Rewrites brace-GUIDs in JSON bound for a snapshot/log column (plan 02 §2.4). */
  readonly pseudonyms: Pseudonymizer;
  /** Keep `espn_cache.raw_body` (fixture-recording mode only). */
  readonly recordRawBodies: boolean;
}

/** Longest ISO-8601 instant accepted. */
const ISO_MAX = 64;

/** Epoch ms of an ISO-8601 instant; RangeError when it is not one. */
export function isoMs(iso: unknown, what: string): number {
  if (typeof iso !== "string" || iso.length === 0 || iso.length > ISO_MAX)
    throw new RangeError(`store: ${what} must be an ISO-8601 instant`);
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new RangeError(`store: ${what} must be an ISO-8601 instant`);
  return ms;
}

/** `isoMs` for a nullable instant. */
export function isoMsOrNull(iso: unknown, what: string): number | null {
  return iso === null ? null : isoMs(iso, what);
}

/** A non-empty string of at most `max` UTF-16 units without NUL; RangeError otherwise. */
export function keyString(v: unknown, what: string, max = 128): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max || v.includes("\0"))
    throw new RangeError(
      `store: ${what} must be a non-empty string of at most ${String(max)} chars`,
    );
  return v;
}

/** A string matching `re`; RangeError otherwise. */
export function matching(v: unknown, re: RegExp, what: string): string {
  if (typeof v !== "string" || !re.test(v)) throw new RangeError(`store: invalid ${what}`);
  return v;
}

/** An integer in [lo, hi]; RangeError otherwise. */
export function intIn(v: unknown, lo: number, hi: number, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi)
    throw new RangeError(`store: ${what} must be an integer in ${String(lo)}..${String(hi)}`);
  return v;
}

/** A finite number; RangeError otherwise. */
export function finite(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new RangeError(`store: ${what} must be a finite number`);
  return v;
}

/** A finite number or null. */
export function finiteOrNull(v: unknown, what: string): number | null {
  return v === null ? null : finite(v, what);
}

/** One of `list`; RangeError otherwise. */
export function oneOf<T extends string>(v: unknown, list: readonly T[], what: string): T {
  if (typeof v !== "string" || !(list as readonly string[]).includes(v))
    throw new RangeError(`store: unknown ${what}`);
  return v as T;
}

/**
 * `v` itself when it is an array of at most `max` items; RangeError otherwise. (Checked through an
 * `unknown` view so the caller's element type is kept — `Array.isArray` would widen it to `any[]`.)
 */
export function boundedArray<T>(v: readonly T[], max: number, what: string): readonly T[] {
  const u: unknown = v;
  if (!Array.isArray(u) || u.length > max)
    throw new RangeError(`store: ${what} must be an array of at most ${String(max)} items`);
  return v;
}

/** A boolean; RangeError otherwise. */
export function bool(v: unknown, what: string): boolean {
  if (typeof v !== "boolean") throw new RangeError(`store: ${what} must be a boolean`);
  return v;
}

/** The season bound every repository accepts (nflverse reaches back to 1999). */
export const SEASON_MIN = 1990;
export const SEASON_MAX = 2100;
/** ESPN scoring periods (0 = preseason) and nflverse weeks (REG 1–18, POST 19–22) fit 0..25. */
export const WEEK_MIN = 0;
export const WEEK_MAX = 25;
/** The largest JSON value one column takes (a whole-league roster is ~50 KB parsed). */
export const JSON_MAX_CHARS = 32 * 1024 * 1024;

/** JSON-encodes a value the store will persist; RangeError when it cannot or is too large. */
export function toJson(v: unknown, what: string, max: number = JSON_MAX_CHARS): string {
  let s: string | undefined;
  try {
    s = JSON.stringify(v);
  } catch {
    throw new RangeError(`store: ${what} is not JSON-serialisable`);
  }
  if (typeof s !== "string") throw new RangeError(`store: ${what} is not JSON-serialisable`);
  if (s.length > max) throw new RangeError(`store: ${what} is too large`);
  return s;
}

/** Parses JSON the store itself wrote (its shape is the one the same repository serialised). */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the shape it wrote
export function parseJson<T>(text: unknown): T {
  if (typeof text !== "string") throw new Error("store: corrupt JSON column");
  return JSON.parse(text) as T;
}

/** 1/0/null → boolean/null. */
export function boolOrNull(v: unknown): boolean | null {
  return v === null || v === undefined ? null : v === 1 || v === 1n;
}

/** boolean/null → 1/0/null. */
export function bitOrNull(v: boolean | null): number | null {
  return v === null ? null : v ? 1 : 0;
}

/** A SQLite integer column read back (numbers by default; a BigInt only if the caller enabled it). */
export function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  throw new Error("store: corrupt integer column");
}

/** Epoch ms → ISO-8601 UTC. */
export const msToIso = (ms: number): string => new Date(ms).toISOString();
