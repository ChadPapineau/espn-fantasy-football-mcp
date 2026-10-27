// provider.ts — EspnProvider, the FantasyPlatform read seam over ESPN's read host (plan 01 §9; plan
// 07 §3 what each P0 tool asks of it; plan 01 §5.6 the views per call). Every read goes through the
// one pipeline (request.ts): one path builder, one filter builder, cache-first, the cross-process
// limiter, in-call drift, the credential rules. The league id comes from config only (plan 02 §5);
// a LeagueRef naming another league is a programming error. Every settings answer is recorded in
// store.sqlite's league_settings (plan 08 §9), which raises `settings_changed` when it changed the
// league-season's newest settings (Stage C, league-settings-changed-never-raised); cached settings are
// refetched before their TTL when a later league answer shows the standings or a waiver run moved,
// when the scoring golden found a league-wide mismatch after they were fetched (the store's open
// `scoring_mismatch` check of status `fail`, plan 08 §6 step 3(d)), or when `invalidateSettings` was
// asked (plan 01 §5.2, plan 08 §9). A week past its correction window is
// cached immutable (plan 01 §5.4). Read-only: no write method exists (league_settings and the cache's
// marks are the store's own bookkeeping, never a write to ESPN).
// PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; owner decision D11): FantasyPlatformWrites
// (src/providers/platform.ts) is not implemented here and nothing in this file sends to the write host.
import { CORRECTIONS_WINDOW_MS, type TtlContext } from "../../config/freshness.js";
import { SEASON_RENEWAL_TEXT, seasonMayAwaitRenewal, type Config } from "../../config/schema.js";
import {
  BOARD_PROBE_VIEW,
  boardControlDiscriminates,
  planDefinitiveProbe,
  probeVerdict,
  type ProbePlan,
} from "../../auth/probe.js";
import type { CredentialAuthority, CredentialObserver } from "../../auth/types.js";
import type { Clock } from "../../domain/clock.js";
import type {
  BoxScoreMatchup,
  CheckRow,
  League,
  LeagueRef,
  LeagueRules,
  LeagueSettingsRepository,
  LiveMatchup,
  Matchup,
  NativeProjection,
  OwnTeamResolution,
  PlatformPlayer,
  PlatformStatLine,
  PlayerOutlook,
  PlayerRef,
  PositionalRating,
  ProGame,
  ProSchedule,
  ProTeam,
  ProjectionHorizon,
  Roster,
  RosterSlots,
  Stamped,
  Standings,
  TeamRef,
  Transaction,
  Week,
} from "../../domain/league/types.js";
import type { ScoringSettings } from "../../domain/scoring/types.js";
import { scoringRefusal, settingsDriftPath } from "../../drift/state.js";
import type { DriftObservations } from "../../drift/types.js";
import type {
  CredentialStateRepository,
  CredentialStateRow,
  DriftStateRepository,
  EspnCacheEntry,
  EspnCacheRepository,
  LimiterRepository,
  RequestOrigin,
} from "../../store/types.js";
import {
  createUpstreamBudget,
  espnCapabilities,
  isUpstreamBudgetExhausted,
  WRITES_SEAM_MARKER,
  type CredentialProbeResult,
  type FantasyPlatform,
  type Page,
  type PageOf,
  type PlatformCapabilities,
  type PlayerQuery,
  type ReadOptions,
  type StatsQuery,
  type TransportStatus,
  type TxnQuery,
  type UpstreamBudget,
} from "../platform.js";
import { EspnCredentialError } from "./auth-gate.js";
import {
  cachedBoardControl,
  cachedPublicity,
  cachedSettingsMarks,
  leagueWideMismatchAfter,
  settingsOutdated,
  statusInstantsOf,
  type KeptFlag,
  type SettingsMarksStore,
} from "./cache.js";
import { EspnDriftError, EspnUpstreamError, isEspnUpstreamError } from "./errors.js";
import {
  boardProbeFilter,
  playerFilter,
  scheduleFilter,
  sortTerms,
  transactionsFilter,
  type PlayerFilterSpec,
} from "./filter.js";
import { slotIdsForName } from "./ids.js";
import type { Sleep } from "./limiter.js";
import {
  byeWeeksOf,
  identityFromNav,
  isCommissioner,
  matchupPeriodsForWeek,
  myTeamId,
  nativeProjectionOf,
  newCounts,
  normalizeBoxScores,
  normalizeLeague,
  normalizeLeagueRules,
  normalizeLiveMatchups,
  normalizeMatchups,
  normalizePlayer,
  normalizePositionalRatings,
  normalizeProSchedule,
  normalizeRosterSlots,
  normalizeRosters,
  normalizeStandings,
  normalizeStatLine,
  normalizeTransaction,
  outlookOf,
  scoringInputOf,
  type LeagueIdentity,
  type NormalizeCounts,
  type PlayerContext,
} from "./normalize.js";
import {
  communicationTarget,
  leagueTarget,
  primaryView,
  readHost,
  seasonPlayersTarget,
  seasonTarget,
  type EspnTarget,
} from "./path.js";
import {
  EspnProviderError,
  EspnRequester,
  SchemaSignals,
  type ProviderLog,
  type ReadResult,
  type ReadSpec,
} from "./request.js";
import type { FetchLike } from "./transport.js";
import {
  FILTER_IDS_MAX,
  HEADER_PLAYER_COUNT,
  HEADER_TRANSACTION_COUNT,
  LEAGUE_VIEWS,
  type EspnView,
  type LeagueView,
  type ScoringSettingsTranslator,
} from "./types.js";
import {
  absentAsEmpty,
  konaPlayerInfoSchema,
  konaPlayercardSchema,
  mBoxscoreSchema,
  mMatchupSchema,
  mMatchupScoreSchema,
  mNavSchema,
  mPendingTransactionsSchema,
  mPositionalRatingsSchema,
  mRosterSchema,
  mSettingsSchema,
  mStandingsSchema,
  mTeamSchema,
  mTransactions2Schema,
  parseView,
  playersWlSchema,
  proTeamSchedulesSchema,
  type WireBoxscoreBody,
  type WireKonaBody,
  type WireMatchupBody,
  type WireMatchupScoreBody,
  type WireNavBody,
  type WirePlayercardBody,
  type WirePlayersWlBody,
  type WirePositionalRatingsBody,
  type WireProScheduleBody,
  type WireRosterBody,
  type WireSettingsBody,
  type WireTeamBody,
} from "./views/index.js";
import type { z } from "zod/v4";

/** The provider declares the write seam and implements none of it (a test greps for the marker). */
export const ESPN_PROVIDER_WRITES = WRITES_SEAM_MARKER;

/** `kona_playercard`'s `filterStatsForTopScoringPeriodIds.value` (the recorded request's; 17 periods). */
export const PLAYERCARD_TOP_PERIODS = 17;
/** ≤ 25 ids per `kona_playercard` request (plan 07 B2; plan 02 §5). */
export const PLAYERCARD_IDS_MAX = 25;
/**
 * How long one season's pro schedule (its bye map, its weeks' final instants) is reused (ms):
 * reading the pro-schedule dataset costs ≈ 10 ms of main loop (the TTL context memoises it for the
 * same reason — plan 10 A16a); byes and finals do not move within a minute, and a dataset loaded
 * meanwhile is seen within one.
 */
export const BYE_WEEKS_MEMO_MS = 60_000;

/**
 * Whether no game of a season before the configured one can still change, by the calendar: from
 * March 1 of the next year — after its last fantasy week (early January) and the Super Bowl, each
 * with its 7-day correction window (research 04 §B.1.7). The bound a previous season's answers are
 * final from when its pro schedule is not loaded (`EspnProvider.finalFrom`).
 */
export function previousSeasonFinalFrom(season: number): number {
  return Date.UTC(season + 1, 2, 1);
}

/**
 * The instant from which every game of `weeks` (all the season's when null) is final and past its
 * 7-day correction window (plan 01 §5.4; research 04 §B.1.7: the week's last kickoff + 7 days — the
 * rule `meta.corrections_window_open` uses, config's CORRECTIONS_WINDOW_MS), by a season's pro-schedule
 * games: the latest close among them; null while any week is unknown, open or not final (no games,
 * a TBD kickoff, a game without official stats). Pure.
 */
