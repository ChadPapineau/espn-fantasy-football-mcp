// roster-read-turns.test.ts — a large roster read runs its schema parse a team a turn and its cache
// strip in turns of their own, fresh and cached (request.ts: a body over YIELD_BEFORE_PARSE_CHARS
// runs ReadSpec.parseSteps and stripForCacheSteps through `inTurns`; provider.ts parseRosterSteps;
// plan 03 §1.2's ≤ 20 ms batch; changelog §R10 timing items: the 1 MB roster's parse and its strip
// were one 20–30 ms turn each on the owner's Mac). A loop-turn counter shows each team's parse in a
// turn of its own; the value read fresh, read back from the cache by a second process and stored is
// the one the whole-body parse and strip give. In memory, recorded fixtures, no network.
import { describe, expect, it } from "vitest";
import { YIELD_BEFORE_PARSE_CHARS } from "../../../src/providers/espn/request.js";
import { stripForCache } from "../../../src/providers/espn/cache.js";
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

describe("a large roster read: a team a turn, fresh and cached", () => {
  it("fresh: the parse and the strip run over many turns; the cached copy is the whole-body strip", async () => {
    const body = loadRoster("league-c", 3);
    const teams = (body.teams as unknown[]).length;
    expect(JSON.stringify(body).length).toBeGreaterThan(YIELD_BEFORE_PARSE_CHARS);
    const cache = new MemoryCache();
    const w = makeWorld({ slot: "league-c", cache });
    const turns = turnCounter();
    const before = turns.now();
    const fresh = await w.provider.getRosters(w.ref, 3);
    const spent = turns.now() - before;
    turns.stop();
    // a turn per team at least (the parse), and more for the strip: in one turn each before
    expect(spent).toBeGreaterThan(teams);
    const stored = [...cache.map.values()].find((e) => e.key.includes("mRoster"));
    expect(stored).toBeDefined();
    // the stored copy is the whole-body strip of what ESPN sent (the recorded parts, re-assembled)
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
    const cached = await second.provider.getRosters(second.ref, 3);
    const spent = turns.now() - before;
    turns.stop();
    expect(second.sent).toHaveLength(0);
    expect(spent).toBeGreaterThan(fresh.value.length);
    expect(JSON.stringify(cached.value)).toBe(JSON.stringify(fresh.value));
  });
});
