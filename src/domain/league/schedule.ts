// schedule.ts — what the pro schedule implies for a league (plan 07 B1 `bye_week`, `kickoff`,
// `lock_at`, `game_state`, `lock_schedule[]`, `latest_execution_time`; A1 `clock.current_week_final`
// and `corrections_window_open`; A4 `game_window`; research 05 §1.5 and §5 Start/sit — per-game locks
// under `INDIVIDUAL_GAME`, Thursday/Monday/international kickoffs; research 04 §B.1.6 — a
// `startTimeTBD` date is a placeholder that is never displayed nor used as a lock). Pure: time comes
// in as epoch ms. Ported from sibling @56d9068 (src/domain/league/schedule.ts), adapted: ESPN
// `proTeamSchedules_wl` games keyed by pro-team id, TBD games, ESPN's lock type.
import {
  correctionsWindowOpen,
  inGameWindow,
  isPeriodProvisional,
} from "../../config/freshness.js";
import { LINEUP_LOCK_PER_GAME, enumToken } from "./slots.js";
import type {
  GameState,
  IsoInstant,
  LockScheduleEntry,
  ProGame,
  ProSchedule,
  Week,
} from "./types.js";

/** The free-agent pseudo team (`proTeamId` 0): never on bye, never playing. */
export const FREE_AGENT_PRO_TEAM_ID = 0;

/** Epoch ms of an ISO instant, or null when missing or invalid. */
export function instantMs(iso: IsoInstant | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

const toIso = (ms: number): IsoInstant => new Date(ms).toISOString();

/** The games of one week (ESPN scoring period), in kickoff order (TBD last, then by game id). */
export function gamesOfWeek(schedule: Pick<ProSchedule, "games">, week: Week): ProGame[] {
  return schedule.games
    .filter((g) => g.week === week)
    .sort(
      (a, b) =>
        (kickoffMsOf(a) ?? Number.POSITIVE_INFINITY) -
          (kickoffMsOf(b) ?? Number.POSITIVE_INFINITY) || a.espn_game_id - b.espn_game_id,
    );
}

/** The sorted distinct weeks that have at least one game. */
export function scheduledWeeks(schedule: Pick<ProSchedule, "games">): Week[] {
  return [...new Set(schedule.games.map((g) => g.week))].sort((a, b) => a - b);
}

/**
 * A game's displayable kickoff in epoch ms: null when the start time is TBD (ESPN's `date` is then
 * a placeholder hours before the real slot — research 04 §B.1.6) or the instant is invalid.
 */
export function kickoffMsOf(game: ProGame): number | null {
  return game.start_time_tbd ? null : instantMs(game.kickoff);
}

/** The displayable kickoff as ISO (canonical), or null (see kickoffMsOf). */
export function kickoffOf(game: ProGame): IsoInstant | null {
  const ms = kickoffMsOf(game);
  return ms === null ? null : toIso(ms);
}

/** A team's game among `weekGames` (the earliest known kickoff if the data ever holds two), or null. */
export function teamGame(weekGames: readonly ProGame[], proTeamId: number): ProGame | null {
  let best: ProGame | null = null;
  for (const g of weekGames) {
    if (g.home_pro_team_id !== proTeamId && g.away_pro_team_id !== proTeamId) continue;
    if (best === null) best = g;
    else {
      const a = kickoffMsOf(g);
      const b = kickoffMsOf(best);
      if (a !== null && (b === null || a < b)) best = g;
    }
  }
  return best;
}

/** The opponent of `proTeamId` in `game`. */
export function opponentOf(game: ProGame, proTeamId: number): number {
  return game.away_pro_team_id === proTeamId ? game.home_pro_team_id : game.away_pro_team_id;
}

/**
 * A game's state at `nowMs` (plan 07 B1 `game_state`; research 04 §B.1.7): `final` once
 * `statsOfficial`; `tbd` while the start time is unknown; `in` from kickoff until stats are
 * official; else `pre`. No game (bye, or a player without an NFL team) is `bye`.
 */
export function gameStateOf(game: ProGame | null, nowMs: number): GameState {
  if (game === null) return "bye";
  if (game.stats_official) return "final";
  const k = kickoffMsOf(game);
  if (k === null) return "tbd";
  return nowMs >= k ? "in" : "pre";
}

/**
 * The kickoff slot in US-Eastern time: Wednesday/Thursday/Friday/Saturday/Monday/Tuesday games by
 * day; Sunday split into `sunday_morning` (before 12:00 ET — the international slot, 09:30 ET),
 * `sunday_early` (12:00–15:59), `sunday_late` (16:00–19:59) and `sunday_night` (from 20:00).
 */
export type KickoffWindow =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday_morning"
  | "sunday_early"
  | "sunday_late"
  | "sunday_night";

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "long",
  hour: "2-digit",
  hourCycle: "h23",
});

