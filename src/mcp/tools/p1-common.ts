// p1-common.ts — the inputs the Phase-2 (P1) tools share (plan 07 §2 conventions; plan 10 §3.2):
// the league basics read once per call, ESPN's weekly value weeks (E1 v1's own point estimate —
// weight_espn = 1.0, ADV OBJ-02 — so league-wide valuation needs no sampling), E1 over many players
// in chunks under the CPU deadline, the seeding simulator with the league's own bracket (the
// cold-start model, or E1-fitted team weeks when the caller has them — plan 10 B9), the per-game
// usage rows D1, E5 (P1), E7 and E10 read (nflverse stats_player_week + ffopportunity ep_weekly,
// scored under the league's S), and the NFL-team spellings the dataset readers key on. The tools
// assemble inputs only; every engine in src/domain/analytics stays pure.
import type { NflTeam } from "../../config/schema.js";
import type { ProjectedPlayer } from "../../domain/analytics/projection.js";
import type { ProjectionOutcome } from "../../domain/analytics/projection.js";
import {
  simulateFittedSeason,
  type FittedSeasonOutcome,
  type TeamWeekProjection,
} from "../../domain/analytics/seasonRoster.js";
import {
  simulateSeason,
  type PlayedGame,
  type PlayoffRound,
  type ScheduledGame,
  type SeasonSimOutcome,
  type SeasonTeam,
} from "../../domain/analytics/seeding.js";
import type {
  EpWeeklyRow,
  PlayerWeekLine,
  SeasonReading,
  SeasonScenario,
  SeedingModeArg,
  UsageGameRow,
} from "../../domain/analytics/types.js";
import { weeklyValues } from "../../domain/analytics/waivers.js";
import { seededRng } from "../../domain/clock.js";
import { ESPN_TO_NFLVERSE_TEAM } from "../../domain/crosswalk/types.js";
import { normalizeTeam } from "../../domain/crosswalk/teams.js";
import { regularSeasonWeeks } from "../../domain/league/rules.js";
import type {
  League,
  LeagueRules,
  Matchup,
  PlatformPlayer,
  ProSchedule,
  RosterSlots,
  Standings,
  Week,
} from "../../domain/league/types.js";
import { score } from "../../domain/scoring/index.js";
import type { ScoringSettings } from "../../domain/scoring/types.js";
import { BOUNDS } from "../bounds.js";
import type { InputStamp } from "../envelope.js";
import { fromBudgetSignal } from "../errors.js";
import type { ToolContext } from "../define.js";
import {
  carryOutcome,
  cpuDeadlineOf,
  project,
  standingsFromMatchups,
  type Subject,
} from "./analytics.js";
import {
  isDegradable,
  leagueOf,
  leagueRef,
  optionalDataset,
  readOpts,
  rosOptsOf,
  rulesOf,
  settingsOf,
  slotsOf,
  take,
  weekOf,
  withinBudget,
  type RosReading,
} from "./common.js";
import { V2_BULK_SIMS } from "./projection-v2.js";

/** What every P1 analytics tool reads about the league once per call. */
export interface LeagueBasics {
  readonly league: League;
  readonly settings: ScoringSettings;
  readonly slots: RosterSlots;
  readonly rules: LeagueRules;
  readonly w: Week;
}

/** The league, its scoring, slots and rules (one mSettings read, cached) and the call's week. */
export async function basicsOf(
  ctx: ToolContext,
  inputs: InputStamp[],
  args: { readonly allow_stale?: boolean | undefined; readonly week?: number | undefined } = {},
): Promise<LeagueBasics> {
  const league = await leagueOf(ctx, inputs, args);
  const settings = await settingsOf(ctx, inputs);
  const slots = await slotsOf(ctx, inputs);
  const rules = await rulesOf(ctx, inputs);
  return { league, settings, slots, rules, w: weekOf(league, args.week) };
}

/**
 * A player's value per week: ESPN's weekly projection for the first week, its rest-of-season total
 * shared over the games it still counts — E1 v1's own point estimate (weight_espn = 1.0), so the
 * league-wide engines (E4, E6, E7, E8's stream, E9's wire, E11) need no sampling. `ros` is the call's
 * reading of that total (common.ts RosReading: E1's window from the pro schedule at the clock —
 * Stage C finding projection-ros-includes-week18); null reads it from the first value week.
 */
