// auth-gate.test.ts — src/providers/espn/auth-gate.ts (plan 02 §2.1; plan 01 §10): the provider
// never reads a store; season routes are keyless; a public league is read keyless; `rejected`
// short-circuits with zero requests; the league feed goes keyless on a league known public whenever
// no accepted cookie is at hand and the caller's own data never does (changelog §R10, R10-10: the
// whole use × state × publicity matrix); only discriminating acceptances are recorded (private
// league; hourly while validated); the SWID is read from the header only to compute my_team; the
// probe uses the short-circuit-exempt access if offered.
import { describe, expect, it } from "vitest";
import { fixedClock } from "../../../src/domain/clock.js";
import {
  ACCEPT_OBSERVE_INTERVAL_MS,
  CookieGate,
  EspnCredentialError,
  hasProbeAccess,
  swidFromHeader,
} from "../../../src/providers/espn/auth-gate.js";
import { FakeAuthority, FakeProbeAuthority, NOW_ISO, testCookieHeader } from "./helpers.js";

const SWID = "{00000000-0000-4000-8000-000000000003}";
const header = testCookieHeader(SWID);
const reason = async (p: Promise<unknown>): Promise<[string, string]> => {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(EspnCredentialError);
  return [(e as EspnCredentialError).effCode, (e as EspnCredentialError).effDetails.reason];
};

describe("swidFromHeader / hasProbeAccess", () => {
  it("reads only a well-formed braced SWID cookie", () => {
    expect(swidFromHeader(header)).toBe(SWID);
    expect(swidFromHeader(`SWID=${SWID}`)).toBe(SWID);
    expect(swidFromHeader("espn_s2=x; SWID=00000000-0000-4000-8000-000000000003")).toBeNull();
    expect(swidFromHeader(`XSWID=${SWID}`)).toBeNull();
    expect(swidFromHeader("")).toBeNull();
  });
  it("detects the probe access", () => {
    expect(hasProbeAccess(new FakeProbeAuthority("validated", { ok: true, header }))).toBe(true);
    expect(hasProbeAccess(new FakeAuthority("validated", { ok: true, header }))).toBe(false);
  });
});

describe("forRequest", () => {
  const clock = fixedClock(NOW_ISO);
  it("season routes and `never` are keyless without asking the authority", async () => {
    const a = new FakeAuthority("validated", { ok: true, header });
    const g = new CookieGate(a, clock, "server");
    expect(await g.forRequest("auto", "season")).toBeNull();
    expect(await g.forRequest("own", "players")).toBeNull();
    expect(await g.forRequest("feed", "season")).toBeNull();
    expect(await g.forRequest("never", "league")).toBeNull();
    expect(a.headerCalls).toBe(0);
  });
  it("configured: the header; a public league reads keyless for auto views but sends it for the feed and own data", async () => {
    const a = new FakeAuthority("validated", { ok: true, header });
    const g = new CookieGate(a, clock, "server");
    expect(await g.forRequest("auto", "communication")).toBe(header);
    expect(await g.memberId()).toBe(SWID);
    g.learnFromBody({ settings: { isPublic: true } });
    expect(g.isPublic()).toBe(true);
    expect(await g.forRequest("auto", "league")).toBeNull();
    expect(await g.forRequest("feed", "league")).toBe(header);
    expect(await g.forRequest("own", "league")).toBe(header);
  });
  it("a store-side not_configured after the state said stored; unreadable and invalid formats are INTERNAL", async () => {
    const nc = new CookieGate(
      new FakeAuthority("stored", { ok: false, reason: "not_configured" }),
      clock,
      "server",
    );
    expect(await nc.forRequest("auto", "league")).toBeNull();
    expect(await reason(nc.forRequest("feed", "league"))).toEqual([
      "ESPN_REQUIRES_COOKIES",
      "no_credential",
    ]);
    nc.learnPublic(true);
    expect(await nc.forRequest("feed", "league")).toBeNull();
    expect(await reason(nc.forRequest("own", "league"))).toEqual([
      "ESPN_REQUIRES_COOKIES",
      "no_credential",
    ]);
    for (const r of ["unreadable", "invalid_format"] as const) {
      const g = new CookieGate(
        new FakeAuthority("stored", { ok: false, reason: r }),
        clock,
        "server",
      );
      for (const use of ["auto", "feed", "own"] as const)
        expect(await reason(g.forRequest(use, "league"))).toEqual(["INTERNAL", `credential_${r}`]);
    }
  });
  it("learnFromBody ignores bodies without a boolean settings.isPublic", () => {
    const g = new CookieGate(null, clock, "server");
    for (const b of [null, 5, {}, { settings: null }, { settings: { isPublic: "yes" } }])
      g.learnFromBody(b);
    expect(g.isPublic()).toBeNull();
    g.learnFromBody({ settings: { isPublic: false } });
    expect(g.isPublic()).toBe(false);
  });
});

