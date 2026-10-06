// waivers.ts — plan 10 A9a's soft part: the hindsight replay of research 05 §1.6 over the nflverse
// 2024–2025 excerpt, against the trending baseline (research 05 §8.4 #4: "replay weeks 2–14 with
// simulated rival demand; compare realised surplus per claim of the rule against 'claim the top
// trending player' and 'always claim the top hindsight player from your slot'"). The shipped pieces
// are used as shipped: the cold-start premium table (`solvePremiumTable`, N = 10), the strike
// (claim ⇔ s ≥ Π(k, W)), the demand curve and drift (`WAIVER_DP`), the P(role holds) prior
// (`roleHolds`) and the scoring engine under the reference league's settings. What nflverse cannot
// supply is replaced by the research's own definitions (each a recorded decision, see REPLAY).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WAIVER_DP } from "../../../src/domain/analytics/constants.js";
import { solvePremiumTable, type PremiumTable } from "../../../src/domain/analytics/waiverDp.js";
import { roleHolds } from "../../../src/domain/analytics/waivers.js";
import { seededRng, type Rng } from "../../../src/domain/clock.js";
import {
  normalizeSettings,
  score,
  statLineFromPlayerWeek,
  type ScoringSettings,
} from "../../../src/domain/scoring/index.js";
import {
  BACKTEST_FINAL_WEEK,
  BACKTEST_POSITIONS,
  ROOT,
  loadBacktestSeason,
  type BacktestPosition,
} from "./waiver-excerpt.js";

/** Per-game replacement levels, reference scoring, ≥ 8 GP (research 05 §4.1), by season. */
const REPLACEMENT: Readonly<Record<number, Readonly<Record<BacktestPosition, number>>>> =
  Object.freeze({
    2024: Object.freeze({ QB: 18.29, RB: 11.07, WR: 10.92, TE: 8.29 }),
    2025: Object.freeze({ QB: 19.55, RB: 10.08, WR: 10.18, TE: 9.12 }),
  });

/** The replay's definitions (research 05 §1.6, §4.1, §8.4 #4; the gaps filled are decisions). */
export const REPLAY = Object.freeze({
  /** League size (the reference league; the premium table's N). */
  teams: 10,
  /** The claim weeks research 05 §1.6 replayed. */
  claimWeeks: Object.freeze([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]),
  finalWeek: BACKTEST_FINAL_WEEK,
  /** "Available" = prior per-game rank below these (≈ rostered counts, 10 teams, 5 bench). */
  rostered: Object.freeze({ QB: 14, RB: 36, WR: 38, TE: 14 }),
  /** Per-game replacement levels by season (research 05 §4.1). */
  replacement: REPLACEMENT,
  /** The forecast at claim time: trailing points per game over the last ≤ 4 games played. */
  trailingGames: 4,
  /** The rule's ordered claim list per run (a failed claim is free; one success per run). */
  claimListMax: 5,
  /** Monte Carlo paths per starting position (every position 1..N is a start). */
  paths: 200,
  seed: 20_261_006,
});

/** Research 05 §1.6's hindsight ROS surplus of the best / 2nd / 5th available player (p25, p50, p75, max). */
export const RESEARCH_HINDSIGHT = Object.freeze({
  best: Object.freeze([54, 62, 86, 156]),
  second: Object.freeze([52, 57, 68, 103]),
  fifth: Object.freeze([39, 48, 60, 75]),
});

/** One season's per-player weekly points (reference scoring) and positions. */
export interface Season {
  readonly season: number;
  readonly position: ReadonlyMap<string, BacktestPosition>;
  /** player → week → points (a week without a row was not played: 0 points, not a game). */
  readonly points: ReadonlyMap<string, ReadonlyMap<number, number>>;
  readonly replacement: Readonly<Record<BacktestPosition, number>>;
}

/** The reference league's scoring (the Skills' fixture league `fx-10h`, hand-written to it). */
export function referenceSettings(): ScoringSettings {
  const body = JSON.parse(
    readFileSync(join(ROOT, "fixtures/espn/fx-10h/league/mSettings.json"), "utf8"),
  ) as { settings: { scoringSettings: unknown } };
  return normalizeSettings(body.settings.scoringSettings);
}

