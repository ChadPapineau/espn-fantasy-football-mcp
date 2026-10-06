// analytics-p1.ts — the season and roster engines as P1 tools (plan 07 §3.E, registered under
// EFF_TOOLSET=full; plan 10 B7, B9): E3 espn_analyze_matchup (`pre`/`live` H2H P(win) — live
// conditioning from the PRO SCHEDULE's game state, never the box score's period-level one; no locked
// seat is ever actionable — and `season`, the seeding simulator under the configured reading or
// `both` when passed explicitly, fitted from E1 team weeks when the rosters are readable, else the
// cold start — ADV OBJ-13), E4 espn_analyze_replacement (replacement level by allocation under this
// format), E8 espn_analyze_schedule (the week-by-week stress test weighted by E3's P(alive)) and E9
// espn_analyze_roster (bench construction and the IR section — first when the roster is invalid).
// League-wide players are valued at E1 v1's own point estimate (ESPN's weekly means, weight_espn =
// 1.0 — ADV OBJ-02) without sampling; E1 sampling runs only for the players a result is about, so a
// call stays inside the 8 s CPU deadline. Results are capped at 10 000 chars (C8), `meta.estimate`.
import { z } from "zod/v4";
import {
  analyzeMatchupWin,
  analyzeReplacement,
  analyzeRoster,
  analyzeSchedule,
  matchupPlayerOf,
  streamCandidates,
  teamWeekOf,
  type AuditPlayer,
  type HandcuffCase,
  type MatchupPlayer,
  type ReplacementPlayer,
  type TeamWeekProjection,
} from "../../domain/analytics/seasonRoster.js";
import { CASCADE } from "../../domain/analytics/phase2.js";
import { lineupPlayerOf, type LineupPlayer } from "../../domain/analytics/lineup.js";
import type { ProjectedPlayer } from "../../domain/analytics/projection.js";
import {
  seedingStatus,
  type MatchupWinData,
  type SeasonSimData,
} from "../../domain/analytics/types.js";
import { seededRng } from "../../domain/clock.js";
import { remainingWeeks, tradeDeadlineWeeks } from "../../domain/league/rules.js";
import { lockPlan } from "../../domain/league/schedule.js";
import type {
  LiveMatchup,
  Matchup,
  PlatformPlayer,
  ProSchedule,
  Roster,
  Standings,
  Week,
} from "../../domain/league/types.js";
import {
  BOUNDS,
  N_SIMS_MAX,
  analyticsFreshnessShape,
  detailShape,
  matchupModeSchema,
  pfDeltaSchema,
  positionsSchema,
  seasonHorizonSchema,
  seedSchema,
  seedingModeArgSchema,
  teamIdSchema,
  weekSchema,
  winProbMethodSchema,
} from "../bounds.js";
import { toDataInputs, type InputStamp } from "../envelope.js";
import { EffError } from "../errors.js";
import { defineTool, type ToolContext, type ToolOutput } from "../define.js";
import { cpuDeadlineOf, opponentIn, periodOf, project, seedOf, type Subject } from "./analytics.js";
import {
  crosswalkOf,
  isDegradable,
  leagueRef,
  readOpts,
  scheduleOf,
  take,
  teamOf,
  withinBudget,
} from "./common.js";
import {
  basicsOf,
  projectMany,
  required,
  runSeason,
  valueWeeks,
  type LeagueBasics,
} from "./p1-common.js";
import { rostersOf } from "./roster.js";
import {
  code,
  count,
  dist,
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
  week,
} from "./schemas.js";

// --- shared schema pieces ---------------------------------------------------------------------------

const assumptionSchema = z.strictObject({ text: serverText, revisit_trigger: serverText });
const seedingSchema = z.strictObject({
  mode_used: z.enum(["espn_rule", "points_only", "both"]),
  confirmed: z.boolean(),
});
const weekP = z.strictObject({ week, p: prob });
const marginalSchema = z.strictObject({ d_p_playoffs: z.number(), d_p_bye: z.number() });

/** The empty pro schedule a degraded call runs on (lock times unknown, said so). */
function emptySchedule(season: number): ProSchedule {
  return { season, games: [], teams: [] };
}

/** The pro schedule, or the empty one with a warning when this call cannot read it. */
async function scheduleOrEmpty(
  ctx: ToolContext,
  season: number,
  inputs: InputStamp[],
  warnings: string[],
  allowStale: boolean,
): Promise<ProSchedule> {
  const s = await withinBudget(() => scheduleOf(ctx, season, inputs, allowStale), warnings).catch(
    (e: unknown) => {
      if (!isDegradable(e)) throw e;
      return null;
    },
  );
  if (s === null) warnings.push("pro schedule unavailable: lock times and byes unknown");
  return s?.schedule ?? emptySchedule(season);
}

/** Subjects (platform player + crosswalk gsis id) of roster entries. */
function subjectsOf(ctx: ToolContext, players: readonly PlatformPlayer[]): Subject[] {
  return players.map((p) => ({ p, gsis: crosswalkOf(ctx, p.ref.id, p.position_id).gsis_id }));
}

