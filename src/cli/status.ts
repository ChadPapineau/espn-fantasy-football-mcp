// status.ts — `eff status [--json]`, the terminal dashboard (plan 06 J2 "`eff status` is the
// dashboard", §3 "any source past its hard limit; probe older than 36 h; snapshots missing; jobs not
// loaded; requests in the last minute near the cap"; plan 03 §6: `rejected_since` and
// `next_probe_at` while rejected; plan 02 §2.3 and plan 10 A2b: NO value, length or fingerprint of
// a credential — booleans, labels and timestamps only). Reads only: the store is opened without
// creating or migrating it. Exit 0 whenever the report was produced; 1 only when the store cannot
// be read. Ported from sibling @5daa625, adapted (credential, drift, limiter, checks).
import { lstatSync } from "node:fs";
import { deriveStartupState } from "../auth/state.js";
import {
  SOURCE_REGISTRY,
  freshnessClass,
  stampState,
  type DatasetSourceId,
  type FreshnessState,
} from "../config/freshness.js";
import { datasetFilePath, storePath } from "../config/paths.js";
import { ESPN_JOB_DAILY_CAPS, type LenientConfig } from "../config/schema.js";
import { utcDayStart } from "../providers/espn/limiter.js";
import { MIGRATIONS } from "../store/index.js";
import type { RefreshLogRow, Store, StoreFactory } from "../store/types.js";
import { VERSION } from "../version.js";
import { EXIT } from "./exit.js";
import { writeLine, type CliIo } from "./io.js";
import { installedPlists } from "./launchd.js";
import { availableJobs } from "./install-launchd.js";
import type { Logger } from "./log.js";
import { openExistingStore, type ExistingStore } from "./store-access.js";

/** The Phase-1 dataset sources, in refresh order (weather follows EFF_WEATHER_SOURCE). */
export function configuredSources(config: Pick<LenientConfig, "weatherSource">): DatasetSourceId[] {
  return [
    "espn:pro_schedule",
    "espn:players",
    "nflverse:schedules",
    "nflverse:injuries",
    "nflverse:roster_weekly",
    "nflverse:players",
    "nflverse:stats_player_week",
    config.weatherSource === "nws" ? "weather:nws" : "weather:open_meteo",
  ];
}

/** One source's line on the dashboard. */
export interface SourceStatus {
  readonly source: DatasetSourceId;
  readonly freshness_class: string;
  readonly state: FreshnessState | "never_loaded" | "file_missing";
  readonly beyond_hard: string | null;
  readonly age_s: number | null;
  readonly basis_at: string | null;
  readonly file_version: string | null;
  readonly rows: number | null;
  readonly last_success_at: string | null;
  readonly last_error: { readonly at: string; readonly error: string | null } | null;
  readonly consecutive_failures: number;
}

/** Judges one source from its refresh_log rows. */
export function sourceStatus(
  source: DatasetSourceId,
  current: RefreshLogRow | null,
  latest: RefreshLogRow | null,
  failures: number,
  cacheDir: string,
  nowMs: number,
): SourceStatus {
  const cls = freshnessClass(SOURCE_REGISTRY[source].freshness);
  const base = {
    source,
    freshness_class: cls.id,
    beyond_hard: cls.beyondHard,
    consecutive_failures: failures,
    last_error:
      latest !== null && !latest.ok ? { at: latest.finished_at, error: latest.error } : null,
  };
  if (current === null)
    return {
      ...base,
      state: "never_loaded",
      age_s: null,
      basis_at: null,
      file_version: null,
      rows: null,
      last_success_at: null,
    };
  let present = false;
  try {
    present = lstatSync(datasetFilePath(cacheDir, source)).isFile();
  } catch {
    present = false;
  }
  const judged = stampState(
    cls,
    {
      as_of: current.release_updated_at ?? current.finished_at,
      fetched_at: current.finished_at,
      checked_at: current.checked_at,
    },
    nowMs,
  );
  return {
    ...base,
    state: present ? judged.state : "file_missing",
    age_s: judged.age_s,
    basis_at: judged.basis_at,
    file_version: current.file_version,
    rows: current.rows,
    last_success_at: current.finished_at,
  };
}

