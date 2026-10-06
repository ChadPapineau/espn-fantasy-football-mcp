// file-crash.test.ts — src/auth/file.ts atomicity (plan 05 §2 `auth/file`: "crash injected between
// temp write and rename leaves the old file intact"; plan 02 §2.2 "Write"): node:fs `renameSync` is
// made to fail once, after the temp file has been written and fsynced; the previous session.json is
// byte-identical, no temp file survives, and the error is the fixed-text `write_failed`.
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEspnS2, fakeGuid } from "../../scripts/ci/secret-fixtures.mjs";

const fail = { rename: false };
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  return {
    ...real,
    renameSync: (from: string, to: string) => {
      if (fail.rename) {
        fail.rename = false;
        throw Object.assign(new Error("injected crash between write and rename"), { code: "EIO" });
      }
      real.renameSync(from, to);
    },
  };
});

const { createFileCredentialStore } = await import("../../src/auth/file.js");
const { CredentialStoreError } = await import("../../src/auth/errors.js");
const { metaFor } = await import("../../src/auth/upgrade.js");
const { ROOT, noXattrs, tempDir } = await import("../config/helpers.js");

let tmp: { dir: string; cleanup: () => void };
let file: string;
beforeEach(() => {
  tmp = tempDir("eff-auth-crash-");
  mkdirSync(path.join(tmp.dir, "cfg"), { mode: 0o700 });
  file = path.join(tmp.dir, "cfg", "session.json");
});
afterEach(() => {
  fail.rename = false;
  tmp.cleanup();
});

describe("a crash between the temp write and the rename", () => {
  it("leaves the old file intact and no temp file behind", async () => {
    const store = createFileCredentialStore({
      path: file,
      home: tmp.dir,
      repoRoot: ROOT,
      xattr: noXattrs,
      gitEntry: () => false,
    });
    const a = { espn_s2: fakeEspnS2("crash-a", 200), swid: `{${fakeGuid("crash-a")}}` };
    await store.write(a, metaFor(a, "2026-10-01T00:00:00.000Z"));
    const before = readFileSync(file);

    const b = { espn_s2: fakeEspnS2("crash-b", 200), swid: `{${fakeGuid("crash-b")}}` };
    fail.rename = true;
    const err = await store.write(b, metaFor(b, "2026-10-02T00:00:00.000Z")).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CredentialStoreError);
    expect((err as InstanceType<typeof CredentialStoreError>).reason).toBe("write_failed");
    expect(String(err)).not.toContain("injected");
    expect(String(err)).not.toContain(b.espn_s2.slice(0, 24));

    expect(readFileSync(file).equals(before)).toBe(true);
    expect(readdirSync(path.dirname(file))).toEqual(["session.json"]);
    expect((await store.read())?.cookies).toEqual(a);
  });
});
