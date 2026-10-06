// verification.ts — which bracket families reproduce ESPN on recorded evidence (plan 08 §6 step 6:
// "flagged `verified: false` per family in `espn_get_league.scoring` until then"; plan 10 B13 and
// open decision D8; plan 07 A1 `scoring.families`). A family, as a league's S uses it, is verified
// iff (1) its DERIVATION — how a derived line's member values come from the scalar (bracketize, the
// pbp long-TD counts) — is reproduced on ESPN's own raw values, and (2) every member S scores is
// GOLDEN-COVERED: a recorded league scores that id for the member's class and the recorded golden
// (tests/golden/espn-recorded.test.ts) compared a non-zero ESPN `appliedStats` value for it. Both
// constants are
// server-authored and re-derived from fixtures/espn/recorded by
// tests/golden/engine-families.test.ts, so they cannot drift from the recordings. Owner decision D8 (no extra fixture league): the members
// no recorded league scores — stat 74 (`fg_50p` legacy), every FG-attempt bucket, the per-N divisors
// other than 25 passing / 10 rushing / 10 receiving yards, 121 and the HC margins — stay unverified,
// and so does a scored member no recorded game ever triggered (128, yards allowed < 100). Pure.
import { ESPN_POSITION_CLASS } from "./stat_map.js";
import type {
  BracketFamilyName,
  Canonical,
  PositionClass,
  ScoringRule,
  ScoringSettings,
} from "./types.js";

/** What the recordings show about one family's derivation (plan 08 §4). */
export interface FamilyEvidence {
  /** Whether a derived line's member values are reproduced on ESPN's raw values. */
  readonly derivation: "verified" | "unverified";
  /**
   * Members whose derived-line semantics stay open although the family's are evidenced (plan 08
   * A-2: whether a 300–399 indicator also pays above 399 — no recorded 400-yard game).
   */
  readonly derivation_open_stat_ids: readonly string[];
  /** Server-authored summary of the evidence (registry text, never third-party). */
  readonly basis: string;
}

const ev = (
  derivation: FamilyEvidence["derivation"],
  basis: string,
  open: readonly string[] = [],
): FamilyEvidence =>
  Object.freeze({ derivation, derivation_open_stat_ids: Object.freeze([...open]), basis });

/** Per family (plan 08 §2 `BracketFamily`): the recorded evidence for its derivation. */
export const FAMILY_EVIDENCE: Readonly<Record<BracketFamilyName, FamilyEvidence>> = Object.freeze({
  fg_distance: ev(
    "verified",
    "made buckets 80/77/198/201 golden on two leagues; raw 74 = 198 + 201 on every recorded K week; nflverse kick lists agree (E8)",
  ),
  fg_attempt: ev(
    "verified",
    "raw attempt buckets = made + missed on every recorded K week; no recorded league scores an attempt bucket",
  ),
  fg_miss: ev(
    "verified",
    "missed buckets 82/79 golden on two leagues; raw 76 = 200 + 203; blocked kicks count as misses (E8)",
  ),
  dst_points_allowed: ev(
    "verified",
    "tier indicators = bracketize(stat 120) on all 70 recorded D/ST weeks; points allowed net of defensive return TDs and safeties, 70/70 (U-6 pinned)",
  ),
  dst_yards_allowed: ev(
    "verified",
    "tier indicators = bracketize(stat 127) on all 70 recorded D/ST weeks; yards allowed = passing + rushing − sack yards, 70/70",
  ),
  yardage_bonus: ev(
    "verified",
    "indicators fire at the lower bound on every recorded line; no recorded 400-yard passing or 200-yard rushing/receiving game, so whether 17/37/56 also pay above their upper bound is open (A-2)",
    ["17", "37", "56"],
  ),
  long_td_bonus: ev(
    "verified",
    "cumulative on every recorded line (a 50+ yard TD sets the 40+ id too); ds_pbp TD lengths reproduce 15/16/35/36/45/46 on 530/530 recorded player-weeks",
  ),
  per_n_yards: ev(
    "verified",
    "max(0, floor(scalar / N)) on every recorded per-N value, actual and projected (15,434; a negative scalar omits the id)",
  ),
  margin: ev(
    "unverified",
    "no head-coach line is recorded and no line carries a margin stat (161–172)",
  ),
});

