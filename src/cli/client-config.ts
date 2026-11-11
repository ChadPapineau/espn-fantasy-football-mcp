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
// is printed but names this program owns, paths, scopes and counts — never an env value, and never a
// word that holds more than one path (`printable`; verifier R-P1: an `sh -c` command line carries
// `NAME=value` assignments, a cookie among them).
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
// a second registration of this one and told him to remove it) — and never by its key alone when
// its command line names no program of this package (verifier A-F1: this key launching `uv run
// server.py` was still "ours"); this package's `eff` bin is one of its programs (verifier A-F2).
// And the plugin Claude Code runs is the one it reads (`pluginOrigin`): a plugin listed by a folder
// marketplace (`directory` or `file` source, a `./` plugin source) is read in place from that
// folder, and installed_plugins.json's `installPath` cache copy is a leftover there — doctor judged
// that leftover as what runs. A folder marketplace doctor cannot follow is never judged by that
// copy either (verifier B1): Claude Code reads it in place or loads nothing.
//
// Refix round 1 (verifiers R and F, Claude Code 2.1.308's own rules): `eff` and the package's name
// count only in program position (R-P2, R-P6); a project server the user declined
// (`disabledMcpjsonServers`) is never started, and every ancestor directory's `.mcp.json` is in a
// session's project scope (R-P5a/b: `SessionView`); a plugin whose marketplace Claude Code does not
// know, or whose known_marketplaces.json it cannot read, loads nothing, while one the user settings
// declare as a folder (`extraKnownMarketplaces`) is read in place (F1); and a folder marketplace's
// plugin needs no install record (F2).
//
// Refix round 2 (verifiers V-A, V-B): known_marketplaces.json is judged by Claude Code 2.1.308's
// own per-record schema, under which one bad record of any marketplace makes the client load none
// (`marketplaceRecordState`); the sessions are the project directories Claude Code records, never a
// parent directory read for the projects below it; and the duplicate fix never leaves a session
// without the server (`duplicateRegistrations`).
import { lstatSync, realpathSync, statSync } from "node:fs";
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
  /**
   * A project-scope entry the user declined (`disabledMcpjsonServers` in the user settings or the
   * settings of every session directory whose project scope holds it): Claude Code never starts it,
   * so it is said, its env still checked, and it is never counted or offered for removal (R-P5a).
   */
  readonly declined: boolean;
}

/**
 * One directory Claude Code sessions run in: a `projects` key of ~/.claude.json, which Claude Code
 * 2.1.308 writes for every session's project (`saveCurrentProjectConfig`) — never a parent directory
 * read only because a project lies below it (verifier V-B) — with the project servers its settings
 * decline (`disabledMcpjsonServers`: the user settings, `<dir>/.claude/settings.json` and
 * `<dir>/.claude/settings.local.json`). Its view is the user scope, its own local scope, and the
 * `.mcp.json` of the directory and every ancestor below the filesystem root (`duplicateRegistrations`).
 */
