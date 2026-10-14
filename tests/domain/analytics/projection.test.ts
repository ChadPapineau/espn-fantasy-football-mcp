// projection.test.ts — E1 v1-ensemble (plan 07 E1; ADV OBJ-02): ESPN's mean is the point estimate
// (weight_espn = 1.0) for every active player-week; the trailing line scored through the engine
// shapes the spread (the QB CV follows the pass-TD value — research 05 §3.2 — and the turnover
// left tail) and raises the 25 % disagreement flag; availability, byes, missing inputs, the ROS
// share (ESPN's total runs through NFL week 18 — Stage C), determinism by seed, the CPU deadline's
// partial result, bounds and hostile inputs.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  espnRosLastWeek,
  pActiveOf,
  positionCv,
  projectPlayers,
  rosGamesOf,
  rosMissed,
  rosShare,
  rosWeekValue,
  rosWeeksOf,
  rosWindow,
  targetOf,
  type ProjectionRequest,
  type ProjectionTarget,
  type RosWeek,
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
/**
 * proSchedule's kickoffs: week w at Sep 6 + 7(w − 1), 17:00Z (week 5 = Oct 4). The default clock
 * (Oct 6) is after week 5's games; a test of the as-of week's own share reads ESPN's total BEFORE
 * them — Thursday Oct 1 — since Stage C round 2 the clock decides which games the total still counts.
 */
const BEFORE_WEEK_5 = "2026-10-01T12:00:00.000Z";
/** Tuesday of week 15 (between week 14's and week 15's kickoffs). */
const BEFORE_WEEK_15 = "2026-12-08T12:00:00.000Z";
const at = (iso: string) => clockAndRng(iso);

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
          return (
            d !== undefined &&
            Math.abs(d.mean - espn) < 1e-4 &&
            d.p10 <= d.p25 &&
            d.p25 <= d.p50 &&
            d.p50 <= d.p75 &&
            d.p75 <= d.p90 &&
            d.p_zero >= 0 &&
            d.p_zero <= 1
          );
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

describe("hostile numbers", () => {
  it("a negative D/ST projection keeps its mean; a huge one stays finite and ordered", async () => {
    const out = await projectPlayers(
      request({
        targets: [
          target({ player_id: 1, position: "D/ST", position_id: 16, espn_week: -3 }),
          target({ player_id: 2, position: "WR", position_id: 3, espn_week: 1e5 }),
        ],
      }),
    );
    const [neg, huge] = out.data.projections.map((p) => p.weeks[0]?.points);
    expect(neg?.mean).toBe(-3);
    expect(neg?.p10 ?? 0).toBeLessThan(neg?.p90 ?? 0);
    expect(huge?.mean).toBe(1e5);
    expect(Number.isFinite(huge?.p90)).toBe(true);
    expect(huge?.p10 ?? 0).toBeLessThan(huge?.p90 ?? 0);
  });

  it("the ROS total's quantiles are ordered and its mean is the sum of the weeks", async () => {
    const out = await projectPlayers(request({ horizon: "ros", week: 10, final_week: 17 }));
    const ros = out.data.projections[0]?.ros_total;
    const weeks = out.data.projections[0]?.weeks ?? [];
    expect(ros?.mean).toBeCloseTo(
      weeks.reduce((s, w) => s + w.points.mean, 0),
      3,
    );
    expect((ros?.p10 ?? 0) <= (ros?.p50 ?? 0) && (ros?.p50 ?? 0) <= (ros?.p90 ?? 0)).toBe(true);
  });
});

