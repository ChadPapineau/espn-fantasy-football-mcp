// state.ts — the in-call side of the `drift_state` row (plan 01 §7: a missing required key or a
// skeleton writes the row and the cache entry is NOT written; a 3xx / non-JSON answer sets
// `host_moved_at` and the status `host_moved`, under which every ESPN-fact read suspends its hard
// limit; `meta.drift` on every result that used an affected view; T-14: `mSettings` drift refuses to
// score — a golden MISMATCH degrades per player and is the scoring module's call, never recorded
// here). Pure transforms over the row plus a writer through the injected repository.
//
// Drift is a fact about the LATEST answer, not a latch (Stage C finding drift-red-never-clears):
// a complete answer for a view clears that view's removed keys — `applyRecovered` with the views
// the answer verified (an in-call answer that passed the required keys AND the view schema clears
// every removed key of its views; a probe answer, which checks the required-key seed only, clears
// the seed's keys) — so scoring is refused only while the drift is still present. A good JSON
// answer from the CONFIGURED read host ends a host move, whichever host moved: that is the
// operator override's recovery (plan 01 §7, ADV OBJ-06; finding drift-host-override-never-recovers).
// A newer manifest re-baselines the row (plan 03 §7: `applyManifest` discards the diff computed
// against the old manifest, records the new `manifest_hash` / `manifest_version`, says so).
import type { Clock } from "../domain/clock.js";
import type { DriftMeta } from "../domain/league/types.js";
import { isEspnView, type EspnView } from "../providers/espn/types.js";
import { failsResponse } from "./detect.js";
import { errorPath } from "./pattern.js";
import {
  REQUIRED_PATHS_BY_VIEW,
  type DriftSignal,
  type DriftStateRepository,
  type DriftStateRow,
  type DriftStatus,
  type ManifestIdentity,
  type ViewDiff,
} from "./types.js";

/** At most this many paths per view list are kept in the row (bounded state). */
export const MAX_DIFF_PATHS = 64;

/** The views whose drift makes EVERY result carry `meta.drift` (plan 01 §7: mSettings). */
export const LEAGUE_WIDE_DRIFT_VIEWS: readonly EspnView[] = Object.freeze(["mSettings"]);

const PATH_RE = /^[A-Za-z0-9_$.[\]{}<>=?-]{1,160}$/;

function cleanList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v)
    if (typeof x === "string" && PATH_RE.test(x) && !out.includes(x) && out.length < MAX_DIFF_PATHS)
      out.push(x);
  return out;
}

/** Parses a stored diff list; anything malformed is dropped (a bad row never throws). */
export function parseDiffs(json: string): ViewDiff[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: ViewDiff[] = [];
  for (const d of raw) {
    if (typeof d !== "object" || d === null) continue;
    const r = d as Record<string, unknown>;
    if (typeof r.view !== "string" || !isEspnView(r.view)) continue;
    out.push({
      view: r.view,
      removed: cleanList(r.removed),
      added: cleanList(r.added),
      enums: cleanList(r.enums),
    });
  }
  return out;
}

function merge(list: ViewDiff[], view: EspnView, field: keyof Omit<ViewDiff, "view">, v: string) {
  let d = list.find((x) => x.view === view);
  if (d === undefined) {
    d = { view, removed: [], added: [], enums: [] };
    list.push(d);
  }
  const arr = d[field] as string[];
  if (!arr.includes(v) && arr.length < MAX_DIFF_PATHS && PATH_RE.test(v)) arr.push(v);
}

/** The status a row implies: host moved > a removed key > additive keys or new enum values > green. */
export function statusOf(
  hostMoved: boolean,
  diffs: readonly ViewDiff[],
  additive: readonly ViewDiff[],
): DriftStatus {
  if (hostMoved) return "host_moved";
  if (diffs.some((d) => d.removed.length > 0)) return "red";
  if ([...diffs, ...additive].some((d) => d.added.length > 0 || d.enums.length > 0))
    return "additive";
  return "green";
}

function emptyRow(host: string, nowIso: string): DriftStateRow {
  return {
    status: "green",
    since: null,
    last_probe_at: null,
    manifest_hash: null,
    manifest_version: null,
    host,
    host_moved_at: null,
    diff_json: "[]",
    additive_json: "[]",
    updated_at: nowIso,
  };
}

