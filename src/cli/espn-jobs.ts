// espn-jobs.ts — the shared harness of the ESPN-credentialed launchd jobs (plan 06 §1.4; ADV OBJ-04,
// OBJ-16): every job except the daily `credential check` reads `credential_state` first and exits 0
// WITHOUT a request while it is `rejected`; a job never overlaps itself (job_lock); jobs are
// season-aware (no game in ±7 days → exit 0 in seconds); kickoff- and waiver-relative jobs wake on
// a fixed cadence and self-select their working run from epoch-ms instants (the pro schedule's
// kickoffs, `waiverNextExecutionDate` read at the previous run) — never a time baked into a plist.
// A cookie-bearing 401 records the rejection (src/auth) and notifies ONCE (credential-check.ts).
import type { Config } from "../config/schema.js";
import type { ProGame, ProSchedule } from "../providers/platform.js";
import { SEASON_WINDOW_DAYS } from "../sources/runner.js";
import type { Store, StoreFactory } from "../store/types.js";
import { notifyRejectionOnce } from "./credential-check.js";
import { buildEspnStack, effCodeOf, type EspnStack } from "./espn-stack.js";
import { EXIT } from "./exit.js";
import { writeLine, type CliIo } from "./io.js";
import type { Logger } from "./log.js";
import { createNotifier, type Notifier } from "./notify.js";
import { errorText, openStore } from "./store-access.js";

/** A job lock older than this is broken (a crashed run must not silence the fleet). */
export const JOB_LOCK_STALE_MS = 30 * 60_000;
/** The working window of an hourly job: the run inside (target − 60 min, target] works. */
export const WORKING_WINDOW_MS = 60 * 60_000;

/** An open job run. */
export interface JobRun {
  readonly store: Store;
  readonly stack: EspnStack;
  readonly notifier: Notifier;
  readonly lockName: string;
}

/** Common options of the ESPN jobs. */
export interface JobOptions {
  readonly notify: boolean;
  readonly factory?: StoreFactory;
}

/**
 * Opens a job run: store, credential gate (rejected → exit 0, no request), job lock, provider.
 * Returns an exit code instead when the job must not run.
 */
export async function startJob(
  io: CliIo,
  config: Config,
  log: Logger,
  job: string,
  opts: JobOptions,
): Promise<JobRun | number> {
  const notifier = createNotifier({
    platform: io.platform,
    exec: io.exec,
    clock: io.clock,
    cacheDir: config.cacheDir,
  });
  let store: Store;
  try {
    store = openStore(config, io.clock, log, {
      migrate: true,
      ...(opts.factory ? { factory: opts.factory } : {}),
    });
  } catch (e) {
    await writeLine(io.stderr, `eff ${job}: the store could not be opened: ${errorText(e)}`);
    if (opts.notify) await notifier.failure(job, "store");
    return EXIT.error;
  }
  if (config.fixtureDir === null) {
    let row = null;
    try {
      row = store.repos.credentialState.get();
    } catch {
      row = null;
    }
    if (row?.league_id === config.leagueId && row.state === "rejected") {
      store.close();
      await writeLine(
        io.stdout,
        `${job}: the stored cookies are rejected — waiting for the daily credential check or \`eff setup\` (no request sent)`,
      );
      return EXIT.ok;
    }
  }
  const lockName = `job:${job}`;
  let locked = false;
  try {
    locked = store.repos.jobLock.acquire(lockName, io.pid, io.clock.nowIso(), JOB_LOCK_STALE_MS);
  } catch {
    locked = false;
  }
  if (!locked) {
    store.close();
    await writeLine(io.stdout, `${job}: another run holds the job lock — nothing done`);
    return EXIT.ok;
  }
  const stack = buildEspnStack(io, config, store, log, { origin: "job", observer: "daily_job" });
  return { store, stack, notifier, lockName };
}

