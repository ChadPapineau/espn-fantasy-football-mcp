// skew.test.ts — rows stamped under a clock that has since been set back (Stage C finding
// store-future-stamped-rows-block; src/store/repos/skew.ts): NTP stepping a fast RTC back, a manual
// date change. Read as written, such a row was never in the past: the limiter's windows (no upper
// bound) refused every ESPN read for the size of the skew, a job's daily cap was spent on the next
// day too, prune never removed the row, a commissioner's settings edit read as a late answer, a
// check raised then could not be acknowledged and a new snapshot was filed behind the old one. Each
// case here failed before the fix; the tool-level case is the finding's own repro (a fixture world:
// one request stamped 3 h ahead → espn_get_league RATE_LIMITED for 10 801 s, 0 upstream requests).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IN_FLIGHT_MAX_AGE_MS, limiterRequest, trySlot } from "../../src/providers/espn/limiter.js";
import { pruneStore } from "../../src/store/prune.js";
import { REQUEST_SKEW_TOLERANCE_MS } from "../../src/store/repos/skew.js";
import type { LimiterRequest, Store } from "../../src/store/types.js";
import { call, connect, makeWorld } from "../mcp/helpers/world.js";
import { openStore, tempCache, type TempCache } from "./helpers/env.js";

let t: TempCache;
let s: Store;
beforeEach(() => {
  t = tempCache();
  s = openStore(t);
});
afterEach(() => {
  s.close();
  t.cleanup();
});

const iso = (ms: number): string => new Date(ms).toISOString();
const MIN = 60_000;
const HOUR = 3_600_000;

/** One send the way the provider and the CLI ask for it (plan 01 §6: ≤ 30/min, ≤ 1/s). */
const send = (atMs: number, origin: "server" | "job" = "server"): LimiterRequest =>
  limiterRequest(atMs, false, origin);