/** LineupPlayers of one roster for week `w` from E1 and the lock plan at the call's instant. */
function lineupOf(
  ctx: ToolContext,
  roster: Roster,
  projected: ReadonlyMap<number, ProjectedPlayer>,
  schedule: ProSchedule,
  b: LeagueBasics,
  w: Week,
): { players: LineupPlayer[]; plan: ReturnType<typeof lockPlan> } {
  const plan = lockPlan(
    roster.entries.map((e) => ({
      player_id: e.player.ref.id,
      pro_team_id: e.player.pro_team_id,
      lineup_locked: e.lineup_locked,
    })),
    schedule,
    w,
    b.slots.lineup_lock_type,
    ctx.nowMs,
  );
  const players = roster.entries.map((e) => {
    const pw = projected.get(e.player.ref.id)?.weeks.find((x) => x.week === w);
    const lock = plan.players.find((x) => x.player_id === e.player.ref.id) ?? null;
    const d = pw?.dist ?? {
      mean: 0,
      p10: 0,
      p25: 0,
      p50: 0,
      p75: 0,
      p90: 0,
      p_zero: 1,
      basis: "position_cv" as const,
    };
    return lineupPlayerOf(
      e,
      {
        dist: d,
        p_active: pw?.p_active ?? null,
        role_games: projected.get(e.player.ref.id)?.projection.role_confidence_games ?? 0,
      },
      lock,
      crosswalkOf(ctx, e.player.ref.id, e.player.position_id).gsis_id,
    );
  });
  return { players, plan };
}

/** The reading a `seeding_mode` argument resolves to for one simulator call. */
function readingOf(ctx: ToolContext, arg: "config" | "espn_rule" | "points_only" | "both") {
  return arg === "config" ? ctx.services.seedingMode : arg;
}

// --- E3 espn_analyze_matchup ---------------------------------------------------------------------

const winBase = {
  p_win: prob,
  interval: z.tuple([prob, prob]),
  mu_m: z.number(),
  sigma_m: z.number(),
  mu_o: z.number(),
  sigma_o: z.number(),
  cov: z.number(),
  method: z.enum(["normal", "mc"]),
  basis: z.enum(["position_cv", "player_sim"]),
  live: z
    .strictObject({
      players_final: z.array(playerId).max(60),
      players_live: z
        .array(
          z.strictObject({
            player_id: playerId,
            points_so_far: z.number(),
            fraction_remaining: prob,
          }),
        )
        .max(60),
      players_pending: z.array(playerId).max(60),
      points_so_far: z.strictObject({ me: z.number(), opp: z.number() }),
    })
    .nullable(),
  espn_cross_check: z
    .strictObject({
      win_probability_espn: probNull,
      projected_live_espn: z.strictObject({
        me: z.number().nullable(),
        opp: z.number().nullable(),
      }),
    })
    .nullable(),
  actionable_slots: z.array(z.strictObject({ slot: slotName, lock_at: isoNull })).max(30),
  rec,
  inputs: inputsSchema,
};

export const readingSchema = z.strictObject({
  seeding_mode: z.enum(["espn_rule", "points_only"]),
  p_playoffs: prob,
  p_bye: prob,
  p_champion: probNull,
  seed_distribution: z.array(z.strictObject({ seed: count, p: prob })).max(20),
  p_alive_by_week: z.array(weekP).max(22),
  tiebreak_chain: z.array(code).max(10),
  cutoff: z.strictObject({
    seed_line: z.number(),
    wins_gap: z.number(),
    pf_gap: z.number(),
    pf_rank_needed: z.number().nullable(),
  }),
  marginal_values: z.strictObject({
    plus_1_win: marginalSchema,
    plus_pf_20: marginalSchema,
    plus_pf_40: marginalSchema,
    plus_pf_80: marginalSchema,
    plus_3_ppw: marginalSchema,
    sigma_x0_7: marginalSchema,
    sigma_x1_4: marginalSchema,
  }),
  pf_per_win: z.number().nullable(),
  clinch: z.strictObject({
    clinched: z.boolean(),
    eliminated: z.boolean(),
    magic_number: z.number().int().nullable(),
  }),
  scenarios_applied: z.array(serverText).max(10),
});

/** E3's tool data: `pre`/`live`, or `season` with the weekly model it ran on (plan 10 B9). */
export type MatchupToolData =
  | MatchupWinData
  | (SeasonSimData & { readonly weekly_model: "e1_fitted" | "cold_start" | "mixed" });

/** E3 data (plan 07 E3; MatchupAnalysisData), discriminated on `mode`. */
export const matchupSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("pre"), ...winBase }),
  z.strictObject({ mode: z.literal("live"), ...winBase }),
  z.strictObject({
    mode: z.literal("season"),
    seeding: seedingSchema,
    readings: z.array(readingSchema).max(2),
    divergence: z.strictObject({ p_playoffs_delta_between_readings: z.number() }).nullable(),
    playoff_pct_espn: probNull,
    division_aware: z.boolean(),
    n_sims: count,
    weekly_model: z.enum(["e1_fitted", "cold_start", "mixed"]),
    rec,
    inputs: inputsSchema,
  }),
]);

const scenarioSchema = z.union([
  z.strictObject({
    week: weekSchema,
    matchup_id: z.number().int().min(0).max(10_000),
    winner: z.union([teamIdSchema, z.literal("me")]),
  }),
  z.strictObject({ team_id: teamIdSchema, pf_delta: pfDeltaSchema }),
]);

/** The season sim's own matchups, or a RATE_LIMITED retry when this call's budget is gone. */
async function matchupsOf(
  ctx: ToolContext,
  inputs: InputStamp[],
  args: { readonly allow_stale?: boolean | undefined },
): Promise<readonly Matchup[]> {
  const got = await required(() =>
    ctx.services.platform.getMatchups(leagueRef(ctx), readOpts(ctx, args)),
  );
  return take(ctx, got, inputs);
}

/** The standings when this call can read them (the simulator falls back to the results). */
async function standingsOrNull(
  ctx: ToolContext,
  inputs: InputStamp[],
  warnings: string[],
): Promise<Standings | null> {
  const got = await withinBudget(
    () => ctx.services.platform.getStandings(leagueRef(ctx), readOpts(ctx)),
    warnings,
  ).catch((e: unknown) => {
    if (!isDegradable(e)) throw e;
    return null;
  });
  return got === null ? null : take(ctx, got, inputs);
}

