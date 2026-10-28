// client-registrations.test.ts — every place a Claude client registers this server, as doctor rows
// #2/#3/#24, `eff print-config` and `eff uninstall` read them (plan 03 §4.1–§4.3, §5 #2/#3/#24, §8
// step 5; plan 02 §1: the client configuration is never a cookie location). Stage C findings:
//  - doctor-plugin-install-invisible: doctor never saw the Claude Code plugin (the README's route),
//    told a plugin user no client launches the server, steered him to `--client code` — the
//    duplicate registration the README forbids — and checked the clone's dist/, never the plugin copy
//    Claude Code runs;
//  - doctor-project-scope-mcp-json-unscanned: a cookie in a project-scope `.mcp.json` (a file meant
//    to be committed) passed row 3 as "skip";
//  - uninstall-local-scope-registration-unnamed: uninstall printed only `claude mcp remove --scope
//    user`, which never touches a local-scope entry (`claude mcp add`'s default), its env cookie kept;
//  - the final gate, round 2: a Claude Code session opened in a clone of this repository read the
//    plugin's own `.mcp.json` as a project server, which ended CONNECTION_CLOSED (`${CLAUDE_PLUGIN_ROOT}`
//    and `${user_config.*}` expand only in a plugin install). Row 2 called that file "entry ok" — one
//    registration with absolute, existing paths — or, beside the enabled plugin, a second
//    registration, and uninstall told the user to `claude mcp remove --scope project` it, which
//    deletes the plugin's server from that copy. An entry carrying a plugin variable in any client
//    config, and a `/bin/sh` entry without an absolute shim path, passed row 2 the same way.
// Every file lives in a sandbox HOME; values are generated placeholders; nothing is executed.
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeEspnS2 } from "../../scripts/ci/secret-fixtures.mjs";
import {
  cookieFindings,
  isPluginRoot,
  pluginVariables,
  removeCommand,
  scanClientConfig,
  scanPlugin,
  whereOf,
} from "../../src/cli/client-config.js";
import {
  checkClientSecrecy,
  checkLaunchConfig,
  checkStaleBuild,
  entryProblems,
} from "../../src/cli/doctor.js";
import { main } from "../../src/cli/main.js";
import { findRegistrations, manualSteps } from "../../src/cli/uninstall.js";
import { fakeExec, fakePackage, makeIo, ROOT, sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox;
afterEach(() => {
  sb.cleanup();
});

const PLUGIN_ID = "espn-fantasy-football@espn-fantasy-football-mcp";
const S2 = fakeEspnS2("cli-client-registrations", 216);
const SWID = "{00000000-0000-4000-8000-000000000001}";

const write = (file: string, v: unknown): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof v === "string" ? v : JSON.stringify(v));
};

/** A plugin copy as Claude Code's cache holds it: built (dist/cli.js) and with its shim. */
function pluginCopy(home: string, built = true): string {
  const copy = path.join(
    home,
    ".claude",
    "plugins",
    "cache",
    "espn-fantasy-football-mcp",
    "espn-fantasy-football",
    "0.0.0",
  );
  mkdirSync(path.join(copy, "scripts"), { recursive: true });
  writeFileSync(path.join(copy, "scripts", "eff-launch.sh"), "#!/bin/sh\n");
  if (built) {
    mkdirSync(path.join(copy, "dist"), { recursive: true });
    writeFileSync(path.join(copy, "dist", "cli.js"), "x");
  }
  return copy;
}

/** The plugin installed (installed_plugins.json) and, when `enabled`, enabled in the settings. */
function installPlugin(home: string, copy: string, enabled = true): void {
  write(path.join(home, ".claude", "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: {
      [PLUGIN_ID]: [{ scope: "user", installPath: copy, version: "0.0.0", installedAt: "x" }],
      "other@market": [{ scope: "user", installPath: "/elsewhere" }],
    },
  });
  write(path.join(home, ".claude", "settings.json"), {
    enabledPlugins: { [PLUGIN_ID]: enabled, "other@market": true },
  });
}

/** The shim's `version --json` (doctor runs it through the injected exec). */
const shimOk = fakeExec(() => ({
  stdout: '{"node":"24.21.0","exec_path":"/n/bin/node"}\n',
})).exec;

