// offseason-clock.test.ts — espn_get_league's clock after the season describes the league's last
// scored week (plan 07 A1 `current_week_final`, `corrections_window_open`). Stage C finding
// league-offseason-clock-not-final: after the season ESPN serves scoringPeriodId 19 with
// finalScoringPeriod 17 (every recorded finished season); A1 judged week 19, which has no games, so
// from January to August the model was told the current week is not final and stats may still be
// corrected. Fixture mode on fx-10h; the clock and schedule as ESPN serves them in March.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { weekOf } from "../../src/mcp/tools/common.js";
import { clockWeek } from "../../src/mcp/tools/league.js";
import type { League, ProSchedule, Stamped } from "../../src/providers/platform.js";
import { faulty } from "./helpers/faults.js";
import { ESPN_FIXTURES, call, connect, makeWorld } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
const WEEK_MS = 7 * 24 * 3600 * 1000;
/** The 2026 season's first Sunday, 13:00 ET. */
const SEASON_SUNDAY_1 = Date.parse("2026-09-13T17:00:00.000Z");

describe("the off-season clock (Stage C league-offseason-clock-not-final)", () => {
  it("clockWeek: the current period in season, the final one once ESPN's clock runs past it", () => {
    expect(clockWeek({ current_scoring_period: 5, final_scoring_period: 17 })).toBe(5);
    expect(clockWeek({ current_scoring_period: 17, final_scoring_period: 17 })).toBe(17);
    expect(clockWeek({ current_scoring_period: 19, final_scoring_period: 17 })).toBe(17);
    expect(clockWeek({ current_scoring_period: 0, final_scoring_period: 17 })).toBe(0);
    // an unknown final period (0) never redirects
    expect(clockWeek({ current_scoring_period: 3, final_scoring_period: 0 })).toBe(3);
  });

  it("in March: current_week_final true and corrections_window_open false", async () => {
    const m = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
      my_team_id: number;
    };
    const world = await makeWorld({
      env: { EFF_FIXTURE_DIR: FX },
      teamId: m.my_team_id,
      clock: "2027-03-15T15:00:00.000Z",
      publishEspn: false,
    });
    try {
      const s = faulty(world.services, {
        // ESPN's clock after the season: period 19 of a 17-period league
        getLeague: async (real, ...args) => {
          const got = (await real(...args)) as Stamped<League>;
          return {
            ...got,
            value: {
              ...got.value,
              clock: {
                ...got.value.clock,
                current_matchup_period: 17,
                current_scoring_period: 19,
                latest_scoring_period: 19,
              },
            },
          };
        },
        // by March every game of the season has been played at a known time and is official
        getProSchedule: async (real, ...args) => {
          const got = (await real(...args)) as Stamped<ProSchedule>;
          return {
            ...got,
            value: {
              ...got.value,
              games: got.value.games.map((g) => ({
                ...g,
                stats_official: true,
                start_time_tbd: false,
                // the October recording still has some kickoffs TBD: a Sunday slot of that week
                kickoff:
                  g.kickoff ?? new Date(SEASON_SUNDAY_1 + (g.week - 1) * WEEK_MS).toISOString(),
              })),
            },
          };
        },
      });
      const c = await connect(world, { services: s });
      const r = await call(c.client, "espn_get_league", {});
      expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
      const clock = (r.body.data as { clock: Record<string, unknown> }).clock;
      expect(clock).toMatchObject({
        current_scoring_period: 19,
        final_scoring_period: 17,
        current_week_final: true,
        corrections_window_open: false,
      });
      await c.close();
    } finally {
      world.cleanup();
    }
  }, 60_000);
});

