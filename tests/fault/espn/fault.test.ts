// fault.test.ts — the ESPN fault matrix (plan 05 §4.1, injected fetch; plan 01 §4.3, §6, §7; plan 02
// §2.1): 401/403 on a cookie-bearing request → ESPN_AUTH_REJECTED with NO second request and a
// zero-request short-circuit after; 404 league; 200 skeleton / renamed key → ESPN_DRIFT_DETECTED (no
// cache write, no retry); 400 → INTERNAL; 429 → RATE_LIMITED after 3 attempts with backoff; 5xx → 3
// attempts then the breaker; timeouts and the ≤ 20 s black-hole deadline; ENOTFOUND never retried;
// 302 → ESPN_HOST_MOVED, not followed, the cookie never sent anywhere but the read host; non-JSON,
// malformed and oversized bodies; stale fallback within the hard limit, STALE_ONLY past it,
// allow_stale and the host-moved suspension; the 304 path. No network: every fetch is scripted.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Clock } from "../../../src/domain/clock.js";
import { EspnProvider } from "../../../src/providers/espn/provider.js";
import type { FetchLike } from "../../../src/providers/espn/transport.js";
import { createUpstreamBudget } from "../../../src/providers/platform.js";
import {
  FakeAuthority,
  FakeProbeAuthority,
  jsonResponse,
  loadFixture,
  loadRoster,
  makeWorld,
  MemoryCache,
  MemoryDrift,
  MemoryLimiterRepo,
  NOW_ISO,
  SEASON,
  stubScoring,
  testCookieHeader,
} from "../../providers/espn/helpers.js";

const SWID = "{00000000-0000-4000-8000-000000000008}";
const settingsBody = (isPublic: boolean): unknown => {
  const s = structuredClone(loadFixture("recorded/league-a/mSettings.json")) as {
    settings: Record<string, unknown>;
  };
  const nav = loadFixture("recorded/league-a/mNav.json") as Record<string, unknown>;
  s.settings.isPublic = isPublic;
  return { ...s, members: nav.members, teams: nav.teams };
};
const errBody = (type: string): unknown => ({
  messages: ["prose that must never surface"],
  details: [{ message: "x", type }],
});

/** A fetch scripted by URL view: each view's queue of responses (the last one repeats). */
function scripted(
  script: Record<string, (() => Response | Promise<Response>)[]>,
): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const counters: Record<string, number> = {};
  const inner: FetchLike = (url) => {
    const views = new URL(url).searchParams.getAll("view").join("&");
    calls.push(views);
    const q = script[views];
    if (q === undefined) return Promise.reject(new Error(`unscripted ${views}`));
    const i = counters[views] ?? 0;
    counters[views] = i + 1;
    const make = q[Math.min(i, q.length - 1)]!;
    return Promise.resolve(make());
  };
  return Object.assign(inner, { calls });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("401 / 403 on a cookie-bearing request (plan 02 §2.1)", () => {
  it.each([401, 403])(
    "%i → ESPN_AUTH_REJECTED, one request, rejected observed, then zero-request short-circuit",
    async (status) => {
      const auth = new FakeAuthority("validated", { ok: true, header: testCookieHeader(SWID) });
      const fetch = scripted({
        "mSettings&mNav": [() => jsonResponse(settingsBody(false))],
        mRoster: [() => jsonResponse(errBody("AUTH_LEAGUE_NOT_VISIBLE"), status)],
      });
      const w = makeWorld({ fetch, credentials: auth });
      await w.provider.getLeague(w.ref);
      expect(auth.observations.map((o) => [o.kind, o.by, o.view])).toEqual([
        ["accepted", "server", "mSettings"],
      ]);
      w.clock.advance(1000);
      const e = await w.provider.getRosters(w.ref, 1).catch((x: unknown) => x);
      expect(e).toMatchObject({
        effCode: "ESPN_AUTH_REJECTED",
        effDetails: { upstream_status: status, upstream_type: "AUTH_LEAGUE_NOT_VISIBLE" },
      });
      expect(JSON.stringify(e)).not.toContain("prose");
      expect(fetch.calls.filter((c) => c === "mRoster")).toHaveLength(1);
      expect(auth.observations.at(-1)).toMatchObject({
        kind: "rejected",
        by: "server",
        upstream_status: status,
        view: "mRoster",
      });
      expect(w.sleeps).toEqual([]);
      const before = fetch.calls.length;
      const again = await w.provider.getRosters(w.ref, 2).catch((x: unknown) => x);
      expect(again).toMatchObject({
        effCode: "ESPN_AUTH_REJECTED",
        effDetails: { reason: "short_circuit" },
      });
      expect(fetch.calls.length).toBe(before);
    },
  );
  it("after another process records validated, the next cookie-bearing call goes through (no restart)", async () => {
    const auth = new FakeAuthority("rejected", { ok: true, header: testCookieHeader(SWID) });
    const fetch = scripted({ "mSettings&mNav": [() => jsonResponse(settingsBody(false))] });
    const w = makeWorld({ fetch, credentials: auth });
    await expect(w.provider.getLeague(w.ref)).rejects.toMatchObject({
      effCode: "ESPN_AUTH_REJECTED",
    });
    expect(fetch.calls).toHaveLength(0);
    auth.current = "validated";
    await w.provider.getLeague(w.ref);
    expect(fetch.calls).toHaveLength(1);
  });
  it("acceptance on a private league is re-recorded at most hourly while validated", async () => {
    const auth = new FakeAuthority("validated", { ok: true, header: testCookieHeader(SWID) });
    const fetch = scripted({
      "mSettings&mNav": [() => jsonResponse(settingsBody(false))],
      "mTeam&mStandings": [() => jsonResponse(loadFixture("recorded/league-a/mTeam.json"))],
    });
    const w = makeWorld({ fetch, credentials: auth });
    await w.provider.getLeague(w.ref);
    await w.provider.getStandings(w.ref);
    expect(auth.observations.filter((o) => o.kind === "accepted")).toHaveLength(1);
    w.clock.advance(61 * 60 * 1000);
    await w.provider.getStandings(w.ref);
    expect(auth.observations.filter((o) => o.kind === "accepted")).toHaveLength(2);
  });
  it("credential store problems are INTERNAL with zero requests; an observe() failure never changes the result", async () => {
    const unreadable = new FakeAuthority("stored", { ok: false, reason: "unreadable" });
    const w = makeWorld({ fetch: scripted({}), credentials: unreadable });
    await expect(w.provider.getLeague(w.ref)).rejects.toMatchObject({
      effCode: "INTERNAL",
      effDetails: { reason: "credential_unreadable" },
    });
    const throwing = new FakeAuthority("validated", { ok: true, header: testCookieHeader(SWID) });
    throwing.observe = () => Promise.reject(new Error("row busy"));
    const w2 = makeWorld({
      fetch: scripted({ "mSettings&mNav": [() => jsonResponse(settingsBody(false))] }),
      credentials: throwing,
    });
    await expect(w2.provider.getLeague(w2.ref)).resolves.toBeTruthy();
  });
});

