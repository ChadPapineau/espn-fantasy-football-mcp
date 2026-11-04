// view-parse-steps.test.ts — a large view's schema parse in steps (views/index.ts parseViewSteps;
// provider.ts parseRosterSteps, mRoster a team a step; request.ts runs a body over
// YIELD_BEFORE_PARSE_CHARS through `inTurns`, fresh and cached; plan 03 §1.2's ≤ 20 ms batch;
// changelog §R10 timing items: the 1 MB roster's parse was one 20–30 ms turn on the owner's Mac).
// The value is parseView's — the same output, its keys in the same order — over recorded rosters and
// random ones; any failure gives parseView's signals for the whole body (the same paths, the same
// order); a schema the split cannot read the same way, a short array and a non-object are parsed
// whole. Counted, never timed: no step parses more than STEP_ELEMENTS elements — a fixed ceiling —
// and a roster takes a step per team.
import fc from "fast-check";
import { z } from "zod/v4";
import { describe, expect, it } from "vitest";
import { drainSteps } from "../../../src/domain/analytics/cooperative.js";
import {
  mRosterSchema,
  parseView,
  parseViewSteps,
} from "../../../src/providers/espn/views/index.js";
import { loadRoster } from "./helpers.js";

/** The most array elements one step may parse: a literal (mRoster: one team, ~16 entries). */
const STEP_ELEMENTS = 1;

const rosters = [
  loadRoster("league-a", 1),
  loadRoster("league-a", 3),
  loadRoster("league-b", 2),
  loadRoster("league-c", 3),
];
const steps = (body: unknown, per = 1) =>
  drainSteps(parseViewSteps("mRoster", mRosterSchema, body, "teams", per));

describe("parseViewSteps: parseView's value, a slice a step", () => {
  it("recorded rosters: the same value as parseView, byte for byte, for any slice", () => {
    for (const r of rosters) {
      const whole = parseView("mRoster", mRosterSchema, r);
      expect(whole.ok).toBe(true);
      for (const per of [1, 2, 5])
        expect(JSON.stringify(steps(r, per))).toBe(JSON.stringify(whole));
    }
  });

  it("property: a broken entry anywhere — the whole body's signals, the same paths in the same order", () => {
    const base = rosters[0] as { teams: { roster: { entries: Record<string, unknown>[] } }[] };
    fc.assert(
      fc.property(
        fc.nat({ max: base.teams.length - 1 }),
        fc.nat({ max: 15 }),
        fc.constantFrom("playerId", "lineupSlotId", "playerPoolEntry"),
        fc.boolean(),
        (t, e, key, shellToo) => {
          const body = structuredClone(base) as typeof base & { status?: unknown };
          const entries = body.teams[t]?.roster.entries ?? [];
          const entry = entries[e % Math.max(1, entries.length)];
          if (entry !== undefined) entry[key] = "not a number";
          if (shellToo) body.status = "broken";
          const want = parseView("mRoster", mRosterSchema, body);
          expect(JSON.stringify(steps(body))).toBe(JSON.stringify(want));
        },
      ),
      { numRuns: 60 },
    );
  });

  it("a broken shell alone, a short array, a non-object and a schema it cannot split: parsed whole", () => {
    const r: Record<string, unknown> = rosters[1] ?? {};
    const shell = { ...r, status: "broken" };
    expect(JSON.stringify(steps(shell))).toBe(
      JSON.stringify(parseView("mRoster", mRosterSchema, shell)),
    );
    const one = { ...r, teams: (r.teams as unknown[]).slice(0, 1) };
    expect(JSON.stringify(steps(one))).toBe(
      JSON.stringify(parseView("mRoster", mRosterSchema, one)),
    );
    for (const odd of [null, [], "x", { teams: "no" }])
      expect(steps(odd)).toEqual(parseView("mRoster", mRosterSchema, odd));
    // an array with a length check, an object with a refinement: the split would not read them the
    // same way (an empty array fails min), so they are parsed whole
    const checked = z.looseObject({ teams: z.array(z.number()).min(2) });
    const refined = z.looseObject({ teams: z.array(z.number()) }).refine((b) => b.teams.length > 2);
    for (const schema of [checked, refined] as z.ZodType[]) {
      const body = { teams: [1, 2, 3, 4] };
      let yields = 0;
      const work = parseViewSteps("mRoster", schema, body, "teams", 1);
      for (let r2 = work.next(); r2.done !== true; r2 = work.next()) yields += 1;
      expect(yields).toBe(0);
    }
  });

  it("counted: no step parses more than STEP_ELEMENTS teams; a roster takes a step per team", () => {
    let parsed = 0;
    const team = z.looseObject({ id: z.number() }).refine(() => {
      parsed += 1;
      return true;
    });
    // a counting element under the same split the provider uses (mRoster's `teams`, one a step)
    const schema = z.looseObject({ status: z.unknown(), teams: z.array(team) });
    const r = rosters[3] as { teams: unknown[] };
    const work = parseViewSteps("mRoster", schema, r, "teams", 1);
    const perStep: number[] = [];
    for (;;) {
      parsed = 0;
      const x = work.next();
      perStep.push(parsed);
      if (x.done === true) {
        expect(x.value.ok).toBe(true);
        break;
      }
    }
    expect(Math.max(...perStep)).toBeLessThanOrEqual(STEP_ELEMENTS);
    expect(perStep.filter((n) => n > 0)).toHaveLength(r.teams.length);
    expect(r.teams.length).toBeGreaterThan(4 * STEP_ELEMENTS);
  });
});