/** Every configured source's status from an open store. */
export function sourceStatuses(store: Store, config: LenientConfig, nowMs: number): SourceStatus[] {
  const rl = store.repos.refreshLog;
  const current = rl.current();
  return configuredSources(config).map((s) =>
    sourceStatus(
      s,
      current.find((r) => r.source === s && r.ok) ?? null,
      rl.latest(s),
      rl.consecutiveFailures(s),
      config.cacheDir,
      nowMs,
    ),
  );
}

/** The credential block: labels and timestamps only (plan 02 §2.3; plan 10 A2b). */
export interface CredentialStatus {
  readonly state: string;
  readonly store: string;
  readonly stored_at: string | null;
  readonly stored_age_days: number | null;
  readonly last_accepted_at: string | null;
  readonly last_rejected_at: string | null;
  readonly rejected_since: string | null;
  readonly next_probe_at: string | null;
}

/** The whole report (`--json` shape; the text view renders the same object). */
export interface StatusReport {
  readonly version: string;
  readonly node: string;
  readonly generated_at: string;
  readonly config: {
    readonly config_dir: string;
    readonly cache_dir: string;
    readonly league_configured: boolean;
    readonly season: number;
    readonly toolset: string;
    readonly seeding_mode: string;
    readonly seeding_confirmed: boolean;
    readonly weather_source: string;
    readonly read_host_overridden: boolean;
    readonly fixture_mode: boolean;
    readonly warnings: readonly string[];
  };
  readonly store: {
    readonly state: "ok" | "missing" | "newer" | "pending" | "error";
    readonly path: string;
    readonly size_bytes: number | null;
    readonly schema_version: number | null;
    readonly binary_schema_version: number;
    readonly message: string | null;
  };
  readonly credential: CredentialStatus | null;
  readonly drift: {
    readonly status: string;
    readonly since: string | null;
    readonly host_moved_at: string | null;
    readonly last_probe_success_at: string | null;
  } | null;
  readonly requests_today: {
    readonly server: { readonly cookie: number; readonly keyless: number };
    readonly job: { readonly cookie: number; readonly keyless: number };
    readonly job_caps: { readonly cookie: number; readonly keyless: number };
  } | null;
  readonly sources: readonly SourceStatus[];
  readonly checks: readonly {
    readonly id: string;
    readonly status: string;
    readonly raised_at: string;
  }[];
  readonly launchd: {
    readonly supported: boolean;
    readonly installed: readonly string[];
    readonly missing: readonly string[];
  };
}

function storeBlock(ex: ExistingStore, config: LenientConfig): StatusReport["store"] {
  const p = storePath(config.cacheDir);
  const bin = MIGRATIONS.length;
  const none = { path: p, size_bytes: null, binary_schema_version: bin };
  switch (ex.kind) {
    case "open": {
      const st = ex.store.stats();
      return {
        ...none,
        state: "ok",
        size_bytes: st.size_bytes,
        schema_version: st.schema_version,
        message: null,
      };
    }
    case "missing":
      return {
        ...none,
        state: "missing",
        schema_version: null,
        message: "not created yet — run `eff refresh all`",
      };
    case "newer":
      return {
        ...none,
        state: "newer",
        schema_version: ex.storeVersion,
        message: `written by a newer version (v${String(ex.storeVersion)}); this binary supports v${String(ex.binaryVersion)} — upgrade the package or restore a backup`,
      };
    case "pending":
      return {
        ...none,
        state: "pending",
        schema_version: ex.storeVersion,
        message: `schema v${String(ex.storeVersion)} → v${String(ex.binaryVersion)} migration pending — it runs on the next job or server start`,
      };
    case "error":
      return { ...none, state: "error", schema_version: null, message: ex.message };
  }
}

const DAY_MS = 86_400_000;

function fileExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** The credential block from the row (no credential-store read — plan 03 §1.1 step 4). */
export function credentialStatus(
  store: Store,
  config: LenientConfig,
  nowMs: number,
): CredentialStatus | null {
  if (config.leagueId === null) return null;
  let row;
  try {
    row = store.repos.credentialState.get();
  } catch {
    row = null;
  }
  const state = deriveStartupState({
    row,
    leagueId: config.leagueId,
    storeKind: config.credentialStore,
    fileStoreExists: config.credentialStore === "file" && fileExists(config.credentialFile),
  });
  const mine = row !== null && row.league_id === config.leagueId ? row : null;
  const storedMs = mine?.stored_at == null ? NaN : Date.parse(mine.stored_at);
  return {
    state,
    store: config.credentialStore,
    stored_at: mine?.stored_at ?? null,
    stored_age_days: Number.isFinite(storedMs)
      ? Math.max(0, Math.floor((nowMs - storedMs) / DAY_MS))
      : null,
    last_accepted_at: mine?.last_accepted_at ?? null,
    last_rejected_at: mine?.last_rejected_at ?? null,
    rejected_since: state === "rejected" ? (mine?.rejected_since ?? null) : null,
    next_probe_at: state === "rejected" ? (mine?.next_probe_at ?? null) : null,
  };
}

/** Builds the report (the store is closed before returning). */
export function collectStatus(
  io: CliIo,
  config: LenientConfig,
  log: Logger,
  factory?: StoreFactory,
): StatusReport {
  const now = io.clock.nowMs();
  const ex = openExistingStore(config, io.clock, log, factory);
  try {
    const store = ex.kind === "open" ? ex.store : null;
    const sources =
      store !== null
        ? sourceStatuses(store, config, now)
        : configuredSources(config).map((s) =>
            sourceStatus(s, null, null, 0, config.cacheDir, now),
          );
    const drift = store === null ? null : store.repos.driftState.get();
    const probe = store === null ? null : store.repos.probeLog.lastSuccess("host");
    const counts =
      store === null
        ? null
        : store.repos.limiter.countToday(new Date(utcDayStart(now)).toISOString());
    const installed = installedPlists(io.home).map((p) => p.job);
    return {
      version: VERSION,
      node: io.nodeVersion,
      generated_at: io.clock.nowIso(),
      config: {
        config_dir: config.configDir,
        cache_dir: config.cacheDir,
        league_configured: config.leagueId !== null,
        season: config.season,
        toolset: config.toolset,
        seeding_mode: config.seedingMode,
        seeding_confirmed: config.seedingConfirmedAt !== null,
        weather_source: config.weatherSource,
        read_host_overridden: config.origins.EFF_ESPN_READ_HOST !== "default",
        fixture_mode: config.fixtureDir !== null,
        warnings: config.warnings,
      },
      store: storeBlock(ex, config),
      credential: store === null ? null : credentialStatus(store, config, now),
      drift:
        store === null
          ? null
          : {
              status: drift?.status ?? "green",
              since: drift?.since ?? null,
              host_moved_at: drift?.host_moved_at ?? null,
              last_probe_success_at: probe?.at ?? null,
            },
      requests_today:
        counts === null
          ? null
          : { server: counts.server, job: counts.job, job_caps: { ...ESPN_JOB_DAILY_CAPS } },
      sources,
      checks:
        store === null
          ? []
          : store.repos.leagueSettings
              .openChecks()
              .map((c) => ({ id: c.id, status: c.status, raised_at: c.raised_at })),
      launchd: {
        supported: io.platform === "darwin",
        installed,
        missing: availableJobs()
          .map((j) => j.name)
          .filter((j) => !installed.includes(j)),
      },
    };
  } finally {
    if (ex.kind === "open") ex.store.close();
  }
}

/** Human age: 45s, 12m, 5h, 3d. */
export function formatAge(s: number | null): string {
  if (s === null) return "—";
  if (s < 90) return `${String(s)}s`;
  if (s < 90 * 60) return `${String(Math.round(s / 60))}m`;
  if (s < 36 * 3600) return `${String(Math.round(s / 3600))}h`;
  return `${String(Math.round(s / 86400))}d`;
}

const STATE_LABEL: Record<SourceStatus["state"], string> = {
  fresh: "fresh",
  stale: "STALE",
  expired: "EXPIRED",
  never_loaded: "NEVER LOADED",
  file_missing: "FILE MISSING",
};

