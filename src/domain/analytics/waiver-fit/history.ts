// history.ts — a league's previous seasons as its own waiver feed (changelog R6-3; plan 07 E5 "the
// league's own feed re-solves Π", `premium_basis: "league_fitted"`; research 05 §1.3 the demand
// curve, §1.6 eval 2–3, §8.4's ~30-observation floor). A finished season's transactions show every
// player a team dropped and whether another team's claim took him in the next waiver cycle — the
// sample that identifies the demand curve's intercept (demand for a player worth nothing). The
// slope (how demand rises with value) is read from the data only when the feed shows claims AT
// value: R6-3 ruled that a slope read off drops that cleared would call a starter-calibre drop
// near-certain to clear, the one case the tool must get right — so without that evidence the slope
// stays the cold start's. The DP is then re-solved with the league's own curve, its drift (claims
// won per team-week, pooled over its seasons) and whatever surplus runs E5 has logged, so the basis
// is `league_fitted` from the first call; the 13-logged-runs path (feed.ts) stays for a league
// without history. Whenever the cold start is served, `coldStartNote` states its measured miss.
// Pure; every input is data, never an instruction. New here (Stage C).
import type { Standing, Transaction } from "../../league/types.js";
import { WAIVER_DP } from "../constants.js";
import { claimRuns, type ClaimRun } from "../demand.js";
import { fitDemandCurve, fitDemandIntercept, type ClearsOutcome } from "./calibration.js";
import { WAIVER_FIT } from "./constants.js";
import {
  driftFromAcquisitions,
  driftFromClaimRuns,
  fitDrift,
  type DriftObservation,
} from "./drift.js";
import { weekOfFromTransactions } from "./feed.js";
import {
  fitLeaguePremium,
  type FittedDemandCurve,
  type LeaguePremiumFit,
  type PremiumHistory,
} from "./fit.js";
import { surplusObservationsFromRuns } from "./surplus.js";

/** One waiver candidate of a previous season: a dropped player and his visible fate. */
export interface HistoryOutcome extends ClearsOutcome {
  /** The scoring period of the drop. */
  readonly week: number;
  /** r is the player's value over replacement (true) or the value-free 0 (false). */
  readonly value_known: boolean;
}

/** One previous season's waiver feed (JSON-serialisable; derived, never stored as truth). */
export interface SeasonWaiverFeed {
  readonly season: number;
  /** The league's team ids that season (rivals per candidate = teams − 1). */
  readonly teams: readonly number[];
  /** Drops with a visible fate (the demand curve's sample). */
  readonly outcomes: readonly HistoryOutcome[];
  /** Team-weeks of claims won (that season's scoring periods). */
  readonly drift: readonly DriftObservation[];
  /** Processed claim runs (WAIVER / WAIVER_ERROR rows grouped by process instant). */
  readonly claim_runs: number;
  /** Drops seen, and those left out (no later cycle to show their fate, past the regular season). */
  readonly drops: number;
  readonly skipped: number;
}

/** The demand curve fitted from previous seasons (null curve: the cold start, with the reason). */
export interface HistoryDemandFit {
  readonly curve: FittedDemandCurve | null;
  readonly n: number;
  readonly cleared: number;
  readonly value_known: number;
  readonly valued: number;
  readonly valued_claimed: number;
  /** Mean log-likelihood of the outcomes under the curve used and under the cold start. */
  readonly log_likelihood: number | null;
  readonly log_likelihood_cold: number | null;
  /** Why the curve stayed cold or the slope stayed the cold start's (generated text). */
  readonly reasons: readonly string[];
}

/**
 * The NFL season an instant belongs to: a season runs from late summer into January, so an instant
 * in January or February belongs to the previous calendar year's season (UTC). Null when unparsable.
 */
export function seasonOfInstant(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  return d.getUTCMonth() >= 2 ? y : y - 1;
}

/** The transactions grouped by the season of their processed (else proposed) instant. */
export function transactionsBySeason(
  transactions: readonly Transaction[],
): Map<number, Transaction[]> {
  const out = new Map<number, Transaction[]>();
  for (const t of transactions) {
    const s = seasonOfInstant(t.process_date ?? t.proposed_date);
    if (s === null) continue;
    const list = out.get(s) ?? [];
    list.push(t);
    out.set(s, list);
  }
  return out;
}

/** A transaction that happened (ESPN `EXECUTED`; a null status reads as executed). */
function executed(t: Transaction): boolean {
  return t.status === null || t.status === "EXECUTED";
}

