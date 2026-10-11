// v2-forecast.ts — plan 10 C5's replay with the Phase 3 opportunity forecast as the rule's `s`
// (docs/evals/phase3-waivers-seeding.md "Reading the replay": the A9a harness ranks targets by a
// trailing-4 points-per-game rate, which reacts to a role change a week or more after "most points
// last week" does; C5's comparison needs the `v2-opportunity` forecast in its place). For a
// candidate at claim week t: v2's expected points if active for that week — `expectV2` (EWM shares
// with change points, shrinkage per rate, location-based TDs, the market line, the regressed matchup,
// weather) scored by the engine (`activePoints`, the deterministic mean project.ts anchors on) — over
// the season's replacement level, held for weeks t..final with the shipped P(role holds) prior,
// exactly as the trailing forecast's rate is. The inputs are the committed C1 excerpt under the
// reference league's S (tests/domain/analytics/projections-v2/data, the same nflverse seasons as the
// replay), handed over the way the store hands them to E1 (calibration/helpers/v2-history.ts: no
// game of week t or later, the 2023-fitted priors and parameters). A bye in week t projects his
// next game (week t + 1 or t + 2: that week's market line and opponent) from the same as-of —
// still nothing of week t or later is read. A candidate the excerpt does not
// hold keeps the trailing forecast (counted). Deterministic, no sampling. New here.
import {
  DEFAULT_V2_PARAMS,
  DEFAULT_V2_PRIORS,
  V2_POSITION_IDS,
  activePoints,
  expectV2,
  indexTeamGames,
  teamGameKey,
  type V2Position,
  type V2TeamGame,
} from "../../../src/domain/analytics/projections-v2/index.js";
import type {
  BacktestPlayer,
  BacktestWorld,
} from "../../../src/domain/analytics/projections-v2/backtest.js";
import { roleHolds } from "../../../src/domain/analytics/waivers.js";
import {
  buildWorld,
  referenceLeagueSettings,
} from "../../domain/analytics/projections-v2/helpers/data.js";
import {
  matchupFor,
  memoGames,
  memoTeamGames,
} from "../../domain/analytics/calibration/helpers/v2-history.js";
import { REPLAY, forecastSurplus, type Season, type SurplusForecaster } from "./waivers.js";

/** Weeks past a bye v2 looks for the candidate's next game. */
const BYE_LOOKAHEAD = 2;

/** What the v2 forecaster did (the eval states it). */
export interface V2ForecastStats {
  /** Candidate-weeks forecast by v2. */
  v2: number;
  /** …that projected the next week because week t was a bye. */
  bye_next: number;
  /** Candidate-weeks the excerpt does not hold (or v2 could not model): the trailing forecast. */
  fallback: number;
}

let worldMemo: BacktestWorld | null = null;
/** The reference-league world of the C1 excerpt (2023–2025). */
export function referenceWorld(): BacktestWorld {
  worldMemo ??= buildWorld("reference", referenceLeagueSettings());
  return worldMemo;
}

const playersMemo = new WeakMap<BacktestWorld, ReadonlyMap<string, BacktestPlayer>>();

/** The player's NFL team going into week t: his week-t game's team, else his latest earlier game's. */
function teamAt(world: BacktestWorld, gsis: string, season: number, t: number): string | null {
  let byId = playersMemo.get(world);
  if (byId === undefined) {
    byId = new Map(world.players.map((x) => [x.gsis_id, x]));
    playersMemo.set(world, byId);
  }
  const p = byId.get(gsis);
  if (p === undefined) return null;
  const now = p.games.find((g) => g.season === season && g.week === t);
  if (now !== undefined) return now.team;
  const before = p.games
    .filter((g) => g.season < season || (g.season === season && g.week < t))
    .sort((a, b) => b.season - a.season || b.week - a.week)[0];
  return before?.team ?? null;
}

/**
 * v2's expected points if active for `gsis` in his game of week `target` (that week's market line,
 * opponent and venue), read as of claim week `asOf` ≤ `target`: no game of week `asOf` or later —
 * the player's, any team's, or the matchup table's — is read. Null when he has no game in `target`
 * (a bye) or v2 cannot model him (no history).
 */
export function v2ActivePoints(
  world: BacktestWorld,
  gsis: string,
  position: V2Position,
  team: string,
  season: number,
  asOf: number,
  target: number,
  index: ReadonlyMap<string, V2TeamGame>,
): number | null {
  const tg = index.get(teamGameKey(team, season, target));
  if (tg === undefined) return null;
  const teamGames = memoTeamGames(world, season, asOf);
  const out = expectV2(
    {
      position,
      position_id: V2_POSITION_IDS[position],
      team,
      games: memoGames(world, gsis, season, asOf),
    },
    {
      season,
      week: target,
      team_index: indexTeamGames(teamGames),
      team_games: teamGames,
      market: { implied: tg.implied, spread: tg.spread, total: tg.total },
      weather: world.weather.get(teamGameKey(team, season, target)) ?? null,
      opponent: tg.opponent,
      matchup: matchupFor(world, season, asOf),
      priors: DEFAULT_V2_PRIORS,
      params: DEFAULT_V2_PARAMS,
    },
  );
  return typeof out === "string" ? null : activePoints(out.expectation, world.settings);
}

/**
 * The v2 forecaster for the replay (a SurplusForecaster): the same shape as the harness's
 * `forecastSurplus` with v2's week-t expected points as the rate's numerator. `stats` counts what
 * it did. Memoised per (season, id, t).
 */
export function v2Forecaster(stats: V2ForecastStats): SurplusForecaster {
  const world = referenceWorld();
  const index = indexTeamGames(world.team_games);
  const memo = new Map<string, number>();
  return (s: Season, id: string, t: number): number => {
    const key = `${String(s.season)}|${id}|${String(t)}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const pos = s.position.get(id);
    let value: number | null = null;
    if (pos !== undefined) {
      const team = teamAt(world, id, s.season, t);
      if (team !== null)
        for (let w = t; w <= Math.min(REPLAY.finalWeek, t + BYE_LOOKAHEAD); w++) {
          // a bye in week t: the next game's projection, still read as of week t (games < t)
          const pts = v2ActivePoints(world, id, pos, team, s.season, t, w, index);
          if (pts === null) continue;
          const rate = Math.max(0, pts - s.replacement[pos]);
          let v = 0;
          for (let j = 0; j <= REPLAY.finalWeek - t; j++) v += roleHolds(pos, null, j) * rate;
          value = v;
          stats.v2 += 1;
          if (w > t) stats.bye_next += 1;
          break;
        }
    }
    if (value === null) {
      stats.fallback += 1;
      value = forecastSurplus(s, id, t);
    }
    memo.set(key, value);
    return value;
  };
}