describe("keyless 401 and cookie-required views (plan 01 §4.3 ESPN_REQUIRES_COOKIES)", () => {
  it("a private league read keyless → ESPN_REQUIRES_COOKIES; then required views short-circuit", async () => {
    const fetch = scripted({
      "mSettings&mNav": [() => jsonResponse(errBody("AUTH_LEAGUE_NOT_VISIBLE"), 401)],
    });
    const w = makeWorld({ fetch });
    await expect(w.provider.getLeague(w.ref)).rejects.toMatchObject({
      effCode: "ESPN_REQUIRES_COOKIES",
    });
    await expect(w.provider.listPendingTransactions(w.ref)).rejects.toMatchObject({
      effCode: "ESPN_REQUIRES_COOKIES",
    });
    expect(fetch.calls).toEqual(["mSettings&mNav", "mSettings&mNav"]);
  });
  it("transactions on a public league with no credential are tried keyless; on an unknown league refused", async () => {
    const txn = (
      loadFixture("recorded/league-b/kona_playercard.json") as {
        players: { transactions?: unknown[] }[];
      }
    ).players.flatMap((p) => p.transactions ?? []);
    const fetch = scripted({
      "mSettings&mNav": [() => jsonResponse(settingsBody(true))],
      mTransactions2: [
        () =>
          jsonResponse({ transactions: [...txn, { broken: true }] }, 200, {
            "x-fantasy-filter-transaction-count": "99",
          }),
      ],
      mPendingTransactions: [() => jsonResponse({ pendingTransactions: txn.slice(0, 1) })],
    });
    const w0 = makeWorld({ fetch: scripted({}) });
    await expect(
      w0.provider.listTransactions(w0.ref, {
        types: ["WAIVER"],
        week: 3,
        since: null,
        count: 5,
        team_id: null,
      }),
    ).rejects.toMatchObject({
      effCode: "ESPN_REQUIRES_COOKIES",
    });
    const w = makeWorld({ fetch });
    await w.provider.getLeague(w.ref);
    const page = await w.provider.listTransactions(w.ref, {
      types: ["WAIVER", "FREEAGENT", "DRAFT"],
      week: 3,
      since: null,
      count: 2,
      team_id: null,
    });
    expect(page.value).toMatchObject({
      count: 2,
      limit: 2,
      total: 99,
      has_more: true,
      next_offset: 2,
    });
    const at = (t: { process_date: string | null; proposed_date: string | null }) =>
      t.process_date ?? t.proposed_date ?? "";
    expect(at(page.value.items[0]!) >= at(page.value.items[1]!)).toBe(true);
    const filtered = await w.provider.listTransactions(w.ref, {
      types: ["WAIVER", "FREEAGENT", "DRAFT"],
      week: 3,
      since: "2026-09-20T00:00:00Z",
      count: 50,
      team_id: 4,
    });
    expect(filtered.value.total).toBeNull();
    expect(filtered.value.items.every((t) => t.team_id === 4)).toBe(true);
    const pending = await w.provider.listPendingTransactions(w.ref);
    expect(pending.value).toHaveLength(1);
    expect(fetch.calls.every((c) => c !== "")).toBe(true);
  });
});

