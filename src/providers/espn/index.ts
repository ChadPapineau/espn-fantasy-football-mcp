// index.ts — the ESPN provider's public surface and its one wiring helper (plan 01 §9, §10; plan 05
// §3.1 step 5 fixture mode): `createEspnProvider` builds an EspnProvider from the resolved Config,
// the store's repositories (league_settings among them: every settings answer is recorded, plan 08
// §9), the CredentialAuthority and the scoring translator. Fixture mode
// (`EFF_FIXTURE_DIR`) swaps the network fetch for the recorded fixtures and REFUSES to start when a
// credential is configured — fixture mode and real cookies never coexist in one process.
// PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; owner decision D11): no write provider is built here.
import { existsSync } from "node:fs";
import path from "node:path";
import type { CredentialAuthority, CredentialObserver } from "../../auth/types.js";
import type { TtlContext } from "../../config/freshness.js";
import type { Config } from "../../config/schema.js";
import type { Clock } from "../../domain/clock.js";
import type { DriftObservations } from "../../drift/types.js";
import type { RequestOrigin, StoreRepositories } from "../../store/types.js";
import { createFixtureFetch } from "./fixture.js";
import { createDerivedLeagueFetch, readDerivedManifest } from "./fixture-league.js";
import { EspnProvider, type ProScheduleDataset } from "./provider.js";
import { EspnProviderError, type ProviderLog } from "./request.js";
import type { FetchLike } from "./transport.js";
import type { ScoringSettingsTranslator } from "./types.js";

export { EspnProvider, ESPN_PROVIDER_WRITES, PLAYERCARD_IDS_MAX } from "./provider.js";
export type { EspnProviderDeps, ProScheduleDataset } from "./provider.js";
export { createFixtureFetch, FixtureError, composeBodies } from "./fixture.js";
export {
  applyJsonPatch,
  createDerivedLeagueFetch,
  derivedLeagueClock,
  DERIVED_LEAGUE_KIND,
  poolQuery,
  readDerivedManifest,
} from "./fixture-league.js";
export { EspnDriftError, EspnUpstreamError, isEspnUpstreamError } from "./errors.js";
export type { FetchLike } from "./transport.js";
export type { ProviderLog } from "./request.js";

/** Where fixture mode's files are: the `fixtures/espn` directory and the recorded league slot. */
export interface FixtureLocation {
  readonly dir: string;
  readonly league: string;
  /**
   * `recorded` (fixtures/espn, exact recorded requests) or `derived` (a derived fixture league such
   * as fixtures/espn/fx-10h or one of its variant directories — served by view and filter).
   */
  readonly kind?: "recorded" | "derived";
}

const SLOT_RE = /^league-[a-z]$/;

/**
 * Resolves `EFF_FIXTURE_DIR` (absolute): a derived fixture league (its manifest.json has `kind:
 * "derived_league"` — fixtures/espn/fx-10h or a variant directory), the `fixtures/espn` directory
 * (its manifest.json present; slot `league-a`) or one recorded league directory
 * `…/fixtures/espn/recorded/<slot>`. Null when none of these shapes is found.
 */
export function resolveFixtureDir(dir: string): FixtureLocation | null {
  if (!path.isAbsolute(dir)) return null;
  const derived = readDerivedManifest(dir);
  if (derived !== null) return { dir, league: derived.league, kind: "derived" };
  if (existsSync(path.join(dir, "manifest.json"))) return { dir, league: "league-a" };
  const slot = path.basename(dir);
  const root = path.dirname(path.dirname(dir));
  if (SLOT_RE.test(slot) && existsSync(path.join(root, "manifest.json")))
    return { dir: root, league: slot };
  return null;
}

