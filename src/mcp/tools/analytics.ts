// analytics.ts — the P0 decision engines as tools (plan 07 §3.E): E1 espn_project_players (v1-ensemble:
// ESPN's mean is the point estimate, weight_espn = 1.0 — ADV OBJ-02; the trailing nflverse line
// scored under the league's S shapes the distribution), E2 espn_analyze_lineup (assignment under the
// objective the seeding reading implies; the PF exchange rate from the seeding simulator when its
// inputs are cached, else the cold start), E5 espn_analyze_waivers (priority premium Π(k, W) with
// its band and `marginal`, the K/D-ST slice). The tools only assemble inputs; the engines in
// src/domain/analytics are pure. Results are capped at 10 000 chars (C8), `meta.estimate: true`,
// a deadline-stopped sampler returns `partial: true` and is never cached. The samplers' CPU deadline
// is ANALYTICS_CPU_DEADLINE_MS unless the server options carry the test-only switch (cpuDeadlineMs:
// null = off, plan 10 A8a; changelog R5). compare pairs E2 skips are named in warnings (R5).
import { z } from "zod/v4";
import {
  analyzeLineup,
  analyzeWaivers,
  compareWarnings,
  lineupPlayerOf,
  pfContextOf,
  projectPlayers,
  simulateSeason,
  targetOf,
  weeklyValues,
  type ImpliedTotal,
  type LineupPlayer,
  type LineupSeasonContext,
  type PlayedGame,
  type ProjectedPlayer,
  type ProjectionOutcome,
  type ScheduledGame,
  type SeasonTeam,
  type TrailingLine,
  type WaiverCandidateInput,
  type WaiverPlayer,
} from "../../domain/analytics/index.js";
import { seededRng, seedFrom } from "../../domain/clock.js";
import { teamOfProTeamId } from "../../domain/crosswalk/teams.js";
import { remainingWeeks, regularSeasonWeeks } from "../../domain/league/rules.js";
import { auditIr, seatsOf } from "../../domain/league/roster.js";
import { lockPlan } from "../../domain/league/schedule.js";
import {
  TRANSACTIONS_RANGE_MAX,
  type League,
  type LeagueRules,
  type Matchup,
  type PlatformPlayer,
  type ProSchedule,
  type Roster,
  type RosterEntry,
  type RosterSlots,
  type Standings,
  type Transaction,
  type TransactionsSeenRepository,
  type Week,
} from "../../domain/league/types.js";
import type { ScoringSettings } from "../../domain/scoring/types.js";
import type { NflTeam } from "../../config/schema.js";
import {
  ANALYTICS_CPU_DEADLINE_MS,
  BOUNDS,
  analyticsFreshnessShape,
  detailShape,
  nSimsSchema,
  objectiveSchema,
  pfWeightSchema,
  playerIdsSchema,
  playerSelectorSchema,
  positionsSchema,
  projectionHorizonSchema,
  reserveSchema,
  seedSchema,
  seedingModeArgSchema,
  teamIdSchema,
  valueSourceSchema,
  waiverModeSchema,
  waiverPhaseSchema,
  weekSchema,
} from "../bounds.js";
import { toDataInputs, type InputStamp } from "../envelope.js";
import { EffError } from "../errors.js";
import { beforeSideEffect, defineTool, dropLastTrim, type ToolContext } from "../define.js";
import { remainingDeadline } from "../call.js";
import {
  crosswalkOf,
  leagueOf,
  leagueRef,
  optionalDataset,
  present,
  readOpts,
  rosOptsOf,
  rosReadingOf,
  opponentIn,
  periodOf,
  rulesOf,
  scheduleOf,
  seasonStartIso,
  settingsOf,
  slotsOf,
  take,
  teamOf,
  turn,
  weekOf,
  withinBudget,
  type RosReading,
} from "./common.js";
import { rostersOf } from "./roster.js";
import {
  canonical,
  code,
  count,
  dist,
  distNull,
  gsisOrNull,
  inputs as inputsSchema,
  isoNull,
  playerId,
  playerName,
  position,
  prob,
  probNull,
  rec,
  serverText,
  slotName,
  teamId,
  week,
} from "./schemas.js";
import { selectPlayers } from "./select.js";
import { analyzeWaiversP1 } from "../../domain/analytics/phase2.js";
import { waiverP1Extras } from "./market-p1.js";
import { projectMany } from "./p1-common.js";
import {
  fitPremiumFromHistory,
  seasonFeedFromTransactions,
  seasonOfInstant,
  WAIVER_FIT,
  type LeaguePremiumFit,
} from "../../domain/analytics/waiver-fit/index.js";
import { mergeV2, runV2, storeProjections, type V2Run } from "./projection-v2.js";

// --- shared engine inputs ------------------------------------------------------------------------

/** One player the engines see: the platform record and its crosswalk gsis id. */
export interface Subject {
  readonly p: PlatformPlayer;
  readonly gsis: string | null;
}

/** The seed a call uses: the argument, an injected source (tests), else stable in the inputs. */
export function seedOf(ctx: ToolContext, explicit: number | undefined, key: string): number {
  if (explicit !== undefined) return explicit;
  const injected = ctx.services.newSeed?.();
  return injected ?? seedFrom(key);
}

/**
 * Trailing canonical lines per player (nflverse, scored by the engine at projection time): this
 * season's weeks before `w` and the prior season. D/ST units read the team-defence lines. A dataset
 * never loaded leaves the trailing window empty and says so (E1 degradation: ESPN-anchored, CV only).
 */
export function trailingFor(
  ctx: ToolContext,
  subjects: readonly Subject[],
  season: number,
  w: Week,
  inputs: InputStamp[],
  warnings: string[],
  allowStale: boolean,
): Map<number, TrailingLine[]> {
  const out = new Map<number, TrailingLine[]>();
  const now: Week[] = Array.from({ length: Math.max(0, w - 1) }, (_, i) => i + 1);
  const prior: Week[] = Array.from({ length: 18 }, (_, i) => i + 1);
  const gsis = present(subjects.map((s) => s.gsis));
  const byGsis = new Map<string, number>();
  for (const s of subjects) if (s.gsis !== null) byGsis.set(s.gsis, s.p.ref.id);
  let loaded = false;
  if (gsis.length > 0) {
    for (const [yr, weeks] of [
      [season, now],
      [season - 1, prior],
    ] as const) {
      if (weeks.length === 0) continue;
      // stat lines only: E1 scores them, it never reads the usage extras
      const r = ctx.services.datasets.playerWeeks.lines(gsis, yr, weeks, { usage: false });
      const input = optionalDataset(r, ctx, allowStale);
      if (input === null) continue;
      loaded = true;
      inputs.push(input);
      for (const l of r.rows) {
        const id = byGsis.get(l.gsis_id);
        if (id === undefined) continue;
        out.set(id, [...(out.get(id) ?? []), { season: l.season, week: l.week, line: l.line }]);
      }
    }
  }
  const dst = subjects.filter((s) => s.p.position === "D/ST");
  const teams = new Map<NflTeam, number>();
  for (const s of dst) {
    const t = teamOfProTeamId(s.p.pro_team_id);
    if (t !== null) teams.set(t, s.p.ref.id);
  }
  if (teams.size > 0 && now.length > 0) {
    const r = ctx.services.datasets.playerWeeks.defenseLines([...teams.keys()], season, now);
    const input = optionalDataset(r, ctx, allowStale);
    if (input !== null) {
      loaded = true;
      inputs.push(input);
      for (const l of r.rows) {
        const id = teams.get(l.nfl_team);
        if (id === undefined) continue;
        out.set(id, [...(out.get(id) ?? []), { season: l.season, week: l.week, line: l.line }]);
      }
    }
  }
  if (!loaded && subjects.length > 0)
    warnings.push("nflverse:stats_player_week not loaded: spreads from the positional CV only");
  return out;
}

/** Implied team totals by ESPN pro-team id, joined on the ESPN game id (research 04 §B.1.6). */
export function impliedTotals(
  ctx: ToolContext,
  schedule: ProSchedule,
  season: number,
  weeks: readonly Week[],
  inputs: InputStamp[],
  allowStale: boolean,
): ImpliedTotal[] {
  const r = ctx.services.datasets.nflGames.games(season, weeks);
  const input = optionalDataset(r, ctx, allowStale);
  if (input === null) return [];
  inputs.push(input);
  const byEspn = new Map(
    r.rows.filter((g) => g.espn_game_id !== null).map((g) => [g.espn_game_id, g]),
  );
  const out: ImpliedTotal[] = [];
  for (const g of schedule.games) {
    if (!weeks.includes(g.week)) continue;
    const n = byEspn.get(g.espn_game_id);
    if (n?.lines === null || n === undefined) continue;
    out.push({ week: g.week, pro_team_id: g.home_pro_team_id, implied: n.lines.implied.home });
    out.push({ week: g.week, pro_team_id: g.away_pro_team_id, implied: n.lines.implied.away });
  }
  return out;
}

