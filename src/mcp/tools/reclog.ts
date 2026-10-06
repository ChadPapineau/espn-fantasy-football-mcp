// reclog.ts — E12 espn_record_recommendation (plan 07 E12: the recommendation-log write; the league
// id and season are filled by the tool from config, never supplied — plan 02 §5; a local-store
// write, idempotent on `client_ref` — T-04; never pruned) and E13 espn_analyze_retrospective (plan
// 07 E13: last week's calls scored by regret and proper scoring rules against two baselines and
// ESPN's own numbers, "n too small" until min_n; the outcome rows are persisted beside the immutable
// log). Read-back text is model-authored and untrusted (C15): sanitised and path-listed with source
// `store.recommendation_log` on every read. Also the espn-ff://rec/* resource payloads.
import { z } from "zod/v4";
import { SHIPPED_WEIGHT_ESPN } from "../../domain/analytics/index.js";
import { seededRng } from "../../domain/clock.js";
import { weekGameState } from "../../domain/league/schedule.js";
import type { BoxScoreMatchup, Week } from "../../domain/league/types.js";
import { RecordValidationError, buildRecord } from "../../domain/reclog/record.js";
import {
  buildRetrospective,
  readBackView,
  toListItem,
  type PlayerWeekFact,
  type RosterPresence,
  type ScoringWeek,
} from "../../domain/reclog/retrospective.js";
import {
  RECLOG_TEXT_PATHS,
  RECLOG_UNTRUSTED_SOURCE,
  RECOMMENDATION_KINDS,
  type RecommendationRecord,
  type RecommendationRecordView,
  type RecordResult,
  type RetrospectiveData,
} from "../../domain/reclog/types.js";
import { kickoffMsOf } from "../../domain/league/schedule.js";
import {
  BOUNDS,
  analyticsFreshnessShape,
  limitSchema,
  offsetSchema,
  recommendationKindsSchema,
  recordRecommendationInputSchema,
  weekSchema,
} from "../bounds.js";
import { toDataInputs, type InputStamp, type UntrustedField } from "../envelope.js";
import { EffError } from "../errors.js";
import { defineTool, recentCall, type ToolContext } from "../define.js";
import {
  leagueOf,
  leagueRef,
  readOpts,
  scheduleOf,
  take,
  teamOf,
  weekOf,
  withinBudget,
} from "./common.js";
import {
  count,
  inputs as inputsSchema,
  iso,
  logId,
  probNull,
  rec,
  recLogText,
  serverText,
  week,
} from "./schemas.js";

/** The provenance tag of read-back log text (plan 07 C15). */
export const REC_SOURCE = RECLOG_UNTRUSTED_SOURCE;

// --- E12 espn_record_recommendation ----------------------------------------------------------------

/** E12 data (plan 07 E12; RecordResult). */
export const recordResultSchema = z.strictObject({
  log_id: logId,
  recorded_at: iso,
  week,
  kind: z.string().regex(/^[a-z]{1,16}$/),
  deduplicated: z.boolean(),
});

/** E12 `espn_record_recommendation`. */
export const recordRecommendation = defineTool({
  name: "espn_record_recommendation",
  description:
    "Log the recommendation just presented (rec, alternatives shown, source request_ids) so the retrospective can score it. Idempotent on client_ref.",
  input: recordRecommendationInputSchema,
  data: recordResultSchema,
  budget: "list",
  wire: "outline",
  opaqueInput: {
    rec: "data.rec of the analytics result presented, copied verbatim (log_id null)",
    alternatives:
      "the options shown: [{action, subjects, point_estimate, distribution, decision_metric_value}] (<=10)",
  },
  run: (args, ctx) => {
    for (const sc of args.source_calls) {
      const known = recentCall(ctx.services, sc.request_id);
      if (known === null) continue;
      if (known.tool !== sc.tool)
        throw new EffError("VALIDATION", {
          field: "source_calls",
          reason: "source_call_tool_mismatch",
        });
      // an onboarding record is a no-move session note whose scoring self-check cites the last
      // final week's box score (skills/onboard), so only decision records are held to their week
      if (known.week !== null && known.week !== args.week && args.kind !== "onboarding")
        throw new EffError("VALIDATION", {
          field: "source_calls",
          reason: "source_call_week_mismatch",
        });
    }
    const ref = leagueRef(ctx);
    let record: RecommendationRecord;
    try {
      record = buildRecord(
        {
          league_id: ref.league_id,
          season: ref.season,
          kind: args.kind,
          week: args.week,
          rec: args.rec,
          alternatives: args.alternatives,
          source_calls: args.source_calls,
          settings_hash: args.settings_hash,
          seeding_mode_used: args.seeding_mode_used ?? null,
          followed_hint: args.followed_hint,
          client_ref: args.client_ref ?? null,
          note: args.note ?? null,
        },
        { clock: ctx.services.clock, rng: seededRng(ctx.nowMs % 2147483647) },
      );
    } catch (e) {
      if (e instanceof RecordValidationError) {
        const first = e.issues[0];
        const reason =
          first !== undefined && /^[a-z_]{1,40}$/.test(first.code) ? first.code : "invalid";
        throw new EffError("VALIDATION", { field: "rec", reason });
      }
      throw e;
    }
    const { log_id: _minted, recorded_at: at, ...input } = record;
    const r: RecordResult = ctx.services.recommendationLog.record(input, at);
    return Promise.resolve({
      data: r,
      inputs: [],
      extraSources: ["store:recommendation_log"],
      week: args.week,
    });
  },
});

