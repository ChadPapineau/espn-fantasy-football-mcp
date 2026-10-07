// readers.ts — the domain's read-only dataset ports over the per-source read-only connections (plan
// 01 §5.2/§5.5; plan 07 §2 stamps), running EXACTLY the SQL of READER_QUERIES (tables.ts) with
// JSON-array list parameters (`json_each`, so no caller value is spliced into SQL) and applying each
// entry's `mapping`. A method that needs two files runs two statements and joins in code. A dataset
// whose file is not loaded answers `{ rows: [], stamp: null }` — the contract's "never loaded" outcome,
// never an exception. A prior season's statement runs on the source's history file (PHASE_1_HISTORY_
// TWINS: stats, injuries) when the current file does not hold it; the Phase-2 ports (depth charts, EP,
// news, trending) and the usage extras `lines()` gains from the snap-count and pbp files are
// readers-p2.ts. Ported from sibling @cf3b015, adapted (separate connections; ESPN pro schedule and
// players).
import { isNflTeam, type NflTeam, type WeatherSource } from "../../config/schema.js";
import type {
  DatasetReaders,
  DatasetResult,
  DatasetStamp,
  GameLines,
  InjuryReport,
  NflGame,
  PlayerWeekLine,
  TeamDefenseWeekLine,
  WeatherObservation,
} from "../../domain/analytics/types.js";
import type {
  EspnPlayerIdentity,
  NflPlayerRecord,
  NflPlayersReader,
  NflRosterPlayer,
  PlayerUniverseReader,
  RosterWeeklyReader,
} from "../../domain/crosswalk/types.js";
import {
  bareUntrusted,
  wrapUntrustedOrNull,
  type IsoInstant,
  type ProGame,
  type ProTeam,
  type Week,
} from "../../domain/league/types.js";
import type { DatasetConnection, DatasetConnections } from "./connections.js";
import { epochMsToIso, impliedPoints } from "./derive.js";
import {
  espnPositionForNflverse,
  statLineFromPlayerWeek,
  statLineFromTeamDefense,
  type PointsAllowedInput,
} from "../../domain/scoring/index.js";
import type { StatLine } from "../../domain/scoring/types.js";
import { PHASE_1_HISTORY_TWINS, READER_QUERIES, type ReaderMethod } from "./tables.js";
import { createPhase2Readers, seasonsOf, usageKeyOf, type UsageKey } from "./readers-p2.js";
import type { DatasetSourceId } from "../../config/freshness.js";

/** Most ids / weeks / teams one reader call accepts (a bounded statement). */
export const READER_LIST_MAX = 100_000;
/** The seasons and weeks a reader accepts (nflverse reaches back to 1999; POST weeks run to 22). */
export const READER_SEASON_MIN = 1990;
export const READER_SEASON_MAX = 2100;
export const READER_WEEK_MAX = 22;

/** A row as SQLite returns it. */
export type SqlRow = Readonly<Record<string, unknown>>;

/** Alias of the crosswalk's NflPlayerRecord (src/domain/crosswalk/types.ts). */
export type NflPlayerRow = NflPlayerRecord;
/** Alias of the crosswalk's NflPlayersReader (src/domain/crosswalk/types.ts). */
export type NflPlayersPort = NflPlayersReader;

/** A finite number from a SQLite value, else null. */
export function sqlNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  return null;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const team = (v: unknown): NflTeam | null => (typeof v === "string" && isNflTeam(v) ? v : null);
const intOrNull = (v: unknown): number | null => {
  const n = sqlNum(v);
  return n !== null && Number.isInteger(n) ? n : null;
};

