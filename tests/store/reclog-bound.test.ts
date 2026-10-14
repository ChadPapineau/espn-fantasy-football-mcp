// reclog-bound.test.ts — the recommendation log's per-league-week bound (src/store/repos/reclog.ts
// RECORDS_PER_WEEK_MAX, RECORD_WEEK_BYTES_MAX; plan 03 §1.2's stall bound). Stage C,
// reclog-retrospective-unbounded-read: E13 reads a whole week with one synchronous statement plus a
// parse per row, the log is never pruned and E12 had no per-week cap, so the read grew without bound
// with the week's record count (400 records: a 71 ms stall). A week now holds at most 100 records and
// 2 MiB of stored UTF-8: the next record is refused (VALIDATION, `week_record_limit`), nothing is
// written (no row, no pseudonym), a deduplicated re-record still answers, and other weeks, seasons and
// leagues are untouched.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecordRecommendationInput } from "../../src/domain/reclog/types.js";
import { classifyError } from "../../src/mcp/errors.js";
import {
  RECORD_JSON_MAX,
  RECORD_WEEK_BYTES_MAX,
  RECORDS_PER_WEEK_MAX,
  RecordWeekFullError,
} from "../../src/store/repos/reclog.js";
import type { Store } from "../../src/store/types.js";
import { openStore, tempCache, type TempCache } from "./helpers/env.js";

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
const input = (
  i: number,
  over: Partial<RecordRecommendationInput> = {},
): RecordRecommendationInput =>
  ({
    league_id: "0",
    season: 2026,
    kind: "lineup",
    week: 4,
    rec: {
      action: `Start Test Player ${String(i)}`,
      subjects: [],
      lineup: null,
      point_estimate: 1.5,
      distribution: null,
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
    alternatives: [],
    source_calls: [],
    settings_hash: "a".repeat(64),
    seeding_mode_used: null,
    followed_hint: "unknown",
    client_ref: `ref-${String(i)}`,
    note: null,
    ...over,
  }) as never;
/** `input(i)` whose action carries `pad` (the store takes up to RECORD_JSON_MAX; E12 caps at 20 000). */
const padded = (i: number, pad: string): RecordRecommendationInput =>
  input(i, { rec: { ...input(i).rec, action: `${pad}${String(i)}` } });

/** The single number `sql` selects as `n`, read on a separate read-only connection. */
const scalar = (sql: string, ...args: (string | number)[]): number => {
  const db = new DatabaseSync(t.storePath, { readOnly: true });
  try {
    return (db.prepare(sql).get(...args) as { n: number }).n;
  } finally {
    db.close();
  }
};
const rowsIn = (week: number): number =>
  scalar("SELECT COUNT(*) AS n FROM recommendation_log WHERE week = ?", week);
/** The stored UTF-8 bytes of a week (what RECORD_WEEK_BYTES_MAX bounds). */
const bytesIn = (week: number): number =>
  scalar(
    "SELECT COALESCE(SUM(LENGTH(CAST(record_json AS BLOB))), 0) AS n FROM recommendation_log WHERE week = ?",
    week,
  );
/**
 * Records `make(0), make(1), …` until the week refuses one; returns how many it took. A week can never
 * take more than RECORDS_PER_WEEK_MAX, so going past that fails the test (never an endless loop).
 */
const fill = (make: (i: number) => RecordRecommendationInput): number => {
  const log = s.repos.recommendationLog;
  for (let n = 0; n <= RECORDS_PER_WEEK_MAX; n++) {
    try {
      log.record(make(n), AT);
    } catch (e) {
      expect(e).toBeInstanceOf(RecordWeekFullError);
      return n;
    }
  }
  throw new Error(`the week took more than ${String(RECORDS_PER_WEEK_MAX)} records`);
};

describe("the per-league-week bound", () => {
  it("the 101st record of a week is refused as VALIDATION and writes nothing; dedup still answers", () => {
    const log = s.repos.recommendationLog;
    for (let i = 0; i < RECORDS_PER_WEEK_MAX; i++) log.record(input(i), AT);
    expect(rowsIn(4)).toBe(RECORDS_PER_WEEK_MAX);
    let thrown: unknown;
    try {
      log.record(input(RECORDS_PER_WEEK_MAX), AT);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RecordWeekFullError);
    // the tool answers a typed refusal, never INTERNAL (src/mcp/errors.ts reads the own effCode)
    expect(classifyError(thrown)).toEqual({
      code: "VALIDATION",
      details: { reason: "week_record_limit" },
    });
    // a record without a client_ref is refused the same way
    expect(() => log.record(input(500, { client_ref: null }), AT)).toThrow(RecordWeekFullError);
    expect(rowsIn(4)).toBe(RECORDS_PER_WEEK_MAX);
    // a re-record of an existing client_ref is a dedup hit (idempotent), never a refusal
    expect(log.record(input(7), AT)).toMatchObject({ deduplicated: true, week: 4 });
    // every reader of the week sees a bounded set
    expect(log.forWeek("0", 2026, 4)).toHaveLength(RECORDS_PER_WEEK_MAX);
  });

  it("the bound is per league-week: another week, season or league records freely", () => {
    const log = s.repos.recommendationLog;
    for (let i = 0; i < RECORDS_PER_WEEK_MAX; i++) log.record(input(i), AT);
    expect(log.record(input(0, { week: 5 }), AT).deduplicated).toBe(false);
    expect(log.record(input(0, { season: 2027 }), AT).deduplicated).toBe(false);
    expect(log.record(input(0, { league_id: "1" }), AT).deduplicated).toBe(false);
    // the same league-week under another kind counts against the same bound
    expect(() => log.record(input(1, { kind: "waiver" }), AT)).toThrow(RecordWeekFullError);
  });

  it("the stored-bytes budget refuses a record that would carry the week past it", () => {
    // 50 000-char records: the byte budget binds long before the count does
    const n = fill((i) => padded(i, "x".repeat(50_000)));
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(RECORDS_PER_WEEK_MAX);
    expect(bytesIn(4)).toBeLessThanOrEqual(RECORD_WEEK_BYTES_MAX);
    expect(bytesIn(4) + 50_000).toBeGreaterThan(RECORD_WEEK_BYTES_MAX); // the next one would pass it
    // a small record still fits when it stays under the budget
    expect(s.repos.recommendationLog.record(input(999), AT).deduplicated).toBe(false);
    // any record the store accepts at all fits an empty week
    expect(RECORD_WEEK_BYTES_MAX).toBeGreaterThanOrEqual(RECORD_JSON_MAX * 2);
    const big = input(0, {
      week: 6,
      rec: { ...input(0).rec, action: "y".repeat(RECORD_JSON_MAX - 2_000) },
    });
    expect(s.repos.recommendationLog.record(big, AT)).toMatchObject({
      week: 6,
      deduplicated: false,
    });
  });

  it("multi-byte text weighs its stored UTF-8 bytes, not its JS length", () => {
    // 30 000 three-byte characters: about 90 000 stored bytes a record, so about 23 fit where about
    // 68 ASCII records of the same JS length would
    const euro = "€".repeat(30_000);
    const n = fill((i) => padded(i, euro));
    expect(n).toBeLessThan(Math.ceil(RECORD_WEEK_BYTES_MAX / 30_000) / 2);
    expect(bytesIn(4)).toBeLessThanOrEqual(RECORD_WEEK_BYTES_MAX);
    expect(bytesIn(4) + 90_000).toBeGreaterThan(RECORD_WEEK_BYTES_MAX);
  });

  it("a refused record leaves nothing behind: no row, and no pseudonym for a GUID it carried", () => {
    // an invented GUID, assembled at run time so the brace-GUID scanner never sees a literal one
    const guid = ["{", ["5A5A5A5A", "1B1B", "4C4C", "8D8D", "0E0E0E0E0E0E"].join("-"), "}"].join(
      "",
    );
    const log = s.repos.recommendationLog;
    for (let i = 0; i < RECORDS_PER_WEEK_MAX; i++) log.record(input(i), AT);
    const pseudonyms = (): number => scalar("SELECT COUNT(*) AS n FROM guid_pseudonym");
    const before = pseudonyms();
    expect(() => log.record(input(RECORDS_PER_WEEK_MAX, { note: `owner ${guid}` }), AT)).toThrow(
      RecordWeekFullError,
    );
    expect(pseudonyms()).toBe(before);
    expect(rowsIn(4)).toBe(RECORDS_PER_WEEK_MAX);
    // the same GUID in another week is pseudonymised as usual
    log.record(input(0, { week: 5, note: `owner ${guid}` }), AT);
    expect(pseudonyms()).toBe(before + 1);
  });
});
