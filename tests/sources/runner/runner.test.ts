// runner.test.ts — every branch of the refresh runner (plan 01 §5.5/§5.7; plan 06 §1.3, J2): the
// pipeline version → fetch → assertSchema → publish; a failure PUBLISHES NOTHING and leaves one
// ok=0 refresh_log row with a fixed SourceErrorCode; unchanged (release and time-bucket), schema
// failures, publish outcomes (incl. the store's job_locked / publish_unrecorded), retryable vs
// never-retried errors (ENOTFOUND fails fast), season gating on the ESPN pro schedule, temp cleanup
// on every path, aborts, seeded jitter. Fakes only; temp dirs under os.tmpdir(); no network.
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SOURCE_ERROR_CODES } from "../../../src/config/freshness.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import { HttpError } from "../../../src/http/errors.js";
import {
  datasetFilePresent,
  DEFAULT_BASE_DELAY_MS,
  describeSchemaFailure,
  fsTempArea,
  isRefreshSuccess,
  JOB_LOCKED_ERROR,
  PUBLISH_UNRECORDED_ERROR,
  PUBLISHED_UNRECORDED_MESSAGE,
  runRefresh,
  runRefreshJob,
  schemaErrorCode,
  seasonState,
  sourceErrorFor,
  type RefreshDeps,
  type RefreshResult,
  type TempArea,
} from "../../../src/sources/runner.js";
import type { HttpDownload, HttpGet, SchemaReport } from "../../../src/sources/source.js";
import { PUBLISH_ALREADY_CURRENT } from "../../../src/store/types.js";
import { captureLog, netError } from "../../http/helpers.js";
import {
  fakeProSchedule,
  fakePublisher,
  fakeRefreshLog,
  fakeSource,
  NO_DOWNLOAD,
  NO_HTTP,
  okRow,
  proGame,
  STATS,
} from "./helpers.js";

const NOW = "2026-10-01T12:00:00.000Z";
let root = "";
let sleeps: number[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "eff-runner-"));
  sleeps = [];
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type Deps = RefreshDeps & {
  publisher: ReturnType<typeof fakePublisher>;
  refreshLog: ReturnType<typeof fakeRefreshLog>;
};

function deps(over: Partial<RefreshDeps> = {}): Deps {
  const base = {
    http: NO_HTTP,
    download: NO_DOWNLOAD,
    clock: fixedClock(NOW),
    rng: seededRng(7),
    publisher: fakePublisher(),
    refreshLog: fakeRefreshLog(),
    proSchedule: fakeProSchedule([proGame(401, "2026-10-04T17:00:00.000Z")]),
    temp: fsTempArea(join(root, "tmp")),
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    // the fakes publish no real file: the current one reads present unless a test says otherwise
    checkDataset: () => true,
  };
  return { ...base, ...over } as Deps;
}

async function tmpLeft(): Promise<string[]> {
  try {
    return await readdir(join(root, "tmp"));
  } catch {
    return [];
  }
}

function expectStatus<S extends RefreshResult["status"]>(
  r: RefreshResult,
  s: S,
): asserts r is Extract<RefreshResult, { status: S }> {
  expect(r.status).toBe(s);
}

