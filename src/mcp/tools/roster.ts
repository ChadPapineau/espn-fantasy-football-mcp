// roster.ts — B1 espn_get_roster (plan 07 B1): one team's roster with the SLOT map for `slot` and the
// POSITION map for `position` (research 03 §B.2 trap), per-player locks from the pro schedule
// (domain/league lockPlan), the IR audit (research 05 §4.3: OUT / INJURY_RESERVE only; a healthy
// player in IR makes the roster invalid and blocks adds), counts, empty starting slots, ESPN's
// native per-player facts (labelled `_espn`) and the crosswalk state. `all: true` returns every
// team in the compact form from the same single mRoster request. mRoster drift degrades to the
// nightly roster snapshot, served stale and said so (plan 01 §7).
import { z } from "zod/v4";
import { byeWeekOf, lockPlan, weekGameState, type LockPlan } from "../../domain/league/schedule.js";
import {
  auditIr,
  emptyStartingSlots,
  irSectionOf,
  rosterCounts,
  seatsOf,
} from "../../domain/league/roster.js";
import {
  ROSTER_ALL_LIST_KEY,
  isIrEligible,
  type League,
  type ProSchedule,
  type Roster,
  type RosterData,
  type RosterPlayerRow,
  type RosterSlots,
  type RosterSummary,
  type RosterToolData,
} from "../../domain/league/types.js";
import { detailShape, espnFreshnessShape, teamIdSchema, weekSchema } from "../bounds.js";
import type { InputStamp } from "../envelope.js";
import { EffError } from "../errors.js";
import { defineTool, type ToolContext } from "../define.js";
import {
  crosswalkOf,
  isDegradable,
  leagueOf,
  leagueRef,
  ownershipRow,
  readOpts,
  scheduleOf,
  slotsOf,
  take,
  teamOf,
  weekOf,
  withinBudget,
} from "./common.js";
import {
  count,
  crosswalkStatus,
  gameState,
  gsisOrNull,
  injuryStatus,
  isoNull,
  ownershipRow as ownershipSchema,
  playerId,
  playerName,
  pointsNull,
  position,
  proTeamNull,
  slotClass,
  slotName,
  teamId,
  tokenNull,
  ut,
  week,
} from "./schemas.js";

const rosterPlayerSchema = z.strictObject({
  player_id: playerId,
  gsis_id: gsisOrNull,
  name: playerName,
  position,
  eligible_slots: z.array(slotName).max(40),
  pro_team: proTeamNull,
  bye_week: week.nullable(),
  slot: slotName,
  slot_id: z.number().int().min(0).max(99),
  slot_class: slotClass,
  is_flex: z.boolean(),
  lineup_locked: z.boolean(),
  kickoff: isoNull,
  lock_at: isoNull,
  game_state: gameState,
  injury_status: injuryStatus,
  injured: z.boolean(),
  ir_eligible: z.boolean(),
  droppable: z.boolean().nullable(),
  ownership: ownershipSchema,
  projection_week_espn: pointsNull,
  points_week_espn: pointsNull,
  last_news_at: isoNull,
  has_outlook: z.boolean(),
  acquisition: z.strictObject({ type: tokenNull, date: isoNull }),
  crosswalk: crosswalkStatus,
});

const countsSchema = z.strictObject({ starters: count, bench: count, ir: count, total: count });

const lockScheduleSchema = z
  .array(
    z.strictObject({
      lock_at: z.iso.datetime({ offset: true }),
      player_ids: z.array(playerId).max(60),
    }),
  )
  .max(60);

const teamScopeSchema = z.strictObject({
  scope: z.literal("team"),
  team_id: teamId,
  name: ut,
  week,
  is_mine: z.boolean(),
  lineup_editable: z.boolean(),
  players: z.array(rosterPlayerSchema).max(60),
  ir: z.strictObject({
    slots: count,
    occupied: z.array(z.strictObject({ player_id: playerId, injury_status: injuryStatus })).max(20),
    invalid: z.boolean(),
    invalid_players: z.array(playerId).max(20),
    eligible_now: z.array(playerId).max(60),
    forced_drop_needed: z.boolean(),
    blocked: z.array(z.literal("adds")).max(1),
  }),
  empty_starting_slots: z.array(slotName).max(30),
  lock_schedule: lockScheduleSchema,
  latest_execution_time: isoNull,
  counts: countsSchema,
});

