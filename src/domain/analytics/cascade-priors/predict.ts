// predict.ts — cascade v2's split from the redistribution prior table (plan 10 §3.3, C6; plan 07 E7;
// sib research 05 §6.1–§6.2): each teammate's ROLE (his position and rank among the remaining
// teammates at it — by opportunities per game with the starter, except at the injured player's
// position, where the successor rule ranks by the starter's own kind of opportunity and puts the
// receivers behind the two remaining starters in depth-chart order; the same rule the table was
// built with), the TEAM CONTEXT (pass tilt from the team's volume, the starter's hold on his main
// component), and per component the expected share gain `vacated × f[cell][role]`, clamped ≥ 0,
// times P(active), the sum capped at the vacated share (plan 10 B6: beneficiaries never inherit more
// than was vacated). One implementation serves the table builder and E7, so a role means the same
// thing in both. Pure. New here.
import type {
  BeneficiaryRole,
  CascadePriorTable,
  ComponentShares,
  ComponentVolume,
  ContextKey,
  InjuredPosition,
  PriorCell,
  PriorComponent,
  SkillPosition,
  TeamContext,
} from "./types.js";
import { INJURED_POSITIONS, PRIOR_COMPONENTS } from "./types.js";

/** Ranks kept per position before the role pools (QB2+, RB3+, WR4+, TE2+). */
const ROLE_DEPTH: Readonly<Record<SkillPosition, number>> = Object.freeze({
  QB: 2,
  RB: 3,
  WR: 4,
  TE: 2,
});

/** Whether a position string is one the table models as an absence. */
export function isInjuredPosition(p: string): p is InjuredPosition {
  return (INJURED_POSITIONS as readonly string[]).includes(p);
}

const SKILL: readonly string[] = ["QB", "RB", "WR", "TE"];
/** Whether a position string is a skill position (a beneficiary the table can rank). */
export function isSkillPosition(p: string): p is SkillPosition {
  return SKILL.includes(p);
}

/** A teammate as the role rule sees him. */
export interface RoleInput {
  readonly position: string;
  /** Opportunities (targets + carries) per game with the starter; non-finite → 0. */
  readonly opportunities: number;
  /** Depth-chart rank at his position (tie-break; null = unlisted, ranked last). */
  readonly depth: number | null;
  /**
   * His per-game count of the injured player's MAIN component (carries for a back's absence,
   * targets otherwise) — at the injured player's position the successor is the one who already had
   * that kind of opportunity. Absent → his opportunities.
   */
  readonly main?: number;
  /** The final tie-break (a stable id). */
  readonly key: string;
}

const finite0 = (x: number | null | undefined): number =>
  typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0;

/**
 * The base-personnel starters per position (11 personnel: one back, three receivers, one tight end).
 * When a receiver starter is out, the other two keep their roles and the next receiver ON THE DEPTH
 * CHART steps in — often a backup with almost no usage, whom only the chart names.
 */
export const BASE_STARTERS: Readonly<Record<SkillPosition, number>> = Object.freeze({
  QB: 1,
  RB: 1,
  WR: 3,
  TE: 1,
});

/**
 * The positions where the depth chart orders the players behind the remaining starters: receivers
 * only. At a one-starter position (RB, TE) the established backup's own usage already shows the
 * role and the weekly chart is often stale, so usage keeps the order there.
 */
export const DEPTH_NEXT_POSITIONS: readonly SkillPosition[] = Object.freeze(["WR"]);

/**
 * How roles are assigned: `usage` — by opportunities at every position; `successor` — at the
 * injured player's position by HIS main component (the successor already had that kind of
 * opportunity), with receivers behind the two remaining base starters in depth-chart order.
 */
export type RoleRule = "usage" | "successor";

const keyOrder = (a: RoleInput, b: RoleInput): number =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
const depthOrder = (a: RoleInput, b: RoleInput): number =>
  (a.depth ?? Number.POSITIVE_INFINITY) - (b.depth ?? Number.POSITIVE_INFINITY);
const byUsage = (a: RoleInput, b: RoleInput): number =>
  finite0(b.opportunities) - finite0(a.opportunities) || depthOrder(a, b) || keyOrder(a, b);
const byMain = (a: RoleInput, b: RoleInput): number =>
  finite0(b.main ?? b.opportunities) - finite0(a.main ?? a.opportunities) || byUsage(a, b);
const byDepth = (a: RoleInput, b: RoleInput): number =>
  depthOrder(a, b) ||
  finite0(b.main ?? b.opportunities) - finite0(a.main ?? a.opportunities) ||
  finite0(b.opportunities) - finite0(a.opportunities) ||
  keyOrder(a, b);

