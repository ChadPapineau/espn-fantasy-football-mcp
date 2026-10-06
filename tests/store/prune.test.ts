// prune.test.ts — `eff store prune` (plan 06 §1.3; plan 01 §5.5, §5.8; T-07): each rule (ESPN cache past
// its longest finite hard limit, snapshots older than 30 days, the bounded points_cache LRU,
// espn_requests past 48 h, dataset debris and unnamable files, backups beyond two versions / four
// weeks) — and the never-pruned tables are untouched: same rows after, and the statement trace shows
// no DELETE/UPDATE on any of them (property over random contents).
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { constants as C, DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ESPN_CACHE_PRUNE_MS,
  POINTS_CACHE_MAX_ROWS,
  PRUNE_TARGETS,
  pruneStore,
  SNAPSHOT_RETENTION_MS,
} from "../../src/store/prune.js";
import { publishJob } from "../../src/store/publisher.js";
import { statementGuardOf } from "../../src/store/store.js";
import { NEVER_PRUNED_TABLES, PRUNE_POLICY, type Store } from "../../src/store/types.js";
import { emptyTables, publishTables } from "./helpers/datasets.js";
import { openPublisher, openStore, tempCache, type TempCache } from "./helpers/env.js";

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

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const DAY = 86_400_000;

