// registration-identity.test.ts — which client entries are THIS server, and which copy of the plugin
// Claude Code runs, as doctor rows #2/#24 and `eff uninstall` judge them (plan 03 §5 #2/#24, §8
// step 5). Both defects were found on the owner's Mac (2026-11-11), and these fixtures are his
// layout's exact shapes with placeholder paths:
//  - A: ~/.claude.json held, in the LOCAL scope of a project directory, the sibling's Yahoo server
//    under the key `fantasy-football-mcp-server` (`<node> <yahoo clone>/dist/cli.js serve`). Doctor
//    counted any `…/dist/cli.js serve` not keyed `fantasy-football` as this server: row 2 warned
//    "registers this server twice", called it "entry ok", said it ran this server "under another
//    key", and pointed at `eff uninstall --dry-run`. The rule now: what it launches decides (this
//    package's package.json name, or this plugin's manifest beside the shim); another package is
//    never ours, under any key — this server's own key included; when the package cannot be read,
//    the key decides (`espn-fantasy-football` stays ours, so a broken registration of ours is still
//    diagnosed; any other key is said once as undetermined and never counted or offered for removal).
//  - B: the plugin's marketplace is a FOLDER (known_marketplaces.json `source: "directory"`, the
//    listing's plugin source `./`), which the current Claude Code reads in place; installed_plugins.json
//    still records the cache copy from an earlier install. Row 24 failed on that leftover copy and
//    row 2 checked its shim while Claude Code ran the folder. A marketplace Claude Code copies
//    (GitHub, a git URL…) keeps the cache copy as what runs, and row 24 still fails on a stale one.
// Two verifiers then found the rest of each class (2026-11-11), each case here failing before its fix:
//  - A-F1: this server's own key launching another program (uv, any binary naming no dist/cli.js,
//    shim or `eff`) was still ours by key — row 2 failed and offered its `claude mcp remove`, and
//    uninstall printed the generic one. A-F2: this package's `eff` bin (`npm link`, a global
//    install) under another key was missed as a second registration. A-F3: two `claude mcp add`
//    registrations under different keys without the plugin were never called a duplicate.
//  - B1: a FOLDER marketplace doctor could not follow (its listing moved, deleted, garbled or no
//    longer listing the plugin; a source doctor refuses) fell back to judging the cache copy, which
//    Claude Code 2.1.308 never runs for a folder marketplace (it reads the folder in place or loads
//    nothing). B2: the leftover line named a cache copy that was not there, and did not say an older
//    client may keep and run that copy.
// Every file lives in a sandbox HOME; values and paths are placeholders; nothing is executed (the
// shim's `version --json` is a fake exec).
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeEspnS2, fakeGuid } from "../../scripts/ci/secret-fixtures.mjs";
import {
  classifyEntry,
  codeProjectKey,
  duplicateRegistrations,
  escapeControls,
  gitWorkTreeAt,
  holdsControl,
  installedPluginsPath as installedPluginsPathOf,
  MAX_GIT_POINTER_BYTES,
  pluginLoads,
  removalOf,
  removeCommand,
  scanClientConfig,
  scanPlugin,
} from "../../src/cli/client-config.js";
import { checkClientSecrecy, checkLaunchConfig, checkStaleBuild } from "../../src/cli/doctor.js";
import { main } from "../../src/cli/main.js";
import { findRegistrations, manualSteps } from "../../src/cli/uninstall.js";
import { fakeExec, fakePackage, makeIo, ROOT, sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox;
afterEach(() => {
  sb.cleanup();
});

const PLUGIN_ID = "espn-fantasy-football@espn-fantasy-football-mcp";
const MARKETPLACE = "espn-fantasy-football-mcp";
/** This repository's plugin manifest and marketplace listing, exactly as committed. */
const MANIFEST = readFileSync(path.join(ROOT, ".claude-plugin", "plugin.json"), "utf8");
const LISTING = readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8");
const INSTALLED_AT = "2026-11-03T00:00:00.000Z";

const write = (file: string, v: unknown): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof v === "string" ? v : JSON.stringify(v));
};
const at = (file: string, iso: string): void => {
  const d = new Date(iso);
  utimesSync(file, d, d);
};

/** The shim's `version --json` (doctor runs it through the injected exec). */
const shimOk = fakeExec(() => ({
  stdout: '{"node":"24.21.0","exec_path":"/n/bin/node"}\n',
})).exec;

/**
 * A copy of this repository (a runtime clone, a dev clone, the plugin's cache copy): its package,
 * plugin manifest and marketplace listing, its shim and its build — the build at `builtAt`, the
 * sources at `sourcesAt`. A `.git` makes it a checkout (rows 12/24 judge a checkout's sources).
 */
function espnCopy(
  dir: string,
  o: { builtAt?: string | null; sourcesAt?: string; checkout?: boolean } = {},
): string {
  if (o.checkout !== false) write(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  write(path.join(dir, "src", "cli", "main.ts"), "export {};\n");
  write(path.join(dir, "package.json"), { name: "espn-fantasy-football-mcp", version: "0.0.0" });
  write(path.join(dir, ".claude-plugin", "plugin.json"), MANIFEST);
  write(path.join(dir, ".claude-plugin", "marketplace.json"), LISTING);
  write(path.join(dir, "scripts", "eff-launch.sh"), "#!/bin/sh\n");
  const sourcesAt = o.sourcesAt ?? "2026-11-01T00:00:00Z";
  at(path.join(dir, "src", "cli", "main.ts"), sourcesAt);
  at(path.join(dir, "package.json"), sourcesAt);
  if (o.builtAt !== null) {
    write(path.join(dir, "dist", "cli.js"), "#!/usr/bin/env node\n");
    at(path.join(dir, "dist", "cli.js"), o.builtAt ?? "2026-11-05T00:00:00Z");
  }
  return dir;
}

/** The sibling's Yahoo clone (its own package and build); returns its dist/cli.js. */
function yahooClone(home: string): string {
  const root = path.join(home, "Developer", "yahoo-fantasy-football-mcp");
  write(path.join(root, "package.json"), { name: "fantasy-football-mcp", version: "0.0.0" });
  write(path.join(root, "dist", "cli.js"), "#!/usr/bin/env node\n");
  return path.join(root, "dist", "cli.js");
}

/** The owner's layout: the runtime clone under ~/src, its cache copy built earlier (stale). */
interface Layout {
  readonly folder: string;
  readonly cache: string;
}

/**
 * The plugin installed and enabled as Claude Code records it: installed_plugins.json's cache copy
 * (built before the folder, so stale), the settings' `enabledPlugins`, and known_marketplaces.json
 * with `marketplace` as the marketplace's record (null: no such file).
 */
function installPlugin(home: string, marketplace: unknown, folderBuilt?: string | null): Layout {
  const folder = espnCopy(
    path.join(home, "src", "espn-fantasy-football-mcp"),
    folderBuilt === undefined ? {} : { builtAt: folderBuilt },
  );
  const cache = espnCopy(
    path.join(home, ".claude", "plugins", "cache", MARKETPLACE, "espn-fantasy-football", "0.0.0"),
    { builtAt: "2026-11-03T00:00:00Z", checkout: false },
  );
  write(path.join(home, ".claude", "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: {
      [PLUGIN_ID]: [
        {
          scope: "user",
          installPath: cache,
          version: "0.0.0",
          installedAt: INSTALLED_AT,
          lastUpdated: INSTALLED_AT,
          gitCommitSha: "0000000000000000000000000000000000000000",
        },
      ],
    },
  });
  write(path.join(home, ".claude", "settings.json"), { enabledPlugins: { [PLUGIN_ID]: true } });
  const known = path.join(home, ".claude", "plugins", "known_marketplaces.json");
  if (marketplace !== null)
    write(
      known,
      typeof marketplace === "string"
        ? marketplace
        : {
            [MARKETPLACE]: marketplace,
            "other-market": recorded({ source: "github", repo: "x/y" }),
          },
    );
  return { folder, cache };
}

/**
 * A known_marketplaces.json record as Claude Code writes it: its source, its cache path and when it
 * was refreshed (Claude Code 2.1.308's schema requires all three of every record — verifier V-A).
 */
const recorded = (source: unknown): Record<string, unknown> => ({
  source,
  installLocation: path.join(path.sep, "placeholder", "marketplaces", "x"),
  lastUpdated: INSTALLED_AT,
});

/** known_marketplaces.json's record of a folder marketplace (`claude plugin marketplace add <dir>`). */
const folderMarketplace = (home: string): Record<string, unknown> => {
  const dir = path.join(home, "src", "espn-fantasy-football-mcp");
  return {
    source: { source: "directory", path: dir },
    installLocation: dir,
    lastUpdated: INSTALLED_AT,
  };
};
/** …and of a marketplace Claude Code clones from GitHub (its plugins are copied into the cache). */
const githubMarketplace = (home: string): Record<string, unknown> => ({
  source: { source: "github", repo: "example/espn-fantasy-football-mcp" },
  installLocation: path.join(home, ".claude", "plugins", "marketplaces", MARKETPLACE),
  lastUpdated: INSTALLED_AT,
});

/**
 * ~/.claude.json: the user scope, and the local scope of each project directory given — a project
 * Claude Code was opened in, so the directory is there (a key whose directory is gone is no session:
 * verifier F2, which writes its own).
 */
function claudeJson(
  home: string,
  user: Record<string, unknown>,
  local: Record<string, Record<string, unknown>> = {},
): string {
  for (const dir of Object.keys(local)) mkdirSync(dir, { recursive: true });
  const file = path.join(home, ".claude.json");
  write(file, {
    numStartups: 1,
    mcpServers: user,
    projects: Object.fromEntries(
      Object.entries(local).map(([dir, servers]) => [
        dir,
        { allowedTools: [], mcpServers: servers },
      ]),
    ),
  });
  return file;
}

const launch = (cli: string): Record<string, unknown> => ({
  command: process.execPath,
  args: [cli, "serve"],
});

describe("Defect A: an entry is this server by what it launches, not by its args' shape", () => {
  it("the owner's Yahoo entry (local scope, `fantasy-football-mcp-server`) beside the plugin: no second registration, the sibling is 'also installed (fine)'", async () => {
    sb = sandbox();
    installPlugin(sb.home, folderMarketplace(sb.home));
    const project = path.join(sb.home, "Developer", "fantasy-football");
    const code = claudeJson(
      sb.home,
      {},
      { [project]: { "fantasy-football-mcp-server": launch(yahooClone(sb.home)) } },
    );
    const scan = scanClientConfig("code", code);
    expect(scan.entries).toEqual([]);
    expect(scan.siblingInstalled).toBe(true);
    const r = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [scan], scanPlugin(sb.home));
    const text = r.details.join("\n");
    // it was: warn "Claude Code registers this server twice", the Yahoo entry "entry ok" under
    // "another key", and a fix pointing at `eff uninstall --dry-run`
    expect(r.status).toBe("ok");
    expect(r.message).toBe("1 client registration with absolute, existing paths");
    expect(r.fix).toBeNull();
    expect(text).toContain(
      "code: the sibling's `fantasy-football` server is also installed (fine)",
    );
    expect(text).not.toContain("under another key");
    expect(text).not.toContain("entry ok");
    expect(text).not.toContain("cannot tell");
    // uninstall never names it, and never offers its removal
    const steps = manualSteps(sb.home, [], findRegistrations(sb.home)).join("\n");
    expect(steps).not.toContain("fantasy-football-mcp-server");
    expect(steps).not.toContain(project);
  });

  it("the sibling under its own key, and under this server's key: never ours — under our key it is said and left, and uninstall never prints its removal", async () => {
    sb = sandbox();
    const yahoo = yahooClone(sb.home);
    const desk = path.join(sb.dir, "claude_desktop_config.json");
    write(desk, { mcpServers: { "espn-fantasy-football": launch(yahoo) } });
    const code = claudeJson(sb.home, {
      "fantasy-football": launch(yahoo),
      "espn-fantasy-football": launch(yahoo),
    });
    const scans = [scanClientConfig("desktop", desk), scanClientConfig("code", code)];
    expect(scans.map((s) => s.entries)).toEqual([[], []]);
    const r = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), scans, null);
    expect(r.status).toBe("warn");
    expect(r.message).toBe("no client is configured to launch this server");
    const text = r.details.join("\n");
    expect(text).toContain(
      "code: the sibling's `fantasy-football` server is also installed (fine)",
    );
    expect(text).toContain(
      "code (user scope): the `espn-fantasy-football` key launches another package, not this server — leave it",
    );
    expect(text).toContain(
      "desktop: the `espn-fantasy-football` key launches another package, not this server — leave it",
    );
    expect(text).not.toContain("entry ok");
    // the generic steps would remove the sibling's server: they are replaced by "leave it"
    const steps = manualSteps(sb.home, [], { scans, plugin: null }).join("\n");
    expect(steps).not.toContain("claude mcp remove --scope user espn-fantasy-football");
    expect(steps).toContain(
      'The "espn-fantasy-football" key in code (user scope) launches another package, not this server: leave it',
    );
    expect(steps).not.toContain(`Remove the "espn-fantasy-football" entry from ${desk}`);
    expect(steps).toContain(
      `The "espn-fantasy-football" entry in ${desk} (Claude Desktop) launches another package, not this server: leave it.`,
    );
  });

  it("another project's `cli.js serve` under any key is not counted, not 'entry ok', never offered for removal", async () => {
    sb = sandbox();
    installPlugin(sb.home, folderMarketplace(sb.home));
    const other = path.join(sb.home, "Developer", "some-other-mcp");
    write(path.join(other, "package.json"), { name: "some-other-mcp" });
    write(path.join(other, "dist", "cli.js"), "x");
    const shimOther = path.join(sb.home, "Developer", "some-plugin");
    write(path.join(shimOther, ".claude-plugin", "plugin.json"), { name: "some-other-plugin" });
    write(path.join(shimOther, "scripts", "eff-launch.sh"), "#!/bin/sh\n");
    const code = claudeJson(sb.home, {
      "other-server": launch(path.join(other, "dist", "cli.js")),
      "other-shim": {
        command: "/bin/sh",
        args: [path.join(shimOther, "scripts", "eff-launch.sh"), "serve"],
      },
    });
    const scan = scanClientConfig("code", code);
    expect(scan.entries).toEqual([]);
    expect(scan.others).toBe(2);
    const r = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [scan], scanPlugin(sb.home));
    expect(r.status).toBe("ok");
    expect(r.details.join("\n")).not.toMatch(/entry ok|under another key|cannot tell/);
    const steps = manualSteps(sb.home, [], findRegistrations(sb.home)).join("\n");
    expect(steps).not.toContain("other-server");
    expect(steps).not.toContain("other-shim");
  });

  it("a real second registration of this server — the runtime clone, a release install, the shim — under any key and scope is still the duplicate, with its exact `claude mcp remove`", async () => {
    sb = sandbox();
    const { folder } = installPlugin(sb.home, folderMarketplace(sb.home));
    const release = path.join(sb.dir, "opt", "espn-fantasy-football-mcp-0.0.0");
    espnCopy(release, { checkout: false });
    const project = path.join(sb.home, "Developer", "fantasy-football");
    const code = claudeJson(
      sb.home,
      {
        "espn-release": launch(path.join(release, "dist", "cli.js")),
        "espn-shim": {
          command: "/bin/sh",
          args: [path.join(folder, "scripts", "eff-launch.sh"), "serve"],
        },
        // this server under the SIBLING's key is still this server: what it launches decides
        "fantasy-football": launch(path.join(folder, "dist", "cli.js")),
      },
      { [project]: { "espn-ff": launch(path.join(folder, "dist", "cli.js")) } },
    );
    const scan = scanClientConfig("code", code);
    expect(scan.entries.map((e) => [e.scope, e.name])).toEqual([
      ["user", "espn-release"],
      ["user", "espn-shim"],
      ["user", "fantasy-football"],
      ["local", "espn-ff"],
    ]);
    expect(scan.siblingInstalled).toBe(false);
    const r = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [scan], scanPlugin(sb.home));
    expect(r.status).toBe("warn");
    // one session in that project directory sees all four keys (verifier A-F3); `espn-shim` runs the
    // plugin's very command line, so Claude Code drops the plugin's server there (R-P4)
    expect(r.message).toBe(
      "Claude Code registers this server four times: four `claude mcp add` entries under different keys — four servers, every tool listed four times",
    );
    expect(r.details).toContain(
      `code (user scope): runs the plugin's own command line (/bin/sh ${path.join(folder, "scripts", "eff-launch.sh")} serve) — Claude Code drops the plugin's server as a duplicate of it, so they are one server`,
    );
    // the exact commands, never a pointer at `eff uninstall` (whose real run deletes the install)
    expect(r.fix).not.toContain("eff uninstall");
    for (const cmd of [
      `cd ${project} && claude mcp remove --scope local espn-ff`,
      "claude mcp remove --scope user espn-release",
      "claude mcp remove --scope user espn-shim",
      "claude mcp remove --scope user fantasy-football",
    ])
      expect(r.fix).toContain(`\`${cmd}\``);
    expect(r.fix).toContain(`or uninstall the plugin (\`claude plugin uninstall ${PLUGIN_ID}\`)`);
    // …and without the plugin one entry stays: the first user-scope key is kept
    expect(r.fix).toContain(
      ` and remove the other entries (\`claude mcp remove --scope user espn-shim\`, \`claude mcp remove --scope user fantasy-football\`, \`cd ${project} && claude mcp remove --scope local espn-ff\`); then restart the client`,
    );
    const text = r.details.join("\n");
    expect(text).toContain(
      `code (local scope, ${project}): an entry launches this server under another key (expected \`espn-fantasy-football\`)`,
    );
    expect(text).toContain(`code (local scope, ${project}): entry ok`);
    // uninstall names the same commands
    const steps = manualSteps(sb.home, [], findRegistrations(sb.home)).join("\n");
    expect(steps).toContain(`cd ${project} && claude mcp remove --scope local espn-ff`);
    expect(steps).toContain(
      'registers this server under the key "espn-release": claude mcp remove --scope user espn-release',
    );
    expect(removeCommand({ scope: "local", dir: project, name: "espn-ff" })).toBe(
      `cd ${project} && claude mcp remove --scope local espn-ff`,
    );
  });

  it("a package doctor cannot read (missing, a symlink, too large, not JSON, unreadable) is said once and never counted or offered for removal; under this server's own key it stays ours", async () => {
    sb = sandbox();
    installPlugin(sb.home, folderMarketplace(sb.home));
    const pkg = (name: string): string => {
      const root = path.join(sb.home, "pkgs", name);
      write(path.join(root, "dist", "cli.js"), "x");
      return root;
    };
    const missing = pkg("missing");
    const linked = pkg("linked");
    write(path.join(sb.dir, "real-package.json"), { name: "espn-fantasy-football-mcp" });
    symlinkSync(path.join(sb.dir, "real-package.json"), path.join(linked, "package.json"));
    const big = pkg("big");
    write(
      path.join(big, "package.json"),
      `{"name":"espn-fantasy-football-mcp","pad":"${"x".repeat(1024 * 1024)}"}`,
    );
    const garbled = pkg("garbled");
    write(path.join(garbled, "package.json"), "{ not json");
    const locked = pkg("locked");
    write(path.join(locked, "package.json"), { name: "espn-fantasy-football-mcp" });
    const asRoot = process.getuid?.() === 0; // root reads a 000 file
    chmodSync(path.join(locked, "package.json"), 0o000);
    try {
      const cases: [string, string, string][] = [
        ["k-missing", missing, `${path.join(missing, "package.json")} is missing`],
        [
          "k-linked",
          linked,
          `${path.join(linked, "package.json")} is a symbolic link (never followed)`,
        ],
        ["k-big", big, `${path.join(big, "package.json")} is larger than 1048576 bytes`],
        ["k-garbled", garbled, `${path.join(garbled, "package.json")} is not JSON`],
        ...(asRoot
          ? []
          : [
              ["k-locked", locked, `${path.join(locked, "package.json")} is unreadable`] as [
                string,
                string,
                string,
              ],
            ]),
      ];
      const code = claudeJson(
        sb.home,
        Object.fromEntries(
          cases.map(([k, root]) => [k, launch(path.join(root, "dist", "cli.js"))]),
        ),
      );
      const scan = scanClientConfig("code", code);
      expect(scan.entries).toEqual([]);
      const r = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [scan], scanPlugin(sb.home));
      // not a duplicate beside the plugin: the plugin is the one registration
      expect(r.status).toBe("ok");
      expect(r.message).toBe("1 client registration with absolute, existing paths");
      const lines = r.details.filter((l) => l.includes("doctor cannot tell what it launches"));
      expect(lines).toHaveLength(cases.length);
      for (const [, root, why] of cases)
        expect(lines).toContain(
          `code (user scope): an entry launches ${path.join(root, "dist", "cli.js")}, and doctor cannot tell what it launches (${why}) — not counted as this server`,
        );
      expect(r.details.join("\n")).not.toContain("entry ok");
      const steps = manualSteps(sb.home, [], findRegistrations(sb.home)).join("\n");
      for (const [k, root] of cases) {
        expect(steps).not.toContain(`claude mcp remove --scope user ${k}`);
        expect(steps).toContain(
          `An entry in code (user scope) launches ${path.join(root, "dist", "cli.js")}, and uninstall cannot tell what it launches`,
        );
      }
      // under this server's own key the key decides: a registration of ours, judged (here, the
      // duplicate beside the plugin)
      const own = claudeJson(sb.home, {
        "espn-fantasy-football": launch(path.join(linked, "dist", "cli.js")),
      });
      const ownScan = scanClientConfig("code", own);
      expect(ownScan.entries.map((e) => e.name)).toEqual(["espn-fantasy-football"]);
      const dup = await checkLaunchConfig(
        makeIo(sb, { exec: shimOk }),
        [ownScan],
        scanPlugin(sb.home),
      );
      expect(dup.message).toContain("registers this server twice");
      expect(dup.fix).toContain("`claude mcp remove --scope user espn-fantasy-football`");
    } finally {
      chmodSync(path.join(locked, "package.json"), 0o600);
    }
  });

  it("this server's own key launching another program (uv, any binary naming no dist/cli.js, shim or `eff`) is not this server: said once, never counted, never offered for removal (A-F1)", async () => {
    sb = sandbox();
    installPlugin(sb.home, folderMarketplace(sb.home));
    const other = path.join(sb.home, "Developer", "other-mcp");
    const uv = { command: "/usr/bin/env", args: ["uv", "--directory", other, "run", "server.py"] };
    const desk = path.join(sb.dir, "claude_desktop_config.json");
    write(desk, { mcpServers: { "espn-fantasy-football": uv } });
    const code = claudeJson(sb.home, { "espn-fantasy-football": uv });
    const scans = [scanClientConfig("desktop", desk), scanClientConfig("code", code)];
    expect(scans.map((s) => s.entries)).toEqual([[], []]);
    expect(scans.map((s) => s.notOurs.map((n) => [n.kind, n.ownKey, n.target]))).toEqual([
      [["undetermined", true, "/usr/bin/env"]],
      [["undetermined", true, "/usr/bin/env"]],
    ]);
    const r = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), scans, scanPlugin(sb.home));
    // it was: fail "a client launches the server with a bad path, Node or location", fix "keep one:
    // remove the `claude mcp add` entry (`claude mcp remove --scope user espn-fantasy-football`)…"
    expect(r.status).toBe("ok");
    expect(r.message).toBe("1 client registration with absolute, existing paths");
    expect(r.fix).toBeNull();
    const why =
      "its command line names no dist/cli.js, scripts/eff-launch.sh or this package's `eff`";
    for (const where of ["code (user scope)", "desktop"])
      expect(r.details).toContain(
        `${where}: the \`espn-fantasy-football\` key launches /usr/bin/env, and doctor cannot tell what it launches (${why}) — not counted as this server`,
      );
    expect(r.details.join("\n")).not.toMatch(/entry ok|claude mcp remove|twice/);
    // uninstall prints neither the generic nor a specific removal of it
    const steps = manualSteps(sb.home, [], { scans, plugin: scanPlugin(sb.home) }).join("\n");
    expect(steps).not.toContain("claude mcp remove --scope user espn-fantasy-football");
    expect(steps).not.toContain(`Remove the "espn-fantasy-football" entry from ${desk}`);
    expect(steps).toContain(
      'The "espn-fantasy-football" key in code (user scope) launches what uninstall cannot tell is this server (said below): never run a generic `claude mcp remove espn-fantasy-football` there.',
    );
    expect(steps).toContain(
      `The "espn-fantasy-football" entry in ${desk} (Claude Desktop) launches what uninstall cannot tell is this server (said below): check it before removing it.`,
    );
    for (const where of ["code (user scope)", `${desk} (Claude Desktop)`])
      expect(steps).toContain(
        `The "espn-fantasy-football" key in ${where} launches /usr/bin/env, and uninstall cannot tell what it launches (${why}): it is not removed here — check what it is before removing anything.`,
      );
    // an entry with no command at all under this key: the same, value-free
    const bare = claudeJson(sb.home, { "espn-fantasy-football": { type: "http", url: "x" } });
    expect(scanClientConfig("code", bare).notOurs.map((n) => n.target)).toEqual(["(no command)"]);
    // a command line that names this program under this server's key stays ours, so a broken
    // registration of ours is still diagnosed: npx by package name, `eff` from the PATH
    for (const spec of [
      { command: "npx", args: ["-y", "espn-fantasy-football-mcp@0.0.0", "serve"] },
      { command: "npx", args: ["espn-fantasy-football-mcp", "serve"] },
      { command: "eff", args: ["serve"] },
    ]) {
      const own = scanClientConfig("code", claudeJson(sb.home, { "espn-fantasy-football": spec }));
      expect(
        own.entries.map((e) => e.name),
        JSON.stringify(spec),
      ).toEqual(["espn-fantasy-football"]);
      const judged = await checkLaunchConfig(
        makeIo(sb, { exec: shimOk }),
        [own],
        scanPlugin(sb.home),
      );
      expect(judged.status, JSON.stringify(spec)).toBe("fail");
      expect(judged.details.join("\n")).toContain("`command` is not an absolute path");
    }
  });

  it("this package's `eff` bin (an `npm link`, a global install: a link to its dist/cli.js) is this server under any key; a bare `eff` from the PATH is said once; another package's `eff` is not ours (A-F2)", async () => {
    sb = sandbox();
    const { folder } = installPlugin(sb.home, folderMarketplace(sb.home));
    const bin = path.join(sb.dir, "bin");
    mkdirSync(bin);
    symlinkSync(path.join(folder, "dist", "cli.js"), path.join(bin, "eff"));
    // another package's bin named eff
    const other = path.join(sb.home, "Developer", "other-eff");
    write(path.join(other, "package.json"), { name: "other-eff" });
    write(path.join(other, "dist", "cli.js"), "x");
    const otherBin = path.join(sb.dir, "obin");
    mkdirSync(otherBin);
    symlinkSync(path.join(other, "dist", "cli.js"), path.join(otherBin, "eff"));
    // a directory named eff in an argument is no program
    const dirNamedEff = path.join(sb.dir, "projects", "eff");
    mkdirSync(dirNamedEff, { recursive: true });
    const code = claudeJson(sb.home, {
      espn: { command: path.join(bin, "eff"), args: ["serve"] },
      "espn-node": { command: process.execPath, args: [path.join(bin, "eff"), "serve"] },
      "espn-path": { command: "eff", args: ["serve"] },
      "other-eff": { command: path.join(otherBin, "eff"), args: ["serve"] },
      "uv-dir": { command: "/usr/bin/env", args: ["uv", "--directory", dirNamedEff, "run", "x"] },
    });
    const scan = scanClientConfig("code", code);
    // it was: none of them ours — `eff` matched neither dist/cli.js nor the shim
    expect(scan.entries.map((e) => e.name)).toEqual(["espn", "espn-node"]);
    expect(scan.notOurs.map((n) => [n.kind, n.ownKey, n.target, n.why])).toEqual([
      ["undetermined", false, "eff", "it is run from the PATH, which doctor does not resolve"],
    ]);
    const r = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [scan], scanPlugin(sb.home));
    expect(r.status).not.toBe("ok");
    expect(r.fix).toContain("`claude mcp remove --scope user espn`");
    expect(r.fix).toContain("`claude mcp remove --scope user espn-node`");
    expect(r.fix).not.toMatch(/espn-path|other-eff|uv-dir/);
    expect(r.details).toContain("code (user scope): entry ok");
    expect(r.details).toContain(
      "code (user scope): an entry launches eff, and doctor cannot tell what it launches (it is run from the PATH, which doctor does not resolve) — not counted as this server",
    );
    // a link that is gone, or that resolves to a file that is no dist/cli.js: said once
    symlinkSync(path.join(sb.dir, "gone.js"), path.join(sb.dir, "eff"));
    const wrapper = path.join(sb.dir, "wbin");
    mkdirSync(wrapper);
    write(path.join(wrapper, "eff"), "#!/bin/sh\n");
    const odd = scanClientConfig(
      "code",
      claudeJson(sb.home, {
        gone: { command: path.join(sb.dir, "eff"), args: ["serve"] },
        wrapped: { command: path.join(wrapper, "eff"), args: ["serve"] },
        relative: { command: "bin/eff", args: ["serve"] },
      }),
    );
    expect(odd.entries).toEqual([]);
    expect(odd.notOurs.map((n) => n.why)).toEqual([
      "it does not exist",
      `it resolves to ${path.join(wrapper, "eff")}, which is not a dist/cli.js`,
      "its path is not absolute",
    ]);
    // under this server's own key: a broken link of ours stays ours (diagnosed); an `eff` that is
    // no link to a dist/cli.js names no program of this package, so the key does not make it ours
    const own = (cmd: string) =>
      scanClientConfig(
        "code",
        claudeJson(sb.home, { "espn-fantasy-football": { command: cmd, args: ["serve"] } }),
      );
    expect(own(path.join(sb.dir, "eff")).entries.map((e) => e.name)).toEqual([
      "espn-fantasy-football",
    ]);
    const wrapped = own(path.join(wrapper, "eff"));
    expect(wrapped.entries).toEqual([]);
    expect(wrapped.notOurs.map((n) => [n.kind, n.ownKey])).toEqual([["undetermined", true]]);
  });

  it("two or more `claude mcp add` registrations of this server under different keys, without the plugin, are the duplicate: the fix removes all but one (A-F3)", async () => {
    sb = sandbox();
    const folder = espnCopy(path.join(sb.home, "src", "espn-fantasy-football-mcp"));
    const release = espnCopy(path.join(sb.dir, "opt", "espn-fantasy-football-mcp-0.0.0"), {
      checkout: false,
    });
    const work = path.join(sb.home, "work");
    const cli = path.join(folder, "dist", "cli.js");
    const code = claudeJson(
      sb.home,
      {
        "espn-fantasy-football": launch(cli),
        "espn-release": launch(path.join(release, "dist", "cli.js")),
      },
      { [work]: { "espn-ff": launch(cli) } },
    );
    const io = makeIo(sb, { exec: shimOk });
    const r = await checkLaunchConfig(io, [scanClientConfig("code", code)], null);
    // it was: ok "3 client registrations with absolute, existing paths", fix null
    expect(r.status).toBe("warn");
    expect(r.message).toBe(
      "Claude Code registers this server three times: three `claude mcp add` entries under different keys — three servers, every tool listed three times",
    );
    expect(r.fix).toBe(
      `keep one: remove the other entries (\`claude mcp remove --scope user espn-release\`, \`cd ${work} && claude mcp remove --scope local espn-ff\`); then restart the client`,
    );
    // the same, with the plugin on: either choice keeps one
    const { folder: pluginFolder } = installPlugin(sb.home, folderMarketplace(sb.home));
    expect(pluginFolder).toBe(folder);
    const withPlugin = await checkLaunchConfig(
      io,
      [scanClientConfig("code", code)],
      scanPlugin(sb.home),
    );
    expect(withPlugin.status).toBe("warn");
    expect(withPlugin.message).toBe(
      "Claude Code registers this server four times: the plugin AND three `claude mcp add` entries under different keys — four servers, every tool listed four times",
    );
    expect(withPlugin.fix).toBe(
      `keep one: remove the \`claude mcp add\` entries (\`claude mcp remove --scope user espn-fantasy-football\`, \`claude mcp remove --scope user espn-release\`, \`cd ${work} && claude mcp remove --scope local espn-ff\`), or uninstall the plugin (\`claude plugin uninstall ${PLUGIN_ID}\`) and remove the other entries (\`claude mcp remove --scope user espn-release\`, \`cd ${work} && claude mcp remove --scope local espn-ff\`); then restart the client`,
    );
    sb.cleanup();
    // a local entry under the user entry's own key overrides it (one server); entries in two
    // project directories never meet in one session: neither is a duplicate
    sb = sandbox();
    const one = espnCopy(path.join(sb.home, "src", "espn-fantasy-football-mcp"));
    const c1 = path.join(one, "dist", "cli.js");
    const a = path.join(sb.home, "a");
    const b = path.join(sb.home, "b");
    for (const [user, local] of [
      [{ "espn-fantasy-football": launch(c1) }, { [a]: { "espn-fantasy-football": launch(c1) } }],
      [{}, { [a]: { "espn-a": launch(c1) }, [b]: { "espn-b": launch(c1) } }],
    ] as const) {
      const f = claudeJson(sb.home, user, local);
      const ok = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [
        scanClientConfig("code", f),
      ]);
      expect(ok.status, JSON.stringify(local)).toBe("ok");
      expect(ok.fix).toBeNull();
    }
    // two keys in one project directory (local and project scope) are the duplicate there
    write(path.join(a, ".mcp.json"), { mcpServers: { "espn-p": launch(c1) } });
    const proj = claudeJson(sb.home, {}, { [a]: { "espn-a": launch(c1) } });
    const pr = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [
      scanClientConfig("code", proj),
    ]);
    expect(pr.message).toContain(
      "Claude Code registers this server twice: two `claude mcp add` entries",
    );
    expect(pr.fix).toBe(
      `keep one: remove the other entry (\`cd ${a} && claude mcp remove --scope project espn-p\`); then restart the client`,
    );
    // Claude Desktop: one registration per client too
    const desk = path.join(sb.dir, "claude_desktop_config.json");
    write(desk, {
      mcpServers: { "espn-fantasy-football": launch(c1), "espn-2": launch(c1) },
    });
    const d = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [
      scanClientConfig("desktop", desk),
    ]);
    expect(d.status).toBe("warn");
    expect(d.message).toBe(
      "Claude Desktop registers this server twice: two entries under different keys — two servers, every tool listed twice",
    );
    expect(d.fix).toBe(
      `keep one: remove the "espn-2" entry from ${desk} (Claude Desktop); then restart it`,
    );
  });
});

