// phase2-readers.test.ts — the Phase-2 dataset ports over REAL published files (plan 10 §3.2; plan 01
// §5.5; tables.ts PHASE_2_READER_QUERIES): every fixture-backed source of `full` is published through
// the real runner + publisher (tests/integration/helpers/seed.ts — the same wiring as `eff refresh
// all`), the store is re-opened the way the server opens it, and each port answers from its own file:
// the depth chart (2026 snapshot runs, 2024's legacy layout from the history file), ffopportunity's
// expected points (current and prior season), the RSS items with their refs (every string wrapped —
// plan 02 §6), Sleeper's trending rows with gsis ids, and the usage extras `PlayerWeekReader.lines`
// gains from the snap-count and pbp files (snaps, red-zone and goal-line volume, carry share, routes
// proxy). A prior season reads from the history twin. No network.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backupDir, datasetDir, storePath } from "../../src/config/paths.js";
import { isUntrustedText } from "../../src/domain/league/types.js";
import { storeFactory } from "../../src/store/index.js";
import type { Store } from "../../src/store/types.js";
import { runningClock } from "../mcp/helpers/world.js";
import { seedDatasets, type SeedReport } from "./helpers/seed.js";

const SEASON = 2026;
const CLOCK = "2026-10-07T01:00:00.000Z";
/** Fixture-roster players (fixtures/players/fixture-roster.json): a RB, a WR, a TE. */
const RB = "00-0037248"; // BUF
const WR = "00-0036963"; // DET
const TE = "00-0033090"; // NE

let root = "";
let store: Store;
let report: SeedReport;
const warnings: string[] = [];

