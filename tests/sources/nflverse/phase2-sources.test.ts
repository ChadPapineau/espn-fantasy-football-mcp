// phase2-sources.test.ts — every Phase-2 parquet DataSource and its history twin end to end on the
// fixture excerpts (plan 10 §3.2 sources, B1; plan 01 §5.5; plan 05 §2 `sources/*`): version from
// the release's timestamp.txt (history: the month bucket, no request) → fetch through a fake
// HttpGet/HttpDownload serving parquet rebuilt from fixtures/{nflverse/phase2,ffopportunity} →
// assertSchema → publish into a real STRICT SQLite writer; the contract's own reader SQL
// (tables.ts PHASE_2_READER_QUERIES) over the published files; the pbp counting reproduces
// nflverse's stats_player_week for every player of the fixture games (current AND prior seasons);
// and the current sources go through the REAL runner + publisher. No network. Phase 3 (plan 10 §3.3,
// D9): a history twin's file holds the three backtest seasons whatever the run names, so its runs
// here (the CLI's two-season default) also load the 2023 excerpts (fixtures/history/).
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ATTRIBUTIONS, SOURCE_REGISTRY } from "../../../src/config/freshness.js";
import { backupDir, datasetDir, storePath } from "../../../src/config/paths.js";
import type { ProScheduleReader } from "../../../src/domain/analytics/types.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import {
  FFOPPORTUNITY_HISTORY_SOURCES,
  FFOPPORTUNITY_SOURCES,
  epWeeklyHistorySource,
  epWeeklySource,
} from "../../../src/sources/ffopportunity/index.js";
import {
  NFLVERSE_HISTORY_SOURCES,
  NFLVERSE_PHASE_2_SOURCES,
  PBP_NOT_KEPT,
  depthChartsSource,
  pbpSource,
  snapCountsSource,
  statsTeamWeekSource,
  type HistoryDataSource,
  type NflversePublishStats,
  type NflverseSchemaReport,
} from "../../../src/sources/nflverse/index.js";
import { fsTempArea, runRefresh } from "../../../src/sources/runner.js";
import { SOURCE_RATE_LIMITS, type DataSource } from "../../../src/sources/source.js";
import { isKeptPlayType } from "../../../src/store/datasets/derive.js";
import {
  HISTORY_OF,
  PHASE_2_READER_QUERIES,
  contractColumnsHash,
  contractTablesFor,
  type Phase2ReaderMethod,
} from "../../../src/store/datasets/tables.js";
import { storeFactory } from "../../../src/store/index.js";
import { FX, REL, fixtureRows, type Row } from "./helpers/fixtures.js";
import { SqliteWriter, makeCtx, proGame, type Ctx, type Route } from "./helpers/harness.js";
import { GAME_2023, hRows } from "./helpers/history-fixtures.js";
import { P2, p2Rows, historyRunRoutes } from "./helpers/phase2-fixtures.js";
import { rewritePhase2 } from "./helpers/phase2-rewrite.js";

const ROUTES = historyRunRoutes();
/** The seasons a history file holds after a run of [2024, 2025] at the fixed clock (2026-10-06). */
const HELD = [2023, 2024, 2025];
const CURRENT: readonly DataSource[] = [
  statsTeamWeekSource,
  pbpSource,
  snapCountsSource,
  depthChartsSource,
  epWeeklySource,
];
const HISTORY: readonly HistoryDataSource[] = [
  ...Object.values(NFLVERSE_HISTORY_SOURCES),
  ...Object.values(FFOPPORTUNITY_HISTORY_SOURCES),
];

const open: Ctx[] = [];
const writers: SqliteWriter[] = [];
afterEach(() => {
  for (const w of writers.splice(0)) w.close();
  for (const c of open.splice(0)) c.cleanup();
});

interface Run {
  readonly c: Ctx;
  readonly w: SqliteWriter;
  readonly report: NflverseSchemaReport;
  readonly stats: NflversePublishStats;
  readonly version: string;
}

