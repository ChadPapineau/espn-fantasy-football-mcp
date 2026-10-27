// retry-after-hold.test.ts — Stage C remediation, round 3 (finding espn-retry-after-not-persisted; plan
// 01 §6 "honour Retry-After if it ever appears"; the limiter is "shared by every tool and every
// process"). Before, a 429/5xx `Retry-After` was only the wait before a retry inside the same read:
// when it could not fit the deadline the read ended and the hint was dropped, so every later tool
// call sent again inside the hinted window (until three 429s opened the breaker — whose 5 minutes
// are shorter than a 600 s hint). Now the hint holds every request to the read host off until it
// ends, in this process and — kept in the cache's own namespace — in every other: a call inside the
// window serves its cached entry degraded, or answers RATE_LIMITED with the time left, and sends
// nothing; a short hint that fits the deadline is still the read's own retry wait. Injected fetch;
// no network, no cookie.
import { describe, expect, it } from "vitest";
import { fixedClock } from "../../../src/domain/clock.js";
import {
  cachedPublicity,
  cachedRetryAfter,
  retryAfterKey,
} from "../../../src/providers/espn/cache.js";
import { createUpstreamBudget } from "../../../src/providers/platform.js";
import {
  FakeProbeAuthority,
  jsonResponse,
  LEAGUE_ID,
  loadFixture,
  makeWorld,
  MemoryCache,
  NOW_ISO,
  SEASON,
  testCookieHeader,
} from "./helpers.js";

const HOST = "lm-api-reads.fantasy.espn.com";
const RID = "r-0123456789ab";
const pro = () => jsonResponse(loadFixture("recorded/season/proTeamSchedules_wl.json"));
const tooMany = (after: string) => jsonResponse({ messages: [] }, 429, { "retry-after": after });

/** A fetch answering by a script of responses (the last one repeats). */
function scripted(...answers: (() => Response)[]) {
  let i = 0;
  return () => Promise.resolve((answers[Math.min(i++, answers.length - 1)] ?? pro)());
}

