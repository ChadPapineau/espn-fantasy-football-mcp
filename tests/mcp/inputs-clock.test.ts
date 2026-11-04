// inputs-clock.test.ts — the round-4 verifier's R4M-3 (plan 07 §2 `data.inputs[]`; plan 01 §4.2 the
// budget's measure, fitLengthOf: "what the fit keeps depends on the data and never on the clock").
// toDataInputs merged repeat rows on a key that held `age_s`, a floor in whole seconds of the clock:
// two reads of one source and version fetched under a second apart merged at some clock phases and
// stayed two rows at others, so the row count — and the length the budget measures — moved with the
// clock alone. The repeat is now told by the stamp's own fetch time. Pure; no clock but the inputs.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { toDataInputs, type InputStamp } from "../../src/mcp/envelope.js";

const T0 = Date.parse("2026-10-05T17:30:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

const stamp = (fetchedMs: number, over: Partial<InputStamp> = {}): InputStamp => ({
  source: "espn:mRoster",
  as_of: "2026-10-05T17:00:00.000Z",
  fetched_at: iso(fetchedMs),
  state: "fresh",
  ...over,
});

describe("R4M-3: data.inputs[] never changes with the clock alone", () => {
  it("two reads 400 ms apart are two rows at every clock phase (before: one at +1.2 s, two at +1.5 s)", () => {
    const ins = [stamp(T0), stamp(T0 + 400)];
    expect(toDataInputs(ins, T0 + 1200)).toHaveLength(2);
    expect(toDataInputs(ins, T0 + 1500)).toHaveLength(2);
  });

  it("a view read twice by one call (one fetch time) is still one row", () => {
    expect(
      toDataInputs([stamp(T0), stamp(T0), stamp(T0, { state: "expired" })], T0 + 5000),
    ).toEqual([
      { source: "espn:mRoster", as_of: "2026-10-05T17:00:00.000Z", age_s: 5, freshness: "fresh" },
      { source: "espn:mRoster", as_of: "2026-10-05T17:00:00.000Z", age_s: 5, freshness: "stale" },
    ]);
  });

  it("property: the rows' count and order are the same at every instant of a whole-second span", () => {
    const sources = ["espn:mRoster", "espn:mMatchup", "nflverse:weekly"] as const;
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            source: fc.constantFrom(...sources),
            asOfS: fc.integer({ min: 0, max: 2 }),
            // fetched under a few seconds apart, at any sub-second offset
            fetchedMs: fc.integer({ min: 0, max: 4000 }),
            fresh: fc.boolean(),
          }),
          { maxLength: 12 },
        ),
        fc.integer({ min: 5_000, max: 3_600_000 }),
        fc.array(fc.integer({ min: 0, max: 999 }), { minLength: 1, maxLength: 6 }),
        (rows, base, phases) => {
          const ins = rows.map((r) =>
            stamp(T0 + r.fetchedMs, {
              source: r.source,
              as_of: iso(T0 - 600_000 + r.asOfS * 1000),
              state: r.fresh ? "fresh" : "expired",
            }),
          );
          const shape = (now: number) =>
            toDataInputs(ins, now).map((d) => `${d.source}|${d.as_of}|${d.freshness}`);
          const first = shape(T0 + base);
          for (const p of phases) expect(shape(T0 + base + p)).toEqual(first);
        },
      ),
      { numRuns: 400 },
    );
  });
});