/**
 * changelog §R10, R10-10: every (use × credential state × publicity) cell. `feed` (mTransactions2,
 * served to anyone on a public league) goes keyless on a league known public whenever no accepted
 * cookie is at hand; `own` (mPendingTransactions, the caller's own) never goes keyless; `auto` with
 * nothing stored goes keyless only while the publicity is unknown (changelog §R10, R10-23: known
 * private, it is ESPN_REQUIRES_COOKIES with zero requests). Publicity is known one way, in both
 * credential branches: what this process saw, else the value another process kept — so each
 * "public"/"private" cell is run both ways.
 */
describe("the cookie-use matrix (changelog §R10, R10-10)", () => {
  type State = "none" | "not_configured" | "validated" | "rejected";
  type Publicity = "unknown" | "public" | "private";
  type Want = "header" | "keyless" | "ESPN_REQUIRES_COOKIES" | "ESPN_AUTH_REJECTED";
  const authority = (st: State): FakeAuthority | null => {
    if (st === "none") return null;
    if (st === "not_configured")
      return new FakeAuthority("not_configured", { ok: false, reason: "not_configured" });
    return new FakeAuthority(st, { ok: true, header });
  };
  /** What a server-process read gets (keylessOnPublic: true). */
  const want = (use: "auto" | "feed" | "own", st: State, pub: Publicity): Want => {
    const noSession = st === "none" || st === "not_configured";
    if (st === "validated") return use === "auto" && pub === "public" ? "keyless" : "header";
    if (use === "own") return noSession ? "ESPN_REQUIRES_COOKIES" : "ESPN_AUTH_REJECTED";
    if (pub === "public") return "keyless";
    // the learning read only while the publicity is unknown; known private refuses with zero
    // requests (changelog §R10, R10-23)
    if (use === "auto" && noSession && pub === "unknown") return "keyless";
    return noSession ? "ESPN_REQUIRES_COOKIES" : "ESPN_AUTH_REJECTED";
  };
  const got = async (g: CookieGate, use: "auto" | "feed" | "own"): Promise<Want> => {
    try {
      const h = await g.forRequest(use, "league");
      return h === header ? "header" : h === null ? "keyless" : (`unexpected ${h}` as Want);
    } catch (e) {
      expect(e).toBeInstanceOf(EspnCredentialError);
      const err = e as EspnCredentialError;
      expect(err.effDetails.reason).toBe(
        err.effCode === "ESPN_AUTH_REJECTED" ? "short_circuit" : "no_credential",
      );
      return err.effCode as Want;
    }
  };
  const cells: [State, Publicity, "seen" | "kept"][] = [];
  for (const st of ["none", "not_configured", "validated", "rejected"] as const)
    for (const pub of ["unknown", "public", "private"] as const)
      for (const how of pub === "unknown" ? (["seen"] as const) : (["seen", "kept"] as const))
        cells.push([st, pub, how]);

  it.each(cells)("state %s, publicity %s (%s)", async (st, pub, how) => {
    for (const use of ["auto", "feed", "own"] as const) {
      const a = authority(st);
      const kept = how === "kept" && pub !== "unknown" ? pub === "public" : null;
      const g = new CookieGate(a, fixedClock(NOW_ISO), "server", {
        load: () => kept,
        save: () => undefined,
      });
      if (how === "seen" && pub !== "unknown") g.learnPublic(pub === "public");
      expect(await got(g, use), `${use} / ${st} / ${pub} (${how})`).toBe(want(use, st, pub));
      // a rejected cookie is never handed out, whatever the use
      if (st === "rejected") expect(await got(g, use)).not.toBe("header");
    }
  });

  it("the jobs (keylessOnPublic false): auto sends the stored cookie on a public league; feed and own are the server's", async () => {
    for (const st of ["none", "not_configured", "validated", "rejected"] as const)
      for (const pub of ["unknown", "public", "private"] as const)
        for (const use of ["auto", "feed", "own"] as const) {
          const g = new CookieGate(authority(st), fixedClock(NOW_ISO), "daily_job", null, {
            keylessOnPublic: false,
          });
          if (pub !== "unknown") g.learnPublic(pub === "public");
          const server = want(use, st, pub);
          const expected = use === "auto" && st === "validated" ? "header" : server;
          expect(await got(g, use), `${use} / ${st} / ${pub}`).toBe(expected);
        }
  });

  it("own data refuses with zero asks of the network and never reads the publicity it does not need", async () => {
    const a = new FakeAuthority("rejected", { ok: true, header });
    let loads = 0;
    const g = new CookieGate(a, fixedClock(NOW_ISO), "server", {
      load: () => {
        loads++;
        return true;
      },
      save: () => undefined,
    });
    expect(await got(g, "own")).toBe("ESPN_AUTH_REJECTED");
    expect(loads).toBe(0);
    // the feed on the same gate reads the kept value once and goes keyless
    expect(await got(g, "feed")).toBe("keyless");
    expect(await got(g, "feed")).toBe("keyless");
    expect(loads).toBe(1);
  });

  it("rejectedNow follows the authority's label, never a store read", () => {
    const a = new FakeAuthority("validated", { ok: true, header });
    const g = new CookieGate(a, fixedClock(NOW_ISO), "server");
    expect(g.rejectedNow()).toBe(false);
    a.current = "rejected";
    expect(g.rejectedNow()).toBe(true);
    expect(a.headerCalls).toBe(0);
    expect(new CookieGate(null, fixedClock(NOW_ISO), "server").rejectedNow()).toBe(false);
  });
});

