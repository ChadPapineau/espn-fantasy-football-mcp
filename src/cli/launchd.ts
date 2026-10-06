// launchd.ts — the launchd jobs and their plists (plan 06 J1, §1.2–§1.4 the job rows, §2 the launchd
// design; plan 03 L4 absolute paths; plan 10 §3.1a/§3.1b "Jobs"). One LaunchAgent per job, generated
// here — the "templates in src/cli/launchd/" of plan 06 §2 are this module's data: the job table
// plus one XML renderer, so every path is resolved, never hand-typed. ProgramArguments =
// [process.execPath, <abs dist/cli.js>, <subcommand…>]; EnvironmentVariables = non-secret config
// only, never EFF_CREDENTIAL_STORE/FILE (plan 03 §3) and never a cookie; logs under
// ~/Library/Logs/espn-fantasy-football-mcp/<job>.log. No kickoff or waiver time is baked into a
// plist (ADV OBJ-16): kickoff- and waiver-relative jobs wake on a fixed cadence and self-select.
// `launchctl` is reached only via the injected executor. Ported from sibling @5daa625, adapted.
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatasetSourceId, RefreshJob } from "../config/freshness.js";
import type { LenientConfig } from "../config/schema.js";
import type { Exec } from "./io.js";

/** The LaunchAgent label prefix. Generic on purpose: no owner/user identifier in a label. */
export const LABEL_PREFIX = "io.github.espn-fantasy-football-mcp.eff";
/** Log directory name under ~/Library/Logs. */
export const LOG_DIR_NAME = "espn-fantasy-football-mcp";
/** The launchctl binary (absolute: never resolved through PATH). */
export const LAUNCHCTL = "/bin/launchctl";

/** One StartCalendarInterval entry; an omitted key is launchd's wildcard (launchd.plist(5)). */
export interface CalendarEntry {
  readonly Minute?: number;
  readonly Hour?: number;
  /** 0 = Sunday … 6 = Saturday. */
  readonly Weekday?: number;
}

/** One launchd job. */
export interface LaunchdJob {
  /** Short name (`--jobs` value, label suffix, log file name). */
  readonly name: string;
  /** The `eff` subcommand and its arguments. */
  readonly argv: readonly string[];
  /** What it does, for `--dry-run` and doctor output. */
  readonly description: string;
  /** Local-time schedule. */
  readonly calendar: readonly CalendarEntry[];
  /** Whether it reads ESPN with cookies (plan 06 §1.4; exits 0 with no request while rejected). */
  readonly cookies: boolean;
  /** The refresh job it runs (availability depends on the sources this build ships). */
  readonly refreshJob: RefreshJob | null;
  /** The dataset sources whose refresh_log rows report this job's last run (doctor #11). */
  readonly sources: readonly DatasetSourceId[];
}

const SUN = 0;
const MON = 1;
const TUE = 2;
const WED = 3;
const THU = 4;
const FRI = 5;
const SAT = 6;
const GAME_DAYS = [THU, SUN, MON] as const;
const OTHER_DAYS = [TUE, WED, FRI, SAT] as const;
const EVERY_DAY = [SUN, MON, TUE, WED, THU, FRI, SAT] as const;

const at = (Hour: number, Minute: number, Weekday?: number): CalendarEntry =>
  Weekday === undefined ? { Hour, Minute } : { Weekday, Hour, Minute };
const hourly = (days: readonly number[], Minute: number): CalendarEntry[] =>
  days.map((Weekday) => ({ Weekday, Minute }));
const every6h = (days: readonly number[], Minute: number): CalendarEntry[] =>
  days.flatMap((d) => [0, 6, 12, 18].map((h) => at(h, Minute, d)));

/**
 * The jobs (plan 06 §1.2–§1.4; plan 10 §3.1a/§3.1b "Jobs"), local time. Every job is idempotent
 * and season-aware: a run with nothing to do exits 0 in seconds and makes no request.
 */