/** E3 `espn_analyze_matchup`. */
export const analyzeMatchupTool = defineTool({
  name: "espn_analyze_matchup",
  description:
    "Head-to-head P(win) pre-week or live (final/live/pending, actionable slots), or the season race: P(playoffs), seeds, marginal values per reading.",
  input: z.strictObject({
    team_id: teamIdSchema.optional(),
    week: weekSchema.optional(),
    mode: matchupModeSchema.default("pre"),
    method: winProbMethodSchema.default("mc"),
    n_sims: z.number().int().min(BOUNDS.nSims.min).max(N_SIMS_MAX).optional(),
    seeding_mode: seedingModeArgSchema.default("config"),
    scenarios: z.array(scenarioSchema).max(BOUNDS.scenarios.max).optional(),
    horizon: seasonHorizonSchema.default("regular"),
    seed: seedSchema.optional(),
    ...analyticsFreshnessShape,
  }),
  data: matchupSchema,
  budget: "analytics",
  opaqueInput: {
    scenarios: "<=10 of {week, matchup_id, winner: team_id|'me'} or {team_id, pf_delta}",
  },
  run: async (args, ctx): Promise<ToolOutput<MatchupToolData>> => {
    const inputs: InputStamp[] = [];
    const warnings: string[] = [];
    const allowStale = args.allow_stale === true;
    const b = await basicsOf(ctx, inputs, args);
    const team = teamOf(b.league, args.team_id);
    const seed = seedOf(
      ctx,
      args.seed,
      ["e3", b.league.ref.season, b.w, team, args.mode, b.settings.settings_hash].join("|"),
    );
    if (args.mode === "season") {
      const matchups = await matchupsOf(ctx, inputs, args);
      const standings = await standingsOrNull(ctx, inputs, warnings);
      if (standings === null)
        warnings.push("standings unavailable: the season read from the results");
      // E1-fitted team weeks when every roster is readable this call (plan 10 B9), else cold start
      let projections: Map<number, TeamWeekProjection[]> | null = null;
      const rosters = await withinBudget(
        () => rostersOf(ctx, b.w, inputs, warnings, args, null),
        warnings,
      ).catch((e: unknown) => {
        if (!isDegradable(e)) throw e;
        return null;
      });
      const schedule = await scheduleOrEmpty(
        ctx,
        b.league.ref.season,
        inputs,
        warnings,
        allowStale,
      );
      if (rosters !== null && rosters.length >= 2) {
        const proj = await projectMany(
          ctx,
          subjectsOf(
            ctx,
            rosters.flatMap((r) => r.entries.map((e) => e.player)),
          ),
          {
            league: b.league,
            settings: b.settings,
            schedule,
            horizon: "week",
            week: b.w,
            seed,
            allowStale,
          },
          inputs,
          warnings,
        );
        projections = new Map();
        for (const r of rosters) {
          const lp = lineupOf(ctx, r, proj.byId, schedule, b, b.w).players;
          projections.set(r.team.team_id, [teamWeekOf(b.slots, lp, b.w)]);
        }
      } else warnings.push("rosters unavailable: the season uses the cold-start weekly model");
      const playoffPct = standings?.teams.find((t) => t.team_id === team)?.playoff_pct_espn ?? null;
      const out = await runSeason(ctx, {
        league: b.league,
        rules: b.rules,
        matchups,
        standings,
        me: team,
        w: b.w,
        seed,
        seeding_mode: args.seeding_mode,
        n_sims: args.n_sims ?? BOUNDS.nSimsSeason.default,
        marginal: true,
        ...(args.scenarios === undefined ? {} : { scenarios: args.scenarios }),
        through_playoffs: args.horizon === "through_playoffs",
        playoff_pct_espn: playoffPct,
        projections,
      });
      if (out === null)
        throw new EffError("VALIDATION", { field: "mode", reason: "no_playoff_field" });
      const weeklyModel = "weekly_model" in out ? out.weekly_model : "cold_start";
      if (!out.data.seeding.confirmed)
        warnings.push("seeding reading not confirmed: run the onboard Skill (eff setup --seeding)");
      const data: MatchupToolData = {
        ...out.data,
        weekly_model: weeklyModel,
        inputs: toDataInputs(inputs, ctx.nowMs),
      };
      return {
        data,
        inputs,
        warnings: [...warnings, ...out.warnings],
        estimate: true,
        partial: out.partial || warnings.some((x) => x.startsWith("partial:")),
        listKey: "readings",
        week: b.w,
      };
    }

    // pre / live: my lineup as set against the opponent's
    const rosters = await rostersOf(ctx, b.w, inputs, warnings, args, team);
    const mine = rosters.find((r) => r.team.team_id === team);
    if (mine === undefined) throw new EffError("NOT_FOUND");
    const matchups = await matchupsOf(ctx, inputs, args);
    const oppId = opponentIn(matchups, periodOf(b.rules, b.w), team);
    const opp = oppId === null ? undefined : rosters.find((r) => r.team.team_id === oppId);
    if (opp === undefined)
      throw new EffError("NOT_FOUND", { field: "week", reason: "no_opponent" });
    const schedule = await scheduleOrEmpty(ctx, b.league.ref.season, inputs, warnings, allowStale);
    const proj = await project(
      ctx,
      subjectsOf(
        ctx,
        [...mine.entries, ...opp.entries].map((e) => e.player),
      ),
      {
        league: b.league,
        settings: b.settings,
        schedule,
        horizon: "week",
        week: b.w,
        seed,
        allowStale,
      },
      inputs,
      warnings,
    );
    const projBy = new Map<number, ProjectedPlayer>(
      proj.players.map((x) => [x.target.player_id ?? 0, x]),
    );
    // live: ESPN's actual so far per player (the box score), the game state from the PRO schedule
    const actual = new Map<number, number | null>();
    if (args.mode === "live") {
      const box = await withinBudget(
        () => ctx.services.platform.getBoxScores(leagueRef(ctx), b.w, readOpts(ctx, args)),
        warnings,
      ).catch((e: unknown) => {
        if (!isDegradable(e)) throw e;
        warnings.push("espn:mBoxscore unavailable: points so far unknown (treated as 0)");
        return null;
      });
      for (const m of box === null ? [] : take(ctx, box, inputs))
        for (const side of [m.home, m.away])
          for (const e of side?.entries ?? [])
            actual.set(e.player.ref.id, e.actual?.applied_total ?? null);
    }
    const sideOf = (r: Roster): MatchupPlayer[] => {
      const { players, plan } = lineupOf(ctx, r, projBy, schedule, b, b.w);
      return players.map((p) =>
        matchupPlayerOf(
          p,
          plan.players.find((x) => x.player_id === p.player_id) ?? null,
          actual.get(p.player_id) ?? null,
        ),
      );
    };
    const liveGot = await withinBudget(
      () => ctx.services.platform.getLiveMatchups(leagueRef(ctx), b.w, readOpts(ctx, args)),
      warnings,
    ).catch((e: unknown) => {
      if (!isDegradable(e)) throw e;
      return null;
    });
    const liveRows: readonly LiveMatchup[] = liveGot === null ? [] : take(ctx, liveGot, inputs);
    const lm = liveRows.find((m) => m.home.team_id === team || m.away?.team_id === team);
    const meSide = lm === undefined ? null : lm.home.team_id === team ? lm.home : lm.away;
    const oppSide = lm === undefined ? null : lm.home.team_id === team ? lm.away : lm.home;
    const cross: MatchupWinData["espn_cross_check"] =
      meSide === null
        ? null
        : {
            win_probability_espn: meSide.win_probability_espn,
            projected_live_espn: {
              me: meSide.projected_live_espn,
              opp: oppSide?.projected_live_espn ?? null,
            },
          };
    if (cross === null) warnings.push("espn:mMatchupScore unavailable: espn_cross_check is null");
    const out = await analyzeMatchupWin({
      mode: args.mode,
      roster: b.slots,
      me: sideOf(mine),
      opponent: sideOf(opp),
      method: args.method,
      n_sims: args.n_sims ?? BOUNDS.nSims.default,
      espn_cross_check: cross,
      clock: ctx.services.clock,
      rng: seededRng(seed),
      deadline_ms: cpuDeadlineOf(ctx),
      inputs: toDataInputs(inputs, ctx.nowMs),
    });
    const data: MatchupToolData = { ...out.data, inputs: toDataInputs(inputs, ctx.nowMs) };
    return {
      data,
      inputs,
      warnings: [...warnings, ...proj.warnings, ...out.warnings],
      estimate: true,
      provisional: args.mode === "live",
      partial: out.partial || proj.partial || warnings.some((x) => x.startsWith("partial:")),
      listKey: "actionable_slots",
      week: b.w,
    };
  },
});

