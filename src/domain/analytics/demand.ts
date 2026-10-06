// demand.ts — E5's warm demand model and the [U] waiver mechanics learned from the league's own feed
// (research 05 §1.3: cold start `q(r)`, warm `q_i = logistic(a + b·upgrade_i + c·log(1+trend) +
// d·activity_i)` fitted on the league's WAIVER and WAIVER_ERROR rows — they say who claimed whom;
// §1.6 eval 2 (Brier of q_i against realised claims) and eval 4 (whether a team's second claim in one
// run is processed at its NEW position: pairs of claim rows with the same processDate and teamId);
// plan 07 E5/E11 `learned.*` — null until the feed shows the case, §6 clean negatives; plan 10 B4).
// The fit is ridge-penalised IRLS (deterministic, no RNG). Pure. New here.
import type { IsoInstant, Transaction } from "../league/types.js";
import { DEMAND_FIT, MECHANICS } from "./marketConstants.js";
import { clamp, round } from "./math.js";
import { demandOf } from "./waiverDp.js";

// --- claim runs ------------------------------------------------------------------------------------

/** One processed claim inside a run (WAIVER executed = won; WAIVER_ERROR = lost). */
export interface RunClaim {
  readonly team_id: number;
  readonly player_id: number;
  readonly won: boolean;
}

/** One processed waiver run: every claim row sharing a `processDate`. */
export interface ClaimRun {
  /** The run's `processDate` (ISO) — its key. */
  readonly run: IsoInstant;
  readonly process_ms: number;
  readonly claims: readonly RunClaim[];
}

const CLAIM_TYPES: ReadonlySet<string> = new Set(MECHANICS.claimTypes);

/** Whether a WAIVER row was processed and won (ESPN `EXECUTED`; a null status reads as executed). */
function wonRow(t: Transaction): boolean | null {
  if (t.type === "WAIVER_ERROR") return false;
  if (t.type !== "WAIVER") return null;
  return t.status === null || t.status === "EXECUTED" ? true : null;
}

/**
 * The league's processed waiver runs, oldest first: WAIVER (executed) and WAIVER_ERROR rows grouped
 * by `processDate`, one claim per ADD item. Pending or cancelled claims and rows without a team, a
 * date or an ADD are skipped (never guessed).
 */
export function claimRuns(transactions: readonly Transaction[]): ClaimRun[] {
  const byRun = new Map<number, RunClaim[]>();
  for (const t of transactions) {
    if (!CLAIM_TYPES.has(t.type)) continue;
    const won = wonRow(t);
    if (won === null || t.process_date === null) continue;
    const ms = Date.parse(t.process_date);
    if (!Number.isFinite(ms)) continue;
    for (const item of t.items) {
      if (item.type !== "ADD") continue;
      const team = t.team_id ?? item.to_team_id;
      if (team === null || !Number.isInteger(team) || team <= 0) continue;
      const list = byRun.get(ms) ?? [];
      list.push({ team_id: team, player_id: item.player_id, won });
      byRun.set(ms, list);
    }
  }
  return [...byRun.entries()]
    .sort(([a], [b]) => a - b)
    .map(([ms, claims]) => ({
      run: new Date(ms).toISOString(),
      process_ms: ms,
      claims: [...claims].sort(
        (a, b) =>
          a.team_id - b.team_id || a.player_id - b.player_id || Number(b.won) - Number(a.won),
      ),
    }));
}

// --- observations and the fit ------------------------------------------------------------------------

/** What the caller knows about (run, rival, player) — the model's covariates. */
export interface DemandFeatures {
  /** The player's per-week value rate — the cold-start curve's argument (research 05 §1.2). */
  readonly r: number;
  /** The rival's lineup gain per week from the player (the assignment on his roster); null → r. */
  readonly upgrade: number | null;
  /** Sleeper trending adds (secondary; research 05 §1.3); null → 0. */
  readonly trend: number | null;
}

/** One (run, team, player) observation: did the team claim the player in that run? */
export interface DemandObservation extends DemandFeatures {
  readonly run: IsoInstant;
  readonly team_id: number;
  readonly player_id: number;
  /** The team's processed claims in EARLIER runs (research 05 §1.3 `activity_i`). */
  readonly activity: number;
  readonly claimed: boolean;
}

