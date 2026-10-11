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
// basis, the "did it matter" shares.
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
  pwinPairs,
  regretSection,
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
    matter: didItMatterSection(both),
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

  it("(soft, reported) the numbers in docs/evals/phase3-startsit.md are this replay's", () => {
    for (const [name, body] of Object.entries(sections()))
      expect(docSection(name), `section ${name}: rerun with UPDATE_EVALS=1 and review`).toBe(body);
  });
});