// --- E4 espn_analyze_replacement -----------------------------------------------------------------

const weekPoints = z.strictObject({ week, points: z.number() });

/** E4 data (plan 07 E4; ReplacementData) plus the valuation's assumptions (its `rec` is null). */
export const replacementSchema = z.strictObject({
  positions: z
    .array(
      z.strictObject({
        position,
        starter_baseline_weekly: z.array(weekPoints).max(22),
        starter_baseline_ros: z.number(),
        stream_baseline_weekly: z.array(weekPoints).max(22),
        curve: z.array(z.strictObject({ rank: count, vor: z.number() })).max(40),
        tiers: z
          .array(z.strictObject({ tier: count, player_ids: z.array(playerId).max(60) }))
          .max(20),
        streamability: z.number(),
        effective_starters: z.number(),
        flex_allocation_trace: z
          .array(z.strictObject({ slot: slotName, position_filled: position }))
          .max(60)
          .optional(),
      }),
    )
    .max(10),
  players: z
    .array(
      z.strictObject({
        player_id: playerId,
        name: playerName,
        position,
        vor_weekly: z.number().nullable(),
        vor_ros: dist,
        xvbd: z.number(),
        tier: count.nullable(),
      }),
    )
    .max(60),
  format_notes: z.strictObject({
    flex_split: z.strictObject({ rb: z.number(), wr: z.number(), te: z.number() }),
    qb_last_starter_vs_replacement_ppg: z.number().nullable(),
    streamable_positions: z.array(position).max(10),
  }),
  assumptions: z.array(assumptionSchema).max(20),
  rec: rec.nullable(),
  inputs: inputsSchema,
});

/** The pool page every league-wide engine reads (available players by ESPN's ROS, one request). */
async function poolOf(
  ctx: ToolContext,
  w: Week,
  inputs: InputStamp[],
  warnings: string[],
  position: string | null = null,
): Promise<readonly PlatformPlayer[]> {
  const got = await withinBudget(
    () =>
      ctx.services.platform.listPlayers(
        leagueRef(ctx),
        { status: "AVAILABLE", position, sort: "projection_ros", week: w, injured: null },
        { limit: 100, offset: 0 },
        readOpts(ctx),
      ),
    warnings,
  ).catch((e: unknown) => {
    if (!isDegradable(e)) throw e;
    warnings.push(
      "espn:kona_player_info unavailable: no free-agent pool (stream baselines proxied)",
    );
    return null;
  });
  return got === null ? [] : take(ctx, got, inputs).items;
}

