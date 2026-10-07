// retrospective.ts — joins logged calls to what happened and assembles `espn_analyze_retrospective`
// (plan 07 E13: realised = ESPN `appliedTotal`, provisional until `statsOfficial`, the corrections
// window; the two baselines with `informative: false` while weight_espn = 1.0; ESPN's projection,
// winProbability and playoffPct as comparators; "n too small" until min_n; C15: model-authored text
// is read back sanitised and path-listed; plan 10 §2 n-per-metric; research 05 §5 Calibration,
// §8.4 #2/#5/#7). Pure: the tool gathers records, facts, rosters and forecasts and passes them in.
// Ported from sibling @cf3b015, adapted (ESPN ids, baselines, comparators, season-to-date pooling).

import {
  correctionsWindowOpen,
  isPeriodProvisional,
  type GameFlags,
} from "../../config/freshness.js";
import {
  WEIGHT_ESPN_V1,
  type InputFreshness,
  type Rec,
  type RecSubject,
  type SubjectRole,
} from "../analytics/types.js";
import { parseIso, type Clock } from "../clock.js";
import {
  bareUntrusted,
  type BareText,
  type IsoInstant,
  type SlotClass,
  type Week,
} from "../league/types.js";
import type { Dist } from "../scoring/types.js";
import {
  MAX_ABS_VALUE,
  at,
  brierScore,
  crpsFromDist,
  crpsFromSamples,
  intervalCoverage,
  isMetricValue,
  isProbabilityOutcome,
  meanAbsoluteError,
  spearman,
  stableMean,
  stableSum,
  type ProbabilityOutcome,
} from "./metrics.js";
import { isIsoInstant } from "./record.js";
import {
  DEFAULT_MIN_N,
  RECOMMENDATION_KINDS,
  nTooSmall,
  toRecordView,
  type BrierEntry,
  type NTooSmall,
  type RecommendationKind,
  type RecommendationListItem,
  type RecommendationOutcome,
  type RecommendationRecord,
  type RecommendationRecordView,
  type RetrospectiveCall,
  type RetrospectiveData,
} from "./types.js";

// --- bounds ----------------------------------------------------------------------------------------

/** E13 bounds (mirrors src/mcp BOUNDS.week and plan 07 E13 `min_n`). */
export const RETRO_BOUNDS = Object.freeze({
  week: { min: 1, max: 18 },
  minN: { min: 1, max: 10_000 },
});

// --- inputs --------------------------------------------------------------------------------------

/** Who a fact/roster row is about: the ESPN player id, else the gsis id, joins it to a RecSubject. */
export interface SubjectIdentity {
  readonly player_id: number | null;
  readonly gsis_id: string | null;
}

/** One player's numbers for one week (A5 box score + the `espn_projection` snapshot). */
export interface PlayerWeekFact extends SubjectIdentity {
  /** ESPN `appliedTotal` for the week (statSourceId 0) — the realised value; null when unknown. */
  readonly points: number | null;
  /** Realised points the week before (the "start by last week's points" baseline); null = unknown. */
  readonly last_week_points: number | null;
  /** ESPN's pre-lock weekly projection under this league's scoring (split (1,1)); null = unknown. */
  readonly espn_projection: number | null;
}

/** One player on the user's roster for the week, and the class of the slot he occupied. */
export interface RosterPresence extends SubjectIdentity {
  readonly slot_class: SlotClass;
}

/** The user's head-to-head result for the week (for `decisive`). */
export interface TeamResult {
  readonly my_points: number;
  readonly opponent_points: number;
}

/** One week of logged calls and what happened (the scored week, or an earlier one for pooling). */
export interface ScoringWeek {
  readonly week: Week;
  /** The calls logged FOR this week (`record.week === week`; others are skipped with a warning). */
  readonly records: readonly RecommendationRecord[];
  readonly facts: readonly PlayerWeekFact[];
  /** The user's roster for the week; null when unknown (then `followed_hint` decides). */
  readonly roster: readonly RosterPresence[] | null;
  readonly team_result: TeamResult | null;
}

/**
 * One scored player-week projection: our pre-lock forecast (never a post-kickoff run), ESPN's
 * projection as a Dist (ESPN's mean widened by the same position-CV rule E1 uses — research 05 §5
 * "beat ESPN's mean-only projection given a positional-CV distribution"), and the realised points.
 */
export interface PlayerForecast {
  readonly week: Week;
  /** Used only to drop a duplicated player-week; null rows are never deduplicated. */
  readonly player_id: number | null;
  /** Display position (`QB`, `D/ST`, …) — RETRO_POSITION_RE; anything else is excluded. */
  readonly position: string;
  readonly ours: Dist;
  /** Scored simulation points (`player_sim`); without them CRPS comes from the Dist's quantiles. */
  readonly ours_samples: readonly number[] | null;
  readonly espn: Dist | null;
  /** ESPN `appliedTotal` (realised). */
  readonly outcome: number;
}

/** A probability forecast of one week and what happened. */
export interface WeekProbability extends ProbabilityOutcome {
  readonly week: Week;
}

/**
 * A probability with ESPN's own number beside it (p_win: `mMatchupScore.winProbability` from the
 * pre-week `scoreboard_snapshot`; p_playoffs: `currentSimulationResults.playoffPct`), both in 0..1 —
 * the provider normalises percentages.
 */
export interface ComparatorProbability {
  readonly week: Week;
  /** Our forecast; null = we made none (the row is skipped). */
  readonly ours: number | null;
  /** ESPN's; null = not captured. */
  readonly espn: number | null;
  readonly outcome: boolean;
}

