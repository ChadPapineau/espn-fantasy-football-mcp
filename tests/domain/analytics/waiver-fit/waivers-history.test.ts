// waivers-history.test.ts — E5 with the premium fitted from the league's previous seasons (changelog
// R6-3; plan 07 E5): premium_basis league_fitted on the first call, Π and the band the history
// table's, the summary (seasons, n) an assumption; the league's own demand curve prices q_i, p_k_win
// and p_clears_to_fa (basis league_fitted, its interval the curve's ×0.5 / ×1.5 band); and whenever
// the cold start is served E5 says so with the measured miss — both parts cold, the demand part only
// (a runs-fitted premium; FAAB has no premium), only the slope beside the league's own intercept, or
// nothing when the premium and the whole curve are the league's. The P1 layer
// reads the history curve at each rival's own lineup gain when it has no fitted logistic, keeps P0's
// statement in place, and drops the demand part when a logistic is fitted.
import { describe, expect, it } from "vitest";
import { WAIVER_DP } from "../../../../src/domain/analytics/constants.js";
import { fitDemand, type DemandObservation } from "../../../../src/domain/analytics/demand.js";
import { TEXT_CAPS, type Transaction } from "../../../../src/domain/league/types.js";
import { isValidClearsToFa, type WaiversData } from "../../../../src/domain/analytics/types.js";
import {
  COLD_START_REVISIT,
  coldStartNote,
  fitLeaguePremium,
  fitPremiumFromHistory,
  seasonFeedFromTransactions,
} from "../../../../src/domain/analytics/waiver-fit/index.js";
import { analyzeWaivers } from "../../../../src/domain/analytics/waivers.js";
import {
  analyzeWaiversP1,
  type WaiverP1Request,
} from "../../../../src/domain/analytics/waiversP1.js";
import { RIVALS, rivalRoster, waiverRequest } from "../p1-helpers.js";

const DAY = 24 * 3600 * 1000;
const TEAMS = Array.from({ length: 10 }, (_, i) => i + 1);

/** A previous season: 13 weeks × 12 drops, one re-claimed by another team each week. */
function previousSeason(y: number): Transaction[] {
  const out: Transaction[] = [];
  const row = (
    id: string,
    type: string,
    team: number,
    player: number,
    item: "ADD" | "DROP",
    ms: number,
    week: number,
  ): Transaction => ({
    transaction_id: id,
    type,
    status: "EXECUTED",
    team_id: team,
    team_name: null,
    scoring_period: week,
    process_date: new Date(ms).toISOString(),
    proposed_date: null,
    bid_amount: null,
    items: [
      {
        type: item,
        player_id: player,
        name: null,
        from_team_id: item === "DROP" ? team : null,
        to_team_id: item === "ADD" ? team : null,
        from_slot: null,
        to_slot: null,
      },
    ],
    related_transaction_id: null,
    note: null,
  });
  for (let w = 1; w <= 14; w++)
    for (let i = 0; i < 12; i++) {
      const pid = y * 1000 + w * 20 + i;
      const ms = Date.UTC(y, 8, 3, 23) + w * 7 * DAY;
      out.push(row(`d${String(pid)}`, "FREEAGENT", (i % 10) + 1, pid, "DROP", ms, w));
      if (i === 0)
        out.push(row(`c${String(pid)}`, "WAIVER", 2 + (i % 9), pid, "ADD", ms + DAY / 2, w));
    }
  return out;
}

const historyFit = () =>
  fitPremiumFromHistory({
    teams: 10,
    feeds: [2025, 2024].map((s) =>
      seasonFeedFromTransactions({ season: s, transactions: previousSeason(s), teams: TEAMS }),
    ),
    runs: [],
    current: null,
  });

const textsOk = (d: WaiversData): void => {
  expect(d.rec.assumptions.length).toBeLessThanOrEqual(20);
  for (const a of d.rec.assumptions) {
    expect(a.text.length).toBeLessThanOrEqual(TEXT_CAPS.rec_log_text);
    expect(a.revisit_trigger.length).toBeLessThanOrEqual(TEXT_CAPS.rec_log_text);
  }
};
const coldNotes = (d: WaiversData) =>
  d.rec.assumptions.filter((a) => a.revisit_trigger === COLD_START_REVISIT).map((a) => a.text);

