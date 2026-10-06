// file.test.ts — src/auth/file.ts (plan 05 §2 `auth/file`; plan 02 §2.2 file column, §8 #1/#7):
// dir 0700 and file 0600 enforced on write and on every read (a 0644 file and a 0755 dir are
// refused, never chmod-ed); symlinks refused (file and directory), a planted symlink is unlinked on
// delete without touching its target; an iCloud/file-provider directory (xattr stubbed), a synced
// folder by name and a git working tree are refused; the value is written exactly as given (no
// decoding); corrupt, truncated, oversized and hostile files are typed errors that carry no value.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEspnS2, fakeGuid } from "../../scripts/ci/secret-fixtures.mjs";
import { CredentialStoreError } from "../../src/auth/errors.js";
import {
  SESSION_FILE_MAX_BYTES,
  createFileCredentialStore,
  fileStoreExistsSync,
  parseSessionFile,
  sessionFileBody,
  type FileStoreOptions,
} from "../../src/auth/file.js";
import { metaFor } from "../../src/auth/upgrade.js";
import type { EspnCookies } from "../../src/auth/types.js";
import { ROOT, brokenXattrs, noXattrs, tempDir, xattrsOn } from "../config/helpers.js";

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const AT = "2026-10-06T12:00:00.000Z";
const cookies = (label = "file"): EspnCookies => ({
  espn_s2: fakeEspnS2(`auth-file-${label}`, 220),
  swid: `{${fakeGuid(`auth-file-${label}`)}}`,
});

let tmp: { dir: string; cleanup: () => void };
let home: string;
let cfgDir: string;
let file: string;
const opts = (over: Partial<FileStoreOptions> = {}): FileStoreOptions => ({
  path: file,
  home,
  repoRoot: ROOT,
  xattr: noXattrs,
  gitEntry: () => false,
  ...over,
});

beforeEach(() => {
  tmp = tempDir("eff-auth-file-");
  home = path.join(tmp.dir, "home");
  mkdirSync(home, { mode: 0o700 });
  cfgDir = path.join(home, ".config", "espn-fantasy-football-mcp");
  file = path.join(cfgDir, "session.json");
});
afterEach(() => {
  try {
    chmodSync(cfgDir, 0o700);
  } catch {
    // not created by this test
  }
  tmp.cleanup();
});

/** Every way an error could be printed or serialised. */
const renderings = (e: unknown): string =>
  [String(e), (e as Error).message, JSON.stringify(e), inspect(e, { depth: 5 })].join("\n");

async function expectStoreError(
  p: Promise<unknown>,
  reason: string,
  refusal?: string,
): Promise<CredentialStoreError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(CredentialStoreError);
  const err = e as CredentialStoreError;
  expect(err.reason).toBe(reason);
  if (refusal !== undefined) expect(err.refusal).toBe(refusal);
  expect(err.store).toBe("file");
  expect(err.effCode).toBe("INTERNAL");
  return err;
}

