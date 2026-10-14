// retry-limiter.test.ts — Stage C remediation, round 1 (plan 01 §6; plan 06 §1.4 + changelog V7;
// plan 05 §4.1): every retry attempt is an upstream request and passes the cross-process limiter on
// its own (its own espn_requests row — the 1/s and 30/min windows, the job fleet's daily caps); a
// Retry-After never shortens the 1/2/4 s backoff (a `Retry-After: 0` 5xx was three sends in the same
// millisecond); no retry is sent once the breaker is open (another process's failures count); a
// timeout Node's fetch raises itself (UND_ERR_CONNECT_TIMEOUT, before the 15 s attempt timer) is
// counted by the breaker. Findings: limiter-retries-bypass-bucket, espn-connect-timeout-not-breaker-
// counted. No network: every fetch is scripted and stamps the fixed clock on each send.
import { describe, expect, it } from "vitest";
import { ESPN_JOB_DAILY_CAPS } from "../../../src/config/schema.js";
import type { FetchLike } from "../../../src/providers/espn/transport.js";
import {
  jsonResponse,
  loadFixture,
  makeWorld,
  NOW_ISO,
  SEASON,
} from "../../providers/espn/helpers.js";

const NOW = Date.parse(NOW_ISO);
const pro = (): Response => jsonResponse(loadFixture("recorded/season/proTeamSchedules_wl.json"));

/** A fetch answering from `answers` in turn (the last repeats), recording each send's clock time. */
function stamped(
  now: () => number,
  answers: (() => Response | Promise<Response>)[],
): FetchLike & { sentAt: number[] } {
  const sentAt: number[] = [];
  const f: FetchLike = () => {
    sentAt.push(now() - NOW);
    const make = answers[Math.min(sentAt.length - 1, answers.length - 1)]!;
    return Promise.resolve(make());
  };
  return Object.assign(f, { sentAt });
}

