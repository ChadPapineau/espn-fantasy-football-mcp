// platform.ts — the FantasyPlatform seam (plan 01 §9), ESPN-shaped: platform-owned types, not a
// lowest common denominator (plan 01 §0.3). ESPN-native capabilities — projections, ownership, live
// scoring — are literal `true`, so their methods are required here (the sibling's seam has them
// optional). Every read resolves to `Stamped<T>` and takes `ReadOptions` (force_refresh,
// allow_stale, the per-call upstream budget — plan 01 §5.3, §5.6, §6). Writes are NOT part of the
// read interface: `FantasyPlatformWrites` is the declared, unbuilt seam and `writes` is literal
// `false`. Also the ops tool data (plan 07 G1, G2). Ported from sibling @d72e03b, adapted.
import type {
  CredentialState,
  CredentialStoreKind,
  DriftStatus,
  SeedingMode,
  Toolset,
} from "../config/schema.js";
import type { Freshness, License } from "../config/freshness.js";
import type {
  CommitTicket,
  LineupMove,
  TradeRequest,
  TransactionRequest,
  WriteReceipt,
} from "../domain/gate/types.js";
import type {
  BoxScoreMatchup,
  CheckRow,
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
  PoolStatus,
  PositionalRating,
  ProjectionHorizon,
  ProSchedule,
  Roster,
  RosterSlots,
  Stamped,
  Standings,
  TeamRef,
  Transaction,
  TransactionType,
  WaiverSystem,
  Week,
} from "../domain/league/types.js";
import type { ScoringSettings } from "../domain/scoring/types.js";

export type * from "../domain/league/types.js";
export type { ScoringSettings } from "../domain/scoring/types.js";
export {
  ESPN_DST_PLAYER_ID_MAX,
  ESPN_DST_PLAYER_ID_MIN,
  ESPN_PRO_TEAM_ABBREVS,
  KNOWN_UPSTREAM_TYPES,
  UPSTREAM_TYPE_FAMILY_RE,
  isEspnView,
  upstreamTypeOrUnknown,
} from "./espn/types.js";
export type { EspnView } from "./espn/types.js";

/** The marker every Phase W seam carries (a test greps for it). */
export const WRITES_SEAM_MARKER =
  "PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; owner decision D11)";

// --- capabilities (plan 01 §9; plan 07 G1 `capabilities`) -----------------------------------------

/** Which write families a grant covers — every flag the literal `false` in this build. */
export interface WriteCapabilities {
  readonly lineup: false;
  readonly add_drop: false;
  readonly waiver: false;
  readonly trade: false;
}

/** The ESPN platform's capabilities. `writes: false` is a literal type: no code can set it true. */
export interface PlatformCapabilities {
  readonly read: true;
  readonly native_projections: true;
  readonly native_ownership: true;
  readonly live_scoring: true;
  readonly waiver_system: WaiverSystem;
  /** PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; D11). */
  readonly writes: false;
  readonly write: WriteCapabilities;
  readonly discovered_at: string;
}

/** The write capabilities of this build: all false. */
export const NO_WRITES: WriteCapabilities = Object.freeze({
  lineup: false,
  add_drop: false,
  waiver: false,
  trade: false,
});

/** Builds the ESPN capabilities (read-only; ESPN-native features true). */
export function espnCapabilities(
  waiverSystem: WaiverSystem,
  discoveredAt: string,
): PlatformCapabilities {
  return Object.freeze({
    read: true,
    native_projections: true,
    native_ownership: true,
    live_scoring: true,
    waiver_system: waiverSystem,
    writes: false,
    write: NO_WRITES,
    discovered_at: discoveredAt,
  });
}

// --- per-call options and budget (plan 01 §5.3, §5.6, §6) ------------------------------------------

/** At most three upstream ESPN requests per tool call; a 4th need → `partial: true`. */
export const MAX_UPSTREAM_PER_CALL = 3;
/** The total upstream deadline of one ESPN-fact call, retries inside it (ADV OBJ-20). */
export const PER_CALL_DEADLINE_MS = 20_000;
/** One attempt's timeout under the per-call deadline. */
export const ATTEMPT_TIMEOUT_MS = 15_000;
/** `force_refresh` is honoured at most once per 60 s per cache key. */
export const FORCE_REFRESH_MIN_INTERVAL_MS = 60_000;

