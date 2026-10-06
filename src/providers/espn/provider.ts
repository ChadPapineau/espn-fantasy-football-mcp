// provider.ts — EspnProvider, the FantasyPlatform read seam over ESPN's read host (plan 01 §9; plan
// 07 §3 what each P0 tool asks of it; plan 01 §5.6 the views per call). Every read goes through the
// one pipeline (request.ts): one path builder, one filter builder, cache-first, the cross-process
// limiter, in-call drift, the credential rules. The league id comes from config only (plan 02 §5);
// a LeagueRef naming another league is a programming error. Read-only: no write method exists.
// PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; owner decision D11): FantasyPlatformWrites
// (src/providers/platform.ts) is not implemented here and nothing in this file sends to the write host.
import type { TtlContext } from "../../config/freshness.js";
import type { Config } from "../../config/schema.js";
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
  ProSchedule,
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
import { scoringRefusal } from "../../drift/state.js";
import type { DriftObservations } from "../../drift/types.js";
import type {
  DriftStateRepository,
  EspnCacheRepository,
  LimiterRepository,
  RequestOrigin,
} from "../../store/types.js";
import {
  espnCapabilities,
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
} from "../platform.js";
import { EspnCredentialError } from "./credentials.js";
import { EspnDriftError, EspnUpstreamError } from "./errors.js";
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
} from "./normalize.js";
import {
  communicationTarget,
  leagueTarget,
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
  type EspnView,
  type LeagueView,
  type ScoringSettingsTranslator,
} from "./types.js";
import {
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
  readonly sleep?: Sleep;
  readonly random?: () => number;
  readonly log?: ProviderLog;
  readonly attemptTimeoutMs?: number;
}

interface SettingsRead {
  readonly settings: WireSettingsBody;
  readonly nav: WireNavBody;
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
const parsePending = (b: unknown): readonly unknown[] =>
  must("mPendingTransactions", mPendingTransactionsSchema, b).pendingTransactions;

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
    try {
      return await this.req.read(
        {
          target: this.league(ref, ["mSettings", "mNav"]),
          filter: null,
          leagueId: ref.league_id,
          cookies: learning ? "never" : "auto",
          parse: parseSettings,
        },
        opts,
      );
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
      const identity = identityFromNav(s.value.nav);
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
    const identity = identityFromNav(r.value.nav);
    const swid = await this.req.cookies.memberId().catch(() => null);
    const mine = myTeamId(identity, swid, this.deps.config.teamId);
    return this.stamped(
      r,
      normalizeLeague(r.value.settings, ref, identity, mine, isCommissioner(identity, swid)),
    );
  }

