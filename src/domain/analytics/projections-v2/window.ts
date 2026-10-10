// window.ts — a player's weighted game window (sibling research 05 §1 step 2): the games before the
// target week, most recent first, exponentially weighted with half-life `h` games, an older season
// discounted per season back; a change-point rule re-bases the window — when the role metric (snap
// share where nflverse has it, else the opportunity share of the team's plays) moved by at least the
// threshold against the three games before and held for `hold_games` straight games, the games
// before the change keep only `pre_weight` of their weight (a soft re-base: a role change is
// evidence, not certainty). Pure. New here.
import type { V2Game, V2Params, V2TeamGame } from "./types.js";

/** One game of the window and its weight (≤ 1; the most recent game of the current season is 1). */
export interface WindowGame {
  readonly game: V2Game;
  readonly weight: number;
  /** The team-game of the player's team that week, when known. */
  readonly team: V2TeamGame | null;
}

/** A detected change point (sib §1 step 2). */
export interface ChangePoint {
  readonly season: number;
  readonly week: number;
  readonly metric: "snap_pct" | "opportunity_share";
  /** The jump against the baseline (signed). */
  readonly delta: number;
}

/** A player's window. */
export interface PlayerWindow {
  readonly games: readonly WindowGame[];
  readonly change_point: ChangePoint | null;
  /** Games since (and including) the change point; all window games when none. */
  readonly role_games: number;
}

/** Key of a team-game. */
export const teamGameKey = (team: string, season: number, week: number): string =>
  `${team}|${String(season)}|${String(week)}`;

/** Indexes team-games by `teamGameKey` (the last row of a duplicated key wins). */
export function indexTeamGames(rows: readonly V2TeamGame[]): ReadonlyMap<string, V2TeamGame> {
  const m = new Map<string, V2TeamGame>();
  for (const r of rows) m.set(teamGameKey(r.team, r.season, r.week), r);
  return m;
}

const fin = (x: number | null | undefined): x is number =>
  typeof x === "number" && Number.isFinite(x);

/** Whether a game is before the target (season, week). */
export function isBefore(g: { season: number; week: number }, season: number, week: number) {
  return g.season < season || (g.season === season && g.week < week);
}

/** The role metric of one game: snap share, else the opportunity share of the team's plays. */
function roleMetric(
  g: V2Game,
  team: V2TeamGame | null,
): { metric: ChangePoint["metric"]; value: number } | null {
  if (fin(g.snap_pct) && g.snap_pct >= 0 && g.snap_pct <= 1)
    return { metric: "snap_pct", value: g.snap_pct };
  const plays = (team?.dropbacks ?? 0) + (team?.rushes ?? 0);
  if (plays <= 0) return null;
  const opp = Math.max(0, g.pass_att + g.sacks + g.rush_att + g.targets);
  return { metric: "opportunity_share", value: Math.min(1, opp / plays) };
}

/**
 * The most recent change point among chronologically ordered games (oldest first), or null: game i
 * starts a change when it and the next `hold_games − 1` games all differ from the mean of the three
 * games before i by at least the threshold, on the same side. Only games of the same metric kind as
 * game i count toward the baseline.
 */
