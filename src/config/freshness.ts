// freshness.ts — the plan 01 §5.2/§5.4 TTL and hard-limit table as data (ESPN classes with their
// game-window / game-day / off-season TTLs, dataset classes judged from the last release check),
// the serve rule incl. the host-moved hard-limit suspension (plan 01 §7, ADV OBJ-06), the
// provisional / corrections-window / game-window helpers (plan 01 §5.4), and the per-source
// license + attribution registry (plan 01 §4.2, §9; research 04 §E). Every number is an assumption
// (plan 01 A-6..A-12): tests assert the SHAPE (fresh < hard), never the values.
// Ported from sibling @d72e03b, adapted (ESPN classes and attribution; manual/Yahoo rows dropped).

/** The envelope's freshness label (plan 01 §4.2). */
export type Freshness = "fresh" | "stale" | "provisional";
/** What a classifier says about one input's age against its class. */
export type FreshnessState = "fresh" | "stale" | "expired";
/** What happens past the hard limit: a `STALE_ONLY` error, or the driver is omitted and named. */
export type BeyondHardLimit = "STALE_ONLY" | "omit";
/**
 * How a class's age is measured: `age` since the fetch; `release` since the last successful
 * release/refresh check (an unchanged release checked an hour ago is fresh); `immutable` never ages.
 */
export type AgeBasis = "age" | "release" | "immutable";
/** Where the class's data comes from: an ESPN read through the provider, or a dataset file. */
export type ClassOrigin = "espn" | "dataset" | "store";
/** The build phase that first produces a class (plan 10 §1). */
export type Phase = "1a" | "1b" | "2" | "3" | "later";

/** One row of the freshness table. */
export interface FreshnessClass {
  readonly id: FreshnessClassId;
  readonly description: string;
  readonly origin: ClassOrigin;
  readonly basis: AgeBasis;
  /** Fresh while age ≤ this; null = always fresh (immutable). */
  readonly ttlSeconds: number | null;
  /** TTL while any game is in progress (plan 01 §5.2 live row); null = same as `ttlSeconds`. */
  readonly ttlInGameWindowSeconds: number | null;
  /** TTL on an NFL game day (Thu/Sun/Mon per the schedule); null = same as `ttlSeconds`. */
  readonly ttlGameDaySeconds: number | null;
  /** TTL off-season; null = same as `ttlSeconds`. */
  readonly ttlOffSeasonSeconds: number | null;
  /** Stale (served, warned) while age ≤ this; beyond → `beyondHard`. null = never expires. */
  readonly hardLimitSeconds: number | null;
  /** The consequence past the hard limit; null exactly when `hardLimitSeconds` is null. */
  readonly beyondHard: BeyondHardLimit | null;
  readonly phase: Phase;
  /** The plan 01 §14 assumption behind the numbers, when assumed. */
  readonly assumption: string | null;
}

const MIN = 60;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Every freshness class id (plan 01 §5.2 rows). */
export const FRESHNESS_CLASS_IDS = [
  "espn_settings",
  "espn_standings",
  "espn_roster",
  "espn_matchups",
  "espn_matchups_final",
  "espn_live",
  "espn_pool",
  "espn_player_card",
  "espn_player_stats_final",
  "espn_transactions",
  "espn_draft",
  "espn_positional_ratings",
  "espn_pro_schedule",
  "espn_players",
  "nflverse_stats_player_week",
  "nflverse_stats_team_week",
  "nflverse_pbp",
  "nflverse_snap_counts",
  "nflverse_pfr_advstats",
  "nflverse_ftn_charting",
  "nflverse_injuries",
  "nflverse_depth_charts",
  "nflverse_roster_weekly",
  "nflverse_players",
  "nflverse_schedules",
  "lines",
  "ffopportunity_ep_weekly",
  "odds",
  "weather",
  "news",
  "sleeper_trending",
  "crosswalk",
] as const;
export type FreshnessClassId = (typeof FRESHNESS_CLASS_IDS)[number];

