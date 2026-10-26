// snapshot.ts — the ESPN-credentialed jobs (plan 06 §1.4; plan 10 §3.1b "Jobs"; T-07, T-08):
// `snapshot roster` (the whole league in one request; the user's team is the diff focus; the daily
// IR-validity check; on the just-finalised week the golden check; the pre-kickoff working run also
// stores the pre-week scoreboard), `snapshot pool` (one sorted page of 100 per position, working 1 h
// after waivers process — `waiverNextExecutionDate` read at the previous run, the ET process hour
// the fallback — and on Tuesday 06:00), `snapshot projections` (the projection corpus), `eff
// transactions` (append unseen transactions 30 min after the pool's working run) and `eff
// pre-kickoff` (no request: the newest roster snapshot vs the schedule, 60 min before the day's first
// kickoff). Notifications carry counts and slot names only — never a member or player name.
import type { Config } from "../config/schema.js";
import {
  auditIr,
  emptyStartingSlots,
  isOnBye,
  lockPlan,
  nextWaiverRun,
  seatsOf,
} from "../domain/league/index.js";
import {
  TRANSACTION_TYPES,
  diffRosterSnapshots,
  type CheckRow,
  type PlatformPlayer,
  type PlatformStatLine,
  type ProSchedule,
  type Roster,
  type RosterSlots,
  type WaiverRules,
} from "../domain/league/types.js";
import type { EspnProjectionSnapshot } from "../domain/analytics/types.js";
import { isLeagueWideMismatch, statLineFromEspn, verify } from "../domain/scoring/index.js";
import type { ScoringSettings } from "../domain/scoring/types.js";
import type { StoreFactory } from "../store/types.js";
import { localDay } from "./credential-check.js";
import {
  endJob,
  inSeasonWindow,
  isWorkingRun,
  jobFailure,
  jobIdle,
  jobWorked,
  nextDayFirstKickoff,
  proScheduleOf,
  startJob,
  weekFirstKickoff,
  WAKE_GRACE_MS,
  type JobRun,
} from "./espn-jobs.js";
import { effCodeOf } from "./espn-stack.js";
import { EXIT, UsageError } from "./exit.js";
import { writeLine, type CliIo } from "./io.js";
import {
  readJobState,
  recordJobRun,
  stateNumber,
  stateToken,
  updateJobState,
  type JobState,
} from "./job-state.js";
import type { Logger } from "./log.js";
import { parseSeasons } from "./refresh.js";

/** The positions `snapshot pool` pages (plan 06 §1.4: QB/RB/WR/TE/K/D-ST). */
export const POOL_POSITIONS = ["QB", "RB", "WR", "TE", "K", "D/ST"] as const;
/** A pool player at or above this ownership appearing on the pool is notified (plan 06 §1.4). */
export const POOL_ALERT_OWNED = 10;
/** `snapshot roster --pre-kickoff` works 30 min before the week's first kickoff. */
export const ROSTER_PRE_KICKOFF_MS = 30 * 60_000;
/** `pre-kickoff` works 60 min before the day's first kickoff. */
export const PRE_KICKOFF_MS = 60 * 60_000;
/** `snapshot pool` works 1 h after waivers process. */
export const POOL_AFTER_WAIVERS_MS = 60 * 60_000;
/** `eff transactions` works 30 min after the pool's working run. */
export const TRANSACTIONS_AFTER_POOL_MS = 30 * 60_000;

/** Options of the jobs. */
export interface SnapshotOptions {
  readonly notify: boolean;
  readonly factory?: StoreFactory;
}

/** A check row raised now (fixed vocabulary and numbers only). */
function check(
  id: CheckRow["id"],
  status: CheckRow["status"],
  detail: CheckRow["detail"],
  at: string,
  settingsHash: string | null,
): CheckRow {
  return {
    id,
    status,
    detail,
    raised_at: at,
    settings_hash: settingsHash,
    acknowledged: false,
    acknowledged_at: null,
    acknowledged_by: null,
  };
}

function hasOpenCheck(run: JobRun, id: CheckRow["id"]): boolean {
  try {
    return run.store.repos.leagueSettings.openChecks().some((c) => c.id === id && !c.acknowledged);
  } catch {
    return false;
  }
}

/** The one-line diff notification of the user's roster (counts only). */
export function rosterDiffText(d: ReturnType<typeof diffRosterSnapshots>): string | null {
  const n = d.added.length + d.dropped.length + d.slot_changes.length + d.injury_changes.length;
  if (n === 0) return null;
  return `Your roster changed since the last snapshot: +${String(d.added.length)} −${String(d.dropped.length)}, ${String(d.slot_changes.length)} slot change(s), ${String(d.injury_changes.length)} status change(s) — \`eff status\``;
}

/**
 * The golden check of one week (plan 08 §6 step 2; T-08): every rostered actual line with ESPN's
 * applied values is re-scored; returns the counts (never a name).
 */
