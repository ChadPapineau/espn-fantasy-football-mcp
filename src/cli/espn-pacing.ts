// espn-pacing.ts — a long run of ESPN reads the CLI makes through the provider (plan 01 §6 and D7:
// ONE global limiter shared by every process — ≤ 30/min, ≤ 1/s, ≤ 2 in flight, and a read waits for
// its slot only until its ≤ 20 s deadline; changelog R6-3: the backfill). A read whose full window
// outlasts its deadline is refused RATE_LIMITED, so a run of more reads than one window holds died
// part-way: found at the owner's install, 2026-11-02, `eff transactions --backfill` (one settings
// read plus one mTransactions2 read per scoring period of each season, ~37 in all) stopped at
// RATE_LIMITED and was finished one `--seasons` at a time by hand. A PacedRun runs each read of
// such a run:
//  - paced: a read starts RUN_PACE_MS after the start of the previous one that went upstream (24 a
//    minute), so the run alone never fills the 30/min window, and the MCP server and the launchd
//    jobs that share the bucket always find a slot within a few seconds (a burst of 30 would hold
//    the window full for half a minute, longer than their reads wait: refused, a job's run failed);
//  - waiting for a full window before the read: the shared bucket's newest rows, read-only
//    (windowFreeInMs over the limiter repository's recentOutcomes, mirroring the store's count),
//    say whether another process filled the 30/min window; if it did, the run waits for the slot
//    itself — its time to free, in whole seconds, plus WINDOW_WAIT_MARGIN_MS — before the read
//    starts. The limiter would otherwise wait for it inside the read's ≤ 20 s deadline, and a wait
//    ending just before the deadline left the request only milliseconds: it timed out
//    (ESPN_UPSTREAM_UNAVAILABLE, counted by the breaker every process shares) and the run died
//    (verifier finding F2 on 4141144). The limiter still decides: the read then takes its slot as
//    any read does, and another process's burst landing after the look is a refusal, below;
//  - waiting on a refusal: the limiter's own refusal for the window (`window`) or for ESPN's
//    Retry-After hold (`retry_after`) is waited out — its retry_after_s plus WINDOW_WAIT_MARGIN_MS —
//    and the same read runs again; a `concurrency` refusal (the limiter already polled for a free
//    in-flight slot through the read's whole deadline) runs again once (MAX_CONCURRENCY_RETRIES:
//    a dead process's `pending` rows age out after 30 s). A refusal the provider's stale fallback
//    turned into STALE_ONLY (only data past its hard limit cached: a week a run more than a day
//    old read) is the refusal kept as its cause, and is waited on the same (verifier finding F1:
//    the re-run that resumes died STALE_ONLY). A spent daily cap, a second concurrency refusal in a
//    row and every other failure — ESPN's own 429 among them, a 4xx, a rejected cookie — are
//    rethrown at once, so the command's exit code and message stay as they were (a refusal not
//    waited on is rethrown as the limiter's RATE_LIMITED, never as the STALE_ONLY around it);
//  - bounded: at most MAX_CONSECUTIVE_REFUSALS waits in a row for one read (on refusals and on a
//    window seen full), and in all no more waiting than the run's planned reads need at 30/min in
//    whole windows plus one spare window (waitBudgetMs: load from the other processes). A window
//    seen full past a bound is not waited on — the read goes to the limiter as it is; a refusal
//    past one is rethrown and `gaveUp` says which bound it was;
//  - cancellable: the run's signal (the command's claim on SIGINT/SIGTERM, src/cli/interrupt.ts)
//    ends a wait at once and no read starts after it (RunInterrupted); a read refused after the
//    signal announces no wait (F3). A read already in flight ends within its own ≤ 20 s deadline;
//    a second signal ends the process.
// It never sends a request itself and never widens the limiter: every read still takes its slot
// from src/providers/espn/limiter.ts, which alone decides when a request goes out (the look before
// a read only reads rows and only ever adds a wait), and the waits are the injected Sleep (tests
// run on fake time).
import { stampedAhead } from "../config/freshness.js";
import { ESPN_LIMITER } from "../config/schema.js";
import type { Clock } from "../domain/clock.js";
import { EspnRateLimitedError, realSleep, type Sleep } from "../providers/espn/limiter.js";
import { EspnStaleOnlyError } from "../providers/espn/request.js";
import { limiterDecision } from "../store/types.js";

