// contention.test.ts — write classes under a concurrent writer (plan 01 §5.3; plan 03 §1.1 step 3
// busy_timeout 5000; plan 05 §2 "busy_timeout under a concurrent writer", §4.1 "SQLite write lock held
// by another process"; T-15(c)): while a SECOND process holds store.sqlite's writer lock, a
// best-effort cache write becomes a counted miss within its short wait (and later ones skip without
// waiting), a required write waits and lands once the lock is released, and a required write whose
// wait runs out fails closed with StoreBusyError. Reads never wait on the writer (WAL).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BEST_EFFORT_BACKOFF_MS, isBusyError, WriteExecutor } from "../../src/store/sqlite.js";
import { storeInternalsOf } from "../../src/store/store.js";
import { BEST_EFFORT_BUSY_MS, StoreBusyError, type Store } from "../../src/store/types.js";
import { openStore, tempCache, type TempCache } from "./helpers/env.js";
import { run, type Child } from "./helpers/spawn.js";

let t: TempCache;
let s: Store;
let holder: Child | null = null;
beforeEach(() => {
  t = tempCache();
});
afterEach(async () => {
  if (holder !== null) {
    holder.proc.kill("SIGKILL");
    await holder.exited();
    holder = null;
  }
  s.close();
  t.cleanup();
});

const probe = (at: string) => ({
  at,
  kind: "host" as const,
  ok: true,
  status: "green" as const,
  upstream_status: 200,
  error: null,
});

async function holdLock(ms: number): Promise<void> {
  holder = run("lock-holder.mjs", [t.storePath, String(ms)]);
  await holder.waitFor(/^LOCKED/);
}

describe("while another process holds the writer lock", () => {
  it("a best-effort write is a counted miss within its short wait; the next ones skip at once", async () => {
    s = openStore(t);
    await holdLock(2500);
    const t0 = performance.now();
    expect(s.repos.pointsCache.put("l1", "s", "{}")).toEqual({ written: false, reason: "busy" });
    const first = performance.now() - t0;
    // it waited (a little) — the latency budget itself is contention.perf.test.ts's
    expect(first).toBeGreaterThanOrEqual(BEST_EFFORT_BUSY_MS * 0.8);
    expect(first).toBeLessThan(2000);
    const t1 = performance.now();
    expect(
      s.repos.espnCache.put({
        key: "k",
        parsed_json: "{}",
        fetched_at: "2026-10-06T12:00:00.000Z",
        server_time: null,
        etag: null,
        http_status: 200,
        raw_body: null,
      }),
    ).toEqual({ written: false, reason: "busy" });
    expect(performance.now() - t1).toBeLessThan(BEST_EFFORT_BUSY_MS * 0.8); // backoff window: no wait
    expect(s.stats().cache_misses_busy).toBe(2);
    // reads never wait on a writer (WAL)
    expect(s.repos.pointsCache.get("l1", "s")).toBeNull();
  });

  it("a required write waits for the lock and lands when it is released", async () => {
    s = openStore(t);
    await holdLock(600);
    const t0 = performance.now();
    s.repos.probeLog.record(probe("2026-10-06T12:00:00.000Z"));
    expect(performance.now() - t0).toBeGreaterThan(200);
    await holder?.waitFor(/^RELEASED/);
    expect(s.repos.probeLog.recent(10)).toHaveLength(2); // the holder's row and ours
  });

  it("a required write whose busy_timeout runs out fails closed (StoreBusyError), nothing written", async () => {
    s = openStore(t, {}, { busyTimeoutMs: 200 });
    await holdLock(3000);
    let err: unknown;
    try {
      s.repos.limiter.tryRecord({
        at: "2026-10-06T12:00:00.000Z",
        keyless: false,
        origin: "server",
        windows: [],
        dailyCap: null,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreBusyError);
    expect((err as StoreBusyError).table).toBe("espn_requests");
    expect((err as StoreBusyError).effCode).toBe("INTERNAL");
    expect(() => {
      s.repos.credentialState.clear();
    }).toThrow(StoreBusyError);
    holder?.proc.kill("SIGKILL");
    await holder?.exited();
    holder = null;
    expect(s.repos.limiter.countSince("2026-01-01T00:00:00.000Z")).toBe(0);
  });
});

describe("the executor itself", () => {
  it("non-busy errors propagate from both classes; the backoff window expires", async () => {
    s = openStore(t);
    const deps = storeInternalsOf(s);
    if (deps === null) throw new Error("no internals");
    const w = new WriteExecutor(deps.db, 5000, 50);
    expect(() =>
      w.bestEffort(() => {
        throw new Error("not busy");
      }),
    ).toThrow("not busy");
    expect(() =>
      w.required("x", () => {
        throw new Error("also not busy");
      }),
    ).toThrow("also not busy");
    expect(isBusyError({ errcode: 5 })).toBe(true);
    expect(isBusyError({ errcode: 517 })).toBe(true); // SQLITE_BUSY_SNAPSHOT
    expect(isBusyError({ errcode: 6 })).toBe(true);
    expect(isBusyError({ errcode: 19 })).toBe(false);
    expect(isBusyError(null)).toBe(false);
    expect(isBusyError("busy")).toBe(false);
    // a busy miss opens the backoff window; after it, writes try again
    await holdLock(BEST_EFFORT_BACKOFF_MS + 600);
    expect(
      w.bestEffort(() => {
        deps.db
          .prepare(
            "INSERT INTO points_cache (line_hash, settings_hash, result_json, used_ms) VALUES ('a','b','{}',1)",
          )
          .run();
      }),
    ).toEqual({ written: false, reason: "busy" });
    await holder?.waitFor(/^RELEASED/, 10_000);
    await new Promise((r) => setTimeout(r, BEST_EFFORT_BACKOFF_MS + 20));
    expect(
      w.bestEffort(() => {
        deps.db
          .prepare(
            "INSERT INTO points_cache (line_hash, settings_hash, result_json, used_ms) VALUES ('a','b','{}',1)",
          )
          .run();
      }),
    ).toEqual({ written: true });
    expect(w.cacheMissesBusy).toBe(1);
  });
});
