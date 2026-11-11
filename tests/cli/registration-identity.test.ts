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
  mkdirSync,
  readFileSync,
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
  duplicateRegistrations,
  installedPluginsPath as installedPluginsPathOf,
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
        'see whether Claude Code loads the plugin with `claude plugin list` (its "Read from" line); if it does not, repair ~/.claude/plugins/known_marketplaces.json as row 2\'s detail says, or add the marketplace again from the built runtime clone (`claude plugin marketplace add <the runtime clone>`, README step 5), then restart the client',
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
    // beside the plugin: removing every entry keeps the plugin; uninstalling it leaves the choice
    installPlugin(sb.home, folderMarketplace(sb.home));
    const beside = await checkLaunchConfig(io, [stuck], scanPlugin(sb.home));
    expect(beside.fix).toBe(
      `keep one: remove the \`claude mcp add\` entries (\`cd ${ax} && claude mcp remove --scope project espn-2\`, \`cd ${a} && claude mcp remove --scope project espn-1\`), or uninstall the plugin (\`claude plugin uninstall ${PLUGIN_ID}\`) and in ${ax} ("espn-2", "espn-1"), removing any of them leaves another directory with no server — keep one there and turn the others off there (\`/mcp disable <name>\` in a session there; a project server can be declined in ${path.join(ax, ".claude", "settings.local.json")} instead, \`disabledMcpjsonServers\`); then restart the client`,
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
        `see whether Claude Code loads the plugin with \`claude plugin list\` (its "Read from" line): if it does, keep one: remove the \`claude mcp add\` entry (\`claude mcp remove --scope user espn-fantasy-football\`), or uninstall the plugin (\`claude plugin uninstall ${PLUGIN_ID}\`); if it does not, keep the entry — or repair ~/.claude/plugins/known_marketplaces.json as row 2's detail says and keep only the plugin; then restart the client`,
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
      `see whether Claude Code loads the plugin with \`claude plugin list\` (its "Read from" line): if it does, keep one: remove the \`claude mcp add\` entries (\`claude mcp remove --scope user espn-fantasy-football\`, \`claude mcp remove --scope user espn-2\`), or uninstall the plugin (\`claude plugin uninstall ${PLUGIN_ID}\`) and remove the other entry (\`claude mcp remove --scope user espn-2\`); if it does not, keep one: remove the other entry (\`claude mcp remove --scope user espn-2\`) — or repair ~/.claude/plugins/known_marketplaces.json as row 2's detail says and keep only the plugin; then restart the client`,
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
    expect((await checkLaunchConfig(io, [first], scanPlugin(sb.home))).fix).toBe(
      `keep one: remove the \`claude mcp add\` entry (\`cd ${x} && claude mcp remove --scope project espn-p\`), or uninstall the plugin (\`claude plugin uninstall ${PLUGIN_ID}\`) and remove the other entry (\`cd ${xa} && claude mcp remove --scope local espn-la\`); then restart the client`,
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
      `keep one: remove the \`claude mcp add\` entry (\`cd ${x} && claude mcp remove --scope project espn-p2\`); in ${xb} ("espn-fantasy-football", beside the plugin), removing it leaves another directory with no server — turn it off there (\`/mcp disable <name>\` in a session there; a project server can be declined in ${path.join(xb, ".claude", "settings.local.json")} instead, \`disabledMcpjsonServers\`), or uninstall the plugin (\`claude plugin uninstall ${PLUGIN_ID}\`) and remove the other entry (\`cd ${x} && claude mcp remove --scope project espn-p2\`); then restart the client`,
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
