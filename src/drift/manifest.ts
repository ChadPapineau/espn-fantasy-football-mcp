// manifest.ts — loads the drift observations the in-call detector compares against (plan 01 §7
// "the manifest", generated after anonymisation from the committed fixtures; plan 05 §3.3): the
// `views` section of either fixtures/drift/manifest.json (MANIFEST_PATH) or
// fixtures/drift/entity-manifest.json (ENTITY_MANIFEST_PATH). A malformed manifest must never read
// as "no drift": every pattern is parsed, every list typed, and a bad file throws. Also the
// manifest's identity `drift_state` records (`manifest_hash` per MANIFEST_HASH_ALGORITHM — the same
// value as scripts/espn-fixture/canonical.ts `contentSha256`, held equal by a test — and
// `manifest_version`), so a newer manifest re-baselines the row on its first probe (plan 03 §7).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isEspnView } from "../providers/espn/types.js";
import { isJsonObject, parsePattern } from "./pattern.js";
import type { DriftObservations, EnumValue, ManifestIdentity, ViewObservations } from "./types.js";

/** A manifest larger than this is refused (the committed ones are < 400 KB). */
export const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

function stringList(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string"))
    throw new Error(`drift manifest: ${what} is not a string list`);
  return v;
}

function enumList(v: unknown, what: string): EnumValue[] {
  if (
    !Array.isArray(v) ||
    !v.every((x) => x === null || ["string", "number", "boolean"].includes(typeof x))
  )
    throw new Error(`drift manifest: ${what} is not an enum list`);
  return v as EnumValue[];
}

/** Validates one view's observations (patterns parse; key and enum lists typed). */
export function parseViewObservations(name: string, v: unknown): ViewObservations {
  if (!isJsonObject(v) || !isJsonObject(v.observed) || !isJsonObject(v.enums))
    throw new Error(`drift manifest: views.${name} is malformed`);
  const observed: Record<string, readonly string[]> = {};
  for (const [pattern, keys] of Object.entries(v.observed)) {
    parsePattern(pattern);
    observed[pattern] = stringList(keys, `views.${name}.observed`);
  }
  const enums: Record<string, readonly EnumValue[]> = {};
  for (const [pattern, values] of Object.entries(v.enums)) {
    parsePattern(pattern);
    enums[pattern] = enumList(values, `views.${name}.enums`);
  }
  return { observed, enums };
}

/**
 * The observations of a parsed manifest object (either format): every whitelisted view under
 * `views`; a view name that is not whitelisted is ignored (the detector never requests it).
 */
export function observationsFrom(manifest: unknown): DriftObservations {
  if (!isJsonObject(manifest) || manifest.version !== 1 || !isJsonObject(manifest.views))
    throw new Error("drift manifest: not a version-1 manifest with views");
  const out: Partial<Record<string, ViewObservations>> = {};
  for (const [name, v] of Object.entries(manifest.views))
    if (isEspnView(name)) out[name] = parseViewObservations(name, v);
  return Object.freeze(out);
}

/**
 * A deep copy with object keys in code-unit order and arrays as given — the input of the content
 * hash (ported from scripts/espn-fixture/canonical.ts `stableStringify`; src/ may not import
 * scripts/). Keys land on a prototype-free object as own data properties, so `__proto__` stays data.
 */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (!isJsonObject(v)) return v;
  const out = Object.create(null) as Record<string, unknown>;
  // own keys are distinct, so the comparator never sees two equal ones
  for (const k of Object.keys(v).sort((a, b) => (a < b ? -1 : 1)))
    Object.defineProperty(out, k, {
      value: canonical(v[k]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return out;
}

/**
 * The identity of a parsed manifest (MANIFEST_HASH_ALGORITHM): sha256 (lowercase hex) of its
 * canonical JSON — whitespace- and key-order-independent — and its integer `version`.
 */
export function manifestIdentity(manifest: unknown): ManifestIdentity {
  if (!isJsonObject(manifest) || !Number.isSafeInteger(manifest.version))
    throw new Error("drift manifest: no integer version");
  const hash = createHash("sha256")
    .update(JSON.stringify(canonical(manifest)))
    .digest("hex");
  return { hash, version: manifest.version as number };
}

/** A loaded manifest: what the detector compares against and what drift_state records. */
export interface LoadedManifest {
  readonly observations: DriftObservations;
  readonly identity: ManifestIdentity;
}

/** Reads and parses a manifest file within the size bound. */
function readManifest(file: string): unknown {
  const text = readFileSync(file, "utf8");
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES)
    throw new Error("drift manifest: file too large");
  return JSON.parse(text) as unknown;
}

/** Reads and validates a manifest file once: its observations and its identity (the probe's). */
export function loadDriftManifest(file: string): LoadedManifest {
  const parsed = readManifest(file);
  return { observations: observationsFrom(parsed), identity: manifestIdentity(parsed) };
}

/** Reads and validates a manifest file (absolute path chosen by the caller's wiring). */
export function loadObservations(file: string): DriftObservations {
  return observationsFrom(readManifest(file));
}
