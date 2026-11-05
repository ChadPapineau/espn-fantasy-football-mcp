// fixture-expiring.test.ts — changelog §R10, R10-28 (extends R10-27): fixture mode's scripted
// session ESPN rejects mid-procedure, on the private variant `private-expiring` (harness
// `credential_state: "stored"` with `rejects: "first_uncached_read"`). espn_get_status reports it
// `stored`; the first read on a
// server that the cache does not serve (a fresh entry is served first, as the real pipeline serves
// it before the gate) is answered as ESPN's 401 to a cookie-bearing read is — ESPN_AUTH_REJECTED
// with `upstream_status: 401` — and the label moves to `rejected`, recorded as the real pipeline
// records a 401 (`last_rejected_at`, `rejected_since`), so espn_get_status and espn_check_auth say
// `rejected` from then on, and every later read follows R10-27's rejected rule (the short-circuit,
// zero requests). The probe is such a read too (the cache never serves it). Zero network and no
// value or Cookie header anywhere; the fixture guard runs first (fixture-credential.test.ts); nothing
// outside fixture mode reaches the seam. Also R10-27's second private variant, `private-league-none`
// (not_configured): its first reads. Over the production stdio entry (serveStdio over an in-memory
// transport), a seed server and the run's servers on one store, as build-plugin-evals runs them.
// Temp directories only, no network.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CredentialState } from "../../src/auth/types.js";
import { fixedClock } from "../../src/domain/clock.js";
import { translateScoringInput } from "../../src/domain/scoring/index.js";
import { SESSION_READ_WARNINGS, activityLeagueReadsWarning } from "../../src/mcp/tools/common.js";
import { CookieGate } from "../../src/providers/espn/auth-gate.js";
import { createEspnProvider } from "../../src/providers/espn/index.js";
import { buildServices } from "../../src/services/index.js";
import {
  readScriptedCredential,
  scriptedAuth,
  SCRIPTED_CREDENTIAL_REFUSALS,
  SCRIPTED_CREDENTIAL_STATES,
  SCRIPTED_REJECTIONS,
} from "../../src/services/fixture-credential.js";
import {
  FakeAuthority,
  jsonResponse,
  MemoryCache,
  MemoryDrift,
  MemoryLimiterRepo,
  testCookieHeader,
} from "../providers/espn/helpers.js";
import { ROOT, call, connect, makeWorld, type World } from "../mcp/helpers/world.js";

const FX = path.join(ROOT, "fixtures", "espn", "fx-10h");
const EXPIRING = path.join(FX, "private-expiring");
const NONE = path.join(FX, "private-league-none");
const CLOCK_AT = "2026-10-07T01:00:00.000Z";
const EPOCH = "1970-01-01T00:00:00.000Z";
/** Words that would mean a credential value or its carrier left the seam. */
const COOKIE_WORDS = /espn_s2=|swid=|cookie:|fingerprint/i;

type Body = Record<string, unknown> & { data?: unknown; warnings?: string[]; partial?: boolean };
type Client = Awaited<ReturnType<typeof connect>>["client"];

const codeOf = (b: Record<string, unknown>): unknown =>
  (b as { error?: { code?: unknown } }).error?.code ?? (b as { code?: unknown }).code;
const errOf = (b: Record<string, unknown>): Record<string, unknown> =>
  (b as { error?: Record<string, unknown> }).error ?? b;
const credOf = async (c: Client) => {
  const r = await call(c, "espn_get_status", {});
  expect(r.isError).toBe(false);
  return (
    r.body.data as {
      credential: { state: string; last_rejected_at: string | null; rejected_since: string | null };
      league: { is_public: unknown };
    }
  ).credential;
};

/** One world (store) for a variant, and its first server (the seed's process). */
async function worldOn(dir: string): Promise<{
  world: World;
  client: Client;
  close: () => Promise<void>;
  requests: () => number;
}> {
  const world = await makeWorld({
    env: { EFF_FIXTURE_DIR: dir, EFF_TOOLSET: "full" },
    teamId: 2,
    clock: CLOCK_AT,
    publishEspn: false,
  });
  const c = await connect(world, { modern: true, options: { toolset: "full" } });
  return {
    world,
    client: c.client,
    close: async () => {
      await c.close();
      world.cleanup();
    },
    requests: () => world.store.repos.limiter.countSince(EPOCH),
  };
}

/** A new server process over the same store (the run's server after the seed's). */
async function again(world: World): Promise<{ client: Client; close: () => Promise<void> }> {
  const w = buildServices({
    config: world.config,
    store: world.store,
    clock: world.clock,
    logger: world.logger,
    packageRoot: ROOT,
    home: path.join(world.root, "home"),
    fetch: () => Promise.reject(new Error("no network in tests")),
    loadKeyring: () => Promise.reject(new Error("no keychain in tests")),
  });
  const c = await connect(
    { services: { ...w.services, newSeed: () => 7 }, options: w.options },
    { modern: true, options: { toolset: "full" } },
  );
  return {
    client: c.client,
    close: async () => {
      await c.close();
      w.close();
    },
  };
}

