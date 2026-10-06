// demand.test.ts — the warm demand model and the learned waiver mechanics (research 05 §1.3, §1.6
// evals 2 and 4; plan 07 E5/E11 `learned.*`; plan 10 B4 hard part: `second_claim_at_new_position`
// flips from null on a fixture with a same-run pair). The claim runs are read from fx-10h's own
// WAIVER / WAIVER_ERROR rows through the provider's normaliser; the conclusive pairs are synthetic
// rows in the fake team-id range. The fit recovers a planted upgrade effect and beats the cold-start
// curve's Brier on data drawn from it; it refuses too little data. Deterministic throughout.
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  brier,
  claimRuns,
  demandCovariates,
  demandObservations,
  fitDemand,
  fittedQ,
  learnKickoffWaivers,
  learnWaiverMechanics,
  type ClaimRun,
  type DemandObservation,
} from "../../../src/domain/analytics/demand.js";
import { DEMAND_FIT } from "../../../src/domain/analytics/marketConstants.js";
import { demandOf } from "../../../src/domain/analytics/waiverDp.js";
import { seededRng } from "../../../src/domain/clock.js";
import type { Transaction } from "../../../src/domain/league/types.js";
import { newCounts, normalizeTransaction } from "../../../src/providers/espn/normalize.js";

/** A synthetic claim row (fake ids only). */
function tx(
  id: number,
  type: "WAIVER" | "WAIVER_ERROR" | "FREEAGENT",
  team: number,
  player: number,
  processIso: string,
  status: string | null = type === "WAIVER_ERROR" ? "FAILED_INVALIDPLAYERSOURCE" : "EXECUTED",
): Transaction {
  return {
    transaction_id: String(id),
    type,
    status,
    team_id: team,
    team_name: null,
    scoring_period: 3,
    process_date: processIso,
    proposed_date: null,
    bid_amount: 0,
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
  };
}

const RUN1 = "2026-09-23T07:30:00.000Z";
const RUN2 = "2026-09-30T07:30:00.000Z";
const order = (ranks: Record<number, number>): ReadonlyMap<number, number> =>
  new Map(Object.entries(ranks).map(([t, r]) => [Number(t), r]));

function fx10hTransactions(): Transaction[] {
  const raw = JSON.parse(
    readFileSync(
      new URL("../../../fixtures/espn/fx-10h/league/mTransactions2.json", import.meta.url),
      "utf8",
    ),
  ) as { transactions: unknown[] };
  const counts = newCounts();
  return raw.transactions
    .map((t) => normalizeTransaction(t, null, counts))
    .filter((t): t is Transaction => t !== null);
}

describe("claimRuns — WAIVER (executed) and WAIVER_ERROR rows grouped by processDate", () => {
  it("groups, orders and labels won / lost; skips pending, FREEAGENT and undated rows", () => {
    const runs = claimRuns([
      tx(1, "WAIVER", 3, 900, RUN2),
      tx(2, "WAIVER_ERROR", 4, 900, RUN2),
      tx(3, "WAIVER", 1, 901, RUN1),
      tx(4, "WAIVER", 5, 902, RUN1, "PENDING"),
      tx(5, "FREEAGENT", 6, 903, RUN1),
      { ...tx(6, "WAIVER", 7, 904, RUN1), process_date: null },
      { ...tx(7, "WAIVER", 8, 905, RUN1), process_date: "not a date" },
      {
        ...tx(8, "WAIVER", 0, 906, RUN1),
        team_id: null,
        items: [
          {
            type: "ADD",
            player_id: 906,
            name: null,
            from_team_id: null,
            to_team_id: 9,
            from_slot: null,
            to_slot: null,
          },
        ],
      },
      {
        ...tx(9, "WAIVER", 2, 907, RUN1),
        items: [
          {
            type: "DROP",
            player_id: 907,
            name: null,
            from_team_id: 2,
            to_team_id: null,
            from_slot: null,
            to_slot: null,
          },
        ],
      },
      { ...tx(10, "WAIVER", 2, 908, RUN1), status: null },
    ]);
    expect(runs.map((r) => r.run)).toEqual([RUN1, RUN2]);
    expect(runs[0]?.claims).toEqual([
      { team_id: 1, player_id: 901, won: true },
      { team_id: 2, player_id: 908, won: true },
      { team_id: 9, player_id: 906, won: true },
    ]);
    expect(runs[1]?.claims).toEqual([
      { team_id: 3, player_id: 900, won: true },
      { team_id: 4, player_id: 900, won: false },
    ]);
  });
  it("fx-10h: two runs; the week-2 run holds Team 1's same-run pair and Team 2's failed claim", () => {
    const runs = claimRuns(fx10hTransactions());
    expect(runs).toHaveLength(2);
    const first = runs[0];
    const t1 = first?.claims.filter((c) => c.team_id === 1) ?? [];
    expect(t1.filter((c) => c.won)).toHaveLength(2);
    const lost = first?.claims.filter((c) => !c.won) ?? [];
    expect(lost).toHaveLength(1);
    expect(lost[0]?.team_id).toBe(2);
    // Team 2 lost the player Team 1 won
    expect(t1.some((c) => c.player_id === lost[0]?.player_id)).toBe(true);
  });
});

