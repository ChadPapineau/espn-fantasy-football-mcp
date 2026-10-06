// main.ts — the `eff` dispatcher (plan 01 §11 / plan 03 §1.1 step 1: `node:util.parseArgs`, exit 2 on
// a usage/config error; §1.3 the shared exit codes; plan 06 J2 one subcommand per job). `serve` is
// handed to src/cli/serve.ts untouched (stdout is the MCP channel — nothing else is written there);
// every other subcommand prints human output on stdout and JSON log lines on stderr. src/cli.ts is
// only the process entry around `main`. Ported from sibling @5daa625, adapted (the ESPN commands).
import { parseArgs, type ParseArgsConfig } from "node:util";
import { resolveAbsolute } from "../config/paths.js";
import { ConfigError } from "../config/schema.js";
import { CHECK_IDS } from "../domain/league/types.js";
import { VERSION } from "../version.js";
import { checkAuth, credentialCheck } from "./credential-check.js";
import { runCrosswalkRebuild } from "./crosswalk.js";
import { doctor } from "./doctor.js";
import { EXIT, UsageError } from "./exit.js";
import { installLaunchd, uninstallLaunchd } from "./install-launchd.js";
import { tolerateClosedPipe, writeLine, type CliIo } from "./io.js";
import { backup, prune } from "./maintenance.js";
import { createNotifier } from "./notify.js";
import { printConfig } from "./print-config.js";
import { probe } from "./probe.js";
import { refresh } from "./refresh.js";
import { bootLevel, loadLenientRuntime, loadRuntime, makeLogger } from "./runtime.js";
import { selftestRead } from "./selftest-agent.js";
import { setup } from "./setup.js";
import {
  preKickoff,
  snapshotPool,
  snapshotProjections,
  snapshotRoster,
  transactionsAppend,
} from "./snapshot.js";
import { status } from "./status.js";
import { errorText, openStore } from "./store-access.js";
import { uninstall } from "./uninstall.js";

// PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; owner decision D11): the writes-phase commands —
// `eff confirm` (the out-of-band confirmation channel, plan 02 §4.2), `eff journal` and
// `eff setup --enable-writes` (the typed acknowledgement, plan 02 §3.2) — would be dispatched here.
// None exists in this build; an unknown flag or command is a usage error (exit 2).

/** The subcommands (selftest-read is internal: run only by setup's one-shot LaunchAgent). */
export const COMMANDS = [
  "serve",
  "setup",
  "status",
  "doctor",
  "check-auth",
  "refresh",
  "probe",
  "snapshot",
  "transactions",
  "credential-check",
  "pre-kickoff",
  "crosswalk",
  "print-config",
  "install-launchd",
  "uninstall-launchd",
  "backup",
  "prune",
  "uninstall",
  "version",
  "help",
  "selftest-read",
] as const;

/** The usage text (stderr for errors, stdout for `eff help`). */
export const USAGE = `usage: eff <command> [options]

  serve                       run the MCP server on stdio (what a client launches)
  setup [--storage keychain|file] [--page] [--reset]
                              store your ESPN cookies (espn_s2 is hidden as you paste) and check them
  setup --seeding espn_rule|points_only
                              record how your league seeds the playoffs
  status [--json]             credential state, drift, data freshness, jobs — the dashboard
  doctor [--json] [--online] [--fix [--yes]] [--ack <check>] [--client-config <path>] [--client-log <path>]
                              diagnose the install; exit code = worst finding
  check-auth [--json]         one credential probe now (at most once a minute)
  refresh <target> [--seasons 2025,2026] [--force] [--notify] [--json]
                              targets: all | espn:schedule | espn:players | nflverse:schedules |
                              nflverse:daily | nflverse:stats | weather | nflverse:<source>
  probe [--host-only] [--notify] [--json]
                              the keyless ESPN drift probe (exit 4 on drift)
  snapshot roster|pool|projections [--pre-kickoff] [--notify]
                              the ESPN snapshot jobs (cookies; read-only)
  transactions [--force] [--notify]
                              append unseen league transactions
  credential-check [--notify] the daily credential probe (launchd)
  pre-kickoff [--notify]      the check before the day's first kickoff (launchd)
  crosswalk rebuild [--notify]
                              re-pair ESPN and nflverse player ids
  print-config --client desktop|code
                              the launch config with absolute paths (no secrets)
  install-launchd [--jobs a,b] [--dry-run]
  uninstall-launchd [--dry-run]
                              install or remove the LaunchAgents (macOS)
  backup [--to <path>] [--notify]
                              consistent backup of store.sqlite (weekly copies keep 4)
  prune [--notify]            drop expired cache rows, old snapshots, debris
  uninstall [--yes] [--dry-run] [--keep-config] [--export-log <path>]
                              remove the jobs, the stored cookies and the data (asks each step)
  version [--json]            print the version
  help                        this text

exit codes: 0 ok · 1 failure · 2 usage or configuration · 3 credentials · 4 drift · 5 serve forced
environment: ESPN_LEAGUE_ID, ESPN_SEASON, EFF_CONFIG_DIR, EFF_CACHE_DIR, EFF_LOG_LEVEL (see README)`;

