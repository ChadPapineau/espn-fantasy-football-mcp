// phase3-real.test.ts — the history twins and schedules over the REAL 2023–2025 release files (plan 10
// §3.3 "≥ 3 historical seasons" [A-3], D9; the grounding of docs/evals/phase3-data.md): OPT-IN and
// offline. Set PHASE3_RELEASE_DIR to a directory (outside the repo) holding the downloaded files named
// `<tag>_<file>` (`pbp_play_by_play_2023.parquet`, `stats_player_stats_player_week_2024.parquet`,
// `ffopportunity_ep_weekly_2025.parquet`, `schedules_games.parquet`, and `<tag>_timestamp.txt` for
// schedules, stats_team, pbp, snap_counts and ffopportunity); every per-season file must
// hash to the observed record (2023: helpers/observed-history.ts; 2024/2025: tests/store/datasets/
// observed-phase2.ts), so the counts below are the grounding's exactly (`games.parquet` is rebuilt
// daily upstream, so only its 2023–2025 content is checked). The files are served through the fake
// HttpGet — no test touches the network — and each twin runs with the CLI's two-season default, so
// the third season arrives through the floor. Skipped in CI.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { epWeeklyHistorySource, epWeeklySource } from "../../../src/sources/ffopportunity/index.js";
import {
  NFLVERSE_HISTORY_SOURCES,
  NFLVERSE_PHASE_2_SOURCES,
  gameLines,
  schedulesSource,
  type HistoryDataSource,
  type NflversePublishStats,
  type NflverseSchemaReport,
} from "../../../src/sources/nflverse/index.js";
import type { DataSource } from "../../../src/sources/source.js";
import { PBP_CARRY_SQL, PBP_TARGET_SQL } from "../../../src/store/datasets/tables.js";
import { OBSERVED_PHASE2 } from "../../store/datasets/observed-phase2.js";
import { REL } from "./helpers/fixtures.js";
import { SqliteWriter, makeCtx, type Ctx, type Route } from "./helpers/harness.js";
import { OBSERVED_HISTORY_2023, OBSERVED_HISTORY_PUBLISH } from "./helpers/observed-history.js";

const DIR = process.env.PHASE3_RELEASE_DIR ?? "";
const enabled = DIR !== "" && existsSync(DIR);
const FFO = "https://github.com/ffverse/ffopportunity/releases/download/latest-data";
const SEASONS = [2023, 2024, 2025] as const;

/** `<source>@<season>` → the release URL and the local file name. */
const FILES: readonly { key: string; url: string; local: string }[] = SEASONS.flatMap((s) => [
  ...(
    [
      ["nflverse:stats_player_week", "stats_player", `stats_player_week_${String(s)}`],
      ["nflverse:stats_team_week", "stats_team", `stats_team_week_${String(s)}`],
      ["nflverse:pbp", "pbp", `play_by_play_${String(s)}`],
      ["nflverse:snap_counts", "snap_counts", `snap_counts_${String(s)}`],
      ["nflverse:depth_charts", "depth_charts", `depth_charts_${String(s)}`],
      ["nflverse:injuries", "injuries", `injuries_${String(s)}`],
    ] as const
  ).map(([id, tag, name]) => ({
    key: `${id}@${String(s)}`,
    url: `${REL}/${tag}/${name}.parquet`,
    local: `${tag}_${name}.parquet`,
  })),
  {
    key: `ffopportunity:ep_weekly@${String(s)}`,
    url: `${FFO}/ep_weekly_${String(s)}.parquet`,
    local: `ffopportunity_ep_weekly_${String(s)}.parquet`,
  },
]);

function routes(): Map<string, Route> {
  const out = new Map<string, Route>();
  for (const f of FILES) {
    const bytes = readFileSync(join(DIR, f.local));
    const want = (OBSERVED_HISTORY_2023[f.key] ?? OBSERVED_PHASE2[f.key])?.sha256;
    if (createHash("sha256").update(bytes).digest("hex") !== want)
      throw new Error(`${f.local}: not the observed file`);
    out.set(f.url, new Uint8Array(bytes));
  }
  out.set(`${REL}/schedules/games.parquet`, readFileSync(join(DIR, "schedules_games.parquet")));
  // the current-season sources' stamps (their versions; the history twins need none)
  for (const tag of ["schedules", "stats_team", "pbp", "snap_counts"])
    out.set(`${REL}/${tag}/timestamp.txt`, readFileSync(join(DIR, `${tag}_timestamp.txt`)));
  out.set(`${FFO}/timestamp.txt`, readFileSync(join(DIR, "ffopportunity_timestamp.txt")));
  return out;
}

