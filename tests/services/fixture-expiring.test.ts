// fixture-expiring.test.ts — changelog §R10, R10-28 (extends R10-27): fixture mode's scripted
// session ESPN rejects mid-procedure, on the private variant `private-expiring` (harness
// `credential_state: "stored"` with `rejects: "first_uncached_read"`). espn_get_status reports it
// `stored`; the first read on a
// server that the cache does not serve (a fresh entry is served first, as the real pipeline serves
// it before the gate) is answered as ESPN's 401 to a cookie-bearing read is — ESPN_AUTH_REJECTED
// with `upstream_status: 401` — and the label moves to `rejected`, recorded as the real pipeline
// records a 401 (`last_rejected_at`, `rejected_since`), so espn_get_status and espn_check_auth say
// `rejected` from then on, and every later read follows R10-27's rejected rule (the short-circuit,
// zero requests). The probe is the explicit check, never a data read: it never fires the 401, and
// before it an accepting probe validates the session and leaves the 401 armed (changelog §R10,
// R10-33): on the eval run's server the first uncached read under `validated` is still the 401.
// Only the seed's own path disarms it — EFF_FIXTURE_SEED=1 (config.fixtureSeed), honoured in
// fixture mode alone and never in the run's `.mcp.json` — so the seed's reads are served and cached,
// never rejected. After the 401 the probe answers accepted false with ESPN's 401 and the label stays
// `rejected` (the round-4c verifier's R4C-VS-3). A read the 401 overtook is refused too (CR-2). Zero network and no
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
import {
  ROOT,
  call,
  connect,
  makeWorld,
  withFixtureSeed,
  type World,
} from "../mcp/helpers/world.js";

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

/**
 * One world (store) for a variant, and its first server: with `seed`, the seed's process, started
 * as build-plugin-evals starts it (EFF_FIXTURE_SEED=1, changelog §R10, R10-33); without, a run's.
 */