const allScopeSchema = z.strictObject({
  scope: z.literal("all"),
  week,
  rosters: z
    .array(
      z.strictObject({
        team_id: teamId,
        name: ut,
        is_mine: z.boolean(),
        players: z
          .array(
            z.strictObject({
              player_id: playerId,
              name: playerName,
              position,
              pro_team: proTeamNull,
              slot: slotName,
              slot_class: slotClass,
              lineup_locked: z.boolean(),
              injury_status: injuryStatus,
              projection_week_espn: pointsNull,
            }),
          )
          .max(60),
        ir_invalid: z.boolean(),
        counts: countsSchema,
      }),
    )
    .max(40),
});

/** B1 data (plan 07 B1; RosterToolData, discriminated on `scope`). */
export const rosterToolSchema = z.discriminatedUnion("scope", [teamScopeSchema, allScopeSchema]);

/** One team's full roster read (B1 `scope: team`); also the input E2/E5/D2 build on. */
export function rosterData(
  ctx: ToolContext,
  league: League,
  roster: Roster,
  slots: RosterSlots,
  schedule: ProSchedule | null,
  w: number,
): { data: RosterData; plan: LockPlan | null } {
  const seats = seatsOf(roster);
  const audit = auditIr(seats, slots);
  const plan =
    schedule === null
      ? null
      : lockPlan(
          roster.entries.map((e) => ({
            player_id: e.player.ref.id,
            pro_team_id: e.player.pro_team_id,
            lineup_locked: e.lineup_locked,
          })),
          schedule,
          w,
          slots.lineup_lock_type,
          ctx.nowMs,
        );
  const lockOf = new Map(plan?.players.map((p) => [p.player_id, p]) ?? []);
  const players: RosterPlayerRow[] = roster.entries.map((e) => {
    const p = e.player;
    const lock = lockOf.get(p.ref.id) ?? null;
    const xw = crosswalkOf(ctx, p.ref.id, p.position_id);
    return {
      player_id: p.ref.id,
      gsis_id: xw.gsis_id,
      name: p.name,
      position: p.position,
      eligible_slots: p.eligible_slots,
      pro_team: p.pro_team,
      bye_week: p.bye_week ?? (schedule === null ? null : byeWeekOf(schedule, p.pro_team_id)),
      slot: e.slot,
      slot_id: e.slot_id,
      slot_class: e.slot_class,
      is_flex: e.is_flex,
      lineup_locked: e.lineup_locked || lock?.locked === true,
      kickoff: lock?.kickoff ?? null,
      lock_at: lock?.lock_at ?? null,
      game_state: lock?.game_state ?? "tbd",
      injury_status: p.injury_status,
      injured: p.injured,
      ir_eligible: isIrEligible(p.injury_status),
      droppable: p.droppable,
      ownership: ownershipRow(p),
      projection_week_espn: p.projection_week_espn,
      points_week_espn: e.points_week_espn,
      last_news_at: p.last_news_at,
      has_outlook: p.has_outlook,
      acquisition: e.acquisition,
      crosswalk: xw.crosswalk,
    };
  });
  const current = w === league.clock.current_scoring_period;
  return {
    data: {
      team_id: roster.team.team_id,
      name: roster.team_name,
      week: w,
      is_mine: roster.is_mine,
      lineup_editable: roster.is_mine && current && plan !== null && !plan.all_locked,
      players,
      ir: irSectionOf(audit),
      empty_starting_slots: emptyStartingSlots(seats, slots),
      lock_schedule: plan?.schedule ?? [],
      latest_execution_time: plan?.latest_execution_time ?? null,
      counts: rosterCounts(seats),
    },
    plan,
  };
}

/** The compact form of one team (B1 `all: true`). */
export function rosterSummary(roster: Roster, slots: RosterSlots): RosterSummary {
  const seats = seatsOf(roster);
  return {
    team_id: roster.team.team_id,
    name: roster.team_name,
    is_mine: roster.is_mine,
    players: roster.entries.map((e) => ({
      player_id: e.player.ref.id,
      name: e.player.name,
      position: e.player.position,
      pro_team: e.player.pro_team,
      slot: e.slot,
      slot_class: e.slot_class,
      lineup_locked: e.lineup_locked,
      injury_status: e.player.injury_status,
      projection_week_espn: e.player.projection_week_espn,
    })),
    ir_invalid: auditIr(seats, slots).invalid,
    counts: rosterCounts(seats),
  };
}

/**
 * Every team's roster for a week (one mRoster request). On drift or an outage, my team's nightly
 * snapshot is served stale when it exists and covers the week (plan 07 B1 degradation).
 */
