// espn-http-tls.test.ts — the CLI's own ESPN requests (src/cli/espn-http.ts over src/http's
// `espnGet`: `eff setup`'s anonymous and cookie-bearing probes and its mTeam resolution, `eff probe`,
// `eff doctor --online`, the espn season sources) send nothing while certificate verification is off
// process-wide (plan 02 T2; Stage C finding espn-tls-verify-disabled-unguarded: the provider was
// fixed first, and this path still sent espn_s2 and SWID to a self-signed impostor and read its
// bodies). Injected fetch first; then Node's real fetch against a self-signed server on 127.0.0.1 (a
// throwaway certificate made by `openssl` into a temp dir — skipped where openssl is absent). The
// cookie is the synthetic test header; no request ever goes to ESPN.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createSetupNetwork, espnRequest, seasonGet } from "../../src/cli/espn-http.js";
import { ESPN_READ_HOST_DEFAULT } from "../../src/config/schema.js";
import { fixedClock } from "../../src/domain/clock.js";
import { createHttpClient, type FetchLike } from "../../src/http/client.js";
import { HttpError, isRetryableError, requestOutcomeOf } from "../../src/http/errors.js";
import { MemoryLimiterRepo, testCookieHeader } from "../providers/espn/helpers.js";

const SWID = "{00000000-0000-4000-8000-000000000009}";
const LEAGUE = { host: ESPN_READ_HOST_DEFAULT, season: 2026, leagueId: "0" };
const URL0 = `https://${ESPN_READ_HOST_DEFAULT}/apis/v3/games/ffl/seasons/2026/segments/0/leagues/0?view=mSettings`;

