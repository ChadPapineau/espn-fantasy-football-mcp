// run-budget.test.ts — one engine call's CPU budget across its cooperative runs (plan 07 E1 [A-7]:
// the 8 s deadline is per CALL; plan 10 A16a; Stage C finding analytics-cpu-deadline-per-run): the
// runs an engine chains share what the call has left instead of each starting a fresh 8 s.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { COOPERATIVE } from "../../../src/domain/analytics/constants.js";
import { RunBudget, runCooperative } from "../../../src/domain/analytics/cooperative.js";
import { steppingPacer } from "./helpers.js";

describe("RunBudget", () => {
  it("absent = the production deadline; null = off; a run's CPU is charged, never below 0", () => {
    expect(new RunBudget(undefined).left()).toBe(COOPERATIVE.deadlineMs);
    const off = new RunBudget(null);
    off.spend({ cpu_ms: 10_000 });
    expect(off.left()).toBeNull();
    const b = new RunBudget(100);
    b.spend({ cpu_ms: 30 });
    expect(b.left()).toBe(70);
    b.spend({ cpu_ms: 500 });
    expect(b.left()).toBe(0);
  });

  it("property: chained runs under one budget spend at most the budget plus one batch each", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 200 }),
        fc.array(fc.integer({ min: 1, max: 400 }), { minLength: 1, maxLength: 4 }),
        async (deadline, units) => {
          const pacer = steppingPacer(1);
          const budget = new RunBudget(deadline);
          let spent = 0;
          for (const n of units) {
            const r = budget.spend(
              await runCooperative(n, () => undefined, {
                pacer,
                deadlineMs: budget.left(),
                batchMs: 12,
              }),
            );
            spent += r.cpu_ms;
          }
          // each run may overrun by at most one batch (its first chunk always runs)
          expect(spent).toBeLessThanOrEqual(deadline + units.length * 13);
        },
      ),
      { numRuns: 100 },
    );
  });
});
