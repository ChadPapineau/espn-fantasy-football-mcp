// table.ts — the redistribution prior table built from pbp history (plan 10 §3.3; sib research 05
// §6.2: "when a RB1 misses, the RB2's carry share rises by X and target share by Y, on average, with
// spread … the plan should build this table rather than assume 1:1 inheritance"). Per injured
// position (RB, WR, TE), team context (pass tilt × the starter's hold) and beneficiary role, per
// component (targets, carries, red zone): the factor f in `E[Δshare_j] = f × vacated`, fitted
// through the origin over the absences (`f = Σ v·Δ / Σ v²` — the share noise does not scale with
// the vacated share), each context cell shrunk toward the position's pooled factor with κ =
// `shrink_events × mean v²`, plus the spread of the per-absence ratio and the count. `shrink_events`
// is chosen by leave-one-season-out WITHIN the build's own seasons (the grid value whose tables best
// predict the held-out season's share changes, squared error) — the held-out season of an outer
// evaluation is never read. The part of a vacated share no listed teammate takes (players signed or
// promoted during the absence, the offence getting worse) stays unassigned: the factors are learned,
// not normalised to 1. Pure. New here.
import { contextKey, contextOf } from "./predict.js";
import type {
  AbsenceEvent,
  AbsenceRules,
  BeneficiaryRole,
  CascadePriorTable,
  ContextKey,
  InjuredPosition,
  PriorCell,
  PriorComponent,
  PriorFactor,
} from "./types.js";
import { BENEFICIARY_ROLES, CONTEXT_KEYS, INJURED_POSITIONS, PRIOR_COMPONENTS } from "./types.js";

/** The table's fixed parameters (recorded in the table). */
export const TABLE_PARAMETERS = Object.freeze({
  /**
   * targets / (targets + carries) at or above → a "pass" team: the median over the 2023–2025
   * absences' pre windows (0.547; an input statistic — no outcome was read to set it).
   */
  tilt_cut: 0.55,
  /**
   * The starter's main share at or above → "lead": the median starter of each position over the
   * 2023–2025 absences (RB carries 0.510, WR targets 0.214, TE targets 0.164; inputs only).
   */
  hold_cut: Object.freeze({ RB: 0.5, WR: 0.21, TE: 0.16 } as Record<InjuredPosition, number>),
  /** The shrinkage grid (pseudo-absences); 1000 is the pooled row in all but name. */
  shrink_grid: Object.freeze([0, 3, 10, 30, 100, 1000] as const),
  /** The shrinkage when the build has fewer than two seasons to choose it with. */
  shrink_default: 30,
  /** A ratio Δ / v enters the spread only when v is at least this (a tiny v blows the ratio up). */
  spread_min_vacated: 0.02,
});

interface Acc {
  svy: number;
  svv: number;
  n: number;
  ratios: number[];
}
type Accs = Map<string, Acc>;
const accKey = (c: PriorComponent, r: BeneficiaryRole) => `${c}|${r}`;

function add(accs: Accs, c: PriorComponent, r: BeneficiaryRole, v: number, y: number): void {
  const k = accKey(c, r);
  let a = accs.get(k);
  if (a === undefined) {
    a = { svy: 0, svv: 0, n: 0, ratios: [] };
    accs.set(k, a);
  }
  a.svy += v * y;
  a.svv += v * v;
  a.n += 1;
  if (v >= TABLE_PARAMETERS.spread_min_vacated) a.ratios.push(y / v);
}

