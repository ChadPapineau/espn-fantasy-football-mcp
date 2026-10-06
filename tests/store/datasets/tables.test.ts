// tables.test.ts — src/store/datasets/tables.ts (plan 01 §5.1–§5.5 per-source dataset files, each its
// own read-only connection; plan 08 §3.2 stat columns): the contract is well-formed (identifiers, no
// duplicate columns, PK/index columns exist, season keys, plan 01 table names, espn_id lookups),
// grounded in the real 2026 parquet columns and codecs and in the recorded proTeamSchedules_wl, every
// domain reader has statements over tables of its own source, and the DDL + every reader statement
// run on node:sqlite — on real recorded rows, read-only, and with hostile parameters that stay data.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, expectTypeOf, it } from "vitest";
import { DATASET_SOURCE_IDS, SOURCE_REGISTRY } from "../../../src/config/freshness.js";
import type {
  InjuryReader,
  NflGamesReader,
  PlayerWeekReader,
  ProScheduleReader,
  WeatherReader,
} from "../../../src/domain/analytics/types.js";
import type {
  PlayerUniverseReader,
  RosterWeeklyReader,
} from "../../../src/domain/crosswalk/types.js";
import * as venues from "../../../src/sources/venues.js";
import { ALLOWED_PARQUET_CODECS } from "../../../src/sources/source.js";
import * as derive from "../../../src/store/datasets/derive.js";
import {
  ALL_DATASET_TABLES,
  DATASET_IDENTIFIER_RE,
  DATASET_TABLES,
  DS_PLAYERS,
  DS_PRO_SCHEDULE,
  DS_PRO_TEAMS,
  DS_ROSTER_WEEKLY,
  DS_SCHEDULES,
  DS_TEAM_DEFENSE_WEEK,
  DST_FUMBLE_RETURN_TD_COLUMN,
  PARQUET_SOURCES,
  PENDING_PORT_READERS,
  PHASE_1_DATASET_SOURCES,
  PLAYER_WEEK_STAT_COLUMNS,
  READER_QUERIES,
  TEAM_DEFENSE_SUM_COLUMNS,
  columnsHash,
  columnsHashOf,
  ddlFor,
  isPhase1DatasetSource,
  quoteIdentifier,
  requiredUpstreamColumns,
  tablesFor,
  type DatasetTableContract,
  type Phase1DatasetSourceId,
  type ReaderMethod,
  type ReaderStatement,
} from "../../../src/store/datasets/tables.js";
import type { DatasetRow, DatasetTableSpec } from "../../../src/store/types.js";
import { OBSERVED_PARQUET } from "./observed-columns.js";

type Params = Record<string, string | number | null>;

const readerStatements: readonly (readonly [string, ReaderStatement])[] = Object.values(
  READER_QUERIES,
).flatMap((r) => r.statements.map((s) => [r.method, s] as const));

/** One in-memory DB per source — the plan 01 §5.5 shape: every dataset file is its own connection. */
function sourceDbs(): Map<Phase1DatasetSourceId, DatabaseSync> {
  const m = new Map<Phase1DatasetSourceId, DatabaseSync>();
  for (const s of PHASE_1_DATASET_SOURCES) {
    const db = new DatabaseSync(":memory:");
    for (const t of DATASET_TABLES[s]) for (const sql of ddlFor(t)) db.exec(sql);
    m.set(s, db);
  }
  return m;
}

function dbOf(dbs: Map<Phase1DatasetSourceId, DatabaseSync>, s: Phase1DatasetSourceId) {
  const db = dbs.get(s);
  if (!db) throw new Error(`no db for ${s}`);
  return db;
}

function run(
  dbs: Map<Phase1DatasetSourceId, DatabaseSync>,
  st: ReaderStatement,
  params: Params,
): Record<string, unknown>[] {
  return dbOf(dbs, st.source).prepare(st.sql).all(params);
}

function insert(db: DatabaseSync, table: string, row: DatasetRow): void {
  const cols = Object.keys(row);
  const sql = `INSERT INTO ${quoteIdentifier(table)} (${cols.map(quoteIdentifier).join(",")}) VALUES (${cols.map((c) => `:${c}`).join(",")})`;
  db.prepare(sql).run(row);
}

function closeAll(dbs: Map<Phase1DatasetSourceId, DatabaseSync>): void {
  for (const db of dbs.values()) db.close();
}

const stmtOf = (m: ReaderMethod, i = 0): ReaderStatement => {
  const s = READER_QUERIES[m].statements[i];
  if (!s) throw new Error(`${m} has no statement ${String(i)}`);
  return s;
};

// --- the recorded ESPN pro schedule, loaded the way the contract says (the source's job) ---------------

interface RecordedGame {
  readonly id: number;
  readonly date: number;
  readonly scoringPeriodId: number;
  readonly startTimeTBD: boolean;
  readonly validForLocking: boolean;
  readonly statsOfficial: boolean;
  readonly homeProTeamId: number;
  readonly awayProTeamId: number;
}
interface RecordedTeam {
  readonly id: number;
  readonly abbrev: string;
  readonly location: string;
  readonly name: string;
  readonly byeWeek: number;
  readonly proGamesByScoringPeriod?: Readonly<Record<string, readonly RecordedGame[]>>;
}
const PRO_SCHEDULE = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/espn/recorded/season/proTeamSchedules_wl.json", import.meta.url),
    "utf8",
  ),
) as { settings: { proTeams: RecordedTeam[] } };

