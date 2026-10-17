// reclog-plans.test.ts — every read of the never-pruned recommendation log is held to an index that
// bounds it by its own week, season or ids, never by the league's whole log (src/store/repos/reclog.ts
// RECLOG_SQL, listSql; plan 03 §1.2: the loop never blocks longer than one SQLite statement or one
// ≤ 20 ms CPU batch — a statement whose cost grows with the log is no bound). Stage C,
// reclog-retrospective-unbounded-read: the store never runs ANALYZE, and without statistics SQLite
// served `forWeek`'s ORDER BY recorded_ms from the (league_id, recorded_ms) index, so one week's read
// walked every row the league ever logged (≈ 17 ms at 34 000 rows, an empty week included) — and E13
// read every week up to the scored one; `list`'s `(? IS NULL OR col = ?)` terms could never choose an
// index at all. The plans are read on the store's own connection over rows in several seasons, weeks
// and leagues; two positive controls show the check sees the pre-fix plans.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RecordRecommendationInput } from "../../src/domain/reclog/types.js";
import { listSql, RECLOG_SQL } from "../../src/store/repos/reclog.js";
import { storeInternalsOf } from "../../src/store/store.js";
import type { Store } from "../../src/store/types.js";
import { openStore, tempCache, type TempCache } from "./helpers/env.js";

let t: TempCache;
let s: Store;

const input = (season: number, week: number, i: number, league = "0"): RecordRecommendationInput =>
  ({
    league_id: league,
    season,
    kind: i % 2 === 0 ? "lineup" : "waiver",
    week,
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
  }) as never;

beforeAll(() => {
  t = tempCache();
  s = openStore(t);
  const log = s.repos.recommendationLog;
  for (const league of ["0", "1"])
    for (const season of [2024, 2025, 2026])
      for (let week = 1; week <= 4; week++)
        for (let i = 0; i < 3; i++)
          log.record(
            input(season, week, i, league),
            `${String(season)}-10-06T12:0${String(i)}:00.000Z`,
          );
});
afterAll(() => {
  s.close();
  t.cleanup();
});

/** The query plan of `sql` on the store's own connection, one detail line per step. */
function plan(sql: string, ...args: (string | number)[]): string[] {
  const db = storeInternalsOf(s)?.db;
  if (db === undefined) throw new Error("no store connection");
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map(
    (r) => r.detail,
  );
}

const LEAGUE_WIDE = "recommendation_log__league_recorded";
const WEEK_INDEX =
  "USING INDEX recommendation_log__league_week (league_id=? AND season=? AND week=?)";

describe("the week reads: the (league_id, season, week) index, never the league's whole log", () => {
  it.each([
    ["weekKeys (forWeek's and forWeekPaced's keys)", RECLOG_SQL.weekKeys],
    ["weekHeld (E12's week bound)", RECLOG_SQL.weekHeld],
  ])("%s", (_name, sql) => {
    const p = plan(sql, "0", 2026, 4);
    expect(p.some((d) => d.includes(WEEK_INDEX))).toBe(true);
    expect(p.join("\n")).not.toContain(LEAGUE_WIDE);
    expect(p.some((d) => d.startsWith("SCAN recommendation_log"))).toBe(false);
  });

  it("weekCounts reads the (league_id, season, week) index alone (covering: no row is read)", () => {
    expect(plan(RECLOG_SQL.weekCounts, "0", 2026)).toEqual([
      "SEARCH recommendation_log USING COVERING INDEX recommendation_log__league_week (league_id=? AND season=?)",
    ]);
  });

  it("E12's dedup probe is one lookup in the dedup-scope unique index", () => {
    expect(plan(RECLOG_SQL.dedupProbe, "0", 2026, 4, "lineup", "ref-1")).toEqual([
      "SEARCH recommendation_log USING INDEX recommendation_log__dedup_scope (league_id=? AND season=? AND week=? AND kind=? AND client_ref=?)",
    ]);
  });

  it.each([
    [
      "weekRowsByIds (forWeek's and each page's rows)",
      RECLOG_SQL.weekRowsByIds,
      ["[]", "0", 2026, 4],
    ],
    ["listRowsByIds (list's page)", RECLOG_SQL.listRowsByIds, ["[]"]],
  ] as const)(
    "%s reads its ids by primary key, nothing else, and sorts nothing (the text never enters a sort)",
    (_name, sql, args) => {
      const p = plan(sql, ...args);
      const log = p.filter((d) => /\brecommendation_log\b|^(SEARCH|SCAN) l\b/.test(d));
      expect(log.length).toBeGreaterThan(0);
      for (const d of log)
        expect(d).toMatch(/^SEARCH (recommendation_log|l) USING INDEX \S+ \(log_id=\?\)$/);
      expect(p.join("\n")).not.toContain(LEAGUE_WIDE);
      expect(p.join("\n")).not.toContain("recommendation_log__league_week");
      expect(p.join("\n")).not.toContain("TEMP B-TREE");
    },
  );

  it("only keys are sorted: no statement that selects record text has an ORDER BY", () => {
    for (const [name, sql] of Object.entries(RECLOG_SQL))
      if (/SELECT[^]*\brecord_json\b[^]*FROM/.test(sql.replace(/octet_length\(record_json\)/g, "")))
        expect(sql, name).not.toMatch(/ORDER BY/);
  });

  it("positive control: the pre-fix forWeek statement walked the league-wide index", () => {
    const before = `SELECT log_id, recorded_at, record_json FROM recommendation_log
      WHERE league_id = ? AND season = ? AND week = ? ORDER BY recorded_ms, log_id`;
    expect(plan(before, "0", 2026, 4).join("\n")).toContain(LEAGUE_WIDE);
  });
});

