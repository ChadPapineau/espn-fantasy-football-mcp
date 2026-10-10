// feed.test.ts — the fitted premium from the E5 tool's own inputs (plan 10 C5; plan 07 E5 Data: A6,
// A2): processed claims give the drift (their week from the transactions' scoring periods); with no
// processed claim (no cookies) the acquisition totals bound it; the logged runs give the surplus; a
// short feed stays cold.
import { describe, expect, it } from "vitest";
import {
  fitPremiumFromFeed,
  weekOfFromTransactions,
} from "../../../../src/domain/analytics/waiver-fit/index.js";
import type { Transaction } from "../../../../src/domain/league/types.js";

const tx = (
  id: string,
  type: string,
  team: number,
  player: number,
  date: string | null,
  period: number | null,
): Transaction => ({
  transaction_id: id,
  type,
  status: "EXECUTED",
  team_id: team,
  team_name: null,
  scoring_period: period,
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

const standings = (n: number, acq: Record<string, number>) =>
  Array.from({ length: n }, (_, i) => ({
    team_id: i + 1,
    transaction_counter: {
      acquisitions: 0,
      drops: 0,
      trades: 0,
      move_to_ir: 0,
      move_to_active: 0,
      budget_spent: null,
      matchup_acquisitions: acq,
    },
  }));

/** 14 logged runs at W = 12 whose best claim is worth 3 points per week. */
const runs = Array.from({ length: 14 }, () => ({ W: 12, candidates: [{ s: 39 }, { s: 5 }] }));

describe("weekOfFromTransactions", () => {
  it("a run's week is its transactions' scoring period (the majority; ties → the earlier)", () => {
    const d1 = "2025-09-17T08:00:00.000Z";
    const d2 = "2025-09-24T08:00:00.000Z";
    const weekOf = weekOfFromTransactions([
      tx("1", "WAIVER", 1, 10, d1, 3),
      tx("2", "WAIVER", 2, 11, d1, 3),
      tx("3", "WAIVER", 3, 12, d1, 2),
      tx("4", "WAIVER", 1, 13, d2, 5),
      tx("5", "WAIVER", 2, 14, d2, 4),
      tx("6", "WAIVER", 2, 15, null, 4),
      tx("7", "WAIVER", 2, 16, "not a date", 4),
      tx("8", "WAIVER", 2, 17, d2, 0),
      tx("9", "WAIVER", 2, 18, d2, null),
    ]);
    expect(weekOf(Date.parse(d1))).toBe(3);
    expect(weekOf(Date.parse(d2))).toBe(4);
    expect(weekOf(0)).toBeNull();
  });
});

describe("fitPremiumFromFeed", () => {
  it("processed claims give a claims-basis drift; a season of runs makes the premium league_fitted", () => {
    const transactions: Transaction[] = [];
    let id = 0;
    for (let week = 2; week <= 5; week++)
      for (let team = 1; team <= 10; team++)
        if ((team + week) % 3 === 0)
          transactions.push(
            tx(
              String(++id),
              "WAIVER",
              team,
              1000 + id,
              `2025-09-${String(10 + week)}T08:00:00.000Z`,
              week,
            ),
          );
    const fit = fitPremiumFromFeed({
      teams: 10,
      transactions,
      standings: standings(10, {}),
      periods_played: [1, 2, 3, 4],
      runs,
    });
    expect(fit.basis).toBe("league_fitted");
    expect(fit.drift.evidence).toBe("claims");
    expect(fit.drift.basis).toBe("claims");
    expect(fit.drift.team_weeks).toBe(40);
    expect(fit.surplus.n).toBe(14);
    expect(fit.surplus.observed_mean_r).toBe(3);
  });

  it("no processed claim (no cookies): the acquisition totals bound the drift; a short feed stays cold", () => {
    const fit = fitPremiumFromFeed({
      teams: 10,
      transactions: [],
      standings: standings(10, { "1": 1, "2": 0, "3": 2, "4": 1 }),
      periods_played: [1, 2, 3, 4],
      runs,
      demand_scale: 0.8,
    });
    expect(fit.drift.evidence).toBe("acquisitions");
    expect(fit.drift.upper_bound).toBe(0.75);
    expect(fit.drift.c).toBe(0.25);
    expect(fit.demand_scale).toBe(0.8);
    const cold = fitPremiumFromFeed({
      teams: 10,
      transactions: [],
      standings: standings(10, {}),
      periods_played: [],
      runs: runs.slice(0, 3),
    });
    expect(cold.basis).toBe("cold_start_table");
  });
});
