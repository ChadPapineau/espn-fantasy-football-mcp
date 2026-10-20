// probe-plan.test.ts — the definitive credential probe as plan 02 §2.1 "The definitive check", plan
// 06 §1.4 and plan 07 G2 draw it (ADV OBJ-14, OBJ-26; R3 nit (c); changelog R-5, K1), wired through
// src/auth/probe.ts `planDefinitiveProbe` over the credential_state row. Stage C finding
// auth-probe-definitive-plan-unwired: (1) after a rejection on a public league whose board does not
// discriminate, the rejected view was never re-probed, so Rejected → Validated needed a human; (2)
// the anonymous board control was re-sent before every probe though setup caches it; (3) the probe
// took no budget (35 s and 3 requests under a black hole). Scripted fetch; no network; the cookie is
// the synthetic test header.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Clock } from "../../../src/domain/clock.js";
import { boardControlKey, publicityKey } from "../../../src/providers/espn/cache.js";
import { createEspnProvider } from "../../../src/providers/espn/index.js";
import { EspnProvider } from "../../../src/providers/espn/provider.js";
import type { FetchLike } from "../../../src/providers/espn/transport.js";
import { createUpstreamBudget } from "../../../src/providers/platform.js";
import type { CredentialStateRow } from "../../../src/store/types.js";
import {
  FakeProbeAuthority,
  jsonResponse,
  loadFixture,
  makeWorld,
  MemoryCache,
  MemoryDrift,
  MemoryLimiterRepo,
  NOW_ISO,
  SEASON,
  stubScoring,
  testCookieHeader,
} from "./helpers.js";

const SWID = "{00000000-0000-4000-8000-000000000008}";
const settingsBody = (isPublic: boolean): unknown => {
  const s = structuredClone(loadFixture("recorded/league-a/mSettings.json")) as {
    settings: Record<string, unknown>;
  };
  const nav = loadFixture("recorded/league-a/mNav.json") as Record<string, unknown>;
  s.settings.isPublic = isPublic;
  return { ...s, members: nav.members, teams: nav.teams };
};
const errBody = (type: string): unknown => ({ messages: ["x"], details: [{ message: "x", type }] });

/** One request as the probe sent it: its views and whether it carried the cookie. */
interface Sent {
  readonly views: string;
  readonly cookie: boolean;
  readonly filter: string | null;
}

/**
 * ESPN as scripted per `views` and cookie: `views` alone answers either way, `views+cookie` only a
 * cookie-bearing request. Every request is recorded.
 */
function espn(script: Record<string, (() => Response)[]>): FetchLike & { sent: Sent[] } {
  const sent: Sent[] = [];
  const n: Record<string, number> = {};
  const f: FetchLike = (url, init) => {
    const h = (init.headers ?? {}) as Record<string, string>;
    const views = new URL(url).searchParams.getAll("view").join("&");
    const cookie = typeof h.cookie === "string";
    sent.push({ views, cookie, filter: h["x-fantasy-filter"] ?? null });
    const key = cookie && script[`${views}+cookie`] !== undefined ? `${views}+cookie` : views;
    const q = script[key];
    if (q === undefined) return Promise.reject(new Error(`unscripted ${key}`));
    const i = n[key] ?? 0;
    n[key] = i + 1;
    return Promise.resolve(q[Math.min(i, q.length - 1)]!());
  };
  return Object.assign(f, { sent });
}

const row = (over: Partial<CredentialStateRow> = {}): CredentialStateRow => ({
  league_id: "0",
  state: "validated",
  store: "file",
  stored_at: "2026-10-01T00:00:00.000Z",
  last_accepted_at: null,
  last_rejected_at: null,
  rejected_since: null,
  next_probe_at: null,
  rejected_view: null,
  board_probe_discriminates: null,
  updated_at: "2026-10-01T00:00:00.000Z",
  updated_by: "setup",
  ...over,
});

