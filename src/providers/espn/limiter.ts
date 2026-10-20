// limiter.ts — the ESPN request governor (plan 01 §6; plan 06 §1.4 + changelog V7): ONE cross-process
// token bucket kept in the store's `espn_requests` table (≤ 30/min, ≤ 1/s, checked and recorded in one
// BEGIN IMMEDIATE by the LimiterRepository — coded against src/store/types.ts, injected in tests), the
// job fleet's daily caps (job-origin rows only), ≤ 2 concurrent ACROSS processes (an in-process
// semaphore plus the `pending` rows every process writes — plan 01 §6 D7 "one global limiter, shared
// by every tool and every process"), fail-closed (a row that cannot be written means the request is
// not sent), one row per upstream request — every retry attempt is a request of its own (plan 01 §6
// "each request inserts a row"), the circuit breaker (open 5 min after 3 consecutive 5xx / 429 /
// timeouts / network failures — plan 05 §4.1 — in process AND derived from the persisted
// outcomes, so a second process sees it), and the backoff schedule (1, 2, 4, 8 s, ±25 % jitter).
import {
  ESPN_BACKOFF,
  ESPN_BREAKER,
  ESPN_JOB_DAILY_CAPS,
  ESPN_LIMITER,
  type RequestOutcome,
} from "../../config/schema.js";
import type { Clock } from "../../domain/clock.js";
import {
  breakerFromOutcomes,
  ESPN_BREAKER_FAILURE_OUTCOMES,
  type TransportStatus,
} from "../platform.js";
import type {
  LimiterRepository,
  LimiterRequest,
  LimiterVerdict,
  RequestOrigin,
} from "../../store/types.js";

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
  constructor(retryAfterMs: number, reason: "window" | "daily_cap" | "concurrency") {
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

/**
 * A `pending` row older than this is no longer in flight (its process died before recording the
 * outcome): one attempt lasts at most ATTEMPT_TIMEOUT_MS (15 s) in the provider and 20 s in the
 * CLI's requests (src/cli/espn-http.ts), so 30 s bounds every live one.
 */
export const IN_FLIGHT_MAX_AGE_MS = 30_000;
/** How often a send waiting for a cross-process concurrency slot looks again. */
export const IN_FLIGHT_POLL_MS = 250;
/**
 * How many of the newest rows hold every possibly-live `pending` row: the bucket admits at most
 * ESPN_LIMITER.perMinute rows in any 60 s, and IN_FLIGHT_MAX_AGE_MS is shorter than that.
 */
const IN_FLIGHT_SCAN_ROWS = ESPN_LIMITER.perMinute;

/**
 * Requests in flight in EVERY process at `nowMs`: the `pending` rows (recorded, outcome not yet
 * written) of the last IN_FLIGHT_MAX_AGE_MS, newest first as `recentOutcomes` returns them. Pure.
 */
export function inFlightOf(
  newestFirst: readonly { readonly at: string; readonly outcome: RequestOutcome }[],
  nowMs: number,
): number {
  let n = 0;
  for (const r of newestFirst) {
    const at = Date.parse(r.at);
    if (!Number.isFinite(at) || nowMs - at > IN_FLIGHT_MAX_AGE_MS) continue;
    if (r.outcome === "pending") n++;
  }
  return n;
}

/** A send's verdict: the bucket's (LimiterVerdict), or no free in-flight slot across processes. */
export type SlotVerdict = LimiterVerdict;

/**
 * One send's slot under the ONE global limiter (plan 01 §6 D7: ≤ 2 in flight across every process,
 * then the bucket's windows and the jobs' daily caps): refused `concurrency` (wait
 * IN_FLIGHT_POLL_MS, nothing written) while ESPN_LIMITER.concurrency `pending` rows are live in any
 * process, else the repository's verdict (and, when it admits the send, the `pending` row that
 * holds the slot until its outcome is written). Throws what the repository throws (the caller fails
 * closed). Every ESPN request takes its slot here: the provider's attempts (EspnLimiter.acquire) and
 * the CLI's own probes and season reads (src/cli/espn-http.ts espnRequest).
 *
 * The cap is decided INSIDE the repository's BEGIN IMMEDIATE (LimiterRequest.inFlight: the store
 * counts the live pending rows in the same transaction as it checks the windows and inserts the
 * row), so no other process can insert a row between the count and the insert, however long this
 * one stalls (Stage C finding limiter-concurrency-per-process). The count here first is only a
 * cheap early refusal that takes no write lock while the slots are visibly full.
 */
export function trySlot(repo: LimiterRepository, req: LimiterRequest): SlotVerdict {
  const at = Date.parse(req.at);
  if (inFlightOf(repo.recentOutcomes(IN_FLIGHT_SCAN_ROWS), at) >= ESPN_LIMITER.concurrency)
    return { ok: false, reason: "concurrency", retry_after_ms: IN_FLIGHT_POLL_MS };
  return repo.tryRecord({
    ...req,
    inFlight: {
      max: ESPN_LIMITER.concurrency,
      since: new Date(at - IN_FLIGHT_MAX_AGE_MS).toISOString(),
      retry_after_ms: IN_FLIGHT_POLL_MS,
    },
  });
}

/**
 * A counting semaphore (in-process concurrency ≤ ESPN_LIMITER.concurrency), first come first served.
 * A wait is bounded: `acquire(waitMs, signal)` gives up (false, nothing held) once `waitMs` of wall
 * time pass or the signal aborts — a read queued behind two hung requests no longer waits past its
 * call's deadline (Stage C finding espn-deadline-budget-exhausted-internal). The bound is a real,
 * unreferenced timer: it never keeps the process alive, and a slot freed first always wins.
 */
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
  /** Waits for a slot: true when held, false when the wait gave up (the bound or the signal). */
  async acquire(
    waitMs: number = Number.POSITIVE_INFINITY,
    signal: AbortSignal | null = null,
  ): Promise<boolean> {
    if (this.active < this.max) {
      this.active++;
      return true;
    }
    if (!(waitMs > 0) || signal?.aborted === true) return false;
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let done = false;
      const settle = (granted: boolean): void => {
        if (done) return;
        done = true;
        if (timer !== null) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(granted);
      };
      const waiter = (): void => {
        settle(true);
      };
      const giveUp = (): void => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        settle(false);
      };
      const onAbort = (): void => {
        giveUp();
      };
      this.waiters.push(waiter);
      if (Number.isFinite(waitMs)) {
        timer = setTimeout(giveUp, waitMs);
        timer.unref();
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  release(): void {
    const next = this.waiters.shift();
    // the slot passes to the next waiter as is (active unchanged), else it is freed
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

  /**
   * Records a finished request's outcome (ESPN_BREAKER_FAILURE_OUTCOMES count — a reset, a refused
   * connection and a certificate failure among them; a success resets the count; a client error,
   * the caller's cancellation included, neither counts nor resets).
   */
  record(outcome: RequestOutcome): void {
    if (outcome === "pending") return;
    if (!ESPN_BREAKER_FAILURE_OUTCOMES.includes(outcome)) {
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

/**
 * A recorded send: release it with that request's outcome. One ticket is ONE upstream request — a
 * retry acquires a ticket (and a row) of its own (plan 01 §6).
 */
export interface LimiterTicket {
  readonly id: number;
  /** The instant the send was recorded at (always before the deadline it was acquired under). */
  readonly atMs: number;
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
   * Waits for a concurrency slot (in this process, then across processes — `trySlot`) and a bucket
   * slot, then records the send (one row per upstream request). A wait that would pass the deadline
   * is refused as RATE_LIMITED (with the wait); a daily cap is refused at once; rows that cannot be
   * read or written refuse fail-closed. The deadline is a number, or a function read at every step:
   * a coalesced read's is the latest deadline of the readers still waiting for it (cache.ts
   * `SharedLimits`), which grows when a later reader joins and shrinks when one leaves.
   */
  async acquire(opts: {
    readonly keyless: boolean;
    readonly deadlineAtMs: number | (() => number);
    readonly signal: AbortSignal | null;
  }): Promise<LimiterTicket> {
    const d = opts.deadlineAtMs;
    const deadline = typeof d === "function" ? d : (): number => d;
    // the in-process slot is waited for only until the deadline: a read queued behind hung requests
    // is refused (RATE_LIMITED, concurrency) instead of sending after its call gave up; a deadline
    // that grew meanwhile (a later reader joined) is waited for again
    for (let horizon = deadline(); ;) {
      const waitMs = horizon - this.deps.clock.nowMs();
      if (await this.sem.acquire(waitMs, opts.signal)) break;
      const later = deadline();
      if (opts.signal?.aborted === true || !(later > horizon))
        throw new EspnRateLimitedError(Math.max(IN_FLIGHT_POLL_MS, waitMs), "concurrency");
      horizon = later;
    }
    let held = true;
    const releaseSlot = (): void => {
      if (held) {
        held = false;
        this.sem.release();
      }
    };
    try {
      // the concurrency waits are counted as well as timed: a clock that does not move (a test's
      // fixed clock) cannot keep the loop alive past the deadline's number of polls (a deadline
      // that grew adds the polls of its extra time)
      let polls: number | null = null;
      let pollHorizon = Number.NEGATIVE_INFINITY;
      for (;;) {
        const now = this.deps.clock.nowMs();
        const until = deadline();
        // a request that can no longer start inside its deadline is never recorded: an unsent
        // request must not spend the 30/min window (espn-deadline-budget-exhausted-internal) — nor
        // one whose every reader has gone (a cancelled call)
        if (now >= until || opts.signal?.aborted === true)
          throw new EspnRateLimitedError(IN_FLIGHT_POLL_MS, "concurrency");
        let verdict: SlotVerdict;
        try {
          verdict = trySlot(this.deps.repo, limiterRequest(now, opts.keyless, this.deps.origin));
        } catch (e) {
          throw new EspnLimiterUnavailableError(e);
        }
        if (!verdict.ok && verdict.reason === "concurrency") {
          if (polls === null) {
            polls = Math.max(0, Math.floor((until - now) / IN_FLIGHT_POLL_MS));
            pollHorizon = until;
          } else if (until > pollHorizon) {
            polls += Math.floor((until - pollHorizon) / IN_FLIGHT_POLL_MS);
            pollHorizon = until;
          }
          if (now + verdict.retry_after_ms >= until || polls <= 0)
            throw new EspnRateLimitedError(verdict.retry_after_ms, "concurrency");
          polls--;
          this.deps.onEvent?.("limiter.wait_concurrency");
          await this.sleep(verdict.retry_after_ms, opts.signal);
          continue;
        }
        if (verdict.ok) {
          const id = verdict.id;
          return {
            id,
            atMs: now,
            finish: (outcome) => {
              this.breaker.record(outcome);
              // the outcome first: a waiter released by the slot counts this row as finished
              try {
                this.deps.repo.recordOutcome(id, outcome);
              } catch {
                this.deps.onEvent?.("limiter.outcome_unwritten");
              }
              releaseSlot();
            },
          };
        }
        if (verdict.reason === "daily_cap" || now + verdict.retry_after_ms >= until)
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
