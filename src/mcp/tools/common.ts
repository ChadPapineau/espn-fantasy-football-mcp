// common.ts — what the plan 07 §2 conventions need in every tool: the configured league ref (never
// a tool argument — plan 02 §5), read options carrying the per-call budget (plan 01 §5.6), stamps →
// envelope inputs through the ONE conversion (stampToInput), dataset reads with STALE_ONLY past a
// hard limit unless `allow_stale` and the never-loaded answer (plan 01 §5.4), the week / my-team
// defaults (plan 07 §2), the pro schedule (dataset first, the keyless view only when the store is
// empty — plan 01 §5.5), the crosswalk state behind every gsis id (plan 07 C1), and the partial
// rule for a 4th request (plan 01 §5.6). Ported from sibling @5daa625, adapted to the ESPN seam.
import {
  DEFAULT_TTL_CONTEXT,
  easternDate,
  freshnessClass,
  serveDecision,
  stampState,
  ttlContextAt,
  type FreshnessClassId,
  type TtlContext,
} from "../../config/freshness.js";
import type { DatasetResult, DatasetStamp, NewsItem } from "../../domain/analytics/types.js";
import { yieldTurn } from "../../domain/analytics/cooperative.js";
import { ESPN_ROS, LIMITS, NFL_REGULAR_SEASON } from "../../domain/analytics/constants.js";
import {
  espnRosLastWeek,
  rosGamesOf,
  rosWeeksOf,
  rosWindow,
  type RosWeek,
} from "../../domain/analytics/projection.js";
import type { WeeklyValuesOpts } from "../../domain/analytics/waivers.js";
import {
  crosswalkStatusOfPair,
  identityOfPlatformPlayer,
  isTeamUnitIdentity,
} from "../../domain/crosswalk/resolver.js";
import { LAST_SEEN_GRANULARITY_MS, type CrosswalkPair } from "../../domain/crosswalk/types.js";
import { seasonOfInstant } from "../../domain/analytics/waiver-fit/history.js";
import {
  TRANSACTIONS_RANGE_MAX,
  type CrosswalkStatus,
  type IsoInstant,
  type League,
  type LeagueRef,
  type LeagueRules,
  type Matchup,
  type OwnershipRow,
  type PlatformPlayer,
  type PlatformStamp,
  type PlayerSearchRow,
  type ProGame,
  type ProSchedule,
  type ProTeam,
  type RosterSlots,
  type Stamped,
  type Transaction,
  type TransactionsSeenRepository,
  type Week,
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
import { asGsisId } from "./schemas.js";

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

// --- the TTL context every input is judged under (plan 01 §5.2 game-day TTLs) ------------------------

// easternDate and ttlContextAt live in the config layer, shared with the provider's TTLs and
// `eff status` (Stage C finding freshness-gameday-ttl-never-applied); re-exported for the tools
export { easternDate, ttlContextAt };

/**
 * This call's TTL context — the stored pro schedule of the configured season at the call's instant,
 * read once per call (memo). Every input a tool or resource builds is judged under it: game-day TTLs
 * (the pro schedule's 1 h, lines' and schedules' 30 min) and the in-game-window TTLs (live, 60 s)
 * apply to the label the envelope shows. Before, every stamp was judged under the default context, so
 * a schedule or lines refresh that stopped on a Sunday was labelled fresh for 6 h instead of stale
 * after 1 h / 30 min (Stage C finding freshness-gameday-ttl-never-applied). An unreadable schedule
 * is the default context (never an error).
 */
export function ttlContextOf(ctx: Pick<ToolContext, "memo" | "nowMs" | "services">): TtlContext {
  const hit = ctx.memo.get("ttl_context") as TtlContext | undefined;
  if (hit !== undefined) return hit;
  let value: TtlContext = DEFAULT_TTL_CONTEXT;
  try {
    value = ttlContextAt(
      ctx.services.datasets.proSchedule.games(ctx.services.league.season, null).rows,
      ctx.nowMs,
    );
  } catch {
    value = DEFAULT_TTL_CONTEXT;
  }
  ctx.memo.set("ttl_context", value);
  return value;
}

/** Where an input is judged: a call (its instant and TTL context), or a bare instant (default context). */
export type JudgeAt = number | Pick<ToolContext, "memo" | "nowMs" | "services">;

function judged(at: JudgeAt): { readonly nowMs: number; readonly ttl: TtlContext } {
  return typeof at === "number"
    ? { nowMs: at, ttl: DEFAULT_TTL_CONTEXT }
    : { nowMs: at.nowMs, ttl: ttlContextOf(at) };
}

/** A stamped platform read → its value, pushing its input onto `inputs` (the call's TTL context). */
export function take<T>(ctx: ToolContext, s: Stamped<T>, inputs: InputStamp[]): T {
  inputs.push(stampToInput(s.stamp, ctx.nowMs, ttlContextOf(ctx)));
  return s.value;
}

/** A platform stamp as an input (for a read whose value is consumed elsewhere). */
export function platformInput(ctx: ToolContext, stamp: PlatformStamp): InputStamp {
  return stampToInput(stamp, ctx.nowMs, ttlContextOf(ctx));
}

/**
 * A dataset stamp as an envelope input — STALE_ONLY past its class's hard limit unless
 * `allow_stale`; an `omit`-class input past it is dropped (null) and named by the caller. Judged
 * under the call's TTL context when `at` is the call (every tool passes it).
 */
export function datasetInput(
  stamp: DatasetStamp,
  at: JudgeAt,
  allowStale: boolean,
): InputStamp | null {
  const j = judged(at);
  const input = stampToInput(stamp, j.nowMs, j.ttl);
  if (input.state === "expired" && !allowStale) {
    if (freshnessClass(stamp.freshness_class).beyondHard === "omit") return null;
    throw new EffError("STALE_ONLY");
  }
  return input;
}

/** A REQUIRED dataset read: never loaded → STALE_ONLY with the "run eff refresh" hint. */
export function requiredDataset<T>(
  r: DatasetResult<T>,
  at: JudgeAt,
  allowStale: boolean,
): InputStamp | null {
  if (r.stamp === null) throw new EffError("STALE_ONLY", { hint: SERVER_HINTS.datasetNeverLoaded });
  return datasetInput(r.stamp, at, allowStale);
}

/** An OPTIONAL dataset read (injuries, lines, weather): null input when never loaded or omitted. */
export function optionalDataset<T>(
  r: DatasetResult<T>,
  at: JudgeAt,
  allowStale: boolean,
): InputStamp | null {
  if (r.stamp === null) return null;
  try {
    return datasetInput(r.stamp, at, allowStale);
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
 * The week the league's clock means: the current scoring period, or — once ESPN's clock has run past
 * the league's final scoring period (during NFL week 18 it serves scoringPeriodId 18, and 19 from
 * then to August, with finalScoringPeriod 17: every recorded finished season) — the league's LAST
 * SCORED week. A1's `current_week_final` / `corrections_window_open` describe this week (Stage C
 * finding league-offseason-clock-not-final), A1 states it as `clock.current_week`, G1 as
 * `league.current_week`, and every tool's default week is it (weekOf). An unknown final period (0)
 * never redirects.
 */
export function clockWeek(
  clock: Pick<League["clock"], "current_scoring_period" | "final_scoring_period">,
): Week {
  const cur = clock.current_scoring_period;
  const fin = clock.final_scoring_period;
  return fin >= 1 && cur > fin ? fin : cur;
}

/**
 * The week a call means (plan 07 §2): the argument, else the week the league's clock means
 * (clockWeek — the league's final scoring period once the season is over), clamped into a tool's
 * 1..18 (a preseason period 0 reads as week 1). Clamping the raw period to 18 sent every
 * default-week tool to NFL week 18 — a week the league does not play — from the day after the
 * championship to August: the retrospective reviewed week 18, E2 set a week-18 lineup, E3 `pre`
 * found no opponent (Stage C finding league-postseason-default-week-18).
 */
export function weekOf(league: League, week: number | undefined): Week {
  if (week !== undefined) return week;
  const cur = clockWeek(league.clock);
  return Math.min(BOUNDS.week.max, Math.max(BOUNDS.week.min, cur));
}

/** The matchup period of a week and the opponent of `team` in it (null on a bye or unknown). */
export function opponentIn(
  matchups: readonly Matchup[],
  period: number | null,
  team: number,
): number | null {
  if (period === null) return null;
  const m = matchups.find(
    (x) => x.matchup_period === period && (x.home.team_id === team || x.away?.team_id === team),
  );
  const away = m?.away ?? null;
  if (m === undefined || away === null) return null;
  return m.home.team_id === team ? away.team_id : m.home.team_id;
}

/** The matchup period listing `w` (lowest id). */
export function periodOf(rules: Pick<LeagueRules, "playoffs">, w: Week): number | null {
  let best: number | null = null;
  for (const [k, ws] of Object.entries(rules.playoffs.matchup_periods))
    if (ws.includes(w) && (best === null || Number(k) < best)) best = Number(k);
  return best;
}

/**
 * The points a multi-week matchup period already holds before week `w` (its earlier scoring
 * periods, ESPN's `points_by_week`) for `team` and its opponent, or null when `w` is its period's
 * first week, the period spans one week, or the matchup is unknown. A two-week round's second week
 * starts from that margin, never 0–0 (research 05 §2.3: read matchupPeriods, never assume).
 */
export function bankedPoints(
  matchups: readonly Matchup[],
  rules: Pick<LeagueRules, "playoffs">,
  w: Week,
  team: number,
): {
  readonly period: number;
  readonly weeks: readonly Week[];
  readonly me: number;
  readonly opp: number;
} | null {
  const period = periodOf(rules, w);
  if (period === null) return null;
  const span = [...(rules.playoffs.matchup_periods[String(period)] ?? [])].sort((a, b) => a - b);
  const earlier = span.filter((x) => x < w);
  if (earlier.length === 0) return null;
  const m = matchups.find(
    (x) => x.matchup_period === period && (x.home.team_id === team || x.away?.team_id === team),
  );
  const away = m?.away ?? null;
  if (m === undefined || away === null) return null;
  const mine = m.home.team_id === team ? m.home : away;
  const theirs = m.home.team_id === team ? away : m.home;
  const sum = (s: { readonly points_by_week: Readonly<Record<string, number>> }): number =>
    earlier.reduce((acc, x) => acc + (s.points_by_week[String(x)] ?? 0), 0);
  return { period, weeks: earlier, me: sum(mine), opp: sum(theirs) };
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
      const input = datasetInput(games.stamp, ctx, allowStale);
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

/**
 * How a tool reads ESPN's rest-of-season total for the engines' weekly values — E1's own window
 * (Stage C finding projection-ros-includes-week18; projection.ts `rosWindow`): which of a player's
 * games the total still counts, from the pro schedule at the call's instant, through the NFL
 * season's last week (never the league's final scoring period). Every weekly-value caller (E4–E9,
 * E11, E5) passes one, so its weeks equal E1's. null: the call has no schedule — the total is then
 * read from the first value week through week 18, the bye excluded (weeklyValues' default).
 */
export interface RosReading {
  readonly schedule: Pick<ProSchedule, "games">;
  readonly season: number;
  readonly nowMs: number;
}

/** A RosReading over `schedule` at `nowMs`, or null when there is no schedule (no games). */
export function rosReadingFrom(
  schedule: Pick<ProSchedule, "games"> | null | undefined,
  season: number,
  nowMs: number,
): RosReading | null {
  return schedule === null || schedule === undefined || schedule.games.length === 0
    ? null
    : { schedule, season, nowMs };
}

/**
 * This call's RosReading: the season's pro schedule (scheduleOf — one memoised read per call) at the
 * call's instant, or null — said once — when the call cannot read it.
 */
export async function rosReadingOf(
  ctx: ToolContext,
  season: number,
  inputs: InputStamp[],
  warnings: string[],
  allowStale: boolean,
): Promise<RosReading | null> {
  const got = await withinBudget(() => scheduleOf(ctx, season, inputs, allowStale), warnings).catch(
    (e: unknown) => {
      if (!isOptionalReadFailure(e)) throw e;
      return null;
    },
  );
  const ros = rosReadingFrom(got?.schedule ?? null, season, ctx.nowMs);
  if (ros === null) {
    const w =
      "pro schedule unavailable: ESPN's rest-of-season total read from the first value week";
    if (!warnings.includes(w)) warnings.push(w);
  }
  return ros;
}

/**
 * Per reading: the season's last week and each pro team's weeks. `rosWeeksOf` scans the season's
 * games (~5 000 game visits), so it runs once per pro team per call — never per player: per player
 * it cost a league-wide tool (E4, E9, E11) 40–60 ms of one turn (the stall bound, plan 03 §1.2).
 */
const ROS_MEMO = new WeakMap<
  RosReading,
  { readonly last: Week; readonly byTeam: Map<number, readonly RosWeek[]> }
>();

/**
 * The weeklyValues options of `p` under `ros` (null: weeklyValues' default reading) — exactly
 * waivers.ts `rosShareOptsOf` for a platform player (who carries no ESPN game count), memoised per
 * pro team.
 */
export function rosOptsOf(
  p: Pick<PlatformPlayer, "pro_team_id" | "position_id">,
  ros: RosReading | null,
): WeeklyValuesOpts {
  if (ros === null) return {};
  let memo = ROS_MEMO.get(ros);
  if (memo === undefined) {
    memo = { last: espnRosLastWeek(ros.schedule, ros.season), byTeam: new Map() };
    ROS_MEMO.set(ros, memo);
  }
  let weeks = memo.byTeam.get(p.pro_team_id);
  if (weeks === undefined) {
    weeks = rosWeeksOf(ros.schedule, p.pro_team_id, memo.last, ros.nowMs);
    memo.byTeam.set(p.pro_team_id, weeks);
  }
  return { ros_last_week: memo.last, ros_weeks: weeks, position_id: p.position_id };
}

/**
 * How many games ESPN's rest-of-season total for `p` covers, as E1 reads the total (projection.ts
 * rosWindow): ESPN's own game count (stat 210 of the split, `espnGames`) when believable; else a
 * D/ST's whole season; else his games not yet started at the clock from the week ESPN's numbers are
 * as of (`asOf`, the clock's week) through the NFL season's last week (week 18 included, byes out).
 * Without a pro schedule (`ros` null) every week from `asOf` on but his bye counts. Independent of
 * any week a caller asks about: the total does not change with it (Stage C finding
 * projections-ros-weeks-remaining-mismatch — C3 paired the total with the league's weeks from the
 * requested week, so a per-week reading was about twice the true per-game value).
 */
export function rosGamesCovered(
  p: Pick<PlatformPlayer, "pro_team_id" | "position_id" | "bye_week" | "projection_ros_espn">,
  ros: RosReading | null,
  asOf: Week,
  espnGames: number | null = null,
): number {
  const opts = rosOptsOf(p, ros);
  const last = opts.ros_last_week ?? NFL_REGULAR_SEASON.lastWeek;
  const given = new Map((opts.ros_weeks ?? []).map((x) => [x.week, x]));
  const season: RosWeek[] = [];
  for (let w = 1; w <= Math.min(LIMITS.maxWeeks, Math.max(last, asOf)); w++)
    season.push(
      given.get(w) ?? { week: w, playing: w !== p.bye_week, started: false, ahead: false },
    );
  return rosWindow(season, {
    from: asOf,
    games: rosGamesOf(espnGames, p.projection_ros_espn),
    full_season: ESPN_ROS.fullSeasonPositionIds.includes(p.position_id),
  }).covered.size;
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

// --- gsis id → ESPN id (Stage C finding crosswalk-reverse-lookup-lowest-id) -------------------------

/** What the server knows NOW about the pairs a gsis id has stored (the evidence pickGsisPair reads). */
export interface GsisEvidence {
  /** The ESPN ids of the current player universe among the candidates; null = the index is not loaded. */
  readonly universe: ReadonlySet<number> | null;
  /** The configured crosswalk overrides, ESPN id → gsis id (the owner's current assertions). */
  readonly overrides: ReadonlyMap<number, string>;
  /**
   * nflverse's newest weekly-roster row for each candidate ESPN id (null: nflverse has none for that
   * id); an id absent from the map, or a null map, was not read (the roster is not loaded).
   */
  readonly nflverse: ReadonlyMap<
    number,
    { readonly gsis_id: string; readonly season: number; readonly week: number } | null
  > | null;
}

/** pickGsisPair's verdict. */
export type GsisPick =
  /** No live pair (none stored, a removed override, every pair contradicted by nflverse). */
  | { readonly kind: "none" }
  /**
   * One pair: `established` when the evidence settles it (the only live pair, a configured override,
   * nflverse's newest row, the only one in the player universe); otherwise the most recently paired
   * one — a guess the caller must say.
   */
  | { readonly kind: "one"; readonly pair: CrosswalkPair; readonly established: boolean }
  /** Two or more pairs that nothing tells apart: none is used. */
  | { readonly kind: "tie"; readonly candidates: readonly number[] };

const msOf = (iso: string): number => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
};
const confidentPair = (p: CrosswalkPair): boolean => p.method !== "match" && p.confidence >= 1;
const idsOf = (ps: readonly CrosswalkPair[]): number[] =>
  ps.map((p) => p.espn_id).sort((a, b) => a - b);

/**
 * The one CURRENT pair among a gsis id's stored pairs, decided by evidence, never by id order. Stored
 * pairs never expire, and legitimate states keep two or more ESPN ids on one gsis id — an ESPN
 * re-key keeps the old id's pair, nflverse corrects a wrong id, the owner removes an override — and
 * `last_seen` moves only at a 7-day grain, so recency alone cannot tell them apart. In order:
 * (1) an override pair the config no longer carries pairs nothing (the owner removed it); (2) a
 * configured override wins; (3) nflverse's newest roster row of each candidate ESPN id confirms the
 * pair (the newest row wins) or contradicts it (that ESPN id is another player now: dropped); (4) the
 * only candidate in the current player universe; (5) else a confident pair over a name match, or
 * the pair the rebuilds saw a full last-seen grain after the others (both evidence); within one grain
 * the later pairing (a re-key or a correction ADDS the newer pair) is a guess, not established — said
 * by the caller — and the same pairing is a true tie that picks none. Before, `byGsis(g)[0]` — the
 * LOWEST ESPN id — read the dead or a different player, and the attempt-1 tie rule (an override
 * first, then the lowest id) still did (Stage C finding crosswalk-reverse-lookup-lowest-id).
 */
export function pickGsisPair(
  gsis: string,
  pairs: readonly CrosswalkPair[],
  ev: GsisEvidence,
): GsisPick {
  const live = pairs.filter(
    (p) => p.gsis_id === gsis && (p.method !== "override" || ev.overrides.get(p.espn_id) === gsis),
  );
  const only = live[0];
  if (only === undefined) return { kind: "none" };
  if (live.length === 1) return { kind: "one", pair: only, established: true };
  const configured = live.filter((p) => p.method === "override");
  const cfg = configured[0];
  if (cfg !== undefined)
    return configured.length === 1
      ? { kind: "one", pair: cfg, established: true }
      : { kind: "tie", candidates: idsOf(configured) };
  const confirmed: { pair: CrosswalkPair; at: number }[] = [];
  const unknown: CrosswalkPair[] = [];
  for (const p of live) {
    const row = ev.nflverse?.get(p.espn_id);
    if (row === undefined || row === null) unknown.push(p);
    else if (row.gsis_id === gsis) confirmed.push({ pair: p, at: row.season * 100 + row.week });
    // else: nflverse pairs that ESPN id with another player now — this pair is stale
  }
  if (confirmed.length > 0) {
    const newest = Math.max(...confirmed.map((c) => c.at));
    const top = confirmed.filter((c) => c.at === newest).map((c) => c.pair);
    const lead = top[0];
    return top.length === 1 && lead !== undefined
      ? { kind: "one", pair: lead, established: true }
      : { kind: "tie", candidates: idsOf(top) };
  }
  if (unknown.length === 0) return { kind: "none" };
  const universe = ev.universe;
  const inUniverse = universe === null ? [] : unknown.filter((p) => universe.has(p.espn_id));
  const sole = inUniverse[0];
  if (inUniverse.length === 1 && sole !== undefined)
    return { kind: "one", pair: sole, established: true };
  const pool = inUniverse.length > 0 ? inUniverse : unknown;
  // what the rebuilds still assert: a confident pair over a name match, then the pair they last saw
  // (a rebuild touches every pair it sees, at the last-seen grain), then the later pairing (a re-key
  // or a correction ADDS the newer pair) — only the first two are evidence
  const sorted = [...pool].sort(
    (a, b) =>
      Number(confidentPair(b)) - Number(confidentPair(a)) ||
      msOf(b.last_seen) - msOf(a.last_seen) ||
      msOf(b.first_seen) - msOf(a.first_seen),
  );
  const lead = sorted[0];
  const next = sorted[1];
  if (lead === undefined) return { kind: "none" };
  if (next === undefined) return { kind: "one", pair: lead, established: true };
  if (
    confidentPair(lead) !== confidentPair(next) ||
    msOf(lead.last_seen) - msOf(next.last_seen) >= LAST_SEEN_GRANULARITY_MS
  )
    return { kind: "one", pair: lead, established: true };
  // within one last-seen grain: the later pairing is a guess (said); the same pairing a true tie
  const recent = sorted.filter(
    (p) =>
      confidentPair(p) === confidentPair(lead) &&
      msOf(lead.last_seen) - msOf(p.last_seen) < LAST_SEEN_GRANULARITY_MS,
  );
  const newest = Math.max(...recent.map((p) => msOf(p.first_seen)));
  const latest = recent.filter((p) => msOf(p.first_seen) === newest);
  const pick = latest[0];
  return latest.length === 1 && pick !== undefined
    ? { kind: "one", pair: pick, established: false }
    : { kind: "tie", candidates: idsOf(latest) };
}

/** What a gsis id resolves to: the ESPN id (or null) and the sentence a caller must say, if any. */
export interface GsisResolution {
  readonly espn_id: number | null;
  /** A pick the evidence did not settle, or a tie (no id): said in warnings[] (ids only). */
  readonly note: string | null;
  /** Two or more pairs that nothing tells apart (no id used). */
  readonly tie: boolean;
}

/**
 * Resolves a gsis id through the persisted crosswalk and the evidence the server holds now
 * (pickGsisPair): the configured overrides, nflverse's roster rows of the candidate ESPN ids, the
 * player universe. A store or reader failure reads as "no evidence" — never an error.
 */
export function resolveGsis(ctx: Pick<ToolContext, "services">, gsis: string): GsisResolution {
  let pairs: readonly CrosswalkPair[];
  try {
    pairs = ctx.services.crosswalk.byGsis(gsis);
  } catch {
    return { espn_id: null, note: null, tie: false };
  }
  if (pairs.length === 0) return { espn_id: null, note: null, tie: false };
  const overrides = new Map<number, string>();
  try {
    for (const o of ctx.services.crosswalkOverrides) overrides.set(o.espn_id, o.gsis_id);
  } catch {
    // no configured overrides readable (a narrower services bundle): none
  }
  const ids = [...new Set(pairs.map((p) => p.espn_id))];
  let universe: Set<number> | null = null;
  let nflverse: Map<number, { gsis_id: string; season: number; week: number } | null> | null = null;
  if (pairs.length > 1) {
    try {
      const u = ctx.services.playerUniverse.byIds(ids);
      if (u.stamp !== null) universe = new Set(u.rows.map((r) => r.espn_id));
    } catch {
      universe = null;
    }
    try {
      const rows = new Map<number, { gsis_id: string; season: number; week: number } | null>();
      for (const id of ids) {
        const r = ctx.services.rosterWeekly.byEspnId(id);
        if (r.stamp === null) continue; // the roster was never loaded: not read
        const row = r.rows[0];
        rows.set(
          id,
          row === undefined ? null : { gsis_id: row.gsis_id, season: row.season, week: row.week },
        );
      }
      nflverse = rows;
    } catch {
      nflverse = null;
    }
  }
  const pick = pickGsisPair(gsis, pairs, { universe, overrides, nflverse });
  const listed = idsOf(pairs).map(String).join(", ");
  if (pick.kind === "none") return { espn_id: null, note: null, tie: false };
  if (pick.kind === "tie")
    return {
      espn_id: null,
      note: `gsis ${gsis}: the crosswalk pairs it with ${String(pairs.length)} ESPN players (${listed}) and nothing tells which is current: none used (pass player_ids)`,
      tie: true,
    };
  return {
    espn_id: pick.pair.espn_id,
    note: pick.established
      ? null
      : `gsis ${gsis}: the crosswalk pairs it with ${String(pairs.length)} ESPN players (${listed}); ${String(pick.pair.espn_id)} used (the most recently paired: neither the nflverse roster nor the player index settles it)`,
    tie: false,
  };
}

/**
 * The ESPN id a gsis id resolves to (resolveGsis), or null; a pick the evidence did not settle, or a
 * tie, is said in `warnings` when the caller passes them (ids only).
 */
export function espnIdOfGsis(
  ctx: Pick<ToolContext, "services">,
  gsis: string,
  warnings?: string[],
): number | null {
  const r = resolveGsis(ctx, gsis);
  if (r.note !== null && warnings !== undefined && !warnings.includes(r.note))
    warnings.push(r.note);
  return r.espn_id;
}

/**
 * The ESPN id a SINGLE-player selector's gsis id names: NOT_FOUND when nothing pairs it, VALIDATION
 * `gsis_ambiguous` on a tie (the caller names the player by player_ids instead), the pick otherwise
 * (an unsettled one said in `warnings`).
 */
export function espnIdOfGsisSelector(
  ctx: Pick<ToolContext, "services">,
  gsis: string,
  warnings: string[],
): number {
  const r = resolveGsis(ctx, gsis);
  if (r.tie)
    throw new EffError("VALIDATION", { field: "player.gsis_ids[0]", reason: "gsis_ambiguous" });
  if (r.espn_id === null) throw new EffError("NOT_FOUND");
  if (r.note !== null && !warnings.includes(r.note)) warnings.push(r.note);
  return r.espn_id;
}

/** Every ESPN id the crosswalk pairs with a gsis id (a join against a known id set needs them all). */
export function espnIdsPairedWith(ctx: Pick<ToolContext, "services">, gsis: string): number[] {
  try {
    return ctx.services.crosswalk.byGsis(gsis).map((p) => p.espn_id);
  } catch {
    return [];
  }
}

/** The matcher's lowest confidence: what an item matched by id alone (no per-ref confidence) reads. */
export const NEWS_MATCH_FLOOR = 0.6;

/** One player a stored news item names (the matcher's ref: ids and confidence, never text). */
export interface NewsRef {
  readonly espn_id: number | null;
  readonly gsis_id: string | null;
  readonly c: number;
}

/**
 * Every player a news item names: the refs the store's reader carries beside a NewsItem (evidence
 * `newsItemWithRefs` — ESPN ids too, so a ref with no gsis pair counts), read defensively; an item
 * without them (another reader) names its `gsis_ids`. At most 10.
 */
export function newsRefsOf(item: NewsItem): readonly NewsRef[] {
  const raw = (item as unknown as { refs?: unknown }).refs;
  if (Array.isArray(raw)) {
    const out: NewsRef[] = [];
    for (const r of raw.slice(0, 10)) {
      if (typeof r !== "object" || r === null) continue;
      const o = r as Record<string, unknown>;
      const e = typeof o.espn_id === "number" && Number.isSafeInteger(o.espn_id) ? o.espn_id : null;
      const g = asGsisId(o.gsis_id);
      const c =
        typeof o.match_confidence === "number" && o.match_confidence >= 0 && o.match_confidence <= 1
          ? o.match_confidence
          : NEWS_MATCH_FLOOR;
      if (e !== null || g !== null) out.push({ espn_id: e, gsis_id: g, c });
    }
    return out;
  }
  return item.gsis_ids
    .slice(0, 10)
    .map(asGsisId)
    .filter((g) => g !== null)
    .map((g) => ({ espn_id: null, gsis_id: g, c: NEWS_MATCH_FLOOR }));
}

/**
 * The most items the news reader returns from one read (its own ceiling, src/store/datasets/
 * readers-p2.ts NEWS_RECENT_MAX — the reader never returns more, whatever is asked).
 */
export const NEWS_READ_MAX = 500;

/** The players a news read selects: ESPN ids, their crosswalk gsis ids, and whether one has none. */
export interface NewsSelection {
  readonly espn_ids: readonly number[];
  readonly gsis_ids: readonly string[];
  /** A selected player (not a team unit) has no crosswalk pair: no gsis filter can find him. */
  readonly unpaired: boolean;
}

/** The selection of `players`: each one's ESPN id and crosswalk gsis id (a team unit needs none). */
export function newsSelectionOf(
  ctx: ToolContext,
  players: readonly { readonly ref: { readonly id: number }; readonly position_id: number }[],
): NewsSelection {
  const espn: number[] = [];
  const gsis: string[] = [];
  let unpaired = false;
  for (const p of players) {
    espn.push(p.ref.id);
    const g = crosswalkOf(ctx, p.ref.id, p.position_id).gsis_id;
    if (g !== null) gsis.push(g);
    else if (!isTeamUnitIdentity({ espn_id: p.ref.id, position_id: p.position_id }))
      unpaired = true;
  }
  return { espn_ids: [...new Set(espn)], gsis_ids: [...new Set(gsis)], unpaired };
}

/**
 * The newest news items since `sinceIso` that name a selected player — by a gsis id OR an ESPN id in
 * the item's refs (the matcher refs an ESPN id even where no crosswalk pair exists) — from the
 * selected feeds, at most `limit`. The reader merges the three feeds and keeps the newest `cap` of
 * them before any feed filter, and filters by gsis id only; so a feed filter applied after its cut
 * lost a feed's older in-window items silently, and an unpaired player's items could not be found
 * at all (Stage C findings news-sources-filter-after-cut, crosswalk-unpaired-joins-silent). Here the
 * read widens (doubling, up to NEWS_READ_MAX) until it holds more than `limit` matching items or
 * every item of the window; with an unpaired player the gsis filter is dropped and the refs decide.
 * `more`: matching items exist past `limit`; `capped`: the read stopped at the reader's ceiling
 * with the window not exhausted (older matching items may be missing).
 */
export async function newsMatching(
  ctx: ToolContext,
  o: {
    readonly sinceIso: IsoInstant;
    readonly limit: number;
    readonly players: NewsSelection | null;
    readonly sources: ReadonlySet<NewsItem["source"]> | null;
  },
): Promise<{
  readonly result: DatasetResult<NewsItem>;
  readonly items: NewsItem[];
  readonly more: boolean;
  readonly capped: boolean;
}> {
  const sel = o.players;
  const espn = new Set(sel?.espn_ids ?? []);
  const gsis = new Set(sel?.gsis_ids ?? []);
  const readerFilter = sel === null || sel.unpaired ? null : [...gsis];
  const sourcesCut = o.sources !== null && o.sources.size < 3;
  const refsCut = sel !== null && readerFilter === null;
  const matches = (it: NewsItem): boolean => {
    if (o.sources !== null && !o.sources.has(it.source)) return false;
    if (sel === null) return true;
    if (it.gsis_ids.some((g) => gsis.has(g))) return true;
    return newsRefsOf(it).some(
      (r) =>
        (r.espn_id !== null && espn.has(r.espn_id)) || (r.gsis_id !== null && gsis.has(r.gsis_id)),
    );
  };
  const limit = Math.max(1, Math.trunc(o.limit));
  // one more than the limit tells whether more exist; a filter applied here reads wider
  let cap = Math.min(NEWS_READ_MAX, (limit + 1) * (sourcesCut || refsCut ? 3 : 1));
  let result = ctx.services.datasets.news.recent(o.sinceIso, cap, readerFilter);
  let matched = result.rows.filter(matches);
  while (matched.length <= limit && result.rows.length >= cap && cap < NEWS_READ_MAX) {
    cap = Math.min(NEWS_READ_MAX, cap * 2);
    await turn();
    result = ctx.services.datasets.news.recent(o.sinceIso, cap, readerFilter);
    matched = result.rows.filter(matches);
  }
  const more = matched.length > limit;
  return {
    result,
    items: matched.slice(0, limit),
    more,
    capped: !more && result.rows.length >= cap && cap >= NEWS_READ_MAX,
  };
}

/** Re-exported for tools that need the full identity (team-unit checks on a PlatformPlayer). */
export { identityOfPlatformPlayer, isTeamUnitIdentity };

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

// --- the season of a stored transaction (Stage C finding transactions-store-not-season-scoped) -------

/**
 * The first instant of NFL season `s` — March 1, UTC: seasonOfInstant's boundary (a stored row's
 * season is that of its processed, else proposed, instant), the window every season-scoped read of
 * `transactions_seen` uses (the table has no season column).
 */
export function seasonStartIso(s: number): IsoInstant {
  return new Date(Date.UTC(s, 2, 1)).toISOString();
}

/**
 * The stored transactions of `season` at or after `since` (null: the whole season), newest first:
 * the season's window read whole (listRange), each row's own instant checked against the season
 * (seasonOfInstant). `transactions_seen` holds every season the server has seen or backfilled, so a
 * newest-first page of `list` returned week N of 2025 and 2024 with this season's week N and filled
 * an early-season page with previous seasons' adds (Stage C finding
 * transactions-store-not-season-scoped). `capped` is true when the season's window held more rows
 * than one read returns (its oldest rows were not read).
 */
export function seasonTransactions(
  seen: Pick<TransactionsSeenRepository, "listRange">,
  season: number,
  since: IsoInstant | null,
): { readonly rows: readonly Transaction[]; readonly capped: boolean } {
  const from = seasonStartIso(season);
  const until = seasonStartIso(season + 1);
  const lo = since !== null && Date.parse(since) > Date.parse(from) ? since : from;
  if (Date.parse(lo) >= Date.parse(until)) return { rows: [], capped: false };
  const all = seen.listRange(lo, until, TRANSACTIONS_RANGE_MAX);
  const rows = all.filter((t) => {
    const s = seasonOfInstant(t.process_date ?? t.proposed_date);
    return s === null || s === season;
  });
  return { rows, capped: all.length >= TRANSACTIONS_RANGE_MAX };
}

// --- position arguments (Stage C finding players-position-filter-unvalidated) -------------------------

/** Spellings a user types for ESPN's `D/ST` (plan 07 §4.2 spells `espn.stream <K|DST>`). */
export const POSITION_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  DST: "D/ST",
  DEF: "D/ST",
});