/**
 * The upstream budget of one tool call, created by the tool handler and consumed by the provider.
 * `tryConsume()` is called before each upstream request; false → the provider must not send it
 * (the tool returns what it has with `partial: true` and names the missing input).
 */
export interface UpstreamBudget {
  readonly request_id: string;
  /** Epoch ms after which no request (and no retry) may start. */
  readonly deadline_at_ms: number;
  readonly signal: AbortSignal;
  used(): number;
  tryConsume(): boolean;
}

/** Per-read options every seam read accepts (plan 07 §2 common inputs). */
export interface ReadOptions {
  readonly force_refresh?: boolean;
  readonly allow_stale?: boolean;
  readonly budget?: UpstreamBudget;
}

// --- queries (plan 07 inputs, already validated by src/mcp/bounds.ts) ------------------------------

/** C2 `status` filter: the pool statuses plus `AVAILABLE` (FA ∪ W) and `ALL`. */
export type PlayerStatusFilter = PoolStatus | "AVAILABLE" | "ALL";
/** C2 `sort`. */
export type PlayerSort =
  "percOwned" | "percChanged" | "projection_week" | "projection_ros" | "draftRank" | "name";

/** A pool query (plan 07 C2). The provider maps it through the one filter builder. */
export interface PlayerQuery {
  readonly status: PlayerStatusFilter;
  /** A slot or position name validated against the league's own roster slots; null = any. */
  readonly position: string | null;
  readonly sort: PlayerSort;
  readonly week: Week;
  readonly injured: boolean | null;
}

/** A page request (plan 01 §4.2: `limit` 1..100 with a mandatory sort, `offset` 0..5 000). */
export interface Page {
  readonly limit: number;
  readonly offset: number;
}

/** A page of results; `total` from `x-fantasy-filter-*-count` when ESPN reports it. */
export interface PageOf<T> {
  readonly items: readonly T[];
  readonly limit: number;
  readonly offset: number;
  readonly count: number;
  readonly total: number | null;
  readonly has_more: boolean;
  readonly next_offset: number | null;
}

/** A transactions query (plan 07 A6). */
export interface TxnQuery {
  readonly types: readonly TransactionType[];
  readonly week: Week;
  readonly since: string | null;
  readonly count: number;
  readonly team_id: number | null;
}

/** A stats query (plan 07 B2 `type`). */
export type StatsQuery =
  | { readonly type: "week"; readonly week: Week }
  | { readonly type: "season" }
  | { readonly type: "prior_season" };

/** The credential probe's outcome (plan 07 G2; plan 02 §2.1 definitive check). */
export interface CredentialProbeResult {
  /** null when nothing is stored, or the board probe does not discriminate here (ADV OBJ-26). */
  readonly accepted: boolean | null;
  readonly probe: "settings" | "board";
  readonly upstream_status: number | null;
  /** Fixed-vocabulary reason when `accepted` is null. */
  readonly reason: "not_configured" | "board_not_discriminating" | null;
  readonly checked_at: string;
}

// --- the seam ---------------------------------------------------------------------------------------

/**
 * The read seam ESPN implements (plan 01 §9). Every implementation maps its failures to plan 01
 * §4.3 codes by throwing Errors that carry an own `effCode` property (src/mcp/errors.ts reads it;
 * a provider may not import src/mcp). Every read resolves to `Stamped<T>`.
 */