describe("the limiter after a backward clock correction", () => {
  it("the finding's repro: a request recorded 10 min fast holds the per-second slot 1 s, never the 10 min", () => {
    const fast = Date.parse("2026-11-01T17:10:00.000Z");
    expect(s.repos.limiter.tryRecord(send(fast))).toMatchObject({ ok: true });
    // the clock is set back 10 min: the row counts as a request made just now (the latest it can
    // have been made) — the per-second slot is busy for 1 s, as after any request
    const at = (hms: string): number => Date.parse(`2026-11-01T${hms}.000Z`);
    expect(s.repos.limiter.tryRecord(send(at("17:00:05")))).toEqual({
      ok: false,
      reason: "window",
      retry_after_ms: 1000,
    });
    expect(s.repos.limiter.tryRecord(send(at("17:05:00")))).toMatchObject({ ok: true });
    expect(s.repos.limiter.tryRecord(send(at("17:09:00")))).toMatchObject({ ok: true });
    expect(s.repos.limiter.tryRecord(send(at("17:10:02")))).toMatchObject({ ok: true });
  });

  it("a full minute recorded 3 h fast holds the minute window 60 s — the bucket never admits more than its rate", () => {
    const now = Date.parse("2026-11-01T12:00:00.000Z");
    for (let i = 0; i < 30; i++)
      expect(s.repos.limiter.tryRecord(send(now + 3 * HOUR + i * 1500)).ok).toBe(true);
    // the 30 rows may have been made in the last real minute: they count as made now, once
    expect(s.repos.limiter.tryRecord(send(now))).toEqual({
      ok: false,
      reason: "window",
      retry_after_ms: MIN,
    });
    expect(s.repos.limiter.tryRecord(send(now + MIN - 1))).toMatchObject({
      ok: false,
      reason: "window",
    });
    expect(s.repos.limiter.tryRecord(send(now + MIN + 1))).toMatchObject({ ok: true });
    expect(s.repos.limiter.countSince(iso(now + 2 * HOUR))).toBe(0);
  });

  it("another process's row stamped while this request waited for the writer lock is kept as written", () => {
    const now = Date.parse("2026-11-01T12:00:00.000Z");
    // stamped up to the busy wait after this request's instant (taken before BEGIN IMMEDIATE)
    expect(s.repos.limiter.tryRecord(send(now + REQUEST_SKEW_TOLERANCE_MS)).ok).toBe(true);
    expect(s.repos.limiter.tryRecord(send(now))).toEqual({
      ok: false,
      reason: "window",
      retry_after_ms: REQUEST_SKEW_TOLERANCE_MS + 1000,
    });
    expect(s.repos.limiter.countSince(iso(now + REQUEST_SKEW_TOLERANCE_MS))).toBe(1);
  });

  it("a row stamped no later than the store's clock is never moved, whatever instant a request carries", () => {
    const now = Date.parse("2026-11-01T12:00:00.000Z");
    t.clock.set(now);
    expect(s.repos.limiter.tryRecord(send(now)).ok).toBe(true);
    // a caller's stale instant (a day old) must not re-stamp the request just made into the past —
    // that would empty the bucket for the next one
    s.repos.limiter.tryRecord(send(now - 24 * HOUR));
    expect(s.repos.limiter.countSince(iso(now))).toBe(1);
    expect(s.repos.limiter.tryRecord(send(now + 500))).toEqual({
      ok: false,
      reason: "window",
      retry_after_ms: 500,
    });
  });

  it("a job's rows stamped into tomorrow by a fast clock spend today's daily cap once, never tomorrow's too", () => {
    const job = (atMs: number, max: number): LimiterRequest => {
      const r = send(atMs, "job");
      return { ...r, dailyCap: r.dailyCap === null ? null : { ...r.dailyCap, max } };
    };
    const tonight = Date.parse("2026-11-01T23:30:00.000Z");
    // an hour fast: both stamped after midnight UTC
    expect(s.repos.limiter.tryRecord(job(tonight + HOUR, 2)).ok).toBe(true);
    expect(s.repos.limiter.tryRecord(job(tonight + HOUR + 2000, 2)).ok).toBe(true);
    // corrected: they were made just now (the per-second slot is busy for 1 s) and they were
    // today's — the cap is spent until midnight
    expect(s.repos.limiter.tryRecord(job(tonight + MIN, 2))).toEqual({
      ok: false,
      reason: "window",
      retry_after_ms: 1000,
    });
    expect(s.repos.limiter.tryRecord(job(tonight + 3 * MIN, 2))).toEqual({
      ok: false,
      reason: "daily_cap",
      retry_after_ms: Date.parse("2026-11-02T00:00:00.000Z") - (tonight + 3 * MIN),
    });
    // tomorrow's cap is whole
    const midnight = Date.parse("2026-11-02T00:00:00.000Z");
    expect(s.repos.limiter.tryRecord(job(midnight + 1000, 2)).ok).toBe(true);
    expect(s.repos.limiter.tryRecord(job(midnight + 3000, 2)).ok).toBe(true);
  });

  it("pending rows stamped ahead (a crashed process, fast clock) hold the in-flight cap 30 s, never the skew", () => {
    const now = Date.parse("2026-11-01T12:00:00.000Z");
    for (const ahead of [2 * HOUR, 2 * HOUR + 5000]) {
      const v = s.repos.limiter.tryRecord(send(now + ahead));
      if (!v.ok) throw new Error("refused");
      // never finished: the row stays `pending`
    }
    const withCap = (atMs: number): LimiterRequest => ({
      ...send(atMs),
      inFlight: { since: iso(atMs - 30_000), max: 2, retry_after_ms: 250 },
    });
    expect(s.repos.limiter.tryRecord(withCap(now))).toEqual({
      ok: false,
      reason: "concurrency",
      retry_after_ms: 250,
    });
    expect(s.repos.limiter.tryRecord(withCap(now + 30_001))).toMatchObject({ ok: true });
  });
});

