// league-scope.test.ts — every league-specific record names its league (migration 003; src/store/
// migrations/003_league_scope.ts; StoreOpenOptions.league). Stage C finding store-not-league-scoped:
// the store is shared by every process on the Mac and ESPN_LEAGUE_ID can change on it, but
// transactions_seen, espn_projection, projection, the roster / pool / scoreboard snapshots and checks
// had no league column and their repositories took none — after a switch every tool read the other
// league's rows as this one's. Here two stores are opened on ONE file for two leagues: each reads
// its own rows only, a collision on the old primary key (the same transaction id, the same instant)
// keeps both leagues' rows, a store opened for no league reads nothing and refuses to write, and a v2
// store migrates with its rows attributed to its one league (or to none when it named several).
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StoredProjection } from "../../src/domain/analytics/types.js";
import type { CheckRow, Transaction } from "../../src/domain/league/types.js";
import { applyMigrations, MIGRATIONS } from "../../src/store/migrations/index.js";
import { storeLeagueOf } from "../../src/store/migrations/003_league_scope.js";
import {
  LEAGUE_SCOPED_TABLES,
  StoreLeagueUnboundError,
  type Store,
} from "../../src/store/types.js";
import { openStore, tempCache, type TempCache } from "./helpers/env.js";

let t: TempCache;
const open: Store[] = [];
beforeEach(() => {
  t = tempCache();
});
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  t.cleanup();
});

const A = "11111";
const B = "22222";
const at = (h: number): string =>
  new Date(Date.parse("2026-10-06T00:00:00.000Z") + h * 3_600_000).toISOString();
function storeFor(league: string | null): Store {
  const s = openStore(t, { league });
  open.push(s);
  return s;
}

const txn = (id: string, processed: string): Transaction => ({
  transaction_id: id,
  type: "WAIVER",
  status: "EXECUTED",
  team_id: 2,
  team_name: null,
  scoring_period: 4,
  process_date: processed,
  proposed_date: null,
  bid_amount: 7,
  items: [],
  related_transaction_id: null,
  note: null,
});
const line = {
  values: { pass_yd: 250 },
  present: ["pass_yd"],
  position: 1 as never,
  position_class: "O" as const,
  provisional: false,
  source: "projection:v1-ensemble",
};
const proj = (made: string, mean: number): StoredProjection => ({
  player_id: 9000001,
  gsis_id: "00-9000001",
  season: 2026,
  week: 5,
  model_version: "v1-ensemble",
  made_at: made,
  inputs_as_of: made,
  expectation: { pass_yd: mean },
  samples: [line],
});
const snap = (atIso: string, total: number) => ({
  player_id: 4569587,
  season: 2026,
  week: 5,
  split: "weekly" as const,
  applied_total: total,
  stats_raw: { "3": 250.5 },
  snapshot_at: atIso,
});
const check = (raised: string): CheckRow => ({
  id: "ir_invalid",
  status: "warn",
  detail: { team_id: 1 },
  raised_at: raised,
  settings_hash: null,
  acknowledged: false,
  acknowledged_at: null,
  acknowledged_by: null,
});

