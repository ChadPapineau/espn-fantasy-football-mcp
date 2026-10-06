// replacement.ts — E4 `espn_analyze_replacement` (plan 07 E4 = sib 07 E4 with `player_id` and
// `format_notes`; plan 10 B7): replacement level by ALLOCATION for the league's exact slots
// (research 05 §4.1 for N = 10 — every dedicated starting slot filled for all N teams from the
// sorted per-game values, then every flex seat greedily from the best remaining eligible player,
// narrowest flex first; the baseline of a position is the best player not slotted, except QB, read
// at "10 starters + the two backups a 10-team league typically rosters" = QB12, research 05 §3.1),
// the bench effect as an optional input (cold start: none — research 05 §4.1 (4)), per-game values
// over the horizon's non-bye weeks (never season totals — research 05 §8.2 #15; sib research 05 §2),
// the starter baseline weekly and ROS, the stream baseline (the best player actually available in
// the pool), the drop-off curve, gap tiers, `VOR_weekly`, `VOR_ROS` as a Dist, `xVBD` (Stuart's
// expected VBD: E[max(X − baseline, 0)]), streamability = mean_w best available / the league's last
// starter, and the format notes (the flex split, QB10 − replacement, streamable positions). Weekly
// allocations run as cooperative batches under the CPU deadline (plan 01 §1.1). Pure. New here (the
// sibling's E4 is planned, not built); the method is sib research 05 §2 adapted to ESPN slot ids.
import type { Clock } from "../clock.js";
import type { BareText, RosterSlots, Week } from "../league/types.js";
import type { Dist } from "../scoring/types.js";
import { DEFAULT_CV, POSITION_CV } from "./constants.js";
import { loopPacer, runCooperative, type Pacer } from "./cooperative.js";
import { ensure } from "./errors.js";
import { type AnyStamp, collectInputs, mergeInputs } from "./inputs.js";
import { normalCdf, normalDist, normalPdf, round, sigmaOf } from "./math.js";
import type { Assumption, InputFreshness, ReplacementData } from "./types.js";

/** E4's constants (research 05 §3.1, §4.1, §4.2; sib research 05 §2) — [U] where marked. */
export const REPLACEMENT = Object.freeze({
  /**
   * Backup QBs rostered per team (research 05 §3.1: "the QB baseline is QB12 … 10 starters + the
   * two backups a 10-team league typically rosters"): the QB baseline is read `round(0.2 × N)` past
   * the last starter, at least one — only while no flex seat accepts a QB (a superflex league slots
   * its QBs through the allocation instead; the research has no figure for it [U]).
   */
  qbBackupsPerTeam: 0.2,
  /** Streamability at or above which a position is streamable (plan 10 B7's 0.9). */
  streamableMin: 0.9,
  /** A position's streamability is reported inside [0, this]. */
  streamabilityMax: 1.5,
  /** Curve ranks reported per position (the baseline rank plus a margin, at most this many). */
  curveMaxRank: 30,
  curvePastBaseline: 2,
  /** A tier break is a gap ≥ max(tierGapMin, tierGapFactor × the median adjacent gap) [U]. */
  tierGapMin: 0.5,
  tierGapFactor: 2.5,
  maxTiers: 8,
  /** Players returned by default, and the most one call returns. */
  defaultPlayers: 30,
  maxPlayers: 60,
  /** Available players per position always listed (the waiver-relevant tail). */
  topAvailablePerPosition: 3,
  /** Players one call accepts (all rosters plus ≤ 3 pool pages, with margin). */
  maxInputPlayers: 3000,
  maxWeeks: 22,
  minTeams: 2,
  maxTeams: 20,
});

// --- the allocation kernel (research 05 §4.1) ----------------------------------------------------------

/** One value the allocation ranks: a player at his display position. */
export interface AllocationEntry {
  readonly key: number | string;
  readonly position: string;
  readonly value: number;
}

