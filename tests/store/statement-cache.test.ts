// statement-cache.test.ts — the guard's statement cache (src/store/sqlite.ts cachedGet/cachedAll/
// cachedRun; plan 03 §1.2 the stall bound, plan 05 §2 the statement trace). Every repository
// statement is prepared once per connection instead of per lookup (E13 prepared ~2,576 per call at
// 552e3d3, and freeing them was most of the young-generation pause CI read as stall growth). The
// cache must never weaken the guard: nothing prepared, cached or run through it while `bypass`
// lifts the authorizer; a statement reused only on the connection, label and mode it was prepared
// under; no cache outliving its connection or a dataset's re-open; a trace that still sees every
// statement run while tracing; no reuse of a statement while its own run is under way; no option or
// parameter leaking between runs; a bounded size; no large bound value kept by a cached statement
// (SQLite keeps a statement's last bindings after its reset: a cached espn_cache INSERT held its
// last 4 MiB parsed_json for the life of the connection); a bypass refused by a closed handle that
// lifts nothing.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { constants as C, DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cachedAll,
  cachedGet,
  cachedRun,
  isDatasetObject,
  isWriteAction,
  StatementGuard,
  type GuardMode,
} from "../../src/store/sqlite.js";
import { nflPlayersReaderOf, statementGuardOf, storeInternalsOf } from "../../src/store/store.js";
import type { DatasetPublisher, EspnCacheEntry, Store } from "../../src/store/types.js";
import {
  emptyTables,
  injuriesTables,
  nflPlayersTables,
  playersTables,
  proScheduleTables,
  publishTables,
  rosterWeeklyTables,
  schedulesTables,
  statsTables,
  weatherTables,
} from "./helpers/datasets.js";
import { openPublisher, openStore, T0, tempCache, type TempCache } from "./helpers/env.js";

const SEL = "SELECT b FROM t WHERE a = ?";
const INS = "INSERT INTO t (a, b) VALUES (?, ?)";

/** A guarded in-memory connection over `t (a, b)` (three rows) and every prepare it makes. */
function guarded(
  mode: GuardMode = "store",
  label = "store",
): {
  db: DatabaseSync;
  guard: StatementGuard;
  prepares: () => string[];
  statementsOf: (sql: string) => StatementSync[];
} {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE t (a INTEGER PRIMARY KEY, b INTEGER); INSERT INTO t VALUES (1,10),(2,20),(3,30)",
  );
  const guard = new StatementGuard();
  guard.install(db, label, mode);
  const spy = vi.spyOn(db, "prepare");
  return {
    db,
    guard,
    prepares: () => spy.mock.calls.map((c) => c[0]),
    statementsOf: (sql) => preparedOf(spy, sql),
  };
}

/** Every statement `spy` (a db.prepare spy) saw prepared for `sql`, in order. */
function preparedOf(
  spy: { mock: { calls: unknown[][]; results: { type: string; value: unknown }[] } },
  sql: string,
): StatementSync[] {
  return spy.mock.results.flatMap((r, i) =>
    r.type === "return" && spy.mock.calls[i]?.[0] === sql ? [r.value as StatementSync] : [],
  );
}

const count = (xs: readonly string[], sql: string): number => xs.filter((x) => x === sql).length;

describe("each statement prepared once per connection", () => {
  it("reuses one statement for every run of a SQL text", () => {
    const { db, guard, prepares } = guarded();
    for (let i = 0; i < 100; i++) expect(cachedGet(db, SEL, 2)).toEqual({ b: 20 });
    expect(cachedAll(db, "SELECT a FROM t ORDER BY a")).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
    expect(cachedRun(db, INS, 4, 40).changes).toBe(1);
    expect(cachedGet(db, SEL, 4)).toEqual({ b: 40 });
    expect(prepares()).toEqual([SEL, "SELECT a FROM t ORDER BY a", INS]);
    expect(guard.cachedSql(db)).toEqual(["SELECT a FROM t ORDER BY a", INS, SEL]);
  });

  it("an unguarded connection prepares per run, as before the cache", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (a INTEGER PRIMARY KEY, b INTEGER); INSERT INTO t VALUES (1, 10)");
    const spy = vi.spyOn(db, "prepare");
    for (let i = 0; i < 3; i++) expect(cachedGet(db, SEL, 1)).toEqual({ b: 10 });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("a guard asked to run on a connection it does not hold prepares per run, and caches nothing", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (a INTEGER PRIMARY KEY, b INTEGER); INSERT INTO t VALUES (1, 10)");
    const guard = new StatementGuard();
    const spy = vi.spyOn(db, "prepare");
    for (let i = 0; i < 2; i++) expect(guard.execute(db, SEL, "get", [1])).toEqual({ b: 10 });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(guard.cachedSql(db)).toEqual([]);
  });

  it("two connections of one guard never share a statement", () => {
    const a = guarded();
    const b = new DatabaseSync(":memory:");
    b.exec("CREATE TABLE t (a INTEGER PRIMARY KEY, b INTEGER); INSERT INTO t VALUES (2, 99)");
    a.guard.install(b, "other", "store");
    const spyB = vi.spyOn(b, "prepare");
    expect(cachedGet(a.db, SEL, 2)).toEqual({ b: 20 });
    expect(cachedGet(b, SEL, 2)).toEqual({ b: 99 });
    expect(cachedGet(a.db, SEL, 2)).toEqual({ b: 20 });
    expect(cachedGet(b, SEL, 2)).toEqual({ b: 99 });
    expect(count(a.prepares(), SEL)).toBe(1);
    expect(spyB).toHaveBeenCalledTimes(1);
  });

  it("a denied or failing prepare caches nothing and is decided again on the next run", () => {
    const { db, guard, prepares } = guarded("dataset", "src");
    expect(() => cachedRun(db, INS, 9, 9)).toThrow(/not authorized/);
    expect(() => cachedRun(db, INS, 9, 9)).toThrow(/not authorized/);
    expect(() => cachedGet(db, "SELEKT 1")).toThrow(/syntax error/);
    expect(guard.cachedSql(db)).toEqual([]);
    expect(count(prepares(), INS)).toBe(2);
    expect(cachedGet(db, "SELECT COUNT(*) AS n FROM t")).toEqual({ n: 3 });
  });
});

