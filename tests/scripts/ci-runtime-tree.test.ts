// ci-runtime-tree.test.ts — scripts/ci/check-runtime-tree.mjs must FAIL on any addition, removal or
// version drift at any depth of the runtime tree, on zero or two keyring platform packages, and on
// non-registry provenance (plan 04 §2, §4.1, R11). Ported from sibling @d72e03b, adapted (`oneOf`,
// unmet optional dependencies).
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkLockProvenance,
  compareTree,
  parseAllowlist,
} from "../../scripts/ci/check-runtime-tree.mjs";
import { flattenTree } from "../../scripts/ci/_lib.mjs";
import { ROOT, runCheck, tempDir, writeTree } from "../lint/helpers.js";

const allow = {
  count: 3,
  packages: ["a@1.0.0", "b@2.0.0"],
  oneOf: ["p-mac@1.0.0", "p-linux@1.0.0"],
};

describe("compareTree", () => {
  it("passes on the packages plus exactly one platform package", () => {
    expect(compareTree(["b@2.0.0", "a@1.0.0", "p-linux@1.0.0"], allow)).toEqual([]);
    expect(compareTree(["b@2.0.0", "a@1.0.0", "p-mac@1.0.0"], allow)).toEqual([]);
  });
  it("fails on a transitive addition", () => {
    expect(
      compareTree(["a@1.0.0", "b@2.0.0", "p-mac@1.0.0", "sneaky@0.0.1"], allow).join(),
    ).toContain("not on the allow-list: sneaky@0.0.1");
  });
  it("fails on a removal", () => {
    expect(compareTree(["a@1.0.0", "p-mac@1.0.0"], allow).join()).toContain(
      "not installed: b@2.0.0",
    );
  });
  it("fails on version drift (both directions reported)", () => {
    const e = compareTree(["a@1.0.0", "b@2.0.1", "p-mac@1.0.0"], allow).join("\n");
    expect(e).toContain("not on the allow-list: b@2.0.1");
    expect(e).toContain("not installed: b@2.0.0");
  });
  it("fails on zero platform packages and on two", () => {
    expect(compareTree(["a@1.0.0", "b@2.0.0"], allow).join()).toContain("found 0");
    expect(
      compareTree(["a@1.0.0", "b@2.0.0", "p-mac@1.0.0", "p-linux@1.0.0"], allow).join(),
    ).toContain("found 2");
  });
  it("fails on a platform package at another version", () => {
    expect(compareTree(["a@1.0.0", "b@2.0.0", "p-mac@1.0.1"], allow).join()).toContain(
      "not on the allow-list: p-mac@1.0.1",
    );
  });
});

describe("parseAllowlist", () => {
  it.each([
    [null, /object/],
    [{ count: 2, packages: ["a@1.0.0", "a@1.0.0"] }, /duplicate/],
    [{ count: 3, packages: ["a@1.0.0"] }, /count/],
    [{ count: -1, packages: [] }, /count/],
    [{ count: 1.5, packages: [] }, /count/],
    [{ count: 1, packages: ["a@^1.0.0"] }, /exact/],
    [{ count: 1, packages: ["a"] }, /exact/],
    [{ count: 1, packages: [7] }, /strings/],
    [{ count: 1, packages: ["a@1.0.0\n"] }, /exact/],
    [{ count: 1, packages: ["a@1.0.0"], oneOf: ["a@1.0.0"] }, /both/],
    [{ count: 1, packages: ["a@1.0.0"], oneOf: ["p@1.0.0"] }, /count/],
    [{ count: 2, packages: ["a@1.0.0"], oneOf: "p@1.0.0" }, /oneOf/],
  ])("rejects %j", (raw, why) => {
    expect(() => parseAllowlist(raw)).toThrow(why);
  });
  it("accepts scoped names, prereleases and an absent oneOf", () => {
    expect(parseAllowlist({ count: 2, packages: ["@s/p@1.2.3", "q@1.0.0-rc.1"] }).oneOf).toEqual(
      [],
    );
  });
  it("the committed allow-list parses: 5 packages + one of 12 = 6", () => {
    const raw = JSON.parse(
      readFileSync(path.join(ROOT, "scripts/ci/runtime-allowlist.json"), "utf8"),
    ) as unknown;
    const a = parseAllowlist(raw);
    expect(a.count).toBe(6);
    expect(a.oneOf).toHaveLength(12);
    expect(a.packages).toContain("@napi-rs/keyring@2.1.0");
  });
});

