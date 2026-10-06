// transport.test.ts — src/providers/espn/transport.ts (plan 01 §6; plan 02 §2.1, §5): the read host
// only (https, default port, no credentials in the URL, never the write host — checked on EVERY
// attempt), redirects never followed (`redirect: "manual"`, body discarded), the Cookie header only
// for the read host, the fixed honest User-Agent, Set-Cookie dropped, the 8 MB cap, the attempt
// timeout and the caller's abort; errors with their own effCode pass through.
import { describe, expect, it } from "vitest";
import { ESPN_WRITE_HOST } from "../../../src/config/schema.js";
import { EspnUpstreamError } from "../../../src/providers/espn/errors.js";
import { leagueTarget, type EspnTarget } from "../../../src/providers/espn/path.js";
import {
  assertReadTarget,
  ESPN_USER_AGENT,
  MAX_BODY_BYTES,
  sendAttempt,
  type AttemptRequest,
  type FetchLike,
} from "../../../src/providers/espn/transport.js";
import { jsonResponse, testCookieHeader } from "./helpers.js";

const H = "lm-api-reads.fantasy.espn.com";
const target = leagueTarget({ host: H, season: 2026, leagueId: "0", views: ["mSettings"] });
const req = (over: Partial<AttemptRequest> = {}): AttemptRequest => ({
  target,
  filter: null,
  cookie: null,
  ifNoneMatch: null,
  timeoutMs: 1000,
  signal: null,
  view: "mSettings",
  ...over,
});
const capture = (
  res: () => Response,
): { fetch: FetchLike; init: RequestInit[]; urls: string[] } => {
  const init: RequestInit[] = [];
  const urls: string[] = [];
  return {
    init,
    urls,
    fetch: (u, i) => {
      urls.push(u);
      init.push(i);
      return Promise.resolve(res());
    },
  };
};

describe("assertReadTarget: refused before anything is sent", () => {
  const bad = (t: Partial<EspnTarget>): EspnTarget => ({ ...target, ...t });
  it.each([
    ["the write host", bad({ host: ESPN_WRITE_HOST, url: `https://${ESPN_WRITE_HOST}/x` })],
    ["http", bad({ url: `http://${H}/x` })],
    ["a port", bad({ url: `https://${H}:8443/x` })],
    ["credentials", bad({ url: `https://u:p@${H}/x` })],
    ["a host mismatch", bad({ url: "https://evil.fantasy.espn.com/x" })],
    ["a non-ESPN host", bad({ host: "example.com", url: "https://example.com/x" })],
    ["an unparseable URL", bad({ url: "not a url" })],
  ])("%s", async (_name, t) => {
    expect(() => assertReadTarget(t)).toThrow(EspnUpstreamError);
    let sent = 0;
    await expect(
      sendAttempt(() => (sent++, Promise.resolve(jsonResponse({}))), req({ target: t })),
    ).rejects.toMatchObject({
      effCode: "INTERNAL",
    });
    expect(sent).toBe(0);
  });
});

