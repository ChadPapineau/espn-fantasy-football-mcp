// client-config.ts — every place a Claude client registers this server, as `eff doctor` rows #2/#3,
// `eff print-config` and `eff uninstall` need them (plan 03 §4.1–§4.3, §5 #2/#3, §8 step 5; plan 02
// §1: the client configuration is never a cookie location): Claude Desktop's `mcpServers`; Claude
// Code's user scope (`~/.claude.json` `mcpServers`), its LOCAL scope (`projects["<dir>"].mcpServers`,
// `claude mcp add`'s default) and its PROJECT scope (`<dir>/.mcp.json`, a file meant to be committed —
// Stage C finding doctor-project-scope-mcp-json-unscanned: a cookie in it passed row 3 as "skip");
// and the Claude Code plugin (`~/.claude/settings.json` `enabledPlugins`,
// `~/.claude/plugins/installed_plugins.json` — Stage C finding doctor-plugin-install-invisible: a
// plugin user was told no client launches the server and steered to the duplicate registration the
// README forbids). Files are read bounded, never through a symlink, never written; nothing read here
// is printed but names this program owns, paths, scopes and counts — never an env value.
//
// A copy of this plugin (a clone of the repository, an unpacked release: plan 04 §1, §2 `files`)
// holds the plugin's own `.mcp.json` (plan 09 §4), which Claude Code also reads as a PROJECT-scope
// server in a session opened there. That file is no registration: its `${CLAUDE_PLUGIN_ROOT}` and
// `${user_config.*}` expand only in a plugin install, so it cannot start there, and removing its
// entry deletes the plugin's server from the copy (`ClientEntry.pluginSource`; the final gate,
// round 2: such a session ended CONNECTION_CLOSED, row 2 had called the file "entry ok", and
// uninstall printed its `claude mcp remove --scope project`).
import path from "node:path";
import { readSecureFile } from "../config/paths.js";
import { looksLikeCredentialValue } from "../config/schema.js";
import { PLUGIN_ID, PLUGIN_NAME, SERVER_NAME, SIBLING_SERVER_NAME } from "./print-config.js";

/** Largest client config read (a Claude Code user config can be several MB). */
export const MAX_CLIENT_CONFIG_BYTES = 16 * 1024 * 1024;
/** Most `projects[*]` entries of ~/.claude.json scanned (a bound on a file the user owns). */
export const MAX_CLIENT_PROJECTS = 1000;
/** Largest project `.mcp.json` or plugin file read. */
export const MAX_PROJECT_FILE_BYTES = 1024 * 1024;

/** Where a registration lives. */
export type RegistrationScope = "desktop" | "user" | "local" | "project";

/** One `mcpServers` entry: its key, its spec, and where it lives. */
export interface ClientEntry {
  readonly name: string;
  readonly spec: Record<string, unknown>;
  readonly scope: RegistrationScope;
  /** The file holding it. */
  readonly file: string;
  /** The project directory of a local- or project-scope entry, else null. */
  readonly dir: string | null;
  /**
   * The plugin's own declaration, not a registration: a project-scope entry using
   * `${CLAUDE_PLUGIN_ROOT}` in the `.mcp.json` of a copy of this plugin (`isPluginRoot`). Row 3 still
   * checks its env; row 2 and uninstall never treat it as a launch someone registered.
   */
  readonly pluginSource: boolean;
}

/** One entry's env block, where it lives (secrecy is checked over ALL entries — plan 03 §5 #3). */
export interface EnvBlock {
  readonly scope: RegistrationScope;
  readonly file: string;
  readonly dir: string | null;
  /** The entry's key (printed only for an entry of ours). */
  readonly name: string;
  readonly ours: boolean;
  readonly env: Readonly<Record<string, unknown>>;
}