/** The reads a paced run starts per minute: six of the limiter's 30 stay free for the others. */
export const RUN_SHARE_PER_MINUTE = 24;
/** The least time from the start of one upstream read of a paced run to the start of the next. */
export const RUN_PACE_MS = Math.ceil(60_000 / RUN_SHARE_PER_MINUTE);
/** Added to a refusal's retry_after_s (already rounded up to whole seconds by the limiter). */
export const WINDOW_WAIT_MARGIN_MS = 500;
/**
 * Waits in a row for one read — on refusals and on a window seen full before it — after which the
 * run stops (the next refusal is rethrown).
 */
export const MAX_CONSECUTIVE_REFUSALS = 5;
/** `concurrency` refusals in a row one read runs again after (the next one is rethrown). */
export const MAX_CONCURRENCY_RETRIES = 1;
/** The limiter's per-minute window. */
const WINDOW_MS = 60_000;

/** The limiter refusals (EspnRateLimitedError's reasons). */
export type RefusalReason = "window" | "daily_cap" | "concurrency" | "retry_after";
const REFUSAL_REASONS: readonly RefusalReason[] = [
  "window",
  "daily_cap",
  "concurrency",
  "retry_after",
];

/** A limiter refusal: its reason and the wait it states. */
export interface LimiterRefusal {
  readonly reason: RefusalReason;
  readonly retryAfterMs: number;
}

/**
 * The local limiter's own refusal behind `e`: `e` itself, or the cause of a STALE_ONLY the
 * provider's stale fallback raised in its place (only data past its hard limit was cached — src/
 * providers/espn/request.ts keeps the failure as the cause); else `e` unchanged. One level only.
 */
export function refusalBehind(e: unknown): unknown {
  return e instanceof EspnStaleOnlyError && e.cause instanceof EspnRateLimitedError ? e.cause : e;
}

/**
 * The refusal `e` is when it is the local limiter's own (EspnRateLimitedError, with a known reason
 * and a positive retry_after_s — itself or behind a STALE_ONLY: refusalBehind), else null — ESPN's
 * own 429 (an EspnUpstreamError carrying RATE_LIMITED) is an answer from ESPN, not a refusal of
 * ours, and is never waited on here, nor a STALE_ONLY around one.
 */
export function limiterRefusal(e: unknown): LimiterRefusal | null {
  const r = refusalBehind(e);
  if (!(r instanceof EspnRateLimitedError)) return null;
  const { reason, retry_after_s: s } = r.effDetails;
  if (!(REFUSAL_REASONS as readonly string[]).includes(reason)) return null;
  if (!Number.isFinite(s) || s <= 0) return null;
  return { reason: reason as RefusalReason, retryAfterMs: s * 1000 };
}

/**
 * How long until the shared bucket's 30/min window has a free slot at `nowMs` (0: one is free now),
 * from its newest rows (LimiterRepository.recentOutcomes, newest first) counted as the store counts
 * them inside its BEGIN IMMEDIATE (src/store/types.ts limiterDecision: a row at or after
 * nowMs − 60 s holds a slot; the oldest of the 30 newest frees one 60 s after it). A row stamped
 * ahead of `nowMs` (stampedAhead: a clock since set back) counts as made now — the store re-stamps
 * it to the next request's instant (src/store/repos/limiter.ts). An unreadable instant holds no
 * slot. Pure and read-only: it decides nothing — the limiter does, when the read takes its slot.
 */
export function windowFreeInMs(
  newestFirst: readonly { readonly at: string }[],
  nowMs: number,
): number {
  const startMs = nowMs - WINDOW_MS;
  const rows: number[] = [];
  for (const r of newestFirst.slice(0, ESPN_LIMITER.perMinute)) {
    const at = Date.parse(r.at);
    if (!Number.isFinite(at)) continue;
    const t = stampedAhead(at, nowMs) ? nowMs : at;
    if (t >= startMs) rows.push(t);
  }
  const v = limiterDecision({
    nowMs,
    windows: [{ startMs, max: ESPN_LIMITER.perMinute }],
    windowRows: [rows],
    dailyCap: null,
  });
  return v.ok ? 0 : v.retry_after_ms;
}

/**
 * The most a run of `plannedReads` reads waits on refusals in all: the time those reads need at
 * the limiter's 30/min in whole windows (a run that fills windows itself waits at most that), plus
 * one spare window for the load of the other processes that share the bucket.
 */