/** A world with a probe-capable authority, the given credential_state row and a scripted ESPN. */
function world(opts: {
  readonly fetch: FetchLike;
  readonly state?: "validated" | "rejected" | "stored";
  readonly row?: CredentialStateRow | null | (() => CredentialStateRow | null);
  readonly cache?: MemoryCache;
  readonly limiter?: MemoryLimiterRepo;
}) {
  const limiter = opts.limiter ?? new MemoryLimiterRepo();
  const cache = opts.cache ?? new MemoryCache();
  const drift = new MemoryDrift();
  const auth = new FakeProbeAuthority(opts.state ?? "validated", {
    ok: true,
    header: testCookieHeader(SWID),
  });
  const r = opts.row;
  const credentialState =
    r === undefined ? undefined : { get: typeof r === "function" ? r : () => r };
  const w = makeWorld({
    fetch: opts.fetch,
    credentials: auth,
    limiter,
    cache,
    drift,
    over: {
      probeObserver: "daily_job",
      repos: {
        limiter,
        cache,
        driftState: drift,
        ...(credentialState === undefined ? {} : { credentialState }),
      },
    },
  });
  return { ...w, auth };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Rejected → Validated on a public league whose board does not discriminate (R3 nit (c))", () => {
  it("the daily check re-requests the view whose 401 caused the rejection; its 200 flips the state", async () => {
    const fetch = espn({
      "mSettings&mNav": [() => jsonResponse(settingsBody(true))],
      kona_league_communication: [() => jsonResponse(errBody("GENERAL_NOT_FOUND"), 404)],
      "mTransactions2+cookie": [() => jsonResponse({ transactions: [] })],
    });
    const w = world({
      fetch,
      state: "rejected",
      row: row({
        state: "rejected",
        rejected_view: "mTransactions2",
        board_probe_discriminates: false,
        last_rejected_at: "2026-10-05T00:00:00.000Z",
        rejected_since: "2026-10-05T00:00:00.000Z",
      }),
    });
    const r = await w.provider.probeCredential(w.ref);
    expect(r).toMatchObject({
      accepted: true,
      probe: "board",
      upstream_status: 200,
      reason: null,
      view: "mTransactions2",
    });
    // publicity learned anonymously (cold), then ONE cookie-bearing request: the rejected view
    expect(fetch.sent.map((s) => [s.views, s.cookie])).toEqual([
      ["mSettings&mNav", false],
      ["mTransactions2", true],
    ]);
    expect(w.auth.observations.at(-1)).toMatchObject({
      kind: "accepted",
      by: "daily_job",
      upstream_status: 200,
      view: "mTransactions2",
    });
    expect(w.auth.current).toBe("validated");
    // and the cookie-only read works again, with no human in the loop
    await expect(
      w.provider.listTransactions(w.ref, {
        types: ["WAIVER"],
        week: 3,
        since: null,
        count: 5,
        team_id: null,
      }),
    ).resolves.toBeTruthy();
  });

  it("a 401 on the rejected view keeps it rejected (recorded again, with the view)", async () => {
    const fetch = espn({
      "mSettings&mNav": [() => jsonResponse(settingsBody(true))],
      "mPendingTransactions+cookie": [() => jsonResponse(errBody("AUTH_LEAGUE_NOT_VISIBLE"), 401)],
    });
    const w = world({
      fetch,
      state: "rejected",
      row: row({
        state: "rejected",
        rejected_view: "mPendingTransactions",
        board_probe_discriminates: false,
      }),
    });
    expect(await w.provider.probeCredential(w.ref)).toMatchObject({
      accepted: false,
      probe: "board",
      upstream_status: 401,
      view: "mPendingTransactions",
    });
    expect(w.auth.observations.at(-1)).toMatchObject({
      kind: "rejected",
      view: "mPendingTransactions",
    });
  });

  it("the rejected view is the board itself: a 404 is the board-less answer to valid cookies — accepted", async () => {
    const fetch = espn({
      "mSettings&mNav": [() => jsonResponse(settingsBody(true))],
      "kona_league_communication+cookie": [() => jsonResponse(errBody("GENERAL_NOT_FOUND"), 404)],
    });
    const w = world({
      fetch,
      state: "rejected",
      row: row({ state: "rejected", rejected_view: "kona_league_communication" }),
    });
    expect(await w.provider.probeCredential(w.ref)).toMatchObject({
      accepted: true,
      upstream_status: 404,
      view: "kona_league_communication",
    });
    expect(fetch.sent.filter((s) => s.cookie).map((s) => s.filter)).toEqual([
      expect.stringContaining('"topics"'),
    ]);
  });

  it("a pool view is re-probed with the smallest request it answers (one row, sorted)", async () => {
    const fetch = espn({
      "mSettings&mNav": [() => jsonResponse(settingsBody(true))],
      "kona_player_info+cookie": [() => jsonResponse({ players: [] })],
    });
    const w = world({
      fetch,
      state: "rejected",
      row: row({ state: "rejected", rejected_view: "kona_player_info" }),
    });
    expect((await w.provider.probeCredential(w.ref)).accepted).toBe(true);
    const probe = fetch.sent.find((s) => s.cookie);
    expect(JSON.parse(probe?.filter ?? "{}")).toMatchObject({
      players: { limit: 1, sortPercOwned: { sortPriority: 1 } },
    });
  });

  it("a recorded view this provider never requests on the league cannot discriminate: null, no cookie sent", async () => {
    for (const view of ["proTeamSchedules_wl", "mUnknownView"]) {
      const fetch = espn({ "mSettings&mNav": [() => jsonResponse(settingsBody(true))] });
      const w = world({
        fetch,
        state: "rejected",
        row: row({ state: "rejected", rejected_view: view, board_probe_discriminates: false }),
      });
      expect(await w.provider.probeCredential(w.ref)).toMatchObject({
        accepted: null,
        reason: "board_not_discriminating",
      });
      expect(fetch.sent.some((s) => s.cookie)).toBe(false);
    }
  });

  it("a 404 on a rejected league view is a wrong league id; a 5xx is an outage, not a verdict", async () => {
    for (const [status, code] of [
      [404, "ESPN_LEAGUE_NOT_FOUND"],
      [503, "ESPN_UPSTREAM_UNAVAILABLE"],
    ] as const) {
      const fetch = espn({
        "mSettings&mNav": [() => jsonResponse(settingsBody(true))],
        "mTransactions2+cookie": [() => jsonResponse(errBody("GENERAL_NOT_FOUND"), status)],
      });
      const w = world({
        fetch,
        state: "rejected",
        row: row({ state: "rejected", rejected_view: "mTransactions2" }),
      });
      await expect(w.provider.probeCredential(w.ref)).rejects.toMatchObject({ effCode: code });
      expect(w.auth.observations).toEqual([]);
    }
  });
});

