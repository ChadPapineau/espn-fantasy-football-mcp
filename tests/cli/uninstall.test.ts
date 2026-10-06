// uninstall.test.ts — `eff uninstall` (plan 03 L8, §8): without a terminal and without --yes nothing
// changes; --dry-run lists; --yes deletes BOTH credential stores (an in-memory keyring here) and our
// files by exact name, keeps files that are not ours, exports the recommendation log as a NEW 0600
// JSON file first, never edits a client config, and prints the manual steps.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { sessionFileBody } from "../../src/auth/file.js";
import { metaFor } from "../../src/auth/upgrade.js";
import { loadLenientRuntime } from "../../src/cli/runtime.js";
import { openStore } from "../../src/cli/store-access.js";
import { executePurge, manualSteps, purgePlan, uninstall } from "../../src/cli/uninstall.js";
import { createTerminalPrompt } from "../../src/cli/prompt.js";
import { fakeCookies } from "../auth/helpers.js";
import { Capture, FakeKeyring, fakeExec, makeIo, sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox;
afterEach(() => {
  sb.cleanup();
});

const COOKIES = fakeCookies("cli-uninstall");

async function install(): Promise<{ keyring: FakeKeyring }> {
  const keyring = new FakeKeyring();
  for (const a of ["espn_s2", "SWID", "meta"]) keyring.plant("espn-fantasy-football-mcp", a, "x");
  keyring.plant("espn-fantasy-football-mcp-selftest", "selftest", "x");
  const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" }, keyring });
  const { config, log } = await loadLenientRuntime(io);
  const store = openStore(config, io.clock, log, { migrate: true });
  store.close();
  mkdirSync(sb.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(sb.configDir, "config.json"), "{}", { mode: 0o600 });
  writeFileSync(
    path.join(sb.configDir, "session.json"),
    sessionFileBody(COOKIES, metaFor(COOKIES, "2026-10-01T00:00:00.000Z")),
    { mode: 0o600 },
  );
  writeFileSync(path.join(sb.cacheDir, "user-notes.txt"), "mine");
  mkdirSync(path.join(sb.cacheDir, "datasets"), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(sb.cacheDir, "datasets", "nflverse__injuries.sqlite"), "x");
  writeFileSync(path.join(sb.cacheDir, "datasets", "README"), "x");
  return { keyring };
}

describe("uninstall", () => {
  it("no terminal and no --yes: exit 2, nothing changed", async () => {
    sb = sandbox();
    await install();
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } });
    const { config, log } = await loadLenientRuntime(io);
    expect(
      await uninstall(io, config, log, {
        yes: false,
        dryRun: false,
        keepConfig: false,
        exportLog: undefined,
      }),
    ).toBe(2);
    expect(existsSync(path.join(sb.configDir, "session.json"))).toBe(true);
    expect(existsSync(path.join(sb.cacheDir, "store.sqlite"))).toBe(true);
  });
  it("--dry-run lists what it would delete and touches nothing", async () => {
    sb = sandbox();
    const { keyring } = await install();
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" }, keyring });
    const { config, log } = await loadLenientRuntime(io);
    expect(
      await uninstall(io, config, log, {
        yes: false,
        dryRun: true,
        keepConfig: false,
        exportLog: undefined,
      }),
    ).toBe(0);
    expect(io.out.text).toContain("would delete the keychain items");
    expect(io.out.text).toContain(`would delete ${path.join(sb.cacheDir, "store.sqlite")}`);
    expect(keyring.calls).toEqual([]);
    expect(existsSync(path.join(sb.cacheDir, "store.sqlite"))).toBe(true);
  });
  it("--yes: both credential stores and the self-test item removed, our files deleted, foreign files kept, export first", async () => {
    sb = sandbox();
    const { keyring } = await install();
    const { exec } = fakeExec();
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" }, keyring, platform: "darwin", exec });
    const { config, log } = await loadLenientRuntime(io);
    const exportTo = path.join(sb.dir, "export.json");
    expect(
      await uninstall(io, config, log, {
        yes: true,
        dryRun: false,
        keepConfig: false,
        exportLog: exportTo,
      }),
    ).toBe(0);
    expect(keyring.items.size).toBe(0);
    expect(existsSync(path.join(sb.configDir, "session.json"))).toBe(false);
    expect(existsSync(path.join(sb.cacheDir, "store.sqlite"))).toBe(false);
    expect(existsSync(path.join(sb.cacheDir, "datasets", "nflverse__injuries.sqlite"))).toBe(false);
    expect(existsSync(path.join(sb.cacheDir, "datasets", "README"))).toBe(true);
    expect(existsSync(path.join(sb.cacheDir, "user-notes.txt"))).toBe(true);
    expect(existsSync(path.join(sb.configDir, "config.json"))).toBe(false);
    expect(statSync(exportTo).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(exportTo, "utf8"))).toMatchObject({ recommendation_log: [] });
    expect(io.out.text).toContain(
      "credentials: keychain removed, session.json removed, self-test item removed, state cleared",
    );
    expect(io.out.text).toContain("claude mcp remove --scope user espn-fantasy-football");
    expect(io.out.text).toContain("NOT invalidated");
    expect(io.out.text).toContain("no launchd jobs of ours are installed");
  });
  it("interactive answers: no to the cookies and the cache keeps them; --keep-config keeps the config", async () => {
    sb = sandbox();
    const { keyring } = await install();
    const stdin = new PassThrough();
    Object.assign(stdin, { isTTY: true });
    const out = new Capture();
    const prompt = createTerminalPrompt({ stdin, out });
    stdin.write("n\nn\n");
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" }, keyring, stdin });
    const { config, log } = await loadLenientRuntime(io);
    expect(
      await uninstall(io, config, log, {
        yes: false,
        dryRun: false,
        keepConfig: true,
        exportLog: undefined,
        prompt,
      }),
    ).toBe(0);
    expect(keyring.items.size).toBe(4);
    expect(existsSync(path.join(sb.cacheDir, "store.sqlite"))).toBe(true);
    expect(io.out.text).toContain("kept the stored cookies");
    expect(io.out.text).toContain(`kept your data: ${sb.cacheDir}`);
    expect(io.out.text).toContain(`kept your config: ${sb.configDir}`);
  });
  it("purgePlan never enters a directory that is not our private one; executePurge keeps a non-empty dir", () => {
    sb = sandbox({ create: true });
    mkdirSync(path.join(sb.cacheDir, "backups"), { mode: 0o755 });
    writeFileSync(path.join(sb.cacheDir, "backups", "store-2026-10-04.sqlite"), "x");
    const plan = purgePlan(sb.cacheDir, ["store.sqlite"], [{ name: "backups", re: /^store-/ }]);
    expect(plan.find((p) => p.path.endsWith("backups"))).toMatchObject({ action: "keep" });
    const r = executePurge(plan.filter((p) => p.action !== "keep"));
    expect(r.kept).toContain(sb.cacheDir);
    expect(purgePlan(path.join(sb.dir, "none"), [], [])).toEqual([]);
    expect(manualSteps("/h").join("\n")).toContain("npm uninstall -g espn-fantasy-football-mcp");
  });
});
