// matchup-multiweek.test.ts — a later week of a multi-week matchup period says the score the period
// already holds, and its win chance is partial (plan 07 E2/E3: P(win) is the matchup's; research 05
// §2.3: read scheduleSettings.matchupPeriods, never assume a one-week matchup). Stage C finding
// matchup-multiweek-prior-points-ignored: in the second week of a two-week round E3 pre/live and E2
// projected week w alone and never read the period's earlier points (points_by_week), so leading or
// trailing by 70 gave the identical P(win), mode and coin flips, presented whole. The engines take no
// carried-points input yet (a need from the domain owner); until they do, each such answer names the
// period's score so far and is partial. Units over bankedPoints, then E3 pre/live and E2 on fx-10h in
// week 16 of a two-week semifinal, leading and trailing (fixture mode, no network).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { League, LeagueRules, Matchup, Stamped } from "../../src/providers/platform.js";
import { bankedPoints, bankedPointsWarning } from "../../src/mcp/tools/common.js";
import { faulty } from "./helpers/faults.js";
import { ESPN_FIXTURES, call, connect, makeWorld } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");

const RULES = {
  playoffs: {
    matchup_periods: { "14": [14], "15": [15, 16], "16": [17], "17": [20, 18, 19] },
  },
} as unknown as Pick<LeagueRules, "playoffs">;

const row = (
  period: number,
  home: number,
  away: number | null,
  byWeek: readonly [Record<string, number>, Record<string, number>] = [{}, {}],
): Matchup =>
  ({
    matchup_id: period * 100 + home,
    matchup_period: period,
    playoff_tier: "WINNERS_BRACKET",
    winner: "UNDECIDED",
    is_bye: away === null,
    home: { team_id: home, points: null, points_by_week: byWeek[0], is_mine: false },
    away:
      away === null
        ? null
        : { team_id: away, points: null, points_by_week: byWeek[1], is_mine: false },
  }) as unknown as Matchup;

describe("bankedPoints (Stage C matchup-multiweek-prior-points-ignored)", () => {
  const ms = [
    row(15, 2, 3, [{ "15": 150 }, { "15": 80 }]),
    row(15, 1, 4),
    row(17, 5, 6, [{ "18": 100, "19": 50.25 }, { "18": 90 }]),
    row(17, 7, null, [{ "18": 120 }, {}]),
  ];

  it("the second week of a two-week period: the first week's points, from either side", () => {
    expect(bankedPoints(ms, RULES, 16, 2)).toEqual({ period: 15, weeks: [15], me: 150, opp: 80 });
    expect(bankedPoints(ms, RULES, 16, 3)).toEqual({ period: 15, weeks: [15], me: 80, opp: 150 });
    // an earlier week not played yet holds 0–0 so far (the period is still more than week 16)
    expect(bankedPoints(ms, RULES, 16, 4)).toEqual({ period: 15, weeks: [15], me: 0, opp: 0 });
  });

  it("a three-week period sums every earlier week, whatever order ESPN lists them in", () => {
    expect(bankedPoints(ms, RULES, 20, 6)).toEqual({
      period: 17,
      weeks: [18, 19],
      me: 90,
      opp: 150.25,
    });
    expect(bankedPoints(ms, RULES, 19, 5)).toEqual({ period: 17, weeks: [18], me: 100, opp: 90 });
  });

  it("null: a period's first week, a one-week period, a bye, an unknown matchup or week", () => {
    expect(bankedPoints(ms, RULES, 15, 2)).toBeNull();
    expect(bankedPoints(ms, RULES, 17, 2)).toBeNull();
    expect(bankedPoints(ms, RULES, 19, 7)).toBeNull();
    expect(bankedPoints(ms, RULES, 16, 9)).toBeNull();
    expect(bankedPoints(ms, RULES, 12, 2)).toBeNull();
  });

  it("the warning names the period, its earlier weeks and the score so far", () => {
    expect(bankedPointsWarning({ period: 15, weeks: [15], me: 150.04, opp: 80 }, 16)).toBe(
      "partial: matchup period 15 also scores week 15 (150–80 so far): the win probability scores week 16 alone, not the period",
    );
    expect(bankedPointsWarning({ period: 17, weeks: [18, 19], me: 90, opp: 150.25 }, 20)).toBe(
      "partial: matchup period 17 also scores week 18, 19 (90–150.3 so far): the win probability scores week 20 alone, not the period",
    );
  });
});

