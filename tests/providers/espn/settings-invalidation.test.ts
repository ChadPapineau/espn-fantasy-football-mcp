// settings-invalidation.test.ts — Stage C remediation, round 3 (finding
// cache-settings-invalidation-triggers-missing; plan 01 §5.2 "League settings" row: invalidate when
// `status.standingsUpdateDate` / `waiverLastExecutionDate` change, and on a scoring golden mismatch;
// plan 08 §9: the E6 > 10 % rule and `eff refresh espn:settings` — "on invalidation the provider
// re-fetches, re-normalises, and — if the hash changed — … settings_changed"). Before, the settings
// cache was TTL-only: a commissioner's scoring edit stayed unseen for up to 24 h whatever ESPN's
// status said. Now every league answer's status instants are kept (cache.ts cachedSettingsMarks): a
// later answer showing the standings or a waiver run moved outdates the cached settings, which are
// refetched once (a lagging settings body cannot make every read refetch); `invalidateSettings`
// outdates them in every process; ESPN down, the outdated settings are served degraded. Over league-a
// (stub translator) and the derived fx-10h league (real translator, real store: the edit raises
// settings_changed inside the TTL). No network, no cookie.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixedClock } from "../../../src/domain/clock.js";
import { translateScoringInput } from "../../../src/domain/scoring/index.js";
import {
  cachedSettingsMarks,
  settingsDirtyKey,
  settingsMarksKey,
  settingsOutdated,
  statusInstantsOf,
} from "../../../src/providers/espn/cache.js";
import { createFixtureFetch } from "../../../src/providers/espn/fixture.js";
import {
  createDerivedLeagueFetch,
  createEspnProvider,
  type FetchLike,
} from "../../../src/providers/espn/index.js";
import { createStoreFactory } from "../../../src/store/index.js";
import type { Store } from "../../../src/store/types.js";
import { tempDir } from "../../lint/helpers.js";
import { FIXTURES, LEAGUE_ID, makeWorld, MemoryCache, NOW_ISO, SEASON } from "./helpers.js";

const HOUR = 3_600_000;
const PASS_TD = "4";

/** ESPN as it answers: the recorded league-a, or — `edited` — after a commissioner's edit. */
function espn(state: {
  /** How far ESPN's standings instant moved (ms); 0: as recorded. */
  standingsMoved: number;
  /** How far its waiver-run instant moved (ms). */
  waiversMoved: number;
  /** The pass-TD points ESPN's settings answer now carries (null: as recorded). */
  passTd: number | null;
  /** The settings answer lags: it still carries the recorded instants. */
  settingsLag?: boolean;
  down?: boolean;
}): { fetch: FetchLike; views: string[] } {
  const inner = createFixtureFetch({ dir: FIXTURES, league: "league-a" });
  const views: string[] = [];
  return {
    views,
    fetch: async (url, init) => {
      const v = new URL(url).searchParams.getAll("view");
      views.push(v.join("+"));
      if (state.down === true) {
        const e = new TypeError("fetch failed");
        (e as { cause?: unknown }).cause = Object.assign(new Error("reset"), {
          code: "ECONNRESET",
        });
        throw e;
      }
      const r = await inner(url, init);
      const b = (await r.json()) as {
        status?: { standingsUpdateDate?: number; waiverLastExecutionDate?: number };
        settings?: { scoringSettings: { scoringItems: { statId: number; points: number }[] } };
      };
      const isSettings = v.includes("mSettings");
      if (b.status !== undefined && !(isSettings && state.settingsLag === true)) {
        b.status.standingsUpdateDate = (b.status.standingsUpdateDate ?? 0) + state.standingsMoved;
        b.status.waiverLastExecutionDate =
          (b.status.waiverLastExecutionDate ?? 0) + state.waiversMoved;
      }
      if (isSettings && state.passTd !== null && b.settings !== undefined)
        for (const i of b.settings.scoringSettings.scoringItems)
          if (i.statId === Number(PASS_TD)) i.points = state.passTd;
      return new Response(JSON.stringify(b), { status: r.status, headers: r.headers });
    },
  };
}

