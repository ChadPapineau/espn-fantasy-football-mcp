// negatives-runner.ts — the C10 re-check over the STORE's history files (plan 10 §3.3 C10; plan 06
// §1.5 "Pre-season negatives re-check": "the store's three backtest seasons (the `<source>_history`
// files) re-scored"; the phase3-summary "Open" item: until now the re-check read the committed
// excerpts only). It builds `negativesReport`'s input from the store's read ports — every QB/RB/WR/TE
// player-week of each season through `PlayerWeekReader.lines` (a prior season reads its
// `<source>_history` file — src/store/datasets/readers.ts), each line scored by the plan 08 engine
// under the league's then-current settings and the two variants the checks need (5 → 4 pt pass TD,
// −2 → −1 INT, as the league scores them), the regular-season schedule through `NflGamesReader`,
// and the league's finished seasons as the caller read them from the platform (`leagueSeasonFrom`).
// The player universe is a port: `PlayerWeekReader` reads by id, so the caller names each season's
// players — `universeFromDepthCharts` is the store-backed one (the depth charts' history file, ESPN
// ids crossed to GSIS through the nflverse players file). What was read is counted, never silent
// (`NegativesRunCoverage`); a season the store does not hold is listed and left out. Pure: ports in,
// numbers out — no file is opened here and nothing is written. New here (Stage C).
import type { NflTeam } from "../../config/schema.js";
import type { AllocationPlan } from "../analytics/replacement.js";
import type {
  DepthChartReader,
  NflGamesReader,
  PlayerWeekLine,
  PlayerWeekReader,
} from "../analytics/types.js";
import type { NflPlayersReader } from "../crosswalk/types.js";
import type { LeagueRules, Standings, Week } from "../league/types.js";
import { score } from "../scoring/engine.js";
import type { Canonical, ScoringSettings } from "../scoring/types.js";
import {
  negativesReport,
  type NegGameSide,
  type NegLeagueSeason,
  type NegPlayerWeek,
  type NegPosition,
  type NegativeCheck,
  type NegativesInput,
} from "./negatives.js";

/** The regular-season fantasy weeks re-scored (ESPN's finalScoringPeriod 17 — research 05 §3.1). */
export const NEG_RUN_WEEKS: readonly Week[] = Object.freeze(
  Array.from({ length: 17 }, (_, i) => i + 1),
);
/** The last regular-season NFL week a schedule row may carry. */
export const NEG_RUN_LAST_REGULAR_WEEK = 18;
/** Ids per `PlayerWeekReader.lines` statement (a bounded statement; READER_LIST_MAX is far above). */
export const NEG_RUN_ID_CHUNK = 2_000;
/** Per-game baselines need this many games (research 05 §4.1: ≥ 8 — the C10 run's own). */
export const NEG_RUN_MIN_GAMES = 8;

/** The store ports the runner reads. */
export interface NegativesStorePorts {
  readonly playerWeeks: Pick<PlayerWeekReader, "lines">;
  readonly nflGames: Pick<NflGamesReader, "games">;
  /** A season's QB/RB/WR/TE players (GSIS ids), or null when the store holds no universe for it. */
  readonly universe: (season: number) => readonly string[] | null;
}

/** What the runner is asked to re-check. */
export interface NegativesRunOptions {
  /** The backtest seasons (the store's history seasons; plan 06 §1.5: three). */
  readonly seasons: readonly number[];
  /** The league's then-current scoring settings. */
  readonly settings: ScoringSettings;
  /** The league's allocation plan (its own roster settings) and size. */
  readonly plan: AllocationPlan;
  readonly league_size: number;
  readonly min_games?: number;
  /** The league's finished seasons (`leagueSeasonFrom` over the platform's previous seasons). */
  readonly league_seasons: readonly NegLeagueSeason[];
  readonly weeks?: readonly Week[];
}

/** One season's read, counted. */
export interface NegativesSeasonCoverage {
  readonly season: number;
  /** Players the universe named. */
  readonly universe: number;
  /** Player-weeks read and kept (a modelled position, a regular week, a line the engine scored). */
  readonly player_weeks: number;
  /** Players with ≥ 1 kept week. */
  readonly players: number;
  /** Rows skipped: not QB/RB/WR/TE, or a line the engine refused. */
  readonly skipped_position: number;
  readonly skipped_unscorable: number;
  /** Schedule sides read for the season (both sides of every regular-season game). */
  readonly schedule_sides: number;
  /** The stats file's version behind the season's rows (null: none read). */
  readonly file_version: string | null;
}