// --- E13 espn_analyze_retrospective ----------------------------------------------------------------

const brierEntrySchema = z.strictObject({
  ours: z.union([z.number(), z.string().regex(/^n too small \(\d+ of \d+\)$/)]).nullable(),
  espn: z
    .union([z.number(), z.string().regex(/^n too small \(\d+ of \d+\)$/)])
    .nullable()
    .optional(),
  n: count,
});

/** E13 data (plan 07 E13; RetrospectiveData). */
export const retrospectiveSchema = z.strictObject({
  week,
  final: z.boolean(),
  corrections_window_open: z.boolean(),
  calls: z
    .array(
      z.strictObject({
        log_id: logId,
        kind: z.string().regex(/^[a-z]{1,16}$/),
        followed: z.boolean().nullable(),
        regret: z.number().nullable(),
        decisive: z.boolean().nullable(),
        recommended: recLogText,
        best_alternative: recLogText.nullable(),
        realised: z.number().nullable(),
      }),
    )
    .max(200),
  baselines: z.strictObject({
    last_week_points: z.strictObject({ regret: z.number().nullable() }),
    espn_projection_lineup: z.strictObject({
      regret: z.number().nullable(),
      informative: z.boolean(),
    }),
  }),
  metrics: z.strictObject({
    projection_vs_espn: z.strictObject({
      crps_ours: z.number().nullable(),
      crps_espn: z.number().nullable(),
      mae_by_position: z.record(
        z.string().regex(/^[A-Z][A-Za-z/]{0,9}$/),
        z.strictObject({ ours: z.number(), espn: z.number() }),
      ),
      n_player_weeks: count,
    }),
    swap_regret: z.strictObject({ mean: z.number().nullable(), n: count }),
    brier: z.strictObject({
      p_active: brierEntrySchema,
      p_win: brierEntrySchema,
      p_playoffs: brierEntrySchema,
      p_role_holds: brierEntrySchema,
      p_k_win: brierEntrySchema,
    }),
    coverage_80: probNull,
    spearman_by_position: z.record(
      z.string().regex(/^[A-Z][A-Za-z/]{0,9}$/),
      z.number().nullable(),
    ),
  }),
  sample_size: z.record(
    z.string().regex(/^[a-z][a-z0-9_.]{0,47}$/),
    z.strictObject({ n: count, n_needed: count, weeks_to_n30_estimate: count.nullable() }),
  ),
  attribution: z.record(z.string().max(40), z.number()).nullable(),
  parameter_changes_proposed: z
    .array(
      z.strictObject({
        parameter: z.string().max(40),
        current: z.number(),
        proposed: z.number(),
        evidence_n: count,
      }),
    )
    .max(10),
  sample_size_caveats: z.array(serverText).max(30),
  rec,
  inputs: inputsSchema,
});