/** ds_pro_schedule rows from the recording: entries collapsed by id, derivations applied. */
function proScheduleRows(season: number): DatasetRow[] {
  const byId = new Map<number, RecordedGame>();
  for (const t of PRO_SCHEDULE.settings.proTeams) {
    for (const games of Object.values(t.proGamesByScoringPeriod ?? {})) {
      for (const g of games) {
        const prior = byId.get(g.id);
        if (prior && JSON.stringify(prior) !== JSON.stringify(g))
          throw new Error("schema_mismatch");
        byId.set(g.id, g);
      }
    }
  }
  return [...byId.values()].map((g) => ({
    season,
    espn_game_id: g.id,
    week: g.scoringPeriodId,
    date_ms: derive.epochMs(g.date),
    start_time_tbd: derive.boolToInt(g.startTimeTBD),
    valid_for_locking: derive.boolToInt(g.validForLocking),
    stats_official: derive.boolToInt(g.statsOfficial),
    home_pro_team_id: g.homeProTeamId,
    away_pro_team_id: g.awayProTeamId,
  }));
}

function proTeamRows(season: number): DatasetRow[] {
  return PRO_SCHEDULE.settings.proTeams.map((t) => ({
    season,
    pro_team_id: t.id,
    abbrev: t.abbrev,
    location: derive.emptyToNull(t.location),
    name: derive.emptyToNull(t.name),
    bye_week: derive.byeWeek(t.byeWeek),
  }));
}

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// -------------------------------------------------------------------------------------------------

describe("contract shape", () => {
  it("covers exactly the Phase-1a dataset sources of SOURCE_REGISTRY", () => {
    const phase1 = DATASET_SOURCE_IDS.filter((id) => SOURCE_REGISTRY[id].phase === "1a");
    expect([...PHASE_1_DATASET_SOURCES].sort()).toEqual([...phase1].sort());
    expect(Object.keys(DATASET_TABLES).sort()).toEqual([...PHASE_1_DATASET_SOURCES].sort());
    for (const s of PHASE_1_DATASET_SOURCES) {
      expect(DATASET_TABLES[s].length).toBeGreaterThan(0);
      for (const t of DATASET_TABLES[s]) expect(t.source).toBe(s);
    }
  });

  it("uses the plan 01 §5.2 / plan 06 table names", () => {
    const names = ALL_DATASET_TABLES.map((t) => t.name);
    for (const n of [
      "ds_pro_schedule",
      "ds_players",
      "ds_schedules",
      "ds_injuries",
      "ds_roster_weekly",
      "ds_stats_player_week",
    ])
      expect(names).toContain(n);
  });

  it("has unique ds_ table names across every dataset file", () => {
    const names = ALL_DATASET_TABLES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) {
      expect(n).toMatch(/^ds_[a-z0-9_]+$/);
      expect(n).toMatch(DATASET_IDENTIFIER_RE);
    }
  });

  it.each(ALL_DATASET_TABLES.map((t) => [t.name, t] as const))(
    "%s: valid identifiers, provenance, PK/index columns exist",
    (_n, t: DatasetTableContract) => {
      const names = t.columns.map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
      for (const c of t.columns) {
        expect(c.name).toMatch(DATASET_IDENTIFIER_RE);
        expect(["TEXT", "INTEGER", "REAL", "BLOB"]).toContain(c.type);
        if (c.derivation === null) expect(c.from).toEqual([c.name]);
        else expect(c.derivation.length).toBeGreaterThan(0);
      }
      expect(t.primary_key).not.toBeNull();
      for (const k of t.primary_key ?? []) {
        const c = t.columns.find((x) => x.name === k);
        expect(c, `${t.name} PK ${k}`).toBeDefined();
        expect(c?.nullable, `${t.name} PK ${k} must be NOT NULL`).toBe(false);
      }
      const seen = new Set<string>();
      for (const ix of t.indexes) {
        expect(ix.length).toBeGreaterThan(0);
        for (const k of ix) expect(names, `${t.name} index ${k}`).toContain(k);
        expect(seen.has(ix.join(","))).toBe(false);
        seen.add(ix.join(","));
        expect(ix.join(","), "an index equal to the PK is redundant").not.toBe(
          (t.primary_key ?? []).join(","),
        );
      }
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.upstream.length).toBeGreaterThan(0);
      // The read host only — never the write host (plan 02; Phase W is not built).
      expect(t.upstream).not.toMatch(/writes/i);
    },
  );

  it("keys per-season tables on a NOT NULL INTEGER season", () => {
    for (const t of ALL_DATASET_TABLES) {
      if (t.season_key === null) continue;
      expect(t.primary_key).toContain("season");
      const c = t.columns.find((x) => x.name === "season");
      expect(c).toMatchObject({ type: "INTEGER", nullable: false });
    }
    const seasonless = ALL_DATASET_TABLES.filter((t) => t.season_key === null).map((t) => t.name);
    expect(seasonless.sort()).toEqual([
      "ds_nfl_players",
      "ds_venues",
      "ds_weather_nws",
      "ds_weather_open_meteo",
    ]);
  });

  it("is a DatasetTableSpec (what DatasetWriter.createTable takes) and deeply frozen", () => {
    const spec: DatasetTableSpec = DS_SCHEDULES;
    expect(spec.name).toBe("ds_schedules");
    for (const t of ALL_DATASET_TABLES) {
      expect(Object.isFrozen(t)).toBe(true);
      expect(Object.isFrozen(t.columns)).toBe(true);
      expect(Object.isFrozen(t.indexes)).toBe(true);
      for (const c of t.columns) {
        expect(Object.isFrozen(c)).toBe(true);
        expect(Object.isFrozen(c.from)).toBe(true);
      }
    }
    expect(Object.isFrozen(DATASET_TABLES)).toBe(true);
    expect(Object.isFrozen(READER_QUERIES)).toBe(true);
  });

  it("tablesFor / isPhase1DatasetSource", () => {
    expect(tablesFor("nflverse:schedules").map((t) => t.name)).toEqual([
      "ds_schedules",
      "ds_venues",
    ]);
    expect(tablesFor("espn:pro_schedule").map((t) => t.name)).toEqual([
      "ds_pro_schedule",
      "ds_pro_teams",
    ]);
    expect(tablesFor("nflverse:pbp")).toEqual([]);
    expect(isPhase1DatasetSource("weather:nws")).toBe(true);
    expect(isPhase1DatasetSource("__proto__")).toBe(false);
    expect(isPhase1DatasetSource("nflverse:stats_team_week")).toBe(false);
  });

  it("every derivation names a real function of derive.ts or src/sources/venues.ts", () => {
    const exported = new Set([...Object.keys(derive), ...Object.keys(venues)]);
    const named = new Set<string>();
    for (const t of ALL_DATASET_TABLES)
      for (const c of t.columns)
        for (const m of (c.derivation ?? "").matchAll(/\b([a-z]+[A-Z][A-Za-z]*)\(/g))
          named.add(m[1] ?? "");
    expect(named.size).toBeGreaterThan(8);
    expect([...named].filter((n) => !exported.has(n))).toEqual([]);
  });
});