export function valueWeeks(
  p: PlatformPlayer,
  weeks: readonly Week[],
  ros: RosReading | null,
): (number | null)[] {
  return weeklyValues(
    weeks,
    p.projection_week_espn,
    p.projection_ros_espn,
    p.bye_week,
    rosOptsOf(p, ros),
  );
}

/** E1 targets per call (the engine's own cap is 64). */
export const E1_CHUNK = 60;

/**
 * E1 over many subjects, in chunks of E1_CHUNK at the sampler's floor (league-wide reads use the
 * minimum paths; the per-player tools keep their own `n_sims`). The CPU deadline applies per chunk.
 */
export async function projectMany(
  ctx: ToolContext,
  subjects: readonly Subject[],
  o: {
    readonly league: League;
    readonly settings: ScoringSettings;
    readonly schedule: ProSchedule;
    readonly horizon: "week" | "ros";
    readonly week: Week;
    readonly seed: number;
    readonly allowStale: boolean;
    readonly n_sims?: number;
  },
  inputs: InputStamp[],
  warnings: string[],
): Promise<{ readonly byId: Map<number, ProjectedPlayer>; readonly partial: boolean }> {
  const byId = new Map<number, ProjectedPlayer>();
  let partial = false;
  const seen = new Set<number>();
  const unique = subjects.filter((s) => {
    if (seen.has(s.p.ref.id)) return false;
    seen.add(s.p.ref.id);
    return true;
  });
  for (let i = 0; i < unique.length; i += E1_CHUNK) {
    const chunk = unique.slice(i, i + E1_CHUNK);
    const out: ProjectionOutcome = await project(
      ctx,
      chunk,
      {
        league: o.league,
        settings: o.settings,
        schedule: o.schedule,
        horizon: o.horizon,
        week: o.week,
        n_sims: o.n_sims ?? BOUNDS.nSims.min,
        seed: o.seed + i,
        allowStale: o.allowStale,
        // v2-opportunity in bulk (full only): its smallest sample count keeps a many-roster search
        // inside the CPU and stall budgets (plan 10 A16a); E1 called directly uses 2 000
        v2_n_sims: V2_BULK_SIMS,
      },
      // each chunk re-reads the same dataset stamps: keep one copy of each in `inputs`
      i === 0 ? inputs : [],
      i === 0 ? warnings : [],
    );
    partial ||= out.partial;
    for (const w of out.warnings) if (!warnings.includes(w)) warnings.push(w);
    for (const pp of out.players)
      if (pp.target.player_id !== null) byId.set(pp.target.player_id, pp);
  }
  return { byId, partial };
}

/** The simulator's season inputs: standings (the view when read, else from the results), games. */
export function seasonInputs(
  matchups: readonly Matchup[],
  standings: Standings | null,
  rules: LeagueRules,
): { teams: SeasonTeam[]; played: PlayedGame[]; remaining: ScheduledGame[] } {
  const derived = standingsFromMatchups(
    matchups,
    rules.playoffs.regular_season_matchups,
    rules.playoffs.matchup_periods,
  );
  const teams: SeasonTeam[] =
    standings === null
      ? derived.teams
      : standings.teams.map((t) => ({
          team_id: t.team_id,
          division_id: t.division_id,
          wins: t.wins,
          losses: t.losses,
          ties: t.ties,
          points_for: t.points_for,
          points_against: t.points_against,
        }));
  return { teams, played: derived.played, remaining: derived.remaining };
}

/**
 * The playoff rounds of a league: one per playoff MATCHUP period (the periods after
 * `regular_season_matchups`), each spanning the scoring periods `matchupPeriods` gives it — a
 * two-week round (`playoffMatchupPeriodLength` 2, or a two-week final) is ONE round of two weeks
 * (plan 07 E3; the PlayoffRound doc). One round per NFL week split such a round in two: the
 * simulator warned "playoff rounds N differ from the bracket's M" on a valid league, simulated a
 * two-week round as one week and left its second week out of p_alive_by_week (Stage C finding
 * season-sim-multiweek-rounds-split). Without the period map: one round per playoff week.
 */