describe("Defect B: the plugin is judged where Claude Code reads it", () => {
  it("a folder marketplace (the owner's): the plugin runs from its folder; the stale cache copy is a leftover — row 24 ok with the leftover named once, row 2 names the folder and its shim", async () => {
    sb = sandbox();
    const { folder, cache } = installPlugin(sb.home, folderMarketplace(sb.home));
    const plugin = scanPlugin(sb.home);
    expect(plugin?.origin).toEqual({ kind: "folder", root: folder, marketplaceDir: folder });
    expect(plugin?.copies).toEqual([
      { scope: "user", root: folder, installPath: cache, version: "0.0.0" },
    ]);
    // B2: the current client reads the folder in place; an older one may keep and run the copy
    const leftover = `the current Claude Code reads the plugin in place from ${folder} and does not run the cache copy ${cache}; if \`claude plugin update\` reports an old copy kept at an unchanged version, your client runs it — reinstall it (README Upgrade)`;
    // doctor run from the folder itself (the runtime clone)
    const fromFolder = checkStaleBuild(folder, plugin);
    expect(fromFolder.status).toBe("ok");
    expect(fromFolder.details.filter((l) => l === leftover)).toHaveLength(1);
    expect(fromFolder.details).toContain(
      `plugin folder ${folder}: this clone (the package doctor runs from), read in place by Claude Code — its build is the one checked here`,
    );
    expect(fromFolder.details.join("\n")).not.toContain(`plugin copy ${cache}`);
    // doctor run from another clone, built later: the folder is judged against its own sources
    const dev = espnCopy(path.join(sb.home, "Developer", "espn-fantasy-football-mcp"), {
      builtAt: "2026-11-10T00:00:00Z",
      sourcesAt: "2026-11-09T00:00:00Z",
    });
    const fromDev = checkStaleBuild(dev, plugin);
    expect(fromDev.status).toBe("ok");
    expect(fromDev.details).toContain(`plugin folder ${folder}: current`);
    expect(fromDev.details).toContain(leftover);
    // row 2: the registration, the leftover line and the shim are the folder's
    const r = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [], plugin);
    expect(r.status).toBe("ok");
    const text = r.details.join("\n");
    expect(text).toContain(
      `code: the plugin registers the server (user scope, version 0.0.0, ${folder}, read in place from its folder marketplace)`,
    );
    expect(text).toContain(`code: ${leftover}`);
    expect(text).toContain(`plugin copy's shim (${folder}) would run node 24.21.0`);
    expect(text).not.toContain(`shim (${cache})`);
    // uninstall names the folder and the leftover
    expect(manualSteps(sb.home, [], findRegistrations(sb.home)).join("\n")).toContain(
      `It is installed here (${folder}, read in place from its folder marketplace; ${cache} is a leftover cache copy).`,
    );
  });

  it("a recorded cache copy that is not there is said to be absent, never called a leftover copy (B2)", async () => {
    sb = sandbox();
    const { folder, cache } = installPlugin(sb.home, folderMarketplace(sb.home));
    rmSync(cache, { recursive: true, force: true });
    const plugin = scanPlugin(sb.home);
    const absent = `installed_plugins.json records ${cache}; nothing is there, and Claude Code reads the plugin from its folder (${folder}) — nothing to do`;
    // it was: "the cache copy <path> is a leftover of an earlier install…" for a path holding nothing
    const r24 = checkStaleBuild(folder, plugin);
    expect(r24.status).toBe("ok");
    expect(r24.details).toContain(absent);
    expect(r24.details.join("\n")).not.toContain("leftover");
    const r2 = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [], plugin);
    expect(r2.details).toContain(`code: ${absent}`);
    const steps = manualSteps(sb.home, [], findRegistrations(sb.home)).join("\n");
    expect(steps).toContain(
      `It is installed here (${folder}, read in place from its folder marketplace).`,
    );
    expect(steps).not.toContain("leftover");
  });

  it("a folder plugin built before its own sources fails row 24 with `npm run build` there, never the plugin reinstall; a folder with no build fails row 2", async () => {
    sb = sandbox();
    const { folder } = installPlugin(sb.home, folderMarketplace(sb.home), "2026-10-30T00:00:00Z");
    const plugin = scanPlugin(sb.home);
    const dev = espnCopy(path.join(sb.home, "Developer", "espn-fantasy-football-mcp"), {
      builtAt: "2026-11-10T00:00:00Z",
    });
    const stale = checkStaleBuild(dev, plugin);
    expect(stale.status).toBe("fail");
    expect(stale.message).toContain(
      "the plugin folder Claude Code reads is not built from its current sources",
    );
    expect(stale.details).toContain(
      `plugin folder ${folder}: built before its own sources — Claude Code runs the old server`,
    );
    expect(stale.fix).toContain(`\`npm run build\` in ${folder}`);
    expect(stale.fix).not.toContain("claude plugin uninstall");
    // run from the folder itself: the clone's own check, and the fix restarts the client
    const self = checkStaleBuild(folder, plugin);
    expect(self.status).toBe("fail");
    expect(self.message).toContain("dist/ is older than the sources");
    expect(self.fix).toBe(
      "`npm run build`, then restart the client (Claude Code reads the plugin in place from this clone)",
    );
    // no build in the folder: row 2 fails, and its fix builds the folder
    const unbuilt = sandbox();
    try {
      installPlugin(unbuilt.home, folderMarketplace(unbuilt.home), null);
      const r = await checkLaunchConfig(
        makeIo(unbuilt, { exec: shimOk }),
        [],
        scanPlugin(unbuilt.home),
      );
      expect(r.status).toBe("fail");
      expect(r.details.join("\n")).toContain(
        `code: the plugin's folder ${path.join(unbuilt.home, "src", "espn-fantasy-football-mcp")} has no dist/cli.js — Claude Code reads the plugin there: \`npm run build\` in it`,
      );
      expect(r.fix).toContain("build the plugin's folder (`npm run build` there");
    } finally {
      unbuilt.cleanup();
    }
  });

  it("a GitHub marketplace: the cache copy is what runs — a stale one fails row 24 as before", () => {
    sb = sandbox();
    const { folder, cache } = installPlugin(sb.home, githubMarketplace(sb.home));
    const plugin = scanPlugin(sb.home);
    expect(plugin?.origin).toEqual({ kind: "copied", source: "github" });
    expect(plugin?.copies[0]?.root).toBe(cache);
    const r = checkStaleBuild(folder, plugin);
    expect(r.status).toBe("fail");
    expect(r.message).toBe(
      "1 plugin copy is older than this clone — Claude Code launches an old server",
    );
    expect(r.details).toContain(
      `plugin copy ${cache}: built before this clone's current build or sources — Claude Code runs the old server`,
    );
    expect(r.fix).toContain(`claude plugin uninstall ${PLUGIN_ID}`);
    expect(r.details.join("\n")).not.toContain("leftover");
    // a folder marketplace whose listing names a remote source for the plugin: copied too
    const remote = sandbox();
    try {
      const l = installPlugin(remote.home, folderMarketplace(remote.home));
      write(path.join(l.folder, ".claude-plugin", "marketplace.json"), {
        name: MARKETPLACE,
        plugins: [
          {
            name: "espn-fantasy-football",
            source: { source: "url", url: "https://example.invalid/x.git" },
          },
        ],
      });
      expect(scanPlugin(remote.home)?.origin).toEqual({ kind: "copied", source: "url" });
      expect(checkStaleBuild(l.folder, scanPlugin(remote.home)).status).toBe("fail");
    } finally {
      remote.cleanup();
    }
  });

  it("a folder marketplace whose plugin source doctor does not follow (absolute, .., a symlink out, a bare name): row 2 warns it cannot tell what runs, and the cache copy is never judged (B1)", async () => {
    sb = sandbox();
    const outside = espnCopy(path.join(sb.dir, "elsewhere"), { builtAt: "2026-11-20T00:00:00Z" });
    for (const [source, why] of [
      [outside, "is an absolute path, outside the marketplace folder"],
      ["./../elsewhere", "climbs out of the marketplace folder (..)"],
      ["./out", "passes through a symbolic link, which doctor never follows"],
      ["bare-name", "is a bare name and the marketplace sets no metadata.pluginRoot"],
    ] as const) {
      const home = path.join(sb.dir, `home-${String(Math.random()).slice(2, 8)}`);
      mkdirSync(home);
      const { folder, cache } = installPlugin(home, folderMarketplace(home));
      try {
        symlinkSync(outside, path.join(folder, "out"));
      } catch {
        // already there
      }
      write(path.join(folder, ".claude-plugin", "marketplace.json"), {
        name: MARKETPLACE,
        plugins: [{ name: "espn-fantasy-football", source }],
      });
      const plugin = scanPlugin(home);
      // Claude Code reads a folder marketplace's plugin in place or not at all: never the cache
      expect(plugin?.origin.kind, source).toBe("refused");
      expect(plugin?.origin.kind === "refused" ? plugin.origin.why : "", source).toContain(why);
      expect(plugin?.copies[0]?.root, source).toBeNull();
      // it was: fail "1 plugin copy is older than this clone", fix `claude plugin uninstall …`
      const r = checkStaleBuild(folder, plugin);
      expect(r.status, source).toBe("ok");
      expect(r.fix, source).toBeNull();
      expect(r.details.join("\n"), source).not.toContain(`plugin copy ${cache}`);
      expect(r.details.join("\n"), source).toContain(
        `the cache copy ${cache} is not judged: the current Claude Code reads a folder marketplace's plugin in place, never from the cache, and doctor does not follow the plugin's source there (`,
      );
      // an installed package (no checkout): nothing to judge, said
      const pkg = checkStaleBuild(sb.dir, plugin);
      expect(pkg.status, source).toBe("skip");
      expect(pkg.message).toBe(
        "no plugin build to judge: doctor cannot tell what Claude Code runs for the plugin (row 2)",
      );
      // row 2: never "the plugin registers the server (… <cache>)", never the cache's shim
      const r2 = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [], plugin);
      expect(r2.status, source).toBe("warn");
      expect(r2.message).toBe(
        "doctor cannot tell what Claude Code runs for the plugin: it does not follow the plugin's source in its folder marketplace",
      );
      const text = r2.details.join("\n");
      expect(text, source).toContain(
        "code: doctor cannot tell what Claude Code runs for the plugin — ",
      );
      expect(text, source).toContain(why);
      expect(text, source).not.toContain("the plugin registers the server");
      expect(text, source).not.toContain(`shim (${cache})`);
      expect(r2.fix).toContain("`claude plugin list`");
    }
  });

  it("a folder marketplace moved or deleted, or whose listing no longer lists the plugin: Claude Code cannot load it — row 2 fails with the re-add, row 24 never judges the cache copy (B1)", async () => {
    sb = sandbox();
    const dev = espnCopy(path.join(sb.home, "Developer", "espn-fantasy-football-mcp"), {
      builtAt: "2026-11-10T00:00:00Z",
      sourcesAt: "2026-11-09T00:00:00Z",
    });
    const cases: [string, (folder: string) => void, string][] = [
      [
        "moved",
        (folder) => {
          renameSync(folder, `${folder}-moved`);
        },
        "is missing",
      ],
      [
        "deleted",
        (folder) => {
          rmSync(folder, { recursive: true, force: true });
        },
        "is missing",
      ],
      [
        "unlisted",
        (folder) => {
          write(path.join(folder, ".claude-plugin", "marketplace.json"), {
            name: MARKETPLACE,
            plugins: [],
          });
        },
        "does not list the espn-fantasy-football plugin",
      ],
      [
        "garbled",
        (folder) => {
          write(path.join(folder, ".claude-plugin", "marketplace.json"), "{");
        },
        "is not JSON",
      ],
      [
        "no source",
        (folder) => {
          write(path.join(folder, ".claude-plugin", "marketplace.json"), {
            plugins: [{ name: "espn-fantasy-football" }],
          });
        },
        "gives the espn-fantasy-football plugin no source",
      ],
    ];
    for (const [label, breakIt, why] of cases) {
      const home = path.join(sb.dir, `home-${label.replace(" ", "-")}`);
      mkdirSync(home);
      const { folder, cache } = installPlugin(home, folderMarketplace(home));
      breakIt(folder);
      const listing = path.join(folder, ".claude-plugin", "marketplace.json");
      const plugin = scanPlugin(home);
      expect(plugin?.origin, label).toEqual({
        kind: "unresolved",
        marketplaceDir: folder,
        why: `${listing} ${why}`,
      });
      expect(plugin?.copies[0]?.root, label).toBeNull();
      // it was: row 2 ok "the plugin registers the server (… <cache>)" while nothing loads
      const r2 = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [], plugin);
      expect(r2.status, label).toBe("fail");
      expect(r2.message).toBe("Claude Code cannot load the plugin from its folder marketplace");
      expect(r2.details, label).toContain(
        `code: Claude Code cannot load the plugin — its folder marketplace ${folder}: ${listing} ${why}`,
      );
      expect(r2.details.join("\n"), label).not.toContain("the plugin registers the server");
      expect(r2.details.join("\n"), label).not.toContain(`shim (${cache})`);
      expect(r2.fix).toBe(
        `add the marketplace and the plugin again from the built runtime clone: \`claude plugin marketplace remove ${MARKETPLACE}\`, then \`claude plugin marketplace add <the runtime clone>\` and \`claude plugin install ${PLUGIN_ID}\` (README step 5), then restart the client`,
      );
      // row 24: the cache copy is never judged — from a current clone ok, from a package a skip
      const r24 = checkStaleBuild(dev, plugin);
      expect(r24.status, label).toBe("ok");
      expect(r24.details.join("\n"), label).not.toContain(`plugin copy ${cache}`);
      expect(r24.details, label).toContain(
        `the cache copy ${cache} is not judged: the current Claude Code reads a folder marketplace's plugin in place, never from the cache`,
      );
      const pkg = checkStaleBuild(sb.dir, plugin);
      expect(pkg.status, label).toBe("skip");
      expect(pkg.message).toBe(
        "no plugin build to judge: Claude Code cannot load the plugin (row 2)",
      );
      // a stale clone's fix is its own build, never the plugin reinstall
      const staleDev = espnCopy(path.join(home, "stale-dev"), {
        builtAt: "2026-11-01T00:00:00Z",
        sourcesAt: "2026-11-02T00:00:00Z",
      });
      expect(checkStaleBuild(staleDev, plugin).fix, label).toBe("`npm run build`");
      // uninstall names the record, never a root it cannot know
      const steps = manualSteps(home, [], findRegistrations(home)).join("\n");
      expect(steps, label).toContain(
        `It is installed here (installed_plugins.json records ${cache}; Claude Code cannot load it — its folder marketplace ${folder}: ${listing} ${why}).`,
      );
    }
  });

  it("every other folder record or listing doctor cannot follow is refused or unresolved — never a cache copy judged as what runs (B1)", () => {
    sb = sandbox();
    const { folder } = installPlugin(sb.home, folderMarketplace(sb.home));
    const known = path.join(sb.home, ".claude", "plugins", "known_marketplaces.json");
    const listing = path.join(folder, ".claude-plugin", "marketplace.json");
    const linked = path.join(sb.dir, "linked-marketplace.json");
    write(linked, LISTING);
    const linkDir = path.join(sb.dir, "linkdir");
    mkdirSync(path.join(linkDir, ".claude-plugin"), { recursive: true });
    symlinkSync(linked, path.join(linkDir, ".claude-plugin", "marketplace.json"));
    const cases: [unknown, unknown, "refused" | "unresolved", string][] = [
      [recorded({ source: "directory", path: "src/x" }), null, "refused", "no absolute path"],
      [
        recorded({ source: "file", path: path.join(folder, "m.json") }),
        null,
        "refused",
        "not in a .claude-plugin folder",
      ],
      [
        recorded({ source: "directory", path: linkDir }),
        null,
        "refused",
        "is a symbolic link (never followed)",
      ],
      [
        recorded({ source: "directory", path: folder }),
        { name: MARKETPLACE, plugins: [] },
        "unresolved",
        "does not list",
      ],
      [
        recorded({ source: "directory", path: folder }),
        { plugins: [{ name: "espn-fantasy-football" }] },
        "unresolved",
        "gives the espn-fantasy-football plugin no source",
      ],
      [
        recorded({ source: "directory", path: folder }),
        { plugins: [{ name: "espn-fantasy-football", source: "~/elsewhere" }] },
        "refused",
        "is an absolute path",
      ],
      [
        recorded({ source: "directory", path: folder }),
        { plugins: [{ name: "espn-fantasy-football", source: "./a\u0007b" }] },
        "refused",
        "is not a path doctor reads",
      ],
      [recorded({ source: "directory", path: folder }), "{", "unresolved", "is not JSON"],
    ];
    for (const [record, doc, kind, why] of cases) {
      write(known, { [MARKETPLACE]: record });
      if (doc !== null) write(listing, doc);
      const plugin = scanPlugin(sb.home);
      expect(plugin?.origin.kind, why).toBe(kind);
      const o = plugin?.origin;
      expect(o !== undefined && "why" in o ? o.why : "", why).toContain(why);
      expect(plugin?.copies[0]?.root, why).toBeNull();
    }
    // a source Claude Code fetches is copied; a source type it does not have is refused (V-A)
    write(known, {
      [MARKETPLACE]: recorded({ source: "git", url: "https://example.invalid/m.git" }),
    });
    expect(scanPlugin(sb.home)?.origin).toEqual({ kind: "copied", source: "git" });
    write(known, { [MARKETPLACE]: recorded({ source: "Some Thing!" }) });
    expect(scanPlugin(sb.home)?.origin.kind).toBe("refused");
  });

  it("a `file` source, a relative plugin directory and metadata.pluginRoot resolve inside the folder", () => {
    sb = sandbox();
    const { folder } = installPlugin(sb.home, folderMarketplace(sb.home));
    const listing = path.join(folder, ".claude-plugin", "marketplace.json");
    write(path.join(sb.home, ".claude", "plugins", "known_marketplaces.json"), {
      [MARKETPLACE]: recorded({ source: "file", path: listing }),
    });
    expect(scanPlugin(sb.home)?.origin).toEqual({
      kind: "folder",
      root: folder,
      marketplaceDir: folder,
    });
    const nested = espnCopy(path.join(folder, "plugins", "espn"), { checkout: false });
    write(listing, {
      name: MARKETPLACE,
      plugins: [{ name: "espn-fantasy-football", source: "./plugins/espn" }],
    });
    expect(scanPlugin(sb.home)?.copies[0]?.root).toBe(nested);
    write(listing, {
      name: MARKETPLACE,
      metadata: { pluginRoot: "./plugins" },
      plugins: [{ name: "espn-fantasy-football", source: "espn" }],
    });
    expect(scanPlugin(sb.home)?.copies[0]?.root).toBe(nested);
  });

  it("eff doctor end to end on the owner's layout (the Yahoo entry, the folder marketplace declared and recorded, the stale cache copy, the clones' committed .mcp.json as projects): row 2 ok, row 24 ok", async () => {
    sb = sandbox({ create: true });
    const { folder, cache } = installPlugin(sb.home, folderMarketplace(sb.home));
    const project = path.join(sb.home, "Developer", "fantasy-football");
    mkdirSync(project, { recursive: true });
    // the dev clone and the runtime clone are copies of this repository, its .mcp.json included,
    // and Claude Code records both (and the home directory) as projects (F7)
    const dev = espnCopy(path.join(sb.home, "Developer", "espn-fantasy-football-mcp"));
    const committed = readFileSync(path.join(ROOT, ".mcp.json"), "utf8");
    for (const clone of [dev, folder]) write(path.join(clone, ".mcp.json"), committed);
    claudeJson(
      sb.home,
      {},
      {
        [project]: { "fantasy-football-mcp-server": launch(yahooClone(sb.home)) },
        [dev]: {},
        [folder]: {},
        [sb.home]: {},
      },
    );
    // the user settings declare the folder marketplace beside its record, and enable the plugin
    write(path.join(sb.home, ".claude", "settings.json"), {
      enabledPlugins: { [PLUGIN_ID]: true },
      extraKnownMarketplaces: {
        [MARKETPLACE]: { source: { source: "directory", path: folder } },
      },
    });
    const io = makeIo(sb, {
      exec: shimOk,
      packageRoot: folder,
      env: { ESPN_LEAGUE_ID: "0", EFF_CREDENTIAL_STORE: "file" },
    });
    await main(["doctor", "--json"], io);
    const doc = JSON.parse(io.out.text) as {
      rows: { n: number; status: string; message: string; details: string[] }[];
    };
    const row2 = doc.rows.find((r) => r.n === 2);
    const row24 = doc.rows.find((r) => r.n === 24);
    expect(row2?.status).toBe("ok");
    expect(row2?.message).not.toContain("twice");
    expect(row2?.message).toBe("1 client registration with absolute, existing paths");
    for (const clone of [dev, folder])
      expect(row2?.details).toContain(
        `code (project scope, ${path.join(clone, ".mcp.json")}): the plugin's own .mcp.json in a copy of this plugin, not a registration — Claude Code opened in that directory reads it as a project server, which cannot start there (\${CLAUDE_PLUGIN_ROOT} and \${user_config.…} expand only in a plugin install): leave the file, and leave that project server unapproved there (\`disabledMcpjsonServers: ["espn-fantasy-football"]\` in its .claude/settings.local.json declines it)`,
      );
    expect(row24?.status).toBe("ok");
    expect(row24?.details.join("\n")).toContain(`and does not run the cache copy ${cache}`);
    const steps = manualSteps(sb.home, [], findRegistrations(sb.home)).join("\n");
    expect(steps).not.toContain("claude mcp remove --scope project espn-fantasy-football");
    expect(steps).not.toContain("fantasy-football-mcp-server");
  });
});