/** A ReplacementPlayer at E1 v1's point estimate (ESPN's weekly means) for `weeks`. */
export function replacementPlayerOf(
  p: PlatformPlayer,
  weeks: readonly Week[],
  rostered: boolean,
): ReplacementPlayer {
  const v = valueWeeks(p, weeks);
  return {
    player_id: p.ref.id,
    name: p.name,
    position: p.position,
    rostered,
    weeks: weeks.map((w, i) => {
      const m = v[i];
      return m === null || m === undefined ? null : { mean: m, bye: w === p.bye_week };
    }),
  };
}

/** Every rostered player plus the pool page as E4 players (rostered first, duplicates dropped). */
function leaguePlayers(
  rosters: readonly Roster[],
  pool: readonly PlatformPlayer[],
  weeks: readonly Week[],
): ReplacementPlayer[] {
  const seen = new Set<number>();
  const out: ReplacementPlayer[] = [];
  for (const r of rosters)
    for (const e of r.entries)
      if (!seen.has(e.player.ref.id)) {
        seen.add(e.player.ref.id);
        out.push(replacementPlayerOf(e.player, weeks, true));
      }
  for (const p of pool)
    if (!seen.has(p.ref.id) && p.status !== "ONTEAM") {
      seen.add(p.ref.id);
      out.push(replacementPlayerOf(p, weeks, false));
    }
  return out;
}

type Obj = Record<string, unknown>;

/**
 * E4's budget steps before `players` is halved (plan 07 C8, §5.2): the flex trace goes, then the
 * weekly baselines keep their first three weeks (compact's own cut), then each curve keeps its top
 * ten ranks — each with a warning, never silently.
 */
export const REPLACEMENT_TRIMS: readonly ((
  d: unknown,
) => { data: unknown; warning: string; key: string } | null)[] = [
  (d) => {
    const ps = ((d as Obj).positions ?? []) as Obj[];
    if (!ps.some((p) => "flex_allocation_trace" in p)) return null;
    return {
      data: {
        ...(d as Obj),
        positions: ps.map((p) => {
          const { flex_allocation_trace: _drop, ...rest } = p;
          return rest;
        }),
      },
      warning: "positions[].flex_allocation_trace omitted to fit the budget",
      key: "flex_trace",
    };
  },
  (d) => {
    const ps = ((d as Obj).positions ?? []) as Obj[];
    const long = (k: string) => ps.some((p) => ((p[k] as unknown[] | undefined) ?? []).length > 3);
    if (!long("starter_baseline_weekly") && !long("stream_baseline_weekly")) return null;
    return {
      data: {
        ...(d as Obj),
        positions: ps.map((p) => ({
          ...p,
          starter_baseline_weekly: (
            (p.starter_baseline_weekly as unknown[] | undefined) ?? []
          ).slice(0, 3),
          stream_baseline_weekly: ((p.stream_baseline_weekly as unknown[] | undefined) ?? []).slice(
            0,
            3,
          ),
        })),
      },
      warning: "weekly baselines cut to the first three weeks to fit the budget",
      key: "weekly",
    };
  },
  (d) => {
    const ps = ((d as Obj).positions ?? []) as Obj[];
    if (!ps.some((p) => ((p.curve as unknown[] | undefined) ?? []).length > 10)) return null;
    return {
      data: {
        ...(d as Obj),
        positions: ps.map((p) => ({
          ...p,
          curve: ((p.curve as unknown[] | undefined) ?? []).slice(0, 10),
        })),
      },
      warning: "VOR curves cut to the top ten ranks to fit the budget",
      key: "curve",
    };
  },
];

/** E4 `espn_analyze_replacement`. */
export const analyzeReplacementTool = defineTool({
  name: "espn_analyze_replacement",
  description:
    "Replacement level by allocation under this league's slots and size: starter and stream baselines, VOR/xVBD curves, tiers, streamability.",
  input: z.strictObject({
    positions: positionsSchema.optional(),
    horizon: z.enum(["week", "ros"]).default("ros"),
    week: weekSchema.optional(),
    baseline: z.enum(["starter", "stream", "both"]).default("both"),
    ...analyticsFreshnessShape,
    ...detailShape,
  }),
  data: replacementSchema,
  budget: "analytics",
  run: async (args, ctx) => {
    const inputs: InputStamp[] = [];
    const warnings: string[] = [];
    const b = await basicsOf(ctx, inputs, args);
    const weeks =
      args.horizon === "week" ? [b.w] : remainingWeeks(b.rules.playoffs, b.w).slice(0, 22);
    if (weeks.length === 0)
      throw new EffError("VALIDATION", { field: "week", reason: "season_over" });
    const rosters = await required(() => rostersOf(ctx, b.w, inputs, warnings, args, null));
    const pool = await poolOf(ctx, b.w, inputs, warnings);
    const mine = rosters.find((r) => r.team.team_id === (b.league.my_team?.team_id ?? -1));
    const out = await analyzeReplacement({
      roster: b.slots,
      league_size: b.league.size,
      weeks,
      horizon: args.horizon,
      baseline: args.baseline,
      ...(args.positions === undefined ? {} : { positions: args.positions }),
      players: leaguePlayers(rosters, pool, weeks),
      ...(mine === undefined ? {} : { focus_player_ids: mine.entries.map((e) => e.player.ref.id) }),
      detail: args.detail,
      clock: ctx.services.clock,
      deadline_ms: cpuDeadlineOf(ctx),
      inputs: toDataInputs(inputs, ctx.nowMs),
    });
    return {
      data: {
        ...out.data,
        assumptions: [
          ...out.assumptions,
          {
            text: "every player at E1 v1's point estimate (ESPN's weekly means, weight_espn 1.0) with the engine's positional spread",
            revisit_trigger: "E1 moves weight_espn below 1 (plan 10 B14)",
          },
        ].slice(0, 20),
        inputs: toDataInputs(inputs, ctx.nowMs),
      },
      inputs,
      warnings: [...warnings, ...out.warnings],
      estimate: true,
      partial: out.partial || warnings.some((x) => x.startsWith("partial:")),
      listKey: "players",
      trims: REPLACEMENT_TRIMS,
      week: b.w,
    };
  },
});

