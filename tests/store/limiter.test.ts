// limiter.test.ts — espn_requests, the cross-process token bucket (plan 01 §6; plan 06 §1.4 +
// changelog V7 daily caps over JOB-origin rows of the same kind; plan 05 §2 "two limiter instances
// sharing one SQLite file", §4.1 the two-process row): every window and the cap checked and the row
// inserted in ONE BEGIN IMMEDIATE; the outcomes the breaker and the 304 count derive from; prune.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { breakerFromOutcomes } from "../../src/providers/platform.js";
import { DAY_MS } from "../../src/store/repos/limiter.js";
import type { LimiterRequest, Store } from "../../src/store/types.js";
import { openStore, tempCache, type TempCache } from "./helpers/env.js";
import { run } from "./helpers/spawn.js";

let t: TempCache;
let s: Store;
beforeEach(() => {
  t = tempCache();
  s = openStore(t);
});
afterEach(() => {
  s.close();
  t.cleanup();
});

const iso = (ms: number): string => new Date(ms).toISOString();
const T = Date.parse("2026-10-06T18:00:00.000Z");
const DAY0 = Date.parse("2026-10-06T04:00:00.000Z");

function req(atMs: number, over: Partial<LimiterRequest> = {}): LimiterRequest {
  return {
    at: iso(atMs),
    keyless: false,
    origin: "server",
    windows: [
      { start: iso(atMs - 60_000), max: 30 },
      { start: iso(atMs - 1000), max: 1 },
    ],
    dailyCap: null,
    ...over,
  };
}

describe("tryRecord", () => {
  it("records with room; refuses inside 1 s with the wait that frees the slot", () => {
    const a = s.repos.limiter.tryRecord(req(T));
    expect(a).toEqual({ ok: true, id: 1 });
    expect(s.repos.limiter.tryRecord(req(T + 400))).toEqual({
      ok: false,
      reason: "window",
      retry_after_ms: 600,
    });
    // the window is closed: a row exactly one window-length old still counts (conservative)
    expect(s.repos.limiter.tryRecord(req(T + 1000))).toEqual({
      ok: false,
      reason: "window",
      retry_after_ms: 1,
    });
    expect(s.repos.limiter.tryRecord(req(T + 1001))).toEqual({ ok: true, id: 2 });
  });

  it("a full minute window waits until its oldest row leaves", () => {
    for (let i = 0; i < 30; i++) expect(s.repos.limiter.tryRecord(req(T + i * 1500)).ok).toBe(true);
    const now = T + 30 * 1500;
    // window starts at now − 60 000 = T − 15 000 → all 30 rows are inside; the oldest is T
    const refusal = s.repos.limiter.tryRecord(req(now));
    expect(refusal).toEqual({ ok: false, reason: "window", retry_after_ms: 15_000 });
    expect(s.repos.limiter.countSince(iso(T - 1))).toBe(30);
  });

  it("the daily cap counts JOB rows of the same kind since dayStart; the wait runs to the next day", () => {
    const job = (atMs: number, keyless: boolean, max: number): LimiterRequest =>
      req(atMs, { origin: "job", keyless, windows: [], dailyCap: { dayStart: iso(DAY0), max } });
    expect(s.repos.limiter.tryRecord(job(T, false, 2)).ok).toBe(true);
    expect(s.repos.limiter.tryRecord(job(T + 1, false, 2)).ok).toBe(true);
    // server rows and keyless job rows do not count against the cookie cap
    expect(s.repos.limiter.tryRecord(req(T + 5000)).ok).toBe(true);
    expect(s.repos.limiter.tryRecord(job(T + 10_000, true, 2)).ok).toBe(true);
    expect(s.repos.limiter.tryRecord(job(T + 20_000, false, 2))).toEqual({
      ok: false,
      reason: "daily_cap",
      retry_after_ms: DAY0 + DAY_MS - (T + 20_000),
    });
    // a cap of 0 refuses at once
    expect(s.repos.limiter.tryRecord(job(T + 30_000, true, 0)).ok).toBe(false);
  });

  it("refuses malformed requests (and caps on server requests)", () => {
    const bad: LimiterRequest[] = [
      req(T, { at: "now" }),
      req(T, { keyless: "yes" as never }),
      req(T, { origin: "browser" as never }),
      req(T, { windows: [{ start: iso(T + 1), max: 1 }] }),
      req(T, { windows: [{ start: iso(T - 1), max: 0 }] }),
      req(T, { windows: Array.from({ length: 9 }, () => ({ start: iso(T - 1), max: 1 })) }),
      req(T, { dailyCap: { dayStart: iso(DAY0), max: 5 } }),
      req(T, { origin: "job", dailyCap: { dayStart: iso(T + 1), max: 5 } }),
      req(T, { origin: "job", dailyCap: { dayStart: iso(DAY0), max: -1 } }),
    ];
    for (const r of bad) expect(() => s.repos.limiter.tryRecord(r)).toThrow(RangeError);
    expect(s.repos.limiter.countSince(iso(0))).toBe(0);
  });
});