describe("ESPN id lookups (research 04 §C: the ESPN id is a lookup, not a matcher)", () => {
  const colOf = (t: DatasetTableContract, n: string) => t.columns.find((c) => c.name === n);
  const leads = (t: DatasetTableContract, n: string): boolean =>
    t.indexes.some((ix) => ix[0] === n) || t.primary_key?.[0] === n;

  it("stores nflverse espn ids as INTEGER and indexes them", () => {
    expect(colOf(DS_ROSTER_WEEKLY, "espn_id")).toMatchObject({ type: "INTEGER", nullable: true });
    expect(DS_ROSTER_WEEKLY.indexes).toContainEqual(["espn_id", "season", "week"]);
    expect(colOf(DS_SCHEDULES, "espn_game_id")).toMatchObject({ type: "INTEGER" });
    expect(leads(DS_SCHEDULES, "espn_game_id")).toBe(true);
    const nflPlayers = tablesFor("nflverse:players")[0];
    expect(nflPlayers && colOf(nflPlayers, "espn_id")).toMatchObject({ type: "INTEGER" });
    expect(nflPlayers && leads(nflPlayers, "espn_id")).toBe(true);
    for (const t of [DS_ROSTER_WEEKLY, DS_SCHEDULES]) {
      const c = t.columns.find((x) => x.name.startsWith("espn_"));
      expect(c?.derivation).toMatch(/^parseDecimalId\(/);
    }
  });

  it("keys the ESPN-side tables on ESPN's own numeric ids", () => {
    expect(DS_PRO_SCHEDULE.primary_key).toEqual(["season", "espn_game_id"]);
    expect(DS_PRO_TEAMS.primary_key).toEqual(["season", "pro_team_id"]);
    expect(DS_PLAYERS.primary_key).toEqual(["season", "espn_id"]);
    expect(leads(DS_PLAYERS, "espn_id")).toBe(true);
    for (const t of tablesFor("weather:open_meteo"))
      expect(t.indexes).toContainEqual(["espn_game_id"]);
  });
});

describe("grounded in the real 2026 release files (2026-10-06)", () => {
  it("observed exactly the parquet sources", () => {
    expect(Object.keys(OBSERVED_PARQUET).sort()).toEqual([...PARQUET_SOURCES].sort());
  });

  it.each([...PARQUET_SOURCES])(
    "%s: every required upstream column exists in the file; codec allowed",
    (source) => {
      const o = OBSERVED_PARQUET[source];
      expect(o).toBeDefined();
      const observed = new Set(o?.columns);
      const required = requiredUpstreamColumns(source);
      expect(required.length).toBeGreaterThan(3);
      expect(required.filter((c) => !observed.has(c))).toEqual([]);
      expect([...required].sort()).toEqual(required);
      for (const codec of o?.codecs ?? []) expect(ALLOWED_PARQUET_CODECS).toContain(codec);
      expect(o?.rows).toBeGreaterThan(0);
      expect(o?.url).toMatch(
        /^https:\/\/github\.com\/nflverse\/nflverse-data\/releases\/download\//,
      );
    },
  );

  it("non-parquet and non-Phase-1 sources require no parquet columns", () => {
    for (const s of ["weather:open_meteo", "weather:nws", "espn:pro_schedule", "espn:players"])
      expect(requiredUpstreamColumns(s as Phase1DatasetSourceId)).toEqual([]);
    expect(requiredUpstreamColumns("nflverse:pbp")).toEqual([]);
  });

  it("stores every plan 08 §3.2 stats_player_week column verbatim", () => {
    const plan08 = [
      "completions", "attempts", "passing_yards", "passing_tds", "passing_interceptions",
      "carries", "rushing_yards", "rushing_tds", "targets", "receptions", "receiving_yards",
      "receiving_tds", "passing_2pt_conversions", "rushing_2pt_conversions",
      "receiving_2pt_conversions", "sack_fumbles_lost", "rushing_fumbles_lost",
      "receiving_fumbles_lost", "sack_fumbles", "rushing_fumbles", "receiving_fumbles",
      "special_teams_tds", "fg_made_0_19", "fg_made_20_29", "fg_made_30_39", "fg_made_40_49",
      "fg_made_50_59", "fg_made_60_", "fg_missed_0_19", "fg_missed_60_", "pat_made", "pat_att",
      "pat_missed",
    ]; // prettier-ignore
    const stored = PLAYER_WEEK_STAT_COLUMNS.map((c) => c.name);
    expect(plan08.filter((c) => !stored.includes(c))).toEqual([]);
    const observed = new Set(OBSERVED_PARQUET["nflverse:stats_player_week"]?.columns);
    for (const c of [...TEAM_DEFENSE_SUM_COLUMNS, ...stored]) expect(observed.has(c), c).toBe(true);
    expect(DS_TEAM_DEFENSE_WEEK.columns.map((c) => c.name)).toContain(DST_FUMBLE_RETURN_TD_COLUMN);
  });

  it("every ds_pro_schedule / ds_pro_teams field is a key of the recorded view", () => {
    const gameKeys = new Set<string>();
    const teamKeys = new Set<string>();
    for (const t of PRO_SCHEDULE.settings.proTeams) {
      for (const k of Object.keys(t)) teamKeys.add(k);
      for (const gs of Object.values(t.proGamesByScoringPeriod ?? {}))
        for (const g of gs) for (const k of Object.keys(g)) gameKeys.add(k);
    }
    for (const c of DS_PRO_SCHEDULE.columns) for (const f of c.from) expect(gameKeys).toContain(f);
    for (const c of DS_PRO_TEAMS.columns) for (const f of c.from) expect(teamKeys).toContain(f);
  });
});

describe("reader queries (one per domain reader method)", () => {
  it("names exactly the reader methods of the domain ports, plus the pending crosswalk port", () => {
    type Port<N extends string, I> = `${N}.${Extract<keyof I, string>}`;
    type Expected =
      | Port<"ProScheduleReader", ProScheduleReader>
      | Port<"NflGamesReader", NflGamesReader>
      | Port<"InjuryReader", InjuryReader>
      | Port<"PlayerWeekReader", PlayerWeekReader>
      | Port<"WeatherReader", WeatherReader>
      | Port<"RosterWeeklyReader", RosterWeeklyReader>
      | Port<"PlayerUniverseReader", PlayerUniverseReader>
      | "NflPlayersReader.byEspnIds";
    expectTypeOf<ReaderMethod>().toEqualTypeOf<Expected>();
    expect(PENDING_PORT_READERS).toEqual(["NflPlayersReader.byEspnIds"]);
    for (const [k, r] of Object.entries(READER_QUERIES)) {
      expect(r.method).toBe(k);
      expect(r.statements.length).toBeGreaterThan(0);
      expect(r.mapping.length).toBeGreaterThan(0);
      expect(r.returns.length).toBeGreaterThan(0);
    }
  });

  it("every statement is a SELECT over only its own source's tables and binds exactly its params", () => {
    for (const [m, st] of readerStatements) {
      expect(st.sql.trimStart().startsWith("SELECT "), m).toBe(true);
      expect(st.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ATTACH|PRAGMA|CREATE)\b/i);
      const own = DATASET_TABLES[st.source].map((t) => t.name);
      for (const t of st.tables) expect(own, `${m} → ${t}`).toContain(t);
      const referenced = [...st.sql.matchAll(/\b(?:FROM|JOIN)\s+(ds_[a-z0-9_]+)/g)].map(
        (x) => x[1],
      );
      expect(new Set(referenced), m).toEqual(new Set(st.tables));
      const bound = new Set([...st.sql.matchAll(/:([a-z_]+)/g)].map((x) => x[1]));
      expect(bound, m).toEqual(new Set(st.params));
      expect(st.sql).not.toContain("{schema}");
    }
  });

  it("every table is read by some reader", () => {
    const read = new Set(readerStatements.flatMap(([, st]) => st.tables));
    expect(ALL_DATASET_TABLES.map((t) => t.name).filter((n) => !read.has(n))).toEqual([]);
  });
});

