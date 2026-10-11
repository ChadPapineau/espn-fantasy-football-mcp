// dispersion.test.ts — Stage C's remediation of the narrow QB interval (docs/evals/phase3-summary.md
// "Open"; docs/evals/phase3-projections.md "Per-position dispersion"): (1) the interception drive
// cost is centred on the expected interceptions, so the simulation's mean is its expected line's (the
// uncentred cost lost every QB-week's average INT-ended drives twice) while each extra interception
// still costs its drive (the negative INT–points correlation research 05 §3.2 needs, within a
// player-week); (2) the own simulation's per-position dispersion (`sim.position`) — never applied to
// the ensemble's anchored simulation, whose mean is ESPN's; a neutral entry reproduces the global
// model draw for draw; (3) `fitPositionDispersion` fits each position on its own cases and moves only
// its own paths. Pure, seeded, no network.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { seededRng } from "../../../../src/domain/clock.js";
import {
  backtestCases,
  type BacktestWorld,
} from "../../../../src/domain/analytics/projections-v2/backtest.js";
import {
  DEFAULT_V2_PARAMS,
  DEFAULT_V2_PRIORS,
  V2_PARAM_BOUNDS,
  V2_POSITIONS,
} from "../../../../src/domain/analytics/projections-v2/constants.js";
import {
  activePoints,
  anchorExpectation,
} from "../../../../src/domain/analytics/projections-v2/ensemble.js";
import { expectV2 } from "../../../../src/domain/analytics/projections-v2/expectation.js";
import {
  DISPERSION_TUNING,
  fitPositionDispersion,
  inBounds,
  paramAt,
  withParam,
} from "../../../../src/domain/analytics/projections-v2/fit.js";
import {
  dispersionOf,
  lineFromCounts,
  NO_DISPERSION,
  SAMPLE_WIDTH,
  simDist,
  simPoints,
  simulateInto,
  simulateLines,
} from "../../../../src/domain/analytics/projections-v2/simulate.js";
import type {
  V2Expectation,
  V2Game,
  V2Params,
  V2Position,
} from "../../../../src/domain/analytics/projections-v2/types.js";
import { indexTeamGames } from "../../../../src/domain/analytics/projections-v2/window.js";
import { score } from "../../../../src/domain/scoring/engine.js";
import {
  qbGame,
  rbGame,
  settings,
  syntheticWorld,
  teamSeason,
  wrGame,
} from "./helpers/synthetic.js";

const S = settings();
const rows = teamSeason(10);
const expectation = (games: readonly V2Game[], position: V2Position): V2Expectation => {
  const r = expectV2(
    { position, position_id: { QB: 1, RB: 2, WR: 3, TE: 4 }[position], team: "AAA", games },
    {
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
    },
  );
  if (typeof r === "string") throw new Error(r);
  return r.expectation;
};
const weeks = [1, 2, 3, 4, 5, 6, 7, 8];
const qb = expectation(
  weeks.map((w) => qbGame(w)),
  "QB",
);
const rb = expectation(
  weeks.map((w) => rbGame(w)),
  "RB",
);
const wr = expectation(
  weeks.map((w) => wrGame(w)),
  "WR",
);
const mean = (xs: Float64Array): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const pts = (e: V2Expectation, p: V2Params, seed: number, n: number): Float64Array =>
  simPoints(simulateLines(e, 1, p, seededRng(seed), n), S);
const noDispersion = (): V2Params => {
  const { position: _drop, ...sim } = DEFAULT_V2_PARAMS.sim;
  return { ...DEFAULT_V2_PARAMS, sim };
};