describe("E5 (P0) with the premium fitted from the league's previous seasons", () => {
  it("league_fitted from the first call: Π, band and summary from history; the curve prices demand", async () => {
    const fit = historyFit();
    expect(fit.basis).toBe("league_fitted");
    const curve = fit.demand_curve;
    if (curve === null || curve === undefined) throw new Error("no curve");
    const req = waiverRequest();
    const { data } = await analyzeWaivers({ ...req, premium_fit: fit });
    expect(data.premium_basis).toBe("league_fitted");
    const k = data.k ?? 0;
    expect(data.premium).toBeCloseTo(fit.base.premium(k, data.W), 3);
    expect(data.premium_band.low).toBeCloseTo(fit.low.premium(k, data.W), 3);
    expect(data.premium_band.high).toBeCloseTo(fit.high.premium(k, data.W), 3);
    const summary = data.rec.assumptions.find((a) => a.text === fit.summary);
    expect(summary?.text).toContain("seasons 2025, 2024");
    expect(summary?.text).toContain("312 drops");
    // only the slope is still the cold start's (no claims at value in this feed): said, with its miss
    expect(fit.demand_curve?.basis).toBe("intercept");
    expect(coldNotes(data)).toEqual([coldStartNote(false, false, true)]);
    textsOk(data);
    const able = req.rivals.filter((r) => !r.ir_blocked).length;
    const ahead = req.rivals.filter((r) => r.waiver_rank !== null && r.waiver_rank < k).length;
    let waivers = 0;
    for (const c of data.candidates) {
      // E5's per-week rate: s over the candidate's value horizon (K/D-ST: this week + look-ahead 2)
      const kdst = c.position === "K" || c.position === "D/ST";
      const H = kdst ? Math.min(req.weeks.length, 3) : req.weeks.length;
      const r = Math.max(0, c.s) / H;
      const q = Math.min(WAIVER_DP.qCap, curve.q0 + curve.q1 * r);
      for (const qi of c.demand.q_i) expect(qi.p).toBeCloseTo(q, 4);
      if (c.status !== "WAIVERS") continue;
      waivers += 1;
      expect(c.p_clears_to_fa?.basis).toBe("league_fitted");
      expect(c.p_clears_to_fa?.p ?? -1).toBeCloseTo((1 - q) ** able, 4);
      expect(c.p_k_win ?? -1).toBeCloseTo((1 - q) ** ahead, 4);
      if (c.p_clears_to_fa) expect(isValidClearsToFa(c.p_clears_to_fa)).toBe(true);
    }
    expect(waivers).toBeGreaterThan(0);
  });

  it("the cold start says so with its measured miss: both parts, or the demand part under a runs fit", async () => {
    const cold = await analyzeWaivers(waiverRequest());
    expect(cold.data.premium_basis).toBe("cold_start_table");
    expect(coldNotes(cold.data)).toEqual([coldStartNote(true, true)]);
    for (const c of cold.data.candidates)
      if (c.p_clears_to_fa !== null) expect(c.p_clears_to_fa.basis).toBe("cold_start");
    textsOk(cold.data);
    const runs = fitLeaguePremium({
      teams: 10,
      surplus: Array.from({ length: 13 }, () => ({ r: 3 })),
    });
    expect(runs.basis).toBe("league_fitted");
    const r = await analyzeWaivers({ ...waiverRequest(), premium_fit: runs });
    expect(coldNotes(r.data)).toEqual([coldStartNote(false, true)]);
    // a fit for another league size is not used: both parts cold again
    const other = historyFit();
    const o = await analyzeWaivers({ ...waiverRequest(), league_size: 12, premium_fit: other });
    expect(coldNotes(o.data)).toEqual([coldStartNote(true, true)]);
  });

  it("FAAB mode has no premium: only the demand part can be cold", async () => {
    const req = waiverRequest();
    // P0's FAAB slice is the K/D-ST streamers
    const faab = await analyzeWaivers({ ...req, mode: "faab", positions: ["K", "D/ST"] });
    expect(faab.data.mode_used).toBe("faab");
    expect(coldNotes(faab.data)).toEqual([coldStartNote(false, true)]);
  });
});

