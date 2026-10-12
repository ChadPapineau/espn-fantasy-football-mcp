// stores.ts — opening the credential stores (plan 02 §2.2 "One store per install"; plan 03 §3:
// the store config.json records selects it for every process, and a running process follows a
// later `eff setup --storage …` — plan 02 §2.2 "Multiple processes", plan 03 L6) and the presence
// check `eff doctor` #6 uses ("exactly one store exists — fails when both the keychain `meta` item
// and session.json are present"). Opening a store touches nothing: the keychain addon loads on
// first use.
import type { XattrReader } from "../config/paths.js";
import type { CredentialStoreKind } from "../config/schema.js";
import { createFileCredentialStore, type FileCredentialStore } from "./file.js";
import { CredentialStoreError } from "./errors.js";
import {
  SELFTEST_ACCOUNT,
  createKeychainCredentialStore,
  isAllowedServiceName,
  loadNativeKeyring,
  selftestServiceOf,
  type KeychainCredentialStore,
  type KeyringPort,
} from "./keychain.js";
import {
  KEYCHAIN_SERVICE,
  SELFTEST_TIMEOUT_MS,
  type CredentialStore,
  type CredentialStoreReader,
  type CredentialStoreRecord,
  type FollowingCredentialStoreReader,
} from "./types.js";

/** Everything needed to open either store. */
export interface CredentialStoreConfig {
  /** `Config.credentialFile` (absolute). */
  readonly filePath: string;
  readonly home: string;
  readonly repoRoot: string;
  readonly xattr?: XattrReader;
  /** The keychain service (default the real one; `eff-test-…` only from `eff setup --service-name`). */
  readonly service?: string;
  /** The keyring loader (default: the native addon, loaded lazily). */
  readonly loadKeyring?: () => Promise<KeyringPort>;
}

/** Both backends, unopened until used. */
export interface CredentialStorePair {
  readonly keychain: KeychainCredentialStore;
  readonly file: FileCredentialStore;
}

/** Creates both backends (nothing is read or loaded here). */
export function openCredentialStores(cfg: CredentialStoreConfig): CredentialStorePair {
  return {
    keychain: createKeychainCredentialStore({
      service: cfg.service ?? KEYCHAIN_SERVICE,
      ...(cfg.loadKeyring === undefined ? {} : { loadKeyring: cfg.loadKeyring }),
    }),
    file: createFileCredentialStore({
      path: cfg.filePath,
      home: cfg.home,
      repoRoot: cfg.repoRoot,
      ...(cfg.xattr === undefined ? {} : { xattr: cfg.xattr }),
    }),
  };
}

/**
 * The install's one store (plan 02 §2.2): both backends opened from the configuration, every
 * operation sent to the one in use. It starts on the kind config.json recorded; once a record is
 * bound (src/auth/state.ts binds the `credential_state` row's `store`), each operation first moves
 * to the backend the record names — so `eff setup --storage …` in another terminal is followed with
 * no restart (plan 02 §2.2 "Multiple processes"; plan 03 L6). The record only ever picks one of
 * these two backends: no path, service or other setting comes from it.
 */
export interface InstallCredentialStore extends CredentialStore, FollowingCredentialStoreReader {
  readonly kind: CredentialStoreKind;
}

/** The install's store, starting on the `kind` config.json records. Touches nothing. */
export function openCredentialStore(
  kind: CredentialStoreKind,
  cfg: CredentialStoreConfig,
): InstallCredentialStore {
  const pair = openCredentialStores(cfg);
  let current: CredentialStoreKind = kind;
  let record: CredentialStoreRecord | null = null;
  /** The backend this operation goes to (chosen synchronously, when the operation starts). */
  const backend = (): CredentialStore => {
    let next: CredentialStoreKind | null = null;
    try {
      next = record?.() ?? null;
    } catch {
      next = null; // an unreadable record keeps the backend in use
    }
    if (next === "keychain" || next === "file") current = next;
    return current === "keychain" ? pair.keychain : pair.file;
  };
  return {
    get kind(): CredentialStoreKind {
      return current;
    },
    followRecord: (r) => {
      record = r;
    },
    read: () => backend().read(),
    readMeta: () => backend().readMeta(),
    exists: () => backend().exists(),
    write: (cookies, meta) => backend().write(cookies, meta),
    delete: () => backend().delete(),
  };
}

/** Presence of each store, without reading a secret (keychain: the `meta` item; file: a stat). */
export interface StorePresence {
  readonly keychain: boolean | "error";
  readonly file: boolean | "error";
  /** The forbidden two-store state (plan 02 §8 #21; `doctor` #6 fails on it). */
  readonly twoStores: boolean;
}

/** `eff doctor` #6's presence check. Never throws. */
export async function storePresence(stores: {
  readonly keychain: CredentialStoreReader;
  readonly file: CredentialStoreReader;
}): Promise<StorePresence> {
  const probe = async (s: CredentialStoreReader): Promise<boolean | "error"> => {
    try {
      return await s.exists();
    } catch {
      return "error";
    }
  };
  const keychain = await probe(stores.keychain);
  const file = await probe(stores.file);
  return { keychain, file, twoStores: keychain === true && file === true };
}

/** A deleter for the `<service>-selftest` throwaway item (uninstall's leftover cleanup). */
export function selftestItemDeleter(
  service: string = KEYCHAIN_SERVICE,
  loadKeyring: () => Promise<KeyringPort> = loadNativeKeyring,
): () => Promise<boolean> {
  return async () => {
    if (!isAllowedServiceName(service))
      throw new CredentialStoreError("keychain", "invalid_service");
    let k: KeyringPort;
    try {
      k = await loadKeyring();
    } catch {
      throw new CredentialStoreError("keychain", "unavailable");
    }
    try {
      return await k.deletePassword(
        selftestServiceOf(service),
        SELFTEST_ACCOUNT,
        AbortSignal.timeout(SELFTEST_TIMEOUT_MS),
      );
    } catch {
      throw new CredentialStoreError("keychain", "delete_failed");
    }
  };
}
