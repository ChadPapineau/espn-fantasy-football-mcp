// season-fit-weeks.test.ts — E3 espn_analyze_matchup(mode: season) fits each team's weekly model
// from its E1 lineup projection over EVERY week the simulation plays (plan 07 E3 "each team's weekly
// distribution from E1"; seasonFit.ts projectionModel: "its E1 lineup projection for the remaining
// weeks"), byes and short absences in the weeks they happen. Stage C finding
// season-fit-prior-one-week: the tool passed one team-week — the current week's — as every team's
// prior for the whole season, so a bye-heavy current week set a team's strength to the end (the
// finder's repro: P(playoffs) 0.55 → 0.19 from one week with three starters on bye). A spy on the
// fitted simulator records the projections the tool hands it; fx-10h (clock: Wednesday of week 5;
// 14 regular-season matchups, playoffs 15–17) under EFF_TOOLSET=full; fixture mode, no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TeamWeekProjection } from "../../src/domain/analytics/seasonRoster.js";
import type { ProSchedule, Stamped } from "../../src/providers/platform.js";
import { seasonFitWeeks } from "../../src/mcp/tools/analytics-p1.js";
import { faulty } from "./helpers/faults.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

/** The projections of every fitted simulation since the last reset. */
const seen = vi.hoisted(() => ({
  runs: [] as ReadonlyMap<number, readonly TeamWeekProjection[]>[],
}));

vi.mock("../../src/domain/analytics/seasonRoster.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/domain/analytics/seasonRoster.js")>();
  return {
    ...mod,
    simulateFittedSeason: (...args: Parameters<typeof mod.simulateFittedSeason>) => {
      seen.runs.push(args[0].projections);
      return mod.simulateFittedSeason(...args);
    },
  };
});

const FX = path.join(ESPN_FIXTURES, "fx-10h");
const REGULAR_FROM_5 = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

let world: World;
let client: Client;
let close: () => Promise<void>;
let me: number;

beforeAll(async () => {
  const m = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
    clock: string;
    my_team_id: number;
  };
  me = m.my_team_id;
  world = await makeWorld({
    env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: "full" },
    teamId: m.my_team_id,
    clock: m.clock,
    publishEspn: false,
  });
  ({ client, close } = await connect(world, { options: { toolset: "full" } }));
  await call(client, "espn_get_league");
  await call(client, "espn_get_standings");
}, 120_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

interface Season {
  weekly_model: string;
  readings: { p_playoffs: number }[];
}

async function season(
  c: Client,
  args: Record<string, unknown> = {},
): Promise<{ data: Season; projections: ReadonlyMap<number, readonly TeamWeekProjection[]> }> {
  seen.runs.length = 0;
  const r = await call(c, "espn_analyze_matchup", {
    mode: "season",
    n_sims: 4000,
    seed: 2026,
    ...args,
  });
  expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
  expect(seen.runs).toHaveLength(1);
  const projections = seen.runs[0];
  if (projections === undefined) throw new Error("no fitted run");
  return { data: r.body.data as Season, projections };
}

const meanMu = (ws: readonly TeamWeekProjection[]) =>
  ws.reduce((s, w) => s + w.mu, 0) / Math.max(1, ws.length);

describe("E3 season: each team's prior covers every simulated week (Stage C season-fit-prior-one-week)", () => {
  it("seasonFitWeeks: the regular season from this week, the playoffs too through them, else this week", async () => {
    const lg = await call(client, "espn_get_league", { include: ["rules"] });
    const rules = (lg.body.data as { rules: Parameters<typeof seasonFitWeeks>[0] }).rules;
    expect(seasonFitWeeks(rules, 5, false)).toEqual(REGULAR_FROM_5);
    expect(seasonFitWeeks(rules, 5, true)).toEqual([...REGULAR_FROM_5, 15, 16, 17]);
    expect(seasonFitWeeks(rules, 14, false)).toEqual([14]);
    // a playoff week under the regular horizon: this week alone (nothing regular is left)
    expect(seasonFitWeeks(rules, 16, false)).toEqual([16]);
    expect(seasonFitWeeks(rules, 16, true)).toEqual([16, 17]);
  });

  it("every team is fitted on weeks 5–14 — one team-week each — never on week 5 alone", async () => {
    const { data, projections } = await season(client);
    expect(data.weekly_model).toBe("e1_fitted");
    expect(projections.size).toBe(10);
    for (const [team, weeks] of projections)
      expect(
        weeks.map((w) => w.week),
        `team ${String(team)}`,
      ).toEqual(REGULAR_FROM_5);
    // the byes of weeks 5–14 move the weekly lineups: no team's ten weeks are all one number
    for (const weeks of projections.values())
      expect(new Set(weeks.map((w) => Math.round(w.mu * 1000))).size).toBeGreaterThan(1);
  }, 120_000);

  it("through the playoffs the playoff weeks are fitted too", async () => {
    const { projections } = await season(client, { horizon: "through_playoffs" });
    for (const weeks of projections.values())
      expect(weeks.map((w) => w.week)).toEqual([...REGULAR_FROM_5, 15, 16, 17]);
  }, 120_000);

  it("a bye-heavy current week moves only its own week: the season prior barely moves", async () => {
    const base = await season(client);
    // three of my starters' NFL teams lose their week-5 games: on bye this week only
    const roster = await call(client, "espn_get_roster", { week: 5 });
    const starters = (
      roster.body.data as {
        players: { slot_class: string; position: string; pro_team: string | null }[];
      }
    ).players.filter((p) => p.slot_class !== "bench" && p.slot_class !== "ir");
    const teams = [
      ...new Set(
        starters.filter((p) => p.position !== "D/ST" && p.pro_team !== null).map((p) => p.pro_team),
      ),
    ].slice(0, 3);
    expect(teams).toHaveLength(3);
    const s = faulty(world.services, {
      getProSchedule: async (real, ...args) => {
        const got = (await real(...args)) as Stamped<ProSchedule>;
        const ids = new Set(
          got.value.teams.filter((t) => teams.includes(t.abbrev)).map((t) => t.id),
        );
        return {
          ...got,
          value: {
            ...got.value,
            games: got.value.games.filter(
              (g) => g.week !== 5 || (!ids.has(g.home_pro_team_id) && !ids.has(g.away_pro_team_id)),
            ),
          },
        };
      },
    });
    const c = await connect(world, { options: { toolset: "full" }, services: s });
    try {
      const byes = await season(c.client);
      const was = base.projections.get(me) ?? [];
      const now = byes.projections.get(me) ?? [];
      expect(now.map((w) => w.week)).toEqual(REGULAR_FROM_5);
      // week 5 drops (three starters on bye) …
      const drop = (was[0]?.mu ?? 0) - (now[0]?.mu ?? 0);
      expect(drop).toBeGreaterThan(10);
      // … but the season prior moves by a fraction of it: the other nine weeks are full lineups
      // (with the one-week prior it moved by all of it)
      expect(meanMu(was) - meanMu(now)).toBeLessThan(drop / 3);
      // and P(playoffs) keeps most of its level (the one-week prior took it far down)
      const p0 = base.data.readings[0]?.p_playoffs ?? 0;
      const p1 = byes.data.readings[0]?.p_playoffs ?? 0;
      expect(p0 - p1).toBeLessThan(0.1);
    } finally {
      await c.close();
    }
  }, 120_000);
});
