// waivers-p1.test.ts — E5 at P1 (plan 07 E5; plan 10 B3 and B4 hard parts) on the reference-format
// scenario of waivers.test.ts: with nothing new the P1 layer reproduces P0 exactly; with E1's values
// `value_basis` flips to `ensemble` and the Π rule still holds for every candidate (claim ⇔ s ≥ Π
// outside the band, `marginal` inside it and never in claim_list); every signal cites a numeric
// evidence and `percent_change` never moves a signal; the per-rival demand (each rival's own lineup
// gain, or the fitted model) drives q_i, P(clears) and the pass / fa_add_after_run split only;
// `learned.*` flips from null when the feed shows the case; `mode: faab` bids instead of a premium.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { analyzeWaivers } from "../../../src/domain/analytics/waivers.js";
import {
  analyzeWaiversP1,
  waiverActionText,
  type WaiverP1Request,
} from "../../../src/domain/analytics/waiversP1.js";
import { fitDemand, type DemandObservation } from "../../../src/domain/analytics/demand.js";
import {
  hasNumericEvidence,
  type SignalInput,
} from "../../../src/domain/analytics/usageSignals.js";
import { isValidClearsToFa, type WaiversData } from "../../../src/domain/analytics/types.js";
import { WAIVERS } from "../../../src/domain/analytics/constants.js";
import { proSchedule, referenceRules, referenceSettings } from "./helpers.js";
import { RIVALS, WEEKS, rivalRoster, waiverRequest, wc } from "./p1-helpers.js";

const p1 = (over: Partial<WaiverP1Request> = {}): WaiverP1Request => ({
  ...waiverRequest(),
  value_basis: "espn_ros",
  ...over,
});

/** Usage that fires a snap jump and an xFP gap for a candidate. */
const risingUsage: SignalInput = {
  position: "WR",
  games: [
    { week: 1, snap_pct: 0.4, target_share: 0.1, rz_share: 0.05, xfp: 9, points: 5 },
    { week: 2, snap_pct: 0.42, target_share: 0.11, rz_share: 0.05, xfp: 9, points: 5 },
    { week: 3, snap_pct: 0.7, target_share: 0.2, rz_share: 0.2, xfp: 14, points: 8 },
    { week: 4, snap_pct: 0.75, target_share: 0.22, rz_share: 0.22, xfp: 15, points: 9 },
  ],
  depth: { rank_now: 2, rank_before: 3 },
};

/** Every candidate obeys the P0 priority rule (plan 10 B3: "the Π rule still holds"). */
function piRuleHolds(d: WaiversData): boolean {
  return d.candidates.every((x) => {
    if (x.s <= 0) return x.verdict === "pass";
    if (x.status === "FREEAGENT") return x.verdict === "fa_add_now";
    const inside = x.s >= d.premium_band.low && x.s <= d.premium_band.high;
    if (inside)
      return (
        x.verdict === "marginal" &&
        !d.claim_list.includes(x.player_id) &&
        d.marginal.includes(x.player_id)
      );
    if (x.s >= d.premium) return x.verdict === "claim" && d.claim_list.includes(x.player_id);
    return (
      (x.verdict === "pass" || x.verdict === "fa_add_after_run") &&
      !d.claim_list.includes(x.player_id)
    );
  });
}

