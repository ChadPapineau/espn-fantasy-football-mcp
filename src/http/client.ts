// client.ts — the one outbound HTTP client (plan 01 §6 "all HTTP goes through one httpClient" with a
// host allow-list per mode, 15 s per ESPN attempt, 60 s release downloads, honest User-Agent; plan
// 02 S12, §2.3 redaction, §5 8 MB JSON cap, §7.1 built-ins only; plan 05 §4.1 network rows). Global
// fetch, node:zlib, node:fs — no dependency. Implements the src/sources/source.ts HttpGet (memory)
// and HttpDownload (streamed to a 0600 file) contracts, plus `espnGet`, the provider's transport.
//
// Rules: HTTPS on the default port only; the start URL's host picks the mode — the ESPN read host →
// ESPN mode (every hop must stay on that one host), else data mode (the data-source hosts); every
// redirect hop is re-checked BEFORE it is requested (`redirect: "manual"`, ≤ MAX_REDIRECT_HOPS), so
// the old ESPN host's 302 to www.espn.com is refused, never followed (plan 05 §4.1 → ESPN_HOST_MOVED).
// A Cookie header exists only on `espnGet`, only for a URL on the read host, and only on hops to it;
// it is never logged and never part of an error (errors are fixed strings with no raw cause). Body
// caps are enforced while streaming, on the wire AND after gzip decoding (a gzip bomb stops at the
// cap). `Set-Cookie` is dropped from every response. PHASE W SEAM — NOT IMPLEMENTED: there is no
// write method and the write host is on no allow-list (allowlist.ts).
// Ported from sibling @cf3b015, adapted (ESPN mode, cookie, X-Fantasy-Filter, If-None-Match, 304/4xx
// returned to the provider, league-masked log URLs).
import { open, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { gunzipSync } from "node:zlib";
import { ATTEMPT_TIMEOUT_MS } from "../providers/platform.js";
import {
  MAX_REDIRECT_HOPS,
  RELEASE_DOWNLOAD_TIMEOUT_MS,
  type HttpDownload,
  type HttpGet,
} from "../sources/source.js";
import { VERSION } from "../version.js";
import {
  allowListFor,
  checkUrl,
  espnReadHostFrom,
  narrowAllowList,
  redactUrl,
} from "./allowlist.js";
import { classifyFetchError, HttpError, type AbortReason } from "./errors.js";

/** Until response headers arrive, per hop (plan 01 §6: 15 s). */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
/** The whole data-mode call, body included (plan 01 §6: 60 s for release downloads). */
export const DEFAULT_TOTAL_TIMEOUT_MS = RELEASE_DOWNLOAD_TIMEOUT_MS;
/** No call may ask for more than 1 GiB. */
export const MAX_BYTES_CEILING = 1024 * 1024 * 1024;
/** The ESPN JSON body cap (plan 02 §5: the largest legitimate league-path response is 5.7 MB). */
export const ESPN_MAX_BODY_BYTES = 8 * 1024 * 1024;
/** At most this many response headers are kept, each value cut to 1 024 chars. */
export const MAX_RESPONSE_HEADERS = 64;
/** Longest Cookie header accepted (an espn_s2 is a few hundred characters). */
export const MAX_COOKIE_CHARS = 8192;
/** Longest X-Fantasy-Filter accepted (50 ids + a sort is well under 2 KB). */
export const MAX_FILTER_CHARS = 8192;
/** Longest If-None-Match accepted. */
export const MAX_ETAG_CHARS = 512;
/** The public repository (the plugin manifest's `repository`; a test holds them equal). */
export const REPO_URL = "https://github.com/ChadPapineau/espn-fantasy-football-mcp";
/**
 * The fixed, honest User-Agent (plan 01 §6 `espn-fantasy-football-mcp/<version> (+<repo URL>)`; NWS
 * requires a contact — research 04 §B.8 — and the public repo is it). Never a browser's.
 */
export const DEFAULT_USER_AGENT = `espn-fantasy-football-mcp/${VERSION} (+${REPO_URL})`;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const DROPPED_RESPONSE_HEADERS: ReadonlySet<string> = new Set(["set-cookie", "set-cookie2"]);
const PRINTABLE = /^[\x20-\x7e]{1,256}$/;
/** Printable ASCII of any length (bounded separately): no CR/LF, so no header injection. */
const PRINTABLE_ANY = /^[\x20-\x7e]+$/;

/** The subset of `fetch` the client uses (tests inject a fake; no sockets). */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** The logger surface the client needs (src/cli/log.ts's Logger satisfies it). */
export interface HttpLog {
  debug(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** Options of one `espnGet` call (one attempt — the deadline runner owns retries). */
export interface EspnGetOptions {
  readonly signal: AbortSignal;
  /** Default ESPN_MAX_BODY_BYTES. */
  readonly maxBytes?: number;
  /**
   * The Cookie header value (`espn_s2=…; SWID=…`, auth/types.ts `CookieHeader`). Sent only to the
   * read host; never logged; never in an error. null/undefined = a keyless request.
   */
  readonly cookie?: string | null;
  /** The X-Fantasy-Filter JSON the filter builder produced (canonical; printable ASCII). */
  readonly fantasyFilter?: string;
  /** The stored weak ETag (plan 01 §5.3 conditional requests). */
  readonly ifNoneMatch?: string;
  /** This attempt's total timeout, ≤ ATTEMPT_TIMEOUT_MS (default it). */
  readonly timeoutMs?: number;
}

/** What an `espnGet` attempt returns: 2xx, 304 and 4xx answers, for the provider to classify. */
export interface EspnResponse {
  readonly status: number;
  readonly body: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
  readonly final_url: string;
  /** Whether a Cookie header was sent (a boolean only — never the value). */
  readonly cookie_sent: boolean;
}

/**
 * One ESPN read attempt. Throws HttpError for 5xx (`http_5xx`), 429 (`rate_limited`), any other
 * unexpected status, an off-host redirect (`redirect_refused` → ESPN_HOST_MOVED), network failures,
 * timeouts and oversize bodies; returns 2xx, 304 and 4xx with their (capped) bodies.
 */
export type EspnGet = (url: string, opts: EspnGetOptions) => Promise<EspnResponse>;

/** How to build a client. */
export interface HttpClientOptions {
  /** Default: the global fetch. */
  readonly fetch?: FetchLike;
  /** The ESPN read host (config `espnReadHost`, EFF_ESPN_READ_HOST); default the documented host. */
  readonly espnReadHost?: string;
  /** A NARROWING of the full allow-list (default: all of it); a host outside it throws at construction. */
  readonly allowHosts?: readonly string[];
  readonly userAgent?: string;
  readonly connectTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly log?: HttpLog;
  /** Monotonic ms for the `ms` log field; default performance.now. */
  readonly now?: () => number;
}

/** An HTTP client: the contract functions plus its effective policy. */
export interface HttpClient {
  readonly get: HttpGet;
  readonly download: HttpDownload;
  readonly espnGet: EspnGet;
  readonly allowHosts: readonly string[];
  readonly espnReadHost: string;
  readonly userAgent: string;
}

interface Config {
  readonly fetch: FetchLike;
  readonly readHost: string;
  /** ESPN mode: [readHost] when allowed, else []. */
  readonly espnAllow: readonly string[];
  /** Data mode: the allowed data-source hosts. */
  readonly dataAllow: readonly string[];
  readonly allow: readonly string[];
  readonly userAgent: string;
  readonly connectTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly log: HttpLog | null;
  readonly now: () => number;
}

/** The per-call policy the shared request loop applies. */
interface CallPolicy {
  readonly signal: AbortSignal;
  readonly maxBytes: number;
  readonly accept: string;
  readonly espn: boolean;
  /** Hosts any hop may target. */
  readonly allow: readonly string[];
  /** Headers sent only on hops whose host is the read host (cookie, filter, etag). */
  readonly espnHeaders: Readonly<Record<string, string>>;
  readonly cookie: boolean;
  /** Non-2xx statuses returned as values instead of thrown (espnGet: 304 and 4xx but 429). */
  readonly returnStatus: (status: number) => boolean;
  readonly connectTimeoutMs: number;
  readonly totalTimeoutMs: number;
}

interface Meta {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly final_url: string;
  readonly bytes: number;
}

type Sink = (chunk: Uint8Array) => Promise<void> | void;

function positiveMs(v: number | undefined, dflt: number, what: string): number {
  if (v === undefined) return dflt;
  if (!Number.isFinite(v) || v <= 0)
    throw new RangeError(`http: ${what} must be a positive number`);
  return v;
}

function validSignal(signal: unknown): AbortSignal {
  if (!(signal instanceof AbortSignal)) throw new RangeError("http: signal is required");
  return signal;
}

function validMaxBytes(maxBytes: unknown): number {
  if (
    typeof maxBytes !== "number" ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > MAX_BYTES_CEILING
  )
    throw new RangeError("http: maxBytes must be an integer in 1..1 GiB");
  return maxBytes;
}

function validAccept(accept: unknown): string {
  const a = accept ?? "*/*";
  if (typeof a !== "string" || !PRINTABLE.test(a))
    throw new RangeError("http: accept must be printable ASCII");
  return a;
}

/** A header value: printable ASCII (no CR/LF), 1..max chars; else RangeError naming the field only. */
function headerValue(v: unknown, max: number, what: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max || !PRINTABLE_ANY.test(v))
    throw new RangeError(`http: ${what} must be 1..${String(max)} printable ASCII characters`);
  return v;
}

/** Fields the data-mode contract never carries: refused so a cast cannot smuggle a cookie in. */
function refuseForeignOptions(opts: object): void {
  for (const k of ["cookie", "headers", "ifNoneMatch"])
    if (Object.prototype.hasOwnProperty.call(opts, k))
      throw new RangeError(`http: ${k} is not an option of this call`);
}

/** Rejects as soon as `signal` aborts, even when `p` ignores the signal (a hung fake or socket). */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  const abortErr = (): DOMException => new DOMException("The operation was aborted", "AbortError");
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.reject(abortErr());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortErr());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e instanceof Error ? e : new Error("fetch rejected with a non-Error"));
      },
    );
  });
}

