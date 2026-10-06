// projection.test.ts — E1 v1-ensemble (plan 07 E1; ADV OBJ-02): ESPN's mean is the point estimate
// (weight_espn = 1.0) for every active player-week; the trailing line scored through the engine
// shapes the spread (the QB CV follows the pass-TD value — research 05 §3.2 — and the turnover
// left tail) and raises the 25 % disagreement flag; availability, byes, missing inputs, the ROS
// share, determinism by seed, the CPU deadline's partial result, bounds and hostile inputs.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  pActiveOf,
  positionCv,
  projectPlayers,
  targetOf,
  type ProjectionRequest,
  type ProjectionTarget,
  type TrailingLine,
} from "../../../src/domain/analytics/projection.js";
import { AnalyticsError } from "../../../src/domain/analytics/errors.js";
import { WEIGHT_ESPN_V1 } from "../../../src/domain/analytics/types.js";
import { asPositionId, type StatLine } from "../../../src/domain/scoring/types.js";
import type { PlatformPlayer } from "../../../src/domain/league/types.js";
import {
  bare,
  clockAndRng,
  instantPacer,
  POSITION_ID,
  proSchedule,
  referenceSettings,
  steppingPacer,
} from "./helpers.js";

const SEASON = 2026;
const WEEKS = Array.from({ length: 17 }, (_, i) => i + 1);

function qbLine(week: number, yd: number, td: number, int: number, season = SEASON): TrailingLine {
  const values = { pass_yd: yd, pass_td: td, pass_int: int, fum_lost: 0 };
  const line: StatLine = {
    values,
    present: Object.keys(values).sort(),
    position: asPositionId(1),
    position_class: "O",
    provisional: false,
    source: "nflverse",
  };
  return { season, week, line };
}

function target(over: Partial<ProjectionTarget> = {}): ProjectionTarget {
  return {
    player_id: 101,
    gsis_id: "00-0000101",
    name: bare("Player 101"),
    position: "QB",
    position_id: POSITION_ID.QB ?? 1,
    pro_team_id: 1,
    injury_status: "ACTIVE",
    espn_week: 20,
    espn_ros: 260,
    trailing: [],
    ...over,
  };
}

function request(over: Partial<ProjectionRequest> = {}): ProjectionRequest {
  const { clock, rng } = clockAndRng();
  return {
    targets: [target()],
    season: SEASON,
    horizon: "week",
    week: 5,
    final_week: 17,
    settings: referenceSettings(),
    schedule: proSchedule(SEASON, WEEKS, { byes: { "9": [1, 2] } }),
    clock,
    rng,
    pacer: instantPacer,
    deadline_ms: null,
    n_sims: 2000,
    ...over,
  };
}

