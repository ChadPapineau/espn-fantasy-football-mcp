// uninstall.ts — `eff uninstall [--yes] [--dry-run] [--keep-config] [--export-log <path>]` (plan 03
// L8, §8): (0) when asked, export the recommendation log AND the snapshots as JSON before anything is
// deleted — every league's rows, read straight from store.sqlite on a read-only connection (so a
// store that needs a migration, or was written by a newer binary, still exports), and an export that
// cannot be written stops the whole uninstall with nothing changed; (1) boot out and delete our
// LaunchAgents and the jobs' log files; (2) delete BOTH the keychain items and session.json —
// always, whichever store config.json records (a stale second copy must never survive — ADV OBJ-05)
// — plus a leftover self-test item, saying that Time Machine may hold copies and that the ESPN
// session itself is NOT invalidated; (3) delete the cache (store, datasets, backups, temp, the
// fixture tools' raw recordings, interrupted-write temp files); (4) ask before deleting the config dir;
// (5) print — never edit — the client-config entry to remove, `claude mcp remove`, the ESPN "log out
// everywhere" pointer and `npm uninstall -g`. Interactive: every destructive step asks y/N on a
// terminal; `--yes` answers yes; without a terminal and without `--yes` nothing changes. Deletion is
// by exact known name or pattern; a directory is removed only when empty afterwards. A config.json
// that cannot be read does not block it: the directories come from the environment alone
// (EFF_CONFIG_DIR / EFF_CACHE_DIR are env-only keys) and what cannot be known is said.
// Ported from sibling @5daa625, adapted (credentials, the export, the per-step questions).
import {
  constants as fsc,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  rmdirSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { selftestItemDeleter } from "../auth/stores.js";
import { removeAllCredentials } from "../auth/uninstall.js";
import { KEYCHAIN_SERVICE } from "../auth/types.js";
import {
  BACKUP_DIR_NAME,
  CONFIG_FILE_NAME,
  DATASET_DIR_NAME,
  defaultCredentialFilePath,
  ensureSecureDir,
  GATE_KEY_FILE_NAME,
  PathSecurityError,
  resolveAbsolute,
  resolveCacheDir,
  resolveConfigDir,
  RUN_TEMP_DIR_NAME,
  STORE_FILE_NAME,
  storePath,
  type Env,
} from "../config/paths.js";
import type { ConfigIssue, LenientConfig } from "../config/schema.js";
import { TUNED_PARAMETERS_FILE_NAME } from "../domain/reclog/tune.js";
import type { StoreFactory } from "../store/types.js";
import { bothCredentialStores } from "./espn-stack.js";
import { EXIT } from "./exit.js";
import { isTty, writeLine, type CliIo } from "./io.js";
import { JOB_STATE_FILE, JOB_STATE_LOCK } from "./job-state.js";
import { JOB_NAMES, logDir, removeJobs } from "./launchd.js";
import type { Logger } from "./log.js";
import { resolveBackupDestination } from "./maintenance.js";
import { codeConfigPath, desktopConfigPath, SERVER_NAME } from "./print-config.js";
import { createTerminalPrompt, type TerminalPrompt } from "./prompt.js";
import { openExistingStore } from "./store-access.js";

/** Plain files of ours directly inside the cache dir. */
const CACHE_FILES = [
  STORE_FILE_NAME,
  `${STORE_FILE_NAME}-wal`,
  `${STORE_FILE_NAME}-shm`,
  `${STORE_FILE_NAME}-journal`,
  `${STORE_FILE_NAME}.lock`,
  JOB_STATE_FILE,
  JOB_STATE_LOCK,
];
/** An interrupted atomic write's temp file (config/paths writeSecureFileAtomic: `<file>.<pid>.<12 hex>.tmp`). */
const atomicTemp = (names: readonly string[]): RegExp =>
  new RegExp(
    `^(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\.\\d{1,10}\\.[0-9a-f]{12}\\.tmp$`,
  );
/** Interrupted-write temp files of ours directly inside the cache dir. */
const CACHE_FILE_PATTERNS: readonly RegExp[] = [atomicTemp([JOB_STATE_FILE])];
/** A run directory under tmp/ (mkdtemp: `<prefix>-XXXXXX`). */
const RUN_TMP_RE = /^[A-Za-z0-9_]{1,80}-[A-Za-z0-9]{6}$/;
/**
 * The fixture tools' raw captures (scripts/record-fixture.ts, scripts/espn-fixture/history.ts):
 * `<cache>/recordings/<YYYY-MM-DD>` and `recordings/history-<YYYY-MM-DD>`, 0700 — they hold REAL
 * names and ids, so they go with the cache.
 */
export const RECORDINGS_DIR_NAME = "recordings";
const RECORDING_RUN_RE = /^(?:history-)?\d{4}-\d{2}-\d{2}$/;

/** One directory of ours inside a purged dir: entries matching `re` go (`tree`: whole private trees). */
export interface PurgeDir {
  readonly name: string;
  readonly re: RegExp;
  /** Matching entries are directories this program made (owned, private): removed with their tree. */
  readonly tree?: boolean;
}

/** Directories of ours inside the cache dir, emptied by pattern. */
const CACHE_DIRS: readonly PurgeDir[] = [
  {
    name: DATASET_DIR_NAME,
    re: /^[a-z][a-z0-9_]*__[a-z][a-z0-9_]*(?:\.sqlite(?:-journal|-wal|-shm)?|\..*\.tmp(?:-journal)?)$/,
  },
  {
    name: BACKUP_DIR_NAME,
    re: /^store(?:-\d{4}-\d{2}-\d{2}(?:-\d{1,16})?\.sqlite|\.sqlite\.bak-v\d+(?:-\d+)?)$/,
  },
  { name: RUN_TEMP_DIR_NAME, re: RUN_TMP_RE, tree: true },
  { name: RECORDINGS_DIR_NAME, re: RECORDING_RUN_RE, tree: true },
];
/** Plain files of ours inside the config dir (session.json is removed by the credential step). */
// the human-applied tuned parameters (`eff tune --apply`, plan 10 C9) live in the config dir too
const CONFIG_FILES = [CONFIG_FILE_NAME, GATE_KEY_FILE_NAME, TUNED_PARAMETERS_FILE_NAME];
/** Interrupted-write temp files of ours inside the config dir (session.json's: the file store's delete). */
const CONFIG_FILE_PATTERNS: readonly RegExp[] = [
  atomicTemp([CONFIG_FILE_NAME, TUNED_PARAMETERS_FILE_NAME]),
];

function kind(p: string): "file" | "dir" | "symlink" | "other" | null {
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return "symlink";
    if (st.isFile()) return "file";
    if (st.isDirectory()) return "dir";
    return "other";
  } catch {
    return null;
  }
}

