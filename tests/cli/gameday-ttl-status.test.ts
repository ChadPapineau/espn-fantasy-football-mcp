// gameday-ttl-status.test.ts — Stage C finding freshness-gameday-ttl-never-applied, the two call
// sites outside src/mcp (plan 01 §5.2: the pro schedule's lock and final flags 1 h on a game day
// [A-9], schedules and lines 30 min [A-12]). `eff status` / `eff doctor` judged every dataset source
// with the default TTL context, so on a Sunday a 2.5 h-old schedule printed `fresh` while
// espn_get_status said `stale`; the provider's own context (src/services ttlContextFrom) compared
// UTC dates, reading the TNF Thursday as no game day and the Friday after as one. Both now judge
// under config's one ttlContextAt. Fixture world (no network); the datasets are published through
// the real runner, so refresh_log holds the rows `eff status` reads.
import { describe, expect, it } from "vitest";
import { sourceStatuses, storeTtlContext } from "../../src/cli/status.js";
import { ttlContextAt } from "../../src/config/freshness.js";
import type { ProGame } from "../../src/domain/league/types.js";
import { ttlContextFrom } from "../../src/services/index.js";
import type { Store } from "../../src/store/types.js";
import { makeWorld } from "../mcp/helpers/world.js";

const game = (kickoff: string): ProGame => ({
  espn_game_id: 1,
  season: 2026,
  week: 6,
  kickoff,
  start_time_tbd: false,
  valid_for_locking: true,
  stats_official: false,
  home_pro_team_id: 1,
  away_pro_team_id: 2,
});

/** A store whose stored pro schedule is `games` (all the TTL context reads). */
const storeOf = (games: readonly ProGame[]): Store =>
  ({
    datasets: { proSchedule: { games: () => ({ rows: games, stamp: null }) } },
  }) as unknown as Store;

describe("the provider's TTL context (src/services ttlContextFrom)", () => {
  // Thursday night football, 20:15 ET on 2026-10-15 = 00:15 UTC on Friday the 16th
  const tnf = [game("2026-10-16T00:15:00.000Z")];

  it("a game day is the NFL's (US-Eastern) day: the TNF Thursday, not the Friday after", () => {
    for (const [at, gameDay] of [
      ["2026-10-15T17:00:00.000Z", true],
      ["2026-10-16T17:00:00.000Z", false],
    ] as const) {
      const ctx = ttlContextFrom(storeOf(tnf), 2026, { nowMs: () => Date.parse(at) } as never);
      expect(ctx().gameDay, at).toBe(gameDay);
      // the same context the tools and eff status judge under
      expect(ctx()).toEqual(ttlContextAt(tnf, Date.parse(at)));
    }
  });

  it("an unreadable schedule is the default context, never an error", () => {
    const broken = {
      datasets: {
        proSchedule: {
          games: () => {
            throw new Error("db");
          },
        },
      },
    } as unknown as Store;
    const ctx = ttlContextFrom(broken, 2026, { nowMs: () => 0 } as never);
    expect(ctx()).toEqual({ inGameWindow: false, gameDay: false, inSeason: true });
    expect(storeTtlContext(broken, 2026, 0)).toEqual(ctx());
  });
});

describe("eff status / eff doctor judge sources under the store's TTL context", () => {
  it.each([
    // published 13:30 UTC, read 16:00 UTC (12:00 ET): 2.5 h old
    ["Sunday 2026-10-11, a game day", "stale", "2026-10-11"],
    ["Saturday 2026-10-10, no game", "fresh", "2026-10-10"],
  ] as const)(
    "%s: a 2.5 h-old pro schedule and nflverse schedules are %s",
    async (_l, want, day) => {
      const world = await makeWorld({
        league: "league-a",
        clock: `${day}T13:30:00.000Z`,
        publishNflverse: true,
      });
      try {
        world.clock.set(`${day}T16:00:00.000Z`);
        const now = world.clock.nowMs();
        expect(storeTtlContext(world.store, world.config.season, now).gameDay).toBe(
          want === "stale",
        );
        const rows = sourceStatuses(world.store, world.config, now);
        for (const id of ["espn:pro_schedule", "nflverse:schedules"] as const) {
          const r = rows.find((x) => x.source === id);
          // about 2.5 h (the clock ticks while the fixtures are published)
          expect(Math.abs((r?.age_s ?? 0) - 9000), id).toBeLessThan(60);
          expect(r?.state, id).toBe(want);
        }
      } finally {
        world.cleanup();
      }
    },
    120_000,
  );
});
