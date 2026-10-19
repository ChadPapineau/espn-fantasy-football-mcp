// market-p1.ts — the market engines as P1 tools (plan 07 §3.E, registered under EFF_TOOLSET=full;
// plan 10 B4–B6, B8): E6 espn_analyze_trade (roster-contextual Δ for both sides converted to ΔU under
// the configured seeding reading — both readings only when `seeding_mode: "both"` is passed — the
// deadline from tradeSettings, veto as risk, ESPN's auction value as a comparator only; every uneven
// trade names its implied drop), E7 espn_analyze_injury_cascade (vacated opportunity by role
// affinity, an honest evidence grade, `hypothesis_only`, the IR consequence from the STRUCTURED status
// only, and a claim / pass per available beneficiary from E5), E10 espn_analyze_evidence (structured
// fields win; outlooks, RSS items and the user's pasted claim enter only wrapped — plan 02 §6.4; the
// result is invariant to the text) and E11 espn_analyze_league_activity (what rivals did, priority
// spent, who needs what, who is IR-blocked). Also the E5 P1 inputs (usage signals, rival rosters,
// Sleeper's secondary trend, learned mechanics, the FAAB context) the waivers tool adds under `full`.
import { z } from "zod/v4";
import {
  analyzeEvidence,
  analyzeInjuryCascade,
  analyzeLeagueActivity,
  analyzeTrade,
  analyzeWaiversP1,
  claimRuns,
  learnWaiverMechanics,
  usageWeekOf,
  type CascadeClaimInput,
  type CascadeTeammate,
  type EvidenceText,
  type FaabContextInput,
  type RivalRoster,
  type SignalInput,
  type TradePlayer,
  type TradeTeam,
  type WaiverP1Request,
} from "../../domain/analytics/phase2.js";
import type { ActivityTeam } from "../../domain/analytics/leagueActivity.js";
import type {
  LeagueActivityData,
  NewsItem,
  TradeData,
  UsageGameRow,
  WaiverVerdict,
} from "../../domain/analytics/types.js";
import type {
  WaiverCandidateInput,
  WaiverPlayer,
  WaiverRequest,
} from "../../domain/analytics/waivers.js";
import { CASCADE_PRIORS } from "../../domain/analytics/cascade-priors/index.js";
import { MAX_NAME_CHARS, mergeName } from "../../domain/crosswalk/normalize.js";
import {
  CALIBRATION,
  buildCalibrationTable,
  practiceHistoryClaims,
  type CalibrationSource,
  type CalibrationTable,
  type ClaimSignal,
  type ScoredClaim,
  type ScoredClaimType,
} from "../../domain/evidence/index.js";
import { seededRng } from "../../domain/clock.js";
import { auditIr, seatsOf } from "../../domain/league/roster.js";
import { remainingWeeks } from "../../domain/league/rules.js";
import type {
  InjuryStatus,
  PlatformPlayer,
  Roster,
  Standings,
  Transaction,
  UntrustedText,
  Week,
} from "../../domain/league/types.js";
import {
  BOUNDS,
  analyticsFreshnessShape,
  boundedTextSchema,
  detailShape,
  isoInstantSchema,
  playerIdsSchema,
  positionSchema,
  seedSchema,
  singlePlayerSelectorSchema,
  teamIdSchema,
} from "../bounds.js";
import { toDataInputs, wrapUntrusted, type InputStamp } from "../envelope.js";
import { EffError } from "../errors.js";
import { beforeSideEffect, defineTool, type ToolContext, type ToolOutput } from "../define.js";
import { carryOutcome, cpuDeadlineOf, seedOf, waiverPlayerOf, type Subject } from "./analytics.js";
import {
  canonicalPosition,
  crosswalkOf,
  espnIdOfGsis,
  espnIdOfGsisSelector,
  espnIdsPairedWith,
  isDegradable,
  leagueRef,
  newsRefsOf,
  optionalDataset,
  readOpts,
  rosReadingOf,
  seasonTransactions,
  take,
  teamOf,
  turn,
  withinBudget,
  type RosReading,
} from "./common.js";
import {
  basicsOf,
  meanFinite,
  nflverseTeam,
  receptionPoints,
  required,
  runSeason,
  rzShareOf,
  usageOf,
  valueWeeks,
  type LeagueBasics,
} from "./p1-common.js";
import { rostersOf } from "./roster.js";
import { universeOf, type UniverseRow } from "./select.js";
import {
  count,
  dist,
  gsisOrNull,
  injuryStatus,
  inputs as inputsSchema,
  iso,
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
  ut,
  week,
} from "./schemas.js";

// --- shared pieces ----------------------------------------------------------------------------------

const marginalSchema = z.strictObject({ d_p_playoffs: z.number(), d_p_bye: z.number() });
const seedingSchema = z.strictObject({
  mode_used: z.enum(["espn_rule", "points_only", "both"]),
  confirmed: z.boolean(),
});

/** One TradePlayer from a platform record at E1 v1's point estimate over `weeks` (`ros`: valueWeeks). */
export function tradePlayerOf(
  ctx: ToolContext,
  p: PlatformPlayer,
  slotId: number,
  weeks: readonly Week[],
  ros: RosReading | null,
): TradePlayer {
  return {
    player_id: p.ref.id,
    gsis_id: crosswalkOf(ctx, p.ref.id, p.position_id).gsis_id,
    name: p.name,
    position: p.position,
    eligible_slot_ids: p.eligible_slot_ids,
    injury_status: p.injury_status,
    slot_id: slotId,
    droppable: p.droppable,
    weekly: valueWeeks(p, weeks, ros),
    bye_week: p.bye_week,
    auction_value_average: p.ownership?.auction_value_average ?? null,
  };
}

/** The standings when this call can read them. */
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

/** The pool page (available players by ESPN's rest-of-season projection), or none. */
async function poolOf(
  ctx: ToolContext,
  w: Week,
  inputs: InputStamp[],
  warnings: string[],
  limit = 50,
): Promise<readonly PlatformPlayer[]> {
  const got = await withinBudget(
    () =>
      ctx.services.platform.listPlayers(
        leagueRef(ctx),
        { status: "AVAILABLE", position: null, sort: "projection_ros", week: w, injured: null },
        { limit, offset: 0 },
        readOpts(ctx),
      ),
    warnings,
  ).catch((e: unknown) => {
    if (!isDegradable(e)) throw e;
    // never silent: the answer goes without the free-agent pool, so it is partial (plan 07 §2)
    warnings.push("partial: espn:kona_player_info unavailable: no free-agent pool");
    return null;
  });
  return got === null ? [] : take(ctx, got, inputs).items.filter((p) => p.status !== "ONTEAM");
}

// --- E6 espn_analyze_trade -----------------------------------------------------------------------

const deltaUSchema = z.strictObject({
  me: marginalSchema,
  partner: marginalSchema,
  reading: z.enum(["espn_rule", "points_only", "both"]),
  basis: z.enum(["season_sim", "cold_start"]),
  by_reading: z
    .array(
      z.strictObject({
        seeding_mode: z.enum(["espn_rule", "points_only"]),
        me: marginalSchema,
        partner: marginalSchema,
      }),
    )
    .max(2),
});

/** E6 data (plan 07 E6; TradeData), discriminated on `kind`. */
export const tradeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("evaluation"),
    delta_me: dist,
    delta_partner: dist,
    delta_u: deltaUSchema,
    seeding: seedingSchema,
    weekly_impact: z.array(z.strictObject({ week, me: z.number(), partner: z.number() })).max(22),
    playoff_weeks_impact: z.strictObject({ me: z.number(), partner: z.number() }),
    implied_drop: z
      .strictObject({
        side: z.enum(["me", "partner"]),
        player_id: playerId,
        name: playerName,
        value: z.number(),
        forced: z.boolean(),
      })
      .nullable(),
    health_adjustment: z.strictObject({ me: z.number(), partner: z.number() }),
    bye_conflicts: z.array(z.strictObject({ week, player_ids: z.array(playerId).max(20) })).max(22),
    why_they_accept: z.array(serverText).max(10),
    veto: z
      .strictObject({
        votes_required: count,
        risk: z.enum(["low", "medium", "high"]),
      })
      .nullable(),
    crowd_value_espn: z
      .strictObject({
        auction_value_average: z.strictObject({ give: z.number(), get: z.number() }),
      })
      .nullable(),
    consolidation: z.strictObject({
      is_2_for_1: z.boolean(),
      implied_drop: playerId.nullable(),
    }),
    counters: z
      .array(
        z.strictObject({
          give: z.array(playerId).max(6),
          get: z.array(playerId).max(6),
          delta_me: dist,
          delta_partner: dist,
        }),
      )
      .max(5),
    verdict: z.enum(["accept", "counter", "decline", "fair"]),
    deadline: isoNull,
    rec,
    inputs: inputsSchema,
  }),
  z.strictObject({
    kind: z.literal("partners"),
    partners: z
      .array(
        z.strictObject({
          team_id: teamId,
          name: ut,
          weakest_slot: slotName,
          proposal: z.strictObject({
            give: z.array(playerId).max(6),
            get: z.array(playerId).max(6),
          }),
          delta_me: dist,
          delta_partner: dist,
        }),
      )
      .max(BOUNDS.maxPartners.max),
    deadline: isoNull,
    rec: rec.nullable(),
    inputs: inputsSchema,
  }),
]);

/**
 * The best free agents the trade engine may fill a freed seat from (the pool page is sorted by ESPN's
 * rest-of-season projection; a seat is filled from the top, so a short list is the same answer at a
 * fraction of the cost of the whole page).
 */
export const TRADE_WIRE_MAX = 12;

const tradeSideSchema = playerIdsSchema.refine((a) => a.length <= BOUNDS.tradeSide.max, {
  message: "too_big",
});

