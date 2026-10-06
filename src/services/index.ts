// services/index.ts — the serve composition root (plan 01 §1.1: the MCP surface never touches the
// store, the credential store or the network, so this module wires them and hands src/mcp plain
// ports): the CredentialAuthority over the store.sqlite `credential_state` row (plan 03 §1.1 step 4 —
// never a keychain read at construction; the secret is read lazily on the first cookie-bearing call),
// probe access for espn_check_auth (plan 02 §2.1), the EspnProvider (cache, limiter, drift, the
// scoring translator; fixture mode swaps in the recorded fixtures and never holds a credential —
// plan 05 §3.1 step 5), the status/auth ports G1/G2 read, the package texts (Skill bodies for the
// prompts, the tool-output cheat-sheet), and the PHASE W SEAM registration-gate verdict (never all
// hold). EFF_TEST_STUBS turns any network call or keychain access into exit 99 (plan 05 §4.2); in
// fixture mode it also turns the samplers' CPU deadline off (the test-only switch — plan 10 A8a's
// injection invariance must not flake on a slow runner; changelog R5).
// Nothing here runs a request or reads a secret.
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { cookieUnavailableFor } from "../auth/errors.js";
import { fileStoreExistsSync } from "../auth/file.js";
import { buildCookieHeader } from "../auth/format.js";
import { evaluateRegistrationGates } from "../auth/gates.js";
import type { KeyringPort } from "../auth/keychain.js";
import { registerCredentialRedaction } from "../auth/redact.js";
import { createCredentialAuthority, type CredentialAuthorityHandle } from "../auth/state.js";
import { openCredentialStore } from "../auth/stores.js";
import type { CookieHeaderResult, CredentialStore, SecretRegistrar } from "../auth/types.js";
import { inGameWindow, isPeriodProvisional, type TtlContext } from "../config/freshness.js";
import { readSecureFile } from "../config/paths.js";
import type { Config } from "../config/schema.js";
import type { Clock } from "../domain/clock.js";
import { CHECKED_IN_OVERRIDES } from "../domain/crosswalk/overrides.js";
import { translateScoringInput } from "../domain/scoring/index.js";
import { loadObservations, parseDiffs } from "../drift/index.js";
import { MANIFEST_PATH, type DriftObservations } from "../drift/types.js";
import type {
  CredentialView,
  DriftView,
  GoldenState,
  McpLogger,
  McpServerOptions,
  McpServices,
  ServerTexts,
} from "../mcp/services.js";
import { createEspnProvider, type EspnProvider, type FetchLike } from "../providers/espn/index.js";
import type { LeagueRef } from "../providers/platform.js";
import type { Store } from "../store/types.js";
import { VERSION } from "../version.js";

/** What the composition root needs of the logger (src/cli/log.ts Logger satisfies it). */
export type ServicesLogger = McpLogger & SecretRegistrar;

/** The exit code a stubbed network call or keychain access ends the process with (plan 05 §4.2). */
export const TEST_STUB_EXIT = 99;

const TEXT_MAX_BYTES = 256 * 1024;

/** Strips a leading `---` YAML frontmatter block. */
export function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return text;
  const after = text.indexOf("\n", end + 4);
  return after === -1 ? "" : text.slice(after + 1);
}

/** Reads a package text file (no symlinks, size-capped); null when absent or unreadable. */
export function readPackageText(file: string): string | null {
  try {
    return readSecureFile(file, {
      requirePrivate: false,
      maxBytes: TEXT_MAX_BYTES,
      what: "package text",
    });
  } catch {
    return null;
  }
}

/** The Skill directories whose bodies become prompts (plan 07 §4.2: the eight P0 and the five P1 Skills). */
export const PROMPT_SKILLS: readonly string[] = Object.freeze([
  "onboard",
  "weekly",
  "start-sit",
  "stream-kdef",
  "retro",
  "apply",
  "session-check",
  "waivers",
  // the five P1 Skills (plan 09 P1; their prompts register under EFF_TOOLSET=full)
  "trade",
  "injury-cascade",
  "schedule-plan",
  "roster-audit",
  "news-check",
]);

