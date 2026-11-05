// reclog.ts — E12 espn_record_recommendation (plan 07 E12: the recommendation-log write; the league
// id and season are filled by the tool from config, never supplied — plan 02 §5; a local-store
// write, idempotent on `client_ref` — T-04; never pruned) and E13 espn_analyze_retrospective (plan
// 07 E13: last week's calls scored by regret and proper scoring rules against two baselines and
// ESPN's own numbers, "n too small" until min_n; the outcome rows are persisted beside the immutable
// log). Read-back text is model-authored and untrusted (C15): sanitised and path-listed with source
// `store.recommendation_log` on every read. Also the espn-ff://rec/* resource payloads. Phase 3 (plan
// 10 C8, C9 — retro-p3.ts): attribution over the stored v2 projections, the proposal set persisted
// for a human-run `eff tune` (never applied here), and E10's logged claims scored once final.
import { z } from "zod/v4";
import { SHIPPED_WEIGHT_ESPN } from "../../domain/analytics/index.js";
import { seededRng } from "../../domain/clock.js";
import { weekGameState } from "../../domain/league/schedule.js";
import type { BoxScoreMatchup, Week } from "../../domain/league/types.js";
import { ATTRIBUTION_KEY_RE } from "../../domain/reclog/attribution.js";
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
  OUTCOMES_PER_WRITE_MAX,
  RECLOG_TEXT_PATHS,
  RECLOG_UNTRUSTED_SOURCE,
  RECOMMENDATION_KINDS,
  RECOMMENDATION_LIST_TEXT_PATHS,
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
import {
  TRUNCATION_HINTS,
  toDataInputs,
  type InputStamp,
  type UntrustedField,
} from "../envelope.js";
import { EffError } from "../errors.js";
import { beforeSideEffect, defineTool, recentCall, type ToolContext } from "../define.js";
import {
  isOptionalReadFailure,
  leagueOf,
  leagueRef,
  readOpts,
  scheduleOf,
  sessionRefusalOf,
  settingsOf,
  take,
  teamOf,
  turn,
  weekOf,
  withinBudget,
} from "./common.js";
import { attributionRows, retroForecasts, scoreClaims, tunedDocOf } from "./retro-p3.js";
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

/**
 * What E13's optional reads absorb (the round-4d product account): an optional read's failure — an
 * outage, a session refusal (said by the call's session line; refusals.ts) or fixture mode's
 * `fixture_missing` (isOptionalReadFailure) — or a dataset past its hard limit (STALE_ONLY: the
 * schedule read here takes no `allow_stale`, so the call degrades as before). Anything else is a
 * bug and propagates, as every other tool's optional reads do; before, every error read as null.
 */
export function retroReadAbsorbed(e: unknown): null {
  if (isOptionalReadFailure(e) || (e as { effCode?: unknown } | null)?.effCode === "STALE_ONLY")
    return null;
  throw e;
}

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
    beforeSideEffect(ctx);
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
        // the logged entry's note (changelog §R10, R10-13, superseding E13's `calls[]` fields): null
        // when none was logged, else read back within the log's own text cap and path-listed
        // `data.calls[].note` with source `store.recommendation_log` (the schema's bare-text mark)
        note: recLogText.nullable(),
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
    retroReadAbsorbed,
  );
  if (sched !== null)
    for (let w = Math.min(current, BOUNDS.week.max); w >= 1; w--)
      if (weekGameState(sched.schedule, w, ctx.nowMs).final) return w;
  return Math.max(1, current - 1);
}

/** The kind a call row counts under in E13's truncation detail: its own when one of ours, else `other`. */
function kindOfCall(c: unknown): string {
  const k = typeof c === "object" && c !== null ? (c as { kind?: unknown }).kind : undefined;
  return typeof k === "string" && (RECOMMENDATION_KINDS as readonly string[]).includes(k)
    ? k
    : "other";
}

