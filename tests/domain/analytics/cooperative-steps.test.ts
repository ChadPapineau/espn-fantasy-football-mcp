// cooperative-steps.test.ts — the cooperative runner over resumable work (cooperative.ts
// runCooperativeSteps, drainSteps, inTurns; plan 03 §1.2: the loop never blocks for more than one
// ≤ 20 ms CPU batch; changelog §R10 timing items). runCooperativeSteps runs a generator's steps in
// runCooperative's batches — every step once, in order, the same yields for the same work — returns
// the work's value, and its deadline stops it between two steps; drainSteps is the same work in one
// go; inTurns ends a loop turn at every yield. Deterministic pacers and a loop-turn counter; no wall
// time is asserted.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  drainSteps,
  inTurns,
  runCooperative,
  runCooperativeSteps,
} from "../../../src/domain/analytics/cooperative.js";
import { instantPacer, steppingPacer } from "./helpers.js";

/** n steps of work: each step records its index; the value is the count. */
function* counting(n: number, log: number[]): Generator<void, number, undefined> {
  for (let i = 0; i < n; i++) {
    log.push(i);
    yield;
  }
  return n;
}

/** One increment per event-loop iteration (an immediate queued inside an immediate runs next turn). */
function turnCounter(): { now: () => number; stop: () => void } {
  let turn = 0;
  let on = true;
  const tick = (): void => {
    turn += 1;
    if (on) setImmediate(tick);
  };
  setImmediate(tick);
  return {
    now: () => turn,
    stop: () => {
      on = false;
    },
  };
}

describe("runCooperativeSteps", () => {
  it("runs every step once, in order, and returns the work's value with done: true", async () => {
    const log: number[] = [];
    const r = await runCooperativeSteps(counting(25, log), { pacer: instantPacer });
    expect(log).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(r).toMatchObject({ done: true, value: 25, partial: false, completed: 25 });
  });

  it("property: the same batches and yields as runCooperative over the same steps", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 60 }),
        fc.integer({ min: 1, max: 15 }),
        async (n, ms) => {
          const a = steppingPacer(ms);
          const unitsLog: number[] = [];
          const units = await runCooperative(n, (i) => unitsLog.push(i), {
            pacer: a,
            deadlineMs: null,
          });
          const b = steppingPacer(ms);
          const stepsLog: number[] = [];
          const steps = await runCooperativeSteps(counting(n, stepsLog), {
            pacer: b,
            deadlineMs: null,
          });
          expect(stepsLog).toEqual(unitsLog);
          expect(steps.completed).toBe(units.completed);
          expect(steps.done).toBe(true);
          // the steps run yields once more at the start for empty work (its length is unknown), and
          // the step that finds the end is one more clock read; otherwise the same batches
          if (n > 0) {
            expect(steps.batches).toBeGreaterThanOrEqual(units.batches);
            expect(steps.batches).toBeLessThanOrEqual(units.batches + 1);
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it("the deadline stops the work between two steps: done false, no value, the steps run counted", async () => {
    const log: number[] = [];
    // a clock that moves 1 ms a read: a 20 ms deadline is reached long before 500 steps
    const r = await runCooperativeSteps(counting(500, log), {
      pacer: steppingPacer(1),
      deadlineMs: 20,
    });
    expect(r.done).toBe(false);
    expect(r.partial).toBe(true);
    expect(r.value).toBeUndefined();
    expect(r.completed).toBe(log.length);
    expect(log.length).toBeGreaterThan(0);
    expect(log.length).toBeLessThan(500);
  });

  it("an error thrown by a step reaches the caller; later steps never run", async () => {
    const log: number[] = [];
    function* failing(): Generator<void, number, undefined> {
      log.push(0);
      yield;
      throw new Error("step 1");
    }
    await expect(runCooperativeSteps(failing(), { pacer: instantPacer })).rejects.toThrow("step 1");
    expect(log).toEqual([0]);
  });

  it("drainSteps is the same work in one go: the same value and order", () => {
    const a: number[] = [];
    expect(drainSteps(counting(9, a))).toBe(9);
    expect(a).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("inTurns", () => {
  it("each yield of the work ends a loop turn: no two steps share one", async () => {
    const turns = turnCounter();
    const seen: number[] = [];
    function* work(): Generator<void, string, undefined> {
      for (let i = 0; i < 6; i++) {
        seen.push(turns.now());
        yield;
      }
      seen.push(turns.now());
      return "done";
    }
    expect(await inTurns(work())).toBe("done");
    turns.stop();
    expect(seen).toHaveLength(7);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1] ?? 0);
  });

  it("work that never yields is answered in the caller's turn; an error propagates", async () => {
    function* none(): Generator<void, number, undefined> {
      return 3;
    }
    expect(await inTurns(none())).toBe(3);
    function* bad(): Generator<void, number, undefined> {
      yield;
      throw new RangeError("bad");
    }
    await expect(inTurns(bad())).rejects.toThrow(RangeError);
  });
});
