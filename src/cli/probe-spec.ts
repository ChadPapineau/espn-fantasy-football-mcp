// probe-spec.ts — the daily probe's comparison of an answer with the drift manifest's probe specs
// (fixtures/drift/manifest.json `probes.host` / `probes.shape`, typed by src/drift/types.ts
// ProbeSpec): plan 01 §7 "The daily probe … Diff against the manifest; any removed key, changed
// enum set, or host anomaly → drift_state red, a macOS notification"; plan 06 §1.2 (the alarm "ESPN
// drift: <view>: removed <key>"); plan 05 §3.3 "probe diff". A required key that is missing or has
// another JSON type, a list shorter than its `minItems`, and a value outside its `enums` set are RED;
// a key outside `observed` (and `scrubbed`) is additive. Stage C finding
// probe-manifest-specs-unevaluated: `eff probe`, doctor #15 and `eff smoke` judged an answer only with
// src/drift's 1–4 seed paths per view, so a removed `playoffSeedingRule`, `waiverOrderReset` or game
// `date`, an emptied `proTeams` list or a new team id stayed green while the in-call schemas (which
// mark those keys optional) read them as UNKNOWN/null.
//
// The comparison is a port of scripts/espn-fixture/drift.ts `diffBody` (src/ may not import
// scripts/; tests/cli/probe-spec.test.ts holds the two equal over mutated recorded fixtures), with
// bounds a hostile body cannot break: every selection is capped, an enum value is compared only as a
// JSON scalar, and the findings per kind are capped. Each finding is also a drift signal of the view
// whose seed paths share its top-level key (the probe's first view otherwise), in src/drift's path
// notation (`$.settings.scheduleSettings.playoffSeedingRule`), and the paths each answer VERIFIED are
// returned too, so a later good probe clears what an earlier one found. Pure: no I/O.
import { enumToken } from "../drift/detect.js";
import { MAX_SELECTED_NODES } from "../drift/pattern.js";
import {
  REQUIRED_PATHS_BY_VIEW,
  type DriftSignal,
  type EnumValue,
  type ProbeSpec,
} from "../drift/types.js";
import { isEspnView, type EspnView } from "../providers/espn/types.js";

/** The two probe specs of the checkout's drift manifest. */
export interface ProbeSpecs {
  readonly host: ProbeSpec;
  readonly shape: ProbeSpec;
}

/** One step of the probe-spec pattern language (`{#}`: every KEY of an object, as a string value). */
type Step =
  | { readonly t: "key"; readonly k: string }
  | { readonly t: "each" }
  | { readonly t: "vals" }
  | { readonly t: "keys" };

const KEY_STEP_RE = /^\.([A-Za-z_$][\w$]*)/;
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;
const TYPE_NAMES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
/** At most this many findings of one kind are kept (bounded state, logs and output). */
export const MAX_FINDINGS_PER_KIND = 32;

/** Parses a pattern (`$`, `.key`, `[]`, `{}`, `{#}`); throws on anything outside the grammar. */
export function parseSpecPattern(pattern: string): readonly Step[] {
  if (!pattern.startsWith("$")) throw new Error("probe spec: a pattern must start with $");
  const out: Step[] = [];
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
    } else {
      const m = KEY_STEP_RE.exec(pattern.slice(i));
      if (m?.[1] === undefined) throw new Error("probe spec: bad pattern step");
      out.push({ t: "key", k: m[1] });
      i += m[0].length;
    }
  }
  return out;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A selected node: its concrete path and its value. */
interface Node {
  readonly segs: readonly (string | number)[];
  readonly value: unknown;
}

/** The selection was larger than MAX_SELECTED_NODES (a hostile or broken body). */
class SelectionTooLarge extends Error {}

/** Every node a pattern selects (a missing intermediate key selects nothing); capped. */
function select(body: unknown, steps: readonly Step[]): Node[] {
  let nodes: Node[] = [{ segs: [], value: body }];
  for (const step of steps) {
    const next: Node[] = [];
    for (const n of nodes) {
      const v = n.value;
      if (step.t === "key") {
        if (isObj(v) && Object.prototype.hasOwnProperty.call(v, step.k))
          next.push({ segs: [...n.segs, step.k], value: v[step.k] });
      } else if (step.t === "each") {
        if (Array.isArray(v)) v.forEach((el, i) => next.push({ segs: [...n.segs, i], value: el }));
      } else if (step.t === "vals") {
        if (isObj(v))
          for (const k of Object.keys(v)) next.push({ segs: [...n.segs, k], value: v[k] });
      } else if (isObj(v)) {
        for (const k of Object.keys(v)) next.push({ segs: [...n.segs, k], value: k });
      }
      if (next.length > MAX_SELECTED_NODES) throw new SelectionTooLarge();
    }
    nodes = next;
  }
  return nodes;
}

