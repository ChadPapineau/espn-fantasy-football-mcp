// budget-stale.test.ts — Stage C remediation, round 3 (finding espn-budget-spent-skips-stale-fallback;
// plan 01 §6 "past the deadline the call returns stale data or partial: true — or
// ESPN_UPSTREAM_UNAVAILABLE when nothing is cached", §5.6 a 4th request "returns what it has", plan
// 05 §4.1 black-hole row): a read whose call can no longer pay for a request — its ≤ 20 s deadline
// passed or its three requests are spent — serves a usable cached entry as degraded, exactly as when
// ESPN itself fails (breaker, limiter, timeout), under the code the shortfall maps to (src/mcp
// fromBudgetSignal: deadline → ESPN_UPSTREAM_UNAVAILABLE, cap → RATE_LIMITED). With nothing usable the
// budget signal stands (the tool's `partial: true`). Before, the budget check threw before the cache
// was consulted, so a call whose first read spent the deadline answered ESPN_UPSTREAM_UNAVAILABLE
// with an hour-old roster in the cache. Recorded fixtures and an injected fetch; no network, no cookie.
import { describe, expect, it } from "vitest";
import { fixedClock } from "../../../src/domain/clock.js";
import { createFixtureFetch } from "../../../src/providers/espn/fixture.js";
import {
  createUpstreamBudget,
  degradedWarning,
  isUpstreamBudgetExhausted,
  MAX_UPSTREAM_PER_CALL,
  PER_CALL_DEADLINE_MS,
} from "../../../src/providers/platform.js";
import { FIXTURES, makeWorld, MemoryCache, NOW_ISO } from "./helpers.js";

const WEEK = 3;
const RID = "r-0123456789ab";
const MIN = 60_000;
const HOUR = 60 * MIN;

/** A world whose roster (and settings) were read once, `ageMs` ago. */
async function warmWorld(ageMs: number) {
  const w = makeWorld({ slot: "league-a" });
  w.clock.advance(-ageMs);
  await w.provider.getRosters(w.ref, WEEK);
  w.clock.advance(ageMs);
  return w;
}

/** A budget whose deadline already passed (the call's earlier reads took > 20 s). */
const passed = (nowMs: number) => createUpstreamBudget(RID, nowMs - PER_CALL_DEADLINE_MS - 1);
/** A budget whose three requests were already spent by the call. */
function spent(nowMs: number) {
  const b = createUpstreamBudget(RID, nowMs);
  for (let i = 0; i < MAX_UPSTREAM_PER_CALL; i++) b.tryConsume();
  return b;
}

