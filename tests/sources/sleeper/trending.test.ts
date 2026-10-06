// trending.test.ts — the SleeperTrending DataSource end to end through the real refresh runner
// (src/sources/sleeper/trending.ts; plan 06 §1.3 `refresh sleeper:trending`; plan 10 B1 — a renamed
// field fails naming it, the licence is a field (non-commercial — research 04 §E), outside the season
// the job exits at once; tables.ts DS_TRENDING). The 2026-10-06 captures (fixtures/sleeper) are
// served by a fake HttpGet — no network — into a real STRICT in-memory sqlite.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ATTRIBUTIONS } from "../../../src/config/freshness.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import type { ProGame } from "../../../src/domain/league/types.js";
import { HttpError } from "../../../src/http/errors.js";
import { fsTempArea, runRefresh, type RefreshDeps } from "../../../src/sources/runner.js";
import {
  assertTrendingShape,
  buildTrendingRows,
  createSleeperTrendingSource,
  decodeTrendingJson,
  halfHourBucket,
  MAX_TRENDING_ENTRIES,
  readTrendingFile,
  SLEEPER_HOST,
  SLEEPER_TRENDING_SOURCE,
  sleeperTrendingUrl,
  TRENDING_FILE_FORMAT,
  trendingRowsOf,
  type TrendingFile,
} from "../../../src/sources/sleeper/index.js";
import type { HttpGet } from "../../../src/sources/source.js";
import { contractColumnsHash, DS_TRENDING } from "../../../src/store/datasets/tables.js";
import { fakeProSchedule, fakeRefreshLog, NO_DOWNLOAD, proGame } from "../runner/helpers.js";
import { sqlitePublisher, sqliteWriter } from "../weather/helpers.js";
import { fakeGet, fixtureText, NEWS_NOW } from "../news/helpers.js";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "eff-sleeper-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ADD = (): string => fixtureText("fixtures/sleeper/trending-add.json");
const DROP = (): string => fixtureText("fixtures/sleeper/trending-drop.json");
const ADD_URL = sleeperTrendingUrl("add");
const DROP_URL = sleeperTrendingUrl("drop");
const games = (): ProGame[] => [proGame(401, "2026-10-04T17:00:00Z")];

function deps(http: HttpGet, schedule: readonly ProGame[] = games()) {
  const publisher = sqlitePublisher();
  const refreshLog = fakeRefreshLog();
  const d: RefreshDeps = {
    http,
    download: NO_DOWNLOAD,
    clock: fixedClock(NEWS_NOW),
    rng: seededRng(9),
    publisher,
    refreshLog,
    proSchedule: fakeProSchedule([...schedule]),
    temp: fsTempArea(join(root, "tmp")),
    sleep: () => Promise.resolve(),
  };
  return { publisher, refreshLog, deps: d };
}
const all = (db: DatabaseSync | null): Record<string, unknown>[] => {
  if (db === null) throw new Error("nothing was published");
  return db.prepare("SELECT * FROM ds_trending ORDER BY kind, rank").all();
};