describe("P1 with nothing new reproduces P0", () => {
  it("same verdicts, lists, premium, demand and action text", async () => {
    const p0 = await analyzeWaivers(waiverRequest());
    const out = await analyzeWaiversP1(p1());
    const { rec: r0, ...d0 } = p0.data;
    const { rec: r1, ...d1 } = out.data;
    // the one P1 difference: P0's K/D-ST stream signal gains its numeric evidence (plan 10 B3)
    const noEvidence = (d: typeof d1) => ({
      ...d,
      candidates: d.candidates.map((c) => ({
        ...c,
        signals: c.signals.map((x) => ({ kind: x.kind, value: x.value })),
      })),
    });
    expect(noEvidence(d1)).toEqual(noEvidence(d0));
    const k = d1.candidates.find((c) => c.player_id === 106);
    expect(k?.signals).toEqual([{ kind: "stream", value: 6, evidence: 6 }]);
    expect(d0.candidates.find((c) => c.player_id === 106)?.signals[0]?.evidence).toBeUndefined();
    expect(r1.action).toBe(r0.action);
    expect(r1.subjects).toEqual(r0.subjects);
    expect(r1.no_move).toBe(r0.no_move);
    expect(r1.latest_execution_time).toBe(r0.latest_execution_time);
    expect(r1.assumptions.slice(0, r0.assumptions.length)).toEqual(r0.assumptions);
  });
  it("waiverActionText matches the P0 template for every count combination", () => {
    expect(waiverActionText(0, 0, 0, 0, "pre_run")).toBe("no claim clears the premium");
    expect(waiverActionText(1, 0, 0, 0, "pre_run")).toBe("submit 1 ordered claim");
    expect(waiverActionText(2, 1, 1, 2, "pre_run")).toBe(
      "submit 2 ordered claims; add 1 free agent now; 1 marginal (your call); 2 on the scramble list after the run",
    );
    expect(waiverActionText(0, 0, 2, 1, "post_run")).toBe("no clear move: 2 marginal (your call)");
    expect(waiverActionText(0, 2, 0, 0, "post_run")).toBe("add 2 free agents now");
  });
});

describe("plan 10 B3 hard: value_basis ensemble, the Π rule, numeric evidence, percent_change", () => {
  const usage = new Map<number, SignalInput>([
    [101, risingUsage],
    [102, { ...risingUsage, position: "RB" }],
    [103, { ...risingUsage, implied: { this_week: 28, season_mean: 22 } }],
  ]);
  it("value_basis flips to ensemble; the Π rule holds for every candidate; every signal is numeric", async () => {
    const { data } = await analyzeWaiversP1(p1({ value_basis: "ensemble", usage }));
    expect(data.value_basis).toBe("ensemble");
    expect(data.premium_basis).toBe("cold_start_table");
    expect(piRuleHolds(data)).toBe(true);
    const signalled = data.candidates.filter((c) => c.signals.length > 0);
    // 106 is a kicker: the K/D-ST stream signal
    expect(signalled.map((c) => c.player_id).sort()).toEqual([101, 102, 103, 106]);
    for (const c of data.candidates) expect(c.signals.every(hasNumericEvidence)).toBe(true);
    expect(data.candidates.find((c) => c.player_id === 103)?.signals.map((s) => s.kind)).toContain(
      "implied_total",
    );
  });
  it("percent_change never appears in signals: changing it changes no signal", async () => {
    const a = await analyzeWaiversP1(p1({ value_basis: "ensemble", usage }));
    const b = await analyzeWaiversP1(
      p1({
        value_basis: "ensemble",
        usage,
        candidates: waiverRequest().candidates.map((c) => ({ ...c, percent_change: 97.5 })),
      }),
    );
    const sig = (d: WaiversData) => d.candidates.map((c) => [c.player_id, c.signals]);
    expect(sig(b.data)).toEqual(sig(a.data));
    expect(b.data.candidates.every((c) => c.demand.percent_change === 97.5)).toBe(true);
  });
  it("property: for any candidate values and usage, the rule and the evidence hold", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.double({ min: 0, max: 25, noNaN: true }), { minLength: 1, maxLength: 5 }),
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 4, maxLength: 6 }),
        fc.double({ min: -100, max: 100, noNaN: true }),
        async (vals, snaps, pct) => {
          const cands = vals.map((v, i) =>
            wc(200 + i, i % 2 === 0 ? "WR" : "RB", v, "WAIVERS", { percent_change: pct }),
          );
          const use = new Map<number, SignalInput>(
            cands.map((c) => [
              c.player_id,
              {
                position: c.position,
                games: snaps.map((s, w) => ({
                  week: w + 1,
                  snap_pct: s,
                  target_share: s / 3,
                  rz_share: s / 4,
                  xfp: 10 * s,
                  points: 5,
                })),
              },
            ]),
          );
          const { data } = await analyzeWaiversP1(
            p1({ value_basis: "ensemble", usage: use, candidates: cands }),
          );
          return (
            data.value_basis === "ensemble" &&
            piRuleHolds(data) &&
            data.candidates.every((c) => c.signals.every(hasNumericEvidence))
          );
        },
      ),
      { numRuns: 25 },
    );
  });
  it("the K/D-ST stream signal gains its numeric evidence", async () => {
    const schedule = proSchedule(2026, [...WEEKS]);
    const implied = WEEKS.flatMap((w) =>
      Array.from({ length: 32 }, (_, i) => ({
        week: w,
        pro_team_id: i + 1,
        implied: 16 + ((i * 7 + w) % 14),
      })),
    );
    const { data } = await analyzeWaiversP1(
      p1({
        positions: ["K", "D/ST"],
        settings: referenceSettings(),
        kdst: { schedule, implied_totals: implied },
        candidates: Array.from({ length: 6 }, (_, i) =>
          wc(300 + i, i % 2 === 0 ? "D/ST" : "K", 6, "FREEAGENT", { pro_team_id: i + 3 }),
        ),
      }),
    );
    const streams = data.candidates.flatMap((c) => c.signals).filter((s) => s.kind === "stream");
    expect(streams.length).toBeGreaterThan(0);
    expect(streams.every(hasNumericEvidence)).toBe(true);
  });
});

