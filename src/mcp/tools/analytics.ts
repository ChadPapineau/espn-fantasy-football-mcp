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
import type { WaiverRunRecord } from "../../domain/analytics/types.js";
import { seededRng, seedFrom } from "../../domain/clock.js";
import { teamOfProTeamId } from "../../domain/crosswalk/teams.js";
import { remainingWeeks, regularSeasonWeeks } from "../../domain/league/rules.js";
import { auditIr, seatsOf } from "../../domain/league/roster.js";
import { kickoffMsOf, lockPlan } from "../../domain/league/schedule.js";
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
import { beforeSideEffect, defineTool, type ToolContext } from "../define.js";
import { remainingDeadline } from "../call.js";
import {
  bankedPoints,
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
import { playoffAliveOf, projectMany } from "./p1-common.js";
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
 * configuration, changelog R5) — less the CPU this call has already spent, inside its batches and
 * outside them (call.ts). Read it when the run starts: every run of one call draws on the same
 * budget, so E1's v1 + v2 and E3's season chain stop at 8 s in total (Stage C finding
 * `analytics-cpu-deadline-per-run`).
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

/** Said when the call's CPU deadline passed before v2-opportunity could run (v1-ensemble serves). */
export const V2_SKIPPED_DEADLINE_WARNING =
  "partial: v2-opportunity not run, the CPU deadline came first (v1-ensemble serves)";

/**
 * The least CPU a call must have left for v2-opportunity to start: its dataset reads alone are a
 * share of the deadline on a slow CPU (a roster call's, at 30× emulated, ~1.9 s), and with less left
 * it reads for players it then skips (Stage C finding analytics-cpu-deadline-per-run).
 */
