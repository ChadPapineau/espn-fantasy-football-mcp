// freshness.test.ts — src/config/freshness.ts (plan 01 §5.2/§5.4 as data; plan 05 §2
// `config/freshness`: property — for every class fresh < stale < hard, the classifier is monotone
// in age; `provisional` iff any game has statsOfficial=false; `corrections_window_open` iff < 7
// days since the last game; the host-moved hard-limit suspension (plan 01 §7)). Shape, never values.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ATTRIBUTIONS,
  CORRECTIONS_WINDOW_MS,
  DATASET_SOURCE_IDS,
  DEFAULT_TTL_CONTEXT,
  FRESHNESS_CLASS_IDS,
  FRESHNESS_TABLE,
  LICENSES,
  REFRESH_JOBS,
  SOURCE_REGISTRY,
  attributionFor,
  classifyAge,
  correctionsWindowOpen,
  freshnessClass,
  inGameWindow,
  isDatasetSourceId,
  isPeriodProvisional,
  resourceTtlMs,
  serveDecision,
  sourcesOfJob,
  stampState,
  ttlFor,
  worseFreshness,
  type FreshnessClassId,
  type FreshnessState,
  type TtlContext,
} from "../../src/config/freshness.js";
import { SOURCE_ERROR_CODES, isSourceErrorCode } from "../../src/config/freshness.js";
import { ERROR_CODES } from "../../src/mcp/errors.js";

const classes = FRESHNESS_CLASS_IDS.map((id) => FRESHNESS_TABLE[id]);
const contexts: TtlContext[] = [true, false].flatMap((inGameWindow) =>
  [true, false].flatMap((gameDay) =>
    [true, false].map((inSeason) => ({ inGameWindow, gameDay, inSeason })),
  ),
);
const rank: Record<FreshnessState, number> = { fresh: 0, stale: 1, expired: 2 };

describe("the table's shape (plan 01 A-6..A-12: shape, not values)", () => {
  it("has one frozen row per id, keyed by its own id", () => {
    expect(Object.keys(FRESHNESS_TABLE).sort()).toEqual([...FRESHNESS_CLASS_IDS].sort());
    for (const c of classes) {
      expect(FRESHNESS_TABLE[c.id].id).toBe(c.id);
      expect(Object.isFrozen(c)).toBe(true);
    }
  });
  it("every TTL variant is positive and ≤ the hard limit; beyondHard is null iff no hard limit", () => {
    for (const c of classes) {
      expect(c.beyondHard === null, c.id).toBe(c.hardLimitSeconds === null);
      if (c.basis === "immutable") {
        expect(c.ttlSeconds, c.id).toBeNull();
        continue;
      }
      for (const ctx of contexts) {
        const ttl = ttlFor(c, ctx);
        expect(ttl, c.id).not.toBeNull();
        expect(ttl, c.id).toBeGreaterThan(0);
        if (c.hardLimitSeconds !== null) expect(ttl, c.id).toBeLessThan(c.hardLimitSeconds);
      }
    }
  });
  it("ESPN classes are age- or immutable-based; datasets are release-based except the age classes", () => {
    for (const c of classes) {
      if (c.origin === "espn") expect(["age", "immutable"], c.id).toContain(c.basis);
      if (c.basis === "release") expect(c.origin, c.id).toBe("dataset");
    }
  });
  it("carries the plan 01 §5.4 key relationships", () => {
    expect(ttlFor(FRESHNESS_TABLE.espn_live, { ...DEFAULT_TTL_CONTEXT, inGameWindow: true })).toBe(
      60,
    );
    expect(ttlFor(FRESHNESS_TABLE.espn_live)).toBe(600);
    expect(ttlFor(FRESHNESS_TABLE.espn_roster, { ...DEFAULT_TTL_CONTEXT, inSeason: false })).toBe(
      3600,
    );
    expect(
      ttlFor(FRESHNESS_TABLE.espn_pro_schedule, { ...DEFAULT_TTL_CONTEXT, gameDay: true }),
    ).toBe(3600);
    expect(FRESHNESS_TABLE.nflverse_injuries.hardLimitSeconds).toBe(36 * 3600);
    expect(FRESHNESS_TABLE.lines.beyondHard).toBe("omit");
    expect(FRESHNESS_TABLE.weather.beyondHard).toBe("omit");
    expect(FRESHNESS_TABLE.news.beyondHard).toBe("omit");
    expect(FRESHNESS_TABLE.espn_settings.beyondHard).toBe("STALE_ONLY");
    expect(FRESHNESS_TABLE.espn_draft.basis).toBe("immutable");
  });
  it("throws on an unknown class id (a programming error)", () => {
    expect(() => freshnessClass("nope" as FreshnessClassId)).toThrow("freshness: unknown class");
  });
});