/**
 * What remains of the call's CPU deadline for the next cooperative run (plan 07 E1 [A-7], E3: "the
 * 8 s per-CALL CPU deadline"): ANALYTICS_CPU_DEADLINE_MS — or the test-only switch in the server
 * options (null = off — plan 10 A8a's injection invariance; never set by a production
 * configuration, changelog R5) — less the CPU this call's batches have already spent (call.ts). Read
 * it when the run starts: every run of one call draws on the same budget, so E1's v1 + v2 and E3's
 * season chain stop at 8 s in total (Stage C finding `analytics-cpu-deadline-per-run`).
 */
export function cpuDeadlineOf(ctx: ToolContext): number | null {
  const v = ctx.options.cpuDeadlineMs;
  return remainingDeadline(v === undefined ? ANALYTICS_CPU_DEADLINE_MS : v, ctx.pacer.spentMs());
}

/**
 * Carries an inner sampler's outcome into the calling tool (plan 07 E1 [A-7]; the envelope rule of
 * plan 01 §4.2): its warnings — the "partial: k of n paths before the CPU deadline" line included —
 * join the call's (each once), and its `partial` is returned for the caller's own flag, so a number
 * built from fewer paths is never reported as complete. No cache holds a season simulation: the
 * per-call memo keeps only the league reads (plan 07 E1: a `partial` result is never cached).
 */
export function carryOutcome(
  out: { readonly partial: boolean; readonly warnings: readonly string[] } | null,
  warnings: string[],
): boolean {
  if (out === null) return false;
  for (const w of out.warnings) if (!warnings.includes(w)) warnings.push(w);
  return out.partial;
}

/** Runs E1 over `subjects` (the projection every other engine starts from). */
export async function project(
  ctx: ToolContext,
  subjects: readonly Subject[],
  o: {
    readonly league: League;
    readonly settings: ScoringSettings;
    readonly schedule: ProSchedule;
    readonly horizon: "week" | "ros" | "season";
    readonly week: Week;
    readonly n_sims?: number | undefined;
    readonly seed: number;
    readonly include_stat_line?: boolean;
    readonly allowStale: boolean;
    /**
     * v2-opportunity's samples per player (full only — plan 10 §3.3): default its own 2 000; the
     * bulk callers (projectMany) pass V2_BULK_SIMS so a many-roster season run stays in budget.
     */
    readonly v2_n_sims?: number;
  },
  inputs: InputStamp[],
  warnings: string[],
): Promise<ProjectionOutcome> {
  const season = o.league.ref.season;
  const trailing = trailingFor(ctx, subjects, season, o.week, inputs, warnings, o.allowStale);
  const lastWeek = Math.max(o.week, o.league.clock.final_scoring_period);
  const weeks: Week[] =
    o.horizon === "week"
      ? [o.week]
      : Array.from({ length: lastWeek - o.week + 1 }, (_, i) => o.week + i);
  const implied = impliedTotals(ctx, o.schedule, season, weeks, inputs, o.allowStale);
  // the trailing reads and their scoring are one synchronous step: the loop runs before sampling
  await turn();
  const v1 = await projectPlayers({
    targets: subjects.map((s) => targetOf(s.p, s.gsis, trailing.get(s.p.ref.id) ?? [])),
    season,
    horizon: o.horizon,
    week: o.week,
    final_week: lastWeek,
    settings: o.settings,
    schedule: o.schedule,
    implied_totals: implied,
    clock: ctx.services.clock,
    pacer: ctx.pacer,
    rng: seededRng(o.seed),
    ...(o.n_sims === undefined ? {} : { n_sims: o.n_sims }),
    include_stat_line: o.include_stat_line === true,
    deadline_ms: cpuDeadlineOf(ctx),
    inputs: toDataInputs(inputs, ctx.nowMs),
    // the P1 player_sim basis where the opportunity inputs exist (plan 10 §3.2): under full only,
    // so the P0 core toolset's projections are unchanged
    player_sim: ctx.options.toolset === "full",
  });
  // Phase 3 (plan 10 §3.3; plan 07 E1 → v2-opportunity): under full, the first target week of every
  // QB/RB/WR/TE whose opportunity inputs exist is served by v2 (basis player_sim; ESPN's mean stays
  // the point estimate at weight_espn 1.0); everyone else keeps v1 (projection-v2.ts)
  let out = v1;
  let run: V2Run | null = null;
  if (ctx.options.toolset === "full")
    try {
      run = await runV2(
        ctx,
        subjects,
        v1,
        {
          season,
          week: o.week,
          settings: o.settings,
          rng: seededRng(o.seed).fork("v2"),
          allowStale: o.allowStale,
          ...(o.v2_n_sims === undefined ? {} : { n_sims: o.v2_n_sims }),
          include_stat_line: o.include_stat_line === true,
          deadline_ms: cpuDeadlineOf(ctx),
        },
        inputs,
        warnings,
      );
      out = mergeV2(v1, run, o.include_stat_line === true);
    } catch (e) {
      // an optional layer never fails the call: v1 serves, said once (no third-party text)
      ctx.services.logger.warn("e1.v2_unavailable", {
        error: e instanceof Error ? e.name : "unknown",
      });
      warnings.push("v2-opportunity unavailable for this call: v1-ensemble serves");
      run = null;
      out = v1;
    }
  // every first-week projection is stored for the retrospective's attribution (plan 08 §5; plan 10
  // C9): best-effort, deduplicated, never failing the call
  await storeProjections(ctx, out, run, season, o.week, inputs);
  return out;
}

// --- E1 espn_project_players ----------------------------------------------------------------------

const projectionWeekSchema = z.strictObject({
  week,
  points: dist,
  p_active: probNull,
  opponent: z
    .string()
    .regex(/^@?[A-Z]{2,4}$/)
    .nullable(),
  implied_total: z.number().min(0).max(100).nullable(),
  inputs: z.strictObject({
    espn: z.number().min(-1000).max(1000).nullable(),
    own: z.number().min(-1000).max(1000).nullable(),
    weight_espn: prob,
  }),
  disagreement: z.strictObject({ pct: z.number().nullable(), flagged: z.boolean() }),
});

const driverSchema = z.strictObject({ name: serverText, contribution: z.number() });
const assumptionSchema = z.strictObject({ text: serverText, revisit_trigger: serverText });

/** E1 data (plan 07 E1; ProjectionData). */
export const projectionSchema = z.strictObject({
  model_version: z.enum(["v1-ensemble", "v2-opportunity"]),
  projections: z
    .array(
      z.strictObject({
        player_id: playerId.nullable(),
        gsis_id: gsisOrNull,
        name: playerName,
        position,
        weeks: z.array(projectionWeekSchema).max(22),
        ros_total: distNull,
        stat_line_expectation: z.record(canonical, z.number()).optional(),
        drivers: z.array(driverSchema).max(20),
        role_confidence_games: count,
        assumptions: z.array(assumptionSchema).max(20),
      }),
    )
    .max(60),
  completed_samples: count,
  inputs: inputsSchema,
});

/** `compact` (plan 07 §5.2): weeks beyond three dropped, no stat-line expectation. */
function compactProjections(
  data: ProjectionOutcome["data"],
  full: boolean,
): ProjectionOutcome["data"] {
  if (full) return data;
  return {
    ...data,
    projections: data.projections.map((p) => {
      const { stat_line_expectation: _drop, ...rest } = p;
      return { ...rest, weeks: p.weeks.slice(0, 3) };
    }),
  };
}

/** The longest one warnings[] line may be (the envelope schema's cap). */
const WARNING_MAX_CHARS = 400;

/** One E1 projection row as the budget steps see it. */
interface ProjRow {
  readonly player_id: number | null;
  readonly weeks: readonly unknown[];
  readonly ros_total: unknown;
  readonly drivers: readonly { readonly name: string; readonly contribution: number }[];
  readonly assumptions: readonly { readonly text: string; readonly revisit_trigger: string }[];
}

const projRows = (d: unknown): ProjRow[] => ((d as Obj).projections ?? []) as ProjRow[];
const withRows = (d: unknown, rows: readonly ProjRow[]): unknown => ({
  ...(d as Obj),
  projections: rows,
});

/**
 * E1's budget steps (plan 07 C8 — 10 000 characters; plan 07 §5.2 — `compact` keeps every
 * identifier, every decision number, every Dist): a whole roster (≤ 16 players) at the default
 * detail is answered for every player, the rows thinned in this order before any player is dropped —
 * (1) an assumption several projections share is stated ONCE in warnings[] with the player ids it
 * applies to (lossless); (2) drivers beyond each player's largest go; (3) weeks beyond the first go
 * (the next game's row stays); (4) for a horizon with a rest-of-season total, the weekly rows go and
 * `ros_total` carries the horizon; only then (5) players leave from the end ONE at a time. Before,
 * the list was only halved: a 16-player roster came back as 8 (week) or 3 (ROS) of 16, and every
 * Skill that projects a roster this way silently read part of it (Stage C finding
 * projections-roster-truncated). Each step says what it removed and how to get it. Under
 * `detail: "full"` (every week asked for) only the lossless step (1) runs before (5).
 */
