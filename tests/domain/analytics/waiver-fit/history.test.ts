// history.test.ts — a league's previous seasons as its own waiver feed (changelog R6-3; plan 07 E5):
// the season an instant belongs to; the feed from a season's transactions (a drop is claimed only
// when ANOTHER team's WON claim of him is processed inside the fate window; failed claims, pending
// rows, other seasons, the last week and the playoffs never count; values or value-free r = 0);
// the demand curve (cold below 30 candidates; the slope from the data only with claims at value and
// off its lower bound — R6-3 — else the intercept alone); the premium re-solved from history so
// the basis is league_fitted from the first call, with the seasons and n in its ≤ 200-character
// summary; the 13-logged-runs path unchanged without history; the cold-start statement and its
// measured miss (the premium, the whole curve, or only the slope beside the league's intercept). Properties (fast-check) against an independent re-implementation of the fate rule.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { WAIVER_DP } from "../../../../src/domain/analytics/constants.js";
import { TEXT_CAPS, type Transaction } from "../../../../src/domain/league/types.js";
import {
  COLD_START_REVISIT,
  WAIVER_FIT,
  coldStartNote,
  curveDemand,
  fitDemandIntercept,
  fitHistoryDemand,
  fitPremiumFromFeed,
  fitPremiumFromHistory,
  seasonFeedFromTransactions,
  seasonOfInstant,
  transactionsBySeason,
  type HistoryOutcome,
  type SeasonWaiverFeed,
} from "../../../../src/domain/analytics/waiver-fit/index.js";
import { capSummary } from "../../../../src/domain/analytics/waiver-fit/fit.js";
import { solvePremiumTable } from "../../../../src/domain/analytics/waiverDp.js";

const DAY = 24 * 3600 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();
/** Week w's evening in a season (deterministic). */
const evening = (season: number, w: number): number => Date.UTC(season, 8, 3, 23) + w * 7 * DAY;

function txn(o: {
  id: string;
  type: string;
  team: number;
  player: number;
  item: "ADD" | "DROP";
  ms: number;
  week: number | null;
  status?: string | null;
}): Transaction {
  return {
    transaction_id: o.id,
    type: o.type,
    status: o.status === undefined ? "EXECUTED" : o.status,
    team_id: o.team,
    team_name: null,
    scoring_period: o.week,
    process_date: iso(o.ms),
    proposed_date: null,
    bid_amount: null,
    items: [
      {
        type: o.item,
        player_id: o.player,
        name: null,
        from_team_id: o.item === "DROP" ? o.team : null,
        to_team_id: o.item === "ADD" ? o.team : null,
        from_slot: null,
        to_slot: null,
      },
    ],
    related_transaction_id: null,
    note: null,
  };
}
const drop = (id: string, team: number, player: number, ms: number, week: number) =>
  txn({ id, type: "FREEAGENT", team, player, item: "DROP", ms, week });
const claim = (id: string, team: number, player: number, ms: number, week: number, won = true) =>
  txn({ id, type: won ? "WAIVER" : "WAIVER_ERROR", team, player, item: "ADD", ms, week });

const TEAMS = Array.from({ length: 10 }, (_, i) => i + 1);

/** A season of drops: per week 1..13, `perWeek` drops, the first `claimedPerWeek` re-claimed next morning. */
function season(
  y: number,
  perWeek: number,
  claimedPerWeek: number,
  weeks = 13,
): { txns: Transaction[]; drops: number; claimed: number } {
  const txns: Transaction[] = [];
  let pid = y * 1000;
  let claimed = 0;
  for (let w = 1; w <= weeks; w++)
    for (let i = 0; i < perWeek; i++) {
      pid += 1;
      const team = (i % 10) + 1;
      const ms = evening(y, w);
      txns.push(drop(`d${String(pid)}`, team, pid, ms, w));
      if (i < claimedPerWeek) {
        claimed += 1;
        txns.push(claim(`c${String(pid)}`, (team % 10) + 1, pid, ms + DAY / 2, w));
      }
    }
  // a later week so every drop above has a cycle after it
  txns.push(drop(`tail${String(y)}`, 1, 1, evening(y, weeks + 1), weeks + 1));
  return { txns, drops: weeks * perWeek, claimed };
}