/** The league's starting seats per team, as the allocation reads them. */
export interface AllocationPlan {
  /** Dedicated starting seats per team by position (`QB: 1, RB: 2, …`). */
  readonly fixed: Readonly<Record<string, number>>;
  /** Flex seat types per team, narrowest first (ties by display order): slot name, positions, count. */
  readonly flex: readonly {
    readonly slot: string;
    readonly positions: readonly string[];
    readonly count: number;
  }[];
}

/** The allocation plan of a league's roster settings (dedicated vs flex seats; bench/IR ignored). */
export function allocationPlanOf(roster: RosterSlots): AllocationPlan {
  const fixed: Record<string, number> = {};
  const flex: { slot: string; positions: string[]; count: number; order: number }[] = [];
  roster.slots.forEach((s, order) => {
    if (s.count <= 0) return;
    if (s.class === "starter" && s.eligible_positions.length === 1) {
      const pos = s.eligible_positions[0] ?? "";
      fixed[pos] = (fixed[pos] ?? 0) + s.count;
    } else if (s.class === "flex" || (s.class === "starter" && s.eligible_positions.length > 1)) {
      flex.push({ slot: s.name, positions: [...s.eligible_positions], count: s.count, order });
    }
  });
  flex.sort((a, b) => a.positions.length - b.positions.length || a.order - b.order);
  return Object.freeze({
    fixed: Object.freeze(fixed),
    flex: Object.freeze(
      flex.map((f) =>
        Object.freeze({ slot: f.slot, positions: Object.freeze(f.positions), count: f.count }),
      ),
    ),
  });
}

/** The positions an allocation plan starts (dedicated or through a flex), in a stable order. */
export function planPositions(plan: AllocationPlan): string[] {
  const set = new Set<string>(Object.keys(plan.fixed));
  for (const f of plan.flex) for (const p of f.positions) set.add(p);
  const order = ["QB", "TQB", "RB", "WR", "TE", "K", "D/ST"];
  return [...set].sort(
    (a, b) =>
      (order.includes(a) ? order.indexOf(a) : 99) - (order.includes(b) ? order.indexOf(b) : 99) ||
      (a < b ? -1 : a > b ? 1 : 0),
  );
}

/**
 * How far past the last slotted starter a position's baseline is read (1 = the best unslotted player,
 * research 05 §4.1); QB `max(1, round(0.2 × N))` while no flex seat takes a QB (research 05 §3.1).
 */
export function replacementDepth(plan: AllocationPlan, leagueSize: number): Record<string, number> {
  const out: Record<string, number> = {};
  const qbInFlex = plan.flex.some((f) => f.positions.includes("QB"));
  for (const pos of planPositions(plan))
    out[pos] =
      pos === "QB" && !qbInFlex
        ? Math.max(1, Math.round(REPLACEMENT.qbBackupsPerTeam * leagueSize))
        : 1;
  return out;
}

/** What one allocation produced. */
export interface AllocationOutcome {
  readonly league_size: number;
  /** Players slotted league-wide per position (dedicated + flex). */
  readonly slotted: Readonly<Record<string, number>>;
  /** Flex seats league-wide per position. */
  readonly flex_split: Readonly<Record<string, number>>;
  /** Bench-effect extra starters league-wide per position (0 at cold start). */
  readonly extra: Readonly<Record<string, number>>;
  readonly depth: Readonly<Record<string, number>>;
  /** The 1-based rank the baseline is read at (slotted + extra + depth). */
  readonly baseline_rank: Readonly<Record<string, number>>;
  /** The baseline value (0 when the position's pool runs out before the baseline rank). */
  readonly baseline: Readonly<Record<string, number>>;
  /** The last slotted starter's value (null when the position has no seat). */
  readonly last_starter: Readonly<Record<string, number | null>>;
  /** Each position's entries, best first (ties by key). */
  readonly ranked: Readonly<Record<string, readonly AllocationEntry[]>>;
  /** Every flex seat in fill order and the position that filled it. */
  readonly trace: readonly { readonly slot: string; readonly position_filled: string }[];
  /** Positions whose pool ran out before their baseline rank (baseline 0, named in a warning). */
  readonly short: readonly string[];
}