/** A row's points under `settings` (the shipped translator and engine). */
export function rowPoints(
  row: Readonly<Record<string, unknown>>,
  settings: ScoringSettings,
): number {
  return score(statLineFromPlayerWeek(row), settings).points;
}

/** Builds a season from per-player weekly points (positions by the player's most frequent group). */
export function seasonFromPoints(
  season: number,
  entries: readonly { id: string; pos: BacktestPosition; week: number; points: number }[],
  replacement: Readonly<Record<BacktestPosition, number>>,
): Season {
  const points = new Map<string, Map<number, number>>();
  const votes = new Map<string, Map<BacktestPosition, number>>();
  for (const e of entries) {
    const weeks = points.get(e.id) ?? new Map<number, number>();
    weeks.set(e.week, (weeks.get(e.week) ?? 0) + e.points);
    points.set(e.id, weeks);
    const v = votes.get(e.id) ?? new Map<BacktestPosition, number>();
    v.set(e.pos, (v.get(e.pos) ?? 0) + 1);
    votes.set(e.id, v);
  }
  const position = new Map<string, BacktestPosition>();
  for (const [id, v] of votes) {
    let best: BacktestPosition | null = null;
    for (const [pos, n] of v) if (best === null || n > (v.get(best) ?? 0)) best = pos;
    if (best !== null) position.set(id, best);
  }
  return { season, position, points, replacement };
}

/** A season from the committed excerpt, or null while it is not committed. */
export function loadSeason(season: number, settings: ScoringSettings): Season | null {
  const rows = loadBacktestSeason(season);
  const replacement = REPLAY.replacement[season];
  if (rows === null || replacement === undefined) return null;
  return seasonFromPoints(
    season,
    rows.map((r) => ({
      id: String(r.player_id),
      pos: r.position_group as BacktestPosition,
      week: Number(r.week),
      points: rowPoints(r, settings),
    })),
    replacement,
  );
}

const ptsOf = (s: Season, id: string, w: number): number | undefined => s.points.get(id)?.get(w);

/** The players rostered at claim week t: the top `rostered[pos]` by points per game over weeks < t. */
export function rosteredAt(s: Season, t: number): Set<string> {
  const out = new Set<string>();
  for (const pos of BACKTEST_POSITIONS) {
    const ranked: { id: string; ppg: number }[] = [];
    for (const [id, weeks] of s.points) {
      if (s.position.get(id) !== pos) continue;
      let sum = 0;
      let games = 0;
      for (const [w, p] of weeks)
        if (w < t) {
          sum += p;
          games++;
        }
      if (games > 0) ranked.push({ id, ppg: sum / games });
    }
    ranked.sort((a, b) => b.ppg - a.ppg || a.id.localeCompare(b.id));
    for (const r of ranked.slice(0, REPLAY.rostered[pos])) out.add(r.id);
  }
  return out;
}

/** Hindsight ROS surplus from week t: Σ_{w=t}^{final} max(0, pts_w − replacement) (research 05 §1.6). */
export function hindsightSurplus(s: Season, id: string, t: number): number {
  const pos = s.position.get(id);
  if (pos === undefined) return 0;
  let h = 0;
  for (let w = t; w <= REPLAY.finalWeek; w++)
    h += Math.max(0, (ptsOf(s, id, w) ?? 0) - s.replacement[pos]);
  return h;
}

/** Points per game over the last ≤ `REPLAY.trailingGames` games before week t, or null. */
export function trailingPpg(s: Season, id: string, t: number): number | null {
  const played: number[] = [];
  for (let w = t - 1; w >= 1 && played.length < REPLAY.trailingGames; w--) {
    const p = ptsOf(s, id, w);
    if (p !== undefined) played.push(p);
  }
  return played.length === 0 ? null : played.reduce((a, b) => a + b, 0) / played.length;
}

