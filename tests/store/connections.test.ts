// connections.test.ts — the server's dataset view (plan 01 §5.5 after ADV OBJ-22; plan 03 §1.1
// step 3; plan 05 §2 `store`): every dataset file its OWN read-only connection, opened lazily and
// re-opened when refresh_log names a new version; ALL eleven refresh sources of `full` (and every
// one of the 21 dataset source ids) open at once with no attach and no error; a write on a dataset
// connection fails by its open mode; a statement trace shows zero ds_* DML from the server; files
// the binary would not serve (symlink, foreign, other layout, unstamped, not SQLite) read as
// never loaded with a fixed-vocabulary warning.
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DATASET_SOURCE_IDS,
  REFRESH_JOBS,
  SOURCE_REGISTRY,
  sourcesOfJob,
  type DatasetSourceId,
} from "../../src/config/freshness.js";
import {
  DATASET_META_TABLE,
  parseDsSchema,
  type DatasetRefusal,
} from "../../src/store/datasets/connections.js";
import { isDatasetObject, isWriteAction } from "../../src/store/sqlite.js";
import { nflPlayersReaderOf, statementGuardOf, storeInternalsOf } from "../../src/store/store.js";
import { SQLITE_ATTACH_LIMIT, type DatasetPublisher, type Store } from "../../src/store/types.js";
import {
  emptyTables,
  injuriesTables,
  playersTables,
  proScheduleTables,
  publishTables,
  RELEASE,
  rosterWeeklyTables,
  schedulesTables,
  statsTables,
  weatherTables,
  nflPlayersTables,
} from "./helpers/datasets.js";
import { openPublisher, openStore, tempCache, type TempCache } from "./helpers/env.js";

let t: TempCache;
let pub: DatasetPublisher;
let warnings: string[];
let store: Store | null = null;
beforeEach(() => {
  t = tempCache();
  pub = openPublisher(t);
  warnings = [];
});
afterEach(() => {
  store?.close();
  store = null;
  pub.close();
  t.cleanup();
});

const open = (): Store => {
  store = openStore(t, { onWarning: (c) => warnings.push(c) });
  return store;
};
const fileOf = (s: DatasetSourceId): string =>
  path.join(t.datasetDir, `${s.replace(":", "__")}.sqlite`);

