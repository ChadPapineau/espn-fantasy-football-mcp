// players.ts — C1 espn_search_players (plan 07 C1: the only path from a name to a player_id — plan
// 02 §6.4; the name index is local — `espn:players` (players_wl) — because no name filter on
// kona_player_info is verified [A-5]; the keyless view is read once when the dataset was never
// loaded (plan 01 §5.5); league status from kona_player_info + filterIds; drift → identity only)
// and C2 espn_list_players (plan 07 C2: one pool tool, `status` a filter, the mandatory sort and
// ≤ 100 rows are the filter builder's invariants; never outlook text — C14; drift → the last pool
// snapshot, stale). Rows carry ESPN's numbers labelled `_espn` and the crosswalk state.
import { z } from "zod/v4";
import { mergeName } from "../../domain/crosswalk/normalize.js";
import type { EspnPlayerIdentity } from "../../domain/crosswalk/types.js";
import { gamesOfWeek, kickoffOf, opponentOf, teamGame } from "../../domain/league/schedule.js";
import { positionNameOf } from "../../domain/league/slots.js";
import {
  bareUntrusted,
  type PlatformPlayer,
  type PlayerListData,
  type PlayerListRow,
  type PlayerSearchData,
  type PlayerSearchRow,
  type ProSchedule,
  type UntrustedText,
} from "../../domain/league/types.js";
import { PLAYER_LIST_WARNINGS, type PlayerStatusFilter } from "../../providers/platform.js";
import {
  BOUNDS,
  NAME_SORT_OFFSET_REASON,
  detailShape,
  espnFreshnessShape,
  pageInputShape,
  playerSortSchema,
  playerStatusSchema,
  positionSchema,
  searchQuerySchema,
  sortOffsetAllowed,
  weekSchema,
} from "../bounds.js";
import type { InputStamp } from "../envelope.js";
import { EffError } from "../errors.js";
import { defineTool, type ToolContext } from "../define.js";
import {
  crosswalkOf,
  datasetInput,
  isDegradable,
  leagueOf,
  leagueRef,
  proTeamAbbrev,
  readOpts,
  scheduleOf,
  searchRow,
  slotsOf,
  take,
  weekOf,
  withinBudget,
  jerseyOf,
} from "./common.js";
import { isoNull, playerSearchRow, week } from "./schemas.js";

// --- shared ---------------------------------------------------------------------------------------

/** Team id → wrapped team name, from standings when they are already cached or the budget allows. */
async function teamNames(
  ctx: ToolContext,
  inputs: InputStamp[],
  warnings: string[],
): Promise<ReadonlyMap<number, UntrustedText>> {
  try {
    const got = await withinBudget(
      () => ctx.services.platform.getStandings(leagueRef(ctx), readOpts(ctx)),
      warnings,
    );
    if (got === null) return new Map();
    const st = take(ctx, got, inputs);
    return new Map(st.teams.map((t) => [t.team_id, t.name]));
  } catch {
    return new Map();
  }
}

/** Folds a name or query to space-separated lowercase ASCII tokens (`St. Brown` → `st brown`). */
export function foldTokens(raw: string): string[] {
  const m = mergeName(raw);
  return m === null ? [] : m.split(" ").filter((t) => t.length > 0);
}

/**
 * Whether every query token is a prefix of some name token (in any order), plus a rank: an exact
 * full-name match first, then a last-name prefix, then any prefix. 0 = no match.
 */
export function nameMatchRank(
  nameTokens: readonly string[],
  queryTokens: readonly string[],
): number {
  if (queryTokens.length === 0 || nameTokens.length === 0) return 0;
  if (!queryTokens.every((q) => nameTokens.some((n) => n.startsWith(q)))) return 0;
  if (queryTokens.join(" ") === nameTokens.join(" ")) return 3;
  const last = nameTokens[nameTokens.length - 1] ?? "";
  return queryTokens.some((q) => last.startsWith(q)) ? 2 : 1;
}