describe("R10-28: the scripted state reads as `stored` and is value-free", () => {
  it("private-expiring scripts a stored session rejected at its first uncached read, with an accepting probe", () => {
    expect(SCRIPTED_CREDENTIAL_STATES).toEqual(["stored", "rejected"]);
    expect(SCRIPTED_REJECTIONS).toEqual(["first_uncached_read"]);
    expect(readScriptedCredential(EXPIRING)).toEqual({
      state: "stored",
      probe: { accepted: true, reason: null, probe: "settings" },
      rejects: "first_uncached_read",
    });
    expect(readScriptedCredential(null)).toBeNull();
  });

  it("refuses `rejects` with any other value, beside rejected or not_configured, or alone", () => {
    const ok = { accepted: true, reason: null, probe: "settings" };
    for (const harness of [
      { credential_state: "stored", rejects: "first_read", probe: ok },
      { credential_state: "rejected", rejects: "first_uncached_read", probe: ok },
      { credential_state: "not_configured", rejects: "first_uncached_read" },
      { rejects: "first_uncached_read" },
    ]) {
      const m = JSON.parse(readFileSync(path.join(EXPIRING, "manifest.json"), "utf8")) as Record<
        string,
        unknown
      >;
      const dir = mkdtempSync(path.join(tmpdir(), "eff-fxexp-"));
      try {
        writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ ...m, harness }));
        expect(() => readScriptedCredential(dir), JSON.stringify(harness)).toThrow(
          expect.objectContaining({
            issues: [{ key: "EFF_FIXTURE_DIR", reason: SCRIPTED_CREDENTIAL_REFUSALS.rejects }],
          }),
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("scriptedAuth: stored until its one 401, then rejected and recorded; every other state never rejects a read", () => {
    const clock = fixedClock(CLOCK_AT);
    const probe = { accepted: true, reason: null, probe: "settings" } as const;
    const a = scriptedAuth({ state: "stored", probe, rejects: "first_uncached_read" }, clock);
    expect(a.state()).toBe("stored");
    expect(a.view()).toMatchObject({
      state: "stored",
      last_rejected_at: null,
      rejected_since: null,
    });
    expect(a.rejectsRead()).toBe(true);
    expect(a.state()).toBe("rejected");
    expect(a.view()).toMatchObject({
      state: "rejected",
      last_rejected_at: CLOCK_AT,
      rejected_since: CLOCK_AT,
    });
    // once: every later read meets the rejected label (the gate's short-circuit)
    expect(a.rejectsRead()).toBe(false);
    for (const state of ["stored", "rejected"] as const) {
      const b = scriptedAuth({ state, probe }, clock);
      expect(b.rejectsRead()).toBe(false);
      expect(b.state()).toBe(state);
    }
    expect(JSON.stringify(a.view())).not.toMatch(COOKIE_WORDS);
  });

  it("the probe is the explicit check, not a data read: it answers the scripted result, and a validated session is never rejected", async () => {
    const clock = fixedClock(CLOCK_AT);
    const a = scriptedAuth(
      {
        state: "stored",
        probe: { accepted: true, reason: null, probe: "settings" },
        rejects: "first_uncached_read",
      },
      clock,
    );
    await expect(a.probe()).resolves.toMatchObject({ accepted: true, upstream_status: null });
    expect(a.state()).toBe("validated");
    expect(a.rejectsRead()).toBe(false);
    expect(a.view()).toMatchObject({ last_rejected_at: null, rejected_since: null });
    // after the 401, the probe still answers the scripted result (the user re-ran setup)
    const b = scriptedAuth(
      {
        state: "stored",
        probe: { accepted: true, reason: null, probe: "settings" },
        rejects: "first_uncached_read",
      },
      clock,
    );
    expect(b.rejectsRead()).toBe(true);
    await expect(b.probe()).resolves.toMatchObject({ accepted: true });
    expect(b.state()).toBe("validated");
  });
});

describe("R10-28 over stdio: status stored → a cached read served → the first uncached read rejected and recorded → status rejected → later reads refused with zero requests", () => {
  let s: Awaited<ReturnType<typeof worldOn>>;
  beforeAll(async () => {
    s = await worldOn(EXPIRING);
  }, 120_000);
  afterAll(async () => {
    await s.close();
  });

  it("the seed's server: stored, and espn_get_status (cache-only reads, a zero budget) leaves it stored; its espn_check_auth accepts; the settings read under validated", async () => {
    expect(await credOf(s.client)).toMatchObject({ state: "stored", last_rejected_at: null });
    // the status snapshot's cache-only league reads send nothing: never the scripted 401
    expect(await credOf(s.client)).toMatchObject({ state: "stored", last_rejected_at: null });
    const probe = await call(s.client, "espn_check_auth", {});
    expect(probe.isError, JSON.stringify(probe.body).slice(0, 300)).toBe(false);
    expect(probe.body.data).toMatchObject({
      accepted: true,
      probe: "settings",
      upstream_status: null,
    });
    expect((await credOf(s.client)).state).toBe("validated");
    expect(s.requests()).toBe(0);
    const lg = await call(s.client, "espn_get_league", {});
    expect(lg.isError, JSON.stringify(lg.body).slice(0, 300)).toBe(false);
    expect((lg.body.data as { league: { is_public: unknown } }).league.is_public).toBe(false);
    expect(s.requests()).toBeGreaterThan(0);
    // validated: no later read is rejected on this server
    expect((await credOf(s.client)).state).toBe("validated");
  });

  it("the run's server starts again on stored: the fresh settings are served, the first uncached read is the 401, then the short-circuit with zero requests", async () => {
    const run = await again(s.world);
    try {
      const n = s.requests();
      expect((await credOf(run.client)).state).toBe("stored");
      // a cached read served: the settings are fresh in the store (served before the gate)
      const lg = await call(run.client, "espn_get_league", {});
      expect(lg.isError, JSON.stringify(lg.body).slice(0, 300)).toBe(false);
      expect((await credOf(run.client)).state).toBe("stored");
      // the first read the cache does not serve: answered as ESPN's 401 would be
      const st = await call(run.client, "espn_get_standings", {});
      expect(st.isError, JSON.stringify(st.body).slice(0, 300)).toBe(true);
      expect(codeOf(st.body)).toBe("ESPN_AUTH_REJECTED");
      expect(errOf(st.body).upstream_status).toBe(401);
      expect(errOf(st.body).reason).toBeUndefined();
      expect(JSON.stringify(st.body)).toMatch(/eff setup/);
      // recorded as a 401 is: espn_get_status and espn_check_auth say rejected from then on
      const cred = await credOf(run.client);
      expect(cred.state).toBe("rejected");
      expect(cred.last_rejected_at).not.toBeNull();
      expect(cred.rejected_since).toBe(cred.last_rejected_at);
      // every later read follows R10-27's rejected rule: the short-circuit, zero requests
      for (const [tool, args] of [
        ["espn_get_standings", {}],
        ["espn_list_transactions", { count: 20 }],
        ["espn_list_transactions", { pending: true }],
        ["espn_get_roster", { week: 5 }],
        ["espn_analyze_schedule", {}],
      ] as const) {
        const r = await call(run.client, tool, args);
        expect(r.isError, `${tool} ${JSON.stringify(r.body).slice(0, 200)}`).toBe(true);
        expect(codeOf(r.body), tool).toBe("ESPN_AUTH_REJECTED");
        expect(errOf(r.body).reason, tool).toBe("short_circuit");
      }
      // the settings stay fresh: still served under the rejected label
      expect((await call(run.client, "espn_get_league", {})).isError).toBe(false);
      // nothing was sent by this server at any point (zero network; the 401 is scripted)
      expect(s.requests()).toBe(n);
      // espn_check_auth then reads the label: the scripted probe (the user re-ran setup)
      const probe = await call(run.client, "espn_check_auth", {});
      expect(probe.body.data).toMatchObject({ accepted: true, upstream_status: null });
      expect((await credOf(run.client)).state).toBe("validated");
    } finally {
      await run.close();
    }
  });

  it("E11 on the seeded state: the session-refusal partial lines, the feed's read the scripted 401, zero requests", async () => {
    const run = await again(s.world);
    try {
      const n = s.requests();
      expect((await credOf(run.client)).state).toBe("stored");
      const act = await call(run.client, "espn_analyze_league_activity", {});
      expect(act.isError, JSON.stringify(act.body).slice(0, 400)).toBe(false);
      const body = act.body as Body;
      expect(body.partial).toBe(true);
      expect(body.warnings).toContain(SESSION_READ_WARNINGS.feed_rejected);
      expect(body.warnings).toContain(
        activityLeagueReadsWarning("rejected", ["standings", "rosters", "free-agent pool"]),
      );
      expect((body.warnings ?? []).filter((w) => w.includes("budget"))).toEqual([]);
      expect((await credOf(run.client)).state).toBe("rejected");
      // a repeat call reads nothing more: the same lines from the rejected label
      const rep = await call(run.client, "espn_analyze_league_activity", {});
      expect((rep.body as Body).warnings).toContain(SESSION_READ_WARNINGS.feed_rejected);
      expect(s.requests()).toBe(n);
      expect(JSON.stringify(body)).not.toMatch(COOKIE_WORDS);
    } finally {
      await run.close();
    }
  });
});

describe("R10-27's second private variant, private-league-none (not_configured): its first reads", () => {
  let s: Awaited<ReturnType<typeof worldOn>>;
  beforeAll(async () => {
    s = await worldOn(NONE);
  }, 120_000);
  afterAll(async () => {
    await s.close();
  });

  it("espn_get_status: not_configured, publicity unknown; every league read ESPN_REQUIRES_COOKIES with zero requests; espn_check_auth has nothing to probe", async () => {
    const st = await call(s.client, "espn_get_status", {});
    const d = st.body.data as { credential: { state: string }; league: { is_public: unknown } };
    expect(d.credential.state).toBe("not_configured");
    expect(d.league.is_public).toBeNull();
    for (const [tool, args] of [
      ["espn_get_league", {}],
      ["espn_get_standings", {}],
      ["espn_list_transactions", { count: 20 }],
      ["espn_list_transactions", { pending: true }],
      ["espn_analyze_league_activity", {}],
      ["espn_analyze_lineup", {}],
    ] as const) {
      const r = await call(s.client, tool, args);
      expect(r.isError, `${tool} ${JSON.stringify(r.body).slice(0, 200)}`).toBe(true);
      expect(codeOf(r.body), tool).toBe("ESPN_REQUIRES_COOKIES");
      expect(JSON.stringify(r.body)).toMatch(/eff setup/);
    }
    const probe = await call(s.client, "espn_check_auth", {});
    expect(probe.body.data).toMatchObject({ accepted: null, reason: "not_configured" });
    expect(s.requests()).toBe(0);
  });
});

describe("R10-28 is unreachable outside fixture mode", () => {
  const ref = { platform: "espn", league_id: "0", season: 2026 } as const;
  const repos = () => ({
    limiter: new MemoryLimiterRepo(),
    espnCache: new MemoryCache(),
    driftState: new MemoryDrift(),
  });

  it("createEspnProvider with no fixture directory never asks the hook", async () => {
    const clock = fixedClock(CLOCK_AT);
    let asked = 0;
    const sent: string[] = [];
    const provider = createEspnProvider({
      config: {
        leagueId: "0",
        season: 2026,
        teamId: 2,
        espnReadHost: "lm-api-reads.fantasy.espn.com",
        fixtureRecord: false,
        fixtureDir: null,
      },
      repos: repos(),
      credentials: null,
      clock,
      fetch: (url) => {
        sent.push(url);
        return Promise.resolve(jsonResponse({ messages: ["not authorized"] }, 401));
      },
      sleep: (ms) => {
        clock.advance(ms);
        return Promise.resolve();
      },
      scoring: translateScoringInput,
      fixtureCredentialLabel: () => "stored",
      fixtureRejectsRead: () => {
        asked++;
        return true;
      },
    });
    await expect(provider.getLeague(ref)).rejects.toMatchObject({
      effCode: "ESPN_REQUIRES_COOKIES",
    });
    expect(asked).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("beside a credential authority the gate drops the hook: the authority's cookie decides", async () => {
    const clock = fixedClock(CLOCK_AT);
    let asked = 0;
    const hook = () => {
      asked++;
      return true;
    };
    const auth = new FakeAuthority("validated", {
      ok: true,
      header: testCookieHeader("{00000000-0000-4000-8000-000000000042}"),
    });
    const gate = new CookieGate(auth, clock, "server", null, {
      fixtureLabel: (): CredentialState => "stored",
      fixturePrivateLeague: true,
      fixtureRejectsRead: hook,
    });
    for (const use of ["auto", "feed", "own"] as const) {
      await expect(gate.forRequest(use, "league")).resolves.not.toBeNull();
      expect(() => {
        gate.fixtureSend(use, "league", "mSettings");
      }).not.toThrow();
    }
    expect(asked).toBe(0);
    // fixture mode's gate: the verdict (forRequest) never fires the hook — only a read about to go
    // out does (fixtureSend), and never a keyless route
    const fixture = new CookieGate(null, clock, "server", null, {
      fixtureLabel: (): CredentialState => "stored",
      fixturePrivateLeague: true,
      fixtureRejectsRead: hook,
    });
    await expect(fixture.forRequest("own", "league")).resolves.toBeNull();
    await expect(fixture.forRequest("auto", "league")).resolves.toBeNull();
    fixture.fixtureSend("auto", "season", "proTeamSchedules_wl");
    fixture.fixtureSend("never", "league", "mSettings");
    expect(asked).toBe(0);
    expect(() => {
      fixture.fixtureSend("auto", "league", "mTeam");
    }).toThrow(expect.objectContaining({ effCode: "ESPN_AUTH_REJECTED" }));
    expect(asked).toBe(1);
  });
});
