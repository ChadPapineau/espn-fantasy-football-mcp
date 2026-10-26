// projection-player-sim.test.ts — E1's P1 `player_sim` basis (plan 10 §3.2 "E1's player_sim basis
// where the opportunity inputs exist"; plan 07 E1; playerSim.ts): with `player_sim: true` an RB/WR/TE
// week whose trailing lines hold ≥ PLAYER_SIM.minGames games gets the volume × efficiency
// distribution around the SAME mean (ESPN's — weight_espn 1.0, ADV OBJ-02); a QB, a player with too
// few games, a ruled-out week and the default request all stay `position_cv`; the result is
// deterministic by seed; `opportunityFromLines` reads volume and efficiency from the stat lines.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEADLINE_UNREAD_ASSUMPTION,
  PLAYER_SIM_ANCHOR_FAILED_ASSUMPTION,
  PLAYER_SIM_E1_SAMPLES,
  projectPlayers,
  type ProjectionRequest,
  type ProjectionTarget,
  type TrailingLine,
} from "../../../src/domain/analytics/projection.js";
import { PLAYER_SIM } from "../../../src/domain/analytics/marketConstants.js";
import {
  OPPORTUNITY_WINDOW_GAMES,
  opportunityFromLines,
} from "../../../src/domain/analytics/playerSim.js";
import { asPositionId, type StatLine } from "../../../src/domain/scoring/types.js";
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

function rbLine(week: number, season = SEASON): TrailingLine {
  const values = {
    targets: 4,
    rec: 3,
    rec_yd: 24,
    rec_td: 0,
    rush_att: 16,
    rush_yd: 72,
    rush_td: 1,
    fum_lost: 0,
  };
  const line: StatLine = {
    values,
    present: Object.keys(values).sort(),
    position: asPositionId(2),
    position_class: "O",
    provisional: false,
    source: "nflverse",
  };
  return { season, week, line };
}

function rb(over: Partial<ProjectionTarget> = {}): ProjectionTarget {
  return {
    player_id: 202,
    gsis_id: "00-0000202",
    name: bare("Player 202"),
    position: "RB",
    position_id: POSITION_ID.RB ?? 2,
    pro_team_id: 1,
    injury_status: "ACTIVE",
    espn_week: 14.5,
    espn_ros: 180,
    trailing: [rbLine(1), rbLine(2), rbLine(3), rbLine(4)],
    ...over,
  };
}

function request(over: Partial<ProjectionRequest> = {}): ProjectionRequest {
  const { clock, rng } = clockAndRng();
  return {
    targets: [rb()],
    season: SEASON,
    horizon: "week",
    week: 5,
    final_week: 17,
    settings: referenceSettings(),
    schedule: proSchedule(SEASON, WEEKS, {}),
    clock,
    rng,
    pacer: instantPacer,
    deadline_ms: null,
    n_sims: 2000,
    ...over,
  };
}

const firstWeek = async (r: ProjectionRequest) =>
  (await projectPlayers(r)).players[0]?.weeks[0]?.dist;

describe("E1 player_sim (P1)", () => {
  it("an RB with ≥ 3 trailing games: player_sim around ESPN's mean; the default stays position_cv", async () => {
    const sim = await firstWeek(request({ player_sim: true }));
    const cv = await firstWeek(request());
    expect(sim?.basis).toBe("player_sim");
    expect(cv?.basis).toBe("position_cv");
    expect(sim?.mean).toBe(14.5);
    expect(cv?.mean).toBe(14.5);
    expect(sim?.p10).toBeLessThanOrEqual(sim?.p50 ?? 0);
    expect(sim?.p50).toBeLessThanOrEqual(sim?.p90 ?? 0);
    // deterministic by seed
    expect(await firstWeek(request({ player_sim: true }))).toEqual(sim);
  });

  it("stays position_cv for a QB, under three games, and a ruled-out week", async () => {
    const qb = await firstWeek(
      request({
        player_sim: true,
        targets: [rb({ position: "QB", position_id: POSITION_ID.QB ?? 1 })],
      }),
    );
    expect(qb?.basis).toBe("position_cv");
    const few = await firstWeek(
      request({ player_sim: true, targets: [rb({ trailing: [rbLine(3), rbLine(4)] })] }),
    );
    expect(few?.basis).toBe("position_cv");
    expect(PLAYER_SIM.minGames).toBe(3);
    const out = await firstWeek(
      request({ player_sim: true, targets: [rb({ injury_status: "OUT" })] }),
    );
    expect(out?.mean).toBe(0);
    expect(out?.basis).toBe("position_cv");
  });

  it("only the trailing lines E1 reads count: this season before the week, and the prior season", async () => {
    // three lines of THIS week or later never count
    const future = await firstWeek(
      request({
        player_sim: true,
        targets: [rb({ trailing: [rbLine(5), rbLine(6), rbLine(7)] })],
      }),
    );
    expect(future?.basis).toBe("position_cv");
    const prior = await firstWeek(
      request({
        player_sim: true,
        targets: [rb({ trailing: [rbLine(15, 2025), rbLine(16, 2025), rbLine(17, 2025)] })],
      }),
    );
    expect(prior?.basis).toBe("player_sim");
  });
});

