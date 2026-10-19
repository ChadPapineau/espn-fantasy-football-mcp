// probe.ts — `eff probe [--host-only] [--notify] [--json]`, the daily drift probe as a subcommand
// (plan 06 J4, §1.2; plan 01 §7 "The daily probe"; plan 10 §3.0 Z4: daily launchd + probe_log +
// macOS notification via osascript execFile). Host probe: the keyless `proTeamSchedules_wl` season
// route; shape probe: keyless `mSettings&mNav&mTeam` on EFF_PROBE_LEAGUE_ID (or, unset, on the
// user's league when it answers anonymously — a private league's shape is covered by the cookie
// requests every job makes, so no cookie is sent here). Each response runs through src/drift's
// detector (required keys, skeleton, and — when the checkout ships the manifest — enums and additive
// keys); a 3xx or a non-JSON body is `host_moved`. It writes probe_log rows and the drift_state
// row, never a dataset file (`eff refresh` stays their only writer). The drift alarm is never
// rate-limited and fires once per state change. Exit 4 on red or host moved (plan 03 §1.3).
import {
  checkResponse,
  DriftStateWriter,
  failsResponse,
  hostMovedSignal,
  probeExitCode,
  type DriftSignal,
  type DriftStatus,
} from "../drift/index.js";
import type { LenientConfig } from "../config/schema.js";
import type { Clock } from "../domain/clock.js";
import type { DriftObservations, ManifestIdentity } from "../drift/types.js";
import { createHttpClient, type HttpClient } from "../http/client.js";
import { leagueTarget, seasonTarget } from "../providers/espn/path.js";
import type { EspnView } from "../providers/espn/types.js";
import type {
  LimiterRepository,
  ProbeLogRow,
  RequestOrigin,
  Store,
  StoreFactory,
} from "../store/types.js";
import { driftManifest } from "./espn-stack.js";
import { espnRequest, jsonBody, type EspnAnswer } from "./espn-http.js";
import { EXIT } from "./exit.js";
import { writeLine, type CliIo } from "./io.js";
import { readJobState, stateToken, updateJobState } from "./job-state.js";
import type { Logger } from "./log.js";
import { createNotifier } from "./notify.js";
import { errorText, openStore } from "./store-access.js";

/** One probe's verdict. */
export type ProbeCheckStatus = DriftStatus | "unreachable" | "config" | "skipped";

/** One probe's result (fixed vocabulary; never a body or a league id). */
export interface ProbeCheck {
  readonly name: "host" | "shape";
  readonly views: readonly EspnView[];
  readonly status: ProbeCheckStatus;
  readonly upstream_status: number | null;
  readonly reason: string | null;
  readonly signals: readonly DriftSignal[];
  /** `x-fantasy-server-time` / `date` of the answer (doctor #14 clock skew). */
  readonly server_time_ms: number | null;
}

/** What the probes need. */
export interface ProbeDeps {
  readonly http: Pick<HttpClient, "espnGet">;
  readonly limiter: LimiterRepository;
  readonly clock: Clock;
  readonly host: string;
  readonly observations: DriftObservations | undefined;
  /**
   * Whose request the limiter row records: `job` (the launchd drift probe — counted against the
   * jobs' daily keyless cap, plan 06 §1.4 + changelog V7) or `server` (an interactive run: `eff
   * doctor --online`, a manual `eff probe` — never charged to the jobs' cap). Default `job`.
   */
  readonly origin?: RequestOrigin;
}

/** The server time an answer reports (x-fantasy-server-time epoch ms, else Date), or null. */
export function serverTimeMs(headers: Readonly<Record<string, string>>): number | null {
  const x = headers["x-fantasy-server-time"];
  if (x !== undefined && /^\d{10,16}$/.test(x)) return Number(x);
  const d = headers.date;
  if (d === undefined) return null;
  const ms = Date.parse(d);
  return Number.isFinite(ms) ? ms : null;
}

