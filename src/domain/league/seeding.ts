// seeding.ts — the seeding reading (plan 07 C12 and A1 `seeding`: `EFF_SEEDING_MODE ∈ { espn_rule,
// points_only }`, default `espn_rule`, `confirmed: false` until `eff setup --seeding` records the
// answer; ADV OBJ-13) and `onboard`'s one-time evidence — a finished season's `playoffSeed` order
// against the record order and the points-for order (research 05 §2.1: reading (a) = win % first
// with points for as the tiebreak, ESPN's `TOTAL_POINTS_SCORED`; reading (b) has no settings field
// and is detected only as seeds that follow points for but not the record). Division winners seed
// first when the league has more than one division (research 05 §2.4; the recorded 4-division
// league's seeds follow exactly that). HANDOFF D1: the owner's league is ESPN's rule. Pure.
import type { SeedingMode } from "../../config/schema.js";
import type { SeedingDigest, SeedingEvidence } from "./types.js";

/** The operator's seeding configuration (`Config.seedingMode`, `Config.seedingConfirmedAt`). */
export interface SeedingConfigInput {
  readonly seeding_mode: SeedingMode;
  /** When `eff setup --seeding` recorded the reading; null = unconfirmed. */
  readonly seeding_confirmed_at: string | null;
}

/**
 * A1's `seeding` section: the rule ESPN states, the configured reading, whether the operator has
 * confirmed it (a valid recorded instant), the reading in use — the configuration, or an explicit
 * per-call `override` (`both` never reaches here: it is an analytics argument) — and the evidence
 * when `onboard` asked for it.
 */
export function seedingDigest(
  rule: string,
  cfg: SeedingConfigInput,
  evidence: SeedingEvidence | null = null,
  override?: SeedingMode,
): SeedingDigest {
  const at = cfg.seeding_confirmed_at;
  return Object.freeze({
    rule,
    mode_configured: cfg.seeding_mode,
    confirmed: at !== null && Number.isFinite(Date.parse(at)),
    mode_in_use: override ?? cfg.seeding_mode,
    evidence,
  });
}

/** One team's final standing of a finished season (from that season's `mTeam`). */
export interface SeasonStandingInput {
  readonly team_id: number;
  /** ESPN `playoffSeed`; null when absent. */
  readonly seed: number | null;
  readonly division_id: number | null;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  readonly points_for: number;
}

/** Winning percentage with a tie as half a win; 0 with no games. */
export function winPct(t: Pick<SeasonStandingInput, "wins" | "losses" | "ties">): number {
  const n = t.wins + t.losses + t.ties;
  return n > 0 ? (t.wins + t.ties / 2) / n : 0;
}

type Cmp = (a: SeasonStandingInput, b: SeasonStandingInput) => number;

/** Points-for order (descending); equal points compare equal. */
const byPoints: Cmp = (a, b) => b.points_for - a.points_for;

/**
 * The record comparator of a seeding rule: division winners first (when the league has more than
 * one division), then win %, then — for `TOTAL_POINTS_SCORED` only — points for. For the other
 * rules the next tiebreak (head-to-head) is not computable from standings, so teams equal on win %
 * compare equal (consistent with either order). A division's winner is its best team by win %,
 * then points for.
 */
function recordComparator(teams: readonly SeasonStandingInput[], rule: string): Cmp {
  const divisions = new Set(teams.map((t) => t.division_id));
  const winners = new Set<number>();
  if (divisions.size > 1)
    for (const d of divisions) {
      const best = teams
        .filter((t) => t.division_id === d)
        .sort((a, b) => winPct(b) - winPct(a) || byPoints(a, b))[0];
      if (best !== undefined) winners.add(best.team_id);
    }
  const pointsBreakTies = rule === "TOTAL_POINTS_SCORED";
  return (a, b) =>
    (winners.has(b.team_id) ? 1 : 0) - (winners.has(a.team_id) ? 1 : 0) ||
    winPct(b) - winPct(a) ||
    (pointsBreakTies ? byPoints(a, b) : 0);
}

/** 1-based competition ranks under a comparator (equal teams share a rank: 1, 2, 2, 4). */
function ranks(teams: readonly SeasonStandingInput[], cmp: Cmp): Map<number, number> {
  const sorted = [...teams].sort((a, b) => cmp(a, b) || a.team_id - b.team_id);
  const out = new Map<number, number>();
  sorted.forEach((t, i) => {
    const prev = sorted[i - 1];
    out.set(
      t.team_id,
      prev !== undefined && cmp(prev, t) === 0 ? (out.get(prev.team_id) ?? i + 1) : i + 1,
    );
  });
  return out;
}

