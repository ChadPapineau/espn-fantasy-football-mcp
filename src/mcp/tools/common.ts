// common.ts — what the plan 07 §2 conventions need in every tool: the configured league ref (never
// a tool argument — plan 02 §5), read options carrying the per-call budget (plan 01 §5.6), stamps →
// envelope inputs through the ONE conversion (stampToInput), dataset reads with STALE_ONLY past a
// hard limit unless `allow_stale` and the never-loaded answer (plan 01 §5.4), the week / my-team
// defaults (plan 07 §2), the pro schedule (dataset first, the keyless view only when the store is
// empty — plan 01 §5.5), the crosswalk state behind every gsis id (plan 07 C1), and the partial
// rule for a 4th request (plan 01 §5.6). Ported from sibling @5daa625, adapted to the ESPN seam.
import { freshnessClass } from "../../config/freshness.js";
import type { DatasetResult, DatasetStamp } from "../../domain/analytics/types.js";
import {
  crosswalkStatusOfPair,
  identityOfPlatformPlayer,
  isTeamUnitIdentity,
} from "../../domain/crosswalk/resolver.js";
import type {
  CrosswalkStatus,
  League,
  LeagueRef,
  LeagueRules,
  OwnershipRow,
  PlatformPlayer,
  PlatformStamp,
  PlayerSearchRow,
  ProGame,
  ProSchedule,
  ProTeam,
  RosterSlots,
  Stamped,
  Week,
} from "../../domain/league/types.js";
import type { ScoringSettings } from "../../domain/scoring/types.js";
import {
  isUpstreamBudgetExhausted,
  partialWarning,
  type ReadOptions,
} from "../../providers/platform.js";
import { BOUNDS } from "../bounds.js";
import { stampToInput, type InputStamp } from "../envelope.js";
import { EffError, SERVER_HINTS } from "../errors.js";
import type { ToolContext } from "../define.js";

/** The configured league for a season (default: the configured season). */
export function leagueRef(ctx: ToolContext, season?: number): LeagueRef {
  const ref = ctx.services.league;
  return season === undefined || season === ref.season ? ref : { ...ref, season };
}

/** The freshness flags of a call (plan 07 §2 common inputs). */
export interface FreshnessArgs {
  readonly force_refresh?: boolean | undefined;
  readonly allow_stale?: boolean | undefined;
}

/** Read options for a platform read: `force_refresh`/`allow_stale` plus this call's budget. */
export function readOpts(ctx: ToolContext, args: FreshnessArgs = {}): ReadOptions {
  return {
    ...(args.force_refresh === true ? { force_refresh: true } : {}),
    ...(args.allow_stale === true ? { allow_stale: true } : {}),
    budget: ctx.budget,
  };
}

/** A stamped platform read → its value, pushing its input onto `inputs` (the provider judged the age). */
export function take<T>(ctx: ToolContext, s: Stamped<T>, inputs: InputStamp[]): T {
  inputs.push(stampToInput(s.stamp, ctx.nowMs));
  return s.value;
}

/** A platform stamp as an input (for a read whose value is consumed elsewhere). */
export function platformInput(ctx: ToolContext, stamp: PlatformStamp): InputStamp {
  return stampToInput(stamp, ctx.nowMs);
}

/**
 * A dataset stamp as an envelope input — STALE_ONLY past its class's hard limit unless
 * `allow_stale`; an `omit`-class input past it is dropped (null) and named by the caller.
 */
export function datasetInput(
  stamp: DatasetStamp,
  nowMs: number,
  allowStale: boolean,
): InputStamp | null {
  const input = stampToInput(stamp, nowMs);
  if (input.state === "expired" && !allowStale) {
    if (freshnessClass(stamp.freshness_class).beyondHard === "omit") return null;
    throw new EffError("STALE_ONLY");
  }
  return input;
}

/** A REQUIRED dataset read: never loaded → STALE_ONLY with the "run eff refresh" hint. */
export function requiredDataset<T>(
  r: DatasetResult<T>,
  nowMs: number,
  allowStale: boolean,
): InputStamp | null {
  if (r.stamp === null) throw new EffError("STALE_ONLY", { hint: SERVER_HINTS.datasetNeverLoaded });
  return datasetInput(r.stamp, nowMs, allowStale);
}

/** An OPTIONAL dataset read (injuries, lines, weather): null input when never loaded or omitted. */
export function optionalDataset<T>(
  r: DatasetResult<T>,
  nowMs: number,
  allowStale: boolean,
): InputStamp | null {
  if (r.stamp === null) return null;
  try {
    return datasetInput(r.stamp, nowMs, allowStale);
  } catch {
    return null;
  }
}

/** Drops nulls. */
export function present<T>(xs: readonly (T | null | undefined)[]): T[] {
  return xs.filter((x): x is T => x !== null && x !== undefined);
}