/** The positions a league starts (its starter and flex slots' eligible positions): E6's needs. */
export function startingPositions(slots: {
  readonly slots: readonly { class: string; eligible_positions: readonly string[] }[];
}): Set<string> {
  const out = new Set<string>();
  for (const s of slots.slots)
    if (s.class === "starter" || s.class === "flex")
      for (const p of s.eligible_positions) out.add(p);
  return out;
}

/** The assumption naming the wire a freed seat is filled from (said whenever one was given). */
export const TRADE_WIRE_ASSUMPTION = Object.freeze({
  text: "a seat the trade frees is filled with the best free agent (FREEAGENT: an instant add) by ESPN's rest-of-season projection; a WAIVERS player needs a claim and is never counted",
  revisit_trigger: "the free-agent pool changes (a waiver run, a drop)",
});

/**
 * The trade data with the wire's assumption on its rec when the engine was given a wire: Δ counts a
 * free-agent fill of every seat the trade frees, and the reader must see which pool that was (the
 * engine states the opposite case itself — "valued at 0 (no wire given)"). Stage C finding
 * trade-wire-fill-free-waivers.
 */
export function withWireAssumption(data: TradeData, wire: readonly unknown[]): TradeData {
  const rec = data.rec;
  if (wire.length === 0 || rec === null) return data;
  if (rec.assumptions.some((a) => a.text === TRADE_WIRE_ASSUMPTION.text)) return data;
  const withA = { ...rec, assumptions: [...rec.assumptions, TRADE_WIRE_ASSUMPTION] };
  return data.kind === "evaluation" ? { ...data, rec: withA } : { ...data, rec: withA };
}

// PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; owner decision D11): a write module would let the
// user act on an accepted evaluation through its trade prepare/commit pair (plan 07 §3.F F5–F6, the
// later gate). Nothing here prepares, proposes or sends a trade: the evaluation is read-only and the
// user makes any offer in the ESPN app.

/** E6 `espn_analyze_trade`. */
export const analyzeTradeTool = defineTool({
  name: "espn_analyze_trade",
  description:
    "Evaluate a trade offer for both sides (lineup-point change, change in playoff odds under the seeding reading, implied drop, veto, deadline) or find partners.",
  input: z
    .strictObject({
      team_id: teamIdSchema.optional(),
      offer: z
        .strictObject({
          partner_team_id: teamIdSchema,
          give: tradeSideSchema,
          get: tradeSideSchema,
        })
        .optional(),
      find_partners: z
        .strictObject({
          need_position: positionSchema,
          max_partners: z
            .number()
            .int()
            .min(BOUNDS.maxPartners.min)
            .max(BOUNDS.maxPartners.max)
            .default(BOUNDS.maxPartners.default),
        })
        .optional(),
      horizon: z.enum(["ros", "playoffs"]).default("ros"),
      risk: z.enum(["auto", "variance", "floor"]).default("auto"),
      seeding_mode: z.enum(["config", "both"]).default("config"),
      seed: seedSchema.optional(),
      ...analyticsFreshnessShape,
      ...detailShape,
    })
    .refine((a) => (a.offer === undefined) !== (a.find_partners === undefined), {
      message: "offer_xor_find_partners",
      path: ["offer"],
    }),
  data: tradeSchema,
  budget: "analytics",
  opaqueInput: {
    offer: "{partner_team_id, give:[<=6 player_ids], get:[<=6 player_ids]}",
    find_partners: "{need_position, max_partners 1-4}",
  },
  run: async (args, ctx): Promise<ToolOutput<TradeData>> => {
    const inputs: InputStamp[] = [];
    const warnings: string[] = [];
    const b = await basicsOf(ctx, inputs, args);
    const me = teamOf(b.league, args.team_id);
    // the engine matches need_position to a player's position exactly: the argument in the league's
    // spelling of a position it starts, else VALIDATION — never partners [] with a "no partner
    // gains" verdict for `rb` or `FLEX` (Stage C finding players-position-filter-unvalidated)
    const findPartners =
      args.find_partners === undefined
        ? null
        : {
            ...args.find_partners,
            need_position: canonicalPosition(
              args.find_partners.need_position,
              startingPositions(b.slots),
              "find_partners.need_position",
            ),
          };
    const weeks = remainingWeeks(b.rules.playoffs, b.w);
    if (weeks.length === 0)
      throw new EffError("VALIDATION", { field: "offer", reason: "season_over" });
    const rosters = await required(() => rostersOf(ctx, b.w, inputs, warnings, args, me));
    const mine = rosters.find((r) => r.team.team_id === me);
    if (mine === undefined) throw new EffError("NOT_FOUND");
    // ESPN's ROS total read as E1 reads it (Stage C finding projection-ros-includes-week18)
    const ros = await rosReadingOf(
      ctx,
      b.league.ref.season,
      inputs,
      warnings,
      args.allow_stale === true,
    );
    if (args.offer !== undefined) {
      const partner = rosters.find((r) => r.team.team_id === args.offer?.partner_team_id);
      if (partner === undefined || args.offer.partner_team_id === me)
        throw new EffError("NOT_FOUND", { field: "offer.partner_team_id", reason: "not_found" });
      const mineIds = new Set(mine.entries.map((e) => e.player.ref.id));
      const theirIds = new Set(partner.entries.map((e) => e.player.ref.id));
      if (!args.offer.give.every((id) => mineIds.has(id)))
        throw new EffError("VALIDATION", { field: "offer.give", reason: "not_on_my_roster" });
      if (!args.offer.get.every((id) => theirIds.has(id)))
        throw new EffError("VALIDATION", { field: "offer.get", reason: "not_on_partner_roster" });
    }
    const seed = seedOf(
      ctx,
      args.seed,
      ["e6", b.league.ref.season, b.w, me, b.settings.settings_hash].join("|"),
    );
    // each side's season readings (marginal values on) for ΔU: me and the partner only
    const mGot = await withinBudget(
      () => ctx.services.platform.getMatchups(leagueRef(ctx), readOpts(ctx, args)),
      warnings,
    ).catch((e: unknown) => {
      if (!isDegradable(e)) throw e;
      return null;
    });
    const standings = await standingsOrNull(ctx, inputs, warnings);
    // a deadline-stopped season run gives ΔU from fewer paths: its warning and flag reach the envelope
    const sims = { partial: false };
    const readingsFor = async (team: number) => {
      if (mGot === null) return null;
      const out = await runSeason(ctx, {
        league: b.league,
        rules: b.rules,
        matchups: take(ctx, mGot, inputs),
        standings,
        me: team,
        w: b.w,
        seed: seed + team,
        seeding_mode: args.seeding_mode === "both" ? "both" : ctx.services.seedingMode,
        n_sims: BOUNDS.nSims.default,
        marginal: true,
        through_playoffs: true,
      });
      if (carryOutcome(out, warnings)) sims.partial = true;
      return out?.data.readings ?? null;
    };
    const aliveOf = (readings: Awaited<ReturnType<typeof readingsFor>>): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const x of readings?.[0]?.p_alive_by_week ?? [])
        if (b.rules.playoffs.playoff_weeks.includes(x.week)) out[String(x.week)] = x.p;
      return out;
    };
    const partnerId = args.offer?.partner_team_id ?? null;
    const teamOfRoster = async (r: Roster, withReadings: boolean): Promise<TradeTeam> => {
      const readings = withReadings ? await readingsFor(r.team.team_id) : null;
      return {
        team_id: r.team.team_id,
        name: r.team_name,
        players: r.entries.map((e) => tradePlayerOf(ctx, e.player, e.slot_id, weeks, ros)),
        readings,
        alive_by_week: aliveOf(readings),
      };
    };
    const meTeam = await teamOfRoster(mine, args.offer !== undefined);
    const others: TradeTeam[] = [];
    for (const r of rosters)
      if (r.team.team_id !== me) others.push(await teamOfRoster(r, r.team.team_id === partnerId));
    if (args.offer !== undefined && mGot === null)
      warnings.push("season simulation unavailable: ΔU from the cold-start PF-per-win rate");
    if (args.risk !== "auto")
      warnings.push(
        "risk preference is not modelled: Δ and its [p10, p90] interval are reported for you to weigh",
      );
    const pool = await poolOf(ctx, b.w, inputs, warnings);
    // a seat the trade frees is filled as an instant, certain, free add: only a FREEAGENT is one.
    // A WAIVERS player needs a claim (a priority cost, a rival's competing claim, a run that may
    // not reach this week) — counted as a free add before, he made "give both my QBs for an RB" look
    // fair when the pool held no free-agent QB at all (Stage C finding trade-wire-fill-free-waivers)
    const wire = pool.filter((p) => p.status === "FREEAGENT").slice(0, TRADE_WIRE_MAX);
    // the teams' players were mapped synchronously above: the loop runs before the engine
    await turn();
    const out = await analyzeTrade({
      roster: b.slots,
      rules: b.rules,
      weeks,
      me: meTeam,
      teams: others,
      offer: args.offer ?? null,
      find_partners: findPartners,
      horizon: args.horizon,
      seeding_mode: args.seeding_mode,
      seeding_config: {
        mode: ctx.services.seedingMode,
        confirmed_at: ctx.services.seedingConfirmedAt,
      },
      free_agents: wire.map((p) => tradePlayerOf(ctx, p, 20, weeks, ros)),
      clock: ctx.services.clock,
      pacer: ctx.pacer,
      rng: seededRng(seed),
      // one 8 s CPU budget per call: the season runs above already spent theirs (Stage C)
      deadline_ms: cpuDeadlineOf(ctx),
      inputs: toDataInputs(inputs, ctx.nowMs),
    });
    if (out.data.kind === "evaluation" && !out.data.seeding.confirmed)
      warnings.push("seeding reading not confirmed: run the onboard Skill (eff setup --seeding)");
    const data: TradeData = withWireAssumption(
      { ...out.data, inputs: toDataInputs(inputs, ctx.nowMs) },
      wire,
    );
    return {
      data,
      inputs,
      warnings: [...warnings, ...out.warnings],
      estimate: true,
      partial:
        sims.partial || out.partial === true || warnings.some((x) => x.startsWith("partial:")),
      listKey: data.kind === "evaluation" ? "counters" : "partners",
      week: b.w,
    };
  },
});

