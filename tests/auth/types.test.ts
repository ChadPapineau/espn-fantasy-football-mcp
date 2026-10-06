// types.test.ts — src/auth/types.ts: the credential state machine exactly as plan 02 §2.1 draws it
// (plus the one recorded reading: stored + cookie_accepted → validated), the observation → event
// mapping (an ordinary request vs a probe), the pure row update (accepted clears the rejection
// fields; a repeated rejection keeps `rejected_since`), and the format constants (ADV OBJ-15).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fakeEspnS2, fakeGuid } from "../../scripts/ci/secret-fixtures.mjs";
import { CREDENTIAL_STATES } from "../../src/config/schema.js";
import {
  CREDENTIAL_EVENTS,
  CREDENTIAL_FORMAT_VERSION,
  CREDENTIAL_TRANSITIONS,
  DAILY_PROBE_MAX,
  ESPN_S2_MAX_CHARS,
  ESPN_S2_MIN_CHARS,
  ESPN_S2_RE,
  ESPN_S2_WARN_BELOW_CHARS,
  FINGERPRINT_RE,
  KEYCHAIN_ACCOUNTS,
  KEYCHAIN_SERVICE,
  SELFTEST_SERVICE_SUFFIX,
  STALE_CREDENTIAL_DAYS,
  SWID_RE,
  TEST_SERVICE_PREFIX,
  applyObservation,
  nextCredentialState,
  observationEvent,
  type CredentialEvent,
  type CredentialObservation,
  type CredentialState,
  type CredentialStateRow,
} from "../../src/auth/types.js";

const T0 = "2026-10-01T12:00:00.000Z";
const T1 = "2026-10-05T18:00:00.000Z";
const row = (
  state: CredentialState,
  over: Partial<CredentialStateRow> = {},
): CredentialStateRow => ({
  league_id: "0",
  state,
  store: "keychain",
  stored_at: T0,
  last_accepted_at: null,
  last_rejected_at: null,
  rejected_since: null,
  next_probe_at: null,
  rejected_view: null,
  board_probe_discriminates: null,
  updated_at: T0,
  updated_by: "setup",
  ...over,
});
const obs = (over: Partial<CredentialObservation>): CredentialObservation => ({
  kind: "accepted",
  at: T1,
  by: "server",
  upstream_status: 200,
  view: "mRoster",
  ...over,
});

describe("the transition table (plan 02 §2.1)", () => {
  it("is keyed by every state; every target is a state; every event is known", () => {
    expect(Object.keys(CREDENTIAL_TRANSITIONS).sort()).toEqual([...CREDENTIAL_STATES].sort());
    for (const [from, edges] of Object.entries(CREDENTIAL_TRANSITIONS))
      for (const [ev, to] of Object.entries(edges)) {
        expect(CREDENTIAL_EVENTS, `${from}:${ev}`).toContain(ev);
        expect(CREDENTIAL_STATES, `${from}:${ev}`).toContain(to);
      }
  });
  it.each([
    ["not_configured", "setup_stored", "stored"],
    ["stored", "setup_probe_accepted", "validated"],
    ["stored", "probe_accepted", "validated"],
    ["stored", "cookie_accepted", "validated"],
    ["stored", "setup_probe_rejected", "not_configured"],
    ["stored", "setup_league_not_found", "not_configured"],
    ["stored", "cookie_rejected", "rejected"],
    ["validated", "cookie_accepted", "validated"],
    ["validated", "probe_accepted", "validated"],
    ["validated", "cookie_rejected", "rejected"],
    ["rejected", "probe_accepted", "validated"],
    ["rejected", "cookie_rejected", "rejected"],
    ["rejected", "setup_rerun", "stored"],
    ["validated", "setup_rerun", "stored"],
    ["stored", "reset", "not_configured"],
    ["validated", "reset", "not_configured"],
    ["rejected", "reset", "not_configured"],
  ] as const)("%s + %s → %s", (from, ev, to) => {
    expect(nextCredentialState(from, ev)).toBe(to);
  });
  it.each([
    ["not_configured", "cookie_accepted"],
    ["not_configured", "probe_accepted"],
    ["not_configured", "cookie_rejected"],
    ["not_configured", "reset"],
    ["rejected", "cookie_accepted"],
    ["rejected", "setup_probe_accepted"],
    ["validated", "setup_stored"],
    ["validated", "setup_league_not_found"],
  ] as const)("%s + %s is not a transition", (from, ev) => {
    expect(nextCredentialState(from, ev)).toBeNull();
  });
  it("an ordinary call can never move rejected to validated (only a probe can)", () => {
    expect(nextCredentialState("rejected", "cookie_accepted")).toBeNull();
    expect(nextCredentialState("rejected", "probe_accepted")).toBe("validated");
  });
  it("property: reset always lands in not_configured from a configured state", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<CredentialState>("stored", "validated", "rejected"),
        (s) => nextCredentialState(s, "reset") === "not_configured",
      ),
    );
  });
});