// Refix round 1 (verifiers R and F, 2026-11-11): what row 2 and uninstall print, which words are a
// program, and Claude Code 2.1.308's own load and dedupe rules — each case failed before its fix.
describe("Refix round 1: never a value printed; a program only in program position (R-P1, R-P2, R-P6)", () => {
  it("a word holding more than a path (an `sh -c` line with NAME=value assignments) is never printed: not in row 2's details or fix, `--json` or text, nor uninstall's steps (R-P1)", async () => {
    sb = sandbox({ create: true });
    const s2 = fakeEspnS2("refix-p1", 220);
    const guid = fakeGuid("refix-p1");
    const token = `tok_${"0123456789abcdef".repeat(2)}`;
    const assigns = `ESPN_S2=${s2} SWID={${guid}} API_TOKEN=${token}`;
    const folder = espnCopy(path.join(sb.home, "src", "espn-fantasy-football-mcp"));
    const cli = path.join(folder, "dist", "cli.js");
    const desk = path.join(sb.dir, "claude_desktop_config.json");
    write(desk, {
      mcpServers: {
        "espn-fantasy-football": {
          command: "/bin/sh",
          args: ["-c", `${assigns} exec node ${cli}`],
        },
        "espn-desk": {
          command: "/bin/sh",
          args: ["-c", `${assigns} exec node /opt/x/dist/cli.js`],
        },
      },
    });
    const code = claudeJson(sb.home, {
      "espn-sh": { command: "/bin/sh", args: ["-c", `${assigns} exec /usr/local/bin/eff`] },
      "espn-node": { command: "/bin/sh", args: ["-c", `${assigns} exec node /opt/x/dist/cli.js`] },
      "espn-abs": { command: "/opt/run", args: [`/opt/run ${assigns} /opt/x/dist/cli.js`] },
      "espn-fantasy-football": {
        command: `SWID={${guid}} API_TOKEN=${token} /usr/bin/uv`,
        args: ["run", "server.py"],
      },
      "espn-two": launch(cli),
      // a key of ours holding a GUID: printed in the fix and the steps, redacted there (defence)
      [`espn-{${guid}}`]: launch(cli),
    });
    const scans = [scanClientConfig("desktop", desk), scanClientConfig("code", code)];
    // what is said: never the word, only that a command line is there
    for (const n of scans.flatMap((s) => s.notOurs))
      expect(n.target === null || !/[\s=]/u.test(n.target), String(n.target)).toBe(true);
    const r = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), scans, null);
    expect(r.details).toContain(
      "code (user scope): an entry launches a command line doctor does not print, and doctor cannot tell what it launches (it is a shell command line, which doctor does not parse) — not counted as this server",
    );
    expect(r.details).toContain(
      "code (user scope): the `espn-fantasy-football` key launches a command line doctor does not print, and doctor cannot tell what it launches (its command line names no dist/cli.js, scripts/eff-launch.sh or this package's `eff`) — not counted as this server",
    );
    const env = { ESPN_LEAGUE_ID: "0", EFF_CREDENTIAL_STORE: "file" };
    const asJson = makeIo(sb, { exec: shimOk, env });
    await main(["doctor", "--json", "--client-config", desk], asJson);
    const asText = makeIo(sb, { exec: shimOk, env });
    await main(["doctor", "--client-config", desk], asText);
    const steps = manualSteps(sb.home, [], { scans, plugin: null }).join("\n");
    expect(steps).toContain("launches a command line uninstall does not print");
    const rowText = [...r.details, r.message, r.fix ?? ""].join("\n");
    for (const [label, out] of [
      ["row 2", rowText],
      ["--json", asJson.out.text],
      ["text", asText.out.text],
      ["uninstall", steps],
    ] as const) {
      expect(out, label).not.toContain(s2.slice(0, 24));
      expect(out.toUpperCase(), label).not.toContain(guid);
      expect(out, label).not.toContain(token);
      expect(out, label).not.toMatch(/(?:ESPN_S2|SWID|API_TOKEN)=(?!\[redacted)/u);
    }
  });

  it("`eff` counts as this package's program only in program position — `--directory eff`, `--profile eff` and `tools/eff` as arguments are not this server, not counted, never removed, never run (R-P2)", async () => {
    sb = sandbox();
    const other = path.join(sb.home, "Developer", "other-mcp", "bin", "server");
    write(other, "#!/bin/sh\n");
    chmodSync(other, 0o755);
    const why =
      "its command line names no dist/cli.js, scripts/eff-launch.sh or this package's `eff`";
    for (const spec of [
      { command: "/usr/bin/env", args: ["uv", "--directory", "eff", "run", "server.py"] },
      { command: "/usr/bin/env", args: ["uv", "--directory", "tools/eff", "run", "server.py"] },
      { command: other, args: ["--profile", "eff"] },
      { command: other, args: ["tools/eff"] },
    ]) {
      const label = JSON.stringify(spec);
      const code = claudeJson(sb.home, { "espn-fantasy-football": spec });
      const scan = scanClientConfig("code", code);
      expect(scan.entries, label).toEqual([]);
      expect(
        scan.notOurs.map((n) => [n.kind, n.ownKey, n.target, n.why]),
        label,
      ).toEqual([["undetermined", true, spec.command, why]]);
      const ex = fakeExec(() => ({ stdout: "v24.21.0\n" }));
      const r = await checkLaunchConfig(makeIo(sb, { exec: ex.exec }), [scan], null);
      // it was: fail "a client launches the server with a bad path…", `<server> --version` run
      expect(r.status, label).toBe("warn");
      expect(r.message, label).toBe("no client is configured to launch this server");
      expect(
        ex.calls.filter((c) => c.file === other),
        label,
      ).toEqual([]);
      const steps = manualSteps(sb.home, [], { scans: [scan], plugin: null }).join("\n");
      expect(steps, label).not.toContain("claude mcp remove --scope user espn-fantasy-football");
    }
    // in program position `eff` still counts: after env, as node's script, a relative command
    const folder = espnCopy(path.join(sb.home, "src", "espn-fantasy-football-mcp"));
    const bin = path.join(sb.dir, "bin");
    mkdirSync(bin);
    symlinkSync(path.join(folder, "dist", "cli.js"), path.join(bin, "eff"));
    const scan = scanClientConfig(
      "code",
      claudeJson(sb.home, {
        "espn-env": {
          command: "/usr/bin/env",
          args: ["-i", "HOME=/x", path.join(bin, "eff"), "serve"],
        },
        "espn-node": {
          command: process.execPath,
          args: ["--no-warnings", path.join(bin, "eff"), "serve"],
        },
        "espn-fantasy-football": { command: "tools/eff", args: ["serve"] },
      }),
    );
    expect(scan.entries.map((e) => e.name)).toEqual([
      "espn-env",
      "espn-node",
      "espn-fantasy-football",
    ]);
  });

  it("`npx espn-fantasy-football-mcp` names this package: ours under any key — never the sibling's, never undetermined — and diagnosed without running npx (R-P6)", async () => {
    sb = sandbox();
    installPlugin(sb.home, folderMarketplace(sb.home));
    const npx = path.join(sb.dir, "bin", "npx");
    write(npx, "#!/bin/sh\n");
    chmodSync(npx, 0o755);
    const byName = { command: "npx", args: ["-y", "espn-fantasy-football-mcp", "serve"] };
    for (const key of ["fantasy-football", "espn", "espn-fantasy-football"])
      expect(classifyEntry(key, byName).owner, key).toBe("ours");
    // the package named as another program's argument is not this server
    expect(
      classifyEntry("espn-label", {
        command: "/opt/tool",
        args: ["--label", "espn-fantasy-football-mcp"],
      }).owner,
    ).toBe("other");
    const code = claudeJson(sb.home, {
      "fantasy-football": byName,
      "espn-abs": { command: npx, args: ["--yes", "espn-fantasy-football-mcp@0.0.0", "serve"] },
    });
    const scan = scanClientConfig("code", code);
    expect(scan.siblingInstalled).toBe(false);
    expect(scan.entries.map((e) => e.name)).toEqual(["fantasy-football", "espn-abs"]);
    const ex = fakeExec(() => ({ stdout: '{"node":"24.21.0","exec_path":"/n/bin/node"}\n' }));
    const r = await checkLaunchConfig(makeIo(sb, { exec: ex.exec }), [scan], scanPlugin(sb.home));
    const text = r.details.join("\n");
    // it was: "the sibling's `fantasy-football` server is also installed (fine)", no duplicate
    expect(text).not.toContain("the sibling's");
    expect(r.status).toBe("fail");
    expect(r.message).toBe("a client launches the server with a bad path, Node or location");
    expect(text).toContain(
      "code (user scope): it runs this package by name (npx, npm exec) — doctor cannot tell which install or version that starts: use `eff print-config`'s entry",
    );
    expect(r.fix).toContain("`claude mcp remove --scope user fantasy-football`");
    expect(r.fix).toContain("`claude mcp remove --scope user espn-abs`");
    expect(ex.calls.filter((c) => c.file === npx)).toEqual([]);
  });
});

describe("Refix round 1: Claude Code 2.1.308's own dedupe and project-scope rules (R-P4, R-P5a, R-P5b, R-T1)", () => {
  it("a `claude mcp add` entry running the plugin's own command line: Claude Code drops the plugin's server, so they are one server, not two (R-P4)", async () => {
    sb = sandbox();
    const { folder } = installPlugin(sb.home, folderMarketplace(sb.home));
    const shim = path.join(folder, "scripts", "eff-launch.sh");
    const same = { command: "/bin/sh", args: [shim, "serve"], env: { ESPN_LEAGUE_ID: "0" } };
    const io = makeIo(sb, { exec: shimOk });
    const one = await checkLaunchConfig(
      io,
      [scanClientConfig("code", claudeJson(sb.home, { "espn-fantasy-football": same }))],
      scanPlugin(sb.home),
    );
    // it was: warn "Claude Code registers this server twice: the plugin AND a `claude mcp add` entry"
    expect(one.status).toBe("ok");
    expect(one.message).not.toContain("twice");
    expect(one.details).toContain(
      `code (user scope): runs the plugin's own command line (/bin/sh ${shim} serve) — Claude Code drops the plugin's server as a duplicate of it, so they are one server`,
    );
    // in one project directory only: the plugin is dropped there, and still runs everywhere else
    const work = path.join(sb.home, "work");
    const local = await checkLaunchConfig(
      io,
      [scanClientConfig("code", claudeJson(sb.home, {}, { [work]: { "espn-w": same } }))],
      scanPlugin(sb.home),
    );
    expect(local.status).toBe("ok");
    // another command line (one more argument) is a second server, as before
    const other = await checkLaunchConfig(
      io,
      [
        scanClientConfig(
          "code",
          claudeJson(sb.home, {
            "espn-fantasy-football": { command: "/bin/sh", args: [shim, "serve", "--quiet"] },
          }),
        ),
      ],
      scanPlugin(sb.home),
    );
    expect(other.message).toContain("registers this server twice");
  });

  it("a project server the user declined (`disabledMcpjsonServers`) is never started: said, its env still scanned, never counted or offered for removal (R-P5a)", async () => {
    for (const where of ["local", "project", "user"] as const) {
      sb = sandbox();
      const one = espnCopy(path.join(sb.home, "src", "espn-fantasy-football-mcp"));
      const c1 = path.join(one, "dist", "cli.js");
      const a = path.join(sb.home, "a");
      write(path.join(a, ".mcp.json"), {
        mcpServers: { "espn-p": { ...launch(c1), env: { ESPN_S2: "x" } } },
      });
      const settings =
        where === "local"
          ? path.join(a, ".claude", "settings.local.json")
          : where === "project"
            ? path.join(a, ".claude", "settings.json")
            : path.join(sb.home, ".claude", "settings.json");
      write(settings, { disabledMcpjsonServers: ["espn-p"] });
      const scan = scanClientConfig(
        "code",
        claudeJson(sb.home, {}, { [a]: { "espn-a": launch(c1) } }),
      );
      const r = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [scan]);
      // it was: warn "registers this server twice … two `claude mcp add` entries", fix removing espn-p
      expect(r.status, where).toBe("ok");
      expect(r.fix, where).toBeNull();
      expect(r.details, where).toContain(
        `code (project scope, ${path.join(a, ".mcp.json")}): declined in Claude Code's settings (\`disabledMcpjsonServers\`) — Claude Code does not start it, so it is not counted`,
      );
      expect(r.message, where).toBe("1 client registration with absolute, existing paths");
      // row 3 still reads its env
      expect(checkClientSecrecy([scan]).details.join("\n"), where).toContain(
        `code (project scope, ${path.join(a, ".mcp.json")}): an env key named like an ESPN cookie`,
      );
      sb.cleanup();
    }
    sb = sandbox();
  });

  it("an ancestor directory's .mcp.json is in every session below it: a duplicate there is caught, its env scanned, and the fix keeps the wider entry (R-P5b)", async () => {
    sb = sandbox();
    const one = espnCopy(path.join(sb.home, "src", "espn-fantasy-football-mcp"));
    const c1 = path.join(one, "dist", "cli.js");
    const work = path.join(sb.home, "work");
    write(path.join(sb.home, ".mcp.json"), {
      mcpServers: { "espn-p": { ...launch(c1), env: { SWID: "x" } } },
    });
    const scan = scanClientConfig(
      "code",
      claudeJson(sb.home, {}, { [work]: { "espn-a": launch(c1) } }),
    );
    expect(scan.entries.map((e) => [e.name, e.scope, e.dir])).toEqual([
      ["espn-a", "local", work],
      ["espn-p", "project", sb.home],
    ]);
    expect(duplicateRegistrations(scan.entries, scan.sessions).most).toBe(2);
    const r = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [scan]);
    // it was: ok "1 client registration…", fix null, while every session in ~/work ran two servers
    expect(r.status).toBe("warn");
    expect(r.message).toBe(
      "Claude Code registers this server twice: two `claude mcp add` entries under different keys — two servers, every tool listed twice",
    );
    // ~/.mcp.json reaches every session under ~: the entry kept; the local one in ~/work goes
    expect(r.fix).toBe(
      `keep one: remove the other entry (\`cd ${work} && claude mcp remove --scope local espn-a\`); then restart the client`,
    );
    expect(checkClientSecrecy([scan]).details).toContain(
      `code (project scope, ${path.join(sb.home, ".mcp.json")}): an env key named like an ESPN cookie`,
    );
    // an ancestor's entry removed from its own directory
    write(path.join(work, ".mcp.json"), { mcpServers: { "espn-w": launch(c1) } });
    const three = scanClientConfig("code", claudeJson(sb.home, {}, { [work]: {} }));
    const r3 = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [three]);
    expect(r3.fix).toBe(
      `keep one: remove the other entry (\`cd ${work} && claude mcp remove --scope project espn-w\`); then restart the client`,
    );
  });

  it("the entry kept is the user scope's `espn-fantasy-football` even when it is not the first key, and in a project directory its `espn-fantasy-football` (R-T1)", async () => {
    sb = sandbox();
    const one = espnCopy(path.join(sb.home, "src", "espn-fantasy-football-mcp"));
    const c1 = path.join(one, "dist", "cli.js");
    const user = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [
      scanClientConfig(
        "code",
        claudeJson(sb.home, { "espn-release": launch(c1), "espn-fantasy-football": launch(c1) }),
      ),
    ]);
    expect(user.fix).toBe(
      "keep one: remove the other entry (`claude mcp remove --scope user espn-release`); then restart the client",
    );
    const a = path.join(sb.home, "a");
    write(path.join(a, ".mcp.json"), { mcpServers: { "espn-fantasy-football": launch(c1) } });
    const dir = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [
      scanClientConfig("code", claudeJson(sb.home, {}, { [a]: { "espn-x": launch(c1) } })),
    ]);
    expect(dir.fix).toBe(
      `keep one: remove the other entry (\`cd ${a} && claude mcp remove --scope local espn-x\`); then restart the client`,
    );
  });
});

describe("Refix round 1: the plugin as Claude Code 2.1.308 loads it (F1, F2, F3)", () => {
  const settingsOf = (home: string): string => path.join(home, ".claude", "settings.json");
  const knownOf = (home: string): string =>
    path.join(home, ".claude", "plugins", "known_marketplaces.json");
  /** The user settings: the plugin enabled, and `declared` under extraKnownMarketplaces. */
  const declare = (home: string, declared: unknown): void => {
    write(settingsOf(home), {
      enabledPlugins: { [PLUGIN_ID]: true },
      extraKnownMarketplaces: { [MARKETPLACE]: declared },
    });
  };

  it("known_marketplaces.json not JSON, or with no usable record, and no declaration: Claude Code loads nothing — row 2 fails with the re-add, row 24 never judges the cache copy (F1a)", async () => {
    for (const record of [
      null,
      "{ not json",
      { "other-market": recorded({ source: "github", repo: "x/y" }) },
      { [MARKETPLACE]: { source: 7 } },
    ]) {
      sb = sandbox();
      const label = JSON.stringify(record);
      const { folder, cache } = installPlugin(sb.home, null);
      const known = knownOf(sb.home);
      if (record !== null) write(known, record);
      const plugin = scanPlugin(sb.home);
      // these cases were "unknown" and judged by the cache copy (Defect B's first model): Claude
      // Code 2.1.308 never runs that copy for them — it loads nothing
      const unreadable = typeof record === "string" || (record !== null && MARKETPLACE in record);
      expect(plugin?.origin.kind, label).toBe("unloaded");
      expect(plugin?.copies[0]?.root, label).toBeNull();
      // it was: row 24 failed on the cache copy, row 2 ok "the plugin registers the server (<cache>)"
      const r24 = checkStaleBuild(folder, plugin);
      expect(r24.status, label).toBe("ok");
      expect(r24.details.join("\n"), label).not.toContain(`plugin copy ${cache}`);
      expect(r24.details, label).toContain(
        `the cache copy ${cache} is not judged: Claude Code cannot load the plugin (row 2)`,
      );
      const r2 = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [], plugin);
      expect(r2.status, label).toBe("fail");
      expect(r2.message, label).toBe(
        unreadable
          ? "Claude Code cannot load the plugin: it cannot read known_marketplaces.json"
          : "Claude Code cannot load the plugin: its marketplace is not known to it",
      );
      expect(r2.details.join("\n"), label).not.toContain("the plugin registers the server");
      expect(r2.details.join("\n"), label).toContain("code: Claude Code cannot load the plugin — ");
      expect(r2.fix, label).toContain("`claude plugin marketplace add <the runtime clone>`");
      sb.cleanup();
    }
    // another marketplace's record with no usable source fails the whole file: nothing loads
    sb = sandbox();
    installPlugin(sb.home, folderMarketplace(sb.home));
    write(knownOf(sb.home), {
      [MARKETPLACE]: folderMarketplace(sb.home),
      "other-market": { installLocation: "/x" },
    });
    expect(scanPlugin(sb.home)?.origin).toEqual({
      kind: "unloaded",
      registry: "unreadable",
      why: `${knownOf(sb.home)} records a marketplace with no usable source, which fails its schema: Claude Code loads no marketplace plugin while it cannot read it`,
    });
  });

  it("no record, but the user settings declare the folder (extraKnownMarketplaces, as on the owner's Mac): read in place, the cache copy a leftover; a symlinked file is doctor's own refusal (F1b)", async () => {
    for (const record of [null, { "other-market": recorded({ source: "github", repo: "x/y" }) }]) {
      sb = sandbox();
      const label = JSON.stringify(record);
      const { folder, cache } = installPlugin(sb.home, null);
      if (record !== null) write(knownOf(sb.home), record);
      declare(sb.home, { source: { source: "directory", path: folder } });
      const plugin = scanPlugin(sb.home);
      expect(plugin?.origin, label).toEqual({
        kind: "folder",
        root: folder,
        marketplaceDir: folder,
        declared: true,
      });
      // it was: row 24 FAIL "1 plugin copy is older than this clone", the uninstall/reinstall fix
      const r24 = checkStaleBuild(folder, plugin);
      expect(r24.status, label).toBe("ok");
      expect(r24.details.join("\n"), label).toContain(`does not run the cache copy ${cache}`);
      const r2 = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [], plugin);
      expect(r2.status, label).toBe("ok");
      expect(r2.details, label).toContain(
        `code: the ${MARKETPLACE} marketplace is declared in ${settingsOf(sb.home)} (extraKnownMarketplaces), not recorded in known_marketplaces.json: Claude Code reads its folder in place all the same`,
      );
      sb.cleanup();
    }
    // a declaration Claude Code does not load before recording it: nothing loads
    for (const [declared, why] of [
      [{ source: { source: "github", repo: "x/y" } }, "a source Claude Code fetches"],
      [{ source: { source: "directory", path: "src/x" } }, "no absolute path"],
    ] as const) {
      sb = sandbox();
      installPlugin(sb.home, null);
      declare(sb.home, declared);
      const o = scanPlugin(sb.home)?.origin;
      expect(o?.kind, why).toBe("unloaded");
      expect(o !== undefined && "why" in o ? o.why : "", why).toContain(why);
      sb.cleanup();
    }
    // known_marketplaces.json through a symbolic link: Claude Code follows it, doctor does not
    sb = sandbox();
    const { folder, cache } = installPlugin(sb.home, null);
    const real = path.join(sb.dir, "known.json");
    write(real, { [MARKETPLACE]: folderMarketplace(sb.home) });
    symlinkSync(real, knownOf(sb.home));
    const plugin = scanPlugin(sb.home);
    expect(plugin?.origin.kind).toBe("refused");
    const r24 = checkStaleBuild(folder, plugin);
    expect(r24.status).toBe("ok");
    expect(r24.details.join("\n")).not.toContain(`plugin copy ${cache}`);
    const linked = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [], plugin);
    expect(linked.status).toBe("warn");
    // V-A: what doctor cannot judge is the registry, not a folder marketplace's listing
    expect(linked.message).toBe(
      "doctor cannot tell what Claude Code runs for the plugin: it cannot judge known_marketplaces.json",
    );
  });

  it("an enabled plugin a folder marketplace lists, with no install record: Claude Code loads it — doctor counts it, catches the duplicate, and print-config warns (F2)", async () => {
    sb = sandbox({ create: true });
    const { folder } = installPlugin(sb.home, folderMarketplace(sb.home));
    rmSync(installedPluginsPathOf(sb.home));
    const plugin = scanPlugin(sb.home);
    // it was: null — "no client is configured to launch this server", the reinstall pointer
    expect(plugin?.copies).toEqual([
      { scope: "user", root: folder, installPath: null, version: null },
    ]);
    const alone = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [], plugin);
    expect(alone.status).toBe("ok");
    expect(alone.details).toContain(
      `code: the plugin registers the server (user scope, ${folder}, read in place from its folder marketplace)`,
    );
    expect(alone.details).toContain(
      `code: installed_plugins.json has no record of the plugin: Claude Code reads it in place from its folder (${folder}) without one`,
    );
    const code = claudeJson(sb.home, {
      "espn-fantasy-football": launch(path.join(folder, "dist", "cli.js")),
    });
    const dup = await checkLaunchConfig(
      makeIo(sb, { exec: shimOk }),
      [scanClientConfig("code", code)],
      plugin,
    );
    expect(dup.message).toContain("registers this server twice");
    const pc = makeIo(sb, { packageRoot: fakePackage(sb), env: { ESPN_LEAGUE_ID: "0" } });
    expect(await main(["print-config", "--client", "code"], pc)).toBe(0);
    expect(pc.err.text).toContain("lists every tool twice");
    expect(manualSteps(sb.home, [], findRegistrations(sb.home)).join("\n")).toContain(
      `It is installed here (${folder}, read in place from its folder marketplace).`,
    );
    // enabled, no record, and a marketplace Claude Code does not know: an orphan it skips
    rmSync(knownOf(sb.home));
    expect(scanPlugin(sb.home)).toBeNull();
  });

  it("print-config's duplicate warning only for a plugin Claude Code loads; one it cannot load is said as such (F3)", async () => {
    sb = sandbox({ create: true });
    const { folder } = installPlugin(sb.home, folderMarketplace(sb.home));
    rmSync(path.join(folder, ".claude-plugin", "marketplace.json"));
    const pc = makeIo(sb, { packageRoot: fakePackage(sb), env: { ESPN_LEAGUE_ID: "0" } });
    expect(await main(["print-config", "--client", "code"], pc)).toBe(0);
    // it was: "it registers this server in Claude Code already. Adding the entry above beside it starts two servers"
    expect(pc.err.text).not.toContain("starts two servers");
    expect(pc.err.text).toContain(
      `eff print-config: warning: the ${PLUGIN_ID} plugin is enabled, but Claude Code cannot load it (\`eff doctor\` row 2 says why): re-add its marketplace, or \`claude plugin uninstall ${PLUGIN_ID}\` before using the entry above — never both.`,
    );
  });
});

