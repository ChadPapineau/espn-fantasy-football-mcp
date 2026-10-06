// print-config.test.ts — plan 03 L4, §4.1–§4.3 (absolute, quoted paths; the `espn-fantasy-football`
// key; only non-secret env keys that came from the environment; never a cookie, an API key or the
// credential-store keys; a warning under a file-provider or synced directory — ADV OBJ-10).
import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MissingBuildError,
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
  it("code: a shell-quoted `claude mcp add --scope user … -- <node> <dist> serve` line (spaces safe)", async () => {
    sb = sandbox();
    const spaced = path.join(sb.dir, "My Repo's dir");
    mkdirSync(path.join(spaced, "dist"), { recursive: true });
    symlinkSync(path.join(fakePackage(sb), "dist", "cli.js"), path.join(spaced, "dist", "cli.js"));
    const io = makeIo(sb, { packageRoot: spaced, env: {} });
    const { config } = await loadLenientRuntime(io);
    expect(await printConfig(io, config, "code")).toBe(0);
    const line = io.out.text.trim();
    expect(line.startsWith("claude mcp add --scope user --transport stdio")).toBe(true);
    expect(line).toContain(`${SERVER_NAME} -- `);
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
