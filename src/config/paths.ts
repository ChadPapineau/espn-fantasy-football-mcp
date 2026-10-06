// paths.ts — the one config dir and one cache dir (plan 01 D16, §5.1; plan 02 §2.2; plan 03 §1.1
// step 1), absolute-path assertions, 0700/0600 helpers that refuse symlinks and group/other bits,
// and the file-provider (iCloud) xattr refusal (plan 02 §2.2 "iCloud check", §8 #7; plan 03 §5 #4).
// Ported from sibling @d72e03b, adapted: no $XDG_* (plan 01 D16, changelog G2), ESPN file names,
// the xattr check, control characters refused. Symlinks are never followed for the dirs or for any
// file opened here; files open O_NONBLOCK (a planted FIFO cannot stall startup).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsc,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The directory name under `~/.config` and `~/.cache` (plan 01 D16). */
export const APP_DIR_NAME = "espn-fantasy-football-mcp";
/** The store file inside the cache dir (plan 01 §5.1). */
export const STORE_FILE_NAME = "store.sqlite";
/** The per-source dataset directory inside the cache dir: `datasets/<source>.sqlite` (plan 01 §5.1). */
export const DATASET_DIR_NAME = "datasets";
/** Pre-migration and weekly backups inside the cache dir (plan 03 §7, plan 06 §1.3). */
export const BACKUP_DIR_NAME = "backups";
/** Per-run temp directories inside the cache dir (`eff refresh` downloads). */
export const RUN_TEMP_DIR_NAME = "tmp";
/** The non-secret config file inside the config dir (plan 03 §3). */
export const CONFIG_FILE_NAME = "config.json";
/** The credential file-store fallback inside the config dir (plan 02 §2.2; `.env.example`). */
export const SESSION_FILE_NAME = "session.json";
/**
 * PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; owner decision D11). The confirmation gate's
 * 0600 HMAC key (plan 02 S7, §4.3). Nothing in this build creates or reads it.
 */
export const GATE_KEY_FILE_NAME = "gate_key";
/** Largest file `readSecureFile` reads by default (config.json, session.json): 1 MiB. */
export const MAX_SECURE_FILE_BYTES = 1024 * 1024;

/** Why a path was refused. */
export type PathRefusal =
  | "empty"
  | "control_char"
  | "relative"
  | "home_user_form"
  | "inside_repo"
  | "synced_folder"
  | "file_provider"
  | "xattr_unverifiable"
  | "symlink"
  | "not_directory"
  | "not_regular_file"
  | "insecure_mode"
  | "wrong_owner"
  | "too_large"
  | "insecure_ancestor"
  | "missing";

const REFUSAL_TEXT: Readonly<Record<PathRefusal, string>> = Object.freeze({
  empty: "path is empty",
  control_char: "path contains a control character",
  relative: "path must be absolute (or start with ~/)",
  home_user_form: "the ~user form is not supported; use ~/ or an absolute path",
  inside_repo:
    "path is inside the repository checkout; config, cache and credentials must live outside it",
  synced_folder:
    "path is inside a cloud-synced folder (Documents, Desktop, iCloud Drive, CloudStorage); use ~/.config or ~/.cache",
  file_provider:
    "path is managed by a file provider (iCloud or another sync client); use a non-synced directory such as ~/.config or ~/.cache",
  xattr_unverifiable:
    "could not check whether the directory is managed by a file provider; refusing (run `eff doctor`)",
  symlink: "refusing to follow a symbolic link",
  not_directory: "exists but is not a directory",
  not_regular_file: "exists but is not a regular file",
  insecure_mode:
    "group/other permission bits are set (directories must be 0700, files 0600); run `eff doctor --fix`",
  wrong_owner: "is not owned by the current user",
  too_large: "file is larger than the allowed maximum",
  insecure_ancestor:
    "a parent directory is writable by group/other without the sticky bit, so the directory could be swapped; fix the parent's permissions",
  missing: "does not exist",
});

/**
 * A path failed a safety rule. Startup reports `detail` and exits 2; inside a tool call it maps to
 * INTERNAL (`effCode`), never VALIDATION — the model's arguments are not at fault.
 */
export class PathSecurityError extends Error {
  /** Cross-layer error code (plan 01 §4.3): an operator/environment problem. */
  readonly effCode = "INTERNAL" as const;
  /** Which rule refused the path. */
  readonly reason: PathRefusal;
  /** The offending path — local diagnostics only (`eff doctor`); never put in a tool result. */
  readonly path: string;
  /** The fixed reason text without the path — safe to show anywhere (`ConfigIssue.reason`). */
  readonly detail: string;
  constructor(reason: PathRefusal, p: string, what: string) {
    super(`${what}: ${REFUSAL_TEXT[reason]}`);
    this.name = "PathSecurityError";
    this.reason = reason;
    this.path = p;
    this.detail = REFUSAL_TEXT[reason];
  }
}

