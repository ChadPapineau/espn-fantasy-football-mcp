// season-bracket.test.ts — the season simulator's playoff numbers respect the rounds ESPN has already
// decided (plan 07 E3/E8/E9: alive-by-week for the league's own bracket; plan 09 schedule-plan:
// "eliminated → say so rather than manufacture advice"). Stage C finding
// season-sim-played-playoff-rounds-ignored: standingsFromMatchups skips every playoff period and the
// simulator always re-runs the bracket from seed 1, so in weeks 16 and 17 an eliminated team (the
// owner included) kept title odds and P(alive) — p_champion 0.13, clinch.eliminated false, E9
// competing "yes", E8 weighting week 16 at 0.7 — and the team that advanced lost them. The bracket is
// traced from the standings' seeds and ESPN's results (bracketState) and every reading is
// conditioned on it (conditionedReading). Units over the finding's bracket, then the tools on fx-10h
// in week 16 with the owner eliminated in week 15 (fixture mode, no network).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SeasonReading } from "../../src/domain/analytics/types.js";
import type {
  League,
  LeagueRules,
  Matchup,
  Stamped,
  Standings,
} from "../../src/providers/platform.js";
import { bracketState, conditionedReading } from "../../src/mcp/tools/p1-common.js";
import { faulty } from "./helpers/faults.js";
import { ESPN_FIXTURES, call, connect, makeWorld } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
const RULES = {
  playoffs: {
    regular_season_matchups: 14,
    team_count: 6,
    matchup_periods: { "15": [15], "16": [16], "17": [17] },
    playoff_weeks: [15, 16, 17],
  },
} as unknown as Pick<LeagueRules, "playoffs">;
const ROUNDS = [{ weeks: [15] }, { weeks: [16] }, { weeks: [17] }];

/** Seeds 1–6 are teams 10, 9, 8, 7, 6, 5 (the finding's repro); teams 1–4 are seeds 7–10. */
const SEEDS: Readonly<Record<number, number>> = {
  10: 1,
  9: 2,
  8: 3,
  7: 4,
  6: 5,
  5: 6,
  1: 7,
  2: 8,
  3: 9,
  4: 10,
};
const standingsOf = (seeds: Readonly<Record<number, number>> = SEEDS): Standings =>
  ({
    teams: Array.from({ length: 10 }, (_, i) => ({
      team_id: i + 1,
      playoff_seed: seeds[i + 1] ?? null,
    })),
  }) as unknown as Standings;

const game = (
  period: number,
  home: number,
  away: number,
  winner: "HOME" | "AWAY" | "UNDECIDED",
): Matchup =>
  ({
    matchup_id: period * 100 + home,
    matchup_period: period,
    playoff_tier: null,
    winner,
    is_bye: false,
    home: { team_id: home, points: winner === "UNDECIDED" ? null : 100, points_by_week: {} },
    away: { team_id: away, points: winner === "UNDECIDED" ? null : 90, points_by_week: {} },
  }) as unknown as Matchup;

/** Week 15 as played: seed 6 (team 5) beat seed 3 (team 8); seed 4 (team 7) beat seed 5 (team 6). */
const WEEK15 = [game(15, 8, 5, "AWAY"), game(15, 7, 6, "HOME"), game(15, 1, 2, "HOME")];

const reading = (alive: Record<number, number>, champion: number | null): SeasonReading => ({
  seeding_mode: "espn_rule",
  p_playoffs: 1,
  p_bye: 0,
  p_champion: champion,
  seed_distribution: [],
  p_alive_by_week: [
    { week: 14, p: 1 },
    ...Object.entries(alive).map(([w, p]) => ({ week: Number(w), p })),
  ],
  tiebreak_chain: [],
  cutoff: { seed_line: 6, wins_gap: 0, pf_gap: 0, pf_rank_needed: null },
  marginal_values: {} as never,
  pf_per_win: null,
  clinch: { clinched: true, eliminated: false, magic_number: null },
  scenarios_applied: [],
});

