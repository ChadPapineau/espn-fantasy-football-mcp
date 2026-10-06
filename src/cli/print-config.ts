// print-config.ts — `eff print-config --client desktop|code` (plan 03 L4, §4.1–§4.3; ADV OBJ-10,
// OBJ-11): the launch configuration with ABSOLUTE paths — `command` = the exact node binary running
// `eff` (process.execPath, which survives version managers and a GUI client's minimal PATH),
// `args[0]` = the absolute `dist/cli.js` — under the config key `espn-fantasy-football`, plus only
// the non-secret settings the server cannot read from config.json (those that came from the
// environment) and EFF_CONFIG_DIR/EFF_CACHE_DIR when overridden. Never a cookie, an API key,
// EFF_CREDENTIAL_STORE/FILE (plan 03 §3) or a test key. Warns when the runtime install sits under a
// file-provider (iCloud) or synced directory. Ported from sibling @5daa625, adapted.
import { existsSync } from "node:fs";
import path from "node:path";
import { assertNotSynced, fileProviderMarks, PathSecurityError } from "../config/paths.js";
import type { ConfigKey, LenientConfig } from "../config/schema.js";
import { EXIT, UsageError } from "./exit.js";
import { distEntry, write, writeLine, type CliIo } from "./io.js";

/** The client-config key (plan 03 §4.1: distinct from the sibling's `fantasy-football`). */
export const SERVER_NAME = "espn-fantasy-football";
/** The sibling's key: doctor #2 says both are installed when it is present (plan 03 §5 #2). */
export const SIBLING_SERVER_NAME = "fantasy-football";
/** The clients `print-config` knows. */
export const CLIENTS = ["desktop", "code"] as const;
export type Client = (typeof CLIENTS)[number];

/** A launch configuration: an absolute command, absolute args, and non-secret env. */
export interface LaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** The server-scope keys copied when they came from the environment (never secrets/credential keys). */
const COPIED_FROM_ENV: readonly ConfigKey[] = [
  "ESPN_LEAGUE_ID",
  "ESPN_SEASON",
  "ESPN_TEAM_ID",
  "EFF_TOOLSET",
  "EFF_SEEDING_MODE",
  "EFF_WEATHER_SOURCE",
  "EFF_PROBE_LEAGUE_ID",
  "EFF_ESPN_READ_HOST",
];

function resolvedValue(config: LenientConfig, key: ConfigKey): string | null {
  switch (key) {
    case "ESPN_LEAGUE_ID":
      return config.leagueId;
    case "ESPN_SEASON":
      return String(config.season);
    case "ESPN_TEAM_ID":
      return config.teamId === null ? null : String(config.teamId);
    case "EFF_TOOLSET":
      return config.toolset;
    case "EFF_SEEDING_MODE":
      return config.seedingMode;
    case "EFF_WEATHER_SOURCE":
      return config.weatherSource;
    case "EFF_PROBE_LEAGUE_ID":
      return config.probeLeagueId;
    case "EFF_ESPN_READ_HOST":
      return config.espnReadHost;
    default:
      return null;
  }
}

/** The env block: EFF_LOG_LEVEL always; env-sourced non-secret keys; the dir overrides. */
export function launchEnv(config: LenientConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of COPIED_FROM_ENV) {
    if (config.origins[key] !== "env") continue;
    const v = resolvedValue(config, key);
    if (v !== null) env[key] = v;
  }
  if (config.origins.EFF_CONFIG_DIR === "env") env.EFF_CONFIG_DIR = config.configDir;
  if (config.origins.EFF_CACHE_DIR === "env") env.EFF_CACHE_DIR = config.cacheDir;
  env.EFF_LOG_LEVEL = config.logLevel;
  return env;
}

/** `dist/cli.js` is missing: the package has not been built. */
export class MissingBuildError extends Error {
  readonly entry: string;
  constructor(entry: string) {
    super("dist/cli.js does not exist — run `npm run build` first");
    this.name = "MissingBuildError";
    this.entry = entry;
  }
}

/** The launch spec for `serve` (throws MissingBuildError for an unbuilt checkout). */
export function launchSpec(
  io: Pick<CliIo, "execPath" | "packageRoot">,
  config: LenientConfig,
  subcommand: readonly string[] = ["serve"],
): LaunchSpec {
  const entry = distEntry(io.packageRoot);
  if (!path.isAbsolute(io.execPath) || !path.isAbsolute(entry))
    throw new Error("print-config: node and dist/cli.js paths must be absolute");
  if (!existsSync(entry)) throw new MissingBuildError(entry);
  return { command: io.execPath, args: [entry, ...subcommand], env: launchEnv(config) };
}