describe("the guard is never weakened (a)", () => {
  it("nothing runs from the cache while bypass lifts the guard; nothing prepared under it is cached", () => {
    const { db, guard, prepares } = guarded();
    expect(cachedGet(db, SEL, 1)).toEqual({ b: 10 });
    const sneak = "INSERT INTO ds_sneak (x) VALUES (1)";
    guard.bypass(db, () => {
      // the cached statement is not run, and nothing new is prepared through the cache
      expect(() => cachedGet(db, SEL, 1)).toThrow(/guard is lifted/);
      expect(() => cachedRun(db, sneak)).toThrow(/guard is lifted/);
      // what bypass is for runs on raw statements (here a ds_* table VACUUM INTO-like work makes)
      db.exec("CREATE TABLE ds_sneak (x INTEGER)");
      db.prepare(sneak).run();
    });
    expect(guard.cachedSql(db)).toEqual([SEL]);
    // the authorizer is back: the text prepared under bypass is prepared again, and denied
    expect(() => cachedRun(db, sneak)).toThrow(/not authorized/);
    expect(guard.cachedSql(db)).toEqual([SEL]);
    expect(count(prepares(), sneak)).toBe(2); // the raw one under bypass, the denied one after
    expect(cachedGet(db, SEL, 1)).toEqual({ b: 10 });
    expect(count(prepares(), SEL)).toBe(1); // the cache survives the bypass
    // a nested bypass keeps the outer one lifted for the cache
    guard.bypass(db, () => {
      guard.bypass(db, () => undefined);
      expect(() => cachedGet(db, SEL, 1)).toThrow(/guard is lifted/);
    });
    expect(cachedGet(db, SEL, 1)).toEqual({ b: 10 });
  });

  it("a re-install under another mode or label drops the cache: a write cached as `store` never runs as `dataset`", () => {
    const { db, guard, prepares } = guarded();
    expect(cachedRun(db, INS, 4, 40).changes).toBe(1);
    // the same label and mode keep it
    guard.install(db, "store", "store");
    expect(guard.cachedSql(db)).toEqual([INS]);
    guard.install(db, "store", "dataset");
    expect(guard.cachedSql(db)).toEqual([]);
    expect(() => cachedRun(db, INS, 5, 50)).toThrow(/not authorized/);
    expect(cachedGet(db, "SELECT COUNT(*) AS n FROM t")).toEqual({ n: 4 });
    // another label: dropped too (the trace names the connection by it)
    guard.install(db, "store", "store");
    expect(cachedRun(db, INS, 5, 50).changes).toBe(1);
    guard.install(db, "renamed", "store");
    expect(guard.cachedSql(db)).toEqual([]);
    expect(count(prepares(), INS)).toBe(3);
  });

  it("a connection installed into another guard leaves the first one's cache", () => {
    const { db, guard: first, prepares } = guarded();
    expect(cachedGet(db, SEL, 1)).toEqual({ b: 10 });
    const second = new StatementGuard();
    second.install(db, "store", "store");
    expect(first.cachedSql(db)).toEqual([]);
    second.startTrace();
    expect(cachedGet(db, SEL, 1)).toEqual({ b: 10 });
    expect(second.stopTrace().some((e) => e.object === "t")).toBe(true);
    expect(second.cachedSql(db)).toEqual([SEL]);
    // forgetting it in the first guard (no longer its holder) leaves the second's cache alone
    first.forget(db);
    expect(second.cachedSql(db)).toEqual([SEL]);
    expect(cachedGet(db, SEL, 1)).toEqual({ b: 10 });
    expect(count(prepares(), SEL)).toBe(2);
  });

  describe("the end of a bypass re-arms what the connection holds then, not what it lifted", () => {
    it("re-installed inside it under another label and mode: the authorizer is the new record's", () => {
      const { db, guard } = guarded();
      expect(cachedRun(db, INS, 4, 40).changes).toBe(1);
      guard.bypass(db, () => {
        guard.install(db, "relabelled", "dataset");
      });
      // the record (and its cache) is dataset now: so is the authorizer, and a write is denied
      expect(guard.cachedSql(db)).toEqual([]);
      guard.startTrace();
      expect(() => cachedRun(db, "INSERT INTO t (a, b) VALUES (9, 90)")).toThrow(/not authorized/);
      expect(cachedGet(db, SEL, 4)).toEqual({ b: 40 });
      const trace = guard.stopTrace();
      expect(trace.length).toBeGreaterThan(0);
      expect(trace.every((e) => e.connection === "relabelled")).toBe(true);
      expect(trace.some((e) => e.action === C.SQLITE_INSERT && e.denied)).toBe(true);
      expect(guard.cachedSql(db)).toEqual([SEL]);
      expect(cachedGet(db, "SELECT COUNT(*) AS n FROM t")).toEqual({ n: 4 });
      // a later install under the same label and mode keeps a cache that never held the write
      guard.install(db, "relabelled", "dataset");
      expect(guard.cachedSql(db)).not.toContain("INSERT INTO t (a, b) VALUES (9, 90)");
    });

    it("re-installed inside it the other way (dataset to store): traced under the new label", () => {
      const { db, guard } = guarded("dataset", "src");
      guard.bypass(db, () => {
        guard.install(db, "store", "store");
      });
      guard.startTrace();
      expect(cachedRun(db, INS, 5, 50).changes).toBe(1);
      expect(() => cachedRun(db, "CREATE TABLE ds_x (x INTEGER)")).toThrow(/not authorized/);
      const trace = guard.stopTrace();
      expect(trace.length).toBeGreaterThan(0);
      expect(trace.every((e) => e.connection === "store")).toBe(true);
    });

    it("taken by another guard inside it: the other guard's authorizer stays", () => {
      const { db, guard: first } = guarded();
      const second = new StatementGuard();
      first.bypass(db, () => {
        second.install(db, "src", "dataset");
      });
      expect(first.cachedSql(db)).toEqual([]);
      first.startTrace();
      second.startTrace();
      expect(() => cachedRun(db, INS, 6, 60)).toThrow(/not authorized/);
      expect(cachedGet(db, SEL, 1)).toEqual({ b: 10 });
      expect(first.stopTrace()).toEqual([]);
      const trace = second.stopTrace();
      expect(trace.some((e) => e.action === C.SQLITE_INSERT && e.denied)).toBe(true);
      expect(trace.every((e) => e.connection === "src")).toBe(true);
      expect(second.cachedSql(db)).toEqual([SEL]);
    });

    it("forgotten inside it (still open): the authorizer lifted comes back, as after any forget", () => {
      const { db, guard } = guarded();
      expect(cachedGet(db, SEL, 1)).toEqual({ b: 10 });
      guard.bypass(db, () => {
        guard.forget(db);
      });
      expect(guard.cachedSql(db)).toEqual([]);
      expect(() => db.prepare("CREATE TABLE ds_x (x INTEGER)")).toThrow(/not authorized/);
      expect(() => cachedRun(db, "CREATE TABLE ds_x (x INTEGER)")).toThrow(/not authorized/);
      expect(guard.cachedSql(db)).toEqual([]);
    });

    it("closed inside it, forgotten or not: nothing is re-armed on the closed handle, fn's own outcome stands", () => {
      const a = guarded();
      expect(
        a.guard.bypass(a.db, () => {
          a.guard.forget(a.db);
          a.db.close();
          return "closed";
        }),
      ).toBe("closed");
      expect(a.guard.cachedSql(a.db)).toEqual([]);
      const b = guarded();
      expect(cachedGet(b.db, SEL, 1)).toEqual({ b: 10 });
      expect(() =>
        b.guard.bypass(b.db, () => {
          b.db.close();
          throw new Error("fn failed");
        }),
      ).toThrow(/fn failed/);
      expect(() => cachedGet(b.db, SEL, 1)).toThrow(/database is not open/);
      expect(b.guard.cachedSql(b.db)).toEqual([]);
    });
  });

  it("forget drops the cache; the connection then prepares per run", () => {
    const { db, guard, prepares } = guarded();
    cachedGet(db, SEL, 1);
    guard.forget(db);
    expect(guard.cachedSql(db)).toEqual([]);
    expect(cachedGet(db, SEL, 1)).toEqual({ b: 10 });
    expect(cachedGet(db, SEL, 1)).toEqual({ b: 10 });
    expect(count(prepares(), SEL)).toBe(3);
  });

  it("a closed connection's statement is never used, and the cache is dropped", () => {
    const { db, guard } = guarded();
    cachedGet(db, SEL, 1);
    db.close();
    expect(() => cachedGet(db, SEL, 1)).toThrow(/database is not open/);
    expect(guard.cachedSql(db)).toEqual([]);
  });

  describe("on a file", () => {
    let dir = "";
    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), "eff-stmt-cache-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("closed and re-opened under the cache (one object): prepared per run, never cached again", () => {
      const db = new DatabaseSync(path.join(dir, "x.sqlite"));
      db.exec("CREATE TABLE t (a INTEGER PRIMARY KEY, b INTEGER); INSERT INTO t VALUES (1, 10)");
      const guard = new StatementGuard();
      guard.install(db, "store", "store");
      const spy = vi.spyOn(db, "prepare");
      expect(cachedGet(db, SEL, 1)).toEqual({ b: 10 });
      db.close();
      db.open();
      // the cached statement was finalized by the close: this run prepares its own
      expect(cachedGet(db, SEL, 1)).toEqual({ b: 10 });
      expect(guard.cachedSql(db)).toEqual([]);
      expect(cachedGet(db, SEL, 1)).toEqual({ b: 10 });
      expect(guard.cachedSql(db)).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(3);
      db.close();
    });

    it("closed and re-opened, a text never cached before is not cached on the unguarded handle", () => {
      const db = new DatabaseSync(path.join(dir, "y.sqlite"));
      db.exec("CREATE TABLE t (a INTEGER PRIMARY KEY, b INTEGER); INSERT INTO t VALUES (1, 10)");
      const guard = new StatementGuard();
      guard.install(db, "store", "store");
      expect(cachedGet(db, SEL, 1)).toEqual({ b: 10 });
      db.close();
      // a miss while closed: node:sqlite's own refusal, and the cache is retired
      expect(() => cachedGet(db, "SELECT COUNT(*) AS n FROM t")).toThrow(/database is not open/);
      db.open();
      guard.startTrace();
      expect(cachedGet(db, "SELECT a FROM t")).toEqual({ a: 1 });
      expect(guard.cachedSql(db)).toEqual([]);
      // (the re-opened handle carries no authorizer: nothing it prepares is in the trace)
      expect(guard.stopTrace()).toEqual([]);
      db.close();
    });

    it("a bypass refused by a closed handle (still installed) lifts nothing: no run then reads 'the guard is lifted'", () => {
      const db = new DatabaseSync(path.join(dir, "b.sqlite"));
      db.exec("CREATE TABLE t (a INTEGER PRIMARY KEY, b INTEGER); INSERT INTO t VALUES (1, 10)");
      const guard = new StatementGuard();
      guard.install(db, "store", "store");
      expect(cachedGet(db, SEL, 1)).toEqual({ b: 10 });
      db.close();
      let ran = 0;
      // node:sqlite refuses the lift on a closed handle: fn never runs, and nothing stays lifted
      expect(() => guard.bypass(db, () => (ran += 1))).toThrow(/database is not open/);
      expect(ran).toBe(0);
      expect(() => cachedGet(db, SEL, 1)).toThrow(/database is not open/);
      // re-opened (no re-install): per run on the unguarded handle, never refused as lifted
      db.open();
      const spy = vi.spyOn(db, "prepare");
      expect(cachedGet(db, SEL, 1)).toEqual({ b: 10 });
      expect(cachedGet(db, SEL, 1)).toEqual({ b: 10 });
      expect(spy).toHaveBeenCalledTimes(2);
      expect(guard.cachedSql(db)).toEqual([]);
      // a bypass that closes the handle and then nests another: the refused inner one lifts
      // nothing, the outer one's end brings the count back to 0
      expect(() => {
        guard.bypass(db, () => {
          db.close();
          guard.bypass(db, () => {
            ran += 1;
          });
        });
      }).toThrow(/database is not open/);
      expect(ran).toBe(0);
      db.open();
      expect(cachedGet(db, SEL, 1)).toEqual({ b: 10 });
      expect(spy).toHaveBeenCalledTimes(3);
      // a re-install guards and caches again, and its bypass lifts and ends as ever
      guard.install(db, "store", "store");
      guard.bypass(db, () => {
        expect(() => cachedGet(db, SEL, 1)).toThrow(/guard is lifted/);
      });
      expect(cachedGet(db, SEL, 1)).toEqual({ b: 10 });
      expect(cachedGet(db, SEL, 1)).toEqual({ b: 10 });
      expect(guard.cachedSql(db)).toEqual([SEL]);
      expect(spy).toHaveBeenCalledTimes(5); // the install's sentinel, and SEL once
      expect(() => cachedRun(db, "CREATE TABLE ds_x (x INTEGER)")).toThrow(/not authorized/);
      db.close();
    });

    it("re-opened without any run between, the first miss is not cached either; a re-install guards and caches again", () => {
      const db = new DatabaseSync(path.join(dir, "z.sqlite"));
      db.exec("CREATE TABLE t (a INTEGER PRIMARY KEY, b INTEGER); INSERT INTO t VALUES (1, 10)");
      const guard = new StatementGuard();
      guard.install(db, "store", "store");
      expect(cachedGet(db, SEL, 1)).toEqual({ b: 10 });
      db.close();
      db.open();
      expect(cachedGet(db, "SELECT a FROM t")).toEqual({ a: 1 });
      expect(guard.cachedSql(db)).toEqual([]);
      // the same label and mode on the new handle: a new cache, under the authorizer again
      guard.install(db, "store", "store");
      guard.startTrace();
      expect(cachedGet(db, SEL, 1)).toEqual({ b: 10 });
      expect(guard.cachedSql(db)).toEqual([SEL]);
      expect(guard.stopTrace().some((e) => e.object === "t")).toBe(true);
      expect(() => cachedRun(db, "CREATE TABLE ds_x (x INTEGER)")).toThrow(/not authorized/);
      db.close();
    });
  });
});

