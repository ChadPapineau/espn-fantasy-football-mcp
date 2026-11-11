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
//
// Refix round 3 (rulings D-1…D-6; verifiers MK, F): a known_marketplaces.json record no client
// version reads still makes the file unreadable, but one only Claude Code 2.1.308's field-level
// schema refuses is a registry doctor cannot judge (D-1: another client version may read it), and a
// plugin from such a registry is no certain server (MK-1: `pluginLoads`); a server `/mcp disable`
// turned off in a project (`projects[<dir>].disabledMcpServers`, any scope, the plugin's included) is
// not started there (F1); a projects key whose directory no longer exists is no session (F2).
//
// Refix round 4 (verifiers V3): a plugin whose folder-marketplace source doctor does not follow is
// no certain server either (V3-2: Claude Code 2.1.308 loads nothing from an absolute or bare-name
// source); the keep rule says where uninstalling the plugin would leave a session with no server
// (V3-1: `uninstallStrips`) and where an entry is turned off (`offIn`); a project directory doctor
// cannot stat stays a session, and one that is no directory is said as such (V3-5: `dirState`); a
// gone directory's removal is never run under a git work tree's record (V3-3: `gitWorkTreeAt`).
//
// Refix round 5 (rulings D-7, D-8; verifier VR4): a recorded directory Claude Code 2.1.308 files
// under another key — below a git work tree, in a linked worktree, or not its own real path — is no
// session, and its local entries never start (`codeProjectKey`, the one key-mapping helper the
// gone-directory route shares); where doctor cannot tell the key, the directory stays a session but
// its entries are removed by hand (`removalOf`); every word read from a client config, settings
// file or registry is printed with its terminal controls escaped, and a command whose words hold one
// is never printed (`escapeControls`, `holdsControl`); and uninstalling the plugin's first steps are
// planned with what they add (VR4-2, VR4-3).
//
// Refix round 6 (verifiers V5, VR5): a line is redacted before its controls are escaped, so a
// pattern that needs the whitespace beside a secret still sees it (`outputLine`; V5-1); an entry that
// is not this server but holds one of its keys at a narrower scope is what Claude Code 2.1.308 starts
// there (its dC: local over project over user, the nearer `.mcp.json` over the farther), so ours is
// not started there and no step relies on it (`ClientConfigScan.held`; V5-2, V5-3, U2); and each
// choice the keep rule leaves to the user says what it keeps beside the entries and, outside the
// projects, which projects it would strip (U1, U3, U5).
//
// Refix round 7 (verifiers VR6, F): a project server wins its key over the user scope only where it
// is approved — Claude Code 2.1.308 skips one that is not while the user or local scope holds its
// key, and never offers it (`SessionView.approved`; VR6-1, F2: another program's unapproved server
// hid a duplicate of ours, and its local add made one); an entry of a record no session reads
// overrides nothing and counts for no session (`HeldEntry.unread`, `absent`; F3); keeping entries
// only in the projects a choice strips adds in each the keys it starts, and only where doctor can
// tell the record (`UnresolvedView.leaves`; F1, VR6-2); and a gone directory too deep to walk is
// "cannot tell", never "no work tree" (`gitWorkTreeAt`; VR6-3).
//
// Refix round 8 (verifiers VR7): a session starts, per key, the one entry Claude Code 2.1.308's dC
// picks there, so an entry of ours behind another under its key is never counted or relied on and
// a removal recomputes what wins next (`startsOf`; VR7-1), and the plugin is dropped only beside an
// entry that starts (VR7-4); a record that is not its directory's own real path is no session's,
// whatever doctor can tell of the git root (`codeProjectKey`; VR7-2); a decline or removal turns a
// key off only where nothing else then starts under it (`UnresolvedView.alone`; VR7-3); and no step
// writes the record of a session whose key doctor cannot tell (`StepBlock`; VR1, VR2, VR3).
import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { PathSecurityError, readSecureFile } from "../config/paths.js";
import { looksLikeCredentialValue } from "../config/schema.js";
import { redactString, SecretRegistry } from "./log.js";
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
  /**
   * The settings that decline it (empty unless `declined`): `disabledMcpjsonServers` (a project
   * server the user did not approve, R-P5a) and `disabledMcpServers` (`/mcp disable` in a session
   * there, which turns off a server of any scope in that project only — F1).
   */
  readonly declinedBy: readonly DeclineSetting[];
  /**
   * No session Claude Code records starts it (verifier F2): a local-scope entry of a `projects` key
   * whose directory no longer exists — Claude Code never prunes those keys, and no session starts in
   * a missing directory — or a project-scope entry at or below whose directory no recorded project
   * still exists. Said once, its env still checked, never counted or judged as a launch.
   */
  readonly absent: boolean;
  /** An `absent` local entry whose recorded path is there but is no directory (V3-5). */
  readonly notDirectory?: true;
  /**
   * An `absent` local entry of a recorded directory that Claude Code 2.1.308 files under another key
   * (`codeProjectKey`: below a git work tree, in a linked worktree, or not its own real path — D-7):
   * no session of that client reads this record, so it never starts; and `claude mcp remove --scope
   * local` there, or `claude purge` of it while it exists, acts on `at`'s record instead.
   */
  readonly filedUnder?: { readonly at: string; readonly how: FiledHow };
  /**
   * An `absent` project-scope entry: a recorded directory at or below it exists, but each is filed
   * under another key (D-7) — a session opened there is doctor's known limit D-2.
   */
  readonly filedBelow?: true;
  /**
   * Why a local entry is removed by hand, never with `claude mcp remove`: doctor cannot tell which
   * record Claude Code 2.1.308 files its directory under (D-7 (d)).
   */
  readonly byHand?: string;
}

/** A setting that declines a server in a project (`ClientEntry.declinedBy`). */
export type DeclineSetting = "disabledMcpjsonServers" | "disabledMcpServers";

/**
 * One directory Claude Code sessions run in: a `projects` key of ~/.claude.json, which Claude Code
 * 2.1.308 writes for every session's project (`saveCurrentProjectConfig`) — never a parent directory
 * read only because a project lies below it (verifier V-B), and never a key whose directory no longer
 * exists (F2) — with the project servers its settings decline (`disabledMcpjsonServers`: the user
 * settings, `<dir>/.claude/settings.json` and `<dir>/.claude/settings.local.json`) and the servers
 * `/mcp disable` turned off there (`disabled`: its `projects` record's `disabledMcpServers`, which
 * Claude Code 2.1.308 applies to a server of ANY scope and to a plugin's, by its key — F1). Its view
 * is the user scope, its own local scope, and the `.mcp.json` of the directory and every ancestor
 * below the filesystem root, less what it declines or turns off (`duplicateRegistrations`). Known
 * limit (D-2): Claude Code files a session under its git root, and a session opened in a
 * subdirectory of a recorded project (or in a linked worktree, filed under its main repository)
 * reads that directory's own `.mcp.json` chain; doctor reads the recorded directories' only.
 */