function judge(
  name: "host" | "shape",
  views: readonly EspnView[],
  a: EspnAnswer,
  observations: DriftObservations | undefined,
): ProbeCheck {
  const base = { name, views, upstream_status: a.status, server_time_ms: serverTimeMs(a.headers) };
  const body = jsonBody(a);
  if (a.status === 200 && (typeof body !== "object" || body === null))
    return {
      ...base,
      status: "host_moved",
      reason: "non_json_200",
      signals: [hostMovedSignal(views[0] ?? "mSettings")],
    };
  if (a.status === 200) {
    const c = checkResponse(views, body, observations);
    // the same rule the drift_state writer applies: a removed key or a skeleton is red; a new
    // enum value or key is additive (counted, reviewed by a human — plan 01 §7)
    const red = c.signals.some(failsResponse);
    const status: DriftStatus = red ? "red" : c.signals.length > 0 ? "additive" : "green";
    return {
      ...base,
      status,
      reason: c.first === null ? null : `${c.first.kind} ${c.first.path}`,
      signals: c.signals,
    };
  }
  if (a.status === 404) return { ...base, status: "config", reason: "http_404", signals: [] };
  if (a.status === 429 || a.status >= 500)
    return { ...base, status: "unreachable", reason: `http_${String(a.status)}`, signals: [] };
  return { ...base, status: "config", reason: `http_${String(a.status)}`, signals: [] };
}

/** The keyless host probe (plan 06 §1.2: one request, no cookie, no league id). */
export async function hostProbe(deps: ProbeDeps, season: number): Promise<ProbeCheck> {
  const views: EspnView[] = ["proTeamSchedules_wl"];
  const url = seasonTarget({ host: deps.host, season, views: ["proTeamSchedules_wl"] }).url;
  const r = await espnRequest(
    { http: deps.http, limiter: deps.limiter, clock: deps.clock, origin: deps.origin ?? "job" },
    { url, cookie: null },
  );
  if ("error" in r) {
    if (r.error === "host_moved")
      return {
        name: "host",
        views,
        status: "host_moved",
        upstream_status: null,
        reason: "redirect_refused",
        signals: [hostMovedSignal("proTeamSchedules_wl")],
        server_time_ms: null,
      };
    return {
      name: "host",
      views,
      status: "unreachable",
      upstream_status: null,
      reason: r.error,
      signals: [],
      server_time_ms: null,
    };
  }
  // the keyless season route refusing an anonymous read is a host problem, not a config one
  if (r.status === 401 || r.status === 403)
    return {
      name: "host",
      views,
      status: "host_moved",
      upstream_status: r.status,
      reason: `http_${String(r.status)}`,
      signals: [hostMovedSignal("proTeamSchedules_wl")],
      server_time_ms: serverTimeMs(r.headers),
    };
  return judge("host", views, r, deps.observations);
}

/** The keyless shape probe on a league (`private` when it needs cookies — skipped, not drift). */
export async function shapeProbe(
  deps: ProbeDeps,
  season: number,
  leagueId: string,
  isProbeLeague: boolean,
): Promise<ProbeCheck> {
  const views: EspnView[] = ["mSettings", "mNav", "mTeam"];
  const url = leagueTarget({
    host: deps.host,
    season,
    leagueId,
    views: ["mSettings", "mNav", "mTeam"],
  }).url;
  const r = await espnRequest(
    { http: deps.http, limiter: deps.limiter, clock: deps.clock, origin: deps.origin ?? "job" },
    { url, cookie: null },
  );
  if ("error" in r) {
    if (r.error === "host_moved")
      return {
        name: "shape",
        views,
        status: "host_moved",
        upstream_status: null,
        reason: "redirect_refused",
        signals: [hostMovedSignal("mSettings")],
        server_time_ms: null,
      };
    return {
      name: "shape",
      views,
      status: "unreachable",
      upstream_status: null,
      reason: r.error,
      signals: [],
      server_time_ms: null,
    };
  }
  if (r.status === 401 || r.status === 403)
    return {
      name: "shape",
      views,
      status: isProbeLeague ? "config" : "skipped",
      upstream_status: r.status,
      reason: isProbeLeague ? "probe_league_not_public" : "private_league",
      signals: [],
      server_time_ms: serverTimeMs(r.headers),
    };
  return judge("shape", views, r, deps.observations);
}

const RANK: Record<ProbeCheckStatus, number> = {
  host_moved: 7,
  red: 6,
  unreachable: 5,
  config: 4,
  additive: 2,
  green: 1,
  skipped: 0,
};

/** The worst check status (skipped-only → green). */
export function worstStatus(checks: readonly ProbeCheck[]): ProbeCheckStatus {
  const w = checks.reduce<ProbeCheckStatus>(
    (acc, c) => (RANK[c.status] > RANK[acc] ? c.status : acc),
    "skipped",
  );
  return w === "skipped" ? "green" : w;
}