export function detectChangePoint(
  chrono: readonly WindowGame[],
  params: V2Params,
): { index: number; cp: ChangePoint } | null {
  const hold = Math.max(1, Math.round(params.change_point.hold_games));
  const metrics = chrono.map((w) => roleMetric(w.game, w.team));
  /** Whether game i starts a held change; its signed jump. */
  const qualifies = (i: number): number | null => {
    const m = metrics[i];
    if (m === null || m === undefined) return null;
    const base: number[] = [];
    for (let j = i - 1; j >= 0 && base.length < 3; j--) {
      const b = metrics[j];
      if (b?.metric === m.metric) base.push(b.value);
    }
    if (base.length < 3) return null;
    const mean = base.reduce((s, x) => s + x, 0) / base.length;
    const threshold =
      m.metric === "snap_pct" ? params.change_point.snap_delta : params.change_point.share_delta;
    const sign = Math.sign(m.value - mean);
    if (sign === 0) return null;
    for (let j = i; j < i + hold; j++) {
      const x = metrics[j];
      if (x?.metric !== m.metric) return null;
      const d = x.value - mean;
      if (Math.sign(d) !== sign || Math.abs(d) < threshold) return null;
    }
    return m.value - mean;
  };
  for (let i = chrono.length - hold; i >= 3; i--) {
    const d = qualifies(i);
    if (d === null) continue;
    // the regime started at the earliest game of a contiguous run of qualifying starts
    let start = i;
    let delta = d;
    for (let j = i - 1; j >= 3; j--) {
      const dj = qualifies(j);
      if (dj === null || Math.sign(dj) !== Math.sign(d)) break;
      start = j;
      delta = dj;
    }
    const g = chrono[start]?.game;
    const m = metrics[start];
    if (g === undefined || m === null || m === undefined) return null;
    return { index: start, cp: { season: g.season, week: g.week, metric: m.metric, delta } };
  }
  return null;
}

/**
 * The player's window for the target (season, week): games before it, most recent first, at most
 * `max_games`, weighted 0.5^(i/h) × prior_season_weight^(seasons back), with the change-point
 * re-base applied. Games with a non-finite count are dropped (never read as 0).
 */
export function playerWindow(
  games: readonly V2Game[],
  season: number,
  week: number,
  teamGames: ReadonlyMap<string, V2TeamGame>,
  params: V2Params,
): PlayerWindow {
  const usable = games
    .filter((g) => isBefore(g, season, week) && countsFinite(g))
    .sort((a, b) => b.season - a.season || b.week - a.week)
    .slice(0, Math.max(1, Math.round(params.max_games)));
  const h = Math.max(0.25, params.half_life_games);
  const base: WindowGame[] = usable.map((g, i) => ({
    game: g,
    weight:
      0.5 ** (i / h) * Math.max(0, params.prior_season_weight) ** Math.max(0, season - g.season),
    team: teamGames.get(teamGameKey(g.team, g.season, g.week)) ?? null,
  }));
  const chrono = [...base].reverse();
  const found = detectChangePoint(chrono, params);
  if (found === null) return { games: base, change_point: null, role_games: base.length };
  const cut = chrono.length - found.index; // games at or after the change, most recent first
  const pre = Math.max(0, Math.min(1, params.change_point.pre_weight));
  return {
    games: base.map((w, i) => (i < cut ? w : { ...w, weight: w.weight * pre })),
    change_point: found.cp,
    role_games: cut,
  };
}

const COUNT_KEYS = [
  "pass_att",
  "pass_cmp",
  "pass_yd",
  "pass_td",
  "pass_int",
  "sacks",
  "sack_fum_lost",
  "rush_att",
  "rush_yd",
  "rush_td",
  "rush_fum_lost",
  "targets",
  "rec",
  "rec_yd",
  "rec_td",
  "rec_fum_lost",
  "two_pt",
] as const;

/** Every count of a game is a finite number and the non-yardage counts are ≥ 0. */
export function countsFinite(g: V2Game): boolean {
  for (const k of COUNT_KEYS) {
    const v = g[k];
    if (!fin(v)) return false;
    if (!k.endsWith("_yd") && v < 0) return false;
  }
  return Number.isInteger(g.season) && Number.isInteger(g.week);
}

/** Σ weight × f(game) over the window, and Σ weight over the games where f is defined. */
export function weightedSum(
  win: readonly WindowGame[],
  f: (w: WindowGame) => number | null,
): { sum: number; weight: number; games: number } {
  let sum = 0;
  let weight = 0;
  let games = 0;
  for (const w of win) {
    const v = f(w);
    if (v === null || !Number.isFinite(v)) continue;
    sum += w.weight * v;
    weight += w.weight;
    games += 1;
  }
  return { sum, weight, games };
}