async function run(
  source: DataSource | HistoryDataSource,
  seasons: readonly number[],
  routes: ReadonlyMap<string, Route> = ROUTES,
): Promise<Run> {
  const c = makeCtx(seasons, { routes });
  open.push(c);
  const v = await source.version(c.ctx);
  if (v === null) throw new Error("no version");
  const files = await source.fetch(v, c.ctx);
  const report = (await source.assertSchema(files)) as NflverseSchemaReport;
  expect(report.ok, report.warnings.join("\n")).toBe(true);
  const w = new SqliteWriter(c.tempDir);
  writers.push(w);
  const stats = (await source.publish(files, w)) as NflversePublishStats;
  return { c, w, report, stats, version: v.version };
}

const rowsOf = (s: NflversePublishStats): Record<string, number> =>
  Object.fromEntries(s.tables.map((t) => [t.name, t.rows]));
const one = (w: SqliteWriter, sql: string): Record<string, unknown> => w.all(sql)[0] ?? {};

describe("registry fields (plan 05 §2 `sources/*`; B1: each source's licence for eff status)", () => {
  it("every current source carries its SOURCE_REGISTRY row and its contract tables", () => {
    for (const s of CURRENT) {
      const info = SOURCE_REGISTRY[s.id];
      expect(s.license, s.id).toBe(info.license);
      expect(s.attribution, s.id).toBe(info.attribution);
      expect(s.freshness, s.id).toBe(info.freshness);
      expect(s.job, s.id).toBe(info.job);
      expect(s.limiter, s.id).toBe(SOURCE_RATE_LIMITS.github_release);
      expect(s.versioning, s.id).toBe("release");
      expect(s.seasonGate, s.id).toBe("in_season");
      expect(s.tables, s.id).toBe(contractTablesFor(s.id));
    }
    expect(NFLVERSE_PHASE_2_SOURCES["nflverse:pbp"]).toBe(pbpSource);
    expect(FFOPPORTUNITY_SOURCES["ffopportunity:ep_weekly"]).toBe(epWeeklySource);
  });

  it("licences: nflverse CC-BY 4.0; ffopportunity CC-BY-SA 4.0 with its own attribution", () => {
    for (const s of CURRENT.filter((x) => x.id.startsWith("nflverse:"))) {
      expect(s.license).toBe("CC-BY-4.0");
      expect(s.attribution).toBe(ATTRIBUTIONS.nflverse);
    }
    expect(epWeeklySource.license).toBe("CC-BY-SA-4.0");
    expect(epWeeklySource.attribution).toBe(ATTRIBUTIONS.ffopportunity);
    expect(epWeeklySource.attribution.url).toBe("https://github.com/ffverse/ffopportunity");
  });

  it("the jobs are plan 06 §1.3's: stats → stats_team_week + pbp; snaps; daily; ffopportunity", () => {
    expect(statsTeamWeekSource.job).toBe("nflverse:stats");
    expect(pbpSource.job).toBe("nflverse:stats");
    expect(snapCountsSource.job).toBe("nflverse:snaps");
    expect(depthChartsSource.job).toBe("nflverse:daily");
    expect(epWeeklySource.job).toBe("ffopportunity");
  });

  it("every history twin repeats its current source: id, tables, licence, job; month-versioned", () => {
    expect(HISTORY.map((h) => h.id).sort()).toEqual(Object.keys(HISTORY_OF).sort());
    for (const h of HISTORY) {
      expect(h.current, h.id).toBe(HISTORY_OF[h.id]);
      const info = SOURCE_REGISTRY[h.current];
      expect(h.license, h.id).toBe(info.license);
      expect(h.attribution, h.id).toBe(info.attribution);
      expect(h.job, h.id).toBe(info.job);
      expect(h.freshness, h.id).toBe(info.freshness);
      expect(h.versioning, h.id).toBe("time_bucket");
      expect(h.seasonGate, h.id).toBe("always");
      expect(h.tables, h.id).toBe(contractTablesFor(h.id));
    }
    for (const [id, h] of Object.entries(NFLVERSE_HISTORY_SOURCES)) expect(h.id).toBe(id);
    expect(epWeeklyHistorySource.license).toBe("CC-BY-SA-4.0");
  });
});

