// waivers-fitted.test.ts — E5 reading the league-fitted premium (plan 10 C5; plan 07 E5
// `premium_basis: "league_fitted"`; ADV OBJ-03 "cold_start_table stays until the league's own feed
// re-solves Π"): with a fitted premium E5 reports league_fitted, its Π and band are the fitted
// table's at E5's own (k, W), the summary is an assumption, and claim ⇔ s ≥ Π still holds outside
// the band; a cold-basis fit or one solved for another league size changes nothing (the latter
// warned). The P1 path passes the fit through.
import { describe, expect, it } from "vitest";
import {
  analyzeWaivers,
  type WaiverCandidateInput,
  type WaiverPlayer,
  type WaiverRequest,
} from "../../../../src/domain/analytics/waivers.js";
import { analyzeWaiversP1 } from "../../../../src/domain/analytics/waiversP1.js";
import { WAIVER_DP } from "../../../../src/domain/analytics/constants.js";
import {
  fitLeaguePremium,
  type SurplusObservation,
} from "../../../../src/domain/analytics/waiver-fit/index.js";
import {
  bare,
  clockAndRng,
  ELIGIBLE,
  instantPacer,
  POSITION_ID,
  referenceRules,
  referenceSlots,
} from "../helpers.js";

const WEEK = 4;
const WEEKS = Array.from({ length: 14 }, (_, i) => WEEK + i); // W = 13
const SLOT = { QB: 0, RB: 2, WR: 4, TE: 6, FLEX: 23, DST: 16, K: 17, BE: 20, IR: 21 } as const;

function p(id: number, position: string, perWeek: number, slot: number): WaiverPlayer {
  return {
    player_id: id,
    gsis_id: null,
    name: bare(`Player ${String(id)}`),
    position,
    position_id: POSITION_ID[position] ?? 1,
    eligible_slot_ids: ELIGIBLE[position] ?? [20],
    injury_status: null,
    pro_team_id: (id % 32) + 1,
    slot_id: slot,
    locked: false,
    droppable: true,
    weekly: WEEKS.map(() => perWeek),
    percent_owned: 10,
  };
}
const c = (id: number, position: string, perWeek: number): WaiverCandidateInput => ({
  ...p(id, position, perWeek, SLOT.BE),
  status: "WAIVERS",
  waiver_process_date: null,
  percent_change: 1,
});
const mine = (): WaiverPlayer[] => [
  p(1, "QB", 18, SLOT.QB),
  p(2, "RB", 14, SLOT.RB),
  p(3, "RB", 10, SLOT.RB),
  p(4, "WR", 12, SLOT.WR),
  p(5, "WR", 8, SLOT.WR),
  p(6, "TE", 8, SLOT.TE),
  p(7, "RB", 7.5, SLOT.FLEX),
  p(8, "D/ST", 7, SLOT.DST),
  p(9, "K", 8, SLOT.K),
  p(10, "RB", 6, SLOT.BE),
  p(11, "WR", 5, SLOT.BE),
  p(12, "WR", 4, SLOT.BE),
  p(13, "TE", 3, SLOT.BE),
  p(14, "RB", 2, SLOT.BE),
];
const CANDIDATES = [c(101, "WR", 14), c(102, "RB", 10.5), c(103, "WR", 8.5), c(104, "WR", 16)];

function request(over: Partial<WaiverRequest> = {}): WaiverRequest {
  return {
    roster: referenceSlots(),
    rules: referenceRules(),
    league_size: 10,
    week: WEEK,
    weeks: WEEKS,
    mine: mine(),
    candidates: CANDIDATES,
    k: 2,
    rivals: Array.from({ length: 9 }, (_, i) => ({
      team_id: i + 2,
      waiver_rank: i < 1 ? 1 : i + 2,
      ir_blocked: false,
    })),
    clock: clockAndRng("2026-10-06T20:00:00.000Z").clock,
    pacer: instantPacer,
    ...over,
  };
}

/** A feed twice as rich as the cold start (two seasons of runs). */
const richFeed: SurplusObservation[] = [15, 15, 10, 6, 3, 1].flatMap((n, i) =>
  Array.from({ length: 2 * n }, () => ({ r: 2 * (WAIVER_DP.rates[i]?.r ?? 0) })),
);

describe("E5 with a league-fitted premium", () => {
  it("reports league_fitted; Π and the band are the fitted table's at E5's own (k, W)", async () => {
    const fit = fitLeaguePremium({ teams: 10, surplus: richFeed });
    expect(fit.basis).toBe("league_fitted");
    const cold = await analyzeWaivers(request());
    const { data } = await analyzeWaivers(request({ premium_fit: fit }));
    expect(data.premium_basis).toBe("league_fitted");
    expect(cold.data.premium_basis).toBe("cold_start_table");
    expect(data.k).toBe(2);
    expect(data.W).toBe(13);
    expect(data.premium).toBeCloseTo(fit.base.premium(2, 13), 3);
    expect(data.premium_band.low).toBeCloseTo(fit.low.premium(2, 13), 3);
    expect(data.premium_band.high).toBeCloseTo(fit.high.premium(2, 13), 3);
    expect(data.premium).toBeGreaterThan(cold.data.premium);
    expect(data.rec.assumptions.some((a) => a.text === fit.summary)).toBe(true);
    // the strike still holds outside the band
    for (const x of data.candidates) {
      if (x.verdict === "claim") expect(x.s).toBeGreaterThanOrEqual(data.premium);
      if (x.s > data.premium_band.high) expect(x.verdict).toBe("claim");
    }
  });

  it("a cold-basis fit changes nothing; a fit for another league size is refused with a warning", async () => {
    const cold = await analyzeWaivers(request());
    const short = fitLeaguePremium({ teams: 10, surplus: richFeed.slice(0, 5) });
    expect(short.basis).toBe("cold_start_table");
    const a = await analyzeWaivers(request({ premium_fit: short }));
    expect(a.data.premium).toBe(cold.data.premium);
    expect(a.data.premium_basis).toBe("cold_start_table");
    const other = fitLeaguePremium({ teams: 12, surplus: richFeed });
    const b = await analyzeWaivers(request({ premium_fit: other }));
    expect(b.data.premium_basis).toBe("cold_start_table");
    expect(b.data.premium).toBe(cold.data.premium);
    expect(b.warnings.some((w) => w.includes("solved for 12 teams, not 10"))).toBe(true);
    const none = await analyzeWaivers(request({ premium_fit: null }));
    expect(none.data.premium).toBe(cold.data.premium);
  });

  it("the P1 engine passes the fitted premium through", async () => {
    const fit = fitLeaguePremium({ teams: 10, surplus: richFeed });
    const { data } = await analyzeWaiversP1({
      ...request({ premium_fit: fit }),
      value_basis: "espn_ros",
    });
    expect(data.premium_basis).toBe("league_fitted");
    expect(data.premium).toBeCloseTo(fit.base.premium(2, 13), 3);
  });
});
