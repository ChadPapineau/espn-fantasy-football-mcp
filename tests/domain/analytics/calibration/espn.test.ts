// espn.test.ts — the comparison with ESPN's own numbers (plan 10 C3): per period over the forecasts
// ESPN also made (`needs_time` without one — never a pass; `met` only when ours is ≤ ESPN's in every
// compared period), grouped by league; the pre-week snapshot (the latest at or before the first
// kickoff, else the earliest); ESPN's numbers read from a snapshot with non-probabilities skipped;
// hostile rows refused.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  compareWithEspn,
  espnNumbersOf,
  preWeekSnapshot,
  type ComparatorRow,
} from "../../../../src/domain/analytics/calibration/index.js";
import { AnalyticsError } from "../../../../src/domain/analytics/errors.js";
import {
  wrapUntrusted,
  type LiveSide,
  type ScoreboardSnapshot,
} from "../../../../src/domain/league/types.js";

const r = (
  period: number,
  ours: number,
  espn: number | null,
  outcome: boolean,
  over: Partial<ComparatorRow> = {},
): ComparatorRow => ({
  season: 2026,
  period,
  team_id: period * 10 + (outcome ? 1 : 0),
  ours,
  espn,
  outcome,
  ...over,
});

const side = (team_id: number, win_probability_espn: number | null): LiveSide => ({
  team_id,
  name: wrapUntrusted("Team A", "espn.team.name"),
  points_live: null,
  projected_pre_espn: null,
  projected_live_espn: null,
  win_probability_espn,
  players: null,
});

const snap = (
  week: number,
  taken_at: string,
  wp: [number, number | null][] = [],
): ScoreboardSnapshot => ({
  week,
  taken_at,
  matchups:
    wp.length === 0
      ? []
      : [
          {
            matchup_id: 1,
            home: side(wp[0]?.[0] ?? 1, wp[0]?.[1] ?? null),
            away: wp[1] === undefined ? null : side(wp[1][0], wp[1][1]),
            is_mine: false,
          },
        ],
  playoff_pct_espn: {},
});

describe("compareWithEspn", () => {
  it("needs_time when no forecast has an ESPN number — our Brier still reported", () => {
    const c = compareWithEspn("win_probability", [
      r(1, 0.7, null, true),
      r(1, 0.3, null, false),
      r(2, 0.6, null, false),
    ]);
    expect(c.status).toBe("needs_time");
    expect(c.periods).toEqual([]);
    expect(c.periods_without_espn).toBe(2);
    expect(c.n_ours).toBe(3);
    expect(c.brier_ours_all).toBeCloseTo((0.09 + 0.09 + 0.36) / 3, 6);
    expect(c.n_compared).toBe(0);
    expect(c.brier_ours_compared).toBeNull();
    expect(c.brier_espn_compared).toBeNull();
    expect(compareWithEspn("playoff_pct", []).brier_ours_all).toBeNull();
  });

  it("met only when ours ≤ ESPN's in every compared period; partial ESPN coverage compares only those rows", () => {
    const met = compareWithEspn("win_probability", [
      r(1, 0.8, 0.6, true),
      r(1, 0.2, 0.4, false),
      r(2, 0.5, 0.5, true),
      r(2, 0.9, null, false),
      r(3, 0.4, null, true),
    ]);
    expect(met.status).toBe("met");
    expect(met.periods.map((p) => [p.period, p.n, p.ours_le_espn])).toEqual([
      [1, 2, true],
      [2, 1, true],
    ]);
    expect(met.periods[0]?.brier_ours).toBeCloseTo(0.04, 6);
    expect(met.periods[0]?.brier_espn).toBeCloseTo(0.16, 6);
    expect(met.periods_without_espn).toBe(1);
    expect(met.n_compared).toBe(3);
    const notMet = compareWithEspn("win_probability", [
      r(1, 0.8, 0.6, true),
      r(2, 0.9, 0.6, false),
    ]);
    expect(notMet.status).toBe("not_met");
    expect(notMet.periods[1]?.ours_le_espn).toBe(false);
  });

  it("groups by league as well as season and period, sorted", () => {
    const c = compareWithEspn("playoff_pct", [
      r(8, 0.7, 0.6, true, { group: "league-c" }),
      r(8, 0.7, 0.6, true, { group: "league-a" }),
      r(4, 0.7, 0.6, true, { group: "league-a", season: 2025 }),
      r(8, 0.7, 0.6, true),
    ]);
    expect(c.periods.map((p) => `${p.group}/${String(p.season)}/${String(p.period)}`)).toEqual([
      "/2026/8",
      "league-a/2025/4",
      "league-a/2026/8",
      "league-c/2026/8",
    ]);
  });

  it("refuses malformed rows", () => {
    const bad: Partial<ComparatorRow>[] = [
      { ours: 1.5 },
      { ours: Number.NaN },
      { espn: -0.1 },
      { espn: Number.POSITIVE_INFINITY },
      { outcome: "yes" as unknown as boolean },
      { season: 2026.5 },
      { period: Number.NaN },
      { team_id: 1.5 },
      { group: "x".repeat(65) },
      { group: 7 as unknown as string },
    ];
    for (const b of bad)
      expect(() => compareWithEspn("win_probability", [{ ...r(1, 0.5, 0.5, true), ...b }])).toThrow(
        AnalyticsError,
      );
  });

  it("(property) needs_time iff no ESPN number; a perfect forecaster is never worse than ESPN", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            period: fc.integer({ min: 1, max: 5 }),
            espn: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
            outcome: fc.boolean(),
          }),
          { minLength: 1, maxLength: 40 },
        ),
        (xs) => {
          const rows = xs.map((x, i) => ({
            season: 2026,
            period: x.period,
            team_id: i,
            ours: x.outcome ? 1 : 0,
            espn: x.espn,
            outcome: x.outcome,
          }));
          const c = compareWithEspn("win_probability", rows);
          const any = rows.some((x) => x.espn !== null);
          expect(c.status === "needs_time").toBe(!any);
          if (any) expect(c.status).toBe("met");
        },
      ),
    );
  });
});