export function playoffRoundsOf(
  p: Pick<LeagueRules["playoffs"], "regular_season_matchups" | "matchup_periods" | "playoff_weeks">,
): PlayoffRound[] {
  const reg = p.regular_season_matchups;
  if (reg !== null) {
    const rounds = Object.entries(p.matchup_periods)
      .map(([k, ws]) => ({ period: Number(k), weeks: [...ws].sort((a, b) => a - b) }))
      .filter((x) => Number.isInteger(x.period) && x.period > reg && x.weeks.length > 0)
      .sort((a, b) => a.period - b.period)
      .map((x) => ({ weeks: x.weeks }));
    if (rounds.length > 0) return rounds;
  }
  return p.playoff_weeks.map((week) => ({ weeks: [week] }));
}

/** One season simulation's request knobs. */
export interface SeasonRun {
  readonly league: League;
  readonly rules: LeagueRules;
  readonly matchups: readonly Matchup[];
  readonly standings: Standings | null;
  readonly me: number;
  readonly w: Week;
  readonly seed: number;
  readonly seeding_mode: SeedingModeArg;
  readonly n_sims: number;
  readonly marginal: boolean;
  readonly scenarios?: readonly SeasonScenario[];
  readonly through_playoffs?: boolean;
  readonly playoff_pct_espn?: number | null;
  /** E1 team weeks (team id → its lineup's μ, σ by week): the fitted model when given. */
  readonly projections?: ReadonlyMap<number, readonly TeamWeekProjection[]> | null;
  readonly inputs?: readonly InputStamp[];
}

/**
 * The seeding simulator over the league's own schedule and bracket (research 05 §2.4): fitted from
 * E1 team weeks when given (plan 10 B9), else the cold-start Normal model. Null when the league has
 * no playoff field or fewer than two teams (the caller degrades and says so).
 */
export async function runSeason(
  ctx: ToolContext,
  r: SeasonRun,
): Promise<SeasonSimOutcome | FittedSeasonOutcome | null> {
  const { teams, played, remaining } = seasonInputs(r.matchups, r.standings, r.rules);
  const teamCount = r.rules.playoffs.team_count;
  if (teamCount === null || teams.length < 2 || !teams.some((t) => t.team_id === r.me)) return null;
  const rounds = r.through_playoffs === false ? [] : playoffRoundsOf(r.rules.playoffs);
  const base = {
    played,
    remaining,
    me: r.me,
    playoff: {
      team_count: Math.min(teamCount, teams.length),
      seeding_rule: r.rules.playoffs.seeding_rule,
      reseed: r.rules.playoffs.reseed,
      rounds,
    },
    seeding_mode: r.seeding_mode,
    seeding_config: {
      mode: ctx.services.seedingMode,
      confirmed_at: ctx.services.seedingConfirmedAt,
    },
    regular_weeks: regularSeasonWeeks(r.rules.playoffs).filter((x) => x >= r.w),
    ...(r.scenarios === undefined ? {} : { scenarios: r.scenarios }),
    n_sims: r.n_sims,
    marginal: r.marginal,
    ...(r.playoff_pct_espn === undefined ? {} : { playoff_pct_espn: r.playoff_pct_espn }),
    clock: ctx.services.clock,
    pacer: ctx.pacer,
    rng: seededRng(r.seed),
    deadline_ms: cpuDeadlineOf(ctx),
  };
  const projections = r.projections ?? null;
  const sim =
    projections !== null && projections.size > 0
      ? await simulateFittedSeason({ ...base, teams, projections })
      : await simulateSeason({ ...base, teams });
  // the simulator re-runs the bracket from the seeds: rounds ESPN has already decided are taken
  // from its results (Stage C finding season-sim-played-playoff-rounds-ignored)
  return withPlayedBracket(sim, bracketState(r.matchups, r.rules, r.standings), rounds, r.me);
}

// --- the bracket as played (Stage C finding season-sim-played-playoff-rounds-ignored) --------------

/** Where the winners bracket stands by ESPN's results. */
export interface BracketState {
  /** A game of a playoff matchup period has a result. */
  readonly started: boolean;
  /**
   * The winners bracket could be traced: its field is the standings' top `team_count` playoff seeds
   * (final once the regular season is over — and a playoff result exists only then).
   */
  readonly traced: boolean;
  /** The bracket's teams (empty when not traced). */
  readonly field: ReadonlySet<number>;
  /** Leading rounds whose every winners-bracket game is decided. */
  readonly rounds_done: number;
  /** Team → the round (0-based) it lost its winners-bracket game in. */
  readonly lost_in: ReadonlyMap<number, number>;
}

