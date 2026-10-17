// lineup-history.test.ts — plan 10 C2 on the held-out seasons (league-b 2024 and 2025, recorded
// keyless; tests/domain/analytics/calibration/helpers/history.ts): every complete team-week replayed
// through the shipped E1 + E2 on both toolsets' distributions — `core`'s position_cv and what `full`
// serves since Phase 3 (v2-opportunity's first-week Dist for every QB/RB/WR/TE it models, else the
// Phase 2 basis; helpers/v2-history.ts assembles v2's request as the store does). Hard: ≥ 2 held-out
// seasons; hindsight ≥ every rule; the `full` replay really is v2-served (QBs included); E2 `auto`
// regret below "start by last week's points" in every season and never above "start by ESPN's
// projection" — identical lineups on BOTH bases, because every served mean is ESPN's (weight_espn
// 1.0, ADV OBJ-02; plan 10 A11a / R2 nit 2's structure, asserted here as the reason, not observed by
// chance); the switch evidence recomputed from the `full` replay equals the committed record and the
// decision follows SWITCH_RULE, so `auto` resolves as the record says; P(win) of the lineups as
// played is never statistically miscalibrated (family-wise) and never a resolvable ±5 miss.
// Reported (docs/evals/phase3-startsit.md, held equal): the regret tables, the literal ±5 status per
// basis, the "did it matter" shares. Stage C (changelog R6-2, the named `p_win_after` finding): every
// head-to-head side has its mirror; both P(win) families — E2's own `p_win_after` included — sit
// inside a calibrated forecaster's sampling distribution of the reliability term (seeded, one draw
// per matchup) and their margins are neither regressed toward 0 nor mis-spread; the optimiser's
// selection bias is real in level but appears on both sides of E2's counterfactual, so it cancels.
// Stage C (changelog R7-1): every C2 clause above judges E2's assignment (`rec.lineup`), which the
// no-move rule leaves unchanged; the lineup E2 tells the user to set ("keep unless outside the
// band") is replayed beside it — structurally the manager's lineup with only decisive changes made
// (hard), its regret reported (soft, the `keep-band` section).
import { beforeAll, describe, expect, it } from "vitest";
import {
  OBJECTIVE_SWITCH_RECORD,
  START_SIT_RULES,
  beatsInEverySeason,
  compareRegret,
  decideObjectiveSwitch,
  noWorseInEverySeason,
  reliabilityByDecile,
  switchEvidenceOf,
  type StartSitRow,
} from "../../src/domain/analytics/calibration/index.js";
import { heldOutSeasons } from "../domain/analytics/calibration/helpers/history.js";
import {
  replayHistory,
  type HistoryReplay,
} from "../domain/analytics/calibration/helpers/replay-history.js";
import {
  baselineSection,
  calibrationSection,
  coverageSection,
  didItMatterSection,
  docSection,
  familyMargins,
  familyNull,
  keepBandCounts,
  keepBandSection,
  oneSidePerMatchup,
  pwinAfterSection,
  pwinPairs,
  regretSection,
  selectionLevel,
  switchSection,
  writeDocSection,
} from "../domain/analytics/calibration/helpers/startsit-report.js";

let cv: HistoryReplay;
let full: HistoryReplay;

const allSimLineups = (rp: HistoryReplay): number =>
  rp.rows.filter((r) => r.basis === "player_sim").length;

const sections = (): Record<string, string> => {
  const both = [cv, full];
  const evidence = switchEvidenceOf(full.rows);
  return {
    coverage: coverageSection(both),
    regret: regretSection(both),
    baselines: baselineSection(both),
    switch: switchSection(
      evidence,
      decideObjectiveSwitch(evidence),
      allSimLineups(full),
      full.rows.length,
    ),
    calibration: calibrationSection(both),
    "pwin-after": pwinAfterSection(both),
    matter: didItMatterSection(both),
    "keep-band": keepBandSection(both),
  };
};

beforeAll(async () => {
  cv = await replayHistory("position_cv");
  full = await replayHistory("full");
  if (process.env.UPDATE_EVALS === "1")
    for (const [name, body] of Object.entries(sections())) writeDocSection(name, body);
}, 900_000);