describe("the demand model per rival (research 05 §1.3)", () => {
  const rosters = RIVALS.map((r) => ({
    team_id: r.team_id,
    players: rivalRoster(r.team_id, 10, r.team_id % 2 === 0 ? "WR" : null),
  }));
  it("each rival's own lineup gain: WR-thin rivals are upgraded by the WR, q_i differs by rival", async () => {
    const { data } = await analyzeWaiversP1(p1({ rival_rosters: rosters }));
    const wr = data.candidates.find((c) => c.player_id === 101);
    expect(wr?.demand.rivals_upgraded.length).toBeGreaterThan(0);
    const qs = new Set(wr?.demand.q_i.map((q) => q.p));
    expect(qs.size).toBeGreaterThan(1);
    expect(piRuleHolds(data)).toBe(true);
    for (const c of data.candidates) {
      if (c.p_clears_to_fa !== null) expect(isValidClearsToFa(c.p_clears_to_fa)).toBe(true);
      if (c.status === "WAIVERS" && c.s > 0 && c.verdict !== "claim" && c.verdict !== "marginal")
        expect(c.verdict).toBe(
          (c.p_clears_to_fa?.p ?? 0) >= WAIVERS.faAfterRunMinClear ? "fa_add_after_run" : "pass",
        );
    }
    for (const id of data.scramble_list) {
      const c = data.candidates.find((x) => x.player_id === id);
      expect(
        c?.status === "WAIVERS" &&
          c.verdict !== "pass" &&
          (c.p_clears_to_fa?.p ?? 0) >= WAIVERS.scrambleMinClear,
      ).toBe(true);
    }
  });
  it("an IR-blocked rival never claims (q = 0) and the ahead-of-me product gives p_k_win", async () => {
    const rivals = RIVALS.map((r) => ({ ...r, ir_blocked: r.team_id === 2 }));
    const { data } = await analyzeWaiversP1(p1({ rivals, rival_rosters: rosters }));
    const wr = data.candidates.find((c) => c.player_id === 101);
    expect(wr?.demand.q_i.find((q) => q.team_id === 2)?.p).toBe(0);
    expect(wr?.demand.rivals_ir_blocked).toEqual([2]);
    // only team 2 ranks ahead of me (k = 2) and it is blocked → nobody ahead can claim
    expect(wr?.p_k_win).toBe(1);
  });
  it("a fitted model: league_fitted P(clears) with a valid interval; Sleeper trend reported", async () => {
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
    const fit = fitDemand(rows);
    expect(fit).not.toBeNull();
    const { data } = await analyzeWaiversP1(
      p1({
        rival_rosters: rosters,
        demand_fit: fit,
        activity: new Map([[3, 2]]),
        sleeper_trend: new Map([[101, 1234]]),
      }),
    );
    const wr = data.candidates.find((c) => c.player_id === 101);
    expect(wr?.p_clears_to_fa?.basis).toBe("league_fitted");
    if (wr?.p_clears_to_fa) expect(isValidClearsToFa(wr.p_clears_to_fa)).toBe(true);
    expect(wr?.demand.sleeper_trend).toBe(1234);
    expect(wr?.demand.competition_signal).toBe(true);
    expect(piRuleHolds(data)).toBe(true);
    expect(data.rec.assumptions.some((a) => a.text.startsWith("q_i is fitted"))).toBe(true);
  });
});