export const JOBS: readonly LaunchdJob[] = Object.freeze([
  {
    name: "probe",
    argv: ["probe", "--notify"],
    description: "drift probe (keyless) — daily 05:00, plus Tue 12:00",
    calendar: [at(5, 0), at(12, 0, TUE)],
    cookies: false,
    refreshJob: null,
    sources: [],
  },
  {
    name: "refresh-espn-schedule",
    argv: ["refresh", "espn:schedule", "--notify"],
    description: "refresh espn:schedule — hourly Thu/Sun/Mon, every 6 h otherwise",
    calendar: [...hourly(GAME_DAYS, 0), ...every6h(OTHER_DAYS, 0)],
    cookies: false,
    refreshJob: "espn:schedule",
    sources: ["espn:pro_schedule"],
  },
  {
    name: "refresh-espn-players",
    argv: ["refresh", "espn:players", "--notify"],
    description: "refresh espn:players — daily 05:10 (then the crosswalk rebuild)",
    calendar: [at(5, 10)],
    cookies: false,
    refreshJob: "espn:players",
    sources: ["espn:players"],
  },
  {
    // every 6 h, every day: plan 06's "daily 10:30 + 16:30 Wed–Sat" leaves 18–24 h gaps against the
    // injuries TTL (the sibling's QA-2-035); 10:30 and 16:30 are kept as two of the four runs
    name: "refresh-nflverse-daily",
    argv: ["refresh", "nflverse:daily", "--notify"],
    description:
      "refresh injuries + depth_charts + roster_weekly + players — 04:30, 10:30, 16:30, 22:30 (then the crosswalk rebuild)",
    calendar: [at(4, 30), at(10, 30), at(16, 30), at(22, 30)],
    cookies: false,
    refreshJob: "nflverse:daily",
    sources: [
      "nflverse:injuries",
      "nflverse:depth_charts",
      "nflverse:roster_weekly",
      "nflverse:players",
    ],
  },
  {
    name: "refresh-nflverse-stats",
    argv: ["refresh", "nflverse:stats", "--notify"],
    description:
      "refresh stats_player_week + stats_team_week + the pbp subset — daily 04:30; Thu/Sun/Mon 13:00, 17:00, 21:00; 00:30 after each game day",
    calendar: [
      at(4, 30),
      ...GAME_DAYS.flatMap((d) => [at(13, 0, d), at(17, 0, d), at(21, 0, d)]),
      at(0, 30, FRI),
      at(0, 30, MON),
      at(0, 30, TUE),
    ],
    cookies: false,
    refreshJob: "nflverse:stats",
    sources: ["nflverse:stats_player_week", "nflverse:stats_team_week", "nflverse:pbp"],
  },
  {
    // plan 06 §1.3 `refresh nflverse:snaps` (Phase 2): 4×/day
    name: "refresh-nflverse-snaps",
    argv: ["refresh", "nflverse:snaps", "--notify"],
    description: "refresh snap_counts — 01:30, 07:30, 13:30, 19:30",
    calendar: [at(1, 30), at(7, 30), at(13, 30), at(19, 30)],
    cookies: false,
    refreshJob: "nflverse:snaps",
    sources: ["nflverse:snap_counts"],
  },
  {
    // plan 06 §1.3 `refresh ffopportunity` (Phase 2): daily 08:30
    name: "refresh-ffopportunity",
    argv: ["refresh", "ffopportunity", "--notify"],
    description: "refresh ffopportunity ep_weekly — daily 08:30",
    calendar: [at(8, 30)],
    cookies: false,
    refreshJob: "ffopportunity",
    sources: ["ffopportunity:ep_weekly"],
  },
  {
    // plan 06 §1.3 `refresh sleeper:trending` (secondary, warn-only): every 30 min; the job itself
    // is season-gated, so an off-season wake exits 0 in seconds with no request
    name: "refresh-sleeper-trending",
    argv: ["refresh", "sleeper:trending", "--notify"],
    description: "refresh Sleeper trending (secondary) — every 30 min in season",
    calendar: [{ Minute: 0 }, { Minute: 30 }],
    cookies: false,
    refreshJob: "sleeper:trending",
    sources: ["sleeper:trending"],
  },
  {
    // plan 06 §1.3 `refresh news` (headlines, warn-only): every 15 min, season-gated
    name: "refresh-news",
    argv: ["refresh", "news", "--notify"],
    description: "refresh RSS headlines (RotoWire, ESPN, CBS) — every 15 min in season",
    calendar: [{ Minute: 0 }, { Minute: 15 }, { Minute: 30 }, { Minute: 45 }],
    cookies: false,
    refreshJob: "news",
    sources: ["news:rotowire", "news:espn", "news:cbs"],
  },
  {
    name: "refresh-nflverse-schedules",
    argv: ["refresh", "nflverse:schedules", "--notify"],
    description: "refresh nflverse:schedules — every 30 min Thu/Sun/Mon, every 6 h otherwise",
    calendar: [...hourly(GAME_DAYS, 0), ...hourly(GAME_DAYS, 30), ...every6h(OTHER_DAYS, 15)],
    cookies: false,
    refreshJob: "nflverse:schedules",
    sources: ["nflverse:schedules"],
  },
  {
    name: "refresh-weather",
    argv: ["refresh", "weather", "--notify"],
    description: "refresh weather — hourly Wed–Mon for the coming week's outdoor games",
    calendar: hourly([WED, THU, FRI, SAT, SUN, MON], 5),
    cookies: false,
    refreshJob: "weather",
    sources: ["weather:open_meteo", "weather:nws"],
  },
  {
    name: "store-prune",
    argv: ["prune", "--notify"],
    description: "store prune — weekly Sun 03:00",
    calendar: [at(3, 0, SUN)],
    cookies: false,
    refreshJob: null,
    sources: [],
  },
  {
    name: "store-backup",
    argv: ["backup", "--notify"],
    description: "store backup — weekly Sun 03:10 (VACUUM INTO; keeps 4)",
    calendar: [at(3, 10, SUN)],
    cookies: false,
    refreshJob: null,
    sources: [],
  },
  {
    name: "snapshot-roster",
    argv: ["snapshot", "roster", "--notify"],
    description: "roster snapshot + diff + IR-validity + golden checks — nightly 02:00",
    calendar: [at(2, 0)],
    cookies: true,
    refreshJob: null,
    sources: [],
  },
  {
    name: "snapshot-roster-gameday",
    argv: ["snapshot", "roster", "--pre-kickoff", "--notify"],
    description:
      "roster + scoreboard snapshot 30 min before the week's first kickoff — wakes hourly Thu/Sun/Mon",
    calendar: hourly(GAME_DAYS, 0),
    cookies: true,
    refreshJob: null,
    sources: [],
  },
  {
    name: "snapshot-pool",
    argv: ["snapshot", "pool", "--notify"],
    description:
      "free-agent pool snapshot — wakes hourly; works 1 h after waivers process, and Tue 06:00",
    calendar: hourly(EVERY_DAY, 0),
    cookies: true,
    refreshJob: null,
    sources: [],
  },
  {
    name: "snapshot-projections",
    argv: ["snapshot", "projections"],
    description: "ESPN projection snapshot — Tue 06:00, Thu 18:00, Sun 11:00",
    calendar: [at(6, 0, TUE), at(18, 0, THU), at(11, 0, SUN)],
    cookies: true,
    refreshJob: null,
    sources: [],
  },
  {
    name: "transactions",
    argv: ["transactions", "--notify"],
    description: "transactions append — wakes hourly at :30; works 30 min after the pool's run",
    calendar: hourly(EVERY_DAY, 30),
    cookies: true,
    refreshJob: null,
    sources: [],
  },
  {
    name: "credential-check",
    argv: ["credential-check", "--notify"],
    description: "the daily credential probe — 09:00, plus Sun 08:00 in season",
    calendar: [at(9, 0), at(8, 0, SUN)],
    cookies: true,
    refreshJob: null,
    sources: [],
  },
  {
    name: "pre-kickoff",
    argv: ["pre-kickoff", "--notify"],
    description:
      "pre-kickoff check 60 min before the day's first kickoff — wakes hourly Thu/Sun/Mon",
    calendar: hourly(GAME_DAYS, 0),
    cookies: true,
    refreshJob: null,
    sources: [],
  },
]);

// PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; owner decision D11): the writes-phase `journal
// reconcile` job (plan 06 §1.4 — hourly while any `sent_unknown` row exists) would join the table
// above. No job writes to ESPN in this build, and none is listed.

/** Every job name. */
export const JOB_NAMES: readonly string[] = JOBS.map((j) => j.name);

/** The label of a job. */
export function labelOf(job: LaunchdJob | string): string {
  return `${LABEL_PREFIX}.${typeof job === "string" ? job : job.name}`;
}

/** `~/Library/LaunchAgents`. */
export function launchAgentsDir(home: string): string {
  return path.join(home, "Library", "LaunchAgents");
}

/** `~/Library/Logs/espn-fantasy-football-mcp`. */
export function logDir(home: string): string {
  return path.join(home, "Library", "Logs", LOG_DIR_NAME);
}

/** `~/Library/LaunchAgents/<label>.plist`. */
export function plistPath(home: string, job: LaunchdJob | string): string {
  return path.join(launchAgentsDir(home), `${labelOf(job)}.plist`);
}

/**
 * Selects jobs from a comma-separated `--jobs` value among `available`; unknown names throw
 * RangeError; a known job that this build cannot run throws too (naming it).
 */
export function selectJobs(
  spec: string | undefined,
  available: readonly LaunchdJob[] = JOBS,
): LaunchdJob[] {
  if (spec === undefined || spec.trim() === "" || spec.trim() === "all") return [...available];
  const names = [
    ...new Set(
      spec
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== ""),
    ),
  ];
  const unknown = names.filter((n) => !JOB_NAMES.includes(n));
  if (unknown.length > 0)
    throw new RangeError(`unknown job(s): ${unknown.map((n) => n.slice(0, 40)).join(", ")}`);
  const missing = names.filter((n) => !available.some((j) => j.name === n));
  if (missing.length > 0)
    throw new RangeError(`not available in this build: ${missing.join(", ")}`);
  return available.filter((j) => names.includes(j.name));
}

