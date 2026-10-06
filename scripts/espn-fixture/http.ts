// http.ts — the one keyless, polite GET used by scripts/probe.ts and scripts/record-fixture.ts:
// plan 06 §1.2 (probe requests), plan 05 §3.1 step 1 (keyless recording), plan 01 §6 (honest
// User-Agent, no retry on 4xx), research 03 §A.1 (read host only), §D.3 (polite usage). Read host
// ONLY, never a cookie, redirects never followed, bodies capped, requests spaced and counted.
import { readFileSync } from "node:fs";
import path from "node:path";

/** The only host this module will ever contact (research 03 §A.1). */
export const READ_HOST = "lm-api-reads.fantasy.espn.com";
/** The write host — refused unconditionally (CLAUDE.md "Security"; plan 10 §3.W not built). */
export const WRITE_HOST = "lm-api-writes.fantasy.espn.com";
export const API_ROOT = `https://${READ_HOST}/apis/v3/games/ffl`;

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

/** The public repository URL, from the plugin manifest (one source of truth). */
export function repoUrl(root = REPO_ROOT): string {
  const manifest = JSON.parse(
    readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8"),
  ) as { repository?: unknown };
  return typeof manifest.repository === "string" ? manifest.repository : "";
}

export function packageVersion(root = REPO_ROOT): string {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
    version?: unknown;
  };
  return typeof pkg.version === "string" ? pkg.version : "0.0.0";
}

/** The fixed, honest User-Agent (plan 01 §6): the tool's name, version and public repo. */
export function userAgent(purpose: string, root = REPO_ROOT): string {
  const url = repoUrl(root);
  return `espn-fantasy-football-mcp/${packageVersion(root)} (${purpose}${url ? `; +${url}` : ""})`;
}

/** A positive league id (digits only, no leading zero, ≤ 12 digits). */
export function isLeagueId(s: string): boolean {
  return /^[1-9]\d{0,11}$/.test(s);
}

/** A plausible season (ESPN serves 2018+ on the modern route — research 03 §A.1). */
export function isSeason(n: number): boolean {
  return Number.isInteger(n) && n >= 2018 && n <= 2100;
}

/**
 * The default season: the calendar year from June on, the previous one before (a new ESPN season
 * opens around early summer; January–May still belong to the season that started last autumn).
 */