/**
 * ESPN stat ids of bracket-family members that are GOLDEN-COVERED: a recorded league scores the id
 * with non-zero points for its class, and its recorded box scores carry a NON-ZERO ESPN
 * `appliedStats` value for it on at least one line of that class (actual or projected) — which the
 * golden compares per stat (≤ 0.005); a member only ever compared at 0 is not covered (an engine
 * that dropped the rule would pass). Numerically sorted. Re-derived by
 * tests/golden/engine-families.test.ts.
 */
export const GOLDEN_COVERED_STAT_IDS: readonly string[] = Object.freeze([
  "8",
  "15",
  "16",
  "17",
  "18",
  "28",
  "35",
  "36",
  "37",
  "38",
  "45",
  "46",
  "48",
  "56",
  "57",
  "77",
  "79",
  "80",
  "82",
  "89",
  "90",
  "91",
  "92",
  "122",
  "123",
  "124",
  "125",
  "129",
  "130",
  "133",
  "134",
  "135",
  "136",
  "198",
  "201",
]);
const GOLDEN: ReadonlySet<string> = new Set(GOLDEN_COVERED_STAT_IDS);

/** The ESPN position ids of one class (ESPN_POSITION_CLASS), as override keys. */
function positionsOf(cls: PositionClass): readonly string[] {
  return Object.entries(ESPN_POSITION_CLASS)
    .filter(([, c]) => c === cls)
    .map(([p]) => p);
}

/**
 * Whether a rule pays anything to a line of class `cls`: some position of the class has a non-zero
 * override, or the base points are non-zero for a position of the class without an override.
 */
export function scoresForClass(rule: ScoringRule, cls: PositionClass): boolean {
  return positionsOf(cls).some((p) => (rule.overrides[p] ?? rule.points) !== 0);
}

/** One family of a league's settings with its verification state (plan 07 A1 `families[]`). */
export interface FamilyVerification {
  readonly family: BracketFamilyName;
  readonly scalar: Canonical;
  readonly position_class: PositionClass;
  /** The derivation is evidenced and every member S scores is golden-covered with a settled meaning. */
  readonly verified: boolean;
  /** Members S scores (non-zero for the class) that are not golden-covered or whose meaning is open. */
  readonly unverified_stat_ids: readonly string[];
}

/**
 * The verification state of every family in `settings`, in `settings.families` order (plan 08 §6
 * step 6): `verified` iff FAMILY_EVIDENCE says the derivation is evidenced and no member S scores is
 * missing from GOLDEN_COVERED_STAT_IDS or open in `derivation_open_stat_ids`; a member S carries at
 * zero points for its class is ignored (it cannot mis-score). Never throws on normalised settings.
 */
export function familyVerification(settings: ScoringSettings): readonly FamilyVerification[] {
  const rules = new Map(settings.rules.map((r) => [r.platform_id, r]));
  return Object.freeze(
    settings.families.map((f) => {
      const evidence = FAMILY_EVIDENCE[f.family];
      const unverified = f.members
        .filter((m) => {
          const rule = rules.get(m.platform_id);
          return rule !== undefined && scoresForClass(rule, f.position_class);
        })
        .map((m) => m.platform_id)
        .filter((id) => !GOLDEN.has(id) || evidence.derivation_open_stat_ids.includes(id));
      return Object.freeze({
        family: f.family,
        scalar: f.scalar,
        position_class: f.position_class,
        verified: evidence.derivation === "verified" && unverified.length === 0,
        unverified_stat_ids: Object.freeze(unverified),
      });
    }),
  );
}