describe("one store file, two leagues: each reads its own records only (Stage C store-not-league-scoped)", () => {
  it("transactions: the same id in both leagues is two rows; list, listRange and oldestSeen are per league", () => {
    const a = storeFor(A);
    const b = storeFor(B);
    expect(a.repos.transactionsSeen.appendNew([txn("t1", at(1)), txn("t2", at(2))], at(3))).toBe(2);
    // the same id under league B is B's own row, never ignored as already seen
    expect(b.repos.transactionsSeen.appendNew([txn("t1", at(5))], at(6))).toBe(1);
    expect(a.repos.transactionsSeen.list(null, 10).map((x) => x.transaction_id)).toEqual([
      "t2",
      "t1",
    ]);
    expect(
      b.repos.transactionsSeen.list(null, 10).map((x) => [x.transaction_id, x.process_date]),
    ).toEqual([["t1", at(5)]]);
    expect(b.repos.transactionsSeen.listRange(at(0), at(4), 10)).toEqual([]);
    expect(a.repos.transactionsSeen.oldestSeen()).toBe(at(1));
    expect(b.repos.transactionsSeen.oldestSeen()).toBe(at(5));
  });

  it("snapshots: roster, pool and scoreboard are per league", () => {
    const a = storeFor(A);
    const b = storeFor(B);
    a.repos.rosterSnapshots.put({
      team_id: 1,
      week: 5,
      taken_at: at(1),
      roster: { entries: [] } as never,
    });
    a.repos.poolSnapshots.put({ taken_at: at(1), week: 5, players: [] });
    a.repos.scoreboardSnapshots.put({
      week: 5,
      taken_at: at(1),
      matchups: [],
      playoff_pct_espn: {},
    });
    expect(b.repos.rosterSnapshots.latestTwo(1)).toEqual([]);
    expect(b.repos.poolSnapshots.latestTwo()).toEqual([]);
    expect(b.repos.scoreboardSnapshots.forWeek(5)).toEqual([]);
    b.repos.rosterSnapshots.put({
      team_id: 1,
      week: 5,
      taken_at: at(2),
      roster: { entries: [] } as never,
    });
    expect(b.repos.rosterSnapshots.latestTwo(1).map((x) => x.taken_at)).toEqual([at(2)]);
    expect(a.repos.rosterSnapshots.latestTwo(1).map((x) => x.taken_at)).toEqual([at(1)]);
    expect(a.repos.poolSnapshots.latestTwo()).toHaveLength(1);
    expect(a.repos.scoreboardSnapshots.forWeek(5)).toHaveLength(1);
  });

  it("projections: ESPN's snapshots and ours, at one instant in both leagues, are each league's own", () => {
    const a = storeFor(A);
    const b = storeFor(B);
    expect(a.repos.espnProjections.putMany([snap(at(1), 4.514)])).toBe(1);
    expect(b.repos.espnProjections.asOf(2026, 5, at(9))).toEqual([]);
    expect(b.repos.espnProjections.lastSnapshotAt()).toBeNull();
    // the same instant under B (a fixed clock): B's own row, never ignored as a duplicate
    expect(b.repos.espnProjections.putMany([snap(at(1), 6.969)])).toBe(1);
    expect(b.repos.espnProjections.asOf(2026, 5, at(9)).map((x) => x.applied_total)).toEqual([
      6.969,
    ]);
    expect(a.repos.espnProjections.asOf(2026, 5, at(9)).map((x) => x.applied_total)).toEqual([
      4.514,
    ]);
    expect(a.repos.projections.put(proj(at(1), 250))).toEqual({ written: true });
    expect(b.repos.projections.latest(9000001, 2026, 5, "v1-ensemble")).toBeNull();
    expect(b.repos.projections.getAsOf(9000001, 2026, 5, "v1-ensemble", at(9))).toBeNull();
    b.repos.projections.put(proj(at(1), 300));
    expect(b.repos.projections.latest(9000001, 2026, 5, "v1-ensemble")?.expectation).toEqual({
      pass_yd: 300,
    });
    expect(a.repos.projections.latest(9000001, 2026, 5, "v1-ensemble")?.expectation).toEqual({
      pass_yd: 250,
    });
  });

  it("checks: open and acknowledged per league; settings_changed goes to the settings' own league", () => {
    const a = storeFor(A);
    const b = storeFor(B);
    a.repos.leagueSettings.raiseCheck(check(at(1)));
    expect(b.repos.leagueSettings.openChecks()).toEqual([]);
    // the same check id at the same instant in B is B's own
    b.repos.leagueSettings.raiseCheck(check(at(1)));
    expect(b.repos.leagueSettings.acknowledgeChecks("ir_invalid", at(2), "doctor", at(2))).toBe(1);
    expect(b.repos.leagueSettings.openChecks()).toEqual([]);
    expect(a.repos.leagueSettings.openChecks().map((c) => c.id)).toEqual(["ir_invalid"]);
  });

  it("a store opened for no league reads none of them and refuses to write one", () => {
    storeFor(A).repos.transactionsSeen.appendNew([txn("t1", at(1))], at(2));
    const none = storeFor(null);
    expect(none.repos.transactionsSeen.list(null, 10)).toEqual([]);
    expect(none.repos.transactionsSeen.oldestSeen()).toBeNull();
    expect(none.repos.leagueSettings.openChecks()).toEqual([]);
    expect(none.repos.espnProjections.lastSnapshotAt()).toBeNull();
    for (const write of [
      () => none.repos.transactionsSeen.appendNew([txn("t9", at(1))], at(2)),
      () => {
        none.repos.rosterSnapshots.put({
          team_id: 1,
          week: 5,
          taken_at: at(1),
          roster: {} as never,
        });
      },
      () => {
        none.repos.poolSnapshots.put({ taken_at: at(1), week: 5, players: [] });
      },
      () => {
        none.repos.scoreboardSnapshots.put({
          week: 5,
          taken_at: at(1),
          matchups: [],
          playoff_pct_espn: {},
        });
      },
      () => none.repos.espnProjections.putMany([snap(at(1), 1)]),
      () => none.repos.projections.put(proj(at(1), 1)),
      () => {
        none.repos.leagueSettings.raiseCheck(check(at(1)));
      },
    ])
      expect(write).toThrow(StoreLeagueUnboundError);
    // and a league that is not an ESPN league id is refused at open
    expect(() => openStore(t, { league: "not a league" })).toThrow(RangeError);
  });
});

