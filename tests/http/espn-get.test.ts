// espn-get.test.ts — the ESPN mode of src/http/client.ts (plan 02 S12: the read host only, the
// write host never, redirects off-list refused BEFORE they are followed, the EFF_ESPN_READ_HOST
// override; plan 02 §2.3: the cookie never in an error or a log line; plan 05 §4.1: `302` to
// www.espn.com → ESPN_HOST_MOVED, not followed, the cookie not sent to it; plan 02 §5: 8 MB cap).
// Injected fake fetch only — no request ever leaves the process, and every cookie is synthetic.
import { inspect } from "node:util";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ESPN_READ_HOST_DEFAULT, ESPN_WRITE_HOST } from "../../src/config/schema.js";
import { createHttpClient, ESPN_MAX_BODY_BYTES, MAX_COOKIE_CHARS } from "../../src/http/client.js";
import { HttpError } from "../../src/http/errors.js";
import { classifyError, describeForLog, toToolError } from "../../src/mcp/errors.js";
import { ATTEMPT_TIMEOUT_MS } from "../../src/providers/platform.js";
import { MAX_REDIRECT_HOPS } from "../../src/sources/source.js";
import {
  captureLog,
  everyRendering,
  fakeFetch,
  hangingFetch,
  json,
  netError,
  ok,
  redirect,
  testCookie,
} from "./helpers.js";

const READ = `https://${ESPN_READ_HOST_DEFAULT}/apis/v3/games/ffl`;
const LEAGUE = "1".repeat(6);
const leagueUrl = (view = "mSettings"): string =>
  `${READ}/seasons/2026/segments/0/leagues/${LEAGUE}?view=${view}`;
const sig = (): AbortSignal => new AbortController().signal;

async function failure(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    return e as HttpError;
  }
  throw new Error("expected a failure");
}

describe("espnGet: what is sent", () => {
  it("cookie, filter and ETag go to the read host; accept is JSON; the cookie value is never echoed", async () => {
    const cookie = testCookie();
    const f = fakeFetch(() =>
      json({ id: 0 }, 200, { etag: 'W/"1"', "x-fantasy-server-time": "1" }),
    );
    const r = await createHttpClient({ fetch: f.fetch }).espnGet(leagueUrl("kona_player_info"), {
      signal: sig(),
      cookie,
      fantasyFilter: '{"players":{"limit":25,"sortPercOwned":{"sortPriority":1,"sortAsc":false}}}',
      ifNoneMatch: 'W/"0"',
    });
    expect(r.status).toBe(200);
    expect(r.cookie_sent).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(r.body))).toEqual({ id: 0 });
    expect(r.headers.etag).toBe('W/"1"');
    const h = f.calls[0]?.headers ?? {};
    expect(h.cookie).toBe(cookie);
    expect(h["x-fantasy-filter"]).toContain("sortPercOwned");
    expect(h["if-none-match"]).toBe('W/"0"');
    expect(h.accept).toBe("application/json");
    expect(Object.keys(h).sort()).toEqual(
      [
        "accept",
        "accept-encoding",
        "cookie",
        "if-none-match",
        "user-agent",
        "x-fantasy-filter",
      ].sort(),
    );
    expect(JSON.stringify(r)).not.toContain(cookie);
  });

  it("a keyless call sends no cookie header at all", async () => {
    const f = fakeFetch(() => json([]));
    const r = await createHttpClient({ fetch: f.fetch }).espnGet(
      `${READ}/seasons/2026?view=proTeamSchedules_wl`,
      {
        signal: sig(),
        cookie: null,
      },
    );
    expect(r.cookie_sent).toBe(false);
    expect(Object.keys(f.calls[0]?.headers ?? {})).not.toContain("cookie");
  });

  it("304 and 4xx answers are returned (the provider classifies them); 429 and 5xx throw", async () => {
    const bodies: Record<number, unknown> = {
      304: null,
      400: { details: [{ type: "FILTER_LIMIT_MISSING_SORT" }] },
      401: { details: [{ type: "AUTH_LEAGUE_NOT_VISIBLE" }] },
      403: { details: [] },
      404: { details: [{ type: "GENERAL_NOT_FOUND" }] },
    };
    for (const [status, body] of Object.entries(bodies)) {
      const f = fakeFetch(
        () => new Response(body === null ? null : JSON.stringify(body), { status: Number(status) }),
      );
      const r = await createHttpClient({ fetch: f.fetch }).espnGet(leagueUrl(), { signal: sig() });
      expect(r.status).toBe(Number(status));
      if (body !== null) expect(JSON.parse(new TextDecoder().decode(r.body))).toEqual(body);
    }
    for (const [status, kind, code] of [
      [429, "rate_limited", "RATE_LIMITED"],
      [500, "http_5xx", "ESPN_UPSTREAM_UNAVAILABLE"],
      [503, "http_5xx", "ESPN_UPSTREAM_UNAVAILABLE"],
      [300, "http_status", "ESPN_UPSTREAM_UNAVAILABLE"],
    ] as const) {
      const f = fakeFetch(() => new Response("x", { status }));
      const e = await failure(
        createHttpClient({ fetch: f.fetch }).espnGet(leagueUrl(), { signal: sig() }),
      );
      expect(e).toMatchObject({ kind, status, espn: true });
      expect(classifyError(e).code).toBe(code);
    }
  });
});

