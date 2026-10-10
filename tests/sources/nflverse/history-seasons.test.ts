// history-seasons.test.ts — the historical season selection (plan 10 §3.3 "≥ 3 historical seasons"
// [A-3]; D9 "≥ 3 in Phase 3"; plan 01 §5.5 per-source files published whole; src/sources/nflverse/
// seasons.ts, phase2.ts `historyFileSeasons`, schedules.ts): every history file and the schedules file
// hold the backtest seasons [current − 3, current − 1] whatever a run names — the CLI's two-season
// default, a one-off `--seasons` — so a refresh never shrinks what the held-out backtests read; the
// third season (2023, fixtures/history/) goes through version → fetch → schema + codec assertion →
// publish exactly like the other two, through the REAL runner and publisher too; a 2023 file that
// drifts (a renamed column, a foreign codec) fails naming it; 2023's INT32 `goal_to_go` (DOUBLE from
// 2024) is stored as the same 0/1 flag. Adversarial by default; properties with fast-check. No network.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { backupDir, datasetDir, storePath } from "../../../src/config/paths.js";
import type { ProScheduleReader } from "../../../src/domain/analytics/types.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import { epWeeklyHistorySource } from "../../../src/sources/ffopportunity/index.js";
import {
  NFLVERSE_HISTORY_SOURCES,
  backtestSeasons,
  gameLines,
  historyFileSeasons,
  historyVersion,
  schedulesSource,
  withBacktestContext,
  withBacktestSeasons,
  type HistoryDataSource,
  type NflversePublishStats,
  type NflverseSchemaReport,
} from "../../../src/sources/nflverse/index.js";
import { MAX_SEASON, MIN_SEASON } from "../../../src/sources/nflverse/release.js";
import { fsTempArea, runRefresh } from "../../../src/sources/runner.js";
import type { DataSource, TempFile } from "../../../src/sources/source.js";
import { impliedPoints } from "../../../src/store/datasets/derive.js";
import {
  BACKTEST_SEASON_COUNT,
  HISTORY_SEASON_COUNT,
  PHASE_2_READER_QUERIES,
  backtestSeasonsFor,
  contractColumnsHash,
  historySeasonsFor,
  type Phase2ReaderMethod,
} from "../../../src/store/datasets/tables.js";
import { storeFactory } from "../../../src/store/index.js";
import { REL } from "./helpers/fixtures.js";
import { SqliteWriter, makeCtx, proGame, type Ctx, type Route } from "./helpers/harness.js";
import {
  GAME_2023,
  H,
  hFixture,
  hRows,
  historyFixtureRoutes,
  historyManifest,
} from "./helpers/history-fixtures.js";
import { allFixtureRoutes, historyRunRoutes } from "./helpers/phase2-fixtures.js";
import { rewriteHistory } from "./helpers/phase2-rewrite.js";
import { tempFile } from "./helpers/rewrite.js";

const NOW = "2026-10-06T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const HELD = [2023, 2024, 2025] as const;
const HISTORY: readonly HistoryDataSource[] = [
  ...Object.values(NFLVERSE_HISTORY_SOURCES),
  epWeeklyHistorySource,
];
/** The 2023 release file each history twin asks for (the Phase-1 twins read their tags' files). */
const FILE_2023: Readonly<Record<string, string>> = {
  "nflverse:stats_player_week_history": `${REL}/stats_player/stats_player_week_2023.parquet`,
  "nflverse:stats_team_week_history": `${REL}/stats_team/stats_team_week_2023.parquet`,
  "nflverse:pbp_history": `${REL}/pbp/play_by_play_2023.parquet`,
  "nflverse:snap_counts_history": `${REL}/snap_counts/snap_counts_2023.parquet`,
  "nflverse:injuries_history": `${REL}/injuries/injuries_2023.parquet`,
  "nflverse:depth_charts_history": `${REL}/depth_charts/depth_charts_2023.parquet`,
  "ffopportunity:ep_weekly_history":
    "https://github.com/ffverse/ffopportunity/releases/download/latest-data/ep_weekly_2023.parquet",
};
/** The fixture key of each twin's 2023 excerpt. */
const KEY_2023: Readonly<Record<string, string>> = {
  "nflverse:stats_player_week_history": "nflverse:stats_player_week@2023",
  "nflverse:stats_team_week_history": "nflverse:stats_team_week@2023",
  "nflverse:pbp_history": "nflverse:pbp@2023",
  "nflverse:snap_counts_history": "nflverse:snap_counts@2023",
  "nflverse:injuries_history": "nflverse:injuries@2023",
  "nflverse:depth_charts_history": "nflverse:depth_charts@2023",
  "ffopportunity:ep_weekly_history": "ffopportunity:ep_weekly@2023",
};

