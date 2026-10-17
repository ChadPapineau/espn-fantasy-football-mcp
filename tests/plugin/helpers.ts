// helpers.ts — the plugin's MCP server as Claude Code starts it from `.claude-plugin/plugin.json` and
// `.mcp.json` (plan 09 §4, §6): `${CLAUDE_PLUGIN_ROOT}` and every `${user_config.KEY}` in `command`,
// `args` and `env` are substituted, and `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA` are added to the
// server's environment. Each option's value is what the user saved, else the option's `default`
// (Claude Code's manifest reference: "Value used when the user provides nothing"), else — for an
// optional option that declares none — the empty string; a required option the user left unset has
// no value, and a reference to it keeps the server from starting ("Plugin option … isn't set").
// That is Claude Code 2.1.238's behaviour, the version CI's `claude plugin validate` pins
// (.github/workflows/docs.yml). The server reads an empty value as unset (src/config/schema.ts:
// config.json, then its own default), so an option left empty never pins the plugin's server to a
// value the eff CLI and the launchd jobs do not read.
import { readFileSync } from "node:fs";
import path from "node:path";

/** The repository root, which is the plugin root (plan 09 §4). */
export const ROOT = path.resolve(import.meta.dirname, "..", "..");

/** One `userConfig` option (the manifest's strict option object). */
export interface UserConfigOption {
  readonly type: string;
  readonly title: string;
  readonly description: string;
  readonly required?: boolean;
  readonly default?: string | number | boolean | readonly string[];
  readonly multiple?: boolean;
  readonly sensitive?: boolean;
}

/** The parts of `.claude-plugin/plugin.json` this suite reads. */
export interface PluginManifest {
  readonly name: string;
  readonly userConfig?: Readonly<Record<string, UserConfigOption>>;
}

/** A stdio server entry of `.mcp.json`. */
export interface StdioServer {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/** The plugin as it ships: its manifest and its one MCP server. */
export interface PluginFiles {
  readonly manifest: PluginManifest;
  readonly serverName: string;
  readonly server: StdioServer;
}

/** Reads the manifest and the `.mcp.json` server of the plugin rooted at `root`. */
export function readPlugin(root: string = ROOT): PluginFiles {
  const manifest = JSON.parse(
    readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8"),
  ) as PluginManifest;
  const mcp = JSON.parse(readFileSync(path.join(root, ".mcp.json"), "utf8")) as {
    mcpServers: Record<string, StdioServer>;
  };
  const entries = Object.entries(mcp.mcpServers);
  if (entries.length !== 1) throw new Error(".mcp.json must declare exactly one server");
  const [serverName, server] = entries[0]!;
  return { manifest, serverName, server };
}

/** The value Claude Code substitutes for each declared option (see the header). */
export function optionValues(
  manifest: PluginManifest,
  saved: Readonly<Record<string, string>>,
): Map<string, string> {
  const values = new Map<string, string>();
  for (const [key, option] of Object.entries(manifest.userConfig ?? {})) {
    if (Object.hasOwn(saved, key)) values.set(key, saved[key]!);
    else if (option.default !== undefined) values.set(key, String(option.default));
    else if (option.required !== true) values.set(key, "");
  }
  return values;
}

/** `${CLAUDE_PLUGIN_ROOT}` and every `${user_config.KEY}` substituted in one string. */
export function substitute(s: string, root: string, values: ReadonlyMap<string, string>): string {
  return s
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", root)
    .replace(/\$\{user_config\.([^}]+)\}/g, (_ref, key: string) => {
      const v = values.get(key);
      if (v === undefined) throw new Error(`Plugin option "${key}" isn't set`);
      return v;
    });
}

/** The server's command, args and env as Claude Code starts it for a user who saved `saved`. */
export interface ResolvedServer {
  readonly command: string;
  readonly args: readonly string[];
  /** Only what the plugin sets (Claude Code adds it over the environment it was launched with). */
  readonly env: Readonly<Record<string, string>>;
}

export function resolveServer(
  saved: Readonly<Record<string, string>>,
  opts: { readonly root?: string; readonly dataDir?: string } = {},
): ResolvedServer {
  const root = opts.root ?? ROOT;
  const { manifest, server } = readPlugin(root);
  const values = optionValues(manifest, saved);
  const env: Record<string, string> = {
    CLAUDE_PLUGIN_ROOT: root,
    ...(opts.dataDir === undefined ? {} : { CLAUDE_PLUGIN_DATA: opts.dataDir }),
  };
  for (const [k, v] of Object.entries(server.env ?? {})) env[k] = substitute(v, root, values);
  return {
    command: substitute(server.command, root, values),
    args: server.args.map((a) => substitute(a, root, values)),
    env,
  };
}
