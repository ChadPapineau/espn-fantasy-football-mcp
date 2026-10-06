// uninstall.test.ts — src/auth/uninstall.ts and src/auth/stores.ts (plan 03 §8 step 2, L8; plan 02
// §2.2 "Removal", §8 #21; plan 03 §5 #6): uninstall deletes BOTH stores always (and a leftover
// self-test item), attempts every target when one fails, and clears the observations; the presence
// check reports the forbidden two-store state; opening the stores touches nothing.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialStoreError } from "../../src/auth/errors.js";
import { SELFTEST_ACCOUNT, selftestServiceOf } from "../../src/auth/keychain.js";
import {
  openCredentialStore,
  openCredentialStores,
  selftestItemDeleter,
  storePresence,
} from "../../src/auth/stores.js";
import { removeAllCredentials } from "../../src/auth/uninstall.js";
import { KEYCHAIN_SERVICE } from "../../src/auth/types.js";
import { metaFor } from "../../src/auth/upgrade.js";
import { ROOT, noXattrs, tempDir } from "../config/helpers.js";
import { FakeKeyring, MemoryStateRepo, MemoryStore, fakeCookies, stateRow } from "./helpers.js";

const AT = "2026-10-06T12:00:00.000Z";

describe("removeAllCredentials (plan 03 §8 step 2)", () => {
  it("deletes both stores, the self-test leftover and the row — whichever store is recorded", async () => {
    const keychain = new MemoryStore("keychain");
    const file = new MemoryStore("file");
    keychain.set(fakeCookies("u1"), AT);
    file.set(fakeCookies("u2"), AT);
    const repo = new MemoryStateRepo();
    repo.row = stateRow({ state: "validated" });
    let selftestDeleted = 0;
    const r = await removeAllCredentials({
      keychain,
      file,
      credentialState: repo,
      deleteSelftestItem: () => {
        selftestDeleted++;
        return Promise.resolve(true);
      },
    });
    expect(r).toEqual({
      keychain: "removed",
      file: "removed",
      selftestItem: "removed",
      credentialState: "cleared",
      ok: true,
    });
    expect(keychain.stored).toBeNull();
    expect(file.stored).toBeNull();
    expect(selftestDeleted).toBe(1);
    expect(repo.row).toBeNull();
  });
  it("one failure never stops the others; the report says which failed (no value in it)", async () => {
    const keychain = new MemoryStore("keychain");
    const file = new MemoryStore("file");
    const c = fakeCookies("u3");
    file.set(c, AT);
    keychain.failDelete = new CredentialStoreError("keychain", "timeout");
    const repo = new MemoryStateRepo();
    repo.failWrite = true;
    const r = await removeAllCredentials({ keychain, file, credentialState: repo });
    expect(r).toEqual({
      keychain: "failed",
      file: "removed",
      selftestItem: "skipped",
      credentialState: "failed",
      ok: false,
    });
    expect(file.stored).toBeNull();
    expect(JSON.stringify(r)).not.toContain(c.espn_s2.slice(0, 16));
  });
  it("an unreachable keychain (Linux, no addon) is `unavailable`, not a failure", async () => {
    const keychain = new MemoryStore("keychain");
    keychain.failDelete = new CredentialStoreError("keychain", "unavailable");
    const r = await removeAllCredentials({
      keychain,
      file: new MemoryStore("file"),
      credentialState: null,
      deleteSelftestItem: () => Promise.reject(new Error("raw")),
    });
    expect(r).toEqual({
      keychain: "unavailable",
      file: "removed",
      selftestItem: "failed",
      credentialState: "skipped",
      ok: false,
    });
  });
});

describe("selftestItemDeleter", () => {
  it("deletes only <service>-selftest / selftest", async () => {
    const kr = new FakeKeyring();
    kr.plant(selftestServiceOf(KEYCHAIN_SERVICE), SELFTEST_ACCOUNT, "x");
    expect(await selftestItemDeleter(KEYCHAIN_SERVICE, () => Promise.resolve(kr))()).toBe(true);
    expect(kr.calls).toEqual([
      { op: "delete", service: `${KEYCHAIN_SERVICE}-selftest`, account: SELFTEST_ACCOUNT },
    ]);
    expect(await selftestItemDeleter(KEYCHAIN_SERVICE, () => Promise.resolve(kr))()).toBe(false);
  });
  it("typed failures: invalid service, unavailable addon, delete failure", async () => {
    const kr = new FakeKeyring();
    const reason = async (p: Promise<unknown>): Promise<string> =>
      p.then(
        () => "none",
        (e: unknown) => (e instanceof CredentialStoreError ? e.reason : "untyped"),
      );
    expect(await reason(selftestItemDeleter("login", () => Promise.resolve(kr))())).toBe(
      "invalid_service",
    );
    expect(
      await reason(
        selftestItemDeleter(KEYCHAIN_SERVICE, () => Promise.reject(new Error("no addon")))(),
      ),
    ).toBe("unavailable");
    kr.failOn = { op: "delete" };
    expect(await reason(selftestItemDeleter(KEYCHAIN_SERVICE, () => Promise.resolve(kr))())).toBe(
      "delete_failed",
    );
    expect(kr.calls).toHaveLength(1);
  });
});

describe("openCredentialStores / storePresence (plan 03 §5 #6)", () => {
  let tmp: { dir: string; cleanup: () => void };
  beforeEach(() => {
    tmp = tempDir("eff-auth-stores-");
  });
  afterEach(() => {
    tmp.cleanup();
  });

  it("opening touches nothing; each kind is the right backend; the file path is honoured", async () => {
    const kr = new FakeKeyring();
    let loads = 0;
    const cfg = {
      filePath: path.join(tmp.dir, "cfg", "session.json"),
      home: tmp.dir,
      repoRoot: ROOT,
      xattr: noXattrs,
      loadKeyring: () => {
        loads++;
        return Promise.resolve(kr);
      },
    };
    const pair = openCredentialStores(cfg);
    expect(loads).toBe(0);
    expect(pair.keychain.kind).toBe("keychain");
    expect(pair.keychain.service).toBe(KEYCHAIN_SERVICE);
    expect(pair.file.kind).toBe("file");
    expect(openCredentialStore("keychain", cfg).kind).toBe("keychain");
    expect(openCredentialStore("file", cfg).kind).toBe("file");
    expect(openCredentialStores({ ...cfg, service: "eff-test-pair" }).keychain.service).toBe(
      "eff-test-pair",
    );
    // defaults (no xattr / loader overrides) still construct without touching anything
    expect(
      openCredentialStores({ filePath: cfg.filePath, home: tmp.dir, repoRoot: ROOT }).file.kind,
    ).toBe("file");

    expect(await storePresence(pair)).toEqual({ keychain: false, file: false, twoStores: false });
    mkdirSync(path.join(tmp.dir, "cfg"), { mode: 0o700 });
    const c = fakeCookies("pair");
    await pair.file.write(c, metaFor(c, AT));
    await pair.keychain.write(c, metaFor(c, AT));
    expect(await storePresence(pair)).toEqual({ keychain: true, file: true, twoStores: true });
  });
  it("a store that cannot answer is reported as `error`, never thrown", async () => {
    const broken = new MemoryStore("keychain");
    broken.failRead = new CredentialStoreError("keychain", "timeout");
    const file = new MemoryStore("file");
    file.set(fakeCookies("p2"), AT);
    expect(await storePresence({ keychain: broken, file })).toEqual({
      keychain: "error",
      file: true,
      twoStores: false,
    });
  });
});