export function waitBudgetMs(plannedReads: number): number {
  const n = Number.isFinite(plannedReads) ? Math.max(1, Math.ceil(plannedReads)) : 1;
  return (Math.ceil(n / ESPN_LIMITER.perMinute) + 1) * WINDOW_MS;
}

/** One wait on a refusal (counts and seconds only: what the progress line prints). */
export interface PaceWait {
  readonly reason: "window" | "retry_after" | "concurrency";
  /** The read was refused and runs again after it (false: it waits before its first try). */
  readonly retry: boolean;
  /** This wait, in whole seconds (rounded up). */
  readonly wait_s: number;
  /** Reads completed before it. */
  readonly reads: number;
  /** Waits so far, this one included. */
  readonly waits: number;
  /** The run's wait budget, in whole seconds. */
  readonly budget_s: number;
}

/** Thrown when the run's signal aborted: during a wait, or before a read would start. */
export class RunInterrupted extends Error {
  constructor() {
    super("cli: the run was interrupted");
    this.name = "RunInterrupted";
  }
}

/** What a paced run needs. */
export interface PacedRunOptions {
  readonly clock: Clock;
  /** Every wait (default: a real, referenced timer — it keeps the process alive while it waits). */
  readonly sleep?: Sleep;
  /** The command's claim on SIGINT/SIGTERM (null: never interrupted). */
  readonly signal?: AbortSignal | null;
  /** The most reads the run expects (sizes the wait budget; `plan` raises it). */
  readonly plannedReads: number;
  /** The pacing interval (default RUN_PACE_MS; 0 turns pacing off). */
  readonly paceMs?: number;
  /** Told of each wait — on a refusal or a window seen full — before it starts (one progress line). */
  readonly onWait?: (w: PaceWait) => void | Promise<void>;
  /**
   * The ms until the shared window has a free slot, read-only (windowFreeInMs over the store's
   * newest limiter rows); looked at before every read. Absent, or throwing, or not positive: no
   * wait before the read (the limiter decides as it always does — and fails closed on its own).
   */
  readonly windowFreeInMs?: () => number;
}

/** A run of ESPN reads, paced and waiting out the limiter's refusals (this module's header). */
export class PacedRun {
  private readonly clock: Clock;
  private readonly sleep: Sleep;
  private readonly signal: AbortSignal | null;
  private readonly paceMs: number;
  private readonly onWait: ((w: PaceWait) => void | Promise<void>) | null;
  private readonly windowFree: (() => number) | null;
  private planned: number;
  private done = 0;
  private waitCount = 0;
  private waitedTotal = 0;
  private lastStart: number | null = null;
  private stopped: "consecutive" | "budget" | null = null;

  constructor(opts: PacedRunOptions) {
    this.clock = opts.clock;
    this.sleep = opts.sleep ?? realSleep;
    this.signal = opts.signal ?? null;
    this.paceMs = Math.max(0, opts.paceMs ?? RUN_PACE_MS);
    this.onWait = opts.onWait ?? null;
    this.windowFree = opts.windowFreeInMs ?? null;
    this.planned = Math.max(0, opts.plannedReads);
  }

  /** Raises the planned reads to `total` (never lowers them: the budget only grows). */
  plan(total: number): void {
    if (Number.isFinite(total) && total > this.planned) this.planned = total;
  }

  /** Reads completed. */
  get reads(): number {
    return this.done;
  }

  /** Waits on refusals so far. */
  get waits(): number {
    return this.waitCount;
  }

  /** The time waited on refusals so far, in ms (pacing not included). */
  get waitedMs(): number {
    return this.waitedTotal;
  }

  /** The run's wait budget now, in ms. */
  get budgetMs(): number {
    return waitBudgetMs(this.planned);
  }

  /** The bound that stopped the run (its last refusal was rethrown), or null. */
  get gaveUp(): "consecutive" | "budget" | null {
    return this.stopped;
  }

