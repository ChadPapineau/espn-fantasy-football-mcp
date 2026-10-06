// canonical.ts — deterministic JSON for the fixture pipeline: plan 05 §3.1 step 3 (sorted keys,
// arrays sorted by `id`, byte-identical reruns) and step 4 (content hashes); research 03 §F.3 step 2.
// Hostile input is assumed: `__proto__`/`constructor` keys stay plain data, never prototypes.
import { createHash } from "node:crypto";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = Record<string, Json>;

/** A plain JSON object (not an array, not null). */
export function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A fresh object with no prototype chain, so any key (even `__proto__`) is ordinary data. */
export function emptyObject(): JsonObject {
  return Object.create(null) as JsonObject;
}

/** Defines `key` as an own, enumerable data property — never a prototype setter. */
export function setOwn(obj: JsonObject, key: string, value: Json): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

export function hasOwn(obj: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** A string that matches a GUID (with or without braces) anywhere inside it. */
export const GUID_ANYWHERE =
  /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/;

/** Code-unit order (locale-independent, total). */
export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The element ids of `arr` when every element is a plain object whose `id` is a finite number or a
 * non-GUID string, all of one kind and all distinct; otherwise null (the array keeps its order).
 * GUID-keyed arrays are left alone: their order is the first-appearance order of the pseudonym map.
 */
function sortableIds(arr: Json[]): (number | string)[] | null {
  if (arr.length < 2) return null;
  const ids: (number | string)[] = [];
  let kind: "number" | "string" | null = null;
  for (const el of arr) {
    if (!isObject(el) || !hasOwn(el, "id")) return null;
    const id = el.id;
    if (typeof id === "number") {
      if (!Number.isFinite(id) || (kind !== null && kind !== "number")) return null;
      kind = "number";
    } else if (typeof id === "string") {
      if (GUID_ANYWHERE.test(id) || (kind !== null && kind !== "string")) return null;
      kind = "string";
    } else return null;
    ids.push(id);
  }
  return new Set(ids).size === ids.length ? ids : null;
}

export interface CanonicalOptions {
  /** Sort arrays of objects by `id` (plan 05 §3.1 step 3). Default true. */
  sortArrays?: boolean;
  /**
   * Paths (dot-joined keys from the root, array levels omitted) whose arrays keep their order — a
   * response ordered by the request's own sort (e.g. `players` of `kona_player_info`).
   */
  keepOrder?: ReadonlySet<string>;
}

/**
 * A deep copy with object keys in code-unit order (integer-like keys still serialise first — the
 * JSON.stringify rule — which is deterministic) and, unless disabled, arrays of objects sorted by
 * `id` where every element has a distinct sortable id.
 */
export function canonicalize(value: Json, opts: CanonicalOptions = {}): Json {
  const sortArrays = opts.sortArrays ?? true;
  const keep = opts.keepOrder ?? new Set<string>();
  const walk = (v: Json, keyPath: string): Json => {
    if (Array.isArray(v)) {
      const items = v.map((el) => walk(el, keyPath));
      if (!sortArrays || keep.has(keyPath)) return items;
      const ids = sortableIds(items);
      if (ids === null) return items;
      const order = items.map((el, i) => ({ el, id: ids[i] ?? 0 }));
      order.sort((a, b) =>
        typeof a.id === "number" && typeof b.id === "number"
          ? a.id - b.id
          : compareKeys(String(a.id), String(b.id)),
      );
      return order.map((o) => o.el);
    }
    if (isObject(v)) {
      const out = emptyObject();
      for (const k of Object.keys(v).sort(compareKeys)) {
        setOwn(out, k, walk(v[k] as Json, keyPath ? `${keyPath}.${k}` : k));
      }
      return out;
    }
    return v;
  };
  return walk(value, "");
}

/** Compact canonical JSON (sorted keys, arrays as given): the input of every content hash. */
export function stableStringify(value: Json): string {
  return JSON.stringify(canonicalize(value, { sortArrays: false }));
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** sha256 of the canonical content of a JSON value (whitespace- and key-order-independent). */
export function contentSha256(value: Json): string {
  return sha256Hex(stableStringify(value));
}

/**
 * Parses JSON text and refuses anything JSON.parse would silently corrupt: an integer outside the
 * safe range (precision loss) — a fixture must hash to exactly what ESPN sent.
 */
export function parseJsonStrict(text: string): Json {
  const value = JSON.parse(text) as Json;
  // an integer LITERAL (digits only, no fraction or exponent) past 2^53 − 1 cannot round-trip;
  // scanned on the text, outside strings, so 1.5e300 (a float by notation) is not refused
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92)
        i++; // backslash: skip the escaped character
      else if (c === 34) inString = false;
      continue;
    }
    if (c === 34) {
      inString = true;
      continue;
    }
    if ((c >= 48 && c <= 57) || c === 45) {
      let j = i + 1;
      while (j < text.length && /[0-9.eE+-]/.test(text[j] ?? "")) j++;
      const token = text.slice(i, j);
      if (/^-?\d{16,}$/.test(token) && !Number.isSafeInteger(Number(token)))
        throw new Error("an integer outside the IEEE-754 safe range would lose precision");
      i = j - 1;
    }
  }
  return value;
}

/** Formats a path segment list as `$.a.b[3]["odd key"]` — safe to print (keys are JSON-escaped). */
export function formatPath(segments: readonly (string | number)[]): string {
  let out = "$";
  for (const s of segments) {
    if (typeof s === "number") out += `[${String(s)}]`;
    else if (/^[A-Za-z_$][\w$]*$/.test(s) && s.length <= 80) out += `.${s}`;
    else out += `[${JSON.stringify(s.length > 80 ? `${s.slice(0, 80)}…` : s)}]`;
  }
  return out;
}
