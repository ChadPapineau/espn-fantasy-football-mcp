// tls-policy.test.ts — no ESPN request while certificate verification is off process-wide (plan 02
// T2: ESPN's facts are trusted on "TLS to ESPN, then zod", and the cookie is a password-equivalent).
// Stage C finding espn-tls-verify-disabled-unguarded: with an inherited NODE_TLS_REJECT_UNAUTHORIZED=0
// the cookie went to an impostor's self-signed endpoint and its body was served as league data. The
// first half injects fetch; the second runs Node's real fetch against a self-signed server on
// 127.0.0.1 (a throwaway certificate made by `openssl` into a temp dir — skipped where openssl is
// absent). No request ever goes to ESPN, and the cookie is the synthetic test header.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createEspnProvider } from "../../../src/providers/espn/index.js";
import { EspnTlsPolicyError, type FetchLike } from "../../../src/providers/espn/transport.js";
import {
  FakeAuthority,
  FakeProbeAuthority,
  FIXTURES,
  jsonResponse,
  loadFixture,
  makeWorld,
  MemoryCache,
  MemoryDrift,
  MemoryLimiterRepo,
  SEASON,
  stubScoring,
  testCookieHeader,
} from "./helpers.js";
import { fixedClock } from "../../../src/domain/clock.js";

const SWID = "{00000000-0000-4000-8000-000000000008}";
const settingsBody = (isPublic: boolean): unknown => {
  const s = structuredClone(loadFixture("recorded/league-a/mSettings.json")) as {
    settings: Record<string, unknown>;
  };
  const nav = loadFixture("recorded/league-a/mNav.json") as Record<string, unknown>;
  s.settings.isPublic = isPublic;
  return { ...s, members: nav.members, teams: nav.teams };
};

const saved = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
const setVar = (v: string | undefined): void => {
  if (v === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = v;
};
afterEach(() => {
  setVar(saved);
});

describe("verification off: the provider sends nothing (injected fetch)", () => {
  it("a cookie-bearing read: refused before the cookie is asked for; no request, no limiter row", async () => {
    setVar("0");
    const auth = new FakeAuthority("validated", { ok: true, header: testCookieHeader(SWID) });
    const logs: string[] = [];
    const w = makeWorld({
      credentials: auth,
      fetch: () => Promise.resolve(jsonResponse(settingsBody(false))),
      over: { log: { debug: () => undefined, warn: (e) => logs.push(e) } },
    });
    const e = await w.provider.getLeague(w.ref).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(EspnTlsPolicyError);
    expect(e).toMatchObject({
      effCode: "INTERNAL",
      effDetails: { reason: "tls_verification_disabled" },
    });
    expect(w.sent).toHaveLength(0);
    expect(w.limiter.rows).toHaveLength(0);
    expect(auth.headerCalls).toBe(0);
    expect(logs).toContain("espn.tls_verification_disabled");
    // the same read goes out the moment verification is on again (read at every request)
    setVar(undefined);
    await expect(w.provider.getLeague(w.ref)).resolves.toBeTruthy();
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]?.headers.cookie).toContain("SWID=");
  });

  it("a keyless read too: an unverified channel's body is never served as ESPN's facts", async () => {
    setVar("0");
    const w = makeWorld({
      fetch: () =>
        Promise.resolve(jsonResponse(loadFixture("recorded/season/proTeamSchedules_wl.json"))),
    });
    await expect(w.provider.getProSchedule(SEASON)).rejects.toBeInstanceOf(EspnTlsPolicyError);
    expect(w.sent).toHaveLength(0);
    expect(w.limiter.rows).toHaveLength(0);
    // it is our own policy refusing, not an outage: the breaker is untouched
    expect(w.provider.transportStatus().consecutive_failures).toBe(0);
  });

  it("a cached entry still answers while it is fresh (no request is needed); a refetch is refused, not served stale", async () => {
    const w = makeWorld({
      fetch: () =>
        Promise.resolve(jsonResponse(loadFixture("recorded/season/proTeamSchedules_wl.json"))),
    });
    await w.provider.getProSchedule(SEASON);
    expect(w.sent).toHaveLength(1);
    setVar("0");
    await expect(w.provider.getProSchedule(SEASON)).resolves.toBeTruthy();
    expect(w.sent).toHaveLength(1);
    // force_refresh needs a request: refused, and INTERNAL is no degraded code (fail closed)
    await expect(w.provider.getProSchedule(SEASON, { force_refresh: true })).rejects.toBeInstanceOf(
      EspnTlsPolicyError,
    );
    expect(w.sent).toHaveLength(1);
  });

  it("the credential probe sends nothing either (private and public leagues)", async () => {
    setVar("0");
    for (const isPublic of [false, true]) {
      const w = makeWorld({
        credentials: new FakeProbeAuthority("validated", {
          ok: true,
          header: testCookieHeader(SWID),
        }),
        fetch: () => Promise.resolve(jsonResponse(settingsBody(isPublic))),
      });
      await expect(w.provider.probeCredential(w.ref)).rejects.toBeInstanceOf(EspnTlsPolicyError);
      expect(w.sent).toHaveLength(0);
    }
  });

  it("a policy that cannot be read refuses (fail closed); an injected policy that says on lets it through", async () => {
    const throwing = makeWorld({
      fetch: () =>
        Promise.resolve(jsonResponse(loadFixture("recorded/season/proTeamSchedules_wl.json"))),
      over: {
        tlsVerificationDisabled: () => {
          throw new Error("unreadable");
        },
      },
    });
    await expect(throwing.provider.getProSchedule(SEASON)).rejects.toBeInstanceOf(
      EspnTlsPolicyError,
    );
    expect(throwing.sent).toHaveLength(0);
    const on = makeWorld({
      fetch: () =>
        Promise.resolve(jsonResponse(loadFixture("recorded/season/proTeamSchedules_wl.json"))),
      over: { tlsVerificationDisabled: () => false },
    });
    await expect(on.provider.getProSchedule(SEASON)).resolves.toBeTruthy();
  });

  it("fixture mode opens no connection: the variable does not stop it", async () => {
    setVar("0");
    const provider = createEspnProvider({
      config: {
        leagueId: "0",
        season: SEASON,
        teamId: null,
        espnReadHost: "lm-api-reads.fantasy.espn.com",
        fixtureRecord: false,
        fixtureDir: FIXTURES,
      },
      repos: {
        limiter: new MemoryLimiterRepo(),
        espnCache: new MemoryCache(),
        driftState: new MemoryDrift(),
      },
      credentials: null,
      clock: fixedClock("2026-10-06T12:00:00.000Z"),
      scoring: stubScoring,
    });
    await expect(provider.getProSchedule(SEASON)).resolves.toBeTruthy();
  });
});