describe("rest of season", () => {
  it("shares ESPN's ROS total over the remaining weeks with a game; the ROS total sums the weeks", async () => {
    const out = await projectPlayers(
      request({
        horizon: "ros",
        week: 5,
        final_week: 17,
        ...at(BEFORE_WEEK_5),
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
        ...at(BEFORE_WEEK_15),
        targets: [
          target({ espn_week: 18, espn_ros: 60, espn_by_week: { "16": 30, "17": Number.NaN } }),
        ],
      }),
    );
    const w = out.data.projections[0]?.weeks;
    expect(w?.map((x) => x.points.mean)).toEqual([18, 30, 12]);
  });

  it("Stage C: ESPN's ROS total runs through NFL week 18 — week 18's game never leaks into the league's weeks", async () => {
    // regression (research 04 §B.1.1): a WR projected 15 every week, first target week 15, ESPN's
    // ROS = weeks 15–18 = 60, the league's final scoring period 17. Before: 15 / 22.5 / 22.5, ROS 60
    const out = await projectPlayers(
      request({
        horizon: "ros",
        week: 15,
        final_week: 17,
        schedule: proSchedule(SEASON, [15, 16, 17, 18]),
        targets: [target({ position: "WR", position_id: 3, espn_week: 15, espn_ros: 60 })],
      }),
    );
    const p = out.data.projections[0];
    expect(p?.weeks.map((w) => w.week)).toEqual([15, 16, 17]);
    for (const w of p?.weeks ?? []) expect(w.points.mean).toBeCloseTo(15, 9);
    expect(p?.ros_total?.mean).toBeCloseTo(45, 3);
  });

  it("Stage C: a full 18-week schedule — the per-game ROS value, the bye at 0, the fantasy weeks' sum only", async () => {
    // week 5, bye week 9, ESPN week 15.9 and ROS 214.99 over 13 games (weeks 5–18): per game after
    // week 5 = (214.99 − 15.9) / 12 = 16.59 (the live fixture's player: E1 showed 18.099 before).
    // fx-10h's clock is Tuesday of week 5, before its games: the total still counts week 5
    const out = await projectPlayers(
      request({
        horizon: "ros",
        week: 5,
        final_week: 17,
        ...at(BEFORE_WEEK_5),
        schedule: proSchedule(
          SEASON,
          Array.from({ length: 18 }, (_, i) => i + 1),
          {
            byes: { "9": [1, 2] },
          },
        ),
        targets: [target({ position: "WR", position_id: 3, espn_week: 15.9, espn_ros: 214.99 })],
      }),
    );
    const p = out.data.projections[0];
    const per = (214.99 - 15.9) / 12;
    expect(p?.weeks.map((w) => w.week)).toEqual(WEEKS.slice(4));
    expect(p?.weeks[0]?.points.mean).toBe(15.9);
    for (const w of p?.weeks.slice(1) ?? [])
      if (w.week === 9) expect(w.points.mean).toBe(0);
      else expect(w.points.mean).toBeCloseTo(per, 2);
    // weeks 5–17 = 15.9 + 11 games (week 9 a bye, week 18 outside the league) — not 214.99
    expect(p?.ros_total?.mean).toBeCloseTo(15.9 + 11 * per, 2);
  });

  it("Stage C: with no game in the schedule the window ends at the season's last NFL week (18; 17 before 2021)", async () => {
    const empty = { games: [], teams: [] };
    const now = await projectPlayers(
      request({
        horizon: "ros",
        week: 15,
        final_week: 17,
        schedule: empty,
        targets: [target({ espn_week: 15, espn_ros: 60 })],
      }),
    );
    expect(now.data.projections[0]?.weeks.map((w) => w.points.mean)).toEqual([15, 15, 15]);
    expect(espnRosLastWeek(empty, 2026)).toBe(18);
    expect(espnRosLastWeek(empty, 2020)).toBe(17);
    expect(espnRosLastWeek(proSchedule(SEASON, [1, 2, 18]), SEASON)).toBe(18);
    expect(espnRosLastWeek(proSchedule(SEASON, WEEKS), SEASON)).toBe(17);
  });

  it("a week horizon shares the ROS total over the whole season left, never one week", async () => {
    const out = await projectPlayers(
      request({
        week: 5,
        ...at(BEFORE_WEEK_5),
        targets: [target({ espn_week: null, espn_ros: 260 })],
      }),
    );
    expect(out.data.projections[0]?.weeks[0]?.points.mean).toBeCloseTo(260 / 12, 3);
    expect(out.data.projections[0]?.ros_total).toBeNull();
  });
});

