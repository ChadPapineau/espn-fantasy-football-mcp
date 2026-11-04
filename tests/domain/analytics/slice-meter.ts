// slice-meter.ts — test meters for the turn gate's slice account (src/domain/analytics/cooperative.ts
// setSliceMeter, SLICE_CPU_MS, turnIfSpent, inTurns; round 3's review of changelog §R10's timing
// items). The thread's own CPU decides in production whether a conditional yield gives up its turn;
// these meters make that decision deterministic: frozen, every conditional yield passes (the work
// counts only the gate passes it cannot skip); spending a slice a read, every one gives up the turn
// (each step in a turn of its own). Test code only.
import { SLICE_CPU_MS, setSliceMeter } from "../../../src/domain/analytics/cooperative.js";
import type { CpuClock } from "../../../src/domain/clock.js";

/** A meter that never moves: no slice ever spends its share, so no conditional yield is taken. */
export const frozenMeter: CpuClock = Object.freeze({ cpuMs: () => 0 });

/** A meter that moves `perRead` ms at every read (a full slice by default): every check yields. */
export function spendingMeter(perRead: number = SLICE_CPU_MS): CpuClock {
  let t = 0;
  return { cpuMs: () => (t += perRead) };
}

/** A meter moved only by hand (`spend`), read without moving. */
export function manualMeter(): CpuClock & { spend: (ms: number) => void } {
  let t = 0;
  return {
    cpuMs: () => t,
    spend: (ms: number) => {
      t += ms;
    },
  };
}

/** Runs `f` with the slice account on `meter`, then puts the meter it replaced back. */
export async function withSliceMeter<T>(meter: CpuClock, f: () => Promise<T>): Promise<T> {
  const previous = setSliceMeter(meter);
  try {
    return await f();
  } finally {
    setSliceMeter(previous);
  }
}
