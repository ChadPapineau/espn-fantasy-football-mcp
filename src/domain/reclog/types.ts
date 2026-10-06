// types.ts — the recommendation log and retrospective contract (plan 07 E12 record input/output,
// E13 retrospective incl. the two baselines, ESPN comparators and "n too small", E14 list items;
// plan 01 §9.2 `recommendation_log`, never pruned; plan 07 C15: every free-text field here is
// model-authored and untrusted on read — readers path-list RECLOG_TEXT_PATHS with source
// `store.recommendation_log`). Deviations recorded (sibling lessons): the dedup scope is the whole
// (league, season, week, kind, client_ref) tuple (sib QA-1-061); a scored outcome is persisted
// beside the immutable log row (sib critic C-02b). Ported from sibling @d72e03b, adapted.
import type { SeedingMode } from "../../config/schema.js";
import type { InputFreshness, Rec, RecSubject } from "../analytics/types.js";
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
 * Every model-authored free-text path in a stored record, relative to the record. Every reader
 * (E13, E14, `espn-ff://rec/{log_id}`, `espn-ff://rec/week/{week}`) path-lists these, prefixed
 * with its own `data…` path, with source RECLOG_UNTRUSTED_SOURCE (plan 07 C15).
 */
export const RECLOG_TEXT_PATHS: readonly string[] = Object.freeze([
  "rec.action",
  "rec.assumptions[].text",
  "rec.assumptions[].revisit_trigger",
  "rec.drivers[].name",
  "alternatives[].action",
  "note",
]);
/** The provenance tag of every read-back free-text field. */
export const RECLOG_UNTRUSTED_SOURCE = "store.recommendation_log";

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

/** A proposed (never applied) parameter change — P2; always empty in v1 (plan 07 E13). */
export interface ParameterChange {
  readonly parameter: string;
  readonly current: number;
  readonly proposed: number;
  readonly evidence_n: number;
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
  /** Phase 3 (plan 10 C8); null in v1. */
  readonly attribution: Readonly<Record<string, number>> | null;
  /** P2; always empty in v1. */
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
