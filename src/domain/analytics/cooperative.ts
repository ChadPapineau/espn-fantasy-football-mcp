// cooperative.ts — cooperative batching for the samplers (plan 01 §1.1: E1's sampler and the
// seeding simulator "run as cooperative batches that yield to the event loop every ≤ 20 ms of CPU
// via setImmediate, so the main-loop stall during any analytics call stays ≤ 50 ms"; plan 03 §1.2;
// plan 07 E1: the per-call CPU deadline of 8 s → `partial: true` with the completed count, never
// cached; ADV OBJ-07). Time comes from an injected Pacer (the Clock), never Date.now. A batch's length
// (the stall a heartbeat sees) is wall time; the deadline counts the thread's CPU when the pacer can
// read it, so a sleeping machine or a preempted process never cuts a run short. New here.
import { threadCpuClock, type Clock, type CpuClock } from "../clock.js";
import { COOPERATIVE } from "./constants.js";

/** Where the runner reads time and how it yields. */
export interface Pacer {
  /** Milliseconds (the injected clock). */
  nowMs(): number;
  /** Lets the event loop run (timers, stdin, the shutdown handler) before the next batch. */
  yieldToLoop(): Promise<void>;
  /**
   * The thread's CPU in milliseconds, when known: the deadline counts it (plan 07 E1's deadline is
   * CPU). Absent, the deadline counts the batches' `nowMs` time instead.
   */
  cpuMs?(): number;
}

/**
 * The production pacer: the injected clock for a batch's length, the thread's CPU for the deadline,
 * `setImmediate` to yield (plan 03 §1.2).
 */
export function loopPacer(clock: Clock, cpu: CpuClock = threadCpuClock): Pacer {
  return Object.freeze({
    nowMs: () => clock.nowMs(),
    cpuMs: () => cpu.cpuMs(),
    yieldToLoop: () =>
      new Promise<void>((resolve) => {
        setImmediate(resolve);
      }),
  });
}

/** How one cooperative run is paced. */
export interface CooperativeOptions {
  readonly pacer: Pacer;
  /** CPU per batch before a yield (default COOPERATIVE.batchMs; clamped to 1..20 ms). */
  readonly batchMs?: number | undefined;
  /**
   * The CPU deadline of the whole run (default COOPERATIVE.deadlineMs), counted in the pacer's
   * `cpuMs` when it has one; null disables it — the determinism and invariance tests run that way
   * so byte-equality cannot flake (plan 07 E1).
   */
  readonly deadlineMs?: number | null | undefined;
}

/** What a run did. */
export interface CooperativeResult {
  /** Steps completed (all of them unless the deadline stopped the run). */
  readonly completed: number;
  /** The deadline stopped the run before every step ran. */
  readonly partial: boolean;
  /** CPU spent in batches (yields excluded): the pacer's `cpuMs` delta, else the batches' time. */
  readonly cpu_ms: number;
  readonly batches: number;
  /**
   * The longest single batch (the stall a heartbeat would see): within batchMs unless a batch's
   * last chunk of steps took longer than every chunk before it in the run, or one chunk alone took
   * batchMs or more (see runCooperative).
   */
  readonly max_batch_ms: number;
}

/** The fewest and most steps between two clock reads (adaptive: ~1 ms between reads). */
const CHECK_MIN = 1;
const CHECK_MAX = 4096;