const open: Ctx[] = [];
const writers: SqliteWriter[] = [];
afterAll(() => {
  for (const w of writers.splice(0)) w.close();
  for (const c of open.splice(0)) c.cleanup();
});

async function run(
  source: DataSource | HistoryDataSource,
  seasons: number[],
  r: Map<string, Route>,
): Promise<{ stats: NflversePublishStats; report: NflverseSchemaReport; w: SqliteWriter }> {
  const c = makeCtx(seasons, { routes: r });
  open.push(c);
  const v = await source.version(c.ctx);
  if (v === null) throw new Error("no version");
  const files = await source.fetch(v, c.ctx);
  const report = (await source.assertSchema(files)) as NflverseSchemaReport;
  expect(report.ok, report.warnings.join("\n")).toBe(true);
  const w = new SqliteWriter(c.tempDir);
  writers.push(w);
  const stats = (await source.publish(files, w)) as NflversePublishStats;
  return { stats, report, w };
}

const rowsOf = (s: NflversePublishStats): Record<string, number> =>
  Object.fromEntries(s.tables.map((t) => [t.name, t.rows]));

describe.skipIf(!enabled)("the history twins over the real 2023–2025 release files", () => {
  const r = enabled ? routes() : new Map<string, Route>();
  const twins: readonly HistoryDataSource[] = [
    ...Object.values(NFLVERSE_HISTORY_SOURCES),
    epWeeklyHistorySource,
  ];
  const published = new Map<string, SqliteWriter>();

  it("every twin publishes the three seasons from the CLI default, as recorded", async () => {
    for (const h of twins) {
      const { stats, report, w } = await run(h, [2024, 2025], r);
      published.set(h.id, w);
      const want = OBSERVED_HISTORY_PUBLISH[h.id];
      expect(want, h.id).toBeDefined();
      expect(stats.seasons, h.id).toEqual([...SEASONS]);
      expect(rowsOf(stats), h.id).toEqual(want?.tables);
      expect(stats.warnings, h.id).toEqual(want?.warnings);
      expect(Object.fromEntries(report.files.map((f) => [String(f.season), f.rows])), h.id).toEqual(
        want?.upstream_rows,
      );
    }
  });

  it("each three-season file is 2023 alone plus Phase 2's two-season record", async () => {
    // the current-season sources carry no floor: run on [2023] alone they publish 2023 only
    const alone = async (s: DataSource) => rowsOf((await run(s, [2023], r)).stats);
    const p2 = NFLVERSE_PHASE_2_SOURCES;
    const total = (id: string, t: string) => OBSERVED_HISTORY_PUBLISH[id]?.tables[t] ?? NaN;
    const twoSeason = {
      ds_stats_team_week: 1140,
      ds_pbp: 85713,
      ds_snap_counts: 53228,
      ds_ep_weekly: 11217,
    };
    const a = {
      ds_stats_team_week: (await alone(p2["nflverse:stats_team_week"])).ds_stats_team_week ?? NaN,
      ds_pbp: (await alone(p2["nflverse:pbp"])).ds_pbp ?? NaN,
      ds_snap_counts: (await alone(p2["nflverse:snap_counts"])).ds_snap_counts ?? NaN,
      ds_ep_weekly: (await alone(epWeeklySource)).ds_ep_weekly ?? NaN,
    };
    expect(a).toEqual({
      ds_stats_team_week: 570,
      ds_pbp: 43658,
      ds_snap_counts: 26540,
      ds_ep_weekly: 5643,
    });
    expect(a.ds_stats_team_week + twoSeason.ds_stats_team_week).toBe(
      total("nflverse:stats_team_week_history", "ds_stats_team_week"),
    );
    expect(a.ds_pbp + twoSeason.ds_pbp).toBe(total("nflverse:pbp_history", "ds_pbp"));
    expect(a.ds_snap_counts + twoSeason.ds_snap_counts).toBe(
      total("nflverse:snap_counts_history", "ds_snap_counts"),
    );
    expect(a.ds_ep_weekly + twoSeason.ds_ep_weekly).toBe(
      total("ffopportunity:ep_weekly_history", "ds_ep_weekly"),
    );
    // the legacy depth layout: 2023's 36,922 rows + 2024's 36,877
    expect(total("nflverse:depth_charts_history", "ds_depth_charts_legacy")).toBe(36922 + 36877);
  });

  it("pbp counting = nflverse's own stats_player_week on every 2023 player-week", () => {
    const pbp = published.get("nflverse:pbp_history");
    const st = published.get("nflverse:stats_player_week_history");
    if (!pbp || !st) throw new Error("publish first");
    pbp.db.exec(`ATTACH DATABASE '${st.path.replaceAll("'", "''")}' AS s`);
    try {
      const agree = (stat: string, perWeek: string): { n: number; agree: number } => {
        const sql = `WITH p AS (${perWeek}),
          k AS (SELECT week, id FROM p UNION SELECT week, player_id FROM s.ds_stats_player_week
                WHERE season = 2023 AND COALESCE(${stat}, 0) <> 0)
          SELECT COUNT(*) AS n,
            SUM(COALESCE(p.v, 0) = COALESCE(x.${stat}, 0)) AS agree
          FROM k LEFT JOIN p ON p.week = k.week AND p.id = k.id
          LEFT JOIN s.ds_stats_player_week AS x
            ON x.season = 2023 AND x.week = k.week AND x.player_id = k.id`;
        return pbp.all(sql)[0] as { n: number; agree: number };
      };
      const by = (id: string, v: string, where: string) =>
        `SELECT week, ${id} AS id, ${v} AS v FROM ds_pbp WHERE season = 2023 AND ${id} IS NOT NULL AND ${where} GROUP BY week, ${id}`;
      const out = {
        targets: agree("targets", by("receiver_player_id", "COUNT(*)", PBP_TARGET_SQL)),
        receptions: agree(
          "receptions",
          by("receiver_player_id", "SUM(complete_pass = 1)", PBP_TARGET_SQL),
        ),
        carries: agree("carries", by("rusher_player_id", "COUNT(*)", PBP_CARRY_SQL)),
        passing_tds: agree(
          "passing_tds",
          by("passer_player_id", "SUM(pass_touchdown = 1)", "pass_touchdown = 1"),
        ),
        receiving_tds: agree(
          "receiving_tds",
          by("td_player_id", "SUM(pass_touchdown = 1)", "pass_touchdown = 1"),
        ),
        rushing_tds: agree(
          "rushing_tds",
          by("td_player_id", "SUM(rush_touchdown = 1)", "rush_touchdown = 1"),
        ),
        fg_att: agree("fg_att", by("kicker_player_id", "COUNT(*)", "play_type = 'field_goal'")),
        fg_made: agree(
          "fg_made",
          by(
            "kicker_player_id",
            "COUNT(*)",
            "play_type = 'field_goal' AND field_goal_result = 'made'",
          ),
        ),
      };
      // every player-week either side counts (receptions: every targeted player-week); all agree —
      // docs/evals/phase3-data.md records these
      expect(out).toEqual({
        targets: { n: 4594, agree: 4594 },
        receptions: { n: 4594, agree: 4594 },
        carries: { n: 2379, agree: 2379 },
        passing_tds: { n: 464, agree: 464 },
        receiving_tds: { n: 719, agree: 719 },
        rushing_tds: { n: 419, agree: 419 },
        fg_att: { n: 499, agree: 499 },
        fg_made: { n: 475, agree: 475 },
      });
    } finally {
      pbp.db.exec("DETACH DATABASE s");
    }
  });

  it("2023's INT32 goal_to_go is stored as 0/1 like 2024–2025's DOUBLE", () => {
    const pbp = published.get("nflverse:pbp_history");
    if (!pbp) throw new Error("publish first");
    const got = pbp.all(
      "SELECT season, SUM(goal_to_go = 1) AS gtg, SUM(goal_to_go IS NULL) AS nulls, COUNT(*) AS n FROM ds_pbp GROUP BY season ORDER BY season",
    ) as { season: number; gtg: number; nulls: number; n: number }[];
    expect(got.map((x) => x.season)).toEqual([...SEASONS]);
    for (const x of got) {
      expect(x.gtg, String(x.season)).toBeGreaterThan(2000);
      expect(x.nulls / x.n, String(x.season)).toBeLessThan(0.01);
    }
  });

  it("schedules: every 2023–2025 game with its lines and score from games.parquet", async () => {
    const { w } = await run(schedulesSource, [2026], r);
    const per = w.all(`SELECT season, COUNT(*) AS n, SUM(spread_line IS NOT NULL) AS spread,
      SUM(total_line IS NOT NULL) AS total, SUM(home_moneyline IS NOT NULL) AS ml,
      SUM(home_score IS NOT NULL) AS scored, SUM(kickoff_utc IS NOT NULL) AS kick
      FROM ds_schedules WHERE season < 2026 GROUP BY season ORDER BY season`);
    expect(per).toEqual(
      SEASONS.map((season) => ({
        season,
        n: 285,
        spread: 285,
        total: 285,
        ml: 285,
        scored: 285,
        kick: 285,
      })),
    );
    for (const g of w.all("SELECT * FROM ds_schedules WHERE season = 2023"))
      expect(gameLines(g), String(g.game_id)).not.toBeNull();
  });
});