beforeAll(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "eff-p2r-")));
  chmodSync(root, 0o700);
  const cache = path.join(root, "cache");
  mkdirSync(cache, { mode: 0o700 });
  const clock = runningClock(CLOCK);
  const t = {
    storePath: storePath(cache),
    datasetDir: datasetDir(cache),
    cache,
    clock,
    season: SEASON,
  };
  const seeding = storeFactory.open({
    path: t.storePath,
    datasetDir: t.datasetDir,
    backupDir: backupDir(cache),
    clock,
    migrate: true,
  });
  try {
    report = await seedDatasets(seeding, t);
  } finally {
    seeding.close();
  }
  // a fresh open, as the server opens the store
  store = storeFactory.open({
    path: t.storePath,
    datasetDir: t.datasetDir,
    backupDir: backupDir(cache),
    clock,
    migrate: false,
    onWarning: (code: string) => warnings.push(code),
  });
}, 120_000);
afterAll(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("the seed: every fixture-backed source of full publishes through the real runner", () => {
  it("publishes the Phase-1, Phase-2 and history sources and rebuilds the crosswalk", () => {
    const by = new Map(report.results.map((r) => [r.source, r.status]));
    for (const id of [
      "nflverse:schedules",
      "nflverse:injuries",
      "nflverse:depth_charts",
      "nflverse:roster_weekly",
      "nflverse:players",
      "nflverse:stats_player_week",
      "nflverse:stats_team_week",
      "nflverse:pbp",
      "nflverse:snap_counts",
      "ffopportunity:ep_weekly",
      "sleeper:trending",
      "news:rotowire",
      "news:espn",
      "news:cbs",
      "nflverse:stats_player_week_history",
      "nflverse:stats_team_week_history",
      "nflverse:pbp_history",
      "nflverse:snap_counts_history",
      "nflverse:injuries_history",
      "nflverse:depth_charts_history",
      "ffopportunity:ep_weekly_history",
    ])
      expect(by.get(id as never), id).toBe("published");
    expect(report.results.every((r) => r.status === "published")).toBe(true);
    expect(report.crosswalk).toBe("done");
    // the network was never reached: every request was a committed fixture
    expect(report.calls.every((u) => u.startsWith("https://"))).toBe(true);
  });
});

describe("DepthChartReader.chart", () => {
  it("2026: the current snapshot runs, ESPN-keyed, names as bare text", () => {
    const r = store.datasets.depthCharts.chart(SEASON, ["BUF", "DET"]);
    expect(r.stamp?.source).toBe("nflverse:depth_charts");
    expect(r.rows.length).toBeGreaterThan(0);
    for (const x of r.rows) {
      expect(["BUF", "DET"]).toContain(x.nfl_team);
      expect(x.week).toBeNull();
      expect(x.rank).toBeGreaterThanOrEqual(1);
      expect(typeof x.name).toBe("string");
      expect(x.espn_id === null || x.espn_id > 0).toBe(true);
    }
    expect(r.rows.some((x) => x.gsis_id === RB)).toBe(true);
  });

  it("2024: the legacy layout from the history file (the team's last listed week)", () => {
    // the 2024 excerpt: every SEA and DET row of week 4 (fixtures/nflverse/phase2/manifest.json)
    const r = store.datasets.depthCharts.chart(2024, ["SEA"]);
    expect(r.stamp?.source).toBe("nflverse:depth_charts_history");
    expect(r.rows.length).toBeGreaterThan(0);
    const weeks = new Set(r.rows.map((x) => x.week));
    expect(weeks.size).toBe(1);
    expect(r.rows.every((x) => x.espn_id === null && x.nfl_team === "SEA")).toBe(true);
  });

  it("a team with no rows answers none, stamped (loaded); an unknown team never reaches SQL as text", () => {
    const r = store.datasets.depthCharts.chart(SEASON, ["ARI"]);
    expect(r.stamp).not.toBeNull();
    const bad = store.datasets.depthCharts.chart(SEASON, ["X') OR 1=1 --" as never]);
    expect(bad.rows).toEqual([]);
  });
});

describe("EpWeeklyReader.rows", () => {
  it("current and prior season (history file), xFP present", () => {
    const now = store.datasets.epWeekly.rows([RB, WR, TE], SEASON, [1, 2, 3]);
    expect(now.stamp?.source).toBe("ffopportunity:ep_weekly");
    expect(now.rows.length).toBeGreaterThan(0);
    expect(now.rows.every((x) => x.xfp_total === null || Number.isFinite(x.xfp_total))).toBe(true);
    expect(now.rows.some((x) => x.xfp_total !== null && x.xfp_total > 0)).toBe(true);
    const prior = store.datasets.epWeekly.rows(
      [RB, WR, TE],
      2025,
      Array.from({ length: 18 }, (_, i) => i + 1),
    );
    expect(prior.stamp?.source).toBe("ffopportunity:ep_weekly_history");
  });
});

describe("PlayerWeekReader.lines gains the snap-count and pbp extras", () => {
  it("snaps and shares from snap_counts, red-zone volume from pbp, routes proxy = share × dropbacks", () => {
    const r = store.datasets.playerWeeks.lines([RB, WR, TE], SEASON, [1, 2, 3]);
    expect(r.rows.length).toBeGreaterThan(0);
    const withSnaps = r.rows.filter((x) => x.usage?.snap_pct !== null);
    expect(withSnaps.length).toBeGreaterThan(0);
    for (const x of withSnaps) {
      const u = x.usage;
      expect(u?.snap_pct).toBeGreaterThanOrEqual(0);
      expect(u?.snap_pct).toBeLessThanOrEqual(1);
      expect(Number.isInteger(u?.snaps)).toBe(true);
    }
    // the pbp excerpt holds three complete games: those player-weeks carry counts (0 or more)
    const covered = r.rows.filter((x) => x.usage?.rz_targets !== null);
    expect(covered.length).toBeGreaterThan(0);
    for (const x of covered) {
      const u = x.usage;
      expect(u?.rz_targets).toBeGreaterThanOrEqual(0);
      expect(u?.rz_carries).toBeGreaterThanOrEqual(0);
      expect(u?.gl_carries).toBeLessThanOrEqual(u?.rz_carries ?? 0);
      if (u?.carry_share !== null) {
        expect(u?.carry_share).toBeGreaterThanOrEqual(0);
        expect(u?.carry_share).toBeLessThanOrEqual(1);
      }
      if (u?.snap_pct !== null && u?.routes_proxy !== null)
        expect(u?.routes_proxy).toBeGreaterThanOrEqual(0);
    }
  });

  it("a prior season reads the file that holds it: 2025 the current stats file, 2024 the history twin", () => {
    // the current stats file carries [2025, 2026] (E1's window — refresh defaultSeasons)
    const y1 = store.datasets.playerWeeks.lines([WR], 2025, [1, 2, 3, 4, 5, 6, 7]);
    expect(y1.stamp?.source).toBe("nflverse:stats_player_week");
    // 2024 is only in the history file (its excerpt: SEA and DET, week 4 — 2024_04_SEA_DET)
    const SEA_WR = "00-0038543";
    const y2 = store.datasets.playerWeeks.lines([WR, SEA_WR], 2024, [4]);
    expect(y2.stamp?.source).toBe("nflverse:stats_player_week_history");
    expect(y2.rows.length).toBeGreaterThan(0);
    // and the extras come from the snap-count and pbp history files for that game
    expect(y2.rows.some((x) => x.usage?.snap_pct !== null)).toBe(true);
    expect(y2.rows.some((x) => x.usage?.rz_targets !== null)).toBe(true);
    // the injuries twin too
    expect(store.datasets.injuries.reports(2024, 4, null).stamp?.source).toBe(
      "nflverse:injuries_history",
    );
  });
});

describe("PbpReader.teamProfile (the D5 profile, by defteam)", () => {
  it("one row per defence-week of the excerpt's games; counts consistent; a prior season reads the history file", () => {
    const pbp = store.datasets.pbp;
    expect(pbp).toBeDefined();
    const r = pbp?.teamProfile(["DET", "NO"], SEASON, [1, 2, 3]);
    expect(r?.stamp?.source).toBe("nflverse:pbp");
    // 2026_01_NO_DET: each side's defence faced the other's run/pass plays in week 1
    expect(r?.rows.map((x) => `${x.nfl_team}:${String(x.week)}`).sort()).toEqual(["DET:1", "NO:1"]);
    for (const x of r?.rows ?? []) {
      expect(x.plays).toBeGreaterThan(40);
      expect(x.dropbacks).toBeLessThanOrEqual(x.plays);
      expect(x.sacks).toBeLessThanOrEqual(x.dropbacks);
      expect(x.rushes).toBeLessThanOrEqual(x.plays);
      expect(x.epa_dropback_sum === null || Number.isFinite(x.epa_dropback_sum)).toBe(true);
    }
    const prior = pbp?.teamProfile(["SEA", "DET"], 2024, [4]);
    expect(prior?.stamp?.source).toBe("nflverse:pbp_history");
    expect(prior?.rows).toHaveLength(2);
  });
});

describe("NewsReader.recent", () => {
  it("merges the three feeds newest first; every string wrapped; refs carry match confidence", () => {
    const r = store.datasets.news.recent("2026-09-01T00:00:00.000Z", 200, null);
    expect(r.stamp).not.toBeNull();
    expect(r.rows.length).toBeGreaterThan(10);
    const sources = new Set(r.rows.map((x) => x.source));
    expect(sources.size).toBe(3);
    for (let i = 1; i < r.rows.length; i++)
      expect(Date.parse(r.rows[i - 1]?.published_at ?? "")).toBeGreaterThanOrEqual(
        Date.parse(r.rows[i]?.published_at ?? ""),
      );
    for (const x of r.rows) {
      expect(isUntrustedText(x.title)).toBe(true);
      expect(isUntrustedText(x.blurb)).toBe(true);
      expect(isUntrustedText(x.url)).toBe(true);
    }
    const withRefs = r.rows.filter(
      (x) => ((x as unknown as { refs?: unknown[] }).refs ?? []).length > 0,
    );
    expect(withRefs.length).toBeGreaterThan(0);
  });

  it("a gsis filter keeps only items that name the player; the limit holds", () => {
    const all = store.datasets.news.recent("2026-09-01T00:00:00.000Z", 200, null);
    const named = all.rows.find((x) => x.gsis_ids.length > 0);
    expect(named).toBeDefined();
    const g = named?.gsis_ids[0] ?? "";
    const r = store.datasets.news.recent("2026-09-01T00:00:00.000Z", 200, [g]);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.every((x) => x.gsis_ids.includes(g))).toBe(true);
    expect(store.datasets.news.recent("2026-09-01T00:00:00.000Z", 3, null).rows).toHaveLength(3);
    expect(() => store.datasets.news.recent("not a date", 3, null)).toThrow(RangeError);
  });
});

describe("TrendingReader.latest", () => {
  it("both lists, counts as given, gsis ids from the roster file where the Sleeper id is known", () => {
    const r = store.datasets.trending.latest();
    expect(r.stamp?.source).toBe("sleeper:trending");
    expect(r.rows.filter((x) => x.kind === "add").length).toBeGreaterThan(0);
    expect(r.rows.filter((x) => x.kind === "drop").length).toBeGreaterThan(0);
    expect(r.rows.every((x) => Number.isInteger(x.count) && x.count >= 0)).toBe(true);
    expect(r.rows.every((x) => Number.isFinite(Date.parse(x.as_of)))).toBe(true);
    // a defence's team code never matches a roster row; a person's Sleeper id may
    expect(
      r.rows.filter((x) => /^[A-Z]{2,3}$/.test(x.sleeper_id)).every((x) => x.gsis_id === null),
    ).toBe(true);
  });
});