describe("the Claude Code plugin is a registration (doctor #2, #24; print-config)", () => {
  it("scanPlugin: installed + enabled, installed + disabled, not installed, malformed files", () => {
    sb = sandbox();
    expect(scanPlugin(sb.home)).toBeNull();
    const copy = pluginCopy(sb.home);
    installPlugin(sb.home, copy);
    expect(scanPlugin(sb.home)).toEqual({
      enabled: true,
      copies: [{ scope: "user", installPath: copy, version: "0.0.0" }],
    });
    installPlugin(sb.home, copy, false);
    expect(scanPlugin(sb.home)?.enabled).toBe(false);
    write(path.join(sb.home, ".claude", "settings.json"), "{");
    expect(scanPlugin(sb.home)?.enabled).toBe(false);
    write(path.join(sb.home, ".claude", "plugins", "installed_plugins.json"), {
      plugins: { [PLUGIN_ID]: [{ installPath: "relative/path" }] },
    });
    expect(scanPlugin(sb.home)).toBeNull();
    write(path.join(sb.home, ".claude", "plugins", "installed_plugins.json"), "not json");
    expect(scanPlugin(sb.home)).toBeNull();
  });

  it("row 2: a plugin user is never told no client launches the server, nor pointed at --client code", async () => {
    sb = sandbox();
    const copy = pluginCopy(sb.home);
    installPlugin(sb.home, copy);
    const io = makeIo(sb, { exec: shimOk });
    const scans = [
      scanClientConfig("desktop", path.join(sb.home, "none.json")),
      scanClientConfig("code", path.join(sb.home, ".claude.json")),
    ];
    const r = await checkLaunchConfig(io, scans, scanPlugin(sb.home));
    expect(r.status).toBe("ok");
    expect(r.message).not.toContain("no client is configured");
    expect(r.details.join("\n")).toContain(
      `code: the plugin registers the server (user scope, version 0.0.0, ${copy})`,
    );
    // the shim checked is the plugin copy's, which Claude Code runs
    expect(r.details.join("\n")).toContain(`plugin copy's shim (${copy}) would run node 24.21.0`);
    // no registration anywhere: the fix names the plugin for Claude Code, --client desktop for Desktop
    const none = await checkLaunchConfig(io, scans, null);
    expect(none.status).toBe("warn");
    expect(none.fix).not.toContain("--client code");
    expect(none.fix).toContain("the plugin");
  });

  it("row 2: a plugin copy without a build fails; the plugin beside a `claude mcp add` entry is the duplicate warning", async () => {
    sb = sandbox();
    const copy = pluginCopy(sb.home, false);
    installPlugin(sb.home, copy);
    const io = makeIo(sb, { exec: shimOk });
    const code = path.join(sb.home, ".claude.json");
    const r = await checkLaunchConfig(io, [scanClientConfig("code", code)], scanPlugin(sb.home));
    expect(r.status).toBe("fail");
    expect(r.details.join("\n")).toContain("has no dist/cli.js");
    // a built copy and a user-scope entry of ours: two registrations
    pluginCopy(sb.home, true);
    write(code, {
      mcpServers: {
        "espn-fantasy-football": {
          command: process.execPath,
          args: [path.join(copy, "dist", "cli.js"), "serve"],
        },
      },
    });
    const dup = await checkLaunchConfig(io, [scanClientConfig("code", code)], scanPlugin(sb.home));
    expect(dup.status).toBe("warn");
    expect(dup.message).toContain("registers this server twice");
    // a disabled plugin is said, never counted
    installPlugin(sb.home, copy, false);
    const off = await checkLaunchConfig(io, [], scanPlugin(sb.home));
    expect(off.status).toBe("warn");
    expect(off.details.join("\n")).toContain("installed (");
    expect(off.details.join("\n")).toContain("but disabled");
  });

  it("row 24: the plugin copy built before the clone's build or sources fails, a current copy passes", () => {
    sb = sandbox();
    const repo = path.join(sb.dir, "repo");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    mkdirSync(path.join(repo, "src"), { recursive: true });
    mkdirSync(path.join(repo, "dist"), { recursive: true });
    writeFileSync(path.join(repo, "src", "a.ts"), "x");
    writeFileSync(path.join(repo, "dist", "cli.js"), "x");
    writeFileSync(path.join(repo, "package.json"), "{}");
    const copy = pluginCopy(sb.home);
    installPlugin(sb.home, copy);
    const at = (f: string, iso: string): void => {
      const d = new Date(iso);
      utimesSync(f, d, d);
    };
    at(path.join(repo, "src", "a.ts"), "2026-10-01T00:00:00Z");
    at(path.join(repo, "dist", "cli.js"), "2026-10-05T00:00:00Z");
    at(path.join(repo, "package.json"), "2026-10-01T00:00:00Z");
    at(path.join(copy, "dist", "cli.js"), "2026-10-03T00:00:00Z");
    const stale = checkStaleBuild(repo, scanPlugin(sb.home));
    expect(stale.status).toBe("fail");
    expect(stale.message).toContain("plugin copy is older than this clone");
    expect(stale.fix).toContain(
      "claude plugin uninstall espn-fantasy-football@espn-fantasy-football-mcp",
    );
    // the clone's own check still says ok for the clone alone (what doctor printed before)
    expect(checkStaleBuild(repo).status).toBe("ok");
    at(path.join(copy, "dist", "cli.js"), "2026-10-06T00:00:00Z");
    expect(checkStaleBuild(repo, scanPlugin(sb.home)).status).toBe("ok");
    // an installed package (no checkout): a built plugin copy passes, an unbuilt one fails
    expect(checkStaleBuild(sb.dir, scanPlugin(sb.home)).status).toBe("ok");
    expect(checkStaleBuild(sb.dir, null).status).toBe("na");
  });

  it("eff doctor end to end (a plugin user): row 2 ok; print-config --client code warns of the duplicate", async () => {
    sb = sandbox({ create: true });
    const copy = pluginCopy(sb.home);
    installPlugin(sb.home, copy);
    write(path.join(sb.home, ".claude.json"), { numStartups: 1 });
    const io = makeIo(sb, {
      exec: shimOk,
      env: { ESPN_LEAGUE_ID: "0", EFF_CREDENTIAL_STORE: "file" },
    });
    await main(["doctor", "--json"], io);
    const doc = JSON.parse(io.out.text) as {
      rows: { n: number; status: string; message: string }[];
    };
    const row2 = doc.rows.find((r) => r.n === 2);
    expect(row2?.status).toBe("ok");
    expect(row2?.message).not.toContain("no client is configured");
    const pc = makeIo(sb, { packageRoot: fakePackage(sb), env: { ESPN_LEAGUE_ID: "0" } });
    expect(await main(["print-config", "--client", "code"], pc)).toBe(0);
    expect(pc.err.text).toContain(`the ${PLUGIN_ID} plugin is installed and enabled`);
    expect(pc.err.text).toContain("lists every tool twice");
    // Claude Desktop ignores a plugin's server: its snippet carries no such warning
    const pd = makeIo(sb, { packageRoot: fakePackage(sb), env: { ESPN_LEAGUE_ID: "0" } });
    expect(await main(["print-config", "--client", "desktop"], pd)).toBe(0);
    expect(pd.err.text).not.toContain("installed and enabled");
  });
});

