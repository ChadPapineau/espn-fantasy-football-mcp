// runtime.ts — the resolved configuration plus a logger that already knows every secret and
// identifier the configuration holds (plan 03 §3 precedence; plan 01 §8 redaction: the configured
// league ids → `[league]`, API keys → `[redacted]`). A ConfigError is printed one line per issue —
// the key and a fixed reason, never a value — and rethrown for exit 2 (plan 03 §1.1 step 1).
// Ported from sibling @5daa625, adapted (league-id identifiers; lenient mode for doctor/print-config).
import {
  ConfigError,
  LOG_LEVELS,
  identifierValues,
  loadConfigFromProcess,
  secretValues,
  type Config,
  type LenientConfig,
  type LogLevel,
} from "../config/schema.js";
import type { Env } from "../config/paths.js";
import { writeLine, type CliIo } from "./io.js";
import { createLogger, type Logger } from "./log.js";

/** A resolved configuration and its logger. */
export interface Runtime<C extends LenientConfig = Config> {
  readonly config: C;
  readonly log: Logger;
}

/** The logger level before the config is known (EFF_LOG_LEVEL if valid, else warn). */
export function bootLevel(env: Env): LogLevel {
  const v = env.EFF_LOG_LEVEL?.trim();
  return v !== undefined && (LOG_LEVELS as readonly string[]).includes(v)
    ? (v as LogLevel)
    : "warn";
}

/** A stderr logger bound to the io's stderr and clock. */
export function makeLogger(io: Pick<CliIo, "stderr" | "clock">, level: LogLevel): Logger {
  return createLogger({
    level,
    sink: (line) => {
      io.stderr.write(`${line}\n`);
    },
    now: () => io.clock.nowIso(),
  });
}

/** Registers the configuration's secrets and identifiers with a logger (plan 01 §8). */
export function registerConfigRedaction(log: Logger, config: LenientConfig): void {
  for (const s of secretValues(config)) log.registerSecret(s.kind, s.value);
  for (const i of identifierValues(config)) log.registerIdentifier(i.kind, i.value);
}

/** Prints a ConfigError's issues (key + fixed reason; never a value). */
export async function reportConfigError(io: CliIo, e: ConfigError): Promise<void> {
  for (const i of e.issues) await writeLine(io.stderr, `eff: config: ${i.key}: ${i.reason}`);
}

function load(io: CliIo, requireLeagueId: boolean): Config | LenientConfig {
  const opts = {
    env: io.env,
    home: io.home,
    repoRoot: io.packageRoot,
    nowMs: io.clock.nowMs(),
    xattr: io.xattr,
  };
  return requireLeagueId
    ? loadConfigFromProcess(opts)
    : loadConfigFromProcess(opts, { requireLeagueId: false });
}

/** Loads the configuration (ESPN_LEAGUE_ID required) and a logger with its secrets registered. */
export async function loadRuntime(io: CliIo): Promise<Runtime> {
  return (await loadRuntimeWith(io, true)) as Runtime;
}

/** As `loadRuntime`, without requiring ESPN_LEAGUE_ID (print-config, install-launchd, prune…). */
export async function loadLenientRuntime(io: CliIo): Promise<Runtime<LenientConfig>> {
  return loadRuntimeWith(io, false);
}

async function loadRuntimeWith(
  io: CliIo,
  requireLeagueId: boolean,
): Promise<Runtime<LenientConfig>> {
  let config: Config | LenientConfig;
  try {
    config = load(io, requireLeagueId);
  } catch (e) {
    if (e instanceof ConfigError) await reportConfigError(io, e);
    throw e;
  }
  const log = makeLogger(io, config.logLevel);
  registerConfigRedaction(log, config);
  for (const w of config.warnings) log.warn("config.warning", { msg: w });
  return { config, log };
}
