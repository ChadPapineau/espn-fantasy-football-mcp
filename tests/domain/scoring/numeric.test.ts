// numeric.test.ts — src/domain/scoring/{numeric,errors,rounding}.ts (plan 08 §4.6 float hygiene, A-3,
// E4 rounding rule, P9; §3.1 "fail loudly" errors). Adversarial: halves, powers of ten, −0, huge.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ScoringError } from "../../../src/domain/scoring/errors.js";
import {
  at,
  denoise,
  denoiseReference,
  finiteWithin,
  round2,
  stableSum,
} from "../../../src/domain/scoring/numeric.js";
import {
  applyRounding,
  ESPN_APPLIED_TOTAL_DECIMALS,
  ESPN_ROUNDING,
  roundingCandidates,
} from "../../../src/domain/scoring/rounding.js";

/** The first x whose x·1e14 lands exactly on a half (the fast path's undecidable case). */
function halfCase(): number {
  for (let m = 123456789012345; m < 123456789012345 + 10_000; m += 1) {
    const x = (m + 0.5) / 1e14;
    if (x * 1e14 === m + 0.5) return x;
  }
  throw new Error("no half case found");
}

describe("denoise", () => {
  it("removes binary-float noise and maps −0 to 0", () => {
    expect(denoise(0.04 * 312)).toBe(12.48);
    expect(denoise(12 * 0.1)).toBe(1.2);
    expect(Object.is(denoise(-0), 0)).toBe(true);
    expect(denoise(0)).toBe(0);
    expect(denoise(-7.578000179)).toBe(-7.578000179);
  });
  it.each([
    ["≥ 1e15", 1e16],
    ["< 1e-8", 1e-9],
    ["non-finite", Number.POSITIVE_INFINITY],
    ["mantissa rounds to 1e15", 0.9999999999999999],
    ["exactly 1e14 mantissa", 1e-8],
  ])("takes the reference path for %s", (_label, x) => {
    expect(Object.is(denoise(x), denoiseReference(x))).toBe(true);
  });
  it("takes the reference path when the scaled value sits exactly on a half", () => {
    const x = halfCase();
    expect(denoise(x)).toBe(denoiseReference(x));
    expect(denoise(-x)).toBe(denoiseReference(-x));
  });
  it("property: equals Number(x.toPrecision(15)) for every finite double", () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), (x) =>
        Object.is(denoise(x), x === 0 ? 0 : denoiseReference(x)),
      ),
      { numRuns: 5000 },
    );
  });
});

describe("stableSum", () => {
  it("is order-robust where a naive sum drifts", () => {
    expect(stableSum([1e16, 1, -1e16])).toBe(1);
    expect(stableSum([1, 1e16, -1e16])).toBe(1);
    expect(stableSum([])).toBe(0);
  });
  it("property: matches the exact sum of small integers in any order", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -1e6, max: 1e6 })), (xs) => {
        const exact = xs.reduce((a, b) => a + b, 0);
        return stableSum(xs) === exact && stableSum([...xs].reverse()) === exact;
      }),
    );
  });
});

describe("round2 (half away from zero, on the denoised value)", () => {
  it.each([
    [1.005, 1.01],
    [-0.125, -0.13],
    [0.125, 0.13],
    [2.675, 2.68],
    [-0.001, 0],
    [100.8, 100.8],
    [0, 0],
  ])("round2(%s) = %s", (x, y) => {
    expect(round2(x)).toBe(y);
  });
  it("never returns −0", () => {
    expect(Object.is(round2(-0.004), 0)).toBe(true);
  });
});

describe("finiteWithin / at", () => {
  it.each([
    [5, true],
    [-1e6, true],
    [1e6 + 1, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    ["5", false],
    [null, false],
  ])("finiteWithin(%s, 1e6) = %s", (x, ok) => {
    expect(finiteWithin(x, 1e6)).toBe(ok);
  });
  it("at returns the element or throws RangeError", () => {
    expect(at([1, 2, 3], 2)).toBe(3);
    for (const i of [-1, 3, 1.5, Number.NaN]) expect(() => at([1, 2, 3], i)).toThrow(RangeError);
  });
});

describe("ScoringError", () => {
  it("keeps at most 10 details of at most 80 chars, and names them in the message", () => {
    const e = new ScoringError(
      "invalid_settings",
      "bad",
      Array.from({ length: 12 }, (_, i) => `${"x".repeat(100)}${String(i)}`),
    );
    expect(e.detail).toHaveLength(10);
    expect(e.detail.every((d) => d.length === 80)).toBe(true);
    expect(e.message.startsWith("bad: ")).toBe(true);
    expect(e.name).toBe("ScoringError");
    expect(e.code).toBe("invalid_settings");
    expect(Object.isFrozen(e.detail)).toBe(true);
  });
  it("has a bare message without details", () => {
    expect(new ScoringError("drift", "plain").message).toBe("plain");
  });
});

describe("rounding (E4 — ESPN's rule pinned by the golden)", () => {
  it("ESPN's rule is exact and verified; appliedTotal is stored to 8 dp", () => {
    expect(ESPN_ROUNDING).toEqual({ mode: "exact", verified: true });
    expect(ESPN_APPLIED_TOTAL_DECIMALS).toBe(8);
  });
  it("roundingCandidates computes the three plan 08 §4.6 candidates", () => {
    expect(roundingCandidates([1.004, 1.004, 1.004])).toEqual({
      exact: 3.012,
      per_stat_2dp: 3,
      per_total_2dp: 3.01,
    });
  });
  it("applyRounding applies a mode only once verified (P9)", () => {
    const per = [1.004, 1.004, 1.004];
    expect(applyRounding(3.012, per, { mode: "per_total_2dp", verified: false })).toBe(3.012);
    expect(applyRounding(3.012, per, { mode: "exact", verified: true })).toBe(3.012);
    expect(applyRounding(3.012, per, { mode: "per_total_2dp", verified: true })).toBe(3.01);
    expect(applyRounding(3.012, per, { mode: "per_stat_2dp", verified: true })).toBe(3);
  });
  it("property: a verified mode stays within 0.01 × stats of exact and the total modes are idempotent", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -100, max: 100, noNaN: true }), { maxLength: 30 }),
        (per) => {
          const exact = denoise(stableSum(per));
          for (const mode of ["exact", "per_stat_2dp", "per_total_2dp"] as const) {
            const p = applyRounding(exact, per, { mode, verified: true });
            if (Math.abs(p - exact) > 0.01 * Math.max(1, per.length) + 1e-9) return false;
          }
          const t = applyRounding(exact, per, { mode: "per_total_2dp", verified: true });
          return applyRounding(t, [t], { mode: "per_total_2dp", verified: true }) === t;
        },
      ),
    );
  });
});