describe("project scope (<dir>/.mcp.json) is read like the user and local scopes (doctor #2, #3)", () => {
  it("a cookie in a project .mcp.json fails row 3 (exit 2), never echoed; the entry counts for row 2", async () => {
    sb = sandbox();
    const proj = path.join(sb.home, "proj");
    write(path.join(sb.home, ".claude.json"), { projects: { [proj]: { allowedTools: [] } } });
    write(path.join(proj, ".mcp.json"), {
      mcpServers: {
        "espn-fantasy-football": {
          command: "/bin/sh",
          args: ["x/scripts/eff-launch.sh", "serve"],
          env: { espn_s2: S2, SWID },
        },
      },
    });
    const scan = scanClientConfig("code", path.join(sb.home, ".claude.json"));
    expect(scan.entries).toEqual([
      expect.objectContaining({ scope: "project", dir: proj, file: path.join(proj, ".mcp.json") }),
    ]);
    const r = checkClientSecrecy([scan]);
    expect(r.status).toBe("config");
    expect(r.details.join("\n")).toContain(`code (project scope, ${path.join(proj, ".mcp.json")})`);
    expect(JSON.stringify(r)).not.toContain(S2.slice(0, 16));
    expect(JSON.stringify(r)).not.toContain(SWID);
    // the same value in the user scope is found the same way (the control)
    write(path.join(sb.home, ".claude.json"), {
      mcpServers: { x: { command: "/x", env: { PASTED: S2 } } },
    });
    expect(
      checkClientSecrecy([scanClientConfig("code", path.join(sb.home, ".claude.json"))]).status,
    ).toBe("config");
    // a project .mcp.json that is not JSON is said by row 2
    write(path.join(sb.home, ".claude.json"), { projects: { [proj]: {} } });
    write(path.join(proj, ".mcp.json"), "{");
    const bad = scanClientConfig("code", path.join(sb.home, ".claude.json"));
    expect(bad.projectFiles).toEqual([{ file: path.join(proj, ".mcp.json"), state: "invalid" }]);
    expect(
      (await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [bad])).details.join("\n"),
    ).toContain(".mcp.json could not be read as JSON");
  });

  it("eff doctor end to end: row 3 CONF for the project-scope cookie (exit 2)", async () => {
    sb = sandbox({ create: true });
    const proj = path.join(sb.home, "proj");
    write(path.join(sb.home, ".claude.json"), { projects: { [proj]: { allowedTools: [] } } });
    write(path.join(proj, ".mcp.json"), {
      mcpServers: {
        "espn-fantasy-football": {
          command: "/bin/sh",
          args: ["s/scripts/eff-launch.sh", "serve"],
          env: { espn_s2: S2 },
        },
      },
    });
    const io = makeIo(sb, {
      exec: shimOk,
      env: { ESPN_LEAGUE_ID: "0", EFF_CREDENTIAL_STORE: "file" },
    });
    const code = await main(["doctor", "--json"], io);
    const doc = JSON.parse(io.out.text) as { rows: { n: number; status: string }[] };
    expect(doc.rows.find((r) => r.n === 3)?.status).toBe("config");
    // a configuration finding (2) — or worse: no credential is stored in this sandbox (3)
    expect(code).toBeGreaterThanOrEqual(2);
    expect(io.out.text).not.toContain(S2.slice(0, 16));
  });
});