function memo<T>(ctx: ToolContext, key: string, make: () => Promise<T>): Promise<T> {
  const hit = ctx.memo.get(key) as Promise<T> | undefined;
  if (hit !== undefined) return hit;
  const p = make();
  ctx.memo.set(key, p);
  return p;
}

/** The league (identity, clock, my team) read once per call. */
export function leagueOf(
  ctx: ToolContext,
  inputs: InputStamp[],
  args: FreshnessArgs = {},
): Promise<League> {
  return memo(ctx, "league", async () => {
    const got = await ctx.services.platform.getLeague(leagueRef(ctx), readOpts(ctx, args));
    inputs.push(platformInput(ctx, got.stamp));
    return got.value;
  });
}

/** The league's scoring settings, refused while mSettings is drifted (plan 01 §7, T-14). */
export function settingsOf(ctx: ToolContext, inputs: InputStamp[]): Promise<ScoringSettings> {
  return memo(ctx, "settings", async () => {
    const got = await ctx.services.platform.getScoringSettings(leagueRef(ctx), readOpts(ctx));
    inputs.push(platformInput(ctx, got.stamp));
    return got.value;
  });
}

/** The roster slots read once per call. */
export function slotsOf(ctx: ToolContext, inputs: InputStamp[]): Promise<RosterSlots> {
  return memo(ctx, "slots", async () => {
    const got = await ctx.services.platform.getRosterSlots(leagueRef(ctx), readOpts(ctx));
    inputs.push(platformInput(ctx, got.stamp));
    return got.value;
  });
}

/** The league rules read once per call. */
export function rulesOf(ctx: ToolContext, inputs: InputStamp[]): Promise<LeagueRules> {
  return memo(ctx, "rules", async () => {
    const got = await ctx.services.platform.getLeagueRules(leagueRef(ctx), readOpts(ctx));
    inputs.push(platformInput(ctx, got.stamp));
    return got.value;
  });
}

/**
 * The week a call means (plan 07 §2): the argument, else the league's current scoring period,
 * clamped into a tool's 1..18 (a preseason period 0 reads as week 1; a kicker-only 19–22 as 18).
 */
export function weekOf(league: League, week: number | undefined): Week {
  if (week !== undefined) return week;
  const cur = league.clock.current_scoring_period;
  return Math.min(BOUNDS.week.max, Math.max(BOUNDS.week.min, cur));
}

/** The team a call means: the argument, else my team — or VALIDATION with the setup hint. */
export function teamOf(league: League, teamId: number | undefined): number {
  if (teamId !== undefined) return teamId;
  const mine = league.my_team?.team_id ?? null;
  if (mine === null)
    throw new EffError("VALIDATION", {
      field: "team_id",
      reason: "my_team_unresolved",
      hint: SERVER_HINTS.myTeamUnresolved,
    });
  return mine;
}

/** The season's pro schedule with its input: the dataset, else the keyless view (1 request). */
export interface ScheduleRead {
  readonly schedule: ProSchedule;
  readonly input: InputStamp | null;
  readonly from: "dataset" | "espn";
}

/**
 * The pro schedule (plan 01 §5.5): `ds_pro_schedule` first; when the dataset was never loaded, the
 * keyless `proTeamSchedules_wl` view once (under the limiter and this call's budget). A stale
 * dataset is served with its age; past its hard limit STALE_ONLY unless `allow_stale`.
 */
export function scheduleOf(
  ctx: ToolContext,
  season: number,
  inputs: InputStamp[],
  allowStale = false,
): Promise<ScheduleRead> {
  return memo(ctx, `schedule:${String(season)}`, async () => {
    const games = ctx.services.datasets.proSchedule.games(season, null);
    if (games.stamp !== null && games.rows.length > 0) {
      const teams = ctx.services.datasets.proSchedule.teams(season);
      const input = datasetInput(games.stamp, ctx.nowMs, allowStale);
      if (input !== null) inputs.push(input);
      return {
        schedule: { season, games: games.rows, teams: teams.rows },
        input,
        from: "dataset" as const,
      };
    }
    const got = await ctx.services.platform.getProSchedule(
      season,
      readOpts(ctx, { allow_stale: allowStale }),
    );
    const input = platformInput(ctx, got.stamp);
    inputs.push(input);
    return { schedule: got.value, input, from: "espn" as const };
  });
}

/** Games of one week. */
export function weekGames(schedule: Pick<ProSchedule, "games">, week: Week): ProGame[] {
  return schedule.games.filter((g) => g.week === week);
}

/** The pro-team abbreviation by id (`teams[]`), or null. */
export function proTeamAbbrev(teams: readonly ProTeam[], id: number | null): string | null {
  if (id === null) return null;
  return teams.find((t) => t.id === id)?.abbrev ?? null;
}