interface RowOpts {
  readonly window?: number;
  readonly gameDay?: number;
  readonly offSeason?: number;
  readonly assumption?: string;
}

const row = (
  id: FreshnessClassId,
  description: string,
  origin: ClassOrigin,
  basis: AgeBasis,
  ttlSeconds: number | null,
  hardLimitSeconds: number | null,
  beyondHard: BeyondHardLimit | null,
  phase: Phase,
  o: RowOpts = {},
): FreshnessClass =>
  Object.freeze({
    id,
    description,
    origin,
    basis,
    ttlSeconds,
    ttlInGameWindowSeconds: o.window ?? null,
    ttlGameDaySeconds: o.gameDay ?? null,
    ttlOffSeasonSeconds: o.offSeason ?? null,
    hardLimitSeconds,
    beyondHard,
    phase,
    assumption: o.assumption ?? null,
  });

/** The table (plan 01 §5.2 "TTL (fresh)" and "Hard limit"; §5.4 "beyond"). */
// prettier-ignore
export const FRESHNESS_TABLE: Readonly<Record<FreshnessClassId, FreshnessClass>> = Object.freeze({
  espn_settings: row("espn_settings", "league settings: scoring, slots, waivers, playoffs (mSettings)", "espn", "age", DAY, 7 * DAY, "STALE_ONLY", "1a", { assumption: "A-6" }),
  espn_standings: row("espn_standings", "teams, records, standings, waiver order (mTeam + mStandings)", "espn", "age", 15 * MIN, DAY, "STALE_ONLY", "1a", { offSeason: 6 * HOUR, assumption: "A-7" }),
  espn_roster: row("espn_roster", "rosters, all teams, per week (mRoster)", "espn", "age", 5 * MIN, DAY, "STALE_ONLY", "1a", { offSeason: HOUR }),
  espn_matchups: row("espn_matchups", "season schedule and results (mMatchup)", "espn", "age", 15 * MIN, DAY, "STALE_ONLY", "1a"),
  espn_matchups_final: row("espn_matchups_final", "results of weeks past the 7-day correction window (immutable)", "espn", "immutable", null, null, null, "1a"),
  espn_live: row("espn_live", "live totals, win probability, per-player actuals (mMatchupScore, mBoxscore)", "espn", "age", 10 * MIN, DAY, "STALE_ONLY", "1a", { window: MIN }),
  espn_pool: row("espn_pool", "player pool, ESPN projections, ownership, injury enum, outlooks (kona_player_info)", "espn", "age", HOUR, DAY, "STALE_ONLY", "1a"),
  espn_player_card: row("espn_player_card", "player card and weekly actuals of open weeks (kona_playercard)", "espn", "age", 6 * HOUR, DAY, "STALE_ONLY", "2"),
  espn_player_stats_final: row("espn_player_stats_final", "player weekly actuals past the correction window (immutable)", "espn", "immutable", null, null, null, "2"),
  espn_transactions: row("espn_transactions", "transactions, pending claims (mTransactions2, mPendingTransactions)", "espn", "age", 10 * MIN, DAY, "STALE_ONLY", "1b"),
  espn_draft: row("espn_draft", "draft results once drafted (immutable)", "espn", "immutable", null, null, null, "later"),
  espn_positional_ratings: row("espn_positional_ratings", "position-vs-opponent ratings (mPositionalRatings)", "espn", "age", DAY, 7 * DAY, "STALE_ONLY", "2"),
  espn_pro_schedule: row("espn_pro_schedule", "NFL schedule, byes, kickoffs, lock and final flags (proTeamSchedules_wl)", "dataset", "release", 6 * HOUR, 7 * DAY, "STALE_ONLY", "1a", { gameDay: HOUR, assumption: "A-9" }),
  espn_players: row("espn_players", "player universe: ids, positions, team, % owned (players_wl)", "dataset", "release", DAY, 7 * DAY, "STALE_ONLY", "1a"),
  nflverse_stats_player_week: row("nflverse_stats_player_week", "nflverse weekly player stats", "dataset", "release", DAY, 3 * DAY, "STALE_ONLY", "1a", { assumption: "A-10" }),
  nflverse_stats_team_week: row("nflverse_stats_team_week", "nflverse weekly team stats", "dataset", "release", DAY, 3 * DAY, "STALE_ONLY", "2", { assumption: "A-10" }),
  nflverse_pbp: row("nflverse_pbp", "nflverse play-by-play (projected subset)", "dataset", "release", DAY, 3 * DAY, "STALE_ONLY", "2", { assumption: "A-10, A-11" }),
  nflverse_snap_counts: row("nflverse_snap_counts", "nflverse snap counts", "dataset", "release", DAY, 3 * DAY, "STALE_ONLY", "2"),
  nflverse_pfr_advstats: row("nflverse_pfr_advstats", "nflverse PFR advanced stats", "dataset", "release", DAY, 3 * DAY, "STALE_ONLY", "2"),
  nflverse_ftn_charting: row("nflverse_ftn_charting", "FTN charting via nflverse (CC-BY-SA)", "dataset", "release", DAY, 3 * DAY, "STALE_ONLY", "2"),
  nflverse_injuries: row("nflverse_injuries", "official injury report and practice participation", "dataset", "release", 12 * HOUR, 36 * HOUR, "STALE_ONLY", "1a"),
  nflverse_depth_charts: row("nflverse_depth_charts", "depth charts (ESPN-keyed)", "dataset", "release", DAY, 4 * DAY, "STALE_ONLY", "2"),
  nflverse_roster_weekly: row("nflverse_roster_weekly", "weekly rosters and ids — the crosswalk source", "dataset", "release", DAY, 7 * DAY, "STALE_ONLY", "1a"),
  nflverse_players: row("nflverse_players", "nflverse players table (ids)", "dataset", "release", DAY, 7 * DAY, "STALE_ONLY", "1a"),
  nflverse_schedules: row("nflverse_schedules", "games.csv: roof, surface, rest, results — joined on the ESPN game id", "dataset", "release", 6 * HOUR + 30 * MIN, 7 * DAY, "STALE_ONLY", "1a", { gameDay: 30 * MIN, assumption: "A-12" }),
  lines: row("lines", "betting lines from nflverse schedules (spread, total, moneyline)", "dataset", "release", 6 * HOUR + 30 * MIN, DAY, "omit", "1a", { gameDay: 30 * MIN, assumption: "A-12" }),
  ffopportunity_ep_weekly: row("ffopportunity_ep_weekly", "ffopportunity expected fantasy points (CC-BY-SA)", "dataset", "release", DAY, 4 * DAY, "STALE_ONLY", "2"),
  odds: row("odds", "The Odds API lines (optional key)", "dataset", "age", 8 * HOUR, DAY, "omit", "later"),
  weather: row("weather", "game-venue weather (Open-Meteo / NWS)", "dataset", "age", HOUR, 12 * HOUR, "omit", "1a"),
  news: row("news", "RSS headlines (RotoWire, ESPN, CBS)", "dataset", "age", 15 * MIN, DAY, "omit", "2"),
  sleeper_trending: row("sleeper_trending", "Sleeper trending adds/drops (secondary)", "dataset", "age", 30 * MIN, 6 * HOUR, "omit", "2"),
  crosswalk: row("crosswalk", "persisted ESPN id ↔ gsis_id pairs (never expire)", "store", "immutable", null, null, null, "1a"),
});

