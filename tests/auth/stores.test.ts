// stores.test.ts — src/auth/stores.ts `openCredentialStore`, the install's one store (plan 02 §2.2
// "One store per install", "Multiple processes"; plan 03 §3, L6; Stage C findings
// auth-store-switch-deletes-credential-row and auth-file-path-switch-deletes-row): it opens on the
// kind config.json records and touches nothing; once a record is bound, every operation first moves
// to the backend the record names, so a process that started on one backend follows `eff setup
// --storage …`; a record that names nothing, names something else or throws keeps the backend in
// use; the record never supplies a path or a service — only one of the two configured backends is
// ever used. Opened with its config dir, the file backend reads the session.json path config.json
// records when the operation starts (`~/` resolved as startup resolves it; the start path while none
// is recorded), runs the location rule on a new path before its first read, and fails closed on a
// config.json startup would refuse — it never falls back to another file.
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialStoreError } from "../../src/auth/errors.js";
import {
  openCredentialStore,
  openCredentialStores,
  recordedCredentialFile,
} from "../../src/auth/stores.js";
import {
  KEYCHAIN_ACCOUNTS,
  KEYCHAIN_SERVICE,
  type CredentialStoreKind,
} from "../../src/auth/types.js";
import { metaFor } from "../../src/auth/upgrade.js";
import { patchConfigFile, type ConfigPatch } from "../../src/cli/config-file.js";
import { configFilePath } from "../../src/config/paths.js";
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