/** The probability forecasts to score, pooled season-to-date by the caller. */
export interface ProbabilityForecasts {
  readonly p_active: readonly WeekProbability[];
  readonly p_win: readonly ComparatorProbability[];
  readonly p_playoffs: readonly ComparatorProbability[];
  readonly p_role_holds: readonly WeekProbability[];
  readonly p_k_win: readonly WeekProbability[];
}

/** Everything the retrospective scores (plan 07 E13 data: recommendation_log, A3, A4, A5, A6). */
export interface RetrospectiveInput {
  /** The scored week (E13 `week`, default the last final week — resolved by the tool). */
  readonly week: Week;
  /** The scored week's NFL games (`proTeamSchedules_wl`): `final` and the corrections window. */
  readonly games: readonly GameFlags[];
  /** E13 `kinds`; null = all. Filters `calls[]`, swap regret and the baselines. */
  readonly kinds: readonly RecommendationKind[] | null;
  /**
   * Season-to-date weeks up to and including `week`. `calls[]` come from `week`; swap regret and
   * the baselines pool every week ≤ `week` (later weeks are skipped: no look-ahead).
   */
  readonly weeks: readonly ScoringWeek[];
  /** Pooled season-to-date player-week forecasts. */
  readonly player_forecasts: readonly PlayerForecast[];
  /** Pooled season-to-date probability forecasts. */
  readonly probabilities: ProbabilityForecasts;
  /** The shipped `weight_espn` (plan 07 E1; v1 1.0): the ESPN baseline is informative only below 1. */
  readonly weight_espn: number;
  /** E13 `min_n` (1..10 000, default 30). */
  readonly min_n: number;
  /** Every contributing input with its freshness (plan 07 §2). */
  readonly inputs: readonly InputFreshness[];
}

/** The assembled retrospective, the outcome rows to persist, and fixed-vocabulary warnings. */
export interface RetrospectiveResult {
  readonly data: RetrospectiveData;
  /** `meta.provisional` (plan 01 §5.4): true while the scored week is not final. */
  readonly provisional: boolean;
  /** One per scored call of `week`, for RecommendationLogRepository.recordOutcome. */
  readonly outcomes: readonly RecommendationOutcome[];
  /** Envelope warnings (counts only; never third-party or model-authored text). */
  readonly warnings: readonly string[];
}

// --- subject index -----------------------------------------------------------------------------------

/**
 * An index from subject ids to values; an id seen twice with unequal values is ambiguous (null), so
 * a hostile duplicate row cannot choose a value.
 */
export class SubjectIndex<T> {
  private readonly byId = new Map<number, T | null>();
  private readonly byGsis = new Map<string, T | null>();

  constructor(
    rows: readonly (SubjectIdentity & { readonly value: T })[],
    equals: (a: T, b: T) => boolean = Object.is,
  ) {
    const put = <K>(m: Map<K, T | null>, k: K | null, v: T): void => {
      if (k === null) return;
      if (!m.has(k)) {
        m.set(k, v);
        return;
      }
      const prev = m.get(k);
      if (prev !== null && prev !== undefined && !equals(prev, v)) m.set(k, null);
    };
    for (const r of rows) {
      put(this.byId, typeof r.player_id === "number" ? r.player_id : null, r.value);
      put(this.byGsis, typeof r.gsis_id === "string" ? r.gsis_id : null, r.value);
    }
  }

  /** The value for a subject (player_id first, then gsis_id); null = ambiguous; undefined = absent. */
  get(s: SubjectIdentity): T | null | undefined {
    if (s.player_id !== null && this.byId.has(s.player_id)) return this.byId.get(s.player_id);
    if (s.gsis_id !== null && this.byGsis.has(s.gsis_id)) return this.byGsis.get(s.gsis_id);
    return undefined;
  }
}

/** A fact with every number checked: anything non-finite or out of range reads as unknown (null). */
function cleanFact(f: PlayerWeekFact): PlayerWeekFact {
  const num = (x: unknown): number | null => (isMetricValue(x) ? x : null);
  return {
    player_id: f.player_id,
    gsis_id: f.gsis_id,
    points: num(f.points),
    last_week_points: num(f.last_week_points),
    espn_projection: num(f.espn_projection),
  };
}

const sameFact = (a: PlayerWeekFact, b: PlayerWeekFact): boolean =>
  a.points === b.points &&
  a.last_week_points === b.last_week_points &&
  a.espn_projection === b.espn_projection;

/** The facts index of one week (cleaned; conflicting duplicates are ambiguous). */
export function factIndex(rows: readonly PlayerWeekFact[]): SubjectIndex<PlayerWeekFact> {
  return new SubjectIndex(
    rows.map((r) => {
      const value = cleanFact(r);
      return { player_id: value.player_id, gsis_id: value.gsis_id, value };
    }),
    sameFact,
  );
}

/** The roster index of one week (slot class by subject), or null without a roster. */
export function rosterIndex(
  rows: readonly RosterPresence[] | null,
): SubjectIndex<SlotClass> | null {
  return rows === null
    ? null
    : new SubjectIndex(
        rows.map((r) => ({ player_id: r.player_id, gsis_id: r.gsis_id, value: r.slot_class })),
      );
}