  /**
   * Runs one read: paced, a window seen full before it waited for, the limiter's window and
   * Retry-After refusals waited out (behind a STALE_ONLY too), every other failure rethrown as is.
   * `upstream(value)` says whether the answer came from ESPN (default yes): a cache hit sent
   * nothing, so the next read is not paced after it.
   */
  async read<T>(fn: () => Promise<T>, upstream: (value: T) => boolean = () => true): Promise<T> {
    let refusals = 0;
    let concurrency = 0;
    let tried = false;
    for (;;) {
      this.checkSignal();
      await this.pace();
      // the window another process filled, seen before the read: waited for here, never inside
      // the read's ≤ 20 s deadline (this module's header; a wait counted like a refusal's)
      const ahead = this.windowWaitMs(refusals);
      if (ahead > 0) {
        refusals++;
        await this.waitFor("window", ahead, tried);
        continue;
      }
      const startedAt = this.clock.nowMs();
      let value: T;
      try {
        value = await fn();
      } catch (e) {
        // a refused read may still have sent a request (a settings read before the refused one)
        this.lastStart = startedAt;
        tried = true;
        const r = limiterRefusal(e);
        if (r === null) throw e;
        // a refusal not waited on fails as the limiter's own (RATE_LIMITED), not as a STALE_ONLY
        const refusal = refusalBehind(e);
        if (r.reason === "daily_cap") throw refusal;
        if (r.reason === "concurrency" && ++concurrency > MAX_CONCURRENCY_RETRIES) throw refusal;
        if (r.reason !== "concurrency") concurrency = 0;
        if (++refusals > MAX_CONSECUTIVE_REFUSALS) {
          this.stopped = "consecutive";
          throw refusal;
        }
        const waitMs = r.retryAfterMs + WINDOW_WAIT_MARGIN_MS;
        if (this.waitedTotal + waitMs > this.budgetMs) {
          this.stopped = "budget";
          throw refusal;
        }
        await this.waitFor(r.reason, waitMs, true);
        continue;
      }
      if (upstream(value)) this.lastStart = startedAt;
      this.done++;
      return value;
    }
  }

  /**
   * The wait before a read for a window seen full (0: none) — its time to free in whole seconds
   * plus the margin; none past a bound (MAX_CONSECUTIVE_REFUSALS waits for this read, or the
   * budget), where the read goes to the limiter as it is; none when the look fails.
   */
  private windowWaitMs(refusals: number): number {
    if (this.windowFree === null) return 0;
    let free: number;
    try {
      free = this.windowFree();
    } catch {
      return 0;
    }
    if (!Number.isFinite(free) || free <= 0) return 0;
    const waitMs = Math.ceil(free / 1000) * 1000 + WINDOW_WAIT_MARGIN_MS;
    if (refusals >= MAX_CONSECUTIVE_REFUSALS || this.waitedTotal + waitMs > this.budgetMs) return 0;
    return waitMs;
  }

  /** One counted wait: announced (never after the signal — F3), slept, added to the total. */
  private async waitFor(reason: PaceWait["reason"], waitMs: number, retry: boolean): Promise<void> {
    this.checkSignal();
    this.waitCount++;
    await this.onWait?.({
      reason,
      retry,
      wait_s: Math.ceil(waitMs / 1000),
      reads: this.done,
      waits: this.waitCount,
      budget_s: Math.ceil(this.budgetMs / 1000),
    });
    await this.wait(waitMs);
    this.waitedTotal += waitMs;
  }

  /** Waits until RUN_PACE_MS after the previous upstream read started (never longer: a clock set back). */
  private async pace(): Promise<void> {
    if (this.lastStart === null || this.paceMs === 0) return;
    const left = Math.min(this.paceMs, this.lastStart + this.paceMs - this.clock.nowMs());
    if (left > 0) await this.wait(left);
  }

  private async wait(ms: number): Promise<void> {
    try {
      await this.sleep(ms, this.signal);
    } catch (e) {
      if (this.signal?.aborted === true) throw new RunInterrupted();
      throw e;
    }
    this.checkSignal();
  }

  private checkSignal(): void {
    if (this.signal?.aborted === true) throw new RunInterrupted();
  }
}

/** One wait's progress line (stderr; counts and seconds only — never a name, id or value). */
export function paceWaitText(job: string, w: PaceWait): string {
  const why =
    w.reason === "window"
      ? "the ESPN request window (30 a minute, shared with the server and the jobs) is full"
      : w.reason === "retry_after"
        ? "ESPN asked for a pause (Retry-After)"
        : "two ESPN requests are still in flight in another process";
  const then = w.retry ? "then retrying the same read" : "then reading";
  return `${job}: ${why} — waiting ${String(w.wait_s)} s, ${then} (${String(w.reads)} read(s) done; wait ${String(w.waits)}, at most ${String(w.budget_s)} s of waiting in all)`;
}
