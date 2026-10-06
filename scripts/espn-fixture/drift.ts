// drift.ts — the probe's comparison of a live body with the checked-in required-key manifest
// (fixtures/drift/manifest.json): plan 01 §7 (required keys per view, skeleton detection, removed /
// type / enum findings are red, new keys additive, host anomalies), plan 05 §3.3 (probe diff, host
// moved), research 03 §F.2. Pure: no I/O. The future src/drift/ may port it.
import { formatPath, isObject, type Json } from "./canonical.js";

/** A required key's JSON type: one name or a `|` union ("integer|null"). */
export type KeyType = string;
const TYPE_NAMES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

export interface ProbeSpec {
  /** ESPN view names the probe requests, in order. */
  views: string[];
  /** Entity path → { key: type }. A missing key or a wrong type is red drift. */
  required: Record<string, Record<string, KeyType>>;
  /** Entity path → every key seen in the recorded fixtures; anything else is additive drift. */
  observed: Record<string, string[]>;
  /** Array path → the fewest elements a healthy body has (an emptied list is red drift). */
  minItems?: Record<string, number>;
  /** Value path → the allowed values; a value outside the set is red drift (plan 01 §7). */
  enums?: Record<string, (string | number | boolean | null)[]>;
  /**
   * Entity path → keys ESPN sends that the fixture scrubber removes (research 03 §F.3, e.g.
   * members[].notificationSettings): known, never additive, never required.
   */
  scrubbed?: Record<string, string[]>;
}

export interface DriftManifest {
  version: 1;
  host: string;
  probes: { host: ProbeSpec; shape: ProbeSpec };
}

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

/** Validates a manifest's own structure (a malformed manifest must never read as "no drift"). */
export function validateManifest(m: unknown): asserts m is DriftManifest {
  if (!isObject(m)) throw new Error("drift manifest: not an object");
  const o = m;
  if (o.version !== 1) throw new Error("drift manifest: unsupported version");
  if (typeof o.host !== "string" || !o.host) throw new Error("drift manifest: host missing");
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
