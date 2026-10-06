// guards.ts — refusals that run before any request or write: no cookie material anywhere in the
// recorder's environment or arguments (CLAUDE.md "Security": no live request to ESPN carries a
// cookie in recording; plan 05 §3.1 keyless recording), and raw captures only OUTSIDE the repo
// and outside ANY git working tree (research 03 §F.3: "raw captures kept outside the repo"). The
// path checks are src/config/paths.ts's (S7): realpath(3) of the existing prefix and, on macOS's
// case- and normalisation-insensitive volumes, NFC + lower-case folding before the comparison.
import { gitWorkTreeOf, isInsideOnFs, realpathOfExistingPrefix } from "../../src/config/paths.js";

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

/**
 * Why a raw-capture directory is refused, or null: inside this repository, or inside any git
 * working tree (a `.git` entry on the way to the root) where `git add -A` would publish real names
 * and ids. `gitEntry` is injectable for tests.
 */
export function rawDirRefusal(
  dir: string,
  repoRoot: string,
  gitEntry?: (d: string) => boolean,
): "inside_repo" | "inside_git_work_tree" | null {
  if (isInside(dir, repoRoot)) return "inside_repo";
  return gitWorkTreeOf(dir, gitEntry) === null ? null : "inside_git_work_tree";
}
