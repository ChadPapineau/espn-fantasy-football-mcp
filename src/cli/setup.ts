// setup.ts — `eff setup` wiring (plan 03 §2.1 steps 1–8 and its flags; §2.2 `--page`; plan 02 §2
// lifecycle; plan 07 C12 `--seeding`; changelog V8 `--service-name`): src/auth/setup.ts decides;
// this file supplies the terminal prompt (espn_s2 hidden), the launchd self-test runner, the ESPN
// requests over src/http + the limiter, the config.json writer, the store.sqlite
// `credential_state` row and the logger as the redaction registrar. Nothing here prints a value.
// `--service-name eff-test-…` is test-only: it touches only the throwaway keychain items, opens no
// store.sqlite, writes no config.json, and makes no network call. `--seeding` is its own action: it
// records EFF_SEEDING_MODE + seeding_confirmed_at and acknowledges `settings_changed` (no prompt).
import {
  runSetup,
  type SetupConfigPatch,
  type SetupNetwork,
  type SetupPrompt,
} from "../auth/setup.js";
import { isTestServiceName } from "../auth/keychain.js";
import { openCredentialStores } from "../auth/stores.js";
import type { KeychainSelftestResult } from "../auth/selftest.js";
import {
  ConfigError,
  CREDENTIAL_STORE_KINDS,
  SEEDING_MODES,
  isOneOf,
  type Config,
  type CredentialStoreKind,
  type LenientConfig,
  type SeedingMode,
} from "../config/schema.js";
import { createHttpClient } from "../http/client.js";
import type { Store, StoreFactory } from "../store/types.js";
import { ConfigWriteError, patchConfigFile, type ConfigPatch } from "./config-file.js";
import { createSetupNetwork } from "./espn-http.js";
import { EXIT, UsageError } from "./exit.js";
import { writeLine, type CliIo } from "./io.js";
import type { Logger } from "./log.js";
import { createTerminalPrompt, type TerminalPrompt } from "./prompt.js";
import { loadLenientRuntime, loadRuntime, reportConfigError } from "./runtime.js";
import { createSelftestRunner } from "./selftest-agent.js";
import { portBusyMessage, runSetupPage } from "./setup-page.js";
import { errorText, openStore } from "./store-access.js";

/** The flags of `eff setup`. */
export interface SetupOptions {
  readonly reset: boolean;
  readonly storage: string | undefined;
  readonly seeding: string | undefined;
  readonly serviceName: string | undefined;
  readonly page: boolean;
}

/** Test hooks (never reachable from argv). */
export interface SetupDepsOverride {
  readonly network?: SetupNetwork;
  readonly selftest?: (service: string) => Promise<KeychainSelftestResult>;
  readonly prompt?: TerminalPrompt;
  readonly factory?: StoreFactory;
  readonly signal?: AbortSignal;
}

/** The config.json patch a SetupConfigPatch becomes (string values; null removes). */
export function configPatchOf(p: SetupConfigPatch): ConfigPatch {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(p) as [string, string | null | undefined][])
    if (v !== undefined) out[k] = v;
  return out;
}

/** Validates the flag combinations (plan 03 §2.1; changelog V8). */
export function checkSetupFlags(o: SetupOptions): void {
  if (o.storage !== undefined && !isOneOf(CREDENTIAL_STORE_KINDS, o.storage))
    throw new UsageError("setup: --storage must be keychain or file");
  if (o.seeding !== undefined) {
    if (!isOneOf(SEEDING_MODES, o.seeding))
      throw new UsageError("setup: --seeding must be espn_rule or points_only");
    if (o.reset || o.page || o.storage !== undefined || o.serviceName !== undefined)
      throw new UsageError("setup: --seeding is its own action; run it without other flags");
  }
  if (o.serviceName !== undefined) {
    if (!isTestServiceName(o.serviceName))
      throw new UsageError(
        "setup: --service-name is test-only and must start with eff-test- (letters, digits, . _ - after it)",
      );
    if (o.page) throw new UsageError("setup: --service-name cannot be combined with --page");
  }
  if (o.page && o.reset) throw new UsageError("setup: --page cannot be combined with --reset");
}

/** A prompt that answers from fixed values (the page's posted pair), then reports closed input. */
export function fixedAnswers(values: readonly string[]): SetupPrompt {
  const queue = [...values];
  return {
    ask: () => {
      const v = queue.shift();
      return Promise.resolve(v === undefined ? { kind: "closed" } : { kind: "answer", value: v });
    },
  };
}

/** `eff setup --seeding <mode>`: record the reading and acknowledge `settings_changed`. */
async function recordSeeding(
  io: CliIo,
  mode: SeedingMode,
  log: Logger,
  config: LenientConfig,
  factory: StoreFactory | undefined,
): Promise<number> {
  const at = io.clock.nowIso();
  try {
    patchConfigFile(
      { configDir: config.configDir, home: io.home, repoRoot: io.packageRoot, xattr: io.xattr },
      { EFF_SEEDING_MODE: mode, seeding_confirmed_at: at },
    );
  } catch (e) {
    await writeLine(io.stderr, `eff setup: config.json could not be written: ${errorText(e)}`);
    return EXIT.error;
  }
  let acked = 0;
  try {
    const store = openStore(config, io.clock, log, {
      migrate: true,
      ...(factory ? { factory } : {}),
    });
    try {
      acked = store.repos.leagueSettings.acknowledgeChecks("settings_changed", at, "setup", at);
    } finally {
      store.close();
    }
  } catch (e) {
    log.warn("setup.seeding_ack_failed", { error: e });
  }
  await writeLine(
    io.stdout,
    `Seeding reading recorded: ${mode} (confirmed now)${acked > 0 ? `; ${String(acked)} settings-changed check(s) acknowledged` : ""}.`,
  );
  if (config.origins.EFF_SEEDING_MODE === "env")
    await writeLine(
      io.stdout,
      "Note: EFF_SEEDING_MODE is also set in the environment, which wins over config.json — remove it there.",
    );
  return EXIT.ok;
}