describe("observations (plan 02 §2.1: only discriminating ones count)", () => {
  it("rejections always; acceptances only on a private league, hourly while validated", async () => {
    const clock = fixedClock(NOW_ISO);
    const a = new FakeAuthority("stored", { ok: true, header });
    const g = new CookieGate(a, clock, "server");
    await g.observe("accepted", 200, "mSettings");
    expect(a.observations).toEqual([]);
    g.learnPublic(true);
    await g.observe("accepted", 200, "mSettings");
    expect(a.observations).toEqual([]);
    g.learnPublic(false);
    await g.observe("accepted", 200, "mSettings");
    await g.observe("accepted", 200, "mRoster");
    expect(a.observations).toEqual([
      { kind: "accepted", at: NOW_ISO, by: "server", upstream_status: 200, view: "mSettings" },
    ]);
    clock.advance(ACCEPT_OBSERVE_INTERVAL_MS);
    await g.observe("accepted", 200, "mRoster");
    expect(a.observations).toHaveLength(2);
    await g.observe("rejected", 401, "mRoster");
    expect(a.observations.at(-1)).toMatchObject({ kind: "rejected", upstream_status: 401 });
    await new CookieGate(null, clock, "server").observe("rejected", 401, "mRoster");
  });
  it("a failing observe never throws out of the gate", async () => {
    const a = new FakeAuthority("validated", { ok: true, header });
    a.observe = () => Promise.reject(new Error("row busy"));
    const g = new CookieGate(a, fixedClock(NOW_ISO), "server");
    await g.observe("rejected", 401, "mRoster");
    await g.observeProbe("accepted", "check_auth", 200, "mSettings");
    await new CookieGate(null, fixedClock(NOW_ISO), "server").observeProbe(
      "accepted",
      "doctor",
      200,
      "mSettings",
    );
  });
});

describe("memberId and probeHeader", () => {
  it("memberId: cached from a header, read lazily, null without a credential or on failure", async () => {
    expect(await new CookieGate(null, fixedClock(NOW_ISO), "server").memberId()).toBeNull();
    const a = new FakeAuthority("validated", { ok: true, header });
    const g = new CookieGate(a, fixedClock(NOW_ISO), "server");
    expect(await g.memberId()).toBe(SWID);
    expect(await g.memberId()).toBe(SWID);
    expect(a.headerCalls).toBe(1);
    const rej = new CookieGate(
      new FakeAuthority("rejected", { ok: true, header }),
      fixedClock(NOW_ISO),
      "server",
    );
    expect(await rej.memberId()).toBeNull();
  });
  it("probeHeader prefers the short-circuit-exempt access", async () => {
    const p = new FakeProbeAuthority("rejected", { ok: true, header });
    const g = new CookieGate(p, fixedClock(NOW_ISO), "server");
    expect(await g.probeHeader()).toEqual({ ok: true, header });
    expect(p.probeCalls).toBe(1);
    expect(await g.memberId()).toBe(SWID);
    const plain = new CookieGate(
      new FakeAuthority("rejected", { ok: true, header }),
      fixedClock(NOW_ISO),
      "server",
    );
    expect(await plain.probeHeader()).toEqual({ ok: false, reason: "rejected" });
    expect(await new CookieGate(null, fixedClock(NOW_ISO), "server").probeHeader()).toBeNull();
  });
});

describe("needsPublicity (plan 02 §2.1: rejected → try anonymously once)", () => {
  it("only while rejected with publicity unknown", () => {
    const clock = fixedClock(NOW_ISO);
    expect(new CookieGate(null, clock, "server").needsPublicity()).toBe(false);
    expect(
      new CookieGate(
        new FakeAuthority("validated", { ok: true, header }),
        clock,
        "server",
      ).needsPublicity(),
    ).toBe(false);
    const g = new CookieGate(new FakeAuthority("rejected", { ok: true, header }), clock, "server");
    expect(g.needsPublicity()).toBe(true);
    g.learnPublic(false);
    expect(g.needsPublicity()).toBe(false);
  });
});