/** The JSON type name of a value (`integer` for a whole number), as the manifest spells types. */
export function jsonTypeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

/** Whether `v` has the declared type (a `|` union; `number` accepts integers; `any` anything). */
export function typeMatches(v: unknown, declared: string): boolean {
  const actual = jsonTypeOf(v);
  return declared
    .split("|")
    .some((t) => t === actual || (t === "number" && actual === "integer") || t === "any");
}

/** The concrete path of a node (scripts/espn-fixture/canonical.ts `formatPath`). */
function formatPath(segs: readonly (string | number)[]): string {
  let out = "$";
  for (const s of segs) {
    if (typeof s === "number") out += `[${String(s)}]`;
    else if (IDENT_RE.test(s) && s.length <= 80) out += `.${s}`;
    else out += `[${JSON.stringify(s.length > 80 ? `${s.slice(0, 80)}…` : s)}]`;
  }
  return out;
}

const isScalar = (v: unknown): v is EnumValue =>
  v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** The kinds of finding (scripts/espn-fixture/drift.ts `Finding.kind`, plus `oversize`). */
export type SpecFindingKind =
  "removed" | "type" | "not_object" | "short" | "enum" | "added" | "oversize";

/** One finding of a probe answer against its spec (fixed vocabulary; never a value but a token). */
export interface SpecFinding {
  readonly severity: "red" | "additive";
  readonly kind: SpecFindingKind;
  /** The view whose drift it is (the seed paths sharing its top-level key; else the first view). */
  readonly view: EspnView;
  /** The pattern-level path, in src/drift's notation — what drift_state records and the alarm names. */
  readonly path: string;
  /** The first concrete path it was seen at (`$.settings.proTeams[3].id`). */
  readonly first: string;
  /** How many nodes showed it. */
  readonly count: number;
  /** `enum`: the value as an ESPN token (or null when it is not one); `short`: the item count. */
  readonly value: string | null;
}

/** What one answer showed: its findings and, per view, the spec paths it verified. */
export interface SpecVerdict {
  readonly findings: readonly SpecFinding[];
  readonly verified: ReadonlyMap<EspnView, ReadonlySet<string>>;
}

/** The top-level key a pattern-level path starts with (`$.settings.x` → `settings`), or null. */
function topKey(path: string): string | null {
  const m = /^\$\.([A-Za-z_$][\w$]*)/.exec(path);
  return m?.[1] ?? null;
}

/**
 * The view a pattern-level path belongs to: the first requested view one of whose seed paths
 * (src/drift REQUIRED_PATHS_BY_VIEW) starts with the same top-level key — `settings` → mSettings,
 * `members` → mNav, `teams` → mTeam, `settings` → proTeamSchedules_wl on the host probe — else the
 * first requested view (`status`, the root's `id`/`seasonId`…: what mSettings answers).
 */
export function viewOfPath(path: string, views: readonly EspnView[]): EspnView {
  const k = topKey(path);
  const first = views[0] ?? "mSettings";
  if (k === null) return first;
  return views.find((v) => REQUIRED_PATHS_BY_VIEW[v].some((p) => topKey(p) === k)) ?? first;
}

/**
 * Judges a parsed answer against `spec` for the requested `views` (scripts/espn-fixture/drift.ts
 * `diffBody`, finding for finding — aggregated per (kind, pattern, key) with the first concrete path
 * and a count — plus the verified paths): a required key missing → `removed`, of another type →
 * `type`, a selected node that is not an object → `not_object`, a list under its `minItems` →
 * `short`, a value outside its `enums` set (or not a JSON scalar) → `enum` (all red); a key outside
 * `observed`, the required keys and `scrubbed` → `added` (additive). A selection over the node cap
 * is one red `oversize` finding for its pattern. Never throws on any body.
 */
