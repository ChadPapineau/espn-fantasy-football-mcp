// breaker.test.ts — the in-process ESPN circuit breaker (plan 01 §5.7, §6: open for 5 min after 3
// consecutive failures, then one half-open probe; plan 05 §4.1: 5xx/429/timeouts/resets and
// ENOTFOUND/ECONNREFUSED feed the counter; a 4xx or a 304 proves the host is up). Property: the
// breaker never allows a request while open, and N consecutive failures always open it.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BREAKER_FAILURE_OUTCOMES,
  ESPN_BREAKER,
  REQUEST_OUTCOMES,
  type RequestOutcome,
} from "../../src/config/schema.js";
import { createCircuitBreaker, HTTP_BREAKER_FAILURE_OUTCOMES } from "../../src/http/breaker.js";
import { breakerFromOutcomes } from "../../src/providers/platform.js";

const T0 = Date.UTC(2026, 9, 4, 17, 0, 0);
const OPEN = ESPN_BREAKER.openMs;

describe("createCircuitBreaker", () => {
  it("defaults: 3 failures open it for 5 minutes (config ESPN_BREAKER)", () => {
    expect(ESPN_BREAKER).toEqual({ failures: 3, openMs: 300_000 });
    const b = createCircuitBreaker();
    for (let i = 0; i < 2; i++) {
      expect(b.check(T0)).toEqual({ allowed: true, probe: false });
      b.record("server_error", T0);
    }
    expect(b.status(T0)).toMatchObject({ state: "closed", consecutive_failures: 2 });
    b.record("timeout", T0 + 10);
    expect(b.status(T0 + 10)).toEqual({
      state: "open",
      open_until_ms: T0 + 10 + OPEN,
      consecutive_failures: 3,
    });
    expect(b.check(T0 + 11)).toEqual({ allowed: false, retry_at_ms: T0 + 10 + OPEN });
    expect(b.check(T0 + 10 + OPEN - 1).allowed).toBe(false);
  });

  it("the failure set: 5xx, 429, timeouts and network errors; everything else resets the streak", () => {
    expect([...HTTP_BREAKER_FAILURE_OUTCOMES].sort()).toEqual(
      [...BREAKER_FAILURE_OUTCOMES, "network_error"].sort(),
    );
    for (const o of REQUEST_OUTCOMES) {
      const b = createCircuitBreaker();
      b.record("server_error", T0);
      b.record("server_error", T0);
      b.record(o, T0);
      const opened = b.status(T0).state === "open";
      expect(opened, o).toBe(HTTP_BREAKER_FAILURE_OUTCOMES.includes(o));
      if (!opened && o !== "pending") expect(b.status(T0).consecutive_failures).toBe(0);
    }
  });

  it("a 4xx or a 304 between failures breaks the streak (the host is up)", () => {
    const b = createCircuitBreaker();
    b.record("server_error", T0);
    b.record("server_error", T0);
    b.record("client_error", T0);
    b.record("server_error", T0);
    b.record("not_modified", T0);
    b.record("server_error", T0);
    expect(b.status(T0)).toMatchObject({ state: "closed", consecutive_failures: 1 });
  });

  it("after the window exactly ONE probe goes; success closes, failure re-opens for a full window", () => {
    const b = createCircuitBreaker();
    for (let i = 0; i < 3; i++) b.record("network_error", T0);
    const after = T0 + OPEN;
    expect(b.status(after).state).toBe("half_open");
    expect(b.check(after)).toEqual({ allowed: true, probe: true });
    expect(b.check(after)).toEqual({ allowed: false, retry_at_ms: after });
    b.record("timeout", after + 5);
    expect(b.status(after + 5)).toMatchObject({ state: "open", open_until_ms: after + 5 + OPEN });
    const again = after + 5 + OPEN;
    expect(b.check(again)).toEqual({ allowed: true, probe: true });
    b.record("ok", again);
    expect(b.status(again)).toEqual({
      state: "closed",
      open_until_ms: null,
      consecutive_failures: 0,
    });
    expect(b.check(again).allowed).toBe(true);
  });

  it("a probe with no verdict (refused before sending, aborted) frees the slot without a state change", () => {
    const b = createCircuitBreaker();
    for (let i = 0; i < 3; i++) b.record("server_error", T0);
    const after = T0 + OPEN + 1;
    expect(b.check(after).allowed).toBe(true);
    b.record(null, after);
    expect(b.status(after).state).toBe("half_open");
    expect(b.check(after)).toEqual({ allowed: true, probe: true });
  });

  it("an in-flight success while open closes it; an in-flight failure re-arms the window", () => {
    const b = createCircuitBreaker();
    for (let i = 0; i < 3; i++) b.record("server_error", T0);
    b.record("server_error", T0 + 1000);
    expect(b.status(T0 + 1000).open_until_ms).toBe(T0 + 1000 + OPEN);
    b.record("ok", T0 + 2000);
    expect(b.status(T0 + 2000).state).toBe("closed");
  });

  it("trip(): force-open (host moved, or another process's derived state); never shortens", () => {
    const b = createCircuitBreaker();
    b.trip(T0);
    expect(b.status(T0)).toMatchObject({ state: "open", open_until_ms: T0 + OPEN });
    b.trip(T0, T0 + 1000);
    expect(b.status(T0).open_until_ms).toBe(T0 + OPEN);
    b.trip(T0, T0 + 2 * OPEN);
    expect(b.status(T0).open_until_ms).toBe(T0 + 2 * OPEN);
    b.trip(T0, T0 - 1); // in the past: ignored
    b.trip(T0, Number.NaN); // invalid: the default window
    expect(b.status(T0).open_until_ms).toBe(T0 + 2 * OPEN);
    expect(b.check(T0 + 2 * OPEN)).toEqual({ allowed: true, probe: true });
  });

  it("transportStatus has platform.ts's shape, with an ISO instant", () => {
    const b = createCircuitBreaker();
    expect(b.transportStatus(T0)).toEqual({
      breaker_open: false,
      breaker_open_until: null,
      consecutive_failures: 0,
    });
    for (let i = 0; i < 3; i++) b.record("rate_limited", T0);
    expect(b.transportStatus(T0)).toEqual({
      breaker_open: true,
      breaker_open_until: new Date(T0 + OPEN).toISOString(),
      consecutive_failures: 3,
    });
    expect(b.transportStatus(T0 + OPEN).breaker_open).toBe(false);
  });

  it("agrees with platform.ts breakerFromOutcomes on the contract's failure outcomes", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.constantFrom<RequestOutcome>(
            "ok",
            "server_error",
            "rate_limited",
            "timeout",
            "client_error",
          ),
          {
            maxLength: 12,
          },
        ),
        (seq) => {
          const b = createCircuitBreaker({ failureOutcomes: BREAKER_FAILURE_OUTCOMES });
          seq.forEach((o, i) => {
            b.record(o, T0 + i);
          });
          const now = T0 + seq.length;
          const derived = breakerFromOutcomes(
            seq.map((o, i) => ({ at_ms: T0 + i, outcome: o })).reverse(),
            now,
          );
          expect(b.transportStatus(now).breaker_open).toBe(derived.breaker_open);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("property: never allowed while open; `failures` consecutive failures always open it", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            dt: fc.integer({ min: 0, max: 2 * OPEN }),
            outcome: fc.constantFrom<RequestOutcome | null>(...REQUEST_OUTCOMES, null),
          }),
          { maxLength: 40 },
        ),
        (steps) => {
          const b = createCircuitBreaker();
          let now = T0;
          let streak = 0;
          for (const s of steps) {
            now += s.dt;
            const before = b.status(now);
            const v = b.check(now);
            if (before.state === "open") expect(v.allowed).toBe(false);
            if (!v.allowed) continue;
            b.record(s.outcome, now);
            if (s.outcome === null) continue;
            streak = HTTP_BREAKER_FAILURE_OUTCOMES.includes(s.outcome) ? streak + 1 : 0;
            if (streak >= ESPN_BREAKER.failures) expect(b.status(now).state).toBe("open");
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("bad tuning throws; a non-finite clock never allows", () => {
    expect(() => createCircuitBreaker({ failures: 0 })).toThrow(RangeError);
    expect(() => createCircuitBreaker({ failures: 1.5 })).toThrow(RangeError);
    expect(() => createCircuitBreaker({ openMs: 0 })).toThrow(RangeError);
    expect(() => createCircuitBreaker({ openMs: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    const b = createCircuitBreaker();
    expect(b.check(Number.NaN).allowed).toBe(false);
    expect(b.status(Number.NaN).state).toBe("open");
    b.record("server_error", Number.NaN);
    b.record("server_error", Number.NaN);
    b.record("server_error", Number.NaN);
    b.trip(Number.NaN);
    expect(b.status(OPEN - 1).state).toBe("open");
  });
});