/**
 * E13's truncation detail (changelog §R10, R10-25, extending R10-20): the calls kept and the calls
 * in the week, per kind, in RECOMMENDATION_KINDS order — counts and kind names only, a fixed text —
 * so retro can tell whether narrowing by `kinds` can help (a week whose calls are all one kind
 * cannot narrow further). Null for an empty list.
 */
export function callsByKind(kept: readonly unknown[], all: readonly unknown[]): string | null {
  const count = (list: readonly unknown[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const c of list) {
      const k = kindOfCall(c);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const total = count(all);
  const have = count(kept);
  const parts = [...RECOMMENDATION_KINDS, "other"]
    .filter((k) => total.has(k))
    .map((k) => `${k} ${String(have.get(k) ?? 0)} of ${String(total.get(k) ?? 0)}`);
  return parts.length === 0 ? null : `calls kept by kind: ${parts.join(", ")}`;
}

/** E13 `espn_analyze_retrospective`. */
export const analyzeRetrospective = defineTool({
  name: "espn_analyze_retrospective",
  description:
    "Score a week's logged calls (default: last final week), each with its note, by regret and proper scoring rules vs two baselines and ESPN's numbers; never applies changes.",
  input: z.strictObject({
    week: weekSchema.optional(),
    kinds: recommendationKindsSchema.optional(),
    min_n: z.number().int().min(BOUNDS.minN.min).max(BOUNDS.minN.max).default(BOUNDS.minN.default),
    ...analyticsFreshnessShape,
  }),
  data: retrospectiveSchema,
  budget: "analytics",
  // plan 07 C8's 10 000 characters are the contract and halving its floor (changelog §R10, R10-20):
  // the retrospective is the record the owner audits, so it keeps the longest prefix of whole
  // calls[] that fits, in its own order, after any trims — at the log's bound, halving kept a few
  // of 100 calls in 7 927 characters while more whole calls would fit. E13 does not page, so the
  // truncation warning names its narrowing input (`kinds`)
  fit: "most",
  hint: TRUNCATION_HINTS.retrospective,
  // the warning also counts the calls kept and in the week per kind (R10-25)
  fitDetail: callsByKind,
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
      const prevRead = { refused: false };
      const pGot = await withinBudget(
        () => ctx.services.platform.getBoxScores(ref, w - 1, readOpts(ctx, args)),
        warnings,
      ).catch((e: unknown) => {
        prevRead.refused = sessionRefusalOf(e) !== null;
        return retroReadAbsorbed(e);
      });
      // a session refusal is said by the call's session line (ESPN's box scores were not read, why,
      // `eff setup`; partial), never as unavailable (refusals.ts; the round-4c product account)
      if (pGot === null && !prevRead.refused)
        warnings.push("last week's box scores unavailable: the last-week baseline is unknown");
      for (const m of pGot === null ? [] : take(ctx, pGot, inputs))
        for (const side of [m.home, m.away])
          for (const e of side?.entries ?? [])
            prev.set(e.player.ref.id, e.actual?.applied_total ?? null);
    }
    const scored = factsOf(boxes, team, prev, gsisOf);
    // the log is read the paced way (Stage C finding reclog-retrospective-unbounded-read; plan 03
    // §1.2): an earlier week is scored with no facts, so its calls contribute only that the week is
    // in the window — which weekCounts answers from the index without reading a record — and the
    // scored week is read in bounded pages through the turn gate. Read whole, weeks 1..w took one
    // synchronous statement and parse each, in one turn, growing with the never-pruned log
    const log = ctx.services.recommendationLog;
    const weeks: ScoringWeek[] = [];
    for (const c of log.weekCounts(ref.league_id, season))
      if (c.week < w && c.n > 0)
        weeks.push({ week: c.week, records: [], facts: [], roster: null, team_result: null });
    weeks.push({
      week: w,
      records: await log.forWeekPaced(ref.league_id, season, w, turn),
      facts: scored.facts,
      roster: scored.roster,
      team_result: scored.result,
    });
    const sched = await withinBudget(() => scheduleOf(ctx, season, inputs), warnings).catch(
      retroReadAbsorbed,
    );
    // Phase 3 (plan 10 C9): the attribution rows of the re-fit window — v2 projections stored before
    // their game joined to the final box scores — and the applied overrides; ESPN's box scores of
    // earlier weeks are cached reads (final weeks), each within the call's budget
    const settings = await withinBudget(() => settingsOf(ctx, inputs), warnings).catch(
      retroReadAbsorbed,
    );
    const boxCache = new Map<Week, readonly BoxScoreMatchup[] | null>([[w, boxes]]);
    // the weeks whose box scores the session refused: not "unavailable" — the call's session line
    // says them (refusals.ts; the round-4c product account: an uncached mBoxscore's 401 read as
    // "1 week(s) of box scores unavailable", partial false, the rejection hidden)
    const refusedWeeks = new Set<Week>();
    const boxesOf = async (x: Week): Promise<readonly BoxScoreMatchup[] | null> => {
      if (boxCache.has(x)) return boxCache.get(x) ?? null;
      const got = await withinBudget(
        () => ctx.services.platform.getBoxScores(ref, x, readOpts(ctx, args)),
        warnings,
      ).catch((e: unknown) => {
        if (sessionRefusalOf(e) !== null) refusedWeeks.add(x);
        return retroReadAbsorbed(e);
      });
      const v = got === null ? null : take(ctx, got, inputs);
      boxCache.set(x, v);
      return v;
    };
    const attrRows =
      settings === null
        ? []
        : await attributionRows(
            ctx,
            season,
            w,
            boxesOf,
            sched?.schedule ?? null,
            inputs,
            warnings,
            refusedWeeks,
          );
    // the forecasts the tools served before lock, against what happened (Stage C finding
    // reclog-retro-forecasts-never-scored): the projections (CRPS, coverage vs ESPN), P(active),
    // and P(win) of the lineups as played beside ESPN's pre-week number
    const forecasts =
      settings === null
        ? null
        : await retroForecasts(
            ctx,
            season,
            w,
            team,
            boxesOf,
            sched?.schedule ?? null,
            settings,
            warnings,
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
        player_forecasts: forecasts?.player_forecasts ?? [],
        probabilities: {
          p_active: forecasts?.p_active ?? [],
          p_win: forecasts?.p_win ?? [],
          p_playoffs: [],
          p_role_holds: [],
          p_k_win: [],
        },
        weight_espn: SHIPPED_WEIGHT_ESPN,
        min_n: args.min_n,
        inputs: toDataInputs(inputs, ctx.nowMs),
        attribution:
          settings === null
            ? null
            : { rows: attrRows, scoring: settings, tuned: tunedDocOf(ctx), season },
      },
      ctx.services.clock,
    );
    // the proposal set (final weeks only) is persisted for a human-run `eff tune` — never applied
    // here (plan 10 C9; plan 07 E13 "propose, never apply")
    if (r.proposal_set !== null && ctx.services.parameterProposals !== undefined) {
      beforeSideEffect(ctx);
      try {
        ctx.services.parameterProposals.put(ref.league_id, r.proposal_set);
      } catch {
        warnings.push("the parameter proposal set could not be stored (the store was busy)");
      }
    }
    // E10's logged news claims whose game is final are scored into the calibration table (C8)
    if (!r.provisional) await scoreClaims(ctx, season, w, boxes, gsisOf);
    // a scored week's outcomes in one transaction per OUTCOMES_PER_WRITE_MAX (a week's calls at
    // the per-week cap fit one): all or none, never a row per statement
    for (let i = 0; i < r.outcomes.length; i += OUTCOMES_PER_WRITE_MAX) {
      try {
        log.recordOutcomes(r.outcomes.slice(i, i + OUTCOMES_PER_WRITE_MAX));
      } catch {
        warnings.push("the week's outcome rows could not be persisted (the store was busy)");
      }
    }
    // the attribution map's keys are server-composed (ATTRIBUTION_KEY_RE); anything else is dropped
    const attr = r.data.attribution;
    const data: RetrospectiveData =
      attr === null
        ? r.data
        : {
            ...r.data,
            attribution: Object.fromEntries(
              Object.entries(attr).filter(([k]) => ATTRIBUTION_KEY_RE.test(k)),
            ),
          };
    return {
      data,
      inputs,
      warnings: [...warnings, ...r.warnings],
      estimate: true,
      provisional: r.provisional,
      correctionsWindowOpen: data.corrections_window_open,
      extraSources: [
        "store:recommendation_log",
        ...(forecasts !== null && forecasts.player_forecasts.length > 0
          ? ["store:projection"]
          : []),
        ...(forecasts?.snapshot_used === true ? ["store:scoreboard_snapshot"] : []),
      ],
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

/**
 * The E14 item text paths (RECOMMENDATION_LIST_TEXT_PATHS: the summary and, since changelog §R10,
 * R10-1, the note) as `meta.untrusted_fields` entries — the tool and its espn-ff://rec/week twin.
 */
export function recListTextFields(): UntrustedField[] {
  return RECOMMENDATION_LIST_TEXT_PATHS.map((p) => ({ path: `data.${p}`, source: REC_SOURCE }));
}

/** espn-ff://rec/week/{week}: the configured league's current-season entries of one week. */
export function recWeekItems(ctx: ToolContext, w: Week) {
  const ref = leagueRef(ctx);
  return ctx.services.recommendationLog
    .forWeek(ref.league_id, ref.season, w)
    .map((r) => toListItem(r, ctx.services.recommendationLog.outcome(r.log_id)));
}

// --- E14 espn_list_recommendations -----------------------------------------------------------------

/**
 * E14 data (plan 07 E14): the log's summary rows, newest first; free text under C15. Each item
 * carries the entry's `note` (changelog §R10, R10-1, superseding E14's item fields): null when none
 * was logged, else read back within the log's own text cap (TEXT_CAPS.rec_log_text, as
 * `action_summary`) and path-listed `data.items[].note` with source `store.recommendation_log`.
 */
export const recommendationListSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        log_id: logId,
        kind: z.enum(RECOMMENDATION_KINDS),
        week,
        recorded_at: iso,
        action_summary: recLogText,
        note: recLogText.nullable(),
        followed: z.boolean().nullable(),
      }),
    )
    .max(BOUNDS.limit.max),
});

