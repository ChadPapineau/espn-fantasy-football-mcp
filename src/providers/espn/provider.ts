// provider.ts — EspnProvider, the FantasyPlatform read seam over ESPN's read host (plan 01 §9; plan
// 07 §3 what each P0 tool asks of it; plan 01 §5.6 the views per call). Every read goes through the
// one pipeline (request.ts): one path builder, one filter builder, cache-first, the cross-process
// limiter, in-call drift, the credential rules. The league id comes from config only (plan 02 §5);
// a LeagueRef naming another league is a programming error. Read-only: no write method exists.
// PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; owner decision D11): FantasyPlatformWrites
// (src/providers/platform.ts) is not implemented here and nothing in this file sends to the write host.
import type { TtlContext } from "../../config/freshness.js";
import type { Config } from "../../config/schema.js";
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
  League,
  LeagueRef,
  LeagueRules,
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
import { cachedBoardControl, cachedPublicity, type KeptFlag } from "./cache.js";
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
 * How long one season's bye map is reused (ms): reading the pro-schedule dataset costs ≈ 10 ms of
 * main loop (the TTL context memoises it for the same reason — plan 10 A16a); byes do not move
 * within a minute, and a dataset loaded meanwhile is seen within one.
 */
export const BYE_WEEKS_MEMO_MS = 60_000;

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
  /** Each season's bye map (null: no schedule loaded) and when it was read (`byeWeeks`). */
  private readonly byeMemo = new Map<
    number,
    { readonly at: number; readonly map: ReadonlyMap<number, number> | null }
  >();

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
   * Pro-team id → bye week for `season` from the wired pro-schedule dataset (memoised
   * BYE_WEEKS_MEMO_MS per season), or undefined when none is wired or the dataset holds no teams for
   * the season. A throwing read counts as not loaded (and is memoised like any answer).
   */
  private byeWeeks(season: number): ReadonlyMap<number, number> | undefined {
    const source = this.deps.proSchedule;
    if (source === undefined) return undefined;
    const now = this.deps.clock.nowMs();
    const hit = this.byeMemo.get(season);
    if (hit !== undefined && now >= hit.at && now - hit.at < BYE_WEEKS_MEMO_MS)
      return hit.map ?? undefined;
    let map: ReadonlyMap<number, number> | null = null;
    try {
      const teams = source.teams(season).rows;
      if (teams.length > 0) {
        const schedule: ProSchedule = { season, teams, games: source.games(season, null).rows };
        map = byeWeeksOf(schedule);
      }
    } catch {
      map = null;
    }
    this.byeMemo.set(season, { at: now, map });
    return map ?? undefined;
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
      this.req.read(
        {
          target: this.league(ref, views),
          filter: null,
          leagueId: ref.league_id,
          cookies: learning ? "never" : "auto",
          parse,
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
          return await read(["mSettings"], parseSettingsAlone);
        } catch (e) {
          if (
            e instanceof Error &&
            (e as { effDetails?: { reason?: unknown } }).effDetails?.reason === "fixture_missing"
          )
            this.settingsMissing.set(ref.season, e);
          throw e;
        }
      }
      return await read(["mSettings", "mNav"], parseSettings);
    } catch (e) {
      // a private league answered the anonymous read with 401: the credential is still the problem
      if (learning && (e as { effCode?: unknown } | null)?.effCode === "ESPN_REQUIRES_COOKIES")
        throw new EspnCredentialError("ESPN_AUTH_REJECTED", "short_circuit");
      throw e;
    }
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
    const r = await this.req.read(
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
    const r = await this.req.read(
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
    return this.req.read(
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
    const r = await this.req.read(
      {
        target: this.league(ref, ["kona_playercard"]),
        filter,
        leagueId: ref.league_id,
        cookies: "auto",
        parse: parseCard,
        provisional: () => q.type === "week" && this.provisional(season, q.week, null),
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
    const r = await this.req.read(
      {
        target: this.league(ref, ["mMatchup"]),
        filter: null,
        leagueId: ref.league_id,
        cookies: "auto",
        parse: parseMatchup,
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
    const r = await this.req.read(
      {
        target: this.league(ref, ["mMatchupScore"], week),
        filter: null,
        leagueId: ref.league_id,
        cookies: "auto",
        parse: parseScore,
        provisional: () => this.provisional(ref.season, week, latest),
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
    const periods = id.settings === null ? [week] : matchupPeriodsForWeek(id.settings, week);
    const r = await this.req.read(
      {
        target: this.league(ref, ["mBoxscore"], week),
        filter: scheduleFilter(periods.length === 0 ? [week] : periods),
        leagueId: ref.league_id,
        cookies: "auto",
        parse: parseBox,
        provisional: (b) =>
          this.provisional(ref.season, week, b.status?.latestScoringPeriod ?? null),
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
    const r = await this.req.read(
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
    const r = await this.req.read(
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
    const r = await this.req.read(
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
    const r = await this.req.read(
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
    const r = await this.req.read(
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
    const r = await this.req.read(
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
    const r = await this.req.read(
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
        const s = await this.req.read(
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