const saved = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
const setVar = (v: string | undefined): void => {
  if (v === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = v;
};
afterEach(() => {
  setVar(saved);
});

/** The setup network over the REAL http client and an in-memory limiter table. */
function setupWorld(fetchFn: FetchLike) {
  const limiter = new MemoryLimiterRepo();
  const clock = fixedClock("2026-10-19T12:00:00.000Z");
  const deps = {
    http: createHttpClient({ fetch: fetchFn, espnReadHost: ESPN_READ_HOST_DEFAULT }),
    limiter,
    clock,
    origin: "server" as const,
    sleep: (ms: number) => {
      clock.advance(ms);
      return Promise.resolve();
    },
  };
  return { deps, limiter, net: createSetupNetwork(deps, LEAGUE) };
}

const answering = (): FetchLike & { calls: number } => {
  const f = Object.assign(
    (): Promise<Response> => {
      f.calls++;
      return Promise.resolve(
        new Response(JSON.stringify({ teams: [{ id: 7, owners: [SWID] }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
    { calls: 0 },
  );
  return f;
};

describe("verification off: the CLI sends nothing (injected fetch)", () => {
  it("every setup request is refused before the limiter: no request, no row, the code named", async () => {
    setVar("0");
    const f = answering();
    const { net, limiter } = setupWorld(f);
    const header = testCookieHeader(SWID);
    expect(await net.anonymousSettings()).toEqual({ error: "tls_verification_disabled" });
    expect(await net.anonymousBoard()).toEqual({ error: "tls_verification_disabled" });
    expect(await net.settingsWithCookies(header)).toEqual({ error: "tls_verification_disabled" });
    expect(await net.boardWithCookies(header)).toEqual({ error: "tls_verification_disabled" });
    expect(await net.resolveTeam(header, SWID)).toEqual({
      kind: "error",
      code: "tls_verification_disabled",
    });
    expect(f.calls).toBe(0);
    expect(limiter.rows).toHaveLength(0);
    // read at every request, as Node reads it: verification on again → the same request goes out
    setVar(undefined);
    expect(await net.resolveTeam(header, SWID)).toEqual({ kind: "one", teamId: 7 });
    expect(f.calls).toBe(1);
  });

  it("only Node's exact rule turns it off: other spellings leave verification (and the request) on", async () => {
    for (const v of ["false", "", " 0", "00", "no", "1"]) {
      setVar(v);
      const f = answering();
      const { deps } = setupWorld(f);
      const r = await espnRequest(deps, { url: URL0, cookie: null });
      expect("status" in r ? r.status : r.error, JSON.stringify(v)).toBe(200);
      expect(f.calls).toBe(1);
    }
  });

  it("espnGet itself refuses (the last line): cookie-bearing and keyless, nothing sent, nothing logged of the cookie", async () => {
    setVar("0");
    const f = answering();
    const warned: { event: string; fields: unknown }[] = [];
    const http = createHttpClient({
      fetch: f,
      log: {
        debug: () => undefined,
        warn: (event, fields) => warned.push({ event, fields }),
      },
    });
    const header = testCookieHeader(SWID);
    for (const cookie of [header, null]) {
      const e = await http
        .espnGet(URL0, { signal: new AbortController().signal, cookie })
        .catch((x: unknown) => x);
      expect(e).toBeInstanceOf(HttpError);
      expect(e).toMatchObject({
        kind: "tls_verification_disabled",
        effCode: "INTERNAL",
        espn: true,
        retryable: false,
      });
      // our own policy refusing: no upstream verdict, so no outcome for the breaker
      expect(requestOutcomeOf(e as HttpError)).toBeNull();
    }
    expect(f.calls).toBe(0);
    expect(warned.map((w) => w.event)).toEqual([
      "http.tls_verification_disabled",
      "http.tls_verification_disabled",
    ]);
    expect(JSON.stringify(warned)).not.toContain(header);
  });

  it("the keyless season sources fail closed as a policy error (INTERNAL, never retried)", async () => {
    setVar("0");
    const f = answering();
    const { deps, limiter } = setupWorld(f);
    const get = seasonGet(deps);
    const e = await get(
      `https://${ESPN_READ_HOST_DEFAULT}/apis/v3/games/ffl/seasons/2026?view=proTeamSchedules_wl`,
      {
        signal: new AbortController().signal,
        maxBytes: 1_000_000,
      },
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect(e).toMatchObject({ kind: "tls_verification_disabled", effCode: "INTERNAL" });
    expect(isRetryableError(e)).toBe(false);
    expect(f.calls).toBe(0);
    expect(limiter.rows).toHaveLength(0);
  });
});

/** A throwaway self-signed certificate (CN=evil.invalid) in a temp dir, or null without openssl. */
function selfSigned(): { dir: string; key: Buffer; cert: Buffer } | null {
  const dir = mkdtempSync(path.join(tmpdir(), "eff-cli-tls-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        path.join(dir, "key.pem"),
        "-out",
        path.join(dir, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=evil.invalid",
      ],
      { stdio: "ignore", timeout: 20_000 },
    );
    return {
      dir,
      key: readFileSync(path.join(dir, "key.pem")),
      cert: readFileSync(path.join(dir, "cert.pem")),
    };
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

const material = selfSigned();

describe.skipIf(material === null)(
  "eff setup's network against an impostor on 127.0.0.1 with a self-signed certificate (Node's real fetch)",
  () => {
    let server: Server;
    let port = 0;
    const seen: { cookie: boolean }[] = [];
    beforeAll(async () => {
      server = createServer({ key: material!.key, cert: material!.cert }, (req, res) => {
        seen.push({ cookie: req.headers.cookie !== undefined });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: 0, teams: [{ id: 7, owners: [SWID] }] }));
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const a = server.address();
      port = typeof a === "object" && a !== null ? a.port : 0;
    });
    afterAll(async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => {
        server.close(() => {
          r();
        });
      });
      rmSync(material!.dir, { recursive: true, force: true });
    });
    /** The read host's request, answered by the impostor (what an on-path attacker does). */
    const redirected = (): FetchLike & { calls: number } => {
      const f = Object.assign(
        (url: string, init: RequestInit): Promise<Response> => {
          f.calls++;
          const u = new URL(url);
          const h = new Headers(init.headers);
          h.set("connection", "close");
          return fetch(`https://127.0.0.1:${String(port)}${u.pathname}${u.search}`, {
            ...init,
            headers: h,
          });
        },
        { calls: 0 },
      );
      return f;
    };

    it("verification on: the certificate fails (`tls`); the impostor never sees a request", async () => {
      setVar(undefined);
      const f = redirected();
      const { net } = setupWorld(f);
      expect(await net.settingsWithCookies(testCookieHeader(SWID))).toEqual({ error: "tls" });
      expect(f.calls).toBe(1);
      expect(seen).toHaveLength(0);
    });

    it("verification off: the impostor would answer, yet setup sends nothing — espn_s2 and SWID never leave", async () => {
      setVar("0");
      const f = redirected();
      const { net, limiter } = setupWorld(f);
      const header = testCookieHeader(SWID);
      expect(await net.settingsWithCookies(header)).toEqual({ error: "tls_verification_disabled" });
      expect(await net.resolveTeam(header, SWID)).toEqual({
        kind: "error",
        code: "tls_verification_disabled",
      });
      expect(f.calls).toBe(0);
      expect(limiter.rows).toHaveLength(0);
      expect(seen).toHaveLength(0);
      // the control: with the variable set, Node's fetch itself does accept the impostor (keyless)
      const r = await fetch(`https://127.0.0.1:${String(port)}/control`, {
        headers: { connection: "close" },
      });
      expect(r.status).toBe(200);
      expect(seen).toEqual([{ cookie: false }]);
    });
  },
);
