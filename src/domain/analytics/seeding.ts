// seeding.ts — the seeding-scenario simulator under both readings (research 05 §2.4; plan 07 E3
// `season` — Phase-1a domain code because E2's PF exchange rate needs it; plan 10 A10a): ≥ 10 000
// paths; every remaining matchup drawn from each team's weekly Normal(μ, σ) (E1's lineup when
// given, else the cold-start model: the season-to-date mean shrunk n/(n+4) toward the league mean,
// σ pooled); the exact tiebreak chain per `playoffSeedingRule` (TOTAL_POINTS_SCORED: win % → PF →
// H2H → division → PA → coin; research 05 §2.1) with division winners first when the league has
// more than one division (reading (a)), PF only under reading (b); the bracket with the bye rule of
// research 05 §2.3; marginal values by re-running from perturbed states on common random numbers.
// Cooperative batches under the CPU deadline (plan 01 §1.1). Pure. New here.
import type { Clock, Rng } from "../clock.js";
import type { SeedingMode } from "../../config/schema.js";
import type { Week } from "../league/types.js";
import { SEEDING, Z90 } from "./constants.js";
import { loopPacer, runCooperative, type Pacer } from "./cooperative.js";
import { ensure } from "./errors.js";
import { type AnyStamp, collectInputs, mergeInputs, newestAsOf } from "./inputs.js";
import { normalDist, normalDraw, round } from "./math.js";
import {
  seedingStatus,
  type Assumption,
  type InputFreshness,
  type MarginalValue,
  type SeasonReading,
  type SeasonScenario,
  type SeasonSimData,
  type SeedingModeArg,
} from "./types.js";

/** One team's standing and weekly scoring model. */
export interface SeasonTeam {
  readonly team_id: number;
  readonly division_id: number | null;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  readonly points_for: number;
  readonly points_against: number;
  /** The team's weekly lineup total from E1 (mean, sd); null → the cold-start model. */
  readonly weekly?: { readonly mu: number; readonly sigma: number } | null;
}

/** A decided regular-season matchup (mMatchup `schedule[]` with a winner). */
export interface PlayedGame {
  readonly period: number;
  readonly home: number;
  readonly away: number;
  readonly home_points: number;
  readonly away_points: number;
}

/** A remaining regular-season matchup. */
export interface ScheduledGame {
  readonly period: number;
  readonly matchup_id?: number;
  readonly home: number;
  readonly away: number;
  /** Scoring periods the matchup spans (default 1). */
  readonly weeks?: number;
}

/** One playoff round: the NFL weeks it spans (`matchupPeriods` of the playoff periods). */
export interface PlayoffRound {
  readonly weeks: readonly Week[];
}

/** A simulator request. */
export interface SeasonSimRequest {
  readonly teams: readonly SeasonTeam[];
  readonly played: readonly PlayedGame[];
  readonly remaining: readonly ScheduledGame[];
  /** The team the outputs are for (my team). */
  readonly me: number;
  readonly playoff: {
    readonly team_count: number;
    /** `playoffSeedingRule`. */
    readonly seeding_rule: string;
    readonly reseed: boolean | null;
    /** The playoff rounds in order; [] → no bracket (p_champion null, playoff weeks unknown). */
    readonly rounds: readonly PlayoffRound[];
  };
  /** The reading: `config` (the operator's), an explicit one, or `both` (only when asked). */
  readonly seeding_mode: SeedingModeArg;
  readonly seeding_config: {
    readonly mode: SeedingMode;
    readonly confirmed_at: string | null;
  };
  /** Remaining regular-season weeks (for `p_alive_by_week`); empty → not reported. */
  readonly regular_weeks?: readonly Week[];
  readonly scenarios?: readonly SeasonScenario[];
  readonly n_sims?: number;
  /** Run the seven marginal-value perturbations (default true). */
  readonly marginal?: boolean;
  readonly playoff_pct_espn?: number | null;
  readonly clock: Clock;
  readonly rng: Rng;
  readonly pacer?: Pacer;
  readonly deadline_ms?: number | null;
  readonly stamps?: readonly AnyStamp[];
  readonly inputs?: readonly InputFreshness[];
}

/** The simulator's outcome. */
export interface SeasonSimOutcome {
  readonly data: SeasonSimData;
  readonly partial: boolean;
  readonly warnings: readonly string[];
  /** The weekly models used (team id → μ, σ) — what a reader needs to reproduce a run. */
  readonly models: ReadonlyMap<number, { readonly mu: number; readonly sigma: number }>;
}