function season(v: unknown): number {
  if (
    typeof v !== "number" ||
    !Number.isInteger(v) ||
    v < READER_SEASON_MIN ||
    v > READER_SEASON_MAX
  )
    throw new RangeError(
      `store: season must be an integer in ${String(READER_SEASON_MIN)}..${String(READER_SEASON_MAX)}`,
    );
  return v;
}
function week(v: unknown): Week {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > READER_WEEK_MAX)
    throw new RangeError(`store: week must be an integer in 1..${String(READER_WEEK_MAX)}`);
  return v;
}
function bounded(v: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(v) || v.length > READER_LIST_MAX)
    throw new RangeError(`store: ${what} must be an array of at most ${String(READER_LIST_MAX)}`);
  return v;
}
function weekList(v: readonly Week[]): string {
  return JSON.stringify([...new Set(bounded(v, "weeks").map(week))]);
}
function stringList(v: readonly string[], what: string): string {
  const xs = bounded(v, what);
  for (const s of xs)
    if (typeof s !== "string") throw new RangeError(`store: ${what} must hold strings`);
  return JSON.stringify([...new Set(xs as string[])]);
}
/** Positive safe integers only (others never match an id); deduplicated. */
function idList(v: readonly number[], what: string): number[] {
  return [...new Set(bounded(v, what).filter((n): n is number => Number.isSafeInteger(n)))];
}

/** Options the readers are built from. */
export interface ReadersOptions {
  readonly connections: DatasetConnections;
  readonly weatherFirst: WeatherSource;
  readonly warn: (code: string) => void;
}

/** The readers a store serves. */
export interface StoreReaders {
  readonly datasets: DatasetReaders;
  readonly rosterWeekly: RosterWeeklyReader;
  readonly playerUniverse: PlayerUniverseReader;
  readonly nflPlayers: NflPlayersReader;
}

const NEVER_LOADED = Object.freeze({
  rows: Object.freeze([]),
  stamp: null,
}) as DatasetResult<never>;

