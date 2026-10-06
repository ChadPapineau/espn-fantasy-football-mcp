// transport.ts — one ESPN attempt over an injected `fetch` (plan 01 §6 "all HTTP goes through one
// client": the read host only, redirects never followed — a 3xx is ESPN_HOST_MOVED and a cookie is
// never sent to a redirect target; plan 02 §5 the 8 MB body cap, streamed; §2.1 the Cookie header
// is built ONLY for the read host; plan 01 §6 the fixed honest User-Agent and a per-attempt timeout
// under the per-call deadline). Never the write host: the host is checked against the config rule
// on every attempt. Tests inject `fetch`; no test touches the network.
import { ESPN_WRITE_HOST, isAllowedReadHost } from "../../config/schema.js";
import { VERSION } from "../../version.js";
import { classifyThrown, EspnUpstreamError } from "./errors.js";
import type { EspnTarget } from "./path.js";
import { HEADER_FILTER, type EspnView } from "./types.js";

/** The subset of `fetch` the transport uses (tests inject a fake; fixture mode serves files). */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** The JSON body cap (plan 02 §5: the largest legitimate league response seen is 5.7 MB). */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
/**
 * The fixed, honest User-Agent (plan 01 §6; research 03 §D.3) — never a browser's. No repository URL
 * or contact address: it would carry an identifier (decision recorded).
 */
export const ESPN_USER_AGENT = `espn-fantasy-football-mcp/${VERSION} (personal read-only local MCP server)`;
/** At most this many response headers are kept (each value cut to 512 chars). */
const MAX_HEADERS = 64;
const DROPPED_HEADERS: ReadonlySet<string> = new Set(["set-cookie", "set-cookie2"]);

/** One attempt's request. */
export interface AttemptRequest {
  readonly target: EspnTarget;
  /** The canonical `X-Fantasy-Filter` value, or null. */
  readonly filter: string | null;
  /** The Cookie header value — attached only when the URL's host is the read host. */
  readonly cookie: string | null;
  readonly ifNoneMatch: string | null;
  readonly timeoutMs: number;
  /** The caller's cancellation (the tool call's budget signal). */
  readonly signal: AbortSignal | null;
  /** For error details: the primary view. */
  readonly view: EspnView;
}

/** One attempt's answer (body as text, decoded; headers lower-cased; Set-Cookie dropped). */
export interface AttemptAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyText: string;
  readonly bytes: number;
}

/**
 * Checks a target before anything is sent: https on the default port, no credentials in the URL,
 * the host equal to the target's host and allowed as a read host (never the write host).
 */
export function assertReadTarget(target: EspnTarget): URL {
  let u: URL;
  try {
    u = new URL(target.url);
  } catch {
    throw new EspnUpstreamError("bad_request", { reason: "invalid_url" });
  }
  if (
    u.protocol !== "https:" ||
    u.port !== "" ||
    u.username !== "" ||
    u.password !== "" ||
    u.hostname !== target.host ||
    u.hostname === ESPN_WRITE_HOST ||
    !isAllowedReadHost(u.hostname)
  )
    throw new EspnUpstreamError("bad_request", { reason: "host_refused" });
  return u;
}

function collectHeaders(h: Headers): Readonly<Record<string, string>> {
  const entries: [string, string][] = [];
  h.forEach((value, key) => {
    const k = key.toLowerCase();
    if (DROPPED_HEADERS.has(k) || entries.length >= MAX_HEADERS) return;
    entries.push([k, value.length > 512 ? value.slice(0, 512) : value]);
  });
  return Object.freeze(Object.fromEntries(entries));
}

/** Frees a body we will not read. Never throws. */
function discard(res: Response): void {
  try {
    res.body?.cancel().catch(() => undefined);
  } catch {
    // a locked body or a hostile getter: nothing to free
  }
}

/** Reads the body as UTF-8 text, enforcing MAX_BODY_BYTES on the declared length and while streaming. */
async function readText(res: Response, view: EspnView): Promise<{ text: string; bytes: number }> {
  const declared = res.headers.get("content-length");
  if (declared !== null && /^\s*\d+\s*$/.test(declared) && Number(declared) > MAX_BODY_BYTES) {
    discard(res);
    throw new EspnUpstreamError("too_large", { view, upstream_status: res.status });
  }
  const body = res.body;
  if (body === null) return { text: "", bytes: 0 };
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder("utf-8");
  const parts: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      bytes += r.value.byteLength;
      if (bytes > MAX_BODY_BYTES)
        throw new EspnUpstreamError("too_large", { view, upstream_status: res.status });
      parts.push(decoder.decode(r.value, { stream: true }));
    }
  } catch (e) {
    reader.cancel().catch(() => undefined);
    throw e;
  }
  parts.push(decoder.decode());
  return { text: parts.join(""), bytes };
}

/**
 * Sends ONE attempt. Resolves with the answer for any HTTP status (the classifier decides); rejects
 * with an EspnUpstreamError for a timeout, a network failure or an oversized body. An error that
 * already carries an own `effCode` (fixture mode's missing-fixture error) passes through unchanged.
 */
export async function sendAttempt(fetchFn: FetchLike, req: AttemptRequest): Promise<AttemptAnswer> {
  const url = assertReadTarget(req.target);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, req.timeoutMs);
  const onCaller = (): void => {
    controller.abort();
  };
  if (req.signal?.aborted === true) {
    clearTimeout(timer);
    throw new EspnUpstreamError("network_transient", { view: req.view, reason: "aborted" });
  }
  req.signal?.addEventListener("abort", onCaller, { once: true });
  const headers: Record<string, string> = {
    "user-agent": ESPN_USER_AGENT,
    accept: "application/json",
  };
  if (req.filter !== null) headers[HEADER_FILTER.toLowerCase()] = req.filter;
  if (req.ifNoneMatch !== null) headers["if-none-match"] = req.ifNoneMatch;
  // The Cookie header exists only for the read host (checked above) — never for any other host.
  if (req.cookie !== null && url.hostname === req.target.host) headers.cookie = req.cookie;
  try {
    let res: Response;
    try {
      res = await fetchFn(url.href, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        headers,
        signal: controller.signal,
      });
    } catch (e) {
      if (e instanceof Error && Object.prototype.hasOwnProperty.call(e, "effCode")) throw e;
      throw classifyThrown(e, timedOut, req.view);
    }
    if (res.status >= 300 && res.status <= 399) {
      discard(res);
      return { status: res.status, headers: collectHeaders(res.headers), bodyText: "", bytes: 0 };
    }
    try {
      const { text, bytes } = await readText(res, req.view);
      return { status: res.status, headers: collectHeaders(res.headers), bodyText: text, bytes };
    } catch (e) {
      if (e instanceof EspnUpstreamError) throw e;
      throw classifyThrown(e, timedOut, req.view);
    }
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onCaller);
  }
}
