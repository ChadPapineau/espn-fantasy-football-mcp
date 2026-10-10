// negatives.ts — research 05 §8.3's negatives ("things that sound smart and are not") re-checked with
// the product's own numbers (plan 10 §3.3 C10: written to docs/evals/phase3-negatives.md, a recurring
// pre-season job from now on; sib research 05 §12.5 "refresh the 'does not predict' list with the
// product's own numbers"). Pure: the caller scores each player-week through the plan 08 engine under
// the league's settings and the named variants (5 → 4 pt pass TD, −2 → −1 INT), and passes the pro
// schedule and the finished ESPN league-seasons; the shipped allocation (research 05 §4.1, E4) and
// waiver DP (§1.2, E5) are used as shipped. Every check returns research 05's number beside the
// product's and a verdict by a rule stated in the check, never by judgement. New here.
import { allocate, type AllocationEntry, type AllocationPlan } from "../analytics/replacement.js";
import { demandOf, solvePremiumTable } from "../analytics/waiverDp.js";
import { at, stableMean, stableSum } from "./metrics.js";

/** The positions the checks read. */
export const NEG_POSITIONS = Object.freeze(["QB", "RB", "WR", "TE"] as const);
export type NegPosition = (typeof NEG_POSITIONS)[number];

/** The scoring variants a row carries (the league's own settings are `reference`). */
export const NEG_VARIANTS = Object.freeze(["reference", "pass_td_4", "int_minus_1"] as const);
export type NegVariant = (typeof NEG_VARIANTS)[number];

/** One player-week under every variant. */
export interface NegPlayerWeek {
  readonly player_id: string;
  readonly position: NegPosition;
  /** The player's team that week (a pro-team abbreviation). */
  readonly team: string;
  readonly season: number;
  readonly week: number;
  readonly points: Readonly<Record<NegVariant, number>>;
}

/** One pro game side: `team` played `opponent` in `week`. */
export interface NegGameSide {
  readonly season: number;
  readonly week: number;
  readonly team: string;
  readonly opponent: string;
}

/** One finished league-season (records and seeds from mTeam, the playoff size from mSettings). */
export interface NegLeagueSeason {
  readonly playoff_team_count: number;
  /** ESPN's acquisition setting: true = the waiver order resets, false = rolling. */
  readonly waiver_order_reset: boolean;
  readonly uses_faab: boolean;
  readonly teams: readonly {
    readonly wins: number;
    readonly losses: number;
    readonly ties: number;
    readonly points_for: number;
    readonly playoff_seed: number;
  }[];
}

/** Everything the report reads. */
export interface NegativesInput {
  readonly rows: readonly NegPlayerWeek[];
  readonly seasons: readonly number[];
  /** The league's allocation plan (its own roster settings) and size. */
  readonly plan: AllocationPlan;
  readonly league_size: number;
  /** Per-game baselines need this many games (research 05 §4.1: ≥ 8). */
  readonly min_games: number;
  readonly schedule: readonly NegGameSide[];
  readonly league_seasons: readonly NegLeagueSeason[];
}

/** A verdict by the check's stated rule. */
export type NegVerdict = "holds" | "holds_revised" | "overturned" | "not_rechecked";

/** One re-checked negative. */
export interface NegativeCheck {
  readonly id: string;
  readonly verdict: NegVerdict;
  /** The product's numbers (null = not computable on the data given). */
  readonly product: Readonly<Record<string, number | null>>;
  /** The rule the verdict follows (fixed text). */
  readonly rule: string;
}

// --- small statistics --------------------------------------------------------------------------------

/** Pearson's r; null with fewer than 3 pairs or no variance. */
export function pearson(x: readonly number[], y: readonly number[]): number | null {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  const mx = stableSum(x.slice(0, n)) / n;
  const my = stableSum(y.slice(0, n)) / n;
  const sxy: number[] = [];
  const sxx: number[] = [];
  const syy: number[] = [];
  for (let i = 0; i < n; i++) {
    const dx = at(x, i) - mx;
    const dy = at(y, i) - my;
    sxy.push(dx * dy);
    sxx.push(dx * dx);
    syy.push(dy * dy);
  }
  const d = Math.sqrt(stableSum(sxx) * stableSum(syy));
  return d > 0 ? stableSum(sxy) / d : null;
}