// --- E8 espn_analyze_schedule --------------------------------------------------------------------

/** E8 data (plan 07 E8; ScheduleAnalysisData). */
export const scheduleAnalysisSchema = z.strictObject({
  seeding: seedingSchema,
  weeks: z
    .array(
      z.strictObject({
        week,
        lineup_pts: dist,
        holes: z
          .array(
            z.strictObject({
              slot: slotName,
              replacement_player_id: playerId.nullable(),
              cost: z.number(),
            }),
          )
          .max(20),
        bye_cluster_cost: z.number(),
        weight: z.strictObject({ p_alive: prob, importance: z.number().min(0).max(1) }),
      }),
    )
    .max(22),
  worst_weeks: z.array(week).max(22),
  fixes: z
    .array(
      z.strictObject({
        action: serverText,
        cost: z.number(),
        delta: z.number(),
        deadline: isoNull,
      }),
    )
    .max(20),
  playoff_weeks: z.strictObject({
    weeks: z.array(week).max(6),
    bye_seeds: count.nullable(),
    matchup_multipliers: z
      .array(z.strictObject({ player_id: playerId, multiplier: z.number(), shrink_w: prob }))
      .max(40),
    evidence_note: serverText,
    week17_rest_risk: z.strictObject({
      flagged_players: z.array(playerId).max(40),
      note: serverText,
    }),
  }),
  rec,
  inputs: inputsSchema,
});

/** E8 `espn_analyze_schedule`. */
export const analyzeScheduleTool = defineTool({
  name: "espn_analyze_schedule",
  description:
    "Week-by-week roster stress test: lineup strength, holes and bye-cluster costs, fixes, weighted by P(alive); playoff weeks and the week-17 flag.",
  input: z.strictObject({
    team_id: teamIdSchema.optional(),
    weeks: z
      .array(weekSchema)
      .min(1)
      .max(BOUNDS.week.max)
      .refine((a) => new Set(a).size === a.length, { message: "duplicate_weeks" })
      .optional(),
    include_playoffs: z.boolean().default(true),
    seed: seedSchema.optional(),
    ...analyticsFreshnessShape,
    ...detailShape,
  }),
  data: scheduleAnalysisSchema,
  budget: "analytics",
  run: async (args, ctx) => {
    const inputs: InputStamp[] = [];
    const warnings: string[] = [];
    const allowStale = args.allow_stale === true;
    const b = await basicsOf(ctx, inputs, args);
    const team = teamOf(b.league, args.team_id);
    const all = remainingWeeks(b.rules.playoffs, b.w, { playoffs: args.include_playoffs });
    const weeks = (args.weeks === undefined ? all : [...args.weeks].sort((a, c) => a - c)).filter(
      (w) => args.include_playoffs || !b.rules.playoffs.playoff_weeks.includes(w),
    );
    if (weeks.length === 0)
      throw new EffError("VALIDATION", { field: "weeks", reason: "season_over" });
    const rosters = await required(() => rostersOf(ctx, b.w, inputs, warnings, args, team));
    const mine = rosters.find((r) => r.team.team_id === team);
    if (mine === undefined) throw new EffError("NOT_FOUND");
    const schedule = await scheduleOrEmpty(ctx, b.league.ref.season, inputs, warnings, allowStale);
    const seed = seedOf(
      ctx,
      args.seed,
      ["e8", b.league.ref.season, b.w, team, b.settings.settings_hash].join("|"),
    );
    const from = Math.min(...weeks);
    const proj = await projectMany(
      ctx,
      subjectsOf(
        ctx,
        mine.entries.map((e) => e.player),
      ),
      {
        league: b.league,
        settings: b.settings,
        schedule,
        horizon: "ros",
        week: from,
        seed,
        allowStale,
      },
      inputs,
      warnings,
    );
    const pool = await poolOf(ctx, b.w, inputs, warnings);
    const streamPlayers = pool
      .filter((p) => p.status !== "ONTEAM")
      .map((p) => replacementPlayerOf(p, weeks, false));
    const positions = [...new Set(mine.entries.map((e) => e.player.position))];
    // P(alive) from E3 `season` under the reading in use (cold start; weight 1 when unreadable)
    const reading = readingOf(ctx, "config");
    let alive: { week: Week; p: number }[] | null = null;
    const mGot = await withinBudget(
      () => ctx.services.platform.getMatchups(leagueRef(ctx), readOpts(ctx, args)),
      warnings,
    ).catch((e: unknown) => {
      if (!isDegradable(e)) throw e;
      return null;
    });
    if (mGot !== null) {
      const sim = await runSeason(ctx, {
        league: b.league,
        rules: b.rules,
        matchups: take(ctx, mGot, inputs),
        standings: null,
        me: team,
        w: b.w,
        seed,
        seeding_mode: reading,
        n_sims: BOUNDS.nSims.default,
        marginal: false,
        through_playoffs: true,
      });
      alive = sim?.data.readings[0]?.p_alive_by_week.map((x) => ({ week: x.week, p: x.p })) ?? null;
    }
    if (alive === null)
      warnings.push("season simulation unavailable: every week weighted 1 (P(alive) unknown)");
    const out = await analyzeSchedule({
      roster: b.slots,
      players: mine.entries.map((e) => ({
        player_id: e.player.ref.id,
        position: e.player.position,
        eligible_slot_ids: e.player.eligible_slot_ids,
        injury_status: e.player.injury_status,
        pro_team_id: e.player.pro_team_id,
        slot_id: e.slot_id,
        weeks: (proj.byId.get(e.player.ref.id)?.weeks ?? [])
          .filter((x) => weeks.includes(x.week))
          .map((x) => ({ week: x.week, dist: x.dist, bye: x.bye })),
      })),
      weeks,
      playoff: { weeks: b.rules.playoffs.playoff_weeks, bye_seeds: b.rules.playoffs.bye_seeds },
      include_playoffs: args.include_playoffs,
      p_alive_by_week: alive,
      seeding: seedingStatus(reading, ctx.services.seedingConfirmedAt),
      stream: streamCandidates(streamPlayers, weeks, positions),
      schedule,
      clock: ctx.services.clock,
      deadline_ms: cpuDeadlineOf(ctx),
      inputs: toDataInputs(inputs, ctx.nowMs),
    });
    if (!out.data.seeding.confirmed)
      warnings.push("seeding reading not confirmed: run the onboard Skill (eff setup --seeding)");
    return {
      data: { ...out.data, inputs: toDataInputs(inputs, ctx.nowMs) },
      inputs,
      warnings: [...warnings, ...out.warnings],
      estimate: true,
      partial: out.partial || proj.partial || warnings.some((x) => x.startsWith("partial:")),
      listKey: "weeks",
      week: b.w,
    };
  },
});