/** Builds the observations: every claimed player (plus `pool_by_run`) × every team, per run. */
export function demandObservations(input: {
  readonly runs: readonly ClaimRun[];
  readonly teams: readonly number[];
  readonly features: (run: IsoInstant, teamId: number, playerId: number) => DemandFeatures | null;
  /** Players that were claimable in a run but nobody claimed (the pool snapshot) — negatives. */
  readonly pool_by_run?: ReadonlyMap<IsoInstant, readonly number[]>;
}): DemandObservation[] {
  const out: DemandObservation[] = [];
  const activity = new Map<number, number>();
  const teams = [...new Set(input.teams)].sort((a, b) => a - b);
  for (const run of input.runs) {
    const players = new Set<number>(run.claims.map((c) => c.player_id));
    for (const p of input.pool_by_run?.get(run.run) ?? []) players.add(p);
    const claimedBy = new Set(run.claims.map((c) => `${String(c.team_id)}:${String(c.player_id)}`));
    for (const player of [...players].sort((a, b) => a - b)) {
      for (const team of teams) {
        const f = input.features(run.run, team, player);
        if (f === null || !Number.isFinite(f.r)) continue;
        out.push({
          run: run.run,
          team_id: team,
          player_id: player,
          r: f.r,
          upgrade: f.upgrade !== null && Number.isFinite(f.upgrade) ? f.upgrade : null,
          trend: f.trend !== null && Number.isFinite(f.trend) ? f.trend : null,
          activity: activity.get(team) ?? 0,
          claimed: claimedBy.has(`${String(team)}:${String(player)}`),
        });
      }
    }
    for (const c of run.claims) activity.set(c.team_id, (activity.get(c.team_id) ?? 0) + 1);
  }
  return out;
}

/** A fitted demand model (`premium_basis` stays cold until Phase 3; this feeds `q_i` only). */
export interface DemandFit {
  readonly kind: "league_fitted";
  /** [a, b, c, d]: intercept, upgrade per week, log(1 + trend), activity. */
  readonly coef: readonly [number, number, number, number];
  /** The coefficients' covariance (the penalised inverse Hessian), row-major 4 × 4. */
  readonly cov: readonly (readonly number[])[];
  readonly n: number;
  readonly claims: number;
  readonly runs: number;
  /** In-sample Brier of the fit, and of the cold-start curve q(r) on the same rows. */
  readonly brier_fitted: number;
  readonly brier_cold: number;
  /** Leave-one-run-out Brier (≥ 3 runs), else null. */
  readonly brier_fitted_cv: number | null;
}

/** The covariates of one row: [1, upgrade (or r), log(1 + trend), activity]. */
export function demandCovariates(
  f: Pick<DemandObservation, "r" | "upgrade" | "trend" | "activity">,
): [number, number, number, number] {
  const u = f.upgrade ?? f.r;
  return [1, Number.isFinite(u) ? u : 0, Math.log1p(Math.max(0, f.trend ?? 0)), f.activity];
}

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-clamp(x, -40, 40)));

/** Solves a small dense system (Gaussian elimination, partial pivoting); null when singular. */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i] ?? 0]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++)
      if (Math.abs(m[r]?.[c] ?? 0) > Math.abs(m[piv]?.[c] ?? 0)) piv = r;
    const pr = m[piv];
    if (pr === undefined || Math.abs(pr[c] ?? 0) < 1e-12) return null;
    [m[c], m[piv]] = [pr, m[c] ?? pr];
    const row = m[c] ?? pr;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const other = m[r];
      if (other === undefined) continue;
      const f = (other[c] ?? 0) / (row[c] ?? 1);
      for (let k = c; k <= n; k++) other[k] = (other[k] ?? 0) - f * (row[k] ?? 0);
    }
  }
  return m.map((row, i) => (row[n] ?? 0) / (row[i] ?? 1));
}

function invert(a: number[][]): number[][] | null {
  const n = a.length;
  const cols: number[][] = [];
  for (let j = 0; j < n; j++) {
    const e = Array.from({ length: n }, (_, i) => (i === j ? 1 : 0));
    const x = solve(
      a.map((r) => [...r]),
      e,
    );
    if (x === null) return null;
    cols.push(x);
  }
  return Array.from({ length: n }, (_, i) => cols.map((c) => c[i] ?? 0));
}

function irls(rows: readonly DemandObservation[]): { beta: number[]; cov: number[][] } | null {
  const X = rows.map(demandCovariates);
  const y = rows.map((r) => (r.claimed ? 1 : 0));
  let beta = [0, 0, 0, 0];
  const lambda = [0, DEMAND_FIT.ridge, DEMAND_FIT.ridge, DEMAND_FIT.ridge];
  let hess: number[][] = [];
  for (let it = 0; it < DEMAND_FIT.maxIterations; it++) {
    const grad = beta.map((b, j) => -(lambda[j] ?? 0) * b);
    hess = beta.map((_, j) => beta.map((__, k) => (j === k ? (lambda[j] ?? 0) : 0)));
    X.forEach((x, i) => {
      const p = sigmoid(x.reduce((s, v, j) => s + v * (beta[j] ?? 0), 0));
      const w = Math.max(p * (1 - p), 1e-9);
      const resid = (y[i] ?? 0) - p;
      for (let j = 0; j < 4; j++) {
        grad[j] = (grad[j] ?? 0) + (x[j] ?? 0) * resid;
        const hj = hess[j];
        if (hj === undefined) continue;
        for (let k = 0; k < 4; k++) hj[k] = (hj[k] ?? 0) + w * (x[j] ?? 0) * (x[k] ?? 0);
      }
    });
    const step = solve(
      hess.map((r) => [...r]),
      grad,
    );
    if (step === null) return null;
    beta = beta.map((b, j) => b + (step[j] ?? 0));
    if (step.every((s) => Math.abs(s) < DEMAND_FIT.tolerance)) break;
  }
  if (!beta.every(Number.isFinite)) return null;
  const cov = invert(hess);
  return cov === null ? null : { beta, cov };
}

