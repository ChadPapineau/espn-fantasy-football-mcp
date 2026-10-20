// refresh-log-plans.test.ts — every refresh_log read the server runs is a fixed number of index seeks,
// never a walk of the history (src/store/repos/ops.ts REFRESH_LOG_SQL; plan 03 §1.2: the loop never
// blocks longer than one bounded SQLite statement; plan 10 A16a's 50 ms stall bound). Stage C,
// store-refresh-log-unpruned-status-stall: G1 (espn_get_status, espn-ff://status, …/freshness) reads
// `current()` and `latest()` once per listed source, `current()` visited every row the table ever
// held (a correlated MAX per row) and `latest()` sorted every row of its source — 60–600 ms of loop
// stall over a season's ≈ 390 publishes a day. The plans are read on the store's own connection over
// a history in every source with failures and an unknown source; the answers are checked against
// the pre-fix statements on the same rows (same rows, same order), and a positive control shows the
// plan check sees the pre-fix scan. The wall-clock side is tests/store/refresh-log-scale.perf.test.ts.
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATASET_SOURCE_IDS } from "../../src/config/freshness.js";
import { REFRESH_LOG_SQL } from "../../src/store/repos/ops.js";
import { storeInternalsOf } from "../../src/store/store.js";
import type { Store } from "../../src/store/types.js";
import { openStore, tempCache, type TempCache } from "./helpers/env.js";

let t: TempCache;
let s: Store;