/** RosterPresence rows from roster entries (the ESPN player id; gsis ids are not needed to join). */
export function rosterPresence(
  entries: readonly {
    readonly player: { readonly ref: { readonly id: number } };
    readonly slot_class: SlotClass;
  }[],
): RosterPresence[] {
  return entries.map((e) => ({
    player_id: e.player.ref.id,
    gsis_id: null,
    slot_class: e.slot_class,
  }));
}

// --- joining a call to what happened ---------------------------------------------------------------

/** Roles whose points the recommended move gains (sit / drop / ir_move gain nothing this week). */
export const GAIN_ROLES: ReadonlySet<SubjectRole> = new Set<SubjectRole>([
  "start",
  "add",
  "claim",
  "stream",
  "trade_in",
]);
/** Kinds whose realised points land in this week's matchup (so `decisive` is defined). */
export const DECISIVE_KINDS: ReadonlySet<RecommendationKind> = new Set<RecommendationKind>([
  "lineup",
  "stream",
]);
/** Kinds scored against the two start/sit baselines (research 05 §8.4 #7, #8). */
export const BASELINE_KINDS: ReadonlySet<RecommendationKind> = new Set<RecommendationKind>([
  "lineup",
  "stream",
]);

/** What a subject's fact contributes under one reading (realised, last week, ESPN projection). */
export type FactReading = (f: PlayerWeekFact) => number | null;
export const REALISED: FactReading = (f) => f.points;
export const LAST_WEEK: FactReading = (f) => f.last_week_points;
export const ESPN_PROJECTION: FactReading = (f) => f.espn_projection;

/**
 * The value of a move under `read`: Σ over its gain subjects − Σ over its trade_out subjects. Null
 * when the move has no gain or trade_out subject (nothing to score) or any counted subject's value is
 * unknown or ambiguous. `valueOf(subjects, facts, REALISED)` is the move's realised points.
 */
export function valueOf(
  subjects: readonly RecSubject[],
  facts: SubjectIndex<PlayerWeekFact>,
  read: FactReading = REALISED,
): number | null {
  const terms: number[] = [];
  for (const s of subjects) {
    const gain = GAIN_ROLES.has(s.role);
    if (!gain && s.role !== "trade_out") continue;
    const f = facts.get(s);
    if (f === undefined || f === null) return null;
    const v = read(f);
    if (v === null) return null;
    terms.push(gain ? v : -v);
  }
  return terms.length === 0 ? null : stableSum(terms);
}

/**
 * Whether the user followed a call, from the week's roster: every subject must hold — start → in a
 * starter or flex slot; sit → not started; add/claim/stream/trade_in → rostered; drop/trade_out →
 * not rostered; ir_move → in an IR slot. An ambiguous roster row makes it unknown (null). With no
 * roster (or no subjects) the model's `followed_hint` decides; `unknown` → null.
 */
export function followedOf(
  record: RecommendationRecord,
  roster: SubjectIndex<SlotClass> | null,
): boolean | null {
  const subjects = record.rec.subjects;
  if (roster === null || subjects.length === 0) {
    if (record.followed_hint === "user_said_yes") return true;
    if (record.followed_hint === "user_said_no") return false;
    return null;
  }
  let all = true;
  for (const s of subjects) {
    const cls = roster.get(s);
    if (cls === null) return null;
    const started = cls === "starter" || cls === "flex";
    const present = cls !== undefined;
    let holds: boolean;
    switch (s.role) {
      case "start":
        holds = started;
        break;
      case "sit":
        holds = !started;
        break;
      case "drop":
      case "trade_out":
        holds = !present;
        break;
      case "ir_move":
        holds = cls === "ir";
        break;
      default:
        holds = present;
    }
    all &&= holds;
  }
  return all;
}