describe("the request", () => {
  it("GET, manual redirects, omit credentials, the honest User-Agent, JSON accept, the filter and ETag", async () => {
    const c = capture(() => jsonResponse({ ok: 1 }, 200, { "set-cookie": "a=b", etag: 'W/"1"' }));
    const a = await sendAttempt(c.fetch, req({ filter: '{"players":{}}', ifNoneMatch: 'W/"0"' }));
    expect(c.urls).toEqual([target.url]);
    const i = c.init[0]!;
    expect(i).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" });
    expect(i.headers).toEqual({
      "user-agent": ESPN_USER_AGENT,
      accept: "application/json",
      "x-fantasy-filter": '{"players":{}}',
      "if-none-match": 'W/"0"',
    });
    expect(ESPN_USER_AGENT).toMatch(/^espn-fantasy-football-mcp\/\S+ \(/);
    expect(ESPN_USER_AGENT).not.toMatch(/Mozilla|Chrome|Safari/);
    expect(a.status).toBe(200);
    expect(a.bodyText).toBe('{"ok":1}');
    expect(a.headers["set-cookie"]).toBeUndefined();
    expect(a.headers.etag).toBe('W/"1"');
  });
  it("the Cookie header is attached for the read host only", async () => {
    const c = capture(() => jsonResponse({}));
    await sendAttempt(
      c.fetch,
      req({ cookie: testCookieHeader("{00000000-0000-4000-8000-000000000001}") }),
    );
    expect((c.init[0]!.headers as Record<string, string>).cookie).toContain("SWID=");
  });
  it("a 3xx is returned (never followed) with its body discarded", async () => {
    const c = capture(
      () =>
        new Response("Redirecting", {
          status: 302,
          headers: { location: "https://www.espn.com/fantasy/" },
        }),
    );
    const a = await sendAttempt(c.fetch, req());
    expect(a).toMatchObject({ status: 302, bodyText: "", bytes: 0 });
    expect(c.urls).toHaveLength(1);
  });
  it("an empty body reads as empty text; headers are capped", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 80; i++) many[`x-h${String(i)}`] = "v".repeat(600);
    const a = await sendAttempt(
      capture(() => new Response(null, { status: 204, headers: many })).fetch,
      req(),
    );
    expect(a.bodyText).toBe("");
    expect(Object.keys(a.headers).length).toBeLessThanOrEqual(64);
    expect(Object.values(a.headers).every((v) => v.length <= 512)).toBe(true);
  });
});

describe("limits and failures", () => {
  it("a declared or streamed body over 8 MB is refused", async () => {
    await expect(
      sendAttempt(
        capture(
          () => new Response("{}", { headers: { "content-length": String(MAX_BODY_BYTES + 1) } }),
        ).fetch,
        req(),
      ),
    ).rejects.toMatchObject({ kind: "too_large" });
    const big = new Uint8Array(MAX_BODY_BYTES + 10);
    await expect(sendAttempt(capture(() => new Response(big)).fetch, req())).rejects.toMatchObject({
      kind: "too_large",
    });
  });
  it("a body stream that errors mid-read is a transient network failure", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([123]));
        c.error(Object.assign(new Error("reset"), { code: "ECONNRESET" }));
      },
    });
    await expect(
      sendAttempt(capture(() => new Response(stream)).fetch, req()),
    ).rejects.toMatchObject({ kind: "network_transient" });
  });
  it("the attempt timeout aborts a hung request (classified timeout)", async () => {
    const hung: FetchLike = (_u, i) =>
      new Promise((_r, rej) =>
        i.signal?.addEventListener("abort", () => {
          rej(new DOMException("a", "AbortError"));
        }),
      );
    await expect(sendAttempt(hung, req({ timeoutMs: 5 }))).rejects.toMatchObject({
      kind: "timeout",
    });
  });
  it("the caller's abort: before the start (no request) and during it", async () => {
    const pre = new AbortController();
    pre.abort();
    let sent = 0;
    await expect(
      sendAttempt(() => (sent++, Promise.resolve(jsonResponse({}))), req({ signal: pre.signal })),
    ).rejects.toMatchObject({
      effDetails: { reason: "aborted" },
    });
    expect(sent).toBe(0);
    const mid = new AbortController();
    const hung: FetchLike = (_u, i) =>
      new Promise((_r, rej) =>
        i.signal?.addEventListener("abort", () => {
          rej(new DOMException("a", "AbortError"));
        }),
      );
    const p = sendAttempt(hung, req({ signal: mid.signal, timeoutMs: 10_000 }));
    mid.abort();
    await expect(p).rejects.toMatchObject({ kind: "network_transient" });
  });
  it("an error carrying its own effCode (fixture mode) passes through unchanged", async () => {
    const own = Object.assign(new Error("fixture"), { effCode: "INTERNAL" });
    await expect(sendAttempt(() => Promise.reject(own), req())).rejects.toBe(own);
  });
  it("a body whose cancel throws is still released safely", async () => {
    const res = new Response("x", { status: 301 });
    Object.defineProperty(res, "body", {
      get() {
        throw new Error("hostile getter");
      },
    });
    await expect(sendAttempt(() => Promise.resolve(res), req())).resolves.toMatchObject({
      status: 301,
    });
  });
});
