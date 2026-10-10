// objective-switch.test.ts — the auto-default switch rule (plan 10 C2; plan 07 E2): the decision as a
// pure function of the evidence (insufficient seasons or differing team-weeks; pwin strictly below
// mean in every season, also after week 3; otherwise no switch), the evidence from replayed rows,
// the committed record (frozen, self-consistent, not switching), and E2 reading it: `auto` on an
// all-player_sim lineup under reading (a) becomes pwin only with a switching record — never on
// position_cv, never under reading (b), and degraded to mean without an opponent.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  OBJECTIVE_SWITCH_RECORD,
  SWITCH_RULE,
  autoObjectiveForPlayerSim,
  decideObjectiveSwitch,
  switchEvidenceOf,
  type ObjectiveSwitchEvidence,
  type ObjectiveSwitchRecord,
  type ObjectiveSwitchSeason,
} from "../../../../src/domain/analytics/calibration/index.js";
import { analyzeLineup, type LineupRequest } from "../../../../src/domain/analytics/lineup.js";
import { clockAndRng, referenceSlots } from "../helpers.js";
import { roster, row } from "./helpers/roster.js";

const season = (over: Partial<ObjectiveSwitchSeason> = {}): ObjectiveSwitchSeason => ({
  season: 2024,
  n: 150,
  n_differing: 20,
  regret_mean: 12,
  regret_pwin: 11.5,
  n_later: 120,
  regret_mean_later: 12,
  regret_pwin_later: 11.6,
  ...over,
});

const evidence = (seasons: ObjectiveSwitchSeason[]): ObjectiveSwitchEvidence => ({
  basis: "player_sim",
  player_sim_share: 1,
  seasons,
});

const switching: ObjectiveSwitchRecord = {
  evidence: evidence([season(), season({ season: 2025 })]),
  decision: { status: "switch", switch: true, reasons: [] },
  source: "test",
};

describe("decideObjectiveSwitch", () => {
  it("switches when pwin's regret is below mean's in every season, also after week 3", () => {
    const d = decideObjectiveSwitch(evidence([season(), season({ season: 2025 })]));
    expect(d.status).toBe("switch");
    expect(d.switch).toBe(true);
    expect(d.reasons.at(-1)).toMatch(/every held-out season/);
  });

  it("is insufficient with one season or too few differing team-weeks — even if pwin wins", () => {
    const one = decideObjectiveSwitch(evidence([season({ n_differing: 40 })]));
    expect(one).toMatchObject({ status: "insufficient", switch: false });
    expect(one.reasons[0]).toMatch(/1 held-out season/);
    const few = decideObjectiveSwitch(
      evidence([season({ n_differing: 10 }), season({ season: 2025, n_differing: 10 })]),
    );
    expect(few.status).toBe("insufficient");
    expect(few.reasons[0]).toBe(
      `pwin and mean differ in 20 team-week(s) < ${String(SWITCH_RULE.minDiffering)} required`,
    );
    expect(decideObjectiveSwitch(evidence([])).status).toBe("insufficient");
  });

  it("does not switch when one season, or the later weeks of one season, favour mean (ties included)", () => {
    const lose = decideObjectiveSwitch(
      evidence([season(), season({ season: 2025, regret_pwin: 12.5 })]),
    );
    expect(lose).toMatchObject({ status: "no_switch", switch: false });
    expect(lose.reasons).toEqual(["2025: pwin regret 12.5000 is not below mean's 12.0000"]);
    const early = decideObjectiveSwitch(
      evidence([season(), season({ season: 2025, regret_pwin_later: 12 })]),
    );
    expect(early.status).toBe("no_switch");
    expect(early.reasons[0]).toMatch(/2025 after week 3/);
    const empty = decideObjectiveSwitch(
      evidence([season(), season({ season: 2025, n: 0, n_later: 0 })]),
    );
    expect(empty.status).toBe("no_switch");
  });

  it("(property) a switch implies pwin below mean in every season and both windows", () => {
    const arb = fc.record({
      season: fc.integer({ min: 2000, max: 2100 }),
      n: fc.integer({ min: 0, max: 200 }),
      n_differing: fc.integer({ min: 0, max: 50 }),
      regret_mean: fc.double({ min: 0, max: 50, noNaN: true }),
      regret_pwin: fc.double({ min: 0, max: 50, noNaN: true }),
      n_later: fc.integer({ min: 0, max: 200 }),
      regret_mean_later: fc.double({ min: 0, max: 50, noNaN: true }),
      regret_pwin_later: fc.double({ min: 0, max: 50, noNaN: true }),
    });
    fc.assert(
      fc.property(fc.array(arb, { maxLength: 4 }), (seasons) => {
        const d = decideObjectiveSwitch(evidence(seasons));
        expect(d.switch).toBe(d.status === "switch");
        if (d.switch) {
          expect(seasons.length).toBeGreaterThanOrEqual(SWITCH_RULE.minSeasons);
          for (const s of seasons) {
            expect(s.regret_pwin).toBeLessThan(s.regret_mean);
            expect(s.regret_pwin_later).toBeLessThan(s.regret_mean_later);
          }
        }
      }),
    );
  });
});

