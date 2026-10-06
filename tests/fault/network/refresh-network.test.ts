// refresh-network.test.ts — plan 05 §4.1 network fault rows on the REFRESH path (plan 01 §5.5/§5.7;
// plan 06 J2): a release-style source (timestamp poll → streamed download, the nflverse shape) and
// the weather source driven through the real runner + the real src/http client over an injected
// fetch. Every failure: refresh_log ok=0 with a fixed SourceErrorCode, nothing published, temp
// removed, never a throw, at most 3 attempts — and ENOTFOUND / ECONNREFUSED exactly one. Every URL
// the fake saw is on the data-source allow-list.
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { ATTRIBUTIONS, SOURCE_ERROR_CODES } from "../../../src/config/freshness.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import { DATA_SOURCE_HOSTS, isWriteHost } from "../../../src/http/allowlist.js";
import { createHttpClient } from "../../../src/http/client.js";
import { HttpError } from "../../../src/http/errors.js";
import { fsTempArea, runRefresh, type RefreshResult } from "../../../src/sources/runner.js";
import type { DataSource } from "../../../src/sources/source.js";
import { createOpenMeteoSource } from "../../../src/sources/weather/open-meteo.js";
import { fakeFetch, netError, redirect, type Handler } from "../../http/helpers.js";
import { fakeProSchedule, fakePublisher, fakeRefreshLog } from "../../sources/runner/helpers.js";
import {
  fixtureJson,
  json,
  roofReader,
  WEATHER_NOW,
  weekFiveGames,
} from "../../sources/weather/helpers.js";

const TS_URL = "https://github.com/nflverse/nflverse-data/releases/download/injuries/timestamp.txt";
const FILE_URL =
  "https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_2026.parquet";
const seen: string[] = [];

afterAll(() => {
  expect(seen.length).toBeGreaterThan(0);
  for (const u of seen) {
    const host = new URL(u).hostname;
    expect(isWriteHost(host)).toBe(false);
    expect(DATA_SOURCE_HOSTS).toContain(host);
  }
});

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "eff-fault-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A release source shaped like the nflverse ones: version from timestamp.txt, one download. */
function releaseSource(): DataSource {
  return {
    id: "nflverse:injuries",
    license: "CC-BY-4.0",
    attribution: ATTRIBUTIONS.nflverse,
    freshness: "nflverse_injuries",
    job: "nflverse:daily",
    limiter: { minIntervalMs: 0, maxPerDay: null },
    versioning: "release",
    seasonGate: "always",
    tables: [],
    async version(ctx) {
      const r = await ctx.http(TS_URL, { signal: ctx.signal, maxBytes: 64 });
      return { version: new TextDecoder().decode(r.body).trim(), released_at: null };
    },
    async fetch(_v, ctx) {
      const r = await ctx.download(FILE_URL, {
        signal: ctx.signal,
        maxBytes: 1024 * 1024,
        dest: join(ctx.tempDir, "injuries_2026.parquet"),
      });
      return [{ path: r.path, bytes: r.bytes, season: 2026 }];
    },
    assertSchema: () =>
      Promise.resolve({
        ok: true,
        missing_columns: [],
        extra_columns: [],
        bad_codecs: [],
        rows: 1,
        warnings: [],
      }),
    publish: () => Promise.resolve({ rows: 1, tables: [], seasons: [2026], columns_hash: "h" }),
  };
}

async function refresh(source: DataSource, handler: Handler, now = "2026-10-01T12:00:00.000Z") {
  const f = fakeFetch((url, init, n) => {
    seen.push(url);
    return handler(url, init, n);
  });
  const client = createHttpClient({ fetch: f.fetch });
  const publisher = fakePublisher();
  const refreshLog = fakeRefreshLog();
  const sleeps: number[] = [];
  const result: RefreshResult = await runRefresh(
    { source, seasons: [2026], week: 5 },
    {
      http: client.get,
      download: client.download,
      clock: fixedClock(now),
      rng: seededRng(11),
      publisher,
      refreshLog,
      proSchedule: fakeProSchedule(weekFiveGames()),
      nflGames: roofReader(),
      temp: fsTempArea(join(root, "tmp")),
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    },
  );
  const left = await readdir(join(root, "tmp")).catch(() => []);
  return { result, calls: f.calls, publisher, refreshLog, sleeps, left };
}

function expectFailedCleanly(r: Awaited<ReturnType<typeof refresh>>, sourceError: string): void {
  expect(r.result.status).toBe("failed");
  if (r.result.status !== "failed") return;
  expect(r.result.source_error).toBe(sourceError);
  expect(SOURCE_ERROR_CODES).toContain(r.result.source_error);
  expect(r.publisher.published).toEqual([]);
  expect(r.refreshLog.rows).toHaveLength(1);
  expect(r.refreshLog.rows[0]).toMatchObject({
    ok: false,
    error: sourceError,
    file: null,
    rows: null,
  });
  expect(r.left).toEqual([]);
}