describe("E5 (P1) with the history curve", () => {
  const rosters = RIVALS.map((r) => ({
    team_id: r.team_id,
    players: rivalRoster(r.team_id, 10, r.team_id % 2 === 0 ? "WR" : null),
  }));
  const p1 = (over: Partial<WaiverP1Request> = {}): WaiverP1Request => ({
    ...waiverRequest(),
    value_basis: "espn_ros",
    ...over,
  });

  it("no fitted logistic: q_i is the history curve at each rival's gain; P(clears) league_fitted; the cold slope said", async () => {
    const fit = historyFit();
    const { data } = await analyzeWaiversP1(p1({ rival_rosters: rosters, premium_fit: fit }));
    const cold = await analyzeWaiversP1(p1({ rival_rosters: rosters }));
    expect(data.premium_basis).toBe("league_fitted");
    expect(coldNotes(data)).toEqual([coldStartNote(false, false, true)]);
    expect(coldNotes(cold.data)).toEqual([coldStartNote(true, true)]);
    expect(
      data.rec.assumptions.some((a) =>
        a.text.startsWith("q_i is the league's previous-season demand curve"),
      ),
    ).toBe(true);
    const wr = data.candidates.find((c) => c.player_id === 101);
    const wrCold = cold.data.candidates.find((c) => c.player_id === 101);
    if (wr?.status === "WAIVERS") {
      expect(wr.p_clears_to_fa?.basis).toBe("league_fitted");
      if (wr.p_clears_to_fa) expect(isValidClearsToFa(wr.p_clears_to_fa)).toBe(true);
    }
    // the history intercept is far below the cold start's: every rival's q is lower
    const q0 = fit.demand_curve?.q0 ?? 1;
    expect(q0).toBeLessThan(WAIVER_DP.q0);
    for (const q of wr?.demand.q_i ?? []) {
      const c = wrCold?.demand.q_i.find((x) => x.team_id === q.team_id);
      if (c !== undefined && c.p > 0) expect(q.p).toBeLessThan(c.p);
    }
    textsOk(data);
  });

  it("a fitted logistic makes the demand part not cold; P0's statement keeps its place", async () => {
    const rows: DemandObservation[] = [];
    for (let i = 0; i < 60; i++)
      rows.push({
        run: `2026-09-${String(10 + (i % 3)).padStart(2, "0")}T07:00:00.000Z`,
        team_id: 2 + (i % 9),
        player_id: 900 + i,
        r: 1 + (i % 5),
        upgrade: i % 4 === 0 ? 4 : 0.2,
        trend: i % 7,
        activity: i % 3,
        claimed: i % 4 === 0,
      });
    const demand = fitDemand(rows);
    expect(demand).not.toBeNull();
    const { data } = await analyzeWaiversP1(p1({ rival_rosters: rosters, demand_fit: demand }));
    expect(coldNotes(data)).toEqual([coldStartNote(true, false)]);
    const p0 = await analyzeWaivers(waiverRequest());
    const at0 = p0.data.rec.assumptions.findIndex((a) => a.revisit_trigger === COLD_START_REVISIT);
    const at1 = data.rec.assumptions.findIndex((a) => a.revisit_trigger === COLD_START_REVISIT);
    expect(at1).toBe(at0);
  });

  it("P1 FAAB: no premium part; the history curve leaves only its slope part; a fitted slope nothing", async () => {
    const req = waiverRequest();
    const faabRules = {
      ...req.rules,
      waiver: { ...req.rules.waiver, uses_budget: true, budget: 100, min_bid: 0 },
    };
    const a = await analyzeWaiversP1(p1({ rules: faabRules, mode: "faab" }));
    expect(coldNotes(a.data)).toEqual([coldStartNote(false, true)]);
    const b = await analyzeWaiversP1(
      p1({ rules: faabRules, mode: "faab", rival_rosters: rosters, premium_fit: historyFit() }),
    );
    expect(coldNotes(b.data)).toEqual([coldStartNote(false, false, true)]);
    // a curve whose slope the data fitted leaves nothing cold
    const fit = historyFit();
    const full = {
      ...fit,
      demand_curve: fit.demand_curve ? { ...fit.demand_curve, basis: "curve" as const } : null,
    };
    const c = await analyzeWaiversP1(p1({ rival_rosters: rosters, premium_fit: full }));
    expect(coldNotes(c.data)).toEqual([]);
    const c0 = await analyzeWaivers({ ...waiverRequest(), premium_fit: full });
    expect(coldNotes(c0.data)).toEqual([]);
  });
});
