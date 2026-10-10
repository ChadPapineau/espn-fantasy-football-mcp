// sources.test.ts — every nflverse DataSource end to end on the fixture excerpts (plan 05 §2
// `sources/*`; plan 10 §3.1a): version from timestamp.txt → fetch through a fake HttpGet/HttpDownload
// serving parquet rebuilt from fixtures/nflverse → assertSchema → publish into a real STRICT SQLite
// DatasetWriter, then the store's own reader SQL (tables.ts READER_QUERIES) over the published file.
// The schedules' ESPN game ids join the recorded proTeamSchedules_wl exactly. No network. Phase 3
// (plan 10 §3.3, D9): the schedules file always holds the backtest seasons [current − 3, current − 1]
// besides the run's own (seasons.ts) — at the fixed clock (2026-10-06) 2023–2025; the Phase-1 games
// excerpt holds 2025 and 2026, so a [2026] run also stores 2025's games.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { SOURCE_REGISTRY } from "../../../src/config/freshness.js";
import { impliedPoints } from "../../../src/store/datasets/derive.js";
import {
  NFLVERSE_SOURCES,
  gameLines,
  injuriesSource,
  playersSource,
  rosterWeeklySource,
  schedulesSource,
  statsPlayerWeekSource,
  type NflversePublishStats,
  type NflverseSchemaReport,
} from "../../../src/sources/nflverse/index.js";
import { SOURCE_RATE_LIMITS, type DataSource, type TempFile } from "../../../src/sources/source.js";
import { GAME_VENUE_OVERRIDES, VENUES } from "../../../src/sources/venues.js";
import { DATASET_TABLES, READER_QUERIES, columnsHash } from "../../../src/store/datasets/tables.js";
import { FX, REL, fixtureRows, fixtureRoutes, manifest } from "./helpers/fixtures.js";
import { SqliteWriter, makeCtx, type Ctx } from "./helpers/harness.js";

interface RosterPlayer {
  espn_id: number;
  espn_name: string;
  gsis_id: string;
  nflverse_name: string;
  position: string;
  team: string;
  jersey: number | null;
  sleeper_id: string | null;
  pfr_id: string | null;
  status: string;
  roster_week: number | null;
  id_source: string;
  stat_weeks: number[];
  tags: string[];
}
const roster = JSON.parse(
  readFileSync(new URL("../../../fixtures/players/fixture-roster.json", import.meta.url), "utf8"),
) as {
  players: RosterPlayer[];
  team_units: { kind: string; team: string }[];
  decoys: { gsis_id: string; espn_id: number; nflverse_name: string }[];
};
const inRoster = roster.players.filter((p) => p.id_source === "nflverse:roster_weekly");

const open: Ctx[] = [];
const writers: SqliteWriter[] = [];
afterEach(() => {
  for (const w of writers.splice(0)) w.close();
  for (const c of open.splice(0)) c.cleanup();
});

interface Run {
  c: Ctx;
  files: readonly TempFile[];
  report: NflverseSchemaReport;
  stats: NflversePublishStats;
  w: SqliteWriter;
}

async function run(source: DataSource, seasons: readonly number[]): Promise<Run> {
  const c = makeCtx(seasons);
  open.push(c);
  const version = await source.version(c.ctx);
  if (version === null) throw new Error("fixture version unreachable");
  const files = await source.fetch(version, c.ctx);
  const report = (await source.assertSchema(files)) as NflverseSchemaReport;
  expect(report.ok, report.warnings.join("\n")).toBe(true);
  expect(report.error).toBeNull();
  const w = new SqliteWriter(c.tempDir);
  writers.push(w);
  const stats = (await source.publish(files, w)) as NflversePublishStats;
  return { c, files, report, stats, w };
}

const n = (w: SqliteWriter, sql: string, ...p: (string | number)[]): number =>
  Number(w.all(sql, ...p)[0]?.n);