export function goldenCounts(
  boxes: readonly {
    readonly home: { readonly entries: readonly BoxEntry[] };
    readonly away: { readonly entries: readonly BoxEntry[] } | null;
  }[],
  settings: ScoringSettings,
): { readonly checked: number; readonly mismatched: number } {
  let checked = 0;
  let mismatched = 0;
  for (const m of boxes) {
    for (const e of [...m.home.entries, ...(m.away?.entries ?? [])]) {
      const a = e.actual;
      if (a?.applied_total === null || a === null) continue;
      try {
        const { line } = statLineFromEspn(
          { raw: a.raw, provisional: a.provisional, split: a.split },
          e.player.position_id,
        );
        checked++;
        if (!verify(line, settings, { total: a.applied_total, by_stat: a.applied_stats }).match)
          mismatched++;
      } catch {
        // a drifted entry is the drift detector's finding, not a scoring mismatch
      }
    }
  }
  return { checked, mismatched };
}

interface BoxEntry {
  readonly player: Pick<PlatformPlayer, "position_id">;
  readonly actual: Pick<
    PlatformStatLine,
    "raw" | "applied_stats" | "applied_total" | "provisional" | "split"
  > | null;
}

/** `eff snapshot roster [--pre-kickoff]`. */
export async function snapshotRoster(
  io: CliIo,
  config: Config,
  log: Logger,
  opts: SnapshotOptions & { readonly preKickoff: boolean },
): Promise<number> {
  const job = opts.preKickoff ? "snapshot-roster-gameday" : "snapshot-roster";
  const run = await startJob(io, config, log, job, opts);
  if (typeof run === "number") return run;
  try {
    const now = io.clock.nowMs();
    const schedule = await proScheduleOf(run, config.season);
    if (schedule !== null && !inSeasonWindow(schedule, now)) {
      jobIdle(io, config, job);
      await writeLine(io.stdout, `${job}: off-season — nothing to do`);
      return EXIT.ok;
    }
    if (opts.preKickoff) {
      const first = schedule === null ? null : weekFirstKickoff(schedule, now);
      if (first === null || !isWorkingRun(now, first.at - ROSTER_PRE_KICKOFF_MS)) {
        jobIdle(io, config, job);
        await writeLine(
          io.stdout,
          `${job}: not the run before the week's first kickoff — nothing to do`,
        );
        return EXIT.ok;
      }
    }
    const ref = run.stack.ref;
    const league = (await run.stack.provider.getLeague(ref)).value;
    const week = league.clock.current_scoring_period;
    const rosters = (await run.stack.provider.getRosters(ref, week)).value;
    const takenAt = io.clock.nowIso();
    for (const r of rosters)
      run.store.repos.rosterSnapshots.put({
        team_id: r.team.team_id,
        week,
        taken_at: takenAt,
        roster: r,
      });
    const mine: Roster | undefined =
      rosters.find((r) => r.is_mine) ??
      rosters.find((r) => config.teamId !== null && r.team.team_id === config.teamId);
    const lines = [`${job}: ${String(rosters.length)} roster(s) stored for week ${String(week)}`];
    if (mine !== undefined) {
      const [, prev] = run.store.repos.rosterSnapshots.latestTwo(mine.team.team_id);
      const text =
        prev === undefined ? null : rosterDiffText(diffRosterSnapshots(prev.roster, mine));
      if (text !== null) {
        lines.push(text);
        if (opts.notify) await run.notifier.info(text);
      }
      // the daily IR-validity check (T-08): a healthy player in IR blocks every add. The check is a
      // CONDITION this snapshot re-reads every night: a valid IR closes every open ir_invalid check
      // (acknowledger `snapshot` — the state it described is gone), so doctor #23, `eff status` and
      // espn_get_status's checks[] clear with the fix; an invalid IR with no open check raises one
      // and alerts — the next healthy player in IR is a new check and a new alert (as is an invalid
      // IR right after a snapshot that read it valid, should a failed close have left a check open).
      const slots = (await run.stack.provider.getRosterSlots(ref)).value;
      const ir = auditIr(seatsOf(mine), slots);
      const prevIrValid = prev === undefined ? null : !auditIr(seatsOf(prev.roster), slots).invalid;
      const openIr = hasOpenCheck(run, "ir_invalid");
      if (!ir.invalid && openIr) {
        const closed = run.store.repos.leagueSettings.acknowledgeChecks(
          "ir_invalid",
          takenAt,
          "snapshot",
          takenAt,
        );
        lines.push(`IR valid again — ${String(closed)} ir_invalid check(s) closed`);
      }
      if (ir.invalid && (!openIr || prevIrValid === true)) {
        run.store.repos.leagueSettings.raiseCheck(
          check(
            "ir_invalid",
            "fail",
            {
              invalid_players: ir.invalid_players.length,
              forced_drop_needed: ir.forced_drop_needed,
            },
            takenAt,
            null,
          ),
        );
        lines.push(
          `IR invalid: ${String(ir.invalid_players.length)} player(s) in IR are not IR-eligible — every add is blocked`,
        );
        if (opts.notify)
          await run.notifier.info(
            "Your IR slot holds a player who is not IR-eligible — adds are blocked until you move him",
          );
      }
    }
    // the golden check on the just-finalised week, once per week (T-08)
    const finalWeek = week - 1;
    const state = readJobState(config.cacheDir);
    if (!opts.preKickoff && finalWeek >= 1 && stateNumber(state, "golden.week") !== finalWeek) {
      const settings = (await run.stack.provider.getScoringSettings(ref)).value;
      const boxes = (await run.stack.provider.getBoxScores(ref, finalWeek)).value;
      const g = goldenCounts(boxes, settings);
      updateJobState(config.cacheDir, { "golden.week": finalWeek });
      if (g.checked > 0) {
        const share = g.mismatched / g.checked;
        if (g.mismatched > 0)
          run.store.repos.leagueSettings.raiseCheck(
            check(
              "scoring_mismatch",
              isLeagueWideMismatch(g.mismatched, g.checked) ? "fail" : "warn",
              {
                week: finalWeek,
                checked: g.checked,
                mismatched: g.mismatched,
                share: Math.round(share * 1000) / 1000,
              },
              takenAt,
              settings.settings_hash,
            ),
          );
        lines.push(
          `golden check week ${String(finalWeek)}: ${String(g.mismatched)}/${String(g.checked)} player-week(s) differ from ESPN`,
        );
      }
    }
    // the pre-kickoff working run also stores ESPN's pre-week win probability (T-07)
    if (opts.preKickoff) {
      const live = (await run.stack.provider.getLiveMatchups(ref, week)).value;
      const standings = (await run.stack.provider.getStandings(ref)).value;
      const pct: Record<string, number | null> = {};
      for (const t of standings.teams) pct[String(t.team_id)] = t.playoff_pct_espn;
      run.store.repos.scoreboardSnapshots.put({
        week,
        taken_at: takenAt,
        matchups: live,
        playoff_pct_espn: pct,
      });
      lines.push(`scoreboard snapshot stored (${String(live.length)} matchup(s))`);
    }
    for (const l of lines) await writeLine(io.stdout, l);
    jobWorked(io, config, job);
    return EXIT.ok;
  } catch (e) {
    return await jobFailure(io, config, run, job, e, opts.notify);
  } finally {
    endJob(io, run);
  }
}

