// drift.ts — the league's own drift c (research 05 §1.2: "c = a rival's per-week probability of a
// successful claim" — rivals ahead of me who win drop below me; §1.6 eval 3; plan 10 C5). Two kinds
// of evidence, never mixed:
//   * claims — the league's processed waiver runs (mTransactions2 WAIVER rows via demand.ts
//     `claimRuns`): a team-week counts when the team won ≥ 1 claim that week. c is the Beta
//     posterior mean with the cold-start c as a prior worth WAIVER_FIT.driftPriorTeamWeeks.
//   * acquisitions — `transactionCounter.matchupAcquisitionTotals` (mTeam, keyless on a public
//     league): every successful claim is an acquisition but free-agent adds are too, so the share of
//     team-weeks with an acquisition only BOUNDS c from above. c is then the prior, cut to that bound
//     when the bound is lower (the data rules the prior out) — never the bound itself.
// Below WAIVER_FIT.minTeamWeeks team-weeks c stays the prior. Pure. New here (Phase 3).
import type { ClaimRun } from "../demand.js";
import { clamp, round } from "../math.js";
import { WAIVER_FIT } from "./constants.js";

/** One team-week: how many claims (or acquisitions) the team made that week. */
export interface DriftObservation {
  readonly team_id: number;
  readonly week: number;
  readonly count: number;
}

/** The evidence a set of observations is (see the header). */
export type DriftEvidence = "claims" | "acquisitions";

/** A fitted drift. */
export interface DriftFit {
  /** The c the DP is solved with. */
  readonly c: number;
  readonly basis: "prior" | "claims" | "prior_within_acquisition_bound" | "acquisition_bound";
  readonly evidence: DriftEvidence | null;
  readonly team_weeks: number;
  /** Team-weeks with ≥ 1 claim (or acquisition). */
  readonly team_weeks_active: number;
  /** team_weeks_active / team_weeks (null with none). */
  readonly observed_rate: number | null;
  /** The acquisition share that bounds c from above (acquisitions evidence only). */
  readonly upper_bound: number | null;
  readonly prior_c: number;
  /** A 90 % interval for c (the Beta posterior's normal approximation; [0, bound] when bounded). */
  readonly interval: readonly [number, number];
  /** Observations rejected (non-finite or negative counts, bad ids or weeks, duplicates). */
  readonly rejected: number;
}

/**
 * Team-week observations from the league's processed claim runs: every listed team × every week
 * a run was processed, counting the claims it WON that week. `weekOf` maps a run's process instant
 * to its fantasy week (null = outside the season: skipped).
 */
export function driftFromClaimRuns(
  runs: readonly ClaimRun[],
  opts: {
    readonly teams: readonly number[];
    readonly weekOf: (processMs: number) => number | null;
  },
): DriftObservation[] {
  const won = new Map<string, number>();
  const weeks = new Set<number>();
  for (const run of runs) {
    const w = opts.weekOf(run.process_ms);
    if (w === null || !Number.isInteger(w) || w < 1) continue;
    weeks.add(w);
    for (const c of run.claims)
      if (c.won) {
        const k = `${String(c.team_id)}:${String(w)}`;
        won.set(k, (won.get(k) ?? 0) + 1);
      }
  }
  const teams = [...new Set(opts.teams)].filter((t) => Number.isInteger(t)).sort((a, b) => a - b);
  const out: DriftObservation[] = [];
  for (const week of [...weeks].sort((a, b) => a - b))
    for (const team_id of teams)
      out.push({ team_id, week, count: won.get(`${String(team_id)}:${String(week)}`) ?? 0 });
  return out;
}

/**
 * Team-week observations from the standings' per-period acquisition totals (`Standing.
 * transaction_counter.matchup_acquisitions`), for the given matchup periods (the regular season):
 * an absent period is 0 acquisitions.
 */
export function driftFromAcquisitions(
  standings: readonly {
    readonly team_id: number;
    readonly transaction_counter: {
      readonly matchup_acquisitions: Readonly<Record<string, number>>;
    };
  }[],
  periods: readonly number[],
): DriftObservation[] {
  const out: DriftObservation[] = [];
  for (const t of standings)
    for (const p of periods) {
      const m = t.transaction_counter.matchup_acquisitions;
      const v = Object.hasOwn(m, String(p)) ? m[String(p)] : 0;
      out.push({ team_id: t.team_id, week: p, count: typeof v === "number" ? v : Number.NaN });
    }
  return out;
}

/** Fits c from team-week observations of one kind of evidence (see the header). */
export function fitDrift(
  observations: readonly DriftObservation[],
  evidence: DriftEvidence,
  opts: { readonly prior_c?: number; readonly prior_team_weeks?: number } = {},
): DriftFit {
  const prior =
    opts.prior_c !== undefined && opts.prior_c >= 0 && opts.prior_c < 1
      ? opts.prior_c
      : WAIVER_FIT.driftPrior;
  const m =
    opts.prior_team_weeks !== undefined &&
    Number.isFinite(opts.prior_team_weeks) &&
    opts.prior_team_weeks >= 0
      ? opts.prior_team_weeks
      : WAIVER_FIT.driftPriorTeamWeeks;
  const seen = new Set<string>();
  let n = 0;
  let x = 0;
  let rejected = 0;
  for (const o of observations) {
    const key = `${String(o.team_id)}:${String(o.week)}`;
    if (
      !Number.isInteger(o.team_id) ||
      !Number.isInteger(o.week) ||
      o.week < 0 ||
      !Number.isFinite(o.count) ||
      o.count < 0 ||
      seen.has(key)
    ) {
      rejected += 1;
      continue;
    }
    seen.add(key);
    n += 1;
    if (o.count >= 1) x += 1;
  }
  const rate = n > 0 ? x / n : null;
  const base = {
    evidence: n > 0 ? evidence : null,
    team_weeks: n,
    team_weeks_active: x,
    observed_rate: rate === null ? null : round(rate, 4),
    prior_c: prior,
    rejected,
  };
  // the prior alone: a Beta(prior·m, (1 − prior)·m) interval
  const betaInterval = (a: number, b: number): [number, number] => {
    const mean = a / (a + b);
    const sd = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)));
    return [
      round(clamp(mean - WAIVER_FIT.z90 * sd, 0, 1), 4),
      round(clamp(mean + WAIVER_FIT.z90 * sd, 0, 1), 4),
    ];
  };
  const priorInterval =
    m > 0 ? betaInterval(prior * m, (1 - prior) * m) : ([prior, prior] as [number, number]);
  if (n < WAIVER_FIT.minTeamWeeks || rate === null)
    return Object.freeze({
      ...base,
      c: prior,
      basis: "prior",
      upper_bound: evidence === "acquisitions" && rate !== null ? round(rate, 4) : null,
      interval: Object.freeze(priorInterval),
    });
  if (evidence === "claims") {
    const a = prior * m + x;
    const b = (1 - prior) * m + (n - x);
    return Object.freeze({
      ...base,
      c: round(clamp(a / (a + b), 0, 0.999), 4),
      basis: "claims",
      upper_bound: null,
      interval: Object.freeze(betaInterval(a, b)),
    });
  }
  const bound = round(rate, 4);
  const cut = bound < prior;
  return Object.freeze({
    ...base,
    c: cut ? round(Math.min(bound, 0.999), 4) : prior,
    basis: cut ? "acquisition_bound" : "prior_within_acquisition_bound",
    upper_bound: bound,
    interval: Object.freeze([
      round(Math.min(priorInterval[0], bound), 4),
      round(Math.min(priorInterval[1], bound), 4),
    ] as const),
  });
}
