// detect.ts — the in-call drift detector `checkResponse(views, body)` the provider calls on EVERY
// parse (plan 01 §7 "In-call detection", zero extra requests; research 03 §A.2 P28, §F.2): skeleton
// detection (every key a requested view adds over the skeleton is absent — a renamed view answers
// 200), missing required keys (named by JSON path and view), unknown enum values (accepted, counted;
// `statSourceId`/`statSplitTypeId` are meaning-changing — the ENTRY fails, not the response), and
// additive keys (counted) against the manifest observations. It never auto-adapts.
import type { EspnView } from "../providers/espn/types.js";
import { isJsonObject, requiredPathStatus, select } from "./pattern.js";
import {
  REQUIRED_PATHS_BY_VIEW,
  SIGNAL_SEVERITY,
  type DriftObservations,
  type DriftSignal,
  type DriftSignalKind,
} from "./types.js";

/** Keys the fixture scrubber removes (scripts/espn-fixture/scrub.ts REMOVE_KEYS): known, never additive. */
export const SCRUBBED_KEYS: ReadonlySet<string> = new Set([
  "notificationSettings",
  "topics",
  "messageBoard",
  "communication",
]);
/** Enum patterns whose value changes a stat entry's meaning (plan 01 §7): unknown fails the entry. */
export const MEANING_CHANGING_ENUM_KEYS: ReadonlySet<string> = new Set([
  "statSourceId",
  "statSplitTypeId",
]);
/** At most this many enum or additive signals per view per response (bounded logs and state). */
export const MAX_SIGNALS_PER_KIND = 32;
/** An enum value is reported only in this shape (an ESPN token); anything else reads as null. */
const ENUM_TOKEN_RE = /^[A-Z0-9_]{1,64}$/;

/** The detector's verdict on one response. */
export interface DriftCheck {
  readonly signals: readonly DriftSignal[];
  /** A required key is missing or the body is a skeleton: `ESPN_DRIFT_DETECTED`, nothing cached. */
  readonly drifted: boolean;
  /** Every required key of some requested view is absent (the renamed-view / P28 case). */
  readonly skeleton: boolean;
  /** The first response-failing signal (its view and path name the error), or null. */
  readonly first: DriftSignal | null;
}

/** The token an enum signal carries: an ESPN enum token or an integer; anything else → null. */
export function enumToken(v: unknown): string | null {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : null;
  if (typeof v === "string") return ENUM_TOKEN_RE.test(v) ? v : null;
  return null;
}

function lastKey(pattern: string): string {
  const m = /\.([A-Za-z_$][\w$]*)$/.exec(pattern);
  return m?.[1] ?? "";
}

/** The response-level signals of the required-path seed for `views` (skeleton / missing key). */
function requiredSignals(
  views: readonly EspnView[],
  body: unknown,
): { signals: DriftSignal[]; skeleton: boolean } {
  const signals: DriftSignal[] = [];
  let skeleton = false;
  for (const view of views) {
    const paths = REQUIRED_PATHS_BY_VIEW[view];
    const statuses = paths.map((p) => ({ p, s: requiredPathStatus(body, p) }));
    if (statuses.every((x) => x.s === "absent")) {
      skeleton = true;
      for (const x of statuses) signals.push({ kind: "skeleton", view, path: x.p, value: null });
      continue;
    }
    for (const x of statuses)
      if (x.s !== "present")
        signals.push({ kind: "missing_required_key", view, path: x.p, value: null });
  }
  return { signals, skeleton };
}

/** Enum and additive signals for one view against its manifest observations. */
function observationSignals(
  view: EspnView,
  body: unknown,
  obs: DriftObservations[EspnView],
): DriftSignal[] {
  if (obs === undefined) return [];
  const out: DriftSignal[] = [];
  const seen = new Set<string>();
  let enums = 0;
  for (const [pattern, allowed] of Object.entries(obs.enums)) {
    const known = new Set(allowed.map((a) => JSON.stringify(a)));
    const kind: DriftSignalKind = MEANING_CHANGING_ENUM_KEYS.has(lastKey(pattern))
      ? "meaning_changing_enum"
      : "unknown_enum_value";
    for (const node of select(body, pattern)) {
      const v = node.value;
      if (typeof v !== "string" && typeof v !== "number") continue;
      if (known.has(JSON.stringify(v))) continue;
      const token = enumToken(v);
      const key = `${kind}|${pattern}|${String(token)}`;
      if (seen.has(key) || enums >= MAX_SIGNALS_PER_KIND) continue;
      seen.add(key);
      enums++;
      out.push({ kind, view, path: pattern, value: token });
    }
  }
  let added = 0;
  for (const [pattern, keys] of Object.entries(obs.observed)) {
    const known = new Set(keys);
    for (const node of select(body, pattern)) {
      if (!isJsonObject(node.value)) continue;
      for (const k of Object.keys(node.value)) {
        if (known.has(k) || SCRUBBED_KEYS.has(k)) continue;
        const path = `${pattern}.${/^[A-Za-z_$][\w$]*$/.test(k) ? k : "<key>"}`;
        if (seen.has(path) || added >= MAX_SIGNALS_PER_KIND) continue;
        seen.add(path);
        added++;
        out.push({ kind: "additive_key", view, path, value: null });
      }
    }
  }
  return out;
}

/**
 * Checks one parsed response for the requested `views` (plan 01 §7). `observations` (a drift
 * manifest's `views`) enables the enum and additive checks; without it only the required-path
 * seed runs. Pure: the provider writes `drift_state` and decides the result.
 */
export function checkResponse(
  views: readonly EspnView[],
  body: unknown,
  observations?: DriftObservations,
): DriftCheck {
  const { signals, skeleton } = requiredSignals(views, body);
  const drifted = signals.length > 0;
  if (!drifted && observations !== undefined)
    for (const view of views) signals.push(...observationSignals(view, body, observations[view]));
  return {
    signals,
    drifted,
    skeleton,
    first: signals.find((s) => s.kind === "skeleton" || s.kind === "missing_required_key") ?? null,
  };
}

/** A host-moved signal (the transport classifier saw a 3xx or a non-JSON body — plan 01 §7). */
export function hostMovedSignal(view: EspnView): DriftSignal {
  return { kind: "host_moved", view, path: "$", value: null };
}

/** Whether a signal fails the whole response (missing key, skeleton, host moved). */
export function failsResponse(s: DriftSignal): boolean {
  return SIGNAL_SEVERITY[s.kind] === "error" && s.kind !== "meaning_changing_enum";
}
