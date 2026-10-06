// selftest.test.ts — src/auth/selftest.ts (plan 02 §2.2 "One store per install"; plan 03 §2.1
// step 4; ADV OBJ-05, OBJ-25): the outcome is ok only when the launchd agent read back exactly the
// throwaway value; a hang is `timeout` within the bound; a failed write, a missing item, a mismatch
// or an agent error is `error`; the throwaway item is deleted in every case; the agent is given the
// service/account only and reports a digest, never the value; anything but ok selects the file store.
import { describe, expect, it } from "vitest";
import { SELFTEST_ACCOUNT, selftestServiceOf } from "../../src/auth/keychain.js";
import {
  runKeychainSelftest,
  selftestDigest,
  selftestReadOnce,
  storeForSelftest,
  type LaunchdReader,
  type SelftestTarget,
} from "../../src/auth/selftest.js";
import { KEYCHAIN_SERVICE, SELFTEST_TIMEOUT_MS } from "../../src/auth/types.js";
import { FakeKeyring } from "./helpers.js";

const AT = "2026-10-06T12:00:00.000Z";
const VALUE = "throwaway-value-0123456789abcdef";

function run(
  reader: LaunchdReader,
  over: { kr?: FakeKeyring; timeoutMs?: number; service?: string } = {},
) {
  const kr = over.kr ?? new FakeKeyring();
  return {
    kr,
    result: runKeychainSelftest({
      service: over.service ?? KEYCHAIN_SERVICE,
      keyring: kr,
      readUnderLaunchd: reader,
      now: () => AT,
      randomValue: () => VALUE,
      ...(over.timeoutMs === undefined ? {} : { timeoutMs: over.timeoutMs }),
    }),
  };
}

/** The honest agent: reads the item from the same keyring. */
const honest =
  (kr: FakeKeyring): LaunchdReader =>
  (t, signal) =>
    selftestReadOnce(kr, t, signal);

