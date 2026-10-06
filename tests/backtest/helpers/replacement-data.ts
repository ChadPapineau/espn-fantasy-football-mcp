// replacement-data.ts — the data behind plan 10 B7's hard regression: research 05 §4.1's table
// (2025 and 2024 baselines, tops, VOR curves and the flex split, per game, ≥ 8 GP) and §3.1/§3.2's
// season-total cross-check, transcribed; the committed nflverse excerpt (tests/backtest/data/
// stats_player_week, re-hashed on every read by loadBacktestSeason); and the per-player season
// aggregates, scored through the shipped translator and engine under the reference league's own
// settings (fx-10h `mSettings` — research 05 §0's format). Nothing is fetched.
import { join } from "node:path";
import type { AllocationEntry } from "../../../src/domain/analytics/replacement.js";
import type { ScoringSettings } from "../../../src/domain/scoring/index.js";
import {
  BACKTEST_POSITIONS,
  ROOT,
  loadBacktestSeason,
  type BacktestPosition,
} from "./waiver-excerpt.js";
import { rowPoints } from "./waivers.js";

/** Where the B7 excerpt and its manifest live (this suite's own data; see its README.md). */
export const REPLACEMENT_DATA_DIR = join(ROOT, "tests/backtest/data/stats_player_week");

/** Research 05 §4.1's per-game filter: at least this many games. */
export const MIN_GAMES = 8;

/** One season's row of research 05 §4.1's table (per game, ≥ 8 GP, reference scoring). */
export interface ResearchSeason {
  readonly baseline: Readonly<Record<BacktestPosition, number>>;
  readonly top: Readonly<Record<BacktestPosition, number>>;
  /** QB10, the last starter (the table's parenthesis). */
  readonly qb_last_starter: number;
  /** VOR at the listed ranks (QB: 1/3/5/10; RB, WR: 1/3/5/10/15/20; TE: 1/3/5/10). */
  readonly vor: Readonly<Record<BacktestPosition, readonly (readonly [number, number])[]>>;
  /** The flex fill (research 05 §4.1 "Flex fill"). */
  readonly flex: { readonly RB: number; readonly WR: number; readonly TE: number };
  /** The season-totals variant: flex fill and RB / WR / TE baselines (research 05 §4.1 note). */
  readonly totals: {
    readonly flex: { readonly RB: number; readonly WR: number; readonly TE: number };
    readonly baseline: { readonly RB: number; readonly WR: number; readonly TE: number };
    /** QB1, QB10, QB12 season totals at 5 pt (research 05 §3.2). */
    readonly qb: { readonly qb1: number; readonly qb10: number; readonly qb12: number };
  };
}

const vor = (ranks: readonly number[], values: readonly number[]): [number, number][] =>
  ranks.map((r, i) => [r, values[i] ?? Number.NaN]);

/** Research 05 §4.1 and §3.2, transcribed. */
export const RESEARCH_05_TABLE: Readonly<Record<2024 | 2025, ResearchSeason>> = Object.freeze({
  2025: {
    baseline: { QB: 19.55, RB: 10.08, WR: 10.18, TE: 9.12 },
    top: { QB: 24.35, RB: 22.31, WR: 19.3, TE: 15.18 },
    qb_last_starter: 19.96,
    vor: {
      QB: vor([1, 3, 5, 10], [4.8, 3.3, 2.4, 0.4]),
      RB: vor([1, 3, 5, 10, 15, 20], [12.2, 10.3, 8.0, 4.4, 3.3, 2.1]),
      WR: vor([1, 3, 5, 10, 15, 20], [9.1, 5.3, 5.2, 3.4, 1.2, 0.3]),
      TE: vor([1, 3, 5, 10], [6.1, 3.5, 1.2, 0.0]),
    },
    flex: { RB: 7, WR: 3, TE: 0 },
    totals: {
      flex: { RB: 6, WR: 4, TE: 0 },
      baseline: { RB: 132.9, WR: 149.1, TE: 127.6 },
      qb: { qb1: 389.6, qb10: 312.9, qb12: 283.7 },
    },
  },
  2024: {
    baseline: { QB: 18.29, RB: 11.07, WR: 10.92, TE: 8.29 },
    top: { QB: 27.9, RB: 21.17, WR: 19.93, TE: 13.85 },
    qb_last_starter: 19.26,
    vor: {
      QB: vor([1, 3, 5, 10], [9.6, 6.8, 5.2, 1.0]),
      RB: vor([1, 3, 5, 10, 15, 20], [10.1, 7.3, 5.8, 4.9, 3.3, 1.8]),
      WR: vor([1, 3, 5, 10, 15, 20], [9.0, 5.3, 4.3, 3.3, 1.8, 1.3]),
      TE: vor([1, 3, 5, 10], [5.6, 3.2, 2.3, 0.1]),
    },
    flex: { RB: 4, WR: 6, TE: 0 },
    totals: {
      flex: { RB: 3, WR: 7, TE: 0 },
      baseline: { RB: 162.9, WR: 161.2, TE: 116.5 },
      qb: { qb1: 446.4, qb10: 308.2, qb12: 286.4 },
    },
  },
});

/** One player's season under the reference scoring. */
export interface PlayerSeason {
  readonly id: string;
  readonly position: BacktestPosition;
  readonly games: number;
  readonly points: number;
}

/**
 * Every QB/RB/WR/TE player-season of the committed excerpt, scored row by row (a game = one weekly
 * row; the position is the player's most frequent `position_group`, ties to the first seen). Null
 * while the season is not committed.
 */
export function playerSeasons(season: number, settings: ScoringSettings): PlayerSeason[] | null {
  const rows = loadBacktestSeason(season, REPLACEMENT_DATA_DIR);
  if (rows === null) return null;
  const acc = new Map<
    string,
    { votes: Map<BacktestPosition, number>; games: number; points: number }
  >();
  for (const r of rows) {
    const id = String(r.player_id);
    const pos = r.position_group as BacktestPosition;
    if (!(BACKTEST_POSITIONS as readonly string[]).includes(pos)) continue;
    const e = acc.get(id) ?? { votes: new Map<BacktestPosition, number>(), games: 0, points: 0 };
    e.votes.set(pos, (e.votes.get(pos) ?? 0) + 1);
    e.games += 1;
    e.points += rowPoints(r, settings);
    acc.set(id, e);
  }
  const out: PlayerSeason[] = [];
  for (const [id, e] of acc) {
    let best: BacktestPosition | null = null;
    for (const [pos, n] of e.votes) if (best === null || n > (e.votes.get(best) ?? 0)) best = pos;
    if (best !== null) out.push({ id, position: best, games: e.games, points: e.points });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The allocation entries of a season: per game (≥ MIN_GAMES) or season totals (every player). */
export function entriesOf(
  seasons: readonly PlayerSeason[],
  basis: "per_game" | "season_total",
): AllocationEntry[] {
  return seasons
    .filter((p) => basis === "season_total" || p.games >= MIN_GAMES)
    .map((p) => ({
      key: p.id,
      position: p.position,
      value: basis === "per_game" ? p.points / p.games : p.points,
    }));
}
