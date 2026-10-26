// probe.ts — `eff probe [--host-only] [--notify] [--json]`, the daily drift probe as a subcommand
// (plan 06 J4, §1.2; plan 01 §7 "The daily probe"; plan 10 §3.0 Z4: daily launchd + probe_log +
// macOS notification via osascript execFile). Host probe: the keyless `proTeamSchedules_wl` season
// route; shape probe: keyless `mSettings&mNav&mTeam` on EFF_PROBE_LEAGUE_ID (or, unset, on the
// user's league when it answers anonymously — a private league's shape is covered by the cookie
// requests every job makes, so no cookie is sent here). Each response runs through src/drift's
// detector (required keys, skeleton, and — when the checkout ships the manifest — enums and additive
// keys) AND, when the checkout ships it, through the manifest's probe spec (probe-spec.ts: typed
// required keys, `minItems`, `enums` — plan 01 §7 "Diff against the manifest"; Stage C finding
// probe-manifest-specs-unevaluated); a 3xx or a non-JSON body is `host_moved`. It writes probe_log
// rows and the drift_state row, never a dataset file (`eff refresh` stays their only writer). The
// drift alarm is never rate-limited and fires once per state change. Exit 4 on red or host moved
// (plan 03 §1.3).
import {
  checkResponse,
  DriftStateWriter,
  failsResponse,
  hostMovedSignal,
  parseDiffs,
  probeExitCode,
  statusOf,
  type DriftSignal,
  type DriftStateRow,
  type DriftStatus,
} from "../drift/index.js";
import {
  SEASON_RENEWAL_TEXT,
  seasonMayAwaitRenewal,
  type LenientConfig,
} from "../config/schema.js";
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
import { driftManifest, driftProbeSpecs } from "./espn-stack.js";
import { espnRequest, jsonBody, type EspnAnswer } from "./espn-http.js";
import { EXIT } from "./exit.js";
import { writeLine, type CliIo } from "./io.js";
import { readJobState, stateToken, updateJobState } from "./job-state.js";
import type { Logger } from "./log.js";
import { createNotifier } from "./notify.js";
import {
  findingPhrase,
  judgeSpec,
  specSignals,
  type ProbeSpecs,
  type SpecFinding,
} from "./probe-spec.js";
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
  /** The manifest probe spec's findings on a judged answer (none without the spec). */
  readonly findings?: readonly SpecFinding[];
  /** Per view, the spec paths this answer verified (a later good probe clears what they name). */
  readonly verified?: ReadonlyMap<EspnView, ReadonlySet<string>>;
}

