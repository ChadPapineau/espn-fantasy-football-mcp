// phase2-history.test.ts — the history twins and the Phase-2 release plumbing (plan 10 §3.2 "two prior
// nflverse seasons for the soft backtests" [A-3]; tables.ts HISTORY_DATASET_SOURCES; plan 01 §5.5
// version poll → skip): a history version is the UTC month + the seasons and costs NO request (so an
// unchanged run is instant in or out of season), a history run refuses the current season, a past
// season's 404 always fails (never "not published"), a current-season 404 within its grace period is
// reported as not published; the contract's expected columns per season; the shared URL builder and
// stamp reader refuse unsafe names and unparseable stamps.
import { afterEach, describe, expect, it } from "vitest";
import { epWeeklyHistorySource } from "../../../src/sources/ffopportunity/index.js";
import {
  EXPECTED_COLUMNS,
  NFLVERSE_HISTORY_SOURCES,
  PHASE_2_HISTORY_TWIN,
  PHASE_2_PARQUET_CURRENT,
  expectedColumnsFor,
  historyBucket,
  historyRefreshSeasons,
  historyRunSeasons,
  historyVersion,
  pbpSource,
  phase1HistorySource,
  releaseAssetUrl,
  snapCountsSource,
  statsTeamWeekSource,
  type HistoryDataSource,
} from "../../../src/sources/nflverse/index.js";
import { releaseVersionAt } from "../../../src/sources/nflverse/release.js";
import { injuriesSource } from "../../../src/sources/nflverse/injuries.js";
import { HISTORY_OF, phase2UpstreamKinds } from "../../../src/store/datasets/tables.js";
import { REL } from "./helpers/fixtures.js";
import { makeCtx, proGame, type Ctx } from "./helpers/harness.js";
import { phase2FixtureRoutes } from "./helpers/phase2-fixtures.js";

const open: Ctx[] = [];
afterEach(() => {
  for (const c of open.splice(0)) c.cleanup();
});
const ctxOf = (seasons: number[], o: Parameters<typeof makeCtx>[1] = {}): Ctx => {
  const c = makeCtx(seasons, o);
  open.push(c);
  return c;
};
const HISTORY: readonly HistoryDataSource[] = [
  ...Object.values(NFLVERSE_HISTORY_SOURCES),
  epWeeklyHistorySource,
];

describe("history versions: the month and the seasons, no request", () => {
  it("every twin's version is h<YYYY-MM>_<seasons> without touching the network", async () => {
    for (const h of HISTORY) {
      const c = ctxOf([2024, 2025], { routes: new Map() });
      const v = await h.version(c.ctx);
      expect(v, h.id).toEqual({ version: "h2026-10_2024-2025", released_at: null });
      expect(c.calls, h.id).toEqual([]);
    }
  });

  it("the bucket rolls over with the UTC month, not the local day", () => {
    expect(historyBucket(Date.parse("2026-10-31T23:59:59.999Z"))).toBe("2026-10");
    expect(historyBucket(Date.parse("2026-11-01T00:00:00.000Z"))).toBe("2026-11");
    expect(historyBucket(Date.parse("2027-01-15T12:00:00.000Z"))).toBe("2027-01");
    const a = ctxOf([2024, 2025], { now: "2026-10-31T23:00:00.000Z" });
    const b = ctxOf([2024, 2025], { now: "2026-11-01T01:00:00.000Z" });
    expect(historyVersion("x", a.ctx).version).not.toBe(historyVersion("x", b.ctx).version);
  });

  it("the prior seasons a refresh covers follow config defaultSeason (July rollover)", () => {
    expect(historyRefreshSeasons(Date.parse("2026-10-06T12:00:00Z"))).toEqual([2024, 2025]);
    expect(historyRefreshSeasons(Date.parse("2027-03-01T12:00:00Z"))).toEqual([2024, 2025]);
    expect(historyRefreshSeasons(Date.parse("2027-07-01T00:00:00Z"))).toEqual([2025, 2026]);
  });

  it("a history run refuses the current season (or later) and malformed seasons", async () => {
    for (const bad of [[2026], [2025, 2026], [2027], [1998], [2025.5]]) {
      const c = ctxOf(bad);
      expect(() => historyRunSeasons("nflverse:pbp_history", c.ctx), String(bad)).toThrow();
      await expect(
        NFLVERSE_HISTORY_SOURCES["nflverse:pbp_history"].version(c.ctx),
      ).rejects.toThrow();
    }
    const c = ctxOf([2025, 2024, 2025]);
    expect(historyRunSeasons("x", c.ctx)).toEqual([2025, 2024]);
    expect(() => historyRunSeasons("nflverse:pbp_history", ctxOf([2026]).ctx)).toThrow(
      /prior seasons only \(season 2026 is not before 2026\)/,
    );
  });

  it("history fetch refuses the current season too (defence in depth) and never asks for its file", async () => {
    for (const h of HISTORY) {
      const c = ctxOf([2026], { routes: phase2FixtureRoutes() });
      await expect(h.fetch({ version: "v", released_at: null }, c.ctx), h.id).rejects.toThrow(
        /prior seasons only/,
      );
      expect(c.calls, h.id).toEqual([]);
    }
  });
});

