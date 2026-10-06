// season-fit.test.ts — E3 `season` with E1 inputs (src/domain/analytics/seasonFit.ts; plan 07 E3;
// plan 10 B9 "mode: season with E1 inputs reproduces the cold-start result within 0.05 on the base
// fixture" — hard). The fitted model's formula (E1's lineup projection as the prior the season-to-
// date mean updates at n/(n+4), σ from E1), the projection model of several weeks, the identity
// "a prior equal to the league mean with the pooled σ IS the cold start" (byte-equal readings on
// one seed), the bookkeeping (weekly_model, fitted_teams, the assumption), hostile inputs, and B9 on
// fx-10h read through the real provider: every team's lineup projected by E1 for week 5, the season
// simulated cold and fitted under both readings, P(playoffs) and P(bye) within 0.05 for my team.
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { SEEDING } from "../../../src/domain/analytics/constants.js";
import { AnalyticsError } from "../../../src/domain/analytics/errors.js";
import {
  fittedWeekly,
  projectionModel,
  simulateFittedSeason,
  teamWeekOf,
  type FittedSeasonRequest,
  type TeamWeekProjection,
} from "../../../src/domain/analytics/seasonFit.js";
import {
  simulateSeason,
  type PlayedGame,
  type ScheduledGame,
  type SeasonTeam,
} from "../../../src/domain/analytics/seeding.js";
import { seededRng } from "../../../src/domain/clock.js";
import { regularSeasonWeeks } from "../../../src/domain/league/rules.js";
import { bare, clockAndRng, dist, ELIGIBLE, instantPacer, referenceSlots } from "./helpers.js";
import {
  FX_WEEK,
  MY_TEAM,
  fxLeague,
  lineupPlayers,
  projectRosters,
  type FxLeague,
} from "./fx10h-world.js";
import type { LineupPlayer } from "../../../src/domain/analytics/lineup.js";

const team = (id: number, w: number, l: number, pf: number): Omit<SeasonTeam, "weekly"> => ({
  team_id: id,
  division_id: null,
  wins: w,
  losses: l,
  ties: 0,
  points_for: pf,
  points_against: 0,
});

/** A 4-team league after 2 weeks with 4 weeks left (round robin). */
function toy(): Pick<FittedSeasonRequest, "teams" | "played" | "remaining"> {
  const played: PlayedGame[] = [
    { period: 1, home: 1, away: 2, home_points: 120, away_points: 100 },
    { period: 1, home: 3, away: 4, home_points: 110, away_points: 90 },
    { period: 2, home: 1, away: 3, home_points: 105, away_points: 115 },
    { period: 2, home: 2, away: 4, home_points: 95, away_points: 99 },
  ];
  const remaining: ScheduledGame[] = [];
  const pairs = [
    [1, 4, 2, 3],
    [1, 2, 3, 4],
    [1, 3, 2, 4],
    [1, 4, 2, 3],
  ];
  pairs.forEach(([a, b, c, d], i) => {
    remaining.push({ period: 3 + i, matchup_id: 10 + 2 * i, home: a ?? 1, away: b ?? 2 });
    remaining.push({ period: 3 + i, matchup_id: 11 + 2 * i, home: c ?? 3, away: d ?? 4 });
  });
  return {
    teams: [team(1, 1, 1, 225), team(2, 0, 2, 195), team(3, 2, 0, 225), team(4, 1, 1, 189)],
    played,
    remaining,
  };
}

function request(over: Partial<FittedSeasonRequest> = {}): FittedSeasonRequest {
  const { clock } = clockAndRng();
  return {
    ...toy(),
    me: 1,
    playoff: { team_count: 2, seeding_rule: "TOTAL_POINTS_SCORED", reseed: false, rounds: [] },
    seeding_mode: "both",
    seeding_config: { mode: "espn_rule", confirmed_at: null },
    n_sims: 2000,
    marginal: false,
    clock,
    rng: seededRng(5),
    pacer: instantPacer,
    deadline_ms: null,
    projections: new Map(),
    ...over,
  };
}

