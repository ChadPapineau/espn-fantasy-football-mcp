// drift.test.ts — the league's own drift c (plan 10 C5; research 05 §1.2 c, §1.6 eval 3): from the
// processed claim runs (the WAIVER rows demand.ts groups) a Beta posterior; from the acquisition
// totals only an upper bound, so the prior is kept or cut to it, never replaced by it; the floor;
// hostile and duplicate observations rejected.
import { describe, expect, it } from "vitest";
import { claimRuns } from "../../../../src/domain/analytics/demand.js";
import {
  WAIVER_FIT,
  driftFromAcquisitions,
  driftFromClaimRuns,
  fitDrift,
  type DriftObservation,
} from "../../../../src/domain/analytics/waiver-fit/index.js";
import type { Transaction } from "../../../../src/domain/league/types.js";

const obs = (n: number, active: number): DriftObservation[] =>
  Array.from({ length: n }, (_, i) => ({
    team_id: (i % 10) + 1,
    week: Math.floor(i / 10) + 1,
    count: i < active ? 1 + (i % 2) : 0,
  }));

describe("fitDrift — claims", () => {
  it("below the floor: the cold-start prior with its interval", () => {
    const f = fitDrift(obs(WAIVER_FIT.minTeamWeeks - 1, 20), "claims");
    expect(f.basis).toBe("prior");
    expect(f.c).toBe(WAIVER_FIT.driftPrior);
    expect(f.observed_rate).toBeCloseTo(20 / 29, 4);
    expect(f.upper_bound).toBeNull();
    expect(f.interval[0]).toBeLessThan(f.c);
    expect(f.interval[1]).toBeGreaterThan(f.c);
    const none = fitDrift([], "claims");
    expect(none.evidence).toBeNull();
    expect(none.observed_rate).toBeNull();
  });

  it("at or above the floor: the Beta posterior mean, pulled toward the data", () => {
    const f = fitDrift(obs(120, 12), "claims");
    expect(f.basis).toBe("claims");
    const a = 0.25 * 40 + 12;
    const b = 0.75 * 40 + 108;
    expect(f.c).toBeCloseTo(a / (a + b), 4);
    expect(f.c).toBeLessThan(0.25);
    expect(f.interval[0]).toBeLessThanOrEqual(f.c);
    expect(f.interval[1]).toBeGreaterThanOrEqual(f.c);
    const hi = fitDrift(obs(120, 100), "claims");
    expect(hi.c).toBeGreaterThan(0.25);
    expect(hi.c).toBeLessThan(1);
  });

  it("custom priors; a zero-strength prior is the observed rate", () => {
    const f = fitDrift(obs(40, 10), "claims", { prior_c: 0.5, prior_team_weeks: 0 });
    expect(f.c).toBeCloseTo(0.25, 4);
    expect(f.prior_c).toBe(0.5);
    const bad = fitDrift(obs(40, 10), "claims", { prior_c: 1.5, prior_team_weeks: Number.NaN });
    expect(bad.prior_c).toBe(WAIVER_FIT.driftPrior);
    const z = fitDrift([], "claims", { prior_team_weeks: 0 });
    expect(z.interval).toEqual([WAIVER_FIT.driftPrior, WAIVER_FIT.driftPrior]);
  });

  it("hostile and duplicate team-weeks are rejected, never counted", () => {
    const f = fitDrift(
      [
        { team_id: 1, week: 1, count: 1 },
        { team_id: 1, week: 1, count: 1 },
        { team_id: 1.5, week: 1, count: 1 },
        { team_id: 2, week: -1, count: 1 },
        { team_id: 2, week: 1.5, count: 1 },
        { team_id: 2, week: 2, count: Number.NaN },
        { team_id: 2, week: 3, count: -1 },
      ],
      "claims",
    );
    expect(f.rejected).toBe(6);
    expect(f.team_weeks).toBe(1);
  });
});