describe("the centred interception drive cost (the root of the narrow QB interval)", () => {
  it("the QB simulation's mean is its expected line's (the drive cost is mean-neutral)", () => {
    const n = 20_000;
    const expected = activePoints(qb, S);
    const withCost = mean(pts(qb, DEFAULT_V2_PARAMS, 3, n));
    // the same simulation without the drive cost: the centred cost moves the mean by noise only
    const free = withParam(
      withParam(DEFAULT_V2_PARAMS, "sim.int_drive_yards", 0),
      "sim.int_drive_td",
      0,
    );
    const noCost = mean(pts(qb, free, 3, n));
    expect(Math.abs(withCost - expected) / expected).toBeLessThan(0.02);
    expect(Math.abs(withCost - noCost) / expected).toBeLessThan(0.02);
  });

  it("property: over QB expectations of any interception rate the simulated mean stays on the expected line", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.005, max: 0.06, noNaN: true }),
        fc.double({ min: 0.7, max: 1.4, noNaN: true }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (intRate, volume, seed) => {
          const e: V2Expectation = {
            ...qb,
            int_per_att: intRate,
            team_dropbacks: qb.team_dropbacks * volume,
            pass_att: qb.pass_att * volume,
            carries: qb.carries * volume,
          };
          const m = mean(pts(e, DEFAULT_V2_PARAMS, seed, 6000));
          const expected = activePoints(e, S);
          return Math.abs(m - expected) / expected < 0.05;
        },
      ),
      { numRuns: 12, seed: 20_261_011 },
    );
  });

  it("an extra interception still costs its drive: within a player-week INTs and the other points move apart", () => {
    const lines = simulateLines(qb, 1, DEFAULT_V2_PARAMS, seededRng(11), 8000);
    const ints = lines.map((l) => l.values.pass_int ?? 0);
    const other = lines.map(
      (l) =>
        (l.values.pass_yd ?? 0) * 0.04 +
        (l.values.pass_td ?? 0) * 5 +
        (l.values.rush_yd ?? 0) * 0.1 +
        (l.values.rush_td ?? 0) * 6,
    );
    const mi = ints.reduce((a, b) => a + b, 0) / ints.length;
    const mo = other.reduce((a, b) => a + b, 0) / other.length;
    let num = 0;
    let di = 0;
    let dd = 0;
    ints.forEach((x, i) => {
      num += (x - mi) * ((other[i] ?? 0) - mo);
      di += (x - mi) ** 2;
      dd += ((other[i] ?? 0) - mo) ** 2;
    });
    expect(num / Math.sqrt(di * dd)).toBeLessThan(-0.05);
  });

  it("a QB with no interception rate pays nothing and gains nothing (the cost is centred on 0)", () => {
    const clean = { ...qb, int_per_att: 0 };
    const a = pts(clean, DEFAULT_V2_PARAMS, 4, 3000);
    const free = withParam(
      withParam(DEFAULT_V2_PARAMS, "sim.int_drive_yards", 0),
      "sim.int_drive_td",
      0,
    );
    const b = pts(clean, free, 4, 3000);
    expect([...a]).toEqual([...b]);
  });
});