describe("runKeychainSelftest", () => {
  it("ok: the agent read back the throwaway value; the item is deleted afterwards", async () => {
    const kr = new FakeKeyring();
    const targets: SelftestTarget[] = [];
    const { result } = run(
      (t, s) => {
        targets.push(t);
        return honest(kr)(t, s);
      },
      { kr },
    );
    expect(await result).toEqual({
      outcome: "ok",
      reason: "ok",
      code: null,
      at: AT,
      cleanup: "deleted",
    });
    expect(targets).toEqual([
      { service: `${KEYCHAIN_SERVICE}-selftest`, account: SELFTEST_ACCOUNT },
    ]);
    expect(kr.items.size).toBe(0);
    // only the throwaway service was ever touched — never the real credential items
    expect(kr.calls.every((c) => c.service === selftestServiceOf(KEYCHAIN_SERVICE))).toBe(true);
  });
  it("the default throwaway value is random (64 hex chars) and differs per run", async () => {
    const seen: string[] = [];
    for (let i = 0; i < 2; i++) {
      const kr = new FakeKeyring();
      await runKeychainSelftest({
        service: KEYCHAIN_SERVICE,
        keyring: kr,
        now: () => AT,
        readUnderLaunchd: (t) => {
          seen.push(kr.peek(t.service, t.account) ?? "");
          return Promise.resolve({ status: "missing" });
        },
      });
    }
    expect(seen[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(seen[0]).not.toBe(seen[1]);
  });
  it("timeout: the agent hangs (a prompt nobody sees) → timeout within the bound; item deleted", async () => {
    const kr = new FakeKeyring();
    let aborted = false;
    const t0 = Date.now();
    const { result } = run(
      (_t, signal) =>
        new Promise(() => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
      { kr, timeoutMs: 30 },
    );
    expect(await result).toMatchObject({
      outcome: "timeout",
      reason: "read_timeout",
      cleanup: "deleted",
    });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(aborted).toBe(true);
    expect(kr.items.size).toBe(0);
    expect(SELFTEST_TIMEOUT_MS).toBe(10_000);
  });
  it.each([
    ["missing", () => Promise.resolve({ status: "missing" as const }), "missing", null],
    [
      "a different value",
      () => Promise.resolve({ status: "read" as const, digest: selftestDigest("other") }),
      "mismatch",
      null,
    ],
    [
      "a short digest",
      () => Promise.resolve({ status: "read" as const, digest: "abc" }),
      "mismatch",
      null,
    ],
    [
      "an agent error code",
      () => Promise.resolve({ status: "error" as const, code: "launchctl_failed" }),
      "read_failed",
      "launchctl_failed",
    ],
    [
      "a hostile agent code",
      () => Promise.resolve({ status: "error" as const, code: "\u001b[31mred\nline" }),
      "read_failed",
      "error",
    ],
    [
      "a throwing agent",
      () => Promise.reject(new Error("spawn failed")),
      "read_failed",
      "agent_failed",
    ],
  ])("error: %s", async (_n, reader, reason, code) => {
    const kr = new FakeKeyring();
    const { result } = run(reader, { kr });
    expect(await result).toEqual({ outcome: "error", reason, code, at: AT, cleanup: "deleted" });
    expect(kr.items.size).toBe(0);
  });
  it("error: the throwaway write fails (the agent is never started); cleanup still attempted", async () => {
    const kr = new FakeKeyring();
    kr.failOn = { op: "set" };
    let started = false;
    const { result } = run(
      () => {
        started = true;
        return Promise.resolve({ status: "missing" });
      },
      { kr },
    );
    expect(await result).toMatchObject({
      outcome: "error",
      reason: "write_failed",
      cleanup: "deleted",
    });
    expect(started).toBe(false);
    expect(kr.calls.map((c) => c.op)).toEqual(["set", "delete"]);
  });
  it("a failed cleanup is reported (cleanup: failed), the outcome stands", async () => {
    const kr = new FakeKeyring();
    kr.failOn = { op: "delete" };
    const { result } = run(honest(kr), { kr });
    expect(await result).toMatchObject({ outcome: "ok", cleanup: "failed" });
  });
  it("a service that is neither the real one nor eff-test-… is refused without a keychain call", async () => {
    const kr = new FakeKeyring();
    const { result } = run(honest(kr), { kr, service: "login" });
    expect(await result).toMatchObject({ outcome: "error", reason: "invalid_service" });
    expect(kr.calls).toEqual([]);
  });
  it("a test service: the throwaway item follows it (<name>-selftest)", async () => {
    const kr = new FakeKeyring();
    const { result } = run(honest(kr), { kr, service: "eff-test-unit" });
    expect((await result).outcome).toBe("ok");
    expect(kr.calls.every((c) => c.service === "eff-test-unit-selftest")).toBe(true);
  });
});

describe("selftestReadOnce (the one-shot agent's side)", () => {
  const signal = new AbortController().signal;
  it("reports a digest of what it read, never the value", async () => {
    const kr = new FakeKeyring();
    kr.plant(`${KEYCHAIN_SERVICE}-selftest`, SELFTEST_ACCOUNT, VALUE);
    const r = await selftestReadOnce(
      kr,
      { service: `${KEYCHAIN_SERVICE}-selftest`, account: SELFTEST_ACCOUNT },
      signal,
    );
    expect(r).toEqual({ status: "read", digest: selftestDigest(VALUE) });
    expect(JSON.stringify(r)).not.toContain(VALUE);
  });
  it("missing → missing; a failure → error read_failed; an abort → error timeout", async () => {
    const kr = new FakeKeyring();
    const t = { service: "eff-test-x-selftest", account: SELFTEST_ACCOUNT };
    expect(await selftestReadOnce(kr, t, signal)).toEqual({ status: "missing" });
    kr.failOn = { op: "get" };
    expect(await selftestReadOnce(kr, t, signal)).toEqual({ status: "error", code: "read_failed" });
    const ctl = new AbortController();
    kr.hangOn = { op: "get" };
    const p = selftestReadOnce(kr, t, ctl.signal);
    ctl.abort();
    expect(await p).toEqual({ status: "error", code: "timeout" });
  });
  it.each([
    [{ service: KEYCHAIN_SERVICE, account: SELFTEST_ACCOUNT }],
    [{ service: `${KEYCHAIN_SERVICE}-selftest`, account: "espn_s2" }],
    [{ service: "login-selftest", account: SELFTEST_ACCOUNT }],
    [{ service: "-selftest", account: SELFTEST_ACCOUNT }],
  ])("refuses to read anything but a throwaway item: %j", async (t) => {
    const kr = new FakeKeyring();
    expect(await selftestReadOnce(kr, t, signal)).toEqual({
      status: "error",
      code: "invalid_target",
    });
    expect(kr.calls).toEqual([]);
  });
});

describe("storeForSelftest (one store per install — anything but ok → file)", () => {
  it.each([
    ["ok", "keychain"],
    ["timeout", "file"],
    ["error", "file"],
  ] as const)("%s → %s", (o, s) => {
    expect(storeForSelftest(o)).toBe(s);
  });
});
