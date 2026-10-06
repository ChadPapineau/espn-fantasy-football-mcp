// brackets.ts — bracket families built from the ids present in S (plan 08 E3, §4.1: members filtered
// to S, sorted, partition asserted — an overlap is an error naming both ids, a gap is legal and
// recorded as complete_range: false), and `bracketize(family, scalar)` for derived lines (§4.1
// "Scoring a derived line"; P4). Ported from sibling @cf3b015 (contiguity, bracketize), adapted to
// ESPN's id-keyed bounds (no name parsing).
import { ScoringError } from "./errors.js";
import { at, finiteWithin, MAX_ABS_STAT } from "./numeric.js";
import { CANONICAL_DEFS, canonicalDef, FAMILY_KIND, type FamilyKind } from "./registry.js";
import type {
  BracketFamily,
  BracketFamilyName,
  BracketMember,
  Canonical,
  PositionClass,
  ScoringRule,
} from "./types.js";
import { POSITION_CLASSES } from "./types.js";

/** The kind of a family (tier, count, threshold, length, per_n). */
export function familyKind(family: BracketFamily): FamilyKind {
  return FAMILY_KIND[family.family];
}

/** A family's identity: name + scalar (three `yardage_bonus` families exist, one per yardage). */
export function familyKey(family: {
  readonly family: BracketFamilyName;
  readonly scalar: Canonical;
}): string {
  return `${family.family}:${family.scalar}`;
}

/** The lowest lower bound the registry gives each family key (where a complete range starts). */
const REGISTRY_MIN: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  for (const d of CANONICAL_DEFS) {
    if (d.family === null) continue;
    const key = familyKey({ family: d.family.name, scalar: d.family.scalar });
    m.set(key, Math.min(m.get(key) ?? Number.POSITIVE_INFINITY, d.family.lower));
  }
  return m;
})();

/** An upper bound as a number (open-ended = +∞). */
const upperOf = (m: BracketMember): number => m.upper ?? Number.POSITIVE_INFINITY;
/** Registry members of one family never share a lower bound with the same upper bound. */
const byBounds = (a: BracketMember, b: BracketMember): number =>
  a.lower - b.lower || upperOf(a) - upperOf(b);

/**
 * For a partition family (`tier`, `count`): throws `bracket_bounds` naming the first two members
 * that overlap (74 legacy 50+ with 198 50–59 — plan 08 §4.1), else returns whether the members
 * cover the registry's whole range with no gap (a gap is legal: a kick in it scores 0).
 */
function partitionComplete(
  name: BracketFamilyName,
  key: string,
  members: readonly BracketMember[],
): boolean {
  let contiguous = true;
  for (let i = 0; i + 1 < members.length; i += 1) {
    const m = at(members, i);
    const next = at(members, i + 1);
    if (m.upper === null || next.lower <= m.upper) {
      throw new ScoringError("bracket_bounds", `bracket family ${name} overlaps`, [
        m.platform_id,
        next.platform_id,
      ]);
    }
    if (next.lower !== m.upper + 1) contiguous = false;
  }
  const first = at(members, 0);
  const last = at(members, members.length - 1);
  return contiguous && first.lower === REGISTRY_MIN.get(key) && last.upper === null;
}

/**
 * The families of a rule set (plan 08 §4.1): every mapped rule whose canonical is a family member
 * in the registry joins its (family, scalar) group; members are sorted by bounds; partition
 * families are checked (overlap → `bracket_bounds`); `exclusive` is true for `tier` families
 * only — FG buckets are counts (recorded), bonuses cumulative (A-2). Ordered by class, name, scalar.
 */
export function buildFamilies(rules: readonly ScoringRule[]): readonly BracketFamily[] {
  const groups = new Map<
    string,
    { name: BracketFamilyName; scalar: Canonical; cls: PositionClass; members: BracketMember[] }
  >();
  for (const r of rules) {
    const def = r.canonical === null ? undefined : canonicalDef(r.canonical);
    const f = def?.family ?? null;
    if (def === undefined || f === null) continue;
    const key = familyKey({ family: f.name, scalar: f.scalar });
    let g = groups.get(key);
    if (g === undefined) {
      g = { name: f.name, scalar: f.scalar, cls: at(def.classes, 0), members: [] };
      groups.set(key, g);
    }
    g.members.push(
      Object.freeze({
        canonical: def.canonical,
        platform_id: r.platform_id,
        lower: f.lower,
        upper: f.upper,
      }),
    );
  }
  const out: BracketFamily[] = [];
  for (const [key, g] of groups) {
    const members = g.members.sort(byBounds);
    const kind = FAMILY_KIND[g.name];
    const partition = kind === "tier" || kind === "count";
    out.push(
      Object.freeze({
        family: g.name,
        position_class: g.cls,
        scalar: g.scalar,
        members: Object.freeze(members),
        exclusive: kind === "tier",
        complete_range: partition ? partitionComplete(g.name, key, members) : true,
      }),
    );
  }
  return Object.freeze(
    out.sort(
      (a, b) =>
        POSITION_CLASSES.indexOf(a.position_class) - POSITION_CLASSES.indexOf(b.position_class) ||
        cmp(a.family, b.family) ||
        cmp(a.scalar, b.scalar),
    ),
  );
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const within = (m: BracketMember, x: number): boolean =>
  m.lower <= x && (m.upper === null || x <= m.upper);

/**
 * The member values a derived line gets from its scalar (plan 08 §4.1, P4), in member order:
 * `tier`/`count` — one-hot on the member whose inclusive bounds hold the scalar, all zero in a gap
 * or outside the members (one kick, one bucket); `threshold` — 1 for every member whose lower bound
 * the scalar reaches (cumulative, A-2); `per_n` — `max(0, ⌊scalar / N⌋)` (recorded on every per-N
 * id: −5 yards gives 0, never −1); `length` — all zero when the scalar (a TD count) is ≤ 0, else
 * null: a weekly total cannot say how long its TDs were (underivable, plan 08 §4.3). A non-finite
 * or absurd scalar throws `invalid_line`.
 */
export function bracketize(family: BracketFamily, scalar: number): readonly number[] | null {
  if (!finiteWithin(scalar, MAX_ABS_STAT)) {
    throw new ScoringError("invalid_line", "bracket scalar is not a finite in-range number", [
      familyKey(family),
    ]);
  }
  const members = family.members;
  switch (FAMILY_KIND[family.family]) {
    case "tier":
    case "count": {
      const hit = members.findIndex((m) => within(m, scalar));
      return members.map((_, i) => (i === hit ? 1 : 0));
    }
    case "threshold":
      return members.map((m) => (scalar >= m.lower ? 1 : 0));
    case "per_n":
      return members.map((m) => (scalar > 0 ? Math.floor(scalar / m.lower) : 0));
    case "length":
      return scalar > 0 ? null : members.map(() => 0);
  }
}
