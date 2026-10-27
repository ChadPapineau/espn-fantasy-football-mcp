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
//
// Attempt 2 (the verifier: "only the provider half landed" — a golden mismatch still never re-read
// the settings). The E6 > 10 % rule (plan 08 §6 step 3(d): "the league's settings cache is marked
// dirty") is now the provider's own: an open `scoring_mismatch` check of status `fail` — the verdict
// the nightly roster snapshot keeps in store.sqlite when more than 10 % of a final week's checked
// player-weeks differ — outdates every settings answer fetched before it, in every process, once,
// for the configured season (cache.ts leagueWideMismatchAfter). `invalidateSettings` is on the
// FantasyPlatform seam, so a golden computed in the server (`espn_get_box_score`, which sees only the
// seam) can mark the settings dirty as well.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixedClock, type FixedClock } from "../../../src/domain/clock.js";
import type { CheckRow } from "../../../src/domain/league/types.js";
import { isLeagueWideMismatch, translateScoringInput } from "../../../src/domain/scoring/index.js";
import {
  cachedSettingsMarks,
  leagueWideMismatchAfter,
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
import { seasonTarget } from "../../../src/providers/espn/path.js";
import { EspnRequester } from "../../../src/providers/espn/request.js";
import type { FantasyPlatform } from "../../../src/providers/platform.js";
import { createStoreFactory } from "../../../src/store/index.js";
import { StoreBusyError, type Store } from "../../../src/store/types.js";
import { historyFixtureFetch } from "../../fixtures/helpers/history-fixtures.js";
import { tempDir } from "../../lint/helpers.js";
import {
  FIXTURES,
  LEAGUE_ID,
  makeWorld,
  MemoryCache,
  MemoryDrift,
  MemoryLimiterRepo,
  NOW_ISO,
  recording,
  SEASON,
} from "./helpers.js";

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

/**
 * The golden's verdict on a final week as the nightly roster snapshot raises it (src/cli/snapshot.ts):
 * `fail` when more than 10 % of the checked player-weeks differ (isLeagueWideMismatch, the E6 rule),
 * else `warn`; the counts and the rounded share in its detail.
 */
function verdict(
  at: string,
  mismatched: number,
  checked = 150,
  settingsHash = "0".repeat(64),
): CheckRow {
  return {
    id: "scoring_mismatch",
    status: isLeagueWideMismatch(mismatched, checked) ? "fail" : "warn",
    detail: {
      week: 4,
      checked,
      mismatched,
      share: Math.round((mismatched / checked) * 1000) / 1000,
    },
    raised_at: at,
    settings_hash: settingsHash,
    acknowledged: false,
    acknowledged_at: null,
    acknowledged_by: null,
  };
}

/** The provider's league_settings port: records nothing; its open checks are `checks` (or throw). */
function checksPort(checks: readonly CheckRow[] | (() => readonly CheckRow[])) {
  return {
    put: () => undefined,
    openChecks: () => (typeof checks === "function" ? checks() : checks),
  };
}

/** A league-a world whose provider reads its open checks from `leagueSettings`. */
function worldWith(
  fetch: FetchLike,
  leagueSettings: ReturnType<typeof checksPort>,
  shared: { readonly cache?: MemoryCache; readonly clock?: FixedClock } = {},
) {
  const limiter = new MemoryLimiterRepo();
  const cache = shared.cache ?? new MemoryCache();
  const drift = new MemoryDrift();
  return makeWorld({
    fetch,
    limiter,
    cache,
    drift,
    ...(shared.clock === undefined ? {} : { clock: shared.clock }),
    over: { repos: { limiter, cache, driftState: drift, leagueSettings } },
  });
}

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

  it("is on the FantasyPlatform seam: a caller holding only the seam (src/mcp's services.platform, where espn_get_box_score computes its golden) marks the settings dirty", async () => {
    const state = { standingsMoved: 0, waiversMoved: 0, passTd: null as number | null };
    const e = espn(state);
    const w = makeWorld({ fetch: e.fetch });
    const seam: FantasyPlatform = w.provider;
    await seam.getScoringSettings(w.ref);
    w.clock.advance(HOUR);
    state.passTd = 6;
    seam.invalidateSettings(w.ref);
    expect(e.views).toHaveLength(1); // nothing sent by the invalidation itself
    const s = await seam.getScoringSettings(w.ref);
    expect(s.stamp.cache).toBe("miss");
    expect(passTdOf(s.value)).toBe(6);
    expect(e.views).toEqual(["mSettings+mNav", "mSettings+mNav"]);
    expect(() => {
      seam.invalidateSettings({ ...w.ref, league_id: "999" });
    }).toThrow(/league_ref_not_configured/);
  });
});