describe("observationEvent", () => {
  it.each([
    [{ kind: "rejected", by: "server" }, "cookie_rejected"],
    // plan 02 §2.1: setup's own 401/403 deletes the value → not_configured, never `rejected`
    [{ kind: "rejected", by: "setup" }, "setup_probe_rejected"],
    [{ kind: "rejected", by: "check_auth" }, "cookie_rejected"],
    [{ kind: "rejected", by: "doctor" }, "cookie_rejected"],
    [{ kind: "rejected", by: "daily_job" }, "cookie_rejected"],
    [{ kind: "accepted", by: "server" }, "cookie_accepted"],
    [{ kind: "accepted", by: "setup" }, "setup_probe_accepted"],
    [{ kind: "accepted", by: "doctor" }, "probe_accepted"],
    [{ kind: "accepted", by: "check_auth" }, "probe_accepted"],
    [{ kind: "accepted", by: "daily_job" }, "probe_accepted"],
    [{ kind: "league_not_found", by: "setup" }, "setup_league_not_found"],
  ] as const)("%j → %s", (o, ev: CredentialEvent) => {
    expect(observationEvent(o)).toBe(ev);
  });
  it.each(["server", "doctor", "check_auth", "daily_job"] as const)(
    "a 404 seen by %s is not a credential event (null — nothing recorded)",
    (by) => {
      expect(observationEvent({ kind: "league_not_found", by })).toBeNull();
    },
  );
  it("property: every observation maps to a known event or null, never throws", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<CredentialObservation["kind"]>("accepted", "rejected", "league_not_found"),
        fc.constantFrom<CredentialObservation["by"]>(
          "setup",
          "server",
          "doctor",
          "check_auth",
          "daily_job",
        ),
        (kind, by) => {
          const ev = observationEvent({ kind, by });
          return ev === null || (CREDENTIAL_EVENTS as readonly string[]).includes(ev);
        },
      ),
    );
  });
});

describe("the two setup failure paths (plan 02 §2.1 diagram; S2)", () => {
  const stored = row("stored", {
    last_rejected_at: T0,
    rejected_since: T0,
    rejected_view: "mSettings",
    next_probe_at: T1,
    board_probe_discriminates: true,
  });
  it.each([
    ["setup probe 401/403", obs({ kind: "rejected", by: "setup", upstream_status: 401 })],
    ["setup mSettings 404", obs({ kind: "league_not_found", by: "setup", upstream_status: 404 })],
  ] as const)(
    "%s → not_configured with every observation of the deleted value cleared",
    (_n, o) => {
      const out = applyObservation(stored, o);
      expect(out).toEqual({
        ...stored,
        state: "not_configured",
        stored_at: null,
        last_accepted_at: null,
        last_rejected_at: null,
        rejected_since: null,
        rejected_view: null,
        next_probe_at: null,
        board_probe_discriminates: null,
        updated_at: T1,
        updated_by: "setup",
      });
      // a not_configured row answers ESPN_REQUIRES_COOKIES, never ESPN_AUTH_REJECTED
      expect(out.state).not.toBe("rejected");
    },
  );
  it("a non-setup 404 leaves the row untouched (the identical object)", () => {
    const v = row("validated");
    expect(applyObservation(v, obs({ kind: "league_not_found", by: "check_auth" }))).toBe(v);
    expect(applyObservation(v, obs({ kind: "league_not_found", by: "server" }))).toBe(v);
  });
  it("setup's rejection outside `stored` is not a transition (validated stays validated)", () => {
    const v = row("validated");
    expect(applyObservation(v, obs({ kind: "rejected", by: "setup" }))).toBe(v);
  });
});