const r4 = (x: number): number => {
  const v = Math.round(x * 1e4) / 1e4;
  return v === 0 ? 0 : v;
};
function spread(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

function cellOf(
  accs: Accs,
  parent: PriorCell | null,
  kappa: Readonly<Record<PriorComponent, number>>,
): PriorCell {
  const out = {} as Record<PriorComponent, Partial<Record<BeneficiaryRole, PriorFactor>>>;
  for (const c of PRIOR_COMPONENTS) {
    const row: Partial<Record<BeneficiaryRole, PriorFactor>> = {};
    for (const r of BENEFICIARY_ROLES) {
      const a = accs.get(accKey(c, r));
      if (a === undefined) continue;
      const pf = parent?.[c][r]?.f;
      const k = pf === undefined ? 0 : kappa[c];
      const f = a.svv + k > 0 ? (a.svy + k * (pf ?? 0)) / (a.svv + k) : 0;
      row[r] = { f: r4(f), sd: r4(spread(a.ratios)), n: a.n };
    }
    out[c] = row;
  }
  return out;
}

/** Options for a table build. */
export interface BuildOptions {
  readonly rules: AbsenceRules;
  /** The role rule the events were built with (default `successor`). */
  readonly role_rule?: "usage" | "successor";
  /** A fixed shrinkage, or `auto` (the default): leave-one-season-out over the grid. */
  readonly shrink_events?: number | "auto";
  readonly provenance?: readonly string[];
}

function fit(
  events: readonly AbsenceEvent[],
  shrink: number,
): Pick<CascadePriorTable, "pooled" | "cells" | "absences_by_position"> {
  const cuts = { tilt_cut: TABLE_PARAMETERS.tilt_cut, hold_cut: TABLE_PARAMETERS.hold_cut };
  const pooledAcc = new Map<InjuredPosition, Accs>();
  const cellAcc = new Map<string, Accs>();
  const vv = new Map<string, { s: number; n: number }>();
  const byPos: Record<InjuredPosition, number> = { RB: 0, WR: 0, TE: 0 };
  for (const e of events) {
    const pos = e.injured.position;
    byPos[pos] += 1;
    const ck = contextKey(contextOf(pos, e.injured.pre, e.team_pre, cuts));
    const pa = pooledAcc.get(pos) ?? new Map<string, Acc>();
    pooledAcc.set(pos, pa);
    const ca = cellAcc.get(`${pos}|${ck}`) ?? new Map<string, Acc>();
    cellAcc.set(`${pos}|${ck}`, ca);
    for (const c of PRIOR_COMPONENTS) {
      const v = e.injured.pre[c];
      const m = vv.get(`${pos}|${c}`) ?? { s: 0, n: 0 };
      vv.set(`${pos}|${c}`, { s: m.s + v * v, n: m.n + 1 });
      for (const t of e.teammates) {
        const y = t.post[c] - t.pre[c];
        add(pa, c, t.role, v, y);
        add(ca, c, t.role, v, y);
      }
    }
  }
  const pooled = {} as Record<InjuredPosition, PriorCell>;
  const cells = {} as Record<InjuredPosition, Partial<Record<ContextKey, PriorCell>>>;
  for (const pos of INJURED_POSITIONS) {
    const kappa = {} as Record<PriorComponent, number>;
    for (const c of PRIOR_COMPONENTS) {
      const m = vv.get(`${pos}|${c}`);
      kappa[c] = m === undefined ? 0 : (shrink * m.s) / m.n;
    }
    const p = cellOf(pooledAcc.get(pos) ?? new Map<string, Acc>(), null, kappa);
    pooled[pos] = p;
    const row: Partial<Record<ContextKey, PriorCell>> = {};
    for (const ck of CONTEXT_KEYS) {
      const a = cellAcc.get(`${pos}|${ck}`);
      if (a !== undefined) row[ck] = cellOf(a, p, kappa);
    }
    cells[pos] = row;
  }
  return { pooled, cells, absences_by_position: byPos };
}

/**
 * The squared error of a fitted table's share predictions on held-out absences (every teammate,
 * every component; `vacated × max(0, f)`, the role's cell or the pooled row, 0 for a missing role).
 */
export function heldOutError(
  table: Pick<CascadePriorTable, "pooled" | "cells">,
  events: readonly AbsenceEvent[],
): number {
  const cuts = { tilt_cut: TABLE_PARAMETERS.tilt_cut, hold_cut: TABLE_PARAMETERS.hold_cut };
  let sse = 0;
  for (const e of events) {
    const pos = e.injured.position;
    const cell =
      table.cells[pos][contextKey(contextOf(pos, e.injured.pre, e.team_pre, cuts))] ??
      table.pooled[pos];
    for (const c of PRIOR_COMPONENTS)
      for (const t of e.teammates) {
        const f = cell[c][t.role]?.f ?? 0;
        sse += (t.post[c] - t.pre[c] - e.injured.pre[c] * Math.max(0, f)) ** 2;
      }
  }
  return sse;
}

/**
 * The shrinkage by leave-one-season-out over the build's seasons: per grid value, the summed
 * held-out squared error of tables fitted on the other seasons; the smallest wins (the first on a
 * tie). Fewer than two seasons → the default.
 */
export function chooseShrink(events: readonly AbsenceEvent[]): number {
  const seasons = [...new Set(events.map((e) => e.season))].sort((a, b) => a - b);
  if (seasons.length < 2) return TABLE_PARAMETERS.shrink_default;
  let best: number = TABLE_PARAMETERS.shrink_default;
  let bestErr = Number.POSITIVE_INFINITY;
  for (const k of TABLE_PARAMETERS.shrink_grid) {
    let err = 0;
    for (const s of seasons)
      err += heldOutError(
        fit(
          events.filter((e) => e.season !== s),
          k,
        ),
        events.filter((e) => e.season === s),
      );
    if (err < bestErr - 1e-12) {
      bestErr = err;
      best = k;
    }
  }
  return best;
}

/**
 * Builds the table from absence events (each event's teammates' realised share change against the
 * starter's vacated share). Seasons are the events' own. Deterministic: the same events give the
 * same table.
 */
export function buildPriorTable(
  events: readonly AbsenceEvent[],
  opts: BuildOptions,
): CascadePriorTable {
  const want = opts.shrink_events ?? "auto";
  const shrink =
    want === "auto"
      ? chooseShrink(events)
      : Number.isFinite(want) && want >= 0
        ? want
        : TABLE_PARAMETERS.shrink_default;
  const { pooled, cells, absences_by_position } = fit(events, shrink);
  return {
    version: "cascade-priors-v2",
    seasons: [...new Set(events.map((e) => e.season))].sort((a, b) => a - b),
    absences: events.length,
    absences_by_position,
    rules: opts.rules,
    tilt_cut: TABLE_PARAMETERS.tilt_cut,
    hold_cut: { ...TABLE_PARAMETERS.hold_cut },
    shrink_events: shrink,
    role_rule: opts.role_rule ?? "successor",
    pooled,
    cells,
    provenance: [...(opts.provenance ?? [])],
  };
}
