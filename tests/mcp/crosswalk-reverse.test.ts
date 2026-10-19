// crosswalk-reverse.test.ts — a gsis id resolves to the one CURRENT ESPN player, never the lowest
// stored ESPN id (plan 07 C1: the crosswalk state behind every gsis id). Stage C finding
// crosswalk-reverse-lookup-lowest-id: stored pairs never expire and legitimate states keep two or more
// ESPN ids on one gsis id (an ESPN re-key keeps the old id's pair; an override beside an id pair; a
// removed override); every reverse lookup took byGsis(g)[0] — ORDER BY espn_id — so after a re-key a
// gsis selector read the dead entity and the waiver tool's Sleeper join missed the new id, and with a
// removed override a real player's gsis id resolved to a different player. Units over the finding's
// two states, then a gsis selector through the real store (fixture mode, no network).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CrosswalkPair } from "../../src/domain/crosswalk/types.js";
import { espnIdOfGsis, espnIdsPairedWith, pickGsisPair } from "../../src/mcp/tools/common.js";
import { call, connect, makeWorld, type World } from "./helpers/world.js";

const G = "00-0099991";
const pair = (
  espn_id: number,
  method: CrosswalkPair["method"],
  last_seen: string,
  confidence = 1,
): CrosswalkPair =>
  ({
    espn_id,
    gsis_id: G,
    method,
    source:
      method === "override" ? "overrides" : method === "id" ? "nflverse:roster_weekly" : "matcher",
    confidence,
    first_seen: "2026-08-01T00:00:00.000Z",
    last_seen,
  });

describe("pickGsisPair (Stage C crosswalk-reverse-lookup-lowest-id)", () => {
  it("a re-key: the new id (seen this week) over the old one, the lowest", () => {
    const pairs = [
      pair(4100001, "id", "2026-09-01T00:00:00.000Z"),
      pair(5100001, "id", "2026-10-05T00:00:00.000Z"),
    ];
    expect(pickGsisPair(pairs, null)).toEqual({ pair: pairs[1], ambiguous: false });
    // the universe settles it even within one last-seen grain
    const same = [
      pair(4100001, "id", "2026-10-04T00:00:00.000Z"),
      pair(5100001, "id", "2026-10-05T00:00:00.000Z"),
    ];
    expect(pickGsisPair(same, new Set([5100001]))?.pair.espn_id).toBe(5100001);
  });

  it("a removed override: the current id pair over the stale override", () => {
    const pairs = [
      pair(9000401, "override", "2026-08-01T00:00:00.000Z"),
      pair(9000402, "id", "2026-10-05T00:00:00.000Z"),
    ];
    expect(pickGsisPair(pairs, null)?.pair.espn_id).toBe(9000402);
  });

  it("a confident pair over a match, and a true tie is ambiguous (an override first)", () => {
    expect(
      pickGsisPair(
        [
          pair(1, "match", "2026-10-05T00:00:00.000Z", 0.9),
          pair(2, "id", "2026-09-20T00:00:00.000Z"),
        ],
        null,
      )?.pair.espn_id,
    ).toBe(2);
    const tie = pickGsisPair(
      [pair(7, "id", "2026-10-05T00:00:00.000Z"), pair(8, "override", "2026-10-04T00:00:00.000Z")],
      null,
    );
    expect(tie).toMatchObject({ ambiguous: true });
    expect(tie?.pair.espn_id).toBe(8);
    expect(pickGsisPair([], null)).toBeNull();
  });
});

describe("a gsis selector through the real store", () => {
  let world: World;
  let oldId = 0;
  let newId = 0;
  beforeAll(async () => {
    world = await makeWorld({ league: "league-a" });
    const c = await connect(world);
    // two players of the recorded pool page (a gsis selector reads them by id through it)
    const page = await call(c.client, "espn_list_players", { status: "ALL", limit: 25, week: 3 });
    const ids = (page.body.data as { players: { player_id: number }[] }).players
      .map((p) => p.player_id)
      .filter((id) => id > 0)
      .sort((a, b) => a - b);
    await c.close();
    // the lower id is the re-keyed (old) entity; the higher one the current pair
    oldId = ids[0] ?? 0;
    newId = ids[ids.length - 1] ?? 0;
    world.store.repos.crosswalk.upsertDelta([
      pair(oldId, "id", "2026-08-15T00:00:00.000Z"),
      pair(newId, "id", "2026-10-05T00:00:00.000Z"),
    ]);
  }, 120_000);
  afterAll(() => {
    world.cleanup();
  });

  it("espnIdOfGsis and an E1 gsis selector resolve to the current pair", async () => {
    expect(oldId).toBeLessThan(newId);
    expect(espnIdOfGsis({ services: world.services }, G)).toBe(newId);
    // a join against a known id set (the waiver tool's Sleeper trend) sees every paired id
    expect(espnIdsPairedWith({ services: world.services }, G)).toEqual([oldId, newId]);
    const c = await connect(world);
    try {
      const r = await call(c.client, "espn_project_players", {
        players: { gsis_ids: [G] },
        horizon: "week",
        week: 3,
      });
      expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
      const p = (r.body.data as { projections: { player_id: number }[] }).projections;
      expect(p.map((x) => x.player_id)).toEqual([newId]);
    } finally {
      await c.close();
    }
  }, 60_000);
});
