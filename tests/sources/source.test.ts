// source.test.ts — src/sources/source.ts constants (plan 01 §5.7 retries, §6 per-source limiters,
// redirect re-checks, release download timeout; plan 05 parquet codec allow-list).
import { describe, expect, it } from "vitest";
import {
  ALLOWED_PARQUET_CODECS,
  MAX_REDIRECT_HOPS,
  REFRESH_MAX_ATTEMPTS,
  RELEASE_DOWNLOAD_TIMEOUT_MS,
  SOURCE_RATE_LIMITS,
} from "../../src/sources/source.js";

describe("source politeness and limits", () => {
  it("per-source limits match plan 01 §6", () => {
    // the 15-min limit is the release poll's; a run's asset downloads are spaced 1 s apart
    expect(SOURCE_RATE_LIMITS.github_release).toEqual({
      minIntervalMs: 900_000,
      maxPerDay: null,
      downloadMinIntervalMs: 1_000,
    });
    expect(SOURCE_RATE_LIMITS.sleeper.minIntervalMs).toBe(6_000);
    expect(SOURCE_RATE_LIMITS.weather.minIntervalMs).toBe(3_600_000);
    expect(SOURCE_RATE_LIMITS.rss.minIntervalMs).toBe(900_000);
    expect(SOURCE_RATE_LIMITS.odds).toEqual({ minIntervalMs: 3_600_000, maxPerDay: 3 });
    expect(SOURCE_RATE_LIMITS.espn_season).toEqual({ minIntervalMs: 60_000, maxPerDay: 30 });
    expect(Object.isFrozen(SOURCE_RATE_LIMITS)).toBe(true);
    for (const [k, l] of Object.entries(SOURCE_RATE_LIMITS)) {
      expect(l.minIntervalMs, k).toBeGreaterThan(0);
      if (l.maxPerDay !== null) expect(l.maxPerDay, k).toBeGreaterThan(0);
    }
  });
  it("retries, redirects, timeouts and codecs", () => {
    expect(REFRESH_MAX_ATTEMPTS).toBe(3);
    expect(MAX_REDIRECT_HOPS).toBe(3);
    expect(RELEASE_DOWNLOAD_TIMEOUT_MS).toBe(60_000);
    expect(ALLOWED_PARQUET_CODECS).toEqual(["SNAPPY", "UNCOMPRESSED"]);
    expect(Object.isFrozen(ALLOWED_PARQUET_CODECS)).toBe(true);
  });
});