export function weeksFinalFrom(
  games: readonly ProGame[],
  weeks: readonly number[] | null,
): number | null {
  const ws = weeks ?? [...new Set(games.map((g) => g.week))];
  if (ws.length === 0) return null;
  let latest = Number.NEGATIVE_INFINITY;
  for (const w of ws) {
    let last = Number.NEGATIVE_INFINITY;
    let any = false;
    for (const g of games) {
      if (g.week !== w) continue;
      any = true;
      const k = g.start_time_tbd || g.kickoff === null ? Number.NaN : Date.parse(g.kickoff);
      if (!Number.isFinite(k) || !g.stats_official) return null;
      if (k > last) last = k;
    }
    if (!any) return null;
    latest = Math.max(latest, last + CORRECTIONS_WINDOW_MS);
  }
  return latest;
}

/**
 * The scoring periods an answer about `week` covers: every week of the matchup period(s) holding it
 * (a playoff matchup can span two — its totals move until the last of them is final), `[week]` when
 * no matchup period names it; null when the settings are unknown (nothing is ever final then).
 */
export function coveredWeeks(settings: WireSettingsBody | null, week: number): number[] | null {
  if (settings === null) return null;
  const periods = matchupPeriodsForWeek(settings, week);
  if (periods.length === 0) return [week];
  const all = settings.settings.scheduleSettings.matchupPeriods ?? {};
  const out = new Set<number>([week]);
  for (const p of periods) for (const w of all[String(p)] ?? []) out.add(w);
  return [...out].sort((a, b) => a - b);
}

/**
 * The store's pro-schedule dataset as the provider reads it — structurally src/store's
 * `datasets.proSchedule` (the analytics `ProScheduleReader`), so a composition root wires
 * `proSchedule: store.datasets.proSchedule` as is. A season the dataset does not hold reads as no
 * teams.
 */
export interface ProScheduleDataset {
  teams(season: number): { readonly rows: readonly ProTeam[] };
  games(season: number, weeks: null): { readonly rows: readonly ProGame[] };
}

/** What the provider needs, injected (no ambient state; tests inject every port). */
export interface EspnProviderDeps {
  readonly config: Pick<
    Config,
    "leagueId" | "season" | "teamId" | "espnReadHost" | "fixtureRecord"
  >;
  readonly fetch: FetchLike;
  /** The Cookie-header port (src/auth implements it); null = keyless only. */
  readonly credentials: CredentialAuthority | null;
  readonly repos: {
    readonly limiter: LimiterRepository;
    readonly cache: EspnCacheRepository;
    readonly driftState: DriftStateRepository;
    /**
     * store.sqlite's `credential_state` row, READ only (never the secret): the definitive probe's
     * plan reads setup's board control and the rejected view from it (plan 02 §2.1; R3 nit (c)).
     * Absent: the probe plans from what it can learn itself.
     */
    readonly credentialState?: Pick<CredentialStateRepository, "get">;
    /**
     * store.sqlite's `league_settings` (plan 08 §9: the normalised settings persisted by
     * settings_hash, never pruned — the recommendation log's referents): each settings answer is
     * recorded once per parsed body, and the store raises `settings_changed` in the same write when
     * it changed the league-season's newest settings (plan 03 §5 #22; T-08). Its open checks are
     * READ for the scoring golden's league-wide verdict, which outdates the cached settings (plan 08
     * §6 step 3(d); cache.ts leagueWideMismatchAfter). Both composition roots pass `store.repos`, so
     * both wire it; absent, nothing is recorded and no verdict is read (a unit test's own ports).
     */
    readonly leagueSettings?: Pick<LeagueSettingsRepository, "put" | "openChecks">;
  };
  readonly clock: Clock;
  /** The scoring module's settings translator (plan 08 §1). */
  readonly scoring: ScoringSettingsTranslator;
  /** Server or job (the job fleet's daily caps bind job rows only). Default `server`. */
  readonly origin?: RequestOrigin;
  /** Who ordinary requests record observations as. Default `server`. */
  readonly observer?: CredentialObserver;
  /** Who `probeCredential` records as. Default `check_auth`. */
  readonly probeObserver?: CredentialObserver;
  /** The drift manifest's views (enum + additive checks); absent = required keys only. */
  readonly observations?: DriftObservations;
  /** The game-window / game-day / season context for TTLs (from the pro schedule dataset). */
  readonly ttlContext?: () => TtlContext;
  /**
   * Whether a period is provisional (`statsOfficial: false` anywhere — research 04 §B.1.6), from the
   * pro schedule dataset when wired; default: the current season's latest scoring period and later.
   */
  readonly periodProvisional?: (season: number, week: number) => boolean | null;
  /**
   * The store's pro-schedule dataset: every PlatformPlayer's `bye_week` comes from it, by the rule
   * `espn_get_roster` applies (plan 07 A4/B1/C2 `bye_week`; the weekly-value consumers — E4–E7,
   * E11 — zero a player's bye week from it). Nothing else supplies it, so every composition root
   * must pass `proSchedule: store.datasets.proSchedule` to createEspnProvider. Not wired, a season
   * it does not hold, or a read that throws → `bye_week` null, said by the field; never an extra
   * ESPN request.
   */
  readonly proSchedule?: ProScheduleDataset;
  readonly sleep?: Sleep;
  readonly random?: () => number;
  readonly log?: ProviderLog;
  readonly attemptTimeoutMs?: number;
  /**
   * Whether certificate verification is off process-wide (request.ts RequestDeps; default Node's
   * NODE_TLS_REJECT_UNAUTHORIZED rule, read at each request). Only fixture mode overrides it.
   */
  readonly tlsVerificationDisabled?: () => boolean;
}

interface SettingsRead {
  readonly settings: WireSettingsBody;
  /**
   * The identity part; null on a previous season's read (`mSettings` alone — `settingsRead`), where
   * every caller degrades to no identity.
   */
  readonly nav: WireNavBody | null;
}

/** Parses one view's part of a body or throws the drift signals (request.ts records them). */
function must<T>(view: EspnView, schema: z.ZodType<T>, body: unknown): T {
  const r = parseView(view, schema, body);
  if (!r.ok) throw new SchemaSignals(r.signals);
  return r.value;
}

// One parse function per wire read (stable identities: the pipeline reuses a parse when equal).
const parseSettings = (b: unknown): SettingsRead => ({
  settings: must("mSettings", mSettingsSchema, b),
  nav: must("mNav", mNavSchema, b),
});
const parseSettingsAlone = (b: unknown): SettingsRead => ({
  settings: must("mSettings", mSettingsSchema, b),
  nav: null,
});
/** A league identity, or null for a read that carried none (a previous season's `mSettings` alone). */
const identityOf = (nav: WireNavBody | null): LeagueIdentity | null =>
  nav === null ? null : identityFromNav(nav);
const parseRoster = (b: unknown): WireRosterBody => must("mRoster", mRosterSchema, b);
const parseTeam = (b: unknown): WireTeamBody => {
  must("mStandings", mStandingsSchema, b);
  return must("mTeam", mTeamSchema, b);
};
const parseMatchup = (b: unknown): WireMatchupBody => must("mMatchup", mMatchupSchema, b);
const parseScore = (b: unknown): WireMatchupScoreBody =>
  must("mMatchupScore", mMatchupScoreSchema, b);
const parseBox = (b: unknown): WireBoxscoreBody => must("mBoxscore", mBoxscoreSchema, b);
const parseKona = (b: unknown): WireKonaBody => must("kona_player_info", konaPlayerInfoSchema, b);
const parseCard = (b: unknown): WirePlayercardBody =>
  must("kona_playercard", konaPlayercardSchema, b);
const parseRatings = (b: unknown): WirePositionalRatingsBody =>
  must("mPositionalRatings", mPositionalRatingsSchema, b);
const parsePro = (b: unknown): WireProScheduleBody =>
  must("proTeamSchedules_wl", proTeamSchedulesSchema, b);
const parsePlayersWl = (b: unknown): WirePlayersWlBody => must("players_wl", playersWlSchema, b);
const parseTxns = (b: unknown): readonly unknown[] =>
  must("mTransactions2", mTransactions2Schema, b).transactions;
/**
 * The pending list; absent on an answer to the recognised view, it means nothing is pending
 * (views `absentAsEmpty`, ABSENT_MEANS_EMPTY) — the in-call check excused exactly that case.
 */
const parsePending = (b: unknown): readonly unknown[] =>
  must("mPendingTransactions", mPendingTransactionsSchema, absentAsEmpty("mPendingTransactions", b))
    .pendingTransactions;

