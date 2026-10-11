// v2-history.ts — what EFF_TOOLSET=full serves for a held-out week of `league-b` (plan 10 C2 on the
// shipped Phase 3 model; plan 07 E1 → "v2-opportunity"): the replay's v1 Dists (E1 with the Phase 2
// player_sim basis) overlaid, for every QB/RB/WR/TE v2 can model, by `projectV2`'s served first-week
// Dist — exactly the merge src/mcp/tools/analytics.ts `project` performs (runV2 → mergeV2). The
// request is assembled from the committed C1 excerpt (tests/domain/analytics/projections-v2/data:
// nflverse player-weeks with usage, ffopportunity expected TDs, team-weeks with the market line and
// venue, CC-BY / CC BY-SA, read through helpers/data.ts) the way src/mcp/tools/projection-v2.ts
// assembles it from the store:
//   - eligibility as runV2's: a modelled position, a GSIS id (the committed ESPN → GSIS crosswalk),
//     an NFL team (the week's team, ESPN pro-team id → nflverse abbreviation), not a bye;
//   - the player's games: this season's weeks before the target WITH the usage extras, the prior
//     season's weeks 1–18 WITHOUT them (the store reads them so — the stall bound), the per-location
//     TD counts never (the store's usage extras do not carry them), ffopportunity's xTD both seasons,
//     fumbles lost as one sum;
//   - team-games: this season before the target week and the prior season, red-zone plays only for
//     this season (they come from the current season's usage rows); the target week's market,
//     opponent and venue weather from its own schedule row — never its volume (no look-ahead);
//   - the regressed matchup table from the season's earlier weeks (none in week 1), the shipped
//     priors and parameters (DEFAULT_V2_PRIORS / DEFAULT_V2_PARAMS — fitted on 2023 only, so 2024 and
//     2025 stay held out), weight_espn = WEIGHT_ESPN_V2 (1.0, ADV OBJ-02);
//   - availability at GAME TIME (plan 07 D2's window: ESPN's status alone): ESPN's recorded weekly
//     projections on finished seasons are game-day values, exactly 0 for every inactive player
//     (docs/evals/phase3-projections.md "ESPN"), so a 0 reads as OUT and anything else as active —
//     the information the "start by ESPN's projection" baseline carries, so neither side knows more.
// Deterministic (seeded per season, week and chunk). Read-only; no name is read. New here.
import {
  DEFAULT_V2_PARAMS,
  DEFAULT_V2_PRIORS,
  WEIGHT_ESPN_V2,
  buildMatchupTable,
  isV2Position,
  projectV2,
  type MatchupRow,
  type V2Game,
  type V2Market,
  type V2MatchupTable,
  type V2Position,
  type V2TeamGame,
  type V2Weather,
} from "../../../../../src/domain/analytics/projections-v2/index.js";
import {
  matchupRows,
  type BacktestPlayer,
  type BacktestWorld,
} from "../../../../../src/domain/analytics/projections-v2/backtest.js";
import { teamGameKey } from "../../../../../src/domain/analytics/projections-v2/window.js";
import { teamOfProTeamId } from "../../../../../src/domain/crosswalk/teams.js";
import { fixedClock, seededRng } from "../../../../../src/domain/clock.js";
import type { BareText } from "../../../../../src/domain/league/types.js";
import type { Dist } from "../../../../../src/domain/scoring/types.js";
import { instantPacer } from "../../helpers.js";
import { buildWorld, leagueBSettings, loadTable } from "../../projections-v2/helpers/data.js";
import type { HistoryEntry, HistorySeason } from "./history.js";

/** projectV2's per-call target bound (LIMITS.maxTargets). */
const TARGETS_PER_CALL = 64;
/** The prior season's regular-season weeks the store reads (projection-v2.ts V2_PRIOR_WEEKS). */
const PRIOR_WEEKS = 18;

/**
 * Why a QB/RB/WR/TE entry was not served by v2: runV2's vocabulary (`no_gsis_id`, `no_nfl_team`,
 * `bye`) or projectV2's own skip reason (`no_history`, `no_team`, …).
 */
export type V2HistorySkip = string;

/** One week's v2 overlay: the served Dist per player id and the skip reasons. */
export interface V2WeekOverlay {
  readonly dists: ReadonlyMap<number, Dist>;
  readonly skipped: ReadonlyMap<number, V2HistorySkip>;
}