// --- tiebreak chains (research 05 §2.1) ---------------------------------------------------------------

/** One tiebreak level. */
export type TieLevel =
  "win_pct" | "points_for" | "head_to_head" | "division_record" | "points_against" | "coin_flip";

/** The chain of a seeding rule under a reading; unknown rules read as TOTAL_POINTS_SCORED (flagged). */
export function tiebreakChain(
  mode: SeedingMode,
  rule: string,
): { readonly chain: readonly TieLevel[]; readonly known: boolean } {
  if (mode === "points_only") return { chain: ["points_for", "coin_flip"], known: true };
  switch (rule) {
    case "TOTAL_POINTS_SCORED":
      return {
        chain: [
          "win_pct",
          "points_for",
          "head_to_head",
          "division_record",
          "points_against",
          "coin_flip",
        ],
        known: true,
      };
    case "H2H_RECORD":
      return {
        chain: [
          "win_pct",
          "head_to_head",
          "points_for",
          "division_record",
          "points_against",
          "coin_flip",
        ],
        known: true,
      };
    case "INTRA_DIVISION_RECORD":
      return {
        chain: [
          "division_record",
          "head_to_head",
          "win_pct",
          "points_for",
          "points_against",
          "coin_flip",
        ],
        known: true,
      };
    default:
      return {
        chain: [
          "win_pct",
          "points_for",
          "head_to_head",
          "division_record",
          "points_against",
          "coin_flip",
        ],
        known: false,
      };
  }
}

/** One game result for H2H / division records: winner 0 home, 1 away, 2 tie. */
interface Result {
  readonly a: number;
  readonly b: number;
  winner: number;
}

/** Aggregates the ranking reads. */
interface Agg {
  readonly n: number;
  readonly wins: Float64Array;
  readonly losses: Float64Array;
  readonly ties: Float64Array;
  readonly pf: Float64Array;
  readonly pa: Float64Array;
  readonly div: Int32Array;
  readonly coin: Float64Array;
  readonly results: readonly Result[];
}

const pct = (w: number, l: number, t: number): number => {
  const g = w + l + t;
  return g > 0 ? (w + t / 2) / g : 0;
};

/** The metric of a level for team i within group g (higher is better). */
function metric(level: TieLevel, i: number, group: readonly number[], s: Agg): number {
  switch (level) {
    case "win_pct":
      return pct(s.wins[i] ?? 0, s.losses[i] ?? 0, s.ties[i] ?? 0);
    case "points_for":
      return s.pf[i] ?? 0;
    case "points_against":
      // fewer points against ranks higher [U]: the tiebreak's direction is unverified
      return -(s.pa[i] ?? 0);
    case "coin_flip":
      return s.coin[i] ?? 0;
    case "head_to_head": {
      let w = 0;
      let g = 0;
      for (const r of s.results) {
        const iHome = r.a === i;
        if (!iHome && r.b !== i) continue;
        const other = iHome ? r.b : r.a;
        if (!group.includes(other)) continue;
        g += 1;
        if (r.winner === 2) w += 0.5;
        else if ((r.winner === 0) === iHome) w += 1;
      }
      return g > 0 ? w / g : 0.5;
    }
    case "division_record": {
      const d = s.div[i] ?? -1;
      if (d < 0) return 0;
      let w = 0;
      let g = 0;
      for (const r of s.results) {
        const iHome = r.a === i;
        if (!iHome && r.b !== i) continue;
        const other = iHome ? r.b : r.a;
        if ((s.div[other] ?? -2) !== d) continue;
        g += 1;
        if (r.winner === 2) w += 0.5;
        else if ((r.winner === 0) === iHome) w += 1;
      }
      return g > 0 ? w / g : 0;
    }
  }
}

/** Orders a group by the chain from `level` on: split by the level's metric, recurse into ties. */
function orderGroup(group: number[], chain: readonly TieLevel[], level: number, s: Agg): number[] {
  if (group.length <= 1 || level >= chain.length) return group;
  const lv = chain[level] ?? "coin_flip";
  const vals = group.map((i) => ({ i, v: metric(lv, i, group, s) }));
  vals.sort((x, y) => y.v - x.v || x.i - y.i);
  const out: number[] = [];
  let k = 0;
  while (k < vals.length) {
    let j = k;
    while (j + 1 < vals.length && Math.abs((vals[j + 1]?.v ?? 0) - (vals[k]?.v ?? 0)) <= 1e-9)
      j += 1;
    const tied = vals.slice(k, j + 1).map((x) => x.i);
    out.push(...(tied.length > 1 ? orderGroup(tied, chain, level + 1, s) : tied));
    k = j + 1;
  }
  return out;
}

