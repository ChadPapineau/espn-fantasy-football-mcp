// keychain.ts — the OS keychain credential store (plan 02 S1, §2.2 keychain column; plan 01 §10):
// service `espn-fantasy-football-mcp`, accounts `espn_s2`, `SWID`, `meta` (setup metadata only,
// written LAST — so a missing `meta` reads as nothing stored). THE ONLY IMPORT SITE of
// `@napi-rs/keyring` (plan 04 R3), and that import is dynamic: the addon loads on the first store
// operation, never at startup (plan 03 §1.1 step 4). `--service-name eff-test-…` (changelog V8) is
// the one other service accepted, with its `-selftest` sibling (plan 03 §2.1 step 4).
import { CredentialStoreError } from "./errors.js";
import { validateCookies } from "./format.js";
import {
  KEYCHAIN_ACCOUNTS,
  KEYCHAIN_SERVICE,
  SELFTEST_SERVICE_SUFFIX,
  TEST_SERVICE_PREFIX,
  type CredentialStore,
  type StoredCredential,
  type StoredSecretMeta,
} from "./types.js";
import { metaJson, metaMatches, parseMeta, parseMetaJson } from "./upgrade.js";

/** What the store needs from a keychain (the addon in production, an in-memory fake in tests). */
export interface KeyringPort {
  /** The stored value, or null when the item does not exist. */
  getPassword(service: string, account: string, signal: AbortSignal): Promise<string | null>;
  setPassword(service: string, account: string, value: string, signal: AbortSignal): Promise<void>;
  /** True when an item was deleted, false when there was none. */
  deletePassword(service: string, account: string, signal: AbortSignal): Promise<boolean>;
}

/** The slice of `@napi-rs/keyring`'s `AsyncEntry` the adapter uses. */
export interface AsyncEntryLike {
  getPassword(signal?: AbortSignal | null): Promise<string | null | undefined>;
  setPassword(password: string, signal?: AbortSignal | null): Promise<void>;
  deleteCredential(signal?: AbortSignal | null): Promise<boolean>;
}

/** The slice of the addon module the adapter uses. */
export interface KeyringModuleLike {
  readonly AsyncEntry: new (service: string, account: string) => AsyncEntryLike;
}

/** Adapts the addon's per-entry API to `KeyringPort` (normalising "absent" to null). */
export function keyringFromModule(mod: KeyringModuleLike): KeyringPort {
  return {
    getPassword: async (s, a, signal) =>
      (await new mod.AsyncEntry(s, a).getPassword(signal)) ?? null,
    setPassword: (s, a, v, signal) => new mod.AsyncEntry(s, a).setPassword(v, signal),
    deletePassword: (s, a, signal) => new mod.AsyncEntry(s, a).deleteCredential(signal),
  };
}

/** Loads the native addon (the one dynamic import of `@napi-rs/keyring` in the code base). */
export async function loadNativeKeyring(): Promise<KeyringPort> {
  return keyringFromModule(await import("@napi-rs/keyring"));
}

/** A test service name: `eff-test-` + a short safe suffix (changelog V8). */
const TEST_SERVICE_RE = new RegExp(`^${TEST_SERVICE_PREFIX}[A-Za-z0-9._-]{1,64}$`);

/** Whether `name` is an allowed test-only service name (`eff setup --service-name`). */
export function isTestServiceName(name: string): boolean {
  return TEST_SERVICE_RE.test(name) && name !== KEYCHAIN_SERVICE;
}

/** Whether `name` is a service this code may touch: the real one or a test one. */
export function isAllowedServiceName(name: string): boolean {
  return name === KEYCHAIN_SERVICE || isTestServiceName(name);
}

/** The launchd-context self-test's throwaway service for `service` (plan 03 §2.1 step 4). */
export function selftestServiceOf(service: string): string {
  return `${service}${SELFTEST_SERVICE_SUFFIX}`;
}

/** The throwaway item's account under the self-test service. */
export const SELFTEST_ACCOUNT = "selftest";

/**
 * Default per-operation timeout: a hidden Keychain prompt must not hang a tool call forever
 * (plan 02 §2.2 keychain friction). Long enough for a person to answer a visible prompt.
 */
export const KEYCHAIN_OP_TIMEOUT_MS = 30_000;

/** Options of the keychain store. */
export interface KeychainStoreOptions {
  /** The service (default `espn-fantasy-football-mcp`; `eff-test-…` in tests only). */
  readonly service?: string;
  /** Loads the keyring lazily on first use (default: the native addon). */
  readonly loadKeyring?: () => Promise<KeyringPort>;
  readonly timeoutMs?: number;
}