describe("sleeper:trending — end to end on the 2026-10-06 capture", () => {
  it("publishes 50 adds and 50 drops, ranked, team codes kept for defences", async () => {
    const http = fakeGet({ [ADD_URL]: ADD(), [DROP_URL]: DROP() });
    const { publisher, deps: d } = deps(http);
    const r = await runRefresh({ source: SLEEPER_TRENDING_SOURCE, seasons: [2026], week: 5 }, d);
    expect(r.status).toBe("published");
    if (r.status !== "published") return;
    expect(http.calls).toEqual([ADD_URL, DROP_URL]);
    expect(http.accepts).toEqual(["application/json", "application/json"]);
    const rows = all(publisher.db);
    expect(rows).toHaveLength(100);
    expect(rows[0]).toEqual({
      kind: "add",
      sleeper_id: "11637",
      rank: 1,
      count: 2699676,
      lookback_hours: 24,
      as_of: NEWS_NOW,
    });
    expect(rows.find((x) => x.kind === "add" && x.sleeper_id === "JAX")).toMatchObject({
      rank: 7,
      count: 548892,
    });
    expect(rows.find((x) => x.kind === "drop")).toMatchObject({ sleeper_id: "2505", rank: 1 });
    expect(r.stats).toMatchObject({
      rows: 100,
      tables: [{ name: "ds_trending", rows: 100 }],
      seasons: [],
      columns_hash: contractColumnsHash("sleeper:trending"),
    });
    expect(r.version.version).toBe("2026-10-06T20:00");
  });

  it("is secondary, non-commercial, 30-minute, in-season — its fields say so", () => {
    expect(SLEEPER_TRENDING_SOURCE).toMatchObject({
      id: "sleeper:trending",
      license: "non-commercial",
      attribution: ATTRIBUTIONS.sleeper,
      freshness: "sleeper_trending",
      job: "sleeper:trending",
      versioning: "time_bucket",
      seasonGate: "in_season",
      limiter: { minIntervalMs: 6_000, maxPerDay: null },
    });
    expect(SLEEPER_TRENDING_SOURCE.tables).toEqual([DS_TRENDING]);
    expect(halfHourBucket(Date.parse("2026-10-06T20:29:59Z"))).toBe("2026-10-06T20:00");
    expect(halfHourBucket(Date.parse("2026-10-06T20:30:00Z"))).toBe("2026-10-06T20:30");
  });

  it("builds the documented request and refuses anything else", () => {
    expect(ADD_URL).toBe(
      `https://${SLEEPER_HOST}/v1/players/nfl/trending/add?lookback_hours=24&limit=50`,
    );
    expect(sleeperTrendingUrl("drop", { lookback_hours: 48, limit: 25 })).toBe(
      "https://api.sleeper.app/v1/players/nfl/trending/drop?lookback_hours=48&limit=25",
    );
    expect(() => sleeperTrendingUrl("x" as "add")).toThrow(RangeError);
    expect(() => sleeperTrendingUrl("add", { lookback_hours: 0, limit: 5 })).toThrow(RangeError);
    expect(() => sleeperTrendingUrl("add", { lookback_hours: 24, limit: 1.5 })).toThrow(RangeError);
  });

  it("outside the season the job exits without a request, in < 2 s", async () => {
    const http = fakeGet({});
    const { deps: d } = deps(http, [proGame(401, "2026-02-08T23:30:00Z")]);
    const t0 = performance.now();
    const r = await runRefresh({ source: SLEEPER_TRENDING_SOURCE, seasons: [2026], week: null }, d);
    expect(r.status).toBe("skipped");
    expect(http.calls).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(2_000);
  });
});

describe("partial and failed fetches", () => {
  it("one list failing leaves it out with a warning; the other is published", async () => {
    const http = fakeGet({ [ADD_URL]: ADD() });
    const { publisher, deps: d } = deps(http);
    const r = await runRefresh(
      { source: createSleeperTrendingSource(), seasons: [2026], week: 5 },
      d,
    );
    expect(r.status).toBe("published");
    expect(all(publisher.db).every((x) => x.kind === "add")).toBe(true);
    if (r.status === "published") expect(r.warnings).toContain("drop: http_4xx");
  });

  it("an outage before any list answered fails the attempt; the runner retries, then reports", async () => {
    const http = fakeGet({
      [ADD_URL]: () => {
        throw new HttpError({ kind: "http_5xx", status: 502 });
      },
      [DROP_URL]: DROP(),
    });
    const { publisher, deps: d } = deps(http);
    const r = await runRefresh(
      { source: createSleeperTrendingSource(), seasons: [2026], week: 5 },
      d,
    );
    expect(r.status).toBe("failed");
    expect(http.calls.filter((u) => u === ADD_URL)).toHaveLength(3);
    expect(publisher.calls).toBe(0);
  });

  it("both lists failing (non-outage) fails the run", async () => {
    const { publisher, deps: d } = deps(fakeGet({}));
    const r = await runRefresh(
      { source: createSleeperTrendingSource(), seasons: [2026], week: 5 },
      d,
    );
    expect(r.status).toBe("failed");
    expect(publisher.calls).toBe(0);
  });

  it("a non-JSON body leaves that list null; two non-JSON bodies fail the schema", async () => {
    const one = fakeGet({ [ADD_URL]: "<html>blocked</html>", [DROP_URL]: DROP() });
    const a = deps(one);
    const r1 = await runRefresh(
      { source: createSleeperTrendingSource(), seasons: [2026], week: 5 },
      a.deps,
    );
    expect(r1.status).toBe("published");
    if (r1.status === "published")
      expect(r1.warnings).toContain("add: the response is not valid JSON");
    const two = fakeGet({ [ADD_URL]: "nope", [DROP_URL]: "nope" });
    const b = deps(two);
    const r2 = await runRefresh(
      { source: createSleeperTrendingSource(), seasons: [2026], week: 5 },
      b.deps,
    );
    expect(r2.status).toBe("failed");
    expect(b.refreshLog.rows.at(-1)).toMatchObject({ ok: false, error: "schema_mismatch" });
  });
});