/** What the wiring hands the provider. */
export interface CreateEspnProviderOptions {
  readonly config: Pick<
    Config,
    "leagueId" | "season" | "teamId" | "espnReadHost" | "fixtureRecord" | "fixtureDir"
  >;
  /**
   * The store's repositories; `credentialState` (read only — the definitive probe's plan reads
   * setup's board control and the rejected view, plan 02 §2.1) and `leagueSettings` (each settings
   * answer recorded; the store raises `settings_changed` — plan 08 §9, plan 03 §5 #22; its open
   * checks read for the scoring golden's league-wide verdict, which outdates the cached settings —
   * plan 08 §6 step 3(d)) when the root passes them, as `store.repos` does.
   */
  readonly repos: Pick<StoreRepositories, "limiter" | "espnCache" | "driftState"> & {
    readonly credentialState?: Pick<StoreRepositories["credentialState"], "get">;
    readonly leagueSettings?: Pick<StoreRepositories["leagueSettings"], "put" | "openChecks">;
  };
  readonly credentials: CredentialAuthority | null;
  readonly clock: Clock;
  readonly scoring: ScoringSettingsTranslator;
  /** Default: the global fetch (never used in fixture mode). */
  readonly fetch?: FetchLike;
  readonly origin?: RequestOrigin;
  readonly observer?: CredentialObserver;
  readonly probeObserver?: CredentialObserver;
  readonly observations?: DriftObservations;
  readonly ttlContext?: () => TtlContext;
  readonly periodProvisional?: (season: number, week: number) => boolean | null;
  /**
   * The store's pro-schedule dataset (`store.datasets.proSchedule`): every player's `bye_week`
   * (EspnProviderDeps.proSchedule). Without it `bye_week` is null.
   */
  readonly proSchedule?: ProScheduleDataset;
  readonly log?: ProviderLog;
}

/** Builds the provider (see the file header for fixture mode's guard). */
export function createEspnProvider(o: CreateEspnProviderOptions): EspnProvider {
  let fetchFn: FetchLike = o.fetch ?? ((url, init) => fetch(url, init));
  let credentials = o.credentials;
  let tlsVerificationDisabled: (() => boolean) | undefined;
  if (o.config.fixtureDir !== null) {
    if (credentials !== null && credentials.state() !== "not_configured")
      throw new EspnProviderError("INTERNAL", "fixture_mode_with_credentials");
    const loc = resolveFixtureDir(o.config.fixtureDir);
    if (loc === null) throw new EspnProviderError("INTERNAL", "fixture_dir_not_found");
    fetchFn =
      loc.kind === "derived" ? createDerivedLeagueFetch({ dir: loc.dir }) : createFixtureFetch(loc);
    credentials = null;
    // fixture mode reads recorded files and opens no connection: no TLS policy applies to it
    tlsVerificationDisabled = () => false;
  }
  return new EspnProvider({
    config: o.config,
    fetch: fetchFn,
    credentials,
    repos: {
      limiter: o.repos.limiter,
      cache: o.repos.espnCache,
      driftState: o.repos.driftState,
      ...(o.repos.credentialState === undefined
        ? {}
        : { credentialState: o.repos.credentialState }),
      ...(o.repos.leagueSettings === undefined ? {} : { leagueSettings: o.repos.leagueSettings }),
    },
    clock: o.clock,
    scoring: o.scoring,
    ...(o.origin === undefined ? {} : { origin: o.origin }),
    ...(o.observer === undefined ? {} : { observer: o.observer }),
    ...(o.probeObserver === undefined ? {} : { probeObserver: o.probeObserver }),
    ...(o.observations === undefined ? {} : { observations: o.observations }),
    ...(o.ttlContext === undefined ? {} : { ttlContext: o.ttlContext }),
    ...(o.periodProvisional === undefined ? {} : { periodProvisional: o.periodProvisional }),
    ...(o.proSchedule === undefined ? {} : { proSchedule: o.proSchedule }),
    ...(o.log === undefined ? {} : { log: o.log }),
    ...(tlsVerificationDisabled === undefined ? {} : { tlsVerificationDisabled }),
  });
}
