// engine.ts — the pure scorer (plan 08 E1: `score`, `scoreSamples`, `explain`; no I/O, no clock, no
// randomness): §3.4 class gating and per-POSITION overrides inside `score`, §4.1 exclusive tiers
// asserted / derived lines bracketized, §4.2–§4.3 bonuses, per-N and long-TD (underivable), §4.6
// exact arithmetic and the verified rounding rule (E4), §4.7 missing vs unknown and `complete`,
// §5 / E5 distributions over SCORED SAMPLES. Ported from sibling @cf3b015 (compile memo, evaluate,
// quantiles, scoreSamples), adapted to ESPN's id-keyed rules and families.
import { bracketize, familyKey } from "./brackets.js";
import { ScoringError } from "./errors.js";
import { at, denoise, finiteWithin, MAX_ABS_STAT, stableSum } from "./numeric.js";
import { CANONICAL_DEFS, canonicalDef, FAMILY_KIND, type FamilyKind } from "./registry.js";
import { applyRounding } from "./rounding.js";
import { renormalizeSettings, unmappedIds } from "./settings.js";
import type {
  BracketFamily,
  Canonical,
  Dist,
  DistBasis,
  PositionClass,
  ScoreContribution,
  ScoreResult,
  ScoreSamplesResult,
  ScoringSettings,
  StatLine,
} from "./types.js";
import { CANONICAL_NAME_RE, DIST_BASES, POSITION_CLASSES } from "./types.js";

// --- compilation (memoised per settings object) --------------------------------------------------

interface CompiledRule {
  readonly canonical: Canonical;
  readonly platform_id: string;
  readonly points: number;
  readonly overrides: Readonly<Record<string, number>>;
  readonly kind: ScoreContribution["kind"];
  /** Registry `zero_with` / `length` family: absent from a derived line → underivable. */
  readonly underivable_when_absent: boolean;
  readonly zero_with: Canonical | null;
}

interface CompiledFamily {
  readonly family: BracketFamily;
  readonly key: string;
  readonly kind: FamilyKind;
  /** Every registry member of this family key (detects a pre-bucketed line; exclusivity check). */
  readonly all_members: readonly Canonical[];
}

interface CompiledClass {
  readonly rules: readonly CompiledRule[];
  readonly families: readonly CompiledFamily[];
  /** Rule canonicals and family scalars: what a line of this class can use (not `ignored`). */
  readonly consumed: ReadonlySet<Canonical>;
  /** Bonus-kind rule canonicals (for `bonus_probability`). */
  readonly bonuses: readonly Canonical[];
}

interface Compiled {
  readonly settings: ScoringSettings;
  readonly byClass: Readonly<Record<PositionClass, CompiledClass>>;
  readonly unmapped: readonly string[];
}

const COMPILED = new WeakMap<ScoringSettings, Compiled>();

/** Every registry member of a family key, in registry order (detects a pre-bucketed line). */
function registryMembers(f: BracketFamily): readonly Canonical[] {
  return CANONICAL_DEFS.filter(
    (d) => d.family !== null && d.family.name === f.family && d.family.scalar === f.scalar,
  ).map((d) => d.canonical);
}

/**
 * Indexes settings per class once (memoised on the object). The settings are RE-NORMALISED first
 * (renormalizeSettings): a hand-built object is validated and its families rebuilt from its rules,
 * so no non-finite number and no untrusted family can reach a total.
 */
