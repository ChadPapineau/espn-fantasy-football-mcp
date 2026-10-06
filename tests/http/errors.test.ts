// errors.test.ts — the HTTP failure taxonomy (plan 01 §4.3: a network failure is never INTERNAL;
// §6: backoff only on 429/5xx/timeouts, ENOTFOUND/ECONNREFUSED never retried; plan 05 §4.1 network
// rows; plan 02 §2.3: no secret in an error). Hostile thrown values never make the classifier throw.
import { describe, expect, it } from "vitest";
import { SOURCE_ERROR_CODES } from "../../src/config/freshness.js";
import { REQUEST_OUTCOMES } from "../../src/config/schema.js";
import {
  classifyFetchError,
  HTTP_ERROR_KINDS,
  HttpError,
  isNetworkFailure,
  isRetryableError,
  kindForCode,
  POLICY_KINDS,
  requestOutcomeOf,
} from "../../src/http/errors.js";
import { classifyError, ERROR_CODES, toToolError } from "../../src/mcp/errors.js";
import { everyRendering, netError, testCookie } from "./helpers.js";

describe("HttpError → the error contract", () => {
  it("data scope: policy refusals are INTERNAL, 429/quota RATE_LIMITED, the rest UPSTREAM_UNAVAILABLE", () => {
    for (const kind of HTTP_ERROR_KINDS) {
      const e = new HttpError({ kind });
      const code = classifyError(e).code;
      if (POLICY_KINDS.has(kind)) expect(code, kind).toBe("INTERNAL");
      else if (kind === "rate_limited" || kind === "quota_exhausted")
        expect(code, kind).toBe("RATE_LIMITED");
      else expect(code, kind).toBe("UPSTREAM_UNAVAILABLE");
      expect(e.code).toBe(`EFF_HTTP_${kind.toUpperCase()}`);
      expect(e.name).toBe("HttpError");
      expect(e.espn).toBe(false);
    }
  });

  it("ESPN scope: outages are ESPN_UPSTREAM_UNAVAILABLE, off-host redirects ESPN_HOST_MOVED", () => {
    for (const kind of HTTP_ERROR_KINDS) {
      const e = new HttpError({ kind, espn: true });
      const code = classifyError(e).code;
      if (POLICY_KINDS.has(kind)) expect(code, kind).toBe("INTERNAL");
      else if (kind === "rate_limited" || kind === "quota_exhausted")
        expect(code, kind).toBe("RATE_LIMITED");
      else if (kind === "redirect_refused" || kind === "too_many_redirects")
        expect(code, kind).toBe("ESPN_HOST_MOVED");
      else expect(code, kind).toBe("ESPN_UPSTREAM_UNAVAILABLE");
    }
  });

  it("every effCode is an ERROR_CODES and a SOURCE_ERROR_CODES value", () => {
    for (const kind of HTTP_ERROR_KINDS)
      for (const espn of [false, true]) {
        const c = new HttpError({ kind, espn }).effCode;
        expect(ERROR_CODES).toContain(c);
        expect(SOURCE_ERROR_CODES).toContain(c);
      }
  });

  it("retryable: 429, 5xx, timeouts, resets and 408 only — never dns/connect (ADV OBJ-20)", () => {
    const retryable = HTTP_ERROR_KINDS.filter((k) => new HttpError({ kind: k }).retryable);
    expect([...retryable].sort()).toEqual(["http_5xx", "rate_limited", "reset", "timeout"]);
    expect(new HttpError({ kind: "http_4xx", status: 408 }).retryable).toBe(true);
    expect(new HttpError({ kind: "http_4xx", status: 404 }).retryable).toBe(false);
    expect(new HttpError({ kind: "dns", causeCode: "ENOTFOUND" }).retryable).toBe(false);
    expect(new HttpError({ kind: "connect", causeCode: "ECONNREFUSED" }).retryable).toBe(false);
  });

  it("sanitises host, status, retry-after and cause code", () => {
    const e = new HttpError({
      kind: "http_5xx",
      host: "evil host\n<script>",
      status: 5.5,
      retryAfterS: -3,
      causeCode: "bad code; rm -rf",
    });
    expect([e.host, e.status, e.retryAfterS, e.causeCode]).toEqual([null, null, null, null]);
    expect(new HttpError({ kind: "http_5xx", status: 99 }).status).toBeNull();
    expect(new HttpError({ kind: "http_5xx", status: 600 }).status).toBeNull();
    const g = new HttpError({
      kind: "http_5xx",
      host: "github.com",
      status: 503,
      retryAfterS: 2,
      causeCode: "X_1",
    });
    expect([g.host, g.status, g.retryAfterS, g.causeCode]).toEqual(["github.com", 503, 2, "X_1"]);
  });

  it("effDetails are value-free and survive the mapper", () => {
    const e = new HttpError({ kind: "rate_limited", status: 429, retryAfterS: 7, espn: true });
    expect(e.effDetails).toEqual({
      reason: "rate_limited",
      upstream_status: 429,
      retry_after_s: 7,
    });
    expect(Object.isFrozen(e.effDetails)).toBe(true);
    const r = toToolError(e, "r-abc123def456").structuredContent.error;
    expect(r).toMatchObject({
      code: "RATE_LIMITED",
      upstream_status: 429,
      retry_after_s: 7,
      reason: "rate_limited",
    });
    expect(new HttpError({ kind: "dns" }).effDetails).toEqual({ reason: "dns" });
  });

  it("an HttpError keeps no raw cause: nothing a hostile fetch threw can be rendered from it", () => {
    const cookie = testCookie("C");
    const hostile = Object.assign(new Error(`boom ${cookie}`), {
      code: "ECONNRESET",
      headers: { cookie },
    });
    const e = classifyFetchError(
      new TypeError("fetch failed", { cause: hostile }),
      null,
      "x.example",
    );
    expect(e.kind).toBe("reset");
    expect(e.cause).toBeUndefined();
    expect(everyRendering(e)).not.toContain(cookie);
    expect(everyRendering(e)).not.toContain("boom");
    expect(JSON.stringify(toToolError(e, "r-abc123def456"))).not.toContain("boom");
  });
});