const passTdOf = (s: { rules: readonly { platform_id: string; points: number }[] }) =>
  s.rules.find((r) => r.platform_id === PASS_TD)?.points;

describe("a moved status instant outdates the cached settings before their 24 h TTL", () => {
  it("a standings update seen in another answer: the settings are refetched and the edit is seen", async () => {
    const state = { standingsMoved: 0, waiversMoved: 0, passTd: null as number | null };
    const e = espn(state);
    const w = makeWorld({ fetch: e.fetch });
    const before = await w.provider.getScoringSettings(w.ref);
    w.clock.advance(2 * HOUR);
    // the commissioner switches pass TDs to 6 points; ESPN re-scores and its standings move
    state.passTd = 6;
    state.standingsMoved = 2 * HOUR;
    await w.provider.getStandings(w.ref); // mTeam + mStandings: the moved instant is seen
    const after = await w.provider.getScoringSettings(w.ref);
    expect(e.views).toEqual(["mSettings+mNav", "mTeam+mStandings", "mSettings+mNav"]);
    expect(passTdOf(before.value)).not.toBe(6);
    expect(passTdOf(after.value)).toBe(6);
    expect(after.stamp.cache).toBe("miss");
    // refetched once: the next read is a hit
    const again = await w.provider.getScoringSettings(w.ref);
    expect(again.stamp.cache).toBe("hit");
    expect(e.views).toHaveLength(3);
  });

  it("a waiver run seen in another answer outdates them too", async () => {
    const state = { standingsMoved: 0, waiversMoved: 0, passTd: null as number | null };
    const e = espn(state);
    const w = makeWorld({ fetch: e.fetch });
    await w.provider.getLeagueRules(w.ref);
    w.clock.advance(HOUR);
    state.waiversMoved = HOUR;
    await w.provider.getRosters(w.ref, 3);
    await w.provider.getLeagueRules(w.ref);
    expect(e.views).toEqual(["mSettings+mNav", "mRoster", "mSettings+mNav"]);
  });

  it("answers that carry the same instants outdate nothing (a hit, no request)", async () => {
    const state = { standingsMoved: 0, waiversMoved: 0, passTd: null as number | null };
    const e = espn(state);
    const w = makeWorld({ fetch: e.fetch });
    await w.provider.getScoringSettings(w.ref);
    w.clock.advance(HOUR);
    await w.provider.getStandings(w.ref);
    await w.provider.getRosters(w.ref, 3);
    const s = await w.provider.getScoringSettings(w.ref);
    expect(s.stamp.cache).toBe("hit");
    expect(e.views).toEqual(["mSettings+mNav", "mTeam+mStandings", "mRoster"]);
  });

  it("a settings answer that lags behind the move is refetched ONCE, then kept", async () => {
    const state = {
      standingsMoved: 0,
      waiversMoved: 0,
      passTd: null as number | null,
      settingsLag: true,
    };
    const e = espn(state);
    const w = makeWorld({ fetch: e.fetch });
    await w.provider.getScoringSettings(w.ref);
    w.clock.advance(HOUR);
    state.standingsMoved = HOUR;
    await w.provider.getStandings(w.ref);
    await w.provider.getScoringSettings(w.ref); // refetched: still the old instant (ESPN lags)
    w.clock.advance(1_000);
    await w.provider.getScoringSettings(w.ref);
    await w.provider.getLeague(w.ref);
    expect(e.views).toEqual(["mSettings+mNav", "mTeam+mStandings", "mSettings+mNav"]);
  });

  it("ESPN down: the outdated settings are served degraded, never an error", async () => {
    const state = {
      standingsMoved: 0,
      waiversMoved: 0,
      passTd: null as number | null,
      down: false,
    };
    const e = espn(state);
    const w = makeWorld({ fetch: e.fetch });
    await w.provider.getScoringSettings(w.ref);
    w.clock.advance(HOUR);
    state.standingsMoved = HOUR;
    await w.provider.getStandings(w.ref);
    state.down = true;
    const s = await w.provider.getScoringSettings(w.ref);
    expect(s.stamp.degraded?.code).toBe("ESPN_UPSTREAM_UNAVAILABLE");
    // three resets open the breaker: the entry is served from cache either way
    expect(["stale", "breaker"]).toContain(s.stamp.cache);
    expect(s.value.settings_hash).toBe("0".repeat(64));
  });
});