const decidedWinner = (m: Matchup): "HOME" | "AWAY" | null =>
  m.winner === "HOME" || m.winner === "AWAY" ? m.winner : null;

/**
 * The winners bracket as ESPN's results have decided it: from the field (the standings' top
 * `team_count` seeds), round by round over the playoff matchup periods, a decided game between two
 * teams still alive is a bracket game and its loser leaves (a consolation game never pairs two of
 * them). A round counts as done when every bracket game of it is decided; a decided game of the
 * round in progress still eliminates its loser. Not traced without seeds (no standings read).
 */
export function bracketState(
  matchups: readonly Matchup[],
  rules: Pick<LeagueRules, "playoffs">,
  standings: Standings | null,
): BracketState {
  const reg = rules.playoffs.regular_season_matchups;
  const P = rules.playoffs.team_count;
  const games = matchups.filter((m) => reg !== null && m.matchup_period > reg && m.away !== null);
  const started = games.some((m) => decidedWinner(m) !== null);
  const none = {
    started,
    traced: false,
    field: new Set<number>(),
    rounds_done: 0,
    lost_in: new Map<number, number>(),
  };
  if (!started || P === null || standings === null) return none;
  const seeded = standings.teams.filter(
    (t) => t.playoff_seed !== null && t.playoff_seed >= 1 && t.playoff_seed <= P,
  );
  if (seeded.length !== P) return none;
  const field = new Set(seeded.map((t) => t.team_id));
  const alive = new Set(field);
  const lostIn = new Map<number, number>();
  const periods = [...new Set(games.map((m) => m.matchup_period))].sort((a, b) => a - b);
  let done = 0;
  for (const [i, period] of periods.entries()) {
    const bracket = games.filter(
      (m) =>
        m.matchup_period === period &&
        m.away !== null &&
        alive.has(m.home.team_id) &&
        alive.has(m.away.team_id),
    );
    if (bracket.length === 0) break;
    for (const g of bracket) {
      const w = decidedWinner(g);
      if (w === null || g.away === null) continue;
      const loser = w === "HOME" ? g.away.team_id : g.home.team_id;
      alive.delete(loser);
      lostIn.set(loser, i);
    }
    if (!bracket.every((g) => decidedWinner(g) !== null)) break;
    done = i + 1;
  }
  return { started, traced: true, field, rounds_done: done, lost_in: lostIn };
}

/**
 * One simulator reading conditioned on the bracket as played, for team `me`: once ESPN has decided a
 * round, an eliminated team is alive only through the round it lost (P(alive) 0 after it, P(champion)
 * 0, `clinch.eliminated`); a team still alive is alive (1) through the round in progress, and a later
 * round is the simulator's chance given that — P(alive at r) / P(alive at the current round) over its
 * paths, P(champion) likewise; a team that has won every round is the champion. Not traced (no seeds):
 * P(champion) null, said — the simulator's later rounds re-run the bracket from the seeds.
 */