export interface SessionView {
  readonly dir: string;
  readonly declined: readonly string[];
  readonly disabled: readonly string[];
  /**
   * Doctor could not stat the directory (the error code, e.g. `EACCES`; macOS privacy protection
   * gives `EPERM`): it is kept as a session, since Claude Code may still open it (V3-5).
   */
  readonly unchecked?: string;
  /**
   * Doctor cannot tell which key Claude Code 2.1.308 files a session here under (`codeProjectKey`
   * `unknown`, or `unchecked`): it is kept as a session, so a broken entry here still fails, but its
   * local entries are removed by hand, never with `claude mcp remove` (D-7 (d)).
   */
  readonly keyUnknown?: string;
  /**
   * The project servers approved here (`enabledMcpjsonServers` in the user settings,
   * `<dir>/.claude/settings.json` or `settings.local.json`, or the legacy field of its `projects`
   * record, which Claude Code 2.1.308 migrates into settings.local.json at startup): only an approved
   * one is started over the user scope's entry under its key (verifiers VR6-1, F2). Absent: none.
   */
  readonly approved?: readonly string[];
  /** `enableAllProjectMcpServers: true` in any of those: every project server is approved here. */
  readonly approvesAll?: true;
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

/**
 * An entry that is not a registration of this server — another program's, one doctor cannot tell, or
 * the plugin's own `.mcp.json` declaration in a copy of the plugin — by its key and where it lives.
 * Claude Code 2.1.308 starts one server per key in a session, the narrowest scope's (its dC: the
 * local scope over the approved project servers over the user scope; of the `.mcp.json` files, the
 * nearer over the farther): such an entry under a key of this server's at a narrower scope is what a
 * session there starts, never ours (verifiers V5-2, V5-3, U2) — a project server only where it is
 * approved (VR6-1, F2: one that is not is skipped while the user scope holds its key).
 */
export interface HeldEntry {
  readonly name: string;
  readonly scope: RegistrationScope;
  readonly dir: string | null;
  /**
   * A local-scope entry of a `projects` record no session reads (one Claude Code 2.1.308 files
   * under another key, a gone path, or a path that is no directory): it overrides nothing (F3: a
   * trailing-slash key's entry was matched to the session at the resolved path). Its key is still
   * one an entry uses.
   */
  readonly unread?: true;
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
  /**
   * Every entry that is not a registration of this server (`HeldEntry`): its key, never printed but
   * where it is one of this server's, decides which entry Claude Code starts under that key.
   */
  readonly held: readonly HeldEntry[];
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

/**
 * The characters a terminal acts on rather than shows (ruling D-8): the C0 controls (ESC, CR, LF,
 * TAB …), DEL, the C1 controls (U+0080–U+009F, CSI among them), the Unicode bidi controls (U+061C,
 * U+200E, U+200F, U+202A–U+202E, U+2066–U+2069) and the line and paragraph separators.
 */
const TERMINAL_CONTROL_RE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/gu;

/** Whether a word read from a file holds a terminal control (`escapeControls`). */
export function holdsControl(s: string): boolean {
  return s.search(TERMINAL_CONTROL_RE) >= 0;
}

/**
 * A line as doctor, uninstall and print-config print it (D-8): every terminal control escaped as
 * `\u{…}` (ESC is `\u{1b}`), so what a path, key or name read from a client config, settings file
 * or registry holds is shown, never acted on — in text and in `--json` (JSON.stringify escapes the
 * C0 controls but leaves the C1 and bidi ones raw). Idempotent.
 */
export function escapeControls(s: string): string {
  return s.replace(TERMINAL_CONTROL_RE, (c) => `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`);
}

/**
 * A line as doctor and uninstall print it: the log redaction patterns first (R-P1, defence: a
 * credential-shaped word in a key or path is pseudonymized — ruling D-6), then every terminal control
 * escaped (D-8). In that order (verifier V5-1): a pattern that needs the whitespace beside a secret
 * (`leagueId=<TAB><id>`, `Bearer<TAB><token>`) no longer sees it once the TAB is `\u{9}`.
 */
export function outputLine(s: string): string {
  return escapeControls(redactString(s, new SecretRegistry()));
}

/**
 * A word read from a file, JSON-quoted for a line that names it (a key, a projects key): redacted
 * before it is quoted (F4, V5-1 — quoting turns a TAB into `\t`, which no pattern reads as
 * whitespace), its controls escaped by `outputLine` with the rest of the line.
 */
export function quotedWord(s: string): string {
  return JSON.stringify(redactString(s, new SecretRegistry()));
}

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
/** Most `disabledMcpjsonServers` or `disabledMcpServers` names read from one list. */
const MAX_DECLINED = 256;

/** A list of server keys read from a file the user owns (bounded; anything else → none). */
function namesIn(list: unknown): string[] {
  return Array.isArray(list)
    ? list.slice(0, MAX_DECLINED).filter((n): n is string => typeof n === "string")
    : [];
}

/** An error's code when it is a plain `E…` word (never anything else read from it). */
function errorCode(e: unknown): string | null {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^E[A-Z]{2,15}$/u.test(code) ? code : null;
}

/**
 * What a recorded project path is (one stat, following a symbolic link as a session's cwd would):
 * `dir`; `missing` — nothing is there (ENOENT, or a path component that is a file: ENOTDIR), or no
 * filesystem holds such a path (Node's own argument error, which has no `E…` code: a NUL byte);
 * `file` — something that is no directory; or the code of any other stat failure (EACCES, EPERM),
 * which says nothing about whether Claude Code reaches it (V3-5).
 */
function dirState(dir: string): "dir" | "missing" | "file" | { readonly code: string } {
  try {
    return statSync(dir).isDirectory() ? "dir" : "file";
  } catch (e) {
    const code = errorCode(e);
    return code === null || code === "ENOENT" || code === "ENOTDIR" ? "missing" : { code };
  }
}

/**
 * The nearest of `start` and its ancestors, the filesystem root included, holding a `.git` (Claude
 * Code 2.1.308's `Zn`, lstat): `root` — a `.git` directory or regular file (`file`: a linked
 * worktree, a submodule…); null — none up to the root (a `.git` of another kind, a socket or a FIFO,
 * is no repository to that client either); `why` — doctor cannot tell at `at`: a `.git` that is a
 * symbolic link (Claude Code follows one it judges safe; doctor does not), a `.git` it cannot lstat
 * (EACCES; Claude Code takes any error as no repository and walks on), or a path deeper than doctor
 * walks (`deep`).
 */
function gitRootWalk(
  start: string,
):
  | { readonly root: string; readonly file: boolean }
  | { readonly why: string; readonly at: string; readonly deep?: true }
  | null {
  let at = path.resolve(start);
  for (let hop = 0; hop <= MAX_ANCESTORS; hop++) {
    const dotgit = path.join(at, ".git");
    try {
      const st = lstatSync(dotgit);
      if (st.isSymbolicLink())
        return { why: `${dotgit} is a symbolic link, which doctor does not follow`, at };
      if (st.isDirectory() || st.isFile()) return { root: at, file: st.isFile() };
    } catch (e) {
      const code = errorCode(e);
      if (code !== "ENOENT" && code !== "ENOTDIR")
        return { why: `doctor cannot check ${dotgit} (${code ?? "not a path"})`, at };
    }
    const up = path.dirname(at);
    if (up === at) return null;
    at = up;
  }
  return { why: "it lies deeper than doctor walks", at, deep: true };
}

/**
 * The git work tree Claude Code 2.1.308 files a session in `dir` under (its `t6e`: the nearest of
 * `dir` and its ancestors, the filesystem root included, holding a `.git` directory or file — read
 * with lstat, never followed), or null when none does: then Claude Code files the session under
 * `dir` itself. `unknown` (why): doctor cannot tell — a `.git` it cannot lstat or does not follow
 * (a symbolic link, a permission error), or a path deeper than it walks (verifier VR6-3: that was
 * null, so a gone directory 65 levels below a work tree was made and `claude mcp remove` run in it,
 * while Claude Code's walk up has no bound and acts on the work tree's record). The lexical walk the
 * gone-directory route keeps (V3-3); `codeProjectKey` is the full mapping of a directory that exists
 * (D-7).
 */
export function gitWorkTreeAt(dir: string): string | null | { readonly unknown: string } {
  const w = gitRootWalk(dir);
  if (w === null) return null;
  return "root" in w ? w.root : { unknown: w.why };
}

/**
 * What `realpath` gives for `dir` once `mkdir -p` makes it: the real path of its deepest existing
 * ancestor with the rest appended, NFC (Claude Code 2.1.308 keys a session by the real path of its
 * working directory) — or null when doctor cannot tell (an ancestor it cannot resolve).
 */
export function realPathOnceMade(dir: string): string | null {
  let at = path.resolve(dir);
  const rest: string[] = [];
  for (let hop = 0; hop <= MAX_ANCESTORS; hop++) {
    try {
      return path.join(realpathSync.native(at), ...rest).normalize("NFC");
    } catch (e) {
      const code = errorCode(e);
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
    }
    const up = path.dirname(at);
    if (up === at) return null;
    rest.unshift(path.basename(at));
    at = up;
  }
  return null;
}

/** Largest `.git`, `commondir` or `gitdir` file read when mapping a project key (a few hundred bytes). */
export const MAX_GIT_POINTER_BYTES = 4096;

/**
 * How a recorded project directory is filed under another key (`CodeProjectKey`): `real path or
 * work tree` — the record is not its directory's own real path (a trailing slash, another
 * spelling), and doctor cannot tell the git root above it, so the key is that real path or a git
 * work tree above it (verifier VR7-2).
 */
export type FiledHow =
  "work tree" | "main repository" | "bare repository" | "real path" | "real path or work tree";

/**
 * The key Claude Code 2.1.308 files a session opened in a directory under, and so the
 * `projects["<key>"]` record its local scope and `claude mcp add|remove --scope local` read and
 * write (its `t6e`, observed in that client's binary, 2026-11-11 — ruling D-7): the working directory
 * is first its real path (`realpathSync(cwd)`, NFC — the system's realpath, which on macOS also
 * gives each name's case as stored: `realpathSync.native` here); its git root is the nearest of it
 * and its ancestors holding a `.git` directory or file (`Zn`); the key is that root's canonical root (`St`/
 * `Qn`: a `.git` file whose `gitdir:` leads to `<common>/worktrees/<name>`, whose `commondir` names
 * the common directory and whose `gitdir` points back at this `.git`, is a linked worktree — filed
 * under its main repository, or under the bare repository it belongs to; anything else, a submodule
 * included, is its own root), or the real path itself outside git. `self`: the key is the recorded
 * string itself, so the record is the directory's own; `other`: another key (`at`, and `how`) —
 * no 2.1.308 session reaches the record; `unknown` (`why`): doctor cannot tell — a `.git` that is a
 * symbolic link or that it cannot lstat, a pointer file it cannot read or past
 * `MAX_GIT_POINTER_BYTES`, a pointer naming a path that holds a control character, a backslash or a
 * `//` start, a pointer path through a symbolic link, or a path it cannot resolve. Where Claude Code
 * keeps the worktree as its own root after a safety check of its own on a plain path, doctor files it
 * under the main repository (known limit: such a directory's entries are said as never started).
 */
export type CodeProjectKey =
  | { readonly kind: "self" }
  | { readonly kind: "other"; readonly at: string; readonly how: FiledHow }
  | { readonly kind: "unknown"; readonly why: string };

/** A path a git pointer file names that doctor follows (Claude Code's `Ki`/`SS` refuse odder ones). */
function plainPointer(p: string): boolean {
  return (
    p.length > 0 &&
    p.length <= MAX_GIT_POINTER_BYTES &&
    !holdsControl(p) &&
    !p.includes("\\") &&
    !p.startsWith("//")
  );
}

/** A git pointer file's text (bounded, never through a symbolic link), or why it was not read. */
function pointerText(file: string): { text: string } | { why: string } | null {
  try {
    const text = readSecureFile(file, {
      requirePrivate: false,
      maxBytes: MAX_GIT_POINTER_BYTES,
      what: "git pointer",
    });
    return text === null ? null : { text };
  } catch (e) {
    if (e instanceof PathSecurityError)
      switch (e.reason) {
        case "symlink":
          return { why: `${file} is a symbolic link` };
        case "too_large":
          return { why: `${file} is larger than ${String(MAX_GIT_POINTER_BYTES)} bytes` };
        default:
          return { why: `doctor cannot read ${file}` };
      }
    return { why: `doctor cannot read ${file}` };
  }
}

/** What is at a path, by lstat: its kind, or the code of an error other than ENOENT/ENOTDIR. */
function lkind(p: string): "absent" | "file" | "dir" | "symlink" | "other" | { code: string } {
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return "symlink";
    return st.isFile() ? "file" : st.isDirectory() ? "dir" : "other";
  } catch (e) {
    const code = errorCode(e);
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : { code: code ?? "not a path" };
  }
}

/** A path's real path, or null when it does not resolve (ENOENT/ENOTDIR), or the error code. */
function realOrNull(p: string): string | null | { code: string } {
  try {
    return realpathSync.native(p);
  } catch (e) {
    const code = errorCode(e);
    return code === "ENOENT" || code === "ENOTDIR" ? null : { code: code ?? "not a path" };
  }
}

/**
 * The canonical root of git root `root` (Claude Code 2.1.308's `St`/`Qn`), as `CodeProjectKey`'s
 * `at` and `how`, or why doctor cannot tell. Every refusal of that client's own returns the root.
 */
function canonicalRoot(
  root: string,
  dotGitIsFile: boolean,
): { readonly at: string; readonly how: FiledHow } | { readonly why: string } {
  const self = { at: root, how: "work tree" } as const;
  // a `.git` directory: the root itself (St's read fails, EISDIR); a root holding a backslash is
  // always its own (Qn's last refusal, which every other outcome but its own passes through)
  if (!dotGitIsFile || root.includes("\\")) return self;
  const dotgit = path.join(root, ".git");
  const read = pointerText(dotgit);
  if (read === null) return self;
  if ("why" in read) return read;
  const line = read.text.trim();
  if (!line.startsWith("gitdir:")) return self;
  const gitdir = line.slice(7).trim();
  if (!plainPointer(gitdir)) return { why: `${dotgit} names a path doctor does not follow` };
  const o = path.resolve(root, gitdir);
  const commondir = path.join(o, "commondir");
  const ck = lkind(commondir);
  if (typeof ck === "object") return { why: `doctor cannot check ${commondir} (${ck.code})` };
  // none (a submodule, a separate git directory), a link or anything but a file: the root itself
  if (ck !== "file") return self;
  const oReal = realOrNull(o);
  if (typeof oReal === "object" && oReal !== null)
    return { why: `doctor cannot resolve ${o} (${oReal.code})` };
  if (oReal !== o)
    return { why: `${o} passes through a symbolic link, which doctor does not follow` };
  const cread = pointerText(commondir);
  if (cread === null) return self;
  if ("why" in cread) return cread;
  const common = cread.text.trim();
  if (!plainPointer(common)) return { why: `${commondir} names a path doctor does not follow` };
  const c = path.resolve(o, common);
  if (path.resolve(path.dirname(o)) !== path.join(c, "worktrees")) return self;
  const back = path.join(o, "gitdir");
  const bk = lkind(back);
  if (typeof bk === "object") return { why: `doctor cannot check ${back} (${bk.code})` };
  if (bk !== "file") return self;
  const bread = pointerText(back);
  if (bread === null) return self;
  if ("why" in bread) return bread;
  const pointer = bread.text.trim();
  if (!plainPointer(pointer)) return { why: `${back} names a path doctor does not follow` };
  const target = path.resolve(o, pointer);
  const there = realOrNull(target);
  if (typeof there === "object" && there !== null)
    return { why: `doctor cannot resolve ${target} (${there.code})` };
  const mine = realOrNull(root);
  if (typeof mine === "object" && mine !== null)
    return { why: `doctor cannot resolve ${root} (${mine.code})` };
  if (there === null || mine === null || there !== path.join(mine, ".git")) return self;
  if (path.basename(c) !== ".git") {
    // a bare repository's worktree: the bare repository — unless it holds a `.git` of its own
    const inner = lkind(path.join(c, ".git"));
    if (typeof inner === "object")
      return { why: `doctor cannot check ${path.join(c, ".git")} (${inner.code})` };
    if (inner === "symlink")
      return { why: `${path.join(c, ".git")} is a symbolic link, which doctor does not follow` };
    if (inner === "file" || inner === "dir") return self;
    return { at: c.normalize("NFC"), how: "bare repository" };
  }
  return { at: path.dirname(c).normalize("NFC"), how: "main repository" };
}

/** See `CodeProjectKey`: the key Claude Code 2.1.308 files a session opened in `dir` under. */
export function codeProjectKey(dir: string): CodeProjectKey {
  const unknown = (why: string): CodeProjectKey => ({ kind: "unknown", why });
  const real = realOrNull(dir);
  if (real === null) return unknown("doctor cannot resolve its real path (it does not exist)");
  if (typeof real === "object")
    return unknown(`doctor cannot resolve its real path (${real.code})`);
  const cwd = real.normalize("NFC");
  // Claude Code 2.1.308 keys a session by a path its real working directory gives, never by
  // another spelling of it (a trailing slash, a symbolic link, another case or normalization): such
  // a record is read by no session whatever doctor can tell of the git root above (verifier VR7-2:
  // a walk doctor could not finish made "~/f/" the session ~/f's record)
  const cannotTell = (why: string): CodeProjectKey =>
    cwd === dir ? unknown(why) : { kind: "other", at: cwd, how: "real path or work tree" };
  const walk = gitRootWalk(cwd);
  if (walk !== null && "why" in walk) return cannotTell(walk.why);
  const key =
    walk === null ? { at: cwd, how: "real path" as const } : canonicalRoot(walk.root, walk.file);
  if ("why" in key) return cannotTell(key.why);
  const at = path.normalize(key.at.normalize("NFC"));
  return at === dir ? { kind: "self" } : { kind: "other", at, how: key.how };
}

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

/** What one settings object (or a legacy `projects` record) says of the project servers. */
interface ProjectChoices {
  readonly declined: readonly string[];
  readonly approved: readonly string[];
  readonly all: boolean;
}

/**
 * The project-server choices of a settings object: `disabledMcpjsonServers`, `enabledMcpjsonServers`
 * and `enableAllProjectMcpServers: true` (bounded; anything else → none). Claude Code 2.1.308 reads
 * the same fields of a `projects` record as legacy choices and moves them into the project's
 * settings.local.json at startup (its migration of enableAllProjectMcpServers to settings).
 */
function choicesOf(v: unknown): ProjectChoices {
  if (!isObj(v)) return { declined: [], approved: [], all: false };
  return {
    declined: namesIn(v.disabledMcpjsonServers),
    approved: namesIn(v.enabledMcpjsonServers),
    all: v.enableAllProjectMcpServers === true,
  };
}

/** A settings file's project-server choices (`choicesOf`; unreadable or malformed → none). */
function choicesIn(file: string): ProjectChoices {
  const r = readJson(file, MAX_PROJECT_FILE_BYTES);
  return choicesOf(r === null || r === "invalid" ? null : r.value);
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
    held: [],
    projectFiles: [],
    sessions: [],
  } as const;
  const read = readJson(file, MAX_CLIENT_CONFIG_BYTES);
  if (read === "invalid") return { ...empty, state: "invalid" };
  if (read === null) return { ...empty, state: "missing" };
  const entries: ClientEntry[] = [];
  const envBlocks: EnvBlock[] = [];
  const notOurs: NotOursEntry[] = [];
  const held: HeldEntry[] = [];
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
          declinedBy: [],
          absent: false,
        });
      } else {
        others++;
        held.push({ name, scope: m.scope, dir: m.dir });
      }
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
      held,
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
  // under `projects`, so a parent directory read only for the projects below it has had none (V-B);
  // only those that still exist — Claude Code never prunes a key, and no session starts in a
  // missing directory (F2); and only those Claude Code 2.1.308 files a session under (D-7: a
  // directory below a git work tree, in a linked worktree, or not its own real path is filed under
  // another key, so no session reads its record)
  const userChoices = choicesIn(path.join(path.dirname(file), ".claude", "settings.json"));
  const records = isObj(read.value) && isObj(read.value.projects) ? read.value.projects : {};
  const turnedOff = new Map<string, string[]>();
  /** The legacy project-server choices of the records each session reads (VR6-1). */
  const legacy = new Map<string, ProjectChoices[]>();
  /** The recorded keys a session reads: only their local entries can override ours (F3). */
  const read_ = new Set<string>();
  /** A recorded path that is there but is no directory (no session either: V3-5). */
  const files = new Set<string>();
  /** A directory doctor cannot stat: a session all the same, said (V3-5). */
  const unchecked = new Map<string, string>();
  /** A recorded key Claude Code 2.1.308 files under another key: no session (D-7). */
  const filed = new Map<string, { readonly at: string; readonly how: FiledHow }>();
  /** A session whose key doctor cannot tell: its local entries are removed by hand (D-7 (d)). */
  const keyUnknown = new Map<string, string>();
  for (const key of known) {
    const state = dirState(key);
    const dir = path.resolve(key);
    if (state === "missing") continue;
    if (state === "file") {
      files.add(dir);
      continue;
    }
    if (state === "dir") {
      const k = codeProjectKey(key);
      if (k.kind === "other") {
        filed.set(key, { at: k.at, how: k.how });
        continue;
      }
      if (k.kind === "unknown") keyUnknown.set(dir, k.why);
    } else {
      unchecked.set(dir, state.code);
      keyUnknown.set(dir, `doctor cannot check ${dir} (${state.code})`);
    }
    const rec = records[key];
    read_.add(key);
    turnedOff.set(dir, [
      ...(turnedOff.get(dir) ?? []),
      ...(isObj(rec) ? namesIn(rec.disabledMcpServers) : []),
    ]);
    legacy.set(dir, [...(legacy.get(dir) ?? []), choicesOf(rec)]);
  }
  const sessions: SessionView[] = [...turnedOff].map(([dir, off]) => {
    const code = unchecked.get(dir);
    const unknownKey = keyUnknown.get(dir);
    // the project-server choices Claude Code 2.1.308 reads for a session here: the user settings,
    // the project's settings and local settings, and its records' legacy fields (R-P5a, VR6-1)
    const choices = [
      userChoices,
      choicesIn(path.join(dir, ".claude", "settings.json")),
      choicesIn(path.join(dir, ".claude", "settings.local.json")),
      ...(legacy.get(dir) ?? []),
    ];
    const approved = [...new Set(choices.flatMap((c) => c.approved))];
    return {
      dir,
      declined: [...new Set(choices.flatMap((c) => c.declined))],
      disabled: [...new Set(off)],
      ...(code === undefined ? {} : { unchecked: code }),
      ...(unknownKey === undefined ? {} : { keyUnknown: unknownKey }),
      ...(approved.length === 0 ? {} : { approved }),
      ...(choices.some((c) => c.all) ? { approvesAll: true as const } : {}),
    };
  });
  // a local entry of a record no session reads overrides nothing (F3); its key stays one in use
  const heldRead = held.map((h): HeldEntry =>
    h.scope === "local" && h.dir !== null && !read_.has(h.dir) ? { ...h, unread: true } : h,
  );
  // an entry is declined when every session that would see it declines it or turns it off (a
  // local-scope one: its own project's session; a project-scope one: every session at or below
  // its directory), and absent when no such session exists (F1, F2) — a local one of a directory
  // filed under another key included (D-7)
  const marked = entries.map((e): ClientEntry => {
    if (e.dir === null || (e.scope !== "project" && e.scope !== "local")) return e;
    const top = path.resolve(e.dir);
    const filedAs = e.scope === "local" ? filed.get(e.dir) : undefined;
    if (filedAs !== undefined) return { ...e, absent: true, filedUnder: filedAs };
    const seeing = sessions.filter((v) =>
      e.scope === "local" ? v.dir === top : within(top, v.dir),
    );
    if (seeing.length === 0)
      return e.scope === "local"
        ? files.has(top)
          ? { ...e, absent: true, notDirectory: true }
          : { ...e, absent: true }
        : [...filed.keys()].some((k) => within(top, path.resolve(k)))
          ? { ...e, absent: true, filedBelow: true }
          : { ...e, absent: true };
    // its directory's key doctor cannot tell: still a session's, removed by hand (D-7 (d))
    const byHand = e.scope === "local" ? keyUnknown.get(top) : undefined;
    const kept = byHand === undefined ? e : { ...e, byHand };
    const by = new Set<DeclineSetting>();
    for (const v of seeing) {
      if (e.scope === "project" && v.declined.includes(e.name)) by.add("disabledMcpjsonServers");
      else if (v.disabled.includes(e.name)) by.add("disabledMcpServers");
      else return kept;
    }
    const declinedBy = (["disabledMcpjsonServers", "disabledMcpServers"] as const).filter((k) =>
      by.has(k),
    );
    return { ...kept, declined: true, declinedBy };
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
    held: heldRead,
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

/** A word as a shell reads it: bare when it is plain, else single-quoted. */
export function shellWord(s: string): string {
  return /^[A-Za-z0-9_/.:=@%+,-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * The exact command that removes one Claude Code registration: `claude mcp remove` with
 * `-s/--scope local|user|project` and its key (Claude Code's `mcp remove <name>`). A local-scope
 * entry belongs to the project directory Claude Code was started in (`projects["<dir>"]`), and a
 * project-scope one to that directory's `.mcp.json`, so those are run from there.
 */
export function removeCommand(e: Pick<ClientEntry, "scope" | "dir" | "name">): string {
  const q = shellWord;
  if (e.scope === "user") return `claude mcp remove --scope user ${q(e.name)}`;
  const scope = e.scope === "project" ? "project" : "local";
  return `cd ${q(e.dir ?? ".")} && claude mcp remove --scope ${scope} ${q(e.name)}`;
}

/** Where a recorded directory is filed instead (`ClientEntry.filedUnder`), as a line says it. */
export function filedWhere(f: { readonly at: string; readonly how: FiledHow }): string {
  switch (f.how) {
    case "work tree":
      return `the git work tree at ${f.at}`;
    case "main repository":
      return `the main repository at ${f.at} of the linked worktree it is in`;
    case "bare repository":
      return `the bare repository at ${f.at} of the linked worktree it is in`;
    case "real path":
      return `its real path ${f.at}`;
    case "real path or work tree":
      return `its real path ${f.at} or a git work tree above it (doctor cannot tell which)`;
  }
}

/** The record a command run in a directory filed under another key acts on, as a line names it. */
function recordOf(f: { readonly at: string; readonly how: FiledHow }): string {
  return f.how === "real path or work tree" ? `${f.at} or of a git work tree above it` : f.at;
}

/** Why a registration's `claude mcp remove` is not printed (`removalOf`), or null when it is. */
function byHandWhy(
  e: Pick<ClientEntry, "scope" | "dir" | "name" | "filedUnder" | "byHand">,
): string | null {
  const key = holdsControl(e.name);
  const dir = e.dir !== null && e.scope !== "user" && holdsControl(e.dir);
  if (key || dir)
    return `its ${key && dir ? "key and directory hold" : key ? "key holds" : "directory holds"} a control character, which no command shows as it runs`;
  if (e.scope !== "local") return null;
  if (e.filedUnder !== undefined)
    return `\`claude mcp remove\` there, or \`claude purge\` of it while it exists, acts on the record of ${recordOf(e.filedUnder)}`;
  if (e.byHand !== undefined)
    return `doctor cannot tell which record \`claude mcp remove\` there acts on: ${e.byHand}`;
  return null;
}

/**
 * How one registration is removed, as a fix line or uninstall step says it: its exact `claude mcp
 * remove` (`removeCommand`) — or, where that command would act on another record or show otherwise
 * than it runs, the hand edit of its own record, with every Claude Code session closed and the file
 * backed up first (D-7: a directory Claude Code 2.1.308 files under another key, or whose key doctor
 * cannot tell; D-8: a key or directory holding a terminal control). The hand edit names exactly the
 * record it changes (`projects["<dir>"].mcpServers["<key>"]`, or the key in `.mcp.json`).
 */
export function removalOf(
  e: Pick<ClientEntry, "scope" | "dir" | "name" | "file" | "filedUnder" | "byHand">,
): { readonly command: string } | { readonly byHand: string } {
  const why = byHandWhy(e);
  if (why === null) return { command: removeCommand(e) };
  const q = quotedWord;
  const closed = "with every Claude Code session closed and the file backed up first";
  switch (e.scope) {
    case "user":
      return {
        byHand: `delete mcpServers[${q(e.name)}] from ${e.file} by hand, ${closed} (${why})`,
      };
    case "project":
      return {
        byHand: `delete mcpServers[${q(e.name)}] from ${path.join(e.dir ?? ".", ".mcp.json")} by hand, the file backed up first (${why})`,
      };
    default:
      return {
        byHand: `delete projects[${q(e.dir ?? "?")}].mcpServers[${q(e.name)}] from ${e.file} by hand, ${closed} (${why})`,
      };
  }
}

/**
 * Why doctor offers no step that writes a session directory's record there (`UnresolvedView.leaves`,
 * `StrippedView`): `key` — it cannot tell which record Claude Code 2.1.308 files a session there
 * under, and `claude mcp add|remove --scope local`, `/mcp enable` and `/mcp disable` all write that
 * one (D-7 (d); verifiers VR1, VR2); `control` — the path holds a terminal control, which no command
 * shows as it runs (D-8: `/mcp enable` there is still offered, a command naming no path).
 */
export type StepBlock = "key" | "control";

/** A view the keep rule cannot settle: which entry to keep there is the user's. */
export interface UnresolvedView {
  /** The session directory, or null: a session outside every project Claude Code records. */
  readonly dir: string | null;
  /**
   * The `claude mcp add` entries still started there, one per key (never the plugin, nor an entry a
   * step adds, nor one behind another of this server's under its key: verifier VR7-1).
   */
  readonly entries: readonly ClientEntry[];
  /**
   * What the plan keeps there beside them, so that every one of them goes there (turned off): the
   * plugin, or the entry an uninstall step adds — null: one of them is kept there (verifier U5: a
   * project that turned the plugin off was told to turn every entry off).
   */
  readonly beside: "plugin" | "added" | null;
  /**
   * Outside the projects, beside the plugin: the projects that turn the plugin off and start none of
   * this server's entries but these, which removing them would leave with no server (verifier U3) —
   * each with the keys of these it starts, the only ones keeping them there adds at local scope (F1:
   * every key added in every project overrode another program's entry where it held one, and started
   * two of this server's), and why a step there is withheld (`blocked`: no local add where doctor
   * cannot tell which record `claude mcp add --scope local` writes or the path holds a terminal
   * control — VR6-2, D-7 (d), D-8 — and no `/mcp enable` either where it cannot tell the record:
   * VR1; null: both are offered).
   */
  readonly leaves: readonly {
    readonly dir: string;
    readonly keys: readonly string[];
    readonly blocked: StepBlock | null;
  }[];
  /**
   * Outside the projects, beside no plugin: the projects that start one of these where doctor offers
   * no `claude mcp add --scope local` (`blocked`, as for `leaves`).
   */
  readonly noAdd: readonly { readonly dir: string; readonly blocked: StepBlock }[];
  /**
   * In a project: the entries of `entries` that, declined there (a project server:
   * `disabledMcpjsonServers` in its settings.local.json) or removed (a local-scope one), leave
   * nothing started under their key there — only those may be turned off that way instead of `/mcp
   * disable`, which turns the key off whatever scope holds it (verifier VR7-3: another entry of this
   * server's under that key then started there, beside the one kept).
   */
  readonly alone: readonly ClientEntry[];
  /** In a project whose key doctor cannot tell: no step there writes a record (D-7 (d), VR1). */
  readonly keyUnknown?: true;
}

/** A view where uninstalling the plugin (and the plan without it) leaves no server (V3-1). */
export interface StrippedView {
  /** The session directory, or null: the sessions outside every project Claude Code records. */
  readonly dir: string | null;
  /**
   * The key turned back on there (`/mcp enable`; at most one: more would only be removed again) —
   * of an entry `/mcp disable` turned off there that Claude Code would start there (VR4-2, V5-2).
   */
  readonly off: readonly string[];
  /**
   * Nothing of this server's reaches it to turn back on: the key this server is added under at
   * local scope there (this server's own where no entry there holds it, else one no entry uses).
   */
  readonly addLocal?: string;
  /**
   * Doctor cannot tell which record a session there reads, and it would have to turn a key back on
   * or add an entry there: that step is the user's, never a printed `/mcp enable` or `claude mcp
   * add --scope local`, which write that record (D-7 (d); verifier VR2).
   */
  readonly keyUnknown?: true;
}

/** The entry an uninstall step adds at user scope (`duplicateRegistrations`), and why its key. */
export interface UninstallAdd {
  /** `espn-fantasy-football`, or — where that key is another program's — one no entry uses. */
  readonly key: string;
  /**
   * Where another program's entry holds `espn-fantasy-football` so that this server cannot start
   * under it (null: the user scope, where `claude mcp add` refuses a key it holds — U2; a project:
   * a narrower scope there, which Claude Code starts instead — V5-2, V5-3). Empty for that key.
   */
  readonly heldIn: readonly (string | null)[];
}

/** The plugin beside the registrations, as `duplicateRegistrations` counts it. */
export interface PluginBeside {
  /** Its server's key (print-config.ts `PLUGIN_SERVER_KEY`): a session whose `disabledMcpServers` names it runs none. */
  readonly key: string;
  /** An entry running the plugin's own command line: Claude Code drops the plugin's server beside it (R-P4). */
  readonly drops: (e: ClientEntry) => boolean;
}

/** An entry as the keep rule places it: its key and where it lives. */
type Placed = Pick<ClientEntry, "name" | "scope" | "dir">;

/** A view as the keep rule plans it: where, and whether the plugin is kept there (pinned). */
interface PlanView {
  readonly dir: string | null;
  readonly plugin: boolean;
}

/** The keys tried, in order, for an entry a step adds where this server's own key is taken. */
function* spareKeys(): Generator<string> {
  yield PACKAGE_NAME;
  for (let i = 2; ; i++) yield `${SERVER_NAME}-${String(i)}`;
}

/**
 * Registrations of this server that run beside each other in one client (README "One registration
 * per client"; verifier A-F3: two `claude mcp add` entries under different keys, without the
 * plugin, were never called a duplicate). Claude Code: a session in one of the `sessions`
 * directories (the projects it records that still exist) reads the user scope, that directory's
 * local scope, and the project scope of its `.mcp.json` and every ancestor's (R-P5b), less the
 * project servers its settings decline (R-P5a); under each key it starts ONE entry, the one its dC
 * picks (`winnerOf`: local over project over user, the nearer `.mcp.json` over the farther, a
 * project server over the user scope only where it is approved — VR6-1, F2), less every key `/mcp
 * disable` turned off there, whatever scope holds it (F1); a session outside them reads the user
 * scope alone. So an entry that is not this server (`held`: another program's, one doctor cannot
 * tell, the plugin's own declaration) winning a key of ours is what starts there, never ours (V5-2,
 * V5-3: `overriddenIn` says where), and an entry of ours behind another under its key does not start
 * there either — no step may rely on it, and removing the one that does start exposes whatever wins
 * next, another program's entry included (verifier VR7-1: `startsOf`). A parent directory's
 * `.mcp.json` counts only in the views of the sessions below it — never as a view of its own
 * (verifier V-B). Claude Desktop: one map, one server per key. `views`: what each view starts;
 * `most`: the most servers one view starts; `extra`: the entries whose removal leaves one key in each
 * view it can — never leaving a view that starts a server with none (V-B), each view's starts
 * recomputed over what is left (VR7-1). In each view the key kept is the first whose keeping strips
 * no view — removing a key there removes every entry of ours under it that the view reads — ranked by
 * how many views its entry starts in, then by how wide it is (the user scope's, then the farthest
 * ancestor's `.mcp.json`), then `espn-fantasy-football`, then the first; `unresolved`: the views
 * where every choice would strip another view, with the entries still there — which to keep there is
 * the user's, and `alone` the ones a decline or removal turns off there (VR7-3). The plugin's own
 * `.mcp.json` declaration is never a registration (`pluginSource`). With `plugin` (one Claude Code
 * may load): `withPlugin` counts it in each view where it is not turned off and no entry that view
 * starts runs its command line (`worst`; `beside`: such a view holds an entry too — Claude Code's
 * B5r dedupes the plugin against the started entries only, VR7-4: `dropping` says where an entry
 * running that line drops it and where it does not start), and plans the fix that keeps it — each
 * entry removed where the plugin stays, none whose removal strips a view that turned the plugin off
 * (F1), the plugin's views settled first, each unresolved view saying whether the plugin stays there
 * (U5) and, outside the projects, which projects the choice would strip (U3); a removed entry running
 * its command line gives the plugin back; and `uninstallStrips`: the views where the plugin is
 * started and the plan without it leaves no entry — uninstalling the plugin would leave them with no
 * server (V3-1), each with what gives it one first: where the sessions outside the projects are
 * stripped, this server added at user scope (`uninstallAdd`: under `espn-fantasy-football` where
 * Claude Code would start it in every stripped project, turned back on where a project turned that
 * key off — VR4-2 — else under a key no entry uses, as another program's entry holds that one: U2,
 * V5-2, V5-3); else, in each stripped project, the best-ranked entry `/mcp disable` turned off there
 * that Claude Code would start there, or this server added at local scope there where nothing is (and
 * doctor can tell which record that command writes: D-7 (d)); where doctor cannot tell which record a
 * session there reads, no step at all (VR2); and `uninstallExtra`/`uninstallUnresolved`: the keep
 * rule over the views as those first steps leave them, what the steps add kept (VR4-3: the entry a
 * step adds never starts beside another entry of this server). `offIn`: each entry that a session
 * where `/mcp disable` turned it off would start, and those sessions (V3-1: said, the way the
 * plugin's off state is). The greedy rule is accepted as such (D-3).
 */
export function duplicateRegistrations(
  entries: readonly ClientEntry[],
  sessions: readonly SessionView[] = [],
  plugin: PluginBeside | null = null,
  held: readonly HeldEntry[] = [],
): {
  readonly most: number;
  readonly extra: readonly ClientEntry[];
  readonly views: readonly (readonly ClientEntry[])[];
  readonly unresolved: readonly UnresolvedView[];
  readonly offIn: readonly { readonly entry: ClientEntry; readonly dirs: readonly string[] }[];
  readonly overriddenIn: readonly {
    readonly entry: ClientEntry;
    readonly dirs: readonly string[];
    /** `narrower`: held at a narrower scope there; `unapproved`: a project server of ours not
     * approved there, its key held at user scope (VR6-1). */
    readonly by: "narrower" | "unapproved";
  }[];
  readonly withPlugin: {
    readonly worst: { readonly servers: number; readonly keys: number; readonly plugin: boolean };
    readonly beside: boolean;
    readonly extra: readonly ClientEntry[];
    readonly unresolved: readonly UnresolvedView[];
    readonly uninstallStrips: readonly StrippedView[];
    readonly uninstallAdd: UninstallAdd | null;
    readonly uninstallExtra: readonly ClientEntry[];
    readonly uninstallUnresolved: readonly UnresolvedView[];
    /**
     * Each entry running the plugin's own command line that a view where the plugin is on starts —
     * Claude Code drops the plugin's server there — and the session directories where the plugin
     * is on but the entry does not start (another entry holds its key there), so the plugin starts
     * there (VR7-4).
     */
    readonly dropping: readonly {
      readonly entry: ClientEntry;
      readonly notIn: readonly string[];
    }[];
  } | null;
} {
  const regs = entries.filter((e) => !e.pluginSource);
  // every entry that is not a registration of this server, by key: the plugin's own declaration in
  // a copy of the plugin is one too (Claude Code reads it there as a project server)
  const others = new Map<string, (Placed & { readonly unread?: true })[]>();
  for (const h of [...held, ...entries.filter((e) => e.pluginSource)])
    others.set(h.name, [...(others.get(h.name) ?? []), h]);
  const narrow = (e: Placed): boolean => e.scope === "local" || e.scope === "project";
  const at = (e: Placed): string => path.resolve(e.dir ?? ".");
  const segments = (e: Placed): number =>
    at(e)
      .split(path.sep)
      .filter((x) => x !== "").length;
  const byDir = new Map(
    sessions.map((v) => [
      path.resolve(v.dir),
      {
        declined: new Set(v.declined),
        disabled: new Set(v.disabled),
        keyUnknown: v.keyUnknown !== undefined,
        approved: new Set(v.approved ?? []),
        approvesAll: v.approvesAll === true,
      },
    ]),
  );
  const off = (d: string | null, key: string): boolean =>
    d !== null && byDir.get(d)?.disabled.has(key) === true;
  /** Why a step that writes `d`'s record is withheld there, or null (`StepBlock`). */
  const blockedIn = (d: string): StepBlock | null =>
    byDir.get(d)?.keyUnknown === true ? "key" : holdsControl(d) ? "control" : null;
  /**
   * Whether a session in `d` reads `e` at all: its scope, less a project server declined there —
   * never an entry of a record no session reads (F3: a held one `unread`, one of this server's
   * `absent`; a trailing-slash key resolves to the session's own path, yet Claude Code 2.1.308 reads
   * only the record keyed exactly so).
   */
  const reads = (
    d: string | null,
    e: Placed & { readonly unread?: true; readonly absent?: boolean },
  ): boolean => {
    if (e.unread === true || e.absent === true) return false;
    if (d === null) return !narrow(e); // the user scope, or Claude Desktop's one map
    if (!narrow(e)) return true;
    if (e.scope === "local") return at(e) === d;
    return within(at(e), d) && byDir.get(d)?.declined.has(e.name) !== true;
  };
  /** Whether a session in `d` approves the project server `key` (VR6-1, F2). */
  const approved = (d: string, key: string): boolean => {
    const v = byDir.get(d);
    return v !== undefined && (v.approvesAll || v.approved.has(key));
  };
  const otherEntries = new Set([...others.values()].flat());
  /**
   * The entry a session in `d` starts under `key`, of `pool` (this server's entries, and those a
   * step adds) and every entry under that key that is not this server's, of those it reads —
   * Claude Code 2.1.308's dC: a local-scope entry over all; else the nearest `.mcp.json`'s (the
   * files merged before any approval) where that key is approved there or the user scope does not
   * hold it (then it is offered: doctor's reading, R-P5a); else the user scope's — a project server
   * not approved is skipped while the user or local scope holds its key, and never offered
   * (verifiers VR6-1, F2). Outside the projects: the user scope's, or Claude Desktop's one map.
   */
  const pick = (d: string | null, key: string, cs: readonly Placed[]): Placed | undefined => {
    if (d === null) return cs[0];
    const local = cs.find((x) => x.scope === "local");
    if (local !== undefined) return local;
    const user = cs.find((x) => x.scope === "user");
    let near: Placed | undefined;
    for (const x of cs)
      if (x.scope === "project" && (near === undefined || segments(x) > segments(near))) near = x;
    if (near === undefined) return user;
    return user === undefined || approved(d, key) ? near : user;
  };
  const othersRead = (d: string | null, key: string): Placed[] =>
    (others.get(key) ?? []).filter((x) => reads(d, x));
  const winnerOf = (d: string | null, key: string, pool: readonly Placed[]): Placed | undefined =>
    pick(d, key, [...pool.filter((x) => x.name === key && reads(d, x)), ...othersRead(d, key)]);
  /**
   * What a session in `d` starts of `pool`, in its order: each entry that wins its key there
   * (`winnerOf`), less a key `/mcp disable` turned off there unless `on` turns it back on (an
   * uninstall step) — one entry per key (verifier VR7-1: an entry of ours behind another under its
   * key was counted there, and a removal relied on it where another program's entry wins next).
   */
  const startsOf = (
    d: string | null,
    pool: readonly ClientEntry[],
    on?: ReadonlySet<string>,
  ): ClientEntry[] => {
    const byKey = new Map<string, ClientEntry[]>();
    for (const e of pool) if (reads(d, e)) byKey.set(e.name, [...(byKey.get(e.name) ?? []), e]);
    const won = new Set<Placed>();
    for (const [k, es] of byKey)
      if (!off(d, k) || on?.has(k) === true) {
        const w = pick(d, k, [...es, ...othersRead(d, k)]);
        if (w !== undefined) won.add(w);
      }
    return pool.filter((e) => won.has(e));
  };
  /**
   * Why an entry that is not this server is what a session in `d` starts under `e`'s key instead,
   * or null: it is not — `narrower` (a local entry, a nearer `.mcp.json`'s, an approved project
   * server over the user scope) or `unapproved` (a user-scope entry over a project server of this
   * server's not approved there: VR6-1).
   */
  const overrider = (d: string | null, e: Placed): "narrower" | "unapproved" | null => {
    if (d === null) return null;
    const w = winnerOf(d, e.name, regs);
    if (w === undefined || !otherEntries.has(w)) return null;
    return w.scope === "user" ? "unapproved" : "narrower";
  };
  const sessionDirs = [...byDir.keys()];
  const offIn = regs.flatMap((entry) => {
    const dirs = sessionDirs.filter(
      (d) => reads(d, entry) && off(d, entry.name) && winnerOf(d, entry.name, regs) === entry,
    );
    return dirs.length > 0 ? [{ entry, dirs }] : [];
  });
  const overriddenIn = regs.flatMap((entry) =>
    (["narrower", "unapproved"] as const).flatMap((by) => {
      const dirs = sessionDirs.filter((d) => reads(d, entry) && overrider(d, entry) === by);
      return dirs.length > 0 ? [{ entry, dirs, by }] : [];
    }),
  );
  const views = [null, ...sessionDirs].map((dir) => ({
    dir,
    entries: startsOf(dir, regs),
    plugin: plugin !== null && !off(dir, plugin.key),
  }));
  /** How far up an entry reaches: the user scope above all, then the shallower directory. */
  const depth = (e: ClientEntry): number => (narrow(e) ? segments(e) : -1);
  const keysOf = (es: readonly ClientEntry[]): string[] => [...new Set(es.map((e) => e.name))];
  const most = Math.max(0, ...views.map((v) => keysOf(v.entries).length));
  /** The plugin's server, as the keep rule pins it in each view where it is on. */
  const pseudo: ClientEntry = {
    name: plugin?.key ?? "",
    spec: {},
    scope: "user",
    file: "",
    dir: null,
    pluginSource: false,
    declined: false,
    declinedBy: [],
    absent: false,
  };
  /**
   * The keep rule over `vs`, whose sessions start `pool`'s entries (`startsOf`, with `on` turned
   * back on where an uninstall step does) and the plugin where a view keeps it; `pinned`: the
   * plugin, or what an uninstall step adds — kept in every view it is in (never removed), each other
   * key removed there where that strips no view. Every check recomputes what each view starts over
   * what is left (VR7-1): a removal exposes whatever wins its key next.
   */
  const plan = (
    vs: readonly PlanView[],
    pool: readonly ClientEntry[],
    pinned: ReadonlyMap<ClientEntry, "plugin" | "added">,
    on: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  ): { extra: ClientEntry[]; unresolved: UnresolvedView[] } => {
    const served = (v: PlanView, gone: ReadonlySet<ClientEntry>): ClientEntry[] => [
      ...startsOf(
        v.dir,
        pool.filter((e) => !gone.has(e)),
        v.dir === null ? undefined : on.get(v.dir),
      ),
      ...(v.plugin ? [pseudo] : []),
    ];
    const before = vs.map((v) => served(v, new Set()));
    /** Every entry of `pool` a view reads: each may start there once those before it go. */
    const readBy = vs.map((v) => pool.filter((e) => reads(v.dir, e)));
    // how many of these views each entry reaches — reads, under a key an entry of ours starts
    // there (itself, or one before it under that key): the ranking's first key
    const reach = new Map<ClientEntry, number>();
    for (const [i, s] of before.entries()) {
      const keys = new Set(s.map((e) => e.name));
      for (const e of readBy[i] ?? []) if (keys.has(e.name)) reach.set(e, (reach.get(e) ?? 0) + 1);
    }
    const extra: ClientEntry[] = [];
    const gone = (more: readonly ClientEntry[] = []): Set<ClientEntry> =>
      new Set([...extra, ...more]);
    /** Removing `drop` beside `extra` leaves a view that starts a server with none. */
    const strips = (drop: readonly ClientEntry[]): boolean => {
      const g = gone(drop);
      return vs.some(
        (w, i) =>
          (before[i]?.length ?? 0) > 0 &&
          (readBy[i] ?? []).some((e) => drop.includes(e)) &&
          served(w, g).length === 0,
      );
    };
    /** The keys of `rest` (what view `i` starts) that what is pinned holds there. */
    const pinnedKeysOf = (i: number, rest: readonly ClientEntry[]): Set<string> =>
      new Set(
        rest
          .filter(
            (e) =>
              pinned.has(e) ||
              (readBy[i] ?? []).some(
                (x) => x.name === e.name && pinned.has(x) && !extra.includes(x),
              ),
          )
          .map((e) => e.name),
      );
    for (const [i, v] of vs.entries()) {
      const rest = served(v, gone());
      const keys = keysOf(rest);
      if (keys.length < 2) continue;
      // removing a key there removes every entry of ours under it the view reads, never a pinned one
      const of = (k: string): ClientEntry[] =>
        (readBy[i] ?? []).filter((e) => e.name === k && !extra.includes(e) && !pinned.has(e));
      const reachOf = (k: string): number => Math.max(0, ...of(k).map((e) => reach.get(e) ?? 0));
      const depthOf = (k: string): number => Math.min(...of(k).map(depth));
      const ranked = [...keys].sort(
        (a, b) =>
          reachOf(b) - reachOf(a) ||
          depthOf(a) - depthOf(b) ||
          Number(b === SERVER_NAME) - Number(a === SERVER_NAME),
      );
      const kept = pinnedKeysOf(i, rest);
      if (kept.size > 0) {
        // what is pinned stays: each other key goes where that strips no view, the lowest ranked first
        for (const k of ranked.filter((x) => !kept.has(x)).reverse()) {
          const drop = of(k);
          if (!strips(drop)) extra.push(...drop);
        }
        continue;
      }
      const dropFor = (k: string): ClientEntry[] => keys.filter((x) => x !== k).flatMap(of);
      const keep = ranked.find((k) => !strips(dropFor(k)));
      if (keep !== undefined) extra.push(...dropFor(keep));
    }
    const left = pool.filter((e) => !extra.includes(e));
    const unresolved = vs.flatMap((v, i): UnresolvedView[] => {
      const rest = served(v, gone());
      if (keysOf(rest).length < 2) return [];
      // never one under a key of what is pinned: `/mcp disable` of that key there turns off both
      const pinnedKeys = pinnedKeysOf(i, rest);
      const pin =
        rest.find((e) => pinned.has(e)) ??
        (readBy[i] ?? []).find((x) => pinned.has(x) && pinnedKeys.has(x.name));
      const beside = pin === undefined ? null : (pinned.get(pin) ?? null);
      const choice = rest.filter((e) => !pinnedKeys.has(e.name));
      const d = v.dir;
      if (d === null) {
        // outside the projects, beside the plugin: the projects that start nothing else of ours
        // once these go (U3) — what a project that turns the plugin off would be left without (a
        // view holding what is pinned never is: what is pinned still starts there)
        const leaves =
          beside === null
            ? []
            : vs.flatMap((w) => {
                const wd = w.dir;
                if (wd === null) return [];
                const now = served(w, gone()).filter((e) => choice.includes(e));
                if (now.length === 0 || served(w, gone(choice)).length > 0) return [];
                return [{ dir: wd, keys: keysOf(now), blocked: blockedIn(wd) }];
              });
        // beside no plugin: the projects starting one of these where no local add is offered
        const noAdd = vs.flatMap((w) => {
          const wd = w.dir;
          if (wd === null || !served(w, gone()).some((e) => choice.includes(e))) return [];
          const blocked = blockedIn(wd);
          return blocked === null ? [] : [{ dir: wd, blocked }];
        });
        return [{ dir: d, entries: choice, beside, leaves, noAdd, alone: [] }];
      }
      // turned off by a decline (a project server, by its key, in this directory's settings) or a
      // removal (a local-scope entry), an entry leaves nothing started under its key here only where
      // no other entry — this server's or another program's — wins that key next (VR7-3)
      const next = (e: ClientEntry): boolean =>
        e.scope === "project"
          ? [...left, ...(others.get(e.name) ?? [])].some(
              (x) => x.name === e.name && x.scope !== "project" && reads(d, x),
            )
          : winnerOf(
              d,
              e.name,
              left.filter((x) => x !== e),
            ) !== undefined;
      const alone = choice.filter(
        (e) => (e.scope === "project" || e.scope === "local") && !next(e),
      );
      return [
        {
          dir: d,
          entries: choice,
          beside,
          leaves: [],
          noAdd: [],
          alone,
          ...(byDir.get(d)?.keyUnknown === true ? { keyUnknown: true as const } : {}),
        },
      ];
    });
    return { extra, unresolved };
  };
  const without = plan(
    views.map((v) => ({ dir: v.dir, plugin: false })),
    regs,
    new Map(),
  );
  let withPlugin: ReturnType<typeof duplicateRegistrations>["withPlugin"] = null;
  if (plugin !== null) {
    let worst = { servers: 0, keys: 0, plugin: false };
    let beside = false;
    for (const v of views) {
      const keys = keysOf(v.entries).length;
      // Claude Code's B5r dedupes the plugin's server against the entries a session starts only
      const runs = v.plugin && !v.entries.some((e) => plugin.drops(e));
      if (runs && keys > 0) beside = true;
      const servers = keys + (runs ? 1 : 0);
      if (servers > worst.servers) worst = { servers, keys, plugin: runs };
    }
    const settled = plan(
      [...views.filter((v) => v.plugin), ...views.filter((v) => !v.plugin)].map((v) => ({
        dir: v.dir,
        plugin: v.plugin,
      })),
      regs,
      new Map([[pseudo, "plugin"]]),
    );
    // its removals in the order the views list them, then the order of the entries (one command
    // line per entry; an entry behind another one's under its key is removed with it: VR7-1)
    const listed = [...new Set([...views.flatMap((v) => v.entries), ...regs])];
    // uninstalling the plugin: the views it strips, and what gives each a server first (V3-1); then
    // the keep rule over the views as those steps leave them, what they add kept (VR4-3)
    const leftWithout = regs.filter((e) => !without.extra.includes(e));
    const stripped = views.filter((v) => v.plugin && startsOf(v.dir, leftWithout).length === 0);
    const projects = stripped.flatMap((v) => (v.dir === null ? [] : [v.dir]));
    // a key no entry uses and no session names: never off, never another program's anywhere
    const used = new Set([
      ...regs.map((e) => e.name),
      ...others.keys(),
      ...sessions.flatMap((v) => [...v.disabled, ...v.declined]),
    ]);
    let spare = PACKAGE_NAME;
    for (const k of spareKeys())
      if (!used.has(k)) {
        spare = k;
        break;
      }
    const added = (name: string, scope: "user" | "local", dir: string | null): ClientEntry => ({
      ...pseudo,
      name,
      scope,
      dir,
    });
    // outside the projects stripped: this server added at user scope — under its own key where
    // Claude Code would start that in every stripped project, else under the spare key (U2, V5-3)
    const own = added(SERVER_NAME, "user", null);
    const heldAtUser = (others.get(SERVER_NAME) ?? []).some((h) => h.scope === "user");
    const heldBelow = projects.filter((d) => {
      const w = winnerOf(d, SERVER_NAME, [own, ...regs]);
      return w !== undefined && otherEntries.has(w);
    });
    const addKey = !stripped.some((v) => v.dir === null)
      ? null
      : heldAtUser || heldBelow.length > 0
        ? spare
        : SERVER_NAME;
    const userAdd = addKey === null ? null : added(addKey, "user", null);
    // the one key a stripped project turns back on (more would only be removed again): the added
    // entry's, where the project turned it off; else the best ranked of the entries turned off
    // there that Claude Code would start there; else this server added at local scope there — and
    // none where doctor cannot tell which record those steps write there (VR2)
    const seen = new Map<ClientEntry, number>();
    for (const v of views) for (const e of v.entries) seen.set(e, (seen.get(e) ?? 0) + 1);
    const best = (es: readonly ClientEntry[]): string[] => {
      const ranked = [...es].sort(
        (x, y) =>
          (seen.get(y) ?? 0) - (seen.get(x) ?? 0) ||
          depth(x) - depth(y) ||
          Number(y.name === SERVER_NAME) - Number(x.name === SERVER_NAME),
      );
      return ranked.length === 0 ? [] : [ranked[0]?.name ?? SERVER_NAME];
    };
    const uninstallStrips = stripped.map((v): StrippedView => {
      if (v.dir === null) return { dir: null, off: [] };
      const d = v.dir;
      const unknownKey = byDir.get(d)?.keyUnknown === true;
      if (userAdd !== null) {
        if (!off(d, userAdd.name)) return { dir: d, off: [] };
        return unknownKey ? { dir: d, off: [], keyUnknown: true } : { dir: d, off: [userAdd.name] };
      }
      if (unknownKey) return { dir: d, off: [], keyUnknown: true };
      const on = best(
        regs.filter((e) => reads(d, e) && off(d, e.name) && winnerOf(d, e.name, regs) === e),
      );
      // added there only where the directory holds no control a printed command would show
      // otherwise than it runs (D-8)
      if (on.length > 0 || holdsControl(d)) return { dir: d, off: on };
      const free =
        !off(d, SERVER_NAME) &&
        ![...regs, ...(others.get(SERVER_NAME) ?? [])].some(
          (e) => e.name === SERVER_NAME && reads(d, e),
        );
      return { dir: d, off: [], addLocal: free ? SERVER_NAME : spare };
    });
    const turnedOn = new Map(
      uninstallStrips.flatMap((v) => (v.dir === null ? [] : [[v.dir, new Set(v.off)] as const])),
    );
    const adds = [
      ...(userAdd === null ? [] : [userAdd]),
      ...uninstallStrips.flatMap((v) =>
        v.addLocal === undefined ? [] : [added(v.addLocal, "local", v.dir)],
      ),
    ];
    const afterSteps = plan(
      [null, ...sessionDirs].map((dir) => ({ dir, plugin: false })),
      [...regs, ...adds],
      new Map(adds.map((e) => [e, "added" as const])),
      turnedOn,
    );
    const dropping = regs.flatMap((entry) => {
      if (!plugin.drops(entry)) return [];
      const on = views.filter((v) => v.plugin);
      if (!on.some((v) => v.entries.includes(entry))) return [];
      const notIn = on.flatMap((v) =>
        v.dir !== null &&
        !v.entries.includes(entry) &&
        reads(v.dir, entry) &&
        !off(v.dir, entry.name)
          ? [v.dir]
          : [],
      );
      return [{ entry, notIn }];
    });
    withPlugin = {
      worst,
      beside,
      extra: listed.filter((e) => settled.extra.includes(e)),
      unresolved: settled.unresolved,
      uninstallStrips,
      uninstallAdd:
        userAdd === null
          ? null
          : {
              key: userAdd.name,
              heldIn:
                userAdd.name === SERVER_NAME ? [] : [...(heldAtUser ? [null] : []), ...heldBelow],
            },
      uninstallExtra: regs.filter((e) => afterSteps.extra.includes(e)),
      uninstallUnresolved: afterSteps.unresolved,
      dropping,
    };
  }
  return {
    most,
    extra: without.extra,
    views: views.filter((v) => v.entries.length > 0 || v.dir === null).map((v) => v.entries),
    unresolved: without.unresolved,
    offIn,
    overriddenIn,
    withPlugin,
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
 * is a symbolic link, past that bound (Claude Code reads it all the same), records a source type
 * Claude Code 2.1.308 does not have (a newer client may: verifier V-A) or a record only 2.1.308's
 * field-level schema refuses (another version may read it: D-1) — `registry` — so what Claude Code
 * runs, and whether it loads the plugin at all, is not known (`pluginLoads`), and it is never the
 * cache copy. `unloaded` (verifier F1, Claude
 * Code 2.1.308's MDe: "not loaded (hooks module, commands, skills, servers: none of it)"): Claude
 * Code loads no plugin of this marketplace — `registry: "unreadable"`: known_marketplaces.json is
 * not JSON, not an object, unreadable, or records a marketplace no client version reads (not an
 * object, or no source object with a string type: `marketplaceRecordState`, V-A, D-1), and Claude
 * Code then loads no marketplace plugin at all, settings declarations included; `registry: "unrecorded"`: the file is missing or records no such
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
       * bound, a source type Claude Code 2.1.308 does not have: V-A, or a record only its field-level
       * schema refuses: D-1), not a folder marketplace's listing — so whether the marketplace is a
       * folder at all, and whether Claude Code loads the plugin, is not known.
       */
      readonly registry?: true;
    }
  | {
      readonly kind: "unloaded";
      readonly registry: "unreadable" | "unrecorded";
      readonly why: string;
    };

/**
 * Whether Claude Code starts the plugin's server from this origin: `no` — `unresolved` or
 * `unloaded`; `unknown` — `refused`: known_marketplaces.json doctor cannot judge (`registry`: Claude
 * Code 2.1.308 loads no marketplace plugin from a file it refuses, another version may — D-1, MK-1),
 * or a folder marketplace whose plugin source doctor does not follow (V3-2: 2.1.308 refuses an
 * absolute or bare-name source and loads nothing from it; a listing past doctor's bound or through
 * a symbolic link it may load) — so the plugin is never counted as a server beside an entry, nor
 * its removal advised unconditionally; `yes` — `folder` and `copied`.
 */
export function pluginLoads(o: PluginOrigin): "yes" | "no" | "unknown" {
  if (o.kind === "unresolved" || o.kind === "unloaded") return "no";
  return o.kind === "refused" ? "unknown" : "yes";
}

/** Whether Claude Code may start the plugin's server from this origin (`pluginLoads` is not `no`). */
export function pluginMayLoad(o: PluginOrigin): boolean {
  return pluginLoads(o) !== "no";
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
 * client then loads no marketplace plugin — verifier V-A), in the two tiers of ruling D-1 (the owner
 * updates Claude Code often, and a false FAIL is the class of bug he reported): `broken` — what no
 * client version reads: a record that is not an object, or has no `source` object with a string
 * `source` type; `refused` — what only 2.1.308's field-level schema refuses (`installLocation` or
 * `lastUpdated` not a string, `autoUpdate` not a boolean, the type's required field missing, a `url`
 * source's url no URL, a `settings` source with no `plugins` list or listing a plugin with no name or
 * no remote source object — MK-4): another client version may read it; `unknown` — a source type 2.1.308 does not
 * have (a newer one may: `type`, when it is a plain word, else null). `what` says why with field and
 * type names only, never a value. Known limit (D-4): each type's optional fields (github
 * ref/sparsePaths/skipLfs, url headers, npm name syntax, a settings plugin's own source fields) are
 * not checked — a file Claude Code wrote passes them.
 */
function marketplaceRecordState(
  m: unknown,
):
  | { readonly kind: "ok" }
  | { readonly kind: "broken" | "refused"; readonly what: string }
  | { readonly kind: "unknown"; readonly type: string | null } {
  const broken = (what: string) => ({ kind: "broken", what }) as const;
  const refused = (what: string) => ({ kind: "refused", what }) as const;
  if (!isObj(m)) return broken("that is not an object");
  const s = m.source;
  if (!isObj(s) || typeof s.source !== "string") return broken("with no usable source");
  if (typeof m.installLocation !== "string") return refused("with no installLocation");
  if (typeof m.lastUpdated !== "string") return refused("with no lastUpdated");
  if (Object.hasOwn(m, "autoUpdate") && typeof m.autoUpdate !== "boolean")
    return refused("whose autoUpdate is not true or false");
  const type = s.source;
  if (!Object.hasOwn(MARKETPLACE_SOURCE_FIELD, type))
    return { kind: "unknown", type: SOURCE_WORD_RE.test(type) ? type : null };
  const field = MARKETPLACE_SOURCE_FIELD[type] ?? null;
  if (field !== null && typeof s[field] !== "string")
    return refused(`whose ${type} source has no ${field}`);
  if (type === "url" && typeof s.url === "string" && !URL.canParse(s.url.trim()))
    return refused("whose url source's url is not a URL");
  if (type === "settings") {
    if (!Array.isArray(s.plugins)) return refused("whose settings source lists no plugins");
    // 2.1.308's settings plugin entry (`Co`): a name, and a remote source — an object with a type,
    // never a relative path string nor the parse-time `unsupported` placeholder (its refinements)
    const listed = (p: unknown): boolean =>
      isObj(p) &&
      typeof p.name === "string" &&
      p.name.length > 0 &&
      isObj(p.source) &&
      typeof p.source.source === "string" &&
      p.source.source !== "unsupported";
    if (!s.plugins.slice(0, MAX_LISTED_PLUGINS).every(listed))
      return refused("whose settings source lists a plugin with no name or no remote source");
  }
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
    // one record no client reads makes the whole file unreadable (V-A); one only 2.1.308's
    // field-level schema refuses, or a source type it does not have, may be one another client
    // version reads: doctor cannot tell then (D-1) — the first tier wins over the second
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
    const strange = states.find((r) => r.state.kind === "refused" || r.state.kind === "unknown");
    if (strange?.state.kind === "refused")
      return refused(
        `${known} records ${who(strange.name)} ${strange.state.what}: Claude Code 2.1.308 refuses such a file and then loads no marketplace plugin, and another client version may read it`,
        true,
      );
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