/** Looks up a class; throws on an unknown id (a programming error, never user input). */
export function freshnessClass(id: FreshnessClassId): FreshnessClass {
  const c = (FRESHNESS_TABLE as Partial<Record<string, FreshnessClass>>)[id];
  if (c === undefined) throw new Error("freshness: unknown class");
  return c;
}

/** The context that picks a class's TTL (plan 01 §5.2). */
export interface TtlContext {
  /** Any game of the period is in progress (see `inGameWindow`). */
  readonly inGameWindow: boolean;
  /** Today is an NFL game day per the schedule. */
  readonly gameDay: boolean;
  /** The league is in season (`status.isActive`). */
  readonly inSeason: boolean;
}

/** The default context: in season, not a game day, no game in progress. */
export const DEFAULT_TTL_CONTEXT: TtlContext = Object.freeze({
  inGameWindow: false,
  gameDay: false,
  inSeason: true,
});

/** The TTL that applies: game window > game day > off-season > default. */
export function ttlFor(cls: FreshnessClass, ctx: TtlContext = DEFAULT_TTL_CONTEXT): number | null {
  if (ctx.inGameWindow && cls.ttlInGameWindowSeconds !== null) return cls.ttlInGameWindowSeconds;
  if (ctx.gameDay && cls.ttlGameDaySeconds !== null) return cls.ttlGameDaySeconds;
  if (!ctx.inSeason && cls.ttlOffSeasonSeconds !== null) return cls.ttlOffSeasonSeconds;
  return cls.ttlSeconds;
}