describe("registry fields (plan 05 §2 `sources/*`: license, attribution, job, limiter)", () => {
  it("every source carries its SOURCE_REGISTRY row, CC-BY 4.0 and the contract's tables", () => {
    expect(Object.keys(NFLVERSE_SOURCES).sort()).toEqual([
      "nflverse:injuries",
      "nflverse:players",
      "nflverse:roster_weekly",
      "nflverse:schedules",
      "nflverse:stats_player_week",
    ]);
    for (const [id, s] of Object.entries(NFLVERSE_SOURCES)) {
      const info = SOURCE_REGISTRY[s.id];
      expect(s.id).toBe(id);
      expect(s.license).toBe("CC-BY-4.0");
      expect(s.attribution).toBe(info.attribution);
      expect(s.attribution.url).toBe("https://github.com/nflverse/nflverse-data");
      expect(s.freshness).toBe(info.freshness);
      expect(s.job).toBe(info.job);
      expect(s.versioning).toBe("release");
      expect(s.limiter).toBe(SOURCE_RATE_LIMITS.github_release);
      expect(s.tables).toBe(DATASET_TABLES[id as keyof typeof DATASET_TABLES]);
      expect(Object.isFrozen(s)).toBe(true);
    }
    expect(schedulesSource.seasonGate).toBe("always");
    expect(rosterWeeklySource.seasonGate).toBe("always");
    expect(playersSource.seasonGate).toBe("always");
    expect(injuriesSource.seasonGate).toBe("in_season");
    expect(statsPlayerWeekSource.seasonGate).toBe("in_season");
  });
});