describe("classifyAge (property: monotone; fresh ≤ ttl < stale ≤ hard < expired)", () => {
  it("is monotone in age for every class and context", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...classes),
        fc.constantFrom(...contexts),
        fc.nat({ max: 60 * 86_400 }),
        fc.nat({ max: 60 * 86_400 }),
        (c, ctx, a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          expect(rank[classifyAge(c, lo, ctx)]).toBeLessThanOrEqual(rank[classifyAge(c, hi, ctx)]);
        },
      ),
      { numRuns: 2000 },
    );
  });
  it("hits each band at its boundaries", () => {
    const c = FRESHNESS_TABLE.espn_settings;
    expect(classifyAge(c, 0)).toBe("fresh");
    expect(classifyAge(c, 86_400)).toBe("fresh");
    expect(classifyAge(c, 86_401)).toBe("stale");
    expect(classifyAge(c, 7 * 86_400)).toBe("stale");
    expect(classifyAge(c, 7 * 86_400 + 1)).toBe("expired");
    expect(classifyAge(FRESHNESS_TABLE.crosswalk, 10 ** 9)).toBe("fresh");
  });
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, -0.5])(
    "throws on age %s (never silently fresh)",
    (age) => {
      expect(() => classifyAge(FRESHNESS_TABLE.espn_roster, age)).toThrow(RangeError);
    },
  );
});

describe("stampState: the basis picks the instant", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  it("release basis judges from the later of checked_at and fetched_at", () => {
    const st = stampState(
      FRESHNESS_TABLE.nflverse_injuries,
      {
        as_of: "2026-09-01T00:00:00Z",
        fetched_at: "2026-09-01T00:00:00Z",
        checked_at: "2026-10-05T11:00:00Z",
      },
      now,
    );
    expect(st).toEqual({ state: "fresh", basis_at: "2026-10-05T11:00:00.000Z", age_s: 3600 });
    const old = stampState(
      FRESHNESS_TABLE.nflverse_injuries,
      {
        as_of: "2026-09-01T00:00:00Z",
        fetched_at: "2026-10-05T10:00:00Z",
        checked_at: "2026-09-01T00:00:00Z",
      },
      now,
    );
    expect(old.basis_at).toBe("2026-10-05T10:00:00.000Z");
    const noCheck = stampState(
      FRESHNESS_TABLE.nflverse_injuries,
      { as_of: "2026-09-01T00:00:00Z", fetched_at: "2026-09-01T00:00:00Z", checked_at: null },
      now,
    );
    expect(noCheck.state).toBe("expired");
  });
  it("age basis ignores checked_at; a future instant (clock skew) reads age 0", () => {
    const st = stampState(
      FRESHNESS_TABLE.espn_roster,
      {
        as_of: "2026-10-05T11:59:00Z",
        fetched_at: "2026-10-05T12:00:30Z",
        checked_at: "2026-10-05T12:00:00Z",
      },
      now,
    );
    expect(st).toEqual({ state: "fresh", basis_at: "2026-10-05T12:00:30.000Z", age_s: 0 });
  });
  it("throws on a bad instant or a non-finite now", () => {
    const t = {
      as_of: "2026-10-05T11:59:00Z",
      fetched_at: "2026-10-05T11:59:00Z",
      checked_at: null,
    };
    expect(() =>
      stampState(FRESHNESS_TABLE.espn_roster, { ...t, fetched_at: "nope" }, now),
    ).toThrow(RangeError);
    expect(() => stampState(FRESHNESS_TABLE.espn_roster, { ...t, as_of: "nope" }, now)).toThrow(
      RangeError,
    );
    expect(() => stampState(FRESHNESS_TABLE.espn_roster, t, Number.NaN)).toThrow(RangeError);
  });
});