describe("after the season every default week is the league's final scoring period (Stage C league-postseason-default-week-18)", () => {
  // weekOf clamped ESPN's post-season period (18 during NFL week 18, 19 from then to August) to 18:
  // a week the league does not play, so the retrospective reviewed week 18 (no matchup, no calls),
  // the roster, the schedule and E2 answered for week 18 and E3 `pre` found no opponent; and A1 said
  // current_scoring_period 19 beside current_week_final true without naming the week it described
  it("weekOf follows clockWeek, then the tools' 1..18", () => {
    const lg = (cur: number, fin: number) =>
      ({ clock: { current_scoring_period: cur, final_scoring_period: fin } }) as unknown as League;
    expect(weekOf(lg(19, 17), undefined)).toBe(17);
    expect(weekOf(lg(18, 17), undefined)).toBe(17);
    expect(weekOf(lg(17, 17), undefined)).toBe(17);
    expect(weekOf(lg(5, 17), undefined)).toBe(5);
    expect(weekOf(lg(0, 17), undefined)).toBe(1);
    // a league that plays week 18 keeps it; an unknown final period clamps as before
    expect(weekOf(lg(19, 18), undefined)).toBe(18);
    expect(weekOf(lg(19, 0), undefined)).toBe(18);
    // an explicit week is the caller's
    expect(weekOf(lg(19, 17), 18)).toBe(18);
  });

  it.each([
    ["in March (period 19)", "2027-03-15T15:00:00.000Z", 19],
    ["during NFL week 18 (period 18)", "2027-01-07T15:00:00.000Z", 18],
  ])(
    "%s: A1, G1, the roster, the schedule, E2 and the retrospective all mean week 17",
    async (_, at, period) => {
      const m = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
        my_team_id: number;
      };
      const world = await makeWorld({
        env: { EFF_FIXTURE_DIR: FX },
        teamId: m.my_team_id,
        clock: at,
        publishEspn: false,
      });
      /** The weeks the tools asked the platform's rosters for. */
      const asked: number[] = [];
      try {
        const s = faulty(world.services, {
          getLeague: async (real, ...args) => {
            const got = (await real(...args)) as Stamped<League>;
            return {
              ...got,
              value: {
                ...got.value,
                clock: {
                  ...got.value.clock,
                  current_matchup_period: 17,
                  current_scoring_period: period,
                  latest_scoring_period: period,
                },
              },
            };
          },
          getProSchedule: async (real, ...args) => {
            const got = (await real(...args)) as Stamped<ProSchedule>;
            return {
              ...got,
              value: {
                ...got.value,
                games: got.value.games.map((g) => ({
                  ...g,
                  stats_official: true,
                  start_time_tbd: false,
                  kickoff:
                    g.kickoff ?? new Date(SEASON_SUNDAY_1 + (g.week - 1) * WEEK_MS).toISOString(),
                })),
              },
            };
          },
          // the October recording has no box score past week 5: a later week reads as no games
          getBoxScores: async (real, ...args) => {
            const week = args[1] as number;
            if (week <= 5) return real(...args);
            const got = (await real(args[0], 3, ...args.slice(2))) as Stamped<unknown[]>;
            return { ...got, value: [] };
          },
          // nor a roster past week 5: the week asked for is recorded, the week-5 rosters answer
          getRosters: async (real, ...args) => {
            const week = args[1] as number;
            asked.push(week);
            return real(args[0], Math.min(week, 5), ...args.slice(2));
          },
        });
        const c = await connect(world, { services: s });
        try {
          const league = await call(c.client, "espn_get_league", {});
          expect(league.isError, JSON.stringify(league.body).slice(0, 300)).toBe(false);
          expect((league.body.data as { clock: Record<string, unknown> }).clock).toMatchObject({
            current_scoring_period: period,
            final_scoring_period: 17,
            current_week: 17,
            current_week_final: true,
          });
          const status = await call(c.client, "espn_get_status", {});
          expect(
            (status.body.data as { league: { current_week: number } }).league.current_week,
          ).toBe(17);
          const roster = await call(c.client, "espn_get_roster", {});
          expect(roster.isError, JSON.stringify(roster.body).slice(0, 300)).toBe(false);
          expect((roster.body.data as { week: number }).week).toBe(17);
          const sched = await call(c.client, "espn_get_schedule", {});
          expect(sched.isError, JSON.stringify(sched.body).slice(0, 300)).toBe(false);
          const sd = sched.body.data as {
            games: { week: number }[];
            byes: Record<string, unknown>;
          };
          expect(Object.keys(sd.byes)).toEqual(["17"]);
          expect(sd.games.every((g) => g.week === 17)).toBe(true);
          const retro = await call(c.client, "espn_analyze_retrospective", {});
          expect(retro.isError, JSON.stringify(retro.body).slice(0, 300)).toBe(false);
          expect((retro.body.data as { week: number }).week).toBe(17);
          asked.length = 0;
          const lineup = await call(c.client, "espn_analyze_lineup", {});
          expect(lineup.isError, JSON.stringify(lineup.body).slice(0, 300)).toBe(false);
          expect(asked.length).toBeGreaterThan(0);
          expect(new Set(asked)).toEqual(new Set([17]));
        } finally {
          await c.close();
        }
      } finally {
        world.cleanup();
      }
    },
    120_000,
  );
});