export function projectionTrims(total: number, full = false): readonly AnalyticsTrim[] {
  const assumptionKey = (a: { text: string; revisit_trigger: string }): string =>
    `${a.text}\u0000${a.revisit_trigger}`;
  // one shared assumption per step (each its own warnings[] line, ≤ the envelope's 400 chars),
  // the largest saving first; one whose line would not fit stays on its rows
  const hoist: AnalyticsTrim = (d) => {
    const rows = projRows(d);
    const holders = new Map<string, { a: ProjRow["assumptions"][number]; ids: number[] }>();
    for (const r of rows) {
      if (r.player_id === null) continue;
      for (const a of r.assumptions) {
        const k = assumptionKey(a);
        const h = holders.get(k) ?? { a, ids: [] };
        h.ids.push(r.player_id);
        holders.set(k, h);
      }
    }
    let best: { k: string; line: string; saving: number } | null = null;
    for (const [k, h] of holders) {
      if (h.ids.length < 2) continue;
      const line = `assumption of projections ${h.ids.map(String).join(", ")}: ${h.a.text} (revisit when ${h.a.revisit_trigger})`;
      if (line.length > WARNING_MAX_CHARS) continue;
      const saving = h.ids.length * JSON.stringify(h.a).length - line.length;
      if (best === null || saving > best.saving) best = { k, line, saving };
    }
    if (best === null) return null;
    const hoisted = best.k;
    const thinned = rows.map((r) =>
      r.player_id === null
        ? r
        : { ...r, assumptions: r.assumptions.filter((a) => assumptionKey(a) !== hoisted) },
    );
    return {
      data: withRows(d, thinned),
      warning: best.line,
      key: `projection_assumption:${hoisted}`,
    };
  };
  const dropLast = dropLastTrim(
    "projections",
    total,
    "pass fewer players (player_ids in batches) for the rest",
  ) as AnalyticsTrim;
  // `full` asks for every week: lossless first, then players one at a time (never thinner rows)
  if (full) return [hoist, dropLast];
  return [
    hoist,
    // drivers explain a mean (no Skill reads them): each player's largest is kept here
    (d) => {
      const rows = projRows(d);
      if (!rows.some((r) => r.drivers.length > 1)) return null;
      const top = (r: ProjRow): ProjRow["drivers"] =>
        r.drivers.length <= 1
          ? r.drivers
          : [
              r.drivers.reduce((b, x) =>
                Math.abs(x.contribution) > Math.abs(b.contribution) ? x : b,
              ),
            ];
      return {
        data: withRows(
          d,
          rows.map((r) => ({ ...r, drivers: top(r) })),
        ),
        warning:
          "projections[].drivers cut to each player's largest to fit the 10000-character budget; detail: full with fewer players shows them all",
        key: "projection_drivers",
      };
    },
    (d) => {
      const rows = projRows(d);
      if (!rows.some((r) => r.weeks.length > 1)) return null;
      return {
        data: withRows(
          d,
          rows.map((r) => ({ ...r, weeks: r.weeks.slice(0, 1) })),
        ),
        warning:
          "projections[].weeks cut to the first week to fit the 10000-character budget (ros_total kept); detail: full with fewer players shows every week",
        key: "projection_weeks",
      };
    },
    (d) => {
      const rows = projRows(d);
      if (!rows.some((r) => r.drivers.length > 0)) return null;
      return {
        data: withRows(
          d,
          rows.map((r) => ({ ...r, drivers: [] })),
        ),
        warning:
          "projections[].drivers omitted to fit the 10000-character budget; fewer players show them",
        key: "projection_drivers",
      };
    },
    (d) => {
      const rows = projRows(d);
      if (rows.length === 0 || !rows.every((r) => r.ros_total !== null)) return null;
      if (!rows.some((r) => r.weeks.length > 0)) return null;
      return {
        data: withRows(
          d,
          rows.map((r) => ({ ...r, weeks: [] })),
        ),
        warning:
          "projections[].weeks omitted to fit the 10000-character budget: ros_total carries the horizon; fewer players (or horizon: week) give the weekly rows",
        key: "projection_weeks",
      };
    },
    dropLast,
  ];
}

/** E1 `espn_project_players`. */
export const projectPlayersTool = defineTool({
  name: "espn_project_players",
  description:
    "Points distributions per player-week under league scoring: ESPN's projection as the mean (v1), spread from recent stats; flags a >25% disagreement.",
  input: z.strictObject({
    players: playerSelectorSchema,
    horizon: projectionHorizonSchema,
    week: weekSchema.optional(),
    n_sims: nSimsSchema,
    seed: seedSchema.optional(),
    include_stat_line: z.boolean().default(false),
    ...detailShape,
    ...analyticsFreshnessShape,
  }),
  data: projectionSchema,
  budget: "analytics",
  opaqueInput: {
    players:
      "PlayerSelector: exactly one of {player_ids:[<=25]}, {gsis_ids:[<=25]}, {team_id}, {nfl_team}, {pool:{status,position,top<=50}}",
  },
  run: async (args, ctx) => {
    const inputs: InputStamp[] = [];
    const warnings: string[] = [];
    const allowStale = args.allow_stale === true;
    const league = await leagueOf(ctx, inputs, args);
    const w = weekOf(league, args.week);
    const settings = await settingsOf(ctx, inputs);
    const sel = await selectPlayers(
      ctx,
      args.players,
      league.my_team?.team_id ?? null,
      w,
      inputs,
      warnings,
    );
    if (sel.missing > 0) warnings.push(`${String(sel.missing)} requested player(s) not found`);
    if (sel.players.length === 0) throw new EffError("NOT_FOUND");
    const sched = await scheduleOf(ctx, league.ref.season, inputs, allowStale);
    const subjects = sel.players.map((p) => ({
      p,
      gsis: crosswalkOf(ctx, p.ref.id, p.position_id).gsis_id,
    }));
    const seed = seedOf(
      ctx,
      args.seed,
      [
        "e1",
        league.ref.season,
        w,
        args.horizon,
        settings.settings_hash,
        ...subjects.map((s) => s.p.ref.id),
      ].join("|"),
    );
    const out = await project(
      ctx,
      subjects,
      {
        league,
        settings,
        schedule: sched.schedule,
        horizon: args.horizon,
        week: w,
        n_sims: args.n_sims,
        seed,
        include_stat_line: args.include_stat_line,
        allowStale,
      },
      inputs,
      warnings,
    );
    const data = compactProjections(out.data, args.detail === "full");
    return {
      data: { ...data, inputs: toDataInputs(inputs, ctx.nowMs) },
      inputs,
      warnings: [...warnings, ...out.warnings],
      estimate: true,
      partial: out.partial,
      listKey: "projections",
      trims: projectionTrims(data.projections.length, args.detail === "full"),
      week: w,
    };
  },
});

// --- E2 espn_analyze_lineup ------------------------------------------------------------------------

const coarseSchema = z.strictObject({
  sign: z.enum(["+", "-", "0"]),
  band: z.enum(["small", "medium", "large"]),
});

const lineupSlotSchema = z.strictObject({
  slot: slotName,
  player_id: playerId,
  name: playerName,
  points: dist,
  lock_at: isoNull,
  percent_started: z.number().min(0).max(100).nullable(),
});

const swapBase = {
  out: playerId.nullable(),
  in: playerId,
  slot: slotName,
  delta_e: z.number(),
  delta_pf: z.number(),
  interval: z.tuple([z.number(), z.number()]),
  coin_flip: z.boolean(),
  option_value: z
    .strictObject({
      kind: z.enum(["thursday", "monday", "late_game"]),
      value: z.number(),
      verdict: serverText,
    })
    .nullable(),
};

const lineupBase = {
  objective_used: z.enum(["mean", "pwin", "blend", "points_only"]),
  objective_reason: serverText,
  seeding_mode_used: z.enum(["espn_rule", "points_only", "both"]),
  seeding: z.strictObject({
    mode_used: z.enum(["espn_rule", "points_only", "both"]),
    confirmed: z.boolean(),
  }),
  current_lineup: z.array(lineupSlotSchema).max(30),
  recommended_lineup: z.array(lineupSlotSchema).max(30),
  mode: z.enum(["protect", "chase", "neutral", "maximise_pf"]),
  mode_basis: z.strictObject({
    mu_m: z.number(),
    mu_o: z.number(),
    sigma_m: z.number(),
    sigma_o: z.number(),
    rho_lineup: z.number(),
    pf_exchange_rate: z.strictObject({
      pf_per_win: z.number().nullable(),
      source: z.enum(["season_sim", "cold_start"]).nullable(),
    }),
    pf_context: z
      .strictObject({
        season_pf_rank: count,
        pf_gap_to_cutoff: z.number(),
        tiebreak_in_play: z.boolean(),
      })
      .nullable(),
  }),
  e_points_before: z.number(),
  e_points_after: z.number(),
  p_win_before: probNull,
  p_win_after: probNull,
  p_win_interval: z.tuple([prob, prob]).nullable(),
  conditionals: z
    .array(
      z.strictObject({
        if: z.strictObject({
          player_id: playerId,
          event: z.literal("inactive"),
          decided_by: z.iso.datetime({ offset: true }),
        }),
        then: z.strictObject({ slot: slotName, in: playerId }),
      }),
    )
    .max(20),
  stack_flags: z
    .array(
      z.strictObject({
        players: z.array(playerId).max(10),
        effect: z.enum(["ceiling+", "floor-"]),
        advice_under_reading: serverText,
      }),
    )
    .max(20),
  espn_cross_check: z.strictObject({
    starter_disagreements: z
      .array(
        z.strictObject({
          player_id: playerId,
          ours: z.number(),
          espn: z.number(),
          pct: z.number(),
        }),
      )
      .max(30),
  }),
  lock_schedule: z
    .array(
      z.strictObject({
        lock_at: z.iso.datetime({ offset: true }),
        player_ids: z.array(playerId).max(60),
      }),
    )
    .max(60),
  latest_execution_time: isoNull,
  no_move: z.boolean(),
  rec,
  inputs: inputsSchema,
};