describe("requestOutcomeOf (espn_requests.outcome, the breaker's input)", () => {
  it.each([
    ["http_5xx", "server_error"],
    ["rate_limited", "rate_limited"],
    ["timeout", "timeout"],
    ["http_4xx", "client_error"],
    ["dns", "network_error"],
    ["connect", "network_error"],
    ["reset", "network_error"],
    ["tls", "network_error"],
    ["too_large", "network_error"],
    ["redirect_refused", "network_error"],
    ["network", "network_error"],
  ] as const)("%s → %s", (kind, outcome) => {
    expect(requestOutcomeOf(new HttpError({ kind }))).toBe(outcome);
    expect(REQUEST_OUTCOMES).toContain(outcome);
  });

  it("no request reached upstream → null (policy, breaker, deadline, quota, abort)", () => {
    for (const kind of [
      ...POLICY_KINDS,
      "breaker_open",
      "deadline",
      "quota_exhausted",
      "aborted",
    ] as const)
      expect(requestOutcomeOf(new HttpError({ kind })), kind).toBeNull();
  });
});

describe("classifyFetchError", () => {
  it("passes an HttpError through; our timers and the caller's abort win over the AbortError", () => {
    const h = new HttpError({ kind: "dns" });
    expect(classifyFetchError(h, "caller", null)).toBe(h);
    const abortErr = new DOMException("aborted", "AbortError");
    expect(classifyFetchError(abortErr, "connect_timeout", "github.com").causeCode).toBe(
      "CONNECT_TIMEOUT",
    );
    expect(classifyFetchError(abortErr, "total_timeout", "github.com", true)).toMatchObject({
      kind: "timeout",
      espn: true,
    });
    expect(classifyFetchError(abortErr, "caller", "github.com").kind).toBe("aborted");
    expect(classifyFetchError(abortErr, null, "github.com").kind).toBe("network");
  });

  it("walks the cause chain for a code; TimeoutError is a timeout", () => {
    expect(classifyFetchError(netError("ENOTFOUND"), null, "github.com")).toMatchObject({
      kind: "dns",
      causeCode: "ENOTFOUND",
      host: "github.com",
    });
    const deep = new Error("a", { cause: new Error("b", { cause: netError("ECONNRESET") }) });
    expect(classifyFetchError(deep, null, null).kind).toBe("reset");
    expect(classifyFetchError(new DOMException("t", "TimeoutError"), null, null).kind).toBe(
      "timeout",
    );
  });

  it("hostile errors (throwing getters, cycles, non-errors) classify as network, never throw", () => {
    const evil = new Error("x");
    for (const k of ["code", "cause", "name"])
      Object.defineProperty(evil, k, {
        get() {
          throw new Error("gotcha");
        },
      });
    expect(classifyFetchError(evil, null, null).kind).toBe("network");
    const cyc = new Error("c") as Error & { cause?: unknown };
    cyc.cause = cyc;
    expect(classifyFetchError(cyc, null, null).kind).toBe("network");
    expect(classifyFetchError("string", null, null).kind).toBe("network");
    expect(classifyFetchError(Object.assign(new Error("n"), { code: 42 }), null, null).kind).toBe(
      "network",
    );
  });

  it("kindForCode knows TLS prefixes and nothing else by accident", () => {
    expect(kindForCode("ERR_TLS_ANYTHING")).toBe("tls");
    expect(kindForCode("ERR_SSL_X")).toBe("tls");
    expect(kindForCode("EPROTO")).toBe("tls");
    expect(kindForCode("EAI_AGAIN")).toBe("dns");
    expect(kindForCode("ENOENT")).toBeNull();
    expect(kindForCode("__proto__")).toBeNull();
  });
});