/**
 * Classifies an age (plan 01 §5.4): `fresh` while ≤ ttl, `stale` while ≤ hard limit, `expired`
 * beyond. Monotone in age. A negative, NaN or infinite age is a caller bug and throws — it must
 * never silently read as fresh.
 */
export function classifyAge(
  cls: FreshnessClass,
  ageSeconds: number,
  ctx: TtlContext = DEFAULT_TTL_CONTEXT,
): FreshnessState {
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0)
    throw new RangeError("freshness: age must be a finite, non-negative number of seconds");
  const ttl = ttlFor(cls, ctx);
  if (cls.basis === "immutable" || ttl === null || ageSeconds <= ttl) return "fresh";
  if (cls.hardLimitSeconds === null || ageSeconds <= cls.hardLimitSeconds) return "stale";
  return "expired";
}

/**
 * The instants an input stamp carries: `as_of` content time, `fetched_at` fetch time,
 * `checked_at` last successful release/refresh check (release basis; null → `fetched_at`).
 */
export interface StampInstants {
  readonly as_of: string;
  readonly fetched_at: string;
  readonly checked_at: string | null;
}

/** An input's state judged by its class's basis, with the instant it was judged from. */
export interface StampState {
  readonly state: FreshnessState;
  /** The instant the age was measured from (ISO-8601 UTC) — what a stale warning must quote. */
  readonly basis_at: string;
  /** Whole seconds from `basis_at` to now, ≥ 0 (a future instant — clock skew — reads 0). */
  readonly age_s: number;
}

function isoMs(s: string): number {
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) throw new RangeError("freshness: invalid ISO instant in stamp");
  return ms;
}

/**
 * Judges one input against its class from the instant its basis names: `age`/`immutable` →
 * `fetched_at`; `release` → the later of `checked_at` and `fetched_at`.
 */
export function stampState(
  cls: FreshnessClass,
  t: StampInstants,
  nowMs: number,
  ctx: TtlContext = DEFAULT_TTL_CONTEXT,
): StampState {
  if (!Number.isFinite(nowMs)) throw new RangeError("freshness: now must be finite");
  const fetched = isoMs(t.fetched_at);
  isoMs(t.as_of);
  const basis =
    cls.basis === "release" && t.checked_at !== null
      ? Math.max(isoMs(t.checked_at), fetched)
      : fetched;
  const age = Math.max(0, Math.floor((nowMs - basis) / 1000));
  return { state: classifyAge(cls, age, ctx), basis_at: new Date(basis).toISOString(), age_s: age };
}

/** What a tool does with an input in a given state (plan 01 §5.4, §5.7, §7). */
export interface ServeDecision {
  readonly outcome: "serve" | "stale_only" | "omit";
  /** The label the served input carries. */
  readonly label: "fresh" | "stale";
  /** True when an expired ESPN input is served only because the host moved (ADV OBJ-06). */
  readonly hardLimitSuspended: boolean;
}

/**
 * The serve rule: fresh/stale inputs are served; an expired input is omitted (omit classes),
 * served as stale under `allow_stale`, served as stale while `drift.status` is `host_moved` for
 * ESPN classes (the hard limit is suspended until the override or the release), else `STALE_ONLY`.
 */
