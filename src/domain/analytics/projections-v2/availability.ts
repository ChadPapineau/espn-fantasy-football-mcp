// availability.ts — P(active) (sibling research 05 §1 step 8; plan 07 D2): from the official game
// designation and the last practice participation (the trend), by the table fitted on the training
// season (constants.ts P_ACTIVE_V2; `fitAvailability`); inside the game-day window ESPN's status
// alone decides (plan 07 D2, sib ADV OBJ-16). The projection is the mixture: with probability
// P(active) the active distribution, otherwise 0. An unknown designation string reads as
// Questionable (uncertain, never certain — decision recorded). Pure. New here.
import { ESPN_DESIGNATION, P_ACTIVE_PRIOR, P_ACTIVE_V2 } from "./constants.js";
import type { V2ActiveEstimate, V2Availability } from "./types.js";

/** The official designations the table knows. */
const DESIGNATIONS: ReadonlySet<string> = new Set(["Questionable", "Doubtful", "Out"]);

/** A designation in the table's vocabulary ("" = none; unknown non-empty → Questionable). */
export function normalizeDesignation(d: string | null | undefined): string {
  if (d === null || d === undefined) return "";
  const t = d.trim();
  if (t.length === 0) return "";
  if (DESIGNATIONS.has(t)) return t;
  const upper = t.toUpperCase();
  if (Object.hasOwn(ESPN_DESIGNATION, upper)) return ESPN_DESIGNATION[upper] ?? "";
  const title = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  if (DESIGNATIONS.has(title)) return title;
  return "Questionable";
}

/** A practice participation in the table's vocabulary (FP / LP / DNP, "" = none or unknown). */
export function normalizePractice(p: string | null | undefined): string {
  if (p === null || p === undefined) return "";
  const t = p.trim().toLowerCase();
  if (t === "fp" || t.startsWith("full")) return "FP";
  if (t === "lp" || t.startsWith("limited")) return "LP";
  if (t === "dnp" || t.startsWith("did not")) return "DNP";
  return "";
}

/** The table's probability for a key, falling back to the designation alone, then 1. */
function lookup(table: Readonly<Record<string, number>>, des: string, prac: string): number {
  for (const key of [`${des}|${prac}`, `${des}|`]) {
    if (Object.hasOwn(table, key)) {
      const v = table[key];
      if (v !== undefined && Number.isFinite(v)) return Math.min(1, Math.max(0, v));
    }
  }
  return des === "Out" ? 0 : 1;
}

/** P(active) and its basis for one player-week. */
export function pActiveV2(
  a: V2Availability | null | undefined,
  table: Readonly<Record<string, number>> = P_ACTIVE_V2,
): V2ActiveEstimate {
  const des = normalizeDesignation(a?.designation);
  if (a?.game_day === true) {
    return { p: lookup(table, des, ""), basis: "espn_gameday_status" };
  }
  const prac = normalizePractice(a?.practice);
  const p = lookup(table, des, prac);
  if (des === "" && prac === "") return { p, basis: "none" };
  return { p, basis: prac === "" ? "designation_base_rate" : "trend_model" };
}

/** One labelled availability outcome (a listed player-week and whether he played). */
export interface AvailabilityOutcome {
  readonly designation: string | null;
  readonly practice: string | null;
  readonly played: boolean;
}

/**
 * The P(active) table fitted on labelled outcomes: per (designation, practice) cell the share who
 * played, shrunk toward `base`'s value with `k` pseudo-observations (cells with few rows stay near
 * the prior); every cell of `base` is kept. `Out` stays 0 (the enum ESPN enforces).
 */
export function fitAvailability(
  rows: readonly AvailabilityOutcome[],
  base: Readonly<Record<string, number>> = P_ACTIVE_PRIOR,
  k = 10,
): Readonly<Record<string, number>> {
  const cells = new Map<string, { n: number; played: number }>();
  const add = (key: string, played: boolean): void => {
    const c = cells.get(key) ?? { n: 0, played: 0 };
    c.n += 1;
    if (played) c.played += 1;
    cells.set(key, c);
  };
  for (const r of rows) {
    const des = normalizeDesignation(r.designation);
    const prac = normalizePractice(r.practice);
    add(`${des}|${prac}`, r.played);
    if (prac !== "") add(`${des}|`, r.played);
  }
  const out: Record<string, number> = { ...base };
  for (const [key, c] of cells) {
    if (key.startsWith("Out|")) {
      out[key] = 0;
      continue;
    }
    const des = key.slice(0, key.indexOf("|"));
    const prior = Object.hasOwn(base, key) ? (base[key] ?? 1) : lookup(base, des, "");
    out[key] = Math.round(((c.played + k * prior) / (c.n + k)) * 1000) / 1000;
  }
  return Object.freeze(out);
}

/** The Brier score of P(active) forecasts (null on an empty set). */
export function brierActive(rows: readonly { p: number; played: boolean }[]): number | null {
  if (rows.length === 0) return null;
  let s = 0;
  for (const r of rows) s += (r.p - (r.played ? 1 : 0)) ** 2;
  return s / rows.length;
}
