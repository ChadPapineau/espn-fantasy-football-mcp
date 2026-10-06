// eff-launch.test.ts — the plugin launch shim's resolution order and failure modes (plan 09 §4, K8;
// plan 03 §4; ADV OBJ-12, OBJ-23): EFF_NODE → fnm default → nvm default → /opt/homebrew/bin/node →
// /usr/local/bin/node → `command -v node`, a Node >= 24.15, exec <node> <root>/dist/cli.js "$@".
// Every candidate is a FAKE node (a sh script) in a temp tree, with HOME, PATH, FNM_DIR and NVM_DIR
// fully controlled; the two fixed Homebrew paths cannot be faked, so the tests that reach them
// compute the expectation from what this machine actually has there (which still pins the order).
// Run under /bin/sh — dash on the CI runner, so bashisms fail here.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ROOT, tempDir } from "../lint/helpers.js";

const SHIM = path.join(ROOT, "scripts", "eff-launch.sh");

let tmp: ReturnType<typeof tempDir> | undefined;
afterEach(() => {
  tmp?.cleanup();
  tmp = undefined;
});

/** A fake node: answers `-p process.versions.node` with `version`, otherwise echoes its argv. */
function fakeNode(file: string, label: string, version: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    [
      "#!/bin/sh",
      `if [ "$1" = "-p" ]; then printf '%s\\n' '${version}'; exit 0; fi`,
      `printf 'ran:%s' '${label}'`,
      `for a in "$@"; do printf '|%s' "$a"; done`,
      "printf '\\n'",
      "",
    ].join("\n"),
  );
  chmodSync(file, 0o755);
  return file;
}

interface Env {
  home: string;
  pathDir: string;
  root: string;
  dir: string;
}

function setup(rootName = "plugin root"): Env {
  tmp = tempDir("eff-shim-");
  const home = path.join(tmp.dir, "home");
  const pathDir = path.join(tmp.dir, "pathbin");
  const root = path.join(tmp.dir, rootName);
  mkdirSync(home, { recursive: true });
  mkdirSync(pathDir, { recursive: true });
  mkdirSync(path.join(root, "dist"), { recursive: true });
  writeFileSync(path.join(root, "dist", "cli.js"), "// fake cli\n");
  return { home, pathDir, root, dir: tmp.dir };
}

