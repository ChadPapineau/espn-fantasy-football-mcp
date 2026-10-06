// request.test.ts — the read pipeline's defensive paths (plan 01 §5.3, §6, §7; WRITE_CLASS: a
// best-effort cache and a required drift_state row that fail must never change a result): failing
// ports (cache, drift_state, ttl context, credential reads), a cached body that no longer matches the
// schema (refetched), the probe's request path, the wired period-provisional resolver, and own-team
// fallbacks.
import { describe, expect, it } from "vitest";
import { EspnBreakerOpenError } from "../../../src/providers/espn/limiter.js";
import { communicationTarget } from "../../../src/providers/espn/path.js";
import { parseJsonSafe } from "../../../src/providers/espn/request.js";
import {
  FakeAuthority,
  jsonResponse,
  loadFixture,
  makeWorld,
  SEASON,
  testCookieHeader,
} from "./helpers.js";

const pro = () => jsonResponse(loadFixture("recorded/season/proTeamSchedules_wl.json"));
const settings = (isPublic: boolean): unknown => {
  const s = structuredClone(loadFixture("recorded/league-a/mSettings.json")) as {
    settings: Record<string, unknown>;
  };
  const nav = loadFixture("recorded/league-a/mNav.json") as Record<string, unknown>;
  s.settings.isPublic = isPublic;
  return { ...s, members: nav.members, teams: nav.teams };
};

describe("failing ports never change a result", () => {
  it("a throwing ttl context falls back to the default; a throwing drift_state read reads as no drift", async () => {
    const w = makeWorld({
      fetch: () => Promise.resolve(pro()),
      over: {
        ttlContext: () => {
          throw new Error("schedule unavailable");
        },
      },
    });
    w.drift.get = () => {
      throw new Error("db");
    };
    const r = await w.provider.getProSchedule(SEASON);
    expect(r.stamp.drift).toBeNull();
    expect(w.provider.transportStatus().breaker_open).toBe(false);
  });
  it("a throwing drift_state write: drift is still reported, soft signals and recovery are still fine", async () => {
    const logs: string[] = [];
    const w = makeWorld({
      fetch: () => Promise.resolve(jsonResponse(loadFixture("recorded/league-a/skeleton.json"))),
      over: { log: { debug: () => undefined, warn: (e) => logs.push(e) } },
    });
    w.drift.put = () => {
      throw new Error("db locked");
    };
    await expect(w.provider.getMatchups(w.ref)).rejects.toMatchObject({
      effCode: "ESPN_DRIFT_DETECTED",
    });
    expect(logs).toContain("espn.drift_state.write_failed");
    const moved = makeWorld({
      fetch: () =>
        Promise.resolve(
          new Response("x", { status: 302, headers: { location: "https://www.espn.com/" } }),
        ),
      over: { log: { debug: () => undefined, warn: (e) => logs.push(e) } },
    });
    moved.drift.put = () => {
      throw new Error("db locked");
    };
    await expect(moved.provider.getProSchedule(SEASON)).rejects.toMatchObject({
      effCode: "ESPN_HOST_MOVED",
    });
    const ok = makeWorld({ fetch: () => Promise.resolve(pro()) });
    ok.drift.row = {
      status: "host_moved",
      since: "2026-10-06T00:00:00.000Z",
      last_probe_at: null,
      manifest_hash: null,
      manifest_version: null,
      host: "lm-api-reads.fantasy.espn.com",
      host_moved_at: "2026-10-06T00:00:00.000Z",
      diff_json: "[]",
      additive_json: "[]",
      updated_at: "2026-10-06T00:00:00.000Z",
    };
    ok.drift.put = () => {
      throw new Error("db locked");
    };
    await expect(ok.provider.getProSchedule(SEASON)).resolves.toBeTruthy();
  });
  it("a cached body that no longer matches the schema is refetched", async () => {
    let calls = 0;
    const w = makeWorld({ fetch: () => (calls++, Promise.resolve(pro())) });
    await w.provider.getProSchedule(SEASON);
    for (const [k, e] of w.cache.map) w.cache.map.set(k, { ...e, parsed_json: '{"settings":{}}' });
    await w.provider.getProSchedule(SEASON);
    expect(calls).toBe(2);
  });
  it("a credential read that throws later leaves my_team to the configured id (no crash)", async () => {
    const auth = new FakeAuthority("validated", { ok: true, header: "x=1" as never });
    let calls = 0;
    auth.getCookieHeader = () => {
      calls++;
      return calls === 1
        ? Promise.resolve({ ok: true, header: "x=1" as never })
        : Promise.reject(new Error("keychain prompt dismissed"));
    };
    const nav = loadFixture("recorded/league-a/mNav.json") as { teams: { id: number }[] };
    const w = makeWorld({
      credentials: auth,
      teamId: nav.teams[1]!.id,
      fetch: () => Promise.resolve(jsonResponse(settings(true))),
    });
    const league = await w.provider.getLeague(w.ref);
    expect(league.value.my_team?.team_id).toBe(nav.teams[1]!.id);
    expect(calls).toBe(2);
    const own = await w.provider.resolveOwnTeam(w.ref);
    expect(own.value.reason).toBe("no_credential");
  });
  it("own team in standings from the team owners when the league identity is unavailable", async () => {
    const owner = (
      loadFixture("recorded/league-a/mTeam.json") as { teams: { id: number; owners: string[] }[] }
    ).teams[3]!;
    const auth = new FakeAuthority("validated", {
      ok: true,
      header: testCookieHeader(owner.owners[0]!),
    });
    const w = makeWorld({
      credentials: auth,
      fetch: (url) =>
        url.includes("mTeam")
          ? Promise.resolve(jsonResponse(loadFixture("recorded/league-a/mTeam.json")))
          : Promise.resolve(jsonResponse({ broken: true })),
    });
    const st = await w.provider.getStandings(w.ref);
    expect(st.value.teams.filter((t) => t.is_mine).map((t) => t.team_id)).toEqual([owner.id]);
    expect(st.value.playoff_line.seeding_rule).toBe("UNKNOWN");
  });
});