// Refix round 2 (verifiers V-A, V-B, V-T, 2026-11-11): known_marketplaces.json read with Claude Code
// 2.1.308's own per-record schema, sessions only where Claude Code records them, a fix that never
// strips a session's only server, and the refix's untested rules pinned — each V-A and V-B case
// failed before its fix.
describe("Refix round 2: Claude Code 2.1.308's marketplace schema, its sessions and the keep rule (V-A, V-B, V-T)", () => {
  const knownOf = (home: string): string =>
    path.join(home, ".claude", "plugins", "known_marketplaces.json");
  const withOther =
    (other: unknown) =>
    (home: string): Record<string, unknown> => ({
      [MARKETPLACE]: folderMarketplace(home),
      "other-market": other,
    });
  const oursWithout =
    (field: string) =>
    (home: string): Record<string, unknown> => {
      const ours = Object.fromEntries(
        Object.entries(folderMarketplace(home)).filter(([k]) => k !== field),
      );
      return { [MARKETPLACE]: ours, "other-market": recorded({ source: "github", repo: "x/y" }) };
    };

  it("a record no Claude Code reads (not an object, no source object with a string type) makes known_marketplaces.json unreadable: nothing loads — row 2 fails, no copy is judged, uninstall says why (V-A, D-1)", async () => {
    const cases: [string, (home: string) => Record<string, unknown>, string][] = [
      [
        "a record that is not an object",
        withOther(7),
        "records a marketplace that is not an object",
      ],
      [
        "a record with no source",
        withOther({ installLocation: "/x", lastUpdated: INSTALLED_AT }),
        "records a marketplace with no usable source",
      ],
      [
        "a source that is a string",
        withOther(recorded("github")),
        "records a marketplace with no usable source",
      ],
      [
        "a source object with no type",
        withOther(recorded({})),
        "records a marketplace with no usable source",
      ],
      [
        "a source type that is a number",
        withOther(recorded({ source: 7 })),
        "records a marketplace with no usable source",
      ],
      [
        "our own record with no usable source",
        (home) => ({ [MARKETPLACE]: recorded({ path: path.join(home, "src") }) }),
        `records the ${MARKETPLACE} marketplace with no usable source`,
      ],
    ];
    for (const [label, known, why] of cases) {
      sb = sandbox();
      const { folder, cache } = installPlugin(sb.home, null);
      write(knownOf(sb.home), known(sb.home));
      const plugin = scanPlugin(sb.home);
      // it was: "folder" — row 2 ok "1 client registration…", row 24 ok — while no Claude Code
      // ("Marketplace configuration file is corrupted") loads any marketplace plugin then
      expect(plugin?.origin, label).toEqual({
        kind: "unloaded",
        registry: "unreadable",
        why: `${knownOf(sb.home)} ${why}, which fails its schema: Claude Code loads no marketplace plugin while it cannot read it`,
      });
      const o = plugin?.origin;
      const said = o !== undefined && "why" in o ? o.why : "";
      expect(plugin?.copies[0]?.root, label).toBeNull();
      const r2 = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [], plugin);
      expect(r2.status, label).toBe("fail");
      expect(r2.message, label).toBe(
        "Claude Code cannot load the plugin: it cannot read known_marketplaces.json",
      );
      expect(r2.fix, label).toContain(
        "repair or move aside ~/.claude/plugins/known_marketplaces.json",
      );
      expect(r2.details.join("\n"), label).not.toContain("the plugin registers the server");
      const r24 = checkStaleBuild(folder, plugin);
      expect(r24.status, label).toBe("ok");
      expect(r24.details, label).toContain(
        `the cache copy ${cache} is not judged: Claude Code cannot load the plugin (row 2)`,
      );
      expect(manualSteps(sb.home, [], findRegistrations(sb.home)).join("\n"), label).toContain(
        `Claude Code cannot load it — ${said}`,
      );
      sb.cleanup();
    }
    sb = sandbox();
  });

  it("a record only Claude Code 2.1.308's field-level schema refuses: another client may read the file — refused registry, row 2 warns naming the field (never a value) with `claude plugin list` and the repair, no copy judged, uninstall says doctor cannot tell (D-1, MK-2, F3, MK-3, MK-4)", async () => {
    const value = "no-scheme-value";
    const remote = { source: "github", repo: "x/p" };
    const github = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      ...recorded({ source: "github", repo: "x/y" }),
      ...extra,
    });
    const cases: [string, (home: string) => Record<string, unknown>, string][] = [
      [
        "our record without installLocation",
        oursWithout("installLocation"),
        `records the ${MARKETPLACE} marketplace with no installLocation`,
      ],
      [
        "our record without lastUpdated",
        oursWithout("lastUpdated"),
        `records the ${MARKETPLACE} marketplace with no lastUpdated`,
      ],
      [
        "another record without installLocation or lastUpdated",
        withOther({ source: { source: "github", repo: "x/y" } }),
        "records a marketplace with no installLocation",
      ],
      [
        "a null installLocation",
        withOther(github({ installLocation: null })),
        "records a marketplace with no installLocation",
      ],
      [
        "a null lastUpdated",
        withOther(github({ lastUpdated: null })),
        "records a marketplace with no lastUpdated",
      ],
      [
        "an autoUpdate that is not true or false",
        withOther(github({ autoUpdate: value })),
        "records a marketplace whose autoUpdate is not true or false",
      ],
      [
        "a null autoUpdate",
        withOther(github({ autoUpdate: null })),
        "records a marketplace whose autoUpdate is not true or false",
      ],
      [
        "a github source with no repo",
        withOther(recorded({ source: "github" })),
        "records a marketplace whose github source has no repo",
      ],
      [
        "a directory source with no path",
        withOther(recorded({ source: "directory" })),
        "records a marketplace whose directory source has no path",
      ],
      [
        "a file source with no path",
        withOther(recorded({ source: "file", path: 7 })),
        "records a marketplace whose file source has no path",
      ],
      [
        "a git source with no url",
        withOther(recorded({ source: "git" })),
        "records a marketplace whose git source has no url",
      ],
      [
        "a url source with no url",
        withOther(recorded({ source: "url" })),
        "records a marketplace whose url source has no url",
      ],
      [
        "a url source whose url is no URL",
        withOther(recorded({ source: "url", url: value })),
        "records a marketplace whose url source's url is not a URL",
      ],
      [
        "an npm source with no package",
        withOther(recorded({ source: "npm" })),
        "records a marketplace whose npm source has no package",
      ],
      [
        "a hostPattern source with no hostPattern",
        withOther(recorded({ source: "hostPattern" })),
        "records a marketplace whose hostPattern source has no hostPattern",
      ],
      [
        "a pathPattern source with no pathPattern",
        withOther(recorded({ source: "pathPattern", pathPattern: 7 })),
        "records a marketplace whose pathPattern source has no pathPattern",
      ],
      [
        "a settings source with no name",
        withOther(recorded({ source: "settings", plugins: [] })),
        "records a marketplace whose settings source has no name",
      ],
      [
        "a settings source with no plugins",
        withOther(recorded({ source: "settings", name: "other-market" })),
        "records a marketplace whose settings source lists no plugins",
      ],
      ...(
        [
          ["an empty plugin entry", {}],
          ["a plugin entry that is not an object", value],
          ["a plugin entry with no name", { source: remote }],
          ["a plugin entry with an empty name", { name: "", source: remote }],
          ["a plugin entry with no source", { name: value }],
          ["a plugin entry whose source has no type", { name: value, source: {} }],
          ["a plugin entry whose source type is a number", { name: value, source: { source: 7 } }],
          // 2.1.308 refines a settings plugin's source: remote only, never the parse placeholder
          ["a plugin entry with a relative path source", { name: value, source: "./p" }],
          [
            "a plugin entry with the placeholder source",
            { name: value, source: { source: "unsupported" } },
          ],
        ] as const
      ).map(([label, item]): [string, (home: string) => Record<string, unknown>, string] => [
        `a settings source listing ${label}`,
        withOther(recorded({ source: "settings", name: "other-market", plugins: [item] })),
        "records a marketplace whose settings source lists a plugin with no name or no remote source",
      ]),
    ];
    for (const [label, known, what] of cases) {
      sb = sandbox();
      const { folder, cache } = installPlugin(sb.home, null);
      write(knownOf(sb.home), known(sb.home));
      const plugin = scanPlugin(sb.home);
      const why = `${knownOf(sb.home)} ${what}: Claude Code 2.1.308 refuses such a file and then loads no marketplace plugin, and another client version may read it`;
      // it was: "unloaded" / "unreadable" — row 2 FAILED "cannot read known_marketplaces.json" and
      // told the owner to move the file aside, for a record a newer client may read (D-1)
      expect(plugin?.origin, label).toEqual({ kind: "refused", why, registry: true });
      expect(plugin?.copies[0]?.root, label).toBeNull();
      const r2 = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [], plugin);
      expect(r2.status, label).toBe("warn");
      expect(r2.message, label).toBe(
        "doctor cannot tell what Claude Code runs for the plugin: it cannot judge known_marketplaces.json",
      );
      expect(r2.fix, label).toBe(
        'see whether Claude Code loads the plugin with `claude plugin list` (its "Read from" line); if it does not, repair the record of ~/.claude/plugins/known_marketplaces.json that row 2\'s detail names first — until then Claude Code 2.1.308 also refuses `claude plugin marketplace add` — and if it still does not load, add the marketplace again from the built runtime clone (`claude plugin marketplace add <the runtime clone>`, README step 5); then restart the client',
      );
      const text = [r2.message, r2.fix ?? "", ...r2.details].join("\n");
      expect(r2.details, label).toContain(
        `code: doctor cannot tell what Claude Code runs for the plugin — ${why}`,
      );
      expect(text, label).not.toContain(value);
      expect(text, label).not.toContain("the plugin registers the server");
      expect(text, label).not.toContain("move aside");
      // row 24 judges nothing: from a current clone ok without the copy, from a package a skip
      const r24 = checkStaleBuild(folder, plugin);
      expect(r24.status, label).toBe("ok");
      expect(r24.details, label).toContain(
        `the cache copy ${cache} is not judged: doctor cannot tell what Claude Code runs for the plugin (row 2)`,
      );
      const pkg = checkStaleBuild(sb.dir, plugin);
      expect(pkg.status, label).toBe("skip");
      expect(pkg.message, label).toBe(
        "no plugin build to judge: doctor cannot tell what Claude Code runs for the plugin (row 2)",
      );
      const steps = manualSteps(sb.home, [], findRegistrations(sb.home)).join("\n");
      expect(steps, label).toContain(`doctor cannot tell what Claude Code runs for it — ${why}`);
      expect(steps, label).not.toContain(value);
      sb.cleanup();
    }
    sb = sandbox();
  });

  it("a record no client reads wins over one only 2.1.308 refuses and over an unknown source type, in either order: row 2 fails (D-1, MK-3)", () => {
    const structural = recorded({});
    for (const [label, other] of [
      ["an unknown source type", recorded({ source: "carrier-pigeon" })],
      ["a field-level refusal", recorded({ source: "github" })],
    ] as const)
      for (const first of [true, false]) {
        sb = sandbox();
        installPlugin(sb.home, null);
        const pair: [string, unknown][] = [
          ["a-structural", structural],
          ["b-other", other],
        ];
        write(
          knownOf(sb.home),
          Object.fromEntries([
            [MARKETPLACE, folderMarketplace(sb.home)],
            ...(first ? pair : pair.reverse()),
          ]),
        );
        const o = scanPlugin(sb.home)?.origin;
        expect(o?.kind, `${label} ${String(first)}`).toBe("unloaded");
        expect(o !== undefined && "registry" in o ? o.registry : null).toBe("unreadable");
        sb.cleanup();
      }
    sb = sandbox();
  });

  it("a source type Claude Code 2.1.308 does not have: doctor cannot tell whether this client reads the file — refused, row 2 warns, no copy judged, the type named only as a plain word (V-A)", async () => {
    for (const [type, named, ours] of [
      ["carrier-pigeon", true, false],
      ["Some Thing!", false, false],
      ["carrier-pigeon", true, true],
      // an own-property lookup: a type named like an Object.prototype member is still unknown (MK-3)
      ["constructor", true, false],
    ] as const) {
      sb = sandbox();
      const label = `${type} ${ours ? "(ours)" : "(another)"}`;
      const { folder, cache } = installPlugin(sb.home, null);
      write(
        knownOf(sb.home),
        ours
          ? { [MARKETPLACE]: recorded({ source: type }) }
          : withOther(recorded({ source: type }))(sb.home),
      );
      const plugin = scanPlugin(sb.home);
      expect(plugin?.origin.kind, label).toBe("refused");
      expect(plugin?.copies[0]?.root, label).toBeNull();
      const r2 = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [], plugin);
      expect(r2.status, label).toBe("warn");
      expect(r2.message, label).toBe(
        "doctor cannot tell what Claude Code runs for the plugin: it cannot judge known_marketplaces.json",
      );
      const text = r2.details.join("\n");
      expect(text, label).toContain(
        `code: doctor cannot tell what Claude Code runs for the plugin — ${knownOf(sb.home)} records ${ours ? `the ${MARKETPLACE} marketplace` : "a marketplace"} with a source type doctor does not know${named ? ` (${type})` : ""}: Claude Code 2.1.308 refuses such a file, and a newer client may read it`,
      );
      expect(text, label).not.toContain("Some Thing");
      expect(text, label).not.toContain("the plugin registers the server");
      const r24 = checkStaleBuild(folder, plugin);
      expect(r24.status, label).toBe("ok");
      expect(r24.details, label).toContain(
        `the cache copy ${cache} is not judged: doctor cannot tell what Claude Code runs for the plugin (row 2)`,
      );
      expect(manualSteps(sb.home, [], findRegistrations(sb.home)).join("\n"), label).toContain(
        "doctor cannot tell what Claude Code runs for it — ",
      );
      sb.cleanup();
    }
    sb = sandbox();
  });

  it("every source type of Claude Code 2.1.308, each with the field it requires, reads: the folder is read in place (V-A)", () => {
    sb = sandbox();
    const { folder } = installPlugin(sb.home, null);
    write(knownOf(sb.home), {
      [MARKETPLACE]: folderMarketplace(sb.home),
      a: recorded({ source: "github", repo: "x/y", ref: "main" }),
      b: recorded({ source: "git", url: "https://example.invalid/m.git" }),
      c: recorded({ source: "url", url: "\u00a0https://example.invalid/marketplace.json\n" }),
      d: recorded({ source: "npm", package: "@example/marketplace" }),
      e: recorded({ source: "file", path: "/placeholder/.claude-plugin/marketplace.json" }),
      f: recorded({ source: "directory", path: "/placeholder" }),
      g: recorded({ source: "skills-dir" }),
      h: recorded({ source: "hostPattern", hostPattern: "^example\\.invalid$" }),
      i: recorded({ source: "pathPattern", pathPattern: ".*" }),
      j: recorded({ source: "settings", name: "j", plugins: [] }),
      l: recorded({
        source: "settings",
        name: "l",
        plugins: [{ name: "p", source: { source: "github", repo: "x/p" } }],
      }),
      k: { ...recorded({ source: "github", repo: "x/z" }), autoUpdate: false },
    });
    expect(scanPlugin(sb.home)?.origin).toEqual({
      kind: "folder",
      root: folder,
      marketplaceDir: folder,
    });
  });

  it("known_marketplaces.json that is an array, null or a number is unreadable, never an empty registry (V-T)", () => {
    for (const body of ["[]", "null", "7"]) {
      sb = sandbox();
      installPlugin(sb.home, body);
      expect(scanPlugin(sb.home)?.origin, body).toEqual({
        kind: "unloaded",
        registry: "unreadable",
        why: `${knownOf(sb.home)} is not a JSON object: Claude Code loads no marketplace plugin while it cannot read it`,
      });
      sb.cleanup();
    }
    sb = sandbox();
  });

  it("a declared `file` source outside a .claude-plugin folder is not loaded before it is recorded (V-T)", () => {
    sb = sandbox();
    const { folder } = installPlugin(sb.home, null);
    write(path.join(sb.home, ".claude", "settings.json"), {
      enabledPlugins: { [PLUGIN_ID]: true },
      extraKnownMarketplaces: {
        [MARKETPLACE]: { source: { source: "file", path: path.join(folder, "marketplace.json") } },
      },
    });
    const o = scanPlugin(sb.home)?.origin;
    expect(o?.kind).toBe("unloaded");
    expect(o !== undefined && "why" in o ? o.why : "").toContain(
      "with a file that is not in a .claude-plugin folder: Claude Code loads none of its plugins until it is recorded",
    );
  });

  it("a parent directory's .mcp.json is no session of its own: its entry, declined in every project below it, is never counted, never offered for removal but as optional (V-B, V-T)", async () => {
    sb = sandbox();
    const one = espnCopy(path.join(sb.home, "src", "espn-fantasy-football-mcp"));
    const c1 = path.join(one, "dist", "cli.js");
    const dev = path.join(sb.home, "Developer");
    const x = path.join(dev, "x");
    write(path.join(dev, ".mcp.json"), { mcpServers: { "espn-dev": launch(c1) } });
    write(path.join(x, ".claude", "settings.local.json"), {
      disabledMcpjsonServers: ["espn-dev"],
    });
    const scan = scanClientConfig(
      "code",
      claudeJson(sb.home, { "espn-fantasy-football": launch(c1) }, { [x]: {} }),
    );
    // it was: sessions [x, ~/Developer] — no session ever opened in ~/Developer (Claude Code records
    // every session's project directory under `projects`), so espn-dev was counted there
    expect(scan.sessions.map((s) => s.dir)).toEqual([x]);
    expect(scan.entries.map((e) => [e.name, e.declined])).toEqual([
      ["espn-fantasy-football", false],
      ["espn-dev", true],
    ]);
    const r = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [scan]);
    // it was: warn "registers this server twice", fix `cd ~/Developer && claude mcp remove … espn-dev`
    expect(r.status).toBe("ok");
    expect(r.fix).toBeNull();
    expect(r.message).toBe("1 client registration with absolute, existing paths");
    expect(r.details).toContain(
      `code (project scope, ${path.join(dev, ".mcp.json")}): declined in Claude Code's settings (\`disabledMcpjsonServers\`) — Claude Code does not start it, so it is not counted`,
    );
    expect(manualSteps(sb.home, [], findRegistrations(sb.home)).join("\n")).toContain(
      `Claude Code (project scope, ${path.join(dev, ".mcp.json")} — a file meant to be committed) registers this server under the key "espn-dev", declined in Claude Code's settings (disabledMcpjsonServers), so never started — removing it is optional: cd ${dev} && claude mcp remove --scope project espn-dev`,
    );
  });

  it("the fix never leaves a session without the server: it keeps an entry whose removal of the others strips no session, and where every removal would, the choice is the user's (V-B)", async () => {
    sb = sandbox();
    const one = espnCopy(path.join(sb.home, "src", "espn-fantasy-football-mcp"));
    const c1 = path.join(one, "dist", "cli.js");
    const a = path.join(sb.home, "a");
    const ax = path.join(a, "x");
    const axz = path.join(ax, "z");
    const ay = path.join(a, "y");
    write(path.join(a, ".mcp.json"), { mcpServers: { "espn-1": launch(c1) } });
    write(path.join(ax, ".mcp.json"), { mcpServers: { "espn-2": launch(c1) } });
    write(path.join(axz, ".claude", "settings.local.json"), { disabledMcpjsonServers: ["espn-1"] });
    const io = makeIo(sb, { exec: shimOk });
    /** After the fix, every session that started a server still starts one. */
    const noneStripped = (d: ReturnType<typeof duplicateRegistrations>): boolean =>
      d.views.every((v) => v.length === 0 || v.some((e) => !d.extra.includes(e)));
    // a/y runs espn-1 alone, a/x/z espn-2 alone (it declines espn-1), and a/x both: any removal
    // strips a/y or a/x/z
    const stuck = scanClientConfig(
      "code",
      claudeJson(sb.home, {}, { [ax]: {}, [axz]: {}, [ay]: {} }),
    );
    const d = duplicateRegistrations(stuck.entries, stuck.sessions);
    expect(d.most).toBe(2);
    // it was: extra [espn-2] — a/x/z, whose only server it is, left with none
    expect(noneStripped(d)).toBe(true);
    expect(d.extra).toEqual([]);
    expect(d.unresolved.map((u) => u.dir)).toEqual([ax]);
    const r = await checkLaunchConfig(io, [stuck]);
    expect(r.status).toBe("warn");
    expect(r.message).toBe(
      "Claude Code registers this server twice: two `claude mcp add` entries under different keys — two servers, every tool listed twice",
    );
    expect(r.fix).toBe(
      `keep one: in ${ax} ("espn-2", "espn-1"), removing any of them leaves another directory with no server — keep one there and turn the others off there (\`/mcp disable <name>\` in a session there; a project server can be declined in ${path.join(ax, ".claude", "settings.local.json")} instead, \`disabledMcpjsonServers\`); then restart the client`,
    );
    // a local-scope entry in a/x as well: still the user's choice there, and it is removed, not declined
    const stuckLocal = scanClientConfig(
      "code",
      claudeJson(sb.home, {}, { [ax]: { "espn-l": launch(c1) }, [axz]: {}, [ay]: {} }),
    );
    expect(duplicateRegistrations(stuckLocal.entries, stuckLocal.sessions).extra).toEqual([]);
    expect((await checkLaunchConfig(io, [stuckLocal])).fix).toBe(
      `keep one: in ${ax} ("espn-l", "espn-2", "espn-1"), removing any of them leaves another directory with no server — keep one there and turn the others off there (\`/mcp disable <name>\` in a session there; a project server can be declined in ${path.join(ax, ".claude", "settings.local.json")} instead, \`disabledMcpjsonServers\`; a local-scope entry is removed instead, with its own \`claude mcp remove --scope local\`); then restart the client`,
    );
    // beside the plugin: removing every entry keeps the plugin; uninstalling it adds this server at
    // user scope first, which every session then starts — so both project entries go (VR4-3: it
    // was the choice in a/x, which left a/y and a/x/z each starting one beside the new entry)
    installPlugin(sb.home, folderMarketplace(sb.home));
    const beside = await checkLaunchConfig(io, [stuck], scanPlugin(sb.home));
    expect(beside.fix).toBe(
      `keep one: remove the \`claude mcp add\` entries (\`cd ${ax} && claude mcp remove --scope project espn-2\`, \`cd ${a} && claude mcp remove --scope project espn-1\`), or uninstall the plugin (\`claude plugin uninstall ${PLUGIN_ID}\`) and remove the other entries (\`cd ${ax} && claude mcp remove --scope project espn-2\`, \`cd ${a} && claude mcp remove --scope project espn-1\`) — only once this server is added at user scope (\`eff print-config --client code\` prints the command): uninstalling it now leaves every session outside the projects Claude Code records with no server; then restart the client`,
    );
    // a/y with an entry of its own: removing espn-1 strips nobody, so that is the fix — never
    // espn-2, whose removal strips a/x/z although espn-1 lives farther up
    const solved = scanClientConfig(
      "code",
      claudeJson(sb.home, {}, { [ax]: {}, [axz]: {}, [ay]: { "espn-y": launch(c1) } }),
    );
    const s = duplicateRegistrations(solved.entries, solved.sessions);
    expect(noneStripped(s)).toBe(true);
    expect(s.extra.map((e) => e.name)).toEqual(["espn-1"]);
    expect(s.unresolved).toEqual([]);
    expect((await checkLaunchConfig(io, [solved])).fix).toBe(
      `keep one: remove the other entry (\`cd ${a} && claude mcp remove --scope project espn-1\`); then restart the client`,
    );
  });

  it("an entry the fix already removes counts as gone: a later choice never strips the session it left (V-B)", () => {
    sb = sandbox();
    const one = espnCopy(path.join(sb.home, "src", "espn-fantasy-football-mcp"));
    const c1 = path.join(one, "dist", "cli.js");
    const a = path.join(sb.home, "a");
    const a1 = path.join(a, "1");
    const a2 = path.join(a, "2");
    const a3 = path.join(a, "3");
    write(path.join(a, ".mcp.json"), {
      mcpServers: {
        "espn-fantasy-football": launch(c1),
        "espn-b": launch(c1),
        "espn-c": launch(c1),
      },
    });
    // a/1 sees espn-fantasy-football and espn-b, a/2 espn-fantasy-football, espn-c and its own
    // espn-d, a/3 espn-b and espn-c
    write(path.join(a1, ".claude", "settings.local.json"), {
      disabledMcpjsonServers: ["espn-c"],
    });
    write(path.join(a2, ".claude", "settings.local.json"), {
      disabledMcpjsonServers: ["espn-b"],
    });
    write(path.join(a3, ".claude", "settings.local.json"), {
      disabledMcpjsonServers: ["espn-fantasy-football"],
    });
    const scan = scanClientConfig(
      "code",
      claudeJson(sb.home, {}, { [a1]: {}, [a2]: { "espn-d": launch(c1) }, [a3]: {} }),
    );
    const d = duplicateRegistrations(scan.entries, scan.sessions);
    // a/1 keeps espn-fantasy-football, so espn-b goes; a/3 then has only espn-c, so a/2 may not drop it
    expect(d.views.every((v) => v.length === 0 || v.some((e) => !d.extra.includes(e)))).toBe(true);
    expect(d.extra.map((e) => e.name)).toEqual(["espn-b"]);
    expect(d.unresolved.map((u) => u.dir)).toEqual([a2]);
  });

  it("among choices that strip no session, the key kept is the one whose entry reaches the most sessions (V-B)", async () => {
    sb = sandbox();
    const one = espnCopy(path.join(sb.home, "src", "espn-fantasy-football-mcp"));
    const c1 = path.join(one, "dist", "cli.js");
    const a = path.join(sb.home, "a");
    const ax = path.join(a, "x");
    const axz = path.join(ax, "z");
    write(path.join(a, ".mcp.json"), { mcpServers: { "espn-y": launch(c1) } });
    write(path.join(ax, ".mcp.json"), { mcpServers: { "espn-x": launch(c1) } });
    write(path.join(axz, ".claude", "settings.local.json"), { disabledMcpjsonServers: ["espn-y"] });
    // espn-x reaches a/x and a/x/z (where a local entry under its key is the same server); espn-y,
    // farther up, only a/x
    const scan = scanClientConfig(
      "code",
      claudeJson(sb.home, {}, { [ax]: {}, [axz]: { "espn-x": launch(c1) } }),
    );
    expect((await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [scan])).fix).toBe(
      `keep one: remove the other entry (\`cd ${a} && claude mcp remove --scope project espn-y\`); then restart the client`,
    );
  });

  it("a project entry declined in one session and not in another below it is counted only where it is not declined (V-T)", async () => {
    sb = sandbox();
    const one = espnCopy(path.join(sb.home, "src", "espn-fantasy-football-mcp"));
    const c1 = path.join(one, "dist", "cli.js");
    const a = path.join(sb.home, "a");
    const ax = path.join(a, "x");
    const ay = path.join(a, "y");
    write(path.join(a, ".mcp.json"), { mcpServers: { "espn-p": launch(c1) } });
    write(path.join(ax, ".mcp.json"), { mcpServers: { "espn-q": launch(c1) } });
    write(path.join(ax, ".claude", "settings.local.json"), { disabledMcpjsonServers: ["espn-p"] });
    const scan = scanClientConfig("code", claudeJson(sb.home, {}, { [ax]: {}, [ay]: {} }));
    expect(scan.entries.map((e) => [e.name, e.declined])).toEqual([
      ["espn-q", false],
      ["espn-p", false],
    ]);
    const d = duplicateRegistrations(scan.entries, scan.sessions);
    expect(d.views.map((v) => v.map((e) => e.name))).toEqual([[], ["espn-q"], ["espn-p"]]);
    const r = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [scan]);
    expect(r.status).toBe("ok");
    expect(r.message).toBe("2 client registrations with absolute, existing paths");
  });

  it("a known project below a copy of this plugin: the copy's .mcp.json, read as a parent directory's, is the plugin's own — no registration, never removed (V-T)", async () => {
    sb = sandbox();
    const repo = espnCopy(path.join(sb.home, "Developer", "espn-fantasy-football-mcp"));
    write(path.join(repo, ".mcp.json"), readFileSync(path.join(ROOT, ".mcp.json"), "utf8"));
    const sub = path.join(repo, "docs");
    mkdirSync(sub, { recursive: true });
    const scan = scanClientConfig("code", claudeJson(sb.home, {}, { [sub]: {} }));
    expect(scan.entries.map((e) => [e.name, e.dir, e.pluginSource])).toEqual([
      ["espn-fantasy-football", repo, true],
    ]);
    const r = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [scan], null);
    expect(r.status).toBe("warn");
    expect(r.message).toBe("no client is configured to launch this server");
    expect(r.details.join("\n")).toContain(
      `code (project scope, ${path.join(repo, ".mcp.json")}): the plugin's own .mcp.json in a copy of this plugin, not a registration`,
    );
    const steps = manualSteps(sb.home, [], { scans: [scan], plugin: null }).join("\n");
    expect(steps).toContain(
      `${path.join(repo, ".mcp.json")} is the plugin's own .mcp.json in a copy of this plugin, not a registration: leave it`,
    );
    expect(steps).not.toContain("claude mcp remove --scope project espn-fantasy-football");
  });

  it("a plugin Claude Code cannot load is no server: beside a `claude mcp add` entry it is never 'twice' (V-T)", async () => {
    sb = sandbox();
    const { folder } = installPlugin(sb.home, null);
    const code = claudeJson(sb.home, {
      "espn-fantasy-football": launch(path.join(folder, "dist", "cli.js")),
    });
    const plugin = scanPlugin(sb.home);
    expect(plugin?.origin.kind).toBe("unloaded");
    const r = await checkLaunchConfig(
      makeIo(sb, { exec: shimOk }),
      [scanClientConfig("code", code)],
      plugin,
    );
    expect(r.status).toBe("fail");
    expect(r.message).toBe(
      "Claude Code cannot load the plugin: its marketplace is not known to it",
    );
    expect(r.fix).not.toContain("keep one");
    expect(r.fix).toContain(
      "— or keep the `claude mcp add` entry instead and `claude plugin uninstall",
    );
  });

  it("an entry running the plugin's command line in one directory drops the plugin there only: beside a user-scope entry it is still 'twice' everywhere else (V-T)", async () => {
    sb = sandbox();
    const { folder } = installPlugin(sb.home, folderMarketplace(sb.home));
    const work = path.join(sb.home, "work");
    const same = {
      command: "/bin/sh",
      args: [path.join(folder, "scripts", "eff-launch.sh"), "serve"],
    };
    const code = claudeJson(
      sb.home,
      { "espn-fantasy-football": launch(path.join(folder, "dist", "cli.js")) },
      { [work]: { "espn-fantasy-football": same } },
    );
    const r = await checkLaunchConfig(
      makeIo(sb, { exec: shimOk }),
      [scanClientConfig("code", code)],
      scanPlugin(sb.home),
    );
    expect(r.status).toBe("warn");
    expect(r.message).toBe(
      "Claude Code registers this server twice: the plugin AND a `claude mcp add` entry — two servers, every tool listed twice",
    );
  });

  it("`npm exec` and `npm x` of this package are this server under any key (V-T)", () => {
    for (const spec of [
      { command: "npm", args: ["exec", "--yes", "espn-fantasy-football-mcp@0.0.0", "serve"] },
      { command: "/usr/local/bin/npm", args: ["x", "espn-fantasy-football-mcp", "serve"] },
    ]) {
      const c = classifyEntry("espn-npm", spec);
      expect(c.owner, JSON.stringify(spec)).toBe("ours");
      expect(c.launch.kind, JSON.stringify(spec)).toBe("named");
    }
    // `npm run` runs a script of the project in the directory: no program of this package
    expect(
      classifyEntry("espn-npm", { command: "npm", args: ["run", "espn-fantasy-football-mcp"] })
        .owner,
    ).toBe("other");
  });
});