/** Whether this hourly wake is the pool's working run (and why). */
export function poolWorkingRun(
  nowMs: number,
  state: Readonly<Record<string, number | string>>,
): "waivers" | "tuesday" | null {
  const anchor = stateNumber(state, "pool.anchor");
  if (
    anchor !== null &&
    nowMs >= anchor + POOL_AFTER_WAIVERS_MS &&
    stateNumber(state, "pool.worked") !== anchor
  )
    return "waivers";
  const d = new Date(nowMs);
  if (
    d.getDay() === 2 &&
    d.getHours() === 6 &&
    stateToken(state, "pool.tuesday") !== localDay(nowMs)
  )
    return "tuesday";
  return null;
}

/** The failures of a fresh settings read after which the pool's anchor is simply read again later. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  "ESPN_UPSTREAM_UNAVAILABLE",
  "UPSTREAM_UNAVAILABLE",
  "RATE_LIMITED",
]);

/** How waiverNextExecutionDate and waiverProcessHour (read as ET) relate (doctor #11 reads it). */
export type AnchorAgreement = "agrees" | "disagrees" | "unknown";

/**
 * Whether the stated next execution falls in the ET process hour on a process day — the
 * fallback's own instant (`nextWaiverRun` without the stated date, from the hour holding it). Unknown
 * when the league states no process hour or days.
 */
export function anchorAgreement(waiver: WaiverRules, statedMs: number): AnchorAgreement {
  const hourStart = Math.floor(statedMs / 3_600_000) * 3_600_000;
  const et = nextWaiverRun({ ...waiver, next_execution: null }, hourStart - 1);
  if (et.at === null) return "unknown";
  return Date.parse(et.at) === hourStart ? "agrees" : "disagrees";
}

/**
 * Re-reads the pool's waiver anchor: `waiverNextExecutionDate` (zone-free) when it is ahead, the ET
 * process hour only when it is not (plan 06 §1.4, §2; ADV OBJ-16). The settings come from the
 * provider's cache — and that body was usually fetched BEFORE the waiver run that just happened, so
 * it states that run's own, now-passed instant: such a body is read fresh once, where ESPN states
 * the next one. Before, every refresh after a working run switched to the ET guess while ESPN served
 * the field (Stage C finding jobs-pool-anchor-cached-past-execution). Records the basis, whether the
 * field was served, and whether it agrees with the ET hour (doctor #11 warns when they disagree, and
 * says "absent" only when it is).
 */