describe("through a store", () => {
  let t: TempCache;
  let pub: DatasetPublisher;
  let store: Store | null = null;
  beforeEach(() => {
    t = tempCache();
    pub = openPublisher(t);
  });
  afterEach(() => {
    store?.close();
    store = null;
    pub.close();
    t.cleanup();
  });
  const open = (): Store => {
    store = openStore(t);
    return store;
  };

  it("the hot repository reads prepare once: projection lookups, the crosswalk, the ESPN cache", () => {
    const s = open();
    const db = storeInternalsOf(s)?.db;
    if (db === undefined) throw new Error("no internals");
    const spy = vi.spyOn(db, "prepare");
    for (let id = 1; id <= 200; id++) {
      s.repos.projections.getAsOf(id, 2026, 3, "v2-opportunity", "2026-09-20T17:00:00.000Z");
      s.repos.projections.getAsOf(id, 2026, 3, "v1-ensemble", "2026-09-20T17:00:00.000Z");
      s.repos.projections.latest(id, 2026, 3, "v1-ensemble");
      s.repos.crosswalk.get(id);
      s.repos.espnCache.get(`key-${String(id)}`);
      s.repos.pointsCache.get(`line-${String(id)}`, "settings");
    }
    expect(spy).toHaveBeenCalledTimes(5);
  });

  /** The store's connection, its guard, and every ESPN cache INSERT it prepared. */
  const cachePuts = (
    s: Store,
  ): { db: DatabaseSync; guard: StatementGuard; puts: () => StatementSync[] } => {
    const db = storeInternalsOf(s)?.db;
    const guard = statementGuardOf(s);
    if (db === undefined || guard === null) throw new Error("no internals");
    const spy = vi.spyOn(db, "prepare");
    const puts = (): StatementSync[] =>
      spy.mock.results.flatMap((r, i) =>
        r.type === "return" && String(spy.mock.calls[i]?.[0]).includes("INTO espn_cache")
          ? [r.value]
          : [],
      );
    return { db, guard, puts };
  };
  const isPut = (sql: string): boolean => sql.includes("INTO espn_cache");
  const entry = (key: string, parsed: string, raw: string | null = null): EspnCacheEntry => ({
    key,
    parsed_json: parsed,
    fetched_at: T0,
    server_time: null,
    etag: null,
    http_status: 200,
    raw_body: raw,
  });

  it("a large ESPN cache put leaves no cached statement carrying its parsed object; a small one is still cached", () => {
    const s = open();
    const { db, guard, puts } = cachePuts(s);
    // a 4 MiB parsed object (the size the verifier saw kept for the life of the connection)
    const body = JSON.stringify({ teams: "P".repeat(4 * 1024 * 1024) });
    expect(s.repos.espnCache.put(entry("big-1", body))).toEqual({ written: true });
    expect(guard.cachedSql(db).filter(isPut)).toEqual([]);
    expect(s.repos.espnCache.get("big-1")?.parsed_json).toBe(body);
    expect(s.repos.espnCache.put(entry("small-1", '{"marker":"one"}'))).toEqual({ written: true });
    expect(s.repos.espnCache.put(entry("big-2", body))).toEqual({ written: true });
    expect(s.repos.espnCache.put(entry("small-2", '{"marker":"two"}'))).toEqual({ written: true });
    const sts = puts();
    // big-1 and big-2 on statements of their own; small-1's cached, and small-2 runs on it
    expect(sts.length).toBe(3);
    expect(guard.cachedSql(db).filter(isPut).length).toBe(1);
    const cached = sts[1];
    if (cached === undefined) throw new Error("not prepared");
    expect(cached.expandedSQL).toContain('"marker":"two"');
    expect(cached.expandedSQL).not.toContain("PPPP");
    expect(cached.expandedSQL.length).toBeLessThan(1024);
    expect(s.repos.espnCache.get("big-2")?.parsed_json).toBe(body);
  });

  it("while recording, a raw body over the bound is not kept by a cached statement either", () => {
    store = openStore(t, { recordRawBodies: true });
    const s = store;
    const { db, guard, puts } = cachePuts(s);
    const raw = `{"pad":"${"R".repeat(StatementGuard.MAX_CACHED_BOUND)}"}`;
    expect(s.repos.espnCache.put(entry("rec-1", "{}", raw))).toEqual({ written: true });
    expect(guard.cachedSql(db).filter(isPut)).toEqual([]);
    expect(s.repos.espnCache.get("rec-1")?.raw_body).toBe(raw);
    expect(s.repos.espnCache.put(entry("rec-2", "{}", "{}"))).toEqual({ written: true });
    expect(guard.cachedSql(db).filter(isPut).length).toBe(1);
    // the body is held only by rec-1's own statement (dropped by the store, freed when V8 collects
    // it — kept alive here by the spy), never by the cached one rec-2 ran on
    expect(puts().map((st) => st.expandedSQL.includes("RRRR"))).toEqual([true, false]);
  });

  it("a dataset re-open is a new connection with a cache of its own; the old one's is dropped", async () => {
    await publishTables(pub, "nflverse:injuries", "v1", injuriesTables());
    const s = open();
    const internals = storeInternalsOf(s);
    if (internals === null) throw new Error("no internals");
    expect(s.datasets.injuries.reports(2026, 3, null).rows.length).toBeGreaterThan(0);
    const first = internals.connections.use("nflverse:injuries")?.db;
    if (first === undefined) throw new Error("not open");
    expect(internals.guard.cachedSql(first).length).toBeGreaterThan(0);
    await publishTables(pub, "nflverse:injuries", "v2", emptyTables("nflverse:injuries"));
    expect(s.reopenChangedDatasets()).toEqual(["nflverse:injuries"]);
    const second = internals.connections.use("nflverse:injuries")?.db;
    expect(second === first).toBe(false);
    expect(first.isOpen).toBe(false);
    expect(internals.guard.cachedSql(first)).toEqual([]);
    // served from the new file (v2 has no rows), through the new connection's own statements
    expect(s.datasets.injuries.reports(2026, 3, null).rows).toEqual([]);
    if (second === undefined) throw new Error("not re-opened");
    expect(internals.guard.cachedSql(second).length).toBeGreaterThan(0);
  });

  it("close drops every connection's cache", async () => {
    await publishTables(pub, "nflverse:injuries", "v1", injuriesTables());
    const s = open();
    const internals = storeInternalsOf(s);
    if (internals === null) throw new Error("no internals");
    s.datasets.injuries.reports(2026, 3, null);
    s.repos.crosswalk.get(1);
    const ds = internals.connections.use("nflverse:injuries")?.db;
    if (ds === undefined) throw new Error("not open");
    s.close();
    store = null;
    expect(internals.guard.cachedSql(internals.db)).toEqual([]);
    expect(internals.guard.cachedSql(ds)).toEqual([]);
  });
});