describe("ESPN's Retry-After holds the read host off for its whole window", () => {
  it("429 + Retry-After 600: the first call sends one request; calls 5, 10, 15 s later send none (RATE_LIMITED, the time left)", async () => {
    const w = makeWorld({ fetch: scripted(() => tooMany("600")) });
    const results: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      const budget = createUpstreamBudget(RID, w.clock.nowMs());
      results.push(await w.provider.getProSchedule(SEASON, { budget }).catch((e: unknown) => e));
      w.clock.advance(5_000);
    }
    expect(w.sent).toHaveLength(1);
    expect(results.map((e) => (e as { effCode?: unknown }).effCode)).toEqual([
      "RATE_LIMITED",
      "RATE_LIMITED",
      "RATE_LIMITED",
      "RATE_LIMITED",
    ]);
    expect(
      results.slice(1).map((e) => (e as { effDetails: { retry_after_s: number } }).effDetails),
    ).toEqual([
      { retry_after_s: 595, reason: "retry_after" },
      { retry_after_s: 590, reason: "retry_after" },
      { retry_after_s: 585, reason: "retry_after" },
    ]);
    // nothing was charged to a call's budget for a request that could not go out
    expect(w.limiter.rows).toHaveLength(1);
  });

  it("after the window a request goes again", async () => {
    let n = 0;
    const w = makeWorld({ fetch: () => Promise.resolve(n++ === 0 ? tooMany("600") : pro()) });
    await w.provider.getProSchedule(SEASON).catch(() => undefined);
    w.clock.advance(599_000);
    await expect(w.provider.getProSchedule(SEASON)).rejects.toMatchObject({
      effCode: "RATE_LIMITED",
    });
    w.clock.advance(1_000);
    const r = await w.provider.getProSchedule(SEASON);
    expect(r.value.games.length).toBeGreaterThan(200);
    expect(w.sent).toHaveLength(2);
  });

  it("a cached entry inside the window is served degraded (RATE_LIMITED), with no request", async () => {
    let n = 0;
    const w = makeWorld({ fetch: () => Promise.resolve(n++ === 0 ? pro() : tooMany("900")) });
    await w.provider.getProSchedule(SEASON);
    w.clock.advance(7 * 3_600_000); // past the schedule's 6 h TTL, inside its 7 d hard limit
    const first = await w.provider.getProSchedule(SEASON);
    expect(first.stamp.degraded?.code).toBe("RATE_LIMITED");
    w.clock.advance(60_000);
    const inside = await w.provider.getProSchedule(SEASON);
    expect(inside.stamp.degraded).toEqual({
      code: "RATE_LIMITED",
      served: "stale_cache",
      hard_limit_suspended: false,
    });
    expect(w.sent).toHaveLength(2);
  });

  it("another process over the same store honours the kept hold", async () => {
    const cache = new MemoryCache();
    const clock = fixedClock(NOW_ISO);
    const one = makeWorld({ fetch: scripted(() => tooMany("300")), cache, clock });
    await one.provider.getProSchedule(SEASON).catch(() => undefined);
    expect(cache.map.has(retryAfterKey(HOST))).toBe(true);
    clock.advance(10_000);
    const other = makeWorld({ fetch: scripted(pro), cache, clock });
    await expect(other.provider.getProSchedule(SEASON)).rejects.toMatchObject({
      effCode: "RATE_LIMITED",
      effDetails: { retry_after_s: 290, reason: "retry_after" },
    });
    expect(other.sent).toEqual([]);
  });

  it("a short hint that fits the deadline is the read's own retry wait: one read, the retry after it", async () => {
    const w = makeWorld({ fetch: scripted(() => tooMany("3"), pro) });
    const r = await w.provider.getProSchedule(SEASON, {
      budget: createUpstreamBudget(RID, w.clock.nowMs()),
    });
    expect(r.value.games.length).toBeGreaterThan(200);
    expect(w.sent).toHaveLength(2);
    expect(Math.max(...w.sleeps)).toBeGreaterThanOrEqual(3_000);
  });

  it("a timer that wakes a moment early: what is left of the hold is waited out once, then the retry goes", async () => {
    const sleeps: number[] = [];
    const w = makeWorld({
      fetch: scripted(() => tooMany("3"), pro),
      over: {
        // the first wait ends 5 ms short of what it asked for (a real timer may)
        sleep: (ms) => {
          sleeps.push(ms);
          w.clock.advance(sleeps.length === 1 ? ms - 5 : ms);
          return Promise.resolve();
        },
      },
    });
    const r = await w.provider.getProSchedule(SEASON);
    expect(r.value.games.length).toBeGreaterThan(200);
    expect(sleeps).toEqual([3_000, 5]);
    expect(w.sent).toHaveLength(2);
  });

  it("a clock that never moves cannot spin the hold: one wait-out, then the read ends with its failure", async () => {
    const sleeps: number[] = [];
    const w = makeWorld({
      fetch: scripted(() => tooMany("3"), pro),
      over: {
        // a wait that resolves at once on a clock that never moves: a loop around it would never
        // yield, so the test bounds it — a spin fails here instead of hanging the worker
        sleep: (ms) => {
          sleeps.push(ms);
          return sleeps.length > 8 ? Promise.reject(new Error("spun")) : Promise.resolve();
        },
      },
    });
    await expect(w.provider.getProSchedule(SEASON)).rejects.toMatchObject({
      effCode: "RATE_LIMITED",
      effDetails: { upstream_status: 429 },
    });
    expect(sleeps).toEqual([3_000, 3_000]);
    expect(w.sent).toHaveLength(1);
  });

  it("Retry-After: 0 holds nothing (the backoff alone paces the retry)", async () => {
    const w = makeWorld({ fetch: scripted(() => tooMany("0"), pro) });
    const r = await w.provider.getProSchedule(SEASON);
    expect(r.value.games.length).toBeGreaterThan(200);
    expect(w.sent).toHaveLength(2);
  });

  it("a hint longer than the deadline ends the read with its failure; the next call inside it sends nothing", async () => {
    // the first attempt is a 503 with a 30 s hint: it cannot be retried inside a 20 s deadline
    const w = makeWorld({ fetch: scripted(() => jsonResponse({}, 503, { "retry-after": "30" })) });
    const e = await w.provider.getProSchedule(SEASON).catch((x: unknown) => x);
    expect((e as { effCode?: unknown }).effCode).toBe("ESPN_UPSTREAM_UNAVAILABLE");
    expect(w.sent).toHaveLength(1);
    await expect(w.provider.getProSchedule(SEASON)).rejects.toMatchObject({
      effCode: "RATE_LIMITED",
      effDetails: { reason: "retry_after" },
    });
    expect(w.sent).toHaveLength(1);
  });

  it("a hold another process keeps while this read backs off stops its retry: the read ends with its last failure", async () => {
    const cache = new MemoryCache();
    const clock = fixedClock(NOW_ISO);
    const w = makeWorld({
      cache,
      clock,
      // a 503 without a hint: retried after the backoff
      fetch: scripted(() => jsonResponse({}, 503)),
      over: {
        sleep: (ms) => {
          // meanwhile another process received 429 + Retry-After: 120 and kept it
          cachedRetryAfter(cache, HOST, clock).save(clock.nowMs() + 120_000);
          clock.advance(ms);
          return Promise.resolve();
        },
      },
    });
    const e = await w.provider.getProSchedule(SEASON).catch((x: unknown) => x);
    expect((e as { effCode?: unknown }).effCode).toBe("ESPN_UPSTREAM_UNAVAILABLE");
    // the retry never went out (three attempts before)
    expect(w.sent).toHaveLength(1);
    expect(w.limiter.rows).toHaveLength(1);
  });
});