const round = (x: number | null, dp = 2): number | null =>
  x === null || !Number.isFinite(x) ? null : Number(x.toFixed(dp));

/** One player's season under a variant: games and points, position by majority. */
export interface NegSeasonLine {
  readonly player_id: string;
  readonly position: NegPosition;
  readonly games: number;
  readonly points: number;
}

/** Season lines of one season under one variant (a game = one weekly row). */
export function seasonLines(
  rows: readonly NegPlayerWeek[],
  season: number,
  variant: NegVariant,
): NegSeasonLine[] {
  const acc = new Map<string, { votes: Map<NegPosition, number>; games: number; pts: number[] }>();
  for (const r of rows) {
    if (r.season !== season) continue;
    const e = acc.get(r.player_id) ?? { votes: new Map<NegPosition, number>(), games: 0, pts: [] };
    e.votes.set(r.position, (e.votes.get(r.position) ?? 0) + 1);
    e.games += 1;
    e.pts.push(r.points[variant]);
    acc.set(r.player_id, e);
  }
  const out: NegSeasonLine[] = [];
  for (const [id, e] of acc) {
    // the majority position (ties: the first seen); every player has at least one vote
    let best: [NegPosition, number] = [...e.votes.entries()][0] ?? ["QB", 0];
    for (const v of e.votes) if (v[1] > best[1]) best = v;
    out.push({ player_id: id, position: best[0], games: e.games, points: stableSum(e.pts) });
  }
  // Map keys are unique, so no two ids compare equal
  return out.sort((a, b) => (a.player_id < b.player_id ? -1 : 1));
}

/** Values of a position, best first (season totals, or per game for players with ≥ minGames). */
function ranked(
  lines: readonly NegSeasonLine[],
  pos: NegPosition,
  basis: "season_total" | "per_game",
  minGames: number,
): number[] {
  return lines
    .filter((l) => l.position === pos && (basis === "season_total" || l.games >= minGames))
    .map((l) => (basis === "per_game" ? l.points / l.games : l.points))
    .sort((a, b) => b - a);
}

/** The shipped allocation's baselines for a season (research 05 §4.1). */
function baselines(
  lines: readonly NegSeasonLine[],
  input: NegativesInput,
  basis: "season_total" | "per_game",
): Readonly<Record<string, number>> {
  const entries: AllocationEntry[] = lines
    .filter((l) => basis === "season_total" || l.games >= input.min_games)
    .map((l) => ({
      key: l.player_id,
      position: l.position,
      value: basis === "per_game" ? l.points / l.games : l.points,
    }));
  return allocate(entries, input.plan, input.league_size).baseline;
}

const nth = (xs: readonly number[], rank: number): number | null => xs[rank - 1] ?? null;

// --- the checks -----------------------------------------------------------------------------------

/**
 * "Hoard the #1 waiver slot" and "never claim from a high slot": the shipped cold-start DP (N =
 * league size) — V(1, 16), V(N, 16), and the #1 slot's per-week threshold with 10 weeks of value
 * left, Π(1, 9)/10 (W counts the weeks AFTER this week's claim — plan 07 E5, R5-1) — and the
 * probability a player worth r points a week clears the N − 1 rivals ahead, (1 − q(r))^(N−1).
 * Holds while that threshold stays a modest upgrade (≤ 3 pts/week) and a 4.5-pt/week player
 * clears with probability < 5 %.
 */
export function waiverChecks(leagueSize: number): [NegativeCheck, NegativeCheck] {
  const t = solvePremiumTable({ teams: leagueSize });
  const r10 = t.premium(1, 9) / 10;
  const clear = (r: number): number => (1 - demandOf(r)) ** (leagueSize - 1);
  return [
    {
      id: "hoard_first_slot",
      verdict: r10 <= 3 ? "holds" : "overturned",
      product: {
        v_1_16: round(t.value(1, 16), 1),
        v_n_16: round(t.value(leagueSize, 16), 1),
        threshold_k1_10_weeks_left: round(r10, 2),
      },
      rule: "holds while Π(1, 9)/10 ≤ 3 pts/week with 10 weeks left (a modest upgrade beats holding the #1 slot)",
    },
    {
      id: "never_claim_high_slot",
      verdict: clear(4.5) < 0.05 ? "holds" : "overturned",
      product: {
        p_clear_r2_5: round(clear(2.5), 3),
        p_clear_r4_5: round(clear(4.5), 4),
        p_clear_r7: round(clear(7), 5),
      },
      rule: "holds while a 4.5-pt/week player clears every rival ahead with probability < 5 %",
    },
  ];
}

