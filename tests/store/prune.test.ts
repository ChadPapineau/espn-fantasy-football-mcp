// prune.test.ts — `eff store prune` (plan 06 §1.3; plan 01 §5.5, §5.8; T-07): each rule (ESPN cache past
// its longest finite hard limit, snapshots older than 30 days, the bounded points_cache LRU,
// espn_requests past 48 h, dataset debris and unnamable files, backups beyond two versions / four
// weeks, the run directories a killed refresh left under <cache>/tmp) — and the never-pruned tables
// are untouched: same rows after, and the statement trace shows no DELETE/UPDATE on any of them
// (property over random contents).
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { constants as C, DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTempDir } from "../../src/config/paths.js";
import {
  ESPN_CACHE_PRUNE_MS,
  POINTS_CACHE_MAX_ROWS,
  PRUNE_TARGETS,
  pruneStore,
  RUN_TEMP_STALE_MS,
  RUN_TEMP_WALK_MAX,
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
  // Phase 3 (migration 002): every new table is never pruned
  runSql(
    "INSERT INTO parameter_proposal (league_id, season, week, hash, created_at, created_ms, set_json) VALUES ('0', 2026, 1, ?, ?, ?, '{}')",
    String(age).padStart(64, "0").slice(-64),
    at,
    NOW - age,
  );
  runSql(
    "INSERT INTO waiver_run (league_id, season, run_at, run_ms, w, surplus_json, updated_at) VALUES ('0', 2026, ?, ?, 12, '[]', ?)",
    at,
    NOW - age,
    at,
  );
  runSql(
    "INSERT INTO scored_claim (claim_key, league_id, season, week, player_id, logged_at, logged_ms, claim_json) VALUES (?, '0', 2026, 1, 1, ?, ?, '{}')",
    String(age).padStart(64, "c").slice(-64),
    at,
    NOW - age,
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
    expect(report.temp_runs_removed).toEqual([]);
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

  // Stage C, store-prune-skips-tmp-runs: a refresh killed with SIGKILL (a launchd timeout, a reboot)
  // leaves <cache>/tmp/<source>-XXXXXX with its partial downloads; prune never swept them, so only
  // uninstall did. The store clock is NOW; mtimes are set relative to it.
  describe("stale run directories under <cache>/tmp", () => {
    const tmp = (): string => runTempDir(t.cache);
    const at = (p: string, ms: number): void => {
      utimesSync(p, ms / 1000, ms / 1000);
    };
    /** A run directory with one partial download, every entry last modified at `ms`. */
    const runDir = (name: string, ms: number, bytes = 1024): string => {
      const d = path.join(tmp(), name);
      mkdirSync(d, { recursive: true, mode: 0o700 });
      const f = path.join(d, "pbp_2026.parquet.part");
      writeFileSync(f, Buffer.alloc(bytes), { mode: 0o600 });
      at(f, ms);
      at(d, ms);
      return d;
    };

    beforeEach(() => {
      mkdirSync(tmp(), { recursive: true, mode: 0o700 });
    });

    it("a 30-day-old killed run's folder goes (whole tree); a live run's stays", () => {
      const dead = runDir("nflverse_pbp-a1B2c3", NOW - 30 * DAY, 1024 * 1024);
      const live = runDir("nflverse_stats-Zz9Yy8", NOW - 60_000);
      const report = pruneStore(s);
      expect(report.temp_runs_removed).toEqual(["nflverse_pbp-a1B2c3"]);
      expect(existsSync(dead)).toBe(false);
      expect(existsSync(live)).toBe(true);
      expect(readdirSync(tmp())).toEqual(["nflverse_stats-Zz9Yy8"]);
    });

    it("an old folder with ONE fresh entry deep inside is a live run: kept", () => {
      const d = runDir("nflverse_pbp-a1B2c3", NOW - 30 * DAY);
      const inner = path.join(d, "eff-pbp-Q1w2E3");
      mkdirSync(inner, { mode: 0o700 });
      const f = path.join(inner, "chunk.part");
      writeFileSync(f, "x", { mode: 0o600 });
      at(f, NOW - 5 * 60_000); // still downloading
      at(inner, NOW - 30 * DAY);
      at(d, NOW - 30 * DAY);
      expect(pruneStore(s).temp_runs_removed).toEqual([]);
      expect(existsSync(f)).toBe(true);
    });

    it("the bound: untouched for exactly RUN_TEMP_STALE_MS stays, one ms more goes; it is an option", () => {
      runDir("espn_players-AAAAAA", NOW - RUN_TEMP_STALE_MS);
      runDir("espn_players-BBBBBB", NOW - RUN_TEMP_STALE_MS - 1000);
      runDir("backup-CCCCCC", NOW - 2 * 60 * 60_000);
      expect(pruneStore(s).temp_runs_removed).toEqual(["espn_players-BBBBBB"]);
      expect(pruneStore(s, { runTempMaxAgeMs: 60 * 60_000 }).temp_runs_removed).toEqual([
        "backup-CCCCCC",
        "espn_players-AAAAAA",
      ]);
      expect(() => pruneStore(s, { runTempMaxAgeMs: -1 })).toThrow(RangeError);
    });

    it("never touches what is not a private run directory of ours", () => {
      const old = NOW - 90 * DAY;
      const keep = (n: string): string => path.join(tmp(), n);
      writeFileSync(keep("loose-AAAAAA"), "x", { mode: 0o600 }); // a file, not a run directory
      at(keep("loose-AAAAAA"), old);
      runDir("not a run dir", old); // wrong name shape
      runDir("x-short", old); // a 5-char suffix is not mkdtemp's
      const shared = runDir("shared_run-DDDDDD", old);
      chmodSync(shared, 0o750); // group-readable: not mkdtemp's 0700
      at(shared, old);
      const target = path.join(t.root, "elsewhere");
      mkdirSync(target, { mode: 0o700 });
      writeFileSync(path.join(target, "precious"), "x", { mode: 0o600 });
      symlinkSync(target, keep("linked_run-EEEEEE")); // a symlink: never followed or removed
      expect(pruneStore(s).temp_runs_removed).toEqual([]);
      expect(readdirSync(tmp()).sort()).toEqual(
        [
          "linked_run-EEEEEE",
          "loose-AAAAAA",
          "not a run dir",
          "shared_run-DDDDDD",
          "x-short",
        ].sort(),
      );
      expect(existsSync(path.join(target, "precious"))).toBe(true);
    });

    it("a tree past the walk bound is kept (judged live), never half-removed", () => {
      const d = runDir("nflverse_pbp-a1B2c3", NOW - 30 * DAY);
      for (let i = 0; i <= RUN_TEMP_WALK_MAX; i++) {
        const f = path.join(d, `f${String(i)}`);
        writeFileSync(f, "", { mode: 0o600 });
        at(f, NOW - 30 * DAY);
      }
      at(d, NOW - 30 * DAY);
      expect(pruneStore(s).temp_runs_removed).toEqual([]);
      expect(readdirSync(d).length).toBe(RUN_TEMP_WALK_MAX + 2);
    });

    it("a tmp dir that is not ours (group-writable, or a symlink) is never swept; absent is fine", () => {
      runDir("nflverse_pbp-a1B2c3", NOW - 30 * DAY);
      chmodSync(tmp(), 0o770);
      expect(pruneStore(s).temp_runs_removed).toEqual([]);
      chmodSync(tmp(), 0o700);
      // an explicit runTempDir (here: a symlink to the real one) — refused, never followed
      const link = path.join(t.root, "tmp-link");
      symlinkSync(tmp(), link);
      expect(pruneStore(s, { runTempDir: link }).temp_runs_removed).toEqual([]);
      expect(pruneStore(s, { runTempDir: null }).temp_runs_removed).toEqual([]);
      expect(pruneStore(s, { runTempDir: path.join(t.root, "absent") }).temp_runs_removed).toEqual(
        [],
      );
      expect(() => pruneStore(s, { runTempDir: "relative/tmp" })).toThrow(RangeError);
      // files: false leaves run directories alone too
      expect(pruneStore(s, { files: false }).temp_runs_removed).toEqual([]);
      expect(pruneStore(s).temp_runs_removed).toEqual(["nflverse_pbp-a1B2c3"]);
    });

    it("a store laid out outside the cache layout sweeps nothing by default", () => {
      runDir("nflverse_pbp-a1B2c3", NOW - 30 * DAY);
      const odd = openStore(t, { backupDir: path.join(t.root, "other-backups") });
      try {
        expect(pruneStore(odd).temp_runs_removed).toEqual([]);
        expect(pruneStore(odd, { runTempDir: tmp() }).temp_runs_removed).toEqual([
          "nflverse_pbp-a1B2c3",
        ]);
      } finally {
        odd.close();
      }
    });

    it("a stale tree it cannot fully remove is skipped, never fails the prune; the others still go", () => {
      const stuck = runDir("nflverse_pbp-a1B2c3", NOW - 30 * DAY);
      const ro = path.join(stuck, "eff-pbp-Q1w2E3");
      mkdirSync(ro, { mode: 0o700 });
      writeFileSync(path.join(ro, "chunk.part"), "x", { mode: 0o600 });
      at(path.join(ro, "chunk.part"), NOW - 30 * DAY);
      chmodSync(ro, 0o500); // its entries cannot be unlinked
      at(ro, NOW - 30 * DAY);
      at(stuck, NOW - 30 * DAY);
      runDir("espn_players-AAAAAA", NOW - 30 * DAY);
      try {
        const report = pruneStore(s);
        expect(report.temp_runs_removed).toEqual(["espn_players-AAAAAA"]);
        expect(existsSync(path.join(ro, "chunk.part"))).toBe(true);
        expect(report.rows.espn_cache).toBe(0); // the row prune still ran and reported
      } finally {
        chmodSync(ro, 0o700);
      }
    });
  });

  it("refuses bad options and a store it did not open", () => {
    expect(() => pruneStore(s, { now: "later" })).toThrow(RangeError);
    expect(() => pruneStore(s, { espnCacheMaxAgeMs: -1 })).toThrow(RangeError);
    expect(() => pruneStore(s, { pointsCacheMaxRows: 1.5 })).toThrow(RangeError);
    expect(() => pruneStore({} as Store)).toThrow(/not an open store/);
    expect(pruneStore(s, { now: iso(NOW), files: false }).rows.espn_cache).toBe(0);
  });
});