  async getScoringSettings(ref: LeagueRef, opts?: ReadOptions): Promise<Stamped<ScoringSettings>> {
    const r = await this.settingsRead(ref, opts);
    if (scoringRefusal(this.req.drift.current()) === "settings_drift")
      throw new EspnDriftError("mSettings", "settings.scoringSettings");
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
      { season: ref.season, week },
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
    let items = r.value.players
      .map((pe) => normalizePlayer(pe.player, pe, { season: ref.season, week: q.week }, counts))
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
    const byId = new Map<number, PlatformPlayer>();
    for (const pe of r.value.players) {
      const p = normalizePlayer(pe.player, pe, { season: ref.season, week }, counts);
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
    const box = normalizeBoxScores(r.value, week, ref.season, prov, id.identity, counts);
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
    const out = r.value
      .map((p) => normalizePlayer(p, null, { season, week: null }, counts))
      .filter((p): p is PlatformPlayer => p !== null);
    this.counted("players_wl", counts);
    return this.stamped(r, out);
  }

  async resolveOwnTeam(ref: LeagueRef, opts?: ReadOptions): Promise<Stamped<OwnTeamResolution>> {
    const r = await this.settingsRead(ref, opts);
    const identity = identityFromNav(r.value.nav);
    const swid = await this.req.cookies.memberId().catch(() => null);
    if (swid === null) return this.stamped(r, { team_id: null, reason: "no_credential" });
    const s = swid.toUpperCase();
    const hits = [...identity.teams.values()].filter((t) =>
      t.owners.some((o) => o.toUpperCase() === s),
    );
    if (hits.length === 1)
      return this.stamped(r, { team_id: hits[0]?.team_id ?? null, reason: "resolved" });
    return this.stamped(r, { team_id: null, reason: hits.length === 0 ? "no_match" : "ambiguous" });
  }

  /**
   * The one explicit credential probe (plan 02 §2.1; plan 07 G2): on a private league one
   * cookie-bearing `mSettings` (200 accepted / 401·403 rejected / 404 → ESPN_LEAGUE_NOT_FOUND); on a
   * public league the board probe (`kona_league_communication`, limit 1, body discarded) with an
   * anonymous control first — a control that is not 401 means the probe does not discriminate here.
   * Never cached; exempt from the short-circuit only when the authority offers probe access.
   */
  async probeCredential(ref: LeagueRef): Promise<CredentialProbeResult> {
    this.checkRef(ref);
    const by = this.deps.probeObserver ?? "check_auth";
    const checkedAt = (): string => this.deps.clock.nowIso();
    const result = (
      accepted: boolean | null,
      probe: "settings" | "board",
      status: number | null,
      reason: CredentialProbeResult["reason"],
    ): CredentialProbeResult => ({
      accepted,
      probe,
      upstream_status: status,
      reason,
      checked_at: checkedAt(),
    });
    if (!this.req.cookies.configured()) return result(null, "settings", null, "not_configured");
    const header = await this.req.cookies.probeHeader();
    if (header === null) return result(null, "settings", null, "not_configured");
    if (!header.ok)
      return header.reason === "rejected"
        ? result(false, "settings", null, null)
        : result(null, "settings", null, "not_configured");
    if (this.req.cookies.isPublic() === null) {
      // learn publicity ANONYMOUSLY (cache-first; one keyless request when cold): a cookie-bearing
      // 200 on a public league would prove nothing (plan 02 §2.1, R-5)
      await this.req
        .read(
          {
            target: this.league(ref, ["mSettings", "mNav"]),
            filter: null,
            leagueId: ref.league_id,
            cookies: "never",
            parse: parseSettings,
          },
          {},
        )
        .catch(() => undefined);
    }
    const isPublic = this.req.cookies.isPublic() === true;
    const probeOnce = (
      target: EspnTarget,
      filter: string | null,
      withCookie: boolean,
    ): Promise<number> => this.req.probeSend(target, filter, withCookie ? header.header : null);
    if (!isPublic) {
      const status = await probeOnce(this.league(ref, ["mSettings"]), null, true);
      if (status >= 200 && status <= 299) {
        await this.req.cookies.observeProbe("accepted", by, status, "mSettings");
        return result(true, "settings", status, null);
      }
      if (status === 401 || status === 403) {
        await this.req.cookies.observeProbe("rejected", by, status, "mSettings");
        return result(false, "settings", status, null);
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
    const control = await probeOnce(board, boardProbeFilter(), false);
    if (control !== 401) return result(null, "board", control, "board_not_discriminating");
    const status = await probeOnce(board, boardProbeFilter(), true);
    if ((status >= 200 && status <= 299) || status === 404) {
      await this.req.cookies.observeProbe("accepted", by, status, "kona_league_communication");
      return result(true, "board", status, null);
    }
    if (status === 401 || status === 403) {
      await this.req.cookies.observeProbe("rejected", by, status, "kona_league_communication");
      return result(false, "board", status, null);
    }
    throw new EspnUpstreamError("server_error", {
      upstream_status: status,
      view: "kona_league_communication",
    });
  }

  transportStatus(): TransportStatus {
    return { ...this.req.limiter.breaker.status(), etag_304_count: this.req.etag304Today() };
  }

  /** The drift lookup a scoring caller needs (T-14): `settings_drift` refuses to score. */
  scoringRefusal(): "settings_drift" | null {
    return scoringRefusal(this.req.drift.current());
  }
}
