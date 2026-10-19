// crosswalk-reverse.test.ts — a gsis id resolves to the one CURRENT ESPN player, decided by evidence,
// never by ESPN id order (plan 07 C1: the crosswalk state behind every gsis id). Stage C finding
// crosswalk-reverse-lookup-lowest-id: stored pairs never expire and legitimate states keep two or more
// ESPN ids on one gsis id (an ESPN re-key keeps the old id's pair; nflverse corrects a wrong id; the
// owner removes an override); every reverse lookup took byGsis(g)[0] — ORDER BY espn_id — so a gsis
// selector read the dead or a different player and the waiver tool's Sleeper join missed the new id.
// Attempt 1 ranked by last_seen at its 7-day grain and broke a tie with "an override first, then the
// lowest id": with the finding's own timestamps a removed override (both pairs seen the same day) and
// a re-key inside one grain still picked the wrong player, and a tie was said only by callers that
// passed warnings. Now: a removed override pairs nothing, a configured one wins, nflverse's roster
// confirms or contradicts each candidate, the player index settles a single live id; a pick the
// evidence does not settle is said, a true tie picks none (a single-player selector answers
// VALIDATION gsis_ambiguous). Units (incl. a fast-check property: relabelling the ids never moves the
// pick), the services path, then the tools through the real store (fixture mode, no network).
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CrosswalkPair } from "../../src/domain/crosswalk/types.js";
import type { McpServices } from "../../src/mcp/services.js";
import {
  espnIdOfGsis,
  espnIdsPairedWith,
  pickGsisPair,
  resolveGsis,
  type GsisEvidence,
} from "../../src/mcp/tools/common.js";
import { call, connect, makeWorld, type World } from "./helpers/world.js";

const G = "00-0099991";
const day = (d: string) => `2026-${d}T00:00:00.000Z`;
const pair = (
  espn_id: number,
  method: CrosswalkPair["method"],
  first_seen: string,
  last_seen = first_seen,
  confidence = 1,
): CrosswalkPair => ({
  espn_id,
  gsis_id: G,
  method,
  source:
    method === "override" ? "overrides" : method === "id" ? "nflverse:roster_weekly" : "matcher",
  confidence,
  first_seen,
  last_seen,
});
const ev = (o: Partial<GsisEvidence> = {}): GsisEvidence => ({
  universe: null,
  overrides: new Map(),
  nflverse: null,
  ...o,
});
const picked = (r: ReturnType<typeof pickGsisPair>) =>
  r.kind === "one" ? { id: r.pair.espn_id, established: r.established } : r;

