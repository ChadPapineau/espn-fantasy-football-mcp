// print-config.test.ts — plan 03 L4, §4.1–§4.3 (absolute, quoted paths; the `espn-fantasy-football`
// key; only non-secret env keys that came from the environment; never a cookie, an API key or the
// credential-store keys; a warning under a file-provider or synced directory — ADV OBJ-10).
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeEspnS2, fakeGuid } from "../../scripts/ci/secret-fixtures.mjs";
import { main } from "../../src/cli/main.js";
import {
  MissingBuildError,
  RUNTIME_LOCATION_FIX,
  SERVER_NAME,
  codeCommand,
  desktopSnippet,
  launchEnv,
  launchSpec,
  printConfig,
  runtimeLocationProblems,
  runtimeLocationWarning,
  shellQuote,
} from "../../src/cli/print-config.js";
import { loadLenientRuntime } from "../../src/cli/runtime.js";
import { fakePackage, fakeXattr, makeIo, sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox;
afterEach(() => {
  sb.cleanup();
});

describe("print-config", () => {
  it("desktop: valid JSON, absolute command and dist/cli.js, `serve`, the server key, no secret", async () => {
    sb = sandbox();
    const root = fakePackage(sb);
    const key = "q".repeat(40);
    const io = makeIo(sb, {
      packageRoot: root,
      env: {
        ESPN_LEAGUE_ID: "0",
        ESPN_SEASON: "2026",
        ODDS_API_KEY: key,
        EFF_CREDENTIAL_STORE: "file",
      },
    });
    const { config } = await loadLenientRuntime(io);
    expect(await printConfig(io, config, "desktop")).toBe(0);
    const doc = JSON.parse(io.out.text) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    const e = doc.mcpServers[SERVER_NAME]!;
    expect(path.isAbsolute(e.command)).toBe(true);
    expect(e.args).toEqual([path.join(root, "dist", "cli.js"), "serve"]);
    expect(e.env).toEqual({
      ESPN_LEAGUE_ID: "0",
      ESPN_SEASON: "2026",
      EFF_CONFIG_DIR: sb.configDir,
      EFF_CACHE_DIR: sb.cacheDir,
      EFF_LOG_LEVEL: "info",
    });
    expect(io.out.text).not.toContain(key);
    expect(io.out.text).not.toContain("EFF_CREDENTIAL");
    expect(io.err.text).toContain("claude_desktop_config.json");
  });
  it("code: a shell-quoted `claude mcp add <name> --scope user … -- <node> <dist> serve` line (spaces safe)", async () => {
    sb = sandbox();
    const spaced = path.join(sb.dir, "My Repo's dir");
    mkdirSync(path.join(spaced, "dist"), { recursive: true });
    symlinkSync(path.join(fakePackage(sb), "dist", "cli.js"), path.join(spaced, "dist", "cli.js"));
    const io = makeIo(sb, { packageRoot: spaced, env: {} });
    const { config } = await loadLenientRuntime(io);
    expect(await printConfig(io, config, "code")).toBe(0);
    const line = io.out.text.trim();
    expect(line.startsWith(`claude mcp add ${SERVER_NAME} --scope user --transport stdio`)).toBe(
      true,
    );
    expect(line).toContain(" -- ");
    expect(line).toContain(`'${spaced.replaceAll("'", `'\\''`)}/dist/cli.js' serve`);
    expect(io.err.text).toContain("ESPN_LEAGUE_ID is not set");
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("/plain/path")).toBe("/plain/path");
  });
  it("refuses an unknown client (usage) and an unbuilt checkout (exit 1)", async () => {
    sb = sandbox();
    const io = makeIo(sb, { packageRoot: fakePackage(sb, { built: false }) });
    const { config } = await loadLenientRuntime(io);
    await expect(printConfig(io, config, "vscode")).rejects.toThrow(
      /--client desktop or --client code/,
    );
    await expect(printConfig(io, config, undefined)).rejects.toThrow();
    expect(await printConfig(io, config, "desktop")).toBe(1);
    expect(io.err.text).toContain("npm run build");
    expect(() => launchSpec(io, config)).toThrow(MissingBuildError);
    expect(() => launchSpec({ execPath: "node", packageRoot: "/x" }, config)).toThrow(/absolute/);
  });
  it("warns when the runtime install sits under a file-provider directory or a synced folder", async () => {
    sb = sandbox();
    const root = fakePackage(sb);
    const dist = path.join(root, "dist");
    const io = makeIo(sb, {
      packageRoot: root,
      xattr: fakeXattr({ [dist]: ["com.apple.file-provider-domain-id"] }),
    });
    const { config } = await loadLenientRuntime(io);
    expect(await printConfig(io, config, "desktop")).toBe(0);
    expect(io.err.text).toContain("file-provider (iCloud) or synced directory");
    // a synced folder by name: HOME/Documents → the package's parent
    mkdirSync(path.join(sb.home, "x"), { recursive: true });
    symlinkSync(sb.dir, path.join(sb.home, "Documents"));
    expect(
      runtimeLocationProblems(
        { home: sb.home, xattr: fakeXattr() },
        path.join(dist, "cli.js"),
      ).some((p) => p.includes("synced")),
    ).toBe(true);
    // an xattr reader that fails is reported, never silent
    expect(
      runtimeLocationProblems({ home: sb.home, xattr: () => null }, path.join(dist, "cli.js"))[0],
    ).toMatch(/could not check/);
    expect(runtimeLocationWarning([])).toEqual([]);
  });
  it("the runtime-location fix is the locked release install, never `npm install -g` of the tarball (README, Install from a release)", () => {
    // npm never reads the npm-shrinkwrap.json of a .tgz it installs by path (Stage C finding
    // ci-release-workflow-missing): the fix print-config, install-launchd and doctor give names the
    // lockfile install the release workflow checks
    const warning = runtimeLocationWarning(["x"]).join("\n");
    expect(warning).toContain(RUNTIME_LOCATION_FIX);
    expect(RUNTIME_LOCATION_FIX).toContain("`npm ci --omit=dev --ignore-scripts`");
    expect(RUNTIME_LOCATION_FIX).toContain("Install from a release");
    expect(warning).not.toMatch(/npm install -g|npm i -g|--global/);
  });
  it("launchEnv copies only env-sourced non-secret keys; desktopSnippet and codeCommand agree", async () => {
    sb = sandbox();
    const io = makeIo(sb, {
      env: {
        EFF_TOOLSET: "full",
        ESPN_TEAM_ID: "4",
        EFF_PROBE_LEAGUE_ID: "0",
        EFF_ENABLE_WRITES: "true",
        EFF_TEST_STUBS: "1",
      },
    });
    const { config } = await loadLenientRuntime(io);
    const env = launchEnv(config);
    expect(env).toMatchObject({
      EFF_TOOLSET: "full",
      ESPN_TEAM_ID: "4",
      EFF_PROBE_LEAGUE_ID: "0",
    });
    expect(env).not.toHaveProperty("EFF_ENABLE_WRITES");
    expect(env).not.toHaveProperty("EFF_TEST_STUBS");
    const spec = { command: "/n", args: ["/d/cli.js", "serve"], env: { A: "x y" } };
    const doc = JSON.parse(desktopSnippet(spec)) as {
      mcpServers: Record<string, { env: Record<string, string> }>;
    };
    expect(doc.mcpServers[SERVER_NAME]?.env.A).toBe("x y");
    expect(codeCommand(spec)).toContain("--env 'A=x y'");
  });
});

/** POSIX words of a line quoted by `shellQuote` (bare words and '…' with '\'' escapes). */
function shellWords(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? "";
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      cur += line.slice(i + 1, end);
      i = end;
      inWord = true;
    } else if (c === "\\") {
      cur += line[i + 1] ?? "";
      i++;
      inWord = true;
    } else if (c === " ") {
      if (inWord) out.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (inWord) out.push(cur);
  return out;
}

/**
 * How Claude Code reads `claude mcp add` (commander): `--scope` and `--transport` take one value;
 * `-e, --env <env...>` is VARIADIC — it takes every following word that does not start with `-`;
 * `--` ends the options. Returns the positionals, the env values and the command after `--`.
 */
function parseMcpAdd(words: readonly string[]): {
  positionals: string[];
  env: string[];
  command: string[];
} {
  const positionals: string[] = [];
  const env: string[] = [];
  let i = 3; // after `claude mcp add`
  while (i < words.length) {
    const w = words[i] ?? "";
    if (w === "--") return { positionals, env, command: words.slice(i + 1) };
    if (w === "--env" || w === "-e") {
      i++;
      while (i < words.length && !(words[i] ?? "").startsWith("-")) env.push(words[i++] ?? "");
      continue;
    }
    if (w === "--scope" || w === "--transport" || w === "-s" || w === "-t") {
      i += 2;
      continue;
    }
    positionals.push(w);
    i++;
  }
  return { positionals, env, command: [] };
}

describe("the printed `claude mcp add` is accepted by Claude Code's option parser", () => {
  it("the server name is the positional, every --env value is K=V, the command follows --", () => {
    const spec = {
      command: "/abs/node",
      args: ["/abs/My Repo/dist/cli.js", "serve"],
      env: { ESPN_LEAGUE_ID: "0", ESPN_SEASON: "2026", EFF_LOG_LEVEL: "info" },
    };
    const words = shellWords(codeCommand(spec));
    expect(words.slice(0, 3)).toEqual(["claude", "mcp", "add"]);
    const parsed = parseMcpAdd(words);
    // the variadic --env must not swallow the name (Claude Code then refuses the whole command)
    expect(parsed.positionals).toEqual([SERVER_NAME]);
    expect(parsed.env).toEqual(["ESPN_LEAGUE_ID=0", "ESPN_SEASON=2026", "EFF_LOG_LEVEL=info"]);
    for (const e of parsed.env) expect(e).toMatch(/^[A-Za-z_][A-Za-z0-9_]*=/);
    expect(parsed.command).toEqual(["/abs/node", "/abs/My Repo/dist/cli.js", "serve"]);
    expect(words).toContain("--scope");
    expect(words[words.indexOf("--scope") + 1]).toBe("user");
  });
});

describe("Refix round 11 (D-10): print-config's stderr passes the log redaction before its controls are escaped, as doctor's and uninstall's lines do (VR10-1, D-6, D-8)", () => {
  /** Every terminal-control class D-8 names. */
  const ANY =
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/u;
  const built = (root: string): string => {
    mkdirSync(path.join(root, "dist"), { recursive: true });
    writeFileSync(path.join(root, "dist", "cli.js"), "#!/usr/bin/env node\n");
    return root;
  };
  it("a refusal naming a path, node binary or directory override that holds `espn_s2=…` or `SWID={…}` beside a control, and the missing-build line, print no fake token", async () => {
    sb = sandbox();
    const s2 = fakeEspnS2("d10-vr10-1", 120);
    const guid = fakeGuid("d10-vr10-1");
    const clean = built(path.join(sb.dir, "clean"));
    // a bidi control in each directory override: the config loader refuses a C0 one first (exit 2)
    const cfg = path.join(sb.dir, `cfg-espn_s2=${s2}\u202e`);
    const cache = path.join(sb.dir, `cache-SWID={${guid}}\u2066`);
    mkdirSync(cfg, { recursive: true, mode: 0o700 });
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    const cases: [string, Partial<Parameters<typeof makeIo>[1]>, string][] = [
      [
        "packageRoot",
        { packageRoot: built(path.join(sb.dir, `espn_s2=${s2}\u001b[0m`)) },
        "the argument (",
      ],
      [
        "execPath",
        { packageRoot: clean, execPath: `/opt/espn_s2=${s2}\u009b/node` },
        "the node binary (",
      ],
      [
        "execPath (SWID)",
        { packageRoot: clean, execPath: `/opt/SWID={${guid}}\u001b/node` },
        "the node binary (",
      ],
      [
        "EFF_CONFIG_DIR",
        { packageRoot: clean, env: { ESPN_LEAGUE_ID: "0", EFF_CONFIG_DIR: cfg } },
        "EFF_CONFIG_DIR (",
      ],
      [
        "EFF_CACHE_DIR",
        { packageRoot: clean, env: { ESPN_LEAGUE_ID: "0", EFF_CACHE_DIR: cache } },
        "EFF_CACHE_DIR (",
      ],
    ];
    for (const client of ["code", "desktop"] as const)
      for (const [what, over, names] of cases) {
        const label = `${client} ${what}`;
        const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" }, ...over });
        expect(await main(["print-config", "--client", client], io), label).toBe(1);
        expect(io.out.text, label).toBe("");
        // it was: the word printed whole, only its control escaped — the fake espn_s2 or GUID raw
        expect(io.err.text, label).not.toContain(s2);
        expect(io.err.text.toUpperCase(), label).not.toContain(guid);
        // the refusal still names the word that holds the control
        expect(io.err.text, label).toContain(names);
        expect(io.err.text, label).toContain("no snippet is printed");
        for (const l of io.err.text.split("\n")) expect(l, label).not.toMatch(ANY);
      }
    // no build under a path holding a brace GUID: the missing-build line (`expected …/dist/cli.js`)
    const unbuilt = path.join(sb.dir, `SWID={${guid}}`);
    mkdirSync(unbuilt, { recursive: true });
    for (const client of ["code", "desktop"] as const) {
      const io = makeIo(sb, { packageRoot: unbuilt, env: { ESPN_LEAGUE_ID: "0" } });
      expect(await main(["print-config", "--client", client], io), client).toBe(1);
      expect(io.err.text, client).toContain("npm run build");
      expect(io.err.text, client).toContain("(expected ");
      // it was: "(expected <SB>/SWID={<the GUID>}/dist/cli.js)"
      expect(io.err.text.toUpperCase(), client).not.toContain(guid);
    }
    // the stdout snippet stays exact: a path with no control is printed as it runs
    const exact = built(path.join(sb.dir, "exact root"));
    const ok = makeIo(sb, { packageRoot: exact, env: { ESPN_LEAGUE_ID: "0" } });
    expect(await main(["print-config", "--client", "code"], ok)).toBe(0);
    expect(ok.out.text).toContain(`'${path.join(exact, "dist", "cli.js")}' serve`);
  });
});