/** The budget id of a probe run without a caller's budget (`eff check-auth`, doctor, the daily job). */
const PROBE_BUDGET_ID = "credential-probe";

/**
 * A public league's probe plan: src/auth/probe.ts `planDefinitiveProbe` over the credential_state
 * row, its board control taken from setup's row or — when setup recorded none — from what this
 * provider learned and kept (`known`; null = never learned, so the plan cannot discriminate yet).
 */
function publicProbePlan(row: CredentialStateRow | null, known: boolean | null): ProbePlan {
  if (row === null) return { kind: "board", view: BOARD_PROBE_VIEW, discriminates: known === true };
  return planDefinitiveProbe({
    leaguePublic: true,
    row: { ...row, board_probe_discriminates: known },
  });
}

/**
 * A probe step's failure as the probe's answer: the call budget's own signal (it carries no code)
 * becomes ESPN_UPSTREAM_UNAVAILABLE — the probe's ≤ 20 s deadline passed, or its three requests were
 * spent — so every caller (the tool, `eff check-auth`, doctor, the daily job) reads a coded failure.
 */
function probeFailure(e: unknown, view: EspnView): unknown {
  if (!isUpstreamBudgetExhausted(e)) return e;
  return e.missing.reason === "deadline"
    ? new EspnUpstreamError("timeout", { view, reason: "call_deadline" })
    : new EspnUpstreamError("client_error", { view, reason: "call_budget" });
}

/** Whether a keyless read was refused (401/403 — ESPN's typed answer, or an edge's block page). */
function refusedAnonymously(e: unknown): boolean {
  return isEspnUpstreamError(e) && (e.kind === "requires_cookies" || e.kind === "edge_blocked");
}

/** A non-negative integer header (`x-fantasy-filter-*-count`), or null. */
function countHeader(h: Readonly<Record<string, string>>, name: string): number | null {
  const v = h[name];
  return v !== undefined && /^\s*\d{1,9}\s*$/.test(v) ? Number(v) : null;
}

/** The ESPN implementation of the read seam. */
export class EspnProvider implements FantasyPlatform {
  readonly id = "espn" as const;
  private readonly deps: EspnProviderDeps;
  private readonly req: EspnRequester;
  private readonly host: string;
  /** Previous seasons fixture mode holds no settings recording for (settingsRead): the error, kept. */
  private readonly settingsMissing = new Map<number, Error>();
  /** The parsed settings answers already recorded (a cache hit re-reads the same frozen parse). */
  private readonly settingsRecorded = new WeakSet<SettingsRead>();
  /**
   * Each season's pro schedule as the wired dataset held it (null: none loaded), its bye map, and
   * when it was read (`scheduleOf`).
   */
  private readonly scheduleMemo = new Map<
    number,
    {
      readonly at: number;
      readonly games: readonly ProGame[];
      readonly byes: ReadonlyMap<number, number> | null;
    }
  >();
  /**
   * The games of a cached `proTeamSchedules_wl` answer, by its parsed body (the requester memoises
   * and freezes the parse while the entry is unchanged, so one body normalises once).
   */
  private readonly cachedViewGames = new WeakMap<WireProScheduleBody, readonly ProGame[]>();

