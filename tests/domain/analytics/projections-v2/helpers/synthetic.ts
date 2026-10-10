// synthetic.ts — builders for the v2 unit tests: games, team-games, targets and a small synthetic
// backtest world. Synthetic data only (invented team codes "AAA", "BBB", ids "00-90000NN"); no
// recorded id, name or league value.
import type {
  BacktestPlayer,
  BacktestReport,
  BacktestWorld,
  ScoredGame,
} from "../../../../../src/domain/analytics/projections-v2/backtest.js";
import type {
  V2Game,
  V2Position,
  V2TeamGame,
  V2Target,
  V2Weather,
} from "../../../../../src/domain/analytics/projections-v2/types.js";
import { teamGameKey } from "../../../../../src/domain/analytics/projections-v2/window.js";
import type { BareText } from "../../../../../src/domain/league/types.js";
import type { ScoringSettings } from "../../../../../src/domain/scoring/types.js";
import { referenceSettings } from "../../helpers.js";

/** A zero game of a team in (season, week); override any count. */
export function game(over: Partial<V2Game> & { week: number }, season = 2025): V2Game {
  return {
    season,
    team: "AAA",
    opponent: "BBB",
    pass_att: 0,
    pass_cmp: 0,
    pass_yd: 0,
    pass_td: 0,
    pass_int: 0,
    sacks: 0,
    sack_fum_lost: 0,
    rush_att: 0,
    rush_yd: 0,
    rush_td: 0,
    rush_fum_lost: 0,
    targets: 0,
    rec: 0,
    rec_yd: 0,
    rec_td: 0,
    rec_fum_lost: 0,
    two_pt: 0,
    snap_pct: null,
    rz_targets: null,
    rz_carries: null,
    gl_carries: null,
    rz_rec_td: null,
    rz_rush_td: null,
    gl_rush_td: null,
    x_rec_td: null,
    x_rush_td: null,
    x_pass_td: null,
    ...over,
  };
}

/** A WR line: 8 targets, 5 catches for 65 yards, 0.4 xTD. */
export function wrGame(week: number, over: Partial<V2Game> = {}, season = 2025): V2Game {
  return game(
    { week, targets: 8, rec: 5, rec_yd: 65, rec_td: 0, x_rec_td: 0.4, snap_pct: 0.85, ...over },
    season,
  );
}

/** An RB line: 16 carries for 70, 3 targets, 2 catches for 15. */
export function rbGame(week: number, over: Partial<V2Game> = {}, season = 2025): V2Game {
  return game(
    {
      week,
      rush_att: 16,
      rush_yd: 70,
      targets: 3,
      rec: 2,
      rec_yd: 15,
      x_rush_td: 0.5,
      x_rec_td: 0.05,
      snap_pct: 0.65,
      ...over,
    },
    season,
  );
}

/** A QB line: 34 attempts, 22 completions, 250 yards, 2 sacks, 1.6 xTD. */
export function qbGame(week: number, over: Partial<V2Game> = {}, season = 2025): V2Game {
  return game(
    {
      week,
      pass_att: 34,
      pass_cmp: 22,
      pass_yd: 250,
      pass_td: 2,
      pass_int: 1,
      sacks: 2,
      rush_att: 3,
      rush_yd: 15,
      x_pass_td: 1.6,
      x_rush_td: 0.1,
      snap_pct: 1,
      ...over,
    },
    season,
  );
}

/** A team-game of "AAA" (or `team`) with a neutral line. */
export function teamGame(week: number, over: Partial<V2TeamGame> = {}, season = 2025): V2TeamGame {
  return {
    team: "AAA",
    season,
    week,
    opponent: "BBB",
    dropbacks: 38,
    rushes: 26,
    rz_plays: 12,
    implied: 22,
    spread: 0,
    total: 44,
    points_for: 22,
    ...over,
  };
}

/** Team-games of `team` for weeks 1..n of a season. */
export function teamSeason(n: number, team = "AAA", season = 2025): V2TeamGame[] {
  return Array.from({ length: n }, (_, i) => teamGame(i + 1, { team }, season));
}