describe("espnGet: the host allow-list (plan 02 S12)", () => {
  it("the write host is refused before any request — with or without a cookie", async () => {
    const f = fakeFetch(() => ok("{}"));
    const c = createHttpClient({ fetch: f.fetch });
    const url = `https://${ESPN_WRITE_HOST}/apis/v3/games/ffl/seasons/2026/segments/0/leagues/0/transactions/`;
    expect((await failure(c.espnGet(url, { signal: sig() }))).kind).toBe("host_not_allowed");
    expect((await failure(c.espnGet(url, { signal: sig(), cookie: testCookie() }))).kind).toBe(
      "cookie_refused",
    );
    expect((await failure(c.get(url, { signal: sig(), maxBytes: 9 }))).kind).toBe(
      "host_not_allowed",
    );
    expect(f.calls).toHaveLength(0);
  });

  it.each([
    "https://github.com/x",
    "https://api.weather.gov/points/1,2",
    "https://www.espn.com/fantasy/",
    "https://fantasy.espn.com/apis/v3/games/ffl",
    `https://${ESPN_READ_HOST_DEFAULT}.evil.example/x`,
    `http://${ESPN_READ_HOST_DEFAULT}/x`,
    `https://${ESPN_READ_HOST_DEFAULT}:8443/x`,
    `https://${ESPN_READ_HOST_DEFAULT}./x`,
  ])("keyless %s → refused, zero requests", async (url) => {
    const f = fakeFetch(() => ok("{}"));
    const e = await failure(createHttpClient({ fetch: f.fetch }).espnGet(url, { signal: sig() }));
    expect(["host_not_allowed", "scheme_refused"]).toContain(e.kind);
    expect(classifyError(e).code).toBe("INTERNAL");
    expect(f.calls).toHaveLength(0);
  });

  it.each([
    "https://github.com/x",
    "https://www.espn.com/fantasy/",
    `https://${ESPN_READ_HOST_DEFAULT}./x`,
    "not a url",
  ])("a cookie offered for %s → cookie_refused, zero requests", async (url) => {
    const cookie = testCookie();
    const f = fakeFetch(() => ok("{}"));
    const e = await failure(
      createHttpClient({ fetch: f.fetch }).espnGet(url, { signal: sig(), cookie }),
    );
    expect(e.kind).toBe("cookie_refused");
    expect(everyRendering(e)).not.toContain(cookie);
    expect(f.calls).toHaveLength(0);
  });

  it("the EFF_ESPN_READ_HOST override: its host works with a cookie, the default no longer does", async () => {
    const host = "fantasy-reads2.fantasy.espn.com";
    const f = fakeFetch(() => json({}));
    const c = createHttpClient({ fetch: f.fetch, espnReadHost: host });
    const r = await c.espnGet(`https://${host}/apis/v3/games/ffl/seasons/2026`, {
      signal: sig(),
      cookie: testCookie(),
    });
    expect(r.cookie_sent).toBe(true);
    expect(
      (await failure(c.espnGet(leagueUrl(), { signal: sig(), cookie: testCookie() }))).kind,
    ).toBe("cookie_refused");
    expect((await failure(c.espnGet(leagueUrl(), { signal: sig() }))).kind).toBe(
      "host_not_allowed",
    );
    expect(f.calls).toHaveLength(1);
  });

  it.each([
    ESPN_WRITE_HOST,
    "www.espn.com",
    "fantasy.espn.com",
    "a.b.fantasy.espn.com",
    "lm-api-reads.fantasy.espn.com.evil.example",
    "evil.example",
    "LM-API-READS.FANTASY.ESPN.COM",
  ])("an override %s is refused at construction (the allow-list never widens)", (host) => {
    expect(() => createHttpClient({ espnReadHost: host })).toThrow(RangeError);
  });
});

