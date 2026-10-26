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
//    user`, which never touches a local-scope entry (`claude mcp add`'s default), its env cookie kept.
// Every file lives in a sandbox HOME; values are generated placeholders; nothing is executed.
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeEspnS2 } from "../../scripts/ci/secret-fixtures.mjs";
import {
  cookieFindings,
  removeCommand,
  scanClientConfig,
  scanPlugin,
  whereOf,
} from "../../src/cli/client-config.js";
import { checkClientSecrecy, checkLaunchConfig, checkStaleBuild } from "../../src/cli/doctor.js";
import { main } from "../../src/cli/main.js";
import { manualSteps } from "../../src/cli/uninstall.js";
import { fakeExec, fakePackage, makeIo, sandbox, type Sandbox } from "./helpers.js";

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