/** A target from its games. */
export function target(
  position: V2Position,
  games: readonly V2Game[],
  over: Partial<V2Target> = {},
): V2Target {
  const pid = { QB: 1, RB: 2, WR: 3, TE: 4 }[position];
  return {
    player_id: 9000 + pid,
    gsis_id: `00-900000${String(pid)}`,
    name: `Player ${position}` as BareText,
    position,
    position_id: pid,
    team: "AAA",
    games,
    espn_mean: null,
    availability: { designation: null, practice: null },
    ...over,
  };
}

/** The reference S (half-PPR, 5-pt pass TD). */
export function settings(): ScoringSettings {
  return referenceSettings(5);
}

/**
 * A small synthetic backtest world: two teams, `weeks` weeks of 2024 and 2025, a QB, an RB, two WRs
 * and a TE per team whose volume is steady with a seeded wobble, each game scored under S by
 * `points` (the caller's scorer).
 */
export function syntheticWorld(
  points: (g: V2Game, pos: V2Position) => number,
  s: ScoringSettings,
  weeks = 8,
): BacktestWorld {
  const teams = ["AAA", "BBB"];
  const players: BacktestPlayer[] = [];
  const team_games: V2TeamGame[] = [];
  const weather = new Map<string, V2Weather>();
  const reports = new Map<string, BacktestReport>();
  let id = 10;
  for (const team of teams) {
    const opp = team === "AAA" ? "BBB" : "AAA";
    const roster: [V2Position, (w: number, o: Partial<V2Game>, season: number) => V2Game][] = [
      ["QB", qbGame],
      ["RB", rbGame],
      ["WR", wrGame],
      [
        "WR",
        (w, o, season) =>
          wrGame(w, { targets: 5, rec: 3, rec_yd: 35, x_rec_td: 0.2, ...o }, season),
      ],
      [
        "TE",
        (w, o, season) =>
          wrGame(w, { targets: 5, rec: 4, rec_yd: 40, x_rec_td: 0.3, ...o }, season),
      ],
    ];
    for (const [pos, make] of roster) {
      const gsis = `00-90000${String(id++)}`;
      const games: ScoredGame[] = [];
      for (const season of [2024, 2025])
        for (let w = 1; w <= weeks; w++) {
          const wobble = ((w * 7 + id * 3 + season) % 5) - 2;
          const g = make(w, { team, opponent: opp }, season);
          const tuned: V2Game = {
            ...g,
            team,
            opponent: opp,
            targets: Math.max(0, g.targets + wobble),
            rec: Math.max(0, Math.min(g.targets + wobble, g.rec + Math.sign(wobble))),
            rec_yd: Math.max(0, g.rec_yd + wobble * 9),
            rush_yd: Math.max(0, g.rush_yd + wobble * 6),
            rec_td: w % 3 === 0 && pos !== "QB" ? 1 : 0,
            rush_td: w % 4 === 0 && pos === "RB" ? 1 : 0,
          };
          games.push({ ...tuned, points: points(tuned, pos) });
        }
      players.push({ gsis_id: gsis, position: pos, games });
    }
    for (const season of [2024, 2025])
      for (let w = 1; w <= weeks; w++) {
        team_games.push(
          teamGame(
            w,
            {
              team,
              opponent: opp,
              spread: team === "AAA" ? 3 : -3,
              implied: team === "AAA" ? 24 : 21,
            },
            season,
          ),
        );
        weather.set(teamGameKey(team, season, w), {
          roof: "outdoors",
          temp_f: 50,
          wind_mph: 5,
          precip_prob: null,
        });
      }
  }
  // one Questionable report a week for the first RB
  const rb = players.find((p) => p.position === "RB");
  if (rb !== undefined)
    for (let w = 1; w <= weeks; w++)
      reports.set(`${rb.gsis_id}|2025|${String(w)}`, {
        designation: w % 2 === 0 ? "Questionable" : null,
        practice: "Limited Participation in Practice",
        team: "AAA",
      });
  return { players, team_games, weather, reports, settings: s };
}
