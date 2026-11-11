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
// Every file lives in a sandbox HOME; values and paths are placeholders; nothing is executed (the
// shim's `version --json` is a fake exec).
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeCommand, scanClientConfig, scanPlugin } from "../../src/cli/client-config.js";
import { checkLaunchConfig, checkStaleBuild } from "../../src/cli/doctor.js";
import { main } from "../../src/cli/main.js";
import { findRegistrations, manualSteps } from "../../src/cli/uninstall.js";
import { fakeExec, makeIo, ROOT, sandbox, type Sandbox } from "./helpers.js";

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
            "other-market": { source: { source: "github", repo: "x/y" } },
          },
    );
  return { folder, cache };
}

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

/** ~/.claude.json: the user scope, and the local scope of each project directory given. */
function claudeJson(
  home: string,
  user: Record<string, unknown>,
  local: Record<string, Record<string, unknown>> = {},
): string {
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
    expect(r.message).toContain("Claude Code registers this server twice");
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
    const leftover = `the cache copy ${cache} is a leftover of an earlier install: Claude Code reads the plugin in place from its folder marketplace (${folder}) and never runs that copy — nothing to do`;
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

  it("known_marketplaces.json missing, malformed or without the marketplace: the cache copy is judged as before, and the source is said to be unknown", () => {
    for (const record of [
      null,
      "{ not json",
      { "other-market": { source: { source: "github" } } },
    ]) {
      sb = sandbox();
      const { folder, cache } = installPlugin(sb.home, null);
      const known = path.join(sb.home, ".claude", "plugins", "known_marketplaces.json");
      if (record !== null) write(known, record);
      const plugin = scanPlugin(sb.home);
      expect(plugin?.origin.kind, JSON.stringify(record)).toBe("unknown");
      expect(plugin?.copies[0]?.root).toBe(cache);
      const r = checkStaleBuild(folder, plugin);
      expect(r.status, JSON.stringify(record)).toBe("fail");
      expect(r.message).toContain("plugin copy is older than this clone");
      const note = r.details.find((l) => l.startsWith("the plugin's source is unknown — "));
      expect(note, JSON.stringify(record)).toContain(
        `so the cache copy ${cache} is judged as what Claude Code runs`,
      );
      expect(note).toContain(
        record === null
          ? `${known} is missing`
          : typeof record === "string"
            ? `${known} is not JSON`
            : `${known} records no ${MARKETPLACE} marketplace with a source`,
      );
      sb.cleanup();
    }
    sb = sandbox(); // afterEach cleans one up
  });

  it("a listing whose plugin source leaves the marketplace folder (absolute, .., a symlink out) is refused: the cache copy is judged", () => {
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
      expect(plugin?.origin.kind, source).toBe("unknown");
      expect(plugin?.origin.kind === "unknown" ? plugin.origin.why : "", source).toContain(why);
      expect(plugin?.copies[0]?.root, source).toBe(cache);
      const r = checkStaleBuild(folder, plugin);
      expect(r.status, source).toBe("fail");
      expect(r.details.join("\n"), source).toContain(why);
    }
  });

  it("every other record or listing doctor cannot follow leaves the source unknown, never a folder", () => {
    sb = sandbox();
    const { folder, cache } = installPlugin(sb.home, folderMarketplace(sb.home));
    const known = path.join(sb.home, ".claude", "plugins", "known_marketplaces.json");
    const listing = path.join(folder, ".claude-plugin", "marketplace.json");
    const cases: [unknown, unknown, string][] = [
      [{ source: { source: "directory", path: "src/x" } }, null, "no absolute path"],
      [
        { source: { source: "file", path: path.join(folder, "m.json") } },
        null,
        "not in a .claude-plugin folder",
      ],
      [
        { source: { source: "directory", path: folder } },
        { name: MARKETPLACE, plugins: [] },
        "does not list",
      ],
      [
        { source: { source: "directory", path: folder } },
        { plugins: [{ name: "espn-fantasy-football" }] },
        "gives the espn-fantasy-football plugin no source",
      ],
      [
        { source: { source: "directory", path: folder } },
        { plugins: [{ name: "espn-fantasy-football", source: "~/elsewhere" }] },
        "is an absolute path",
      ],
      [
        { source: { source: "directory", path: folder } },
        { plugins: [{ name: "espn-fantasy-football", source: "./a\u0007b" }] },
        "is not a path doctor reads",
      ],
      [{ source: { source: "directory", path: folder } }, "{", "is not JSON"],
    ];
    for (const [record, doc, why] of cases) {
      write(known, { [MARKETPLACE]: record });
      if (doc !== null) write(listing, doc);
      const plugin = scanPlugin(sb.home);
      expect(plugin?.origin.kind, why).toBe("unknown");
      expect(plugin?.origin.kind === "unknown" ? plugin.origin.why : "", why).toContain(why);
      expect(plugin?.copies[0]?.root, why).toBe(cache);
    }
    // a source type outside this list is copied, named value-free
    write(known, { [MARKETPLACE]: { source: { source: "Some Thing!" } } });
    expect(scanPlugin(sb.home)?.origin).toEqual({ kind: "copied", source: "another" });
  });

  it("a `file` source, a relative plugin directory and metadata.pluginRoot resolve inside the folder", () => {
    sb = sandbox();
    const { folder } = installPlugin(sb.home, folderMarketplace(sb.home));
    const listing = path.join(folder, ".claude-plugin", "marketplace.json");
    write(path.join(sb.home, ".claude", "plugins", "known_marketplaces.json"), {
      [MARKETPLACE]: { source: { source: "file", path: listing } },
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

  it("eff doctor end to end on the owner's layout (the Yahoo entry, the folder marketplace, the stale cache copy): row 2 ok, row 24 ok", async () => {
    sb = sandbox({ create: true });
    const { folder, cache } = installPlugin(sb.home, folderMarketplace(sb.home));
    const project = path.join(sb.home, "Developer", "fantasy-football");
    claudeJson(
      sb.home,
      {},
      { [project]: { "fantasy-football-mcp-server": launch(yahooClone(sb.home)) } },
    );
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
    expect(row24?.status).toBe("ok");
    expect(row24?.details.join("\n")).toContain(`the cache copy ${cache} is a leftover`);
  });
});
