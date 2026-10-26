// doctor.ts — `eff doctor [--json] [--online] [--fix [--yes]] [--ack <check>] [--client-config <p>]
// [--client-log <p>]` (plan 03 L5, §5 rows #1–#25; plan 10 A17b: every row has a passing and a
// failing case; offline mode makes zero network calls and zero keychain-SECRET reads except #7).
// Doctor never creates or migrates the store and never modifies the stored secret or its metadata;
// `--online` records its probe observation in store.sqlite exactly as `espn_check_auth` does (#16).
// `--fix` only creates missing 0700 directories and sets our own files/directories back to
// 0600/0700, after `--yes` or a y/N answer on a terminal; `--ack <check>` is the human
// acknowledgement of an open health check (src/domain/league/types.ts CheckAcknowledger "doctor").
// Ported from sibling @5daa625, adapted (the ESPN rows: credential store, drift, gates, online).
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsc,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  statfsSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CredentialStoreError } from "../auth/errors.js";
import { fileStoreExistsSync } from "../auth/file.js";
import { validateCookies } from "../auth/format.js";
import { evaluateRegistrationGates } from "../auth/gates.js";
import type { StoredCredential } from "../auth/types.js";
import {
  backupDir,
  ensureSecureDir,
  fileProviderMarks,
  foreignAclEntries,
  insecureAncestors,
  PathSecurityError,
  readSecureFile,
  storePath,
  stripForeignAcl,
  systemAcl,
  type AclAccess,
} from "../config/paths.js";
import {
  ConfigError,
  loadConfigFromProcess,
  tlsVerificationDisabled,
  type LenientConfig,
} from "../config/schema.js";
import type { CheckId } from "../domain/league/types.js";
import { TUNED_PARAMETERS_FILE_NAME } from "../domain/reclog/tune.js";
import { parseDiffs } from "../drift/index.js";
import { MIGRATIONS } from "../store/index.js";
import type { CredentialStateRow, Store, StoreFactory } from "../store/types.js";
import { VERSION } from "../version.js";
import {
  cookieFindings,
  scanClientConfig,
  scanPlugin,
  whereOf,
  type ClientConfigScan,
  type PluginInstall,
} from "./client-config.js";
import { onlineRows } from "./doctor-online.js";
import { exitCodeFor, row, type DoctorRow, type RowStatus } from "./doctor-rows.js";
import { bothCredentialStores } from "./espn-stack.js";
import { writeLine, distEntry, type CliIo } from "./io.js";
import {
  jobRunRecords,
  jobStatePath,
  notificationLogPath,
  readJobState,
  stateToken,
} from "./job-state.js";
import { installedPlists, JOB_NAMES, LAUNCHCTL, labelOf, launchctl } from "./launchd.js";
import { availableJobs } from "./install-launchd.js";
import { redactString, SecretRegistry, truncate, type Logger } from "./log.js";
import {
  codeConfigPath,
  desktopConfigPath,
  RUNTIME_LOCATION_FIX,
  SERVER_NAME,
  SIBLING_SERVER_NAME,
} from "./print-config.js";
import { createTerminalPrompt } from "./prompt.js";
import { bootLevel, makeLogger, registerConfigRedaction } from "./runtime.js";
import { candidatePorts, portOwner } from "./setup-page.js";
import { sourceStatuses, configuredSources, sourceStatus } from "./status.js";
import {
  errorText,
  openExistingStore,
  restoreSteps,
  type ExistingStore,
  type StoreOpenReason,
} from "./store-access.js";
import { CACHE_DIRS } from "./uninstall.js";
import { createServer } from "node:net";

export { exitCodeFor, type DoctorRow, type RowStatus } from "./doctor-rows.js";
export {
  MAX_CLIENT_CONFIG_BYTES,
  MAX_CLIENT_PROJECTS,
  isOurs,
  scanClientConfig,
  serverMaps,
  type ClientConfigScan,
} from "./client-config.js";

/** The minimum Node (plan 03 §5 #1). */
export const MIN_NODE = [24, 15, 0] as const;
/** Free space below this warns (plan 03 §5 #5). */
export const MIN_FREE_BYTES = 1024 ** 3;
/** Store size above this warns (plan 03 §5 #5). */
export const MAX_STORE_BYTES = 500 * 1024 ** 2;
/** How much of a client log's tail is read; lines shown (plan 03 §5 #25: the last 40). */
export const LOG_TAIL_BYTES = 64 * 1024;
export const LOG_TAIL_LINES = 40;
/** A probe older than this is stale (plan 03 §5 #9). */
export const PROBE_MAX_AGE_MS = 36 * 3_600_000;
/** A keychain read slower than this probably waited for a prompt (plan 03 §5 #7 [A-3]). */
export const PROMPT_SUSPECT_MS = 2_000;

/** The `--json` document. */
export interface DoctorReport {
  readonly version: string;
  readonly node: string;
  readonly generated_at: string;
  readonly online: boolean;
  readonly exit_code: number;
  readonly rows: readonly DoctorRow[];
}

/** Doctor options (from argv). */
export interface DoctorOptions {
  readonly json: boolean;
  readonly online: boolean;
  readonly fix: boolean;
  readonly yes: boolean;
  readonly ack?: string | undefined;
  readonly clientConfig?: string | undefined;
  readonly clientLog?: string | undefined;
  /** Test hook for the store factory (never reachable from argv). */
  readonly factory?: StoreFactory;
}

const MIN_TEXT = MIN_NODE.join(".");

/** Parses `v24.15.0` / `24.15.0`; null when unparseable. */
export function parseNodeVersion(s: string): [number, number, number] | null {
  const m = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})/.exec(s.trim());
  return m?.[1] === undefined || m[2] === undefined || m[3] === undefined
    ? null
    : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Whether `v` ≥ MIN_NODE. */