describe("the provisional resolver and the probe request", () => {
  it("a wired periodProvisional wins; another season is never provisional by default", async () => {
    const w = makeWorld({ over: { periodProvisional: () => false } });
    expect((await w.provider.getLiveMatchups(w.ref, 4)).stamp.provisional).toBe(false);
    const w2 = makeWorld({ over: { periodProvisional: () => null } });
    expect((await w2.provider.getLiveMatchups(w2.ref, 4)).stamp.provisional).toBe(true);
    const old = makeWorld({
      fetch: () =>
        Promise.resolve(jsonResponse(loadFixture("recorded/league-a/kona_playercard.json"))),
    });
    const ids = [{ platform: "espn" as const, id: -16034 }];
    const lines = await old.provider.getPlayerStats({ ...old.ref, season: SEASON }, ids, {
      type: "week",
      week: 4,
    });
    expect(lines.stamp.provisional).toBe(true);
  });
  it("probeSend: refused while the breaker is open; a 3xx is a host move", async () => {
    const w = makeWorld({
      fetch: () =>
        Promise.resolve(
          new Response("x", { status: 302, headers: { location: "https://www.espn.com/" } }),
        ),
    });
    const req = (
      w.provider as unknown as {
        req: {
          probeSend: (t: unknown, f: unknown, c: unknown) => Promise<number>;
          limiter: { breaker: { forceOpen(): void } };
        };
      }
    ).req;
    const board = communicationTarget({
      host: "lm-api-reads.fantasy.espn.com",
      season: SEASON,
      leagueId: "0",
    });
    await expect(req.probeSend(board, null, null)).rejects.toMatchObject({
      effCode: "ESPN_HOST_MOVED",
    });
    req.limiter.breaker.forceOpen();
    await expect(req.probeSend(board, null, null)).rejects.toBeInstanceOf(EspnBreakerOpenError);
    const net = makeWorld({
      fetch: () => Promise.reject(Object.assign(new Error("x"), { code: "ECONNREFUSED" })),
    });
    const netReq = (net.provider as unknown as { req: typeof req }).req;
    await expect(netReq.probeSend(board, null, null)).rejects.toMatchObject({
      effCode: "ESPN_UPSTREAM_UNAVAILABLE",
    });
    expect(net.limiter.rows[0]?.outcome).toBe("network_error");
  });
  it("parseJsonSafe drops every __proto__ key at any depth", () => {
    const v = parseJsonSafe('{"a":[{"__proto__":{"x":1},"b":2}]}') as {
      a: Record<string, unknown>[];
    };
    expect(v.a[0]).toEqual({ b: 2 });
    expect(Object.getPrototypeOf(v.a[0])).toBe(Object.prototype);
  });
});