// Refix round 3 (rulings D-1…D-6; verifiers MK and F, 2026-11-11): a plugin whose load doctor cannot
// judge is no certain server, `/mcp disable` turns a server off per project, a projects key whose
// directory is gone is no session, the choices line is redacted, and the keep rule is pinned — each
// MK-1, F1, F2 and F4 case failed before its fix.
describe("Refix round 3: what Claude Code 2.1.308 starts per project, and a plugin doctor cannot judge (MK-1, MK-3, F1, F2, F4, F6)", () => {
  const knownOf = (home: string): string =>
    path.join(home, ".claude", "plugins", "known_marketplaces.json");
  /** The plugin's server as `/mcp disable` names it (`plugin:<plugin>:<server>`). */
  const PLUGIN_SERVER = "plugin:espn-fantasy-football:espn-fantasy-football";
  /** ~/.claude.json: the user scope and each project's own record (local servers, what is off). */
  const claudeJsonWith = (
    home: string,
    user: Record<string, unknown>,
    projects: Record<string, Record<string, unknown>>,
  ): string => {
    const file = path.join(home, ".claude.json");
    write(file, { mcpServers: user, projects });
    return file;
  };
  const dirAt = (...parts: string[]): string => {
    const d = path.join(...parts);
    mkdirSync(d, { recursive: true });
    return d;
  };

  it("a refused registry beside one `claude mcp add` entry is never 'twice': doctor cannot tell whether the plugin loads, so the fix asks `claude plugin list` first and never removes the entry unconditionally; print-config says the same (MK-1)", async () => {
    for (const [label, other] of [
      ["a source type 2.1.308 does not have", recorded({ source: "claudeai" })],
      ["a field 2.1.308 refuses", recorded({ source: "github" })],
    ] as const) {
      sb = sandbox({ create: true });
      const { folder } = installPlugin(sb.home, null);
      write(knownOf(sb.home), { [MARKETPLACE]: folderMarketplace(sb.home), "other-market": other });
      const code = claudeJson(sb.home, {
        "espn-fantasy-football": launch(path.join(folder, "dist", "cli.js")),
      });
      const plugin = scanPlugin(sb.home);
      expect(plugin?.origin.kind, label).toBe("refused");
      const r = await checkLaunchConfig(
        makeIo(sb, { exec: shimOk }),
        [scanClientConfig("code", code)],
        plugin,
      );
      // it was: "Claude Code registers this server twice: the plugin AND a `claude mcp add` entry",
      // fix "keep one: remove the `claude mcp add` entry …" — on 2.1.308, which then loads no
      // marketplace plugin, that removal left every session with no server
      expect(r.status, label).toBe("warn");
      expect(r.message, label).toBe(
        "doctor cannot tell whether Claude Code loads the plugin beside the `claude mcp add` entry: it cannot judge known_marketplaces.json",
      );
      expect(r.fix, label).toBe(
        `see whether Claude Code loads the plugin with \`claude plugin list\` (its "Read from" line): if it does, keep one: remove the \`claude mcp add\` entry (\`claude mcp remove --scope user espn-fantasy-football\`), or uninstall the plugin (\`claude plugin uninstall ${PLUGIN_ID}\`); if it does not, keep the entry — or repair ~/.claude/plugins/known_marketplaces.json as row 2's detail says so that it loads the plugin, then keep one as for a plugin it loads (above); then restart the client`,
      );
      const pc = makeIo(sb, { packageRoot: fakePackage(sb), env: { ESPN_LEAGUE_ID: "0" } });
      expect(await main(["print-config", "--client", "code"], pc), label).toBe(0);
      // it was: "it registers this server in Claude Code already" — unconditionally
      expect(pc.err.text, label).not.toContain("it registers this server in Claude Code already");
      expect(pc.err.text, label).toContain(
        `eff print-config: warning: the ${PLUGIN_ID} plugin is enabled, but doctor cannot tell whether Claude Code loads it (\`eff doctor\` row 2 says why): \`claude plugin list\` shows it — if it is loaded, adding the entry above beside it starts two servers: use it only instead of the plugin (\`claude plugin uninstall ${PLUGIN_ID}\` first).`,
      );
      sb.cleanup();
    }
    sb = sandbox();
  });

  it("an enabled plugin with no install record under a refused registry is still the install: row 2 says doctor cannot tell, never 'no client is configured' (MK-3)", async () => {
    sb = sandbox();
    installPlugin(sb.home, null);
    rmSync(installedPluginsPathOf(sb.home));
    write(knownOf(sb.home), {
      [MARKETPLACE]: folderMarketplace(sb.home),
      "other-market": recorded({ source: "claudeai" }),
    });
    const plugin = scanPlugin(sb.home);
    expect(plugin?.enabled).toBe(true);
    expect(plugin?.origin.kind).toBe("refused");
    expect(plugin?.copies).toEqual([
      { scope: "user", root: null, installPath: null, version: null },
    ]);
    const r = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [], plugin);
    expect(r.status).toBe("warn");
    expect(r.message).toBe(
      "doctor cannot tell what Claude Code runs for the plugin: it cannot judge known_marketplaces.json",
    );
  });

  it("a server `/mcp disable` turned off in a project (`disabledMcpServers`) is not started there, whatever its scope: never 'twice' with it, never the reason to strip that project; turned off everywhere it is seen, it is declined (F1)", async () => {
    sb = sandbox();
    const one = espnCopy(path.join(sb.home, "src", "espn-fantasy-football-mcp"));
    const c1 = path.join(one, "dist", "cli.js");
    const a = dirAt(sb.home, "a");
    const io = makeIo(sb, { exec: shimOk });
    // DIS-1: a turns the user-scope entry off and runs its own local one
    const scan = scanClientConfig(
      "code",
      claudeJsonWith(
        sb.home,
        { "espn-fantasy-football": launch(c1) },
        {
          [a]: {
            mcpServers: { "espn-a": launch(c1) },
            disabledMcpServers: ["espn-fantasy-football"],
          },
        },
      ),
    );
    expect(scan.sessions).toEqual([{ dir: a, declined: [], disabled: ["espn-fantasy-football"] }]);
    const d = duplicateRegistrations(scan.entries, scan.sessions);
    expect(d.views.map((v) => v.map((e) => e.name))).toEqual([
      ["espn-fantasy-football"],
      ["espn-a"],
    ]);
    expect(d.most).toBe(1);
    const r = await checkLaunchConfig(io, [scan]);
    // it was: warn "registers this server twice", fix `cd a && claude mcp remove --scope local
    // espn-a` — a's only server
    expect(r.status).toBe("ok");
    expect(r.message).toBe("2 client registrations with absolute, existing paths");
    expect(r.fix).toBeNull();
    // a local entry turned off in its own project, a project entry turned off in every session
    // below it (by `/mcp disable` in one, `disabledMcpjsonServers` in the other): declined
    const b = dirAt(sb.home, "b");
    const bx = dirAt(b, "x");
    const by = dirAt(b, "y");
    // a session below a sees no local entry of a's: it never keeps espn-a from being declined
    const asub = dirAt(a, "sub");
    write(path.join(b, ".mcp.json"), { mcpServers: { "espn-p": launch(c1) } });
    write(path.join(bx, ".claude", "settings.local.json"), { disabledMcpjsonServers: ["espn-p"] });
    const off = scanClientConfig(
      "code",
      claudeJsonWith(
        sb.home,
        {},
        {
          [a]: { mcpServers: { "espn-a": launch(c1) }, disabledMcpServers: ["espn-a"] },
          [asub]: {},
          [bx]: {},
          [by]: { disabledMcpServers: ["espn-p"] },
        },
      ),
    );
    expect(off.entries.map((e) => [e.name, e.declined, e.declinedBy])).toEqual([
      ["espn-a", true, ["disabledMcpServers"]],
      ["espn-p", true, ["disabledMcpjsonServers", "disabledMcpServers"]],
    ]);
    const ro = await checkLaunchConfig(io, [off]);
    expect(ro.message).toBe("no client is configured to launch this server");
    expect(ro.details).toContain(
      `code (local scope, ${a}): declined in Claude Code's settings (\`disabledMcpServers\`) — Claude Code does not start it, so it is not counted`,
    );
    expect(ro.details).toContain(
      `code (project scope, ${path.join(b, ".mcp.json")}): declined in Claude Code's settings (\`disabledMcpjsonServers\` or \`disabledMcpServers\`) — Claude Code does not start it, so it is not counted`,
    );
    const steps = manualSteps(sb.home, [], { scans: [off], plugin: null }).join("\n");
    expect(steps).toContain(
      `registers this server under the key "espn-a", declined in Claude Code's settings (disabledMcpServers), so never started — removing it is optional: cd ${a} && claude mcp remove --scope local espn-a`,
    );
    // where every removal would strip a project, the choice names `/mcp disable` (a user entry
    // can be left there now): a/x runs both, a/y only the project entry, every other session only
    // the user one
    const p = dirAt(sb.home, "p");
    const px = dirAt(p, "x");
    const py = dirAt(p, "y");
    write(path.join(p, ".mcp.json"), { mcpServers: { "espn-p": launch(c1) } });
    const stuck = scanClientConfig(
      "code",
      claudeJsonWith(
        sb.home,
        { "espn-fantasy-football": launch(c1) },
        { [px]: {}, [py]: { disabledMcpServers: ["espn-fantasy-football"] } },
      ),
    );
    const ds = duplicateRegistrations(stuck.entries, stuck.sessions);
    expect(ds.extra).toEqual([]);
    expect(ds.unresolved.map((u) => u.dir)).toEqual([px]);
    expect((await checkLaunchConfig(io, [stuck])).fix).toBe(
      `keep one: in ${px} ("espn-fantasy-football", "espn-p"), removing any of them leaves another directory with no server — keep one there and turn the others off there (\`/mcp disable <name>\` in a session there; a project server can be declined in ${path.join(px, ".claude", "settings.local.json")} instead, \`disabledMcpjsonServers\`); then restart the client`,
    );
  });

  it("the plugin `/mcp disable` turned off in a project is no server there: beside that project's entry it is never 'twice', and the keep-the-plugin fix never strips a project that turned it off (F1)", async () => {
    sb = sandbox();
    const { folder } = installPlugin(sb.home, folderMarketplace(sb.home));
    const c1 = path.join(folder, "dist", "cli.js");
    const a = dirAt(sb.home, "a");
    const io = makeIo(sb, { exec: shimOk });
    // DIS-2: a runs espn-a alone (the plugin is off there), every other session the plugin alone
    const own = scanClientConfig(
      "code",
      claudeJsonWith(
        sb.home,
        {},
        { [a]: { mcpServers: { "espn-a": launch(c1) }, disabledMcpServers: [PLUGIN_SERVER] } },
      ),
    );
    const r = await checkLaunchConfig(io, [own], scanPlugin(sb.home));
    // it was: warn "… twice: the plugin AND a `claude mcp add` entry", fix "remove the `claude mcp
    // add` entry (cd a && …), or uninstall the plugin" — either strips somebody
    expect(r.status).toBe("ok");
    expect(r.message).toBe("2 client registrations with absolute, existing paths");
    expect(r.details).toContain(
      `code: the plugin is turned off in ${a} (\`/mcp disable\`: \`disabledMcpServers\` in ~/.claude.json) — Claude Code does not start it there`,
    );
    // a user-scope entry beside it as well: every other session runs the plugin and the entry, a
    // the entry and its own — keeping the plugin removes the user entry, which a does not need
    const both = scanClientConfig(
      "code",
      claudeJsonWith(
        sb.home,
        { "espn-fantasy-football": launch(c1) },
        { [a]: { mcpServers: { "espn-a": launch(c1) }, disabledMcpServers: [PLUGIN_SERVER] } },
      ),
    );
    const rb = await checkLaunchConfig(io, [both], scanPlugin(sb.home));
    // it was: "… three times", fix "remove the `claude mcp add` entries (both)" — a left with none
    expect(rb.message).toBe(
      "Claude Code registers this server twice: the plugin AND a `claude mcp add` entry — two servers, every tool listed twice",
    );
    expect(rb.fix).toBe(
      `keep one: remove the \`claude mcp add\` entry (\`claude mcp remove --scope user espn-fantasy-football\`), or uninstall the plugin (\`claude plugin uninstall ${PLUGIN_ID}\`) and remove the other entry (\`cd ${a} && claude mcp remove --scope local espn-a\`); then restart the client`,
    );
    // the user-scope entry alone: a needs it, every other session runs it beside the plugin
    const user = scanClientConfig(
      "code",
      claudeJsonWith(
        sb.home,
        { "espn-fantasy-football": launch(c1) },
        { [a]: { disabledMcpServers: [PLUGIN_SERVER] } },
      ),
    );
    const ru = await checkLaunchConfig(io, [user], scanPlugin(sb.home));
    expect(ru.status).toBe("warn");
    // it was: "keep one: remove the `claude mcp add` entry (…), or uninstall the plugin" — a
    // left with no server
    expect(ru.fix).toBe(
      `keep one: outside the projects Claude Code records, the plugin and "espn-fantasy-football" start, and removing it leaves a project that turns the plugin off with no server — turn the plugin back on there (\`/mcp enable ${PLUGIN_SERVER}\` in a session there), or keep it only there (\`claude mcp add --scope local\` in that project, then \`claude mcp remove --scope user espn-fantasy-football\`), or uninstall the plugin (\`claude plugin uninstall ${PLUGIN_ID}\`); then restart the client`,
    );
  });

  it("a projects key whose directory no longer exists is no session: its local entries are never counted, judged or called 'twice' — said once, and uninstall gives a removal that works (F2)", async () => {
    sb = sandbox({ create: true });
    const { folder } = installPlugin(sb.home, folderMarketplace(sb.home));
    const docs = path.join(sb.home, "Documents");
    const dead = path.join(docs, "espn-old");
    // DEAD-A: its launch target lived inside the deleted directory; DEAD-B: the live runtime clone
    for (const [label, target] of [
      ["inside", path.join(dead, "dist", "cli.js")],
      ["live", path.join(folder, "dist", "cli.js")],
    ] as const) {
      const scan = scanClientConfig(
        "code",
        claudeJsonWith(
          sb.home,
          {},
          { [dead]: { mcpServers: { "espn-fantasy-football": launch(target) } } },
        ),
      );
      expect(scan.sessions, label).toEqual([]);
      expect(
        scan.entries.map((e) => [e.name, e.absent]),
        label,
      ).toEqual([["espn-fantasy-football", true]]);
      const plugin = scanPlugin(sb.home);
      const r = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [scan], plugin);
      // it was: fail "a client launches the server with a bad path…" / warn "twice", fix
      // `cd <dead> && …` (which fails) or uninstall the plugin (which strips every live session)
      expect(r.status, label).toBe("ok");
      expect(r.message, label).toBe("1 client registration with absolute, existing paths");
      expect(r.fix, label).toBeNull();
      expect(r.details, label).toContain(
        `code (local scope, ${dead}): recorded for ${dead}, which does not exist — Claude Code starts it only in a session there, so it is not counted`,
      );
      expect(r.details.join("\n"), label).not.toContain("does not exist (run npm run build?)");
      const steps = manualSteps(sb.home, [], { scans: [scan], plugin }).join("\n");
      expect(steps, label).toContain(
        `Claude Code (local scope, project ${dead}): recorded for ${dead}, which does not exist, so never started — to remove it: mkdir -p ${dead} && cd ${dead} && claude mcp remove --scope local espn-fantasy-football (or claude purge ${dead}, which deletes all of Claude Code's state for that directory)`,
      );
    }
    // a project entry only a gone directory lies below: no session Claude Code records starts it
    write(path.join(docs, ".mcp.json"), {
      mcpServers: { "espn-p": launch(path.join(folder, "dist", "cli.js")) },
    });
    const scan = scanClientConfig("code", claudeJsonWith(sb.home, {}, { [dead]: {} }));
    expect(scan.entries.map((e) => [e.name, e.absent])).toEqual([["espn-p", true]]);
    const r = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [scan], scanPlugin(sb.home));
    expect(r.status).toBe("ok");
    expect(r.message).toBe("1 client registration with absolute, existing paths");
    expect(r.details).toContain(
      `code (project scope, ${path.join(docs, ".mcp.json")}): no project directory Claude Code records at or below ${docs} still exists — Claude Code starts it only in a session there, so it is not counted`,
    );
    // the directory back: a session again, and the duplicate is caught
    mkdirSync(dead, { recursive: true });
    const back = scanClientConfig("code", claudeJsonWith(sb.home, {}, { [dead]: {} }));
    expect(back.sessions.map((s) => s.dir)).toEqual([dead]);
    expect(
      (await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [back], scanPlugin(sb.home))).message,
    ).toContain("registers this server twice");
  });

  it("the choices line names each key through the output redaction: a credential-shaped key is never printed raw (F4)", async () => {
    sb = sandbox();
    const one = espnCopy(path.join(sb.home, "src", "espn-fantasy-football-mcp"));
    const c1 = path.join(one, "dist", "cli.js");
    const fake = fakeEspnS2("verifier-named", 66);
    const key = `espn_s2="${fake}"`;
    const a = dirAt(sb.home, "a");
    const ax = dirAt(a, "x");
    const axz = dirAt(ax, "z");
    const ay = dirAt(a, "y");
    write(path.join(a, ".mcp.json"), { mcpServers: { [key]: launch(c1) } });
    write(path.join(ax, ".mcp.json"), { mcpServers: { "espn-2": launch(c1) } });
    write(path.join(axz, ".claude", "settings.local.json"), { disabledMcpjsonServers: [key] });
    const scan = scanClientConfig(
      "code",
      claudeJson(sb.home, {}, { [ax]: {}, [axz]: {}, [ay]: {} }),
    );
    const r = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [scan]);
    expect(r.fix).toContain(`in ${ax} (`);
    // it was: `"espn_s2=[redacted:espn_s2]\"AE…\""` — the value after the escaped quote printed raw
    const text = [r.message, r.fix ?? "", ...r.details].join("\n");
    expect(text).not.toContain(fake);
    expect(text).not.toContain(fake.slice(2, 40));
  });

  it("a projects key that names a file is no session either; a local entry is never declined by `disabledMcpjsonServers`, which only declines project servers (F1, F2)", async () => {
    sb = sandbox();
    const one = espnCopy(path.join(sb.home, "src", "espn-fantasy-football-mcp"));
    const c1 = path.join(one, "dist", "cli.js");
    const file = path.join(sb.home, "not-a-dir");
    write(file, "x");
    const onFile = scanClientConfig(
      "code",
      claudeJsonWith(sb.home, {}, { [file]: { mcpServers: { "espn-f": launch(c1) } } }),
    );
    expect(onFile.sessions).toEqual([]);
    expect(onFile.entries.map((e) => [e.name, e.absent])).toEqual([["espn-f", true]]);
    const a = dirAt(sb.home, "a");
    write(path.join(a, ".claude", "settings.local.json"), { disabledMcpjsonServers: ["espn-a"] });
    const local = scanClientConfig(
      "code",
      claudeJsonWith(sb.home, {}, { [a]: { mcpServers: { "espn-a": launch(c1) } } }),
    );
    expect(local.entries.map((e) => [e.name, e.declined, e.absent])).toEqual([
      ["espn-a", false, false],
    ]);
    const r = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [local]);
    expect(r.message).toBe("1 client registration with absolute, existing paths");
  });

  it("beside a plugin doctor cannot judge: an entry only where the plugin is turned off, or one running its own command line, is no maybe-second server; two keys beside it keep the manual fix for when it does not load (MK-1, F1)", async () => {
    sb = sandbox();
    const { folder } = installPlugin(sb.home, null);
    write(knownOf(sb.home), {
      [MARKETPLACE]: folderMarketplace(sb.home),
      "other-market": recorded({ source: "claudeai" }),
    });
    const c1 = path.join(folder, "dist", "cli.js");
    const a = dirAt(sb.home, "a");
    const io = makeIo(sb, { exec: shimOk });
    const cannotJudge =
      "doctor cannot tell what Claude Code runs for the plugin: it cannot judge known_marketplaces.json";
    // a turns the plugin off and runs its own entry: whether or not the plugin loads, one server
    const offOnly = scanClientConfig(
      "code",
      claudeJsonWith(
        sb.home,
        {},
        { [a]: { mcpServers: { "espn-a": launch(c1) }, disabledMcpServers: [PLUGIN_SERVER] } },
      ),
    );
    const ro = await checkLaunchConfig(io, [offOnly], scanPlugin(sb.home));
    expect(ro.status).toBe("warn");
    expect(ro.message).toBe(cannotJudge);
    // two keys in every session beside it: the manual duplicate is certain, the plugin a question
    const two = scanClientConfig(
      "code",
      claudeJsonWith(sb.home, { "espn-fantasy-football": launch(c1), "espn-2": launch(c1) }, {}),
    );
    const rt = await checkLaunchConfig(io, [two], scanPlugin(sb.home));
    expect(rt.message).toBe(
      "Claude Code registers this server twice: two `claude mcp add` entries under different keys — two servers, every tool listed twice; doctor cannot tell whether Claude Code loads the plugin beside the `claude mcp add` entries: it cannot judge known_marketplaces.json",
    );
    expect(rt.fix).toBe(
      `see whether Claude Code loads the plugin with \`claude plugin list\` (its "Read from" line): if it does, keep one: remove the \`claude mcp add\` entries (\`claude mcp remove --scope user espn-fantasy-football\`, \`claude mcp remove --scope user espn-2\`), or uninstall the plugin (\`claude plugin uninstall ${PLUGIN_ID}\`) and remove the other entry (\`claude mcp remove --scope user espn-2\`); if it does not, keep one: remove the other entry (\`claude mcp remove --scope user espn-2\`) — or repair ~/.claude/plugins/known_marketplaces.json as row 2's detail says so that it loads the plugin, then keep one as for a plugin it loads (above); then restart the client`,
    );
  });

  it("the fix that keeps the plugin settles the plugin's sessions first and drops the lowest-ranked key first, so a project that turned the plugin off keeps the widest entry it needs (F1)", async () => {
    sb = sandbox();
    const { folder } = installPlugin(sb.home, folderMarketplace(sb.home));
    const c1 = path.join(folder, "dist", "cli.js");
    const x = dirAt(sb.home, "x");
    const xa = dirAt(x, "a");
    const xb = dirAt(x, "b");
    const io = makeIo(sb, { exec: shimOk });
    // x/a turns the plugin off and runs its local entry and x's project entry; x/b runs the plugin
    // and the project entry. Settled in listing order, x/a would keep the project entry and x/b
    // could then never drop it.
    write(path.join(x, ".mcp.json"), { mcpServers: { "espn-p": launch(c1) } });
    const first = scanClientConfig(
      "code",
      claudeJsonWith(
        sb.home,
        {},
        {
          [xa]: { mcpServers: { "espn-la": launch(c1) }, disabledMcpServers: [PLUGIN_SERVER] },
          [xb]: {},
        },
      ),
    );
    const d = duplicateRegistrations(first.entries, first.sessions, {
      key: PLUGIN_SERVER,
      drops: () => false,
    });
    expect(d.withPlugin?.extra.map((e) => e.name)).toEqual(["espn-p"]);
    expect(d.withPlugin?.unresolved).toEqual([]);
    // uninstalling: this server added at user scope reaches every session, so espn-p goes too
    // (VR4-3: it was kept, starting beside the new entry in x/a and x/b)
    expect((await checkLaunchConfig(io, [first], scanPlugin(sb.home))).fix).toBe(
      `keep one: remove the \`claude mcp add\` entry (\`cd ${x} && claude mcp remove --scope project espn-p\`), or uninstall the plugin (\`claude plugin uninstall ${PLUGIN_ID}\`) and remove the other entries (\`cd ${xa} && claude mcp remove --scope local espn-la\`, \`cd ${x} && claude mcp remove --scope project espn-p\`) — only once this server is added at user scope (\`eff print-config --client code\` prints the command): uninstalling it now leaves every session outside the projects Claude Code records with no server; then restart the client`,
    );
    // two project keys in x: x/a (plugin off) needs one of them, and keeps the own key
    write(path.join(x, ".mcp.json"), {
      mcpServers: { "espn-fantasy-football": launch(c1), "espn-p2": launch(c1) },
    });
    const two = scanClientConfig(
      "code",
      claudeJsonWith(sb.home, {}, { [xa]: { disabledMcpServers: [PLUGIN_SERVER] }, [xb]: {} }),
    );
    const d2 = duplicateRegistrations(two.entries, two.sessions, {
      key: PLUGIN_SERVER,
      drops: () => false,
    });
    expect(d2.withPlugin?.extra.map((e) => e.name)).toEqual(["espn-p2"]);
    expect(d2.withPlugin?.unresolved.map((u) => [u.dir, u.entries.map((e) => e.name)])).toEqual([
      [xb, ["espn-fantasy-football"]],
    ]);
    expect((await checkLaunchConfig(io, [two], scanPlugin(sb.home))).fix).toBe(
      `keep one: remove the \`claude mcp add\` entry (\`cd ${x} && claude mcp remove --scope project espn-p2\`); in ${xb} ("espn-fantasy-football", beside the plugin), removing it leaves another directory with no server — turn it off there (\`/mcp disable <name>\` in a session there; a project server can be declined in ${path.join(xb, ".claude", "settings.local.json")} instead, \`disabledMcpjsonServers\`), or uninstall the plugin (\`claude plugin uninstall ${PLUGIN_ID}\`) and remove the other entry (\`cd ${x} && claude mcp remove --scope project espn-p2\`) — only once this server is added at user scope (\`eff print-config --client code\` prints the command): uninstalling it now leaves every session outside the projects Claude Code records with no server; then restart the client`,
    );
  });

  it("the key kept ranks by its entry that reaches the most sessions and by its shallowest entry (F6)", () => {
    sb = sandbox();
    const one = espnCopy(path.join(sb.home, "src", "espn-fantasy-football-mcp"));
    const c1 = path.join(one, "dist", "cli.js");
    // reach: espn-fantasy-football has a local entry in r (one session) and a project entry in
    // r/.mcp.json (r and r/s); k1 a project entry there too — its widest entry ties k1's, so the
    // own key is kept
    const r = dirAt(sb.home, "r");
    const rs = dirAt(r, "s");
    write(path.join(r, ".mcp.json"), {
      mcpServers: { "espn-fantasy-football": launch(c1), k1: launch(c1) },
    });
    const reach = scanClientConfig(
      "code",
      claudeJson(sb.home, {}, { [r]: { "espn-fantasy-football": launch(c1) }, [rs]: {} }),
    );
    const dr = duplicateRegistrations(reach.entries, reach.sessions);
    expect(dr.extra.map((e) => [e.name, e.scope, e.dir])).toEqual([["k1", "project", r]]);
    // depth: kb has a local entry in q/x; ka a project entry in q/x and one in q — its
    // shallowest entry is wider than kb's, so ka is kept
    sb.cleanup();
    sb = sandbox();
    const two = espnCopy(path.join(sb.home, "src", "espn-fantasy-football-mcp"));
    const c2 = path.join(two, "dist", "cli.js");
    const q = dirAt(sb.home, "q");
    const qx = dirAt(q, "x");
    write(path.join(q, ".mcp.json"), { mcpServers: { ka: launch(c2) } });
    write(path.join(qx, ".mcp.json"), { mcpServers: { ka: launch(c2) } });
    const depth = scanClientConfig("code", claudeJson(sb.home, {}, { [qx]: { kb: launch(c2) } }));
    expect(depth.entries.map((e) => e.name)).toEqual(["kb", "ka", "ka"]);
    const dd = duplicateRegistrations(depth.entries, depth.sessions);
    expect(dd.extra.map((e) => [e.name, e.scope, e.dir])).toEqual([["kb", "local", qx]]);
  });
});