describe("drift in call (plan 01 §7)", () => {
  it("a 200 skeleton for mRoster → ESPN_DRIFT_DETECTED; drift_state red; nothing cached; no retry; standings still work", async () => {
    const fetch = scripted({
      "mSettings&mNav": [() => jsonResponse(settingsBody(true))],
      mRoster: [() => jsonResponse(loadFixture("recorded/league-a/skeleton.json"))],
      "mTeam&mStandings": [() => jsonResponse(loadFixture("recorded/league-a/mTeam.json"))],
    });
    const w = makeWorld({ fetch });
    const e = await w.provider.getRosters(w.ref, 1).catch((x: unknown) => x);
    expect(e).toMatchObject({
      effCode: "ESPN_DRIFT_DETECTED",
      effDetails: { view: "mRoster", path: "teams[].roster.entries" },
    });
    expect(fetch.calls.filter((c) => c === "mRoster")).toHaveLength(1);
    expect(w.drift.row?.status).toBe("red");
    expect([...w.cache.map.keys()].some((k) => k.includes("mRoster"))).toBe(false);
    expect(w.limiter.rows.at(-1)?.outcome).toBe("ok");
    const st = await w.provider.getStandings(w.ref);
    expect(st.stamp.drift).toBeNull();
    // a later mRoster read from cache would carry meta.drift; the next fresh read re-checks
    await expect(w.provider.getRosters(w.ref, 1)).rejects.toMatchObject({
      effCode: "ESPN_DRIFT_DETECTED",
    });
  });
  it("a renamed / missing required key deep in the body names the path (schema hard-fail)", async () => {
    const body = loadRoster("league-a", 3) as {
      teams: { roster: { entries: Record<string, unknown>[] } }[];
    };
    delete body.teams[0]!.roster.entries[0]!.playerId;
    const fetch = scripted({
      "mSettings&mNav": [() => jsonResponse(settingsBody(true))],
      mRoster: [() => jsonResponse(body)],
    });
    const w = makeWorld({ fetch });
    await expect(w.provider.getRosters(w.ref, 3)).rejects.toMatchObject({
      effCode: "ESPN_DRIFT_DETECTED",
      effDetails: { view: "mRoster", path: "teams[].roster.entries[].playerId" },
    });
  });
  it("mSettings drift refuses to score and every read carries meta.drift (T-14)", async () => {
    const broken = structuredClone(settingsBody(true)) as { settings: Record<string, unknown> };
    delete broken.settings.scoringSettings;
    const fetch = scripted({
      "mSettings&mNav": [() => jsonResponse(broken), () => jsonResponse(settingsBody(true))],
      "mTeam&mStandings": [() => jsonResponse(loadFixture("recorded/league-a/mTeam.json"))],
    });
    const w = makeWorld({ fetch });
    await expect(w.provider.getScoringSettings(w.ref)).rejects.toMatchObject({
      effCode: "ESPN_DRIFT_DETECTED",
      effDetails: { view: "mSettings" },
    });
    expect(w.provider.scoringRefusal()).toBe("settings_drift");
    const st = await w.provider.getStandings(w.ref);
    expect(st.stamp.drift?.views).toEqual(["mSettings"]);
    await expect(w.provider.getScoringSettings(w.ref)).rejects.toMatchObject({
      effDetails: { path: "settings.scoringSettings" },
    });
  });
  it("unknown enum values are counted once (soft), never fatal", async () => {
    const kona = structuredClone(loadFixture("recorded/league-a/kona_player_info.json")) as {
      players: { player: { injuryStatus: string } }[];
    };
    kona.players[0]!.player.injuryStatus = "BRAND_NEW_STATUS";
    const w = makeWorld({
      fetch: scripted({
        kona_player_info: [
          () => jsonResponse(kona, 200, { "x-fantasy-filter-player-count": "800" }),
        ],
      }),
      over: {
        observations: (await import("../../../src/drift/manifest.js")).observationsFrom(
          loadFixture("../drift/manifest.json"),
        ),
      },
    });
    const page = await w.provider.listPlayers(
      w.ref,
      { status: "AVAILABLE", position: null, sort: "percOwned", week: 4, injured: null },
      { limit: 25, offset: 0 },
    );
    expect(page.value.items[0]?.injury_status).toBe("BRAND_NEW_STATUS");
    expect(w.drift.row?.status).toBe("additive");
    const puts = w.drift.puts;
    w.clock.advance(2 * 3600 * 1000);
    await w.provider.listPlayers(
      w.ref,
      { status: "AVAILABLE", position: null, sort: "percOwned", week: 4, injured: null },
      { limit: 25, offset: 0 },
    );
    expect(w.drift.puts).toBe(puts);
  });
});

