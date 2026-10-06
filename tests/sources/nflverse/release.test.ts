// release.test.ts — timestamp.txt versioning and release downloads (plan 01 §5.5 + D9; plan 05 §2
// `sources/*`): parsing nflverse's `YYYY-MM-DD HH:MM:SS EDT` stamps (never ISO), the version contract
// (null = unreachable, a garbled stamp fails loudly, a retryable failure propagates), cancellation,
// the download checks (status, https, size cap, no partial file) and the not-yet-published window.
// Ported from sibling @521f9f3, adapted (HttpDownload, the ESPN pro schedule as season clock).
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_RELEASE_FILE_BYTES,
  NFLVERSE_TAGS,
  NflverseSourceError,
  SEASON_PUBLISH_GRACE_DAYS,
  TIMESTAMP_MAX_BYTES,
  assertSeason,
  downloadAsset,
  firstKickoffMs,
  isNotFound,
  isRetryable,
  mayBeUnpublished,
  parseNflverseTimestamp,
  releaseUrl,
  releaseVersion,
  runSeasons,
  sourceTempDir,
  versionString,
} from "../../../src/sources/nflverse/release.js";
import type { HttpDownload } from "../../../src/sources/source.js";
import { REL, manifest } from "./helpers/fixtures.js";
import { makeCtx, proGame, type Ctx, type CtxOptions, type Route } from "./helpers/harness.js";

const open: Ctx[] = [];
afterEach(() => {
  for (const c of open.splice(0)) c.cleanup();
});
const ctxFor = (seasons: readonly number[], o: CtxOptions = {}): Ctx => {
  const c = makeCtx(seasons, o);
  open.push(c);
  return c;
};
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const routes = (url: string, r: Route): Map<string, Route> => new Map([[url, r]]);

/** An error shaped like src/http's HttpError (retryable flag + status). */
class FakeHttpError extends Error {
  constructor(
    readonly retryable: boolean,
    readonly status: number | null,
  ) {
    super("fake http failure");
  }
}