/**
 * "5-pt passing TDs mean draft a QB early": per season, QB1 − QB12 (season points) beside RB1's and
 * WR1's season-total VOR over the shipped allocation's baselines; the QB VOR pool (QB1..QB10 over
 * QB12) at 5 vs 4 pt; QB1's per-game edge over QB12 at 5 vs 4 pt; QB10 − QB12 per game. Holds while
 * QB1 − QB12 ≤ the larger of RB1's and WR1's VOR in every season (QB1 is WR1-class at most).
 */
export function qbScarcityCheck(input: NegativesInput): NegativeCheck {
  const product: Record<string, number | null> = {};
  let ok = true;
  for (const s of input.seasons) {
    const ref = seasonLines(input.rows, s, "reference");
    const td4 = seasonLines(input.rows, s, "pass_td_4");
    const qb5 = ranked(ref, "QB", "season_total", input.min_games);
    const qb4 = ranked(td4, "QB", "season_total", input.min_games);
    const base = baselines(ref, input, "season_total");
    const qbVor = (nth(qb5, 1) ?? 0) - (nth(qb5, 12) ?? 0);
    const rbVor = (nth(ranked(ref, "RB", "season_total", 0), 1) ?? 0) - (base.RB ?? 0);
    const wrVor = (nth(ranked(ref, "WR", "season_total", 0), 1) ?? 0) - (base.WR ?? 0);
    const pool = (xs: readonly number[]): number =>
      stableSum(xs.slice(0, 10).map((v) => v - (nth(xs, 12) ?? 0)));
    const pg5 = ranked(ref, "QB", "per_game", input.min_games);
    const pg4 = ranked(td4, "QB", "per_game", input.min_games);
    const edge = (xs: readonly number[]): number => (nth(xs, 1) ?? 0) - (nth(xs, 12) ?? 0);
    product[`${String(s)}.qb1_minus_qb12`] = round(qbVor, 1);
    product[`${String(s)}.rb1_vor`] = round(rbVor, 1);
    product[`${String(s)}.wr1_vor`] = round(wrVor, 1);
    product[`${String(s)}.qb_vor_pool_change_pct`] = round(
      pool(qb4) > 0 ? ((pool(qb5) - pool(qb4)) / pool(qb4)) * 100 : null,
      1,
    );
    product[`${String(s)}.qb1_edge_change_ppg`] = round(edge(pg5) - edge(pg4), 2);
    product[`${String(s)}.qb10_minus_qb12_ppg`] = round(
      (nth(pg5, 10) ?? 0) - (nth(pg5, 12) ?? 0),
      2,
    );
    ok &&= qbVor <= Math.max(rbVor, wrVor);
  }
  return {
    id: "five_point_td_qb_early",
    verdict: ok ? "holds" : "overturned",
    product,
    rule: "holds while QB1 − QB12 ≤ max(RB1, WR1 season-total VOR) in every season",
  };
}

/**
 * "−2 INT makes turnover-prone QBs unstartable": the top 24 QBs by season points under the league's
 * −2, their ranks under −1, the largest rank move, the marginal level shift of −1 → −2 (mean of
 * (pts(−1) − pts(−2)) / pts(−1)) and the whole −2 penalty's share of a QB's points before it (mean of
 * 2·INT / (pts(−2) + 2·INT), INT = pts(−1) − pts(−2)). Holds (as written) while no top-24 QB moves
 * more than one rank in any season; revised while the largest move is two or three; overturned beyond.
 */