describe("seasonOfInstant / transactionsBySeason", () => {
  it("September–December is that year's season, January–February the previous one", () => {
    expect(seasonOfInstant("2025-09-10T12:00:00.000Z")).toBe(2025);
    expect(seasonOfInstant("2025-12-31T23:59:59.000Z")).toBe(2025);
    expect(seasonOfInstant("2026-01-06T10:00:00.000Z")).toBe(2025);
    expect(seasonOfInstant("2026-02-28T10:00:00.000Z")).toBe(2025);
    expect(seasonOfInstant("2026-03-01T00:00:00.000Z")).toBe(2026);
    expect(seasonOfInstant(null)).toBeNull();
    expect(seasonOfInstant("not a date")).toBeNull();
  });

  it("property: the season is the instant's year or the one before", () => {
    fc.assert(
      fc.property(fc.integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2100, 0, 1) }), (ms) => {
        const s = seasonOfInstant(iso(ms));
        const y = new Date(ms).getUTCFullYear();
        expect(s === y || s === y - 1).toBe(true);
      }),
    );
  });

  it("groups by the processed (else proposed) instant; undated rows are left out", () => {
    const a = drop("a", 1, 10, evening(2024, 3), 3);
    const b = drop("b", 1, 11, evening(2025, 3), 3);
    const jan = drop("j", 1, 12, Date.UTC(2026, 0, 5), 17);
    const undated: Transaction = {
      ...a,
      transaction_id: "u",
      process_date: null,
      proposed_date: null,
    };
    const g = transactionsBySeason([a, b, jan, undated]);
    expect([...g.keys()].sort()).toEqual([2024, 2025]);
    expect(g.get(2025)?.map((t) => t.transaction_id)).toEqual(["b", "j"]);
  });
});