describe("learned.* (plan 07 §6 clean negatives; plan 10 B4)", () => {
  it("null until the feed shows the case, then the learned value", async () => {
    const none = await analyzeWaiversP1(p1());
    expect(none.data.learned).toEqual({
      second_claim_at_new_position: null,
      unowned_to_waivers_at_kickoff: null,
      order_reset_rule: null,
    });
    const shown = await analyzeWaiversP1(
      p1({
        mechanics: {
          second_claim_at_new_position: true,
          waiver_rank_moves_on_success: true,
          evidence: {
            runs: 2,
            pairs: 1,
            new_position_cases: 1,
            old_position_cases: 0,
            moved_cases: 3,
            stayed_cases: 0,
          },
        },
        kickoff_waivers: true,
      }),
    );
    expect(shown.data.learned).toEqual({
      second_claim_at_new_position: true,
      unowned_to_waivers_at_kickoff: true,
      order_reset_rule: "move_to_last",
    });
  });
});

describe("mode: faab (P1)", () => {
  const faabRules = referenceRules({ uses_budget: true, order_reset: true });
  const rosters = RIVALS.map((r) => ({
    team_id: r.team_id,
    players: rivalRoster(r.team_id, 10, "WR"),
  }));
  it("no premium, a bid per open candidate, claims ranked by expected net, data.faab for the top claim", async () => {
    const out = await analyzeWaiversP1(
      p1({
        rules: faabRules,
        rival_rosters: rosters,
        faab: {
          my_budget: 60,
          rival_budgets: new Map(RIVALS.map((r) => [r.team_id, 40 + r.team_id])),
          history: [
            { bid: 12, value: 20 },
            { bid: 30, value: 45 },
          ],
        },
      }),
    );
    const d = out.data;
    expect(d.mode_used).toBe("faab");
    expect(d.premium).toBe(0);
    expect(d.premium_band).toEqual({ low: 0, high: 0 });
    expect(d.k).toBe(2);
    expect(d.W).toBe(13);
    const open = d.candidates.filter((c) => c.status === "WAIVERS" && c.s > 0);
    expect(open.length).toBeGreaterThan(0);
    for (const c of open) {
      expect(c.bid).not.toBeNull();
      expect(c.p_k_win).toBe(c.bid?.p_win);
      expect(c.verdict === "claim").toBe((c.bid?.expected_net ?? 0) > 0);
    }
    const claims = d.claim_list.map((id) => d.candidates.find((c) => c.player_id === id));
    const nets = claims.map((c) => c?.bid?.expected_net ?? 0);
    expect([...nets].sort((a, b) => b - a)).toEqual(nets);
    expect(claims.map((c) => c?.claim_rank)).toEqual(claims.map((_, i) => i + 1));
    expect(d.faab).not.toBeNull();
    expect(d.faab?.b_star).toBe(claims[0]?.bid?.b_star);
    expect(d.faab?.dollars_per_point.n).toBe(2);
    expect(d.faab?.lambda).toBeGreaterThan(0);
    expect(d.rec.action.startsWith("bid on")).toBe(true);
    expect(d.rec.assumptions.some((a) => a.text.startsWith("last in the order"))).toBe(false);
    expect(d.rec.assumptions.some((a) => a.text.startsWith("FAAB: first-price"))).toBe(true);
    expect(d.marginal).toEqual([]);
  });
  it("auto mode follows uses_budget; an unknown budget is said; nothing worth a bid → no move", async () => {
    const out = await analyzeWaiversP1(p1({ rules: faabRules, candidates: [wc(106, "K", 6)] }));
    expect(out.data.mode_used).toBe("faab");
    expect(out.data.faab).toBeNull();
    expect(out.data.rec.no_move).toBe(true);
    expect(out.data.rec.action).toBe("no bid has a positive expected value");
    expect(
      out.data.rec.assumptions.some((a) => a.text.startsWith("my remaining budget is unknown")),
    ).toBe(true);
  });
  it("FAAB works for every position (P0 refused it outside K/D-ST)", async () => {
    await expect(analyzeWaivers(waiverRequest({ rules: faabRules }))).rejects.toMatchObject({
      code: "not_in_phase",
    });
    const out = await analyzeWaiversP1(p1({ rules: faabRules }));
    expect(out.data.mode_used).toBe("faab");
    expect(out.data.candidates.some((c) => c.position === "WR" && c.verdict === "claim")).toBe(
      true,
    );
  });
});