describe("the own simulation's per-position dispersion (sim.position)", () => {
  it("ships the 2023 fit: QB's role draw × 1.25 and yardage per completion × 2.5; every other entry neutral", () => {
    expect(DEFAULT_V2_PARAMS.sim.position?.QB).toEqual({
      role: 1.25,
      yds_cmp: 2.5,
      yds_catch: 1,
      yds_carry: 1,
    });
    for (const p of ["RB", "WR", "TE"] as const)
      expect(DEFAULT_V2_PARAMS.sim.position?.[p], p).toEqual(NO_DISPERSION);
  });

  it("dispersionOf: the position's entry for the own simulation; none for an anchored one; bad values read as 1", () => {
    expect(dispersionOf(DEFAULT_V2_PARAMS, qb)).toBe(DEFAULT_V2_PARAMS.sim.position?.QB);
    const qbWide = withParam(DEFAULT_V2_PARAMS, "sim.position.QB.yds_cmp", 2);
    expect(dispersionOf(qbWide, qb).yds_cmp).toBe(2);
    expect(dispersionOf(qbWide, { ...qb, anchored: true })).toBe(NO_DISPERSION);
    expect(dispersionOf(DEFAULT_V2_PARAMS, { ...qb, anchored: true })).toBe(NO_DISPERSION);
    expect(dispersionOf(noDispersion(), qb)).toBe(NO_DISPERSION);
    const bad = withParam(
      withParam(DEFAULT_V2_PARAMS, "sim.position.RB.role", Number.NaN),
      "sim.position.RB.yds_carry",
      -1,
    );
    expect(dispersionOf(bad, rb)).toEqual({ role: 1, yds_cmp: 1, yds_catch: 1, yds_carry: 1 });
    const inf = withParam(DEFAULT_V2_PARAMS, "sim.position.WR.yds_catch", Number.POSITIVE_INFINITY);
    expect(dispersionOf(inf, wr).yds_catch).toBe(1);
  });

  it("property: a neutral entry reproduces the global model draw for draw (the draws and their order are unchanged)", () => {
    const neutral = withParam(
      withParam(DEFAULT_V2_PARAMS, "sim.position.QB.role", 1),
      "sim.position.QB.yds_cmp",
      1,
    );
    fc.assert(
      fc.property(
        fc.constantFrom<V2Expectation>(qb, rb, wr),
        fc.integer({ min: 1, max: 1_000_000 }),
        (e, seed) => {
          const a = new Float64Array(SAMPLE_WIDTH * 50);
          const b = new Float64Array(SAMPLE_WIDTH * 50);
          const ra = seededRng(seed);
          const rb2 = seededRng(seed);
          for (let i = 0; i < 50; i++) {
            simulateInto(e, 0.9, neutral, ra, a, i * SAMPLE_WIDTH);
            simulateInto(e, 0.9, noDispersion(), rb2, b, i * SAMPLE_WIDTH);
          }
          return a.every((x, i) => x === b[i]);
        },
      ),
      { numRuns: 25, seed: 20_261_011 },
    );
  });

  it("the shipped QB entry widens the own distribution, keeps its mean, and moves nobody else", () => {
    const wide = DEFAULT_V2_PARAMS;
    const own = simDist(simulateLines(qb, 1, wide, seededRng(5), 8000), S);
    const global = simDist(simulateLines(qb, 1, noDispersion(), seededRng(5), 8000), S);
    expect(own.p90 - own.p10).toBeGreaterThan(global.p90 - global.p10);
    expect(Math.abs(own.mean - global.mean) / global.mean).toBeLessThan(0.02);
    for (const e of [rb, wr])
      expect([...pts(e, wide, 6, 500)]).toEqual([...pts(e, noDispersion(), 6, 500)]);
  });

  it("the anchored (served) simulation is the same with or without any per-position dispersion", () => {
    const wide = withParam(
      withParam(DEFAULT_V2_PARAMS, "sim.position.QB.role", 3),
      "sim.position.QB.yds_carry",
      2,
    );
    const a = anchorExpectation(qb, 1, activePoints(qb, S) * 1.2, S);
    if (a.expectation === null) throw new Error("expected an anchor");
    for (const p of [wide, DEFAULT_V2_PARAMS])
      expect([...pts(a.expectation, p, 9, 800)]).toEqual([
        ...pts(a.expectation, noDispersion(), 9, 800),
      ]);
    // while the own simulation does change with it
    expect([...pts(qb, wide, 9, 200)]).not.toEqual([...pts(qb, noDispersion(), 9, 200)]);
  });

  it("each multiplier reaches its draw: role widens the opportunities, yds_* the yardage", () => {
    const sd = (xs: readonly number[]): number => {
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
    };
    const stat = (e: V2Expectation, p: V2Params, k: string): number[] =>
      simulateLines(e, 1, p, seededRng(12), 4000).map((l) => l.values[k] ?? 0);
    const base = noDispersion();
    const cases: [V2Expectation, string, string][] = [
      [rb, "sim.position.RB.role", "rush_att"],
      [rb, "sim.position.RB.yds_carry", "rush_yd"],
      [rb, "sim.position.RB.yds_catch", "rec_yd"],
      [qb, "sim.position.QB.yds_cmp", "pass_yd"],
    ];
    const neutral = withParam(
      withParam(DEFAULT_V2_PARAMS, "sim.position.QB.role", 1),
      "sim.position.QB.yds_cmp",
      1,
    );
    for (const [e, path, k] of cases)
      expect(sd(stat(e, withParam(neutral, path, 2.5), k)), path).toBeGreaterThan(
        sd(stat(e, base, k)),
      );
  });

  it("the multipliers have their own bounds (a proposal outside them is refused)", () => {
    expect(V2_PARAM_BOUNDS.dispersion).toEqual([0.25, 4]);
    expect(inBounds("sim.position.QB.yds_cmp", 3)).toBe(true);
    expect(inBounds("sim.position.QB.yds_cmp", 4.5)).toBe(false);
    expect(inBounds("sim.position.RB.role", 0.1)).toBe(false);
    for (const p of V2_POSITIONS)
      for (const t of DISPERSION_TUNING[p]) {
        expect(t.path.startsWith(`sim.position.${p}.`)).toBe(true);
        expect(Number.isFinite(paramAt(DEFAULT_V2_PARAMS, t.path))).toBe(true);
        expect(t.grid.every((v) => inBounds(t.path, v))).toBe(true);
      }
  });
});

