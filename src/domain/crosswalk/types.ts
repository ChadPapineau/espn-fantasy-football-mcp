// types.ts — the player-crosswalk contract (plan 01 §5.2 `crosswalk` row: ESPN id → gsis_id,
// method, confidence, first/last seen; research 04 §C: the ESPN id is a lookup, not a matcher —
// nflverse `roster_weekly.espn_id` covers 497/500; plan 05 §2 `domain/crosswalk`: precedence
// nflverse espn_id → nflverse players → deterministic name+team+position → override, never
// name-only, ESPN WSH/LAR → WAS/LA; plan 06 §1.3 alert threshold 1; plan 07 C1 `crosswalk`).
// Ported from sibling @d72e03b, adapted (ESPN ids are the entry point; D/ST never matched).
import type { NflTeam } from "../../config/schema.js";
import type { BestEffortOutcome, DatasetResult } from "../analytics/types.js";
import type { CrosswalkMethod, IsoInstant, PlatformPlayer } from "../league/types.js";

export type { CrosswalkMethod, CrosswalkStatus } from "../league/types.js";

/** Every crosswalk method (plan 07 C1). */
export const CROSSWALK_METHODS: readonly CrosswalkMethod[] = Object.freeze([
  "id",
  "match",
  "override",
  "none",
]);

/**
 * ESPN team-unit positions: never matched, never paired — a D/ST's identity IS its pro team, so it
 * is never counted as unmatched (plan 06 §1.3 threshold).
 */
export const TEAM_UNIT_POSITIONS: readonly string[] = Object.freeze(["D/ST", "HC"]);

/**
 * ESPN pro-team abbreviation → nflverse abbreviation where they differ (research 04 §C; plan 05 §2
 * `domain/crosswalk`). Every other ESPN abbreviation is spelled the same in nflverse.
 */
export const ESPN_TO_NFLVERSE_TEAM: Readonly<Record<string, NflTeam>> = Object.freeze({
  WSH: "WAS",
  LAR: "LA",
});

/** ESPN position id → nflverse position for the deterministic matcher (plan 05 §2: ids 1–4). */
export const ESPN_POSITION_TO_NFLVERSE: Readonly<Record<number, string>> = Object.freeze({
  1: "QB",
  2: "RB",
  3: "WR",
  4: "TE",
  5: "K",
});

/** `last_seen` is rewritten only when older than this (7 days): no daily full rewrite. */
export const LAST_SEEN_GRANULARITY_MS = 7 * 24 * 60 * 60 * 1000;
/** Alert when this many rostered or ≥ 1 %-owned ESPN players lack a confidence-1.0 pair (plan 06). */
export const UNMATCHED_ALERT_THRESHOLD = 1;
/** "Top-owned" for the unmatched report (plan 06 §1.3): ≥ 1 % owned. */
export const TOP_OWNED_PERCENT = 1;

/** Where a pair's evidence came from. */
export type CrosswalkSource =
  "nflverse:roster_weekly" | "nflverse:players" | "matcher" | "overrides";

/** A persisted ESPN-player → gsis_id pair (survives team changes; never expires). */
export interface CrosswalkPair {
  readonly espn_id: number;
  readonly gsis_id: string;
  readonly method: Exclude<CrosswalkMethod, "none">;
  readonly source: CrosswalkSource;
  /** 1 for id/override; the matcher's score for `match`. */
  readonly confidence: number;
  readonly first_seen: IsoInstant;
  /** Not part of change detection; refreshed by `touch` at LAST_SEEN_GRANULARITY_MS grain. */
  readonly last_seen: IsoInstant;
}

/** One nflverse weekly-roster row the crosswalk reads (wire-free; research 04 §C columns). */
export interface NflRosterPlayer {
  readonly gsis_id: string;
  readonly season: number;
  readonly week: number;
  /** Raw full name (matching only; never emitted unsanitised). */
  readonly full_name: string;
  readonly team: NflTeam;
  readonly position: string;
  readonly jersey_number: number | null;
  /** nflverse's ESPN id — the lookup (research 04 §C). */
  readonly espn_id: number | null;
  readonly sleeper_id: string | null;
  readonly status: string | null;
}

/** An ESPN player identity from `ds_players` (players_wl) — the crosswalk's universe. */
export interface EspnPlayerIdentity {
  readonly espn_id: number;
  /** Raw full name (matching only). */
  readonly full_name: string;
  readonly position_id: number;
  readonly pro_team_id: number;
  readonly pro_team: string | null;
  readonly percent_owned: number | null;
  readonly jersey: string | null;
}

/** A checked-in override row (repo-authored; research 04 §C step 3). */
export interface CrosswalkOverride {
  readonly espn_id: number;
  readonly gsis_id: string;
  readonly note: string | null;
}

/** Why a candidate matched. Name alone is never enough to accept. */
export type MatchEvidence = "id" | "name" | "team" | "position" | "jersey";

/** A matcher candidate for one ESPN player. */
export interface MatchCandidate {
  readonly gsis_id: string;
  readonly team: string;
  readonly position: string;
  readonly jersey_number: number | null;
  readonly evidence: readonly MatchEvidence[];
  readonly score: number;
}

/** The matcher's decision for one ESPN player. */
export type MatchDecision =
  | { readonly status: "matched"; readonly pair: CrosswalkPair }
  | { readonly status: "ambiguous"; readonly candidates: readonly MatchCandidate[] }
  | {
      readonly status: "unmatched";
      readonly reason: "no_candidate" | "name_only" | "unknown_team" | "team_unit";
    };

/** One unmatched player in the report. */
export interface UnmatchedPlayer {
  readonly player: PlatformPlayer;
  readonly reason: "no_candidate" | "name_only" | "unknown_team" | "ambiguous";
  readonly candidates: readonly MatchCandidate[];
}

/** The unmatched report (plan 07 G1 `crosswalk`). */
export interface UnmatchedReport {
  readonly matched: number;
  readonly unmatched_rostered: readonly UnmatchedPlayer[];
  readonly unmatched_top_owned: readonly UnmatchedPlayer[];
}

/** The crosswalk repository port (store; required writes). */
export interface CrosswalkRepository {
  get(espnId: number): CrosswalkPair | null;
  byGsis(gsisId: string): readonly CrosswalkPair[];
  /** Writes only new or changed pairs (delta; "changed" never compares `last_seen`). Returns rows written. */
  upsertDelta(pairs: readonly CrosswalkPair[]): number;
  /** Best-effort: sets `last_seen` only on pairs older than the granularity. */
  touch(espnIds: readonly number[], at: IsoInstant): BestEffortOutcome;
  count(): number;
}

/** The nflverse roster port the crosswalk reads (over the `nflverse:roster_weekly` dataset file). */
export interface RosterWeeklyReader {
  /** The latest row per gsis id for a season. */
  latest(season: number): DatasetResult<NflRosterPlayer>;
  byEspnId(espnId: number): DatasetResult<NflRosterPlayer>;
}

/** The ESPN player-universe port (over the `espn:players` dataset file — C1's local name index). */
export interface PlayerUniverseReader {
  all(season: number): DatasetResult<EspnPlayerIdentity>;
  byIds(espnIds: readonly number[]): DatasetResult<EspnPlayerIdentity>;
}