describe("seasonFeedFromTransactions", () => {
  const base = evening(2025, 4);
  const last = drop("last", 9, 999, evening(2025, 10), 10);

  it("claimed only by another team's WON claim inside the window; everything else clears", () => {
    const txns = [
      drop("d1", 1, 101, base, 4),
      claim("c1", 2, 101, base + DAY / 2, 4), // claimed
      drop("d2", 1, 102, base, 4),
      claim("c2", 1, 102, base + DAY / 2, 4), // the same team re-claims him: not another team's claim
      drop("d3", 1, 103, base, 4),
      claim("c3", 3, 103, base + 9 * DAY, 5), // outside the 8-day window
      drop("d4", 1, 104, base, 4),
      claim("c4", 4, 104, base + DAY / 2, 4, false), // a failed claim (WAIVER_ERROR)
      drop("d5", 1, 105, base, 4),
      claim("c5", 5, 105, base - DAY, 3), // before the drop
      last,
    ];
    const f = seasonFeedFromTransactions({ season: 2025, transactions: txns, teams: TEAMS });
    expect(f.drops).toBe(6);
    expect(f.skipped).toBe(1); // the last week's drop
    expect(f.outcomes.map((o) => o.cleared)).toEqual([false, true, true, true, true]);
    for (const o of f.outcomes) {
      expect(o.rivals).toBe(9);
      expect(o.r).toBe(0);
      expect(o.value_known).toBe(false);
      expect(o.week).toBe(4);
    }
  });

  it("only executed FREEAGENT / WAIVER drops count: a failed claim's drop, a pending row, a trade do not", () => {
    const failedClaimWithDrop: Transaction = {
      ...claim("x", 2, 201, base, 4, false),
      items: [
        {
          type: "ADD",
          player_id: 300,
          name: null,
          from_team_id: null,
          to_team_id: 2,
          from_slot: null,
          to_slot: null,
        },
        {
          type: "DROP",
          player_id: 201,
          name: null,
          from_team_id: 2,
          to_team_id: null,
          from_slot: null,
          to_slot: null,
        },
      ],
    };
    const pending = txn({
      id: "p",
      type: "FREEAGENT",
      team: 3,
      player: 202,
      item: "DROP",
      ms: base,
      week: 4,
      status: "PENDING",
    });
    const trade = txn({
      id: "t",
      type: "TRADE_ACCEPT",
      team: 4,
      player: 203,
      item: "DROP",
      ms: base,
      week: 4,
    });
    const nullStatus = txn({
      id: "n",
      type: "FREEAGENT",
      team: 5,
      player: 204,
      item: "DROP",
      ms: base,
      week: 4,
      status: null,
    });
    const f = seasonFeedFromTransactions({
      season: 2025,
      transactions: [failedClaimWithDrop, pending, trade, nullStatus, last],
      teams: TEAMS,
    });
    expect(f.drops).toBe(2); // the null-status drop (reads as executed) and the last week's
    expect(f.outcomes).toHaveLength(1);
  });

  it("other seasons, the playoffs, unknown teams and duplicates are left out; values are read when known", () => {
    const txns = [
      drop("a", 1, 301, base, 4),
      drop("a-dup", 1, 301, base, 4), // the same drop seen twice
      drop("b", 1, 302, evening(2024, 4), 4), // last season
      drop("c", 1, 303, evening(2025, 9), 9), // past a regular season of 8
      drop("d", 77, 304, base, 4), // not a team of the league
      drop("e", 2, 305, base, 4),
      drop("f", 3, 306, base, 4),
      last,
    ];
    const values = new Map([
      [301, 3.5],
      [305, -2],
      [306, Number.NaN],
    ]);
    const f = seasonFeedFromTransactions({
      season: 2025,
      transactions: txns,
      teams: TEAMS,
      regular_season_weeks: 8,
      value_at: (p) => values.get(p) ?? null,
    });
    expect(f.drops).toBe(6); // a, c, d, e, f, last (the duplicate once; last season's never)
    expect(f.outcomes.map((o) => [o.r, o.value_known])).toEqual([
      [3.5, true],
      [0, true], // a negative value clamps to 0 and is still a known value
      [0, false], // NaN is value-free
    ]);
  });

  it("the drift is the season's claims won per team-week, regular season only", () => {
    const txns = [
      claim("c1", 1, 1, evening(2025, 2) + DAY / 2, 2),
      claim("c2", 2, 2, evening(2025, 2) + DAY / 2, 2),
      claim("c3", 3, 3, evening(2025, 9) + DAY / 2, 9),
      claim("c4", 4, 4, evening(2025, 3) + DAY / 2, 3, false),
      last,
    ];
    const f = seasonFeedFromTransactions({
      season: 2025,
      transactions: txns,
      teams: TEAMS,
      regular_season_weeks: 8,
    });
    expect(f.claim_runs).toBe(3);
    // weeks 2 and 3 had runs (week 9 is past the regular season): 2 weeks × 10 teams
    expect(f.drift).toHaveLength(20);
    expect(f.drift.filter((o) => o.count > 0).map((o) => [o.team_id, o.week])).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it("the team list defaults to every team the rows name; a one-team league has no rivals", () => {
    const f = seasonFeedFromTransactions({
      season: 2025,
      transactions: [drop("a", 1, 1, base, 4), claim("c", 2, 1, base + DAY / 2, 4), last],
    });
    expect(f.teams).toEqual([1, 2, 9]);
    expect(f.outcomes[0]?.rivals).toBe(2);
    const solo = seasonFeedFromTransactions({
      season: 2025,
      transactions: [drop("a", 1, 1, base, 4), drop("z", 1, 2, evening(2025, 6), 6)],
    });
    expect(solo.outcomes).toHaveLength(0);
    expect(solo.skipped).toBe(2);
  });

  it("property: every drop is an outcome or skipped; claimed iff another team won him inside the window", () => {
    const arb = fc.array(
      fc.record({
        kind: fc.constantFrom("drop", "claim", "error"),
        team: fc.integer({ min: 1, max: 4 }),
        player: fc.integer({ min: 1, max: 6 }),
        week: fc.integer({ min: 1, max: 6 }),
        offsetH: fc.integer({ min: 0, max: 24 * 10 }),
      }),
      { maxLength: 40 },
    );
    fc.assert(
      fc.property(arb, (rows) => {
        const txns = rows.map((r, i) => {
          const ms = evening(2025, r.week) + r.offsetH * 3600 * 1000;
          return r.kind === "drop"
            ? drop(`r${String(i)}`, r.team, r.player, ms, r.week)
            : claim(`r${String(i)}`, r.team, r.player, ms, r.week, r.kind === "claim");
        });
        const f = seasonFeedFromTransactions({
          season: 2025,
          transactions: txns,
          teams: [1, 2, 3, 4],
        });
        expect(f.outcomes.length + f.skipped).toBe(f.drops);
        // the independent reading: re-derive each kept drop's fate
        const lastWeek = Math.max(0, ...rows.map((r) => r.week));
        const seen = new Set<string>();
        const expected: boolean[] = [];
        rows.forEach((r) => {
          if (r.kind !== "drop") return;
          const ms = evening(2025, r.week) + r.offsetH * 3600 * 1000;
          const key = `${String(r.team)}:${String(r.player)}:${String(ms)}`;
          if (seen.has(key)) return;
          seen.add(key);
          if (r.week >= lastWeek) return;
          const claimed = rows.some((c) => {
            if (c.kind !== "claim" || c.team === r.team || c.player !== r.player) return false;
            const cms = evening(2025, c.week) + c.offsetH * 3600 * 1000;
            return cms > ms && cms <= ms + WAIVER_FIT.history.fateWindowMs;
          });
          expected.push(!claimed);
        });
        expect(f.outcomes.map((o) => o.cleared)).toEqual(expected);
      }),
    );
  });
});

describe("fitHistoryDemand", () => {
  const o = (r: number, cleared: boolean, known = false, rivals = 9): HistoryOutcome => ({
    week: 3,
    r,
    rivals,
    cleared,
    value_known: known,
  });

  it("below 30 candidates the curve stays cold, with the reason", () => {
    const d = fitHistoryDemand(Array.from({ length: 29 }, (_, i) => o(0, i > 0)));
    expect(d.curve).toBeNull();
    expect(d.n).toBe(29);
    expect(d.reasons[0]).toContain("29 waiver candidate(s)");
  });

  it("value-free drops: the intercept alone, at its closed form, the slope the cold start's", () => {
    // 95 % of worthless drops clear with 9 rivals: (1 − q0)^9 = 0.95
    const outs = Array.from({ length: 200 }, (_, i) => o(0, i < 190));
    const d = fitHistoryDemand(outs);
    expect(d.curve?.basis).toBe("intercept");
    expect(d.curve?.q1).toBe(WAIVER_DP.q1);
    expect(d.curve?.q0 ?? 0).toBeCloseTo(1 - 0.95 ** (1 / 9), 4);
    expect(d.reasons[0]).toContain("slope stays the cold start's");
    expect(d.log_likelihood ?? -1).toBeGreaterThanOrEqual(d.log_likelihood_cold ?? 0);
  });

  it("valued drops that all cleared never fit a slope (R6-3): the intercept alone", () => {
    const outs = [
      ...Array.from({ length: 100 }, (_, i) => o(0, i < 96, true)),
      ...Array.from({ length: 20 }, () => o(4, true, true)),
    ];
    const d = fitHistoryDemand(outs);
    expect(d.valued).toBe(20);
    expect(d.valued_claimed).toBe(0);
    expect(d.curve?.basis).toBe("intercept");
    expect(d.curve?.q1).toBe(WAIVER_DP.q1);
  });

  it("claims at value fit the slope; a flat optimum on its bound keeps the cold slope", () => {
    // demand rises with value: worthless drops clear 96 %, valued ones are mostly claimed
    const rising = [
      ...Array.from({ length: 100 }, (_, i) => o(0, i < 96, true)),
      ...Array.from({ length: 30 }, (_, i) => o(5, i < 6, true)),
    ];
    const d = fitHistoryDemand(rising);
    expect(d.valued_claimed).toBe(24);
    expect(d.curve?.basis).toBe("curve");
    expect(d.curve?.q1 ?? 0).toBeGreaterThan(WAIVER_FIT.demandCurve.q1.min * 1.01);
    // flat: valued candidates are claimed no more often than worthless ones
    const flat = [
      ...Array.from({ length: 100 }, (_, i) => o(0, i < 80, true)),
      ...Array.from({ length: 50 }, (_, i) => o(6, i < 45, true)),
    ];
    const g = fitHistoryDemand(flat);
    expect(g.valued_claimed).toBe(5);
    expect(g.curve?.basis).toBe("intercept");
    expect(g.reasons.join(" ")).toContain("lower bound");
  });

  it("hostile outcomes (NaN, negative r, no rivals) are not counted", () => {
    const outs = [
      ...Array.from({ length: 30 }, () => o(0, true)),
      o(Number.NaN, true),
      o(-1, true),
      o(0, true, false, 0),
    ];
    expect(fitHistoryDemand(outs).n).toBe(30);
  });
});

describe("fitDemandIntercept", () => {
  it("homogeneous worthless drops recover 1 − rate^(1/m); empty is the cold intercept; the bound is flagged", () => {
    const outs = (n: number, cleared: number, rivals: number) =>
      Array.from({ length: n }, (_, i) => ({ r: 0, rivals, cleared: i < cleared }));
    expect(fitDemandIntercept(outs(100, 90, 11)).q0).toBeCloseTo(1 - 0.9 ** (1 / 11), 4);
    const empty = fitDemandIntercept([]);
    expect(empty.q0).toBe(WAIVER_DP.q0);
    expect(empty.n).toBe(0);
    expect(fitDemandIntercept(outs(50, 50, 9)).at_bound).toBe(true); // nothing claimed: q0 → min
    expect(fitDemandIntercept([{ r: Number.NaN, rivals: 9, cleared: true }]).rejected).toBe(1);
  });

  it("property: the fitted intercept never loses to the cold intercept on its own data", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            r: fc.double({ min: 0, max: 8, noNaN: true }),
            cleared: fc.boolean(),
          }),
          { minLength: 1, maxLength: 60 },
        ),
        (rows) => {
          const f = fitDemandIntercept(rows.map((x) => ({ ...x, rivals: 9 })));
          expect(f.log_likelihood ?? -1).toBeGreaterThanOrEqual(
            (f.log_likelihood_cold ?? 0) - 1e-6,
          );
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe("fitPremiumFromHistory", () => {
  const s24 = season(2024, 12, 1);
  const s25 = season(2025, 12, 1);
  const feed24 = seasonFeedFromTransactions({ season: 2024, transactions: s24.txns, teams: TEAMS });
  const feed25 = seasonFeedFromTransactions({ season: 2025, transactions: s25.txns, teams: TEAMS });
  const current = (txns: readonly Transaction[] = []) => ({
    season: 2026,
    transactions: txns,
    standings: TEAMS.map((t) => ({
      team_id: t,
      transaction_counter: {
        acquisitions: 0,
        drops: 0,
        trades: 0,
        move_to_ir: 0,
        move_to_active: 0,
        budget_spent: null,
        matchup_acquisitions: {},
      },
    })),
    periods_played: [],
  });

  it("previous seasons make the basis league_fitted from the first call (no run logged)", () => {
    const fit = fitPremiumFromHistory({
      teams: 10,
      feeds: [feed24, feed25],
      runs: [],
      current: current(),
    });
    expect(fit.basis).toBe("league_fitted");
    expect(fit.demand_curve?.basis).toBe("intercept");
    expect(fit.demand_curve?.n).toBe(2 * 13 * 12);
    expect(fit.history?.seasons).toEqual([2025, 2024]);
    expect(fit.history?.claim_runs).toBe(26);
    expect(fit.summary).toContain("seasons 2025, 2024");
    expect(fit.summary).toContain(`${String(2 * 13 * 12)} drops`);
    expect(fit.summary).toContain("value-free");
    expect(fit.summary.length).toBeLessThanOrEqual(TEXT_CAPS.rec_log_text);
    expect(fit.reasons.join(" ")).toContain("surplus distribution: the cold-start table");
    // the DP is the one solved with the league's curve and drift over the cold surplus table
    const q0 = fit.demand_curve?.q0 ?? 0;
    const dp = solvePremiumTable({
      teams: 10,
      rates: fit.surplus.rates,
      drift: fit.drift.c,
      demandCurve: { q0, q1: WAIVER_DP.q1 },
    });
    expect(fit.base.premium(2, 12)).toBeCloseTo(dp.premium(2, 12), 9);
    expect(fit.drift.basis).toBe("claims");
    // its band brackets it
    expect(fit.low.premium(2, 12)).toBeLessThanOrEqual(fit.base.premium(2, 12));
    expect(fit.high.premium(2, 12)).toBeGreaterThanOrEqual(fit.base.premium(2, 12));
  });

  it("the newest two previous seasons only; a season at or after the current one is ignored", () => {
    const s23 = season(2023, 12, 6);
    const feed23 = seasonFeedFromTransactions({
      season: 2023,
      transactions: s23.txns,
      teams: TEAMS,
    });
    const feed26 = { ...feed25, season: 2026 };
    const fit = fitPremiumFromHistory({
      teams: 10,
      feeds: [feed23, feed24, feed26, feed25],
      runs: [],
      current: current(),
    });
    expect(fit.history?.seasons).toEqual([2025, 2024]);
  });

  it("two seasons' week numbers never collide in the drift (season-qualified team-weeks)", () => {
    const fit = fitPremiumFromHistory({
      teams: 10,
      feeds: [feed24, feed25],
      runs: [],
      current: current(),
    });
    expect(fit.drift.team_weeks).toBe(feed24.drift.length + feed25.drift.length);
    expect(fit.drift.rejected).toBe(0);
  });

  it("too thin a history stays cold and says why; nothing at all says no history is stored", () => {
    const thin = season(2025, 2, 1);
    const feed = seasonFeedFromTransactions({
      season: 2025,
      transactions: thin.txns,
      teams: TEAMS,
    });
    const a = fitPremiumFromHistory({ teams: 10, feeds: [feed], runs: [], current: current() });
    expect(a.basis).toBe("cold_start_table");
    expect(a.demand_curve).toBeNull();
    expect(a.reasons.join(" ")).toContain("26 waiver candidate(s)");
    const b = fitPremiumFromHistory({ teams: 10, feeds: [], runs: [], current: current() });
    expect(b.basis).toBe("cold_start_table");
    expect(b.reasons[0]).toContain("no previous-season transactions");
    expect(b.base.premium(2, 12)).toBeCloseTo(solvePremiumTable({ teams: 10 }).premium(2, 12), 9);
  });

  it("without history it is the 13-logged-runs path: the same premium as fitPremiumFromFeed", () => {
    const runs = Array.from({ length: 14 }, () => ({ W: 12, candidates: [{ s: 39 }, { s: 5 }] }));
    const cur = current([
      claim("k1", 1, 1, evening(2026, 2), 2),
      claim("k2", 2, 2, evening(2026, 3), 3),
    ]);
    const h = fitPremiumFromHistory({ teams: 10, feeds: [], runs, current: cur });
    const f = fitPremiumFromFeed({
      teams: 10,
      transactions: cur.transactions,
      standings: cur.standings,
      periods_played: [],
      runs,
    });
    expect(h.basis).toBe("league_fitted");
    expect(h.demand_curve).toBeNull();
    expect(h.drift.c).toBe(f.drift.c);
    expect(h.base.premium(3, 9)).toBeCloseTo(f.base.premium(3, 9), 9);
    expect(h.summary).toBe(f.summary);
  });

  it("history and 13 runs together: the league's curve and its own surplus", () => {
    const runs = Array.from({ length: 13 }, () => ({ W: 12, candidates: [{ s: 39 }] }));
    const fit = fitPremiumFromHistory({ teams: 10, feeds: [feed25], runs, current: current() });
    expect(fit.basis).toBe("league_fitted");
    expect(fit.demand_curve).not.toBeNull();
    expect(fit.summary).toContain("surplus 13 runs");
  });

  it("property: the summary never exceeds the assumption cap", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 600 }), (t) => {
        expect(capSummary(t).length).toBeLessThanOrEqual(TEXT_CAPS.rec_log_text);
        if (t.length <= TEXT_CAPS.rec_log_text) expect(capSummary(t)).toBe(t);
      }),
    );
    const many: SeasonWaiverFeed = {
      ...feed25,
      outcomes: Array.from({ length: 99999 }, (_, i) => ({
        week: 3,
        r: 0,
        rivals: 9,
        cleared: i % 50 !== 0,
        value_known: false,
      })),
    };
    const fit = fitPremiumFromHistory({
      teams: 10,
      feeds: [many, feed24],
      runs: [],
      current: current(),
    });
    expect(fit.summary.length).toBeLessThanOrEqual(TEXT_CAPS.rec_log_text);
  });
});