export interface FantasyPlatform {
  readonly id: "espn";
  capabilities(): Promise<PlatformCapabilities>;
  /** Identity, season, clock, status flags (mSettings + mNav, composed). */
  getLeague(ref: LeagueRef, opts?: ReadOptions): Promise<Stamped<League>>;
  /** Normalised scoring settings — canonical hub + ESPN ids (plan 08). */
  getScoringSettings(ref: LeagueRef, opts?: ReadOptions): Promise<Stamped<ScoringSettings>>;
  getRosterSlots(ref: LeagueRef, opts?: ReadOptions): Promise<Stamped<RosterSlots>>;
  getLeagueRules(ref: LeagueRef, opts?: ReadOptions): Promise<Stamped<LeagueRules>>;
  /** One team's roster (mRoster requested alone; every team arrives and is cached per team). */
  getRoster(team: TeamRef, week: Week, opts?: ReadOptions): Promise<Stamped<Roster>>;
  /** Every team's roster for a week — the same single request. */
  getRosters(ref: LeagueRef, week: Week, opts?: ReadOptions): Promise<Stamped<readonly Roster[]>>;
  /** A page of the pool (kona_player_info + filter, ≤ 100 rows, sorted). */
  listPlayers(
    ref: LeagueRef,
    q: PlayerQuery,
    page: Page,
    opts?: ReadOptions,
  ): Promise<Stamped<PageOf<PlatformPlayer>>>;
  /** League status of known players (kona_player_info + filterIds, ≤ 50 ids). */
  getPlayers(
    ref: LeagueRef,
    players: readonly PlayerRef[],
    week: Week,
    opts?: ReadOptions,
  ): Promise<Stamped<readonly PlatformPlayer[]>>;
  /** ESPN editorial outlooks (tool-only text, plan 07 C14). */
  getPlayerOutlooks(
    ref: LeagueRef,
    players: readonly PlayerRef[],
    weeks: readonly Week[],
    opts?: ReadOptions,
  ): Promise<Stamped<readonly (PlayerOutlook & { readonly player: PlayerRef })[]>>;
  /** Weekly / season / prior-season splits (kona_playercard, ≤ 25 ids per request). */
  getPlayerStats(
    ref: LeagueRef,
    players: readonly PlayerRef[],
    q: StatsQuery,
    opts?: ReadOptions,
  ): Promise<Stamped<readonly PlatformStatLine[]>>;
  /** The whole season's schedule and results (mMatchup). */
  getMatchups(ref: LeagueRef, opts?: ReadOptions): Promise<Stamped<readonly Matchup[]>>;
  /** Current-period live totals and ESPN's win probability (mMatchupScore). */
  getLiveMatchups(
    ref: LeagueRef,
    week: Week,
    opts?: ReadOptions,
  ): Promise<Stamped<readonly LiveMatchup[]>>;
  /** Per-player box scores with appliedStats — the golden's input (mBoxscore; plan 07 C6). */
  getBoxScores(
    ref: LeagueRef,
    week: Week,
    opts?: ReadOptions,
  ): Promise<Stamped<readonly BoxScoreMatchup[]>>;
  /** ESPN's own projections (labelled ESPN's; plan 01 D15). */
  getNativeProjections(
    ref: LeagueRef,
    players: readonly PlayerRef[],
    horizon: ProjectionHorizon,
    week: Week,
    opts?: ReadOptions,
  ): Promise<Stamped<readonly NativeProjection[]>>;
  /** Standings, waiver order, divisions (mTeam + mStandings, composed). */
  getStandings(ref: LeagueRef, opts?: ReadOptions): Promise<Stamped<Standings>>;
  /** Transactions incl. losing claims (mTransactions2; cookies required on a private league). */
  listTransactions(
    ref: LeagueRef,
    q: TxnQuery,
    opts?: ReadOptions,
  ): Promise<Stamped<PageOf<Transaction>>>;
  /** Pending claims and proposals (mPendingTransactions). */
  listPendingTransactions(
    ref: LeagueRef,
    opts?: ReadOptions,
  ): Promise<Stamped<readonly Transaction[]>>;
  /** Position-vs-opponent ratings (mPositionalRatings, or embedded in a pool page). */
  getPositionalRatings(
    ref: LeagueRef,
    week: Week,
    opts?: ReadOptions,
  ): Promise<Stamped<readonly PositionalRating[]>>;
  /** The keyless pro schedule — on demand only when the dataset is empty (plan 01 §5.5). */
  getProSchedule(season: number, opts?: ReadOptions): Promise<Stamped<ProSchedule>>;
  /** The team whose owners include the stored SWID (plan 03 §2.1 step 6). */
  resolveOwnTeam(ref: LeagueRef, opts?: ReadOptions): Promise<Stamped<OwnTeamResolution>>;
  /** The one explicit credential probe (plan 07 G2), ≤ 1 per minute by the caller. */
  probeCredential(ref: LeagueRef): Promise<CredentialProbeResult>;
}