/** The exit code of a probe run (4 drift/host moved, 1 unreachable, 2 config, else 0). */
export function probeRunExit(status: ProbeCheckStatus): number {
  if (status === "unreachable") return EXIT.error;
  if (status === "config") return EXIT.usage;
  if (status === "skipped") return EXIT.ok;
  return probeExitCode(status);
}

/** The one alarm line (plan 06 §1.2: "ESPN drift: <view>: removed <key>"). */
export function alarmText(checks: readonly ProbeCheck[]): string | null {
  for (const c of checks) {
    if (c.status === "host_moved")
      return `ESPN host moved: ${c.views.join("+")} — run \`eff doctor --online\``;
    if (c.status === "red") {
      const s = c.signals.find((x) => x.kind !== "additive_key");
      return `ESPN drift: ${s?.view ?? c.views.join("+")}: ${s === undefined ? "changed" : `${s.kind === "skeleton" || s.kind === "missing_required_key" ? "removed" : "changed"} ${s.path}`}`;
    }
  }
  return null;
}

/** The probe_log `error` token of a failed check (fixed vocabulary: a signal kind or a reason code). */
export function probeErrorToken(c: ProbeCheck): string {
  const failing = c.signals.find(failsResponse);
  if (failing !== undefined) return failing.kind;
  const raw = (c.reason ?? c.status).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64);
  return /^[A-Za-z]/.test(raw) ? raw : `e${raw.slice(0, 63)}`;
}

/** What one recorded probe run left in drift_state. */
export interface RecordedProbe {
  readonly status: DriftStatus;
  /** When the row's bad episode began (`DriftStateRow.since`; null on a good row). */
  readonly since: string | null;
  /** A newer manifest discarded the diff computed against the old one (plan 03 §7: say so). */
  readonly rebaselined: boolean;
}

/**
 * The `alarm.drift` stamp of a bad drift_state state: its status and the instant its episode began
 * (fixed vocabulary + an ISO instant — job-state's token alphabet). The drift alarm fires once per
 * state change (plan 06 §1.2, §2): a stamp that names the EPISODE — not just `red` — can never match a
 * later episode, so the alarm fires again even when no probe saw the good state in between (an
 * in-call answer recovers drift_state too: Stage C finding probe-drift-alarm-stamp-sticks).
 */
export function driftAlarmKey(status: DriftStatus, since: string | null): string {
  return (since === null ? status : `${status}:${since}`)
    .replace(/[^A-Za-z0-9_.:-]/g, "_")
    .slice(0, 64);
}

/**
 * Records probe_log rows and the drift_state row through src/drift's probe transform
 * (DriftStateWriter.probed — plan 01 §7 "The daily probe"): the manifest the run judged against
 * (a newer one re-baselines), what each answer verified clears (the required-key drift of its
 * views), what the run found is recorded, a host move ends on a good answer of a run that saw none,
 * and last_probe_at moves. Before, a run recorded its signals and called `recovered()` with no
 * view, so a green probe never ended a red row (Stage C finding drift-red-never-clears).
 */
export function recordProbe(
  store: Store,
  clock: Clock,
  host: string,
  checks: readonly ProbeCheck[],
  manifest: ManifestIdentity | null = null,
): RecordedProbe {
  const at = clock.nowIso();
  for (const c of checks) {
    if (c.status === "skipped") continue;
    const row: ProbeLogRow = {
      at,
      kind: c.name,
      ok: c.status === "green" || c.status === "additive",
      status: c.status === "unreachable" || c.status === "config" ? "green" : c.status,
      upstream_status: c.upstream_status,
      error: c.status === "green" || c.status === "additive" ? null : probeErrorToken(c),
    };
    store.repos.probeLog.record(row);
  }
  const out = new DriftStateWriter(store.repos.driftState, clock, host).probed(checks, manifest);
  return { status: out.row.status, since: out.row.since, rebaselined: out.rebaselined };
}

/** Options of `eff probe`. */
export interface ProbeOptions {
  readonly hostOnly: boolean;
  readonly notify: boolean;
  readonly json: boolean;
  readonly factory?: StoreFactory;
}