/** A throwaway self-signed certificate (CN=evil.invalid) in a temp dir, or null without openssl. */
function selfSigned(): { dir: string; key: Buffer; cert: Buffer } | null {
  const dir = mkdtempSync(path.join(tmpdir(), "eff-tls-"));
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
  "an impostor on 127.0.0.1 with a self-signed certificate (Node's real fetch)",
  () => {
    let server: Server;
    let port = 0;
    const seen: { cookie: boolean }[] = [];
    beforeAll(async () => {
      server = createServer({ key: material!.key, cert: material!.cert }, (req, res) => {
        seen.push({ cookie: req.headers.cookie !== undefined });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(settingsBody(false)));
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
          return fetch(`https://127.0.0.1:${String(port)}${u.pathname}${u.search}`, {
            ...init,
            headers: { ...(init.headers as Record<string, string>), connection: "close" },
          });
        },
        { calls: 0 },
      );
      return f;
    };

    it("verification on: the certificate fails, ONE attempt (never retried), counted by the breaker", async () => {
      setVar(undefined);
      const fetchFn = redirected();
      const auth = new FakeAuthority("validated", { ok: true, header: testCookieHeader(SWID) });
      const w = makeWorld({ credentials: auth, fetch: fetchFn });
      const e = await w.provider.getLeague(w.ref).catch((x: unknown) => x);
      expect(e).toMatchObject({
        effCode: "ESPN_UPSTREAM_UNAVAILABLE",
        effDetails: { reason: "tls" },
      });
      expect(fetchFn.calls).toBe(1);
      expect(w.limiter.rows.map((r) => r.outcome)).toEqual(["network_error"]);
      expect(w.provider.transportStatus().consecutive_failures).toBe(1);
      expect(seen).toHaveLength(0);
    });

    it("verification off: the impostor would answer, yet the provider sends nothing — the cookie never leaves", async () => {
      setVar("0");
      const fetchFn = redirected();
      const auth = new FakeAuthority("validated", { ok: true, header: testCookieHeader(SWID) });
      const w = makeWorld({ credentials: auth, fetch: fetchFn });
      await expect(w.provider.getLeague(w.ref)).rejects.toBeInstanceOf(EspnTlsPolicyError);
      expect(fetchFn.calls).toBe(0);
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