const DROP_TYPES: ReadonlySet<string> = new Set(["FREEAGENT", "WAIVER"]);

/**
 * One previous season's feed from its transactions (mTransactions2 rows, any order): every DROP
 * item of an executed FREEAGENT or WAIVER transaction is a waiver candidate; he was **claimed** when
 * another team won a claim of him in a run processed within WAIVER_FIT.history.fateWindowMs after
 * the drop, else he **cleared**. A drop in the season's last week with transactions (no later cycle
 * shows its fate) or past `regular_season_weeks` (eliminated teams stop claiming) is skipped. r is
 * `value_at(player, week)` when known (his per-week value over replacement), else 0 (value-free). The
 * drift is the season's claims won per team-week (regular season).
 */
export function seasonFeedFromTransactions(input: {
  readonly season: number;
  readonly transactions: readonly Transaction[];
  /** The league's team ids that season; default: every team id the transactions name. */
  readonly teams?: readonly number[] | null;
  /** The regular season's last scoring period (null = no cap). */
  readonly regular_season_weeks?: number | null;
  readonly value_at?: ((playerId: number, week: number) => number | null) | null;
}): SeasonWaiverFeed {
  const txns = input.transactions.filter(
    (t) => seasonOfInstant(t.process_date ?? t.proposed_date) === input.season,
  );
  const teamOk = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x > 0;
  const named = new Set<number>();
  for (const t of txns) {
    if (teamOk(t.team_id)) named.add(t.team_id);
    for (const i of t.items) {
      if (teamOk(i.from_team_id)) named.add(i.from_team_id);
      if (teamOk(i.to_team_id)) named.add(i.to_team_id);
    }
  }
  const teams = [...new Set((input.teams ?? [...named]).filter(teamOk))].sort((a, b) => a - b);
  const reg =
    input.regular_season_weeks !== undefined &&
    input.regular_season_weeks !== null &&
    Number.isInteger(input.regular_season_weeks) &&
    input.regular_season_weeks >= 1
      ? input.regular_season_weeks
      : null;
  const runs: ClaimRun[] = claimRuns(txns);
  const weekOf = weekOfFromTransactions(txns);
  let lastWeek = 0;
  for (const t of txns)
    if (t.scoring_period !== null && Number.isInteger(t.scoring_period))
      lastWeek = Math.max(lastWeek, t.scoring_period);
  // won claims by player: the instants and the claiming teams
  const wonBy = new Map<number, { ms: number; team: number }[]>();
  for (const run of runs)
    for (const c of run.claims)
      if (c.won) {
        const list = wonBy.get(c.player_id) ?? [];
        list.push({ ms: run.process_ms, team: c.team_id });
        wonBy.set(c.player_id, list);
      }
  const window = WAIVER_FIT.history.fateWindowMs;
  const rivals = Math.max(0, teams.length - 1);
  const seen = new Set<string>();
  const outcomes: HistoryOutcome[] = [];
  let drops = 0;
  let skipped = 0;
  for (const t of txns) {
    if (!DROP_TYPES.has(t.type) || !executed(t) || t.process_date === null) continue;
    const ms = Date.parse(t.process_date);
    if (!Number.isFinite(ms)) continue;
    for (const item of t.items) {
      if (item.type !== "DROP" || !Number.isInteger(item.player_id)) continue;
      const team = item.from_team_id ?? t.team_id;
      if (!teamOk(team)) continue;
      const key = `${String(team)}:${String(item.player_id)}:${String(ms)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      drops += 1;
      const week = t.scoring_period ?? weekOf(ms);
      if (
        week === null ||
        !Number.isInteger(week) ||
        week < 1 ||
        week >= lastWeek ||
        (reg !== null && week > reg) ||
        rivals < 1 ||
        !teams.includes(team)
      ) {
        skipped += 1;
        continue;
      }
      const claimed = (wonBy.get(item.player_id) ?? []).some(
        (c) => c.team !== team && c.ms > ms && c.ms <= ms + window,
      );
      const v = input.value_at?.(item.player_id, week) ?? null;
      const known = v !== null && Number.isFinite(v);
      outcomes.push({
        week,
        r: known ? Math.max(0, v) : 0,
        rivals,
        cleared: !claimed,
        value_known: known,
      });
    }
  }
  const drift = driftFromClaimRuns(runs, { teams, weekOf }).filter(
    (o) => reg === null || o.week <= reg,
  );
  return Object.freeze({
    season: input.season,
    teams: Object.freeze(teams),
    outcomes: Object.freeze(outcomes),
    drift: Object.freeze(drift),
    claim_runs: runs.length,
    drops,
    skipped,
  });
}

/**
 * The demand curve from previous seasons' waiver candidates (see the header): at least
 * WAIVER_FIT.history.minOutcomes of them to leave the cold start; the slope from the data only with
 * ≥ minValued valued candidates of which ≥ minValuedClaims were claimed and an optimum off its
 * lower bound; otherwise the intercept alone, the slope held at the cold start's.
 */
export function fitHistoryDemand(outcomes: readonly HistoryOutcome[]): HistoryDemandFit {
  const ok = outcomes.filter(
    (o) =>
      Number.isFinite(o.r) &&
      o.r >= 0 &&
      Number.isFinite(o.rivals) &&
      o.rivals >= 1 &&
      typeof o.cleared === "boolean",
  );
  const H = WAIVER_FIT.history;
  const n = ok.length;
  const cleared = ok.filter((o) => o.cleared).length;
  const known = ok.filter((o) => o.value_known).length;
  const valued = ok.filter((o) => o.value_known && o.r >= H.valuedRate);
  const valuedClaimed = valued.filter((o) => !o.cleared).length;
  const base = {
    n,
    cleared,
    value_known: known,
    valued: valued.length,
    valued_claimed: valuedClaimed,
  };
  if (n < H.minOutcomes)
    return Object.freeze({
      ...base,
      curve: null,
      log_likelihood: null,
      log_likelihood_cold: null,
      reasons: Object.freeze([
        `the league's previous seasons show ${String(n)} waiver candidate(s) with a visible fate, fewer than the ${String(H.minOutcomes)} a fitted demand curve needs`,
      ]),
    });
  const reasons: string[] = [];
  if (valued.length >= H.minValued && valuedClaimed >= H.minValuedClaims) {
    const full = fitDemandCurve(ok);
    if (!full.at_bound.q1)
      return Object.freeze({
        ...base,
        curve: Object.freeze({ q0: full.q0, q1: full.q1, basis: "curve" as const, n }),
        log_likelihood: full.log_likelihood,
        log_likelihood_cold: full.log_likelihood_cold,
        reasons: Object.freeze([]),
      });
    reasons.push(
      "the fitted slope sits on its lower bound (flat demand): the cold start's slope is kept",
    );
  } else
    reasons.push(
      `the slope stays the cold start's ${String(WAIVER_DP.q1)}: ${String(valuedClaimed)} of ${String(valued.length)} valued candidates were claimed (a value slope needs ${String(H.minValuedClaims)} claims of ${String(H.minValued)}+ valued candidates)`,
    );
  const icpt = fitDemandIntercept(ok, WAIVER_DP.q1);
  return Object.freeze({
    ...base,
    curve: Object.freeze({ q0: icpt.q0, q1: icpt.q1, basis: "intercept" as const, n }),
    log_likelihood: icpt.log_likelihood,
    log_likelihood_cold: icpt.log_likelihood_cold,
    reasons: Object.freeze(reasons),
  });
}