/** `eff probe`. */
export async function probe(
  io: CliIo,
  config: LenientConfig,
  log: Logger,
  opts: ProbeOptions,
): Promise<number> {
  const notifier = createNotifier({
    platform: io.platform,
    exec: io.exec,
    clock: io.clock,
    cacheDir: config.cacheDir,
  });
  if (config.fixtureDir !== null) {
    await writeLine(
      io.stderr,
      "eff probe: fixture mode makes no network call — unset EFF_FIXTURE_DIR to probe ESPN",
    );
    return EXIT.usage;
  }
  let store: Store;
  try {
    store = openStore(config, io.clock, log, {
      migrate: true,
      ...(opts.factory ? { factory: opts.factory } : {}),
    });
  } catch (e) {
    await writeLine(io.stderr, `eff probe: the store could not be opened: ${errorText(e)}`);
    if (opts.notify) await notifier.failure("probe", "store");
    return EXIT.error;
  }
  try {
    const manifest = driftManifest(io, log);
    const deps: ProbeDeps = {
      http: createHttpClient({
        ...(io.fetch === null ? {} : { fetch: io.fetch }),
        espnReadHost: config.espnReadHost,
        log,
      }),
      limiter: store.repos.limiter,
      clock: io.clock,
      host: config.espnReadHost,
      observations: manifest?.observations,
      // the launchd job runs `probe --notify`; a run without it is someone at a terminal
      origin: opts.notify ? "job" : "server",
    };
    const checks: ProbeCheck[] = [await hostProbe(deps, config.season)];
    const league = config.probeLeagueId ?? config.leagueId;
    if (opts.hostOnly || league === null)
      checks.push({
        name: "shape",
        views: ["mSettings", "mNav", "mTeam"],
        status: "skipped",
        upstream_status: null,
        reason: opts.hostOnly ? "host_only" : "no_league",
        signals: [],
        server_time_ms: null,
      });
    else checks.push(await shapeProbe(deps, config.season, league, config.probeLeagueId !== null));
    const recorded = recordProbe(
      store,
      io.clock,
      config.espnReadHost,
      checks,
      manifest?.identity ?? null,
    );
    const stored = recorded.status;
    const status = worstStatus(checks);
    log.info("probe.done", {
      status,
      stored,
      manifest: deps.observations === undefined ? "absent" : "present",
      rebaselined: recorded.rebaselined,
    });

    // the drift alarm: once per bad episode, by the run that notifies (the launchd `probe --notify`).
    // A run without --notify (someone at a terminal, who sees the alarm line below) never stamps it,
    // so the scheduled probe still notifies that episode; a notification osascript could not show
    // is not stamped either (the next probe tries again). A good stored state ends the episode.
    const bad = stored === "red" || stored === "host_moved";
    const alarmed = stateToken(readJobState(config.cacheDir), "alarm.drift");
    if (bad) {
      const key = driftAlarmKey(stored, recorded.since);
      if (opts.notify && alarmed !== key) {
        const text = alarmText(checks) ?? `ESPN drift: ${stored} — run \`eff status\``;
        if ((await notifier.alarm(text)) !== "failed")
          updateJobState(config.cacheDir, { "alarm.drift": key });
      }
    } else if (alarmed !== null) updateJobState(config.cacheDir, { "alarm.drift": null });
    if (opts.notify && (status === "unreachable" || status === "config"))
      await notifier.failure("probe", status);

    if (opts.json) {
      await writeLine(
        io.stdout,
        JSON.stringify({
          probe: "espn-drift",
          at: io.clock.nowIso(),
          season: config.season,
          status,
          drift_state: stored,
          manifest: deps.observations === undefined ? "absent" : "present",
          rebaselined: recorded.rebaselined,
          checks: checks.map((c) => ({
            name: c.name,
            views: c.views,
            status: c.status,
            upstream_status: c.upstream_status,
            reason: c.reason,
            signals: c.signals.slice(0, 50),
          })),
        }),
      );
    } else {
      for (const c of checks)
        await writeLine(
          io.stdout,
          `${c.name.padEnd(6)} ${c.status.padEnd(11)} ${c.views.join("+")}${c.reason === null ? "" : `  (${c.reason})`}`,
        );
      await writeLine(
        io.stdout,
        `drift_state: ${stored}${deps.observations === undefined ? " (manifest absent: required keys and skeletons only)" : ""}${recorded.rebaselined ? " (re-baselined on a newer drift manifest: the old diff was discarded)" : ""}`,
      );
      const a = alarmText(checks);
      if (a !== null) await writeLine(io.stderr, a);
    }
    return probeRunExit(status === "green" || status === "additive" ? stored : status);
  } finally {
    store.close();
  }
}