// --- E9 espn_analyze_roster ------------------------------------------------------------------------

/** E9 data (plan 07 E9; RosterAnalysisData). `ir` is emitted first when the roster is invalid. */
export const rosterAnalysisSchema = z.strictObject({
  phase: z.enum(["early", "mid", "late"]),
  competing: z.enum(["yes", "eliminated"]),
  bench_template: z.strictObject({
    derived: z.strictObject({
      k: count,
      dst: count,
      qb_bench: count,
      te_bench: count,
      rb_wr_depth: count,
    }),
    basis: serverText,
    streamability: z.record(position, z.number()),
  }),
  bench_plan: z
    .array(
      z.strictObject({
        slot: slotName,
        role: z.enum(["bye_cover", "injury_cover", "upside", "handcuff", "stash"]),
        player_id: playerId,
        marginal_value: z.number(),
      }),
    )
    .max(30),
  handcuff_values: z
    .array(
      z.strictObject({ handcuff: playerId, starter: playerId, value: dist, verdict: serverText }),
    )
    .max(10),
  stash_values: z
    .array(
      z.strictObject({
        player_id: playerId,
        p_return_by_week: z.array(weekP).max(22),
        value: dist,
        verdict: serverText,
        playoff_horizon_note: serverText.nullable(),
      }),
    )
    .max(10),
  consolidation_candidates: z
    .array(z.strictObject({ give: z.array(playerId).max(6), target_profile: serverText }))
    .max(10),
  droppable: z
    .array(
      z.strictObject({
        player_id: playerId,
        value_ros: dist,
        re_add_risk: z.strictObject({
          percent_owned: z.number().min(0).max(100).nullable(),
          rivals_claiming: count.nullable(),
        }),
        undroppable: z.boolean(),
      }),
    )
    .max(10),
  ir: z.strictObject({
    slots: count,
    eligible_now: z
      .array(
        z.strictObject({
          player_id: playerId,
          tag: z
            .string()
            .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
            .nullable(),
        }),
      )
      .max(20),
    invalid: z.boolean(),
    invalid_players: z.array(playerId).max(20),
    forced_drop: playerId.nullable(),
    blocked_until: isoNull,
    hidden_bench_play: z
      .strictObject({
        available: z.boolean(),
        player_id: playerId.nullable(),
        risks: z.tuple([serverText, serverText, serverText]),
      })
      .nullable(),
    activation_timing_warning: serverText.nullable(),
    effective_bench: z.number(),
  }),
  adds_remaining: count.nullable(),
  rec,
  inputs: inputsSchema,
});

/** E9's handcuff cases (research 05 §4.2): my bench RB behind his NFL team's lead back. */
export function handcuffCases(
  mine: Roster,
  rosters: readonly Roster[],
  weeks: readonly Week[],
): HandcuffCase[] {
  const out: HandcuffCase[] = [];
  const rostered = rosters.flatMap((r) => r.entries.map((e) => e.player));
  for (const e of mine.entries) {
    const p = e.player;
    if (p.position !== "RB" || p.pro_team_id <= 0 || e.slot_id !== 20) continue;
    const lead = rostered
      .filter(
        (x) => x.position === "RB" && x.pro_team_id === p.pro_team_id && x.ref.id !== p.ref.id,
      )
      .sort((a, b) => (b.projection_ros_espn ?? 0) - (a.projection_ros_espn ?? 0))[0];
    if (lead === undefined || (lead.projection_ros_espn ?? 0) <= (p.projection_ros_espn ?? 0))
      continue;
    const v = valueWeeks(lead, weeks);
    out.push({
      handcuff: p.ref.id,
      starter: lead.ref.id,
      // the backup inherits the vacated carries at the cascade's retention [U] (research 05 §6)
      promoted: weeks.map((w, i) => ({ week: w, mean: (v[i] ?? 0) * CASCADE.retention.carries })),
    });
    if (out.length >= 5) break;
  }
  return out;
}