function sign(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

/** The scored view of one call, before it is split into the E13 row and the persisted outcome. */
export interface ScoredCall {
  readonly call: RetrospectiveCall;
  /** Swap regrets of a lineup call: max(0, points(sit) − points(start)) per start/sit pair. */
  readonly swaps: readonly number[];
  /** realised(option the "last week's points" policy picks) − realised(recommended); null = n/a. */
  readonly baseline_last_week: number | null;
  /** realised(option the "ESPN projection" policy picks) − realised(recommended); null = n/a. */
  readonly baseline_espn: number | null;
}

/**
 * Regret against a baseline policy that picks, among the options offered (the recommendation and its
 * alternatives), the one with the highest value under `read`: realised(pick) − realised(recommended)
 * — positive when the baseline would have scored more, 0 when it picks the same move. Tied picks
 * score the mean of their realised values (uniform tie-break, order-independent). Null when the call
 * has no alternative, or any option's baseline value, the recommendation's realised value or a
 * picked option's realised value is unknown (the policy's choice cannot be known).
 */
export function baselineRegret(
  record: RecommendationRecord,
  facts: SubjectIndex<PlayerWeekFact>,
  read: FactReading,
): number | null {
  if (record.alternatives.length === 0) return null;
  const options = [record.rec.subjects, ...record.alternatives.map((a) => a.subjects)];
  const realisedRec = valueOf(record.rec.subjects, facts, REALISED);
  if (realisedRec === null) return null;
  const scores: number[] = [];
  for (const o of options) {
    const v = valueOf(o, facts, read);
    if (v === null) return null;
    scores.push(v);
  }
  const best = Math.max(...scores);
  const picked: number[] = [];
  for (let i = 0; i < options.length; i++) {
    if (at(scores, i) !== best) continue;
    const r = valueOf(at(options, i), facts, REALISED);
    if (r === null) return null;
    picked.push(r);
  }
  return stableSum(picked) / picked.length - realisedRec;
}

/** Read-back form of model-authored text (plan 07 C15): sanitised and capped, path-listed by the tool. */
export function readBack(text: string): BareText {
  return bareUntrusted(text, "rec_log_text");
}

/**
 * Scores one call: `realised` of the recommendation; `regret` = realised(best alternative offered) −
 * realised(recommended), signed (negative = the call beat every alternative), null when no
 * alternative is scorable; `decisive` = following the best alternative instead would have changed
 * the H2H result (win/tie/loss) — defined only for followed lineup/stream calls with a known result;
 * swap regrets (lineup calls: the k-th start subject paired with the k-th sit subject); and the two
 * baseline regrets (lineup/stream calls). Regret is read from the structured subjects only — never
 * from the model's `action` text (plan 07 C15).
 */
export function scoreCall(
  record: RecommendationRecord,
  facts: SubjectIndex<PlayerWeekFact>,
  roster: SubjectIndex<SlotClass> | null,
  team: TeamResult | null,
): ScoredCall {
  const realised = valueOf(record.rec.subjects, facts, REALISED);
  let best: { action: string; value: number } | null = null;
  for (const alt of record.alternatives) {
    const v = valueOf(alt.subjects, facts, REALISED);
    if (v !== null && (best === null || v > best.value)) best = { action: alt.action, value: v };
  }
  const regret = realised !== null && best !== null ? best.value - realised : null;
  const followed = followedOf(record, roster);
  let decisive: boolean | null = null;
  if (
    regret !== null &&
    followed === true &&
    team !== null &&
    isMetricValue(team.my_points) &&
    isMetricValue(team.opponent_points) &&
    DECISIVE_KINDS.has(record.kind)
  ) {
    const margin = team.my_points - team.opponent_points;
    decisive = sign(margin) !== sign(margin + regret);
  }
  const swaps: number[] = [];
  if (record.kind === "lineup") {
    const starts = record.rec.subjects.filter((s) => s.role === "start");
    const sits = record.rec.subjects.filter((s) => s.role === "sit");
    for (let k = 0; k < Math.min(starts.length, sits.length); k++) {
      const a = facts.get(at(starts, k))?.points;
      const b = facts.get(at(sits, k))?.points;
      if (typeof a === "number" && typeof b === "number") swaps.push(Math.max(0, b - a));
    }
  }
  const baselined = BASELINE_KINDS.has(record.kind);
  return {
    call: {
      log_id: record.log_id,
      kind: record.kind,
      followed,
      regret,
      decisive,
      recommended: readBack(record.rec.action),
      best_alternative: best === null ? null : readBack(best.action),
      realised,
    },
    swaps,
    baseline_last_week: baselined ? baselineRegret(record, facts, LAST_WEEK) : null,
    baseline_espn: baselined ? baselineRegret(record, facts, ESPN_PROJECTION) : null,
  };
}

/** The persisted outcome row of a scored call (E14 `followed` reads it). */
export function outcomeOf(
  call: RetrospectiveCall,
  scoredAt: IsoInstant,
  weekFinal: boolean,
): RecommendationOutcome {
  return {
    log_id: call.log_id,
    followed: call.followed,
    realised: call.realised,
    regret: call.regret,
    decisive: call.decisive,
    scored_at: scoredAt,
    week_final: weekFinal,
  };
}

/** The E14 list item of a record (`followed` from its persisted outcome, null until scored). */
export function toListItem(
  record: RecommendationRecord,
  outcome: RecommendationOutcome | null,
): RecommendationListItem {
  return {
    log_id: record.log_id,
    kind: record.kind,
    week: record.week,
    recorded_at: record.recorded_at,
    action_summary: readBack(record.rec.action),
    followed: outcome === null ? null : outcome.followed,
  };
}

/**
 * The read-back form of a record (`espn-ff://rec/{log_id}`): no `league_id` (toRecordView) and every
 * RECLOG_TEXT_PATHS field sanitised and capped (control, bidi, zero-width and markup removed) — the
 * reader still path-lists them with source `store.recommendation_log` (plan 07 C15).
 */
export function readBackView(record: RecommendationRecord): RecommendationRecordView {
  const view = toRecordView(record);
  return {
    ...view,
    rec: {
      ...view.rec,
      action: readBack(view.rec.action),
      drivers: view.rec.drivers.map((d) => ({ ...d, name: readBack(d.name) })),
      assumptions: view.rec.assumptions.map((a) => ({
        text: readBack(a.text),
        revisit_trigger: readBack(a.revisit_trigger),
      })),
    },
    alternatives: view.alternatives.map((a) => ({ ...a, action: readBack(a.action) })),
    note: view.note === null ? null : readBack(view.note),
    client_ref: view.client_ref === null ? null : readBack(view.client_ref),
  };
}

// --- metric blocks -------------------------------------------------------------------------------

/** A display position usable as a record key (`QB`, `D/ST`, `RB/WR` — never `__proto__`). */
export const RETRO_POSITION_RE = /^[A-Z][A-Za-z/]{0,9}$/;

function validDist(d: unknown): d is Dist {
  if (typeof d !== "object" || d === null) return false;
  const x = d as Record<string, unknown>;
  return (
    isMetricValue(x.mean) &&
    isMetricValue(x.p10) &&
    isMetricValue(x.p25) &&
    isMetricValue(x.p50) &&
    isMetricValue(x.p75) &&
    isMetricValue(x.p90) &&
    x.p10 <= x.p25 &&
    x.p25 <= x.p50 &&
    x.p50 <= x.p75 &&
    x.p75 <= x.p90
  );
}

function validForecast(f: PlayerForecast): boolean {
  return (
    typeof f.position === "string" &&
    RETRO_POSITION_RE.test(f.position) &&
    validDist(f.ours) &&
    isMetricValue(f.outcome) &&
    (f.ours_samples === null ||
      (Array.isArray(f.ours_samples) &&
        f.ours_samples.length > 0 &&
        f.ours_samples.every(isMetricValue)))
  );
}

/** Caveat line for a metric under its minimum n: `metric: n too small (k of min)`. */
export function caveat(metric: string, n: number, minN: number): string {
  return `${metric}: ${nTooSmall(n, minN)}`;
}

/** A value gated on n: computed only when n ≥ min_n, else null (research 05 §8.4: no conclusion). */
function gated<T>(n: number, minN: number, compute: () => T): T | null {
  return n >= minN ? compute() : null;
}

function byPosition<T extends { readonly position: string }>(rows: readonly T[]): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const list = m.get(r.position);
    if (list === undefined) m.set(r.position, [r]);
    else list.push(r);
  }
  // Map keys are unique, so no two entries compare equal
  return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}