async function worldOn(
  dir: string,
  seed = false,
): Promise<{
  world: World;
  client: Client;
  close: () => Promise<void>;
  requests: () => number;
}> {
  const world = await makeWorld({
    env: { EFF_FIXTURE_DIR: dir, EFF_TOOLSET: "full", ...(seed ? { EFF_FIXTURE_SEED: "1" } : {}) },
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

/**
 * A new server process over the same store: the run's server after the seed's (no seed path, as
 * the run's `.mcp.json` starts it), or with `seed` another seed server (R10-33).
 */
async function again(
  world: World,
  seed = false,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const w = buildServices({
    config: withFixtureSeed(world.config, seed),
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

  it("the probe is the explicit check, not a data read: before the 401 it answers the scripted result and validates, leaving the 401 armed (R10-33); after it, rejected from then on", async () => {
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
    expect(a.view()).toMatchObject({ last_rejected_at: null, rejected_since: null });
    // changelog §R10, R10-33: the accepting probe did not disarm the 401 — the first uncached read
    // under `validated` is still ESPN's 401, recorded as one, and only once
    expect(a.rejectsRead()).toBe(true);
    expect(a.state()).toBe("rejected");
    expect(a.view()).toMatchObject({ last_rejected_at: CLOCK_AT, rejected_since: CLOCK_AT });
    expect(a.rejectsRead()).toBe(false);
    await expect(a.probe()).resolves.toMatchObject({ accepted: false, upstream_status: 401 });
    expect(a.state()).toBe("rejected");
    // after the 401, the probe reports the session rejected from then on (R10-28; R4C-VS-3)
    const b = scriptedAuth(
      {
        state: "stored",
        probe: { accepted: true, reason: null, probe: "settings" },
        rejects: "first_uncached_read",
      },
      clock,
    );
    expect(b.rejectsRead()).toBe(true);
    for (let i = 0; i < 2; i++) {
      await expect(b.probe()).resolves.toEqual({
        accepted: false,
        probe: "settings",
        upstream_status: 401,
        reason: null,
        checked_at: CLOCK_AT,
      });
      expect(b.state()).toBe("rejected");
      expect(b.view()).toMatchObject({ rejected_since: CLOCK_AT, last_rejected_at: CLOCK_AT });
      expect(b.rejectsRead()).toBe(false);
    }
  });
});

describe("R10-33: only the seed's path disarms the scripted 401", () => {
  const scripted = {
    state: "stored",
    probe: { accepted: true, reason: null, probe: "settings" },
    rejects: "first_uncached_read",
  } as const;

  it("the seed path: never armed — unprobed reads stay `stored`, an accepting probe validates, no read is ever rejected", async () => {
    const clock = fixedClock(CLOCK_AT);
    const unprobed = scriptedAuth(scripted, clock, { seed: true });
    for (let i = 0; i < 3; i++) expect(unprobed.rejectsRead()).toBe(false);
    expect(unprobed.state()).toBe("stored");
    const probed = scriptedAuth(scripted, clock, { seed: true });
    await expect(probed.probe()).resolves.toMatchObject({ accepted: true, upstream_status: null });
    for (let i = 0; i < 3; i++) expect(probed.rejectsRead()).toBe(false);
    expect(probed.state()).toBe("validated");
    expect(probed.view()).toMatchObject({ last_rejected_at: null, rejected_since: null });
  });

  it("without the seed path (the eval run's server; `seed: false` or absent), the 401 is armed whether or not a probe accepted first", async () => {
    const clock = fixedClock(CLOCK_AT);
    for (const opts of [undefined, {}, { seed: false }] as const) {
      for (const probeFirst of [false, true]) {
        const a = scriptedAuth(scripted, clock, opts);
        if (probeFirst) await a.probe();
        expect(a.state(), `${JSON.stringify(opts)} ${String(probeFirst)}`).toBe(
          probeFirst ? "validated" : "stored",
        );
        expect(a.rejectsRead()).toBe(true);
        expect(a.state()).toBe("rejected");
      }
    }
    // a variant scripting no rejection is unchanged by either path
    for (const seed of [true, false]) {
      const b = scriptedAuth({ state: "stored", probe: scripted.probe }, clock, { seed });
      await b.probe();
      expect(b.rejectsRead()).toBe(false);
      expect(b.state()).toBe("validated");
    }
  });
});

describe("R10-28 over stdio: status stored → a cached read served → the first uncached read rejected and recorded → status rejected → later reads refused with zero requests", () => {
  let s: Awaited<ReturnType<typeof worldOn>>;
  beforeAll(async () => {
    // the seed's server, on its own path (EFF_FIXTURE_SEED=1, R10-33)
    s = await worldOn(EXPIRING, true);
    expect(s.world.config.fixtureSeed).toBe(true);
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
      // espn_check_auth after the 401: rejected from then on (R10-28; R4C-VS-3), and reads stay refused
      const probe = await call(run.client, "espn_check_auth", {});
      expect(probe.body.data).toMatchObject({ accepted: false, upstream_status: 401 });
      expect((await credOf(run.client)).state).toBe("rejected");
      const after = await call(run.client, "espn_get_standings", {});
      expect(codeOf(after.body)).toBe("ESPN_AUTH_REJECTED");
      expect(errOf(after.body).reason).toBe("short_circuit");
      expect(s.requests()).toBe(n);
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

describe("R10-33 over stdio: on the eval run's server an accepting espn_check_auth validates and leaves the 401 armed", () => {
  let s: Awaited<ReturnType<typeof worldOn>>;
  beforeAll(async () => {
    // no seed path: the world's first server is a run's, started as the run's .mcp.json starts it
    s = await worldOn(EXPIRING);
    expect(s.world.config.fixtureSeed).toBe(false);
  }, 120_000);
  afterAll(async () => {
    await s.close();
  });

  const rejectedAfter = async (c: Client, label: string): Promise<void> => {
    const cred = await credOf(c);
    expect(cred.state, label).toBe("rejected");
    expect(cred.last_rejected_at, label).not.toBeNull();
    expect(cred.rejected_since, label).toBe(cred.last_rejected_at);
    for (const [tool, args] of [
      ["espn_get_standings", {}],
      ["espn_list_transactions", { count: 20 }],
      ["espn_get_roster", { week: 5 }],
    ] as const) {
      const r = await call(c, tool, args);
      expect(r.isError, `${label} ${tool} ${JSON.stringify(r.body).slice(0, 200)}`).toBe(true);
      expect(codeOf(r.body), `${label} ${tool}`).toBe("ESPN_AUTH_REJECTED");
      expect(errOf(r.body).reason, `${label} ${tool}`).toBe("short_circuit");
    }
    // (the probe after the 401 is R10-28's case above; this server already used its one probe a
    // minute, plan 07 G2)
    expect((await credOf(c)).state, label).toBe("rejected");
  };

  it("nothing cached: the probe accepts (validated), and the first read is ESPN's 401 — the label rejected, later reads short-circuited, zero requests", async () => {
    expect((await credOf(s.client)).state).toBe("stored");
    const probe = await call(s.client, "espn_check_auth", {});
    expect(probe.body.data).toMatchObject({ accepted: true, upstream_status: null });
    expect((await credOf(s.client)).state).toBe("validated");
    const lg = await call(s.client, "espn_get_league", {});
    expect(lg.isError, JSON.stringify(lg.body).slice(0, 300)).toBe(true);
    expect(codeOf(lg.body)).toBe("ESPN_AUTH_REJECTED");
    expect(errOf(lg.body).upstream_status).toBe(401);
    expect(errOf(lg.body).reason).toBeUndefined();
    await rejectedAfter(s.client, "unseeded run");
    expect(s.requests()).toBe(0);
    expect(JSON.stringify(lg.body)).not.toMatch(COOKIE_WORDS);
  });

  it("on the seeded state: the seed (its own path) leaves the settings fresh; the run probes first (validated), the settings are served, and its first uncached read is the 401", async () => {
    const seed = await again(s.world, true);
    try {
      expect((await call(seed.client, "espn_check_auth", {})).body.data).toMatchObject({
        accepted: true,
      });
      const lg = await call(seed.client, "espn_get_league", {});
      expect(lg.isError, JSON.stringify(lg.body).slice(0, 300)).toBe(false);
      expect((await credOf(seed.client)).state).toBe("validated");
    } finally {
      await seed.close();
    }
    const run = await again(s.world);
    try {
      const n = s.requests();
      expect((await credOf(run.client)).state).toBe("stored");
      const probe = await call(run.client, "espn_check_auth", {});
      expect(probe.body.data).toMatchObject({ accepted: true, upstream_status: null });
      expect((await credOf(run.client)).state).toBe("validated");
      // a cached read is served under `validated` (the 401 is the first read the cache does not serve)
      const lg = await call(run.client, "espn_get_league", {});
      expect(lg.isError, JSON.stringify(lg.body).slice(0, 300)).toBe(false);
      expect((await credOf(run.client)).state).toBe("validated");
      const st = await call(run.client, "espn_get_standings", {});
      expect(st.isError, JSON.stringify(st.body).slice(0, 300)).toBe(true);
      expect(codeOf(st.body)).toBe("ESPN_AUTH_REJECTED");
      expect(errOf(st.body).upstream_status).toBe(401);
      await rejectedAfter(run.client, "seeded run");
      // the settings stay fresh: still served under the rejected label; nothing was sent
      expect((await call(run.client, "espn_get_league", {})).isError).toBe(false);
      expect(s.requests()).toBe(n);
    } finally {
      await run.close();
    }
  });
});

describe("R10-33 over stdio: the seed's path (EFF_FIXTURE_SEED=1) — reads served and cached, never rejected, probed or not", () => {
  let s: Awaited<ReturnType<typeof worldOn>>;
  beforeAll(async () => {
    s = await worldOn(EXPIRING, true);
  }, 120_000);
  afterAll(async () => {
    await s.close();
  });

  it("before and after an accepting probe every read is served; the run's server after it is served the cached reads with zero requests and still meets the 401 at its first uncached one", async () => {
    expect((await credOf(s.client)).state).toBe("stored");
    // unprobed: the read is served, the label stays stored
    const lg = await call(s.client, "espn_get_league", {});
    expect(lg.isError, JSON.stringify(lg.body).slice(0, 300)).toBe(false);
    expect((await credOf(s.client)).state).toBe("stored");
    const probe = await call(s.client, "espn_check_auth", {});
    expect(probe.body.data).toMatchObject({ accepted: true, upstream_status: null });
    for (const [tool, args] of [
      ["espn_get_standings", {}],
      ["espn_get_roster", {}],
    ] as const) {
      const r = await call(s.client, tool, args);
      expect(r.isError, `${tool} ${JSON.stringify(r.body).slice(0, 200)}`).toBe(false);
    }
    const cred = await credOf(s.client);
    expect(cred).toMatchObject({
      state: "validated",
      last_rejected_at: null,
      rejected_since: null,
    });
    expect(s.requests()).toBeGreaterThan(0);
    // the run's server (no seed path) over the same store: the seed's reads were cached
    const run = await again(s.world);
    try {
      const n = s.requests();
      for (const [tool, args] of [
        ["espn_get_league", {}],
        ["espn_get_standings", {}],
      ] as const) {
        const r = await call(run.client, tool, args);
        expect(r.isError, `${tool} ${JSON.stringify(r.body).slice(0, 200)}`).toBe(false);
      }
      expect((await credOf(run.client)).state).toBe("stored");
      expect(s.requests()).toBe(n);
      // and its 401 is armed: the first read the cache does not serve
      const tx = await call(run.client, "espn_list_transactions", { count: 20 });
      expect(tx.isError, JSON.stringify(tx.body).slice(0, 300)).toBe(true);
      expect(codeOf(tx.body)).toBe("ESPN_AUTH_REJECTED");
      expect(errOf(tx.body).upstream_status).toBe(401);
      expect((await credOf(run.client)).state).toBe("rejected");
      expect(s.requests()).toBe(n);
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

describe("R10-28 under concurrency (the round-4c verifier's CR-2): a read the 401 overtook is never served", () => {
  const ref = { platform: "espn", league_id: "0", season: 2026 } as const;

  it("settings warmed, then two concurrent reads of uncached views: one the scripted 401, the other the short-circuit, none served", async () => {
    const clock = fixedClock(CLOCK_AT);
    const scripted = readScriptedCredential(EXPIRING);
    if (scripted === null) throw new Error("private-expiring scripts no credential");
    const auth = scriptedAuth(scripted, clock);
    const repos = {
      limiter: new MemoryLimiterRepo(),
      espnCache: new MemoryCache(),
      driftState: new MemoryDrift(),
    };
    const make = (label: () => CredentialState, rejects: () => boolean) =>
      createEspnProvider({
        config: {
          leagueId: "0",
          season: 2026,
          teamId: 2,
          espnReadHost: "lm-api-reads.fantasy.espn.com",
          fixtureRecord: false,
          fixtureDir: EXPIRING,
        },
        repos,
        credentials: null,
        clock,
        fetch: () => Promise.reject(new Error("no network in tests")),
        sleep: (ms) => {
          clock.advance(ms);
          return Promise.resolve();
        },
        scoring: translateScoringInput,
        fixtureCredentialLabel: label,
        fixtureRejectsRead: rejects,
      });
    // the seed's process (its own path, R10-33: never rejected) leaves the settings fresh in the cache
    await make(
      () => "validated",
      () => false,
    ).getLeague(ref);
    const run = make(
      () => auth.state(),
      () => auth.rejectsRead(),
    );
    const rs = await Promise.allSettled([run.getRosters(ref, 1), run.getRosters(ref, 2)]);
    expect(rs.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    const reasons = rs.map((r) => (r.status === "rejected" ? (r.reason as unknown) : null)) as {
      effCode?: unknown;
      effDetails?: { upstream_status?: unknown; reason?: unknown };
    }[];
    for (const e of reasons) expect(e.effCode).toBe("ESPN_AUTH_REJECTED");
    const kinds = reasons.map((e) =>
      e.effDetails?.upstream_status === 401 ? "401" : String(e.effDetails?.reason),
    );
    expect(kinds.sort()).toEqual(["401", "short_circuit"]);
    expect(auth.state()).toBe("rejected");
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