/**
 * The premium from the league's previous seasons plus its current season (see the header): the
 * newest WAIVER_FIT.history.maxSeasons previous seasons with any evidence give the demand curve;
 * the drift pools claims won per team-week over those seasons and the current one (else the
 * current standings' acquisition totals bound it); E5's logged runs give the surplus. With no
 * previous-season evidence this is the 13-logged-runs path.
 */
export function fitPremiumFromHistory(input: {
  readonly teams: number;
  readonly feeds: readonly SeasonWaiverFeed[];
  readonly runs: readonly {
    readonly W: number;
    readonly candidates: readonly { readonly s: number }[];
  }[];
  /** The current season: its transactions (claims → drift) and the standings (the bound). */
  readonly current?: {
    readonly season: number;
    readonly transactions: readonly Transaction[];
    readonly standings: readonly Pick<Standing, "team_id" | "transaction_counter">[];
    readonly periods_played: readonly number[];
  } | null;
  readonly demand_scale?: number | null;
}): LeaguePremiumFit {
  const cur = input.current ?? null;
  const used = [...input.feeds]
    .filter(
      (f) =>
        Number.isInteger(f.season) &&
        (cur === null || f.season < cur.season) &&
        (f.outcomes.length > 0 || f.claim_runs > 0),
    )
    .sort((a, b) => b.season - a.season)
    .filter((f, i, xs) => xs.findIndex((x) => x.season === f.season) === i)
    .slice(0, WAIVER_FIT.history.maxSeasons);
  const outcomes = used.flatMap((f) => f.outcomes);
  const demand = used.length > 0 ? fitHistoryDemand(outcomes) : null;
  // drift: claims won per team-week, season-qualified so two seasons' week 3 never collide
  const q = (season: number, obs: readonly DriftObservation[]): DriftObservation[] =>
    obs.map((o) => ({ ...o, week: season * 100 + o.week }));
  const claims: DriftObservation[] = used.flatMap((f) => q(f.season, f.drift));
  if (cur !== null) {
    const txns = cur.transactions.filter(
      (t) => seasonOfInstant(t.process_date ?? t.proposed_date) === cur.season,
    );
    const curTeams = cur.standings.map((s) => s.team_id);
    claims.push(
      ...q(
        cur.season,
        driftFromClaimRuns(claimRuns(txns), {
          teams: curTeams,
          weekOf: weekOfFromTransactions(txns),
        }),
      ),
    );
  }
  const drift =
    claims.length > 0
      ? fitDrift(claims, "claims")
      : fitDrift(
          driftFromAcquisitions(cur?.standings ?? [], cur?.periods_played ?? []),
          "acquisitions",
        );
  const historyReasons =
    used.length === 0
      ? [
          "no previous-season transactions of this league are stored: its own demand curve cannot be fitted yet",
        ]
      : (demand?.reasons ?? []);
  const history: PremiumHistory | null =
    demand === null
      ? null
      : Object.freeze({
          seasons: Object.freeze(used.map((f) => f.season)),
          outcomes: demand.n,
          cleared: demand.cleared,
          value_known: demand.value_known,
          valued: demand.valued,
          valued_claimed: demand.valued_claimed,
          claim_runs: used.reduce((s, f) => s + f.claim_runs, 0),
        });
  const fit = fitLeaguePremium({
    teams: input.teams,
    surplus: surplusObservationsFromRuns(input.runs),
    drift,
    demand_scale: input.demand_scale ?? null,
    demand_curve: demand?.curve ?? null,
    history,
    history_reasons: historyReasons,
  });
  if (fit.basis !== "league_fitted" || demand === null || demand.reasons.length === 0) return fit;
  // the slope caveat travels with a fitted curve too
  return Object.freeze({ ...fit, reasons: Object.freeze([...demand.reasons, ...fit.reasons]) });
}