describe("DDL + statements on node:sqlite", () => {
  const sample: Params = {
    season: 2026,
    week: 3,
    weeks: "[1,2,3]",
    gsis_ids: '["00-0034857"]',
    teams: '["BUF"]',
    game_ids: '["2026_04_PIT_CLE"]',
    espn_game_ids: "[401872964]",
    espn_ids: "[3918298]",
    espn_id: 3918298,
    seasons: "[2026]",
  };

  it("creates every table STRICT, and every reader statement prepares and runs on empty files", () => {
    const dbs = sourceDbs();
    for (const [m, st] of readerStatements) {
      const p = Object.fromEntries(st.params.map((k) => [k, sample[k] ?? null]));
      expect(Object.values(p), `${m} sample covers its params`).not.toContain(null);
      expect(run(dbs, st, p)).toEqual([]);
    }
    expect(() => {
      insert(dbOf(dbs, "nflverse:injuries"), "ds_injuries", {
        season: "not a number",
        game_type: "REG",
        week: 1,
        team: "BUF",
        gsis_id: "00-0000001",
      });
    }).toThrow();
    // STRICT coerces only a lossless conversion: decimal text lands as an INTEGER, anything else throws.
    const rw = dbOf(dbs, "nflverse:roster_weekly");
    const r = (espn: string, gsis: string): DatasetRow => ({
      season: 2026,
      week: 1,
      game_type: "REG",
      team: "BUF",
      gsis_id: gsis,
      full_name: "Josh Allen",
      espn_id: espn,
    });
    insert(rw, "ds_roster_weekly", r("3918298", "00-0034857"));
    expect(rw.prepare("SELECT typeof(espn_id) AS t FROM ds_roster_weekly").get()).toEqual({
      t: "integer",
    });
    for (const bad of ["3918298x", "", "1e5x", "３９１８２９８"])
      expect(() => {
        insert(rw, "ds_roster_weekly", r(bad, "00-0000002"));
      }, bad).toThrow();
    closeAll(dbs);
  });

  it("loads the recorded pro schedule (272 games, 33 teams) and serves it through the readers", () => {
    const dbs = sourceDbs();
    const db = dbOf(dbs, "espn:pro_schedule");
    const games = proScheduleRows(2026);
    for (const r of games) insert(db, "ds_pro_schedule", r);
    for (const r of proTeamRows(2026)) insert(db, "ds_pro_teams", r);
    const all = run(dbs, stmtOf("ProScheduleReader.games"), { season: 2026, weeks: null });
    expect(all).toHaveLength(272);
    expect(new Set(all.map((g) => g.week)).size).toBe(18);
    expect(all.filter((g) => g.start_time_tbd === 1)).toHaveLength(24);
    expect(all.filter((g) => g.valid_for_locking === 1)).toHaveLength(248);
    // ordered by kickoff
    const ms = all.map((g) => Number(g.date_ms));
    expect(ms).toEqual([...ms].sort((a, b) => a - b));
    const wk4 = run(dbs, stmtOf("ProScheduleReader.games"), { season: 2026, weeks: "[4]" });
    expect(wk4).toHaveLength(16);
    const pitCle = wk4.find((g) => g.espn_game_id === 401872964);
    expect(derive.epochMsToIso(pitCle?.date_ms)).toBe(
      derive.kickoffUtcFromEastern("2026-10-01", "20:15"),
    );
    expect(run(dbs, stmtOf("ProScheduleReader.games"), { season: 2025, weeks: null })).toEqual([]);
    const teams = run(dbs, stmtOf("ProScheduleReader.teams"), { season: 2026 });
    expect(teams).toHaveLength(33);
    expect(teams[0]).toMatchObject({ pro_team_id: 0, abbrev: "FA", bye_week: null });
    expect(teams.filter((t) => t.bye_week !== null)).toHaveLength(32);
    closeAll(dbs);
  });

  it("player universe: newest season per id; abbreviations come from the schedule file", () => {
    const dbs = sourceDbs();
    const players = dbOf(dbs, "espn:players");
    const p = (season: number, id: number, team: number): DatasetRow => ({
      season,
      espn_id: id,
      full_name: `Player ${String(id)}`,
      position_id: 1,
      pro_team_id: team,
    });
    insert(players, "ds_players", p(2025, 3918298, 2));
    insert(players, "ds_players", p(2026, 3918298, 2));
    insert(players, "ds_players", p(2026, 15818, 11));
    insert(players, "ds_players", { ...p(2026, -16021, 21), position_id: 16 });
    for (const r of proTeamRows(2026)) insert(dbOf(dbs, "espn:pro_schedule"), "ds_pro_teams", r);
    const by = run(dbs, stmtOf("PlayerUniverseReader.byIds"), { espn_ids: "[3918298,-16021,1]" });
    expect(by.map((r) => [r.espn_id, r.season])).toEqual([
      [-16021, 2026],
      [3918298, 2026],
    ]);
    const abbrevs = run(dbs, stmtOf("PlayerUniverseReader.byIds", 1), { seasons: "[2026]" });
    expect(abbrevs.find((r) => r.pro_team_id === 2)?.abbrev).toBe("BUF");
    expect(run(dbs, stmtOf("PlayerUniverseReader.all"), { season: 2026 })).toHaveLength(3);
    expect(run(dbs, stmtOf("PlayerUniverseReader.all", 1), { season: 2026 })).toHaveLength(33);
    closeAll(dbs);
  });

  it("schedules: games join the venue table; byEspnGameId returns every season's match", () => {
    const dbs = sourceDbs();
    const db = dbOf(dbs, "nflverse:schedules");
    for (const r of venues.venueRows()) insert(db, "ds_venues", r);
    const game = (id: string, season: number, espn: number, kick: string | null): DatasetRow => ({
      game_id: id,
      season,
      game_type: "REG",
      week: 4,
      espn_game_id: espn,
      gameday: "2026-10-01",
      kickoff_utc: kick,
      away_team: "PIT",
      home_team: "CLE",
      spread_line: -2.5,
      total_line: 38.5,
      venue_id: venues.resolveVenueId(id, "CLE00", "Huntington Bank Field"),
    });
    insert(
      db,
      "ds_schedules",
      game("2026_04_PIT_CLE", 2026, 401872964, "2026-10-02T00:15:00.000Z"),
    );
    insert(db, "ds_schedules", game("2026_04_X_Y", 2026, 401872965, null));
    insert(db, "ds_schedules", game("2026_04_A_B", 2026, 401872966, "2026-10-04T13:30:00.000Z"));
    insert(db, "ds_schedules", game("2003_04_A_B", 2003, 401872964, null)); // nflverse repeats old ids
    const games = run(dbs, stmtOf("NflGamesReader.games"), { season: 2026, weeks: "[4]" });
    expect(games.map((g) => g.game_id)).toEqual(["2026_04_PIT_CLE", "2026_04_A_B", "2026_04_X_Y"]);
    expect(games[0]).toMatchObject({
      venue_tz: "America/New_York",
      venue_roof_default: "outdoors",
      spread_line: -2.5,
    });
    const by = run(dbs, stmtOf("NflGamesReader.byEspnGameId"), { espn_game_ids: "[401872964]" });
    expect(by.map((g) => g.game_id)).toEqual(["2026_04_PIT_CLE", "2003_04_A_B"]);
    closeAll(dbs);
  });

  it("roster latest() returns the newest week per player; byEspnId the newest row for the id", () => {
    const dbs = sourceDbs();
    const db = dbOf(dbs, "nflverse:roster_weekly");
    const row = (week: number, team: string, espn: number | null): DatasetRow => ({
      season: 2026,
      week,
      game_type: "REG",
      team,
      gsis_id: "00-0036322",
      full_name: "Justin Jefferson",
      position: "WR",
      espn_id: espn,
    });
    insert(db, "ds_roster_weekly", row(1, "MIN", 4262921));
    insert(db, "ds_roster_weekly", row(4, "MIN", 4262921));
    insert(db, "ds_roster_weekly", {
      ...row(4, "CLE", 5150249),
      gsis_id: "00-0041075",
      position: "LB",
    });
    insert(db, "ds_roster_weekly", { ...row(4, "NYJ", null), gsis_id: "00-0099999" });
    const latest = run(dbs, stmtOf("RosterWeeklyReader.latest"), { season: 2026 });
    expect(latest.map((r) => [r.gsis_id, r.week])).toEqual([
      ["00-0036322", 4],
      ["00-0041075", 4],
      ["00-0099999", 4],
    ]);
    const by = stmtOf("RosterWeeklyReader.byEspnId");
    expect(run(dbs, by, { espn_id: 4262921 })).toMatchObject([{ week: 4, team: "MIN" }]);
    expect(run(dbs, by, { espn_id: 5150249 })).toMatchObject([{ position: "LB" }]);
    expect(run(dbs, by, { espn_id: 1 })).toEqual([]);
    expect(run(dbs, by, { espn_id: null })).toEqual([]); // NULL never equals NULL
    // INTEGER affinity converts decimal text for the comparison — the same id, never another one
    expect(run(dbs, by, { espn_id: "4262921" })).toHaveLength(1);
    expect(run(dbs, by, { espn_id: "4262921 OR 1=1" })).toEqual([]);
    expect(run(dbs, by, { espn_id: "' OR '1'='1" })).toEqual([]);
    closeAll(dbs);
  });

  it("defence lines + the points-allowed statement on the schedules file; weather by game id", () => {
    const dbs = sourceDbs();
    insert(dbOf(dbs, "nflverse:stats_player_week"), "ds_team_defense_week", {
      season: 2026,
      week: 4,
      season_type: "REG",
      team: "CLE",
      opponent_team: "PIT",
      game_id: "2026_04_PIT_CLE",
      def_sacks: 2.5,
      ...Object.fromEntries(
        [
          ...TEAM_DEFENSE_SUM_COLUMNS.filter((c) => c !== "def_sacks"),
          DST_FUMBLE_RETURN_TD_COLUMN,
        ].map((c) => [c, 0]),
      ),
      player_rows: 22,
    });
    const d = run(dbs, stmtOf("PlayerWeekReader.defenseLines"), {
      season: 2026,
      weeks: "[4]",
      teams: '["CLE"]',
    });
    expect(d).toMatchObject([{ team: "CLE", def_sacks: 2.5, game_id: "2026_04_PIT_CLE" }]);
    expect(
      run(dbs, stmtOf("PlayerWeekReader.defenseLines", 1), {
        season: 2026,
        game_ids: JSON.stringify(d.map((r) => r.game_id)),
      }),
    ).toEqual([]);
    const w = dbOf(dbs, "weather:nws");
    insert(w, "ds_weather_nws", {
      game_id: "2026_04_PIT_CLE",
      espn_game_id: 401872964,
      season: 2026,
      week: 4,
      venue_id: "CLE00",
      lat: 41.5061,
      lon: -81.6995,
      kickoff_utc: "2026-10-02T00:15:00.000Z",
      forecast_hour_utc: "2026-10-02T00:00:00.000Z",
      temp_f: 55.5,
      precip_prob: 0.2,
      as_of: "2026-10-01T18:00:00.000Z",
    });
    expect(
      run(dbs, stmtOf("WeatherReader.forGames", 1), { game_ids: '["2026_04_PIT_CLE"]' }),
    ).toMatchObject([{ temp_f: 55.5, precip_prob: 0.2 }]);
    closeAll(dbs);
  });

  it("hostile list parameters stay data (no injection, huge lists, unicode)", () => {
    const dbs = sourceDbs();
    insert(dbOf(dbs, "nflverse:injuries"), "ds_injuries", {
      season: 2026,
      game_type: "REG",
      week: 2,
      team: "BUF",
      gsis_id: "00-0034857",
      report_status: "Questionable",
    });
    const st = stmtOf("InjuryReader.reports");
    const hostile = JSON.stringify([
      "x') OR 1=1 --",
      "00-0034857\u0000",
      "Ｏ'Brien",
      "' ; DROP TABLE ds_injuries; --",
      "00-0034857 ",
    ]);
    expect(run(dbs, st, { season: 2026, week: 2, gsis_ids: hostile })).toEqual([]);
    const many = JSON.stringify([
      ...Array.from({ length: 20_000 }, (_, i) => `00-${String(i).padStart(7, "0")}`),
      "00-0034857",
    ]);
    expect(run(dbs, st, { season: 2026, week: 2, gsis_ids: many })).toHaveLength(1);
    expect(run(dbs, st, { season: 2026, week: 2, gsis_ids: null })).toHaveLength(1);
    expect(run(dbs, st, { season: 2026, week: 2, gsis_ids: "[]" })).toEqual([]);
    expect(() => run(dbs, st, { season: 2026, week: 2, gsis_ids: "not json" })).toThrow();
    // the table survived every attempt
    expect(run(dbs, st, { season: 2026, week: 2, gsis_ids: null })).toHaveLength(1);
    closeAll(dbs);
  });

  it("serves from a read-only connection to a published file and refuses any write (plan 01 §5.5, A-13)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eff-ds-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "espn_pro_schedule.sqlite");
    const w = new DatabaseSync(file);
    w.exec("PRAGMA journal_mode=DELETE");
    for (const t of tablesFor("espn:pro_schedule")) for (const sql of ddlFor(t)) w.exec(sql);
    for (const r of proScheduleRows(2026)) insert(w, "ds_pro_schedule", r);
    w.close();
    const ro = new DatabaseSync(file, { readOnly: true });
    const rows = ro
      .prepare(stmtOf("ProScheduleReader.games").sql)
      .all({ season: 2026, weeks: "[1]" });
    expect(rows).toHaveLength(16);
    expect(() => {
      insert(ro, "ds_pro_schedule", { ...proScheduleRows(2026)[0], espn_game_id: 1 });
    }).toThrow(/readonly|read-only/i);
    expect(() => {
      ro.exec("DELETE FROM ds_pro_schedule");
    }).toThrow();
    ro.close();
  });
});

