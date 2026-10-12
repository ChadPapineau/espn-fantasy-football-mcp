// stores.test.ts — src/auth/stores.ts `openCredentialStore`, the install's one store (plan 02 §2.2
// "One store per install", "Multiple processes"; plan 03 L6; Stage C finding
// auth-store-switch-deletes-credential-row): it opens on the kind config.json records and touches
// nothing; once a record is bound, every operation first moves to the backend the record names, so
// a process that started on one backend follows `eff setup --storage …`; a record that names
// nothing, names something else or throws keeps the backend in use; the record never supplies a
// path or a service — only one of the two configured backends is ever used.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCredentialStore, openCredentialStores } from "../../src/auth/stores.js";
import {
  KEYCHAIN_ACCOUNTS,
  KEYCHAIN_SERVICE,
  type CredentialStoreKind,
} from "../../src/auth/types.js";
import { metaFor } from "../../src/auth/upgrade.js";
import { ROOT, noXattrs, tempDir } from "../config/helpers.js";
import { FakeKeyring, fakeCookies } from "./helpers.js";

const T0 = "2026-10-01T00:00:00.000Z";
const T5 = "2026-10-06T00:00:00.000Z";

let tmp: { dir: string; cleanup: () => void };
let kr: FakeKeyring;
let loads: number;
let cfg: Parameters<typeof openCredentialStores>[0];

beforeEach(() => {
  tmp = tempDir("eff-auth-stores-");
  kr = new FakeKeyring();
  loads = 0;
  cfg = {
    filePath: path.join(tmp.dir, "cfg", "session.json"),
    home: tmp.dir,
    repoRoot: ROOT,
    xattr: noXattrs,
    loadKeyring: () => {
      loads++;
      return Promise.resolve(kr);
    },
  };
  mkdirSync(path.join(tmp.dir, "cfg"), { mode: 0o700 });
});
afterEach(() => {
  tmp.cleanup();
});

describe("openCredentialStore — the install's one store", () => {
  it("opens on the recorded kind and touches nothing; binding a record reads nothing either", () => {
    let recordReads = 0;
    const s = openCredentialStore("keychain", cfg);
    s.followRecord(() => {
      recordReads++;
      return "file";
    });
    expect(s.kind).toBe("keychain");
    expect(loads).toBe(0);
    expect(recordReads).toBe(0);
    expect(openCredentialStore("file", cfg).kind).toBe("file");
  });

  it("without a record every operation goes to the starting backend", async () => {
    const pair = openCredentialStores(cfg);
    const c = fakeCookies("stores-a");
    await pair.file.write(c, metaFor(c, T0));
    const s = openCredentialStore("keychain", cfg);
    expect(await s.readMeta()).toBeNull(); // the keychain holds nothing; the file is never read
    expect(await s.exists()).toBe(false);
    const f = openCredentialStore("file", cfg);
    expect((await f.read())?.meta.storedAt).toBe(T0);
  });

  it("follows the record: `eff setup --storage file` moves every later operation to the file", async () => {
    const pair = openCredentialStores(cfg); // what setup holds, in its own process
    const a = fakeCookies("stores-a");
    await pair.keychain.write(a, metaFor(a, T0));
    let recorded: CredentialStoreKind | null = "keychain";
    const s = openCredentialStore("keychain", cfg);
    s.followRecord(() => recorded);
    expect((await s.read())?.meta.storedAt).toBe(T0);

    // setup switches: the keychain items go, session.json is written, the row names the file
    await pair.keychain.delete();
    const b = fakeCookies("stores-b");
    await pair.file.write(b, metaFor(b, T5));
    recorded = "file";
    const got = await s.read();
    expect(s.kind).toBe("file");
    expect(got?.meta.storedAt).toBe(T5);
    expect(got?.cookies.espn_s2 === b.espn_s2).toBe(true);
    expect(await s.exists()).toBe(true);

    // and back: `eff setup --storage keychain`
    await pair.file.delete();
    await pair.keychain.write(a, metaFor(a, T5));
    recorded = "keychain";
    expect((await s.readMeta())?.storedAt).toBe(T5);
    expect(s.kind).toBe("keychain");
  });

  it("the backend is chosen when the operation starts (the authority reads `kind` right after)", () => {
    let recorded: CredentialStoreKind | null = null;
    const s = openCredentialStore("keychain", cfg);
    s.followRecord(() => recorded);
    recorded = "file";
    const pending = s.exists();
    expect(s.kind).toBe("file");
    return pending;
  });

  it("a record naming nothing, something else, or throwing keeps the backend in use", async () => {
    const s = openCredentialStore("file", cfg);
    for (const r of [
      () => null,
      () => "dropbox" as unknown as CredentialStoreKind,
      () => "../keychain" as unknown as CredentialStoreKind,
      (): CredentialStoreKind => {
        throw new Error("SQLITE_BUSY");
      },
    ]) {
      s.followRecord(r);
      await s.exists();
      expect(s.kind).toBe("file");
    }
    expect(loads).toBe(0); // the keychain was never reached
  });

  it("write and delete go to the backend the record names; the service stays the configured one", async () => {
    let recorded: CredentialStoreKind | null = "keychain";
    const s = openCredentialStore("file", cfg);
    s.followRecord(() => recorded);
    const c = fakeCookies("stores-w");
    await s.write(c, metaFor(c, T0));
    expect(kr.peek(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNTS.meta)).toBeDefined();
    expect(kr.calls.every((x) => x.service === KEYCHAIN_SERVICE)).toBe(true);
    expect(await openCredentialStores(cfg).file.exists()).toBe(false);
    await s.delete();
    expect(kr.peek(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNTS.meta)).toBeUndefined();
    recorded = "file";
    await s.write(c, metaFor(c, T5));
    expect(await openCredentialStores(cfg).file.exists()).toBe(true);
  });
});
