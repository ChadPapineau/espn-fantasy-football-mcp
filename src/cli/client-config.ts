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
//
// An entry is this server by what it launches, never by its args' shape (`launchOf`,
// `classifyEntry`; found on the owner's Mac, 2026-11-11: doctor counted the sibling's Yahoo
// server, registered as `fantasy-football-mcp-server` and launching its own `dist/cli.js serve`, as
// a second registration of this one and told him to remove it). And the plugin Claude Code runs is
// the one it reads (`pluginOrigin`): a plugin listed by a folder marketplace (`directory` or `file`
// source, a `./` plugin source) is read in place from that folder, and installed_plugins.json's
// `installPath` cache copy is a leftover there — doctor judged that leftover as what runs.
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { PathSecurityError, readSecureFile } from "../config/paths.js";
import { looksLikeCredentialValue } from "../config/schema.js";
import {
  MARKETPLACE_NAME,
  PACKAGE_NAME,
  PLUGIN_ID,
  PLUGIN_NAME,
  SERVER_NAME,
  SIBLING_PACKAGE_NAME,
  SIBLING_SERVER_NAME,
} from "./print-config.js";

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

/**
 * An entry that is not this server but must be said (value-free: where it lives, and for an
 * undetermined one the path it launches): `foreign` — this server's own key launches another
 * package, so a generic `claude mcp remove espn-fantasy-football` would remove that one;
 * `undetermined` — it launches a `dist/cli.js` or `scripts/eff-launch.sh` whose package doctor
 * cannot read, so it is neither counted as this server nor offered for removal.
 */
