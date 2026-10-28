// migrations.test.ts — forward-only migrations (plan 03 §7, L7): from empty; migration 001 creates
// exactly MIGRATION_001_TABLES and 002 (Phase 3, plan 10 §3.3) exactly MIGRATION_002_TABLES plus the
// projection's three attribution columns, on a v1 store with its rows kept (003, the league scope,
// is held in league-scope.test.ts); a synthetic next migration runs after a VACUUM INTO
// pre-migration backup (0600, holding the current data) under the process lock; a
// failing migration rolls back whole and leaves no copy behind; one copy per version, of the last
// two versions, is kept; a store from a newer binary is refused (no down-migration); a second runner
// is a no-op.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  KEEP_BACKUP_VERSIONS,
  preMigrationBackupPath,
  prunePreMigrationBackups,
} from "../../src/store/backup.js";
import { lockPathOf } from "../../src/store/lock.js";
import { MIGRATION_001_SQL } from "../../src/store/migrations/001_initial.js";
import {
  MIGRATION_002_PROJECTION_COLUMNS,
  MIGRATION_002_SQL,
} from "../../src/store/migrations/002_phase3.js";
import {
  applyMigrations,
  MIGRATIONS,
  readSchemaVersion,
  targetVersion,
  type Migration,
} from "../../src/store/migrations/index.js";
import {
  MIGRATION_001_TABLES,
  MIGRATION_002_TABLES,
  NEVER_PRUNED_TABLES,
  STORE_TABLES,
  StoreVersionError,
} from "../../src/store/types.js";
import { openPublisher, openStore, ROOT, tempCache, type TempCache } from "./helpers/env.js";

let t: TempCache;
beforeEach(() => {
  t = tempCache();
});
afterEach(() => {
  t.cleanup();
});

/** This binary's schema version (migrations 001, 002 and 003). */
const BIN = 3;
const NEXT: Migration = Object.freeze({
  version: BIN + 1,
  name: "synthetic_add_column",
  up: (db: DatabaseSync) => {
    db.exec("ALTER TABLE probe_log ADD COLUMN note TEXT");
  },
});
const NEXT_FAILS: Migration = Object.freeze({
  version: BIN + 1,
  name: "synthetic_fails",
  up: (db: DatabaseSync) => {
    db.exec("ALTER TABLE probe_log ADD COLUMN half_done TEXT");
    throw new Error("boom mid-migration");
  },
});

function seedCurrent(): void {
  const s = openStore(t);
  s.repos.probeLog.record({
    at: "2026-10-06T12:00:00.000Z",
    kind: "shape",
    ok: true,
    status: "green",
    upstream_status: 200,
    error: null,
  });
  s.close();
}

describe("the migration list", () => {
  it("is numbered 1..n contiguously; this binary is v3", () => {
    expect(targetVersion(MIGRATIONS)).toBe(BIN);
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 2, 3]);
    expect(() => targetVersion([NEXT])).toThrow(/contiguously/);
    expect(() => targetVersion([...MIGRATIONS, NEXT, NEXT])).toThrow(/contiguously/);
  });

  const tablesIn = (db: DatabaseSync): string[] =>
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    )
      .map((r) => r.name)
      .filter((n) => n !== "sqlite_sequence");

  it("migration 001 creates exactly MIGRATION_001_TABLES and comments every never-pruned table", () => {
    const db = new DatabaseSync(":memory:");
    expect(readSchemaVersion(db)).toBe(0);
    const only001 = MIGRATIONS.slice(0, 1);
    expect(applyMigrations(db, only001, () => "2026-10-06T12:00:00.000Z")).toEqual([1]);
    expect(readSchemaVersion(db)).toBe(1);
    expect(tablesIn(db)).toEqual([...MIGRATION_001_TABLES].sort());
    // A second runner (another process that raced) applies nothing.
    expect(applyMigrations(db, only001, () => "2026-10-06T12:00:00.000Z")).toEqual([]);
    db.close();
    const ddl = MIGRATION_001_SQL.join("\n");
    for (const tname of NEVER_PRUNED_TABLES)
      if ((MIGRATION_001_TABLES as readonly string[]).includes(tname))
        expect(ddl).toContain(`CREATE TABLE ${tname} (`);
    // The write_journal table is a declared Phase W seam: created, never written in this build.
    for (const f of [
      "src/store/migrations/001_initial.ts",
      "src/store/repos/ops.ts",
      "src/store/store.ts",
    ])
      expect(readFileSync(path.join(ROOT, f), "utf8")).toContain("PHASE W SEAM — NOT IMPLEMENTED");
    expect(ddl).not.toMatch(/CREATE TABLE ds_/);
  });

  it("migration 002 adds exactly MIGRATION_002_TABLES (never pruned) and the projection's three columns", () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db, MIGRATIONS.slice(0, 1), () => "2026-10-06T12:00:00.000Z");
    const projCols = (): string[] =>
      (db.prepare("PRAGMA table_info(projection)").all() as { name: string }[]).map((c) => c.name);
    const before = projCols();
    const upTo002 = MIGRATIONS.slice(0, 2);
    expect(applyMigrations(db, upTo002, () => "2026-10-06T12:00:00.000Z")).toEqual([2]);
    expect(readSchemaVersion(db)).toBe(2);
    expect(tablesIn(db)).toEqual([...STORE_TABLES].sort());
    expect(projCols()).toEqual([...before, ...MIGRATION_002_PROJECTION_COLUMNS]);
    expect(applyMigrations(db, upTo002, () => "2026-10-06T12:00:00.000Z")).toEqual([]);
    db.close();
    const ddl = MIGRATION_002_SQL.join("\n");
    for (const tname of MIGRATION_002_TABLES) {
      expect(ddl).toContain(`CREATE TABLE ${tname} (`);
      expect(NEVER_PRUNED_TABLES).toContain(tname);
    }
    expect(ddl).not.toMatch(/CREATE TABLE ds_|DROP |DELETE /);
  });

  it("espn_requests carries exactly the columns the limiter contract names", () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db, MIGRATIONS, () => "2026-10-06T12:00:00.000Z");
    const cols = (db.prepare("PRAGMA table_info(espn_requests)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toEqual(["id", "ts", "keyless", "origin", "outcome"]);
    db.close();
  });
});

