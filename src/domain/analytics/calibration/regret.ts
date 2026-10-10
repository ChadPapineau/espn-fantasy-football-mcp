// regret.ts — the start/sit replay's summaries (plan 10 C2 "regret below both baselines on the
// held-out seasons … the 'did it matter' share reported"; sib research 05 §3 Evaluation, §12.3;
// research 05 §8.4 "every claim of improvement must hold in both seasons and not be concentrated in
// weeks 1–3"). Regret is the hindsight-best legal lineup's realised points minus a rule's (≥ 0; the
// oracle regret of docs/evals/1a-backtest.md); a comparison of two rules counts only the team-weeks
// where both are available, per season and pooled, optionally from a week on. "Did it matter": among
// the head-to-head team-weeks where a rule's starters differ from a reference's, the share where
// starting them would have flipped the result against the opponent's realised total — split into
// results it would have won and results it would have lost. Pure. New here.
import { ensure } from "../errors.js";
import { round } from "../math.js";
import type { StartSitRow, StartSitRule } from "./types.js";

/** Hindsight − realised for a rule; null when either is unavailable. */
export function regretOf(row: StartSitRow, rule: StartSitRule): number | null {
  const h = row.realised.hindsight;
  const r = row.realised[rule];
  return h === null || r === null ? null : round(h - r, 2);
}

/** Two rules' mean regret over the team-weeks where both are available. */
export interface RegretComparison {
  /** A season, or null for the pooled seasons. */
  readonly season: number | null;
  readonly n: number;
  readonly mean_a: number | null;
  readonly mean_b: number | null;
  /** mean_a − mean_b (negative = rule a has the lower regret); null when n = 0. */
  readonly diff: number | null;
  /** Team-weeks where both rules started the same players. */
  readonly identical: number;
}

/** A comparison of rule a against rule b, per season and pooled. */
export interface RegretComparisonReport {
  readonly a: StartSitRule;
  readonly b: StartSitRule;
  /** Only weeks ≥ from_week count (1 = every week). */
  readonly from_week: number;
  readonly by_season: readonly RegretComparison[];
  readonly pooled: RegretComparison;
}

const MAX_WEEK = 25;

function compareOn(
  rows: readonly StartSitRow[],
  a: StartSitRule,
  b: StartSitRule,
  season: number | null,
): RegretComparison {
  let n = 0;
  let sa = 0;
  let sb = 0;
  let identical = 0;
  for (const r of rows) {
    const ra = regretOf(r, a);
    const rb = regretOf(r, b);
    if (ra === null || rb === null) continue;
    n += 1;
    sa += ra;
    sb += rb;
    if (r.lineup_key[a] === r.lineup_key[b]) identical += 1;
  }
  return {
    season,
    n,
    mean_a: n === 0 ? null : round(sa / n, 4),
    mean_b: n === 0 ? null : round(sb / n, 4),
    diff: n === 0 ? null : round((sa - sb) / n, 4),
    identical,
  };
}

/** Rule a's regret against rule b's (plan 10 C2), per season (ascending) and pooled. */
export function compareRegret(
  rows: readonly StartSitRow[],
  a: StartSitRule,
  b: StartSitRule,
  opts: { readonly from_week?: number } = {},
): RegretComparisonReport {
  const from = opts.from_week ?? 1;
  ensure(
    Number.isInteger(from) && from >= 1 && from <= MAX_WEEK,
    "from_week out of range",
    "from_week",
  );
  const kept = rows.filter((r) => r.week >= from);
  const seasons = [...new Set(kept.map((r) => r.season))].sort((x, y) => x - y);
  return {
    a,
    b,
    from_week: from,
    by_season: seasons.map((s) =>
      compareOn(
        kept.filter((r) => r.season === s),
        a,
        b,
        s,
      ),
    ),
    pooled: compareOn(kept, a, b, null),
  };
}

/** Whether rule a's mean regret is strictly below rule b's in every season (and n > 0 in each). */
export function beatsInEverySeason(report: RegretComparisonReport): boolean {
  return (
    report.by_season.length > 0 &&
    report.by_season.every((c) => c.n > 0 && c.diff !== null && c.diff < 0)
  );
}

/** Whether rule a's mean regret is at most rule b's in every season (and n > 0 in each). */
export function noWorseInEverySeason(report: RegretComparisonReport): boolean {
  return (
    report.by_season.length > 0 &&
    report.by_season.every((c) => c.n > 0 && c.diff !== null && c.diff <= 0)
  );
}

/** The "did it matter" share of a rule against a reference (sib research 05 §12.3). */
export interface DidItMatter {
  readonly rule: StartSitRule;
  readonly reference: StartSitRule;
  /** Head-to-head team-weeks where both rules are available. */
  readonly n_h2h: number;
  /** …of which the two rules started different players. */
  readonly n_changed: number;
  /** …of which starting the rule's lineup would have flipped the result (a tie counts as a flip). */
  readonly n_decisive: number;
  /** Flips to a win (the rule's lineup wins where the reference's did not). */
  readonly n_helped: number;
  /** Flips to a loss. */
  readonly n_hurt: number;
  /** n_decisive / n_changed; null when nothing changed. */
  readonly share_of_changed: number | null;
  /** n_decisive / n_h2h; null when n_h2h = 0. */
  readonly share_of_all: number | null;
}

/** Sign of a − b at ESPN's 0.01 resolution. */
const sign = (a: number, b: number): -1 | 0 | 1 => {
  const d = round(a - b, 2);
  return d > 0 ? 1 : d < 0 ? -1 : 0;
};

/** The "did it matter" share of `rule` against `reference` (both realised vs the opponent's total). */
export function didItMatter(
  rows: readonly StartSitRow[],
  rule: StartSitRule,
  reference: StartSitRule,
): DidItMatter {
  let nH2h = 0;
  let changed = 0;
  let decisive = 0;
  let helped = 0;
  let hurt = 0;
  for (const r of rows) {
    const h = r.h2h;
    const x = r.realised[rule];
    const y = r.realised[reference];
    if (h === null || x === null || y === null) continue;
    nH2h += 1;
    if (r.lineup_key[rule] === r.lineup_key[reference]) continue;
    changed += 1;
    const sx = sign(x, h.opponent_total);
    const sy = sign(y, h.opponent_total);
    if (sx === sy) continue;
    decisive += 1;
    if (sx > sy) helped += 1;
    else hurt += 1;
  }
  return {
    rule,
    reference,
    n_h2h: nH2h,
    n_changed: changed,
    n_decisive: decisive,
    n_helped: helped,
    n_hurt: hurt,
    share_of_changed: changed === 0 ? null : round(decisive / changed, 4),
    share_of_all: nH2h === 0 ? null : round(decisive / nH2h, 4),
  };
}
