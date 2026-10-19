// gameday-ttl.test.ts — game-day TTLs apply to every input the tools judge (plan 01 §5.2: the pro
// schedule's lock and final flags 1 h on a game day [A-9], schedules and lines 30 min [A-12]).
// Stage C finding freshness-gameday-ttl-never-applied: every dataset stamp went through
// stampToInput(stamp, nowMs) with no TTL context, so the default TTLs always applied — a schedule
// refresh that stopped on a Sunday was labelled fresh for 6 h — and the provider's own game-day test
// compared UTC dates, reading the TNF Thursday as no game day and the Friday after as one. Units
// over synthetic games, then one tool through the real composition root (fixture mode, no network).
import { describe, expect, it } from "vitest";
import type { DatasetStamp } from "../../src/domain/analytics/types.js";
import type { ProGame } from "../../src/domain/league/types.js";
import {
  datasetInput,
  easternDate,
  optionalDataset,
  ttlContextAt,
  ttlContextOf,
} from "../../src/mcp/tools/common.js";
import { call, connect, makeWorld } from "./helpers/world.js";

const game = (kickoff: string, over: Partial<ProGame> = {}): ProGame => ({
  espn_game_id: 1,
  season: 2026,
  week: 6,
  kickoff,
  start_time_tbd: false,
  valid_for_locking: true,
  stats_official: false,
  home_pro_team_id: 1,
  away_pro_team_id: 2,
  ...over,
});

/** A dataset stamp of `cls` fetched (and checked) at `at`. */
const stamp = (cls: DatasetStamp["freshness_class"], at: string): DatasetStamp =>
  ({
    source: cls === "espn_pro_schedule" ? "espn:pro_schedule" : "nflverse:schedules",
    as_of: at,
    fetched_at: at,
    checked_at: at,
    freshness_class: cls,
    file_version: "v1",
  }) as unknown as DatasetStamp;

/** A call context whose stored schedule is `games`. */
const ctxOf = (games: readonly ProGame[], nowMs: number) => ({
  nowMs,
  memo: new Map<string, unknown>(),
  services: {
    league: { season: 2026 },
    datasets: { proSchedule: { games: () => ({ rows: games, stamp: null }) } },
  } as never,
});

describe("the TTL context (Stage C freshness-gameday-ttl-never-applied)", () => {
  // Thursday night football, 20:15 ET on 2026-10-15 = 00:15 UTC on Friday the 16th
  const tnf = [game("2026-10-16T00:15:00.000Z")];

  it("a game day is the NFL's (US-Eastern) calendar day: the TNF Thursday, not the Friday after", () => {
    expect(easternDate(Date.parse("2026-10-16T00:15:00.000Z"))).toBe("2026-10-15");
    expect(ttlContextAt(tnf, Date.parse("2026-10-15T17:00:00.000Z")).gameDay).toBe(true);
    expect(ttlContextAt(tnf, Date.parse("2026-10-16T17:00:00.000Z")).gameDay).toBe(false);
    expect(ttlContextAt([], Date.parse("2026-10-15T17:00:00.000Z"))).toEqual({
      inGameWindow: false,
      gameDay: false,
      inSeason: true,
    });
  });

  it("a game window is open from kickoff until the stats are official", () => {
    expect(ttlContextAt(tnf, Date.parse("2026-10-16T01:00:00.000Z")).inGameWindow).toBe(true);
    expect(
      ttlContextAt(
        [game("2026-10-16T00:15:00.000Z", { stats_official: true })],
        Date.parse("2026-10-16T01:00:00.000Z"),
      ).inGameWindow,
    ).toBe(false);
  });

  it("on a Sunday the 2.5 h-old schedule (1 h) and nflverse schedules (30 min) are stale; on a bare instant they read fresh", () => {
    const sunday = [game("2026-10-11T17:00:00.000Z")];
    const now = Date.parse("2026-10-11T16:00:00.000Z"); // 12:00 ET
    const at = new Date(now - 2.5 * 3600 * 1000).toISOString();
    const ctx = ctxOf(sunday, now);
    expect(ttlContextOf(ctx).gameDay).toBe(true);
    for (const cls of ["espn_pro_schedule", "nflverse_schedules"] as const) {
      expect(datasetInput(stamp(cls, at), ctx, false)?.state, cls).toBe("stale");
      // the default context (no call) keeps the 6 h TTLs — the call's context is what changes
      expect(datasetInput(stamp(cls, at), now, false)?.state, cls).toBe("fresh");
    }
    // the optional reader judges the same way
    expect(
      optionalDataset({ rows: [], stamp: stamp("nflverse_schedules", at) }, ctx, false)?.state,
    ).toBe("stale");
  });
});

describe("a tool on a game day (the composition root's stored schedule)", () => {
  it("espn_get_roster on Sunday labels a 2.5 h-old pro schedule stale", async () => {
    // the datasets are published at 13:30 UTC on Sunday 2026-10-11 (a week-5 game day), read at 16:00
    const world = await makeWorld({ league: "league-a", clock: "2026-10-11T13:30:00.000Z" });
    try {
      world.clock.set("2026-10-11T16:00:00.000Z");
      const c = await connect(world);
      const r = await call(c.client, "espn_get_roster", { week: 4 });
      expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
      expect(r.body.warnings as string[]).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^source espn:pro_schedule is 2h old \(stale\)$/),
        ]),
      );
      expect((r.body.meta as { freshness: string }).freshness).toBe("stale");
      await c.close();
    } finally {
      world.cleanup();
    }
  }, 60_000);
});