describe("write → read round trip", () => {
  it("creates 0700 dir + 0600 file; reads back exactly what was written (no decoding)", async () => {
    const store = createFileCredentialStore(opts());
    expect(store.kind).toBe("file");
    const c = cookies();
    const meta = metaFor(c, AT);
    await store.write(c, meta);
    expect(statSync(cfgDir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const raw = readFileSync(file, "utf8");
    expect(raw).toContain(c.espn_s2); // URL-encoded, as pasted
    expect(raw).not.toContain(decodeURIComponent(c.espn_s2));
    expect(JSON.parse(raw)).toEqual({
      format_version: 1,
      storedAt: AT,
      fingerprint: meta.fingerprint,
      espn_s2: c.espn_s2,
      SWID: c.swid,
    });
    expect(await store.read()).toEqual({ cookies: c, meta });
    expect(await store.readMeta()).toEqual(meta);
    expect(await store.exists()).toBe(true);
  });
  it("a re-write replaces the value atomically and leaves no temp file", async () => {
    const store = createFileCredentialStore(opts());
    await store.write(cookies("a"), metaFor(cookies("a"), AT));
    const b = cookies("b");
    await store.write(b, metaFor(b, "2026-10-07T00:00:00.000Z"));
    expect((await store.read())?.cookies).toEqual(b);
    expect(readdirSync(cfgDir)).toEqual(["session.json"]);
  });
  it("nothing stored: missing dir and missing file read as null; exists() is false", async () => {
    const store = createFileCredentialStore(opts());
    expect(await store.read()).toBeNull();
    expect(await store.readMeta()).toBeNull();
    expect(await store.exists()).toBe(false);
    mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
    expect(await store.read()).toBeNull();
  });
  it("defaults: the system xattr reader and .git probe (a temp dir passes both)", async () => {
    const store = createFileCredentialStore({ path: file, home, repoRoot: ROOT });
    const c = cookies();
    await store.write(c, metaFor(c, AT));
    expect((await store.read())?.cookies).toEqual(c);
  });
});

describe("permissions are enforced on every read (plan 02 §2.2: refuse, never chmod)", () => {
  it.skipIf(isRoot)("a 0644 file is refused (insecure_mode), and stays 0644", async () => {
    const store = createFileCredentialStore(opts());
    await store.write(cookies(), metaFor(cookies(), AT));
    chmodSync(file, 0o644);
    await expectStoreError(store.read(), "insecure_location", "insecure_mode");
    await expectStoreError(store.readMeta(), "insecure_location", "insecure_mode");
    expect(statSync(file).mode & 0o777).toBe(0o644);
  });
  it.skipIf(isRoot)("a 0755 directory is refused on read and on write", async () => {
    const store = createFileCredentialStore(opts());
    await store.write(cookies(), metaFor(cookies(), AT));
    chmodSync(cfgDir, 0o755);
    await expectStoreError(store.read(), "insecure_location", "insecure_mode");
    await expectStoreError(
      store.write(cookies(), metaFor(cookies(), AT)),
      "insecure_location",
      "insecure_mode",
    );
  });
  it.skipIf(isRoot)("an unreadable directory (0000) is a read failure, not a crash", async () => {
    const store = createFileCredentialStore(opts());
    await store.write(cookies(), metaFor(cookies(), AT));
    chmodSync(cfgDir, 0o000);
    await expectStoreError(store.read(), "read_failed");
    expect(() => fileStoreExistsSync(file)).toThrow(CredentialStoreError);
    await expectStoreError(store.exists(), "read_failed");
  });
});

describe("symlinks (plan 02 §2.2; paths.ts O_NOFOLLOW)", () => {
  it("a symlinked session.json is refused on read and on write; the target is never written", async () => {
    mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
    const target = path.join(tmp.dir, "elsewhere.json");
    writeFileSync(target, "decoy", { mode: 0o600 });
    symlinkSync(target, file);
    const store = createFileCredentialStore(opts());
    await expectStoreError(store.read(), "insecure_location", "symlink");
    await expectStoreError(
      store.write(cookies(), metaFor(cookies(), AT)),
      "insecure_location",
      "symlink",
    );
    expect(readFileSync(target, "utf8")).toBe("decoy");
    expect(await store.exists()).toBe(true);
    // delete unlinks the planted link, never its target
    await store.delete();
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("decoy");
  });
  it("a symlinked config directory is refused", async () => {
    const real = path.join(tmp.dir, "real-dir");
    mkdirSync(real, { mode: 0o700 });
    mkdirSync(path.dirname(cfgDir), { recursive: true, mode: 0o700 });
    symlinkSync(real, cfgDir);
    const store = createFileCredentialStore(opts());
    await expectStoreError(store.read(), "insecure_location", "symlink");
    await expectStoreError(
      store.write(cookies(), metaFor(cookies(), AT)),
      "insecure_location",
      "symlink",
    );
    expect(readdirSync(real)).toEqual([]);
  });
  it("a FIFO at the path is refused (never blocks)", async () => {
    mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
    execFileSync("mkfifo", ["-m", "600", file]);
    const store = createFileCredentialStore(opts());
    await expectStoreError(store.read(), "insecure_location", "not_regular_file");
  });
});

describe("location rule: iCloud / file provider, synced folders, repositories (plan 02 §8 #7)", () => {
  it("a file-provider xattr on the directory chain refuses the write and the read", async () => {
    const marked = createFileCredentialStore(
      opts({ xattr: xattrsOn(home, ["com.apple.file-provider-domain-id"]) }),
    );
    await expectStoreError(
      marked.write(cookies(), metaFor(cookies(), AT)),
      "insecure_location",
      "file_provider",
    );
    expect(existsSync(file)).toBe(false);
    // a file written while unmarked is refused once the directory becomes managed
    await createFileCredentialStore(opts()).write(cookies(), metaFor(cookies(), AT));
    await expectStoreError(marked.read(), "insecure_location", "file_provider");
    expect(() => {
      marked.verifyLocation();
    }).toThrow(CredentialStoreError);
  });
  it("an icloud.* xattr is refused too; an unrelated xattr is not", async () => {
    await expectStoreError(
      createFileCredentialStore(
        opts({ xattr: xattrsOn(home, ["com.apple.icloud.itemName"]) }),
      ).write(cookies(), metaFor(cookies(), AT)),
      "insecure_location",
      "file_provider",
    );
    await createFileCredentialStore(
      opts({ xattr: xattrsOn(home, ["com.apple.quarantine"]) }),
    ).write(cookies(), metaFor(cookies(), AT));
  });
  it("an unreadable xattr set fails closed (xattr_unverifiable)", async () => {
    await expectStoreError(
      createFileCredentialStore(opts({ xattr: brokenXattrs })).write(
        cookies(),
        metaFor(cookies(), AT),
      ),
      "insecure_location",
      "xattr_unverifiable",
    );
  });
  it("a synced folder by name (~/Documents) is refused", async () => {
    const synced = path.join(home, "Documents", "eff", "session.json");
    await expectStoreError(
      createFileCredentialStore(opts({ path: synced })).write(cookies(), metaFor(cookies(), AT)),
      "insecure_location",
      "synced_folder",
    );
  });
  it("a path inside a git working tree (this checkout or any other) is refused", async () => {
    await expectStoreError(
      createFileCredentialStore(opts({ path: path.join(ROOT, "session.json") })).write(
        cookies(),
        metaFor(cookies(), AT),
      ),
      "insecure_location",
      "inside_repo",
    );
    await expectStoreError(
      createFileCredentialStore(opts({ gitEntry: (d) => d === home })).write(
        cookies(),
        metaFor(cookies(), AT),
      ),
      "insecure_location",
      "inside_repo",
    );
  });
  it("the location is checked once per instance on read (cached), on every write", async () => {
    let calls = 0;
    const counting = createFileCredentialStore(
      opts({
        xattr: (paths) => {
          calls++;
          return noXattrs(paths);
        },
      }),
    );
    await counting.write(cookies(), metaFor(cookies(), AT));
    const afterWrite = calls;
    await counting.read();
    await counting.read();
    expect(calls).toBe(afterWrite);
    await counting.write(cookies(), metaFor(cookies(), AT));
    expect(calls).toBeGreaterThan(afterWrite);
  });
});

describe("refused values and metadata are never written", () => {
  it("an invalid cookie value is refused before anything touches the disk", async () => {
    const store = createFileCredentialStore(opts());
    const bad = { ...cookies(), espn_s2: `${fakeEspnS2("bad", 120)} trailing` };
    const err = await expectStoreError(store.write(bad, metaFor(cookies(), AT)), "invalid_format");
    expect(renderings(err)).not.toContain(bad.espn_s2.slice(0, 30));
    expect(existsSync(cfgDir)).toBe(false);
  });
  it("metadata that is malformed or belongs to another value is refused (corrupt)", async () => {
    const store = createFileCredentialStore(opts());
    const c = cookies();
    await expectStoreError(store.write(c, { ...metaFor(c, AT), storedAt: "yesterday" }), "corrupt");
    await expectStoreError(store.write(c, metaFor(cookies("other"), AT)), "corrupt");
    expect(existsSync(cfgDir)).toBe(false);
  });
});

describe("hostile and damaged files (typed errors, no value in any rendering)", () => {
  const plant = (body: string | Buffer): void => {
    mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
    writeFileSync(file, body, { mode: 0o600 });
  };
  it.each([
    ["not JSON", "{not json"],
    ["truncated", '{"format_version":1,"storedAt":"2026-10-06T12:00:00.000Z"'],
    ["an array", "[]"],
    ["null", "null"],
    [
      "missing espn_s2",
      '{"format_version":1,"storedAt":"2026-10-06T12:00:00.000Z","fingerprint":"abcdef","SWID":"x"}',
    ],
    ["wrong types", '{"format_version":"1","storedAt":1,"fingerprint":2,"espn_s2":3,"SWID":4}'],
    ["a __proto__ key only", '{"__proto__":{"espn_s2":"x"}}'],
  ])("%s → corrupt", async (_n, body) => {
    plant(body);
    await expectStoreError(createFileCredentialStore(opts()).read(), "corrupt");
  });
  it("a fingerprint that does not match the value → corrupt (a hand-edited or swapped value)", async () => {
    const c = cookies();
    plant(sessionFileBody(c, metaFor(cookies("other"), AT)));
    const err = await expectStoreError(createFileCredentialStore(opts()).read(), "corrupt");
    expect(renderings(err)).not.toContain(c.espn_s2.slice(0, 24));
  });
  it("a newer format_version → newer_format (plan 03 §7: refused, never guessed)", async () => {
    const c = cookies();
    plant(sessionFileBody(c, { ...metaFor(c, AT), format_version: 2 }));
    await expectStoreError(createFileCredentialStore(opts()).read(), "newer_format");
  });
  it("a stored value that fails the format rules → invalid_format, without the value", async () => {
    const c = { ...cookies(), espn_s2: fakeEspnS2("short", 120).slice(0, 30) };
    plant(sessionFileBody(c, metaFor(c, AT)));
    const err = await expectStoreError(createFileCredentialStore(opts()).read(), "invalid_format");
    expect(renderings(err)).not.toContain(c.espn_s2);
  });
  it("an oversized file is refused before it is read into memory", async () => {
    plant(Buffer.alloc(SESSION_FILE_MAX_BYTES + 1, 0x20));
    await expectStoreError(
      createFileCredentialStore(opts()).read(),
      "insecure_location",
      "too_large",
    );
  });
  it("parseSessionFile ignores unknown keys (forward compatible) and needs both values", () => {
    const c = cookies();
    const body = JSON.parse(sessionFileBody(c, metaFor(c, AT))) as Record<string, unknown>;
    expect(parseSessionFile(JSON.stringify({ ...body, extra: { nested: true } })).cookies).toEqual(
      c,
    );
    const noSwid = { ...body };
    delete noSwid.SWID;
    expect(() => parseSessionFile(JSON.stringify(noSwid))).toThrow(CredentialStoreError);
  });
});

describe("delete (setup --reset, a failed setup, uninstall)", () => {
  it("removes the file and our leftover temp files, nothing else; idempotent", async () => {
    const store = createFileCredentialStore(opts());
    await store.write(cookies(), metaFor(cookies(), AT));
    writeFileSync(path.join(cfgDir, "session.json.123.0a1b2c3d4e5f.tmp"), "x", { mode: 0o600 });
    writeFileSync(path.join(cfgDir, "config.json"), "{}", { mode: 0o600 });
    writeFileSync(path.join(cfgDir, "session.json.backup"), "keep", { mode: 0o600 });
    await store.delete();
    expect(readdirSync(cfgDir).sort()).toEqual(["config.json", "session.json.backup"]);
    await store.delete();
    expect(await store.exists()).toBe(false);
  });
  it("works when the directory does not exist", async () => {
    await createFileCredentialStore(opts()).delete();
    expect(existsSync(cfgDir)).toBe(false);
  });
  it("a directory at the path cannot be deleted as a file → delete_failed", async () => {
    mkdirSync(file, { recursive: true, mode: 0o700 });
    await expectStoreError(createFileCredentialStore(opts()).delete(), "delete_failed");
    expect(lstatSync(file).isDirectory()).toBe(true);
  });
});

describe("fileStoreExistsSync (the startup stat — plan 03 §1.1 step 4)", () => {
  it("true for any entry, false when absent or under a file", () => {
    expect(fileStoreExistsSync(file)).toBe(false);
    mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(cfgDir, "plain"), "x");
    expect(fileStoreExistsSync(path.join(cfgDir, "plain", "under"))).toBe(false);
    writeFileSync(file, "x", { mode: 0o600 });
    expect(fileStoreExistsSync(file)).toBe(true);
  });
});