const cmpKey = (a: number | string, b: number | string): number => {
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
};

/**
 * Allocates the league's starting seats from `entries` (research 05 §4.1): dedicated seats N × count
 * per position, then each flex type (narrowest first) seat by seat from the best remaining eligible
 * player (ties: the eligible position listed first). `bench_share[pos]` deepens a position's
 * effective starters (sib research 05 §2 bench effect: slotted × share extra starters).
 */
export function allocate(
  entries: readonly AllocationEntry[],
  plan: AllocationPlan,
  leagueSize: number,
  opts: {
    readonly depth?: Readonly<Record<string, number>>;
    readonly bench_share?: Readonly<Record<string, number>>;
  } = {},
): AllocationOutcome {
  ensure(
    Number.isInteger(leagueSize) &&
      leagueSize >= REPLACEMENT.minTeams &&
      leagueSize <= REPLACEMENT.maxTeams,
    "league size out of range",
    "league_size",
  );
  const positions = planPositions(plan);
  const ranked: Record<string, AllocationEntry[]> = {};
  for (const pos of positions) ranked[pos] = [];
  for (const e of entries) {
    if (!Number.isFinite(e.value)) continue;
    ranked[e.position]?.push(e);
  }
  for (const pos of positions)
    ranked[pos]?.sort((a, b) => b.value - a.value || cmpKey(a.key, b.key));
  const next: Record<string, number> = {};
  const slotted: Record<string, number> = {};
  const flexSplit: Record<string, number> = {};
  for (const pos of positions) {
    const fixed = (plan.fixed[pos] ?? 0) * leagueSize;
    next[pos] = fixed;
    slotted[pos] = fixed;
    flexSplit[pos] = 0;
  }
  const valueAt = (pos: string, i: number): number | null => ranked[pos]?.[i]?.value ?? null;
  const trace: { slot: string; position_filled: string }[] = [];
  for (const f of plan.flex) {
    for (let seat = 0; seat < f.count * leagueSize; seat++) {
      let best: string | null = null;
      let bestV = Number.NEGATIVE_INFINITY;
      for (const pos of f.positions) {
        const v = valueAt(pos, next[pos] ?? 0);
        if (v !== null && v > bestV) {
          bestV = v;
          best = pos;
        }
      }
      if (best === null) continue;
      next[best] = (next[best] ?? 0) + 1;
      slotted[best] = (slotted[best] ?? 0) + 1;
      flexSplit[best] = (flexSplit[best] ?? 0) + 1;
      trace.push({ slot: f.slot, position_filled: best });
    }
  }
  const depth = opts.depth ?? replacementDepth(plan, leagueSize);
  const extra: Record<string, number> = {};
  const baselineRank: Record<string, number> = {};
  const baseline: Record<string, number> = {};
  const last: Record<string, number | null> = {};
  const short: string[] = [];
  for (const pos of positions) {
    const share = opts.bench_share?.[pos] ?? 0;
    const s = slotted[pos] ?? 0;
    const ex = Number.isFinite(share) && share > 0 ? Math.round(s * share) : 0;
    extra[pos] = ex;
    const rank = s + ex + Math.max(1, Math.floor(depth[pos] ?? 1));
    baselineRank[pos] = rank;
    const v = valueAt(pos, rank - 1);
    if (v === null) short.push(pos);
    baseline[pos] = v ?? 0;
    last[pos] = s > 0 ? valueAt(pos, s - 1) : null;
  }
  return Object.freeze({
    league_size: leagueSize,
    slotted: Object.freeze(slotted),
    flex_split: Object.freeze(flexSplit),
    extra: Object.freeze(extra),
    depth: Object.freeze({ ...depth }),
    baseline_rank: Object.freeze(baselineRank),
    baseline: Object.freeze(baseline),
    last_starter: Object.freeze(last),
    ranked: Object.freeze(ranked),
    trace: Object.freeze(trace),
    short: Object.freeze(short),
  });
}