describe("espnGet: redirects are re-checked BEFORE they are followed", () => {
  it("302 to www.espn.com (the old host's move, research 03 P02) → ESPN_HOST_MOVED, not followed", async () => {
    const cookie = testCookie();
    const f = fakeFetch(() => redirect("https://www.espn.com/fantasy/", 302));
    const e = await failure(
      createHttpClient({ fetch: f.fetch }).espnGet(leagueUrl(), { signal: sig(), cookie }),
    );
    expect(e).toMatchObject({
      kind: "redirect_refused",
      host: "www.espn.com",
      status: 302,
      espn: true,
    });
    expect(classifyError(e).code).toBe("ESPN_HOST_MOVED");
    expect(f.calls).toHaveLength(1);
    expect(f.calls.every((c) => new URL(c.url).hostname === ESPN_READ_HOST_DEFAULT)).toBe(true);
    expect(everyRendering(e)).not.toContain(cookie);
  });

  it("a redirect to the write host is refused and never requested; the cookie goes nowhere", async () => {
    const cookie = testCookie();
    const f = fakeFetch(() => redirect(`https://${ESPN_WRITE_HOST}/apis/v3/games/ffl/x`, 307));
    const e = await failure(
      createHttpClient({ fetch: f.fetch }).espnGet(leagueUrl(), { signal: sig(), cookie }),
    );
    expect(e.kind).toBe("redirect_refused");
    expect(e.causeCode).toBe("HOST_NOT_ALLOWED");
    expect(f.calls.map((c) => new URL(c.url).hostname)).toEqual([ESPN_READ_HOST_DEFAULT]);
  });

  it.each([
    ["a data host", "https://github.com/x"],
    ["another fantasy host", "https://fantasy-reads2.fantasy.espn.com/x"],
    ["a scheme downgrade", `http://${ESPN_READ_HOST_DEFAULT}/x`],
    ["a credentialed URL", `https://u:p@${ESPN_READ_HOST_DEFAULT}/x`],
    ["a protocol-relative URL", "//evil.example/x"],
    ["no Location", null],
  ])("a redirect to %s is refused (ESPN mode allows the read host only)", async (_what, loc) => {
    const f = fakeFetch(() => redirect(loc, 301));
    const e = await failure(
      createHttpClient({ fetch: f.fetch }).espnGet(leagueUrl(), {
        signal: sig(),
        cookie: testCookie(),
      }),
    );
    expect(e.kind).toBe("redirect_refused");
    expect(f.calls).toHaveLength(1);
  });

  it("a same-host redirect is followed with the cookie (same origin) and reports final_url", async () => {
    const cookie = testCookie();
    const f = fakeFetch((_u, _i, n) =>
      n === 1 ? redirect(`${leagueUrl()}&x=1`, 301) : json({ ok: 1 }),
    );
    const r = await createHttpClient({ fetch: f.fetch }).espnGet(leagueUrl(), {
      signal: sig(),
      cookie,
    });
    expect(r.final_url).toBe(`${leagueUrl()}&x=1`);
    expect(f.calls.map((c) => c.headers.cookie)).toEqual([cookie, cookie]);
  });

  it("more than MAX_REDIRECT_HOPS same-host hops → too_many_redirects → ESPN_HOST_MOVED", async () => {
    const f = fakeFetch((_u, _i, n) => redirect(`${READ}/hop${String(n)}`, 302));
    const e = await failure(
      createHttpClient({ fetch: f.fetch }).espnGet(leagueUrl(), { signal: sig() }),
    );
    expect(e.kind).toBe("too_many_redirects");
    expect(classifyError(e).code).toBe("ESPN_HOST_MOVED");
    expect(f.calls).toHaveLength(MAX_REDIRECT_HOPS + 1);
  });
});

