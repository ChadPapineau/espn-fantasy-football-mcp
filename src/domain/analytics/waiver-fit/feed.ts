// feed.ts — the fitted premium from what the E5 tool already holds (plan 10 C5; plan 07 E5 Data:
// A6 history, A2 standings): the league's persisted transactions (`transactions_seen`, mTransactions2
// — cookie-authenticated) give the drift from processed claims; without any processed claim, the
// standings' per-period acquisition totals give its upper bound; the logged E5 runs (each run's `W`
// and its candidates' `s`) give the surplus distribution. One call, so the tool layer wires one
// function. A run's fantasy week is the `scoring_period` ESPN stamps on the transactions processed
// with it. Pure. New here (Phase 3).
import type { Standing, Transaction } from "../../league/types.js";
import { claimRuns } from "../demand.js";
import { driftFromAcquisitions, driftFromClaimRuns, fitDrift } from "./drift.js";
import { fitLeaguePremium, type LeaguePremiumFit } from "./fit.js";
import { surplusObservationsFromRuns } from "./surplus.js";

/**
 * Maps a processed run's instant to its fantasy week: the `scoring_period` of the transactions
 * processed at that instant (the most common one when they disagree; ties → the earlier week).
 */
export function weekOfFromTransactions(
  transactions: readonly Transaction[],
): (processMs: number) => number | null {
  const votes = new Map<number, Map<number, number>>();
  for (const t of transactions) {
    if (t.process_date === null || t.scoring_period === null) continue;
    if (!Number.isInteger(t.scoring_period) || t.scoring_period < 1) continue;
    const ms = Date.parse(t.process_date);
    if (!Number.isFinite(ms)) continue;
    const v = votes.get(ms) ?? new Map<number, number>();
    v.set(t.scoring_period, (v.get(t.scoring_period) ?? 0) + 1);
    votes.set(ms, v);
  }
  const week = new Map<number, number>();
  for (const [ms, v] of votes) {
    let best: [number, number] | null = null;
    for (const [w, n] of v)
      if (best === null || n > best[1] || (n === best[1] && w < best[0])) best = [w, n];
    if (best !== null) week.set(ms, best[0]);
  }
  return (ms) => week.get(ms) ?? null;
}

/** The fitted premium from the league's feed (see the header). */
export function fitPremiumFromFeed(input: {
  readonly teams: number;
  /** The league's persisted transactions (any order, any age; empty without cookies). */
  readonly transactions: readonly Transaction[];
  /** The standings (team ids; per-period acquisition totals for the bound). */
  readonly standings: readonly Pick<Standing, "team_id" | "transaction_counter">[];
  /** The regular-season matchup periods that have been played (the acquisition totals' keys). */
  readonly periods_played: readonly number[];
  /** The logged E5 runs, one per processing run. */
  readonly runs: readonly {
    readonly W: number;
    readonly candidates: readonly { readonly s: number }[];
  }[];
  readonly demand_scale?: number | null;
}): LeaguePremiumFit {
  const runs = claimRuns(input.transactions);
  const teams = input.standings.map((s) => s.team_id);
  const claims = driftFromClaimRuns(runs, {
    teams,
    weekOf: weekOfFromTransactions(input.transactions),
  });
  const drift =
    claims.length > 0
      ? fitDrift(claims, "claims")
      : fitDrift(driftFromAcquisitions(input.standings, input.periods_played), "acquisitions");
  return fitLeaguePremium({
    teams: input.teams,
    surplus: surplusObservationsFromRuns(input.runs),
    drift,
    demand_scale: input.demand_scale ?? null,
  });
}