/** The projection block (research 05 §5 Projections, §8.4 #2) and its sample sizes. */
export interface ProjectionMetrics {
  readonly projection_vs_espn: RetrospectiveData["metrics"]["projection_vs_espn"];
  readonly coverage_80: number | null;
  readonly spearman_by_position: Readonly<Record<string, number | null>>;
  /** Rows with a valid forecast of ours (coverage, Spearman). */
  readonly n_ours: number;
  readonly caveats: readonly string[];
}

/**
 * Projection metrics over the valid forecasts (invalid rows are ignored). The comparison with ESPN (CRPS of ours vs of ESPN's
 * position-CV Dist, MAE of the means by position) is PAIRED: only player-weeks carrying both are
 * counted (`n_player_weeks`). Coverage of our 80 % band (p10..p90, ends inclusive) and Spearman
 * within position use every valid forecast of ours. Every value is null (or a position omitted from
 * `mae_by_position`) while its n is under `min_n`; per-position caveats are listed once the overall
 * metric has reached `min_n` (until then the overall caveat says it).
 */
export function projectionMetrics(
  rows: readonly PlayerForecast[],
  minN: number,
): ProjectionMetrics {
  const caveats: string[] = [];
  // standalone-safe: invalid rows (and a position such as `__proto__`) never reach a record key
  const forecasts = rows.filter(validForecast);
  const paired = forecasts.flatMap((f) =>
    f.espn !== null && validDist(f.espn) ? [{ position: f.position, f, espn: f.espn }] : [],
  );
  const nPaired = paired.length;
  const crpsOurs = (f: PlayerForecast): number =>
    f.ours_samples === null
      ? crpsFromDist(f.ours, f.outcome)
      : crpsFromSamples(f.ours_samples, f.outcome);
  const mae: Record<string, { readonly ours: number; readonly espn: number }> = {};
  if (nPaired >= minN)
    for (const [pos, list] of byPosition(paired)) {
      if (list.length < minN) {
        caveats.push(caveat(`projection_vs_espn.mae_by_position.${pos}`, list.length, minN));
        continue;
      }
      const ys = list.map((r) => r.f.outcome);
      mae[pos] = {
        ours: meanAbsoluteError(
          list.map((r) => r.f.ours.mean),
          ys,
        ),
        espn: meanAbsoluteError(
          list.map((r) => r.espn.mean),
          ys,
        ),
      };
    }
  const n = forecasts.length;
  const sp: Record<string, number | null> = {};
  for (const [pos, list] of byPosition(forecasts)) {
    if (list.length >= minN)
      sp[pos] = spearman(
        list.map((f) => f.ours.mean),
        list.map((f) => f.outcome),
      );
    else {
      sp[pos] = null;
      if (n >= minN) caveats.push(caveat(`spearman_by_position.${pos}`, list.length, minN));
    }
  }
  return {
    projection_vs_espn: {
      crps_ours: gated(nPaired, minN, () => stableMean(paired.map((r) => crpsOurs(r.f)))),
      crps_espn: gated(nPaired, minN, () =>
        stableMean(paired.map((r) => crpsFromDist(r.espn, r.f.outcome))),
      ),
      mae_by_position: mae,
      n_player_weeks: nPaired,
    },
    coverage_80: gated(n, minN, () =>
      intervalCoverage(
        forecasts.map((f) => ({ lo: f.ours.p10, hi: f.ours.p90 })),
        forecasts.map((f) => f.outcome),
      ),
    ),
    spearman_by_position: sp,
    n_ours: n,
    caveats,
  };
}

/** A Brier value at n ≥ min_n, else "n too small (k of min_n)". */
export function brierOrCaveat(
  pairs: readonly ProbabilityOutcome[],
  minN: number,
): number | NTooSmall {
  return pairs.length >= minN && pairs.length > 0
    ? brierScore(pairs)
    : nTooSmall(pairs.length, minN);
}

/** A Brier entry with no ESPN comparator (p_active, p_role_holds, p_k_win). */
export function brierEntry(pairs: readonly ProbabilityOutcome[], minN: number): BrierEntry {
  return { ours: brierOrCaveat(pairs, minN), n: pairs.length };
}

/**
 * A Brier entry with ESPN's number beside ours (p_win, p_playoffs): `ours` over every valid forecast
 * of ours; `espn` over the rows that carry both (paired), null when no row carries ESPN's number.
 */
