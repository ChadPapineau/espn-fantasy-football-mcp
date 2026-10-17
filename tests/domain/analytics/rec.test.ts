// rec.test.ts — the E12/E13 hooks (plan 07 E12, E13): `informative: false` at weight_espn = 1.0
// (R2 nit 2) and true only below it; ESPN's comparator Dist uses E1's position-CV rule; forecasts in
// the retrospective's shapes; the alternatives an analytics result offers the log; the surface.
import { describe, expect, it } from "vitest";
import * as analytics from "../../../src/domain/analytics/index.js";
import {
  SHIPPED_WEIGHT_ESPN,
  espnBaselineInformative,
  espnComparatorDist,
  lineupAlternatives,
  pActiveForecastsOf,
  playerForecastOf,
  pPlayoffsForecastOf,
  pWinForecastOf,
  waiverAlternatives,
} from "../../../src/domain/analytics/rec.js";
import { projectPlayers } from "../../../src/domain/analytics/projection.js";
import {
  WEIGHT_ESPN_V1,
  type LineupData,
  type SeasonSimData,
  type WaiversData,
} from "../../../src/domain/analytics/types.js";
import {
  bare,
  clockAndRng,
  dist,
  instantPacer,
  proSchedule,
  referenceSettings,
} from "./helpers.js";

describe("E13: the ESPN baseline is not informative in v1", () => {
  it("weight_espn ships at 1.0 and the baseline is informative only below it", () => {
    expect(SHIPPED_WEIGHT_ESPN).toBe(1);
    expect(SHIPPED_WEIGHT_ESPN).toBe(WEIGHT_ESPN_V1);
    expect(espnBaselineInformative()).toBe(false);
    expect(espnBaselineInformative(0.8)).toBe(true);
    expect(espnBaselineInformative(Number.NaN)).toBe(false);
  });

  it("ESPN's comparator is its mean widened by E1's position CV (the QB CV follows the pass-TD value)", () => {
    const s4 = referenceSettings(4);
    const s6 = referenceSettings(6);
    const a = espnComparatorDist(20, "QB", 1, s4);
    const b = espnComparatorDist(20, "QB", 1, s6);
    expect(a?.mean).toBe(20);
    expect((b?.p90 ?? 0) - (b?.p10 ?? 0)).toBeGreaterThan((a?.p90 ?? 0) - (a?.p10 ?? 0));
    expect(espnComparatorDist(null, "QB", 1, s4)).toBeNull();
    expect(espnComparatorDist(Number.NaN, "QB", 1, s4)).toBeNull();
  });
});

describe("forecasts in the retrospective's shapes", () => {
  it("a player forecast pairs our pre-lock Dist with ESPN's comparator and the realised total", async () => {
    const { clock, rng } = clockAndRng();
    const out = await projectPlayers({
      targets: [
        {
          player_id: 9,
          gsis_id: null,
          name: bare("Player 9"),
          position: "WR",
          position_id: 3,
          pro_team_id: 1,
          injury_status: "QUESTIONABLE",
          espn_week: 12,
          espn_ros: null,
          trailing: [],
        },
      ],
      season: 2026,
      horizon: "week",
      week: 5,
      final_week: 17,
      settings: referenceSettings(),
      schedule: proSchedule(2026, [5]),
      clock,
      rng,
      pacer: instantPacer,
      deadline_ms: null,
      n_sims: 1000,
    });
    const p = out.players[0];
    if (p === undefined) throw new Error("no projection");
    const f = playerForecastOf(p, 5, 14.5, referenceSettings());
    expect(f).toMatchObject({
      week: 5,
      player_id: 9,
      position: "WR",
      outcome: 14.5,
      ours_samples: null,
    });
    expect(f?.ours.mean).toBe(12);
    expect(f?.espn?.mean).toBe(12);
    expect(playerForecastOf(p, 6, 14.5, referenceSettings())).toBeNull();
    expect(playerForecastOf(p, 5, null, referenceSettings())).toBeNull();
    const active = pActiveForecastsOf(out.players, 5, new Map([[9, true]]));
    expect(active).toEqual([{ week: 5, p: 0.71, outcome: true }]);
    expect(pActiveForecastsOf(out.players, 5, new Map())).toEqual([]);
  });

  it("P(win) and P(playoffs) rows carry ESPN's number beside ours", () => {
    expect(pWinForecastOf(5, { p_win_after: 0.62 }, 0.58, true)).toEqual({
      week: 5,
      ours: 0.62,
      espn: 0.58,
      outcome: true,
    });
    const season = {
      readings: [{ p_playoffs: 0.8 }],
      playoff_pct_espn: 0.7,
    } as unknown as SeasonSimData;
    expect(pPlayoffsForecastOf(9, season, false)).toEqual({
      week: 9,
      ours: 0.8,
      espn: 0.7,
      outcome: false,
    });
    expect(pPlayoffsForecastOf(9, { readings: [], playoff_pct_espn: null }, false).ours).toBeNull();
  });
});