/** The row after one response's signals (pure). Failing signals go to the diff, the rest to additive. */
export function applySignals(
  row: DriftStateRow | null,
  signals: readonly DriftSignal[],
  host: string,
  nowIso: string,
): DriftStateRow {
  const base = row ?? emptyRow(host, nowIso);
  const diffs = parseDiffs(base.diff_json);
  const additive = parseDiffs(base.additive_json);
  for (const s of signals) {
    if (s.kind === "host_moved") continue;
    if (failsResponse(s)) merge(diffs, s.view, "removed", s.path);
    else if (s.kind === "additive_key") merge(additive, s.view, "added", s.path);
    else merge(additive, s.view, "enums", `${s.path}=${s.value ?? "?"}`);
  }
  const movedNow = signals.some((s) => s.kind === "host_moved");
  const hostMoved = base.status === "host_moved" || movedNow;
  const status = statusOf(hostMoved, diffs, additive);
  const wasBad = base.status === "red" || base.status === "host_moved";
  const isBad = status === "red" || status === "host_moved";
  return {
    ...base,
    status,
    since: isBad ? (wasBad ? (base.since ?? nowIso) : nowIso) : base.since,
    // the row names the host whose answer moved (what `eff status` and doctor #15 report)
    host: movedNow ? host : base.host,
    host_moved_at: hostMoved ? (base.host_moved_at ?? nowIso) : base.host_moved_at,
    diff_json: JSON.stringify(diffs),
    additive_json: JSON.stringify(additive),
    updated_at: nowIso,
  };
}

/**
 * How much of a view a good answer verified: `schema` — the required-key seed AND the view's
 * schema passed (an in-call answer the provider parsed), so every removed key of the view is back;
 * `required_paths` — only the seed (`REQUIRED_PATHS_BY_VIEW`) was checked (the daily probe runs no
 * view schema), so only the seed's removed keys are cleared and a schema-level one stays until an
 * in-call answer verifies it.
 */
export type Verification = "schema" | "required_paths";

function clearedBy(view: EspnView, path: string, verification: Verification): boolean {
  return verification === "schema" || REQUIRED_PATHS_BY_VIEW[view].includes(path);
}

/**
 * The row after a well-formed JSON answer from `host` — the CONFIGURED read host of the process
 * that received it — which verified `views` (pure):
 * - a host move is over, whichever host it was recorded for: the configured host serves JSON (the
 *   default host again, or the operator override `EFF_ESPN_READ_HOST` that replaced it — plan 01
 *   §7, ADV OBJ-06); the row then names `host`;
 * - each verified view's removed keys are cleared (all of them under `schema`, the seed's under
 *   `required_paths`): drift is a fact about the latest answer, so a later complete answer ends it;
 * - additive keys and new enum values stay: a human reviews them and regenerates the manifest
 *   (cleared by `applyManifest` on the newer manifest).
 * The status follows what remains. A row with nothing to clear is returned unchanged (the same
 * object — the writer then writes nothing).
 */
export function applyRecovered(
  row: DriftStateRow,
  host: string,
  nowIso: string,
  views: readonly EspnView[] = [],
  verification: Verification = "schema",
): DriftStateRow {
  const moved = row.status === "host_moved";
  const diffs = parseDiffs(row.diff_json);
  let cleared = false;
  const next: ViewDiff[] = [];
  for (const d of diffs) {
    const removed = views.includes(d.view)
      ? d.removed.filter((p) => !clearedBy(d.view, p, verification))
      : d.removed;
    if (removed.length !== d.removed.length) cleared = true;
    if (removed.length + d.added.length + d.enums.length > 0) next.push({ ...d, removed });
  }
  if (!moved && !cleared) return row;
  const status = statusOf(false, next, parseDiffs(row.additive_json));
  return {
    ...row,
    status,
    since: status === "red" ? (row.since ?? nowIso) : null,
    host: moved ? host : row.host,
    host_moved_at: null,
    diff_json: JSON.stringify(next),
    updated_at: nowIso,
  };
}

/** The outcome of `applyManifest`: the row to store and whether the diff was re-baselined. */
export interface ManifestOutcome {
  readonly row: DriftStateRow;
  /** True when the row's diff (computed against another manifest) was discarded — say so. */
  readonly rebaselined: boolean;
}

/**
 * The row under the manifest `manifest` (plan 03 §7: "the manifest has its own version in
 * drift_state; a binary with a newer manifest re-baselines on its first probe and says so"; pure):
 * - no row yet → a green row that records the manifest (nothing to discard);
 * - the row records the same manifest → unchanged (the same object);
 * - the row records no manifest (written before any probe) → the manifest is recorded and the diff
 *   kept: nothing says it was computed against another one, and drift is never dropped on doubt;
 * - the row records ANOTHER manifest (a different hash or version — the human re-recorded the
 *   fixtures and regenerated it) → re-baselined: the removed / added / enum lists computed against
 *   the old manifest are discarded and the new identity recorded; a host move is not a manifest
 *   fact and stays (a good answer ends it). Drift that is still real is found again by the probe
 *   that re-baselines and by the next in-call answer of its view (a drifted answer is never cached).
 */