describe("the trace sees every statement run while tracing (b)", () => {
  it("a statement prepared before the trace and reused while tracing is in it", () => {
    const { db, guard } = guarded();
    expect(cachedGet(db, SEL, 1)).toEqual({ b: 10 });
    guard.startTrace();
    expect(cachedGet(db, SEL, 1)).toEqual({ b: 10 });
    const trace = guard.stopTrace();
    expect(trace.filter((e) => e.action === C.SQLITE_READ && e.object === "t").length).toBe(2);
    // a write reused under the trace is seen as one too
    expect(cachedRun(db, INS, 4, 40).changes).toBe(1);
    guard.startTrace();
    expect(cachedRun(db, INS, 5, 50).changes).toBe(1);
    expect(guard.stopTrace()).toContainEqual({
      connection: "store",
      action: C.SQLITE_INSERT,
      object: "t",
      schema: "main",
      denied: false,
    });
  });

  describe("over a warm store with every reader (connections.test.ts's trace, caches filled first)", () => {
    let t: TempCache;
    let pub: DatasetPublisher;
    let s: Store | null = null;
    beforeEach(() => {
      t = tempCache();
      pub = openPublisher(t);
    });
    afterEach(() => {
      s?.close();
      s = null;
      pub.close();
      t.cleanup();
    });

    it("zero ds_* DML, every dataset connection seen — and a ds_* write attempted is caught", async () => {
      await publishTables(pub, "espn:pro_schedule", "v1", proScheduleTables());
      await publishTables(pub, "espn:players", "v1", playersTables());
      await publishTables(pub, "nflverse:schedules", "v1", schedulesTables());
      await publishTables(pub, "nflverse:injuries", "v1", injuriesTables());
      await publishTables(pub, "nflverse:roster_weekly", "v1", rosterWeeklyTables());
      await publishTables(pub, "nflverse:players", "v1", nflPlayersTables());
      await publishTables(pub, "nflverse:stats_player_week", "v1", statsTables());
      await publishTables(pub, "weather:open_meteo", "v1", weatherTables("open_meteo"));
      await publishTables(pub, "weather:nws", "v1", weatherTables("nws"));
      const store = openStore(t);
      s = store;
      const readAll = (): void => {
        store.datasets.proSchedule.games(2026, null);
        store.datasets.proSchedule.teams(2026);
        store.datasets.nflGames.games(2026, [1, 2]);
        store.datasets.nflGames.byEspnGameId([900000001]);
        store.datasets.injuries.reports(2026, 3, null);
        store.datasets.playerWeeks.lines(["00-9000001"], 2026, [1]);
        store.datasets.playerWeeks.defenseLines(["BUF"], 2026, [1]);
        store.datasets.weather.forGames(["2026_01_BUF_MIA", "2026_02_WAS_BUF"]);
        nflPlayersReaderOf(store)?.byEspnIds([9000009]);
        store.rosterWeekly.latest(2026);
        store.rosterWeekly.byEspnId(9000001);
        store.playerUniverse.all(2026);
        store.playerUniverse.byIds([9000001]);
        store.repos.pointsCache.put("line", "settings", "{}");
      };
      const internals = storeInternalsOf(store);
      const guard = statementGuardOf(store);
      if (internals === null || guard === null) throw new Error("no internals");
      // warm: every statement of the window prepared (and cached) before the trace starts
      readAll();
      const conns = new Set(
        internals.connections
          .list()
          .map((o) => internals.connections.use(o.source)?.db)
          .filter((d) => d !== undefined),
      );
      expect(conns.size).toBe(9);
      for (const db of conns) expect(guard.cachedSql(db).length).toBeGreaterThan(0);
      guard.startTrace();
      readAll();
      const trace = guard.stopTrace();
      const dsWrites = (es: typeof trace) =>
        es.filter((e) => isWriteAction(e.action) && isDatasetObject(e.object));
      expect(dsWrites(trace)).toEqual([]);
      const datasetSide = trace.filter((e) => e.connection !== "store");
      expect(datasetSide.filter((e) => isWriteAction(e.action))).toEqual([]);
      expect(new Set(datasetSide.map((e) => e.connection)).size).toBe(9);
      expect(trace.some((e) => e.connection === "store" && e.object === "points_cache")).toBe(true);
      // a ds_* write the server attempted while tracing is in the trace: the zero-ds_*-DML check
      // (connections.test.ts) fails on it, through the cache as through a raw prepare
      guard.bypass(internals.db, () => {
        internals.db.exec("CREATE TABLE ds_sneak (x INTEGER)");
      });
      const injuries = internals.connections.use("nflverse:injuries")?.db;
      if (injuries === undefined) throw new Error("not open");
      guard.startTrace();
      readAll();
      expect(() => cachedRun(internals.db, "INSERT INTO ds_sneak (x) VALUES (1)")).toThrow(
        /not authorized/,
      );
      expect(() => cachedRun(injuries, "DELETE FROM ds_injuries")).toThrow(/not authorized/);
      const caught = dsWrites(guard.stopTrace());
      expect(caught.map((e) => [e.connection, e.object, e.denied])).toEqual([
        ["store", "ds_sneak", true],
        ["nflverse:injuries", "ds_injuries", true],
      ]);
    });
  });
});

