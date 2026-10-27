// setup-keychain-unreachable.test.ts — `eff setup` on a Mac whose login keychain cannot be asked
// (Stage C finding setup-keychain-unreachable-blocks-file-store; plan 02 §2.2 "One store per
// install", §8 #21; plan 03 §2.1 step 4 and its `--storage` paragraph; ADV OBJ-05, OBJ-25). The
// file store is the fallback for a keychain that prompts, hangs or is locked, so such a keychain
// must not block it when this install never stored anything there; where this install's records
// name the keychain, a switch away from it still empties it first or stores — and records — nothing
// (never two stores). Everything is the real code but the keychain itself: the real orchestration
// (src/auth/setup.ts), the real keychain adapter (src/auth/keychain.ts, a 20 ms per-call bound) over
// an in-memory keyring that can lock, the real launchd-context self-test (src/auth/selftest.ts)
// reading through the same keyring, the real 0600 file store in a temp HOME, and config.json
// written by the CLI's own writer and read back as the CLI resolves it (the recorded store wins).
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileCredentialStore } from "../../src/auth/file.js";
import { createKeychainCredentialStore } from "../../src/auth/keychain.js";
import { runKeychainSelftest, selftestReadOnce } from "../../src/auth/selftest.js";
import { SETUP_TEXT, runSetup, type PromptAnswer, type SetupResult } from "../../src/auth/setup.js";
import {
  KEYCHAIN_ACCOUNTS,
  KEYCHAIN_SERVICE,
  type CredentialStoreKind,
  type EspnCookies,
} from "../../src/auth/types.js";
import { patchConfigFile } from "../../src/cli/config-file.js";
import { configPatchOf } from "../../src/cli/setup.js";
import { loadConfig, readConfigFile, type Config } from "../../src/config/schema.js";
import { ROOT, noXattrs, tempDir } from "../config/helpers.js";
import {
  FakeKeyring,
  MemoryStateRepo,
  RecordingRegistrar,
  containsFragment,
  fakeCookies,
} from "./helpers.js";

const LEAGUE = "0";
const T0 = "2026-10-01T00:00:00.000Z";
const T5 = "2026-10-06T00:00:00.000Z";
const T6 = "2026-10-07T00:00:00.000Z";

/**
 * A login keychain that can lock. `refuse`: every call fails at once (a locked keychain in a session
 * without UI, or access refused); `silent`: no call answers until it is aborted (an unlock or access
 * prompt nobody answers). The real adapter maps both to its own fixed errors.
 */
class LockableKeyring extends FakeKeyring {
  lock: "refuse" | "silent" | null = null;
  /** The operations asked while locked (never a value). */
  readonly lockedOps: ("get" | "set" | "delete")[] = [];
  private async gateLock(op: "get" | "set" | "delete", signal: AbortSignal): Promise<void> {
    if (this.lock === null) return;
    this.lockedOps.push(op);
    if (this.lock === "refuse") throw new Error("User interaction is not allowed.");
    await new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(new Error("aborted"));
      });
    });
  }
  override async getPassword(service: string, account: string, signal: AbortSignal) {
    await this.gateLock("get", signal);
    return super.getPassword(service, account, signal);
  }
  override async setPassword(service: string, account: string, value: string, signal: AbortSignal) {
    await this.gateLock("set", signal);
    return super.setPassword(service, account, value, signal);
  }
  override async deletePassword(service: string, account: string, signal: AbortSignal) {
    await this.gateLock("delete", signal);
    return super.deletePassword(service, account, signal);
  }
}

let tmp: { dir: string; cleanup: () => void };
let home: string;
let configDir: string;
let kr: LockableKeyring;
let repo: MemoryStateRepo;

beforeEach(() => {
  tmp = tempDir("eff-auth-kc-unreachable-");
  home = path.join(tmp.dir, "home");
  configDir = path.join(home, ".config", "espn-fantasy-football-mcp");
  mkdirSync(home, { mode: 0o700 });
  kr = new LockableKeyring();
  repo = new MemoryStateRepo();
});
afterEach(() => {
  tmp.cleanup();
});