/** The facts and my roster presence of one week from its box scores. */
function factsOf(
  boxes: readonly BoxScoreMatchup[],
  team: number,
  lastWeek: ReadonlyMap<number, number | null>,
  gsisOf: (id: number) => string | null,
): {
  facts: PlayerWeekFact[];
  roster: RosterPresence[] | null;
  result: ScoringWeek["team_result"];
} {
  const facts: PlayerWeekFact[] = [];
  let roster: RosterPresence[] | null = null;
  let result: ScoringWeek["team_result"] = null;
  for (const m of boxes) {
    for (const side of [m.home, m.away]) {
      if (side === null) continue;
      for (const e of side.entries)
        facts.push({
          player_id: e.player.ref.id,
          gsis_id: gsisOf(e.player.ref.id),
          points: e.actual?.applied_total ?? null,
          last_week_points: lastWeek.get(e.player.ref.id) ?? null,
          espn_projection: e.projected?.applied_total ?? null,
        });
      if (side.team_id === team) {
        roster = side.entries.map((e) => ({
          player_id: e.player.ref.id,
          gsis_id: gsisOf(e.player.ref.id),
          slot_class: e.slot_class,
        }));
        const other = side === m.home ? m.away : m.home;
        if (side.total_points !== null && other !== null && other.total_points !== null)
          result = { my_points: side.total_points, opponent_points: other.total_points };
      }
    }
  }
  return { facts, roster, result };
}

/** The last week whose games are all final (by the schedule), before or at the current one. */
async function lastFinalWeek(
  ctx: ToolContext,
  season: number,
  current: Week,
  inputs: InputStamp[],
  warnings: string[],
): Promise<Week> {
  const sched = await withinBudget(() => scheduleOf(ctx, season, inputs), warnings).catch(
    () => null,
  );
  if (sched !== null)
    for (let w = Math.min(current, BOUNDS.week.max); w >= 1; w--)
      if (weekGameState(sched.schedule, w, ctx.nowMs).final) return w;
  return Math.max(1, current - 1);
}

/** E13 `espn_analyze_retrospective`. */
export const analyzeRetrospective = defineTool({
  name: "espn_analyze_retrospective",
  description:
    "Score a week's logged calls (default: last final week) by regret and proper scoring rules vs two baselines and ESPN's numbers; never applies changes.",
  input: z.strictObject({
    week: weekSchema.optional(),
    kinds: recommendationKindsSchema.optional(),
    min_n: z.number().int().min(BOUNDS.minN.min).max(BOUNDS.minN.max).default(BOUNDS.minN.default),
    ...analyticsFreshnessShape,
  }),
  data: retrospectiveSchema,
  budget: "analytics",
  run: async (args, ctx) => {
    const inputs: InputStamp[] = [];
    const warnings: string[] = [];
    const league = await leagueOf(ctx, inputs);
    const season = league.ref.season;
    const team = teamOf(league, undefined);
    const w =
      args.week ?? (await lastFinalWeek(ctx, season, weekOf(league, undefined), inputs, warnings));
    const ref = leagueRef(ctx);
    const gsisOf = (id: number): string | null => {
      try {
        const pair = ctx.services.crosswalk.get(id);
        return pair?.espn_id === id ? pair.gsis_id : null;
      } catch {
        return null;
      }
    };
    const box = await ctx.services.platform.getBoxScores(ref, w, readOpts(ctx, args));
    const boxes = take(ctx, box, inputs);
    const prev = new Map<number, number | null>();
    if (w > 1) {
      const pGot = await withinBudget(
        () => ctx.services.platform.getBoxScores(ref, w - 1, readOpts(ctx, args)),
        warnings,
      ).catch(() => null);
      if (pGot === null)
        warnings.push("last week's box scores unavailable: the last-week baseline is unknown");
      for (const m of pGot === null ? [] : take(ctx, pGot, inputs))
        for (const side of [m.home, m.away])
          for (const e of side?.entries ?? [])
            prev.set(e.player.ref.id, e.actual?.applied_total ?? null);
    }
    const scored = factsOf(boxes, team, prev, gsisOf);
    const weeks: ScoringWeek[] = [];
    for (let x = 1; x <= w; x++) {
      const records = ctx.services.recommendationLog.forWeek(ref.league_id, season, x);
      if (x === w)
        weeks.push({
          week: x,
          records,
          facts: scored.facts,
          roster: scored.roster,
          team_result: scored.result,
        });
      else if (records.length > 0)
        weeks.push({ week: x, records, facts: [], roster: null, team_result: null });
    }
    const sched = await withinBudget(() => scheduleOf(ctx, season, inputs), warnings).catch(
      () => null,
    );
    const games = (sched?.schedule.games ?? [])
      .filter((g) => g.week === w)
      .map((g) => ({
        kickoff_ms: kickoffMsOf(g),
        valid_for_locking: g.valid_for_locking,
        stats_official: g.stats_official,
      }));
    const r = buildRetrospective(
      {
        week: w,
        games,
        kinds: args.kinds ?? null,
        weeks,
        player_forecasts: [],
        probabilities: { p_active: [], p_win: [], p_playoffs: [], p_role_holds: [], p_k_win: [] },
        weight_espn: SHIPPED_WEIGHT_ESPN,
        min_n: args.min_n,
        inputs: toDataInputs(inputs, ctx.nowMs),
      },
      ctx.services.clock,
    );
    for (const o of r.outcomes) {
      try {
        ctx.services.recommendationLog.recordOutcome(o);
      } catch {
        warnings.push("an outcome row could not be persisted (the store was busy)");
      }
    }
    const data: RetrospectiveData = r.data;
    return {
      data,
      inputs,
      warnings: [...warnings, ...r.warnings],
      estimate: true,
      provisional: r.provisional,
      correctionsWindowOpen: data.corrections_window_open,
      extraSources: ["store:recommendation_log"],
      listKey: "calls",
      week: w,
    };
  },
});

