// verify.ts — the golden comparator (plan 08 §2 `verify`, §6 steps 1 and 3, E6; P16): per stat
// |engine − appliedStats{id}| ≤ 0.005 and |engine − appliedTotal| ≤ 0.01, never widened; the
// mismatch classes of §6 step 3; the > 10 % league-wide refusal share. Pure; plan 07 A5/B2 call it
// to fill `match`. A 100 %-coverage module (plan 05 §7, T-10).
import { score } from "./engine.js";
import { ScoringError } from "./errors.js";
import { denoise, finiteWithin, MAX_ABS_STAT } from "./numeric.js";
import { canonicalDef } from "./registry.js";
import type {
  AppliedReference,
  MismatchKind,
  ScoreResult,
  ScoringSettings,
  StatLine,
  VerifyResult,
} from "./types.js";
import { GOLDEN_TOLERANCE, LEAGUE_MISMATCH_REFUSAL_SHARE } from "./types.js";

/** Slack for binary-float noise on top of the tolerances (never widens them materially). */
const FLOAT_SLACK = 1e-9;
/** A total off by at most this much with every stat matching is a rounding difference (§6 step 3). */
const ROUNDING_BAND = 0.02;
/** `appliedStats` keys are ESPN statIds. */
const STAT_ID_RE = /^(0|[1-9]\d{0,3})$/;
/** Most `appliedStats` entries one line may carry. */
const MAX_APPLIED = 1000;

/** Whether two per-stat point values match (≤ 0.005). Non-finite values never match. */
export function statPointsMatch(engine: number, espn: number): boolean {
  return (
    Number.isFinite(engine) &&
    Number.isFinite(espn) &&
    Math.abs(engine - espn) <= GOLDEN_TOLERANCE.per_stat + FLOAT_SLACK
  );
}

/** Whether two totals match (≤ 0.01). Non-finite values never match. */
export function totalPointsMatch(engine: number, espn: number): boolean {
  return (
    Number.isFinite(engine) &&
    Number.isFinite(espn) &&
    Math.abs(engine - espn) <= GOLDEN_TOLERANCE.per_total + FLOAT_SLACK
  );
}

/**
 * Whether `mismatched` of `total` rostered player-weeks is a settings change rather than a stat
 * correction (plan 08 E6): strictly more than 10 %. Zero or invalid counts are never league-wide.
 */
export function isLeagueWideMismatch(mismatched: number, total: number): boolean {
  if (!Number.isInteger(mismatched) || !Number.isInteger(total) || total <= 0 || mismatched < 0) {
    return false;
  }
  return mismatched / total > LEAGUE_MISMATCH_REFUSAL_SHARE;
}

/** Validates ESPN's applied values (numbers on the wire — a non-number is drift, plan 08 §3.3). */
function checkApplied(applied: AppliedReference): AppliedReference {
  const raw: unknown = applied;
  if (raw === null || typeof raw !== "object")
    throw new ScoringError("drift", "applied must be an object");
  if (!finiteWithin(applied.total, MAX_ABS_STAT))
    throw new ScoringError("drift", "appliedTotal is not a finite number");
  const byStat: unknown = applied.by_stat;
  if (byStat === null || typeof byStat !== "object" || Array.isArray(byStat)) {
    throw new ScoringError("drift", "appliedStats must be an object");
  }
  const keys = Object.keys(byStat);
  if (keys.length > MAX_APPLIED) throw new ScoringError("drift", "too many appliedStats");
  for (const k of keys) {
    if (!STAT_ID_RE.test(k))
      throw new ScoringError("drift", "appliedStats key is not a statId", [k]);
    if (!finiteWithin((byStat as Record<string, unknown>)[k], MAX_ABS_STAT)) {
      throw new ScoringError("drift", "appliedStats value is not a finite number", [k]);
    }
  }
  return applied;
}

/** Engine points per ESPN statId (one rule per id, so one contribution per id). */
function enginePerStat(result: ScoreResult): Map<string, number> {
  return new Map(result.contributions.map((c) => [c.platform_id, c.points]));
}