// --- Stage C round 2: where ESPN's total STARTS ---------------------------------------------------
// The verifier's counter-evidence (recorded leagues, captured after week 4's games with the period
// still 4): ESPN's (1,0) total counts a healthy player's games in weeks 5–18 only (stat 210 = 13),
// so subtracting week 4's projection from it under-valued every later week by ≈ wk4 / 13.
describe("Stage C round 2: ESPN's total counts the games not yet played (the clock, or ESPN's own count)", () => {
  const W18 = Array.from({ length: 18 }, (_, i) => i + 1);
  const full = (byes: Record<string, readonly number[]> = { "9": [1, 2] }) =>
    proSchedule(SEASON, W18, { byes });
  const AFTER_WEEK_5 = "2026-10-06T12:00:00.000Z"; // every week-5 kickoff (Oct 4) is past
  const means = (out: Awaited<ReturnType<typeof projectPlayers>>, i = 0) =>
    out.data.projections[i]?.weeks.map((w) => w.points.mean) ?? [];

  it("after the as-of week's game his projection stays that week's, and the total is shared over the games left — never less his played game", async () => {
    // regression: the recorded post-game state, synthetic — ESPN's ROS 214.99 = his 12 games in weeks
    // 6–18 (bye 9); before: (214.99 − 15.9) / 12 = 16.59 a game, ESPN's own value is 214.99 / 12
    const out = await projectPlayers(
      request({
        horizon: "ros",
        week: 5,
        final_week: 17,
        ...at(AFTER_WEEK_5),
        schedule: full(),
        targets: [target({ position: "WR", position_id: 3, espn_week: 15.9, espn_ros: 214.99 })],
      }),
    );
    const per = 214.99 / 12;
    const m = means(out);
    expect(m[0]).toBe(15.9);
    out.data.projections[0]?.weeks.slice(1).forEach((w) => {
      if (w.week === 9) expect(w.points.mean).toBe(0);
      else expect(w.points.mean).toBeCloseTo(per, 3);
    });
    // weeks 6–17 hold 11 of his 12 remaining games (week 18 is past the league): 214.99 − per
    expect(out.data.projections[0]?.ros_total?.mean).toBeCloseTo(15.9 + 11 * per, 2);
  });

  it("the same numbers before the week's games subtract it: the clock alone moves the start", async () => {
    const pre = await projectPlayers(
      request({
        horizon: "ros",
        week: 5,
        final_week: 17,
        ...at(BEFORE_WEEK_5),
        schedule: full(),
        targets: [target({ espn_week: 20, espn_ros: 20 * 13 })], // weeks 5–18, bye 9
      }),
    );
    expect(means(pre).filter((x) => x !== 0)).toEqual(Array(12).fill(20));
    const post = await projectPlayers(
      request({
        horizon: "ros",
        week: 5,
        final_week: 17,
        ...at(AFTER_WEEK_5),
        schedule: full(),
        targets: [target({ espn_week: 20, espn_ros: 20 * 12 })], // weeks 6–18, bye 9
      }),
    );
    expect(means(post).filter((x) => x !== 0)).toEqual(Array(12).fill(20));
  });

  it("per player: mid-week, a Thursday player's game is out of his total while a Sunday player's is still in", async () => {
    const thursday = Date.UTC(2026, 9, 1, 0, 15); // team 1's week-5 game
    const sched = proSchedule(SEASON, W18, {
      byes: { "9": [1, 2] },
      kickoffMs: (w, home) =>
        w === 5 && home === 1 ? thursday : Date.UTC(2026, 8, 6 + 7 * (w - 1), 17, 0),
    });
    const out = await projectPlayers(
      request({
        horizon: "ros",
        week: 5,
        final_week: 17,
        ...at("2026-10-02T12:00:00.000Z"), // Friday: Thursday night is over, Sunday is ahead
        schedule: sched,
        targets: [
          // team 1 played Thursday: ESPN's 120 is his 12 games in weeks 6–18
          target({ player_id: 1, pro_team_id: 1, espn_week: 9, espn_ros: 120 }),
          // team 3 plays Sunday: ESPN's 130 still holds week 5 (9) — 121 over weeks 6–18 (no bye)
          target({ player_id: 2, pro_team_id: 3, espn_week: 9, espn_ros: 9 + 121 }),
        ],
      }),
    );
    const a = means(out, 0);
    const b = means(out, 1);
    expect(a[0]).toBe(9);
    expect(a[1]).toBeCloseTo(10, 3);
    expect(b[0]).toBe(9);
    expect(b[1]).toBeCloseTo(121 / 13, 3);
  });

  it("a later week asked while this one is unplayed: this week's game stays inside the total, outside the horizon", async () => {
    // Thursday Oct 1: week 5 unplayed; asked for week 6. ESPN's 20 × 13 covers weeks 5–18 (bye 9)
    const out = await projectPlayers(
      request({
        horizon: "ros",
        week: 6,
        final_week: 17,
        ...at(BEFORE_WEEK_5),
        schedule: full(),
        targets: [target({ espn_week: 20, espn_ros: 20 * 13 })],
      }),
    );
    // before: 240 shared over weeks 7–18 (11 games) = 21.8 — week 5's points leaked into the horizon
    expect(means(out).filter((x) => x !== 0)).toEqual(Array(11).fill(20));
  });

  it("ESPN's own game count (stat 210) wins: equal to the games left it agrees with the clock; smaller, his next games read as missed", async () => {
    const base = {
      horizon: "ros" as const,
      week: 5,
      final_week: 17,
      ...at(AFTER_WEEK_5),
      schedule: full(),
    };
    const healthy = await projectPlayers(
      request({
        ...base,
        targets: [target({ espn_week: 15, espn_ros: 15 * 12, espn_ros_games: 12 })],
      }),
    );
    const byClock = await projectPlayers(
      request({ ...base, targets: [target({ espn_week: 15, espn_ros: 15 * 12 })] }),
    );
    expect(means(healthy)).toEqual(means(byClock));
    // injured: ESPN counts 10 of his 12 remaining games — weeks 6 and 7 read as missed
    const hurt = await projectPlayers(
      request({
        ...base,
        targets: [target({ espn_week: 0, espn_ros: 16 * 10, espn_ros_games: 10 })],
      }),
    );
    const m = means(hurt);
    expect(m.slice(0, 3)).toEqual([0, 0, 0]);
    hurt.data.projections[0]?.weeks.slice(3).forEach((w) => {
      if (w.week === 9) expect(w.points.mean).toBe(0);
      else expect(w.points.mean).toBeCloseTo(16, 9);
    });
    expect(
      hurt.data.projections[0]?.assumptions.some(
        (a) => a.text.includes("counts 10 of his games") && a.text.includes("weeks 6, 7"),
      ),
    ).toBe(true);
    // pre-game, the count includes the as-of week: its projection is subtracted, as before
    const pre = await projectPlayers(
      request({
        ...base,
        ...at(BEFORE_WEEK_5),
        targets: [target({ espn_week: 15, espn_ros: 15 * 13, espn_ros_games: 13 })],
      }),
    );
    expect(means(pre).filter((x) => x !== 0)).toEqual(Array(12).fill(15));
  });

  it("an untrustworthy count is ignored: a positive total over 0 games, a non-integer, an impossible count", async () => {
    const base = {
      horizon: "ros" as const,
      week: 5,
      final_week: 17,
      ...at(AFTER_WEEK_5),
      schedule: full(),
    };
    const ref = means(
      await projectPlayers(
        request({ ...base, targets: [target({ espn_week: 15, espn_ros: 180 })] }),
      ),
    );
    for (const games of [0, 11.5, -1, 99])
      expect(
        means(
          await projectPlayers(
            request({
              ...base,
              targets: [target({ espn_week: 15, espn_ros: 180, espn_ros_games: games })],
            }),
          ),
        ),
      ).toEqual(ref);
    // a 0 count with a 0 total is ESPN's word that he plays no more: every week left reads 0
    const none = await projectPlayers(
      request({ ...base, targets: [target({ espn_week: 0, espn_ros: 0, espn_ros_games: 0 })] }),
    );
    expect(means(none).every((x) => x === 0)).toBe(true);
  });

  it("a D/ST's total is a full-season figure: shared over all 17 of its games, whatever the clock", async () => {
    // every recorded D/ST carries stat 210 = 17: ESPN's 17 × 6 = 102 less week 5's 6, over 16 games
    for (const iso of [BEFORE_WEEK_5, AFTER_WEEK_5]) {
      const out = await projectPlayers(
        request({
          horizon: "ros",
          week: 5,
          final_week: 17,
          ...at(iso),
          schedule: full(),
          targets: [target({ position: "D/ST", position_id: 16, espn_week: 6, espn_ros: 102 })],
        }),
      );
      expect(means(out).filter((x) => x !== 0)).toEqual(Array(12).fill(6));
    }
    // ESPN's own count gives the same window
    const counted = await projectPlayers(
      request({
        horizon: "ros",
        week: 5,
        final_week: 17,
        schedule: full(),
        targets: [
          target({
            position: "D/ST",
            position_id: 16,
            espn_week: 6,
            espn_ros: 102,
            espn_ros_games: 17,
          }),
        ],
      }),
    );
    expect(means(counted).filter((x) => x !== 0)).toEqual(Array(12).fill(6));
  });

  it("property: at any clock and any count, the covered weeks' values sum to ESPN's total; a missed game reads 0; a played one keeps the share", async () => {
    const sched = full();
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 17 }),
        fc.integer({ min: 0, max: 160 }),
        fc.option(fc.integer({ min: 0, max: 17 }), { nil: undefined }),
        fc.double({ min: 0, max: 30, noNaN: true }),
        fc.double({ min: 0.5, max: 300, noNaN: true }),
        async (week, steps, games, wk, extra) => {
          // clocks from Sep 1 to mid-January in 18-hour steps (before, during and after any week)
          const nowMs = Date.UTC(2026, 8, 1) + steps * 18 * 3600_000;
          const ros = wk + extra;
          const out = await projectPlayers(
            request({
              horizon: "ros",
              week,
              final_week: 18,
              ...at(new Date(nowMs).toISOString()),
              n_sims: 1000,
              schedule: sched,
              targets: [
                target({
                  position: "WR",
                  position_id: 3,
                  espn_week: wk,
                  espn_ros: ros,
                  ...(games === undefined ? {} : { espn_ros_games: games }),
                }),
              ],
            }),
          );
          const p = out.players[0];
          if (p === undefined) return false;
          const espnOf = new Map(p.weeks.map((w) => [w.week, w.espn]));
          const rw = rosWeeksOf(sched, 1, 18, nowMs);
          const win = rosWindow(rw, { from: week, games: rosGamesOf(games, ros) });
          const known = win.covered.has(week) ? wk : 0;
          const open = win.covered.size - (win.covered.has(week) ? 1 : 0);
          const share = open > 0 ? (ros - known) / open : null;
          let sum = 0;
          for (const x of rw) {
            const covered = win.covered.has(x.week);
            if (covered) sum += x.week < week ? (share ?? 0) : (espnOf.get(x.week) ?? Number.NaN);
            if (x.week < week) continue;
            const v = espnOf.get(x.week) ?? null;
            if (!x.playing) expect(v).toBeNull();
            else if (x.week === week) expect(v).toBe(wk);
            else if (rosMissed(win, x)) expect(v).toBe(0);
            else if (share === null) expect(v).toBeNull();
            else expect(v ?? Number.NaN).toBeCloseTo(share, 9);
          }
          if (share !== null) expect(sum).toBeCloseTo(ros, 6);
          return true;
        },
      ),
      { numRuns: 80 },
    );
  });
});