async function refreshPoolAnchor(
  run: JobRun,
  config: Config,
  now: number,
  anchor: number | null,
): Promise<void> {
  const ref = run.stack.ref;
  let rules = (await run.stack.provider.getLeagueRules(ref)).value;
  const statedOf = (w: WaiverRules): number | null => {
    const t = w.next_execution === null ? null : Date.parse(w.next_execution);
    return t !== null && Number.isFinite(t) ? t : null;
  };
  const cached = statedOf(rules.waiver);
  if (cached !== null && cached <= now) {
    // ESPN unreachable for that one read — it failed, or the provider answered from its stale
    // cache instead: the anchor stays (passed and worked), so the next hourly wake reads again —
    // never the ET guess in its place. Any other failure (a rejected cookie, drift) is the job's
    let fresh;
    try {
      fresh = await run.stack.provider.getLeagueRules(ref, { force_refresh: true });
    } catch (e) {
      if (!TRANSIENT_CODES.has(effCodeOf(e))) throw e;
      return;
    }
    if (fresh.stamp.degraded !== null) return;
    rules = fresh.value;
  }
  const stated = statedOf(rules.waiver);
  const next = nextWaiverRun(rules.waiver, now);
  const at = next.at === null ? null : Date.parse(next.at);
  const agreement: AnchorAgreement =
    next.basis === "status" && at !== null ? anchorAgreement(rules.waiver, at) : "unknown";
  if (at !== null && Number.isFinite(at) && at !== anchor)
    updateJobState(config.cacheDir, {
      "pool.anchor": at,
      "pool.anchor_basis": next.basis,
      "pool.anchor_field": stated === null ? "absent" : "served",
      "pool.anchor_et": agreement,
    });
}

/** `eff snapshot pool`. */
export async function snapshotPool(
  io: CliIo,
  config: Config,
  log: Logger,
  opts: SnapshotOptions,
): Promise<number> {
  const job = "snapshot-pool";
  const run = await startJob(io, config, log, job, opts);
  if (typeof run === "number") return run;
  try {
    const now = io.clock.nowMs();
    const ref = run.stack.ref;
    const state = readJobState(config.cacheDir);
    const why = poolWorkingRun(now, state);
    const anchor = stateNumber(state, "pool.anchor");
    if (why === null) {
      // refresh the anchor only when it is unknown, or passed AND worked (one cached settings read
      // at most). A passed anchor whose working run is still due — the wake inside [anchor,
      // anchor + 1 h) — is kept: replacing it there with the NEXT waiver run (nextWaiverRun returns
      // instants strictly after now) meant the wake at anchor + 1 h found a future anchor and the
      // waiver-relative working run never fired (plan 06 §1.4, ADV OBJ-16).
      if (anchor === null || (now >= anchor && stateNumber(state, "pool.worked") === anchor))
        await refreshPoolAnchor(run, config, now, anchor);
      jobIdle(io, config, job);
      await writeLine(io.stdout, `${job}: not a working run — nothing to do`);
      return EXIT.ok;
    }
    const schedule = await proScheduleOf(run, config.season);
    if (schedule !== null && !inSeasonWindow(schedule, now)) {
      jobIdle(io, config, job);
      await writeLine(io.stdout, `${job}: off-season — nothing to do`);
      return EXIT.ok;
    }
    const league = (await run.stack.provider.getLeague(ref)).value;
    const week = league.clock.current_scoring_period;
    const players: PlatformPlayer[] = [];
    for (const position of POOL_POSITIONS) {
      try {
        const page = await run.stack.provider.listPlayers(
          ref,
          { status: "AVAILABLE", position, sort: "percOwned", week, injured: null },
          { limit: 100, offset: 0 },
        );
        players.push(...page.value.items);
      } catch (e) {
        // a position this league does not use is refused by the builder (VALIDATION): skip it
        if ((e as { effCode?: unknown }).effCode !== "VALIDATION") throw e;
      }
    }
    const takenAt = io.clock.nowIso();
    const before = run.store.repos.poolSnapshots.latestTwo()[0];
    run.store.repos.poolSnapshots.put({ taken_at: takenAt, week, players });
    const prevIds = new Set(before?.players.map((p) => p.ref.id) ?? []);
    const appeared =
      before === undefined
        ? []
        : players.filter(
            (p) => !prevIds.has(p.ref.id) && (p.ownership?.percent_owned ?? 0) >= POOL_ALERT_OWNED,
          );
    updateJobState(
      config.cacheDir,
      why === "waivers"
        ? { "pool.worked": anchor ?? now, "pool.worked_at": now }
        : { "pool.tuesday": localDay(now), "pool.worked_at": now },
    );
    await writeLine(
      io.stdout,
      `${job}: ${String(players.length)} pool player(s) stored for week ${String(week)} (${why})`,
    );
    if (appeared.length > 0) {
      const text = `Pool: ${String(appeared.length)} player(s) ≥ ${String(POOL_ALERT_OWNED)} % owned became available — \`espn_list_players\``;
      await writeLine(io.stdout, text);
      if (opts.notify) await run.notifier.info(text);
    }
    jobWorked(io, config, job);
    return EXIT.ok;
  } catch (e) {
    return await jobFailure(io, config, run, job, e, opts.notify);
  } finally {
    endJob(io, run);
  }
}