export function serveDecision(
  cls: FreshnessClass,
  state: FreshnessState,
  opts: { readonly allowStale: boolean; readonly hostMoved: boolean },
): ServeDecision {
  if (state !== "expired") return { outcome: "serve", label: state, hardLimitSuspended: false };
  if (cls.beyondHard === "omit")
    return { outcome: "omit", label: "stale", hardLimitSuspended: false };
  if (opts.allowStale) return { outcome: "serve", label: "stale", hardLimitSuspended: false };
  if (opts.hostMoved && cls.origin === "espn")
    return { outcome: "serve", label: "stale", hardLimitSuspended: true };
  return { outcome: "stale_only", label: "stale", hardLimitSuspended: false };
}

/** The worse of two envelope labels: stale > provisional > fresh. */
export function worseFreshness(a: Freshness, b: Freshness): Freshness {
  const rank: Record<Freshness, number> = { fresh: 0, provisional: 1, stale: 2 };
  return rank[a] >= rank[b] ? a : b;
}

// --- period helpers (plan 01 §5.2 live row, §5.4 provisional rule; research 04 §B.1.6–B.1.7) --------

/** One NFL game's lock/final flags, as `proTeamSchedules_wl` carries them. */
export interface GameFlags {
  /** Kickoff, epoch ms; null when `startTimeTBD`. */
  readonly kickoff_ms: number | null;
  readonly valid_for_locking: boolean;
  readonly stats_official: boolean;
}

/** The ESPN stat-correction window after a period's last game (research 04 §B.1.7). */
export const CORRECTIONS_WINDOW_MS = 7 * DAY * 1000;

/** `meta.provisional`: true iff any game of the period has `statsOfficial: false`. */
export function isPeriodProvisional(games: readonly Pick<GameFlags, "stats_official">[]): boolean {
  return games.some((g) => !g.stats_official);
}

/**
 * `meta.corrections_window_open`: true until 7 days after the period's last game kickoff; an
 * unknown last kickoff (null) is conservatively open.
 */
export function correctionsWindowOpen(lastGameKickoffMs: number | null, nowMs: number): boolean {
  if (!Number.isFinite(nowMs)) throw new RangeError("freshness: now must be finite");
  if (lastGameKickoffMs === null || !Number.isFinite(lastGameKickoffMs)) return true;
  return nowMs < lastGameKickoffMs + CORRECTIONS_WINDOW_MS;
}

/** A game window is open when any game is `validForLocking && !statsOfficial && now ≥ kickoff`. */
export function inGameWindow(games: readonly GameFlags[], nowMs: number): boolean {
  return games.some(
    (g) =>
      g.valid_for_locking && !g.stats_official && g.kickoff_ms !== null && nowMs >= g.kickoff_ms,
  );
}

/** A resource's `ttlMs`: the class TTL capped at one day; one day for immutable classes. */
export function resourceTtlMs(cls: FreshnessClass): number {
  return (cls.ttlSeconds === null ? DAY : Math.min(cls.ttlSeconds, DAY)) * 1000;
}

// --- licenses, attribution, dataset sources (plan 01 §4.2, §9 DataSource; research 04 §E) --------

/** A source's license class; `espn-unofficial` keeps the ESPN layer separable (plan 01 §9). */
export type License =
  | "CC-BY-4.0"
  | "CC-BY-SA-4.0"
  | "public-domain"
  | "non-commercial"
  | "api-terms"
  | "espn-unofficial";
/** Every license value. */
export const LICENSES: readonly License[] = Object.freeze([
  "CC-BY-4.0",
  "CC-BY-SA-4.0",
  "public-domain",
  "non-commercial",
  "api-terms",
  "espn-unofficial",
]);

/** One `meta.attribution[]` entry (plan 01 §4.2). */
export interface Attribution {
  readonly source: string;
  readonly text: string | null;
  readonly license: License | null;
  readonly url: string;
}