describe("missing upstream files", () => {
  it("a past season's 404 fails the history run and leaves nothing behind", async () => {
    const routes = phase2FixtureRoutes();
    routes.delete(`${REL}/pbp/play_by_play_2024.parquet`);
    const c = ctxOf([2024, 2025], { routes });
    await expect(
      NFLVERSE_HISTORY_SOURCES["nflverse:pbp_history"].fetch(
        { version: "v", released_at: null },
        c.ctx,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(c.unpublished).toEqual([]);
  });

  it("a new season's 404 before it is under way is reported as not published", async () => {
    const c = ctxOf([2027], {
      now: "2027-08-01T12:00:00.000Z",
      routes: new Map(),
      proGames: [proGame(2027, 1, "2027-09-10T00:20:00.000Z")],
    });
    const files = await snapCountsSource.fetch({ version: "v", released_at: null }, c.ctx);
    expect(files).toEqual([]);
    expect(c.unpublished).toEqual([2027]);
  });

  it("the same 404 past the grace period is a failure", async () => {
    const c = ctxOf([2026], {
      routes: new Map(),
      proGames: [proGame(2026, 1, "2026-09-10T00:20:00.000Z")],
    });
    await expect(
      statsTeamWeekSource.fetch({ version: "v", released_at: null }, c.ctx),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("no seasons → no request", async () => {
    const c = ctxOf([]);
    expect(await pbpSource.fetch({ version: "v", released_at: null }, c.ctx)).toEqual([]);
    expect(c.calls).toEqual([]);
  });
});

describe("the current sources' version (timestamp.txt)", () => {
  it("reads the tag's stamp: one 24-byte request", async () => {
    const c = ctxOf([2026], { routes: phase2FixtureRoutes() });
    expect(await pbpSource.version(c.ctx)).toEqual({
      version: "20261006T155334Z_2026",
      released_at: "2026-10-06T15:53:34.000Z",
    });
    expect(c.calls).toEqual([`${REL}/pbp/timestamp.txt`]);
  });

  it("unreachable → null; unparseable or non-UTF-8 → schema_mismatch", async () => {
    const enc = new TextEncoder();
    const stamp = `${REL}/snap_counts/timestamp.txt`;
    expect(await snapCountsSource.version(ctxOf([2026], { routes: new Map() }).ctx)).toBeNull();
    for (const body of [enc.encode("yesterday"), new Uint8Array([0xff, 0xfe])]) {
      const c = ctxOf([2026], { routes: new Map([[stamp, body]]) });
      await expect(snapCountsSource.version(c.ctx)).rejects.toMatchObject({
        code: "schema_mismatch",
      });
    }
    const c = ctxOf([2026], { routes: new Map([[stamp, enc.encode("2026-10-06 07:01:45 EDT")]]) });
    expect(
      await releaseVersionAt(stamp, "x", c.ctx, [2026], () => null).catch((e: unknown) => e),
    ).toMatchObject({ message: "x: unparseable timestamp.txt" });
  });

  it("asset URLs: plain names only", () => {
    expect(releaseAssetUrl("https://h/releases/download", "pbp", "a_1.parquet")).toBe(
      "https://h/releases/download/pbp/a_1.parquet",
    );
    for (const [tag, file] of [
      ["pbp", "../x"],
      ["../pbp", "x"],
      ["pbp", "a/b"],
      ["p b", "x"],
      ["pbp", ""],
      ["pbp", "x".repeat(81)],
    ] as const)
      expect(() => releaseAssetUrl("https://h", tag, file), `${tag}/${file}`).toThrow(/unsafe/);
  });
});

describe("expected columns per contract file and season", () => {
  it("the Phase-2 kinds of the contract; null where no layout covers the season", () => {
    for (const id of PHASE_2_PARQUET_CURRENT) {
      expect(expectedColumnsFor(id, 2026), id).toEqual(phase2UpstreamKinds(id, 2026));
      expect(expectedColumnsFor(id, null), id).toBeNull();
      expect(expectedColumnsFor(id, 2026.5), id).toBeNull();
    }
    expect(expectedColumnsFor("nflverse:depth_charts", 2024)).toBeNull();
    expect(expectedColumnsFor("nflverse:depth_charts_history", 2024)).toMatchObject({
      depth_team: "string",
      club_code: "string",
    });
    expect(expectedColumnsFor("nflverse:depth_charts_history", 2025)).toMatchObject({
      dt: "string",
      espn_id: "string",
    });
    expect(expectedColumnsFor("nflverse:stats_player_week_history", 2024)).toBe(
      EXPECTED_COLUMNS["nflverse:stats_player_week"],
    );
    expect(expectedColumnsFor("nflverse:injuries_history", 2025)).toBe(
      EXPECTED_COLUMNS["nflverse:injuries"],
    );
    expect(expectedColumnsFor("sleeper:trending", 2026)).toBeNull();
  });

  it("PHASE_2_HISTORY_TWIN is tables.ts HISTORY_OF, inverted", () => {
    for (const [cur, h] of Object.entries(PHASE_2_HISTORY_TWIN)) expect(HISTORY_OF[h]).toBe(cur);
  });

  it("a Phase-1 twin must repeat its source", () => {
    expect(() => phase1HistorySource("nflverse:pbp_history", injuriesSource)).toThrow(
      /does not repeat/,
    );
  });
});