describe("pickGsisPair (Stage C crosswalk-reverse-lookup-lowest-id)", () => {
  it("a removed override pairs nothing — even seen the same day as the id pair (the verifier's repro b)", () => {
    // the finding's own timestamps: the override and the id pair written by one rebuild
    const removed = pair(9000401, "override", day("10-01"));
    const pairs = [removed, pair(9000402, "id", day("10-01"))];
    expect(picked(pickGsisPair(G, pairs, ev()))).toEqual({ id: 9000402, established: true });
    // the override alone, removed: nothing
    expect(pickGsisPair(G, [removed], ev())).toEqual({ kind: "none" });
    // still configured: the owner's assertion wins over nflverse's id
    expect(picked(pickGsisPair(G, pairs, ev({ overrides: new Map([[9000401, G]]) })))).toEqual({
      id: 9000401,
      established: true,
    });
    // an override configured for ANOTHER gsis id is not this one's
    expect(
      picked(pickGsisPair(G, pairs, ev({ overrides: new Map([[9000401, "00-0000001"]]) }))),
    ).toEqual({ id: 9000402, established: true });
  });

  it("a re-key inside one last-seen grain: nflverse, then the index, settle it; else the later pairing, said", () => {
    const pairs = [pair(4100001, "id", day("10-13")), pair(5100001, "id", day("10-15"))];
    const nfl = new Map([
      [4100001, { gsis_id: G, season: 2026, week: 3 }],
      [5100001, { gsis_id: G, season: 2026, week: 6 }],
    ]);
    expect(picked(pickGsisPair(G, pairs, ev({ nflverse: nfl })))).toEqual({
      id: 5100001,
      established: true,
    });
    expect(picked(pickGsisPair(G, pairs, ev({ universe: new Set([5100001]) })))).toEqual({
      id: 5100001,
      established: true,
    });
    // neither settles it (both ids live, no roster): the later pairing, never the lowest id — said
    for (const universe of [new Set([4100001, 5100001]), null])
      expect(picked(pickGsisPair(G, pairs, ev({ universe })))).toEqual({
        id: 5100001,
        established: false,
      });
    // across grains the rebuilds' last sight is evidence
    const apart = [
      pair(4100001, "id", day("08-01"), day("09-01")),
      pair(5100001, "id", day("09-25"), day("10-15")),
    ];
    expect(picked(pickGsisPair(G, apart, ev()))).toEqual({ id: 5100001, established: true });
  });

  it("nflverse corrects a wrong id: the contradicted pair is dropped", () => {
    // A belonged to another live player; nflverse now pairs G with B (the verifier's v-idfix)
    const pairs = [pair(7000101, "id", day("10-12")), pair(7000202, "id", day("10-14"))];
    const nfl = new Map([
      [7000101, { gsis_id: "00-0099502", season: 2026, week: 6 }],
      [7000202, { gsis_id: G, season: 2026, week: 6 }],
    ]);
    expect(picked(pickGsisPair(G, pairs, ev({ nflverse: nfl })))).toEqual({
      id: 7000202,
      established: true,
    });
    // every candidate contradicted: none
    const gone = new Map([
      [7000101, { gsis_id: "00-0099502", season: 2026, week: 6 }],
      [7000202, { gsis_id: "00-0099503", season: 2026, week: 6 }],
    ]);
    expect(pickGsisPair(G, pairs, ev({ nflverse: gone }))).toEqual({ kind: "none" });
    // an id nflverse has no row for is unknown (not contradicted): the confirmed one wins
    const half = new Map([
      [7000101, null],
      [7000202, { gsis_id: G, season: 2026, week: 5 }],
    ]);
    expect(picked(pickGsisPair(G, pairs, ev({ nflverse: half })))).toEqual({
      id: 7000202,
      established: true,
    });
  });

  it("a confident pair over a name match; a true tie picks none (never the lowest id)", () => {
    expect(
      picked(
        pickGsisPair(
          G,
          [pair(1, "match", day("10-05"), day("10-05"), 0.9), pair(2, "id", day("09-20"))],
          ev(),
        ),
      ),
    ).toEqual({ id: 2, established: true });
    const tie = [pair(7, "id", day("10-05")), pair(8, "id", day("10-05"), day("10-06"))];
    expect(pickGsisPair(G, tie, ev({ universe: new Set([7, 8]) }))).toEqual({
      kind: "tie",
      candidates: [7, 8],
    });
    // nflverse rows of the same week for both: a tie too
    const same = new Map([
      [7, { gsis_id: G, season: 2026, week: 6 }],
      [8, { gsis_id: G, season: 2026, week: 6 }],
    ]);
    expect(pickGsisPair(G, tie, ev({ nflverse: same }))).toEqual({
      kind: "tie",
      candidates: [7, 8],
    });
    expect(pickGsisPair(G, [], ev())).toEqual({ kind: "none" });
  });

  it("property: relabelling the ESPN ids (order reversed) never moves the pick", () => {
    const methods = ["id", "match", "override"] as const;
    const arbPair = fc.record({
      id: fc.integer({ min: 1, max: 40 }),
      method: fc.constantFrom(...methods),
      first: fc.integer({ min: 0, max: 30 }),
      seenAfter: fc.integer({ min: 0, max: 30 }),
    });
    fc.assert(
      fc.property(
        fc.uniqueArray(arbPair, { minLength: 1, maxLength: 5, selector: (p) => p.id }),
        fc.option(fc.uniqueArray(fc.integer({ min: 1, max: 40 }))),
        fc.uniqueArray(fc.integer({ min: 1, max: 40 }), { maxLength: 3 }),
        (raw, uni, configured) => {
          const at = (d: number) => new Date(Date.UTC(2026, 8, 1 + d)).toISOString();
          const build = (rel: (id: number) => number) => {
            const pairs = raw.map((p) =>
              pair(
                rel(p.id),
                p.method,
                at(p.first),
                at(p.first + p.seenAfter),
                p.method === "match" ? 0.9 : 1,
              ),
            );
            return pickGsisPair(
              G,
              pairs,
              ev({
                universe: uni === null ? null : new Set(uni.map(rel)),
                overrides: new Map(configured.map((id) => [rel(id), G])),
              }),
            );
          };
          const flip = (id: number) => 100 - id;
          const a = build((id) => id);
          const b = build(flip);
          if (a.kind === "one" && b.kind === "one") {
            expect(flip(a.pair.espn_id)).toBe(b.pair.espn_id);
            expect(a.established).toBe(b.established);
          } else if (a.kind === "tie" && b.kind === "tie")
            expect([...a.candidates].map(flip).sort((x, y) => x - y)).toEqual(b.candidates);
          else expect(b.kind).toBe(a.kind);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("resolveGsis over the services (evidence reads, the sentence said)", () => {
  const services = (
    pairs: readonly CrosswalkPair[],
    o: {
      universe?: readonly number[] | null;
      roster?: ReadonlyMap<number, string> | null;
      overrides?: readonly { espn_id: number; gsis_id: string; note: null }[];
    } = {},
  ) =>
    ({
      services: {
        crosswalk: { byGsis: () => pairs, get: () => null, count: () => pairs.length },
        crosswalkOverrides: o.overrides ?? [],
        playerUniverse: {
          all: () => ({ rows: [], stamp: null }),
          byIds: (ids: readonly number[]) =>
            o.universe === null || o.universe === undefined
              ? { rows: [], stamp: null }
              : {
                  rows: ids.filter((i) => o.universe?.includes(i)).map((espn_id) => ({ espn_id })),
                  stamp: { source: "espn:players" },
                },
        },
        rosterWeekly: {
          latest: () => ({ rows: [], stamp: null }),
          byEspnId: (id: number) =>
            o.roster === null || o.roster === undefined
              ? { rows: [], stamp: null }
              : {
                  rows: o.roster.has(id)
                    ? [{ gsis_id: o.roster.get(id), season: 2026, week: 6, espn_id: id }]
                    : [],
                  stamp: { source: "nflverse:roster_weekly" },
                },
        },
      } as unknown as McpServices,
    }) as const;

  it("an unsettled pick is said; a tie gives no id and says so; a settled one says nothing", () => {
    const rekey = [pair(4100001, "id", day("10-13")), pair(5100001, "id", day("10-15"))];
    const w: string[] = [];
    expect(espnIdOfGsis(services(rekey, { universe: [4100001, 5100001] }), G, w)).toBe(5100001);
    expect(w).toEqual([
      `gsis ${G}: the crosswalk pairs it with 2 ESPN players (4100001, 5100001); 5100001 used (the most recently paired: neither the nflverse roster nor the player index settles it)`,
    ]);
    const roster = new Map([
      [4100001, "00-0099999"],
      [5100001, G],
    ]);
    const quiet: string[] = [];
    expect(espnIdOfGsis(services(rekey, { roster }), G, quiet)).toBe(5100001);
    expect(quiet).toEqual([]);
    const tie = [pair(7, "id", day("10-05")), pair(8, "id", day("10-05"))];
    const r = resolveGsis(services(tie, { universe: [7, 8] }), G);
    expect(r).toMatchObject({ espn_id: null, tie: true });
    expect(r.note).toMatch(/nothing tells which is current: none used \(pass player_ids\)$/);
  });

  it("the configured overrides are read from the services (a removed one pairs nothing)", () => {
    const pairs = [pair(9000401, "override", day("10-01")), pair(9000402, "id", day("10-01"))];
    expect(espnIdOfGsis(services(pairs), G)).toBe(9000402);
    expect(
      espnIdOfGsis(
        services(pairs, { overrides: [{ espn_id: 9000401, gsis_id: G, note: null }] }),
        G,
      ),
    ).toBe(9000401);
  });
});

describe("the tools through the real store", () => {
  let world: World;
  let oldId = 0;
  let newId = 0;
  const TIE = "00-0099992";
  beforeAll(async () => {
    world = await makeWorld({ league: "league-a" });
    const c = await connect(world);
    // players of the recorded pool page (a gsis selector reads them by id through it)
    const page = await call(c.client, "espn_list_players", { status: "ALL", limit: 25, week: 3 });
    const ids = (page.body.data as { players: { player_id: number }[] }).players
      .map((p) => p.player_id)
      .filter((id) => id > 0)
      .sort((a, b) => a - b);
    await c.close();
    // the lower id is the re-keyed (old) entity the rebuilds stopped seeing; the higher the current
    oldId = ids[0] ?? 0;
    newId = ids[ids.length - 1] ?? 0;
    world.store.repos.crosswalk.upsertDelta([
      pair(oldId, "id", day("08-01"), day("08-15")),
      pair(newId, "id", day("09-20"), day("10-05")),
      // a true tie: two live ids paired by one rebuild, nothing to tell them apart
      { ...pair(ids[1] ?? 0, "id", day("10-01")), gsis_id: TIE },
      { ...pair(ids[2] ?? 0, "id", day("10-01")), gsis_id: TIE },
    ]);
  }, 120_000);
  afterAll(() => {
    world.cleanup();
  });

  it("espnIdOfGsis and an E1 gsis selector resolve to the current pair", async () => {
    expect(oldId).toBeLessThan(newId);
    expect(espnIdOfGsis({ services: world.services }, G)).toBe(newId);
    // the raw join helper still lists every paired id (the Sleeper join resolves through espnIdOfGsis)
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

  it("a true tie: a gsis selector names nobody (said); a single-player selector is gsis_ambiguous", async () => {
    const c = await connect(world, { options: { toolset: "full" } });
    try {
      const r = await call(c.client, "espn_project_players", {
        players: { gsis_ids: [G, TIE] },
        horizon: "week",
        week: 3,
      });
      expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
      const p = (r.body.data as { projections: { player_id: number }[] }).projections;
      expect(p.map((x) => x.player_id)).toEqual([newId]);
      const warnings = r.body.warnings as string[];
      expect(warnings).toContain("1 requested player(s) not found");
      expect(warnings.some((x) => x.startsWith(`gsis ${TIE}: `) && x.includes("none used"))).toBe(
        true,
      );
      for (const tool of ["espn_analyze_evidence", "espn_analyze_injury_cascade"]) {
        const e = await call(c.client, tool, { player: { gsis_ids: [TIE] } });
        expect(e.isError, tool).toBe(true);
        expect((e.body as { error: { code: string; reason?: string } }).error).toMatchObject({
          code: "VALIDATION",
          reason: "gsis_ambiguous",
        });
      }
    } finally {
      await c.close();
    }
  }, 120_000);
});