/** One purge step: unlink, remove one of our run-temp trees, rmdir if empty — or keep (not ours). */
export type PurgeStep =
  | { readonly path: string; readonly action: "unlink" | "rmtree" | "rmdir" }
  | { readonly path: string; readonly action: "keep"; readonly reason: string };

function isOwnRunDir(p: string): boolean {
  try {
    const st = lstatSync(p);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    return st.isDirectory() && (uid === null || st.uid === uid) && (st.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/** What a purge of `dir` would delete (existing entries only), in deletion order. */
export function purgePlan(
  dir: string,
  files: readonly string[],
  dirs: readonly PurgeDir[],
  filePatterns: readonly RegExp[] = [],
): PurgeStep[] {
  const out: PurgeStep[] = [];
  if (kind(dir) !== "dir") return out;
  for (const d of dirs) {
    const sub = path.join(dir, d.name);
    if (kind(sub) !== "dir") continue;
    try {
      ensureSecureDir(sub, { create: false, what: "directory" });
    } catch (e) {
      out.push({
        path: sub,
        action: "keep",
        reason: `not our private directory${e instanceof PathSecurityError ? ` (${e.reason})` : ""}`,
      });
      continue;
    }
    for (const n of readdirSync(sub).sort()) {
      if (!d.re.test(n)) continue;
      const p = path.join(sub, n);
      const k = kind(p);
      if (d.tree !== true) {
        if (k === "file" || k === "symlink") out.push({ path: p, action: "unlink" });
      } else if (k === "dir" && isOwnRunDir(p)) out.push({ path: p, action: "rmtree" });
      else out.push({ path: p, action: "keep", reason: "not a run directory this program made" });
    }
    out.push({ path: sub, action: "rmdir" });
  }
  const names = new Set(files);
  if (filePatterns.length > 0) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      entries = [];
    }
    for (const n of entries) if (filePatterns.some((re) => re.test(n))) names.add(n);
  }
  for (const f of names) {
    const p = path.join(dir, f);
    const k = kind(p);
    if (k === "file" || k === "symlink") out.push({ path: p, action: "unlink" });
  }
  out.push({ path: dir, action: "rmdir" });
  return out;
}

/** The jobs' log files under ~/Library/Logs (plan 06 §2: one `<job>.log` per job), by exact name. */
export function jobLogPlan(home: string): PurgeStep[] {
  return purgePlan(
    logDir(home),
    JOB_NAMES.map((n) => `${n}.log`),
    [],
  );
}

/** Executes a plan; a non-empty directory (someone else's files) is kept, never forced. */
export function executePurge(plan: readonly PurgeStep[]): { removed: string[]; kept: string[] } {
  const removed: string[] = [];
  const kept: string[] = [];
  for (const s of plan) {
    if (s.action === "keep") continue;
    try {
      if (s.action === "rmdir") rmdirSync(s.path);
      else rmSync(s.path, { recursive: s.action === "rmtree", force: true });
      removed.push(s.path);
    } catch {
      kept.push(s.path);
    }
  }
  return { removed, kept };
}

/** The manual steps uninstall prints and never performs (plan 03 §8 steps 5–6). */
export function manualSteps(home: string): string[] {
  return [
    `Remove the "${SERVER_NAME}" entry from ${desktopConfigPath(home)} (Claude Desktop), then restart it.`,
    `Claude Code: claude mcp remove --scope user ${SERVER_NAME} (entries live in ${codeConfigPath(home)})`,
    "The ESPN session itself is NOT invalidated: log out at espn.com (account settings) to attempt that — whether it works is unverified.",
    "Time Machine or other backups may still hold copies of the keychain, session.json and the store.",
    "If installed globally: npm uninstall -g espn-fantasy-football-mcp",
  ];
}

/**
 * The tables `--export-log` writes (plan 03 §8 step 3: "recommendation log and snapshots"): the
 * never-rebuildable recommendation log with its scored outcomes, and the snapshot corpus — roster,
 * pool and pre-week scoreboard snapshots and ESPN's projection snapshots (plan 06 §1.3, T-07). A
 * table this store does not have (an older schema) is exported empty and counted as absent.
 */
export const EXPORT_TABLES = [
  "recommendation_log",
  "recommendation_outcome",
  "roster_snapshot",
  "pool_snapshot",
  "scoreboard_snapshot",
  "espn_projection",
] as const;

/** One exported table's row count, or null when the store has no such table. */
export type ExportCounts = Readonly<Record<(typeof EXPORT_TABLES)[number], number | null>>;

/** A stored row as JSON: `<x>_json` columns parsed under `<x>`, bytes as base64. */
function exportRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.endsWith("_json") && typeof v === "string") {
      try {
        out[k.slice(0, -5)] = JSON.parse(v) as unknown;
        continue;
      } catch {
        // not JSON after all: kept verbatim under its column name
      }
    }
    out[k] = v instanceof Uint8Array ? { base64: Buffer.from(v).toString("base64") } : v;
  }
  return out;
}