describe("nflverse:schedules", () => {
  it("publishes the 2026 games: ESPN ids, DST-aware kickoffs, roof, venues, lines", async () => {
    const { report, stats, w, files, c } = await run(schedulesSource, [2026]);
    // the run's season plus the backtest seasons, from ONE download
    expect(files.map((f) => f.season)).toEqual([2023, 2024, 2025, 2026]);
    expect(c.calls).toEqual([`${REL}/schedules/timestamp.txt`, `${REL}/schedules/games.parquet`]);
    expect(report.extra_columns).toContain("referee"); // not kept, tolerated, reported
    expect(report.files).toEqual(
      [2023, 2024, 2025, 2026].map((season) => ({
        season,
        rows: 557,
        nflverse_timestamp: "2026-10-06 01:46:36 EDT",
      })),
    );
    expect(stats.tables).toEqual([
      { name: "ds_schedules", rows: 272 + 285 },
      { name: "ds_venues", rows: VENUES.length },
    ]);
    expect(stats.seasons).toEqual([2025, 2026]);
    expect(stats.columns_hash).toBe(columnsHash("nflverse:schedules"));
    expect(stats.warnings).toEqual([]);
    expect(
      n(w, "SELECT COUNT(*) AS n FROM ds_schedules WHERE typeof(espn_game_id) <> 'integer'"),
    ).toBe(0);
    const k = (id: string): unknown =>
      w.all("SELECT kickoff_utc FROM ds_schedules WHERE game_id = ?", id)[0]?.kickoff_utc;
    // Fall-back weekend (DST ends 2026-11-01): Sunday 13:00 EST = 18:00Z; Monday 20:15 EST next day.
    expect(k("2026_08_BAL_BUF")).toBe("2026-11-01T18:00:00.000Z");
    expect(k("2026_08_CHI_SEA")).toBe("2026-11-03T01:15:00.000Z");
    expect(k("2026_08_CAR_GB")).toBe("2026-10-30T00:15:00.000Z"); // Thursday, still EDT
    expect(k("2026_01_SF_LA")).toBe("2026-09-11T00:35:00.000Z"); // Melbourne, 20:35 ET
    // the mis-coded London JAX home game and an override game resolve to the real venue
    expect(
      w.all("SELECT stadium_id, venue_id FROM ds_schedules WHERE game_id = '2026_05_PHI_JAX'")[0],
    ).toEqual({
      stadium_id: "JAX00",
      venue_id: "LON02",
    });
    expect(n(w, "SELECT COUNT(*) AS n FROM ds_schedules WHERE roof = ''")).toBe(0);
    expect(
      n(w, "SELECT COUNT(*) AS n FROM ds_schedules WHERE season = 2026 AND roof IS NULL"),
    ).toBe(34);
    expect(
      n(
        w,
        "SELECT COUNT(*) AS n FROM ds_schedules s LEFT JOIN ds_venues v ON v.stadium_id = s.venue_id WHERE v.stadium_id IS NULL",
      ),
    ).toBe(0);
  });

  it("the ESPN game id join is exact: 272/272 against the recorded proTeamSchedules_wl", async () => {
    const { w } = await run(schedulesSource, [2026]);
    const espn = JSON.parse(
      readFileSync(
        new URL("../../../fixtures/espn/recorded/season/proTeamSchedules_wl.json", import.meta.url),
        "utf8",
      ),
    ) as {
      settings: {
        proTeams: {
          proGamesByScoringPeriod?: Record<string, { id: number; scoringPeriodId: number }[]>;
        }[];
      };
    };
    const espnGames = new Map<number, number>();
    for (const t of espn.settings.proTeams) {
      for (const gs of Object.values(t.proGamesByScoringPeriod ?? {})) {
        for (const g of gs) espnGames.set(g.id, g.scoringPeriodId);
      }
    }
    const ours = w.all("SELECT espn_game_id, week FROM ds_schedules WHERE season = 2026") as {
      espn_game_id: number;
      week: number;
    }[];
    expect(espnGames.size).toBe(272);
    expect(ours).toHaveLength(272);
    for (const g of ours)
      expect(espnGames.get(g.espn_game_id), String(g.espn_game_id)).toBe(g.week);
    expect(new Set(ours.map((g) => g.espn_game_id)).size).toBe(272);
  });

  it("implied team totals from spread/total: the favourite gets the larger total (+ = home)", async () => {
    const { w } = await run(schedulesSource, [2026]);
    const row = (id: string) => w.all("SELECT * FROM ds_schedules WHERE game_id = ?", id)[0] ?? {};
    // PIT at CLE, week 4: spread −2.5 (away favoured), total 38.5
    expect(gameLines(row("2026_04_PIT_CLE"))).toEqual({
      spread_line: -2.5,
      total_line: 38.5,
      implied: { away: 20.5, home: 18 },
      moneyline: { away: -148, home: 124 },
    });
    // SF at LA, week 1: spread +3.5 (home favoured), total 47.5
    expect(gameLines(row("2026_01_SF_LA"))?.implied).toEqual({ away: 22, home: 25.5 });
    // no line yet → null
    expect(gameLines(row("2026_08_BAL_BUF"))).toBeNull();
    let withLines = 0;
    for (const r of w.all("SELECT * FROM ds_schedules WHERE season = 2026")) {
      const l = gameLines(r);
      if (l === null) continue;
      withLines++;
      const { away, home } = l.implied;
      if (l.spread_line !== null && l.total_line !== null && away !== null && home !== null) {
        expect(away + home).toBeCloseTo(l.total_line, 9);
        expect(home - away).toBeCloseTo(l.spread_line, 9);
        expect(l.implied).toEqual(impliedPoints(l.spread_line, l.total_line));
      }
    }
    expect(withLines).toBe(79);
  });

  it("covers the requested seasons (plus the backtest seasons), from one download", async () => {
    const { stats, w, files, c } = await run(schedulesSource, [2025, 2026, 2025]);
    expect(files.map((f) => f.season)).toEqual([2023, 2024, 2025, 2026]);
    expect(c.calls.filter((u) => u.endsWith("games.parquet"))).toHaveLength(1);
    expect(stats.seasons).toEqual([2025, 2026]);
    expect(w.all("SELECT season, COUNT(*) AS n FROM ds_schedules GROUP BY season")).toEqual([
      { season: 2025, n: 285 },
      { season: 2026, n: 272 },
    ]);
    for (const [gameId, venue] of Object.entries(GAME_VENUE_OVERRIDES)) {
      expect(
        w.all("SELECT venue_id FROM ds_schedules WHERE game_id = ?", gameId)[0]?.venue_id,
        gameId,
      ).toBe(venue);
    }
    // the Super Bowl is not a fantasy week: no venue cross-check warning for it
    expect(stats.warnings).toEqual([]);
  });
});

