// cooperative.ts — cooperative batching for the samplers (plan 01 §1.1: E1's sampler and the
// seeding simulator "run as cooperative batches that yield to the event loop every ≤ 20 ms of CPU
// via setImmediate, so the main-loop stall during any analytics call stays ≤ 50 ms"; plan 03 §1.2;
// plan 07 E1: the per-call CPU deadline of 8 s → `partial: true` with the completed count, never
// cached; ADV OBJ-07). Time comes from an injected Pacer (the Clock), never Date.now. New here.
import type { Clock } from "../clock.js";
import { COOPERATIVE } from "./constants.js";

/** Where the runner reads time and how it yields. */
export interface Pacer {
  /** Milliseconds (the injected clock). */
  nowMs(): number;
  /** Lets the event loop run (timers, stdin, the shutdown handler) before the next batch. */
  yieldToLoop(): Promise<void>;
}

/** The production pacer: the injected clock for time, `setImmediate` to yield (plan 03 §1.2). */
export function loopPacer(clock: Clock): Pacer {
  return Object.freeze({
    nowMs: () => clock.nowMs(),
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
   * The CPU deadline of the whole run (default COOPERATIVE.deadlineMs); null disables it — the
   * determinism and invariance tests run that way so byte-equality cannot flake (plan 07 E1).
   */
  readonly deadlineMs?: number | null | undefined;
}

/** What a run did. */
export interface CooperativeResult {
  /** Steps completed (all of them unless the deadline stopped the run). */
  readonly completed: number;
  /** The deadline stopped the run before every step ran. */
  readonly partial: boolean;
  /** CPU spent in batches (yields excluded). */
  readonly cpu_ms: number;
  readonly batches: number;
  /** The longest single batch (the stall a heartbeat would see, at most one step past batchMs). */
  readonly max_batch_ms: number;
}

/** The fewest and most steps between two clock reads (adaptive: ~1 ms between reads). */
const CHECK_MIN = 1;
const CHECK_MAX = 4096;

/**
 * Runs `step(i)` for i = 0..units−1 in batches of at most `batchMs` of CPU, yielding to the event
 * loop between batches; stops early (partial) once the CPU spent reaches the deadline. Steps run in
 * index order exactly once each, so a deterministic step function gives a deterministic prefix.
 * Throws RangeError for a negative or non-integer `units`.
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
  while (i < units) {
    const start = pacer.nowMs();
    let last = start;
    let elapsed = 0;
    for (;;) {
      const end = Math.min(units, i + checkEvery);
      for (; i < end; i++) step(i);
      const now = pacer.nowMs();
      const gap = now - last;
      last = now;
      if (gap < 0.5 && checkEvery < CHECK_MAX) checkEvery *= 2;
      else if (gap > 2 && checkEvery > CHECK_MIN) checkEvery = Math.max(CHECK_MIN, checkEvery >> 1);
      elapsed = now - start;
      if (i >= units || elapsed >= batchMs) break;
      if (deadline !== null && cpu + elapsed >= deadline) break;
    }
    cpu += Math.max(0, elapsed);
    batches += 1;
    maxBatch = Math.max(maxBatch, elapsed);
    if (i >= units) break;
    if (deadline !== null && cpu >= deadline) {
      return { completed: i, partial: true, cpu_ms: cpu, batches, max_batch_ms: maxBatch };
    }
    await pacer.yieldToLoop();
  }
  return { completed: i, partial: false, cpu_ms: cpu, batches, max_batch_ms: maxBatch };
}