/**
 * The rule's surplus at claim time (E5's value with replacement as the opportunity cost): the
 * trailing rate over replacement, held for weeks t..final with the shipped P(role holds) prior
 * (healthy: nflverse carries no injury status); 0 without a game to forecast from.
 */
export function forecastSurplus(s: Season, id: string, t: number): number {
  const pos = s.position.get(id);
  const ppg = trailingPpg(s, id, t);
  if (pos === undefined || ppg === null) return 0;
  const rate = Math.max(0, ppg - s.replacement[pos]);
  let v = 0;
  for (let j = 0; j <= REPLAY.finalWeek - t; j++) v += roleHolds(pos, null, j) * rate;
  return v;
}

/** One available player at a claim week. */
export interface Candidate {
  readonly id: string;
  /** The forecast surplus `s` (what the rule sees). */
  readonly f: number;
  /** The hindsight ROS surplus (what a claim realises). */
  readonly h: number;
  /** Points last week (what "trending" chases). */
  readonly last: number;
}

/** The available players at week t (not rostered by the rank rule), every quantity precomputed. */
export function candidatesAt(s: Season, t: number): Candidate[] {
  const rostered = rosteredAt(s, t);
  const out: Candidate[] = [];
  for (const id of s.points.keys()) {
    if (rostered.has(id) || !s.position.has(id)) continue;
    out.push({
      id,
      f: forecastSurplus(s, id, t),
      h: hindsightSurplus(s, id, t),
      last: ptsOf(s, id, t - 1) ?? 0,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Linear-interpolated quantile (type 7) of a sorted list. */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? 0;
  return a + (b - a) * (i - lo);
}

/** The §1.6 hindsight table: per season-week, the best / 2nd / 5th available player's surplus. */
export function hindsightTable(
  seasons: readonly Season[],
): Record<"best" | "second" | "fifth", readonly number[]> & { readonly weeks: number } {
  const ranks = { best: [] as number[], second: [] as number[], fifth: [] as number[] };
  let weeks = 0;
  for (const s of seasons)
    for (const t of REPLAY.claimWeeks) {
      const hs = candidatesAt(s, t)
        .map((c) => c.h)
        .sort((a, b) => b - a);
      ranks.best.push(hs[0] ?? 0);
      ranks.second.push(hs[1] ?? 0);
      ranks.fifth.push(hs[4] ?? 0);
      weeks++;
    }
  const q4 = (xs: number[]) => {
    const sorted = [...xs].sort((a, b) => a - b);
    return [0.25, 0.5, 0.75, 1].map((q) => quantile(sorted, q));
  };
  return { best: q4(ranks.best), second: q4(ranks.second), fifth: q4(ranks.fifth), weeks };
}

/** The policies replayed. */
export const POLICIES = Object.freeze(["rule", "trending", "hindsight"] as const);
export type Policy = (typeof POLICIES)[number];

/** One claim attempt (for the tests' trace). */
export interface ClaimEvent {
  readonly week: number;
  readonly k: number;
  readonly W: number;
  readonly id: string;
  readonly f: number;
  readonly premium: number;
  readonly won: boolean;
}

/** One simulated season from one starting position. */
export interface PathResult {
  readonly claims: number;
  readonly successes: number;
  /** Σ of the realised (hindsight) surplus of the successful claims. */
  readonly surplus: number;
  readonly events: readonly ClaimEvent[];
  /** My position at the start of each claim week. */
  readonly positions: readonly number[];
}

/** The rivals' demand for a candidate (the DP's cold-start curve at the candidate's weekly rate). */
export function demand(f: number, W: number): number {
  return Math.min(WAIVER_DP.qCap, WAIVER_DP.q0 + (WAIVER_DP.q1 * f) / (W + 1));
}

/** A claim week's available players in each policy's order (sorted once; a path only skips). */
export interface Pool {
  /** Forecast surplus, best first (the rule's list). */
  readonly byForecast: readonly Candidate[];
  /** Points last week, best first (trending), ties by forecast then id. */
  readonly byLast: readonly Candidate[];
  /** Hindsight surplus, best first (the ceiling). */
  readonly byHindsight: readonly Candidate[];
}

/** The pool of claim week t. */
export function poolAt(s: Season, t: number): Pool {
  const c = candidatesAt(s, t);
  return {
    byForecast: [...c].sort((a, b) => b.f - a.f || a.id.localeCompare(b.id)),
    byLast: [...c].sort((a, b) => b.last - a.last || b.f - a.f || a.id.localeCompare(b.id)),
    byHindsight: [...c].sort((a, b) => b.h - a.h || a.id.localeCompare(b.id)),
  };
}

/** Every claim week's pool of one season. */
export function poolsFor(s: Season): Map<number, Pool> {
  return new Map(REPLAY.claimWeeks.map((t) => [t, poolAt(s, t)] as const));
}

/** The targets a policy submits this run, best first (each order is sorted descending). */
function targetsOf(
  policy: Policy,
  pool: Pool | undefined,
  premium: number,
  skip: (id: string) => boolean,
): Candidate[] {
  if (pool === undefined) return [];
  const order =
    policy === "rule" ? pool.byForecast : policy === "trending" ? pool.byLast : pool.byHindsight;
  const max = policy === "rule" ? REPLAY.claimListMax : 1;
  const out: Candidate[] = [];
  for (const c of order) {
    if (out.length >= max) break;
    const v = policy === "rule" ? c.f : policy === "trending" ? c.last : c.h;
    // the strike: never below the premium, never a zero forecast (the rest of the list is lower)
    if (v <= 0 || (policy === "rule" && c.f < premium)) break;
    if (!skip(c.id)) out.push(c);
  }
  return out;
}

/**
 * One season under one policy from waiver position `startK` (research 05 §1.2 mechanics): each run
 * the policy's targets are tried in order; a claim at position k wins when none of the k − 1 rivals
 * ahead claims the player (probability (1 − q)^(k−1)); a win realises the player's hindsight surplus
 * (the drop is replacement level) and sends me to N; a loss costs nothing but the player (a rival
 * has him); a week without a win moves me up by D ~ Binomial(k − 1, c) (rivals ahead who won).
 */
export function simulateSeason(
  policy: Policy,
  startK: number,
  rng: Rng,
  table: PremiumTable,
  pools: ReadonlyMap<number, Pool>,
): PathResult {
  const N = REPLAY.teams;
  let k = startK;
  let claims = 0;
  let successes = 0;
  let surplus = 0;
  const mine = new Set<string>();
  const gone = new Set<string>();
  const events: ClaimEvent[] = [];
  const positions: number[] = [];
  for (const t of REPLAY.claimWeeks) {
    positions.push(k);
    const W = REPLAY.finalWeek - t;
    const premium = table.premium(k, W);
    const targets = targetsOf(policy, pools.get(t), premium, (id) => mine.has(id) || gone.has(id));
    let won = false;
    for (const c of targets) {
      claims++;
      const win = rng.next() < (1 - demand(c.f, W)) ** (k - 1);
      events.push({ week: t, k, W, id: c.id, f: c.f, premium, won: win });
      if (win) {
        successes++;
        surplus += c.h;
        mine.add(c.id);
        won = true;
        break;
      }
      gone.add(c.id);
    }
    if (won) k = N;
    else {
      let d = 0;
      for (let i = 0; i < k - 1; i++) if (rng.next() < WAIVER_DP.drift) d++;
      k -= d;
    }
  }
  return { claims, successes, surplus, events, positions };
}

/** One policy's aggregate over every starting position and path of one season. */
export interface PolicyRow {
  readonly season: number;
  readonly policy: Policy;
  /** Mean claims submitted per season. */
  readonly claims: number;
  /** Mean successful claims per season. */
  readonly successes: number;
  /** Realised surplus per successful claim (Σ surplus / Σ successes). */
  readonly per_claim: number;
  /** Mean realised ROS surplus per season. */
  readonly per_season: number;
}

/** The whole replay: every season × policy over N starting positions × REPLAY.paths paths. */
export function replayWaivers(
  seasons: readonly Season[],
  paths: number = REPLAY.paths,
): PolicyRow[] {
  const table = solvePremiumTable({ teams: REPLAY.teams });
  const rows: PolicyRow[] = [];
  for (const s of seasons) {
    const pools = poolsFor(s);
    for (const policy of POLICIES) {
      let claims = 0;
      let successes = 0;
      let surplus = 0;
      let runs = 0;
      for (let startK = 1; startK <= REPLAY.teams; startK++)
        for (let p = 0; p < paths; p++) {
          const rng = seededRng(REPLAY.seed).fork(
            `${String(s.season)}/${String(startK)}/${String(p)}`,
          );
          const r = simulateSeason(policy, startK, rng, table, pools);
          claims += r.claims;
          successes += r.successes;
          surplus += r.surplus;
          runs++;
        }
      rows.push({
        season: s.season,
        policy,
        claims: claims / runs,
        successes: successes / runs,
        per_claim: successes === 0 ? 0 : surplus / successes,
        per_season: surplus / runs,
      });
    }
  }
  return rows;
}

const f1 = (x: number): string => x.toFixed(1);

/** The waivers section of docs/evals/1a-backtest.md (null seasons: the excerpt is not committed). */
export function waiversSection(seasons: readonly Season[] | null): string {
  if (seasons === null || seasons.length === 0)
    return [
      "**Not run yet: the 2024–2025 excerpt is not committed.** `fixtures/nflverse/backtest/` (written by",
      "`tests/backtest/helpers/make-waiver-excerpt.ts` from `stats_player_week_2024.parquet` and",
      "`stats_player_week_2025.parquet`) does not exist: downloading a release file is a grounding step",
      "that no test and no build agent performs. The harness is tested on a constructed season and on the",
      "committed 2026 excerpt (`tests/backtest/waivers.test.ts`); the moment the excerpt lands this",
      "section no longer matches the run, and the test fails until it is regenerated with the numbers.",
    ].join("\n");
  const ht = hindsightTable(seasons);
  const lines = [
    `Hindsight ROS surplus of the best available player per season-week (${String(ht.weeks)} season-weeks; research 05 §1.6's numbers beside):`,
    "",
    "| available player | p25 | p50 | p75 | max | research p25 / p50 / p75 / max |",
    "|---|---:|---:|---:|---:|---|",
  ];
  for (const [label, key] of [
    ["best", "best"],
    ["2nd-best", "second"],
    ["5th-best", "fifth"],
  ] as const)
    lines.push(
      `| ${label} | ${ht[key].map(f1).join(" | ")} | ${RESEARCH_HINDSIGHT[key].join(" / ")} |`,
    );
  const rows = replayWaivers(seasons);
  lines.push(
    "",
    `Policies (${String(REPLAY.teams)} starting positions × ${String(REPLAY.paths)} paths per season):`,
    "",
    "| season | policy | claims / season | successful / season | surplus per successful claim | surplus / season |",
    "|---:|---|---:|---:|---:|---:|",
  );
  for (const r of rows)
    lines.push(
      `| ${String(r.season)} | ${r.policy} | ${f1(r.claims)} | ${f1(r.successes)} | ${f1(r.per_claim)} | ${f1(r.per_season)} |`,
    );
  const verdict = seasons.map((s) => {
    const rule = rows.find((r) => r.season === s.season && r.policy === "rule");
    const trend = rows.find((r) => r.season === s.season && r.policy === "trending");
    const ratio =
      rule !== undefined && trend !== undefined && trend.per_claim > 0
        ? rule.per_claim / trend.per_claim
        : null;
    return `${String(s.season)}: ${ratio === null ? "—" : `${f1((ratio - 1) * 100)} %`}`;
  });
  lines.push(
    "",
    `Rule vs trending, surplus per successful claim (research 05 §8.4 "good": ≥ +10 % in both seasons): ${verdict.join("; ")}.`,
  );
  return lines.join("\n");
}