describe("status codes (never retried: 400/401/403/404)", () => {
  it("404 GENERAL_NOT_FOUND → ESPN_LEAGUE_NOT_FOUND, one request", async () => {
    const fetch = scripted({
      "mSettings&mNav": [
        () => jsonResponse(loadFixture("recorded/errors/404-league-not-found.json"), 404),
      ],
    });
    const w = makeWorld({ fetch });
    await expect(w.provider.getLeague(w.ref)).rejects.toMatchObject({
      effCode: "ESPN_LEAGUE_NOT_FOUND",
      effDetails: { upstream_type: "GENERAL_NOT_FOUND" },
    });
    expect(fetch.calls).toHaveLength(1);
  });
  it("400 FILTER_LIMIT_MISSING_SORT → INTERNAL, one request, logged", async () => {
    const logs: string[] = [];
    const fetch = scripted({
      kona_player_info: [
        () => jsonResponse(loadFixture("recorded/errors/400-limit-missing-sort.json"), 400),
      ],
    });
    const w = makeWorld({
      fetch,
      over: { log: { debug: (e) => logs.push(e), warn: (e) => logs.push(e) } },
    });
    await expect(
      w.provider.listPlayers(
        w.ref,
        { status: "ALL", position: null, sort: "percOwned", week: 1, injured: null },
        { limit: 5, offset: 0 },
      ),
    ).rejects.toMatchObject({
      effCode: "INTERNAL",
      effDetails: { upstream_type: "FILTER_LIMIT_MISSING_SORT" },
    });
    expect(fetch.calls).toHaveLength(1);
    expect(logs).toContain("espn.request.failed");
  });
  it("429 → RATE_LIMITED after 3 attempts with backoff (1 s, 2 s); no 4th attempt", async () => {
    const fetch = scripted({ proTeamSchedules_wl: [() => jsonResponse({}, 429)] });
    const w = makeWorld({ fetch });
    await expect(w.provider.getProSchedule(SEASON)).rejects.toMatchObject({
      effCode: "RATE_LIMITED",
    });
    expect(fetch.calls).toHaveLength(3);
    expect(w.sleeps).toEqual([1000, 2000]);
    expect(w.limiter.rows).toHaveLength(1);
    expect(w.limiter.rows[0]?.outcome).toBe("rate_limited");
  });
  it("Retry-After is honoured when ESPN ever sends one", async () => {
    const fetch = scripted({
      proTeamSchedules_wl: [
        () => jsonResponse({}, 503, { "retry-after": "3" }),
        () => jsonResponse(loadFixture("recorded/season/proTeamSchedules_wl.json")),
      ],
    });
    const w = makeWorld({ fetch });
    await w.provider.getProSchedule(SEASON);
    expect(w.sleeps).toEqual([3000]);
  });
  it("500/503 → 3 attempts, ESPN_UPSTREAM_UNAVAILABLE; the breaker opens; the next call sends nothing", async () => {
    const fetch = scripted({
      proTeamSchedules_wl: [
        () =>
          new Response("<html>oops</html>", {
            status: 503,
            headers: { "content-type": "text/html" },
          }),
      ],
    });
    const w = makeWorld({ fetch });
    const e = await w.provider.getProSchedule(SEASON).catch((x: unknown) => x);
    expect(e).toMatchObject({
      effCode: "ESPN_UPSTREAM_UNAVAILABLE",
      effDetails: { upstream_status: 503 },
    });
    expect(JSON.stringify(e)).not.toContain("oops");
    expect(fetch.calls).toHaveLength(3);
    expect(w.provider.transportStatus()).toMatchObject({
      breaker_open: true,
      consecutive_failures: 3,
    });
    await expect(w.provider.getProSchedule(SEASON)).rejects.toMatchObject({
      effCode: "ESPN_UPSTREAM_UNAVAILABLE",
      effDetails: { reason: "breaker_open" },
    });
    expect(fetch.calls).toHaveLength(3);
  });
  it("ENOTFOUND / ECONNREFUSED → immediately, zero retries; ECONNRESET → retried", async () => {
    const dns = Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" });
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    let calls = 0;
    const w = makeWorld({
      fetch: () => (calls++, Promise.reject(new TypeError("fetch failed", { cause: dns }))),
    });
    await expect(w.provider.getProSchedule(SEASON)).rejects.toMatchObject({
      effCode: "ESPN_UPSTREAM_UNAVAILABLE",
    });
    expect(calls).toBe(1);
    expect(w.sleeps).toEqual([]);
    let resets = 0;
    const w2 = makeWorld({ fetch: () => (resets++, Promise.reject(reset)) });
    await expect(w2.provider.getProSchedule(SEASON)).rejects.toMatchObject({
      effCode: "ESPN_UPSTREAM_UNAVAILABLE",
    });
    expect(resets).toBe(3);
  });
});