const open: Ctx[] = [];
const writers: SqliteWriter[] = [];
afterEach(() => {
  for (const w of writers.splice(0)) w.close();
  for (const c of open.splice(0)) c.cleanup();
});
const ctxOf = (seasons: readonly number[], o: Parameters<typeof makeCtx>[1] = {}): Ctx => {
  const c = makeCtx(seasons, { routes: historyRunRoutes(), ...o });
  open.push(c);
  return c;
};

async function run(
  source: DataSource | HistoryDataSource,
  seasons: readonly number[],
  routes: ReadonlyMap<string, Route> = historyRunRoutes(),
): Promise<{
  c: Ctx;
  w: SqliteWriter;
  files: readonly TempFile[];
  report: NflverseSchemaReport;
  stats: NflversePublishStats;
  version: string;
}> {
  const c = ctxOf(seasons, { routes });
  const v = await source.version(c.ctx);
  if (v === null) throw new Error("no version");
  const files = await source.fetch(v, c.ctx);
  const report = (await source.assertSchema(files)) as NflverseSchemaReport;
  expect(report.ok, report.warnings.join("\n")).toBe(true);
  const w = new SqliteWriter(c.tempDir);
  writers.push(w);
  const stats = (await source.publish(files, w)) as NflversePublishStats;
  return { c, w, files, report, stats, version: v.version };
}

const sqlOf = (m: Phase2ReaderMethod, i = 0): string => {
  const s = PHASE_2_READER_QUERIES[m].statements[i];
  if (!s) throw new Error(`${m} has no statement ${String(i)}`);
  return s.sql;
};

// --- the selection itself -----------------------------------------------------------------------------