describe("no statement reused while its own run is under way (c)", () => {
  it("a run re-entered from inside itself (a SQL function) gets a statement of its own", () => {
    const { db, prepares } = guarded();
    const sql = "SELECT a, f(a) AS fa FROM t ORDER BY a";
    let nested = 1;
    const inner: unknown[] = [];
    db.function("f", (x) => {
      if (nested-- > 0) inner.push(cachedAll(db, sql));
      return x;
    });
    const rows = [
      { a: 1, fa: 1 },
      { a: 2, fa: 2 },
      { a: 3, fa: 3 },
    ];
    expect(cachedAll(db, sql)).toEqual(rows);
    expect(inner).toEqual([rows]);
    expect(count(prepares(), sql)).toBe(2);
    // the cached one is reusable after, and is not prepared again
    expect(cachedAll(db, sql)).toEqual(rows);
    expect(count(prepares(), sql)).toBe(2);
  });

  it("what it prevents: re-running a statement inside its own run resets the run under way", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (a INTEGER PRIMARY KEY); INSERT INTO t VALUES (1),(2),(3)");
    let nested = 1;
    db.function("g", (x) => {
      if (nested-- > 0) st.all();
      return x;
    });
    const st = db.prepare("SELECT a, g(a) AS ga FROM t ORDER BY a");
    expect(st.all()).not.toEqual([
      { a: 1, ga: 1 },
      { a: 2, ga: 2 },
      { a: 3, ga: 3 },
    ]);
  });
});