/** ESPN projection rows from a pool/roster read (weekly and rest-of-season applied totals). */
export function projectionRows(
  players: readonly PlatformPlayer[],
  season: number,
  week: number,
  at: string,
): EspnProjectionSnapshot[] {
  const out: EspnProjectionSnapshot[] = [];
  const seen = new Set<number>();
  for (const p of players) {
    if (seen.has(p.ref.id)) continue;
    seen.add(p.ref.id);
    if (p.projection_week_espn !== null && Number.isFinite(p.projection_week_espn))
      out.push({
        player_id: p.ref.id,
        season,
        week,
        split: "weekly",
        applied_total: p.projection_week_espn,
        stats_raw: {},
        snapshot_at: at,
      });
    if (p.projection_ros_espn !== null && Number.isFinite(p.projection_ros_espn))
      out.push({
        player_id: p.ref.id,
        season,
        week: null,
        split: "ros",
        applied_total: p.projection_ros_espn,
        stats_raw: {},
        snapshot_at: at,
      });
  }
  return out;
}

/** `eff snapshot projections` (Tue 06:00, Thu 18:00, Sun 11:00 — the projection corpus). */
export async function snapshotProjections(
  io: CliIo,
  config: Config,
  log: Logger,
  opts: SnapshotOptions,
): Promise<number> {
  const job = "snapshot-projections";
  const run = await startJob(io, config, log, job, opts);
  if (typeof run === "number") return run;
  try {
    const now = io.clock.nowMs();
    const schedule = await proScheduleOf(run, config.season);
    if (schedule !== null && !inSeasonWindow(schedule, now)) {
      jobIdle(io, config, job);
      await writeLine(io.stdout, `${job}: off-season — nothing to do`);
      return EXIT.ok;
    }
    const ref = run.stack.ref;
    const league = (await run.stack.provider.getLeague(ref)).value;
    const week = league.clock.current_scoring_period;
    const players: PlatformPlayer[] = [];
    for (const position of POOL_POSITIONS) {
      try {
        const page = await run.stack.provider.listPlayers(
          ref,
          { status: "AVAILABLE", position, sort: "percOwned", week, injured: null },
          { limit: 100, offset: 0 },
        );
        players.push(...page.value.items);
      } catch (e) {
        if ((e as { effCode?: unknown }).effCode !== "VALIDATION") throw e;
      }
    }
    if (config.teamId !== null) {
      const roster = (
        await run.stack.provider.getRoster({ league: ref, team_id: config.teamId }, week)
      ).value;
      players.push(...roster.entries.map((e) => e.player));
    }
    const rows = projectionRows(players, config.season, week, io.clock.nowIso());
    const n = run.store.repos.espnProjections.putMany(rows);
    await writeLine(
      io.stdout,
      `${job}: ${String(n)} ESPN projection row(s) stored for week ${String(week)}`,
    );
    jobWorked(io, config, job);
    return EXIT.ok;
  } catch (e) {
    return await jobFailure(io, config, run, job, e, opts.notify);
  } finally {
    endJob(io, run);
  }
}

/**
 * Whether `eff transactions` works at `nowMs`: the wake 30 min after the pool's working run (plan 06
 * §1.4), once per pool run, launch latency included — both instants are read after node start, the
 * store open and the lock, and the pool's :00 run starts beside the other :00 jobs, so its `now` can
 * trail its minute by more than the :30 wake's does (the `isWorkingRun` grace; Stage C finding
 * jobs-transactions-wake-no-grace: that wake read 29 min 59 s and the work slipped an hour).
 */
export function transactionsDue(nowMs: number, state: JobState): boolean {
  const poolAt = stateNumber(state, "pool.worked_at");
  return (
    poolAt !== null &&
    nowMs >= poolAt + TRANSACTIONS_AFTER_POOL_MS - WAKE_GRACE_MS &&
    stateNumber(state, "transactions.after") !== poolAt
  );
}

/** At most this many scoring periods are read by one `eff transactions` run (one request each). */
export const TRANSACTIONS_MAX_PERIODS = 4;

/** The scoring periods one append reads, and the periods it found never read (a gap). */
export interface TransactionPeriods {
  readonly read: readonly number[];
  readonly gap: { readonly from: number; readonly to: number } | null;
}

