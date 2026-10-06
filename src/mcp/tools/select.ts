// select.ts — the PlayerSelector resolver (plan 07 legend: exactly one of ≤ 25 player ids, ≤ 25
// gsis ids, a fantasy team, an NFL team, or a pool page — the sanctioned way past 25 players, T-11)
// shared by D2 and E1. Ids are read with kona_player_info + filterIds (one request); a team is the
// week's mRoster (one request, every team); an NFL team is the local player index filtered by team
// (top 25 by ownership; the keyless players_wl view once while the index was never loaded) then one
// filterIds request; a pool is one sorted kona page.
import type { PlatformPlayer, Roster, Week } from "../../domain/league/types.js";
import type { PlayerSelector } from "../bounds.js";
import { BOUNDS } from "../bounds.js";
import type { InputStamp } from "../envelope.js";
import { EffError } from "../errors.js";
import type { ToolContext } from "../define.js";
import { leagueRef, readOpts, take, withinBudget } from "./common.js";
import { rostersOf } from "./roster.js";

/** What a selector resolved to. */
export interface Selection {
  readonly players: readonly PlatformPlayer[];
  /** Set when the selector named a fantasy team (its roster, for slot-aware tools). */
  readonly roster: Roster | null;
  /** Requested ids that resolved to nothing (counted in a warning, never echoed). */
  readonly missing: number;
}

/** ESPN ids of gsis ids through the persisted crosswalk (unknown ones counted). */
function espnIdsOfGsis(
  ctx: ToolContext,
  gsis: readonly string[],
): { ids: number[]; missing: number } {
  const ids: number[] = [];
  let missing = 0;
  for (const g of gsis) {
    const pair = ctx.services.crosswalk.byGsis(g)[0];
    if (pair === undefined) missing++;
    else if (!ids.includes(pair.espn_id)) ids.push(pair.espn_id);
  }
  return { ids, missing };
}

async function byIds(
  ctx: ToolContext,
  ids: readonly number[],
  w: Week,
  inputs: InputStamp[],
): Promise<PlatformPlayer[]> {
  if (ids.length === 0) return [];
  const got = await ctx.services.platform.getPlayers(
    leagueRef(ctx),
    ids.map((id) => ({ platform: "espn" as const, id })),
    w,
    readOpts(ctx),
  );
  const found = new Map(take(ctx, got, inputs).map((p) => [p.ref.id, p]));
  return ids.map((id) => found.get(id)).filter((p): p is PlatformPlayer => p !== undefined);
}

/** One player of the season's index, as the selectors and the cascade read it. */
export interface UniverseRow {
  readonly espn_id: number;
  readonly position_id: number;
  readonly pro_team_id: number;
  readonly pro_team: string | null;
  readonly percent_owned: number | null;
}

/**
 * The season's player index: the `espn:players` dataset (C1's local index), else — before the first
 * `eff refresh espn:players`, or in fixture mode — the keyless `players_wl` view once (plan 01 §5.5,
 * under this call's budget). Past the budget: STALE_ONLY with the refresh hint.
 */
export async function universeOf(
  ctx: ToolContext,
  season: number,
  inputs: InputStamp[],
  warnings: string[],
): Promise<readonly UniverseRow[]> {
  const ds = ctx.services.playerUniverse.all(season);
  if (ds.stamp !== null) return ds.rows;
  const got = await withinBudget(
    () => ctx.services.espn.getSeasonPlayers(season, readOpts(ctx)),
    warnings,
  );
  if (got === null)
    throw new EffError("STALE_ONLY", {
      hint: "That dataset was never loaded: run eff refresh in a terminal, then retry.",
    });
  return take(ctx, got, inputs).map((p) => ({
    espn_id: p.ref.id,
    position_id: p.position_id,
    pro_team_id: p.pro_team_id,
    pro_team: p.pro_team,
    percent_owned: p.ownership?.percent_owned ?? null,
  }));
}

/** ESPN ids of an NFL team's players from the player index, by ownership. */
async function nflTeamIds(
  ctx: ToolContext,
  season: number,
  espnAbbrev: string,
  inputs: InputStamp[],
  warnings: string[],
): Promise<number[]> {
  const rows = await universeOf(ctx, season, inputs, warnings);
  return rows
    .filter((r) => r.pro_team === espnAbbrev && r.espn_id > 0)
    .sort((a, b) => (b.percent_owned ?? 0) - (a.percent_owned ?? 0) || a.espn_id - b.espn_id)
    .slice(0, BOUNDS.playerIds.max)
    .map((r) => r.espn_id);
}

/** Resolves a PlayerSelector (default: my roster when `selector` is undefined and `myTeam` set). */
export async function selectPlayers(
  ctx: ToolContext,
  selector: PlayerSelector | undefined,
  myTeam: number | null,
  w: Week,
  inputs: InputStamp[],
  warnings: string[],
): Promise<Selection> {
  if (selector === undefined || "team_id" in selector) {
    const team = selector === undefined ? myTeam : selector.team_id;
    if (team === null)
      throw new EffError("VALIDATION", {
        field: "players",
        reason: "my_team_unresolved",
        hint: "Pass team_id, or run eff setup in a terminal so your team is recorded.",
      });
    const rosters = await rostersOf(ctx, w, inputs, warnings, {}, team);
    const roster = rosters.find((r) => r.team.team_id === team);
    if (roster === undefined) throw new EffError("NOT_FOUND");
    return { players: roster.entries.map((e) => e.player), roster, missing: 0 };
  }
  if ("player_ids" in selector) {
    const players = await byIds(ctx, selector.player_ids, w, inputs);
    return { players, roster: null, missing: selector.player_ids.length - players.length };
  }
  if ("gsis_ids" in selector) {
    const { ids, missing } = espnIdsOfGsis(ctx, selector.gsis_ids);
    const players = await byIds(ctx, ids, w, inputs);
    return { players, roster: null, missing: missing + ids.length - players.length };
  }
  if ("nfl_team" in selector) {
    const ids = await nflTeamIds(
      ctx,
      ctx.services.league.season,
      selector.nfl_team,
      inputs,
      warnings,
    );
    const players = await byIds(ctx, ids, w, inputs);
    return { players, roster: null, missing: 0 };
  }
  const pool = selector.pool;
  const got = await ctx.services.platform.listPlayers(
    leagueRef(ctx),
    { status: pool.status, position: pool.position, sort: "percOwned", week: w, injured: null },
    { limit: pool.top, offset: 0 },
    readOpts(ctx),
  );
  return { players: take(ctx, got, inputs).items, roster: null, missing: 0 };
}