/**
 * A position argument in the league's own spelling: matched case-insensitively against `known`
 * (`DST`/`DEF` → `D/ST`), else VALIDATION `unknown_position` naming `field` — an empty result never
 * stands in for an input error. Before, C1 and E6 compared the raw string (C1 upper-cased only):
 * `DST`, `rb` and slot names silently matched nothing, and E6 then stated a false "no partner gains"
 * conclusion (Stage C finding players-position-filter-unvalidated).
 */
export function canonicalPosition(raw: string, known: Iterable<string>, field: string): string {
  const up = raw.trim().toUpperCase();
  const want = POSITION_ALIASES[up] ?? up;
  for (const k of known) if (k.toUpperCase() === want) return k;
  throw new EffError("VALIDATION", { field, reason: "unknown_position" });
}

// --- nightly snapshots standing in for a failed ESPN read (plan 01 §5.4, §7) -----------------------

/** How long a nightly snapshot can still be the week it names: one scoring period. */
export const SNAPSHOT_WEEK_SPAN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether a nightly snapshot (pool_snapshot, roster_snapshot) may answer for a failed ESPN read of
 * week `w`, and its input. A snapshot carries no season, so it must name week `w` AND be younger
 * than one scoring period: a week-`w` snapshot older than that is another season's week `w` (or a
 * week long gone) and is never served — null, and the caller re-raises the read's own error. A
 * usable snapshot is judged against the class it replaces (`cls`): past that class's hard limit it is
 * served only as the provider's cache path would serve an expired entry (serveDecision: under
 * `allow_stale`, or while the host has moved), else STALE_ONLY. It is always labelled at least stale.
 * Before, any snapshot of any age and season was served as "last night's", past the STALE_ONLY gate
 * the cache path enforces (Stage C finding players-pool-snapshot-fallback-unbounded).
 */