export function nodeAtLeastMin(v: readonly [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    const a = v[i] ?? 0;
    const b = MIN_NODE[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

// --- #1 ----------------------------------------------------------------------------------------------

/** Row 1: the running Node and its path. */
export function checkNode(nodeVersion: string, execPath: string): DoctorRow {
  const v = parseNodeVersion(nodeVersion);
  if (v !== null && nodeAtLeastMin(v))
    return row(1, "node", "Node version", "ok", `${nodeVersion} (≥ ${MIN_TEXT}) at ${execPath}`);
  return row(
    1,
    "node",
    "Node version",
    "fail",
    `${nodeVersion} at ${execPath} is below ${MIN_TEXT}`,
    "fnm install 24 && fnm default 24, then `eff print-config` and `eff install-launchd`",
  );
}

// --- #2, #3, #13: client configs ---------------------------------------------------------------------

async function nodeVersionOf(io: CliIo, command: string): Promise<string | null> {
  if (command === io.execPath) return io.nodeVersion;
  const r = await io.exec(command, ["--version"], { timeoutMs: 5_000 });
  return r.code === 0 ? r.stdout.trim().slice(0, 32) : null;
}

/** Whether a file looks like a dataless placeholder (an evicted iCloud file: size > 0, no blocks). */
export function isDataless(file: string): boolean {
  try {
    const st = statSync(file);
    return st.isFile() && st.size > 0 && st.blocks === 0;
  } catch {
    return false;
  }
}

/** Problems of one entry (value-free): hard problems and warnings separately. */
export async function entryProblems(
  io: CliIo,
  spec: Record<string, unknown>,
): Promise<{ hard: string[]; soft: string[] }> {
  const hard: string[] = [];
  const soft: string[] = [];
  const command = spec.command;
  const args = Array.isArray(spec.args) ? (spec.args as unknown[]) : [];
  if (command === "/bin/sh") {
    // the plugin path: `/bin/sh <root>/scripts/eff-launch.sh serve` (variables, no user paths)
    if (!args.includes("serve")) hard.push("`args` does not contain `serve`");
    return { hard, soft };
  }
  if (typeof command !== "string" || !path.isAbsolute(command)) {
    hard.push("`command` is not an absolute path (GUI clients have no shell PATH)");
  } else {
    try {
      accessSync(command, fsc.X_OK);
      const v = await nodeVersionOf(io, command);
      const parsed = v === null ? null : parseNodeVersion(v);
      if (parsed === null) hard.push("`command` did not report a Node version");
      else if (!nodeAtLeastMin(parsed))
        hard.push(`\`command\` is Node ${v ?? "?"}, below ${MIN_TEXT}`);
      if (command !== io.execPath)
        soft.push(
          `config uses ${v ?? "another node"}; you are running v${io.nodeVersion} — re-run \`eff print-config\` and \`eff install-launchd\``,
        );
    } catch {
      hard.push("`command` does not exist or is not executable");
    }
  }
  const entry = args[0];
  if (typeof entry !== "string" || !path.isAbsolute(entry)) {
    hard.push("`args[0]` is not an absolute path to dist/cli.js");
  } else {
    let exists = true;
    try {
      lstatSync(entry);
    } catch {
      exists = false;
      hard.push("`args[0]` does not exist (run `npm run build`?)");
    }
    if (exists) {
      const dir = path.dirname(entry);
      try {
        const marks = fileProviderMarks(dir, io.home, io.xattr, "runtime install");
        if (marks.length > 0)
          hard.push(`${dir} is managed by a file provider (iCloud): ${RUNTIME_LOCATION_FIX}`);
      } catch {
        hard.push(`${dir}: the file-provider check could not run`);
      }
      const root = path.dirname(dir);
      if (isDataless(entry)) hard.push(`${entry} is a dataless (evicted) placeholder`);
      const probe = path.join(root, "node_modules", "zod", "package.json");
      if (isDataless(probe))
        hard.push(`${path.join(root, "node_modules")} holds dataless (evicted) placeholders`);
    }
  }
  if (!args.includes("serve")) hard.push("`args` does not contain `serve`");
  return { hard, soft };
}

/**
 * The node the plugin shim would pick (plan 03 §5 #2; ADV OBJ-12), via `version --json` — the shim
 * of `root` (this install by default; an installed plugin's copy, which is what Claude Code runs).
 */
export async function shimResolution(io: CliIo, root: string = io.packageRoot): Promise<string> {
  const shim = path.join(root, "scripts", "eff-launch.sh");
  const label = root === io.packageRoot ? "plugin shim" : `plugin copy's shim (${root})`;
  try {
    lstatSync(shim);
  } catch {
    return `${label}: not present in this install`;
  }
  const r = await io.exec("/bin/sh", [shim, "version", "--json"], { timeoutMs: 10_000 });
  if (r.code !== 0) {
    // the shim's own fixed text (eff-launch: …), first line only, control characters dropped
    const first = r.stderr.split("\n").find((l) => l.startsWith("eff-launch: ")) ?? "";
    const why = truncate(first.replace(/[\u0000-\u001f\u007f]/g, " ").trim(), 200);
    return `${label} failed${why === "" ? "" : `: ${why}`}`;
  }
  try {
    const v = JSON.parse(r.stdout.trim().split("\n").pop() ?? "") as {
      node?: unknown;
      exec_path?: unknown;
    };
    if (
      typeof v.node === "string" &&
      typeof v.exec_path === "string" &&
      /^\d+\.\d+\.\d+/.test(v.node)
    )
      return `${label} would run node ${v.node} at ${v.exec_path.replace(/[\u0000-\u001f]/g, "")}`;
  } catch {
    // fall through
  }
  return `${label}: ran, but its output was not understood`;
}

/**
 * Problems of an installed plugin copy (what Claude Code runs: `<installPath>/scripts/eff-launch.sh
 * serve` → `<installPath>/dist/cli.js`): its build and its shim must be there. A copy added from
 * GitHub carries no `dist/` (README step 5: the plugin comes from the built clone).
 */
export function pluginCopyProblems(installPath: string): string[] {
  const out: string[] = [];
  const has = (rel: string): boolean => {
    try {
      return lstatSync(path.join(installPath, rel)).isFile();
    } catch {
      return false;
    }
  };
  if (!has(path.join("dist", "cli.js")))
    out.push(
      `the plugin copy at ${installPath} has no dist/cli.js — install the plugin from the built clone (README step 5), not from GitHub`,
    );
  if (!has(path.join("scripts", "eff-launch.sh")))
    out.push(`the plugin copy at ${installPath} has no scripts/eff-launch.sh`);
  return out;
}

/**
 * Row 2: launch configuration paths in every client config found — and the Claude Code plugin, the
 * README's recommended registration (Stage C finding doctor-plugin-install-invisible: a plugin user
 * was told no client launches the server and pointed at `--client code`, the duplicate registration
 * the README forbids). An enabled plugin beside a `claude mcp add` entry of ours is a warning: two
 * servers, every tool listed twice.
 */
export async function checkLaunchConfig(
  io: CliIo,
  scans: readonly ClientConfigScan[],
  plugin: PluginInstall | null = null,
): Promise<DoctorRow> {
  const title = "Launch config paths";
  const details: string[] = [];
  let hard = false;
  let soft = false;
  let found = 0;
  let codeEntries = 0;
  for (const s of scans) {
    if (s.state === "missing") {
      details.push(`${s.client}: no config at ${s.file}`);
      continue;
    }
    if (s.state === "invalid") {
      details.push(`${s.client}: ${s.file} could not be read as JSON`);
      continue;
    }
    for (const pf of s.projectFiles)
      if (pf.state === "invalid") details.push(`${s.client}: ${pf.file} could not be read as JSON`);
    if (s.siblingInstalled)
      details.push(
        `${s.client}: the sibling's \`${SIBLING_SERVER_NAME}\` server is also installed (fine)`,
      );
    if (s.entries.length === 0) {
      details.push(`${s.client}: ${s.file} has no \`${SERVER_NAME}\` entry`);
      continue;
    }
    for (const e of s.entries) {
      found++;
      if (s.client === "code") codeEntries++;
      const where = whereOf(e.scope, e.dir);
      if (e.name !== SERVER_NAME)
        details.push(
          `${where}: an entry launches this server under another key (expected \`${SERVER_NAME}\`)`,
        );
      const p = await entryProblems(io, e.spec);
      if (p.hard.length === 0 && p.soft.length === 0) details.push(`${where}: entry ok`);
      for (const x of p.hard) details.push(`${where}: ${x}`);
      for (const x of p.soft) details.push(`${where}: warning: ${x}`);
      if (p.hard.length > 0) hard = true;
      if (p.soft.length > 0) soft = true;
    }
  }
  const pluginOn = plugin?.enabled === true;
  if (plugin !== null) {
    for (const c of plugin.copies) {
      if (!plugin.enabled) {
        details.push(`code: the plugin is installed (${c.installPath}) but disabled`);
        continue;
      }
      found++;
      const problems = pluginCopyProblems(c.installPath);
      if (problems.length === 0)
        details.push(
          `code: the plugin registers the server (${c.scope} scope${c.version === null ? "" : `, version ${c.version}`}, ${c.installPath})`,
        );
      for (const x of problems) details.push(`code: ${x}`);
      if (problems.length > 0) hard = true;
      details.push(await shimResolution(io, c.installPath));
    }
  }
  if (!pluginOn) details.push(await shimResolution(io));
  if (hard)
    return row(
      2,
      "launch_config",
      title,
      "fail",
      "a client launches the server with a bad path, Node or location",
      pluginOn
        ? "install the plugin again from the built clone (README step 5); replace any other entry with `eff print-config`'s output"
        : "replace the entry with the output of `eff print-config --client desktop` (or --client code)",
      details,
    );
  if (found === 0)
    return row(
      2,
      "launch_config",
      title,
      "warn",
      "no client is configured to launch this server",
      "Claude Code: the plugin (README step 5); Claude Desktop: `eff print-config --client desktop`",
      details,
    );
  if (pluginOn && codeEntries > 0)
    return row(
      2,
      "launch_config",
      title,
      "warn",
      "Claude Code registers this server twice: the plugin AND a `claude mcp add` entry — two servers, every tool listed twice",
      "keep one: remove the entry (`eff uninstall --dry-run` prints its `claude mcp remove` command) or uninstall the plugin",
      details,
    );
  if (soft)
    return row(
      2,
      "launch_config",
      title,
      "warn",
      "the client config names another Node binary than this one",
      "re-run `eff print-config` and `eff install-launchd`",
      details,
    );
  return row(
    2,
    "launch_config",
    title,
    "ok",
    `${String(found)} client registration${found === 1 ? "" : "s"} with absolute, existing paths`,
    null,
    details,
  );
}

/**
 * Row 3: no cookie-shaped env value and no ESPN_S2/SWID-named key in any client config — every
 * scope Claude Code keeps (user, local, and the project `.mcp.json` files: Stage C finding
 * doctor-project-scope-mcp-json-unscanned) and Claude Desktop's. Never a value: where it is and what.
 */
export function checkClientSecrecy(scans: readonly ClientConfigScan[]): DoctorRow {
  const title = "Client config secrecy";
  const details: string[] = [];
  let any = false;
  for (const s of scans) {
    for (const b of s.envBlocks) {
      any = true;
      const where = b.scope === "desktop" ? s.client : whereOf(b.scope, b.dir);
      for (const f of cookieFindings(b.env))
        details.push(
          f === "key"
            ? `${where}: an env key named like an ESPN cookie`
            : `${where}: an env value shaped like an ESPN cookie or a member GUID`,
        );
    }
  }
  if (!any) return row(3, "client_secrecy", title, "skip", "no client env block to check");
  if (details.length === 0)
    return row(3, "client_secrecy", title, "ok", "no cookie-shaped value in any client config");
  return row(
    3,
    "client_secrecy",
    title,
    "config",
    "a client config holds a cookie-shaped value — the client config is not a secret store",
    "remove it from the env block (cookies live only in the credential store; `eff setup` puts them there), then restart the client; a project .mcp.json is a file meant to be committed: check its history",
    [...new Set(details)],
  );
}

/** Row 13: the four registration gates (plan 02 §3.2) and the reach-session warning. */
export function checkWriteFlag(
  config: LenientConfig | null,
  credentialRow: CredentialStateRow | null,
  env: CliIo["env"],
  scans: readonly ClientConfigScan[],
): DoctorRow {
  const title = "Write flag";
  if (config === null) return row(13, "write_flag", title, "skip", "configuration invalid");
  const g = evaluateRegistrationGates({
    writesRequested: config.writesRequested,
    acknowledgement: config.writesAcknowledgement,
    currentAcknowledgementSha256: null,
    teamId: config.teamId,
    teamIdOrigin: config.origins.ESPN_TEAM_ID,
    credentialRow,
    leagueId: config.leagueId ?? "",
  });
  const details = Object.entries(g.gates).map(([k, v]) => `gate ${k}: ${v ? "holds" : "fails"}`);
  const base = "writes: off — the write module is not built (PHASE W; plan 10 §3.W)";
  if (!config.writesRequested) return row(13, "write_flag", title, "ok", base, null, details);
  const signals: string[] = [];
  if ((env.CLAUDECODE ?? "") !== "") signals.push("running under Claude Code (CLAUDECODE is set)");
  for (const s of scans)
    if (s.entries.length > 0 && s.others > 0)
      signals.push(
        `${s.client} config lists ${String(s.others)} other MCP server(s) — another server may give the model shell or file reach`,
      );
  return row(
    13,
    "write_flag",
    title,
    "warn",
    `EFF_ENABLE_WRITES=true is inert: ${base}`,
    "unset EFF_ENABLE_WRITES",
    [...details, ...signals],
  );
}

// --- #4, #5: directories and the store ----------------------------------------------------------------

function refusal(e: unknown): string {
  return e instanceof PathSecurityError ? e.detail : errorText(e);
}

/**
 * What fixes a refused directory or file of ours, by why it was refused: `--fix` tightens a mode bit
 * and removes an ACL entry giving others access on our OWN paths (it creates what is missing); it
 * never follows a symlink and never changes what is not ours. Rows 4 and 5 used to say "--fix
 * tightens our own directory's mode" for every refusal, an ACL's included, which --fix then did not
 * repair (Stage C finding doctor-fix-dirs-inherit-acl).
 */
export function refusalFix(e: unknown): string {
  if (!(e instanceof PathSecurityError))
    return "`eff doctor --fix` never follows a symlink or changes what is not yours: fix it by hand";
  switch (e.reason) {
    case "insecure_mode":
      return "`eff doctor --fix` tightens our own directory's or file's mode";
    case "insecure_acl":
      return "`eff doctor --fix` removes the ACL entries that give others access to our own directory or file";
    case "missing":
      return "`eff setup` (or `eff doctor --fix`) creates it 0700";
    case "symlink":
      return "`eff doctor --fix` never follows a symlink: replace the link with a real directory by hand";
    case "wrong_owner":
      return "it belongs to another user, and `eff doctor --fix` never changes what is not yours: fix its owner by hand";
    case "insecure_ancestor":
      return "a directory above it is writable by others: fix that directory's permissions by hand (`eff doctor --fix` changes only our own paths)";
    case "acl_unverifiable":
      return "its access control list could not be read: check it with `ls -led` and fix it by hand";
    default:
      return "`eff doctor --fix` never follows a symlink or changes what is not yours: fix it by hand";
  }
}

/**
 * The cache's own directories that are there but refused (group/other bits, a symlink, not ours):
 * every store open checks `datasets/`, `eff backup` `backups/`, `eff refresh` `tmp/` — each
 * refusal says "run `eff doctor --fix`", so doctor names it and --fix repairs it (Stage C finding
 * doctor-fix-skips-cache-subdirs). A missing one is fine: what needs it creates it 0700.
 */
export function cacheSubdirRefusals(cacheDir: string): { path: string; error: unknown }[] {
  const out: { path: string; error: unknown }[] = [];
  for (const d of CACHE_DIRS) {
    const sub = path.join(cacheDir, d.name);
    try {
      ensureSecureDir(sub, { create: false, what: `${d.name}/ directory` });
    } catch (e) {
      if (!(e instanceof PathSecurityError && e.reason === "missing"))
        out.push({ path: sub, error: e });
    }
  }
  return out;
}

/** At most this many entries of one run directory's tree are looked at (a bound on a user's tree). */
export const MAX_RUN_TREE_ENTRIES = 2_000;

/**
 * The run directories inside the cache's own tree directories (`tmp/<run>`, `recordings/<run>` —
 * raw captures with real names and ids, a full store copy of an interrupted `backup --to`) that are
 * there but not private (group/other bits, an ACL entry for others): `eff uninstall` and `eff prune`
 * keep such a directory as "not a run directory this program made", so it would outlive both (Stage
 * C finding doctor-fix-run-dirs-unrepaired). A run directory that is a symlink or someone else's is
 * not ours and not listed.
 */
export function cacheRunDirRefusals(
  cacheDir: string,
  acl: AclAccess = systemAcl,
): { path: string; error: unknown }[] {
  const out: { path: string; error: unknown }[] = [];
  for (const d of CACHE_DIRS) {
    if (d.tree !== true) continue;
    const top = path.join(cacheDir, d.name);
    for (const p of ownDirsIn(top, d.re)) {
      try {
        ensureSecureDir(p, { create: false, what: `${d.name}/ run directory`, acl });
      } catch (e) {
        if (!(e instanceof PathSecurityError && e.reason === "insecure_ancestor"))
          out.push({ path: p, error: e });
      }
    }
  }
  return out;
}

/** The directories of ours (real, owned) inside `dir` whose names match `re`. */
function ownDirsIn(dir: string, re: RegExp): string[] {
  try {
    if (!lstatSync(dir).isDirectory()) return [];
    const uid = ownUid();
    return readdirSync(dir)
      .filter((n) => re.test(n))
      .sort()
      .map((n) => path.join(dir, n))
      .filter((p) => {
        try {
          const st = lstatSync(p);
          return st.isDirectory() && (uid === null || st.uid === uid);
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/** Row 5's detail and fix for a store that could not be opened (never "move a healthy store aside"). */
function openFailure(
  config: LenientConfig,
  reason: StoreOpenReason,
  subdirs: readonly { path: string; error: unknown }[],
  refusedPath: string | undefined,
): { detail: string; fix: string; steps: string[] } {
  const cannot = `store.sqlite could not be opened (${reason})`;
  switch (reason) {
    case "insecure_path": {
      const first = subdirs[0];
      return {
        detail:
          first !== undefined
            ? `${cannot}: a directory of ours is refused (below) — a path rule, not damage to the store`
            : `${cannot}: ${refusedPath ?? "a path of ours"} is refused — a path rule, not damage to the store`,
        fix:
          first !== undefined
            ? refusalFix(first.error)
            : "`eff doctor --fix` tightens our own directories' and files' modes",
        steps: [],
      };
    }
    case "busy":
      return {
        detail: `${cannot}: another process holds it`,
        fix: "retry once the running job or server is done (`eff status` lists the jobs)",
        steps: [],
      };
    case "readonly":
      return {
        detail: `${cannot}: it is not writable by you`,
        fix: "`eff doctor --fix` restores 0600 on our own file; a file owned by someone else needs fixing by hand",
        steps: [],
      };
    case "unsupported_node":
      return { detail: cannot, fix: "upgrade Node (row 1)", steps: [] };
    case "cannot_open":
      return { detail: cannot, fix: "check the cache dir's path and mode (rows 4–5)", steps: [] };
    case "not_a_database":
    case "corrupt":
    case "other":
      return {
        detail: cannot,
        fix: "restore a backup — the steps below (with no backup: do steps 1–2, then `eff refresh all` starts a new, empty store)",
        steps: restoreSteps(config.cacheDir, { kind: "newest" }),
      };
  }
}

function marksOf(io: CliIo, dir: string): string[] {
  try {
    return fileProviderMarks(dir, io.home, io.xattr, "directory").map(
      (m) => `${m.path}: ${m.attr}`,
    );
  } catch {
    return [`${dir}: the file-provider check could not run`];
  }
}

/** Row 4: config dir 0700, ours, no file-provider xattr; warns on a dir override. */
export function checkConfigDir(io: CliIo, config: LenientConfig): DoctorRow {
  const title = "Config dir";
  const details: string[] = [];
  if (config.origins.EFF_CONFIG_DIR === "env" || config.origins.EFF_CACHE_DIR === "env")
    details.push(
      "EFF_CONFIG_DIR/EFF_CACHE_DIR is set: a plugin-launched server uses the default directories — launch from a client config instead (plan 01 D16)",
    );
  try {
    ensureSecureDir(config.configDir, { create: false, what: "config dir" });
  } catch (e) {
    const missing = e instanceof PathSecurityError && e.reason === "missing";
    return row(
      4,
      "config_dir",
      title,
      missing ? "warn" : "fail",
      `${config.configDir}: ${refusal(e)}`,
      refusalFix(e),
      details,
    );
  }
  const marks = marksOf(io, config.configDir);
  if (marks.length > 0)
    return row(
      4,
      "config_dir",
      title,
      "fail",
      `${config.configDir} is managed by a file provider (iCloud)`,
      "use ~/.config (or another non-synced directory) — secrets must never live in a synced folder",
      marks,
    );
  return row(
    4,
    "config_dir",
    title,
    details.length > 0 ? "warn" : "ok",
    `${config.configDir} is 0700 and ours`,
    null,
    details,
  );
}

function existingAncestor(p: string): string {
  let cur = path.resolve(p);
  for (;;) {
    try {
      statSync(cur);
      return cur;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return cur;
      cur = parent;
    }
  }
}

function freeBytes(p: string): number | null {
  try {
    const s = statfsSync(existingAncestor(p));
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/** `PRAGMA quick_check` on its own read-only connection. */
export function quickCheckFile(file: string): "ok" | "corrupt" | "unreadable" {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare("PRAGMA quick_check").all() as { quick_check?: unknown }[];
    return rows.length === 1 && rows[0]?.quick_check === "ok" ? "ok" : "corrupt";
  } catch {
    return "unreadable";
  } finally {
    db?.close();
  }
}

/** Why a store file of ours is not writable, with the fix for that cause, or null when it is. */
export function storeUnwritable(
  file: string,
): { readonly file: string; readonly code: string; readonly fix: string } | null {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    let st;
    try {
      st = lstatSync(f);
    } catch {
      continue; // no -wal / -shm right after a checkpoint
    }
    try {
      accessSync(f, fsc.W_OK);
      continue;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "EACCES";
      const fix =
        code === "EROFS"
          ? "the volume holding the cache is mounted read-only: move the cache to a writable volume (EFF_CACHE_DIR)"
          : code === "EPERM"
            ? `the file is locked (an immutable flag): \`chflags nouchg ${f}\`, then \`eff doctor\``
            : (st.mode & 0o200) === 0
              ? `\`eff doctor --fix\` restores 0600 on our own file (or \`chmod 600 ${f}\`)`
              : `an access control list entry denies you write access: \`chmod -N ${f}\` removes it`;
      return { file: f, code, fix };
    }
  }
  return null;
}

/** The store's page counts on its own read-only connection (live bytes vs free pages), or null. */
export function storePages(
  file: string,
): { readonly liveBytes: number; readonly freeBytes: number } | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const n = (pragma: string): number => {
      const r = db?.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
      const v = r === undefined ? undefined : Object.values(r)[0];
      return typeof v === "number" ? v : Number(v ?? NaN);
    };
    const size = n("page_size");
    const count = n("page_count");
    const free = n("freelist_count");
    if (![size, count, free].every((x) => Number.isFinite(x) && x >= 0)) return null;
    return { liveBytes: (count - free) * size, freeBytes: free * size };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** The backups a restore can take, newest first (names and dates only), for row 5's details. */
export function backupsPresent(cacheDir: string, max = 6): string[] {
  const dir = backupDir(cacheDir);
  const re = CACHE_DIRS.find((d) => d.name === path.basename(dir))?.re;
  if (re === undefined) return [];
  let found: { name: string; at: number }[] = [];
  try {
    found = readdirSync(dir)
      .filter((n) => re.test(n))
      .flatMap((n) => {
        try {
          const st = lstatSync(path.join(dir, n));
          return st.isFile() ? [{ name: n, at: st.mtimeMs }] : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.at - a.at);
  } catch {
    // no backups directory (or none readable): there is no backup to take
    found = [];
  }
  if (found.length === 0) return [`no backup in ${dir}`];
  return found
    .slice(0, max)
    .map((f) => `backup: ${path.join(dir, f.name)} (${new Date(f.at).toISOString()})`);
}

/** Row 5: cache dir, free space, store integrity + schema + size, no file-provider xattr. */
export function checkStore(io: CliIo, config: LenientConfig, ex: ExistingStore): DoctorRow {
  const title = "Cache dir + store";
  const details: string[] = [];
  const acc: { status: RowStatus } = { status: "ok" };
  const worse = (s: RowStatus): void => {
    if (s === "fail" || (s === "warn" && acc.status === "ok")) acc.status = s;
  };
  try {
    ensureSecureDir(config.cacheDir, { create: false, what: "cache dir" });
  } catch (e) {
    if (e instanceof PathSecurityError && e.reason === "missing")
      return row(
        5,
        "store",
        title,
        "warn",
        `${config.cacheDir} does not exist yet`,
        "`eff refresh all` (or `eff doctor --fix`) creates it 0700",
      );
    return row(5, "store", title, "fail", `${config.cacheDir}: ${refusal(e)}`, refusalFix(e));
  }
  try {
    accessSync(config.cacheDir, fsc.W_OK | fsc.X_OK);
  } catch {
    return row(
      5,
      "store",
      title,
      "fail",
      `${config.cacheDir} is not writable by you`,
      "`eff doctor --fix` restores 0700 on our own directory",
    );
  }
  const marks = marksOf(io, config.cacheDir);
  if (marks.length > 0)
    return row(
      5,
      "store",
      title,
      "fail",
      `${config.cacheDir} is managed by a file provider (iCloud)`,
      "use ~/.cache (or another non-synced directory)",
      marks,
    );
  const free = freeBytes(config.cacheDir);
  if (free !== null && free < MIN_FREE_BYTES) {
    worse("warn");
    details.push(`free space ${String(Math.round(free / 1024 ** 2))} MB < 1 GB`);
  }
  // the cache's own directories: a refused one fails every store open, `eff backup` or `eff refresh`;
  // a run directory inside tmp/ or recordings/ that is not private outlives uninstall and prune
  const subdirs = [
    ...cacheSubdirRefusals(config.cacheDir),
    ...cacheRunDirRefusals(config.cacheDir),
  ];
  for (const r of subdirs) details.push(`${r.path}: ${refusal(r.error)}`);
  const subdirRow = (): DoctorRow | null => {
    const first = subdirs[0];
    return first === undefined
      ? null
      : row(
          5,
          "store",
          title,
          "fail",
          `${String(subdirs.length)} directory(ies) of ours refused: ${first.path}${subdirs.length > 1 ? " …" : ""}`,
          refusalFix(first.error),
          details,
        );
  };
  const bin = MIGRATIONS.length;
  switch (ex.kind) {
    case "missing":
      return (
        subdirRow() ??
        row(5, "store", title, "warn", "store.sqlite not created yet", "`eff refresh all`", details)
      );
    case "newer":
      return row(
        5,
        "store",
        title,
        "fail",
        `store.sqlite was written by a newer version (v${String(ex.storeVersion)}); this binary supports v${String(bin)}`,
        "upgrade the package — or restore the backup taken before the upgrade: the steps below",
        [
          ...details,
          ...restoreSteps(config.cacheDir, { kind: "pre_migration", binaryVersion: bin }),
          ...backupsPresent(config.cacheDir),
        ],
      );
    case "pending":
      return (
        subdirRow() ??
        row(
          5,
          "store",
          title,
          "warn",
          `schema v${String(ex.storeVersion)}; the next job or server start migrates it to v${String(bin)} (a VACUUM INTO backup is taken first)`,
          null,
          details,
        )
      );
    case "error": {
      const f = openFailure(config, ex.reason, subdirs, ex.path);
      return row(5, "store", title, "fail", f.detail, f.fix, [
        ...details,
        ...f.steps,
        ...(f.steps.length > 0 ? backupsPresent(config.cacheDir) : []),
      ]);
    }
    case "open":
      break;
  }
  const file = storePath(config.cacheDir);
  const stats = ex.store.stats();
  details.push(
    `schema v${String(stats.schema_version)} (binary v${String(bin)}), ${String(Math.round(stats.size_bytes / 1024))} KB`,
  );
  // a store that opens but fails quick_check is the usual way damage shows: the same restore
  // procedure as a store that does not open at all, with the backups to take (Stage C finding
  // doctor-quick-check-corrupt-no-restore-steps: it said only "store problems → see details")
  const qc = quickCheckFile(file);
  if (qc !== "ok")
    return row(
      5,
      "store",
      title,
      "fail",
      `store.sqlite fails quick_check (${qc}): the file is damaged`,
      "restore a backup — the steps below (with no backup: do steps 1–2, then `eff refresh all` starts a new, empty store)",
      [
        ...details,
        `store quick_check: ${qc}`,
        ...restoreSteps(config.cacheDir, { kind: "newest" }),
        ...backupsPresent(config.cacheDir),
      ],
    );
  // writable: every request writes its limiter row first, so a store SQLite opens read-only (mode
  // 0400, an immutable flag, an ACL denying write, a read-only volume) fails every ESPN-backed tool
  // and every job (Stage C finding doctor-store-readonly-reported-ok)
  const unwritable = storeUnwritable(file);
  if (unwritable !== null)
    return row(
      5,
      "store",
      title,
      "fail",
      `${unwritable.file} is not writable by you (${unwritable.code}): every ESPN request and every job fails`,
      unwritable.fix,
      details,
    );
  const pages = storePages(file);
  const live = pages === null ? stats.size_bytes : pages.liveBytes;
  if (pages !== null && pages.freeBytes >= 1024 ** 2)
    details.push(
      `${String(Math.round(pages.freeBytes / 1024 ** 2))} MB of the file are free pages (\`eff prune\` reclaims them)`,
    );
  if (live > MAX_STORE_BYTES) {
    worse("warn");
    details.push(
      `store holds ${String(Math.round(live / 1024 ** 2))} MB of data > 500 MB — \`eff prune\` removes what is past its limits`,
    );
  } else if (stats.size_bytes > MAX_STORE_BYTES) {
    worse("warn");
    details.push(
      `store file ${String(Math.round(stats.size_bytes / 1024 ** 2))} MB > 500 MB, most of it free pages — \`eff prune\` reclaims them`,
    );
  }
  // the store opened, but a refused directory of ours still fails `eff backup` or `eff refresh`
  const refused = subdirRow();
  if (refused !== null) return refused;
  const ok = acc.status === "ok";
  return row(
    5,
    "store",
    title,
    acc.status,
    ok ? "store passes quick_check at the binary's schema" : "store problems",
    ok ? null : "see details",
    details,
  );
}

// --- #6, #7, #8: the credential store -----------------------------------------------------------------

const DAY_MS = 86_400_000;

/** What #6 learned, for #7/#8. */
interface CredentialFacts {
  readonly configured: boolean;
}

/** Row 6: presence, one store per install, env conflicts, mode bits; timestamps only. */
export async function checkCredentialPresence(
  io: CliIo,
  config: LenientConfig,
  credentialRow: CredentialStateRow | null,
): Promise<{ row: DoctorRow; facts: CredentialFacts }> {
  const title = "Credential store";
  const details: string[] = [];
  const stores = bothCredentialStores(io, config);
  let filePresent = false;
  try {
    filePresent = fileStoreExistsSync(config.credentialFile);
  } catch {
    filePresent = false;
  }
  // the keychain is consulted only when it is the recorded store or a file copy exists beside it;
  // `unavailable` = the native keyring addon did not load (it holds nothing we wrote, but it is a
  // broken install, never "no credential is stored")
  let keychainPresent: boolean | "error" | "unavailable" | "unchecked" = "unchecked";
  if (config.credentialStore === "keychain" || filePresent) {
    try {
      keychainPresent = await stores.keychain.exists();
    } catch (e) {
      keychainPresent =
        e instanceof CredentialStoreError && e.reason === "unavailable" ? "unavailable" : "error";
    }
  }
  details.push(
    `recorded store: ${config.credentialStore}${config.origins.EFF_CREDENTIAL_STORE === "file" ? " (recorded by eff setup)" : ""}`,
  );
  const keychainText =
    keychainPresent === "unchecked"
      ? "not checked"
      : keychainPresent === "unavailable"
        ? "unavailable (the native keyring addon did not load)"
        : String(keychainPresent);
  details.push(`keychain item: ${keychainText}; session.json: ${String(filePresent)}`);
  const mine =
    credentialRow !== null &&
    config.leagueId !== null &&
    credentialRow.league_id === config.leagueId
      ? credentialRow
      : null;
  if (mine !== null) {
    const storedMs = mine.stored_at === null ? NaN : Date.parse(mine.stored_at);
    if (Number.isFinite(storedMs))
      details.push(
        `storedAt ${mine.stored_at ?? ""} (${String(Math.max(0, Math.floor((io.clock.nowMs() - storedMs) / DAY_MS)))}d)`,
      );
    if (mine.last_accepted_at !== null) details.push(`lastAcceptedAt ${mine.last_accepted_at}`);
    if (mine.last_rejected_at !== null) details.push(`lastRejectedAt ${mine.last_rejected_at}`);
    if (mine.state === "rejected")
      details.push(
        `rejectedSince ${mine.rejected_since ?? "?"}; nextProbeAt ${mine.next_probe_at ?? "unscheduled"}`,
      );
  }
  if (keychainPresent === true && filePresent)
    return {
      row: row(
        6,
        "credential_store",
        title,
        "fail",
        "two stores hold a credential (the keychain item AND session.json) — forbidden",
        "run `eff setup --reset` then `eff setup`",
        details,
      ),
      facts: { configured: true },
    };
  if (config.credentialEnvConflicts.length > 0)
    return {
      row: row(
        6,
        "credential_store",
        title,
        "fail",
        `${config.credentialEnvConflicts.join(", ")} in the environment disagrees with the value eff setup recorded`,
        "remove EFF_CREDENTIAL_STORE/EFF_CREDENTIAL_FILE from the client config env block",
        details,
      ),
      facts: {
        configured: config.credentialStore === "file" ? filePresent : keychainPresent === true,
      },
    };
  if (keychainPresent === "error" && config.credentialStore === "keychain")
    return {
      row: row(
        6,
        "credential_store",
        title,
        "fail",
        "the keychain could not be read",
        "unlock the login keychain, or `eff setup --storage file`",
        details,
      ),
      facts: { configured: false },
    };
  if (keychainPresent === "unavailable" && config.credentialStore === "keychain")
    return {
      row: row(
        6,
        "credential_store",
        title,
        "fail",
        "the keychain is unavailable: the native keyring addon did not load",
        "reinstall the server's dependencies, or `eff setup --storage file`",
        details,
      ),
      facts: { configured: false },
    };
  const configured = config.credentialStore === "file" ? filePresent : keychainPresent === true;
  if (!configured)
    return {
      row: row(
        6,
        "credential_store",
        title,
        "credentials",
        `no credential is stored in the ${config.credentialStore} store`,
        "run `eff setup` in a terminal",
        details,
      ),
      facts: { configured: false },
    };
  if (config.credentialStore === "file") {
    try {
      const st = lstatSync(config.credentialFile);
      if (st.isSymbolicLink() || !st.isFile())
        return {
          row: row(
            6,
            "credential_store",
            title,
            "fail",
            "session.json is not a regular file",
            "run `eff setup --reset` then `eff setup`",
            details,
          ),
          facts: { configured: true },
        };
      if ((st.mode & 0o077) !== 0)
        return {
          row: row(
            6,
            "credential_store",
            title,
            "fail",
            "session.json has group/other permission bits",
            "`eff doctor --fix` (chmod 600)",
            details,
          ),
          facts: { configured: true },
        };
      ensureSecureDir(path.dirname(config.credentialFile), {
        create: false,
        what: "credential directory",
      });
    } catch (e) {
      return {
        row: row(
          6,
          "credential_store",
          title,
          "fail",
          `the credential file location is unsafe: ${refusal(e)}`,
          "`eff doctor --fix`, or move it with `eff setup --storage file`",
          details,
        ),
        facts: { configured: true },
      };
    }
  }
  return {
    row: row(
      6,
      "credential_store",
      title,
      "ok",
      `one store holds the credential (${config.credentialStore})`,
      null,
      details,
    ),
    facts: { configured: true },
  };
}

/** Rows 7 and 8: one read of the secret (the only offline check that touches it), then its format. */
export async function checkCredentialRead(
  io: CliIo,
  config: LenientConfig,
  facts: CredentialFacts,
): Promise<DoctorRow[]> {
  const selftest =
    config.keychainSelftest === null
      ? "never run"
      : `${config.keychainSelftest.outcome}${config.keychainSelftest.at === null ? "" : ` at ${config.keychainSelftest.at}`}`;
  if (!facts.configured)
    return [
      row(7, "credential_read", "Credential readability", "skip", "nothing stored", null, [
        `setup keychain self-test: ${selftest}`,
      ]),
      row(8, "credential_format", "Credential format", "skip", "nothing stored"),
    ];
  const stores = bothCredentialStores(io, config);
  const store = config.credentialStore === "keychain" ? stores.keychain : stores.file;
  const start = Date.now();
  let read: StoredCredential | null = null;
  let error: CredentialStoreError | null = null;
  try {
    read = await store.read();
  } catch (e) {
    error =
      e instanceof CredentialStoreError
        ? e
        : new CredentialStoreError(config.credentialStore, "read_failed");
  }
  const ms = Date.now() - start;
  const details = [`setup keychain self-test: ${selftest}`];
  if (config.credentialStore === "keychain" && ms > PROMPT_SUSPECT_MS)
    details.push(
      `the read took ${String(ms)} ms — a Keychain prompt was probably shown; if it appears on every run, use \`eff setup --storage file\``,
    );
  if (error !== null) {
    const fmt = error.reason === "invalid_format";
    return [
      row(
        7,
        "credential_read",
        "Credential readability",
        fmt ? "ok" : "fail",
        fmt
          ? "read, but the value fails the format rules"
          : `the ${config.credentialStore} store could not be read (${error.reason})`,
        fmt ? null : "run `eff setup` again",
        details,
      ),
      row(
        8,
        "credential_format",
        "Credential format",
        fmt ? "fail" : "skip",
        fmt ? "the stored value fails the format rules" : "not read",
        fmt ? "re-run `eff setup`" : null,
      ),
    ];
  }
  if (read === null)
    return [
      row(
        7,
        "credential_read",
        "Credential readability",
        "credentials",
        "the store holds nothing",
        "run `eff setup` in a terminal",
        details,
      ),
      row(8, "credential_format", "Credential format", "skip", "nothing stored"),
    ];
  const verdict = validateCookies(read.cookies);
  read = null; // discarded (a JavaScript string cannot be zeroed — plan 03 §1.3)
  return [
    row(
      7,
      "credential_read",
      "Credential readability",
      "ok",
      `one read succeeded (${String(ms)} ms); nothing was written`,
      null,
      details,
    ),
    verdict.ok
      ? row(
          8,
          "credential_format",
          "Credential format",
          "ok",
          "SWID and espn_s2 pass the format rules",
        )
      : row(
          8,
          "credential_format",
          "Credential format",
          "fail",
          `${verdict.field} fails the format rules`,
          "re-run `eff setup`",
        ),
  ];
}

// --- #9, #10, #11, #12 ---------------------------------------------------------------------------------

/** Row 9: the last successful probe ≤ 36 h; drift_state not red. */
export function checkDrift(store: Store | null, nowMs: number): DoctorRow {
  const title = "Drift probe";
  if (store === null) return row(9, "drift", title, "skip", "store not open");
  const drift = store.repos.driftState.get();
  const last = store.repos.probeLog.lastSuccess("host");
  if (drift !== null && (drift.status === "red" || drift.status === "host_moved")) {
    const details = parseDiffs(drift.diff_json)
      .filter((d) => d.removed.length > 0)
      .flatMap((d) => d.removed.slice(0, 5).map((p) => `${d.view}: removed ${p}`))
      .slice(0, 15);
    return row(
      9,
      "drift",
      title,
      "drift",
      drift.status === "host_moved"
        ? "ESPN_HOST_MOVED"
        : "red: ESPN removed or renamed a key the server reads",
      "run `eff probe` and read the diff (plan 01 §7)",
      details,
    );
  }
  const at = last === null ? NaN : Date.parse(last.at);
  if (!Number.isFinite(at))
    return row(
      9,
      "drift",
      title,
      "warn",
      "no successful probe yet",
      "run `eff probe` (and `eff install-launchd` for the daily run)",
    );
  if (nowMs - at > PROBE_MAX_AGE_MS)
    return row(
      9,
      "drift",
      title,
      "warn",
      `the last successful probe is older than 36 h (${last?.at ?? "?"})`,
      "run `eff probe`; check the launchd job (#11)",
    );
  return row(
    9,
    "drift",
    title,
    "ok",
    `${drift?.status ?? "green"}; last successful probe ${last?.at ?? "?"}`,
  );
}

/** Row 10: every configured dataset's age against its hard limit. */
export function checkDatasets(config: LenientConfig, ex: ExistingStore, nowMs: number): DoctorRow {
  const title = "Datasets";
  if (ex.kind !== "open" && ex.kind !== "missing")
    return row(10, "datasets", title, "skip", "store not open");
  const list =
    ex.kind === "open"
      ? sourceStatuses(ex.store, config, nowMs)
      : configuredSources(config).map((s) =>
          sourceStatus(s, null, null, 0, config.cacheDir, nowMs),
        );
  let status: RowStatus = "ok";
  const details: string[] = [];
  let bad = 0;
  for (const s of list) {
    let st: RowStatus = "ok";
    if (s.state === "never_loaded" || s.state === "expired" || s.state === "file_missing")
      st = s.beyond_hard === "omit" ? "warn" : "fail";
    else if (s.state === "stale") st = "warn";
    if (st !== "ok") bad++;
    if (st === "fail" || (st === "warn" && status === "ok")) status = st;
    details.push(
      `${s.source}: ${s.state}${s.age_s === null ? "" : ` (${String(s.age_s)} s)`}${s.consecutive_failures > 0 ? `, ${String(s.consecutive_failures)} consecutive failure(s)` : ""}`,
    );
  }
  return status === "ok"
    ? row(
        10,
        "datasets",
        title,
        "ok",
        "every dataset is within its freshness limits",
        null,
        details,
      )
    : row(
        10,
        "datasets",
        title,
        status,
        `${String(bad)} dataset(s) stale, expired or never loaded`,
        "`eff refresh all` (or `eff refresh <source>`)",
        details,
      );
}

/** Row 11: launchd jobs installed, loaded, their last run; the waiver-time fallback warning. */
export async function checkLaunchd(
  io: CliIo,
  config: LenientConfig,
  store: Store | null,
): Promise<DoctorRow> {
  const title = "launchd jobs";
  if (io.platform !== "darwin")
    return row(
      11,
      "launchd",
      title,
      "na",
      "launchd is macOS-only; schedule the `eff` jobs with your platform's scheduler",
    );
  if (io.uid === null) return row(11, "launchd", title, "skip", "no user id");
  const installed = installedPlists(io.home);
  const details: string[] = [];
  // plan 06 §1.4 / ADV OBJ-16: waiverProcessHour (read as ET) is the fallback only when
  // waiverNextExecutionDate is absent, with a warning when the two disagree — "absent" is said only
  // when it is (Stage C finding jobs-pool-anchor-cached-past-execution)
  const state = readJobState(config.cacheDir);
  const basis = stateToken(state, "pool.anchor_basis");
  if (basis === "process_days_et")
    details.push(
      stateToken(state, "pool.anchor_field") === "served"
        ? "waiverNextExecutionDate was not ahead even on a fresh read: `snapshot pool` uses waiverProcessHour read as ET for now (unverified — ADV OBJ-16)"
        : "waiverNextExecutionDate is absent: `snapshot pool` uses waiverProcessHour read as ET (unverified — ADV OBJ-16)",
    );
  else if (basis === "status" && stateToken(state, "pool.anchor_et") === "disagrees")
    details.push(
      "waiverNextExecutionDate disagrees with waiverProcessHour read as ET: `snapshot pool` follows waiverNextExecutionDate (the process hour's zone is unverified — ADV OBJ-16)",
    );
  if (installed.length === 0)
    return row(11, "launchd", title, "warn", "no jobs installed", "`eff install-launchd`", details);
  let status: RowStatus = "ok";
  let failing = 0;
  const records = new Map(
    jobRunRecords(readJobState(config.cacheDir), JOB_NAMES).map((r) => [r.job, r] as const),
  );
  for (const { job } of installed) {
    const r = await io.exec(LAUNCHCTL, launchctl.print(io.uid, labelOf(job)));
    const loaded = r.code === 0;
    if (!loaded) status = "warn";
    const spec = availableJobs().find((j) => j.name === job);
    const runs = (spec?.sources ?? [])
      .map((s) => (store === null ? null : store.repos.refreshLog.latest(s)))
      .filter((x) => x !== null)
      .map((x) => `${x.source} ${x.ok ? "ok" : `failed (${x.error ?? "?"})`} at ${x.finished_at}`);
    // the jobs without a dataset source record their runs in job-state.json (plan 06 J2)
    const rec = records.get(job);
    if (rec?.last_run_at != null)
      runs.push(
        rec.ok === true
          ? `ok at ${rec.last_run_at}`
          : `FAILED (${rec.error ?? "?"}) at ${rec.last_run_at}, ${String(rec.consecutive_failures)} in a row`,
      );
    if (rec?.ok === false) {
      failing++;
      status = "warn";
    }
    details.push(
      `${job}: ${loaded ? "loaded" : "NOT loaded"}${runs.length > 0 ? `; last run ${runs.join("; ")}` : ""}`,
    );
  }
  const missing = availableJobs()
    .map((j) => j.name)
    .filter((n) => !installed.some((i) => i.job === n));
  if (missing.length > 0) {
    status = "warn";
    details.push(`not installed: ${missing.join(", ")}`);
  }
  return row(
    11,
    "launchd",
    title,
    status,
    status === "ok"
      ? `${String(installed.length)} job(s) installed and loaded`
      : failing > 0
        ? `${String(failing)} job(s) failed on their last run${missing.length > 0 ? "; some jobs are missing or not loaded" : ""}`
        : "some jobs are missing or not loaded",
    status === "ok"
      ? null
      : failing > 0
        ? "see each job's last error below and its log under ~/Library/Logs/espn-fantasy-football-mcp/; `eff status` lists the runs"
        : "`eff install-launchd` (re-running is safe)",
    details,
  );
}

/** Whether `root` is a git checkout with sources (rows 12 and 24 apply). */
export function isCheckout(root: string): boolean {
  try {
    lstatSync(path.join(root, ".git"));
    return lstatSync(path.join(root, "src")).isDirectory();
  } catch {
    return false;
  }
}

/** Row 12: `.npmrc` hardening when run from a checkout. */
export function checkNpmrc(root: string): DoctorRow {
  const title = ".npmrc";
  if (!isCheckout(root)) return row(12, "npmrc", title, "na", "not a checkout (installed package)");
  let text: string | null = null;
  try {
    text = readSecureFile(path.join(root, ".npmrc"), {
      requirePrivate: false,
      maxBytes: 64 * 1024,
      what: ".npmrc",
    });
  } catch {
    text = null;
  }
  const kv = new Map(
    (text ?? "")
      .split("\n")
      .map((l) => l.replace(/[#;].*$/, "").trim())
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()] as const),
  );
  const missing = ["ignore-scripts", "save-exact"].filter((k) => kv.get(k) !== "true");
  if (missing.length === 0)
    return row(12, "npmrc", title, "ok", "ignore-scripts=true, save-exact=true");
  return row(
    12,
    "npmrc",
    title,
    "warn",
    `missing: ${missing.map((k) => `${k}=true`).join(", ")}`,
    "restore the repository's .npmrc",
  );
}

// --- #20 – #25 ------------------------------------------------------------------------------------

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => {
      resolve(false);
    });
    s.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      s.close(() => {
        resolve(true);
      });
    });
  });
}

/** Row 20: EFF_SETUP_PORT free, or the default range has a free port (plan 03 §2.2). */
export async function checkSetupPort(io: CliIo, config: LenientConfig | null): Promise<DoctorRow> {
  const title = "Setup page port";
  const explicit = config?.setupPort ?? null;
  for (const p of candidatePorts(explicit)) {
    if (await canBind(p))
      return row(
        20,
        "setup_port",
        title,
        "ok",
        `127.0.0.1:${String(p)} is free for \`eff setup --page\``,
      );
    if (explicit !== null) {
      const owner = await portOwner(io.exec, p);
      return row(
        20,
        "setup_port",
        title,
        "warn",
        `EFF_SETUP_PORT ${String(p)} is in use${owner === null ? "" : ` by ${owner}`}`,
        "set EFF_SETUP_PORT to a free port, or use `eff setup` (no page)",
      );
    }
  }
  return row(
    20,
    "setup_port",
    title,
    "warn",
    "every port 8790-8799 is in use",
    "set EFF_SETUP_PORT to a free port, or use `eff setup` (no page)",
  );
}

/**
 * Rows 21–23: the open health checks (plan 03 §5, T-08). An ir_invalid check is closed by the
 * nightly roster snapshot the night it reads the user's IR valid again, so an open one is the IR as
 * last read (an event check — scoring, settings — waits for `eff doctor --ack`).
 */
export function checkHealthChecks(store: Store | null): DoctorRow[] {
  const titles = {
    scoring_mismatch: [21, "Scoring golden"],
    settings_changed: [22, "Settings changed"],
    ir_invalid: [23, "IR validity"],
  } as const;
  if (store === null)
    return Object.entries(titles).map(([id, [n, t]]) => row(n, id, t, "skip", "store not open"));
  const open = store.repos.leagueSettings.openChecks().filter((c) => !c.acknowledged);
  return Object.entries(titles).map(([id, [n, t]]) => {
    const hits = open.filter((c) => c.id === id);
    if (hits.length === 0) return row(n, id, t, "ok", "no open check");
    const worst = hits.some((c) => c.status === "fail") ? "fail" : "warn";
    const details = hits.slice(0, 5).map(
      (c) =>
        `raised ${c.raised_at}: ${Object.entries(c.detail)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(", ")}`,
    );
    const fix =
      id === "scoring_mismatch"
        ? "run `onboard`'s self-check (plan 08 §6 step 3d); `eff doctor --ack scoring_mismatch` once reviewed"
        : id === "settings_changed"
          ? "the commissioner changed the league settings: `onboard` explains it; `eff setup --seeding …` or `eff doctor --ack settings_changed`"
          : "move the healthy player out of IR (adds are blocked until then); the nightly roster snapshot closes the check once it reads the IR valid";
    return row(n, id, t, worst, `${String(hits.length)} open check(s)`, fix, details);
  });
}

/** Newest mtime of the files under `dir` (symlinks not followed; bounded walk). */
export function newestMtime(dir: string, budget = { left: 20_000 }): number {
  let newest = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const n of names) {
    if (budget.left-- <= 0) break;
    const p = path.join(dir, n);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) newest = Math.max(newest, newestMtime(p, budget));
    else if (st.isFile()) newest = Math.max(newest, st.mtimeMs);
  }
  return newest;
}

function mtimeOf(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Row 24: in a checkout, dist/cli.js newer than every file under src/ and package.json — and every
 * enabled plugin copy (what Claude Code actually runs) built no earlier than this clone: README says
 * `claude plugin update` at an unchanged version keeps the old copy, which the clone's own check never
 * saw (Stage C finding doctor-plugin-install-invisible).
 */
export function checkStaleBuild(root: string, plugin: PluginInstall | null = null): DoctorRow {
  const title = "Stale dist/";
  const copies = plugin?.enabled === true ? plugin.copies : [];
  const checkout = isCheckout(root);
  const clone = checkout ? mtimeOf(distEntry(root)) : null;
  const newestSource = checkout
    ? Math.max(newestMtime(path.join(root, "src")), mtimeOf(path.join(root, "package.json")) ?? 0)
    : 0;
  const details: string[] = [];
  let stale = 0;
  for (const c of copies) {
    const copy = mtimeOf(distEntry(c.installPath));
    if (copy === null) {
      stale++;
      details.push(`plugin copy ${c.installPath}: no dist/cli.js`);
    } else if (checkout && copy < Math.max(clone ?? 0, newestSource)) {
      stale++;
      details.push(
        `plugin copy ${c.installPath}: built before this clone's current build or sources — Claude Code runs the old server`,
      );
    } else details.push(`plugin copy ${c.installPath}: current`);
  }
  const pluginFix =
    "refresh the plugin's copy: `claude plugin uninstall espn-fantasy-football@espn-fantasy-football-mcp`, then install it again from the built clone (README Upgrade), and restart the client";
  if (!checkout && copies.length === 0)
    return row(24, "stale_build", title, "na", "not a checkout (installed package)");
  if (checkout && clone === null)
    return row(
      24,
      "stale_build",
      title,
      "warn",
      "dist/cli.js does not exist — the package is not built",
      "`npm run build`",
      details,
    );
  if (checkout && (clone ?? 0) < newestSource)
    return row(
      24,
      "stale_build",
      title,
      "fail",
      "dist/ is older than the sources — the client is launching an old server",
      `\`npm run build\`${copies.length > 0 ? `, then ${pluginFix}` : ""}`,
      details,
    );
  if (stale > 0)
    return row(
      24,
      "stale_build",
      title,
      "fail",
      `${String(stale)} plugin cop${stale === 1 ? "y is" : "ies are"} older than this clone — Claude Code launches an old server`,
      pluginFix,
      details,
    );
  return row(
    24,
    "stale_build",
    title,
    "ok",
    checkout ? "dist/ is newer than every source file" : "the plugin copy is built",
    null,
    details,
  );
}

/** The last `maxLines` lines of a file (no symlink), from its last LOG_TAIL_BYTES. */
export function tailLines(file: string, maxLines = LOG_TAIL_LINES): string[] | null {
  let fd: number;
  try {
    fd = openSync(file, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const len = Math.min(st.size, LOG_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, st.size - len);
    const lines = buf
      .subarray(0, n)
      .toString("utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "");
    if (st.size > len) lines.shift();
    return lines.slice(-maxLines);
  } finally {
    closeSync(fd);
  }
}

/** The default Claude Desktop per-server log (plan 03 §5 #25 [A-9]). */
export function defaultClientLog(home: string): string {
  return path.join(home, "Library", "Logs", "Claude", `mcp-server-${SERVER_NAME}.log`);
}

const LOG_BAD_RE = /error|exception|fail|EACCES|ENOENT|not found|exited|disconnect/i;

/** Row 25: the client's MCP-log tail for this server, redacted (registered values + patterns). */
export function checkClientLog(file: string, secrets: SecretRegistry): DoctorRow {
  const title = "Client MCP log tail";
  const lines = tailLines(file);
  if (lines === null)
    return row(
      25,
      "client_log",
      title,
      "skip",
      `no client log at ${file}`,
      "pass --client-log <path> if your client logs elsewhere",
    );
  const shown = lines.map((l) =>
    truncate(redactString(l, secrets).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " "), 240),
  );
  const bad = shown.some((l) => LOG_BAD_RE.test(l));
  return row(
    25,
    "client_log",
    title,
    bad ? "warn" : "ok",
    bad
      ? "the client log shows errors or exits for this server (the last lines below)"
      : `last ${String(shown.length)} line(s) show no errors`,
    bad ? "the lines name the failure; the rows above name the fix" : null,
    shown,
  );
}

// --- --fix and --ack ---------------------------------------------------------------------------------

/** One repair `--fix` may apply. */
export interface Fix {
  readonly description: string;
  apply(): void;
}

function ownUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

/** Whether `p` carries an ACL entry giving others access (false when it cannot be read: not ours to touch). */
function hasForeignAcl(p: string, acl: AclAccess): boolean {
  try {
    return foreignAclEntries(p, "path", acl).length > 0;
  } catch {
    return false;
  }
}

/** The ACL repair of one of our own paths: removes every entry that gives others access. */
function aclFix(p: string, what: string, acl: AclAccess): Fix | null {
  if (!hasForeignAcl(p, acl)) return null;
  return {
    description: `remove the ACL entries that give others access to ${p} (chmod -N)`,
    apply: () => {
      stripForeignAcl(p, what, acl);
    },
  };
}

/**
 * The repairs of one directory of ours: created when missing (`create`) through ensureSecureDir —
 * which removes an ACL entry the parent passed down to every directory it made, so the new directory
 * is the 0700 one every later check accepts (Stage C finding doctor-fix-dirs-inherit-acl: a plain
 * mkdir kept the inherited entry and every command then refused the directory --fix had made); an
 * existing one gets its mode back to 0700 and its foreign ACL entries removed. Never a symlink,
 * something that is not a directory, or a directory of another user.
 */
function dirFixes(dir: string, what: string, create: boolean, acl: AclAccess): Fix[] {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    if (!create || insecureAncestors(dir).length > 0) return [];
    return [
      {
        description: `create ${what} ${dir} (0700)`,
        apply: () => {
          ensureSecureDir(dir, { create: true, what, acl });
        },
      },
    ];
  }
  const uid = ownUid();
  if (st.isSymbolicLink() || !st.isDirectory() || (uid !== null && st.uid !== uid)) return [];
  const out: Fix[] = [];
  if ((st.mode & 0o077) !== 0 || (st.mode & 0o700) !== 0o700)
    out.push({
      description: `chmod 700 ${dir}`,
      apply: () => {
        chmodSync(dir, 0o700);
      },
    });
  const a = aclFix(dir, what, acl);
  if (a !== null) out.push(a);
  return out;
}

/** The repairs of one private file of ours: mode 0600, foreign ACL entries removed. */
function fileFixes(file: string, acl: AclAccess): Fix[] {
  try {
    const st = lstatSync(file);
    const uid = ownUid();
    if (!st.isFile() || (uid !== null && st.uid !== uid)) return [];
    const out: Fix[] = [];
    if ((st.mode & 0o077) !== 0 || (st.mode & 0o600) !== 0o600)
      out.push({
        description: `chmod 600 ${file}`,
        apply: () => {
          chmodSync(file, 0o600);
        },
      });
    const a = aclFix(file, "file", acl);
    if (a !== null) out.push(a);
    return out;
  } catch {
    return []; // not there
  }
}

/**
 * The repair of one run directory of ours inside tmp/ or recordings/ that is not private: its whole
 * tree (bounded by MAX_RUN_TREE_ENTRIES) back to directories 0700 and files 0600, every foreign ACL
 * entry removed — never through a symlink, never a path of another user — so `eff uninstall` and
 * `eff prune` recognise it as a run directory this program made (Stage C finding
 * doctor-fix-run-dirs-unrepaired: only the top-level directories were repaired).
 */
function runTreeFix(root: string, acl: AclAccess): Fix | null {
  const uid = ownUid();
  const paths: { p: string; dir: boolean }[] = [];
  const walk = (p: string): void => {
    if (paths.length >= MAX_RUN_TREE_ENTRIES) return;
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (st.isSymbolicLink() || (uid !== null && st.uid !== uid)) return;
    if (st.isDirectory()) {
      paths.push({ p, dir: true });
      let names: string[] = [];
      try {
        names = readdirSync(p).sort();
      } catch {
        names = [];
      }
      for (const n of names) walk(path.join(p, n));
    } else if (st.isFile()) paths.push({ p, dir: false });
  };
  walk(root);
  const modeBad = (x: { p: string; dir: boolean }): boolean => {
    try {
      const m = lstatSync(x.p).mode;
      return (m & 0o077) !== 0 || (m & (x.dir ? 0o700 : 0o600)) !== (x.dir ? 0o700 : 0o600);
    } catch {
      return false;
    }
  };
  const stripAll = hasForeignAcl(root, acl);
  const todo = paths.filter((x) => modeBad(x) || (stripAll && hasForeignAcl(x.p, acl)));
  if (todo.length === 0) return null;
  return {
    description: `repair the run directory ${root} (${String(todo.length)} path(s) to 0700/0600${stripAll ? ", ACL entries for others removed" : ""})`,
    apply: () => {
      for (const x of todo) {
        if (modeBad(x)) chmodSync(x.p, x.dir ? 0o700 : 0o600);
        if (stripAll && hasForeignAcl(x.p, acl)) stripForeignAcl(x.p, "run directory", acl);
      }
    },
  };
}

/** Our files inside one of the cache's own directories (only when it is a real directory). */
function ownFilesIn(dir: string, re: RegExp): string[] {
  try {
    if (!lstatSync(dir).isDirectory()) return [];
    return readdirSync(dir)
      .filter((n) => re.test(n))
      .sort()
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/**
 * The repairs `--fix` would make (never on a symlink or something we do not own): the config and
 * cache dirs (created when missing, through ensureSecureDir), the cache's own directories —
 * `datasets/`, `backups/`, `tmp/`, `recordings/`, which every store open, `eff backup`, `eff refresh`
 * and the fixture tools refuse while group/other bits are set (never created here: what needs one
 * makes it) — and the run directories inside `tmp/` and `recordings/`, whole; our private files: the
 * credential file, the store with its -wal/-shm, the jobs' state and notification log, the tuned
 * parameters and the backups (each written 0600). Each also loses an ACL entry giving others access
 * (rows 4 and 5 refuse one as `insecure_acl`). A tree copied or restored with default modes is
 * repaired whole (Stage C findings doctor-fix-skips-cache-subdirs, doctor-fix-dirs-inherit-acl,
 * doctor-fix-run-dirs-unrepaired).
 */
export function plannedFixes(config: LenientConfig, acl: AclAccess = systemAcl): Fix[] {
  const store = storePath(config.cacheDir);
  const backups = CACHE_DIRS.find((d) => d.name === path.basename(backupDir(config.cacheDir)));
  const out: (Fix | null)[] = [
    ...dirFixes(config.configDir, "config dir", true, acl),
    ...dirFixes(config.cacheDir, "cache dir", true, acl),
    ...CACHE_DIRS.flatMap((d) =>
      dirFixes(path.join(config.cacheDir, d.name), `${d.name}/ dir`, false, acl),
    ),
    ...CACHE_DIRS.filter((d) => d.tree === true).flatMap((d) =>
      ownDirsIn(path.join(config.cacheDir, d.name), d.re).map((p) => runTreeFix(p, acl)),
    ),
    ...fileFixes(config.credentialFile, acl),
    ...fileFixes(path.join(config.configDir, TUNED_PARAMETERS_FILE_NAME), acl),
    ...fileFixes(store, acl),
    ...fileFixes(`${store}-wal`, acl),
    ...fileFixes(`${store}-shm`, acl),
    ...fileFixes(jobStatePath(config.cacheDir), acl),
    ...fileFixes(notificationLogPath(config.cacheDir), acl),
    ...(backups === undefined
      ? []
      : ownFilesIn(backupDir(config.cacheDir), backups.re).flatMap((f) => fileFixes(f, acl))),
  ];
  return out.filter((f): f is Fix => f !== null);
}

// --- the run -------------------------------------------------------------------------------------

/** Runs every row; the store (if opened) is closed before returning. */
export async function runDoctor(io: CliIo, opts: DoctorOptions): Promise<DoctorReport> {
  const rows: DoctorRow[] = [];
  let config: LenientConfig | null = null;
  let log: Logger = makeLogger(io, bootLevel(io.env));
  const secrets = new SecretRegistry();
  try {
    config = loadConfigFromProcess(
      {
        env: io.env,
        home: io.home,
        repoRoot: io.packageRoot,
        nowMs: io.clock.nowMs(),
        xattr: io.xattr,
      },
      { requireLeagueId: false },
    );
    log = makeLogger(io, config.logLevel);
    registerConfigRedaction(log, config);
    if (config.leagueId !== null) secrets.addIdentifier("league", config.leagueId);
    if (config.probeLeagueId !== null) secrets.addIdentifier("league", config.probeLeagueId);
    // certificate verification off: every ESPN request is refused (plan 02 T2; Stage C finding
    // espn-tls-verify-disabled-unguarded) — a configuration finding, worse than a missing id
    const tlsOff = tlsVerificationDisabled(io.env);
    rows.push(
      row(
        0,
        "config",
        "Configuration",
        tlsOff ? "config" : config.leagueId === null ? "warn" : "ok",
        tlsOff
          ? "certificate verification is off (NODE_TLS_REJECT_UNAUTHORIZED=0): no ESPN request is sent"
          : config.leagueId === null
            ? "resolves, but ESPN_LEAGUE_ID is not set"
            : "configuration resolves",
        tlsOff
          ? "unset NODE_TLS_REJECT_UNAUTHORIZED in this shell and in the MCP client's env block (a proxy's CA belongs in NODE_EXTRA_CA_CERTS)"
          : config.leagueId === null
            ? "set ESPN_LEAGUE_ID (env or config.json)"
            : null,
        [...config.warnings],
      ),
    );
  } catch (e) {
    const issues =
      e instanceof ConfigError ? e.issues.map((i) => `${i.key}: ${i.reason}`) : [errorText(e)];
    rows.push(
      row(
        0,
        "config",
        "Configuration",
        "config",
        "the configuration is invalid",
        "fix the named keys (env or <config>/config.json)",
        issues,
      ),
    );
  }

  if (config !== null && opts.fix) {
    const fixes = plannedFixes(config);
    if (fixes.length > 0) {
      let go = opts.yes;
      if (!go) {
        const prompt = createTerminalPrompt({ stdin: io.stdin, out: io.stderr });
        try {
          go =
            (io.stdin as { isTTY?: boolean }).isTTY === true &&
            (await prompt.confirm(
              `Apply ${String(fixes.length)} fix(es): ${fixes.map((f) => f.description).join("; ")}?`,
            ));
        } finally {
          prompt.close();
        }
      }
      for (const f of fixes) {
        if (!go) {
          await writeLine(io.stderr, `eff doctor: not applied (add --yes): ${f.description}`);
          continue;
        }
        try {
          f.apply();
          await writeLine(io.stderr, `eff doctor: fixed: ${f.description}`);
        } catch (e) {
          await writeLine(io.stderr, `eff doctor: could not ${f.description}: ${errorText(e)}`);
        }
      }
    }
  }

  rows.push(checkNode(io.nodeVersion, io.execPath));
  const scans = [
    scanClientConfig("desktop", opts.clientConfig ?? desktopConfigPath(io.home)),
    scanClientConfig("code", codeConfigPath(io.home)),
  ];
  const plugin = scanPlugin(io.home);
  rows.push(await checkLaunchConfig(io, scans, plugin));
  rows.push(checkClientSecrecy(scans));

  let ex: ExistingStore = { kind: "missing" };
  try {
    let credRow: CredentialStateRow | null = null;
    if (config !== null) {
      rows.push(checkConfigDir(io, config));
      ex = openExistingStore(config, io.clock, log, opts.factory);
      rows.push(checkStore(io, config, ex));
      if (ex.kind === "open") {
        try {
          credRow = ex.store.repos.credentialState.get();
        } catch {
          credRow = null;
        }
        if (opts.ack !== undefined) {
          const at = io.clock.nowIso();
          const n = ex.store.repos.leagueSettings.acknowledgeChecks(
            opts.ack as CheckId,
            at,
            "doctor",
            at,
          );
          await writeLine(
            io.stderr,
            `eff doctor: acknowledged ${String(n)} open ${opts.ack} check(s)`,
          );
        }
      }
      const presence = await checkCredentialPresence(io, config, credRow);
      rows.push(presence.row);
      rows.push(...(await checkCredentialRead(io, config, presence.facts)));
    } else {
      for (const [n, id, t] of [
        [4, "config_dir", "Config dir"],
        [5, "store", "Cache dir + store"],
        [6, "credential_store", "Credential store"],
        [7, "credential_read", "Credential readability"],
        [8, "credential_format", "Credential format"],
      ] as const)
        rows.push(row(n, id, t, "skip", "configuration invalid"));
    }
    const store = ex.kind === "open" ? ex.store : null;
    const now = io.clock.nowMs();
    rows.push(checkDrift(store, now));
    rows.push(
      config === null
        ? row(10, "datasets", "Datasets", "skip", "configuration invalid")
        : checkDatasets(config, ex, now),
    );
    rows.push(
      config === null
        ? row(11, "launchd", "launchd jobs", "skip", "configuration invalid")
        : await checkLaunchd(io, config, store),
    );
    rows.push(checkNpmrc(io.packageRoot));
    rows.push(checkWriteFlag(config, credRow, io.env, scans));
    if (!opts.online || config === null) {
      const why = config === null ? "configuration invalid" : "offline (use --online)";
      for (const [n, id, t] of [
        [14, "clock_skew", "Clock skew (online)"],
        [15, "host_probe", "API host / shape probe (online)"],
        [16, "credential_validity", "Credential validity (online)"],
        [17, "league_reachability", "League reachability (online)"],
        [18, "own_team", "Own team (online)"],
        [19, "sources_online", "Sources (online)"],
      ] as const)
        rows.push(row(n, id, t, "skip", why));
    } else {
      rows.push(...(await onlineRows(io, config, store, log)));
    }
    rows.push(await checkSetupPort(io, config));
    rows.push(...checkHealthChecks(store));
    rows.push(checkStaleBuild(io.packageRoot, plugin));
    rows.push(checkClientLog(opts.clientLog ?? defaultClientLog(io.home), secrets));
  } finally {
    if (ex.kind === "open") ex.store.close();
  }
  return {
    version: VERSION,
    node: io.nodeVersion,
    generated_at: io.clock.nowIso(),
    online: opts.online,
    exit_code: exitCodeFor(rows),
    rows,
  };
}

const MARK: Record<RowStatus, string> = {
  ok: " ok ",
  warn: "warn",
  fail: "FAIL",
  config: "CONF",
  credentials: "CRED",
  drift: "DRFT",
  na: " -- ",
  skip: "skip",
};

/** The terminal rendering. */
export function renderDoctor(r: DoctorReport): string[] {
  const out = [
    `eff doctor — espn-fantasy-football-mcp ${r.version}, node ${r.node}${r.online ? " (online)" : ""}`,
  ];
  for (const x of r.rows) {
    out.push(
      `[${MARK[x.status]}] ${x.n === 0 ? "  " : String(x.n).padStart(2)} ${x.title} — ${x.message}`,
    );
    for (const d of x.details) out.push(`           ${d}`);
    if (x.fix !== null && x.status !== "ok") out.push(`           → ${x.fix}`);
  }
  const worst =
    [
      "no failures",
      "failures above",
      "configuration problem",
      "credentials problem",
      "drift detected",
    ][r.exit_code] ?? "failures above";
  out.push(`exit ${String(r.exit_code)}: ${worst}`);
  return out;
}

/** `eff doctor`. */
export async function doctor(io: CliIo, opts: DoctorOptions): Promise<number> {
  const report = await runDoctor(io, opts);
  if (opts.json) await writeLine(io.stdout, JSON.stringify(report, null, 2));
  else for (const l of renderDoctor(report)) await writeLine(io.stdout, l);
  return report.exit_code;
}
