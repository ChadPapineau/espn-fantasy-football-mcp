// drift.ts — the probe's comparison of a live body with the checked-in drift manifest
// (fixtures/drift/manifest.json, typed by src/drift/types.ts): plan 01 §7 (required keys per view,
// skeleton detection, removed / type / enum findings are red, new keys additive, host anomalies,
// the per-view manifest of entity keys, enums and array lengths), plan 05 §3.1 step 4 and §3.3
// (probe diff, host moved, required ⊆ observed), research 03 §F.2. Pure: no I/O.
import type {
  DriftManifest as SharedDriftManifest,
  EnumValue,
  KeyType,
  ProbeSpec as SharedProbeSpec,
  ViewManifest,
} from "../../src/drift/types.js";
import { formatPath, isObject, type Json } from "./canonical.js";

export type { EnumValue, KeyType, ViewManifest } from "../../src/drift/types.js";
/** The probe spec — one definition, src/drift/types.ts's. */
export type ProbeSpec = SharedProbeSpec;
/** The drift manifest — one definition, src/drift/types.ts's. */
export type DriftManifest = SharedDriftManifest;

const TYPE_NAMES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

export type Severity = "red" | "additive";
export interface Finding {
  severity: Severity;
  kind: "removed" | "type" | "added" | "short" | "enum" | "not_object";
  /** The first concrete JSON path where it was seen (keys JSON-escaped; never a value). */
  path: string;
  /** How many nodes showed the same finding. */
  count: number;
  detail?: string;
}

type Seg = string | number;
interface Node {
  segs: Seg[];
  value: Json;
}

/**
 * Pattern language: `$` root, `.key` a property, `[]` every array element, `{}` every value of an
 * object, `{#}` every KEY of an object (as a string value — enum checks only).
 */
export function parsePattern(
  pattern: string,
): ({ t: "key"; k: string } | { t: "each" } | { t: "vals" } | { t: "keys" })[] {
  if (!pattern.startsWith("$")) throw new Error(`pattern must start with $: ${pattern}`);
  const out: ({ t: "key"; k: string } | { t: "each" } | { t: "vals" } | { t: "keys" })[] = [];
  let i = 1;
  while (i < pattern.length) {
    if (pattern.startsWith("[]", i)) {
      out.push({ t: "each" });
      i += 2;
    } else if (pattern.startsWith("{#}", i)) {
      out.push({ t: "keys" });
      i += 3;
    } else if (pattern.startsWith("{}", i)) {
      out.push({ t: "vals" });
      i += 2;
    } else if (pattern[i] === ".") {
      const m = /^\.([A-Za-z_$][\w$]*)/.exec(pattern.slice(i));
      if (!m?.[1]) throw new Error(`bad key at ${String(i)} in ${pattern}`);
      out.push({ t: "key", k: m[1] });
      i += m[0].length;
    } else throw new Error(`bad pattern ${pattern} at ${String(i)}`);
  }
  return out;
}

/** Every node a pattern selects (missing intermediate keys select nothing — the parent reports). */
export function select(body: Json, pattern: string): Node[] {
  let nodes: Node[] = [{ segs: [], value: body }];
  for (const step of parsePattern(pattern)) {
    const next: Node[] = [];
    for (const n of nodes) {
      const v = n.value;
      if (step.t === "key") {
        if (isObject(v) && Object.prototype.hasOwnProperty.call(v, step.k))
          next.push({ segs: [...n.segs, step.k], value: v[step.k] as Json });
      } else if (step.t === "each") {
        if (Array.isArray(v)) v.forEach((el, i) => next.push({ segs: [...n.segs, i], value: el }));
      } else if (step.t === "vals") {
        if (isObject(v))
          for (const k of Object.keys(v)) next.push({ segs: [...n.segs, k], value: v[k] as Json });
      } else if (isObject(v)) {
        for (const k of Object.keys(v)) next.push({ segs: [...n.segs, k], value: k });
      }
    }
    nodes = next;
  }
  return nodes;
}

export function typeOf(v: Json): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

/** Does value `v` satisfy the declared type (`number` accepts integers)? */
export function typeMatches(v: Json, declared: KeyType): boolean {
  const actual = typeOf(v);
  return declared
    .split("|")
    .some((t) => t === actual || (t === "number" && actual === "integer") || t === "any");
}