describe("learnWaiverMechanics — plan 10 B4 hard: second_claim_at_new_position flips from null", () => {
  it("null with no order before the run (never guessed), and null on a pair that proves nothing", () => {
    const runs = claimRuns([tx(1, "WAIVER", 1, 900, RUN1), tx(2, "WAIVER", 1, 901, RUN1)]);
    expect(learnWaiverMechanics({ runs }).second_claim_at_new_position).toBeNull();
    const m = learnWaiverMechanics({
      runs,
      order_before: new Map([[RUN1, order({ 1: 1, 2: 2, 3: 3 })]]),
    });
    expect(m.second_claim_at_new_position).toBeNull();
    expect(m.evidence.pairs).toBe(1);
  });
  it("fx-10h's own pair: uncontested second win, so the feed has not shown the case → null", () => {
    const runs = claimRuns(fx10hTransactions());
    const before = new Map([
      [runs[0]?.run ?? "", order({ 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10 })],
    ]);
    const m = learnWaiverMechanics({ runs, order_before: before });
    expect(m.evidence.pairs).toBe(1);
    expect(m.second_claim_at_new_position).toBeNull();
  });
  it("TRUE on a same-run pair: team 1 (rank 1) wins one claim and loses another to team 3 (rank 3)", () => {
    const runs = claimRuns([
      tx(1, "WAIVER", 1, 900, RUN1),
      tx(2, "WAIVER_ERROR", 1, 901, RUN1),
      tx(3, "WAIVER", 3, 901, RUN1),
    ]);
    const m = learnWaiverMechanics({
      runs,
      order_before: new Map([[RUN1, order({ 1: 1, 2: 2, 3: 3 })]]),
    });
    expect(m.second_claim_at_new_position).toBe(true);
    expect(m.evidence.new_position_cases).toBe(1);
  });
  it("FALSE: team 1 wins two claims that teams ranked behind it claimed and lost", () => {
    const runs = claimRuns([
      tx(1, "WAIVER", 1, 900, RUN1),
      tx(2, "WAIVER", 1, 901, RUN1),
      tx(3, "WAIVER_ERROR", 3, 900, RUN1),
      tx(4, "WAIVER_ERROR", 4, 901, RUN1),
    ]);
    const m = learnWaiverMechanics({
      runs,
      order_before: new Map([[RUN1, order({ 1: 1, 2: 2, 3: 3, 4: 4 })]]),
    });
    expect(m.second_claim_at_new_position).toBe(false);
  });
  it("a loss to a team ranked AHEAD proves nothing; conflicting runs read null", () => {
    const ahead = claimRuns([
      tx(1, "WAIVER", 3, 900, RUN1),
      tx(2, "WAIVER_ERROR", 3, 901, RUN1),
      tx(3, "WAIVER", 1, 901, RUN1),
    ]);
    expect(
      learnWaiverMechanics({ runs: ahead, order_before: new Map([[RUN1, order({ 1: 1, 3: 3 })]]) })
        .second_claim_at_new_position,
    ).toBeNull();
    const conflict = claimRuns([
      tx(1, "WAIVER", 1, 900, RUN1),
      tx(2, "WAIVER_ERROR", 1, 901, RUN1),
      tx(3, "WAIVER", 3, 901, RUN1),
      tx(4, "WAIVER", 2, 910, RUN2),
      tx(5, "WAIVER", 2, 911, RUN2),
      tx(6, "WAIVER_ERROR", 5, 910, RUN2),
      tx(7, "WAIVER_ERROR", 6, 911, RUN2),
    ]);
    const m = learnWaiverMechanics({
      runs: conflict,
      order_before: new Map([
        [RUN1, order({ 1: 1, 2: 2, 3: 3 })],
        [RUN2, order({ 2: 1, 5: 5, 6: 6 })],
      ]),
    });
    expect(m.evidence.new_position_cases).toBe(1);
    expect(m.evidence.old_position_cases).toBe(1);
    expect(m.second_claim_at_new_position).toBeNull();
  });
  it("rank moves on success: winners move down / to last → true; a winner who kept his rank → false", () => {
    const runs = claimRuns([tx(1, "WAIVER", 1, 900, RUN1), tx(2, "WAIVER", 2, 901, RUN1)]);
    const before = new Map([[RUN1, order({ 1: 1, 2: 2, 3: 3 })]]);
    expect(
      learnWaiverMechanics({
        runs,
        order_before: before,
        order_after: new Map([[RUN1, order({ 3: 1, 1: 2, 2: 3 })]]),
      }).waiver_rank_moves_on_success,
    ).toBe(true);
    expect(
      learnWaiverMechanics({
        runs,
        order_before: before,
        order_after: new Map([[RUN1, order({ 1: 1, 2: 2, 3: 3 })]]),
      }).waiver_rank_moves_on_success,
    ).toBe(false);
    expect(
      learnWaiverMechanics({ runs, order_before: before }).waiver_rank_moves_on_success,
    ).toBeNull();
  });
});

