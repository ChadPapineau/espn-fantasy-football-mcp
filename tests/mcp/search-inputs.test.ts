// search-inputs.test.ts — C1 espn_search_players' inputs and E2's pf_weight bound, at the tool level
// in fixture mode (league-a; no network, no cookie). Stage C round-2 findings:
// - players-position-filter-unvalidated: `position` was compared raw (upper-cased) to ESPN's position
//   name, so `DST` and a slot name like `FLEX` silently returned [] — indistinguishable from "no such
//   player". Now: the league's spelling (case, DST → D/ST), a slot widened to what it accepts, and an
//   unknown spelling is VALIDATION unknown_position.
// - players-search-no-allow-stale: C1 had no allow_stale, so its own STALE_ONLY hint ("Retry with
//   allow_stale: true") and orient's host_moved rule led to VALIDATION (unknown key) and the only
//   name → player_id path stayed dead until a terminal refresh.
// - lineup-pf-weight-zero-refused: pf_weight 0 was advertised valid (minimum 0) and refused by the
//   engine with a VALIDATION naming no field.
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { T0, call, connect, makeWorld, type World } from "./helpers/world.js";

let world: World;
let client: Client;
let close: () => Promise<void>;

type J = Record<string, unknown>;
interface Row {
  player_id: number;
  position: string;
  name: string;
}

async function ok(name: string, args: J = {}): Promise<J> {
  const r = await call(client, name, args);
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.body).slice(0, 400)}`);
  return r.body;
}
async function err(name: string, args: J = {}): Promise<J> {
  const r = await call(client, name, args);
  expect(r.isError, `${name} should fail`).toBe(true);
  return (r.body as { error: J }).error;
}
const players = (b: J): Row[] => (b.data as { players: Row[] }).players;

beforeAll(async () => {
  world = await makeWorld({ league: "league-a" });
  ({ client, close } = await connect(world));
  await ok("espn_get_league");
}, 120_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

describe("C1 position filter (Stage C players-position-filter-unvalidated)", () => {
  it("DST and dst mean D/ST, exactly as D/ST does — never an empty stand-in", async () => {
    const canonical = players(
      await ok("espn_search_players", { query: "bills", position: "D/ST" }),
    );
    expect(canonical.length).toBeGreaterThan(0);
    expect(canonical.every((p) => p.position === "D/ST")).toBe(true);
    for (const spelling of ["DST", "dst", "d/st"]) {
      const got = players(await ok("espn_search_players", { query: "bills", position: spelling }));
      expect(
        got.map((p) => p.player_id),
        spelling,
      ).toEqual(canonical.map((p) => p.player_id));
    }
  });

  it("a lower-case position equals its upper-case form", async () => {
    const up = players(await ok("espn_search_players", { query: "allen", position: "QB" }));
    const low = players(await ok("espn_search_players", { query: "allen", position: "qb" }));
    expect(up.length).toBeGreaterThan(0);
    expect(low.map((p) => p.player_id)).toEqual(up.map((p) => p.player_id));
  });

  it("a slot name matches what the slot accepts (FLEX → RB, WR, TE)", async () => {
    const all = players(await ok("espn_search_players", { query: "allen", limit: 25 }));
    const flex = players(
      await ok("espn_search_players", { query: "allen", position: "FLEX", limit: 25 }),
    );
    const want = all.filter((p) => ["RB", "WR", "TE"].includes(p.position));
    expect(want.length).toBeGreaterThan(0);
    expect(flex.map((p) => p.player_id)).toEqual(want.map((p) => p.player_id));
  });

  it("an unknown spelling is VALIDATION unknown_position on field position", async () => {
    for (const bad of ["XYZ", "QBX", "FLX"]) {
      const e = await err("espn_search_players", { query: "allen", position: bad });
      expect(e, bad).toMatchObject({
        code: "VALIDATION",
        field: "position",
        reason: "unknown_position",
      });
    }
  });
});

describe("C1 allow_stale (Stage C players-search-no-allow-stale)", () => {
  it("past espn:players' hard limit: STALE_ONLY, and the hint's retry with allow_stale is served labelled stale", async () => {
    // the input contract: the keys plan 07 §2 gives every ESPN-fact tool
    const listed = await client.listTools();
    const c1 = listed.tools.find((t) => t.name === "espn_search_players");
    const props = (c1?.inputSchema as { properties?: J } | undefined)?.properties ?? {};
    expect(Object.keys(props)).toEqual(expect.arrayContaining(["allow_stale", "force_refresh"]));
    world.clock.advance(8 * 24 * 3600 * 1000); // the dataset is now 8 days old (hard limit 7)
    try {
      const stale = await err("espn_search_players", { query: "allen" });
      expect(stale.code).toBe("STALE_ONLY");
      expect(String(stale.hint)).toContain("allow_stale");
      // the hint names the one refresh that fixes it (Stage C final gate: it said "<source>")
      expect(stale.hint).toBe(
        "Retry with allow_stale: true, or run eff refresh espn:players in a terminal.",
      );
      const served = await ok("espn_search_players", { query: "allen", allow_stale: true });
      expect(players(served).length).toBeGreaterThan(0);
      expect((served.meta as { freshness: string }).freshness).toBe("stale");
      expect(served.warnings as string[]).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^source espn:players is .* old \(expired\)$/),
        ]),
      );
      // force_refresh is accepted too (plan 07 §2), never an unknown key
      const forced = await call(client, "espn_search_players", {
        query: "allen",
        allow_stale: true,
        force_refresh: true,
      });
      expect(forced.isError).toBe(false);
    } finally {
      world.clock.set(T0);
    }
  }, 60_000);
});

describe("E2 pf_weight (Stage C lineup-pf-weight-zero-refused)", () => {
  it("0 is refused by the schema naming the field, and the advertised minimum is exclusive", async () => {
    const e = await err("espn_analyze_lineup", { pf_weight: 0 });
    expect(e).toMatchObject({ code: "VALIDATION", field: "pf_weight" });
    const listed = await client.listTools();
    const e2 = listed.tools.find((t) => t.name === "espn_analyze_lineup");
    const pf = (e2?.inputSchema as { properties?: Record<string, J> } | undefined)?.properties
      ?.pf_weight;
    expect(JSON.stringify(pf)).toContain('"exclusiveMinimum":0');
    expect(JSON.stringify(pf)).not.toContain('"minimum":0');
  });
});