describe("the kept hold (cache.ts cachedRetryAfter)", () => {
  it("keeps only a later, finite instant; an absent, unreadable or broken row reads as none", () => {
    const cache = new MemoryCache();
    const clock = fixedClock(NOW_ISO);
    const kept = cachedRetryAfter(cache, HOST, clock);
    expect(kept.load()).toBeNull();
    kept.save(5_000);
    kept.save(4_000); // earlier: the kept hold stands
    kept.save(Number.NaN);
    kept.save(Number.POSITIVE_INFINITY);
    expect(cache.puts).toBe(1);
    expect(kept.load()).toBe(5_000);
    kept.save(6_000);
    expect(kept.load()).toBe(6_000);
    cache.map.set(retryAfterKey(HOST), {
      ...cache.map.get(retryAfterKey(HOST))!,
      parsed_json: '{"until_ms":"6000"}',
    });
    expect(kept.load()).toBeNull();
    const broken = cachedRetryAfter(
      {
        get: () => {
          throw new Error("db");
        },
        put: () => {
          throw new Error("db");
        },
      },
      HOST,
      clock,
    );
    expect(broken.load()).toBeNull();
    expect(() => {
      broken.save(1_000);
    }).not.toThrow();
  });
});

describe("the credential probe honours the hold, and a probe's own Retry-After sets it", () => {
  const settingsBody = () => {
    const s = structuredClone(loadFixture("recorded/league-a/mSettings.json")) as {
      settings: Record<string, unknown>;
    };
    const nav = loadFixture("recorded/league-a/mNav.json") as Record<string, unknown>;
    s.settings.isPublic = false;
    return { ...s, members: nav.members, teams: nav.teams };
  };

  it("a held host: the probe answers RATE_LIMITED and sends nothing", async () => {
    const auth = new FakeProbeAuthority("validated", {
      ok: true,
      header: testCookieHeader("{00000000-0000-4000-8000-000000000001}"),
    });
    const w = makeWorld({ credentials: auth, fetch: scripted(() => tooMany("120")) });
    await w.provider.getProSchedule(SEASON).catch(() => undefined);
    cachedPublicity(w.cache, LEAGUE_ID, w.clock).save(false);
    const before = w.sent.length;
    await expect(w.provider.probeCredential(w.ref)).rejects.toMatchObject({
      effCode: "RATE_LIMITED",
      effDetails: { reason: "retry_after" },
    });
    expect(w.sent.length).toBe(before);
    expect(auth.observations).toEqual([]);
  });

  it("the probe's 429 + Retry-After holds every later read off", async () => {
    const auth = new FakeProbeAuthority("validated", {
      ok: true,
      header: testCookieHeader("{00000000-0000-4000-8000-000000000001}"),
    });
    const w = makeWorld({
      credentials: auth,
      fetch: scripted(
        () => tooMany("120"),
        () => jsonResponse(settingsBody()),
      ),
    });
    cachedPublicity(w.cache, LEAGUE_ID, w.clock).save(false);
    await w.provider.probeCredential(w.ref).catch(() => undefined);
    expect(w.sent).toHaveLength(1);
    w.clock.advance(1_000);
    await expect(w.provider.getLeague(w.ref)).rejects.toMatchObject({ effCode: "RATE_LIMITED" });
    expect(w.sent).toHaveLength(1);
  });
});