/** Frees a response we will not read (a redirect, an error status). Never throws. */
function discard(res: Response): void {
  try {
    res.body?.cancel().catch(() => undefined);
  } catch {
    // a body already locked or a hostile getter: nothing to free
  }
}

function retryAfterSeconds(res: Response): number | null {
  const v = res.headers.get("retry-after");
  return v !== null && /^\s*\d{1,6}\s*$/.test(v) ? Number(v.trim()) : null;
}

function statusError(res: Response, host: string, espn: boolean): HttpError {
  const status = res.status;
  if (status === 429)
    return new HttpError({
      kind: "rate_limited",
      host,
      status,
      retryAfterS: retryAfterSeconds(res),
      espn,
    });
  if (status >= 500 && status <= 599)
    return new HttpError({
      kind: "http_5xx",
      host,
      status,
      retryAfterS: retryAfterSeconds(res),
      espn,
    });
  if (status >= 400 && status <= 499)
    return new HttpError({ kind: "http_4xx", host, status, espn });
  return new HttpError({ kind: "http_status", host, status, espn });
}

function collectHeaders(h: Headers): Readonly<Record<string, string>> {
  const entries: [string, string][] = [];
  h.forEach((value, key) => {
    const k = key.toLowerCase();
    if (DROPPED_RESPONSE_HEADERS.has(k) || entries.length >= MAX_RESPONSE_HEADERS) return;
    entries.push([k, value.length > 1024 ? value.slice(0, 1024) : value]);
  });
  // fromEntries defines own data properties, so a `__proto__` header cannot touch the prototype.
  return Object.freeze(Object.fromEntries(entries));
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * Streams the body into `sink`, enforcing `maxBytes` on the wire. A body the server declares as
 * gzip AND that still starts with the gzip magic (a fetch that did not decode it) is decoded here
 * with `maxOutputLength = maxBytes`, so decompression stops at the cap; a declared-gzip body that
 * fetch already decoded (undici does — its chunks are then counted decoded) passes through.
 */
async function readBody(
  res: Response,
  maxBytes: number,
  sink: Sink,
  signal: AbortSignal,
  host: string,
  espn: boolean,
): Promise<number> {
  const len = res.headers.get("content-length");
  if (len !== null && /^\s*\d+\s*$/.test(len) && Number(len.trim()) > maxBytes) {
    discard(res);
    throw new HttpError({ kind: "too_large", host, status: res.status, espn });
  }
  const body = res.body;
  if (body === null) return 0;
  const gzipDeclared = /(^|[\s,])(x-)?gzip($|[\s,;])/i.test(
    res.headers.get("content-encoding") ?? "",
  );
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const held: Uint8Array[] = [];
  let wire = 0;
  try {
    for (;;) {
      const r = await raceAbort(reader.read(), signal);
      if (r.done) break;
      wire += r.value.byteLength;
      if (wire > maxBytes)
        throw new HttpError({ kind: "too_large", host, status: res.status, espn });
      if (gzipDeclared) held.push(r.value);
      else await sink(r.value);
    }
  } catch (e) {
    reader.cancel().catch(() => undefined);
    throw e;
  }
  if (!gzipDeclared) return wire;
  const buf = concat(held, wire);
  if (buf.length < 2 || buf[0] !== 0x1f || buf[1] !== 0x8b) {
    if (buf.length > 0) await sink(buf);
    return buf.length;
  }
  let out: Uint8Array;
  try {
    out = gunzipSync(buf, { maxOutputLength: maxBytes });
  } catch (e) {
    const tooLarge =
      e instanceof RangeError ||
      (e instanceof Error && (e as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE");
    throw new HttpError({
      kind: tooLarge ? "too_large" : "decode",
      host,
      status: res.status,
      espn,
    });
  }
  await sink(out);
  return out.length;
}

/** The shared request loop: one call, every hop re-checked, timers cleared on every path. */
async function request(cfg: Config, start: URL, p: CallPolicy, sink: Sink): Promise<Meta> {
  let url = start;
  let hops = 0;
  const controller = new AbortController();
  let reason: AbortReason = null;
  const abort = (r: Exclude<AbortReason, null>): void => {
    if (reason !== null) return;
    reason = r;
    controller.abort();
  };
  const onCaller = (): void => {
    abort("caller");
  };
  if (p.signal.aborted) throw new HttpError({ kind: "aborted", host: url.hostname, espn: p.espn });
  p.signal.addEventListener("abort", onCaller, { once: true });
  const totalTimer = setTimeout(() => {
    abort("total_timeout");
  }, p.totalTimeoutMs);
  const t0 = cfg.now();
  try {
    for (;;) {
      const host = url.hostname.toLowerCase();
      const headers: Record<string, string> = {
        "user-agent": cfg.userAgent,
        accept: p.accept,
        "accept-encoding": "gzip",
        ...(host === cfg.readHost ? p.espnHeaders : {}),
      };
      const connectTimer = setTimeout(() => {
        abort("connect_timeout");
      }, p.connectTimeoutMs);
      let res: Response;
      try {
        res = await raceAbort(
          cfg.fetch(url.href, {
            method: "GET",
            redirect: "manual",
            credentials: "omit",
            headers,
            signal: controller.signal,
          }),
          controller.signal,
        );
      } catch (e) {
        throw classifyFetchError(e, reason, host, p.espn);
      } finally {
        clearTimeout(connectTimer);
      }
      if (REDIRECT_STATUSES.has(res.status)) {
        discard(res);
        if (hops >= MAX_REDIRECT_HOPS)
          throw new HttpError({
            kind: "too_many_redirects",
            host,
            status: res.status,
            espn: p.espn,
          });
        const loc = res.headers.get("location");
        let next: URL;
        try {
          if (loc === null || loc === "") throw new Error("no location");
          next = new URL(loc, url);
        } catch {
          throw new HttpError({ kind: "redirect_refused", host, status: res.status, espn: p.espn });
        }
        try {
          next = checkUrl(next.href, p.allow, p.espn);
        } catch (e) {
          throw new HttpError({
            kind: "redirect_refused",
            host: next.hostname.toLowerCase(),
            status: res.status,
            causeCode: e instanceof HttpError ? e.kind.toUpperCase() : null,
            espn: p.espn,
          });
        }
        cfg.log?.debug("http.redirect", {
          from: redactUrl(url),
          to: redactUrl(next),
          status: res.status,
        });
        url = next;
        hops++;
        continue;
      }
      if ((res.status < 200 || res.status > 299) && !p.returnStatus(res.status)) {
        discard(res);
        throw statusError(res, host, p.espn);
      }
      const bytes = await readBody(res, p.maxBytes, sink, controller.signal, host, p.espn);
      cfg.log?.debug("http.get", {
        url: redactUrl(url),
        status: res.status,
        bytes,
        hops,
        cookie: p.cookie,
        ms: Math.round(cfg.now() - t0),
      });
      return {
        status: res.status,
        headers: collectHeaders(res.headers),
        final_url: url.href,
        bytes,
      };
    }
  } catch (e) {
    const err = e instanceof HttpError ? e : classifyFetchError(e, reason, url.hostname, p.espn);
    cfg.log?.warn("http.error", {
      url: redactUrl(url),
      kind: err.kind,
      status: err.status,
      cause_code: err.causeCode,
      hops,
      cookie: p.cookie,
      ms: Math.round(cfg.now() - t0),
    });
    throw err;
  } finally {
    clearTimeout(totalTimer);
    p.signal.removeEventListener("abort", onCaller);
  }
}

/** Builds the client. Options are validated here (a bad timeout or host is a programming error). */
export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  if (!PRINTABLE.test(userAgent)) throw new RangeError("http: userAgent must be printable ASCII");
  const readHost = espnReadHostFrom(options.espnReadHost);
  const full = allowListFor(readHost);
  const allow = options.allowHosts === undefined ? full : narrowAllowList(options.allowHosts, full);
  const cfg: Config = {
    fetch: options.fetch ?? ((url, init) => fetch(url, init)),
    readHost,
    espnAllow: Object.freeze(allow.filter((h) => h === readHost)),
    dataAllow: Object.freeze(allow.filter((h) => h !== readHost)),
    allow,
    userAgent,
    connectTimeoutMs: positiveMs(
      options.connectTimeoutMs,
      DEFAULT_CONNECT_TIMEOUT_MS,
      "connectTimeoutMs",
    ),
    totalTimeoutMs: positiveMs(options.totalTimeoutMs, DEFAULT_TOTAL_TIMEOUT_MS, "totalTimeoutMs"),
    log: options.log ?? null,
    now: options.now ?? (() => performance.now()),
  };

  /** The start URL picks the mode: the read host → ESPN mode, else data mode. */
  const modeOf = (raw: string): { url: URL; espn: boolean } => {
    let host = "";
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      // checkUrl reports the parse failure below
    }
    const espn = host === readHost;
    return { url: checkUrl(raw, espn ? cfg.espnAllow : cfg.dataAllow, espn), espn };
  };

  /** The data-contract policy (HttpGet / HttpDownload): non-2xx throws. */
  const dataPolicy = (
    raw: string,
    opts: {
      readonly signal: AbortSignal;
      readonly maxBytes: number;
      readonly accept?: string;
      readonly fantasyFilter?: string;
    },
  ): { url: URL; policy: CallPolicy } => {
    const signal = validSignal(opts.signal);
    const maxBytes = validMaxBytes(opts.maxBytes);
    const accept = validAccept(opts.accept);
    refuseForeignOptions(opts);
    const { url, espn } = modeOf(raw);
    let espnHeaders: Readonly<Record<string, string>> = {};
    if (opts.fantasyFilter !== undefined) {
      if (!espn) throw new RangeError("http: fantasyFilter is only sent to the ESPN read host");
      espnHeaders = {
        "x-fantasy-filter": headerValue(opts.fantasyFilter, MAX_FILTER_CHARS, "fantasyFilter"),
      };
    }
    return {
      url,
      policy: {
        signal,
        maxBytes,
        accept,
        espn,
        allow: espn ? cfg.espnAllow : cfg.dataAllow,
        espnHeaders,
        cookie: false,
        returnStatus: () => false,
        connectTimeoutMs: cfg.connectTimeoutMs,
        totalTimeoutMs: cfg.totalTimeoutMs,
      },
    };
  };

  const get: HttpGet = async (raw, opts) => {
    const { url, policy } = dataPolicy(raw, opts);
    const chunks: Uint8Array[] = [];
    let total = 0;
    const meta = await request(cfg, url, policy, (c) => {
      chunks.push(c);
      total += c.byteLength;
    });
    return {
      status: meta.status,
      body: concat(chunks, total),
      headers: meta.headers,
      final_url: meta.final_url,
    };
  };

  const download: HttpDownload = async (raw, opts) => {
    if (typeof opts.dest !== "string" || !isAbsolute(opts.dest))
      throw new RangeError("http: download dest must be an absolute path");
    const { url, policy } = dataPolicy(raw, opts);
    const fh = await open(opts.dest, "wx", 0o600);
    try {
      const meta = await request(cfg, url, policy, async (c) => {
        let off = 0;
        while (off < c.byteLength) {
          const { bytesWritten } = await fh.write(c, off, c.byteLength - off);
          off += bytesWritten;
        }
      });
      await fh.close();
      return { ...meta, path: opts.dest };
    } catch (e) {
      await fh.close().catch(() => undefined);
      await unlink(opts.dest).catch(() => undefined);
      throw e;
    }
  };

  const espnGet: EspnGet = async (raw, opts) => {
    const signal = validSignal(opts.signal);
    const maxBytes = validMaxBytes(opts.maxBytes ?? ESPN_MAX_BODY_BYTES);
    const timeoutMs = opts.timeoutMs ?? ATTEMPT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > ATTEMPT_TIMEOUT_MS)
      throw new RangeError("http: an ESPN attempt's timeoutMs must be in (0, ATTEMPT_TIMEOUT_MS]");
    const cookie = opts.cookie ?? null;
    let host = "";
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      // checkUrl reports the parse failure below
    }
    // the cookie rule is checked before anything else: it never meets a URL off the read host
    if (cookie !== null && host !== readHost)
      throw new HttpError({ kind: "cookie_refused", host, espn: true });
    const url = checkUrl(raw, cfg.espnAllow, true);
    const espnHeaders: Record<string, string> = {};
    if (cookie !== null) espnHeaders.cookie = headerValue(cookie, MAX_COOKIE_CHARS, "cookie");
    if (opts.fantasyFilter !== undefined)
      espnHeaders["x-fantasy-filter"] = headerValue(
        opts.fantasyFilter,
        MAX_FILTER_CHARS,
        "fantasyFilter",
      );
    if (opts.ifNoneMatch !== undefined)
      espnHeaders["if-none-match"] = headerValue(opts.ifNoneMatch, MAX_ETAG_CHARS, "ifNoneMatch");
    const chunks: Uint8Array[] = [];
    let total = 0;
    const meta = await request(
      cfg,
      url,
      {
        signal,
        maxBytes,
        accept: "application/json",
        espn: true,
        allow: cfg.espnAllow,
        espnHeaders: Object.freeze(espnHeaders),
        cookie: cookie !== null,
        returnStatus: (s) => s === 304 || (s >= 400 && s <= 499 && s !== 429),
        connectTimeoutMs: Math.min(cfg.connectTimeoutMs, timeoutMs),
        totalTimeoutMs: timeoutMs,
      },
      (c) => {
        chunks.push(c);
        total += c.byteLength;
      },
    );
    return {
      status: meta.status,
      body: concat(chunks, total),
      headers: meta.headers,
      final_url: meta.final_url,
      cookie_sent: cookie !== null,
    };
  };

  return Object.freeze({
    get,
    download,
    espnGet,
    allowHosts: allow,
    espnReadHost: readHost,
    userAgent,
  });
}