describe("invalidateSettings: an explicit invalidation (the golden mismatch, eff refresh espn:settings)", () => {
  it("outdates the cached settings in this process and in another one over the same cache; sends nothing itself", async () => {
    const state = { standingsMoved: 0, waiversMoved: 0, passTd: null as number | null };
    const e = espn(state);
    const cache = new MemoryCache();
    const clock = fixedClock(NOW_ISO);
    const one = makeWorld({ fetch: e.fetch, cache, clock });
    await one.provider.getScoringSettings(one.ref);
    clock.advance(HOUR);
    state.passTd = 6;
    one.provider.invalidateSettings(one.ref);
    expect(e.views).toHaveLength(1);
    // another process (a new provider over the same store) sees it
    const other = makeWorld({ fetch: e.fetch, cache, clock });
    const s = await other.provider.getScoringSettings(other.ref);
    expect(passTdOf(s.value)).toBe(6);
    expect(e.views).toEqual(["mSettings+mNav", "mSettings+mNav"]);
    // and the first process reads the refetched entry: a hit
    const hit = await one.provider.getScoringSettings(one.ref);
    expect(hit.stamp.cache).toBe("hit");
    expect(passTdOf(hit.value)).toBe(6);
    expect(e.views).toHaveLength(2);
  });

  it("refuses a league ref that is not the configured one (no row written)", () => {
    const w = makeWorld({
      fetch: espn({ standingsMoved: 0, waiversMoved: 0, passTd: null }).fetch,
    });
    expect(() => {
      w.provider.invalidateSettings({ platform: "espn", league_id: "999", season: SEASON });
    }).toThrow(/league_ref_not_configured/);
    expect(w.cache.map.has(settingsMarksKey(LEAGUE_ID, SEASON))).toBe(false);
    expect(w.cache.map.has(settingsDirtyKey(LEAGUE_ID, SEASON))).toBe(false);
    expect(w.cache.puts).toBe(0);
  });
});