/** One index entry. */
interface IndexEntry {
  readonly id: number;
  readonly tokens: readonly string[];
  readonly position: string;
  readonly percent_owned: number;
  readonly identity: EspnPlayerIdentity | null;
  readonly player: PlatformPlayer | null;
}

/** The local name index: `espn:players`, else the keyless players_wl view (1 request). */
async function nameIndex(
  ctx: ToolContext,
  season: number,
  inputs: InputStamp[],
  warnings: string[],
  allowStale = false,
): Promise<IndexEntry[]> {
  const ds = ctx.services.playerUniverse.all(season);
  if (ds.stamp !== null && ds.rows.length > 0) {
    const input = datasetInput(ds.stamp, ctx.nowMs, allowStale);
    if (input !== null) inputs.push(input);
    return ds.rows.map((r) => ({
      id: r.espn_id,
      tokens: foldTokens(r.full_name),
      position: positionNameOf(r.position_id) ?? `POS_${String(r.position_id)}`,
      percent_owned: r.percent_owned ?? 0,
      identity: r,
      player: null,
    }));
  }
  const got = await withinBudget(
    () => ctx.services.espn.getSeasonPlayers(season, readOpts(ctx)),
    warnings,
  );
  if (got === null) return [];
  const players = take(ctx, got, inputs);
  return players.map((p) => ({
    id: p.ref.id,
    tokens: foldTokens(p.name),
    position: p.position,
    percent_owned: p.ownership?.percent_owned ?? 0,
    identity: null,
    player: p,
  }));
}

/** An identity-only C1 row (no league status: kona_player_info unavailable). */
function identityRow(ctx: ToolContext, e: IndexEntry): PlayerSearchRow {
  if (e.player !== null)
    return { ...searchRow(ctx, e.player, null), status: null, on_team_id: null };
  const i = e.identity;
  if (i === null) throw new EffError("INTERNAL");
  const xw = crosswalkOf(ctx, i.espn_id, i.position_id);
  return {
    player_id: i.espn_id,
    gsis_id: xw.gsis_id,
    name: bareUntrusted(i.full_name, "player_name"),
    position: e.position,
    eligible_slots: [],
    pro_team: i.pro_team,
    jersey: jerseyOf(i.jersey),
    status: null,
    on_team_id: null,
    on_team_name: null,
    waiver_process_date: null,
    injury_status: null,
    droppable: null,
    ownership:
      i.percent_owned === null
        ? null
        : {
            percent_owned: i.percent_owned,
            percent_started: null,
            percent_change: null,
            competition_signal: true,
          },
    projection_week_espn: null,
    projection_ros_espn: null,
    last_news_at: null,
    has_outlook: false,
    crosswalk: xw.crosswalk,
  };
}

// --- C1 espn_search_players ------------------------------------------------------------------------

/** C1 data (plan 07 C1; PlayerSearchData). */
export const playerSearchSchema = z.strictObject({
  players: z.array(playerSearchRow).max(BOUNDS.searchLimit.max),
});

