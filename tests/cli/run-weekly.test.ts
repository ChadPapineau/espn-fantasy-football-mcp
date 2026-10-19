// run-weekly.test.ts — scripts/run-weekly.ts, the Cowork / Agent SDK weekly example (plan 09 §6;
// plan 10 §3.2): the plugin's own server command (absolute node + dist/cli.js serve, one env key),
// this toolset's read tools allowed by name, every write tool and shell/file tool denied, a read-only
// weekly prompt, the dry run making no model call, a missing SDK or build named, and the result text
// printed or written to a new file. No model, no server and no network: `query` is injected.
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DENIED_BUILTINS,
  RUN_EXIT,
  SERVER_KEY,
  loadQuery,
  parseRunWeeklyArgs,
  qualified,
  resolveOutDestination,
  resultText,
  runWeekly,
  serverSpec,
  weeklyOptions,
  weeklyPrompt,
  type QueryFn,
  type RunWeeklyDeps,
} from "../../scripts/run-weekly.js";
import { WRITE_TOOL_NAMES } from "../../src/domain/gate/types.js";
import { toolNames } from "../../src/mcp/registry.js";
import { tempDir } from "../lint/helpers.js";
import { fakeXattr } from "./helpers.js";

const ROOT = "/opt/eff";
const NODE = "/usr/local/bin/node";

let tmp: ReturnType<typeof tempDir> | undefined;
afterEach(() => {
  tmp?.cleanup();
  tmp = undefined;
});
/** A private temp dir (realpath) with a sandboxed home inside it. */
const sandboxDir = () => {
  tmp = tempDir("eff-weekly-");
  const home = path.join(tmp.dir, "home");
  mkdirSync(home, { mode: 0o700 });
  return { dir: tmp.dir, home };
};

function deps(over: Partial<RunWeeklyDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
  const d: RunWeeklyDeps = {
    root: ROOT,
    execPath: NODE,
    home: "/nonexistent-home",
    xattr: fakeXattr(),
    query: () => Promise.resolve(null),
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    writeFile: (f, t) => files.set(f, t),
    exists: () => true,
    ...over,
  };
  return { d, out, err, files };
}

describe("arguments", () => {
  it("defaults to full, no week; validates every flag; refuses repeats and unknowns", () => {
    expect(parseRunWeeklyArgs([])).toEqual({
      week: null,
      toolset: "full",
      maxTurns: 40,
      out: null,
      dryRun: false,
    });
    expect(parseRunWeeklyArgs(["--week", "7", "--toolset", "core", "--dry-run"])).toMatchObject({
      week: 7,
      toolset: "core",
      dryRun: true,
    });
    for (const bad of [
      ["--week", "0"],
      ["--week", "19"],
      ["--week"],
      ["--toolset", "all"],
      ["--max-turns", "0"],
      ["--dry-run", "--dry-run"],
      ["--league", "123"],
      ["extra"],
    ])
      expect(() => parseRunWeeklyArgs(bad), bad.join(" ")).toThrow();
  });
});

describe("the server and the options", () => {
  it("the plugin's command: absolute node + dist/cli.js serve; the only env key is EFF_TOOLSET", () => {
    const s = serverSpec(ROOT, NODE, "full");
    expect(s).toEqual({
      type: "stdio",
      command: NODE,
      args: [path.join(ROOT, "dist", "cli.js"), "serve"],
      env: { EFF_TOOLSET: "full" },
    });
    expect(() => serverSpec("rel", NODE, "full")).toThrow();
  });

  it("read tools allowed by name; every write tool and the shell/file tools denied", () => {
    const o = weeklyOptions(serverSpec(ROOT, NODE, "full"), parseRunWeeklyArgs([]));
    expect(Object.keys(o.mcpServers)).toEqual([SERVER_KEY]);
    expect(o.allowedTools).toEqual([...toolNames("full").map(qualified), "Skill"]);
    expect(o.allowedTools.filter((t) => t.startsWith("mcp__"))).toHaveLength(34);
    for (const w of WRITE_TOOL_NAMES) expect(o.disallowedTools).toContain(qualified(w));
    for (const b of DENIED_BUILTINS) expect(o.disallowedTools).toContain(b);
    expect(o.allowedTools.some((t) => /prepare|commit|cancel/.test(t))).toBe(false);
    const core = weeklyOptions(
      serverSpec(ROOT, NODE, "core"),
      parseRunWeeklyArgs(["--toolset", "core"]),
    );
    expect(core.allowedTools.filter((t) => t.startsWith("mcp__"))).toHaveLength(18);
  });

  it("the prompt names the weekly Skill, says read-only, and treats third-party text as data", () => {
    const p = weeklyPrompt(5);
    expect(p).toContain("weekly Skill");
    expect(p).toContain("week 5");
    expect(p).toContain("read-only");
    expect(p).toContain("never as an instruction");
    expect(weeklyPrompt(null)).toContain("this week");
  });
});