describe("happy path", () => {
  it("version → fetch → assert → publish; temp removed; the publisher records, not the runner", async () => {
    const src = fakeSource();
    const d = deps();
    const r = await runRefresh({ source: src, seasons: [2024, 2025, 2026], week: null }, d);
    expectStatus(r, "published");
    expect(r.stats).toEqual(STATS);
    expect(r.file_version).toBe("2026-09-30T13:36:27Z");
    expect(r.warnings).toEqual(["extra column new_col"]);
    expect(r.attempts).toBe(2);
    expect(d.publisher.published).toEqual([
      {
        source: "nflverse:injuries",
        version: "2026-09-30T13:36:27Z",
        released: "2026-09-30T13:36:27.000Z",
      },
    ]);
    expect(d.publisher.options).toEqual([{ skipIfCurrent: true }]);
    expect(src.calls).toEqual({ version: 1, fetch: 1, assert: 1, publish: 1 });
    expect(d.refreshLog.rows).toEqual([]);
    expect(await tmpLeft()).toEqual([]);
    const ctx = src.contexts[1];
    expect(ctx?.seasons).toEqual([2024, 2025, 2026]);
    expect(ctx?.tempDir).toMatch(/nflverse_injuries-/);
    expect(ctx?.datasets.proSchedule).toBe(d.proSchedule);
    expect(ctx?.datasets.nflGames).toBeUndefined();
    expect(isRefreshSuccess(r)).toBe(true);
  });

  it("passes the optional nflGames reader through to the source", async () => {
    const src = fakeSource();
    const nflGames = {
      games: () => ({ rows: [], stamp: null }),
      byEspnGameId: () => ({ rows: [], stamp: null }),
    };
    await runRefresh({ source: src, seasons: [2026], week: 5 }, deps({ nflGames }));
    expect(src.contexts[0]?.datasets.nflGames).toBe(nflGames);
    expect(src.contexts[0]?.week).toBe(5);
  });

  it("wraps http and download with the source's limiter (every request spaced, start to start)", async () => {
    const calls: string[] = [];
    const http: HttpGet = (url) => {
      calls.push(url);
      return Promise.resolve({ status: 200, body: new Uint8Array(), headers: {}, final_url: url });
    };
    const download: HttpDownload = (url, o) => {
      calls.push(url);
      return Promise.resolve({ status: 200, bytes: 0, headers: {}, final_url: url, path: o.dest });
    };
    const src = fakeSource({
      limiter: { minIntervalMs: 900, maxPerDay: null },
      version: async (ctx) => {
        await ctx.http("https://github.com/v", { signal: ctx.signal, maxBytes: 64 });
        await ctx.http("https://github.com/v2", { signal: ctx.signal, maxBytes: 64 });
        return { version: "v", released_at: null };
      },
      fetch: async (_v, ctx) => {
        await ctx.download("https://github.com/f", {
          signal: ctx.signal,
          maxBytes: 9,
          dest: join(ctx.tempDir, "f"),
        });
        return [];
      },
    });
    const r = await runRefresh({ source: src, seasons: [2026], week: 5 }, deps({ http, download }));
    expectStatus(r, "published");
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([900, 900]);
  });

  it("runRefreshJob runs the job's sources in order", async () => {
    const a = fakeSource({ id: "nflverse:injuries" });
    const b = fakeSource({ id: "nflverse:roster_weekly" });
    const rs = await runRefreshJob(
      [
        { source: a, seasons: [2026], week: null },
        { source: b, seasons: [2026], week: null },
      ],
      deps(),
    );
    expect(rs.map((r) => [r.source, r.status])).toEqual([
      ["nflverse:injuries", "published"],
      ["nflverse:roster_weekly", "published"],
    ]);
  });
});

describe("seasons a source reports as not published yet", () => {
  const seasonal = (missing: readonly number[], report: readonly number[] = missing) =>
    fakeSource({
      fetch: async (_v, ctx) => {
        const out = [];
        for (const s of ctx.seasons) {
          if (missing.includes(s)) continue;
          const path = join(ctx.tempDir, `${String(s)}.parquet`);
          await writeFile(path, "PAR1");
          out.push({ path, bytes: 4, season: s });
        }
        for (const s of report) ctx.notPublished(s);
        return out;
      },
    });

  it("the rest is published with a warning per missing season", async () => {
    const d = deps();
    const r = await runRefresh({ source: seasonal([2027]), seasons: [2026, 2027], week: null }, d);
    expectStatus(r, "published");
    expect(r.warnings[0]).toMatch(/nflverse:injuries season 2027: not published upstream yet/);
    expect(r.warnings).toContain("extra column new_col");
    expect(await tmpLeft()).toEqual([]);
  });

  it("no season left → skipped not_published (a success), nothing recorded", async () => {
    const d = deps();
    const r = await runRefresh({ source: seasonal([2027]), seasons: [2027], week: null }, d);
    expect(r).toEqual({ status: "skipped", source: "nflverse:injuries", reason: "not_published" });
    expect(isRefreshSuccess(r)).toBe(true);
    expect(d.publisher.published).toEqual([]);
    expect(d.refreshLog.rows).toEqual([]);
    expect(await tmpLeft()).toEqual([]);
  });

  it("a season the run did not ask for is ignored; a failed attempt's reports do not leak", async () => {
    const r = await runRefresh(
      { source: seasonal([], [1999]), seasons: [2026], week: null },
      deps(),
    );
    expectStatus(r, "published");
    expect(r.warnings).toEqual(["extra column new_col"]);
    const src = fakeSource({
      fetch: async (_v, ctx, n) => {
        if (n === 1) {
          ctx.notPublished(2027);
          throw netError("ECONNRESET");
        }
        const path = join(ctx.tempDir, "x.parquet");
        await writeFile(path, "PAR1");
        return [{ path, bytes: 4, season: 2027 }];
      },
    });
    const r2 = await runRefresh({ source: src, seasons: [2026, 2027], week: null }, deps());
    expectStatus(r2, "published");
    expect(r2.warnings).toEqual(["extra column new_col"]);
  });
});