/** A minimal environment view (process.env shape). */
export type Env = Readonly<Record<string, string | undefined>>;

/** Control characters: C0 and DEL. */
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Expands a leading `~` / `~/` against `home`; rejects `~user`. Other strings pass unchanged. */
export function expandHome(p: string, home: string, what = "path"): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  if (p.startsWith("~")) throw new PathSecurityError("home_user_form", p, what);
  return p;
}

/**
 * Resolves a user-supplied path to a normalised absolute path: `~` expanded, `.`/`..` collapsed,
 * trailing separators dropped. Relative paths, empty strings and control characters (NUL, newline —
 * a path with a newline could forge a line in any line-oriented tool output) are refused.
 */
export function resolveAbsolute(p: string, home: string, what = "path"): string {
  if (p.length === 0) throw new PathSecurityError("empty", p, what);
  if (CONTROL_RE.test(p)) throw new PathSecurityError("control_char", "<redacted>", what);
  const expanded = expandHome(p, home, what);
  if (!path.isAbsolute(expanded)) throw new PathSecurityError("relative", p, what);
  return path.resolve(expanded);
}

function envValue(env: Env, key: string): string | undefined {
  const v = env[key];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

/**
 * The config dir: `EFF_CONFIG_DIR`, else `~/.config/espn-fantasy-football-mcp`. `$XDG_CONFIG_HOME`
 * is deliberately NOT read — every entry point (server, CLI, launchd jobs) must agree on one
 * location (plan 01 D16; changelog G2). Absolute; repo/sync/xattr checks are separate.
 */
export function resolveConfigDir(env: Env, home: string): string {
  const override = envValue(env, "EFF_CONFIG_DIR");
  if (override !== undefined) return resolveAbsolute(override, home, "EFF_CONFIG_DIR");
  return path.join(home, ".config", APP_DIR_NAME);
}

/** The cache dir: `EFF_CACHE_DIR`, else `~/.cache/espn-fantasy-football-mcp` (no XDG, plan 01 D16). */
export function resolveCacheDir(env: Env, home: string): string {
  const override = envValue(env, "EFF_CACHE_DIR");
  if (override !== undefined) return resolveAbsolute(override, home, "EFF_CACHE_DIR");
  return path.join(home, ".cache", APP_DIR_NAME);
}

/** The package root: two levels above this module in both layouts (`src/config`, `dist/config`). */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Whether `child` equals `parent` or lies beneath it (pure path arithmetic, no I/O). */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolves symlinks in the longest existing prefix of `p` and re-appends the rest, so a path whose
 * parent is a symlink into the repo is still caught. Never throws for a missing path. The native
 * realpath(3) also returns the on-disk spelling on macOS (case, Unicode form).
 */
export function realpathOfExistingPrefix(p: string): string {
  let head = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(head), ...tail.reverse());
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return path.resolve(p);
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

/**
 * The comparison key of a path on `platform`'s default filesystem: macOS volumes are case- and
 * normalisation-insensitive by default; elsewhere byte for byte. Folding can only over-refuse.
 */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? p.normalize("NFC").toLowerCase() : p;
}

/** `isInside` under the filesystem's notion of "the same name" (see `pathKey`). */
export function isInsideOnFs(
  child: string,
  parent: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return isInside(pathKey(child, platform), pathKey(parent, platform));
}

function spellings(p: string): string[] {
  return [path.resolve(p), realpathOfExistingPrefix(p)];
}

/** Throws `inside_repo` when `p` (or what its existing prefix resolves to) is inside `repoRoot`. */
export function assertOutsideRepo(p: string, repoRoot: string, what = "path"): void {
  const roots = spellings(repoRoot);
  if (spellings(p).some((c) => roots.some((r) => isInsideOnFs(c, r)))) {
    throw new PathSecurityError("inside_repo", p, what);
  }
}

/** The cloud-synced folders under a macOS home (iCloud, CloudStorage, desktop sync clients). */
export function syncedFolders(home: string): readonly string[] {
  let oneDrives: string[] = [];
  try {
    oneDrives = readdirSync(home)
      .filter((n) => n.startsWith("OneDrive") && n !== "OneDrive")
      .map((n) => path.join(home, n));
  } catch {
    // no readable home: the fixed names still apply
  }
  return [
    path.join(home, "Documents"),
    path.join(home, "Desktop"),
    path.join(home, "Library", "Mobile Documents"),
    path.join(home, "Library", "CloudStorage"),
    path.join(home, "Dropbox"),
    path.join(home, "Google Drive"),
    path.join(home, "OneDrive"),
    ...oneDrives.sort(),
  ];
}