describe("lazy, per-source, read-only connections", () => {
  it("opens nothing at startup and exactly the file a read needs, read-only", async () => {
    await publishTables(pub, "nflverse:injuries", "v1", injuriesTables());
    await publishTables(pub, "espn:pro_schedule", "v1", proScheduleTables());
    const s = open();
    expect(s.stats().open_datasets).toEqual([]);
    const res = s.datasets.injuries.reports(2026, 3, null);
    expect(res.stamp?.file_version).toBe("v1");
    const opened = s.stats().open_datasets;
    expect(opened.map((o) => o.source)).toEqual(["nflverse:injuries"]);
    expect(opened[0]).toMatchObject({ file: fileOf("nflverse:injuries"), file_version: "v1" });
    expect(opened[0]?.inode).toBeGreaterThan(0);
    // the connection is read-only by its open mode (and the guard denies it too)
    const conn = storeInternalsOf(s)?.connections.use("nflverse:injuries");
    expect(() => conn?.db.exec("DELETE FROM ds_injuries")).toThrow();
    expect(() =>
      conn?.db.exec("INSERT INTO dataset_meta (key, value) VALUES ('x', 'y')"),
    ).toThrow();
    expect(() => conn?.db.exec("ATTACH DATABASE ':memory:' AS evil")).toThrow();
    expect(() => conn?.db.exec("CREATE TABLE ds_new (x INTEGER)")).toThrow();
  });

  it("the stamp comes from refresh_log (as_of = release, fetched_at = publish, checked_at moves)", async () => {
    await publishTables(pub, "nflverse:injuries", "v1", injuriesTables());
    const s = open();
    expect(s.datasets.injuries.reports(2026, 3, null).stamp).toEqual({
      source: "nflverse:injuries",
      as_of: RELEASE,
      fetched_at: "2026-10-06T12:00:00.000Z",
      checked_at: "2026-10-06T12:00:00.000Z",
      freshness_class: SOURCE_REGISTRY["nflverse:injuries"].freshness,
      file_version: "v1",
    });
    t.clock.advance(7_200_000);
    pub.recordUnchanged("nflverse:injuries", "v1", t.clock.nowIso());
    expect(s.datasets.injuries.reports(2026, 3, null).stamp?.checked_at).toBe(
      "2026-10-06T14:00:00.000Z",
    );
  });

  it("re-opens when refresh_log names a new version; reopenChangedDatasets reports it", async () => {
    await publishTables(pub, "nflverse:injuries", "v1", injuriesTables());
    const s = open();
    s.datasets.injuries.reports(2026, 3, null);
    const ino1 = s.stats().open_datasets[0]?.inode;
    await publishTables(pub, "nflverse:injuries", "v2", emptyTables("nflverse:injuries"));
    // the open connection still serves the old inode until something asks for a re-open
    const conn = storeInternalsOf(s)?.connections;
    expect(conn?.list()[0]?.file_version).toBe("v1");
    expect(s.reopenChangedDatasets()).toEqual(["nflverse:injuries"]);
    expect(conn?.list()[0]?.file_version).toBe("v2");
    expect(conn?.list()[0]?.inode).not.toBe(ino1);
    expect(s.reopenChangedDatasets()).toEqual([]);
    expect(s.datasets.injuries.reports(2026, 3, null)).toMatchObject({
      rows: [],
      stamp: { file_version: "v2" },
    });
  });

  it("a reader opened before the rename keeps reading the old rows (the old inode)", async () => {
    await publishTables(pub, "nflverse:injuries", "v1", injuriesTables());
    const s = open();
    const c1 = storeInternalsOf(s)?.connections.use("nflverse:injuries");
    await publishTables(pub, "nflverse:injuries", "v2", emptyTables("nflverse:injuries"));
    // the old handle still sees v1's rows even though the path now names v2
    expect((c1?.db.prepare("SELECT COUNT(*) AS n FROM ds_injuries").get() as { n: number }).n).toBe(
      3,
    );
    const fresh = new DatabaseSync(fileOf("nflverse:injuries"), { readOnly: true });
    expect((fresh.prepare("SELECT COUNT(*) AS n FROM ds_injuries").get() as { n: number }).n).toBe(
      0,
    );
    fresh.close();
    // and a deleted file keeps being served from the open inode until the version moves
    rmSync(fileOf("nflverse:injuries"));
    expect(s.reopenChangedDatasets()).toEqual(["nflverse:injuries"]);
    expect(s.datasets.injuries.reports(2026, 3, null)).toEqual({ rows: [], stamp: null });
    expect(warnings).toContain("dataset_missing");
  });

  it("after the documented restore (refresh_log names an older publish than the file on disk) the file is opened ONCE and served until refresh_log moves (Stage C datasets-restore-version-mismatch-reopen)", async () => {
    await publishTables(pub, "nflverse:injuries", "v1", injuriesTables());
    const before = open();
    const v1 = before.datasets.injuries.reports(2026, 3, null);
    expect(v1.stamp?.file_version).toBe("v1");
    expect(v1.rows.length).toBeGreaterThan(0);
    // the weekly backup, then a nightly publish the backup never saw
    const backup = path.join(t.backupDir, "store-2026-10-06.sqlite");
    await before.backup(backup);
    t.clock.advance(3_600_000);
    await publishTables(pub, "nflverse:injuries", "v2", emptyTables("nflverse:injuries"));
    before.close();
    store = null;
    pub.close();
    // restoreSteps: stop everything, move the store WITH its -wal and -shm away, copy the backup in
    for (const side of ["", "-wal", "-shm"]) rmSync(`${t.storePath}${side}`, { force: true });
    copyFileSync(backup, t.storePath);
    chmodSync(t.storePath, 0o600);
    const s = open();
    const conns = storeInternalsOf(s)?.connections;
    const first = conns?.use("nflverse:injuries");
    expect(first).toMatchObject({ file_version: "v2" });
    const openedAt = s.stats().open_datasets[0]?.opened_at;
    for (let i = 0; i < 200; i++) {
      t.clock.advance(1000);
      const res = s.datasets.injuries.reports(2026, 3, null);
      // the file on disk, under its own stamp (the restored refresh_log has no row for v2)
      expect(res).toMatchObject({ rows: [], stamp: { file_version: "v2" } });
      expect(conns?.use("nflverse:injuries")).toBe(first);
    }
    expect(s.stats().open_datasets).toEqual([
      expect.objectContaining({ file_version: "v2", opened_at: openedAt }),
    ]);
    // opened under the version the restored refresh_log names, not the file's
    expect(first?.opened_for).toBe("v1");
    // nothing changed in refresh_log: nothing to re-open
    expect(s.reopenChangedDatasets()).toEqual([]);
    expect(conns?.use("nflverse:injuries")).toBe(first);
    // the next publish moves refresh_log (recording the live v2 file first, then v3): re-opened once
    pub = openPublisher(t);
    await publishTables(pub, "nflverse:injuries", "v3", injuriesTables());
    const next = conns?.use("nflverse:injuries");
    expect(next).not.toBe(first);
    expect(next).toMatchObject({ file_version: "v3", opened_for: "v3" });
    expect(s.datasets.injuries.reports(2026, 3, null)).toMatchObject({
      rows: v1.rows,
      stamp: { file_version: "v3" },
    });
    expect(conns?.use("nflverse:injuries")).toBe(next);
    // no file was ever refused on the way
    const refusals: readonly DatasetRefusal[] = [
      "dataset_symlink_refused",
      "dataset_not_regular_file",
      "dataset_missing",
      "dataset_unreadable",
      "dataset_unstamped",
      "dataset_source_mismatch",
      "dataset_schema_mismatch",
      "dataset_tables_missing",
    ];
    for (const code of refusals) expect(warnings).not.toContain(code);
  });

  it("a source refresh_log never named reads as never loaded, even when a file exists", async () => {
    await publishTables(pub, "nflverse:injuries", "v1", injuriesTables());
    const s = open();
    const db = new DatabaseSync(t.storePath);
    db.exec("DELETE FROM refresh_log");
    db.close();
    expect(s.datasets.injuries.reports(2026, 3, null)).toEqual({ rows: [], stamp: null });
    expect(s.stats().open_datasets).toEqual([]);
  });
});