describe("unchanged version (plan 01 §5.5 'skip if unchanged')", () => {
  it("a release already published with its file present: records the check, never fetches", async () => {
    const src = fakeSource();
    const d = deps({
      refreshLog: fakeRefreshLog([okRow("nflverse:injuries", "2026-09-30T13:36:27Z")]),
    });
    const r = await runRefresh({ source: src, seasons: [2026], week: null }, d);
    expectStatus(r, "unchanged");
    expect(d.publisher.unchanged).toEqual([
      { source: "nflverse:injuries", version: "2026-09-30T13:36:27Z", at: NOW },
    ]);
    expect(src.calls.fetch).toBe(0);
    expect(await tmpLeft()).toEqual([]);
  });

  it("a time-bucket source (weather) already published this hour is unchanged too (≤ 1 per venue per hour)", async () => {
    const src = fakeSource({
      id: "weather:open_meteo",
      versioning: "time_bucket",
      version: () => Promise.resolve({ version: "2026-10-01T12", released_at: null }),
    });
    const d = deps({ refreshLog: fakeRefreshLog([okRow("weather:open_meteo", "2026-10-01T12")]) });
    expectStatus(await runRefresh({ source: src, seasons: [2026], week: 5 }, d), "unchanged");
    expect(src.calls.fetch).toBe(0);
  });

  it("the newest successful row of the source decides", async () => {
    const d = deps({
      refreshLog: fakeRefreshLog([
        okRow("nflverse:injuries", "2026-09-30T13:36:27Z"),
        okRow("nflverse:injuries", "newer"),
      ]),
    });
    expectStatus(
      await runRefresh({ source: fakeSource(), seasons: [2026], week: null }, d),
      "published",
    );
  });

  it("force re-downloads (and asks the publisher not to skip); another source's row does not count", async () => {
    const log = fakeRefreshLog([
      okRow("nflverse:injuries", "2026-09-30T13:36:27Z"),
      okRow("nflverse:schedules", "other"),
    ]);
    const d = deps({ refreshLog: log });
    const forced = await runRefresh(
      { source: fakeSource(), seasons: [2026], week: null, force: true },
      d,
    );
    expect(forced.status).toBe("published");
    expect(d.publisher.options).toEqual([{ skipIfCurrent: false }]);
    const other = await runRefresh(
      { source: fakeSource({ id: "nflverse:schedules" }), seasons: [2026], week: null },
      deps({ refreshLog: log }),
    );
    expect(other.status).toBe("published");
  });

  it("a missing current file (or a throwing check) is republished, never 'unchanged'", async () => {
    for (const checkDataset of [
      () => false,
      () => {
        throw new Error("EIO");
      },
    ]) {
      const cap = captureLog();
      const src = fakeSource();
      const d = deps({
        log: cap.log,
        checkDataset,
        refreshLog: fakeRefreshLog([okRow("nflverse:injuries", "2026-09-30T13:36:27Z")]),
      });
      expectStatus(await runRefresh({ source: src, seasons: [2026], week: null }, d), "published");
      expect(src.calls.fetch).toBe(1);
      expect(d.publisher.unchanged).toEqual([]);
      expect(cap.lines.map((l) => l.event)).toContain("refresh.dataset_missing");
    }
  });

  it("a failing recordUnchanged falls through to publish (never a failure)", async () => {
    const d = deps({
      refreshLog: fakeRefreshLog([okRow("nflverse:injuries", "2026-09-30T13:36:27Z")]),
      publisher: fakePublisher(undefined, { throwOnUnchanged: true }),
    });
    const src = fakeSource();
    expectStatus(await runRefresh({ source: src, seasons: [2026], week: null }, d), "published");
    expect(src.calls.fetch).toBe(1);
    expect(d.refreshLog.rows).toHaveLength(1);
  });

  it("a throwing or null-version refresh log reads as 'no previous version'", async () => {
    const throwing = {
      record: () => undefined,
      current: () => {
        throw new Error("store busy");
      },
    };
    expect(
      (
        await runRefresh(
          { source: fakeSource(), seasons: [2026], week: null },
          deps({ refreshLog: throwing }),
        )
      ).status,
    ).toBe("published");
    const nullVersion = { ...okRow("nflverse:injuries", "x"), file_version: null };
    expect(
      (
        await runRefresh(
          { source: fakeSource(), seasons: [2026], week: null },
          deps({ refreshLog: fakeRefreshLog([nullVersion]) }),
        )
      ).status,
    ).toBe("published");
  });

  it("datasetFilePresent: a non-empty regular file only", async () => {
    const f = join(root, "ds.sqlite");
    expect(datasetFilePresent("nflverse:injuries", null, "v")).toBe(false);
    expect(datasetFilePresent("nflverse:injuries", f, "v")).toBe(false);
    await writeFile(f, "");
    expect(datasetFilePresent("nflverse:injuries", f, "v")).toBe(false);
    await writeFile(f, "SQLite format 3");
    expect(datasetFilePresent("nflverse:injuries", f, "v")).toBe(true);
    expect(datasetFilePresent("nflverse:injuries", root, "v")).toBe(false);
  });
});