let worldMemo: BacktestWorld | null = null;
/** The league-b world (one S for both held-out seasons — tests/backtest/projections.test.ts holds it). */
export function leagueBWorld(): BacktestWorld {
  worldMemo ??= buildWorld("league-b", leagueBSettings(2025));
  return worldMemo;
}

let xwalkMemo: ReadonlyMap<number, string> | null = null;
/** ESPN player id → GSIS id (the committed crosswalk of league-b's box-score players). */
export function espnToGsis(): ReadonlyMap<number, string> {
  if (xwalkMemo === null) {
    const m = new Map<number, string>();
    for (const r of loadTable("espn_xwalk", null)) m.set(Number(r.espn_id), String(r.gsis_id));
    xwalkMemo = m;
  }
  return xwalkMemo;
}

/** Per-world memos (a world is built once and never mutated). */
interface WorldMemo {
  readonly games: Map<string, readonly V2Game[]>;
  players: ReadonlyMap<string, BacktestPlayer> | null;
  rows: MatchupRow[] | null;
  readonly tables: Map<string, V2MatchupTable | null>;
  readonly teamGames: Map<string, V2TeamGame[]>;
}
const memos = new WeakMap<BacktestWorld, WorldMemo>();
function memoOf(world: BacktestWorld): WorldMemo {
  let m = memos.get(world);
  if (m === undefined) {
    m = { games: new Map(), players: null, rows: null, tables: new Map(), teamGames: new Map() };
    memos.set(world, m);
  }
  return m;
}

/** A player's games as the store hands them to v2 for (season, week) (see the header). */
export function storeGames(
  world: BacktestWorld,
  gsis: string,
  season: number,
  week: number,
): V2Game[] {
  const memo = memoOf(world);
  memo.players ??= new Map(world.players.map((x) => [x.gsis_id, x]));
  const p = memo.players.get(gsis);
  if (p === undefined) return [];
  const out: V2Game[] = [];
  for (const g of p.games) {
    const current = g.season === season && g.week < week;
    const prior = g.season === season - 1 && g.week <= PRIOR_WEEKS;
    if (!current && !prior) continue;
    out.push({
      season: g.season,
      week: g.week,
      team: g.team,
      opponent: g.opponent,
      pass_att: g.pass_att,
      pass_cmp: g.pass_cmp,
      pass_yd: g.pass_yd,
      pass_td: g.pass_td,
      pass_int: g.pass_int,
      sacks: g.sacks,
      sack_fum_lost: 0,
      rush_att: g.rush_att,
      rush_yd: g.rush_yd,
      rush_td: g.rush_td,
      rush_fum_lost: g.sack_fum_lost + g.rush_fum_lost + g.rec_fum_lost,
      targets: g.targets,
      rec: g.rec,
      rec_yd: g.rec_yd,
      rec_td: g.rec_td,
      rec_fum_lost: 0,
      two_pt: g.two_pt,
      snap_pct: current ? g.snap_pct : null,
      rz_targets: current ? g.rz_targets : null,
      rz_carries: current ? g.rz_carries : null,
      gl_carries: current ? g.gl_carries : null,
      rz_rec_td: null,
      rz_rush_td: null,
      gl_rush_td: null,
      x_rec_td: g.x_rec_td,
      x_rush_td: g.x_rush_td,
      x_pass_td: g.x_pass_td,
    });
  }
  return out;
}

/** storeGames, memoised per world (the same player-week is asked for by several replays). */
export function memoGames(
  world: BacktestWorld,
  gsis: string,
  season: number,
  week: number,
): V2Game[] {
  const memo = memoOf(world);
  const key = `${gsis}|${String(season)}|${String(week)}`;
  let g = memo.games.get(key);
  if (g === undefined) {
    g = storeGames(world, gsis, season, week);
    memo.games.set(key, g);
  }
  return [...g];
}

/** storeTeamGames, memoised per world. */
export function memoTeamGames(world: BacktestWorld, season: number, week: number): V2TeamGame[] {
  const memo = memoOf(world);
  const key = `${String(season)}|${String(week)}`;
  let t = memo.teamGames.get(key);
  if (t === undefined) {
    t = storeTeamGames(world, season, week);
    memo.teamGames.set(key, t);
  }
  return t;
}

