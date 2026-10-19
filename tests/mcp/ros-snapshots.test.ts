// ros-snapshots.test.ts — espn_get_projections reads its ROS snapshots (plan 07 C3: `revised_recently`;
// degradation "drift → the last espn_projection snapshot with stale"; C3 "exists for ROS batches").
// Stage C finding projections-ros-snapshots-unread: `eff snapshot projections` stores the ros split
// with week null (week_key −1) and the tool read snapshots only at week `w`, so a ROS projection never
// read as revised however far ESPN moved it, and on an outage no ROS snapshot was served although the
// store held them (the weekly horizon worked). Through the REAL store (the existing tests mocked
// asOf); fixture mode on league-a under EFF_TOOLSET=full; no network.
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SNAPSHOT_NO_WEEK } from "../../src/mcp/tools/espn-p1.js";
import { coded, faulty } from "./helpers/faults.js";
import { SEASON, T0, call, connect, makeWorld, type World } from "./helpers/world.js";

let world: World;
let client: Client;
let close: () => Promise<void>;
const DAY = 24 * 3600 * 1000;

type J = Record<string, unknown>;
interface Row {
  player_id: number;
  week: { points: number } | null;
  ros: { points: number } | null;
  revised_recently: boolean;
}
const rows = (b: J): Row[] => (b.data as { projections: Row[] }).projections;

let ids: number[] = [];
const TEAM = { team_id: 1 };

beforeAll(async () => {
  world = await makeWorld({ league: "league-a", env: { EFF_TOOLSET: "full" } });
  ({ client, close } = await connect(world, { options: { toolset: "full" } }));
  await call(client, "espn_get_league");
  // ESPN's current numbers for my team, then snapshots taken three days ago as projectionRows writes
  // them: the weekly split 5 points lower (week 4), the ROS split 15 points lower (week null)
  const wk = rows(
    (await call(client, "espn_get_projections", { players: TEAM, horizon: "week", week: 4 })).body,
  );
  const ros = rows(
    (await call(client, "espn_get_projections", { players: TEAM, horizon: "ros", week: 4 })).body,
  );
  ids = ros
    .filter((r) => r.ros !== null && wk.find((x) => x.player_id === r.player_id)?.week !== null)
    .map((r) => r.player_id)
    .slice(0, 2);
  expect(ids).toHaveLength(2);
  const at = new Date(Date.parse(T0) - 3 * DAY).toISOString();
  world.store.repos.espnProjections.putMany(
    ids.flatMap((id) => [
      {
        player_id: id,
        season: SEASON,
        week: 4,
        split: "weekly" as const,
        applied_total: (wk.find((r) => r.player_id === id)?.week?.points ?? 20) - 5,
        stats_raw: {},
        snapshot_at: at,
      },
      {
        player_id: id,
        season: SEASON,
        week: null,
        split: "ros" as const,
        applied_total: (ros.find((r) => r.player_id === id)?.ros?.points ?? 150) - 15,
        stats_raw: {},
        snapshot_at: at,
      },
    ]),
  );
}, 120_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

describe("C3 reads its ROS snapshots (Stage C projections-ros-snapshots-unread)", () => {
  it("the store files a week-less split under SNAPSHOT_NO_WEEK", () => {
    const got = world.store.repos.espnProjections.asOf(SEASON, SNAPSHOT_NO_WEEK, T0);
    expect(
      got
        .filter((s) => s.split === "ros")
        .map((s) => s.player_id)
        .sort(),
    ).toEqual([...ids].sort());
  });

  it("a ROS projection ESPN revised by 15 reads revised_recently, as the weekly one does", async () => {
    for (const horizon of ["week", "ros"] as const) {
      const r = await call(client, "espn_get_projections", {
        players: { player_ids: ids },
        horizon,
        week: 4,
      });
      expect(r.isError).toBe(false);
      expect(
        rows(r.body).map((x) => x.revised_recently),
        horizon,
      ).toEqual([true, true]);
    }
  });

  it("on an outage the ROS snapshot is served stale (as the weekly one is)", async () => {
    const s = faulty(world.services, {
      getNativeProjections: coded("ESPN_UPSTREAM_UNAVAILABLE", { view: "kona_player_info" }),
    });
    const c = await connect(world, { options: { toolset: "full" }, services: s });
    try {
      for (const horizon of ["week", "ros"] as const) {
        const r = await call(c.client, "espn_get_projections", {
          players: { player_ids: ids },
          horizon,
          week: 4,
        });
        expect(r.isError).toBe(false);
        const got = rows(r.body);
        const served = got.filter((x) => (horizon === "week" ? x.week : x.ros) !== null);
        expect(served.map((x) => x.player_id).sort(), horizon).toEqual([...ids].sort());
        expect((r.body.meta as { freshness: string }).freshness).toBe("stale");
        expect(r.body.warnings as string[]).not.toContain(
          "2 player(s) carry no ESPN projection here",
        );
      }
    } finally {
      await c.close();
    }
  });
});