export function judgeSpec(spec: ProbeSpec, views: readonly EspnView[], body: unknown): SpecVerdict {
  const agg = new Map<string, { -readonly [K in keyof SpecFinding]: SpecFinding[K] }>();
  const perKind = new Map<SpecFindingKind, number>();
  const verified = new Map<EspnView, Set<string>>();
  const verify = (path: string): void => {
    const view = viewOfPath(path, views);
    const set = verified.get(view) ?? new Set<string>();
    set.add(path);
    verified.set(view, set);
  };
  const add = (
    key: string,
    f: Omit<SpecFinding, "count" | "view" | "value"> & { readonly value?: string | null },
  ): void => {
    const prev = agg.get(key);
    if (prev !== undefined) {
      prev.count++;
      return;
    }
    const n = perKind.get(f.kind) ?? 0;
    if (n >= MAX_FINDINGS_PER_KIND) return;
    perKind.set(f.kind, n + 1);
    agg.set(key, {
      ...f,
      value: f.value ?? null,
      view: viewOfPath(f.path, views),
      count: 1,
    });
  };
  const sel = (pattern: string): Node[] | null => {
    try {
      return select(body, parseSpecPattern(pattern));
    } catch (e) {
      if (!(e instanceof SelectionTooLarge)) throw e;
      add(`oversize|${pattern}`, { severity: "red", kind: "oversize", path: pattern, first: "$" });
      return null;
    }
  };

  for (const [pattern, keys] of Object.entries(spec.required)) {
    const nodes = sel(pattern);
    if (nodes === null || nodes.length === 0) continue;
    let allObjects = true;
    const bad = new Set<string>();
    for (const node of nodes) {
      const v = node.value;
      if (!isObj(v)) {
        allObjects = false;
        add(`not_object|${pattern}`, {
          severity: "red",
          kind: "not_object",
          path: pattern,
          first: formatPath(node.segs),
        });
        continue;
      }
      for (const [k, t] of Object.entries(keys)) {
        if (!Object.prototype.hasOwnProperty.call(v, k)) {
          bad.add(k);
          add(`removed|${pattern}|${k}`, {
            severity: "red",
            kind: "removed",
            path: `${pattern}.${k}`,
            first: formatPath([...node.segs, k]),
          });
        } else if (!typeMatches(v[k], t)) {
          bad.add(k);
          add(`type|${pattern}|${k}`, {
            severity: "red",
            kind: "type",
            path: `${pattern}.${k}`,
            first: formatPath([...node.segs, k]),
          });
        }
      }
    }
    // a pattern that selected objects only verifies itself; each key every node has, typed, too
    if (allObjects) {
      verify(pattern);
      for (const k of Object.keys(keys)) if (!bad.has(k)) verify(`${pattern}.${k}`);
    }
  }

  const known = new Map<string, Set<string>>();
  const learn = (pattern: string, keys: Iterable<string>): void => {
    const set = known.get(pattern) ?? new Set<string>();
    for (const k of keys) set.add(k);
    known.set(pattern, set);
  };
  for (const [pattern, keys] of Object.entries(spec.observed)) learn(pattern, keys);
  for (const [pattern, keys] of Object.entries(spec.required)) learn(pattern, Object.keys(keys));
  for (const [pattern, keys] of Object.entries(spec.scrubbed ?? {})) learn(pattern, keys);
  for (const [pattern, keys] of known) {
    for (const node of sel(pattern) ?? []) {
      if (!isObj(node.value)) continue;
      for (const k of Object.keys(node.value)) {
        if (keys.has(k)) continue;
        add(`added|${pattern}|${k}`, {
          severity: "additive",
          kind: "added",
          path: `${pattern}.${IDENT_RE.test(k) ? k : "<key>"}`,
          first: formatPath([...node.segs, k]),
        });
      }
    }
  }

  for (const [pattern, min] of Object.entries(spec.minItems ?? {})) {
    const nodes = sel(pattern);
    if (nodes === null || nodes.length === 0) continue;
    let short = false;
    for (const node of nodes) {
      if (!Array.isArray(node.value) || node.value.length < min) {
        short = true;
        add(`short|${pattern}`, {
          severity: "red",
          kind: "short",
          path: pattern,
          first: formatPath(node.segs),
          value: Array.isArray(node.value) ? String(node.value.length) : null,
        });
      }
    }
    if (!short) verify(pattern);
  }

  for (const [pattern, allowed] of Object.entries(spec.enums ?? {})) {
    const set = new Set(allowed.map((a) => JSON.stringify(a)));
    const nodes = sel(pattern);
    if (nodes === null || nodes.length === 0) continue;
    let outside = false;
    for (const node of nodes) {
      // only a JSON scalar is compared (a deep value could not even be stringified): anything else
      // is outside every enum set
      const scalar = isScalar(node.value);
      const text = scalar ? JSON.stringify(node.value) : null;
      if (text !== null && set.has(text)) continue;
      outside = true;
      add(`enum|${pattern}|${text ?? `<${jsonTypeOf(node.value)}>`}`, {
        severity: "red",
        kind: "enum",
        path: pattern,
        first: formatPath(node.segs),
        value: scalar ? enumToken(node.value) : null,
      });
    }
    if (!outside) verify(pattern);
  }

  const findings = [...agg.values()].sort((a, b) =>
    a.severity === b.severity
      ? a.first < b.first
        ? -1
        : a.first > b.first
          ? 1
          : 0
      : a.severity === "red"
        ? -1
        : 1,
  );
  // a path some finding names is not verified (a key missing on one node of several)
  for (const f of findings) verified.get(f.view)?.delete(f.path);
  return { findings, verified };
}