describe("Refix round 4: the plugin's uninstall never strips a session, a plugin doctor does not follow is no certain server, and a gone or unreadable project directory (V3-1…V3-5)", () => {
  const knownOf = (home: string): string =>
    path.join(home, ".claude", "plugins", "known_marketplaces.json");
  /** The plugin's server as `/mcp disable` names it (`plugin:<plugin>:<server>`). */
  const PLUGIN_SERVER = "plugin:espn-fantasy-football:espn-fantasy-football";
  const claudeJsonWith = (
    home: string,
    user: Record<string, unknown>,
    projects: Record<string, Record<string, unknown>>,
  ): string => {
    const file = path.join(home, ".claude.json");
    write(file, { mcpServers: user, projects });
    return file;
  };
  const dirAt = (...parts: string[]): string => {
    const d = path.join(...parts);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const UNINSTALL = `uninstall the plugin (\`claude plugin uninstall ${PLUGIN_ID}\`)`;
  const PLUGIN_LIST_TEXT =
    'see whether Claude Code loads the plugin with `claude plugin list` (its "Read from" line)';
  const offLine = (where: string, dirs: string): string =>
    `${where}: turned off in ${dirs} (\`/mcp disable\`: \`disabledMcpServers\` in ~/.claude.json) — Claude Code does not start it there`;
  const OUTSIDE = "every session outside the projects Claude Code records";
  const ADD_USER =
    "this server is added at user scope (`eff print-config --client code` prints the command)";

  it("uninstalling the plugin is offered unconditionally only where it strips no session; where the plugin is a session's only server, the fix names those sessions and what to do first, and an entry turned off in a project is said (V3-1)", async () => {
    sb = sandbox();
    const { folder } = installPlugin(sb.home, folderMarketplace(sb.home));
    const c1 = path.join(folder, "dist", "cli.js");
    const a = dirAt(sb.home, "a");
    const b = dirAt(sb.home, "b");
    const io = makeIo(sb, { exec: shimOk });
    const user = { "espn-fantasy-football": launch(c1) };
    // U1: a turned the user-scope entry off, so a runs the plugin alone
    const u1 = scanClientConfig(
      "code",
      claudeJsonWith(sb.home, user, {
        [a]: { disabledMcpServers: ["espn-fantasy-football"] },
        [b]: {},
      }),
    );
    const d1 = duplicateRegistrations(u1.entries, u1.sessions, {
      key: PLUGIN_SERVER,
      drops: () => false,
    });
    expect(d1.withPlugin?.uninstallStrips).toEqual([{ dir: a, off: ["espn-fantasy-football"] }]);
    expect(d1.offIn.map((o) => [o.entry.name, o.dirs])).toEqual([["espn-fantasy-football", [a]]]);
    const r1 = await checkLaunchConfig(io, [u1], scanPlugin(sb.home));
    expect(r1.status).toBe("warn");
    expect(r1.message).toBe(
      "Claude Code registers this server twice: the plugin AND a `claude mcp add` entry — two servers, every tool listed twice",
    );
    // it was: "…, or uninstall the plugin (`claude plugin uninstall …`); then restart the client" —
    // a, whose only server the plugin is, left with none
    expect(r1.fix).toBe(
      `keep one: remove the \`claude mcp add\` entry (\`claude mcp remove --scope user espn-fantasy-football\`), or ${UNINSTALL} — only once "espn-fantasy-football" is turned back on in ${a} (\`/mcp enable <name>\` in a session there): uninstalling it now leaves ${a} with no server; then restart the client`,
    );
    expect(r1.details).toContain(offLine("code (user scope)", a));
    // U3: the plugin is off in b as well — keeping the plugin is the user's choice outside, and
    // uninstalling it still strips a
    const u3 = scanClientConfig(
      "code",
      claudeJsonWith(sb.home, user, {
        [a]: { disabledMcpServers: ["espn-fantasy-football"] },
        [b]: { disabledMcpServers: [PLUGIN_SERVER] },
      }),
    );
    const r3 = await checkLaunchConfig(io, [u3], scanPlugin(sb.home));
    expect(r3.fix).toBe(
      `keep one: outside the projects Claude Code records, the plugin and "espn-fantasy-football" start, and removing it leaves a project that turns the plugin off with no server — turn the plugin back on there (\`/mcp enable ${PLUGIN_SERVER}\` in a session there), or keep it only there (\`claude mcp add --scope local\` in that project, then \`claude mcp remove --scope user espn-fantasy-football\`), or ${UNINSTALL} — only once "espn-fantasy-football" is turned back on in ${a} (\`/mcp enable <name>\` in a session there): uninstalling it now leaves ${a} with no server; then restart the client`,
    );
    expect(r3.details).toContain(offLine("code (user scope)", a));
    // U2: a local entry in a, nothing turned off — b and every session outside the recorded
    // projects run the plugin alone
    const u2 = scanClientConfig(
      "code",
      claudeJsonWith(sb.home, {}, { [a]: { mcpServers: user }, [b]: {} }),
    );
    const r2 = await checkLaunchConfig(io, [u2], scanPlugin(sb.home));
    expect(r2.fix).toBe(
      `keep one: remove the \`claude mcp add\` entry (\`cd ${a} && claude mcp remove --scope local espn-fantasy-football\`), or ${UNINSTALL} — only once ${ADD_USER}: uninstalling it now leaves ${b} and ${OUTSIDE} with no server; then restart the client`,
    );
    // both at once: the sessions outside and a turned-off project, each with its own step
    const both = scanClientConfig(
      "code",
      claudeJsonWith(
        sb.home,
        {},
        {
          [a]: { mcpServers: user, disabledMcpServers: ["espn-fantasy-football"] },
          [b]: { mcpServers: { "espn-b": launch(c1) } },
        },
      ),
    );
    const d4 = duplicateRegistrations(both.entries, both.sessions, {
      key: PLUGIN_SERVER,
      drops: () => false,
    });
    // a's own entry is declined (turned off in every session that sees it): never in a view
    expect(both.entries.map((e) => [e.name, e.declined])).toEqual([
      ["espn-fantasy-football", true],
      ["espn-b", false],
    ]);
    // …but it reaches a, where `/mcp enable` brings it back (a user-scope entry under that key
    // would be off there too)
    expect(d4.withPlugin?.uninstallStrips).toEqual([
      { dir: null, off: [] },
      { dir: a, off: ["espn-fantasy-football"] },
    ]);
    const r4 = await checkLaunchConfig(io, [both], scanPlugin(sb.home));
    // VR4-3: with this server added at user scope, b would start it beside espn-b — the step
    // removes espn-b (it was: no removal, a new duplicate in b)
    expect(r4.fix).toBe(
      `keep one: remove the \`claude mcp add\` entry (\`cd ${b} && claude mcp remove --scope local espn-b\`), or ${UNINSTALL} and remove the other entry (\`cd ${b} && claude mcp remove --scope local espn-b\`) — only once ${ADD_USER} and "espn-fantasy-football" is turned back on in ${a} (\`/mcp enable <name>\` in a session there): uninstalling it now leaves ${a} and ${OUTSIDE} with no server; then restart the client`,
    );
    // the declined entry is said once as declined, never again as turned off; the key it holds is
    // said once as the one the fix's user-scope entry needs turned back on (VR4-2)
    expect(r4.details.filter((l) => l.includes("turned off in"))).toEqual([
      `code: \`espn-fantasy-football\` is turned off in ${a} (\`/mcp disable\`: \`disabledMcpServers\` in ~/.claude.json) — the user-scope entry the fix adds does not start there until it is turned back on`,
    ]);
    // a user-scope entry no project turns off: uninstalling strips nobody — offered as before
    const plain = scanClientConfig("code", claudeJsonWith(sb.home, user, { [a]: {}, [b]: {} }));
    const rp = await checkLaunchConfig(io, [plain], scanPlugin(sb.home));
    expect(rp.fix).toBe(
      `keep one: remove the \`claude mcp add\` entry (\`claude mcp remove --scope user espn-fantasy-football\`), or ${UNINSTALL}; then restart the client`,
    );
    expect(rp.details.join("\n")).not.toContain("turned off in");
    // more than five directories are listed as five and "…"
    const many = Object.fromEntries(
      ["p1", "p2", "p3", "p4", "p5", "p6"].map((n) => [
        dirAt(sb.home, n),
        { disabledMcpServers: ["espn-fantasy-football"] },
      ]),
    );
    const rm = await checkLaunchConfig(
      io,
      [scanClientConfig("code", claudeJsonWith(sb.home, user, many))],
      scanPlugin(sb.home),
    );
    const five = ["p1", "p2", "p3", "p4", "p5"].map((n) => path.join(sb.home, n)).join(", ");
    expect(rm.details).toContain(offLine("code (user scope)", `${five} …`));
    expect(rm.fix).toContain(`uninstalling it now leaves ${five} … with no server`);
    expect(rm.fix).toContain(`is turned back on in ${five} …`);
    // exactly five are listed whole
    const p6 = path.join(sb.home, "p6");
    const fiveDirs = Object.fromEntries(Object.entries(many).filter(([k]) => k !== p6));
    const r5 = await checkLaunchConfig(
      io,
      [scanClientConfig("code", claudeJsonWith(sb.home, user, fiveDirs))],
      scanPlugin(sb.home),
    );
    expect(r5.details).toContain(offLine("code (user scope)", five));
    expect(r5.fix).toContain(`uninstalling it now leaves ${five} with no server`);
  });

  it("the sessions uninstalling the plugin would strip, and the entries turned off there, are only those an entry reaches and the plugin runs in (V3-1)", async () => {
    sb = sandbox();
    const { folder } = installPlugin(sb.home, folderMarketplace(sb.home));
    const c1 = path.join(folder, "dist", "cli.js");
    const [a, b, c, d] = ["a", "b", "c", "d"].map((n) => dirAt(sb.home, n)) as [
      string,
      string,
      string,
      string,
    ];
    const io = makeIo(sb, { exec: shimOk });
    const plugin = { key: PLUGIN_SERVER, drops: () => false };
    // b turns off a key only a's local entry has (it never reaches b); c turns the plugin off and
    // has no entry (no server before, none after); d runs the plugin beside its own entry
    const scan = scanClientConfig(
      "code",
      claudeJsonWith(
        sb.home,
        {},
        {
          [a]: { mcpServers: { "espn-a": launch(c1) } },
          [b]: { disabledMcpServers: ["espn-a"] },
          [c]: { disabledMcpServers: [PLUGIN_SERVER] },
          [d]: { mcpServers: { "espn-d": launch(c1) } },
        },
      ),
    );
    const dr = duplicateRegistrations(scan.entries, scan.sessions, plugin);
    expect(dr.offIn).toEqual([]);
    expect(dr.withPlugin?.uninstallStrips).toEqual([
      { dir: null, off: [] },
      { dir: b, off: [] },
    ]);
    const r = await checkLaunchConfig(io, [scan], scanPlugin(sb.home));
    // only the plugin's own off state in c is said
    expect(r.details.filter((l) => l.includes("turned off in"))).toEqual([
      `code: the plugin is turned off in ${c} (\`/mcp disable\`: \`disabledMcpServers\` in ~/.claude.json) — Claude Code does not start it there`,
    ]);
    expect(r.fix).toContain(
      `— only once ${ADD_USER}: uninstalling it now leaves ${b} and ${OUTSIDE} with no server`,
    );
    // a turns its own two entries off: both are named, "are", and only a is to turn them back on
    const two = scanClientConfig(
      "code",
      claudeJsonWith(
        sb.home,
        {},
        {
          [a]: {
            mcpServers: { "espn-a": launch(c1), "espn-a2": launch(c1) },
            disabledMcpServers: ["espn-a", "espn-a2"],
          },
          [b]: {},
          [d]: { mcpServers: { "espn-d": launch(c1) } },
        },
      ),
    );
    // with this server added at user scope (the sessions outside are stripped too), a gets it: its
    // own entries turned back on would only be removed again (VR4-3) — none is named
    expect(
      duplicateRegistrations(two.entries, two.sessions, plugin).withPlugin?.uninstallStrips,
    ).toEqual([
      { dir: null, off: [] },
      { dir: a, off: [] },
      { dir: b, off: [] },
    ]);
    const rt = await checkLaunchConfig(io, [two], scanPlugin(sb.home));
    expect(rt.fix).toContain(
      `, or ${UNINSTALL} and remove the other entry (\`cd ${d} && claude mcp remove --scope local espn-d\`) — only once ${ADD_USER}: uninstalling it now leaves ${a}, ${b} and ${OUTSIDE} with no server`,
    );
    // without the sessions outside stripped (a user-scope entry a turns off), a turns back on the
    // one key that reaches the most sessions — turning on more would only remove them again
    const inner = scanClientConfig(
      "code",
      claudeJsonWith(
        sb.home,
        { "espn-u": launch(c1) },
        {
          [a]: {
            mcpServers: { "espn-a": launch(c1), "espn-a2": launch(c1) },
            disabledMcpServers: ["espn-a", "espn-a2", "espn-u"],
          },
        },
      ),
    );
    expect(
      duplicateRegistrations(inner.entries, inner.sessions, plugin).withPlugin?.uninstallStrips,
    ).toEqual([{ dir: a, off: ["espn-u"] }]);
  });

  it("beside a plugin doctor cannot judge, the uninstall branch follows the same rule (V3-1, MK-1)", async () => {
    sb = sandbox();
    const { folder } = installPlugin(sb.home, null);
    write(knownOf(sb.home), {
      [MARKETPLACE]: folderMarketplace(sb.home),
      "other-market": recorded({ source: "claudeai" }),
    });
    const a = dirAt(sb.home, "a");
    const scan = scanClientConfig(
      "code",
      claudeJsonWith(
        sb.home,
        {},
        {
          [a]: {
            mcpServers: { "espn-fantasy-football": launch(path.join(folder, "dist", "cli.js")) },
          },
        },
      ),
    );
    const r = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [scan], scanPlugin(sb.home));
    expect(r.fix).toBe(
      `${PLUGIN_LIST_TEXT}: if it does, keep one: remove the \`claude mcp add\` entry (\`cd ${a} && claude mcp remove --scope local espn-fantasy-football\`), or ${UNINSTALL} — only once ${ADD_USER}: uninstalling it now leaves ${OUTSIDE} with no server; if it does not, keep the entry — or repair ~/.claude/plugins/known_marketplaces.json as row 2's detail says so that it loads the plugin, then keep one as for a plugin it loads (above); then restart the client`,
    );
  });

  it("a plugin whose folder-marketplace source doctor does not follow (an absolute path, a bare name — which Claude Code 2.1.308 loads nothing from) is no certain server: beside a `claude mcp add` entry never 'twice', never an unconditional removal (V3-2)", async () => {
    for (const label of ["absolute", "bare name"] as const) {
      sb = sandbox({ create: true });
      const { folder } = installPlugin(sb.home, folderMarketplace(sb.home));
      write(path.join(folder, ".claude-plugin", "marketplace.json"), {
        name: MARKETPLACE,
        plugins: [
          { name: "espn-fantasy-football", source: label === "absolute" ? folder : "bare-name" },
        ],
      });
      const code = claudeJson(sb.home, {
        "espn-fantasy-football": launch(path.join(folder, "dist", "cli.js")),
      });
      const plugin = scanPlugin(sb.home);
      expect(plugin?.origin.kind, label).toBe("refused");
      expect(plugin === null ? "" : pluginLoads(plugin.origin), label).toBe("unknown");
      const r = await checkLaunchConfig(
        makeIo(sb, { exec: shimOk }),
        [scanClientConfig("code", code)],
        plugin,
      );
      // it was: warn "Claude Code registers this server twice: the plugin AND a `claude mcp add`
      // entry", fix "keep one: remove the `claude mcp add` entry (…), or uninstall the plugin" — on
      // 2.1.308, which loads no such plugin, that removal left every session with no server
      expect(r.status, label).toBe("warn");
      expect(r.message, label).toBe(
        "doctor cannot tell whether Claude Code loads the plugin beside the `claude mcp add` entry: it does not follow the plugin's source in its folder marketplace",
      );
      expect(r.fix, label).toBe(
        `${PLUGIN_LIST_TEXT}: if it does, keep one: remove the \`claude mcp add\` entry (\`claude mcp remove --scope user espn-fantasy-football\`), or ${UNINSTALL}; if it does not, keep the entry — or repair the plugin's source in its marketplace listing as row 2's detail says (the runtime clone's committed listing names it \`./\`, README step 5) so that it loads the plugin, then keep one as for a plugin it loads (above); then restart the client`,
      );
      const pc = makeIo(sb, { packageRoot: fakePackage(sb), env: { ESPN_LEAGUE_ID: "0" } });
      expect(await main(["print-config", "--client", "code"], pc), label).toBe(0);
      expect(pc.err.text, label).not.toContain("it registers this server in Claude Code already");
      expect(pc.err.text, label).toContain(
        `the ${PLUGIN_ID} plugin is enabled, but doctor cannot tell whether Claude Code loads it`,
      );
      sb.cleanup();
    }
    sb = sandbox();
  });

  it("a gone project directory under a git work tree gets `claude purge` only, never `mkdir -p` — a session made there is filed under the work tree, whose entry `claude mcp remove` would remove (V3-3)", () => {
    sb = sandbox();
    const one = espnCopy(path.join(sb.home, "src", "espn-fantasy-football-mcp"));
    const c1 = path.join(one, "dist", "cli.js");
    for (const kind of ["a .git directory", "a .git file (a linked worktree)"] as const) {
      const top = dirAt(sb.home, kind === "a .git directory" ? "repo" : "worktree");
      if (kind === "a .git directory")
        write(path.join(top, ".git", "HEAD"), "ref: refs/heads/main\n");
      else write(path.join(top, ".git"), "gitdir: /placeholder/.git/worktrees/x\n");
      const gone = path.join(top, "Developer", "gone-repo");
      // GONE-GIT: the work tree's own record holds another server under this server's key
      const scan = scanClientConfig(
        "code",
        claudeJsonWith(
          sb.home,
          {},
          {
            [top]: { mcpServers: { "espn-fantasy-football": { command: "uvx", args: ["other"] } } },
            [gone]: { mcpServers: { "espn-fantasy-football": launch(c1) } },
          },
        ),
      );
      expect(
        scan.entries.map((e) => [e.dir, e.absent]),
        kind,
      ).toEqual([[gone, true]]);
      const steps = manualSteps(sb.home, [], { scans: [scan], plugin: null }).join("\n");
      // it was: "to remove it: mkdir -p <gone> && cd <gone> && claude mcp remove --scope local
      // espn-fantasy-football" — which on 2.1.308 removes the uvx entry of the work tree's record
      expect(steps, kind).not.toContain(`mkdir -p ${gone}`);
      expect(steps, kind).not.toContain(`cd ${gone}`);
      expect(steps, kind).toContain(
        `Claude Code (local scope, project ${gone}): recorded for ${gone}, which does not exist, so never started — to remove it: claude purge ${gone} while ${gone} does not exist (it deletes all of Claude Code's state for that directory); never make ${gone} first: Claude Code files a session there under the git work tree at ${top}, so \`claude mcp remove\` there, or \`claude purge\` once it exists, acts on ${top}'s record`,
      );
    }
    // no work tree above: the mkdir route stands
    const free = path.join(sb.home, "plain", "gone");
    mkdirSync(path.dirname(free), { recursive: true });
    const scan = scanClientConfig(
      "code",
      claudeJsonWith(
        sb.home,
        {},
        { [free]: { mcpServers: { "espn-fantasy-football": launch(c1) } } },
      ),
    );
    expect(manualSteps(sb.home, [], { scans: [scan], plugin: null }).join("\n")).toContain(
      `to remove it: mkdir -p ${free} && cd ${free} && claude mcp remove --scope local espn-fantasy-football (or claude purge ${free}, which deletes all of Claude Code's state for that directory)`,
    );
  });

  it("the fix for a known_marketplaces.json doctor cannot judge orders its steps: `claude plugin list`, then the record's repair (2.1.308 refuses `marketplace add` until then), then the re-add (V3-4)", async () => {
    sb = sandbox();
    installPlugin(sb.home, null);
    write(knownOf(sb.home), {
      [MARKETPLACE]: folderMarketplace(sb.home),
      "other-market": recorded({ source: "github" }),
    });
    const r = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [], scanPlugin(sb.home));
    expect(r.status).toBe("warn");
    // it was: "…; if it does not, repair … as row 2's detail says, or add the marketplace again …"
    // — on 2.1.308 that `claude plugin marketplace add` fails while the record is refused
    expect(r.fix).toBe(
      `${PLUGIN_LIST_TEXT}; if it does not, repair the record of ~/.claude/plugins/known_marketplaces.json that row 2's detail names first — until then Claude Code 2.1.308 also refuses \`claude plugin marketplace add\` — and if it still does not load, add the marketplace again from the built runtime clone (\`claude plugin marketplace add <the runtime clone>\`, README step 5); then restart the client`,
    );
    expect(r.fix).not.toContain("move aside");
  });

  it("the git work tree a session is filed under is the nearest of the directory and its ancestors holding a .git; a .git doctor cannot lstat counts as one (V3-3)", () => {
    sb = sandbox();
    const top = dirAt(sb.home, "repo");
    write(path.join(top, ".git", "HEAD"), "ref: refs/heads/main\n");
    const inner = dirAt(top, "sub");
    write(path.join(inner, ".git"), "gitdir: /placeholder/.git/worktrees/x\n");
    expect(gitWorkTreeAt(top)).toBe(top);
    expect(gitWorkTreeAt(path.join(top, "gone", "deeper"))).toBe(top);
    expect(gitWorkTreeAt(path.join(inner, "gone"))).toBe(inner);
    expect(gitWorkTreeAt(path.join(sb.home, "plain", "gone"))).toBeNull();
    // Node refuses the path itself (a NUL byte): not known to be no work tree — taken as one
    const nul = path.join(sb.home, "nul\u0000dir");
    expect(gitWorkTreeAt(nul)).toBe(nul);
    if (process.getuid?.() !== 0) {
      // a permission error on the lstat: the same
      const locked = dirAt(sb.home, "locked");
      chmodSync(locked, 0o000);
      try {
        expect(gitWorkTreeAt(path.join(locked, "x"))).toBe(path.join(locked, "x"));
      } finally {
        chmodSync(locked, 0o755);
      }
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    "a project directory doctor cannot stat is still a session (Claude Code may reach it): a broken entry there still fails, and the detail says doctor cannot check it (V3-5)",
    async () => {
      sb = sandbox();
      const locked = dirAt(sb.home, "locked");
      const proj = dirAt(locked, "proj");
      // a local entry of ours whose build is gone (ours by key: its package.json is missing)
      const missing = path.join(sb.home, "gone-build", "dist", "cli.js");
      const file = claudeJsonWith(
        sb.home,
        {},
        {
          [proj]: { mcpServers: { "espn-fantasy-football": launch(missing) } },
        },
      );
      const io = makeIo(sb, { exec: shimOk });
      const readable = await checkLaunchConfig(io, [scanClientConfig("code", file)]);
      expect(readable.status).toBe("fail");
      chmodSync(locked, 0o000);
      try {
        const scan = scanClientConfig("code", file);
        expect(scan.sessions.map((s) => [s.dir, s.unchecked])).toEqual([[proj, "EACCES"]]);
        expect(scan.entries.map((e) => e.absent)).toEqual([false]);
        const r = await checkLaunchConfig(io, [scan]);
        // it was: warn "no client is configured to launch this server" with the fix to install
        // the plugin — while Claude Code, if it reaches the directory, starts the broken entry
        expect(r.status).toBe("fail");
        expect(r.message).toBe("a client launches the server with a bad path, Node or location");
        expect(r.details).toContain(
          `code: doctor cannot check ${proj} (EACCES): it is counted as a session, as Claude Code may still open it`,
        );
        expect(r.details.join("\n")).not.toContain("which does not exist");
        const steps = manualSteps(sb.home, [], { scans: [scan], plugin: null }).join("\n");
        expect(steps).not.toContain("mkdir -p");
        // D-7 (d): doctor cannot tell which record Claude Code files it under — by hand only
        expect(steps).not.toContain(`cd ${proj}`);
        expect(steps).toContain(
          `delete projects[${JSON.stringify(proj)}].mcpServers["espn-fantasy-football"] from ${file} by hand, with every Claude Code session closed and the file backed up first (doctor cannot tell which record \`claude mcp remove\` there acts on: doctor cannot check ${proj} (EACCES))`,
        );
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );

  it("a projects key that names a file is 'not a directory', never 'does not exist', and uninstall never offers `mkdir -p` for it (V3-5)", async () => {
    sb = sandbox();
    const one = espnCopy(path.join(sb.home, "src", "espn-fantasy-football-mcp"));
    const c1 = path.join(one, "dist", "cli.js");
    const file = path.join(sb.home, "not-a-dir");
    write(file, "x");
    const scan = scanClientConfig(
      "code",
      claudeJsonWith(sb.home, {}, { [file]: { mcpServers: { "espn-f": launch(c1) } } }),
    );
    expect(scan.entries.map((e) => [e.absent, e.notDirectory])).toEqual([[true, true]]);
    const r = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [scan]);
    expect(r.details).toContain(
      `code (local scope, ${file}): recorded for ${file}, which is not a directory — Claude Code starts it only in a session there, so it is not counted`,
    );
    const steps = manualSteps(sb.home, [], { scans: [scan], plugin: null }).join("\n");
    expect(steps).not.toContain("mkdir -p");
    expect(steps).toContain(
      `Claude Code (local scope, project ${file}) registers this server under the key "espn-f": recorded for ${file}, which is not a directory, so never started — to remove it: claude purge ${file} (it deletes all of Claude Code's state for that path; \`claude mcp remove\` cannot run there)`,
    );
    // a key below a file (ENOTDIR) or one no filesystem holds (a NUL byte): gone, never a session
    // doctor "cannot check"
    for (const key of [path.join(file, "proj"), path.join(sb.home, "nul\u0000dir")]) {
      const odd = scanClientConfig(
        "code",
        claudeJsonWith(sb.home, {}, { [key]: { mcpServers: { "espn-f": launch(c1) } } }),
      );
      expect(odd.sessions, JSON.stringify(key)).toEqual([]);
      expect(
        odd.entries.map((e) => [e.absent, e.notDirectory]),
        JSON.stringify(key),
      ).toEqual([[true, undefined]]);
      const ro = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [odd]);
      expect(ro.details.join("\n"), JSON.stringify(key)).not.toContain("doctor cannot check");
    }
    // under a git work tree: purge only while nothing is there
    const top = dirAt(sb.home, "repo");
    write(path.join(top, ".git", "HEAD"), "ref: refs/heads/main\n");
    const inside = path.join(top, "not-a-dir");
    write(inside, "x");
    const scan2 = scanClientConfig(
      "code",
      claudeJsonWith(sb.home, {}, { [inside]: { mcpServers: { "espn-f": launch(c1) } } }),
    );
    const steps2 = manualSteps(sb.home, [], { scans: [scan2], plugin: null }).join("\n");
    expect(steps2).not.toContain("mkdir -p");
    expect(steps2).toContain(
      `recorded for ${inside}, which is not a directory, so never started — to remove it: move ${inside} aside, then claude purge ${inside} while nothing is there, then move it back; with ${inside} there, claude purge also acts on the record of the git work tree at ${top}`,
    );
  });
});

// Refix round 5 (rulings D-7, D-8; re-verifier 2's VR4-1…VR4-4 on 552e3d3): the key Claude Code
// 2.1.308 files a recorded project directory under, terminal controls in what is printed, and the
// plugin fixes' alternatives followed in a model of ~/.claude.json — each case failed before its fix.
describe("Refix round 5: Claude Code's own key for a project, display safety, and alternatives that strip or duplicate nothing (D-7, D-8, VR4-1…VR4-4)", () => {
  const knownOf = (home: string): string =>
    path.join(home, ".claude", "plugins", "known_marketplaces.json");
  const PLUGIN_SERVER = "plugin:espn-fantasy-football:espn-fantasy-football";
  const UNINSTALL = `uninstall the plugin (\`claude plugin uninstall ${PLUGIN_ID}\`)`;
  const ADD_USER =
    "this server is added at user scope (`eff print-config --client code` prints the command)";
  const OUTSIDE = "every session outside the projects Claude Code records";
  const PLUGIN_LIST_TEXT =
    'see whether Claude Code loads the plugin with `claude plugin list` (its "Read from" line)';
  const CLOSED = "with every Claude Code session closed and the file backed up first";
  const claudeJsonWith = (
    home: string,
    user: Record<string, unknown>,
    projects: Record<string, unknown>,
  ): string => {
    const file = path.join(home, ".claude.json");
    write(file, { mcpServers: user, projects });
    return file;
  };
  const dirAt = (...parts: string[]): string => {
    const d = path.join(...parts);
    mkdirSync(d, { recursive: true });
    return d;
  };
  /** A linked worktree `w` of the repository `main`, as `git worktree add` lays it out. */
  const linkedWorktree = (main: string, w: string, name: string): string => {
    write(path.join(main, ".git", "HEAD"), "ref: refs/heads/main\n");
    const admin = path.join(main, ".git", "worktrees", name);
    write(path.join(admin, "commondir"), "../..\n");
    write(path.join(admin, "gitdir"), `${path.join(w, ".git")}\n`);
    write(path.join(w, ".git"), `gitdir: ${admin}\n`);
    return admin;
  };

  /** ~/.claude.json as the simulation edits it, and whether the plugin is installed and loads. */
  interface Model {
    user: Record<string, unknown>;
    projects: Record<
      string,
      { mcpServers?: Record<string, unknown>; disabledMcpServers?: string[] }
    >;
    plugin: boolean;
  }
  const edit = (m: Model, f: (x: Model) => void): Model => {
    const x = structuredClone(m);
    f(x);
    return x;
  };
  /**
   * The servers each session starts under the model — this test's own reading of Claude Code
   * 2.1.308, independent of client-config.ts: the user scope and the session's local scope, one
   * server per distinct key, less what `/mcp disable` turned off there; the plugin unless turned off
   * there. null: a session outside every recorded project.
   */
  const started = (m: Model): Map<string | null, number> => {
    const out = new Map<string | null, number>();
    for (const dir of [null, ...Object.keys(m.projects)]) {
      const rec = dir === null ? {} : (m.projects[dir] ?? {});
      const off = new Set(rec.disabledMcpServers ?? []);
      const keys = new Set(
        [...Object.keys(m.user), ...Object.keys(rec.mcpServers ?? {})].filter((k) => !off.has(k)),
      );
      out.set(dir, keys.size + (m.plugin && !off.has(PLUGIN_SERVER) ? 1 : 0));
    }
    return out;
  };
  /** Following an alternative: each session that started a server starts one, none starts two. */
  const expectOneEach = (before: Model, after: Model, label: string): void => {
    const was = started(before);
    for (const [dir, n] of started(after))
      if ((was.get(dir) ?? 0) > 0) expect(n, `${label}: ${String(dir)}`).toBe(1);
      else expect(n, `${label}: ${String(dir)}`).toBeLessThanOrEqual(1);
  };

  it("a recorded directory below a git work tree is no session: Claude Code 2.1.308 files its sessions under the work tree, so its local entries never start — said once, never counted, judged or 'twice', never a FAIL, and never a `claude mcp remove` or `claude purge` that would act on the work tree's record (D-7, VR4-4)", async () => {
    sb = sandbox();
    const one = espnCopy(path.join(sb.home, "src", "espn-fantasy-football-mcp"));
    const c1 = path.join(one, "dist", "cli.js");
    write(path.join(sb.home, ".git", "HEAD"), "ref: refs/heads/main\n");
    const proj = dirAt(sb.home, "proj");
    // ours by key with its build gone: counted, it would FAIL; two keys: counted, it would be "twice"
    const broken = path.join(sb.home, "gone-build", "dist", "cli.js");
    const file = claudeJsonWith(
      sb.home,
      {},
      {
        // the work tree's own record holds another server under this server's key (VR4-4's P4)
        [sb.home]: {
          mcpServers: { "espn-fantasy-football": { command: "uvx", args: ["other"] } },
        },
        [proj]: {
          mcpServers: { "espn-fantasy-football": launch(broken), "espn-two": launch(c1) },
        },
      },
    );
    const scan = scanClientConfig("code", file);
    expect(scan.sessions.map((v) => v.dir)).toEqual([sb.home]);
    expect(scan.entries.map((e) => [e.name, e.absent, e.filedUnder])).toEqual([
      ["espn-fantasy-football", true, { at: sb.home, how: "work tree" }],
      ["espn-two", true, { at: sb.home, how: "work tree" }],
    ]);
    const r = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [scan]);
    // it was: FAIL on the broken entry and "twice" — for a record no session of 2.1.308 reads
    expect(r.status).toBe("warn");
    expect(r.message).toBe("no client is configured to launch this server");
    const filedLine = `code (local scope, ${proj}): two entries recorded for ${proj}, which Claude Code 2.1.308 files under the git work tree at ${sb.home}, so it never starts them — not counted`;
    expect(r.details.filter((l) => l.includes(`recorded for ${proj}`))).toEqual([filedLine]);
    expect(r.details.join("\n")).not.toMatch(/entry ok|under another key|does not exist/u);
    // the env is still scanned (row 3)
    expect(scan.envBlocks.length).toBe(0);
    // uninstall: never the work tree's record
    const steps = manualSteps(sb.home, [], { scans: [scan], plugin: null }).join("\n");
    expect(steps).not.toContain(`cd ${proj}`);
    expect(steps).not.toContain(`claude purge ${proj}`);
    expect(steps).not.toContain("mkdir -p");
    expect(codeProjectKey(sb.home)).toEqual({ kind: "self" });
    expect(codeProjectKey(proj)).toEqual({ kind: "other", at: sb.home, how: "work tree" });
    const filedRemoval = (key: string): string =>
      `delete projects[${JSON.stringify(proj)}].mcpServers[${JSON.stringify(key)}] from ${file} by hand, ${CLOSED} (\`claude mcp remove\` there, or \`claude purge\` of it while it exists, acts on the record of ${sb.home})`;
    expect(steps).toContain(
      `Claude Code (local scope, project ${proj}): recorded for ${proj}, which Claude Code 2.1.308 files under the git work tree at ${sb.home}, so never started — removing it is optional: ${filedRemoval("espn-fantasy-football")}`,
    );
    expect(steps).toContain(
      `Claude Code (local scope, project ${proj}) registers this server under the key "espn-two": recorded for ${proj}, which Claude Code 2.1.308 files under the git work tree at ${sb.home}, so never started — removing it is optional: ${filedRemoval("espn-two")}`,
    );
    // the hand edit names exactly the record it changes: deleting it leaves every other record
    const before = JSON.parse(readFileSync(file, "utf8")) as {
      projects: Record<string, { mcpServers: Record<string, unknown> }>;
    };
    const after = structuredClone(before);
    delete after.projects[proj]?.mcpServers["espn-two"];
    expect(after.projects[sb.home]).toEqual(before.projects[sb.home]);
    // a project-scope file there: no session doctor models reads it — said as such, never "gone"
    write(path.join(proj, ".mcp.json"), { mcpServers: { "espn-p": launch(c1) } });
    const withFile = scanClientConfig("code", file);
    expect(withFile.entries.find((e) => e.name === "espn-p")?.filedBelow).toBe(true);
    const rf = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [withFile]);
    expect(rf.details).toContain(
      `code (project scope, ${path.join(proj, ".mcp.json")}): every project directory Claude Code records at or below ${proj} is gone or filed under another key (Claude Code 2.1.308 files a session under its git work tree or real path), so no session doctor models reads it — not counted (a session opened there is doctor's known limit D-2)`,
    );
  });

  it("a linked worktree is filed under its main repository (or its bare repository); a submodule, a worktree whose back-pointer names another .git, and the main repository itself are their own keys; a directory reached through a symbolic link is filed under its real path (D-7)", async () => {
    sb = sandbox();
    const one = espnCopy(path.join(sb.home, "src", "espn-fantasy-football-mcp"));
    const c1 = path.join(one, "dist", "cli.js");
    const main_ = dirAt(sb.home, "main");
    const w = dirAt(sb.home, "w");
    linkedWorktree(main_, w, "w");
    const inW = dirAt(w, "sub");
    // a back-pointer naming another .git: Claude Code keeps the worktree as its own key
    const w2 = dirAt(sb.home, "w2");
    const admin2 = linkedWorktree(main_, w2, "w2");
    // (one that exists: the main repository's own .git)
    write(path.join(admin2, "gitdir"), `${path.join(main_, ".git")}\n`);
    // a submodule (its gitdir has no commondir) and a .git file that is no gitdir line: their own
    const sm = dirAt(sb.home, "sm");
    dirAt(main_, ".git", "modules", "sm");
    write(path.join(sm, ".git"), `gitdir: ${path.join(main_, ".git", "modules", "sm")}\n`);
    const odd = dirAt(sb.home, "odd");
    write(path.join(odd, ".git"), "not a pointer\n");
    // a bare repository's worktree: the bare repository
    const bare = dirAt(sb.home, "bare.git");
    write(path.join(bare, "HEAD"), "ref: refs/heads/main\n");
    const bw = dirAt(sb.home, "bw");
    const badmin = path.join(bare, "worktrees", "bw");
    write(path.join(badmin, "commondir"), "../..\n");
    write(path.join(badmin, "gitdir"), `${path.join(bw, ".git")}\n`);
    write(path.join(bw, ".git"), `gitdir: ${badmin}\n`);
    // a directory reached through a symbolic link: Claude Code keys the session by its real path
    const realDir = dirAt(sb.home, "real-proj");
    const link = path.join(sb.home, "link-proj");
    symlinkSync(realDir, link);
    const file = claudeJsonWith(
      sb.home,
      {},
      {
        [main_]: { mcpServers: { "espn-fantasy-football": { command: "uvx", args: ["other"] } } },
        [w]: { mcpServers: { "espn-fantasy-football": launch(c1) } },
        [link]: { mcpServers: { "espn-fantasy-football": launch(c1) } },
        [sm]: {},
      },
    );
    const scan = scanClientConfig("code", file);
    expect(scan.sessions.map((v) => v.dir).sort()).toEqual([main_, sm].sort());
    const r = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [scan]);
    expect(r.details).toContain(
      `code (local scope, ${w}): recorded for ${w}, which Claude Code 2.1.308 files under the main repository at ${main_} of the linked worktree it is in, so it never starts it — not counted`,
    );
    expect(r.details).toContain(
      `code (local scope, ${link}): recorded for ${link}, which Claude Code 2.1.308 files under its real path ${realDir}, so it never starts it — not counted`,
    );
    const steps = manualSteps(sb.home, [], { scans: [scan], plugin: null }).join("\n");
    for (const d of [w, link]) {
      expect(steps).not.toContain(`cd ${d}`);
      expect(steps).not.toContain(`claude purge ${d}`);
    }
    expect(steps).toContain(
      `delete projects[${JSON.stringify(w)}].mcpServers["espn-fantasy-football"] from ${file} by hand, ${CLOSED} (\`claude mcp remove\` there, or \`claude purge\` of it while it exists, acts on the record of ${main_})`,
    );
    // a gone directory below the symbolic link: once made, it would be filed under its real path,
    // so no `mkdir -p` (it was: `mkdir -p <link>/gone && cd … && claude mcp remove`, which acts on
    // the real path's record)
    const goneBelowLink = path.join(link, "gone");
    const goneScan = scanClientConfig(
      "code",
      claudeJsonWith(
        sb.home,
        {},
        { [goneBelowLink]: { mcpServers: { "espn-fantasy-football": launch(c1) } } },
      ),
    );
    const goneSteps = manualSteps(sb.home, [], { scans: [goneScan], plugin: null }).join("\n");
    expect(goneSteps).not.toContain("mkdir -p");
    expect(goneSteps).toContain(
      `to remove it: claude purge ${goneBelowLink} while ${goneBelowLink} does not exist (it deletes all of Claude Code's state for that directory); never make ${goneBelowLink} first: Claude Code files a session there under its real path ${path.join(realDir, "gone")}, so \`claude mcp remove\` there, or \`claude purge\` once it exists, acts on ${path.join(realDir, "gone")}'s record`,
    );
    // a key that differs from the directory's stored name in case only (a case-insensitive
    // filesystem: macOS): Claude Code's working directory is the system's real path, stored case
    const stored = dirAt(sb.home, "CaseDir");
    const folded = path.join(sb.home, "casedir");
    if (realpathSync.native(sb.home) === sb.home && existsSync(folded))
      expect(codeProjectKey(folded)).toEqual({ kind: "other", at: stored, how: "real path" });
    // a commondir that is a directory or a symbolic link (2.1.308 reads neither): its own key
    for (const [n, make] of [
      [
        "cdir",
        (f: string) => {
          mkdirSync(f);
        },
      ],
      [
        "clink",
        (f: string) => {
          symlinkSync(path.join(main_, ".git"), f);
        },
      ],
    ] as const) {
      const wt = dirAt(sb.home, n);
      const adm = linkedWorktree(main_, wt, n);
      rmSync(path.join(adm, "commondir"));
      make(path.join(adm, "commondir"));
      expect(codeProjectKey(wt), n).toEqual({ kind: "self" });
    }
    // a commondir that names no directory holding this worktree's admin directory: its own key
    const wx = dirAt(sb.home, "wx");
    const admx = linkedWorktree(main_, wx, "wx");
    write(path.join(admx, "commondir"), `${path.join(sb.home, "other", ".git")}\n`);
    expect(codeProjectKey(wx)).toEqual({ kind: "self" });
    // a gitdir reached through a symbolic link: doctor cannot tell
    const mainLink = path.join(sb.home, "main-link");
    symlinkSync(main_, mainLink);
    const wl = dirAt(sb.home, "wl");
    linkedWorktree(main_, wl, "wl");
    write(path.join(wl, ".git"), `gitdir: ${path.join(mainLink, ".git", "worktrees", "wl")}\n`);
    expect(codeProjectKey(wl)).toEqual({
      kind: "unknown",
      why: `${path.join(mainLink, ".git", "worktrees", "wl")} passes through a symbolic link, which doctor does not follow`,
    });
    // a bare-named common directory that holds a .git of its own: the worktree's own key
    const odd2 = dirAt(sb.home, "odd2.git");
    write(path.join(odd2, ".git", "HEAD"), "ref: refs/heads/main\n");
    const ow = dirAt(sb.home, "ow");
    const oadmin = path.join(odd2, "worktrees", "ow");
    write(path.join(oadmin, "commondir"), "../..\n");
    write(path.join(oadmin, "gitdir"), `${path.join(ow, ".git")}\n`);
    write(path.join(ow, ".git"), `gitdir: ${oadmin}\n`);
    expect(codeProjectKey(ow)).toEqual({ kind: "self" });
    // a name stored decomposed (NFD) and recorded composed (NFC), as Claude Code writes its keys:
    // the key is NFC, so the record is the directory's own (where the filesystem maps the two)
    const nfd = dirAt(sb.home, "cafe\u0301");
    const nfc = path.join(sb.home, "caf\u00e9");
    if (existsSync(nfc) && realpathSync.native(nfc) === nfd)
      expect(codeProjectKey(nfc)).toEqual({ kind: "self" });
    // the keys themselves
    expect(codeProjectKey(w2)).toEqual({ kind: "self" });
    expect(codeProjectKey(sm)).toEqual({ kind: "self" });
    expect(codeProjectKey(odd)).toEqual({ kind: "self" });
    expect(codeProjectKey(bw)).toEqual({ kind: "other", at: bare, how: "bare repository" });
    expect(codeProjectKey(main_)).toEqual({ kind: "self" });
    expect(codeProjectKey(w)).toEqual({ kind: "other", at: main_, how: "main repository" });
    expect(codeProjectKey(inW)).toEqual({ kind: "other", at: main_, how: "main repository" });
    expect(codeProjectKey(link)).toEqual({ kind: "other", at: realDir, how: "real path" });
  });

  it("a .git doctor cannot follow (a symbolic link, unreadable, past its bound, a commondir it cannot read): the directory stays a session — a broken entry there still FAILs — but no `claude mcp remove --scope local` is printed for it, and the detail says why (D-7 (d))", async () => {
    sb = sandbox();
    const one = espnCopy(path.join(sb.home, "src", "espn-fantasy-football-mcp"));
    const c1 = path.join(one, "dist", "cli.js");
    const main_ = dirAt(sb.home, "main");
    write(path.join(main_, ".git", "HEAD"), "ref: refs/heads/main\n");
    const linked = dirAt(sb.home, "linked");
    symlinkSync(path.join(main_, ".git"), path.join(linked, ".git"));
    const big = dirAt(sb.home, "big");
    write(path.join(big, ".git"), `gitdir: ${"x".repeat(MAX_GIT_POINTER_BYTES)}\n`);
    const cases: string[] = [linked, big];
    if (process.getuid?.() !== 0) {
      const locked = dirAt(sb.home, "locked");
      write(path.join(locked, ".git"), "gitdir: /placeholder/.git/worktrees/x\n");
      chmodSync(path.join(locked, ".git"), 0o000);
      const w = dirAt(sb.home, "w");
      const admin = linkedWorktree(main_, w, "w");
      chmodSync(path.join(admin, "commondir"), 0o000);
      cases.push(locked, w);
    }
    const broken = path.join(sb.home, "gone-build", "dist", "cli.js");
    try {
      for (const d of cases) {
        const file = claudeJsonWith(
          sb.home,
          { "espn-fantasy-football": launch(c1) },
          {
            [d]: { mcpServers: { "espn-d": launch(c1), "espn-fantasy-football": launch(broken) } },
          },
        );
        const scan = scanClientConfig("code", file);
        const r = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [scan]);
        // the broken entry there is still judged, and the duplicate's removal is the hand edit,
        // never the command (it was: `cd <d> && claude mcp remove --scope local espn-d`)
        expect(r.status, d).toBe("fail");
        expect(r.fix, d).not.toContain(`cd ${d}`);
        expect(
          scan.sessions.map((v) => [v.dir, v.keyUnknown !== undefined]),
          d,
        ).toEqual([[d, true]]);
        const why = codeProjectKey(d);
        expect(why.kind, d).toBe("unknown");
        expect(r.details, d).toContain(
          `code: doctor cannot tell which record Claude Code 2.1.308 files a session in ${d} under (${why.kind === "unknown" ? why.why : ""}): it is counted as a session, and its local-scope entries are removed by hand, never with \`claude mcp remove\``,
        );
        expect(r.fix, d).toContain(
          `delete projects[${JSON.stringify(d)}].mcpServers["espn-d"] from ${file} by hand, ${CLOSED} (doctor cannot tell which record \`claude mcp remove\` there acts on: `,
        );
        const steps = manualSteps(sb.home, [], { scans: [scan], plugin: null }).join("\n");
        expect(steps, d).not.toContain(`cd ${d}`);
        expect(steps, d).toContain(`delete projects[${JSON.stringify(d)}].mcpServers["espn-d"]`);
      }
      expect(codeProjectKey(linked)).toEqual({
        kind: "unknown",
        why: `${path.join(linked, ".git")} is a symbolic link, which doctor does not follow`,
      });
      expect(codeProjectKey(big).kind).toBe("unknown");
    } finally {
      if (process.getuid?.() !== 0) {
        chmodSync(path.join(sb.home, "locked", ".git"), 0o644);
        chmodSync(path.join(main_, ".git", "worktrees", "w", "commondir"), 0o644);
      }
    }
  });

  it("the owner's layout is unchanged: every clone is its own git root and the home directory its own key, so all stay sessions (D-7)", () => {
    sb = sandbox();
    const { folder } = installPlugin(sb.home, folderMarketplace(sb.home));
    const dev = espnCopy(path.join(sb.home, "Developer", "espn-fantasy-football-mcp"));
    const yahooRoot = path.dirname(path.dirname(yahooClone(sb.home)));
    write(path.join(yahooRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
    for (const d of [folder, dev, yahooRoot, sb.home])
      expect(codeProjectKey(d), d).toEqual({ kind: "self" });
  });

  it("every terminal control in a key, a project directory or a marketplace record is printed escaped — doctor text and --json, uninstall, print-config — and a command whose words hold one is never printed (D-8)", async () => {
    const CONTROLS: Record<string, string> = {
      ESC: "\u001b[31m",
      CR: "\r",
      LF: "\n",
      TAB: "\t",
      DEL: "\u007f",
      "C1 NEL": "\u0085",
      "C1 CSI": "\u009b",
      "bidi RLO": "\u202e",
      "bidi isolate": "\u2066",
      "bidi ALM": "\u061c",
      "bidi LRM": "\u200e",
      "line separator": "\u2028",
    };
    // any control at all (a printed line); the raw JSON text keeps only its own line breaks
    const ANY =
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/u;
    const IN_JSON =
      /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/u;
    for (const [label, c] of Object.entries(CONTROLS)) {
      sb = sandbox({ create: true });
      const one = espnCopy(path.join(sb.home, "src", "espn-fantasy-football-mcp"));
      const c1 = path.join(one, "dist", "cli.js");
      const p = dirAt(sb.home, `p${c}q`);
      const key = `espn${c}k`;
      const file = claudeJsonWith(
        sb.home,
        { "espn-fantasy-football": launch(c1) },
        { [p]: { mcpServers: { [key]: launch(c1) } } },
      );
      // the plugin enabled from a folder marketplace whose recorded path holds the control (there,
      // listing the plugin, never built — rows 2 and 24 name it), beside a second marketplace
      // record whose name holds it
      const mk = dirAt(sb.home, `mk${c}dir`);
      write(path.join(mk, ".claude-plugin", "plugin.json"), MANIFEST);
      write(path.join(mk, ".claude-plugin", "marketplace.json"), LISTING);
      write(path.join(sb.home, ".claude", "settings.json"), {
        enabledPlugins: { [PLUGIN_ID]: true },
      });
      write(knownOf(sb.home), {
        [MARKETPLACE]: recorded({ source: "directory", path: mk }),
        [`mk${c}`]: recorded({ source: "github", repo: "x/y" }),
      });
      const scan = scanClientConfig("code", file);
      const r = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [scan], scanPlugin(sb.home));
      const row2 = [r.message, r.fix ?? "", ...r.details];
      for (const l of row2) expect(l, label).not.toMatch(ANY);
      expect(row2.join("\n"), label).toContain(escapeControls(p));
      expect(row2.join("\n"), label).toContain(escapeControls(path.join(sb.home, `mk${c}dir`)));
      // the duplicate's removal: by hand, never a command holding the control
      expect(r.fix, label).not.toContain("claude mcp remove --scope local");
      expect(r.fix, label).toContain(
        `delete projects[${escapeControls(JSON.stringify(p))}].mcpServers[${escapeControls(JSON.stringify(key))}] from ${file} by hand, ${CLOSED} (its key and directory hold a control character, which no command shows as it runs)`,
      );
      const env = { ESPN_LEAGUE_ID: "0", EFF_CREDENTIAL_STORE: "file" };
      // doctor run from an installed package (no checkout: row 24 judges the plugin's folder)
      const installed = fakePackage(sb);
      const asJson = makeIo(sb, { exec: shimOk, env, packageRoot: installed });
      await main(["doctor", "--json"], asJson);
      expect(asJson.out.text, label).not.toMatch(IN_JSON);
      const doc = JSON.parse(asJson.out.text) as {
        rows: { n: number; message: string; fix: string | null; details: string[] }[];
      };
      for (const x of doc.rows)
        for (const l of [x.message, x.fix ?? "", ...x.details]) expect(l, label).not.toMatch(ANY);
      const row24 = doc.rows.find((x) => x.n === 24);
      expect(row24?.fix, label).toContain(escapeControls(mk));
      expect(row24?.details.join("\n"), label).toContain(escapeControls(mk));
      const asText = makeIo(sb, { exec: shimOk, env, packageRoot: installed });
      await main(["doctor"], asText);
      for (const l of asText.out.text.split("\n")) expect(l, label).not.toMatch(ANY);
      expect(asText.out.text, label).toContain(escapeControls(p));
      const steps = manualSteps(sb.home, [], findRegistrations(sb.home));
      for (const l of steps) expect(l, label).not.toMatch(ANY);
      const stepText = steps.join("\n");
      expect(stepText, label).not.toContain("claude mcp remove --scope local");
      expect(stepText, label).toContain(escapeControls(path.join(sb.home, `mk${c}dir`)));
      // a gone directory holding it: no mkdir, no purge — the hand edit
      const gone = path.join(sb.home, `gone${c}dir`);
      const goneScan = scanClientConfig(
        "code",
        claudeJsonWith(
          sb.home,
          {},
          { [gone]: { mcpServers: { "espn-fantasy-football": launch(c1) } } },
        ),
      );
      const goneSteps = manualSteps(sb.home, [], { scans: [goneScan], plugin: null });
      for (const l of goneSteps) expect(l, label).not.toMatch(ANY);
      expect(goneSteps.join("\n"), label).not.toMatch(/mkdir -p|claude purge/u);
      expect(goneSteps.join("\n"), label).toContain(
        `delete projects[${escapeControls(JSON.stringify(gone))}].mcpServers["espn-fantasy-football"] from`,
      );
      // a choice that is the user's (every removal strips a session), with a local entry whose
      // key holds the control: its removal there is the hand edit too
      const ax = path.join(sb.home, "a", "x");
      write(path.join(sb.home, "a", ".mcp.json"), { mcpServers: { "espn-1": launch(c1) } });
      write(path.join(ax, ".mcp.json"), { mcpServers: { "espn-2": launch(c1) } });
      write(path.join(ax, "z", ".claude", "settings.local.json"), {
        disabledMcpjsonServers: ["espn-1"],
      });
      dirAt(sb.home, "a", "y");
      const stuck = scanClientConfig(
        "code",
        claudeJsonWith(
          sb.home,
          {},
          {
            [ax]: { mcpServers: { [key]: launch(c1) } },
            [path.join(ax, "z")]: {},
            [path.join(sb.home, "a", "y")]: {},
          },
        ),
      );
      const rs = await checkLaunchConfig(makeIo(sb, { exec: shimOk }), [stuck]);
      expect(rs.fix, label).toContain(
        `; a local-scope entry is removed instead: delete projects[${JSON.stringify(ax)}].mcpServers[${escapeControls(JSON.stringify(key))}] from`,
      );
      expect(rs.fix, label).not.toContain("with its own `claude mcp remove --scope local`");
      // print-config: its warnings, with a runtime install whose path holds the control
      const pkg = dirAt(sb.dir, `pkg${c}x`);
      const pc = makeIo(sb, { packageRoot: pkg, env: { ESPN_LEAGUE_ID: "0" } });
      await main(["print-config", "--client", "code"], pc);
      expect(pc.err.text, label).toContain(escapeControls(path.join(pkg, "dist", "cli.js")));
      for (const l of pc.err.text.split("\n")) expect(l, label).not.toMatch(ANY);
      sb.cleanup();
    }
    expect(escapeControls("a\u001bb\u202ec")).toBe("a\\u{1b}b\\u{202e}c");
    expect(escapeControls(escapeControls("x\u0085"))).toBe("x\\u{85}");
    // a control in first place, in a key of any scope: the hand edit, never the command
    expect(holdsControl("\u001bk")).toBe(true);
    expect(holdsControl("k")).toBe(false);
    expect(
      removalOf({ scope: "user", dir: null, name: "\u001bk", file: "/f/.claude.json" }),
    ).toEqual({
      byHand: `delete mcpServers["\\u001bk"] from /f/.claude.json by hand, ${CLOSED} (its key holds a control character, which no command shows as it runs)`,
    });
    expect(
      removalOf({ scope: "project", dir: "/p\u202e", name: "k", file: "/p/.mcp.json" }),
    ).toEqual({
      byHand: `delete mcpServers["k"] from /p\u202e/.mcp.json by hand, the file backed up first (its directory holds a control character, which no command shows as it runs)`,
    });
    sb = sandbox();
  });

  it("beside a plugin doctor cannot tell Claude Code loads, the fix never ends with 'keep only the plugin' — which removes the entry a project that turned the plugin off still needs; the repair is followed by the keep-one fix of a plugin it loads (VR4-1)", async () => {
    for (const label of ["a refused registry", "a refused listing source"] as const) {
      sb = sandbox();
      const { folder } = installPlugin(sb.home, folderMarketplace(sb.home));
      if (label === "a refused registry")
        write(knownOf(sb.home), {
          [MARKETPLACE]: folderMarketplace(sb.home),
          "other-market": recorded({ source: "claudeai" }),
        });
      else
        write(path.join(folder, ".claude-plugin", "marketplace.json"), {
          name: MARKETPLACE,
          plugins: [{ name: "espn-fantasy-football", source: folder }],
        });
      const a = dirAt(sb.home, "a");
      const model: Model = {
        user: { "espn-fantasy-football": launch(path.join(folder, "dist", "cli.js")) },
        projects: { [a]: { disabledMcpServers: [PLUGIN_SERVER] } },
        plugin: true,
      };
      const file = claudeJsonWith(sb.home, model.user, model.projects);
      const io = makeIo(sb, { exec: shimOk });
      const r = await checkLaunchConfig(io, [scanClientConfig("code", file)], scanPlugin(sb.home));
      expect(r.status, label).toBe("warn");
      // it was: "… — or repair … as row 2's detail says … and keep only the plugin; then restart
      // the client": that removes the user-scope entry, a's only server
      expect(r.fix, label).not.toContain("keep only the plugin");
      expect(started(edit(model, (x) => (x.user = {}))).get(a), label).toBe(0);
      const repair =
        label === "a refused registry"
          ? "repair ~/.claude/plugins/known_marketplaces.json as row 2's detail says"
          : "repair the plugin's source in its marketplace listing as row 2's detail says (the runtime clone's committed listing names it `./`, README step 5)";
      const planA = `outside the projects Claude Code records, the plugin and "espn-fantasy-football" start, and removing it leaves a project that turns the plugin off with no server — turn the plugin back on there (\`/mcp enable ${PLUGIN_SERVER}\` in a session there), or keep it only there (\`claude mcp add --scope local\` in that project, then \`claude mcp remove --scope user espn-fantasy-football\`)`;
      expect(r.fix, label).toBe(
        `${PLUGIN_LIST_TEXT}: if it does, keep one: ${planA}, or ${UNINSTALL}; if it does not, keep the entry — or ${repair} so that it loads the plugin, then keep one as for a plugin it loads (above); then restart the client`,
      );
      // each alternative followed: uninstalling the plugin, or keeping the entry where it does not load
      expectOneEach(
        model,
        edit(model, (x) => (x.plugin = false)),
        `${label}: uninstall`,
      );
      // the repair followed: the plugin loads, and the fix is the keep-one fix of a loading plugin
      if (label === "a refused registry")
        write(knownOf(sb.home), {
          [MARKETPLACE]: folderMarketplace(sb.home),
          "other-market": recorded({ source: "github", repo: "x/y" }),
        });
      else write(path.join(folder, ".claude-plugin", "marketplace.json"), LISTING);
      const repaired = await checkLaunchConfig(
        io,
        [scanClientConfig("code", file)],
        scanPlugin(sb.home),
      );
      expect(repaired.fix, label).toBe(
        `keep one: ${planA}, or ${UNINSTALL}; then restart the client`,
      );
      sb.cleanup();
    }
    sb = sandbox();
  });

  it("uninstalling the plugin once this server is added at user scope: a stripped project that turned `espn-fantasy-football` off turns it back on first, and the step's removals are planned with the user-scope entry, so it never makes a duplicate (VR4-2, VR4-3)", async () => {
    sb = sandbox();
    const { folder } = installPlugin(sb.home, folderMarketplace(sb.home));
    const c1 = path.join(folder, "dist", "cli.js");
    const [a, b, c] = ["a", "b", "c"].map((n) => dirAt(sb.home, n)) as [string, string, string];
    const io = makeIo(sb, { exec: shimOk });
    const run = async (m: Model) => {
      const scan = scanClientConfig("code", claudeJsonWith(sb.home, m.user, m.projects));
      return checkLaunchConfig(io, [scan], scanPlugin(sb.home));
    };
    // P2: a local entry in a; c turned this server's key off (and has no entry of its own)
    const p2: Model = {
      user: {},
      projects: {
        [a]: { mcpServers: { "espn-fantasy-football": launch(c1) } },
        [c]: { disabledMcpServers: ["espn-fantasy-football"] },
      },
      plugin: true,
    };
    const r2 = await run(p2);
    // it was: "… — only once this server is added at user scope (…): uninstalling it now leaves c
    // and … with no server" — the new entry is off in c, so c was left with none
    expect(r2.fix).toBe(
      `keep one: remove the \`claude mcp add\` entry (\`cd ${a} && claude mcp remove --scope local espn-fantasy-football\`), or ${UNINSTALL} — only once ${ADD_USER} and "espn-fantasy-football" is turned back on in ${c} (\`/mcp enable <name>\` in a session there): uninstalling it now leaves ${c} and ${OUTSIDE} with no server; then restart the client`,
    );
    expect(r2.details).toContain(
      `code: \`espn-fantasy-football\` is turned off in ${c} (\`/mcp disable\`: \`disabledMcpServers\` in ~/.claude.json) — the user-scope entry the fix adds does not start there until it is turned back on`,
    );
    // no duplicate, so no fix: the key c turns off is not said (nothing would add it)
    const quiet = await run({
      user: {},
      projects: { [c]: { disabledMcpServers: ["espn-fantasy-football"] } },
      plugin: true,
    });
    expect(quiet.fix).toBeNull();
    expect(quiet.details.join("\n")).not.toContain("the user-scope entry the fix adds");
    const user = { "espn-fantasy-football": launch(c1) };
    const oldP2 = edit(p2, (x) => {
      x.user = user;
      x.plugin = false;
    });
    expect(started(oldP2).get(c)).toBe(0);
    expectOneEach(
      p2,
      edit(oldP2, (x) => (x.projects[c] = { disabledMcpServers: [] })),
      "P2: uninstall",
    );
    expectOneEach(
      p2,
      edit(p2, (x) => delete x.projects[a]?.mcpServers),
      "P2: keep the plugin",
    );
    // P3: a local entry under another key in a, b empty
    const p3: Model = {
      user: {},
      projects: { [a]: { mcpServers: { "espn-a": launch(c1) } }, [b]: {} },
      plugin: true,
    };
    const r3 = await run(p3);
    // it was: "…, or uninstall the plugin (…) — only once this server is added at user scope …" —
    // which leaves a starting espn-a beside the new user-scope entry
    expect(r3.fix).toBe(
      `keep one: remove the \`claude mcp add\` entry (\`cd ${a} && claude mcp remove --scope local espn-a\`), or ${UNINSTALL} and remove the other entry (\`cd ${a} && claude mcp remove --scope local espn-a\`) — only once ${ADD_USER}: uninstalling it now leaves ${b} and ${OUTSIDE} with no server; then restart the client`,
    );
    const oldP3 = edit(p3, (x) => {
      x.user = user;
      x.plugin = false;
    });
    expect(started(oldP3).get(a)).toBe(2);
    expectOneEach(
      p3,
      edit(oldP3, (x) => delete x.projects[a]?.mcpServers),
      "P3: uninstall",
    );
    // both, and a project that turned its own entries off: with this server added at user scope,
    // only its key is turned back on — the turned-off entries would only be removed again
    const both: Model = {
      user: {},
      projects: {
        [a]: {
          mcpServers: { "espn-a": launch(c1), "espn-a2": launch(c1) },
          disabledMcpServers: ["espn-a", "espn-a2"],
        },
        [b]: { mcpServers: { "espn-b": launch(c1) } },
        [c]: { disabledMcpServers: ["espn-fantasy-football"] },
      },
      plugin: true,
    };
    const rb = await run(both);
    expect(rb.fix).toContain(
      `, or ${UNINSTALL} and remove the other entry (\`cd ${b} && claude mcp remove --scope local espn-b\`) — only once ${ADD_USER} and "espn-fantasy-football" is turned back on in ${c} (\`/mcp enable <name>\` in a session there): uninstalling it now leaves ${a}, ${c} and ${OUTSIDE} with no server; then restart the client`,
    );
    expectOneEach(
      both,
      edit(both, (x) => {
        x.user = user;
        x.plugin = false;
        delete x.projects[b]?.mcpServers;
        x.projects[c] = { disabledMcpServers: [] };
      }),
      "both: uninstall",
    );
  });
  it("the plan after the uninstall's first steps keeps the choice that is the user's where this server's key is off, and a stripped project turns back on its widest entry first (VR4-3, V3-1)", async () => {
    sb = sandbox();
    const { folder } = installPlugin(sb.home, folderMarketplace(sb.home));
    const c1 = path.join(folder, "dist", "cli.js");
    const plugin = { key: PLUGIN_SERVER, drops: () => false };
    const io = makeIo(sb, { exec: shimOk });
    // a/x runs espn-1 and espn-2, a/x/z only espn-2 (it declines espn-1), a/y only espn-1; each
    // turns this server's key off, so the user-scope entry the step adds does not start there
    const a = path.join(sb.home, "a");
    const ax = path.join(a, "x");
    write(path.join(a, ".mcp.json"), { mcpServers: { "espn-1": launch(c1) } });
    write(path.join(ax, ".mcp.json"), { mcpServers: { "espn-2": launch(c1) } });
    write(path.join(ax, "z", ".claude", "settings.local.json"), {
      disabledMcpjsonServers: ["espn-1"],
    });
    const off = { disabledMcpServers: ["espn-fantasy-football"] };
    const stuck = scanClientConfig(
      "code",
      claudeJsonWith(sb.home, {}, { [ax]: off, [path.join(ax, "z")]: off, [dirAt(a, "y")]: off }),
    );
    const r = await checkLaunchConfig(io, [stuck], scanPlugin(sb.home));
    expect(r.fix).toContain(
      `, or ${UNINSTALL} and in ${ax} ("espn-2", "espn-1"), removing any of them leaves another directory with no server — keep one there and turn the others off there (\`/mcp disable <name>\` in a session there; a project server can be declined in ${path.join(ax, ".claude", "settings.local.json")} instead, \`disabledMcpjsonServers\`) — only once ${ADD_USER}: uninstalling it now leaves ${OUTSIDE} with no server; then restart the client`,
    );
    // a stripped project with two entries turned off that reach as many sessions: the widest (the
    // user scope's) is the one turned back on
    const p = dirAt(sb.home, "P");
    write(path.join(p, ".mcp.json"), { mcpServers: { "espn-x": launch(c1) } });
    const s5 = dirAt(p, "s");
    const b5 = dirAt(p, "b");
    const tie = scanClientConfig(
      "code",
      claudeJsonWith(
        sb.home,
        { "espn-u": launch(c1) },
        {
          [s5]: { disabledMcpServers: ["espn-u", "espn-x"] },
          [b5]: { disabledMcpServers: ["espn-u"] },
        },
      ),
    );
    expect(
      duplicateRegistrations(tie.entries, tie.sessions, plugin).withPlugin?.uninstallStrips,
    ).toEqual([{ dir: s5, off: ["espn-u"] }]);
  });
});
