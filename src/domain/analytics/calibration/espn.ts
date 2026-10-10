// espn.ts — P(win) and P(playoffs) against ESPN's own numbers (plan 10 C3 "Brier ≤ ESPN's
// `winProbability` on every replayed week with a `scoreboard_snapshot`; Brier ≤ ESPN's `playoffPct`
// on replayed seasons"; research 05 §5 "H2H win probability — ESPN's number is the comparator",
// §8.4 #5 "Brier and reliability of P(playoffs) from weeks 4, 8 and 12 against ESPN's
// currentSimulationResults.playoffPct"; plan 07 E13's comparators; T-07 `scoreboard_snapshot`).
// ESPN's pre-week numbers exist only in the scoreboard snapshots the pre-kickoff working run stores
// (src/cli/snapshot.ts) — a finished season carries neither (docs/evals/phase3-data.md) — so every
// comparison is per period over the forecasts that HAVE an ESPN number, and a replay with no
// snapshot at all is `needs_time`, never a pass. Snapshot choice: the latest one taken at or before
// the week's first kickoff (the most informed pre-week number), else the earliest of the week. An
// ESPN value outside [0, 1] or non-finite is not a probability and is skipped (counted). Pure. New.
import type { ScoreboardSnapshot } from "../../league/types.js";
import { ensure } from "../errors.js";
import { round } from "../math.js";

/** One forecast of ours, ESPN's for the same event when a snapshot has it, and what happened. */
export interface ComparatorRow {
  /** The league the forecast is about (a replay of several leagues groups by it); default "". */
  readonly group?: string;
  readonly season: number;
  /** The replayed week (win probability) or the checkpoint week (playoff %). */
  readonly period: number;
  readonly team_id: number;
  /** Our forecast, 0..1. */
  readonly ours: number;
  /** ESPN's forecast, 0..1, or null when no snapshot carries it. */
  readonly espn: number | null;
  /** The team won the matchup / made the playoffs (ties are excluded by the caller). */
  readonly outcome: boolean;
}

/** One period's Brier pair over the forecasts ESPN also made. */
export interface PeriodBrier {
  readonly group: string;
  readonly season: number;
  readonly period: number;
  readonly n: number;
  readonly brier_ours: number;
  readonly brier_espn: number;
  readonly ours_le_espn: boolean;
}

/** The comparison's status. */
export type ComparatorStatus = "met" | "not_met" | "needs_time";

/** A C3 comparison of one probability kind. */
export interface EspnComparison {
  readonly kind: "win_probability" | "playoff_pct";
  readonly status: ComparatorStatus;
  /** Periods with at least one ESPN forecast, by season then period. */
  readonly periods: readonly PeriodBrier[];
  /** Replayed periods with no ESPN forecast at all. */
  readonly periods_without_espn: number;
  /** Every forecast of ours, and our Brier over all of them (ESPN or not). */
  readonly n_ours: number;
  readonly brier_ours_all: number | null;
  /** Pooled over the compared forecasts only. */
  readonly n_compared: number;
  readonly brier_ours_compared: number | null;
  readonly brier_espn_compared: number | null;
}

const EPS = 1e-12;
const MAX_ROWS = 200_000;

const isProb = (p: unknown): p is number =>
  typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1;

const brier = (xs: readonly { p: number; o: boolean }[]): number =>
  xs.reduce((s, x) => s + (x.p - (x.o ? 1 : 0)) ** 2, 0) / xs.length;

/**
 * Compares our forecasts with ESPN's per period (plan 10 C3): `needs_time` when no period has an
 * ESPN forecast; `met` when our Brier is ≤ ESPN's in every compared period; else `not_met`. Throws
 * AnalyticsError `invalid_request` on a malformed row (ours outside [0, 1], an ESPN value that is
 * neither null nor a probability, a non-boolean outcome) or too many rows.
 */