describe("parseNflverseTimestamp", () => {
  it("parses every committed fixture stamp (the real 2026-10-06 releases)", () => {
    expect(Object.keys(manifest.timestamps).sort()).toEqual([...NFLVERSE_TAGS].sort());
    for (const t of Object.values(manifest.timestamps)) {
      expect(parseNflverseTimestamp(t.text), t.text).toMatch(
        /^2026-10-0[56]T\d{2}:\d{2}:\d{2}\.000Z$/,
      );
    }
    expect(parseNflverseTimestamp("2026-10-06 02:02:02 EDT")).toBe("2026-10-06T06:02:02.000Z");
  });

  it.each([
    ["2026-09-30 09:36:26 EDT", "2026-09-30T13:36:26.000Z"],
    ["2026-01-15 09:36:26 EST", "2026-01-15T14:36:26.000Z"],
    ["2026-09-30 09:36:26 UTC", "2026-09-30T09:36:26.000Z"],
    ["2026-09-30 09:36:26 GMT", "2026-09-30T09:36:26.000Z"],
    ["2026-09-30T13:36:26Z", "2026-09-30T13:36:26.000Z"],
    ["2026-09-30T13:36:26.123Z", "2026-09-30T13:36:26.000Z"],
    ["2026-09-30T09:36:26-04:00", "2026-09-30T13:36:26.000Z"],
    ["2026-09-30T19:06:26+0530", "2026-09-30T13:36:26.000Z"],
    ["  2026-09-30 09:36:26 EDT\n", "2026-09-30T13:36:26.000Z"],
    ["2024-02-29 00:00:00 EST", "2024-02-29T05:00:00.000Z"],
  ])("%j → %s", (input, iso) => {
    expect(parseNflverseTimestamp(input)).toBe(iso);
  });

  it.each([
    "",
    "2026-09-30",
    "2026-09-30 09:36:26",
    "2026-09-30 09:36:26 PDT", // a zone we do not know is never guessed
    "2026-09-30 09:36:26 edt",
    "2026-02-30 09:36:26 EDT",
    "2025-02-29 09:36:26 EDT",
    "2026-13-01 09:36:26 EDT",
    "2026-00-10 09:36:26 EDT",
    "2026-09-00 09:36:26 EDT",
    "2026-09-30 24:00:00 EDT",
    "2026-09-30 09:60:00 EDT",
    "2026-09-30 09:36:60 EDT",
    "2026-09-30T09:36:26+15:00",
    "2026-09-30T09:36:26+05:61",
    "2026-09-30 09:36:26 EDT; rm -rf /",
    "<html>rate limited</html>",
    "２０２６-09-30 09:36:26 EDT",
    "2026-09-30 09:36:26 EDT‮",
    `2026-09-30 09:36:26 EDT${" ".repeat(300)}`,
  ])("rejects %j", (input) => {
    expect(parseNflverseTimestamp(input)).toBeNull();
  });

  it("rejects non-strings", () => {
    for (const v of [null, undefined, 0, 1727703386, {}, [], new Date(), 5n]) {
      expect(parseNflverseTimestamp(v)).toBeNull();
    }
  });

  it("never throws and yields only valid ISO instants (fuzz)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (s) => {
        const r = parseNflverseTimestamp(s);
        return r === null || new Date(r).toISOString() === r;
      }),
      { numRuns: 2000 },
    );
  });

  it("round-trips every instant written as a UTC line, and EDT is UTC−4 (properties)", () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date("2000-01-01T00:00:00Z"),
          max: new Date("2099-12-31T23:59:59Z"),
          noInvalidDate: true,
        }),
        (d) => {
          const iso = new Date(Math.floor(d.getTime() / 1000) * 1000).toISOString();
          const wall = `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
          const edt = parseNflverseTimestamp(`${wall} EDT`);
          return (
            parseNflverseTimestamp(`${wall} UTC`) === iso &&
            edt !== null &&
            Date.parse(edt) - Date.parse(iso) === 4 * 3_600_000
          );
        },
      ),
    );
  });
});

describe("versionString / seasons / urls", () => {
  it("is filename-safe, carries the seasons, and is bare for a season-less source", () => {
    const v = versionString("2026-10-06T06:02:02.000Z", [2024, 2025, 2026]);
    expect(v).toBe("20261006T060202Z_2024-2025-2026");
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(versionString("2026-10-06T06:02:02.000Z", [2026])).not.toBe(v);
    expect(versionString("2026-10-06T06:02:02.000Z", [])).toBe("20261006T060202Z");
  });

  it("validates seasons", () => {
    expect(assertSeason(2026)).toBe(2026);
    for (const bad of [1998, 2101, 2026.5, Number.NaN, "2026", null, -1, Infinity]) {
      expect(() => assertSeason(bad)).toThrow(NflverseSourceError);
    }
    try {
      assertSeason("2026");
    } catch (e) {
      expect(e).toMatchObject({ reason: "bad_season", code: "INTERNAL" });
    }
    expect(runSeasons([2026, 2025, 2026])).toEqual([2026, 2025]);
    expect(() => runSeasons([2026, 3000])).toThrow(/season/);
  });

  it("refuses path tricks in file names", () => {
    expect(releaseUrl("injuries", "injuries_2026.parquet")).toBe(
      `${REL}/injuries/injuries_2026.parquet`,
    );
    for (const bad of [
      "../x",
      "a/b",
      "",
      "a b",
      "x?y=1",
      "..",
      "%2e%2e",
      "a".repeat(81),
      "x\u0000y",
      "é.parquet",
    ]) {
      expect(() => releaseUrl("injuries", bad)).toThrow(NflverseSourceError);
    }
  });

  it("maps every failure to the fixed refresh_log vocabulary", () => {
    expect(new NflverseSourceError("download", "x", 503).code).toBe("UPSTREAM_UNAVAILABLE");
    expect(new NflverseSourceError("download", "x", 429).code).toBe("RATE_LIMITED");
    expect(new NflverseSourceError("codec", "x").code).toBe("codec");
    expect(new NflverseSourceError("schema", "x").code).toBe("schema_mismatch");
    expect(new NflverseSourceError("not_parquet", "x").code).toBe("schema_mismatch");
    expect(new NflverseSourceError("bad_timestamp", "x").code).toBe("schema_mismatch");
    expect(new NflverseSourceError("corrupt", "x").code).toBe("schema_mismatch");
    expect(new NflverseSourceError("schema", "x").name).toBe("NflverseSourceError");
  });

  it("isRetryable / isNotFound read src/http's error shape, nothing looser", () => {
    expect(isRetryable(new FakeHttpError(true, 503))).toBe(true);
    expect(isRetryable(new FakeHttpError(false, 404))).toBe(false);
    expect(isRetryable({ retryable: true })).toBe(false);
    expect(isRetryable(new Error("503"))).toBe(false);
    expect(isNotFound(new FakeHttpError(false, 404))).toBe(true);
    expect(isNotFound(new NflverseSourceError("download", "x answered 404", 404))).toBe(true);
    expect(isNotFound(new NflverseSourceError("download", "x answered 500", 500))).toBe(false);
    expect(isNotFound(new Error("404"))).toBe(false);
    expect(isNotFound({ status: 404 })).toBe(false);
  });
});

describe("releaseVersion", () => {
  it("reads the tag's timestamp.txt, once, with a tiny byte cap", async () => {
    const seen: number[] = [];
    const c = ctxFor([2026]);
    const http = c.ctx.http;
    const spy = ctxFor([2026], {
      overrides: {
        http: (u, o) => {
          seen.push(o.maxBytes);
          return http(u, o);
        },
      },
    });
    await expect(releaseVersion("injuries", spy.ctx)).resolves.toEqual({
      version: "20261006T060202Z_2026",
      released_at: "2026-10-06T06:02:02.000Z",
    });
    expect(seen).toEqual([TIMESTAMP_MAX_BYTES]);
    expect(c.calls).toEqual([`${REL}/injuries/timestamp.txt`]);
  });

  it("returns null when upstream is unreachable, answers non-200, or sends an oversize body", async () => {
    const url = `${REL}/schedules/timestamp.txt`;
    for (const r of [new Error("dns"), new FakeHttpError(false, 404), 404, 500, 302, 204]) {
      const c = ctxFor([2026], { routes: routes(url, r) });
      await expect(releaseVersion("schedules", c.ctx)).resolves.toBeNull();
    }
    const big = ctxFor([2026], {
      overrides: {
        http: () =>
          Promise.resolve({
            status: 200,
            body: new Uint8Array(TIMESTAMP_MAX_BYTES + 1),
            headers: {},
            final_url: url,
          }),
      },
    });
    await expect(releaseVersion("schedules", big.ctx)).resolves.toBeNull();
  });

  it("re-throws a retryable failure (the runner retries it)", async () => {
    const url = `${REL}/schedules/timestamp.txt`;
    const e = new FakeHttpError(true, 503);
    const c = ctxFor([2026], { routes: routes(url, e) });
    await expect(releaseVersion("schedules", c.ctx)).rejects.toBe(e);
  });

  it("fails loudly on a garbled or non-UTF-8 stamp", async () => {
    const url = `${REL}/schedules/timestamp.txt`;
    const garbled = ctxFor([2026], { routes: routes(url, enc("soon")) });
    await expect(releaseVersion("schedules", garbled.ctx)).rejects.toMatchObject({
      reason: "bad_timestamp",
      code: "schema_mismatch",
    });
    const binary = ctxFor([2026], { routes: routes(url, Uint8Array.from([0xff, 0xfe, 0x00])) });
    await expect(releaseVersion("schedules", binary.ctx)).rejects.toThrow(/UTF-8/);
  });

  it("propagates cancellation instead of reporting an outage", async () => {
    const c = ctxFor([2026]);
    c.abort.abort();
    await expect(releaseVersion("injuries", c.ctx)).rejects.toThrow(/aborted/);
  });

  it("validates the run's seasons before any request (a season-less source needs none)", async () => {
    const c = ctxFor([1900]);
    await expect(releaseVersion("injuries", c.ctx)).rejects.toMatchObject({ reason: "bad_season" });
    expect(c.calls).toEqual([]);
    await expect(releaseVersion("players", c.ctx, true)).resolves.toEqual({
      version: "20261005T165138Z",
      released_at: "2026-10-05T16:51:38.000Z",
    });
  });
});

describe("downloadAsset", () => {
  const url = `${REL}/injuries/injuries_2026.parquet`;

  it("writes through HttpDownload with the release cap and returns the TempFile", async () => {
    const c = ctxFor([2026], { routes: routes(url, enc("PAR1xxxxPAR1")) });
    const dir = await sourceTempDir(c.ctx, "t");
    expect(dir.startsWith(c.tempDir)).toBe(true);
    const f = await downloadAsset(c.ctx, url, join(dir, "a.parquet"), 2026);
    expect(f).toEqual({ path: join(dir, "a.parquet"), bytes: 12, season: 2026 });
  });

  it("fails on non-200 naming the URL with the status, and leaves no partial file", async () => {
    const c = ctxFor([2026], {
      overrides: {
        download: (_u, o) => {
          writeFileSync(o.dest, "partial");
          return Promise.resolve({
            status: 500,
            bytes: 7,
            headers: {},
            final_url: "https://x/",
            path: o.dest,
          });
        },
      },
    });
    const dest = join(await sourceTempDir(c.ctx, "t"), "a.parquet");
    await expect(downloadAsset(c.ctx, url, dest, 2026)).rejects.toMatchObject({
      message: expect.stringMatching(/injuries_2026\.parquet answered 500/) as unknown,
      status: 500,
      code: "UPSTREAM_UNAVAILABLE",
    });
    expect(existsSync(dest)).toBe(false);
  });

  it("refuses to overwrite an existing file (exclusive create)", async () => {
    const c = ctxFor([2026], { routes: routes(url, enc("x")) });
    const dest = join(await sourceTempDir(c.ctx, "t"), "a.parquet");
    writeFileSync(dest, "keep");
    await expect(downloadAsset(c.ctx, url, dest, 2026)).rejects.toThrow(/EEXIST/);
  });

  it("refuses a body served over plain http or from an unparseable final URL", async () => {
    for (const final_url of ["http://evil.example/x", "not a url", ""]) {
      const download: HttpDownload = (_u, o) => {
        writeFileSync(o.dest, "PAR1");
        return Promise.resolve({ status: 200, bytes: 4, headers: {}, final_url, path: o.dest });
      };
      const c = ctxFor([2026], { overrides: { download } });
      const dest = join(await sourceTempDir(c.ctx, "t"), "a.parquet");
      await expect(downloadAsset(c.ctx, url, dest, 2026)).rejects.toThrow(/https/);
      expect(existsSync(dest)).toBe(false);
    }
  });

  it("enforces the size cap even when the transport does not, and rejects nonsense sizes", async () => {
    for (const bytes of [MAX_RELEASE_FILE_BYTES + 1, -1, Number.NaN, 1.5]) {
      const c = ctxFor([2026], {
        overrides: {
          download: (_u, o) => {
            writeFileSync(o.dest, "PAR1");
            return Promise.resolve({
              status: 200,
              bytes,
              headers: {},
              final_url: "https://x/",
              path: o.dest,
            });
          },
        },
      });
      const dest = join(await sourceTempDir(c.ctx, "t"), "a.parquet");
      await expect(downloadAsset(c.ctx, url, dest, 2026)).rejects.toThrow(/size cap/);
      expect(existsSync(dest)).toBe(false);
    }
  });

  it("a thrown transport error removes the partial file and propagates unchanged", async () => {
    const e = new FakeHttpError(true, null);
    const c = ctxFor([2026], {
      overrides: {
        download: (_u, o) => {
          writeFileSync(o.dest, "half");
          return Promise.reject(e);
        },
      },
    });
    const dest = join(await sourceTempDir(c.ctx, "t"), "a.parquet");
    await expect(downloadAsset(c.ctx, url, dest, 2026)).rejects.toBe(e);
    expect(existsSync(dest)).toBe(false);
  });
});

describe("the new-season window: which 404 may mean 'not published yet'", () => {
  const DAY = 86_400_000;
  const k = "2027-09-10T00:20:00.000Z";

  it("firstKickoffMs: the earliest known week-1 kickoff from the ESPN pro schedule", () => {
    const c = ctxFor([2027], {
      proGames: [
        proGame(2027, 1, "2027-09-12T17:00:00.000Z"),
        proGame(2027, 1, k),
        proGame(2027, 1, null),
        proGame(2027, 2, "2027-09-01T00:00:00.000Z"),
        proGame(2026, 1, "2026-09-01T00:00:00.000Z"),
      ],
    });
    expect(firstKickoffMs(2027, c.ctx)).toBe(Date.parse(k));
    expect(firstKickoffMs(2028, c.ctx)).toBeNull();
    const garbage = ctxFor([2027], { proGames: [proGame(2027, 1, "garbage")] });
    expect(firstKickoffMs(2027, garbage.ctx)).toBeNull();
    const throws = ctxFor([2027], {
      proGames: () => {
        throw new Error("schedule unreadable");
      },
    });
    expect(firstKickoffMs(2027, throws.ctx)).toBeNull();
  });

  it("a past season never; the current season until GRACE days after its first kickoff", () => {
    const at = (now: string) => ctxFor([2027], { now, proGames: [proGame(2027, 1, k)] }).ctx;
    expect(mayBeUnpublished(2026, at("2027-09-01T12:00:00.000Z"))).toBe(false);
    expect(mayBeUnpublished(2027, at("2027-07-15T12:00:00.000Z"))).toBe(true);
    const edge = Date.parse(k) + SEASON_PUBLISH_GRACE_DAYS * DAY;
    expect(mayBeUnpublished(2027, at(new Date(edge - 1).toISOString()))).toBe(true);
    expect(mayBeUnpublished(2027, at(new Date(edge).toISOString()))).toBe(false);
    // a future season (an explicit --seasons) is not published either
    expect(mayBeUnpublished(2028, at("2027-12-01T12:00:00.000Z"))).toBe(true);
    // before July the previous season is still the current one (config defaultSeason)
    expect(mayBeUnpublished(2026, at("2027-06-30T12:00:00.000Z"))).toBe(true);
  });

  it("a schedule that does not know the season cannot prove it started: may be unpublished", () => {
    const c = ctxFor([2027], { now: "2027-12-01T12:00:00.000Z" });
    expect(mayBeUnpublished(2027, c.ctx)).toBe(true);
  });
});