const unusedNetwork: SetupNetwork = {
  anonymousSettings: () => Promise.resolve({ error: "test_mode" }),
  anonymousBoard: () => Promise.resolve({ error: "test_mode" }),
  settingsWithCookies: () => Promise.resolve({ error: "test_mode" }),
  boardWithCookies: () => Promise.resolve({ error: "test_mode" }),
  resolveTeam: () => Promise.resolve({ kind: "error", code: "test_mode" }),
};

/** `eff setup`. */
export async function setup(
  io: CliIo,
  opts: SetupOptions,
  over: SetupDepsOverride = {},
): Promise<number> {
  checkSetupFlags(opts);
  const testMode = opts.serviceName !== undefined;

  if (opts.seeding !== undefined) {
    const { config, log } = await loadLenientRuntime(io);
    return recordSeeding(io, opts.seeding as SeedingMode, log, config, over.factory);
  }

  // test mode needs no league (it never asks ESPN); every other run does
  let config: Config | LenientConfig;
  let log: Logger;
  try {
    ({ config, log } = testMode ? await loadLenientRuntime(io) : await loadRuntime(io));
  } catch (e) {
    if (e instanceof ConfigError) return EXIT.usage;
    throw e;
  }

  const out = (line: string): void => {
    io.stdout.write(`${line}\n`);
  };
  let store: Store | null = null;
  const prompt = over.prompt ?? createTerminalPrompt({ stdin: io.stdin, out: io.stdout });
  try {
    if (!testMode) {
      try {
        store = openStore(config, io.clock, log, {
          migrate: true,
          ...(over.factory ? { factory: over.factory } : {}),
        });
      } catch (e) {
        await writeLine(io.stderr, `eff setup: store.sqlite could not be opened: ${errorText(e)}`);
        return EXIT.error;
      }
    }
    const stores = openCredentialStores({
      filePath: config.credentialFile,
      home: io.home,
      repoRoot: io.packageRoot,
      xattr: io.xattr,
      loadKeyring: io.loadKeyring,
      ...(testMode ? { service: opts.serviceName } : {}),
    });
    const leagueId = config.leagueId ?? "0";
    const network =
      over.network ??
      (testMode || store === null
        ? unusedNetwork
        : createSetupNetwork(
            {
              http: createHttpClient({
                ...(io.fetch === null ? {} : { fetch: io.fetch }),
                espnReadHost: config.espnReadHost,
                log,
              }),
              limiter: store.repos.limiter,
              clock: io.clock,
              origin: "server",
            },
            { host: config.espnReadHost, season: config.season, leagueId },
          ));

    let answers: SetupPrompt = prompt;
    if (opts.page) {
      const page = await runSetupPage({
        explicitPort: config.setupPort,
        exec: io.exec,
        out,
        signal: over.signal ?? new AbortController().signal,
      });
      if (page.kind === "port_busy") {
        await writeLine(io.stderr, `eff setup: ${portBusyMessage(page.port, page.owner)}`);
        return EXIT.usage;
      }
      if (page.kind !== "values") {
        out(
          page.kind === "timeout"
            ? "No submission within 120 s: run `eff setup --page` again (or `eff setup`). Nothing was stored."
            : "Stopped: nothing was stored.",
        );
        return EXIT.error;
      }
      answers = fixedAnswers([page.swid, page.espn_s2]);
    }

    const result = await runSetup(
      {
        reset: opts.reset,
        storage: (opts.storage as CredentialStoreKind | undefined) ?? null,
        serviceName: opts.serviceName ?? null,
        leagueId,
        season: config.season,
        recordedStore:
          config.origins.EFF_CREDENTIAL_STORE === "file" ? config.credentialStore : null,
        filePath: config.credentialFile,
      },
      {
        prompt: answers,
        out,
        now: () => io.clock.nowIso(),
        stores,
        runSelftest: over.selftest ?? createSelftestRunner(io, config.cacheDir),
        network,
        config: {
          record: (patch) => {
            if (testMode) return Promise.resolve();
            try {
              patchConfigFile(
                {
                  configDir: config.configDir,
                  home: io.home,
                  repoRoot: io.packageRoot,
                  xattr: io.xattr,
                },
                configPatchOf(patch),
              );
              return Promise.resolve();
            } catch (e) {
              return Promise.reject(
                e instanceof ConfigWriteError ? e : new ConfigWriteError("write failed"),
              );
            }
          },
        },
        credentialState: store?.repos.credentialState ?? null,
        registrar: log,
      },
    );
    log.info("setup.done", {
      exit: result.exitCode,
      state: result.state,
      store: result.store,
      probe: result.probe,
      selftest: result.selftest,
    });
    return result.exitCode;
  } catch (e) {
    if (e instanceof ConfigError) {
      await reportConfigError(io, e);
      return EXIT.usage;
    }
    throw e;
  } finally {
    prompt.close();
    store?.close();
  }
}
