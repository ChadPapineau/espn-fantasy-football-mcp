// plugin-launch.test.ts — the plugin's server started exactly as Claude Code starts it from .mcp.json
// (plan 09 §4, §6; plan 10 B10; Stage C finding plugin-toolset-full-unreachable): `/bin/sh` and the
// launch shim with `${CLAUDE_PLUGIN_ROOT}` = this checkout, and the env with every
// `${user_config.KEY}` resolved from plugin.json as Claude Code resolves it (tests/plugin/
// helpers.ts). The plugin's toolset option set to full registers all 34 read tools and reports
// `server.toolset: full` — what the five P1 Skills read in Step 0 — and left empty the server takes
// config.json's EFF_TOOLSET, else core. Fixture mode on fx-10h with a private temp HOME (so the
// default config and cache directories, the ones a plugin install uses, are inside it), the
// no-socket preload (through NODE_OPTIONS: the shim execs node) and EFF_TEST_STUBS=1 — no network,
// no keychain, no ~/.config or ~/.cache. The shim gets EFF_NODE, its documented override, so it
// runs the node running this suite.
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envelopeOf, rpcOver } from "../../scripts/skills/build-plugin-evals.mjs";
import { resolveServer } from "../plugin/helpers.js";
import { FX, NO_SOCKET, ROOT, requireDist } from "./helpers.js";

type Json = Record<string, unknown>;
const expectedTools = JSON.parse(
  readFileSync(path.join(ROOT, "tests", "smoke", "expected-tools.json"), "utf8"),
) as { core: string[]; full: string[] };
/** The fixture-mode-only tool every fixture server adds (never listed in expected-tools.json). */
const FIXTURE_ONLY = "espn_debug_echo";

let base: string;
beforeEach(() => {
  requireDist();
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "eff-plugin-launch-")));
  chmodSync(base, 0o700);
  for (const d of ["home", "data", "cwd"]) mkdirSync(path.join(base, d), { mode: 0o700 });
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** config.json in the default config directory a plugin-launched server reads (plan 09 §4). */
function writeConfigJson(values: Json): void {
  const dir = path.join(base, "home", ".config", "espn-fantasy-football-mcp");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(path.join(dir, "config.json"), `${JSON.stringify(values)}\n`, { mode: 0o600 });
}

/** One server started as the plugin's .mcp.json says, for a user who saved `saved`. */
async function startPluginServer(saved: Record<string, string>) {
  const s = resolveServer(saved, { dataDir: path.join(base, "data") });
  const child = spawn(s.command, [...s.args], {
    cwd: path.join(base, "cwd"),
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: path.join(base, "home"),
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      EFF_NODE: process.execPath,
      NODE_OPTIONS: `--import "${NO_SOCKET}"`,
      EFF_FIXTURE_DIR: FX,
      EFF_TEST_STUBS: "1",
      ...s.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (b: Buffer) => {
    stderr += b.toString("utf8");
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => {
      resolve(code);
    });
  });
  const rpc = rpcOver(child, 60_000);
  await rpc.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "plugin-launch-test", version: "1" },
  });
  rpc.notify("notifications/initialized", {});
  return {
    tools: async () =>
      ((await rpc.request("tools/list", {})) as { tools: { name: string }[] }).tools.map(
        (t) => t.name,
      ),
    toolset: async () => {
      const env = envelopeOf(
        await rpc.request(
          "tools/call",
          { name: "espn_get_status", arguments: {} },
          "espn_get_status",
        ),
        "espn_get_status",
      );
      return ((env.data as Json).server as Json).toolset;
    },
    close: async () => {
      child.stdin.end();
      return { code: await exited, stderr };
    },
  };
}

describe("the plugin's server as Claude Code starts it", () => {
  // a season recorded in config.json keeps the fixture league's season whatever today's date is
  // (the season option itself is left empty in every case — tests/plugin/plugin-config.test.ts)
  beforeEach(() => {
    writeConfigJson({ ESPN_SEASON: "2026" });
  });

  it("the toolset option set to full: all 34 read tools, server.toolset full", async () => {
    const run = await startPluginServer({ league_id: "0", toolset: "full" });
    expect(await run.tools()).toEqual([...expectedTools.full, FIXTURE_ONLY]);
    expect(await run.toolset()).toBe("full");
    const end = await run.close();
    expect(end.code).toBe(0);
    expect(end.stderr).not.toContain("unknown environment variable");
  }, 120_000);

  it("the toolset option left empty: config.json's EFF_TOOLSET, else core's 18", async () => {
    writeConfigJson({ ESPN_SEASON: "2026", EFF_TOOLSET: "full" });
    const fromFile = await startPluginServer({ league_id: "0" });
    expect(await fromFile.tools()).toEqual([...expectedTools.full, FIXTURE_ONLY]);
    expect((await fromFile.close()).code).toBe(0);

    writeConfigJson({ ESPN_SEASON: "2026" });
    const plain = await startPluginServer({ league_id: "0" });
    expect(await plain.tools()).toEqual([...expectedTools.core, FIXTURE_ONLY]);
    expect(await plain.toolset()).toBe("core");
    expect((await plain.close()).code).toBe(0);
  }, 120_000);
});