/** The Eastern weekday (lower-case) and hour of an instant. */
export function easternDayHour(ms: number): { readonly day: string; readonly hour: number } {
  const parts = ET_PARTS.formatToParts(new Date(ms));
  const day = (parts.find((p) => p.type === "weekday")?.value ?? "").toLowerCase();
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  return { day, hour };
}

/** The kickoff window of an instant (null when the instant is missing or invalid). */
export function kickoffWindowOf(iso: IsoInstant | null): KickoffWindow | null {
  const ms = instantMs(iso);
  if (ms === null) return null;
  const { day, hour } = easternDayHour(ms);
  if (day !== "sunday") return day as KickoffWindow;
  if (hour < 12) return "sunday_morning";
  if (hour < 16) return "sunday_early";
  return hour < 20 ? "sunday_late" : "sunday_night";
}

/** The NFL team ids of the schedule (the free-agent pseudo team excluded), ascending. */
export function proTeamIds(schedule: Pick<ProSchedule, "teams">): number[] {
  return schedule.teams
    .map((t) => t.id)
    .filter((id) => id !== FREE_AGENT_PRO_TEAM_ID)
    .sort((a, b) => a - b);
}

/**
 * Byes by week, derived from the games: for every week that has games, each NFL team with no game
 * that week (ascending ids). Weeks where every team plays are omitted.
 */
export function byesByWeek(schedule: ProSchedule): Readonly<Record<string, readonly number[]>> {
  const teams = proTeamIds(schedule);
  const out: [string, readonly number[]][] = [];
  for (const w of scheduledWeeks(schedule)) {
    const playing = new Set<number>();
    for (const g of schedule.games)
      if (g.week === w) {
        playing.add(g.home_pro_team_id);
        playing.add(g.away_pro_team_id);
      }
    const idle = teams.filter((t) => !playing.has(t));
    if (idle.length > 0) out.push([String(w), Object.freeze(idle)]);
  }
  return Object.freeze(Object.fromEntries(out));
}

/**
 * A team's bye week: ESPN's `byeWeek` when it is a plausible week (1–22), else the first week the
 * games show it idle; null for the free-agent team or when neither says.
 */
export function byeWeekOf(schedule: ProSchedule, proTeamId: number): Week | null {
  if (proTeamId === FREE_AGENT_PRO_TEAM_ID) return null;
  const team = schedule.teams.find((t) => t.id === proTeamId);
  const stated = team?.bye_week ?? null;
  if (stated !== null && Number.isInteger(stated) && stated >= 1 && stated <= 22) return stated;
  if (team === undefined) return null;
  for (const [w, idle] of Object.entries(byesByWeek(schedule)))
    if (idle.includes(proTeamId)) return Number(w);
  return null;
}

/** Whether a team has no game in `week` (a week without any game is nobody's bye). */
export function isOnBye(schedule: ProSchedule, proTeamId: number, week: Week): boolean {
  if (proTeamId === FREE_AGENT_PRO_TEAM_ID) return false;
  const weekGames = schedule.games.filter((g) => g.week === week);
  return weekGames.length > 0 && teamGame(weekGames, proTeamId) === null;
}

/**
 * How lineups lock: `per_game` — each player at his own game's kickoff (`INDIVIDUAL_GAME`, every
 * recorded league); any other or missing value → `first_kickoff`, everyone at the week's first
 * known kickoff — the conservative reading (the earliest a lock could be), labelled unverified.
 */
export type LockRule = "per_game" | "first_kickoff";

/** The lock rule of a `lineupLocktimeType` and whether it is the verified one. */
export function lockRuleOf(lineupLockType: string | null): {
  readonly rule: LockRule;
  readonly verified: boolean;
} {
  return enumToken(lineupLockType) === LINEUP_LOCK_PER_GAME
    ? { rule: "per_game", verified: true }
    : { rule: "first_kickoff", verified: false };
}

