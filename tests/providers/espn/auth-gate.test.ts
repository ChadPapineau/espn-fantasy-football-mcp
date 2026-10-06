// auth-gate.test.ts — src/providers/espn/auth-gate.ts (plan 02 §2.1; plan 01 §10): the provider
// never reads a store; season routes are keyless; a public league is read keyless; `rejected`
// short-circuits with zero requests; required views without a credential refuse; only
// discriminating acceptances are recorded (private league; hourly while validated); the SWID is read
// from the header only to compute my_team; the probe uses the short-circuit-exempt access if offered.
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
    expect(await g.forRequest("required", "players")).toBeNull();
    expect(await g.forRequest("never", "league")).toBeNull();
    expect(a.headerCalls).toBe(0);
  });
  it("no authority / not configured: keyless, or REQUIRES_COOKIES for required views unless public", async () => {
    for (const a of [
      null,
      new FakeAuthority("not_configured", { ok: false, reason: "not_configured" }),
    ]) {
      const g = new CookieGate(a, clock, "server");
      expect(await g.forRequest("auto", "league")).toBeNull();
      expect(await reason(g.forRequest("required", "league"))).toEqual([
        "ESPN_REQUIRES_COOKIES",
        "no_credential",
      ]);
      g.learnPublic(true);
      expect(await g.forRequest("required", "league")).toBeNull();
      expect(g.configured()).toBe(false);
    }
  });
  it("configured: the header; a public league reads keyless for auto views but sends it for required ones", async () => {
    const a = new FakeAuthority("validated", { ok: true, header });
    const g = new CookieGate(a, clock, "server");
    expect(await g.forRequest("auto", "communication")).toBe(header);
    expect(await g.memberId()).toBe(SWID);
    g.learnFromBody({ settings: { isPublic: true } });
    expect(g.isPublic()).toBe(true);
    expect(await g.forRequest("auto", "league")).toBeNull();
    expect(await g.forRequest("required", "league")).toBe(header);
  });
  it("rejected: the zero-request short-circuit (ESPN_AUTH_REJECTED); keyless on a known-public league", async () => {
    const a = new FakeAuthority("rejected", { ok: true, header });
    const g = new CookieGate(a, clock, "server");
    expect(await reason(g.forRequest("auto", "league"))).toEqual([
      "ESPN_AUTH_REJECTED",
      "short_circuit",
    ]);
    g.learnPublic(true);
    expect(await g.forRequest("auto", "league")).toBeNull();
    expect(await reason(g.forRequest("required", "league"))).toEqual([
      "ESPN_AUTH_REJECTED",
      "short_circuit",
    ]);
  });
  it("a store-side not_configured after the state said stored; unreadable and invalid formats are INTERNAL", async () => {
    const nc = new CookieGate(
      new FakeAuthority("stored", { ok: false, reason: "not_configured" }),
      clock,
      "server",
    );
    expect(await nc.forRequest("auto", "league")).toBeNull();
    expect(await reason(nc.forRequest("required", "league"))).toEqual([
      "ESPN_REQUIRES_COOKIES",
      "no_credential",
    ]);
    nc.learnPublic(true);
    expect(await nc.forRequest("required", "league")).toBeNull();
    for (const r of ["unreadable", "invalid_format"] as const) {
      const g = new CookieGate(
        new FakeAuthority("stored", { ok: false, reason: r }),
        clock,
        "server",
      );
      expect(await reason(g.forRequest("auto", "league"))).toEqual(["INTERNAL", `credential_${r}`]);
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
