// reclog-paged.test.ts — the recommendation log's paced reads and batched outcome writes (src/store/
// repos/reclog.ts planWeekPages, weekCounts, forWeekPaced, recordOutcomes, list; src/store/types.ts
// RecommendationLogStore; plan 03 §1.2: the loop never blocks longer than one SQLite statement or one
// ≤ 20 ms CPU batch). Stage C, reclog-retrospective-unbounded-read: E13 read every week up to the
// scored one, whole, in one turn — the per-week bound capped one week, not the season (17 full weeks:
// ≈ 240 ms) — so the store serves what a paced caller needs: which weeks hold records, from the index
// alone; a week in pages of at most WEEK_PAGE_ROWS_MAX records and WEEK_PAGE_BYTES_MAX bytes with the
// caller's pace awaited between pages (each turn's parses are counted here through JSON.parse); a
// scored week's outcomes in one transaction. `list` (E14), rewritten to plain equality terms and a
// page of ids first, answers exactly what a reference model over the same log answers.
import { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bareUntrusted } from "../../src/domain/league/types.js";
import type {
  RecommendationKind,
  RecommendationOutcome,
  RecordRecommendationInput,
} from "../../src/domain/reclog/types.js";
import {
  newLogId,
  OUTCOMES_PER_BATCH_MAX,
  planWeekPages,
  WEEK_PAGE_BYTES_MAX,
  WEEK_PAGE_ROWS_MAX,
  type WeekKey,
} from "../../src/store/repos/reclog.js";
import { statementGuardOf } from "../../src/store/store.js";
import { StoreBusyError, type Store } from "../../src/store/types.js";
import { openStore, tempCache, type TempCache } from "./helpers/env.js";
import { run, type Child } from "./helpers/spawn.js";

let t: TempCache;
let s: Store;
let holder: Child | null = null;
beforeEach(() => {
  t = tempCache();
  s = openStore(t);
});
afterEach(async () => {
  if (holder !== null) {
    holder.proc.kill("SIGKILL");
    await holder.exited();
    holder = null;
  }
  s.close();
  t.cleanup();
});