describe("uninstall names every registration it can see (the local scope, `claude mcp add`'s default)", () => {
  it("local and project scope entries get their `claude mcp remove` from their directory; a key of another name is named; an env cookie is said", async () => {
    sb = sandbox({ create: true });
    const local = path.join(sb.home, "some-project");
    const proj = path.join(sb.home, "repo");
    write(path.join(sb.home, ".claude.json"), {
      mcpServers: { "espn-ff": { command: "/n", args: ["/c/dist/cli.js", "serve"] } },
      projects: {
        [local]: {
          mcpServers: {
            "espn-fantasy-football": {
              command: "/n",
              args: ["/c/dist/cli.js", "serve"],
              env: { ESPN_LEAGUE_ID: "0", ESPN_S2: "placeholder-not-a-cookie", SWID },
            },
          },
        },
        [proj]: {},
      },
    });
    write(path.join(proj, ".mcp.json"), {
      mcpServers: {
        "espn-fantasy-football": { command: "/bin/sh", args: ["r/scripts/eff-launch.sh", "serve"] },
      },
    });
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } });
    expect(await main(["uninstall", "--yes"], io)).toBe(0);
    const t = io.out.text;
    expect(t).toContain(`cd ${local} && claude mcp remove --scope local espn-fantasy-football`);
    expect(t).toContain(`cd ${proj} && claude mcp remove --scope project espn-fantasy-football`);
    expect(t).toContain(`${path.join(proj, ".mcp.json")} — a file meant to be committed`);
    expect(t).toContain(
      'registers this server under the key "espn-ff": claude mcp remove --scope user espn-ff',
    );
    expect(t).toContain("its env block holds an ESPN cookie");
    expect(t).not.toContain("placeholder-not-a-cookie");
    // found entries replace the generic user-scope line
    expect(t).not.toContain(
      "claude mcp remove --scope user espn-fantasy-football (entries live in",
    );
  });

  it("nothing found: the generic steps stand; a Desktop entry found is named with its file", () => {
    sb = sandbox();
    const generic = manualSteps(sb.home).join("\n");
    expect(generic).toContain(
      "claude mcp remove --scope user espn-fantasy-football (entries live in",
    );
    expect(generic).toContain("--scope local");
    const desk = path.join(sb.dir, "desktop.json");
    write(desk, {
      mcpServers: {
        "espn-fantasy-football": {
          command: "/n",
          args: ["/c/dist/cli.js", "serve"],
          env: { X: S2 },
        },
      },
    });
    const steps = manualSteps(sb.home, [], {
      scans: [scanClientConfig("desktop", desk)],
      plugin: null,
    }).join("\n");
    expect(steps).toContain(
      `Remove the "espn-fantasy-football" entry from ${desk} (Claude Desktop)`,
    );
    expect(steps).toContain("its env block holds an ESPN cookie");
    expect(steps).not.toContain(S2.slice(0, 16));
  });

  it("helpers: the scope labels, the remove commands (quoted), the cookie findings", () => {
    expect(whereOf("user", null)).toBe("code (user scope)");
    expect(whereOf("local", "/p")).toBe("code (local scope, /p)");
    expect(whereOf("project", "/p")).toBe("code (project scope, /p/.mcp.json)");
    expect(whereOf("desktop", null)).toBe("desktop");
    expect(removeCommand({ scope: "user", dir: null, name: "espn-fantasy-football" })).toBe(
      "claude mcp remove --scope user espn-fantasy-football",
    );
    expect(removeCommand({ scope: "local", dir: "/a b/c", name: "x" })).toBe(
      "cd '/a b/c' && claude mcp remove --scope local x",
    );
    expect(removeCommand({ scope: "project", dir: "/r", name: "it's" })).toBe(
      "cd /r && claude mcp remove --scope project 'it'\\''s'",
    );
    expect(cookieFindings({ espn_s2: "x" })).toEqual(["key"]);
    expect(cookieFindings({ A: S2 })).toEqual(["value"]);
    expect(cookieFindings({ ESPN_LEAGUE_ID: "1" })).toEqual([]);
  });
});