/** The recorded player index (B1 grounding re-recording); the block below runs once it is committed. */
const PLAYERS_WL = new URL(
  "../../../fixtures/espn/recorded/season/players_wl.json",
  import.meta.url,
);
const ROSTER = new URL("../../../fixtures/players/fixture-roster.json", import.meta.url);

/** ds_players rows from a players_wl body, by the contract's derivations (the source's job). */
function playerRows(season: number, body: readonly Record<string, unknown>[]): DatasetRow[] {
  const ints = (v: unknown): v is number[] =>
    Array.isArray(v) && v.every((x) => Number.isInteger(x));
  return body.map((p) => {
    const own = (p.ownership as { percentOwned?: unknown } | undefined)?.percentOwned;
    return {
      season,
      espn_id: p.id as number,
      full_name: p.fullName as string,
      first_name: derive.emptyToNull(p.firstName),
      last_name: derive.emptyToNull(p.lastName),
      position_id: p.defaultPositionId as number,
      pro_team_id: p.proTeamId as number,
      eligible_slots: ints(p.eligibleSlots) ? JSON.stringify(p.eligibleSlots) : null,
      percent_owned:
        typeof own === "number" && Number.isFinite(own) && own >= 0 && own <= 100 ? own : null,
      droppable: derive.boolToInt(p.droppable),
      last_news_date_ms: derive.epochMs(p.lastNewsDate),
    };
  });
}