/** E14 `espn_list_recommendations` (P1; the tool twin of espn-ff://rec/*). */
export const listRecommendations = defineTool({
  name: "espn_list_recommendations",
  description:
    "Browse the recommendation log (this league, this season), newest first: kind, week, a summary, its note and whether it was followed.",
  input: z.strictObject({
    week: z.number().int().min(0).max(BOUNDS.week.max).optional(),
    kind: z.enum(RECOMMENDATION_KINDS).optional(),
    limit: limitSchema,
    offset: offsetSchema,
  }),
  data: recommendationListSchema,
  budget: "list",
  pageable: true,
  // a page over the budget keeps the most whole items that fit, not half (define.ts `fit`): with
  // every summary and note at the log's 200-char bound (the worst JSON escaping) a 25-item page is
  // over 20 000 chars, and halving kept 12 of 25 where 20 fit; `next_offset` pages on from where it
  // stopped either way
  fit: "most",
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
      bareFields: recListTextFields(),
      page: {
        limit: args.limit,
        offset: args.offset,
        count: items.length,
        total: page.total,
        has_more: args.offset + items.length < page.total,
        next_offset: args.offset + items.length < page.total ? args.offset + items.length : null,
      },
      // a read of the log is about no decision week: a record citing it is never held to a week
      listKey: "items",
    });
  },
});
