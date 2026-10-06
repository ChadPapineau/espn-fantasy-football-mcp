// migrations.test.ts — forward-only migrations (plan 03 §7, L7): from empty; a synthetic 002 runs
// after a VACUUM INTO pre-migration backup (0600, holding the v1 data) under the process lock; a
// failing migration rolls back whole; a store from a newer binary is refused (no down-migration);
// backups beyond the last two versions are pruned; a second runner is a no-op.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  applyMigrations,
  MIGRATIONS,
  readSchemaVersion,
  targetVersion,
  type Migration,
} from "../../src/store/migrations/index.js";
import {
  MIGRATION_001_TABLES,
  NEVER_PRUNED_TABLES,
  StoreVersionError,
} from "../../src/store/types.js";
import { openStore, ROOT, tempCache, type TempCache } from "./helpers/env.js";

let t: TempCache;
beforeEach(() => {
  t = tempCache();
});
afterEach(() => {
  t.cleanup();
});

const M002: Migration = Object.freeze({
  version: 2,
  name: "synthetic_add_column",
  up: (db: DatabaseSync) => {
    db.exec("ALTER TABLE probe_log ADD COLUMN note TEXT");
  },
});
const M002_FAILS: Migration = Object.freeze({
  version: 2,
  name: "synthetic_fails",
  up: (db: DatabaseSync) => {
    db.exec("ALTER TABLE probe_log ADD COLUMN half_done TEXT");
    throw new Error("boom mid-migration");
  },
});

function seedV1(): void {
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
  it("is numbered 1..n contiguously; this binary is v1", () => {
    expect(targetVersion(MIGRATIONS)).toBe(1);
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1]);
    expect(() => targetVersion([M002])).toThrow(/contiguously/);
    expect(() => targetVersion([...MIGRATIONS, M002, M002])).toThrow(/contiguously/);
  });

  it("migration 001 creates exactly MIGRATION_001_TABLES and comments every never-pruned table", () => {
    const db = new DatabaseSync(":memory:");
    expect(readSchemaVersion(db)).toBe(0);
    expect(applyMigrations(db, MIGRATIONS, () => "2026-10-06T12:00:00.000Z")).toEqual([1]);
    expect(readSchemaVersion(db)).toBe(1);
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    )
      .map((r) => r.name)
      .filter((n) => n !== "sqlite_sequence");
    expect(names).toEqual([...MIGRATION_001_TABLES].sort());
    // A second runner (another process that raced) applies nothing.
    expect(applyMigrations(db, MIGRATIONS, () => "2026-10-06T12:00:00.000Z")).toEqual([]);
    db.close();
    const ddl = MIGRATION_001_SQL.join("\n");
    for (const tname of NEVER_PRUNED_TABLES) expect(ddl).toContain(`CREATE TABLE ${tname} (`);
    // The write_journal table is a declared Phase W seam: created, never written in this build.
    for (const f of [
      "src/store/migrations/001_initial.ts",
      "src/store/repos/ops.ts",
      "src/store/store.ts",
    ])
      expect(readFileSync(path.join(ROOT, f), "utf8")).toContain("PHASE W SEAM — NOT IMPLEMENTED");
    expect(ddl).not.toMatch(/CREATE TABLE ds_/);
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
  it("backs up by VACUUM INTO (0600, the v1 data) before the first pending migration, then migrates", () => {
    seedV1();
    const s = openStore(t, {}, { migrations: [...MIGRATIONS, M002] });
    expect(s.schemaVersion).toBe(2);
    expect(s.repos.probeLog.recent(5)).toHaveLength(1);
    s.close();
    const bak = path.join(t.backupDir, "store.sqlite.bak-v1");
    expect(existsSync(bak)).toBe(true);
    expect(statSync(bak).mode & 0o777).toBe(0o600);
    const b = new DatabaseSync(bak, { readOnly: true });
    expect(readSchemaVersion(b)).toBe(1);
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
    const s = openStore(t, {}, { migrations: [...MIGRATIONS, M002] });
    expect(s.schemaVersion).toBe(2);
    s.close();
    expect(existsSync(t.backupDir) ? readdirSync(t.backupDir) : []).toEqual([]);
  });

  it("a failing migration rolls back whole: the store stays v1 and keeps its rows", () => {
    seedV1();
    expect(() => openStore(t, {}, { migrations: [...MIGRATIONS, M002_FAILS] })).toThrow(
      /boom mid-migration/,
    );
    const db = new DatabaseSync(t.storePath, { readOnly: true });
    expect(readSchemaVersion(db)).toBe(1);
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

  it("refuses to run down: a v2 store opened by a v1 binary is StoreVersionError(2, 1)", () => {
    openStore(t, {}, { migrations: [...MIGRATIONS, M002] }).close();
    let err: unknown;
    try {
      openStore(t);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreVersionError);
    expect((err as StoreVersionError).storeVersion).toBe(2);
    expect((err as StoreVersionError).binaryVersion).toBe(1);
    expect((err as Error).message).toMatch(/Upgrade the package or restore the backup/);
  });

  it("waits for, then takes, the process lock held by a dead process (stale lock broken)", () => {
    seedV1();
    // A lock left by a process that no longer exists.
    writeFileSync(lockPathOf(t.storePath), "999999999 2026-10-06T00:00:00.000Z\n", { mode: 0o600 });
    const s = openStore(t, {}, { migrations: [...MIGRATIONS, M002] });
    expect(s.schemaVersion).toBe(2);
    s.close();
  });
});

describe("pre-migration backup retention", () => {
  it("keeps the newest two versions; a same-version second backup gets a suffix", () => {
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
    expect(preMigrationBackupPath(dir, 3, 42)).toBe(path.join(dir, "store.sqlite.bak-v3-42"));
    expect(preMigrationBackupPath(dir, 4, 42)).toBe(path.join(dir, "store.sqlite.bak-v4"));
    expect(KEEP_BACKUP_VERSIONS).toBe(2);
    expect(prunePreMigrationBackups(dir)).toEqual(["store.sqlite.bak-v1"]);
    expect(readdirSync(dir).sort()).toEqual([
      "store.sqlite.bak-v2",
      "store.sqlite.bak-v3",
      "store.sqlite.bak-v3-1759752000000",
      "unrelated.txt",
    ]);
    expect(prunePreMigrationBackups(path.join(dir, "missing"))).toEqual([]);
  });
});