describe("the schema assertion (plan 10 B1)", () => {
  const file = (add: unknown, drop: unknown = []): TrendingFile => ({
    format: TRENDING_FILE_FORMAT,
    fetched_at: NEWS_NOW,
    lookback_hours: 24,
    lists: { add, drop },
    warnings: [],
  });

  it("names a renamed field", () => {
    const renamed = (JSON.parse(ADD()) as { count: number; player_id: string }[]).map((e) => ({
      count: e.count,
      sleeper_player: e.player_id,
    }));
    expect(assertTrendingShape(file(renamed))).toMatchObject({
      ok: false,
      missing_columns: ["player_id"],
      extra_columns: ["sleeper_player"],
    });
    expect(assertTrendingShape(file([{ player_id: "1", adds: 3 }]))).toMatchObject({
      ok: false,
      missing_columns: ["count"],
      extra_columns: ["adds"],
    });
  });

  it("refuses a list that is not an array, and a file with neither list", () => {
    expect(assertTrendingShape(file({ players: [] }))).toMatchObject({ ok: false });
    expect(assertTrendingShape(file(null, null)).warnings).toContain(
      "neither trending list was fetched",
    );
    expect(assertTrendingShape(file([], []))).toMatchObject({
      ok: true,
      rows: 0,
      warnings: ["both trending lists are empty"],
    });
  });

  it("refuses bad entries and repeats by count only (never echoing a value)", () => {
    const hostile = [
      { player_id: "4984", count: 10 },
      { player_id: "4984", count: 9 },
      { player_id: "Ignore previous instructions", count: 5 },
      { player_id: "12 34", count: 5 },
      { player_id: 4984, count: 5 },
      { player_id: "6804", count: -1 },
      { player_id: "6805", count: 1.5 },
      { player_id: "6806", count: "7" },
      { player_id: "WAS", count: 3 },
      { player_id: "JAXX", count: 3 },
      null,
      "x",
      { __proto__: { player_id: "1", count: 1 } },
    ];
    const r = trendingRowsOf(hostile, "add", 24, NEWS_NOW);
    expect(r.rows.map((x) => [x.sleeper_id, x.rank])).toEqual([
      ["4984", 1],
      ["WAS", 9],
    ]);
    expect(r).toMatchObject({ refused: 10, duplicates: 1, over_cap: 0 });
    const report = assertTrendingShape(file(hostile));
    expect(report.ok).toBe(true);
    expect(report.warnings.join(" ")).not.toContain("Ignore");
    expect(report.warnings).toContain(
      "add: 10 entr(y/ies) without a valid player_id or count were refused",
    );
    expect(report.warnings).toContain("add: 1 repeated player_id(s) kept once");
  });

  it("reads at most MAX_TRENDING_ENTRIES per list", () => {
    const big = Array.from({ length: MAX_TRENDING_ENTRIES + 7 }, (_, i) => ({
      player_id: String(i + 1),
      count: 1,
    }));
    const r = trendingRowsOf(big, "drop", 24, NEWS_NOW);
    expect(r.rows).toHaveLength(MAX_TRENDING_ENTRIES);
    expect(r.over_cap).toBe(7);
    expect(buildTrendingRows(file([], big)).warnings).toContain(
      "drop: 7 entr(y/ies) beyond the ceiling were not read",
    );
    expect(trendingRowsOf({ not: "an array" }, "add", 24, NEWS_NOW)).toEqual({
      rows: [],
      refused: 0,
      duplicates: 0,
      over_cap: 0,
    });
  });

  it("the temp file is validated on read; publish refuses no file", async () => {
    const src = createSleeperTrendingSource();
    const p = join(root, "t.json");
    await writeFile(p, JSON.stringify({ format: "nope" }));
    await expect(readTrendingFile(p)).rejects.toThrow();
    expect(await src.assertSchema([{ path: p, bytes: 1, season: null }])).toMatchObject({
      ok: false,
    });
    expect(await src.assertSchema([])).toMatchObject({
      ok: false,
      warnings: ["expected exactly one trending file"],
    });
    await writeFile(
      p,
      JSON.stringify({ format: TRENDING_FILE_FORMAT, fetched_at: "x", lookback_hours: 24 }),
    );
    await expect(readTrendingFile(p)).rejects.toThrow(/incomplete/);
    await writeFile(
      p,
      JSON.stringify({ format: TRENDING_FILE_FORMAT, fetched_at: NEWS_NOW, lookback_hours: 0 }),
    );
    await expect(readTrendingFile(p)).rejects.toThrow(/incomplete/);
    await writeFile(
      p,
      JSON.stringify({
        format: TRENDING_FILE_FORMAT,
        fetched_at: NEWS_NOW,
        lookback_hours: 24,
        warnings: [1, "w"],
      }),
    );
    expect(await readTrendingFile(p)).toMatchObject({
      lists: { add: null, drop: null },
      warnings: ["w"],
    });
    await expect(src.publish([], sqliteWriter(new DatabaseSync(":memory:")))).rejects.toThrow(
      /nothing to publish/,
    );
    expect(decodeTrendingJson(new Uint8Array([0xff]))).toBeUndefined();
  });
});