describe("ADV OBJ-22: no attach loop — every source at once", () => {
  it("the eleven refresh sources of `full` are opened at once with no attach or open error", async () => {
    expect(REFRESH_JOBS).toHaveLength(11);
    expect(REFRESH_JOBS.length).toBeGreaterThan(SQLITE_ATTACH_LIMIT);
    const firstOfEach = REFRESH_JOBS.map((j) => sourcesOfJob(j)[0]).filter(
      (s): s is DatasetSourceId => s !== undefined,
    );
    expect(firstOfEach).toHaveLength(11);
    for (const src of firstOfEach)
      expect((await publishTables(pub, src, "v1", emptyTables(src))).ok).toBe(true);
    const s = open();
    const conns = storeInternalsOf(s)?.connections;
    for (const src of firstOfEach) expect(conns?.use(src)).not.toBeNull();
    expect(s.stats().open_datasets).toHaveLength(11);
    expect(warnings).toEqual([]);
  });

  it("every dataset source id (28, the history files included) is opened at once, each its own connection", async () => {
    expect(DATASET_SOURCE_IDS).toHaveLength(28);
    for (const src of DATASET_SOURCE_IDS)
      expect((await publishTables(pub, src, "v1", emptyTables(src))).ok).toBe(true);
    const s = open();
    const conns = storeInternalsOf(s)?.connections;
    const dbs = new Set(DATASET_SOURCE_IDS.map((src) => conns?.use(src)?.db));
    expect(dbs.size).toBe(DATASET_SOURCE_IDS.length);
    expect(s.stats().open_datasets.map((o) => o.source)).toEqual([...DATASET_SOURCE_IDS].sort());
    // none of them attached anything
    for (const src of DATASET_SOURCE_IDS) {
      const list = conns?.use(src)?.db.prepare("PRAGMA database_list").all() as { name: string }[];
      expect(list.map((d) => d.name)).toEqual(["main"]);
    }
  });
});