export function intPenaltyCheck(input: NegativesInput): NegativeCheck {
  const product: Record<string, number | null> = {};
  let worst = 0;
  for (const s of input.seasons) {
    const ref = seasonLines(input.rows, s, "reference").filter((l) => l.position === "QB");
    const alt = seasonLines(input.rows, s, "int_minus_1").filter((l) => l.position === "QB");
    const order = (ls: readonly NegSeasonLine[]): string[] =>
      [...ls]
        .sort((a, b) => b.points - a.points || (a.player_id < b.player_id ? -1 : 1))
        .map((l) => l.player_id);
    const refOrder = order(ref);
    const altOrder = order(alt);
    const top = refOrder.slice(0, 24);
    let maxMove = 0;
    for (const [i, id] of top.entries())
      maxMove = Math.max(maxMove, Math.abs(altOrder.indexOf(id) - i));
    const altPts = new Map(alt.map((l) => [l.player_id, l.points]));
    const refPts = new Map(ref.map((l) => [l.player_id, l.points]));
    const shifts: number[] = [];
    const shares: number[] = [];
    for (const id of top) {
      const a = altPts.get(id) ?? 0;
      const r = refPts.get(id) ?? 0;
      const ints = a - r;
      if (a > 0) shifts.push((ints / a) * 100);
      if (r + 2 * ints > 0) shares.push(((2 * ints) / (r + 2 * ints)) * 100);
    }
    product[`${String(s)}.max_rank_move_top24`] = maxMove;
    product[`${String(s)}.level_shift_pct`] = round(stableMean(shifts), 1);
    product[`${String(s)}.penalty_share_pct`] = round(stableMean(shares), 1);
    worst = Math.max(worst, maxMove);
  }
  return {
    id: "int_minus_two_unstartable",
    verdict: worst <= 1 ? "holds" : worst <= 3 ? "holds_revised" : "overturned",
    product,
    rule: "holds while no top-24 QB moves > 1 rank between −1 and −2 per INT; revised at 2–3; overturned beyond",
  };
}

/** Research 05 §8.3's QB–WR1 weekly correlation (this format, 2024–2025). */
export const RESEARCH_STACK_R = 0.35;

/**
 * "Stack QB–WR to score more": the weekly correlation of each team's QB1 and WR1 (by season points
 * for that team), pooled over the team-weeks both played. A correlation changes the variance of a
 * lineup, never its mean, so the negative holds for any r; the number is reported against research
 * 05's 0.35 (revised when it moves by more than 0.1).
 */