describe("alternatives for the log (E12)", () => {
  const row = (slot: string, player_id: number, mean: number) => ({
    slot,
    player_id,
    name: bare("a"),
    points: dist(mean),
    lock_at: null,
    percent_started: null,
  });
  const start = (player_id: number, slot: string) => ({
    player_id,
    gsis_id: null,
    role: "start" as const,
    slot,
  });
  const sit = (player_id: number) => ({
    player_id,
    gsis_id: null,
    role: "sit" as const,
    slot: "BE",
  });
  // the current lineup starts QB 1; E2's best-by-mean lineup starts QB 2 instead
  const lineup = (over: { no_move: boolean; subjects: unknown[] }): LineupData =>
    ({
      no_move: over.no_move,
      basis: "position_cv",
      e_points_before: 98,
      e_points_after: 103,
      current_lineup: [row("QB", 1, 20), row("BE", 2, 25)],
      recommended_lineup: [row("QB", 2, 25), row("BE", 1, 20)],
      rec: { distribution: dist(103, 0.2), subjects: over.subjects },
    }) as unknown as LineupData;

  it("a lineup change offers 'keep the current lineup'", () => {
    const alts = lineupAlternatives(lineup({ no_move: false, subjects: [start(2, "QB"), sit(1)] }));
    expect(alts).toHaveLength(1);
    expect(alts[0]).toMatchObject({
      action: "keep the current lineup",
      point_estimate: 98,
      decision_metric_value: 98,
    });
    expect(alts[0]?.subjects).toEqual([start(1, "QB")]);
  });

  it("a no-move that holds a coin flip offers E2's best-by-mean lineup, the coin flip made (R7-1)", () => {
    const alts = lineupAlternatives(lineup({ no_move: true, subjects: [start(1, "QB"), sit(2)] }));
    expect(alts).toHaveLength(1);
    expect(alts[0]).toMatchObject({
      action: "set the best-by-mean lineup, every coin flip made",
      point_estimate: 103,
      decision_metric_value: 103,
    });
    expect(alts[0]?.subjects).toEqual([start(2, "QB"), { ...sit(1), slot: "QB" }]);
  });

  it("nothing to change offers nothing", () => {
    const same = {
      ...lineup({ no_move: true, subjects: [start(1, "QB")] }),
      recommended_lineup: [row("QB", 1, 20), row("BE", 2, 5)],
    } as unknown as LineupData;
    expect(lineupAlternatives(same)).toEqual([]);
  });

  it("a claim offers 'make no claim'", () => {
    const w = { premium: 29.5, rec: { no_move: false } } as unknown as WaiversData;
    expect(waiverAlternatives(w)[0]).toMatchObject({
      action: "make no claim and keep the waiver position",
      decision_metric_value: 0,
    });
    expect(waiverAlternatives({ ...w, rec: { no_move: true } } as unknown as WaiversData)).toEqual(
      [],
    );
  });
});

describe("the public surface", () => {
  it("exports the engines, the DP, the simulator and the hooks", () => {
    for (const name of [
      "projectPlayers",
      "analyzeLineup",
      "simulateSeason",
      "analyzeWaivers",
      "priorityPremium",
      "premiumBand",
      "kdstExpectation",
      "runCooperative",
      "loopPacer",
      "playerForecastOf",
      "espnBaselineInformative",
      "N_SIMS_MAX",
      "WEIGHT_ESPN_V1",
    ])
      expect(analytics, name).toHaveProperty(name);
  });
});