/** E2 data (plan 07 E2; LineupData, discriminated on `basis`). */
export const lineupSchema = z.discriminatedUnion("basis", [
  z.strictObject({
    ...lineupBase,
    basis: z.literal("position_cv"),
    p_win_reporting: z.literal("sign_and_band"),
    swaps: z.array(z.strictObject({ ...swapBase, delta_pwin: coarseSchema })).max(30),
  }),
  z.strictObject({
    ...lineupBase,
    basis: z.literal("player_sim"),
    p_win_reporting: z.literal("calibrated"),
    swaps: z.array(z.strictObject({ ...swapBase, delta_pwin: z.number() })).max(30),
  }),
]);

export { opponentIn, periodOf };

/** Season standings from the schedule's results (when the standings view is not cached). */
export function standingsFromMatchups(
  matchups: readonly Matchup[],
  regularPeriods: number | null,
): { teams: SeasonTeam[]; played: PlayedGame[]; remaining: ScheduledGame[] } {
  const acc = new Map<number, { w: number; l: number; t: number; pf: number; pa: number }>();
  const row = (id: number) => {
    let r = acc.get(id);
    if (r === undefined) {
      r = { w: 0, l: 0, t: 0, pf: 0, pa: 0 };
      acc.set(id, r);
    }
    return r;
  };
  const played: PlayedGame[] = [];
  const remaining: ScheduledGame[] = [];
  for (const m of matchups) {
    row(m.home.team_id);
    if (m.away !== null) row(m.away.team_id);
    if (regularPeriods !== null && m.matchup_period > regularPeriods) continue;
    if (m.away === null) continue;
    const hp = m.home.points;
    const ap = m.away.points;
    if (m.winner !== null && m.winner !== "UNDECIDED" && hp !== null && ap !== null) {
      played.push({
        period: m.matchup_period,
        home: m.home.team_id,
        away: m.away.team_id,
        home_points: hp,
        away_points: ap,
      });
      const h = row(m.home.team_id);
      const a = row(m.away.team_id);
      h.pf += hp;
      h.pa += ap;
      a.pf += ap;
      a.pa += hp;
      if (hp > ap) {
        h.w++;
        a.l++;
      } else if (ap > hp) {
        a.w++;
        h.l++;
      } else {
        h.t++;
        a.t++;
      }
    } else {
      remaining.push({
        period: m.matchup_period,
        matchup_id: m.matchup_id,
        home: m.home.team_id,
        away: m.away.team_id,
      });
    }
  }
  const teams: SeasonTeam[] = [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, r]) => ({
      team_id: id,
      division_id: null,
      wins: r.w,
      losses: r.l,
      ties: r.t,
      points_for: r.pf,
      points_against: r.pa,
    }));
  return { teams, played, remaining };
}

/** The PF exchange rate and context from the seeding simulator (reading (a)); null → cold start. */
export async function seasonContext(
  ctx: ToolContext,
  league: League,
  rules: LeagueRules,
  matchups: readonly Matchup[],
  standings: Standings | null,
  me: number,
  w: Week,
  seed: number,
  readingMode: "espn_rule" | "points_only",
  warnings: string[],
): Promise<LineupSeasonContext | null> {
  const regular = rules.playoffs.regular_season_matchups;
  const derived = standingsFromMatchups(matchups, regular);
  const teams: SeasonTeam[] =
    standings === null
      ? derived.teams
      : standings.teams.map((t) => ({
          team_id: t.team_id,
          division_id: t.division_id,
          wins: t.wins,
          losses: t.losses,
          ties: t.ties,
          points_for: t.points_for,
          points_against: t.points_against,
        }));
  const remainingWeeksN = regularSeasonWeeks(rules.playoffs).filter((x) => x >= w).length;
  const pfCtx = pfContextOf(teams, me, rules.playoffs.team_count ?? 4);
  if (readingMode === "points_only")
    return { pf_per_win: null, pf_context: pfCtx, remaining_weeks: remainingWeeksN };
  const teamCount = rules.playoffs.team_count;
  if (teamCount === null || teams.length < 2 || !teams.some((t) => t.team_id === me)) return null;
  try {
    const sim = await simulateSeason({
      teams,
      played: derived.played,
      remaining: derived.remaining,
      me,
      playoff: {
        team_count: Math.min(teamCount, teams.length),
        seeding_rule: rules.playoffs.seeding_rule,
        reseed: rules.playoffs.reseed,
        rounds: [],
      },
      seeding_mode: "espn_rule",
      seeding_config: { mode: "espn_rule", confirmed_at: ctx.services.seedingConfirmedAt },
      n_sims: BOUNDS.nSims.default,
      clock: ctx.services.clock,
      pacer: ctx.pacer,
      rng: seededRng(seed),
      deadline_ms: cpuDeadlineOf(ctx),
    });
    // a deadline-stopped run's exchange rate comes from fewer paths: say so (warning + partial)
    carryOutcome(sim, warnings);
    const reading = sim.data.readings[0];
    return {
      pf_per_win: reading?.pf_per_win ?? null,
      pf_context: pfCtx,
      remaining_weeks: remainingWeeksN,
    };
  } catch {
    warnings.push("seeding simulator unavailable: PF exchange rate from the cold start");
    return { pf_per_win: null, pf_context: pfCtx, remaining_weeks: remainingWeeksN };
  }
}