type Options = NonNullable<ParseArgsConfig["options"]>;

const SPECS: Readonly<Record<string, { options: Options; positionals: number }>> = {
  setup: {
    options: {
      reset: { type: "boolean" },
      storage: { type: "string" },
      seeding: { type: "string" },
      "service-name": { type: "string" },
      page: { type: "boolean" },
    },
    positionals: 0,
  },
  status: { options: { json: { type: "boolean" } }, positionals: 0 },
  doctor: {
    options: {
      json: { type: "boolean" },
      online: { type: "boolean" },
      fix: { type: "boolean" },
      yes: { type: "boolean" },
      ack: { type: "string" },
      "client-config": { type: "string" },
      "client-log": { type: "string" },
    },
    positionals: 0,
  },
  "check-auth": { options: { json: { type: "boolean" } }, positionals: 0 },
  refresh: {
    options: {
      seasons: { type: "string" },
      force: { type: "boolean" },
      notify: { type: "boolean" },
      json: { type: "boolean" },
    },
    positionals: 1,
  },
  probe: {
    options: {
      "host-only": { type: "boolean" },
      notify: { type: "boolean" },
      json: { type: "boolean" },
    },
    positionals: 0,
  },
  snapshot: {
    options: { "pre-kickoff": { type: "boolean" }, notify: { type: "boolean" } },
    positionals: 1,
  },
  transactions: {
    options: { force: { type: "boolean" }, notify: { type: "boolean" } },
    positionals: 0,
  },
  "credential-check": { options: { notify: { type: "boolean" } }, positionals: 0 },
  "pre-kickoff": { options: { notify: { type: "boolean" } }, positionals: 0 },
  crosswalk: { options: { notify: { type: "boolean" } }, positionals: 1 },
  "print-config": { options: { client: { type: "string" } }, positionals: 0 },
  "install-launchd": {
    options: { jobs: { type: "string" }, "dry-run": { type: "boolean" } },
    positionals: 0,
  },
  "uninstall-launchd": { options: { "dry-run": { type: "boolean" } }, positionals: 0 },
  backup: { options: { to: { type: "string" }, notify: { type: "boolean" } }, positionals: 0 },
  prune: { options: { notify: { type: "boolean" } }, positionals: 0 },
  uninstall: {
    options: {
      yes: { type: "boolean" },
      "dry-run": { type: "boolean" },
      "keep-config": { type: "boolean" },
      "export-log": { type: "string" },
    },
    positionals: 0,
  },
  version: { options: { json: { type: "boolean" } }, positionals: 0 },
  help: { options: {}, positionals: 0 },
  "selftest-read": {
    options: { service: { type: "string" }, report: { type: "string" } },
    positionals: 0,
  },
};

/** ` '<name>'` for a command-shaped word; nothing for anything else (a pasted value is never echoed). */
function safeName(command: string): string {
  return /^[a-z][a-z-]{0,30}$/.test(command) ? ` '${command}'` : "";
}

/** Parsed flags of one subcommand. */
export interface Parsed {
  readonly values: Readonly<Record<string, string | boolean | undefined>>;
  readonly positionals: readonly string[];
}

