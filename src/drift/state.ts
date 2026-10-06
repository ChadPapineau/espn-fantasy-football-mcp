// state.ts — the in-call side of the `drift_state` row (plan 01 §7: a missing required key or a
// skeleton writes the row and the cache entry is NOT written; a 3xx / non-JSON answer sets
// `host_moved_at` and the status `host_moved`, under which every ESPN-fact read suspends its hard
// limit; `meta.drift` on every result that used an affected view; T-14: `mSettings` drift refuses to
// score — a golden MISMATCH degrades per player and is the scoring module's call, never recorded
// here). Pure transforms over the row plus a writer through the injected repository.
import type { Clock } from "../domain/clock.js";
import type { DriftMeta } from "../domain/league/types.js";
import { isEspnView, type EspnView } from "../providers/espn/types.js";
import { failsResponse } from "./detect.js";
import type {
  DriftSignal,
  DriftStateRepository,
  DriftStateRow,
  DriftStatus,
  ViewDiff,
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
  const hostMoved = base.status === "host_moved" || signals.some((s) => s.kind === "host_moved");
  const status = statusOf(hostMoved, diffs, additive);
  const wasBad = base.status === "red" || base.status === "host_moved";
  const isBad = status === "red" || status === "host_moved";
  return {
    ...base,
    status,
    since: isBad ? (wasBad ? (base.since ?? nowIso) : nowIso) : base.since,
    host_moved_at: hostMoved ? (base.host_moved_at ?? nowIso) : base.host_moved_at,
    diff_json: JSON.stringify(diffs),
    additive_json: JSON.stringify(additive),
    updated_at: nowIso,
  };
}

/**
 * The row after a well-formed JSON answer from `host` while the row says `host_moved` for that
 * host: the move is over (the next good answer proves the host serves JSON again — decision
 * recorded); the status falls back to what the diffs say. Any other row is returned unchanged.
 */
export function applyHostRecovered(
  row: DriftStateRow,
  host: string,
  nowIso: string,
): DriftStateRow {
  if (row.status !== "host_moved" || row.host !== host) return row;
  const status = statusOf(false, parseDiffs(row.diff_json), parseDiffs(row.additive_json));
  return {
    ...row,
    status,
    since: status === "red" ? row.since : null,
    host_moved_at: null,
    updated_at: nowIso,
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

  /** A good JSON answer arrived: clears an in-call host move of this host. */
  recovered(): DriftStateRow | null {
    const current = this.repo.get();
    if (current === null) return null;
    const next = applyHostRecovered(current, this.host, this.clock.nowIso());
    if (next !== current) this.repo.put(next);
    return next;
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
 * league-wide only above 10 %, plan 08 E6) is decided by the scoring module, not here.
 */
export function scoringRefusal(row: DriftStateRow | null): "settings_drift" | null {
  if (row?.status !== "red" && row?.status !== "host_moved") return null;
  return parseDiffs(row.diff_json).some((d) => d.view === "mSettings" && d.removed.length > 0)
    ? "settings_drift"
    : null;
}