describe("prune after a backward clock correction", () => {
  it("re-stamps request rows stamped ahead to its instant (they age out by the TTL) and deletes cache rows fetched ahead", () => {
    const now = Date.parse("2026-11-01T12:00:00.000Z");
    t.clock.set(now);
    const v = s.repos.limiter.tryRecord(send(now + 3 * HOUR));
    if (!v.ok) throw new Error("refused");
    s.repos.limiter.recordOutcome(v.id, "ok");
    const entry = (key: string, fetchedMs: number) => ({
      key,
      parsed_json: "{}",
      fetched_at: iso(fetchedMs),
      server_time: null,
      etag: null,
      http_status: 200,
      raw_body: null,
    });
    s.repos.espnCache.put(entry("ahead", now + 3 * HOUR));
    s.repos.espnCache.put(entry("fresh", now - MIN));
    const first = pruneStore(s, { files: false });
    expect(first.restamped).toEqual({ espn_requests: 1 });
    expect(first.rows.espn_requests).toBe(0);
    expect(first.rows.espn_cache).toBe(1);
    expect(s.repos.espnCache.get("ahead")).toBeNull();
    expect(s.repos.espnCache.get("fresh")).not.toBeNull();
    // the row now reads as made at the prune: inside the next minute's window, then aged out by the TTL
    expect(s.repos.limiter.recentOutcomes(5)).toEqual([{ at: iso(now), outcome: "ok" }]);
    const later = pruneStore(s, { files: false, now: iso(now + 48 * HOUR + 1) });
    expect(later.restamped).toEqual({ espn_requests: 0 });
    expect(later.rows.espn_requests).toBe(1);
    expect(s.repos.limiter.recentOutcomes(5)).toEqual([]);
  });
});

