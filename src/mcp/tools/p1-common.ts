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
  type ScheduledGame,
  type SeasonSimOutcome,
  type SeasonTeam,
} from "../../domain/analytics/seeding.js";
import type {
  EpWeeklyRow,
  PlayerWeekLine,
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
import { isUpstreamBudgetExhausted } from "../../providers/platform.js";
import { BOUNDS } from "../bounds.js";
import type { InputStamp } from "../envelope.js";
import { EffError } from "../errors.js";
import type { ToolContext } from "../define.js";
import { cpuDeadlineOf, project, standingsFromMatchups, type Subject } from "./analytics.js";
import { leagueOf, optionalDataset, rulesOf, settingsOf, slotsOf, weekOf } from "./common.js";

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
 * shared over the remaining non-bye weeks — E1 v1's own point estimate (weight_espn = 1.0), so the
 * league-wide engines (E4, E6, E8's stream, E9's wire) need no sampling.
 */
export function valueWeeks(p: PlatformPlayer, weeks: readonly Week[]): (number | null)[] {
  return weeklyValues(weeks, p.projection_week_espn, p.projection_ros_espn, p.bye_week);
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
  const derived = standingsFromMatchups(matchups, rules.playoffs.regular_season_matchups);
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
  const rounds =
    r.through_playoffs === false
      ? []
      : r.rules.playoffs.playoff_weeks.map((week) => ({ weeks: [week] }));
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
    rng: seededRng(r.seed),
    deadline_ms: cpuDeadlineOf(ctx),
  };
  const projections = r.projections ?? null;
  if (projections !== null && projections.size > 0)
    return simulateFittedSeason({ ...base, teams, projections });
  return simulateSeason({ ...base, teams });
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
    const input = optionalDataset(r, ctx.nowMs, allowStale);
    if (input !== null) {
      statsLoaded = true;
      if (!inputs.some((x) => x.source === input.source)) inputs.push(input);
      for (const l of r.rows) byGsis.set(l.gsis_id, [...(byGsis.get(l.gsis_id) ?? []), l]);
    }
    const ep = ctx.services.datasets.epWeekly.rows(gsis, season, weeks);
    const epInput = optionalDataset(ep, ctx.nowMs, allowStale);
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
 * A read the call cannot answer without: past this call's upstream budget it becomes RATE_LIMITED
 * with a 1 s retry (the reads before it are cached, so the retry fits — plan 01 §5.6), never an
 * INTERNAL "tool bug".
 */
export async function required<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (e) {
    if (isUpstreamBudgetExhausted(e)) throw new EffError("RATE_LIMITED", { retry_after_s: 1 });
    throw e;
  }
}
