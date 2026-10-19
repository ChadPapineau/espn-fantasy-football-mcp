// guards.ts — refusals that run before any request or write: no cookie material anywhere in the
// recorder's environment or arguments (CLAUDE.md "Security": no live request to ESPN carries a
// cookie in recording; plan 05 §3.1 keyless recording), and raw captures only OUTSIDE the repo,
// outside ANY git working tree (research 03 §F.3: "raw captures kept outside the repo") and under
// the same location rule as the product's own cache, config and backups (src/config/paths.ts
// locationRefusals — plan 01 D16, plan 02 §2.2): never a cloud-synced folder, never a directory a
// file provider manages. The path checks are src/config/paths.ts's (S7): realpath(3) of the
// existing prefix and, on macOS's case- and normalisation-insensitive volumes, NFC + lower-case
// folding before the comparison.
import { homedir } from "node:os";
import path from "node:path";
import {
  PathSecurityError,
  gitWorkTreeOf,
  isInsideOnFs,
  locationRefusals,
  realpathOfExistingPrefix,
  resolveCacheDir,
  type PathRefusal,
  type XattrReader,
} from "../../src/config/paths.js";

/**
 * The directory under the cache dir that holds the raw runs. `eff uninstall` purges
 * `<cache dir>/recordings/<YYYY-MM-DD>` and `recordings/history-<YYYY-MM-DD>` (src/cli/uninstall.ts
 * RECORDINGS_DIR_NAME; tests/fixtures/recorder.test.ts holds the two together).
 */
export const RECORDINGS_DIR_NAME = "recordings";

/**
 * The default raw-capture directory of a run: `<cache dir>/recordings/<run>`, the cache dir resolved
 * exactly as the product resolves it (EFF_CACHE_DIR, else ~/.cache/espn-fantasy-football-mcp —
 * src/config/paths.ts resolveCacheDir), so the uninstall that purges `<cache dir>/recordings` removes
 * it whatever EFF_CACHE_DIR says (Stage C finding uninstall-recordings-override-path: the tools
 * always wrote under ~/.cache while uninstall purged only EFF_CACHE_DIR's). Throws a
 * PathSecurityError for an EFF_CACHE_DIR the product itself would refuse (relative, `~user`, …).
 */
export function defaultRawDir(env: NodeJS.ProcessEnv, home: string, run: string): string {
  return path.join(resolveCacheDir(env, home), RECORDINGS_DIR_NAME, run);
}

/** The fixed reason of a refused EFF_CACHE_DIR (never the value). */
export function cacheDirRefusalMessage(e: unknown): string {
  return `EFF_CACHE_DIR: ${e instanceof PathSecurityError ? e.detail : "cannot be resolved"}`;
}

/** Names that mean "a cookie or credential is configured" (env var names, argument text). */
const COOKIE_NAME = /espn[_-]?s2|\bswid\b|(?:^|[_-])swid(?:$|[_-])|cookie|set-cookie/i;
/** Values that carry cookie material whatever the variable is called. */
const COOKIE_VALUE =
  /espn[_-]?s2\s*=|\bswid\s*=|%7B[0-9A-F]{8}-|^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/i;

/**
 * The NAMES (never the values) of environment variables and the POSITIONS of arguments that carry
 * cookie material. Empty means the run may proceed keyless.
 */
export function findCookieMaterial(env: NodeJS.ProcessEnv, argv: readonly string[]): string[] {
  const hits: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value === "") continue;
    if (COOKIE_NAME.test(name) || COOKIE_VALUE.test(value))
      hits.push(`environment variable ${name}`);
  }
  argv.forEach((a, i) => {
    if (COOKIE_NAME.test(a) || COOKIE_VALUE.test(a) || /^--cookies?$/.test(a))
      hits.push(`argument #${String(i + 1)}`);
  });
  return hits;
}

/**
 * True when `dir` is `root` or anywhere inside it: symlinks in the existing prefix resolved with
 * realpath(3) (which also returns the on-disk spelling), compared under the filesystem's notion of
 * "the same name" — a case-changed spelling of the repo is inside it on macOS (S7).
 */
export function isInside(
  dir: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return isInsideOnFs(realpathOfExistingPrefix(dir), realpathOfExistingPrefix(root), platform);
}

/** Why a raw-capture directory is refused (the location rules of src/config/paths.ts). */
export type RawDirRefusal = "inside_repo" | "inside_git_work_tree" | PathRefusal;

/** Injectable parts of the raw-directory check (tests); each defaults to the real machine. */
export interface RawDirGuardOptions {
  /** The home whose synced folders are refused (default: os.homedir()). */
  readonly home?: string;
  /** The extended-attribute reader of the file-provider check (default: the system reader). */
  readonly xattr?: XattrReader;
  /** The `.git` probe of the work-tree walk (default: an lstat of `<dir>/.git`). */
  readonly gitEntry?: (dir: string) => boolean;
}

/**
 * Why a raw-capture directory is refused, or null. Raw captures hold the probe leagues' real member
 * names, member GUIDs and request URLs with the league ids (and run.json maps each slot to its real
 * id), so they get the location rule the product applies to its own data (locationRefusals): not
 * inside this repository or any git working tree — where `git add -A` would publish them — not in a
 * cloud-synced folder by name (Documents, Desktop, iCloud Drive, CloudStorage, Dropbox, …) and not
 * in a directory a file provider manages, from where they would sync off the machine (Stage C
 * finding scripts-raw-dir-synced-accepted). A check that cannot run refuses (fail closed).
 */
export function rawDirRefusal(
  dir: string,
  repoRoot: string,
  o: RawDirGuardOptions = {},
): RawDirRefusal | null {
  if (isInside(dir, repoRoot)) return "inside_repo";
  if (gitWorkTreeOf(dir, o.gitEntry) !== null) return "inside_git_work_tree";
  const refused = locationRefusals(dir, {
    home: o.home ?? homedir(),
    repoRoot,
    what: "--raw-dir",
    ...(o.xattr === undefined ? {} : { xattr: o.xattr }),
    ...(o.gitEntry === undefined ? {} : { gitEntry: o.gitEntry }),
  })[0];
  if (refused === undefined) return null;
  return refused.reason === "inside_repo" ? "inside_git_work_tree" : refused.reason;
}

/** The message each fixture tool prints for a refused raw directory (never the path itself). */
export function rawDirRefusalMessage(reason: RawDirRefusal): string {
  const why = "raw captures hold real names and ids";
  switch (reason) {
    case "inside_repo":
    case "inside_git_work_tree":
      return `the raw directory must be OUTSIDE the repository and outside any git working tree (${why})`;
    case "synced_folder":
      return `the raw directory must not be in a cloud-synced folder (Documents, Desktop, iCloud Drive, CloudStorage, Dropbox, Google Drive, OneDrive) — ${why}; the default is under the cache dir (~/.cache/espn-fantasy-football-mcp/recordings or EFF_CACHE_DIR)`;
    case "file_provider":
      return `the raw directory is managed by a file provider (iCloud or another sync client) — ${why}; choose a non-synced directory such as the default under the cache dir`;
    case "xattr_unverifiable":
      return `could not check whether the raw directory is managed by a file provider — refusing (${why})`;
    default:
      return `the raw directory could not be checked against the location rules (${reason}) — refusing; ${why}`;
  }
}