/**
 * Which scoring periods an append reads (plan 06 §1.4 `transactions append`, "warn on gap
 * detection"): from the period the previous append last read — read AGAIN, so the moves made in it
 * after that read (Monday's adds for the Monday game, the drops before ESPN rolls the period) are
 * stored — through the current one, at most TRANSACTIONS_MAX_PERIODS (the newest); older periods
 * never read are the gap, said. A first run, another season, or a period behind the recorded one
 * reads the current period alone. Before, only the current period was read, so each week's last
 * moves were never stored and nothing noticed (Stage C finding jobs-transactions-period-rollover-gap).
 */
export function transactionPeriods(
  state: JobState,
  season: number,
  firstPeriod: number,
  current: number,
): TransactionPeriods {
  const lastSeason = stateNumber(state, "transactions.season");
  const last = stateNumber(state, "transactions.period");
  if (lastSeason !== season || last === null || last > current || !Number.isInteger(last))
    return { read: [current], gap: null };
  const from = Math.max(firstPeriod, last);
  const start = Math.max(from, current - TRANSACTIONS_MAX_PERIODS + 1);
  const read: number[] = [];
  for (let p = start; p <= current; p++) read.push(p);
  return { read, gap: start > from ? { from, to: start - 1 } : null };
}

/** `eff transactions` — append unseen transactions after the pool's working run (plan 06 §1.4). */
export async function transactionsAppend(
  io: CliIo,
  config: Config,
  log: Logger,
  opts: SnapshotOptions & { readonly force: boolean },
): Promise<number> {
  const job = "transactions";
  const run = await startJob(io, config, log, job, opts);
  if (typeof run === "number") return run;
  try {
    const now = io.clock.nowMs();
    const state = readJobState(config.cacheDir);
    const poolAt = stateNumber(state, "pool.worked_at");
    if (!transactionsDue(now, state) && !opts.force) {
      jobIdle(io, config, job);
      await writeLine(io.stdout, `${job}: not 30 min after a pool run — nothing to do`);
      return EXIT.ok;
    }
    const ref = run.stack.ref;
    const league = (await run.stack.provider.getLeague(ref)).value;
    const week = league.clock.current_scoring_period;
    const plan = transactionPeriods(
      readJobState(config.cacheDir),
      config.season,
      Math.max(1, league.clock.first_scoring_period),
      week,
    );
    let added = 0;
    for (const period of plan.read) {
      const page = await run.stack.provider.listTransactions(ref, {
        types: TRANSACTION_TYPES,
        week: period,
        since: null,
        count: 100,
        team_id: null,
      });
      added += run.store.repos.transactionsSeen.appendNew(page.value.items, io.clock.nowIso());
    }
    updateJobState(config.cacheDir, {
      ...(poolAt === null ? {} : { "transactions.after": poolAt }),
      "transactions.season": config.season,
      "transactions.period": week,
    });
    await writeLine(
      io.stdout,
      `${job}: ${String(added)} new transaction(s) appended (week${plan.read.length > 1 ? "s" : ""} ${plan.read.join(", ")})`,
    );
    if (plan.gap !== null) {
      log.warn("transactions.gap", { from: plan.gap.from, to: plan.gap.to });
      await writeLine(
        io.stdout,
        `${job}: warning: scoring period(s) ${String(plan.gap.from)}–${String(plan.gap.to)} were not read (the job did not run then): the moves made in them since the last run are missing from transactions_seen`,
      );
    }
    jobWorked(io, config, job);
    return EXIT.ok;
  } catch (e) {
    return await jobFailure(io, config, run, job, e, opts.notify);
  } finally {
    endJob(io, run);
  }
}

/** The previous seasons a backfill reads by default (the waiver fit's history window, R6-3). */
export const BACKFILL_DEFAULT_SEASONS = 2;
/** At most this many seasons per backfill run (each costs a settings read plus one per week). */
export const BACKFILL_MAX_SEASONS = 3;
/** One week's transactions page (mTransactions2 holds the whole week; the cap only bounds it). */
export const BACKFILL_WEEK_COUNT = 1000;

/** What a backfill did for one season (counts and codes only). */
export interface BackfillSeason {
  readonly season: number;
  readonly weeks: number;
  readonly read: number;
  readonly added: number;
  /** A fixed code when ESPN does not serve the season to these cookies (it is skipped). */
  readonly skipped: string | null;
}

/**
 * `eff transactions --backfill [--seasons 2024,2025]` (changelog R6-3; plan 07 E5 "the league's
 * own feed"): appends each previous season's transactions — every scoring period's mTransactions2,
 * cookies required on a private league — to transactions_seen, so E5 fits the league's demand curve
 * and premium from its own history on the first call instead of after 13 logged runs. Run by the
 * owner (an interactive `server` origin: never the jobs' daily caps), read host only, under the
 * limiter; idempotent (appendNew dedups by transaction id). Default: the league's newest
 * BACKFILL_DEFAULT_SEASONS previous seasons; a season ESPN does not serve is skipped and said.
 */
