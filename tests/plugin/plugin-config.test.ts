// plugin-config.test.ts — the plugin's userConfig and .mcp.json as Claude Code resolves them, read by
// the server's own config loader (plan 09 §4, §6; plan 03 §3; plan 06 §2 "one configuration"; Stage
// C findings plugin-season-default-pinned and plugin-toolset-full-unreachable). An option the user
// leaves empty reaches the server empty, which the server reads as unset: the plugin's server reads
// the same season as the eff CLI and the launchd jobs in every later year too, and a plugin user can
// set the toolset the five P1 Skills stop on (`EFF_TOOLSET=full`) through the plugin's own option.
// How Claude Code substitutes the options: tests/plugin/helpers.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jobEnv } from "../../src/cli/launchd.js";
import {
  ConfigError,
  defaultSeason,
  loadConfig,
  type Config,
  type ConfigInput,
} from "../../src/config/schema.js";
import { toolNames } from "../../src/mcp/registry.js";
import { noXattrs, tempDir } from "../config/helpers.js";
import { ROOT, readPlugin, resolveServer } from "./helpers.js";

let tmp: { dir: string; cleanup: () => void };
beforeEach(() => {
  tmp = tempDir("eff-plugin-config-");
});
afterEach(() => {
  tmp.cleanup();
});

/** The fixture league id (CLAUDE.md: placeholders only). */
const LEAGUE = "0";
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");
const expectedTools = JSON.parse(read("tests/smoke/expected-tools.json")) as {
  core: string[];
  full: string[];
};

/** The configuration a process with environment `env` (and `file` as config.json) resolves. */
function configOf(env: Record<string, string>, nowMs: number, file?: unknown): Config {
  const input: ConfigInput = { env, file, home: tmp.dir, repoRoot: ROOT, nowMs, xattr: noXattrs };
  return loadConfig(input);
}

/** The plugin server's configuration for a user who saved `saved` in the plugin's options. */
function pluginServer(saved: Record<string, string>, nowMs: number, file?: unknown): Config {
  return configOf({ ...resolveServer(saved).env }, nowMs, file);
}

/**
 * The eff CLI's configuration in a shell that exported only the league id (README Quickstart step
 * 2), and the launchd jobs' — their plists carry exactly what `eff install-launchd` copied from that
 * shell (src/cli/launchd.ts jobEnv).
 */
function cliAndJobs(nowMs: number, file?: unknown): { cli: Config; jobs: Config } {
  const cli = configOf({ ESPN_LEAGUE_ID: LEAGUE }, nowMs, file);
  return { cli, jobs: configOf(jobEnv(cli), nowMs, file) };
}

describe("season: a plugin option left empty follows the season the eff CLI and the jobs read", () => {
  it.each([
    ["in the 2026 season", "2026-10-17T12:00:00Z"],
    ["before July 2027, still the 2026 season", "2027-03-01T12:00:00Z"],
    ["once the 2027 season starts", "2027-09-15T12:00:00Z"],
    ["years later", "2031-08-01T00:00:00Z"],
  ])("%s", (_label, at) => {
    const now = Date.parse(at);
    const plugin = pluginServer({ league_id: LEAGUE }, now);
    const { cli, jobs } = cliAndJobs(now);
    expect(plugin.season).toBe(defaultSeason(now));
    expect(plugin.origins.ESPN_SEASON).toBe("default");
    expect([cli.season, jobs.season]).toEqual([plugin.season, plugin.season]);
  });

  it("a season recorded in config.json is read by the plugin's server like every other process", () => {
    const now = Date.parse("2027-09-15T12:00:00Z");
    const file = { ESPN_SEASON: "2026" };
    const plugin = pluginServer({ league_id: LEAGUE }, now, file);
    const { cli, jobs } = cliAndJobs(now, file);
    expect([plugin.season, cli.season, jobs.season]).toEqual([2026, 2026, 2026]);
    expect(plugin.origins.ESPN_SEASON).toBe("file");
  });

  it("a year the user types pins the plugin's server — a deliberate choice, passed through", () => {
    const now = Date.parse("2027-09-15T12:00:00Z");
    const plugin = pluginServer({ league_id: LEAGUE, season: "2025" }, now);
    expect(plugin.season).toBe(2025);
    expect(plugin.origins.ESPN_SEASON).toBe("env");
  });

  it("the manifest's season option is optional and its default is empty", () => {
    const season = readPlugin().manifest.userConfig?.season;
    expect(season).toBeDefined();
    expect(season?.required).not.toBe(true);
    expect(season?.default ?? "").toBe("");
  });
});

