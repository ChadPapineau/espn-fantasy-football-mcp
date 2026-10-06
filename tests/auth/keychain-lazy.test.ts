// keychain-lazy.test.ts — the default loader of src/auth/keychain.ts (plan 03 §1.1 step 4: nothing on
// the startup path touches the keychain; plan 04 R3: the one import site): `@napi-rs/keyring` is
// mocked, and the mock's factory — which runs only when the module is first imported — must not run
// when keychain.ts is imported or a store is constructed, only on the first store operation.
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ loaded: 0, items: new Map<string, string>() }));
vi.mock("@napi-rs/keyring", () => {
  state.loaded++;
  class AsyncEntry {
    constructor(
      private readonly s: string,
      private readonly a: string,
    ) {}
    getPassword(): Promise<string | undefined> {
      return Promise.resolve(state.items.get(`${this.s}/${this.a}`));
    }
    setPassword(v: string): Promise<void> {
      state.items.set(`${this.s}/${this.a}`, v);
      return Promise.resolve();
    }
    deleteCredential(): Promise<boolean> {
      return Promise.resolve(state.items.delete(`${this.s}/${this.a}`));
    }
  }
  return { AsyncEntry };
});

const { createKeychainCredentialStore, loadNativeKeyring } =
  await import("../../src/auth/keychain.js");
const { openCredentialStores } = await import("../../src/auth/stores.js");

describe("the native addon loads on first use, never at import or construction", () => {
  it("import + construction: the addon module is not loaded", () => {
    createKeychainCredentialStore();
    openCredentialStores({
      filePath: "/nonexistent/eff/session.json",
      home: "/nonexistent",
      repoRoot: "/nonexistent-repo",
    });
    expect(state.loaded).toBe(0);
  });
  it("the first operation loads it once, through the default loader", async () => {
    const store = createKeychainCredentialStore({ service: "eff-test-lazy" });
    expect(await store.exists()).toBe(false);
    expect(state.loaded).toBe(1);
    const k = await loadNativeKeyring();
    const signal = new AbortController().signal;
    await k.setPassword("eff-test-lazy", "probe", "v", signal);
    expect(await k.getPassword("eff-test-lazy", "probe", signal)).toBe("v");
    expect(await k.deletePassword("eff-test-lazy", "probe", signal)).toBe(true);
    expect(state.loaded).toBe(1);
  });
});