/** What one run read. */
export interface NegativesRunCoverage {
  readonly seasons: readonly NegativesSeasonCoverage[];
  /** Seasons asked for that the store does not hold (no universe, or no player-week read). */
  readonly missing_seasons: readonly number[];
  readonly league_seasons: number;
}

/** The league's settings with one rule's points replaced, overrides cleared (a scoring variant). */
export function withRulePoints(
  s: ScoringSettings,
  canonical: Canonical,
  points: number,
): ScoringSettings {
  return {
    ...s,
    rules: s.rules.map((r) => (r.canonical === canonical ? { ...r, points, overrides: {} } : r)),
  };
}

/** nflverse's position → the checks' position (FB plays RB, as E1 reads it); null when not modelled. */
export function negPositionOf(position: string): NegPosition | null {
  const p = position === "FB" ? "RB" : position;
  return p === "QB" || p === "RB" || p === "WR" || p === "TE" ? p : null;
}

/** One line under the three variants, or null when the engine refuses it. */
function variantPoints(
  l: PlayerWeekLine,
  variants: readonly [ScoringSettings, ScoringSettings, ScoringSettings],
): NegPlayerWeek["points"] | null {
  try {
    return {
      reference: score(l.line, variants[0]).points,
      pass_td_4: score(l.line, variants[1]).points,
      int_minus_1: score(l.line, variants[2]).points,
    };
  } catch {
    return null;
  }
}

/** Both sides of every regular-season game of `season`'s schedule. */
function scheduleOf(ports: NegativesStorePorts, season: number): NegGameSide[] {
  const weeks = Array.from({ length: NEG_RUN_LAST_REGULAR_WEEK }, (_, i) => i + 1);
  const out: NegGameSide[] = [];
  for (const g of ports.nflGames.games(season, weeks).rows) {
    if (g.season !== season || g.week < 1 || g.week > NEG_RUN_LAST_REGULAR_WEEK) continue;
    out.push({ season, week: g.week, team: g.home, opponent: g.away });
    out.push({ season, week: g.week, team: g.away, opponent: g.home });
  }
  return out;
}

/**
 * The C10 input from the store's ports (see the header), with what was read. Rows are read in id
 * chunks of `NEG_RUN_ID_CHUNK`; a duplicate (player, season, week) row is kept once.
 */