/** What `eff setup` resolves at start: its env over the config.json on disk (src/cli/setup.ts). */
function resolveConfig(): Config {
  return loadConfig({
    env: {
      ESPN_LEAGUE_ID: LEAGUE,
      ESPN_SEASON: "2026",
      EFF_CONFIG_DIR: configDir,
      EFF_CACHE_DIR: path.join(home, ".cache", "espn-fantasy-football-mcp"),
    },
    file: readConfigFile(configDir),
    home,
    repoRoot: ROOT,
    nowMs: Date.parse(T0),
    xattr: noXattrs,
  });
}

const sessionPath = (): string => path.join(configDir, "session.json");
const configJson = (): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(configDir, "config.json"), "utf8")) as Record<string, unknown>;
const keychainHolds = (): boolean =>
  kr.peek(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNTS.meta) !== undefined;
/** The forbidden state (plan 02 §8 #21): the keychain `meta` item and session.json both present. */
const twoStores = (): boolean => keychainHolds() && existsSync(sessionPath());

/** `eff setup [--storage kind | --reset]`: private league, probe 200, one team; the real parts. */
async function setup(
  cookies: EspnCookies,
  at: string,
  storage: CredentialStoreKind | null,
  reset = false,
): Promise<{ readonly r: SetupResult; readonly lines: readonly string[] }> {
  const c = resolveConfig();
  const lines: string[] = [];
  const answers: PromptAnswer[] = [
    { kind: "answer", value: cookies.swid },
    { kind: "answer", value: cookies.espn_s2 },
  ];
  const r = await runSetup(
    {
      reset,
      storage,
      serviceName: null,
      leagueId: LEAGUE,
      season: c.season,
      recordedStore: c.origins.EFF_CREDENTIAL_STORE === "file" ? c.credentialStore : null,
      filePath: c.credentialFile,
    },
    {
      prompt: { ask: () => Promise.resolve(answers.shift() ?? { kind: "closed" }) },
      out: (l) => lines.push(l),
      now: () => at,
      stores: {
        keychain: createKeychainCredentialStore({
          loadKeyring: () => Promise.resolve(kr),
          timeoutMs: 20,
        }),
        file: createFileCredentialStore({
          path: c.credentialFile,
          home,
          repoRoot: ROOT,
          xattr: noXattrs,
        }),
      },
      runSelftest: (service) =>
        runKeychainSelftest({
          service,
          keyring: kr,
          readUnderLaunchd: (t, signal) => selftestReadOnce(kr, t, signal),
          now: () => at,
        }),
      network: {
        anonymousSettings: () => Promise.resolve({ status: 401 }),
        anonymousBoard: () => Promise.resolve({ error: "unused" }),
        settingsWithCookies: () => Promise.resolve({ status: 200 }),
        boardWithCookies: () => Promise.resolve({ error: "unused" }),
        resolveTeam: () => Promise.resolve({ kind: "one", teamId: 3 }),
      },
      config: {
        record: (p) => {
          patchConfigFile({ configDir, home, repoRoot: ROOT, xattr: noXattrs }, configPatchOf(p));
          return Promise.resolve();
        },
      },
      credentialState: repo,
      registrar: new RecordingRegistrar(),
    },
  );
  const all = lines.join("\n");
  expect(containsFragment(all, cookies.espn_s2, 12)).toBe(false);
  expect(all).not.toContain(cookies.swid.slice(1, 9));
  return { r, lines };
}