export interface NotOursEntry {
  readonly kind: "foreign" | "undetermined";
  readonly scope: RegistrationScope;
  readonly file: string;
  readonly dir: string | null;
  /** The path it launches (undetermined only), control characters dropped, bounded. */
  readonly target: string | null;
  /** Why doctor cannot tell (undetermined only): the file and what is wrong with it. */
  readonly why: string | null;
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
  /** The sibling's server is registered (its package under any key, or its own key). */
  readonly siblingInstalled: boolean;
  /** The other entries that must be said (`NotOursEntry`). */
  readonly notOurs: readonly NotOursEntry[];
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

/** A launched `dist/cli.js` (absolute or not) and the plugin shim, as a word of an entry. */
const CLI_ENTRY_RE = /(?:^|[/\\])dist[/\\]cli\.js$/u;
const SHIM_ENTRY_RE = /(?:^|[/\\])scripts[/\\]eff-launch\.sh$/u;

/**
 * What an entry launches, as far as the files it names tell — read bounded, never through a
 * symlink: `ours` — a `dist/cli.js` whose package root (the directory above `dist/`) has a
 * package.json named `espn-fantasy-football-mcp` (a clone, a release install), or a
 * `scripts/eff-launch.sh` under a copy of this plugin (`isPluginRoot`); `sibling` — the sibling's
 * package; `another` — another package (its package.json or plugin manifest names another);
 * `none` — no `dist/cli.js` or `scripts/eff-launch.sh` in its command line at all (`npx …`, any
 * other program); `unknown` — it launches one, but its path is not absolute or the file that
 * names its package is missing, unreadable, a symbolic link, too large or not JSON.
 */
export type Launch =
  | { readonly kind: "ours" | "sibling" | "another" | "none" }
  | { readonly kind: "unknown"; readonly target: string; readonly why: string };

/** A path or word read from a file, for a detail line: control characters dropped, bounded. */
function shown(s: string, max = 300): string {
  const t = s.replace(/[\u0000-\u001f\u007f]/gu, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** See `Launch`. */
export function launchOf(spec: Record<string, unknown>): Launch {
  const args: readonly unknown[] = Array.isArray(spec.args) ? spec.args : [];
  const words = [spec.command, ...args].filter((w): w is string => typeof w === "string");
  const target = words.find((w) => CLI_ENTRY_RE.test(w) || SHIM_ENTRY_RE.test(w));
  if (target === undefined) return { kind: "none" };
  const unknown = (why: string): Launch => ({ kind: "unknown", target: shown(target), why });
  if (pluginVariables({ command: target }).length > 0)
    return unknown("its path uses a plugin variable, which only a plugin install expands");
  if (!path.isAbsolute(target)) return unknown("its path is not absolute");
  const root = path.dirname(path.dirname(target));
  const shim = SHIM_ENTRY_RE.test(target);
  const file = shim
    ? path.join(root, ".claude-plugin", "plugin.json")
    : path.join(root, "package.json");
  const read = readJsonWhy(file, MAX_PROJECT_FILE_BYTES);
  if ("why" in read) return unknown(`${shown(file)} is ${read.why}`);
  const name = isObj(read.value) ? read.value.name : undefined;
  if (name === (shim ? PLUGIN_NAME : PACKAGE_NAME)) return { kind: "ours" };
  return { kind: !shim && name === SIBLING_PACKAGE_NAME ? "sibling" : "another" };
}

/**
 * Whose an entry is — the one rule doctor rows #2/#3/#13 and uninstall's printed steps share. What it
 * launches decides, whatever its key: this package is `ours` (a `claude mcp add` of the runtime
 * clone or a release install under any key, any scope — a real second registration); the sibling's
 * package is `sibling`; another package is not ours, under any key — this server's own key
 * included (`foreign`: a generic `claude mcp remove espn-fantasy-football` would remove it). Only
 * when what it launches cannot be told does the key decide: `espn-fantasy-football` stays `ours`
 * (so a broken registration of ours is still diagnosed — a missing build, a relative path, a
 * plugin variable), `fantasy-football` stays the sibling's, and any other key is `undetermined`
 * when it launches a `dist/cli.js`/`eff-launch.sh` doctor cannot read (said once, never counted,
 * never offered for removal) or `other` when it launches neither.
 */
export function classifyEntry(
  name: string,
  spec: Record<string, unknown>,
): {
  readonly owner: "ours" | "sibling" | "foreign" | "undetermined" | "other";
  readonly launch: Launch;
} {
  const launch = launchOf(spec);
  switch (launch.kind) {
    case "ours":
      return { owner: "ours", launch };
    case "sibling":
      return { owner: name === SERVER_NAME ? "foreign" : "sibling", launch };
    case "another":
      return {
        owner:
          name === SERVER_NAME ? "foreign" : name === SIBLING_SERVER_NAME ? "sibling" : "other",
        launch,
      };
    case "none":
    case "unknown":
      return {
        owner:
          name === SERVER_NAME
            ? "ours"
            : name === SIBLING_SERVER_NAME
              ? "sibling"
              : launch.kind === "unknown"
                ? "undetermined"
                : "other",
        launch,
      };
  }
}

/** Whether an entry is this server (`classifyEntry`). */
export function isOurs(name: string, spec: Record<string, unknown>): boolean {
  return classifyEntry(name, spec).owner === "ours";
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

/**
 * A JSON file read bounded and never through a symlink, or what stopped it (said as "<file> is
 * <why>").
 */
function readJsonWhy(file: string, maxBytes: number): { value: unknown } | { why: string } {
  let text: string | null;
  try {
    text = readSecureFile(file, { requirePrivate: false, maxBytes, what: "client config" });
  } catch (e) {
    if (e instanceof PathSecurityError)
      switch (e.reason) {
        case "symlink":
          return { why: "a symbolic link (never followed)" };
        case "too_large":
          return { why: `larger than ${String(maxBytes)} bytes` };
        case "not_regular_file":
          return { why: "not a regular file" };
        default:
          return { why: "unreadable" };
      }
    return { why: "unreadable" };
  }
  if (text === null) return { why: "missing" };
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return { why: "not JSON" };
  }
}

/** A JSON file read bounded and never through a symlink: missing → null, unreadable → "invalid". */
function readJson(file: string, maxBytes: number): { value: unknown } | null | "invalid" {
  const r = readJsonWhy(file, maxBytes);
  if (!("why" in r)) return r;
  return r.why === "missing" ? null : "invalid";
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
    notOurs: [],
    projectFiles: [],
  } as const;
  const read = readJson(file, MAX_CLIENT_CONFIG_BYTES);
  if (read === "invalid") return { ...empty, state: "invalid" };
  if (read === null) return { ...empty, state: "missing" };
  const entries: ClientEntry[] = [];
  const envBlocks: EnvBlock[] = [];
  const notOurs: NotOursEntry[] = [];
  let others = 0;
  let siblingInstalled = false;
  /** `pluginCopy`: the map is the `.mcp.json` of a copy of this plugin (`isPluginRoot`). */
  const take = (m: ServerMap, holder: string, pluginCopy = false): void => {
    for (const [name, spec] of Object.entries(m.servers)) {
      if (!isObj(spec)) continue;
      const { owner, launch } = classifyEntry(name, spec);
      const ours = owner === "ours";
      if (isObj(spec.env))
        envBlocks.push({ scope: m.scope, file: holder, dir: m.dir, name, ours, env: spec.env });
      if (owner === "sibling" || launch.kind === "sibling") siblingInstalled = true;
      const at = { scope: m.scope, file: holder, dir: m.dir };
      if (owner === "foreign") notOurs.push({ kind: "foreign", ...at, target: null, why: null });
      if (owner === "undetermined" && launch.kind === "unknown")
        notOurs.push({ kind: "undetermined", ...at, target: launch.target, why: launch.why });
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
    notOurs,
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

/**
 * The exact command that removes one Claude Code registration: `claude mcp remove` with
 * `-s/--scope local|user|project` and its key (Claude Code's `mcp remove <name>`). A local-scope
 * entry belongs to the project directory Claude Code was started in (`projects["<dir>"]`), and a
 * project-scope one to that directory's `.mcp.json`, so those are run from there.
 */
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

/** Claude Code's record of the marketplaces it knows (`["<name>"].source`, `.installLocation`). */
export function knownMarketplacesPath(home: string): string {
  return path.join(home, ".claude", "plugins", "known_marketplaces.json");
}

/**
 * Where the plugin Claude Code runs comes from. `folder`: its marketplace is a folder on this Mac
 * (a `directory` source, or a `file` source's `.claude-plugin/marketplace.json`) and lists the
 * plugin by a relative path, so Claude Code reads the plugin IN PLACE from `root` (`claude plugin
 * list`: "Read from: <root>"; `claude plugin update`: "is read from its folder … Edits there take
 * effect at the next session start") and installed_plugins.json's `installPath` is a leftover
 * cache copy. `copied`: a marketplace or plugin source Claude Code fetches (github, git, url, npm …)
 * — the `installPath` cache copy is what runs. `unknown`: the marketplace record or listing could
 * not be read, or its source for the plugin leaves the marketplace folder — the `installPath` copy
 * is judged, as before, and `why` says what was not known.
 */
export type PluginOrigin =
  | { readonly kind: "folder"; readonly root: string; readonly marketplaceDir: string }
  | { readonly kind: "copied"; readonly source: string }
  | { readonly kind: "unknown"; readonly why: string };

/** One installed copy of the plugin. */
export interface PluginCopy {
  readonly scope: string;
  /**
   * The plugin Claude Code runs (`<root>/scripts/eff-launch.sh serve` → its `dist/cli.js`): the
   * marketplace folder's copy for a `folder` origin, else `installPath`.
   */
  readonly root: string;
  /** installed_plugins.json's record: the cache copy (a leftover for a `folder` origin). */
  readonly installPath: string;
  readonly version: string | null;
}

/** The plugin as Claude Code records it (null: not installed). */
export interface PluginInstall {
  /** `enabledPlugins["<id>"] === true` in the user settings: Claude Code starts its server. */
  readonly enabled: boolean;
  readonly origin: PluginOrigin;
  readonly copies: readonly PluginCopy[];
}

const SCOPE_RE = /^[a-z]{1,16}$/;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,40}$/;
/** A marketplace or plugin source type, as said in a detail line. */
const SOURCE_WORD_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** Most `plugins` entries of a marketplace listing scanned. */
const MAX_LISTED_PLUGINS = 1000;

/**
 * The plugin directory a folder marketplace's relative plugin source names, or why doctor refuses
 * it: a source that leaves the marketplace folder — an absolute path, a `..` segment, or a path
 * through a symbolic link — is never followed. Relative sources resolve against the marketplace
 * root (the folder holding `.claude-plugin/`); a bare name resolves under `metadata.pluginRoot`.
 */
export function pluginDirIn(
  marketplaceDir: string,
  source: string,
  pluginRoot?: unknown,
): { root: string } | { why: string } {
  const refusal = (s: string): string | null => {
    if (s.length === 0 || s.length > 1024 || /[\u0000-\u001f\u007f]/u.test(s))
      return "is not a path doctor reads";
    if (path.isAbsolute(s) || /^[A-Za-z]:|^[~\\]/u.test(s))
      return "is an absolute path, outside the marketplace folder";
    if (s.split(/[/\\]/u).includes("..")) return "climbs out of the marketplace folder (..)";
    return null;
  };
  const given =
    source.startsWith("./") || source === "."
      ? [source]
      : typeof pluginRoot === "string"
        ? [pluginRoot, source]
        : [source];
  for (const s of given) {
    const why = refusal(s);
    if (why !== null) return { why };
  }
  if (given.length === 1 && given[0] !== "." && !source.startsWith("./"))
    return { why: "is a bare name and the marketplace sets no metadata.pluginRoot" };
  const root = path.resolve(marketplaceDir, ...given);
  const rel = path.relative(marketplaceDir, root);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    return { why: "leaves the marketplace folder" };
  // every directory between the marketplace folder and the plugin's: none may be a symbolic link
  let at = marketplaceDir;
  for (const seg of rel === "" ? [] : rel.split(path.sep)) {
    at = path.join(at, seg);
    try {
      if (lstatSync(at).isSymbolicLink())
        return { why: "passes through a symbolic link, which doctor never follows" };
    } catch {
      break; // missing: the plugin's directory is then said to have no build
    }
  }
  return { root };
}

/**
 * Where the plugin Claude Code runs comes from (`PluginOrigin`), read the way Claude Code reads it:
 * known_marketplaces.json's record of `MARKETPLACE_NAME`, then — for a folder marketplace — its
 * `.claude-plugin/marketplace.json` listing of the plugin. Bounded reads, never through a symlink.
 */
export function pluginOrigin(home: string): PluginOrigin {
  const known = knownMarketplacesPath(home);
  const unknown = (why: string): PluginOrigin => ({ kind: "unknown", why });
  const record = readJsonWhy(known, MAX_PROJECT_FILE_BYTES);
  if ("why" in record) return unknown(`${known} is ${record.why}`);
  const m = isObj(record.value) ? record.value[MARKETPLACE_NAME] : undefined;
  const source = isObj(m) && isObj(m.source) ? m.source : null;
  if (source === null || typeof source.source !== "string")
    return unknown(`${known} records no ${MARKETPLACE_NAME} marketplace with a source`);
  const word = (v: unknown): string =>
    typeof v === "string" && SOURCE_WORD_RE.test(v) ? v : "another";
  if (source.source !== "directory" && source.source !== "file")
    return { kind: "copied", source: word(source.source) };
  if (typeof source.path !== "string" || !path.isAbsolute(source.path))
    return unknown(`${known} gives the ${MARKETPLACE_NAME} marketplace no absolute path`);
  let marketplaceDir: string;
  let listing: string;
  if (source.source === "directory") {
    marketplaceDir = path.resolve(source.path);
    listing = path.join(marketplaceDir, ".claude-plugin", "marketplace.json");
  } else {
    listing = path.resolve(source.path);
    if (path.basename(path.dirname(listing)) !== ".claude-plugin")
      return unknown(`the ${MARKETPLACE_NAME} marketplace file is not in a .claude-plugin folder`);
    marketplaceDir = path.dirname(path.dirname(listing));
  }
  const doc = readJsonWhy(listing, MAX_PROJECT_FILE_BYTES);
  if ("why" in doc) return unknown(`${shown(listing)} is ${doc.why}`);
  const plugins =
    isObj(doc.value) && Array.isArray(doc.value.plugins)
      ? doc.value.plugins.slice(0, MAX_LISTED_PLUGINS)
      : [];
  const entry = plugins.find(
    (p): p is Record<string, unknown> => isObj(p) && p.name === PLUGIN_NAME,
  );
  if (entry === undefined)
    return unknown(`${shown(listing)} does not list the ${PLUGIN_NAME} plugin`);
  if (isObj(entry.source)) return { kind: "copied", source: word(entry.source.source) };
  if (typeof entry.source !== "string")
    return unknown(`${shown(listing)} gives the ${PLUGIN_NAME} plugin no source`);
  const metadata = isObj(doc.value) && isObj(doc.value.metadata) ? doc.value.metadata : {};
  const dir = pluginDirIn(marketplaceDir, entry.source, metadata.pluginRoot);
  if ("why" in dir)
    return unknown(
      `the plugin's source in ${shown(listing)} (${shown(JSON.stringify(entry.source), 120)}) ${dir.why}`,
    );
  return { kind: "folder", root: dir.root, marketplaceDir };
}

/** Whether two paths name the same directory (their real paths when both resolve). */
export function samePath(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return path.resolve(a) === path.resolve(b) || real(a) === real(b);
}

/**
 * The espn-fantasy-football plugin's install (`PLUGIN_ID` in installed_plugins.json, enabled in
 * the user settings) and where what runs comes from (`pluginOrigin`), or null when it is not
 * installed. Bounded reads; a malformed file reads as not installed / not enabled / source unknown.
 */
export function scanPlugin(home: string): PluginInstall | null {
  const installed = readJson(installedPluginsPath(home), MAX_PROJECT_FILE_BYTES);
  if (installed === null || installed === "invalid" || !isObj(installed.value)) return null;
  const plugins = installed.value.plugins;
  if (!isObj(plugins)) return null;
  const list = plugins[PLUGIN_ID];
  if (!Array.isArray(list)) return null;
  const records: { scope: string; installPath: string; version: string | null }[] = [];
  for (const c of list.slice(0, 16)) {
    if (!isObj(c) || typeof c.installPath !== "string" || !path.isAbsolute(c.installPath)) continue;
    records.push({
      scope: typeof c.scope === "string" && SCOPE_RE.test(c.scope) ? c.scope : "user",
      installPath: c.installPath,
      version: typeof c.version === "string" && VERSION_RE.test(c.version) ? c.version : null,
    });
  }
  if (records.length === 0) return null;
  const origin = pluginOrigin(home);
  const copies: PluginCopy[] = records.map((r) => ({
    ...r,
    root: origin.kind === "folder" ? origin.root : r.installPath,
  }));
  const settings = readJson(codeSettingsPath(home), MAX_PROJECT_FILE_BYTES);
  const enabled =
    settings !== null &&
    settings !== "invalid" &&
    isObj(settings.value) &&
    isObj(settings.value.enabledPlugins) &&
    settings.value.enabledPlugins[PLUGIN_ID] === true;
  return { enabled, origin, copies };
}