describe("migration 003 attributes a v2 store's rows to its one league", () => {
  /** A store at v2 with one row in every league-scoped table and `leagues` named in league_settings. */
  function v2Store(leagues: readonly string[]): void {
    // a v2 binary's store (0600, its directories 0700), then the rows it held
    openStore(t, { league: null }, { migrations: MIGRATIONS.slice(0, 2) }).close();
    const db = new DatabaseSync(t.storePath);
    for (const [i, l] of leagues.entries())
      db.prepare(
        "INSERT INTO league_settings (league_id, season, settings_hash, scoring_json, slots_json, rules_json, fetched_at, fetched_ms) VALUES (?, 2026, ?, '{}', '{}', '{}', ?, ?)",
      ).run(l, String(i).padStart(64, "0"), at(0), Date.parse(at(0)));
    db.prepare(
      "INSERT INTO transactions_seen (transaction_id, ts, ts_ms, seen_at, seen_ms, txn_json) VALUES ('t1', ?, ?, ?, ?, ?)",
    ).run(at(1), Date.parse(at(1)), at(1), Date.parse(at(1)), JSON.stringify(txn("t1", at(1))));
    db.prepare(
      "INSERT INTO roster_snapshot (team_id, week, taken_at, taken_ms, roster_json) VALUES (1, 5, ?, ?, '{\"entries\":[]}')",
    ).run(at(1), Date.parse(at(1)));
    db.prepare(
      "INSERT INTO checks (id, raised_at, raised_ms, status, detail_json, settings_hash, acknowledged, acknowledged_at, acknowledged_by) VALUES ('ir_invalid', ?, ?, 'warn', '{}', NULL, 0, NULL, NULL)",
    ).run(at(1), Date.parse(at(1)));
    db.close();
  }

  it("one league named: its history stays its own (the owner's single-league install)", () => {
    v2Store([A]);
    const a = storeFor(A);
    expect(a.schemaVersion).toBe(3);
    expect(a.repos.transactionsSeen.list(null, 10).map((x) => x.transaction_id)).toEqual(["t1"]);
    expect(a.repos.rosterSnapshots.latestTwo(1)).toHaveLength(1);
    expect(a.repos.leagueSettings.openChecks()).toHaveLength(1);
    expect(storeFor(B).repos.transactionsSeen.list(null, 10)).toEqual([]);
  });

  it("several leagues named: no league can claim the rows — none reads them, none is deleted", () => {
    v2Store([A, B]);
    for (const l of [A, B]) {
      const s = storeFor(l);
      expect(s.repos.transactionsSeen.list(null, 10)).toEqual([]);
      expect(s.repos.rosterSnapshots.latestTwo(1)).toEqual([]);
      expect(s.repos.leagueSettings.openChecks()).toEqual([]);
    }
    const db = new DatabaseSync(t.storePath, { readOnly: true });
    try {
      for (const table of ["transactions_seen", "roster_snapshot", "checks"])
        expect(
          db.prepare(`SELECT league_id AS l, COUNT(*) AS n FROM ${table} GROUP BY league_id`).all(),
          table,
        ).toEqual([{ l: "", n: 1 }]);
    } finally {
      db.close();
    }
  });

  it("storeLeagueOf reads the league-keyed tables; every scoped table carries league_id", () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db, MIGRATIONS, () => at(0));
    expect(storeLeagueOf(db)).toBeNull();
    db.prepare(
      "INSERT INTO waiver_run (league_id, season, run_at, run_ms, w, surplus_json, updated_at) VALUES (?, 2026, ?, 1, 12, '[]', ?)",
    ).run(A, at(0), at(0));
    expect(storeLeagueOf(db)).toBe(A);
    db.prepare(
      "INSERT INTO recommendation_log (log_id, league_id, season, week, kind, recorded_at, recorded_ms, settings_hash, client_ref, record_json) VALUES ('r1', ?, 2026, 1, 'lineup', ?, 1, ?, NULL, '{}')",
    ).run(B, at(0), "a".repeat(64));
    expect(storeLeagueOf(db)).toBeNull();
    for (const table of LEAGUE_SCOPED_TABLES) {
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
        (c) => c.name,
      );
      expect(cols, table).toContain("league_id");
    }
    db.close();
  });
});
