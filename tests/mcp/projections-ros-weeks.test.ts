// projections-ros-weeks.test.ts — C3 espn_get_projections' `ros.weeks_remaining` (plan 07 C3) is the
// number of games ESPN's rest-of-season total covers: the total is as of the clock and runs through
// NFL week 18, byes out (research 04 §B.1.1; constants.ts NFL_REGULAR_SEASON, ESPN_ROS), so the count
// is ESPN's own (stat 210 of the split) when it carries one, else E1's reading of the pro schedule at
// the clock (common.ts rosGamesCovered), and it never moves with the `week` argument. Stage C finding
// projections-ros-weeks-remaining-mismatch: it was final_scoring_period − week + 1 — 13 at week 5, 2
// at week 16, 1 at week 17 beside the same total — so points / weeks_remaining read about twice the
// true per-game value late in the season. fx-10h at its own clock (Wednesday of week 5) under
// EFF_TOOLSET=full; fixture mode, no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NativeProjection } from "../../src/domain/league/types.js";
import { faulty } from "./helpers/faults.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
/** A QB and an RB of the fx-10h pool: ESPN's ROS split counts 13 games for each (weeks 5–18, bye out). */
const PLAYERS = [4431452, 4379399];
/** A D/ST of the pool: its total is a full-season figure (17 games). */
const DST = -16034;

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
    publishEspn: true,
  });
  ({ client, close } = await connect(world, { options: { toolset: "full" } }));
  await call(client, "espn_get_league");
}, 120_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

interface Row {
  player_id: number;
  ros: { points: number; weeks_remaining: number } | null;
}

async function ros(c: Client, ids: readonly number[], week?: number): Promise<Row[]> {
  const r = await call(c, "espn_get_projections", {
    players: { player_ids: ids },
    horizon: "ros",
    ...(week === undefined ? {} : { week }),
  });
  expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
  return (r.body.data as { projections: Row[] }).projections;
}

describe("C3 ros.weeks_remaining: the games ESPN's total covers (Stage C projections-ros-weeks-remaining-mismatch)", () => {
  it("ESPN's own count, the same at weeks 5, 16 and 17 (the total does not move with `week`)", async () => {
    const at5 = await ros(client, PLAYERS, 5);
    const at16 = await ros(client, PLAYERS, 16);
    const at17 = await ros(client, PLAYERS, 17);
    const atDefault = await ros(client, PLAYERS);
    for (const id of PLAYERS) {
      const x = at5.find((p) => p.player_id === id)?.ros;
      expect(x?.weeks_remaining, String(id)).toBe(13);
      for (const other of [at16, at17, atDefault]) {
        const y = other.find((p) => p.player_id === id)?.ros;
        expect(y).toEqual(x); // the same points AND the same games
      }
    }
  });

  it("a D/ST's total is a full-season figure: its 17 games", async () => {
    const [row] = await ros(client, [DST], 16);
    expect(row?.ros?.weeks_remaining).toBe(17);
  });

  it("without ESPN's count, the pro schedule at the clock gives the same games (week 18 in, the bye out)", async () => {
    const s = faulty(world.services, {
      getNativeProjections: async (real, ...args) => {
        const got = (await real(...args)) as { value: NativeProjection[] };
        return {
          ...got,
          value: got.value.map((n) => {
            const { "210": _gp, ...raw } = n.raw;
            return { ...n, raw };
          }),
        };
      },
    });
    const c = await connect(world, { options: { toolset: "full" }, services: s });
    try {
      for (const week of [5, 17]) {
        const rows = await ros(c.client, PLAYERS, week);
        for (const id of PLAYERS)
          expect(rows.find((p) => p.player_id === id)?.ros?.weeks_remaining, String(id)).toBe(13);
      }
    } finally {
      await c.close();
    }
  });
});