/**
 * Each teammate's role: his rank among the given teammates at his position, ranks past the
 * position's pool merged (QB2+, RB3+, WR4+, TE2+). Away from the injured player's position (and
 * everywhere under `usage`) the rank is by opportunities (desc; depth, then key break ties). Under
 * `successor`, at the injured player's position the rank is by his main component (then
 * opportunities, depth, key), and for receivers only the two remaining base starters keep that
 * order — the rest follow the depth chart (an unlisted player last). A non-skill position has no
 * role (null). The result is index-aligned with the input.
 */
export function rolesOf(
  mates: readonly RoleInput[],
  injured: InjuredPosition | null = null,
  rule: RoleRule = "successor",
): (BeneficiaryRole | null)[] {
  const out: (BeneficiaryRole | null)[] = mates.map(() => null);
  for (const pos of SKILL as readonly SkillPosition[]) {
    const idx = mates.map((m, i) => ({ m, i })).filter(({ m }) => m.position === pos);
    const successor = rule === "successor" && pos === injured;
    idx.sort((a, b) => (successor ? byMain(a.m, b.m) : byUsage(a.m, b.m)));
    let order = idx;
    if (successor && DEPTH_NEXT_POSITIONS.includes(pos)) {
      const keep = Math.max(0, BASE_STARTERS[pos] - 1);
      order = [...idx.slice(0, keep), ...idx.slice(keep).sort((a, b) => byDepth(a.m, b.m))];
    }
    order.forEach(({ i }, rank) => {
      out[i] = `${pos}${String(Math.min(rank + 1, ROLE_DEPTH[pos]))}` as BeneficiaryRole;
    });
  }
  return out;
}

/** The starter's main component: carries for a back, targets otherwise. */
export function mainComponent(position: InjuredPosition): PriorComponent {
  return position === "RB" ? "carries" : "targets";
}

/** The team context from the team's volume and the injured player's shares, at the table's cuts. */
export function contextOf(
  position: InjuredPosition,
  injured: ComponentShares,
  volume: ComponentVolume,
  cuts: Pick<CascadePriorTable, "tilt_cut" | "hold_cut">,
): TeamContext {
  const t = finite0(volume.targets);
  const c = finite0(volume.carries);
  const tilt = t + c > 0 && t / (t + c) >= cuts.tilt_cut ? "pass" : "run";
  const main = finite0(injured[mainComponent(position)]);
  return { tilt, hold: main >= cuts.hold_cut[position] ? "lead" : "share" };
}

/** A context's cell key. */
export function contextKey(ctx: TeamContext): ContextKey {
  return `${ctx.tilt}|${ctx.hold}`;
}

/** The cell a lookup reads: the context's cell, else the position's pooled row. */
export function cellFor(
  table: CascadePriorTable,
  position: InjuredPosition,
  ctx: TeamContext,
): { readonly cell: PriorCell; readonly pooled: boolean } {
  const cell = table.cells[position][contextKey(ctx)];
  return cell === undefined
    ? { cell: table.pooled[position], pooled: true }
    : { cell, pooled: false };
}

/** A teammate as the split sees him. */
export interface SplitMate extends RoleInput {
  /** P(he is active) — his share of a gain is scaled by it (OUT teammates take nothing). */
  readonly p_active: number;
}

/** The split's outcome: per teammate (index-aligned) and component, the expected share gain. */
export interface PriorSplit {
  readonly context: TeamContext;
  readonly pooled: boolean;
  readonly roles: readonly (BeneficiaryRole | null)[];
  readonly delta: readonly Readonly<Record<PriorComponent, number>>[];
}

/**
 * The prior split for one absence: `vacated[c] × max(0, f[c][role]) × P(active)` per teammate and
 * component, scaled down so no component's sum exceeds its vacated share. A component never
 * vacated, a teammate without a role or a role absent from the cell gains nothing.
 */
export function priorSplit(
  table: CascadePriorTable,
  position: InjuredPosition,
  vacated: ComponentShares,
  volume: ComponentVolume,
  mates: readonly SplitMate[],
): PriorSplit {
  const context = contextOf(position, vacated, volume, table);
  const { cell, pooled } = cellFor(table, position, context);
  const roles = rolesOf(mates, position, table.role_rule);
  const delta = mates.map(() => ({ targets: 0, carries: 0, rz: 0 }));
  for (const c of PRIOR_COMPONENTS) {
    const v = Math.min(1, finite0(vacated[c]));
    if (!(v > 0)) continue;
    const raw = mates.map((m, i) => {
      const role = roles[i] ?? null;
      const f = role === null ? undefined : cell[c][role]?.f;
      const pa = Number.isFinite(m.p_active) ? Math.min(1, Math.max(0, m.p_active)) : 1;
      return f === undefined || !Number.isFinite(f) ? 0 : v * Math.max(0, f) * pa;
    });
    const sum = raw.reduce((s, x) => s + x, 0);
    const scale = sum > v ? v / sum : 1;
    raw.forEach((x, i) => {
      const d = delta[i];
      if (d !== undefined) d[c] = x * scale;
    });
  }
  return { context, pooled, roles, delta };
}
