// fit.test.ts — the premium re-solved from a league's own feed (plan 10 C5; plan 07 E5
// `premium_basis: "league_fitted"`; research 05 §1.2 sensitivities, §1.6 eval 3; ADV OBJ-03): cold
// until the feed holds a season of runs; a feed in the cold-start proportions reproduces the
// research table cell for cell; the drift wiring reproduces research 05's c sensitivity; a richer
// wire raises Π and more drift lowers it; the band brackets the premium; the DP's new `rates`
// parameter refuses a malformed distribution.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { WAIVER_DP } from "../../../../src/domain/analytics/constants.js";
import {
  RESEARCH_W_COLUMNS,
  WAIVER_FIT,
  comparePremium,
  fitDrift,
  fitLeaguePremium,
  type SurplusObservation,
} from "../../../../src/domain/analytics/waiver-fit/index.js";
import {
  isValidRateDistribution,
  solvePremiumTable,
} from "../../../../src/domain/analytics/waiverDp.js";

/** n observations in the cold-start proportions (multiples of 50). */
function coldFeed(times = 1): SurplusObservation[] {
  const counts = [15, 15, 10, 6, 3, 1];
  return WAIVER_DP.rates.flatMap((x, i) =>
    Array.from({ length: (counts[i] ?? 0) * times }, () => ({ r: x.r })),
  );
}
const scaledFeed = (k: number): SurplusObservation[] => coldFeed().map((o) => ({ r: o.r * k }));