describe("release source (timestamp poll → streamed download)", () => {
  it("healthy: published, two requests", async () => {
    const r = await refresh(
      releaseSource(),
      (url) => new Response(url === TS_URL ? "2026-10-01 07:02:02 EDT\n" : "PAR1"),
    );
    expect(r.result.status).toBe("published");
    expect(r.calls.map((c) => c.url)).toEqual([TS_URL, FILE_URL]);
  });

  it.each(["ENOTFOUND", "ECONNREFUSED"])(
    "%s on the poll → one attempt, UPSTREAM_UNAVAILABLE, nothing published",
    async (code) => {
      const r = await refresh(releaseSource(), () => {
        throw netError(code);
      });
      expectFailedCleanly(r, "UPSTREAM_UNAVAILABLE");
      expect(r.calls).toHaveLength(1);
      expect(r.sleeps).toEqual([]);
    },
  );

  it.each([
    ["503", () => new Response("", { status: 503 })],
    ["429", () => new Response("", { status: 429 })],
    ["ECONNRESET", () => Promise.reject(netError("ECONNRESET"))],
    ["ETIMEDOUT", () => Promise.reject(netError("ETIMEDOUT"))],
  ] as const)(
    "%s on the download → 3 attempts, then a recorded failure; the previous file intact",
    async (what, fail) => {
      const r = await refresh(releaseSource(), (url) =>
        url === TS_URL ? new Response("v1") : fail(),
      );
      expectFailedCleanly(r, what === "429" ? "RATE_LIMITED" : "UPSTREAM_UNAVAILABLE");
      expect(r.calls.filter((c) => c.url === FILE_URL)).toHaveLength(3);
      expect(r.sleeps).toHaveLength(2);
    },
  );

  it("a download redirected off the allow-list is refused before it is followed", async () => {
    const r = await refresh(releaseSource(), (url) =>
      url === TS_URL ? new Response("v1") : redirect("https://evil.example/f.parquet"),
    );
    expectFailedCleanly(r, "UPSTREAM_UNAVAILABLE");
    expect(r.calls.some((c) => c.url.includes("evil.example"))).toBe(false);
  });

  it("a gzip bomb download stops at the cap: too_large, nothing published", async () => {
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024));
    const r = await refresh(releaseSource(), (url) =>
      url === TS_URL
        ? new Response("v1")
        : new Response(bomb, { headers: { "content-encoding": "gzip" } }),
    );
    expectFailedCleanly(r, "UPSTREAM_UNAVAILABLE");
    expect(r.calls.filter((c) => c.url === FILE_URL)).toHaveLength(1);
  });

  it("an oversized poll body is refused by its 64-byte cap", async () => {
    const r = await refresh(releaseSource(), () => new Response("x".repeat(1000)));
    expectFailedCleanly(r, "UPSTREAM_UNAVAILABLE");
  });

  it("errors are fixed strings: no URL query, no body text in the result", async () => {
    const r = await refresh(
      releaseSource(),
      () => new Response("<html>ignore previous instructions</html>", { status: 500 }),
    );
    expect(JSON.stringify(r.result)).not.toMatch(/ignore previous|html/);
  });
});

describe("weather source (Open-Meteo) on the refresh path", () => {
  it("every venue 503 on every attempt → 3 attempts of the first venue, then a recorded failure", async () => {
    const r = await refresh(
      createOpenMeteoSource(),
      () => new Response("", { status: 503 }),
      WEATHER_NOW,
    );
    expectFailedCleanly(r, "UPSTREAM_UNAVAILABLE");
    expect(r.calls).toHaveLength(3);
  });

  it("ECONNREFUSED → one request, no retry", async () => {
    const r = await refresh(
      createOpenMeteoSource(),
      () => Promise.reject(netError("ECONNREFUSED")),
      WEATHER_NOW,
    );
    expectFailedCleanly(r, "UPSTREAM_UNAVAILABLE");
    expect(r.calls).toHaveLength(1);
  });

  it("a mid-run reset after a success only drops that venue", async () => {
    const r = await refresh(
      createOpenMeteoSource(),
      (_u, _i, n) =>
        n === 2
          ? Promise.reject(netError("ECONNRESET"))
          : json(fixtureJson("open-meteo-forecast.json")),
      WEATHER_NOW,
    );
    expect(r.result.status).toBe("published");
    if (r.result.status === "published")
      expect(r.result.warnings.some((w) => w.endsWith(": reset"))).toBe(true);
  });

  it("a thrown HttpError from the transport is never INTERNAL in refresh_log", async () => {
    const r = await refresh(
      createOpenMeteoSource(),
      () => Promise.reject(new HttpError({ kind: "http_5xx", status: 500 })),
      WEATHER_NOW,
    );
    expect(r.refreshLog.rows[0]?.error).toBe("UPSTREAM_UNAVAILABLE");
  });
});