describe("isRetryableError / isNetworkFailure", () => {
  it("retryable: HttpError.retryable, raw retryable codes, TimeoutError; never ENOTFOUND/ECONNREFUSED", () => {
    expect(isRetryableError(new HttpError({ kind: "reset" }))).toBe(true);
    expect(isRetryableError(new HttpError({ kind: "tls" }))).toBe(false);
    expect(isRetryableError(netError("ECONNRESET"))).toBe(true);
    expect(isRetryableError(netError("ETIMEDOUT"))).toBe(true);
    expect(isRetryableError(netError("ECONNREFUSED"))).toBe(false);
    expect(isRetryableError(netError("ENOTFOUND"))).toBe(false);
    expect(isRetryableError(netError("CERT_HAS_EXPIRED"))).toBe(false);
    expect(isRetryableError(new DOMException("t", "TimeoutError"))).toBe(true);
    expect(isRetryableError(new TypeError("fetch failed"))).toBe(false);
    expect(isRetryableError(new Error("parse error"))).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    const evil = new Error("x");
    Object.defineProperty(evil, "cause", {
      get() {
        throw new Error("gotcha");
      },
    });
    expect(isRetryableError(evil)).toBe(false);
  });

  it("network failure: any HttpError but a policy refusal or an abort; raw network-shaped errors", () => {
    expect(isNetworkFailure(new HttpError({ kind: "http_4xx", status: 404 }))).toBe(true);
    expect(isNetworkFailure(new HttpError({ kind: "tls" }))).toBe(true);
    expect(isNetworkFailure(new HttpError({ kind: "host_not_allowed" }))).toBe(false);
    expect(isNetworkFailure(new HttpError({ kind: "aborted" }))).toBe(false);
    expect(isNetworkFailure(netError("ENOTFOUND"))).toBe(true);
    expect(isNetworkFailure(new DOMException("t", "TimeoutError"))).toBe(true);
    expect(isNetworkFailure(new TypeError("fetch failed"))).toBe(true);
    expect(isNetworkFailure(new TypeError("other"))).toBe(false);
    expect(isNetworkFailure(new Error("x"))).toBe(false);
    expect(isNetworkFailure(undefined)).toBe(false);
    const evil = new TypeError("y");
    Object.defineProperty(evil, "message", {
      get() {
        throw new Error("gotcha");
      },
    });
    expect(isNetworkFailure(evil)).toBe(false);
  });
});
