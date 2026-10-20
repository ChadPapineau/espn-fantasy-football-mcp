// refresh-log-scale.perf.test.ts — G1's freshness read stays inside the stall bound whatever the
// refresh_log history holds (plan 03 §1.2: main-loop stall ≤ 50 ms; plan 10 A16a; src/store/repos/ops.ts
// REFRESH_LOG_SQL). Stage C, store-refresh-log-unpruned-status-stall: one row per publish (news ×3
// every 15 min, trending every 30, weather and the schedule hourly: ≈ 390 a day in season) and G1
// reads `current()` and `latest()` once per listed source in one synchronous turn — measured 60 ms
// of stall at 10 000 rows and 590 ms at 100 000 (each `latest` sorted its source's rows: ≈ 38 ms
// apiece at 100 000). Here: 100 000 rows (more than a season's worth with no prune at all) in the
// per-day mix, and the reads G1 makes for all 16 `full` sources plus weather — current(), latest()
// and consecutiveFailures() each — repeated; their p95 must stay under 20 ms, two-fifths of the stall
// budget (≈ 8 ms measured on the development Mac under a load average of 20–30, ≈ 4 ms at 100 rows).
// The query plans themselves are tests/store/refresh-log-plans.test.ts's. Runs in the `process`
// project (wall-clock budgets never run under coverage).
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatasetSourceId } from "../../src/config/freshness.js";
import type { Store } from "../../src/store/types.js";
import { openStore, percentile, tempCache, type TempCache } from "./helpers/env.js";

let t: TempCache;
let s: Store;

/** The in-season mix of one day's publishes (plan 06 §1.3 cadences), by source. */
const PER_DAY: readonly (readonly [DatasetSourceId, number])[] = [
  ["news:rotowire", 96],
  ["news:espn", 96],
  ["news:cbs", 96],
  ["sleeper:trending", 48],
  ["weather:open_meteo", 24],
  ["espn:pro_schedule", 24],
  ["nflverse:stats_player_week", 2],
  ["nflverse:roster_weekly", 1],
  ["nflverse:injuries", 2],
  ["nflverse:pbp", 1],
];

/** G1's listed sources under `full` (src/mcp/tools/ops.ts statusSources): 17 reads per call. */
const G1_SOURCES: readonly DatasetSourceId[] = [
  "espn:pro_schedule",
  "espn:players",
  "nflverse:stats_player_week",
  "nflverse:stats_team_week",
  "nflverse:injuries",
  "nflverse:depth_charts",
  "nflverse:roster_weekly",
  "nflverse:players",
  "nflverse:schedules",
  "nflverse:pbp",
  "nflverse:snap_counts",
  "ffopportunity:ep_weekly",
  "sleeper:trending",
  "news:rotowire",
  "news:espn",
  "news:cbs",
  "weather:open_meteo",
];

const ROWS = 100_000;

beforeAll(() => {
  t = tempCache();
  s = openStore(t);
  const db = new DatabaseSync(t.storePath);
  try {
    const ins = db.prepare(
      `INSERT INTO refresh_log (source, file, file_version, release_updated_at, seasons_json, rows,
         columns_hash, started_at, finished_at, ok, error, checked_at)
       VALUES (?, ?, ?, NULL, '[2026]', 10, 'h', ?, ?, ?, ?, ?)`,
    );
    const day: DatasetSourceId[] = PER_DAY.flatMap(([src, n]) =>
      Array.from({ length: n }, () => src),
    );
    db.exec("BEGIN");
    for (let i = 0; i < ROWS; i++) {
      const source = day[i % day.length] ?? "news:espn";
      const ok = i % 23 === 0 ? 0 : 1;
      const at = new Date(Date.parse("2026-09-01T00:00:00.000Z") + i * 200_000).toISOString();
      ins.run(
        source,
        ok ? `/c/${source}.sqlite` : null,
        ok ? `b${String(i)}` : null,
        at,
        at,
        ok,
        ok ? null : "UPSTREAM_UNAVAILABLE",
        at,
      );
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
});
afterAll(() => {
  s.close();
  t.cleanup();
});

describe(`G1's refresh_log read over ${String(ROWS)} rows`, () => {
  it("one call's reads (current() and latest() per listed source, as G1 makes them) keep p95 under 20 ms", () => {
    const rl = s.repos.refreshLog;
    const call = (): number => {
      const t0 = performance.now();
      for (const id of G1_SOURCES) {
        rl.current().find((r) => r.source === id);
        rl.latest(id);
        rl.consecutiveFailures(id);
      }
      return performance.now() - t0;
    };
    for (let i = 0; i < 5; i++) call(); // warm the statement cache and the page cache
    const ms = Array.from({ length: 40 }, call);
    expect(percentile(ms, 95)).toBeLessThan(20);
    // and it reads the same thing a smaller table would: the newest success of each source
    expect(rl.current().length).toBe(PER_DAY.length);
  });
});