interface Comparison {
  readonly result: ScoreResult;
  readonly engine: Map<string, number>;
  readonly mismatched: readonly string[];
  readonly delta_total: number;
}

function compare(line: StatLine, settings: ScoringSettings, applied: AppliedReference): Comparison {
  const a = checkApplied(applied);
  const result = score(line, settings);
  const engine = enginePerStat(result);
  const ids = new Set<string>([...engine.keys(), ...Object.keys(a.by_stat)]);
  const mismatched = [...ids]
    .filter((id) => !statPointsMatch(engine.get(id) ?? 0, a.by_stat[id] ?? 0))
    .sort((x, y) => Number(x) - Number(y));
  return { result, engine, mismatched, delta_total: denoise(result.points - a.total) };
}

/**
 * The golden comparator (plan 08 §2, §6; P16): scores the line and compares it with ESPN's own
 * `appliedTotal` and `appliedStats`. `match` is true iff every per-stat delta (over the union of
 * the engine's and ESPN's ids, an absent id counting 0) is ≤ 0.005 and the total delta ≤ 0.01.
 * `delta_total` is engine − ESPN. A non-number in `applied` throws `drift`.
 */
export function verify(
  line: StatLine,
  settings: ScoringSettings,
  applied: AppliedReference,
): VerifyResult {
  const c = compare(line, settings, applied);
  return Object.freeze({
    match: c.mismatched.length === 0 && totalPointsMatch(c.result.points, applied.total),
    mismatch_stat_ids: Object.freeze(c.mismatched),
    delta_total: c.delta_total,
  });
}

/**
 * Diagnoses a mismatch (plan 08 §6 step 3), sorted and unique; empty when it matches or no class
 * fits: `unmapped_id` — ESPN scored an id the settings do not map; `bracket_bounds` — a family
 * member's points differ; `translator` — ESPN scored a stat the line does not carry;
 * `override_missed` — ESPN's points per unit equal another of the rule's values (base or an
 * override); `disputed_103_104` — swapping the engine's 103 and 104 fixes both; `rounding` — every
 * stat matches and the total is off by ≤ 0.02.
 */
export function classifyMismatch(
  line: StatLine,
  settings: ScoringSettings,
  applied: AppliedReference,
): readonly MismatchKind[] {
  const c = compare(line, settings, applied);
  const kinds = new Set<MismatchKind>();
  const rules = new Map(settings.rules.map((r) => [r.platform_id, r]));
  for (const id of c.mismatched) {
    const espn = applied.by_stat[id] ?? 0;
    const rule = rules.get(id);
    const canonical = rule?.canonical ?? null;
    // no engine contribution here, so a mismatch means ESPN scored it
    if (rule === undefined || canonical === null) {
      kinds.add("unmapped_id");
      continue;
    }
    if (canonicalDef(canonical)?.family) kinds.add("bracket_bounds");
    const value = Object.hasOwn(line.values, canonical) ? line.values[canonical] : undefined;
    if (value === undefined || value === 0) {
      kinds.add("translator");
      continue;
    }
    const perUnit = espn / value;
    const candidates = [rule.points, ...Object.values(rule.overrides)];
    if (candidates.some((p) => Math.abs(p - perUnit) <= FLOAT_SLACK)) kinds.add("override_missed");
  }
  if (c.mismatched.includes("103") || c.mismatched.includes("104")) {
    const e103 = c.engine.get("103") ?? 0;
    const e104 = c.engine.get("104") ?? 0;
    if (
      statPointsMatch(e104, applied.by_stat["103"] ?? 0) &&
      statPointsMatch(e103, applied.by_stat["104"] ?? 0)
    ) {
      kinds.add("disputed_103_104");
    }
  }
  const off = Math.abs(c.delta_total);
  if (
    c.mismatched.length === 0 &&
    off > GOLDEN_TOLERANCE.per_total + FLOAT_SLACK &&
    off <= ROUNDING_BAND
  ) {
    kinds.add("rounding");
  }
  return Object.freeze([...kinds].sort());
}
