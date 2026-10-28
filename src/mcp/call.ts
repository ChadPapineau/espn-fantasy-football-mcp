// call.ts — one tool call's cooperative pacer: the per-CALL CPU deadline, the client's cancellation
// and progress notifications (plan 07 E1 [A-7] and E3: "past the 8 s per-call CPU deadline" →
// `partial: true`; plan 10 A16a; plan 03 §1.2: long calls send notifications/progress when the
// request carried a progressToken; MCP cancellation: the receiver SHOULD stop processing).
// Stage C findings `analytics-cpu-deadline-per-run` (each cooperative run started a fresh 8 s, so one
// E1 call chained v1 + v2 and an E3 season about seven budgets) and `mcp-request-extra-dropped` (no
// progress for a progressToken; a cancelled call ran to completion with its side effects).
// Every engine a tool runs takes `pacer: ctx.pacer`: its batches' CPU is summed per call (the
// runner reads the pacer's CPU clock at the start and end of each synchronous batch and yields
// between batches), so `cpuDeadlineOf` hands each run only what the call has left; each yield checks
// the client's signal (a cancelled call stops at its next batch boundary, before any store write)
// and, at most every PROGRESS_INTERVAL_MS, notifies progress. A call's spend is also the CPU its
// code ran OUTSIDE any batch (a parse, a read, assembling the answer): the thread's CPU since the call
// began, less what other calls' batches spent meanwhile — exact when calls run one at a time,
// conservative when they overlap (another call's unbatched CPU counts here too, so a run stops
// earlier, never later). Batches alone undercounted it by 1–5 s per call on a 30× slower CPU, and E8
// and E9 ran past 8 s with partial false (Stage C finding analytics-cpu-deadline-per-run). New here.
import { loopPacer, type Pacer } from "../domain/analytics/index.js";
import type { Clock } from "../domain/clock.js";

/** The fewest milliseconds between two progress notifications of one call. */
export const PROGRESS_INTERVAL_MS = 250;

/** What the transport hands a call beyond its arguments (the SDK's request context, narrowed). */
export interface CallControls {
  /** Aborts when the client cancels the request (notifications/cancelled) or the transport closes. */
  readonly signal?: AbortSignal | undefined;
  /** Sends one notifications/progress with a strictly increasing `progress` (token bound by the caller). */
  readonly progress?: ((progress: number) => void) | undefined;
}

/** Thrown at a cooperative yield once the client cancelled: the call stops, nothing is written. */
export class CallCancelled extends Error {
  constructor() {
    super("call cancelled by the client");
    this.name = "CallCancelled";
  }
}

/** One call's pacer plus its CPU account and cancellation state. */
export interface CallPacer extends Pacer {
  /** The thread's CPU (ms); always present, so the runner counts the deadline in CPU. */
  cpuMs(): number;
  /** The same meter read without pairing (the runner's in-batch deadline check). */
  cpuPeekMs(): number;
  /**
   * CPU (ms) this call has spent so far: the thread's CPU since it began less other calls' batches
   * meanwhile (never less than its own batches); its batches alone when the base pacer has no CPU
   * clock.
   */
  spentMs(): number;
  /** CPU (ms) this call's cooperative batches have spent so far (a part of `spentMs`). */
  batchMs(): number;
  /** Whether the client cancelled this call. */
  cancelled(): boolean;
  /** Throws CallCancelled when the client cancelled (before a side effect, a request, a reply). */
  throwIfCancelled(): void;
}

/** Every call's batch CPU, summed process-wide (a call subtracts the others' share from its own). */
const BATCH_LEDGER = { ms: 0 };

/**
 * Where a call's CPU account starts (the tool wrapper's reads of the base pacer's CPU meter): the
 * call's own CPU before its turn (`spentBefore`: the handler's entry — its in-flight bookkeeping and
 * input validation, synchronous, so no other call runs inside it) and the reading its turn resumed
 * at (`startCpu`: beforeCall's per-call refresh and context set-up count from here). The turn wait
 * between the two is never charged: other calls run in it. Before, the account began only once the
 * context was built, so every call's first 1–2 ms of CPU (6–12 ms on a 6× slower CPU) went
 * uncounted (Stage C finding ci-cpu-deadline-scaled-flaky). Absent: the account starts when the
 * pacer is made (a resource read, the engines' own tests).
 */
export interface CallAccount {
  readonly startCpu: number;
  readonly spentBefore: number;
}

