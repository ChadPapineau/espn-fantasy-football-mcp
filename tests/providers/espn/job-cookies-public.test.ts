// job-cookies-public.test.ts — Stage C remediation, round 3 (finding jobs-public-league-keyless-cap;
// plan 06 §1.4: the snapshot, transactions and credential jobs are "Cookies: Y", budgeted under the
// fleet's ≤ 40 cookie-bearing requests a day, and §5 "designed as cookie-bearing on the user's
// league regardless" of its publicity; changelog V7: the ≤ 30 keyless cap is the drift probe's, the
// pro schedule's and the player index's alone). On a league known public the provider read every
// `auto` view keyless even with cookies stored, so every launchd job's league read spent the keyless
// cap and a game day's late jobs were refused (`RATE_LIMITED`). The jobs (origin `job`) now read the
// user's league with the stored cookie; the server keeps reading a public league keyless; the season
// routes stay keyless for everyone; a cookie-bearing 200 on a public league is still no acceptance,
// and a rejected cookie still reads a public league anonymously. Recorded fixtures, synthetic
// cookies stripped before the fixture fetch (fixture mode refuses cookies); no network.
import { describe, expect, it } from "vitest";
import { ESPN_JOB_DAILY_CAPS } from "../../../src/config/schema.js";
import { cachedPublicity } from "../../../src/providers/espn/cache.js";
import type { PlayerQuery } from "../../../src/providers/platform.js";
import {
  FakeAuthority,
  fixturesIgnoringCookies,
  LEAGUE_ID,
  makeWorld,
  MemoryLimiterRepo,
  SEASON,
  testCookieHeader,
  type World,
} from "./helpers.js";

const SWID = "{00000000-0000-4000-8000-000000000001}";
const pool: PlayerQuery = {
  status: "AVAILABLE",
  position: null,
  sort: "percOwned",
  week: 4,
  injured: null,
};

/** league-a (settings.isPublic: true) with a validated, synthetic cookie stored. */
function world(
  origin: "job" | "server",
  limiter?: MemoryLimiterRepo,
): World & { auth: FakeAuthority } {
  const auth = new FakeAuthority("validated", { ok: true, header: testCookieHeader(SWID) });
  const w = makeWorld({
    fetch: fixturesIgnoringCookies("league-a"),
    credentials: auth,
    ...(limiter === undefined ? {} : { limiter }),
    over: { origin, observer: origin === "job" ? "daily_job" : "server" },
  });
  return { ...w, auth };
}

/** What a snapshot job reads: the league, the roster, a pool page, a box score, the pro schedule. */
async function jobReads(w: World): Promise<void> {
  await w.provider.getLeague(w.ref);
  w.clock.advance(1_000);
  await w.provider.getRosters(w.ref, 3);
  w.clock.advance(1_000);
  await w.provider.listPlayers(w.ref, pool, { limit: 25, offset: 0 });
  w.clock.advance(1_000);
  await w.provider.getBoxScores(w.ref, 3);
  w.clock.advance(1_000);
  await w.provider.getProSchedule(SEASON);
}

const isSeasonRoute = (url: string): boolean => !url.includes(`/leagues/${LEAGUE_ID}`);

describe("the credentialed jobs read a public league with the stored cookie (plan 06 §1.4)", () => {
  it("every league read of a job carries the cookie and is charged to the cookie cap; the season route stays keyless", async () => {
    const w = world("job");
    await jobReads(w);
    expect(w.sent.length).toBe(5);
    for (const s of w.sent) {
      if (isSeasonRoute(s.url)) expect(s.headers.cookie, s.url).toBeUndefined();
      else expect(s.headers.cookie, s.url).toBe(testCookieHeader(SWID));
    }
    expect(w.limiter.rows.map((r) => [r.origin, r.keyless])).toEqual([
      ["job", false],
      ["job", false],
      ["job", false],
      ["job", false],
      ["job", true],
    ]);
    // the league proved public: a cookie-bearing 200 there tests nothing — no acceptance recorded
    expect(w.auth.observations).toEqual([]);
  });

  it("the keyless cap already spent by the probe and the schedule refreshes: the job's league read still goes", async () => {
    const limiter = new MemoryLimiterRepo();
    const dayStart = Date.parse(`${String(SEASON)}-10-06T00:00:00.000Z`);
    // the day's keyless allowance used up by the drift probe and the hourly schedule refreshes
    for (let i = 0; i < ESPN_JOB_DAILY_CAPS.keyless; i++)
      limiter.rows.push({
        id: 1_000 + i,
        at: dayStart + 3_600_000 + i * 60_000,
        keyless: true,
        origin: "job",
        outcome: "ok",
      });
    const w = world("job", limiter);
    const r = await w.provider.getRosters(w.ref, 3);
    expect(r.value.length).toBe(10);
    // the season views are still refused once the keyless cap is spent (the cap is unchanged)
    await expect(w.provider.getProSchedule(SEASON)).rejects.toMatchObject({
      effCode: "RATE_LIMITED",
      effDetails: { reason: "daily_cap" },
    });
  });

  it("the server reads the same public league keyless once it knows it is public (unchanged)", async () => {
    const w = world("server");
    await jobReads(w);
    const [first, ...rest] = w.sent;
    // the first read learns the publicity (cookie-bearing: unknown until then); the rest go keyless
    expect(first?.headers.cookie).toBe(testCookieHeader(SWID));
    for (const s of rest) expect(s.headers.cookie, s.url).toBeUndefined();
    expect(w.limiter.rows.filter((r) => !r.keyless)).toHaveLength(1);
  });

  it("a rejected cookie: a job still reads the public league anonymously, never ESPN_AUTH_REJECTED", async () => {
    const auth = new FakeAuthority("rejected", { ok: true, header: testCookieHeader(SWID) });
    const w = makeWorld({
      fetch: fixturesIgnoringCookies("league-a"),
      credentials: auth,
      over: { origin: "job", observer: "daily_job" },
    });
    cachedPublicity(w.cache, LEAGUE_ID, w.clock).save(true);
    const r = await w.provider.getRosters(w.ref, 3);
    expect(r.value.length).toBe(10);
    for (const s of w.sent) expect(s.headers.cookie, s.url).toBeUndefined();
  });

  it("no cookie stored: a job's reads of a public league are keyless (nothing to send)", async () => {
    const auth = new FakeAuthority("not_configured", { ok: false, reason: "not_configured" });
    const w = makeWorld({
      fetch: fixturesIgnoringCookies("league-a"),
      credentials: auth,
      over: { origin: "job", observer: "daily_job" },
    });
    await w.provider.getRosters(w.ref, 3);
    for (const s of w.sent) expect(s.headers.cookie, s.url).toBeUndefined();
  });
});