// --- writes: PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; owner decision D11) --------------------

/** One lineup move to send (the provider decides the wire form; plan 01 §9). */
export type SlotMove = LineupMove;

/**
 * PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; owner decision D11).
 * The write methods a write module would add to the ESPN provider (plan 02 §4; plan 07 §3.F):
 * every one takes a CommitTicket from the gate, sends exactly one atomic POST to the write host,
 * and reads `mRoster` back as the outcome. No class implements this interface; nothing calls it.
 */
export interface FantasyPlatformWrites {
  setLineup(
    team: TeamRef,
    scoringPeriod: number,
    moves: readonly SlotMove[],
    ticket: CommitTicket,
  ): Promise<WriteReceipt>;
  submitTransaction(
    team: TeamRef,
    request: TransactionRequest,
    ticket: CommitTicket,
  ): Promise<WriteReceipt>;
  submitTrade(team: TeamRef, request: TradeRequest, ticket: CommitTicket): Promise<WriteReceipt>;
}

// --- ops tool data (plan 07 G1, G2) -----------------------------------------------------------------

/** `espn_get_status` data (plan 07 G1). Never a cookie value, length or fingerprint. */
export interface StatusData {
  readonly server: {
    readonly version: string;
    readonly sdk_version: string;
    readonly protocol_eras: readonly string[];
    readonly node: string;
    readonly tool_contract: number;
    readonly toolset: Toolset;
  };
  readonly credential: {
    readonly present: boolean;
    readonly store: CredentialStoreKind | null;
    readonly state: CredentialState;
    readonly stored_at: string | null;
    readonly age_days: number | null;
    readonly last_accepted_at: string | null;
    readonly last_rejected_at: string | null;
    readonly rejected_since: string | null;
    readonly next_probe_at: string | null;
    readonly stale_warning: boolean | null;
  };
  readonly capabilities: Omit<PlatformCapabilities, "discovered_at"> & {
    readonly write_gate_failing: string | null;
  };
  readonly league: {
    readonly season: number;
    readonly current_week: Week | null;
    readonly is_public: boolean | null;
    readonly seeding_mode_configured: SeedingMode;
    readonly seeding_confirmed: boolean;
  };
  readonly drift: {
    readonly status: DriftStatus;
    readonly last_probe_at: string | null;
    readonly manifest_hash: string | null;
    readonly diff: readonly {
      readonly view: string;
      readonly removed: readonly string[];
      readonly added: readonly string[];
      readonly enums: readonly string[];
    }[];
    readonly affected_tools: readonly string[];
  };
  readonly limiter: {
    readonly requests_last_minute: number;
    readonly requests_today: number;
    readonly breaker_open: boolean;
    readonly etag_304_count: number;
  };
  readonly sources: readonly {
    readonly id: string;
    readonly license: License;
    readonly last_success_at: string | null;
    readonly age_s: number | null;
    readonly freshness: Freshness | "expired" | "never";
    readonly rows: number | null;
    readonly last_error: string | null;
  }[];
  readonly crosswalk: {
    readonly matched: number;
    readonly unmatched_rostered: number;
    readonly unmatched_top_owned: number;
  };
  readonly store: {
    readonly path: string;
    readonly size_bytes: number;
    readonly schema_version: number;
  };
  readonly snapshots: {
    readonly roster_last_at: string | null;
    readonly pool_last_at: string | null;
    readonly projection_last_at: string | null;
  };
  /** PHASE W SEAM — always null in this build. */
  readonly journal: { readonly prepared: number; readonly sent_unknown: number } | null;
  readonly jobs: readonly {
    readonly label: string;
    readonly last_run_at: string | null;
    readonly exit: number | null;
  }[];
  readonly checks: readonly Pick<CheckRow, "id" | "status" | "detail">[] | null;
}

/** `espn_check_auth` data (plan 07 G2). */
export interface CheckAuthData {
  readonly accepted: boolean | null;
  readonly probe: "settings" | "board";
  readonly state: CredentialState;
  readonly upstream_status: number | null;
  readonly checked_at: string;
  readonly next_allowed_at: string;
}