/** The Skill bodies and the cheat-sheet (plan 07 §4.2 prompts; §4.1 espn-ff://docs/tool-outputs). */
export function loadTexts(root: string): ServerTexts {
  const skills: Record<string, string | null> = {};
  const dir = path.join(root, "skills");
  const present = existsSync(dir) ? new Set(readdirSync(dir)) : new Set<string>();
  for (const name of PROMPT_SKILLS) {
    const t = present.has(name) ? readPackageText(path.join(dir, name, "SKILL.md")) : null;
    skills[name] = t === null ? null : stripFrontmatter(t);
  }
  return {
    skills,
    tool_outputs: readPackageText(
      path.join(root, "skills", "_shared", "references", "tool-outputs.md"),
    ),
  };
}

/** The drift observations the package ships (fixtures/drift/manifest.json), or undefined. */
export function driftObservationsAt(
  root: string,
  logger: McpLogger,
): DriftObservations | undefined {
  const file = path.join(root, MANIFEST_PATH);
  if (!existsSync(file)) return undefined;
  try {
    return loadObservations(file);
  } catch {
    logger.warn("drift.manifest_unreadable");
    return undefined;
  }
}

/** A fetch that ends the process with TEST_STUB_EXIT (EFF_TEST_STUBS=1). */
export function stubbedFetch(stderr: NodeJS.WritableStream): FetchLike {
  return () => {
    stderr.write("eff: EFF_TEST_STUBS: a network call was attempted\n");
    process.exit(TEST_STUB_EXIT);
  };
}

/** A keychain loader that ends the process with TEST_STUB_EXIT (EFF_TEST_STUBS=1). */
export function stubbedKeyring(stderr: NodeJS.WritableStream): () => Promise<KeyringPort> {
  return () => {
    stderr.write("eff: EFF_TEST_STUBS: a keychain access was attempted\n");
    process.exit(TEST_STUB_EXIT);
  };
}

/** The authority plus probe access (the provider's CredentialProbeAccess — plan 02 §2.1). */
export type ProbingAuthority = CredentialAuthorityHandle & {
  getCookieHeaderForProbe(): Promise<CookieHeaderResult>;
};

/**
 * Adds probe access: espn_check_auth reads the stored value directly — even while `rejected` — so
 * the one explicit probe can flip `rejected → validated` (plan 02 §2.1, ADV OBJ-04). The value is
 * registered with the redactor before it is used; it is never returned or logged.
 */
export function withProbeAccess(
  authority: CredentialAuthorityHandle,
  store: CredentialStore,
  registrar: SecretRegistrar,
): ProbingAuthority {
  return {
    state: () => authority.state(),
    getCookieHeader: () => authority.getCookieHeader(),
    observe: (o) => authority.observe(o),
    dropSecret: () => {
      authority.dropSecret();
    },
    holdsSecret: () => authority.holdsSecret(),
    getCookieHeaderForProbe: async (): Promise<CookieHeaderResult> => {
      try {
        const stored = await store.read();
        if (stored === null) return { ok: false, reason: "not_configured" };
        registerCredentialRedaction(registrar, stored.cookies);
        return { ok: true, header: buildCookieHeader(stored.cookies) };
      } catch (e) {
        return { ok: false, reason: cookieUnavailableFor(e) };
      }
    },
  };
}

/** The freshness context the provider's TTLs read, from the stored pro schedule (plan 01 §5.2). */
export function ttlContextFrom(store: Store, season: number, clock: Clock): () => TtlContext {
  return () => {
    try {
      const games = store.datasets.proSchedule.games(season, null).rows;
      const now = clock.nowMs();
      const flags = games.map((g) => ({
        kickoff_ms: g.kickoff === null || g.start_time_tbd ? null : Date.parse(g.kickoff),
        valid_for_locking: g.valid_for_locking,
        stats_official: g.stats_official,
      }));
      const day = new Date(now).toISOString().slice(0, 10);
      const gameDay = flags.some(
        (f) => f.kickoff_ms !== null && new Date(f.kickoff_ms).toISOString().slice(0, 10) === day,
      );
      const kicks = flags.map((f) => f.kickoff_ms).filter((k): k is number => k !== null);
      const inSeason =
        kicks.length === 0 ||
        (now >= Math.min(...kicks) - 14 * 86_400_000 &&
          now <= Math.max(...kicks) + 14 * 86_400_000);
      return { inGameWindow: inGameWindow(flags, now), gameDay, inSeason };
    } catch {
      return { inGameWindow: false, gameDay: false, inSeason: true };
    }
  };
}