/** C1 `espn_search_players`. */
export const searchPlayers = defineTool({
  name: "espn_search_players",
  description:
    "Resolve a player name to a player_id with league status, injury, ownership, ESPN projections (labelled) and crosswalk state.",
  input: z.strictObject({
    query: searchQuerySchema,
    position: positionSchema.optional(),
    limit: z
      .number()
      .int()
      .min(BOUNDS.searchLimit.min)
      .max(BOUNDS.searchLimit.max)
      .default(BOUNDS.searchLimit.default),
  }),
  data: playerSearchSchema,
  budget: "list",
  run: async (args, ctx) => {
    const inputs: InputStamp[] = [];
    const warnings: string[] = [];
    const season = ctx.services.league.season;
    const q = foldTokens(args.query);
    if (q.length === 0)
      throw new EffError("VALIDATION", { field: "query", reason: "no_name_tokens" });
    const index = await nameIndex(ctx, season, inputs, warnings);
    if (index.length === 0)
      throw new EffError("STALE_ONLY", {
        hint: "That dataset was never loaded: run eff refresh in a terminal, then retry.",
      });
    const pos = args.position?.toUpperCase() ?? null;
    const hits = index
      .map((e) => ({ e, rank: nameMatchRank(e.tokens, q) }))
      .filter((h) => h.rank > 0 && (pos === null || h.e.position.toUpperCase() === pos))
      .sort((a, b) => b.rank - a.rank || b.e.percent_owned - a.e.percent_owned || a.e.id - b.e.id)
      .slice(0, args.limit)
      .map((h) => h.e);
    if (hits.length === 0)
      return { data: { players: [] } satisfies PlayerSearchData, inputs, warnings };
    let rows: PlayerSearchRow[];
    try {
      const league = await leagueOf(ctx, inputs);
      const w = weekOf(league, undefined);
      const got = await ctx.services.platform.getPlayers(
        leagueRef(ctx),
        hits.map((h) => ({ platform: "espn" as const, id: h.id })),
        w,
        readOpts(ctx),
      );
      const found = new Map(take(ctx, got, inputs).map((p) => [p.ref.id, p]));
      const names = await teamNames(ctx, inputs, warnings);
      rows = hits.map((h) => {
        const p = found.get(h.id);
        if (p === undefined) return identityRow(ctx, h);
        return searchRow(ctx, p, p.on_team_id === null ? null : (names.get(p.on_team_id) ?? null));
      });
    } catch (e) {
      if (!isDegradable(e)) throw e;
      warnings.push("espn:kona_player_info unavailable: identity only (status null)");
      rows = hits.map((h) => identityRow(ctx, h));
    }
    return {
      data: { players: rows } satisfies PlayerSearchData,
      inputs,
      warnings,
      listKey: "players",
    };
  },
});

// --- C2 espn_list_players --------------------------------------------------------------------------

/** C2 data (plan 07 C2; PlayerListData). */
export const playerListSchema = z.strictObject({
  players: z
    .array(
      playerSearchRow.extend({
        bye_week: week.nullable(),
        next_opponent: z
          .string()
          .regex(/^@?[A-Z]{2,4}$/)
          .nullable(),
        next_kickoff: isoNull,
        rank_week_espn: z.number().int().min(0).nullable(),
      }),
    )
    .max(BOUNDS.limit.max),
});

/** The C2 row: C1's fields plus bye, next opponent (`@KC` away) and kickoff from the schedule. */
export function listRow(
  ctx: ToolContext,
  p: PlatformPlayer,
  schedule: ProSchedule | null,
  w: number,
  onTeamName: PlayerSearchRow["on_team_name"],
): PlayerListRow {
  let next: string | null = null;
  let kickoff: string | null = null;
  if (schedule !== null && p.pro_team_id > 0) {
    const g = teamGame(gamesOfWeek(schedule, w), p.pro_team_id);
    if (g !== null) {
      const opp = proTeamAbbrev(schedule.teams, opponentOf(g, p.pro_team_id));
      next = opp === null ? null : `${g.home_pro_team_id === p.pro_team_id ? "" : "@"}${opp}`;
      kickoff = kickoffOf(g);
    }
  }
  return {
    ...searchRow(ctx, p, onTeamName),
    bye_week: p.bye_week,
    next_opponent: next,
    next_kickoff: kickoff,
    rank_week_espn: p.rank_week_espn,
  };
}

/** Every slot name and eligible position the league knows (C2 `position` validation). */
export function leaguePositions(slots: {
  readonly slots: readonly { name: string; eligible_positions: readonly string[] }[];
}): Set<string> {
  const out = new Set<string>();
  for (const s of slots.slots) {
    out.add(s.name);
    for (const e of s.eligible_positions) out.add(e);
  }
  return out;
}