/** The attribution entries, one per provider. */
// prettier-ignore
export const ATTRIBUTIONS = Object.freeze({
  espn_fantasy: Object.freeze({ source: "ESPN Fantasy Football", text: "League data and ESPN projections from ESPN Fantasy (unofficial API); not affiliated with ESPN or Disney", license: "espn-unofficial", url: "https://fantasy.espn.com/" }),
  nflverse: Object.freeze({ source: "nflverse", text: null, license: "CC-BY-4.0", url: "https://github.com/nflverse/nflverse-data" }),
  ftn: Object.freeze({ source: "FTN Data via nflverse", text: "Charting data from FTN Data via nflverse (CC BY-SA 4.0)", license: "CC-BY-SA-4.0", url: "https://github.com/nflverse/nflverse-data" }),
  ffopportunity: Object.freeze({ source: "ffopportunity (ffverse)", text: null, license: "CC-BY-SA-4.0", url: "https://github.com/ffverse/ffopportunity" }),
  open_meteo: Object.freeze({ source: "Open-Meteo", text: "Weather data by Open-Meteo.com (CC BY 4.0); free API for non-commercial use", license: "non-commercial", url: "https://open-meteo.com/" }),
  nws: Object.freeze({ source: "National Weather Service", text: null, license: "public-domain", url: "https://www.weather.gov/" }),
  sleeper: Object.freeze({ source: "Sleeper", text: null, license: "non-commercial", url: "https://docs.sleeper.com/" }),
  rotowire: Object.freeze({ source: "RotoWire", text: null, license: "api-terms", url: "https://www.rotowire.com/" }),
  espn_rss: Object.freeze({ source: "ESPN (RSS)", text: null, license: "api-terms", url: "https://www.espn.com/" }),
  cbs: Object.freeze({ source: "CBS Sports", text: null, license: "api-terms", url: "https://www.cbssports.com/" }),
  the_odds_api: Object.freeze({ source: "The Odds API", text: null, license: "api-terms", url: "https://the-odds-api.com/" }),
} satisfies Record<string, Attribution>);

/**
 * The fixed vocabulary of a source's last error (refresh_log `error`; G1 `sources[].last_error`):
 * plan 01 §4.3 codes a refresh can end in, plus three refresh-only conditions (an asserted column
 * set or codec failed, or the season is not published upstream yet). Never an exception message
 * or upstream text (plan 01 §4.3). tests/config/freshness.test.ts holds the upper-case ones to
 * src/mcp/errors.ts ERROR_CODES (config may not import mcp).
 */
export const SOURCE_ERROR_CODES = [
  "UPSTREAM_UNAVAILABLE",
  "ESPN_UPSTREAM_UNAVAILABLE",
  "ESPN_DRIFT_DETECTED",
  "ESPN_HOST_MOVED",
  "ESPN_AUTH_REJECTED",
  "ESPN_REQUIRES_COOKIES",
  "RATE_LIMITED",
  "INTERNAL",
  "schema_mismatch",
  "codec",
  "not_published",
] as const;
export type SourceErrorCode = (typeof SOURCE_ERROR_CODES)[number];
/** Whether `v` is a SourceErrorCode (anything else is stored as `INTERNAL`). */
export function isSourceErrorCode(v: unknown): v is SourceErrorCode {
  return typeof v === "string" && (SOURCE_ERROR_CODES as readonly string[]).includes(v);
}

