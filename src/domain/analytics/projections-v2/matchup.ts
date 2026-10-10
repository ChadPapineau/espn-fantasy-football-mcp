// matchup.ts — the opponent adjustment, regressed (sibling research 05 §1 step 6; research 05 §8.2
// #11 and §8.3): aFPA, fantasy points a defence allowed to a position relative to what the same
// offences score in their other games (never raw points allowed), over the season's games before the
// target week; RELATIVE to the defence's all-position figure, because the market already prices the
// team total (step 1 — applying the absolute figure would count the matchup twice); then
// mult = 1 + β_pos × w(games) × (relative − 1), `w` rising from 0 to 1 by `matchup_full_games`
// (preseason and early-season DvP is near noise: YoY r 0.15–0.27). ESPN's own positional rating
// (mPositionalRatings, plan 07 D5) is carried beside it as a labelled comparator and never moves the
// number. Pure. New here.
import { MULT_BOUNDS } from "./constants.js";
import type { V2EspnRating, V2MatchupCell, V2MatchupTable, V2Params, V2Position } from "./types.js";

/** One player-game for the table: who scored how much against whom. */
export interface MatchupRow {
  readonly season: number;
  readonly week: number;
  /** The scoring offence. */
  readonly team: string;
  /** The defence faced. */
  readonly opponent: string | null;
  readonly position: V2Position;
  /** The player's points that game under the league's S. */
  readonly points: number;
}

const POSITIONS: readonly V2Position[] = ["QB", "RB", "WR", "TE"];

/**
 * The aFPA table of `season` from its games before `beforeWeek` (keys `${defence}|${position}`). An
 * offence-game counts only when the offence has ≥ 2 other games in the window to average.
 */
export function buildMatchupTable(
  rows: readonly MatchupRow[],
  season: number,
  beforeWeek: number,
): V2MatchupTable {
  // offence × week × position points, and each offence-week's defence
  const pts = new Map<string, number>();
  const defOf = new Map<string, string>();
  const weeksOf = new Map<string, Set<number>>();
  for (const r of rows) {
    if (r.season !== season || r.week >= beforeWeek || r.opponent === null) continue;
    if (!Number.isFinite(r.points)) continue;
    const k = `${r.team}|${String(r.week)}|${r.position}`;
    pts.set(k, (pts.get(k) ?? 0) + r.points);
    defOf.set(`${r.team}|${String(r.week)}`, r.opponent);
    const ws = weeksOf.get(r.team) ?? new Set<number>();
    ws.add(r.week);
    weeksOf.set(r.team, ws);
  }
  const allowed = new Map<string, { actual: number; expected: number; games: number }>();
  for (const [team, weeks] of weeksOf) {
    if (weeks.size < 3) continue;
    for (const pos of POSITIONS) {
      let total = 0;
      for (const w of weeks) total += pts.get(`${team}|${String(w)}|${pos}`) ?? 0;
      for (const w of weeks) {
        const def = defOf.get(`${team}|${String(w)}`);
        if (def === undefined) continue;
        const here = pts.get(`${team}|${String(w)}|${pos}`) ?? 0;
        const expected = (total - here) / (weeks.size - 1);
        for (const key of [`${def}|${pos}`, `${def}|ALL`]) {
          const a = allowed.get(key) ?? { actual: 0, expected: 0, games: 0 };
          a.actual += here;
          a.expected += expected;
          if (key.endsWith(pos)) a.games += 1;
          allowed.set(key, a);
        }
      }
    }
  }
  const out: Record<string, V2MatchupCell> = {};
  for (const [key, a] of allowed) {
    if (key.endsWith("|ALL") || a.expected <= 0) continue;
    const def = key.slice(0, key.lastIndexOf("|"));
    const all = allowed.get(`${def}|ALL`);
    const afpa = a.actual / a.expected;
    const allRatio = all !== undefined && all.expected > 0 ? all.actual / all.expected : 1;
    out[key] = Object.freeze({
      afpa: round4(afpa),
      relative: round4(allRatio > 0 ? afpa / allRatio : 1),
      games: a.games,
    });
  }
  return Object.freeze(out);
}

const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;

/** The regressed multiplier of a position against a defence (1 without a cell). */
export function matchupMult(
  table: V2MatchupTable | null | undefined,
  defence: string | null,
  position: V2Position,
  params: V2Params,
): { readonly mult: number; readonly cell: V2MatchupCell | null } {
  if (table === null || table === undefined || defence === null) return { mult: 1, cell: null };
  const cell = Object.hasOwn(table, `${defence}|${position}`)
    ? table[`${defence}|${position}`]
    : undefined;
  if (cell === undefined || !Number.isFinite(cell.relative)) return { mult: 1, cell: null };
  const full = Math.max(1, params.matchup_full_games);
  const w = Math.min(1, Math.max(0, cell.games) / full);
  const beta = Math.max(0, params.matchup_beta[position]);
  const [lo, hi] = MULT_BOUNDS.matchup;
  const m = 1 + beta * w * (cell.relative - 1);
  return { mult: Math.min(hi, Math.max(lo, m)), cell };
}

/** ESPN's rating for a defence × position, when the caller has it (a comparator only). */
export function espnRatingOf(
  ratings: Readonly<Record<string, V2EspnRating | null>> | undefined,
  defence: string | null,
  position: V2Position,
): V2EspnRating | null {
  if (ratings === undefined || defence === null) return null;
  const key = `${defence}|${position}`;
  return Object.hasOwn(ratings, key) ? (ratings[key] ?? null) : null;
}
