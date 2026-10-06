// helpers.ts — shared builders for the reclog tests: seeded normal draws, a valid E12 input over the
// shared fixture roster (fixtures/players/fixture-roster.json ESPN ids and gsis ids — public player
// ids only; no names), record factories. Ported from sibling @cf3b015, adapted (ESPN integer ids).
import type { Rec, RecSubject } from "../../../src/domain/analytics/types.js";
import { seededRng, type Rng } from "../../../src/domain/clock.js";
import type { Dist } from "../../../src/domain/scoring/types.js";
import type {
  Alternative,
  RecommendationRecord,
  RecordRecommendationInput,
} from "../../../src/domain/reclog/types.js";

/** Standard-normal quantiles at the Dist levels 0.1 / 0.25 / 0.5 / 0.75 / 0.9. */
export const Z = Object.freeze({
  p10: -1.2815515655446004,
  p25: -0.6744897501960817,
  p75: 0.6744897501960817,
  p90: 1.2815515655446004,
});

/** A standard normal draw (Box–Muller) from a seeded Rng. */
export function normal(rng: Rng): number {
  let u = rng.next();
  while (u <= 0) u = rng.next();
  const v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** `n` seeded N(mu, sigma) draws. */
export function normals(seed: number, n: number, mu = 0, sigma = 1): number[] {
  const rng = seededRng(seed);
  return Array.from({ length: n }, () => mu + sigma * normal(rng));
}

/** The Dist of N(mu, sigma) at the five levels. */
export function normalDist(mu: number, sigma: number): Dist {
  return {
    mean: mu,
    p10: mu + sigma * Z.p10,
    p25: mu + sigma * Z.p25,
    p50: mu,
    p75: mu + sigma * Z.p75,
    p90: mu + sigma * Z.p90,
    p_zero: 0,
    basis: "position_cv",
  };
}

/** A degenerate Dist at `c`. */
export function pointDist(c: number): Dist {
  return {
    mean: c,
    p10: c,
    p25: c,
    p50: c,
    p75: c,
    p90: c,
    p_zero: c === 0 ? 1 : 0,
    basis: "player_sim",
  };
}

/** Fixture-roster players (ESPN id, gsis id): two QBs, two RBs, a WR, two D/ST units. */
export const QB1 = { id: 3918298, gsis: "00-0034857" } as const;
export const QB2 = { id: 4036378, gsis: "00-0036264" } as const;
export const RB1 = { id: 4430807, gsis: "00-0038542" } as const;
export const RB2 = { id: 4239996, gsis: "00-0036973" } as const;
export const WR1 = { id: 4374302, gsis: "00-0036963" } as const;
export const DST1 = { id: -16021, gsis: null } as const;
export const DST2 = { id: -16008, gsis: null } as const;
export interface Who {
  readonly id: number;
  readonly gsis: string | null;
}

/** A subject for a fixture player. */
export function subj(who: Who, role: RecSubject["role"], slot: string | null = null): RecSubject {
  return { player_id: who.id, gsis_id: who.gsis, role, slot };
}

/** A valid Rec: start RB1 over RB2 at FLEX. */
export function rec(over: Partial<Rec> = {}): Rec {
  return {
    action: "Start RB1 over RB2 at FLEX",
    subjects: [subj(RB1, "start", "FLEX"), subj(RB2, "sit", "BE")],
    lineup: null,
    point_estimate: 14.2,
    distribution: normalDist(14.2, 6),
    delta_vs_next: { value: 1.8, p10: -4, p90: 7.5 },
    decision_metric: "expected_points",
    drivers: [{ name: "opportunity", contribution: 1.2 }],
    assumptions: [{ text: "assumes RB1 active", revisit_trigger: "Friday injury report" }],
    confidence: {
      role_games: 3,
      inputs: [
        {
          source: "espn:mRoster",
          as_of: "2026-09-30T09:05:48Z",
          age_s: 3600,
          freshness: "fresh",
        },
      ],
    },
    as_of: "2026-09-30T09:05:48Z",
    latest_execution_time: "2026-10-04T17:00:00Z",
    no_move: false,
    log_id: null,
    ...over,
  };
}

/** A valid alternative: start RB2 over RB1. */
export function alt(over: Partial<Alternative> = {}): Alternative {
  return {
    action: "Start RB2 over RB1 at FLEX",
    subjects: [subj(RB2, "start", "FLEX"), subj(RB1, "sit", "BE")],
    point_estimate: 12.4,
    distribution: normalDist(12.4, 6),
    decision_metric_value: 12.4,
    ...over,
  };
}

/** A valid settings hash (64 lowercase hex). */
export const HASH = "0123456789abcdef".repeat(4);

/** A valid E12 input (placeholder league 0, season 2026, week 4). */
export function input(over: Partial<RecordRecommendationInput> = {}): RecordRecommendationInput {
  return {
    league_id: "0",
    season: 2026,
    kind: "lineup",
    week: 4,
    rec: rec(),
    alternatives: [alt()],
    source_calls: [{ tool: "espn_analyze_lineup", request_id: "r-0123456789ab" }],
    settings_hash: HASH,
    seeding_mode_used: "espn_rule",
    followed_hint: "unknown",
    client_ref: null,
    note: null,
    ...over,
  };
}

let seq = 0;
/** A stored record (log id, recorded_at) around an input. */
export function record(over: Partial<RecommendationRecord> = {}): RecommendationRecord {
  seq++;
  const suffix = String(seq).padStart(4, "0");
  return {
    ...input(),
    log_id: `rec-01K6D${"0".repeat(17)}${suffix}`,
    recorded_at: "2026-10-01T12:00:00.000Z",
    ...over,
  };
}
