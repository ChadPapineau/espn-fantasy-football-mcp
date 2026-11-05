// read-chain-turns.test.ts — F1, round 4d: a tool's reads chain as microtasks, and on the Linux CI
// runner espn_analyze_matchup pre held the CPU 19.8–23.6 ms in one chain of cache lookups and small
// bodies' parses (53 SQLite statements, the JSON and schema parses — the per-tool notice's split
// and its profiled pass). Each read now starts a turn of its own once the slice has spent its share,
// and a small body's parse phases do too (request.ts `read`, `parseCached`, `success`: turnIfSpent).
// Counted, no clock: with a meter that spends a slice a read every one of those checks gives up the
// turn; with a frozen meter none does past the account's first check; the values are the same.
import { describe, expect, it } from "vitest";
import { grantedTurns } from "../../../src/domain/analytics/cooperative.js";
import { frozenMeter, spendingMeter, withSliceMeter } from "../../domain/analytics/slice-meter.js";
import { MemoryCache, makeWorld } from "./helpers.js";

/** The chain a cold analytics call makes: several small league reads, one after another. */
async function chain(w: ReturnType<typeof makeWorld>): Promise<string> {
  const out: unknown[] = [];
  out.push((await w.provider.getLeague(w.ref)).value);
  out.push((await w.provider.getStandings(w.ref)).value);
  out.push((await w.provider.getMatchups(w.ref)).value);
  out.push((await w.provider.getLeagueRules(w.ref)).value);
  return JSON.stringify(out);
}

describe("a chain of small reads gives up the turn between reads once the slice is spent (F1, round 4d)", () => {
  it("cached (a second process over the same store): a turn a read when spent, none when not, the same values", async () => {
    const cache = new MemoryCache();
    const seed = makeWorld({ cache });
    const fresh = await chain(seed);

    const spent = makeWorld({ cache });
    const a = grantedTurns();
    const cachedSpent = await withSliceMeter(spendingMeter(), () => chain(spent));
    const spentTurns = grantedTurns() - a;

    const idle = makeWorld({ cache });
    const b = grantedTurns();
    const cachedIdle = await withSliceMeter(frozenMeter, () => chain(idle));
    const idleTurns = grantedTurns() - b;

    expect(cachedSpent).toBe(fresh);
    expect(cachedIdle).toBe(fresh);
    // a spent slice: each of the four reads starts a turn of its own, and each small cached body's
    // JSON parse, schema parse and freeze are turns apart (three more a read) — counted, not timed;
    // a frozen meter takes none of them (past the account's first check), only the reads' fixed
    // passes, the same in both runs
    expect(spentTurns - idleTurns).toBeGreaterThanOrEqual(4 * 4 - 1);
    // the later processes read from the store (what one cached, the next serves)
    expect(seed.sent.length).toBeGreaterThan(spent.sent.length);
    expect(idle.sent.length).toBeLessThanOrEqual(spent.sent.length);
  });

  it("fresh: a small body's parse, drift check, schema parse and strip are turns apart when spent", async () => {
    const spent = makeWorld({ cache: new MemoryCache() });
    const a = grantedTurns();
    const v1 = await withSliceMeter(spendingMeter(), () => chain(spent));
    const spentTurns = grantedTurns() - a;
    const idle = makeWorld({ cache: new MemoryCache() });
    const b = grantedTurns();
    const v2 = await withSliceMeter(frozenMeter, () => chain(idle));
    const idleTurns = grantedTurns() - b;
    expect(v1).toBe(v2);
    expect(spentTurns - idleTurns).toBeGreaterThanOrEqual(spent.sent.length * 4);
    expect(idle.sent.length).toBeLessThanOrEqual(spent.sent.length);
  });
});