/** Every dataset source id a `DataSource` may carry (`<provider>:<dataset>`; plan 01 §9). */
export const DATASET_SOURCE_IDS = [
  "espn:pro_schedule",
  "espn:players",
  "nflverse:stats_player_week",
  "nflverse:stats_team_week",
  "nflverse:pbp",
  "nflverse:snap_counts",
  "nflverse:pfr_advstats",
  "nflverse:ftn_charting",
  "nflverse:injuries",
  "nflverse:depth_charts",
  "nflverse:roster_weekly",
  "nflverse:players",
  "nflverse:schedules",
  "ffopportunity:ep_weekly",
  "sleeper:trending",
  "news:rotowire",
  "news:espn",
  "news:cbs",
  "weather:open_meteo",
  "weather:nws",
  "odds:the_odds_api",
  // the Phase-2 history files: the two prior seasons of a current-season source, in their own
  // dataset file (plan 10 §3.2 "two prior nflverse seasons"; D9; A-3; src/store/datasets/tables.ts
  // HISTORY_DATASET_SOURCES), written by the same job as their current source
  "nflverse:stats_player_week_history",
  "nflverse:stats_team_week_history",
  "nflverse:pbp_history",
  "nflverse:snap_counts_history",
  "nflverse:injuries_history",
  "nflverse:depth_charts_history",
  "ffopportunity:ep_weekly_history",
] as const;
export type DatasetSourceId = (typeof DATASET_SOURCE_IDS)[number];

/** The `eff refresh <job>` names — the eleven refresh sources of `full` (plan 06 §1.3). */
export const REFRESH_JOBS = [
  "espn:schedule",
  "espn:players",
  "nflverse:stats",
  "nflverse:snaps",
  "nflverse:daily",
  "nflverse:schedules",
  "ffopportunity",
  "sleeper:trending",
  "news",
  "weather",
  "odds",
] as const;
export type RefreshJob = (typeof REFRESH_JOBS)[number];

/** Registry row for one dataset source. */
export interface SourceInfo {
  readonly id: DatasetSourceId;
  readonly freshness: FreshnessClassId;
  readonly license: License;
  readonly attribution: Attribution;
  /** The refresh job that writes it. */
  readonly job: RefreshJob;
  readonly phase: Phase;
}

const src = (
  id: DatasetSourceId,
  freshness: FreshnessClassId,
  attribution: Attribution & { readonly license: License },
  job: RefreshJob,
  phase: Phase,
): SourceInfo =>
  Object.freeze({ id, freshness, license: attribution.license, attribution, job, phase });

