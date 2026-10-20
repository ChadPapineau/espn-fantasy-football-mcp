// cache.test.ts — src/providers/espn/cache.ts (plan 01 §5.3; plan 05 §2 `providers/espn/cache`): the
// canonical key (view order, filter order → one entry), the class per view (a composite takes its
// strictest member), the PII strip (member names, notification settings, clientAddress never stored;
// owner GUIDs kept for own-team resolution; `__proto__` never copied), the force_refresh gate (once
// per 60 s per key) and the coalescer (N concurrent → one call).
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { FRESHNESS_TABLE } from "../../../src/config/freshness.js";
import {
  cacheKey,
  classForViews,
  Coalescer,
  type CoalesceParty,
  type LeaveReason,
  type SharedLimits,
  ForceRefreshGate,
  serverTimeIso,
  stripForCache,
  UNCACHED_VIEWS,
  VIEW_FRESHNESS,
} from "../../../src/providers/espn/cache.js";
import { canonicalJson } from "../../../src/providers/espn/filter.js";
import { leagueTarget, seasonTarget } from "../../../src/providers/espn/path.js";
import { ESPN_VIEWS } from "../../../src/providers/espn/types.js";
import { loadFixture } from "./helpers.js";

const H = "lm-api-reads.fantasy.espn.com";

describe("cacheKey", () => {
  it("two spellings of one request are one key; any difference is another", () => {
    const a = leagueTarget({
      host: H,
      season: 2026,
      leagueId: "0",
      views: ["mStandings", "mTeam"],
    });
    const b = leagueTarget({
      host: H,
      season: 2026,
      leagueId: "0",
      views: ["mTeam", "mStandings"],
    });
    const f1 = canonicalJson({ players: { b: 1, a: 2 } });
    const f2 = canonicalJson({ players: { a: 2, b: 1 } });
    expect(cacheKey(a, "0", f1)).toBe(cacheKey(b, "0", f2));
    expect(cacheKey(a, "0", null)).not.toBe(cacheKey(a, "0", f1));
    expect(cacheKey(a, "0", null)).not.toBe(cacheKey(a, "1", null));
    const r3 = leagueTarget({
      host: H,
      season: 2026,
      leagueId: "0",
      views: ["mRoster"],
      scoringPeriodId: 3,
    });
    const r4 = leagueTarget({
      host: H,
      season: 2026,
      leagueId: "0",
      views: ["mRoster"],
      scoringPeriodId: 4,
    });
    expect(cacheKey(r3, "0", null)).not.toBe(cacheKey(r4, "0", null));
    expect(cacheKey(r3, "0", null)).toContain("sp=3");
    expect(cacheKey(seasonTarget({ host: H, season: 2026 }), null, null)).toBe(
      "espn:v1|season|2026|-|proTeamSchedules_wl|sp=-|f=-",
    );
  });
});

describe("freshness classes", () => {
  it("every view has a class from the table; the board view is never cached", () => {
    for (const v of ESPN_VIEWS)
      expect(FRESHNESS_TABLE[VIEW_FRESHNESS[v]].origin).toMatch(/espn|dataset/);
    expect(UNCACHED_VIEWS).toEqual(["kona_league_communication"]);
  });
  it("a composite takes its strictest member; immutable last", () => {
    expect(classForViews(["mSettings", "mNav"]).id).toBe("espn_settings");
    expect(classForViews(["mSettings", "mTeam"]).id).toBe("espn_standings");
    expect(classForViews(["mDraftDetail", "mTeam"]).id).toBe("espn_standings");
    expect(classForViews(["mDraftDetail"]).id).toBe("espn_draft");
    expect(() => classForViews([])).toThrow(RangeError);
  });
});