/** A parsed client config and our entries in it. */
export interface ClientConfigScan {
  readonly client: "desktop" | "code";
  readonly file: string;
  readonly state: "ok" | "missing" | "invalid";
  readonly entries: readonly ClientEntry[];
  /** Every entry's env (secrecy is checked over ALL entries — plan 03 §5 #3). */
  readonly envs: readonly Readonly<Record<string, unknown>>[];
  /** The same env blocks, each with where it lives. */
  readonly envBlocks: readonly EnvBlock[];
  /** How many OTHER mcpServers entries it lists (names are never printed). */
  readonly others: number;
  readonly siblingInstalled: boolean;
  /** Claude Code: the project `.mcp.json` files read (project scope), and those that were not JSON. */
  readonly projectFiles: readonly { readonly file: string; readonly state: "ok" | "invalid" }[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The substitutions only Claude Code's plugin loader performs (`${CLAUDE_PLUGIN_ROOT}`,
 * `${CLAUDE_PLUGIN_DATA}`, `${user_config.<key>}`): Claude Desktop's config and Claude Code's user,
 * local and project scopes expand none of them, so an entry using one cannot start there.
 */
const PLUGIN_VARIABLE_RE =
  /\$\{(CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|user_config\.)[^}]{0,128}\}/gu;

/**
 * The plugin variables an entry uses in its `command`, `args` or `env` values, sorted and named
 * value-free (`${user_config.…}` for any user_config key).
 */
export function pluginVariables(spec: Record<string, unknown>): string[] {
  const args: readonly unknown[] = Array.isArray(spec.args) ? spec.args : [];
  const words: unknown[] = [spec.command, ...args];
  if (isObj(spec.env)) words.push(...Object.values(spec.env));
  const out = new Set<string>();
  for (const w of words)
    if (typeof w === "string")
      for (const m of w.matchAll(PLUGIN_VARIABLE_RE))
        out.add(m[1] === "user_config." ? "${user_config.…}" : `\${${m[1] ?? ""}}`);
  return [...out].sort();
}

/**
 * Whether `dir` is a copy of this plugin: `<dir>/.claude-plugin/plugin.json` names it (a clone of the
 * repository, an unpacked release). Read bounded, never through a symlink; unreadable → false.
 */
export function isPluginRoot(dir: string): boolean {
  const manifest = readJson(
    path.join(dir, ".claude-plugin", "plugin.json"),
    MAX_PROJECT_FILE_BYTES,
  );
  return (
    manifest !== null &&
    manifest !== "invalid" &&
    isObj(manifest.value) &&
    manifest.value.name === PLUGIN_NAME
  );
}

/** Whether an entry launches this server (the config key, the dist/cli.js path or the plugin shim). */
export function isOurs(name: string, spec: Record<string, unknown>): boolean {
  if (name === SERVER_NAME) return true;
  const args = Array.isArray(spec.args) ? spec.args : [];
  const strs = args.filter((a): a is string => typeof a === "string");
  return (
    strs.includes("serve") &&
    strs.some(
      (a) => /[/\\]dist[/\\]cli\.js$/.test(a) || /[/\\]scripts[/\\]eff-launch\.sh$/.test(a),
    ) &&
    name !== SIBLING_SERVER_NAME
  );
}

/** One `mcpServers` map and where it lives. */
export interface ServerMap {
  readonly scope: RegistrationScope;
  readonly dir: string | null;
  readonly servers: Record<string, unknown>;
}

/**
 * Every `mcpServers` map of a client config with its scope: the top-level one (Claude Desktop;
 * Claude Code's user scope) and each `projects["<dir>"].mcpServers` (Claude Code's LOCAL scope —
 * `claude mcp add`'s default — which a cookie pasted into an `--env` lands in).
 */
export function scopedServerMaps(client: "desktop" | "code", parsed: unknown): ServerMap[] {
  if (!isObj(parsed)) return [];
  const out: ServerMap[] = [];
  if (isObj(parsed.mcpServers))
    out.push({
      scope: client === "desktop" ? "desktop" : "user",
      dir: null,
      servers: parsed.mcpServers,
    });
  if (isObj(parsed.projects))
    for (const [dir, p] of Object.entries(parsed.projects).slice(0, MAX_CLIENT_PROJECTS))
      if (isObj(p) && isObj(p.mcpServers)) out.push({ scope: "local", dir, servers: p.mcpServers });
  return out;
}

