// guards.ts — refusals that run before any request or write: no cookie material anywhere in the
// recorder's environment or arguments (CLAUDE.md "Security": no live request to ESPN carries a
// cookie in recording; plan 05 §3.1 keyless recording), and raw captures only OUTSIDE the repo
// (research 03 §F.3: "raw captures kept outside the repo").
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

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

/** The real path of `p`, or of its nearest existing ancestor joined with the rest. */
function realish(p: string): string {
  const abs = path.resolve(p);
  let cur = abs;
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  return path.join(realpathSync(cur), ...rest);
}

/** True when `dir` is the repo root or anywhere inside it (symlinks resolved). */
export function isInside(dir: string, root: string): boolean {
  const d = realish(dir);
  const r = realish(root);
  const rel = path.relative(r, d);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