export function comparatorBrierEntry(
  rows: readonly {
    readonly ours: number;
    readonly espn: number | null;
    readonly outcome: boolean;
  }[],
  minN: number,
): BrierEntry {
  const ours = rows.map((r) => ({ p: r.ours, outcome: r.outcome }));
  const espn = rows.flatMap((r) => (r.espn === null ? [] : [{ p: r.espn, outcome: r.outcome }]));
  return {
    ours: brierOrCaveat(ours, minN),
    espn: espn.length === 0 ? null : brierOrCaveat(espn, minN),
    n: ours.length,
  };
}

/** Weeks until a metric reaches `needed` at its observed rate per window week; null without a rate. */
export function weeksToN(n: number, needed: number, windowWeeks: number): number | null {
  if (n >= needed) return 0;
  if (n <= 0 || windowWeeks <= 0) return null;
  return Math.ceil((needed - n) / (n / windowWeeks));
}

// --- the retrospective's own Rec -------------------------------------------------------------------

/**
 * The retrospective's `rec` (plan 07 E13 `rec: Rec`): always a no-move — v1 reports and never tunes
 * (parameter proposals are P2). point_estimate = mean call regret; the distribution is the empirical
 * spread of the per-call regrets (linear-interpolated quantiles); `as_of` = the newest valid input
 * instant, else the clock; `basis` is `position_cv` because DistBasis has no "empirical" value.
 */
export function retroRec(
  calls: readonly RetrospectiveCall[],
  swapTotal: number,
  inputs: readonly InputFreshness[],
  clock: Clock,
): Rec {
  const regrets = calls.flatMap((c) => (c.regret === null ? [] : [c.regret])).sort((a, b) => a - b);
  const q = (tau: number): number => {
    if (regrets.length === 0) return 0;
    const h = (regrets.length - 1) * tau;
    const lo = Math.floor(h);
    const a = at(regrets, lo);
    const b = at(regrets, Math.min(lo + 1, regrets.length - 1));
    return a + (h - lo) * (b - a);
  };
  const clamp = (x: number): number => Math.max(-1000, Math.min(1000, x));
  const mean = clamp(stableMean(regrets) ?? 0);
  const zero = regrets.filter((r) => r === 0).length;
  let asOf: IsoInstant | null = null;
  for (const i of inputs)
    if (isIsoInstant(i.as_of) && (asOf === null || parseIso(i.as_of) > parseIso(asOf)))
      asOf = i.as_of;
  return {
    action: "Keep the model unchanged: v1 retrospectives report calibration, they do not tune it",
    subjects: [],
    lineup: null,
    point_estimate: mean,
    distribution: {
      mean,
      p10: clamp(q(0.1)),
      p25: clamp(q(0.25)),
      p50: clamp(q(0.5)),
      p75: clamp(q(0.75)),
      p90: clamp(q(0.9)),
      p_zero: regrets.length === 0 ? 0 : zero / regrets.length,
      basis: "position_cv",
    },
    delta_vs_next: { value: 0, p10: 0, p90: 0 },
    decision_metric: "regret",
    drivers: [
      { name: "mean call regret", contribution: mean },
      { name: "swap regret, season to date", contribution: clamp(swapTotal) },
    ],
    assumptions: [
      {
        text: "One week is one draw; a metric under its minimum n supports no conclusion",
        revisit_trigger: "each metric reaching its min_n in sample_size",
      },
      {
        text: "The distribution is the empirical spread of this week's per-call regrets",
        revisit_trigger: "Phase 3 held-out seasons",
      },
    ],
    confidence: { role_games: Math.min(regrets.length, 1000), inputs: inputs.slice(0, 25) },
    as_of: asOf ?? clock.nowIso(),
    latest_execution_time: null,
    no_move: true,
    log_id: null,
  };
}

// --- assembly --------------------------------------------------------------------------------------

/**
 * Call order: by `recorded_at` (the store's canonical `toISOString()` form, so string order is time
 * order), then by `log_id`.
 */
export function compareRecords(a: RecommendationRecord, b: RecommendationRecord): number {
  if (a.recorded_at !== b.recorded_at) return a.recorded_at < b.recorded_at ? -1 : 1;
  if (a.log_id === b.log_id) return 0;
  return a.log_id < b.log_id ? -1 : 1;
}

/** The `sample_size` keys, in report order (plan 10 §2 "which metrics reach n ≥ 30"). */
export const RETRO_METRIC_KEYS = Object.freeze([
  "projection_vs_espn",
  "coverage_80",
  "swap_regret",
  "baselines.last_week_points",
  "baselines.espn_projection_lineup",
  "brier.p_active",
  "brier.p_win",
  "brier.p_playoffs",
  "brier.p_role_holds",
  "brier.p_k_win",
] as const);
export type RetroMetricKey = (typeof RETRO_METRIC_KEYS)[number];

/** Whether the scored week is final and its corrections window open (plan 01 §5.4). */
export function weekStatus(
  games: readonly GameFlags[],
  nowMs: number,
): { readonly final: boolean; readonly corrections_window_open: boolean } {
  const final = games.length > 0 && !isPeriodProvisional(games);
  let last: number | null = null;
  for (const g of games) {
    if (g.kickoff_ms === null || !Number.isFinite(g.kickoff_ms)) {
      last = null;
      break;
    }
    last = last === null ? g.kickoff_ms : Math.max(last, g.kickoff_ms);
  }
  return { final, corrections_window_open: correctionsWindowOpen(last, nowMs) };
}