/** The final order of every team under a reading (division winners first under espn_rule with > 1 division). */
function rankAll(chain: readonly TieLevel[], divisionsFirst: boolean, s: Agg): number[] {
  const all = Array.from({ length: s.n }, (_, i) => i);
  if (!divisionsFirst) return orderGroup(all, chain, 0, s);
  const byDiv = new Map<number, number[]>();
  for (const i of all) {
    const d = s.div[i] ?? -1;
    byDiv.set(d, [...(byDiv.get(d) ?? []), i]);
  }
  const winners: number[] = [];
  for (const members of byDiv.values()) {
    const best = orderGroup(members, chain, 0, s)[0];
    if (best !== undefined) winners.push(best);
  }
  const winnerSet = new Set(winners);
  return [
    ...orderGroup(winners, chain, 0, s),
    ...orderGroup(
      all.filter((i) => !winnerSet.has(i)),
      chain,
      0,
      s,
    ),
  ];
}

/** The standard bracket order of seeds for a power-of-two bracket (1, 8, 4, 5, 2, 7, 3, 6 for 8). */
export function bracketOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const m = order.length * 2 + 1;
    order = order.flatMap((s) => [s, m - s]);
  }
  return order;
}

/** The bracket size (next power of two ≥ the field). */
const bracketSize = (p: number): number => {
  let b = 1;
  while (b < p) b *= 2;
  return b;
};

// --- the run -----------------------------------------------------------------------------------------

const VARIANTS = [
  "base",
  "plus_1_win",
  "plus_pf_20",
  "plus_pf_40",
  "plus_pf_80",
  "plus_3_ppw",
  "sigma_x0_7",
  "sigma_x1_4",
] as const;
type Variant = (typeof VARIANTS)[number];

interface Tally {
  playoffs: number;
  bye: number;
  champion: number;
  seeds: Float64Array;
  rounds: Float64Array;
}

const A = (text: string, revisit_trigger: string): Assumption => ({ text, revisit_trigger });

/** The weekly models: E1's when given, else the cold-start shrunk mean and pooled σ. */
function models(
  req: SeasonSimRequest,
  assumptions: Assumption[],
): { mu: Float64Array; sigma: Float64Array } {
  const n = req.teams.length;
  const mu = new Float64Array(n);
  const sigma = new Float64Array(n);
  const games = req.teams.map((t) => t.wins + t.losses + t.ties);
  const totalGames = games.reduce((a, b) => a + b, 0);
  const totalPf = req.teams.reduce((a, t) => a + t.points_for, 0);
  const leagueMean = totalGames > 0 ? totalPf / totalGames : SEEDING.defaultMean;
  // pooled σ: every played score around its team's season mean
  const idx = new Map(req.teams.map((t, i) => [t.team_id, i]));
  let ss = 0;
  let cnt = 0;
  const seasonMean = req.teams.map((t, i) =>
    (games[i] ?? 0) > 0 ? t.points_for / (games[i] ?? 1) : leagueMean,
  );
  for (const g of req.played) {
    for (const [team, pts] of [
      [g.home, g.home_points],
      [g.away, g.away_points],
    ] as const) {
      const i = idx.get(team);
      if (i === undefined) continue;
      ss += (pts - (seasonMean[i] ?? leagueMean)) ** 2;
      cnt += 1;
    }
  }
  const pooled = cnt - n >= 2 ? Math.sqrt(ss / (cnt - n)) : SEEDING.defaultSigma;
  let cold = 0;
  req.teams.forEach((t, i) => {
    if (
      t.weekly !== undefined &&
      t.weekly !== null &&
      Number.isFinite(t.weekly.mu) &&
      t.weekly.sigma >= 0
    ) {
      mu[i] = t.weekly.mu;
      sigma[i] = t.weekly.sigma;
      return;
    }
    cold += 1;
    const ng = games[i] ?? 0;
    const w = ng / (ng + SEEDING.shrinkGames);
    mu[i] = leagueMean + w * ((seasonMean[i] ?? leagueMean) - leagueMean);
    sigma[i] = pooled;
  });
  if (cold > 0)
    assumptions.push(
      A(
        totalGames > 0
          ? `cold-start weekly model for ${String(cold)} teams: season mean shrunk n/(n+${String(SEEDING.shrinkGames)}) toward the league mean, pooled σ ${String(round(pooled, 1))}`
          : `no week played: every cold-start team is Normal(${String(SEEDING.defaultMean)}, ${String(SEEDING.defaultSigma)})`,
        "E1 lineup projections for every team are passed in",
      ),
    );
  return { mu, sigma };
}

