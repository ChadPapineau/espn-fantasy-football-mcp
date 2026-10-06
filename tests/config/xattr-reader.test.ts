// xattr-reader.test.ts — the darwin branch of src/config/paths.ts `systemXattrReader` on every
// runner (the CI runner is Linux): spawnSync is mocked so the argument array, the bounds and the
// fail-closed paths (spawn error, timeout, non-zero exit, no stdout) are asserted without a Mac.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSync = vi.fn();
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawnSync,
}));

const { XATTR_BIN, systemXattrReader } = await import("../../src/config/paths.js");

const realPlatform = process.platform;
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  spawnSync.mockReset();
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

describe("systemXattrReader on darwin", () => {
  it("spawns /usr/bin/xattr once with an argument array, no shell, bounded", () => {
    spawnSync.mockReturnValue({
      status: 0,
      stdout: "/a: com.apple.icloud.x\n/b: com.apple.quarantine\n",
    });
    const m = systemXattrReader(["/a", "/b"]);
    expect(spawnSync).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = spawnSync.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(bin).toBe(XATTR_BIN);
    expect(args).toEqual(["/a", "/b"]);
    expect(opts).toMatchObject({ shell: false, timeout: 2000, maxBuffer: 256 * 1024 });
    expect(m?.get("/a")).toEqual(["com.apple.icloud.x"]);
    expect(m?.get("/b")).toEqual(["com.apple.quarantine"]);
  });
  it.each([
    ["a spawn error", { error: new Error("ENOENT"), status: null, stdout: "" }],
    [
      "a timeout",
      { error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }), status: null, stdout: "" },
    ],
    ["a non-zero exit", { status: 1, stdout: "" }],
    ["no stdout", { status: 0, stdout: null }],
  ])("fails closed (null) on %s", (_name, result) => {
    spawnSync.mockReturnValue(result);
    expect(systemXattrReader(["/a"])).toBeNull();
  });
  it("never spawns for an empty path list", () => {
    expect(systemXattrReader([])?.size).toBe(0);
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
