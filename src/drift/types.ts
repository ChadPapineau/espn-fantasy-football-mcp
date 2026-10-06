// types.ts — the drift detector's contract (plan 01 §7; research 03 §F.2; plan 05 §3.3 T4): the
// manifest (per view: top-level keys, per-entity keys, enum values, array lengths, the host —
// generated after anonymisation from the committed fixtures), the seed of required keys per view
// (the keys a view must ADD over the P28 skeleton — skeleton detection), the in-call signals, the
// probe report and diff, the status, and the exit code (plan 03 §1.3: 4 = drift). It never
// auto-adapts: a human reads the diff and regenerates the manifest.
import { EXIT_CODES, type DriftStatus } from "../config/schema.js";
import type { IsoInstant } from "../domain/league/types.js";
import type { EspnView } from "../providers/espn/types.js";

export { DRIFT_STATUSES, type DriftStatus } from "../config/schema.js";
export type {
  DriftStateRepository,
  DriftStateRow,
  ProbeLogRepository,
  ProbeLogRow,
} from "../store/types.js";

/** `eff probe` / `eff doctor` exit code when drift is red or the host moved (plan 03 §1.3). */
export const DRIFT_EXIT_CODE = EXIT_CODES.drift;

/** The manifest file, relative to the repo (plan 01 §7). */
export const MANIFEST_PATH = "fixtures/espn/manifest.json";
/** The manifest format version (plan 03 §7: a newer manifest re-baselines on its first probe). */
export const MANIFEST_FORMAT_VERSION = 1;

/**
 * The keys of ESPN's skeleton response for ANY view, incl. unknown ones (research 03 §A.2 P28):
 * a required key that is in this set can never detect a renamed view.
 */
export const SKELETON_TOP_LEVEL_KEYS: readonly string[] = Object.freeze([
  "draftDetail",
  "gameId",
  "id",
  "members",
  "scoringPeriodId",
  "seasonId",
  "segmentId",
  "settings",
  "status",
  "teams",
]);
/** Skeleton paths that are present even for a bogus view (slim `teams[]`, `members[]`, `settings{name}`). */
export const SKELETON_PATHS: readonly string[] = Object.freeze([
  "draftDetail.drafted",
  "draftDetail.inProgress",
  "settings.name",
  "teams[].id",
  "teams[].abbrev",
  "teams[].name",
  "members[].id",
]);

/**
 * The seed of required paths per view: the keys each view ADDS over the skeleton (research 03
 * §A.2). A response missing any of these is drift (`ESPN_DRIFT_DETECTED`), because ESPN answers an
 * unknown or renamed view with 200 and a skeleton. Paths: `a.b` objects, `[]` arrays, `<root>[]`
 * for a root array. The views/*.schema.ts required sets must contain these and stay a subset of the
 * manifest's observed keys (plan 05 §3.3).
 */
export const REQUIRED_PATHS_BY_VIEW: Readonly<Record<EspnView, readonly string[]>> = Object.freeze({
  mSettings: [
    "settings.scoringSettings",
    "settings.rosterSettings",
    "settings.acquisitionSettings",
    "settings.scheduleSettings",
  ],
  mNav: ["teams[].owners", "members[].isLeagueManager"],
  mTeam: ["teams[].record", "teams[].transactionCounter", "teams[].waiverRank"],
  mStandings: ["teams[].record"],
  mRoster: ["teams[].roster.entries"],
  mMatchup: ["schedule[].matchupPeriodId"],
  mMatchupScore: ["schedule[].playoffTierType"],
  mBoxscore: ["schedule[].home.rosterForCurrentScoringPeriod"],
  mScoreboard: ["schedule[].home.totalPoints"],
  mDraftDetail: ["draftDetail.picks"],
  mTransactions2: ["transactions"],
  mPendingTransactions: ["pendingTransactions"],
  mPositionalRatings: ["positionAgainstOpponent.positionalRatings"],
  kona_player_info: ["players"],
  kona_playercard: ["players"],
  kona_league_communication: ["topics"],
  proTeamSchedules_wl: ["settings.proTeams"],
  players_wl: ["<root>[]"],
});