export function conditionedReading(
  reading: SeasonReading,
  state: BracketState,
  rounds: readonly PlayoffRound[],
  me: number,
): { readonly reading: SeasonReading; readonly note: string | null } {
  if (!state.started || rounds.length === 0) return { reading, note: null };
  if (!state.traced)
    return {
      reading: { ...reading, p_champion: null },
      note: "the playoff bracket has started and its field is unknown (no standings seeds): P(alive) for later rounds re-runs the bracket from the seeds, and P(champion) is not given",
    };
  if (!state.field.has(me)) return { reading, note: null };
  const roundOf = new Map<number, number>();
  rounds.forEach((r, i) => {
    for (const w of r.weeks) roundOf.set(w, i);
  });
  const lost = state.lost_in.get(me);
  const firstWeekP = (i: number): number | null => {
    const w = rounds[i]?.weeks[0];
    const x = w === undefined ? undefined : reading.p_alive_by_week.find((y) => y.week === w);
    return x?.p ?? null;
  };
  const clamp = (x: number): number => Math.min(1, Math.max(0, Math.round(x * 10_000) / 10_000));
  if (lost !== undefined)
    return {
      reading: {
        ...reading,
        p_champion: 0,
        p_alive_by_week: reading.p_alive_by_week.map((x) => {
          const ri = roundOf.get(x.week);
          return ri === undefined ? x : { week: x.week, p: ri <= lost ? 1 : 0 };
        }),
        clinch: { ...reading.clinch, eliminated: true },
      },
      note: `eliminated in playoff round ${String(lost + 1)} of ${String(rounds.length)} (ESPN's results): P(alive) is 0 from then on and P(champion) 0`,
    };
  const cur = state.rounds_done;
  if (cur >= rounds.length)
    return {
      reading: {
        ...reading,
        p_champion: 1,
        p_alive_by_week: reading.p_alive_by_week.map((x) =>
          roundOf.has(x.week) ? { week: x.week, p: 1 } : x,
        ),
      },
      note: "the playoff bracket is decided (ESPN's results): this team won it",
    };
  const base = firstWeekP(cur);
  if (base === null || base <= 0)
    return {
      reading: { ...reading, p_champion: null },
      note: `alive in playoff round ${String(cur + 1)} of ${String(rounds.length)} (ESPN's results), a path the simulator did not reach: later rounds re-run the bracket from the seeds, and P(champion) is not given`,
    };
  return {
    reading: {
      ...reading,
      p_champion: reading.p_champion === null ? null : clamp(reading.p_champion / base),
      p_alive_by_week: reading.p_alive_by_week.map((x) => {
        const ri = roundOf.get(x.week);
        if (ri === undefined) return x;
        return { week: x.week, p: ri <= cur ? 1 : clamp(x.p / base) };
      }),
    },
    note: `the playoff bracket has started: round ${String(cur + 1)} of ${String(rounds.length)} is this team's next (ESPN's results); later rounds are the simulator's chances given that it is alive now`,
  };
}

/** A simulator outcome with every reading conditioned on the bracket as played (said once). */
export function withPlayedBracket<T extends SeasonSimOutcome>(
  sim: T,
  state: BracketState,
  rounds: readonly PlayoffRound[],
  me: number,
): T {
  if (!state.started) return sim;
  const notes: string[] = [];
  const readings = sim.data.readings.map((x) => {
    const c = conditionedReading(x, state, rounds, me);
    if (c.note !== null && !notes.includes(c.note)) notes.push(c.note);
    return c.reading;
  });
  return {
    ...sim,
    data: { ...sim.data, readings },
    warnings: [...sim.warnings, ...notes.filter((n) => !sim.warnings.includes(n))],
  };
}

/**
 * P(`team` alive) by playoff week from the seeding simulator under the configured reading (E3
 * `season`, through the playoffs) — the weights E5's W and playoff-week values, E6's Δ and E8's
 * importance take (plan 07 E5's W bullet, changelog R5-1; research 05 §1.2). Null when the schedule
 * cannot be read or the league has no bracket (the engine then weights 1 and says so). A
 * deadline-stopped run's warning reaches `warnings` and `partial` is true.
 */
export async function playoffAliveOf(
  ctx: ToolContext,
  o: {
    readonly league: League;
    readonly rules: LeagueRules;
    readonly team: number;
    readonly w: Week;
    readonly standings: Standings | null;
    readonly seed: number;
    readonly args?: { readonly allow_stale?: boolean | undefined };
  },
  inputs: InputStamp[],
  warnings: string[],
): Promise<{ readonly alive: Readonly<Record<string, number>> | null; readonly partial: boolean }> {
  const mGot = await withinBudget(
    () => ctx.services.platform.getMatchups(leagueRef(ctx), readOpts(ctx, o.args ?? {})),
    warnings,
  ).catch((e: unknown) => {
    if (!isDegradable(e)) throw e;
    return null;
  });
  if (mGot === null) return { alive: null, partial: false };
  const sim = await runSeason(ctx, {
    league: o.league,
    rules: o.rules,
    matchups: take(ctx, mGot, inputs),
    standings: o.standings,
    me: o.team,
    w: o.w,
    seed: o.seed,
    seeding_mode: ctx.services.seedingMode,
    n_sims: BOUNDS.nSims.default,
    marginal: false,
    through_playoffs: true,
  });
  const partial = carryOutcome(sim, warnings);
  const playoff = new Set(o.rules.playoffs.playoff_weeks);
  const alive: Record<string, number> = {};
  for (const x of sim?.data.readings[0]?.p_alive_by_week ?? [])
    if (playoff.has(x.week)) alive[String(x.week)] = x.p;
  return { alive: Object.keys(alive).length === 0 ? null : alive, partial };
}

