// roster-read-turns.test.ts — a large roster read runs its schema parse a team a step and its cache
// strip in steps of its own, fresh and cached (request.ts: a body over YIELD_BEFORE_PARSE_CHARS runs
// ReadSpec.parseSteps and stripForCacheSteps through `inTurns`; provider.ts parseRosterSteps; plan 03
// §1.2's ≤ 20 ms batch; changelog §R10 timing items: league-c's week-3 roster, about 1 MB, parsed in
// 12–14 ms and stripped in about 10 ms of one turn each on the owner's Mac). Each step gives up the
// loop turn once the slice has spent SLICE_CPU_MS (round 3's review: a pass through the turn gate
// per step made a cold roster read twice as slow under parallel calls). Deterministic slice meters:
// spending a slice a read, every step takes a turn — both halves split, the parse a team a turn and
// the strip a step a turn; frozen, the read takes only the passes it cannot skip, a fixed ceiling.
// The value read fresh, read back from the cache by a second process and stored is the one the
// whole-body parse and strip give. In memory, recorded fixtures, no network.
import { describe, expect, it } from "vitest";
import { grantedTurns } from "../../../src/domain/analytics/cooperative.js";
import { YIELD_BEFORE_PARSE_CHARS } from "../../../src/providers/espn/request.js";
import { stripForCache, stripForCacheSteps } from "../../../src/providers/espn/cache.js";
import { frozenMeter, spendingMeter, withSliceMeter } from "../../domain/analytics/slice-meter.js";
import { loadRoster, makeWorld, MemoryCache } from "./helpers.js";

/** One increment per event-loop iteration (an immediate queued inside an immediate runs next turn). */
function turnCounter(): { now: () => number; stop: () => void } {
  let turn = 0;
  let on = true;
  const tick = (): void => {
    turn += 1;
    if (on) setImmediate(tick);
  };
  setImmediate(tick);
  return {
    now: () => turn,
    stop: () => {
      on = false;
    },
  };
}

/** The yields of the strip's walk over `body`: its steps less one. */
function stripYields(body: unknown): number {
  const work = stripForCacheSteps(body);
  let n = 0;
  for (let r = work.next(); r.done !== true; r = work.next()) n += 1;
  return n;
}

/**
 * The gate passes a large read cannot skip. Fresh: the requester's resume after each upstream
 * answer (two reads: the league's settings, then the roster), and one after the roster's JSON parse,
 * its drift check, its schema parse and its strip. Cached: one before and one after the stored
 * body's JSON parse and one after its schema parse. Each also starts with the read's own
 * conditional turn (request.ts `read`: turnIfSpent, F1 round 4d), which a frozen meter takes once —
 * the account's first check after the meter is set always yields (sliceStart −∞) — and never again.
 * Literals: the reads' fixed ceiling.
 */
const FIXED_PASSES = { fresh: 7, cached: 4 } as const;

describe("a large roster read: a team a step, fresh and cached", () => {
  const body = loadRoster("league-c", 3);
  const teams = (body.teams as unknown[]).length;

  it("fresh, a slice spent a read: the parse a team a turn AND the strip a step a turn", async () => {
    expect(JSON.stringify(body).length).toBeGreaterThan(YIELD_BEFORE_PARSE_CHARS);
    const strip = stripYields(body);
    expect(strip).toBeGreaterThan(4);
    const cache = new MemoryCache();
    const w = makeWorld({ slot: "league-c", cache });
    const turns = turnCounter();
    const before = turns.now();
    const fresh = await withSliceMeter(spendingMeter(), () => w.provider.getRosters(w.ref, 3));
    const spent = turns.now() - before;
    turns.stop();
    // both halves: a turn per team (the parse's yields, one a team) plus a turn per strip step —
    // neither half alone clears this (round 3's review: a one-turn parse made 21 turns of 33 here, a
    // one-turn strip 18, and both passed the old bound of a turn per team)
    expect(spent).toBeGreaterThan(teams + strip);
    const stored = [...cache.map.values()].find((e) => e.key.includes("mRoster"));
    expect(stored).toBeDefined();
    // the stored copy is the whole-body strip of what ESPN sent (the recorded parts, re-assembled)
    expect(stored?.parsed_json).toBe(JSON.stringify(stripForCache(body)));
    expect(fresh.value.length).toBe(teams);
  });

  it("fresh, a frozen meter: only the read's fixed passes through the gate, the same value", async () => {
    const cache = new MemoryCache();
    const w = makeWorld({ slot: "league-c", cache });
    const before = grantedTurns();
    const fresh = await withSliceMeter(frozenMeter, () => w.provider.getRosters(w.ref, 3));
    // round 3's review: a pass per step was 33 loop turns for this read, about 1 ms of work each
    expect(grantedTurns() - before).toBeLessThanOrEqual(FIXED_PASSES.fresh);
    const stored = [...cache.map.values()].find((e) => e.key.includes("mRoster"));
    expect(stored?.parsed_json).toBe(JSON.stringify(stripForCache(body)));
    expect(fresh.value.length).toBe(teams);
  });

  it("cached: a second process parses the stored body a team a turn, to the same rosters", async () => {
    const cache = new MemoryCache();
    const first = makeWorld({ slot: "league-c", cache });
    const fresh = await first.provider.getRosters(first.ref, 3);
    // a new provider over the same cache: its parse memo is empty, so the stored body is parsed
    const second = makeWorld({ slot: "league-c", cache, clock: first.clock });
    const turns = turnCounter();
    const before = turns.now();
    const cached = await withSliceMeter(spendingMeter(), () =>
      second.provider.getRosters(second.ref, 3),
    );
    const spent = turns.now() - before;
    turns.stop();
    expect(second.sent).toHaveLength(0);
    expect(spent).toBeGreaterThan(fresh.value.length);
    expect(JSON.stringify(cached.value)).toBe(JSON.stringify(fresh.value));
    // frozen: a third process takes only the cached read's fixed passes
    const third = makeWorld({ slot: "league-c", cache, clock: first.clock });
    const at = grantedTurns();
    const again = await withSliceMeter(frozenMeter, () => third.provider.getRosters(third.ref, 3));
    expect(grantedTurns() - at).toBeLessThanOrEqual(FIXED_PASSES.cached);
    expect(JSON.stringify(again.value)).toBe(JSON.stringify(fresh.value));
  });
});