/** Every `mcpServers` map of a client config (the maps of `scopedServerMaps`). */
export function serverMaps(parsed: unknown): Record<string, unknown>[] {
  return scopedServerMaps("code", parsed).map((m) => m.servers);
}

/** The project directories ~/.claude.json knows (bounded; absolute paths only). */
export function projectDirs(parsed: unknown): string[] {
  if (!isObj(parsed) || !isObj(parsed.projects)) return [];
  return Object.keys(parsed.projects)
    .slice(0, MAX_CLIENT_PROJECTS)
    .filter((d) => path.isAbsolute(d));
}

/** A JSON file read bounded and never through a symlink: missing → null, unreadable → "invalid". */
function readJson(file: string, maxBytes: number): { value: unknown } | null | "invalid" {
  let text: string | null;
  try {
    text = readSecureFile(file, { requirePrivate: false, maxBytes, what: "client config" });
  } catch {
    return "invalid";
  }
  if (text === null) return null;
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return "invalid";
  }
}

/**
 * Reads a client config's `mcpServers` — every scope it holds, and for Claude Code also each known
 * project's `.mcp.json` (project scope: `claude mcp add --scope project`, a file meant to be
 * committed, so the most dangerous place for a cookie in an env block).
 */
export function scanClientConfig(client: "desktop" | "code", file: string): ClientConfigScan {
  const empty = {
    client,
    file,
    entries: [],
    envs: [],
    envBlocks: [],
    others: 0,
    siblingInstalled: false,
    projectFiles: [],
  } as const;
  const read = readJson(file, MAX_CLIENT_CONFIG_BYTES);
  if (read === "invalid") return { ...empty, state: "invalid" };
  if (read === null) return { ...empty, state: "missing" };
  const entries: ClientEntry[] = [];
  const envBlocks: EnvBlock[] = [];
  let others = 0;
  let siblingInstalled = false;
  /** `pluginCopy`: the map is the `.mcp.json` of a copy of this plugin (`isPluginRoot`). */
  const take = (m: ServerMap, holder: string, pluginCopy = false): void => {
    for (const [name, spec] of Object.entries(m.servers)) {
      if (!isObj(spec)) continue;
      const ours = isOurs(name, spec);
      if (isObj(spec.env))
        envBlocks.push({ scope: m.scope, file: holder, dir: m.dir, name, ours, env: spec.env });
      if (name === SIBLING_SERVER_NAME) siblingInstalled = true;
      if (ours) {
        const pluginSource = pluginCopy && pluginVariables(spec).includes("${CLAUDE_PLUGIN_ROOT}");
        entries.push({ name, spec, scope: m.scope, file: holder, dir: m.dir, pluginSource });
      } else others++;
    }
  };
  for (const m of scopedServerMaps(client, read.value)) take(m, file);
  const projectFiles: { file: string; state: "ok" | "invalid" }[] = [];
  if (client === "code")
    for (const dir of projectDirs(read.value)) {
      const f = path.join(dir, ".mcp.json");
      const p = readJson(f, MAX_PROJECT_FILE_BYTES);
      if (p === null) continue;
      if (p === "invalid") {
        projectFiles.push({ file: f, state: "invalid" });
        continue;
      }
      projectFiles.push({ file: f, state: "ok" });
      if (isObj(p.value) && isObj(p.value.mcpServers))
        take({ scope: "project", dir, servers: p.value.mcpServers }, f, isPluginRoot(dir));
    }
  return {
    client,
    file,
    state: "ok",
    entries,
    envs: envBlocks.map((b) => b.env),
    envBlocks,
    others,
    siblingInstalled,
    projectFiles,
  };
}

const COOKIE_KEY_RE = /^(?:espn[_-]?s2|swid)$/i;

