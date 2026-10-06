// usageSignals.ts — E5's usage-first detection (plan 07 E5 P1 `signals[]`; plan 10 B3 hard parts;
// sib research 05 §4.1: opportunity before points, ordered by lead time — injury / depth-chart change,
// a snap-share jump held two straight games, a target-share jump, under-produced opportunity (xFP −
// actual), red-zone share shifts; research 05 §1.3: `percentChange` is a COMPETITION signal, never a
// detection signal). Every signal cites a NUMBER as `evidence` (never text), and the input type has
// no ownership field at all, so `percent_change` cannot reach `signals[]` by construction. A jump
// whose hold window lies inside a teammate's absence is not a role change (sib §4.1 "every signal is
// filtered by P(role holds)") — the cascade signal carries that case. Pure. New here.
import type { Week } from "../league/types.js";
import { SIGNALS } from "./marketConstants.js";
import { meanOf, round } from "./math.js";
import type { UsageGameRow, WaiverSignal, WaiverSignalKind } from "./types.js";

/** One game of a player's usage, as the detector reads it (shares in [0, 1]; points under S). */
export interface UsageWeek {
  readonly week: Week;
  readonly snap_pct: number | null;
  readonly target_share: number | null;
  /** The player's share of the team's red-zone opportunities (targets + carries inside the 20). */
  readonly rz_share: number | null;
  /** Expected fantasy points from usage under the league's S (ffopportunity re-scored). */
  readonly xfp: number | null;
  /** Actual fantasy points under the league's S. */
  readonly points: number | null;
}

/** The detector's input for one candidate. Deliberately carries no ownership / trend field. */
export interface SignalInput {
  readonly position: string;
  /** This season's games (any order; one row per week). */
  readonly games: readonly UsageWeek[];
  /** The depth-chart rank now and at the previous chart (1 = starter). */
  readonly depth?: { readonly rank_now: number | null; readonly rank_before: number | null } | null;
  /** The player's team implied total this week and its season mean (nflverse lines). */
  readonly implied?: {
    readonly this_week: number | null;
    readonly season_mean: number | null;
  } | null;
  /** From E7: the share of a vacated role this player inherits, and the vacated share itself. */
  readonly cascade?: { readonly inherited_share: number; readonly vacated_share: number } | null;
  /** Weeks a teammate ahead of him was absent: a jump inside them is not (yet) a role change. */
  readonly teammate_absent_weeks?: readonly Week[];
}

/** A UsageWeek from a D1 per-game row; `team_rz` = the team's red-zone opportunities that game. */
export function usageWeekOf(row: UsageGameRow, teamRz: number | null): UsageWeek {
  const rz =
    row.rz_targets === null && row.rz_carries === null
      ? null
      : (row.rz_targets ?? 0) + (row.rz_carries ?? 0);
  return {
    week: row.week,
    snap_pct: row.snap_pct,
    target_share: row.target_share,
    rz_share: rz === null || teamRz === null || !(teamRz > 0) ? null : Math.min(1, rz / teamRz),
    xfp: row.xfp_ep,
    points: row.points_league,
  };
}

const finite = (x: number | null | undefined): x is number =>
  typeof x === "number" && Number.isFinite(x);

/** Whether a signal is well-formed for plan 10 B3: a finite value and a finite NUMBER as evidence. */
export function hasNumericEvidence(s: WaiverSignal): boolean {
  return finite(s.value) && typeof s.evidence === "number" && Number.isFinite(s.evidence);
}

function sortedGames(games: readonly UsageWeek[]): UsageWeek[] {
  const byWeek = new Map<number, UsageWeek>();
  for (const g of games) if (Number.isInteger(g.week)) byWeek.set(g.week, g);
  return [...byWeek.values()].sort((a, b) => a.week - b.week);
}

/**
 * A share jump held over the latest `holdGames` games against the mean of up to `baselineGames`
 * games before them: every hold value ≥ baseline + threshold. Returns the jump (hold mean − baseline)
 * and the latest value, or null.
 */