describe("fitPositionDispersion", () => {
  const pid: Record<V2Position, number> = { QB: 1, RB: 2, WR: 3, TE: 4 };
  const points = (g: V2Game, pos: V2Position): number =>
    score(
      lineFromCounts(
        {
          pass_att: g.pass_att,
          pass_cmp: g.pass_cmp,
          pass_yd: g.pass_yd,
          pass_td: g.pass_td,
          pass_int: g.pass_int,
          sacks: g.sacks,
          rush_att: g.rush_att,
          rush_yd: g.rush_yd,
          rush_td: g.rush_td,
          targets: g.targets,
          rec: g.rec,
          rec_yd: g.rec_yd,
          rec_td: g.rec_td,
          fum_lost: g.sack_fum_lost + g.rush_fum_lost + g.rec_fum_lost,
          pass_2pt: 0,
          rush_2pt: 0,
          rec_2pt: 0,
        },
        pid[pos],
      ),
      S,
    ).points;
  const world: BacktestWorld = syntheticWorld(points, S, 8);
  const cases = backtestCases(world, 2025, 2, 8);

  it("fits each position on its own cases and moves only that position's paths", () => {
    const start = withParam(DEFAULT_V2_PARAMS, "sim.position.RB.role", 2);
    const fit = fitPositionDispersion(world, cases, ["RB", "WR"], start, {
      samples: 30,
      seed: 3,
      passes: 1,
      min_gain: 0,
    });
    expect(fit.fits.map((f) => f.position)).toEqual(["RB", "WR"]);
    expect(fit.fits[0]?.cases).toBe(cases.filter((c) => c.position === "RB").length);
    expect(fit.fits[1]?.cases).toBe(cases.filter((c) => c.position === "WR").length);
    for (const f of fit.fits) {
      expect(f.proposal.crps_after).toBeLessThanOrEqual(f.proposal.crps_before);
      expect(f.proposal.steps.every((s) => s.path.startsWith(`sim.position.${f.position}.`))).toBe(
        true,
      );
    }
    // QB and TE were not fitted: their entries are the start's
    expect(fit.params.sim.position?.QB).toEqual(start.sim.position?.QB);
    expect(fit.params.sim.position?.TE).toEqual(start.sim.position?.TE);
    // the start is never mutated
    expect(start.sim.position?.RB.role).toBe(2);
  });
});
