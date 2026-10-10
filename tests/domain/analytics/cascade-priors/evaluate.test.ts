// evaluate.test.ts — plan 10 C6's measurement (sib research 05 §6 Evaluation): the beneficiary
// share (a teammate's change in the starter's opportunity mix over the starter's share), the
// opportunity share beside it, each method's prediction (cascade v2 through E7's own redistribute,
// v1, next man up by usage and by the depth chart — every vacated share to one player), the MAEs and
// the top-beneficiary hit rate hand-computed on a small absence, pooling across folds, the exact
// McNemar test, and leave-one-season-out on synthetic seasons (each fold's table never sees its
// season).
import { describe, expect, it } from "vitest";
import { redistribute } from "../../../../src/domain/analytics/cascade.js";
import {
  EVAL_RECEPTION_POINTS,
  beneficiaryShare,
  cascadeMateOf,
  crossValidateCascade,
  evaluateCascade,
  opportunityMix,
  pairedHits,
  poolEvaluations,
  predictedOpportunity,
  predictions,
  realisedOpportunity,
} from "../../../../src/domain/analytics/cascade-priors/evaluate.js";
import type {
  CascadeEvaluation,
  CascadeMethod,
} from "../../../../src/domain/analytics/cascade-priors/types.js";
import { CASCADE_METHODS } from "../../../../src/domain/analytics/cascade-priors/types.js";
import { cell, eventOf, mateOf, tableOf, teamSeason, type Cell } from "./helpers/synth.js";

const A = mateOf("a", "WR", "WR1", [0.2, 0, 0], [0.3, 0, 0], { depth: 2 });
const B = mateOf("b", "WR", "WR2", [0.1, 0, 0], [0.12, 0, 0], { depth: 1 });
const C = mateOf("c", "RB", "RB1", [0.05, 0.6, 0], [0.05, 0.7, 0]);
const E = eventOf({ vacated: [0.2, 0, 0], teammates: [A, B, C] });
const T = tableOf(cell({ WR1: 0.5, WR2: 0.25 }));

describe("the measures", () => {
  it("the starter's opportunity mix and the beneficiary share", () => {
    expect(opportunityMix(E)).toEqual({ targets: 1, carries: 0 });
    expect(beneficiaryShare(E, { targets: 0.1, carries: 0.5 })).toBeCloseTo(0.5, 12);
    const rb = eventOf({ position: "RB", vacated: [0.1, 0.6, 0] });
    const mix = opportunityMix(rb); // 3 targets, 15 carries a game
    expect(mix.targets).toBeCloseTo(3 / 18, 12);
    expect(beneficiaryShare(rb, { targets: 0.1, carries: 0.6 })).toBeCloseTo(1, 12);
    const none = eventOf({ vacated: [0, 0, 0.3] });
    expect(opportunityMix(none)).toEqual({ targets: 0, carries: 0 });
    expect(beneficiaryShare(none, { targets: 0.1, carries: 0.1 })).toBe(0);
  });
  it("opportunity shares: realised over the post volume, predicted at the volume before", () => {
    expect(realisedOpportunity(E, A)).toBeCloseTo(3 / 55, 12);
    expect(realisedOpportunity(E, C)).toBeCloseTo(2.5 / 55, 12);
    expect(predictedOpportunity(E, { targets: 0.1, carries: 0.1, rz: 0 })).toBeCloseTo(
      5.5 / 55,
      12,
    );
    const dead = eventOf({
      team_pre: { targets: 0, carries: 0, rz: 0 },
      team_post: { targets: 0, carries: 0, rz: 0 },
    });
    expect(realisedOpportunity(dead, A)).toBe(0);
    expect(predictedOpportunity(dead, { targets: 1, carries: 1, rz: 0 })).toBe(0);
  });
  it("an absence teammate as E7 sees him (pre shares, no status, his depth)", () => {
    const m = cascadeMateOf(A);
    expect(m.usage).toEqual({ target_share: 0.2, carry_share: 0, rz_share: 0, snap_pct: null });
    expect(m.depth_rank).toBe(2);
    expect(m.injury_status).toBeNull();
    expect(m.player_id).toBeNull();
  });
});