describe("toolset: EFF_TOOLSET=full is reachable through the plugin's own option", () => {
  const now = Date.parse("2026-10-17T12:00:00Z");

  it("the option set to full registers all 34 read tools", () => {
    const plugin = pluginServer({ league_id: LEAGUE, toolset: "full" }, now);
    expect(plugin.toolset).toBe("full");
    expect(plugin.origins.EFF_TOOLSET).toBe("env");
    expect(toolNames(plugin.toolset)).toEqual(expectedTools.full);
    expect(expectedTools.full).toHaveLength(34);
  });

  it("the option set to core registers the 18 P0 tools", () => {
    const plugin = pluginServer({ league_id: LEAGUE, toolset: "core" }, now);
    expect(plugin.toolset).toBe("core");
    expect(toolNames(plugin.toolset)).toEqual(expectedTools.core);
    expect(expectedTools.core).toHaveLength(18);
  });

  it("left empty, the server takes config.json's EFF_TOOLSET, else core", () => {
    const fromFile = pluginServer({ league_id: LEAGUE }, now, { EFF_TOOLSET: "full" });
    expect([fromFile.toolset, fromFile.origins.EFF_TOOLSET]).toEqual(["full", "file"]);
    const plain = pluginServer({ league_id: LEAGUE }, now);
    expect([plain.toolset, plain.origins.EFF_TOOLSET]).toEqual(["core", "default"]);
  });

  it("any other value stops the server with a coded EFF_TOOLSET issue — never a silent core", () => {
    for (const bad of ["Full", "FULL", "all", "core,full", "1"]) {
      let issues: { key: string; reason: string }[] = [];
      try {
        pluginServer({ league_id: LEAGUE, toolset: bad }, now);
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        issues = [...e.issues];
      }
      expect(
        issues.map((i) => i.key),
        bad,
      ).toEqual(["EFF_TOOLSET"]);
    }
  });

  it("the option is named by the setting the P1 Skills' Step 0 stop text tells the user to set", () => {
    const stop = read("skills/_shared/references/orient.md");
    expect(stop).toContain("set `EFF_TOOLSET=full` in the server's env and restart the client");
    const toolset = readPlugin().manifest.userConfig?.toolset;
    expect(toolset?.title).toContain("EFF_TOOLSET");
    expect(toolset?.description).toMatch(/\bfull\b/);
    expect(toolset?.description).toMatch(/\bcore\b/);
    expect(toolset?.required).not.toBe(true);
    expect(toolset?.sensitive).not.toBe(true);
    expect(toolset?.default ?? "").toBe("");
  });
});

describe("every option reaches the server, and an empty plugin leaves it to the shared config", () => {
  it("each declared option is referenced by exactly one env key of the server (no dead option)", () => {
    const { manifest, server } = readPlugin();
    const refs = Object.values(server.env ?? {});
    for (const key of Object.keys(manifest.userConfig ?? {}))
      expect(refs.filter((v) => v === `\${user_config.${key}}`)).toHaveLength(1);
  });

  it("a user who saved nothing still gets a server that starts on config.json alone", () => {
    const now = Date.parse("2027-09-15T12:00:00Z");
    const env = { ...resolveServer({}).env };
    const c = configOf(env, now, { ESPN_LEAGUE_ID: LEAGUE, EFF_TOOLSET: "full" });
    expect([c.leagueId, c.season, c.toolset]).toEqual([LEAGUE, 2027, "full"]);
    expect([c.origins.ESPN_LEAGUE_ID, c.origins.ESPN_SEASON]).toEqual(["file", "default"]);
  });
});