describe("the board control is setup's, cached — never re-sent before every probe (ADV OBJ-26)", () => {
  it("setup's row says the board discriminates: one cookie-bearing board request per run, every run", async () => {
    const cache = new MemoryCache();
    const limiter = new MemoryLimiterRepo();
    const day = (): { sent: Sent[]; ok: boolean | null } => ({ sent: [], ok: null });
    const days = [day(), day(), day()];
    let clockMs = Date.parse(NOW_ISO);
    for (const d of days) {
      const fetch = espn({
        "mSettings&mNav": [() => jsonResponse(settingsBody(true))],
        "kona_league_communication+cookie": [() => jsonResponse({ topics: [] })],
      });
      const w = world({
        fetch,
        cache,
        limiter,
        row: row({ board_probe_discriminates: true }),
      });
      w.clock.set(clockMs);
      d.ok = (await w.provider.probeCredential(w.ref)).accepted;
      d.sent.push(...fetch.sent);
      clockMs += 24 * 3600 * 1000;
    }
    // day 1 learns publicity (cold, keyless, kept); every day then sends exactly the probe
    expect(days[0]!.sent.map((s) => [s.views, s.cookie])).toEqual([
      ["mSettings&mNav", false],
      ["kona_league_communication", true],
    ]);
    for (const d of days.slice(1))
      expect(d.sent.map((s) => [s.views, s.cookie])).toEqual([["kona_league_communication", true]]);
    expect(days.map((d) => d.ok)).toEqual([true, true, true]);
  });

  it("no setup control: learned ONCE, then kept — day 1 control + probe, days 2–3 the probe alone", async () => {
    const cache = new MemoryCache();
    const limiter = new MemoryLimiterRepo();
    const perDay: [string, boolean][][] = [];
    let clockMs = Date.parse(NOW_ISO);
    for (let i = 0; i < 3; i++) {
      const fetch = espn({
        "mSettings&mNav": [() => jsonResponse(settingsBody(true))],
        kona_league_communication: [
          () => jsonResponse(errBody("AUTH_COMMUNICATION_NOT_VISIBLE"), 401),
        ],
        "kona_league_communication+cookie": [() => jsonResponse({ topics: [] })],
      });
      const w = world({ fetch, cache, limiter });
      w.clock.set(clockMs);
      expect((await w.provider.probeCredential(w.ref)).accepted).toBe(true);
      perDay.push(fetch.sent.map((s) => [s.views, s.cookie]));
      clockMs += 24 * 3600 * 1000;
    }
    expect(perDay[0]).toEqual([
      ["mSettings&mNav", false],
      ["kona_league_communication", false],
      ["kona_league_communication", true],
    ]);
    expect(perDay[1]).toEqual([["kona_league_communication", true]]);
    expect(perDay[2]).toEqual([["kona_league_communication", true]]);
  });

  it("a board that answers anyone (non-401 control): null with the reason, the cookie never sent, and the control not re-sent", async () => {
    const cache = new MemoryCache();
    const perDay: [string, boolean][][] = [];
    const results: unknown[] = [];
    for (let i = 0; i < 2; i++) {
      const fetch = espn({
        "mSettings&mNav": [() => jsonResponse(settingsBody(true))],
        kona_league_communication: [() => jsonResponse(errBody("GENERAL_NOT_FOUND"), 404)],
      });
      const w = world({ fetch, cache });
      results.push(await w.provider.probeCredential(w.ref));
      perDay.push(fetch.sent.map((s) => [s.views, s.cookie]));
    }
    expect(results[0]).toMatchObject({
      accepted: null,
      reason: "board_not_discriminating",
      upstream_status: 404,
    });
    expect(results[1]).toMatchObject({
      accepted: null,
      reason: "board_not_discriminating",
      upstream_status: null,
    });
    expect(perDay[0]).toEqual([
      ["mSettings&mNav", false],
      ["kona_league_communication", false],
    ]);
    expect(perDay[1]).toEqual([]);
  });

  it("a kept control is trusted a week; past that, or unreadable, it is learned again (once)", async () => {
    const script = () =>
      espn({
        "mSettings&mNav": [() => jsonResponse(settingsBody(true))],
        kona_league_communication: [
          () => jsonResponse(errBody("AUTH_COMMUNICATION_NOT_VISIBLE"), 401),
        ],
        "kona_league_communication+cookie": [() => jsonResponse({ topics: [] })],
      });
    const controls = (sent: Sent[]) =>
      sent.filter((x) => x.views === "kona_league_communication" && !x.cookie).length;
    const cache = new MemoryCache();
    const first = script();
    const w1 = world({ fetch: first, cache });
    await w1.provider.probeCredential(w1.ref);
    expect(controls(first.sent)).toBe(1);
    const key = boardControlKey("0", SEASON);
    expect(JSON.parse(cache.map.get(key)!.parsed_json)).toEqual({ discriminates: true });
    // eight days on: too old to trust
    const later = script();
    const w2 = world({ fetch: later, cache });
    w2.clock.set(Date.parse(NOW_ISO) + 8 * 24 * 3600 * 1000);
    await w2.provider.probeCredential(w2.ref);
    expect(controls(later.sent)).toBe(1);
    // a row that does not hold a flag, or does not parse, reads as never learned
    for (const parsed_json of ['{"discriminates":"yes"}', "not json"]) {
      cache.map.set(key, { ...cache.map.get(key)!, parsed_json });
      const again = script();
      const w3 = world({ fetch: again, cache });
      w3.clock.set(Date.parse(NOW_ISO) + 8 * 24 * 3600 * 1000);
      expect((await w3.provider.probeCredential(w3.ref)).accepted).toBe(true);
      expect(controls(again.sent)).toBe(1);
    }
    // a cache that cannot be read or written: the probe still answers (the control is re-sent)
    const broken = new MemoryCache();
    broken.get = () => {
      throw new Error("cache down");
    };
    broken.put = () => {
      throw new Error("cache down");
    };
    const f = script();
    const w4 = world({ fetch: f, cache: broken });
    expect((await w4.provider.probeCredential(w4.ref)).accepted).toBe(true);
    expect(controls(f.sent)).toBe(1);
  });
  it("a settings body without the publicity flag: probed as before, on mSettings", async () => {
    const noFlag = (): unknown => {
      const b = settingsBody(true) as { settings: Record<string, unknown> };
      delete b.settings.isPublic;
      return b;
    };
    const fetch = espn({
      "mSettings&mNav": [() => jsonResponse(noFlag())],
      "mSettings+cookie": [() => jsonResponse(noFlag())],
    });
    const w = world({ fetch });
    expect(await w.provider.probeCredential(w.ref)).toMatchObject({
      accepted: true,
      probe: "settings",
    });
  });
  it("the row of another league, or a row that cannot be read, reads as none", async () => {
    for (const r of [
      () => row({ league_id: "1", board_probe_discriminates: true }),
      () => {
        throw new Error("store busy");
      },
    ]) {
      const fetch = espn({
        "mSettings&mNav": [() => jsonResponse(settingsBody(true))],
        kona_league_communication: [
          () => jsonResponse(errBody("AUTH_COMMUNICATION_NOT_VISIBLE"), 401),
        ],
        "kona_league_communication+cookie": [() => jsonResponse({ topics: [] })],
      });
      const w = world({ fetch, row: r });
      expect((await w.provider.probeCredential(w.ref)).accepted).toBe(true);
      // no usable setup control: the anonymous control ran
      expect(
        fetch.sent.filter((s) => s.views === "kona_league_communication" && !s.cookie),
      ).toHaveLength(1);
    }
  });

  it("createEspnProvider hands the store's credential_state row to the probe (the composition roots pass store.repos)", async () => {
    const fetch = espn({
      "mSettings&mNav": [() => jsonResponse(settingsBody(true))],
      "kona_league_communication+cookie": [() => jsonResponse({ topics: [] })],
    });
    const auth = new FakeProbeAuthority("validated", { ok: true, header: testCookieHeader(SWID) });
    const provider = createEspnProvider({
      config: {
        leagueId: "0",
        season: SEASON,
        teamId: null,
        espnReadHost: "lm-api-reads.fantasy.espn.com",
        fixtureRecord: false,
        fixtureDir: null,
      },
      repos: {
        limiter: new MemoryLimiterRepo(),
        espnCache: new MemoryCache(),
        driftState: new MemoryDrift(),
        credentialState: { get: () => row({ board_probe_discriminates: true }) },
      },
      credentials: auth,
      // the limiter's 1/s window spaces the two requests: a clock that moves with the (fake) timers
      clock: { nowMs: () => Date.now(), nowIso: () => new Date(Date.now()).toISOString() },
      scoring: stubScoring,
      fetch,
    });
    vi.useFakeTimers({ now: Date.parse(NOW_ISO) });
    const p = provider.probeCredential({ platform: "espn", league_id: "0", season: SEASON });
    await vi.advanceTimersByTimeAsync(5_000);
    const r = await p;
    expect(r.accepted).toBe(true);
    expect(fetch.sent.map((s) => [s.views, s.cookie])).toEqual([
      ["mSettings&mNav", false],
      ["kona_league_communication", true],
    ]);
  });
});