describe("outcomes, counts and prune", () => {
  it("recordOutcome; recentOutcomes newest first (pending included); 304 count; countToday", () => {
    const ids: number[] = [];
    const kinds: [boolean, "server" | "job"][] = [
      [false, "server"],
      [true, "server"],
      [false, "job"],
      [true, "job"],
      [true, "job"],
    ];
    kinds.forEach(([keyless, origin], i) => {
      const v = s.repos.limiter.tryRecord(req(T + i * 2000, { keyless, origin }));
      if (!v.ok) throw new Error("refused");
      ids.push(v.id);
    });
    s.repos.limiter.recordOutcome(ids[0]!, "server_error");
    s.repos.limiter.recordOutcome(ids[1]!, "timeout");
    s.repos.limiter.recordOutcome(ids[2]!, "not_modified");
    s.repos.limiter.recordOutcome(ids[3]!, "ok");
    expect(s.repos.limiter.recentOutcomes(3)).toEqual([
      { at: iso(T + 8000), outcome: "pending" },
      { at: iso(T + 6000), outcome: "ok" },
      { at: iso(T + 4000), outcome: "not_modified" },
    ]);
    expect(s.repos.limiter.count304Since(iso(T))).toBe(1);
    expect(s.repos.limiter.count304Since(iso(T + 5000))).toBe(0);
    expect(s.repos.limiter.countToday(iso(DAY0))).toEqual({
      server: { cookie: 1, keyless: 1 },
      job: { cookie: 1, keyless: 2 },
    });
    // the breaker derived from the persisted outcomes (any process can do this)
    const rows = s.repos.limiter
      .recentOutcomes(10)
      .map((r) => ({ at_ms: Date.parse(r.at), outcome: r.outcome }));
    expect(breakerFromOutcomes(rows, T + 9000).breaker_open).toBe(false);
    expect(() => {
      s.repos.limiter.recordOutcome(ids[0]!, "exploded" as never);
    }).toThrow(RangeError);
    expect(() => {
      s.repos.limiter.recordOutcome(0, "ok");
    }).toThrow(RangeError);
    expect(() => s.repos.limiter.recentOutcomes(0)).toThrow(RangeError);
    expect(() => s.repos.limiter.recentOutcomes(1001)).toThrow(RangeError);
  });

  it("three consecutive failures open the derived breaker", () => {
    for (let i = 0; i < 3; i++) {
      const v = s.repos.limiter.tryRecord(req(T + i * 2000));
      if (!v.ok) throw new Error("refused");
      s.repos.limiter.recordOutcome(v.id, "server_error");
    }
    const rows = s.repos.limiter
      .recentOutcomes(10)
      .map((r) => ({ at_ms: Date.parse(r.at), outcome: r.outcome }));
    expect(breakerFromOutcomes(rows, T + 5000).breaker_open).toBe(true);
  });

  it("prune removes rows older than the cutoff; ids are never reused", () => {
    s.repos.limiter.tryRecord(req(T));
    s.repos.limiter.tryRecord(req(T + 5000));
    expect(s.repos.limiter.prune(iso(T + 1000))).toBe(1);
    expect(s.repos.limiter.countSince(iso(0))).toBe(1);
    const v = s.repos.limiter.tryRecord(req(T + 10_000));
    expect(v).toEqual({ ok: true, id: 3 });
    expect(() => s.repos.limiter.prune("x")).toThrow(RangeError);
  });
});

describe("two processes, one limiter table (plan 05 §2, §4.1)", () => {
  it("never more than the window max in any window across both processes", async () => {
    const W = 2000;
    const MAX = 5;
    const SHORT = 150;
    const args = [
      t.storePath,
      t.datasetDir,
      t.backupDir,
      "3500",
      String(W),
      String(MAX),
      String(SHORT),
      "1",
    ];
    const a = run("limiter-child.mjs", args, { tsx: true });
    const b = run("limiter-child.mjs", args, { tsx: true });
    await Promise.all([a.waitFor(/^STARTED/), b.waitFor(/^STARTED/)]);
    const [ra, rb] = await Promise.all([a.waitFor(/^\{/, 30_000), b.waitFor(/^\{/, 30_000)]);
    expect(await a.exited()).toBe(0);
    expect(await b.exited()).toBe(0);
    const sa = JSON.parse(ra) as { sent: number; refused: number };
    const sb = JSON.parse(rb) as { sent: number; refused: number };
    expect(sa.sent).toBeGreaterThan(0);
    expect(sb.sent).toBeGreaterThan(0);
    expect(sa.refused + sb.refused).toBeGreaterThan(0);
    const ts = s.repos.limiter
      .recentOutcomes(1000)
      .map((r) => Date.parse(r.at))
      .sort((x, y) => x - y);
    expect(ts.length).toBe(sa.sent + sb.sent);
    for (let i = 0; i < ts.length; i++) {
      let inWindow = 0;
      let inShort = 0;
      for (let j = i; j < ts.length && ts[j]! <= ts[i]! + W; j++) {
        inWindow += 1;
        if (ts[j]! <= ts[i]! + SHORT) inShort += 1;
      }
      expect(inWindow).toBeLessThanOrEqual(MAX);
      expect(inShort).toBeLessThanOrEqual(1);
    }
    // every row's outcome was recorded by its process
    expect(s.repos.limiter.recentOutcomes(1000).every((r) => r.outcome === "ok")).toBe(true);
  });
});