describe("predictions and C6 on one absence", () => {
  const p = predictions(E, T);
  it("next man up gives every vacated share to one player: by usage A, by the chart B", () => {
    expect(p.next_man_up_usage).toEqual([
      { targets: 0.2, carries: 0, rz: 0 },
      { targets: 0, carries: 0, rz: 0 },
      { targets: 0, carries: 0, rz: 0 },
    ]);
    expect(p.next_man_up_depth[1]).toEqual({ targets: 0.2, carries: 0, rz: 0 });
  });
  it("v2 is E7's own redistribute with the table; v1 without it", () => {
    const mates = E.teammates.map(cascadeMateOf);
    const inj = { position: "WR", usage: { target_share: 0.2, carry_share: 0, rz_share: 0 } };
    expect(p.v2_table).toEqual(
      redistribute(inj, mates, 0, EVAL_RECEPTION_POINTS, {
        priors: T,
        team_volume: E.team_pre,
      }).allocs.map((a) => a.delta),
    );
    expect(p.v1_affinity).toEqual(
      redistribute(inj, mates, 0, EVAL_RECEPTION_POINTS).allocs.map((a) => a.delta),
    );
    expect(p.v2_table[0]?.targets).toBeCloseTo(0.1, 12);
    expect(p.v2_table[1]?.targets).toBeCloseTo(0.05, 12);
  });
  it("hand-computed MAEs and hits (realised beneficiary shares 0.5, 0.1, 0)", () => {
    const ev = evaluateCascade([E, eventOf({ teammates: [] })], T);
    expect(ev.absences).toBe(1); // the empty one is skipped
    expect(ev.teammate_rows).toBe(3);
    expect(ev.by_position).toEqual({ RB: 0, WR: 1, TE: 0 });
    expect(ev.methods.v2_table.mae_beneficiary_share).toBeCloseTo(0.05, 4);
    expect(ev.methods.v2_table.hits).toBe(1);
    expect(ev.methods.v2_table.mae_targets).toBeCloseTo(0.01, 4);
    expect(ev.methods.v2_table.mae_carries).toBeCloseTo(0.1 / 3, 4);
    expect(ev.methods.next_man_up_usage.mae_beneficiary_share).toBeCloseTo(0.2, 4);
    expect(ev.methods.next_man_up_usage.hit_rate).toBe(1);
    expect(ev.methods.next_man_up_depth.mae_beneficiary_share).toBeCloseTo(1.4 / 3, 4);
    expect(ev.methods.next_man_up_depth.hits).toBe(0);
    expect(ev.methods.v2_table.hit_rate_opportunity).toBe(1);
    expect(ev.event_hits).toEqual([
      {
        v2_table: true,
        v1_affinity: ev.event_hits[0]?.v1_affinity,
        next_man_up_usage: true,
        next_man_up_depth: false,
      },
    ]);
  });
  it("a method that predicts no gain misses; an empty set scores zeros", () => {
    const lone = eventOf({ position: "TE", vacated: [0.2, 0, 0], teammates: [A] });
    const ev = evaluateCascade([lone], tableOf(cell({})));
    expect(ev.methods.next_man_up_usage.hits).toBe(0); // no tight end to inherit
    expect(ev.methods.v2_table.hits).toBe(0); // an empty cell predicts nothing
    const empty = evaluateCascade([], T);
    expect(empty.absences).toBe(0);
    for (const m of CASCADE_METHODS) expect(empty.methods[m].mae_beneficiary_share).toBe(0);
  });
});

const evalOf = (
  absences: number,
  rows: number,
  mae: number,
  hits: number,
  hitList: boolean[] = [],
): CascadeEvaluation => {
  const score = {
    mae_beneficiary_share: mae,
    hit_rate: absences === 0 ? 0 : hits / absences,
    hits,
    mae_opportunity: mae / 10,
    hit_rate_opportunity: absences === 0 ? 0 : hits / absences,
    mae_targets: mae,
    mae_carries: mae,
    mae_rz: mae,
  };
  return {
    absences,
    teammate_rows: rows,
    by_position: { RB: absences, WR: 0, TE: 0 },
    methods: Object.fromEntries(CASCADE_METHODS.map((m) => [m, score])) as Record<
      CascadeMethod,
      typeof score
    >,
    event_hits: hitList.map(
      (h) =>
        Object.fromEntries(CASCADE_METHODS.map((m) => [m, h])) as Record<CascadeMethod, boolean>,
    ),
  };
};