/** Whether a week is provisional by the stored pro schedule; null when it holds no such games. */
export function periodProvisionalFrom(
  store: Store,
): (season: number, week: number) => boolean | null {
  return (season, week) => {
    try {
      const games = store.datasets.proSchedule.games(season, [week]).rows;
      return games.length === 0 ? null : isPeriodProvisional(games);
    } catch {
      return null;
    }
  };
}

/** Everything buildServices needs (the CLI passes the real ones; tests pass fixtures). */
export interface BuildServicesArgs {
  readonly config: Config;
  readonly store: Store;
  readonly clock: Clock;
  readonly logger: ServicesLogger;
  /** The package root (Skill texts, the drift manifest, fixtures). */
  readonly packageRoot: string;
  readonly home: string;
  /** The transport under the provider (tests inject; default the global fetch; ignored in fixture mode). */
  readonly fetch?: FetchLike;
  /** The keychain loader (tests inject; default the native addon, loaded lazily). */
  readonly loadKeyring?: () => Promise<KeyringPort>;
  readonly texts?: ServerTexts;
  /** Where EFF_TEST_STUBS writes its one line (default process.stderr). */
  readonly stderr?: NodeJS.WritableStream;
}

/** The composition root's product. */
export interface Wiring {
  readonly services: McpServices;
  readonly options: McpServerOptions;
  readonly provider: EspnProvider;
  /** Drops the in-memory secret (plan 03 §1.3). */
  close(): void;
}