/** Throws `synced_folder` when `p` lies in a cloud-synced folder by name. */
export function assertNotSynced(p: string, home: string, what = "path"): void {
  const bases = syncedFolders(home).flatMap(spellings);
  if (spellings(p).some((c) => bases.some((b) => isInsideOnFs(c, b)))) {
    throw new PathSecurityError("synced_folder", p, what);
  }
}

// --- file-provider xattr check (plan 02 §2.2; plan 03 §5 #4, #5) -----------------------------------

/**
 * Extended attributes that mark a file-provider (iCloud Drive, CloudStorage clients) managed item:
 * `com.apple.file-provider-domain-id`, `com.apple.fileprovider.*`, `com.apple.icloud.*`.
 */
export const FILE_PROVIDER_XATTR_RE = /^com\.apple\.(?:file-?provider[.-]|icloud\.)/i;

/** The extended-attribute names of each existing path, or null when they could not be read. */
export type XattrReader = (
  paths: readonly string[],
) => ReadonlyMap<string, readonly string[]> | null;

/** The macOS `xattr` binary (argument-array spawn, never a shell). */
export const XATTR_BIN = "/usr/bin/xattr";

/**
 * Parses `xattr p1 p2 …` output: with one path each line is an attribute name; with several each
 * line is `<path>: <name>` and the longest matching path wins (paths carry no control characters).
 */
export function parseXattrOutput(
  paths: readonly string[],
  stdout: string,
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>(paths.map((p) => [p, []]));
  const byLength = [...paths].sort((a, b) => b.length - a.length);
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    if (line === "") continue;
    if (paths.length === 1) {
      out.get(paths[0] ?? "")?.push(line);
      continue;
    }
    const owner = byLength.find((p) => line.startsWith(`${p}: `));
    if (owner !== undefined) out.get(owner)?.push(line.slice(owner.length + 2));
  }
  return out;
}

/**
 * The system reader: on macOS one `xattr` spawn for all paths (bounded: 2 s, 256 KiB); elsewhere
 * no file-provider attributes exist, so every path maps to `[]`. Null when the spawn failed.
 */