describe("no option or parameter leaks between runs; a run that threw is reusable (d)", () => {
  it("named and anonymous parameters are bound afresh on every run", () => {
    const { db } = guarded();
    expect(cachedGet(db, "SELECT :a AS a, :b AS b", { a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
    expect(cachedGet(db, "SELECT :a AS a, :b AS b", { a: 3 })).toEqual({ a: 3, b: null });
    expect(cachedGet(db, "SELECT ? AS x, ? AS y", 1, 2)).toEqual({ x: 1, y: 2 });
    expect(cachedGet(db, "SELECT ? AS x, ? AS y", 3)).toEqual({ x: 3, y: null });
    expect(cachedGet(db, "SELECT ? AS x, ? AS y")).toEqual({ x: null, y: null });
  });

  it("a raw statement's options never reach the cached one (no setter is reachable)", () => {
    const { db } = guarded();
    expect(cachedGet(db, "SELECT b FROM t WHERE a = 1")).toEqual({ b: 10 });
    const raw = db.prepare("SELECT b FROM t WHERE a = 1");
    raw.setReadBigInts(true);
    raw.setReturnArrays(true);
    expect(raw.get()).toEqual([10n]);
    expect(cachedGet(db, "SELECT b FROM t WHERE a = 1")).toEqual({ b: 10 });
    expect(cachedAll(db, "SELECT b FROM t WHERE a = 1")).toEqual([{ b: 10 }]);
  });

  it("after a constraint failure, a bind failure or a throwing SQL function, the same statement runs correctly", () => {
    const { db, prepares } = guarded();
    expect(() => cachedRun(db, INS, 1, 11)).toThrow(/UNIQUE constraint failed/);
    expect(cachedRun(db, INS, 4, 40).changes).toBe(1);
    const xy = "SELECT ? AS x, ? AS y";
    expect(() => cachedGet(db, xy, 1, (() => 1) as never)).toThrow(/cannot be bound/);
    expect(cachedGet(db, xy, 2, 3)).toEqual({ x: 2, y: 3 });
    let boom = true;
    db.function("h", (x) => {
      if (boom) {
        boom = false;
        throw new Error("boom");
      }
      return x;
    });
    const sql = "SELECT h(a) AS ha FROM t ORDER BY a";
    expect(() => cachedAll(db, sql)).toThrow(/boom/);
    expect(cachedAll(db, sql)).toEqual([{ ha: 1 }, { ha: 2 }, { ha: 3 }, { ha: 4 }]);
    for (const s of [INS, xy, sql]) expect(count(prepares(), s)).toBe(1);
  });
});

describe("no cached statement keeps a large bound value (f)", () => {
  const MAX = StatementGuard.MAX_CACHED_BOUND;
  const PUT = "INSERT OR REPLACE INTO u (k, v, w) VALUES (?, ?, ?)";
  const NAMED = "INSERT OR REPLACE INTO u (k, v, w) VALUES (:k, :v, ?)";
  const PREFIXED = "INSERT OR REPLACE INTO u (k, v, w) VALUES ($k, @v, :w)";
  /** guarded(), with a table of any-typed values. */
  const withU = (): ReturnType<typeof guarded> => {
    const g = guarded();
    g.db.exec("CREATE TABLE u (k INTEGER PRIMARY KEY, v, w)");
    return g;
  };
  const big = (n = MAX + 1, ch = "B"): string => ch.repeat(n);

  it("a run binding more than MAX_CACHED_BOUND runs on a statement of its own; the cached one keeps the small run's values", () => {
    const { db, guard, statementsOf } = withU();
    expect(cachedRun(db, PUT, 1, "small-one", null).changes).toBe(1);
    expect(cachedRun(db, PUT, 2, big(), null).changes).toBe(1);
    expect(cachedRun(db, PUT, 3, big(), 7).changes).toBe(1);
    const sts = statementsOf(PUT);
    expect(sts.length).toBe(3); // the cached one, then one per large run
    expect(guard.cachedSql(db)).toEqual([PUT]);
    const [cached] = sts;
    if (cached === undefined) throw new Error("not prepared");
    expect(cached.expandedSQL).toContain("small-one");
    expect(cached.expandedSQL).not.toContain("BBBB");
    // what a large run binds is written all the same
    expect(cachedGet(db, "SELECT length(v) AS n, w FROM u WHERE k = 3")).toEqual({
      n: MAX + 1,
      w: 7,
    });
    // a small run after them is the cached statement's again, and replaces what it holds
    expect(cachedRun(db, PUT, 4, "small-two", null).changes).toBe(1);
    expect(statementsOf(PUT).length).toBe(3);
    expect(cached.expandedSQL).toContain("small-two");
    expect(cached.expandedSQL).not.toContain("small-one");
  });

  it("the first run of a text binding a large value caches nothing; a small run then caches it", () => {
    const { db, guard, statementsOf } = withU();
    expect(cachedGet(db, "SELECT length(?) AS n", big())).toEqual({ n: MAX + 1 });
    expect(cachedRun(db, PUT, 1, big(), null).changes).toBe(1);
    expect(guard.cachedSql(db)).toEqual([]);
    expect(cachedRun(db, PUT, 2, "s", null).changes).toBe(1);
    expect(guard.cachedSql(db)).toEqual([PUT]);
    expect(statementsOf(PUT).length).toBe(2);
    expect(statementsOf(PUT)[1]?.expandedSQL).not.toContain("BBBB");
  });

  it("counts the whole run: strings by length, buffer views by bytes, a named object's values, numbers as nothing", () => {
    const cases: [name: string, sql: string, params: unknown[], cached: boolean][] = [
      ["exactly MAX in one value", PUT, [1, big(MAX, "E"), null], true],
      ["exactly MAX over two values", PUT, [2, big(MAX - 10, "E"), big(10, "F")], true],
      ["one more over two values", PUT, [3, big(MAX - 10, "E"), big(11, "F")], false],
      ["a Uint8Array over", PUT, [4, new Uint8Array(MAX + 1), null], false],
      ["a Buffer over", PUT, [5, Buffer.alloc(MAX + 1), null], false],
      ["a DataView over", PUT, [6, new DataView(new ArrayBuffer(MAX + 1)), null], false],
      ["a Uint8Array of exactly MAX", PUT, [7, new Uint8Array(MAX), null], true],
      ["a Float64Array by bytes", PUT, [8, new Float64Array(MAX / 8), "x"], false],
      ["numbers and bigints count nothing", PUT, [2 ** 52, big(MAX, "E"), 2n ** 62n], true],
      ["a named object's value over", NAMED, [{ k: 9, v: big() }, null], false],
      [
        "a named value and an anonymous one",
        NAMED,
        [{ k: 10, v: big(MAX / 2) }, big(MAX / 2 + 1)],
        false,
      ],
      ["a small named run", NAMED, [{ k: 11, v: "small" }, "s"], true],
      ["prefixed names over", PREFIXED, [{ $k: 12, "@v": big(), w: 1 }], false],
      ["prefixed names small", PREFIXED, [{ $k: 13, "@v": "s", w: big(MAX - 1) }], true],
      // node:sqlite binds a function's own enumerable properties as named parameters too
      [
        "a function's named values over",
        NAMED,
        [Object.assign(() => 0, { k: 14, v: big() }), 1],
        false,
      ],
      [
        "a function's named values small",
        NAMED,
        [Object.assign(() => 0, { k: 15, v: "s" }), 1],
        true,
      ],
      // a buffer first is a value, not a named-parameter object
      ["a buffer first, over", "INSERT INTO u (v) VALUES (?)", [new Uint8Array(MAX + 1)], false],
      ["a buffer first, exactly MAX", "INSERT INTO u (v) VALUES (?)", [Buffer.alloc(MAX)], true],
    ];
    for (const [name, sql, params, cached] of cases) {
      const { db, guard, statementsOf } = withU();
      expect(cachedRun(db, sql, ...(params as [])).changes, name).toBe(1);
      expect(guard.cachedSql(db).includes(sql), name).toBe(cached);
      expect(statementsOf(sql).length, name).toBe(1);
      // the next small run: the cached statement (no prepare) or the first one cached (one more)
      expect(cachedRun(db, PUT, 99, "s", null).changes, name).toBe(1);
      if (sql === PUT) expect(statementsOf(PUT).length, name).toBe(cached ? 1 : 2);
    }
  });

  it("a named object's value is read once: measured as it is bound (a getter cannot answer small, then large)", () => {
    const { db, guard, statementsOf } = withU();
    const sql = "SELECT :v AS v";
    let reads = 0;
    const tricky = {
      get v(): string {
        reads += 1;
        return reads === 1 ? "small" : big();
      },
    };
    expect(cachedGet(db, sql, tricky)).toEqual({ v: "small" });
    expect(reads).toBe(1);
    expect(guard.cachedSql(db)).toEqual([sql]);
    expect(statementsOf(sql)[0]?.expandedSQL).toBe("SELECT 'small' AS v");
    // the caller's object is never changed; its next read is the large one, prepared per run
    expect(cachedGet(db, sql, tricky)).toEqual({ v: big() });
    expect(statementsOf(sql).length).toBe(2);
    expect(statementsOf(sql)[0]?.expandedSQL).toBe("SELECT 'small' AS v");
  });

  it("a large run while bypass lifts the guard is refused like any other: nothing is prepared unguarded", () => {
    const { db, guard, prepares } = withU();
    guard.bypass(db, () => {
      expect(() => cachedRun(db, PUT, 1, big(), null)).toThrow(/guard is lifted/);
      db.exec("CREATE TABLE ds_y (x)");
      expect(() => cachedRun(db, "INSERT INTO ds_y VALUES (?)", big())).toThrow(/guard is lifted/);
    });
    expect(count(prepares(), PUT)).toBe(0);
    expect(count(prepares(), "INSERT INTO ds_y VALUES (?)")).toBe(0);
    // under the authorizer again, a large run's own statement is denied a ds_* write as ever
    expect(() => cachedRun(db, "INSERT INTO ds_y VALUES (?)", big())).toThrow(/not authorized/);
    expect(cachedGet(db, "SELECT COUNT(*) AS n FROM ds_y")).toEqual({ n: 0 });
  });

  it("a view's bytes are its own: an own or inherited byteLength cannot answer small (verifier V3-1)", () => {
    const own = new Uint8Array(MAX + 1);
    Object.defineProperty(own, "byteLength", { value: 1 });
    class Sub extends Uint8Array {}
    Object.defineProperty(Sub.prototype, "byteLength", { get: () => 1 });
    const inherited = new Sub(MAX + 1);
    const view = new DataView(new ArrayBuffer(MAX + 1));
    Object.defineProperty(view, "byteLength", { value: 1 });
    for (const [name, v] of [
      ["own", own],
      ["inherited", inherited],
      ["DataView", view],
    ] as const) {
      expect(v.byteLength, name).toBe(1);
      const { db, guard, statementsOf } = withU();
      expect(cachedRun(db, PUT, 1, v, null).changes, name).toBe(1);
      // what node:sqlite bound is the whole view, so the run is never the cached statement's
      expect(cachedGet(db, "SELECT length(v) AS n FROM u WHERE k = 1"), name).toEqual({
        n: MAX + 1,
      });
      expect(guard.cachedSql(db).includes(PUT), name).toBe(false);
      expect(statementsOf(PUT).length, name).toBe(1);
    }
  });

  it("a null first parameter is a value, not a named-parameter object (verifier V3-2)", () => {
    const { db, guard } = withU();
    const sql = "SELECT ? AS a, ? AS b";
    expect(cachedGet(db, sql, null, 5)).toEqual({ a: null, b: 5 });
    expect(guard.cachedSql(db)).toEqual([sql]);
    // and again through the cached statement, a null first among the others
    expect(cachedGet(db, sql, null, null)).toEqual({ a: null, b: null });
    expect(cachedRun(db, PUT, null, "v", 1).changes).toBe(1);
    expect(cachedGet(db, "SELECT v, w FROM u WHERE v = 'v'")).toEqual({ v: "v", w: 1 });
  });

  it("an unguarded connection's large run prepares per run, as every run there does", () => {
    const db = new DatabaseSync(":memory:");
    const spy = vi.spyOn(db, "prepare");
    expect(cachedGet(db, "SELECT length(?) AS n", big())).toEqual({ n: MAX + 1 });
    expect(cachedGet(db, "SELECT length(?) AS n", "s")).toEqual({ n: 1 });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("bounded (e)", () => {
  it("at most MAX_CACHED statements per connection, least recently used dropped first", () => {
    const { db, guard, prepares } = guarded();
    const hot = "SELECT 'hot' AS h";
    const n = StatementGuard.MAX_CACHED + 44;
    for (let i = 0; i < n; i++) {
      expect(cachedGet(db, `SELECT ${String(i)} AS i`)).toEqual({ i });
      if (i % 10 === 0) cachedGet(db, hot);
    }
    const held = guard.cachedSql(db);
    expect(held.length).toBe(StatementGuard.MAX_CACHED);
    expect(held).toContain(hot);
    expect(held).not.toContain("SELECT 0 AS i");
    expect(held.at(-1)).toBe(`SELECT ${String(n - 1)} AS i`);
    expect(count(prepares(), hot)).toBe(1);
    // an evicted text is prepared again on its next run
    expect(cachedGet(db, "SELECT 0 AS i")).toEqual({ i: 0 });
    expect(count(prepares(), "SELECT 0 AS i")).toBe(2);
    expect(guard.cachedSql(db).length).toBe(StatementGuard.MAX_CACHED);
  });

  it("SQL longer than MAX_CACHED_SQL runs, prepared for its run only", () => {
    const { db, guard, prepares } = guarded();
    const long = `SELECT 1 AS one /* ${"x".repeat(StatementGuard.MAX_CACHED_SQL)} */`;
    const edge = `SELECT 2 AS two /*${"y".repeat(StatementGuard.MAX_CACHED_SQL - 20)}*/`;
    expect(edge.length).toBe(StatementGuard.MAX_CACHED_SQL);
    for (let i = 0; i < 2; i++) {
      expect(cachedGet(db, long)).toEqual({ one: 1 });
      expect(cachedGet(db, edge)).toEqual({ two: 2 });
    }
    expect(guard.cachedSql(db)).toEqual([edge]);
    expect(count(prepares(), long)).toBe(2);
    expect(count(prepares(), edge)).toBe(1);
  });
});