/** E2 `espn_analyze_lineup`. */
export const analyzeLineupTool = defineTool({
  name: "espn_analyze_lineup",
  description:
    "Start/sit as an assignment under the objective the seeding reading implies: lineup, swaps with expected points and P(win) change, coin flips, locks.",
  input: z.strictObject({
    team_id: teamIdSchema.optional(),
    week: weekSchema.optional(),
    objective: objectiveSchema.default("auto"),
    blend_weight: z.number().min(BOUNDS.blendWeight.min).max(BOUNDS.blendWeight.max).optional(),
    pf_weight: pfWeightSchema.optional(),
    seeding_mode: seedingModeArgSchema.default("config"),
    only_unlocked: z.boolean().default(false),
    exclude: playerIdsSchema.optional(),
    force_start: playerIdsSchema.optional(),
    compare: z
      .array(z.strictObject({ out: playerId, in: playerId }))
      .max(BOUNDS.compareSwaps.max)
      .optional(),
    seed: seedSchema.optional(),
    ...analyticsFreshnessShape,
  }),
  data: lineupSchema,
  budget: "analytics",
  run: async (args, ctx) => {
    const inputs: InputStamp[] = [];
    const warnings: string[] = [];
    const allowStale = args.allow_stale === true;
    const league = await leagueOf(ctx, inputs, args);
    const w = weekOf(league, args.week);
    const team = teamOf(league, args.team_id);
    const settings = await settingsOf(ctx, inputs);
    const slots = await slotsOf(ctx, inputs);
    const rules = await rulesOf(ctx, inputs);
    const rosters = await rostersOf(ctx, w, inputs, warnings, args, team);
    const mine = rosters.find((r) => r.team.team_id === team);
    if (mine === undefined) throw new EffError("NOT_FOUND");
    const mGot = await withinBudget(
      () => ctx.services.platform.getMatchups(leagueRef(ctx), readOpts(ctx, args)),
      warnings,
    );
    const matchups = mGot === null ? [] : take(ctx, mGot, inputs);
    const oppId = opponentIn(matchups, periodOf(rules, w), team);
    const opp = oppId === null ? null : (rosters.find((r) => r.team.team_id === oppId) ?? null);
    if (mGot === null)
      warnings.push("schedule unavailable: no opponent, objective mean, mode neutral");
    const sched = await withinBudget(
      () => scheduleOf(ctx, league.ref.season, inputs, allowStale),
      warnings,
    );
    const schedule: ProSchedule = sched?.schedule ?? {
      season: league.ref.season,
      games: [],
      teams: [],
    };
    if (sched === null) warnings.push("pro schedule unavailable: lock times unknown");
    const entries = [...mine.entries, ...(opp?.entries ?? [])];
    const subjects = entries.map((e) => ({
      p: e.player,
      gsis: crosswalkOf(ctx, e.player.ref.id, e.player.position_id).gsis_id,
    }));
    const seed = seedOf(
      ctx,
      args.seed,
      [
        "e2",
        league.ref.season,
        w,
        team,
        settings.settings_hash,
        ...subjects.map((s) => s.p.ref.id),
      ].join("|"),
    );
    const proj = await project(
      ctx,
      subjects,
      { league, settings, schedule, horizon: "week", week: w, seed, allowStale },
      inputs,
      warnings,
    );
    const projBy = new Map<number, ProjectedPlayer>(
      proj.players.map((x) => [x.target.player_id ?? 0, x]),
    );
    const plan = lockPlan(
      entries.map((e) => ({
        player_id: e.player.ref.id,
        pro_team_id: e.player.pro_team_id,
        lineup_locked: e.lineup_locked,
      })),
      schedule,
      w,
      slots.lineup_lock_type,
      ctx.nowMs,
    );
    const lockBy = new Map(plan.players.map((p) => [p.player_id, p]));
    const toLineup = (e: RosterEntry, gsis: string | null): LineupPlayer | null => {
      const pw = projBy.get(e.player.ref.id);
      const first = pw?.weeks[0];
      if (first === undefined) return null;
      return lineupPlayerOf(
        e,
        {
          dist: first.dist,
          p_active: first.p_active,
          role_games: pw?.projection.role_confidence_games ?? 0,
        },
        lockBy.get(e.player.ref.id) ?? null,
        gsis,
      );
    };
    const gsisOf = new Map(subjects.map((s) => [s.p.ref.id, s.gsis]));
    const players = present(
      mine.entries.map((e) => toLineup(e, gsisOf.get(e.player.ref.id) ?? null)),
    );
    const opponent =
      opp === null
        ? null
        : present(opp.entries.map((e) => toLineup(e, gsisOf.get(e.player.ref.id) ?? null)));
    const stGot =
      mGot === null
        ? null
        : await withinBudget(
            () => ctx.services.platform.getStandings(leagueRef(ctx), readOpts(ctx)),
            warnings,
          ).catch(() => null);
    const standings = stGot === null ? null : take(ctx, stGot, inputs);
    const reading =
      args.seeding_mode === "config"
        ? ctx.services.seedingMode
        : args.seeding_mode === "points_only"
          ? "points_only"
          : "espn_rule";
    const season =
      mGot === null
        ? null
        : await seasonContext(
            ctx,
            league,
            rules,
            matchups,
            standings,
            team,
            w,
            seed,
            reading,
            warnings,
          );
    const data = analyzeLineup({
      roster: slots,
      players,
      opponent,
      objective: args.objective,
      ...(args.blend_weight === undefined ? {} : { blend_weight: args.blend_weight }),
      ...(args.pf_weight === undefined ? {} : { pf_weight: args.pf_weight }),
      seeding_mode: args.seeding_mode,
      seeding_config: {
        mode: ctx.services.seedingMode,
        confirmed_at: ctx.services.seedingConfirmedAt,
      },
      season,
      only_unlocked: args.only_unlocked,
      ...(args.exclude === undefined ? {} : { exclude: args.exclude }),
      ...(args.force_start === undefined ? {} : { force_start: args.force_start }),
      ...(args.compare === undefined ? {} : { compare: args.compare }),
      clock: ctx.services.clock,
      inputs: toDataInputs(inputs, ctx.nowMs),
    });
    warnings.push(...compareWarnings(players, args.compare));
    if (!data.seeding.confirmed)
      warnings.push("seeding reading not confirmed: run the onboard Skill (eff setup --seeding)");
    return {
      data,
      inputs,
      warnings: [...warnings, ...proj.warnings],
      estimate: true,
      partial: proj.partial || warnings.some((x) => x.startsWith("partial:")),
      listKey: "swaps",
      trims: lineupTrims(data),
      week: w,
    };
  },
});

type Obj = Record<string, unknown>;
const arr = (d: unknown, k: string): unknown[] => {
  const v = (d as Obj)[k];
  return Array.isArray(v) ? v : [];
};

/** One E2/E5 budget step (envelope.ts BudgetTrim with a required key). */
export type AnalyticsTrim = (d: unknown) => { data: unknown; warning: string; key: string } | null;

/** The rec's confidence inputs go first in every analytics answer: `data.inputs` carries them. */
export const REC_INPUTS_TRIM: AnalyticsTrim = (d) => {
  const rec = (d as Obj).rec as Obj | null | undefined;
  const conf = rec?.confidence as Obj | undefined;
  if (rec === null || rec === undefined || conf === undefined) return null;
  if (!Array.isArray(conf.inputs) || conf.inputs.length === 0) return null;
  return {
    data: { ...(d as Obj), rec: { ...rec, confidence: { ...conf, inputs: [] } } },
    warning: "rec.confidence.inputs omitted (data.inputs carries them)",
    key: "rec_inputs",
  };
};

/**
 * The players E2 moves: every player whose slot differs between `current_lineup` and
 * `recommended_lineup`, or who appears in only one of them. Read from the UNTRIMMED answer, so each
 * budget step below is independent of the order the earlier ones ran in.
 */
export function movedPlayers(d: unknown): ReadonlySet<number> {
  const slotOf = (rows: unknown[]): Map<unknown, unknown> =>
    new Map((rows as Obj[]).map((r) => [r.player_id, r.slot]));
  const cur = slotOf(arr(d, "current_lineup"));
  const rec = slotOf(arr(d, "recommended_lineup"));
  const out = new Set<number>();
  for (const [p, s] of cur) if (rec.get(p) !== s && typeof p === "number") out.add(p);
  for (const [p, s] of rec) if (cur.get(p) !== s && typeof p === "number") out.add(p);
  return out;
}

const BENCH_SLOTS: ReadonlySet<unknown> = new Set(["BE", "IR"]);

/**
 * E2's budget steps before `swaps` is halved (plan 07 C8 and §5.1: an analytics answer is capped at
 * 10 000 chars BY CONSTRUCTION, never silent — every step adds one fixed warning). Each step removes
 * a repeat before it removes information: the slots that do not change leave `current_lineup` (they
 * repeat `recommended_lineup`), the lock schedule goes (espn_get_roster carries it), the rec's
 * confidence inputs go (`data.inputs` carries them), the bench and IR rows that do not change leave
 * `recommended_lineup` (espn_get_roster carries them), `rec.subjects` keeps the players who move
 * (`rec.lineup` carries the whole lineup), `current_lineup` goes (its rows repeat the moved
 * players' rows of `recommended_lineup`; `swaps` and `rec.subjects` name every from-slot), the
 * cross-check, stack flags and conditionals are halved, the unchanged starters leave
 * `recommended_lineup` (`rec.lineup` still names them), and last the moved rows and the rec's
 * drivers are halved. With every step taken the answer is the fixed fields plus `rec.lineup`, so an
 * `exclude`/`force_start` that changes many slots trims instead of failing (Stage C:
 * `lineup-exclude-over-budget-internal`).
 */
export function lineupTrims(untrimmed: unknown): readonly AnalyticsTrim[] {
  const moved = movedPlayers(untrimmed);
  const hasMoved = (r: Obj): boolean => typeof r.player_id === "number" && moved.has(r.player_id);
  const keepRows = (key: string, keep: (r: Obj) => boolean, warning: string): AnalyticsTrim => {
    return (d) => {
      const rows = arr(d, key) as Obj[];
      const kept = rows.filter(keep);
      if (kept.length === rows.length) return null;
      return { data: { ...(d as Obj), [key]: kept }, warning, key };
    };
  };
  return [
    keepRows(
      "current_lineup",
      hasMoved,
      "current_lineup lists only the slots that change (the rest equal recommended_lineup)",
    ),
    (d) =>
      arr(d, "lock_schedule").length === 0
        ? null
        : {
            data: { ...(d as Obj), lock_schedule: [] },
            warning: "lock_schedule omitted (espn_get_roster carries it)",
            key: "lock_schedule",
          },
    REC_INPUTS_TRIM,
    keepRows(
      "recommended_lineup",
      (r) => !BENCH_SLOTS.has(r.slot) || hasMoved(r),
      "recommended_lineup omits the bench and IR rows that do not change (espn_get_roster carries them)",
    ),
    (d) => {
      const rec = (d as Obj).rec as Obj;
      const subjects = Array.isArray(rec.subjects) ? (rec.subjects as Obj[]) : [];
      const kept = subjects.filter(hasMoved);
      if (kept.length === subjects.length) return null;
      return {
        data: { ...(d as Obj), rec: { ...rec, subjects: kept } },
        warning: "rec.subjects lists only the players who move (rec.lineup carries the lineup)",
        key: "rec_subjects",
      };
    },
    (d) =>
      arr(d, "current_lineup").length === 0
        ? null
        : {
            data: { ...(d as Obj), current_lineup: [] },
            warning:
              "current_lineup omitted (swaps and rec.subjects name every slot a moved player leaves)",
            key: "current_lineup",
          },
    (d) => {
      const x = (d as Obj).espn_cross_check as Obj;
      const list = Array.isArray(x.starter_disagreements) ? x.starter_disagreements : [];
      if (list.length === 0) return null;
      return {
        data: {
          ...(d as Obj),
          espn_cross_check: { starter_disagreements: list.slice(0, Math.floor(list.length / 2)) },
        },
        warning: "espn_cross_check.starter_disagreements truncated to fit the budget",
        key: "cross_check",
      };
    },
    (d) => {
      const s = arr(d, "stack_flags");
      const c = arr(d, "conditionals");
      if (s.length === 0 && c.length === 0) return null;
      return {
        data: {
          ...(d as Obj),
          stack_flags: s.slice(0, Math.floor(s.length / 2)),
          conditionals: c.slice(0, Math.floor(c.length / 2)),
        },
        warning: "stack_flags and conditionals truncated to fit the budget",
        key: "flags",
      };
    },
    keepRows(
      "recommended_lineup",
      hasMoved,
      "recommended_lineup lists only the players who move (rec.lineup carries the whole lineup)",
    ),
    (d) => {
      const rows = arr(d, "recommended_lineup");
      const rec = (d as Obj).rec as Obj;
      const drivers = Array.isArray(rec.drivers) ? rec.drivers : [];
      if (rows.length === 0 && drivers.length === 0) return null;
      return {
        data: {
          ...(d as Obj),
          recommended_lineup: rows.slice(0, Math.floor(rows.length / 2)),
          rec: { ...rec, drivers: drivers.slice(0, Math.floor(drivers.length / 2)) },
        },
        warning:
          "recommended_lineup and rec.drivers truncated to fit the budget (rec.lineup and swaps name every change)",
        key: "moved_rows",
      };
    },
  ];
}