/** Escapes text for an XML element body. Control characters are refused. */
export function xmlEscape(s: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s))
    throw new RangeError("plist: control characters are not allowed in a value");
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * The EnvironmentVariables of every plist (plan 06 §2): the non-secret keys the jobs cannot read
 * from config.json — the values that came from the ENVIRONMENT (ESPN_LEAGUE_ID, ESPN_SEASON,
 * EFF_PROBE_LEAGUE_ID, EFF_LOG_LEVEL, EFF_WEATHER_SOURCE) — plus EFF_CONFIG_DIR / EFF_CACHE_DIR only
 * when overridden. Never EFF_CREDENTIAL_STORE / EFF_CREDENTIAL_FILE (plan 03 §3), never a secret,
 * never a test-scope key.
 */
export function jobEnv(config: LenientConfig): Record<string, string> {
  const env: Record<string, string> = {};
  const o = config.origins;
  if (o.EFF_CONFIG_DIR === "env") env.EFF_CONFIG_DIR = config.configDir;
  if (o.EFF_CACHE_DIR === "env") env.EFF_CACHE_DIR = config.cacheDir;
  if (o.ESPN_LEAGUE_ID === "env" && config.leagueId !== null) env.ESPN_LEAGUE_ID = config.leagueId;
  if (o.ESPN_SEASON === "env") env.ESPN_SEASON = String(config.season);
  if (o.EFF_PROBE_LEAGUE_ID === "env" && config.probeLeagueId !== null)
    env.EFF_PROBE_LEAGUE_ID = config.probeLeagueId;
  if (o.EFF_LOG_LEVEL === "env") env.EFF_LOG_LEVEL = config.logLevel;
  if (o.EFF_WEATHER_SOURCE === "env") env.EFF_WEATHER_SOURCE = config.weatherSource;
  return env;
}

/** What a plist is built from. */
export interface PlistInput {
  readonly job: LaunchdJob;
  /** Absolute node binary (process.execPath). */
  readonly node: string;
  /** Absolute dist/cli.js. */
  readonly entry: string;
  readonly env: Readonly<Record<string, string>>;
  readonly home: string;
}

const ind = (n: number): string => "  ".repeat(n);