// --- espn-ff://rec/* payloads (plan 07 §4.1; C15) ----------------------------------------------------

/** The RECLOG_TEXT_PATHS of a record view as `meta.untrusted_fields` entries under `prefix`. */
export function recordTextFields(prefix: string): UntrustedField[] {
  return RECLOG_TEXT_PATHS.map((p) => ({ path: `${prefix}.${p}`, source: REC_SOURCE }));
}

/** One record as the espn-ff://rec/{log_id} resource shows it: no league_id, text sanitised. */
export function recordView(r: RecommendationRecord): RecommendationRecordView {
  return readBackView(r);
}

/** espn-ff://rec/week/{week}: the configured league's current-season entries of one week. */
export function recWeekItems(ctx: ToolContext, w: Week) {
  const ref = leagueRef(ctx);
  return ctx.services.recommendationLog
    .forWeek(ref.league_id, ref.season, w)
    .map((r) => toListItem(r, ctx.services.recommendationLog.outcome(r.log_id)));
}

// --- E14 espn_list_recommendations -----------------------------------------------------------------

/** E14 data (plan 07 E14): the log's summary rows, newest first; free text under C15. */
export const recommendationListSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        log_id: logId,
        kind: z.enum(RECOMMENDATION_KINDS),
        week,
        recorded_at: iso,
        action_summary: recLogText,
        followed: z.boolean().nullable(),
      }),
    )
    .max(BOUNDS.limit.max),
});

/** E14 `espn_list_recommendations` (P1; the tool twin of espn-ff://rec/*). */
export const listRecommendations = defineTool({
  name: "espn_list_recommendations",
  description:
    "Browse the recommendation log (this league, this season), newest first: kind, week, a summary and whether it was followed.",
  input: z.strictObject({
    week: z.number().int().min(0).max(BOUNDS.week.max).optional(),
    kind: z.enum(RECOMMENDATION_KINDS).optional(),
    limit: limitSchema,
    offset: offsetSchema,
  }),
  data: recommendationListSchema,
  budget: "list",
  pageable: true,
  run: (args, ctx) => {
    const ref = leagueRef(ctx);
    const page = ctx.services.recommendationLog.list({
      league_id: ref.league_id,
      season: ref.season,
      week: args.week ?? null,
      kind: args.kind ?? null,
      limit: args.limit,
      offset: args.offset,
    });
    const items = page.items.slice(0, args.limit);
    return Promise.resolve({
      data: { items },
      inputs: [],
      extraSources: ["store:recommendation_log"],
      bareFields: [{ path: "data.items[].action_summary", source: REC_SOURCE }],
      page: {
        limit: args.limit,
        offset: args.offset,
        count: items.length,
        total: page.total,
        has_more: args.offset + items.length < page.total,
        next_offset: args.offset + items.length < page.total ? args.offset + items.length : null,
      },
      listKey: "items",
      ...(args.week === undefined || args.week === 0 ? {} : { week: args.week }),
    });
  },
});