describe("preWeekSnapshot / espnNumbersOf", () => {
  const kickoff = Date.parse("2026-10-01T17:00:00.000Z");
  const early = snap(4, "2026-09-29T12:00:00.000Z");
  const late = snap(4, "2026-10-01T12:00:00.000Z");
  const after = snap(4, "2026-10-06T06:28:00.000Z");

  it("takes the latest snapshot at or before the first kickoff, else none; without a kickoff the earliest", () => {
    expect(preWeekSnapshot([after, late, early], 4, kickoff)).toBe(late);
    expect(preWeekSnapshot([after], 4, kickoff)).toBeNull();
    expect(preWeekSnapshot([after, late, early], 4, null)).toBe(early);
    expect(preWeekSnapshot([after, early], 5, kickoff)).toBeNull();
    expect(preWeekSnapshot([snap(4, "not a date"), late], 4, kickoff)).toBe(late);
    expect(preWeekSnapshot([], 4, null)).toBeNull();
    expect(preWeekSnapshot([early], 4, Number.NaN)).toBe(early);
  });

  it("reads both sides' win probabilities and the playoff %, skipping non-probabilities", () => {
    const s: ScoreboardSnapshot = {
      ...snap(4, "2026-09-29T12:00:00.000Z", [
        [1, 0.62],
        [2, 0.38],
      ]),
      playoff_pct_espn: { "1": 0.79, "2": null, "3": 1.4, x: 0.5 },
    };
    const n = espnNumbersOf(s);
    expect([...n.win_probability.entries()]).toEqual([
      [1, 0.62],
      [2, 0.38],
    ]);
    expect([...n.playoff_pct.entries()]).toEqual([[1, 0.79]]);
    expect(n.skipped).toBe(1);
    const odd = espnNumbersOf(
      snap(4, "2026-09-29T12:00:00.000Z", [
        [1, 62],
        [2, null],
      ]),
    );
    expect(odd.win_probability.size).toBe(0);
    expect(odd.skipped).toBe(1);
    const bye = espnNumbersOf(snap(4, "2026-09-29T12:00:00.000Z", [[1, 0.5]]));
    expect(bye.win_probability.size).toBe(1);
    expect(espnNumbersOf(null)).toEqual({
      win_probability: new Map(),
      playoff_pct: new Map(),
      skipped: 0,
    });
  });
});
