// manifest.ts — loads the drift observations the in-call detector compares against (plan 01 §7
// "the manifest", generated after anonymisation from the committed fixtures; plan 05 §3.3): the
// `views` section of either fixtures/drift/manifest.json (MANIFEST_PATH) or
// fixtures/drift/entity-manifest.json (ENTITY_MANIFEST_PATH). A malformed manifest must never read
// as "no drift": every pattern is parsed, every list typed, and a bad file throws.
import { readFileSync } from "node:fs";
import { isEspnView } from "../providers/espn/types.js";
import { isJsonObject, parsePattern } from "./pattern.js";
import type { DriftObservations, EnumValue, ViewObservations } from "./types.js";

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

/** Reads and validates a manifest file (absolute path chosen by the caller's wiring). */
export function loadObservations(file: string): DriftObservations {
  const text = readFileSync(file, "utf8");
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES)
    throw new Error("drift manifest: file too large");
  return observationsFrom(JSON.parse(text) as unknown);
}