describe("the plugin's own .mcp.json in a copy of this plugin is not a registration (final gate, round 2)", () => {
  /** This repository's plugin manifest and `.mcp.json`, exactly as committed. */
  const MANIFEST = readFileSync(path.join(ROOT, ".claude-plugin", "plugin.json"), "utf8");
  const PLUGIN_MCP = JSON.parse(readFileSync(path.join(ROOT, ".mcp.json"), "utf8")) as {
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  };
  const OWN = PLUGIN_MCP.mcpServers["espn-fantasy-football"];
  if (OWN === undefined)
    throw new Error("the committed .mcp.json declares no espn-fantasy-football");

  /** A clone of this repository at `dir`: the plugin manifest and the plugin's `.mcp.json`. */
  function pluginClone(dir: string, mcp: unknown = PLUGIN_MCP): void {
    write(path.join(dir, ".claude-plugin", "plugin.json"), MANIFEST);
    write(path.join(dir, ".mcp.json"), mcp);
  }
  /** A home whose ~/.claude.json knows `dirs` as projects (Claude Code was opened in each). */
  const knownProjects = (home: string, ...dirs: string[]): void => {
    write(path.join(home, ".claude.json"), {
      projects: Object.fromEntries(dirs.map((d) => [d, { allowedTools: [] }])),
    });
  };

  it("row 2: a clone's .mcp.json is no registration that is ok, nor a second one beside the plugin", async () => {
    sb = sandbox();
    const clone = path.join(sb.home, "Developer", "espn-fantasy-football-mcp");
    pluginClone(clone);
    knownProjects(sb.home, clone);
    const scan = scanClientConfig("code", path.join(sb.home, ".claude.json"));
    // still read — row 3 checks its env like every other file — and marked the plugin's own
    expect(scan.entries).toEqual([
      expect.objectContaining({ scope: "project", dir: clone, pluginSource: true }),
    ]);
    const io = makeIo(sb, { exec: shimOk });
    const alone = await checkLaunchConfig(io, [scan], null);
    // it was "ok: 1 client registration with absolute, existing paths", though no client can start it
    expect(alone.status).toBe("warn");
    expect(alone.message).toBe("no client is configured to launch this server");
    const text = alone.details.join("\n");
    expect(text).toContain(
      `code (project scope, ${path.join(clone, ".mcp.json")}): the plugin's own .mcp.json in a copy of this plugin, not a registration`,
    );
    expect(text).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(text).toContain("disabledMcpjsonServers");
    expect(text).not.toContain("entry ok");
    expect(text).toContain(
      `${path.join(sb.home, ".claude.json")} has no \`espn-fantasy-football\``,
    );
    // beside the enabled plugin it was "registers this server twice"; the plugin is the one
    const copy = pluginCopy(sb.home);
    installPlugin(sb.home, copy);
    const withPlugin = await checkLaunchConfig(io, [scan], scanPlugin(sb.home));
    expect(withPlugin.status).toBe("ok");
    expect(withPlugin.message).toBe("1 client registration with absolute, existing paths");
    // a real registration beside the clone's file is judged as before
    write(path.join(sb.home, ".claude.json"), {
      projects: { [clone]: {} },
      mcpServers: {
        "espn-fantasy-football": {
          command: process.execPath,
          args: [path.join(copy, "dist", "cli.js"), "serve"],
        },
      },
    });
    const both = scanClientConfig("code", path.join(sb.home, ".claude.json"));
    const dup = await checkLaunchConfig(io, [both], scanPlugin(sb.home));
    expect(dup.message).toContain("registers this server twice");
    expect(dup.details.join("\n")).toContain("code (user scope): entry ok");
  });

  it("row 3 still reads the clone's file: a cookie pasted into its env block is a config finding", () => {
    sb = sandbox();
    const clone = path.join(sb.home, "clone");
    pluginClone(clone, {
      mcpServers: { "espn-fantasy-football": { ...OWN, env: { ...OWN.env, PASTED: S2 } } },
    });
    knownProjects(sb.home, clone);
    const r = checkClientSecrecy([scanClientConfig("code", path.join(sb.home, ".claude.json"))]);
    expect(r.status).toBe("config");
    expect(JSON.stringify(r)).not.toContain(S2.slice(0, 16));
  });

  it("uninstall never tells the user to remove the plugin's server from a copy of the plugin", () => {
    sb = sandbox();
    const clone = path.join(sb.home, "clone");
    pluginClone(clone);
    knownProjects(sb.home, clone);
    const steps = manualSteps(sb.home, [], findRegistrations(sb.home)).join("\n");
    // it printed `cd <clone> && claude mcp remove --scope project espn-fantasy-football`
    expect(steps).not.toContain("--scope project");
    expect(steps).toContain(
      `${path.join(clone, ".mcp.json")} is the plugin's own .mcp.json in a copy of this plugin, not a registration: leave it`,
    );
    // no registration was found: the generic user-scope step stands
    expect(steps).toContain(
      "claude mcp remove --scope user espn-fantasy-football (entries live in",
    );
    // a cookie in that file is still said, with what to do about it
    pluginClone(clone, {
      mcpServers: { "espn-fantasy-football": { ...OWN, env: { ...OWN.env, PASTED: S2 } } },
    });
    const withCookie = manualSteps(sb.home, [], findRegistrations(sb.home)).join("\n");
    expect(withCookie).toContain("its env block holds an ESPN cookie");
    expect(withCookie).not.toContain(S2.slice(0, 16));
  });

  it("only a copy of this plugin: another plugin's manifest, a missing one or an absolute launch is judged as a registration", async () => {
    sb = sandbox();
    const other = path.join(sb.home, "other");
    write(path.join(other, ".claude-plugin", "plugin.json"), { name: "some-other-plugin" });
    write(path.join(other, ".mcp.json"), PLUGIN_MCP);
    const bare = path.join(sb.home, "bare");
    write(path.join(bare, ".mcp.json"), PLUGIN_MCP);
    const edited = path.join(sb.home, "edited");
    const shim = path.join(edited, "scripts", "eff-launch.sh");
    write(shim, "#!/bin/sh\n");
    pluginClone(edited, {
      mcpServers: { "espn-fantasy-football": { command: "/bin/sh", args: [shim, "serve"] } },
    });
    knownProjects(sb.home, other, bare, edited);
    expect([other, bare, edited, path.join(sb.home, "none")].map(isPluginRoot)).toEqual([
      false,
      false,
      true,
      false,
    ]);
    const scan = scanClientConfig("code", path.join(sb.home, ".claude.json"));
    expect(scan.entries.map((e) => [e.dir, e.pluginSource])).toEqual([
      [other, false],
      [bare, false],
      [edited, false],
    ]);
    const r = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [scan], null);
    // the plugin's variables in a project that is no copy of the plugin: that entry cannot start
    expect(r.status).toBe("fail");
    const text = r.details.join("\n");
    expect(text).toContain(
      `code (project scope, ${path.join(other, ".mcp.json")}): uses \${CLAUDE_PLUGIN_ROOT}, \${user_config.…}`,
    );
    expect(text).toContain(`code (project scope, ${path.join(bare, ".mcp.json")}): uses`);
    // an edited copy launching its own shim by an absolute path is a working registration
    expect(text).toContain(`code (project scope, ${path.join(edited, ".mcp.json")}): entry ok`);
  });
});