describe("pooling and the paired test", () => {
  it("pools MAEs by teammate rows and hits by count", () => {
    const p = poolEvaluations([
      evalOf(2, 10, 0.1, 1, [true, false]),
      evalOf(3, 30, 0.2, 3, [true, true, true]),
    ]);
    expect(p.absences).toBe(5);
    expect(p.teammate_rows).toBe(40);
    expect(p.methods.v2_table.mae_beneficiary_share).toBeCloseTo(0.175, 4);
    expect(p.methods.v2_table.hits).toBe(4);
    expect(p.methods.v2_table.hit_rate).toBeCloseTo(0.8, 4);
    expect(p.methods.v2_table.hit_rate_opportunity).toBeCloseTo(0.8, 4);
    expect(p.by_position.RB).toBe(5);
    expect(p.event_hits).toHaveLength(5);
    expect(poolEvaluations([]).methods.v2_table.mae_beneficiary_share).toBe(0);
  });
  it("exact McNemar: discordant counts and the two-sided p", () => {
    const mk = (first: number, second: number, both: number): CascadeEvaluation => ({
      ...evalOf(0, 0, 0, 0),
      event_hits: [
        ...Array.from({ length: first }, () => ({ v2_table: true, next_man_up_usage: false })),
        ...Array.from({ length: second }, () => ({ v2_table: false, next_man_up_usage: true })),
        ...Array.from({ length: both }, () => ({ v2_table: true, next_man_up_usage: true })),
      ].map((h) => ({ v1_affinity: false, next_man_up_depth: false, ...h })),
    });
    expect(pairedHits(mk(18, 9, 25), "v2_table", "next_man_up_usage")).toEqual({
      only_first: 18,
      only_second: 9,
      p_value: 0.1221,
    });
    expect(pairedHits(mk(5, 0, 0), "v2_table", "next_man_up_usage").p_value).toBeCloseTo(0.0625, 4);
    expect(pairedHits(mk(0, 0, 4), "v2_table", "next_man_up_usage").p_value).toBe(1);
    expect(pairedHits(mk(3, 3, 0), "v2_table", "next_man_up_usage").p_value).toBe(1);
  });
});

describe("crossValidateCascade — leave one season out", () => {
  const base = (): Record<string, Cell> => ({
    a: ["RB", 3, 15, 0, 3, 1],
    b: ["RB", 2, 4, 0, 1, 2],
    c: ["WR", 8, 0, 2, 0, 1],
    d: ["WR", 6, 0, 1, 0, 1],
    f: ["TE", 5, 0, 1, 0, 1],
  });
  const season = (s: number, gain: number) => {
    const m = base();
    delete m.a;
    m.b = ["RB", 2, 4 + gain, 0, 1, 1];
    return teamSeason(s, "T1", { 1: base(), 2: base(), 3: m, 4: m });
  };
  it("one fold per season; each fold's table is built without it; pooled = the folds", () => {
    const cv = crossValidateCascade([...season(2023, 10), ...season(2024, 12), ...season(2025, 8)]);
    expect(cv.folds.map((f) => f.season)).toEqual([2023, 2024, 2025]);
    for (const f of cv.folds) {
      expect(f.train_absences).toBe(2);
      expect(f.evaluation.absences).toBe(1);
      expect(f.shrink_events).toBeGreaterThanOrEqual(0);
    }
    expect(cv.pooled.absences).toBe(3);
    // the successor (b) takes the carries: every fold names him, as next man up does
    expect(cv.pooled.methods.v2_table.hits).toBe(3);
    expect(cv.pooled.methods.next_man_up_usage.hits).toBe(3);
    expect(cv.pooled.methods.v2_table.mae_beneficiary_share).toBeLessThan(
      cv.pooled.methods.next_man_up_usage.mae_beneficiary_share,
    );
  });
  it("no rows, no folds", () => {
    const cv = crossValidateCascade([]);
    expect(cv.folds).toEqual([]);
    expect(cv.pooled.absences).toBe(0);
  });
});