/** Validates one `views.<view>` entry (a malformed entry must never read as "no drift"). */
function validateView(name: string, v: unknown): void {
  if (!/^[A-Za-z_]+$/.test(name)) throw new Error("drift manifest: bad view name");
  if (!isObject(v)) throw new Error(`drift manifest: views.${name} invalid`);
  if (
    !Array.isArray(v.sources) ||
    !v.sources.length ||
    !v.sources.every((x) => typeof x === "string")
  )
    throw new Error(`drift manifest: views.${name}.sources invalid`);
  for (const field of ["observed", "enums", "array_lengths"] as const)
    if (!isObject(v[field])) throw new Error(`drift manifest: views.${name}.${field} missing`);
  for (const [pat, keys] of Object.entries(v.observed as Record<string, unknown>)) {
    parsePattern(pat);
    if (!Array.isArray(keys) || !keys.every((k) => typeof k === "string"))
      throw new Error(`drift manifest: views.${name}.observed ${pat} invalid`);
  }
  for (const [pat, vals] of Object.entries(v.enums as Record<string, unknown>)) {
    parsePattern(pat);
    if (
      !Array.isArray(vals) ||
      !vals.every((x) => x === null || ["string", "number", "boolean"].includes(typeof x))
    )
      throw new Error(`drift manifest: views.${name}.enums ${pat} invalid`);
  }
  for (const [pat, r] of Object.entries(v.array_lengths as Record<string, unknown>)) {
    parsePattern(pat);
    if (
      !isObject(r) ||
      !Number.isInteger(r.min) ||
      !Number.isInteger(r.max) ||
      (r.min as number) < 0 ||
      (r.min as number) > (r.max as number)
    )
      throw new Error(`drift manifest: views.${name}.array_lengths ${pat} invalid`);
  }
}

/** Validates a manifest's own structure (a malformed manifest must never read as "no drift"). */
export function validateManifest(m: unknown): asserts m is DriftManifest {
  if (!isObject(m)) throw new Error("drift manifest: not an object");
  const o = m;
  if (o.version !== 1) throw new Error("drift manifest: unsupported version");
  if (typeof o.host !== "string" || !o.host) throw new Error("drift manifest: host missing");
  const src = o.$sources;
  if (
    !isObject(src) ||
    !["host", "shape"].every(
      (k) => Array.isArray(src[k]) && (src[k] as unknown[]).every((x) => typeof x === "string"),
    )
  )
    throw new Error("drift manifest: $sources invalid");
  if (!isObject(o.views)) throw new Error("drift manifest: views missing");
  for (const [name, v] of Object.entries(o.views)) validateView(name, v);
  const probes = o.probes;
  if (!isObject(probes)) throw new Error("drift manifest: probes missing");
  for (const name of ["host", "shape"]) {
    const p = probes[name];
    if (!isObject(p)) throw new Error(`drift manifest: probes.${name} missing`);
    if (
      !Array.isArray(p.views) ||
      !p.views.length ||
      !p.views.every((v) => typeof v === "string" && /^[A-Za-z_]+$/.test(v))
    )
      throw new Error(`drift manifest: probes.${name}.views invalid`);
    if (!isObject(p.required) || !Object.keys(p.required).length)
      throw new Error(`drift manifest: probes.${name}.required empty`);
    for (const [pat, keys] of Object.entries(p.required)) {
      parsePattern(pat);
      if (!isObject(keys) || !Object.keys(keys).length)
        throw new Error(`drift manifest: required ${pat} empty`);
      for (const [k, t] of Object.entries(keys))
        if (typeof t !== "string" || !t.split("|").every((x) => TYPE_NAMES.has(x) || x === "any"))
          throw new Error(`drift manifest: required ${pat}.${k} has a bad type`);
    }
    if (!isObject(p.observed)) throw new Error(`drift manifest: probes.${name}.observed missing`);
    for (const [pat, keys] of Object.entries(p.observed)) {
      parsePattern(pat);
      if (!Array.isArray(keys) || !keys.every((k) => typeof k === "string"))
        throw new Error(`drift manifest: observed ${pat} invalid`);
    }
    if (p.scrubbed !== undefined) {
      if (!isObject(p.scrubbed)) throw new Error(`drift manifest: probes.${name}.scrubbed invalid`);
      for (const [pat, keys] of Object.entries(p.scrubbed)) {
        parsePattern(pat);
        if (!Array.isArray(keys) || !keys.every((k) => typeof k === "string"))
          throw new Error(`drift manifest: scrubbed ${pat} invalid`);
      }
    }
    for (const field of ["minItems", "enums"] as const) {
      const f = p[field];
      if (f === undefined) continue;
      if (!isObject(f)) throw new Error(`drift manifest: probes.${name}.${field} invalid`);
      for (const pat of Object.keys(f)) parsePattern(pat);
    }
  }
}