describe("a failure publishes nothing and leaves one ok=0 row (plan 06 J2)", () => {
  it("version null → failed network, row UPSTREAM_UNAVAILABLE, no fetch/publish, check time kept", async () => {
    const src = fakeSource({ version: () => Promise.resolve(null) });
    const prev = okRow("nflverse:injuries", "old");
    const d = deps({ refreshLog: fakeRefreshLog([prev]) });
    const r = await runRefresh({ source: src, seasons: [2025, 2026], week: null }, d);
    expectStatus(r, "failed");
    expect(r).toMatchObject({ error: "network", source_error: "UPSTREAM_UNAVAILABLE" });
    expect(src.calls.fetch).toBe(0);
    expect(d.publisher.published).toEqual([]);
    expect(d.refreshLog.rows[1]).toMatchObject({
      source: "nflverse:injuries",
      ok: false,
      error: "UPSTREAM_UNAVAILABLE",
      file: null,
      file_version: null,
      rows: null,
      seasons: [2025, 2026],
      started_at: NOW,
      checked_at: prev.checked_at,
    });
  });

  it("an ESPN season source's outage is ESPN_UPSTREAM_UNAVAILABLE; a host move ESPN_HOST_MOVED", async () => {
    const d = deps();
    const r = await runRefresh(
      {
        source: fakeSource({ id: "espn:pro_schedule", version: () => Promise.resolve(null) }),
        seasons: [2026],
        week: null,
      },
      d,
    );
    expectStatus(r, "failed");
    expect(r.source_error).toBe("ESPN_UPSTREAM_UNAVAILABLE");
    const moved = await runRefresh(
      {
        source: fakeSource({
          id: "espn:players",
          version: () =>
            Promise.reject(
              new HttpError({ kind: "redirect_refused", espn: true, host: "www.espn.com" }),
            ),
        }),
        seasons: [2026],
        week: null,
      },
      d,
    );
    expectStatus(moved, "failed");
    expect(moved.source_error).toBe("ESPN_HOST_MOVED");
    expect(d.refreshLog.rows.map((x) => x.error)).toEqual([
      "ESPN_UPSTREAM_UNAVAILABLE",
      "ESPN_HOST_MOVED",
    ]);
  });

  it("schema failure names the column and codec; codec-only → `codec`; publish never called", async () => {
    const report: SchemaReport = {
      ok: false,
      missing_columns: ["report_status"],
      extra_columns: [],
      bad_codecs: [{ column: "gsis_id", codec: "ZSTD" }],
      rows: 0,
      warnings: [],
    };
    const src = fakeSource({ assertSchema: () => Promise.resolve(report) });
    const d = deps();
    const r = await runRefresh({ source: src, seasons: [2026], week: null }, d);
    expectStatus(r, "failed");
    expect(r.error).toBe("schema");
    expect(r.message).toBe(
      "schema assertion failed: missing column(s): report_status; unsupported codec(s): gsis_id=ZSTD",
    );
    expect(r.schema).toEqual(report);
    expect(src.calls.publish).toBe(0);
    expect(d.publisher.published).toEqual([]);
    expect(d.refreshLog.rows[0]).toMatchObject({
      ok: false,
      error: "schema_mismatch",
      file_version: "2026-09-30T13:36:27Z",
    });
    expect(schemaErrorCode({ ...report, missing_columns: [] })).toBe("codec");
    expect(schemaErrorCode(null)).toBe("schema_mismatch");
    expect(await tmpLeft()).toEqual([]);
  });

  it("assertSchema throwing (a corrupt file) is a schema failure", async () => {
    const r = await runRefresh(
      {
        source: fakeSource({ assertSchema: () => Promise.reject(new Error("not parquet")) }),
        seasons: [2026],
        week: null,
      },
      deps(),
    );
    expectStatus(r, "failed");
    expect(r).toMatchObject({ error: "schema", source_error: "schema_mismatch" });
  });

  it("a non-network fetch error is internal and not retried", async () => {
    const src = fakeSource({ fetch: () => Promise.reject(new Error("parse")) });
    const r = await runRefresh({ source: src, seasons: [2026], week: null }, deps());
    expectStatus(r, "failed");
    expect(r).toMatchObject({ error: "internal", source_error: "INTERNAL" });
    expect(src.calls.fetch).toBe(1);
  });

  it("an upstream 4xx is a network failure, not retried; the message names host and status only", async () => {
    const src = fakeSource({
      fetch: () =>
        Promise.reject(new HttpError({ kind: "http_4xx", status: 404, host: "github.com" })),
    });
    const r = await runRefresh({ source: src, seasons: [2026], week: null }, deps());
    expectStatus(r, "failed");
    expect(r.error).toBe("network");
    expect(r.message).toBe("http: upstream answered with a client error (github.com) status 404");
    expect(src.calls.fetch).toBe(1);
  });

  it("a record() that throws still returns the failure (logged)", async () => {
    const cap = captureLog();
    const r = await runRefresh(
      { source: fakeSource({ version: () => Promise.resolve(null) }), seasons: [2026], week: null },
      deps({
        log: cap.log,
        refreshLog: {
          record: () => {
            throw new Error("busy");
          },
          current: () => [],
        },
      }),
    );
    expect(r.status).toBe("failed");
    expect(cap.lines.map((l) => l.event)).toContain("refresh.log_write_failed");
  });

  it("invalid requests are refused without recording", async () => {
    for (const req of [
      { seasons: [] as number[], week: null },
      { seasons: [1990], week: null },
      { seasons: [2026.5], week: null },
      { seasons: [2026], week: 0 },
      { seasons: [2026], week: 23 },
    ]) {
      const d = deps();
      const r = await runRefresh({ source: fakeSource(), ...req }, d);
      expectStatus(r, "failed");
      expect(r.error).toBe("invalid_request");
      expect(d.refreshLog.rows).toEqual([]);
    }
  });

  it("an unexpected runner failure (an invalid limiter) is internal, recorded, never a throw", async () => {
    const d = deps();
    const r = await runRefresh(
      {
        source: fakeSource({ limiter: { minIntervalMs: -1, maxPerDay: null } }),
        seasons: [2026],
        week: null,
      },
      d,
    );
    expectStatus(r, "failed");
    expect(r).toMatchObject({ error: "internal", source_error: "INTERNAL" });
    expect(d.refreshLog.rows[0]?.error).toBe("INTERNAL");
  });

  it("every recorded error is a SourceErrorCode", () => {
    for (const e of [
      new HttpError({ kind: "http_5xx" }),
      new HttpError({ kind: "rate_limited" }),
      new HttpError({ kind: "host_not_allowed" }),
      new HttpError({ kind: "dns", espn: true }),
      netError("ENOTFOUND"),
      new Error("x"),
    ])
      for (const id of ["nflverse:injuries", "espn:players"] as const)
        expect(SOURCE_ERROR_CODES).toContain(sourceErrorFor(e, id));
    expect(sourceErrorFor(netError("ENOTFOUND"), "espn:players")).toBe("ESPN_UPSTREAM_UNAVAILABLE");
    expect(sourceErrorFor(new HttpError({ kind: "quota_exhausted" }), "weather:nws")).toBe(
      "RATE_LIMITED",
    );
    expect(sourceErrorFor(new HttpError({ kind: "dns" }), "weather:nws")).toBe(
      "UPSTREAM_UNAVAILABLE",
    );
  });
});

