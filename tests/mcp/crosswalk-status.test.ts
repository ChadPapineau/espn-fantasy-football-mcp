// crosswalk-status.test.ts — Stage C finding crosswalk-alert-remediation-dead, part 3 (plan 07 G1;
// plan 06 §1.3; research 04 §C steps 2 and 5): espn_get_status counts a rostered or ≥ 1 %-owned
// player as unmatched exactly when the rebuild's alert lists him — no stored pair, or one below
// confidence 1.0 — and surfaces the name-only pairs as `matched_by_name`. Before, a name-only pair
// (0.8) counted the player as matched while the alert listed him. The fixture world (league-a,
// `full`, the nflverse excerpts published through the real runner and the real crosswalk rebuild);
// the planted rows are written the way a rebuild would write them.
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CrosswalkPair } from "../../src/domain/crosswalk/types.js";
import { call, connect, makeWorld, type World } from "./helpers/world.js";

let world: World;
let client: Client;
let close: () => Promise<void>;

interface RosterRow {
  readonly player_id: number;
  readonly position: string;
  readonly gsis_id: string | null;
}
interface CrosswalkCounts {
  readonly matched: number;
  readonly matched_by_name: number;
  readonly unmatched_rostered: number;
  readonly unmatched_top_owned: number;
}

async function data(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await call(client, name, args);
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body.data as Record<string, unknown>;
}

const counts = async (): Promise<CrosswalkCounts> =>
  (await data("espn_get_status", {})).crosswalk as CrosswalkCounts;

beforeAll(async () => {
  world = await makeWorld({ publishNflverse: true });
  ({ client, close } = await connect(world, { options: { toolset: "full" } }));
  await data("espn_get_league", {});
}, 180_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

describe("espn_get_status counts the crosswalk as the rebuild's alert does", () => {
  it("a name-only pair is matched_by_name and still unmatched; a confidence-1.0 pair is matched", async () => {
    const rows = (await data("espn_get_roster", { week: 4 })).players as RosterRow[];
    const victim = rows.find(
      (p) => p.player_id > 0 && p.gsis_id === null && ["RB", "WR", "TE"].includes(p.position),
    );
    if (victim === undefined)
      throw new Error("the fixture world lacks an unpaired rostered player");
    expect(world.store.repos.crosswalk.get(victim.player_id)).toBeNull();
    const before = await counts();
    expect(before.unmatched_rostered).toBeGreaterThan(0);

    const at = world.clock.nowIso();
    const pairOf = (edit: Partial<CrosswalkPair>): CrosswalkPair => ({
      espn_id: victim.player_id,
      gsis_id: "00-0099801",
      method: "match",
      source: "matcher",
      confidence: 0.8,
      first_seen: at,
      last_seen: at,
      ...edit,
    });

    // paired by name, team and position (0.8): stored, surfaced as matched by name, and still
    // counted unmatched — the alert lists him (confidence < 1)
    world.store.repos.crosswalk.upsertDelta([pairOf({})]);
    const byName = await counts();
    expect(byName).toEqual({
      ...before,
      matched: before.matched + 1,
      matched_by_name: before.matched_by_name + 1,
    });

    // a confidence-1.0 pair (an override): matched, and no longer unmatched
    world.store.repos.crosswalk.upsertDelta([
      pairOf({ method: "override", source: "overrides", confidence: 1 }),
    ]);
    const confident = await counts();
    expect(confident).toEqual({
      ...before,
      matched: before.matched + 1,
      unmatched_rostered: before.unmatched_rostered - 1,
    });
  });
});