// --- NFL team spellings ----------------------------------------------------------------------------

/** The nflverse spelling of an ESPN pro-team abbreviation (WSH → WAS, LAR → LA), or null. */
export function nflverseTeam(espnAbbrev: string | null): NflTeam | null {
  if (espnAbbrev === null) return null;
  return ESPN_TO_NFLVERSE_TEAM[espnAbbrev] ?? normalizeTeam(espnAbbrev);
}

/** The ESPN spelling of an nflverse team (WAS → WSH, LA → LAR). */
export function espnTeamOf(team: NflTeam): string {
  for (const [espn, nfl] of Object.entries(ESPN_TO_NFLVERSE_TEAM)) if (nfl === team) return espn;
  return team;
}

// --- usage rows (D1; E5 at P1; E7; E10) ------------------------------------------------------------

/** The datasets one usage read touched (named in `data_gaps[]` when missing). */
export const USAGE_SOURCES = Object.freeze({
  stats: "nflverse:stats_player_week",
  ep: "ffopportunity:ep_weekly",
  snaps: "nflverse:snap_counts",
  pbp: "nflverse:pbp",
});

/** Points per reception under S for a position (the PPR adjustment of the xFP comparison). */
export function receptionPoints(settings: ScoringSettings, positionId: number): number {
  const rule = settings.rules.find((x) => x.canonical === "rec");
  if (rule === undefined) return 0;
  return rule.overrides[String(positionId)] ?? rule.points;
}

/**
 * ffopportunity's expected points are full-PPR (its own scoring); the league's points re-expressed at
 * full PPR for the reception difference make the two comparable (`xfp_gap` = xFP − that).
 */
export function pprAdjusted(points: number, receptions: number | null, recPts: number): number {
  return points + (1 - recPts) * (receptions ?? 0);
}

/** One player's usage read: per-game rows (oldest first) and the datasets that were missing. */
export interface UsageRead {
  readonly games: readonly UsageGameRow[];
  readonly nfl_team: NflTeam | null;
  readonly position: string | null;
  readonly data_gaps: readonly string[];
}

