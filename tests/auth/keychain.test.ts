// keychain.test.ts — src/auth/keychain.ts with the addon mocked (plan 05 §2 `auth/keychain`; plan 02
// §2.2 keychain column; plan 04 R3): the addon loads lazily (not at construction), `meta` is written
// last and deleted first, a missing `meta` reads as nothing stored, partial and mismatched items are
// `corrupt`, a native failure or hang becomes a fixed-text typed error (never the native message,
// never a value), and only the real service or an `eff-test-…` service is accepted.
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { CredentialStoreError } from "../../src/auth/errors.js";
import {
  KEYCHAIN_OP_TIMEOUT_MS,
  SELFTEST_ACCOUNT,
  createKeychainCredentialStore,
  isAllowedServiceName,
  isTestServiceName,
  keyringFromModule,
  selftestServiceOf,
  type AsyncEntryLike,
} from "../../src/auth/keychain.js";
import { KEYCHAIN_ACCOUNTS, KEYCHAIN_SERVICE } from "../../src/auth/types.js";
import { metaFor, metaJson } from "../../src/auth/upgrade.js";
import { FakeKeyring, containsFragment, fakeCookies } from "./helpers.js";

const AT = "2026-10-06T12:00:00.000Z";
const S = KEYCHAIN_SERVICE;

function setup(over: { timeoutMs?: number; service?: string } = {}) {
  const kr = new FakeKeyring();
  let loads = 0;
  const store = createKeychainCredentialStore({
    ...over,
    loadKeyring: () => {
      loads++;
      return Promise.resolve(kr);
    },
  });
  return { kr, store, loads: () => loads };
}

async function rejection(p: Promise<unknown>): Promise<CredentialStoreError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(CredentialStoreError);
  return e as CredentialStoreError;
}

describe("laziness (plan 03 §1.1 step 4: nothing at startup touches the keychain)", () => {
  it("constructing the store neither loads the addon nor calls the keychain", () => {
    const { kr, loads } = setup();
    expect(loads()).toBe(0);
    expect(kr.calls).toEqual([]);
  });
  it("the addon loads once, on the first operation", async () => {
    const { store, loads } = setup();
    await store.exists();
    await store.readMeta();
    expect(loads()).toBe(1);
  });
  it("a failed load is `unavailable` and retried on the next call", async () => {
    let n = 0;
    const kr = new FakeKeyring();
    const store = createKeychainCredentialStore({
      loadKeyring: () =>
        ++n === 1 ? Promise.reject(new Error("dlopen failed: /secret/path")) : Promise.resolve(kr),
    });
    const e = await rejection(store.read());
    expect(e.reason).toBe("unavailable");
    expect(e.message).not.toContain("dlopen");
    expect(await store.read()).toBeNull();
    expect(n).toBe(2);
  });
});

describe("write order and read-back (plan 02 §2.2: meta written last)", () => {
  it("deletes the old meta first, then espn_s2, SWID, and meta last", async () => {
    const { kr, store } = setup();
    const c = fakeCookies("kc");
    const meta = metaFor(c, AT);
    await store.write(c, meta);
    expect(kr.calls.map((x) => `${x.op}:${x.account}`)).toEqual([
      "delete:meta",
      "set:espn_s2",
      "set:SWID",
      "set:meta",
    ]);
    expect(kr.calls.every((x) => x.service === S)).toBe(true);
    expect(kr.peek(S, KEYCHAIN_ACCOUNTS.espn_s2)).toBe(c.espn_s2);
    expect(kr.peek(S, KEYCHAIN_ACCOUNTS.swid)).toBe(c.swid);
    const metaText = kr.peek(S, KEYCHAIN_ACCOUNTS.meta) ?? "";
    expect(JSON.parse(metaText)).toEqual(meta);
    // cookie-not-in-store-metadata (plan 05 §4.4)
    expect(containsFragment(metaText, c.espn_s2)).toBe(false);
    expect(metaText).not.toContain(c.swid);
    expect(await store.read()).toEqual({ cookies: c, meta });
    expect(await store.readMeta()).toEqual(meta);
    expect(await store.exists()).toBe(true);
  });
  it("no meta item → nothing stored (null), even with stray secret items", async () => {
    const { kr, store } = setup();
    expect(await store.read()).toBeNull();
    expect(await store.exists()).toBe(false);
    kr.plant(S, KEYCHAIN_ACCOUNTS.espn_s2, fakeCookies("stray").espn_s2);
    expect(await store.read()).toBeNull();
    expect(await store.readMeta()).toBeNull();
  });
  it("a crash after meta was deleted but before it was rewritten reads as nothing stored", async () => {
    const { kr, store } = setup();
    const a = fakeCookies("a");
    await store.write(a, metaFor(a, AT));
    const b = fakeCookies("b");
    kr.failOn = { op: "set", account: KEYCHAIN_ACCOUNTS.meta };
    const e = await rejection(store.write(b, metaFor(b, AT)));
    expect(e.reason).toBe("write_failed");
    expect(await store.read()).toBeNull();
  });
});