export function negativesInputFromStore(
  ports: NegativesStorePorts,
  opts: NegativesRunOptions,
): { readonly input: NegativesInput; readonly coverage: NegativesRunCoverage } {
  const ref = opts.settings;
  const variants = [
    ref,
    withRulePoints(ref, "pass_td", 4),
    withRulePoints(ref, "pass_int", -1),
  ] as const;
  const weeks = [...(opts.weeks ?? NEG_RUN_WEEKS)];
  const rows: NegPlayerWeek[] = [];
  const schedule: NegGameSide[] = [];
  const covered: NegativesSeasonCoverage[] = [];
  const missing: number[] = [];
  const held: number[] = [];
  for (const season of [...new Set(opts.seasons)].sort((a, b) => a - b)) {
    const ids = [...new Set(ports.universe(season) ?? [])].sort();
    let kept = 0;
    let skippedPos = 0;
    let skippedScore = 0;
    let version: string | null = null;
    const seen = new Set<string>();
    const players = new Set<string>();
    for (let i = 0; i < ids.length; i += NEG_RUN_ID_CHUNK) {
      const r = ports.playerWeeks.lines(ids.slice(i, i + NEG_RUN_ID_CHUNK), season, weeks, {
        usage: false,
      });
      version ??= r.stamp?.file_version ?? null;
      for (const l of r.rows) {
        if (l.season !== season || !weeks.includes(l.week)) continue;
        const key = `${l.gsis_id}|${String(l.week)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const position = negPositionOf(l.position);
        if (position === null) {
          skippedPos += 1;
          continue;
        }
        const points = variantPoints(l, variants);
        if (points === null) {
          skippedScore += 1;
          continue;
        }
        rows.push({
          player_id: l.gsis_id,
          position,
          team: l.nfl_team,
          season,
          week: l.week,
          points,
        });
        players.add(l.gsis_id);
        kept += 1;
      }
    }
    const sides = scheduleOf(ports, season);
    schedule.push(...sides);
    if (kept === 0) missing.push(season);
    else held.push(season);
    covered.push({
      season,
      universe: ids.length,
      player_weeks: kept,
      players: players.size,
      skipped_position: skippedPos,
      skipped_unscorable: skippedScore,
      schedule_sides: sides.length,
      file_version: version,
    });
  }
  return {
    input: {
      rows,
      seasons: held,
      plan: opts.plan,
      league_size: opts.league_size,
      min_games: opts.min_games ?? NEG_RUN_MIN_GAMES,
      schedule,
      league_seasons: opts.league_seasons,
    },
    coverage: {
      seasons: covered,
      missing_seasons: missing,
      league_seasons: opts.league_seasons.length,
    },
  };
}

/** The whole re-check over the store: the report (`negativesReport`) and what it read. */
export function runNegativesFromStore(
  ports: NegativesStorePorts,
  opts: NegativesRunOptions,
): { readonly report: NegativeCheck[]; readonly coverage: NegativesRunCoverage } {
  const { input, coverage } = negativesInputFromStore(ports, opts);
  return { report: negativesReport(input), coverage };
}

/**
 * One finished league-season from the platform's reads of it (`getStandings`, `getLeagueRules` on a
 * previous season): records, points for and seeds, the playoff size and the waiver mode. Null when
 * the season cannot carry the checks (no playoff size, a team without a seed, or an unknown waiver
 * mode) — the caller counts it out.
 */
export function leagueSeasonFrom(
  standings: Pick<Standings, "teams">,
  rules: Pick<LeagueRules, "playoffs" | "waiver">,
): NegLeagueSeason | null {
  const size = rules.playoffs.team_count;
  const reset = rules.waiver.order_reset;
  const faab = rules.waiver.uses_budget;
  if (size === null || !Number.isInteger(size) || size < 1 || reset === null || faab === null)
    return null;
  const teams: NegLeagueSeason["teams"][number][] = [];
  for (const t of standings.teams) {
    if (t.playoff_seed === null) return null;
    teams.push({
      wins: t.wins,
      losses: t.losses,
      ties: t.ties,
      points_for: t.points_for,
      playoff_seed: t.playoff_seed,
    });
  }
  return { playoff_team_count: size, waiver_order_reset: reset, uses_faab: faab, teams };
}

/** Depth-chart position labels (`pos_abb`, src/store/datasets/derive.ts DEPTH_LABELS) of a modelled player. */
const DEPTH_POSITIONS: ReadonlySet<string> = new Set(["QB", "RB", "HB", "FB", "WR", "TE"]);

/**
 * The store-backed universe of a season: every QB/RB/WR/TE (HB, FB) on any team's depth chart that
 * season (`DepthChartReader.chart` reads the season's `depth_charts_history` file for a prior
 * season), its GSIS id, or — for a row keyed by ESPN id alone (nflverse's 2025 depth charts) — the
 * GSIS id the nflverse players file pairs with it. Null when the store holds no depth chart for
 * the season.
 */
export function universeFromDepthCharts(
  depthCharts: Pick<DepthChartReader, "chart">,
  nflPlayers: Pick<NflPlayersReader, "byEspnIds">,
  teams: readonly NflTeam[],
  season: number,
): string[] | null {
  const chart = depthCharts.chart(season, teams);
  if (chart.stamp === null && chart.rows.length === 0) return null;
  const ids = new Set<string>();
  const espnOnly = new Set<number>();
  for (const r of chart.rows) {
    if (r.season !== season) continue;
    if (!DEPTH_POSITIONS.has(r.pos_abb.toUpperCase())) continue;
    if (r.gsis_id !== null && r.gsis_id !== "") ids.add(r.gsis_id);
    else if (r.espn_id !== null && Number.isSafeInteger(r.espn_id) && r.espn_id > 0)
      espnOnly.add(r.espn_id);
  }
  if (espnOnly.size > 0)
    for (const p of nflPlayers.byEspnIds([...espnOnly]).rows)
      if (p.gsis_id !== "") ids.add(p.gsis_id);
  return [...ids].sort();
}