describe("row 2: an entry no client can start is never ok (final gate, round 2)", () => {
  it("a plugin variable in Claude Desktop's config or Claude Code's user or local scope: a hard problem", async () => {
    sb = sandbox();
    const io = makeIo(sb, { exec: shimOk });
    const dist = path.join(ROOT, "dist", "cli.js");
    for (const spec of [
      { command: "/bin/sh", args: ["${CLAUDE_PLUGIN_ROOT}/scripts/eff-launch.sh", "serve"] },
      {
        command: process.execPath,
        args: [dist, "serve"],
        env: { ESPN_SEASON: "${user_config.season}" },
      },
      { command: process.execPath, args: ["${CLAUDE_PLUGIN_ROOT}/dist/cli.js", "serve"] },
      { command: process.execPath, args: [dist, "serve"], env: { X: "${CLAUDE_PLUGIN_DATA}/x" } },
    ]) {
      const p = await entryProblems(io, spec);
      expect(p.hard, JSON.stringify(spec)).toHaveLength(1);
      expect(p.hard[0], JSON.stringify(spec)).toMatch(
        /^uses \$\{.+\}, which only a Claude Code plugin install expands: no client starts this entry/,
      );
    }
    expect(
      pluginVariables({
        command: "/bin/sh",
        args: ["${CLAUDE_PLUGIN_ROOT}/a", "${CLAUDE_PLUGIN_ROOT}/b", 7],
        env: { A: "${user_config.league_id}", B: "${user_config.toolset}", C: "${HOME}", D: 1 },
      }),
    ).toEqual(["${CLAUDE_PLUGIN_ROOT}", "${user_config.…}"]);
    expect(pluginVariables({ command: process.execPath, args: [dist, "serve"] })).toEqual([]);
    // through row 2, in each scope
    const desk = path.join(sb.dir, "desktop.json");
    write(desk, { mcpServers: { "espn-fantasy-football": PLUGIN_ENTRY } });
    const code = path.join(sb.home, ".claude.json");
    const proj = path.join(sb.home, "p");
    write(code, {
      mcpServers: { "espn-fantasy-football": PLUGIN_ENTRY },
      projects: { [proj]: { mcpServers: { "espn-fantasy-football": PLUGIN_ENTRY } } },
    });
    const r = await checkLaunchConfig(io, [
      scanClientConfig("desktop", desk),
      scanClientConfig("code", code),
    ]);
    expect(r.status).toBe("fail");
    const text = r.details.join("\n");
    for (const where of ["desktop", "code (user scope)", `code (local scope, ${proj})`])
      expect(text).toContain(`${where}: uses \${CLAUDE_PLUGIN_ROOT}`);
  });

  it("a `/bin/sh` launch needs the absolute path of an existing scripts/eff-launch.sh", async () => {
    sb = sandbox();
    const io = makeIo(sb, { exec: shimOk });
    const shim = path.join(sb.dir, "pkg", "scripts", "eff-launch.sh");
    write(shim, "#!/bin/sh\n");
    expect(await entryProblems(io, { command: "/bin/sh", args: [shim, "serve"] })).toEqual({
      hard: [],
      soft: [],
    });
    expect(
      (await entryProblems(io, { command: "/bin/sh", args: ["x/scripts/eff-launch.sh", "serve"] }))
        .hard,
    ).toEqual(["`args[0]` is not an absolute path to scripts/eff-launch.sh"]);
    expect(
      (
        await entryProblems(io, {
          command: "/bin/sh",
          args: [path.join(sb.dir, "gone", "scripts", "eff-launch.sh"), "serve"],
        })
      ).hard,
    ).toEqual(["`args[0]` does not exist"]);
    expect(
      (await entryProblems(io, { command: "/bin/sh", args: [path.join(sb.dir, "x.sh"), "serve"] }))
        .hard,
    ).toEqual(["`args[0]` is not an absolute path to scripts/eff-launch.sh"]);
  });
});

/** The plugin's server entry as a plugin declares it (the committed `.mcp.json`'s shape). */
const PLUGIN_ENTRY = {
  command: "/bin/sh",
  args: ["${CLAUDE_PLUGIN_ROOT}/scripts/eff-launch.sh", "serve"],
  env: { ESPN_LEAGUE_ID: "${user_config.league_id}" },
};