describe("checkLockProvenance", () => {
  const good = { resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz", integrity: "sha512-AAAA" };
  it("passes registry + sha512 entries (optional ones included) and ignores dev entries", () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/a": good,
        "node_modules/p": { ...good, optional: true },
        "node_modules/d": { dev: true, resolved: "git+x" },
      },
    };
    expect(checkLockProvenance(lock)).toEqual([]);
  });
  it.each([
    [{ ...good, resolved: "https://evil.example/a.tgz" }, /resolved from/],
    [{ ...good, resolved: "git+https://github.com/x/a.git" }, /resolved from/],
    [{ ...good, resolved: "https://registry.npmjs.org.evil.example/a.tgz" }, /resolved from/],
    [{ ...good, integrity: "sha1-AAAA" }, /sha512/],
    [{ resolved: good.resolved }, /sha512/],
    [{ link: true }, /link/],
    [{ ...good, optional: true, resolved: "https://evil.example/p.tgz" }, /resolved from/],
  ])("fails on %j", (entry, why) => {
    const lock = { lockfileVersion: 3, packages: { "node_modules/a": entry } };
    expect(checkLockProvenance(lock).join()).toMatch(why);
  });
  it("fails on a non-v3 or malformed lockfile", () => {
    expect(checkLockProvenance({ lockfileVersion: 2, packages: {} })).toHaveLength(1);
    expect(checkLockProvenance({})).toHaveLength(1);
    expect(checkLockProvenance(null)).toHaveLength(1);
  });
});

describe("flattenTree", () => {
  it("dedupes and records missing/invalid/extraneous problems", () => {
    const t = flattenTree({
      dependencies: {
        a: {
          version: "1.0.0",
          path: "/x/a",
          dependencies: { c: { version: "3.0.0", path: "/x/c" } },
        },
        b: { version: "2.0.0", dependencies: { c: { version: "3.0.0" } } },
        m: { missing: true },
        e: { version: "1.0.0", extraneous: true },
        i: { version: "1.0.0", invalid: true },
      },
      problems: ["missing: m@1"],
    });
    expect([...t.nodes.keys()].sort()).toEqual([
      "a@1.0.0",
      "b@2.0.0",
      "c@3.0.0",
      "e@1.0.0",
      "i@1.0.0",
    ]);
    expect(t.nodes.get("c@3.0.0")?.path).toBe("/x/c");
    expect(t.problems.join("\n")).toMatch(/missing: m[\s\S]*extraneous: e[\s\S]*invalid: i/);
  });

  it("an empty entry is an UNMET OPTIONAL dependency only when the parent declares it optional", () => {
    const t = flattenTree({
      dependencies: {
        k: {
          version: "2.1.0",
          optionalDependencies: { "k-mac": "2.1.0", "k-linux": "2.1.0" },
          dependencies: { "k-mac": {}, "k-linux": { version: "2.1.0", optional: true } },
        },
        // an empty entry for something NOT declared optional is a problem
        ghost: {},
      },
    });
    expect(t.unmetOptional).toEqual(["k-mac"]);
    expect([...t.nodes.keys()].sort()).toEqual(["k-linux@2.1.0", "k@2.1.0"]);
    expect(t.nodes.get("k-linux@2.1.0")?.optional).toBe(true);
    expect(t.problems).toEqual(["no version for ghost"]);
  });

  it("rejects non-object output and a pathologically deep tree", () => {
    expect(() => flattenTree("x")).toThrow();
    expect(() => flattenTree([])).toThrow();
    let deep: Record<string, unknown> = { version: "1.0.0" };
    for (let i = 0; i < 205; i++)
      deep = { version: "1.0.0", dependencies: { [`n${String(i)}`]: deep } };
    expect(() => flattenTree({ dependencies: { root: deep } })).toThrow(/deeper/);
  });
});

describe("check-runtime-tree CLI", () => {
  let tmp: ReturnType<typeof tempDir> | undefined;
  afterEach(() => tmp?.cleanup());

  it("exits 0 on this repository against the committed allow-list", () => {
    const r = runCheck("check-runtime-tree.mjs", []);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("exits 1 and names the package when the allow-list lacks one (a transitive addition)", () => {
    tmp = tempDir();
    const committed = JSON.parse(
      readFileSync(path.join(ROOT, "scripts/ci/runtime-allowlist.json"), "utf8"),
    ) as {
      packages: string[];
      oneOf: string[];
    };
    const packages = committed.packages.filter((p) => !p.startsWith("@modelcontextprotocol/core@"));
    writeTree(tmp.dir, {
      "allow.json": { count: packages.length + 1, packages, oneOf: committed.oneOf },
    });
    const r = runCheck("check-runtime-tree.mjs", ["--allowlist", path.join(tmp.dir, "allow.json")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not on the allow-list: @modelcontextprotocol/core@2.2.0");
  });

  it("exits 2 on a malformed allow-list", () => {
    tmp = tempDir();
    writeTree(tmp.dir, { "allow.json": "{ not json" });
    expect(
      runCheck("check-runtime-tree.mjs", ["--allowlist", path.join(tmp.dir, "allow.json")]).status,
    ).toBe(2);
  });

  it("--print emits the current tree (6 packages)", () => {
    const r = runCheck("check-runtime-tree.mjs", ["--print"]);
    expect(r.status).toBe(0);
    expect((JSON.parse(r.stdout) as { count: number }).count).toBe(6);
  });
});