describe("learnKickoffWaivers", () => {
  it("all flipped → true; all stayed → false; none or mixed → null", () => {
    const before = new Map([
      [1, "FREEAGENT"],
      [2, "FREEAGENT"],
      [3, "ONTEAM"],
    ]);
    expect(
      learnKickoffWaivers({
        before,
        after: new Map([
          [1, "WAIVERS"],
          [2, "WAIVERS"],
        ]),
        played: [1, 2, 3],
      }),
    ).toBe(true);
    expect(
      learnKickoffWaivers({
        before,
        after: new Map([
          [1, "FREEAGENT"],
          [2, "FREEAGENT"],
        ]),
        played: [1, 2],
      }),
    ).toBe(false);
    expect(
      learnKickoffWaivers({
        before,
        after: new Map([
          [1, "WAIVERS"],
          [2, "FREEAGENT"],
        ]),
        played: [1, 2],
      }),
    ).toBeNull();
    expect(learnKickoffWaivers({ before, after: new Map(), played: [3] })).toBeNull();
  });
});

/** A synthetic league whose claims follow a planted logistic in the rival's own upgrade. */
function planted(
  seed: number,
  runsN: number,
): { runs: ClaimRun[]; features: Map<string, { r: number; upgrade: number }> } {
  const rng = seededRng(seed);
  const runs: ClaimRun[] = [];
  const features = new Map<string, { r: number; upgrade: number }>();
  for (let k = 0; k < runsN; k++) {
    const run = new Date(Date.UTC(2026, 8, 10 + 7 * k, 7)).toISOString();
    const claims: { team_id: number; player_id: number; won: boolean }[] = [];
    for (let p = 0; p < 6; p++) {
      const player = 1000 + k * 10 + p;
      const r = 1 + rng.next() * 4;
      for (let team = 1; team <= 10; team++) {
        const upgrade = rng.next() < 0.5 ? 0 : r * (0.5 + rng.next());
        features.set(`${run}|${String(team)}|${String(player)}`, { r, upgrade });
        const q = 1 / (1 + Math.exp(-(-3 + 1.1 * upgrade)));
        if (rng.next() < q) claims.push({ team_id: team, player_id: player, won: false });
      }
    }
    runs.push({ run, process_ms: Date.parse(run), claims });
  }
  return { runs, features };
}