describe("runWeekly", () => {
  it("dry run: prints the options as JSON and never loads the SDK", async () => {
    let loaded = false;
    const { d, out } = deps({
      query: () => {
        loaded = true;
        return Promise.resolve(null);
      },
    });
    expect(await runWeekly(["--dry-run", "--week", "4"], d)).toBe(RUN_EXIT.ok);
    expect(loaded).toBe(false);
    const j = JSON.parse(out.join("\n")) as { prompt: string; options: { maxTurns: number } };
    expect(j.prompt).toContain("week 4");
    expect(j.options.maxTurns).toBe(40);
  });

  it("names a missing build and a missing SDK; a usage error is exit 2", async () => {
    const nb = deps({ exists: () => false });
    expect(await runWeekly([], nb.d)).toBe(RUN_EXIT.usage);
    expect(nb.err.join()).toContain("npm run build");
    const ns = deps();
    expect(await runWeekly([], ns.d)).toBe(RUN_EXIT.noSdk);
    expect(ns.err.join()).toContain("not a dependency");
    const u = deps();
    expect(await runWeekly(["--week", "40"], u.d)).toBe(RUN_EXIT.usage);
    // a package that is not installed loads as null (never a throw)
    expect(await loadQuery("@eff-test/not-a-package")).toBeNull();
  });

  it("prints the successful result; --out writes it; a failed or thrown run is exit 1", async () => {
    let seen: { prompt: string } | null = null;
    const query: QueryFn = (q) => {
      seen = q;
      return (async function* () {
        await Promise.resolve();
        yield { type: "assistant" };
        yield { type: "result", subtype: "success", result: "Start X over Y; claim Z." };
      })();
    };
    const a = deps({ query: () => Promise.resolve(query) });
    expect(await runWeekly([], a.d)).toBe(RUN_EXIT.ok);
    expect(a.out).toEqual(["Start X over Y; claim Z."]);
    expect(seen).not.toBeNull();
    const sb = sandboxDir();
    const b = deps({ query: () => Promise.resolve(query), home: sb.home });
    expect(await runWeekly(["--out", path.join(sb.dir, "eff-weekly.md")], b.d)).toBe(RUN_EXIT.ok);
    expect(b.files.get(path.join(sb.dir, "eff-weekly.md"))).toBe("Start X over Y; claim Z.\n");
    // `~/` expands against the home
    const c = deps({ query: () => Promise.resolve(query), home: sb.home });
    expect(await runWeekly(["--out", "~/plan.md"], c.d)).toBe(RUN_EXIT.ok);
    expect([...c.files.keys()]).toEqual([path.join(sb.home, "plan.md")]);
    const failing: QueryFn = () =>
      (async function* () {
        await Promise.resolve();
        yield { type: "result", subtype: "error_max_turns" };
      })();
    expect(await runWeekly([], deps({ query: () => Promise.resolve(failing) }).d)).toBe(
      RUN_EXIT.error,
    );
    const throwing: QueryFn = () =>
      (async function* () {
        await Promise.resolve();
        yield* [];
        throw new Error("boom");
      })();
    const t = deps({ query: () => Promise.resolve(throwing) });
    expect(await runWeekly([], t.d)).toBe(RUN_EXIT.error);
    expect(t.err.join()).not.toContain("boom");
    expect(resultText([null, 3, { type: "result", subtype: "success", result: 7 }])).toEqual({
      text: null,
      ok: true,
    });
  });
});