/** Buffered writes to a NEW 0600 file (O_EXCL, never follows a symlink); removed on failure. */
function newPrivateWriter(dest: string): { write(s: string): void; close(): void; abort(): void } {
  const fd = openSync(dest, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
  let buf: string[] = [];
  let size = 0;
  const flush = (): void => {
    const b = Buffer.from(buf.join(""), "utf8");
    let off = 0;
    while (off < b.length) off += writeSync(fd, b, off, b.length - off);
    buf = [];
    size = 0;
  };
  return {
    write: (s) => {
      buf.push(s);
      size += s.length;
      if (size >= 64 * 1024) flush();
    },
    close: () => {
      flush();
      fsyncSync(fd);
      closeSync(fd);
    },
    abort: () => {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
      rmSync(dest, { force: true });
    },
  };
}

/**
 * Exports the recommendation log and the snapshots of EVERY league in the store as JSON (plan 03
 * §8 step 3) to a NEW 0600 file, streaming row by row. The store file is read on its own read-only
 * connection, never through a migration: a store whose migration is pending, or one written by a
 * newer binary, exports its tables as they are. Throws when the store cannot be read or the file
 * cannot be written (the partial file is removed).
 */
export function exportStoreData(storeFile: string, dest: string, nowIso: string): ExportCounts {
  const db = new DatabaseSync(storeFile, { readOnly: true, timeout: 5_000 });
  try {
    const present = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: unknown;
        }[]
      )
        .map((r) => r.name)
        .filter((n): n is string => typeof n === "string"),
    );
    let schemaVersion: unknown = null;
    try {
      schemaVersion =
        (
          db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as
            { v?: unknown } | undefined
        )?.v ?? null;
    } catch {
      schemaVersion = null;
    }
    const counts = {} as Record<(typeof EXPORT_TABLES)[number], number | null>;
    for (const t of EXPORT_TABLES)
      counts[t] = present.has(t)
        ? Number((db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: unknown }).n)
        : null;
    const w = newPrivateWriter(dest);
    try {
      w.write(
        `{\n  "exported_at": ${JSON.stringify(nowIso)},\n  "schema_version": ${JSON.stringify(schemaVersion)},\n  "rows": ${JSON.stringify(counts)}`,
      );
      for (const t of EXPORT_TABLES) {
        w.write(`,\n  ${JSON.stringify(t)}: [`);
        if (present.has(t)) {
          let first = true;
          for (const row of db.prepare(`SELECT * FROM "${t}"`).iterate()) {
            w.write(`${first ? "\n    " : ",\n    "}${JSON.stringify(exportRow(row))}`);
            first = false;
          }
          if (!first) w.write("\n  ");
        }
        w.write("]");
      }
      w.write("\n}\n");
      w.close();
    } catch (e) {
      w.abort();
      throw e;
    }
    return counts;
  } finally {
    db.close();
  }
}

