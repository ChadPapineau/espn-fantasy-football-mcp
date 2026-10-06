// provider-yield.test.ts — the stall fix in the provider's read (plan 03 §1.2; plan 10 A16a): a
// warm read of a LARGE cached body (a 10-team roster, ~1 MB) yields to the event loop before its
// synchronous parse, so a tool's several reads never run as one macrotask; a small cached body
// (settings) does not yield, so coalescing and ordering are unchanged.
import { describe, expect, it } from "vitest";
import { YIELD_BEFORE_PARSE_CHARS } from "../../src/providers/espn/request.js";
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