const input = (
  i: number,
  over: Partial<RecordRecommendationInput> = {},
  pad = "",
): RecordRecommendationInput =>
  ({
    league_id: "0",
    season: 2026,
    kind: "lineup",
    week: 4,
    rec: {
      action: `Start Test Player ${String(i)}${pad}`,
      subjects: [],
      lineup: null,
      point_estimate: 1.5,
      distribution: null,
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
    alternatives: [],
    source_calls: [],
    settings_hash: "a".repeat(64),
    seeding_mode_used: null,
    followed_hint: "unknown",
    client_ref: `ref-${String(i)}`,
    note: null,
    ...over,
  }) as never;

/** An instant `i` seconds after noon (i < 3600). */
const at = (i: number): string =>
  new Date(Date.parse("2026-10-06T12:00:00.000Z") + i * 1000).toISOString();

/** A pace that counts its calls and lets the event loop run (setImmediate). */
function pacer(): { pace: () => Promise<void>; calls: () => number } {
  let n = 0;
  return {
    pace: () => {
      n += 1;
      return new Promise((resolve) => {
        setImmediate(resolve);
      });
    },
    calls: () => n,
  };
}

describe("planWeekPages", () => {
  const key = (i: number, bytes: number): WeekKey => ({ log_id: `k${String(i)}`, bytes });

  it("cases: empty; a page closes at the row bound and before the key that would pass the byte bound; a large key alone", () => {
    expect(planWeekPages([])).toEqual([]);
    expect(planWeekPages([key(0, 10 * WEEK_PAGE_BYTES_MAX)])).toEqual([["k0"]]);
    expect(
      planWeekPages(
        [0, 1, 2, 3, 4].map((i) => key(i, 1)),
        2,
        100,
      ),
    ).toEqual([["k0", "k1"], ["k2", "k3"], ["k4"]]);
    expect(
      planWeekPages([key(0, 60), key(1, 40), key(2, 1), key(3, 500), key(4, 1)], 10, 100),
    ).toEqual([["k0", "k1"], ["k2"], ["k3"], ["k4"]]);
  });

  it("property: an ordered partition; every page within both bounds unless one key alone; greedy", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 2_000 }), { maxLength: 300 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 1_000 }),
        (sizes, rows, bytes) => {
          const keys = sizes.map((b, i) => key(i, b));
          const size = new Map(keys.map((k) => [k.log_id, k.bytes]));
          const sum = (p: readonly string[]): number =>
            p.reduce((a, id) => a + (size.get(id) ?? 0), 0);
          const pages = planWeekPages(keys, rows, bytes);
          expect(pages.flat()).toEqual(keys.map((k) => k.log_id));
          for (const p of pages) {
            expect(p.length).toBeGreaterThan(0);
            expect(p.length).toBeLessThanOrEqual(rows);
            if (p.length > 1) expect(sum(p)).toBeLessThanOrEqual(bytes);
          }
          // a page closed only because the next key could not join it
          for (let i = 0; i + 1 < pages.length; i++) {
            const p = pages[i] ?? [];
            const first = pages[i + 1]?.[0] ?? "";
            expect(p.length === rows || sum(p) + (size.get(first) ?? 0) > bytes).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("forWeekPaced", () => {
  it("returns forWeek's records in forWeek's order: ties, large and small records, other weeks out", async () => {
    const log = s.repos.recommendationLog;
    // ties on recorded_at (log_id breaks them), records past the page's byte bound, and neighbours
    for (let i = 0; i < 30; i++) log.record(input(i), at(i % 7));
    for (let i = 30; i < 33; i++) log.record(input(i, {}, "x".repeat(300_000)), at(i));
    log.record(input(0, { week: 5 }), at(0));
    log.record(input(0, { season: 2025 }), at(0));
    log.record(input(0, { league_id: "1" }), at(0));
    const { pace, calls } = pacer();
    const paced = await log.forWeekPaced("0", 2026, 4, pace);
    expect(paced).toEqual(log.forWeek("0", 2026, 4));
    expect(paced).toHaveLength(33);
    // four pages — the 30 small records, then each large one alone — and a pace before the read,
    // between the pages and after the last
    expect(calls()).toBe(4 + 1);
  });

  it("no turn parses more than one page: at most WEEK_PAGE_ROWS_MAX records, WEEK_PAGE_BYTES_MAX bytes", async () => {
    const log = s.repos.recommendationLog;
    // 40 records of about 19 KB (pages bound by bytes) then 60 tiny ones (pages bound by rows)
    for (let i = 0; i < 40; i++) log.record(input(i, {}, "r".repeat(19_000)), at(i));
    for (let i = 40; i < 100; i++) log.record(input(i), at(i));
    const parse = vi.spyOn(JSON, "parse");
    const turns: number[] = [];
    const paced = await log.forWeekPaced("0", 2026, 4, () => {
      turns.push(parse.mock.calls.length);
      return new Promise((resolve) => {
        setImmediate(resolve);
      });
    });
    expect(paced).toHaveLength(100);
    // the stored record texts parsed (the store serialises `league_id` first), with their turn
    const isRecord = (c: unknown[]): boolean => String(c[0]).startsWith('{"league_id":');
    const all = parse.mock.calls;
    expect(all.filter(isRecord)).toHaveLength(100); // one parse per record
    expect(all.slice(0, turns[0]).filter(isRecord)).toEqual([]); // none before the first pace
    expect(all.slice(turns.at(-1)).filter(isRecord)).toEqual([]); // none after the last pace
    let pages = 0;
    for (let k = 0; k + 1 < turns.length; k++) {
      const slice = all
        .slice(turns[k], turns[k + 1])
        .filter(isRecord)
        .map((c) => c[0]);
      if (slice.length === 0) continue;
      pages += 1;
      expect(slice.length).toBeLessThanOrEqual(WEEK_PAGE_ROWS_MAX);
      const bytes = slice.reduce((a, x) => a + Buffer.byteLength(x, "utf8"), 0);
      if (slice.length > 1) expect(bytes).toBeLessThanOrEqual(WEEK_PAGE_BYTES_MAX);
    }
    expect(pages).toBeGreaterThanOrEqual(5); // ≈ 760 KB of large records + 60 tiny ones
  });

  it("the week's membership is fixed when the read starts: a record logged mid-read is not half in", async () => {
    const log = s.repos.recommendationLog;
    for (let i = 0; i < 60; i++) log.record(input(i), at(100 + i));
    const before = log.forWeek("0", 2026, 4);
    let n = 0;
    const paced = await log.forWeekPaced("0", 2026, 4, () => {
      n += 1;
      // between the two pages: one record sorting into the first page, one into the second
      if (n === 2) {
        log.record(input(900), at(0));
        log.record(input(901), at(3000));
      }
      return Promise.resolve();
    });
    expect(n).toBe(3);
    expect(paced).toEqual(before);
    expect(log.forWeek("0", 2026, 4)).toHaveLength(62);
  });

  it("an empty week paces once and reads nothing; a malformed key rejects before any pace", async () => {
    const log = s.repos.recommendationLog;
    const { pace, calls } = pacer();
    expect(await log.forWeekPaced("0", 2026, 7, pace)).toEqual([]);
    expect(calls()).toBe(1);
    expect(log.forWeek("0", 2026, 7)).toEqual([]);
    for (const [league, season, week] of [
      ["abc", 2026, 4],
      ["0", 1800, 4],
      ["0", 2026, 99],
      ["0", 2026.5, 4],
    ] as const) {
      const p = pacer();
      await expect(log.forWeekPaced(league, season, week, p.pace)).rejects.toThrow(RangeError);
      expect(p.calls()).toBe(0);
    }
  });
});

describe("weekCounts", () => {
  it("each week's record count of one league-season, ascending, from the index alone (no parse)", () => {
    const log = s.repos.recommendationLog;
    for (const [week, n] of [
      [9, 2],
      [1, 3],
      [4, 1],
    ] as const)
      for (let i = 0; i < n; i++)
        log.record(input(i, { week, kind: i === 0 ? "lineup" : "retro" }), at(i));
    log.record(input(0, { season: 2025, week: 2 }), at(0));
    log.record(input(0, { league_id: "1", week: 3 }), at(0));
    const parse = vi.spyOn(JSON, "parse");
    expect(log.weekCounts("0", 2026)).toEqual([
      { week: 1, n: 3 },
      { week: 4, n: 1 },
      { week: 9, n: 2 },
    ]);
    expect(log.weekCounts("0", 2024)).toEqual([]);
    expect(parse).not.toHaveBeenCalled();
    expect(() => log.weekCounts("abc", 2026)).toThrow(RangeError);
    expect(() => log.weekCounts("0", 3000)).toThrow(RangeError);
  });

  it("still counts a week whose record text is unreadable (the counts never touch it)", () => {
    const log = s.repos.recommendationLog;
    log.record(input(0), at(0));
    log.record(input(1), at(1));
    const db = new DatabaseSync(t.storePath);
    try {
      db.prepare(
        "UPDATE recommendation_log SET record_json = 'not json' WHERE client_ref = 'ref-1'",
      ).run();
    } finally {
      db.close();
    }
    expect(() => log.forWeek("0", 2026, 4)).toThrow();
    expect(log.weekCounts("0", 2026)).toEqual([{ week: 4, n: 2 }]);
  });
});

describe("recordOutcomes", () => {
  const outcome = (
    log_id: string,
    over: Partial<RecommendationOutcome> = {},
  ): RecommendationOutcome => ({
    log_id,
    followed: true,
    realised: 3.5,
    regret: 0,
    decisive: false,
    scored_at: "2026-10-08T00:00:00.000Z",
    week_final: false,
    ...over,
  });
  const ids = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => s.repos.recommendationLog.record(input(i), at(i)).log_id);

  it("one transaction with recordOutcome's semantics row by row: provisional re-written, final immutable", () => {
    const [a = "", b = ""] = ids(2);
    const log = s.repos.recommendationLog;
    const guard = statementGuardOf(s);
    guard?.startTrace();
    log.recordOutcomes([
      outcome(a),
      outcome(a, { realised: 4, week_final: true }),
      outcome(a, { realised: 99, week_final: true }),
      outcome(b, { followed: null, decisive: null, regret: null }),
    ]);
    const trace = guard?.stopTrace() ?? [];
    const tx = trace
      .filter((e) => e.object === "BEGIN" || e.object === "COMMIT")
      .map((e) => e.object);
    expect(tx).toEqual(["BEGIN", "COMMIT"]);
    expect(log.outcome(a)).toEqual(outcome(a, { realised: 4, week_final: true }));
    expect(log.outcome(b)).toEqual(outcome(b, { followed: null, decisive: null, regret: null }));
    // the same rows one by one land the same way
    log.recordOutcome(outcome(b, { realised: 7, week_final: true }));
    log.recordOutcomes([outcome(b, { realised: 8, week_final: true })]);
    expect(log.outcome(b)?.realised).toBe(7);
    // nothing to write: no transaction
    guard?.startTrace();
    log.recordOutcomes([]);
    expect(guard?.stopTrace()).toEqual([]);
  });

  it("every row is checked first and the batch is all or none", () => {
    const [a = "", b = ""] = ids(2);
    const log = s.repos.recommendationLog;
    for (const bad of [
      outcome("rec-short"),
      outcome(b, { realised: Number.NaN }),
      outcome(b, { followed: "yes" as never }),
      outcome(b, { decisive: 1 as never }),
      outcome(b, { week_final: 1 as never }),
      outcome(b, { scored_at: "x" }),
    ]) {
      expect(() => {
        log.recordOutcomes([outcome(a), bad]);
      }).toThrow(RangeError);
      expect(log.outcome(a)).toBeNull();
    }
    // a row for a log entry that does not exist fails the foreign key: the rows before it roll back
    expect(() => {
      log.recordOutcomes([outcome(a), outcome(newLogId(0))]);
    }).toThrow();
    expect(log.outcome(a)).toBeNull();
    // more rows than a week's calls is a programming error
    const many = Array.from({ length: OUTCOMES_PER_BATCH_MAX + 1 }, () => outcome(a));
    expect(() => {
      log.recordOutcomes(many);
    }).toThrow(RangeError);
    expect(log.outcome(a)).toBeNull();
    log.recordOutcomes(many.slice(0, OUTCOMES_PER_BATCH_MAX));
    expect(log.outcome(a)).toEqual(outcome(a));
  });

  it("a writer lock that stays busy fails the batch closed (StoreBusyError), nothing written", async () => {
    s.close();
    s = openStore(t, {}, { busyTimeoutMs: 200 });
    const [a = "", b = ""] = ids(2);
    holder = run("lock-holder.mjs", [t.storePath, "3000"]);
    await holder.waitFor(/^LOCKED/);
    let err: unknown;
    try {
      s.repos.recommendationLog.recordOutcomes([outcome(a), outcome(b)]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreBusyError);
    expect((err as StoreBusyError).table).toBe("recommendation_outcome");
    holder.proc.kill("SIGKILL");
    await holder.exited();
    holder = null;
    expect(s.repos.recommendationLog.outcome(a)).toBeNull();
    expect(s.repos.recommendationLog.outcome(b)).toBeNull();
  });
});

describe("list answers what a reference model over the same log answers", () => {
  const KINDS: readonly RecommendationKind[] = ["lineup", "waiver", "trade", "retro"];

  it("property: every filter combination, limit and offset; total, order, summary and followed", () => {
    const log = s.repos.recommendationLog;
    // a seeded log over two leagues, three seasons, four weeks and four kinds, with tied instants
    const rows: {
      log_id: string;
      league: string;
      season: number;
      week: number;
      kind: RecommendationKind;
      ms: number;
      at: string;
      action: string;
    }[] = [];
    let x = 7; // a fixed linear-congruential stream: the same log every run
    const next = (m: number): number => {
      x = (x * 1103515245 + 12345) % 2 ** 31;
      return x % m;
    };
    for (let i = 0; i < 260; i++) {
      const league = next(5) === 0 ? "1" : "0";
      const season = 2024 + next(3);
      const week = 1 + next(4);
      const kind = KINDS[next(4)] ?? "lineup";
      const when = at(next(40)); // many ties: log_id breaks them
      const action = `Start <b>Test</b> Player ${String(i)}`;
      const r = log.record(
        input(i, { league_id: league, season, week, kind, rec: { ...input(i).rec, action } }),
        when,
      );
      rows.push({
        log_id: r.log_id,
        league,
        season,
        week,
        kind,
        ms: Date.parse(when),
        at: when,
        action,
      });
    }
    // some scored outcomes, so `followed` is joined
    const followed = new Map<string, boolean | null>();
    for (const r of rows.filter((_, i) => i % 3 === 0)) {
      const f = next(3) === 0 ? null : next(2) === 0;
      followed.set(r.log_id, f);
      log.recordOutcome({
        log_id: r.log_id,
        followed: f,
        realised: 1,
        regret: 0,
        decisive: null,
        scored_at: "2026-10-08T00:00:00.000Z",
        week_final: true,
      });
    }
    fc.assert(
      fc.property(
        fc.constantFrom("0", "1"),
        fc.option(fc.constantFrom(2024, 2025, 2026, 2027), { nil: null }),
        fc.option(fc.integer({ min: 0, max: 5 }), { nil: null }),
        fc.option(fc.constantFrom(...KINDS), { nil: null }),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 0, max: 300 }),
        (league, season, week, kind, limit, offset) => {
          const want = rows
            .filter(
              (r) =>
                r.league === league &&
                (season === null || r.season === season) &&
                (week === null || r.week === week) &&
                (kind === null || r.kind === kind),
            )
            .sort(
              (p, q) => q.ms - p.ms || (p.log_id < q.log_id ? 1 : p.log_id > q.log_id ? -1 : 0),
            );
          const page = log.list({ league_id: league, season, week, kind, limit, offset });
          expect(page.total).toBe(want.length);
          expect(page.items).toEqual(
            want.slice(offset, offset + limit).map((r) => ({
              log_id: r.log_id,
              kind: r.kind,
              week: r.week,
              recorded_at: r.at,
              action_summary: bareUntrusted(r.action, "rec_log_text"),
              followed: followed.get(r.log_id) ?? null,
            })),
          );
        },
      ),
      { numRuns: 400 },
    );
  });
});
