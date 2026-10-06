// limiter.ts — the ESPN request governor (plan 01 §6; plan 06 §1.4 + changelog V7): ONE cross-process
// token bucket kept in the store's `espn_requests` table (≤ 30/min, ≤ 1/s, checked and recorded in one
// BEGIN IMMEDIATE by the LimiterRepository — coded against src/store/types.ts, injected in tests), the
// job fleet's daily caps (job-origin rows only), ≤ 2 concurrent in this process, fail-closed (a row
// that cannot be written means the request is not sent), the circuit breaker (open 5 min after 3
// consecutive 5xx / 429 / timeouts — in process AND derived from the persisted outcomes, so a second
// process sees it), and the backoff schedule (1, 2, 4, 8 s, ±25 % full jitter).
import {
  BREAKER_FAILURE_OUTCOMES,
  ESPN_BACKOFF,
  ESPN_BREAKER,
  ESPN_JOB_DAILY_CAPS,
  ESPN_LIMITER,
  type RequestOutcome,
} from "../../config/schema.js";
import type { Clock } from "../../domain/clock.js";
import { breakerFromOutcomes, type TransportStatus } from "../platform.js";
import type { LimiterRepository, LimiterRequest, RequestOrigin } from "../../store/types.js";

/** Waits `ms`; rejects when `signal` aborts. Injected so tests run on fake time. */
export type Sleep = (ms: number, signal: AbortSignal | null) => Promise<void>;

/** The real sleep over setTimeout (a non-finite or negative wait is 0). */
export const realSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      Number.isFinite(ms) && ms > 0 ? ms : 0,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Our own limiter refused (plan 01 §4.3 RATE_LIMITED, with `retry_after_s`). */
export class EspnRateLimitedError extends Error {
  readonly effCode = "RATE_LIMITED" as const;
  readonly effDetails: { readonly retry_after_s: number; readonly reason: string };
  constructor(retryAfterMs: number, reason: "window" | "daily_cap") {
    super("espn: rate limited by the local limiter");
    this.name = "EspnRateLimitedError";
    this.effDetails = Object.freeze({
      retry_after_s: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      reason,
    });
  }
}

/** The limiter's row could not be written: fail closed — the request is not sent (plan 01 §6). */
export class EspnLimiterUnavailableError extends Error {
  readonly effCode = "INTERNAL" as const;
  readonly effDetails = Object.freeze({ reason: "limiter_unavailable" });
  constructor(cause: unknown) {
    super("espn: limiter row could not be written", { cause });
    this.name = "EspnLimiterUnavailableError";
  }
}

/** The breaker is open: no request is sent (plan 01 §6). */
export class EspnBreakerOpenError extends Error {
  readonly effCode = "ESPN_UPSTREAM_UNAVAILABLE" as const;
  readonly effDetails = Object.freeze({ reason: "breaker_open" });
  constructor() {
    super("espn: circuit breaker open");
    this.name = "EspnBreakerOpenError";
  }
}

/** The start of the UTC day containing `ms` (the daily caps' day — decision recorded). */
export function utcDayStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** The limiter request for one send at `nowMs` (pure: the windows and the cap). */
export function limiterRequest(
  nowMs: number,
  keyless: boolean,
  origin: RequestOrigin,
): LimiterRequest {
  const iso = (ms: number): string => new Date(ms).toISOString();
  return {
    at: iso(nowMs),
    keyless,
    origin,
    windows: [
      { start: iso(nowMs - 60_000), max: ESPN_LIMITER.perMinute },
      { start: iso(nowMs - 1_000), max: ESPN_LIMITER.perSecond },
    ],
    dailyCap:
      origin === "job"
        ? {
            dayStart: iso(utcDayStart(nowMs)),
            max: keyless ? ESPN_JOB_DAILY_CAPS.keyless : ESPN_JOB_DAILY_CAPS.cookie,
          }
        : null,
  };
}

/**
 * The wait before retry `attempt` (1-based: the wait after the first failure is attempt 1):
 * base·2^(attempt−1) capped at maxMs, scaled by a full ±25 % jitter from `random` ∈ [0, 1).
 */
export function backoffMs(attempt: number, random: number): number {
  const base = Math.min(ESPN_BACKOFF.maxMs, ESPN_BACKOFF.baseMs * 2 ** Math.max(0, attempt - 1));
  const r = Number.isFinite(random) ? Math.min(Math.max(random, 0), 1) : 0.5;
  return Math.round(base * (1 + ESPN_BACKOFF.jitter * (2 * r - 1)));
}

/** A counting semaphore (in-process concurrency ≤ ESPN_LIMITER.concurrency). */
export class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  get inFlight(): number {
    return this.active;
  }
  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) next();
    else this.active = Math.max(0, this.active - 1);
  }
}

/** The circuit breaker: in process, plus the outcome rows any process wrote. */
export class Breaker {
  private consecutive = 0;
  private openUntil = 0;
  private readonly clock: Clock;
  private readonly repo: LimiterRepository | null;
  constructor(clock: Clock, repo: LimiterRepository | null) {
    this.clock = clock;
    this.repo = repo;
  }