describe("nflverse:stats_team_week", () => {
  it("publishes every fixture team-week verbatim; the version names the release + seasons", async () => {
    const r = await run(statsTeamWeekSource, [2026]);
    expect(r.version).toBe("20261006T155527Z_2026");
    expect(rowsOf(r.stats)).toEqual({ ds_stats_team_week: 60 });
    expect(r.stats.seasons).toEqual([2026]);
    expect(r.stats.columns_hash).toBe(contractColumnsHash("nflverse:stats_team_week"));
    expect(r.stats.warnings).toEqual([]);
    const raw = p2Rows("nflverse:stats_team_week@2026").find(
      (x) => x.team === "DET" && x.week === 1,
    );
    const got = one(
      r.w,
      "SELECT * FROM ds_stats_team_week WHERE season = 2026 AND week = 1 AND team = 'DET'",
    );
    for (const k of ["passing_yards", "rushing_tds", "def_sacks", "passing_epa", "fg_made_list"])
      expect(got[k], k).toEqual(raw?.[k] === "" ? null : raw?.[k]);
    // every game appears twice (one row per side)
    const sides = r.w.all(
      "SELECT game_id, COUNT(*) AS n FROM ds_stats_team_week GROUP BY game_id HAVING n <> 2",
    );
    expect(sides.length).toBeLessThan(30); // only games whose opponent is outside the excerpt
    expect(r.report.extra_columns.length).toBe(138 - 92);
  });

  it("history: the prior seasons' rows (REG and POST) in their own file", async () => {
    const r = await run(NFLVERSE_HISTORY_SOURCES["nflverse:stats_team_week_history"], [2024, 2025]);
    expect(rowsOf(r.stats)).toEqual({ ds_stats_team_week: 9 });
    expect(r.stats.seasons).toEqual(HELD);
    expect(r.version).toBe("h2026-10_2023-2024-2025");
    expect(r.c.calls.every((u) => !u.endsWith("timestamp.txt"))).toBe(true);
    expect(r.w.all("SELECT DISTINCT season_type FROM ds_stats_team_week ORDER BY 1")).toEqual([
      { season_type: "POST" },
      { season_type: "REG" },
    ]);
  });
});

describe("nflverse:pbp — the projected subset", () => {
  it("keeps every snap and kick, drops markers and no_play rows (counted), never reads desc", async () => {
    const raw = p2Rows("nflverse:pbp@2026");
    const kept = raw.filter((x) => isKeptPlayType(x.play_type));
    const r = await run(pbpSource, [2026]);
    expect(rowsOf(r.stats)).toEqual({ ds_pbp: kept.length });
    expect(kept.length).toBe(516);
    expect(r.stats.warnings).toEqual([
      `ds_pbp: dropped ${String(raw.length - kept.length)} row(s) — ${PBP_NOT_KEPT}`,
    ]);
    const cols = r.w.all("SELECT name FROM pragma_table_info('ds_pbp')").map((x) => x.name);
    expect(cols).not.toContain("desc");
    expect(cols).toHaveLength(51);
    // the contract's 49 upstream columns + 6 unread extras are in the file; only 49 are decoded
    expect(r.report.extra_columns).toEqual(
      ["away_team", "desc", "drive", "game_date", "home_team", "time"].sort(),
    );
  });

  it("rz / gl follow yardline_100 (≤ 20 / ≤ 5); 0/1 indicators; whole numbers; finite reals", async () => {
    const r = await run(pbpSource, [2026]);
    const bad = r.w.all(`SELECT play_id FROM ds_pbp WHERE
      rz <> (yardline_100 <= 20) OR gl <> (yardline_100 <= 5) OR yardline_100 NOT BETWEEN 1 AND 99
      OR typeof(play_id) <> 'integer' OR (epa IS NOT NULL AND typeof(epa) <> 'real')
      OR pass_attempt NOT IN (0, 1) OR touchdown NOT IN (0, 1)`);
    expect(bad).toEqual([]);
    expect(one(r.w, "SELECT SUM(gl) AS n FROM ds_pbp").n).toBeGreaterThan(0);
    const fg = r.w.all(
      "SELECT kick_distance, field_goal_result FROM ds_pbp WHERE play_type = 'field_goal'",
    );
    expect(fg.length).toBe(10);
    for (const k of fg) expect(Number(k.kick_distance)).toBeGreaterThan(17);
    const tds = r.w.all(
      "SELECT yards_gained FROM ds_pbp WHERE touchdown = 1 AND return_touchdown = 0",
    );
    for (const t of tds) expect(t.yards_gained).not.toBeNull();
  });

  it("reproduces nflverse's stats_player_week for every player of the three 2026 games", async () => {
    const r = await run(pbpSource, [2026]);
    const stats = fixtureRows(FX.stats).filter(
      (s) =>
        s.player_id !== null &&
        ((s.week === 1 && ["NO", "DET"].includes(String(s.team))) ||
          (s.week === 2 && ["LV", "LAC"].includes(String(s.team))) ||
          (s.week === 3 && ["LA", "DEN"].includes(String(s.team)))),
    );
    expect(compareWithStats(r.w, 2026, stats)).toBeGreaterThan(70);
  });

  it("history: both prior games reproduce their stats_player_week twins too", async () => {
    const r = await run(NFLVERSE_HISTORY_SOURCES["nflverse:pbp_history"], [2024, 2025]);
    expect(r.stats.seasons).toEqual(HELD);
    let n = 0;
    for (const season of HELD) {
      const key = `nflverse:stats_player_week@${String(season)}`;
      const stats = (season === 2023 ? hRows(key) : p2Rows(key)).filter(
        (s) => s.player_id !== null,
      );
      const one = compareWithStats(r.w, season, stats);
      expect(one, String(season)).toBeGreaterThan(20);
      n += one;
    }
    expect(n).toBeGreaterThan(75);
  });
});

