// expectation-simulate.test.ts — v2's deterministic expectation (sib research 05 §1 steps 1–7) and
// the simulation (step 9; plan 07 E1 `basis: "player_sim"`): opportunities = team volume × share,
// touchdowns from location with the ffopportunity → pbp → prior fallbacks and never the player's own
// TD rate, the market multiplier against the player's window, skips; the simulator is deterministic
// per stream, the engine's scoreSamples Dist equals the quantiles of the per-line points, the mean
// matches the expected line under a linear S, P(active) sets the zero mass, the format changes the
// Dist through S only, and research 05 §3.2's turnover model widens the QB's left tail more than it
// moves his mean.
import { describe, expect, it } from "vitest";
import { seededRng } from "../../../../src/domain/clock.js";
import { distFromSamples } from "../../../../src/domain/analytics/math.js";
import {
  DEFAULT_V2_PARAMS,
  DEFAULT_V2_PRIORS,
} from "../../../../src/domain/analytics/projections-v2/constants.js";
import {
  activePoints,
  anchorExpectation,
  scaleVolume,
} from "../../../../src/domain/analytics/projections-v2/ensemble.js";
import {
  expectV2,
  isV2Position,
  type ExpectationContext,
  type ExpectationResult,
} from "../../../../src/domain/analytics/projections-v2/expectation.js";
import {
  expectedCounts,
  expectedLine,
  lineAt,
  SAMPLE_WIDTH,
  shareCv,
  simDist,
  simPoints,
  simulateInto,
  simulateLine,
  simulateLines,
  zeroLine,
} from "../../../../src/domain/analytics/projections-v2/simulate.js";
import type { V2Game } from "../../../../src/domain/analytics/projections-v2/types.js";
import { indexTeamGames } from "../../../../src/domain/analytics/projections-v2/window.js";
import { score } from "../../../../src/domain/scoring/engine.js";
import { game, qbGame, rbGame, settings, teamSeason, wrGame } from "./helpers/synthetic.js";

const rows = teamSeason(10);
const ctx = (over: Partial<ExpectationContext> = {}): ExpectationContext => ({
  season: 2025,
  week: 9,
  team_index: indexTeamGames(rows),
  team_games: rows,
  market: { implied: 22, spread: 0, total: 44 },
  weather: null,
  opponent: "BBB",
  matchup: null,
  priors: DEFAULT_V2_PRIORS,
  params: DEFAULT_V2_PARAMS,
  ...over,
});
const expect8 = (
  games: readonly V2Game[],
  position = "WR",
  over: Partial<ExpectationContext> = {},
) => {
  const r = expectV2(
    { position, position_id: { QB: 1, RB: 2, WR: 3, TE: 4 }[position] ?? 3, team: "AAA", games },
    ctx(over),
  );
  if (typeof r === "string") throw new Error(r);
  return r;
};
const wrs = [1, 2, 3, 4, 5, 6, 7, 8].map((w) => wrGame(w));