describe("publish outcomes", () => {
  it("a SourceErrorCode failure was recorded by the publisher: the runner does not double-record", async () => {
    const d = deps({ publisher: fakePublisher(() => ({ ok: false, error: "INTERNAL" })) });
    const r = await runRefresh({ source: fakeSource(), seasons: [2026], week: null }, d);
    expectStatus(r, "failed");
    expect(r).toMatchObject({ error: "publish", source_error: "INTERNAL" });
    expect(r.message).toMatch(/intact/);
    expect(d.refreshLog.rows).toEqual([]);
    expect(await tmpLeft()).toEqual([]);
  });

  it("a refusal before the publisher's lock wrote nothing: the runner records INTERNAL", async () => {
    const d = deps({ publisher: fakePublisher(() => ({ ok: false, error: "invalid_version" })) });
    const r = await runRefresh({ source: fakeSource(), seasons: [2026], week: null }, d);
    expectStatus(r, "failed");
    expect(d.refreshLog.rows[0]).toMatchObject({ ok: false, error: "INTERNAL" });
  });

  it("publish_unrecorded: the new file is live, its row missing — never reported as intact", async () => {
    const d = deps({
      publisher: fakePublisher(() => ({ ok: false, error: PUBLISH_UNRECORDED_ERROR })),
    });
    const r = await runRefresh({ source: fakeSource(), seasons: [2026], week: null }, d);
    expectStatus(r, "failed");
    expect(r.error).toBe("published_unrecorded");
    expect(r.message).toBe(PUBLISHED_UNRECORDED_MESSAGE);
    expect(r.message).not.toMatch(/intact/);
    expect(d.refreshLog.rows).toEqual([]);
  });

  it("already current under the lock (another refresh won the race) → unchanged", async () => {
    const d = deps({
      publisher: fakePublisher(() => ({ ok: false, error: PUBLISH_ALREADY_CURRENT })),
    });
    expectStatus(
      await runRefresh({ source: fakeSource(), seasons: [2026], week: null }, d),
      "unchanged",
    );
    expect(d.refreshLog.rows).toEqual([]);
  });

  it("a throwing publisher → failed publish, recorded INTERNAL", async () => {
    const d = deps({ publisher: fakePublisher(undefined, { throwOnPublish: true }) });
    const r = await runRefresh({ source: fakeSource(), seasons: [2026], week: null }, d);
    expectStatus(r, "failed");
    expect(r.error).toBe("publish");
    expect(d.refreshLog.rows[0]).toMatchObject({ ok: false, error: "INTERNAL" });
  });

  it(`a held job lock (${JOB_LOCKED_ERROR}) is a skip, exit-0`, async () => {
    const d = deps({
      publisher: fakePublisher(() => ({ ok: false, error: `${JOB_LOCKED_ERROR}: pid 4242` })),
    });
    const r = await runRefresh({ source: fakeSource(), seasons: [2026], week: null }, d);
    expectStatus(r, "skipped");
    expect(r.reason).toBe("locked");
    expect(isRefreshSuccess(r)).toBe(true);
  });

  it("a fill that throws inside the publisher surfaces as a publish failure", async () => {
    const r = await runRefresh(
      {
        source: fakeSource({ publish: () => Promise.reject(new Error("constraint")) }),
        seasons: [2026],
        week: null,
      },
      deps(),
    );
    expectStatus(r, "failed");
    expect(r.error).toBe("publish");
  });
});