describe("damaged items are typed errors (no value anywhere)", () => {
  it("meta present, a secret item missing → corrupt", async () => {
    const { kr, store } = setup();
    const c = fakeCookies("partial");
    kr.plant(S, KEYCHAIN_ACCOUNTS.meta, metaJson(metaFor(c, AT)));
    kr.plant(S, KEYCHAIN_ACCOUNTS.espn_s2, c.espn_s2);
    expect((await rejection(store.read())).reason).toBe("corrupt");
  });
  it("meta that belongs to another value → corrupt (old meta paired with a new value)", async () => {
    const { kr, store } = setup();
    const c = fakeCookies("new");
    kr.plant(S, KEYCHAIN_ACCOUNTS.meta, metaJson(metaFor(fakeCookies("old"), AT)));
    kr.plant(S, KEYCHAIN_ACCOUNTS.espn_s2, c.espn_s2);
    kr.plant(S, KEYCHAIN_ACCOUNTS.swid, c.swid);
    const e = await rejection(store.read());
    expect(e.reason).toBe("corrupt");
    expect(containsFragment(inspect(e), c.espn_s2)).toBe(false);
  });
  it.each([
    ["not JSON", "{oops", "corrupt"],
    [
      "a newer format",
      JSON.stringify({ storedAt: AT, format_version: 9, fingerprint: "abcdef" }),
      "newer_format",
    ],
    [
      "a bad fingerprint",
      JSON.stringify({ storedAt: AT, format_version: 1, fingerprint: "XYZ" }),
      "corrupt",
    ],
  ])("meta %s → %s", async (_n, text, reason) => {
    const { kr, store } = setup();
    kr.plant(S, KEYCHAIN_ACCOUNTS.meta, text);
    expect((await rejection(store.readMeta())).reason).toBe(reason);
    expect((await rejection(store.read())).reason).toBe(reason);
  });
  it("a stored value that fails the format rules → invalid_format", async () => {
    const { kr, store } = setup();
    const c = { ...fakeCookies("fmt"), swid: "not-a-guid" };
    kr.plant(S, KEYCHAIN_ACCOUNTS.meta, metaJson(metaFor(c, AT)));
    kr.plant(S, KEYCHAIN_ACCOUNTS.espn_s2, c.espn_s2);
    kr.plant(S, KEYCHAIN_ACCOUNTS.swid, c.swid);
    expect((await rejection(store.read())).reason).toBe("invalid_format");
  });
});

