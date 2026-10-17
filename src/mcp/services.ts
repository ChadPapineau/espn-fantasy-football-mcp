// services.ts — what the MCP surface is given by the composition root (plan 01 §1.1: src/mcp may not
// import src/store, src/auth or node:fs, so src/services builds this object from the real store,
// provider, credential authority and package texts and hands it to createServer). Typed only by
// domain/provider/config interfaces plus the small ports declared here (structural subsets of the
// store's rows, so the store satisfies them without src/mcp naming a store type).
// Ported from sibling @5daa625 (src/mcp/services.ts), adapted (ESPN ports; status/auth ports).
import type { DatasetSourceId, SourceErrorCode } from "../config/freshness.js";
import type {
  CredentialState,
  CredentialStoreKind,
  DriftStatus,
  SeedingMode,
  Toolset,
  WeatherSource,
} from "../config/schema.js";
import type {
  DatasetReaders,
  EspnProjectionRepository,
  ProjectionRepository,
  WaiverRunRepository,
} from "../domain/analytics/types.js";
import type { Clock } from "../domain/clock.js";
import type {
  CrosswalkOverride,
  CrosswalkRepository,
  NflPlayersReader,
  PlayerUniverseReader,
  RosterWeeklyReader,
} from "../domain/crosswalk/types.js";
import type {
  CheckRow,
  LeagueRef,
  LeagueSettingsRepository,
  PlatformPlayer,
  PoolSnapshotRepository,
  RosterSnapshotRepository,
  ScoreboardSnapshotRepository,
  Stamped,
  TransactionsSeenRepository,
} from "../domain/league/types.js";
import type {
  ParameterProposalRepository,
  RecommendationLogRepository,
  ScoredClaimRepository,
} from "../domain/reclog/types.js";
import type {
  CredentialProbeResult,
  FantasyPlatform,
  ReadOptions,
  TransportStatus,
} from "../providers/platform.js";

