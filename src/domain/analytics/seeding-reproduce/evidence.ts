// evidence.ts — A1's `seeding.evidence` from the previous season's exact reproduction (Stage C, the
// phase3-summary "Open" item: plan 07 A1 / C12, ADV OBJ-13 — `onboard`'s one-time evidence; plan 10
// §3.3 C4's chain): the seeds ESPN gave last season compared, team by team, with the simulator's own
// tiebreak chain under each reading (`reproduceSeason`: division winners, win % → PF → H2H → division
// record → PA under reading (a); PF under reading (b)) instead of the standings-only orders
// (`seedingEvidence` in src/domain/league/seeding.ts — the fallback when last season's schedule or
// settings cannot be read). A reading "matches" when it reproduces every seed exactly, or when only a
// coin flip separates teams it otherwise orders as ESPN did; `suggests` names the one reading that
// matches, else `unknown` — the operator decides, never this function. `record_rank` is the team's
// place in reading (a)'s full chain, `pf_rank` its place by points for (reading (b)). Every value is an
// id, a number or a fixed code — never third-party text. Pure. New here.
import type { SeedingEvidence } from "../../league/types.js";
import type { ReadingReproduction, ReproductionFindingCode, SeasonReproduction } from "./types.js";

/** Whether ESPN's seeds follow a reading's chain (exactly, or but for a coin flip). */
export function readingMatches(r: ReadingReproduction): boolean {
  return r.exact || (r.coin_flip_decides && r.consistent_up_to_coin);
}

/** The season-level finding codes of a reproduction, unique, in their order of appearance. */
export function findingCodes(s: SeasonReproduction): ReproductionFindingCode[] {
  return [...new Set(s.findings.map((f) => f.code))];
}

/**
 * A1's evidence from a reproduction. `playoff_edited` is the season's own flag (the provider's
 * `playoff_matchup_edited`; null = unknown).
 */
export function seedingEvidenceFromReproduction(
  s: SeasonReproduction,
  playoffEdited: boolean | null,
  seeds: ReadonlyMap<number, number | null>,
): SeedingEvidence {
  const matchesRecord = readingMatches(s.espn_rule);
  const matchesPf = readingMatches(s.points_only);
  const suggests: SeedingEvidence["suggests"] =
    matchesRecord && !matchesPf
      ? "espn_rule"
      : matchesPf && !matchesRecord
        ? "points_only"
        : "unknown";
  const placeIn = (order: readonly number[]): Map<number, number> =>
    new Map(order.map((id, i) => [id, i + 1]));
  const recordRank = placeIn(s.espn_rule.order);
  const pfRank = placeIn(s.points_only.order);
  const ids = [...seeds.keys()];
  const table = ids
    .sort(
      (a, b) =>
        (seeds.get(a) ?? Number.POSITIVE_INFINITY) - (seeds.get(b) ?? Number.POSITIVE_INFINITY) ||
        a - b,
    )
    .map((team_id) =>
      Object.freeze({
        team_id,
        seed: seeds.get(team_id) ?? null,
        record_rank: recordRank.get(team_id) ?? null,
        pf_rank: pfRank.get(team_id) ?? null,
      }),
    );
  return Object.freeze({
    season: s.season,
    seed_order_matches_pf: matchesPf,
    seed_order_matches_record: matchesRecord,
    playoff_edited: playoffEdited,
    suggests,
    table: Object.freeze(table),
    method: "reproduction",
    findings: Object.freeze(findingCodes(s)),
  });
}