describe("the fitted weekly model", () => {
  it("E1's projection is the prior the season-to-date mean updates at n/(n+4); σ from E1", () => {
    const prior = { mu: 110, sigma: 22 };
    // 4 games, 480 PF → season mean 120; w = 4/8 → 110 + 0.5 × 10
    expect(fittedWeekly({ wins: 2, losses: 2, ties: 0, points_for: 480 }, prior)).toEqual({
      mu: 115,
      sigma: 22,
    });
    expect(fittedWeekly({ wins: 0, losses: 0, ties: 0, points_for: 0 }, prior)).toEqual(prior);
    expect(SEEDING.shrinkGames).toBe(4);
  });

  it("property: the fitted mean lies between E1's mean and the season mean, nearer the season as games accrue", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 40, max: 200, noNaN: true }),
        fc.double({ min: 40, max: 200, noNaN: true }),
        fc.integer({ min: 1, max: 16 }),
        (mu, seasonMean, n) => {
          const f = fittedWeekly(
            { wins: n, losses: 0, ties: 0, points_for: seasonMean * n },
            { mu, sigma: 20 },
          );
          const lo = Math.min(mu, seasonMean) - 1e-9;
          const hi = Math.max(mu, seasonMean) + 1e-9;
          const more = fittedWeekly(
            { wins: n + 1, losses: 0, ties: 0, points_for: seasonMean * (n + 1) },
            { mu, sigma: 20 },
          );
          return (
            f.mu >= lo &&
            f.mu <= hi &&
            Math.abs(more.mu - seasonMean) <= Math.abs(f.mu - seasonMean) + 1e-9
          );
        },
      ),
    );
  });

  it("projectionModel: the mean of the weeks' means and the RMS σ; non-finite or negative weeks skipped", () => {
    const weeks: TeamWeekProjection[] = [
      { week: 5, mu: 100, sigma: 20 },
      { week: 6, mu: 120, sigma: 10 },
      { week: 7, mu: Number.NaN, sigma: 5 },
      { week: 8, mu: 110, sigma: -1 },
    ];
    const m = projectionModel(weeks);
    expect(m?.mu).toBe(110);
    expect(m?.sigma).toBeCloseTo(Math.sqrt(250), 9);
    expect(projectionModel([])).toBeNull();
    expect(projectionModel([{ week: 5, mu: -3, sigma: 1 }])).toBeNull();
  });

  it("teamWeekOf: the best legal lineup's sum and σ (a bench player never counts)", () => {
    const slots = referenceSlots();
    const p = (id: number, pos: string, mean: number, slot: number): LineupPlayer => ({
      player_id: id,
      gsis_id: null,
      name: bare(`P${String(id)}`),
      position: pos,
      eligible_slot_ids: ELIGIBLE[pos] ?? [],
      injury_status: null,
      pro_team_id: id,
      slot_id: slot,
      locked: false,
      lock_at: null,
      points: dist(mean, 0.4),
      p_active: 1,
      espn_projection: mean,
      percent_started: null,
      role_games: 4,
    });
    const roster = [
      p(1, "QB", 20, 0),
      p(2, "RB", 15, 2),
      p(3, "RB", 12, 2),
      p(4, "WR", 14, 4),
      p(5, "WR", 11, 4),
      p(6, "TE", 9, 6),
      p(7, "RB", 10, 23),
      p(8, "D/ST", 7, 16),
      p(9, "K", 8, 17),
      p(10, "QB", 30, 20), // a better QB on the bench takes the QB seat; the starter sits
    ];
    const t = teamWeekOf(slots, roster, 5);
    expect(t.mu).toBeCloseTo(30 + 15 + 12 + 14 + 11 + 9 + 10 + 7 + 8, 9);
    expect(t.sigma).toBeGreaterThan(0);
    expect(teamWeekOf(slots, [], 5)).toEqual({ week: 5, mu: 0, sigma: 0 });
  });
});

describe("simulateFittedSeason", () => {
  it("a prior equal to the league mean with the pooled σ IS the cold start (identical readings, one seed)", async () => {
    const cold = await simulateSeason({ ...request(), teams: toy().teams });
    const m = cold.models.get(1);
    // the cold start's league mean and pooled σ, recovered from the cold models (n = 2, w = 1/3)
    const lm = (225 + 195 + 225 + 189) / 8;
    const pooled = m?.sigma ?? 0;
    const projections = new Map(
      toy().teams.map((t) => [t.team_id, [{ week: 3, mu: lm, sigma: pooled }]]),
    );
    const fit = await simulateFittedSeason(request({ projections }));
    expect(fit.weekly_model).toBe("e1_fitted");
    expect(fit.fitted_teams).toEqual([1, 2, 3, 4]);
    for (const [i, r] of fit.data.readings.entries()) {
      const c = cold.data.readings[i];
      expect(Math.abs(r.p_playoffs - (c?.p_playoffs ?? -1))).toBeLessThan(0.002);
      expect(Math.abs(r.p_bye - (c?.p_bye ?? -1))).toBeLessThan(0.002);
    }
  });

  it("bookkeeping: cold_start without projections, mixed with some; the fitted assumption leads", async () => {
    const none = await simulateFittedSeason(request());
    expect(none.weekly_model).toBe("cold_start");
    expect(none.fitted_teams).toEqual([]);
    expect(none.data.rec.assumptions[0]?.text).toMatch(/cold-start weekly model/);
    const some = await simulateFittedSeason(
      request({ projections: new Map([[3, [{ week: 3, mu: 130, sigma: 18 }]]]) }),
    );
    expect(some.weekly_model).toBe("mixed");
    expect(some.fitted_teams).toEqual([3]);
    expect(some.data.rec.assumptions[0]?.text).toMatch(/^fitted weekly model for 1 teams/);
    expect(some.models.get(3)?.mu).toBeCloseTo(130 + (2 / 6) * (225 / 2 - 130), 2);
  });

  it("a stronger E1 projection raises my P(playoffs) (direction)", async () => {
    const weak = await simulateFittedSeason(
      request({ projections: new Map([[1, [{ week: 3, mu: 80, sigma: 18 }]]]) }),
    );
    const strong = await simulateFittedSeason(
      request({ projections: new Map([[1, [{ week: 3, mu: 160, sigma: 18 }]]]) }),
    );
    expect(strong.data.readings[0]?.p_playoffs ?? 0).toBeGreaterThan(
      weak.data.readings[0]?.p_playoffs ?? 1,
    );
  });

  it("refuses a projection for a team that is not in the league; the simulator's own checks hold", async () => {
    await expect(
      simulateFittedSeason(
        request({ projections: new Map([[99, [{ week: 3, mu: 1, sigma: 1 }]]]) }),
      ),
    ).rejects.toBeInstanceOf(AnalyticsError);
    await expect(simulateFittedSeason(request({ me: 42 }))).rejects.toBeInstanceOf(AnalyticsError);
  });
});

