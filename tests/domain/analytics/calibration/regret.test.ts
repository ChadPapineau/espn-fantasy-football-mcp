// regret.test.ts — the start/sit replay's summaries (plan 10 C2; sib research 05 §12.3): regret =
// hindsight − realised; comparisons per season and pooled over the team-weeks where both rules
// exist, from a week on; "beats in every season" and "no worse"; the "did it matter" share with ties,
// flips to a win and to a loss; hostile options.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  beatsInEverySeason,
  compareRegret,
  didItMatter,
  noWorseInEverySeason,
  regretOf,
} from "../../../../src/domain/analytics/calibration/index.js";
import { AnalyticsError } from "../../../../src/domain/analytics/errors.js";
import { row } from "./helpers/roster.js";

const h2h = (opponent_total: number) => ({
  outcome_played: null,
  p_win_played: 0.5,
  p_win_auto: 0.5,
  outcome_auto: null,
  opponent_total,
});

describe("regretOf / compareRegret", () => {
  it("regret is hindsight − realised; null when either is missing", () => {
    const r = row(2024, 2, { hindsight: 120.5, auto: 100.25, last_week: 80 });
    expect(regretOf(r, "auto")).toBe(20.25);
    expect(regretOf(r, "last_week")).toBe(40.5);
    expect(regretOf(r, "pwin")).toBeNull();
    expect(regretOf(row(2024, 2, { auto: 3 }), "auto")).toBeNull();
  });

  it("compares per season (ascending) and pooled, counting only the weeks where both rules exist", () => {
    const rows = [
      row(2025, 1, { hindsight: 100, auto: 90 }),
      row(2025, 2, { hindsight: 100, auto: 90, last_week: 70 }),
      row(2024, 2, { hindsight: 100, auto: 95, last_week: 85 }),
      row(2024, 3, { hindsight: 100, auto: 97, last_week: 99 }),
    ];
    const c = compareRegret(rows, "auto", "last_week");
    expect(c.by_season.map((s) => s.season)).toEqual([2024, 2025]);
    expect(c.by_season[0]).toMatchObject({ n: 2, mean_a: 4, mean_b: 8, diff: -4, identical: 0 });
    expect(c.by_season[1]).toMatchObject({ n: 1, mean_a: 10, mean_b: 30, diff: -20 });
    expect(c.pooled).toMatchObject({ season: null, n: 3 });
    expect(beatsInEverySeason(c)).toBe(true);
    expect(noWorseInEverySeason(c)).toBe(true);
    const late = compareRegret(rows, "auto", "last_week", { from_week: 3 });
    expect(late.from_week).toBe(3);
    expect(late.by_season.map((s) => [s.season, s.n])).toEqual([[2024, 1]]);
  });

  it("identical lineups count; equal regret is no worse but never beats", () => {
    const rows = [
      row(
        2024,
        1,
        { hindsight: 100, auto: 90, espn_projection: 90 },
        {
          lineup_key: { ...row(2024, 1, {}).lineup_key, auto: "1,2", espn_projection: "1,2" },
        },
      ),
    ];
    const c = compareRegret(rows, "auto", "espn_projection");
    expect(c.pooled.identical).toBe(1);
    expect(c.pooled.diff).toBe(0);
    expect(beatsInEverySeason(c)).toBe(false);
    expect(noWorseInEverySeason(c)).toBe(true);
  });

  it("an empty replay beats nothing and is not 'no worse'", () => {
    const c = compareRegret([], "auto", "mean");
    expect(c.by_season).toEqual([]);
    expect(c.pooled).toMatchObject({ n: 0, mean_a: null, mean_b: null, diff: null });
    expect(beatsInEverySeason(c)).toBe(false);
    expect(noWorseInEverySeason(c)).toBe(false);
  });

  it("refuses an out-of-range from_week", () => {
    for (const w of [0, 26, 1.5, Number.NaN])
      expect(() => compareRegret([], "auto", "mean", { from_week: w })).toThrow(AnalyticsError);
  });

  it("(property) diff = mean_a − mean_b and regrets are averaged over the shared weeks", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            season: fc.constantFrom(2024, 2025),
            week: fc.integer({ min: 1, max: 17 }),
            a: fc.integer({ min: 0, max: 200 }),
            b: fc.integer({ min: 0, max: 200 }),
          }),
          { minLength: 1, maxLength: 60 },
        ),
        (xs) => {
          const rows = xs.map((x) =>
            row(x.season, x.week, { hindsight: 400, auto: x.a, mean: x.b }),
          );
          const c = compareRegret(rows, "auto", "mean");
          expect(c.pooled.n).toBe(xs.length);
          expect(c.pooled.diff ?? 0).toBeCloseTo(
            (c.pooled.mean_a ?? 0) - (c.pooled.mean_b ?? 0),
            3,
          );
          expect(c.by_season.reduce((s, x) => s + x.n, 0)).toBe(xs.length);
        },
      ),
    );
  });
});

describe("didItMatter", () => {
  it("counts changed lineups, flips to a win and to a loss, and ties as flips", () => {
    const rows = [
      // same lineup: not changed
      row(
        2024,
        1,
        { auto: 100, manager: 100 },
        {
          h2h: h2h(90),
          lineup_key: { ...row(2024, 1, {}).lineup_key, auto: "x", manager: "x" },
        },
      ),
      // changed, both win: not decisive
      row(2024, 2, { auto: 110, manager: 100 }, { h2h: h2h(90) }),
      // changed, auto wins where the manager lost: helped
      row(2024, 3, { auto: 110, manager: 80 }, { h2h: h2h(90) }),
      // changed, auto loses where the manager won: hurt
      row(2024, 4, { auto: 85, manager: 95 }, { h2h: h2h(90) }),
      // changed, auto ties where the manager lost: helped (a tie is a flip)
      row(2024, 5, { auto: 90, manager: 80 }, { h2h: h2h(90) }),
      // no h2h: not counted
      row(2024, 6, { auto: 1, manager: 2 }),
      // missing rule: not counted
      row(2024, 7, { auto: 1 }, { h2h: h2h(90) }),
    ];
    const d = didItMatter(rows, "auto", "manager");
    expect(d).toMatchObject({
      rule: "auto",
      reference: "manager",
      n_h2h: 5,
      n_changed: 4,
      n_decisive: 3,
      n_helped: 2,
      n_hurt: 1,
      share_of_changed: 0.75,
      share_of_all: 0.6,
    });
  });

  it("nothing changed → null shares", () => {
    expect(didItMatter([], "pwin", "mean")).toMatchObject({
      n_h2h: 0,
      share_of_changed: null,
      share_of_all: null,
    });
  });
});
