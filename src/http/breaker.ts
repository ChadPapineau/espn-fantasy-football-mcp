// breaker.ts — the in-process ESPN circuit breaker (plan 01 §5.7, §6: open for 5 min after 3
// consecutive failures; while open every ESPN-fact call answers from cache or with
// ESPN_UPSTREAM_UNAVAILABLE without a request; plan 05 §4.1 rows: 5xx/429/timeouts/ECONNRESET and
// ENOTFOUND/ECONNREFUSED feed the counter; config ESPN_BREAKER). After the open window ONE probe is
// let through (half-open): its success closes the breaker, its failure re-opens it for another
// window — so a dead host costs 3 requests, then one per 5 minutes. Pure: time is passed in.
// The cross-process view (`eff status`, a second server) is platform.ts `breakerFromOutcomes` over
// the persisted outcomes; `trip()` lets the provider adopt it or force-open on ESPN_HOST_MOVED.
import { BREAKER_FAILURE_OUTCOMES, ESPN_BREAKER, type RequestOutcome } from "../config/schema.js";
import type { TransportStatus } from "../providers/platform.js";

/**
 * The outcomes this breaker counts: config's BREAKER_FAILURE_OUTCOMES (5xx, 429, timeouts) plus
 * `network_error` — plan 05 §4.1 counts ECONNRESET and ENOTFOUND/ECONNREFUSED too (decision
 * recorded; config's list is the cross-process derivation's and is not narrowed here).
 */
export const HTTP_BREAKER_FAILURE_OUTCOMES: readonly RequestOutcome[] = Object.freeze([
  ...BREAKER_FAILURE_OUTCOMES,
  "network_error",
]);

/** The breaker's state. */
export type BreakerState = "closed" | "open" | "half_open";

/** Whether a request may be sent now. `probe` = this caller is the half-open trial. */
export type BreakerVerdict =
  | { readonly allowed: true; readonly probe: boolean }
  | { readonly allowed: false; readonly retry_at_ms: number };

/** A snapshot for `espn_get_status` / `eff status`. */
export interface BreakerStatus {
  readonly state: BreakerState;
  readonly open_until_ms: number | null;
  readonly consecutive_failures: number;
}

/** The breaker. Every method takes the caller's clock reading; none throws. */
export interface CircuitBreaker {
  /** Whether a request may start at `nowMs` (call it immediately before sending). */
  check(nowMs: number): BreakerVerdict;
  /** One finished request's outcome; null / `pending` = no verdict (frees a half-open probe slot). */
  record(outcome: RequestOutcome | null, nowMs: number): void;
  /** Force-opens until `untilMs` (default now + openMs): host moved, or another process's view. */
  trip(nowMs: number, untilMs?: number): void;
  status(nowMs: number): BreakerStatus;
  /** platform.ts TransportStatus fields (ISO instant), for the provider's `transportStatus()`. */
  transportStatus(
    nowMs: number,
  ): Pick<TransportStatus, "breaker_open" | "breaker_open_until" | "consecutive_failures">;
}

/** Breaker tuning (defaults: config ESPN_BREAKER and HTTP_BREAKER_FAILURE_OUTCOMES). */
export interface BreakerOptions {
  readonly failures?: number;
  readonly openMs?: number;
  readonly failureOutcomes?: readonly RequestOutcome[];
}

/** Builds a breaker; bad tuning is a programming error (RangeError). */
export function createCircuitBreaker(opts: BreakerOptions = {}): CircuitBreaker {
  const threshold = opts.failures ?? ESPN_BREAKER.failures;
  const openMs = opts.openMs ?? ESPN_BREAKER.openMs;
  if (!Number.isSafeInteger(threshold) || threshold < 1)
    throw new RangeError("breaker: failures must be an integer ≥ 1");
  if (!Number.isFinite(openMs) || openMs <= 0)
    throw new RangeError("breaker: openMs must be a positive number");
  const failing = new Set<RequestOutcome>(opts.failureOutcomes ?? HTTP_BREAKER_FAILURE_OUTCOMES);
  let consecutive = 0;
  /** While > now the breaker is open; once passed, the next check is the half-open probe. */
  let openUntil: number | null = null;
  let probeInFlight = false;

  const valid = (n: number): boolean => Number.isFinite(n);
  const stateAt = (now: number): BreakerState => {
    if (openUntil === null) return "closed";
    return now < openUntil ? "open" : "half_open";
  };

  const status = (nowMs: number): BreakerStatus => {
    const s = valid(nowMs) ? stateAt(nowMs) : "open";
    return {
      state: s,
      open_until_ms: s === "open" ? openUntil : null,
      consecutive_failures: consecutive,
    };
  };

  return {
    check(nowMs) {
      if (!valid(nowMs)) return { allowed: false, retry_at_ms: Number.POSITIVE_INFINITY };
      const s = stateAt(nowMs);
      if (s === "closed") return { allowed: true, probe: false };
      if (s === "open") return { allowed: false, retry_at_ms: openUntil ?? nowMs };
      if (probeInFlight) return { allowed: false, retry_at_ms: nowMs };
      probeInFlight = true;
      return { allowed: true, probe: true };
    },
    record(outcome, nowMs) {
      probeInFlight = false;
      // null = no upstream verdict; `pending` is an in-flight row, never a verdict (as in
      // platform.ts breakerFromOutcomes)
      if (outcome === null || outcome === "pending") return;
      if (!failing.has(outcome)) {
        // any upstream answer that is not a failure proves the host is up
        consecutive = 0;
        openUntil = null;
        return;
      }
      consecutive++;
      const now = valid(nowMs) ? nowMs : 0;
      if (consecutive >= threshold || openUntil !== null) openUntil = now + openMs;
    },
    trip(nowMs, untilMs) {
      const now = valid(nowMs) ? nowMs : 0;
      const until = untilMs !== undefined && valid(untilMs) ? untilMs : now + openMs;
      if (until <= now) return;
      openUntil = Math.max(openUntil ?? 0, until);
      consecutive = Math.max(consecutive, threshold);
      probeInFlight = false;
    },
    status,
    transportStatus(nowMs) {
      const s = status(nowMs);
      const until = s.state === "open" ? s.open_until_ms : null;
      return {
        breaker_open: until !== null,
        breaker_open_until: until === null ? null : new Date(until).toISOString(),
        consecutive_failures: s.consecutive_failures,
      };
    },
  };
}