describe("stripForCache (plan 02 §2.4)", () => {
  it("drops member names, notification settings and any clientAddress; keeps owner GUIDs and team names", () => {
    const body = {
      members: [
        {
          id: "{00000000-0000-4000-8000-000000000001}",
          displayName: "Member 1",
          firstName: "F",
          lastName: "L",
          isLeagueCreator: false,
          notificationSettings: [{ x: 1 }],
        },
      ],
      teams: [{ id: 1, name: "Team A", owners: ["{00000000-0000-4000-8000-000000000001}"] }],
      status: { lastUpdateInfo: { clientAddress: "0.0.0.0" }, isActive: true },
      deep: { a: [{ clientAddress: "0.0.0.0", ok: 1 }] },
    };
    expect(stripForCache(body)).toEqual({
      members: [{ id: "{00000000-0000-4000-8000-000000000001}", isLeagueCreator: false }],
      teams: [{ id: 1, name: "Team A", owners: ["{00000000-0000-4000-8000-000000000001}"] }],
      status: { isActive: true },
      deep: { a: [{ ok: 1 }] },
    });
  });
  it("a recorded mNav body keeps nothing of a member but id and flags", () => {
    const out = stripForCache(loadFixture("recorded/league-a/mNav.json")) as {
      members: Record<string, unknown>[];
    };
    for (const m of out.members)
      expect(Object.keys(m).sort()).toEqual(["id", "isLeagueCreator", "isLeagueManager"]);
  });
  it("never copies __proto__; cuts hostile depth; scalars pass", () => {
    const hostile = JSON.parse('{"a":{"__proto__":{"polluted":true},"b":1}}') as unknown;
    const out = stripForCache(hostile) as { a: Record<string, unknown> };
    expect(Object.getPrototypeOf(out.a)).toBe(Object.prototype);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(out.a).toEqual({ b: 1 });
    let deep: unknown = 1;
    for (let i = 0; i < 60; i++) deep = { d: deep };
    expect(JSON.stringify(stripForCache(deep))).toContain("null");
    expect(stripForCache("x")).toBe("x");
    expect(stripForCache(null)).toBeNull();
  });
});

describe("ForceRefreshGate", () => {
  it("honours force_refresh at most once per 60 s per key", () => {
    const g = new ForceRefreshGate();
    expect(g.allow("k", 0)).toBe(true);
    expect(g.allow("k", 59_999)).toBe(false);
    expect(g.allow("other", 1)).toBe(true);
    expect(g.allow("k", 60_000)).toBe(true);
  });
  it("stays bounded (oldest key evicted past 4096)", () => {
    const g = new ForceRefreshGate();
    for (let i = 0; i < 4100; i++) g.allow(`k${String(i)}`, 0);
    expect(g.allow("k0", 1)).toBe(true);
    expect(g.allow("k4099", 1)).toBe(false);
  });
});