/** Per player-week: targets, receptions, carries, TDs and FG kicks from ds_pbp = the stats rows. */
function compareWithStats(w: SqliteWriter, season: number, stats: readonly Row[]): number {
  const weeks = JSON.stringify([...new Set(stats.map((s) => Number(s.week)))]);
  const ids = JSON.stringify(stats.map((s) => String(s.player_id)));
  const p = (sql: string) =>
    w.db.prepare(sql).all({ season, weeks, gsis_ids: ids }) as Record<string, unknown>[];
  const usage = (i: number) =>
    new Map(
      p(sqlOf("PbpReader.playerUsage", i)).map((x) => [
        `${String(x.gsis_id)}|${String(x.week)}`,
        x,
      ]),
    );
  const targets = usage(0);
  const carries = usage(1);
  const plays = p(sqlOf("PbpReader.scoringPlays"));
  const count = (
    pred: (x: Record<string, unknown>) => boolean,
    id: string,
  ): Map<string, number> => {
    const m = new Map<string, number>();
    for (const x of plays.filter(pred)) {
      const k = `${String(x[id])}|${String(x.week)}`;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const passTd = count((x) => x.pass_touchdown === 1, "passer_player_id");
  const recTd = count((x) => x.pass_touchdown === 1, "td_player_id");
  const rushTd = count((x) => x.rush_touchdown === 1, "td_player_id");
  const fga = count((x) => x.play_type === "field_goal", "kicker_player_id");
  const fgm = count(
    (x) => x.play_type === "field_goal" && x.field_goal_result === "made",
    "kicker_player_id",
  );
  let compared = 0;
  for (const s of stats) {
    const k = `${String(s.player_id)}|${String(s.week)}`;
    expect(Number(targets.get(k)?.targets ?? 0), `targets ${k}`).toBe(Number(s.targets ?? 0));
    expect(Number(targets.get(k)?.receptions ?? 0), `receptions ${k}`).toBe(
      Number(s.receptions ?? 0),
    );
    expect(Number(carries.get(k)?.carries ?? 0), `carries ${k}`).toBe(Number(s.carries ?? 0));
    expect(passTd.get(k) ?? 0, `pass td ${k}`).toBe(Number(s.passing_tds ?? 0));
    expect(recTd.get(k) ?? 0, `rec td ${k}`).toBe(Number(s.receiving_tds ?? 0));
    expect(rushTd.get(k) ?? 0, `rush td ${k}`).toBe(Number(s.rushing_tds ?? 0));
    expect(fga.get(k) ?? 0, `fg att ${k}`).toBe(Number(s.fg_att ?? 0));
    expect(fgm.get(k) ?? 0, `fg made ${k}`).toBe(Number(s.fg_made ?? 0));
    compared++;
  }
  return compared;
}

const sqlOf = (m: Phase2ReaderMethod, i = 0): string =>
  PHASE_2_READER_QUERIES[m].statements[i]?.sql ?? "";

describe("nflverse:snap_counts", () => {
  it("publishes every row: whole snaps, shares within 0–1, keyed by pfr id; no player name", async () => {
    const r = await run(snapCountsSource, [2026]);
    expect(rowsOf(r.stats)).toEqual({ ds_snap_counts: p2Rows("nflverse:snap_counts@2026").length });
    expect(
      r.w.all(`SELECT pfr_player_id FROM ds_snap_counts WHERE
        typeof(offense_snaps) NOT IN ('integer', 'null') OR offense_pct < 0 OR offense_pct > 1
        OR st_pct < 0 OR st_pct > 1 OR defense_pct < 0 OR defense_pct > 1`),
    ).toEqual([]);
    const cols = r.w.all("SELECT name FROM pragma_table_info('ds_snap_counts')").map((x) => x.name);
    expect(cols).not.toContain("player");
    expect(r.report.extra_columns).toEqual(["player"]);
  });

  it("SnapCountReader's snap statement reads the file; history holds the prior games", async () => {
    const r = await run(snapCountsSource, [2026]);
    const pfr = p2Rows("nflverse:snap_counts@2026")
      .filter((x) => x.game_id === "2026_01_NO_DET")
      .map((x) => String(x.pfr_player_id));
    const got = r.w.db
      .prepare(sqlOf("SnapCountReader.counts", 2))
      .all({ season: 2026, weeks: "[1]", pfr_ids: JSON.stringify(pfr) });
    expect(got.length).toBe(pfr.length);
    const h = await run(NFLVERSE_HISTORY_SOURCES["nflverse:snap_counts_history"], [2024, 2025]);
    expect(rowsOf(h.stats)).toEqual({ ds_snap_counts: 95 + 91 + 92 });
    expect(h.stats.seasons).toEqual(HELD);
  });
});

describe("nflverse:depth_charts — ESPN-keyed occupancy runs", () => {
  it("compresses the snapshots into runs that rebuild every snapshot; the current chart is the newest", async () => {
    const raw = p2Rows("nflverse:depth_charts@2026");
    const r = await run(depthChartsSource, [2026]);
    const n = rowsOf(r.stats).ds_depth_charts ?? 0;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(raw.length / 4);
    expect(r.stats.warnings).toEqual([]);
    // every snapshot row belongs to exactly one run
    expect(one(r.w, "SELECT SUM(snapshots) AS s FROM ds_depth_charts").s).toBe(raw.length);
    const newest = [...new Set(raw.map((x) => String(x.dt)))].sort().at(-1);
    expect(one(r.w, "SELECT COUNT(*) AS c FROM ds_depth_charts WHERE valid_to_ms IS NULL").c).toBe(
      raw.filter((x) => x.dt === newest).length,
    );
    expect(
      r.w.all(`SELECT espn_id FROM ds_depth_charts WHERE valid_from_ms > last_seen_ms
        OR (valid_to_ms IS NOT NULL AND valid_to_ms <= last_seen_ms) OR snapshots < 1
        OR season <> 2026 OR typeof(espn_id) <> 'integer'`),
    ).toEqual([]);
    // the chart as of any snapshot instant equals that snapshot's rows (DepthChartReader.asOf)
    const det = raw.filter((x) => x.team === "DET");
    for (const dt of [...new Set(det.map((x) => String(x.dt)))]) {
      const got = r.w.db
        .prepare(sqlOf("DepthChartReader.asOf"))
        .all({ season: 2026, teams: '["DET"]', at_ms: Date.parse(dt) });
      expect(got.length, dt).toBe(det.filter((x) => x.dt === dt).length);
    }
    const chart = r.w.db
      .prepare(sqlOf("DepthChartReader.chart"))
      .all({ season: 2026, teams: '["DET"]' });
    expect(chart.length).toBe(det.filter((x) => x.dt === newest).length);
  });

  it("history: 2025 runs (snapshot layout) + the ≤ 2024 weekly layout, its edge rows handled", async () => {
    const legacyRaw = p2Rows("nflverse:depth_charts@2024");
    const r = await run(NFLVERSE_HISTORY_SOURCES["nflverse:depth_charts_history"], [2024, 2025]);
    const t = rowsOf(r.stats);
    expect(Object.keys(t)).toEqual(["ds_depth_charts", "ds_depth_charts_legacy"]);
    expect(t.ds_depth_charts).toBeGreaterThan(0);
    expect(r.stats.columns_hash).toBe(contractColumnsHash("nflverse:depth_charts_history"));
    // 2024: 1 duplicate + 3 SBBYE; 2023 (fixtures/history): 2 duplicates + 3 SBBYE, 13 rows whose
    // label is outside DEPTH_LABELS (kept as OTHER) and 2 whose label fails the grammar (dropped)
    const raw2023 = hRows("nflverse:depth_charts@2023");
    expect(r.stats.warnings).toEqual([
      "ds_depth_charts_legacy: 13 row(s) — pos_abb label outside DEPTH_LABELS stored as 'OTHER'",
      "ds_depth_charts_legacy: dropped 2 row(s) — null pos_abb",
      "ds_depth_charts_legacy: dropped 3 row(s) — exact duplicate row collapsed",
      "ds_depth_charts_legacy: dropped 6 row(s) — week null (SBBYE rows)",
    ]);
    expect(t.ds_depth_charts_legacy).toBe(legacyRaw.length - 4 + raw2023.length - 7);
    expect(r.stats.seasons).toEqual(HELD);
    expect(
      one(r.w, "SELECT COUNT(*) AS n FROM ds_depth_charts_legacy WHERE pos_abb = 'OTHER'").n,
    ).toBe(13);
    // no upstream label text outside the vocabulary is stored (the backslash label never lands)
    expect(
      r.w.all(
        "SELECT pos_abb FROM ds_depth_charts_legacy WHERE instr(pos_abb, char(92)) > 0 OR instr(formation, char(92)) > 0",
      ),
    ).toEqual([]);
    const chart2023 = r.w.db
      .prepare(sqlOf("DepthChartReader.chart", 1))
      .all({ season: 2023, teams: '["BUF","CIN"]' });
    expect(chart2023.length).toBeGreaterThan(40);
    // each team's last listed week (an edge row of a later week stands for its team's chart)
    const lastWeek = new Map(chart2023.map((x) => [String(x.team), Number(x.week)]));
    expect([...lastWeek.keys()].sort()).toEqual(["BUF", "CIN"]);
    for (const x of chart2023) expect(x.week).toBe(lastWeek.get(String(x.team)));
    // a blank depth_position falls back to position
    const blank = legacyRaw.find(
      (x) =>
        typeof x.depth_position === "string" && x.depth_position.trim() === "" && x.week !== null,
    );
    expect(blank).toBeDefined();
    const got = r.w.db
      .prepare(
        "SELECT pos_abb FROM ds_depth_charts_legacy WHERE gsis_id = ? AND week = ? AND team = ?",
      )
      .all(String(blank?.gsis_id), Number(blank?.week), String(blank?.club_code));
    expect(got.map((x) => x.pos_abb)).toContain(String(blank?.position));
    const chart = r.w.db
      .prepare(sqlOf("DepthChartReader.chart", 1))
      .all({ season: 2024, teams: '["SEA","DET"]' });
    expect(chart.length).toBeGreaterThan(100);
  });
});

describe("ffopportunity:ep_weekly", () => {
  it("publishes player-weeks (season text → integer, week double → integer); team-level rows dropped", async () => {
    const raw = p2Rows("ffopportunity:ep_weekly@2026");
    const r = await run(epWeeklySource, [2026]);
    expect(r.version).toBe("20261006T121446Z_2026");
    expect(rowsOf(r.stats)).toEqual({ ds_ep_weekly: raw.length - 2 });
    expect(r.stats.warnings).toEqual([
      "ds_ep_weekly: dropped 2 row(s) — team-level row without a player_id (unattributed opportunity)",
    ]);
    expect(
      r.w.all(`SELECT player_id FROM ds_ep_weekly WHERE typeof(season) <> 'integer'
        OR season <> 2026 OR typeof(week) <> 'integer' OR week NOT BETWEEN 1 AND 3`),
    ).toEqual([]);
    const cols = r.w.all("SELECT name FROM pragma_table_info('ds_ep_weekly')").map((x) => x.name);
    expect(cols).not.toContain("full_name");
    const ids = raw.filter((x) => x.player_id !== null).map((x) => String(x.player_id));
    const rows = r.w.db
      .prepare(sqlOf("EpWeeklyReader.rows"))
      .all({ season: 2026, weeks: "[1,2,3]", gsis_ids: JSON.stringify(ids) });
    expect(rows.length).toBe(ids.length);
    const x = raw.find((y) => y.player_id !== null);
    const back = rows.find((y) => y.player_id === x?.player_id && y.week === x?.week);
    expect(back?.total_fantasy_points_exp).toBe(x?.total_fantasy_points_exp);
  });

  it("history: both prior games' player rows", async () => {
    const r = await run(epWeeklyHistorySource, [2024, 2025]);
    const teamLevel2023 = hRows("ffopportunity:ep_weekly@2023").filter((x) => x.player_id === null);
    expect(teamLevel2023.length).toBeGreaterThan(0);
    expect(rowsOf(r.stats)).toEqual({ ds_ep_weekly: 40 + 21 - teamLevel2023.length });
    expect(r.stats.seasons).toEqual(HELD);
    expect(r.w.all("SELECT DISTINCT game_id FROM ds_ep_weekly WHERE season = 2023")).toEqual([
      { game_id: GAME_2023 },
    ]);
  });
});

describe("the Phase-1 history twins (stats_player_week, injuries) over prior seasons", () => {
  it("stats_player_week_history: player rows + derived team-defence lines, the Phase-1 hash", async () => {
    const r = await run(
      NFLVERSE_HISTORY_SOURCES["nflverse:stats_player_week_history"],
      [2024, 2025],
    );
    const t = rowsOf(r.stats);
    expect(t.ds_stats_player_week).toBeGreaterThan(100);
    // the four game teams, plus the teams of that week's team-level (null player_id) rows
    const teams = r.w
      .all("SELECT season, week, team FROM ds_team_defense_week ORDER BY season, team")
      .map((x) => `${String(x.season)}/${String(x.week)}/${String(x.team)}`);
    expect(teams).toEqual(
      expect.arrayContaining([
        "2023/9/BUF",
        "2023/9/CIN",
        "2024/4/DET",
        "2024/4/SEA",
        "2025/7/DAL",
        "2025/7/WAS",
      ]),
    );
    expect(t.ds_team_defense_week).toBe(teams.length);
    expect(r.stats.columns_hash).toBe(contractColumnsHash("nflverse:stats_player_week_history"));
    expect(r.c.calls.filter((u) => u.endsWith(".parquet"))).toEqual([
      `${REL}/stats_player/stats_player_week_2023.parquet`,
      `${REL}/stats_player/stats_player_week_2024.parquet`,
      `${REL}/stats_player/stats_player_week_2025.parquet`,
    ]);
    expect(r.stats.seasons).toEqual(HELD);
  });

  it("injuries_history: the 2024 file (no season_type, an extra column dropped) loads", async () => {
    const r = await run(NFLVERSE_HISTORY_SOURCES["nflverse:injuries_history"], [2024, 2025]);
    expect(rowsOf(r.stats)).toEqual({ ds_injuries: 30 + 29 + 16 });
    expect(r.stats.seasons).toEqual(HELD);
  });
});

describe("through the REAL runner and publisher (the `eff refresh` path, plan 01 §5.5)", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });
  const NOW = "2026-10-06T12:00:00.000Z";
  const inSeason: ProScheduleReader = {
    games: (season) => ({
      rows: [proGame(season, 5, "2026-10-08T00:15:00.000Z")],
      stamp: {
        source: "espn:pro_schedule",
        as_of: NOW,
        fetched_at: NOW,
        checked_at: NOW,
        freshness_class: "espn_pro_schedule",
        file_version: "v",
      },
    }),
    teams: () => ({ rows: [], stamp: null }),
  };

  function world(proSchedule: ProScheduleReader, routes: ReadonlyMap<string, Route> = ROUTES) {
    const root = mkdtempSync(path.join(tmpdir(), "eff-p2-runner-"));
    roots.push(root);
    const cache = path.join(root, "cache");
    mkdirSync(cache, { mode: 0o700 });
    const clock = fixedClock(NOW);
    const sp = storePath(cache);
    const dd = datasetDir(cache);
    const store = storeFactory.open({
      path: sp,
      datasetDir: dd,
      backupDir: backupDir(cache),
      clock,
      migrate: true,
    });
    const publisher = storeFactory.openPublisher({ storePath: sp, datasetDir: dd, clock });
    const c = makeCtx([2026], { routes });
    open.push(c);
    const deps = {
      http: c.ctx.http,
      download: c.ctx.download,
      clock,
      rng: seededRng(1),
      publisher,
      refreshLog: store.repos.refreshLog,
      proSchedule,
      temp: fsTempArea(path.join(cache, "tmp")),
      sleep: () => Promise.resolve(),
    };
    return {
      deps,
      calls: c.calls,
      close: () => {
        publisher.close();
        store.close();
      },
    };
  }

  it("each current source publishes its dataset file; a rerun is unchanged after one stamp request", async () => {
    const w = world(inSeason);
    try {
      for (const source of CURRENT) {
        const res = await runRefresh({ source, seasons: [2026], week: null }, w.deps);
        expect(res.status, source.id).toBe("published");
        if (res.status !== "published") continue;
        expect(res.stats.columns_hash).toBe(contractColumnsHash(source.id));
        const db = new DatabaseSync(res.file, { readOnly: true });
        try {
          const meta = Object.fromEntries(
            (
              db.prepare("SELECT key, value FROM dataset_meta").all() as {
                key: string;
                value: string;
              }[]
            ).map((m) => [m.key, m.value]),
          );
          expect(meta.source).toBe(source.id);
          expect(meta.columns_hash).toBe(contractColumnsHash(source.id));
          expect(JSON.parse(meta.seasons ?? "[]")).toEqual([2026]);
        } finally {
          db.close();
        }
        const before = w.calls.length;
        const again = await runRefresh({ source, seasons: [2026], week: null }, w.deps);
        expect(again.status, source.id).toBe("unchanged");
        expect(w.calls.length - before, source.id).toBe(1); // timestamp.txt only
      }
    } finally {
      w.close();
    }
  });

  it("outside the season every current source exits (skipped) in < 2 s with no request (B1)", async () => {
    const offSeason: ProScheduleReader = {
      ...inSeason,
      games: (season) => ({
        rows: [proGame(season, 1, "2026-09-10T00:20:00.000Z")].map((g) => ({
          ...g,
          kickoff: "2026-01-04T18:00:00.000Z",
        })),
        stamp: inSeason.games(season, null).stamp,
      }),
    };
    const w = world(offSeason);
    try {
      for (const source of CURRENT) {
        const t0 = performance.now();
        const res = await runRefresh({ source, seasons: [2026], week: null }, w.deps);
        expect(res, source.id).toMatchObject({ status: "skipped", reason: "off_season" });
        expect(performance.now() - t0).toBeLessThan(2000);
      }
      expect(w.calls).toEqual([]);
    } finally {
      w.close();
    }
  });

  it("a renamed column fails the run NAMING it; the previous file stays (B1)", async () => {
    const renamed = new Map(ROUTES);
    renamed.set(
      P2["nflverse:pbp@2026"]?.f.url ?? "",
      rewritePhase2("nflverse:pbp@2026", { rename: { kick_distance: "kick_dist" } }),
    );
    const w = world(inSeason, renamed);
    try {
      const res = await runRefresh({ source: pbpSource, seasons: [2026], week: null }, w.deps);
      expect(res.status).toBe("failed");
      if (res.status !== "failed") return;
      expect(res.source_error).toBe("schema_mismatch");
      expect(res.message).toContain("kick_distance");
      expect(res.schema?.missing_columns).toEqual(["kick_distance"]);
    } finally {
      w.close();
    }
  });
});
