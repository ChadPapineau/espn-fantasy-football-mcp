// reclog-scale.perf.test.ts — the recommendation log's reads cost what they read, never what the
// never-pruned log holds (plan 03 §1.2: the loop never blocks longer than one SQLite statement or one
// ≤ 20 ms CPU batch; plan 10 A16a's 50 ms stall bound; src/store/repos/reclog.ts RECLOG_SQL, listSql,
// weekCounts, forWeekPaced). Stage C, reclog-retrospective-unbounded-read, measured on the
// development Mac before the fix: one week's read walked the league's whole log (≈ 17 ms at 34 000
// rows, an empty week included — the (league_id, recorded_ms) index served its ORDER BY), E14's list
// ≈ 17 ms of count plus up to ≈ 21 ms of rows, and E13 read every week up to the scored one in one
// turn (17 weeks at the per-week bound ≈ 240 ms). Here: a 20-season league log, and a season at the
// per-week bound read the way a paced caller reads it (a 1 ms heartbeat measures the loop's longest
// block). Runs in the `process` project (wall-clock budgets never run under coverage).
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecordRecommendationInput } from "../../src/domain/reclog/types.js";
import { newLogId, RECORDS_PER_WEEK_MAX } from "../../src/store/repos/reclog.js";
import type { Store } from "../../src/store/types.js";
import { openStore, percentile, tempCache, type TempCache } from "./helpers/env.js";

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

const AT_MS = Date.parse("2026-10-06T12:00:00.000Z");
const dist = {
  mean: 10,
  p10: 2,
  p25: 5,
  p50: 9,
  p75: 14,
  p90: 19,
  p_zero: 0.05,
  basis: "position_cv",
};

/** A lineup record with 10 alternatives and a note, its action padded by `pad` chars. */
const record = (season: number, week: number, i: number, pad: number): RecordRecommendationInput =>
  ({
    league_id: "0",
    season,
    kind: i % 3 === 0 ? "waiver" : "lineup",
    week,
    rec: {
      action: `Start Test Player ${String(i)} ${"r".repeat(pad)}`,
      subjects: [],
      lineup: null,
      point_estimate: 1.5,
      distribution: dist,
      delta_vs_next: null,
      decision_metric: "expected_points",
      drivers: [],
      assumptions: [],
      confidence: "medium",
      as_of: "2026-10-06T12:00:00.000Z",
      latest_execution_time: null,
      no_move: false,
      log_id: null,
    },
    alternatives: Array.from({ length: 10 }, (_, k) => ({
      action: `Alternative ${String(k)} ${"a".repeat(200)}`,
      point_estimate: 8 + k,
      distribution: dist,
      decision_metric_value: 8 + k,
    })),
    source_calls: [{ tool: "espn_analyze_lineup", request_id: `r-${String(i).padStart(12, "0")}` }],
    settings_hash: "a".repeat(64),
    seeding_mode_used: null,
    followed_hint: "unknown",
    client_ref: null,
    note: "n".repeat(200),
  }) as never;

/**
 * Writes `weeks` full weeks (RECORDS_PER_WEEK_MAX records each) of each season straight into the
 * store file, in one transaction on a second connection — the rows the store itself would write.
 */