describe.skipIf(!existsSync(PLAYERS_WL))("the recorded players_wl through ds_players", () => {
  const body = existsSync(PLAYERS_WL)
    ? (JSON.parse(readFileSync(PLAYERS_WL, "utf8")) as Record<string, unknown>[])
    : [];

  it("carries every field ds_players reads", () => {
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(2000);
    const keys = new Set<string>();
    for (const p of body) {
      for (const [k, v] of Object.entries(p)) {
        keys.add(k);
        if (v !== null && typeof v === "object" && !Array.isArray(v))
          for (const kk of Object.keys(v)) keys.add(`${k}.${kk}`);
      }
    }
    for (const c of DS_PLAYERS.columns) for (const f of c.from) expect(keys, f).toContain(f);
  });

  it("loads into ds_players and serves every fixture-roster entry with its ESPN facts", () => {
    const dbs = sourceDbs();
    const db = dbOf(dbs, "espn:players");
    for (const r of playerRows(2026, body)) insert(db, "ds_players", r);
    for (const r of proTeamRows(2026)) insert(dbOf(dbs, "espn:pro_schedule"), "ds_pro_teams", r);
    const all = run(dbs, stmtOf("PlayerUniverseReader.all"), { season: 2026 });
    expect(all).toHaveLength(body.length);
    expect(all.filter((r) => Number(r.espn_id) < 0).length).toBeGreaterThan(90);
    const roster = JSON.parse(readFileSync(ROSTER, "utf8")) as {
      players: {
        espn_id: number;
        espn_name: string;
        espn_position_id: number;
        espn_pro_team_id: number;
      }[];
      team_units: {
        espn_id: number;
        espn_name: string;
        espn_position_id: number;
        espn_pro_team_id: number;
      }[];
    };
    const want = [...roster.players, ...roster.team_units];
    const got = run(dbs, stmtOf("PlayerUniverseReader.byIds"), {
      espn_ids: JSON.stringify(want.map((p) => p.espn_id)),
    });
    expect(got).toHaveLength(want.length);
    const byId = new Map(got.map((r) => [Number(r.espn_id), r]));
    for (const p of want)
      expect(byId.get(p.espn_id), p.espn_name).toMatchObject({
        full_name: p.espn_name,
        position_id: p.espn_position_id,
        pro_team_id: p.espn_pro_team_id,
      });
    closeAll(dbs);
  });
});