describe("expectV2", () => {
  it("skips what it does not model", () => {
    expect(expectV2({ position: "K", position_id: 5, team: "AAA", games: wrs }, ctx())).toBe(
      "position_not_modelled",
    );
    expect(expectV2({ position: "WR", position_id: 3, team: null, games: wrs }, ctx())).toBe(
      "no_team",
    );
    expect(expectV2({ position: "WR", position_id: 3, team: "", games: wrs }, ctx())).toBe(
      "no_team",
    );
    expect(expectV2({ position: "WR", position_id: 3, team: "AAA", games: [] }, ctx())).toBe(
      "no_history",
    );
    expect(isV2Position("TE")).toBe(true);
    expect(isV2Position("D/ST")).toBe(false);
  });

  it("expected targets are the team's dropbacks × the shrunk target share", () => {
    const r = expect8(wrs);
    const e = r.expectation;
    expect(e.target_per_dropback).toBeLessThan(8 / 38);
    expect(e.target_per_dropback).toBeGreaterThan(DEFAULT_V2_PRIORS.positions.WR.target_share);
    expect(e.targets).toBeCloseTo(e.team_dropbacks * e.target_per_dropback, 9);
    expect(e.pass_att).toBe(0);
    expect(e.td_basis).toBe("ffopportunity");
    // xTD 0.4 per 8 targets, shrunk toward the prior, market and matchup neutral
    expect(e.td_per_target).toBeGreaterThan(DEFAULT_V2_PRIORS.positions.WR.xtd_per_target);
    expect(e.td_per_target).toBeLessThan(0.05);
    expect(e.market_mult).toBeCloseTo(1, 9);
    expect(e.role_games).toBe(8);
    expect(r.market_missing).toBe(false);
    expect(e.shrinkage.map((s) => s.rate)).toContain("catch_rate");
  });

  it("never uses the player's own TD rate: 3 TDs a game change nothing", () => {
    const lucky = wrs.map((g) => ({ ...g, rec_td: 3 }));
    expect(expect8(lucky).expectation.td_per_target).toBeCloseTo(
      expect8(wrs).expectation.td_per_target,
      12,
    );
  });

  it("falls back to pbp location rates, then to the prior", () => {
    const pbp = wrs.map((g) => ({ ...g, x_rec_td: null, rz_targets: 2 }));
    const e = expect8(pbp).expectation;
    expect(e.td_basis).toBe("pbp_location");
    const P = DEFAULT_V2_PRIORS.positions.WR;
    const loc = (2 * P.td_rz_target + 6 * P.td_other_target) / 8;
    expect(e.td_per_target).toBeGreaterThan(Math.min(loc, P.xtd_per_target) - 1e-9);
    const none = wrs.map((g) => ({ ...g, x_rec_td: null }));
    const p = expect8(none).expectation;
    expect(p.td_basis).toBe("prior");
    expect(p.td_per_target).toBeCloseTo(P.xtd_per_target, 12);
  });

  it("scales touchdown rates by the implied total against the player's window (bounded)", () => {
    const hi = expect8(wrs, "WR", { market: { implied: 27.5, spread: 3, total: 52 } }).expectation;
    expect(hi.market_mult).toBeCloseTo((27.5 / 22) ** DEFAULT_V2_PARAMS.market_td_theta, 6);
    const huge = expect8(wrs, "WR", {
      market: { implied: 400, spread: 0, total: 800 },
    }).expectation;
    expect(huge.market_mult).toBe(1.6);
    const missing = expect8(wrs, "WR", { market: null });
    expect(missing.market_missing).toBe(true);
    expect(missing.expectation.market_mult).toBe(1);
  });

  it("a QB's attempts come from his dropback share net of sacks; turnovers are his shrunk rates", () => {
    const qbs = [1, 2, 3, 4, 5, 6, 7, 8].map((w) => qbGame(w));
    const e = expect8(qbs, "QB").expectation;
    expect(e.pass_att).toBeGreaterThan(25);
    expect(e.pass_att).toBeCloseTo(e.team_dropbacks * e.att_per_dropback, 9);
    expect(e.sack_per_dropback).toBeGreaterThan(0);
    expect(e.int_per_att).toBeGreaterThan(DEFAULT_V2_PRIORS.positions.QB.int_rate);
    expect(e.td_basis).toBe("ffopportunity");
    expect(e.targets).toBe(0);
  });

  it("an RB's carries are team rushes × carry share; cold weather adds yards per carry", () => {
    const rbs = [1, 2, 3, 4, 5, 6, 7, 8].map((w) => rbGame(w));
    const warm = expect8(rbs, "RB").expectation;
    const cold = expect8(rbs, "RB", {
      weather: { roof: "outdoors", temp_f: 10, wind_mph: 0, precip_prob: null },
    }).expectation;
    expect(warm.carries).toBeCloseTo(warm.team_rushes * warm.carry_share, 9);
    expect(cold.yards_per_carry).toBeGreaterThan(warm.yards_per_carry);
    expect(cold.weather.applied).toBe(true);
    expect(warm.td_basis).toBe("ffopportunity");
  });
});

