// types.test.ts — src/store/types.ts (plan 01 §5.1, §5.5, §9.2; plan 03 §1.1 step 3; plan 06 §1.3):
// the version error (exit 1, no upstream text), the migration-001 table list and its consistency
// with the write classes, the never-pruned list, the prune policy, and the attach ceiling.
import { describe, expect, it } from "vitest";
import {
  BUSY_TIMEOUT_MS,
  MAX_ON_DEMAND_ATTACHMENTS,
  MIGRATION_001_TABLES,
  NEVER_PRUNED_TABLES,
  PRUNE_POLICY,
  PUBLISH_ALREADY_CURRENT,
  SQLITE_ATTACH_LIMIT,
  StoreVersionError,
  WRITE_CLASS,
} from "../../src/store/types.js";

describe("StoreVersionError", () => {
  it("names both versions, maps to INTERNAL and exit 1", () => {
    const e = new StoreVersionError(3, 1);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("StoreVersionError");
    expect(e.effCode).toBe("INTERNAL");
    expect(e.exitCode).toBe(1);
    expect(e.storeVersion).toBe(3);
    expect(e.binaryVersion).toBe(1);
    expect(e.message).toBe(
      "store.sqlite was written by a newer version (v3); this binary supports v1. Upgrade the package or restore the backup.",
    );
  });
});

describe("tables", () => {
  it("migration 001: distinct snake-case names, no dataset (ds_*) table", () => {
    expect(new Set(MIGRATION_001_TABLES).size).toBe(MIGRATION_001_TABLES.length);
    for (const t of MIGRATION_001_TABLES) {
      expect(t).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(t.startsWith("ds_"), t).toBe(false);
    }
    for (const t of [
      "credential_state",
      "drift_state",
      "espn_requests",
      "recommendation_log",
      "write_journal",
    ])
      expect(MIGRATION_001_TABLES).toContain(t);
  });
  it("every table but schema_version has exactly one write class", () => {
    const classed = Object.keys(WRITE_CLASS).sort();
    expect(classed).toEqual(MIGRATION_001_TABLES.filter((t) => t !== "schema_version").sort());
    for (const c of Object.values(WRITE_CLASS)) expect(["best_effort", "required"]).toContain(c);
  });
  it("the request ledger fails closed; only caches are best-effort", () => {
    expect(WRITE_CLASS.espn_requests).toBe("required");
    expect(WRITE_CLASS.credential_state).toBe("required");
    expect(WRITE_CLASS.recommendation_log).toBe("required");
    expect(
      Object.entries(WRITE_CLASS)
        .filter(([, c]) => c === "best_effort")
        .map(([t]) => t)
        .sort(),
    ).toEqual(["espn_cache", "points_cache", "projection"]);
  });
  it("never-pruned and pruned tables are disjoint subsets of the migration", () => {
    for (const t of NEVER_PRUNED_TABLES) {
      expect(MIGRATION_001_TABLES).toContain(t);
      expect(PRUNE_POLICY[t], t).toBeUndefined();
    }
    for (const t of Object.keys(PRUNE_POLICY)) expect(MIGRATION_001_TABLES).toContain(t);
    expect(NEVER_PRUNED_TABLES).toContain("recommendation_log");
    expect(NEVER_PRUNED_TABLES).toContain("recommendation_outcome");
    expect(Object.isFrozen(NEVER_PRUNED_TABLES)).toBe(true);
    expect(Object.isFrozen(PRUNE_POLICY)).toBe(true);
  });
});

describe("connection constants", () => {
  it("busy timeout, attach ceiling below SQLite's limit, publish sentinel", () => {
    expect(BUSY_TIMEOUT_MS).toBe(5000);
    expect(SQLITE_ATTACH_LIMIT).toBe(10);
    expect(MAX_ON_DEMAND_ATTACHMENTS).toBe(8);
    expect(MAX_ON_DEMAND_ATTACHMENTS).toBeLessThan(SQLITE_ATTACH_LIMIT);
    expect(PUBLISH_ALREADY_CURRENT).toBe("already_current");
  });
});