/** The config uninstall needs (the dirs, the credential file and what the store opener reads). */
export type UninstallConfig = Pick<
  LenientConfig,
  "cacheDir" | "configDir" | "credentialFile" | "weatherSource" | "fixtureRecord"
> & {
  /** Set when config.json could not be read: its issues (key + fixed reason, never a value). */
  readonly unreadableConfig?: readonly ConfigIssue[];
};

/**
 * The config of an uninstall whose config.json cannot be read (invalid JSON, a value of the wrong
 * type): the directories come from the environment alone — EFF_CONFIG_DIR / EFF_CACHE_DIR are
 * env-only keys — and the credential file is EFF_CREDENTIAL_FILE when set, else the default. A
 * custom credential file recorded only in the unreadable file is unknown, and uninstall says so.
 * Throws (a usage error upstream) only when the environment's own directory values are invalid.
 */
export function fallbackUninstallConfig(
  env: Env,
  home: string,
  issues: readonly ConfigIssue[],
): UninstallConfig {
  const configDir = resolveConfigDir(env, home);
  const fromEnv = env.EFF_CREDENTIAL_FILE?.trim();
  return {
    configDir,
    cacheDir: resolveCacheDir(env, home),
    credentialFile:
      fromEnv === undefined || fromEnv === ""
        ? defaultCredentialFilePath(configDir)
        : resolveAbsolute(fromEnv, home, "EFF_CREDENTIAL_FILE"),
    weatherSource: "open-meteo",
    fixtureRecord: false,
    unreadableConfig: issues,
  };
}

