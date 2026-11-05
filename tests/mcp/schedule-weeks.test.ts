// schedule-weeks.test.ts — espn_analyze_schedule never analyses a week after the league's final
// scoring period (plan 07 E8: importance(w) = P(alive at w), 0 after the championship week). Stage C
// finding schedule-weeks-past-final-weighted: explicit weeks were filtered only for include_playoffs,
// and a week with no simulated P(alive) defaulted to 1, so week 18 of a 17-period league came back
// {p_alive: 1, importance: 1} with lineup points and holes, unflagged — while
// espn_analyze_replacement refuses the same week (VALIDATION season_over). Fixture mode on fx-10h
// (final_scoring_period 17, playoff weeks 15–17) under EFF_TOOLSET=full; no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
let world: World;
let client: Client;
let close: () => Promise<void>;

beforeAll(async () => {
  const m = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
    clock: string;
    my_team_id: number;
  };
  world = await makeWorld({
    env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: "full" },
    teamId: m.my_team_id,
    clock: m.clock,
  });
  ({ client, close } = await connect(world, { options: { toolset: "full" } }));
  await call(client, "espn_get_league");
}, 120_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

interface Week {
  week: number;
  p_alive: number;
  importance: number;
}

describe("weeks past the final scoring period (Stage C schedule-weeks-past-final-weighted)", () => {
  it("weeks [16, 17, 18]: week 18 is dropped and said, 16 and 17 analysed", async () => {
    const r = await call(client, "espn_analyze_schedule", { seed: 7, weeks: [16, 17, 18] });
    expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
    const weeks = (r.body.data as { weeks: Week[] }).weeks.map((w) => w.week);
    expect(weeks).not.toContain(18);
    expect(weeks).toEqual(expect.arrayContaining([16, 17]));
    expect(r.body.warnings as string[]).toContain(
      "week(s) 18 dropped: after the league's final scoring period (17)",
    );
  }, 60_000);

  it("only weeks past the final one: VALIDATION season_over, as espn_analyze_replacement answers", async () => {
    const r = await call(client, "espn_analyze_schedule", { seed: 7, weeks: [18] });
    expect(r.isError).toBe(true);
    expect((r.body as { error: Record<string, unknown> }).error).toMatchObject({
      code: "VALIDATION",
      field: "weeks",
      reason: "season_over",
    });
  }, 60_000);
});

// The round-4b review's F3 at the tool: on base--full with seed 7, week 11's row (its holes and
// bye_cluster_cost) changed with the other weeks asked for — [11] gave cost 0, [7, 11] 6.71, [11, 12]
// 4.01. Every week is now projected from the current one and valued against the whole rest-of-season
// projection, so the row is the same in every window; a week already behind the current one is
// dropped and said.
describe("F3: a week's row is the same whatever other weeks are requested", () => {
  type Row = Week & { holes: unknown[]; bye_cluster_cost: number; lineup_pts: unknown };
  const rowOf = async (weeks: number[], w: number): Promise<Row | undefined> => {
    const r = await call(client, "espn_analyze_schedule", { seed: 7, weeks });
    expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
    return (r.body.data as { weeks: Row[] }).weeks.find((x) => x.week === w);
  };

  it("week 11 in [11], [7, 11], [11, 12] and [11, 13, 15]: one row", async () => {
    const alone = await rowOf([11], 11);
    expect(alone).toBeDefined();
    for (const weeks of [
      [7, 11],
      [11, 12],
      [11, 13, 15],
    ])
      expect(await rowOf(weeks, 11), JSON.stringify(weeks)).toEqual(alone);
  }, 120_000);

  it("week 7 in [7], [7, 11, 13] and [6, 7, 8]: one row", async () => {
    const alone = await rowOf([7], 7);
    for (const weeks of [
      [7, 11, 13],
      [6, 7, 8],
    ])
      expect(await rowOf(weeks, 7), JSON.stringify(weeks)).toEqual(alone);
  }, 120_000);

  it("a week before the current one is dropped and said; only such weeks: VALIDATION before_current_week", async () => {
    const r = await call(client, "espn_analyze_schedule", { seed: 7, weeks: [3, 11] });
    expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
    expect((r.body.data as { weeks: Week[] }).weeks.map((w) => w.week)).toEqual([11]);
    expect(r.body.warnings as string[]).toContain("week(s) 3 dropped: before the current week (5)");
    const only = await call(client, "espn_analyze_schedule", { seed: 7, weeks: [2, 3] });
    expect(only.isError).toBe(true);
    expect((only.body as { error: Record<string, unknown> }).error).toMatchObject({
      code: "VALIDATION",
      field: "weeks",
      reason: "before_current_week",
    });
  }, 120_000);
});
