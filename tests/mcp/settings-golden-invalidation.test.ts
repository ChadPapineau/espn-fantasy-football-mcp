// settings-golden-invalidation.test.ts — a golden computed in process that finds a league-wide
// mismatch marks the league settings cache dirty (plan 08 §6 step 3(d): "only when share > 10 % …:
// the league's settings cache is marked dirty (plan 01 §5.2 invalidation)"; §9 "Invalidation
// triggers … the E6 > 10 % rule"). espn_get_box_score scores every player-week under the cached
// settings and checks each against ESPN's appliedTotal; on a league-wide mismatch it warned and kept
// the settings for the rest of their 24 h TTL — a commissioner's scoring edit, the likeliest cause,
// stayed unseen (Stage C finding cache-settings-invalidation-triggers-missing; the provider's half —
// the nightly verdict and the status instants — is held in tests/providers/espn/
// settings-invalidation.test.ts). Settings ESPN answered during the call are current: a re-read would
// change nothing, so a persistent mismatch re-reads them once, never every call. League-a in fixture
// mode (weeks 1–3 final); the settings the golden scores with are rescaled to force the mismatch.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScoringSettings } from "../../src/domain/scoring/types.js";
import type { LeagueRef, Stamped } from "../../src/providers/platform.js";
import { SETTINGS_REREAD_WARNING, settingsCachedBefore } from "../../src/mcp/tools/league.js";
import { faulty } from "./helpers/faults.js";
import { call, connect, makeWorld, type World } from "./helpers/world.js";

let world: World;
beforeAll(async () => {
  world = await makeWorld();
}, 120_000);
afterAll(() => {
  world.cleanup();
});

/** Every rule worth twice its points: nobody's engine total reproduces ESPN's appliedTotal. */
function doubled(s: ScoringSettings): ScoringSettings {
  return {
    ...s,
    rules: s.rules.map((r) => ({
      ...r,
      points: r.points * 2,
      overrides: Object.fromEntries(Object.entries(r.overrides).map(([k, v]) => [k, v * 2])),
    })),
  };
}

/** A box score over services whose settings are mis-scored and stamped `fetchedAt` (ms → ISO). */
async function boxScore(fetchedAt: (nowMs: number) => number) {
  const invalidated: LeagueRef[] = [];
  // every settings read answers from one cached entry: each is stamped alike
  const restamp =
    () =>
    async (real: (...a: unknown[]) => Promise<unknown>, ...args: unknown[]): Promise<unknown> => {
      const got = (await real(...args)) as Stamped<unknown>;
      return {
        ...got,
        stamp: {
          ...got.stamp,
          fetched_at: new Date(fetchedAt(world.clock.nowMs())).toISOString(),
        },
      };
    };
  const s = faulty(world.services, {
    getLeague: restamp(),
    getRosterSlots: restamp(),
    getLeagueRules: restamp(),
    getScoringSettings: async (real, ...args) => {
      const got = (await real(...args)) as Stamped<ScoringSettings>;
      return {
        value: doubled(got.value),
        stamp: {
          ...got.stamp,
          fetched_at: new Date(fetchedAt(world.clock.nowMs())).toISOString(),
        },
      };
    },
    invalidateSettings: (real, ...args) => {
      invalidated.push(args[0] as LeagueRef);
      return real(...args);
    },
  });
  const c = await connect(world, { services: s });
  try {
    await call(c.client, "espn_get_league");
    const r = await call(c.client, "espn_get_box_score", { week: 3, all_matchups: true });
    expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
    return { warnings: r.body.warnings as string[], invalidated };
  } finally {
    await c.close();
  }
}

describe("a league-wide golden mismatch marks the cached settings dirty (Stage C cache-settings-invalidation-triggers-missing)", () => {
  it("scored with a copy fetched before the call: the settings are invalidated once and the next read asks ESPN", async () => {
    const got = await boxScore((now) => now - 3_600_000);
    expect(got.warnings.some((w) => w.startsWith("scoring mismatch on more than 10%"))).toBe(true);
    expect(got.warnings).toContain(SETTINGS_REREAD_WARNING);
    expect(got.invalidated).toEqual([world.services.league]);
    // the provider's own bookkeeping: the next settings read of any process asks ESPN again
    const before = world.requests.length;
    await world.services.platform.getScoringSettings(world.services.league);
    expect(world.requests.slice(before).some((u) => u.includes("view=mSettings"))).toBe(true);
  }, 120_000);

  it("scored with settings ESPN answered during the call: no invalidation — a re-read would change nothing", async () => {
    const got = await boxScore((now) => now + 1000);
    expect(got.warnings.some((w) => w.startsWith("scoring mismatch on more than 10%"))).toBe(true);
    expect(got.warnings).not.toContain(SETTINGS_REREAD_WARNING);
    expect(got.invalidated).toEqual([]);
  }, 120_000);

  it("control: settings that reproduce ESPN invalidate nothing", async () => {
    const invalidated: unknown[] = [];
    const s = faulty(world.services, {
      invalidateSettings: (real, ...args) => {
        invalidated.push(args[0]);
        return real(...args);
      },
    });
    const c = await connect(world, { services: s });
    try {
      const r = await call(c.client, "espn_get_box_score", { week: 3, all_matchups: true });
      expect(r.isError).toBe(false);
      expect(r.body.warnings).not.toContain(SETTINGS_REREAD_WARNING);
      expect(invalidated).toEqual([]);
    } finally {
      await c.close();
    }
  }, 120_000);

  it("settingsCachedBefore reads the settings inputs only, by their fetch instant", () => {
    const at = (iso: string, source = "espn:mSettings") =>
      ({ source, as_of: iso, fetched_at: iso, basis_at: iso, state: "fresh" }) as const;
    const start = Date.parse("2026-10-06T12:00:00.000Z");
    expect(settingsCachedBefore([at("2026-10-06T11:00:00.000Z")], start)).toBe(true);
    expect(settingsCachedBefore([at("2026-10-06T12:00:01.000Z")], start)).toBe(false);
    expect(settingsCachedBefore([at("2026-10-06T11:00:00.000Z", "espn:mBoxscore")], start)).toBe(
      false,
    );
    expect(settingsCachedBefore([], start)).toBe(false);
  });
});
