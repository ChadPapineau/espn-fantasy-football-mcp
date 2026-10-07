// projection-player-sim.test.ts — E1's P1 `player_sim` basis (plan 10 §3.2 "E1's player_sim basis
// where the opportunity inputs exist"; plan 07 E1; playerSim.ts): with `player_sim: true` an RB/WR/TE
// week whose trailing lines hold ≥ PLAYER_SIM.minGames games gets the volume × efficiency
// distribution around the SAME mean (ESPN's — weight_espn 1.0, ADV OBJ-02); a QB, a player with too
// few games, a ruled-out week and the default request all stay `position_cv`; the result is
// deterministic by seed; `opportunityFromLines` reads volume and efficiency from the stat lines.
import { describe, expect, it } from "vitest";
import {
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
