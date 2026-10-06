// patch.ts — the minimal JSON patch (RFC 6902's add / remove / replace; paths as segment arrays) a
// variant body is stored as, over the base body it derives from (plan 09 §4: "a directory each, overriding only the
// files that change" — at value granularity, so a variant's file shows exactly what it changes,
// e.g. `mismatch-53` touching stat 53 only). The applier lives with the derived-league fetch
// (src/providers/espn/fixture-league.ts); a test round-trips every variant through it.
import type { Json } from "./json.js";

/** A path as segments (object keys, array indices) — never a `/a/b` string: a pointer through a
 * matchup's `home` side reads like a home directory to the repository's secret scanner. */
export type PatchPath = readonly (string | number)[];

export interface PatchOp {
  readonly op: "add" | "remove" | "replace";
  readonly path: PatchPath;
  readonly value?: Json;
}

const isRecord = (v: Json): v is Record<string, Json> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Structural equality of two JSON values. */
export function jsonEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => jsonEqual(x, b[i] ?? null));
  }
  if (isRecord(a)) {
    if (!isRecord(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k] ?? null, b[k] ?? null));
  }
  return false;
}

/** The ops turning `a` into `b` (deterministic: keys in sorted order; arrays index-wise). */
export function diff(a: Json, b: Json, path: PatchPath = []): PatchOp[] {
  if (jsonEqual(a, b)) return [];
  if (isRecord(a) && isRecord(b)) {
    const ops: PatchOp[] = [];
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) {
      const p = [...path, k];
      const inA = Object.hasOwn(a, k);
      const inB = Object.hasOwn(b, k);
      if (inA && !inB) ops.push({ op: "remove", path: p });
      else if (!inA && inB) ops.push({ op: "add", path: p, value: b[k] ?? null });
      else ops.push(...diff(a[k] ?? null, b[k] ?? null, p));
    }
    return ops;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    return a.flatMap((x, i) => diff(x, b[i] ?? null, [...path, i]));
  }
  return [{ op: "replace", path, value: b }];
}