describe("list: plain equality terms only, bounded by the season it lists", () => {
  const combos = [false, true].flatMap((season) =>
    [false, true].flatMap((week) => [false, true].map((kind) => ({ season, week, kind }))),
  );
  const args = (f: { season: boolean; week: boolean; kind: boolean }): (string | number)[] => [
    "0",
    ...(f.season ? [2026] : []),
    ...(f.week ? [4] : []),
    ...(f.kind ? ["lineup"] : []),
  ];

  it.each(combos.filter((f) => f.season))(
    "with a season (E14 always sets one) %o: count and ids through the season's index",
    (f) => {
      const sql = listSql(f);
      for (const p of [plan(sql.count, ...args(f)), plan(sql.ids, ...args(f), 25, 0)]) {
        const prefix = f.week
          ? "(league_id=? AND season=? AND week=?)"
          : "(league_id=? AND season=?)";
        expect(p.some((d) => d.includes(`recommendation_log__league_week ${prefix}`))).toBe(true);
        expect(p.join("\n")).not.toContain(LEAGUE_WIDE);
        expect(p.some((d) => d.startsWith("SCAN"))).toBe(false);
      }
    },
  );

  it.each(combos.filter((f) => !f.season))(
    "without a season %o: never a table scan; the ids walk newest first and stop at offset + limit",
    (f) => {
      const sql = listSql(f);
      const count = plan(sql.count, ...args(f));
      const ids = plan(sql.ids, ...args(f), 25, 0);
      for (const p of [count, ids]) expect(p.some((d) => d.startsWith("SCAN"))).toBe(false);
      expect(ids[0]).toBe(`SEARCH recommendation_log USING INDEX ${LEAGUE_WIDE} (league_id=?)`);
      // the league-wide count reads the index alone
      if (!f.week && !f.kind) expect(count[0]).toMatch(/USING COVERING INDEX/);
    },
  );

  it("positive control: the pre-fix `(? IS NULL OR col = ?)` terms could choose no index but the league's", () => {
    const before = `SELECT COUNT(*) AS n FROM recommendation_log AS l WHERE l.league_id = :league
      AND (:season IS NULL OR l.season = :season) AND (:week IS NULL OR l.week = :week)
      AND (:kind IS NULL OR l.kind = :kind)`;
    const db = storeInternalsOf(s)?.db;
    const p = (
      db?.prepare(`EXPLAIN QUERY PLAN ${before}`).all({
        league: "0",
        season: 2026,
        week: 4,
        kind: null,
      }) as { detail: string }[]
    ).map((r) => r.detail);
    expect(p.join("\n")).toMatch(/\(league_id=\?\)/);
    expect(p.join("\n")).not.toContain("season=?");
  });
});