function compile(input: ScoringSettings): Compiled {
  const hit = COMPILED.get(input);
  if (hit !== undefined) return hit;
  const settings = renormalizeSettings(input);
  const byClass = {} as Record<PositionClass, CompiledClass>;
  for (const cls of POSITION_CLASSES) {
    const rules: CompiledRule[] = [];
    const consumed = new Set<Canonical>();
    for (const r of settings.rules) {
      if (r.canonical === null || !r.applies_to.includes(cls)) continue;
      const def = canonicalDef(r.canonical);
      const fam = def === undefined ? null : def.family;
      const lengthFamily = fam !== null && FAMILY_KIND[fam.name] === "length";
      const zeroWith = def === undefined ? null : def.zero_with;
      rules.push({
        canonical: r.canonical,
        platform_id: r.platform_id,
        points: r.points,
        overrides: r.overrides,
        kind: def === undefined ? "linear" : def.kind,
        underivable_when_absent: lengthFamily || zeroWith !== null,
        zero_with: zeroWith,
      });
      consumed.add(r.canonical);
    }
    const fams: CompiledFamily[] = [];
    for (const f of settings.families) {
      if (f.position_class !== cls) continue;
      fams.push({
        family: f,
        key: familyKey(f),
        kind: FAMILY_KIND[f.family],
        all_members: registryMembers(f),
      });
      consumed.add(f.scalar);
    }
    byClass[cls] = {
      rules,
      families: fams,
      consumed,
      bonuses: rules.filter((r) => r.kind === "bonus").map((r) => r.canonical),
    };
  }
  const compiled: Compiled = { settings, byClass, unmapped: unmappedIds(settings) };
  COMPILED.set(input, compiled);
  return compiled;
}

// --- one line ------------------------------------------------------------------------------------

/** How a line's source is treated (plan 08 §4.1, §4.7). */
type Regime = "espn" | "projection" | "derived";

/** Slack for ESPN's projected tier probabilities (they sum to 1 ± 2e-9 — recorded). */
const EXCLUSIVE_SLACK = 1e-6;

interface Evaluation {
  readonly result: ScoreResult;
  /** Per compiled family: the member values used (line or derived), or null when absent. */
  readonly familyValues: readonly (readonly number[] | null)[];
  /** Per bonus canonical of the class: the value used (0 when absent). */
  readonly bonusValues: readonly number[];
  readonly parts: { readonly linear: number; readonly bonus: number; readonly bracket: number };
}

function invalidLine(message: string, detail: readonly string[] = []): ScoringError {
  return new ScoringError("invalid_line", message, detail);
}

/** Validates the line's shape (P11): every value finite and in range, a known class and position. */
function checkLine(line: StatLine): {
  values: Readonly<Record<string, number>>;
  keys: string[];
  regime: Regime;
} {
  const raw: unknown = line;
  if (raw === null || typeof raw !== "object") throw invalidLine("stat line must be an object");
  const position: unknown = line.position;
  if (
    typeof position !== "number" ||
    !Number.isInteger(position) ||
    position < 0 ||
    position > 99
  ) {
    throw invalidLine("position must be an ESPN position id 0..99");
  }
  if (!POSITION_CLASSES.includes(line.position_class)) throw invalidLine("unknown position class");
  const source: unknown = line.source;
  if (typeof source !== "string") throw invalidLine("source must be a string");
  const rawValues: unknown = line.values;
  if (rawValues === null || typeof rawValues !== "object")
    throw invalidLine("values must be an object");
  const values = rawValues as Readonly<Record<string, unknown>>;
  const keys = Object.keys(values);
  for (const k of keys) {
    if (!finiteWithin(values[k], MAX_ABS_STAT)) {
      throw invalidLine("stat value is not a finite in-range number", [k]);
    }
  }
  const regime: Regime =
    source === "espn" ? "espn" : source.startsWith("projection:") ? "projection" : "derived";
  return { values: values as Readonly<Record<string, number>>, keys, regime };
}

/**
 * Scores one line (`detail: false` — the scoreSamples path — skips `contributions` and `ignored`;
 * every number is computed identically).
 */