/** The mean squared error of probabilities against outcomes (Brier); NaN-free. */
export function brier(pairs: readonly { readonly p: number; readonly y: boolean }[]): number {
  if (pairs.length === 0) return 0;
  let s = 0;
  for (const { p, y } of pairs) s += (clamp(p, 0, 1) - (y ? 1 : 0)) ** 2;
  return s / pairs.length;
}

const predict = (beta: readonly number[], x: readonly number[]): number =>
  clamp(
    sigmoid(x.reduce((s, v, j) => s + v * (beta[j] ?? 0), 0)),
    DEMAND_FIT.pMin,
    DEMAND_FIT.pMax,
  );

/**
 * Fits the warm demand model on the observations; null (the cold-start curve stays) with fewer
 * than `minObservations` rows, without both a claim and a non-claim, or when the system is singular.
 */
export function fitDemand(rows: readonly DemandObservation[]): DemandFit | null {
  const claims = rows.filter((r) => r.claimed).length;
  if (rows.length < DEMAND_FIT.minObservations || claims === 0 || claims === rows.length)
    return null;
  const fit = irls(rows);
  if (fit === null) return null;
  const runs = [...new Set(rows.map((r) => r.run))].sort();
  const fitted = brier(
    rows.map((r) => ({ p: predict(fit.beta, demandCovariates(r)), y: r.claimed })),
  );
  const cold = brier(rows.map((r) => ({ p: demandOf(r.r), y: r.claimed })));
  let cv: number | null = null;
  if (runs.length >= 3) {
    const pairs: { p: number; y: boolean }[] = [];
    for (const run of runs) {
      const train = rows.filter((r) => r.run !== run);
      const tc = train.filter((r) => r.claimed).length;
      const f = tc === 0 || tc === train.length ? null : irls(train);
      for (const r of rows.filter((x) => x.run === run))
        pairs.push({
          p: f === null ? demandOf(r.r) : predict(f.beta, demandCovariates(r)),
          y: r.claimed,
        });
    }
    cv = round(brier(pairs), 5);
  }
  return Object.freeze({
    kind: "league_fitted",
    coef: [fit.beta[0] ?? 0, fit.beta[1] ?? 0, fit.beta[2] ?? 0, fit.beta[3] ?? 0] as const,
    cov: Object.freeze(fit.cov.map((r) => Object.freeze([...r]))),
    n: rows.length,
    claims,
    runs: runs.length,
    brier_fitted: round(fitted, 5),
    brier_cold: round(cold, 5),
    brier_fitted_cv: cv,
  });
}

/** A fitted q_i with its 90 % interval on the linear predictor (delta method). */
export function fittedQ(
  fit: DemandFit,
  f: Pick<DemandObservation, "r" | "upgrade" | "trend" | "activity">,
): { readonly p: number; readonly lo: number; readonly hi: number } {
  const x = demandCovariates(f);
  const eta = x.reduce((s, v, j) => s + v * (fit.coef[j] ?? 0), 0);
  let v = 0;
  for (let j = 0; j < 4; j++)
    for (let k = 0; k < 4; k++) v += (x[j] ?? 0) * (fit.cov[j]?.[k] ?? 0) * (x[k] ?? 0);
  const se = Math.sqrt(Math.max(0, v));
  const bound = (e: number): number => clamp(sigmoid(e), DEMAND_FIT.pMin, DEMAND_FIT.pMax);
  return {
    p: round(bound(eta), 4),
    lo: round(bound(eta - DEMAND_FIT.z * se), 4),
    hi: round(bound(eta + DEMAND_FIT.z * se), 4),
  };
}

// --- the [U] mechanics (research 05 §1.6 eval 4) -------------------------------------------------------

/** Team → waiver rank (1 = first) at one instant. */
export type WaiverOrder = ReadonlyMap<number, number>;