describe("bracketState (Stage C season-sim-played-playoff-rounds-ignored)", () => {
  it("round 1 decided: its losers out, the consolation game ignored, one round done", () => {
    const st = bracketState(WEEK15, RULES, standingsOf());
    expect(st).toMatchObject({ started: true, traced: true, rounds_done: 1 });
    expect([...st.lost_in.entries()].sort()).toEqual([
      [6, 0],
      [8, 0],
    ]);
    expect([...st.field].sort((a, b) => a - b)).toEqual([5, 6, 7, 8, 9, 10]);
  });

  it("a decided game of the round in progress eliminates its loser; the round is not done", () => {
    const st = bracketState(
      [...WEEK15, game(16, 10, 5, "HOME"), game(16, 9, 7, "UNDECIDED")],
      RULES,
      standingsOf(),
    );
    expect(st.rounds_done).toBe(1);
    expect(st.lost_in.get(5)).toBe(1);
    expect(st.lost_in.has(9)).toBe(false);
  });

  it("not started before a playoff result; not traced without the standings' seeds", () => {
    expect(bracketState([game(15, 8, 5, "UNDECIDED")], RULES, standingsOf()).started).toBe(false);
    expect(bracketState(WEEK15, RULES, null)).toMatchObject({ started: true, traced: false });
  });
});

describe("conditionedReading", () => {
  const st = bracketState(WEEK15, RULES, standingsOf());
  // the simulator's unconditional numbers (it re-ran week 15 from the seeds)
  const sim = reading({ 15: 1, 16: 0.5835, 17: 0.2715 }, 0.1303);

  it("the eliminated team: alive only through its round, P(champion) 0, eliminated", () => {
    const c = conditionedReading(sim, st, ROUNDS, 8);
    expect(c.reading.p_alive_by_week).toEqual([
      { week: 14, p: 1 },
      { week: 15, p: 1 },
      { week: 16, p: 0 },
      { week: 17, p: 0 },
    ]);
    expect(c.reading.p_champion).toBe(0);
    expect(c.reading.clinch.eliminated).toBe(true);
    expect(c.note).toBe(
      "eliminated in playoff round 1 of 3 (ESPN's results): P(alive) is 0 from then on and P(champion) 0",
    );
  });

  it("the team that advanced: alive (1) in the round it is in, later rounds given that", () => {
    const c = conditionedReading(reading({ 15: 1, 16: 0.4165, 17: 0.2 }, 0.1), st, ROUNDS, 5);
    expect(c.reading.p_alive_by_week.find((x) => x.week === 16)?.p).toBe(1);
    expect(c.reading.p_alive_by_week.find((x) => x.week === 17)?.p).toBeCloseTo(0.2 / 0.4165, 4);
    expect(c.reading.p_champion).toBeCloseTo(0.1 / 0.4165, 4);
    expect(c.reading.clinch.eliminated).toBe(false);
  });

  it("a team outside the field, and an unstarted bracket, are left as simulated", () => {
    expect(conditionedReading(sim, st, ROUNDS, 1).reading).toBe(sim);
    expect(conditionedReading(sim, bracketState([], RULES, standingsOf()), ROUNDS, 8).reading).toBe(
      sim,
    );
  });

  it("not traced: P(champion) is not given, said", () => {
    const c = conditionedReading(sim, bracketState(WEEK15, RULES, null), ROUNDS, 8);
    expect(c.reading.p_champion).toBeNull();
    expect(c.note).toMatch(/^the playoff bracket has started and its field is unknown/);
  });

  it("the champion: every playoff week alive and P(champion) 1", () => {
    const done = bracketState(
      [...WEEK15, game(16, 10, 5, "HOME"), game(16, 9, 7, "HOME"), game(17, 10, 9, "HOME")],
      RULES,
      standingsOf(),
    );
    const c = conditionedReading(sim, done, ROUNDS, 10);
    expect(c.reading.p_champion).toBe(1);
    expect(c.reading.p_alive_by_week.every((x) => x.p === 1)).toBe(true);
  });
});