// Stage C finding projection-player-sim-clamp-mean (round 3): v1 clamped the rescale ESPN / simulated
// mean to [1/3, 3] and then served the simulated mean × 3 (or ÷ 3), not ESPN's, while `inputs.weight_espn`
// read 1 — exactly on a role change, where ESPN departs most from the trailing opportunity. A rescale
// the simulation cannot carry now serves no player_sim: the week keeps the positional CV around
// ESPN's mean (v2's anchor_failed rule), and E1 says so.
describe("an anchor the simulation cannot carry (Stage C projection-player-sim-clamp-mean)", () => {
  // a backup's trailing role: 3 carries and 1 target a game (the finding's repro)
  function thinLine(week: number): TrailingLine {
    const values = {
      targets: 1,
      rec: 1,
      rec_yd: 7,
      rec_td: 0,
      rush_att: 3,
      rush_yd: 11,
      rush_td: 0,
      fum_lost: 0,
    };
    const line: StatLine = {
      values,
      present: Object.keys(values).sort(),
      position: asPositionId(2),
      position_class: "O",
      provisional: false,
      source: "nflverse",
    };
    return { season: SEASON, week, line };
  }
  const backup = (espn: number, over: Partial<ProjectionTarget> = {}) =>
    rb({ espn_week: espn, trailing: [1, 2, 3, 4].map(thinLine), ...over });
  const first = async (target: ProjectionTarget, playerSim: boolean) => {
    const out = await projectPlayers(request({ player_sim: playerSim, targets: [target] }));
    const p = out.data.projections[0];
    return { week: p?.weeks[0], assumptions: (p?.assumptions ?? []).map((a) => a.text) };
  };

  it("a promoted backup: ESPN's 14 and 18 are served exactly at weight_espn 1, on the positional CV, said", async () => {
    for (const espn of [14, 18]) {
      const sim = await first(backup(espn), true);
      const cv = await first(backup(espn), false);
      expect(sim.week?.points.mean).toBe(espn);
      expect(sim.week?.points.basis).toBe("position_cv");
      expect(sim.week?.inputs.espn).toBe(espn);
      expect(sim.week?.inputs.weight_espn).toBe(1);
      // the very distribution the default request serves (the same mean, the same spread)
      expect(sim.week?.points).toEqual(cv.week?.points);
      expect(sim.assumptions).toContain(PLAYER_SIM_ANCHOR_FAILED_ASSUMPTION.text);
      expect(cv.assumptions).not.toContain(PLAYER_SIM_ANCHOR_FAILED_ASSUMPTION.text);
    }
  });

  it("a projection far below the trailing role (a starter losing it) is served exactly too", async () => {
    // a lead back's trailing line (≈ 17 points a game) against ESPN's 2: a rescale below 1/3
    const sim = await first(rb({ espn_week: 2 }), true);
    expect(sim.week?.points.mean).toBe(2);
    expect(sim.week?.points.basis).toBe("position_cv");
    expect(sim.assumptions).toContain(PLAYER_SIM_ANCHOR_FAILED_ASSUMPTION.text);
  });

  it("inside the band the simulation stands, at ESPN's mean, and nothing is said", async () => {
    const sim = await first(backup(4), true);
    expect(sim.week?.points.basis).toBe("player_sim");
    expect(sim.week?.points.mean).toBe(4);
    expect(sim.assumptions).not.toContain(PLAYER_SIM_ANCHOR_FAILED_ASSUMPTION.text);
  });

  it("property: whatever the trailing role and ESPN's projection, the first week's mean is ESPN's at weight_espn 1", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 12 }),
        fc.integer({ min: 0, max: 24 }),
        fc.double({ min: 0.1, max: 45, noNaN: true }),
        async (targets, carries, espn) => {
          fc.pre(targets + carries > 0);
          const line = (week: number): TrailingLine => {
            const values = {
              targets,
              rec: Math.round(targets * 0.7),
              rec_yd: Math.round(targets * 6),
              rec_td: 0,
              rush_att: carries,
              rush_yd: Math.round(carries * 4.2),
              rush_td: carries > 10 ? 1 : 0,
              fum_lost: 0,
            };
            return {
              season: SEASON,
              week,
              line: {
                values,
                present: Object.keys(values).sort(),
                position: asPositionId(2),
                position_class: "O",
                provisional: false,
                source: "nflverse",
              },
            };
          };
          const out = await projectPlayers(
            request({
              player_sim: true,
              n_sims: 1000,
              targets: [rb({ espn_week: espn, trailing: [1, 2, 3, 4].map(line) })],
            }),
          );
          const w = out.data.projections[0]?.weeks[0];
          return (
            w?.points.mean === Math.round(espn * 10_000) / 10_000 && w.inputs.weight_espn === 1
          );
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe("E1 player_sim cost bound", () => {
  it("only the first target week of a ROS horizon is simulated; later weeks keep position_cv", async () => {
    const out = await projectPlayers(request({ player_sim: true, horizon: "ros" }));
    const weeks = out.players[0]?.weeks ?? [];
    expect(weeks.length).toBeGreaterThan(5);
    expect(weeks[0]?.dist.basis).toBe("player_sim");
    for (const w of weeks.slice(1)) expect(w.dist.basis).toBe("position_cv");
    expect(PLAYER_SIM_E1_SAMPLES).toBe(1000);
  });
});

// Stage C finding analytics-cpu-deadline-per-run (round 2, the verifier at 30× emulated CPU): the
// set-up (every trailing line scored) and the summaries (a sort per player-week, the player_sim
// simulation) ran with no deadline, so E1 passed 8 s on a slow CPU however early the sampler
// stopped. One budget now runs through the three phases; past it the work is thin, never skipped.
describe("one CPU budget through E1's set-up, sampling and summaries", () => {
  const roster = Array.from({ length: 30 }, (_, i) =>
    rb({ player_id: 300 + i, gsis_id: `00-0000${String(300 + i)}` }),
  );

  it("past it: the rest are planned without their trailing line and summarised without player_sim — every player answered, said", async () => {
    const out = await projectPlayers(
      request({ targets: roster, player_sim: true, pacer: steppingPacer(1), deadline_ms: 6 }),
    );
    expect(out.data.projections).toHaveLength(30);
    expect(out.partial).toBe(true);
    expect(
      out.warnings.filter((w) =>
        /^partial: \d+ of 30 players' trailing lines read before the CPU deadline \(the rest: ESPN's mean with the position's spread\)$/.test(
          w,
        ),
      ),
    ).toHaveLength(1);
    const thin = out.data.projections.filter((p) =>
      p.assumptions.some((a) => a.text === DEADLINE_UNREAD_ASSUMPTION.text),
    );
    expect(thin.length).toBeGreaterThan(0);
    expect(thin.length).toBeLessThan(30);
    for (const p of thin) {
      // no trailing line was scored: ESPN's mean, no own number, no role sample
      expect(p.role_confidence_games).toBe(0);
      expect(p.weeks[0]?.points.mean).toBe(14.5);
      expect(p.weeks[0]?.inputs.own).toBeNull();
      expect(p.assumptions.some((a) => a.text.startsWith("no trailing nflverse line"))).toBe(false);
    }
    expect(
      out.warnings.filter((w) =>
        /^partial: \d+ of 30 players summarised from every sample before the CPU deadline/.test(w),
      ),
    ).toHaveLength(1);
    // summarised thin: the position's spread, no player_sim simulation
    expect(out.data.projections.some((p) => p.weeks[0]?.points.basis === "position_cv")).toBe(true);
  });

  it("no CPU left at all: every plan is thin; off: every line read, every simulation run, nothing said", async () => {
    const none = await projectPlayers(
      request({ targets: roster.slice(0, 5), player_sim: true, deadline_ms: 0 }),
    );
    expect(none.partial).toBe(true);
    expect(
      none.data.projections.every((p) =>
        p.assumptions.some((a) => a.text === DEADLINE_UNREAD_ASSUMPTION.text),
      ),
    ).toBe(true);
    const off = await projectPlayers(request({ targets: roster, player_sim: true }));
    expect(off.partial).toBe(false);
    expect(off.warnings.filter((w) => w.startsWith("partial:"))).toEqual([]);
    expect(off.data.projections.every((p) => p.weeks[0]?.points.basis === "player_sim")).toBe(true);
    expect(off.data.projections.every((p) => p.role_confidence_games === 4)).toBe(true);
  });
});

describe("opportunityFromLines", () => {
  it("per-game volume and efficiency over the most recent window", () => {
    const o = opportunityFromLines("RB", 2, [rbLine(1), rbLine(2), rbLine(3)]);
    expect(o).toEqual({
      position: "RB",
      position_id: 2,
      games: 3,
      targets_pg: 4,
      carries_pg: 16,
      catch_rate: 0.75,
      yards_per_reception: 8,
      yards_per_carry: 4.5,
      td_per_target: 0,
      td_per_carry: 1 / 16,
    });
    const many = Array.from({ length: 10 }, (_, i) => rbLine(i + 1));
    expect(opportunityFromLines("WR", 3, many)?.games).toBe(OPPORTUNITY_WINDOW_GAMES);
  });

  it("null for an uncovered position or no line; null rates on zero denominators", () => {
    expect(opportunityFromLines("QB", 1, [rbLine(1)])).toBeNull();
    expect(opportunityFromLines("RB", 2, [])).toBeNull();
    const zero: TrailingLine = {
      ...rbLine(1),
      line: { ...rbLine(1).line, values: { targets: 0, rush_att: 0 } },
    };
    const o = opportunityFromLines("TE", 4, [zero]);
    expect([o?.catch_rate, o?.yards_per_carry, o?.td_per_target]).toEqual([null, null, null]);
  });
});
