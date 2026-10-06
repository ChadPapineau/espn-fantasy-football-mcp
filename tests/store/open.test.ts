// open.test.ts — StoreFactory.open (plan 01 §5.1; plan 03 §1.1 step 3, §1.3, §7): cache dir 0700,
// store.sqlite 0600, WAL, busy_timeout 5000, schema_version, a newer store refused (exit 1), a
// pending migration refused without `migrate`, nothing attached or opened at startup, idempotent
// close with a WAL checkpoint, and the path-safety refusals (symlinks, modes, relative paths).
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathSecurityError } from "../../src/config/paths.js";
import { storeInternalsOf } from "../../src/store/store.js";
import {
  BUSY_TIMEOUT_MS,
  MIGRATION_001_TABLES,
  StoreMigrationPendingError,
  StoreVersionError,
} from "../../src/store/types.js";
import { emptyTables, publishTables } from "./helpers/datasets.js";
import { openPublisher, openStore, tempCache, type TempCache } from "./helpers/env.js";

let t: TempCache;
beforeEach(() => {
  t = tempCache();
});
afterEach(() => {
  t.cleanup();
});

const mode = (p: string): number => statSync(p).mode & 0o777;

function tablesOf(file: string): string[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    )
      .map((r) => r.name)
      .filter((n) => n !== "sqlite_sequence");
  } finally {
    db.close();
  }
}

describe("a fresh store", () => {
  it("creates the cache dir 0700 and store.sqlite 0600, WAL, schema v1, exactly the 001 tables", () => {
    rmSync(t.cache, { recursive: true });
    const s = openStore(t);
    expect(mode(t.cache)).toBe(0o700);
    expect(mode(t.storePath)).toBe(0o600);
    expect(mode(t.datasetDir)).toBe(0o700);
    expect(s.schemaVersion).toBe(1);
    expect(s.path).toBe(t.storePath);
    const db = storeInternalsOf(s)?.db;
    expect(db).toBeDefined();
    expect(
      (db?.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
    ).toBe("wal");
    expect((db?.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(
      BUSY_TIMEOUT_MS,
    );
    expect(
      (db?.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys,
    ).toBe(1);
    s.close();
    expect(tablesOf(t.storePath)).toEqual([...MIGRATION_001_TABLES].sort());
    for (const n of tablesOf(t.storePath)) expect(n.startsWith("ds_")).toBe(false);
  });

  it("re-opens without migrating again; close is idempotent and checkpoints the WAL", () => {
    const a = openStore(t);
    a.repos.probeLog.record({
      at: "2026-10-06T12:00:00.000Z",
      kind: "host",
      ok: true,
      status: "green",
      upstream_status: 200,
      error: null,
    });
    a.close();
    a.close();
    const wal = `${t.storePath}-wal`;
    expect(!existsSync(wal) || statSync(wal).size === 0).toBe(true);
    const b = openStore(t, { migrate: false });
    expect(b.schemaVersion).toBe(1);
    expect(b.repos.probeLog.recent(5)).toHaveLength(1);
    b.close();
  });

  it("stats(): path, size, schema version, no dataset open at startup", async () => {
    // A published dataset exists before the server starts: startup still opens nothing.
    const pub = openPublisher(t);
    expect(
      (await publishTables(pub, "nflverse:injuries", "v1", emptyTables("nflverse:injuries"))).ok,
    ).toBe(true);
    pub.close();
    const s = openStore(t);
    const st = s.stats();
    expect(st.path).toBe(t.storePath);
    expect(st.schema_version).toBe(1);
    expect(st.size_bytes).toBeGreaterThan(0);
    expect(st.open_datasets).toEqual([]);
    expect(st.cache_misses_busy).toBe(0);
    s.close();
  });

  it("a throwing warning sink never breaks a read", async () => {
    const pub = openPublisher(t);
    await publishTables(pub, "nflverse:injuries", "v1", emptyTables("nflverse:injuries"));
    pub.close();
    rmSync(path.join(t.datasetDir, "nflverse__injuries.sqlite"));
    const s = openStore(t, {
      onWarning: () => {
        throw new Error("sink exploded");
      },
    });
    expect(s.datasets.injuries.reports(2026, 3, null)).toEqual({ rows: [], stamp: null });
    s.close();
  });
});

describe("version gates (plan 03 §1.1 step 3, §7)", () => {
  it("a store written by a newer binary is refused with StoreVersionError (exit 1)", () => {
    openStore(t).close();
    const db = new DatabaseSync(t.storePath);
    db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (7, ?)").run(
      "2026-10-06T12:00:00.000Z",
    );
    db.close();
    let err: unknown;
    try {
      openStore(t);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreVersionError);
    expect((err as StoreVersionError).storeVersion).toBe(7);
    expect((err as StoreVersionError).binaryVersion).toBe(1);
    expect((err as StoreVersionError).exitCode).toBe(1);
    // the publisher (the refresh process) refuses the same way
    expect(() => openPublisher(t)).toThrow(StoreVersionError);
  });

  it("a pending migration without `migrate` is refused (and nothing is created)", () => {
    let err: unknown;
    try {
      openStore(t, { migrate: false });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreMigrationPendingError);
    expect((err as StoreMigrationPendingError).exitCode).toBe(1);
    expect(tablesOf(t.storePath)).toEqual([]);
  });
});

describe("path safety (plan 02 §2.2 modes; plan 03 §1.1 step 1)", () => {
  it("refuses relative paths", () => {
    expect(() => openStore(t, { path: "store.sqlite" })).toThrow(PathSecurityError);
    expect(() => openStore(t, { datasetDir: "datasets" })).toThrow(PathSecurityError);
    expect(() => openStore(t, { backupDir: "./backups" })).toThrow(PathSecurityError);
    expect(() => openStore(t, { path: `${t.storePath}\0x` })).toThrow(PathSecurityError);
  });

  it("refuses a symlinked store file, a group-readable one, and a symlinked -wal", () => {
    const real = path.join(t.root, "elsewhere.sqlite");
    writeFileSync(real, "", { mode: 0o600 });
    symlinkSync(real, t.storePath);
    expect(() => openStore(t)).toThrow(PathSecurityError);
    rmSync(t.storePath);
    writeFileSync(t.storePath, "", { mode: 0o644 });
    chmodSync(t.storePath, 0o644);
    expect(() => openStore(t)).toThrow(/permission bits/);
    rmSync(t.storePath);
    symlinkSync(real, `${t.storePath}-wal`);
    expect(() => openStore(t)).toThrow(PathSecurityError);
  });

  it("refuses an existing cache directory with group/other bits (never chmods it)", () => {
    chmodSync(t.cache, 0o755);
    expect(() => openStore(t)).toThrow(PathSecurityError);
    expect(mode(t.cache)).toBe(0o755);
  });

  it("refuses a dataset directory that is a symlink", () => {
    const real = path.join(t.root, "real-ds");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, t.datasetDir);
    expect(() => openStore(t)).toThrow(PathSecurityError);
  });
});