describe("serveDecision (plan 01 §5.4, §7 host_moved)", () => {
  const espn = FRESHNESS_TABLE.espn_roster;
  const dataset = FRESHNESS_TABLE.nflverse_injuries;
  const omit = FRESHNESS_TABLE.weather;
  const off = { allowStale: false, hostMoved: false };
  it("serves fresh and stale inputs with their label", () => {
    expect(serveDecision(espn, "fresh", off)).toEqual({
      outcome: "serve",
      label: "fresh",
      hardLimitSuspended: false,
    });
    expect(serveDecision(espn, "stale", off)).toEqual({
      outcome: "serve",
      label: "stale",
      hardLimitSuspended: false,
    });
  });
  it("past the hard limit: omit classes omit; STALE_ONLY unless allow_stale", () => {
    expect(serveDecision(omit, "expired", { allowStale: true, hostMoved: true }).outcome).toBe(
      "omit",
    );
    expect(serveDecision(dataset, "expired", off).outcome).toBe("stale_only");
    expect(serveDecision(dataset, "expired", { allowStale: true, hostMoved: false })).toEqual({
      outcome: "serve",
      label: "stale",
      hardLimitSuspended: false,
    });
  });
  it("host_moved suspends the hard limit for ESPN classes only", () => {
    expect(serveDecision(espn, "expired", { allowStale: false, hostMoved: true })).toEqual({
      outcome: "serve",
      label: "stale",
      hardLimitSuspended: true,
    });
    expect(serveDecision(dataset, "expired", { allowStale: false, hostMoved: true }).outcome).toBe(
      "stale_only",
    );
  });
});

describe("period helpers (research 04 §B.1.6–B.1.7)", () => {
  it("provisional iff any game is not statsOfficial (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { maxLength: 20 }), (flags) => {
        expect(isPeriodProvisional(flags.map((stats_official) => ({ stats_official })))).toBe(
          flags.includes(false),
        );
      }),
    );
  });
  it("the corrections window is open until 7 days after the last kickoff; unknown is open", () => {
    const last = Date.parse("2026-10-05T17:00:00Z");
    expect(correctionsWindowOpen(last, last + CORRECTIONS_WINDOW_MS - 1)).toBe(true);
    expect(correctionsWindowOpen(last, last + CORRECTIONS_WINDOW_MS)).toBe(false);
    expect(correctionsWindowOpen(null, last)).toBe(true);
    expect(correctionsWindowOpen(Number.NaN, last)).toBe(true);
    expect(() => correctionsWindowOpen(last, Number.NaN)).toThrow(RangeError);
  });
  it("a game window is open only for a locking, unofficial game that has kicked off", () => {
    const now = 1_000_000;
    const g = { kickoff_ms: now - 1, valid_for_locking: true, stats_official: false };
    expect(inGameWindow([g], now)).toBe(true);
    expect(inGameWindow([{ ...g, kickoff_ms: now + 1 }], now)).toBe(false);
    expect(inGameWindow([{ ...g, stats_official: true }], now)).toBe(false);
    expect(inGameWindow([{ ...g, valid_for_locking: false }], now)).toBe(false);
    expect(inGameWindow([{ ...g, kickoff_ms: null }], now)).toBe(false);
    expect(inGameWindow([], now)).toBe(false);
  });
  it("worseFreshness orders stale > provisional > fresh", () => {
    expect(worseFreshness("fresh", "provisional")).toBe("provisional");
    expect(worseFreshness("stale", "provisional")).toBe("stale");
    expect(worseFreshness("provisional", "fresh")).toBe("provisional");
  });
  it("resource TTLs are capped at a day; immutable classes get a day", () => {
    expect(resourceTtlMs(FRESHNESS_TABLE.espn_settings)).toBe(86_400_000);
    expect(resourceTtlMs(FRESHNESS_TABLE.espn_draft)).toBe(86_400_000);
    expect(resourceTtlMs(FRESHNESS_TABLE.espn_roster)).toBe(300_000);
  });
});