export const systemXattrReader: XattrReader = (paths) => {
  if (paths.length === 0) return new Map();
  if (process.platform !== "darwin") return new Map(paths.map((p) => [p, []]));
  const r = spawnSync(XATTR_BIN, [...paths], {
    encoding: "utf8",
    shell: false,
    timeout: 2000,
    maxBuffer: 256 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (r.error !== undefined || r.status !== 0 || typeof r.stdout !== "string") return null;
  return parseXattrOutput(paths, r.stdout);
};

/**
 * The existing directories a file-provider check must look at for `target`: the target's longest
 * existing prefix (resolved) always, then each ancestor up to — not including — `home` (or the
 * filesystem root when the target is outside `home`). Nearest first.
 */
export function xattrCheckChain(target: string, home: string): string[] {
  let cur = realpathOfExistingPrefix(target);
  while (lstatOrNull(cur) === null) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const homeReal = realpathOfExistingPrefix(home);
  const stopAt = isInsideOnFs(cur, homeReal) ? homeReal : path.parse(cur).root;
  const chain: string[] = [cur];
  if (pathKey(cur) === pathKey(stopAt)) return chain;
  for (let parent = path.dirname(cur); parent !== cur; parent = path.dirname(cur)) {
    if (pathKey(parent) === pathKey(stopAt)) break;
    chain.push(parent);
    cur = parent;
  }
  return chain;
}

/** One offending attribute: the directory and the attribute name (never a value). */
export interface FileProviderMark {
  readonly path: string;
  readonly attr: string;
}

/**
 * File-provider marks on `target`'s chain (see `xattrCheckChain`). Throws `xattr_unverifiable`
 * when the reader fails — fail closed: a secret must never land in a directory we could not check.
 */
export function fileProviderMarks(
  target: string,
  home: string,
  reader: XattrReader = systemXattrReader,
  what = "path",
): FileProviderMark[] {
  const chain = xattrCheckChain(target, home);
  const attrs = reader(chain);
  if (attrs === null) throw new PathSecurityError("xattr_unverifiable", target, what);
  const marks: FileProviderMark[] = [];
  for (const p of chain) {
    for (const a of attrs.get(p) ?? [])
      if (FILE_PROVIDER_XATTR_RE.test(a)) marks.push({ path: p, attr: a });
  }
  return marks;
}

/** Throws `file_provider` when `target` or an ancestor below `home` carries a file-provider xattr. */
export function assertNotFileProvider(
  target: string,
  home: string,
  reader: XattrReader = systemXattrReader,
  what = "path",
): void {
  if (fileProviderMarks(target, home, reader, what).length > 0)
    throw new PathSecurityError("file_provider", target, what);
}

/** Options of `assertSafeLocation`. */
export interface LocationGuardOptions {
  readonly home: string;
  readonly repoRoot: string;
  readonly xattr?: XattrReader;
  readonly what?: string;
}

/**
 * The full location rule for config, cache and credential paths: outside the repository, not in a
 * synced folder by name, and no file-provider xattr on the chain (plan 01 D16; plan 02 §2.2).
 * Every failure is collected; returns the refusals (empty = safe).
 */
export function locationRefusals(p: string, opts: LocationGuardOptions): PathSecurityError[] {
  const what = opts.what ?? "path";
  const out: PathSecurityError[] = [];
  const attempt = (fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      if (e instanceof PathSecurityError) out.push(e);
      else out.push(new PathSecurityError("xattr_unverifiable", p, what));
    }
  };
  attempt(() => {
    assertOutsideRepo(p, opts.repoRoot, what);
  });
  attempt(() => {
    assertNotSynced(p, opts.home, what);
  });
  attempt(() => {
    assertNotFileProvider(p, opts.home, opts.xattr ?? systemXattrReader, what);
  });
  return out;
}

// --- derived locations ------------------------------------------------------------------------

/** `<cache>/store.sqlite`. */
export function storePath(cacheDir: string): string {
  return path.join(cacheDir, STORE_FILE_NAME);
}
/** `<cache>/datasets/`. */
export function datasetDir(cacheDir: string): string {
  return path.join(cacheDir, DATASET_DIR_NAME);
}
/** `<cache>/backups/`. */
export function backupDir(cacheDir: string): string {
  return path.join(cacheDir, BACKUP_DIR_NAME);
}
/** `<cache>/tmp/` — refresh run temp dirs. */
export function runTempDir(cacheDir: string): string {
  return path.join(cacheDir, RUN_TEMP_DIR_NAME);
}
/** `<config>/config.json`. */
export function configFilePath(configDir: string): string {
  return path.join(configDir, CONFIG_FILE_NAME);
}
/** `<config>/session.json` — the default `EFF_CREDENTIAL_FILE` (plan 02 §2.2). */
export function defaultCredentialFilePath(configDir: string): string {
  return path.join(configDir, SESSION_FILE_NAME);
}
/** PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; D11). `<config>/gate_key`; never created today. */
export function gateKeyPath(configDir: string): string {
  return path.join(configDir, GATE_KEY_FILE_NAME);
}

/** A dataset source id: `<provider>:<dataset>`, lowercase ASCII, digits, `_`. */
export const SOURCE_ID_RE = /^[a-z][a-z0-9_]{0,31}:[a-z][a-z0-9_]{0,47}$/;

function checkSourceId(sourceId: string): void {
  if (!SOURCE_ID_RE.test(sourceId)) throw new RangeError("paths: invalid dataset source id");
}

/** File stem for a source's dataset: `nflverse:stats_player_week` → `nflverse__stats_player_week`. */
export function datasetFileStem(sourceId: string): string {
  checkSourceId(sourceId);
  return sourceId.replace(":", "__");
}

/** `<cache>/datasets/<stem>.sqlite` — the published, immutable dataset file (plan 01 §5.5). */
export function datasetFilePath(cacheDir: string, sourceId: string): string {
  return path.join(datasetDir(cacheDir), `${datasetFileStem(sourceId)}.sqlite`);
}

/** `<cache>/datasets/<stem>.<version>.<rand>.tmp` — the staging file `eff refresh` renames. */
export function datasetTempPath(cacheDir: string, sourceId: string, version: string): string {
  const safe = version.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "v";
  return path.join(
    datasetDir(cacheDir),
    `${datasetFileStem(sourceId)}.${safe}.${randomBytes(6).toString("hex")}.tmp`,
  );
}

// --- 0700 / 0600 filesystem helpers ------------------------------------------------------------

const GROUP_OTHER = 0o077;

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch (e) {
    if (
      (e as NodeJS.ErrnoException).code === "ENOENT" ||
      (e as NodeJS.ErrnoException).code === "ENOTDIR"
    )
      return null;
    throw e;
  }
}