describe("orderings and acknowledgements after a backward clock correction", () => {
  const NOW = Date.parse("2026-11-01T12:00:00.000Z");
  const HASH_A = "a".repeat(64);
  const HASH_B = "b".repeat(64);
  const settings = (hash: string, fetchedMs: number, budget = 100) => ({
    league_id: "0",
    season: 2026,
    settings_hash: hash,
    scoring: { platform: "espn", rules: [] } as never,
    slots: { slots: [] } as never,
    rules: { waiver: { budget } } as never,
    fetched_at: iso(fetchedMs),
  });
  beforeEach(() => {
    t.clock.set(NOW);
  });

  it("a commissioner's edit fetched after the correction is the newest settings and raises settings_changed", () => {
    s.repos.leagueSettings.put(settings(HASH_A, NOW - 2 * HOUR));
    s.repos.leagueSettings.put(settings(HASH_A, NOW + 3 * HOUR)); // fetched while 3 h fast
    expect(s.repos.leagueSettings.openChecks()).toEqual([]);
    s.repos.leagueSettings.put(settings(HASH_B, NOW, 200));
    expect(s.repos.leagueSettings.latest("0", 2026)).toMatchObject({
      settings_hash: HASH_B,
      fetched_at: iso(NOW),
    });
    expect(s.repos.leagueSettings.openChecks().map((c) => [c.id, c.settings_hash])).toEqual([
      ["settings_changed", HASH_B],
    ]);
    // a genuinely late answer (fetched before the newest, under the same clock) still raises nothing
    s.repos.leagueSettings.put(settings(HASH_A, NOW - HOUR));
    expect(s.repos.leagueSettings.latest("0", 2026)?.settings_hash).toBe(HASH_B);
    expect(s.repos.leagueSettings.openChecks()).toHaveLength(1);
  });

  it("a fetch of the same settings after the correction is recorded, not silenced by the row stamped ahead", () => {
    s.repos.leagueSettings.put(settings(HASH_A, NOW + 3 * HOUR, 100));
    s.repos.leagueSettings.put(settings(HASH_A, NOW, 300));
    expect(s.repos.leagueSettings.byHash(HASH_A)).toMatchObject({
      fetched_at: iso(NOW),
      rules: { waiver: { budget: 300 } },
    });
    // the re-record of the very fetch a row holds takes no write (the read path's common case)
    s.repos.leagueSettings.put(settings(HASH_A, NOW, 300));
    expect(s.repos.leagueSettings.byHash(HASH_A)?.fetched_at).toBe(iso(NOW));
  });

  it("a check raised while the clock ran fast is closed by an acknowledgement made now; a later one stays open", () => {
    const check = (raisedMs: number) => ({
      id: "drift" as const,
      status: "warn" as const,
      detail: { view: 1 },
      raised_at: iso(raisedMs),
      settings_hash: null,
      acknowledged: false,
      acknowledged_at: null,
      acknowledged_by: null,
    });
    s.repos.leagueSettings.raiseCheck(check(NOW + 3 * HOUR));
    expect(s.repos.leagueSettings.acknowledgeChecks("drift", iso(NOW), "doctor", iso(NOW))).toBe(1);
    expect(s.repos.leagueSettings.openChecks()).toEqual([]);
    // under the corrected clock, a raise after the instant acknowledged stays open as before
    t.clock.set(NOW + 2 * MIN);
    s.repos.leagueSettings.raiseCheck(check(NOW + MIN));
    expect(
      s.repos.leagueSettings.acknowledgeChecks("drift", iso(NOW), "doctor", iso(NOW + 2 * MIN)),
    ).toBe(0);
    expect(s.repos.leagueSettings.openChecks()).toHaveLength(1);
    // an acknowledgement NOT made under the store's clock (its own instant lies past it) is no
    // evidence about a raise past the clock either: only what it names, up to its instant, closes
    s.repos.leagueSettings.raiseCheck(check(NOW + 5 * HOUR));
    expect(
      s.repos.leagueSettings.acknowledgeChecks(
        "drift",
        iso(NOW + 4 * HOUR),
        "doctor",
        iso(NOW + 4 * HOUR),
      ),
    ).toBe(1);
    expect(s.repos.leagueSettings.openChecks().map((c) => c.raised_at)).toEqual([
      iso(NOW + 5 * HOUR),
    ]);
  });

  it("a snapshot taken after the correction is the newest; the one taken while fast is next", () => {
    s.repos.rosterSnapshots.put({
      team_id: 3,
      week: 9,
      taken_at: iso(NOW - 26 * HOUR),
      roster: { n: 0 } as never,
    });
    s.repos.rosterSnapshots.put({
      team_id: 3,
      week: 9,
      taken_at: iso(NOW + 3 * HOUR),
      roster: { n: 1 } as never,
    });
    s.repos.rosterSnapshots.put({
      team_id: 3,
      week: 9,
      taken_at: iso(NOW),
      roster: { n: 2 } as never,
    });
    expect(s.repos.rosterSnapshots.latestTwo(3).map((r) => r.roster)).toEqual([{ n: 2 }, { n: 1 }]);
    s.repos.poolSnapshots.put({
      week: 9,
      taken_at: iso(NOW + 3 * HOUR),
      players: [{ id: 1 }] as never,
    });
    s.repos.poolSnapshots.put({ week: 9, taken_at: iso(NOW), players: [] });
    expect(s.repos.poolSnapshots.latestTwo().map((p) => p.players.length)).toEqual([0, 1]);
  });
});

