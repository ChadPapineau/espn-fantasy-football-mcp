// index.ts — the ESPN provider's public surface and its one wiring helper (plan 01 §9, §10; plan 05
// §3.1 step 5 fixture mode): `createEspnProvider` builds an EspnProvider from the resolved Config,
// the store's three repositories, the CredentialAuthority and the scoring translator. Fixture mode
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
import { EspnProvider } from "./provider.js";
import { EspnProviderError, type ProviderLog } from "./request.js";
import type { FetchLike } from "./transport.js";
import type { ScoringSettingsTranslator } from "./types.js";

export { EspnProvider, ESPN_PROVIDER_WRITES, PLAYERCARD_IDS_MAX } from "./provider.js";
export type { EspnProviderDeps } from "./provider.js";
export { createFixtureFetch, FixtureError, composeBodies } from "./fixture.js";
export { EspnDriftError, EspnUpstreamError, isEspnUpstreamError } from "./errors.js";
export type { FetchLike } from "./transport.js";
export type { ProviderLog } from "./request.js";

/** Where fixture mode's files are: the `fixtures/espn` directory and the recorded league slot. */
export interface FixtureLocation {
  readonly dir: string;
  readonly league: string;
}

const SLOT_RE = /^league-[a-z]$/;

/**
 * Resolves `EFF_FIXTURE_DIR` (absolute): either the `fixtures/espn` directory (its manifest.json
 * present; slot `league-a`) or one recorded league directory `…/fixtures/espn/recorded/<slot>`.
 * Null when neither shape is found.
 */
export function resolveFixtureDir(dir: string): FixtureLocation | null {
  if (!path.isAbsolute(dir)) return null;
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
  readonly repos: Pick<StoreRepositories, "limiter" | "espnCache" | "driftState">;
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
  readonly log?: ProviderLog;
}

/** Builds the provider (see the file header for fixture mode's guard). */
export function createEspnProvider(o: CreateEspnProviderOptions): EspnProvider {
  let fetchFn: FetchLike = o.fetch ?? ((url, init) => fetch(url, init));
  let credentials = o.credentials;
  if (o.config.fixtureDir !== null) {
    if (credentials !== null && credentials.state() !== "not_configured")
      throw new EspnProviderError("INTERNAL", "fixture_mode_with_credentials");
    const loc = resolveFixtureDir(o.config.fixtureDir);
    if (loc === null) throw new EspnProviderError("INTERNAL", "fixture_dir_not_found");
    fetchFn = createFixtureFetch(loc);
    credentials = null;
  }
  return new EspnProvider({
    config: o.config,
    fetch: fetchFn,
    credentials,
    repos: { limiter: o.repos.limiter, cache: o.repos.espnCache, driftState: o.repos.driftState },
    clock: o.clock,
    scoring: o.scoring,
    ...(o.origin === undefined ? {} : { origin: o.origin }),
    ...(o.observer === undefined ? {} : { observer: o.observer }),
    ...(o.probeObserver === undefined ? {} : { probeObserver: o.probeObserver }),
    ...(o.observations === undefined ? {} : { observations: o.observations }),
    ...(o.ttlContext === undefined ? {} : { ttlContext: o.ttlContext }),
    ...(o.periodProvisional === undefined ? {} : { periodProvisional: o.periodProvisional }),
    ...(o.log === undefined ? {} : { log: o.log }),
  });
}
