// cascade.test.ts — plan 10 C6 (hard): "beneficiary-share MAE below next-man-up and the top-beneficiary
// hit rate above it on the historical absence set" (sib research 05 §6 Evaluation). The absence set is
// every 2023–2025 starter absence (RB1 by carries, WR1/WR2 and TE1 by targets; ≥ 2 consecutive team
// games missed; plan 10 B6's ≥ 10) found in the committed pbp usage excerpt
// (tests/domain/analytics/cascade-priors/data, re-hashed on every read). Leave one season out: each
// season's absences are predicted by a table built from the OTHER two seasons (its shrinkage chosen
// inside them), so no prediction has seen its own outcome. Cascade v2 runs through E7's own
// `redistribute` with no team evidence (the prior alone). It must beat next man up by usage (B6's
// rule) AND by the depth chart (sib's "naive depth-chart-next-man-up rule"), pooled over the three
// held-out seasons. The measured values are pinned so a change in either direction is seen; the
// soft numbers (per season, per position, the paired test, B6's measure) are in
// docs/evals/phase3-cascade.md.
import { describe, expect, it } from "vitest";
import {
  crossValidateCascade,
  pairedHits,
} from "../../src/domain/analytics/cascade-priors/evaluate.js";
import { loadUsageExcerpt } from "../domain/analytics/cascade-priors/helpers/excerpt.js";

const cv = crossValidateCascade(loadUsageExcerpt());
const m = cv.pooled.methods;

describe("plan 10 C6 — the historical absence set", () => {
  it("≥ 10 starter absences over three held-out seasons (145 measured: 41 RB, 71 WR, 33 TE)", () => {
    expect(cv.pooled.absences).toBeGreaterThanOrEqual(10);
    expect(cv.folds.map((f) => f.season)).toEqual([2023, 2024, 2025]);
    expect(cv.pooled.absences).toBe(145);
    expect(cv.pooled.by_position).toEqual({ RB: 41, WR: 71, TE: 33 });
    expect(cv.folds.map((f) => f.evaluation.absences)).toEqual([42, 54, 49]);
    // every fold's table was built from the other two seasons only
    expect(cv.folds.map((f) => f.train_absences)).toEqual([103, 91, 96]);
  });
});

describe("plan 10 C6 (hard) — cascade v2 against next man up, pooled over the held-out seasons", () => {
  it("beneficiary-share MAE below next man up — by usage and by the depth chart", () => {
    expect(m.v2_table.mae_beneficiary_share).toBeLessThan(
      m.next_man_up_usage.mae_beneficiary_share,
    );
    expect(m.v2_table.mae_beneficiary_share).toBeLessThan(
      m.next_man_up_depth.mae_beneficiary_share,
    );
  });
  it("top-beneficiary hit rate above next man up — by usage and by the depth chart", () => {
    expect(m.v2_table.hit_rate).toBeGreaterThan(m.next_man_up_usage.hit_rate);
    expect(m.v2_table.hit_rate).toBeGreaterThan(m.next_man_up_depth.hit_rate);
  });
  it("the measured values (pinned: a change in either direction is seen)", () => {
    expect([
      m.v2_table.hits,
      m.v1_affinity.hits,
      m.next_man_up_usage.hits,
      m.next_man_up_depth.hits,
    ]).toEqual([52, 30, 43, 42]);
    expect(m.v2_table.mae_beneficiary_share).toBeCloseTo(0.1427, 4);
    expect(m.v1_affinity.mae_beneficiary_share).toBeCloseTo(0.1455, 4);
    expect(m.next_man_up_usage.mae_beneficiary_share).toBeCloseTo(0.1718, 4);
    expect(m.next_man_up_depth.mae_beneficiary_share).toBeCloseTo(0.1693, 4);
    expect(cv.folds.map((f) => f.shrink_events)).toEqual([1000, 10, 1000]);
  });
});

describe("C6 beside it (soft, reported; asserted only where it holds by a margin)", () => {
  it("per held-out season: MAE below both next-man-up rules every season; hits never fewer", () => {
    for (const f of cv.folds) {
      const e = f.evaluation.methods;
      expect(e.v2_table.mae_beneficiary_share).toBeLessThan(
        e.next_man_up_usage.mae_beneficiary_share,
      );
      expect(e.v2_table.mae_beneficiary_share).toBeLessThan(
        e.next_man_up_depth.mae_beneficiary_share,
      );
      expect(e.v2_table.hits).toBeGreaterThanOrEqual(e.next_man_up_usage.hits);
      expect(e.v2_table.hits).toBeGreaterThanOrEqual(e.next_man_up_depth.hits);
    }
  });
  it("B6's measure (targets + carries over the team's): v2's MAE is below both rules too", () => {
    expect(m.v2_table.mae_opportunity).toBeLessThan(m.next_man_up_usage.mae_opportunity);
    expect(m.v2_table.mae_opportunity).toBeLessThan(m.next_man_up_depth.mae_opportunity);
    expect(m.v2_table.mae_opportunity).toBeCloseTo(0.0307, 4);
    expect(m.v2_table.hit_rate_opportunity).toBeCloseTo(0.2552, 4);
  });
  it("v2 improves on B6's v1 baseline; against next man up the hit gain is not yet significant", () => {
    const v1 = pairedHits(cv.pooled, "v2_table", "v1_affinity");
    expect(v1.p_value).toBeLessThan(0.01);
    const nmu = pairedHits(cv.pooled, "v2_table", "next_man_up_usage");
    expect([nmu.only_first, nmu.only_second]).toEqual([18, 9]);
    expect(nmu.p_value).toBeCloseTo(0.1221, 4); // reported honestly: 145 absences, p ≈ 0.12
  });
});
