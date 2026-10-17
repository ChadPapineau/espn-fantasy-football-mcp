// waivers-history-read.test.ts — how E5 reads the league's own previous seasons (Stage C finding
// waivers-previous-season-feed-not-populated; changelog R6-3; plan 03 §1.2's stall bound). Each
// season is read whole through its own [March 1, March 1) window (`listRange`), never the newest-
// first page of `list` that a full current season fills; and every season's read waits for a turn
// of its own (`pace`): a full season (5 000 stored rows) costs 16–21 ms to read and parse, so three
// in one turn would pass the 50 ms bound. The tool-level R6-3 cases are
// tests/backtest/waivers-history-tool.test.ts.
import { describe, expect, it } from "vitest";
import type { IsoInstant, Transaction } from "../../src/domain/league/types.js";
import { TRANSACTIONS_RANGE_MAX } from "../../src/domain/league/types.js";
import { HISTORY_SCAN_SEASONS, storedSeasons } from "../../src/mcp/tools/analytics.js";

const txn = (id: string, at: string): Transaction => ({
  transaction_id: id,
  type: "WAIVER",
  status: "EXECUTED",
  team_id: 1,
  team_name: null,
  scoring_period: 3,
  process_date: at,
  proposed_date: null,
  bid_amount: null,
  items: [],
  related_transaction_id: null,
  note: null,
});

/** An in-memory store of `rows` that logs every read and every pace into `events`. */
function seenOf(rows: readonly Transaction[], events: string[]) {
  return {
    listRange(from: IsoInstant, until: IsoInstant, limit: number): readonly Transaction[] {
      events.push(`read ${from.slice(0, 4)}`);
      const a = Date.parse(from);
      const b = Date.parse(until);
      return rows
        .filter((t) => {
          const at = Date.parse(t.process_date ?? "");
          return at >= a && at < b;
        })
        .slice(0, limit);
    },
    oldestSeen(): IsoInstant | null {
      const all = rows.map((t) => t.process_date ?? "").sort();
      return all[0] ?? null;
    },
  };
}

describe("E5's previous-season read (R6-3)", () => {
  const rows = [
    ...[2023, 2024, 2025, 2026].flatMap((s) =>
      Array.from({ length: 5 }, (_, i) =>
        txn(`t${String(s)}-${String(i)}`, new Date(Date.UTC(s, 8, 10 + i)).toISOString()),
      ),
    ),
  ];

  it("reads each season through its own window: the current one and the newest previous ones", async () => {
    const events: string[] = [];
    const out = await storedSeasons(seenOf(rows, events), 2026, [], () => Promise.resolve());
    expect(out.current.map((t) => t.transaction_id).sort()).toEqual(
      Array.from({ length: 5 }, (_, i) => `t2026-${String(i)}`),
    );
    expect(out.previous.map((p) => p.season)).toEqual([2025, 2024]);
    expect(out.previous.every((p) => p.transactions.length === 5)).toBe(true);
    expect(HISTORY_SCAN_SEASONS).toBeGreaterThanOrEqual(2);
  });

  it("every season's read waits for a turn of its own (never two reads in one turn)", async () => {
    const events: string[] = [];
    await storedSeasons(seenOf(rows, events), 2026, [], () => {
      events.push("pace");
      return Promise.resolve();
    });
    const reads = events.filter((e) => e.startsWith("read"));
    expect(reads.length).toBe(3);
    for (const [i, e] of events.entries())
      if (e.startsWith("read")) expect(events[i - 1], `before ${e}`).toBe("pace");
  });

  it("a season at the read's bound is said", async () => {
    const big = Array.from({ length: TRANSACTIONS_RANGE_MAX }, (_, i) =>
      txn(`b${String(i)}`, new Date(Date.UTC(2025, 8, 10) + i * 1000).toISOString()),
    );
    const warnings: string[] = [];
    await storedSeasons(seenOf(big, []), 2026, warnings, () => Promise.resolve());
    expect(warnings).toContain(
      `season 2025: only its newest ${String(TRANSACTIONS_RANGE_MAX)} stored transactions are read`,
    );
  });
});