describe("backtest seasons (tables.ts backtestSeasonsFor, seasons.ts)", () => {
  it("three seasons from Phase 3 on; Phase 2's two stay its record", () => {
    expect(BACKTEST_SEASON_COUNT).toBe(3);
    expect(HISTORY_SEASON_COUNT).toBe(2);
    expect(backtestSeasonsFor(2026)).toEqual([2023, 2024, 2025]);
    expect(Object.isFrozen(backtestSeasonsFor(2026))).toBe(true);
    // Phase 2's seasons are the newest two of Phase 3's (property)
    fc.assert(
      fc.property(fc.integer({ min: 2001, max: 2999 }), (c) => {
        expect(backtestSeasonsFor(c).slice(-HISTORY_SEASON_COUNT)).toEqual(historySeasonsFor(c));
      }),
    );
  });

  it("[current − 3, current − 1]: consecutive, ascending, all before current (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2001, max: 2999 }), (c) => {
        const s = backtestSeasonsFor(c);
        expect(s).toHaveLength(BACKTEST_SEASON_COUNT);
        expect(s.at(-1)).toBe(c - 1);
        s.forEach((x, i) => {
          expect(x).toBe(c - BACKTEST_SEASON_COUNT + i);
          expect(x).toBeLessThan(c);
        });
      }),
    );
  });

  it("refuses a season the contract cannot place", () => {
    for (const bad of [2000, 3000, 2026.5, Number.NaN, Number.POSITIVE_INFINITY, -1])
      expect(() => backtestSeasonsFor(bad), String(bad)).toThrow(RangeError);
  });

  it("follows the run's clock with the July rollover; an unplaceable clock has no floor", () => {
    expect(backtestSeasons(NOW_MS)).toEqual([2023, 2024, 2025]);
    expect(backtestSeasons(Date.parse("2027-06-30T23:59:59Z"))).toEqual([2023, 2024, 2025]);
    expect(backtestSeasons(Date.parse("2027-07-01T00:00:00Z"))).toEqual([2024, 2025, 2026]);
    // nflverse starts in 1999: the 2001 season's floor is cut there
    expect(backtestSeasons(Date.parse("2001-09-01T00:00:00Z"))).toEqual([1999, 2000]);
    for (const bad of [0, Date.parse("2000-12-01T00:00:00Z"), Number.NaN, Infinity])
      expect(backtestSeasons(bad), String(bad)).toEqual([]);
  });

  it("withBacktestSeasons: the run's seasons ∪ the floor, ascending, unique; empty stays empty (property)", () => {
    const clock = fc.integer({
      min: Date.parse("2001-07-01T00:00:00Z"),
      max: Date.parse("2099-06-30T00:00:00Z"),
    });
    const seasons = fc.array(fc.integer({ min: MIN_SEASON, max: MAX_SEASON }), { maxLength: 8 });
    fc.assert(
      fc.property(clock, seasons, (now, run) => {
        const out = withBacktestSeasons(run, now);
        if (run.length === 0) {
          expect(out).toEqual([]);
          return;
        }
        for (const s of run) expect(out).toContain(s);
        for (const s of backtestSeasons(now)) expect(out).toContain(s);
        for (let i = 1; i < out.length; i++) expect(out[i]!).toBeGreaterThan(out[i - 1]!);
        // nothing but the run's seasons and the floor
        const allowed = new Set([...run, ...backtestSeasons(now)]);
        for (const s of out) expect(allowed.has(s)).toBe(true);
        expect(Object.isFrozen(out)).toBe(true);
      }),
    );
  });

  it("withBacktestSeasons refuses a malformed season (it never reaches a URL)", () => {
    for (const bad of [1998, 2101, 2025.5, Number.NaN])
      expect(() => withBacktestSeasons([2026, bad], NOW_MS), String(bad)).toThrow(
        /a season must be an integer/,
      );
  });

  it("withBacktestContext widens the seasons only", () => {
    const c = ctxOf([2026]);
    const w = withBacktestContext(c.ctx);
    expect(w.seasons).toEqual([2023, 2024, 2025, 2026]);
    expect({ ...w, seasons: c.ctx.seasons }).toEqual(c.ctx);
    expect(c.ctx.seasons).toEqual([2026]); // the caller's context is not mutated
  });
});

describe("historyFileSeasons: what a history file holds after a run", () => {
  const id = "nflverse:pbp_history";
  it("the CLI's two-season default, a one-off season and the full set all hold the three", () => {
    for (const run of [[2024, 2025], [2025, 2024], [2024], [2023], [2023, 2024, 2025]])
      expect(historyFileSeasons(id, ctxOf(run).ctx), String(run)).toEqual(HELD);
  });

  it("an explicit older season adds to them; the same set gives the same version (no re-download)", () => {
    expect(historyFileSeasons(id, ctxOf([2019]).ctx)).toEqual([2019, 2023, 2024, 2025]);
    const versions = new Set(
      [[2024, 2025], [2023], [2025, 2023, 2024]].map(
        (s) => historyVersion(id, ctxOf(s).ctx).version,
      ),
    );
    expect([...versions]).toEqual(["h2026-10_2023-2024-2025"]);
  });

  it("still refuses the current season (or later) before any floor applies", () => {
    for (const bad of [[2026], [2024, 2026], [2027]])
      expect(() => historyFileSeasons(id, ctxOf(bad).ctx), String(bad)).toThrow(
        /prior seasons only/,
      );
  });

  it("an empty run stays empty", () => {
    expect(historyFileSeasons(id, ctxOf([]).ctx)).toEqual([]);
  });
});

// --- every history twin over the three fixture seasons ---------------------------------------------------