describe("applyObservation (pure)", () => {
  it("an acceptance validates and clears the rejection fields", () => {
    const r = row("stored", {
      rejected_view: "mRoster",
      next_probe_at: T0,
      rejected_since: T0,
      last_rejected_at: T0,
    });
    const out = applyObservation(r, obs({}));
    expect(out).toEqual({
      ...r,
      state: "validated",
      last_accepted_at: T1,
      rejected_since: null,
      rejected_view: null,
      next_probe_at: null,
      updated_at: T1,
      updated_by: "server",
    });
    expect(r.state).toBe("stored");
  });
  it("a first rejection records since/view; a repeated one keeps the original since", () => {
    const first = applyObservation(
      row("validated"),
      obs({ kind: "rejected", upstream_status: 401, view: "mTeam" }),
    );
    expect(first).toMatchObject({
      state: "rejected",
      rejected_since: T1,
      last_rejected_at: T1,
      rejected_view: "mTeam",
    });
    const T2 = "2026-10-06T09:00:00.000Z";
    const again = applyObservation(
      first,
      obs({ kind: "rejected", at: T2, by: "daily_job", view: null }),
    );
    expect(again).toMatchObject({
      state: "rejected",
      rejected_since: T1,
      last_rejected_at: T2,
      rejected_view: "mTeam",
      updated_by: "daily_job",
    });
  });
  it("a probe acceptance recovers from rejected", () => {
    const r = row("rejected", { rejected_since: T0, rejected_view: "mRoster", next_probe_at: T1 });
    expect(applyObservation(r, obs({ by: "check_auth" }))).toMatchObject({
      state: "validated",
      rejected_since: null,
      rejected_view: null,
      next_probe_at: null,
      updated_by: "check_auth",
    });
  });
  it("a non-transition returns the identical row (no acceptance recorded while rejected by a server call)", () => {
    const r = row("rejected", { rejected_since: T0 });
    expect(applyObservation(r, obs({ by: "server" }))).toBe(r);
    const nc = row("not_configured");
    expect(applyObservation(nc, obs({ kind: "rejected" }))).toBe(nc);
  });
  it("the setup probe's acceptance moves stored to validated", () => {
    expect(applyObservation(row("stored"), obs({ by: "setup" })).state).toBe("validated");
  });
});

describe("format and storage constants", () => {
  it("SWID: a braced GUID only", () => {
    expect(SWID_RE.test(`{${fakeGuid("auth-test")}}`)).toBe(true);
    for (const bad of [
      fakeGuid("auth-test"),
      `{${fakeGuid("auth-test")}`,
      "{not-a-guid}",
      `{${fakeGuid("a")}} `,
    ])
      expect(SWID_RE.test(bad), bad).toBe(false);
  });
  it("espn_s2: URL-encoded alphabet; no whitespace, quotes or semicolons", () => {
    expect(ESPN_S2_RE.test(fakeEspnS2("auth-test", 200))).toBe(true);
    for (const bad of ["a b", 'a"b', "a;b", "a\nb", "", "a,b"])
      expect(ESPN_S2_RE.test(bad), JSON.stringify(bad)).toBe(false);
    expect(ESPN_S2_MIN_CHARS).toBe(40);
    expect(ESPN_S2_WARN_BELOW_CHARS).toBe(100);
    expect(ESPN_S2_MAX_CHARS).toBe(4096);
  });
  it("keychain names, fingerprint grammar, versions and probe caps", () => {
    expect(KEYCHAIN_SERVICE).toBe("espn-fantasy-football-mcp");
    expect(KEYCHAIN_ACCOUNTS).toEqual({ espn_s2: "espn_s2", swid: "SWID", meta: "meta" });
    expect(SELFTEST_SERVICE_SUFFIX).toBe("-selftest");
    expect(TEST_SERVICE_PREFIX).toBe("eff-test-");
    expect(FINGERPRINT_RE.test("0a1b2c")).toBe(true);
    expect(FINGERPRINT_RE.test("0A1B2C")).toBe(false);
    expect(FINGERPRINT_RE.test("0a1b2c3")).toBe(false);
    expect(CREDENTIAL_FORMAT_VERSION).toBe(1);
    expect(STALE_CREDENTIAL_DAYS).toBe(30);
    expect(DAILY_PROBE_MAX).toEqual({ in_season: 2, off_season: 1 });
  });
});