/** Parses a subcommand's argv strictly; any problem is a UsageError (exit 2). Never echoes a value. */
export function parseCommand(command: string, argv: readonly string[]): Parsed {
  const spec = Object.hasOwn(SPECS, command) ? SPECS[command] : undefined;
  if (spec === undefined) throw new UsageError(`unknown command${safeName(command)}`);
  let r: { values: Record<string, unknown>; positionals: string[] };
  try {
    r = parseArgs({ args: [...argv], options: spec.options, strict: true, allowPositionals: true });
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    throw new UsageError(
      code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"
        ? `${command}: unknown option`
        : code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE"
          ? `${command}: an option is missing its value or has the wrong type`
          : `${command}: invalid arguments`,
    );
  }
  if (r.positionals.length > spec.positionals)
    throw new UsageError(`${command}: unexpected argument(s)`);
  const values: Record<string, string | boolean | undefined> = {};
  for (const [k, v] of Object.entries(r.values))
    if (typeof v === "string" || typeof v === "boolean") values[k] = v;
  return { values, positionals: r.positionals };
}

const str = (p: Parsed, k: string): string | undefined => {
  const v = p.values[k];
  return typeof v === "string" ? v : undefined;
};
const flag = (p: Parsed, k: string): boolean => p.values[k] === true;

/** An optional path flag: absolute (or `~/…`) only — a relative path would depend on the cwd. */
function absOption(io: CliIo, v: string | undefined, name: string): string | undefined {
  if (v === undefined) return undefined;
  try {
    return resolveAbsolute(v, io.home, name);
  } catch {
    throw new UsageError(`${name} must be an absolute path (or start with ~/)`);
  }
}

/** The `serve` handler's contract (implemented in src/cli/serve.ts by the MCP layer). */
export type ServeFn = (opts: {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}) => Promise<number>;

/** The serve module's path (a variable: the other subcommands never load the MCP SDK). */
const SERVE_MODULE = "./serve.js";

/** Loads `serve` lazily (src/cli/serve.ts); null when this build has none. */
export async function loadServe(): Promise<ServeFn | null> {
  let mod: unknown;
  try {
    mod = await import(SERVE_MODULE);
  } catch {
    return null;
  }
  const fn = (mod as { serve?: unknown } | null)?.serve;
  return typeof fn === "function" ? (fn as ServeFn) : null;
}

/** Extra wiring for tests (never reachable from argv). */
export interface MainDeps {
  readonly loadServe?: () => Promise<ServeFn | null>;
  /** Aborts a running refresh or setup page (the entry wires SIGINT/SIGTERM to it). */
  readonly signal?: AbortSignal;
}

/**
 * Runs `eff <argv>` and returns the exit code. Never throws: usage and configuration errors are 2,
 * anything else 1 with a one-line stderr message (details at debug level on the logger).
 */
