// espn-pacing.ts — a long run of ESPN reads the CLI makes through the provider (plan 01 §6 and D7:
// ONE global limiter shared by every process — ≤ 30/min, ≤ 1/s, ≤ 2 in flight, one row per request
// and per retry attempt, and a read waits for its slot only until its ≤ 20 s deadline; changelog
// R6-3: the backfill). A read whose full window outlasts its deadline is refused RATE_LIMITED, so a
// run of more reads than one window holds died part-way: found at the owner's install, 2026-11-02,
// `eff transactions --backfill` (one settings read plus one mTransactions2 read per scoring period
// of each season, ~37 in all) stopped at RATE_LIMITED and was finished one `--seasons` at a time by
// hand. A PacedRun runs each read of such a run:
//  - paced: a read starts RUN_PACE_MS after the start of the previous one that went upstream (22 a
//    minute);
//  - within its share of the window, counted in requests: before every read the run looks at the
//    shared bucket's newest rows, read-only (the limiter repository's recentOutcomes, counted as the
//    store counts them: windowFreeInMs), and the read starts only while the last minute holds at
//    most RUN_START_MAX_ROWS rows of every process — room for each attempt the read can make (its
//    first and each retry on a 429, a 5xx or a timeout, a row each: READ_MAX_ROWS) inside
//    RUN_SHARE_PER_MINUTE. So the run's own requests, its retries included, are at most 24 in any
//    minute however flaky ESPN is (for reads of one request, as the backfill's are), the run alone
//    never fills the 30/min window, and the MCP server and the launchd jobs that share it find a
//    slot within a few seconds (a burst of 30 would hold the window full for half a minute, longer
//    than their reads wait: refused, a job's run failed). Pacing counted reads before, blind to a
//    read's retries: with every first attempt a 503, the run alone filled the window and was
//    refused by it (verifier finding F2 on fbbd705). Reads that go out once each find room at every
//    start at RUN_PACE_MS but for moments of latency, which are waited silently as pacing (at most
//    RUN_PACE_MS); a longer wait for the share is announced (`share`) and counted like a refusal's;
//  - waiting for a full window before the read: the same look says whether another process filled
//    the 30/min window; if it did, the run waits itself — until the window has room for the read
//    inside the share, in whole seconds, plus WINDOW_WAIT_MARGIN_MS — before the read starts. The
//    limiter would otherwise wait for it inside the read's ≤ 20 s deadline, and a wait ending just
//    before the deadline left the request only milliseconds: it timed out (ESPN_UPSTREAM_UNAVAILABLE,
//    counted by the breaker every process shares) and the run died (verifier finding F2 on
//    4141144). The limiter still decides: the read then takes its slot as any read does, and another
//    process's burst landing after the look is a refusal, below;
//  - waiting on a refusal: the limiter's own refusal for the window (`window`) or for ESPN's
//    Retry-After hold (`retry_after`) is waited out — its retry_after_s plus WINDOW_WAIT_MARGIN_MS —
//    and the same read runs again; a `concurrency` refusal (the limiter already polled for a free
//    in-flight slot through the read's whole deadline) runs again once (MAX_CONCURRENCY_RETRIES:
//    a dead process's `pending` rows age out after 30 s). A refusal the provider's stale fallback
//    turned into STALE_ONLY (only data past its hard limit cached: a week a run more than a day
//    old read) is the refusal kept as its cause, and is waited on the same (verifier finding F1 on
//    4141144: the re-run that resumes died STALE_ONLY). A spent daily cap, a second concurrency
//    refusal in a row and every other failure — ESPN's own 429 among them, a 4xx, a rejected cookie
//    — are rethrown at once, so the command's exit code and message stay as they were (a refusal
//    not waited on is rethrown as the limiter's RATE_LIMITED, never as the STALE_ONLY around it);
//  - bounded: at most MAX_CONSECUTIVE_REFUSALS waits in a row for one read (on refusals and on the
//    look before it), and in all no more waiting than the run's planned reads need at 30/min in
//    whole windows plus one spare window (waitBudgetMs: load from the other processes); the silent
//    pacing waits are not counted. A full window or a used share past a bound is not waited on —
//    the read goes to the limiter as it is (its 30/min holds; the share then does not); a refusal
//    past one is rethrown and `gaveUp` says which bound it was;
//  - cancellable, and no request after the signal: the run's signal (the command's claim on
//    SIGINT/SIGTERM, src/cli/interrupt.ts) ends a wait at once, no read starts after it
//    (RunInterrupted), and it reaches each read: every attempt runs under an upstream budget of its
//    own (the provider's per-call defaults, ≤ 3 requests and ≤ 20 s: createUpstreamBudget) that
//    the signal aborts. A read waiting inside the limiter — for the window, the 1/s gap or an
//    in-flight slot — is then refused before its slot (no row is written, nothing is sent), and a
//    request already sent is cancelled, not waited for (its row records client_error, which the
//    breaker never counts). Before, the signal reached only the run's own waits, so a read already
//    waiting in the limiter took its slot and sent up to 20 s after the Ctrl-C (verifier finding F1
//    on fbbd705). What such a read throws — a refusal, the budget's, the cancelled request's, an
//    aborted wait's (endedByAbort), itself or behind a STALE_ONLY — is the run's interrupt
//    (RunInterrupted: no wait announced, F3; no failure recorded); an answer from ESPN (a rejected
//    cookie, a 404) still fails as itself. A second signal ends the process.
// It never sends a request itself and never widens the limiter: every read still takes its slot
// from src/providers/espn/limiter.ts, which alone decides when a request goes out (the look before
// a read only reads rows and only ever adds a wait; the budget only ever refuses), and the waits
// are the injected Sleep (tests run on fake time).
import { stampedAhead } from "../config/freshness.js";
import { ESPN_BACKOFF, ESPN_LIMITER } from "../config/schema.js";
import type { Clock } from "../domain/clock.js";
import { isEspnUpstreamError } from "../providers/espn/errors.js";
import { EspnRateLimitedError, realSleep, type Sleep } from "../providers/espn/limiter.js";
import { EspnStaleOnlyError } from "../providers/espn/request.js";
import {
  createUpstreamBudget,
  UpstreamBudgetExhausted,
  type ReadOptions,
} from "../providers/platform.js";
import { limiterDecision } from "../store/types.js";