describe("native failures and hangs (plan 02 §2.2 keychain friction)", () => {
  it("a native error message is never propagated — even one that echoes the value", async () => {
    const { kr, store } = setup();
    const c = fakeCookies("echo");
    kr.failOn = {
      op: "set",
      account: KEYCHAIN_ACCOUNTS.espn_s2,
      message: `could not store ${c.espn_s2}`,
    };
    const e = await rejection(store.write(c, metaFor(c, AT)));
    expect(e.reason).toBe("write_failed");
    for (const s of [String(e), e.message, JSON.stringify(e), inspect(e, { depth: 5 })])
      expect(containsFragment(s, c.espn_s2)).toBe(false);
  });
  it("a read failure is read_failed", async () => {
    const { kr, store } = setup();
    kr.failOn = { op: "get" };
    expect((await rejection(store.exists())).reason).toBe("read_failed");
  });
  it("a hung operation (a hidden prompt) times out as `timeout`", async () => {
    const { kr, store } = setup({ timeoutMs: 20 });
    kr.hangOn = { op: "get", account: KEYCHAIN_ACCOUNTS.meta };
    expect((await rejection(store.readMeta())).reason).toBe("timeout");
    expect(KEYCHAIN_OP_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });
  it("invalid values and foreign metadata are refused before any keychain call", async () => {
    const { kr, store } = setup();
    const c = fakeCookies("refuse");
    expect((await rejection(store.write({ ...c, espn_s2: "short" }, metaFor(c, AT)))).reason).toBe(
      "invalid_format",
    );
    expect((await rejection(store.write(c, metaFor(fakeCookies("x"), AT)))).reason).toBe("corrupt");
    expect((await rejection(store.write(c, { ...metaFor(c, AT), format_version: 0 }))).reason).toBe(
      "corrupt",
    );
    expect(kr.calls).toEqual([]);
  });
});

describe("delete (reset, failed setup, uninstall)", () => {
  it("deletes meta first, then both secrets; idempotent", async () => {
    const { kr, store } = setup();
    const c = fakeCookies("del");
    await store.write(c, metaFor(c, AT));
    kr.calls.length = 0;
    await store.delete();
    expect(kr.calls.map((x) => `${x.op}:${x.account}`)).toEqual([
      "delete:meta",
      "delete:espn_s2",
      "delete:SWID",
    ]);
    expect(kr.items.size).toBe(0);
    await store.delete();
  });
  it("attempts every item even when one fails, then reports delete_failed", async () => {
    const { kr, store } = setup();
    const c = fakeCookies("del2");
    await store.write(c, metaFor(c, AT));
    kr.failOn = { op: "delete", account: KEYCHAIN_ACCOUNTS.meta };
    expect((await rejection(store.delete())).reason).toBe("delete_failed");
    expect(kr.peek(S, KEYCHAIN_ACCOUNTS.espn_s2)).toBeUndefined();
    expect(kr.peek(S, KEYCHAIN_ACCOUNTS.swid)).toBeUndefined();
  });
});

describe("service names (changelog V8: eff-test-… only, never the real item in tests)", () => {
  it.each([
    ["eff-test-abc123", true],
    ["eff-test-a.b_c-d", true],
    ["eff-test-", false],
    ["eff-test-has space", false],
    ["eff-test-semi;colon", false],
    [`eff-test-${"x".repeat(65)}`, false],
    ["espn-fantasy-football-mcp", false],
    ["eff-tests-x", false],
    ["EFF-TEST-x", false],
  ])("isTestServiceName(%j) = %s", (name, ok) => {
    expect(isTestServiceName(name)).toBe(ok);
  });
  it("the real service and test services are allowed; anything else is refused at construction", () => {
    expect(isAllowedServiceName(KEYCHAIN_SERVICE)).toBe(true);
    expect(isAllowedServiceName("eff-test-x")).toBe(true);
    expect(isAllowedServiceName("login")).toBe(false);
    expect(() => createKeychainCredentialStore({ service: "other-app" })).toThrow(
      CredentialStoreError,
    );
  });
  it("a test service store only ever touches its own service", async () => {
    const { kr, store } = setup({ service: "eff-test-unit" });
    expect(store.service).toBe("eff-test-unit");
    const c = fakeCookies("svc");
    await store.write(c, metaFor(c, AT));
    await store.read();
    await store.delete();
    expect(kr.calls.every((x) => x.service === "eff-test-unit")).toBe(true);
  });
  it("the self-test service follows the base service", () => {
    expect(selftestServiceOf(KEYCHAIN_SERVICE)).toBe(`${KEYCHAIN_SERVICE}-selftest`);
    expect(selftestServiceOf("eff-test-x")).toBe("eff-test-x-selftest");
    expect(SELFTEST_ACCOUNT).toBe("selftest");
  });
});

describe("keyringFromModule (the addon adapter)", () => {
  it("maps AsyncEntry per (service, account) and normalises undefined/null to null", async () => {
    const store = new Map<string, string>();
    const seen: string[] = [];
    class Entry implements AsyncEntryLike {
      constructor(
        private readonly s: string,
        private readonly a: string,
      ) {
        seen.push(`${s}/${a}`);
      }
      getPassword(): Promise<string | undefined> {
        return Promise.resolve(store.get(`${this.s}/${this.a}`));
      }
      setPassword(v: string): Promise<void> {
        store.set(`${this.s}/${this.a}`, v);
        return Promise.resolve();
      }
      deleteCredential(): Promise<boolean> {
        return Promise.resolve(store.delete(`${this.s}/${this.a}`));
      }
    }
    const k = keyringFromModule({ AsyncEntry: Entry });
    const signal = new AbortController().signal;
    expect(await k.getPassword("s", "a", signal)).toBeNull();
    await k.setPassword("s", "a", "v", signal);
    expect(await k.getPassword("s", "a", signal)).toBe("v");
    expect(await k.deletePassword("s", "a", signal)).toBe(true);
    expect(await k.deletePassword("s", "a", signal)).toBe(false);
    expect(seen.every((x) => x === "s/a")).toBe(true);
  });
});