/** What an env block holds that only the credential store may hold (value-free). */
export function cookieFindings(env: Readonly<Record<string, unknown>>): ("key" | "value")[] {
  const out = new Set<"key" | "value">();
  for (const [k, v] of Object.entries(env)) {
    if (COOKIE_KEY_RE.test(k)) out.add("key");
    else if (typeof v === "string" && looksLikeCredentialValue(v)) out.add("value");
  }
  return [...out];
}

/** Where a registration lives, as one label (`code (local scope, /dir)`). */
export function whereOf(scope: RegistrationScope, dir: string | null): string {
  switch (scope) {
    case "desktop":
      return "desktop";
    case "user":
      return "code (user scope)";
    case "local":
      return `code (local scope, ${dir ?? "?"})`;
    case "project":
      return `code (project scope, ${dir === null ? ".mcp.json" : path.join(dir, ".mcp.json")})`;
  }
}

/** The command that removes a Claude Code registration (`claude mcp remove`, run where it applies). */
export function removeCommand(e: Pick<ClientEntry, "scope" | "dir" | "name">): string {
  const q = (s: string): string =>
    /^[A-Za-z0-9_/.:=@%+,-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
  if (e.scope === "user") return `claude mcp remove --scope user ${q(e.name)}`;
  const scope = e.scope === "project" ? "project" : "local";
  return `cd ${q(e.dir ?? ".")} && claude mcp remove --scope ${scope} ${q(e.name)}`;
}

// --- the Claude Code plugin --------------------------------------------------------------------

/** Claude Code's user settings (`enabledPlugins`). */
export function codeSettingsPath(home: string): string {
  return path.join(home, ".claude", "settings.json");
}

/** Claude Code's record of installed plugins (`plugins["<id>"][].installPath`). */
export function installedPluginsPath(home: string): string {
  return path.join(home, ".claude", "plugins", "installed_plugins.json");
}

/** One installed copy of the plugin. */
export interface PluginCopy {
  readonly scope: string;
  /** The copy Claude Code runs: `<installPath>/scripts/eff-launch.sh serve` → its `dist/cli.js`. */
  readonly installPath: string;
  readonly version: string | null;
}

/** The plugin as Claude Code records it (null: not installed). */
export interface PluginInstall {
  /** `enabledPlugins["<id>"] === true` in the user settings: Claude Code starts its server. */
  readonly enabled: boolean;
  readonly copies: readonly PluginCopy[];
}

const SCOPE_RE = /^[a-z]{1,16}$/;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,40}$/;

/**
 * The espn-fantasy-football plugin's install (`PLUGIN_ID` in installed_plugins.json, enabled in
 * the user settings), or null when it is not installed. Bounded reads; a malformed file reads as
 * not installed / not enabled.
 */
export function scanPlugin(home: string): PluginInstall | null {
  const installed = readJson(installedPluginsPath(home), MAX_PROJECT_FILE_BYTES);
  if (installed === null || installed === "invalid" || !isObj(installed.value)) return null;
  const plugins = installed.value.plugins;
  if (!isObj(plugins)) return null;
  const list = plugins[PLUGIN_ID];
  if (!Array.isArray(list)) return null;
  const copies: PluginCopy[] = [];
  for (const c of list.slice(0, 16)) {
    if (!isObj(c) || typeof c.installPath !== "string" || !path.isAbsolute(c.installPath)) continue;
    copies.push({
      scope: typeof c.scope === "string" && SCOPE_RE.test(c.scope) ? c.scope : "user",
      installPath: c.installPath,
      version: typeof c.version === "string" && VERSION_RE.test(c.version) ? c.version : null,
    });
  }
  if (copies.length === 0) return null;
  const settings = readJson(codeSettingsPath(home), MAX_PROJECT_FILE_BYTES);
  const enabled =
    settings !== null &&
    settings !== "invalid" &&
    isObj(settings.value) &&
    isObj(settings.value.enabledPlugins) &&
    settings.value.enabledPlugins[PLUGIN_ID] === true;
  return { enabled, copies };
}