describe("the tools in week 16 with the owner eliminated in week 15 (fx-10h)", () => {
  it("E3 season: P(champion) 0, eliminated, P(alive) 0 after week 15; E9 competing eliminated; E8 weights 0", async () => {
    const m = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
      my_team_id: number;
    };
    const me = m.my_team_id; // team 2
    const world = await makeWorld({
      env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: "full" },
      teamId: me,
      clock: "2026-12-22T15:00:00.000Z",
    });
    try {
      // the regular season complete; seeds 1–6 = teams 1, 3, 2 (me), 4, 5, 6; week 15: seed 6
      // (team 6) beat me (seed 3), seed 4 (team 4) beat seed 5 (team 5)
      const seeds: Record<number, number> = { 1: 1, 3: 2, 2: 3, 4: 4, 5: 5, 6: 6 };
      const s = faulty(world.services, {
        getLeague: async (real, ...args) => {
          const got = (await real(...args)) as Stamped<League>;
          return {
            ...got,
            value: {
              ...got.value,
              clock: {
                ...got.value.clock,
                current_matchup_period: 16,
                current_scoring_period: 16,
                latest_scoring_period: 16,
              },
            },
          };
        },
        getMatchups: async (real, ...args) => {
          const got = (await real(...args)) as Stamped<readonly Matchup[]>;
          const regular = got.value.map((x) =>
            x.winner === "UNDECIDED" && x.away !== null
              ? {
                  ...x,
                  winner: "HOME" as const,
                  home: { ...x.home, points: 110 },
                  away: { ...x.away, points: 100 },
                }
              : x,
          );
          return {
            ...got,
            value: [...regular, game(15, 2, 6, "AWAY"), game(15, 4, 5, "HOME")],
          };
        },
        // fx-10h records rosters through week 5: week 16's are week 5's
        getRosters: (real, ref, week, opts) => real(ref, Math.min(Number(week), 5), opts),
        getStandings: async (real, ...args) => {
          const got = (await real(...args)) as Stamped<Standings>;
          return {
            ...got,
            value: {
              ...got.value,
              teams: got.value.teams.map((t) => ({
                ...t,
                playoff_seed: seeds[t.team_id] ?? t.team_id,
              })),
            },
          };
        },
      });
      const c = await connect(world, { options: { toolset: "full" }, services: s });
      const e3 = await call(c.client, "espn_analyze_matchup", {
        mode: "season",
        horizon: "through_playoffs",
        n_sims: 2000,
        seed: 1,
      });
      expect(e3.isError, JSON.stringify(e3.body).slice(0, 400)).toBe(false);
      const r0 = (e3.body.data as { readings: SeasonReading[] }).readings[0];
      expect(r0?.p_champion).toBe(0);
      expect(r0?.clinch.eliminated).toBe(true);
      const alive = new Map(r0?.p_alive_by_week.map((x) => [x.week, x.p]));
      expect([alive.get(15), alive.get(16), alive.get(17)]).toEqual([1, 0, 0]);
      expect(e3.body.warnings as string[]).toContain(
        "eliminated in playoff round 1 of 3 (ESPN's results): P(alive) is 0 from then on and P(champion) 0",
      );
      const e9 = await call(c.client, "espn_analyze_roster", {});
      expect(e9.isError, JSON.stringify(e9.body).slice(0, 400)).toBe(false);
      expect((e9.body.data as { competing: string }).competing).toBe("eliminated");
      const e8 = await call(c.client, "espn_analyze_schedule", { seed: 7 });
      expect(e8.isError, JSON.stringify(e8.body).slice(0, 400)).toBe(false);
      const weeks = (
        e8.body.data as {
          weeks: { week: number; weight: { p_alive: number; importance: number } }[];
        }
      ).weeks;
      const late = weeks.filter((x) => x.week >= 16);
      expect(late.length).toBeGreaterThan(0);
      for (const w of late) expect(w.weight, String(w.week)).toEqual({ p_alive: 0, importance: 0 });
      await c.close();
    } finally {
      world.cleanup();
    }
  }, 180_000);
});