describe("sources, licenses, attribution (plan 01 §4.2, §9; research 04 §E)", () => {
  it("every dataset source has one registry row with a known class, license and job", () => {
    expect(Object.keys(SOURCE_REGISTRY).sort()).toEqual([...DATASET_SOURCE_IDS].sort());
    for (const id of DATASET_SOURCE_IDS) {
      const s = SOURCE_REGISTRY[id];
      expect(s.id).toBe(id);
      expect(FRESHNESS_CLASS_IDS).toContain(s.freshness);
      expect(LICENSES).toContain(s.license);
      expect(s.license).toBe(s.attribution.license);
      expect(REFRESH_JOBS).toContain(s.job);
      expect(isDatasetSourceId(id)).toBe(true);
    }
    expect(isDatasetSourceId("nflverse:nope")).toBe(false);
  });
  it("there are eleven refresh jobs and each writes at least one source", () => {
    expect(REFRESH_JOBS).toHaveLength(11);
    for (const job of REFRESH_JOBS) expect(sourcesOfJob(job).length, job).toBeGreaterThan(0);
    expect(sourcesOfJob("nflverse:daily")).toEqual([
      "nflverse:injuries",
      "nflverse:depth_charts",
      "nflverse:roster_weekly",
      "nflverse:players",
    ]);
  });
  it("the ESPN layer is labelled espn-unofficial and keeps the no-affiliation line", () => {
    expect(SOURCE_REGISTRY["espn:pro_schedule"].license).toBe("espn-unofficial");
    expect(ATTRIBUTIONS.espn_fantasy.text).toContain("not affiliated with ESPN or Disney");
    expect(SOURCE_REGISTRY["nflverse:ftn_charting"].license).toBe("CC-BY-SA-4.0");
    expect(SOURCE_REGISTRY["ffopportunity:ep_weekly"].license).toBe("CC-BY-SA-4.0");
    expect(SOURCE_REGISTRY["weather:open_meteo"].license).toBe("non-commercial");
    expect(SOURCE_REGISTRY["sleeper:trending"].license).toBe("non-commercial");
  });
  it("attributionFor: any espn:* tag → the ESPN line; dataset ids → their provider; internal → null", () => {
    expect(attributionFor("espn:mRoster")).toBe(ATTRIBUTIONS.espn_fantasy);
    expect(attributionFor("espn:projection")).toBe(ATTRIBUTIONS.espn_fantasy);
    expect(attributionFor("espn:pro_schedule")).toBe(ATTRIBUTIONS.espn_fantasy);
    expect(attributionFor("news:espn")).toBe(ATTRIBUTIONS.espn_rss);
    expect(attributionFor("nflverse:injuries")).toBe(ATTRIBUTIONS.nflverse);
    for (const tag of [
      "engine",
      "store:pool_snapshot",
      "store.recommendation_log",
      "espn:",
      "espn:9x",
      "ESPN:mRoster",
    ])
      expect(attributionFor(tag), tag).toBeNull();
  });
});

describe("CAT-15: the source error vocabulary (G1 sources[].last_error, refresh_log.error)", () => {
  it("its upper-case codes are plan 01 §4.3 codes; the rest are three refresh-only conditions", () => {
    for (const c of SOURCE_ERROR_CODES)
      if (c === c.toUpperCase()) expect(ERROR_CODES, c).toContain(c);
      else expect(["schema_mismatch", "codec", "not_published"]).toContain(c);
    expect(isSourceErrorCode("codec")).toBe(true);
    expect(isSourceErrorCode("ECONNRESET: socket hang up")).toBe(false);
    expect(isSourceErrorCode(undefined)).toBe(false);
  });
});