describe("C2 start/sit on the held-out seasons", () => {
  it("replays ≥ 2 held-out seasons, every complete team-week of every scoring period", () => {
    expect(heldOutSeasons().length).toBeGreaterThanOrEqual(2);
    for (const rp of [cv, full]) {
      expect(rp.seasons.map((s) => s.season)).toEqual(heldOutSeasons());
      for (const s of rp.seasons) {
        // ten teams × 17 scoring periods = 170 team-weeks, less the withheld ones
        expect(s.rows.length + s.skipped_incomplete).toBe(170);
        expect(s.rows.length).toBeGreaterThanOrEqual(150);
        expect(new Set(s.rows.map((r) => r.week)).size).toBe(17);
      }
      expect(rp.rows.filter((r) => r.h2h?.outcome_played != null).length).toBeGreaterThanOrEqual(
        250,
      );
    }
  });

  it("(hard) the `full` replay is what full serves: v2-opportunity on most rostered QB/RB/WR/TE weeks, QBs included; core never", () => {
    for (const s of full.seasons) {
      expect(s.v2_weeks).toBeGreaterThanOrEqual(1500);
      expect(s.v2_qb_weeks).toBeGreaterThanOrEqual(200);
      expect(s.v2_weeks).toBeLessThanOrEqual(s.player_sim_weeks);
    }
    for (const s of cv.seasons) {
      expect(s.v2_weeks).toBe(0);
      expect(s.player_sim_weeks).toBe(0);
    }
  });

  it("(hard) the hindsight-best lineup out-scores every rule on every team-week", () => {
    for (const rp of [cv, full])
      for (const r of rp.rows)
        for (const rule of START_SIT_RULES) {
          const x = r.realised[rule];
          if (x !== null) expect(r.realised.hindsight ?? 0).toBeGreaterThanOrEqual(x - 1e-9);
        }
  });

  it("(hard) E2 auto's regret is below 'start by last week's points' in every season, on both bases", () => {
    for (const rp of [cv, full]) {
      const c = compareRegret(rp.rows, "auto", "last_week", { from_week: 2 });
      expect(c.by_season.length).toBeGreaterThanOrEqual(2);
      expect(beatsInEverySeason(c)).toBe(true);
    }
  });

  it("(hard) E2 auto's regret is never above 'start by ESPN's projection'; on both bases every served mean is ESPN's, so the lineups are identical (weight_espn 1.0)", () => {
    for (const rp of [cv, full]) {
      // the reason: no player_sim mean departs from ESPN's projection (position_cv is ESPN's by
      // construction), so E2's mean-objective lineup is the same assignment by the same numbers
      for (const s of rp.seasons) expect(s.player_sim_off_espn).toBe(0);
      expect(noWorseInEverySeason(compareRegret(rp.rows, "auto", "espn_projection"))).toBe(true);
      const c = compareRegret(rp.rows, "auto", "espn_projection");
      expect(c.pooled.identical).toBe(c.pooled.n);
      expect(c.pooled.diff).toBe(0);
    }
  });

  it("(hard) the switch evidence recomputed from the `full` replay equals the committed record", () => {
    const evidence = switchEvidenceOf(full.rows);
    const why = `E1/E2 changed since the record: review, then set OBJECTIVE_SWITCH_RECORD (src/domain/analytics/calibration/objectiveSwitch.ts) to evidence ${JSON.stringify(evidence)} and decision ${JSON.stringify(decideObjectiveSwitch(evidence))}`;
    expect(evidence, why).toEqual(OBJECTIVE_SWITCH_RECORD.evidence);
    expect(decideObjectiveSwitch(evidence), why).toEqual(OBJECTIVE_SWITCH_RECORD.decision);
  });

  it("(hard) auto resolves as the committed record says on every replayed team-week", () => {
    const expected = OBJECTIVE_SWITCH_RECORD.decision.switch ? "pwin" : "mean";
    for (const rp of [cv, full])
      for (const r of rp.rows)
        expect(r.objective_auto).toBe(r.basis === "player_sim" ? expected : "mean");
  });

  it("(hard) P(win) of the lineups as played is never miscalibrated beyond what the sample resolves", () => {
    for (const rp of [cv, full]) {
      const rep = reliabilityByDecile(pwinPairs(rp.rows, "played"));
      expect(rep.consistent).toBe(true);
      expect(["met", "unresolved"]).toContain(rep.status);
      expect(rep.bins_checked).toBeGreaterThanOrEqual(2);
      // better than a coin flip on the real results
      expect(rep.brier.value).toBeLessThan(rep.brier_coin_flip);
    }
  });

  it("(hard, R6-2) every head-to-head side has its mirror: the other team's side, complementary in forecast and result, in both families", () => {
    for (const rp of [cv, full]) {
      const key = (r: StartSitRow, team: number): string =>
        `${String(r.season)}:${String(r.week)}:${String(team)}`;
      const byTeam = new Map(rp.rows.map((r) => [key(r, r.team_id), r]));
      const sides = rp.rows.filter((r) => r.h2h !== null);
      for (const r of sides) {
        const h = r.h2h;
        if (h === null) continue;
        expect(h.opponent_id).not.toBeNull();
        const m = byTeam.get(key(r, h.opponent_id ?? -1))?.h2h;
        expect(m, "the mirror side").toBeDefined();
        if (m === undefined || m === null) continue;
        expect(m.opponent_id).toBe(r.team_id);
        expect(h.p_win_played + m.p_win_played).toBeCloseTo(1, 4);
        expect(h.p_win_auto + m.p_win_auto).toBeCloseTo(1, 4);
        expect(m.outcome_played).toBe(h.outcome_played === null ? null : !h.outcome_played);
        expect(m.outcome_auto).toBe(h.outcome_auto === null ? null : !h.outcome_auto);
        // the pair facts are the forecast's: Φ(margin / sd) is the stored P(win)
        expect(h.auto.mu_m).toBeCloseTo(m.auto.mu_o, 6);
        expect(h.played.real_o).toBe(h.opponent_total);
      }
      const one = oneSidePerMatchup(rp.rows);
      expect(one.length * 2).toBe(sides.length);
      // the mirrored null scores exactly the decile table's forecasts
      for (const family of ["played", "auto"] as const)
        expect(familyNull(rp, family, 100).observed).toBeCloseTo(
          reliabilityByDecile(pwinPairs(rp.rows, family)).brier.decomposition.reliability,
          5,
        );
    }
  });

  it("(hard, R6-2) both P(win) families — E2's own p_win_after included — are consistent with a calibrated forecaster: the reliability term inside its calibrated sampling distribution (P ≥ 0.05), the margins neither regressed toward 0 nor mis-spread", () => {
    for (const rp of [cv, full])
      for (const family of ["played", "auto"] as const) {
        const label = `${rp.basis} ${family}`;
        const nu = familyNull(rp, family);
        expect(nu.events, label).toBeGreaterThanOrEqual(125);
        expect(nu.mirrored).toBe(true);
        expect(nu.p_value, label).toBeGreaterThanOrEqual(0.05);
        expect(nu.observed, label).toBeLessThanOrEqual(nu.q95);
        // the floor is the distribution's mean (reliability_if_calibrated of the same forecasts)
        const floor = reliabilityByDecile(pwinPairs(rp.rows, family)).reliability_if_calibrated;
        expect(Math.abs(nu.mean - floor) / floor, label).toBeLessThan(0.05);
        const m = familyMargins(rp, family);
        expect(m.n, label).toBe(nu.events);
        expect(m.slope_consistent, `${label}: slope ${String(m.slope)}`).toBe(true);
        expect(m.spread_consistent, `${label}: z² ${String(m.z2)}`).toBe(true);
      }
  });

  it("(hard, R6-2) the optimiser's selection bias is real in level and sits on both sides of E2's counterfactual, so it cancels in p_win_after", () => {
    for (const rp of [cv, full]) {
      const s = selectionLevel(rp.rows);
      expect(s.n).toBeGreaterThanOrEqual(250);
      // a best-by-mean lineup realises further below its projected total than the lineup as played
      expect(s.auto).toBeLessThan(s.played);
      // the opponent's best-by-mean lineup out-projects his lineup as played by more than it out-scores it
      expect(s.opp_projected_gap).toBeGreaterThan(s.opp_realised_gap);
      // …and E2's counterfactual pits a best-by-mean lineup against a best-by-mean lineup: summed over
      // both sides of every matchup the margin's error is exactly 0, and its scale is unbiased
      const sides = rp.rows.flatMap((r) => (r.h2h === null ? [] : [r.h2h.auto]));
      const err = sides.reduce((a, x) => a + (x.real_m - x.real_o) - (x.mu_m - x.mu_o), 0);
      expect(Math.abs(err)).toBeLessThan(1e-6 * sides.length);
      expect(familyMargins(rp, "auto").slope_consistent).toBe(true);
    }
  });

  it("(hard, R7-1) E2's advice is the lineup it was handed with only decisive changes made; its assignment is untouched", () => {
    for (const rp of [cv, full]) {
      let changed = 0;
      for (const r of rp.rows) {
        const k = r.lineup_key;
        expect(k.keep_band).not.toBeNull();
        // nothing to change: the advice is the lineup as played, which is E2's assignment too
        if (k.auto === k.manager) expect(k.keep_band).toBe(k.manager);
        else changed += 1;
        // the advice is a legal lineup, so the hindsight best bounds it
        expect(r.realised.keep_band ?? Infinity).toBeLessThanOrEqual(
          (r.realised.hindsight ?? 0) + 1e-9,
        );
      }
      const c = keepBandCounts(rp.rows);
      expect(c.changed).toBe(changed);
      expect(c.all_held + c.some_made).toBe(c.changed);
      // position-level spreads make most changes coin flips (the dispute's count: 154 of 166 on
      // core) — the policy holds them, so the advice keeps the as-played lineup in most changed weeks
      expect(c.all_held).toBeGreaterThan(c.some_made);
      // R6-1 still holds on E2's assignment (asserted above); the advice is a different lineup
      expect(compareRegret(rp.rows, "auto", "espn_projection").pooled.diff).toBe(0);
    }
  });

  it("(soft, reported) the numbers in docs/evals/phase3-startsit.md are this replay's", () => {
    for (const [name, body] of Object.entries(sections()))
      expect(docSection(name), `section ${name}: rerun with UPDATE_EVALS=1 and review`).toBe(body);
  });
});