function runSql(sql: string, ...args: (string | number | null)[]): void {
  const db = new DatabaseSync(t.storePath);
  try {
    db.prepare(sql).run(...args);
  } finally {
    db.close();
  }
}
function count(table: string): number {
  const db = new DatabaseSync(t.storePath, { readOnly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/** Seeds every never-pruned table with old rows (rows a careless prune would delete). */
function seedNeverPruned(age: number): void {
  const at = iso(NOW - age);
  runSql(
    "INSERT INTO league_settings (league_id, season, settings_hash, scoring_json, slots_json, rules_json, fetched_at, fetched_ms) VALUES ('0', 2026, ?, '{}', '{}', '{}', ?, ?)",
    String(age).padStart(64, "0").slice(-64),
    at,
    NOW - age,
  );
  runSql(
    "INSERT INTO recommendation_log (log_id, league_id, season, week, kind, recorded_at, recorded_ms, settings_hash, client_ref, record_json) VALUES (?, '0', 2026, 1, 'lineup', ?, ?, ?, NULL, '{}')",
    `rec-${String(age).padStart(26, "0")}`.slice(0, 30),
    at,
    NOW - age,
    "a".repeat(64),
  );
  runSql(
    "INSERT INTO recommendation_outcome (log_id, followed, realised, regret, decisive, scored_at, week_final) VALUES (?, 1, 1, 0, 0, ?, 1)",
    `rec-${String(age).padStart(26, "0")}`.slice(0, 30),
    at,
  );
  runSql(
    "INSERT INTO espn_projection (player_id, season, week, week_key, split, applied_total, stats_raw_json, snapshot_at, snapshot_ms) VALUES (1, 2026, 1, 1, 'weekly', 1, '{}', ?, ?)",
    at,
    NOW - age,
  );
  runSql(
    "INSERT INTO scoreboard_snapshot (week, taken_at, taken_ms, matchups_json, playoff_pct_json) VALUES (1, ?, ?, '[]', '{}')",
    at,
    NOW - age,
  );
  runSql(
    "INSERT INTO projection (player_id, gsis_id, season, week, model_version, made_at, made_ms, inputs_as_of, expectation_json, samples) VALUES (1, NULL, 2026, 1, 'v1-ensemble', ?, ?, ?, '{}', x'00')",
    at,
    NOW - age,
    at,
  );
  runSql(
    "INSERT INTO write_journal (journal_id, status, created_at, created_ms, updated_at, payload_json) VALUES (?, 'confirmed_applied', ?, ?, ?, '{}')",
    `j-${String(age)}`,
    at,
    NOW - age,
    at,
  );
  runSql(
    "INSERT INTO guid_pseudonym (guid_sha256, n) VALUES (?, (SELECT COALESCE(MAX(n), 0) + 1 FROM guid_pseudonym))",
    String(age).padStart(64, "f"),
  );
}

describe("the prune targets", () => {
  it("are exactly the PRUNE_POLICY tables, disjoint from the never-pruned list", () => {
    expect([...PRUNE_TARGETS].sort()).toEqual(Object.keys(PRUNE_POLICY).sort());
    for (const tname of PRUNE_TARGETS) expect(NEVER_PRUNED_TABLES).not.toContain(tname);
  });
});

describe("pruneStore", () => {
  it("applies each rule at its boundary", () => {
    // espn_cache: older than 7 days
    for (const [k, age] of [
      ["old", ESPN_CACHE_PRUNE_MS + 1],
      ["edge", ESPN_CACHE_PRUNE_MS],
      ["new", 1000],
    ] as const)
      runSql(
        "INSERT INTO espn_cache (key, parsed_json, fetched_at, fetched_ms, http_status) VALUES (?, '{}', ?, ?, 200)",
        k,
        iso(NOW - age),
        NOW - age,
      );
    // snapshots: older than 30 days
    for (const age of [SNAPSHOT_RETENTION_MS + 1, SNAPSHOT_RETENTION_MS - 1]) {
      runSql(
        "INSERT INTO roster_snapshot (team_id, week, taken_at, taken_ms, roster_json) VALUES (1, 1, ?, ?, '{}')",
        iso(NOW - age),
        NOW - age,
      );
      runSql(
        "INSERT INTO pool_snapshot (week, taken_at, taken_ms, players_json) VALUES (1, ?, ?, '[]')",
        iso(NOW - age),
        NOW - age,
      );
    }
    // espn_requests: older than 48 h
    for (const age of [48 * 3600_000 + 1, 47 * 3600_000])
      runSql(
        "INSERT INTO espn_requests (ts, keyless, origin, outcome) VALUES (?, 1, 'job', 'ok')",
        NOW - age,
      );
    // points_cache: keep the newest N by last write
    for (let i = 0; i < 5; i++)
      runSql(
        "INSERT INTO points_cache (line_hash, settings_hash, result_json, used_ms) VALUES (?, 's', '{}', ?)",
        `l${String(i)}`,
        i,
      );
    seedNeverPruned(400 * DAY);
    const report = pruneStore(s, { pointsCacheMaxRows: 2, files: false });
    expect(report.rows).toEqual({
      espn_cache: 1,
      points_cache: 3,
      roster_snapshot: 1,
      pool_snapshot: 1,
      espn_requests: 1,
    });
    expect(s.repos.espnCache.get("edge")).not.toBeNull();
    expect(s.repos.pointsCache.get("l4", "s")).toBe("{}");
    expect(s.repos.pointsCache.get("l0", "s")).toBeNull();
    for (const tname of NEVER_PRUNED_TABLES) expect(count(tname), tname).toBe(1);
    expect(report.files_removed).toEqual([]);
    expect(report.backups_removed).toEqual([]);
    expect(POINTS_CACHE_MAX_ROWS).toBeGreaterThan(1000);
  });

  it("property: never-pruned tables keep every row and see no DELETE/UPDATE in the trace", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 4000 }), { minLength: 1, maxLength: 4 }),
        fc.integer({ min: 0, max: 10 }),
        (ages, keep) => {
          // children before parents (recommendation_outcome references recommendation_log)
          for (const tname of [
            "recommendation_outcome",
            ...NEVER_PRUNED_TABLES.filter((x) => x !== "recommendation_outcome"),
          ])
            runSql(`DELETE FROM ${tname}`);
          for (const a of ages) seedNeverPruned(a * DAY);
          const before = NEVER_PRUNED_TABLES.map((x) => count(x));
          const guard = statementGuardOf(s);
          guard?.startTrace();
          pruneStore(s, {
            pointsCacheMaxRows: keep,
            espnCacheMaxAgeMs: 0,
            snapshotMaxAgeMs: 0,
            requestRowTtlMs: 0,
            files: false,
          });
          const trace = guard?.stopTrace() ?? [];
          const touched = trace.filter(
            (e) =>
              (e.action === C.SQLITE_DELETE ||
                e.action === C.SQLITE_UPDATE ||
                e.action === C.SQLITE_INSERT) &&
              (NEVER_PRUNED_TABLES as readonly (string | null)[]).includes(e.object),
          );
          const after = NEVER_PRUNED_TABLES.map((x) => count(x));
          return touched.length === 0 && JSON.stringify(before) === JSON.stringify(after);
        },
      ),
      { numRuns: 15 },
    );
  });

  it("files: debris without a live publish, unnamable dataset files and sidecars go; live work stays", async () => {
    const pub = openPublisher(t);
    await publishTables(pub, "nflverse:injuries", "v1", emptyTables("nflverse:injuries"));
    pub.close();
    const ds = t.datasetDir;
    const touch = (n: string): void => {
      writeFileSync(path.join(ds, n), "x", { mode: 0o600 });
    };
    touch("nflverse__schedules.v1.0123456789ab.tmp"); // no publish running → debris
    touch("nflverse__schedules.v1.0123456789ab.tmp-journal");
    touch("espn__players.v2.0123456789ab.tmp"); // a live publish holds the lock → kept
    runSql(
      "INSERT INTO job_lock (job, pid, acquired_at, acquired_ms) VALUES (?, ?, ?, ?)",
      publishJob("espn:players"),
      process.pid,
      iso(NOW),
      NOW,
    );
    touch("unknown__source.sqlite"); // no such source → refresh_log can never name it
    touch("nflverse__injuries.sqlite-journal"); // a sidecar beside a published file
    touch("nflverse__injuries.sqlite-wal");
    touch("notes.txt"); // not ours to judge
    mkdirSync(path.join(ds, "nflverse__players.sqlite")); // a directory: never removed
    symlinkSync(path.join(t.root, "x"), path.join(ds, "nflverse__depth_charts.sqlite"));
    mkdirSync(t.backupDir, { recursive: true, mode: 0o700 });
    for (const n of [
      "store.sqlite.bak-v1",
      "store.sqlite.bak-v2",
      "store.sqlite.bak-v3",
      "store-2026-09-01.sqlite",
      "store-2026-09-08.sqlite",
      "store-2026-09-15.sqlite",
      "store-2026-09-22.sqlite",
      "store-2026-09-29.sqlite",
    ])
      writeFileSync(path.join(t.backupDir, n), "x", { mode: 0o600 });
    const report = pruneStore(s);
    expect(report.files_removed).toEqual([
      "nflverse__depth_charts.sqlite",
      "nflverse__injuries.sqlite-journal",
      "nflverse__injuries.sqlite-wal",
      "nflverse__schedules.v1.0123456789ab.tmp",
      "nflverse__schedules.v1.0123456789ab.tmp-journal",
      "unknown__source.sqlite",
    ]);
    expect(readdirSync(ds).sort()).toEqual([
      "espn__players.v2.0123456789ab.tmp",
      "nflverse__injuries.sqlite",
      "nflverse__players.sqlite",
      "notes.txt",
    ]);
    expect(report.backups_removed).toEqual(["store-2026-09-01.sqlite", "store.sqlite.bak-v1"]);
    // the published dataset is still served
    expect(s.datasets.injuries.reports(2026, 3, null).stamp?.file_version).toBe("v1");
  });

  it("refuses bad options and a store it did not open", () => {
    expect(() => pruneStore(s, { now: "later" })).toThrow(RangeError);
    expect(() => pruneStore(s, { espnCacheMaxAgeMs: -1 })).toThrow(RangeError);
    expect(() => pruneStore(s, { pointsCacheMaxRows: 1.5 })).toThrow(RangeError);
    expect(() => pruneStore({} as Store)).toThrow(/not an open store/);
    expect(pruneStore(s, { now: iso(NOW), files: false }).rows.espn_cache).toBe(0);
  });
});