describe("a keychain this install never stored anything in does not block the file store", () => {
  it("fresh install, the keychain refusing every call: the self-test picks the file store and setup completes", async () => {
    kr.lock = "refuse";
    const a = fakeCookies("kcu-fresh");
    const { r, lines } = await setup(a, T0, null);
    expect(r).toMatchObject({ exitCode: 0, state: "validated", store: "file", selftest: "error" });
    expect(lines).toContain(
      "Keychain check: error (write_failed). Using the 0600 file store for this whole install.",
    );
    expect(lines).toContain(SETUP_TEXT.keychainUnchecked);
    expect(lines).not.toContain(SETUP_TEXT.otherStoreFailed("keychain"));
    expect(statSync(sessionPath()).mode & 0o777).toBe(0o600);
    expect(configJson()).toMatchObject({
      EFF_CREDENTIAL_STORE: "file",
      EFF_CREDENTIAL_FILE: sessionPath(),
      keychain_selftest_outcome: "error",
    });
    expect(repo.row).toMatchObject({ state: "validated", store: "file", stored_at: T0 });
    expect(kr.items.size).toBe(0);
    // the self-test's throwaway write and its cleanup, then the three items' deletes, each refused
    expect(kr.lockedOps).toEqual(["set", "delete", "delete", "delete", "delete"]);

    // every re-run, the keychain still locked, completes too (the recorded file store)
    const b = fakeCookies("kcu-rerun");
    const again = await setup(b, T5, null);
    expect(again.r).toMatchObject({ exitCode: 0, state: "validated", store: "file" });
    expect(again.lines).toContain(SETUP_TEXT.keychainUnchecked);
    expect(readFileSync(sessionPath(), "utf8")).toContain(T5);
    expect(twoStores()).toBe(false);
  });

  it("`eff setup --storage file`, the keychain never answering (a prompt nobody answers)", async () => {
    kr.lock = "silent";
    const a = fakeCookies("kcu-silent");
    const { r, lines } = await setup(a, T0, "file");
    expect(r).toMatchObject({ exitCode: 0, state: "validated", store: "file", selftest: null });
    expect(kr.lockedOps).toEqual(["delete", "delete", "delete"]); // each one timed out (20 ms here)
    expect(lines).toContain(SETUP_TEXT.keychainUnchecked);
    expect(statSync(sessionPath()).mode & 0o777).toBe(0o600);
    expect(configJson()).toMatchObject({
      EFF_CREDENTIAL_STORE: "file",
      EFF_CREDENTIAL_FILE: sessionPath(),
    });
  });
});

describe("where this install's records name the keychain, it stays the one store until it answers", () => {
  it("a keychain install, locked: reset fails there, every switch to the file store stores and records nothing, then the unlocked switch moves it", async () => {
    const a = fakeCookies("kcu-held");
    expect((await setup(a, T0, null)).r).toMatchObject({ exitCode: 0, store: "keychain" });
    expect(keychainHolds()).toBe(true);
    expect(configJson()).toMatchObject({ EFF_CREDENTIAL_STORE: "keychain" });

    kr.lock = "refuse";
    // `eff setup --reset`: the keychain cannot be emptied (reported), the row is cleared anyway
    const reset = await setup(a, T5, null, true);
    expect(reset.r.exitCode).toBe(1);
    expect(repo.row).toBeNull();
    expect(keychainHolds()).toBe(true);

    // config.json still names the keychain, so the switch knows it may hold the value
    const b = fakeCookies("kcu-switch");
    for (const attempt of [1, 2]) {
      const sw = await setup(b, T5, "file");
      expect(sw.r, `attempt ${String(attempt)}`).toMatchObject({ exitCode: 1, store: null });
      expect(sw.lines.at(-1)).toBe(SETUP_TEXT.otherStoreFailed("keychain"));
      expect(configJson()).toMatchObject({ EFF_CREDENTIAL_STORE: "keychain" }); // unchanged
      expect(configJson()).not.toHaveProperty("EFF_CREDENTIAL_FILE");
      expect(existsSync(sessionPath())).toBe(false);
      expect(keychainHolds()).toBe(true);
      expect(twoStores()).toBe(false);
    }

    // unlocked: the switch empties the keychain first, then stores in the file — one store
    kr.lock = null;
    const done = await setup(b, T6, "file");
    expect(done.r).toMatchObject({ exitCode: 0, state: "validated", store: "file" });
    expect(kr.items.size).toBe(0);
    expect(readFileSync(sessionPath(), "utf8")).toContain(T6);
    expect(configJson()).toMatchObject({
      EFF_CREDENTIAL_STORE: "file",
      EFF_CREDENTIAL_FILE: sessionPath(),
    });
    expect(done.lines).not.toContain(SETUP_TEXT.keychainUnchecked);
  });
});