export async function transactionsBackfill(
  io: CliIo,
  config: Config,
  log: Logger,
  opts: SnapshotOptions & { readonly seasons: string | undefined },
): Promise<number> {
  const job = "transactions-backfill";
  let asked: number[] | null = null;
  if (opts.seasons !== undefined) {
    asked = parseSeasons(opts.seasons);
    if (asked.some((y) => y >= config.season))
      throw new UsageError(
        `transactions --backfill: --seasons takes previous seasons only (before ${String(config.season)})`,
      );
    if (asked.length > BACKFILL_MAX_SEASONS)
      throw new UsageError(
        `transactions --backfill: at most ${String(BACKFILL_MAX_SEASONS)} seasons per run`,
      );
  }
  const run = await startJob(io, config, log, job, { ...opts, origin: "server" });
  if (typeof run === "number") return run;
  try {
    const ref = run.stack.ref;
    const seasons =
      asked ??
      [...(await run.stack.provider.getLeague(ref)).value.previous_seasons]
        .filter((y) => y < config.season)
        .sort((a, b) => b - a)
        .slice(0, BACKFILL_DEFAULT_SEASONS);
    if (seasons.length === 0) {
      jobIdle(io, config, job);
      await writeLine(io.stdout, `${job}: the league has no previous season to read`);
      return EXIT.ok;
    }
    const done: BackfillSeason[] = [];
    for (const season of seasons) {
      const sref = { ...ref, season };
      let first: number;
      let last: number;
      try {
        const clock = (await run.stack.provider.getLeague(sref)).value.clock;
        first = Math.max(1, clock.first_scoring_period);
        last = Math.max(first, clock.final_scoring_period);
      } catch (e) {
        // a season ESPN does not serve this league is skipped, never fatal; no cookie stored for
        // a private league is no such season — it is the run's credential failure (exit 3, `eff
        // setup`: Stage C finding cli-backfill-no-cookie-exit-zero)
        if (effCodeOf(e) === "ESPN_LEAGUE_NOT_FOUND") {
          done.push({ season, weeks: 0, read: 0, added: 0, skipped: "ESPN_LEAGUE_NOT_FOUND" });
          continue;
        }
        throw e;
      }
      let read = 0;
      let added = 0;
      for (let week = first; week <= last; week++) {
        const page = await run.stack.provider.listTransactions(sref, {
          types: TRANSACTION_TYPES,
          week,
          since: null,
          count: BACKFILL_WEEK_COUNT,
          team_id: null,
        });
        read += page.value.items.length;
        added += run.store.repos.transactionsSeen.appendNew(page.value.items, io.clock.nowIso());
      }
      done.push({ season, weeks: last - first + 1, read, added, skipped: null });
    }
    for (const d of done)
      await writeLine(
        io.stdout,
        d.skipped === null
          ? `${job}: season ${String(d.season)}: ${String(d.weeks)} week(s) read, ${String(d.read)} transaction(s), ${String(d.added)} new`
          : `${job}: season ${String(d.season)}: not served (${d.skipped}) — skipped`,
      );
    const total = done.reduce((a, d) => a + d.added, 0);
    const readAny = done.some((d) => d.skipped === null);
    await writeLine(
      io.stdout,
      readAny
        ? `${job}: ${String(total)} new transaction(s) stored — espn_analyze_waivers fits its premium from them`
        : `${job}: no season could be read — nothing stored; espn_analyze_waivers keeps the basis it has`,
    );
    if (!readAny) {
      jobIdle(io, config, job);
      return EXIT.ok;
    }
    jobWorked(io, config, job);
    return EXIT.ok;
  } catch (e) {
    return await jobFailure(io, config, run, job, e, opts.notify);
  } finally {
    endJob(io, run);
  }
}

/** The problems the pre-kickoff check reports (slot names and counts only). */
export interface PreKickoffFindings {
  readonly empty_slots: readonly string[];
  readonly out_starters: number;
  readonly doubtful_starters: number;
  readonly bye_starters: number;
}

/**
 * Judges a roster for the pre-kickoff check (plan 06 §1.4: the check before the day's first kickoff —
 * of what the owner can still change). A starter whose slot is locked is left out (Stage C finding
 * prekickoff-counts-locked-starters: a Thursday starter hurt in his game alarmed "starter OUT" on
 * Sunday and Monday): locked by ESPN's flag in the snapshot, or — given `nowMs` and the league's
 * verified per-game lock rule — by his game's kickoff having passed (a snapshot older than the lock).
 * An unverified lock rule never silences a starter on the schedule alone.
 */