/** Closes a job run (releases the lock, drops the secret, closes the store). */
export function endJob(io: CliIo, run: JobRun): void {
  try {
    run.store.repos.jobLock.release(run.lockName, io.pid);
  } catch {
    // a stale lock is broken by the next run after JOB_LOCK_STALE_MS
  }
  run.stack.close();
  run.store.close();
}

/** Maps a provider failure to the job's exit code, notifying as plan 06 §1.4 says. */
export async function jobFailure(
  io: CliIo,
  config: Config,
  run: JobRun,
  job: string,
  e: unknown,
  notify: boolean,
): Promise<number> {
  const code = effCodeOf(e);
  if (code === "ESPN_AUTH_REJECTED") {
    await writeLine(
      io.stdout,
      `${job}: ESPN rejected the stored cookies — the jobs go quiet until the daily credential check or \`eff setup\``,
    );
    if (notify) await notifyRejectionOnce(run.store, config.cacheDir, run.notifier);
    return EXIT.credentials;
  }
  if (code === "ESPN_REQUIRES_COOKIES") {
    await writeLine(
      io.stdout,
      `${job}: this league needs cookies and none are stored — run \`eff setup\` (nothing done)`,
    );
    return EXIT.ok;
  }
  await writeLine(io.stderr, `eff ${job}: ${code}`);
  if (notify) await run.notifier.failure(job, code);
  return EXIT.error;
}

/** The season's pro schedule: the dataset first, else the keyless view (cached) — or null. */
export async function proScheduleOf(run: JobRun, season: number): Promise<ProSchedule | null> {
  try {
    const games = run.store.datasets.proSchedule.games(season, null);
    if (games.stamp !== null) {
      const teams = run.store.datasets.proSchedule.teams(season);
      return { season, games: games.rows, teams: teams.rows };
    }
  } catch {
    // fall through to the keyless view
  }
  try {
    return (await run.stack.provider.getProSchedule(season)).value;
  } catch {
    return null;
  }
}

function kickoffMs(g: ProGame): number | null {
  if (g.kickoff === null || g.start_time_tbd) return null;
  const k = Date.parse(g.kickoff);
  return Number.isFinite(k) ? k : null;
}

/** Whether any game kicks off within ±SEASON_WINDOW_DAYS of now (plan 06 §2 season awareness). */
export function inSeasonWindow(schedule: ProSchedule, nowMs: number): boolean {
  const w = SEASON_WINDOW_DAYS * 86_400_000;
  return schedule.games.some((g) => {
    const k = g.kickoff === null ? null : Date.parse(g.kickoff);
    return k !== null && Number.isFinite(k) && Math.abs(k - nowMs) <= w;
  });
}

/** The first confirmed kickoff of the coming week (the week of the next game at or after now). */
export function weekFirstKickoff(
  schedule: ProSchedule,
  nowMs: number,
): { week: number; at: number } | null {
  let next: ProGame | null = null;
  for (const g of schedule.games) {
    const k = kickoffMs(g);
    if (k === null || k < nowMs) continue;
    if (next === null || k < (kickoffMs(next) ?? Infinity)) next = g;
  }
  if (next === null) return null;
  const week = next.week;
  let first: number | null = null;
  for (const g of schedule.games) {
    if (g.week !== week) continue;
    const k = kickoffMs(g);
    if (k !== null && (first === null || k < first)) first = k;
  }
  return first === null ? null : { week, at: first };
}

/** The first confirmed kickoff of the local calendar day of `nowMs`, or null. */
export function dayFirstKickoff(schedule: ProSchedule, nowMs: number): number | null {
  const d = new Date(nowMs);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  let first: number | null = null;
  for (const g of schedule.games) {
    const k = kickoffMs(g);
    if (k !== null && k >= start && k < end && (first === null || k < first)) first = k;
  }
  return first;
}

/** Whether `nowMs` is the working run for `targetMs`: inside (target − window, target]. */
export function isWorkingRun(
  nowMs: number,
  targetMs: number,
  windowMs = WORKING_WINDOW_MS,
): boolean {
  return nowMs > targetMs - windowMs && nowMs <= targetMs;
}