/** The logger surface src/mcp needs (the cli Logger satisfies it; src/mcp may not import src/cli). */
export interface McpLogger {
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  debug(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** The ESPN provider's reads beyond the seam the tools use (EspnProvider satisfies it). */
export interface EspnExtras {
  /** players_wl — C1's name index when the `espn:players` dataset was never loaded (plan 01 §5.5). */
  getSeasonPlayers(season: number, opts?: ReadOptions): Promise<Stamped<readonly PlatformPlayer[]>>;
  /** `settings_drift` while mSettings is drifted: the server refuses to score (plan 01 §7, T-14). */
  scoringRefusal(): "settings_drift" | null;
}

/** One refresh_log row as G1 and the dataset tools read it (a structural subset of the store's row). */
export interface SourceLogRow {
  readonly source: DatasetSourceId;
  readonly file_version: string | null;
  readonly release_updated_at: string | null;
  readonly rows: number | null;
  readonly finished_at: string;
  readonly ok: boolean;
  readonly error: SourceErrorCode | null;
  readonly checked_at: string;
}

/** The refresh_log reads (the store's RefreshLogRepository satisfies it). */
export interface SourceLogPort {
  current(): readonly SourceLogRow[];
  latest(source: DatasetSourceId): SourceLogRow | null;
  consecutiveFailures(source: DatasetSourceId): number;
}

/** The credential observations G1 shows — never a value, length or fingerprint (plan 02 §2.3). */
export interface CredentialView {
  readonly state: CredentialState;
  readonly store: CredentialStoreKind | null;
  readonly present: boolean;
  readonly stored_at: string | null;
  readonly last_accepted_at: string | null;
  readonly last_rejected_at: string | null;
  readonly rejected_since: string | null;
  readonly next_probe_at: string | null;
}

/** One view's drift paths (the drift_state row's diff_json / additive_json entries, parsed). */
export interface DriftViewDiff {
  readonly view: string;
  readonly removed: readonly string[];
  readonly added: readonly string[];
  readonly enums: readonly string[];
}

/** The drift_state row as G1 reads it (diffs already parsed by the composition root). */
export interface DriftView {
  readonly status: DriftStatus;
  readonly since: string | null;
  readonly last_probe_at: string | null;
  readonly manifest_hash: string | null;
  /** The failing diff (removed required keys, skeletons). */
  readonly diff: readonly DriftViewDiff[];
  /**
   * The additive-drift list (new keys and enum values — the row's `additive_json`, parsed like
   * `diff_json`: `parseDiffs(row.additive_json)`; plan 07 §4.1 espn-ff://status/drift "the
   * additive-drift list"). Optional and additive: G1 merges it into the diff it shows, so an
   * `additive` status names its paths (Stage C finding `status-drift-diff-unwrapped-strings`) —
   * absent, an additive status shows an empty diff.
   */
  readonly additive?: readonly DriftViewDiff[];
}

/** The limiter rows as G1 reads them (from espn_requests, so a second process agrees). */
export interface LimiterView {
  readonly requests_last_minute: number;
  readonly requests_today: number;
}

/** Store health (`path` is never shown to the model — G1 prints a placeholder). */
export interface StoreView {
  readonly size_bytes: number;
  readonly schema_version: number;
}

/** Everything G1 and the status resources read beyond the platform (implemented in src/services). */
export interface StatusPort {
  credential(): CredentialView;
  drift(): DriftView;
  limiter(nowMs: number): LimiterView;
  store(): StoreView;
  /** Open health checks (league_settings `checks`). */
  checks(): readonly CheckRow[];
  /** launchd job runs (plan 06): none are installed by the server itself. */
  jobs(): readonly {
    readonly label: string;
    readonly last_run_at: string | null;
    readonly exit: number | null;
  }[];
}

/** The one explicit credential probe (plan 07 G2) behind the authority's state. */
export interface AuthPort {
  /** The credential state label (never a keychain read). */
  state(): CredentialState;
  /** One probe through the provider (the tool enforces the once-per-minute rule first). */
  probe(ref: LeagueRef): Promise<CredentialProbeResult>;
}

/** The PHASE W SEAM registration-gate verdict (plan 02 §3.2), evaluated by the composition root. */
export interface WriteGateVerdict {
  /** Always false in this build (the write module is not built — D11). */
  readonly allHold: false;
  readonly firstFailing: string | null;
}

/** Texts the composition root read from the package (Skill bodies, the cheat-sheet). */
export interface ServerTexts {
  /** skills/<name>/SKILL.md bodies (frontmatter stripped), keyed by Skill directory; null = absent. */
  readonly skills: Readonly<Record<string, string | null>>;
  /** skills/_shared/references/tool-outputs.md (served as espn-ff://docs/tool-outputs). */
  readonly tool_outputs: string | null;
  /**
   * skills/<name>/references/<file>.md, keyed by Skill directory then file name (`orient.md`,
   * `onboard-log-entry.md`); null or absent = not installed. A prompt carries the references its
   * Skill body links, and the ones those link (plan 09 §6: the prompts are the Skill delivery path
   * where no Skill loader exists, and a prompt-only client cannot open a file). Optional and
   * additive: the composition root fills it with `referenceTextsFor(skills, read)`
   * (src/mcp/prompts) over its bounded package read — absent, every prompt names its references as
   * "not installed".
   */
  readonly references?: Readonly<Record<string, Readonly<Record<string, string | null>>>>;
}

/** The scoring golden's in-process state (A5 updates it; A1 reports it — plan 07 A1 `golden`). */
export interface GoldenState {
  last_checked_week: number | null;
  status: "match" | "mismatch" | "unchecked";
  mismatch_share: number | null;
  settings_hash: string | null;
}

/** Everything the tools, resources and prompts read or write. */
export interface McpServices {
  readonly clock: Clock;
  /** The configured league (operator config only — never model-set; the id is never emitted). */
  readonly league: LeagueRef;
  /** ESPN_TEAM_ID as configured (null until `eff setup` resolved it). */
  readonly configuredTeamId: number | null;
  readonly seedingMode: SeedingMode;
  /** config `seeding_confirmed_at` (null = unconfirmed — plan 07 C12). */
  readonly seedingConfirmedAt: string | null;
  readonly platform: FantasyPlatform;
  readonly espn: EspnExtras;
  readonly datasets: DatasetReaders;
  readonly rosterWeekly: RosterWeeklyReader;
  readonly playerUniverse: PlayerUniverseReader;
  readonly nflPlayers: NflPlayersReader;
  readonly crosswalk: Pick<CrosswalkRepository, "get" | "byGsis" | "count">;
  readonly crosswalkOverrides: readonly CrosswalkOverride[];
  readonly recommendationLog: RecommendationLogRepository;
  readonly projections: ProjectionRepository;
  readonly espnProjections: Pick<EspnProjectionRepository, "asOf" | "lastSnapshotAt">;
  readonly transactionsSeen: Pick<TransactionsSeenRepository, "list" | "listRange" | "oldestSeen">;
  readonly rosterSnapshots: Pick<RosterSnapshotRepository, "latestTwo">;
  readonly poolSnapshots: Pick<PoolSnapshotRepository, "latestTwo">;
  readonly scoreboardSnapshots: Pick<ScoreboardSnapshotRepository, "forWeek">;
  readonly leagueSettings: Pick<LeagueSettingsRepository, "latest" | "openChecks">;
  /**
   * Phase 3 (plan 10 §3.3; migration 002). Optional so a services bundle built before Phase 3 (and
   * the narrower test fakes) still type-checks; the composition root always sets them.
   * The retrospective persists its proposal sets here; only `eff tune` reads them (C9).
   */
  readonly parameterProposals?: Pick<ParameterProposalRepository, "put">;
  /** E5's priced waiver runs — the league's own surplus feed for the fitted premium (C5). */
  readonly waiverRuns?: WaiverRunRepository;
  /** E10's logged news claims; the retrospective scores them, E10 reads the scored rows (C8). */
  readonly scoredClaims?: ScoredClaimRepository;
  readonly refreshLog: SourceLogPort;
  readonly status: StatusPort;
  readonly auth: AuthPort;
  /** The transport state (this process's breaker). */
  transport(): TransportStatus;
  /** Called at the start of every tool call / resource read (re-opens changed dataset files). */
  beforeCall?(): void;
  /** In-flight call accounting for the shutdown drain (plan 03 §1.3: reads ≤ 3 s). */
  readonly inflight?: { enter(): void; exit(): void };
  /** Seed source for calls without `seed`. */
  readonly newSeed?: () => number;
  /** The golden cell A5 writes and A1 reads (in-process). */
  readonly golden: GoldenState;
  readonly logger: McpLogger;
}

/** Server-level options (from the resolved Config and the package). */
export interface McpServerOptions {
  /** Server version (package.json). */
  readonly version: string;
  /** `EFF_TOOLSET`. */
  readonly toolset: Toolset;
  /** `EFF_FIXTURE_DIR` is set (recorded fixtures; no network, no keychain). */
  readonly fixtureMode: boolean;
  readonly weatherSource: WeatherSource;
  /** Fixture mode only: the echo-spike nonce placed in the `instructions` (plan 10 A11b). */
  readonly spikeNonce?: string;
  /** EFF_ENABLE_WRITES=true was set (reported, never honoured — plan 02 §3.2; PHASE W SEAM). */
  readonly writesRequested: boolean;
  /** The four registration gates' verdict (PHASE W SEAM — NOT IMPLEMENTED: never all hold). */
  readonly writeGates: WriteGateVerdict;
  readonly texts: ServerTexts;
  /**
   * Test-only switch for the samplers' per-call CPU deadline (plan 10 A8a; changelog R5): omitted =
   * ANALYTICS_CPU_DEADLINE_MS (8 s, production), null = off, a number = that many ms. Set only by a
   * test's injected options or by the composition root under EFF_TEST_STUBS=1 in fixture mode —
   * both test-scope keys, so no production configuration reaches it.
   */
  readonly cpuDeadlineMs?: number | null;
  /**
   * The applied tuned parameters (`<config>/tuned-parameters.json` — written only by a human-run
   * `eff tune --apply`, plan 10 §3.3 and C9): read ONCE at server start by the composition root and
   * never written by the server; E1's v2-opportunity reads them through `applyTunedOverrides`.
   * Absent or null = the model's own constants (no file, or an unusable one — logged, never guessed).
   */
  readonly tuned?: TunedOverrides | null;
}

/** The applied overrides E1 reads (src/domain/reclog/tune.ts TunedParameters.values, validated). */
export interface TunedOverrides {
  readonly values: Readonly<Record<string, number>>;
  readonly updated_at: string | null;
}