describe("retries (plan 01 §5.7: 3× with jitter, then stop; §6: ENOTFOUND never retried)", () => {
  it("retryable version failures, then success: 3 attempts, 2 bounded jittered sleeps", async () => {
    const src = fakeSource({
      version: (_c, n) =>
        n < 3
          ? Promise.reject(netError("ECONNRESET"))
          : Promise.resolve({ version: "v", released_at: null }),
    });
    const r = await runRefresh({ source: src, seasons: [2026], week: null }, deps());
    expectStatus(r, "published");
    expect(src.calls.version).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeLessThan(DEFAULT_BASE_DELAY_MS);
    expect(sleeps[1]).toBeLessThan(2 * DEFAULT_BASE_DELAY_MS);
  });

  it.each(["ENOTFOUND", "ECONNREFUSED", "CERT_HAS_EXPIRED"])(
    "%s fails fast: one attempt, no sleep",
    async (code) => {
      const src = fakeSource({ version: () => Promise.reject(netError(code)) });
      const d = deps();
      const r = await runRefresh({ source: src, seasons: [2026], week: null }, d);
      expectStatus(r, "failed");
      expect(r).toMatchObject({
        error: "network",
        source_error: "UPSTREAM_UNAVAILABLE",
        attempts: 1,
      });
      expect(src.calls.version).toBe(1);
      expect(sleeps).toEqual([]);
    },
  );

  it("a 429's Retry-After raises the delay (capped at maxDelayMs)", async () => {
    const src = fakeSource({
      version: (_c, n) =>
        n === 1
          ? Promise.reject(new HttpError({ kind: "rate_limited", status: 429, retryAfterS: 9 }))
          : Promise.resolve({ version: "v", released_at: null }),
    });
    await runRefresh({ source: src, seasons: [2026], week: null }, deps());
    expect(sleeps).toEqual([9000]);
    sleeps = [];
    const src2 = fakeSource({
      version: (_c, n) =>
        n === 1
          ? Promise.reject(new HttpError({ kind: "rate_limited", status: 429, retryAfterS: 3600 }))
          : Promise.resolve({ version: "v", released_at: null }),
    });
    await runRefresh({ source: src2, seasons: [2026], week: null }, deps());
    expect(sleeps).toEqual([30_000]);
  });

  it("jitter is deterministic for a seed and differs across seeds", async () => {
    const run = async (seed: number): Promise<number[]> => {
      sleeps = [];
      await runRefresh(
        {
          source: fakeSource({
            fetch: () => Promise.reject(new HttpError({ kind: "http_5xx", status: 503 })),
          }),
          seasons: [2026],
          week: null,
        },
        deps({ rng: seededRng(seed) }),
      );
      return [...sleeps];
    };
    const a = await run(1);
    expect(await run(1)).toEqual(a);
    expect(await run(2)).not.toEqual(a);
  });

  it("retries exhausted on fetch → failed after 3 attempts; every attempt starts from a fresh dir", async () => {
    const dirs: string[] = [];
    const src = fakeSource({
      fetch: async (_v, ctx) => {
        dirs.push(ctx.tempDir);
        await writeFile(join(ctx.tempDir, "partial.parquet"), "PA");
        throw netError("ETIMEDOUT");
      },
    });
    const d = deps();
    const r = await runRefresh({ source: src, seasons: [2026], week: null }, d);
    expectStatus(r, "failed");
    expect(r).toMatchObject({ error: "network", attempts: 4 });
    expect(src.calls.fetch).toBe(3);
    expect(new Set(dirs).size).toBe(3);
    expect(await tmpLeft()).toEqual([]);
    expect(d.refreshLog.rows).toHaveLength(1);
    expect(d.refreshLog.rows[0]).toMatchObject({ ok: false, error: "UPSTREAM_UNAVAILABLE" });
    expect(d.publisher.published).toEqual([]);
  });

  it("uses the real abortable sleep when none is injected", async () => {
    const src = fakeSource({
      version: (_c, n) =>
        n < 2
          ? Promise.reject(netError("ECONNRESET"))
          : Promise.resolve({ version: "v", released_at: null }),
    });
    const { sleep: _drop, ...noSleep } = deps({ retry: { baseDelayMs: 2, maxDelayMs: 2 } });
    expect((await runRefresh({ source: src, seasons: [2026], week: null }, noSleep)).status).toBe(
      "published",
    );
    expect(src.calls.version).toBe(2);
  });

  it("maxAttempts 1 disables retries; backoff is capped by maxDelayMs", async () => {
    const src = fakeSource({ version: () => Promise.reject(netError("ETIMEDOUT")) });
    expect(
      (
        await runRefresh(
          { source: src, seasons: [2026], week: null },
          deps({ retry: { maxAttempts: 1 } }),
        )
      ).status,
    ).toBe("failed");
    expect(src.calls.version).toBe(1);
    const src2 = fakeSource({ version: () => Promise.reject(netError("ETIMEDOUT")) });
    await runRefresh(
      { source: src2, seasons: [2026], week: null },
      deps({ retry: { maxAttempts: 5, baseDelayMs: 10_000, maxDelayMs: 50 } }),
    );
    expect(sleeps.every((s) => s <= 50)).toBe(true);
    expect(sleeps).toHaveLength(4);
  });
});

