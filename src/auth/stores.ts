// stores.ts — opening the credential stores (plan 02 §2.2 "One store per install"; plan 03 §3:
// the store config.json records selects it for every process, and so does the session.json path
// recorded beside it; a running process follows a later `eff setup --storage …` — the backend and
// the path — plan 02 §2.2 "Multiple processes", plan 03 L6) and the presence check `eff doctor` #6
// uses ("exactly one store exists — fails when both the keychain `meta` item and session.json are
// present"). Opening a store touches nothing: the keychain addon loads on first use, and config.json
// is read when a file operation starts.
import { PathSecurityError, resolveAbsolute, type XattrReader } from "../config/paths.js";
import {
  readConfigFile,
  scanConfigFileForCredentials,
  type CredentialRecordKey,
  type CredentialStoreKind,
} from "../config/schema.js";
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
  /** `Config.credentialFile` (absolute): the session.json path this process resolved at start. */
  readonly filePath: string;
  /**
   * `Config.configDir`, for the install store (`openCredentialStore`): each of its file operations
   * then goes to the session.json path config.json records at that moment (`recordedCredentialFile`;
   * plan 03 §3: authoritative for every process), so a running process follows `eff setup --storage
   * file` run with another `EFF_CREDENTIAL_FILE` with no restart (plan 03 L6); `filePath` while
   * config.json records none. Without it, and always in the backend pair, the file store stays at
   * `filePath`.
   */
  readonly configDir?: string;
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

/** The file store at `file` with the configuration's location rule (nothing touched here). */
function fileStoreAt(cfg: CredentialStoreConfig, file: string): FileCredentialStore {
  return createFileCredentialStore({
    path: file,
    home: cfg.home,
    repoRoot: cfg.repoRoot,
    ...(cfg.xattr === undefined ? {} : { xattr: cfg.xattr }),
  });
}

/** Creates both backends (nothing is read or loaded here). */
export function openCredentialStores(cfg: CredentialStoreConfig): CredentialStorePair {
  return {
    keychain: createKeychainCredentialStore({
      service: cfg.service ?? KEYCHAIN_SERVICE,
      ...(cfg.loadKeyring === undefined ? {} : { loadKeyring: cfg.loadKeyring }),
    }),
    file: fileStoreAt(cfg, cfg.filePath),
  };
}

/** The config.json key that records the file store's path (plan 03 §2.1 step 4, §3). */
const RECORDED_FILE_KEY: CredentialRecordKey = "EFF_CREDENTIAL_FILE";
/** The longest config.json value startup accepts (src/config/schema.ts `loadConfig`). */
const RECORDED_VALUE_MAX = 4096;

/**
 * The session.json path config.json records now — `eff setup` records the file store's resolved
 * absolute path as `EFF_CREDENTIAL_FILE`, authoritative over env for every process (plan 03 §2.1
 * step 4, §3) — resolved as startup resolves it (`~/` against `home`), or null when config.json is
 * absent or records none. A config.json startup would refuse (not a JSON object, a credential-shaped
 * value, a key value that is not a short string) is never followed: this throws `read_failed`, and
 * a recorded path that is not absolute throws `insecure_location` with the rule — the caller fails
 * closed rather than reading another file. Reads config.json only; never echoes it or the path.
 */
export function recordedCredentialFile(configDir: string, home: string): string | null {
  let raw: unknown;
  try {
    raw = readConfigFile(configDir);
  } catch {
    throw new CredentialStoreError("file", "read_failed");
  }
  if (raw === undefined) return null;
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    scanConfigFileForCredentials(raw).length > 0
  )
    throw new CredentialStoreError("file", "read_failed");
  const rec = raw as Readonly<Record<string, unknown>>;
  if (!Object.prototype.hasOwnProperty.call(rec, RECORDED_FILE_KEY)) return null;
  const value = rec[RECORDED_FILE_KEY];
  if (typeof value !== "string" || value.length > RECORDED_VALUE_MAX)
    throw new CredentialStoreError("file", "read_failed");
  const p = value.trim();
  if (p === "") return null;
  try {
    return resolveAbsolute(p, home, RECORDED_FILE_KEY);
  } catch (e) {
    throw new CredentialStoreError(
      "file",
      "insecure_location",
      e instanceof PathSecurityError ? e.reason : null,
    );
  }
}

/**
 * The install's one store (plan 02 §2.2): both backends opened from the configuration, every
 * operation sent to the one in use. It starts on the kind config.json recorded; once a record is
 * bound (src/auth/state.ts binds the `credential_state` row's `store`), each operation first moves
 * to the backend the record names — so `eff setup --storage …` in another terminal is followed with
 * no restart (plan 02 §2.2 "Multiple processes"; plan 03 L6). The record only ever picks one of
 * these two backends: no path, service or other setting comes from it. The file backend's path is
 * config.json's (`CredentialStoreConfig.configDir`): setup records it there, never in the row, and
 * a path that changes is a new file store whose location rule runs before its first read. Opened
 * without `configDir` it says so (`followsRecordedPath: false`): its file backend stays at the start
 * path, which a setup run from another shell may never have written, so the authority does not
 * take an empty file there as the end of the value a row records.
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
  /** The file backend in use and the path it reads. */
  let file: { readonly path: string; readonly store: FileCredentialStore } = {
    path: cfg.filePath,
    store: pair.file,
  };
  /** The file backend at the path config.json records now (throws when that cannot be known). */
  const fileBackend = (): FileCredentialStore => {
    const configDir = cfg.configDir;
    if (configDir === undefined) return pair.file;
    const p = recordedCredentialFile(configDir, cfg.home) ?? cfg.filePath;
    if (p !== file.path)
      file = { path: p, store: p === cfg.filePath ? pair.file : fileStoreAt(cfg, p) };
    return file.store;
  };
  /** The backend this operation goes to (chosen synchronously, when the operation starts). */
  const backend = (): CredentialStore => {
    let next: CredentialStoreKind | null = null;
    try {
      next = record?.() ?? null;
    } catch {
      next = null; // an unreadable record keeps the backend in use
    }
    if (next === "keychain" || next === "file") current = next;
    return current === "keychain" ? pair.keychain : fileBackend();
  };
  /**
   * Starts `op` on the backend in use. A backend that cannot be chosen rejects — never throws, and
   * only ever with a store error, whose message carries no path (a raw error's might).
   */
  const run = <T>(op: (b: CredentialStore) => Promise<T>): Promise<T> => {
    let b: CredentialStore;
    try {
      b = backend();
    } catch (e) {
      return Promise.reject(
        e instanceof CredentialStoreError ? e : new CredentialStoreError("file", "read_failed"),
      );
    }
    return op(b);
  };
  return {
    get kind(): CredentialStoreKind {
      return current;
    },
    // read as `fileBackend` reads it, when asked (opening touches nothing); unreadable → false
    get followsRecordedPath(): boolean {
      try {
        return cfg.configDir !== undefined;
      } catch {
        return false;
      }
    },
    followRecord: (r) => {
      record = r;
    },
    read: () => run((b) => b.read()),
    readMeta: () => run((b) => b.readMeta()),
    exists: () => run((b) => b.exists()),
    write: (cookies, meta) => run((b) => b.write(cookies, meta)),
    delete: () => run((b) => b.delete()),
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