describe("the statement trace: zero ds_* DML from the server (plan 05 §2)", () => {
  it("every reader runs; the trace shows reads only on the dataset connections", async () => {
    await publishTables(pub, "espn:pro_schedule", "v1", proScheduleTables());
    await publishTables(pub, "espn:players", "v1", playersTables());
    await publishTables(pub, "nflverse:schedules", "v1", schedulesTables());
    await publishTables(pub, "nflverse:injuries", "v1", injuriesTables());
    await publishTables(pub, "nflverse:roster_weekly", "v1", rosterWeeklyTables());
    await publishTables(pub, "nflverse:players", "v1", nflPlayersTables());
    await publishTables(pub, "nflverse:stats_player_week", "v1", statsTables());
    await publishTables(pub, "weather:open_meteo", "v1", weatherTables("open_meteo"));
    await publishTables(pub, "weather:nws", "v1", weatherTables("nws"));
    const s = open();
    const guard = statementGuardOf(s);
    guard?.startTrace();
    s.datasets.proSchedule.games(2026, null);
    s.datasets.proSchedule.teams(2026);
    s.datasets.nflGames.games(2026, [1, 2]);
    s.datasets.nflGames.byEspnGameId([900000001]);
    s.datasets.injuries.reports(2026, 3, null);
    s.datasets.playerWeeks.lines(["00-9000001"], 2026, [1]);
    s.datasets.playerWeeks.defenseLines(["BUF"], 2026, [1]);
    s.datasets.weather.forGames(["2026_01_BUF_MIA", "2026_02_WAS_BUF"]);
    nflPlayersReaderOf(s)?.byEspnIds([9000009]);
    s.rosterWeekly.latest(2026);
    s.rosterWeekly.byEspnId(9000001);
    s.playerUniverse.all(2026);
    s.playerUniverse.byIds([9000001]);
    // cache writes on the main store during the same window are allowed (they are not ds_*)
    s.repos.pointsCache.put("line", "settings", "{}");
    const trace = guard?.stopTrace() ?? [];
    expect(trace.length).toBeGreaterThan(0);
    const dsWrites = trace.filter((e) => isWriteAction(e.action) && isDatasetObject(e.object));
    expect(dsWrites).toEqual([]);
    const datasetSide = trace.filter((e) => e.connection !== "store");
    expect(datasetSide.length).toBeGreaterThan(0);
    expect(datasetSide.filter((e) => isWriteAction(e.action))).toEqual([]);
    expect(new Set(datasetSide.map((e) => e.connection)).size).toBe(9);
  });

  it("the main store's guard denies a ds_* table or an attached write even through its own connection", () => {
    const s = open();
    const db = storeInternalsOf(s)?.db;
    expect(() => db?.exec("CREATE TABLE ds_sneaky (x INTEGER)")).toThrow(/not authorized/);
    expect(() => db?.exec("ATTACH DATABASE ':memory:' AS side")).toThrow(/not authorized/);
    expect(() => db?.exec("CREATE TABLE DS_UPPER (x INTEGER)")).toThrow(/not authorized/);
  });
});