/**
 * Gap tiers over a descending value list (a Gaussian mixture is the sib method; gap breaks are the
 * recorded simplification): a new tier starts after a gap ≥ max(tierGapMin, tierGapFactor × the
 * median adjacent gap). Returns the 1-based tier of each index.
 */
export function gapTiers(values: readonly number[]): number[] {
  if (values.length === 0) return [];
  const gaps = values.slice(1).map((v, i) => (values[i] ?? v) - v);
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted.length === 0 ? 0 : (sorted[Math.floor((sorted.length - 1) / 2)] ?? 0);
  const threshold = Math.max(REPLACEMENT.tierGapMin, REPLACEMENT.tierGapFactor * median);
  const out = [1];
  let tier = 1;
  gaps.forEach((g) => {
    if (g >= threshold && tier < REPLACEMENT.maxTiers) tier += 1;
    out.push(tier);
  });
  return out;
}

/** E[max(X − b, 0)] for X ~ Normal(μ, σ) (σ = 0 → max(0, μ − b)). */
export function expectedExcess(mu: number, sigma: number, b: number): number {
  const d = mu - b;
  if (!(sigma > 0)) return Math.max(0, d);
  const z = d / sigma;
  return Math.max(0, d * normalCdf(z) + sigma * normalPdf(z));
}

// --- E4 ---------------------------------------------------------------------------------------------

/** One week of a player's horizon: the projected mean and whether his NFL team is on bye. */
export interface ReplacementWeek {
  readonly mean: number;
  readonly bye: boolean;
}

/** One player E4 ranks (every rostered player and the pool pages read). */
export interface ReplacementPlayer {
  readonly player_id: number;
  readonly name: BareText;
  /** ESPN display position. */
  readonly position: string;
  /** On some team's roster (ONTEAM) — false for FREEAGENT / WAIVERS (the stream baseline's pool). */
  readonly rostered: boolean;
  /** One entry per horizon week (null = no projection that week). */
  readonly weeks: readonly (ReplacementWeek | null)[];
  /** E1's ROS total over the same weeks (the VOR_ROS spread), or null. */
  readonly ros?: Dist | null;
  /** E1's first-week Dist (the per-game CV behind xVBD), or null. */
  readonly week_dist?: Dist | null;
}

/** An E4 request (validated by the tool's zod schema; re-checked here). */
export interface ReplacementRequest {
  readonly roster: RosterSlots;
  readonly league_size: number;
  /** The horizon weeks, first = the target week. */
  readonly weeks: readonly Week[];
  readonly horizon?: "week" | "ros";
  readonly baseline?: "starter" | "stream" | "both";
  readonly positions?: readonly string[];
  readonly players: readonly ReplacementPlayer[];
  /** Players always listed in `players[]` (the tool passes my roster). */
  readonly focus_player_ids?: readonly number[];
  /** Bench-effect share per position from the league's bye-week lineups (A5); omitted = cold start. */
  readonly bench_share?: Readonly<Record<string, number>>;
  readonly max_players?: number;
  readonly clock: Clock;
  readonly pacer?: Pacer;
  readonly deadline_ms?: number | null;
  readonly stamps?: readonly AnyStamp[];
  readonly inputs?: readonly InputFreshness[];
}