// --- E5 espn_analyze_waivers -----------------------------------------------------------------------

const kdstSchema = z
  .strictObject({
    implied_total: z.number().nullable(),
    opp_implied_total: z.number().nullable(),
    brackets_e: z.number().nullable(),
    sacks_e: z.number().nullable(),
    takeaways_e: z.number().nullable(),
    rare_c: z.number().nullable(),
    returns_e: z.number().nullable(),
    next_week: z
      .strictObject({
        opponent: z
          .string()
          .regex(/^@?[A-Z]{2,4}$/)
          .nullable(),
        implied_total: z.number().nullable(),
        e: z.number().nullable(),
      })
      .nullable(),
  })
  .nullable();

export const candidateSchema = z.strictObject({
  player_id: playerId,
  name: playerName,
  position,
  status: z.enum(["FREEAGENT", "WAIVERS"]),
  waiver_process_date: isoNull,
  signals: z
    .array(z.strictObject({ kind: code, value: z.number(), evidence: z.number().optional() }))
    .max(10),
  value: dist,
  s: z.number(),
  s_with_ir_move: z.number().nullable(),
  p_role_holds: z.array(z.strictObject({ week, p: prob })).max(18),
  p_k_win: probNull,
  p_clears_to_fa: z
    .strictObject({
      p: prob,
      interval: z.tuple([prob, prob]),
      basis: z.enum(["cold_start", "league_fitted"]),
    })
    .nullable(),
  demand: z.strictObject({
    rivals_upgraded: z.array(teamId).max(40),
    q_i: z.array(z.strictObject({ team_id: teamId, p: prob })).max(40),
    percent_change: z.number().nullable(),
    competition_signal: z.literal(true),
    sleeper_trend: z.number().nullable(),
    rivals_ir_blocked: z.array(teamId).max(40),
  }),
  verdict: z.enum(["claim", "pass", "marginal", "fa_add_now", "fa_add_after_run"]),
  claim_rank: count.nullable(),
  conditional_drop: z
    .strictObject({
      player_id: playerId,
      name: playerName,
      value_ros: dist,
      re_add_risk: z.strictObject({
        percent_owned: z.number().min(0).max(100).nullable(),
        rivals_claiming: count.nullable(),
      }),
      is_ir_move: z.boolean(),
      activation_warning: serverText.nullable(),
    })
    .nullable(),
  flip_driver: serverText,
  invalidators: z.array(serverText).max(10),
  kdst: kdstSchema,
  /** FAAB mode only (P1, additive): this candidate's own bid, P(win | bid), its expected net value. */
  bid: z
    .strictObject({ b_star: z.number(), p_win: prob, expected_net: z.number() })
    .nullable()
    .optional(),
});

/** E5 data (plan 07 E5; WaiversData). */
export const waiversSchema = z.strictObject({
  mode_used: z.enum(["priority", "faab"]),
  phase: z.enum(["pre_run", "post_run"]),
  next_run_at: isoNull,
  last_run_at: isoNull,
  k: count.nullable(),
  W: count,
  premium: z.number(),
  premium_band: z.strictObject({ low: z.number(), high: z.number() }),
  premium_basis: z.enum(["cold_start_table", "league_fitted"]),
  per_week_threshold: z.number(),
  value_basis: z.enum(["espn_ros", "ensemble"]),
  candidates: z.array(candidateSchema).max(25),
  claim_list: z.array(playerId).max(25),
  marginal: z.array(playerId).max(25),
  scramble_list: z.array(playerId).max(25),
  hold_vs_stream: z
    .strictObject({ streamability: z.number(), current_starter_delta: z.number() })
    .nullable(),
  adds_remaining: count.nullable(),
  faab: z
    .strictObject({
      b_star: z.number(),
      p_win_curve: z.array(z.strictObject({ bid: z.number(), p_win: prob })).max(50),
      lambda: z.number(),
      dollars_per_point: z.strictObject({ value: z.number(), n: count }),
    })
    .nullable(),
  learned: z.strictObject({
    second_claim_at_new_position: z.boolean().nullable(),
    unowned_to_waivers_at_kickoff: z.boolean().nullable(),
    order_reset_rule: z.string().max(40).nullable(),
  }),
  rec,
  inputs: inputsSchema,
});

/**
 * A waiver-engine player from a platform record and its value weeks, ESPN's rest-of-season total
 * read under the call's `ros` (common.ts RosReading — E1's window; null: from the first value week).
 */
export function waiverPlayerOf(
  p: PlatformPlayer,
  slotId: number,
  locked: boolean,
  weeks: readonly Week[],
  gsis: string | null,
  ros: RosReading | null,
): WaiverPlayer {
  return {
    player_id: p.ref.id,
    gsis_id: gsis,
    name: p.name,
    position: p.position,
    position_id: p.position_id,
    eligible_slot_ids: p.eligible_slot_ids,
    injury_status: p.injury_status,
    pro_team_id: p.pro_team_id,
    slot_id: slotId,
    locked,
    droppable: p.droppable,
    weekly: weeklyValues(
      weeks,
      p.projection_week_espn,
      p.projection_ros_espn,
      p.bye_week,
      rosOptsOf(p, ros),
    ),
    percent_owned: p.ownership?.percent_owned ?? null,
  };
}

/** The K/D-ST positions (plan 07 C5). */
export const KDST = new Set(["K", "D/ST"]);

/** The pool page E5 reads: one sorted page, filtered to the positions asked. */
export async function candidatePool(
  ctx: ToolContext,
  w: Week,
  positions: readonly string[] | undefined,
  ids: readonly number[] | undefined,
  inputs: InputStamp[],
): Promise<PlatformPlayer[]> {
  if (ids !== undefined) {
    const got = await ctx.services.platform.getPlayers(
      leagueRef(ctx),
      ids.map((id) => ({ platform: "espn" as const, id })),
      w,
      readOpts(ctx),
    );
    return [...take(ctx, got, inputs)];
  }
  const single = positions?.length === 1 ? (positions[0] ?? null) : null;
  const got = await ctx.services.platform.listPlayers(
    leagueRef(ctx),
    { status: "AVAILABLE", position: single, sort: "projection_ros", week: w, injured: null },
    { limit: single === null ? 50 : 25, offset: 0 },
    readOpts(ctx),
  );
  const items = take(ctx, got, inputs).items;
  return positions === undefined
    ? [...items]
    : items.filter(
        (p) =>
          positions.includes(p.position) || p.eligible_slots.some((s) => positions.includes(s)),
      );
}

/** The regular season's last scoring period from the rules (null when unknown). */
export function regularSeasonLastWeek(rules: LeagueRules): number | null {
  const reg = rules.playoffs.regular_season_matchups;
  if (reg === null || !Number.isInteger(reg) || reg < 1) return null;
  let last = 0;
  for (const [k, ws] of Object.entries(rules.playoffs.matchup_periods))
    if (Number(k) <= reg) for (const x of ws) last = Math.max(last, x);
  return last > 0 ? last : null;
}

/** Previous seasons scanned for stored transactions, newest first (an empty one is one index probe). */
export const HISTORY_SCAN_SEASONS = 10;