/** Renders the text dashboard (labels and timestamps only — never a credential value). */
export function renderStatus(r: StatusReport): string[] {
  const out: string[] = [];
  out.push(`espn-fantasy-football-mcp ${r.version} (node ${r.node}) — ${r.generated_at}`);
  out.push(`config  ${r.config.config_dir}${r.config.fixture_mode ? "  [fixture mode]" : ""}`);
  out.push(`cache   ${r.config.cache_dir}`);
  out.push(
    `league  ${r.config.league_configured ? "configured" : "NOT CONFIGURED (ESPN_LEAGUE_ID)"}, season ${String(r.config.season)}, toolset ${r.config.toolset}, seeding ${r.config.seeding_mode}${r.config.seeding_confirmed ? "" : " (unconfirmed)"}`,
  );
  const s = r.store;
  out.push(
    s.state === "ok"
      ? `store   schema v${String(s.schema_version)}  ${String(Math.round((s.size_bytes ?? 0) / 1024))} KB`
      : `store   ${s.state.toUpperCase()}: ${s.message ?? ""}`,
  );
  if (r.credential !== null) {
    const c = r.credential;
    out.push(
      `cookies ${c.state} (${c.store} store)${c.stored_age_days === null ? "" : `, stored ${String(c.stored_age_days)}d ago`}${c.last_accepted_at === null ? "" : `, last accepted ${c.last_accepted_at}`}`,
    );
    if (c.state === "rejected")
      out.push(
        `        REJECTED since ${c.rejected_since ?? "?"}; next probe ${c.next_probe_at ?? "unscheduled"} — run \`eff setup\` in a terminal`,
      );
    else if (c.state === "not_configured") out.push("        → run `eff setup` in a terminal");
  }
  if (r.drift !== null)
    out.push(
      `drift   ${r.drift.status}${r.drift.since === null ? "" : ` since ${r.drift.since}`}; last probe success ${r.drift.last_probe_success_at ?? "never"}${r.drift.status === "red" || r.drift.status === "host_moved" ? " — run `eff probe`" : ""}`,
    );
  if (r.requests_today !== null) {
    const q = r.requests_today;
    out.push(
      `ESPN today: server ${String(q.server.cookie)} cookie + ${String(q.server.keyless)} keyless; jobs ${String(q.job.cookie)}/${String(q.job_caps.cookie)} cookie + ${String(q.job.keyless)}/${String(q.job_caps.keyless)} keyless`,
    );
  }
  out.push("");
  out.push("source                       state         age    version / rows            failures");
  for (const src of r.sources) {
    const v =
      src.file_version === null
        ? "—"
        : `${src.file_version.slice(0, 22)} / ${String(src.rows ?? 0)}`;
    const err =
      src.last_error === null
        ? ""
        : `  last error ${src.last_error.error ?? "?"} at ${src.last_error.at}`;
    out.push(
      `${src.source.padEnd(28)} ${STATE_LABEL[src.state].padEnd(13)} ${formatAge(src.age_s).padEnd(6)} ${v.padEnd(25)} ${String(src.consecutive_failures)}${err}`,
    );
  }
  const red = r.sources.filter((x) => x.state !== "fresh" && x.state !== "stale");
  if (red.length > 0)
    out.push(
      `→ run \`eff refresh all\` (${String(red.length)} source(s) expired, missing or never loaded)`,
    );
  if (r.checks.length > 0) {
    out.push("");
    for (const c of r.checks)
      out.push(`check ${c.id}: ${c.status} (raised ${c.raised_at}) — \`eff doctor\``);
  }
  out.push("");
  if (!r.launchd.supported)
    out.push("launchd: not available on this platform (schedule the `eff` jobs yourself)");
  else if (r.launchd.installed.length === 0)
    out.push("launchd: no jobs installed — `eff install-launchd`");
  else
    out.push(
      `launchd: ${String(r.launchd.installed.length)} job(s) installed${r.launchd.missing.length > 0 ? ` (missing: ${r.launchd.missing.join(", ")})` : ""} — \`eff doctor\` checks they are loaded`,
    );
  for (const w of r.config.warnings) out.push(`warning: ${w}`);
  return out;
}

/** `eff status`. */
export async function status(
  io: CliIo,
  config: LenientConfig,
  log: Logger,
  opts: { readonly json: boolean; readonly factory?: StoreFactory },
): Promise<number> {
  const report = collectStatus(io, config, log, opts.factory);
  if (opts.json) await writeLine(io.stdout, JSON.stringify(report, null, 2));
  else for (const l of renderStatus(report)) await writeLine(io.stdout, l);
  return report.store.state === "error" ? EXIT.error : EXIT.ok;
}