/** What the feed has shown about ESPN's waiver mechanics; null = not shown yet (plan 07 §6). */
export interface LearnedMechanics {
  readonly second_claim_at_new_position: boolean | null;
  readonly waiver_rank_moves_on_success: boolean | null;
  readonly evidence: {
    readonly runs: number;
    /** Same-run pairs examined: a team with ≥ 2 claims and ≥ 1 win in one run. */
    readonly pairs: number;
    readonly new_position_cases: number;
    readonly old_position_cases: number;
    readonly moved_cases: number;
    readonly stayed_cases: number;
  };
}

/**
 * Learns the mechanics from processed runs and the waiver order before (and after) each run:
 *
 * - **Second claim at the new position** — a team T with two claims in one run that won one of them:
 *   if T LOST another claim on a player WON by a team ranked behind T before the run, that team beat T
 *   — only possible once T had dropped below it, so T's later claim ran at its new position (`true`).
 *   If T WON two claims that each a team ranked behind T claimed and lost, T kept its place for both
 *   (`false`). Anything else is inconclusive. Conflicting runs → null.
 * - **Rank moves on success** — with the order after the run as well: every winner moved down (or to
 *   last) → `true`; a winner not already last who kept his rank → `false`.
 *
 * A run without its order before is inconclusive for both (never guessed).
 */
export function learnWaiverMechanics(input: {
  readonly runs: readonly ClaimRun[];
  readonly order_before?: ReadonlyMap<IsoInstant, WaiverOrder>;
  readonly order_after?: ReadonlyMap<IsoInstant, WaiverOrder>;
}): LearnedMechanics {
  let pairs = 0;
  let newPos = 0;
  let oldPos = 0;
  let moved = 0;
  let stayed = 0;
  for (const run of input.runs) {
    const before = input.order_before?.get(run.run);
    if (before === undefined) continue;
    const winnerOf = new Map<number, number>();
    for (const c of run.claims) if (c.won) winnerOf.set(c.player_id, c.team_id);
    const byTeam = new Map<number, RunClaim[]>();
    for (const c of run.claims) byTeam.set(c.team_id, [...(byTeam.get(c.team_id) ?? []), c]);
    for (const [team, claims] of byTeam) {
      const rank = before.get(team);
      if (rank === undefined || claims.length < 2 || !claims.some((c) => c.won)) continue;
      pairs += 1;
      const behind = (other: number): boolean => {
        const r = before.get(other);
        return r !== undefined && r > rank;
      };
      const beaten = claims.some((c) => {
        if (c.won) return false;
        const w = winnerOf.get(c.player_id);
        return w !== undefined && w !== team && behind(w);
      });
      const contestedWins = claims.filter(
        (c) =>
          c.won &&
          run.claims.some(
            (o) => o.player_id === c.player_id && !o.won && o.team_id !== team && behind(o.team_id),
          ),
      ).length;
      if (beaten) newPos += 1;
      else if (contestedWins >= 2) oldPos += 1;
    }
    const after = input.order_after?.get(run.run);
    if (after !== undefined) {
      const last = Math.max(...after.values());
      for (const team of new Set(run.claims.filter((c) => c.won).map((c) => c.team_id))) {
        const b = before.get(team);
        const a = after.get(team);
        if (b === undefined || a === undefined) continue;
        if (a > b || a === last) moved += 1;
        else if (b !== last) stayed += 1;
      }
    }
  }
  const verdict = (yes: number, no: number): boolean | null =>
    yes > 0 && no === 0 ? true : no > 0 && yes === 0 ? false : null;
  return Object.freeze({
    second_claim_at_new_position: verdict(newPos, oldPos),
    waiver_rank_moves_on_success: verdict(moved, stayed),
    evidence: Object.freeze({
      runs: input.runs.length,
      pairs,
      new_position_cases: newPos,
      old_position_cases: oldPos,
      moved_cases: moved,
      stayed_cases: stayed,
    }),
  });
}

/**
 * Whether unowned players go to waivers at their game's kickoff (research 05 §1.1 [U]; plan 07 E5
 * `learned.unowned_to_waivers_at_kickoff`): from two pool snapshots either side of kickoff, the
 * unowned players whose game started — all flipped FREEAGENT → WAIVERS → true; all stayed FREEAGENT
 * → false; none observed or mixed → null.
 */
export function learnKickoffWaivers(input: {
  readonly before: ReadonlyMap<number, string>;
  readonly after: ReadonlyMap<number, string>;
  readonly played: readonly number[];
}): boolean | null {
  let flipped = 0;
  let stayed = 0;
  for (const p of input.played) {
    if (input.before.get(p) !== "FREEAGENT") continue;
    const a = input.after.get(p);
    if (a === "WAIVERS") flipped += 1;
    else if (a === "FREEAGENT") stayed += 1;
  }
  return flipped > 0 && stayed === 0 ? true : stayed > 0 && flipped === 0 ? false : null;
}
