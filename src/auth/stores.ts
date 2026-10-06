// stores.ts — opening the credential stores (plan 02 §2.2 "One store per install"; plan 03 §3:
// the store config.json records selects it for every process) and the presence check `eff doctor`
// #6 uses ("exactly one store exists — fails when both the keychain `meta` item and session.json
// are present"). Opening a store touches nothing: the keychain addon loads on first use.
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

/** The store `kind` names (the one config.json records). */
export function openCredentialStore(
  kind: CredentialStoreKind,
  cfg: CredentialStoreConfig,
): CredentialStore {
  const pair = openCredentialStores(cfg);
  return kind === "keychain" ? pair.keychain : pair.file;
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
