// common.ts — what the plan 07 §2 conventions need in every tool: the configured league ref (never
// a tool argument — plan 02 §5), read options carrying the per-call budget (plan 01 §5.6), stamps →
// envelope inputs through the ONE conversion (stampToInput), dataset reads with STALE_ONLY past a
// hard limit unless `allow_stale` and the never-loaded answer (plan 01 §5.4), the week / my-team
// defaults (plan 07 §2), the pro schedule (dataset first, the keyless view only when the store is
// empty — plan 01 §5.5), the crosswalk state behind every gsis id (plan 07 C1), and the partial
// rule for a 4th request (plan 01 §5.6). Ported from sibling @5daa625, adapted to the ESPN seam.
import {
  DEFAULT_TTL_CONTEXT,
  freshnessClass,
  inGameWindow,
  serveDecision,
  stampState,
  type FreshnessClassId,
  type TtlContext,
} from "../../config/freshness.js";
import type { DatasetResult, DatasetStamp } from "../../domain/analytics/types.js";
import { yieldTurn } from "../../domain/analytics/cooperative.js";
import { espnRosLastWeek, rosWeeksOf, type RosWeek } from "../../domain/analytics/projection.js";
import type { WeeklyValuesOpts } from "../../domain/analytics/waivers.js";
import {
  crosswalkStatusOfPair,
  identityOfPlatformPlayer,
  isTeamUnitIdentity,
} from "../../domain/crosswalk/resolver.js";
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

const EASTERN_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The US-Eastern calendar date of an instant (`YYYY-MM-DD`): the NFL's game day. */
export function easternDate(ms: number): string {
  return EASTERN_DATE.format(new Date(ms));
}

/** Days before the first and after the last kickoff still counted as the season (as the provider counts). */
const IN_SEASON_MARGIN_MS = 14 * 86_400_000;

/**
 * The TTL context at `nowMs` from a season's pro-schedule games (plan 01 §5.2): a game day is a day
 * with a kickoff on the league's local calendar — US Eastern, the NFL's (a Thursday-night game kicks
 * off after midnight UTC, so a UTC-date test read the TNF Thursday as no game day and the Friday after
 * as one); a game window is open while any game is under way; the season runs from two weeks before
 * the first kickoff to two weeks after the last. No games: the default context.
 */
export function ttlContextAt(games: readonly ProGame[], nowMs: number): TtlContext {
  const flags = games.map((g) => ({
    kickoff_ms: g.kickoff === null || g.start_time_tbd ? null : Date.parse(g.kickoff),
    valid_for_locking: g.valid_for_locking,
    stats_official: g.stats_official,
  }));
  const kicks = flags
    .map((f) => f.kickoff_ms)
    .filter((k): k is number => k !== null && Number.isFinite(k));
  if (kicks.length === 0) return DEFAULT_TTL_CONTEXT;
  const today = easternDate(nowMs);
  return {
    inGameWindow: inGameWindow(flags, nowMs),
    gameDay: kicks.some((k) => easternDate(k) === today),
    inSeason:
      nowMs >= Math.min(...kicks) - IN_SEASON_MARGIN_MS &&
      nowMs <= Math.max(...kicks) + IN_SEASON_MARGIN_MS,
  };
}

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
 * The week a call means (plan 07 §2): the argument, else the league's current scoring period,
 * clamped into a tool's 1..18 (a preseason period 0 reads as week 1; a kicker-only 19–22 as 18).
 */
export function weekOf(league: League, week: number | undefined): Week {
  if (week !== undefined) return week;
  const cur = league.clock.current_scoring_period;
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
export function rosOptsOf(p: PlatformPlayer, ros: RosReading | null): WeeklyValuesOpts {
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