/** The keychain store, with the service it uses. */
export interface KeychainCredentialStore extends CredentialStore {
  readonly kind: "keychain";
  readonly service: string;
}

/** Creates the keychain store. Constructing it touches neither the addon nor the keychain. */
export function createKeychainCredentialStore(
  opts: KeychainStoreOptions = {},
): KeychainCredentialStore {
  const service = opts.service ?? KEYCHAIN_SERVICE;
  if (!isAllowedServiceName(service)) throw new CredentialStoreError("keychain", "invalid_service");
  const load = opts.loadKeyring ?? loadNativeKeyring;
  const timeoutMs = opts.timeoutMs ?? KEYCHAIN_OP_TIMEOUT_MS;
  let port: Promise<KeyringPort> | null = null;

  const keyring = (): Promise<KeyringPort> => {
    port ??= load().catch((_e: unknown) => {
      port = null; // a later call may succeed (an addon that failed once is retried)
      throw new CredentialStoreError("keychain", "unavailable");
    });
    return port;
  };

  /** One keyring call under the timeout; native errors become fixed-text typed errors. */
  const call = async <T>(
    failure: "read_failed" | "write_failed" | "delete_failed",
    fn: (k: KeyringPort, signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const k = await keyring();
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      ctl.abort();
    }, timeoutMs);
    try {
      return await fn(k, ctl.signal);
    } catch (_e: unknown) {
      // the native message is never propagated (it is not ours to vouch for)
      throw new CredentialStoreError("keychain", ctl.signal.aborted ? "timeout" : failure);
    } finally {
      clearTimeout(timer);
    }
  };

  const get = (account: string): Promise<string | null> =>
    call("read_failed", (k, signal) => k.getPassword(service, account, signal));

  const readMeta = async (): Promise<StoredSecretMeta | null> => {
    const text = await get(KEYCHAIN_ACCOUNTS.meta);
    if (text === null) return null;
    const meta = parseMetaJson(text);
    if (!meta.ok) throw new CredentialStoreError("keychain", meta.reason);
    return meta.meta;
  };

  const deleteAll = async (): Promise<void> => {
    let failed = false;
    // meta first: an interrupted delete then reads as "nothing stored"
    for (const account of [
      KEYCHAIN_ACCOUNTS.meta,
      KEYCHAIN_ACCOUNTS.espn_s2,
      KEYCHAIN_ACCOUNTS.swid,
    ]) {
      try {
        await call("delete_failed", (k, signal) => k.deletePassword(service, account, signal));
      } catch {
        failed = true;
      }
    }
    if (failed) throw new CredentialStoreError("keychain", "delete_failed");
  };

  return {
    kind: "keychain",
    service,
    readMeta,
    exists: async () => (await get(KEYCHAIN_ACCOUNTS.meta)) !== null,
    read: async (): Promise<StoredCredential | null> => {
      const meta = await readMeta();
      if (meta === null) return null;
      const s2 = await get(KEYCHAIN_ACCOUNTS.espn_s2);
      const swid = await get(KEYCHAIN_ACCOUNTS.swid);
      if (s2 === null || swid === null) throw new CredentialStoreError("keychain", "corrupt");
      const cookies = { espn_s2: s2, swid };
      if (!validateCookies(cookies).ok)
        throw new CredentialStoreError("keychain", "invalid_format");
      if (!metaMatches(meta, cookies)) throw new CredentialStoreError("keychain", "corrupt");
      return { cookies, meta };
    },
    write: async (cookies, meta) => {
      if (!validateCookies(cookies).ok)
        throw new CredentialStoreError("keychain", "invalid_format");
      if (!parseMeta(meta).ok || !metaMatches(meta, cookies))
        throw new CredentialStoreError("keychain", "corrupt");
      // a re-run first removes the old `meta`, so a crash mid-write never pairs old meta with a new
      // value; the secret goes in, then `meta` LAST (plan 02 §2.2 "Write")
      await call("write_failed", (k, signal) =>
        k.deletePassword(service, KEYCHAIN_ACCOUNTS.meta, signal),
      );
      await call("write_failed", (k, signal) =>
        k.setPassword(service, KEYCHAIN_ACCOUNTS.espn_s2, cookies.espn_s2, signal),
      );
      await call("write_failed", (k, signal) =>
        k.setPassword(service, KEYCHAIN_ACCOUNTS.swid, cookies.swid, signal),
      );
      await call("write_failed", (k, signal) =>
        k.setPassword(service, KEYCHAIN_ACCOUNTS.meta, metaJson(meta), signal),
      );
    },
    delete: deleteAll,
  };
}