/**
 * The stored transactions of `season` and of the newest WAIVER_FIT.history.maxSeasons previous
 * seasons that have any, each season read whole through its own window — never the newest-first
 * page of `list`, which stops reaching the previous seasons once the current one (lineup moves
 * included) fills it (Stage C finding waivers-previous-season-feed-not-populated). A season at the
 * read's bound is said. `pace` is awaited before each season's read: one full season (5 000 rows,
 * read and parsed) costs 16–21 ms, so three in one turn would pass the 50 ms stall bound (plan 03
 * §1.2) — each takes a turn of its own.
 */
export async function storedSeasons(
  seen: Pick<TransactionsSeenRepository, "listRange" | "oldestSeen">,
  season: number,
  warnings: string[],
  pace: () => Promise<void>,
): Promise<{
  readonly current: readonly Transaction[];
  readonly previous: readonly {
    readonly season: number;
    readonly transactions: readonly Transaction[];
  }[];
}> {
  const read = (s: number): Transaction[] => {
    const rows = seen.listRange(seasonStartIso(s), seasonStartIso(s + 1), TRANSACTIONS_RANGE_MAX);
    if (rows.length >= TRANSACTIONS_RANGE_MAX)
      warnings.push(
        `season ${String(s)}: only its newest ${String(TRANSACTIONS_RANGE_MAX)} stored transactions are read`,
      );
    // the season of a row is its processed (else proposed) instant, as the feed reads it
    return rows.filter((t) => seasonOfInstant(t.process_date ?? t.proposed_date) === s);
  };
  const previous: { season: number; transactions: Transaction[] }[] = [];
  const oldest = seasonOfInstant(seen.oldestSeen());
  if (oldest !== null)
    for (
      let s = season - 1;
      s >= Math.max(oldest, season - HISTORY_SCAN_SEASONS) &&
      previous.length < WAIVER_FIT.history.maxSeasons;
      s--
    ) {
      await pace();
      const transactions = read(s);
      if (transactions.length > 0) previous.push({ season: s, transactions });
    }
  await pace();
  return { current: read(season), previous };
}

/**
 * The league-fitted premium (Phase 3, plan 10 C5; Stage C, changelog R6-3 — waiver-fit/history.ts
 * fitPremiumFromHistory). The league's previous seasons' transactions kept in `transactions_seen`
 * are its own feed: the demand curve (its drops and whether another team's claim took them) and the
 * drift fitted from them make the basis `league_fitted` from the first call — no request is spent
 * here, the store holds them (read value-free: a past player's value is not in the store). Without
 * history, the waiver runs E5 priced this season re-solve Π at 13 runs (the path for a league with
 * no history); the current season's processed claims, else the standings' acquisition totals, give
 * the drift. Null when the store holds neither history nor runs (E5 then states the cold start
 * itself); a cold fit says why once.
 */
export async function leaguePremiumFit(
  ctx: ToolContext,
  league: League,
  rules: LeagueRules,
  w: Week,
  standings: Standings | null,
  warnings: string[],
): Promise<LeaguePremiumFit | null> {
  try {
    const season = league.ref.season;
    const stored = await storedSeasons(ctx.services.transactionsSeen, season, warnings, turn);
    const regular = regularSeasonLastWeek(rules);
    // a season's feed costs 10–22 ms at 5 000 rows: one per turn (the stall bound)
    const feeds: ReturnType<typeof seasonFeedFromTransactions>[] = [];
    for (const p of stored.previous) {
      await turn();
      feeds.push(
        seasonFeedFromTransactions({
          season: p.season,
          transactions: p.transactions,
          regular_season_weeks: regular,
        }),
      );
    }
    await turn();
    const repo = ctx.services.waiverRuns;
    const runs = repo === undefined ? [] : repo.list(leagueRef(ctx).league_id, season);
    const evidence = feeds.filter((f) => f.outcomes.length > 0 || f.claim_runs > 0);
    if (evidence.length === 0 && runs.length === 0) return null;
    const period = periodOf(rules, w) ?? w;
    const fit = fitPremiumFromHistory({
      teams: league.size,
      feeds,
      runs: runs.map((r) => ({ W: r.W, candidates: r.surplus.map((x) => ({ s: x })) })),
      current: {
        season,
        transactions: stored.current,
        standings: standings?.teams ?? [],
        periods_played: Array.from({ length: Math.max(0, period - 1) }, (_, i) => i + 1),
      },
    });
    if (fit.basis !== "league_fitted") {
      const n = evidence.reduce((x, f) => x + f.outcomes.length, 0);
      const history =
        evidence.length === 0
          ? "no previous-season transactions of this league are stored"
          : `its previous seasons (${evidence.map((f) => String(f.season)).join(", ")}) show ${String(n)} waiver candidate(s) with a visible fate, ${String(WAIVER_FIT.history.minOutcomes)} needed`;
      warnings.push(
        `premium and demand stay on the cold-start tables: ${history}; ${String(runs.length)} of ${String(WAIVER_FIT.minRuns)} priced waiver runs logged`,
      );
    }
    return fit;
  } catch (e) {
    ctx.services.logger.warn("e5.premium_fit_unavailable", {
      error: e instanceof Error ? e.name : "unknown",
    });
    return null;
  }
}

/** The E5 arguments that decide whether a call prices the league's run as its feed means it. */
export interface WaiverRunArgs {
  readonly positions?: readonly string[] | undefined;
  readonly candidates?: readonly number[] | undefined;
  readonly horizon_weeks?: number | undefined;
  readonly look_ahead?: number | undefined;
  readonly phase: string;
  readonly value_source: string;
  readonly include_drop: boolean;
}

/**
 * Whether an E5 call priced the waiver RUN the way the league feed reads it (research 05 §1.2, §1.6
 * eval 3: each logged run's best `s` is "the best claimable player's surplus" — over the whole wire,
 * for my team, on the default horizon and value basis): no `positions` or `candidates` filter, no
 * `horizon_weeks` or `look_ahead`, `phase`/`value_source` auto, the drop counted, and the team the
 * call is about is my own team. Only such a call is logged: a K/D-ST slice (stream-kdef), a
 * hand-picked `candidates` list (injury-cascade) or a rival's team_id upserted the same run row and
 * biased the fitted Π (Stage C finding `waivers-run-log-overwritten`).
 */
export function pricesWholeWireRun(
  args: WaiverRunArgs,
  team: number,
  myTeam: number | null,
): boolean {
  return (
    myTeam !== null &&
    team === myTeam &&
    args.positions === undefined &&
    args.candidates === undefined &&
    args.horizon_weeks === undefined &&
    args.look_ahead === undefined &&
    args.phase === "auto" &&
    args.value_source === "auto" &&
    args.include_drop
  );
}

/** Logs the waiver run an E5 answer priced (priority mode, a known next run; plan 10 C5). */
export function logWaiverRun(
  ctx: ToolContext,
  season: number,
  data: {
    readonly mode_used: string;
    readonly next_run_at: string | null;
    readonly W: number;
    readonly candidates: readonly { readonly s: number }[];
  },
): void {
  const repo = ctx.services.waiverRuns;
  if (repo === undefined || data.mode_used !== "priority" || data.next_run_at === null) return;
  beforeSideEffect(ctx);
  try {
    repo.put(
      leagueRef(ctx).league_id,
      {
        season,
        run_at: data.next_run_at,
        W: data.W,
        surplus: data.candidates.map((c) => c.s).filter((x) => Number.isFinite(x)),
      },
      ctx.services.clock.nowIso(),
    );
  } catch {
    // a run the store refuses is skipped, never fatal to the answer
  }
}