describe("columnsHash (the ds_schema fingerprint)", () => {
  it("is 64 hex, stable, distinct per source, and the empty-set hash for a non-Phase-1 source", () => {
    const hashes = PHASE_1_DATASET_SOURCES.map((s) => columnsHash(s));
    for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(columnsHash("nflverse:schedules")).toBe(columnsHash("nflverse:schedules"));
    expect(columnsHash("nflverse:pbp")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("changes when a column's type or nullability changes, not when columns are reordered", () => {
    const base = DS_PRO_TEAMS;
    const reordered = { ...base, columns: [...base.columns].reverse() };
    expect(columnsHashOf([reordered])).toBe(columnsHashOf([base]));
    const retyped = {
      ...base,
      columns: base.columns.map((c) =>
        c.name === "bye_week" ? { ...c, type: "TEXT" as const } : c,
      ),
    };
    expect(columnsHashOf([retyped])).not.toBe(columnsHashOf([base]));
    const nullable = {
      ...base,
      columns: base.columns.map((c) => (c.name === "abbrev" ? { ...c, nullable: true } : c)),
    };
    expect(columnsHashOf([nullable])).not.toBe(columnsHashOf([base]));
  });
});

describe("ddlFor / quoteIdentifier reject what they must", () => {
  const base: DatasetTableSpec = {
    name: "ds_t",
    columns: [
      { name: "a", type: "TEXT", nullable: false },
      { name: "b", type: "INTEGER", nullable: true },
    ],
    primary_key: ["a"],
    indexes: [["b"]],
  };

  it("emits CREATE TABLE ... STRICT with quoted identifiers and named indexes", () => {
    expect(ddlFor(base)).toEqual([
      'CREATE TABLE "ds_t" ("a" TEXT NOT NULL, "b" INTEGER, PRIMARY KEY ("a")) STRICT',
      'CREATE INDEX "ds_t__b" ON "ds_t" ("b")',
    ]);
    expect(ddlFor({ ...base, primary_key: null, indexes: [] })).toEqual([
      'CREATE TABLE "ds_t" ("a" TEXT NOT NULL, "b" INTEGER) STRICT',
    ]);
  });

  it.each([
    [
      "an injected column name",
      { columns: [{ name: 'a" TEXT); DROP TABLE x; --', type: "TEXT", nullable: true }] },
    ],
    ["an upper-case column", { columns: [{ name: "A", type: "TEXT", nullable: true }] }],
    ["a unicode column", { columns: [{ name: "wéek", type: "TEXT", nullable: true }] }],
    ["an empty column", { columns: [{ name: "", type: "TEXT", nullable: true }] }],
    ["a 64-char column", { columns: [{ name: "a".repeat(64), type: "TEXT", nullable: true }] }],
    ["a duplicate column", { columns: [base.columns[0], base.columns[0]] }],
    ["no columns", { columns: [] }],
    ["an unknown type", { columns: [{ name: "a", type: "JSON", nullable: true }] }],
    ["an unknown PK column", { primary_key: ["zz"] }],
    ["an unknown index column", { indexes: [["zz"]] }],
    ["an empty index", { indexes: [[]] }],
    ["a bad table name", { name: "ds_T" }],
    ["a hostile table name", { name: 'ds_t"; DROP TABLE x; --' }],
  ])("throws on %s", (_label, patch) => {
    expect(() => ddlFor({ ...base, ...patch } as DatasetTableSpec)).toThrow(/dataset contract/);
  });

  it.each([["Main"], ['main"; DROP'], [""], ["1abc"], ["a b"], ["ß"], ["a".repeat(64)]])(
    "quoteIdentifier rejects %j",
    (id) => {
      expect(() => quoteIdentifier(id)).toThrow(/dataset contract/);
    },
  );

  it("quoteIdentifier accepts the grammar", () => {
    expect(quoteIdentifier("fg_made_60_")).toBe('"fg_made_60_"');
    expect(quoteIdentifier("a".repeat(63))).toBe(`"${"a".repeat(63)}"`);
  });
});
