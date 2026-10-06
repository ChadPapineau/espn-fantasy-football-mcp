// player-sim.test.ts — E1's `player_sim` hook (plan 07 E1; sib research 05 §1 step 9): it exists
// only where the opportunity inputs exist (RB/WR/TE with ≥ 3 games of targets or carries); the mean
// is ESPN's (weight_espn = 1.0, ADV OBJ-02) and the simulation only shapes the distribution, scored
// under the league's S — so a full-PPR league widens a receiver's spread in points; the zero mass
// follows P(active) with E1's floor; seeded and deterministic.
import { describe, expect, it } from "vitest";
import {
  hasOpportunityInputs,
  playerSimDist,
  type OpportunityInputs,
} from "../../../src/domain/analytics/playerSim.js";
import { P_ACTIVE_SHAPE_FLOOR } from "../../../src/domain/analytics/constants.js";
import { normalizeSettings } from "../../../src/domain/scoring/settings.js";
import { seededRng } from "../../../src/domain/clock.js";
import { REFERENCE_SCORING_SETTINGS } from "../scoring/helpers.js";
import { referenceSettings } from "./helpers.js";

const WR: OpportunityInputs = {
  position: "WR",
  position_id: 3,
  games: 5,
  targets_pg: 8,
  carries_pg: 0.3,
  catch_rate: 0.65,
  yards_per_reception: 12.5,
  yards_per_carry: 6,
  td_per_target: 0.05,
  td_per_carry: 0.02,
};

const ppr = () =>
  normalizeSettings({
    ...REFERENCE_SCORING_SETTINGS,
    scoringItems: REFERENCE_SCORING_SETTINGS.scoringItems.map((i) =>
      i.statId === 53 ? { ...i, points: 1 } : i,
    ),
  });

describe("hasOpportunityInputs", () => {
  it("RB/WR/TE with ≥ 3 games and some volume only", () => {
    expect(hasOpportunityInputs(WR)).toBe(true);
    expect(hasOpportunityInputs({ ...WR, position: "QB" })).toBe(false);
    expect(hasOpportunityInputs({ ...WR, games: 2 })).toBe(false);
    expect(hasOpportunityInputs({ ...WR, targets_pg: 0, carries_pg: 0 })).toBe(false);
    expect(hasOpportunityInputs({ ...WR, targets_pg: Number.NaN })).toBe(false);
    expect(hasOpportunityInputs({ ...WR, carries_pg: -1 })).toBe(false);
    expect(hasOpportunityInputs(null)).toBe(false);
    expect(hasOpportunityInputs(undefined)).toBe(false);
  });
});

describe("playerSimDist", () => {
  const run = (over: Partial<Parameters<typeof playerSimDist>[0]> = {}) =>
    playerSimDist({
      opportunity: WR,
      settings: referenceSettings(),
      espn_mean: 11.2,
      p_active: 1,
      n_sims: 3000,
      rng: seededRng(3),
      ...over,
    });
  it("player_sim basis, ESPN's mean exactly, ordered quantiles", () => {
    const r = run();
    expect(r).not.toBeNull();
    const d = r?.dist;
    expect(d?.basis).toBe("player_sim");
    expect(d?.mean).toBe(11.2);
    expect(
      d !== undefined && d.p10 <= d.p25 && d.p25 <= d.p50 && d.p50 <= d.p75 && d.p75 <= d.p90,
    ).toBe(true);
    expect(r?.sim_mean).toBeGreaterThan(0);
    expect(r?.factor).toBeCloseTo(11.2 / (r?.sim_mean ?? 1), 3);
  });
  it("seeded and deterministic", () => {
    expect(run()).toEqual(run());
    expect(run({ rng: seededRng(4) })).not.toEqual(run());
  });
  it("format-aware: full PPR widens a receiver's spread at the same mean", () => {
    const half = run();
    const full = run({ settings: ppr() });
    const spread = (x: typeof half) => (x === null ? 0 : x.dist.p90 - x.dist.p10);
    expect(full?.sim_mean).toBeGreaterThan(half?.sim_mean ?? 0);
    expect(full?.dist.mean).toBe(11.2);
    expect(spread(full)).toBeGreaterThan(0);
  });
  it("the zero mass follows P(active), floored as E1's", () => {
    const q = run({ p_active: 0.71, n_sims: 5000 });
    expect(q?.dist.p_zero).toBeGreaterThan(0.2);
    expect(q?.dist.p_zero).toBeLessThan(0.4);
    const out = run({ p_active: 0, n_sims: 5000 });
    expect(out?.dist.p_zero).toBeCloseTo(1 - P_ACTIVE_SHAPE_FLOOR, 1);
  });
  it("no ESPN mean: the simulated mean stands (factor 1); an implausible anchor is clamped", () => {
    const r = run({ espn_mean: null });
    expect(r?.factor).toBe(1);
    expect(r?.dist.mean).toBe(r?.sim_mean);
    const wild = run({ espn_mean: 500 });
    expect(wild?.factor).toBe(3);
    expect(wild?.dist.mean).toBeCloseTo((wild?.sim_mean ?? 0) * 3, 2);
  });
  it("defaults fill missing efficiency inputs; a QB or a thin history gets null", () => {
    const sparse = run({
      opportunity: {
        ...WR,
        position: "RB",
        position_id: 2,
        catch_rate: null,
        yards_per_reception: null,
        yards_per_carry: null,
        td_per_target: null,
        td_per_carry: null,
        carries_pg: 14,
      },
    });
    expect(sparse?.dist.basis).toBe("player_sim");
    expect(run({ opportunity: { ...WR, position: "QB", position_id: 1 } })).toBeNull();
    expect(run({ opportunity: { ...WR, games: 1 } })).toBeNull();
  });
});