describe("upgrading (plan 03 §7)", () => {
  it("backs up by VACUUM INTO (0600, the current data) before the first pending migration, then migrates", () => {
    seedCurrent();
    const s = openStore(t, {}, { migrations: [...MIGRATIONS, NEXT] });
    expect(s.schemaVersion).toBe(BIN + 1);
    expect(s.repos.probeLog.recent(5)).toHaveLength(1);
    s.close();
    const bak = path.join(t.backupDir, `store.sqlite.bak-v${String(BIN)}`);
    expect(existsSync(bak)).toBe(true);
    expect(statSync(bak).mode & 0o777).toBe(0o600);
    const b = new DatabaseSync(bak, { readOnly: true });
    expect(readSchemaVersion(b)).toBe(BIN);
    expect((b.prepare("SELECT COUNT(*) AS n FROM probe_log").get() as { n: number }).n).toBe(1);
    const cols = (b.prepare("PRAGMA table_info(probe_log)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).not.toContain("note");
    b.close();
    // The process lock is released afterwards.
    expect(existsSync(lockPathOf(t.storePath))).toBe(false);
  });

  it("a fresh store (v0) takes no backup", () => {
    const s = openStore(t, {}, { migrations: [...MIGRATIONS, NEXT] });
    expect(s.schemaVersion).toBe(BIN + 1);
    s.close();
    expect(existsSync(t.backupDir) ? readdirSync(t.backupDir) : []).toEqual([]);
  });

  it("a failing migration rolls back whole: the store keeps its version and its rows", () => {
    seedCurrent();
    expect(() => openStore(t, {}, { migrations: [...MIGRATIONS, NEXT_FAILS] })).toThrow(
      /boom mid-migration/,
    );
    const db = new DatabaseSync(t.storePath, { readOnly: true });
    expect(readSchemaVersion(db)).toBe(BIN);
    const cols = (db.prepare("PRAGMA table_info(probe_log)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).not.toContain("half_done");
    db.close();
    expect(existsSync(lockPathOf(t.storePath))).toBe(false);
    const s = openStore(t);
    expect(s.repos.probeLog.recent(5)).toHaveLength(1);
    s.close();
  });

  it("refuses to run down: a v4 store opened by a v3 binary is StoreVersionError(4, 3)", () => {
    openStore(t, {}, { migrations: [...MIGRATIONS, NEXT] }).close();
    let err: unknown;
    try {
      openStore(t);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreVersionError);
    expect((err as StoreVersionError).storeVersion).toBe(BIN + 1);
    expect((err as StoreVersionError).binaryVersion).toBe(BIN);
    expect((err as Error).message).toMatch(/Upgrade the package or restore the backup/);
  });

  it("waits for, then takes, the process lock held by a dead process (stale lock broken)", () => {
    seedCurrent();
    // A lock left by a process that no longer exists.
    writeFileSync(lockPathOf(t.storePath), "999999999 2026-10-06T00:00:00.000Z\n", { mode: 0o600 });
    const s = openStore(t, {}, { migrations: [...MIGRATIONS, NEXT] });
    expect(s.schemaVersion).toBe(BIN + 1);
    s.close();
  });

  it("a v1 store (written before Phase 3) migrates to this binary's version and keeps its rows", () => {
    // a store at v1 only: migration 001 applied by an older binary
    openStore(t, {}, { migrations: MIGRATIONS.slice(0, 1) }).close();
    const s1 = openStore(t, {}, { migrations: MIGRATIONS.slice(0, 1) });
    s1.repos.probeLog.record({
      at: "2026-10-06T12:00:00.000Z",
      kind: "shape",
      ok: true,
      status: "green",
      upstream_status: 200,
      error: null,
    });
    s1.close();
    const s = openStore(t);
    expect(s.schemaVersion).toBe(BIN);
    expect(s.repos.probeLog.recent(5)).toHaveLength(1);
    s.close();
    expect(existsSync(path.join(t.backupDir, "store.sqlite.bak-v1"))).toBe(true);
  });
});

describe("pre-migration backup retention", () => {
  it("keeps the newest copy of each of the newest two versions; a new copy's name always ranks newest", () => {
    const dir = t.backupDir;
    openStore(t).close(); // creates nothing in backups/, but the dir may not exist yet
    const mk = (name: string): void => {
      writeFileSync(path.join(dir, name), "x", { mode: 0o600 });
    };
    mkdirSync(dir, { mode: 0o700, recursive: true });
    mk("store.sqlite.bak-v1");
    mk("store.sqlite.bak-v2");
    mk("store.sqlite.bak-v3");
    mk("store.sqlite.bak-v3-1759752000000");
    mk("unrelated.txt");
    // a copy of a version that has one takes a suffix above every suffix it holds — even when the
    // clock reads earlier (42) — so a rotation keeping a version's newest copy keeps the new one
    expect(preMigrationBackupPath(dir, 3, 42)).toBe(
      path.join(dir, "store.sqlite.bak-v3-1759752000001"),
    );
    expect(preMigrationBackupPath(dir, 3, 1_800_000_000_000)).toBe(
      path.join(dir, "store.sqlite.bak-v3-1800000000000"),
    );
    expect(preMigrationBackupPath(dir, 2, 42)).toBe(path.join(dir, "store.sqlite.bak-v2-42"));
    expect(preMigrationBackupPath(dir, 4, 42)).toBe(path.join(dir, "store.sqlite.bak-v4"));
    expect(() => preMigrationBackupPath(dir, 4, Number.NaN)).toThrow(RangeError);
    expect(KEEP_BACKUP_VERSIONS).toBe(2);
    // v1 is past the newest two versions; v3's bare copy is older than its suffixed one
    expect(prunePreMigrationBackups(dir)).toEqual(["store.sqlite.bak-v1", "store.sqlite.bak-v3"]);
    expect(readdirSync(dir).sort()).toEqual([
      "store.sqlite.bak-v2",
      "store.sqlite.bak-v3-1759752000000",
      "unrelated.txt",
    ]);
    expect(prunePreMigrationBackups(dir)).toEqual([]);
    expect(prunePreMigrationBackups(path.join(dir, "missing"))).toEqual([]);
  });

  it("never removes a symlink's target or a directory, and a copy it cannot remove is left for the next rotation", () => {
    const dir = t.backupDir;
    mkdirSync(dir, { mode: 0o700, recursive: true });
    const outside = path.join(t.root, "outside.sqlite");
    writeFileSync(outside, "keep", { mode: 0o600 });
    symlinkSync(outside, path.join(dir, "store.sqlite.bak-v1"));
    mkdirSync(path.join(dir, "store.sqlite.bak-v2"));
    writeFileSync(path.join(dir, "store.sqlite.bak-v2-5"), "x", { mode: 0o600 });
    writeFileSync(path.join(dir, "store.sqlite.bak-v3"), "x", { mode: 0o600 });
    writeFileSync(path.join(dir, "store.sqlite.bak-v4"), "x", { mode: 0o600 });
    expect(prunePreMigrationBackups(dir)).toEqual(["store.sqlite.bak-v2-5"]);
    expect(readFileSync(outside, "utf8")).toBe("keep");
    expect(readdirSync(dir).sort()).toEqual([
      "store.sqlite.bak-v1",
      "store.sqlite.bak-v2",
      "store.sqlite.bak-v3",
      "store.sqlite.bak-v4",
    ]);
  });
});

// Stage C, store-failed-migration-backups-accumulate: openMigrated took a full VACUUM INTO copy before
// every attempt and pruned only after a success, keeping every file of the newest two versions — so a
// migration that kept failing (a lock still busy at BEGIN IMMEDIATE, SQLITE_FULL, a migration bug)
// left one full copy per open: the server's start and each launchd job, every hour, until the disk
// filled. Now a run that committed nothing removes its own copy, an attempt removes the earlier copies
// of the version it migrates from before it takes its own, and the rotation keeps one per version.
describe("a migration that keeps failing leaves no copies behind (one copy per version at most)", () => {
  const preCopies = (): string[] =>
    (existsSync(t.backupDir) ? readdirSync(t.backupDir) : [])
      .filter((n) => n.includes(".bak-v"))
      .sort();

  it("24 hourly wakes of a failing migration: no copy remains, the store keeps its version and rows", () => {
    seedCurrent();
    for (let hour = 0; hour < 24; hour++) {
      t.clock.advance(3_600_000);
      expect(() => openStore(t, {}, { migrations: [...MIGRATIONS, NEXT_FAILS] })).toThrow(
        /boom mid-migration/,
      );
      expect(preCopies()).toEqual([]);
    }
    const db = new DatabaseSync(t.storePath, { readOnly: true });
    expect(readSchemaVersion(db)).toBe(BIN);
    db.close();
    // the refresh process opens the store the same way (openPublisher → openMigrated)
    expect(() => openPublisher(t, { migrations: [...MIGRATIONS, NEXT_FAILS] })).toThrow(
      /boom mid-migration/,
    );
    expect(preCopies()).toEqual([]);
    // the fixed migration then takes exactly one copy, holding the current data
    const s = openStore(t, {}, { migrations: [...MIGRATIONS, NEXT] });
    expect(s.schemaVersion).toBe(BIN + 1);
    expect(s.repos.probeLog.recent(5)).toHaveLength(1);
    s.close();
    expect(preCopies()).toEqual([`store.sqlite.bak-v${String(BIN)}`]);
    const b = new DatabaseSync(path.join(t.backupDir, `store.sqlite.bak-v${String(BIN)}`), {
      readOnly: true,
    });
    expect(readSchemaVersion(b)).toBe(BIN);
    expect((b.prepare("SELECT COUNT(*) AS n FROM probe_log").get() as { n: number }).n).toBe(1);
    b.close();
  });

  it("a run that committed a step keeps its copy (that step cannot be undone without it)", () => {
    seedCurrent();
    const AFTER_NEXT_FAILS: Migration = { ...NEXT_FAILS, version: BIN + 2 };
    expect(() => openStore(t, {}, { migrations: [...MIGRATIONS, NEXT, AFTER_NEXT_FAILS] })).toThrow(
      /boom mid-migration/,
    );
    const db = new DatabaseSync(t.storePath, { readOnly: true });
    expect(readSchemaVersion(db)).toBe(BIN + 1);
    db.close();
    expect(preCopies()).toEqual([`store.sqlite.bak-v${String(BIN)}`]);
    // the next attempt starts from v3: its own copy of v3 goes when it fails; the v2 copy stays
    t.clock.advance(3_600_000);
    expect(() => openStore(t, {}, { migrations: [...MIGRATIONS, NEXT, AFTER_NEXT_FAILS] })).toThrow(
      /boom mid-migration/,
    );
    expect(preCopies()).toEqual([`store.sqlite.bak-v${String(BIN)}`]);
  });

  it("copies left by killed attempts (or by builds before this rule) are replaced by the next attempt's", () => {
    seedCurrent();
    mkdirSync(t.backupDir, { mode: 0o700, recursive: true });
    // what a SIGKILLed attempt — or the old code's failed ones — left: copies of the version (v2)
    for (const n of ["", "-1760000000000", "-1760003600000"])
      writeFileSync(path.join(t.backupDir, `store.sqlite.bak-v${String(BIN)}${n}`), "stale", {
        mode: 0o600,
      });
    writeFileSync(path.join(t.backupDir, "store.sqlite.bak-v1"), "older version", { mode: 0o600 });
    expect(() => openStore(t, {}, { migrations: [...MIGRATIONS, NEXT_FAILS] })).toThrow(
      /boom mid-migration/,
    );
    // the failed attempt removed them before its own copy, then its own copy: v1's stays
    expect(preCopies()).toEqual(["store.sqlite.bak-v1"]);
    for (const n of ["", "-1760000000000"])
      writeFileSync(path.join(t.backupDir, `store.sqlite.bak-v${String(BIN)}${n}`), "stale", {
        mode: 0o600,
      });
    const s = openStore(t, {}, { migrations: [...MIGRATIONS, NEXT] });
    s.close();
    // one copy of v2, the fresh one (a database holding the data, not a leftover)
    expect(preCopies()).toEqual(["store.sqlite.bak-v1", `store.sqlite.bak-v${String(BIN)}`]);
    const b = new DatabaseSync(path.join(t.backupDir, `store.sqlite.bak-v${String(BIN)}`), {
      readOnly: true,
    });
    expect((b.prepare("SELECT COUNT(*) AS n FROM probe_log").get() as { n: number }).n).toBe(1);
    b.close();
  });
});