  constructor(deps: EspnProviderDeps) {
    this.deps = deps;
    this.host = readHost(deps.config.espnReadHost);
    this.req = new EspnRequester({
      fetch: deps.fetch,
      clock: deps.clock,
      limiter: deps.repos.limiter,
      cache: deps.repos.cache,
      driftState: deps.repos.driftState,
      credentials: deps.credentials,
      host: this.host,
      origin: deps.origin ?? "server",
      observer: deps.observer ?? "server",
      recordRawBodies: deps.config.fixtureRecord,
      ...(deps.observations === undefined ? {} : { observations: deps.observations }),
      ...(deps.ttlContext === undefined ? {} : { ttlContext: deps.ttlContext }),
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
      ...(deps.random === undefined ? {} : { random: deps.random }),
      ...(deps.log === undefined ? {} : { log: deps.log }),
      ...(deps.attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs: deps.attemptTimeoutMs }),
      ...(deps.tlsVerificationDisabled === undefined
        ? {}
        : { tlsVerificationDisabled: deps.tlsVerificationDisabled }),
      // the league's publicity outlives the process: a CLI probe never re-learns it anonymously
      publicity: cachedPublicity(deps.repos.cache, deps.config.leagueId, deps.clock),
    });
  }

  // --- guards and shared reads -----------------------------------------------------------------

  /** The ref must be the configured league (plan 02 §5: no league id is ever a free argument). */
  private checkRef(ref: LeagueRef): void {
    if (
      (ref.platform as string) !== "espn" ||
      ref.league_id !== this.deps.config.leagueId ||
      !Number.isInteger(ref.season)
    )
      throw new EspnProviderError("INTERNAL", "league_ref_not_configured");
  }

  /**
   * A league 404 on a season that may await the league's renewal (config `seasonMayAwaitRenewal`:
   * the configured season, not a past one, before its October 1) is that state, named — the same
   * code and outcome, tagged `season_not_renewed` with config's fixed SEASON_RENEWAL_TEXT message
   * and hint, which src/mcp/errors.ts shows (Stage C finding league-rollover-not-found-misdiagnosed).
   * Any other failure, or a past season's 404, is returned unchanged. Idempotent.
   */
  private renewalAware(season: number, e: unknown): unknown {
    if (!isEspnUpstreamError(e) || e.kind !== "league_not_found") return e;
    if (e.effDetails.reason === SEASON_RENEWAL_TEXT.reason) return e;
    if (!seasonMayAwaitRenewal(this.deps.config, this.deps.clock.nowMs(), season)) return e;
    return new EspnUpstreamError(
      "league_not_found",
      {
        ...e.effDetails,
        reason: SEASON_RENEWAL_TEXT.reason,
        message: SEASON_RENEWAL_TEXT.message,
        hint: SEASON_RENEWAL_TEXT.hint,
      },
      { cause: e },
    );
  }

  /** Every read: the one pipeline (request.ts), its league 404 read for the renewal state. */
  private async read<T>(spec: ReadSpec<T>, opts?: ReadOptions): Promise<ReadResult<T>> {
    try {
      return await this.req.read(spec, opts);
    } catch (e) {
      throw this.renewalAware(spec.target.season, e);
    }
  }

  private league(
    ref: LeagueRef,
    views: readonly LeagueView[],
    sp: number | null = null,
  ): EspnTarget {
    return leagueTarget({
      host: this.host,
      season: ref.season,
      leagueId: ref.league_id,
      views,
      scoringPeriodId: sp,
    });
  }

  /**
   * `season` from the wired pro-schedule dataset (memoised BYE_WEEKS_MEMO_MS per season): its games
   * and its pro-team id → bye week map, or null when none is wired. A season the dataset holds no
   * teams for, or a throwing read, is no games and no byes (memoised like any answer).
   */
  private scheduleOf(season: number): {
    readonly games: readonly ProGame[];
    readonly byes: ReadonlyMap<number, number> | null;
  } | null {
    const source = this.deps.proSchedule;
    if (source === undefined) return null;
    const now = this.deps.clock.nowMs();
    const hit = this.scheduleMemo.get(season);
    if (hit !== undefined && now >= hit.at && now - hit.at < BYE_WEEKS_MEMO_MS) return hit;
    let games: readonly ProGame[] = [];
    let byes: ReadonlyMap<number, number> | null = null;
    try {
      const teams = source.teams(season).rows;
      if (teams.length > 0) {
        const schedule: ProSchedule = { season, teams, games: source.games(season, null).rows };
        games = schedule.games;
        byes = byeWeeksOf(schedule);
      }
    } catch {
      games = [];
      byes = null;
    }
    const memo = { at: now, games, byes };
    this.scheduleMemo.set(season, memo);
    return memo;
  }

  /**
   * Pro-team id → bye week for `season` from the wired pro-schedule dataset, or undefined when none
   * is wired or the dataset holds no teams for the season (`scheduleOf`).
   */
  private byeWeeks(season: number): ReadonlyMap<number, number> | undefined {
    return this.scheduleOf(season)?.byes ?? undefined;
  }

  /**
   * The games `finalFrom` judges a season by: the wired dataset's (`scheduleOf`), else the
   * provider's own cached `proTeamSchedules_wl` answer whatever its age (request.ts `cachedValue` —
   * never a request). The tools read the schedule the same way (src/mcp `scheduleOf`: the dataset,
   * else the keyless view), so a server whose dataset was never loaded still knows a week is closed.
   * An older copy can only make a week final later, never sooner: a game's official stats never
   * revert, and a game not yet official in it is not final.
   */
  private async finalityGames(season: number): Promise<readonly ProGame[]> {
    const fromDataset = this.scheduleOf(season)?.games ?? [];
    if (fromDataset.length > 0) return fromDataset;
    try {
      const body = await this.req.cachedValue({
        target: seasonTarget({ host: this.host, season }),
        filter: null,
        leagueId: null,
        cookies: "never",
        parse: parsePro,
      });
      if (body === null) return [];
      let games = this.cachedViewGames.get(body);
      if (games === undefined) {
        games = normalizeProSchedule(body, season).games;
        this.cachedViewGames.set(body, games);
      }
      return games;
    } catch {
      return [];
    }
  }

  /**
   * The instant from which an answer about `weeks` of `season` (all its weeks when null) is final —
   * past every covered week's correction window, so cached immutable (request.ts `finalFromMs`;
   * plan 01 §5.4; Stage C finding cache-final-weeks-not-immutable) — by the season's pro schedule
   * (`finalityGames`, `weeksFinalFrom`); a season before the configured one is final from
   * `previousSeasonFinalFrom` at the latest. Null (never final) for the configured season while a
   * week is open, its schedule not known or unknown, and for any later season. Never an ESPN request.
   */
  private async finalFrom(season: number, weeks: readonly number[] | null): Promise<number | null> {
    const bound = season < this.deps.config.season ? previousSeasonFinalFrom(season) : null;
    const games = await this.finalityGames(season);
    const fromSchedule = games.length === 0 ? null : weeksFinalFrom(games, weeks);
    if (fromSchedule === null) return bound;
    return bound === null ? fromSchedule : Math.min(fromSchedule, bound);
  }

  /** The player context of `season`/`week`, with that season's byes when known. */
  private playerContext(season: number, week: Week | null): PlayerContext {
    const byeWeeks = this.byeWeeks(season);
    return byeWeeks === undefined ? { season, week } : { season, week, byeWeeks };
  }

  private counted(view: EspnView, counts: NormalizeCounts): void {
    if (counts.stat_entries_failed + counts.rows_dropped + counts.transactions_skipped > 0)
      this.deps.log?.warn("espn.normalize.dropped", { view, ...counts });
  }

  private provisional(season: number, week: number, latest: number | null): boolean {
    const wired = this.deps.periodProvisional?.(season, week);
    if (typeof wired === "boolean") return wired;
    if (season !== this.deps.config.season) return false;
    return latest === null ? true : week >= latest;
  }

  /** A league-season's settings invalidation marks (cache.ts cachedSettingsMarks). */
  private settingsMarks(season: number): SettingsMarksStore {
    return cachedSettingsMarks(
      this.deps.repos.cache,
      this.deps.config.leagueId,
      season,
      this.deps.clock,
    );
  }

  /**
   * Whether a cached settings answer, fresh by its 24 h TTL, is outdated (plan 01 §5.2 "League
   * settings" row; plan 08 §9 — Stage C finding cache-settings-invalidation-triggers-missing: only the
   * TTL existed, so a commissioner's edit stayed unseen for up to a day). It is outdated when any of
   * these happened after it was fetched:
   * - a later league answer showed `status.standingsUpdateDate` or `waiverLastExecutionDate` newer
   *   than the cached settings carry (request.ts records every answer's instants);
   * - the scoring golden found a league-wide mismatch (the E6 > 10 % rule, plan 08 §6 step 3(d)): an
   *   open `scoring_mismatch` check of status `fail` (`leagueWideMismatchAfter`), for the configured
   *   season only, the one the nightly golden checks (a check names no season);
   * - the settings were invalidated (`invalidateSettings`).
   * Then they are refetched, re-normalised and recorded, so a changed hash raises `settings_changed`
   * and every engine re-scores. While ESPN is down, the cached answer is served degraded.
   */
  private settingsOutdated(season: number, value: SettingsRead, entry: EspnCacheEntry): boolean {
    const fetchedAtMs = Date.parse(entry.fetched_at);
    if (
      settingsOutdated(
        this.settingsMarks(season).load(),
        statusInstantsOf(value.settings),
        fetchedAtMs,
      )
    )
      return true;
    return (
      season === this.deps.config.season && leagueWideMismatchAfter(this.openChecks(), fetchedAtMs)
    );
  }

  /**
   * The store's open health checks, read for the scoring golden's verdict (`settingsOutdated`).
   * Best effort: with no store wired, or a store that cannot be read, there are none — the verdict is
   * read again on the next settings read, and a read never fails over it.
   */
  private openChecks(): readonly CheckRow[] {
    const repo = this.deps.repos.leagueSettings;
    if (repo === undefined) return [];
    try {
      return repo.openChecks();
    } catch {
      return [];
    }
  }

  /**
   * The settings a week's matchup periods and coverage are read from (`coveredWeeks`): the call's
   * own, else the cached answer whatever its age (request.ts `cachedValue` — a league's matchup
   * periods do not move with the answer's freshness), so a final week stays immutable, and is asked
   * under the same key, through an outage that outlasts the settings' 7-day hard limit. Null when
   * no settings answer was ever cached. Never a request.
   */
  private async coverageSettings(
    ref: LeagueRef,
    known: WireSettingsBody | null,
  ): Promise<WireSettingsBody | null> {
    if (known !== null) return known;
    const previous = ref.season < this.deps.config.season;
    try {
      const cached = await this.req.cachedValue({
        target: this.league(ref, previous ? ["mSettings"] : ["mSettings", "mNav"]),
        filter: null,
        leagueId: ref.league_id,
        cookies: "never",
        parse: previous ? parseSettingsAlone : parseSettings,
      });
      return cached?.settings ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Marks the league-season's cached settings outdated from now, in every process
   * (FantasyPlatform.invalidateSettings). It serves plan 08 §6 step 3(d), where a golden mismatch
   * above 10 % marks the settings cache dirty (a golden computed in process, as `espn_get_box_score`
   * computes it; the nightly roster snapshot's kept verdict outdates them by itself), and plan 08 §9
   * `eff refresh espn:settings`. The next settings read of any process asks ESPN again. While ESPN
   * cannot answer, every read keeps asking (the breaker and the call budget permitting) and serves
   * the cached answer degraded. No request is made here. Read-only toward ESPN: the marks are the
   * provider's own cache bookkeeping.
   */
  invalidateSettings(ref: LeagueRef): void {
    this.checkRef(ref);
    this.settingsMarks(ref.season).invalidate(this.deps.clock.nowMs());
  }

  private async settingsRead(
    ref: LeagueRef,
    opts?: ReadOptions,
  ): Promise<ReadResult<SettingsRead>> {
    this.checkRef(ref);
    // rejected and publicity unknown: the one anonymous read that learns settings.isPublic
    const learning = this.req.cookies.needsPublicity();
    const read = (
      views: readonly LeagueView[],
      parse: (b: unknown) => SettingsRead,
    ): Promise<ReadResult<SettingsRead>> =>
      this.read(
        {
          target: this.league(ref, views),
          filter: null,
          leagueId: ref.league_id,
          cookies: learning ? "never" : "auto",
          parse,
          outdated: (value, entry) => this.settingsOutdated(ref.season, value, entry),
        },
        opts,
      );
    try {
      // a previous season reads mSettings alone (Stage C): a finished season's rules, scoring, slots
      // and bracket-edit flag are all any caller needs of it, and all its recorded history holds
      // (fixtures/espn/recorded/history); its identity is not read — every caller degrades to no
      // identity (my team from ESPN_TEAM_ID). One request either way, so A1's seeding evidence
      // (standings, schedule and settings of the previous season) fits the per-call budget
      if (ref.season < this.deps.config.season) {
        // fixture mode without a recording of that season: said once, never re-asked (a missing
        // recording never appears mid-process, and every identity read would otherwise re-send it)
        const missing = this.settingsMissing.get(ref.season);
        if (missing !== undefined) throw missing;
        try {
          return this.recordSettings(ref, await read(["mSettings"], parseSettingsAlone));
        } catch (e) {
          if (
            e instanceof Error &&
            (e as { effDetails?: { reason?: unknown } }).effDetails?.reason === "fixture_missing"
          )
            this.settingsMissing.set(ref.season, e);
          throw e;
        }
      }
      return this.recordSettings(ref, await read(["mSettings", "mNav"], parseSettings));
    } catch (e) {
      // a private league answered the anonymous read with 401: the credential is still the problem
      if (learning && (e as { effCode?: unknown } | null)?.effCode === "ESPN_REQUIRES_COOKIES")
        throw new EspnCredentialError("ESPN_AUTH_REJECTED", "short_circuit");
      throw e;
    }
  }

  /**
   * Records a settings answer in league_settings and returns it (plan 08 §9: re-normalised and
   * persisted by settings_hash; the store raises `settings_changed` in the same write when the
   * answer changed the league-season's newest settings — Stage C, league-settings-changed-never-
   * raised: nothing recorded them, so the check could never open). Once per parsed body: a cache hit
   * re-reads the same frozen parse, and a parse the memo dropped re-records a fetch the store already
   * holds without a write lock. Only an answer that passed mSettings' required keys and schema reaches
   * here (a drifted one throws in the pipeline), so what is recorded is the league's settings. Never at
   * the read's cost: a failure is logged and the next answer records again — the store compares with
   * its newest row, so a change is raised late, never lost.
   */
  private recordSettings(ref: LeagueRef, r: ReadResult<SettingsRead>): ReadResult<SettingsRead> {
    const repo = this.deps.repos.leagueSettings;
    if (repo === undefined || this.settingsRecorded.has(r.value)) return r;
    try {
      const body = r.value.settings;
      const scoring = this.deps.scoring(scoringInputOf(body));
      repo.put({
        league_id: ref.league_id,
        season: ref.season,
        settings_hash: scoring.settings_hash,
        scoring,
        slots: normalizeRosterSlots(body),
        rules: normalizeLeagueRules(body),
        fetched_at: r.stamp.fetched_at,
      });
      this.settingsRecorded.add(r.value);
    } catch (e) {
      // the error's class name only (StoreBusyError, RangeError, …), never its message
      this.deps.log?.warn("espn.settings.record_failed", {
        error: e instanceof Error ? e.name : "unknown",
      });
    }
    return r;
  }

  /** The ref check, then (rejected, publicity unknown) the one anonymous settings read. */
  private async prepare(ref: LeagueRef, opts?: ReadOptions): Promise<void> {
    this.checkRef(ref);
    if (this.req.cookies.needsPublicity())
      await this.settingsRead(ref, opts).catch(() => undefined);
  }

  /** The league identity (teams + owners) — best effort: a failure leaves names as `Team <id>`. */
  private async identity(
    ref: LeagueRef,
    opts?: ReadOptions,
  ): Promise<{
    identity: LeagueIdentity | null;
    settings: WireSettingsBody | null;
    myTeam: number | null;
  }> {
    try {
      const s = await this.settingsRead(ref, opts);
      const identity = identityOf(s.value.nav);
      if (identity === null)
        return { identity: null, settings: s.value.settings, myTeam: this.deps.config.teamId };
      const swid = await this.req.cookies.memberId().catch(() => null);
      return {
        identity,
        settings: s.value.settings,
        myTeam: myTeamId(identity, swid, this.deps.config.teamId),
      };
    } catch (e) {
      this.deps.log?.debug("espn.identity.unavailable", {
        code: (e as { effCode?: unknown } | null)?.effCode ?? "INTERNAL",
      });
      return { identity: null, settings: null, myTeam: this.deps.config.teamId };
    }
  }

  private stamped<T, U>(r: ReadResult<T>, value: U): Stamped<U> {
    return { value, stamp: r.stamp };
  }

  // --- the seam ----------------------------------------------------------------------------------

  async capabilities(): Promise<PlatformCapabilities> {
    const ref: LeagueRef = {
      platform: "espn",
      league_id: this.deps.config.leagueId,
      season: this.deps.config.season,
    };
    const rules = await this.getLeagueRules(ref);
    return espnCapabilities(rules.value.waiver_system, this.deps.clock.nowIso());
  }

  async getLeague(ref: LeagueRef, opts?: ReadOptions): Promise<Stamped<League>> {
    const r = await this.settingsRead(ref, opts);
    const identity = identityOf(r.value.nav);
    const swid = await this.req.cookies.memberId().catch(() => null);
    // no identity (a previous season): my team is the operator's ESPN_TEAM_ID, named Team <id>
    const mine =
      identity === null
        ? this.deps.config.teamId
        : myTeamId(identity, swid, this.deps.config.teamId);
    return this.stamped(
      r,
      normalizeLeague(r.value.settings, ref, identity, mine, isCommissioner(identity, swid)),
    );
  }

  async getScoringSettings(ref: LeagueRef, opts?: ReadOptions): Promise<Stamped<ScoringSettings>> {
    const r = await this.settingsRead(ref, opts);
    // the refusal names the mSettings key the row records missing (src/drift settingsDriftPath),
    // never a fixed stand-in, and ends with the drift: the next complete answer — a 200, or a 304
    // revalidating the cached body — clears it (Stage C finding drift-red-never-clears)
    const missing = settingsDriftPath(this.req.drift.current());
    if (missing !== null) throw new EspnDriftError("mSettings", missing);
    return this.stamped(r, this.deps.scoring(scoringInputOf(r.value.settings)));
  }

  async getRosterSlots(ref: LeagueRef, opts?: ReadOptions): Promise<Stamped<RosterSlots>> {
    const r = await this.settingsRead(ref, opts);
    return this.stamped(r, normalizeRosterSlots(r.value.settings));
  }

  async getLeagueRules(ref: LeagueRef, opts?: ReadOptions): Promise<Stamped<LeagueRules>> {
    const r = await this.settingsRead(ref, opts);
    return this.stamped(r, normalizeLeagueRules(r.value.settings));
  }

  async getRosters(
    ref: LeagueRef,
    week: Week,
    opts?: ReadOptions,
  ): Promise<Stamped<readonly Roster[]>> {
    await this.prepare(ref, opts);
    const id = await this.identity(ref, opts);
    const r = await this.read(
      {
        target: this.league(ref, ["mRoster"], week),
        filter: null,
        leagueId: ref.league_id,
        cookies: "auto",
        parse: parseRoster,
        provisional: (b) => this.provisional(ref.season, week, b.status.latestScoringPeriod),
      },
      opts,
    );
    const counts = newCounts();
    const rosters = normalizeRosters(
      r.value,
      ref,
      week,
      id.identity,
      id.myTeam,
      this.playerContext(ref.season, week),
      counts,
    );
    this.counted("mRoster", counts);
    return this.stamped(r, rosters);
  }

  async getRoster(team: TeamRef, week: Week, opts?: ReadOptions): Promise<Stamped<Roster>> {
    const all = await this.getRosters(team.league, week, opts);
    const one = all.value.find((x) => x.team.team_id === team.team_id);
    if (one === undefined) throw new EspnProviderError("NOT_FOUND", "team_not_in_league");
    return { value: one, stamp: all.stamp };
  }

  /** The pool filter for a C2 query (plan 07 C2): status, position → slot ids, the mapped sort, the page. */
  private poolFilter(q: PlayerQuery, page: Page, season: number): PlayerFilterSpec {
    if (q.sort === "name" && page.offset > 0)
      throw new EspnProviderError("VALIDATION", "name_sort_single_page");
    let slotIds: number[] | undefined;
    if (q.position !== null) {
      const ids = slotIdsForName(q.position);
      if (ids === null) throw new EspnProviderError("VALIDATION", "unknown_position");
      slotIds = ids;
    }
    const status =
      q.status === "ALL"
        ? undefined
        : q.status === "AVAILABLE"
          ? (["FREEAGENT", "WAIVERS"] as const)
          : [q.status];
    return {
      ...(status === undefined ? {} : { filterStatus: status }),
      ...(slotIds === undefined ? {} : { filterSlotIds: slotIds }),
      limit: page.limit,
      offset: page.offset,
      sorts: sortTerms(q.sort, season, q.week),
    };
  }

  async listPlayers(
    ref: LeagueRef,
    q: PlayerQuery,
    page: Page,
    opts?: ReadOptions,
  ): Promise<Stamped<PageOf<PlatformPlayer>>> {
    await this.prepare(ref, opts);
    const filter = playerFilter(this.poolFilter(q, page, ref.season), "league");
    const r = await this.read(
      {
        target: this.league(ref, ["kona_player_info"], q.week),
        filter,
        leagueId: ref.league_id,
        cookies: "auto",
        parse: parseKona,
      },
      opts,
    );
    const counts = newCounts();
    const ctx = this.playerContext(ref.season, q.week);
    let items = r.value.players
      .map((pe) => normalizePlayer(pe.player, pe, ctx, counts))
      .filter((p): p is PlatformPlayer => p !== null);
    if (q.sort === "name")
      items = [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const injuredFilter = q.injured !== null;
    if (injuredFilter) items = items.filter((p) => p.injured === q.injured);
    this.counted("kona_player_info", counts);
    const total = injuredFilter ? null : countHeader(r.headers, HEADER_PLAYER_COUNT);
    const returned = r.value.players.length;
    const hasMore = total !== null ? page.offset + returned < total : returned >= page.limit;
    return this.stamped(r, {
      items,
      limit: page.limit,
      offset: page.offset,
      count: items.length,
      total,
      has_more: hasMore && q.sort !== "name",
      next_offset: hasMore && q.sort !== "name" ? page.offset + page.limit : null,
    });
  }

  private checkIds(players: readonly PlayerRef[], max: number): number[] {
    if (players.length === 0 || players.length > max)
      throw new EspnProviderError("VALIDATION", "player_ids_count");
    return players.map((p) => p.id);
  }

  private konaById(ref: LeagueRef, ids: readonly number[], week: Week, opts?: ReadOptions) {
    return this.read(
      {
        target: this.league(ref, ["kona_player_info"], week),
        filter: playerFilter({ filterIds: ids }, "league"),
        leagueId: ref.league_id,
        cookies: "auto",
        parse: parseKona,
      },
      opts,
    );
  }

  async getPlayers(
    ref: LeagueRef,
    players: readonly PlayerRef[],
    week: Week,
    opts?: ReadOptions,
  ): Promise<Stamped<readonly PlatformPlayer[]>> {
    await this.prepare(ref, opts);
    const ids = this.checkIds(players, FILTER_IDS_MAX);
    const r = await this.konaById(ref, ids, week, opts);
    const counts = newCounts();
    const ctx = this.playerContext(ref.season, week);
    const byId = new Map<number, PlatformPlayer>();
    for (const pe of r.value.players) {
      const p = normalizePlayer(pe.player, pe, ctx, counts);
      if (p !== null) byId.set(p.ref.id, p);
    }
    this.counted("kona_player_info", counts);
    return this.stamped(
      r,
      ids.map((id) => byId.get(id)).filter((p): p is PlatformPlayer => p !== undefined),
    );
  }

  async getPlayerOutlooks(
    ref: LeagueRef,
    players: readonly PlayerRef[],
    weeks: readonly Week[],
    opts?: ReadOptions,
  ): Promise<Stamped<readonly (PlayerOutlook & { readonly player: PlayerRef })[]>> {
    await this.prepare(ref, opts);
    const ids = this.checkIds(players, FILTER_IDS_MAX);
    const week = weeks.length === 0 ? null : Math.max(...weeks);
    const r = await this.konaById(ref, ids, week ?? 0, opts);
    const out = r.value.players
      .filter((pe) => ids.includes(pe.player.id))
      .map((pe) => ({
        ...outlookOf(pe.player, weeks.length === 0 ? null : weeks),
        player: { platform: "espn" as const, id: pe.player.id },
      }));
    return this.stamped(r, out);
  }

  async getPlayerStats(
    ref: LeagueRef,
    players: readonly PlayerRef[],
    q: StatsQuery,
    opts?: ReadOptions,
  ): Promise<Stamped<readonly PlatformStatLine[]>> {
    await this.prepare(ref, opts);
    const ids = this.checkIds(players, PLAYERCARD_IDS_MAX);
    const season = ref.season;
    const filter = playerFilter(
      {
        filterIds: ids,
        filterStatsForTopScoringPeriodIds: {
          value: PLAYERCARD_TOP_PERIODS,
          additionalValue: [
            `00${String(season)}`,
            `10${String(season)}`,
            `00${String(season - 1)}`,
          ],
        },
      },
      "league",
    );
    const r = await this.read(
      {
        target: this.league(ref, ["kona_playercard"]),
        filter,
        leagueId: ref.league_id,
        cookies: "auto",
        parse: parseCard,
        provisional: () => q.type === "week" && this.provisional(season, q.week, null),
        // one card holds the season's every week and its projections: final only once the whole
        // season is (a previous season's card — plan 01 §5.2 "never for final weeks")
        finalFromMs: await this.finalFrom(season, null),
      },
      opts,
    );
    const counts = newCounts();
    const lines: PlatformStatLine[] = [];
    for (const pe of r.value.players) {
      const p = pe.player;
      for (const e of p.stats ?? []) {
        const keep =
          q.type === "week"
            ? e.seasonId === season && e.statSplitTypeId === 1 && e.scoringPeriodId === q.week
            : q.type === "season"
              ? e.seasonId === season && e.statSplitTypeId === 0
              : e.seasonId === season - 1 && e.statSourceId === 0;
        if (!keep) continue;
        const prov =
          q.type === "week" && e.statSourceId === 0 && this.provisional(season, q.week, null);
        const line = normalizeStatLine(e, p.id, prov, counts);
        if (line !== null) lines.push(line);
      }
    }
    this.counted("kona_playercard", counts);
    return this.stamped(r, lines);
  }

  async getMatchups(ref: LeagueRef, opts?: ReadOptions): Promise<Stamped<readonly Matchup[]>> {
    await this.prepare(ref, opts);
    const id = await this.identity(ref, opts);
    const r = await this.read(
      {
        target: this.league(ref, ["mMatchup"]),
        filter: null,
        leagueId: ref.league_id,
        cookies: "auto",
        parse: parseMatchup,
        // the season's whole schedule: final once every week of it is (a finished season)
        finalFromMs: await this.finalFrom(ref.season, null),
      },
      opts,
    );
    return this.stamped(r, normalizeMatchups(r.value, id.identity, id.myTeam));
  }

  async getLiveMatchups(
    ref: LeagueRef,
    week: Week,
    opts?: ReadOptions,
  ): Promise<Stamped<readonly LiveMatchup[]>> {
    await this.prepare(ref, opts);
    const id = await this.identity(ref, opts);
    const latest = id.settings?.status.latestScoringPeriod ?? null;
    const covered = coveredWeeks(await this.coverageSettings(ref, id.settings), week);
    const r = await this.read(
      {
        target: this.league(ref, ["mMatchupScore"], week),
        filter: null,
        leagueId: ref.league_id,
        cookies: "auto",
        parse: parseScore,
        provisional: () => this.provisional(ref.season, week, latest),
        // what this read uses is the week's matchup period: final once all its weeks are
        finalFromMs: covered === null ? null : await this.finalFrom(ref.season, covered),
      },
      opts,
    );
    return this.stamped(r, normalizeLiveMatchups(r.value, week, id.identity, id.myTeam));
  }

  async getBoxScores(
    ref: LeagueRef,
    week: Week,
    opts?: ReadOptions,
  ): Promise<Stamped<readonly BoxScoreMatchup[]>> {
    await this.prepare(ref, opts);
    const id = await this.identity(ref, opts);
    const settings = await this.coverageSettings(ref, id.settings);
    const periods = settings === null ? [week] : matchupPeriodsForWeek(settings, week);
    const covered = coveredWeeks(settings, week);
    const r = await this.read(
      {
        target: this.league(ref, ["mBoxscore"], week),
        filter: scheduleFilter(periods.length === 0 ? [week] : periods),
        leagueId: ref.league_id,
        cookies: "auto",
        parse: parseBox,
        provisional: (b) =>
          this.provisional(ref.season, week, b.status?.latestScoringPeriod ?? null),
        // a week past its correction window (with every week of its matchup period) never changes
        // again: its box scores are cached immutable (plan 01 §5.4)
        finalFromMs: covered === null ? null : await this.finalFrom(ref.season, covered),
      },
      opts,
    );
    const counts = newCounts();
    const prov = this.provisional(ref.season, week, r.value.status?.latestScoringPeriod ?? null);
    const box = normalizeBoxScores(
      r.value,
      week,
      ref.season,
      prov,
      id.identity,
      counts,
      this.byeWeeks(ref.season),
    );
    this.counted("mBoxscore", counts);
    return this.stamped(r, box);
  }

  async getNativeProjections(
    ref: LeagueRef,
    players: readonly PlayerRef[],
    horizon: ProjectionHorizon,
    week: Week,
    opts?: ReadOptions,
  ): Promise<Stamped<readonly NativeProjection[]>> {
    await this.prepare(ref, opts);
    const ids = this.checkIds(players, FILTER_IDS_MAX);
    const r = await this.read(
      {
        target: this.league(ref, ["kona_player_info"], week),
        filter: playerFilter({ filterIds: ids }, "league"),
        leagueId: ref.league_id,
        cookies: "auto",
        parse: parseKona,
        source: "espn:projection",
      },
      opts,
    );
    const out = r.value.players
      .map((pe) => nativeProjectionOf(pe.player, horizon, ref.season, week, r.stamp.as_of))
      .filter((p): p is NativeProjection => p !== null);
    return this.stamped(r, out);
  }

  async getStandings(ref: LeagueRef, opts?: ReadOptions): Promise<Stamped<Standings>> {
    await this.prepare(ref, opts);
    const id = await this.identity(ref, opts);
    const r = await this.read(
      {
        target: this.league(ref, ["mTeam", "mStandings"]),
        filter: null,
        leagueId: ref.league_id,
        cookies: "auto",
        parse: parseTeam,
      },
      opts,
    );
    let mine = id.myTeam;
    if (mine === null) {
      const swid = await this.req.cookies.memberId().catch(() => null);
      if (swid !== null) {
        const s = swid.toUpperCase();
        const hits = r.value.teams.filter((t) =>
          (t.owners ?? []).some((o) => o.toUpperCase() === s),
        );
        mine = hits.length === 1 ? (hits[0]?.id ?? null) : null;
      }
    }
    return this.stamped(r, normalizeStandings(r.value, id.settings, mine));
  }

  async listTransactions(
    ref: LeagueRef,
    q: TxnQuery,
    opts?: ReadOptions,
  ): Promise<Stamped<PageOf<Transaction>>> {
    await this.prepare(ref, opts);
    const id = await this.identity(ref, opts);
    const r = await this.read(
      {
        target: this.league(ref, ["mTransactions2"], q.week),
        filter: transactionsFilter(q.types),
        leagueId: ref.league_id,
        cookies: "required",
        parse: parseTxns,
      },
      opts,
    );
    const counts = newCounts();
    const since = q.since === null ? null : Date.parse(q.since);
    const all = r.value
      .map((t) => normalizeTransaction(t, id.identity, counts))
      .filter((t): t is Transaction => t !== null)
      .filter((t) => q.team_id === null || t.team_id === q.team_id)
      .filter((t) => {
        if (since === null || !Number.isFinite(since)) return true;
        const at = Date.parse(t.process_date ?? t.proposed_date ?? "");
        return Number.isFinite(at) && at >= since;
      })
      .sort((a, b) =>
        (b.process_date ?? b.proposed_date ?? "").localeCompare(
          a.process_date ?? a.proposed_date ?? "",
        ),
      );
    this.counted("mTransactions2", counts);
    const items = all.slice(0, q.count);
    return this.stamped(r, {
      items,
      limit: q.count,
      offset: 0,
      count: items.length,
      total:
        q.team_id === null && q.since === null
          ? countHeader(r.headers, HEADER_TRANSACTION_COUNT)
          : null,
      has_more: all.length > items.length,
      next_offset: all.length > items.length ? items.length : null,
    });
  }

  async listPendingTransactions(
    ref: LeagueRef,
    opts?: ReadOptions,
  ): Promise<Stamped<readonly Transaction[]>> {
    await this.prepare(ref, opts);
    const id = await this.identity(ref, opts);
    const r = await this.read(
      {
        target: this.league(ref, ["mPendingTransactions"]),
        filter: null,
        leagueId: ref.league_id,
        cookies: "required",
        parse: parsePending,
      },
      opts,
    );
    const counts = newCounts();
    const out = r.value
      .map((t) => normalizeTransaction(t, id.identity, counts))
      .filter((t): t is Transaction => t !== null);
    this.counted("mPendingTransactions", counts);
    return this.stamped(r, out);
  }

  async getPositionalRatings(
    ref: LeagueRef,
    week: Week,
    opts?: ReadOptions,
  ): Promise<Stamped<readonly PositionalRating[]>> {
    await this.prepare(ref, opts);
    const r = await this.read(
      {
        target: this.league(ref, ["mPositionalRatings"], week),
        filter: null,
        leagueId: ref.league_id,
        cookies: "auto",
        parse: parseRatings,
      },
      opts,
    );
    return this.stamped(r, normalizePositionalRatings(r.value));
  }

  async getProSchedule(season: number, opts?: ReadOptions): Promise<Stamped<ProSchedule>> {
    const r = await this.read(
      {
        target: seasonTarget({ host: this.host, season }),
        filter: null,
        leagueId: null,
        cookies: "never",
        parse: parsePro,
      },
      opts,
    );
    return this.stamped(r, normalizeProSchedule(r.value, season));
  }

  /**
   * The season player index (players_wl, keyless, root-level `filterActive`) — for the `espn:players`
   * dataset refresh and the C1 name index; not part of the seam (plan 07 C1 [A-5]).
   */
  async getSeasonPlayers(
    season: number,
    opts?: ReadOptions,
  ): Promise<Stamped<readonly PlatformPlayer[]>> {
    const r = await this.read(
      {
        target: seasonPlayersTarget({ host: this.host, season }),
        filter: playerFilter({ filterActive: true }, "root"),
        leagueId: null,
        cookies: "never",
        parse: parsePlayersWl,
      },
      opts,
    );
    const counts = newCounts();
    const ctx = this.playerContext(season, null);
    const out = r.value
      .map((p) => normalizePlayer(p, null, ctx, counts))
      .filter((p): p is PlatformPlayer => p !== null);
    this.counted("players_wl", counts);
    return this.stamped(r, out);
  }

  async resolveOwnTeam(ref: LeagueRef, opts?: ReadOptions): Promise<Stamped<OwnTeamResolution>> {
    const r = await this.settingsRead(ref, opts);
    const identity = identityOf(r.value.nav);
    const swid = await this.req.cookies.memberId().catch(() => null);
    if (swid === null) return this.stamped(r, { team_id: null, reason: "no_credential" });
    if (identity === null) return this.stamped(r, { team_id: null, reason: "no_match" });
    const s = swid.toUpperCase();
    const hits = [...identity.teams.values()].filter((t) =>
      t.owners.some((o) => o.toUpperCase() === s),
    );
    if (hits.length === 1)
      return this.stamped(r, { team_id: hits[0]?.team_id ?? null, reason: "resolved" });
    return this.stamped(r, { team_id: null, reason: hits.length === 0 ? "no_match" : "ambiguous" });
  }

  /**
   * The one explicit credential probe — plan 02 §2.1 "The definitive check", plan 06 §1.4, plan 07
   * G2 (ADV OBJ-14, OBJ-26; R3 nit (c); changelog R-5, K1) — inside ONE ≤ 20 s call budget (plan 01
   * §6 / ADV OBJ-20: every step's requests and retries, never more than the call's three):
   * - a PRIVATE league: one cookie-bearing `mSettings` (200 accepted / 401·403 rejected / 404 →
   *   ESPN_LEAGUE_NOT_FOUND);
   * - a PUBLIC league: src/auth/probe.ts `planDefinitiveProbe` over the credential_state row — the
   *   board probe (`kona_league_communication`, one topic, body discarded) when its anonymous
   *   control answered 401; after a rejection on a league whose board does not discriminate, the
   *   view whose 401 caused it (discriminating by construction), so Rejected → Validated stays
   *   reachable without a human; otherwise `accepted: null` (`board_not_discriminating`) and no
   *   cookie-bearing request. The control is setup's (`board_probe_discriminates`, cached with the
   *   league settings); a league without one learns it ONCE here and keeps it (cache.ts
   *   `cachedBoardControl`) — never re-sent before every probe (Stage C finding
   *   auth-probe-definitive-plan-unwired). `probe` names the family: `board` on a public league.
   * Publicity is learned ANONYMOUSLY when unknown (cache-first; a cookie-bearing 200 on a public
   * league would prove nothing — R-5): when it cannot be learned, no probe is judged and the read's
   * error is the answer. Never cached; exempt from the short-circuit only when the authority offers
   * probe access. Nothing stored (whatever the startup label said) → not_configured, zero requests.
   */
  async probeCredential(
    ref: LeagueRef,
    opts: { readonly budget?: UpstreamBudget } = {},
  ): Promise<CredentialProbeResult> {
    try {
      return await this.probeDefinitive(ref, opts);
    } catch (e) {
      // the probe's own 404 (mSettings or the board) on a season awaiting renewal is that state
      throw this.renewalAware(ref.season, e);
    }
  }

  /** `probeCredential`'s body (its doc above). */
  private async probeDefinitive(
    ref: LeagueRef,
    opts: { readonly budget?: UpstreamBudget },
  ): Promise<CredentialProbeResult> {
    this.checkRef(ref);
    const by = this.deps.probeObserver ?? "check_auth";
    const budget = opts.budget ?? createUpstreamBudget(PROBE_BUDGET_ID, this.deps.clock.nowMs());
    const checkedAt = (): string => this.deps.clock.nowIso();
    const result = (
      accepted: boolean | null,
      probe: "settings" | "board",
      status: number | null,
      reason: CredentialProbeResult["reason"],
      view: EspnView | null = null,
    ): CredentialProbeResult => ({
      accepted,
      probe,
      upstream_status: status,
      reason,
      checked_at: checkedAt(),
      ...(view === null ? {} : { view }),
    });
    // a label of "nothing stored" is not the store: a value `eff setup` stored while this process
    // ran (or items a wiped cache lost the row of) is loaded first, so it is probed and its
    // acceptance lands on a row that describes it (plan 02 §2.2; plan 03 §1.1 step 4 [A-3]); any
    // other label already sends the probe to the store (probeHeader)
    if (!this.req.cookies.configured()) await this.req.cookies.syncWithStore();
    const header = await this.req.cookies.probeHeader();
    if (header === null) return result(null, "settings", null, "not_configured");
    if (!header.ok)
      return header.reason === "rejected"
        ? result(false, "settings", null, null)
        : result(null, "settings", null, "not_configured");
    let isPublic = this.req.cookies.isPublic();
    if (isPublic === null) {
      // learn publicity ANONYMOUSLY (cache-first; one keyless request when cold): a cookie-bearing
      // 200 on a public league would prove nothing (plan 02 §2.1, R-5). A fresh answer is learned
      // (and kept) by the read itself; a cached or stale body's flag is used for this probe only.
      let failure: unknown = null;
      let flag: boolean | null = null;
      try {
        const s = await this.read(
          {
            target: this.league(ref, ["mSettings", "mNav"]),
            filter: null,
            leagueId: ref.league_id,
            cookies: "never",
            parse: parseSettings,
          },
          { budget },
        );
        const p = s.value.settings.isPublic;
        flag = typeof p === "boolean" ? p : null;
      } catch (e) {
        failure = e;
      }
      isPublic = this.req.cookies.isPublic() ?? flag;
      // still unknown: an anonymous REFUSAL (a keyless 401/403 — ESPN's own, or an edge's) means a
      // cookie-bearing 200 discriminates, as on a private league (the anonymous control's rule, ADV
      // OBJ-26); any other failure (an outage, a malformed answer, the deadline) leaves nothing to
      // judge a probe against — no probe is sent and the read's failure is the answer
      if (isPublic === null && failure !== null && !refusedAnonymously(failure))
        throw probeFailure(failure, "mSettings");
    }
    const probeOnce = (
      target: EspnTarget,
      filter: string | null,
      withCookie: boolean,
    ): Promise<number> =>
      this.req
        .probeSend(target, filter, withCookie ? header.header : null, budget)
        .catch((e: unknown) => {
          throw probeFailure(e, primaryView(target));
        });
    if (isPublic !== true) {
      const status = await probeOnce(this.league(ref, ["mSettings"]), null, true);
      if (status >= 200 && status <= 299) {
        await this.req.cookies.observeProbe("accepted", by, status, "mSettings");
        return result(true, "settings", status, null, "mSettings");
      }
      if (status === 401 || status === 403) {
        await this.req.cookies.observeProbe("rejected", by, status, "mSettings");
        return result(false, "settings", status, null, "mSettings");
      }
      if (status === 404)
        throw new EspnUpstreamError("league_not_found", {
          upstream_status: 404,
          view: "mSettings",
        });
      throw new EspnUpstreamError("server_error", { upstream_status: status, view: "mSettings" });
    }
    const board = communicationTarget({
      host: this.host,
      season: ref.season,
      leagueId: ref.league_id,
    });
    const row = this.credentialRow();
    const kept = this.boardControl(ref.season);
    let known = row?.board_probe_discriminates ?? kept.load();
    let plan = publicProbePlan(row, known);
    let controlStatus: number | null = null;
    if (plan.kind === "board" && known === null) {
      // no control was ever run for this league: once, ANONYMOUSLY (ADV OBJ-26), then kept
      controlStatus = await probeOnce(board, boardProbeFilter(), false);
      known = boardControlDiscriminates(controlStatus) === true;
      kept.save(known);
      plan = publicProbePlan(row, known);
    }
    if (!plan.discriminates)
      return result(null, "board", controlStatus, "board_not_discriminating");
    const probe = this.probeTarget(ref, plan, board);
    if (probe === null) return result(null, "board", controlStatus, "board_not_discriminating");
    const status = await probeOnce(probe.target, probe.filter, true);
    // a discriminating board answers valid cookies 200 or 404 (plan 02 §2.1): the board verdict reads
    // its 404 as an acceptance, also when the board is the rejected view itself
    const verdict = probeVerdict(
      probe.view === BOARD_PROBE_VIEW ? { ...plan, kind: "board" } : plan,
      status,
    );
    if (verdict.observation === "accepted" || verdict.observation === "rejected") {
      await this.req.cookies.observeProbe(verdict.observation, by, status, probe.view);
      return result(verdict.observation === "accepted", "board", status, null, probe.view);
    }
    if (verdict.observation === "league_not_found")
      throw new EspnUpstreamError("league_not_found", { upstream_status: 404, view: probe.view });
    throw new EspnUpstreamError("server_error", { upstream_status: status, view: probe.view });
  }

  /** This league's credential_state row, read only (null: none, another league's, unreadable). */
  private credentialRow(): CredentialStateRow | null {
    try {
      const row = this.deps.repos.credentialState?.get() ?? null;
      return row !== null && row.league_id === this.deps.config.leagueId ? row : null;
    } catch {
      return null;
    }
  }

  /** The kept board control of a season (cache.ts cachedBoardControl). */
  private boardControl(season: number): KeptFlag {
    return cachedBoardControl(
      this.deps.repos.cache,
      this.deps.config.leagueId,
      season,
      this.deps.clock,
    );
  }

  /**
   * The request a public-league probe plan sends: the board probe, or the view whose cookie-bearing
   * 401 caused the rejection (R3 nit (c)) with the smallest request that view answers — the pool
   * views one row (`limit` needs a sort); null when the recorded view is not one this provider
   * requests on the league (then nothing can discriminate here).
   */
  private probeTarget(
    ref: LeagueRef,
    plan: ProbePlan,
    board: EspnTarget,
  ): {
    readonly target: EspnTarget;
    readonly filter: string | null;
    readonly view: EspnView;
  } | null {
    if (plan.kind === "board" || plan.view === BOARD_PROBE_VIEW)
      return { target: board, filter: boardProbeFilter(), view: "kona_league_communication" };
    const view = (LEAGUE_VIEWS as readonly string[]).includes(plan.view)
      ? (plan.view as LeagueView)
      : null;
    if (view === null) return null;
    const filter =
      view === "kona_player_info" || view === "kona_playercard"
        ? playerFilter({ limit: 1, sorts: sortTerms("percOwned", ref.season, 1) }, "league")
        : null;
    return { target: this.league(ref, [view]), filter, view };
  }

  transportStatus(): TransportStatus {
    return { ...this.req.limiter.breaker.status(), etag_304_count: this.req.etag304Today() };
  }

  /** The drift lookup a scoring caller needs (T-14): `settings_drift` refuses to score. */
  scoringRefusal(): "settings_drift" | null {
    return scoringRefusal(this.req.drift.current());
  }
}
