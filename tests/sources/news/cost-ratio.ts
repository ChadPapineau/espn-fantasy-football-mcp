// cost-ratio.ts — the news matcher's cost-ratio measure (tests/sources/news/match.perf.test.ts;
// ruling R8-8's bounds, unchanged; changelog §R10 timing items). One macOS CI run timed "Henderson"
// at 6.4 times a benign item on the wall clock: the benign item was timed once, before every
// adversarial one, as medians of wall time, on a runner whose idle control stalled 44 ms in the same
// job — a host stall during the benign timing moves every ratio. Here the two are timed in
// interleaved pairs (benign first, then the other first, alternately, so a slow stretch of the host
// falls on both of a pair), each in the calling thread's own CPU time (a preempted thread spends
// none), each over a batch of calls long enough for the meter to read, and the verdict is the
// median of the per-pair ratios. A positive control in the perf file holds that the measure still
// fails a matcher whose cost is quadratic. Test code only.

/** The calling thread's CPU time (ms): user + system. */
function threadCpuMs(): number {
  const c = process.threadCpuUsage();
  return (c.user + c.system) / 1000;
}

/** The thread's CPU (ms) over `reps` calls of `f`. */
function cpuOf(f: () => unknown, reps: number): number {
  const t0 = threadCpuMs();
  for (let i = 0; i < reps; i++) f();
  return threadCpuMs() - t0;
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};

/** One cost-ratio measurement: the verdict and what it rests on. */
export interface CostRatio {
  /** The median of the per-pair ratios (`a`'s CPU over `b`'s). */
  readonly ratio: number;
  readonly ratios: readonly number[];
  /** The median CPU of one call of each (ms). */
  readonly a_ms: number;
  readonly b_ms: number;
  /** Calls per timed batch. */
  readonly reps: number;
}

/** The least CPU (ms) one timed batch of `b` takes: well above the thread meter's resolution. */
export const BATCH_MIN_CPU_MS = 4;

/**
 * The cost of `a` against `b` (a small multiple is a linear reading; a large one is not): after a
 * warm-up, `pairs` interleaved pairs, each side a batch of the same number of calls, timed in the
 * thread's CPU; the median of the per-pair ratios.
 */
export function costRatio(a: () => unknown, b: () => unknown, pairs = 15): CostRatio {
  for (let i = 0; i < 5; i++) {
    a();
    b();
  }
  let reps = 1;
  while (reps < 4096 && cpuOf(b, reps) < BATCH_MIN_CPU_MS) reps *= 2;
  const ratios: number[] = [];
  const as: number[] = [];
  const bs: number[] = [];
  for (let i = 0; i < pairs; i++) {
    let ta: number;
    let tb: number;
    if (i % 2 === 0) {
      tb = cpuOf(b, reps);
      ta = cpuOf(a, reps);
    } else {
      ta = cpuOf(a, reps);
      tb = cpuOf(b, reps);
    }
    as.push(ta / reps);
    bs.push(tb / reps);
    ratios.push(ta / Math.max(tb, 1e-3));
  }
  return { ratio: median(ratios), ratios, a_ms: median(as), b_ms: median(bs), reps };
}

/** A measurement as one line for an assertion's message (ms to 0.01, the ratio to 0.1). */
export function ratioEvidence(r: CostRatio): string {
  const f = (x: number, d: number): string => x.toFixed(d);
  return `ratio ${f(r.ratio, 1)} (${f(r.a_ms, 2)} ms against ${f(r.b_ms, 2)} ms of CPU, ${String(r.reps)} calls a batch; pairs ${r.ratios.map((x) => f(x, 1)).join(" ")})`;
}
