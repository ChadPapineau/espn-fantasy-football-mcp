// matchup-tie.test.ts — Stage C finding matchup-tie-winner-null at the tools (plan 07 A3, E3;
// research 05 §2.4): a finished tie is a played game. ESPN's "TIE" read as null, so
// standingsFromMatchups put the tie in remaining[] — every season simulation (E2's PF exchange rate,
// E3, E6, E8, E9/E11) re-played it, a finished season kept "remaining" games, P(playoffs) of a
// decided season was not 0 or 1, and records derived from the schedule lost the tie — and
// espn_get_scoreboard could not report it (its output schema had no TIE). Held here on the recorded
// 2024 season of league-c (three regular-season ties) through the real provider in fixture mode,
// and at the tool over the recorded league with one week-2 game made a tie.
import { describe, expect, it } from "vitest";
import { simulateSeason } from "../../src/domain/analytics/seeding.js";
import { standingsFromMatchups } from "../../src/mcp/tools/analytics.js";
import { seasonInputs } from "../../src/mcp/tools/p1-common.js";
import { normalizeLeagueRules } from "../../src/providers/espn/normalize.js";
import { mSettingsSchema } from "../../src/providers/espn/views/index.js";
import type { FetchLike } from "../../src/providers/espn/index.js";
import { clockAndRng, instantPacer } from "../domain/analytics/helpers.js";
import { historyBody, historyFixtureFetch } from "../fixtures/helpers/history-fixtures.js";
import { makeWorld as makeProviderWorld } from "../providers/espn/helpers.js";
import { call, connect, makeWorld } from "./helpers/world.js";

/** League-c's finished 2024 season as the product reads it: provider (fixture mode), rules. */
async function season2024() {
  const w = makeProviderWorld({ fetch: historyFixtureFetch("league-c") });
  const ref = { ...w.ref, season: 2024 };
  const matchups = (await w.provider.getMatchups(ref)).value;
  const standings = (await w.provider.getStandings(ref)).value;
  const rules = normalizeLeagueRules(
    mSettingsSchema.parse(historyBody(2024, "league-c", "mSettings")),
  );
  return { matchups, standings, rules };
}

describe("a finished tie is a played game (Stage C finding matchup-tie-winner-null)", () => {
  it("standingsFromMatchups: nothing of the finished regular season remains; the ties are ties; the records equal ESPN's", async () => {
    const { matchups, standings, rules } = await season2024();
    const regular = rules.playoffs.regular_season_matchups;
    expect(regular).not.toBeNull();
    const d = standingsFromMatchups(matchups, regular, rules.playoffs.matchup_periods);
    expect(d.remaining).toEqual([]);
    const ties = d.played.filter((g) => g.home_points === g.away_points);
    expect(ties.map((g) => g.period)).toEqual([1, 3, 11]);
    for (const t of standings.teams) {
      const mine = d.teams.find((x) => x.team_id === t.team_id);
      expect(
        mine === undefined ? null : [mine.wins, mine.losses, mine.ties],
        `team ${String(t.team_id)}`,
      ).toEqual([t.wins, t.losses, t.ties]);
      expect(mine?.points_for ?? Number.NaN).toBeCloseTo(t.points_for, 2);
    }
    expect(d.teams.reduce((s, t) => s + t.ties, 0)).toBe(6);
  });

  it("after the regular season every team's P(playoffs) is exactly 0 or 1", async () => {
    const { matchups, standings, rules } = await season2024();
    const inputs = seasonInputs(matchups, standings, rules);
    expect(inputs.remaining).toEqual([]);
    const teamCount = rules.playoffs.team_count;
    if (teamCount === null) throw new Error("no playoff field recorded");
    for (const t of inputs.teams) {
      const { clock, rng } = clockAndRng();
      const out = await simulateSeason({
        ...inputs,
        me: t.team_id,
        playoff: {
          team_count: teamCount,
          seeding_rule: rules.playoffs.seeding_rule,
          reseed: rules.playoffs.reseed,
          rounds: [],
        },
        seeding_mode: "espn_rule",
        seeding_config: { mode: "espn_rule", confirmed_at: null },
        n_sims: 1000,
        marginal: false,
        clock,
        rng,
        pacer: instantPacer,
        deadline_ms: null,
      });
      const p = out.data.readings[0]?.p_playoffs;
      expect([0, 1], `team ${String(t.team_id)}: ${String(p)}`).toContain(p);
    }
  }, 60_000);
});

describe("A3 espn_get_scoreboard reports a finished tie as TIE", () => {
  /** The recorded mMatchup with the first week-2 game made a 100-100 tie. */
  const withTie =
    (inner: FetchLike): FetchLike =>
    async (url, init) => {
      const res = await inner(url, init);
      const views = new URL(url).searchParams.getAll("view");
      if (views.length !== 1 || views[0] !== "mMatchup" || res.status !== 200) return res;
      const b = (await res.json()) as {
        schedule: {
          matchupPeriodId: number;
          winner?: string;
          home: { totalPoints?: number; pointsByScoringPeriod?: Record<string, number> };
          away?: { totalPoints?: number; pointsByScoringPeriod?: Record<string, number> };
        }[];
      };
      const g = b.schedule.find((r) => r.matchupPeriodId === 2 && r.away !== undefined);
      if (g?.away === undefined) throw new Error("no week-2 game recorded");
      g.winner = "TIE";
      for (const s of [g.home, g.away]) {
        s.totalPoints = 100;
        s.pointsByScoringPeriod = { "2": 100 };
      }
      return new Response(JSON.stringify(b), {
        status: 200,
        headers: { "content-type": "application/json;charset=utf-8" },
      });
    };

  it("the tie is TIE with its points, inside the tool's output schema", async () => {
    const world = await makeWorld({ wrapFetch: withTie });
    const { client, close } = await connect(world);
    try {
      const r = await call(client, "espn_get_scoreboard", { week: 2, detail: "full" });
      expect(r.isError).toBe(false);
      const data = r.body.data as {
        matchups: {
          winner: string | null;
          home: { points: number };
          away: { points: number } | null;
        }[];
      };
      const ties = data.matchups.filter((m) => m.winner === "TIE");
      expect(ties).toHaveLength(1);
      expect([ties[0]?.home.points, ties[0]?.away?.points]).toEqual([100, 100]);
      expect(data.matchups.some((m) => m.winner === null)).toBe(false);
    } finally {
      await close();
      world.cleanup();
    }
  });
});