// --- E7 espn_analyze_injury_cascade --------------------------------------------------------------

const poolStatus = z.enum(["FREEAGENT", "WAIVERS", "ONTEAM"]);

/** E7 data (plan 07 E7; InjuryCascadeData). */
export const cascadeSchema = z.strictObject({
  injured: z.strictObject({
    player_id: playerId.nullable(),
    gsis_id: gsisOrNull,
    name: playerName,
    nfl_team: z
      .string()
      .regex(/^[A-Z]{2,4}$/)
      .nullable(),
    position,
    injury_status: injuryStatus,
  }),
  expected_weeks: z.strictObject({
    p25: z.number(),
    p50: z.number(),
    p75: z.number(),
    basis: z.enum(["report", "prior"]),
  }),
  beneficiaries: z
    .array(
      z.strictObject({
        player_id: playerId.nullable(),
        gsis_id: gsisOrNull,
        name: playerName,
        delta_opportunity: z.strictObject({
          targets: z.number(),
          carries: z.number(),
          rz: z.number(),
        }),
        delta_proj_by_week: z.array(z.strictObject({ week, delta: z.number() })).max(22),
        p_role_holds: prob,
        evidence: z.strictObject({
          team_games: count,
          usage_confirmed: z.boolean(),
          market_move: z.number().nullable(),
        }),
        availability: z.strictObject({
          status: poolStatus.nullable(),
          waiver_process_date: isoNull,
        }),
        verdict: z.enum(["claim", "pass", "marginal", "fa_add_now", "fa_add_after_run"]).nullable(),
      }),
    )
    .max(20),
  team_volume_change: z.strictObject({ implied_total_delta: z.number().nullable() }),
  vacated: z.strictObject({ targets: z.number(), carries: z.number(), rz: z.number() }),
  returning_ramp: z.strictObject({ weeks: z.number(), factor: z.number() }),
  ir_consequence: z
    .strictObject({
      on_my_roster: z.boolean(),
      ir_eligible: z.boolean(),
      move: z.strictObject({ from_slot: slotName, to: z.literal("IR") }).nullable(),
      frees_bench_slot: z.boolean(),
    })
    .nullable(),
  pass_down_back_note: serverText.nullable(),
  hypothesis_only: z.boolean(),
  rec,
  inputs: inputsSchema,
});

/** The NFL team's players in the player index, by ownership, the injured player first. */
function teamPlayerIds(rows: readonly UniverseRow[], proTeamId: number, injured: number): number[] {
  const ids = rows
    .filter((r) => r.pro_team_id === proTeamId && r.espn_id > 0 && r.espn_id !== injured)
    .filter((r) => [1, 2, 3, 4].includes(r.position_id))
    .sort((a, b) => (b.percent_owned ?? 0) - (a.percent_owned ?? 0) || a.espn_id - b.espn_id)
    .slice(0, 24)
    .map((r) => r.espn_id);
  return [injured, ...ids];
}

/** Shares of a set of games (target share from nflverse; carry share against the listed carriers). */
function sharesOf(
  games: readonly UsageGameRow[],
  teamCarries: ReadonlyMap<number, number>,
): {
  target_share: number | null;
  carry_share: number | null;
  rz_share: number | null;
  snap_pct: number | null;
} {
  return {
    target_share: meanFinite(games.map((g) => g.target_share)),
    carry_share: meanFinite(
      games.map((g) => {
        const t = teamCarries.get(g.week) ?? 0;
        return g.carries === null || !(t > 0) ? null : g.carries / t;
      }),
    ),
    rz_share: rzShareOf(games),
    snap_pct: meanFinite(games.map((g) => g.snap_pct)),
  };
}

/** E5 verdicts for the available beneficiaries (the cascade's injected evaluator). */
async function waiverVerdicts(
  ctx: ToolContext,
  b: LeagueBasics,
  mine: Roster,
  rosters: readonly Roster[],
  standings: Standings | null,
  weeks: readonly Week[],
  teammates: ReadonlyMap<number, PlatformPlayer>,
  list: readonly CascadeClaimInput[],
  ros: RosReading | null,
  warnings: string[],
): Promise<ReadonlyMap<number, WaiverVerdict>> {
  const out = new Map<number, WaiverVerdict>();
  const gsis = (p: PlatformPlayer): string | null =>
    crosswalkOf(ctx, p.ref.id, p.position_id).gsis_id;
  const candidates: WaiverCandidateInput[] = [];
  for (const c of list) {
    const p = teammates.get(c.player_id);
    if (p === undefined || c.status === "ONTEAM") continue;
    const base = waiverPlayerOf(p, 20, false, weeks, gsis(p), ros);
    const delta = new Map(c.delta_proj_by_week.map((x) => [x.week, x.delta]));
    candidates.push({
      ...base,
      weekly: weeks.map((w, i) => Math.max(0, (base.weekly[i] ?? 0) + (delta.get(w) ?? 0))),
      status: c.status === "WAIVERS" ? "WAIVERS" : "FREEAGENT",
      waiver_process_date: p.waiver_process_date,
      percent_change: p.ownership?.percent_change ?? null,
    });
  }
  if (candidates.length === 0) return out;
  const me = mine.team.team_id;
  const req: WaiverP1Request = {
    ...waiverBase(ctx, b, mine, rosters, standings, weeks, ros),
    candidates: candidates.slice(0, BOUNDS.waiverCandidates.max),
    value_basis: "ensemble",
    rival_rosters: rivalRosters(ctx, rosters, me, weeks, ros),
    deadline_ms: cpuDeadlineOf(ctx),
  };
  const res = await analyzeWaiversP1(req);
  // a deadline-stopped claim evaluation reaches the cascade's envelope (its flag and its line)
  for (const w of res.warnings)
    if (w.startsWith("partial:") && !warnings.includes(w)) warnings.push(w);
  for (const c of res.data.candidates) out.set(c.player_id, c.verdict);
  return out;
}

/**
 * The P0 waiver request's shared part (my roster, rivals, k, rules) for a set of weeks; `ros` reads
 * ESPN's ROS total as E1 does and carries the pro schedule the claim timing reads (Stage C).
 */
export function waiverBase(
  ctx: ToolContext,
  b: LeagueBasics,
  mine: Roster,
  rosters: readonly Roster[],
  standings: Standings | null,
  weeks: readonly Week[],
  ros: RosReading | null,
): Omit<WaiverRequest, "candidates"> {
  const me = mine.team.team_id;
  const gsis = (p: PlatformPlayer): string | null =>
    crosswalkOf(ctx, p.ref.id, p.position_id).gsis_id;
  return {
    roster: b.slots,
    rules: b.rules,
    league_size: b.league.size,
    week: b.w,
    weeks,
    mine: mine.entries.map((e) =>
      waiverPlayerOf(e.player, e.slot_id, e.lineup_locked, weeks, gsis(e.player), ros),
    ),
    k: standings?.teams.find((t) => t.team_id === me)?.waiver_rank ?? null,
    rivals: (standings?.teams ?? [])
      .filter((t) => t.team_id !== me)
      .map((t) => {
        const r = rosters.find((x) => x.team.team_id === t.team_id);
        return {
          team_id: t.team_id,
          waiver_rank: t.waiver_rank,
          ir_blocked: r === undefined ? false : auditIr(seatsOf(r), b.slots).invalid,
        };
      }),
    settings: b.settings,
    schedule: ros?.schedule ?? null,
    clock: ctx.services.clock,
    pacer: ctx.pacer,
  };
}

/** Every rival's roster as E5 players (each rival's own lineup gain — research 05 §1.3). */
export function rivalRosters(
  ctx: ToolContext,
  rosters: readonly Roster[],
  me: number,
  weeks: readonly Week[],
  ros: RosReading | null,
): RivalRoster[] {
  return rosters
    .filter((r) => r.team.team_id !== me)
    .map((r) => ({
      team_id: r.team.team_id,
      players: r.entries.map((e) =>
        waiverPlayerOf(
          e.player,
          e.slot_id,
          e.lineup_locked,
          weeks,
          crosswalkOf(ctx, e.player.ref.id, e.player.position_id).gsis_id,
          ros,
        ),
      ),
    }));
}

/** The single player a selector names (one cached filterIds read). */
async function singlePlayer(
  ctx: ToolContext,
  sel: z.output<typeof singlePlayerSelectorSchema>,
  w: Week,
  inputs: InputStamp[],
  warnings: string[],
  extra: readonly number[] = [],
): Promise<{ readonly player: PlatformPlayer; readonly others: readonly PlatformPlayer[] }> {
  let id: number | undefined;
  if ("player_ids" in sel) id = sel.player_ids[0];
  else {
    // the gsis id's ONE current pair (a tie is VALIDATION gsis_ambiguous: name him by player_ids)
    const g = sel.gsis_ids[0];
    id = g === undefined ? undefined : espnIdOfGsisSelector(ctx, g, warnings);
  }
  if (id === undefined) throw new EffError("NOT_FOUND");
  const ids = [id, ...extra.filter((x) => x !== id)].slice(0, 50);
  const got = await required(() =>
    ctx.services.platform.getPlayers(
      leagueRef(ctx),
      ids.map((x) => ({ platform: "espn" as const, id: x })),
      w,
      readOpts(ctx),
    ),
  );
  const list = take(ctx, got, inputs);
  const player = list.find((p) => p.ref.id === id);
  if (player === undefined) throw new EffError("NOT_FOUND");
  return { player, others: list.filter((p) => p.ref.id !== id) };
}