export function snapshotStandIn(
  snap: { readonly taken_at: string; readonly week: number } | undefined,
  w: Week,
  cls: FreshnessClassId,
  source: string,
  nowMs: number,
  opts: { readonly allowStale: boolean; readonly error: unknown },
): InputStamp | null {
  if (snap?.week !== w) return null;
  const taken = Date.parse(snap.taken_at);
  if (!Number.isFinite(taken) || nowMs - taken > SNAPSHOT_WEEK_SPAN_MS || taken - nowMs > 60_000)
    return null;
  const c = freshnessClass(cls);
  const st = stampState(
    c,
    { as_of: snap.taken_at, fetched_at: snap.taken_at, checked_at: null },
    nowMs,
  );
  const hostMoved = (opts.error as { effCode?: unknown } | null)?.effCode === "ESPN_HOST_MOVED";
  const d = serveDecision(c, st.state, { allowStale: opts.allowStale, hostMoved });
  if (d.outcome !== "serve") throw new EffError("STALE_ONLY");
  return {
    source,
    as_of: snap.taken_at,
    fetched_at: snap.taken_at,
    basis_at: st.basis_at,
    state: st.state === "fresh" ? "stale" : st.state,
  };
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

/**
 * Lets the event loop run (timers, stdin, the shutdown handler) before the next synchronous step of
 * a tool: a cached roster parse, the player-index mapping and the dataset reads each take ~10–25 ms,
 * and chained as one macrotask they passed the 50 ms main-loop stall bound (plan 03 §1.2; plan 10
 * A16a; ADV OBJ-07 — found by the full-toolset stall probe). Through the process-wide turn gate
 * (cooperative.ts `yieldTurn`): one slice per loop turn however many calls are in flight (Stage C
 * finding analytics-parallel-calls-stall-loop).
 */
export function turn(): Promise<void> {
  return yieldTurn();
}
