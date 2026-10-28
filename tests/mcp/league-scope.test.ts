// league-scope.test.ts — the tools read this league's stored records only (migration 003;
// StoreOpenOptions.league; the composition roots open the store for the configured ESPN_LEAGUE_ID).
// Stage C finding store-not-league-scoped, the finding's own shape: one store file holds another
// league's rows — its transactions, an ESPN projection snapshot, roster and pool snapshots and an open
// check, written as its jobs would under another configured league id — and this league's tools answer
// exactly as on a store without them. Before, A6 merged the other league's moves under this league's
// team ids (and history_coverage read its oldest row), C3 flagged revisions nobody made against the
// other league's snapshot, the snapshot stand-ins could serve its team-N roster, and its open checks
// stayed open here. League-a under id 0 in fixture mode; no network.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Transaction } from "../../src/domain/league/types.js";
import { storeFactory } from "../../src/store/index.js";
import type { Store } from "../../src/store/types.js";
import { backupDir, datasetDir, storePath } from "../../src/config/paths.js";
import { call, connect, makeWorld, type World } from "./helpers/world.js";

const OTHER = "11111";
let world: World;
let other: Store;
beforeAll(async () => {
  world = await makeWorld({ env: { EFF_TOOLSET: "full" } });
  other = storeFactory.open({
    path: storePath(world.cache),
    datasetDir: datasetDir(world.cache),
    backupDir: backupDir(world.cache),
    clock: world.clock,
    migrate: true,
    league: OTHER,
  });
}, 120_000);
afterAll(() => {
  other.close();
  world.cleanup();
});

/** The tools' answers that stored records feed, on this world's store as it is now. */
async function answers() {
  const { client, close } = await connect(world, { options: { toolset: "full" } });
  try {
    await call(client, "espn_get_league");
    const a6 = await call(client, "espn_list_transactions", { count: 100 });
    expect(a6.isError, JSON.stringify(a6.body).slice(0, 300)).toBe(false);
    // players of the recorded pool page (C3 reads them by id through it)
    const pool = await call(client, "espn_list_players", { status: "ONTEAM", limit: 20 });
    const ids = (pool.body.data as { players: { player_id: number }[] }).players
      .map((p) => p.player_id)
      .filter((id) => id > 0)
      .slice(0, 5);
    expect(ids.length).toBeGreaterThan(0);
    const c3 = await call(client, "espn_get_projections", {
      players: { player_ids: ids },
      horizon: "week",
    });
    expect(c3.isError, JSON.stringify(c3.body).slice(0, 300)).toBe(false);
    const status = await call(client, "espn_get_status", { include_checks: true });
    return {
      ids,
      transactions: (
        a6.body.data as { transactions: { transaction_id: string }[] }
      ).transactions.map((x) => x.transaction_id),
      coverage: (a6.body.data as { history_coverage: unknown }).history_coverage,
      revised: (
        c3.body.data as { projections: { player_id: number; revised_recently: boolean }[] }
      ).projections.map((p) => [p.player_id, p.revised_recently]),
      checks:
        (status.body.data as { checks: { id: string }[] | null }).checks?.map((c) => c.id) ?? null,
    };
  } finally {
    await close();
  }
}

const txn = (id: string, team: number, processed: string): Transaction => ({
  transaction_id: id,
  type: "FREEAGENT",
  status: "EXECUTED",
  team_id: team,
  team_name: null,
  scoring_period: 3,
  process_date: processed,
  proposed_date: null,
  bid_amount: 0,
  items: [],
  related_transaction_id: null,
  note: null,
});

describe("another league's stored records never reach this league's tools (Stage C store-not-league-scoped)", () => {
  it("A6, C3, the status checks: identical answers with the other league's rows in the store", async () => {
    const before = await answers();
    const now = world.clock.nowMs();
    const iso = (ms: number): string => new Date(ms).toISOString();
    // the other league's history, under this league's team ids, older than anything stored here
    other.repos.transactionsSeen.appendNew(
      Array.from({ length: 12 }, (_, i) =>
        txn(`other-${String(i)}`, 1 + (i % 4), iso(now - (20 + i) * 86_400_000)),
      ),
      iso(now - 86_400_000),
    );
    // its ESPN projections two days ago, far from this league's numbers (C3's revision basis)
    other.repos.espnProjections.putMany(
      before.ids.map((id) => ({
        player_id: id,
        season: 2026,
        week: 4,
        split: "weekly" as const,
        applied_total: 99,
        stats_raw: {},
        snapshot_at: iso(now - 2 * 86_400_000),
      })),
    );
    // its nightly snapshots of team 1 and its pool, and an open check
    other.repos.rosterSnapshots.put({
      team_id: 1,
      week: 4,
      taken_at: iso(now - 3_600_000),
      roster: { entries: [] } as never,
    });
    other.repos.poolSnapshots.put({ taken_at: iso(now - 3_600_000), week: 4, players: [] });
    other.repos.leagueSettings.raiseCheck({
      id: "ir_invalid",
      status: "warn",
      detail: { team_id: 1 },
      raised_at: iso(now - 3_600_000),
      settings_hash: null,
      acknowledged: false,
      acknowledged_at: null,
      acknowledged_by: null,
    });
    const after = await answers();
    expect(before.checks).toEqual([]);
    expect(after.transactions.some((id) => id.startsWith("other-"))).toBe(false);
    expect(after).toEqual(before);
    // the other league still reads its own
    expect(other.repos.transactionsSeen.list(null, 100)).toHaveLength(12);
    expect(other.repos.leagueSettings.openChecks().map((c) => c.id)).toEqual(["ir_invalid"]);
    expect(world.store.repos.rosterSnapshots.latestTwo(1)).toEqual([]);
  }, 180_000);
});