/** A short, printable rendering of an enum value (escaped, truncated). */
function showValue(v: Json): string {
  const s = JSON.stringify(v);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/**
 * Compares a parsed body with one probe spec. Findings are aggregated per (kind, pattern, key) with
 * the first concrete path, so a renamed field on 33 teams is one finding with count 33.
 */
export function diffBody(spec: ProbeSpec, body: Json): Finding[] {
  const agg = new Map<string, Finding>();
  const add = (key: string, f: Omit<Finding, "count">) => {
    const prev = agg.get(key);
    if (prev) prev.count++;
    else agg.set(key, { ...f, count: 1 });
  };

  for (const [pattern, keys] of Object.entries(spec.required)) {
    for (const node of select(body, pattern)) {
      if (!isObject(node.value)) {
        add(`not_object|${pattern}`, {
          severity: "red",
          kind: "not_object",
          path: formatPath(node.segs),
          detail: `expected an object, found ${typeOf(node.value)}`,
        });
        continue;
      }
      for (const [k, t] of Object.entries(keys)) {
        if (!Object.prototype.hasOwnProperty.call(node.value, k)) {
          add(`removed|${pattern}|${k}`, {
            severity: "red",
            kind: "removed",
            path: formatPath([...node.segs, k]),
          });
        } else if (!typeMatches(node.value[k] as Json, t)) {
          add(`type|${pattern}|${k}`, {
            severity: "red",
            kind: "type",
            path: formatPath([...node.segs, k]),
            detail: `expected ${t}, found ${typeOf(node.value[k] as Json)}`,
          });
        }
      }
    }
  }

  const known = new Map<string, Set<string>>();
  for (const [pattern, keys] of Object.entries(spec.observed)) known.set(pattern, new Set(keys));
  for (const [pattern, keys] of Object.entries(spec.required)) {
    const set = known.get(pattern) ?? new Set<string>();
    for (const k of Object.keys(keys)) set.add(k);
    known.set(pattern, set);
  }
  for (const [pattern, keys] of Object.entries(spec.scrubbed ?? {})) {
    const set = known.get(pattern) ?? new Set<string>();
    for (const k of keys) set.add(k);
    known.set(pattern, set);
  }
  for (const [pattern, keys] of known) {
    for (const node of select(body, pattern)) {
      if (!isObject(node.value)) continue;
      for (const k of Object.keys(node.value)) {
        if (!keys.has(k))
          add(`added|${pattern}|${k}`, {
            severity: "additive",
            kind: "added",
            path: formatPath([...node.segs, k]),
          });
      }
    }
  }

  for (const [pattern, min] of Object.entries(spec.minItems ?? {})) {
    for (const node of select(body, pattern)) {
      if (!Array.isArray(node.value) || node.value.length < min)
        add(`short|${pattern}`, {
          severity: "red",
          kind: "short",
          path: formatPath(node.segs),
          detail: `expected ≥ ${String(min)} items, found ${Array.isArray(node.value) ? String(node.value.length) : typeOf(node.value)}`,
        });
    }
  }

  for (const [pattern, allowed] of Object.entries(spec.enums ?? {})) {
    const set = new Set(allowed.map((a) => JSON.stringify(a)));
    for (const node of select(body, pattern)) {
      if (!set.has(JSON.stringify(node.value)))
        add(`enum|${pattern}|${JSON.stringify(node.value)}`, {
          severity: "red",
          kind: "enum",
          path: formatPath(node.segs),
          detail: `value ${showValue(node.value)} is not in the known set`,
        });
    }
  }

  return [...agg.values()].sort((a, b) =>
    a.severity === b.severity
      ? a.path < b.path
        ? -1
        : a.path > b.path
          ? 1
          : 0
      : a.severity === "red"
        ? -1
        : 1,
  );
}

// --- the per-view manifest (plan 01 §7; plan 05 §3.1 step 4) ------------------------------------

/** Keys whose UPPER_SNAKE string values are member/editor text, never an enum. */
const TEXT_KEYS = new Set([
  "abbrev",
  "name",
  "nickname",
  "location",
  "displayName",
  "firstName",
  "lastName",
  "fullName",
  "logo",
  "tradeBlock",
  "draftStrategy",
  "seasonOutlook",
  "primaryOwner",
  "id",
  "notes",
  "jersey",
]);
/** Integer fields that are closed vocabularies (research 03 §B.2): observed values are enums. */
const INTEGER_ENUM_KEYS = new Set([
  "statSourceId",
  "statSplitTypeId",
  "lineupSlotId",
  "defaultPositionId",
  "proTeamId",
]);
const ENUM_STRING_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
/** More distinct values than this at one pattern → not an enum (dropped from the manifest). */
export const MAX_ENUM_VALUES = 64;
const KEY_RE = /^[A-Za-z_$][\w$]*$/;
const MAX_OBSERVE_DEPTH = 24;

/**
 * An object whose keys are data, not schema — every key numeric (stats by stat id, points by
 * period, slot counts) or any key outside the pattern grammar: its VALUES are walked under `{}`.
 */
function isMapLike(o: Record<string, Json>): boolean {
  const keys = Object.keys(o);
  return (
    keys.length > 0 &&
    (keys.every((k) => /^-?[0-9]+$/.test(k)) || keys.some((k) => !KEY_RE.test(k)))
  );
}

/**
 * The per-view observations of `bodies`: every entity pattern's key set, every array pattern's
 * length range, and the enum values (UPPER_SNAKE strings outside TEXT_KEYS, and the integer
 * vocabularies) per value pattern, each sorted. Deterministic for a given input.
 */
export function observeBodies(bodies: readonly Json[]): Omit<ViewManifest, "sources"> {
  const observed = new Map<string, Set<string>>();
  const enums = new Map<string, Set<string | number>>();
  const lengths = new Map<string, { min: number; max: number }>();
  const walk = (v: Json, pattern: string, key: string | null, depth: number): void => {
    if (depth > MAX_OBSERVE_DEPTH) return;
    if (Array.isArray(v)) {
      const r = lengths.get(pattern);
      lengths.set(
        pattern,
        r
          ? { min: Math.min(r.min, v.length), max: Math.max(r.max, v.length) }
          : { min: v.length, max: v.length },
      );
      for (const el of v) walk(el, `${pattern}[]`, key, depth + 1);
      return;
    }
    if (isObject(v)) {
      if (isMapLike(v)) {
        for (const x of Object.values(v)) walk(x, `${pattern}{}`, key, depth + 1);
        return;
      }
      const set = observed.get(pattern) ?? new Set<string>();
      for (const [k, x] of Object.entries(v)) {
        set.add(k);
        walk(x, `${pattern}.${k}`, k, depth + 1);
      }
      observed.set(pattern, set);
      return;
    }
    if (key === null) return;
    const isEnum =
      (typeof v === "string" && !TEXT_KEYS.has(key) && ENUM_STRING_RE.test(v)) ||
      (typeof v === "number" && Number.isInteger(v) && INTEGER_ENUM_KEYS.has(key));
    if (isEnum) {
      const set = enums.get(pattern) ?? new Set<string | number>();
      set.add(v);
      enums.set(pattern, set);
    }
  };
  for (const b of bodies) walk(b, "$", null, 0);
  const sortVals = (xs: Iterable<string | number>) =>
    [...xs].sort((a, b) =>
      typeof a === "number" && typeof b === "number"
        ? a - b
        : String(a) < String(b)
          ? -1
          : String(a) > String(b)
            ? 1
            : 0,
    );
  const byKey = <T>(m: Map<string, T>) => [...m.keys()].sort();
  const out: {
    observed: Record<string, string[]>;
    enums: Record<string, EnumValue[]>;
    array_lengths: Record<string, { min: number; max: number }>;
  } = {
    observed: {},
    enums: {},
    array_lengths: {},
  };
  for (const k of byKey(observed)) out.observed[k] = [...(observed.get(k) ?? [])].sort();
  for (const k of byKey(enums)) {
    const vals = enums.get(k) ?? new Set();
    if (vals.size <= MAX_ENUM_VALUES) out.enums[k] = sortVals(vals);
  }
  for (const k of byKey(lengths)) out.array_lengths[k] = lengths.get(k) ?? { min: 0, max: 0 };
  return out;
}

/**
 * Evaluates a required path (src/drift/types.ts REQUIRED_PATHS_BY_VIEW notation) on a body:
 * `present` when the parent pattern selects ≥ 1 node and every node has the last key (for `…[]`:
 * the parent is a non-empty array), `absent` when no selected node has it (or nothing is
 * selected), `partial` otherwise. Skeleton detection = every required path absent.
 */
export function requiredPathStatus(
  body: Json,
  requiredPath: string,
): "present" | "absent" | "partial" {
  if (requiredPath.endsWith("[]")) {
    const parents = select(body, requiredPath.slice(0, -2) || "$");
    if (!parents.length) return "absent";
    const ok = parents.filter((n) => Array.isArray(n.value) && n.value.length > 0).length;
    return ok === parents.length ? "present" : ok === 0 ? "absent" : "partial";
  }
  const m = /^(.*)\.([A-Za-z_$][\w$]*)$/.exec(requiredPath);
  if (!m?.[1] || !m[2]) throw new Error(`bad required path ${requiredPath}`);
  const key = m[2];
  const parents = select(body, m[1]);
  if (!parents.length) return "absent";
  const ok = parents.filter(
    (n) => isObject(n.value) && Object.prototype.hasOwnProperty.call(n.value, key),
  ).length;
  return ok === parents.length ? "present" : ok === 0 ? "absent" : "partial";
}

/** Every key observed at each entity path of `spec` across `bodies` (for a human re-baseline). */
export function observeKeys(
  patterns: readonly string[],
  bodies: readonly Json[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const pattern of patterns) {
    const keys = new Set<string>();
    for (const body of bodies)
      for (const node of select(body, pattern))
        if (isObject(node.value)) for (const k of Object.keys(node.value)) keys.add(k);
    out[pattern] = [...keys].sort();
  }
  return out;
}

export type ResponseClass =
  | { kind: "json"; body: Json }
  | { kind: "host_moved"; reason: string }
  | { kind: "unreachable"; reason: string }
  | { kind: "not_found"; reason: string }
  | { kind: "forbidden"; reason: string }
  | { kind: "error"; reason: string };

/** The ESPN error `type` codes of a JSON error body (research 03 §A.4), for a terse reason. */
function espnErrorTypes(text: string): string {
  try {
    const b = JSON.parse(text) as unknown;
    if (isObject(b)) {
      const d = b.details;
      if (Array.isArray(d)) {
        const types = d
          .map((x) => (isObject(x) && typeof x.type === "string" ? x.type : null))
          .filter((x): x is string => x !== null && /^[A-Z0-9_]{1,64}$/.test(x));
        if (types.length) return types.join(",");
      }
    }
  } catch {
    /* not JSON */
  }
  return "";
}

/**
 * Classifies one probe response before any key diff (plan 01 §7 "Host answered 3xx / non-JSON →
 * host moved"; research 03 §A.1, §A.4). `expectedHost` is the host the request went to.
 */
export function classifyResponse(
  r: { status: number; headers: Record<string, string>; bodyText: string; url: string },
  expectedHost: string,
): ResponseClass {
  let finalHost = "";
  try {
    finalHost = new URL(r.url).hostname;
  } catch {
    finalHost = "";
  }
  if (finalHost && finalHost !== expectedHost)
    return { kind: "host_moved", reason: `answered from another host (${finalHost.slice(0, 80)})` };
  if (r.status >= 300 && r.status < 400) {
    let to = "";
    try {
      to = new URL(r.headers.location ?? "", `https://${expectedHost}/`).hostname;
    } catch {
      to = "";
    }
    return {
      kind: "host_moved",
      reason: `HTTP ${String(r.status)} redirect${to ? ` to ${to.slice(0, 80)}` : ""} (not followed)`,
    };
  }
  if (r.status === 429 || r.status >= 500)
    return { kind: "unreachable", reason: `HTTP ${String(r.status)}` };
  const ct = (r.headers["content-type"] ?? "").toLowerCase();
  const isJsonType = /^application\/(?:[\w.+-]+\+)?json\b/.test(ct);
  if (r.status === 404)
    return {
      kind: "not_found",
      reason: `HTTP 404${isJsonType ? ` ${espnErrorTypes(r.bodyText)}` : ""}`.trim(),
    };
  if (r.status === 401 || r.status === 403) {
    if (!isJsonType)
      return {
        kind: "host_moved",
        reason: `HTTP ${String(r.status)} with a non-JSON body (edge block or moved API)`,
      };
    return {
      kind: "forbidden",
      reason: `HTTP ${String(r.status)} ${espnErrorTypes(r.bodyText)}`.trim(),
    };
  }
  if (r.status < 200 || r.status >= 300)
    return {
      kind: "error",
      reason: `HTTP ${String(r.status)} ${espnErrorTypes(r.bodyText)}`.trim(),
    };
  if (!isJsonType)
    return {
      kind: "host_moved",
      reason: `HTTP ${String(r.status)} with content-type ${JSON.stringify(ct.slice(0, 60))} (not JSON)`,
    };
  try {
    return { kind: "json", body: JSON.parse(r.bodyText) as Json };
  } catch {
    return { kind: "host_moved", reason: `HTTP ${String(r.status)} body is not parseable JSON` };
  }
}