function run(
  e: Env,
  extra: Record<string, string> = {},
  args: string[] = ["serve"],
  shim = SHIM,
): { status: number | null; out: string; err: string } {
  const env: Record<string, string> = {
    HOME: e.home,
    PATH: `${e.pathDir}:/usr/bin:/bin`,
    CLAUDE_PLUGIN_ROOT: e.root,
    ...extra,
  };
  for (const [k, v] of Object.entries(env)) if (v === "<unset>") Reflect.deleteProperty(env, k);
  const r = spawnSync("/bin/sh", [shim, ...args], { env, encoding: "utf8", timeout: 30_000 });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

/** What the shim would find at the two fixed Homebrew paths on THIS machine (null: none qualifies). */
function systemNode(): string | null {
  for (const p of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    if (!existsSync(p)) continue;
    const r = spawnSync(p, ["-p", "process.versions.node"], { encoding: "utf8" });
    const [maj = 0, min = 0] = (r.stdout || "0.0").trim().split(".").map(Number);
    if (r.status === 0 && (maj > 24 || (maj === 24 && min >= 15))) return p;
  }
  return null;
}

const cliOf = (e: Env) => path.join(e.root, "dist", "cli.js");

describe("resolution order", () => {
  it("1. EFF_NODE wins over every other candidate, and the argv reaches the CLI verbatim", () => {
    const e = setup();
    const node = fakeNode(path.join(e.dir, "custom", "node"), "eff-node", "24.15.0");
    fakeNode(path.join(e.home, ".fnm", "aliases", "default", "bin", "node"), "fnm", "24.21.0");
    fakeNode(path.join(e.pathDir, "node"), "path", "26.0.0");
    const r = run(e, { EFF_NODE: node }, ["serve", "a b", "$HOME", "--x=1", "", "ü;|&"]);
    expect(r.status, r.err).toBe(0);
    expect(r.out.trim()).toBe(`ran:eff-node|${cliOf(e)}|serve|a b|$HOME|--x=1||ü;|&`);
  });

  it("an invalid EFF_NODE is an error — never a silent fallback to another node", () => {
    const e = setup();
    fakeNode(path.join(e.home, ".fnm", "aliases", "default", "bin", "node"), "fnm", "24.21.0");
    for (const bad of [
      fakeNode(path.join(e.dir, "old", "node"), "old", "24.14.9"),
      path.join(e.dir, "missing", "node"),
      e.dir, // a directory
    ]) {
      const r = run(e, { EFF_NODE: bad });
      expect(r.status, bad).toBe(1);
      expect(r.out).toBe("");
      expect(r.err).toContain("EFF_NODE is set but is not an executable Node >= 24.15");
      expect(r.err).toContain("fnm install 24 && fnm default 24");
    }
  });

  it("2. the fnm default ($FNM_DIR) comes before nvm and PATH", () => {
    const e = setup();
    const fnmDir = path.join(e.dir, "fnm dir with space");
    fakeNode(path.join(fnmDir, "aliases", "default", "bin", "node"), "fnm", "24.21.0");
    fakeNode(
      path.join(e.home, ".nvm", "versions", "node", "v24.20.0", "bin", "node"),
      "nvm",
      "24.20.0",
    );
    mkdirSync(path.join(e.home, ".nvm", "alias"), { recursive: true });
    writeFileSync(path.join(e.home, ".nvm", "alias", "default"), "24\n");
    fakeNode(path.join(e.pathDir, "node"), "path", "26.0.0");
    const r = run(e, { FNM_DIR: fnmDir });
    expect(r.out).toMatch(/^ran:fnm\|/);
  });

  it.each([".local/share/fnm", "Library/Application Support/fnm", ".fnm"])(
    "the fnm default is found under ~/%s when FNM_DIR is unset",
    (sub) => {
      const e = setup();
      fakeNode(path.join(e.home, sub, "aliases", "default", "bin", "node"), "fnm", "24.15.0");
      const r = run(e, { FNM_DIR: "<unset>" });
      expect(r.out).toMatch(/^ran:fnm\|/);
    },
  );

  it("an fnm default below 24.15 is skipped for the nvm default", () => {
    const e = setup();
    fakeNode(path.join(e.home, ".fnm", "aliases", "default", "bin", "node"), "fnm-old", "22.23.2");
    fakeNode(
      path.join(e.home, ".nvm", "versions", "node", "v24.16.0", "bin", "node"),
      "nvm",
      "24.16.0",
    );
    mkdirSync(path.join(e.home, ".nvm", "alias"), { recursive: true });
    writeFileSync(path.join(e.home, ".nvm", "alias", "default"), "v24.16.0\n");
    const r = run(e);
    expect(r.out).toMatch(/^ran:nvm\|/);
  });

  it("3. nvm: a major alias picks the highest installed version, compared numerically", () => {
    const e = setup();
    const nvm = path.join(e.dir, "nvm");
    for (const v of ["24.9.0", "24.15.0", "24.20.1", "26.1.0"]) {
      fakeNode(path.join(nvm, "versions", "node", `v${v}`, "bin", "node"), `nvm-${v}`, v);
    }
    mkdirSync(path.join(nvm, "alias"), { recursive: true });
    writeFileSync(path.join(nvm, "alias", "default"), "24\n");
    expect(run(e, { NVM_DIR: nvm }).out).toMatch(/^ran:nvm-24\.20\.1\|/);
  });

  it("nvm: `24.1` matches 24.1.x only, never 24.15.0 (component boundary)", () => {
    const e = setup();
    const nvm = path.join(e.dir, "nvm");
    fakeNode(path.join(nvm, "versions", "node", "v24.15.0", "bin", "node"), "nvm-24.15", "24.15.0");
    mkdirSync(path.join(nvm, "alias"), { recursive: true });
    writeFileSync(path.join(nvm, "alias", "default"), "24.1\n");
    fakeNode(path.join(e.pathDir, "node"), "path", "24.30.0");
    const r = run(e, { NVM_DIR: nvm });
    expect(r.out).not.toMatch(/^ran:nvm-24\.15\|/);
  });

  it("nvm: an alias chain (default -> lts/krypton -> v24.16.0) is followed", () => {
    const e = setup();
    const nvm = path.join(e.dir, "nvm");
    fakeNode(path.join(nvm, "versions", "node", "v24.16.0", "bin", "node"), "nvm-lts", "24.16.0");
    fakeNode(path.join(nvm, "versions", "node", "v26.0.0", "bin", "node"), "nvm-26", "26.0.0");
    mkdirSync(path.join(nvm, "alias", "lts"), { recursive: true });
    writeFileSync(path.join(nvm, "alias", "default"), "lts/krypton\n");
    writeFileSync(path.join(nvm, "alias", "lts", "krypton"), "v24.16.0\n");
    expect(run(e, { NVM_DIR: nvm }).out).toMatch(/^ran:nvm-lts\|/);
  });

  it("nvm: `node` means the highest installed version", () => {
    const e = setup();
    const nvm = path.join(e.dir, "nvm");
    fakeNode(path.join(nvm, "versions", "node", "v24.16.0", "bin", "node"), "nvm-24", "24.16.0");
    fakeNode(path.join(nvm, "versions", "node", "v26.0.0", "bin", "node"), "nvm-26", "26.0.0");
    mkdirSync(path.join(nvm, "alias"), { recursive: true });
    writeFileSync(path.join(nvm, "alias", "default"), "node\n");
    expect(run(e, { NVM_DIR: nvm }).out).toMatch(/^ran:nvm-26\|/);
  });

  it("4–6. with no fnm/nvm default: a qualifying Homebrew node, else `command -v node`", () => {
    const e = setup();
    fakeNode(path.join(e.pathDir, "node"), "path", "24.15.0");
    const r = run(e);
    expect(r.status, r.err).toBe(0);
    const sys = systemNode();
    if (sys)
      expect(r.out).not.toMatch(/^ran:path\|/); // the fixed path comes BEFORE PATH
    else expect(r.out).toMatch(/^ran:path\|/);
  });

  it("a PATH node below the floor is never used", () => {
    const e = setup();
    fakeNode(path.join(e.pathDir, "node"), "path-old", "24.14.0");
    const r = run(e);
    expect(r.out).not.toContain("ran:path-old");
    if (systemNode() === null) {
      expect(r.status).toBe(1);
      expect(r.err).toContain("no Node.js >= 24.15 found");
      expect(r.err).toContain(
        "tried: fnm default, nvm default, /opt/homebrew/bin/node, /usr/local/bin/node, PATH",
      );
      expect(r.err).toContain("fnm install 24 && fnm default 24");
    }
  });

  it.each([
    ["garbage version", "not-a-version"],
    ["two-part version", "26"],
    ["empty version", ""],
  ])("a candidate with a %s is rejected", (_why, version) => {
    const e = setup();
    fakeNode(path.join(e.home, ".fnm", "aliases", "default", "bin", "node"), "fnm-bad", version);
    const r = run(e);
    expect(r.out).not.toContain("ran:fnm-bad");
  });

  it("a non-executable candidate is rejected", () => {
    const e = setup();
    const f = fakeNode(
      path.join(e.home, ".fnm", "aliases", "default", "bin", "node"),
      "fnm-noexec",
      "24.21.0",
    );
    chmodSync(f, 0o644);
    expect(run(e).out).not.toContain("ran:fnm-noexec");
  });
});

describe("the plugin root and the CLI", () => {
  it("fails with the exact build fix when dist/cli.js is missing", () => {
    const e = setup();
    fakeNode(path.join(e.home, ".fnm", "aliases", "default", "bin", "node"), "fnm", "24.21.0");
    writeFileSync(cliOf(e), "");
    spawnSync("rm", ["-f", cliOf(e)]);
    const r = run(e);
    expect(r.status).toBe(1);
    expect(r.err).toContain("dist/cli.js is missing");
    expect(r.err).toContain("npm ci && npm run build");
  });

  it("derives the root from its own location when CLAUDE_PLUGIN_ROOT is unset (paths with spaces)", () => {
    const e = setup("root with spaces");
    const shim = path.join(e.root, "scripts", "eff-launch.sh");
    mkdirSync(path.dirname(shim), { recursive: true });
    copyFileSync(SHIM, shim);
    fakeNode(path.join(e.home, ".fnm", "aliases", "default", "bin", "node"), "fnm", "24.21.0");
    const r = run(e, { CLAUDE_PLUGIN_ROOT: "<unset>" }, ["serve"], shim);
    expect(r.status, r.err).toBe(0);
    expect(r.out.trim()).toBe(`ran:fnm|${cliOf(e)}|serve`);
  });

  it("an empty CLAUDE_PLUGIN_ROOT is treated as unset", () => {
    const e = setup();
    const shim = path.join(e.root, "scripts", "eff-launch.sh");
    mkdirSync(path.dirname(shim), { recursive: true });
    copyFileSync(SHIM, shim);
    fakeNode(path.join(e.home, ".fnm", "aliases", "default", "bin", "node"), "fnm", "24.21.0");
    const r = run(e, { CLAUDE_PLUGIN_ROOT: "" }, ["serve"], shim);
    expect(r.out.trim()).toBe(`ran:fnm|${cliOf(e)}|serve`);
  });
});

describe("POSIX hygiene", () => {
  const text = readFileSync(SHIM, "utf8");

  it("is a #!/bin/sh script that parses under sh -n", () => {
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    expect(spawnSync("/bin/sh", ["-n", SHIM]).status).toBe(0);
  });

  it("uses no bashisms ([[, ==, local, function, arrays, $'…', source)", () => {
    const code = text
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    for (const re of [
      /\[\[/,
      / == /,
      /\blocal\s/,
      /^\s*function\s/m,
      /\w+=\(/,
      /\$'/,
      /^\s*source\s/m,
    ]) {
      expect(code, String(re)).not.toMatch(re);
    }
  });

  it("execs the CLI (no lingering shell between the client and the server)", () => {
    expect(text).toMatch(/^exec "\$node" "\$cli" "\$@"$/m);
  });
});