describe("Coalescer", () => {
  // a reader with no budget: the default 20 s window, never cancelled
  const lone = (deadlineAtMs = Date.now() + 20_000): CoalesceParty => ({
    deadlineAtMs,
    signal: null,
  });
  const gone = (why: LeaveReason): Error => new Error(`left: ${why}`);
  it("N concurrent identical calls → one run; the key is free again afterwards", async () => {
    const c = new Coalescer<number>();
    let runs = 0;
    let release!: (n: number) => void;
    const gate = new Promise<number>((r) => (release = r));
    const calls = Array.from({ length: 5 }, () => c.run("k", lone(), () => (runs++, gate), gone));
    expect(calls.filter((x) => x.joined)).toHaveLength(4);
    expect(c.size).toBe(1);
    expect(c.has("k")).toBe(true);
    release(7);
    expect(await Promise.all(calls.map((x) => x.promise))).toEqual([7, 7, 7, 7, 7]);
    expect(runs).toBe(1);
    expect(c.size).toBe(0);
    expect(c.has("k")).toBe(false);
    const failing = c.run("k", lone(), () => Promise.reject(new Error("boom")), gone);
    await expect(failing.promise).rejects.toThrow("boom");
    expect(c.size).toBe(0);
    const thrown = c.run(
      "k",
      lone(),
      () => {
        throw new Error("sync");
      },
      gone,
    );
    await expect(thrown.promise).rejects.toThrow("sync");
    expect(c.size).toBe(0);
  });
  it("property: concurrent calls over k keys run exactly k times", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 1, maxLength: 30 }),
        async (keys) => {
          const c = new Coalescer<string>();
          let runs = 0;
          const ps = keys.map(
            (k) =>
              c.run(
                String(k),
                lone(),
                async () => {
                  runs++;
                  await Promise.resolve();
                  return String(k);
                },
                gone,
              ).promise,
          );
          expect(await Promise.all(ps)).toEqual(keys.map(String));
          expect(runs).toBe(new Set(keys).size);
        },
      ),
    );
  });

  // Stage C finding espn-coalesced-read-leader-budget: the run used to take the FIRST caller's
  // signal and deadline, so cancelling that caller failed every joiner
  it("a reader's cancellation ends its own wait only: the run goes on for the others", async () => {
    const c = new Coalescer<string>();
    let release!: (v: string) => void;
    let limits!: SharedLimits;
    const a = new AbortController();
    const first = c.run(
      "k",
      { deadlineAtMs: Date.now() + 20_000, signal: a.signal },
      (l) => {
        limits = l;
        return new Promise<string>((r) => (release = r));
      },
      gone,
    );
    const second = c.run("k", lone(), () => Promise.reject(new Error("never run")), gone);
    expect(second.joined).toBe(true);
    a.abort();
    await expect(first.promise).rejects.toThrow("left: aborted");
    expect(limits.signal.aborted).toBe(false);
    expect(c.has("k")).toBe(true);
    release("data");
    await expect(second.promise).resolves.toBe("data");
  });
  it("the run is aborted, and the key freed, only once every reader has gone", async () => {
    const c = new Coalescer<string>();
    let limits!: SharedLimits;
    const a = new AbortController();
    const b = new AbortController();
    const first = c.run(
      "k",
      { deadlineAtMs: Date.now() + 20_000, signal: a.signal },
      (l) => {
        limits = l;
        return new Promise<string>((_r, rej) => {
          l.signal.addEventListener("abort", () => {
            rej(new Error("aborted run"));
          });
        });
      },
      gone,
    );
    const second = c.run(
      "k",
      { deadlineAtMs: Date.now() + 20_000, signal: b.signal },
      () => Promise.reject(new Error("never run")),
      gone,
    );
    a.abort();
    await expect(first.promise).rejects.toThrow("left: aborted");
    expect(limits.signal.aborted).toBe(false);
    b.abort();
    await expect(second.promise).rejects.toThrow("left: aborted");
    expect(limits.signal.aborted).toBe(true);
    expect(limits.canStart(Date.now())).toBe(false);
    // a later reader starts a run of its own, never joining the aborted one
    let runs = 0;
    const third = c.run("k", lone(), () => (runs++, Promise.resolve("fresh")), gone);
    expect(third.joined).toBe(false);
    await expect(third.promise).resolves.toBe("fresh");
    expect(runs).toBe(1);
  });
  it("a reader already cancelled starts and joins nothing", async () => {
    const c = new Coalescer<string>();
    const a = new AbortController();
    a.abort();
    let runs = 0;
    const r = c.run(
      "k",
      { deadlineAtMs: Date.now() + 20_000, signal: a.signal },
      () => (runs++, Promise.resolve("x")),
      gone,
    );
    await expect(r.promise).rejects.toThrow("left: aborted");
    expect(runs).toBe(0);
    expect(c.size).toBe(0);
  });
  it("the run's deadline is the latest of the readers still waiting; each reader stops at its own", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const c = new Coalescer<string>(() => Date.now());
      let release!: (v: string) => void;
      let limits!: SharedLimits;
      const t0 = Date.now();
      const early = c.run(
        "k",
        { deadlineAtMs: t0 + 100, signal: null },
        (l) => {
          limits = l;
          return new Promise<string>((r) => (release = r));
        },
        gone,
      );
      expect(limits.deadline()).toBe(t0 + 100);
      expect(limits.canStart(t0 + 99)).toBe(true);
      expect(limits.canStart(t0 + 100)).toBe(false);
      expect(limits.canStart(Number.NaN)).toBe(false);
      const late = c.run(
        "k",
        { deadlineAtMs: t0 + 20_000, signal: null },
        () => Promise.reject(new Error("never run")),
        gone,
      );
      // a later reader extends the run: it may now start requests up to that reader's deadline
      expect(limits.deadline()).toBe(t0 + 20_000);
      expect(limits.canStart(t0 + 5_000)).toBe(true);
      let earlyOutcome: unknown = null;
      early.promise.catch((e: unknown) => (earlyOutcome = e));
      await vi.advanceTimersByTimeAsync(100);
      // the early reader stopped at ITS deadline; the run goes on, bounded by the late reader's
      expect(String(earlyOutcome)).toContain("left: deadline");
      expect(limits.signal.aborted).toBe(false);
      expect(limits.deadline()).toBe(t0 + 20_000);
      release("late data");
      await expect(late.promise).resolves.toBe("late data");
    } finally {
      vi.useRealTimers();
    }
  });
  it("a lone reader arms no timer of its own (the run's own timing bounds it)", async () => {
    vi.useFakeTimers({ now: 2_000_000 });
    try {
      const c = new Coalescer<string>(() => Date.now());
      let release!: (v: string) => void;
      const r = c.run(
        "k",
        { deadlineAtMs: Date.now() + 50, signal: null },
        () => new Promise<string>((res) => (release = res)),
        gone,
      );
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1_000);
      release("late but alone");
      await expect(r.promise).resolves.toBe("late but alone");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("serverTimeIso", () => {
  it("parses RFC 1123; refuses junk and over-long values", () => {
    expect(serverTimeIso("Tue, 06 Oct 2026 06:28:53 GMT")).toBe("2026-10-06T06:28:53.000Z");
    expect(serverTimeIso(undefined)).toBeNull();
    expect(serverTimeIso("not a date")).toBeNull();
    expect(serverTimeIso("x".repeat(65))).toBeNull();
  });
});