describe("plan 10 B9 (hard): on fx-10h the fitted season reproduces the cold start within 0.05", () => {
  let fx: FxLeague;
  let fitted: Awaited<ReturnType<typeof simulateFittedSeason>>;
  let cold: Awaited<ReturnType<typeof simulateSeason>>;

  beforeAll(async () => {
    fx = await fxLeague("");
    const projected = await projectRosters(fx, fx.rosters, { from: FX_WEEK, horizon: "week" });
    const regular = fx.rules.playoffs.regular_season_matchups ?? 14;
    const teams = fx.standings.teams.map((t) => ({
      team_id: t.team_id,
      division_id: t.division_id,
      wins: t.wins,
      losses: t.losses,
      ties: t.ties,
      points_for: t.points_for,
      points_against: t.points_against,
    }));
    const played: PlayedGame[] = [];
    const remaining: ScheduledGame[] = [];
    for (const m of fx.matchups) {
      if (m.away === null || m.matchup_period > regular) continue;
      if (
        m.winner !== null &&
        m.winner !== "UNDECIDED" &&
        m.home.points !== null &&
        m.away.points !== null
      )
        played.push({
          period: m.matchup_period,
          home: m.home.team_id,
          away: m.away.team_id,
          home_points: m.home.points,
          away_points: m.away.points,
        });
      else
        remaining.push({
          period: m.matchup_period,
          matchup_id: m.matchup_id,
          home: m.home.team_id,
          away: m.away.team_id,
        });
    }
    const projections = new Map<number, TeamWeekProjection[]>();
    for (const r of fx.rosters)
      projections.set(r.team.team_id, [
        teamWeekOf(fx.slots, lineupPlayers(fx, r, projected), FX_WEEK),
      ]);
    const rounds = fx.rules.playoffs.playoff_weeks.map((w) => ({ weeks: [w] }));
    const base = {
      played,
      remaining,
      me: MY_TEAM,
      playoff: {
        team_count: fx.rules.playoffs.team_count ?? 6,
        seeding_rule: fx.rules.playoffs.seeding_rule,
        reseed: fx.rules.playoffs.reseed,
        rounds,
      },
      seeding_mode: "both" as const,
      seeding_config: { mode: "espn_rule" as const, confirmed_at: null },
      regular_weeks: regularSeasonWeeks(fx.rules.playoffs).filter((w) => w >= FX_WEEK),
      n_sims: 20_000,
      marginal: false,
      clock: fx.clock,
      pacer: instantPacer,
      deadline_ms: null,
    };
    cold = await simulateSeason({ ...base, teams, rng: seededRng(2026) });
    fitted = await simulateFittedSeason({ ...base, teams, projections, rng: seededRng(2026) });
  });

  it("every team is fitted from its E1 lineup; the bracket is the league's (6 teams, weeks 15–17)", () => {
    expect(fitted.weekly_model).toBe("e1_fitted");
    expect(fitted.fitted_teams).toHaveLength(10);
    expect(fx.rules.playoffs.playoff_weeks).toEqual([15, 16, 17]);
  });

  it.each([0, 1])("reading %i: P(playoffs) and P(bye) for my team within 0.05", (i) => {
    const f = fitted.data.readings[i];
    const c = cold.data.readings[i];
    expect(f?.seeding_mode).toBe(c?.seeding_mode);
    expect(Math.abs((f?.p_playoffs ?? 0) - (c?.p_playoffs ?? 1))).toBeLessThan(0.05);
    expect(Math.abs((f?.p_bye ?? 0) - (c?.p_bye ?? 1))).toBeLessThan(0.05);
  });

  it("P(alive) by week carries the bracket (the weights E8 and E9 read)", () => {
    const r = fitted.data.readings[0];
    const playoffAlive = (r?.p_alive_by_week ?? []).filter((x) => x.week >= 15);
    expect(playoffAlive.map((x) => x.week)).toEqual([15, 16, 17]);
    expect(playoffAlive.every((x) => x.p >= 0 && x.p <= 1)).toBe(true);
    expect(playoffAlive[0]?.p).toBeGreaterThanOrEqual(playoffAlive[2]?.p ?? 2);
  });
});