/**
 * Runs `step(i)` for i = 0..units−1 in batches of at most `batchMs` of CPU, yielding to the event
 * loop before the first batch, between batches and after the last one; stops early (partial) once
 * the CPU spent reaches the deadline. A batch ends by its `nowMs` time (the stall bound); the CPU
 * spent is the pacer's `cpuMs` delta over the batch when it has one, so time the thread did not run
 * (a preempted process, a machine asleep mid-batch) is never counted — inside a batch the `nowMs`
 * time bounds it from above, so the in-batch check can only end a batch early, never the run. Steps
 * run in index order exactly once each, so a deterministic step function gives a deterministic
 * prefix. Throws RangeError for a negative or non-integer `units`. The yields around the run keep
 * the caller's synchronous work before it (a parse, a precompute) and after it (assembling the
 * answer) out of a batch's turn: chained, the two once made a 40–50 ms stall from 16 ms batches
 * (plan 10 A16a's end-to-end probe). A batch also ends before a chunk predicted to overrun it,
 * predicted from the larger of the last chunk's pace and the longest chunk timed so far in the run
 * (capped at batchMs; a chunk's time bounds every step in it): steps of uneven cost (a trade
 * package whose partner roster is not yet memoised, a bench audit) otherwise ran a batch of cheap
 * steps up to batchMs and then one heavy step past it. So a batch passes batchMs only where no
 * prediction could help: its first chunk (which always runs — progress is never blocked), a chunk
 * longer than every chunk the run timed before it, or a chunk that alone takes batchMs or more.
 */
export async function runCooperative(
  units: number,
  step: (i: number) => void,
  opts: CooperativeOptions,
): Promise<CooperativeResult> {
  if (!Number.isInteger(units) || units < 0) throw new RangeError("cooperative: bad unit count");
  const { pacer } = opts;
  const batchMs = Math.min(20, Math.max(1, opts.batchMs ?? COOPERATIVE.batchMs));
  const deadline = opts.deadlineMs === undefined ? COOPERATIVE.deadlineMs : opts.deadlineMs;
  let i = 0;
  let cpu = 0;
  let batches = 0;
  let maxBatch = 0;
  let checkEvery = CHECK_MIN;
  /** The longest chunk timed in this run (ms, ≤ batchMs) — an upper bound on any one step seen. */
  let heaviest = 0;
  if (units > 0) await pacer.yieldToLoop();
  while (i < units) {
    const start = pacer.nowMs();
    const cpuStart = pacer.cpuMs?.() ?? 0;
    let last = start;
    let elapsed = 0;
    for (;;) {
      const from = i;
      const end = Math.min(units, i + checkEvery);
      for (; i < end; i++) step(i);
      const now = pacer.nowMs();
      const gap = now - last;
      last = now;
      const perStep = gap / Math.max(1, i - from);
      heaviest = Math.max(heaviest, Math.min(batchMs, gap));
      if (gap < 0.5 && checkEvery < CHECK_MAX) checkEvery *= 2;
      else if (gap > 2 && checkEvery > CHECK_MIN) checkEvery = Math.max(CHECK_MIN, checkEvery >> 1);
      elapsed = now - start;
      if (i >= units || elapsed >= batchMs) break;
      if (deadline !== null && cpu + elapsed >= deadline) break;
      // the next chunk would run the batch past batchMs: yield first. A coarse step (a trade package,
      // a bench audit: several ms each) otherwise made a batch of batchMs plus one more step —
      // ~30 ms turns from 16 ms batches, measured by the end-to-end stall probe (plan 10 A16a). The
      // prediction is the larger of the last chunk's pace and the longest chunk timed: after a run
      // of cheap steps the next one may be a heavy one (a partner roster not yet memoised)
      const next = Math.max(perStep * Math.min(checkEvery, units - i), heaviest);
      if (elapsed + next > batchMs) break;
    }
    cpu += Math.max(0, pacer.cpuMs === undefined ? elapsed : pacer.cpuMs() - cpuStart);
    batches += 1;
    maxBatch = Math.max(maxBatch, elapsed);
    await pacer.yieldToLoop();
    if (i >= units) break;
    if (deadline !== null && cpu >= deadline) {
      return { completed: i, partial: true, cpu_ms: cpu, batches, max_batch_ms: maxBatch };
    }
  }
  return { completed: i, partial: false, cpu_ms: cpu, batches, max_batch_ms: maxBatch };
}