export const V2_MIN_LEFT_MS = ANALYTICS_CPU_DEADLINE_MS / 4;

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
    /**
     * A `ros` horizon's last week (default the league's final scoring period): a caller that needs
     * fewer weeks — E3 `season` under the regular horizon fits the regular season only — samples
     * no week it would discard (each week is ~1 000 samples per player).
     */
    readonly last_week?: Week;
  },
  inputs: InputStamp[],
  warnings: string[],
): Promise<ProjectionOutcome> {
  const season = o.league.ref.season;
  // a call with no CPU left reads no trailing line (E1 plans every target thin and runs no v2):
  // the reads outside every batch count against the deadline too (Stage C finding
  // analytics-cpu-deadline-per-run — a 30× slower CPU took a chunked season call far past 8 s)
  const trailing =
    cpuDeadlineOf(ctx) === 0
      ? new Map<number, TrailingLine[]>()
      : trailingFor(ctx, subjects, season, o.week, inputs, warnings, o.allowStale);
  const lastWeek = Math.max(o.week, o.last_week ?? o.league.clock.final_scoring_period);
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
  const left = cpuDeadlineOf(ctx);
  if (ctx.options.toolset === "full" && left !== null && (left === 0 || left < V2_MIN_LEFT_MS)) {
    warnings.push(V2_SKIPPED_DEADLINE_WARNING);
    out = { ...v1, partial: true };
  } else if (ctx.options.toolset === "full")
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
          deadline: () => cpuDeadlineOf(ctx),
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

/** One number to `places` decimals (a non-number, an integer or a non-finite value as it is; −0 → 0). */
function toPlaces(x: unknown, places: number): unknown {
  if (typeof x !== "number" || !Number.isFinite(x) || Number.isInteger(x)) return x;
  const f = 10 ** places;
  const r = Math.round(x * f) / f;
  return r === 0 ? 0 : r;
}

/** A Dist with its points to 0.1 and its zero mass to 0.01 (rounding is monotone: the order holds). */
function coarseDist(d: unknown): unknown {
  if (typeof d !== "object" || d === null) return d;
  const o = d as Obj;
  return {
    ...o,
    mean: toPlaces(o.mean, 1),
    p10: toPlaces(o.p10, 1),
    p25: toPlaces(o.p25, 1),
    p50: toPlaces(o.p50, 1),
    p75: toPlaces(o.p75, 1),
    p90: toPlaces(o.p90, 1),
    p_zero: toPlaces(o.p_zero, 2),
  };
}

/** One E1 week row at the precision a decision reads: points to 0.1, probabilities to 0.01. */
function coarseWeek(w: unknown): unknown {
  if (typeof w !== "object" || w === null) return w;
  const o = w as Obj;
  const inputs = o.inputs as Obj | null | undefined;
  const dis = o.disagreement as Obj | null | undefined;
  return {
    ...o,
    points: coarseDist(o.points),
    p_active: toPlaces(o.p_active, 2),
    implied_total: toPlaces(o.implied_total, 1),
    ...(typeof inputs === "object" && inputs !== null
      ? {
          inputs: {
            ...inputs,
            espn: toPlaces(inputs.espn, 1),
            own: toPlaces(inputs.own, 1),
            weight_espn: toPlaces(inputs.weight_espn, 2),
          },
        }
      : {}),
    ...(typeof dis === "object" && dis !== null
      ? { disagreement: { ...dis, pct: toPlaces(dis.pct, 2) } }
      : {}),
  };
}

/** E1's warning once every assumption line went to fit the budget (projectionTrims step 8). */
export const EVERY_ASSUMPTION_OMITTED =
  "projections[].assumptions omitted to fit the budget, shared and own (detail full, fewer players: stated)";

/**
 * E1's budget steps (plan 07 C8 — 10 000 characters; plan 07 §5.2 — `compact` keeps every
 * identifier, every decision number, every Dist): a whole roster (≤ 16 players) at the default
 * detail is answered for every player, the rows thinned in this order before any player is dropped —
 * (1) an assumption several projections share is stated ONCE in warnings[] with the player ids it
 * applies to, or those it does not (lossless); (2) drivers beyond each player's largest go; (3) weeks beyond the first go
 * (the next game's row stays); (4) drivers go; (5) for a horizon with a rest-of-season total, the
 * weekly rows go and `ros_total` carries the horizon; (6) the numbers go to the precision a decision
 * reads — points to 0.1, probabilities to 0.01 (every Dist, comparator and flag stays); (7) the
 * assumptions only one player carries go, their player ids said; (8) the shared ones' lines go
 * from warnings[] too, one line saying every assumption was omitted; only then (9) players leave
 * from the end ONE at a time. Before, the list was only halved: a 16-player roster came back as 8
 * (week) or 3 (ROS) of 16, and every Skill that projects a roster this way silently read part of it
 * (Stage C finding projections-roster-truncated); attempt 1 stopped at (5), and a 16-player roster
 * under `full` at horizon week — v2's rows are the longest — still lost a player on the seeded
 * fixture league in 68 of its 130 sets; attempt 2 stopped at (7), and in a week with no market line
 * yet (most rows carry "no market line", the state the weekly Skill meets on a Tuesday) 2–12 of 130
 * sets still lost one. Every warning counts against the budget, so each is short, a shared
 * assumption names the players it does NOT apply to when that list is shorter ("every projection
 * but …"), and (8) trades every assumption line for one. Each step says what it removed and how to
 * get it. Under `detail: "full"` (every week asked for) only the lossless step (1) runs before (9).
 */
export function projectionTrims(total: number, full = false): readonly AnalyticsTrim[] {
  const assumptionKey = (a: { text: string; revisit_trigger: string }): string =>
    `${a.text}\u0000${a.revisit_trigger}`;
  // each warnings[] line the assumption steps wrote, by key (step 8 trades them all for one)
  const assumptionLines = new Map<string, number>();
  // one shared assumption per step (each its own warnings[] line, ≤ the envelope's 400 chars),
  // the largest saving first; one whose line would not fit stays on its rows. Its players are named,
  // or — when shorter — the players it does not apply to ("every projection but …")
  const hoist: AnalyticsTrim = (d) => {
    const rows = projRows(d);
    const whom = (ids: readonly number[]): string => {
      const named = `projections ${ids.map(String).join(", ")}`;
      const others = rows.filter((r) => r.player_id === null || !ids.includes(r.player_id));
      if (others.some((r) => r.player_id === null)) return named;
      const but =
        others.length === 0
          ? "every projection"
          : `every projection but ${others.map((r) => String(r.player_id)).join(", ")}`;
      return but.length < named.length ? but : named;
    };
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
      const line = `assumption of ${whom(h.ids)}: ${h.a.text} (revisit when ${h.a.revisit_trigger})`;
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
    const key = `projection_assumption:${hoisted}`;
    assumptionLines.set(key, best.line.length);
    return { data: withRows(d, thinned), warning: best.line, key };
  };
  // the last player goes, one at a time — and the warning names every player left out, so the
  // caller asks for exactly them (Stage C finding projections-roster-truncated: "pass fewer players"
  // named nobody, and no Skill could tell whom the answer lacked)
  const omitted: number[] = [];
  const dropLast: AnalyticsTrim = (d) => {
    const rows = projRows(d);
    if (rows.length <= 1) return null;
    const last = rows[rows.length - 1];
    if (last?.player_id !== null && last?.player_id !== undefined) omitted.unshift(last.player_id);
    const kept = rows.slice(0, -1);
    const ids = omitted.map(String).join(", ");
    const named = `projections truncated to ${String(kept.length)} of ${String(total)} to fit the budget; call again with player_ids [${ids}] for the rest`;
    return {
      data: withRows(d, kept),
      warning:
        named.length <= WARNING_MAX_CHARS
          ? named
          : `projections truncated to ${String(kept.length)} of ${String(total)} to fit the budget; pass the players not returned (player_ids in batches) for the rest`,
      key: "projections",
    };
  };
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
          "projections[].drivers cut to each player's largest to fit the budget (detail full, fewer players: all)",
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
          "projections[].weeks cut to the first to fit the budget (ros_total kept; detail full, fewer players: every week)",
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
        warning: "projections[].drivers omitted to fit the budget (fewer players show them)",
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
          "projections[].weeks omitted to fit the budget: ros_total carries the horizon (fewer players, or horizon week: weekly rows)",
        key: "projection_weeks",
      };
    },
    // the precision a decision reads: a tenth of a point (a coin flip is several points wide)
    (d) => {
      const rows = projRows(d);
      const coarse = rows.map((r) => ({
        ...r,
        weeks: r.weeks.map(coarseWeek),
        ros_total: coarseDist(r.ros_total),
      }));
      if (JSON.stringify(coarse) === JSON.stringify(rows)) return null;
      return {
        data: withRows(d, coarse),
        warning: "projections[] numbers rounded to fit the budget (points 0.1, probabilities 0.01)",
        key: "projection_precision",
      };
    },
    // an assumption only one player carries (the shared ones are in warnings[] already)
    (d) => {
      const rows = projRows(d);
      const ids = rows
        .filter((r) => r.player_id !== null && r.assumptions.length > 0)
        .map((r) => String(r.player_id));
      if (ids.length === 0) return null;
      const tail = " to fit the budget (detail full, fewer players: stated)";
      const named = `projections[].assumptions of ${ids.join(", ")} omitted${tail}`;
      const warning =
        named.length <= WARNING_MAX_CHARS
          ? named
          : `projections[].assumptions of ${String(ids.length)} players omitted${tail}`;
      assumptionLines.set("projection_assumptions", warning.length);
      return {
        data: withRows(
          d,
          rows.map((r) => (r.player_id === null ? r : { ...r, assumptions: [] })),
        ),
        warning,
        key: "projection_assumptions",
      };
    },
    // the shared assumptions' lines (step 1) go too: one line for every assumption line written —
    // taken only when it is shorter than the lines it stands for
    (d) => {
      const shared = [...assumptionLines.keys()].filter((k) => k !== "projection_assumptions");
      if (shared.length === 0) return null;
      const warning = EVERY_ASSUMPTION_OMITTED;
      let saved = 0;
      for (const n of assumptionLines.values()) saved += n + 3;
      if (saved <= warning.length + 3) return null;
      assumptionLines.clear();
      return { data: d, warning, key: "projection_assumptions", dropKeys: shared };
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

/**
 * Season standings from the schedule's results (when the standings view is not cached), the played
 * regular-season games and the remaining ones — each remaining game carrying the scoring periods its
 * matchup period spans (`matchupPeriods`, `scheduleSettings.matchupPeriods`), so a two-week period is
 * simulated as two weeks of points, never one (Stage C finding season-sim-multiweek-rounds-split).
 */
export function standingsFromMatchups(
  matchups: readonly Matchup[],
  regularPeriods: number | null,
  matchupPeriods: Readonly<Record<string, readonly number[]>> = {},
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
      const span = matchupPeriods[String(m.matchup_period)]?.length ?? 1;
      remaining.push({
        period: m.matchup_period,
        matchup_id: m.matchup_id,
        home: m.home.team_id,
        away: m.away.team_id,
        ...(span > 1 ? { weeks: span } : {}),
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
  const derived = standingsFromMatchups(matchups, regular, rules.playoffs.matchup_periods);
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
    // a later week of a multi-week period: its earlier weeks' points are carried into P(win), the
    // mode and the coin flips — the period's, never a 0–0 start (Stage C finding
    // matchup-multiweek-prior-points-ignored; the engine says the carried score)
    const banked = bankedPoints(matchups, rules, w, team);
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
      banked: banked === null ? null : { me: banked.me, opponent: banked.opp },
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
export type AnalyticsTrim = (d: unknown) => {
  data: unknown;
  warning: string;
  key: string;
  dropKeys?: readonly string[];
} | null;

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
  // the usable weeks after the claim week, playoff weeks weighted by P(alive) under full (plan 07
  // E5's W bullet, changelog R5-1) — fractional once weighted, an integer at P0
  W: z.number().min(0).max(BOUNDS.week.max),
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

/** The most pool pages one E5 call reads (plan 07 E5 "Data: C2 (≤ 3 pages)"). */
export const E5_POOL_PAGES = 3;
/** One position's page: its best 25 available players by ESPN's rest-of-season projection. */
export const E5_POSITION_PAGE = 25;

/** The order positions are paged in (and interleaved) when no flex slot names the market. */
const MARKET_ORDER = ["RB", "WR", "TE", "QB"];
const marketRank = (p: string): number => {
  const i = MARKET_ORDER.indexOf(p);
  return i === -1 ? MARKET_ORDER.length : i;
};

/**
 * E5's default market when the call names neither positions nor candidates: the league's widest
 * flex slot (FLEX → RB, WR, TE; OP → QB too) read as ONE page — ESPN's pool filter takes the slot,
 * so the flex market costs the single request the old all-position page cost — else, in a league
 * with no flex slot, its starting positions other than K and D/ST (stream-kdef names those), one
 * page each, at most E5_POOL_PAGES of them.
 */
export function defaultWaiverMarket(slots: Pick<RosterSlots, "slots">): {
  readonly slot: string | null;
  readonly positions: readonly string[];
} {
  let widest: RosterSlots["slots"][number] | null = null;
  for (const s of slots.slots)
    if (
      s.class === "flex" &&
      s.count > 0 &&
      s.name !== "" &&
      (widest === null || s.eligible_positions.length > widest.eligible_positions.length)
    )
      widest = s;
  if (widest !== null) return { slot: widest.name, positions: widest.eligible_positions };
  const starters = new Set<string>();
  for (const s of slots.slots)
    if (s.class === "starter" && s.count > 0)
      for (const p of s.eligible_positions) if (!KDST.has(p)) starters.add(p);
  return {
    slot: null,
    positions: [...starters]
      .sort((a, b) => marketRank(a) - marketRank(b) || (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, E5_POOL_PAGES),
  };
}

/**
 * The players E5 prices. Named `candidates` are read by id. With no positions, the default market
 * (defaultWaiverMarket: the flex slot's page, said in a warning); with ≤ E5_POOL_PAGES positions,
 * one page per position — each its best E5_POSITION_PAGE available players by ESPN's rest-of-season
 * projection — interleaved so every position enters the engine's 25; with more, one page of every
 * position filtered to them (said). Before, the default call read ONE 50-row page of EVERY
 * position, which ESPN's ROS totals fill with backup QBs, kickers and D/STs (fx-10h: 25 TQB and 7 QB
 * in it), so the waivers and weekly Skills' main call never priced the RB/WR targets they had just
 * surfaced (Stage C finding skills-waivers-default-pool-wrong-market). A page after the first that
 * the call's budget stops leaves the partial line.
 */
export async function candidatePool(
  ctx: ToolContext,
  w: Week,
  positions: readonly string[] | undefined,
  ids: readonly number[] | undefined,
  inputs: InputStamp[],
  slots: Pick<RosterSlots, "slots">,
  warnings: string[],
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
  const page = async (position: string | null, limit: number) => {
    const got = await ctx.services.platform.listPlayers(
      leagueRef(ctx),
      { status: "AVAILABLE", position, sort: "projection_ros", week: w, injured: null },
      { limit, offset: 0 },
      readOpts(ctx),
    );
    return take(ctx, got, inputs).items;
  };
  const market = positions === undefined ? defaultWaiverMarket(slots) : { slot: null, positions };
  const wanted = market.positions;
  const fits = (p: PlatformPlayer): boolean =>
    wanted.includes(p.position) || p.eligible_slots.some((x) => wanted.includes(x));
  if (market.slot !== null) {
    warnings.push(
      `pool: the ${market.slot} market (${wanted.join(", ")}) — one page by ESPN's rest-of-season projection; pass positions for QB, K or D/ST`,
    );
    return (await page(market.slot, 50)).filter(fits);
  }
  if (wanted.length === 0) return [...(await page(null, 50))];
  if (wanted.length > E5_POOL_PAGES) {
    warnings.push(
      `${String(wanted.length)} positions asked: one page of every position by ESPN's rest-of-season projection, filtered to them (pass at most ${String(E5_POOL_PAGES)} positions for a page each)`,
    );
    return (await page(null, 50)).filter(fits);
  }
  if (positions === undefined)
    warnings.push(
      `pool: ${wanted.join(", ")} — one page each by ESPN's rest-of-season projection (pass positions for K or D/ST)`,
    );
  const pages: PlatformPlayer[][] = [];
  for (const [i, pos] of wanted.entries()) {
    // the first page is the call's market; a later one the budget stops leaves the partial line
    const got =
      i === 0
        ? await page(pos, E5_POSITION_PAGE)
        : await withinBudget(() => page(pos, E5_POSITION_PAGE), warnings);
    if (got !== null) pages.push(got.filter(fits));
  }
  const out: PlatformPlayer[] = [];
  const seen = new Set<number>();
  for (let r = 0; pages.some((pg) => r < pg.length); r++)
    for (const pg of pages) {
      const p = pg[r];
      if (p !== undefined && !seen.has(p.ref.id)) {
        seen.add(p.ref.id);
        out.push(p);
      }
    }
  return out;
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
    // one observation per fantasy week (weeklyRunFeed), the pro schedule placing each run in its
    // week (the call's memoised read — no request once the dataset is refreshed)
    const logged = repo === undefined ? [] : repo.list(leagueRef(ctx).league_id, season);
    const sched =
      logged.length === 0
        ? null
        : await withinBudget(() => scheduleOf(ctx, season, [], true), []).catch(() => null);
    const runs = weeklyRunFeed(logged, sched?.schedule ?? null);
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
        `premium and demand stay on the cold-start tables: ${history}; ${String(runs.length)} of ${String(WAIVER_FIT.minRuns)} weeks of priced waiver runs logged`,
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

/**
 * Logs the waiver run an E5 answer priced (priority mode, a known next run; plan 10 C5): the
 * surplus of its CLAIMABLE players only — the WAIVERS candidates a claim spends priority on (research
 * 05 §1.2: "the best claimable player's surplus") — and nothing for a post-run call, whose
 * candidates are free agents (an add costs no priority) and whose `next_run_at` is the NEXT run:
 * before, every candidate's `s` was logged, a post-run free-agent scramble included, as an
 * observation of the run after it (Stage C finding waivers-surplus-feed-per-run). Runs are stored as
 * the store keys them (one row per run, the newest call before it wins); the feed reads one
 * observation per fantasy week (weeklyRunFeed).
 */
export function logWaiverRun(
  ctx: ToolContext,
  season: number,
  data: {
    readonly mode_used: string;
    readonly phase?: string;
    readonly next_run_at: string | null;
    readonly W: number;
    readonly candidates: readonly { readonly s: number; readonly status?: string }[];
  },
): void {
  const repo = ctx.services.waiverRuns;
  if (repo === undefined || data.mode_used !== "priority" || data.next_run_at === null) return;
  if (data.phase === "post_run") return;
  const surplus = data.candidates
    .filter((c) => c.status === undefined || c.status === "WAIVERS")
    .map((c) => c.s)
    .filter((x) => Number.isFinite(x));
  if (surplus.length === 0) return;
  beforeSideEffect(ctx);
  try {
    repo.put(
      leagueRef(ctx).league_id,
      { season, run_at: data.next_run_at, W: data.W, surplus },
      ctx.services.clock.nowIso(),
    );
  } catch {
    // a run the store refuses is skipped, never fatal to the answer
  }
}

/** A Tuesday 09:00 UTC (04:00/05:00 ET, after Monday night's game): the fallback week boundary. */
const FEED_WEEK_ANCHOR_MS = Date.parse("2020-01-07T09:00:00.000Z");
const FEED_WEEK_MS = 7 * 24 * 3600 * 1000;

/**
 * The fantasy week a waiver run belongs to: within the season — from a week before its first known
 * kickoff (the run before week 1) to its last — the first scoring period whose last known kickoff is
 * at or after the run (a run after Monday night's game serves the coming week); before or after the
 * season, or without the pro schedule, the Tuesday-to-Tuesday week it falls in (a preseason run
 * after the draft is its own week). Exported for tests.
 */
export function feedWeekOf(
  runMs: number,
  lastKickoffs: readonly (readonly [Week, number])[],
  firstKickoffMs: number | null,
): string {
  if (firstKickoffMs !== null && runMs > firstKickoffMs - FEED_WEEK_MS)
    for (const [week, last] of lastKickoffs) if (last >= runMs) return `w${String(week)}`;
  return `t${String(Math.floor((runMs - FEED_WEEK_ANCHOR_MS) / FEED_WEEK_MS))}`;
}

/**
 * The league's priced waiver runs as the fitted premium reads them (research 05 §1.2 — the weekly
 * DP's surplus rate of the best weekly claim; plan 10 C5 "13 logged runs (one regular season)"): ONE
 * observation per fantasy week, the week's run whose best claimable surplus is the largest — the
 * week's main claim run; a later daily run holds the leftovers. One row per processing run made a
 * daily-processing league reach the 13-run threshold in about two weeks and biased the rate low
 * (Stage C finding waivers-surplus-feed-per-run). Chronological.
 */
export function weeklyRunFeed(
  runs: readonly WaiverRunRecord[],
  schedule: Pick<ProSchedule, "games"> | null,
): WaiverRunRecord[] {
  const last = new Map<Week, number>();
  for (const g of schedule?.games ?? []) {
    const k = kickoffMsOf(g);
    if (k !== null) last.set(g.week, Math.max(last.get(g.week) ?? Number.NEGATIVE_INFINITY, k));
  }
  const lastKickoffs = [...last.entries()].sort((a, b) => a[0] - b[0]);
  let first: number | null = null;
  for (const g of schedule?.games ?? []) {
    const k = kickoffMsOf(g);
    if (k !== null && (first === null || k < first)) first = k;
  }
  const best = (r: WaiverRunRecord): number =>
    r.surplus.reduce((m, x) => (Number.isFinite(x) && x > m ? x : m), Number.NEGATIVE_INFINITY);
  const byWeek = new Map<string, WaiverRunRecord>();
  for (const r of runs) {
    const ms = Date.parse(r.run_at);
    if (!Number.isFinite(ms)) continue;
    const key = feedWeekOf(ms, lastKickoffs, first);
    const cur = byWeek.get(key);
    if (cur === undefined || best(r) > best(cur)) byWeek.set(key, r);
  }
  return [...byWeek.values()].sort((a, b) => Date.parse(a.run_at) - Date.parse(b.run_at));
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
    const pool = await candidatePool(
      ctx,
      w,
      args.positions,
      args.candidates,
      inputs,
      slots,
      warnings,
    );
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
    // under full, playoff weeks are weighted by P(alive) from E3's season simulator under the
    // reading in use — W and every candidate's playoff-week value (plan 07 E5's W bullet; changelog
    // R5-1); weight 1 stays the P0 path's, said in its assumption. Before, full never passed it and
    // served W 12 / Π 26.95 where P(alive) 0.775 / 0.58 / 0.233 gives W 10.6 / Π 23.4 (Stage C finding
    // waivers-playoff-weeks-unweighted-full)
    const sims = { partial: false };
    const out = !p1
      ? await analyzeWaivers(p0Request)
      : await (async () => {
          const alive = await playoffAliveOf(
            ctx,
            {
              league,
              rules,
              team,
              w,
              standings,
              seed: seedOf(ctx, undefined, ["e5alive", league.ref.season, w, team].join("|")),
              args,
            },
            inputs,
            warnings,
          );
          sims.partial = alive.partial;
          if (alive.alive === null && weeks.some((x) => rules.playoffs.playoff_weeks.includes(x)))
            warnings.push(
              "season simulation unavailable: playoff weeks weighted 1 (P(alive) unknown)",
            );
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
            ...(alive.alive === null ? {} : { alive_by_week: alive.alive }),
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
      partial:
        out.partial === true || sims.partial || warnings.some((x) => x.startsWith("partial:")),
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