/** C2 `espn_list_players`. */
export const listPlayers = defineTool({
  name: "espn_list_players",
  description:
    "Browse the player pool by status and position with ownership, ESPN projections (labelled) and injuries; sort percChanged = trending.",
  input: z
    .strictObject({
      status: playerStatusSchema.default("AVAILABLE"),
      position: positionSchema.optional(),
      sort: playerSortSchema.default("percOwned"),
      week: weekSchema.optional(),
      injured: z.boolean().optional(),
      ...pageInputShape,
      ...espnFreshnessShape,
      ...detailShape,
    })
    .refine((a) => sortOffsetAllowed(a.sort, a.offset), {
      message: NAME_SORT_OFFSET_REASON,
      path: ["offset"],
    }),
  data: playerListSchema,
  budget: "list",
  pageable: true,
  run: async (args, ctx) => {
    const inputs: InputStamp[] = [];
    const warnings: string[] = [];
    const league = await leagueOf(ctx, inputs, args);
    const w = weekOf(league, args.week);
    if (args.position !== undefined) {
      const slots = await slotsOf(ctx, inputs);
      if (!leaguePositions(slots).has(args.position))
        throw new EffError("VALIDATION", { field: "position", reason: "unknown_position" });
    }
    const status: PlayerStatusFilter = args.status;
    let players: readonly PlatformPlayer[];
    let page: {
      limit: number;
      offset: number;
      count: number;
      total: number | null;
      has_more: boolean;
      next_offset: number | null;
    };
    let fromSnapshot = false;
    try {
      const got = await ctx.services.platform.listPlayers(
        leagueRef(ctx),
        {
          status,
          position: args.position ?? null,
          sort: args.sort,
          week: w,
          injured: args.injured ?? null,
        },
        { limit: args.limit, offset: args.offset },
        readOpts(ctx, args),
      );
      const v = take(ctx, got, inputs);
      players = v.items;
      page = {
        limit: v.limit,
        offset: v.offset,
        count: v.count,
        total: v.total,
        has_more: v.has_more,
        next_offset: v.next_offset,
      };
    } catch (e) {
      if (!isDegradable(e)) throw e;
      const snap = ctx.services.poolSnapshots.latestTwo()[0];
      if (snap === undefined) throw e;
      fromSnapshot = true;
      const wanted = (p: PlatformPlayer): boolean =>
        (status === "ALL" ||
          (status === "AVAILABLE"
            ? p.status === "FREEAGENT" || p.status === "WAIVERS"
            : p.status === status)) &&
        (args.position === undefined ||
          p.position === args.position ||
          p.eligible_slots.includes(args.position)) &&
        (args.injured === undefined || p.injured === args.injured);
      const all = snap.players.filter(wanted);
      players = all.slice(args.offset, args.offset + args.limit);
      page = {
        limit: args.limit,
        offset: args.offset,
        count: players.length,
        total: all.length,
        has_more: args.offset + players.length < all.length,
        next_offset:
          args.offset + players.length < all.length ? args.offset + players.length : null,
      };
      inputs.push({
        source: "store:pool_snapshot",
        as_of: snap.taken_at,
        fetched_at: snap.taken_at,
        state: "stale",
      });
      warnings.push(
        "espn:kona_player_info unavailable: served from last night's pool snapshot (stale)",
      );
    }
    if (args.sort === "name") warnings.push(PLAYER_LIST_WARNINGS.name_sort_page_only);
    if (args.injured !== undefined && !fromSnapshot)
      warnings.push(PLAYER_LIST_WARNINGS.injured_post_filter);
    const sched = await withinBudget(
      () => scheduleOf(ctx, league.ref.season, inputs),
      warnings,
    ).catch(() => null);
    const names = players.some((p) => p.on_team_id !== null)
      ? await teamNames(ctx, inputs, warnings)
      : new Map<number, UntrustedText>();
    const rows = players.map((p) =>
      listRow(
        ctx,
        p,
        sched?.schedule ?? null,
        w,
        p.on_team_id === null ? null : (names.get(p.on_team_id) ?? null),
      ),
    );
    const data: PlayerListData = { players: rows };
    return { data, inputs, warnings, page, listKey: "players", partial: fromSnapshot, week: w };
  },
});
