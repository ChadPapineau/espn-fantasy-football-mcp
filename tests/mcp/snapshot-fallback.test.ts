// snapshot-fallback.test.ts — the nightly snapshots that stand in for a failed ESPN read (plan 01 §5.4,
// §7; plan 07 B1, C2 degradation) obey the hard limit the cache path enforces and never serve another
// season's week. Stage C finding players-pool-snapshot-fallback-unbounded: espn_list_players served
// poolSnapshots.latestTwo()[0] with no age, week or season check and no allow_stale requirement — a
// 393-day-old previous-season pool came back as "last night's" while a 2-day-old cache entry was
// refused STALE_ONLY — and rostersOf checked only the week. Fixture mode on league-a; ESPN's reads
// fail through the fault helper (no network).
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { coded, faulty } from "./helpers/faults.js";
import { T0, call, connect, makeWorld, type World } from "./helpers/world.js";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const T0_MS = Date.parse(T0);

let world: World;
let client: Client;
let close: () => Promise<void>;
let poolPage: readonly unknown[];

type J = Record<string, unknown>;
const at = (ms: number): string => new Date(ms).toISOString();

beforeAll(async () => {
  world = await makeWorld({ league: "league-a" });
  const page = await world.services.platform.listPlayers(
    world.services.league,
    { status: "AVAILABLE", position: null, sort: "percOwned", week: 4, injured: null },
    { limit: 25, offset: 0 },
  );
  poolPage = page.value.items;
  const s = faulty(world.services, {
    listPlayers: coded("ESPN_UPSTREAM_UNAVAILABLE", { view: "kona_player_info" }),
    getRosters: coded("ESPN_UPSTREAM_UNAVAILABLE", { view: "mRoster" }),
  });
  ({ client, close } = await connect(world, { services: s }));
  await call(client, "espn_get_league");
}, 120_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

/** Stores the newest pool snapshot (latestTwo()[0] is the one taken last). */
function poolSnapshot(takenMs: number, week: number): void {
  world.store.repos.poolSnapshots.put({
    taken_at: at(takenMs),
    week,
    players: poolPage as never,
  });
}

describe("espn_list_players' pool-snapshot fallback", () => {
  // latestTwo() reads the newest snapshot by taken_at: each case stores a newer one than the last
  it("a previous season's snapshot (393 days old) is never served — not even with allow_stale", async () => {
    poolSnapshot(T0_MS - 393 * DAY, 4);
    for (const args of [{ week: 4 }, { week: 4, allow_stale: true }]) {
      const r = await call(client, "espn_list_players", { limit: 5, ...args });
      expect(r.isError).toBe(true);
      expect((r.body.error as J).code).toBe("ESPN_UPSTREAM_UNAVAILABLE");
    }
  });

  it("past the 24 h hard limit: STALE_ONLY without allow_stale, served expired with it", async () => {
    poolSnapshot(T0_MS - 2 * DAY, 4);
    const refused = await call(client, "espn_list_players", { limit: 5, week: 4 });
    expect(refused.isError).toBe(true);
    expect((refused.body.error as J).code).toBe("STALE_ONLY");
    const served = await call(client, "espn_list_players", {
      limit: 5,
      week: 4,
      allow_stale: true,
    });
    expect(served.isError).toBe(false);
    expect(served.body.warnings as string[]).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^source store:pool_snapshot is 2d old \(expired\)$/),
      ]),
    );
  });

  it("another week's snapshot is never served as this week's pool", async () => {
    poolSnapshot(T0_MS - 2 * HOUR, 3);
    const r = await call(client, "espn_list_players", { limit: 5, week: 4, allow_stale: true });
    expect(r.isError).toBe(true);
    expect((r.body.error as J).code).toBe("ESPN_UPSTREAM_UNAVAILABLE");
  });

  it("a snapshot of this week taken an hour ago: served stale, dated, never 'last night's'", async () => {
    const taken = T0_MS - HOUR;
    poolSnapshot(taken, 4);
    const r = await call(client, "espn_list_players", { limit: 5, week: 4 });
    expect(r.isError).toBe(false);
    expect((r.body.meta as J).freshness).toBe("stale");
    expect(r.body.partial).toBe(true);
    expect(r.body.warnings as string[]).toContain(
      `espn:kona_player_info unavailable: served from the week 4 pool snapshot taken ${at(taken)} (stale)`,
    );
  });
});

describe("espn_get_roster's roster-snapshot fallback", () => {
  async function rosterSnapshot(takenMs: number, week: number): Promise<void> {
    const got = await world.services.platform.getRoster(
      { league: world.services.league, team_id: 1 },
      3,
    );
    world.store.repos.rosterSnapshots.put({
      team_id: 1,
      week,
      taken_at: at(takenMs),
      roster: got.value,
    });
  }

  it("a previous season's week-3 snapshot is never served", async () => {
    await rosterSnapshot(T0_MS - 370 * DAY, 3);
    const r = await call(client, "espn_get_roster", { week: 3, allow_stale: true });
    expect(r.isError).toBe(true);
    expect((r.body.error as J).code).toBe("ESPN_UPSTREAM_UNAVAILABLE");
  });

  it("past 24 h: STALE_ONLY unless allow_stale; hours old: served stale and dated", async () => {
    await rosterSnapshot(T0_MS - 3 * DAY, 3);
    const refused = await call(client, "espn_get_roster", { week: 3 });
    expect(refused.isError).toBe(true);
    expect((refused.body.error as J).code).toBe("STALE_ONLY");
    const served = await call(client, "espn_get_roster", { week: 3, allow_stale: true });
    expect(served.isError).toBe(false);
    const taken = T0_MS - 5 * HOUR;
    await rosterSnapshot(taken, 3);
    const fresh = await call(client, "espn_get_roster", { week: 3 });
    expect(fresh.isError).toBe(false);
    expect(fresh.body.warnings as string[]).toContain(
      `espn:mRoster unavailable: served from the week 3 roster snapshot taken ${at(taken)} (stale)`,
    );
  });
});