describe("ESPN's mean is the point estimate (weight_espn = 1.0)", () => {
  it("every active player-week's Dist mean is ESPN's projection exactly, basis position_cv", async () => {
    const out = await projectPlayers(
      request({
        targets: [
          target(),
          target({ player_id: 102, position: "RB", position_id: 2, espn_week: 13.7 }),
          target({
            player_id: 103,
            position: "WR",
            position_id: 3,
            espn_week: 9.25,
            injury_status: "QUESTIONABLE",
          }),
        ],
      }),
    );
    for (const [i, espn] of [20, 13.7, 9.25].entries()) {
      const w = out.data.projections[i]?.weeks[0];
      expect(w?.points.mean).toBe(espn);
      expect(w?.points.basis).toBe("position_cv");
      expect(w?.inputs).toMatchObject({ espn, weight_espn: WEIGHT_ESPN_V1 });
    }
    expect(out.data.model_version).toBe("v1-ensemble");
    expect(out.data.completed_samples).toBe(2000);
    expect(out.partial).toBe(false);
  });

  it("property: the mean equals ESPN's for any positive projection and active status", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 0.1, max: 60, noNaN: true }),
        fc.constantFrom("QB", "RB", "WR", "TE", "K", "D/ST"),
        fc.constantFrom("ACTIVE", "QUESTIONABLE", null),
        async (espn, pos, status) => {
          const out = await projectPlayers(
            request({
              targets: [
                target({
                  position: pos,
                  position_id: POSITION_ID[pos] ?? 1,
                  espn_week: espn,
                  injury_status: status,
                }),
              ],
              n_sims: 1000,
            }),
          );
          const d = out.data.projections[0]?.weeks[0]?.points;
          return d !== undefined && Math.abs(d.mean - espn) < 1e-4 && d.p10 <= d.p90;
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe("the trailing line shapes the spread and the disagreement flag", () => {
  it("the QB CV moves with the pass-TD value (research 05 §3.2: 0.391 / 0.401 / 0.411)", () => {
    expect(positionCv("QB", 1, referenceSettings(4))).toBeCloseTo(0.391, 6);
    expect(positionCv("QB", 1, referenceSettings(5))).toBeCloseTo(0.401, 6);
    expect(positionCv("QB", 1, referenceSettings(6))).toBeCloseTo(0.411, 6);
    expect(positionCv("RB", 2, referenceSettings())).toBe(0.585);
    expect(positionCv("LS", 99, referenceSettings())).toBe(0.65);
  });

  it("a turnover-prone QB has a fatter left tail than a clean one at the same mean and CV", async () => {
    const turnovers = Array.from({ length: 6 }, (_, i) => qbLine(4 - (i % 4), 250, 2, 3));
    const clean = Array.from({ length: 6 }, (_, i) => qbLine(4 - (i % 4), 250, 2, 0));
    const out = await projectPlayers(
      request({
        targets: [
          target({ player_id: 1, trailing: turnovers }),
          target({ player_id: 2, trailing: clean }),
        ],
        n_sims: 8000,
      }),
    );
    const [a, b] = out.data.projections.map((p) => p.weeks[0]?.points);
    expect(a?.mean).toBe(b?.mean);
    expect(a?.p10 ?? 0).toBeLessThan(b?.p10 ?? 0);
    const tail = out.data.projections[0]?.drivers.find((d) => d.name === "turnover_tail");
    expect(tail?.contribution ?? 0).toBeLessThan(0);
  });

  it("flags a > 25 % gap between ESPN and the trailing line, never overrides ESPN", async () => {
    const low = Array.from({ length: 4 }, (_, i) => qbLine(4 - i, 150, 1, 1));
    const near = Array.from({ length: 4 }, (_, i) => qbLine(4 - i, 260, 2, 0));
    const out = await projectPlayers(
      request({
        targets: [
          target({ player_id: 1, trailing: low }),
          target({ player_id: 2, trailing: near }),
        ],
      }),
    );
    const [a, b] = out.data.projections.map((p) => p.weeks[0]);
    expect(a?.disagreement.flagged).toBe(true);
    expect(a?.disagreement.pct ?? 0).toBeGreaterThan(0.25);
    expect(a?.points.mean).toBe(20);
    expect(b?.disagreement.flagged).toBe(false);
    expect(out.data.projections[0]?.role_confidence_games).toBe(4);
    // own = the trailing line scored under S: 150 × 0.04 + 5 − 2 = 9
    expect(a?.inputs.own).toBeCloseTo(9, 6);
  });

  it("reads only the season's weeks before the target week and the prior season (no look-ahead)", async () => {
    const lines = [
      qbLine(5, 500, 6, 0),
      qbLine(6, 500, 6, 0),
      qbLine(3, 200, 1, 0),
      qbLine(17, 200, 1, 0, SEASON - 1),
      qbLine(3, 900, 9, 0, SEASON - 2),
    ];
    const out = await projectPlayers(
      request({ targets: [target({ trailing: lines })], include_stat_line: true }),
    );
    const p = out.data.projections[0];
    expect(p?.role_confidence_games).toBe(2);
    expect(p?.stat_line_expectation?.pass_yd).toBeCloseTo(200, 6);
    expect(
      (await projectPlayers(request({ targets: [target({ trailing: lines })] }))).data
        .projections[0],
    ).not.toHaveProperty("stat_line_expectation");
  });

  it("a trailing line the engine refuses is skipped with a warning", async () => {
    const bad = {
      season: SEASON,
      week: 2,
      line: { ...qbLine(2, 1, 0, 0).line, values: { pass_yd: Number.NaN } },
    };
    const out = await projectPlayers(
      request({ targets: [target({ trailing: [bad, qbLine(3, 200, 1, 0)] })] }),
    );
    expect(out.data.projections[0]?.role_confidence_games).toBe(1);
    expect(out.warnings.some((w) => w.includes("could not be scored"))).toBe(true);
  });
});

describe("availability, byes and missing inputs", () => {
  it("OUT is structured and wins: 0 points, ESPN's number named in the assumptions", async () => {
    const out = await projectPlayers(request({ targets: [target({ injury_status: "OUT" })] }));
    const w = out.data.projections[0]?.weeks[0];
    expect(w?.points).toMatchObject({ mean: 0, p_zero: 1 });
    expect(w?.p_active).toBe(0);
    expect(out.data.projections[0]?.assumptions.some((a) => a.text.includes("rules him out"))).toBe(
      true,
    );
  });

  it("Questionable keeps ESPN's mean with a 29 % zero mass; Doubtful holds the zero mass at the floor", async () => {
    const out = await projectPlayers(
      request({
        targets: [
          target({ player_id: 1, injury_status: "QUESTIONABLE" }),
          target({ player_id: 2, injury_status: "DOUBTFUL" }),
        ],
        n_sims: 8000,
      }),
    );
    const [q, d] = out.data.projections.map((p) => p.weeks[0]);
    expect(q?.points.mean).toBe(20);
    expect(q?.points.p_zero ?? 0).toBeCloseTo(0.29, 1);
    expect(q?.p_active).toBe(0.71);
    expect(d?.points.mean).toBe(20);
    expect(d?.points.p_zero ?? 0).toBeCloseTo(0.5, 1);
    expect(d?.p_active).toBe(0.059);
    expect(out.data.projections[1]?.assumptions.some((a) => a.text.includes("zero mass"))).toBe(
      true,
    );
  });

  it("a bye week and a player without an NFL team score a point mass at zero", async () => {
    const out = await projectPlayers(
      request({
        week: 9,
        final_week: 9,
        targets: [target({ player_id: 1 }), target({ player_id: 2, pro_team_id: 0 })],
      }),
    );
    const [bye, none] = out.data.projections.map((p) => p.weeks[0]);
    expect(bye?.points).toMatchObject({ mean: 0, p_zero: 1 });
    expect(bye?.p_active).toBeNull();
    expect(none?.points).toMatchObject({ mean: 0, p_zero: 1 });
    expect(out.players[0]?.weeks[0]?.bye).toBe(true);
    expect(out.data.projections[1]?.assumptions.some((a) => a.text.includes("no NFL team"))).toBe(
      true,
    );
  });

  it("ESPN missing → the trailing line is the estimate, weight_espn 0; both missing → 0, said so", async () => {
    const lines = Array.from({ length: 3 }, (_, i) => qbLine(4 - i, 250, 2, 0));
    const out = await projectPlayers(
      request({
        targets: [
          target({ player_id: 1, espn_week: null, espn_ros: null, trailing: lines }),
          target({ player_id: 2, espn_week: null, espn_ros: null }),
        ],
      }),
    );
    const [own, nothing] = out.data.projections;
    expect(own?.weeks[0]?.points.mean).toBeCloseTo(20, 6);
    expect(own?.weeks[0]?.inputs.weight_espn).toBe(0);
    expect(own?.weeks[0]?.inputs.espn).toBeNull();
    expect(own?.assumptions.some((a) => a.text.includes("no ESPN projection"))).toBe(true);
    expect(nothing?.weeks[0]?.points.mean).toBe(0);
    expect(nothing?.assumptions.some((a) => a.text.includes("projected at 0"))).toBe(true);
  });

  it("P(active) basis: base rate, game day within 3 h of kickoff, none without a designation", () => {
    const now = Date.UTC(2026, 9, 11, 15, 0);
    expect(pActiveOf("QUESTIONABLE", now + 5 * 3600_000, now)).toEqual({
      p: 0.71,
      basis: "designation_base_rate",
    });
    expect(pActiveOf("QUESTIONABLE", now + 2 * 3600_000, now)).toEqual({
      p: 0.71,
      basis: "espn_gameday_status",
    });
    expect(pActiveOf(null, null, now)).toEqual({ p: 1, basis: "none" });
    expect(pActiveOf("ACTIVE", null, now)).toEqual({ p: 1, basis: "none" });
    expect(pActiveOf("SOMETHING_NEW", null, now)).toEqual({ p: 1, basis: "none" });
    expect(pActiveOf("DAY_TO_DAY", null, now).p).toBe(0.71);
  });
});

describe("rest of season", () => {
  it("shares ESPN's ROS total over the remaining weeks with a game; the ROS total sums the weeks", async () => {
    const out = await projectPlayers(
      request({
        horizon: "ros",
        week: 5,
        final_week: 17,
        targets: [target({ espn_week: 20, espn_ros: 260 })],
      }),
    );
    const p = out.data.projections[0];
    expect(p?.weeks.map((w) => w.week)).toEqual(WEEKS.slice(4));
    // 260 − 20 shared over weeks 6–17 minus the week-9 bye = 11 weeks
    expect(p?.weeks[1]?.points.mean).toBeCloseTo(240 / 11, 3);
    expect(p?.weeks.find((w) => w.week === 9)?.points.mean).toBe(0);
    expect(p?.ros_total?.mean).toBeCloseTo(260, 3);
    expect(p?.ros_total?.basis).toBe("position_cv");
  });

  it("a weekly ESPN value for a later week is used as given and leaves the share", async () => {
    const out = await projectPlayers(
      request({
        horizon: "season",
        week: 15,
        final_week: 17,
        targets: [
          target({ espn_week: 18, espn_ros: 60, espn_by_week: { "16": 30, "17": Number.NaN } }),
        ],
      }),
    );
    const w = out.data.projections[0]?.weeks;
    expect(w?.map((x) => x.points.mean)).toEqual([18, 30, 12]);
  });

  it("a week horizon shares the ROS total over the whole season left, never one week", async () => {
    const out = await projectPlayers(
      request({ week: 5, targets: [target({ espn_week: null, espn_ros: 260 })] }),
    );
    expect(out.data.projections[0]?.weeks[0]?.points.mean).toBeCloseTo(260 / 12, 3);
    expect(out.data.projections[0]?.ros_total).toBeNull();
  });
});

describe("determinism, the CPU deadline, opponents and bounds", () => {
  it("the same seed gives byte-identical data; a different seed moves the quantiles only", async () => {
    const first = (await projectPlayers(request())).data;
    const a = JSON.stringify(first);
    const b = JSON.stringify((await projectPlayers(request())).data);
    expect(a).toBe(b);
    const { clock, rng } = clockAndRng("2026-10-06T12:00:00.000Z", 99);
    const c = (await projectPlayers(request({ clock, rng }))).data.projections[0]?.weeks[0]?.points;
    expect(JSON.stringify(c)).not.toBe(JSON.stringify(first.projections[0]?.weeks[0]?.points));
    expect(c?.mean).toBe(20);
  });

  it("past the CPU deadline the result is partial with the completed sample count", async () => {
    const out = await projectPlayers(
      request({ pacer: steppingPacer(1), deadline_ms: 30, n_sims: 20_000 }),
    );
    expect(out.partial).toBe(true);
    expect(out.data.completed_samples).toBeGreaterThan(0);
    expect(out.data.completed_samples).toBeLessThan(20_000);
    expect(out.data.projections[0]?.weeks[0]?.points.mean).toBe(20);
    expect(out.warnings.some((w) => w.startsWith("partial:"))).toBe(true);
  });

  it("names the opponent and its implied total", async () => {
    const out = await projectPlayers(
      request({ implied_totals: [{ week: 5, pro_team_id: 1, implied: 24.5 }] }),
    );
    const w = out.data.projections[0]?.weeks[0];
    expect(w?.opponent).toBe("T2");
    expect(w?.implied_total).toBe(24.5);
  });

  it("shares n_sims down over many player-weeks, never below the minimum", async () => {
    const targets = Array.from({ length: 50 }, (_, i) => target({ player_id: i + 1 }));
    const out = await projectPlayers(
      request({ targets, horizon: "ros", week: 1, final_week: 17, n_sims: 20_000 }),
    );
    expect(out.data.completed_samples).toBeLessThan(20_000);
    expect(out.data.completed_samples).toBeGreaterThanOrEqual(1000);
    expect(out.warnings.some((w) => w.startsWith("n_sims shared down"))).toBe(true);
  });

  it("refuses without settings and out of bounds", async () => {
    await expect(projectPlayers(request({ settings: null }))).rejects.toMatchObject({
      code: "no_settings",
      effCode: "STALE_ONLY",
    });
    for (const bad of [
      { targets: [] },
      { week: 0 },
      { final_week: 30 },
      { n_sims: 10 },
      { n_sims: 1500.5 },
      { horizon: "ros" as const, week: 10, final_week: 9 },
    ])
      await expect(projectPlayers(request(bad))).rejects.toBeInstanceOf(AnalyticsError);
  });

  it("targetOf maps the provider's player", () => {
    const p = {
      ref: { platform: "espn", id: 42 },
      name: bare("Player 42"),
      position: "TE",
      position_id: 4,
      pro_team_id: 7,
      injury_status: null,
      projection_week_espn: 8.5,
      projection_ros_espn: 90,
    } as unknown as PlatformPlayer;
    expect(targetOf(p, null)).toMatchObject({
      player_id: 42,
      position_id: 4,
      espn_week: 8.5,
      espn_ros: 90,
      trailing: [],
    });
  });
});