describe("timeouts and the ≤ 20 s per-call deadline (ADV OBJ-20)", () => {
  const wallClock: Clock = {
    nowMs: () => Date.now(),
    nowIso: () => new Date(Date.now()).toISOString(),
  };
  const hanging: FetchLike = (_u, init) =>
    new Promise<Response>((_res, rej) => {
      init.signal?.addEventListener("abort", () => {
        rej(new DOMException("aborted", "AbortError"));
      });
    });
  it("a black hole (every attempt times out) ends within 20 s of the call", async () => {
    vi.useFakeTimers({ now: Date.parse(NOW_ISO) });
    const provider = new EspnProvider({
      config: {
        leagueId: "0",
        season: SEASON,
        teamId: null,
        espnReadHost: "lm-api-reads.fantasy.espn.com",
        fixtureRecord: false,
      },
      fetch: hanging,
      credentials: null,
      repos: {
        limiter: new MemoryLimiterRepo(),
        cache: new MemoryCache(),
        driftState: new MemoryDrift(),
      },
      clock: wallClock,
      scoring: stubScoring,
      random: () => 0.5,
    });
    const start = Date.now();
    const budget = createUpstreamBudget("r-0123456789ab", start);
    let endedAt = 0;
    const p = provider.getProSchedule(SEASON, { budget }).catch((e: unknown) => {
      endedAt = Date.now();
      return e;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    const e = await p;
    expect(e).toMatchObject({
      effCode: "ESPN_UPSTREAM_UNAVAILABLE",
      effDetails: { reason: "attempt_timeout" },
    });
    expect(endedAt - start).toBeLessThanOrEqual(20_000);
    expect(provider.transportStatus().consecutive_failures).toBe(2);
  });
  it("a short attempt timeout is a classified timeout (retried, then unavailable)", async () => {
    let calls = 0;
    const w = makeWorld({
      fetch: (u, i) => (calls++, hanging(u, i)),
      over: { attemptTimeoutMs: 5 },
    });
    await expect(w.provider.getProSchedule(SEASON)).rejects.toMatchObject({
      effCode: "ESPN_UPSTREAM_UNAVAILABLE",
    });
    expect(calls).toBe(3);
    expect(w.limiter.rows[0]?.outcome).toBe("timeout");
  });
});

describe("host moved, non-JSON, malformed, oversized (plan 01 §4.3, §7; plan 02 §5)", () => {
  it("302 to www.espn.com → ESPN_HOST_MOVED: not followed, the cookie only ever went to the read host", async () => {
    const auth = new FakeAuthority("validated", { ok: true, header: testCookieHeader(SWID) });
    const urls: { url: string; cookie: string | undefined; redirect: unknown }[] = [];
    const w = makeWorld({
      credentials: auth,
      fetch: (url, init) => {
        urls.push({
          url,
          cookie: (init.headers as Record<string, string>).cookie,
          redirect: init.redirect,
        });
        return Promise.resolve(
          new Response("Redirecting", {
            status: 302,
            headers: { location: "https://www.espn.com/fantasy/", "content-type": "text/plain" },
          }),
        );
      },
    });
    await expect(w.provider.getLeague(w.ref)).rejects.toMatchObject({
      effCode: "ESPN_HOST_MOVED",
      effDetails: { reason: "redirect_not_followed" },
    });
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]!.url).hostname).toBe("lm-api-reads.fantasy.espn.com");
    expect(urls[0]!.redirect).toBe("manual");
    expect(w.drift.row).toMatchObject({
      status: "host_moved",
      host: "lm-api-reads.fantasy.espn.com",
    });
    expect(w.drift.row?.host_moved_at).toBe(NOW_ISO);
    expect(w.provider.transportStatus().breaker_open).toBe(true);
    expect(auth.observations).toEqual([]);
  });
  it("a non-JSON 200 (HTML) is ESPN_HOST_MOVED and never parsed as data; a good answer later clears it", async () => {
    const fetch = scripted({
      proTeamSchedules_wl: [
        () =>
          new Response("<html>Access Denied</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
        () => jsonResponse(loadFixture("recorded/season/proTeamSchedules_wl.json")),
      ],
    });
    const w = makeWorld({ fetch });
    await expect(w.provider.getProSchedule(SEASON)).rejects.toMatchObject({
      effCode: "ESPN_HOST_MOVED",
      effDetails: { reason: "non_json_body" },
    });
    w.clock.advance(5 * 60 * 1000 + 1);
    await w.provider.getProSchedule(SEASON);
    expect(w.drift.row?.status).toBe("green");
    expect(w.drift.row?.host_moved_at).toBeNull();
  });
  it("malformed JSON → ESPN_UPSTREAM_UNAVAILABLE; no throw of a raw SyntaxError escapes", async () => {
    const w = makeWorld({
      fetch: () =>
        Promise.resolve(
          new Response('{"settings": {', {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
    });
    const e = await w.provider.getProSchedule(SEASON).catch((x: unknown) => x);
    expect(e).toMatchObject({ effCode: "ESPN_UPSTREAM_UNAVAILABLE" });
    expect((e as Error).name).toBe("EspnUpstreamError");
  });
  it("an oversized body (> 8 MB) — declared or streamed — is refused with bounded memory", async () => {
    const w = makeWorld({
      fetch: () =>
        Promise.resolve(
          new Response("{}", {
            status: 200,
            headers: {
              "content-type": "application/json",
              "content-length": String(9 * 1024 * 1024),
            },
          }),
        ),
    });
    await expect(w.provider.getProSchedule(SEASON)).rejects.toMatchObject({
      effCode: "ESPN_UPSTREAM_UNAVAILABLE",
    });
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        sent++;
        c.enqueue(chunk);
        if (sent > 20) c.close();
      },
    });
    const w2 = makeWorld({
      fetch: () =>
        Promise.resolve(
          new Response(stream, { status: 200, headers: { "content-type": "application/json" } }),
        ),
    });
    await expect(w2.provider.getProSchedule(SEASON)).rejects.toMatchObject({
      effCode: "ESPN_UPSTREAM_UNAVAILABLE",
    });
    expect(sent).toBeLessThanOrEqual(10);
  });
  it("x-fantasy-filter-player-count absent → page.total null, has_more from the page length", async () => {
    const kona = loadFixture("recorded/league-a/kona_player_info.json");
    const w = makeWorld({ fetch: () => Promise.resolve(jsonResponse(kona)) });
    const page = await w.provider.listPlayers(
      w.ref,
      { status: "AVAILABLE", position: null, sort: "percOwned", week: 4, injured: null },
      { limit: 25, offset: 0 },
    );
    expect(page.value).toMatchObject({ total: null, has_more: true, next_offset: 25 });
    const short = await w.provider.listPlayers(
      w.ref,
      { status: "AVAILABLE", position: null, sort: "percOwned", week: 4, injured: null },
      { limit: 50, offset: 0 },
    );
    expect(short.value).toMatchObject({ total: null, has_more: false, next_offset: null });
  });
});