function checkOwnerAndMode(st: Stats, p: string, what: string): void {
  const uid = currentUid();
  if (uid !== null && st.uid !== uid) throw new PathSecurityError("wrong_owner", p, what);
  if ((st.mode & GROUP_OTHER) !== 0) throw new PathSecurityError("insecure_mode", p, what);
}

/**
 * Every existing ancestor of `dir` (nearest first, `dir` excluded) writable by group/other WITHOUT
 * the sticky bit — a directory in which someone else could rename ours away (ssh StrictModes).
 * Both the spelled chain and the resolved chain are walked.
 */
export function insecureAncestors(dir: string): string[] {
  const out: string[] = [];
  const walk = (start: string): void => {
    let cur = path.dirname(start);
    for (;;) {
      let st: Stats | null = null;
      try {
        st = statSync(cur);
      } catch {
        st = null;
      }
      if (
        st?.isDirectory() === true &&
        (st.mode & 0o022) !== 0 &&
        (st.mode & 0o1000) === 0 &&
        !out.includes(cur)
      )
        out.push(cur);
      const parent = path.dirname(cur);
      if (parent === cur) return;
      cur = parent;
    }
  };
  const abs = path.resolve(dir);
  walk(abs);
  const real = realpathOfExistingPrefix(abs);
  if (real !== abs) walk(real);
  return out;
}

/**
 * Asserts `dir` is a real (non-symlink) directory owned by this user with no group/other bits and
 * no insecure ancestor. With `create`, a missing directory is created 0700 (parents too). An
 * existing directory with bad bits is refused, never silently chmod-ed (`eff doctor --fix`).
 */
export function ensureSecureDir(dir: string, opts: { create: boolean; what?: string }): void {
  const what = opts.what ?? "directory";
  let st = lstatOrNull(dir);
  if (st === null) {
    if (!opts.create) throw new PathSecurityError("missing", dir, what);
    if (insecureAncestors(dir).length > 0)
      throw new PathSecurityError("insecure_ancestor", dir, what);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    st = lstatSync(dir);
  }
  if (st.isSymbolicLink()) throw new PathSecurityError("symlink", dir, what);
  if (!st.isDirectory()) throw new PathSecurityError("not_directory", dir, what);
  checkOwnerAndMode(st, dir, what);
  if (insecureAncestors(dir).length > 0)
    throw new PathSecurityError("insecure_ancestor", dir, what);
}

/** Asserts `file` is a real (non-symlink) regular file owned by this user with no group/other bits. */
export function assertSecureFile(file: string, what = "file"): void {
  const st = lstatOrNull(file);
  if (st === null) throw new PathSecurityError("missing", file, what);
  if (st.isSymbolicLink()) throw new PathSecurityError("symlink", file, what);
  if (!st.isFile()) throw new PathSecurityError("not_regular_file", file, what);
  checkOwnerAndMode(st, file, what);
}

/**
 * Reads a file opened `O_NOFOLLOW | O_NONBLOCK` and checked on the open descriptor (no TOCTOU; a
 * FIFO is refused as `not_regular_file`). `requirePrivate` enforces 0600-or-stricter and ownership
 * (session.json); config.json passes false (plan 03 §3: no secrets allowed in it). Null when absent.
 */
export function readSecureFile(
  file: string,
  opts: { requirePrivate: boolean; maxBytes?: number; what?: string },
): string | null {
  const what = opts.what ?? "file";
  const max = opts.maxBytes ?? MAX_SECURE_FILE_BYTES;
  let fd: number;
  try {
    fd = openSync(file, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP" || code === "EMLINK") throw new PathSecurityError("symlink", file, what);
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new PathSecurityError("not_regular_file", file, what);
    if (opts.requirePrivate) checkOwnerAndMode(st, file, what);
    if (st.size > max) throw new PathSecurityError("too_large", file, what);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Atomically writes a 0600 file (plan 02 §2.2 "Write"): `<file>.<pid>.<rand>.tmp` opened `wx`
 * (exclusive, never follows a pre-placed symlink), written, fsynced, renamed over the target, then
 * the directory is fsynced. The parent must already pass `ensureSecureDir`. On failure the temp
 * file is removed and the previous target is untouched.
 */
export function writeSecureFileAtomic(
  file: string,
  data: string | Uint8Array,
  what = "file",
): void {
  const dir = path.dirname(file);
  ensureSecureDir(dir, { create: false, what: `${what} directory` });
  const target = lstatOrNull(file);
  if (target?.isSymbolicLink() === true) throw new PathSecurityError("symlink", file, what);
  const tmp = `${file}.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "wx", 0o600);
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, file);
  } catch (e) {
    if (fd !== null) closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  const dfd = openSync(dir, fsc.O_RDONLY);
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
}