/**
 * E5's statement whenever it serves the cold start (changelog R6-3: "says so and states the
 * measured miss"): which parts are research 05's cold-start tables — the premium, the whole demand
 * curve, or only its slope beside the league's own intercept — and how far they were off on real
 * data (WAIVER_FIT.coldStartMiss). Null when nothing served is the cold start.
 */
export function coldStartNote(
  premiumCold: boolean,
  demandCold: boolean,
  slopeCold = false,
): string | null {
  const m = WAIVER_FIT.coldStartMiss;
  const clears = `P(clears_to_FA) ${String(m.clearsPoints.min)}–${String(m.clearsPoints.max)} pts too low on real drops`;
  const premium = `Π ×${String(m.premiumRatio.min)}–×${String(m.premiumRatio.max)}`;
  if (premiumCold && demandCold)
    return `cold-start premium and demand (research 05), not this league's feed; measured miss: ${clears}, ${premium} (${m.source})`;
  if (demandCold)
    return `cold-start demand curve (research 05), not this league's; measured miss: ${clears} (${m.source})`;
  if (premiumCold)
    return `cold-start premium table (research 05), not this league's; measured miss: ${premium} of a league-fitted table (${m.source})`;
  if (slopeCold)
    return `cold-start demand slope (no claims at value in the feed); measured miss with the fitted intercept: P(clears_to_FA) ${String(m.slopeClearsPoints)} pts too low on held-out drops (${m.source})`;
  return null;
}

/** When the cold-start statement stops applying (the revisit trigger E5 reports with it). */
export const COLD_START_REVISIT =
  "the league's previous-season transactions are stored, or 13 waiver runs are logged";

/** The per-rival demand q(r) under a fitted curve (capped like the cold start's), or null. */
export function curveDemand(
  curve: { readonly q0: number; readonly q1: number } | null | undefined,
  r: number,
  scale = 1,
): number | null {
  if (curve === null || curve === undefined) return null;
  const x = Number.isFinite(r) && r > 0 ? r : 0;
  return Math.min(WAIVER_DP.qCap, (curve.q0 + curve.q1 * x) * scale);
}