/** The per-game usage rows of `subjects` over `weeks` of `season`, keyed by ESPN player id. */
export function usageOf(
  ctx: ToolContext,
  subjects: readonly {
    readonly p: { readonly ref: { readonly id: number }; readonly position_id: number };
    readonly gsis: string | null;
  }[],
  season: number,
  weeks: readonly Week[],
  settings: ScoringSettings | null,
  allowStale: boolean,
  inputs: InputStamp[],
): { readonly byId: Map<number, UsageRead>; readonly gaps: readonly string[] } {
  const byId = new Map<number, UsageRead>();
  const gaps: string[] = [];
  const gsis = [...new Set(subjects.map((s) => s.gsis).filter((g): g is string => g !== null))];
  const byGsis = new Map<string, PlayerWeekLine[]>();
  const epBy = new Map<string, EpWeeklyRow>();
  let statsLoaded = false;
  let epLoaded = false;
  if (gsis.length > 0 && weeks.length > 0) {
    const r = ctx.services.datasets.playerWeeks.lines(gsis, season, weeks);
    const input = optionalDataset(r, ctx, allowStale);
    if (input !== null) {
      statsLoaded = true;
      if (!inputs.some((x) => x.source === input.source)) inputs.push(input);
      for (const l of r.rows) byGsis.set(l.gsis_id, [...(byGsis.get(l.gsis_id) ?? []), l]);
    }
    const ep = ctx.services.datasets.epWeekly.rows(gsis, season, weeks);
    const epInput = optionalDataset(ep, ctx, allowStale);
    if (epInput !== null) {
      epLoaded = true;
      if (!inputs.some((x) => x.source === epInput.source)) inputs.push(epInput);
      for (const e of ep.rows) epBy.set(`${e.gsis_id}:${String(e.week)}`, e);
    }
  }
  if (!statsLoaded) gaps.push(`${USAGE_SOURCES.stats} not loaded`);
  if (!epLoaded) gaps.push(`${USAGE_SOURCES.ep} not loaded: xfp_ep and xfp_gap are null`);
  for (const s of subjects) {
    const own: string[] = [];
    if (s.gsis === null) own.push("no crosswalk pair: no nflverse usage");
    const lines = s.gsis === null ? [] : [...(byGsis.get(s.gsis) ?? [])];
    lines.sort((a, b) => a.week - b.week);
    const recPts = settings === null ? 0 : receptionPoints(settings, s.p.position_id);
    const games: UsageGameRow[] = lines.map((l) => {
      let pts: number | null = null;
      if (settings !== null)
        try {
          pts = score(l.line, settings).points;
        } catch {
          pts = null;
        }
      const ep = s.gsis === null ? undefined : epBy.get(`${s.gsis}:${String(l.week)}`);
      const xfp = ep?.xfp_total ?? null;
      const rec = l.line.values.rec ?? l.line.values.rec_stat ?? null;
      const u = l.usage;
      return {
        week: l.week,
        opponent: l.opponent,
        snaps: u?.snaps ?? null,
        snap_pct: u?.snap_pct ?? null,
        routes_proxy: u?.routes_proxy ?? null,
        targets: u?.targets ?? null,
        target_share: u?.target_share ?? null,
        air_yards: u?.air_yards ?? null,
        air_yards_share: u?.air_yards_share ?? null,
        adot: u?.adot ?? null,
        wopr: u?.wopr ?? null,
        racr: u?.racr ?? null,
        carries: u?.carries ?? null,
        carry_share: u?.carry_share ?? null,
        rz_targets: u?.rz_targets ?? null,
        rz_carries: u?.rz_carries ?? null,
        rz_team: u?.rz_team ?? null,
        gl_carries: u?.gl_carries ?? null,
        xfp_ep: xfp,
        points_league: pts,
        xfp_gap: xfp === null || pts === null ? null : xfp - pprAdjusted(pts, rec, recPts),
      };
    });
    if (games.length > 0 && games.every((g) => g.snap_pct === null))
      own.push(
        `${USAGE_SOURCES.snaps} not in the store's usage rows: snaps and routes_proxy are null`,
      );
    if (games.length > 0 && games.every((g) => g.rz_targets === null && g.rz_carries === null))
      own.push(
        `${USAGE_SOURCES.pbp} red-zone counts not in the store's usage rows: rz fields are null`,
      );
    const latest = lines[lines.length - 1];
    byId.set(s.p.ref.id, {
      games,
      nfl_team: latest?.nfl_team ?? null,
      position: latest?.position ?? null,
      data_gaps: own,
    });
  }
  return { byId, gaps };
}

/**
 * A player's red-zone share over games: Σ(his RZ targets + carries) ÷ Σ(his team's), over the weeks
 * the pbp file covers (`rz_team` known and > 0); null when none is covered. Clamped to [0, 1].
 */
export function rzShareOf(games: readonly UsageGameRow[]): number | null {
  let mine = 0;
  let team = 0;
  for (const g of games) {
    const t = g.rz_team;
    if (t === null || t === undefined || !(t > 0)) continue;
    mine += (g.rz_targets ?? 0) + (g.rz_carries ?? 0);
    team += t;
  }
  return team > 0 ? Math.min(1, Math.max(0, mine / team)) : null;
}

/** Distinct, in order. */
export function uniq<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

/** The mean of the finite values (null when none). */
export function meanFinite(xs: readonly (number | null | undefined)[]): number | null {
  const v = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  return v.length === 0 ? null : v.reduce((s, x) => s + x, 0) / v.length;
}

/**
 * A read the call cannot answer without: past this call's request cap it becomes RATE_LIMITED with
 * a 1 s retry (the reads before it are cached, so the retry fits — plan 01 §5.6), past its deadline
 * ESPN_UPSTREAM_UNAVAILABLE (plan 01 §6) — never an INTERNAL "tool bug" (errors.ts fromBudgetSignal).
 */
export async function required<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (e) {
    throw fromBudgetSignal(e);
  }
}