export function applyManifest(
  row: DriftStateRow | null,
  manifest: ManifestIdentity,
  host: string,
  nowIso: string,
): ManifestOutcome {
  const stamp = { manifest_hash: manifest.hash, manifest_version: manifest.version };
  if (row === null) return { row: { ...emptyRow(host, nowIso), ...stamp }, rebaselined: false };
  if (row.manifest_hash === manifest.hash && row.manifest_version === manifest.version)
    return { row, rebaselined: false };
  if (row.manifest_hash === null && row.manifest_version === null)
    return { row: { ...row, ...stamp, updated_at: nowIso }, rebaselined: false };
  const moved = row.status === "host_moved";
  return {
    row: {
      ...row,
      ...stamp,
      status: statusOf(moved, [], []),
      since: moved ? row.since : null,
      diff_json: "[]",
      additive_json: "[]",
      updated_at: nowIso,
    },
    rebaselined: true,
  };
}

/** Writes the row (a `required` write — plan 01 §9.2); the caller decides what a failure means. */
export class DriftStateWriter {
  private readonly repo: DriftStateRepository;
  private readonly clock: Clock;
  private readonly host: string;

  constructor(repo: DriftStateRepository, clock: Clock, host: string) {
    this.repo = repo;
    this.clock = clock;
    this.host = host;
  }

  /** Records a response's signals (no-op for an empty list). Returns the row now stored. */
  record(signals: readonly DriftSignal[]): DriftStateRow | null {
    const current = this.repo.get();
    if (signals.length === 0) return current;
    const next = applySignals(current, signals, this.host, this.clock.nowIso());
    this.repo.put(next);
    return next;
  }

  /**
   * A good JSON answer arrived from this writer's (the configured) host and verified `views`
   * (`applyRecovered`): ends a host move and clears the verified views' removed keys. The provider
   * passes the views of every answer it parsed (`schema`); the probe the views of its green checks
   * (`required_paths`). Writes only when something changed. Returns the row now stored.
   */
  recovered(
    views: readonly EspnView[] = [],
    verification: Verification = "schema",
  ): DriftStateRow | null {
    const current = this.repo.get();
    if (current === null) return null;
    const next = applyRecovered(current, this.host, this.clock.nowIso(), views, verification);
    if (next !== current) this.repo.put(next);
    return next;
  }

  /**
   * Records the manifest this process judges against (`applyManifest`; the probe calls it before
   * recording its signals). Writes only when something changed; `rebaselined` says the old diff
   * was discarded.
   */
  rebaseline(manifest: ManifestIdentity): ManifestOutcome {
    const current = this.repo.get();
    const out = applyManifest(current, manifest, this.host, this.clock.nowIso());
    if (out.row !== current) this.repo.put(out.row);
    return out;
  }

  /** The stored row (null when none was ever written). */
  current(): DriftStateRow | null {
    return this.repo.get();
  }
}

/**
 * `meta.drift` for a result that used `views` (plan 01 §4.2, §7): non-null while the row is red or
 * host-moved and its diff names one of `views` — or names `mSettings`, whose drift every tool
 * carries — or the host moved (every ESPN view is affected).
 */
export function driftMetaFor(
  row: DriftStateRow | null,
  views: readonly EspnView[],
): DriftMeta | null {
  if (row === null || (row.status !== "red" && row.status !== "host_moved")) return null;
  const since = row.since ?? row.updated_at;
  if (row.status === "host_moved") return { views: [...views], since, detail: "espn_get_status" };
  const red = parseDiffs(row.diff_json)
    .filter((d) => d.removed.length > 0)
    .map((d) => d.view);
  const hit = red.filter((v) => views.includes(v) || LEAGUE_WIDE_DRIFT_VIEWS.includes(v));
  return hit.length === 0 ? null : { views: hit, since, detail: "espn_get_status" };
}

/**
 * Drift vs mismatch (plan 01 §7, T-14): `settings_drift` when the row records a missing
 * `mSettings` key — the server refuses to score; null otherwise. A golden mismatch (per player,
 * league-wide only above 10 %, plan 08 E6) is decided by the scoring module, not here. The row
 * records the key only while the drift is present: a later complete `mSettings` answer clears it
 * (`applyRecovered`), so the refusal ends with the drift.
 */
export function scoringRefusal(row: DriftStateRow | null): "settings_drift" | null {
  return settingsDriftPath(row) === null ? null : "settings_drift";
}

/**
 * The missing `mSettings` key a scoring refusal names (`ESPN_DRIFT_DETECTED { view: "mSettings",
 * path }`, in the error-path form): the first removed `mSettings` path the row records while it is
 * red or host-moved — the key that is actually missing, never a fixed stand-in — else null.
 */
export function settingsDriftPath(row: DriftStateRow | null): string | null {
  if (row?.status !== "red" && row?.status !== "host_moved") return null;
  for (const d of parseDiffs(row.diff_json)) {
    const first = d.view === "mSettings" ? d.removed[0] : undefined;
    if (first !== undefined) return renderedPath(first);
  }
  return null;
}

/** A stored path in the error-path form; a tampered one outside the pattern grammar reads `<key>`. */
function renderedPath(path: string): string {
  try {
    return errorPath(path);
  } catch {
    return "<key>";
  }
}
