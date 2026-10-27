// types.ts — the recommendation log and retrospective contract (plan 07 E12 record input/output,
// E13 retrospective incl. the two baselines, ESPN comparators and "n too small", E14 list items;
// plan 01 §9.2 `recommendation_log`, never pruned; plan 07 C15: what the model wrote here is
// untrusted on read — readers path-list RECLOG_TEXT_PATHS, every position whose grammar admits words
// (RECLOG_STRING_PATHS classifies them all), with source `store.recommendation_log`). Deviations
// recorded (sibling lessons): the dedup scope is the whole (league, season, week, kind, client_ref)
// tuple (sib QA-1-061); a scored outcome is persisted beside the immutable log row (sib critic
// C-02b). Ported from sibling @d72e03b, adapted.
import type { SeedingMode } from "../../config/schema.js";
import type { BestEffortOutcome, InputFreshness, Rec, RecSubject } from "../analytics/types.js";
import type { ScoredClaim } from "../evidence/calibration.js";
import type { BareText, IsoInstant, Week } from "../league/types.js";
import type { Dist } from "../scoring/types.js";

/** `log_id` grammar: `rec-` + a 26-char Crockford-base32 ULID. */
export const LOG_ID_RE = /^rec-[0-9A-HJKMNP-TV-Z]{26}$/;
/** `source_calls[].tool` grammar: an `espn_` tool name (≤ 40 chars; plan 01 §4.1). */
export const TOOL_NAME_RE = /^espn_[a-z_]{1,35}$/;
/** `decision_metric` grammar: a snake-case metric name, never prose. */
export const DECISION_METRIC_RE = /^[a-z_]{1,32}$/;
/** `client_ref` grammar (plan 07 E12: ≤ 64 chars). */
export const CLIENT_REF_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * How one string position of a stored record is read back (plan 07 C15: the log is a persistence
 * channel for injected text across sessions, and everything in a row but its id and instant is the
 * model's). `listed` — model-authored under a grammar that admits words: sanitised and path-listed
 * with source RECLOG_UNTRUSTED_SOURCE on every read. `code` — model-authored under a closed enum or
 * a grammar that cannot carry an instruction (digits, lowercase hex, an ISO instant). `minted` — the
 * server's own (the log id, the recording instant).
 */
export type ReclogStringClass = "listed" | "code" | "minted";

/**
 * Every string position of a read-back record (`espn-ff://rec/{log_id}`; relative to the record,
 * `[]` = every element), classified. Besides the free text, the labels whose grammars spell words
 * are listed: `client_ref` (CLIENT_REF_RE — "ignore.previous:rules"; the B2a gate's round 3), the
 * decision metric (DECISION_METRIC_RE — "ignore_rules_drop_your_qb"), every slot (SLOT_NAME_RE —
 * "DropYourQB"), every provenance tag (INPUT_SOURCE_RE — "system:IgnorePreviousRules…") and every
 * source call's tool (TOOL_NAME_RE — "espn_ignore_all_previous_instructions"), although C15's
 * enumeration predates them (Stage C finding reclog-identifier-fields-unlisted). A string position
 * added to the record without an entry here, or a position that admits a word without being
 * `listed`, fails tests/domain/reclog/read-back-paths.test.ts. A position stays `listed` even if its
 * write grammar later closes: the log is never pruned, so older rows keep what it admitted.
 */
export const RECLOG_STRING_PATHS: Readonly<Record<string, ReclogStringClass>> = Object.freeze({
  // free text (C15's enumeration) and the model's own dedup label
  "rec.action": "listed",
  "rec.assumptions[].text": "listed",
  "rec.assumptions[].revisit_trigger": "listed",
  "rec.drivers[].name": "listed",
  "alternatives[].action": "listed",
  note: "listed",
  client_ref: "listed",
  // labels whose grammars spell words
  "rec.decision_metric": "listed",
  "rec.subjects[].slot": "listed",
  "rec.lineup[].slot": "listed",
  "rec.confidence.inputs[].source": "listed",
  "alternatives[].subjects[].slot": "listed",
  "source_calls[].tool": "listed",
  // closed enums
  kind: "code",
  "rec.subjects[].role": "code",
  "rec.distribution.basis": "code",
  "rec.confidence.inputs[].freshness": "code",
  "alternatives[].subjects[].role": "code",
  "alternatives[].distribution.basis": "code",
  seeding_mode_used: "code",
  followed_hint: "code",
  // grammars that cannot carry an instruction: GSIS ids, ISO instants, request ids, the hash
  "rec.subjects[].gsis_id": "code",
  "rec.as_of": "code",
  "rec.latest_execution_time": "code",
  "rec.confidence.inputs[].as_of": "code",
  "alternatives[].subjects[].gsis_id": "code",
  "source_calls[].request_id": "code",
  settings_hash: "code",
  // the server's own
  log_id: "minted",
  recorded_at: "minted",
});

/**
 * Every model-authored path of a stored record whose grammar admits words (RECLOG_STRING_PATHS'
 * `listed` entries), relative to the record. Every reader (E13, E14, `espn-ff://rec/{log_id}`,
 * `espn-ff://rec/week/{week}`) path-lists these, prefixed with its own `data…` path, with source
 * RECLOG_UNTRUSTED_SOURCE (plan 07 C15), and readBackView sanitises each of them.
 */
export const RECLOG_TEXT_PATHS: readonly string[] = Object.freeze(
  Object.keys(RECLOG_STRING_PATHS).filter((p) => RECLOG_STRING_PATHS[p] === "listed"),
);
/** The provenance tag of every listed read-back field (RECLOG_TEXT_PATHS). */
export const RECLOG_UNTRUSTED_SOURCE = "store.recommendation_log";
/**
 * The model-authored text paths of `espn_analyze_retrospective` data (plan 07 E13, C15), relative to
 * `data`: the tool path-lists them with source RECLOG_UNTRUSTED_SOURCE (`rec.action` there is the
 * server's own text, not the log's).
 */
export const RETROSPECTIVE_TEXT_PATHS: readonly string[] = Object.freeze([
  "calls[].recommended",
  "calls[].best_alternative",
]);
/** The model-authored text paths of `espn_list_recommendations` data (plan 07 E14, C15). */
export const RECOMMENDATION_LIST_TEXT_PATHS: readonly string[] = Object.freeze([
  "items[].action_summary",
]);

/** Recommendation kinds (plan 07 E12 `kind`). */
export const RECOMMENDATION_KINDS = [
  "lineup",
  "waiver",
  "stream",
  "trade",
  "cascade",
  "schedule",
  "roster",
  "evidence",
  "matchup",
  "onboarding",
  "retro",
  "executed",
  "weekly",
  "session",
] as const;
export type RecommendationKind = (typeof RECOMMENDATION_KINDS)[number];

/** What the user said about following the call (plan 07 E12). */
export type FollowedHint = "unknown" | "user_said_yes" | "user_said_no";

/** An alternative the model offered alongside the recommendation. */
export interface Alternative {
  /** Model-authored text (untrusted on read). */
  readonly action: string;
  /** Structured subjects — regret is computed from these, never from `action`. */
  readonly subjects: readonly RecSubject[];
  readonly point_estimate: number;
  readonly distribution: Dist;
  readonly decision_metric_value: number;
}

/** A tool call the recommendation was derived from (`request_id` = that envelope's `meta.request_id`). */
export interface SourceCall {
  readonly tool: string;
  readonly request_id: string;
}

/** The validated `espn_record_recommendation` input plus the tool-filled identity (plan 07 E12). */
export interface RecordRecommendationInput {
  /** Filled by the tool from config — never supplied by the model (plan 02 §5). */
  readonly league_id: string;
  /** Filled by the tool from the league's season. */
  readonly season: number;
  readonly kind: RecommendationKind;
  readonly week: Week;
  readonly rec: Rec;
  readonly alternatives: readonly Alternative[];
  readonly source_calls: readonly SourceCall[];
  /** The settings the call was made under (links the never-pruned `league_settings` row). */
  readonly settings_hash: string;
  readonly seeding_mode_used: SeedingMode | "both" | null;
  readonly followed_hint: FollowedHint;
  /** Deduplication key; a second record dedups only on the whole RECORD_DEDUP_SCOPE. */
  readonly client_ref: string | null;
  /** Model-authored note, ≤ 200 chars (untrusted on read). */
  readonly note: string | null;
}

/** One stored log row (never pruned). */
export interface RecommendationRecord extends RecordRecommendationInput {
  readonly log_id: string;
  readonly recorded_at: IsoInstant;
}

/**
 * The read-back form of a record (`espn-ff://rec/{log_id}`): the stored row WITHOUT `league_id`
 * (plan 07 §4.1: the league id is never emitted; CLAUDE.md). Readers path-list RECLOG_TEXT_PATHS.
 */
export type RecommendationRecordView = Omit<RecommendationRecord, "league_id">;

/** Strips `league_id` at RUN time (an `Omit` alone would still serialise the key). */
export function toRecordView(record: RecommendationRecord): RecommendationRecordView {
  const { league_id: _leagueId, ...view } = record;
  return view;
}

/** `espn_record_recommendation` output (plan 07 E12). */
export interface RecordResult {
  readonly log_id: string;
  readonly recorded_at: IsoInstant;
  readonly week: Week;
  readonly kind: RecommendationKind;
  readonly deduplicated: boolean;
}

/** The fields that make two records the SAME record (idempotent retries only). */
export const RECORD_DEDUP_SCOPE = Object.freeze([
  "league_id",
  "season",
  "week",
  "kind",
  "client_ref",
] as const);
export type RecordDedupField = (typeof RECORD_DEDUP_SCOPE)[number];

/** A record's deduplication scope (only records with a `client_ref` have one). */
export interface RecordDedupScope {
  readonly league_id: string;
  readonly season: number;
  readonly week: Week;
  readonly kind: RecommendationKind;
  readonly client_ref: string;
}

/** The dedup scope of a record, or null when it has no `client_ref` (never deduplicated). */
export function recordDedupScope(
  input: Pick<RecordRecommendationInput, RecordDedupField>,
): RecordDedupScope | null {
  if (input.client_ref === null) return null;
  return Object.freeze({
    league_id: input.league_id,
    season: input.season,
    week: input.week,
    kind: input.kind,
    client_ref: input.client_ref,
  });
}

/** Whether `b` deduplicates onto `a`: both carry a `client_ref` and every scope field is equal. */
export function sameRecordDedupScope(
  a: Pick<RecordRecommendationInput, RecordDedupField>,
  b: Pick<RecordRecommendationInput, RecordDedupField>,
): boolean {
  const sa = recordDedupScope(a);
  const sb = recordDedupScope(b);
  return sa !== null && sb !== null && RECORD_DEDUP_SCOPE.every((f) => sa[f] === sb[f]);
}

/** One `espn_list_recommendations` item (plan 07 E14). */
export interface RecommendationListItem {
  readonly log_id: string;
  readonly kind: RecommendationKind;
  readonly week: Week;
  readonly recorded_at: IsoInstant;
  /** Model-authored summary, sanitised and capped on read (BareText; path-listed — C15). */
  readonly action_summary: BareText;
  readonly followed: boolean | null;
}

/** A scored outcome, persisted beside the immutable log row (`recommendation_outcome`). */
export interface RecommendationOutcome {
  readonly log_id: string;
  readonly followed: boolean | null;
  readonly realised: number | null;
  readonly regret: number | null;
  readonly decisive: boolean | null;
  readonly scored_at: IsoInstant;
  /** Scored on final stats (an outcome scored while provisional is re-scored later). */
  readonly week_final: boolean;
}

// --- retrospective (plan 07 E13; research 05 §8.4) ------------------------------------------------

/** Below this n a metric reports "n too small" (plan 07 E13 `min_n` default; sib ADV OBJ-05). */
export const DEFAULT_MIN_N = 30;
/** The literal a metric under its minimum n carries: `n too small (k of 30)`. */
export type NTooSmall = `n too small (${number} of ${number})`;

/** An integer count for the caveat: non-finite or < 1 → `fallback`; capped so it prints as digits. */
function countOr(v: number, fallback: number): number {
  return Number.isFinite(v) && v >= 1 ? Math.min(Math.floor(v), Number.MAX_SAFE_INTEGER) : fallback;
}

/** Builds the "n too small (k of min)" string; non-finite, negative or huge inputs are clamped. */
export function nTooSmall(k: number, minN: number = DEFAULT_MIN_N): NTooSmall {
  const kk = countOr(k, 0);
  const mm = countOr(minN, DEFAULT_MIN_N);
  return `n too small (${String(kk)} of ${String(mm)})` as NTooSmall;
}

/** A Brier entry: ours, ESPN's where a comparator exists, and n (the value or the caveat). */
export interface BrierEntry {
  readonly ours: number | NTooSmall | null;
  readonly espn?: number | NTooSmall | null;
  readonly n: number;
}

/**
 * A proposed (never applied) parameter change (plan 07 E13). Empty in v1; from Phase 3 the
 * retrospective proposes re-fitted projection parameters and only a human-run `eff tune --apply`
 * applies them (plan 10 §3.3, C9; src/domain/reclog/tune.ts).
 */
export interface ParameterChange {
  readonly parameter: string;
  readonly current: number;
  readonly proposed: number;
  readonly evidence_n: number;
}

// --- Phase 3: parameter proposals (plan 10 §3.3 "the weekly re-fit … proposed by retro and applied
// only by a human-run eff tune --apply", C9; sib research 05 §12.4–§12.5). Additive. --------------

/** The grammar of a tunable parameter name: ≤ 40 chars (the E13 wire bound), `base` or `base.key`. */
export const PARAMETER_NAME_RE =
  /^(?=.{1,40}$)[a-z][a-z0-9_]{0,23}(?:\.[A-Za-z][A-Za-z0-9_]{0,23})?$/;

/** How a parameter is re-fitted (src/domain/reclog/tune.ts). */
export type TuneFitKind = "ewm_half_life" | "shrinkage_k" | "matchup_beta" | "weight_espn";

/** Why a tunable parameter was or was not proposed this week. */
export type ProposalOutcome =
  "proposed" | "no_change" | "n_too_small" | "current_unknown" | "not_held";

/** One proposal with its evidence: the loss at the current value and at the proposed one. */
export interface ParameterProposal extends ParameterChange {
  readonly fit: TuneFitKind;
  /** The fit's loss (mean squared or absolute error, per fit) at the value in effect. */
  readonly loss_current: number;
  /** The same loss at the proposed value (strictly lower, and lower in both halves of the window). */
  readonly loss_proposed: number;
}

/** One registry parameter's evaluation, proposed or not (why not is the outcome). */
export interface ParameterEvaluation {
  readonly parameter: string;
  readonly fit: TuneFitKind;
  readonly evidence_n: number;
  readonly outcome: ProposalOutcome;
  /** The value in effect (the applied override, else the value the model reported using). */
  readonly current: number | null;
  /** The unshrunk best fit on the window; null when not fitted. */
  readonly fitted: number | null;
}

/**
 * What one retrospective proposes (persisted by the retro tool, read by `eff tune`): the proposals,
 * every parameter's evaluation, and a content hash the human matches between retro and the CLI.
 */
export interface ParameterProposalSet {
  readonly schema: 1;
  readonly created_at: IsoInstant;
  readonly season: number;
  /** The scored week (proposals are made on final weeks only). */
  readonly week: Week;
  /** The season-to-date window the fits read. */
  readonly window: { readonly first_week: Week; readonly last_week: Week };
  readonly proposals: readonly ParameterProposal[];
  readonly evaluated: readonly ParameterEvaluation[];
  /** sha256 (64 lowercase hex) of the canonical (season, week, proposals) — the set's id. */
  readonly hash: string;
}

/**
 * Where the retrospective persists proposal sets and `eff tune` reads the newest one (a store table,
 * never pruned — the audit trail of what was proposed). The league id is local-only, never emitted.
 */
export interface ParameterProposalRepository {
  put(leagueId: string, set: ParameterProposalSet): void;
  /** The newest set of a league's season, or null when none was stored. */
  latest(leagueId: string, season: number): ParameterProposalSet | null;
}

/**
 * One news claim E10 weighed, logged for the calibration table (plan 10 C8; migration 002
 * `scored_claim`): value-free — the calibration source, the claim type, its signal and the structured
 * prior it was made against; never the text. Scored once the player-week is final.
 */
export interface LoggedClaim {
  readonly season: number;
  readonly week: Week;
  readonly player_id: number;
  readonly claim: Pick<ScoredClaim, "source" | "type" | "signal" | "prior_status" | "prior_p">;
}

/** A logged claim still waiting for its outcome, with its store key. */
export interface PendingClaim extends LoggedClaim {
  readonly key: string;
}

/**
 * `scored_claim` (best-effort writes, never pruned; the league id is local-only, never emitted): E10
 * logs, the retrospective (E13) scores with `claimOutcome`, E10 reads the scored rows into the table.
 */
export interface ScoredClaimRepository {
  /** Logs a claim once (idempotent per player-week, source, type and signal). */
  log(leagueId: string, c: LoggedClaim, loggedAt: IsoInstant): BestEffortOutcome;
  /** The league's unscored claims of a week. */
  pending(leagueId: string, season: number, week: Week): readonly PendingClaim[];
  /** Records a claim's outcome (a second scoring of the same key changes nothing). */
  score(
    key: string,
    outcome: { readonly active: boolean | null; readonly borne_out: boolean | null },
    scoredAt: IsoInstant,
  ): BestEffortOutcome;
  /** The league's scored claims (every season), newest first, at most `limit`. */
  scored(leagueId: string, limit: number): readonly ScoredClaim[];
}

/** One scored call (plan 07 E13 `calls[]`). */
export interface RetrospectiveCall {
  readonly log_id: string;
  readonly kind: RecommendationKind;
  readonly followed: boolean | null;
  readonly regret: number | null;
  readonly decisive: boolean | null;
  /** Model-authored, sanitised on read (BareText; path-listed, source `store.recommendation_log`). */
  readonly recommended: BareText;
  /** Model-authored, sanitised on read (BareText; path-listed). */
  readonly best_alternative: BareText | null;
  readonly realised: number | null;
}

/** `espn_analyze_retrospective` data (plan 07 E13). */
export interface RetrospectiveData {
  readonly week: Week;
  readonly final: boolean;
  readonly corrections_window_open: boolean;
  readonly calls: readonly RetrospectiveCall[];
  readonly baselines: {
    readonly last_week_points: { readonly regret: number | null };
    /** Not informative while `weight_espn = 1.0` (identically zero regret — R2 nit 2). */
    readonly espn_projection_lineup: {
      readonly regret: number | null;
      readonly informative: boolean;
    };
  };
  readonly metrics: {
    readonly projection_vs_espn: {
      readonly crps_ours: number | null;
      readonly crps_espn: number | null;
      readonly mae_by_position: Readonly<
        Record<string, { readonly ours: number; readonly espn: number }>
      >;
      readonly n_player_weeks: number;
    };
    readonly swap_regret: { readonly mean: number | null; readonly n: number };
    readonly brier: {
      readonly p_active: BrierEntry;
      readonly p_win: BrierEntry;
      readonly p_playoffs: BrierEntry;
      readonly p_role_holds: BrierEntry;
      readonly p_k_win: BrierEntry;
    };
    readonly coverage_80: number | null;
    readonly spearman_by_position: Readonly<Record<string, number | null>>;
  };
  readonly sample_size: Readonly<
    Record<
      string,
      {
        readonly n: number;
        readonly n_needed: number;
        readonly weeks_to_n30_estimate: number | null;
      }
    >
  >;
  /**
   * Phase 3 (plan 10 C9): the projection-error attribution as a flat map (src/domain/reclog/
   * attribution.ts `attributionMap` — the key grammar is documented there); null when the caller
   * passed no attribution rows.
   */
  readonly attribution: Readonly<Record<string, number>> | null;
  /** Phase 3: the first MAX_WIRE_PROPOSALS proposals (never applied here — `eff tune --apply`). */
  readonly parameter_changes_proposed: readonly ParameterChange[];
  readonly sample_size_caveats: readonly string[];
  readonly rec: Rec;
  readonly inputs: readonly InputFreshness[];
}

/** `espn_list_recommendations` data (plan 07 E14). */
export interface RecommendationListData {
  readonly items: readonly RecommendationListItem[];
}

// --- the repository port (store; required writes) -------------------------------------------------

/** A list query over the log. */
export interface RecommendationQuery {
  readonly league_id: string;
  readonly season: number | null;
  readonly week: Week | null;
  readonly kind: RecommendationKind | null;
  readonly limit: number;
  readonly offset: number;
}

/** A page of log items (`total` known — the log is local). */
export interface RecommendationPage {
  readonly items: readonly RecommendationListItem[];
  readonly total: number;
}

/** The recommendation-log repository (never pruned). */
export interface RecommendationLogRepository {
  /** Inserts, or returns the row with the same dedup scope with `deduplicated: true`. */
  record(input: RecordRecommendationInput, recordedAt: IsoInstant): RecordResult;
  get(logId: string): RecommendationRecord | null;
  /** Newest first; `followed` joined from the outcome table. */
  list(q: RecommendationQuery): RecommendationPage;
  forWeek(leagueId: string, season: number, week: Week): readonly RecommendationRecord[];
  /** Upserts the scored outcome of one call (the log row itself never changes). */
  recordOutcome(outcome: RecommendationOutcome): void;
  outcome(logId: string): RecommendationOutcome | null;
}

/** How many records one week of a league-season holds (`PacedRecommendationLog.weekCounts`). */
export interface WeekRecordCount {
  readonly week: Week;
  readonly n: number;
}

/** The most outcomes one `recordOutcomes` call carries (a week's calls at the store's per-week cap). */
export const OUTCOMES_PER_WRITE_MAX = 100;

/**
 * The recommendation log as an analytics caller reads it (E13; plan 03 §1.2: no turn of the event
 * loop holds more than one bounded statement or one small batch, however long the never-pruned log
 * grows — Stage C finding reclog-retrospective-unbounded-read: E13 read every week up to the scored
 * one, whole, in one turn): which weeks hold records (no record text read), one week read in pages
 * with the caller's pace awaited around them, and a scored week's outcomes in one transaction. The
 * store implements it (src/store/types.ts RecommendationLogStore).
 */
export interface PacedRecommendationLog extends RecommendationLogRepository {
  /** Records each week of a league-season holds, ascending by week; weeks with none are absent. */
  weekCounts(leagueId: string, season: number): readonly WeekRecordCount[];
  /** `forWeek`'s records in its order, read in bounded pages; `pace` awaited before, between, after. */
  forWeekPaced(
    leagueId: string,
    season: number,
    week: Week,
    pace: () => Promise<void>,
  ): Promise<readonly RecommendationRecord[]>;
  /** Upserts at most OUTCOMES_PER_WRITE_MAX outcomes in ONE write transaction (all or none). */
  recordOutcomes(outcomes: readonly RecommendationOutcome[]): void;
}