describe("the golden's league-wide verdict (the E6 > 10 % rule) outdates the cached settings before their TTL", () => {
  it("leagueWideMismatchAfter: an open fail scoring_mismatch raised after the fetch; nothing else", () => {
    const fetched = Date.parse(NOW_ISO);
    const later = "2026-10-06T14:00:00.000Z";
    expect(leagueWideMismatchAfter([], fetched)).toBe(false);
    expect(leagueWideMismatchAfter([verdict(later, 40)], fetched)).toBe(true);
    // raised at or before the fetch: the cached answer is as new as the verdict, or newer
    expect(leagueWideMismatchAfter([verdict(NOW_ISO, 40)], fetched)).toBe(false);
    expect(leagueWideMismatchAfter([verdict("2026-10-06T11:00:00.000Z", 40)], fetched)).toBe(false);
    // at or below 10 % (15 of 150): warn, the settings stand; just above it: fail
    expect(verdict(later, 15).status).toBe("warn");
    expect(leagueWideMismatchAfter([verdict(later, 15)], fetched)).toBe(false);
    expect(leagueWideMismatchAfter([verdict(later, 16)], fetched)).toBe(true);
    // a human explained it (`eff doctor --ack scoring_mismatch`)
    const acked: CheckRow = {
      ...verdict(later, 40),
      acknowledged: true,
      acknowledged_at: later,
      acknowledged_by: "doctor",
    };
    expect(leagueWideMismatchAfter([acked], fetched)).toBe(false);
    // any other check, however severe
    for (const id of ["settings_changed", "ir_invalid", "stale_credential", "drift"] as const)
      expect(leagueWideMismatchAfter([{ ...verdict(later, 40), id }], fetched)).toBe(false);
    // an instant that does not parse; a fetch instant that is not finite
    expect(leagueWideMismatchAfter([verdict("not an instant", 40)], fetched)).toBe(false);
    expect(leagueWideMismatchAfter([verdict(later, 40)], Number.NaN)).toBe(false);
    // one verdict among other checks is enough
    expect(
      leagueWideMismatchAfter(
        [verdict(later, 15), { ...verdict(later, 40), id: "ir_invalid" }, verdict(later, 40)],
        fetched,
      ),
    ).toBe(true);
  });

  it("a verdict raised after the cached settings were fetched refetches them once: the commissioner's edit is seen", async () => {
    const state = { standingsMoved: 0, waiversMoved: 0, passTd: null as number | null };
    const e = espn(state);
    const checks: CheckRow[] = [];
    const w = worldWith(e.fetch, checksPort(checks));
    const before = await w.provider.getScoringSettings(w.ref);
    w.clock.advance(2 * HOUR);
    // the commissioner switches pass TDs to 6 points; ESPN's status instants do not move
    state.passTd = 6;
    // with no verdict the cached settings stand for their 24 h TTL: the edit is unseen
    const unseen = await w.provider.getScoringSettings(w.ref);
    expect(unseen.stamp.cache).toBe("hit");
    expect(passTdOf(unseen.value)).toBe(passTdOf(before.value));
    // the nightly golden re-scores the final week under the cached settings: 40 of 150 differ
    checks.push(verdict(w.clock.nowIso(), 40));
    w.clock.advance(1_000);
    const after = await w.provider.getScoringSettings(w.ref);
    expect(after.stamp.cache).toBe("miss");
    expect(passTdOf(before.value)).not.toBe(6);
    expect(passTdOf(after.value)).toBe(6);
    // one refetch per verdict: the answer fetched after it is current for every settings read
    expect((await w.provider.getLeagueRules(w.ref)).stamp.cache).toBe("hit");
    expect((await w.provider.getRosterSlots(w.ref)).stamp.cache).toBe("hit");
    expect((await w.provider.getScoringSettings(w.ref)).stamp.cache).toBe("hit");
    expect(e.views).toEqual(["mSettings+mNav", "mSettings+mNav"]);
  });

  it("refetches nothing for a verdict at or below 10 %, one raised at the fetch, one a human acknowledged, or another check", async () => {
    const e = espn({ standingsMoved: 0, waiversMoved: 0, passTd: null });
    const checks: CheckRow[] = [];
    const w = worldWith(e.fetch, checksPort(checks));
    await w.provider.getScoringSettings(w.ref);
    // raised in the same instant as the fetch: the cached answer is not older than the verdict
    checks.push(verdict(w.clock.nowIso(), 40));
    w.clock.advance(HOUR);
    const at = w.clock.nowIso();
    checks.push(
      verdict(at, 15), // exactly 10 %: warn
      { ...verdict(at, 40), acknowledged: true, acknowledged_at: at, acknowledged_by: "doctor" },
      { ...verdict(at, 40), id: "ir_invalid" },
    );
    w.clock.advance(1_000);
    expect((await w.provider.getScoringSettings(w.ref)).stamp.cache).toBe("hit");
    expect((await w.provider.getLeague(w.ref)).stamp.cache).toBe("hit");
    expect(e.views).toEqual(["mSettings+mNav"]);
  });

  it("a store whose checks cannot be read: the settings read as current, never an error; a moved instant still outdates them", async () => {
    const state = { standingsMoved: 0, waiversMoved: 0, passTd: null as number | null };
    const e = espn(state);
    const w = worldWith(
      e.fetch,
      checksPort(() => {
        throw new StoreBusyError("checks");
      }),
    );
    await w.provider.getScoringSettings(w.ref);
    w.clock.advance(HOUR);
    expect((await w.provider.getScoringSettings(w.ref)).stamp.cache).toBe("hit");
    state.standingsMoved = HOUR;
    state.passTd = 6;
    await w.provider.getStandings(w.ref);
    const s = await w.provider.getScoringSettings(w.ref);
    expect(s.stamp.cache).toBe("miss");
    expect(passTdOf(s.value)).toBe(6);
    expect(e.views).toEqual(["mSettings+mNav", "mTeam+mStandings", "mSettings+mNav"]);
  });

  it("ESPN down after the verdict: the cached settings are served degraded, never an error, and refetched once ESPN answers", async () => {
    const state = {
      standingsMoved: 0,
      waiversMoved: 0,
      passTd: null as number | null,
      down: false,
    };
    const e = espn(state);
    const checks: CheckRow[] = [];
    const w = worldWith(e.fetch, checksPort(checks));
    await w.provider.getScoringSettings(w.ref);
    w.clock.advance(HOUR);
    state.passTd = 6;
    checks.push(verdict(w.clock.nowIso(), 40));
    w.clock.advance(1_000);
    state.down = true;
    const down = await w.provider.getScoringSettings(w.ref);
    expect(down.stamp.degraded?.code).toBe("ESPN_UPSTREAM_UNAVAILABLE");
    expect(["stale", "breaker"]).toContain(down.stamp.cache);
    expect(passTdOf(down.value)).not.toBe(6);
    // ESPN answers again once the breaker's 5 minutes are over: the outdated answer is asked again
    state.down = false;
    w.clock.advance(5 * 60_000 + 1_000);
    const back = await w.provider.getScoringSettings(w.ref);
    expect(back.stamp.cache).toBe("miss");
    expect(back.stamp.degraded ?? null).toBeNull();
    expect(passTdOf(back.value)).toBe(6);
  });

  it("the verdict is the configured season's (the golden checks its weeks): a previous season's cached settings stand", async () => {
    const current = createFixtureFetch({ dir: FIXTURES, league: "league-a" });
    const history = historyFixtureFetch("league-a");
    const asked: string[] = [];
    const fetch: FetchLike = (url, init) => {
      const u = new URL(url);
      const season = /\/seasons\/(\d+)\//.exec(u.pathname)?.[1] ?? "?";
      asked.push(`${season}:${u.searchParams.getAll("view").join("+")}`);
      return (season === String(SEASON) ? current : history)(url, init);
    };
    const checks: CheckRow[] = [];
    const w = worldWith(fetch, checksPort(checks));
    const prior = { ...w.ref, season: SEASON - 1 };
    await w.provider.getLeagueRules(prior);
    await w.provider.getLeagueRules(w.ref);
    w.clock.advance(HOUR);
    checks.push(verdict(w.clock.nowIso(), 40));
    w.clock.advance(1_000);
    expect((await w.provider.getLeagueRules(prior)).stamp.cache).toBe("hit");
    expect((await w.provider.getLeagueRules(w.ref)).stamp.cache).toBe("miss");
    expect(asked).toEqual([
      `${String(SEASON - 1)}:mSettings`,
      `${String(SEASON)}:mSettings+mNav`,
      `${String(SEASON)}:mSettings+mNav`,
    ]);
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

  it("an instant that is not a finite number writes nothing", () => {
    const cache = new MemoryCache();
    const marks = cachedSettingsMarks(cache, LEAGUE_ID, SEASON, fixedClock(NOW_ISO));
    marks.observe({ standings_ms: 100, waivers_ms: 50 }, Number.NaN);
    marks.invalidate(Number.POSITIVE_INFINITY);
    expect(cache.puts).toBe(0);
    expect(marks.load()).toBeNull();
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

describe("the read's outdated hook (request.ts ReadSpec.outdated)", () => {
  const HOST = "lm-api-reads.fantasy.espn.com";
  const raw = (b: unknown): unknown => b;
  const spec = (outdated?: () => boolean) => ({
    target: seasonTarget({ host: HOST, season: SEASON }),
    filter: null,
    leagueId: null,
    cookies: "never" as const,
    parse: raw,
    ...(outdated === undefined ? {} : { outdated }),
  });

  it("true refetches a TTL-fresh entry; false, and a check that throws, read it as current", async () => {
    const clock = fixedClock(NOW_ISO);
    const rec = recording(createFixtureFetch({ dir: FIXTURES, league: "league-a" }));
    const r = new EspnRequester({
      fetch: rec.fetch,
      clock,
      limiter: new MemoryLimiterRepo(),
      cache: new MemoryCache(),
      driftState: new MemoryDrift(),
      credentials: null,
      host: HOST,
      origin: "server",
      observer: "server",
      recordRawBodies: false,
      sleep: (ms) => {
        clock.advance(ms);
        return Promise.resolve();
      },
      random: () => 0.5,
    });
    await r.read(spec());
    expect((await r.read(spec(() => false))).stamp.cache).toBe("hit");
    expect(
      (
        await r.read(
          spec(() => {
            throw new Error("check");
          }),
        )
      ).stamp.cache,
    ).toBe("hit");
    expect(rec.sent).toHaveLength(1);
    clock.advance(1_000);
    expect((await r.read(spec(() => true))).stamp.cache).toBe("miss");
    expect(rec.sent).toHaveLength(2);
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

  it("fx-10h: an edit no status instant shows is refetched on the nightly golden's league-wide verdict; settings_changed opens and a new process reads the new settings", async () => {
    tmp = tempDir("eff-settings-golden-");
    const clock = fixedClock("2026-10-07T01:00:00.000Z");
    store = createStoreFactory({ busyTimeoutMs: 50 }).open({
      path: path.join(tmp.dir, "store.sqlite"),
      datasetDir: path.join(tmp.dir, "datasets"),
      backupDir: path.join(tmp.dir, "backups"),
      clock,
      migrate: true,
    });
    const s = store;
    const inner = createDerivedLeagueFetch({ dir: path.join(FIXTURES, "fx-10h") });
    const views: string[] = [];
    let edited = false;
    const fetch: FetchLike = async (url, init) => {
      views.push(new URL(url).searchParams.getAll("view").join("+"));
      const r = await inner(url, init);
      if (!edited) return r;
      const b = (await r.json()) as {
        settings?: { scoringSettings: { scoringItems: { statId: number; points: number }[] } };
      };
      // half-PPR → full PPR; ESPN's status instants stay as they were
      for (const i of b.settings?.scoringSettings.scoringItems ?? [])
        if (i.statId === 53) i.points = 1;
      return new Response(JSON.stringify(b), { status: r.status, headers: r.headers });
    };
    const ref = { platform: "espn", league_id: "0", season: 2026 } as const;
    const make = () =>
      createEspnProvider({
        config: {
          leagueId: "0",
          season: 2026,
          teamId: 2,
          espnReadHost: "lm-api-reads.fantasy.espn.com",
          fixtureRecord: false,
          fixtureDir: null,
        },
        repos: s.repos,
        credentials: null,
        clock,
        scoring: translateScoringInput,
        fetch,
      });
    const p = make();
    const before = await p.getScoringSettings(ref);
    clock.advance(2 * HOUR);
    edited = true;
    // no instant moved: inside the 24 h TTL the edit is unseen
    expect((await p.getScoringSettings(ref)).value.settings_hash).toBe(before.value.settings_hash);
    // the nightly roster snapshot's golden on the just-finalised week, under those settings: the
    // receptions ESPN now pays a full point for differ on 61 of 160 player-weeks — raised as it is
    s.repos.leagueSettings.raiseCheck(verdict(clock.nowIso(), 61, 160, before.value.settings_hash));
    clock.advance(1_001); // the limiter's one request per second (the clock is fixed)
    const after = await p.getScoringSettings(ref);
    expect(after.stamp.cache).toBe("miss");
    expect(after.value.settings_hash).not.toBe(before.value.settings_hash);
    const changed = s.repos.leagueSettings.openChecks().filter((c) => c.id === "settings_changed");
    expect(changed.map((c) => [c.settings_hash, c.detail.scoring_changed])).toEqual([
      [after.value.settings_hash, true],
    ]);
    // a server started after the job (a new provider over the same store) reads the refetched
    // answer: one refetch for the verdict across processes
    const other = await make().getScoringSettings(ref);
    expect(other.stamp.cache).toBe("hit");
    expect(other.value.settings_hash).toBe(after.value.settings_hash);
    expect(views.filter((v) => v.includes("mSettings"))).toHaveLength(2);
  });
});
