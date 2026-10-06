// types.test.ts — src/store/types.ts (plan 01 §5.1, §5.5, §9.2; plan 03 §1.1 step 3; plan 06 §1.3):
// the version error (exit 1, no upstream text), the migration-001 table list and its consistency
// with the write classes, the never-pruned list, the prune policy, and the attach ceiling.
import fc from "fast-check";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { SourceErrorCode } from "../../src/config/freshness.js";
import {
  ESPN_REQUESTS_COLUMNS,
  limiterDecision,
  type CredentialStateRepository,
  type CredentialStateRow,
  type LimiterRepository,
  type LimiterVerdict,
  type RefreshLogRow,
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

describe("B4: the limiter contract — one decision over every window and the daily cap", () => {
  const T = Date.parse("2026-10-05T18:00:00Z");
  const minute = { startMs: T - 60_000, max: 30 };
  const second = { startMs: T - 1000, max: 1 };
  it("records when every window has room and the cap is not reached", () => {
    expect(
      limiterDecision({
        nowMs: T,
        windows: [minute, second],
        windowRows: [[], []],
        dailyCap: null,
      }),
    ).toEqual({ ok: true });
  });
  it("a full minute window waits until its oldest row leaves the window", () => {
    const rows = Array.from({ length: 30 }, (_, i) => T - 59_000 + i * 100);
    expect(
      limiterDecision({
        nowMs: T,
        windows: [minute, second],
        windowRows: [rows, []],
        dailyCap: null,
      }),
    ).toEqual({
      ok: false,
      reason: "window",
      retry_after_ms: 1000,
    });
  });
  it("the per-second window refuses a second request inside 1 s", () => {
    expect(
      limiterDecision({
        nowMs: T,
        windows: [minute, second],
        windowRows: [[T - 400], [T - 400]],
        dailyCap: null,
      }),
    ).toEqual({
      ok: false,
      reason: "window",
      retry_after_ms: 600,
    });
  });
  it("a full daily cap waits to the next day start; a window refusal takes precedence", () => {
    const next = T + 6 * 3600 * 1000;
    expect(
      limiterDecision({
        nowMs: T,
        windows: [minute],
        windowRows: [[]],
        dailyCap: { max: 30, used: 30, nextDayStartMs: next },
      }),
    ).toEqual({ ok: false, reason: "daily_cap", retry_after_ms: 6 * 3600 * 1000 });
    expect(
      limiterDecision({
        nowMs: T,
        windows: [second],
        windowRows: [[T - 10]],
        dailyCap: { max: 30, used: 30, nextDayStartMs: next },
      }),
    ).toMatchObject({ ok: false, reason: "window" });
    expect(
      limiterDecision({
        nowMs: T,
        windows: [],
        windowRows: [],
        dailyCap: { max: 40, used: 39, nextDayStartMs: next },
      }),
    ).toEqual({ ok: true });
  });
  it("property: refused ⇔ some window is full or the cap is used up; the wait is ≥ 1 ms", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 35 }), fc.integer({ min: 0, max: 45 }), (n, used) => {
        const rows = Array.from({ length: n }, (_, i) => T - 59_000 + i * 10);
        const d = limiterDecision({
          nowMs: T,
          windows: [minute],
          windowRows: [rows],
          dailyCap: { max: 40, used, nextDayStartMs: T + 1000 },
        });
        const refuse = n >= 30 || used >= 40;
        return d.ok === !refuse && (d.ok || d.retry_after_ms >= 1);
      }),
    );
  });
  it("espn_requests has the columns the caps, the breaker and the 304 count need (migration 001)", () => {
    expect([...ESPN_REQUESTS_COLUMNS]).toEqual(["id", "ts", "keyless", "origin", "outcome"]);
    expect(PRUNE_POLICY.espn_requests).toMatch(/48 hours/);
  });
});

describe("M2: credential_state transitions serialise (type contract)", () => {
  it("the repository exposes a read-modify-write `transition`", () => {
    expectTypeOf<CredentialStateRepository["transition"]>()
      .parameter(0)
      .toEqualTypeOf<(row: CredentialStateRow | null) => CredentialStateRow | null>();
    expectTypeOf<LimiterRepository["tryRecord"]>().returns.toEqualTypeOf<LimiterVerdict>();
    expectTypeOf<RefreshLogRow["error"]>().toEqualTypeOf<SourceErrorCode | null>();
  });
});