/** E7 `espn_analyze_injury_cascade`. */
export const analyzeInjuryCascadeTool = defineTool({
  name: "espn_analyze_injury_cascade",
  description:
    "Who gains when a player is out: beneficiaries by role affinity with timing and an evidence grade, the IR consequence for my roster, a claim/pass each.",
  input: z.strictObject({
    player: singlePlayerSelectorSchema,
    assume_weeks_out: z
      .number()
      .int()
      .min(BOUNDS.assumeWeeksOut.min)
      .max(BOUNDS.assumeWeeksOut.max)
      .nullable()
      .optional(),
    ...analyticsFreshnessShape,
    ...detailShape,
  }),
  data: cascadeSchema,
  budget: "analytics",
  opaqueInput: { player: "exactly one of {player_ids:[id]} or {gsis_ids:[id]}" },
  run: async (args, ctx) => {
    const inputs: InputStamp[] = [];
    const warnings: string[] = [];
    const allowStale = args.allow_stale === true;
    const b = await basicsOf(ctx, inputs, args);
    const season = b.league.ref.season;
    // the injured player's NFL team from the local index first, so ONE filterIds read covers the room
    let first: number | undefined;
    if ("player_ids" in args.player) first = args.player.player_ids[0];
    else {
      const g = args.player.gsis_ids[0];
      first = g === undefined ? undefined : (espnIdOfGsis(ctx, g, warnings) ?? undefined);
    }
    const index = await universeOf(ctx, season, inputs, warnings);
    await turn();
    const teamId0 = index.find((r) => r.espn_id === first)?.pro_team_id ?? 0;
    const room = first === undefined || teamId0 <= 0 ? [] : teamPlayerIds(index, teamId0, first);
    const { player: inj, others } = await singlePlayer(
      ctx,
      args.player,
      b.w,
      inputs,
      warnings,
      room,
    );
    if (inj.pro_team_id <= 0)
      throw new EffError("VALIDATION", { field: "player", reason: "no_nfl_team" });
    const teammates = others.filter(
      (p) => p.pro_team_id === inj.pro_team_id && ["QB", "RB", "WR", "TE"].includes(p.position),
    );
    if (teammates.length === 0)
      warnings.push("no teammates in the local player index: run eff refresh espn:players");
    const weeks = remainingWeeks(b.rules.playoffs, b.w).slice(0, 22);
    if (weeks.length === 0)
      throw new EffError("VALIDATION", { field: "player", reason: "season_over" });
    // ESPN's ROS total read as E1 reads it (Stage C finding projection-ros-includes-week18)
    const ros = await rosReadingOf(ctx, season, inputs, warnings, allowStale);
    const subjects: Subject[] = [inj, ...teammates].map((p) => ({
      p,
      gsis: crosswalkOf(ctx, p.ref.id, p.position_id).gsis_id,
    }));
    await turn();
    const now = usageOf(
      ctx,
      subjects,
      season,
      Array.from({ length: b.w }, (_, i) => i + 1),
      b.settings,
      allowStale,
      inputs,
    );
    await turn();
    const prior = usageOf(
      ctx,
      subjects,
      season - 1,
      Array.from({ length: BOUNDS.week.max }, (_, i) => i + 1),
      b.settings,
      allowStale,
      [],
    );
    const games = (id: number, prev: boolean): readonly UsageGameRow[] =>
      (prev ? prior : now).byId.get(id)?.games ?? [];
    // the team's carries per week (the listed carriers) — the carry share's denominator
    const carriesBy = (prev: boolean): Map<number, number> => {
      const m = new Map<number, number>();
      for (const s of subjects)
        for (const g of games(s.p.ref.id, prev))
          m.set(g.week, (m.get(g.week) ?? 0) + (g.carries ?? 0));
      return m;
    };
    const tcNow = carriesBy(false);
    const tcPrior = carriesBy(true);
    const injWeeks = new Set(games(inj.ref.id, false).map((g) => g.week));
    const injWeeksPrior = new Set(games(inj.ref.id, true).map((g) => g.week));
    const injShares = sharesOf(games(inj.ref.id, false).slice(-4), tcNow);
    // team games without the starter: weeks a teammate played and he did not (this and last season)
    const teamWeeks = new Set(
      subjects.slice(1).flatMap((s) => games(s.p.ref.id, false).map((g) => g.week)),
    );
    const teamWeeksPrior = new Set(
      subjects.slice(1).flatMap((s) => games(s.p.ref.id, true).map((g) => g.week)),
    );
    const without = [...teamWeeks].filter((x) => !injWeeks.has(x) && injWeeks.size > 0);
    const withoutPrior = [...teamWeeksPrior].filter(
      (x) => !injWeeksPrior.has(x) && injWeeksPrior.size > 0,
    );
    // per-game team volume: targets from nflverse target shares, carries from the listed carriers
    const targetsBy = new Map<number, number[]>();
    for (const s of subjects)
      for (const g of games(s.p.ref.id, false))
        if (g.targets !== null && g.target_share !== null && g.target_share >= 0.05)
          targetsBy.set(g.week, [...(targetsBy.get(g.week) ?? []), g.targets / g.target_share]);
    const median = (xs: number[]): number => {
      const s = [...xs].sort((a, c) => a - c);
      return s[Math.floor(s.length / 2)] ?? 0;
    };
    const teamTargets = meanFinite([...targetsBy.values()].map(median)) ?? 0;
    const teamCarries = meanFinite([...tcNow.values()]) ?? 0;
    // the team's red-zone opportunities per game (nflverse pbp, the weeks it covers)
    const rzByWeek = new Map<number, number>();
    for (const s of subjects)
      for (const g of games(s.p.ref.id, false))
        if (g.rz_team !== null && g.rz_team !== undefined) rzByWeek.set(g.week, g.rz_team);
    const teamRz = meanFinite([...rzByWeek.values()]) ?? 0;
    // the depth chart's rank of each teammate at his own position (the cascade's receiver role rule
    // reads it — plan 10 C6; cascade-priors/predict.ts): the newest snapshot of his team's chart
    const injTeam = nflverseTeam(inj.pro_team);
    const depthRankOf = new Map<number, number>();
    const mateById = new Map(teammates.map((p) => [p.ref.id, p]));
    if (injTeam !== null) {
      await turn();
      const dc = ctx.services.datasets.depthCharts.chart(season, [injTeam]);
      const di = optionalDataset(dc, ctx, allowStale);
      if (di !== null) {
        inputs.push(di);
        const byGsis = new Map(subjects.map((s) => [s.gsis, s.p]));
        for (const row of dc.rows) {
          const pl =
            (row.espn_id === null ? undefined : mateById.get(row.espn_id)) ??
            (row.gsis_id === null ? undefined : byGsis.get(row.gsis_id));
          if (pl === undefined) continue;
          if (row.pos_abb !== pl.position) continue;
          const cur = depthRankOf.get(pl.ref.id);
          if (cur === undefined || row.rank < cur) depthRankOf.set(pl.ref.id, row.rank);
        }
      } else warnings.push("nflverse:depth_charts not loaded: the receiver role rule reads usage");
    }
    const cascadeMates: CascadeTeammate[] = teammates.map((p) => {
      const g = games(p.ref.id, false);
      const gp = games(p.ref.id, true);
      const withStarter = g.filter((x) => injWeeks.has(x.week)).slice(-4);
      const w0 = [
        ...g.filter((x) => without.includes(x.week)),
        ...gp.filter((x) => withoutPrior.includes(x.week)),
      ];
      const latest = g[g.length - 1];
      const usage = sharesOf(withStarter.length > 0 ? withStarter : g.slice(-4), tcNow);
      return {
        player_id: p.ref.id,
        gsis_id: crosswalkOf(ctx, p.ref.id, p.position_id).gsis_id,
        name: p.name,
        position: p.position,
        injury_status: p.injury_status,
        usage,
        recent: latest === undefined ? null : sharesOf([latest], tcNow),
        without_starter:
          w0.length === 0
            ? null
            : (() => {
                const s = sharesOf(w0, new Map([...tcNow, ...tcPrior]));
                return {
                  target_share: s.target_share,
                  carry_share: s.carry_share,
                  rz_share: s.rz_share,
                };
              })(),
        percent_change: p.ownership?.percent_change ?? null,
        availability: { status: p.status, waiver_process_date: p.waiver_process_date },
        weekly: valueWeeks(p, weeks, ros),
        depth_rank: depthRankOf.get(p.ref.id) ?? null,
      };
    });
    const myTeam = b.league.my_team?.team_id ?? null;
    const rosters = await withinBudget(
      () => rostersOf(ctx, b.w, inputs, warnings, args, myTeam),
      warnings,
    ).catch((e: unknown) => {
      if (!isDegradable(e)) throw e;
      return null;
    });
    const mine = rosters?.find((r) => r.team.team_id === myTeam) ?? null;
    const myEntry = mine?.entries.find((e) => e.player.ref.id === inj.ref.id) ?? null;
    const standings = await standingsOrNull(ctx, inputs, warnings);
    const nfl = ctx.services.datasets.nflGames.games(season, [b.w]);
    const nflIn = optionalDataset(nfl, ctx, allowStale);
    if (nflIn !== null) inputs.push(nflIn);
    const team = nflverseTeam(inj.pro_team);
    const game = nfl.rows.find((g) => g.home === team || g.away === team);
    const impliedNow =
      game?.lines === null || game === undefined
        ? null
        : game.home === team
          ? game.lines.implied.home
          : game.lines.implied.away;
    const tmById = new Map(teammates.map((p) => [p.ref.id, p]));
    await turn();
    const out = await analyzeInjuryCascade({
      injured: {
        player_id: inj.ref.id,
        gsis_id: subjects[0]?.gsis ?? null,
        name: inj.name,
        nfl_team: inj.pro_team,
        position: inj.position,
        injury_status: inj.injury_status,
        usage: {
          target_share: injShares.target_share,
          carry_share: injShares.carry_share,
          rz_share: injShares.rz_share,
        },
        weekly: valueWeeks(inj, weeks, ros),
        mine:
          myEntry === null
            ? null
            : { slot_id: myEntry.slot_id, eligible_slot_ids: inj.eligible_slot_ids },
      },
      teammates: cascadeMates.slice(0, 40),
      // cascade v2 (plan 10 §3.3, C6): the redistribution prior table from pbp history
      priors: CASCADE_PRIORS,
      team_volume: { targets: teamTargets, carries: teamCarries, rz: teamRz },
      team_games_without: without.length + withoutPrior.length,
      weeks,
      ...(args.assume_weeks_out === undefined ? {} : { assume_weeks_out: args.assume_weeks_out }),
      reception_points: receptionPoints(b.settings, 2),
      implied_total: { before: null, now: impliedNow },
      my_roster:
        mine === null || myEntry === null ? null : { roster: b.slots, seats: seatsOf(mine) },
      ...(mine === null
        ? {}
        : {
            evaluate_claims: (list: readonly CascadeClaimInput[]) =>
              waiverVerdicts(
                ctx,
                b,
                mine,
                rosters ?? [],
                standings,
                weeks,
                tmById,
                list,
                ros,
                warnings,
              ),
          }),
      clock: ctx.services.clock,
      inputs: toDataInputs(inputs, ctx.nowMs),
    });
    if (mine === null) warnings.push("my roster unavailable: claim/pass verdicts are null");
    if (rzByWeek.size === 0)
      warnings.push("nflverse:pbp does not cover these weeks: the red-zone components are 0");
    return {
      data: { ...out.data, inputs: toDataInputs(inputs, ctx.nowMs) },
      inputs,
      warnings: [...warnings, ...out.warnings],
      estimate: true,
      partial: warnings.some((x) => x.startsWith("partial:")),
      listKey: "beneficiaries",
      week: b.w,
    };
  },
});

