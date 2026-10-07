// provider-yield.test.ts — the stall fix in the provider's read (plan 03 §1.2; plan 10 A16a): a
// warm read of a LARGE cached body (a 10-team roster, ~1 MB) yields to the event loop before its
// synchronous parse, so a tool's several reads never run as one macrotask; a small cached body
// (settings) does not yield, so coalescing and ordering are unchanged. A COLD read of a large body
// lets the loop run between its parse, drift check, schema check and cache strip (the full-toolset
// stall probe found those phases at ~100 ms as one macrotask). A warm read of an UNCHANGED stored
// entry is served from the parse memo (deep-frozen): no parse, no yield; a new stored version
// parses again.
import { describe, expect, it } from "vitest";
import { deepFreeze, YIELD_BEFORE_PARSE_CHARS } from "../../src/providers/espn/request.js";
import { makeWorld } from "../providers/espn/helpers.js";

/** Whether a setImmediate queued just before `work` starts runs before `work` resolves. */
async function yieldsDuring(work: () => Promise<unknown>): Promise<boolean> {
  let ran = false;
  setImmediate(() => {
    ran = true;
  });
  const p = work();
  const done = await p.then(() => ran);
  return done;
}

describe("the provider yields before parsing a large cached body", () => {
  it("a warm roster read (over the threshold) lets the loop run; a warm settings read does not", async () => {
    const w = makeWorld({ slot: "league-b" });
    await w.provider.getLeague(w.ref);
    await w.provider.getRosters(w.ref, 3);
    const rosterKey = [...w.cache.map.keys()].find((k) => k.includes("mRoster"));
    expect(rosterKey).toBeDefined();
    expect(w.cache.map.get(rosterKey ?? "")?.parsed_json.length).toBeGreaterThan(
      YIELD_BEFORE_PARSE_CHARS,
    );
    expect(await yieldsDuring(() => w.provider.getRosters(w.ref, 3))).toBe(true);
    // the settings body is small: served without a yield (microtasks only)
    expect(await yieldsDuring(() => w.provider.getLeague(w.ref))).toBe(false);
  });
});

/** How many loop turns (a self-requeuing setImmediate) ran while `work` was pending. */
async function turnsDuring(work: () => Promise<unknown>): Promise<number> {
  let turns = 0;
  let done = false;
  const tick = (): void => {
    if (done) return;
    turns++;
    setImmediate(tick);
  };
  setImmediate(tick);
  await work();
  done = true;
  return turns;
}

describe("the provider parses a large cached body in turns of its own", () => {
  it("JSON, view schema and freeze each get a turn (a cold 1 MB roster made a 30–40 ms block)", async () => {
    const w = makeWorld({ slot: "league-b" });
    await w.provider.getLeague(w.ref);
    await w.provider.getRosters(w.ref, 3);
    // a new stored version: the warm read parses it (no memo) — at least three loop turns
    const key = [...w.cache.map.keys()].find((k) => k.includes("mRoster")) ?? "";
    const e = w.cache.map.get(key);
    if (e === undefined) throw new Error("no roster entry");
    w.cache.map.set(key, {
      ...e,
      fetched_at: new Date(Date.parse(e.fetched_at) + 1).toISOString(),
    });
    expect(await turnsDuring(() => w.provider.getRosters(w.ref, 3))).toBeGreaterThanOrEqual(3);
    // memoised now: no turn at all
    expect(await turnsDuring(() => w.provider.getRosters(w.ref, 3))).toBe(0);
  });
});

describe("the provider yields between the phases of a large fresh body", () => {
  it("a cold roster read lets the loop turn at least three times (parse, drift, schema, strip)", async () => {
    const w = makeWorld({ slot: "league-b" });
    await w.provider.getLeague(w.ref);
    expect(await turnsDuring(() => w.provider.getRosters(w.ref, 3))).toBeGreaterThanOrEqual(3);
  });
});

describe("the parse memo", () => {
  it("a second warm read of the unchanged entry skips the parse (no yield, equal value); a new stored version parses again", async () => {
    const w = makeWorld({ slot: "league-b" });
    await w.provider.getLeague(w.ref);
    const cold = await w.provider.getRosters(w.ref, 3);
    expect(await yieldsDuring(() => w.provider.getRosters(w.ref, 3))).toBe(true); // parses, memoises
    let warm: unknown;
    expect(
      await yieldsDuring(async () => {
        warm = await w.provider.getRosters(w.ref, 3);
      }),
    ).toBe(false);
    expect(JSON.stringify((warm as { value: unknown }).value)).toBe(JSON.stringify(cold.value));
    // the stored entry changes (a re-fetch writes a new fetched_at): parsed again
    const key = [...w.cache.map.keys()].find((k) => k.includes("mRoster")) ?? "";
    const e = w.cache.map.get(key);
    if (e === undefined) throw new Error("no roster entry");
    w.cache.map.set(key, {
      ...e,
      fetched_at: new Date(Date.parse(e.fetched_at) + 1000).toISOString(),
    });
    expect(await yieldsDuring(() => w.provider.getRosters(w.ref, 3))).toBe(true);
  });

  it("deepFreeze freezes every nested object and array, tolerates cycles and primitives", () => {
    const v: { a: { b: number[] }; c?: unknown } = { a: { b: [1, 2] } };
    v.c = v;
    expect(deepFreeze(v)).toBe(v);
    expect(Object.isFrozen(v) && Object.isFrozen(v.a) && Object.isFrozen(v.a.b)).toBe(true);
    expect(() => {
      v.a.b.push(3);
    }).toThrow(TypeError);
    expect(deepFreeze(5)).toBe(5);
    expect(deepFreeze(null)).toBeNull();
  });
});