describe("every history twin loads the third season (fixtures/history/)", () => {
  it("version: h<month>_2023-2024-2025 from the CLI default, no request", async () => {
    for (const h of HISTORY) {
      const c = ctxOf([2024, 2025], { routes: new Map() });
      expect(await h.version(c.ctx), h.id).toEqual({
        version: "h2026-10_2023-2024-2025",
        released_at: null,
      });
      expect(c.calls, h.id).toEqual([]);
    }
  });

  it("fetch asks for exactly the three season files, oldest first, no stamp", async () => {
    for (const h of HISTORY) {
      const c = ctxOf([2025, 2024]);
      const files = await h.fetch({ version: "v", released_at: null }, c.ctx);
      expect(
        files.map((f) => f.season),
        h.id,
      ).toEqual(HELD);
      const want = FILE_2023[h.id] ?? "";
      expect(c.calls, h.id).toEqual(HELD.map((s) => want.replace("2023", String(s))));
    }
  });

  it("schema + codec assertion passes for each season; publish holds rows of all three", async () => {
    for (const h of HISTORY) {
      const r = await run(h, [2024, 2025]);
      expect(
        r.report.files.map((f) => f.season),
        h.id,
      ).toEqual(HELD);
      expect(r.report.error, h.id).toBeNull();
      expect(r.stats.seasons, h.id).toEqual(HELD);
      expect(r.stats.columns_hash, h.id).toBe(contractColumnsHash(h.id));
      const key = KEY_2023[h.id] ?? "";
      expect(r.report.files[0]?.rows, h.id).toBe(hFixture(key).rows);
    }
  });

  it("a missing 2023 file fails the run (a past season is never 'not published')", async () => {
    for (const h of HISTORY) {
      const routes = historyRunRoutes();
      routes.delete(FILE_2023[h.id] ?? "");
      const c = ctxOf([2024, 2025], { routes });
      await expect(h.fetch({ version: "v", released_at: null }, c.ctx), h.id).rejects.toMatchObject(
        { status: 404 },
      );
      expect(c.unpublished, h.id).toEqual([]);
    }
  });

  it("an explicit older season the release lacks fails the run too, never silently dropped", async () => {
    const c = ctxOf([2019]);
    await expect(
      NFLVERSE_HISTORY_SOURCES["nflverse:snap_counts_history"].fetch(
        { version: "v", released_at: null },
        c.ctx,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(c.calls[0]).toBe(`${REL}/snap_counts/snap_counts_2019.parquet`);
  });

  it("a 2023 file with a renamed column fails the assertion NAMING it, under the history id", async () => {
    const cases: [string, string, string][] = [
      ["nflverse:pbp_history", "nflverse:pbp@2023", "goal_to_go"],
      ["nflverse:snap_counts_history", "nflverse:snap_counts@2023", "offense_pct"],
      ["ffopportunity:ep_weekly_history", "ffopportunity:ep_weekly@2023", "rush_attempt"],
      ["nflverse:stats_player_week_history", "nflverse:stats_player_week@2023", "targets"],
      ["nflverse:injuries_history", "nflverse:injuries@2023", "report_status"],
      ["nflverse:depth_charts_history", "nflverse:depth_charts@2023", "depth_team"],
    ];
    for (const [id, key, col] of cases) {
      const h = HISTORY.find((x) => x.id === id)!;
      const c = ctxOf([]);
      const bytes = rewriteHistory(key, { rename: { [col]: `${col}_v2` } });
      const report = (await h.assertSchema([
        tempFile(c.tempDir, "2023.parquet", bytes, 2023),
      ])) as NflverseSchemaReport;
      expect(report.ok, id).toBe(false);
      expect(report.error, id).toBe("schema_mismatch");
      expect(report.missing_columns, id).toContain(col);
      expect(report.warnings.join("\n"), id).toContain(`${id}: missing or renamed column(s)`);
      // publish never trusts the assertion: the same file throws before a row is handed out
      const w = new SqliteWriter(c.tempDir);
      writers.push(w);
      await expect(
        h.publish([tempFile(c.tempDir, "p.parquet", bytes, 2023)], w),
        id,
      ).rejects.toThrow();
    }
  });

  it("a 2023 file with a foreign codec label fails as 'codec'", async () => {
    const h = NFLVERSE_HISTORY_SOURCES["nflverse:stats_team_week_history"];
    const c = ctxOf([]);
    const bytes = rewriteHistory("nflverse:stats_team_week@2023", { codec: { team: "ZSTD" } });
    const report = (await h.assertSchema([
      tempFile(c.tempDir, "2023.parquet", bytes, 2023),
    ])) as NflverseSchemaReport;
    expect(report.ok).toBe(false);
    expect(report.error).toBe("codec");
    expect(report.bad_codecs).toEqual([{ column: "team", codec: "ZSTD" }]);
  });

  it("a 2023 row labelled with another season is dropped and counted, never stored as 2023", async () => {
    const h = NFLVERSE_HISTORY_SOURCES["nflverse:snap_counts_history"];
    const c = ctxOf([]);
    const rows = hRows("nflverse:snap_counts@2023");
    const bytes = rewriteHistory("nflverse:snap_counts@2023", {
      rows: (r) => r.map((x, i) => (i === 0 ? { ...x, season: 2024 } : x)),
    });
    const w = new SqliteWriter(c.tempDir);
    writers.push(w);
    const stats = (await h.publish(
      [tempFile(c.tempDir, "2023.parquet", bytes, 2023)],
      w,
    )) as NflversePublishStats;
    expect(stats.tables).toEqual([{ name: "ds_snap_counts", rows: rows.length - 1 }]);
    expect(stats.warnings.join("\n")).toContain("season differs from the file's season");
    expect(w.all("SELECT DISTINCT season FROM ds_snap_counts")).toEqual([{ season: 2023 }]);
  });
});

describe("the third season's data, as the backtests will read it", () => {
  it("pbp: 2023's goal_to_go is INT32 upstream (DOUBLE from 2024) and lands as the same 0/1 flag", async () => {
    const f = hFixture("nflverse:pbp@2023");
    expect(f.schema.find((c) => c.name === "goal_to_go")?.type).toBe("INT32");
    const r = await run(NFLVERSE_HISTORY_SOURCES["nflverse:pbp_history"], [2024, 2025]);
    const got = r.w.all(
      "SELECT goal_to_go AS g, COUNT(*) AS n FROM ds_pbp WHERE season = 2023 GROUP BY 1 ORDER BY 1",
    );
    const kept = hRows("nflverse:pbp@2023").filter(
      (x) => typeof x.play_type === "string" && !["no_play"].includes(x.play_type),
    );
    const upstream = (v: number) => kept.filter((x) => x.goal_to_go === v).length;
    expect(got).toEqual([
      { g: 0, n: upstream(0) },
      { g: 1, n: upstream(1) },
    ]);
    expect(upstream(1)).toBeGreaterThan(0);
    // the same column of 2024 (DOUBLE upstream) stores the same two values
    expect(
      r.w.all("SELECT DISTINCT goal_to_go AS g FROM ds_pbp WHERE season = 2024 ORDER BY 1"),
    ).toEqual([{ g: 0 }, { g: 1 }]);
  });

  it("pbp: an out-of-range INT32 goal_to_go is NULL, never a flag (flag01)", async () => {
    const h = NFLVERSE_HISTORY_SOURCES["nflverse:pbp_history"];
    const c = ctxOf([]);
    const bytes = rewriteHistory("nflverse:pbp@2023", {
      rows: (rows) =>
        rows.map((x) => ({ ...x, goal_to_go: x.goal_to_go === 1 ? 2 : x.goal_to_go })),
    });
    const w = new SqliteWriter(c.tempDir);
    writers.push(w);
    await h.publish([tempFile(c.tempDir, "2023.parquet", bytes, 2023)], w);
    expect(w.all("SELECT COUNT(*) AS n FROM ds_pbp WHERE goal_to_go = 1")).toEqual([{ n: 0 }]);
    expect(
      (w.all("SELECT COUNT(*) AS n FROM ds_pbp WHERE goal_to_go IS NULL")[0] as { n: number }).n,
    ).toBeGreaterThan(0);
  });

  it("pbp: free text never reaches the history file (desc is read by nobody)", async () => {
    expect(hFixture("nflverse:pbp@2023").schema.map((c) => c.name)).toContain("desc");
    const r = await run(NFLVERSE_HISTORY_SOURCES["nflverse:pbp_history"], [2024, 2025]);
    const cols = r.w.all("SELECT name FROM pragma_table_info('ds_pbp')").map((x) => x.name);
    expect(cols).not.toContain("desc");
    expect(r.report.extra_columns).toContain("desc");
  });

  it("the Phase-2 reader statements answer for 2023 from the history file", async () => {
    const snaps = await run(NFLVERSE_HISTORY_SOURCES["nflverse:snap_counts_history"], [2024, 2025]);
    const pfr = hRows("nflverse:snap_counts@2023").map((x) => String(x.pfr_player_id));
    expect(
      snaps.w.db
        .prepare(sqlOf("SnapCountReader.counts", 2))
        .all({ season: 2023, weeks: "[9]", pfr_ids: JSON.stringify(pfr) }),
    ).toHaveLength(new Set(pfr).size);
    const ep = await run(epWeeklyHistorySource, [2024, 2025]);
    const ids = hRows("ffopportunity:ep_weekly@2023")
      .filter((x) => x.player_id !== null)
      .map((x) => String(x.player_id));
    const rows = ep.w.db
      .prepare(sqlOf("EpWeeklyReader.rows"))
      .all({ season: 2023, weeks: "[9]", gsis_ids: JSON.stringify(ids) });
    expect(rows).toHaveLength(ids.length);
    expect(new Set(rows.map((x) => x.game_id))).toEqual(new Set([GAME_2023]));
    const pbp = await run(NFLVERSE_HISTORY_SOURCES["nflverse:pbp_history"], [2024, 2025]);
    const profile = pbp.w.db
      .prepare(sqlOf("PbpReader.teamProfile"))
      .all({ season: 2023, weeks: "[9]", teams: '["BUF","CIN"]' });
    expect(profile.length).toBeGreaterThan(0);
  });

  it("stats_player_week + the derived defence lines carry 2023's week 9 for both game teams", async () => {
    const r = await run(
      NFLVERSE_HISTORY_SOURCES["nflverse:stats_player_week_history"],
      [2024, 2025],
    );
    expect(
      r.w.all(
        "SELECT team FROM ds_team_defense_week WHERE season = 2023 AND week = 9 AND team IN ('BUF','CIN') ORDER BY team",
      ),
    ).toEqual([{ team: "BUF" }, { team: "CIN" }]);
    const players = hRows("nflverse:stats_player_week@2023").filter((x) => x.player_id !== null);
    expect(
      (
        r.w.all("SELECT COUNT(*) AS n FROM ds_stats_player_week WHERE season = 2023")[0] as {
          n: number;
        }
      ).n,
    ).toBe(players.length);
  });

  it("injuries 2023 (no season_type, as 2024) loads under the Phase-1 loader", async () => {
    expect(hFixture("nflverse:injuries@2023").schema.map((c) => c.name)).not.toContain(
      "season_type",
    );
    const r = await run(NFLVERSE_HISTORY_SOURCES["nflverse:injuries_history"], [2024, 2025]);
    expect(
      r.w.all("SELECT COUNT(*) AS n FROM ds_injuries WHERE season = 2023 AND week = 9"),
    ).toEqual([{ n: hFixture("nflverse:injuries@2023").rows }]);
  });
});

// --- schedules (one file, every season) ----------------------------------------------------------------

describe("nflverse:schedules holds the backtest seasons' games and lines", () => {
  it("a [2026] run stores 2023's games with lines from the one games.parquet download", async () => {
    const r = await run(schedulesSource, [2026], allFixtureRoutes());
    expect(r.files.map((f) => f.season)).toEqual([2023, 2024, 2025, 2026]);
    expect(r.c.calls.filter((u) => u.endsWith("games.parquet"))).toHaveLength(1);
    expect(r.version).toMatch(/^\d{8}T\d{6}Z_2023-2024-2025-2026$/);
    const raw = hRows("nflverse:schedules@2023");
    const got = r.w.all("SELECT * FROM ds_schedules WHERE season = 2023 ORDER BY game_id");
    expect(got).toHaveLength(raw.length);
    expect(got.map((g) => g.game_id)).toContain(GAME_2023);
    for (const g of got) {
      const l = gameLines(g);
      expect(l, String(g.game_id)).not.toBeNull();
      if (l?.spread_line == null || l.total_line === null) continue;
      expect(l.implied).toEqual(impliedPoints(l.spread_line, l.total_line));
      expect(g.kickoff_utc, String(g.game_id)).not.toBeNull();
      expect(g.venue_id, String(g.game_id)).not.toBeNull();
    }
    expect(r.stats.seasons).toEqual([2023, 2025, 2026]);
  });

  it("the version moves when the floor grows (a new current season republishes)", async () => {
    const a = ctxOf([2026], { routes: allFixtureRoutes() });
    const b = ctxOf([2027], { routes: allFixtureRoutes(), now: "2027-08-01T12:00:00.000Z" });
    const va = await schedulesSource.version(a.ctx);
    const vb = await schedulesSource.version(b.ctx);
    expect(va?.version.endsWith("_2023-2024-2025-2026")).toBe(true);
    expect(vb?.version.endsWith("_2024-2025-2026-2027")).toBe(true);
  });

  it("a malformed run season rejects (never a synchronous throw); no seasons → no request", async () => {
    const c = ctxOf([2026.5], { routes: allFixtureRoutes() });
    const pv = schedulesSource.version(c.ctx);
    await expect(pv).rejects.toThrow(/a season must be an integer/);
    await expect(schedulesSource.fetch({ version: "v", released_at: null }, c.ctx)).rejects.toThrow(
      /a season must be an integer/,
    );
    const none = ctxOf([], { routes: allFixtureRoutes() });
    expect(await schedulesSource.fetch({ version: "v", released_at: null }, none.ctx)).toEqual([]);
    expect(none.calls).toEqual([]);
  });
});

// --- through the REAL runner and publisher (the `eff refresh` path) ------------------------------------------

describe("through the REAL runner and publisher", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });
  const stampOf = { source: "espn:pro_schedule", as_of: NOW, fetched_at: NOW, checked_at: NOW };
  const inSeason: ProScheduleReader = {
    games: (season) => ({
      rows: [proGame(season, 5, "2026-10-08T00:15:00.000Z")],
      stamp: { ...stampOf, freshness_class: "espn_pro_schedule", file_version: "v" } as never,
    }),
    teams: () => ({ rows: [], stamp: null }),
  };

  function world(now: string) {
    const root = mkdtempSync(path.join(tmpdir(), "eff-h3-runner-"));
    roots.push(root);
    const cache = path.join(root, "cache");
    mkdirSync(cache, { mode: 0o700 });
    const clock = fixedClock(now);
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
    const c = ctxOf([2026], { routes: historyRunRoutes(), now });
    const deps = {
      http: c.ctx.http,
      download: c.ctx.download,
      clock,
      rng: seededRng(1),
      publisher,
      refreshLog: store.repos.refreshLog,
      proSchedule: inSeason,
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

  it("each twin publishes a file holding 2023–2025 from the CLI default; a rerun is unchanged with no request", async () => {
    const w = world(NOW);
    try {
      for (const h of HISTORY) {
        const source = h as unknown as DataSource;
        const res = await runRefresh({ source, seasons: [2024, 2025], week: null }, w.deps);
        expect(res.status, h.id).toBe("published");
        if (res.status !== "published") continue;
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
          expect(meta.source, h.id).toBe(h.id);
          expect(JSON.parse(meta.seasons ?? "[]"), h.id).toEqual(HELD);
          expect(meta.columns_hash, h.id).toBe(contractColumnsHash(h.id));
        } finally {
          db.close();
        }
        // the same month: unchanged, with NO request — whether the run names two seasons or three
        for (const seasons of [
          [2024, 2025],
          [2023, 2024, 2025],
        ]) {
          const before = w.calls.length;
          const again = await runRefresh({ source, seasons, week: null }, w.deps);
          expect(again.status, `${h.id} ${String(seasons)}`).toBe("unchanged");
          expect(w.calls.length - before, h.id).toBe(0);
        }
      }
    } finally {
      w.close();
    }
  });
});

describe("the fixtures are what the generator says (fixtures/history/manifest.json)", () => {
  it("one excerpt per history dataset plus the schedules week, all 2023, all served", () => {
    expect(historyManifest.backtest_seasons).toEqual(HELD);
    expect(Object.keys(H).sort()).toEqual(
      [...Object.values(KEY_2023), "nflverse:schedules@2023"].sort(),
    );
    const routes = historyFixtureRoutes();
    for (const f of historyManifest.files) {
      expect(f.season, f.path).toBe(2023);
      expect(routes.has(f.url), f.url).toBe(true);
    }
  });
});