export async function main(
  argv: readonly string[],
  io: CliIo,
  deps: MainDeps = {},
): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined) {
    await writeLine(io.stderr, USAGE);
    return EXIT.usage;
  }
  if (command === "--version" || command === "-v") return main(["version", ...rest], io, deps);
  if (command === "--help" || command === "-h") return main(["help", ...rest], io, deps);
  if (command === "serve") {
    const serve = await (deps.loadServe ?? loadServe)();
    if (serve === null) {
      await writeLine(
        io.stderr,
        "eff serve: the MCP server module is not present in this build (run `npm run build`)",
      );
      return EXIT.error;
    }
    return serve({
      argv: rest,
      env: io.env,
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
    });
  }
  tolerateClosedPipe(io.stdout);
  tolerateClosedPipe(io.stderr);
  const bootLog = makeLogger(io, bootLevel(io.env));
  const signal = deps.signal ?? new AbortController().signal;
  try {
    const p = parseCommand(command, rest);
    switch (command) {
      case "version":
        await writeLine(
          io.stdout,
          flag(p, "json")
            ? JSON.stringify({ version: VERSION, node: io.nodeVersion, exec_path: io.execPath })
            : `eff ${VERSION} (node ${io.nodeVersion})`,
        );
        return EXIT.ok;
      case "help":
        await writeLine(io.stdout, USAGE);
        return EXIT.ok;
      case "doctor": {
        const ack = str(p, "ack");
        if (ack !== undefined && !(CHECK_IDS as readonly string[]).includes(ack))
          throw new UsageError(`doctor: --ack takes one of ${CHECK_IDS.join(" | ")}`);
        return await doctor(io, {
          json: flag(p, "json"),
          online: flag(p, "online"),
          fix: flag(p, "fix"),
          yes: flag(p, "yes"),
          ack,
          clientConfig: absOption(io, str(p, "client-config"), "--client-config"),
          clientLog: absOption(io, str(p, "client-log"), "--client-log"),
        });
      }
      case "setup":
        return await setup(
          io,
          {
            reset: flag(p, "reset"),
            storage: str(p, "storage"),
            seeding: str(p, "seeding"),
            serviceName: str(p, "service-name"),
            page: flag(p, "page"),
          },
          { signal },
        );
      case "selftest-read":
        return await selftestRead(io, { service: str(p, "service"), report: str(p, "report") });
      case "uninstall-launchd":
        return await uninstallLaunchd(io, { dryRun: flag(p, "dry-run") });
      default:
        break;
    }
    if (
      ["check-auth", "credential-check", "snapshot", "transactions", "pre-kickoff"].includes(
        command,
      )
    ) {
      const { config, log } = await loadRuntime(io);
      switch (command) {
        case "check-auth":
          return await checkAuth(io, config, log, { json: flag(p, "json") });
        case "credential-check":
          return await credentialCheck(io, config, log, { notify: flag(p, "notify") });
        case "transactions":
          return await transactionsAppend(io, config, log, {
            notify: flag(p, "notify"),
            force: flag(p, "force"),
          });
        case "pre-kickoff":
          return await preKickoff(io, config, log, { notify: flag(p, "notify") });
        default: {
          const what = p.positionals[0];
          if (what === "roster")
            return await snapshotRoster(io, config, log, {
              notify: flag(p, "notify"),
              preKickoff: flag(p, "pre-kickoff"),
            });
          if (flag(p, "pre-kickoff"))
            throw new UsageError("snapshot: --pre-kickoff applies to `snapshot roster` only");
          if (what === "pool")
            return await snapshotPool(io, config, log, { notify: flag(p, "notify") });
          if (what === "projections")
            return await snapshotProjections(io, config, log, { notify: flag(p, "notify") });
          throw new UsageError("snapshot needs one of: roster | pool | projections");
        }
      }
    }
    const { config, log } = await loadLenientRuntime(io);
    switch (command) {
      case "status":
        return await status(io, config, log, { json: flag(p, "json") });
      case "refresh":
        return await refresh(
          io,
          config,
          log,
          {
            target: p.positionals[0],
            seasons: str(p, "seasons"),
            force: flag(p, "force"),
            notify: flag(p, "notify"),
            json: flag(p, "json"),
          },
          signal,
        );
      case "probe":
        return await probe(io, config, log, {
          hostOnly: flag(p, "host-only"),
          notify: flag(p, "notify"),
          json: flag(p, "json"),
        });
      case "crosswalk": {
        if (p.positionals[0] !== "rebuild") throw new UsageError("crosswalk needs: rebuild");
        const notifier = createNotifier({
          platform: io.platform,
          exec: io.exec,
          clock: io.clock,
          cacheDir: config.cacheDir,
        });
        let store;
        try {
          store = openStore(config, io.clock, log, { migrate: true });
        } catch (e) {
          await writeLine(
            io.stderr,
            `eff crosswalk: the store could not be opened: ${errorText(e)}`,
          );
          return EXIT.error;
        }
        try {
          const r = await runCrosswalkRebuild(
            io,
            config,
            store,
            log,
            flag(p, "notify") ? notifier : null,
          );
          for (const l of r.lines) await writeLine(io.stdout, l);
          return r.code;
        } finally {
          store.close();
        }
      }
      case "print-config":
        return await printConfig(io, config, str(p, "client"));
      case "install-launchd":
        return await installLaunchd(io, config, {
          jobs: str(p, "jobs"),
          dryRun: flag(p, "dry-run"),
        });
      case "backup":
        return await backup(io, config, log, { to: str(p, "to"), notify: flag(p, "notify") });
      case "prune":
        return await prune(io, config, log, { notify: flag(p, "notify") });
      case "uninstall":
        return await uninstall(io, config, log, {
          yes: flag(p, "yes"),
          dryRun: flag(p, "dry-run"),
          keepConfig: flag(p, "keep-config"),
          exportLog: str(p, "export-log"),
        });
      default:
        throw new UsageError(`unknown command${safeName(command)}`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      await writeLine(io.stderr, `eff: ${e.message} (run \`eff help\`)`);
      return EXIT.usage;
    }
    if (e instanceof ConfigError) return EXIT.usage;
    bootLog.error("cli.failed", { command, error: e });
    await writeLine(
      io.stderr,
      `eff${safeName(command)}: unexpected error: ${e instanceof Error ? e.name : "error"} (run with EFF_LOG_LEVEL=debug for detail)`,
    );
    return EXIT.error;
  }
}