describe("switchEvidenceOf", () => {
  it("averages each objective's regret per season, over every week and after week 3", () => {
    const rows = [
      row(2025, 1, { hindsight: 100, mean: 90, pwin: 80 }, { player_sim_share: 1 }),
      row(2025, 4, { hindsight: 100, mean: 90, pwin: 95 }, { player_sim_share: 0 }),
      row(
        2024,
        5,
        { hindsight: 50, mean: 40, pwin: 40 },
        {
          player_sim_share: 0.5,
          lineup_key: { ...row(2024, 5, {}).lineup_key, mean: "a", pwin: "a" },
        },
      ),
      row(2024, 6, { hindsight: 50, mean: 40 }),
    ];
    const e = switchEvidenceOf(rows);
    expect(e.basis).toBe("player_sim");
    expect(e.player_sim_share).toBe(0.375);
    expect(e.seasons).toEqual([
      {
        season: 2024,
        n: 1,
        n_differing: 0,
        regret_mean: 10,
        regret_pwin: 10,
        n_later: 1,
        regret_mean_later: 10,
        regret_pwin_later: 10,
      },
      {
        season: 2025,
        n: 2,
        n_differing: 2,
        regret_mean: 10,
        regret_pwin: 12.5,
        n_later: 1,
        regret_mean_later: 10,
        regret_pwin_later: 5,
      },
    ]);
    expect(switchEvidenceOf([])).toEqual({ basis: "player_sim", player_sim_share: 0, seasons: [] });
  });
});

describe("the committed record and E2's auto objective", () => {
  it("is frozen, self-consistent and does not switch", () => {
    expect(Object.isFrozen(OBJECTIVE_SWITCH_RECORD)).toBe(true);
    expect(Object.isFrozen(OBJECTIVE_SWITCH_RECORD.evidence.seasons)).toBe(true);
    expect(decideObjectiveSwitch(OBJECTIVE_SWITCH_RECORD.evidence)).toEqual(
      OBJECTIVE_SWITCH_RECORD.decision,
    );
    expect(OBJECTIVE_SWITCH_RECORD.evidence.seasons.length).toBeGreaterThanOrEqual(2);
    expect(OBJECTIVE_SWITCH_RECORD.source).toBe("docs/evals/phase3-startsit.md");
    expect(autoObjectiveForPlayerSim()).toBe("mean");
    expect(autoObjectiveForPlayerSim(switching)).toBe("pwin");
    // a record claiming a switch without the status is not trusted
    expect(
      autoObjectiveForPlayerSim({
        ...switching,
        decision: { ...switching.decision, status: "no_switch" },
      }),
    ).toBe("mean");
  });

  const request = (over: Partial<LineupRequest> = {}): LineupRequest => ({
    roster: referenceSlots(),
    players: roster(0, "player_sim"),
    opponent: roster(100, "player_sim"),
    seeding_config: { mode: "espn_rule", confirmed_at: null },
    clock: clockAndRng("2026-10-08T12:00:00.000Z").clock,
    ...over,
  });

  it("auto on an all-player_sim lineup: mean under the committed record, pwin under a switching one", () => {
    const committed = analyzeLineup(request());
    expect(committed.basis).toBe("player_sim");
    expect(committed.objective_used).toBe("mean");
    expect(committed.objective_reason).toMatch(/until player_sim P\(win\) is shown to beat it/);
    const switched = analyzeLineup(request({ objective_switch: switching }));
    expect(switched.objective_used).toBe("pwin");
    expect(switched.objective_reason).toMatch(/plan 10 C2/);
    expect(switched.rec.decision_metric).toBe("p_win");
  });

  it("never switches a position_cv lineup, reading (b), an explicit objective, or a lineup without an opponent", () => {
    const cv = analyzeLineup(
      request({ players: roster(0), opponent: roster(100), objective_switch: switching }),
    );
    expect(cv.basis).toBe("position_cv");
    expect(cv.objective_used).toBe("mean");
    const b = analyzeLineup(
      request({
        seeding_config: { mode: "points_only", confirmed_at: null },
        objective_switch: switching,
      }),
    );
    expect(b.objective_used).toBe("points_only");
    const explicit = analyzeLineup(request({ objective: "mean", objective_switch: switching }));
    expect(explicit.objective_used).toBe("mean");
    const alone = analyzeLineup(request({ opponent: null, objective_switch: switching }));
    expect(alone.objective_used).toBe("mean");
    expect(alone.objective_reason).toBe("degraded: no opponent roster");
  });
});
