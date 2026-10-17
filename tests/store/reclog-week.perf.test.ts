// reclog-week.perf.test.ts — a full league-week of the recommendation log reads within the stall
// bound (plan 03 §1.2: main-loop stall ≤ 50 ms; src/store/repos/reclog.ts RECORDS_PER_WEEK_MAX,
// RECORD_WEEK_BYTES_MAX). Stage C, reclog-retrospective-unbounded-read: `forWeek` reads a whole week
// synchronously (its keys, then its rows by primary key, a parse per row), and before the bound a
// week grew with every record E12 accepted. At the bound — 100 records at the tool's 20 000-char
// input cap, about 2 MB, the most a week can hold — the read keeps its p95 under 25 ms (half the whole
// stall budget; ≈ 9 ms measured on the development Mac) and the week cannot grow past it. That a
// week's read never grows with the rest of the log is tests/store/reclog-scale.perf.test.ts's. Runs
// in the `process` project (wall-clock budgets never run under coverage).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecordRecommendationInput } from "../../src/domain/reclog/types.js";
import {
  RECORD_WEEK_BYTES_MAX,
  RECORDS_PER_WEEK_MAX,
  RecordWeekFullError,
} from "../../src/store/repos/reclog.js";
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

const AT = "2026-10-06T12:00:00.000Z";
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

/** A lineup record with 10 alternatives, a 200-char note, padded to about 19 900 chars. */
const record = (i: number): RecordRecommendationInput =>
  ({
    league_id: "0",
    season: 2026,
    kind: "lineup",
    week: 4,
    rec: {
      action: `Start Test Player ${String(i)} ${"r".repeat(15_200)}`,
      subjects: [],
      lineup: null,
      point_estimate: 1.5,
      distribution: dist,
      delta_vs_next: null,
      decision_metric: "expected_points",
      drivers: [],
      assumptions: [],
      confidence: "medium",
      as_of: AT,
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
    client_ref: `ref-${String(i)}`,
    note: "n".repeat(200),
  }) as never;

describe("a full league-week", () => {
  it("100 records at the input cap: forWeek p95 < 25 ms, and the week takes no more", () => {
    const log = s.repos.recommendationLog;
    expect(JSON.stringify(record(0)).length).toBeGreaterThan(19_500);
    expect(JSON.stringify(record(0)).length).toBeLessThanOrEqual(20_000);
    for (let i = 0; i < RECORDS_PER_WEEK_MAX; i++) log.record(record(i), AT);
    expect(() => log.record(record(RECORDS_PER_WEEK_MAX), AT)).toThrow(RecordWeekFullError);
    // the count binds here, at about 2 MB; no week of fewer, larger records holds more than the
    // byte budget, which is within 5 % of this one
    expect(RECORDS_PER_WEEK_MAX * 20_000).toBeLessThanOrEqual(RECORD_WEEK_BYTES_MAX);
    expect(RECORD_WEEK_BYTES_MAX).toBeLessThan(RECORDS_PER_WEEK_MAX * 20_000 * 1.05);
    log.forWeek("0", 2026, 4); // warm the statement cache
    const lat: number[] = [];
    for (let k = 0; k < 30; k++) {
      const t0 = performance.now();
      const rows = log.forWeek("0", 2026, 4);
      lat.push(performance.now() - t0);
      expect(rows).toHaveLength(RECORDS_PER_WEEK_MAX);
    }
    expect(percentile(lat, 95)).toBeLessThan(25);
  });
});