function evaluate(line: StatLine, settings: ScoringSettings, detail: boolean): Evaluation {
  const compiled = compile(settings);
  const { values, keys, regime } = checkLine(line);
  const t = compiled.byClass[line.position_class];
  const get = (c: Canonical): number | undefined =>
    Object.hasOwn(values, c) ? values[c] : undefined;
  const derived = new Map<Canonical, number>();

  // families: assert exclusivity on what the line carries; bracketize a scalar for derived lines
  const familyValues: (readonly number[] | null)[] = [];
  for (const f of t.families) {
    const carried: number[] = [];
    for (const c of f.all_members) {
      const v = get(c);
      if (v === undefined) continue;
      if (f.family.exclusive && (v < 0 || v > 1 + EXCLUSIVE_SLACK)) {
        throw new ScoringError("bracket_exclusivity", "tier member is not in [0, 1]", [f.key, c]);
      }
      carried.push(v);
    }
    if (f.family.exclusive && stableSum(carried) > 1 + EXCLUSIVE_SLACK) {
      throw new ScoringError("bracket_exclusivity", "two exclusive tiers set in one game", [f.key]);
    }
    const scalar = get(f.family.scalar);
    let vector: readonly number[] | null = null;
    if (carried.length > 0) {
      vector = f.family.members.map((m) => get(m.canonical) ?? 0);
    } else if (regime !== "espn" && scalar !== undefined) {
      vector = bracketize(f.family, scalar);
      if (vector !== null) {
        const v = vector;
        f.family.members.forEach((m, i) => derived.set(m.canonical, at(v, i)));
      }
    }
    familyValues.push(vector);
  }

  const contributions: ScoreContribution[] | null = detail ? [] : null;
  const perStat: number[] = [];
  const parts = { linear: [] as number[], bonus: [] as number[], bracket: [] as number[] };
  const underivable: Canonical[] = [];
  let missing = false;
  const posKey = String(line.position);
  const bonusValue = new Map<Canonical, number>();
  for (const r of t.rules) {
    // position-id keys are "0".."99": never an Object.prototype name
    const override = r.overrides[posKey];
    const pts = override ?? r.points;
    let value = get(r.canonical) ?? derived.get(r.canonical);
    if (
      value === undefined &&
      regime !== "espn" &&
      r.zero_with !== null &&
      get(r.zero_with) === 0
    ) {
      value = 0;
    }
    if (value === undefined) {
      if (pts !== 0) {
        missing = true;
        if (regime === "derived" && r.underivable_when_absent) underivable.push(r.canonical);
      }
      continue;
    }
    if (r.kind === "bonus") bonusValue.set(r.canonical, value);
    const points = denoise(pts * value);
    perStat.push(points);
    parts[r.kind].push(points);
    contributions?.push({
      canonical: r.canonical,
      platform_id: r.platform_id,
      value,
      points_per: pts,
      override_used: override !== undefined,
      points,
      kind: r.kind,
    });
  }

  const exact = denoise(stableSum(perStat));
  const ignored = detail
    ? keys.filter((k) => CANONICAL_NAME_RE.test(k) && !t.consumed.has(k)).sort()
    : [];
  const result: ScoreResult = Object.freeze({
    points: applyRounding(exact, perStat, compiled.settings.rounding),
    points_exact: exact,
    complete: !(line.provisional && missing) && underivable.length === 0,
    unmapped: compiled.unmapped,
    ignored: Object.freeze(ignored),
    underivable: Object.freeze(underivable.sort()),
    contributions: Object.freeze(contributions ?? []),
  });
  return {
    result,
    familyValues,
    bonusValues: t.bonuses.map((c) => bonusValue.get(c) ?? 0),
    parts: {
      linear: stableSum(parts.linear),
      bonus: stableSum(parts.bonus),
      bracket: stableSum(parts.bracket),
    },
  };
}

/**
 * Scores one canonical line under normalised settings (plan 08 §2, §3.4, §4): rules gated by the
 * line's class, the per-POSITION override used where one exists, ESPN lines scored as sent
 * (pre-bucketed), derived and projection lines bracketized from their scalars, exclusivity of tier
 * families asserted. Throws `invalid_line` (malformed line), `bracket_exclusivity` (two tiers set,
 * a tier outside [0, 1]) or `invalid_settings` / `bracket_bounds` (hand-built settings).
 */
export function score(line: StatLine, settings: ScoringSettings): ScoreResult {
  return evaluate(line, settings, true).result;
}

/** `score`, named for the tools that render `contributions` (plan 08 §2). */
export const explain: (line: StatLine, settings: ScoringSettings) => ScoreResult = score;

