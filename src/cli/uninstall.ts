// uninstall.ts — `eff uninstall [--yes] [--dry-run] [--keep-config] [--export-log <path>]` (plan 03
// L8, §8): (1) boot out and delete our LaunchAgents; (2) delete BOTH the keychain items and
// session.json — always, whichever store config.json records (a stale second copy must never survive
// — ADV OBJ-05) — plus a leftover self-test item, saying that Time Machine may hold copies and that
// the ESPN session itself is NOT invalidated; (3) delete the cache (store, datasets, backups, temp)
// after an optional `--export-log` of the recommendation log as JSON; (4) ask before deleting the
// config dir; (5) print — never edit — the client-config entry to remove, `claude mcp remove`, the
// ESPN "log out everywhere" pointer and `npm uninstall -g`. Interactive: every destructive step asks
// y/N on a terminal; `--yes` answers yes; without a terminal and without `--yes` nothing changes.
// Deletion is by exact known name; a directory is removed only when empty afterwards.
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
import { selftestItemDeleter } from "../auth/stores.js";
import { removeAllCredentials } from "../auth/uninstall.js";
import { KEYCHAIN_SERVICE } from "../auth/types.js";
import {
  BACKUP_DIR_NAME,
  CONFIG_FILE_NAME,
  DATASET_DIR_NAME,
  ensureSecureDir,
  GATE_KEY_FILE_NAME,
  PathSecurityError,
  RUN_TEMP_DIR_NAME,
  STORE_FILE_NAME,
} from "../config/paths.js";
import type { LenientConfig } from "../config/schema.js";
import type { Store, StoreFactory } from "../store/types.js";
import { bothCredentialStores } from "./espn-stack.js";
import { EXIT } from "./exit.js";
import { isTty, writeLine, type CliIo } from "./io.js";
import { JOB_STATE_FILE } from "./job-state.js";
import { removeJobs } from "./launchd.js";
import type { Logger } from "./log.js";
import { resolveBackupDestination } from "./maintenance.js";
import { codeConfigPath, desktopConfigPath, SERVER_NAME } from "./print-config.js";
import { createTerminalPrompt, type TerminalPrompt } from "./prompt.js";
import { errorText, openExistingStore } from "./store-access.js";

/** Plain files of ours directly inside the cache dir. */
const CACHE_FILES = [
  STORE_FILE_NAME,
  `${STORE_FILE_NAME}-wal`,
  `${STORE_FILE_NAME}-shm`,
  `${STORE_FILE_NAME}-journal`,
  `${STORE_FILE_NAME}.lock`,
  JOB_STATE_FILE,
];
/** A run directory under tmp/ (mkdtemp: `<prefix>-XXXXXX`). */
const RUN_TMP_RE = /^[A-Za-z0-9_]{1,80}-[A-Za-z0-9]{6}$/;
/** Directories of ours inside the cache dir, emptied by pattern. */
const CACHE_DIRS: readonly { readonly name: string; readonly re: RegExp }[] = [
  {
    name: DATASET_DIR_NAME,
    re: /^[a-z][a-z0-9_]*__[a-z][a-z0-9_]*(?:\.sqlite(?:-journal|-wal|-shm)?|\..*\.tmp(?:-journal)?)$/,
  },
  {
    name: BACKUP_DIR_NAME,
    re: /^store(?:-\d{4}-\d{2}-\d{2}(?:-\d{1,16})?\.sqlite|\.sqlite\.bak-v\d+(?:-\d+)?)$/,
  },
  { name: RUN_TEMP_DIR_NAME, re: RUN_TMP_RE },
];
/** Plain files of ours inside the config dir (session.json is removed by the credential step). */
const CONFIG_FILES = [CONFIG_FILE_NAME, GATE_KEY_FILE_NAME];

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
  dirs: readonly { readonly name: string; readonly re: RegExp }[],
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
      if (d.name !== RUN_TEMP_DIR_NAME) {
        if (k === "file" || k === "symlink") out.push({ path: p, action: "unlink" });
      } else if (k === "dir" && isOwnRunDir(p)) out.push({ path: p, action: "rmtree" });
      else out.push({ path: p, action: "keep", reason: "not a run directory this program made" });
    }
    out.push({ path: sub, action: "rmdir" });
  }
  for (const f of files) {
    const p = path.join(dir, f);
    const k = kind(p);
    if (k === "file" || k === "symlink") out.push({ path: p, action: "unlink" });
  }
  out.push({ path: dir, action: "rmdir" });
  return out;
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

/** Writes a NEW 0600 JSON file (O_EXCL, never follows a symlink). */
function writeNewPrivateFile(dest: string, text: string): void {
  const fd = openSync(dest, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
  try {
    const b = Buffer.from(text, "utf8");
    let off = 0;
    while (off < b.length) off += writeSync(fd, b, off, b.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Exports the recommendation log (records + scored outcomes) as JSON (plan 03 §8 step 3). */
export function exportLog(
  store: Store,
  leagueId: string | null,
  dest: string,
  nowIso: string,
): number {
  const items: unknown[] = [];
  if (leagueId !== null) {
    for (let offset = 0; offset < 1_000_000; offset += 100) {
      const page = store.repos.recommendationLog.list({
        league_id: leagueId,
        season: null,
        week: null,
        kind: null,
        limit: 100,
        offset,
      });
      for (const it of page.items)
        items.push({
          record: store.repos.recommendationLog.get(it.log_id),
          outcome: store.repos.recommendationLog.outcome(it.log_id),
        });
      if (page.items.length < 100) break;
    }
  }
  writeNewPrivateFile(
    dest,
    `${JSON.stringify({ exported_at: nowIso, recommendation_log: items }, null, 2)}\n`,
  );
  return items.length;
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
  config: LenientConfig,
  log: Logger,
  opts: UninstallOptions,
): Promise<number> {
  const out = (l: string): Promise<void> => writeLine(io.stdout, l);
  const exportDest =
    opts.exportLog === undefined
      ? null
      : resolveBackupDestination(opts.exportLog, io.home, io.packageRoot);
  const cachePlan = purgePlan(config.cacheDir, CACHE_FILES, CACHE_DIRS);
  const configPlan = opts.keepConfig ? [] : purgePlan(config.configDir, CONFIG_FILES, []);
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
    // 1. launchd
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

    // 3. the cache (after an optional export of the recommendation log)
    if (exportDest !== null && !opts.dryRun) {
      const ex = openExistingStore(config, io.clock, log, opts.factory);
      try {
        if (ex.kind === "open") {
          const n = exportLog(ex.store, config.leagueId, exportDest, io.clock.nowIso());
          await out(`exported ${String(n)} recommendation(s) to ${exportDest}`);
        } else await out("no store to export from");
      } catch (e) {
        await writeLine(
          io.stderr,
          `eff uninstall: the export failed (${errorText(e)}) — nothing else was deleted`,
        );
        return EXIT.error;
      } finally {
        if (ex.kind === "open") ex.store.close();
      }
    }
    const deleting = cachePlan.filter((p) => p.action !== "keep");
    if (opts.dryRun) {
      for (const p of deleting)
        await out(`would delete ${p.path}${p.action === "rmdir" ? " (if empty)" : ""}`);
    } else if (
      deleting.length > 0 &&
      (await ask(
        `Delete the cache ${config.cacheDir} (store with the recommendation log, datasets, backups)?`,
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
