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
} from "../domain/league/types.js";
import type { EspnProjectionSnapshot } from "../domain/analytics/types.js";
import { isLeagueWideMismatch, statLineFromEspn, verify } from "../domain/scoring/index.js";
import type { ScoringSettings } from "../domain/scoring/types.js";
import type { StoreFactory } from "../store/types.js";
import { localDay } from "./credential-check.js";
import {
  dayFirstKickoff,
  endJob,
  inSeasonWindow,
  isWorkingRun,
  jobFailure,
  proScheduleOf,
  startJob,
  weekFirstKickoff,
  type JobRun,
} from "./espn-jobs.js";
import { EXIT } from "./exit.js";
import { writeLine, type CliIo } from "./io.js";
import { readJobState, stateNumber, stateToken, updateJobState } from "./job-state.js";
import type { Logger } from "./log.js";

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
      await writeLine(io.stdout, `${job}: off-season — nothing to do`);
      return EXIT.ok;
    }
    if (opts.preKickoff) {
      const first = schedule === null ? null : weekFirstKickoff(schedule, now);
      if (first === null || !isWorkingRun(now, first.at - ROSTER_PRE_KICKOFF_MS)) {
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
      // the daily IR-validity check (T-08): a healthy player in IR blocks every add
      const slots = (await run.stack.provider.getRosterSlots(ref)).value;
      const ir = auditIr(seatsOf(mine), slots);
      if (ir.invalid && !hasOpenCheck(run, "ir_invalid")) {
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
      // refresh the anchor only when it is unknown or passed (one cached settings read at most)
      if (anchor === null || now >= anchor) {
        const rules = (await run.stack.provider.getLeagueRules(ref)).value;
        const next = nextWaiverRun(rules.waiver, now);
        const at = next.at === null ? null : Date.parse(next.at);
        if (at !== null && Number.isFinite(at) && at !== anchor)
          updateJobState(config.cacheDir, { "pool.anchor": at, "pool.anchor_basis": next.basis });
      }
      await writeLine(io.stdout, `${job}: not a working run — nothing to do`);
      return EXIT.ok;
    }
    const schedule = await proScheduleOf(run, config.season);
    if (schedule !== null && !inSeasonWindow(schedule, now)) {
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
    return EXIT.ok;
  } catch (e) {
    return await jobFailure(io, config, run, job, e, opts.notify);
  } finally {
    endJob(io, run);
  }
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
    const done = stateNumber(state, "transactions.after");
    const due = poolAt !== null && now >= poolAt + TRANSACTIONS_AFTER_POOL_MS && done !== poolAt;
    if (!due && !opts.force) {
      await writeLine(io.stdout, `${job}: not 30 min after a pool run — nothing to do`);
      return EXIT.ok;
    }
    const ref = run.stack.ref;
    const league = (await run.stack.provider.getLeague(ref)).value;
    const week = league.clock.current_scoring_period;
    const page = await run.stack.provider.listTransactions(ref, {
      types: TRANSACTION_TYPES,
      week,
      since: null,
      count: 100,
      team_id: null,
    });
    const added = run.store.repos.transactionsSeen.appendNew(page.value.items, io.clock.nowIso());
    if (poolAt !== null) updateJobState(config.cacheDir, { "transactions.after": poolAt });
    await writeLine(
      io.stdout,
      `${job}: ${String(added)} new transaction(s) appended (week ${String(week)})`,
    );
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

/** Judges a roster for the pre-kickoff check (plan 06 §1.4). */
export function preKickoffFindings(
  roster: Roster,
  slots: RosterSlots,
  schedule: ProSchedule | null,
  week: number,
): PreKickoffFindings {
  const starters = roster.entries.filter(
    (e) => e.slot_class === "starter" || e.slot_class === "flex",
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
    const first = schedule === null ? null : dayFirstKickoff(schedule, now);
    if (first === null || !isWorkingRun(now, first - PRE_KICKOFF_MS)) {
      await writeLine(
        io.stdout,
        `${job}: not the run before today's first kickoff — nothing to do`,
      );
      return EXIT.ok;
    }
    if (config.teamId === null) {
      await writeLine(io.stdout, `${job}: ESPN_TEAM_ID is not recorded — run \`eff setup\``);
      return EXIT.ok;
    }
    const [latest] = run.store.repos.rosterSnapshots.latestTwo(config.teamId);
    if (latest === undefined) {
      await writeLine(io.stdout, `${job}: no roster snapshot yet — nothing to judge`);
      return EXIT.ok;
    }
    const slots = (await run.stack.provider.getRosterSlots(run.stack.ref)).value;
    const f = preKickoffFindings(latest.roster, slots, schedule, latest.week);
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
    return EXIT.ok;
  } catch (e) {
    return await jobFailure(io, config, run, job, e, opts.notify);
  } finally {
    endJob(io, run);
  }
}