// --- E10 espn_analyze_evidence -------------------------------------------------------------------

/** The official practice report's seed (constant; built once per process). */
let practiceSeed: readonly ScoredClaim[] | null = null;

/** The calibration table E10 reads: the history seed plus this league's scored claims (plan 10 C8). */
export function calibrationTableOf(ctx: ToolContext): CalibrationTable {
  practiceSeed ??= Object.freeze(practiceHistoryClaims());
  let stored: readonly ScoredClaim[] = [];
  try {
    stored =
      ctx.services.scoredClaims?.scored(leagueRef(ctx).league_id, CALIBRATION.maxClaims) ?? [];
  } catch {
    stored = []; // a busy or unreadable store reads as no scored claim (the note stays)
  }
  return buildCalibrationTable([...practiceSeed, ...stored]);
}

/**
 * Logs E10's scorable claims (value-free: source, type, signal, the structured prior) for the
 * retrospective to score once the week is final (plan 10 C8; best-effort — a busy store skips them).
 */
export function logClaims(
  ctx: ToolContext,
  season: number,
  week: number,
  playerId: number,
  status: InjuryStatus | null,
  priorP: number | null,
  claims: readonly {
    readonly source: CalibrationSource;
    readonly type: ScoredClaimType;
    readonly signal: ClaimSignal;
  }[],
): void {
  const repo = ctx.services.scoredClaims;
  if (repo === undefined || claims.length === 0) return;
  beforeSideEffect(ctx);
  const league = leagueRef(ctx).league_id;
  for (const c of claims)
    try {
      repo.log(
        league,
        {
          season,
          week,
          player_id: playerId,
          claim: {
            source: c.source,
            type: c.type,
            signal: c.signal,
            prior_status: status === "ACTIVE" ? null : status,
            prior_p: priorP,
          },
        },
        ctx.services.clock.nowIso(),
      );
    } catch {
      // a claim the store refuses is skipped, never fatal to the answer
    }
}

/**
 * Where a news text splits into clauses: sentence ends, semicolons, dashes and line breaks. A period
 * after an initial or a name suffix ("D.J. Moore", "Kyle Pitts Sr. (ankle) ruled out") ends no
 * sentence: split there, the claim would lose the name it follows.
 */
