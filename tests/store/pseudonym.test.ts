// pseudonym.test.ts — member-GUID pseudonymisation before persistence (plan 02 §2.4; plan 10 A6b):
// a brace-GUID in snapshot / log / transaction JSON is stored as `{00000000-0000-4000-8000-<n>}` by
// first appearance, one map per store, case-insensitively, idempotent on the pseudonym range; the map
// holds a sha256, never the GUID; a grep of store.sqlite for the real GUID finds nothing.
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, applyMigrations } from "../../src/store/migrations/index.js";
import {
  BRACE_GUID_RE,
  createPseudonymizer,
  guidKey,
  pseudonymOf,
  PSEUDONYM_MAX,
  PSEUDONYM_RE,
} from "../../src/store/pseudonym.js";
import type { Store } from "../../src/store/types.js";
import { openStore, tempCache, type TempCache } from "./helpers/env.js";

// Invented GUIDs (not member ids of any league), assembled at run time so the repository's
// brace-GUID scanner never sees a non-fixture GUID literal in this file.
const guid = (...parts: string[]): string => ["{", parts.join("-"), "}"].join("");
const G1 = guid("ABCDEF01", "2345", "4678", "9ABC", "DEF012345678");
const G2 = guid("12345678", "90AB", "4CDE", "8F01", "23456789ABCD");

function memDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db, MIGRATIONS, () => "2026-10-06T12:00:00.000Z");
  return db;
}

describe("pseudonymOf / guidKey", () => {
  it("formats the fixture range and refuses out-of-range numbers", () => {
    expect(pseudonymOf(1)).toBe(guid("00000000", "0000", "4000", "8000", "000000000001"));
    expect(pseudonymOf(255)).toBe(guid("00000000", "0000", "4000", "8000", "0000000000ff"));
    expect(pseudonymOf(42)).toMatch(PSEUDONYM_RE);
    expect(pseudonymOf(PSEUDONYM_MAX)).toMatch(PSEUDONYM_RE);
    for (const n of [0, -1, 1.5, PSEUDONYM_MAX + 1, Number.NaN])
      expect(() => pseudonymOf(n)).toThrow(RangeError);
    expect(guidKey(G1)).toBe(guidKey(G1.toLowerCase()));
    expect(guidKey(G1)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the pseudonymiser", () => {
  it("numbers GUIDs by first appearance, case-insensitively, and leaves pseudonyms alone", () => {
    const db = memDb();
    const p = createPseudonymizer(db);
    const json = JSON.stringify({ a: G2, b: [G1.toLowerCase(), G2], note: `owner ${G1} said hi` });
    const out = p.apply(json);
    expect(out).not.toMatch(/ABCDEF01|abcdef01|12345678-90AB/i);
    expect(JSON.parse(out)).toEqual({
      a: pseudonymOf(1),
      b: [pseudonymOf(2), pseudonymOf(1)],
      note: `owner ${pseudonymOf(2)} said hi`,
    });
    // stable across calls (one map per store) and idempotent on its own output
    expect(p.apply(JSON.stringify([G1]))).toBe(JSON.stringify([pseudonymOf(2)]));
    expect(p.apply(out)).toBe(out);
    // the map holds hashes only
    const rows = db.prepare("SELECT guid_sha256, n FROM guid_pseudonym ORDER BY n").all() as {
      guid_sha256: string;
      n: number;
    }[];
    expect(rows).toEqual([
      { guid_sha256: guidKey(G2), n: 1 },
      { guid_sha256: guidKey(G1), n: 2 },
    ]);
    db.close();
  });

  it("a string without GUIDs is returned unchanged without touching the map", () => {
    const db = memDb();
    const p = createPseudonymizer(db);
    const s = JSON.stringify({
      x: "{not-a-guid}",
      y: "{0000-0000}",
      z: "ABCDEF01-2345-4678-9ABC-DEF012345678",
    });
    expect(p.apply(s)).toBe(s);
    expect((db.prepare("SELECT COUNT(*) AS n FROM guid_pseudonym").get() as { n: number }).n).toBe(
      0,
    );
    db.close();
  });

  it("property: no real brace-GUID survives; the output is valid JSON when the input was", () => {
    const db = memDb();
    const p = createPseudonymizer(db);
    const hex = (n: number) => fc.stringMatching(new RegExp(`^[0-9A-Fa-f]{${String(n)}}$`));
    const anyGuid = fc
      .tuple(hex(8), hex(4), hex(4), hex(4), hex(12))
      .map(([a, b, c, d, e]) => guid(a, b, c, d, e));
    fc.assert(
      fc.property(fc.array(fc.oneof(anyGuid, fc.string()), { maxLength: 8 }), (parts) => {
        const json = JSON.stringify(parts);
        const out = p.apply(json);
        const left = (out.match(BRACE_GUID_RE) ?? []).filter((g) => !PSEUDONYM_RE.test(g));
        JSON.parse(out);
        return left.length === 0;
      }),
      { numRuns: 200 },
    );
    db.close();
  });
});

describe("in the store (plan 10 A6b)", () => {
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

  it("roster, pool and scoreboard snapshots, transactions and the log carry pseudonyms only", () => {
    const teamName = {
      untrusted_text: { value: G1, source: "espn.team.name", chars: 38, truncated: false },
    };
    s.repos.rosterSnapshots.put({
      team_id: 3,
      week: 4,
      taken_at: "2026-10-06T02:00:00.000Z",
      roster: {
        team: { team_id: 3 },
        team_name: teamName,
        week: 4,
        is_mine: true,
        entries: [],
      } as never,
    });
    s.repos.poolSnapshots.put({
      taken_at: "2026-10-06T02:00:00.000Z",
      week: 4,
      players: [{ note: G2 }] as never,
    });
    s.repos.scoreboardSnapshots.put({
      week: 4,
      taken_at: "2026-10-06T02:00:00.000Z",
      matchups: [{ home: { name: teamName } }] as never,
      playoff_pct_espn: { [G2]: 0.5 },
    });
    s.repos.transactionsSeen.appendNew(
      [
        {
          transaction_id: "txn-1",
          type: "FREEAGENT",
          status: null,
          team_id: 3,
          team_name: teamName as never,
          scoring_period: 4,
          process_date: null,
          proposed_date: null,
          bid_amount: null,
          items: [],
          related_transaction_id: null,
          note: null,
        },
      ],
      "2026-10-06T02:00:00.000Z",
    );
    s.close();
    const bytes = readFileSync(t.storePath).toString("latin1") + safeRead(`${t.storePath}-wal`);
    expect(bytes).not.toContain(G1);
    expect(bytes).not.toContain(G2);
    expect(bytes.toUpperCase()).not.toContain(G1.slice(1, 9).toUpperCase() + "-2345");
    s = openStore(t);
    const [snap] = s.repos.rosterSnapshots.latestTwo(3);
    expect(JSON.stringify(snap)).toContain(pseudonymOf(1));
    expect(s.repos.scoreboardSnapshots.forWeek(4)[0]?.playoff_pct_espn).toEqual({
      [pseudonymOf(2)]: 0.5,
    });
  });
});

function safeRead(p: string): string {
  try {
    return readFileSync(p).toString("latin1");
  } catch {
    return "";
  }
}