/**
 * Whether the seeded field is consistent with an order: within the field (seeds ascending) no team
 * outranks the one seeded ahead of it, and no team outside the field outranks one inside it.
 */
function seedsFollow(
  field: readonly SeasonStandingInput[],
  rest: readonly SeasonStandingInput[],
  cmp: Cmp,
): boolean {
  for (let i = 1; i < field.length; i++) {
    const a = field[i - 1];
    const b = field[i];
    if (a !== undefined && b !== undefined && cmp(a, b) > 0) return false;
  }
  return field.every((f) => rest.every((o) => cmp(f, o) <= 0));
}

/** Options for `seedingEvidence`. */
export interface SeedingEvidenceOptions {
  /** The playoff field size (`playoffTeamCount`); null → every seeded team is compared. */
  readonly team_count: number | null;
  /** That season's `playoffSeedingRule`. */
  readonly seeding_rule: string;
  /** That season's `status.isPlayoffMatchupEdited`. */
  readonly playoff_edited: boolean | null;
}

/**
 * Last season's seed-vs-record and seed-vs-points table (plan 07 A1 `seeding.evidence`; research 05
 * §2.1). The compared field is the teams seeded 1..`team_count` (the playoff bracket a commissioner
 * would edit). `suggests` is `points_only` when the seeds follow points for but not the record,
 * `espn_rule` when they follow the record but not points for, and `unknown` when both or neither
 * hold, or no team carries a seed (no previous season) — the operator decides, never this function.
 */
export function seedingEvidence(
  season: number,
  teams: readonly SeasonStandingInput[],
  opts: SeedingEvidenceOptions,
): SeedingEvidence {
  const valid = teams.filter(
    (t) =>
      Number.isInteger(t.team_id) &&
      [t.wins, t.losses, t.ties, t.points_for].every((n) => Number.isFinite(n) && n >= 0),
  );
  const record = recordComparator(valid, opts.seeding_rule);
  const recordRanks = ranks(valid, record);
  const pointsRanks = ranks(valid, byPoints);
  const seeded = valid
    .filter((t) => t.seed !== null && Number.isInteger(t.seed) && t.seed >= 1)
    .sort((a, b) => (a.seed ?? 0) - (b.seed ?? 0) || a.team_id - b.team_id);
  const n =
    opts.team_count !== null && opts.team_count >= 1
      ? Math.min(opts.team_count, seeded.length)
      : seeded.length;
  const field = seeded.slice(0, n);
  const rest = valid.filter((t) => !field.includes(t));
  const matchesPf = field.length > 0 && seedsFollow(field, rest, byPoints);
  const matchesRecord = field.length > 0 && seedsFollow(field, rest, record);
  const suggests: SeedingEvidence["suggests"] =
    matchesPf && !matchesRecord
      ? "points_only"
      : matchesRecord && !matchesPf
        ? "espn_rule"
        : "unknown";
  const table = [...valid]
    .sort(
      (a, b) =>
        (a.seed ?? Number.POSITIVE_INFINITY) - (b.seed ?? Number.POSITIVE_INFINITY) ||
        a.team_id - b.team_id,
    )
    .map((t) =>
      Object.freeze({
        team_id: t.team_id,
        seed: t.seed,
        record_rank: recordRanks.get(t.team_id) ?? null,
        pf_rank: pointsRanks.get(t.team_id) ?? null,
      }),
    );
  return Object.freeze({
    season,
    seed_order_matches_pf: matchesPf,
    seed_order_matches_record: matchesRecord,
    playoff_edited: opts.playoff_edited,
    suggests,
    table: Object.freeze(table),
  });
}

/**
 * The standings in seeding order under a reading: `espn_rule` — the record comparator of `rule`
 * (division winners, win %, points for under `TOTAL_POINTS_SCORED`); `points_only` — points for.
 * Remaining ties keep team-id order. The cold-start ordering the seeding simulator starts from.
 */
export function seedingOrder(
  teams: readonly SeasonStandingInput[],
  mode: SeedingMode,
  rule: string,
): number[] {
  const cmp = mode === "points_only" ? byPoints : recordComparator(teams, rule);
  return [...teams].sort((a, b) => cmp(a, b) || a.team_id - b.team_id).map((t) => t.team_id);
}