describe("the marks (cache.ts): pure rule and kept row", () => {
  it("settingsOutdated: dirty after the fetch, or a newer instant seen to move after the fetch", () => {
    const m = { standings_ms: 200, waivers_ms: 100, moved_at_ms: 5_000, dirty_at_ms: null };
    const own = { standings_ms: 100, waivers_ms: 100 };
    expect(settingsOutdated(null, own, 1_000)).toBe(false);
    expect(settingsOutdated(m, own, 1_000)).toBe(true);
    // fetched after the move: kept, whatever it carries
    expect(settingsOutdated(m, own, 5_000)).toBe(false);
    // carries the newest instants already
    expect(settingsOutdated(m, { standings_ms: 200, waivers_ms: 100 }, 1_000)).toBe(false);
    // an answer that carries no instant: outdated by a move seen after it
    expect(settingsOutdated(m, { standings_ms: null, waivers_ms: null }, 1_000)).toBe(true);
    const dirty = { ...m, moved_at_ms: null, dirty_at_ms: 9_000 };
    expect(settingsOutdated(dirty, own, 8_999)).toBe(true);
    expect(settingsOutdated(dirty, own, 9_000)).toBe(false);
    expect(settingsOutdated(m, own, Number.NaN)).toBe(false);
  });

  it("statusInstantsOf reads finite non-negative instants only", () => {
    expect(
      statusInstantsOf({ status: { standingsUpdateDate: 5, waiverLastExecutionDate: 7 } }),
    ).toEqual({ standings_ms: 5, waivers_ms: 7 });
    for (const b of [null, 1, {}, { status: null }, { status: { standingsUpdateDate: "5" } }])
      expect(statusInstantsOf(b)).toEqual({ standings_ms: null, waivers_ms: null });
    expect(
      statusInstantsOf({ status: { standingsUpdateDate: -1, waiverLastExecutionDate: Infinity } }),
    ).toEqual({ standings_ms: null, waivers_ms: null });
  });

  it("the row is written only when an instant moves (never per read); a broken store reads as none", () => {
    const cache = new MemoryCache();
    const clock = fixedClock(NOW_ISO);
    const marks = cachedSettingsMarks(cache, LEAGUE_ID, SEASON, clock);
    marks.observe({ standings_ms: 100, waivers_ms: 50 }, 1_000);
    marks.observe({ standings_ms: 100, waivers_ms: 50 }, 2_000);
    marks.observe({ standings_ms: 90, waivers_ms: null }, 3_000);
    expect(cache.puts).toBe(1);
    expect(marks.load()).toEqual({
      standings_ms: 100,
      waivers_ms: 50,
      moved_at_ms: 1_000,
      dirty_at_ms: null,
    });
    marks.observe({ standings_ms: 100, waivers_ms: 60 }, 4_000);
    marks.invalidate(5_000);
    expect(marks.load()).toEqual({
      standings_ms: 100,
      waivers_ms: 60,
      moved_at_ms: 4_000,
      dirty_at_ms: 5_000,
    });
    const broken = cachedSettingsMarks(
      {
        get: () => {
          throw new Error("db");
        },
        put: () => {
          throw new Error("db");
        },
      },
      LEAGUE_ID,
      SEASON,
      clock,
    );
    expect(broken.load()).toBeNull();
    expect(() => {
      broken.observe({ standings_ms: 1, waivers_ms: 1 }, 1);
      broken.invalidate(1);
    }).not.toThrow();
    // an unreadable observation row reads as no instants: the invalidation, kept apart, stands
    cache.map.set(settingsMarksKey(LEAGUE_ID, SEASON), {
      ...cache.map.get(settingsMarksKey(LEAGUE_ID, SEASON))!,
      parsed_json: "not json",
    });
    expect(marks.load()).toEqual({
      standings_ms: null,
      waivers_ms: null,
      moved_at_ms: null,
      dirty_at_ms: 5_000,
    });
    cache.map.set(settingsDirtyKey(LEAGUE_ID, SEASON), {
      ...cache.map.get(settingsDirtyKey(LEAGUE_ID, SEASON))!,
      parsed_json: "null",
    });
    expect(marks.load()).toBeNull();
    // and the next move replaces the unreadable row
    marks.observe({ standings_ms: 120, waivers_ms: 60 }, 6_000);
    expect(marks.load()?.moved_at_ms).toBe(6_000);
  });

  it("an observation never erases an invalidation another process keeps meanwhile", () => {
    const cache = new MemoryCache();
    const clock = fixedClock(NOW_ISO);
    const job = cachedSettingsMarks(cache, LEAGUE_ID, SEASON, clock);
    job.observe({ standings_ms: 100, waivers_ms: 50 }, 1_000);
    // the server observes a moved instant; between its read of the kept marks and its write, the
    // nightly job's golden mismatch invalidates the settings (two processes over one store)
    let raced = false;
    const racing = {
      get: (key: string) => {
        const e = cache.get(key);
        if (!raced && key === settingsMarksKey(LEAGUE_ID, SEASON)) {
          raced = true;
          job.invalidate(2_000);
        }
        return e;
      },
      put: (e: Parameters<MemoryCache["put"]>[0]) => cache.put(e),
    };
    cachedSettingsMarks(racing, LEAGUE_ID, SEASON, clock).observe(
      { standings_ms: 110, waivers_ms: 50 },
      2_500,
    );
    expect(raced).toBe(true);
    expect(job.load()).toEqual({
      standings_ms: 110,
      waivers_ms: 50,
      moved_at_ms: 2_500,
      dirty_at_ms: 2_000,
    });
  });

  it("a store that cannot be read writes no observation (it would replace marks it never saw)", () => {
    const cache = new MemoryCache();
    const clock = fixedClock(NOW_ISO);
    const marks = cachedSettingsMarks(cache, LEAGUE_ID, SEASON, clock);
    marks.observe({ standings_ms: 100, waivers_ms: 50 }, 1_000);
    const puts = cache.puts;
    const unreadable = {
      get: () => {
        throw new Error("store busy");
      },
      put: (e: Parameters<MemoryCache["put"]>[0]) => cache.put(e),
    };
    cachedSettingsMarks(unreadable, LEAGUE_ID, SEASON, clock).observe(
      { standings_ms: 90, waivers_ms: null },
      2_000,
    );
    expect(cache.puts).toBe(puts);
    expect(marks.load()?.standings_ms).toBe(100);
    // an explicit invalidation is still written: what matters is that it is kept
    cachedSettingsMarks(unreadable, LEAGUE_ID, SEASON, clock).invalidate(3_000);
    expect(marks.load()?.dirty_at_ms).toBe(3_000);
  });
});