describe("nflverse:injuries", () => {
  it("publishes every 2026 report, one practice status per player-week, '' never stored", async () => {
    const { stats, w } = await run(injuriesSource, [2026]);
    expect(stats.tables).toEqual([{ name: "ds_injuries", rows: 1052 }]);
    expect(stats.warnings).toEqual([]);
    expect(stats.columns_hash).toBe(columnsHash("nflverse:injuries"));
    expect(
      n(
        w,
        "SELECT COUNT(*) AS n FROM ds_injuries WHERE report_status = '' OR practice_status = ''",
      ),
    ).toBe(0);
    expect(n(w, "SELECT COUNT(*) AS n FROM ds_injuries WHERE report_status IS NULL")).toBe(629);
    expect(w.all("SELECT DISTINCT week FROM ds_injuries ORDER BY week").map((r) => r.week)).toEqual(
      [1, 2, 3, 4],
    );
  });
});

describe("nflverse:roster_weekly — the crosswalk's id source", () => {
  it("publishes gsis_id ↔ espn_id (INTEGER) and the other ids for every fixture-roster player", async () => {
    const { stats, w } = await run(rosterWeeklySource, [2026]);
    expect(stats.warnings).toEqual(["ds_roster_weekly: dropped 5 row(s) — null gsis_id"]);
    expect(
      n(
        w,
        "SELECT COUNT(*) AS n FROM ds_roster_weekly WHERE espn_id IS NOT NULL AND typeof(espn_id) <> 'integer'",
      ),
    ).toBe(0);
    for (const p of inRoster) {
      const rows = w.all(
        "SELECT * FROM ds_roster_weekly WHERE gsis_id = ? ORDER BY week DESC",
        p.gsis_id,
      );
      expect(rows.length, p.espn_name).toBeGreaterThan(0);
      const latest = rows[0] ?? {};
      expect(latest.week, p.espn_name).toBe(p.roster_week);
      expect(latest.espn_id, p.espn_name).toBe(p.espn_id);
      expect(latest.full_name).toBe(p.nflverse_name);
      expect(latest.team).toBe(p.team);
      expect(latest.position).toBe(p.position);
      expect(latest.jersey_number).toBe(p.jersey);
      expect(latest.sleeper_id).toBe(p.sleeper_id);
      expect(latest.pfr_id).toBe(p.pfr_id);
      expect(latest.status).toBe(p.status);
      expect(String(latest.birth_date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // the decoy shares a fixture player's full name but not the ESPN id
    const decoy = roster.decoys[0];
    const hits = w.all(
      "SELECT gsis_id, espn_id FROM ds_roster_weekly WHERE full_name = ? AND week = 4 ORDER BY gsis_id",
      decoy?.nflverse_name ?? "",
    );
    expect(hits.length).toBe(2);
    expect(hits.map((h) => h.espn_id)).toContain(decoy?.espn_id);
    // the free agent is absent here (the players fallback finds him)
    const fa = roster.players.find((p) => p.tags.includes("players_fallback"));
    expect(
      n(w, "SELECT COUNT(*) AS n FROM ds_roster_weekly WHERE gsis_id = ?", fa?.gsis_id ?? ""),
    ).toBe(0);
    // active skill players without an ESPN id keep a NULL, never a 0 or ''
    expect(
      n(
        w,
        "SELECT COUNT(*) AS n FROM ds_roster_weekly WHERE espn_id IS NULL AND week = 4 AND status = 'ACT' AND position IN ('QB','RB','WR','TE')",
      ),
    ).toBe(3);
  });
});

describe("nflverse:stats_player_week", () => {
  it("publishes the fixture players' weeks 1–3 and the derived team-defence weeks", async () => {
    const { stats, w } = await run(statsPlayerWeekSource, [2026]);
    const raw = fixtureRows(FX.stats);
    const sum = (rows: readonly Record<string, unknown>[], c: string): number =>
      rows.reduce((a, r) => a + (typeof r[c] === "number" ? r[c] : 0), 0);
    const t = Object.fromEntries(stats.tables.map((x) => [x.name, x.rows]));
    expect(t.ds_stats_player_week).toBe(1071); // 1,075 excerpt rows − 4 team-level rows
    expect(stats.warnings).toEqual([
      "ds_stats_player_week: dropped 4 row(s) — null player_id",
      "ds_team_defense_week: 1 team-level row(s) without a player_id credited to their team",
    ]);
    expect(stats.columns_hash).toBe(columnsHash("nflverse:stats_player_week"));
    for (const p of inRoster) {
      const weeks = w.all(
        "SELECT week FROM ds_stats_player_week WHERE player_id = ? ORDER BY week",
        p.gsis_id,
      );
      expect(
        weeks.map((r) => r.week),
        p.espn_name,
      ).toEqual(p.stat_weeks);
    }
    // every fixture team unit has a complete D/ST line for weeks 1–3, with yards allowed
    for (const u of roster.team_units) {
      const lines = w.all(
        "SELECT * FROM ds_team_defense_week WHERE team = ? ORDER BY week",
        u.team,
      );
      expect(
        lines.map((l) => l.week),
        u.team,
      ).toEqual([1, 2, 3]);
      for (const l of lines) {
        const opp = w.all(
          "SELECT SUM(passing_yards) AS p, SUM(rushing_yards) AS r, SUM(sack_yards_lost) AS s FROM ds_stats_player_week WHERE team = ? AND week = ?",
          String(l.opponent_team),
          Number(l.week),
        )[0];
        expect(l.opp_passing_yards).toBe(opp?.p);
        expect(l.opp_rushing_yards).toBe(opp?.r);
        expect(l.opp_sack_yards_lost).toBe(opp?.s);
        const own = raw.filter(
          (r) => r.team === u.team && r.week === l.week && r.player_id !== null,
        );
        expect(l.player_rows).toBe(own.length);
        expect(l.def_sacks).toBeCloseTo(sum(own, "def_sacks"), 9);
        expect(l.def_interceptions).toBe(sum(own, "def_interceptions"));
        expect(l.fumble_recovery_opp).toBe(sum(own, "fumble_recovery_opp"));
      }
    }
    // BUF's unattributed week-2 safety is credited to BUF (not a player row, no yardage)
    const buf = w.all(
      "SELECT def_safeties, player_rows FROM ds_team_defense_week WHERE team = 'BUF' AND week = 2",
    )[0];
    const bufRows = raw.filter((r) => r.team === "BUF" && r.week === 2);
    const teamRow = bufRows.filter((r) => r.player_id === null);
    expect(teamRow.map((r) => r.def_safeties)).toEqual([1]);
    expect(buf).toEqual({
      def_safeties:
        sum(
          bufRows.filter((r) => r.player_id !== null),
          "def_safeties",
        ) + 1,
      player_rows: bufRows.length - 1,
    });
  });
});

describe("nflverse:players — the crosswalk fallback", () => {
  it("publishes GSIS rows only, espn_id as INTEGER, jersey text → integer; version is season-less", async () => {
    const { stats, w, files, c } = await run(playersSource, [2025, 2026]);
    expect(files).toEqual([expect.objectContaining({ season: null })]);
    expect(c.calls).toEqual([`${REL}/players/timestamp.txt`, `${REL}/players/players.parquet`]);
    const v = await playersSource.version(c.ctx);
    expect(v?.version).toBe("20261005T165138Z");
    expect(stats.warnings).toEqual(["ds_nfl_players: dropped 3 row(s) — gsis_id is not a GSIS id"]);
    expect(stats.seasons).toEqual([]);
    expect(stats.tables).toEqual([{ name: "ds_nfl_players", rows: 26 }]);
    const fa = roster.players.find((p) => p.tags.includes("players_fallback"));
    const row = w.all("SELECT * FROM ds_nfl_players WHERE espn_id = ?", fa?.espn_id ?? 0)[0];
    expect(row?.gsis_id).toBe(fa?.gsis_id);
    expect(typeof row?.jersey_number === "number" || row?.jersey_number === null).toBe(true);
    // the one player whose espn_id differs between the two files is present in both fixtures
    expect(n(w, "SELECT COUNT(*) AS n FROM ds_nfl_players WHERE gsis_id = '00-0031484'")).toBe(1);
  });
});

describe("the published files satisfy the store's reader SQL (tables.ts READER_QUERIES)", () => {
  const sql = (key: keyof typeof READER_QUERIES, i = 0): string =>
    READER_QUERIES[key].statements[i]?.sql ?? "";

  it("NflGamesReader.games / byEspnGameId and PlayerWeekReader.defenseLines' scores", async () => {
    const { w } = await run(schedulesSource, [2026]);
    const games = w.db.prepare(sql("NflGamesReader.games")).all({ season: 2026, weeks: "[8]" });
    expect(games).toHaveLength(14);
    expect(games.every((g) => typeof g.venue_tz === "string")).toBe(true);
    const byId = w.db
      .prepare(sql("NflGamesReader.byEspnGameId"))
      .all({ espn_game_ids: JSON.stringify([401872964]) });
    expect(byId.map((g) => g.game_id)).toEqual(["2026_04_PIT_CLE"]);
    const scores = w.db
      .prepare(sql("PlayerWeekReader.defenseLines", 1))
      .all({ season: 2026, game_ids: JSON.stringify(["2026_04_PIT_CLE"]) });
    expect(scores).toEqual([
      {
        game_id: "2026_04_PIT_CLE",
        away_team: "PIT",
        home_team: "CLE",
        away_score: 24,
        home_score: 27,
      },
    ]);
  });

  it("InjuryReader, PlayerWeekReader, RosterWeeklyReader, NflPlayersReader over their files", async () => {
    const ids = JSON.stringify(inRoster.map((p) => p.gsis_id));
    const inj = await run(injuriesSource, [2026]);
    expect(
      inj.w.db.prepare(sql("InjuryReader.reports")).all({ season: 2026, week: 1, gsis_ids: null })
        .length,
    ).toBeGreaterThan(100);

    const st = await run(statsPlayerWeekSource, [2026]);
    const lines = st.w.db
      .prepare(sql("PlayerWeekReader.lines"))
      .all({ season: 2026, weeks: "[1,2,3]", gsis_ids: ids });
    expect(lines).toHaveLength(inRoster.reduce((a, p) => a + p.stat_weeks.length, 0));
    const teams = JSON.stringify(roster.team_units.map((u) => u.team));
    const d = st.w.db
      .prepare(sql("PlayerWeekReader.defenseLines"))
      .all({ season: 2026, weeks: "[1,2,3]", teams });
    expect(d).toHaveLength(roster.team_units.length * 3);

    const ro = await run(rosterWeeklySource, [2026]);
    const latest = ro.w.db.prepare(sql("RosterWeeklyReader.latest")).all({ season: 2026 });
    for (const p of inRoster) expect(latest.map((x) => x.gsis_id)).toContain(p.gsis_id);
    const allen = inRoster.find((p) => p.espn_name === "Josh Allen");
    const hit = ro.w.db
      .prepare(sql("RosterWeeklyReader.byEspnId"))
      .all({ espn_id: allen?.espn_id ?? 0 });
    expect(hit.map((h) => h.gsis_id)).toEqual([allen?.gsis_id]);
    // the ESPN id is an INTEGER column: a text id never matches (no type confusion at lookup)
    expect(ro.w.db.prepare(sql("RosterWeeklyReader.byEspnId")).all({ espn_id: "x" })).toEqual([]);

    const pl = await run(playersSource, [2026]);
    const fa = roster.players.find((p) => p.tags.includes("players_fallback"));
    const fb = pl.w.db
      .prepare(sql("NflPlayersReader.byEspnIds"))
      .all({ espn_ids: JSON.stringify([fa?.espn_id]) });
    expect(fb.map((r) => r.gsis_id)).toEqual([fa?.gsis_id]);
  });
});

describe("fetch hygiene and failures", () => {
  it("files land only inside the run's temp dir, mode 0600, one per season", async () => {
    const c = makeCtx([2026]);
    open.push(c);
    const v = await injuriesSource.version(c.ctx);
    const files = await injuriesSource.fetch(v!, c.ctx);
    for (const f of files) {
      expect(f.path.startsWith(c.tempDir)).toBe(true);
      expect(statSync(f.path).mode & 0o777).toBe(0o600);
    }
    expect(c.calls).toEqual([
      `${REL}/injuries/timestamp.txt`,
      `${REL}/injuries/injuries_2026.parquet`,
    ]);
  });

  it("concurrent sources in one temp dir never collide", async () => {
    const c = makeCtx([2026]);
    open.push(c);
    const all = await Promise.all(
      Object.values(NFLVERSE_SOURCES).map(async (s) => s.fetch((await s.version(c.ctx))!, c.ctx)),
    );
    const paths = all.flat().map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(readdirSync(c.tempDir)).toHaveLength(5);
  });

  it("an unchanged timestamp.txt is one 24-byte request — the version names the release + seasons", async () => {
    const c = makeCtx([2026]);
    open.push(c);
    const a = await statsPlayerWeekSource.version(c.ctx);
    const b = await statsPlayerWeekSource.version(c.ctx);
    expect(a).toEqual(b);
    expect(a).toEqual({
      version: "20261006T043503Z_2026",
      released_at: "2026-10-06T04:35:03.000Z",
    });
    expect(c.calls).toEqual([
      `${REL}/stats_player/timestamp.txt`,
      `${REL}/stats_player/timestamp.txt`,
    ]);
  });

  it("a past season's missing file fails the run and leaves nothing behind", async () => {
    const c = makeCtx([2024, 2026]);
    open.push(c);
    const v = await injuriesSource.version(c.ctx);
    await expect(injuriesSource.fetch(v!, c.ctx)).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      status: 404,
    });
    expect(readdirSync(c.tempDir)).toEqual([]);
    expect(c.unpublished).toEqual([]);
  });

  it("a new season's 404 before it is under way is 'not published': reported, the rest published", async () => {
    const c = makeCtx([2026, 2027], {
      now: "2027-07-15T12:00:00.000Z",
    });
    open.push(c);
    const v = await injuriesSource.version(c.ctx);
    const files = await injuriesSource.fetch(v!, c.ctx);
    expect(files.map((f) => f.season)).toEqual([2026]);
    expect(c.unpublished).toEqual([2027]);
    // a season-only-unpublished run has no files: the report says not_published
    const only = makeCtx([2027], { now: "2027-07-15T12:00:00.000Z" });
    open.push(only);
    const none = await injuriesSource.fetch(v!, only.ctx);
    expect(none).toEqual([]);
    const r = (await injuriesSource.assertSchema(none)) as NflverseSchemaReport;
    expect(r).toMatchObject({ ok: false, error: "not_published" });
  });

  it("schedules: a failed games.parquet download leaves nothing behind", async () => {
    const routes = new Map(fixtureRoutes());
    routes.delete(`${REL}/schedules/games.parquet`);
    const c = makeCtx([2026], { routes });
    open.push(c);
    const v = await schedulesSource.version(c.ctx);
    await expect(schedulesSource.fetch(v!, c.ctx)).rejects.toThrow(/games\.parquet answered 404/);
    expect(readdirSync(c.tempDir)).toEqual([]);
  });

  it("no seasons → no files and no request (a seasonal source)", async () => {
    const c = makeCtx([]);
    open.push(c);
    expect(await rosterWeeklySource.fetch({ version: "v", released_at: null }, c.ctx)).toEqual([]);
    expect(c.calls).toEqual([]);
    expect(existsSync(c.tempDir)).toBe(true);
    expect(readdirSync(c.tempDir)).toEqual([]);
  });

  it("the manifest's default seasons publish cleanly for every source (fixture-mode refresh)", async () => {
    for (const [id, seasons] of Object.entries(manifest.default_seasons)) {
      const s = NFLVERSE_SOURCES[id as keyof typeof NFLVERSE_SOURCES];
      const r = await run(s, seasons);
      expect(r.stats.rows, id).toBeGreaterThan(0);
    }
    expect(fixtureRows(FX.games).length).toBe(557);
  });
});