describe("fitDemand — research 05 §1.3 warm model on the league's own claim rows", () => {
  const { runs, features } = planted(11, 6);
  const rows = demandObservations({
    runs,
    teams: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    features: (run, team, player) => {
      const f = features.get(`${run}|${String(team)}|${String(player)}`);
      return f === undefined ? null : { r: f.r, upgrade: f.upgrade, trend: null };
    },
    // every planted player was claimable in his run: the unclaimed ones are the negatives
    pool_by_run: new Map(
      runs.map((r, k) => [r.run, Array.from({ length: 6 }, (_, p) => 1000 + k * 10 + p)]),
    ),
  });
  it("builds one row per (run, team, claimable player) with prior-run activity", () => {
    expect(rows).toHaveLength(6 * 10 * 6);
    const first = rows.filter((r) => r.run === runs[0]?.run);
    expect(first.every((r) => r.activity === 0)).toBe(true);
    const later = rows.filter((r) => r.run === runs[5]?.run);
    expect(later.some((r) => r.activity > 0)).toBe(true);
  });
  it("recovers the planted upgrade effect, beats the cold-start curve's Brier, and is deterministic", () => {
    const fit = fitDemand(rows);
    expect(fit).not.toBeNull();
    if (fit === null) return;
    expect(fit.coef[1]).toBeGreaterThan(0.5);
    expect(fit.coef[0]).toBeLessThan(-1.5);
    expect(fit.brier_fitted).toBeLessThan(fit.brier_cold);
    expect(fit.brier_fitted_cv).not.toBeNull();
    expect(fit.runs).toBe(6);
    expect(fitDemand(rows)).toEqual(fit);
  });
  it("refuses too few rows, or rows without both outcomes (the cold-start curve stays)", () => {
    expect(fitDemand(rows.slice(0, DEMAND_FIT.minObservations - 1))).toBeNull();
    expect(fitDemand(rows.map((r) => ({ ...r, claimed: false })))).toBeNull();
    expect(fitDemand(rows.map((r) => ({ ...r, claimed: true })))).toBeNull();
  });
  it("fittedQ: inside [pMin, pMax], lo ≤ p ≤ hi, rising in the upgrade", () => {
    const fit = fitDemand(rows);
    if (fit === null) throw new Error("expected a fit");
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 8, noNaN: true }),
        fc.option(fc.double({ min: 0, max: 8, noNaN: true }), { nil: null }),
        fc.option(fc.double({ min: 0, max: 1e6, noNaN: true }), { nil: null }),
        fc.integer({ min: 0, max: 30 }),
        (r, upgrade, trend, activity) => {
          const q = fittedQ(fit, { r, upgrade, trend, activity });
          expect(q.lo).toBeLessThanOrEqual(q.p);
          expect(q.p).toBeLessThanOrEqual(q.hi);
          expect(q.lo).toBeGreaterThanOrEqual(DEMAND_FIT.pMin);
          expect(q.hi).toBeLessThanOrEqual(DEMAND_FIT.pMax);
        },
      ),
      { numRuns: 300 },
    );
    const low = fittedQ(fit, { r: 2, upgrade: 0, trend: null, activity: 0 });
    const high = fittedQ(fit, { r: 2, upgrade: 5, trend: null, activity: 0 });
    expect(high.p).toBeGreaterThan(low.p);
  });
  it("covariates: upgrade falls back to r; trend is log(1 + max(0, trend))", () => {
    const base: Pick<DemandObservation, "r" | "upgrade" | "trend" | "activity"> = {
      r: 2.5,
      upgrade: null,
      trend: null,
      activity: 3,
    };
    expect(demandCovariates(base)).toEqual([1, 2.5, 0, 3]);
    expect(demandCovariates({ ...base, upgrade: 1, trend: Math.E - 1 })[2]).toBeCloseTo(1, 12);
    expect(demandCovariates({ ...base, trend: -50 })[2]).toBe(0);
  });
  it("brier: 0 for no pairs, the mean squared error otherwise; the cold curve is demandOf", () => {
    expect(brier([])).toBe(0);
    expect(
      brier([
        { p: 1, y: true },
        { p: 0, y: true },
      ]),
    ).toBe(0.5);
    expect(demandOf(0)).toBeCloseTo(0.05, 12);
  });
  it("features returning null skip the row; non-finite features are dropped", () => {
    const one = demandObservations({
      runs: [
        {
          run: RUN1,
          process_ms: Date.parse(RUN1),
          claims: [{ team_id: 1, player_id: 5, won: true }],
        },
      ],
      teams: [1, 2, 2],
      features: (_run, team) =>
        team === 1 ? { r: 1, upgrade: Number.NaN, trend: Number.POSITIVE_INFINITY } : null,
    });
    expect(one).toEqual([
      {
        run: RUN1,
        team_id: 1,
        player_id: 5,
        r: 1,
        upgrade: null,
        trend: null,
        activity: 0,
        claimed: true,
      },
    ]);
  });
});