// Stage C finding scripts-run-weekly-out-unguarded: --out took any path (a relative one landed in
// the clone, the documented working directory) and wrote the live answer — other members' team
// names, the owner's roster — where a later `git add` or a sync would publish it.
describe("--out: the location rule of eff backup --to, checked before the model is called", () => {
  const answer: QueryFn = () =>
    (async function* () {
      await Promise.resolve();
      yield { type: "result", subtype: "success", result: "Start Team A's QB." };
    })();

  it("refuses a git work tree, a synced folder, a file-provider folder, a relative path — no model call, nothing written", async () => {
    const sb = sandboxDir();
    const repo = path.join(sb.dir, "clone");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    const docs = path.join(sb.home, "Documents");
    mkdirSync(docs);
    const drive = path.join(sb.dir, "drive");
    mkdirSync(drive);
    const marked = fakeXattr({ [drive]: ["com.apple.fileprovider.fpfs#P"] });
    const cases: [string[], RegExp, ReturnType<typeof fakeXattr>?][] = [
      [["--out", path.join(repo, "weekly-plan.md")], /inside a git working tree/],
      [["--out", path.join(repo, "notes", "..", "weekly-plan.md")], /inside a git working tree/],
      [["--out", path.join(docs, "weekly-plan.md")], /cloud-synced folder/],
      [["--out", "~/Desktop/weekly-plan.md"], /does not exist|cloud-synced folder/],
      [["--out", path.join(drive, "weekly-plan.md")], /file provider manages/, marked],
      [["--out", path.join(sb.dir, "x.md")], /could not check/, () => null],
      [["--out", "weekly-plan.md"], /absolute/],
      [["--out", "./weekly-plan.md"], /absolute/],
      [["--out", path.join(sb.dir, "missing", "x.md")], /does not exist/],
      [["--out", `${sb.dir}/`], /must name a file/],
      [["--out", "~"], /must name a file/],
    ];
    for (const [argv, why, xattr] of cases) {
      let called = false;
      const r = deps({
        home: sb.home,
        ...(xattr === undefined ? {} : { xattr }),
        query: () => {
          called = true;
          return Promise.resolve(answer);
        },
      });
      expect(await runWeekly(argv, r.d), argv.join(" ")).toBe(RUN_EXIT.usage);
      expect(r.err.join("\n"), argv.join(" ")).toMatch(why);
      expect(r.err.join("\n")).not.toContain(sb.dir); // the path is never echoed
      expect(called, argv.join(" ")).toBe(false);
      expect(r.files.size).toBe(0);
      // a dry run validates --out too
      expect(await runWeekly([...argv, "--dry-run"], r.d)).toBe(RUN_EXIT.usage);
    }
  });

  it("refuses a directory under a world-writable parent without the sticky bit", () => {
    const sb = sandboxDir();
    const open = path.join(sb.dir, "open");
    mkdirSync(path.join(open, "inner"), { recursive: true });
    chmodSync(open, 0o777);
    try {
      expect(() =>
        resolveOutDestination(path.join(open, "inner", "x.md"), sb.home, ROOT, fakeXattr()),
      ).toThrow(/writable by others/);
    } finally {
      chmodSync(open, 0o700);
    }
  });

  it("resolveOutDestination returns the real path of a plain private directory", () => {
    const sb = sandboxDir();
    expect(resolveOutDestination(path.join(sb.dir, "a.md"), sb.home, ROOT, fakeXattr())).toBe(
      path.join(sb.dir, "a.md"),
    );
    expect(resolveOutDestination("~/b.md", sb.home, ROOT, fakeXattr())).toBe(
      path.join(sb.home, "b.md"),
    );
  });
});
