// espn-stack.ts — the composition root for every non-serve subcommand that reads ESPN (plan 01 §10,
// plan 03 §1.1 steps 3–4, plan 06 §1.4): the ONE credential store config.json records (plan 03 §3),
// the CredentialAuthority over the store.sqlite `credential_state` row (never a keychain read at
// construction), the probe access the definitive check needs from `rejected` (the daily
// `credential check`, `eff doctor --online`, `eff check-auth` — plan 02 §2.1: "the one job exempt
// from the short-circuit"), and the EspnProvider wired with the scoring translator, the drift
// observations (when the checkout ships the manifest) and the job/server request origin.
// PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; owner decision D11): no write provider is composed.
import { existsSync } from "node:fs";
import path from "node:path";
import { cookieUnavailableFor } from "../auth/errors.js";
import { fileStoreExistsSync } from "../auth/file.js";
import { buildCookieHeader } from "../auth/format.js";
import { registerCredentialRedaction } from "../auth/redact.js";
import { createCredentialAuthority, type CredentialAuthorityHandle } from "../auth/state.js";
import { openCredentialStore, openCredentialStores } from "../auth/stores.js";
import type {
  CookieHeaderResult,
  CredentialObserver,
  CredentialStore,
  SecretRegistrar,
} from "../auth/types.js";
import type { Config } from "../config/schema.js";
import { translateScoringInput } from "../domain/scoring/index.js";
import { loadObservations, MANIFEST_PATH, type DriftObservations } from "../drift/index.js";
import { createEspnProvider, type EspnProvider } from "../providers/espn/index.js";
import type { LeagueRef } from "../providers/platform.js";
import type { RequestOrigin, Store } from "../store/types.js";
import type { CliIo } from "./io.js";
import { nextCredentialCheckAt } from "./launchd.js";
import type { Logger } from "./log.js";

/** The credential store config.json records (plan 03 §3), opened lazily (nothing touched here). */
export function recordedCredentialStore(io: CliIo, config: Config): CredentialStore {
  return openCredentialStore(config.credentialStore, {
    filePath: config.credentialFile,
    home: io.home,
    repoRoot: io.packageRoot,
    xattr: io.xattr,
    loadKeyring: io.loadKeyring,
  });
}

/** Both real-service stores (uninstall, doctor #6, setup --reset). */
export function bothCredentialStores(
  io: CliIo,
  config: Pick<Config, "credentialFile">,
  service?: string,
): ReturnType<typeof openCredentialStores> {
  return openCredentialStores({
    filePath: config.credentialFile,
    home: io.home,
    repoRoot: io.packageRoot,
    xattr: io.xattr,
    loadKeyring: io.loadKeyring,
    ...(service === undefined ? {} : { service }),
  });
}

/** The authority plus probe access (the provider's `CredentialProbeAccess`). */
export type ProbingAuthority = CredentialAuthorityHandle & {
  getCookieHeaderForProbe(): Promise<CookieHeaderResult>;
};

/**
 * Adds probe access: the definitive check reads the stored value directly — even while `rejected`
 * — so a probe can flip `rejected → validated` without a human (plan 02 §2.1, ADV OBJ-04). The
 * value is registered with the redactor before it is used; it is never returned or logged.
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

/** The drift observations the checkout ships (fixtures/drift/manifest.json), or undefined. */
export function driftObservations(io: CliIo, log: Logger): DriftObservations | undefined {
  const file = path.join(io.packageRoot, MANIFEST_PATH);
  if (!existsSync(file)) return undefined;
  try {
    return loadObservations(file);
  } catch {
    log.warn("drift.manifest_unreadable");
    return undefined;
  }
}

/** The league the configuration names. */
export function leagueRefOf(config: Pick<Config, "leagueId" | "season">): LeagueRef {
  return { platform: "espn", league_id: config.leagueId, season: config.season };
}

/** The composed ESPN stack. */
export interface EspnStack {
  readonly provider: EspnProvider;
  /** null in fixture mode (fixture mode and real cookies never coexist — plan 05 §3.1 step 5). */
  readonly authority: ProbingAuthority | null;
  readonly ref: LeagueRef;
  /** Drops the in-memory secret (plan 03 §1.3). */
  close(): void;
}

/** Options of `buildEspnStack`. */
export interface EspnStackOptions {
  /** `job` for launchd jobs (the daily caps bind them), `server` for interactive commands. */
  readonly origin: RequestOrigin;
  /** Who records ordinary observations. */
  readonly observer: CredentialObserver;
  /** Who records the explicit probe's observation (`daily_job`, `doctor`, `check_auth`). */
  readonly probeObserver?: CredentialObserver;
}

/** Builds the provider and the authority for a subcommand (no network, no keychain read here). */
export function buildEspnStack(
  io: CliIo,
  config: Config,
  store: Store,
  log: Logger,
  opts: EspnStackOptions,
): EspnStack {
  const fixture = config.fixtureDir !== null;
  let authority: ProbingAuthority | null = null;
  if (!fixture) {
    const credStore = recordedCredentialStore(io, config);
    const handle = createCredentialAuthority({
      store: credStore,
      repo: store.repos.credentialState,
      leagueId: config.leagueId,
      registrar: log,
      observer: opts.observer,
      now: () => io.clock.nowIso(),
      fileStoreExists:
        config.credentialStore === "file" ? safeExists(config.credentialFile) : false,
      nextProbeAt: nextCredentialCheckAt,
      onWarning: (code) => {
        log.warn("credential.warning", { code });
      },
    });
    authority = withProbeAccess(handle, credStore, log);
  }
  const observations = driftObservations(io, log);
  const provider = createEspnProvider({
    config,
    repos: store.repos,
    credentials: authority,
    clock: io.clock,
    scoring: translateScoringInput,
    ...(io.fetch === null ? {} : { fetch: io.fetch }),
    origin: opts.origin,
    observer: opts.observer,
    ...(opts.probeObserver === undefined ? {} : { probeObserver: opts.probeObserver }),
    ...(observations === undefined ? {} : { observations }),
    log,
  });
  return {
    provider,
    authority,
    ref: leagueRefOf(config),
    close: () => {
      authority?.dropSecret();
    },
  };
}

function safeExists(p: string): boolean {
  try {
    return fileStoreExistsSync(p);
  } catch {
    return false;
  }
}

const EFF_CODE_RE = /^[A-Z][A-Z0-9_]{1,40}$/;

/** The plan 01 §4.3 code an error carries (`effCode`), or INTERNAL. */
export function effCodeOf(e: unknown): string {
  const c = (e as { effCode?: unknown } | null)?.effCode;
  return typeof c === "string" && EFF_CODE_RE.test(c) ? c : "INTERNAL";
}