/** A history: every known source with successes and failures in a mixed order, plus an unknown id. */
function seedHistory(path: string, perSource: number): void {
  const db = new DatabaseSync(path);
  try {
    const ins = db.prepare(
      `INSERT INTO refresh_log (source, file, file_version, release_updated_at, seasons_json, rows,
         columns_hash, started_at, finished_at, ok, error, checked_at)
       VALUES (?, ?, ?, NULL, '[2026]', 10, 'h', ?, ?, ?, ?, ?)`,
    );
    db.exec("BEGIN");
    const sources = [...DATASET_SOURCE_IDS, "retired:source"];
    for (let i = 0; i < perSource; i++)
      for (const [k, source] of sources.entries()) {
        // a source that never succeeded, a source whose newest row is a failure, the rest mixed
        const ok = source === "odds:the_odds_api" ? 0 : (i + k) % 5 === 0 ? 0 : 1;
        const at = new Date(
          Date.parse("2026-08-01T00:00:00.000Z") + (i * 40 + k) * 60_000,
        ).toISOString();
        ins.run(
          source,
          ok ? `/c/${source}.sqlite` : null,
          ok ? `v${String(i)}` : null,
          at,
          at,
          ok,
          ok ? null : "UPSTREAM_UNAVAILABLE",
          at,
        );
      }
    // weather:nws ends on a failure streak of three
    for (let j = 0; j < 3; j++) {
      const at = new Date(Date.parse("2026-10-01T00:00:00.000Z") + j * 60_000).toISOString();
      ins.run("weather:nws", null, null, at, at, 0, "UPSTREAM_UNAVAILABLE", at);
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

beforeAll(() => {
  t = tempCache();
  s = openStore(t);
  seedHistory(t.storePath, 60);
});
afterAll(() => {
  s.close();
  t.cleanup();
});

/** The query plan of `sql` on the store's own connection, one detail line per step. */
function plan(sql: string, args: Record<string, string>): string[] {
  const db = storeInternalsOf(s)?.db;
  if (db === undefined) throw new Error("no store connection");
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(args) as { detail: string }[]).map(
    (r) => r.detail,
  );
}

const SEEK = "USING COVERING INDEX refresh_log__source_ok_id (source=? AND ok=?";
const ARGS: Record<keyof typeof REFRESH_LOG_SQL, Record<string, string>> = {
  current: { sources: JSON.stringify(DATASET_SOURCE_IDS) },
  latest: { s: "news:espn" },
  consecutiveFailures: { s: "news:espn" },
};

describe("refresh_log reads: index seeks, never a walk of the history", () => {
  it.each(Object.keys(REFRESH_LOG_SQL) as (keyof typeof REFRESH_LOG_SQL)[])("%s", (name) => {
    const p = plan(REFRESH_LOG_SQL[name], ARGS[name]);
    // no step scans the table or sorts its rows (the only ORDER BY sorts one row per known source)
    expect(
      p.some((d) => /^SCAN (refresh_log|r|c)\b/.test(d)),
      p.join("\n"),
    ).toBe(false);
    for (const d of p.filter((x) => /\brefresh_log\b|^SEARCH (r|c)\b/.test(x)))
      expect(d).toMatch(
        /USING (COVERING INDEX refresh_log__source_ok_id \(source=\? AND ok=\?|INTEGER PRIMARY KEY \(rowid=\?\))/,
      );
    expect(p.some((d) => d.includes(SEEK))).toBe(true);
  });

  it("positive control: the pre-fix current() visited every row and latest() sorted its source", () => {
    const before = `SELECT r.* FROM refresh_log AS r
      WHERE r.ok = 1 AND r.id = (SELECT MAX(id) FROM refresh_log WHERE source = r.source AND ok = 1)
      ORDER BY r.source`;
    expect(plan(before, {}).some((d) => d.startsWith("SCAN r"))).toBe(true);
    const latestBefore = "SELECT * FROM refresh_log WHERE source = :s ORDER BY id DESC LIMIT 1";
    expect(plan(latestBefore, { s: "news:espn" })).toContain("USE TEMP B-TREE FOR ORDER BY");
  });
});

describe("the answers are the pre-fix answers", () => {
  const raw = (sql: string, args: Record<string, string> = {}): unknown[] => {
    const db = new DatabaseSync(t.storePath, { readOnly: true });
    try {
      return db.prepare(sql).all(args);
    } finally {
      db.close();
    }
  };

  it("current(): the newest success of each known source, in source order (an unknown id never)", () => {
    const want = raw(
      `SELECT r.source, r.file_version, r.finished_at FROM refresh_log AS r
       WHERE r.ok = 1 AND r.id = (SELECT MAX(id) FROM refresh_log WHERE source = r.source AND ok = 1)
       ORDER BY r.source`,
    ).filter((r) =>
      (DATASET_SOURCE_IDS as readonly string[]).includes((r as { source: string }).source),
    );
    const got = s.repos.refreshLog
      .current()
      .map((r) => ({ source: r.source, file_version: r.file_version, finished_at: r.finished_at }));
    expect(got).toEqual(want.map((r) => ({ ...(r as object) })));
    expect(got.map((r) => r.source)).not.toContain("odds:the_odds_api"); // never succeeded
    expect(got.length).toBe(DATASET_SOURCE_IDS.length - 1);
  });

  it("latest(): the newest row of the source, success or failure; consecutiveFailures unchanged", () => {
    for (const source of DATASET_SOURCE_IDS) {
      const [want] = raw(
        "SELECT id, ok, error FROM refresh_log WHERE source = :s ORDER BY id DESC LIMIT 1",
        {
          s: source,
        },
      ) as { ok: number; error: string | null }[];
      const got = s.repos.refreshLog.latest(source);
      expect(got?.ok, source).toBe(want?.ok === 1);
      expect(got?.error ?? null, source).toBe(want?.error ?? null);
    }
    expect(s.repos.refreshLog.latest("weather:nws")).toMatchObject({
      ok: false,
      error: "UPSTREAM_UNAVAILABLE",
    });
    expect(s.repos.refreshLog.consecutiveFailures("weather:nws")).toBeGreaterThanOrEqual(3);
    expect(s.repos.refreshLog.consecutiveFailures("odds:the_odds_api")).toBe(60);
  });
});