/** The team-games the store hands v2 for (season, week): no game of the target week or later. */
export function storeTeamGames(world: BacktestWorld, season: number, week: number): V2TeamGame[] {
  return world.team_games
    .filter(
      (t) =>
        (t.season === season && t.week < week) ||
        (t.season === season - 1 && t.week <= PRIOR_WEEKS),
    )
    .map((t) => (t.season === season ? t : { ...t, rz_plays: null }));
}

/** The season's regressed matchup table before `week` (null in week 1, as matchupTableFor). */
export function matchupFor(
  world: BacktestWorld,
  season: number,
  week: number,
): V2MatchupTable | null {
  if (week <= 1) return null;
  const memo = memoOf(world);
  const key = `${String(season)}|${String(week)}`;
  if (memo.tables.has(key)) return memo.tables.get(key) ?? null;
  memo.rows ??= matchupRows(world);
  const table = buildMatchupTable(memo.rows, season, week);
  memo.tables.set(key, table);
  return table;
}

/**
 * v2's served first-week Dists for one held-out week: every entry in `entries` v2 can model, with
 * `byes` the players whose v1 first week is a bye (E1's own flag). `n_sims` per player (projectV2
 * shares it down by its line budget, as in the product).
 */
export async function v2WeekOverlay(
  s: HistorySeason,
  week: number,
  entries: readonly HistoryEntry[],
  byes: ReadonlySet<number>,
  nSims: number,
): Promise<V2WeekOverlay> {
  const world = leagueBWorld();
  const xwalk = espnToGsis();
  const skipped = new Map<number, V2HistorySkip>();
  const eligible: { e: HistoryEntry; gsis: string; team: string }[] = [];
  for (const e of entries) {
    if (!isV2Position(e.position)) continue;
    const gsis = xwalk.get(e.player_id) ?? null;
    const team = teamOfProTeamId(e.pro_team_id);
    if (gsis === null) skipped.set(e.player_id, "no_gsis_id");
    else if (team === null) skipped.set(e.player_id, "no_nfl_team");
    else if (byes.has(e.player_id)) skipped.set(e.player_id, "bye");
    else eligible.push({ e, gsis, team });
  }
  const dists = new Map<number, Dist>();
  if (eligible.length === 0) return { dists, skipped };
  const teamGames = memoTeamGames(world, s.season, week);
  const markets: Record<string, V2Market> = {};
  const opponents: Record<string, string | null> = {};
  const weather: Record<string, V2Weather> = {};
  for (const { team } of eligible) {
    const key = teamGameKey(team, s.season, week);
    const tg = world.team_games.find(
      (t) => t.team === team && t.season === s.season && t.week === week,
    );
    if (tg !== undefined) {
      markets[team] = { implied: tg.implied, spread: tg.spread, total: tg.total };
      opponents[team] = tg.opponent;
    } else opponents[team] = null;
    const wx = world.weather.get(key);
    if (wx !== undefined) weather[team] = wx;
  }
  const matchup = matchupFor(world, s.season, week);
  for (let i = 0; i < eligible.length; i += TARGETS_PER_CALL) {
    const chunk = eligible.slice(i, i + TARGETS_PER_CALL);
    const out = await projectV2({
      targets: chunk.map(({ e, gsis, team }) => ({
        player_id: e.player_id,
        gsis_id: gsis,
        name: `Player ${String(e.player_id)}` as BareText,
        position: e.position as V2Position,
        position_id: e.position_id,
        team,
        games: memoGames(world, gsis, s.season, week),
        espn_mean: e.projected,
        availability: {
          designation: e.projected === 0 ? "OUT" : null,
          practice: null,
          game_day: true,
        },
      })),
      season: s.season,
      week,
      settings: s.settings,
      team_games: teamGames,
      markets,
      weather,
      opponents,
      matchup,
      priors: DEFAULT_V2_PRIORS,
      params: DEFAULT_V2_PARAMS,
      weight_espn: WEIGHT_ESPN_V2,
      n_sims: nSims,
      clock: fixedClock(Date.UTC(s.season, 8, 1)),
      rng: seededRng(s.season * 1000 + week * 10 + i / TARGETS_PER_CALL).fork("v2"),
      pacer: instantPacer,
      deadline_ms: null,
    });
    for (const d of out.details) {
      if (d.player_id === null) continue;
      if (d.dist !== null) dists.set(d.player_id, d.dist);
      else skipped.set(d.player_id, d.skipped ?? "not_modelled");
    }
  }
  return { dists, skipped };
}