/** The crosswalk state and gsis id of one ESPN player (the tool-time path: a persisted pair). */
export function crosswalkOf(
  ctx: ToolContext,
  espnId: number,
  positionId: number,
): { readonly gsis_id: string | null; readonly crosswalk: CrosswalkStatus } {
  const identity = { espn_id: espnId, position_id: positionId };
  if (isTeamUnitIdentity(identity))
    return { gsis_id: null, crosswalk: crosswalkStatusOfPair(identity, null) };
  let pair = null;
  try {
    pair = ctx.services.crosswalk.get(espnId);
  } catch {
    pair = null;
  }
  return {
    gsis_id: pair?.espn_id === espnId ? pair.gsis_id : null,
    crosswalk: crosswalkStatusOfPair(identity, pair),
  };
}

/** Re-exported for tools that need the full identity (team-unit checks on a PlatformPlayer). */
export { identityOfPlatformPlayer };

/** A row's ownership block (the competition signal flag is always true — plan 07 E5). */
export function ownershipRow(p: Pick<PlatformPlayer, "ownership">): OwnershipRow | null {
  const o = p.ownership;
  if (o === null) return null;
  return {
    percent_owned: o.percent_owned,
    percent_started: o.percent_started,
    percent_change: o.percent_change,
    competition_signal: true,
  };
}

/** A jersey as rows show it (digits only, else null). */
export function jerseyOf(j: string | null): string | null {
  return j !== null && /^[0-9]{1,3}$/.test(j) ? j : null;
}

/** The C1 row of a PlatformPlayer (plan 07 C1); `onTeamName` from the league's team names. */
export function searchRow(
  ctx: ToolContext,
  p: PlatformPlayer,
  onTeamName: PlayerSearchRow["on_team_name"],
): PlayerSearchRow {
  const xw = crosswalkOf(ctx, p.ref.id, p.position_id);
  return {
    player_id: p.ref.id,
    gsis_id: xw.gsis_id,
    name: p.name,
    position: p.position,
    eligible_slots: p.eligible_slots,
    pro_team: p.pro_team,
    jersey: jerseyOf(p.jersey),
    status: p.status,
    on_team_id: p.on_team_id,
    on_team_name: onTeamName,
    waiver_process_date: p.waiver_process_date,
    injury_status: p.injury_status,
    droppable: p.droppable,
    ownership: ownershipRow(p),
    projection_week_espn: p.projection_week_espn,
    projection_ros_espn: p.projection_ros_espn,
    last_news_at: p.last_news_at,
    has_outlook: p.has_outlook,
    crosswalk: xw.crosswalk,
  };
}

/**
 * Runs an upstream read that may exceed this call's budget (plan 01 §5.6): on the budget signal it
 * returns null and adds the fixed partial warning; every other error propagates.
 */
export async function withinBudget<T>(
  read: () => Promise<T>,
  warnings: string[],
): Promise<T | null> {
  try {
    return await read();
  } catch (e) {
    if (isUpstreamBudgetExhausted(e)) {
      const w = partialWarning(e.missing);
      if (!warnings.includes(w)) warnings.push(w);
      return null;
    }
    throw e;
  }
}

/** Whether an error is one a degradation path may absorb (drift or an upstream outage — plan 01 §7). */
export function isDegradable(e: unknown): boolean {
  const code = (e as { effCode?: unknown } | null)?.effCode;
  return (
    code === "ESPN_DRIFT_DETECTED" ||
    code === "ESPN_UPSTREAM_UNAVAILABLE" ||
    code === "ESPN_HOST_MOVED" ||
    code === "RATE_LIMITED"
  );
}

/** A fixed degradation warning naming the view (never upstream text). */
export function degradedViewWarning(view: string, what: string): string {
  return `espn:${view} unavailable: ${what}`;
}

/**
 * Whether an error may be absorbed by an OPTIONAL ESPN read — a comparator or a labelled extra the
 * result can honestly go without (D5's positional rating, B2's playercard beside its nflverse
 * fallback): a degradable outage, a cookie state the read cannot satisfy, or a view the fixture
 * league does not carry (fixture mode's `fixture_missing`). Anything else — a bug — propagates.
 */
export function isOptionalReadFailure(e: unknown): boolean {
  if (isDegradable(e)) return true;
  const code = (e as { effCode?: unknown } | null)?.effCode;
  if (code === "ESPN_AUTH_REJECTED" || code === "ESPN_REQUIRES_COOKIES") return true;
  const reason = (e as { effDetails?: { reason?: unknown } } | null)?.effDetails?.reason;
  return (e as { name?: unknown } | null)?.name === "FixtureError" && reason === "fixture_missing";
}
