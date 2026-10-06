// allowlist.ts — the host allow-list every outbound request (and every redirect hop) is checked
// against BEFORE it is made (plan 02 S12 + §7.1 "Host allow-list"; §8 threats 10, 18; plan 01 §6).
// Two disjoint modes: ESPN mode = the configured read host ONLY (`lm-api-reads…`, or the operator
// override EFF_ESPN_READ_HOST accepted only under ^[a-z0-9-]+\.fantasy\.espn\.com$ — so a cookie can
// never leave *.fantasy.espn.com); data mode = the Phase-1a data-source hosts. The ESPN write host is
// in neither and is refused by an explicit check even if a caller hands it in as the read host
// (PHASE W SEAM — NOT IMPLEMENTED: a write module would add its host here, behind plan 02 §3.2's four
// gates). `release-assets.githubusercontent.com` is a recorded deviation (GitHub release downloads
// 302 there — sibling @cf3b015, verified 2026-09-30). Ported from sibling @cf3b015, adapted.
import { ESPN_READ_HOST_DEFAULT, ESPN_WRITE_HOST, isAllowedReadHost } from "../config/schema.js";
import { HttpError } from "./errors.js";

/** The Phase-1a/1b data-source hosts: nflverse releases on GitHub, Open-Meteo, NWS. */
export const DATA_SOURCE_HOSTS: readonly string[] = Object.freeze([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "raw.githubusercontent.com",
  "api.open-meteo.com",
  "api.weather.gov",
]);

/**
 * The first DNS label of the write host, derived from config's constant (the write-host literal is
 * spelled only in src/config/schema.ts — HANDOFF "Build facts"): any host starting with it is refused.
 */
const WRITE_HOST_LABEL = ESPN_WRITE_HOST.slice(0, ESPN_WRITE_HOST.indexOf("."));

/**
 * Whether `host` is the ESPN write host or any host in its family. Nothing in this build ever sends
 * a request there (CLAUDE.md "Security"; plan 02 §3.1).
 */
export function isWriteHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.+$/, "");
  return h === ESPN_WRITE_HOST || h.startsWith(WRITE_HOST_LABEL);
}

/**
 * The ESPN read host to use: `configured` when it passes plan 02 S12's grammar (and is not the write
 * host), the default when it is undefined. Anything else is a programming error (config validates
 * EFF_ESPN_READ_HOST first) and throws RangeError — the allow-list never widens past the rule.
 */
export function espnReadHostFrom(configured?: string): string {
  if (configured === undefined) return ESPN_READ_HOST_DEFAULT;
  if (typeof configured !== "string" || !isAllowedReadHost(configured) || isWriteHost(configured))
    throw new RangeError(
      "http: the ESPN read host must match ^[a-z0-9-]+\\.fantasy\\.espn\\.com$ and is never the write host",
    );
  return configured;
}

/** The full allow-list for a read host: the read host plus the data-source hosts (never the write host). */
export function allowListFor(readHost: string): readonly string[] {
  return Object.freeze([espnReadHostFrom(readHost), ...DATA_SOURCE_HOSTS]);
}

/** The longest URL accepted. */
export const MAX_URL_CHARS = 4096;

/**
 * Validates `raw` for a request: parses it, requires `https:` on the default port, refuses embedded
 * credentials, refuses the write host outright, and requires the host to be EXACTLY one of `allow`
 * (no suffix matching, no IP literals, no trailing-dot variants). Returns the parsed URL; throws
 * HttpError otherwise. `espn` marks the error's scope.
 */
export function checkUrl(raw: string, allow: readonly string[], espn = false): URL {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_CHARS)
    throw new HttpError({ kind: "invalid_url", espn });
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError({ kind: "invalid_url", espn });
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || (u.port !== "" && u.port !== "443"))
    throw new HttpError({ kind: "scheme_refused", host, espn });
  if (u.username !== "" || u.password !== "")
    throw new HttpError({ kind: "credentials_refused", host, espn });
  if (isWriteHost(host) || !allow.includes(host))
    throw new HttpError({ kind: "host_not_allowed", host, espn });
  return u;
}

/**
 * Validates a caller-supplied allow-list: it may only NARROW `full` (a per-source client never
 * widens the policy). Returns a frozen, lower-cased, de-duplicated copy; throws on an unknown host.
 */
export function narrowAllowList(
  hosts: readonly string[],
  full: readonly string[],
): readonly string[] {
  const out: string[] = [];
  for (const h of hosts) {
    const lc = typeof h === "string" ? h.toLowerCase() : "";
    if (!full.includes(lc))
      throw new RangeError("http: an allow-list may only narrow the full list");
    if (!out.includes(lc)) out.push(lc);
  }
  return Object.freeze(out);
}

/**
 * A URL for logs (plan 01 §8): origin + path, never the query string or fragment, with every ESPN
 * league id masked (`/leagues/[league]` — plan 02 §2.3: the configured league id is never logged).
 */
export function redactUrl(u: URL): string {
  const path = u.pathname.replace(/(\/leagues?\/)[^/]+/gi, "$1[league]");
  return `${u.protocol}//${u.host}${path}`;
}