export function defaultSeason(now: Date): number {
  return now.getUTCMonth() >= 5 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

/** `…/seasons/{season}?view=…` — the game-level route, no league id (research 03 §A.1). */
export function seasonUrl(season: number, views: readonly string[]): string {
  const q = new URLSearchParams();
  for (const v of views) q.append("view", v);
  return `${API_ROOT}/seasons/${String(season)}?${q.toString()}`;
}

/** `…/seasons/{season}/segments/0/leagues/{id}?view=…&…` (research 03 §A.1–§A.3). */
export function leagueUrl(
  season: number,
  leagueId: string,
  views: readonly string[],
  params: Readonly<Record<string, string>> = {},
): string {
  if (!/^\d{1,12}$/.test(leagueId)) throw new Error("league id must be digits only");
  const q = new URLSearchParams();
  for (const v of views) q.append("view", v);
  for (const [k, v] of Object.entries(params)) q.append(k, v);
  return `${API_ROOT}/seasons/${String(season)}/segments/0/leagues/${leagueId}?${q.toString()}`;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface GetResult {
  status: number;
  /** Lower-cased response headers (all of them; callers keep an allow-list when persisting). */
  headers: Record<string, string>;
  bodyText: string;
  bytes: number;
  /** The final URL the fetch implementation reports (a follower would change it). */
  url: string;
  ms: number;
}

export class RequestRefused extends Error {}
export class TransportError extends Error {
  constructor(
    message: string,
    readonly kind: "timeout" | "network" | "too_large",
  ) {
    super(message);
  }
}

export interface PoliteOptions {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Minimum spacing between request starts (≥ 1200 ms — the brief's floor; it cannot go lower). */
  minIntervalMs?: number;
  /** Hard cap on requests this client will ever make. */
  maxRequests?: number;
  timeoutMs?: number;
  maxBodyBytes?: number;
  userAgent?: string;
}

export const MIN_INTERVAL_FLOOR_MS = 1200;

/** Header names a request may carry — nothing else, and never a cookie or credential. */
const ALLOWED_REQUEST_HEADERS = new Set(["accept", "user-agent", "x-fantasy-filter"]);

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max)
    throw new TransportError(
      `response declares ${String(declared)} bytes (cap ${String(max)})`,
      "too_large",
    );
  if (!res.body) return new Uint8Array(0);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new TransportError(`response exceeds the ${String(max)}-byte cap`, "too_large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * A keyless GET client. Every request: https, host exactly READ_HOST (the write host and every other
 * host refused before any I/O), headers from a fixed allow-list (no Cookie, no Authorization),
 * `redirect: "manual"` (a 3xx is returned, never followed — plan 05 §2 `http/client`), a timeout,
 * a body cap, ≥ minIntervalMs between request starts, and a hard request cap.
 */
export function politeClient(opts: PoliteOptions = {}) {
  const doFetch: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const minInterval = Math.max(MIN_INTERVAL_FLOOR_MS, opts.minIntervalMs ?? MIN_INTERVAL_FLOOR_MS);
  const maxRequests = opts.maxRequests ?? 60;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxBody = opts.maxBodyBytes ?? 16 * 1024 * 1024;
  const ua = opts.userAgent ?? userAgent("fixture tooling");
  let count = 0;
  let lastStart: number | null = null;

  async function get(url: string, extra: { filter?: unknown } = {}): Promise<GetResult> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new RequestRefused("not a URL");
    }
    if (parsed.protocol !== "https:") throw new RequestRefused("only https is allowed");
    if (parsed.hostname === WRITE_HOST)
      throw new RequestRefused("the ESPN write host is never contacted");
    if (parsed.hostname !== READ_HOST || parsed.port !== "" || parsed.username || parsed.password)
      throw new RequestRefused(`only ${READ_HOST} is allowed`);
    if (count >= maxRequests)
      throw new RequestRefused(
        `request cap reached (${String(maxRequests)}) — nothing more is sent`,
      );

    const headers: Record<string, string> = { accept: "application/json", "user-agent": ua };
    if (extra.filter !== undefined) headers["x-fantasy-filter"] = JSON.stringify(extra.filter);
    for (const name of Object.keys(headers))
      if (!ALLOWED_REQUEST_HEADERS.has(name))
        throw new RequestRefused(`header ${name} is not allowed`);

    if (lastStart !== null) {
      const wait = lastStart + minInterval - now();
      if (wait > 0) await sleep(wait);
    }
    count++;
    lastStart = now();
    const started = lastStart;
    let res: Response;
    try {
      res = await doFetch(parsed.href, {
        method: "GET",
        headers,
        redirect: "manual",
        credentials: "omit",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      if (name === "TimeoutError" || name === "AbortError")
        throw new TransportError(`timed out after ${String(timeoutMs)} ms`, "timeout");
      throw new TransportError(
        `network error (${e instanceof Error ? e.message.slice(0, 120) : "unknown"})`,
        "network",
      );
    }
    const raw = await readCapped(res, maxBody);
    const outHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      outHeaders[k.toLowerCase()] = v;
    });
    return {
      status: res.status,
      headers: outHeaders,
      bodyText: new TextDecoder("utf-8", { fatal: false }).decode(raw),
      bytes: raw.byteLength,
      url: res.url || parsed.href,
      ms: now() - started,
    };
  }

  return {
    get,
    /** Requests started so far. */
    count: () => count,
  };
}

export type PoliteClient = ReturnType<typeof politeClient>;