/** Renders one LaunchAgent plist (XML 1.0, Apple PLIST 1.0 DTD). Every path must be absolute. */
export function renderPlist(p: PlistInput): string {
  for (const [what, v] of [
    ["node", p.node],
    ["entry", p.entry],
    ["home", p.home],
  ] as const) {
    if (!path.isAbsolute(v)) throw new RangeError(`plist: ${what} path must be absolute`);
  }
  const str = (v: string): string => `<string>${xmlEscape(v)}</string>`;
  const log = path.join(logDir(p.home), `${p.job.name}.log`);
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `${ind(1)}<key>Label</key>`,
    `${ind(1)}${str(labelOf(p.job))}`,
    `${ind(1)}<key>ProgramArguments</key>`,
    `${ind(1)}<array>`,
    ...[p.node, p.entry, ...p.job.argv].map((a) => `${ind(2)}${str(a)}`),
    `${ind(1)}</array>`,
    `${ind(1)}<key>EnvironmentVariables</key>`,
    `${ind(1)}<dict>`,
    ...Object.entries(p.env)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .flatMap(([k, v]) => [`${ind(2)}<key>${xmlEscape(k)}</key>`, `${ind(2)}${str(v)}`]),
    `${ind(1)}</dict>`,
    `${ind(1)}<key>StandardOutPath</key>`,
    `${ind(1)}${str(log)}`,
    `${ind(1)}<key>StandardErrorPath</key>`,
    `${ind(1)}${str(log)}`,
    `${ind(1)}<key>ProcessType</key>`,
    `${ind(1)}<string>Background</string>`,
    `${ind(1)}<key>LowPriorityIO</key>`,
    `${ind(1)}<true/>`,
    `${ind(1)}<key>RunAtLoad</key>`,
    `${ind(1)}<false/>`,
    `${ind(1)}<key>StartCalendarInterval</key>`,
    `${ind(1)}<array>`,
    ...p.job.calendar.flatMap((c) => [
      `${ind(2)}<dict>`,
      ...(["Weekday", "Hour", "Minute"] as const).flatMap((k) =>
        c[k] === undefined
          ? []
          : [`${ind(3)}<key>${k}</key>`, `${ind(3)}<integer>${String(c[k])}</integer>`],
      ),
      `${ind(2)}</dict>`,
    ]),
    `${ind(1)}</array>`,
    "</dict>",
    "</plist>",
    "",
  ];
  return lines.join("\n");
}

/** `launchctl` argument vectors (plan 06 §2). */
export const launchctl = Object.freeze({
  bootstrap: (uid: number, plist: string): string[] => ["bootstrap", `gui/${String(uid)}`, plist],
  bootout: (uid: number, label: string): string[] => ["bootout", `gui/${String(uid)}/${label}`],
  print: (uid: number, label: string): string[] => ["print", `gui/${String(uid)}/${label}`],
});

/** Refuses a symlinked or non-directory LaunchAgents/Logs directory; creates it when missing. */
export function ensurePlainDir(dir: string, mode: number): void {
  let st;
  try {
    st = lstatSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    mkdirSync(dir, { recursive: true, mode });
    return;
  }
  if (st.isSymbolicLink() || !st.isDirectory())
    throw new Error(`launchd: ${dir} is not a plain directory`);
}

/** Writes a plist atomically (temp + rename), 0644 (launchd refuses group/world-writable plists). */
export function writePlist(file: string, xml: string): void {
  ensurePlainDir(path.dirname(file), 0o755);
  let st = null;
  try {
    st = lstatSync(file);
  } catch {
    st = null;
  }
  if (st?.isSymbolicLink() === true)
    throw new Error(`launchd: refusing to replace a symlink at ${file}`);
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, xml, { mode: 0o644, flag: "wx" });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** One step of an install/uninstall, for printing and for tests. */
export interface LaunchdStep {
  readonly kind: "write" | "launchctl" | "remove" | "mkdir";
  readonly detail: string;
  readonly ok: boolean;
  /** Only for failed launchctl calls: its exit code. */
  readonly code?: number | null;
}