describe("espnGet: the cookie never reaches an error or a log line (plan 02 §2.3)", () => {
  it("hostile fetch errors carrying the cookie are reduced to fixed strings", async () => {
    const cookie = testCookie("Z");
    for (const code of [
      "ECONNRESET",
      "ENOTFOUND",
      "ECONNREFUSED",
      "EWHATEVER",
      "CERT_HAS_EXPIRED",
    ]) {
      const cap = captureLog();
      const c = createHttpClient({
        log: cap.log,
        fetch: () => Promise.reject(netError(code, `failed sending cookie ${cookie}`)),
      });
      const e = await failure(c.espnGet(leagueUrl(), { signal: sig(), cookie }));
      for (const text of [
        everyRendering(e),
        inspect(e, { depth: 5, showHidden: true }),
        JSON.stringify(describeForLog(e)),
        JSON.stringify(toToolError(e, "r-abc123def456")),
        JSON.stringify(cap.lines),
      ]) {
        expect(text).not.toContain(cookie);
        expect(text).not.toContain("espn_s2=");
        expect(text).not.toContain(LEAGUE);
      }
    }
  });

  it("a 5xx whose body echoes the cookie never surfaces the body", async () => {
    const cookie = testCookie("Y");
    const cap = captureLog();
    const f = fakeFetch(() => new Response(`<html>${cookie}</html>`, { status: 502 }));
    const e = await failure(
      createHttpClient({ fetch: f.fetch, log: cap.log }).espnGet(leagueUrl(), {
        signal: sig(),
        cookie,
      }),
    );
    expect(everyRendering(e)).not.toContain(cookie);
    expect(JSON.stringify(cap.lines)).not.toContain(cookie);
  });

  it("log lines say only whether a cookie was sent, and mask the league id", async () => {
    const cap = captureLog();
    const f = fakeFetch(() => json({}));
    await createHttpClient({ fetch: f.fetch, log: cap.log }).espnGet(leagueUrl(), {
      signal: sig(),
      cookie: testCookie(),
    });
    expect(cap.lines).toHaveLength(1);
    expect(cap.lines[0]?.fields).toMatchObject({
      url: `${READ}/seasons/2026/segments/0/leagues/[league]`,
      cookie: true,
      status: 200,
    });
    expect(JSON.stringify(cap.lines)).not.toContain(LEAGUE);
  });

  it.each([
    ["CR/LF injection", "espn_s2=a\r\nX-Evil: 1"],
    ["a NUL", "a\u0000b"],
    ["non-ASCII", "espn_s2=é"],
    ["empty", ""],
    ["too long", "a".repeat(MAX_COOKIE_CHARS + 1)],
  ])(
    "a malformed cookie (%s) is refused with a value-free RangeError, zero requests",
    async (_what, cookie) => {
      const f = fakeFetch(() => json({}));
      let thrown: unknown = null;
      try {
        await createHttpClient({ fetch: f.fetch }).espnGet(leagueUrl(), { signal: sig(), cookie });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(RangeError);
      if (cookie.length > 3) expect(everyRendering(thrown)).not.toContain(cookie);
      expect(f.calls).toHaveLength(0);
    },
  );

  it("malformed filter / ETag values are refused before any request", async () => {
    const f = fakeFetch(() => json({}));
    const c = createHttpClient({ fetch: f.fetch });
    await expect(c.espnGet(leagueUrl(), { signal: sig(), fantasyFilter: "{\n}" })).rejects.toThrow(
      RangeError,
    );
    await expect(c.espnGet(leagueUrl(), { signal: sig(), ifNoneMatch: "a\rb" })).rejects.toThrow(
      RangeError,
    );
    await expect(
      c.espnGet(leagueUrl(), { signal: undefined as unknown as AbortSignal }),
    ).rejects.toThrow(RangeError);
    expect(f.calls).toHaveLength(0);
  });
});

describe("espnGet: caps and the per-attempt timeout", () => {
  it("the default cap is 8 MB (plan 02 §5); more fails mid-stream; an ESPN gzip bomb stops at it", async () => {
    expect(ESPN_MAX_BODY_BYTES).toBe(8 * 1024 * 1024);
    const f = fakeFetch((_u, _i, n) =>
      n === 1
        ? ok(new Uint8Array(ESPN_MAX_BODY_BYTES + 1))
        : ok(gzipSync(Buffer.alloc(64 * 1024 * 1024)), { "content-encoding": "gzip" }),
    );
    const c = createHttpClient({ fetch: f.fetch });
    expect((await failure(c.espnGet(leagueUrl(), { signal: sig() }))).kind).toBe("too_large");
    const e = await failure(c.espnGet(leagueUrl(), { signal: sig() }));
    expect(e).toMatchObject({ kind: "too_large", espn: true });
    expect(classifyError(e).code).toBe("ESPN_UPSTREAM_UNAVAILABLE");
  });

  it.each([0, -1, ATTEMPT_TIMEOUT_MS + 1, Number.NaN])("timeoutMs %s → RangeError", async (t) => {
    const f = fakeFetch(() => json({}));
    await expect(
      createHttpClient({ fetch: f.fetch }).espnGet(leagueUrl(), { signal: sig(), timeoutMs: t }),
    ).rejects.toThrow(RangeError);
  });

  describe("fake timers", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("an attempt times out at ATTEMPT_TIMEOUT_MS (15 s) by default", async () => {
      const h = hangingFetch();
      const p = failure(
        createHttpClient({ fetch: h.fetch }).espnGet(leagueUrl(), { signal: sig() }),
      );
      await vi.advanceTimersByTimeAsync(ATTEMPT_TIMEOUT_MS - 1);
      let settled = false;
      void p.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(await p).toMatchObject({ kind: "timeout", espn: true, retryable: true });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("a shorter timeoutMs (the deadline's remainder) bounds connect and body alike", async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
      });
      const f = fakeFetch(() => new Response(stream, { status: 200 }));
      const p = failure(
        createHttpClient({ fetch: f.fetch }).espnGet(leagueUrl(), {
          signal: sig(),
          timeoutMs: 3000,
        }),
      );
      await vi.advanceTimersByTimeAsync(3001);
      expect((await p).kind).toBe("timeout");
    });
  });
});
