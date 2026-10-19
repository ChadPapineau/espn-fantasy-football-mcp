// refresh.test.ts — `eff refresh` (plan 06 J3, §1.3; plan 01 §5.5): target planning (the ESPN season
// sources plan through the default registry), seasons, the coming week,
// result lines and JSON (fixed fields, terminal-safe warnings), fixture mode refused, a failed source
// → exit 1 + one failure notification, and the crosswalk chain after a published daily source.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_REGISTRY,
  REFRESH_TARGETS,
  availableRefreshJobs,
  comingWeek,
  defaultSeasons,
  describeResult,
  historySkip,
  historyTwinsOf,
  isHistorySource,
  newsInputs,
  describeWarnings,
  isRefreshTarget,
  jobNameFor,
  parseSeasons,
  planTarget,
  refresh,
  resultJson,
  seasonsFor,
  targetUsageError,
  type SourceRegistry,
} from "../../src/cli/refresh.js";
import { loadLenientRuntime } from "../../src/cli/runtime.js";
import { configuredSources } from "../../src/cli/status.js";
import { openStore } from "../../src/cli/store-access.js";
import { isDatasetSourceId } from "../../src/config/freshness.js";
import { limiterRequest } from "../../src/providers/espn/limiter.js";
import { NFLVERSE_SOURCES } from "../../src/sources/nflverse/index.js";
import type { Store } from "../../src/store/types.js";
import { seasonState, type RefreshResult } from "../../src/sources/runner.js";
import type { DataSource } from "../../src/sources/source.js";
import {
  fakeExec,
  fakeFetch,
  json,
  makeIo,
  movingClock,
  noNetwork,
  ROOT,
  sandbox,
  type Sandbox,
} from "./helpers.js";

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
  it("knows every target; every built job has its sources (the ESPN season sources included)", () => {
    sb = sandbox();
    expect(isRefreshTarget("all")).toBe(true);
    expect(isRefreshTarget("nflverse:snaps")).toBe(true);
    // D13: no paid or keyed odds API — odds is not a target of this build
    expect(isRefreshTarget("odds")).toBe(false);
    expect(REFRESH_TARGETS).toContain("nflverse:players");
    expect(availableRefreshJobs()).toEqual([
      "espn:schedule",
      "espn:players",
      "nflverse:schedules",
      "nflverse:daily",
      "nflverse:stats",
      "nflverse:snaps",
      "ffopportunity",
      "sleeper:trending",
      "news",
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
    ).toEqual([
      "nflverse:injuries",
      "nflverse:depth_charts",
      "nflverse:roster_weekly",
      "nflverse:players",
      ...historyTwinsOf("nflverse:daily").map((t) => t.id),
    ]);
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
  it("Phase 2 (plan 10 §3.2): the new sources in their plan 06 §1.3 jobs; a source target plans alone", () => {
    sb = sandbox();
    const ids = (t: Parameters<typeof planTarget>[0]) =>
      planTarget(t, { weatherSource: "open-meteo" }).map((s) =>
        s.kind === "source" ? s.source.id : `unavailable:${s.job}`,
      );
    expect(ids("nflverse:stats")).toEqual([
      "nflverse:stats_player_week",
      "nflverse:stats_team_week",
      "nflverse:pbp",
      ...historyTwinsOf("nflverse:stats").map((t) => t.id),
    ]);
    expect(ids("nflverse:snaps")[0]).toBe("nflverse:snap_counts");
    expect(ids("ffopportunity")[0]).toBe("ffopportunity:ep_weekly");
    expect(ids("sleeper:trending")).toEqual(["sleeper:trending"]);
    expect(ids("news")).toEqual(["news:rotowire", "news:espn", "news:cbs"]);
    expect(ids("news:espn")).toEqual(["news:espn"]);
    expect(planTarget("nflverse:pbp", { weatherSource: "open-meteo" })[0]).toMatchObject({
      job: "nflverse:stats",
    });
    expect(planTarget("nflverse:depth_charts", { weatherSource: "open-meteo" })[0]).toMatchObject({
      job: "nflverse:daily",
    });
    // `all`: news after the player index and the daily job (the matcher's universe), weather last
    const all = ids("all");
    expect(all.indexOf("news:rotowire")).toBeGreaterThan(all.indexOf("espn:players"));
    expect(all.indexOf("news:rotowire")).toBeGreaterThan(all.indexOf("nflverse:roster_weekly"));
    expect(all.filter((x) => x.startsWith("unavailable:"))).toEqual([]);
    // a history twin is wired only once its id is a registered dataset source (no failing run)
    for (const job of [
      "nflverse:stats",
      "nflverse:snaps",
      "nflverse:daily",
      "ffopportunity",
    ] as const)
      for (const t of historyTwinsOf(job)) expect(isDatasetSourceId(t.id)).toBe(true);
    expect(isHistorySource({ id: "nflverse:pbp_history" })).toBe(true);
    expect(isHistorySource(NFLVERSE_SOURCES["nflverse:players"])).toBe(false);
  });

  it("the news inputs: the universe from the player index with crosswalk ids; nothing carried before a file exists", () => {
    sb = sandbox();
    const store = {
      playerUniverse: {
        all: () => ({
          rows: [
            { espn_id: 4239996, full_name: "Travis Etienne Jr.", pro_team_id: 18, position_id: 2 },
            { espn_id: -1, full_name: "bad", pro_team_id: 0, position_id: 2 },
          ],
          stamp: null,
        }),
      },
      repos: {
        crosswalk: {
          get: (id: number) => (id === 4239996 ? { espn_id: id, gsis_id: "00-0036973" } : null),
        },
      },
    } as unknown as Store;
    const opts = newsInputs(() => store, sb.dir, "espn");
    const ctx = { seasons: [2026] } as never;
    const u = opts.universe?.(ctx) ?? [];
    expect(u).toEqual([
      { espn_id: 4239996, full_name: "Travis Etienne Jr.", team: "NO", gsis_id: "00-0036973" },
    ]);
    expect(opts.previous?.(ctx)).toEqual([]);
    expect(newsInputs(() => null, sb.dir, "cbs").universe?.(ctx)).toEqual([]);
  });

  it("the seven registered history twins join their jobs, each gated on the CURRENT season (plan 10 B1)", () => {
    const twins = (["nflverse:stats", "nflverse:snaps", "nflverse:daily", "ffopportunity"] as const)
      .flatMap((j) => historyTwinsOf(j))
      .map((t) => t.id)
      .sort();
    expect(twins).toEqual([
      "ffopportunity:ep_weekly_history",
      "nflverse:depth_charts_history",
      "nflverse:injuries_history",
      "nflverse:pbp_history",
      "nflverse:snap_counts_history",
      "nflverse:stats_player_week_history",
      "nflverse:stats_team_week_history",
    ]);
    const game = (kickoff: string) => ({
      espn_game_id: 1,
      season: 2026,
      week: 5,
      kickoff,
      start_time_tbd: false,
      valid_for_locking: true,
      stats_official: false,
      home_pro_team_id: 1,
      away_pro_team_id: 2,
    });
    const schedule = (rows: ReturnType<typeof game>[] | null) => ({
      games: () => ({
        rows: rows ?? [],
        stamp: rows === null ? null : ({ source: "espn:pro_schedule" } as never),
      }),
      teams: () => ({ rows: [], stamp: null }),
    });
    const now = Date.parse("2026-10-06T12:00:00.000Z");
    const twin = { id: "nflverse:pbp_history" } as never;
    const inSeason = schedule([game("2026-10-08T00:15:00.000Z")]);
    const offSeason = schedule([game("2026-01-04T18:00:00.000Z")]);
    expect(historySkip(twin, inSeason, 2026, now, null)).toBeNull();
    expect(historySkip(twin, offSeason, 2026, now, null)).toEqual({
      status: "skipped",
      source: "nflverse:pbp_history",
      reason: "off_season",
    });
    expect(historySkip(twin, schedule(null), 2026, now, null)).toMatchObject({
      reason: "schedule_never_loaded",
    });
    const throwing = {
      games: () => {
        throw new Error("closed");
      },
      teams: () => ({ rows: [], stamp: null }),
    };
    expect(historySkip(twin, throwing, 2026, now, null)).toMatchObject({
      reason: "schedule_never_loaded",
    });
    // an explicit --seasons runs it; a current-season source is never gated here
    expect(historySkip(twin, offSeason, 2026, now, [2024, 2025])).toBeNull();
    expect(
      historySkip(NFLVERSE_SOURCES["nflverse:players"], offSeason, 2026, now, null),
    ).toBeNull();
  });

  it("seasons: defaults carry the previous season for stats, two for schedules; --seasons is validated", () => {
    sb = sandbox();
    expect(defaultSeasons(NFLVERSE_SOURCES["nflverse:stats_player_week"], 2026)).toEqual([
      2025, 2026,
    ]);
    expect(defaultSeasons(NFLVERSE_SOURCES["nflverse:schedules"], 2026)).toEqual([
      2024, 2025, 2026,
    ]);
    expect(
      defaultSeasons({ ...NFLVERSE_SOURCES["nflverse:players"], id: "nflverse:pbp_history" }, 2026),
    ).toEqual([2024, 2025]);
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
  // Stage C finding refresh-seasons-drops-current: a file is replaced whole, so --seasons only adds
  it("seasonsFor: --seasons adds to a source's own seasons; earlier seasons of a twinned source go to its history file", () => {
    sb = sandbox();
    const id = (s: string) => ({ id: s as DataSource["id"] });
    expect(seasonsFor(id("espn:pro_schedule"), 2026, null)).toEqual({
      seasons: [2026],
      forHistory: [],
    });
    expect(seasonsFor(id("espn:pro_schedule"), 2026, [2025])).toEqual({
      seasons: [2025, 2026],
      forHistory: [],
    });
    expect(seasonsFor(id("espn:players"), 2026, [2024, 2025]).seasons).toEqual([2024, 2025, 2026]);
    expect(seasonsFor(id("nflverse:schedules"), 2026, [2020]).seasons).toEqual([
      2020, 2024, 2025, 2026,
    ]);
    // a twinned current-season file keeps exactly its own seasons; the earlier ones are the twin's
    expect(seasonsFor(id("nflverse:pbp"), 2026, [2023, 2024])).toEqual({
      seasons: [2026],
      forHistory: [2023, 2024],
    });
    expect(seasonsFor(id("nflverse:stats_player_week"), 2026, [2025])).toEqual({
      seasons: [2025, 2026],
      forHistory: [],
    });
    // a twin never takes the current season; it keeps its own two
    expect(seasonsFor(id("nflverse:pbp_history"), 2026, [2023, 2026])).toEqual({
      seasons: [2023, 2024, 2025],
      forHistory: [],
    });
    // nothing is asked for a season after the current one
    expect(seasonsFor(id("espn:pro_schedule"), 2026, [2027]).seasons).toEqual([2026]);
  });
  it("refresh espn:schedule / espn:players --seasons <previous season>: the current season stays loaded", async () => {
    sb = sandbox();
    const root = path.join(ROOT, "fixtures/espn/recorded/season");
    const schedule = JSON.parse(
      readFileSync(path.join(root, "proTeamSchedules_wl.json"), "utf8"),
    ) as Record<string, unknown>;
    const players = JSON.parse(readFileSync(path.join(root, "players_wl.json"), "utf8")) as unknown;
    const f = fakeFetch((url) => {
      if (/seasons\/\d{4}\/players/.test(url)) return json(players);
      const m = /seasons\/(\d{4})/.exec(url);
      return json({ ...schedule, seasonId: m === null ? null : Number(m[1]) });
    });
    // the season views are spaced 60 s apart within a run (politeness): every clock read moves
    // past it, so no real wait happens
    const clock = movingClock("2026-10-11T12:00:00.000Z", 61_000);
    const io = makeIo(sb, { fetch: f.fetch, clock });
    const { config, log } = await loadLenientRuntime(io);
    const run = (target: string, seasons?: string) =>
      refresh(
        io,
        config,
        log,
        {
          target,
          force: false,
          notify: false,
          json: true,
          ...(seasons === undefined ? {} : { seasons }),
        },
        new AbortController().signal,
      );
    const peek = () => {
      const st = openStore(config, io.clock, log, { migrate: true });
      try {
        st.reopenChangedDatasets();
        return {
          games2026: st.datasets.proSchedule.games(2026, null).rows.length,
          games2025: st.datasets.proSchedule.games(2025, null).rows.length,
          state: seasonState(st.datasets.proSchedule, 2026, io.clock.nowMs()),
          players2026: st.playerUniverse.all(2026).rows.length,
          players2025: st.playerUniverse.all(2025).rows.length,
        };
      } finally {
        st.close();
      }
    };
    expect(await run("espn:schedule")).toBe(0);
    expect(await run("espn:players")).toBe(0);
    const before = peek();
    expect(before.games2026).toBeGreaterThan(0);
    expect(before.players2026).toBeGreaterThan(0);
    expect(before.state).toBe("in_season");
    clock.advance(10 * 60_000);
    expect(await run("espn:schedule", "2025")).toBe(0);
    expect(await run("espn:players", "2025")).toBe(0);
    const after = peek();
    expect(after).toMatchObject({
      games2026: before.games2026,
      players2026: before.players2026,
      state: "in_season",
    });
    expect(after.games2025).toBeGreaterThan(0);
    expect(after.players2025).toBeGreaterThan(0);
  });
  it("a single twinned source with earlier --seasons says where they belong (its history file)", async () => {
    sb = sandbox();
    const io = makeIo(sb, { fetch: noNetwork });
    const { config, log } = await loadLenientRuntime(io);
    await refresh(
      io,
      config,
      log,
      { target: "nflverse:pbp", seasons: "2024", force: false, notify: false, json: false },
      new AbortController().signal,
    );
    expect(io.out.text).toContain(
      "note: season(s) 2024 belong to nflverse:pbp_history (the history file;",
    );
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
    ).rejects.toThrow(/refresh: unknown target 'bogus' — the targets are: all \| /);
  });
  // Stage C finding cli-refresh-source-id-not-target
  it("every source id the product reports is a target; a missing, an unknown and an unconfigured one are told apart", async () => {
    sb = sandbox();
    for (const weatherSource of ["open-meteo", "nws"] as const) {
      // the ids `eff status` lists, both toolsets
      for (const id of configuredSources({ weatherSource, toolset: "full" }))
        expect(isRefreshTarget(id), id).toBe(true);
      // every source a job of this build runs (the history files included) — what a tool's
      // freshness warning or the STALE_ONLY hint can name
      for (const step of planTarget("all", { weatherSource }))
        if (step.kind === "source")
          expect(isRefreshTarget(step.source.id), step.source.id).toBe(true);
    }
    expect(
      planTarget("espn:pro_schedule", { weatherSource: "open-meteo" }).map((s) =>
        s.kind === "source" ? s.source.id : s.job,
      ),
    ).toEqual(["espn:pro_schedule"]);
    expect(
      planTarget("weather:open_meteo", { weatherSource: "open-meteo" }).map((s) =>
        s.kind === "source" ? s.source.id : s.job,
      ),
    ).toEqual(["weather:open_meteo"]);
    expect(
      planTarget("nflverse:pbp_history", { weatherSource: "open-meteo" }).map((s) =>
        s.kind === "source" ? s.source.id : s.job,
      ),
    ).toEqual(["nflverse:pbp_history"]);
    expect(targetUsageError(undefined).message).toMatch(/^refresh needs a target: all \| /);
    // a value that is not a plain token is never echoed
    expect(targetUsageError("x\u001b[2Jy").message).toMatch(/^refresh: unknown target — /);
    const io = makeIo(sb, { fetch: noNetwork });
    const { config, log } = await loadLenientRuntime(io);
    const go = (target: string) =>
      refresh(
        io,
        config,
        log,
        { target, force: false, notify: false, json: true },
        new AbortController().signal,
      );
    await expect(go("weather:nws")).rejects.toThrow(
      /weather:nws is not the configured weather source \(EFF_WEATHER_SOURCE=open-meteo\)/,
    );
    const nws = makeIo(sb, { fetch: noNetwork, env: { EFF_WEATHER_SOURCE: "nws" } });
    const n = await loadLenientRuntime(nws);
    await expect(
      refresh(
        nws,
        n.config,
        n.log,
        { target: "weather:open_meteo", force: false, notify: false, json: true },
        new AbortController().signal,
      ),
    ).rejects.toThrow(
      /weather:open_meteo is not the configured weather source \(EFF_WEATHER_SOURCE=nws\)/,
    );
    // the id a stale warning names runs its source (offline here: a failure, not a usage error)
    expect(await go("espn:pro_schedule")).toBe(1);
    expect(JSON.parse(io.out.text)).toMatchObject({
      target: "espn:pro_schedule",
      results: [{ source: "espn:pro_schedule", status: "failed" }],
    });
  });
  it("plan 10 B1: outside the season (no schedule loaded) each Phase-2 job exits 0 in < 2 s, no request", async () => {
    sb = sandbox();
    for (const target of ["nflverse:snaps", "ffopportunity", "sleeper:trending", "news"] as const) {
      const io = makeIo(sb, { fetch: noNetwork });
      const { config, log } = await loadLenientRuntime(io);
      const t0 = performance.now();
      const code = await refresh(
        io,
        config,
        log,
        { target, force: false, notify: false, json: true },
        new AbortController().signal,
      );
      expect(code, target).toBe(0);
      expect(performance.now() - t0, target).toBeLessThan(2000);
      const out = JSON.parse(io.out.text) as { results: { status: string; reason?: string }[] };
      expect(out.results.length, target).toBeGreaterThan(0);
      for (const r of out.results) expect(r.status, target).toBe("skipped");
    }
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

  // Stage C finding cli-refresh-manual-charged-job-cap
  it("a refresh at a terminal (no --notify) is a server request: it never spends the jobs' keyless cap", async () => {
    sb = sandbox();
    const body = JSON.parse(
      readFileSync(
        path.join(ROOT, "fixtures/espn/recorded/season/proTeamSchedules_wl.json"),
        "utf8",
      ),
    ) as unknown;
    const f = fakeFetch(() => json(body));
    // a Sunday of the season (a game day: the schedule job's hourly runs need the allowance)
    const clock = movingClock("2026-10-11T13:00:00.000Z", 3_000);
    const io = makeIo(sb, { fetch: f.fetch, clock });
    const { config, log } = await loadLenientRuntime(io);
    const day = "2026-10-11T00:00:00.000Z";
    let store = openStore(config, io.clock, log, { migrate: true });
    try {
      // the fleet already spent 28 of its 30 keyless requests today
      const start = Date.parse("2026-10-11T01:00:00.000Z");
      for (let i = 0; i < 28; i++)
        expect(
          store.repos.limiter.tryRecord(limiterRequest(start + i * 5_000, true, "job")).ok,
        ).toBe(true);
    } finally {
      store.close();
    }
    const run = (notify: boolean, gameDayCadence = false) =>
      refresh(
        io,
        config,
        log,
        { target: "espn:schedule", force: true, notify, json: true, gameDayCadence },
        new AbortController().signal,
      );
    // the owner refreshes by hand, three times
    for (let i = 0; i < 3; i++) expect(await run(false)).toBe(0);
    store = openStore(config, io.clock, log, { migrate: true });
    try {
      expect(store.repos.limiter.countToday(day)).toEqual({
        server: { cookie: 0, keyless: 3 },
        job: { cookie: 0, keyless: 28 },
      });
    } finally {
      store.close();
    }
    // the launchd run an hour later (its plist's form) keeps its allowance and refreshes
    clock.advance(3_600_000);
    expect(await run(true, true)).toBe(0);
    store = openStore(config, io.clock, log, { migrate: true });
    try {
      expect(store.repos.limiter.countToday(day).job.keyless).toBe(29);
    } finally {
      store.close();
    }
  });
  it("an ESPN season refresh goes through the limiter as a keyless request; offline it fails with ESPN_UPSTREAM_UNAVAILABLE", async () => {
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