describe("publicity for the probe: learned anonymously, judged only from what ESPN said", () => {
  it("an anonymous refusal by an edge (a non-JSON 403) counts as refused: the cookie-bearing mSettings discriminates", async () => {
    const fetch = espn({
      "mSettings&mNav": [
        () =>
          new Response("<html>blocked</html>", {
            status: 403,
            headers: { "content-type": "text/html" },
          }),
      ],
      "mSettings+cookie": [() => jsonResponse(settingsBody(false))],
    });
    const w = world({ fetch });
    expect(await w.provider.probeCredential(w.ref)).toMatchObject({
      accepted: true,
      probe: "settings",
      view: "mSettings",
    });
    expect(fetch.sent.map((x) => [x.views, x.cookie])).toEqual([
      ["mSettings&mNav", false],
      ["mSettings", true],
    ]);
    // an edge's block page is not ESPN saying the league is private: nothing is kept
    expect(w.cache.map.has(publicityKey("0"))).toBe(false);
  });
  it("a cached settings body decides the probe when the kept publicity is gone, and is not re-kept", async () => {
    const cache = new MemoryCache();
    const first = world({
      cache,
      fetch: espn({ "mSettings&mNav": [() => jsonResponse(settingsBody(false))] }),
    });
    await first.provider.getLeague(first.ref);
    cache.map.delete(publicityKey("0"));
    const fetch = espn({ "mSettings+cookie": [() => jsonResponse(settingsBody(false))] });
    const w = world({ cache, fetch });
    expect(await w.provider.probeCredential(w.ref)).toMatchObject({
      accepted: true,
      probe: "settings",
    });
    // the settings came from the (fresh) cache: one request, the probe itself
    expect(fetch.sent.map((x) => [x.views, x.cookie])).toEqual([["mSettings", true]]);
    expect(cache.map.has(publicityKey("0"))).toBe(false);
  });
});

