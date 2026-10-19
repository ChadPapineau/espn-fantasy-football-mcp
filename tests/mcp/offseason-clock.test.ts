// offseason-clock.test.ts — espn_get_league's clock after the season describes the league's last
// scored week (plan 07 A1 `current_week_final`, `corrections_window_open`). Stage C finding
// league-offseason-clock-not-final: after the season ESPN serves scoringPeriodId 19 with
// finalScoringPeriod 17 (every recorded finished season); A1 judged week 19, which has no games, so
// from January to August the model was told the current week is not final and stats may still be
// corrected. Fixture mode on fx-10h; the clock and schedule as ESPN serves them in March.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