describe("end to end over the real store: the edit raises settings_changed inside the TTL", () => {
  let tmp: ReturnType<typeof tempDir> | undefined;
  let store: Store | undefined;
  afterEach(() => {
    store?.close();
    tmp?.cleanup();
    store = undefined;
    tmp = undefined;
  });

  it("fx-10h: a scoring edit with moved standings is recorded under the new hash two hours later", async () => {
    tmp = tempDir("eff-settings-inval-");
    const clock = fixedClock("2026-10-07T01:00:00.000Z");
    store = createStoreFactory({ busyTimeoutMs: 50 }).open({
      path: path.join(tmp.dir, "store.sqlite"),
      datasetDir: path.join(tmp.dir, "datasets"),
      backupDir: path.join(tmp.dir, "backups"),
      clock,
      migrate: true,
    });
    const inner = createDerivedLeagueFetch({ dir: path.join(FIXTURES, "fx-10h") });
    let edited = false;
    const fetch: FetchLike = async (url, init) => {
      const r = await inner(url, init);
      if (!edited) return r;
      const b = (await r.json()) as {
        status?: { standingsUpdateDate?: number };
        settings?: { scoringSettings: { scoringItems: { statId: number; points: number }[] } };
      };
      if (b.status !== undefined)
        b.status.standingsUpdateDate = (b.status.standingsUpdateDate ?? 0) + 2 * HOUR;
      for (const i of b.settings?.scoringSettings.scoringItems ?? [])
        if (i.statId === 53) i.points = 1; // half-PPR → full PPR
      return new Response(JSON.stringify(b), { status: r.status, headers: r.headers });
    };
    const ref = { platform: "espn", league_id: "0", season: 2026 } as const;
    const p = createEspnProvider({
      config: {
        leagueId: "0",
        season: 2026,
        teamId: 2,
        espnReadHost: "lm-api-reads.fantasy.espn.com",
        fixtureRecord: false,
        fixtureDir: null,
      },
      repos: store.repos,
      credentials: null,
      clock,
      scoring: translateScoringInput,
      fetch,
    });
    const before = await p.getScoringSettings(ref);
    clock.advance(2 * HOUR);
    edited = true;
    await p.getStandings(ref);
    clock.advance(1_001); // the limiter's one request per second (the clock is fixed)
    const after = await p.getScoringSettings(ref);
    expect(after.value.settings_hash).not.toBe(before.value.settings_hash);
    const changed = store.repos.leagueSettings
      .openChecks()
      .filter((c) => c.id === "settings_changed");
    expect(changed.map((c) => [c.settings_hash, c.detail.scoring_changed])).toEqual([
      [after.value.settings_hash, true],
    ]);
  });
});