describe("coldStartNote / curveDemand", () => {
  it("states which part is cold and its measured miss, inside the cap; null when both are fitted", () => {
    const m = WAIVER_FIT.coldStartMiss;
    const both = coldStartNote(true, true) ?? "";
    expect(both).toContain(`${String(m.clearsPoints.min)}–${String(m.clearsPoints.max)}`);
    expect(both).toContain(`×${String(m.premiumRatio.min)}–×${String(m.premiumRatio.max)}`);
    expect(both).toContain(m.source);
    expect(coldStartNote(false, true)).toContain("cold-start demand curve");
    expect(coldStartNote(false, true)).not.toContain("Π ×");
    expect(coldStartNote(true, false)).toContain("cold-start premium table");
    expect(coldStartNote(false, false)).toBeNull();
    // the league's own intercept beside the cold slope: the slope part is said with its own miss
    expect(coldStartNote(false, false, true)).toContain("cold-start demand slope");
    expect(coldStartNote(false, false, true)).toContain(String(m.slopeClearsPoints));
    // a cold curve's statement already covers its slope
    expect(coldStartNote(false, true, true)).toBe(coldStartNote(false, true));
    for (const t of [
      coldStartNote(true, true),
      coldStartNote(false, true),
      coldStartNote(true, false),
      coldStartNote(false, false, true),
    ])
      expect((t ?? "").length).toBeLessThanOrEqual(TEXT_CAPS.rec_log_text);
    expect(COLD_START_REVISIT.length).toBeLessThanOrEqual(TEXT_CAPS.rec_log_text);
  });

  it("the curve's q(r): intercept plus slope, capped, r ≤ 0 reads the intercept; null without a curve", () => {
    expect(curveDemand(null, 3)).toBeNull();
    expect(curveDemand({ q0: 0.01, q1: 0.08 }, 2)).toBeCloseTo(0.17, 12);
    expect(curveDemand({ q0: 0.01, q1: 0.08 }, -5)).toBeCloseTo(0.01, 12);
    expect(curveDemand({ q0: 0.01, q1: 0.08 }, Number.NaN)).toBeCloseTo(0.01, 12);
    expect(curveDemand({ q0: 0.5, q1: 1 }, 50)).toBe(WAIVER_DP.qCap);
    expect(curveDemand({ q0: 0.01, q1: 0.08 }, 2, 1.5)).toBeCloseTo(0.255, 12);
  });
});