describe("Stage C round 2: the window functions", () => {
  const wk = (week: number, playing = true, started = false, ahead = false): RosWeek => ({
    week,
    playing,
    started,
    ahead,
  });

  it("rosWindow: the clock's games not yet started; an earlier week only when its kickoff is ahead; ESPN's count = his last games; a D/ST's season", () => {
    const season = [
      wk(1, true, true),
      wk(2, true, false, true), // a week before `from` whose kickoff is ahead (asked about week 3)
      wk(3, true, true), // the as-of week, kicked off
      wk(4, false), // bye
      wk(5),
      wk(6),
    ];
    const clock = rosWindow(season, { from: 3 });
    expect([...clock.covered].sort((a, b) => a - b)).toEqual([2, 5, 6]);
    expect(clock.basis).toBe("remaining_games");
    // a week before `from` with no known kickoff never joins (an unknown schedule never moves it)
    expect([...rosWindow([wk(1), wk(2), wk(3)], { from: 2 }).covered]).toEqual([2, 3]);
    const counted = rosWindow(season, { from: 3, games: 2 });
    expect([...counted.covered].sort((a, b) => a - b)).toEqual([5, 6]);
    expect(counted.basis).toBe("espn_games");
    expect(rosWindow(season, { from: 3, games: 0 }).covered.size).toBe(0);
    expect(rosWindow(season, { from: 3, games: 40 }).basis).toBe("remaining_games");
    const dst = rosWindow(season, { from: 3, full_season: true });
    expect([...dst.covered].sort((a, b) => a - b)).toEqual([1, 2, 3, 5, 6]);
    expect(dst.basis).toBe("full_season");
  });

  it("rosShare and rosWeekValue: the total less the covered weekly values, over the covered weeks left; a missed game 0", () => {
    const covered = new Set([5, 6, 7]);
    expect(rosShare(30, covered, new Map([[5, 6]]))).toBe(12);
    // a weekly value for a week the total no longer counts is never subtracted
    expect(rosShare(30, covered, new Map([[4, 6]]))).toBe(10);
    expect(rosShare(5, covered, new Map([[5, 9]]))).toBe(0);
    expect(rosShare(null, covered, new Map())).toBeNull();
    expect(rosShare(Number.NaN, covered, new Map())).toBeNull();
    expect(rosShare(30, new Set([5]), new Map([[5, 6]]))).toBeNull();
    const counted = { covered: new Set([7]), basis: "espn_games" as const };
    expect(rosWeekValue(counted, wk(6), 9)).toBe(0); // still to come, left out: missed
    expect(rosWeekValue(counted, wk(6, true, true), 9)).toBe(9); // played: the share
    expect(rosWeekValue(counted, wk(7), 9)).toBe(9);
    expect(rosMissed({ covered: new Set([7]), basis: "remaining_games" }, wk(6))).toBe(false);
    expect(rosGamesOf(13, 200)).toBe(13);
    expect(rosGamesOf(0, 0)).toBe(0);
    for (const bad of [0, -1, 2.5, 21, null, undefined]) expect(rosGamesOf(bad, 50)).toBeNull();
  });

  it("rosWeeksOf: bye and no-team weeks never play; a final game or a past kickoff has started; a TBD kickoff is unknown", () => {
    const sched = proSchedule(SEASON, [1, 2, 3], {
      byes: { "2": [1, 2] },
      kickoffMs: (w) => (w === 3 ? null : Date.UTC(2026, 8, 6 + 7 * (w - 1), 17, 0)),
    });
    const now = Date.UTC(2026, 8, 7);
    expect(rosWeeksOf(sched, 1, 4, now)).toEqual([
      { week: 1, playing: true, started: true, ahead: false },
      { week: 2, playing: false, started: false, ahead: false },
      { week: 3, playing: true, started: false, ahead: false },
      { week: 4, playing: true, started: false, ahead: false }, // not in the schedule: assumed
    ]);
    expect(rosWeeksOf(sched, 0, 2, now).every((x) => !x.playing)).toBe(true);
    const official = {
      ...sched,
      games: sched.games.map((g) => (g.week === 3 ? { ...g, stats_official: true } : g)),
    };
    expect(rosWeeksOf(official, 1, 3, now)[2]?.started).toBe(true);
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
    // Stage C round 2: ESPN's own game count rides along when the provider carries it
    expect(targetOf(p, null)).not.toHaveProperty("espn_ros_games");
    expect(targetOf({ ...p, projection_ros_games_espn: 13 }, null).espn_ros_games).toBe(13);
    expect(targetOf({ ...p, projection_ros_games_espn: null }, null).espn_ros_games).toBeNull();
  });
});