describe("fitDrift — acquisitions (an upper bound only)", () => {
  it("a share above the prior keeps the prior and reports the bound", () => {
    const f = fitDrift(obs(100, 43), "acquisitions");
    expect(f.basis).toBe("prior_within_acquisition_bound");
    expect(f.c).toBe(WAIVER_FIT.driftPrior);
    expect(f.upper_bound).toBe(0.43);
    expect(f.interval[1]).toBeLessThanOrEqual(0.43);
  });

  it("a share below the prior rules the prior out: c is cut to the bound", () => {
    const f = fitDrift(obs(100, 15), "acquisitions");
    expect(f.basis).toBe("acquisition_bound");
    expect(f.c).toBe(0.15);
    expect(f.interval[1]).toBeLessThanOrEqual(0.15);
    expect(f.interval[0]).toBeLessThanOrEqual(0.15);
  });

  it("below the floor the prior stays, but the bound is still reported", () => {
    const f = fitDrift(obs(10, 1), "acquisitions");
    expect(f.basis).toBe("prior");
    expect(f.upper_bound).toBe(0.1);
  });
});

describe("observations from the league's feed", () => {
  const tx = (
    id: string,
    type: string,
    team: number,
    player: number,
    date: string,
    status: string | null = "EXECUTED",
  ): Transaction => ({
    transaction_id: id,
    type,
    status,
    team_id: team,
    team_name: null,
    scoring_period: null,
    process_date: date,
    proposed_date: null,
    bid_amount: null,
    items: [
      {
        type: "ADD",
        player_id: player,
        name: null,
        from_team_id: null,
        to_team_id: team,
        from_slot: null,
        to_slot: null,
      },
    ],
    related_transaction_id: null,
    note: null,
  });

  it("driftFromClaimRuns: every team × every processed week, counting claims WON", () => {
    const runs = claimRuns([
      tx("1", "WAIVER", 1, 100, "2025-09-17T08:00:00.000Z"),
      tx("2", "WAIVER_ERROR", 2, 100, "2025-09-17T08:00:00.000Z"),
      tx("3", "WAIVER", 1, 101, "2025-09-18T08:00:00.000Z"),
      tx("4", "WAIVER", 3, 102, "2025-09-24T08:00:00.000Z"),
      tx("5", "WAIVER", 3, 103, "2026-02-01T08:00:00.000Z"),
    ]);
    const weekOf = (ms: number) => {
      const d = new Date(ms).toISOString().slice(0, 10);
      return d <= "2025-09-20" ? 3 : d <= "2025-09-27" ? 4 : null;
    };
    const o = driftFromClaimRuns(runs, { teams: [3, 1, 2, 2, 1.5], weekOf });
    expect(o).toEqual([
      { team_id: 1, week: 3, count: 2 },
      { team_id: 2, week: 3, count: 0 },
      { team_id: 3, week: 3, count: 0 },
      { team_id: 1, week: 4, count: 0 },
      { team_id: 2, week: 4, count: 0 },
      { team_id: 3, week: 4, count: 1 },
    ]);
    expect(driftFromClaimRuns(runs, { teams: [1], weekOf: () => 0 })).toEqual([]);
    expect(driftFromClaimRuns(runs, { teams: [1], weekOf: () => 2.5 })).toEqual([]);
  });

  it("driftFromAcquisitions: the regular-season periods, an absent period 0, a hostile value rejected later", () => {
    const o = driftFromAcquisitions(
      [
        { team_id: 1, transaction_counter: { matchup_acquisitions: { "1": 2, "3": 1 } } },
        {
          team_id: 2,
          transaction_counter: {
            matchup_acquisitions: { "2": "x" as unknown as number, toString: 5 },
          },
        },
      ],
      [1, 2, 3],
    );
    expect(o.slice(0, 3)).toEqual([
      { team_id: 1, week: 1, count: 2 },
      { team_id: 1, week: 2, count: 0 },
      { team_id: 1, week: 3, count: 1 },
    ]);
    expect(Number.isNaN(o[4]?.count)).toBe(true);
    const f = fitDrift(o, "acquisitions");
    expect(f.rejected).toBe(1);
    expect(f.team_weeks).toBe(5);
  });
});