export function preKickoffFindings(
  roster: Roster,
  slots: RosterSlots,
  schedule: ProSchedule | null,
  week: number,
  nowMs: number | null = null,
): PreKickoffFindings {
  const plan =
    schedule === null || nowMs === null
      ? null
      : lockPlan(
          roster.entries.map((e) => ({
            player_id: e.player.ref.id,
            pro_team_id: e.player.pro_team_id,
            lineup_locked: e.lineup_locked,
          })),
          schedule,
          week,
          slots.lineup_lock_type,
          nowMs,
        );
  const lockedBySchedule = new Set(
    plan !== null && plan.rule === "per_game" && plan.rule_verified ? plan.locked_player_ids : [],
  );
  const starters = roster.entries.filter(
    (e) =>
      (e.slot_class === "starter" || e.slot_class === "flex") &&
      !e.lineup_locked &&
      !lockedBySchedule.has(e.player.ref.id),
  );
  return {
    empty_slots: emptyStartingSlots(seatsOf(roster), slots),
    out_starters: starters.filter(
      (e) => e.player.injury_status === "OUT" || e.player.injury_status === "INJURY_RESERVE",
    ).length,
    doubtful_starters: starters.filter((e) => e.player.injury_status === "DOUBTFUL").length,
    bye_starters:
      schedule === null
        ? 0
        : starters.filter((e) => isOnBye(schedule, e.player.pro_team_id, week)).length,
  };
}

/** The one pre-kickoff notification, or null when nothing is wrong. */
export function preKickoffText(
  f: PreKickoffFindings,
  staleInputs: readonly string[],
): string | null {
  const parts: string[] = [];
  if (f.empty_slots.length > 0)
    parts.push(
      `${String(f.empty_slots.length)} empty starting slot(s) (${[...new Set(f.empty_slots)].join(", ")})`,
    );
  if (f.out_starters > 0) parts.push(`${String(f.out_starters)} starter(s) OUT/IR`);
  if (f.bye_starters > 0) parts.push(`${String(f.bye_starters)} starter(s) on bye`);
  if (f.doubtful_starters > 0) parts.push(`${String(f.doubtful_starters)} DOUBTFUL starter(s)`);
  if (staleInputs.length > 0) parts.push(`stale: ${staleInputs.join(", ")}`);
  return parts.length === 0 ? null : `Before kickoff: ${parts.join("; ")}`;
}

/** `eff pre-kickoff` — no ESPN request beyond the schedule (the newest roster snapshot is judged). */
export async function preKickoff(
  io: CliIo,
  config: Config,
  log: Logger,
  opts: SnapshotOptions,
): Promise<number> {
  const job = "pre-kickoff";
  const run = await startJob(io, config, log, job, opts);
  if (typeof run === "number") return run;
  try {
    const now = io.clock.nowMs();
    const schedule = await proScheduleOf(run, config.season);
    const first = schedule === null ? null : nextDayFirstKickoff(schedule, now);
    if (first === null || !isWorkingRun(now, first - PRE_KICKOFF_MS)) {
      jobIdle(io, config, job);
      await writeLine(
        io.stdout,
        `${job}: not the run before today's first kickoff — nothing to do`,
      );
      return EXIT.ok;
    }
    if (config.teamId === null) {
      // a configuration gap, recorded as a failed run so `eff status` and doctor #11 show it
      recordJobRun(config.cacheDir, job, now, { ok: false, error: "no_team_id" });
      await writeLine(io.stdout, `${job}: ESPN_TEAM_ID is not recorded — run \`eff setup\``);
      return EXIT.ok;
    }
    const [latest] = run.store.repos.rosterSnapshots.latestTwo(config.teamId);
    if (latest === undefined) {
      jobIdle(io, config, job);
      await writeLine(io.stdout, `${job}: no roster snapshot yet — nothing to judge`);
      return EXIT.ok;
    }
    const slots = (await run.stack.provider.getRosterSlots(run.stack.ref)).value;
    const f = preKickoffFindings(latest.roster, slots, schedule, latest.week, now);
    const stale: string[] = [];
    for (const [source, maxH] of [
      ["nflverse:injuries", 36],
      ["nflverse:schedules", 24],
    ] as const) {
      const row = run.store.repos.refreshLog.current().find((r) => r.source === source && r.ok);
      const at = row === undefined ? NaN : Date.parse(row.checked_at);
      if (!Number.isFinite(at) || now - at > maxH * 3_600_000)
        stale.push(source.slice("nflverse:".length));
    }
    const text = preKickoffText(f, stale);
    await writeLine(io.stdout, text ?? `${job}: no problems found`);
    if (text !== null && opts.notify) await run.notifier.info(text);
    jobWorked(io, config, job);
    return EXIT.ok;
  } catch (e) {
    return await jobFailure(io, config, run, job, e, opts.notify);
  } finally {
    endJob(io, run);
  }
}
