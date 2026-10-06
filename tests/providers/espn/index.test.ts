// index.test.ts — src/providers/espn/index.ts and src/drift/index.ts (plan 05 §3.1 step 5 fixture
// mode; plan 01 §1.1): the wiring helper builds a working provider from the store's repositories;
// fixture mode serves the recorded fixtures keyless and refuses to start with a configured credential
// (fixture mode and real cookies never coexist); the public surfaces export what callers use.
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as drift from "../../../src/drift/index.js";
import { fixedClock } from "../../../src/domain/clock.js";
import * as espn from "../../../src/providers/espn/index.js";
import { createEspnProvider, resolveFixtureDir } from "../../../src/providers/espn/index.js";
import {
  FakeAuthority,
  FIXTURES,
  jsonResponse,
  loadFixture,
  MemoryCache,
  MemoryDrift,
  MemoryLimiterRepo,
  NOW_ISO,
  RECORDED,
  SEASON,
  stubScoring,
  testCookieHeader,
} from "./helpers.js";

const base = {
  leagueId: "0",
  season: SEASON,
  teamId: null,
  espnReadHost: "lm-api-reads.fantasy.espn.com",
  fixtureRecord: false,
  fixtureDir: null,
};
const repos = () => ({
  limiter: new MemoryLimiterRepo(),
  espnCache: new MemoryCache(),
  driftState: new MemoryDrift(),
});
const ref = { platform: "espn" as const, league_id: "0", season: SEASON };

describe("createEspnProvider", () => {
  it("builds a provider over the injected fetch and the store's repositories", async () => {
    const p = createEspnProvider({
      config: base,
      repos: repos(),
      credentials: null,
      clock: fixedClock(NOW_ISO),
      scoring: stubScoring,
      fetch: () =>
        Promise.resolve(jsonResponse(loadFixture("recorded/season/proTeamSchedules_wl.json"))),
      origin: "job",
      observer: "daily_job",
      probeObserver: "doctor",
      observations: {},
      ttlContext: () => ({ inGameWindow: false, gameDay: false, inSeason: true }),
      periodProvisional: () => null,
      log: { debug: () => undefined, warn: () => undefined },
    });
    expect((await p.getProSchedule(SEASON)).value.games).toHaveLength(272);
    expect(
      createEspnProvider({
        config: base,
        repos: repos(),
        credentials: null,
        clock: fixedClock(NOW_ISO),
        scoring: stubScoring,
      }),
    ).toBeInstanceOf(espn.EspnProvider);
  });
  it("fixture mode: the fixtures directory or one recorded league directory, keyless", async () => {
    for (const [dir, size] of [
      [FIXTURES, 10],
      [path.join(RECORDED, "league-c"), 12],
    ] as const) {
      const p = createEspnProvider({
        config: { ...base, fixtureDir: dir },
        repos: repos(),
        credentials: null,
        clock: fixedClock(NOW_ISO),
        scoring: stubScoring,
      });
      expect((await p.getLeague(ref)).value.size).toBe(size);
    }
    const unconfigured = new FakeAuthority("not_configured", {
      ok: false,
      reason: "not_configured",
    });
    const p = createEspnProvider({
      config: { ...base, fixtureDir: FIXTURES },
      repos: repos(),
      credentials: unconfigured,
      clock: fixedClock(NOW_ISO),
      scoring: stubScoring,
    });
    expect((await p.getLeague(ref)).value.is_public).toBe(true);
  });
  it("fixture mode refuses to start with a configured credential, or with no fixtures", () => {
    const auth = new FakeAuthority("validated", {
      ok: true,
      header: testCookieHeader("{00000000-0000-4000-8000-000000000001}"),
    });
    expect(() =>
      createEspnProvider({
        config: { ...base, fixtureDir: FIXTURES },
        repos: repos(),
        credentials: auth,
        clock: fixedClock(NOW_ISO),
        scoring: stubScoring,
      }),
    ).toThrow(
      expect.objectContaining({
        effCode: "INTERNAL",
        effDetails: { reason: "fixture_mode_with_credentials" },
      }),
    );
    expect(() =>
      createEspnProvider({
        config: { ...base, fixtureDir: "/nonexistent-eff-fixtures" },
        repos: repos(),
        credentials: null,
        clock: fixedClock(NOW_ISO),
        scoring: stubScoring,
      }),
    ).toThrow(expect.objectContaining({ effDetails: { reason: "fixture_dir_not_found" } }));
  });
  it("resolveFixtureDir", () => {
    expect(resolveFixtureDir("fixtures/espn")).toBeNull();
    expect(resolveFixtureDir(FIXTURES)).toEqual({ dir: FIXTURES, league: "league-a" });
    expect(resolveFixtureDir(path.join(RECORDED, "league-b"))).toEqual({
      dir: FIXTURES,
      league: "league-b",
    });
    expect(resolveFixtureDir(path.join(RECORDED, "season"))).toBeNull();
  });
});

describe("public surfaces", () => {
  it("export the provider, its errors, fixture mode and the drift module", () => {
    expect(typeof espn.createFixtureFetch).toBe("function");
    expect(typeof espn.composeBodies).toBe("function");
    expect(espn.ESPN_PROVIDER_WRITES).toContain("PHASE W SEAM");
    expect(espn.PLAYERCARD_IDS_MAX).toBe(25);
    expect(new espn.EspnUpstreamError("timeout").effCode).toBe("ESPN_UPSTREAM_UNAVAILABLE");
    expect(espn.isEspnUpstreamError(new espn.EspnDriftError("mRoster", "teams"))).toBe(false);
    expect(new espn.FixtureError("fixture_missing", "x").effCode).toBe("INTERNAL");
    for (const name of [
      "checkResponse",
      "loadObservations",
      "select",
      "DriftStateWriter",
      "driftMetaFor",
      "scoringRefusal",
      "REQUIRED_PATHS_BY_VIEW",
      "ENTITY_MANIFEST_PATH",
    ])
      expect(drift, name).toHaveProperty(name);
  });
});