/** E9 `espn_analyze_roster`. */
export const analyzeRosterTool = defineTool({
  name: "espn_analyze_roster",
  description:
    "Rest-of-season roster construction: derived bench template, bench roles, handcuffs and stashes per case, droppables, and the IR audit.",
  input: z.strictObject({
    team_id: teamIdSchema.optional(),
    competing: z.enum(["auto", "yes", "eliminated"]).default("auto"),
    seed: seedSchema.optional(),
    ...analyticsFreshnessShape,
    ...detailShape,
  }),
  data: rosterAnalysisSchema,
  budget: "analytics",
  run: async (args, ctx) => {
    const inputs: InputStamp[] = [];
    const warnings: string[] = [];
    const allowStale = args.allow_stale === true;
    const b = await basicsOf(ctx, inputs, args);
    const team = teamOf(b.league, args.team_id);
    const weeks = remainingWeeks(b.rules.playoffs, b.w);
    if (weeks.length === 0)
      throw new EffError("VALIDATION", { field: "week", reason: "season_over" });
    const rosters = await required(() => rostersOf(ctx, b.w, inputs, warnings, args, team));
    const mine = rosters.find((r) => r.team.team_id === team);
    if (mine === undefined) throw new EffError("NOT_FOUND");
    const schedule = await scheduleOrEmpty(ctx, b.league.ref.season, inputs, warnings, allowStale);
    const seed = seedOf(
      ctx,
      args.seed,
      ["e9", b.league.ref.season, b.w, team, b.settings.settings_hash].join("|"),
    );
    const proj = await projectMany(
      ctx,
      subjectsOf(
        ctx,
        mine.entries.map((e) => e.player),
      ),
      {
        league: b.league,
        settings: b.settings,
        schedule,
        horizon: "ros",
        week: b.w,
        seed,
        allowStale,
      },
      inputs,
      warnings,
    );
    const pool = await poolOf(ctx, b.w, inputs, warnings);
    // E4's streamability over the league (cheap: no sampling) and its stream candidates
    const repl = await analyzeReplacement({
      roster: b.slots,
      league_size: b.league.size,
      weeks,
      players: leaguePlayers(rosters, pool, weeks),
      clock: ctx.services.clock,
      deadline_ms: cpuDeadlineOf(ctx),
    });
    const streamability: Record<string, number> = {};
    for (const p of repl.data.positions) streamability[p.position] = p.streamability;
    const streamPlayers = pool
      .filter((p) => p.status !== "ONTEAM")
      .map((p) => replacementPlayerOf(p, weeks, false));
    const positions = [...new Set(mine.entries.map((e) => e.player.position))];
    const standings = await standingsOrNull(ctx, inputs, warnings);
    const mineStanding = standings?.teams.find((t) => t.team_id === team) ?? null;
    let season: {
      p_playoffs: number;
      eliminated: boolean;
      p_alive_by_week: { week: Week; p: number }[];
    } | null = null;
    if (args.competing === "auto") {
      const mGot = await withinBudget(
        () => ctx.services.platform.getMatchups(leagueRef(ctx), readOpts(ctx, args)),
        warnings,
      ).catch((e: unknown) => {
        if (!isDegradable(e)) throw e;
        return null;
      });
      if (mGot !== null) {
        const sim = await runSeason(ctx, {
          league: b.league,
          rules: b.rules,
          matchups: take(ctx, mGot, inputs),
          standings,
          me: team,
          w: b.w,
          seed,
          seeding_mode: readingOf(ctx, "config"),
          n_sims: BOUNDS.nSims.default,
          marginal: false,
          through_playoffs: true,
        });
        const r0 = sim?.data.readings[0];
        if (r0 !== undefined)
          season = {
            p_playoffs: r0.p_playoffs,
            eliminated: r0.clinch.eliminated,
            p_alive_by_week: r0.p_alive_by_week.map((x) => ({ week: x.week, p: x.p })),
          };
      }
      if (season === null) warnings.push("season simulation unavailable: competing read as yes");
    }
    const deadline = tradeDeadlineWeeks(b.rules.trade, schedule).first_week_after;
    const players: AuditPlayer[] = mine.entries.map((e) => {
      const pp = proj.byId.get(e.player.ref.id);
      return {
        player_id: e.player.ref.id,
        gsis_id: crosswalkOf(ctx, e.player.ref.id, e.player.position_id).gsis_id,
        position: e.player.position,
        eligible_slot_ids: e.player.eligible_slot_ids,
        slot_id: e.slot_id,
        injury_status: e.player.injury_status,
        pro_team_id: e.player.pro_team_id,
        droppable: e.player.droppable,
        percent_owned: e.player.ownership?.percent_owned ?? null,
        weeks: (pp?.weeks ?? []).map((x) => ({ week: x.week, mean: x.dist.mean, bye: x.bye })),
        ros: pp?.projection.ros_total ?? null,
      };
    });
    const out = await analyzeRoster({
      roster: b.slots,
      players,
      weeks,
      current_week: b.w,
      playoff_weeks: b.rules.playoffs.playoff_weeks,
      trade_deadline_week: deadline,
      competing: args.competing,
      season,
      streamability,
      stream: streamCandidates(streamPlayers, weeks, positions),
      handcuffs: handcuffCases(mine, rosters, weeks),
      rules: {
        acquisition_limit: b.rules.waiver.acquisition_limit,
        acquisitions_used: mineStanding?.transaction_counter.acquisitions ?? null,
        next_run_at: b.rules.waiver.next_execution,
      },
      clock: ctx.services.clock,
      deadline_ms: cpuDeadlineOf(ctx),
      inputs: toDataInputs(inputs, ctx.nowMs),
    });
    if (out.data.ir.invalid)
      warnings.push("the roster is invalid: a healthy player in IR blocks every add until fixed");
    return {
      // the engine puts `ir` first in key order when the roster is invalid: kept as built
      data: { ...out.data, inputs: toDataInputs(inputs, ctx.nowMs) },
      inputs,
      warnings: [...warnings, ...repl.warnings.slice(0, 2), ...out.warnings],
      estimate: true,
      partial: out.partial || proj.partial || warnings.some((x) => x.startsWith("partial:")),
      listKey: "bench_plan",
      week: b.w,
    };
  },
});