function heldJump(
  games: readonly UsageWeek[],
  pick: (g: UsageWeek) => number | null,
  threshold: number,
  absent: ReadonlySet<number>,
): { readonly delta: number; readonly latest: number } | null {
  const H = SIGNALS.holdGames;
  if (games.length < H + SIGNALS.minBaselineGames) return null;
  const hold = games.slice(-H);
  const holdValues = hold.map(pick);
  if (!holdValues.every(finite)) return null;
  const baseline = games
    .slice(0, games.length - H)
    .map(pick)
    .filter(finite)
    .slice(-SIGNALS.baselineGames);
  if (baseline.length < SIGNALS.minBaselineGames) return null;
  // the hold window entirely inside a teammate's absence: a fill-in, not a role change (yet)
  if (hold.every((g) => absent.has(g.week))) return null;
  const base = meanOf(baseline);
  if (!holdValues.every((v) => v >= base + threshold)) return null;
  const latest = holdValues[holdValues.length - 1] ?? 0;
  return { delta: meanOf(holdValues) - base, latest };
}

function push(out: WaiverSignal[], kind: WaiverSignalKind, value: number, evidence: number): void {
  if (!finite(value) || !finite(evidence)) return;
  out.push({ kind, value: round(value, 3), evidence: round(evidence, 3) });
}

/**
 * The usage signals of one candidate, in lead-time order (sib §4.1): injury_cascade, depth_chart,
 * snap_jump, target_share_jump, xfp_gap, rz_shift, then implied_total. Each signal's `evidence` is a
 * number: the inherited role's vacated share, the new depth rank, the latest snap / target / red-zone
 * share, the window's expected points, the team's implied total.
 */
export function detectSignals(input: SignalInput): WaiverSignal[] {
  const out: WaiverSignal[] = [];
  const cascade = input.cascade ?? null;
  if (cascade !== null && finite(cascade.inherited_share) && cascade.inherited_share > 0)
    push(out, "injury_cascade", cascade.inherited_share, cascade.vacated_share);
  const depth = input.depth ?? null;
  if (
    depth !== null &&
    finite(depth.rank_now) &&
    finite(depth.rank_before) &&
    depth.rank_now >= 1 &&
    depth.rank_now < depth.rank_before
  )
    push(out, "depth_chart", depth.rank_before - depth.rank_now, depth.rank_now);

  const games = sortedGames(input.games);
  if (games.length >= SIGNALS.minGames) {
    const absent = new Set(input.teammate_absent_weeks ?? []);
    const snap = heldJump(games, (g) => g.snap_pct, SIGNALS.snapJump, absent);
    if (snap !== null) push(out, "snap_jump", snap.delta, snap.latest);
    const tgt = heldJump(games, (g) => g.target_share, SIGNALS.targetShareJump, absent);
    if (tgt !== null) push(out, "target_share_jump", tgt.delta, tgt.latest);
    const window = games.filter((g) => finite(g.xfp) && finite(g.points)).slice(-SIGNALS.xfpWindow);
    if (window.length === SIGNALS.xfpWindow) {
      const xfp = window.reduce((s, g) => s + (g.xfp ?? 0), 0);
      const pts = window.reduce((s, g) => s + (g.points ?? 0), 0);
      const gap = (xfp - pts) / window.length;
      if (gap >= SIGNALS.xfpGapPerGame) push(out, "xfp_gap", gap, xfp);
    }
    const rz = heldJump(games, (g) => g.rz_share, SIGNALS.rzShareJump, absent);
    if (rz !== null) push(out, "rz_shift", rz.delta, rz.latest);
  }

  const implied = input.implied ?? null;
  if (implied !== null && finite(implied.this_week) && finite(implied.season_mean)) {
    const d = implied.this_week - implied.season_mean;
    if (d >= SIGNALS.impliedTotalJump) push(out, "implied_total", d, implied.this_week);
  }
  return out;
}
