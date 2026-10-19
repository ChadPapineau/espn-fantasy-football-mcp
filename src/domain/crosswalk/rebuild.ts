// rebuild.ts — the `crosswalk rebuild` use case over the crosswalk ports (plan 06 §1.3 row: inputs
// ds_roster_weekly, ds_players, the overrides file, persisted pairs → crosswalk rows + unmatched report;
// research 04 §C steps 1–2: nflverse players only for ESPN ids roster_weekly lacks; plan 01 §5.5 delta).
// The rows end as the run decided: new or changed pairs written, the pairs it rejects removed (Stage C
// finding crosswalk-rejected-pair-persists — the tool-time path reads the stored row, plan 07 C1).
import type { BestEffortOutcome, DatasetStamp } from "../analytics/types.js";
import type { IsoInstant } from "../league/types.js";
import {
  buildNflPlayersIndex,
  buildRosterIndex,
  identityOf,
  isTeamUnitIdentity,
  resolveCrosswalk,
  type CrosswalkRun,
} from "./resolver.js";
import { isPersonId } from "./ids.js";
import type {
  CrosswalkOverride,
  CrosswalkPair,
  CrosswalkRepository,
  EspnPlayerIdentity,
  NflPlayersReader,
  PlayerUniverseReader,
  RosterWeeklyReader,
} from "./types.js";

/** What a rebuild reads and writes (all injected; the domain does no I/O). */
export interface CrosswalkRebuildDeps {
  readonly season: number;
  readonly roster: RosterWeeklyReader;
  readonly universe: PlayerUniverseReader;
  /** Null when the nflverse players dataset is not configured (the fallback is then skipped). */
  readonly nflPlayers: NflPlayersReader | null;
  readonly repository: CrosswalkRepository;
  readonly overrides: readonly CrosswalkOverride[];
  /** The Clock instant. */
  readonly now: IsoInstant;
  /** ESPN ids on any fantasy roster of the league (roster snapshots). Default: none. */
  readonly rostered?: ReadonlySet<number>;
}

/** Why a rebuild did not run: resolving against a dataset that was never loaded would alert falsely. */
export type CrosswalkRebuildSkip = "roster_weekly_never_loaded" | "players_universe_never_loaded";

/** The outcome of one rebuild. */
export type CrosswalkRebuildResult =
  | {
      readonly status: "skipped";
      readonly reason: CrosswalkRebuildSkip;
      readonly stamps: CrosswalkRebuildStamps;
    }
  | {
      readonly status: "done";
      readonly run: CrosswalkRun<EspnPlayerIdentity>;
      /** Rows `upsertDelta` wrote. */
      readonly written: number;
      /**
       * Rows `removeRejected` removed (the run's `rejected` pairs still stored as read); null when the
       * run rejected pairs and the repository cannot remove them — they stay stored.
       */
      readonly removed: number | null;
      /** The best-effort `last_seen` refresh of unchanged pairs (null when there were none). */
      readonly touched: BestEffortOutcome | null;
      readonly stamps: CrosswalkRebuildStamps;
    };

/** The dataset stamps the rebuild read (for refresh_log / status). */
export interface CrosswalkRebuildStamps {
  readonly roster_weekly: DatasetStamp | null;
  readonly players_universe: DatasetStamp | null;
  /** Null when the fallback was not asked (no missing id, or no reader). */
  readonly nfl_players: DatasetStamp | null;
}

/** Removes the run's rejected pairs (none: no call); null when the repository cannot remove. */
function removeRejected(
  repository: CrosswalkRepository,
  rejected: readonly CrosswalkPair[],
): number | null {
  if (rejected.length === 0) return 0;
  return repository.removeRejected === undefined ? null : repository.removeRejected(rejected);
}

/**
 * Rebuilds the crosswalk for a season: reads roster_weekly and the ESPN universe, asks nflverse
 * players only for the person ids roster_weekly does not pair, resolves (resolveCrosswalk), writes the
 * new or changed pairs, removes the stored pairs the run rejects (after the writes, so a failed
 * removal never holds back a new pair; both are required writes) and refreshes `last_seen` on the
 * unchanged ones. Skips — writing nothing — when roster_weekly or the universe was never loaded. The
 * caller notifies when `run.alert.triggered`.
 */
export function rebuildCrosswalk(deps: CrosswalkRebuildDeps): CrosswalkRebuildResult {
  const roster = deps.roster.latest(deps.season);
  const universe = deps.universe.all(deps.season);
  const base = { roster_weekly: roster.stamp, players_universe: universe.stamp, nfl_players: null };
  if (roster.stamp === null) {
    return { status: "skipped", reason: "roster_weekly_never_loaded", stamps: base };
  }
  if (universe.stamp === null) {
    return { status: "skipped", reason: "players_universe_never_loaded", stamps: base };
  }
  const index = buildRosterIndex(roster.rows);
  const missing = [
    ...new Set(
      universe.rows
        .filter((p) => !isTeamUnitIdentity(p) && isPersonId(p.espn_id))
        .filter((p) => index.byEspnId(p.espn_id).length === 0)
        .map((p) => p.espn_id),
    ),
  ].sort((a, b) => a - b);
  const fallback =
    deps.nflPlayers === null || missing.length === 0 ? null : deps.nflPlayers.byEspnIds(missing);
  const run = resolveCrosswalk({
    players: universe.rows,
    identify: identityOf,
    roster: index,
    nflPlayers: buildNflPlayersIndex(fallback?.rows ?? []),
    overrides: deps.overrides,
    persisted: deps.repository,
    now: deps.now,
    ...(deps.rostered === undefined ? {} : { rostered: deps.rostered }),
  });
  const written = run.changed.length > 0 ? deps.repository.upsertDelta(run.changed) : 0;
  const removed = removeRejected(deps.repository, run.rejected);
  const touched =
    run.unchanged_ids.length > 0 ? deps.repository.touch(run.unchanged_ids, deps.now) : null;
  return {
    status: "done",
    run,
    written,
    removed,
    touched,
    stamps: { ...base, nfl_players: fallback?.stamp ?? null },
  };
}