export interface SessionView {
  readonly dir: string;
  readonly declined: readonly string[];
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
 * `undetermined` — it launches a `dist/cli.js`, `scripts/eff-launch.sh` or `eff` whose package
 * doctor cannot read, or, under this server's own key, a command line naming no program of this
 * package: it is neither counted as this server nor offered for removal.
 */
export interface NotOursEntry {
  readonly kind: "foreign" | "undetermined";
  /**
   * Its key is this server's (`espn-fantasy-football`): a generic `claude mcp remove
   * espn-fantasy-football` (or Desktop's "remove the espn-fantasy-football entry") would remove it.
   * Always true for `foreign`. The key itself is never printed for any other entry.
   */
  readonly ownKey: boolean;
  readonly scope: RegistrationScope;
  readonly file: string;
  readonly dir: string | null;
  /**
   * The path it launches (undetermined only), control characters dropped, bounded — or null when
   * that word holds more than a path (`printable`: an `sh -c` command line), which is never printed.
   */
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
  /** Claude Code: the session directories and what each declines (`SessionView`). */
  readonly sessions: readonly SessionView[];
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
/** This package's bin (package.json `bin.eff`: a link to its `dist/cli.js`), as a word. */
const EFF_BIN_RE = /(?:^|[/\\])eff$/u;
/** This package run by name (`npx espn-fantasy-football-mcp`, `npm exec …@<version>`), as a word. */
const PACKAGE_WORD_RE = /^espn-fantasy-football-mcp(?:@[^/\\\s]{0,64})?$/u;
/** Most `eff` words of one entry resolved (a bound on a file the user owns). */
const MAX_BIN_WORDS = 8;

/**
 * What an entry launches, as far as the files it names tell — read bounded, never through a
 * symlink: `ours` — a `dist/cli.js` whose package root (the directory above `dist/`) has a
 * package.json named `espn-fantasy-football-mcp` (a clone, a release install), or a
 * `scripts/eff-launch.sh` under a copy of this plugin (`isPluginRoot`), or an absolute `eff` in
 * program position (`programWords`) whose real path is such a `dist/cli.js` (`npm link`, a global
 * install: package.json `bin`); `named` — this package run by name in program position (`npx
 * espn-fantasy-football-mcp`, `npm exec …`: verifier R-P6), which no client resolves to a known
 * install; `sibling` — the sibling's package; `another` — another package (its package.json or
 * plugin manifest names another); `none` — its command line names no program of this package at all
 * (`uv run …`, any other program, an `eff` that is only an argument: verifier R-P2); `unknown` — it
 * names one, but doctor cannot tell which package it is: its path is not absolute, it is inside a
 * shell command line, the file that names its package is missing, unreadable, a symbolic link, too
 * large or not JSON, or an `eff` is run from the PATH or resolves to no `dist/cli.js`.
 */
export type Launch =
  | { readonly kind: "ours" | "sibling" | "another" | "none" }
  | { readonly kind: "named"; readonly target: string | null }
  | {
      readonly kind: "unknown";
      /** The word it launches, when it is printable (`printable`); null: a command line, not printed. */
      readonly target: string | null;
      readonly why: string;
      /**
       * The word resolved to a file outside this package's layout (an `eff` that is no link to a
       * `dist/cli.js`): it names no program of this package, so even this server's key does not
       * make it ours (`classifyEntry`).
       */
      readonly elsewhere: boolean;
    };

/** A path or word read from a file, for a detail line: control characters dropped, bounded. */
function shown(s: string, max = 300): string {
  const t = s.replace(/[\u0000-\u001f\u007f]/gu, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Whether a word read from a client config may be printed: one token holding neither whitespace nor
 * `=` (verifier R-P1: `/bin/sh -c "ESPN_S2=… SWID=… exec …/eff"` printed the cookie). A path with a
 * space in it is not printed either — said as "a command line", never echoed.
 */
export function printable(w: string): boolean {
  return !/[\s=]/u.test(w);
}

/** A word as a detail line shows it (`shown`), or null when it is not `printable`. */
function shownWord(w: string): string | null {
  return printable(w) ? shown(w) : null;
}

/** Why a matched word is not resolved: it is inside a shell command line. */
const IN_COMMAND_LINE = "it is a shell command line, which doctor does not parse";

/** The programs that run another program named by their next word (`programWords`). */
const LAUNCHERS = new Set(["env", "node", "nodejs", "npx"]);
/** Most launcher hops followed (`env node eff …` is two). */
const MAX_LAUNCHER_HOPS = 4;

/**
 * The words of an entry in program position: its `command`, and the program each launcher it names
 * runs — the first word after `env` (its options and `NAME=value` assignments skipped), the script
 * after `node` (its options skipped), the package after `npx` or `npm exec` / `npm x` (verifier
 * R-P2: an `eff` anywhere else is an argument — `uv --directory eff`, `--profile eff`).
 */
export function programWords(spec: Record<string, unknown>): string[] {
  const args: readonly unknown[] = Array.isArray(spec.args) ? spec.args : [];
  const words: unknown[] = [spec.command, ...args];
  const out: string[] = [];
  let i = 0;
  for (let hop = 0; hop <= MAX_LAUNCHER_HOPS && i < words.length; hop++) {
    const w = words[i];
    if (typeof w !== "string") break;
    out.push(w);
    const base = path.basename(w);
    const npmExec = base === "npm" && (words[i + 1] === "exec" || words[i + 1] === "x");
    if (!LAUNCHERS.has(base) && !npmExec) break;
    i += npmExec ? 2 : 1;
    const skip = (x: unknown): boolean =>
      typeof x === "string" &&
      (x.startsWith("-") || (base === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(x)));
    while (i < words.length && skip(words[i])) i++;
  }
  return out;
}

/**
 * The `dist/cli.js` an `eff` word names, or why doctor cannot tell, or null when the word is no
 * program (a directory named `eff` passed as an argument). Only an absolute word is resolved, and
 * only by `realpathSync` (a stat, nothing read); a bare `eff` is looked up on a PATH doctor does not
 * share with the client.
 */
function binTarget(word: string): { cli: string } | { why: string; elsewhere: boolean } | null {
  if (!printable(word) && !path.isAbsolute(word)) return { why: IN_COMMAND_LINE, elsewhere: false };
  if (!word.includes("/") && !word.includes("\\"))
    return { why: "it is run from the PATH, which doctor does not resolve", elsewhere: false };
  if (!path.isAbsolute(word)) return { why: "its path is not absolute", elsewhere: false };
  let real: string;
  try {
    real = realpathSync(word);
  } catch {
    return { why: "it does not exist", elsewhere: false };
  }
  try {
    if (!statSync(real).isFile()) return null;
  } catch {
    return { why: "it does not exist", elsewhere: false };
  }
  if (!CLI_ENTRY_RE.test(real))
    return {
      why: `it resolves to ${printable(real) ? shown(real) : "a file"}, which is not a dist/cli.js`,
      elsewhere: true,
    };
  return { cli: real };
}

/** See `Launch`. */
export function launchOf(spec: Record<string, unknown>): Launch {
  const args: readonly unknown[] = Array.isArray(spec.args) ? spec.args : [];
  const words = [spec.command, ...args].filter((w): w is string => typeof w === "string");
  const programs = programWords(spec);
  let target = words.find((w) => CLI_ENTRY_RE.test(w) || SHIM_ENTRY_RE.test(w));
  if (target === undefined) {
    for (const w of programs.filter((x) => EFF_BIN_RE.test(x)).slice(0, MAX_BIN_WORDS)) {
      const t = binTarget(w);
      if (t === null) continue;
      if ("why" in t)
        return { kind: "unknown", target: shownWord(w), why: t.why, elsewhere: t.elsewhere };
      target = t.cli;
      break;
    }
  }
  if (target === undefined) {
    const named = programs.find((w) => PACKAGE_WORD_RE.test(w));
    return named === undefined ? { kind: "none" } : { kind: "named", target: shownWord(named) };
  }
  const found = target;
  const unknown = (why: string): Launch => ({
    kind: "unknown",
    target: shownWord(found),
    why,
    elsewhere: false,
  });
  if (pluginVariables({ command: target }).length > 0)
    return unknown("its path uses a plugin variable, which only a plugin install expands");
  if (!path.isAbsolute(target))
    return unknown(printable(target) ? "its path is not absolute" : IN_COMMAND_LINE);
  const root = path.dirname(path.dirname(target));
  const shim = SHIM_ENTRY_RE.test(target);
  const file = shim
    ? path.join(root, ".claude-plugin", "plugin.json")
    : path.join(root, "package.json");
  const read = readJsonWhy(file, MAX_PROJECT_FILE_BYTES);
  if ("why" in read)
    return unknown(
      `${printable(file) ? shown(file) : shim ? "its .claude-plugin/plugin.json" : "its package.json"} is ${read.why}`,
    );
  const name = isObj(read.value) ? read.value.name : undefined;
  if (name === (shim ? PLUGIN_NAME : PACKAGE_NAME)) return { kind: "ours" };
  return { kind: !shim && name === SIBLING_PACKAGE_NAME ? "sibling" : "another" };
}

/** Why an entry under this server's key whose command line names no program of ours is not ours. */
const NAMES_NO_PROGRAM =
  "its command line names no dist/cli.js, scripts/eff-launch.sh or this package's `eff`";

/**
 * Whose an entry is — the one rule doctor rows #2/#3/#13 and uninstall's printed steps share. What it
 * launches decides, whatever its key: this package is `ours` (a `claude mcp add` of the runtime
 * clone, a release install or its `eff` link under any key, any scope — a real second
 * registration); the sibling's package is `sibling`; another package is not ours, under any key —
 * this server's own key included (`foreign`: a generic `claude mcp remove espn-fantasy-football`
 * would remove it). Only when it names a program of this package that doctor cannot place does the
 * key decide: `espn-fantasy-football` stays `ours` (so a broken registration of ours is still
 * diagnosed — a missing build, a relative path, a plugin variable, `eff` or npx from the PATH),
 * `fantasy-football` stays the sibling's, and any other key is `undetermined` (said once, never
 * counted, never offered for removal). A command line naming no program of this package — or an
 * `eff` resolving to a file that is no `dist/cli.js` — is never ours, whatever its key (verifier
 * A-F1): under `espn-fantasy-football` it is `undetermined` — said once, and neither counted nor
 * removed by uninstall's generic step — and under any other key it is `other` (an `eff`
 * elsewhere: `undetermined`; the sibling's key: `sibling`). This package run by name (`named`: npx,
 * npm exec) is `ours` under any key, the sibling's included (verifier R-P6): a registration of this
 * server that doctor diagnoses as unsupported.
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
    case "named":
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
      if (name === SERVER_NAME)
        return {
          owner: "undetermined",
          launch: {
            kind: "unknown",
            target: typeof spec.command === "string" ? shownWord(spec.command) : "(no command)",
            why: NAMES_NO_PROGRAM,
            elsewhere: true,
          },
        };
      return { owner: name === SIBLING_SERVER_NAME ? "sibling" : "other", launch };
    case "unknown":
      return {
        owner:
          name === SERVER_NAME && !launch.elsewhere
            ? "ours"
            : name === SIBLING_SERVER_NAME
              ? "sibling"
              : "undetermined",
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
 * <why>"). `doctorOnly`: a refusal of doctor's own (a symbolic link, the size bound) — a client
 * that follows links or reads larger files may read the file; every other stop holds for any reader.
 */
function readJsonWhy(
  file: string,
  maxBytes: number,
): { value: unknown } | { why: string; doctorOnly: boolean } {
  let text: string | null;
  try {
    text = readSecureFile(file, { requirePrivate: false, maxBytes, what: "client config" });
  } catch (e) {
    if (e instanceof PathSecurityError)
      switch (e.reason) {
        case "symlink":
          return { why: "a symbolic link (never followed)", doctorOnly: true };
        case "too_large":
          return { why: `larger than ${String(maxBytes)} bytes`, doctorOnly: true };
        case "not_regular_file":
          return { why: "not a regular file", doctorOnly: false };
        default:
          return { why: "unreadable", doctorOnly: false };
      }
    return { why: "unreadable", doctorOnly: false };
  }
  if (text === null) return { why: "missing", doctorOnly: false };
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return { why: "not JSON", doctorOnly: false };
  }
}

/** A JSON file read bounded and never through a symlink: missing → null, unreadable → "invalid". */
function readJson(file: string, maxBytes: number): { value: unknown } | null | "invalid" {
  const r = readJsonWhy(file, maxBytes);
  if (!("why" in r)) return r;
  return r.why === "missing" ? null : "invalid";
}

/** Most directories walked up from one project directory (Claude Code stops at the root). */
export const MAX_ANCESTORS = 64;
/** Most distinct project `.mcp.json` files read for one client config. */
export const MAX_PROJECT_FILES = 4096;
/** Most `disabledMcpjsonServers` names read from one settings file. */
const MAX_DECLINED = 256;

/**
 * Each directory from `dir` up to, but not including, the filesystem root — the directories whose
 * `.mcp.json` Claude Code 2.1.308 reads for a session opened in `dir` (nearest first; R-P5b).
 */
export function ancestorDirs(dir: string): string[] {
  const out: string[] = [];
  let at = path.resolve(dir);
  while (out.length < MAX_ANCESTORS && at !== path.parse(at).root) {
    out.push(at);
    at = path.dirname(at);
  }
  return out;
}

/** Whether `dir` is `top` or below it (lexically, as Claude Code walks a session's directory). */
function within(top: string, dir: string): boolean {
  const rel = path.relative(top, dir);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** A settings file's `disabledMcpjsonServers` (bounded; unreadable or malformed → none). */
function declinedIn(file: string): string[] {
  const r = readJson(file, MAX_PROJECT_FILE_BYTES);
  if (r === null || r === "invalid" || !isObj(r.value)) return [];
  const list = r.value.disabledMcpjsonServers;
  return Array.isArray(list)
    ? list.slice(0, MAX_DECLINED).filter((n): n is string => typeof n === "string")
    : [];
}

/**
 * Reads a client config's `mcpServers` — every scope it holds, and for Claude Code also the
 * `.mcp.json` of each known project directory and of every ancestor of it below the filesystem root
 * (project scope: `claude mcp add --scope project`, a file meant to be committed, so the most
 * dangerous place for a cookie in an env block; Claude Code 2.1.308 reads every one of them for a
 * session there — R-P5b), and each session directory's declined project servers (R-P5a). Claude
 * Code's user settings are read beside its config (`<dir of file>/.claude/settings.json`).
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
    sessions: [],
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
      const at = { scope: m.scope, file: holder, dir: m.dir, ownKey: name === SERVER_NAME };
      if (owner === "foreign") notOurs.push({ kind: "foreign", ...at, target: null, why: null });
      if (owner === "undetermined" && launch.kind === "unknown")
        notOurs.push({ kind: "undetermined", ...at, target: launch.target, why: launch.why });
      if (ours) {
        const pluginSource = pluginCopy && pluginVariables(spec).includes("${CLAUDE_PLUGIN_ROOT}");
        entries.push({
          name,
          spec,
          scope: m.scope,
          file: holder,
          dir: m.dir,
          pluginSource,
          declined: false,
        });
      } else others++;
    }
  };
  for (const m of scopedServerMaps(client, read.value)) take(m, file);
  const projectFiles: { file: string; state: "ok" | "invalid" }[] = [];
  if (client !== "code")
    return {
      ...empty,
      state: "ok",
      entries,
      envs: envBlocks.map((b) => b.env),
      envBlocks,
      others,
      siblingInstalled,
      notOurs,
    };
  const known = projectDirs(read.value);
  const seen = new Set<string>();
  for (const dir of known)
    for (const at of ancestorDirs(dir)) {
      if (seen.has(at)) continue;
      if (seen.size >= MAX_PROJECT_FILES) break;
      seen.add(at);
      const f = path.join(at, ".mcp.json");
      const p = readJson(f, MAX_PROJECT_FILE_BYTES);
      if (p === null) continue;
      if (p === "invalid") {
        projectFiles.push({ file: f, state: "invalid" });
        continue;
      }
      projectFiles.push({ file: f, state: "ok" });
      if (isObj(p.value) && isObj(p.value.mcpServers))
        take({ scope: "project", dir: at, servers: p.value.mcpServers }, f, isPluginRoot(at));
    }
  // the session directories: the known projects only — Claude Code records every session's project
  // under `projects`, so a parent directory read only for the projects below it has had none (V-B)
  const userDeclined = declinedIn(path.join(path.dirname(file), ".claude", "settings.json"));
  const sessionDirs = [...new Set(known.map((d) => path.resolve(d)))];
  const sessions: SessionView[] = sessionDirs.map((dir) => ({
    dir,
    declined: [
      ...new Set([
        ...userDeclined,
        ...declinedIn(path.join(dir, ".claude", "settings.json")),
        ...declinedIn(path.join(dir, ".claude", "settings.local.json")),
      ]),
    ],
  }));
  // a project entry is declined when every session at or below its directory declines it
  const marked = entries.map((e) => {
    if (e.scope !== "project" || e.dir === null) return e;
    const top = path.resolve(e.dir);
    const seeing = sessions.filter((v) => within(top, v.dir));
    const declined = seeing.length > 0 && seeing.every((v) => v.declined.includes(e.name));
    return declined ? { ...e, declined } : e;
  });
  return {
    client,
    file,
    state: "ok",
    entries: marked,
    envs: envBlocks.map((b) => b.env),
    envBlocks,
    others,
    siblingInstalled,
    notOurs,
    projectFiles,
    sessions,
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

/**
 * Registrations of this server that run beside each other in one client (README "One registration
 * per client"; verifier A-F3: two `claude mcp add` entries under different keys, without the
 * plugin, were never called a duplicate). Claude Code: a session in one of the `sessions`
 * directories (the projects it records) sees the user scope, that directory's local scope, and the
 * project scope of its `.mcp.json` and every ancestor's (R-P5b) less the project servers its
 * settings decline (R-P5a); a session outside them sees the user scope alone. A parent directory's
 * `.mcp.json` counts only in the views of the sessions below it — never as a view of its own
 * (verifier V-B). A key at a narrower scope overrides the same key at a wider one, so each view
 * starts one server per DISTINCT key. Claude Desktop: one map, one server per key. `views`: each
 * view's entries; `most`: the most servers one view starts; `extra`: the entries whose removal
 * leaves one key in each view it can — never leaving a view that starts a server with none (V-B: a
 * session declining the entry kept lost its only server). In each view the key kept is the first
 * that strips no view, ranked by how many views its entry reaches, then by how wide it is (the user
 * scope's, then the farthest ancestor's `.mcp.json`), then `espn-fantasy-football`, then the first;
 * `unresolved`: the views where every choice would strip another view, with the entries still there
 * — which to keep there is the user's (declining the others in that directory). The plugin's own
 * `.mcp.json` declaration is never a registration (`pluginSource`).
 */
export function duplicateRegistrations(
  entries: readonly ClientEntry[],
  sessions: readonly SessionView[] = [],
): {
  readonly most: number;
  readonly extra: readonly ClientEntry[];
  readonly views: readonly (readonly ClientEntry[])[];
  readonly unresolved: readonly {
    readonly dir: string;
    readonly entries: readonly ClientEntry[];
  }[];
} {
  const regs = entries.filter((e) => !e.pluginSource);
  const narrow = (e: ClientEntry): boolean => e.scope === "local" || e.scope === "project";
  const at = (e: ClientEntry): string => path.resolve(e.dir ?? ".");
  const wide = regs.filter((e) => !narrow(e)); // the user scope, or Claude Desktop's one map
  const declined = new Map(sessions.map((v) => [path.resolve(v.dir), new Set(v.declined)]));
  const dirs = [...declined.keys()];
  const sees = (d: string, e: ClientEntry): boolean => {
    if (!narrow(e)) return true;
    if (e.scope === "local") return at(e) === d;
    return within(at(e), d) && declined.get(d)?.has(e.name) !== true;
  };
  const views: { dir: string | null; entries: ClientEntry[] }[] = [
    { dir: null, entries: wide },
    ...dirs.map((d) => ({ dir: d, entries: regs.filter((e) => sees(d, e)) })),
  ];
  const reach = new Map<ClientEntry, number>();
  for (const v of views) for (const e of v.entries) reach.set(e, (reach.get(e) ?? 0) + 1);
  /** How far up an entry reaches: the user scope above all, then the shallower directory. */
  const depth = (e: ClientEntry): number =>
    narrow(e)
      ? at(e)
          .split(path.sep)
          .filter((x) => x !== "").length
      : -1;
  const keysOf = (es: readonly ClientEntry[]): string[] => [...new Set(es.map((e) => e.name))];
  const most = Math.max(0, ...views.map((v) => keysOf(v.entries).length));
  const extra: ClientEntry[] = [];
  const left = (es: readonly ClientEntry[]): ClientEntry[] => es.filter((e) => !extra.includes(e));
  /** Removing `drop` beside `extra` leaves every view that starts a server with one. */
  const strips = (drop: readonly ClientEntry[]): boolean =>
    views.some(
      (v) => v.entries.length > 0 && v.entries.every((e) => extra.includes(e) || drop.includes(e)),
    );
  for (const v of views) {
    const rest = left(v.entries);
    const keys = keysOf(rest);
    if (keys.length < 2) continue;
    const of = (k: string): ClientEntry[] => rest.filter((e) => e.name === k);
    const reachOf = (k: string): number => Math.max(...of(k).map((e) => reach.get(e) ?? 0));
    const depthOf = (k: string): number => Math.min(...of(k).map(depth));
    const ranked = [...keys].sort(
      (a, b) =>
        reachOf(b) - reachOf(a) ||
        depthOf(a) - depthOf(b) ||
        Number(b === SERVER_NAME) - Number(a === SERVER_NAME),
    );
    const keep = ranked.find((k) => !strips(rest.filter((e) => e.name !== k)));
    if (keep !== undefined) extra.push(...rest.filter((e) => e.name !== keep));
  }
  const unresolved = views.flatMap((v) =>
    v.dir !== null && keysOf(left(v.entries)).length > 1
      ? [{ dir: v.dir, entries: left(v.entries) }]
      : [],
  );
  return {
    most,
    extra,
    views: views.filter((v) => v.entries.length > 0 || v.dir === null).map((v) => v.entries),
    unresolved,
  };
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
 * Where the plugin Claude Code runs comes from, as Claude Code 2.1.308 resolves it (observed in
 * that client, 2026-11-11: a plugin whose catalog entry is a STRING source in a marketplace whose
 * known_marketplaces.json record is a `file` or `directory` source resolves to the folder, or to
 * "unresolved" and is not loaded — never to a cache copy; `claude plugin list`: "Read from:
 * <root>"; `claude plugin update`: "is read from its folder … Edits there take effect at the next
 * session start"; an older client copied such a plugin into the cache and ran that copy, README
 * Upgrade). `folder`: its marketplace is a folder on this Mac (a `directory` source, or a `file`
 * source's `.claude-plugin/marketplace.json`) and lists the plugin by a relative path, so Claude
 * Code reads the plugin IN PLACE from `root` and installed_plugins.json's `installPath` is a
 * leftover cache copy. `copied`: a marketplace or plugin source Claude Code fetches (github, git,
 * url, npm …) — the `installPath` cache copy is what runs. `unresolved` (Claude Code's own term):
 * the record is a folder marketplace, but its listing is missing (the folder moved or deleted),
 * unreadable, not JSON, no longer lists the plugin or gives it no source — Claude Code cannot load
 * the plugin, and the cache copy is not what runs. `refused`: the record is a folder marketplace,
 * but doctor does not follow it (no absolute path, a listing through a symbolic link or past
 * doctor's size bound, a plugin source that leaves the folder), or known_marketplaces.json itself
 * is a symbolic link, past that bound (Claude Code reads it all the same) or records a source type
 * Claude Code 2.1.308 does not have (a newer client may: verifier V-A) — `registry` — so what
 * Claude Code runs is not known, and it is never the cache copy. `unloaded` (verifier F1, Claude
 * Code 2.1.308's MDe: "not loaded (hooks module, commands, skills, servers: none of it)"): Claude
 * Code loads no plugin of this marketplace — `registry: "unreadable"`: known_marketplaces.json is
 * not JSON, unreadable or fails its schema (one record of ANY marketplace that schema refuses:
 * `marketplaceRecordState`, V-A), and Claude Code then loads no marketplace plugin at all, settings
 * declarations included; `registry: "unrecorded"`: the file is missing or records no such
 * marketplace, and the user settings declare none Claude Code loads before recording it. A folder
 * the user settings declare (`extraKnownMarketplaces`, a `directory` source or a `file` source
 * under `.claude-plugin`, at an absolute path) is read in place like a recorded one (`folder` with
 * `declared`, or `unresolved` / `refused`). The cache copy is judged only for a marketplace Claude
 * Code fetches (`copied`).
 */
export type PluginOrigin =
  | {
      readonly kind: "folder";
      readonly root: string;
      readonly marketplaceDir: string;
      /** Declared in the user settings, not recorded in known_marketplaces.json (F1). */
      readonly declared?: true;
    }
  | { readonly kind: "copied"; readonly source: string }
  | { readonly kind: "unresolved"; readonly marketplaceDir: string; readonly why: string }
  | {
      readonly kind: "refused";
      readonly why: string;
      /**
       * What doctor cannot judge is known_marketplaces.json itself (a symbolic link, past doctor's
       * bound, or a source type Claude Code 2.1.308 does not have: V-A), not a folder marketplace's
       * listing — so whether the marketplace is a folder at all is not known.
       */
      readonly registry?: true;
    }
  | {
      readonly kind: "unloaded";
      readonly registry: "unreadable" | "unrecorded";
      readonly why: string;
    };

/** Whether Claude Code may start the plugin's server from this origin (all but `unresolved`/`unloaded`). */
export function pluginMayLoad(o: PluginOrigin): boolean {
  return o.kind !== "unresolved" && o.kind !== "unloaded";
}

/** One installed copy of the plugin. */
export interface PluginCopy {
  readonly scope: string;
  /**
   * The plugin Claude Code runs (`<root>/scripts/eff-launch.sh serve` → its `dist/cli.js`): the
   * marketplace folder's copy for a `folder` origin, `installPath` for a `copied` one, and null for
   * an `unresolved`, `refused` or `unloaded` one (nothing doctor can judge as what runs).
   */
  readonly root: string | null;
  /**
   * installed_plugins.json's record: the cache copy (a leftover for a folder marketplace); null when
   * there is no record — a folder marketplace's plugin loads without one (verifier F2).
   */
  readonly installPath: string | null;
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

/** The marketplace's declaration in the user settings (`extraKnownMarketplaces`), or null. */
function declaredMarketplace(home: string): unknown {
  const settings = readJson(codeSettingsPath(home), MAX_PROJECT_FILE_BYTES);
  if (settings === null || settings === "invalid" || !isObj(settings.value)) return null;
  const extra = settings.value.extraKnownMarketplaces;
  return isObj(extra) && Object.hasOwn(extra, MARKETPLACE_NAME) ? extra[MARKETPLACE_NAME] : null;
}

/**
 * The field each marketplace source type of Claude Code 2.1.308 requires in a known_marketplaces.json
 * record (its `yn` union, keyed by `source`: `url` and `git` a `url`, `github` a `repo`, `npm` a
 * `package`, `file` and `directory` a `path`, the policy patterns theirs, `settings` a `name`;
 * `skills-dir` none). A type missing here is one that client does not have (V-A).
 */
const MARKETPLACE_SOURCE_FIELD: Readonly<Record<string, string | null>> = {
  url: "url",
  github: "repo",
  git: "url",
  npm: "package",
  file: "path",
  directory: "path",
  "skills-dir": null,
  hostPattern: "hostPattern",
  pathPattern: "pathPattern",
  settings: "name",
};

/**
 * One known_marketplaces.json record against Claude Code 2.1.308's schema of it (its `jo`, observed
 * in that client's binary, 2026-11-11: `source`, then `installLocation` and `lastUpdated` strings and
 * an optional boolean `autoUpdate`; one record that fails makes the whole file "corrupted", and the
 * client then loads no marketplace plugin — verifier V-A). `broken`: that schema refuses it, `what`
 * saying why (field and type names only, never a value); `unknown`: its source type is one that
 * client does not have — a newer one may (`type`: the type when it is a plain word, else null).
 * Doctor checks each type's required field (a `url` source's must parse as a URL, a `settings`
 * source's `plugins` must be a list), not every optional field a type allows: a file Claude Code
 * wrote passes all of it.
 */
function marketplaceRecordState(
  m: unknown,
):
  | { readonly kind: "ok" }
  | { readonly kind: "broken"; readonly what: string }
  | { readonly kind: "unknown"; readonly type: string | null } {
  const broken = (what: string) => ({ kind: "broken", what }) as const;
  if (!isObj(m)) return broken("that is not an object");
  const s = m.source;
  if (!isObj(s) || typeof s.source !== "string") return broken("with no usable source");
  if (typeof m.installLocation !== "string") return broken("with no installLocation");
  if (typeof m.lastUpdated !== "string") return broken("with no lastUpdated");
  if (Object.hasOwn(m, "autoUpdate") && typeof m.autoUpdate !== "boolean")
    return broken("whose autoUpdate is not true or false");
  const type = s.source;
  if (!Object.hasOwn(MARKETPLACE_SOURCE_FIELD, type))
    return { kind: "unknown", type: SOURCE_WORD_RE.test(type) ? type : null };
  const field = MARKETPLACE_SOURCE_FIELD[type] ?? null;
  if (field !== null && typeof s[field] !== "string")
    return broken(`whose ${type} source has no ${field}`);
  if (type === "url" && typeof s.url === "string" && !URL.canParse(s.url.trim()))
    return broken("whose url source's url is not a URL");
  if (type === "settings" && !Array.isArray(s.plugins))
    return broken("whose settings source lists no plugins");
  return { kind: "ok" };
}

/**
 * Where the plugin Claude Code runs comes from (`PluginOrigin`), read the way Claude Code 2.1.308
 * reads it (F1): known_marketplaces.json's record of `MARKETPLACE_NAME` — or, when the file is
 * missing or records none, the user settings' declaration of it — then, for a folder marketplace,
 * its `.claude-plugin/marketplace.json` listing of the plugin. Bounded reads, never through a
 * symlink. Once a folder marketplace is named, nothing that follows falls back to the cache copy
 * (verifier B1): Claude Code reads such a plugin in place or loads nothing.
 */
export function pluginOrigin(home: string): PluginOrigin {
  const known = knownMarketplacesPath(home);
  const settings = codeSettingsPath(home);
  const refused = (why: string, registry = false): PluginOrigin =>
    registry ? { kind: "refused", why, registry: true } : { kind: "refused", why };
  const unloaded = (registry: "unreadable" | "unrecorded", why: string): PluginOrigin => ({
    kind: "unloaded",
    registry,
    why,
  });
  const record = readJsonWhy(known, MAX_PROJECT_FILE_BYTES);
  let source: Record<string, unknown> | null = null;
  let declared = false;
  if ("why" in record) {
    // a symbolic link or past doctor's bound: Claude Code reads it, doctor does not
    if (record.doctorOnly) return refused(`${known} is ${record.why}`, true);
    if (record.why !== "missing")
      return unloaded(
        "unreadable",
        `${known} is ${record.why}: Claude Code loads no marketplace plugin while it cannot read it`,
      );
  } else {
    if (!isObj(record.value))
      return unloaded(
        "unreadable",
        `${known} is not a JSON object: Claude Code loads no marketplace plugin while it cannot read it`,
      );
    // one record its schema refuses makes Claude Code 2.1.308 refuse the whole file (V-A), and a
    // source type it does not have may be one a newer client reads: doctor cannot tell then
    const records = Object.entries(record.value).slice(0, MAX_LISTED_PLUGINS);
    const states = records.map(([name, m]) => ({ name, state: marketplaceRecordState(m) }));
    const who = (name: string): string =>
      name === MARKETPLACE_NAME ? `the ${MARKETPLACE_NAME} marketplace` : "a marketplace";
    const broken = states.find((r) => r.state.kind === "broken");
    if (broken?.state.kind === "broken")
      return unloaded(
        "unreadable",
        `${known} records ${who(broken.name)} ${broken.state.what}, which fails its schema: Claude Code loads no marketplace plugin while it cannot read it`,
      );
    const strange = states.find((r) => r.state.kind === "unknown");
    if (strange?.state.kind === "unknown")
      return refused(
        `${known} records ${who(strange.name)} with a source type doctor does not know${strange.state.type === null ? "" : ` (${strange.state.type})`}: Claude Code 2.1.308 refuses such a file, and a newer client may read it`,
        true,
      );
    const m = Object.hasOwn(record.value, MARKETPLACE_NAME)
      ? record.value[MARKETPLACE_NAME]
      : undefined;
    if (isObj(m) && isObj(m.source)) source = m.source;
  }
  if (source === null) {
    const state = "why" in record ? "is missing" : `records no ${MARKETPLACE_NAME} marketplace`;
    const d = declaredMarketplace(home);
    const ds = isObj(d) && isObj(d.source) ? d.source : null;
    if (ds === null)
      return unloaded(
        "unrecorded",
        `${known} ${state}, and ${settings} declares none under extraKnownMarketplaces`,
      );
    const notYet = (what: string): PluginOrigin =>
      unloaded(
        "unrecorded",
        `${known} ${state}, and ${settings} declares the ${MARKETPLACE_NAME} marketplace (extraKnownMarketplaces) with ${what}: Claude Code loads none of its plugins until it is recorded`,
      );
    if (ds.source !== "directory" && ds.source !== "file")
      return notYet("a source Claude Code fetches");
    if (typeof ds.path !== "string" || !path.isAbsolute(ds.path)) return notYet("no absolute path");
    if (
      ds.source === "file" &&
      path.basename(path.dirname(path.resolve(ds.path))) !== ".claude-plugin"
    )
      return notYet("a file that is not in a .claude-plugin folder");
    source = ds;
    declared = true;
  }
  const word = (v: unknown): string =>
    typeof v === "string" && SOURCE_WORD_RE.test(v) ? v : "another";
  if (source.source !== "directory" && source.source !== "file")
    return { kind: "copied", source: word(source.source) };
  // a folder marketplace from here on: in place, unresolved or refused — never the cache copy
  if (typeof source.path !== "string" || !path.isAbsolute(source.path))
    return refused(`${known} gives the ${MARKETPLACE_NAME} marketplace no absolute path`);
  let marketplaceDir: string;
  let listing: string;
  if (source.source === "directory") {
    marketplaceDir = path.resolve(source.path);
    listing = path.join(marketplaceDir, ".claude-plugin", "marketplace.json");
  } else {
    listing = path.resolve(source.path);
    if (path.basename(path.dirname(listing)) !== ".claude-plugin")
      return refused(`the ${MARKETPLACE_NAME} marketplace file is not in a .claude-plugin folder`);
    marketplaceDir = path.dirname(path.dirname(listing));
  }
  const unresolved = (why: string): PluginOrigin => ({
    kind: "unresolved",
    marketplaceDir,
    why: `${shown(listing)} ${why}`,
  });
  const doc = readJsonWhy(listing, MAX_PROJECT_FILE_BYTES);
  if ("why" in doc)
    return doc.doctorOnly
      ? refused(`${shown(listing)} is ${doc.why}`)
      : unresolved(`is ${doc.why}`);
  const plugins =
    isObj(doc.value) && Array.isArray(doc.value.plugins)
      ? doc.value.plugins.slice(0, MAX_LISTED_PLUGINS)
      : [];
  const entry = plugins.find(
    (p): p is Record<string, unknown> => isObj(p) && p.name === PLUGIN_NAME,
  );
  if (entry === undefined) return unresolved(`does not list the ${PLUGIN_NAME} plugin`);
  if (isObj(entry.source)) return { kind: "copied", source: word(entry.source.source) };
  if (typeof entry.source !== "string")
    return unresolved(`gives the ${PLUGIN_NAME} plugin no source`);
  const metadata = isObj(doc.value) && isObj(doc.value.metadata) ? doc.value.metadata : {};
  const dir = pluginDirIn(marketplaceDir, entry.source, metadata.pluginRoot);
  if ("why" in dir)
    return refused(
      `the plugin's source in ${shown(listing)} (${shown(JSON.stringify(entry.source), 120)}) ${dir.why}`,
    );
  return {
    kind: "folder",
    root: dir.root,
    marketplaceDir,
    ...(declared ? { declared: true } : {}),
  };
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
 * installed. Bounded reads; a malformed file reads as not installed / not enabled. An enabled plugin
 * that a folder marketplace lists by a string source needs no install record (verifier F2, Claude
 * Code 2.1.308's MDe: a record is required only for a non-string source): with none it is still the
 * install, its copy `installPath: null`. With no record and no folder marketplace, an enabled entry
 * is an orphan Claude Code skips: not installed.
 */
export function scanPlugin(home: string): PluginInstall | null {
  const installed = readJson(installedPluginsPath(home), MAX_PROJECT_FILE_BYTES);
  const plugins =
    installed !== null && installed !== "invalid" && isObj(installed.value)
      ? installed.value.plugins
      : undefined;
  const list = isObj(plugins) ? plugins[PLUGIN_ID] : undefined;
  const records: { scope: string; installPath: string; version: string | null }[] = [];
  for (const c of Array.isArray(list) ? list.slice(0, 16) : []) {
    if (!isObj(c) || typeof c.installPath !== "string" || !path.isAbsolute(c.installPath)) continue;
    records.push({
      scope: typeof c.scope === "string" && SCOPE_RE.test(c.scope) ? c.scope : "user",
      installPath: c.installPath,
      version: typeof c.version === "string" && VERSION_RE.test(c.version) ? c.version : null,
    });
  }
  const settings = readJson(codeSettingsPath(home), MAX_PROJECT_FILE_BYTES);
  const enabled =
    settings !== null &&
    settings !== "invalid" &&
    isObj(settings.value) &&
    isObj(settings.value.enabledPlugins) &&
    settings.value.enabledPlugins[PLUGIN_ID] === true;
  if (records.length === 0 && !enabled) return null;
  const origin = pluginOrigin(home);
  if (records.length === 0) {
    if (origin.kind !== "folder" && origin.kind !== "unresolved" && origin.kind !== "refused")
      return null;
    return {
      enabled,
      origin,
      copies: [
        {
          scope: "user",
          root: origin.kind === "folder" ? origin.root : null,
          installPath: null,
          version: null,
        },
      ],
    };
  }
  const copies: PluginCopy[] = records.map((r) => ({
    ...r,
    root: origin.kind === "folder" ? origin.root : origin.kind === "copied" ? r.installPath : null,
  }));
  return { enabled, origin, copies };
}