/** Per-view observations in the manifest (plan 01 §7). */
export interface ViewManifest {
  readonly top_level_keys: readonly string[];
  /** Entity name (`team`, `rosterEntry`, `player`, `stats`, `scheduleItem`, `settings.*`, `status`) → keys. */
  readonly entity_keys: Readonly<Record<string, readonly string[]>>;
  /** JSON path → observed enum values. */
  readonly enums: Readonly<Record<string, readonly string[]>>;
  /** JSON path → observed array length range. */
  readonly array_lengths: Readonly<Record<string, { readonly min: number; readonly max: number }>>;
}

/** The manifest (generated from the committed, anonymised fixtures — research 03 §F.3 step 4). */
export interface DriftManifest {
  readonly format_version: number;
  /** A fixed instant recorded at capture (never the header — research 03 §F.3 step 2). */
  readonly captured_at: IsoInstant;
  readonly host: string;
  readonly views: Readonly<Partial<Record<EspnView, ViewManifest>>>;
}

/** The kinds of in-call signal (plan 01 §7 table). */
export type DriftSignalKind =
  | "missing_required_key"
  | "skeleton"
  | "unknown_enum_value"
  | "meaning_changing_enum"
  | "additive_key"
  | "host_moved";

/** One in-call signal. Paths and enum values are ESPN vocabulary, never free text. */
export interface DriftSignal {
  readonly kind: DriftSignalKind;
  readonly view: EspnView;
  /** The JSON path the signal names (never a value). */
  readonly path: string;
  /** For enum signals: the new value (an ESPN enum token, length-capped by the detector). */
  readonly value: string | null;
}

/** What the provider does with a signal (plan 01 §7). */
export const SIGNAL_SEVERITY: Readonly<Record<DriftSignalKind, "error" | "warning" | "count">> =
  Object.freeze({
    missing_required_key: "error",
    skeleton: "error",
    meaning_changing_enum: "error",
    host_moved: "error",
    unknown_enum_value: "warning",
    additive_key: "count",
  });

/** One view's diff against the manifest (plan 07 G1 `drift.diff[]`). */
export interface ViewDiff {
  readonly view: EspnView;
  readonly removed: readonly string[];
  readonly added: readonly string[];
  /** `path=value` tokens for enum values added or removed. */
  readonly enums: readonly string[];
}

/** The probe's report (plan 01 §7 "The daily probe"). */
export interface DriftReport {
  readonly status: DriftStatus;
  readonly checked_at: IsoInstant;
  readonly host: string;
  readonly host_moved: boolean;
  readonly manifest_hash: string;
  readonly diffs: readonly ViewDiff[];
  /** Additive drift: new keys counted, the manifest updated by a human. */
  readonly additive: readonly ViewDiff[];
  /** True when the shape probe carried cookies (the merged credential check — plan 06 §1.2). */
  readonly cookie_bearing: boolean;
}

/** The status a report implies: host move > removed key or changed enum set > additive > green. */
export function reportStatus(
  r: Pick<DriftReport, "host_moved" | "diffs" | "additive">,
): DriftStatus {
  if (r.host_moved) return "host_moved";
  if (r.diffs.some((d) => d.removed.length > 0 || d.enums.length > 0)) return "red";
  if (r.additive.some((d) => d.added.length > 0) || r.diffs.some((d) => d.added.length > 0))
    return "additive";
  return "green";
}

/** The probe's exit code: 4 for red or host_moved, else 0 (plan 03 §1.3; plan 06 §1.2). */
export function probeExitCode(status: DriftStatus): number {
  return status === "red" || status === "host_moved" ? DRIFT_EXIT_CODE : EXIT_CODES.ok;
}