/** The dataset source registry (plan 01 §5.2; plan 06 §1.3; research 04 §E licenses). */
// prettier-ignore
export const SOURCE_REGISTRY: Readonly<Record<DatasetSourceId, SourceInfo>> = Object.freeze({
  "espn:pro_schedule": src("espn:pro_schedule", "espn_pro_schedule", ATTRIBUTIONS.espn_fantasy, "espn:schedule", "1a"),
  "espn:players": src("espn:players", "espn_players", ATTRIBUTIONS.espn_fantasy, "espn:players", "1a"),
  "nflverse:stats_player_week": src("nflverse:stats_player_week", "nflverse_stats_player_week", ATTRIBUTIONS.nflverse, "nflverse:stats", "1a"),
  "nflverse:stats_team_week": src("nflverse:stats_team_week", "nflverse_stats_team_week", ATTRIBUTIONS.nflverse, "nflverse:stats", "2"),
  "nflverse:pbp": src("nflverse:pbp", "nflverse_pbp", ATTRIBUTIONS.nflverse, "nflverse:stats", "2"),
  "nflverse:snap_counts": src("nflverse:snap_counts", "nflverse_snap_counts", ATTRIBUTIONS.nflverse, "nflverse:snaps", "2"),
  "nflverse:pfr_advstats": src("nflverse:pfr_advstats", "nflverse_pfr_advstats", ATTRIBUTIONS.nflverse, "nflverse:snaps", "2"),
  "nflverse:ftn_charting": src("nflverse:ftn_charting", "nflverse_ftn_charting", ATTRIBUTIONS.ftn, "nflverse:snaps", "2"),
  "nflverse:injuries": src("nflverse:injuries", "nflverse_injuries", ATTRIBUTIONS.nflverse, "nflverse:daily", "1a"),
  "nflverse:depth_charts": src("nflverse:depth_charts", "nflverse_depth_charts", ATTRIBUTIONS.nflverse, "nflverse:daily", "2"),
  "nflverse:roster_weekly": src("nflverse:roster_weekly", "nflverse_roster_weekly", ATTRIBUTIONS.nflverse, "nflverse:daily", "1a"),
  "nflverse:players": src("nflverse:players", "nflverse_players", ATTRIBUTIONS.nflverse, "nflverse:daily", "1a"),
  "nflverse:schedules": src("nflverse:schedules", "nflverse_schedules", ATTRIBUTIONS.nflverse, "nflverse:schedules", "1a"),
  "ffopportunity:ep_weekly": src("ffopportunity:ep_weekly", "ffopportunity_ep_weekly", ATTRIBUTIONS.ffopportunity, "ffopportunity", "2"),
  "sleeper:trending": src("sleeper:trending", "sleeper_trending", ATTRIBUTIONS.sleeper, "sleeper:trending", "2"),
  "news:rotowire": src("news:rotowire", "news", ATTRIBUTIONS.rotowire, "news", "2"),
  "news:espn": src("news:espn", "news", ATTRIBUTIONS.espn_rss, "news", "2"),
  "news:cbs": src("news:cbs", "news", ATTRIBUTIONS.cbs, "news", "2"),
  "weather:open_meteo": src("weather:open_meteo", "weather", ATTRIBUTIONS.open_meteo, "weather", "1a"),
  "weather:nws": src("weather:nws", "weather", ATTRIBUTIONS.nws, "weather", "1a"),
  "odds:the_odds_api": src("odds:the_odds_api", "odds", ATTRIBUTIONS.the_odds_api, "odds", "later"),
  "nflverse:stats_player_week_history": src("nflverse:stats_player_week_history", "nflverse_stats_player_week", ATTRIBUTIONS.nflverse, "nflverse:stats", "2"),
  "nflverse:stats_team_week_history": src("nflverse:stats_team_week_history", "nflverse_stats_team_week", ATTRIBUTIONS.nflverse, "nflverse:stats", "2"),
  "nflverse:pbp_history": src("nflverse:pbp_history", "nflverse_pbp", ATTRIBUTIONS.nflverse, "nflverse:stats", "2"),
  "nflverse:snap_counts_history": src("nflverse:snap_counts_history", "nflverse_snap_counts", ATTRIBUTIONS.nflverse, "nflverse:snaps", "2"),
  "nflverse:injuries_history": src("nflverse:injuries_history", "nflverse_injuries", ATTRIBUTIONS.nflverse, "nflverse:daily", "2"),
  "nflverse:depth_charts_history": src("nflverse:depth_charts_history", "nflverse_depth_charts", ATTRIBUTIONS.nflverse, "nflverse:daily", "2"),
  "ffopportunity:ep_weekly_history": src("ffopportunity:ep_weekly_history", "ffopportunity_ep_weekly", ATTRIBUTIONS.ffopportunity, "ffopportunity", "2"),
});

/** Whether a string is a known dataset source id. */
export function isDatasetSourceId(s: string): s is DatasetSourceId {
  return (DATASET_SOURCE_IDS as readonly string[]).includes(s);
}

/** The dataset sources a refresh job writes. */
export function sourcesOfJob(job: RefreshJob): readonly DatasetSourceId[] {
  return DATASET_SOURCE_IDS.filter((id) => SOURCE_REGISTRY[id].job === job);
}

/** An ESPN provenance tag: `espn:<view or kind>` (`espn:mRoster`, `espn:projection`). */
export const ESPN_SOURCE_TAG_RE = /^espn:[A-Za-z][A-Za-z0-9_]{0,47}$/;

/**
 * The attribution entry for one `meta.source[]` tag, or null when none is owed: any `espn:*` tag
 * → the ESPN Fantasy line (honesty + no-affiliation, plan 01 §4.2); a dataset source id → its
 * provider; internal tags (`engine`, `store:pool_snapshot`, `store.recommendation_log`) → null.
 */
export function attributionFor(sourceTag: string): Attribution | null {
  if (ESPN_SOURCE_TAG_RE.test(sourceTag)) return ATTRIBUTIONS.espn_fantasy;
  return isDatasetSourceId(sourceTag) ? SOURCE_REGISTRY[sourceTag].attribution : null;
}