/** E5 `espn_analyze_waivers`. */
export const analyzeWaiversTool = defineTool({
  name: "espn_analyze_waivers",
  description:
    "Waiver targets priced against waiver priority: premium of position k, surplus over the drop, claim/pass/marginal, claim and scramble lists; K/D-ST streams.",
  input: z.strictObject({
    team_id: teamIdSchema.optional(),
    mode: waiverModeSchema.default("auto"),
    positions: positionsSchema.optional(),
    candidates: playerIdsSchema.optional(),
    horizon_weeks: z
      .number()
      .int()
      .min(BOUNDS.horizonWeeks.min)
      .max(BOUNDS.horizonWeeks.max)
      .optional(),
    look_ahead: z.number().int().min(BOUNDS.lookAhead.min).max(BOUNDS.lookAhead.max).optional(),
    phase: waiverPhaseSchema.default("auto"),
    value_source: valueSourceSchema.default("auto"),
    include_drop: z.boolean().default(true),
    reserve: reserveSchema.default("none"),
    ...detailShape,
    ...analyticsFreshnessShape,
  }),
  data: waiversSchema,
  budget: "analytics",
  run: async (args, ctx) => {
    const inputs: InputStamp[] = [];
    const warnings: string[] = [];
    const allowStale = args.allow_stale === true;
    const league = await leagueOf(ctx, inputs, args);
    const w = weekOf(league, undefined);
    const team = teamOf(league, args.team_id);
    const settings = await settingsOf(ctx, inputs);
    const slots: RosterSlots = await slotsOf(ctx, inputs);
    const rules = await rulesOf(ctx, inputs);
    const p1 = ctx.options.toolset === "full";
    if (args.value_source === "ensemble" && !p1)
      warnings.push(
        "value_source ensemble needs EFF_TOOLSET=full: valued on ESPN's rest-of-season projection",
      );
    const rosters = await rostersOf(ctx, w, inputs, warnings, args, team);
    const mine: Roster | undefined = rosters.find((r) => r.team.team_id === team);
    if (mine === undefined) throw new EffError("NOT_FOUND");
    const pool = await candidatePool(ctx, w, args.positions, args.candidates, inputs);
    const stGot = await withinBudget(
      () => ctx.services.platform.getStandings(leagueRef(ctx), readOpts(ctx)),
      warnings,
    );
    const standings = stGot === null ? null : take(ctx, stGot, inputs);
    if (standings === null)
      warnings.push("standings unavailable: waiver rank unknown (cold-start premium at k = N/2)");
    const weeks = remainingWeeks(rules.playoffs, w);
    if (weeks.length === 0)
      throw new EffError("VALIDATION", { field: "week", reason: "season_over" });
    const kdstOnly = args.positions?.every((p) => KDST.has(p)) === true;
    // the pro schedule, for every call (Stage C findings waivers-lock-state-drop-candidates and
    // projection-ros-includes-week18): this week's kickoffs place the claim's run against the week's
    // games (which players a claim can still add or drop, and whether it reaches this week — the
    // engine's scheduled path), and ESPN's ROS total is read as E1 reads it (rosReadingOf)
    const ros = await rosReadingOf(ctx, league.ref.season, inputs, warnings, allowStale);
    const sched =
      ros === null ? null : await scheduleOf(ctx, league.ref.season, inputs, allowStale);
    let kdst: { schedule: ProSchedule; implied_totals: ImpliedTotal[] } | null = null;
    if (kdstOnly && sched !== null)
      kdst = {
        schedule: sched.schedule,
        implied_totals: impliedTotals(
          ctx,
          sched.schedule,
          league.ref.season,
          weeks.slice(0, 3),
          inputs,
          allowStale,
        ),
      };
    const gsis = (p: PlatformPlayer): string | null =>
      crosswalkOf(ctx, p.ref.id, p.position_id).gsis_id;
    const minePlayers = mine.entries.map((e) =>
      waiverPlayerOf(e.player, e.slot_id, e.lineup_locked, weeks, gsis(e.player), ros),
    );
    const candidates: WaiverCandidateInput[] = pool
      .filter((p) => p.status === "FREEAGENT" || p.status === "WAIVERS")
      .slice(0, BOUNDS.waiverCandidates.max)
      .map((p) => ({
        ...waiverPlayerOf(p, 20, false, weeks, gsis(p), ros),
        status: p.status === "WAIVERS" ? "WAIVERS" : "FREEAGENT",
        waiver_process_date: p.waiver_process_date,
        percent_change: p.ownership?.percent_change ?? null,
      }));
    if (candidates.length === 0) throw new EffError("NOT_FOUND");
    const rivals = (standings?.teams ?? [])
      .filter((t) => t.team_id !== team)
      .map((t) => {
        const r = rosters.find((x) => x.team.team_id === t.team_id);
        return {
          team_id: t.team_id,
          waiver_rank: t.waiver_rank,
          ir_blocked: r === undefined ? false : auditIr(seatsOf(r), slots).invalid,
        };
      });
    const myRank = standings?.teams.find((t) => t.team_id === team)?.waiver_rank ?? null;
    // Phase 3 (plan 10 C5; research 05 §1.6 eval 3) and Stage C (R6-3): the premium re-solved from
    // this league's own feed — its previous seasons' transactions (demand curve and drift, from the
    // first call), else a regular season of runs E5 priced (store); until then the cold-start table,
    // said once with its measured miss
    const premiumFit = await leaguePremiumFit(ctx, league, rules, w, standings, warnings);
    const p0Request = {
      roster: slots,
      rules,
      league_size: league.size,
      week: w,
      weeks,
      mine: minePlayers,
      candidates,
      k: myRank,
      rivals,
      mode: args.mode,
      phase: args.phase,
      positions: args.positions ?? null,
      ...(args.horizon_weeks === undefined ? {} : { horizon_weeks: args.horizon_weeks }),
      ...(args.look_ahead === undefined ? {} : { look_ahead: args.look_ahead }),
      include_drop: args.include_drop,
      settings,
      schedule: sched?.schedule ?? null,
      kdst,
      adds_remaining: null,
      premium_fit: premiumFit,
      clock: ctx.services.clock,
      pacer: ctx.pacer,
      // one 8 s CPU budget per call (Stage C finding analytics-cpu-deadline-per-run)
      deadline_ms: cpuDeadlineOf(ctx),
      inputs: toDataInputs(inputs, ctx.nowMs),
    };
    // PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; D11): the claim list is advice only; a write module
    // would hand it to its transaction prepare step (plan 07 §3.F F3–F4). No claim is ever sent here.
    // P1 (EFF_TOOLSET=full): E1 values (`ensemble`), usage signals, rival rosters, Sleeper's
    // secondary trend, the learned mechanics and FAAB bidding (plan 07 E5 P1; plan 10 B3, B4)
    const out = !p1
      ? await analyzeWaivers(p0Request)
      : await (async () => {
          const ensemble = args.value_source !== "espn_ros";
          let mineV = minePlayers;
          let candV = candidates;
          if (ensemble) {
            const proj = await projectMany(
              ctx,
              [...mine.entries.map((e) => e.player), ...pool]
                .filter((p, i, xs) => xs.findIndex((x) => x.ref.id === p.ref.id) === i)
                .map((p) => ({ p, gsis: gsis(p) })),
              {
                league,
                settings,
                schedule: sched?.schedule ?? { season: league.ref.season, games: [], teams: [] },
                horizon: "ros",
                week: w,
                seed: seedOf(ctx, undefined, ["e5p1", league.ref.season, w, team].join("|")),
                allowStale,
              },
              inputs,
              warnings,
            );
            const e1 = (id: number, fallback: readonly (number | null)[]): (number | null)[] => {
              const pp = proj.byId.get(id);
              if (pp === undefined) return [...fallback];
              return weeks.map(
                (x, i) => pp.weeks.find((y) => y.week === x)?.dist.mean ?? fallback[i] ?? null,
              );
            };
            mineV = minePlayers.map((m) => ({ ...m, weekly: e1(m.player_id, m.weekly) }));
            candV = candidates.map((c) => ({ ...c, weekly: e1(c.player_id, c.weekly) }));
          }
          const extras = waiverP1Extras(
            ctx,
            { league, settings, slots, rules, w },
            candV,
            rosters,
            team,
            standings,
            weeks,
            inputs,
            warnings,
            allowStale,
            ros,
          );
          return analyzeWaiversP1({
            ...p0Request,
            mine: mineV,
            candidates: candV,
            value_basis: ensemble ? "ensemble" : "espn_ros",
            usage: extras.usage,
            rival_rosters: extras.rival_rosters,
            sleeper_trend: extras.sleeper_trend,
            mechanics: extras.mechanics,
            faab: extras.faab === null ? null : { ...extras.faab, reserve: args.reserve },
            // what the call has left after E1's ensemble runs above
            deadline_ms: cpuDeadlineOf(ctx),
            inputs: toDataInputs(inputs, ctx.nowMs),
          });
        })();
    // the run this call priced joins the league's feed (priority mode only; the newest whole-wire
    // call of my own team before the run wins — best-effort, a busy store skips it)
    if (pricesWholeWireRun(args, team, league.my_team?.team_id ?? ctx.services.configuredTeamId))
      logWaiverRun(ctx, league.ref.season, out.data);
    const full = args.detail === "full";
    const data = full
      ? out.data
      : {
          ...out.data,
          candidates: out.data.candidates.map((c) => ({ ...c, demand: { ...c.demand, q_i: [] } })),
        };
    if (!full && out.data.candidates.some((c) => c.demand.q_i.length > 0))
      warnings.push("demand.q_i per rival is listed with detail full");
    return {
      data,
      inputs,
      warnings: [...warnings, ...out.warnings],
      estimate: true,
      partial: out.partial === true || warnings.some((x) => x.startsWith("partial:")),
      listKey: "candidates",
      trims: waiverTrims(data.candidates.length),
      week: w,
    };
  },
});

/**
 * E5's budget steps (plan 07 C8; [A-1] 10 candidates at compact): the rec's confidence inputs go
 * (`data.inputs` carries them), then candidates leave from the end one at a time (the engine orders
 * them best first) — the id lists keep naming every candidate.
 */
export function waiverTrims(total: number): readonly AnalyticsTrim[] {
  return [
    REC_INPUTS_TRIM,
    (d) => {
      const list = arr(d, "candidates");
      if (list.length <= 1) return null;
      const kept = list.slice(0, list.length - 1);
      return {
        data: { ...(d as Obj), candidates: kept },
        warning: `candidates truncated to ${String(kept.length)} of ${String(total)} to fit the 10000-character budget; claim_list, marginal and scramble_list still name every candidate`,
        key: "candidates",
      };
    },
  ];
}