/**
 * The requests a paced run sends in any minute at the most, its reads' retries included (every
 * attempt is a row of the shared bucket): six of the limiter's 30 stay free for the others.
 */
export const RUN_SHARE_PER_MINUTE = 24;
/**
 * The rows one read can add to the shared bucket: its request's first attempt and each retry on a
 * 429, a 5xx or a timeout (ESPN_BACKOFF.maxAttempts; src/providers/espn/request.ts fetchFresh) — for
 * a read of one request, as the backfill's are (a season's settings read first; its weeks then find
 * the settings in the cache).
 */
export const READ_MAX_ROWS = ESPN_BACKOFF.maxAttempts;
/**
 * The most rows of every process the shared bucket's last minute may hold when a read starts: room
 * for each of the read's attempts inside RUN_SHARE_PER_MINUTE (24 − 3 = 21).
 */
export const RUN_START_MAX_ROWS = RUN_SHARE_PER_MINUTE - READ_MAX_ROWS;
/**
 * The least time from the start of one upstream read of a paced run to the start of the next: a
 * minute over RUN_START_MAX_ROWS + 1 reads (2728 ms, 22 a minute), so reads that go out once each
 * find room in the share at every start.
 */
export const RUN_PACE_MS = Math.ceil(60_000 / (RUN_START_MAX_ROWS + 1));
/** Added to a refusal's retry_after_s (already rounded up to whole seconds by the limiter). */
export const WINDOW_WAIT_MARGIN_MS = 500;
/**
 * Waits in a row for one read — on refusals and on the look before it (a full window, a used share)
 * — after which the run stops (the next refusal is rethrown).
 */
export const MAX_CONSECUTIVE_REFUSALS = 5;
/** `concurrency` refusals in a row one read runs again after (the next one is rethrown). */
export const MAX_CONCURRENCY_RETRIES = 1;
/** The limiter's per-minute window. */
const WINDOW_MS = 60_000;
/** The request id of a paced read's own upstream budget (src/providers/platform.ts). */
const READ_BUDGET_ID = "cli-paced-read";

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
 * How long until the shared bucket's last minute holds fewer than `max` rows at `nowMs` (0: it does
 * now) — by default the limiter's 30: until the 30/min window has a free slot — from its newest
 * rows (LimiterRepository.recentOutcomes, newest first, at least `max` of them) counted as the store
 * counts them inside its BEGIN IMMEDIATE (src/store/types.ts limiterDecision: a row at or after
 * nowMs − 60 s holds a slot; the oldest of the `max` newest frees one 60 s after it). A row stamped
 * ahead of `nowMs` (stampedAhead: a clock since set back) counts as made now — the store re-stamps
 * it to the next request's instant (src/store/repos/limiter.ts). An unreadable instant holds no
 * slot. Pure and read-only: it decides nothing — the limiter does, when the read takes its slot.
 */