describe("a spent call budget serves a usable cached entry, as an ESPN failure does", () => {
  it("the deadline passed: the stale roster is served (ESPN_UPSTREAM_UNAVAILABLE), nothing sent", async () => {
    const w = await warmWorld(30 * MIN); // the roster is stale (5 min TTL), inside its 24 h hard limit
    const before = w.sent.length;
    const r = await w.provider.getRosters(w.ref, WEEK, { budget: passed(w.clock.nowMs()) });
    expect(w.sent.length).toBe(before);
    expect(r.value.length).toBe(10);
    expect(r.stamp.cache).toBe("stale");
    expect(r.stamp.degraded).toEqual({
      code: "ESPN_UPSTREAM_UNAVAILABLE",
      served: "stale_cache",
      hard_limit_suspended: false,
    });
    // what the envelope warns for it (buildEnvelope adds it for every degraded input)
    expect(degradedWarning(r.stamp.source, r.stamp.degraded!)).toBe(
      "ESPN_UPSTREAM_UNAVAILABLE: espn:mRoster served from stale cache",
    );
  });

  it("the 3-request cap is spent: the stale roster is served (RATE_LIMITED), nothing sent", async () => {
    const w = await warmWorld(30 * MIN);
    const before = w.sent.length;
    const budget = spent(w.clock.nowMs());
    const r = await w.provider.getRosters(w.ref, WEEK, { budget });
    expect(w.sent.length).toBe(before);
    expect(budget.used()).toBe(MAX_UPSTREAM_PER_CALL);
    expect(r.stamp.degraded).toEqual({
      code: "RATE_LIMITED",
      served: "stale_cache",
      hard_limit_suspended: false,
    });
  });

  it("nothing cached: the budget signal stands — the tool's partial answer, as before", async () => {
    const w = makeWorld({ slot: "league-a" });
    for (const budget of [passed(w.clock.nowMs()), spent(w.clock.nowMs())]) {
      const e = await w.provider.getRosters(w.ref, WEEK, { budget }).catch((x: unknown) => x);
      expect(isUpstreamBudgetExhausted(e)).toBe(true);
    }
    expect(w.sent).toEqual([]);
  });

  it("only data past its hard limit: still the budget signal (partial), never STALE_ONLY; allow_stale serves it", async () => {
    const w = await warmWorld(25 * HOUR); // the roster is past its 24 h hard limit
    const e = await w.provider
      .getRosters(w.ref, WEEK, { budget: spent(w.clock.nowMs()) })
      .catch((x: unknown) => x);
    // (the settings, 25 h old, are inside their 7 d hard limit: served stale; the roster is not)
    expect(isUpstreamBudgetExhausted(e)).toBe(true);
    expect((e as { missing: unknown }).missing).toEqual({ view: "mRoster", reason: "budget" });
    const r = await w.provider.getRosters(w.ref, WEEK, {
      budget: spent(w.clock.nowMs()),
      allow_stale: true,
    });
    expect(r.stamp.degraded?.code).toBe("RATE_LIMITED");
    expect(r.value.length).toBe(10);
  });

  it("a fresh entry needs no budget at all (a hit), whatever the budget says", async () => {
    const w = await warmWorld(MIN);
    const r = await w.provider.getRosters(w.ref, WEEK, { budget: passed(w.clock.nowMs()) });
    expect(r.stamp.cache).toBe("hit");
    expect(r.stamp.degraded).toBeNull();
  });
});

describe("the black hole (plan 05 §4.1): stale data within 20 s, never ESPN_UPSTREAM_UNAVAILABLE while cached", () => {
  it("the settings read spends the deadline on two timeouts and is served stale; the roster after it is served stale too", async () => {
    const clock = fixedClock(NOW_ISO);
    const cache = new MemoryCache();
    const fixtures = createFixtureFetch({ dir: FIXTURES, league: "league-a" });
    let blackhole = false;
    const fetch = (url: string, init: RequestInit): Promise<Response> => {
      if (!blackhole) return fixtures(url, init);
      // a black hole: 15 s pass on the clock, then the attempt's own timer aborts it
      clock.advance(15_000);
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    };
    const w = makeWorld({ fetch, cache, clock, over: { attemptTimeoutMs: 50 } });
    // 25 h ago the settings and the roster were read; 1 h ago the roster again (the settings were
    // still inside their 24 h TTL then)
    clock.advance(-25 * HOUR);
    await w.provider.getRosters(w.ref, WEEK);
    clock.advance(24 * HOUR - 10_000);
    await w.provider.getRosters(w.ref, WEEK);
    expect(w.sent.map((s) => new URL(s.url).searchParams.getAll("view").join("+"))).toEqual([
      "mSettings+mNav",
      "mRoster",
      "mRoster",
    ]);
    clock.advance(HOUR + 10_000);
    blackhole = true;
    const before = w.sent.length;
    const budget = createUpstreamBudget(RID, clock.nowMs());
    const r = await w.provider.getRosters(w.ref, WEEK, { budget });
    // the roster read could not start (the deadline was spent) and served the cached roster
    expect(budget.canStart(clock.nowMs())).toBe(false);
    expect(r.stamp.source).toBe("espn:mRoster");
    expect(r.stamp.degraded?.code).toBe("ESPN_UPSTREAM_UNAVAILABLE");
    expect(r.value.length).toBe(10);
    // the settings read's two attempts, nothing more
    expect(w.sent.slice(before).map((s) => new URL(s.url).searchParams.getAll("view"))).toEqual([
      ["mSettings", "mNav"],
      ["mSettings", "mNav"],
    ]);
  });
});
