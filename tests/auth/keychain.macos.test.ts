// keychain.macos.test.ts — the REAL `@napi-rs/keyring` addon on macOS only (plan 05 §2
// `auth/keychain`, §4.2 keychain round trip; changelog V8): a throwaway service `eff-test-<random>`
// — never the real service name — gets a fake value written, read back, verified and deleted by the
// store, and the self-test agent's read runs against a real throwaway item. Cleanup runs in
// afterAll whatever happens, and a final read proves no item survives. Skipped on every other OS.
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  SELFTEST_ACCOUNT,
  createKeychainCredentialStore,
  loadNativeKeyring,
  selftestServiceOf,
} from "../../src/auth/keychain.js";
import { runKeychainSelftest, selftestReadOnce } from "../../src/auth/selftest.js";
import { selftestItemDeleter } from "../../src/auth/stores.js";
import { KEYCHAIN_ACCOUNTS, KEYCHAIN_SERVICE } from "../../src/auth/types.js";
import { metaFor } from "../../src/auth/upgrade.js";
import { fakeCookies } from "./helpers.js";

const onMac = process.platform === "darwin";
const SERVICE = `eff-test-${randomBytes(6).toString("hex")}`;
const ACCOUNTS = [KEYCHAIN_ACCOUNTS.meta, KEYCHAIN_ACCOUNTS.espn_s2, KEYCHAIN_ACCOUNTS.swid];

afterAll(async () => {
  if (!onMac) return;
  const k = await loadNativeKeyring();
  const signal = AbortSignal.timeout(10_000);
  for (const a of ACCOUNTS) await k.deletePassword(SERVICE, a, signal).catch(() => false);
  await k.deletePassword(selftestServiceOf(SERVICE), SELFTEST_ACCOUNT, signal).catch(() => false);
  for (const a of ACCOUNTS) expect(await k.getPassword(SERVICE, a, signal)).toBeNull();
  expect(await k.getPassword(selftestServiceOf(SERVICE), SELFTEST_ACCOUNT, signal)).toBeNull();
});

describe.skipIf(!onMac)("the real keychain (macOS, throwaway eff-test- service)", () => {
  it("guard: the test service is never the real one", () => {
    expect(SERVICE).not.toBe(KEYCHAIN_SERVICE);
    expect(SERVICE.startsWith("eff-test-")).toBe(true);
  });

  it("round trip: write → read → exists → delete → nothing left", async () => {
    const store = createKeychainCredentialStore({ service: SERVICE, timeoutMs: 15_000 });
    expect(await store.read()).toBeNull();
    const c = fakeCookies("macos-roundtrip");
    const meta = metaFor(c, new Date().toISOString());
    await store.write(c, meta);
    expect(await store.exists()).toBe(true);
    expect(await store.read()).toEqual({ cookies: c, meta });
    await store.delete();
    expect(await store.exists()).toBe(false);
    expect(await store.read()).toBeNull();
  });

  it("the self-test: a throwaway item read by the agent side, then deleted", async () => {
    const keyring = await loadNativeKeyring();
    const r = await runKeychainSelftest({
      service: SERVICE,
      keyring,
      // in-process stand-in for the one-shot launchd agent (the CLI wires the real one)
      readUnderLaunchd: (target, signal) => selftestReadOnce(keyring, target, signal),
      now: () => new Date().toISOString(),
    });
    expect(r).toMatchObject({ outcome: "ok", reason: "ok", cleanup: "deleted" });
    const left = await keyring.getPassword(
      selftestServiceOf(SERVICE),
      SELFTEST_ACCOUNT,
      AbortSignal.timeout(10_000),
    );
    expect(left).toBeNull();
    expect(await selftestItemDeleter(SERVICE)()).toBe(false);
  });
});