/**
 * The pacer one tool call hands every engine it runs. `base` is the production loop pacer (the
 * injected clock, the thread's CPU, the process-wide turn gate). The runner reads `cpuMs()` once at
 * a batch's start and once at its end, and yields between batches, so the CPU between the two reads
 * of a batch is this call's own: batches are synchronous, so no other call runs inside one. The
 * call's spend (`spentMs`) is the thread's CPU since the pacer was made, less the other calls'
 * batches since then — never less than its own batches.
 */
export function callPacer(
  base: Pacer,
  controls: CallControls = {},
  wallMs: () => number = () => performance.now(),
  account?: CallAccount,
): CallPacer {
  let spent = 0;
  let batchStart: number | null = null;
  let sent = 0;
  let lastSent = Number.NEGATIVE_INFINITY;
  const signal = controls.signal;
  const cancelled = (): boolean => signal?.aborted === true;
  const throwIfCancelled = (): void => {
    if (cancelled()) throw new CallCancelled();
  };
  const cpuNow = (): number => (base.cpuMs === undefined ? base.nowMs() : base.cpuMs());
  const hasCpu = base.cpuMs !== undefined;
  const fromAccount = hasCpu && account !== undefined && Number.isFinite(account.startCpu);
  const startCpu = fromAccount ? account.startCpu : cpuNow();
  const before =
    fromAccount && Number.isFinite(account.spentBefore) ? Math.max(0, account.spentBefore) : 0;
  const ledgerAtStart = BATCH_LEDGER.ms;
  return Object.freeze({
    nowMs: () => base.nowMs(),
    cpuMs: () => {
      const now = cpuNow();
      if (batchStart === null) batchStart = now;
      else {
        const d = Math.max(0, now - batchStart);
        spent += d;
        BATCH_LEDGER.ms += d;
        batchStart = null;
      }
      return now;
    },
    yieldToLoop: async () => {
      // a batch never spans a yield: an unpaired start read is dropped, never counted twice
      batchStart = null;
      throwIfCancelled();
      const progress = controls.progress;
      if (progress !== undefined) {
        const t = wallMs();
        if (t - lastSent >= PROGRESS_INTERVAL_MS) {
          lastSent = t;
          sent += 1;
          try {
            progress(sent);
          } catch {
            // a notification that cannot be sent never fails the call
          }
        }
      }
      await base.yieldToLoop();
      throwIfCancelled();
    },
    cpuPeekMs: cpuNow,
    spentMs: () => {
      if (!hasCpu) return spent;
      const others = Math.max(0, BATCH_LEDGER.ms - ledgerAtStart - spent);
      return before + Math.max(spent, cpuNow() - startCpu - others);
    },
    batchMs: () => spent,
    cancelled,
    throwIfCancelled,
  });
}

/** The production call pacer over the injected clock (its account from `account` when given). */
export function productionCallPacer(
  clock: Clock,
  controls: CallControls = {},
  account?: CallAccount,
): CallPacer {
  return callPacer(loopPacer(clock), controls, undefined, account);
}

/**
 * What remains of a per-call CPU deadline after `spent` ms (null = the deadline is off — the
 * test-only switch, changelog R5). Never negative: a run handed 0 does one batch and reports partial.
 */
export function remainingDeadline(deadline: number | null, spent: number): number | null {
  return deadline === null ? null : Math.max(0, deadline - spent);
}

/**
 * The SDK request context, narrowed to what a call uses: its abort signal, and a progress sender
 * bound to the request's progressToken (absent → no progress is ever sent). Defensive: any shape the
 * SDK does not hand over reads as "no controls".
 */
export function controlsFromRequest(extra: unknown): CallControls {
  if (typeof extra !== "object" || extra === null) return {};
  const req = (extra as { mcpReq?: unknown }).mcpReq;
  if (typeof req !== "object" || req === null) return {};
  const r = req as {
    signal?: unknown;
    _meta?: { progressToken?: unknown } | undefined;
    notify?: unknown;
  };
  const signal = r.signal instanceof AbortSignal ? r.signal : undefined;
  const token = r._meta?.progressToken;
  const notify = r.notify;
  const hasToken =
    typeof token === "string" || (typeof token === "number" && Number.isFinite(token));
  const progress =
    hasToken && typeof notify === "function"
      ? (p: number): void => {
          void Promise.resolve(
            (notify as (n: unknown) => unknown)({
              method: "notifications/progress",
              params: { progressToken: token, progress: p },
            }),
          ).catch(() => undefined);
        }
      : undefined;
  return {
    ...(signal === undefined ? {} : { signal }),
    ...(progress === undefined ? {} : { progress }),
  };
}
