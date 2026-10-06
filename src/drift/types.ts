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

/**
 * The ONE drift manifest, relative to the repo (plan 01 §7, plan 05 §3.1 step 4 — content as they
 * specify; the FILE is the probe's, decision recorded): the daily probe's required/observed key
 * sets (`probes`) and the per-view observations of every recorded view (`views`: entity key sets,
 * enum values, array-length ranges, the host), regenerated together by
 * `scripts/probe.ts --rebaseline` over the committed anonymised fixtures. scripts/probe.ts and
 * src/drift read this same file. `fixtures/espn/manifest.json` is the recording/hash manifest only.
 */
export const MANIFEST_PATH = "fixtures/drift/manifest.json";
/** The manifest format version (`version`; plan 03 §7: a newer manifest re-baselines on its first probe). */
export const MANIFEST_FORMAT_VERSION = 1;
/**
 * How G1 `drift.manifest_hash` and the probe line's `manifest_sha256` are computed: sha256
 * (lowercase hex) of the manifest's canonical JSON (keys sorted, no whitespace) — the same value
 * in every process (scripts/espn-fixture/canonical.ts `contentSha256`).
 */
export const MANIFEST_HASH_ALGORITHM = "sha256-canonical-json" as const;

/**
 * The top-level keys of ESPN's skeleton response for ANY view, incl. unknown ones (research 03
 * §A.2 P28; the recorded `fixtures/espn/recorded/league-a/skeleton.json` has every key but
 * `draftDetail`): a required key in this set can never detect a renamed view.
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
/**
 * Paths present even for a bogus view — exactly what the recorded skeleton carries (slim `teams[]`
 * with owners, `members[]` with names and the manager flag, `settings.name`, three `status`
 * keys). tests/drift/types.test.ts evaluates every REQUIRED path against the recorded skeleton
 * (absent there) and against a recorded fixture of the view (present there).
 */
export const SKELETON_PATHS: readonly string[] = Object.freeze([
  "$.settings.name",
  "$.status.currentMatchupPeriod",
  "$.status.isActive",
  "$.status.latestScoringPeriod",
  "$.teams[].id",
  "$.teams[].abbrev",
  "$.teams[].owners",
  "$.members[].id",
  "$.members[].displayName",
  "$.members[].isLeagueManager",
]);

/**
 * The seed of required paths per view: the keys each view ADDS over the skeleton (research 03
 * §A.2). A response missing any of these is drift (`ESPN_DRIFT_DETECTED`), because ESPN answers an
 * unknown or renamed view with 200 and a skeleton. Notation = the probe manifest's pattern
 * language: `$` the root, `.key` a property, `[]` every array element; a path is present when its
 * parent pattern selects ≥ 1 node and every selected node has the last key (`$[]`: the root is a
 * non-empty array). The views/*.schema.ts required sets must contain these and stay a subset of
 * the manifest's observed keys (plan 05 §3.3). `mNav` adds only `members[].isLeagueCreator`: its
 * other keys are in the skeleton (`isLeagueManager`, `owners`) or come from `mTeam` too.
 */
export const REQUIRED_PATHS_BY_VIEW: Readonly<Record<EspnView, readonly string[]>> = Object.freeze({
  mSettings: [
    "$.settings.scoringSettings",
    "$.settings.rosterSettings",
    "$.settings.acquisitionSettings",
    "$.settings.scheduleSettings",
  ],
  mNav: ["$.members[].isLeagueCreator"],
  mTeam: ["$.teams[].record", "$.teams[].transactionCounter", "$.teams[].waiverRank"],
  mStandings: ["$.teams[].record"],
  mRoster: ["$.teams[].roster.entries"],
  mMatchup: ["$.schedule[].matchupPeriodId"],
  mMatchupScore: ["$.schedule[].playoffTierType"],
  mBoxscore: ["$.schedule[].home.rosterForCurrentScoringPeriod"],
  mScoreboard: ["$.schedule[].home.totalPoints"],
  mDraftDetail: ["$.draftDetail.picks"],
  mTransactions2: ["$.transactions"],
  mPendingTransactions: ["$.pendingTransactions"],
  mPositionalRatings: ["$.positionAgainstOpponent.positionalRatings"],
  kona_player_info: ["$.players"],
  kona_playercard: ["$.players"],
  kona_league_communication: ["$.topics"],
  proTeamSchedules_wl: ["$.settings.proTeams"],
  players_wl: ["$[]"],
});

/**
 * Views whose required set no recorded fixture verifies yet (no solo recording; mNav is verified
 * on the recorded composite `mSettings&mNav&mTeam`). The list may only shrink: a test fails when
 * a view here gains a recording without leaving it.
 */
export const REQUIRED_PATHS_UNVERIFIED: readonly EspnView[] = Object.freeze([
  "mStandings",
  "mMatchupScore",
  "mScoreboard",
  "mDraftDetail",
  "mTransactions2",
  "mPendingTransactions",
  "mPositionalRatings",
  "kona_playercard",
  "kona_league_communication",
  "players_wl",
]);

/** A required key's JSON type: one name or a `|` union (`integer|null`). */
export type KeyType = string;
/** A JSON scalar an enum observation may hold. */
export type EnumValue = string | number | boolean | null;

/** One probe's spec (fixtures/drift/manifest.json `probes.host` / `probes.shape`). */
export interface ProbeSpec {
  /** ESPN view names the probe requests, in order. */
  readonly views: readonly string[];
  /** Entity pattern → { key: type }. A missing key or a wrong type is red drift. */
  readonly required: Readonly<Record<string, Readonly<Record<string, KeyType>>>>;
  /** Entity pattern → every key seen in the recorded fixtures; anything else is additive drift. */
  readonly observed: Readonly<Record<string, readonly string[]>>;
  /** Array pattern → the fewest elements a healthy body has (an emptied list is red drift). */
  readonly minItems?: Readonly<Record<string, number>>;
  /** Value pattern → the allowed values; a value outside the set is red drift (plan 01 §7). */
  readonly enums?: Readonly<Record<string, readonly EnumValue[]>>;
  /** Entity pattern → keys ESPN sends that the scrubber removes: known, never additive. */
  readonly scrubbed?: Readonly<Record<string, readonly string[]>>;
}

/**
 * One view's observations (plan 01 §7 manifest; plan 05 §3.1 step 4), generated from the recorded
 * fixtures named in `sources`: per-entity key sets, enum values, array-length ranges.
 */
export interface ViewManifest {
  /** Recorded fixture paths, relative to `fixtures/`. */
  readonly sources: readonly string[];
  /** Entity pattern (`$`, `$.teams[]`, `$.teams[].roster.entries[]`, `{}` = map values) → keys. */
  readonly observed: Readonly<Record<string, readonly string[]>>;
  /** Value pattern → observed enum values (in-call: an unknown value is a warning, plan 01 §7). */
  readonly enums: Readonly<Record<string, readonly EnumValue[]>>;
  /** Array pattern → observed length range. */
  readonly array_lengths: Readonly<Record<string, { readonly min: number; readonly max: number }>>;
}

/** The drift manifest, exactly as fixtures/drift/manifest.json holds it. */
export interface DriftManifest {
  readonly $comment?: string;
  /** The recorded fixtures each probe's `observed` came from (relative to `fixtures/`). */
  readonly $sources: { readonly host: readonly string[]; readonly shape: readonly string[] };
  readonly version: number;
  readonly host: string;
  readonly probes: { readonly host: ProbeSpec; readonly shape: ProbeSpec };
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