const CLAUSE_SPLIT =
  /(?<=[;!?])\s+|(?<=\.)(?<!(?:^|[\s.(])(?:[a-z]|jr|sr|ii|iii|iv|st|vs|no|dr|mr|mt|ft)\.)\s+|\s+[—–-]\s+|\n+/iu;

/**
 * Where a clause that names a second player splits further: commas and colons, and the words that
 * join two players' news in one sentence ("X ruled out, Y to start"; "Y starts as X sits"; "with X
 * out, Y …"). Only ever applied to a clause naming more than one player, and each piece is kept only
 * when it names the subject alone, so a split can lose one of his claims but never adopt another's.
 */
const PHRASE_SPLIT =
  /\s*[,:]\s*|\s+(?:and|but|while|whereas|as|so|with|without|after|before|because|since|though|although|or|then|when|until|amid|plus|meaning|leaving|opening)\s+/iu;

/** The folded keys a player is named by in news text: his surname and his whole name run together. */
export interface NameKeys {
  /** The last token of his folded name (`mergeName`: suffixes and punctuation gone). */
  readonly surname: string;
  /** Every token run together (`Smith Njigba` and `Smith-Njigba` both read `smithnjigba`). */
  readonly whole: string;
  /**
   * His first name when it can stand for him in text ("in place of Dorian, who is out"): two or more
   * tokens, three or more letters, not an English word as well (Will, Mark, Chase …); null otherwise.
   * Read only to see ANOTHER player named — never to name the subject.
   */
  readonly given: string | null;
  /** Every folded token of his name. */
  readonly tokens: readonly string[];
}

/** First names that are English words too: as a key they would see a player in ordinary prose. */
const COMMON_WORD_NAMES: ReadonlySet<string> = new Set([
  "will",
  "mark",
  "chase",
  "miles",
  "hunter",
  "grant",
  "frank",
  "rich",
  "bill",
  "art",
  "jack",
  "ray",
  "rob",
  "sterling",
  "august",
  "earl",
  "dale",
  "guy",
  "major",
  "king",
  "young",
  "hope",
  "faith",
  "pat",
  "sky",
  "jet",
  "cash",
  "case",
  "lane",
  "dean",
  "van",
  "del",
  "von",
  "don",
  "bo",
  "jay",
  "kenny",
  "joe",
  "max",
  "rush",
  "price",
  "gage",
  "page",
  "sam",
  "drew",
  "wade",
  "dee",
]);

/** A player's NameKeys, or null when his name does not fold (non-Latin, empty) or its surname is one letter. */
export function nameKeysOf(name: string): NameKeys | null {
  const m = mergeName(name);
  const tokens = m === null ? [] : m.split(" ").filter((t) => t.length > 0);
  const surname = tokens[tokens.length - 1];
  if (surname === undefined || surname.length < 2) return null;
  const first = tokens[0];
  const given =
    tokens.length >= 2 && first !== undefined && first.length >= 3 && !COMMON_WORD_NAMES.has(first)
      ? first
      : null;
  return { surname, whole: tokens.join(""), given, tokens };
}

/**
 * The folded words of a piece of text, read as a name is folded: each word with its punctuation
 * dropped (`Ostrander's` → `ostranders`, `Smith-Njigba` → `smithnjigba`), each part between its
 * punctuation (`Quist/Ostrander`), and every run of two or three adjacent words joined (a spaced
 * compound surname). A word that does not fold (symbols, non-Latin) contributes nothing.
 */
function foldedWords(text: string): ReadonlySet<string> {
  const out = new Set<string>();
  const words: string[] = [];
  for (const w of text.split(/\s+/u)) {
    if (w.length === 0 || w.length > MAX_NAME_CHARS) continue;
    const f = mergeName(w)?.replaceAll(" ", "") ?? "";
    words.push(f);
    if (f.length > 0) out.add(f);
    for (const part of w.split(/\p{P}+/u)) {
      const g = part.length === 0 ? null : mergeName(part);
      if (g !== null) out.add(g.replaceAll(" ", ""));
    }
  }
  for (let i = 0; i < words.length; i++) {
    let run = words[i] ?? "";
    for (let j = i + 1; j < Math.min(words.length, i + 3); j++) {
      run += words[j] ?? "";
      if (run.length > 0) out.add(run);
    }
  }
  return out;
}

/** Whether folded words name a player: his surname or whole name, possessive (`…s`) included. */
function namesPlayer(words: ReadonlySet<string>, k: NameKeys): boolean {
  return (
    words.has(k.surname) ||
    words.has(`${k.surname}s`) ||
    words.has(k.whole) ||
    words.has(`${k.whole}s`)
  );
}

/**
 * The parts of a third-party text of a news item that also names other players which are about the
 * subject ALONE: a clause (CLAUSE_SPLIT) naming him and none of the others is kept whole; a clause
 * naming him and another is split into its phrases (PHRASE_SPLIT), each kept on the same rule; a
 * clause naming nobody ("He will not play") stays out — whom it is about is not resolved. Re-wrapped
 * with the original source tag (the parts joined by "; ", so no claim pattern can straddle two of
 * them), or null when nothing is his alone. Only sliced, never interpreted: the flags are recomputed
 * on what is kept. Stage C finding evidence-item-claims-misattributed: the matcher attaches one item
 * to every player it names, and a teammate's claim in a clause that also named the subject — "X
 * (ankle) ruled out, Y to start", "with X out Y starts", "X will not play, so Y …" — was his.
 */
export function partsAbout(
  text: UntrustedText,
  subject: NameKeys,
  others: readonly NameKeys[],
): UntrustedText | null {
  // another player is seen by his surname or whole name, and by his first name too unless the
  // subject shares it ("Josh Allen" names no "Josh Jacobs")
  const namesOther = (words: ReadonlySet<string>, o: NameKeys): boolean =>
    namesPlayer(words, o) ||
    (o.given !== null && !subject.tokens.includes(o.given) && words.has(o.given));
  const alone = (piece: string): boolean => {
    const words = foldedWords(piece);
    return namesPlayer(words, subject) && !others.some((o) => namesOther(words, o));
  };
  const kept: string[] = [];
  for (const raw of text.untrusted_text.value.split(CLAUSE_SPLIT)) {
    const clause = raw.trim();
    if (clause.length === 0 || !namesPlayer(foldedWords(clause), subject)) continue;
    if (alone(clause)) {
      kept.push(clause);
      continue;
    }
    for (const p of clause.split(PHRASE_SPLIT)) {
      const phrase = p.trim();
      if (phrase.length > 0 && alone(phrase)) kept.push(phrase);
    }
  }
  return kept.length === 0 ? null : wrapUntrusted(kept.join("; "), text.untrusted_text.source);
}

/**
 * The NameKeys of the players around the subject in the local player index: his NFL teammates and
 * the players of the team he faces in week `w` (not him, not a team unit, not sharing his surname — a
 * shared surname cannot tell them apart in text). The matcher refs a player named by his surname
 * only when the item also names his team, and an ESPN outlook carries no refs at all, so "with Quist
 * (ankle) ruled out" about a teammate — or an opponent the outlook discusses — may carry nothing to
 * say whom it is about: one of these surnames in the text makes it a multi-player text for E10.
 * Empty when the index is not loaded (refs alone decide); the opponent is skipped when the week's
 * pro schedule cannot say who it is.
 */
export function neighbourKeysOf(
  ctx: ToolContext,
  season: number,
  w: Week,
  subject: { readonly espn_id: number; readonly pro_team_id: number; readonly keys: NameKeys },
): readonly NameKeys[] {
  if (subject.pro_team_id <= 0) return [];
  const teams = new Set<number>([subject.pro_team_id]);
  try {
    for (const g of ctx.services.datasets.proSchedule.games(season, [w]).rows) {
      if (g.week !== w) continue;
      if (g.home_pro_team_id === subject.pro_team_id) teams.add(g.away_pro_team_id);
      else if (g.away_pro_team_id === subject.pro_team_id) teams.add(g.home_pro_team_id);
    }
  } catch {
    // the opponent stays unknown: teammates only
  }
  let rows: readonly { espn_id: number; pro_team_id: number; full_name: string }[];
  try {
    rows = ctx.services.playerUniverse.all(season).rows;
  } catch {
    return [];
  }
  const out: NameKeys[] = [];
  for (const r of rows) {
    if (!teams.has(r.pro_team_id) || r.espn_id <= 0 || r.espn_id === subject.espn_id) continue;
    const k = nameKeysOf(r.full_name);
    if (k !== null && k.surname !== subject.keys.surname) out.push(k);
  }
  return out;
}

/** The keys among `keys` whose player a text names (surname or whole name, possessive included). */
export function namedIn(text: string, keys: readonly NameKeys[]): readonly NameKeys[] {
  if (keys.length === 0) return [];
  const words = foldedWords(text);
  return keys.filter((k) => namesPlayer(words, k));
}

/** Who a news item names besides the subject, as E10 reads it. */
export type ItemOthers =
  /** Nobody else: the item is his alone (read whole). */
  | { readonly kind: "own" }
  /** These others, named by their keys: read only in the parts naming him alone. */
  | { readonly kind: "others"; readonly keys: readonly NameKeys[] }
  /** Others that cannot be named, or his own name does not fold: not read for him at all. */
  | { readonly kind: "unreadable" };

/**
 * The other players a news item names — its refs that are not the subject, by ESPN id or by gsis id
 * through the crosswalk — with their NameKeys from the local player index. `unreadable` when one of
 * them cannot be named (no ESPN id, not in the index, a name that does not fold), shares the
 * subject's surname, or the subject's own name does not fold: such an item cannot be read for him
 * safely.
 */
export function othersOf(
  ctx: ToolContext,
  item: NewsItem,
  subject: { readonly espn_id: number; readonly gsis_id: string | null; readonly name: string },
): ItemOthers {
  const ids: number[] = [];
  for (const r of newsRefsOf(item)) {
    if (r.espn_id === subject.espn_id) continue;
    if (r.gsis_id !== null && r.gsis_id === subject.gsis_id) continue;
    const id = r.espn_id ?? (r.gsis_id === null ? null : espnIdOfGsis(ctx, r.gsis_id));
    if (id === null || id <= 0) return { kind: "unreadable" };
    if (id !== subject.espn_id && !ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) return { kind: "own" };
  const mine = nameKeysOf(subject.name);
  if (mine === null) return { kind: "unreadable" };
  let rows: readonly { readonly espn_id: number; readonly full_name: string }[];
  try {
    rows = ctx.services.playerUniverse.byIds(ids).rows;
  } catch {
    return { kind: "unreadable" };
  }
  const keys: NameKeys[] = [];
  for (const id of ids) {
    const row = rows.find((x) => x.espn_id === id);
    const k = row === undefined ? null : nameKeysOf(row.full_name);
    if (k === null || k.surname === mine.surname) return { kind: "unreadable" };
    keys.push(k);
  }
  return { kind: "others", keys };
}

/** E10 data (plan 07 E10; EvidenceData). */
export const evidenceSchema = z.strictObject({
  flag: z.enum([
    "unconfirmed_narrative",
    "quiet_role_change",
    "availability_conflict",
    "consistent",
    "no_claim",
  ]),
  structured_disagrees: z
    .strictObject({
      field: z.enum([
        "injury_status",
        "lineup_slot",
        "stats",
        "waiver_process_date",
        "lineup_locked",
      ]),
      structured_value: z.union([z.string().max(64), z.number(), z.boolean()]).nullable(),
      claim_value: z.union([z.string().max(64), z.number(), z.boolean()]).nullable(),
    })
    .nullable(),
  injection_flags: z
    .array(z.enum(["imperative", "second_person", "json_like", "role_marker"]))
    .max(4),
  prior: z
    .strictObject({
      p_active: probNull,
      role_shares: z.record(z.string().regex(/^[a-z_]{1,24}$/), z.number()).nullable(),
    })
    .nullable(),
  evidence: z
    .array(
      z.strictObject({
        source: z.string().regex(/^[a-z0-9_.]{1,64}$/),
        claim: ut,
        type: z.enum(["availability", "role", "health", "coaching_intent", "transaction", "other"]),
        direction: z.enum(["up", "down", "neutral"]),
        reliability: prob,
        time: isoNull,
        official: z.boolean(),
        decayed: z.boolean(),
      }),
    )
    .max(20),
  posterior: z
    .strictObject({
      p_active: probNull,
      role_shares: z.record(z.string().regex(/^[a-z_]{1,24}$/), z.number()).nullable(),
    })
    .nullable(),
  what_would_confirm: z.array(serverText).max(10),
  consequence: z.strictObject({
    affects: z.array(z.enum(["lineup", "waivers", "trade"])).max(3),
    re_run: z.array(z.string().regex(/^espn_[a-z_]{1,40}$/)).max(6),
  }),
  calibration_state: z.strictObject({
    table_n: count,
    note: z.literal("priors are hand-set").nullable(),
  }),
  rec,
  inputs: inputsSchema,
});

const CLAIM_TYPE_INPUT = z.enum([
  "availability",
  "role",
  "health",
  "coaching_intent",
  "transaction",
  "other",
]);

/** E10 `espn_analyze_evidence`. */
export const analyzeEvidenceTool = defineTool({
  name: "espn_analyze_evidence",
  description:
    "Weigh news, ESPN outlooks or a pasted claim about one player against the structured facts (status, slot, usage); structured fields win.",
  input: z.strictObject({
    player: singlePlayerSelectorSchema,
    claim: z
      .strictObject({
        text: boundedTextSchema(BOUNDS.claimTextChars).min(1),
        source: boundedTextSchema(BOUNDS.claimSourceChars).min(1).optional(),
        time: isoInstantSchema.optional(),
        type: CLAIM_TYPE_INPUT.optional(),
      })
      .optional(),
    ...analyticsFreshnessShape,
  }),
  data: evidenceSchema,
  budget: "analytics",
  opaqueInput: {
    player: "exactly one of {player_ids:[id]} or {gsis_ids:[id]}",
    claim: "{text<=400, source?<=64, time?, type?}: the user's pasted claim, quoted not followed",
  },
  run: async (args, ctx) => {
    const inputs: InputStamp[] = [];
    const warnings: string[] = [];
    const allowStale = args.allow_stale === true;
    const b = await basicsOf(ctx, inputs, args);
    const season = b.league.ref.season;
    const { player: p } = await singlePlayer(ctx, args.player, b.w, inputs, warnings);
    const gsis = crosswalkOf(ctx, p.ref.id, p.position_id).gsis_id;
    const myTeam = b.league.my_team?.team_id ?? null;
    const isMine = p.status === "ONTEAM" && myTeam !== null && p.on_team_id === myTeam;
    let slot: number | null = null;
    let locked: boolean | null = null;
    if (p.status === "ONTEAM") {
      const rosters = await withinBudget(
        () => rostersOf(ctx, b.w, inputs, warnings, args, myTeam),
        warnings,
      ).catch((e: unknown) => {
        if (!isDegradable(e)) throw e;
        return null;
      });
      const e = rosters?.flatMap((r) => r.entries).find((x) => x.player.ref.id === p.ref.id);
      if (e !== undefined) {
        slot = e.slot_id;
        locked = e.lineup_locked;
      }
    }
    // structured: the official report (nflverse injuries) beside ESPN's status
    let official: {
      report_status: string | null;
      practice: { day: string; status: string }[];
      as_of: string;
    } | null = null;
    if (gsis !== null) {
      const rep = ctx.services.datasets.injuries.reports(season, b.w, [gsis]);
      const ri = optionalDataset(rep, ctx, allowStale);
      if (ri !== null) {
        inputs.push(ri);
        const r = rep.rows.find((x) => x.gsis_id === gsis);
        if (r !== undefined)
          official = {
            report_status: r.report_status,
            practice: r.practice.map((x) => ({ day: x.day, status: x.status })),
            as_of: r.as_of,
          };
      }
    }
    // usage (D1's rows) as the detector reads them
    await turn();
    const u = usageOf(
      ctx,
      [{ p, gsis }],
      season,
      Array.from({ length: b.w }, (_, i) => i + 1),
      b.settings,
      allowStale,
      inputs,
    );
    const usage = (u.byId.get(p.ref.id)?.games ?? []).map((g) => usageWeekOf(g, g.rz_team ?? null));
    // texts: ESPN's outlooks and the RSS items about him — wrapped at the source, never followed
    const texts: EvidenceText[] = [];
    const ol = await withinBudget(
      () => ctx.services.platform.getPlayerOutlooks(leagueRef(ctx), [p.ref], [b.w], readOpts(ctx)),
      warnings,
    ).catch((e: unknown) => {
      if (!isDegradable(e)) throw e;
      warnings.push("partial: espn:kona_player_info unavailable: no ESPN outlook in the evidence");
      return null;
    });
    // the subject's name keys and the players around him (teammates, the week's opponent): a
    // third-party text that names one of them is read only in its parts naming him alone (Stage C
    // finding evidence-item-claims-misattributed: "with <teammate> sidelined, <him> …" in his own
    // ESPN outlook was an 'out' claim about him)
    const keys = nameKeysOf(p.name);
    const around =
      keys === null
        ? []
        : neighbourKeysOf(ctx, season, b.w, {
            espn_id: p.ref.id,
            pro_team_id: p.pro_team_id,
            keys,
          });
    let outlooksScoped = 0;
    const outlookText = (t: UntrustedText): UntrustedText | null => {
      const named = namedIn(t.untrusted_text.value, around);
      if (named.length === 0) return t;
      outlooksScoped += 1;
      return keys === null ? null : partsAbout(t, keys, named);
    };
    for (const o of ol === null ? [] : take(ctx, ol, inputs)) {
      const wk = o.weekly[String(b.w)];
      const wkText = wk === undefined ? null : outlookText(wk);
      if (wkText !== null) texts.push({ text: wkText, time: p.last_news_at });
      const seasonText = o.season === null ? null : outlookText(o.season);
      if (seasonText !== null) texts.push({ text: seasonText, time: null });
    }
    if (outlooksScoped > 0)
      warnings.push(
        `${String(outlooksScoped)} ESPN outlook text(s) also name other players: only their parts naming this player alone are read`,
      );
    if (gsis !== null) {
      const since = new Date(ctx.nowMs - 7 * 24 * 3600 * 1000).toISOString();
      const news = ctx.services.datasets.news.recent(since, 10, [gsis]);
      const ni = optionalDataset(news, ctx, allowStale);
      if (ni !== null) {
        inputs.push(ni);
        // an item that names other players too (any of its refs — an ESPN id with no gsis pair
        // counts) is read only in the parts naming him ALONE: the matcher attaches one item to every
        // player it names, and "<starter> (ankle) ruled out, <him> to start" is no 'out' claim about
        // him; an item whose other players cannot be named is not read for him at all (Stage C
        // finding evidence-item-claims-misattributed)
        let scoped = 0;
        let skipped = 0;
        for (const it of news.rows.slice(0, 8)) {
          const byRefs = othersOf(ctx, it, { espn_id: p.ref.id, gsis_id: gsis, name: p.name });
          // a player around him the matcher did not ref (his surname alone, no team named) counts too
          const unreffed = namedIn(
            `${it.title.untrusted_text.value}\n${it.blurb.untrusted_text.value}`,
            around,
          );
          const who: ItemOthers =
            byRefs.kind === "unreadable" || unreffed.length === 0
              ? byRefs
              : {
                  kind: "others",
                  keys: [...(byRefs.kind === "others" ? byRefs.keys : []), ...unreffed],
                };
          const parts = [it.title, it.blurb]
            .filter((t) => t.untrusted_text.value.length > 0)
            .map((t) =>
              who.kind === "own"
                ? t
                : who.kind === "others" && keys !== null
                  ? partsAbout(t, keys, who.keys)
                  : null,
            )
            .filter((t): t is UntrustedText => t !== null);
          if (who.kind !== "own") {
            if (parts.length === 0) skipped += 1;
            else scoped += 1;
          }
          for (const t of parts) texts.push({ text: t, time: it.published_at });
        }
        if (scoped + skipped > 0)
          warnings.push(
            `${String(scoped + skipped)} news item(s) also name other players: only their parts naming this player alone are read${skipped > 0 ? ` (${String(skipped)} with none, or whose other players cannot be named, skipped)` : ""}`,
          );
      }
    }
    const out = analyzeEvidence({
      player: {
        player_id: p.ref.id,
        gsis_id: gsis,
        name: p.name,
        position: p.position,
        injury_status: p.injury_status,
        roster: p.status === "ONTEAM" ? (isMine ? "mine" : "rival") : "none",
        slot_id: slot,
        lineup_locked: locked,
        waiver_process_date: p.waiver_process_date,
        last_news_at: p.last_news_at,
      },
      official,
      usage,
      texts: texts.slice(0, 20),
      ...(args.claim === undefined
        ? {}
        : {
            claim: {
              text: args.claim.text,
              ...(args.claim.source === undefined ? {} : { source: args.claim.source }),
              ...(args.claim.time === undefined ? {} : { time: args.claim.time }),
              ...(args.claim.type === undefined ? {} : { type: args.claim.type }),
            },
          }),
      // the per-source calibration table (Phase 3, plan 10 C8): the official practice report's
      // labelled history plus every claim the retrospective scored for this league; table_n counts
      // the news claims only, so the posterior stays null until 200 of them are scored
      calibration_table: calibrationTableOf(ctx),
      week: b.w,
      clock: ctx.services.clock,
      inputs: toDataInputs(inputs, ctx.nowMs),
    });
    // this call's scorable news claims, logged value-free for the retrospective to score (C8)
    logClaims(
      ctx,
      season,
      b.w,
      p.ref.id,
      p.injury_status,
      out.data.prior?.p_active ?? null,
      out.claims,
    );
    return {
      data: { ...out.data, inputs: toDataInputs(inputs, ctx.nowMs) },
      inputs,
      warnings: [...warnings, ...out.warnings],
      estimate: true,
      partial: warnings.some((x) => x.startsWith("partial:")),
      listKey: "evidence",
      week: b.w,
    };
  },
});

// --- E11 espn_analyze_league_activity --------------------------------------------------------------

const named = z.strictObject({ player_id: playerId, name: playerName, count });

/** E11 data (plan 07 E11; LeagueActivityData). */
export const activitySchema = z.strictObject({
  window: z.strictObject({ from: iso, to: iso }),
  transactions: z.strictObject({
    adds: count,
    drops: count,
    claims: count,
    losing_claims: count,
    trades: count,
    by_team: z
      .array(
        z.strictObject({
          team_id: teamId,
          name: ut,
          adds: count,
          drops: count,
          claims_won: count,
          claims_lost: count,
          notable: z
            .array(
              z.strictObject({
                player_id: playerId,
                name: playerName,
                action: z.string().regex(/^[a-z_]{1,24}$/),
              }),
            )
            .max(10),
        }),
      )
      .max(20),
  }),
  waiver_order_movement: z
    .array(
      z.strictObject({
        team_id: teamId,
        rank_before: count.nullable(),
        rank_after: count.nullable(),
        cause: z.enum(["successful_claim", "reset"]).nullable(),
      }),
    )
    .max(20),
  claims_by_rank: z.array(z.strictObject({ rank: count, won: count, lost: count })).max(20),
  standings_movement: z
    .array(
      z.strictObject({
        team_id: teamId,
        rank_before: count.nullable(),
        rank_after: count.nullable(),
      }),
    )
    .max(20),
  top_added: z.array(named).max(10),
  top_dropped: z.array(named).max(10),
  rival_needs: z
    .array(
      z.strictObject({
        team_id: teamId,
        weakest_slots: z.array(slotName).max(10),
        likely_targets: z.array(playerId).max(10),
        ir_blocked: z.boolean(),
      }),
    )
    .max(20),
  learned: z.strictObject({
    second_claim_at_new_position: z.boolean().nullable(),
    waiver_rank_moves_on_success: z.boolean().nullable(),
  }),
  rec: rec.nullable(),
  inputs: inputsSchema,
});

/** The most per-week transaction reads one E11 call makes (ESPN's feed is per scoring period). */
export const ACTIVITY_MAX_WEEKS = 3;

/**
 * The scoring periods a `since_days` window spans, newest first: the current one plus one per seven
 * days, at most ACTIVITY_MAX_WEEKS (older weeks come from the persisted history only, said so).
 */
export function activityWeeks(w: Week, sinceDays: number): Week[] {
  const want = Math.ceil(sinceDays / 7) + 1;
  const out: Week[] = [];
  for (let x = w; x >= 1 && out.length < Math.min(want, ACTIVITY_MAX_WEEKS); x--) out.push(x);
  return out;
}

/** The league's transactions: the window's weekly ESPN feeds merged with the persisted history (A6). */
async function transactionsOf(
  ctx: ToolContext,
  w: Week,
  sinceDays: number,
  since: string,
  inputs: InputStamp[],
  warnings: string[],
): Promise<Transaction[]> {
  const byId = new Map<string, Transaction>();
  const weeks = activityWeeks(w, sinceDays);
  const state = { unavailable: false };
  for (const week of weeks) {
    const got = await withinBudget(
      () =>
        ctx.services.platform.listTransactions(
          leagueRef(ctx),
          {
            types: ["FREEAGENT", "WAIVER", "WAIVER_ERROR", "TRADE_ACCEPT"],
            week,
            since,
            count: BOUNDS.txnCount.max,
            team_id: null,
          },
          readOpts(ctx),
        ),
      warnings,
    ).catch((e: unknown) => {
      if (!isDegradable(e) && (e as { effCode?: unknown }).effCode !== "ESPN_REQUIRES_COOKIES")
        throw e;
      state.unavailable = true;
      return null;
    });
    if (got === null) break;
    for (const t of take(ctx, got, inputs).items) byId.set(t.transaction_id, t);
  }
  if (state.unavailable)
    warnings.push("espn:mTransactions2 unavailable: the server's persisted history only");
  const covered = weeks[weeks.length - 1] ?? w;
  if (Math.ceil(sinceDays / 7) + 1 > weeks.length && covered > 1)
    warnings.push(
      `weeks before ${String(covered)} come from the server's persisted history only (one feed read per week)`,
    );
  // the configured season's stored rows in the window (never a previous season's — Stage C finding
  // transactions-store-not-season-scoped)
  await turn();
  for (const t of seasonTransactions(ctx.services.transactionsSeen, leagueRef(ctx).season, since)
    .rows)
    if (!byId.has(t.transaction_id)) byId.set(t.transaction_id, t);
  return [...byId.values()];
}

/** E11 `espn_analyze_league_activity`. */
export const analyzeLeagueActivityTool = defineTool({
  name: "espn_analyze_league_activity",
  description:
    "The league activity digest: adds, drops, claims won and lost, trades, waiver-order movement, rival needs and IR-blocked rivals over a window.",
  input: z.strictObject({
    since_days: z
      .number()
      .int()
      .min(BOUNDS.sinceDays.min)
      .max(BOUNDS.sinceDays.max)
      .default(BOUNDS.sinceDays.default),
    include_rival_needs: z.boolean().default(true),
    ...analyticsFreshnessShape,
    ...detailShape,
  }),
  data: activitySchema,
  budget: "analytics",
  run: async (args, ctx) => {
    const inputs: InputStamp[] = [];
    const warnings: string[] = [];
    const b = await basicsOf(ctx, inputs, args);
    const since = new Date(ctx.nowMs - args.since_days * 24 * 3600 * 1000).toISOString();
    const txns = await transactionsOf(ctx, b.w, args.since_days, since, inputs, warnings);
    const standings = await standingsOrNull(ctx, inputs, warnings);
    const myTeam = b.league.my_team?.team_id ?? null;
    const rosters = await withinBudget(
      () => rostersOf(ctx, b.w, inputs, warnings, args, myTeam),
      warnings,
    ).catch((e: unknown) => {
      if (!isDegradable(e)) throw e;
      return null;
    });
    const weeks = remainingWeeks(b.rules.playoffs, b.w).slice(0, 4);
    // ESPN's ROS total read as E1 reads it (Stage C finding projection-ros-includes-week18)
    const ros = await rosReadingOf(
      ctx,
      b.league.ref.season,
      inputs,
      warnings,
      args.allow_stale === true,
    );
    const pool = args.include_rival_needs ? await poolOf(ctx, b.w, inputs, warnings, 25) : [];
    const names = new Map<number, UntrustedText>();
    for (const r of rosters ?? []) names.set(r.team.team_id, r.team_name);
    for (const t of standings?.teams ?? []) if (!names.has(t.team_id)) names.set(t.team_id, t.name);
    const ids = [
      ...new Set([
        ...(standings?.teams ?? []).map((t) => t.team_id),
        ...(rosters ?? []).map((r) => r.team.team_id),
      ]),
    ];
    const teams: ActivityTeam[] = ids.flatMap((id) => {
      const name = names.get(id);
      if (name === undefined) return [];
      const st = standings?.teams.find((t) => t.team_id === id) ?? null;
      const r = rosters?.find((x) => x.team.team_id === id) ?? null;
      return [
        {
          team_id: id,
          name,
          rank_before: null,
          rank_now: st?.rank ?? null,
          waiver_rank_before: null,
          waiver_rank_now: st?.waiver_rank ?? null,
          ir_blocked: r === null ? false : auditIr(seatsOf(r), b.slots).invalid,
          ...(r === null
            ? {}
            : {
                players: r.entries.map((e) => ({
                  player_id: e.player.ref.id,
                  position: e.player.position,
                  slot_id: e.slot_id,
                  weekly: valueWeeks(e.player, weeks, ros),
                })),
              }),
        },
      ];
    });
    if (teams.length === 0) throw new EffError("NOT_FOUND");
    const out = analyzeLeagueActivity({
      since_days: args.since_days,
      transactions: txns,
      teams,
      my_team_id: myTeam,
      roster: b.slots,
      pool: pool.map((p) => ({
        player_id: p.ref.id,
        position: p.position,
        slot_id: 20,
        weekly: valueWeeks(p, weeks, ros),
      })),
      include_rival_needs: args.include_rival_needs,
      clock: ctx.services.clock,
      inputs: toDataInputs(inputs, ctx.nowMs),
    });
    if (ctx.services.transactionsSeen.oldestSeen() === null)
      warnings.push("no persisted transaction history yet: the window shows this week's feed only");
    const data: LeagueActivityData = { ...out.data, inputs: toDataInputs(inputs, ctx.nowMs) };
    return {
      data,
      inputs,
      warnings: [...warnings, ...out.warnings],
      estimate: true,
      partial: warnings.some((x) => x.startsWith("partial:")),
      listKey: "rival_needs",
      week: b.w,
    };
  },
});

// --- E5 at P1: the extra inputs `espn_analyze_waivers` adds under EFF_TOOLSET=full -----------------

/** What E5 at P1 adds to the P0 request (plan 07 E5 P1; plan 10 B3, B4). */
export interface WaiverP1Extras {
  readonly usage: ReadonlyMap<number, SignalInput>;
  readonly rival_rosters: readonly RivalRoster[];
  readonly sleeper_trend: ReadonlyMap<number, number>;
  readonly mechanics: ReturnType<typeof learnWaiverMechanics> | null;
  readonly faab: FaabContextInput | null;
}

/**
 * E5's P1 inputs: usage signals per candidate (D1's rows through E5's detector), every rival's
 * roster (each rival's own lineup gain), Sleeper's trending adds (secondary), the mechanics learned
 * from the persisted claim history, and — in a FAAB league — budgets and the league's winning bids.
 */
export function waiverP1Extras(
  ctx: ToolContext,
  b: LeagueBasics,
  candidates: readonly WaiverPlayer[],
  rosters: readonly Roster[],
  me: number,
  standings: Standings | null,
  weeks: readonly Week[],
  inputs: InputStamp[],
  warnings: string[],
  allowStale: boolean,
  ros: RosReading | null,
): WaiverP1Extras {
  const season = b.league.ref.season;
  const byId = new Map<number, WaiverPlayer>();
  for (const c of candidates) byId.set(c.player_id, c);
  // usage: the candidates' D1 rows (the PlatformPlayer is not needed beyond the ids and positions)
  const u = usageOf(
    ctx,
    candidates.map((c) => ({
      p: { ref: { platform: "espn" as const, id: c.player_id }, position_id: c.position_id },
      gsis: c.gsis_id,
    })),
    season,
    Array.from({ length: b.w }, (_, i) => i + 1),
    b.settings,
    allowStale,
    inputs,
  );
  const usage = new Map<number, SignalInput>();
  for (const c of candidates) {
    const games = u.byId.get(c.player_id)?.games ?? [];
    usage.set(c.player_id, {
      position: c.position,
      games: games.map((g) => usageWeekOf(g, g.rz_team ?? null)),
    });
  }
  if (u.gaps.length > 0) warnings.push(`usage signals limited: ${u.gaps[0] ?? ""}`.slice(0, 200));
  // Sleeper trending adds (secondary; ESPN's percentChange is primary)
  const sleeper = new Map<number, number>();
  const tr = ctx.services.datasets.trending.latest();
  const ti = optionalDataset(tr, ctx, allowStale);
  if (ti !== null) {
    inputs.push(ti);
    for (const r of tr.rows) {
      if (r.kind !== "add" || r.gsis_id === null) continue;
      // the gsis id's ONE current pair, and only when it is a candidate: a gsis id paired with two
      // ESPN players (a re-key, a removed override) gave its trend to both — a different player's
      // among them (Stage C finding crosswalk-reverse-lookup-lowest-id); resolved only for a row
      // that touches a candidate at all
      if (!espnIdsPairedWith(ctx, r.gsis_id).some((id) => byId.has(id))) continue;
      const id = espnIdOfGsis(ctx, r.gsis_id, warnings);
      if (id !== null && byId.has(id)) sleeper.set(id, r.count);
    }
  }
  // the mechanics the league's own persisted feed has shown (null until a same-run pair exists)
  const history = ctx.services.transactionsSeen.list(null, 1000);
  const runs = claimRuns(history);
  const mechanics = runs.length === 0 ? null : learnWaiverMechanics({ runs });
  // FAAB: budgets from the standings' counters, winning bids from the history
  let faab: FaabContextInput | null = null;
  if (b.rules.waiver.uses_budget && b.rules.waiver.budget !== null) {
    const budget = b.rules.waiver.budget;
    const left = (team: number): number | null => {
      const spent = standings?.teams.find((t) => t.team_id === team)?.transaction_counter
        .budget_spent;
      return spent === null || spent === undefined ? null : Math.max(0, budget - spent);
    };
    const rivalBudgets = new Map<number, number | null>();
    for (const r of rosters)
      if (r.team.team_id !== me) rivalBudgets.set(r.team.team_id, left(r.team.team_id));
    faab = {
      my_budget: left(me),
      rival_budgets: rivalBudgets,
      history: [],
      reserve: "none",
    };
  }
  return {
    usage,
    rival_rosters: rivalRosters(ctx, rosters, me, weeks, ros),
    sleeper_trend: sleeper,
    mechanics,
    faab,
  };
}