/** One player to place on the lock schedule. */
export interface LockSubject {
  readonly player_id: number;
  /** NFL team id (a D/ST or TQB unit's own team); null or 0 = no NFL team. */
  readonly pro_team_id: number | null;
  /** ESPN's `lineupLocked` when known: true locks the player whatever the clock says. */
  readonly lineup_locked?: boolean;
}

/** One player's week: his game, kickoff, lock instant and state (plan 07 B1 row fields). */
export interface PlayerLock {
  readonly player_id: number;
  readonly pro_team_id: number | null;
  readonly espn_game_id: number | null;
  readonly opponent_pro_team_id: number | null;
  readonly is_home: boolean | null;
  /** Displayable kickoff; null on bye, without a team, or while TBD. */
  readonly kickoff: IsoInstant | null;
  readonly window: KickoffWindow | null;
  /** When his lineup slot locks; null when no lock instant is known (bye under per_game, TBD). */
  readonly lock_at: IsoInstant | null;
  readonly game_state: GameState;
  readonly locked: boolean;
  readonly bye: boolean;
  readonly no_team: boolean;
  readonly tbd: boolean;
}

/** A roster's lock plan for one week. */
export interface LockPlan {
  readonly week: Week;
  readonly rule: LockRule;
  readonly rule_verified: boolean;
  /** In input order. */
  readonly players: readonly PlayerLock[];
  /** Plan 07 B1 `lock_schedule[]`: one entry per distinct lock instant, ascending, ids sorted. */
  readonly schedule: readonly LockScheduleEntry[];
  readonly bye_player_ids: readonly number[];
  readonly no_team_player_ids: readonly number[];
  /** Players whose game time is TBD: no lock instant can be computed — say so, never guess. */
  readonly tbd_player_ids: readonly number[];
  readonly locked_player_ids: readonly number[];
  /** Plan 07 B1 `latest_execution_time`: the earliest lock still ahead of `nowMs`, or null. */
  readonly latest_execution_time: IsoInstant | null;
  /** Every player with a lock instant or ESPN's lock flag is locked (nothing left to set). */
  readonly all_locked: boolean;
}

const sortedIds = (xs: readonly number[]): readonly number[] =>
  Object.freeze([...new Set(xs)].sort((a, b) => a - b));

/**
 * The lock plan of `subjects` in `week` (research 05 §1.5, §5 Start/sit): under `per_game` each
 * player locks at his own game's displayable kickoff — Thursday, Saturday, Monday and international
 * games included — while a bye or no-team player has no lock instant and a TBD game has none yet;
 * under `first_kickoff` everyone locks at the week's first known kickoff. A player is `locked` when
 * ESPN says so or his lock instant has passed (inclusive).
 */
export function lockPlan(
  subjects: readonly LockSubject[],
  schedule: Pick<ProSchedule, "games">,
  week: Week,
  lineupLockType: string | null,
  nowMs: number,
): LockPlan {
  const { rule, verified } = lockRuleOf(lineupLockType);
  const weekGames = gamesOfWeek(schedule, week);
  const firstKnown = weekGames.map(kickoffMsOf).find((k) => k !== null) ?? null;
  const players: PlayerLock[] = [];
  const byLock = new Map<number, number[]>();
  for (const s of subjects) {
    const team = s.pro_team_id;
    const noTeam = team === null || team === FREE_AGENT_PRO_TEAM_ID;
    const game = noTeam ? null : teamGame(weekGames, team);
    const kickoffMs = game === null ? null : kickoffMsOf(game);
    const tbd = game !== null && kickoffMs === null;
    const lockMs = rule === "per_game" ? kickoffMs : firstKnown;
    const locked = s.lineup_locked === true || (lockMs !== null && nowMs >= lockMs);
    if (lockMs !== null) byLock.set(lockMs, [...(byLock.get(lockMs) ?? []), s.player_id]);
    const kickoff = kickoffMs === null ? null : toIso(kickoffMs);
    players.push(
      Object.freeze({
        player_id: s.player_id,
        pro_team_id: team,
        espn_game_id: game?.espn_game_id ?? null,
        opponent_pro_team_id: game === null || noTeam ? null : opponentOf(game, team),
        is_home: game === null ? null : game.home_pro_team_id === team,
        kickoff,
        window: kickoffWindowOf(kickoff),
        lock_at: lockMs === null ? null : toIso(lockMs),
        game_state: gameStateOf(game, nowMs),
        locked,
        bye: !noTeam && game === null && weekGames.length > 0,
        no_team: noTeam,
        tbd,
      }),
    );
  }
  const lockSchedule: LockScheduleEntry[] = [...byLock.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ms, ids]) => Object.freeze({ lock_at: toIso(ms), player_ids: sortedIds(ids) }));
  let next: number | null = null;
  for (const p of players) {
    const ms = instantMs(p.lock_at);
    if (!p.locked && ms !== null && ms > nowMs && (next === null || ms < next)) next = ms;
  }
  const lockable = players.filter((p) => p.lock_at !== null || p.locked);
  return Object.freeze({
    week,
    rule,
    rule_verified: verified,
    players: Object.freeze(players),
    schedule: Object.freeze(lockSchedule),
    bye_player_ids: sortedIds(players.filter((p) => p.bye).map((p) => p.player_id)),
    no_team_player_ids: sortedIds(players.filter((p) => p.no_team).map((p) => p.player_id)),
    tbd_player_ids: sortedIds(players.filter((p) => p.tbd).map((p) => p.player_id)),
    locked_player_ids: sortedIds(players.filter((p) => p.locked).map((p) => p.player_id)),
    latest_execution_time: next === null ? null : toIso(next),
    all_locked:
      lockable.length > 0 && lockable.every((p) => p.locked) && players.every((p) => !p.tbd),
  });
}