describe("the tools after a backward clock correction (the finding's repro)", () => {
  it("one request stamped 3 h ahead: espn_get_league and espn_get_roster answer, with and without a prune between", async () => {
    const world = await makeWorld({ league: "league-b" });
    const { client, close } = await connect(world);
    try {
      const ahead = (): void => {
        const v = world.store.repos.limiter.tryRecord(send(world.clock.nowMs() + 3 * HOUR));
        if (!v.ok) throw new Error("refused");
        world.store.repos.limiter.recordOutcome(v.id, "ok");
      };
      ahead();
      const before = world.requests.length;
      const league = await call(client, "espn_get_league", {});
      expect(league.isError, JSON.stringify(league.body).slice(0, 300)).toBe(false);
      expect(world.requests.length).toBeGreaterThan(before);
      ahead();
      expect(pruneStore(world.store, { files: false }).restamped).toEqual({ espn_requests: 1 });
      const roster = await call(client, "espn_get_roster", {});
      expect(roster.isError, JSON.stringify(roster.body).slice(0, 300)).toBe(false);
    } finally {
      await close();
      world.cleanup();
    }
  }, 120_000);

  // the readers' half (src/store/repos/skew.ts names them): the in-flight pre-check, the derived
  // breaker and a cached copy's freshness judge an instant past now themselves (config/freshness.ts
  // stampedAhead) — the store hands such rows out as stamped
  it("two pending rows a crashed process stamped 3 h fast hold a slot 30 s, never the 3 h: espn_get_league then answers (the in-flight pre-check)", async () => {
    const world = await makeWorld({ league: "league-b" });
    const { client, close } = await connect(world);
    try {
      for (const ms of [3 * HOUR, 3 * HOUR + 1100])
        expect(world.store.repos.limiter.tryRecord(send(world.clock.nowMs() + ms)).ok).toBe(true);
      // the next send's pre-check reads them as no evidence (before: refused `concurrency` here,
      // so tryRecord — which re-stamps them — was never reached and they held both slots 3 h); the
      // store then counts them as in flight just now
      expect(trySlot(world.store.repos.limiter, send(world.clock.nowMs()))).toMatchObject({
        ok: false,
        reason: "concurrency",
      });
      world.clock.advance(IN_FLIGHT_MAX_AGE_MS + 1000);
      const before = world.requests.length;
      const league = await call(client, "espn_get_league", {});
      expect(league.isError, JSON.stringify(league.body).slice(0, 300)).toBe(false);
      expect(world.requests.length).toBeGreaterThan(before);
    } finally {
      await close();
      world.cleanup();
    }
  }, 120_000);

  it("three failures recorded 3 h fast hold no breaker: espn_get_league is sent and answers, status reads it closed", async () => {
    const world = await makeWorld({ league: "league-b" });
    const { client, close } = await connect(world);
    try {
      for (const ms of [3 * HOUR, 3 * HOUR + 1100, 3 * HOUR + 2200]) {
        const v = world.store.repos.limiter.tryRecord(send(world.clock.nowMs() + ms));
        if (!v.ok) throw new Error("refused");
        world.store.repos.limiter.recordOutcome(v.id, "server_error");
      }
      const before = world.requests.length;
      const league = await call(client, "espn_get_league", {});
      expect(league.isError, JSON.stringify(league.body).slice(0, 300)).toBe(false);
      expect(world.requests.length).toBeGreaterThan(before);
      const st = await call(client, "espn_get_status", {});
      expect(st.isError).toBe(false);
      expect((st.body.data as { limiter: { breaker_open: boolean } }).limiter.breaker_open).toBe(
        false,
      );
    } finally {
      await close();
      world.cleanup();
    }
  }, 120_000);

  it("a copy cached while the clock ran 3 h fast is never served fresh: espn_get_league refetches it", async () => {
    const world = await makeWorld({ league: "league-b" });
    const { client, close } = await connect(world);
    try {
      world.clock.advance(3 * HOUR);
      const fast = await call(client, "espn_get_league", {});
      expect(fast.isError).toBe(false);
      // the correction: the clock is set back 3 h; the cached copy now reads as fetched in the future
      world.clock.advance(-3 * HOUR);
      const before = world.requests.length;
      const again = await call(client, "espn_get_league", {});
      expect(again.isError, JSON.stringify(again.body).slice(0, 300)).toBe(false);
      // refetched — before, a cache hit labelled fresh with age_s 0 and a fetched_at 3 h ahead
      expect(world.requests.length).toBeGreaterThan(before);
      const meta = again.body.meta as { fetched_at: string; freshness: string };
      expect(Date.parse(meta.fetched_at)).toBeLessThanOrEqual(world.clock.nowMs() + 1000);
      expect(meta.freshness).toBe("fresh");
    } finally {
      await close();
      world.cleanup();
    }
  }, 120_000);
});
