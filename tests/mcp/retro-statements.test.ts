// retro-statements.test.ts — espn_analyze_retrospective (E13) prepares a bounded number of
// node:sqlite statements per call, the same whatever its player count, weeks or log size (plan 03
// §1.2: the stall bound holds "regardless of log size"; src/store/sqlite.ts, the guard's statement
// cache). At 552e3d3 every E13 call prepared ~2,576 statements and dropped them — 2,332 of them
// projection.getAsOf, one per lookup and two lookups per player-week — and V8's weak callbacks
// freeing them were ~70 % of the young-generation pause CI's retrospective-stall test read as
// growth (40.6 ms over a 27.7 ms bound). Through the real composition root over the real store
// (fixture mode, nflverse excerpts published; no network, no cookie): a small world (league-b, ten
// teams, one record, week 1) and a large one (league-c, twelve teams, records in weeks 1–3, week 3),
// every DatabaseSync.prepare in the process counted around each E13 call.
import type { Client } from "@modelcontextprotocol/client";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProjectionRepository } from "../../src/domain/analytics/types.js";
import { call, connect, makeWorld, type LeagueSlot, type World } from "./helpers/world.js";

/** Most statements one E13 call may prepare cold (each distinct SQL text once per connection). */
const COLD_PREPARES_MAX = 32;
/** Most statements a repeated E13 call may prepare (warm: every statement already cached). */
const WARM_PREPARES_MAX = 2;

interface Env {
  data: Record<string, unknown>;
  meta: { request_id: string };
}
async function ok(c: Client, name: string, args: Record<string, unknown> = {}): Promise<Env> {
  const r = await call(c, name, args);
  expect(r.isError, `${name}: ${JSON.stringify(r.body).slice(0, 400)}`).toBe(false);
  return r.body as unknown as Env;
}

/** One world with `perWeek` lineup records logged in each of `weeks`. */
async function seeded(
  league: LeagueSlot,
  weeks: readonly number[],
  perWeek: number,
): Promise<World> {
  const world = await makeWorld({ league, publishNflverse: true });
  const { client, close } = await connect(world);
  try {
    const lg = await ok(client, "espn_get_league", { include: ["scoring"] });
    const hash = (lg.data.scoring as { settings_hash: string }).settings_hash;
    for (const week of weeks) {
      const lineup = await ok(client, "espn_analyze_lineup", { week });
      for (let n = 0; n < perWeek; n++)
        await ok(client, "espn_record_recommendation", {
          kind: "lineup",
          week,
          rec: lineup.data.rec,
          alternatives: [],
          source_calls: [{ tool: "espn_analyze_lineup", request_id: lineup.meta.request_id }],
          settings_hash: hash,
          client_ref: `stmts-${String(week)}-${String(n)}`,
        });
    }
  } finally {
    await close();
  }
  return world;
}

/** One E13 call's statement count: every prepare in the process, and the SQL of each. */
interface Counted {
  readonly prepares: number;
  readonly sql: readonly string[];
  readonly lookups: number;
  readonly calls: number;
}

/** Two E13 calls for `week` (the first may compile what no earlier tool ran; the second is warm). */
async function e13Twice(world: World, week: number): Promise<[Counted, Counted]> {
  let lookups = 0;
  const inner = world.services.projections;
  const projections: ProjectionRepository = {
    put: (p) => inner.put(p),
    latest: (...a) => inner.latest(...a),
    getAsOf: (...a) => {
      lookups += 1;
      return inner.getAsOf(...a);
    },
  };
  const { client, close } = await connect(world, { services: { projections } });
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  try {
    const one = async (): Promise<Counted> => {
      const from = prepare.mock.calls.length;
      lookups = 0;
      const e = await ok(client, "espn_analyze_retrospective", { week, min_n: 1 });
      const sql = prepare.mock.calls.slice(from).map((c) => c[0]);
      return {
        prepares: sql.length,
        sql,
        lookups,
        calls: (e.data.calls as unknown[]).length,
      };
    };
    const cold = await one();
    const warm = await one();
    return [cold, warm];
  } finally {
    prepare.mockRestore();
    await close();
  }
}

let small: World;
let large: World;
beforeAll(async () => {
  small = await seeded("league-b", [1], 1);
  large = await seeded("league-c", [1, 2, 3], 12);
}, 300_000);
afterAll(() => {
  small.cleanup();
  large.cleanup();
});

describe("E13 prepares a bounded number of statements per call (retrospective-stall's GC pause)", () => {
  it("few or many players, weeks and records: the same handful, none per lookup", async () => {
    const [smallCold, smallWarm] = await e13Twice(small, 1);
    const [largeCold, largeWarm] = await e13Twice(large, 3);
    const report = JSON.stringify({
      small: { cold: smallCold.prepares, warm: smallWarm.prepares, lookups: smallCold.lookups },
      large: { cold: largeCold.prepares, warm: largeWarm.prepares, lookups: largeCold.lookups },
      warm_sql: [...new Set([...smallWarm.sql, ...largeWarm.sql])],
    });
    // the worlds differ where the old cost grew: players × weeks (lookups) and the log (records)
    expect(smallCold.calls, report).toBe(1);
    expect(largeCold.calls, report).toBe(12); // the scored week's records (36 logged in all)
    expect(largeCold.lookups, report).toBeGreaterThan(3 * smallCold.lookups);
    // one prepare per lookup would be far over the bound (2,332 at 552e3d3)
    expect(largeCold.lookups, report).toBeGreaterThan(4 * COLD_PREPARES_MAX);
    for (const run of [smallCold, largeCold])
      expect(run.prepares, report).toBeLessThanOrEqual(COLD_PREPARES_MAX);
    for (const run of [smallWarm, largeWarm])
      expect(run.prepares, report).toBeLessThanOrEqual(WARM_PREPARES_MAX);
    // independent of the player count, the weeks and the log size
    expect(largeWarm.prepares, report).toBe(smallWarm.prepares);
    // each statement a call prepares, it prepares once (no SQL text twice in one call)
    for (const run of [smallCold, largeCold, smallWarm, largeWarm])
      expect(run.sql.length, report).toBe(new Set(run.sql).size);
    // the warm calls answer what the cold ones did
    expect(largeWarm.calls).toBe(largeCold.calls);
    expect(smallWarm.calls).toBe(smallCold.calls);
  });
});