/** Installs jobs: writes plists, then bootout (ignored if not loaded) + bootstrap each. */
export async function installJobs(opts: {
  readonly jobs: readonly LaunchdJob[];
  readonly home: string;
  readonly node: string;
  readonly entry: string;
  readonly env: Readonly<Record<string, string>>;
  readonly uid: number;
  readonly exec: Exec;
}): Promise<LaunchdStep[]> {
  const steps: LaunchdStep[] = [];
  ensurePlainDir(logDir(opts.home), 0o700);
  steps.push({ kind: "mkdir", detail: logDir(opts.home), ok: true });
  for (const job of opts.jobs) {
    const file = plistPath(opts.home, job);
    writePlist(
      file,
      renderPlist({ job, node: opts.node, entry: opts.entry, env: opts.env, home: opts.home }),
    );
    steps.push({ kind: "write", detail: file, ok: true });
    await opts.exec(LAUNCHCTL, launchctl.bootout(opts.uid, labelOf(job)));
    const r = await opts.exec(LAUNCHCTL, launchctl.bootstrap(opts.uid, file));
    steps.push({
      kind: "launchctl",
      detail: `bootstrap ${labelOf(job)}`,
      ok: r.code === 0,
      code: r.code,
    });
  }
  return steps;
}

/** The plists of ours present in LaunchAgents (known job names only). */
export function installedPlists(home: string): { job: string; file: string }[] {
  let names: string[];
  try {
    names = readdirSync(launchAgentsDir(home));
  } catch {
    return [];
  }
  return JOB_NAMES.filter((j) => names.includes(`${labelOf(j)}.plist`)).map((j) => ({
    job: j,
    file: plistPath(home, j),
  }));
}

/** Boots out and removes every installed plist of ours (plan 03 §8 step 1). */
export async function removeJobs(opts: {
  readonly home: string;
  readonly uid: number;
  readonly exec: Exec;
  readonly dryRun: boolean;
}): Promise<LaunchdStep[]> {
  const steps: LaunchdStep[] = [];
  for (const { job, file } of installedPlists(opts.home)) {
    if (opts.dryRun) {
      steps.push({ kind: "launchctl", detail: `bootout ${labelOf(job)}`, ok: true });
      steps.push({ kind: "remove", detail: file, ok: true });
      continue;
    }
    const r = await opts.exec(LAUNCHCTL, launchctl.bootout(opts.uid, labelOf(job)));
    // 0 = booted out; anything else usually means "not loaded" — the plist is removed either way
    steps.push({ kind: "launchctl", detail: `bootout ${labelOf(job)}`, ok: true, code: r.code });
    let removed = true;
    try {
      const st = lstatSync(file);
      if (st.isFile() || st.isSymbolicLink()) rmSync(file, { force: true });
      else removed = false;
    } catch {
      removed = false;
    }
    steps.push({ kind: "remove", detail: file, ok: removed });
  }
  return steps;
}

// --- calendar arithmetic (local time, like launchd) ------------------------------------------------

/**
 * The next instant strictly after `afterMs` at which `calendar` fires, in the process's local time
 * (launchd's clock), or null for an empty calendar. Used for `next_probe_at` (plan 06 §1.4).
 */
export function nextOccurrence(calendar: readonly CalendarEntry[], afterMs: number): number | null {
  if (!Number.isFinite(afterMs)) return null;
  let best = Number.POSITIVE_INFINITY;
  const start = new Date(afterMs);
  for (let day = 0; day <= 8; day++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + day);
    for (const c of calendar) {
      if (c.Weekday !== undefined && c.Weekday !== d.getDay()) continue;
      const hours = c.Hour === undefined ? [...Array(24).keys()] : [c.Hour];
      for (const h of hours) {
        const t = new Date(
          d.getFullYear(),
          d.getMonth(),
          d.getDate(),
          h,
          c.Minute ?? 0,
          0,
          0,
        ).getTime();
        if (t > afterMs && t < best) best = t;
      }
    }
    // every time on a later day is later than any time found on this one
    if (Number.isFinite(best)) break;
  }
  return Number.isFinite(best) ? best : null;
}

/** The credential-check job's next run after `atIso` (the authority's `nextProbeAt` hook). */
export function nextCredentialCheckAt(atIso: string): string | null {
  const job = JOBS.find((j) => j.name === "credential-check");
  const ms = Date.parse(atIso);
  if (job === undefined || !Number.isFinite(ms)) return null;
  const next = nextOccurrence(job.calendar, ms);
  return next === null ? null : new Date(next).toISOString();
}