/** What the probes need. */
export interface ProbeDeps {
  readonly http: Pick<HttpClient, "espnGet">;
  readonly limiter: LimiterRepository;
  readonly clock: Clock;
  readonly host: string;
  readonly observations: DriftObservations | undefined;
  /**
   * The checkout's manifest probe specs (`probes.host` for the host probe, `probes.shape` for the
   * shape probe): typed required keys, `minItems` and `enums`, each red drift (plan 01 §7). Absent
   * → the seed paths and the observations only.
   */
  readonly specs?: ProbeSpecs;
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

/**
 * The signals of one judged answer: src/drift's detector first (the seed paths, skeletons, and the
 * observations' enum and additive keys), then the probe spec's findings it did not already name.
 */
function mergeSignals(
  detected: readonly DriftSignal[],
  spec: readonly DriftSignal[],
): DriftSignal[] {
  const seen = new Set(
    detected.map((s) => `${s.view}|${s.path}|${failsResponse(s) ? "red" : "add"}`),
  );
  const out = [...detected];
  for (const s of spec) {
    const key = `${s.view}|${s.path}|${failsResponse(s) ? "red" : "add"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function judge(
  name: "host" | "shape",
  views: readonly EspnView[],
  a: EspnAnswer,
  observations: DriftObservations | undefined,
  spec: ProbeSpecs["host"] | undefined,
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
    const verdict = spec === undefined ? null : judgeSpec(spec, views, body);
    const signals = mergeSignals(c.signals, verdict === null ? [] : specSignals(verdict.findings));
    // the same rule the drift_state writer applies: a removed key, a skeleton, or a red finding of
    // the manifest's probe spec is red; a new enum value or key is additive (counted, reviewed by a
    // human — plan 01 §7)
    const red = signals.some(failsResponse);
    const status: DriftStatus = red ? "red" : signals.length > 0 ? "additive" : "green";
    const firstRed = verdict?.findings.find((f) => f.severity === "red") ?? null;
    return {
      ...base,
      status,
      reason:
        c.first !== null
          ? `${c.first.kind} ${c.first.path}`
          : firstRed !== null
            ? `spec_${firstRed.kind} ${firstRed.path}`
            : null,
      signals,
      ...(verdict === null ? {} : { findings: verdict.findings, verified: verdict.verified }),
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
  return judge("host", views, r, deps.observations, deps.specs?.host);
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
  return judge("shape", views, r, deps.observations, deps.specs?.shape);
}

/**
 * A league 404 on a season that may await the league's renewal (config `seasonMayAwaitRenewal`:
 * the configured season, not a past one, before its October 1) is no configuration failure: the league — the probe
 * league or the user's — has no season on ESPN until its manager renews it, so the shape probe is
 * skipped with that reason, never `config`, never notified (Stage C finding
 * league-rollover-not-found-misdiagnosed). Any other check is returned unchanged.
 */
export function renewalSkipped(
  c: ProbeCheck,
  config: Pick<LenientConfig, "season">,
  nowMs: number,
): ProbeCheck {
  if (c.name !== "shape" || c.status !== "config" || c.upstream_status !== 404) return c;
  if (!seasonMayAwaitRenewal(config, nowMs)) return c;
  return { ...c, status: "skipped", reason: SEASON_RENEWAL_TEXT.reason };
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

/** The spec finding behind a signal (the same view and path), if the probe spec raised it. */
function findingOf(c: ProbeCheck, s: DriftSignal): SpecFinding | undefined {
  return c.findings?.find((f) => f.severity === "red" && f.view === s.view && f.path === s.path);
}

/**
 * The one alarm line (plan 06 §1.2: "ESPN drift: <view>: removed <key>"): the first response-failing
 * signal of the first red answer — a removed key or a skeleton says `removed`; a probe-spec finding
 * says what it saw (`removed`, `changed the type of`, `shortened`, `unknown value … at`).
 */
export function alarmText(checks: readonly ProbeCheck[]): string | null {
  for (const c of checks) {
    if (c.status === "host_moved")
      return `ESPN host moved: ${c.views.join("+")} — run \`eff doctor --online\``;
    if (c.status === "red") {
      const s = c.signals.find(failsResponse) ?? c.signals.find((x) => x.kind !== "additive_key");
      if (s === undefined) return `ESPN drift: ${c.views.join("+")}: changed`;
      const f = findingOf(c, s);
      if (f !== undefined) return `ESPN drift: ${s.view}: ${findingPhrase(f)}`;
      return `ESPN drift: ${s.view}: ${s.kind === "skeleton" || s.kind === "missing_required_key" ? "removed" : "changed"} ${s.path}`;
    }
  }
  return null;
}

/** The probe_log `error` token of a failed check (fixed vocabulary: a signal kind or a reason code). */
export function probeErrorToken(c: ProbeCheck): string {
  const failing = c.signals.find(failsResponse);
  if (failing !== undefined) {
    const f = findingOf(c, failing);
    return f === undefined ? failing.kind : `spec_${f.kind}`;
  }
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
 * The row with every removed path a probe answer just VERIFIED cleared (pure; nothing to clear → the
 * same object): src/drift's probe transform clears only the seed paths (`required_paths`), so a key
 * the manifest's probe spec found missing — `playoffSeedingRule`, a game's `date` — would stay red
 * after ESPN served it again, until some in-call answer of its view (Stage C finding
 * probe-manifest-specs-unevaluated). A path any answer of this run found failing is never cleared;
 * a host move is left to the transform.
 */
export function clearSpecVerified(
  row: DriftStateRow,
  checks: readonly ProbeCheck[],
  nowIso: string,
): DriftStateRow {
  if (row.status !== "red" && row.status !== "host_moved") return row;
  const failing = new Set(
    checks.flatMap((c) => c.signals.filter(failsResponse).map((s) => `${s.view}|${s.path}`)),
  );
  const verified = new Map<EspnView, Set<string>>();
  for (const c of checks) {
    const judged = c.status === "green" || c.status === "additive" || c.status === "red";
    if (!judged || c.verified === undefined) continue;
    for (const [view, paths] of c.verified) {
      const set = verified.get(view) ?? new Set<string>();
      for (const p of paths) if (!failing.has(`${view}|${p}`)) set.add(p);
      verified.set(view, set);
    }
  }
  if (verified.size === 0) return row;
  const diffs = parseDiffs(row.diff_json);
  let cleared = false;
  const next = [];
  for (const d of diffs) {
    const v = verified.get(d.view);
    const removed = v === undefined ? d.removed : d.removed.filter((p) => !v.has(p));
    if (removed.length !== d.removed.length) cleared = true;
    if (removed.length + d.added.length + d.enums.length > 0) next.push({ ...d, removed });
  }
  if (!cleared) return row;
  const moved = row.status === "host_moved";
  const status = statusOf(moved, next, parseDiffs(row.additive_json));
  return {
    ...row,
    status,
    since: status === "red" || moved ? (row.since ?? nowIso) : null,
    diff_json: JSON.stringify(next),
    updated_at: nowIso,
  };
}

/**
 * Records probe_log rows and the drift_state row through src/drift's probe transform
 * (DriftStateWriter.probed — plan 01 §7 "The daily probe"): the manifest the run judged against
 * (a newer one re-baselines), what each answer verified clears (the required-key drift of its
 * views — and, first, every path the manifest's probe spec verified: `clearSpecVerified`), what the
 * run found is recorded, a host move ends on a good answer of a run that saw none, and
 * last_probe_at moves. Before, a run recorded its signals and called `recovered()` with no view, so
 * a green probe never ended a red row (Stage C finding drift-red-never-clears).
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
  const current = store.repos.driftState.get();
  if (current !== null) {
    const cleared = clearSpecVerified(current, checks, at);
    if (cleared !== current) store.repos.driftState.put(cleared);
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
    const specs = manifest === undefined ? undefined : driftProbeSpecs(io, log);
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
      ...(specs === undefined ? {} : { specs }),
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
    else
      checks.push(
        renewalSkipped(
          await shapeProbe(deps, config.season, league, config.probeLeagueId !== null),
          config,
          io.clock.nowMs(),
        ),
      );
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
      probe_specs: specs === undefined ? "absent" : "present",
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
          probe_specs: specs === undefined ? "absent" : "present",
          rebaselined: recorded.rebaselined,
          checks: checks.map((c) => ({
            name: c.name,
            views: c.views,
            status: c.status,
            upstream_status: c.upstream_status,
            reason: c.reason,
            signals: c.signals.slice(0, 50),
            findings: (c.findings ?? []).slice(0, 50).map((f) => ({
              severity: f.severity,
              kind: f.kind,
              view: f.view,
              path: f.path,
              count: f.count,
              value: f.value,
            })),
          })),
        }),
      );
    } else {
      for (const c of checks) {
        await writeLine(
          io.stdout,
          `${c.name.padEnd(6)} ${c.status.padEnd(11)} ${c.views.join("+")}${c.reason === null ? "" : `  (${c.reason})`}`,
        );
        const red = (c.findings ?? []).filter((f) => f.severity === "red");
        for (const f of red.slice(0, 10))
          await writeLine(io.stdout, `       red: ${f.view}: ${findingPhrase(f)}`);
        if (red.length > 10)
          await writeLine(
            io.stdout,
            `       … and ${String(red.length - 10)} more (--json lists them)`,
          );
      }
      await writeLine(
        io.stdout,
        `drift_state: ${stored}${deps.observations === undefined ? " (manifest absent: required keys and skeletons only)" : specs === undefined ? " (the manifest's probe specs are unreadable: required keys and skeletons only)" : ""}${recorded.rebaselined ? " (re-baselined on a newer drift manifest: the old diff was discarded)" : ""}`,
      );
      const a = alarmText(checks);
      if (a !== null) await writeLine(io.stderr, a);
    }
    return probeRunExit(status === "green" || status === "additive" ? stored : status);
  } finally {
    store.close();
  }
}