export function stackCheck(input: NegativesInput): NegativeCheck {
  const product: Record<string, number | null> = {};
  const all: [number, number][] = [];
  for (const s of input.seasons) {
    const rows = input.rows.filter((r) => r.season === s);
    const totals = new Map<string, { team: string; pos: string; id: string; v: number }>();
    for (const r of rows) {
      const k = `${r.team}|${r.position}|${r.player_id}`;
      const t = totals.get(k) ?? { team: r.team, pos: r.position, id: r.player_id, v: 0 };
      t.v += r.points.reference;
      totals.set(k, t);
    }
    // each team's QB1 and WR1 by season points (ties: the smaller key, for determinism)
    const best = new Map<string, { id: string; v: number }>();
    for (const [, t] of [...totals.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const key = `${t.team}|${t.pos}`;
      const prev = best.get(key);
      if (prev === undefined || t.v > prev.v) best.set(key, { id: t.id, v: t.v });
    }
    const top = new Map<string, string>([...best].map(([k, b]) => [k, b.id]));
    const weekly = new Map<string, number>();
    for (const r of rows)
      weekly.set(`${r.team}|${String(r.week)}|${r.player_id}`, r.points.reference);
    const pairs: [number, number][] = [];
    const teams = new Set(rows.map((r) => r.team));
    for (const team of [...teams].sort()) {
      const qb = top.get(`${team}|QB`);
      const wr = top.get(`${team}|WR`);
      if (qb === undefined || wr === undefined) continue;
      for (let w = 1; w <= 18; w++) {
        const a = weekly.get(`${team}|${String(w)}|${qb}`);
        const b = weekly.get(`${team}|${String(w)}|${wr}`);
        if (a !== undefined && b !== undefined) pairs.push([a, b]);
      }
    }
    const r = pearson(
      pairs.map((p) => p[0]),
      pairs.map((p) => p[1]),
    );
    product[`${String(s)}.r`] = round(r, 2);
    product[`${String(s)}.n_pairs`] = pairs.length;
    all.push(...pairs);
  }
  const rAll = pearson(
    all.map((p) => p[0]),
    all.map((p) => p[1]),
  );
  product.pooled_r = round(rAll, 2);
  const maxDev = rAll === null ? 0 : Math.abs(rAll - RESEARCH_STACK_R);
  return {
    id: "stack_scores_more",
    verdict: maxDev > 0.1 ? "holds_revised" : "holds",
    product,
    rule: "holds for any r (a correlation moves variance, not the mean); revised when the pooled r is > 0.1 from research 05's 0.35",
  };
}

/**
 * "Carry a backup QB/TE for the bye": QB10 − QB12 and TE5's VOR over the shipped baseline, per game
 * (≥ min_games). Holds while QB10 − QB12 < 1 pt/game in every season.
 */
export function backupCheck(input: NegativesInput): NegativeCheck {
  const product: Record<string, number | null> = {};
  let ok = true;
  for (const s of input.seasons) {
    const ref = seasonLines(input.rows, s, "reference");
    const qb = ranked(ref, "QB", "per_game", input.min_games);
    const te = ranked(ref, "TE", "per_game", input.min_games);
    const base = baselines(ref, input, "per_game");
    const gap = (nth(qb, 10) ?? 0) - (nth(qb, 12) ?? 0);
    product[`${String(s)}.qb10_minus_qb12_ppg`] = round(gap, 2);
    product[`${String(s)}.te5_vor_ppg`] = round((nth(te, 5) ?? 0) - (base.TE ?? 0), 2);
    ok &&= gap < 1;
  }
  return {
    id: "carry_backup_qb_te",
    verdict: ok ? "holds" : "overturned",
    product,
    rule: "holds while QB10 − QB12 < 1 pt/game in every season",
  };
}

/**
 * "ESPN's position-vs-opponent ratings rank the matchups" and "plan playoff weeks by September SOS":
 * fantasy points each defence allowed per position per game, correlated across defences between two
 * week ranges of the same season (weeks 1–8 vs 9–17; weeks 1–4 vs 15–17). Holds while the mean r
 * over the four positions is < 0.4 (weak — regress toward 1 and ramp in, research 05 §8.3).
 */
export function dvpChecks(input: NegativesInput): [NegativeCheck, NegativeCheck] {
  const opp = new Map<string, string>();
  for (const g of input.schedule)
    opp.set(`${String(g.season)}|${String(g.week)}|${g.team}`, g.opponent);
  const seasons = input.seasons.filter((s) => input.schedule.some((g) => g.season === s));
  const corr = (
    s: number,
    a: readonly [number, number],
    b: readonly [number, number],
  ): Record<NegPosition, number | null> => {
    const allowed = new Map<string, number>();
    const games = new Map<string, Set<number>>();
    for (const r of input.rows) {
      if (r.season !== s) continue;
      const d = opp.get(`${String(s)}|${String(r.week)}|${r.team}`);
      if (d === undefined) continue;
      const k = `${d}|${r.position}|${String(r.week)}`;
      allowed.set(k, (allowed.get(k) ?? 0) + r.points.reference);
      games.set(d, (games.get(d) ?? new Set<number>()).add(r.week));
    }
    const out = {} as Record<NegPosition, number | null>;
    for (const pos of NEG_POSITIONS) {
      const xa: number[] = [];
      const xb: number[] = [];
      for (const [d, played] of [...games.entries()].sort(([x], [y]) => (x < y ? -1 : 1))) {
        const per = (lo: number, hi: number): number | null => {
          const ws = [...played].filter((w) => w >= lo && w <= hi);
          if (ws.length === 0) return null;
          return stableSum(ws.map((w) => allowed.get(`${d}|${pos}|${String(w)}`) ?? 0)) / ws.length;
        };
        const va = per(a[0], a[1]);
        const vb = per(b[0], b[1]);
        if (va !== null && vb !== null) {
          xa.push(va);
          xb.push(vb);
        }
      }
      out[pos] = pearson(xa, xb);
    }
    return out;
  };
  const build = (
    id: string,
    a: readonly [number, number],
    b: readonly [number, number],
    rule: string,
  ): NegativeCheck => {
    if (seasons.length === 0) return { id, verdict: "not_rechecked", product: {}, rule };
    const product: Record<string, number | null> = {};
    const rs: number[] = [];
    for (const s of seasons) {
      const c = corr(s, a, b);
      for (const pos of NEG_POSITIONS) {
        product[`${String(s)}.${pos}`] = round(c[pos], 2);
        const v = c[pos];
        if (v !== null) rs.push(v);
      }
    }
    const m = stableMean(rs);
    product.mean_r = round(m, 2);
    return { id, verdict: m !== null && m < 0.4 ? "holds" : "overturned", product, rule };
  };
  return [
    build(
      "espn_dvp_ranks_matchups",
      [1, 8],
      [9, 17],
      "holds while the mean split-half r (weeks 1–8 vs 9–17) of points allowed by position is < 0.4",
    ),
    build(
      "september_sos_for_playoffs",
      [1, 4],
      [15, 17],
      "holds while the mean r of points allowed in weeks 1–4 vs 15–17 is < 0.4",
    ),
  ];
}

/** Research 05 §8.3's simulated share of seasons whose last playoff seat points-for decides. */
export const RESEARCH_PF_CUTOFF_SHARE = 0.56;

/**
 * "When the matchup is decided, the rest of the week doesn't matter": on the finished league-seasons,
 * whether the last team in and the first team out had the same record (then points-for decided the
 * last playoff seat — ESPN's TOTAL_POINTS_SCORED tiebreak). Holds while points-for decided it in at
 * least one league-season (every point can count); revised when the observed share is more than
 * 0.25 from research 05's simulated 56 % (a 6-of-10 bracket; n is small — report, do not tune on it).
 */
export function pfCutoffCheck(leagues: readonly NegLeagueSeason[]): NegativeCheck {
  let decided = 0;
  let n = 0;
  for (const l of leagues) {
    const byseed = new Map(l.teams.map((t) => [t.playoff_seed, t]));
    const lastIn = byseed.get(l.playoff_team_count);
    const firstOut = byseed.get(l.playoff_team_count + 1);
    if (lastIn === undefined || firstOut === undefined) continue;
    n++;
    if (
      lastIn.wins === firstOut.wins &&
      lastIn.losses === firstOut.losses &&
      lastIn.ties === firstOut.ties
    )
      decided++;
  }
  const share = n === 0 ? null : decided / n;
  return {
    id: "decided_matchup_rest_irrelevant",
    verdict:
      share === null
        ? "not_rechecked"
        : decided === 0
          ? "overturned"
          : Math.abs(share - RESEARCH_PF_CUTOFF_SHARE) > 0.25
            ? "holds_revised"
            : "holds",
    product: { league_seasons: n, pf_decided_last_seat: decided, share: round(share, 2) },
    rule: "holds while points-for decided the last playoff seat in ≥ 1 finished league-season; revised when the share is > 0.25 from the simulated 0.56",
  };
}

/**
 * "The waiver order resets weekly, so priority doesn't matter": among the finished league-seasons,
 * how many use rolling priority (no FAAB, `waiverOrderReset` false). Holds while any does — ESPN
 * offers both rules and the product reads the setting, never assumes it.
 */
export function waiverResetCheck(leagues: readonly NegLeagueSeason[]): NegativeCheck {
  const rolling = leagues.filter((l) => !l.uses_faab && !l.waiver_order_reset).length;
  const priority = leagues.filter((l) => !l.uses_faab).length;
  return {
    id: "waiver_order_resets",
    verdict: leagues.length === 0 ? "not_rechecked" : rolling > 0 ? "holds" : "holds_revised",
    product: { league_seasons: leagues.length, priority_leagues: priority, rolling },
    rule: "holds while ≥ 1 finished league-season uses rolling (move-to-last) priority",
  };
}

/** The negatives not re-checkable on this data, and why (fixed text). */
export const NOT_RECHECKED: Readonly<Record<string, string>> = Object.freeze({
  pf_seeding_high_ceiling:
    "needs the seeding simulator's variance experiment (C2/C4 owners), not a history statistic",
  handcuff_rb1:
    "no labelled handcuff outcomes exist in the committed history (sib §18: no rigorous study)",
  ir_any_injured:
    "an ESPN rule (IR eligibility), verified at the source in research 05 §4.3 — not a statistic",
  trending_adds: "needs Sleeper trending history; the product uses trending only as demand (q_i)",
  clinched_week_17:
    "unproven by research 05 itself; no week-17 rest labels in the committed history",
});

/** The whole report: every computable check, in research 05 §8.3's order. */
export function negativesReport(input: NegativesInput): NegativeCheck[] {
  const [hoard, neverClaim] = waiverChecks(input.league_size);
  const [dvp, sos] = dvpChecks(input);
  return [
    hoard,
    neverClaim,
    qbScarcityCheck(input),
    intPenaltyCheck(input),
    stackCheck(input),
    pfCutoffCheck(input.league_seasons),
    backupCheck(input),
    dvp,
    sos,
    waiverResetCheck(input.league_seasons),
  ];
}
