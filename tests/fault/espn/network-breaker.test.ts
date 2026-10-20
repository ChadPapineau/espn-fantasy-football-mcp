// network-breaker.test.ts — the ESPN breaker counts every network failure (plan 05 §4.1 fault matrix:
// "timeout (AbortError), ECONNRESET → same [as 500/503]: 3 attempts; breaker opens after 3
// consecutive"; "ENOTFOUND / ECONNREFUSED → … immediately; breaker counter; zero retries"; plan 01
// §5.7 "a dead host costs 3 requests, not a request per tool call"), a certificate failure is never
// retried (src/http's `tls`), and the caller's own cancellation is no verdict at all. Stage C
// findings espn-breaker-ignores-resets and espn-tls-failure-retried-transient: a resetting edge used
// to cost up to 3 requests per read on every call, forever, with the breaker never opening, and a
// certificate failure 3 attempts per read. No network: every fetch is scripted.
import { describe, expect, it } from "vitest";
import { createUpstreamBudget } from "../../../src/providers/platform.js";
import { jsonResponse, loadFixture, makeWorld, SEASON } from "../../providers/espn/helpers.js";

const wrapped = (code: string): TypeError =>
  new TypeError("fetch failed", {
    cause: Object.assign(new Error("socket hang up"), { code }),
  });
const pro = (): Response => jsonResponse(loadFixture("recorded/season/proTeamSchedules_wl.json"));

describe("a resetting edge: retried like a 5xx, and counted (plan 05 §4.1)", () => {
  it.each([
    ["ECONNRESET", wrapped("ECONNRESET")],
    ["UND_ERR_SOCKET", wrapped("UND_ERR_SOCKET")],
    ["EPIPE", wrapped("EPIPE")],
    ["a bare fetch failed", new TypeError("fetch failed")],
  ])("%s: 3 attempts, the breaker opens, later calls send nothing", async (_name, failure) => {
    let calls = 0;
    const w = makeWorld({ fetch: () => (calls++, Promise.reject(failure)) });
    await expect(w.provider.getProSchedule(SEASON)).rejects.toMatchObject({
      effCode: "ESPN_UPSTREAM_UNAVAILABLE",
    });
    expect(calls).toBe(3);
    expect(w.limiter.rows.map((r) => r.outcome)).toEqual([
      "network_error",
      "network_error",
      "network_error",
    ]);
    expect(w.provider.transportStatus()).toMatchObject({
      breaker_open: true,
      consecutive_failures: 3,
    });
    // the finding's pattern: five calls a second apart — now 3 requests in all, not 15
    for (let i = 0; i < 4; i++) {
      w.clock.advance(1000);
      await expect(w.provider.getProSchedule(SEASON)).rejects.toMatchObject({
        effCode: "ESPN_UPSTREAM_UNAVAILABLE",
        effDetails: { reason: "breaker_open" },
      });
    }
    expect(calls).toBe(3);
  });

  it("a league read under a call budget: [3, 0, 0] requests over three calls, not [6, 6, 6]", async () => {
    let calls = 0;
    const w = makeWorld({ fetch: () => (calls++, Promise.reject(wrapped("ECONNRESET"))) });
    const perCall: number[] = [];
    for (let i = 0; i < 3; i++) {
      const before = calls;
      const budget = createUpstreamBudget("r-0123456789ab", w.clock.nowMs());
      await w.provider.getRosters(w.ref, 1, { budget }).catch(() => undefined);
      perCall.push(calls - before);
      w.clock.advance(60_000);
    }
    expect(perCall).toEqual([3, 0, 0]);
    expect(w.provider.transportStatus().breaker_open).toBe(true);
  });

  it("the same as the 503 baseline, and a success closes it again after the open window", async () => {
    let fail = true;
    let calls = 0;
    const w = makeWorld({
      fetch: () => (calls++, fail ? Promise.reject(wrapped("ECONNRESET")) : Promise.resolve(pro())),
    });
    await w.provider.getProSchedule(SEASON).catch(() => undefined);
    expect(calls).toBe(3);
    // past the 5-minute window one request goes out again; its success resets the count
    w.clock.advance(300_000);
    fail = false;
    await expect(w.provider.getProSchedule(SEASON)).resolves.toBeTruthy();
    expect(calls).toBe(4);
    expect(w.provider.transportStatus()).toMatchObject({
      breaker_open: false,
      consecutive_failures: 0,
    });
  });
});