/**
 * The drift signals of a verdict's findings (src/drift's vocabulary): every red finding fails the
 * response (`missing_required_key` — drift_state records its path as removed, red); every additive
 * one is an `additive_key`. An enum finding carries its value token.
 */
export function specSignals(findings: readonly SpecFinding[]): DriftSignal[] {
  return findings.map((f) => ({
    kind: f.severity === "red" ? ("missing_required_key" as const) : ("additive_key" as const),
    view: f.view,
    path: f.path,
    value: f.kind === "enum" ? f.value : null,
  }));
}

/** What an alarm or a probe line says a red finding did to its path (fixed vocabulary). */
export function findingPhrase(f: Pick<SpecFinding, "kind" | "path" | "value">): string {
  switch (f.kind) {
    case "removed":
      return `removed ${f.path}`;
    case "type":
    case "not_object":
      return `changed the type of ${f.path}`;
    case "short":
      return `shortened ${f.path}${f.value === null ? "" : ` to ${f.value} item(s)`}`;
    case "enum":
      return `unknown value${f.value === null ? "" : ` ${f.value}`} at ${f.path}`;
    case "oversize":
      return `oversized ${f.path}`;
    case "added":
      return `added ${f.path}`;
  }
}

// --- the manifest's probes section ----------------------------------------------------------------

function stringList(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string"))
    throw new Error(`probe spec: ${what} is not a string list`);
  return v;
}

function patternsOf<T>(
  v: unknown,
  what: string,
  each: (x: unknown, pattern: string) => T,
): Record<string, T> {
  if (!isObj(v)) throw new Error(`probe spec: ${what} is not an object`);
  const out: Record<string, T> = {};
  for (const [pattern, x] of Object.entries(v)) {
    parseSpecPattern(pattern);
    out[pattern] = each(x, pattern);
  }
  return out;
}

/** Validates one probe spec (a malformed spec must never read as "no drift": it throws). */
export function parseProbeSpec(v: unknown, name: string): ProbeSpec {
  if (!isObj(v)) throw new Error(`probe spec: probes.${name} is missing`);
  const views = stringList(v.views, `probes.${name}.views`);
  if (views.length === 0 || !views.every((x) => isEspnView(x)))
    throw new Error(`probe spec: probes.${name}.views names an unknown view`);
  const required = patternsOf(v.required, `probes.${name}.required`, (keys, pattern) => {
    if (!isObj(keys) || Object.keys(keys).length === 0)
      throw new Error(`probe spec: required ${pattern} is empty`);
    const out: Record<string, string> = {};
    for (const [k, t] of Object.entries(keys)) {
      if (typeof t !== "string" || !t.split("|").every((x) => TYPE_NAMES.has(x) || x === "any"))
        throw new Error(`probe spec: required ${pattern} has a bad type`);
      out[k] = t;
    }
    return out;
  });
  if (Object.keys(required).length === 0)
    throw new Error(`probe spec: probes.${name}.required is empty`);
  const observed = patternsOf(v.observed, `probes.${name}.observed`, (keys, pattern) =>
    stringList(keys, `observed ${pattern}`),
  );
  const scrubbed =
    v.scrubbed === undefined
      ? undefined
      : patternsOf(v.scrubbed, `probes.${name}.scrubbed`, (keys, pattern) =>
          stringList(keys, `scrubbed ${pattern}`),
        );
  const minItems =
    v.minItems === undefined
      ? undefined
      : patternsOf(v.minItems, `probes.${name}.minItems`, (n, pattern) => {
          if (typeof n !== "number" || !Number.isInteger(n) || n < 0)
            throw new Error(`probe spec: minItems ${pattern} is not a count`);
          return n;
        });
  const enums =
    v.enums === undefined
      ? undefined
      : patternsOf(v.enums, `probes.${name}.enums`, (vals, pattern) => {
          if (!Array.isArray(vals) || vals.length === 0 || !vals.every(isScalar))
            throw new Error(`probe spec: enums ${pattern} is not a value list`);
          return vals;
        });
  return Object.freeze({
    views,
    required,
    observed,
    ...(scrubbed === undefined ? {} : { scrubbed }),
    ...(minItems === undefined ? {} : { minItems }),
    ...(enums === undefined ? {} : { enums }),
  });
}

/** The probes section of a parsed drift manifest (throws when it is missing or malformed). */
export function parseProbeSpecs(manifest: unknown): ProbeSpecs {
  if (!isObj(manifest) || !isObj(manifest.probes))
    throw new Error("probe spec: the manifest has no probes section");
  return Object.freeze({
    host: parseProbeSpec(manifest.probes.host, "host"),
    shape: parseProbeSpec(manifest.probes.shape, "shape"),
  });
}