describe("simulate", () => {
  const s = settings();
  const e = expect8(wrs).expectation;

  it("is deterministic per stream and the draw order is fixed", () => {
    const a = simulateLines(e, 1, DEFAULT_V2_PARAMS, seededRng(5), 50);
    const b = simulateLines(e, 1, DEFAULT_V2_PARAMS, seededRng(5), 50);
    expect(a).toEqual(b);
    const one = simulateLine(e, 1, DEFAULT_V2_PARAMS, seededRng(5));
    expect(one).toEqual(a[0]);
  });

  it("the engine's scoreSamples Dist equals the quantiles of the per-line points", () => {
    const lines = simulateLines(e, 0.8, DEFAULT_V2_PARAMS, seededRng(9), 600);
    const d = simDist(lines, s);
    const viaPoints = distFromSamples(simPoints(lines, s), "player_sim");
    expect(d.basis).toBe("player_sim");
    for (const k of ["p10", "p25", "p50", "p75", "p90", "p_zero"] as const)
      expect(d[k]).toBeCloseTo(viaPoints[k], 3);
    expect(d.mean).toBeCloseTo(viaPoints.mean, 3);
  });

  it("the simulated mean matches the expected line under a linear S (sampling error only)", () => {
    const lines = simulateLines(e, 1, DEFAULT_V2_PARAMS, seededRng(21), 6000);
    const det = activePoints(e, s);
    expect(simDist(lines, s).mean).toBeCloseTo(det, 0);
    expect(score(expectedLine(e), s).points_exact).toBeCloseTo(det, 9);
  });

  it("P(active) is the zero mass; P(active) 0 is a point mass at 0", () => {
    const d = simDist(simulateLines(e, 0.6, DEFAULT_V2_PARAMS, seededRng(3), 4000), s);
    expect(d.p_zero).toBeGreaterThan(0.35);
    expect(d.p_zero).toBeLessThan(0.46);
    const zero = simDist(simulateLines(e, 0, DEFAULT_V2_PARAMS, seededRng(3), 50), s);
    expect(zero).toMatchObject({ mean: 0, p90: 0, p_zero: 1 });
    expect(score(zeroLine(3), s).points).toBe(0);
    expect(zeroLine(3).values.gp).toBe(0);
  });

  it("the format moves the distribution through S only (half-PPR → PPR adds the catches)", () => {
    const lines = simulateLines(e, 1, DEFAULT_V2_PARAMS, seededRng(4), 2000);
    const half = simDist(lines, s).mean;
    const ppr = simDist(lines, {
      ...s,
      rules: s.rules.map((r) => (r.canonical === "rec" ? { ...r, points: 1 } : r)),
    }).mean;
    const rec = lines.reduce((a, l) => a + (l.values.rec ?? 0), 0) / lines.length;
    expect(ppr - half).toBeCloseTo(0.5 * rec, 6);
  });

  it("the role draw widens while the role is young", () => {
    expect(shareCv(DEFAULT_V2_PARAMS, 1)).toBeGreaterThan(shareCv(DEFAULT_V2_PARAMS, 8));
    expect(
      shareCv({ ...DEFAULT_V2_PARAMS, sim: { ...DEFAULT_V2_PARAMS.sim, cv_share: 0 } }, 1),
    ).toBe(0);
  });

  it("samples write SAMPLE_WIDTH numbers and read back as lines", () => {
    const buf = new Float64Array(2 * SAMPLE_WIDTH);
    simulateInto(e, 1, DEFAULT_V2_PARAMS, seededRng(1), buf, SAMPLE_WIDTH);
    expect(buf.slice(0, SAMPLE_WIDTH).every((x) => x === 0)).toBe(true);
    const l = lineAt(buf, SAMPLE_WIDTH, 3);
    expect(l.values.gp).toBe(1);
    expect(l.values.rec_stat).toBe(l.values.rec);
    expect(l.values.pass_inc).toBe(0);
    expect(l.present).toEqual([...l.present].sort());
  });

  it("research 05 §3.2: turnovers widen the QB's left tail more than they move his mean", () => {
    const qb = expect8(
      [1, 2, 3, 4, 5, 6, 7, 8].map((w) => qbGame(w)),
      "QB",
    ).expectation;
    const clean = { ...qb, int_per_att: 0, fumble_per_touch: 0 };
    const risky = { ...qb, int_per_att: 0.035, fumble_per_touch: 0.02 };
    const a = simDist(simulateLines(clean, 1, DEFAULT_V2_PARAMS, seededRng(8), 6000), s);
    const b = simDist(simulateLines(risky, 1, DEFAULT_V2_PARAMS, seededRng(8), 6000), s);
    expect(b.mean).toBeLessThan(a.mean);
    expect(a.p10 - b.p10).toBeGreaterThan(a.mean - b.mean);
    expect(b.p90 - b.p10).toBeGreaterThan(a.p90 - a.p10);
  });

  it("expectedCounts is the line the expectation implies", () => {
    const c = expectedCounts(e);
    expect(c.targets).toBeCloseTo(e.targets, 3);
    expect(c.rec).toBeCloseTo(e.targets * e.catch_rate, 3);
    expect(c.rec_td).toBeCloseTo(e.targets * e.td_per_target, 3);
  });
});

