// crosswalk-rejected.test.ts — Stage C finding crosswalk-rejected-pair-persists at the tool level
// (repro (b)): a stored pair the rebuild refutes leaves the store, so espn_get_roster's crosswalk block
// (plan 07 C1), espn_get_player_usage's gsis join (D1) and espn_get_status's counts (G1) agree with
// the run's alert (plan 06 §1.3; research 04 §C step 5). The fixture world (league-a, `full`, the
// nflverse excerpts published through the real runner and the real crosswalk rebuild); the stale row
// is planted the way an earlier rebuild would have written it.
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHECKED_IN_OVERRIDES } from "../../src/domain/crosswalk/overrides.js";
import { rebuildCrosswalk } from "../../src/domain/crosswalk/rebuild.js";
import { call, connect, makeWorld, type World } from "./helpers/world.js";

let world: World;
let client: Client;
let close: () => Promise<void>;

interface RosterRow {
  readonly player_id: number;
  readonly position: string;
  readonly gsis_id: string | null;
  readonly crosswalk: { readonly method: string; readonly confidence: number };
}
interface UsageRow {
  readonly player_id: number;
  readonly gsis_id: string | null;
  readonly trailing: { readonly window_games: number; readonly target_share: number | null };
}

async function data(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await call(client, name, args);
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body.data as Record<string, unknown>;
}

const roster = async (): Promise<RosterRow[]> =>
  (await data("espn_get_roster", { week: 4 })).players as RosterRow[];
const usage = async (): Promise<UsageRow[]> =>
  (await data("espn_get_player_usage", { players: { team_id: 1 } })).players as UsageRow[];
const unmatchedRostered = async (): Promise<number> =>
  ((await data("espn_get_status", {})).crosswalk as { unmatched_rostered: number })
    .unmatched_rostered;

function rebuild() {
  const r = rebuildCrosswalk({
    season: world.config.season,
    roster: world.store.rosterWeekly,
    universe: world.store.playerUniverse,
    nflPlayers: world.store.nflPlayers,
    repository: world.store.repos.crosswalk,
    overrides: CHECKED_IN_OVERRIDES,
    now: world.clock.nowIso(),
    rostered: new Set(),
  });
  if (r.status !== "done") throw new Error(`rebuild skipped: ${r.reason}`);
  return r;
}

beforeAll(async () => {
  world = await makeWorld({ publishNflverse: true });
  ({ client, close } = await connect(world, { options: { toolset: "full" } }));
  await data("espn_get_league", {});
}, 180_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

describe("a pair the rebuild rejects stops reaching the tools", () => {
  it("repro (b): a refuted name match is removed; roster, usage and status say no pair", async () => {
    const universe = new Set(
      world.store.playerUniverse.all(world.config.season).rows.map((p) => p.espn_id),
    );
    const before = await roster();
    const lined = await usage();
    // an unpaired skill player the universe knows, and a paired one whose usage rows exist
    const victim = before.find(
      (p) =>
        p.player_id > 0 &&
        p.gsis_id === null &&
        ["RB", "WR", "TE"].includes(p.position) &&
        universe.has(p.player_id),
    );
    const donor = lined.find((u) => u.gsis_id !== null && u.trailing.window_games > 0);
    if (victim === undefined || donor?.gsis_id == null)
      throw new Error("the fixture world lacks an unpaired rostered player or a lined one");
    const statusBefore = await unmatchedRostered();

    // the row an earlier rebuild wrote: a name match to the donor's gsis id, which nflverse gives the
    // donor's ESPN id — the next rebuild refutes it (persisted_id_conflict)
    world.store.repos.crosswalk.upsertDelta([
      {
        espn_id: victim.player_id,
        gsis_id: donor.gsis_id,
        method: "match",
        source: "matcher",
        confidence: 0.8,
        first_seen: world.clock.nowIso(),
        last_seen: world.clock.nowIso(),
      },
    ]);
    const planted = (await roster()).find((p) => p.player_id === victim.player_id);
    expect(planted).toMatchObject({
      gsis_id: donor.gsis_id,
      crosswalk: { method: "match", confidence: 0.8 },
    });

    const r = rebuild();
    expect(r.run.rejected.map((p) => p.espn_id)).toContain(victim.player_id);
    expect(r.removed).toBeGreaterThanOrEqual(1);
    expect(world.store.repos.crosswalk.get(victim.player_id)).toBeNull();
    expect(world.store.repos.crosswalk.byGsis(donor.gsis_id).map((p) => p.espn_id)).toEqual([
      donor.player_id,
    ]);

    const after = (await roster()).find((p) => p.player_id === victim.player_id);
    expect(after).toMatchObject({ gsis_id: null, crosswalk: { method: "none", confidence: 0 } });
    const u = (await usage()).find((x) => x.player_id === victim.player_id);
    expect(u).toMatchObject({ gsis_id: null, trailing: { window_games: 0 } });
    expect(await unmatchedRostered()).toBe(statusBefore);
    // the store holds what the run decided: a second rebuild removes nothing more
    expect(rebuild().removed).toBe(0);
  });
});