/** E4's outcome. */
export interface ReplacementOutcome {
  readonly data: ReplacementData;
  /** The ROS allocation (the kernel's full view, for E8/E9 and tests). */
  readonly allocation: AllocationOutcome;
  /** Per position: `pool` when the stream baseline came from available players, else the proxy. */
  readonly streamability_basis: Readonly<Record<string, "pool" | "allocation_proxy">>;
  /** What the numbers assume (E4's `rec` is null — a valuation table, not a decision). */
  readonly assumptions: readonly Assumption[];
  readonly partial: boolean;
  readonly warnings: readonly string[];
}

const A = (text: string, revisit_trigger: string): Assumption => ({ text, revisit_trigger });

const cvOf = (position: string): number =>
  Object.hasOwn(POSITION_CV, position) ? (POSITION_CV[position] ?? DEFAULT_CV) : DEFAULT_CV;

/** Per-game value over the non-bye weeks with a projection (null when none). */
function perGame(p: ReplacementPlayer, nWeeks: number): number | null {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < nWeeks; i++) {
    const w = p.weeks[i];
    if (w === null || w === undefined || w.bye || !Number.isFinite(w.mean)) continue;
    sum += w.mean;
    n += 1;
  }
  return n > 0 ? sum / n : null;
}

/** The best available (unrostered) player's value at each position in one week. */
function bestAvailable(
  players: readonly ReplacementPlayer[],
  positions: readonly string[],
  i: number,
): Record<string, { value: number; player_id: number } | null> {
  const out: Record<string, { value: number; player_id: number } | null> = {};
  for (const pos of positions) out[pos] = null;
  for (const p of players) {
    if (p.rostered || !(p.position in out)) continue;
    const w = p.weeks[i];
    if (w === null || w === undefined || w.bye || !Number.isFinite(w.mean)) continue;
    const cur = out[p.position] ?? null;
    if (cur === null || w.mean > cur.value || (w.mean === cur.value && p.player_id < cur.player_id))
      out[p.position] = { value: w.mean, player_id: p.player_id };
  }
  return out;
}

/**
 * The stream candidates (best available player per position and week) — E8's hole fillers, from
 * the same pool E4 reads. Weeks are indices into `weeks`.
 */
export function streamCandidates(
  players: readonly ReplacementPlayer[],
  weeks: readonly Week[],
  positions: readonly string[],
): {
  readonly position: string;
  readonly week: Week;
  readonly player_id: number;
  readonly points: number;
}[] {
  const out: { position: string; week: Week; player_id: number; points: number }[] = [];
  weeks.forEach((week, i) => {
    const best = bestAvailable(players, positions, i);
    for (const pos of positions) {
      const b = best[pos];
      if (b !== null && b !== undefined)
        out.push({ position: pos, week, player_id: b.player_id, points: round(b.value, 3) });
    }
  });
  return out;
}

/** Shifts every quantile of a Dist by `by` (a VOR Dist: points minus a deterministic baseline). */
function shiftDist(d: Dist, by: number): Dist {
  return {
    mean: round(d.mean + by),
    p10: round(d.p10 + by),
    p25: round(d.p25 + by),
    p50: round(d.p50 + by),
    p75: round(d.p75 + by),
    p90: round(d.p90 + by),
    p_zero: 0,
    basis: d.basis,
  };
}