function isWeek(w: unknown): w is Week {
  return (
    typeof w === "number" &&
    Number.isInteger(w) &&
    w >= RETRO_BOUNDS.week.min &&
    w <= RETRO_BOUNDS.week.max
  );
}

/**
 * Scores a week (plan 07 E13): the week's calls with followed / regret / decisive / realised, the two
 * baselines (relative regret, pooled season-to-date; `espn_projection_lineup.informative` is false
 * while `weight_espn` ≥ 1), projection-vs-ESPN, swap regret, the Brier suite with ESPN's comparators,
 * coverage, Spearman, `sample_size` per metric (n, n_needed = min_n, weeks to reach it) and one caveat
 * per metric under min_n, attribution null and no parameter proposals (P2), plus the outcome rows to
 * persist. Throws RangeError on an invalid week, min_n, weight_espn or kinds filter; bad rows are
 * excluded and counted in `warnings`, never fatal.
 */
export function buildRetrospective(input: RetrospectiveInput, clock: Clock): RetrospectiveResult {
  const { week, min_n: minN, weight_espn: weightEspn } = input;
  if (!isWeek(week)) throw new RangeError("reclog: week must be an integer 1..18");
  if (!Number.isInteger(minN) || minN < RETRO_BOUNDS.minN.min || minN > RETRO_BOUNDS.minN.max)
    throw new RangeError("reclog: min_n must be an integer 1..10000");
  if (typeof weightEspn !== "number" || !(weightEspn >= 0 && weightEspn <= 1))
    throw new RangeError("reclog: weight_espn must be a number in [0, 1]");
  if (
    input.kinds !== null &&
    !input.kinds.every((k) => (RECOMMENDATION_KINDS as readonly string[]).includes(k))
  )
    throw new RangeError("reclog: kinds names an unknown recommendation kind");
  const warnings: string[] = [];
  const warn = (count: number, what: string): void => {
    if (count > 0) warnings.push(`retrospective: ${String(count)} ${what}`);
  };
  const kinds = input.kinds === null ? null : new Set<RecommendationKind>(input.kinds);
  const inWindow = (w: unknown): boolean => isWeek(w) && w <= week;
  const windowWeeks = new Set<Week>();

  // weeks: in the window, one entry per week, each record once and under its own week
  const seenWeeks = new Set<Week>();
  const seenIds = new Set<string>();
  let skippedWeeks = 0;
  let duplicateWeeks = 0;
  let misfiled = 0;
  let duplicateIds = 0;
  const scoredWeeks: { sw: ScoringWeek; records: RecommendationRecord[] }[] = [];
  for (const sw of input.weeks) {
    if (!inWindow(sw.week)) {
      skippedWeeks++;
      continue;
    }
    if (seenWeeks.has(sw.week)) {
      duplicateWeeks++;
      continue;
    }
    seenWeeks.add(sw.week);
    windowWeeks.add(sw.week);
    const records: RecommendationRecord[] = [];
    for (const r of sw.records) {
      if (r.week !== sw.week) {
        misfiled++;
        continue;
      }
      if (seenIds.has(r.log_id)) {
        duplicateIds++;
        continue;
      }
      seenIds.add(r.log_id);
      if (kinds === null || kinds.has(r.kind)) records.push(r);
    }
    scoredWeeks.push({ sw, records: records.sort(compareRecords) });
  }
  warn(skippedWeeks, "weeks outside 1..the scored week skipped");
  warn(duplicateWeeks, "duplicate weeks skipped");
  warn(misfiled, "records filed under another week skipped");
  warn(duplicateIds, "duplicate log ids skipped");

  // score every call of every window week; calls[] are the scored week's
  const pooled: ScoredCall[] = [];
  let calls: RetrospectiveCall[] = [];
  for (const { sw, records } of scoredWeeks) {
    const facts = factIndex(sw.facts);
    const roster = rosterIndex(sw.roster);
    const scored = records.map((r) => scoreCall(r, facts, roster, sw.team_result));
    pooled.push(...scored);
    if (sw.week === week) calls = scored.map((s) => s.call);
  }
  const swaps = pooled.flatMap((s) => s.swaps);
  const lastWeek = pooled.flatMap((s) =>
    s.baseline_last_week === null ? [] : [s.baseline_last_week],
  );
  const espnBase = pooled.flatMap((s) => (s.baseline_espn === null ? [] : [s.baseline_espn]));

  // player forecasts: valid, in the window, one row per (week, player_id)
  const seenPw = new Set<string>();
  let badForecasts = 0;
  let futureForecasts = 0;
  let dupForecasts = 0;
  let badEspn = 0;
  const forecasts: PlayerForecast[] = [];
  for (const f of input.player_forecasts) {
    if (!validForecast(f) || !isWeek(f.week)) {
      badForecasts++;
      continue;
    }
    if (f.week > week) {
      futureForecasts++;
      continue;
    }
    if (typeof f.player_id === "number") {
      const key = `${String(f.week)}:${String(f.player_id)}`;
      if (seenPw.has(key)) {
        dupForecasts++;
        continue;
      }
      seenPw.add(key);
    }
    windowWeeks.add(f.week);
    if (f.espn !== null && !validDist(f.espn)) {
      badEspn++;
      forecasts.push({ ...f, espn: null });
    } else forecasts.push(f);
  }
  warn(
    badForecasts,
    "player forecasts excluded (invalid week, position, dist, samples or outcome)",
  );
  warn(futureForecasts, "player forecasts after the scored week skipped");
  warn(dupForecasts, "duplicate player-week forecasts skipped");
  warn(badEspn, "ESPN projections excluded from the comparison (invalid dist)");
  const proj = projectionMetrics(forecasts, minN);

  // probabilities: valid, in the window
  const probs = input.probabilities;
  const plain = (name: string, rows: readonly WeekProbability[]): ProbabilityOutcome[] => {
    let bad = 0;
    let future = 0;
    const out: ProbabilityOutcome[] = [];
    for (const r of rows) {
      if (!isProbabilityOutcome(r) || !isWeek(r.week)) bad++;
      else if (r.week > week) future++;
      else {
        windowWeeks.add(r.week);
        out.push({ p: r.p, outcome: r.outcome });
      }
    }
    warn(bad, `${name} forecasts excluded (invalid week, probability or outcome)`);
    warn(future, `${name} forecasts after the scored week skipped`);
    return out;
  };
  const isProb = (x: unknown): x is number =>
    typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
  const compared = (
    name: string,
    rows: readonly ComparatorProbability[],
  ): { ours: number; espn: number | null; outcome: boolean }[] => {
    let bad = 0;
    let future = 0;
    let badComparator = 0;
    const out: { ours: number; espn: number | null; outcome: boolean }[] = [];
    for (const r of rows) {
      if (r.ours === null) continue;
      if (!isProb(r.ours) || typeof r.outcome !== "boolean" || !isWeek(r.week)) bad++;
      else if (r.week > week) future++;
      else {
        windowWeeks.add(r.week);
        let espn: number | null = null;
        if (r.espn !== null) {
          if (isProb(r.espn)) espn = r.espn;
          else badComparator++;
        }
        out.push({ ours: r.ours, espn, outcome: r.outcome });
      }
    }
    warn(bad, `${name} forecasts excluded (invalid week, probability or outcome)`);
    warn(future, `${name} forecasts after the scored week skipped`);
    warn(badComparator, `${name} ESPN comparators excluded (not a probability in 0..1)`);
    const withEspn = out.filter((r) => r.espn !== null).length;
    if (withEspn > 0 && withEspn < out.length)
      warnings.push(
        `retrospective: ${name} ESPN comparator present on ${String(withEspn)} of ${String(out.length)} forecasts`,
      );
    return out;
  };
  const pActive = plain("p_active", probs.p_active);
  const pWin = compared("p_win", probs.p_win);
  const pPlayoffs = compared("p_playoffs", probs.p_playoffs);
  const pRole = plain("p_role_holds", probs.p_role_holds);
  const pK = plain("p_k_win", probs.p_k_win);

  // sample sizes and caveats
  const ns: Record<RetroMetricKey, number> = {
    projection_vs_espn: proj.projection_vs_espn.n_player_weeks,
    coverage_80: proj.n_ours,
    swap_regret: swaps.length,
    "baselines.last_week_points": lastWeek.length,
    "baselines.espn_projection_lineup": espnBase.length,
    "brier.p_active": pActive.length,
    "brier.p_win": pWin.length,
    "brier.p_playoffs": pPlayoffs.length,
    "brier.p_role_holds": pRole.length,
    "brier.p_k_win": pK.length,
  };
  const sampleSize: Record<
    string,
    { readonly n: number; readonly n_needed: number; readonly weeks_to_n30_estimate: number | null }
  > = {};
  const caveats: string[] = [];
  for (const k of RETRO_METRIC_KEYS) {
    sampleSize[k] = {
      n: ns[k],
      n_needed: minN,
      weeks_to_n30_estimate: weeksToN(ns[k], minN, windowWeeks.size),
    };
    if (ns[k] < minN) caveats.push(caveat(k, ns[k], minN));
  }
  caveats.push(...proj.caveats);

  const { final, corrections_window_open } = weekStatus(input.games, clock.nowMs());
  const swapTotal = stableSum(swaps);
  const data: RetrospectiveData = {
    week,
    final,
    corrections_window_open,
    calls,
    baselines: {
      last_week_points: {
        regret: gated(lastWeek.length, minN, () => stableSum(lastWeek) / lastWeek.length),
      },
      espn_projection_lineup: {
        regret: gated(espnBase.length, minN, () => stableSum(espnBase) / espnBase.length),
        informative: weightEspn < WEIGHT_ESPN_V1,
      },
    },
    metrics: {
      projection_vs_espn: proj.projection_vs_espn,
      swap_regret: {
        mean: gated(swaps.length, minN, () => swapTotal / swaps.length),
        n: swaps.length,
      },
      brier: {
        p_active: brierEntry(pActive, minN),
        p_win: comparatorBrierEntry(pWin, minN),
        p_playoffs: comparatorBrierEntry(pPlayoffs, minN),
        p_role_holds: brierEntry(pRole, minN),
        p_k_win: brierEntry(pK, minN),
      },
      coverage_80: proj.coverage_80,
      spearman_by_position: proj.spearman_by_position,
    },
    sample_size: sampleSize,
    attribution: null,
    parameter_changes_proposed: [],
    sample_size_caveats: caveats,
    rec: retroRec(calls, swapTotal, input.inputs, clock),
    inputs: [...input.inputs],
  };
  const scoredAt = clock.nowIso();
  return {
    data,
    provisional: !final,
    outcomes: calls.map((c) => outcomeOf(c, scoredAt, final)),
    warnings,
  };
}

/** E13's default `min_n` (re-exported for the tool). */
export { DEFAULT_MIN_N, MAX_ABS_VALUE };
