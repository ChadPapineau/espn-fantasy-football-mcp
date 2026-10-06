// json.ts — typed accessors over parsed fixture JSON for the fx-10h generator (plan 09 §4
// `gen-fixtures.ts`; plan 05 §3 fixture law). Every accessor fails loudly with the path it expected,
// so a recorded body that drifted stops the generator instead of producing a silent hole.
import type { Json } from "../espn-fixture/canonical.js";

export type { Json } from "../espn-fixture/canonical.js";
export type Obj = Record<string, Json>;

/** A fixture defect: the generator refuses to write anything. */
export class FixtureGenError extends Error {
  override readonly name = "FixtureGenError";
}

export function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function obj(v: Json | undefined, what: string): Obj {
  if (!isObj(v)) throw new FixtureGenError(`fx-10h: ${what} is not an object`);
  return v;
}

export function arr(v: Json | undefined, what: string): Json[] {
  if (!Array.isArray(v)) throw new FixtureGenError(`fx-10h: ${what} is not an array`);
  return v;
}

export function num(v: Json | undefined, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new FixtureGenError(`fx-10h: ${what} is not a finite number`);
  return v;
}

export function str(v: Json | undefined, what: string): string {
  if (typeof v !== "string") throw new FixtureGenError(`fx-10h: ${what} is not a string`);
  return v;
}

/** A deep copy (JSON round trip — the inputs are plain JSON). */
export function clone<T extends Json>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Rounds a derived number to 6 decimals (well inside the 0.005 / 0.01 match tolerances). */
export function round6(x: number): number {
  const r = Math.round(x * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

/** Rounds to 2 decimals (team totals, as ESPN shows them). */
export function round2(x: number): number {
  const r = Math.round(x * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}
