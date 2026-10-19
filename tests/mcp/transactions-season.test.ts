// transactions-season.test.ts — espn_list_transactions serves the configured league-season's stored
// transactions only (plan 07 A6: ESPN's feed merged with persisted history; `history_coverage`).
// Stage C finding transactions-store-not-season-scoped: transactions_seen has no season column, and
// `eff transactions --backfill` (R6-3) appends previous seasons; A6 filtered stored rows only by
// type, team and `scoring_period !== week`, so `week: 3` returned this season's week 3 plus 2025's
// and 2024's, the default call filled `count` with previous seasons' adds, and history_coverage named
// a previous season's oldest row (gap_suspected false over a gap). Fixture mode on league-a (season
// 2026), the stored rows written as the backfill writes them; no network.
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Transaction } from "../../src/domain/league/types.js";
import { oldestInstant } from "../../src/mcp/tools/league.js";
import { seasonStartIso, seasonTransactions } from "../../src/mcp/tools/common.js";
import { call, connect, makeWorld, type World } from "./helpers/world.js";

const txn = (id: string, at: string, week: number): Transaction => ({
  transaction_id: id,
  type: "FREEAGENT",
  status: "EXECUTED",
  team_id: 1,
  team_name: null,
  scoring_period: week,
  process_date: at,
  proposed_date: at,
  bid_amount: null,
  items: [],
  related_transaction_id: null,
  note: null,
});

let world: World;
let client: Client;
let close: () => Promise<void>;

/** Five 2025 week-3 adds (as the backfill stores them) and two of this season's (2026) older rows. */
const PREV = Array.from({ length: 5 }, (_, i) =>
  txn(`prev2025-${String(i)}`, `2025-09-2${String(i)}T10:00:00.000Z`, 3),
);
const CUR = [
  txn("cur2026-0", "2026-09-24T10:00:00.000Z", 3),
  txn("cur2026-1", "2026-09-17T10:00:00.000Z", 2),
];

type J = Record<string, unknown>;
interface Txns {
  transactions: { transaction_id: string; scoring_period: number | null }[];
  history_coverage: { oldest_seen: string | null; gap_suspected: boolean };
}

beforeAll(async () => {
  world = await makeWorld({ league: "league-a" });
  world.store.repos.transactionsSeen.appendNew([...PREV, ...CUR], world.clock.nowIso());
  ({ client, close } = await connect(world));
}, 120_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

async function ok(args: J): Promise<Txns> {
  const r = await call(client, "espn_list_transactions", args);
  if (r.isError) throw new Error(JSON.stringify(r.body).slice(0, 400));
  return r.body.data as Txns;
}

describe("A6 is season-scoped (Stage C transactions-store-not-season-scoped)", () => {
  it("week 3 means this season's week 3: no 2025 row, this season's stored week-3 row kept", async () => {
    const d = await ok({ week: 3, count: 50 });
    const ids = d.transactions.map((t) => t.transaction_id);
    expect(ids.filter((id) => id.startsWith("prev2025"))).toEqual([]);
    expect(ids).toContain("cur2026-0");
    expect(ids).not.toContain("cur2026-1"); // week 2
  });

  it("the default call never fills its page with a previous season's adds", async () => {
    const d = await ok({ count: 50 });
    const ids = d.transactions.map((t) => t.transaction_id);
    expect(ids.filter((id) => id.startsWith("prev2025"))).toEqual([]);
    expect(ids).toEqual(expect.arrayContaining(["cur2026-0", "cur2026-1"]));
  });

  it("history_coverage describes this season's stored history, not the backfilled 2025 rows", async () => {
    const d = await ok({ count: 50 });
    expect(d.history_coverage.oldest_seen).toBe("2026-09-17T10:00:00.000Z");
    // asking for history before this season's oldest stored row is a suspected gap
    const early = await ok({ count: 50, since: "2026-09-01T00:00:00.000Z" });
    expect(early.history_coverage.gap_suspected).toBe(true);
    expect(early.transactions.map((t) => t.transaction_id)).not.toContain("prev2025-0");
  });
});

describe("the season window (units)", () => {
  it("seasonStartIso is the March 1 boundary seasonOfInstant uses", () => {
    expect(seasonStartIso(2026)).toBe("2026-03-01T00:00:00.000Z");
  });

  it("seasonTransactions reads one season's window and honours since", () => {
    const rows = [...PREV, ...CUR].sort(
      (a, b) => Date.parse(b.process_date ?? "") - Date.parse(a.process_date ?? ""),
    );
    const seen = {
      listRange: (from: string, until: string, limit: number) =>
        rows
          .filter((t) => {
            const at = Date.parse(t.process_date ?? "");
            return at >= Date.parse(from) && at < Date.parse(until);
          })
          .slice(0, limit),
    };
    expect(seasonTransactions(seen, 2026, null).rows.map((t) => t.transaction_id)).toEqual([
      "cur2026-0",
      "cur2026-1",
    ]);
    expect(
      seasonTransactions(seen, 2026, "2026-09-20T00:00:00.000Z").rows.map((t) => t.transaction_id),
    ).toEqual(["cur2026-0"]);
    expect(seasonTransactions(seen, 2025, null).rows).toHaveLength(5);
    expect(seasonTransactions(seen, 2026, "2027-04-01T00:00:00.000Z").rows).toEqual([]);
    expect(oldestInstant(seasonTransactions(seen, 2026, null).rows)).toBe(
      "2026-09-17T10:00:00.000Z",
    );
    expect(oldestInstant([])).toBeNull();
  });
});
