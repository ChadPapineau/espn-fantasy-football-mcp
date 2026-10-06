// overrides.ts — the checked-in crosswalk override file (research 04 §C step 3: the residue the id
// lookup and the matcher cannot settle; plan 02 T5 "schema-validated"; plan 05 §2). Ported from sibling
// @8db206f (src/providers/crosswalk-overrides.ts), adapted: JSON (no YAML dependency — plan 04 §2),
// ESPN ids, pure (the caller reads the file; the domain does no I/O — plan 01 §1.1).
import { GSIS_ID_RE } from "../../config/schema.js";
import { isPersonId } from "./ids.js";
import type { CrosswalkOverride } from "./types.js";

/** Largest overrides text accepted (the expected residue is single digits — research 04 §C). */
export const MAX_OVERRIDES_BYTES = 256 * 1024;
/** Most override rows accepted. */
export const MAX_OVERRIDES = 2000;
/** Longest `note`. */
export const MAX_NOTE_CHARS = 200;
/** Longest top-level `$comment`. */
export const MAX_COMMENT_CHARS = 4096;
/** The file's schema version. */
export const OVERRIDES_VERSION = 1;

/** Keys that are never accepted anywhere in the document (prototype pollution). */
export const FORBIDDEN_KEYS: readonly string[] = Object.freeze([
  "__proto__",
  "constructor",
  "prototype",
]);

/** Why a parse failed. */
export type OverridesErrorCode = "too_large" | "json" | "forbidden_key" | "schema" | "duplicate";

/** A parse failure. The message names the code and a location, never file content. */
export class CrosswalkOverridesError extends Error {
  readonly code: OverridesErrorCode;
  constructor(code: OverridesErrorCode, where: string) {
    super(`crosswalk overrides: ${code}${where ? ` (${where})` : ""}`);
    this.name = "CrosswalkOverridesError";
    this.code = code;
  }
}

/** C0/C1 controls, DEL, zero-width and bidi format characters: never in a note or comment. */
const UNSAFE_TEXT_RE = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/u;
const MAX_DEPTH = 32;
const TOP_KEYS: readonly string[] = ["$comment", "version", "overrides"];
const ROW_KEYS: readonly string[] = ["espn_id", "gsis_id", "note"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

/** Throws `forbidden_key` if any key anywhere is `__proto__`/`constructor`/`prototype`. */
export function assertNoForbiddenKeys(value: unknown, path = "root", depth = 0): void {
  if (depth > MAX_DEPTH) throw new CrosswalkOverridesError("schema", "nesting too deep");
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      assertNoForbiddenKeys(v, `${path}[${String(i)}]`, depth + 1);
    });
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const key of Object.getOwnPropertyNames(value)) {
    if (FORBIDDEN_KEYS.includes(key)) throw new CrosswalkOverridesError("forbidden_key", path);
    assertNoForbiddenKeys((value as Record<string, unknown>)[key], `${path}.${key}`, depth + 1);
  }
}

function safeText(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length <= max && !UNSAFE_TEXT_RE.test(v);
}

function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key))
      throw new CrosswalkOverridesError("schema", `${where}: unknown key`);
  }
}

function parseRow(row: unknown, where: string): CrosswalkOverride {
  if (!isPlainObject(row)) throw new CrosswalkOverridesError("schema", where);
  onlyKeys(row, ROW_KEYS, where);
  const { espn_id: espnId, gsis_id: gsisId, note } = row;
  // A person id only: a team unit's identity is its team, never an override (TEAM_UNIT_POSITION_IDS).
  if (!isPersonId(espnId)) throw new CrosswalkOverridesError("schema", `${where}.espn_id`);
  if (typeof gsisId !== "string" || !GSIS_ID_RE.test(gsisId)) {
    throw new CrosswalkOverridesError("schema", `${where}.gsis_id`);
  }
  if (note !== undefined && note !== null && !safeText(note, MAX_NOTE_CHARS)) {
    throw new CrosswalkOverridesError("schema", `${where}.note`);
  }
  return Object.freeze({ espn_id: espnId, gsis_id: gsisId, note: note ?? null });
}

/**
 * Parses and validates the overrides text `{ "$comment"?, "version": 1, "overrides": [{ espn_id,
 * gsis_id, note? }] }`. Rejects (CrosswalkOverridesError): more than MAX_OVERRIDES_BYTES, invalid
 * JSON, any `__proto__`/`constructor`/`prototype` key, unknown keys, wrong types, a non-person ESPN
 * id (≤ 0, fractional, > 99 999 999 — team units are never overridden), a gsis id off its grammar,
 * an unsafe or over-long note, more than MAX_OVERRIDES rows, and two rows for one ESPN id. One
 * leading byte-order mark is tolerated.
 */
export function parseCrosswalkOverrides(text: string): readonly CrosswalkOverride[] {
  if (typeof text !== "string") throw new CrosswalkOverridesError("schema", "not text");
  if (Buffer.byteLength(text, "utf8") > MAX_OVERRIDES_BYTES) {
    throw new CrosswalkOverridesError("too_large", `> ${String(MAX_OVERRIDES_BYTES)} bytes`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text.startsWith("﻿") ? text.slice(1) : text) as unknown;
  } catch {
    throw new CrosswalkOverridesError("json", "");
  }
  assertNoForbiddenKeys(data);
  if (!isPlainObject(data)) throw new CrosswalkOverridesError("schema", "root");
  onlyKeys(data, TOP_KEYS, "root");
  if (data.version !== OVERRIDES_VERSION) throw new CrosswalkOverridesError("schema", "version");
  if (data.$comment !== undefined && !safeText(data.$comment, MAX_COMMENT_CHARS)) {
    throw new CrosswalkOverridesError("schema", "$comment");
  }
  const rows = data.overrides;
  if (!Array.isArray(rows)) throw new CrosswalkOverridesError("schema", "overrides");
  if (rows.length > MAX_OVERRIDES) {
    throw new CrosswalkOverridesError("schema", `overrides: > ${String(MAX_OVERRIDES)} rows`);
  }
  const seen = new Set<number>();
  const out = rows.map((row: unknown, i): CrosswalkOverride => {
    const where = `overrides[${String(i)}]`;
    const parsed = parseRow(row, where);
    if (seen.has(parsed.espn_id)) throw new CrosswalkOverridesError("duplicate", where);
    seen.add(parsed.espn_id);
    return parsed;
  });
  return Object.freeze(out);
}

/**
 * The rows of data/crosswalk/overrides.json, compiled in: the published package ships `dist` and not
 * `data/` (plan 04 §2's exact `files`), so this copy is what a running server and `eff crosswalk
 * rebuild` use. tests/domain/crosswalk/overrides.test.ts holds it equal to the parsed file — edit both
 * together. Empty today: every fixture player resolves by id (research 04 §C expects single digits).
 */
export const CHECKED_IN_OVERRIDES: readonly CrosswalkOverride[] = Object.freeze([]);