describe("fitLeaguePremium — the basis", () => {
  it("fewer runs than a season: cold_start_table, the cold tables, the reason said", () => {
    const f = fitLeaguePremium({ teams: 10, surplus: coldFeed().slice(0, WAIVER_FIT.minRuns - 1) });
    expect(f.basis).toBe("cold_start_table");
    expect(f.base).toBe(solvePremiumTable({ teams: 10 }));
    expect(f.reasons[0]).toMatch(/fewer than the 13 a fitted premium needs/);
    expect(f.summary).toMatch(/cold-start table/);
    expect(f.demand_scale).toBe(1);
  });

  it("a feed in the cold-start proportions reproduces the cold table cell for cell (research table)", () => {
    const f = fitLeaguePremium({ teams: 10, surplus: coldFeed(2) });
    expect(f.basis).toBe("league_fitted");
    const cells = comparePremium(f);
    expect(cells).toHaveLength(10 * RESEARCH_W_COLUMNS.length);
    for (const c of cells) expect(Math.abs(c.diff)).toBeLessThan(1e-6);
    // the research table's anchors through the fitted path
    expect(Math.abs(f.base.premium(2, 13) - 29.5)).toBeLessThan(0.5);
    expect(Math.abs(f.base.premium(1, 9) - 25.0)).toBeLessThan(0.5);
    expect(f.summary).toMatch(/re-solved from the league's own feed: 100 runs/);
    expect(f.reasons.some((r) => /drift c stays the cold-start 0.25: 0 team-week/.test(r))).toBe(
      true,
    );
  });

  it("the drift parameter reproduces research 05 §1.2's c sensitivity (Π(1,9) = 26.8 / 23.2)", () => {
    const at = (c: number) =>
      fitLeaguePremium({
        teams: 10,
        surplus: coldFeed(),
        drift: { ...fitDrift([], "claims"), c, basis: "claims" },
      }).base.premium(1, 9);
    expect(Math.abs(at(0.15) - 26.8)).toBeLessThan(0.5);
    expect(Math.abs(at(0.35) - 23.2)).toBeLessThan(0.5);
  });

  it("a richer wire raises the premium almost linearly; the band brackets it", () => {
    const cold = fitLeaguePremium({ teams: 10, surplus: coldFeed(2) });
    const rich = fitLeaguePremium({ teams: 10, surplus: scaledFeed(2) });
    const poor = fitLeaguePremium({ teams: 10, surplus: scaledFeed(0.5) });
    for (const k of [1, 3, 5, 9])
      for (const W of [3, 9, 15]) {
        expect(rich.base.premium(k, W)).toBeGreaterThan(cold.base.premium(k, W));
        expect(poor.base.premium(k, W)).toBeLessThan(cold.base.premium(k, W));
        expect(rich.low.premium(k, W)).toBeLessThanOrEqual(rich.base.premium(k, W));
        expect(rich.high.premium(k, W)).toBeGreaterThanOrEqual(rich.base.premium(k, W));
      }
    const ratio = rich.base.premium(1, 9) / cold.base.premium(1, 9);
    expect(ratio).toBeGreaterThan(1.4);
    expect(ratio).toBeLessThan(2.6);
    expect(comparePremium(rich, { ks: [1], Ws: [9] })[0]?.ratio).toBeCloseTo(
      rich.base.premium(1, 9) / cold.base.premium(1, 9),
      2,
    );
  });

  it("the caveats: clamped and rejected runs, the acquisition bound kept or cut, a demand scale", () => {
    const feed = [...coldFeed(), { r: 50 }, { r: Number.NaN }];
    const kept = fitLeaguePremium({
      teams: 10,
      surplus: feed,
      drift: fitDrift(
        Array.from({ length: 50 }, (_, i) => ({ team_id: i, week: 1, count: i < 30 ? 1 : 0 })),
        "acquisitions",
      ),
      demand_scale: 0.5,
    });
    expect(kept.reasons.join(" | ")).toMatch(/1 unusable surplus observation/);
    expect(kept.reasons.join(" | ")).toMatch(/1 run\(s\) above 20 points per week/);
    expect(kept.reasons.join(" | ")).toMatch(/only bounds it from above/);
    expect(kept.demand_scale).toBe(0.5);
    expect(kept.summary).toMatch(/demand ×0.5/);
    const cut = fitLeaguePremium({
      teams: 10,
      surplus: coldFeed(),
      drift: fitDrift(
        Array.from({ length: 50 }, (_, i) => ({ team_id: i, week: 1, count: i < 5 ? 1 : 0 })),
        "acquisitions",
      ),
    });
    expect(cut.drift.c).toBe(0.1);
    expect(cut.reasons.join(" | ")).toMatch(/cut to the acquisition share 0.1/);
    // a bad demand scale or min_runs falls back
    for (const demand_scale of [Number.NaN, 0, 99, null])
      expect(fitLeaguePremium({ teams: 10, surplus: coldFeed(), demand_scale }).demand_scale).toBe(
        1,
      );
    expect(
      fitLeaguePremium({ teams: 10, surplus: coldFeed().slice(0, 2), min_runs: 2 }).basis,
    ).toBe("league_fitted");
    expect(fitLeaguePremium({ teams: 10, surplus: [], min_runs: Number.NaN }).basis).toBe(
      "cold_start_table",
    );
  });

  it("refuses a league size the DP does not accept", () => {
    expect(() => fitLeaguePremium({ teams: 1, surplus: coldFeed() })).toThrow(RangeError);
    expect(() => fitLeaguePremium({ teams: 21, surplus: [] })).toThrow(RangeError);
  });

  it("property: the band is the fitted DP at ×0.5 / ×1.5 surplus — exactly half and one and a half Π (the DP is homogeneous in the surplus when demand reads the base rate)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 18, noNaN: true }), { minLength: 13, maxLength: 40 }),
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 0, max: 17 }),
        (rs, k, W) => {
          const f = fitLeaguePremium({ teams: 10, surplus: rs.map((r) => ({ r })) });
          const base = f.base.premium(k, W);
          expect(Math.abs(f.low.premium(k, W) - 0.5 * base)).toBeLessThan(1e-6);
          expect(Math.abs(f.high.premium(k, W) - 1.5 * base)).toBeLessThan(1e-6);
          expect(base).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("a richer wire is not always a higher premium: rivals want richer players too (q reads the rate)", () => {
    // recorded, not hidden: demand rises with r, so P_k(s) falls and the option can be worth less
    // at the bottom of the order; at the top it rises (the cells checked above)
    const rich = fitLeaguePremium({ teams: 10, surplus: scaledFeed(3) });
    const cold = fitLeaguePremium({ teams: 10, surplus: coldFeed(2) });
    expect(rich.base.premium(1, 9)).toBeGreaterThan(cold.base.premium(1, 9));
    expect(rich.base.premium(10, 1)).toBeLessThan(cold.base.premium(10, 1));
  });
});

describe("solvePremiumTable — the rates parameter (additive)", () => {
  it("accepts a valid distribution and caches by it", () => {
    const rates = [
      { r: 0, p: 0.5 },
      { r: 3, p: 0.5 },
    ];
    expect(isValidRateDistribution(rates)).toBe(true);
    const t = solvePremiumTable({ teams: 10, rates });
    expect(solvePremiumTable({ teams: 10, rates: [...rates] })).toBe(t);
    expect(t.premium(1, 9)).toBeGreaterThan(0);
  });

  it("refuses malformed distributions", () => {
    const bad: unknown[] = [
      [],
      [{ r: 1, p: 0.5 }],
      [{ r: -1, p: 1 }],
      [{ r: Number.NaN, p: 1 }],
      [{ r: 1, p: Number.POSITIVE_INFINITY }],
      [
        { r: 1, p: -0.5 },
        { r: 2, p: 1.5 },
      ],
      [null],
      [{ r: "1", p: 1 }],
      Array.from({ length: 65 }, () => ({ r: 1, p: 1 / 65 })),
      "not an array",
    ];
    for (const rates of bad) {
      expect(isValidRateDistribution(rates as never)).toBe(false);
      expect(() => solvePremiumTable({ teams: 10, rates: rates as never })).toThrow(RangeError);
    }
  });

  it("the cache stays bounded however many fitted distributions are solved", () => {
    for (let i = 0; i < 80; i++)
      solvePremiumTable({
        teams: 10,
        rates: [
          { r: 0, p: 0.5 },
          { r: 1 + i / 10, p: 0.5 },
        ],
      });
    // the default table is re-solved on demand (evicted or not) with the same values
    expect(Math.abs(solvePremiumTable({ teams: 10 }).premium(2, 13) - 29.5)).toBeLessThan(0.5);
  });
});