/** E4. Throws AnalyticsError `invalid_request` on bounds. */
export async function analyzeReplacement(req: ReplacementRequest): Promise<ReplacementOutcome> {
  const N = req.league_size;
  ensure(
    Number.isInteger(N) && N >= REPLACEMENT.minTeams && N <= REPLACEMENT.maxTeams,
    "league size out of range",
    "league_size",
  );
  ensure(
    req.weeks.length >= 1 &&
      req.weeks.length <= REPLACEMENT.maxWeeks &&
      req.weeks.every((w) => Number.isInteger(w) && w >= 1 && w <= REPLACEMENT.maxWeeks),
    "weeks out of range",
    "weeks",
  );
  ensure(req.players.length <= REPLACEMENT.maxInputPlayers, "too many players", "players");
  for (const p of req.players)
    ensure(
      p.weeks.length === req.weeks.length,
      "a player's weeks differ from the horizon",
      "players",
    );
  const maxOut = req.max_players ?? REPLACEMENT.defaultPlayers;
  ensure(
    Number.isInteger(maxOut) && maxOut >= 1 && maxOut <= REPLACEMENT.maxPlayers,
    "max_players out of range",
    "max_players",
  );
  const horizon = req.horizon ?? "ros";
  const baselineMode = req.baseline ?? "both";
  const nWeeks = horizon === "week" ? 1 : req.weeks.length;
  const weeks = req.weeks.slice(0, nWeeks);
  const plan = allocationPlanOf(req.roster);
  const all = planPositions(plan);
  const positions =
    req.positions === undefined ? all : all.filter((p) => req.positions?.includes(p) === true);
  ensure(positions.length > 0, "no requested position is started in this league", "positions");
  const depth = replacementDepth(plan, N);
  const assumptions: Assumption[] = [];
  const warnings: string[] = [];

  // ROS: per-game values over the horizon's non-bye weeks (never season totals)
  const pg = new Map<number, number>();
  let unprojected = 0;
  for (const p of req.players) {
    const v = perGame(p, nWeeks);
    if (v === null) unprojected += 1;
    else pg.set(p.player_id, v);
  }
  const rosEntries: AllocationEntry[] = req.players.flatMap((p) => {
    const v = pg.get(p.player_id);
    return v === undefined ? [] : [{ key: p.player_id, position: p.position, value: v }];
  });
  const benchShare = req.bench_share;
  const ros = allocate(rosEntries, plan, N, {
    depth,
    ...(benchShare === undefined ? {} : { bench_share: benchShare }),
  });

  // weekly allocations and the stream baseline, cooperatively (one step per week)
  const weekly: { starter: Record<string, number>; last: Record<string, number | null> }[] = [];
  const stream: Record<string, { value: number; player_id: number } | null>[] = [];
  const pacer = req.pacer ?? loopPacer(req.clock);
  const run = await runCooperative(
    nWeeks,
    (i) => {
      const entries: AllocationEntry[] = [];
      for (const p of req.players) {
        const w = p.weeks[i];
        if (w === null || w === undefined || !Number.isFinite(w.mean)) continue;
        entries.push({ key: p.player_id, position: p.position, value: w.bye ? 0 : w.mean });
      }
      const a = allocate(entries, plan, N, {
        depth,
        ...(benchShare === undefined ? {} : { bench_share: benchShare }),
      });
      weekly.push({ starter: { ...a.baseline }, last: { ...a.last_starter } });
      stream.push(bestAvailable(req.players, positions, i));
    },
    { pacer, deadlineMs: req.deadline_ms },
  );
  const done = run.completed;
  if (run.partial)
    warnings.push(
      `partial: ${String(done)} of ${String(nWeeks)} weekly allocations before the CPU deadline`,
    );

  const anyPool = req.players.some((p) => !p.rostered);
  const basisOf: Record<string, "pool" | "allocation_proxy"> = {};
  const positionsOut: ReplacementData["positions"][number][] = [];
  const streamabilityOf: Record<string, number> = {};
  const tierOf = new Map<number, number>();
  for (const pos of positions) {
    const rankedPos = ros.ranked[pos] ?? [];
    const base = ros.baseline[pos] ?? 0;
    const rank = ros.baseline_rank[pos] ?? 1;
    const curveTo = Math.min(
      rankedPos.length,
      rank + REPLACEMENT.curvePastBaseline,
      REPLACEMENT.curveMaxRank,
    );
    const curve = rankedPos
      .slice(0, curveTo)
      .map((e, i) => ({ rank: i + 1, vor: round(e.value - base, 2) }));
    const tierSpan = rankedPos.slice(0, Math.min(rank, rankedPos.length));
    const tiersIdx = gapTiers(tierSpan.map((e) => e.value));
    const tierMap = new Map<number, number[]>();
    tierSpan.forEach((e, i) => {
      const t = tiersIdx[i] ?? 1;
      if (typeof e.key === "number") {
        tierOf.set(e.key, t);
        tierMap.set(t, [...(tierMap.get(t) ?? []), e.key]);
      }
    });
    // streamability: mean over weeks of best available / the league's last starter
    let sum = 0;
    let n = 0;
    let fromPool = false;
    const starterWeekly: { week: Week; points: number }[] = [];
    const streamWeekly: { week: Week; points: number }[] = [];
    for (let i = 0; i < done; i++) {
      const wk = weeks[i] ?? 0;
      const st = weekly[i]?.starter[pos] ?? 0;
      starterWeekly.push({ week: wk, points: round(st, 3) });
      const avail = stream[i]?.[pos] ?? null;
      if (avail !== null) streamWeekly.push({ week: wk, points: round(avail.value, 3) });
      const lastV = weekly[i]?.last[pos] ?? null;
      const s = avail !== null ? avail.value : st;
      if (avail !== null) fromPool = true;
      if (lastV !== null && lastV > 0) {
        sum += Math.max(0, s) / lastV;
        n += 1;
      }
    }
    basisOf[pos] = fromPool ? "pool" : "allocation_proxy";
    const streamability = round(Math.min(REPLACEMENT.streamabilityMax, n > 0 ? sum / n : 0), 3);
    streamabilityOf[pos] = streamability;
    const extra = ros.extra[pos] ?? 0;
    positionsOut.push({
      position: pos,
      starter_baseline_weekly: baselineMode === "stream" ? [] : starterWeekly,
      starter_baseline_ros: round(base, 3),
      stream_baseline_weekly: baselineMode === "starter" ? [] : streamWeekly,
      curve,
      tiers: [...tierMap.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([tier, ids]) => ({ tier, player_ids: ids })),
      streamability,
      effective_starters: (ros.slotted[pos] ?? 0) + extra,
      flex_allocation_trace: ros.trace.filter((t) => t.position_filled === pos),
    });
  }

  // players[]: the focus players, then the best available per position, then the best overall
  const byId = new Map(req.players.map((p) => [p.player_id, p]));
  const pick = new Set<number>();
  for (const id of req.focus_player_ids ?? []) {
    const p = byId.get(id);
    if (p !== undefined && positions.includes(p.position)) pick.add(id);
  }
  for (const pos of positions) {
    const avail = (ros.ranked[pos] ?? []).filter(
      (e) => typeof e.key === "number" && byId.get(e.key)?.rostered === false,
    );
    for (const e of avail.slice(0, REPLACEMENT.topAvailablePerPosition))
      if (typeof e.key === "number") pick.add(e.key);
  }
  const leaders = rosEntries
    .filter((e) => positions.includes(e.position))
    .map((e) => ({ e, vor: e.value - (ros.baseline[e.position] ?? 0) }))
    .sort((a, b) => b.vor - a.vor || cmpKey(a.e.key, b.e.key));
  for (const { e } of leaders) {
    if (pick.size >= maxOut) break;
    if (typeof e.key === "number") pick.add(e.key);
  }
  const players: ReplacementData["players"][number][] = [];
  for (const id of pick) {
    const p = byId.get(id);
    if (p === undefined) continue;
    const pos = p.position;
    const value = pg.get(id) ?? null;
    const base = ros.baseline[pos] ?? 0;
    let point = 0;
    let ss = 0;
    for (let i = 0; i < done; i++) {
      const w = p.weeks[i];
      const m = w === null || w === undefined ? (value ?? 0) : w.bye ? 0 : w.mean;
      point += m - (weekly[i]?.starter[pos] ?? 0);
      ss += m * m;
    }
    const rosDist = p.ros ?? null;
    const vorRos =
      rosDist !== null
        ? shiftDist(rosDist, point - rosDist.mean)
        : normalDist(point, cvOf(pos) * Math.sqrt(ss), "position_cv");
    const wd = p.week_dist ?? null;
    const cv = wd !== null && wd.mean > 0 ? sigmaOf(wd) / wd.mean : cvOf(pos);
    const v = value ?? 0;
    const w0 = p.weeks[0];
    const s0 = stream[0]?.[pos] ?? null;
    players.push({
      player_id: id,
      name: p.name,
      position: pos,
      vor_weekly:
        s0 === null || w0 === null || w0 === undefined || done === 0
          ? null
          : round((w0.bye ? 0 : w0.mean) - s0.value, 3),
      vor_ros: vorRos,
      xvbd: round(value === null ? 0 : expectedExcess(v, cv * v, base), 3),
      tier: tierOf.get(id) ?? null,
    });
  }
  players.sort(
    (a, b) =>
      positions.indexOf(a.position) - positions.indexOf(b.position) ||
      b.vor_ros.mean - a.vor_ros.mean ||
      a.player_id - b.player_id,
  );

  // assumptions and warnings (fixed vocabulary — counts and positions, never third-party text)
  const qbDepth = depth.QB;
  if (qbDepth !== undefined && positions.includes("QB"))
    assumptions.push(
      A(
        `QB replacement read ${String(qbDepth)} past the last starter (QB${String(ros.baseline_rank.QB ?? 0)}: the starters plus the backups a ${String(N)}-team league typically rosters — research 05 §3.1); other positions at the best unslotted player (research 05 §4.1)`,
        "the league's own rosters show a different backup count",
      ),
    );
  assumptions.push(
    benchShare === undefined
      ? A(
          "no bench effect: the baselines cold-start from the allocation (research 05 §4.1)",
          "the league's bye-week lineups (box scores) are read",
        )
      : A(
          "bench effect from the league's own bye-week lineups deepens the baselines",
          "a season's lineups change the share",
        ),
  );
  assumptions.push(
    A(
      horizon === "week"
        ? "values are this week's projections"
        : "values are per game over the horizon's non-bye weeks (never season totals)",
      "the projections change",
    ),
  );
  const proxied = positions.filter((p) => basisOf[p] === "allocation_proxy");
  if (proxied.length > 0)
    assumptions.push(
      A(
        anyPool
          ? `no available player read at ${proxied.join(", ")}: streamability there uses the best unslotted player (research 05 §4.1)`
          : "no free-agent pool in the input: streamability uses the best unslotted player (research 05 §4.1)",
        "a pool page for the position is read",
      ),
    );
  if (unprojected > 0)
    warnings.push(`${String(unprojected)} players without a projection in the horizon left out`);
  if (ros.short.some((p) => positions.includes(p)))
    warnings.push(
      `the pool runs out before the baseline at ${ros.short.filter((p) => positions.includes(p)).join(", ")}: baseline 0`,
    );

  const flexOf = (p: string): number => ros.flex_split[p] ?? 0;
  const lastQb = ros.last_starter.QB ?? null;
  const data: ReplacementData = {
    positions: positionsOut,
    players,
    format_notes: {
      flex_split: { rb: flexOf("RB"), wr: flexOf("WR"), te: flexOf("TE") },
      qb_last_starter_vs_replacement_ppg:
        positions.includes("QB") && lastQb !== null
          ? round(lastQb - (ros.baseline.QB ?? 0), 2)
          : null,
      streamable_positions: positions.filter(
        (p) => (streamabilityOf[p] ?? 0) >= REPLACEMENT.streamableMin,
      ),
    },
    rec: null,
    inputs: mergeInputs(collectInputs(req.stamps ?? [], req.clock), req.inputs ?? []),
  };
  return {
    data,
    allocation: ros,
    streamability_basis: Object.freeze(basisOf),
    assumptions,
    partial: run.partial,
    warnings,
  };
}