describe("the file path config.json records (Stage C finding auth-file-path-switch-deletes-row)", () => {
  const configDir = (): string => path.join(tmp.dir, "cfg");
  const alt = (name = "alt"): string => path.join(tmp.dir, name, "session.json");
  /** config.json written exactly as `eff setup` writes it (the CLI's one writer). */
  const record = (patch: ConfigPatch): void => {
    patchConfigFile(
      { configDir: configDir(), home: tmp.dir, repoRoot: ROOT, xattr: noXattrs },
      patch,
    );
  };
  /** A config.json body written raw (shapes the writer refuses to produce). */
  const rawConfig = (text: string): void => {
    rmSync(configFilePath(configDir()), { recursive: true, force: true });
    writeFileSync(configFilePath(configDir()), text, { mode: 0o600 });
  };
  /** The install store as the composition roots open it: the start path and the config dir. */
  const wired = (kind: CredentialStoreKind) =>
    openCredentialStore(kind, { ...cfg, configDir: configDir() });
  /** `eff setup`'s own process, at the path IT resolved (its env, or the path already recorded). */
  const setupAt = (file: string) => openCredentialStores({ ...cfg, filePath: file });

  beforeEach(() => {
    for (const d of ["alt", "alt2"]) mkdirSync(path.join(tmp.dir, d), { mode: 0o700 });
  });

  it("`EFF_CREDENTIAL_FILE=<alt> eff setup --storage file`: every later operation reads <alt>", async () => {
    const a = fakeCookies("path-a");
    await openCredentialStores(cfg).keychain.write(a, metaFor(a, T0));
    record({ EFF_CREDENTIAL_STORE: "keychain" });
    let recorded: CredentialStoreKind | null = "keychain";
    const s = wired("keychain");
    s.followRecord(() => recorded);
    expect((await s.read())?.meta.storedAt).toBe(T0);

    // setup, in a shell whose EFF_CREDENTIAL_FILE names <alt>: config.json, the keychain, the file,
    // then the row (here: the record) — in that order
    const b = fakeCookies("path-b");
    record({ EFF_CREDENTIAL_STORE: "file", EFF_CREDENTIAL_FILE: alt() });
    await setupAt(alt()).keychain.delete();
    await setupAt(alt()).file.write(b, metaFor(b, T5));
    recorded = "file";

    const got = await s.read();
    expect(s.kind).toBe("file");
    expect(got?.meta.storedAt).toBe(T5);
    expect(got?.cookies.espn_s2 === b.espn_s2).toBe(true);
    expect((await s.readMeta())?.storedAt).toBe(T5);
    expect(await s.exists()).toBe(true);
    // the path this process started with holds nothing, and is no longer the install's
    expect(await openCredentialStores(cfg).file.exists()).toBe(false);
  });

  it("a recorded `~/` path resolves against home, as startup resolves it", async () => {
    const b = fakeCookies("path-home");
    await setupAt(alt()).file.write(b, metaFor(b, T5));
    record({ EFF_CREDENTIAL_STORE: "file", EFF_CREDENTIAL_FILE: "~/alt/session.json" });
    expect(recordedCredentialFile(configDir(), tmp.dir)).toBe(alt());
    expect((await wired("file").readMeta())?.storedAt).toBe(T5);
  });

  it("a changed record is followed; no record (or a blank one, or no config.json) is the start path", async () => {
    const [b, c, d] = [fakeCookies("path-b"), fakeCookies("path-c"), fakeCookies("path-d")];
    await setupAt(alt()).file.write(b, metaFor(b, T0));
    await setupAt(alt("alt2")).file.write(c, metaFor(c, T5));
    await openCredentialStores(cfg).file.write(d, metaFor(d, "2026-10-07T00:00:00.000Z"));
    const s = wired("file");
    record({ EFF_CREDENTIAL_STORE: "file", EFF_CREDENTIAL_FILE: alt() });
    expect((await s.readMeta())?.storedAt).toBe(T0);
    record({ EFF_CREDENTIAL_FILE: alt("alt2") }); // a hand edit: the next operation follows it
    expect((await s.readMeta())?.storedAt).toBe(T5);
    expect((await s.read())?.cookies.espn_s2 === c.espn_s2).toBe(true);
    record({ EFF_CREDENTIAL_FILE: null });
    expect((await s.readMeta())?.storedAt).toBe("2026-10-07T00:00:00.000Z");
    record({ EFF_CREDENTIAL_FILE: alt() });
    expect((await s.readMeta())?.storedAt).toBe(T0);
    record({ EFF_CREDENTIAL_FILE: "   " }); // startup ignores a blank value
    expect((await s.readMeta())?.storedAt).toBe("2026-10-07T00:00:00.000Z");
    rmSync(configFilePath(configDir()));
    expect(recordedCredentialFile(configDir(), tmp.dir)).toBeNull();
    expect((await s.readMeta())?.storedAt).toBe("2026-10-07T00:00:00.000Z");
  });

  it("without the config dir, and in the backend pair, the file store stays at the start path", async () => {
    const b = fakeCookies("path-pair");
    await setupAt(alt()).file.write(b, metaFor(b, T5));
    record({ EFF_CREDENTIAL_STORE: "file", EFF_CREDENTIAL_FILE: alt() });
    expect(await openCredentialStore("file", cfg).readMeta()).toBeNull();
    expect(
      await openCredentialStores({ ...cfg, configDir: configDir() }).file.readMeta(),
    ).toBeNull();
  });

  it("the store says whether its file is the one config.json records (the authority's clearing rule)", () => {
    // src/auth/state.ts clears a `file` row on an empty read only where that read is the install's
    expect(openCredentialStore("file", cfg).followsRecordedPath).toBe(false);
    expect(openCredentialStore("keychain", cfg).followsRecordedPath).toBe(false);
    expect(wired("file").followsRecordedPath).toBe(true);
    expect(wired("keychain").followsRecordedPath).toBe(true);
  });

  it("nothing is read at construction or for a keychain operation; the choice stays synchronous", async () => {
    rawConfig("{ not json");
    let recorded: CredentialStoreKind | null = "keychain";
    const s = wired("keychain");
    s.followRecord(() => recorded);
    expect(await s.readMeta()).toBeNull(); // the keychain: config.json is not consulted
    expect(await s.exists()).toBe(false);
    recorded = "file";
    const pending = s.exists();
    expect(s.kind).toBe("file");
    await expect(pending).rejects.toMatchObject({
      name: "CredentialStoreError",
      reason: "read_failed",
    });
    expect(loads).toBe(1);
  });

  it("a config.json startup would refuse is never followed: the file operation fails closed", async () => {
    const d = fakeCookies("path-fallback");
    await openCredentialStores(cfg).file.write(d, metaFor(d, T0)); // what a fallback would read
    const refused: readonly (readonly [string, string])[] = [
      ["{ not json", "read_failed"],
      ["[]", "read_failed"],
      ['"session.json"', "read_failed"],
      ["42", "read_failed"],
      ["null", "read_failed"],
      [JSON.stringify({ EFF_CREDENTIAL_FILE: 42 }), "read_failed"],
      [JSON.stringify({ EFF_CREDENTIAL_FILE: null }), "read_failed"],
      [JSON.stringify({ EFF_CREDENTIAL_FILE: [alt()] }), "read_failed"],
      [JSON.stringify({ EFF_CREDENTIAL_FILE: `/${"a".repeat(4100)}` }), "read_failed"],
      // a credential-shaped value or a secret-looking key anywhere: startup refuses the file
      [
        JSON.stringify({ EFF_CREDENTIAL_FILE: alt(), note: fakeCookies("path-cfg").swid }),
        "read_failed",
      ],
      [JSON.stringify({ EFF_CREDENTIAL_FILE: alt(), cookie: "x" }), "read_failed"],
      [JSON.stringify({ EFF_CREDENTIAL_FILE: "alt/session.json" }), "insecure_location"],
      [JSON.stringify({ EFF_CREDENTIAL_FILE: "~someone/session.json" }), "insecure_location"],
      [JSON.stringify({ EFF_CREDENTIAL_FILE: `${alt()}\nx` }), "insecure_location"],
    ];
    const s = wired("file");
    for (const [text, reason] of refused) {
      rawConfig(text);
      for (const op of [() => s.read(), () => s.readMeta(), () => s.exists()]) {
        const e: unknown = await op().then(
          () => null,
          (x: unknown) => x,
        );
        expect(e, text.slice(0, 40)).toBeInstanceOf(CredentialStoreError);
        expect((e as CredentialStoreError).reason, text.slice(0, 40)).toBe(reason);
        // a fixed text: never the path, never config.json's content
        expect((e as Error).message).not.toMatch(/session|alt|someone|cfg|cookie|\{/);
      }
    }
    expect(
      ((): unknown => {
        try {
          return recordedCredentialFile(configDir(), tmp.dir);
        } catch (e) {
          return (e as CredentialStoreError).refusal;
        }
      })(),
    ).toBe("control_char");
    // whatever else fails while resolving the recorded path is a store error too, never a raw one
    record({ EFF_CREDENTIAL_FILE: "~/alt/session.json" });
    expect(() => recordedCredentialFile(configDir(), 42 as unknown as string)).toThrow(
      expect.objectContaining({
        name: "CredentialStoreError",
        reason: "insecure_location",
        refusal: null,
      }),
    );
  });

  it("a symlinked or non-regular config.json is not followed either", async () => {
    const real = path.join(tmp.dir, "alt2", "config.json");
    writeFileSync(real, `${JSON.stringify({ EFF_CREDENTIAL_FILE: alt() })}\n`, { mode: 0o600 });
    rmSync(configFilePath(configDir()), { force: true });
    symlinkSync(real, configFilePath(configDir()));
    await expect(wired("file").readMeta()).rejects.toMatchObject({ reason: "read_failed" });
    rmSync(configFilePath(configDir()));
    mkdirSync(configFilePath(configDir()), { mode: 0o700 });
    await expect(wired("file").readMeta()).rejects.toMatchObject({ reason: "read_failed" });
  });

  it("a backend that cannot be chosen rejects with a store error, never a raw one (no path in it)", async () => {
    const leaky = new TypeError(`EACCES: permission denied, open '${configFilePath(configDir())}'`);
    const s = openCredentialStore("file", {
      ...cfg,
      get configDir(): string {
        throw leaky;
      },
    });
    expect(s.followsRecordedPath).toBe(false); // it cannot say, so it never claims the recorded path
    for (const op of [() => s.read(), () => s.readMeta(), () => s.exists()]) {
      let pending: Promise<unknown> | null = null;
      expect(() => {
        pending = op();
      }).not.toThrow();
      const e: unknown = await (pending as unknown as Promise<unknown>).then(
        () => null,
        (x: unknown) => x,
      );
      expect(e).toBeInstanceOf(CredentialStoreError);
      expect(e).toMatchObject({ store: "file", reason: "read_failed" });
      expect((e as Error).message).not.toContain(tmp.dir);
    }
  });

  it("the location and mode rules run on a followed path before its first read", async () => {
    // a recorded path in a synced folder (Documents under home): refused, nothing read
    const synced = path.join(tmp.dir, "Documents", "session.json");
    mkdirSync(path.dirname(synced), { mode: 0o700 });
    const b = fakeCookies("path-synced");
    await setupAt(alt()).file.write(b, metaFor(b, T5));
    writeFileSync(synced, readFileSync(alt(), "utf8"), { mode: 0o600 });
    record({ EFF_CREDENTIAL_STORE: "file", EFF_CREDENTIAL_FILE: synced });
    const s = wired("file");
    await expect(s.readMeta()).rejects.toMatchObject({
      reason: "insecure_location",
      refusal: "synced_folder",
    });
    // a followed file readable by others: refused like the start path would be
    record({ EFF_CREDENTIAL_FILE: alt() });
    chmodSync(alt(), 0o644);
    await expect(s.readMeta()).rejects.toMatchObject({ reason: "insecure_location" });
    chmodSync(alt(), 0o600);
    expect((await s.readMeta())?.storedAt).toBe(T5);
  });
});