export function createReaders(o: ReadersOptions): StoreReaders {
  const { connections, warn } = o;

  /**
   * The connection to read `source` from for `season`: the current file when it holds the season (or
   * no season / no history file applies), else the history file when IT holds it, else whichever is
   * loaded (a loaded file without the season answers no rows, stamped); null when neither is.
   */
  function connFor(
    source: DatasetSourceId,
    history: DatasetSourceId | null,
    s: number | null,
  ): DatasetConnection | null {
    const cur = connections.use(source);
    if (s === null || history === null) return cur;
    if (cur !== null && seasonsOf(cur).includes(s)) return cur;
    const h = connections.use(history);
    if (h !== null && seasonsOf(h).includes(s)) return h;
    return cur ?? h;
  }

  /** Runs statement `i` of a reader method on its source's connection; null when not loaded. */
  function run(
    method: ReaderMethod,
    i: number,
    params: Record<string, string | number | null>,
  ): { rows: SqlRow[]; conn: DatasetConnection } | null {
    const st = READER_QUERIES[method].statements[i];
    if (st === undefined) throw new Error(`store: ${method} has no statement ${String(i)}`);
    const twin = (PHASE_1_HISTORY_TWINS as Partial<Record<string, DatasetSourceId>>)[st.source];
    const conn = connFor(
      st.source,
      twin ?? null,
      typeof params.season === "number" ? params.season : null,
    );
    if (conn === null) return null;
    const rows = conn.db.prepare(st.sql).all(params) as unknown as SqlRow[];
    return { rows, conn };
  }

  const stampOf = (c: DatasetConnection): DatasetStamp => connections.stamp(c);
  const phase2 = createPhase2Readers({ connFor, stampOf, warn });

  // --- espn:pro_schedule ------------------------------------------------------------------------

  const proSchedule: DatasetReaders["proSchedule"] = {
    games(s, weeks): DatasetResult<ProGame> {
      const res = run("ProScheduleReader.games", 0, {
        season: season(s),
        weeks: weeks === null ? null : weekList(weeks),
      });
      if (res === null) return NEVER_LOADED;
      const rows: ProGame[] = [];
      for (const r of res.rows) {
        const id = intOrNull(r.espn_game_id);
        const home = intOrNull(r.home_pro_team_id);
        const away = intOrNull(r.away_pro_team_id);
        if (id === null || home === null || away === null) {
          warn("dataset_row_skipped");
          continue;
        }
        rows.push({
          espn_game_id: id,
          season: intOrNull(r.season) ?? s,
          week: intOrNull(r.week) ?? 0,
          kickoff: epochMsToIso(r.date_ms),
          start_time_tbd: r.start_time_tbd === 1,
          valid_for_locking: r.valid_for_locking === 1,
          stats_official: r.stats_official === 1,
          home_pro_team_id: home,
          away_pro_team_id: away,
        });
      }
      return { rows, stamp: stampOf(res.conn) };
    },
    teams(s): DatasetResult<ProTeam> {
      const res = run("ProScheduleReader.teams", 0, { season: season(s) });
      if (res === null) return NEVER_LOADED;
      const rows: ProTeam[] = [];
      for (const r of res.rows) {
        const id = intOrNull(r.pro_team_id);
        const abbrev = str(r.abbrev);
        if (id === null || abbrev === null) {
          warn("dataset_row_skipped");
          continue;
        }
        rows.push({ id, abbrev, bye_week: intOrNull(r.bye_week) });
      }
      return { rows, stamp: stampOf(res.conn) };
    },
  };

  // --- nflverse:schedules -----------------------------------------------------------------------

  function mapGame(r: SqlRow, asOf: IsoInstant): NflGame | null {
    const away = team(r.away_team);
    const home = team(r.home_team);
    const gameId = str(r.game_id);
    if (away === null || home === null || gameId === null) {
      warn("dataset_row_skipped_team");
      return null;
    }
    const spread = sqlNum(r.spread_line);
    const total = sqlNum(r.total_line);
    const mlAway = sqlNum(r.away_moneyline);
    const mlHome = sqlNum(r.home_moneyline);
    const lines: GameLines | null =
      spread === null && total === null && mlAway === null && mlHome === null
        ? null
        : {
            spread_line: spread,
            total_line: total,
            implied: impliedPoints(spread, total),
            moneyline: { away: mlAway, home: mlHome },
            as_of: asOf,
          };
    const as = sqlNum(r.away_score);
    const hs = sqlNum(r.home_score);
    const final = as !== null && hs !== null;
    const div = sqlNum(r.div_game);
    return {
      game_id: gameId,
      espn_game_id: intOrNull(r.espn_game_id),
      season: intOrNull(r.season) ?? 0,
      week: intOrNull(r.week) ?? 0,
      kickoff: str(r.kickoff_utc),
      away,
      home,
      roof: str(r.roof) ?? str(r.venue_roof_default),
      surface: str(r.surface),
      stadium: wrapUntrustedOrNull(str(r.stadium), "nflverse.schedules.stadium"),
      divisional: div === null ? null : div === 1,
      rest_days: { away: intOrNull(r.away_rest), home: intOrNull(r.home_rest) },
      lines,
      is_final: final,
      score: final ? { away: as, home: hs } : null,
    };
  }

  function games(res: { rows: SqlRow[]; conn: DatasetConnection }): DatasetResult<NflGame> {
    const stamp = stampOf(res.conn);
    const rows = res.rows
      .map((r) => mapGame(r, stamp.as_of))
      .filter((g): g is NflGame => g !== null);
    return { rows, stamp };
  }

  const nflGames: DatasetReaders["nflGames"] = {
    games(s, weeks) {
      const res = run("NflGamesReader.games", 0, { season: season(s), weeks: weekList(weeks) });
      return res === null ? NEVER_LOADED : games(res);
    },
    byEspnGameId(ids) {
      const res = run("NflGamesReader.byEspnGameId", 0, {
        espn_game_ids: JSON.stringify(idList(ids, "espnGameIds").filter((n) => n > 0)),
      });
      return res === null ? NEVER_LOADED : games(res);
    },
  };

  // --- nflverse:injuries ------------------------------------------------------------------------

  const injuries: DatasetReaders["injuries"] = {
    reports(s, w, gsisIds): DatasetResult<InjuryReport> {
      const res = run("InjuryReader.reports", 0, {
        season: season(s),
        week: week(w),
        gsis_ids: gsisIds === null ? null : stringList(gsisIds, "gsisIds"),
      });
      if (res === null) return NEVER_LOADED;
      const stamp = stampOf(res.conn);
      const rows: InjuryReport[] = [];
      for (const r of res.rows) {
        const t = team(r.team);
        const gsis = str(r.gsis_id);
        if (t === null || gsis === null) {
          warn("dataset_row_skipped_team");
          continue;
        }
        const reportStatus = str(r.report_status);
        const practice = str(r.practice_status);
        rows.push({
          gsis_id: gsis,
          season: intOrNull(r.season) ?? s,
          week: intOrNull(r.week) ?? w,
          nfl_team: t,
          report_status: reportStatus === null ? null : bareUntrusted(reportStatus, "dataset_text"),
          practice:
            practice === null
              ? []
              : [{ day: "week", status: bareUntrusted(practice, "dataset_text") }],
          primary_injury: wrapUntrustedOrNull(
            str(r.report_primary_injury) ?? str(r.practice_primary_injury),
            "nflverse.injuries.primary_injury",
          ),
          secondary_injury: wrapUntrustedOrNull(
            str(r.report_secondary_injury) ?? str(r.practice_secondary_injury),
            "nflverse.injuries.secondary_injury",
          ),
          as_of: stamp.as_of,
        });
      }
      return { rows, stamp };
    },
  };

  // --- nflverse:stats_player_week ---------------------------------------------------------------

  /** `toStatLine(nflverse)` of src/domain/scoring for a player row; null (warned) when untranslatable. */
  function playerLine(r: SqlRow): StatLine | null {
    const position =
      espnPositionForNflverse(r.position) ?? espnPositionForNflverse(r.position_group);
    if (position === null) {
      warn("dataset_row_skipped_position");
      return null;
    }
    try {
      return statLineFromPlayerWeek(r, { position });
    } catch {
      warn("dataset_row_invalid");
      return null;
    }
  }

  const playerWeeks: DatasetReaders["playerWeeks"] = {
    lines(gsisIds, s, weeks): DatasetResult<PlayerWeekLine> {
      const res = run("PlayerWeekReader.lines", 0, {
        season: season(s),
        weeks: weekList(weeks),
        gsis_ids: stringList(gsisIds, "gsisIds"),
      });
      if (res === null) return NEVER_LOADED;
      // the snap-count and pbp extras of these player-weeks (readers-p2.ts; null fields when the
      // snap-count / pbp files are not loaded)
      const keys: UsageKey[] = [];
      for (const r of res.rows) {
        const t = team(r.team);
        const gsis = str(r.player_id);
        const w = intOrNull(r.week);
        if (t !== null && gsis !== null && w !== null)
          keys.push({ gsis_id: gsis, week: w, nfl_team: t });
      }
      const extras = phase2.usageExtras(keys, season(s));
      const rows: PlayerWeekLine[] = [];
      for (const r of res.rows) {
        const t = team(r.team);
        const gsis = str(r.player_id);
        if (t === null || gsis === null) {
          warn("dataset_row_skipped_team");
          continue;
        }
        const line = playerLine(r);
        if (line === null) continue;
        const targets = sqlNum(r.targets);
        const air = sqlNum(r.receiving_air_yards);
        const x = extras.get(usageKeyOf(gsis, intOrNull(r.week) ?? 0));
        rows.push({
          gsis_id: gsis,
          season: intOrNull(r.season) ?? s,
          week: intOrNull(r.week) ?? 0,
          nfl_team: t,
          opponent: team(r.opponent_team),
          position: str(r.position) ?? "",
          line,
          usage: {
            snaps: x?.snaps ?? null,
            snap_pct: x?.snap_pct ?? null,
            routes_proxy: x?.routes_proxy ?? null,
            targets,
            target_share: sqlNum(r.target_share),
            air_yards: air,
            air_yards_share: sqlNum(r.air_yards_share),
            adot: air !== null && targets !== null && targets > 0 ? air / targets : null,
            wopr: sqlNum(r.wopr),
            racr: sqlNum(r.racr),
            carries: sqlNum(r.carries),
            carry_share: x?.carry_share ?? null,
            rz_targets: x?.rz_targets ?? null,
            rz_carries: x?.rz_carries ?? null,
            gl_carries: x?.gl_carries ?? null,
            rz_team: x?.rz_team ?? null,
            xfp_ep: null,
          },
        });
      }
      return { rows, stamp: stampOf(res.conn) };
    },

    /**
     * Statement 1 for the requested teams, statement 1 again for their opponents (the defence TDs
     * and safeties the opponent scored, which points allowed nets out — plan 08 §3.2 U-6, settled
     * by the scoring module), statement 2 for the final scores (the schedules file; absent → no
     * dst_pa_raw). Joined in code; the translator is src/domain/scoring's.
     */
    defenseLines(teams, s, weeks): DatasetResult<TeamDefenseWeekLine> {
      const sn = season(s);
      const weekParam = weekList(weeks);
      const res = run("PlayerWeekReader.defenseLines", 0, {
        season: sn,
        weeks: weekParam,
        teams: stringList(teams, "teams"),
      });
      if (res === null) return NEVER_LOADED;
      const key = (week: unknown, t: unknown): string => `${String(week)}|${String(t)}`;
      const byTeamWeek = new Map<string, SqlRow>();
      for (const r of res.rows) byTeamWeek.set(key(r.week, r.team), r);
      const opponents = [
        ...new Set(
          res.rows
            .map((r) => str(r.opponent_team))
            .filter((o): o is string => o !== null && !res.rows.some((x) => x.team === o)),
        ),
      ];
      if (opponents.length > 0) {
        const opp = run("PlayerWeekReader.defenseLines", 0, {
          season: sn,
          weeks: weekParam,
          teams: JSON.stringify(opponents),
        });
        for (const r of opp?.rows ?? []) byTeamWeek.set(key(r.week, r.team), r);
      }
      const gameIds = [
        ...new Set(res.rows.map((r) => str(r.game_id)).filter((g): g is string => g !== null)),
      ];
      const scores = new Map<string, SqlRow>();
      if (gameIds.length > 0) {
        const g = run("PlayerWeekReader.defenseLines", 1, {
          season: sn,
          game_ids: JSON.stringify(gameIds),
        });
        for (const r of g?.rows ?? []) {
          const id = str(r.game_id);
          if (id !== null) scores.set(id, r);
        }
      }
      const rows: TeamDefenseWeekLine[] = [];
      for (const r of res.rows) {
        const t = team(r.team);
        if (t === null) {
          warn("dataset_row_skipped_team");
          continue;
        }
        const game = scores.get(str(r.game_id) ?? "");
        let pa: PointsAllowedInput | null = null;
        if (game !== undefined) {
          const as = sqlNum(game.away_score);
          const hs = sqlNum(game.home_score);
          const oppScore = game.home_team === t ? as : game.away_team === t ? hs : null;
          if (as !== null && hs !== null && oppScore !== null) {
            const o = byTeamWeek.get(key(r.week, r.opponent_team));
            pa = {
              score: oppScore,
              opponent_int_tds: sqlNum(o?.def_tds) ?? 0,
              opponent_fumble_tds: sqlNum(o?.fumble_recovery_tds_opp) ?? 0,
              opponent_safeties: sqlNum(o?.def_safeties) ?? 0,
            };
          }
        }
        let line: StatLine;
        try {
          line = statLineFromTeamDefense(r, { pointsAllowed: pa });
        } catch {
          warn("dataset_row_invalid");
          continue;
        }
        rows.push({
          nfl_team: t,
          season: intOrNull(r.season) ?? sn,
          week: intOrNull(r.week) ?? 0,
          opponent: team(r.opponent_team),
          line,
        });
      }
      return { rows, stamp: stampOf(res.conn) };
    },
  };

  // --- weather ------------------------------------------------------------------------------------

  const weather: DatasetReaders["weather"] = {
    forGames(gameIds): DatasetResult<WeatherObservation> {
      const want = JSON.parse(stringList(gameIds, "gameIds")) as string[];
      const order: readonly ["weather:open_meteo" | "weather:nws", number][] =
        o.weatherFirst === "nws"
          ? [
              ["weather:nws", 1],
              ["weather:open_meteo", 0],
            ]
          : [
              ["weather:open_meteo", 0],
              ["weather:nws", 1],
            ];
      const found = new Map<string, WeatherObservation>();
      let stamp: DatasetStamp | null = null;
      let firstLoaded: DatasetConnection | null = null;
      for (const [source, idx] of order) {
        const missing = want.filter((g) => !found.has(g));
        if (missing.length === 0 && want.length > 0) break;
        const res = run("WeatherReader.forGames", idx, { game_ids: JSON.stringify(missing) });
        if (res === null) continue;
        firstLoaded ??= res.conn;
        let contributed = false;
        for (const r of res.rows) {
          const id = str(r.game_id);
          const asOf = str(r.as_of);
          if (id === null || asOf === null || found.has(id)) continue;
          found.set(id, {
            game_id: id,
            temp_f: sqlNum(r.temp_f),
            wind_mph: sqlNum(r.wind_mph),
            gust_mph: sqlNum(r.gust_mph),
            precip_prob: sqlNum(r.precip_prob),
            as_of: asOf,
            source,
          });
          contributed = true;
        }
        if (contributed && stamp === null) stamp = stampOf(res.conn);
      }
      if (stamp === null && firstLoaded !== null) stamp = stampOf(firstLoaded);
      const rows = [...found.values()].sort((a, b) => (a.game_id < b.game_id ? -1 : 1));
      return { rows, stamp };
    },
  };

  // --- nflverse:roster_weekly (the crosswalk) -------------------------------------------------------

  function mapRoster(r: SqlRow): NflRosterPlayer | null {
    const t = team(r.team);
    const gsis = str(r.gsis_id);
    if (t === null || gsis === null) {
      warn("dataset_row_skipped_team");
      return null;
    }
    return {
      gsis_id: gsis,
      season: intOrNull(r.season) ?? 0,
      week: intOrNull(r.week) ?? 0,
      full_name: str(r.full_name) ?? "",
      team: t,
      position: str(r.position) ?? "",
      jersey_number: intOrNull(r.jersey_number),
      espn_id: intOrNull(r.espn_id),
      sleeper_id: str(r.sleeper_id),
      status: str(r.status),
    };
  }

  const rosterWeekly: RosterWeeklyReader = {
    latest(s): DatasetResult<NflRosterPlayer> {
      const res = run("RosterWeeklyReader.latest", 0, { season: season(s) });
      if (res === null) return NEVER_LOADED;
      const rows = res.rows.map(mapRoster).filter((p): p is NflRosterPlayer => p !== null);
      return { rows, stamp: stampOf(res.conn) };
    },
    byEspnId(espnId): DatasetResult<NflRosterPlayer> {
      if (!Number.isSafeInteger(espnId) || espnId <= 0) {
        // A non-positive or non-integer id never reaches SQL (mapping note).
        const conn = connections.use("nflverse:roster_weekly");
        return { rows: [], stamp: conn === null ? null : stampOf(conn) };
      }
      const res = run("RosterWeeklyReader.byEspnId", 0, { espn_id: espnId });
      if (res === null) return NEVER_LOADED;
      const rows = res.rows.map(mapRoster).filter((p): p is NflRosterPlayer => p !== null);
      return { rows, stamp: stampOf(res.conn) };
    },
  };

  // --- espn:players (+ pro-team abbreviations from espn:pro_schedule) ------------------------------

  function mapPlayers(
    rows: readonly SqlRow[],
    abbrevOf: (season: number, proTeamId: number) => string | null,
  ): EspnPlayerIdentity[] {
    const out: EspnPlayerIdentity[] = [];
    for (const r of rows) {
      const id = intOrNull(r.espn_id);
      const name = str(r.full_name);
      const pos = intOrNull(r.position_id);
      const pro = intOrNull(r.pro_team_id);
      const s = intOrNull(r.season);
      if (id === null || name === null || pos === null || pro === null || s === null) {
        warn("dataset_row_skipped");
        continue;
      }
      out.push({
        espn_id: id,
        full_name: name,
        position_id: pos,
        pro_team_id: pro,
        pro_team: pro === 0 ? null : abbrevOf(s, pro),
        percent_owned: sqlNum(r.percent_owned),
        jersey: null,
      });
    }
    return out;
  }

  const playerUniverse: PlayerUniverseReader = {
    all(s): DatasetResult<EspnPlayerIdentity> {
      const sn = season(s);
      const res = run("PlayerUniverseReader.all", 0, { season: sn });
      if (res === null) return NEVER_LOADED;
      const teams = run("PlayerUniverseReader.all", 1, { season: sn });
      const abbrev = new Map<number, string>();
      for (const r of teams?.rows ?? []) {
        const id = intOrNull(r.pro_team_id);
        const a = str(r.abbrev);
        if (id !== null && a !== null) abbrev.set(id, a);
      }
      return {
        rows: mapPlayers(res.rows, (_s, id) => abbrev.get(id) ?? null),
        stamp: stampOf(res.conn),
      };
    },
    byIds(espnIds): DatasetResult<EspnPlayerIdentity> {
      const res = run("PlayerUniverseReader.byIds", 0, {
        espn_ids: JSON.stringify(idList(espnIds, "espnIds")),
      });
      if (res === null) return NEVER_LOADED;
      const seasons = [
        ...new Set(res.rows.map((r) => intOrNull(r.season)).filter((x): x is number => x !== null)),
      ];
      const abbrev = new Map<string, string>();
      if (seasons.length > 0) {
        const teams = run("PlayerUniverseReader.byIds", 1, { seasons: JSON.stringify(seasons) });
        for (const r of teams?.rows ?? []) {
          const s = intOrNull(r.season);
          const id = intOrNull(r.pro_team_id);
          const a = str(r.abbrev);
          if (s !== null && id !== null && a !== null) abbrev.set(`${String(s)}:${String(id)}`, a);
        }
      }
      return {
        rows: mapPlayers(res.rows, (s, id) => abbrev.get(`${String(s)}:${String(id)}`) ?? null),
        stamp: stampOf(res.conn),
      };
    },
  };

  // --- nflverse:players (the crosswalk's id fallback) --------------------------------------------

  const nflPlayers: NflPlayersReader = {
    byEspnIds(espnIds): DatasetResult<NflPlayerRecord> {
      const res = run("NflPlayersReader.byEspnIds", 0, {
        espn_ids: JSON.stringify(idList(espnIds, "espnIds").filter((n) => n > 0)),
      });
      if (res === null) return NEVER_LOADED;
      const rows: NflPlayerRecord[] = [];
      for (const r of res.rows) {
        const gsis = str(r.gsis_id);
        const name = str(r.display_name);
        if (gsis === null || name === null) {
          warn("dataset_row_skipped");
          continue;
        }
        rows.push({
          gsis_id: gsis,
          espn_id: intOrNull(r.espn_id),
          display_name: name,
          position: str(r.position),
          latest_team: team(r.latest_team),
          jersey_number: intOrNull(r.jersey_number),
          status: str(r.status),
          last_season: intOrNull(r.last_season),
        });
      }
      return { rows, stamp: stampOf(res.conn) };
    },
  };

  const datasets: DatasetReaders = {
    proSchedule,
    nflGames,
    injuries,
    playerWeeks,
    // the Phase-2 ports (plan 10 §3.2): readers-p2.ts
    depthCharts: phase2.depthCharts,
    epWeekly: phase2.epWeekly,
    weather,
    news: phase2.news,
    trending: phase2.trending,
    pbp: phase2.pbp,
  };

  return { datasets, rosterWeekly, playerUniverse, nflPlayers };
}