describe("stale fallback (plan 01 §5.4, §5.7, ADV OBJ-06)", () => {
  const ok = () =>
    jsonResponse(loadFixture("recorded/season/proTeamSchedules_wl.json"), 200, { etag: 'W/"abc"' });
  const down = () => jsonResponse({}, 503);
  it("past the TTL, a failed refresh serves the entry with ESPN_UPSTREAM_UNAVAILABLE (degraded)", async () => {
    const fetch = scripted({ proTeamSchedules_wl: [ok, down] });
    const w = makeWorld({ fetch });
    await w.provider.getProSchedule(SEASON);
    w.clock.advance(7 * 3600 * 1000);
    const r = await w.provider.getProSchedule(SEASON);
    expect(r.stamp.degraded).toEqual({
      code: "ESPN_UPSTREAM_UNAVAILABLE",
      served: "stale_cache",
      hard_limit_suspended: false,
    });
    expect(r.stamp.cache).toBe("breaker");
  });
  it("past the hard limit → STALE_ONLY; allow_stale serves it; a host move suspends the limit", async () => {
    const fetch = scripted({ proTeamSchedules_wl: [ok, down] });
    const w = makeWorld({ fetch });
    await w.provider.getProSchedule(SEASON);
    w.clock.advance(8 * 24 * 3600 * 1000);
    await expect(w.provider.getProSchedule(SEASON)).rejects.toMatchObject({
      effCode: "STALE_ONLY",
      effDetails: { view: "proTeamSchedules_wl" },
    });
    const stale = await w.provider.getProSchedule(SEASON, { allow_stale: true });
    expect(stale.stamp.degraded?.code).toBe("ESPN_UPSTREAM_UNAVAILABLE");
    // the suspension applies to ESPN classes (plan 01 §7); the pro schedule is a dataset class
    const ratings = {
      positionAgainstOpponent: (
        loadFixture("recorded/league-a/kona_player_info.json") as {
          positionAgainstOpponent: unknown;
        }
      ).positionAgainstOpponent,
    };
    const moved = scripted({
      mPositionalRatings: [
        () => jsonResponse(ratings),
        () =>
          new Response("x", { status: 301, headers: { location: "https://elsewhere.example/" } }),
      ],
    });
    const w2 = makeWorld({ fetch: moved });
    await w2.provider.getPositionalRatings(w2.ref, 4);
    w2.clock.advance(8 * 24 * 3600 * 1000);
    const served = await w2.provider.getPositionalRatings(w2.ref, 4);
    expect(served.stamp.degraded).toEqual({
      code: "ESPN_HOST_MOVED",
      served: "stale_cache",
      hard_limit_suspended: true,
    });
    expect(served.value.length).toBeGreaterThan(100);
    w.clock.advance(1);
    await expect(w.provider.getProSchedule(SEASON)).rejects.toMatchObject({
      effCode: "STALE_ONLY",
    });
  });
  it("our own limiter refusing serves the entry as RATE_LIMITED (degraded)", async () => {
    const fetch = scripted({ proTeamSchedules_wl: [ok] });
    const w = makeWorld({ fetch });
    await w.provider.getProSchedule(SEASON);
    w.clock.advance(7 * 3600 * 1000);
    for (let i = 0; i < 30; i++)
      w.limiter.rows.push({
        id: 1000 + i,
        at: w.clock.nowMs() - 1000 - i,
        keyless: true,
        origin: "server",
        outcome: "ok",
      });
    const r = await w.provider.getProSchedule(SEASON);
    expect(r.stamp.degraded?.code).toBe("RATE_LIMITED");
  });
  it("a limiter row that cannot be written: nothing is sent (fail closed) — INTERNAL", async () => {
    const fetch = scripted({ proTeamSchedules_wl: [ok] });
    const w = makeWorld({ fetch });
    w.limiter.failWrites = true;
    await expect(w.provider.getProSchedule(SEASON)).rejects.toMatchObject({
      effCode: "INTERNAL",
      effDetails: { reason: "limiter_unavailable" },
    });
    expect(fetch.calls).toHaveLength(0);
  });
  it("If-None-Match → 304 serves the cached body and counts it (etag_304_count)", async () => {
    const seen: (string | undefined)[] = [];
    let n = 0;
    const w = makeWorld({
      fetch: (_u, init) => {
        seen.push((init.headers as Record<string, string>)["if-none-match"]);
        return Promise.resolve(n++ === 0 ? ok() : new Response(null, { status: 304 }));
      },
    });
    await w.provider.getProSchedule(SEASON);
    w.clock.advance(7 * 3600 * 1000);
    const r = await w.provider.getProSchedule(SEASON);
    expect(seen).toEqual([undefined, 'W/"abc"']);
    expect(r.value.games).toHaveLength(272);
    expect(w.provider.transportStatus().etag_304_count).toBe(1);
    expect(w.limiter.rows.at(-1)?.outcome).toBe("not_modified");
  });
  it("a cache that throws on read or write never changes the answer", async () => {
    const w = makeWorld({ fetch: scripted({ proTeamSchedules_wl: [ok] }) });
    w.cache.get = () => {
      throw new Error("read");
    };
    w.cache.put = () => {
      throw new Error("write");
    };
    await expect(w.provider.getProSchedule(SEASON)).resolves.toBeTruthy();
  });
});