describe("ensemble anchoring", () => {
  const s = settings();
  const r: ExpectationResult = expect8(wrs);
  const e = r.expectation;

  it("scales every opportunity, never a rate", () => {
    const x = scaleVolume(e, 1.5);
    expect(x.targets).toBeCloseTo(e.targets * 1.5, 9);
    expect(x.carries).toBeCloseTo(e.carries * 1.5, 9);
    expect(x.catch_rate).toBe(e.catch_rate);
    expect(x.td_per_target).toBe(e.td_per_target);
  });

  it("anchors the simulation's mean to the target within the band; outside it, or with no volume, it does not", () => {
    const base = activePoints(e, s);
    const a = anchorExpectation(e, 1, base * 1.4, s);
    expect(a.factor).toBeCloseTo(1.4, 9);
    if (a.expectation === null) throw new Error("expected an anchor");
    expect(activePoints(a.expectation, s)).toBeCloseTo(base * 1.4, 0);
    const same = anchorExpectation(e, 1, base, s);
    expect(same.expectation).toBe(e);
    expect(anchorExpectation(e, 1, base * 10, s).expectation).toBeNull();
    expect(anchorExpectation(e, 1, 0, s).expectation).toBeNull();
    const idle = { ...e, targets: 0, carries: 0 };
    expect(anchorExpectation(idle, 1, 5, s).expectation).toBeNull();
  });

  it("anchoring by volume narrows the relative spread as the mean grows (Poisson, not a scale)", () => {
    const base = activePoints(e, s);
    const a = anchorExpectation(e, 1, base * 2, s).expectation;
    if (a === null) throw new Error("expected an anchor");
    const own = simDist(simulateLines(e, 1, DEFAULT_V2_PARAMS, seededRng(2), 4000), s);
    const big = simDist(simulateLines(a, 1, DEFAULT_V2_PARAMS, seededRng(2), 4000), s);
    expect((big.p90 - big.p10) / big.mean).toBeLessThan((own.p90 - own.p10) / own.mean);
  });

  it("an engine refusal reads as 0 points (no throw)", () => {
    const broken = { ...e, position_id: 999 };
    expect(activePoints(broken, s)).toBe(0);
  });

  it("game builder sanity", () => {
    expect(game({ week: 1 }).targets).toBe(0);
  });
});