describe("files the binary will not serve read as never loaded (fixed-vocabulary warnings)", () => {
  async function publishThenTamper(tamper: (file: string) => void): Promise<Store> {
    await publishTables(pub, "nflverse:injuries", "v1", injuriesTables());
    tamper(fileOf("nflverse:injuries"));
    return open();
  }
  const setMeta = (file: string, key: string, value: string | null): void => {
    // published files are 0600 and ours: re-open writable to simulate a foreign/other-layout file
    const db = new DatabaseSync(file);
    if (value === null) db.prepare(`DELETE FROM ${DATASET_META_TABLE} WHERE key = ?`).run(key);
    else db.prepare(`UPDATE ${DATASET_META_TABLE} SET value = ? WHERE key = ?`).run(value, key);
    db.close();
  };

  const cases: [string, (file: string) => void, string][] = [
    [
      "a foreign source",
      (f) => {
        setMeta(f, "source", "nflverse:players");
      },
      "dataset_source_mismatch",
    ],
    [
      "another layout",
      (f) => {
        setMeta(f, "ds_schema", "999");
      },
      "dataset_schema_mismatch",
    ],
    [
      "a non-numeric layout",
      (f) => {
        setMeta(f, "ds_schema", "1x");
      },
      "dataset_schema_mismatch",
    ],
    [
      "a changed contract hash",
      (f) => {
        setMeta(f, "columns_hash", "0".repeat(64));
      },
      "dataset_schema_mismatch",
    ],
    [
      "an unstamped file",
      (f) => {
        setMeta(f, "file_version", null);
      },
      "dataset_unstamped",
    ],
    [
      "a missing contract table",
      (f) => {
        const db = new DatabaseSync(f);
        db.exec("DROP TABLE ds_injuries");
        db.close();
      },
      "dataset_tables_missing",
    ],
    [
      "no dataset_meta at all",
      (f) => {
        const db = new DatabaseSync(f);
        db.exec(`DROP TABLE ${DATASET_META_TABLE}`);
        db.close();
      },
      "dataset_unstamped",
    ],
    [
      "not a SQLite file",
      (f) => {
        writeFileSync(f, "this is not a database, it is a trap\n".repeat(200));
      },
      "dataset_unreadable",
    ],
    [
      "a symlink",
      (f) => {
        const real = path.join(t.root, "real.sqlite");
        renameSync(f, real);
        symlinkSync(real, f);
      },
      "dataset_symlink_refused",
    ],
    [
      "a directory",
      (f) => {
        rmSync(f);
        mkdirSync(f);
      },
      "dataset_not_regular_file",
    ],
  ];
  for (const [name, tamper, code] of cases)
    it(`${name} → stamp null, warning ${code}, warned once per version`, async () => {
      const s = await publishThenTamper(tamper);
      expect(s.datasets.injuries.reports(2026, 3, null)).toEqual({ rows: [], stamp: null });
      expect(s.datasets.injuries.reports(2026, 3, null)).toEqual({ rows: [], stamp: null });
      expect(warnings.filter((w) => w === code)).toHaveLength(1);
      expect(s.stats().open_datasets).toEqual([]);
      // the store says why, as the reader read it (Stage C status-damaged-dataset-reported-fresh)
      expect(s.datasetRefusal("nflverse:injuries")).toBe(code);
    });

  for (const [name, tamper, code] of cases)
    it(`datasetRefusal judges ${name} as a first read would, before any reader ran: ${code}`, async () => {
      const s = await publishThenTamper(tamper);
      expect(s.datasetRefusal("nflverse:injuries")).toBe(code);
      expect(s.datasetRefusal("nflverse:injuries")).toBe(code);
      // the reader agrees and the warning is still raised once for the version
      expect(s.datasets.injuries.reports(2026, 3, null).stamp).toBeNull();
      expect(warnings.filter((w) => w === code)).toHaveLength(1);
    });

  it("a half-truncated file (Stage C status-damaged-dataset-reported-fresh) is refused, and datasetRefusal says so", async () => {
    await publishTables(pub, "nflverse:injuries", "v1", injuriesTables());
    const f = fileOf("nflverse:injuries");
    const bytes = readFileSync(f);
    writeFileSync(f, bytes.subarray(0, Math.floor(bytes.length / 2)));
    const s = open();
    const code = s.datasetRefusal("nflverse:injuries");
    expect(code).not.toBeNull();
    expect(s.datasets.injuries.reports(2026, 3, null)).toEqual({ rows: [], stamp: null });
    expect(warnings).toContain(code);
  });

  it("datasetRefusal is null for a served file, a never-loaded source, and a refused file once republished", async () => {
    await publishTables(pub, "nflverse:injuries", "v1", injuriesTables());
    const s = open();
    expect(s.datasetRefusal("nflverse:injuries")).toBeNull();
    expect(s.datasets.injuries.reports(2026, 3, null).stamp?.file_version).toBe("v1");
    expect(s.datasetRefusal("nflverse:injuries")).toBeNull();
    // never refreshed: nothing to refuse, even with a file on disk
    copyFileSync(fileOf("nflverse:injuries"), fileOf("nflverse:players"));
    expect(s.datasetRefusal("nflverse:players")).toBeNull();
  });

  it("a refused version stops being reported the moment refresh_log names a good republish", async () => {
    const s = await publishThenTamper((f) => {
      setMeta(f, "ds_schema", "999");
    });
    expect(s.datasetRefusal("nflverse:injuries")).toBe("dataset_schema_mismatch");
    await publishTables(pub, "nflverse:injuries", "v2", injuriesTables());
    expect(s.datasetRefusal("nflverse:injuries")).toBeNull();
    expect(s.datasets.injuries.reports(2026, 3, null).stamp?.file_version).toBe("v2");
  });

  it("a refused file is retried once refresh_log names a new version", async () => {
    const s = await publishThenTamper((f) => {
      setMeta(f, "ds_schema", "999");
    });
    expect(s.datasets.injuries.reports(2026, 3, null).stamp).toBeNull();
    await publishTables(pub, "nflverse:injuries", "v2", injuriesTables());
    expect(s.datasets.injuries.reports(2026, 3, null).stamp?.file_version).toBe("v2");
  });

  it("parseDsSchema accepts digits only", () => {
    expect(parseDsSchema("1")).toBe(1);
    expect(parseDsSchema(" 1")).toBeNull();
    expect(parseDsSchema("1.0")).toBeNull();
    expect(parseDsSchema(undefined)).toBeNull();
    expect(parseDsSchema("1".repeat(10))).toBeNull();
  });
});

describe("closing", () => {
  it("close() closes every dataset connection; a use after close throws", async () => {
    await publishTables(pub, "nflverse:injuries", "v1", injuriesTables());
    const s = open();
    const conns = storeInternalsOf(s)?.connections;
    const c = conns?.use("nflverse:injuries");
    s.close();
    store = null;
    expect(() => c?.db.prepare("SELECT 1").get()).toThrow();
    expect(() => conns?.use("nflverse:injuries")).toThrow(/closed/);
  });
});