/** The earliest lock instant of a schedule strictly after `nowMs`, or null (none ahead). */
export function latestExecutionTime(
  schedule: readonly LockScheduleEntry[],
  nowMs: number,
): IsoInstant | null {
  let best: number | null = null;
  for (const e of schedule) {
    const at = instantMs(e.lock_at);
    if (at !== null && at > nowMs && (best === null || at < best)) best = at;
  }
  return best === null ? null : toIso(best);
}

/** A week's game flags at an instant (plan 07 A1 `clock`, A4 `game_window`; plan 01 §5.4). */
export interface WeekGameState {
  readonly week: Week;
  readonly games: number;
  /** Any game without official stats (`meta.provisional`). */
  readonly provisional: boolean;
  /** Every game of the week has official stats (A1 `current_week_final`); false for an empty week. */
  readonly final: boolean;
  /** Until 7 days after the week's last known kickoff (unknown → open). */
  readonly corrections_window_open: boolean;
  /** Some game is in progress (`validForLocking && !statsOfficial && now ≥ kickoff`). */
  readonly game_window_open: boolean;
  readonly games_in_progress: readonly number[];
  readonly first_kickoff: IsoInstant | null;
  readonly last_kickoff: IsoInstant | null;
  /** The earliest known kickoff strictly after `nowMs`. */
  readonly next_kickoff: IsoInstant | null;
  readonly has_tbd: boolean;
}

/** The game flags of one week at `nowMs`. */
export function weekGameState(
  schedule: Pick<ProSchedule, "games">,
  week: Week,
  nowMs: number,
): WeekGameState {
  const games = gamesOfWeek(schedule, week);
  const flags = games.map((g) => ({
    id: g.espn_game_id,
    kickoff_ms: kickoffMsOf(g),
    valid_for_locking: g.valid_for_locking,
    stats_official: g.stats_official,
  }));
  const known = flags.map((f) => f.kickoff_ms).filter((k): k is number => k !== null);
  const first = known.length > 0 ? Math.min(...known) : null;
  const last = known.length > 0 ? Math.max(...known) : null;
  const ahead = known.filter((k) => k > nowMs);
  const provisional = isPeriodProvisional(flags);
  return Object.freeze({
    week,
    games: games.length,
    provisional,
    final: games.length > 0 && !provisional,
    corrections_window_open: correctionsWindowOpen(
      flags.some((f) => f.kickoff_ms === null) ? null : last,
      nowMs,
    ),
    game_window_open: inGameWindow(flags, nowMs),
    games_in_progress: Object.freeze(
      flags
        .filter((f) => inGameWindow([f], nowMs))
        .map((f) => f.id)
        .sort((a, b) => a - b),
    ),
    first_kickoff: first === null ? null : toIso(first),
    last_kickoff: last === null ? null : toIso(last),
    next_kickoff: ahead.length > 0 ? toIso(Math.min(...ahead)) : null,
    has_tbd: flags.some((f) => f.kickoff_ms === null),
  });
}