export function windowFreeInMs(
  newestFirst: readonly { readonly at: string }[],
  nowMs: number,
  max: number = ESPN_LIMITER.perMinute,
): number {
  const startMs = nowMs - WINDOW_MS;
  const rows: number[] = [];
  for (const r of newestFirst.slice(0, max)) {
    const at = Date.parse(r.at);
    if (!Number.isFinite(at)) continue;
    const t = stampedAhead(at, nowMs) ? nowMs : at;
    if (t >= startMs) rows.push(t);
  }
  const v = limiterDecision({
    nowMs,
    windows: [{ startMs, max }],
    windowRows: [rows],
    dailyCap: null,
  });
  return v.ok ? 0 : v.retry_after_ms;
}

/**
 * How long until the shared bucket's last minute has room for a read inside the run's share at
 * `nowMs` — at most RUN_START_MAX_ROWS rows of every process (0: it has now; windowFreeInMs, from
 * the same newest rows). Pure and read-only.
 */
export function shareFreeInMs(
  newestFirst: readonly { readonly at: string }[],
  nowMs: number,
): number {
  return windowFreeInMs(newestFirst, nowMs, RUN_START_MAX_ROWS + 1);
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

/** One wait on a refusal or the look (counts and seconds only: what the progress line prints). */
export interface PaceWait {
  /** `share`: the window holds no room for the read inside the run's share (not full). */
  readonly reason: "window" | "share" | "retry_after" | "concurrency";
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

/** Thrown when the run's signal aborted: during a wait, before a read would start, or ending one. */
export class RunInterrupted extends Error {
  constructor() {
    super("cli: the run was interrupted");
    this.name = "RunInterrupted";
  }
}

/**
 * Whether `e` is what a read the run's signal ended throws (asked only once the signal aborted):
 * the limiter's refusal of a read waiting for its slot (EspnRateLimitedError — the slot never
 * taken: no row, nothing sent), the budget's (UpstreamBudgetExhausted: no request started), the
 * cancelled request's or the left read's (EspnUpstreamError `aborted`), an aborted wait's
 * (AbortError) or the run's own interrupt — itself or behind a STALE_ONLY (the provider's stale
 * fallback keeps it as the cause; one level). An answer from ESPN (a rejected cookie, a 404, a
 * drift) is none: it is the read's own outcome.
 */
export function endedByAbort(e: unknown): boolean {
  const r = e instanceof EspnStaleOnlyError ? e.cause : e;
  return (
    r instanceof EspnRateLimitedError ||
    r instanceof UpstreamBudgetExhausted ||
    r instanceof RunInterrupted ||
    (isEspnUpstreamError(r) && r.kind === "aborted") ||
    (r instanceof Error && r.name === "AbortError")
  );
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
  /**
   * Told of each counted wait — on a refusal, a full window or a used share — before it starts (one
   * progress line); a silent pacing wait is not told.
   */
  readonly onWait?: (w: PaceWait) => void | Promise<void>;
  /**
   * The shared bucket's newest rows, newest first, read-only (LimiterRepository.recentOutcomes of
   * at least ESPN_LIMITER.perMinute rows): read once before every read, for the window and the
   * share (windowFreeInMs, shareFreeInMs). Absent, or throwing: no wait before the read (the
   * limiter decides as it always does — and fails closed on its own).
   */
  readonly bucketRows?: () => readonly { readonly at: string }[];
}

/** The look before a read: a counted wait (`announced`), or a silent pacing one. */
interface LookWait {
  readonly reason: "window" | "share";
  readonly ms: number;
  readonly announced: boolean;
}

/** A run of ESPN reads, paced and waiting out the limiter's refusals (this module's header). */
export class PacedRun {
  private readonly clock: Clock;
  private readonly sleep: Sleep;
  private readonly signal: AbortSignal | null;
  private readonly paceMs: number;
  private readonly onWait: ((w: PaceWait) => void | Promise<void>) | null;
  private readonly bucketRows: (() => readonly { readonly at: string }[]) | null;
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
    this.bucketRows = opts.bucketRows ?? null;
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
   * Runs one read: paced, a full window or a used share seen before it waited for, the limiter's
   * window and Retry-After refusals waited out (behind a STALE_ONLY too), every other failure
   * rethrown as is. Each attempt of `fn` gets ReadOptions with an upstream budget of its own that
   * the run's signal aborts (pass them to the provider read: a read waiting inside the limiter is
   * then refused before its slot). `upstream(value)` says whether the answer came from ESPN
   * (default yes): a cache hit sent nothing, so the next read is not paced after it.
   */
  async read<T>(
    fn: (opts: ReadOptions) => Promise<T>,
    upstream: (value: T) => boolean = () => true,
  ): Promise<T> {
    let refusals = 0;
    let concurrency = 0;
    let tried = false;
    for (;;) {
      this.checkSignal();
      await this.pace();
      // the look before the read (this module's header): a window another process filled, or one
      // without room for the read inside the run's share, is waited for here — never inside the
      // read's ≤ 20 s deadline — counted like a refusal's wait; moments of the share are pacing
      const ahead = this.look(refusals);
      if (ahead?.announced === true) {
        refusals++;
        await this.waitFor(ahead.reason, ahead.ms, tried);
        continue;
      }
      if (ahead !== null) await this.wait(ahead.ms);
      const startedAt = this.clock.nowMs();
      const a = await this.attempt(fn, startedAt);
      if (a.ok) {
        if (upstream(a.value)) this.lastStart = startedAt;
        this.done++;
        return a.value;
      }
      const e = a.error;
      // a refused read may still have sent a request (a settings read before the refused one)
      this.lastStart = startedAt;
      tried = true;
      // the run's signal ended the read — refused before its slot, its request cancelled, a wait
      // cut: the run's interrupt, never a failure (verifier finding F1 on fbbd705); ESPN's own
      // answer (a rejected cookie, a 404) still fails as itself
      if (this.signal?.aborted === true && endedByAbort(e)) throw new RunInterrupted();
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
    }
  }

  /**
   * One attempt of a read, under an upstream budget of its own (createUpstreamBudget's per-call
   * defaults: ≤ 3 requests, ≤ 20 s from `nowMs`) that the run's signal aborts while it runs; the
   * listener is removed when the attempt ends. Its outcome, never thrown.
   */
  private async attempt<T>(
    fn: (opts: ReadOptions) => Promise<T>,
    nowMs: number,
  ): Promise<
    { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }
  > {
    const budget = createUpstreamBudget(READ_BUDGET_ID, nowMs);
    const signal = this.signal;
    const onAbort = (): void => {
      budget.abort();
    };
    if (signal?.aborted === true) budget.abort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return { ok: true, value: await fn({ budget }) };
    } catch (error) {
      return { ok: false, error };
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * The look before a read (null: no wait), from the shared bucket's newest rows read once: until
   * the window has room for the read inside the run's share (shareFreeInMs; never sooner than a
   * full window frees). A wait no longer than the pacing interval while the window is not full is
   * pacing — moments between a read's start and its row — silent and uncounted, its exact time
   * plus 1 ms (the window's start is inclusive). Else the wait is counted (`window` when full,
   * else `share`): its time in whole seconds plus the margin — none past a bound
   * (MAX_CONSECUTIVE_REFUSALS waits for this read, or the budget), where the read goes to the
   * limiter as it is; none when the look fails.
   */
  private look(refusals: number): LookWait | null {
    if (this.bucketRows === null) return null;
    let full: number;
    let room: number;
    try {
      const rows = this.bucketRows();
      const now = this.clock.nowMs();
      full = windowFreeInMs(rows, now);
      room = shareFreeInMs(rows, now);
    } catch {
      return null;
    }
    if (!Number.isFinite(room) || room <= 0) return null;
    if (full <= 0 && room <= this.paceMs)
      return { reason: "share", ms: room + 1, announced: false };
    const ms = Math.ceil(room / 1000) * 1000 + WINDOW_WAIT_MARGIN_MS;
    if (refusals >= MAX_CONSECUTIVE_REFUSALS || this.waitedTotal + ms > this.budgetMs) return null;
    return { reason: full > 0 ? "window" : "share", ms, announced: true };
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
  // `share`: the window holds no room for the read inside the run's share — RUN_SHARE_PER_MINUTE,
  // six of the 30 left free (fixed words, held by the tests)
  const why =
    w.reason === "window"
      ? "the ESPN request window (30 a minute, shared with the server and the jobs) is full"
      : w.reason === "share"
        ? "the ESPN request window (30 a minute, shared with the server and the jobs) is near full (the run keeps six free)"
        : w.reason === "retry_after"
          ? "ESPN asked for a pause (Retry-After)"
          : "two ESPN requests are still in flight in another process";
  const then = w.retry ? "then retrying the same read" : "then reading";
  return `${job}: ${why} — waiting ${String(w.wait_s)} s, ${then} (${String(w.reads)} read(s) done; wait ${String(w.waits)}, at most ${String(w.budget_s)} s of waiting in all)`;
}
