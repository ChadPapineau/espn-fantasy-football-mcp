// ros-window-wiring.test.ts — Stage C finding projection-ros-includes-week18, the wiring of every
// league-wide tool (research 04 §B.1.1; plan 07 E1, E4–E9, E11). ESPN's split (1,0) total counts the
// games not yet played through NFL week 18, so each tool must share it over the player's own window at
// the call's clock (common.ts rosReadingOf → rosOptsOf) — as E1 does. ros-window-tools.test.ts holds
// the helpers to E1's numbers under a reading the test builds itself; this file holds the TOOLS to
// pass the reading: a spy on weeklyValues (the one function every one of them prices a player week
// with) records every call each tool makes, and every call must carry the window (`ros_weeks`) and the
// schedule's last week. A tool whose reading reverted to null (the verifier's mutation of E5, E6 and
// E8: every other test still passed) answers with weeklyValues' default reading and fails here.
// Fixture world (league-a at T0, after week 4's games; `full`; nflverse published), no network.
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WeeklyValuesOpts } from "../../src/domain/analytics/waivers.js";
import { call, connect, makeWorld, type World } from "./helpers/world.js";

/** Every weeklyValues call since the last reset: its options argument (null when none was passed). */
const seen = vi.hoisted(() => ({ opts: [] as (WeeklyValuesOpts | null)[] }));

vi.mock("../../src/domain/analytics/waivers.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/domain/analytics/waivers.js")>();
  return {
    ...mod,
    weeklyValues: (...args: Parameters<typeof mod.weeklyValues>) => {
      seen.opts.push(args[4] ?? null);
      return mod.weeklyValues(...args);
    },
  };
});

let world: World;
let client: Client;
let close: () => Promise<void>;
let mine: { player_id: number; slot: string; position: string; gsis_id: string | null }[];
let rival: { player_id: number; slot: string }[];
let pooled: { player_id: number; position: string; gsis_id: string | null }[];

async function data(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await call(client, name, args);
  expect(r.isError, `${name}: ${JSON.stringify(r.body).slice(0, 400)}`).toBe(false);
  return r.body.data as Record<string, unknown>;
}

beforeAll(async () => {
  world = await makeWorld({ publishNflverse: true });
  ({ client, close } = await connect(world, { options: { toolset: "full" } }));
  await data("espn_get_league", {});
  mine = (await data("espn_get_roster", { week: 4 })).players as typeof mine;
  rival = (await data("espn_get_roster", { week: 4, team_id: 2 })).players as typeof rival;
  await data("espn_get_standings", {});
  pooled = (await data("espn_list_players", { status: "ONTEAM", limit: 100 }))
    .players as typeof pooled;
}, 180_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

/** The last week ESPN's total counts (research 04 §B.1.1): the 2026 schedule's week 18. */
const LAST_WEEK = 18;

/** Calls `tool` and returns the options of every weeklyValues call it made. */
async function optsOf(tool: string, args: Record<string, unknown>) {
  seen.opts.length = 0;
  await data(tool, args);
  return [...seen.opts];
}

describe("every league-wide tool shares ESPN's ROS total over the player's window", () => {
  const cases: readonly (readonly [string, string, () => Record<string, unknown>])[] = [
    ["E4", "espn_analyze_replacement", () => ({ horizon: "ros" })],
    ["E5 priority", "espn_analyze_waivers", () => ({})],
    ["E5 espn_ros", "espn_analyze_waivers", () => ({ value_source: "espn_ros" })],
    [
      "E6 offer",
      "espn_analyze_trade",
      () => ({
        offer: {
          partner_team_id: 2,
          give: mine
            .filter((p) => p.slot !== "IR")
            .slice(0, 1)
            .map((p) => p.player_id),
          get: rival
            .filter((p) => p.slot !== "IR")
            .slice(0, 1)
            .map((p) => p.player_id),
        },
        seed: 4,
      }),
    ],
    [
      "E6 partners",
      "espn_analyze_trade",
      () => ({ find_partners: { need_position: "RB", max_partners: 1 }, seed: 4 }),
    ],
    [
      "E7",
      "espn_analyze_injury_cascade",
      () => ({
        // a crosswalked RB (E7 reads his usage through the gsis id)
        player: {
          player_ids: [
            (pooled.find((p) => p.position === "RB" && p.gsis_id !== null) ?? pooled[0])
              ?.player_id ?? 0,
          ],
        },
      }),
    ],
    ["E8", "espn_analyze_schedule", () => ({ seed: 2 })],
    ["E9", "espn_analyze_roster", () => ({ seed: 2 })],
    ["E11", "espn_analyze_league_activity", () => ({})],
  ];

  for (const [label, tool, args] of cases)
    it(`${label} (${tool}): every weekly value carries the window and week ${String(LAST_WEEK)}`, async () => {
      const opts = await optsOf(tool, args());
      expect(opts.length, `${label} priced no player week`).toBeGreaterThan(0);
      const without = opts.filter(
        (o) => o === null || !Array.isArray(o.ros_weeks) || o.ros_last_week !== LAST_WEEK,
      );
      expect(without.length, `${label}: ${String(without.length)} of ${String(opts.length)}`).toBe(
        0,
      );
    }, 240_000);
});