describe("the probe is one call: one ≤ 20 s budget for every step (plan 01 §6, ADV OBJ-20)", () => {
  const wallClock: Clock = {
    nowMs: () => Date.now(),
    nowIso: () => new Date(Date.now()).toISOString(),
  };
  const hanging: FetchLike & { calls: number } = Object.assign(
    (_u: string, init: RequestInit): Promise<Response> =>
      new Promise<Response>((_res, rej) => {
        hanging.calls++;
        init.signal?.addEventListener("abort", () => {
          rej(new DOMException("aborted", "AbortError"));
        });
      }),
    { calls: 0 },
  );
  const provider = (): EspnProvider =>
    new EspnProvider({
      config: {
        leagueId: "0",
        season: SEASON,
        teamId: null,
        espnReadHost: "lm-api-reads.fantasy.espn.com",
        fixtureRecord: false,
      },
      fetch: hanging,
      credentials: new FakeProbeAuthority("validated", {
        ok: true,
        header: testCookieHeader(SWID),
      }),
      repos: {
        limiter: new MemoryLimiterRepo(),
        cache: new MemoryCache(),
        driftState: new MemoryDrift(),
      },
      clock: wallClock,
      scoring: stubScoring,
      random: () => 0.5,
    });

  it("a black hole with publicity unknown: the call ends within 20 s, and no cookie-bearing request is judged", async () => {
    vi.useFakeTimers({ now: Date.parse(NOW_ISO) });
    hanging.calls = 0;
    const p = provider();
    const start = Date.now();
    let endedAt = 0;
    const r = p
      .probeCredential({ platform: "espn", league_id: "0", season: SEASON })
      .catch((e: unknown) => {
        endedAt = Date.now();
        return e;
      });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await r).toMatchObject({ effCode: "ESPN_UPSTREAM_UNAVAILABLE" });
    expect(endedAt - start).toBeLessThanOrEqual(20_000);
    // the anonymous read and its one retry inside the deadline — never a third, cookie-bearing one
    expect(hanging.calls).toBe(2);
  });

  it("a caller's budget is the probe's: past its deadline nothing is sent", async () => {
    hanging.calls = 0;
    const p = provider();
    const passed = createUpstreamBudget("r-0123456789ab", Date.now() - 30_000);
    await expect(
      p.probeCredential({ platform: "espn", league_id: "0", season: SEASON }, { budget: passed }),
    ).rejects.toMatchObject({
      effCode: "ESPN_UPSTREAM_UNAVAILABLE",
      effDetails: { reason: "call_deadline" },
    });
    expect(hanging.calls).toBe(0);
  });

  it("publicity known (private): the one probe request has what the deadline leaves, and no retry", async () => {
    vi.useFakeTimers({ now: Date.parse(NOW_ISO) });
    hanging.calls = 0;
    const cache = new MemoryCache();
    // the league's publicity, kept by an earlier process (auth-gate.ts PublicityStore)
    const prior = makeWorld({
      cache,
      fetch: () => Promise.resolve(jsonResponse(settingsBody(false))),
    });
    await prior.provider.getLeague(prior.ref);
    const p = new EspnProvider({
      config: {
        leagueId: "0",
        season: SEASON,
        teamId: null,
        espnReadHost: "lm-api-reads.fantasy.espn.com",
        fixtureRecord: false,
      },
      fetch: hanging,
      credentials: new FakeProbeAuthority("validated", {
        ok: true,
        header: testCookieHeader(SWID),
      }),
      repos: { limiter: new MemoryLimiterRepo(), cache, driftState: new MemoryDrift() },
      clock: wallClock,
      scoring: stubScoring,
    });
    const budget = createUpstreamBudget("r-0123456789ab", Date.now() - 12_000);
    const start = Date.now();
    let endedAt = 0;
    const r = p
      .probeCredential({ platform: "espn", league_id: "0", season: SEASON }, { budget })
      .catch((e: unknown) => {
        endedAt = Date.now();
        return e;
      });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await r).toMatchObject({
      effCode: "ESPN_UPSTREAM_UNAVAILABLE",
      effDetails: { reason: "attempt_timeout" },
    });
    // 8 s were left of the call's 20 s: the attempt's timeout is what the deadline leaves
    expect(endedAt - start).toBeLessThanOrEqual(8_000);
    expect(hanging.calls).toBe(1);
  });

  it("publicity that cannot be learned: no cookie-bearing probe is judged; the read's failure is the answer", async () => {
    // one malformed answer (no retry, no breaker effect): the old probe went on as if private and
    // sent the cookie-bearing mSettings, whose 200 on a public league would prove nothing (R-5)
    const fetch = espn({
      "mSettings&mNav": [
        () =>
          new Response("not json", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ],
      "mSettings+cookie": [() => jsonResponse(settingsBody(true))],
    });
    const w = world({ fetch });
    await expect(w.provider.probeCredential(w.ref)).rejects.toMatchObject({
      effCode: "ESPN_UPSTREAM_UNAVAILABLE",
    });
    expect(fetch.sent.map((s) => [s.views, s.cookie])).toEqual([["mSettings&mNav", false]]);
    expect(w.auth.observations).toEqual([]);
    // an outage that opens the breaker: the same — nothing cookie-bearing goes out
    const down = espn({ "mSettings&mNav": [() => jsonResponse({}, 503)] });
    const w2 = world({ fetch: down });
    await expect(w2.provider.probeCredential(w2.ref)).rejects.toMatchObject({
      effCode: "ESPN_UPSTREAM_UNAVAILABLE",
    });
    expect(down.sent.every((x) => !x.cookie)).toBe(true);
  });
});