describe("a refused connection or a failed lookup: never retried, still counted", () => {
  it.each(["ENOTFOUND", "ECONNREFUSED", "EHOSTUNREACH"])(
    "%s: one request per call; the third call opens the breaker; the fourth sends nothing",
    async (code) => {
      let calls = 0;
      const w = makeWorld({ fetch: () => (calls++, Promise.reject(wrapped(code))) });
      for (let i = 1; i <= 3; i++) {
        await expect(w.provider.getProSchedule(SEASON)).rejects.toMatchObject({
          effCode: "ESPN_UPSTREAM_UNAVAILABLE",
          effDetails: { reason: "unreachable" },
        });
        expect(calls).toBe(i);
        w.clock.advance(1000);
      }
      expect(w.sleeps).toEqual([]);
      expect(w.provider.transportStatus()).toMatchObject({
        breaker_open: true,
        consecutive_failures: 3,
      });
      await expect(w.provider.getProSchedule(SEASON)).rejects.toMatchObject({
        effDetails: { reason: "breaker_open" },
      });
      expect(calls).toBe(3);
    },
  );
});

describe("a certificate failure: never retried, counted (src/http `tls`)", () => {
  it("DEPTH_ZERO_SELF_SIGNED_CERT: one request per call (was 3), the breaker opens after 3 calls", async () => {
    let calls = 0;
    const w = makeWorld({
      fetch: () => (calls++, Promise.reject(wrapped("DEPTH_ZERO_SELF_SIGNED_CERT"))),
    });
    await expect(w.provider.getProSchedule(SEASON)).rejects.toMatchObject({
      effCode: "ESPN_UPSTREAM_UNAVAILABLE",
      effDetails: { reason: "tls" },
    });
    expect(calls).toBe(1);
    expect(w.sleeps).toEqual([]);
    expect(w.provider.transportStatus().consecutive_failures).toBe(1);
    for (let i = 0; i < 2; i++) {
      w.clock.advance(5000);
      await w.provider.getProSchedule(SEASON).catch(() => undefined);
    }
    expect(calls).toBe(3);
    expect(w.provider.transportStatus()).toMatchObject({
      breaker_open: true,
      consecutive_failures: 3,
    });
    await w.provider.getProSchedule(SEASON).catch(() => undefined);
    expect(calls).toBe(3);
  });
});

describe("the persisted outcomes: another process sees the same breaker (plan 01 §6)", () => {
  it("a second provider over the same limiter rows sends nothing while the first's resets are fresh", async () => {
    let calls = 0;
    const a = makeWorld({ fetch: () => (calls++, Promise.reject(wrapped("ECONNRESET"))) });
    await a.provider.getProSchedule(SEASON).catch(() => undefined);
    expect(calls).toBe(3);
    let bCalls = 0;
    const b = makeWorld({
      limiter: a.limiter,
      clock: a.clock,
      fetch: () => (bCalls++, Promise.resolve(pro())),
    });
    expect(b.provider.transportStatus()).toMatchObject({
      breaker_open: true,
      consecutive_failures: 3,
    });
    await expect(b.provider.getProSchedule(SEASON)).rejects.toMatchObject({
      effDetails: { reason: "breaker_open" },
    });
    expect(bCalls).toBe(0);
  });
});

describe("the caller's own cancellation is no verdict (never counted, never retried)", () => {
  it("three cancelled calls leave the breaker closed; their rows read client_error", async () => {
    let calls = 0;
    const hanging = (_u: string, init: RequestInit): Promise<Response> =>
      new Promise<Response>((_res, rej) => {
        calls++;
        init.signal?.addEventListener("abort", () => {
          rej(new DOMException("This operation was aborted", "AbortError"));
        });
      });
    const w = makeWorld({ fetch: hanging });
    for (let i = 0; i < 3; i++) {
      const budget = createUpstreamBudget("r-0123456789ab", w.clock.nowMs());
      const p = w.provider.getProSchedule(SEASON, { budget }).catch((e: unknown) => e);
      await new Promise((r) => setTimeout(r, 5));
      budget.abort();
      expect(await p).toMatchObject({
        effCode: "ESPN_UPSTREAM_UNAVAILABLE",
        effDetails: { reason: "aborted" },
      });
      w.clock.advance(1000);
    }
    // let the aborted attempts unwind and record their rows
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toBe(3);
    expect(w.sleeps).toEqual([]);
    expect(w.limiter.rows.map((r) => r.outcome)).toEqual([
      "client_error",
      "client_error",
      "client_error",
    ]);
    expect(w.provider.transportStatus()).toMatchObject({
      breaker_open: false,
      consecutive_failures: 0,
    });
  });
});