describe("temp cleanup on every path", () => {
  it("a TempFile a source wrote outside its run dir is removed too", async () => {
    const outside = join(root, "stray.parquet");
    const src = fakeSource({
      fetch: async () => {
        await writeFile(outside, "x");
        return [{ path: outside, bytes: 1, season: 2026 }];
      },
    });
    await runRefresh({ source: src, seasons: [2026], week: null }, deps());
    expect(await readdir(root)).toEqual(["tmp"]);
  });

  it("a temp area that fails to create is an internal failure", async () => {
    const temp: TempArea = {
      create: () => Promise.reject(new Error("EACCES")),
      remove: () => Promise.resolve(),
    };
    const r = await runRefresh(
      { source: fakeSource(), seasons: [2026], week: null },
      deps({ temp }),
    );
    expectStatus(r, "failed");
    expect(r.error).toBe("internal");
  });

  it("a remove that throws never escapes", async () => {
    const real = fsTempArea(join(root, "tmp"));
    const temp: TempArea = {
      create: (s) => real.create(s),
      remove: () => Promise.reject(new Error("EBUSY")),
    };
    expect(
      (await runRefresh({ source: fakeSource(), seasons: [2026], week: null }, deps({ temp })))
        .status,
    ).toBe("published");
  });
});

describe("aborts (a cancel is not a source error: nothing recorded)", () => {
  it("aborted before publish → failed aborted, nothing published, nothing recorded", async () => {
    const ac = new AbortController();
    const src = fakeSource({
      assertSchema: () => {
        ac.abort();
        return Promise.resolve({
          ok: true,
          missing_columns: [],
          extra_columns: [],
          bad_codecs: [],
          rows: 0,
          warnings: [],
        });
      },
    });
    const d = deps();
    const r = await runRefresh({ source: src, seasons: [2026], week: null, signal: ac.signal }, d);
    expectStatus(r, "failed");
    expect(r.error).toBe("aborted");
    expect(d.publisher.published).toEqual([]);
    expect(d.refreshLog.rows).toEqual([]);
    expect(await tmpLeft()).toEqual([]);
  });

  it("an abort during a retryable failure stops retrying", async () => {
    const ac = new AbortController();
    const src = fakeSource({
      version: () => {
        ac.abort();
        return Promise.reject(netError("ECONNRESET"));
      },
    });
    const d = deps();
    const r = await runRefresh({ source: src, seasons: [2026], week: null, signal: ac.signal }, d);
    expectStatus(r, "failed");
    expect(r.error).toBe("aborted");
    expect(src.calls.version).toBe(1);
    expect(d.refreshLog.rows).toEqual([]);
  });

  it("an HttpError 'aborted' from the source is an abort", async () => {
    const r = await runRefresh(
      {
        source: fakeSource({ fetch: () => Promise.reject(new HttpError({ kind: "aborted" })) }),
        seasons: [2026],
        week: null,
      },
      deps(),
    );
    expectStatus(r, "failed");
    expect(r.error).toBe("aborted");
  });
});

