// acl-reader.test.ts — the darwin branch of src/config/paths.ts `createSystemAcl` on every runner
// (the CI runner is Linux): spawnSync is mocked, the files are real, so the argument arrays, the
// bounds, the fail-closed paths (spawn error, non-zero exit, no stdout, unparsable output, a missing
// or renamed path) and the inode-state cache are asserted without a Mac (Stage C finding
// paths-acl-bypasses-private-check). The real `ls`/`chmod` are exercised in acl.test.ts on macOS.
import { chmodSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSync = vi.fn();
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawnSync,
}));

const { ACL_CACHE_MAX, CHMOD_BIN, LS_BIN, createSystemAcl } =
  await import("../../src/config/paths.js");
const { tempDir } = await import("./helpers.js");

const realPlatform = process.platform;
let tmp: { dir: string; cleanup: () => void };
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  spawnSync.mockReset();
  tmp = tempDir("eff-acl-reader-");
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  tmp.cleanup();
});

const LISTING = "drwx------@ 2 me  staff  64 Oct 20 04:37 /x\n";
const WITH_ENTRY = `${LISTING} 0: group:staff inherited allow list,search\n`;

/** Changes `p`'s change time for certain (Linux timestamps are coarse: one tick can hold two edits). */
function bumpCtime(p: string): void {
  const before = lstatSync(p, { bigint: true }).ctimeNs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 200; i++) {
    chmodSync(p, i % 2 === 0 ? 0o755 : 0o700);
    if (lstatSync(p, { bigint: true }).ctimeNs !== before) break;
    Atomics.wait(pause, 0, 0, 5);
  }
  chmodSync(p, 0o700);
  expect(lstatSync(p, { bigint: true }).ctimeNs).not.toBe(before);
}

describe("createSystemAcl().read on darwin", () => {
  it("spawns /bin/ls -ledq -- <path> with an argument array, no shell, bounded, a C locale only", () => {
    spawnSync.mockReturnValue({ status: 0, stdout: WITH_ENTRY });
    const acl = createSystemAcl();
    expect(acl.read(tmp.dir)).toEqual([
      { principal: "group:staff", inherited: true, kind: "allow", perms: ["list", "search"] },
    ]);
    expect(spawnSync).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = spawnSync.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(bin).toBe(LS_BIN);
    expect(args).toEqual(["-ledq", "--", tmp.dir]);
    expect(opts).toMatchObject({
      shell: false,
      timeout: 2000,
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      env: { LC_ALL: "C" },
    });
    expect(Object.keys(opts.env as object)).toEqual(["LC_ALL"]);
  });

  it.each([
    ["a spawn error", { error: new Error("ENOENT"), status: null, stdout: "" }],
    ["a non-zero exit", { status: 1, stdout: LISTING }],
    ["no stdout", { status: 0, stdout: null }],
    ["output it cannot parse", { status: 0, stdout: `${LISTING}not an entry\n` }],
  ])("fails closed (null) on %s", (_name, result) => {
    spawnSync.mockReturnValue(result);
    expect(createSystemAcl().read(tmp.dir)).toBeNull();
  });

  it("a missing path is null without a spawn", () => {
    expect(createSystemAcl().read(path.join(tmp.dir, "missing"))).toBeNull();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("a path renamed over while it is listed is null (the listing may be of another inode)", () => {
    const f = path.join(tmp.dir, "f");
    const g = path.join(tmp.dir, "g");
    writeFileSync(f, "1", { mode: 0o600 });
    writeFileSync(g, "2", { mode: 0o600 });
    spawnSync.mockImplementation(() => {
      renameSync(g, f);
      return { status: 0, stdout: LISTING };
    });
    expect(createSystemAcl().read(f)).toBeNull();
  });

  it("a path removed while it is listed is null", () => {
    const d = path.join(tmp.dir, "d");
    mkdirSync(d, { mode: 0o700 });
    spawnSync.mockImplementation(() => {
      rmSync(d, { recursive: true });
      return { status: 0, stdout: LISTING };
    });
    expect(createSystemAcl().read(d)).toBeNull();
  });

  it("an unchanged inode is listed once; any change to it (an ACL edit moves ctime) is listed again", () => {
    spawnSync.mockReturnValue({ status: 0, stdout: LISTING });
    const acl = createSystemAcl();
    expect(acl.read(tmp.dir)).toEqual([]);
    expect(acl.read(tmp.dir)).toEqual([]);
    expect(spawnSync).toHaveBeenCalledTimes(1);
    bumpCtime(tmp.dir);
    spawnSync.mockReturnValue({ status: 0, stdout: WITH_ENTRY });
    expect(acl.read(tmp.dir)).toHaveLength(1);
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });

  it("a failed listing is never cached; each access keeps its own cache", () => {
    spawnSync.mockReturnValueOnce({ status: 1, stdout: "" });
    const acl = createSystemAcl();
    expect(acl.read(tmp.dir)).toBeNull();
    spawnSync.mockReturnValue({ status: 0, stdout: LISTING });
    expect(acl.read(tmp.dir)).toEqual([]);
    expect(createSystemAcl().read(tmp.dir)).toEqual([]);
    expect(spawnSync).toHaveBeenCalledTimes(3);
  });

  it(`keeps at most ${String(ACL_CACHE_MAX)} verdicts, the oldest going first`, () => {
    spawnSync.mockReturnValue({ status: 0, stdout: LISTING });
    const acl = createSystemAcl();
    const files = Array.from({ length: ACL_CACHE_MAX + 1 }, (_, i) => {
      const f = path.join(tmp.dir, `f${String(i)}`);
      writeFileSync(f, "x", { mode: 0o600 });
      return f;
    });
    for (const f of files) acl.read(f);
    expect(spawnSync).toHaveBeenCalledTimes(ACL_CACHE_MAX + 1);
    acl.read(files[ACL_CACHE_MAX] ?? "");
    expect(spawnSync).toHaveBeenCalledTimes(ACL_CACHE_MAX + 1);
    acl.read(files[0] ?? "");
    expect(spawnSync).toHaveBeenCalledTimes(ACL_CACHE_MAX + 2);
  });
});

describe("createSystemAcl().strip on darwin", () => {
  it("spawns /bin/chmod -h -N <absolute path> (no symlink followed; a relative path is resolved)", () => {
    spawnSync.mockReturnValue({ status: 0, stdout: "" });
    const acl = createSystemAcl();
    expect(acl.strip(tmp.dir)).toBe(true);
    expect(acl.strip("relative/dir")).toBe(true);
    const calls = spawnSync.mock.calls as [string, string[], Record<string, unknown>][];
    expect(calls.map(([bin, args]) => [bin, args])).toEqual([
      [CHMOD_BIN, ["-h", "-N", tmp.dir]],
      [CHMOD_BIN, ["-h", "-N", path.resolve("relative/dir")]],
    ]);
    expect(calls[0]?.[2]).toMatchObject({ shell: false, timeout: 2000 });
  });
  it("is false when chmod fails or cannot run", () => {
    spawnSync.mockReturnValueOnce({ status: 1, stdout: "" });
    spawnSync.mockReturnValueOnce({ error: new Error("EAGAIN"), status: null, stdout: "" });
    const acl = createSystemAcl();
    expect(acl.strip(tmp.dir)).toBe(false);
    expect(acl.strip(tmp.dir)).toBe(false);
  });
});

describe("createSystemAcl().owner", () => {
  it("is this account's name", () => {
    expect(createSystemAcl().owner()).toBe(userInfo().username);
  });
});