/** The Claude Desktop `mcpServers` snippet (plan 03 §4.1). */
export function desktopSnippet(spec: LaunchSpec): string {
  const snippet = {
    mcpServers: {
      [SERVER_NAME]: { command: spec.command, args: [...spec.args], env: { ...spec.env } },
    },
  };
  return JSON.stringify(snippet, null, 2);
}

const SHELL_SAFE = /^[A-Za-z0-9_/.:=@%+,-]+$/;

/** Quotes one word for a POSIX shell (single quotes; `'` → `'\''`). */
export function shellQuote(word: string): string {
  if (word !== "" && SHELL_SAFE.test(word)) return word;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The `claude mcp add` command line (plan 03 §4.2): user scope; `--` separates the command. */
export function codeCommand(spec: LaunchSpec): string {
  const words = ["claude", "mcp", "add", "--scope", "user", "--transport", "stdio"];
  for (const [k, v] of Object.entries(spec.env)) words.push("--env", `${k}=${v}`);
  words.push(SERVER_NAME, "--", spec.command, ...spec.args);
  return words.map(shellQuote).join(" ");
}

/** Where Claude Desktop's config lives (plan 03 §4.1 A-7 — doctor accepts --client-config). */
export function desktopConfigPath(home: string): string {
  return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
}

/** Claude Code's user config (plan 03 §4.2: `--scope user` stores the entry in ~/.claude.json). */
export function codeConfigPath(home: string): string {
  return path.join(home, ".claude.json");
}

/**
 * Why the runtime install is in a bad place (plan 03 §4.1 ADV OBJ-10): the directory holding
 * `dist/cli.js` (or an ancestor below home) carries a file-provider xattr, or sits in a synced folder
 * by name. Empty when fine; a reader failure is reported as one finding (fail loud, not silent).
 */
export function runtimeLocationProblems(
  io: Pick<CliIo, "home" | "xattr">,
  entry: string,
): string[] {
  const dir = path.dirname(entry);
  const out: string[] = [];
  try {
    const marks = fileProviderMarks(dir, io.home, io.xattr, "runtime install");
    for (const m of marks.slice(0, 3))
      out.push(`${m.path} carries the file-provider attribute ${m.attr}`);
  } catch (e) {
    out.push(
      e instanceof PathSecurityError ? `${dir}: ${e.detail}` : `${dir}: could not be checked`,
    );
  }
  try {
    assertNotSynced(dir, io.home, "runtime install");
  } catch (e) {
    if (e instanceof PathSecurityError) out.push(`${dir}: ${e.detail}`);
  }
  return out;
}

/** The warning lines for a runtime install under a file-provider or synced directory. */
export function runtimeLocationWarning(problems: readonly string[]): string[] {
  if (problems.length === 0) return [];
  return [
    "eff print-config: warning: the runtime install is under a file-provider (iCloud) or synced directory:",
    ...problems.map((p) => `  ${p}`),
    "  iCloud eviction breaks launches silently — use a clone outside it (e.g. ~/Developer/…) or `npm install -g` from the release tarball (plan 03 §4.1).",
  ];
}

/** `eff print-config`: the snippet on stdout; where to paste it and any warning on stderr. */
export async function printConfig(
  io: CliIo,
  config: LenientConfig,
  client: string | undefined,
): Promise<number> {
  if (client === undefined || !(CLIENTS as readonly string[]).includes(client))
    throw new UsageError("print-config needs --client desktop or --client code");
  let spec: LaunchSpec;
  try {
    spec = launchSpec(io, config);
  } catch (e) {
    if (e instanceof MissingBuildError) {
      await writeLine(io.stderr, `eff print-config: ${e.message} (expected ${e.entry})`);
      return EXIT.error;
    }
    throw e;
  }
  const text = client === "desktop" ? desktopSnippet(spec) : codeCommand(spec);
  await write(io.stdout, `${text}\n`);
  for (const l of runtimeLocationWarning(runtimeLocationProblems(io, spec.args[0] ?? "")))
    await writeLine(io.stderr, l);
  if (config.leagueId === null)
    await writeLine(
      io.stderr,
      "eff print-config: ESPN_LEAGUE_ID is not set: add it to the env block above or to config.json before starting the server.",
    );
  await writeLine(
    io.stderr,
    client === "desktop"
      ? `eff print-config: merge the mcpServers entry into ${desktopConfigPath(io.home)}, then restart Claude Desktop.`
      : "eff print-config: run the command above in a terminal (user scope, so nothing lands in a repository's .mcp.json).",
  );
  return EXIT.ok;
}