describe("E3 and E2 in week 16 of a two-week semifinal (fx-10h)", () => {
  it("each answer names the period's score so far, leading or trailing, and is partial", async () => {
    const m = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
      my_team_id: number;
    };
    const me = m.my_team_id; // team 2
    const world = await makeWorld({
      env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: "full" },
      teamId: me,
      // the Tuesday of week 16: week 15 is played, the semifinal's second week to come
      clock: "2026-12-22T15:00:00.000Z",
    });
    // the owner's week-15 score in the semifinal against team 3 (mutated between the calls)
    let week15: readonly [number, number] = [150, 80];
    try {
      const s = faulty(world.services, {
        getLeagueRules: async (real, ...args) => {
          const got = (await real(...args)) as Stamped<LeagueRules>;
          const p = got.value.playoffs;
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
                matchup_periods: { ...periods, "15": [15, 16], "16": [17] },
                playoff_weeks: [15, 16, 17],
              },
            },
          };
        },
        getLeague: async (real, ...args) => {
          const got = (await real(...args)) as Stamped<League>;
          return {
            ...got,
            value: {
              ...got.value,
              clock: {
                ...got.value.clock,
                current_matchup_period: 15,
                current_scoring_period: 16,
                latest_scoring_period: 16,
              },
            },
          };
        },
        getMatchups: async (real, ...args) => {
          const got = (await real(...args)) as Stamped<readonly Matchup[]>;
          return {
            ...got,
            value: [
              ...got.value,
              row(15, me, 3, [{ "15": week15[0] }, { "15": week15[1] }]),
              row(15, 1, 4, [{ "15": 120 }, { "15": 110 }]),
            ],
          };
        },
        // fx-10h records rosters through week 5: week 16's are week 5's
        getRosters: (real, ref, week, opts) => real(ref, Math.min(Number(week), 5), opts),
        // past the recording: no box score points and no live numbers (a recorded read's stamp, no
        // rows — live then names its opponent from the season schedule)
        getBoxScores: async (real, ref, week, opts) =>
          Number(week) > 5
            ? { ...((await real(ref, 5, opts)) as Stamped<readonly unknown[]>), value: [] }
            : real(ref, week, opts),
        getLiveMatchups: async (real, ref, week, opts) =>
          Number(week) > 5
            ? { ...((await real(ref, 5, opts)) as Stamped<readonly unknown[]>), value: [] }
            : real(ref, week, opts),
      });
      const c = await connect(world, { options: { toolset: "full" }, services: s });
      try {
        for (const [lead, said] of [
          [[150, 80], "150–80"],
          [[80, 150], "80–150"],
        ] as const) {
          week15 = lead;
          const line = `partial: matchup period 15 also scores week 15 (${said} so far): the win probability scores week 16 alone, not the period`;
          for (const [name, args] of [
            ["espn_analyze_matchup", { mode: "pre", n_sims: 2000, seed: 1 }],
            ["espn_analyze_matchup", { mode: "live", n_sims: 2000, seed: 1 }],
            ["espn_analyze_lineup", { seed: 7 }],
          ] as const) {
            const r = await call(c.client, name, args);
            const label = `${name} ${JSON.stringify(args)} ${said}`;
            expect(r.isError, `${label}: ${JSON.stringify(r.body).slice(0, 400)}`).toBe(false);
            expect(r.body.warnings as string[], label).toContain(line);
            expect(r.body.partial, label).toBe(true);
          }
        }
        // control: the period's first week is the whole score so far — nothing to carry, not said
        const first = await call(c.client, "espn_analyze_matchup", {
          mode: "pre",
          week: 15,
          n_sims: 2000,
          seed: 1,
        });
        expect(first.isError, JSON.stringify(first.body).slice(0, 400)).toBe(false);
        expect(
          (first.body.warnings as string[]).filter((w) => w.includes("also scores week")),
        ).toEqual([]);
      } finally {
        await c.close();
      }
    } finally {
      world.cleanup();
    }
  }, 240_000);
});