  /** Records a finished request's outcome (success resets the count). */
  record(outcome: RequestOutcome): void {
    if (outcome === "pending") return;
    if (!BREAKER_FAILURE_OUTCOMES.includes(outcome)) {
      if (outcome === "ok" || outcome === "not_modified") this.consecutive = 0;
      return;
    }
    this.consecutive++;
    if (this.consecutive >= ESPN_BREAKER.failures)
      this.openUntil = this.clock.nowMs() + ESPN_BREAKER.openMs;
  }

  /** Opens the breaker now regardless of the count (a host move — plan 01 §7). */
  forceOpen(): void {
    this.openUntil = this.clock.nowMs() + ESPN_BREAKER.openMs;
  }

  private derived(now: number): ReturnType<typeof breakerFromOutcomes> | null {
    if (this.repo === null) return null;
    try {
      const rows = this.repo.recentOutcomes(ESPN_BREAKER.failures * 2);
      return breakerFromOutcomes(
        rows.map((r) => ({ at_ms: Date.parse(r.at), outcome: r.outcome })),
        now,
      );
    } catch {
      return null;
    }
  }

  /** Whether a request may not be sent now (in-process window or another process's failures). */
  isOpen(): boolean {
    const now = this.clock.nowMs();
    if (now < this.openUntil) return true;
    return this.derived(now)?.breaker_open === true;
  }

  /** The breaker part of `transportStatus()`. */
  status(): Pick<TransportStatus, "breaker_open" | "breaker_open_until" | "consecutive_failures"> {
    const now = this.clock.nowMs();
    const own = now < this.openUntil ? this.openUntil : null;
    const d = this.derived(now);
    const otherUntil =
      d?.breaker_open_until === null || d === null ? null : Date.parse(d.breaker_open_until);
    const until = Math.max(own ?? 0, otherUntil ?? 0);
    return {
      breaker_open: until > 0,
      breaker_open_until: until > 0 ? new Date(until).toISOString() : null,
      consecutive_failures: Math.max(this.consecutive, d?.consecutive_failures ?? 0),
    };
  }
}

/** A recorded send: release it with the request's final outcome (retries keep the same row). */
export interface LimiterTicket {
  readonly id: number;
  finish(outcome: RequestOutcome): void;
}

/** What the governor needs. */
export interface LimiterDeps {
  readonly repo: LimiterRepository;
  readonly clock: Clock;
  readonly origin: RequestOrigin;
  readonly sleep?: Sleep;
  /** Receives fixed-vocabulary events (never values). */
  readonly onEvent?: (event: string) => void;
}

/** The ESPN request governor: concurrency, the cross-process bucket and the outcome rows. */
export class EspnLimiter {
  readonly breaker: Breaker;
  private readonly deps: LimiterDeps;
  private readonly sem = new Semaphore(ESPN_LIMITER.concurrency);
  private readonly sleep: Sleep;

  constructor(deps: LimiterDeps) {
    this.deps = deps;
    this.sleep = deps.sleep ?? realSleep;
    this.breaker = new Breaker(deps.clock, deps.repo);
  }

  /** Requests in flight in this process. */
  get inFlight(): number {
    return this.sem.inFlight;
  }

  /**
   * Waits for a concurrency slot and a bucket slot, then records the send (one row per request).
   * A wait that would pass `deadlineAtMs` is refused as RATE_LIMITED (with the wait); a daily cap
   * is refused at once; a row that cannot be written refuses fail-closed.
   */
  async acquire(opts: {
    readonly keyless: boolean;
    readonly deadlineAtMs: number;
    readonly signal: AbortSignal | null;
  }): Promise<LimiterTicket> {
    await this.sem.acquire();
    let held = true;
    const releaseSlot = (): void => {
      if (held) {
        held = false;
        this.sem.release();
      }
    };
    try {
      for (;;) {
        const now = this.deps.clock.nowMs();
        let verdict;
        try {
          verdict = this.deps.repo.tryRecord(limiterRequest(now, opts.keyless, this.deps.origin));
        } catch (e) {
          throw new EspnLimiterUnavailableError(e);
        }
        if (verdict.ok) {
          const id = verdict.id;
          return {
            id,
            finish: (outcome) => {
              releaseSlot();
              this.breaker.record(outcome);
              try {
                this.deps.repo.recordOutcome(id, outcome);
              } catch {
                this.deps.onEvent?.("limiter.outcome_unwritten");
              }
            },
          };
        }
        if (verdict.reason === "daily_cap" || now + verdict.retry_after_ms >= opts.deadlineAtMs)
          throw new EspnRateLimitedError(verdict.retry_after_ms, verdict.reason);
        this.deps.onEvent?.("limiter.wait");
        await this.sleep(verdict.retry_after_ms, opts.signal);
      }
    } catch (e) {
      releaseSlot();
      throw e;
    }
  }
}
