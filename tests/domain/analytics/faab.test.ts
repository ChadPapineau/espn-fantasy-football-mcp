// faab.test.ts — FAAB bid sizing (plan 07 E5 `mode: faab`; sib research 05 §4.3): the price of a
// point shrinks the league's winning bids toward the cold start; P(win | b) is a non-decreasing
// curve that a rival's budget caps; λ is 0 once no week remains and rises as my budget shrinks
// against the league's; b* maximises P(win) × (value − λ·b) and is 0 when nothing is worth a bid.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  faabBid,
  lambdaOf,
  pricePerPoint,
  pWinAt,
  type FaabInput,
} from "../../../src/domain/analytics/faab.js";
import { FAAB } from "../../../src/domain/analytics/marketConstants.js";

const price = { value: 0.6, n: 10 };
const rivals = [
  { team_id: 2, q: 0.6, value: 30, budget_remaining: 80 },
  { team_id: 3, q: 0.4, value: 20, budget_remaining: null },
  { team_id: 4, q: 0.2, value: 25, budget_remaining: 5 },
];
const base: FaabInput = { value: 30, my_budget: 100, min_bid: 0, price, rivals, lambda: 0.5 };

describe("pricePerPoint", () => {
  it("cold start = budget / coldPointsPerBudget with no history; shrinks the slope toward it", () => {
    expect(pricePerPoint([], 100)).toEqual({ value: 0.6667, n: 0 });
    const hist = Array.from({ length: 5 }, () => ({ bid: 20, value: 10 }));
    const p = pricePerPoint(hist, 100);
    expect(p.n).toBe(5);
    expect(p.value).toBeCloseTo(
      (5 * 2 + FAAB.priceShrinkBids * (100 / 150)) / (5 + FAAB.priceShrinkBids),
      3,
    );
  });
  it("ignores non-positive values, negative bids and non-finite rows", () => {
    const p = pricePerPoint(
      [
        { bid: 10, value: 0 },
        { bid: -1, value: 5 },
        { bid: Number.NaN, value: 5 },
      ],
      150,
    );
    expect(p).toEqual({ value: 1, n: 0 });
  });
});

describe("pWinAt", () => {
  it("non-decreasing in the bid; 1 with no rivals; past a rival's budget he cannot outbid", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 99 }), (b) => {
        expect(pWinAt(b + 1, base)).toBeGreaterThanOrEqual(pWinAt(b, base) - 1e-12);
      }),
      { numRuns: 100 },
    );
    expect(pWinAt(0, { price, rivals: [] })).toBe(1);
    const capped = { price, rivals: [{ team_id: 2, q: 1, value: 100, budget_remaining: 10 }] };
    expect(pWinAt(10, capped)).toBe(1);
    expect(pWinAt(9, capped)).toBeLessThan(1);
  });
  it("a rival with q = 0 or no value never bids", () => {
    expect(
      pWinAt(0, { price, rivals: [{ team_id: 2, q: 0, value: 50, budget_remaining: null }] }),
    ).toBe(1);
    expect(
      pWinAt(0, { price, rivals: [{ team_id: 2, q: 1, value: 0, budget_remaining: null }] }),
    ).toBe(1);
  });
});

describe("lambdaOf", () => {
  const args = {
    price,
    weeks_remaining: 8,
    weeks_season: 17,
    my_budget: 50,
    rival_budgets: [50, 50],
    reserve: "none" as const,
  };
  it("0 after the last run (no weeks) or with no price", () => {
    expect(lambdaOf({ ...args, weeks_remaining: 0 })).toBe(0);
    expect(lambdaOf({ ...args, price: { value: 0, n: 0 } })).toBe(0);
  });
  it("rises as my budget shrinks against the league's, and with a playoff reserve", () => {
    const even = lambdaOf(args);
    expect(even).toBeCloseTo((1 / 0.6) * (8 / 17), 5);
    expect(lambdaOf({ ...args, my_budget: 20 })).toBeGreaterThan(even);
    expect(lambdaOf({ ...args, reserve: "playoff_reserve" })).toBeCloseTo(
      even * FAAB.reserveFactor,
      5,
    );
    expect(lambdaOf({ ...args, my_budget: 0 })).toBeCloseTo(
      (1 / 0.6) * (8 / 17) * FAAB.scarcityMax,
      5,
    );
    expect(lambdaOf({ ...args, rival_budgets: [null, null] })).toBeCloseTo(even, 6);
  });
});

describe("faabBid", () => {
  it("b* maximises the expected net over the grid; the curve rises", () => {
    const b = faabBid(base);
    expect(b.b_star).toBeGreaterThan(0);
    expect(b.b_star).toBeLessThanOrEqual(100);
    for (let x = 0; x <= 100; x++) {
      const net = pWinAt(x, base) * (base.value - base.lambda * x);
      expect(net).toBeLessThanOrEqual(b.expected_net + 1e-3);
    }
    const ps = b.curve.map((c) => c.p_win);
    expect([...ps].sort((a, z) => a - z)).toEqual(ps);
    expect(b.curve.some((c) => c.bid === b.b_star)).toBe(true);
  });
  it("λ = 0 (the last run): bid to the top of what can still raise P(win)", () => {
    const b = faabBid({ ...base, lambda: 0 });
    expect(b.p_win).toBeGreaterThanOrEqual(faabBid(base).p_win);
  });
  it("nothing worth a bid → b* = 0, expected net 0", () => {
    expect(faabBid({ ...base, value: 0 })).toMatchObject({ b_star: 0, expected_net: 0 });
    expect(faabBid({ ...base, value: 1, lambda: 10 })).toMatchObject({ b_star: 0 });
  });
  it("min bid and a large budget thin the grid without leaving it", () => {
    const b = faabBid({ ...base, my_budget: 5000, min_bid: 3, rivals: [] });
    expect(b.b_star).toBe(3);
    expect(b.p_win).toBe(1);
  });
});
