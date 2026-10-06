// pattern.ts — the drift manifests' path language over a parsed body (plan 01 §7; research 03 §F.2):
// `$` the root, `.key` a property, `[]` every array element, `{}` every value of an object. The
// same selection rule as scripts/espn-fixture/drift.ts (src/ may not import scripts/ — ported, and
// tests/drift/pattern.test.ts holds the two equal on every recorded fixture). Pure; bounded.

/** One parsed pattern step. */
export type PatternStep =
  { readonly t: "key"; readonly k: string } | { readonly t: "each" } | { readonly t: "vals" };

/** A selected node: its concrete path segments and its value. */
export interface SelectedNode {
  readonly segs: readonly (string | number)[];
  readonly value: unknown;
}

const KEY_STEP_RE = /^\.([A-Za-z_$][\w$]*)/;
/** At most this many nodes are carried through one selection (a hostile body cannot blow up). */
export const MAX_SELECTED_NODES = 200_000;

/** Whether `v` is a plain JSON object (not an array, not null). */
export function isJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parses a pattern; throws on anything outside the grammar (a manifest bug, never input). */
export function parsePattern(pattern: string): readonly PatternStep[] {
  if (!pattern.startsWith("$")) throw new Error("drift: pattern must start with $");
  const out: PatternStep[] = [];
  let i = 1;
  while (i < pattern.length) {
    if (pattern.startsWith("[]", i)) {
      out.push({ t: "each" });
      i += 2;
    } else if (pattern.startsWith("{}", i)) {
      out.push({ t: "vals" });
      i += 2;
    } else {
      const m = KEY_STEP_RE.exec(pattern.slice(i));
      if (m?.[1] === undefined) throw new Error("drift: bad pattern step");
      out.push({ t: "key", k: m[1] });
      i += m[0].length;
    }
  }
  return out;
}

/** Every node a pattern selects; a missing intermediate key selects nothing. */
export function select(body: unknown, pattern: string): SelectedNode[] {
  let nodes: SelectedNode[] = [{ segs: [], value: body }];
  for (const step of parsePattern(pattern)) {
    const next: SelectedNode[] = [];
    for (const n of nodes) {
      const v = n.value;
      if (step.t === "key") {
        if (isJsonObject(v) && Object.prototype.hasOwnProperty.call(v, step.k))
          next.push({ segs: [...n.segs, step.k], value: v[step.k] });
      } else if (step.t === "each") {
        if (Array.isArray(v)) v.forEach((el, i) => next.push({ segs: [...n.segs, i], value: el }));
      } else if (isJsonObject(v)) {
        for (const k of Object.keys(v)) next.push({ segs: [...n.segs, k], value: v[k] });
      }
      if (next.length > MAX_SELECTED_NODES) throw new Error("drift: selection too large");
    }
    nodes = next;
  }
  return nodes;
}

/**
 * A required path's status on a body: `present` when the parent pattern selects ≥ 1 node and
 * every one has the last key (`…[]`: the parent is a non-empty array), `absent` when none does
 * (or nothing is selected), `partial` otherwise.
 */
export function requiredPathStatus(
  body: unknown,
  requiredPath: string,
): "present" | "absent" | "partial" {
  if (requiredPath.endsWith("[]")) {
    const parents = select(body, requiredPath.slice(0, -2));
    if (parents.length === 0) return "absent";
    const ok = parents.filter((n) => Array.isArray(n.value) && n.value.length > 0).length;
    return ok === parents.length ? "present" : ok === 0 ? "absent" : "partial";
  }
  const dot = requiredPath.lastIndexOf(".");
  const key = requiredPath.slice(dot + 1);
  const parents = select(body, requiredPath.slice(0, dot));
  if (parents.length === 0) return "absent";
  const ok = parents.filter(
    (n) => isJsonObject(n.value) && Object.prototype.hasOwnProperty.call(n.value, key),
  ).length;
  return ok === parents.length ? "present" : ok === 0 ? "absent" : "partial";
}

/** The SAFE_JSON_PATH grammar of an error's `path` (src/mcp/errors.ts): no `$`, ≤ 120 chars. */
export const ERROR_PATH_RE = /^[A-Za-z0-9_.[\]<>]{1,120}$/;
const PATH_SEG_RE = /^[A-Za-z0-9_]{1,40}$/;

/**
 * Renders a pattern or concrete path for an error's `path` field: the leading `$`/`$.` dropped,
 * odd keys as `<key>`, cut at a segment boundary to ≤ 120 chars; `<root>` for the root.
 */
export function errorPath(segsOrPattern: readonly (string | number)[] | string): string {
  const segs: (string | number)[] =
    typeof segsOrPattern === "string"
      ? patternSegments(segsOrPattern)
      : segsOrPattern.map((s) => s);
  let out = "";
  for (const s of segs) {
    const part =
      typeof s === "number"
        ? Number.isInteger(s) && s >= 0 && s < 1e7
          ? `[${String(s)}]`
          : "[]"
        : s === "[]"
          ? "[]"
          : `${out === "" ? "" : "."}${PATH_SEG_RE.test(s) ? s : "<key>"}`;
    if (out.length + part.length > 120) break;
    out += part;
  }
  return out === "" ? "<root>" : out;
}

/** A pattern's steps as path segments (`[]` kept as the literal "[]"; `{}` as `<key>`). */
function patternSegments(pattern: string): (string | number)[] {
  return parsePattern(pattern).map((s) => (s.t === "key" ? s.k : s.t === "each" ? "[]" : "<key>"));
}
