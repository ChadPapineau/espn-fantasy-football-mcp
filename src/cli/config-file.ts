// config-file.ts — the one writer of `<config>/config.json` (plan 03 §2.1 steps 4 and 6, §3: `eff
// setup` records the credential store, the file-store path, the keychain self-test outcome,
// ESPN_TEAM_ID and the seeding reading; "no secrets allowed in it"). A patch merges into the current
// file (null removes a key), only file-settable keys and setup records are accepted, the merged
// object must pass the same credential rule startup applies, and the write is atomic and 0600 in a
// 0700 directory that is outside every repository and every synced folder (plan 02 §2.2).
import {
  configFilePath,
  ensureSecureDir,
  locationRefusals,
  writeSecureFileAtomic,
  type XattrReader,
} from "../config/paths.js";
import {
  CONFIG_KEY_SPECS,
  ConfigError,
  SETUP_RECORD_KEYS,
  readConfigFile,
  scanConfigFileForCredentials,
} from "../config/schema.js";

/** A config.json patch: key → string value, or null to remove the key. */
export type ConfigPatch = Readonly<Record<string, string | null>>;

/** Keys `eff` may write into config.json: the file-settable keys and the setup records. */
export const WRITABLE_CONFIG_KEYS: readonly string[] = Object.freeze([
  ...CONFIG_KEY_SPECS.filter((s) => s.fileSettable).map((s) => s.key),
  ...SETUP_RECORD_KEYS,
]);

/** Longest value written (the loader's own bound). */
const MAX_VALUE_LEN = 4096;

/** Where config.json lives and how its location is checked. */
export interface ConfigFileTarget {
  readonly configDir: string;
  readonly home: string;
  readonly repoRoot: string;
  readonly xattr?: XattrReader;
}

/** A refused config.json write (value-free message). */
export class ConfigWriteError extends Error {
  constructor(reason: string) {
    super(`config.json: ${reason}`);
    this.name = "ConfigWriteError";
  }
}

/** The merged object a patch produces over `current` (pure; throws ConfigWriteError). */
export function mergeConfigPatch(
  current: Readonly<Record<string, unknown>>,
  patch: ConfigPatch,
): Record<string, unknown> {
  const map = new Map<string, unknown>(Object.entries(current));
  for (const [k, v] of Object.entries(patch)) {
    if (!WRITABLE_CONFIG_KEYS.includes(k)) throw new ConfigWriteError("refused an unknown key");
    if (v === null) {
      map.delete(k);
      continue;
    }
    if (typeof v !== "string" || v.length > MAX_VALUE_LEN || /[\u0000-\u001f\u007f]/.test(v))
      throw new ConfigWriteError("refused a value that is not a short printable string");
    map.set(k, v);
  }
  const next = Object.fromEntries(map);
  if (scanConfigFileForCredentials(next).length > 0)
    throw new ConfigWriteError("refused: the result would hold a credential-shaped value");
  return next;
}

/**
 * Applies `patch` to config.json atomically (0600; the directory created 0700 when missing). An
 * existing file that is not a JSON object is never overwritten. Returns the object written.
 */
export function patchConfigFile(
  target: ConfigFileTarget,
  patch: ConfigPatch,
): Record<string, unknown> {
  const refusals = locationRefusals(target.configDir, {
    home: target.home,
    repoRoot: target.repoRoot,
    what: "config dir",
    ...(target.xattr === undefined ? {} : { xattr: target.xattr }),
  });
  const first = refusals[0];
  if (first !== undefined) throw new ConfigWriteError(first.detail);
  ensureSecureDir(target.configDir, { create: true, what: "config dir" });
  let current: unknown;
  try {
    current = readConfigFile(target.configDir);
  } catch (e) {
    if (e instanceof ConfigError) throw new ConfigWriteError("the existing file is not valid JSON");
    throw e;
  }
  if (
    current !== undefined &&
    (typeof current !== "object" || current === null || Array.isArray(current))
  )
    throw new ConfigWriteError("the existing file is not a JSON object");
  const next = mergeConfigPatch((current ?? {}) as Record<string, unknown>, patch);
  const sorted = Object.fromEntries(
    Object.keys(next)
      .sort()
      .map((k) => [k, next[k]]),
  );
  writeSecureFileAtomic(
    configFilePath(target.configDir),
    `${JSON.stringify(sorted, null, 2)}\n`,
    "config.json",
  );
  return sorted;
}