describe("every attempt passes the limiter (finding limiter-retries-bypass-bucket)", () => {
  it("three attempts are three limiter rows, and the retries keep the 1/s spacing", async () => {
    let clockNow = (): number => NOW;
    const fetch = stamped(() => clockNow(), [() => jsonResponse({}, 503)]);
    // random 0: the backoff's low end (750 ms, 1500 ms) — the 1/s window must still space the sends
    const w = makeWorld({ fetch, over: { random: () => 0 } });
    clockNow = () => w.clock.nowMs();
    await expect(w.provider.getProSchedule(SEASON)).rejects.toMatchObject({
      effCode: "ESPN_UPSTREAM_UNAVAILABLE",
      effDetails: { upstream_status: 503 },
    });
    expect(fetch.sentAt).toEqual([0, 1000, 2500]);
    expect(w.limiter.rows.map((r) => r.at - NOW)).toEqual([0, 1000, 2500]);
    expect(w.limiter.rows.map((r) => r.outcome)).toEqual([
      "server_error",
      "server_error",
      "server_error",
    ]);
    for (let i = 1; i < fetch.sentAt.length; i++)
      expect(fetch.sentAt[i]! - fetch.sentAt[i - 1]!).toBeGreaterThanOrEqual(1000);
  });

  it("Retry-After: 0 never collapses the retries into a burst (the backoff is the floor)", async () => {
    let clockNow = (): number => NOW;
    const fetch = stamped(() => clockNow(), [() => jsonResponse({}, 503, { "retry-after": "0" })]);
    const w = makeWorld({ fetch });
    clockNow = () => w.clock.nowMs();
    await expect(w.provider.getProSchedule(SEASON)).rejects.toMatchObject({
      effCode: "ESPN_UPSTREAM_UNAVAILABLE",
    });
    expect(w.sleeps).toEqual([1000, 2000]);
    expect(fetch.sentAt).toEqual([0, 1000, 3000]);
    expect(w.limiter.rows).toHaveLength(3);
  });

  it("a Retry-After longer than the backoff lengthens the wait; a 429's too", async () => {
    const fetch = stamped(() => NOW, [() => jsonResponse({}, 429, { "retry-after": "5" }), pro]);
    const w = makeWorld({ fetch });
    await w.provider.getProSchedule(SEASON);
    expect(w.sleeps).toEqual([5000]);
    expect(w.limiter.rows.map((r) => r.outcome)).toEqual(["rate_limited", "ok"]);
  });

  it("a retry counts against the job fleet's daily cap: the cap refuses it, the last upstream failure is the answer", async () => {
    let clockNow = (): number => NOW;
    const fetch = stamped(() => clockNow(), [() => jsonResponse({}, 503)]);
    const w = makeWorld({ fetch, over: { origin: "job" } });
    clockNow = () => w.clock.nowMs();
    // earlier today the job fleet sent all but one of its keyless requests
    for (let i = 0; i < ESPN_JOB_DAILY_CAPS.keyless - 1; i++)
      w.limiter.rows.push({
        id: 10_000 + i,
        at: NOW - 2 * 60 * 60 * 1000 + i * 2000,
        keyless: true,
        origin: "job",
        outcome: "ok",
      });
    await expect(w.provider.getProSchedule(SEASON)).rejects.toMatchObject({
      effCode: "ESPN_UPSTREAM_UNAVAILABLE",
      effDetails: { upstream_status: 503 },
    });
    // one request: the cap's last slot; the retries were refused before anything was sent
    expect(fetch.sentAt).toEqual([0]);
    expect(w.limiter.rows.filter((r) => r.origin === "job" && r.keyless)).toHaveLength(
      ESPN_JOB_DAILY_CAPS.keyless,
    );
  });

  it("no retry once the breaker is open — another process's failures count", async () => {
    const fetch = stamped(() => NOW, [() => jsonResponse({}, 503)]);
    const w = makeWorld({ fetch });
    // another process's two failures, just before this call
    for (const [i, dt] of [2000, 1500].entries())
      w.limiter.rows.push({
        id: 20_000 + i,
        at: NOW - dt,
        keyless: true,
        origin: "server",
        outcome: "server_error",
      });
    await expect(w.provider.getProSchedule(SEASON)).rejects.toMatchObject({
      effCode: "ESPN_UPSTREAM_UNAVAILABLE",
      effDetails: { upstream_status: 503 },
    });
    expect(fetch.sentAt).toHaveLength(1);
    expect(w.sleeps).toEqual([]);
    expect(w.provider.transportStatus().breaker_open).toBe(true);
  });
});

describe("a runtime connect timeout is counted (finding espn-connect-timeout-not-breaker-counted)", () => {
  it("UND_ERR_CONNECT_TIMEOUT before the attempt timer: each attempt counts — one call opens the breaker", async () => {
    let calls = 0;
    const w = makeWorld({
      fetch: () => {
        calls++;
        return Promise.reject(
          new TypeError("fetch failed", {
            cause: Object.assign(new Error("Connect Timeout Error"), {
              code: "UND_ERR_CONNECT_TIMEOUT",
            }),
          }),
        );
      },
    });
    await expect(w.provider.getProSchedule(SEASON)).rejects.toMatchObject({
      effCode: "ESPN_UPSTREAM_UNAVAILABLE",
      effDetails: { reason: "connect_timeout" },
    });
    expect(calls).toBe(3);
    expect(w.limiter.rows.map((r) => r.outcome)).toEqual(["timeout", "timeout", "timeout"]);
    expect(w.provider.transportStatus()).toMatchObject({
      breaker_open: true,
      consecutive_failures: 3,
    });
    // the next call sends nothing (plan 01 §6: while open, no request)
    await expect(w.provider.getProSchedule(SEASON + 1)).rejects.toMatchObject({
      effCode: "ESPN_UPSTREAM_UNAVAILABLE",
      effDetails: { reason: "breaker_open" },
    });
    expect(calls).toBe(3);
  });
});