function bulk(seasons: readonly number[], weeks: number, pad: number): void {
  const db = new DatabaseSync(t.storePath);
  try {
    const ins = db.prepare(
      `INSERT INTO recommendation_log
       (log_id, league_id, season, week, kind, recorded_at, recorded_ms, settings_hash, client_ref, record_json)
       VALUES (?, '0', ?, ?, ?, ?, ?, ?, NULL, ?)`,
    );
    db.exec("BEGIN");
    let n = 0;
    for (const season of seasons)
      for (let week = 1; week <= weeks; week++)
        for (let i = 0; i < RECORDS_PER_WEEK_MAX; i++) {
          const ms = AT_MS - (2026 - season) * 31_536_000_000 + n++ * 1000;
          const r = record(season, week, i, pad);
          ins.run(
            newLogId(ms),
            season,
            week,
            r.kind,
            new Date(ms).toISOString(),
            ms,
            r.settings_hash,
            JSON.stringify(r),
          );
        }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

/** p95 of `fn`'s wall time (ms) over `n` runs after one warm-up. */
function p95(fn: () => unknown, n = 30): number {
  fn();
  const xs: number[] = [];
  for (let k = 0; k < n; k++) {
    const t0 = performance.now();
    fn();
    xs.push(performance.now() - t0);
  }
  return percentile(xs, 95);
}

/** The longest the event loop was blocked (ms) while `run` ran: a 1 ms heartbeat's widest gap. */
async function longestBlock(run: () => Promise<unknown>): Promise<number> {
  await new Promise((r) => setTimeout(r, 5));
  let last = performance.now();
  let worst = 0;
  const beat = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 1);
  try {
    last = performance.now();
    await run();
    worst = Math.max(worst, performance.now() - last);
  } finally {
    clearInterval(beat);
  }
  return worst;
}

const nextTurn = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

describe("a league log of 20 seasons (34 000 records)", () => {
  it("a week's read, the week counts and E14's list cost what they read, not what the league logged", () => {
    const seasons = Array.from({ length: 20 }, (_, k) => 2026 - k);
    bulk(seasons, 17, 0);
    const log = s.repos.recommendationLog;
    expect(log.weekCounts("0", 2026)).toHaveLength(17);
    const empty = p95(() => log.forWeek("0", 2026, 18));
    const full = p95(() => log.forWeek("0", 2026, 4));
    const counts = p95(() => log.weekCounts("0", 2026));
    const page = { league_id: "0", season: 2026, week: null, kind: null, limit: 25, offset: 0 };
    const e14 = p95(() => log.list(page));
    const e14week = p95(() => log.list({ ...page, week: 4, kind: "waiver" as const }));
    const e14deep = p95(() => log.list({ ...page, limit: 100, offset: 1500 }));
    const completion = p95(() => log.list({ ...page, season: null, limit: 20 }));
    console.log(
      `20-season log: forWeek empty ${empty.toFixed(2)} ms, full ${full.toFixed(2)} ms; weekCounts ${counts.toFixed(2)} ms; list ${e14.toFixed(2)} / week+kind ${e14week.toFixed(2)} / offset 1500 ${e14deep.toFixed(2)} / league-wide ${completion.toFixed(2)} ms (p95)`,
    );
    expect(empty).toBeLessThan(2);
    expect(full).toBeLessThan(15);
    expect(counts).toBeLessThan(2);
    expect(e14).toBeLessThan(5);
    expect(e14week).toBeLessThan(5);
    expect(e14deep).toBeLessThan(15);
    expect(completion).toBeLessThan(5);
  });
});

describe("a season at the per-week bound (17 weeks × 100 records at the E12 input cap)", () => {
  it("read the paced way, no turn blocks the loop more than one page; in one turn it blocked for the whole season", async () => {
    bulk([2026], 17, 15_200);
    const log = s.repos.recommendationLog;
    expect(JSON.stringify(record(2026, 1, 0, 15_200)).length).toBeGreaterThan(19_500);
    const paced: number[] = [];
    for (let k = 0; k < 5; k++)
      paced.push(
        await longestBlock(async () => {
          // what E13 needs: which earlier weeks hold records, and the scored week's records
          const earlier = log.weekCounts("0", 2026).filter((c) => c.week < 17);
          expect(earlier).toHaveLength(16);
          await nextTurn();
          expect(await log.forWeekPaced("0", 2026, 17, nextTurn)).toHaveLength(
            RECORDS_PER_WEEK_MAX,
          );
        }),
      );
    // the shape E13 had: every week up to the scored one, whole, in one turn
    const oneTurn = await longestBlock(() => {
      let n = 0;
      for (let w = 1; w <= 17; w++) n += log.forWeek("0", 2026, w).length;
      expect(n).toBe(17 * RECORDS_PER_WEEK_MAX);
      return Promise.resolve();
    });
    const worst = Math.max(...paced);
    console.log(
      `season at the bound: paced longest block ${worst.toFixed(1)} ms (5 runs); one turn ${oneTurn.toFixed(1)} ms`,
    );
    expect(worst).toBeLessThan(20);
    // the probe sees the defect it guards against
    expect(oneTurn).toBeGreaterThan(5 * worst);
  });
});