describe("season awareness on the ESPN pro schedule (plan 06)", () => {
  it("in_season source off-season → skipped before any call, nothing recorded", async () => {
    const src = fakeSource({ seasonGate: "in_season" });
    const d = deps({
      proSchedule: fakeProSchedule([proGame(1, "2026-09-10T00:20:00.000Z", { week: 1 })]),
    });
    const r = await runRefresh({ source: src, seasons: [2026], week: null }, d);
    expectStatus(r, "skipped");
    expect(r.reason).toBe("off_season");
    expect(src.calls.version).toBe(0);
    expect(d.refreshLog.rows).toEqual([]);
  });

  it("pro schedule never loaded (or throwing) → skipped schedule_never_loaded", async () => {
    const src = fakeSource({ seasonGate: "in_season" });
    const r = await runRefresh(
      { source: src, seasons: [2026], week: null },
      deps({ proSchedule: fakeProSchedule([], false) }),
    );
    expectStatus(r, "skipped");
    expect(r.reason).toBe("schedule_never_loaded");
    const throwing = {
      games: () => {
        throw new Error("no file");
      },
      teams: () => ({ rows: [], stamp: null }),
    };
    const r2 = await runRefresh(
      { source: src, seasons: [2026], week: null },
      deps({ proSchedule: throwing }),
    );
    expectStatus(r2, "skipped");
    expect(r2.reason).toBe("schedule_never_loaded");
  });

  it("in season → runs; an always-gated source never reads the schedule", async () => {
    expect(
      (
        await runRefresh(
          { source: fakeSource({ seasonGate: "in_season" }), seasons: [2026], week: 5 },
          deps(),
        )
      ).status,
    ).toBe("published");
    const sch = fakeProSchedule([], false);
    expect(
      (
        await runRefresh(
          { source: fakeSource(), seasons: [2026], week: null },
          deps({ proSchedule: sch }),
        )
      ).status,
    ).toBe("published");
    expect(sch.queries).toEqual([]);
  });

  it("seasonState: ±7 days inclusive, null/garbage kickoffs ignored, every week asked", () => {
    const now = Date.parse(NOW);
    const at = (d: number): string => new Date(now + d * 86_400_000).toISOString();
    expect(seasonState(fakeProSchedule([proGame(1, at(7))]), 2026, now)).toBe("in_season");
    expect(seasonState(fakeProSchedule([proGame(1, at(-7))]), 2026, now)).toBe("in_season");
    expect(seasonState(fakeProSchedule([proGame(1, at(7.01))]), 2026, now)).toBe("off_season");
    expect(seasonState(fakeProSchedule([proGame(1, null), proGame(2, "garbage")]), 2026, now)).toBe(
      "off_season",
    );
    const sch = fakeProSchedule([]);
    seasonState(sch, 2026, now);
    expect(sch.queries[0]).toEqual({ season: 2026, weeks: null });
  });
});

describe("describeSchemaFailure", () => {
  it("sanitises hostile names and caps the list", () => {
    const r: SchemaReport = {
      ok: false,
      missing_columns: [
        "ok_col",
        "bad\ncol; DROP",
        ...Array.from({ length: 20 }, (_, i) => `c${String(i)}`),
      ],
      extra_columns: [],
      bad_codecs: [{ column: "x", codec: "<script>" }],
      rows: 0,
      warnings: [],
    };
    const m = describeSchemaFailure(r);
    expect(m).toContain("ok_col, ?");
    expect(m).toContain("x=?");
    expect(m).not.toContain("c15");
    expect(describeSchemaFailure({ ...r, missing_columns: [], bad_codecs: [] })).toBe(
      "schema assertion failed",
    );
  });
});

describe("fsTempArea", () => {
  it("creates private per-source dirs and removes them (missing paths are fine)", async () => {
    const t = fsTempArea(join(root, "t"));
    const a = await t.create("weather:open_meteo");
    expect(a).toMatch(/weather_open_meteo-/);
    await t.remove(a);
    await t.remove(join(root, "t", "never-existed"));
    expect(await readdir(join(root, "t"))).toEqual([]);
  });

  it("refuses a world-writable or symlinked root", async () => {
    const open = join(root, "open");
    await mkdir(open, { mode: 0o700 });
    await chmod(open, 0o777);
    await expect(fsTempArea(open).create("nflverse:injuries")).rejects.toThrow();
    expect(await readdir(open)).toEqual([]);
    const target = join(root, "elsewhere");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, join(root, "link"));
    await expect(fsTempArea(join(root, "link")).create("nflverse:injuries")).rejects.toThrow();
    expect(await readdir(target)).toEqual([]);
    const fresh = join(root, "fresh");
    await fsTempArea(fresh).create("nflverse:injuries");
    expect((await stat(fresh)).mode & 0o077).toBe(0);
  });
});