/** Wires the services src/mcp is given. No request is made and no secret is read here. */
export function buildServices(args: BuildServicesArgs): Wiring {
  const { config, store, clock, logger } = args;
  const stderr = args.stderr ?? process.stderr;
  const fixture = config.fixtureDir !== null;
  const loadKeyring = config.testStubs ? stubbedKeyring(stderr) : args.loadKeyring;
  const fetchFn = config.testStubs && !fixture ? stubbedFetch(stderr) : args.fetch;
  const ref: LeagueRef = { platform: "espn", league_id: config.leagueId, season: config.season };

  let authority: ProbingAuthority | null = null;
  if (!fixture) {
    const credStore = openCredentialStore(config.credentialStore, {
      filePath: config.credentialFile,
      home: args.home,
      repoRoot: args.packageRoot,
      ...(loadKeyring === undefined ? {} : { loadKeyring }),
    });
    const base = createCredentialAuthority({
      store: credStore,
      repo: store.repos.credentialState,
      leagueId: config.leagueId,
      registrar: logger,
      observer: "server",
      fileStoreExists:
        config.credentialStore === "file" && fileStoreExistsSync(config.credentialFile),
      onWarning: (code) => {
        logger.warn("auth.warning", { code });
      },
    });
    authority = withProbeAccess(base, credStore, logger);
  }

  const provider = createEspnProvider({
    config,
    repos: store.repos,
    credentials: authority,
    clock,
    scoring: translateScoringInput,
    origin: "server",
    observer: "server",
    probeObserver: "check_auth",
    ...(fetchFn === undefined ? {} : { fetch: fetchFn }),
    ...((): { observations?: DriftObservations } => {
      const o = driftObservationsAt(args.packageRoot, logger);
      return o === undefined ? {} : { observations: o };
    })(),
    ttlContext: ttlContextFrom(store, config.season, clock),
    periodProvisional: periodProvisionalFrom(store),
    log: logger,
  });

  const golden: GoldenState = {
    last_checked_week: null,
    status: "unchecked",
    mismatch_share: null,
    settings_hash: null,
  };

  const credentialView = (): CredentialView => {
    let row = null;
    try {
      row = store.repos.credentialState.get();
    } catch {
      row = null;
    }
    const mine = row !== null && row.league_id === config.leagueId ? row : null;
    const state = authority?.state() ?? "not_configured";
    return {
      state,
      store: fixture ? null : state === "not_configured" ? null : config.credentialStore,
      present: state !== "not_configured",
      stored_at: mine?.stored_at ?? null,
      last_accepted_at: mine?.last_accepted_at ?? null,
      last_rejected_at: mine?.last_rejected_at ?? null,
      rejected_since: mine?.rejected_since ?? null,
      next_probe_at: mine?.next_probe_at ?? null,
    };
  };

  const driftView = (): DriftView => {
    let row = null;
    try {
      row = store.repos.driftState.get();
    } catch {
      row = null;
    }
    if (row === null)
      return { status: "green", since: null, last_probe_at: null, manifest_hash: null, diff: [] };
    return {
      status: row.status,
      since: row.since,
      last_probe_at: row.last_probe_at,
      manifest_hash: row.manifest_hash,
      diff: parseDiffs(row.diff_json).slice(0, 30),
    };
  };

  const services: McpServices = {
    clock,
    league: ref,
    configuredTeamId: config.teamId,
    seedingMode: config.seedingMode,
    seedingConfirmedAt: config.seedingConfirmedAt,
    platform: provider,
    espn: provider,
    datasets: store.datasets,
    rosterWeekly: store.rosterWeekly,
    playerUniverse: store.playerUniverse,
    nflPlayers: store.nflPlayers,
    crosswalk: store.repos.crosswalk,
    crosswalkOverrides: CHECKED_IN_OVERRIDES,
    recommendationLog: store.repos.recommendationLog,
    projections: store.repos.projections,
    espnProjections: store.repos.espnProjections,
    transactionsSeen: store.repos.transactionsSeen,
    rosterSnapshots: store.repos.rosterSnapshots,
    poolSnapshots: store.repos.poolSnapshots,
    scoreboardSnapshots: store.repos.scoreboardSnapshots,
    leagueSettings: store.repos.leagueSettings,
    refreshLog: store.repos.refreshLog,
    status: {
      credential: credentialView,
      drift: driftView,
      limiter: (nowMs) => {
        try {
          const day = new Date(nowMs);
          const dayStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
          const today = store.repos.limiter.countToday(new Date(dayStart).toISOString());
          return {
            requests_last_minute: store.repos.limiter.countSince(
              new Date(nowMs - 60_000).toISOString(),
            ),
            requests_today:
              today.server.cookie + today.server.keyless + today.job.cookie + today.job.keyless,
          };
        } catch {
          return { requests_last_minute: 0, requests_today: 0 };
        }
      },
      store: () => {
        const s = store.stats();
        return { size_bytes: s.size_bytes, schema_version: s.schema_version };
      },
      checks: () => {
        try {
          return store.repos.leagueSettings.openChecks();
        } catch {
          return [];
        }
      },
      jobs: () => [],
    },
    auth: {
      state: () => authority?.state() ?? "not_configured",
      probe: (r) => provider.probeCredential(r),
    },
    transport: () => provider.transportStatus(),
    beforeCall: () => {
      try {
        store.reopenChangedDatasets();
      } catch (e) {
        logger.warn("store.reopen_failed", { error: e instanceof Error ? e.name : "unknown" });
      }
    },
    golden,
    logger,
  };

  let row = null;
  try {
    row = store.repos.credentialState.get();
  } catch {
    row = null;
  }
  // PHASE W SEAM — NOT IMPLEMENTED (plan 02 §3.2; D11): the four gates are evaluated from persisted
  // evidence for the record; there is no acknowledgement sentence in this build, so they never hold.
  const gates = evaluateRegistrationGates({
    writesRequested: config.writesRequested,
    acknowledgement: config.writesAcknowledgement,
    currentAcknowledgementSha256: null,
    teamId: config.teamId,
    teamIdOrigin: config.origins.ESPN_TEAM_ID,
    credentialRow: row,
    leagueId: config.leagueId,
  });
  // the CPU-deadline switch (changelog R5): off only under the test stubs in fixture mode — both
  // test-scope keys, so a production configuration always keeps the 8 s deadline
  const deadlineOff = fixture && config.testStubs;
  if (deadlineOff) logger.info("services.cpu_deadline_off", { reason: "test_stubs_fixture_mode" });
  const options: McpServerOptions = {
    version: VERSION,
    toolset: config.toolset,
    fixtureMode: fixture,
    ...(fixture ? { spikeNonce: randomBytes(6).toString("hex") } : {}),
    ...(deadlineOff ? { cpuDeadlineMs: null } : {}),
    weatherSource: config.weatherSource,
    writesRequested: config.writesRequested,
    writeGates: { allHold: false, firstFailing: gates.firstFailing ?? "module_not_built" },
    texts: args.texts ?? loadTexts(args.packageRoot),
  };
  return {
    services,
    options,
    provider,
    close: () => {
      authority?.dropSecret();
    },
  };
}