export async function rostersOf(
  ctx: ToolContext,
  w: number,
  inputs: InputStamp[],
  warnings: string[],
  args: { force_refresh?: boolean | undefined; allow_stale?: boolean | undefined } = {},
  fallbackTeam: number | null = null,
): Promise<readonly Roster[]> {
  try {
    const got = await ctx.services.platform.getRosters(leagueRef(ctx), w, readOpts(ctx, args));
    return take(ctx, got, inputs);
  } catch (e) {
    if (!isDegradable(e) || fallbackTeam === null) throw e;
    const snap = ctx.services.rosterSnapshots.latestTwo(fallbackTeam)[0];
    if (snap?.week !== w) throw e;
    inputs.push({
      source: "store:roster_snapshot",
      as_of: snap.taken_at,
      fetched_at: snap.taken_at,
      state: "stale",
    });
    warnings.push("espn:mRoster unavailable: served from last night's roster snapshot (stale)");
    return [snap.roster];
  }
}

/**
 * B1 `all: true`'s budget step (ten compact rosters can exceed 20 000 chars — the contract's
 * ROSTER_ALL_LIST_KEY note): teams leave from the end one at a time (mine is first), never silently.
 */
export function rosterAllTrim(
  total: number,
): (d: unknown) => { data: unknown; warning: string; key: string } | null {
  return (d) => {
    const list = (d as { rosters?: unknown[] }).rosters ?? [];
    if (list.length <= 1) return null;
    const kept = list.slice(0, list.length - 1);
    return {
      data: { ...(d as Record<string, unknown>), rosters: kept },
      warning: `rosters truncated to ${String(kept.length)} of ${String(total)} teams to fit the 20000-character budget; pass team_id for any other team`,
      key: "rosters",
    };
  };
}

/** B1 `espn_get_roster`. */
export const getRoster = defineTool({
  name: "espn_get_roster",
  description:
    "A team's roster for a week (default: mine): slots, positions, locks, game state, IR validity, injuries, ESPN projection, ownership. all: every team, compact.",
  input: z
    .strictObject({
      team_id: teamIdSchema.optional(),
      all: z.boolean().default(false),
      week: weekSchema.optional(),
      ...espnFreshnessShape,
      ...detailShape,
    })
    .refine((a) => !(a.all && a.team_id !== undefined), {
      message: "team_id_or_all",
      path: ["all"],
    }),
  data: rosterToolSchema,
  budget: "list",
  run: async (args, ctx) => {
    const inputs: InputStamp[] = [];
    const warnings: string[] = [];
    const league = await leagueOf(ctx, inputs, args);
    const w = weekOf(league, args.week);
    const slots = await slotsOf(ctx, inputs);
    const team = args.all ? null : teamOf(league, args.team_id);
    const rosters = await rostersOf(ctx, w, inputs, warnings, args, team);
    const sched = await withinBudget(
      () => scheduleOf(ctx, league.ref.season, inputs, args.allow_stale === true),
      warnings,
    ).catch((e: unknown) => {
      if (!isDegradable(e)) throw e;
      return null;
    });
    if (sched === null) warnings.push("pro schedule unavailable: kickoffs and lock times unknown");
    const gs = sched === null ? null : weekGameState(sched.schedule, w, ctx.nowMs);
    let data: RosterToolData;
    if (team === null) {
      const sorted = [...rosters].sort(
        (a, b) => Number(b.is_mine) - Number(a.is_mine) || a.team.team_id - b.team.team_id,
      );
      data = { scope: "all", week: w, rosters: sorted.map((r) => rosterSummary(r, slots)) };
    } else {
      const roster = rosters.find((r) => r.team.team_id === team);
      if (roster === undefined) throw new EffError("NOT_FOUND");
      const r = rosterData(ctx, league, roster, slots, sched?.schedule ?? null, w);
      data = { scope: "team", ...r.data };
      if (r.data.ir.invalid)
        warnings.push("roster invalid: a player in IR is not IR-eligible — every add is blocked");
      if (r.plan !== null && r.plan.tbd_player_ids.length > 0)
        warnings.push(
          `${String(r.plan.tbd_player_ids.length)} player(s) have a TBD kickoff: no lock time yet`,
        );
    }
    return {
      data,
      inputs,
      warnings,
      provisional: gs?.provisional ?? false,
      correctionsWindowOpen: gs?.corrections_window_open ?? false,
      week: w,
      ...(team === null
        ? { listKey: ROSTER_ALL_LIST_KEY, trims: [rosterAllTrim(rosters.length)] }
        : {}),
    };
  },
});
