// uninstall-recorded-file.test.ts — `eff uninstall` removes the credential file config.json RECORDS,
// whatever else the configuration gets wrong (plan 03 §3: the recorded EFF_CREDENTIAL_FILE is
// authoritative; plan 03 §8 step 2 and plan 02 §8 #21: "a stale second copy must never survive an
// uninstall"). Stage C finding uninstall-fallback-ignores-recorded-credential-file: on ANY
// configuration error — an environment typo, a location refusal such as a dotfiles repo at ~ — the
// fallback took the default session.json, never read the path config.json records, reported
// "session.json removed" for a file that was never there, and then deleted config.json, the only
// record of where the real espn_s2/SWID file lived. Placeholder values only; an in-memory keyring.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { sessionFileBody } from "../../src/auth/file.js";
import { metaFor } from "../../src/auth/upgrade.js";
import { main } from "../../src/cli/main.js";
import { createTerminalPrompt } from "../../src/cli/prompt.js";
import { loadLenientRuntime } from "../../src/cli/runtime.js";
import { configFileRecord, fallbackUninstallConfig, uninstall } from "../../src/cli/uninstall.js";
import { fakeCookies } from "../auth/helpers.js";
import { Capture, FakeKeyring, makeIo, sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox;
afterEach(() => {
  sb.cleanup();
});

const COOKIES = fakeCookies("cli-uninstall-recorded");

/** A file-store install whose cookie file lives at a custom path config.json records. */
function installAtCustomPath(): { vaultFile: string; keyring: FakeKeyring } {
  const vault = path.join(sb.dir, "vault", "eff");
  mkdirSync(vault, { recursive: true, mode: 0o700 });
  const vaultFile = path.join(vault, "session.json");
  writeFileSync(vaultFile, sessionFileBody(COOKIES, metaFor(COOKIES, "2026-10-01T00:00:00.000Z")), {
    mode: 0o600,
  });
  mkdirSync(sb.configDir, { recursive: true, mode: 0o700 });
  mkdirSync(sb.cacheDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(sb.configDir, "config.json"),
    JSON.stringify({ EFF_CREDENTIAL_STORE: "file", EFF_CREDENTIAL_FILE: vaultFile }),
    { mode: 0o600 },
  );
  return { vaultFile, keyring: new FakeKeyring() };
}

const CONFIG_JSON = (): string => path.join(sb.configDir, "config.json");

describe("the recorded credential file is the one uninstall deletes", () => {
  it("control: a configuration that loads deletes the recorded file, then config.json", async () => {
    sb = sandbox();
    const { vaultFile, keyring } = installAtCustomPath();
    const io = makeIo(sb, { keyring });
    expect(await main(["uninstall", "--yes"], io)).toBe(0);
    expect(existsSync(vaultFile)).toBe(false);
    expect(io.out.text).toContain("session.json removed");
    expect(io.out.text).toContain(`credential file: ${vaultFile}`);
    expect(existsSync(CONFIG_JSON())).toBe(false);
  });

  it("an environment typo (EFF_LOG_LEVEL=verbose): the recorded file is deleted, never the default path; no 'could not be read'", async () => {
    sb = sandbox();
    const { vaultFile, keyring } = installAtCustomPath();
    const io = makeIo(sb, { keyring, env: { EFF_LOG_LEVEL: "verbose" } });
    expect(await main(["uninstall", "--yes"], io)).toBe(0);
    expect(existsSync(vaultFile)).toBe(false);
    expect(io.out.text).toContain("the configuration could not be loaded (EFF_LOG_LEVEL:");
    expect(io.out.text).not.toContain("config.json could not be read");
    expect(io.out.text).toContain(
      `The credential file it removes is ${vaultFile} (recorded in config.json)`,
    );
    expect(io.out.text).toContain("session.json removed");
    expect(io.out.text).toContain(`credential file: ${vaultFile}`);
    // the file it named is gone: config.json, its record, may go too
    expect(existsSync(CONFIG_JSON())).toBe(false);
  });

  it("a location refusal (a git work tree around everything): the cookie file inside it is deleted", async () => {
    sb = sandbox();
    const { vaultFile, keyring } = installAtCustomPath();
    mkdirSync(path.join(sb.dir, ".git"));
    const io = makeIo(sb, { keyring });
    expect(await main(["uninstall", "--yes"], io)).toBe(0);
    expect(io.out.text).toContain("the configuration could not be loaded");
    expect(io.out.text).toContain("inside a git working tree");
    expect(existsSync(vaultFile)).toBe(false);
    expect(io.out.text).toContain("session.json removed");
  });

  it("a config.json that is not JSON is KEPT (it may record a file no one else knows); the default path is said, absent", async () => {
    sb = sandbox();
    const { vaultFile, keyring } = installAtCustomPath();
    writeFileSync(CONFIG_JSON(), `{"EFF_CREDENTIAL_FILE": "${vaultFile}"`, { mode: 0o600 });
    const io = makeIo(sb, { keyring });
    expect(await main(["uninstall", "--yes"], io)).toBe(0);
    expect(io.out.text).toContain("config.json could not be read (config.json: is not valid JSON)");
    expect(io.out.text).toContain("so config.json is kept");
    expect(io.out.text).toContain(
      `kept ${CONFIG_JSON()}: it could not be read, so a credential file it may record is unknown`,
    );
    expect(existsSync(CONFIG_JSON())).toBe(true);
    // nothing was at the default path: never reported as removed
    expect(io.out.text).toContain("session.json absent");
    expect(io.out.text).not.toContain("session.json removed");
  });

  it("cookies kept at the terminal: config.json is kept too, while the file it records is still there", async () => {
    sb = sandbox();
    const { vaultFile, keyring } = installAtCustomPath();
    const stdin = new PassThrough();
    Object.assign(stdin, { isTTY: true });
    const out = new Capture();
    const prompt = createTerminalPrompt({ stdin, out });
    const io = makeIo(sb, { keyring, stdin });
    const { config, log } = await loadLenientRuntime(io);
    const run = uninstall(io, config, log, {
      yes: false,
      dryRun: false,
      keepConfig: false,
      exportLog: undefined,
      prompt,
    });
    // no to the cookies, yes to the cache, yes to the config
    for (const [n, answer] of [
      [1, "n"],
      [2, "y"],
      [3, "y"],
    ] as const) {
      for (let i = 0; i < 400 && out.text.split("[y/N] ").length - 1 < n; i++)
        await new Promise((r) => setTimeout(r, 5));
      stdin.write(`${answer}\n`);
    }
    expect(await run).toBe(0);
    expect(existsSync(vaultFile)).toBe(true);
    expect(existsSync(CONFIG_JSON())).toBe(true);
    expect(io.out.text).toContain(
      `kept ${CONFIG_JSON()}: it records where the credential file ${vaultFile} lives, and that file is still there`,
    );
  });

  it("--dry-run says which config.json it would keep", async () => {
    sb = sandbox();
    installAtCustomPath();
    writeFileSync(CONFIG_JSON(), "not json", { mode: 0o600 });
    const io = makeIo(sb);
    expect(await main(["uninstall", "--dry-run"], io)).toBe(0);
    expect(io.out.text).toContain(`would keep ${CONFIG_JSON()}`);
    expect(io.out.text).not.toContain(`would delete ${CONFIG_JSON()}`);
  });
});

describe("configFileRecord / fallbackUninstallConfig", () => {
  it("reads the record past a credential-shaped value elsewhere, an empty value, a non-string, a relative path", () => {
    sb = sandbox({ create: true });
    const write = (o: unknown): void => {
      writeFileSync(CONFIG_JSON(), typeof o === "string" ? o : JSON.stringify(o), { mode: 0o600 });
    };
    const abs = path.join(sb.dir, "x", "session.json");
    write({ EFF_CREDENTIAL_FILE: abs, ESPN_SEASON: 2026 });
    expect(configFileRecord(sb.configDir, sb.home)).toEqual({
      state: "parsed",
      file: abs,
      unusable: false,
    });
    write({ EFF_CREDENTIAL_FILE: "~/eff/session.json" });
    expect(configFileRecord(sb.configDir, sb.home).file).toBe(
      path.join(sb.home, "eff", "session.json"),
    );
    write({ EFF_CREDENTIAL_FILE: "" });
    expect(configFileRecord(sb.configDir, sb.home)).toMatchObject({ file: null, unusable: false });
    write({ EFF_CREDENTIAL_FILE: 5 });
    expect(configFileRecord(sb.configDir, sb.home)).toMatchObject({ file: null, unusable: true });
    write({ EFF_CREDENTIAL_FILE: "relative/session.json" });
    expect(configFileRecord(sb.configDir, sb.home)).toMatchObject({ file: null, unusable: true });
    write([1, 2]);
    expect(configFileRecord(sb.configDir, sb.home).state).toBe("unreadable");
    write("{");
    expect(configFileRecord(sb.configDir, sb.home).state).toBe("unreadable");
    write({});
    expect(configFileRecord(sb.configDir, sb.home)).toEqual({
      state: "parsed",
      file: null,
      unusable: false,
    });
    expect(configFileRecord(path.join(sb.dir, "none"), sb.home).state).toBe("missing");
  });

  it("precedence: the record, then EFF_CREDENTIAL_FILE, then the default — each origin said", () => {
    sb = sandbox({ create: true });
    const env = { EFF_CONFIG_DIR: sb.configDir, EFF_CACHE_DIR: sb.cacheDir };
    const recorded = path.join(sb.dir, "rec", "session.json");
    const fromEnv = path.join(sb.dir, "env", "session.json");
    writeFileSync(CONFIG_JSON(), JSON.stringify({ EFF_CREDENTIAL_FILE: recorded }), {
      mode: 0o600,
    });
    expect(
      fallbackUninstallConfig({ ...env, EFF_CREDENTIAL_FILE: fromEnv }, sb.home, []),
    ).toMatchObject({ credentialFile: recorded, origins: { EFF_CREDENTIAL_FILE: "file" } });
    writeFileSync(CONFIG_JSON(), "{}", { mode: 0o600 });
    expect(
      fallbackUninstallConfig({ ...env, EFF_CREDENTIAL_FILE: fromEnv }, sb.home, []),
    ).toMatchObject({ credentialFile: fromEnv, origins: { EFF_CREDENTIAL_FILE: "env" } });
    expect(fallbackUninstallConfig(env, sb.home, [])).toMatchObject({
      credentialFile: path.join(sb.configDir, "session.json"),
      origins: { EFF_CREDENTIAL_FILE: "default" },
      configFileUnreadable: false,
    });
    // an unusable EFF_CREDENTIAL_FILE in the environment falls back to the default
    expect(
      fallbackUninstallConfig({ ...env, EFF_CREDENTIAL_FILE: "relative" }, sb.home, []),
    ).toMatchObject({ origins: { EFF_CREDENTIAL_FILE: "default" } });
    writeFileSync(CONFIG_JSON(), "nope", { mode: 0o600 });
    expect(fallbackUninstallConfig(env, sb.home, [])).toMatchObject({
      configFileUnreadable: true,
    });
  });
});