describe("the explicit credential probe (plan 02 §2.1; plan 07 G2)", () => {
  const probeAuth = () =>
    new FakeProbeAuthority("validated", { ok: true, header: testCookieHeader(SWID) });
  it("not configured → accepted null, zero requests", async () => {
    const w = makeWorld({ fetch: scripted({}) });
    const r = await w.provider.probeCredential(w.ref);
    expect(r).toMatchObject({
      accepted: null,
      probe: "settings",
      reason: "not_configured",
      upstream_status: null,
    });
  });
  it("private league: mSettings 200 → accepted (by check_auth); 401 → rejected; 404 → league not found", async () => {
    for (const [status, accepted] of [
      [200, true],
      [401, false],
      [403, false],
    ] as const) {
      const auth = probeAuth();
      const fetch = scripted({
        "mSettings&mNav": [() => jsonResponse(settingsBody(false))],
        mSettings: [
          () =>
            status === 200
              ? jsonResponse(settingsBody(false))
              : jsonResponse(errBody("AUTH_LEAGUE_NOT_VISIBLE"), status),
        ],
      });
      const w = makeWorld({ fetch, credentials: auth });
      await w.provider.getLeague(w.ref);
      const r = await w.provider.probeCredential(w.ref);
      expect(r).toMatchObject({
        accepted,
        probe: "settings",
        upstream_status: status,
        reason: null,
        checked_at: w.clock.nowIso(),
      });
      expect(auth.observations.at(-1)).toMatchObject({
        kind: accepted ? "accepted" : "rejected",
        by: "check_auth",
        view: "mSettings",
      });
      expect(auth.probeCalls).toBe(1);
    }
    const w = makeWorld({
      fetch: scripted({
        "mSettings&mNav": [() => jsonResponse(settingsBody(false))],
        mSettings: [() => jsonResponse(errBody("GENERAL_NOT_FOUND"), 404)],
      }),
      credentials: probeAuth(),
    });
    await w.provider.getLeague(w.ref);
    await expect(w.provider.probeCredential(w.ref)).rejects.toMatchObject({
      effCode: "ESPN_LEAGUE_NOT_FOUND",
    });
    const w5 = makeWorld({
      fetch: scripted({
        "mSettings&mNav": [() => jsonResponse(settingsBody(false))],
        mSettings: [() => jsonResponse({}, 500)],
      }),
      credentials: probeAuth(),
    });
    await w5.provider.getLeague(w5.ref);
    await expect(w5.provider.probeCredential(w5.ref)).rejects.toMatchObject({
      effCode: "ESPN_UPSTREAM_UNAVAILABLE",
    });
  });
  it("public league: the board probe with its anonymous control (body discarded)", async () => {
    const run = async (control: number, probe: number) => {
      const auth = probeAuth();
      const statuses = [control, probe];
      const sent: (string | undefined)[] = [];
      const w = makeWorld({
        credentials: auth,
        fetch: (url, init) => {
          if (url.includes("communication")) {
            sent.push((init.headers as Record<string, string>).cookie);
            const s = statuses.shift()!;
            return Promise.resolve(
              jsonResponse(
                s === 200
                  ? { topics: [{ text: "member chatter" }] }
                  : errBody("AUTH_COMMUNICATION_NOT_VISIBLE"),
                s,
              ),
            );
          }
          return Promise.resolve(jsonResponse(settingsBody(true)));
        },
      });
      const r = await w.provider.probeCredential(w.ref);
      expect(JSON.stringify(r)).not.toContain("chatter");
      return { r, sent, auth };
    };
    const ok = await run(401, 200);
    expect(ok.r).toMatchObject({ accepted: true, probe: "board", upstream_status: 200 });
    expect(ok.sent[0]).toBeUndefined();
    expect(ok.sent[1]).toContain("SWID=");
    expect((await run(401, 404)).r.accepted).toBe(true);
    const rej = await run(401, 401);
    expect(rej.r).toMatchObject({ accepted: false, probe: "board" });
    expect(rej.auth.observations.at(-1)).toMatchObject({
      kind: "rejected",
      view: "kona_league_communication",
    });
    expect((await run(404, 200)).r).toMatchObject({
      accepted: null,
      reason: "board_not_discriminating",
      upstream_status: 404,
    });
    await expect(run(401, 500)).rejects.toMatchObject({ effCode: "ESPN_UPSTREAM_UNAVAILABLE" });
  });
  it("rejected without probe access reports the short-circuit (no request); with it, the probe runs", async () => {
    const plain = new FakeAuthority("rejected", { ok: true, header: testCookieHeader(SWID) });
    const fetch = scripted({});
    const w = makeWorld({ fetch, credentials: plain });
    expect(await w.provider.probeCredential(w.ref)).toMatchObject({
      accepted: false,
      upstream_status: null,
    });
    expect(fetch.calls).toHaveLength(0);
    const auth = new FakeProbeAuthority("rejected", { ok: true, header: testCookieHeader(SWID) });
    const w2 = makeWorld({
      credentials: auth,
      fetch: scripted({
        "mSettings&mNav": [() => jsonResponse(errBody("AUTH_LEAGUE_NOT_VISIBLE"), 401)],
        mSettings: [() => jsonResponse(settingsBody(false))],
      }),
    });
    const r = await w2.provider.probeCredential(w2.ref);
    expect(r).toMatchObject({ accepted: true, probe: "settings" });
    const nc = new FakeAuthority("stored", { ok: false, reason: "not_configured" });
    expect(
      (
        await makeWorld({ fetch: scripted({}), credentials: nc }).provider.probeCredential(
          makeWorld().ref,
        )
      ).reason,
    ).toBe("not_configured");
  });
});

describe("fixture mode guard (plan 05 §3.1 step 5)", () => {
  it("fixture mode refuses a cookie-bearing request (INTERNAL, never retried)", async () => {
    const auth = new FakeAuthority("validated", { ok: true, header: testCookieHeader(SWID) });
    const w = makeWorld({ credentials: auth });
    await expect(w.provider.getLeague(w.ref)).rejects.toMatchObject({
      effCode: "INTERNAL",
      effDetails: { reason: "fixture_cookie_refused" },
    });
    expect(w.sent).toHaveLength(1);
  });
});
