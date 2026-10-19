// season-rounds.test.ts — the seeding simulator's rounds are the league's playoff MATCHUP periods, and
// a remaining game spans its period's scoring periods (plan 07 E3: a round is "the NFL weeks it spans
// (matchupPeriods of the playoff periods)"; research 05 §2.3: read scheduleSettings.matchupPeriods,
// never assume). Stage C finding season-sim-multiweek-rounds-split: runSeason built one round per
// playoff WEEK, so a two-week round was two rounds — the simulator warned "playoff rounds 3 differ from
// the bracket's 2" on a valid league, simulated the two-week round as one week and dropped its second
// week from p_alive_by_week — and standingsFromMatchups never set ScheduledGame.weeks. Units, then E3
// on fx-10h with a two-week final (fixture mode, no network).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LeagueRules, Matchup, Stamped } from "../../src/providers/platform.js";
import { standingsFromMatchups } from "../../src/mcp/tools/analytics.js";
import { playoffRoundsOf } from "../../src/mcp/tools/p1-common.js";
import { faulty } from "./helpers/faults.js";
import { ESPN_FIXTURES, call, connect, makeWorld } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");

describe("playoffRoundsOf (Stage C season-sim-multiweek-rounds-split)", () => {
  it("one round per playoff matchup period, its weeks in order", () => {
    expect(
      playoffRoundsOf({
        regular_season_matchups: 14,
        matchup_periods: { "14": [14], "15": [16, 15], "16": [17, 18] },
        playoff_weeks: [15, 16, 17, 18],
      }),
    ).toEqual([{ weeks: [15, 16] }, { weeks: [17, 18] }]);
    // the owner's format: one-week rounds stay one per week
    expect(
      playoffRoundsOf({
        regular_season_matchups: 14,
        matchup_periods: { "14": [14], "15": [15], "16": [16], "17": [17] },
        playoff_weeks: [15, 16, 17],
      }),
    ).toEqual([{ weeks: [15] }, { weeks: [16] }, { weeks: [17] }]);
    // no period map: one round per playoff week
    expect(
      playoffRoundsOf({
        regular_season_matchups: null,
        matchup_periods: {},
        playoff_weeks: [15, 16],
      }),
    ).toEqual([{ weeks: [15] }, { weeks: [16] }]);
  });

  it("a remaining game spans its matchup period's scoring periods", () => {
    const m = (period: number, h: number, a: number): Matchup =>
      ({
        matchup_id: period * 10 + h,
        matchup_period: period,
        playoff_tier: null,
        winner: "UNDECIDED",
        is_bye: false,
        home: { team_id: h, points: null, points_by_week: {} },
        away: { team_id: a, points: null, points_by_week: {} },
      }) as unknown as Matchup;
    const out = standingsFromMatchups([m(9, 1, 2), m(10, 3, 4)], 10, {
      "9": [9],
      "10": [10, 11],
    });
    expect(out.remaining).toEqual([
      { period: 9, matchup_id: 91, home: 1, away: 2 },
      { period: 10, matchup_id: 103, home: 3, away: 4, weeks: 2 },
    ]);
  });
});

describe("E3 season with a two-week round (the tool)", () => {
  it("rounds [15] and [16, 17]: no 'rounds differ' warning; week 17 is in p_alive_by_week, as week 16", async () => {
    const m = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
      clock: string;
      my_team_id: number;
    };
    const world = await makeWorld({
      env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: "full" },
      teamId: m.my_team_id,
      clock: m.clock,
    });
    try {
      // a four-team bracket: the semifinal week 15, the final over weeks 16 and 17
      const s = faulty(world.services, {
        getLeagueRules: async (real, ...args) => {
          const got = (await real(...args)) as Stamped<LeagueRules>;
          const p = got.value.playoffs;
          // periods 1–14 regular, 15 the semifinal, 16 the two-week final (no period 17)
          const periods = Object.fromEntries(
            Object.entries(p.matchup_periods).filter(([k]) => Number(k) <= 14),
          );
          return {
            ...got,
            value: {
              ...got.value,
              playoffs: {
                ...p,
                team_count: 4,
                bye_seeds: 0,
                matchup_periods: { ...periods, "15": [15], "16": [16, 17] },
                playoff_weeks: [15, 16, 17],
              },
            },
          };
        },
      });
      const c = await connect(world, { options: { toolset: "full" }, services: s });
      const r = await call(c.client, "espn_analyze_matchup", {
        mode: "season",
        horizon: "through_playoffs",
        n_sims: 2000,
        seed: 1,
      });
      expect(r.isError, JSON.stringify(r.body).slice(0, 600)).toBe(false);
      expect((r.body.warnings as string[]).some((w) => w.includes("playoff rounds"))).toBe(false);
      const alive = (
        r.body.data as { readings: { p_alive_by_week: { week: number; p: number }[] }[] }
      ).readings[0]?.p_alive_by_week;
      const byWeek = new Map(alive?.map((x) => [x.week, x.p]));
      expect(byWeek.has(15)).toBe(true);
      expect(byWeek.has(16)).toBe(true);
      expect(byWeek.has(17)).toBe(true);
      // one round: alive in week 16 is alive in week 17
      expect(byWeek.get(17)).toBe(byWeek.get(16));
      await c.close();
    } finally {
      world.cleanup();
    }
  }, 120_000);
});