export function compareWithEspn(
  kind: EspnComparison["kind"],
  rows: readonly ComparatorRow[],
): EspnComparison {
  ensure(rows.length <= MAX_ROWS, "too many comparator rows", "rows");
  for (const r of rows) {
    ensure(isProb(r.ours), "our forecast must be a probability", "rows");
    ensure(
      r.espn === null || isProb(r.espn),
      "ESPN's forecast must be null or a probability",
      "rows",
    );
    ensure(typeof r.outcome === "boolean", "an outcome must be a boolean", "rows");
    ensure(
      Number.isInteger(r.season) && Number.isInteger(r.period) && Number.isInteger(r.team_id),
      "season, period and team must be integers",
      "rows",
    );
    ensure(
      r.group === undefined || (typeof r.group === "string" && r.group.length <= 64),
      "a group must be a short string",
      "rows",
    );
  }
  const keyOf = (r: ComparatorRow): string =>
    `${r.group ?? ""}\u0000${String(r.season)}:${String(r.period)}`;
  const keys = [...new Set(rows.map(keyOf))];
  const periods: PeriodBrier[] = [];
  let without = 0;
  const compared: { ours: number; espn: number; o: boolean }[] = [];
  for (const key of keys) {
    const inPeriod = rows.filter((r) => keyOf(r) === key);
    const both = inPeriod.flatMap((r) =>
      r.espn === null ? [] : [{ ours: r.ours, espn: r.espn, o: r.outcome }],
    );
    const first = inPeriod[0];
    if (both.length === 0 || first === undefined) {
      without += 1;
      continue;
    }
    compared.push(...both);
    const bo = brier(both.map((x) => ({ p: x.ours, o: x.o })));
    const be = brier(both.map((x) => ({ p: x.espn, o: x.o })));
    periods.push({
      group: first.group ?? "",
      season: first.season,
      period: first.period,
      n: both.length,
      brier_ours: round(bo, 6),
      brier_espn: round(be, 6),
      ours_le_espn: bo <= be + EPS,
    });
  }
  periods.sort(
    (a, b) =>
      (a.group < b.group ? -1 : a.group > b.group ? 1 : 0) ||
      a.season - b.season ||
      a.period - b.period,
  );
  const status: ComparatorStatus =
    periods.length === 0 ? "needs_time" : periods.every((p) => p.ours_le_espn) ? "met" : "not_met";
  return {
    kind,
    status,
    periods,
    periods_without_espn: without,
    n_ours: rows.length,
    brier_ours_all:
      rows.length === 0 ? null : round(brier(rows.map((r) => ({ p: r.ours, o: r.outcome }))), 6),
    n_compared: compared.length,
    brier_ours_compared:
      compared.length === 0 ? null : round(brier(compared.map((x) => ({ p: x.ours, o: x.o }))), 6),
    brier_espn_compared:
      compared.length === 0 ? null : round(brier(compared.map((x) => ({ p: x.espn, o: x.o }))), 6),
  };
}

/**
 * The snapshot a week's pre-week ESPN numbers are read from (see the header), or null. A snapshot
 * whose `taken_at` is not a valid instant is ignored.
 */
export function preWeekSnapshot(
  snapshots: readonly ScoreboardSnapshot[],
  week: number,
  firstKickoffMs: number | null,
): ScoreboardSnapshot | null {
  const timed = snapshots
    .filter((s) => s.week === week)
    .map((s) => ({ s, t: Date.parse(s.taken_at) }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);
  if (timed.length === 0) return null;
  if (firstKickoffMs !== null && Number.isFinite(firstKickoffMs)) {
    const before = timed.filter((x) => x.t <= firstKickoffMs);
    return before.at(-1)?.s ?? null;
  }
  return timed[0]?.s ?? null;
}

/** What a snapshot says, per team: ESPN's win probability and playoff %, plus what was skipped. */
export interface EspnSnapshotNumbers {
  readonly win_probability: ReadonlyMap<number, number>;
  readonly playoff_pct: ReadonlyMap<number, number>;
  /** Values present but not probabilities (outside [0, 1] or non-finite). */
  readonly skipped: number;
}

/** ESPN's numbers in one snapshot (both sides of every matchup; playoff % by team). */
export function espnNumbersOf(snapshot: ScoreboardSnapshot | null): EspnSnapshotNumbers {
  const wp = new Map<number, number>();
  const pct = new Map<number, number>();
  let skipped = 0;
  if (snapshot === null) return { win_probability: wp, playoff_pct: pct, skipped };
  for (const m of snapshot.matchups)
    for (const side of [m.home, m.away]) {
      if (side === null) continue;
      const p = side.win_probability_espn;
      if (p === null) continue;
      if (isProb(p)) wp.set(side.team_id, p);
      else skipped += 1;
    }
  for (const [team, p] of Object.entries(snapshot.playoff_pct_espn)) {
    const id = Number(team);
    if (p === null || !Number.isInteger(id)) continue;
    if (isProb(p)) pct.set(id, p);
    else skipped += 1;
  }
  return { win_probability: wp, playoff_pct: pct, skipped };
}

/**
 * Our forecasts with ESPN's number attached per team (the chain: `preWeekSnapshot` → `espnNumbersOf`
 * → this → `compareWithEspn`). `numbersFor` returns the period's numbers by team (an empty map when
 * no snapshot exists — the forecast keeps `espn: null`).
 */
export function attachEspn(
  rows: readonly ComparatorRow[],
  numbersFor: (row: ComparatorRow) => ReadonlyMap<number, number>,
): ComparatorRow[] {
  return rows.map((r) => ({ ...r, espn: numbersFor(r).get(r.team_id) ?? null }));
}