/** Σ of player points with compensated summation, denoised (the matchup layer's starters' sum). */
export function sumPoints(points: readonly number[]): number {
  for (const p of points) {
    if (!finiteWithin(p, MAX_ABS_STAT)) throw invalidLine("points must be finite and in range");
  }
  return denoise(stableSum(points));
}

// --- distributions -------------------------------------------------------------------------------

/** Most samples one `scoreSamples` call accepts (the analytics layer bounds n_sims below it). */
export const MAX_SAMPLES = 100_000;

/** Linear-interpolation quantile (Hyndman–Fan type 7) of an ascending array. */
function quantile(sorted: readonly number[], p: number): number {
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const a = at(sorted, lo);
  const b = at(sorted, Math.min(lo + 1, sorted.length - 1));
  return denoise(a + (h - lo) * (b - a));
}

const byKey = <V>(m: Map<string, V>): [string, V][] => [...m].sort(([a], [b]) => (a < b ? -1 : 1));

/**
 * Scores sampled stat lines into a distribution (plan 08 §2, §5, E5): quantiles and `p_zero` over
 * the final points; `mean_of_exact` = E[linear] + E[bonus] + E[bracket] over the exact totals, so a
 * bonus contributes P(stat ≥ target) × points, never [E[stat] ≥ target] × points (P5, P13);
 * `bonus_probability` = mean of min(value, 1) per bonus stat (a fired indicator, a count ≥ 1, or
 * ESPN's own fractional probability); `bracket_probability` per family key = mean member values.
 * Throws `invalid_line` on an empty or oversized batch or an unknown basis.
 */
export function scoreSamples(
  lines: readonly StatLine[],
  settings: ScoringSettings,
  basis: DistBasis,
): ScoreSamplesResult {
  if (!DIST_BASES.includes(basis)) throw invalidLine("basis must be position_cv or player_sim");
  const shape: unknown = lines;
  if (!Array.isArray(shape) || lines.length === 0 || lines.length > MAX_SAMPLES) {
    throw invalidLine(`samples must be 1..${String(MAX_SAMPLES)} lines`);
  }
  const compiled = compile(settings);
  const n = lines.length;
  const points: number[] = [];
  const exact: number[] = [];
  const bonusTotals = new Map<Canonical, number>();
  const familyTotals = new Map<string, number[]>();
  for (const line of lines) {
    const e = evaluate(line, settings, false);
    const t = compiled.byClass[line.position_class];
    t.bonuses.forEach((c, i) => {
      bonusTotals.set(c, (bonusTotals.get(c) ?? 0) + Math.min(at(e.bonusValues, i), 1));
    });
    t.families.forEach((f, i) => {
      const totals = familyTotals.get(f.key) ?? f.family.members.map(() => 0);
      const vec = at(e.familyValues, i);
      if (vec !== null) vec.forEach((v, j) => (totals[j] = at(totals, j) + v));
      familyTotals.set(f.key, totals);
    });
    points.push(e.result.points);
    exact.push(stableSum([e.parts.linear, e.parts.bonus, e.parts.bracket]));
  }
  const sorted = [...points].sort((a, b) => a - b);
  const dist: Dist = Object.freeze({
    mean: denoise(stableSum(points) / n),
    p10: quantile(sorted, 0.1),
    p25: quantile(sorted, 0.25),
    p50: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.9),
    p_zero: denoise(points.filter((p) => p === 0).length / n),
    basis,
  });
  const bonus_probability: Record<Canonical, number> = {};
  for (const [c, total] of byKey(bonusTotals)) bonus_probability[c] = denoise(total / n);
  const bracket_probability: Record<string, readonly number[]> = {};
  for (const [k, totals] of byKey(familyTotals)) {
    bracket_probability[k] = Object.freeze(totals.map((x) => denoise(x / n)));
  }
  return Object.freeze({
    dist,
    mean_of_exact: denoise(stableSum(exact) / n),
    bonus_probability: Object.freeze(bonus_probability),
    bracket_probability: Object.freeze(bracket_probability),
  });
}