/**
 * The seeding simulator. Throws AnalyticsError `invalid_request` on a malformed league (unknown
 * teams in a game, a field larger than the league, bounds).
 */
export async function simulateSeason(req: SeasonSimRequest): Promise<SeasonSimOutcome> {
  const n = req.teams.length;
  ensure(n >= 2 && n <= SEEDING.maxTeams, "team count out of range", "teams");
  const idx = new Map<number, number>();
  req.teams.forEach((t, i) => idx.set(t.team_id, i));
  ensure(idx.size === n, "duplicate team id", "teams");
  for (const t of req.teams)
    ensure(
      [t.wins, t.losses, t.ties, t.points_for, t.points_against].every(
        (x) => Number.isFinite(x) && x >= 0,
      ),
      "standings must be finite and non-negative",
      "teams",
    );
  const me = idx.get(req.me);
  ensure(me !== undefined, "my team is not in the league", "team_id");
  const P = req.playoff.team_count;
  ensure(
    Number.isInteger(P) && P >= 1 && P <= n,
    "playoff team count out of range",
    "playoff.team_count",
  );
  const known = (id: number): boolean => idx.has(id);
  for (const g of [...req.played, ...req.remaining])
    ensure(
      known(g.home) && known(g.away) && g.home !== g.away,
      "a matchup names an unknown team",
      "schedule",
    );
  for (const g of req.played)
    ensure(
      Number.isFinite(g.home_points) && Number.isFinite(g.away_points),
      "a played score is not finite",
      "schedule",
    );
  const nSims = req.n_sims ?? SEEDING.defaultPaths;
  ensure(
    Number.isInteger(nSims) && nSims >= SEEDING.minPaths && nSims <= 20_000,
    "n_sims out of range",
    "n_sims",
  );
  const scenarios = req.scenarios ?? [];
  ensure(scenarios.length <= SEEDING.maxScenarios, "too many scenarios", "scenarios");

  const modes: SeedingMode[] =
    req.seeding_mode === "both"
      ? ["espn_rule", "points_only"]
      : [req.seeding_mode === "config" ? req.seeding_config.mode : req.seeding_mode];
  const assumptions: Assumption[] = [];
  const warnings: string[] = [];
  const { mu, sigma } = models(req, assumptions);
  const divIds = [
    ...new Set(req.teams.map((t) => t.division_id).filter((d): d is number => d !== null)),
  ];
  const divisionAware = divIds.length > 1;
  const div = Int32Array.from(
    req.teams.map((t) => (t.division_id === null ? -1 : divIds.indexOf(t.division_id))),
  );

  // starting aggregates, with PF scenarios
  const w0 = Float64Array.from(req.teams.map((t) => t.wins));
  const l0 = Float64Array.from(req.teams.map((t) => t.losses));
  const t0 = Float64Array.from(req.teams.map((t) => t.ties));
  const pf0 = Float64Array.from(req.teams.map((t) => t.points_for));
  const pa0 = Float64Array.from(req.teams.map((t) => t.points_against));
  const applied: string[] = [];
  const remaining = req.remaining.map((g) => ({
    h: idx.get(g.home) ?? 0,
    a: idx.get(g.away) ?? 0,
    L: Math.max(1, g.weeks ?? 1),
    period: g.period,
    matchup_id: g.matchup_id ?? null,
    forced: -1,
  }));
  for (const sc of scenarios) {
    if ("pf_delta" in sc) {
      const i = idx.get(sc.team_id);
      ensure(
        i !== undefined && Number.isFinite(sc.pf_delta),
        "a PF scenario names an unknown team",
        "scenarios",
      );
      pf0[i] = Math.max(0, (pf0[i] ?? 0) + sc.pf_delta);
      applied.push(
        `team ${String(sc.team_id)}: points for ${sc.pf_delta >= 0 ? "+" : ""}${String(sc.pf_delta)}`,
      );
    } else {
      const g = remaining.find((x) => x.period === sc.week && x.matchup_id === sc.matchup_id);
      ensure(g !== undefined, "a scenario names an unknown remaining matchup", "scenarios");
      const winnerId = sc.winner === "me" ? req.me : sc.winner;
      const wi = idx.get(winnerId);
      ensure(
        wi !== undefined && (wi === g.h || wi === g.a),
        "a scenario's winner is not in that matchup",
        "scenarios",
      );
      g.forced = wi;
      applied.push(
        `matchup ${String(sc.matchup_id)} (period ${String(sc.week)}): team ${String(winnerId)} wins`,
      );
    }
  }

  // played results (H2H, division) and the most recent loss of mine (the +1 win perturbation)
  const playedResults: Result[] = req.played.map((g) => ({
    a: idx.get(g.home) ?? 0,
    b: idx.get(g.away) ?? 0,
    winner: g.home_points > g.away_points ? 0 : g.home_points < g.away_points ? 1 : 2,
  }));
  let flipIndex = -1;
  for (let i = playedResults.length - 1; i >= 0; i--) {
    const r = playedResults[i];
    if (r === undefined) continue;
    if ((r.a === me && r.winner === 1) || (r.b === me && r.winner === 0)) {
      flipIndex = i;
      break;
    }
  }
  const canFlip = (l0[me] ?? 0) > 0;
  if (!canFlip)
    assumptions.push(A("no loss to flip: the +1 win marginal value is 0", "a loss is recorded"));

  const rounds = req.playoff.rounds;
  const B = bracketSize(P);
  const byes = B - P;
  const roundsNeeded = Math.round(Math.log2(B));
  const bracketRounds = Math.min(rounds.length, roundsNeeded);
  if (rounds.length > 0 && rounds.length !== roundsNeeded)
    warnings.push(
      `playoff rounds ${String(rounds.length)} differ from the bracket's ${String(roundsNeeded)}`,
    );
  const simulateBracket = rounds.length > 0;
  const roundL = rounds.slice(0, bracketRounds).map((r) => Math.max(1, r.weeks.length));
  const order = bracketOrder(B);
  const reseed = req.playoff.reseed === true;

  const chains = modes.map((m) => tiebreakChain(m, req.playoff.seeding_rule));
  if (chains.some((c) => !c.known))
    assumptions.push(
      A(
        "the seeding rule is not one ESPN is known to send: read as TOTAL_POINTS_SCORED",
        "the rule is identified",
      ),
    );
  const variants: readonly Variant[] = req.marginal === false ? ["base"] : VARIANTS;
  const tallies = modes.map(() =>
    variants.map((): Tally => ({
      playoffs: 0,
      bye: 0,
      champion: 0,
      seeds: new Float64Array(n),
      rounds: new Float64Array(Math.max(1, bracketRounds)),
    })),
  );

  const G = remaining.length;
  const zg = new Float64Array(2 * G);
  const zp = new Float64Array(Math.max(1, bracketRounds) * n);
  const coin = new Float64Array(n);
  const stream = req.rng.fork("season");
  const wins = new Float64Array(n);
  const losses = new Float64Array(n);
  const ties = new Float64Array(n);
  const pf = new Float64Array(n);
  const pa = new Float64Array(n);
  const simResults: Result[] = remaining.map((g) => ({ a: g.h, b: g.a, winner: 2 }));
  const resultsAll: Result[] = [...playedResults.map((r) => ({ ...r })), ...simResults];

  const evaluate = (v: Variant): void => {
    wins.set(w0);
    losses.set(l0);
    ties.set(t0);
    pf.set(pf0);
    pa.set(pa0);
    playedResults.forEach((r, i) => {
      const t = resultsAll[i];
      if (t !== undefined) t.winner = r.winner;
    });
    const muMe = (mu[me] ?? 0) + (v === "plus_3_ppw" ? SEEDING.plusPointsPerWeek : 0);
    const sgMe = (sigma[me] ?? 0) * (v === "sigma_x0_7" ? 0.7 : v === "sigma_x1_4" ? 1.4 : 1);
    const mOf = (i: number): number => (i === me ? muMe : (mu[i] ?? 0));
    const sOf = (i: number): number => (i === me ? sgMe : (sigma[i] ?? 0));
    if (v === "plus_1_win" && canFlip) {
      wins[me] = (wins[me] ?? 0) + 1;
      losses[me] = (losses[me] ?? 0) - 1;
      const r = flipIndex >= 0 ? resultsAll[flipIndex] : undefined;
      if (r !== undefined) {
        const opp = r.a === me ? r.b : r.a;
        wins[opp] = Math.max(0, (wins[opp] ?? 0) - 1);
        losses[opp] = (losses[opp] ?? 0) + 1;
        r.winner = r.a === me ? 0 : 1;
      }
    }
    if (v === "plus_pf_20") pf[me] = (pf[me] ?? 0) + 20;
    if (v === "plus_pf_40") pf[me] = (pf[me] ?? 0) + 40;
    if (v === "plus_pf_80") pf[me] = (pf[me] ?? 0) + 80;
    for (let g = 0; g < G; g++) {
      const gm = remaining[g];
      if (gm === undefined) continue;
      const rL = Math.sqrt(gm.L);
      let sh = gm.L * mOf(gm.h) + rL * sOf(gm.h) * (zg[2 * g] ?? 0);
      let sa = gm.L * mOf(gm.a) + rL * sOf(gm.a) * (zg[2 * g + 1] ?? 0);
      if ((gm.forced === gm.h && sh < sa) || (gm.forced === gm.a && sa < sh)) [sh, sa] = [sa, sh];
      pf[gm.h] = (pf[gm.h] ?? 0) + sh;
      pa[gm.h] = (pa[gm.h] ?? 0) + sa;
      pf[gm.a] = (pf[gm.a] ?? 0) + sa;
      pa[gm.a] = (pa[gm.a] ?? 0) + sh;
      const sr = simResults[g];
      if (sh > sa) {
        wins[gm.h] = (wins[gm.h] ?? 0) + 1;
        losses[gm.a] = (losses[gm.a] ?? 0) + 1;
        if (sr !== undefined) sr.winner = 0;
      } else if (sa > sh) {
        wins[gm.a] = (wins[gm.a] ?? 0) + 1;
        losses[gm.h] = (losses[gm.h] ?? 0) + 1;
        if (sr !== undefined) sr.winner = 1;
      } else {
        ties[gm.h] = (ties[gm.h] ?? 0) + 1;
        ties[gm.a] = (ties[gm.a] ?? 0) + 1;
        if (sr !== undefined) sr.winner = 2;
      }
    }
    const agg: Agg = { n, wins, losses, ties, pf, pa, div, coin, results: resultsAll };
    modes.forEach((mode, mi) => {
      const chain = chains[mi]?.chain ?? [];
      const order0 = rankAll(chain, mode === "espn_rule" && divisionAware, agg);
      const rank = order0.indexOf(me) + 1;
      const tally = tallies[mi]?.[variants.indexOf(v)];
      if (tally === undefined) return;
      tally.seeds[rank - 1] = (tally.seeds[rank - 1] ?? 0) + 1;
      if (rank <= P) tally.playoffs += 1;
      if (rank <= byes) tally.bye += 1;
      if (!simulateBracket || rank > P) return;
      // the bracket: seeds 1..P (byes are the missing seeds above P), 1-week or multi-week rounds
      let alive: (number | null)[] = order.map((s) => (s <= P ? (order0[s - 1] ?? null) : null));
      const seedOf = (team: number): number => order0.indexOf(team) + 1;
      for (let r = 0; r < bracketRounds; r++) {
        if (reseed && r > 0) {
          const left = alive
            .filter((x): x is number => x !== null)
            .sort((a, b) => seedOf(a) - seedOf(b));
          const size = bracketSize(left.length);
          const ord = bracketOrder(size);
          alive = ord.map((s) => left[s - 1] ?? null);
        }
        const next: (number | null)[] = [];
        for (let k = 0; k < alive.length; k += 2) {
          const x = alive[k] ?? null;
          const y = alive[k + 1] ?? null;
          if (x === null || y === null) {
            next.push(x ?? y);
            continue;
          }
          if (x === me || y === me) tally.rounds[r] = (tally.rounds[r] ?? 0) + 1;
          const L = roundL[r] ?? 1;
          const scoreOf = (team: number): number =>
            L * mOf(team) + Math.sqrt(L) * sOf(team) * (zp[r * n + team] ?? 0);
          const sx = scoreOf(x);
          const sy = scoreOf(y);
          next.push(sx > sy || (sx === sy && seedOf(x) < seedOf(y)) ? x : y);
        }
        alive = next;
      }
      if (bracketRounds === roundsNeeded && alive.length === 1 && alive[0] === me)
        tally.champion += 1;
    });
  };

  const pacer = req.pacer ?? loopPacer(req.clock);
  const run = await runCooperative(
    nSims,
    () => {
      for (let i = 0; i < 2 * G; i++) zg[i] = normalDraw(stream);
      for (let i = 0; i < zp.length; i++) zp[i] = normalDraw(stream);
      for (let i = 0; i < n; i++) coin[i] = stream.next();
      for (const v of variants) evaluate(v);
    },
    { pacer, deadlineMs: req.deadline_ms },
  );
  const k = run.completed;
  if (run.partial)
    warnings.push(`partial: ${String(k)} of ${String(nSims)} paths before the CPU deadline`);

  // current standings under each reading (deterministic: the coin is team order)
  const coinNow = Float64Array.from({ length: n }, (_, i) => n - i);
  const nowAgg: Agg = {
    n,
    wins: w0,
    losses: l0,
    ties: t0,
    pf: pf0,
    pa: pa0,
    div,
    coin: coinNow,
    results: playedResults,
  };
  const remainingOf = (i: number): number => remaining.filter((g) => g.h === i || g.a === i).length;
  const readings: SeasonReading[] = modes.map((mode, mi) => {
    const chain = chains[mi]?.chain ?? [];
    const t = tallies[mi] ?? [];
    const kk = Math.max(1, k);
    const base = t[0];
    const pOf = (x: Tally | undefined): number => (x === undefined ? 0 : x.playoffs / kk);
    const bOf = (x: Tally | undefined): number => (x === undefined ? 0 : x.bye / kk);
    const mv = (name: Variant): MarginalValue => {
      const vi = variants.indexOf(name);
      if (vi < 0) return { d_p_playoffs: 0, d_p_bye: 0 };
      const x = t[vi];
      if (name === "plus_1_win" && !canFlip) return { d_p_playoffs: 0, d_p_bye: 0 };
      return { d_p_playoffs: round(pOf(x) - pOf(base), 4), d_p_bye: round(bOf(x) - bOf(base), 4) };
    };
    const winV = mv("plus_1_win");
    const pfV = mv(`plus_pf_${String(SEEDING.exchangeRatePf)}` as Variant);
    const pfPerWin =
      mode === "points_only" ||
      variants.length === 1 ||
      !canFlip ||
      pfV.d_p_playoffs < SEEDING.minExchangeDelta
        ? null
        : round(
            Math.min(
              SEEDING.maxPfPerWin,
              Math.max(0, (winV.d_p_playoffs / pfV.d_p_playoffs) * SEEDING.exchangeRatePf),
            ),
            1,
          );
    // the cutoff from today's standings
    const nowOrder = rankAll(chain, mode === "espn_rule" && divisionAware, nowAgg);
    const myRank = nowOrder.indexOf(me) + 1;
    const ref = myRank <= P ? nowOrder[P] : nowOrder[P - 1];
    const winsGap = ref === undefined ? 0 : (w0[me] ?? 0) - (w0[ref] ?? 0);
    const pfGap = ref === undefined ? 0 : (pf0[me] ?? 0) - (pf0[ref] ?? 0);
    let pfRankNeeded: number | null = null;
    if (mode === "points_only") pfRankNeeded = P;
    else {
      const myPct = pct(w0[me] ?? 0, l0[me] ?? 0, t0[me] ?? 0);
      const ahead = nowOrder.filter(
        (i) => pct(w0[i] ?? 0, l0[i] ?? 0, t0[i] ?? 0) > myPct + 1e-9,
      ).length;
      const group = nowOrder.filter(
        (i) => Math.abs(pct(w0[i] ?? 0, l0[i] ?? 0, t0[i] ?? 0) - myPct) <= 1e-9,
      ).length;
      const spots = P - ahead;
      if (spots > 0 && spots < group) pfRankNeeded = spots;
    }
    // clinch / elimination: deterministic, wins only (reading (a)); PF is unbounded under (b)
    let clinched = false;
    let eliminated = false;
    let magic: number | null = null;
    if (mode === "espn_rule") {
      const myW = w0[me] ?? 0;
      const myMax = myW + remainingOf(me);
      const adj = divisionAware ? divIds.length - 1 : 0;
      const rivals = Array.from({ length: n }, (_, i) => i).filter((i) => i !== me);
      const above = rivals.filter((i) => (w0[i] ?? 0) > myMax).length;
      const divRivalAbove = rivals.some((i) => div[i] === div[me] && (w0[i] ?? 0) > myMax);
      eliminated = above >= P && (!divisionAware || divRivalAbove);
      const reachers = (target: number): number =>
        rivals.filter((i) => (w0[i] ?? 0) + remainingOf(i) >= target).length + adj;
      clinched = reachers(myW) < P;
      if (!eliminated)
        for (let m = 0; m <= remainingOf(me); m++)
          if (reachers(myW + m) < P) {
            magic = m;
            break;
          }
    }
    const seedDist = Array.from(t[0]?.seeds ?? [], (c, i) => ({
      seed: i + 1,
      p: round(c / kk, 4),
    })).filter((x) => x.p > 0);
    const aliveByWeek: { week: Week; p: number }[] = (req.regular_weeks ?? []).map((w) => ({
      week: w,
      p: 1,
    }));
    rounds.slice(0, bracketRounds).forEach((r, ri) => {
      for (const w of r.weeks)
        aliveByWeek.push({ week: w, p: round((base?.rounds[ri] ?? 0) / kk, 4) });
    });
    return {
      seeding_mode: mode,
      p_playoffs: round(pOf(base), 4),
      p_bye: round(bOf(base), 4),
      p_champion:
        simulateBracket && bracketRounds === roundsNeeded
          ? round((base?.champion ?? 0) / kk, 4)
          : null,
      seed_distribution: seedDist,
      p_alive_by_week: aliveByWeek,
      tiebreak_chain: [
        ...(mode === "espn_rule" && divisionAware ? ["division_winners_first"] : []),
        ...chain,
      ],
      cutoff: {
        seed_line: P,
        wins_gap: winsGap,
        pf_gap: round(pfGap, 2),
        pf_rank_needed: pfRankNeeded,
      },
      marginal_values: {
        plus_1_win: winV,
        plus_pf_20: mv("plus_pf_20"),
        plus_pf_40: mv("plus_pf_40"),
        plus_pf_80: mv("plus_pf_80"),
        plus_3_ppw: mv("plus_3_ppw"),
        sigma_x0_7: mv("sigma_x0_7"),
        sigma_x1_4: mv("sigma_x1_4"),
      },
      pf_per_win: pfPerWin,
      clinch: { clinched, eliminated, magic_number: magic },
      scenarios_applied: applied,
    };
  });

  const used = readings[0];
  const inputs = mergeInputs(collectInputs(req.stamps ?? [], req.clock), req.inputs ?? []);
  const p = used?.p_playoffs ?? 0;
  const se = Math.sqrt((p * (1 - p)) / Math.max(1, k));
  const modeUsed = req.seeding_mode === "both" ? "both" : (modes[0] ?? "espn_rule");
  const rec = {
    action:
      used === undefined
        ? "no season outlook"
        : `season outlook: P(playoffs) ${String(round(p, 3))}, P(bye) ${String(round(used.p_bye, 3))} under ${used.seeding_mode}`,
    subjects: [],
    lineup: null,
    point_estimate: round(p, 4),
    distribution: normalDist(p, se, "position_cv"),
    delta_vs_next: { value: 0, p10: round(-Z90 * se, 4), p90: round(Z90 * se, 4) },
    decision_metric: "p_playoffs",
    drivers:
      used === undefined
        ? []
        : [
            { name: "plus_1_win", contribution: used.marginal_values.plus_1_win.d_p_playoffs },
            { name: "plus_pf_40", contribution: used.marginal_values.plus_pf_40.d_p_playoffs },
          ],
    assumptions,
    confidence: { role_games: 0, inputs },
    as_of: newestAsOf(inputs, req.clock.nowIso()),
    latest_execution_time: null,
    no_move: true,
    log_id: null,
  } as const;
  const both = readings.length === 2 ? readings : null;
  return {
    data: {
      mode: "season",
      seeding: seedingStatus(modeUsed, req.seeding_config.confirmed_at),
      readings,
      divergence:
        both === null
          ? null
          : {
              p_playoffs_delta_between_readings: round(
                (both[0]?.p_playoffs ?? 0) - (both[1]?.p_playoffs ?? 0),
                4,
              ),
            },
      playoff_pct_espn: req.playoff_pct_espn ?? null,
      division_aware: divisionAware,
      n_sims: k,
      rec,
      inputs,
    },
    partial: run.partial,
    warnings,
    models: new Map(
      req.teams.map((t, i) => [
        t.team_id,
        { mu: round(mu[i] ?? 0, 3), sigma: round(sigma[i] ?? 0, 3) },
      ]),
    ),
  };
}