/** A value-free reason an export failed (a SQLite code name, a filesystem code, or the error name). */
function exportFailure(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z_]{2,40}$/.test(code)) {
    const errcode = (e as { errcode?: unknown }).errcode;
    return typeof errcode === "number" ? `${code} ${String(errcode & 0xff)}` : code;
  }
  return e instanceof Error && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : "error";
}

/** Options of `eff uninstall`. */
export interface UninstallOptions {
  readonly yes: boolean;
  readonly dryRun: boolean;
  readonly keepConfig: boolean;
  readonly exportLog: string | undefined;
  /** Test hooks (never reachable from argv). */
  readonly prompt?: TerminalPrompt;
  readonly factory?: StoreFactory;
}

/** `eff uninstall`. */
export async function uninstall(
  io: CliIo,
  config: UninstallConfig,
  log: Logger,
  opts: UninstallOptions,
): Promise<number> {
  const out = (l: string): Promise<void> => writeLine(io.stdout, l);
  const exportDest =
    opts.exportLog === undefined
      ? null
      : resolveBackupDestination(opts.exportLog, io.home, io.packageRoot, io.xattr);
  const cachePlan = purgePlan(config.cacheDir, CACHE_FILES, CACHE_DIRS, CACHE_FILE_PATTERNS);
  const configPlan = opts.keepConfig
    ? []
    : purgePlan(config.configDir, CONFIG_FILES, [], CONFIG_FILE_PATTERNS);
  const interactive = isTty(io.stdin);
  if (!opts.yes && !opts.dryRun && !interactive) {
    await writeLine(
      io.stderr,
      "eff uninstall: deletes your credentials and data; run it in a terminal (it asks each step) or pass --yes. Nothing was changed.",
    );
    return EXIT.usage;
  }
  const prompt =
    opts.yes || opts.dryRun
      ? null
      : (opts.prompt ?? createTerminalPrompt({ stdin: io.stdin, out: io.stdout }));
  const ask = async (q: string): Promise<boolean> =>
    opts.yes || (prompt !== null && (await prompt.confirm(q)));
  const prefix = opts.dryRun ? "would " : "";
  let failed = false;
  try {
    if (config.unreadableConfig !== undefined) {
      await out(
        `config.json could not be read (${config.unreadableConfig.map((i) => `${i.key}: ${i.reason}`).join("; ")}): uninstall continues with the directories from the environment.`,
      );
      await out(
        `  The credential file it removes is ${config.credentialFile}; a different EFF_CREDENTIAL_FILE recorded only in that config.json cannot be known here — delete it yourself if you set one.`,
      );
    }

    // 0. the export comes first: when it cannot be written, NOTHING is changed (plan 03 §8 step 3 —
    // the recommendation log cannot be rebuilt)
    if (exportDest !== null) {
      const file = storePath(config.cacheDir);
      if (kind(file) === null) await out("no store.sqlite — nothing recorded to export");
      else if (opts.dryRun)
        await out(`would export the recommendation log and snapshots to ${exportDest}`);
      else {
        try {
          const counts = exportStoreData(file, exportDest, io.clock.nowIso());
          const n = (t: (typeof EXPORT_TABLES)[number]): string => String(counts[t] ?? 0);
          await out(
            `exported ${n("recommendation_log")} recommendation(s) (${n("recommendation_outcome")} scored), ${n("roster_snapshot")} roster, ${n("pool_snapshot")} pool and ${n("scoreboard_snapshot")} scoreboard snapshot(s) and ${n("espn_projection")} ESPN projection row(s) to ${exportDest}`,
          );
        } catch (e) {
          await writeLine(
            io.stderr,
            `eff uninstall: the export failed (${exportFailure(e)}) — nothing was changed`,
          );
          return EXIT.error;
        }
      }
    }

    // 1. launchd: the jobs, then their log files
    if (io.platform === "darwin" && io.uid !== null) {
      const steps = await removeJobs({
        home: io.home,
        uid: io.uid,
        exec: io.exec,
        dryRun: opts.dryRun,
      });
      for (const s of steps)
        await out(`${prefix}${s.kind === "remove" ? "remove" : "launchctl"} ${s.detail}`);
      if (steps.length === 0) await out("no launchd jobs of ours are installed");
    } else await out("launchd: not available on this platform — nothing to boot out");
    const logs = jobLogPlan(io.home).filter((p) => p.action !== "keep");
    if (opts.dryRun)
      for (const p of logs)
        await out(`would delete ${p.path}${p.action === "rmdir" ? " (if empty)" : ""}`);
    else if (logs.length > 0) {
      const r = executePurge(logs);
      for (const p of r.removed) await out(`deleted ${p}`);
      for (const p of r.kept) await out(`kept (not empty or not removable) ${p}`);
    }

    // 2. credentials — both stores, always
    if (opts.dryRun)
      await out(
        "would delete the keychain items (espn_s2, SWID, meta) AND session.json, plus any self-test item",
      );
    else if (await ask("Delete the stored ESPN cookies (keychain items AND session.json)?")) {
      const stores = bothCredentialStores(io, config);
      const ex = openExistingStore(config, io.clock, log, opts.factory);
      try {
        const r = await removeAllCredentials({
          keychain: stores.keychain,
          file: stores.file,
          deleteSelftestItem: selftestItemDeleter(KEYCHAIN_SERVICE, io.loadKeyring),
          credentialState: ex.kind === "open" ? ex.store.repos.credentialState : null,
        });
        await out(
          `credentials: keychain ${r.keychain}, session.json ${r.file}, self-test item ${r.selftestItem}, state ${r.credentialState}`,
        );
        if (!r.ok) failed = true;
      } finally {
        if (ex.kind === "open") ex.store.close();
      }
    } else await out("kept the stored cookies");

    // 3. the cache (already exported when asked — step 0)
    const deleting = cachePlan.filter((p) => p.action !== "keep");
    if (opts.dryRun) {
      for (const p of deleting)
        await out(`would delete ${p.path}${p.action === "rmdir" ? " (if empty)" : ""}`);
    } else if (
      deleting.length > 0 &&
      (await ask(
        `Delete the cache ${config.cacheDir} (store with the recommendation log, datasets, backups, raw recordings)?`,
      ))
    ) {
      const r = executePurge(deleting);
      for (const p of r.removed) await out(`deleted ${p}`);
      for (const p of r.kept) await out(`kept (not empty or not removable) ${p}`);
    } else if (deleting.length > 0) await out(`kept your data: ${config.cacheDir}`);
    for (const p of cachePlan)
      if (p.action === "keep") await out(`kept (not ours: ${p.reason}) ${p.path}`);

    // 4. the config dir
    const cfgDeleting = configPlan.filter((p) => p.action !== "keep");
    if (opts.keepConfig) await out(`kept your config: ${config.configDir}`);
    else if (opts.dryRun)
      for (const p of cfgDeleting)
        await out(`would delete ${p.path}${p.action === "rmdir" ? " (if empty)" : ""}`);
    else if (
      cfgDeleting.length > 0 &&
      (await ask(`Delete the config ${config.configDir} (config.json)?`))
    ) {
      const r = executePurge(cfgDeleting);
      for (const p of r.removed) await out(`deleted ${p}`);
      for (const p of r.kept) await out(`kept (not empty or not removable) ${p}`);
    } else if (cfgDeleting.length > 0) await out(`kept your config: ${config.configDir}`);

    // 5–6. what uninstall never does itself
    await out("");
    await out("Not done automatically (do these yourself):");
    for (const s of manualSteps(io.home)) await out(`  - ${s}`);
    return failed ? EXIT.error : EXIT.ok;
  } finally {
    prompt?.close();
  }
}
