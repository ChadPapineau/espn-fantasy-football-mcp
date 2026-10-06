// refresh.test.ts — `eff refresh` (plan 06 J3, §1.3; plan 01 §5.5): target planning (the ESPN season
// sources plan through the default registry), seasons, the coming week,
// result lines and JSON (fixed fields, terminal-safe warnings), fixture mode refused, a failed source
// → exit 1 + one failure notification, and the crosswalk chain after a published daily source.
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_REGISTRY,
  REFRESH_TARGETS,
  availableRefreshJobs,
  comingWeek,
  defaultSeasons,
  describeResult,
  describeWarnings,
  isRefreshTarget,
  jobNameFor,
  parseSeasons,
  planTarget,
  refresh,
  resultJson,
  type SourceRegistry,
} from "../../src/cli/refresh.js";
import { loadLenientRuntime } from "../../src/cli/runtime.js";
import { NFLVERSE_SOURCES } from "../../src/sources/nflverse/index.js";
import type { RefreshResult } from "../../src/sources/runner.js";
import type { DataSource } from "../../src/sources/source.js";
import { fakeExec, makeIo, noNetwork, sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox;
afterEach(() => {
  sb.cleanup();
});

const published: RefreshResult = {
  status: "published",
  source: "nflverse:injuries",
  version: { version: "v1", released_at: null },
  file: "/x",
  file_version: "v1",
  stats: { rows: 12, tables: [], seasons: [2026], columns_hash: "h" },
  attempts: 1,
  warnings: [
    "col \u001b[31mred\u001b[0m",
    ...Array.from({ length: 6 }, (_, i) => `w${String(i)} ${"y".repeat(300)}`),
  ],
};

describe("planning", () => {
  it("knows every target; every Phase-1a job has its sources (the ESPN season sources included)", () => {
    sb = sandbox();
    expect(isRefreshTarget("all")).toBe(true);
    expect(isRefreshTarget("nflverse:snaps")).toBe(false);
    expect(REFRESH_TARGETS).toContain("nflverse:players");
    expect(availableRefreshJobs()).toEqual([
      "espn:schedule",
      "espn:players",
      "nflverse:schedules",
      "nflverse:daily",
      "nflverse:stats",
      "weather",
    ]);
    const all = planTarget("all", { weatherSource: "nws" });
    expect(all.filter((s) => s.kind === "unavailable")).toEqual([]);
    expect(
      planTarget("espn:schedule", {
        weatherSource: "nws",
        espnReadHost: "lm-api-reads.fantasy.espn.com",
      }).map((s) => (s.kind === "source" ? s.source.id : s.job)),
    ).toEqual(["espn:pro_schedule"]);
    expect(
      planTarget("espn:players", { weatherSource: "nws" }).map((s) =>
        s.kind === "source" ? s.source.id : s.job,
      ),
    ).toEqual(["espn:players"]);
    // a registry without a job's sources still plans it as unavailable
    const none: SourceRegistry = {
      byJob: (job) =>
        job === "weather" ? null : DEFAULT_REGISTRY.byJob(job, { weatherSource: "nws" }),
    };
    expect(availableRefreshJobs(none)).not.toContain("weather");
    expect(
      planTarget("all", { weatherSource: "nws" }, none)
        .filter((s) => s.kind === "unavailable")
        .map((s) => s.job),
    ).toEqual(["weather"]);
    const ids = all.flatMap((s) => (s.kind === "source" ? [s.source.id] : []));
    expect(ids.indexOf("nflverse:schedules")).toBeLessThan(ids.indexOf("weather:nws"));
    expect(
      planTarget("nflverse:daily", { weatherSource: "open-meteo" }).map((s) =>
        s.kind === "source" ? s.source.id : s.job,
      ),
    ).toEqual(["nflverse:injuries", "nflverse:roster_weekly", "nflverse:players"]);
    expect(planTarget("nflverse:roster_weekly", { weatherSource: "open-meteo" })[0]).toMatchObject({
      job: "nflverse:daily",
    });
    expect(
      planTarget("nflverse:stats_player_week", { weatherSource: "open-meteo" })[0],
    ).toMatchObject({ job: "nflverse:stats" });
    expect(planTarget("nflverse:schedules", { weatherSource: "open-meteo" })[0]).toMatchObject({
      job: "nflverse:schedules",
    });
    expect(DEFAULT_REGISTRY.byJob("odds", { weatherSource: "nws" })).toBeNull();
    expect(jobNameFor("nflverse:daily")).toBe("refresh-nflverse-daily");
  });
  it("seasons: defaults carry the previous season for stats/schedules; --seasons is validated", () => {
    sb = sandbox();
    expect(defaultSeasons(NFLVERSE_SOURCES["nflverse:stats_player_week"], 2026)).toEqual([
      2025, 2026,
    ]);
    expect(defaultSeasons(NFLVERSE_SOURCES["nflverse:injuries"], 2026)).toEqual([2026]);
    expect(parseSeasons(" 2026,2025,2026 ")).toEqual([2025, 2026]);
    for (const bad of [
      "",
      "26",
      "1998",
      "2101",
      "x",
      Array.from({ length: 31 }, (_, i) => String(2000 + i)).join(","),
    ])
      expect(() => parseSeasons(bad), bad).toThrow();
  });
  it("comingWeek: the week of the next confirmed kickoff; TBD and past games ignored", () => {
    sb = sandbox();
    const g = (week: number, kickoff: string | null, tbd = false) => ({
      espn_game_id: week,
      season: 2026,
      week,
      kickoff,
      start_time_tbd: tbd,
      valid_for_locking: true,
      stats_official: false,
      home_pro_team_id: 1,
      away_pro_team_id: 2,
    });
    const reader = (rows: ReturnType<typeof g>[]) => ({
      games: () => ({ rows, stamp: { as_of: "x" } }) as never,
      teams: () => ({ rows: [], stamp: null }) as never,
    });
    const now = Date.parse("2026-10-06T12:00:00Z");
    expect(
      comingWeek(
        reader([
          g(4, "2026-10-01T00:00:00Z"),
          g(6, "2026-10-15T00:00:00Z", true),
          g(5, "2026-10-09T00:00:00Z"),
        ]),
        2026,
        now,
      ),
    ).toBe(5);
    expect(comingWeek(reader([g(4, null)]), 2026, now)).toBeNull();
    const throwing = {
      games: () => {
        throw new Error("x");
      },
      teams: () => {
        throw new Error("x");
      },
    };
    expect(comingWeek(throwing as never, 2026, now)).toBeNull();
  });
});

describe("result lines", () => {
  it("published/unchanged/skipped/failed lines; warnings terminal-safe, capped and counted", () => {
    sb = sandbox();
    expect(describeResult(published)).toMatch(
      /published  version v1  12 rows  \(7 warnings, below\)/,
    );
    const w = describeWarnings(published);
    expect(w).toHaveLength(6);
    expect(w[0]).not.toContain("\u001b");
    expect(w[1]!.length).toBeLessThan(220);
    expect(w[5]).toContain("… 2 more");
    const unchanged: RefreshResult = {
      status: "unchanged",
      source: "nflverse:players",
      version: { version: "v2", released_at: null },
      attempts: 1,
    };
    const skipped: RefreshResult = {
      status: "skipped",
      source: "weather:nws",
      reason: "off_season",
    };
    const failed: RefreshResult = {
      status: "failed",
      source: "nflverse:schedules",
      error: "network",
      source_error: "UPSTREAM_UNAVAILABLE",
      message: "m",
      version: null,
      attempts: 3,
      schema: null,
    };
    expect(describeResult(unchanged)).toContain("unchanged");
    expect(describeResult(skipped)).toContain("off_season");
    expect(describeResult(failed)).toContain("FAILED     UPSTREAM_UNAVAILABLE: m");
    expect(describeWarnings(failed)).toEqual([]);
    expect(resultJson(published)).toMatchObject({ rows: 12, warnings: 7 });
    expect(resultJson(unchanged)).toMatchObject({ version: "v2" });
    expect(resultJson(skipped)).toMatchObject({ reason: "off_season" });
    expect(resultJson(failed)).toMatchObject({ error: "UPSTREAM_UNAVAILABLE", attempts: 3 });
  });
});

/** A source that cannot reach upstream (version() → null): the runner records one failure row. */
function unreachable(base: DataSource): DataSource {
  return { ...base, version: () => Promise.resolve(null) };
}

describe("refresh", () => {
  it("refuses fixture mode (no network allowed there) and a bad target", async () => {
    sb = sandbox();
    const io = makeIo(sb, { env: { EFF_FIXTURE_DIR: sb.dir } });
    const { config, log } = await loadLenientRuntime(io);
    expect(
      await refresh(
        io,
        config,
        log,
        { target: "all", force: false, notify: false, json: false },
        new AbortController().signal,
      ),
    ).toBe(2);
    await expect(
      refresh(
        io,
        config,
        log,
        { target: "bogus", force: false, notify: false, json: false },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/refresh needs a target/);
  });
  it("a job this build cannot run is exit 1 with a 'not available' line and no request", async () => {
    sb = sandbox();
    const io = makeIo(sb, { fetch: noNetwork });
    const { config, log } = await loadLenientRuntime(io);
    const registry: SourceRegistry = { byJob: () => null };
    expect(
      await refresh(
        io,
        config,
        log,
        { target: "espn:schedule", force: false, notify: false, json: true, registry },
        new AbortController().signal,
      ),
    ).toBe(1);
    expect(JSON.parse(io.out.text)).toMatchObject({
      target: "espn:schedule",
      results: [],
      unavailable: ["espn:schedule"],
    });
  });

  it("an ESPN season refresh goes through the limiter as a keyless job request; offline it fails with ESPN_UPSTREAM_UNAVAILABLE", async () => {
    sb = sandbox();
    const io = makeIo(sb, { fetch: noNetwork });
    const { config, log } = await loadLenientRuntime(io);
    expect(
      await refresh(
        io,
        config,
        log,
        { target: "espn:schedule", force: false, notify: false, json: true },
        new AbortController().signal,
      ),
    ).toBe(1);
    const out = JSON.parse(io.out.text) as {
      results: { source: string; status: string; error?: string }[];
      unavailable: string[];
    };
    expect(out.unavailable).toEqual([]);
    expect(out.results).toMatchObject([
      { source: "espn:pro_schedule", status: "failed", error: "ESPN_UPSTREAM_UNAVAILABLE" },
    ]);
  });
  it("a failing source: exit 1, a refresh_log failure row, one rate-limited failure notification", async () => {
    sb = sandbox();
    const { exec, calls } = fakeExec();
    const io = makeIo(sb, { platform: "darwin", exec, fetch: noNetwork });
    const { config, log } = await loadLenientRuntime(io);
    const registry: SourceRegistry = {
      byJob: (job) =>
        job === "nflverse:schedules" ? [unreachable(NFLVERSE_SOURCES["nflverse:schedules"])] : null,
    };
    const code = await refresh(
      io,
      config,
      log,
      {
        target: "nflverse:schedules",
        seasons: "2026",
        force: true,
        notify: true,
        json: false,
        registry,
      },
      new AbortController().signal,
    );
    expect(code).toBe(1);
    expect(io.out.text).toContain("nflverse:schedules");
    expect(io.out.text).toContain("FAILED");
    expect(calls.filter((c) => c.file === "/usr/bin/osascript")).toHaveLength(1);
  });
  it("an unwritable cache dir is exit 1 (the store cannot open)", async () => {
    sb = sandbox();
    const io = makeIo(sb, { env: { EFF_CACHE_DIR: "/dev/null/cache" } });
    let threw = false;
    try {
      const { config, log } = await loadLenientRuntime(io);
      expect(
        await refresh(
          io,
          config,
          log,
          { target: "weather", force: false, notify: false, json: false },
          new AbortController().signal,
        ),
      ).toBe(1);
    } catch {
      threw = true;
    }
    expect(threw || io.err.text.includes("could not be opened")).toBe(true);
  });
});
