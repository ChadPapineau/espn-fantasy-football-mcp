// contention.perf.test.ts — the write-class latency budget (plan 01 §5.3; plan 05 §2 `store`, §4.1;
// T-15(c)): while another process holds store.sqlite's writer lock for 3 s, 50 tool-call-shaped
// operations (a read + a best-effort cache write each) all complete with every cache write a counted
// miss and p95 < 300 ms; a required write lands right after the release. Runs in the `process`
// project (wall-clock budgets never run under coverage).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Store } from "../../src/store/types.js";
import { openStore, percentile, tempCache, type TempCache } from "./helpers/env.js";
import { run, type Child } from "./helpers/spawn.js";

let t: TempCache;
let s: Store;
let holder: Child | null = null;
beforeEach(() => {
  t = tempCache();
  s = openStore(t);
});
afterEach(async () => {
  if (holder !== null) {
    holder.proc.kill("SIGKILL");
    await holder.exited();
  }
  s.close();
  t.cleanup();
});

describe("a 3-s foreign writer lock", () => {
  it("50 cache-missing operations: every cache write a miss, p95 < 300 ms; a required write after", async () => {
    holder = run("lock-holder.mjs", [t.storePath, "3000"]);
    await holder.waitFor(/^LOCKED/);
    const lat: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now();
      s.repos.pointsCache.get(`line-${String(i)}`, "s");
      expect(s.repos.pointsCache.put(`line-${String(i)}`, "s", "{}")).toEqual({
        written: false,
        reason: "busy",
      });
      lat.push(performance.now() - t0);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(percentile(lat, 95)).toBeLessThan(300);
    expect(s.stats().cache_misses_busy).toBe(50);
    await holder.waitFor(/^RELEASED/, 10_000);
    const t1 = performance.now();
    s.repos.probeLog.record({
      at: "2026-10-06T12:00:00.000Z",
      kind: "shape",
      ok: true,
      status: "green",
      upstream_status: 200,
      error: null,
    });
    expect(performance.now() - t1).toBeLessThan(300);
  });
});