describe("the DP's demand curve (waiverDp.ts, additive)", () => {
  it("the cold-start curve passed explicitly reproduces the cold table cell for cell", () => {
    const cold = solvePremiumTable({ teams: 10 });
    const same = solvePremiumTable({
      teams: 10,
      demandCurve: { q0: WAIVER_DP.q0, q1: WAIVER_DP.q1 },
    });
    for (let k = 1; k <= 10; k++)
      for (const W of [0, 1, 5, 9, 13, 16])
        expect(same.premium(k, W)).toBeCloseTo(cold.premium(k, W), 12);
    const other = solvePremiumTable({ teams: 10, demandCurve: { q0: 0.005, q1: 0.08 } });
    expect(other.premium(1, 9)).not.toBeCloseTo(cold.premium(1, 9), 3);
  });

  it("a malformed curve is refused", () => {
    for (const bad of [
      { q0: -0.1, q1: 0.08 },
      { q0: 0.05, q1: Number.NaN },
      { q0: Number.POSITIVE_INFINITY, q1: 0 },
      null as unknown as { q0: number; q1: number },
      { q0: "0.05", q1: 0.08 } as unknown as { q0: number; q1: number },
    ])
      expect(() => solvePremiumTable({ teams: 10, demandCurve: bad })).toThrow(RangeError);
  });

  it("property: the band brackets Π for any curve (×0.5 ≤ ×1 ≤ ×1.5 surplus)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 0.3, noNaN: true }),
        fc.double({ min: 0, max: 0.3, noNaN: true }),
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 16 }),
        (q0, q1, k, W) => {
          const c = { q0, q1 };
          const lo = solvePremiumTable({ teams: 10, demandCurve: c, surplusScale: 0.5 }).premium(
            k,
            W,
          );
          const mid = solvePremiumTable({ teams: 10, demandCurve: c }).premium(k, W);
          const hi = solvePremiumTable({ teams: 10, demandCurve: c, surplusScale: 1.5 }).premium(
            k,
            W,
          );
          expect(lo).toBeLessThanOrEqual(mid + 1e-9);
          expect(mid).toBeLessThanOrEqual(hi + 1e-9);
        },
      ),
      { numRuns: 40 },
    );
  });
});
