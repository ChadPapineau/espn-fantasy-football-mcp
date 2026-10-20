// seeding.ts — the operator's seeding reading as a running server follows it (plan 07 C12: every
// result says `seeding.confirmed: false` until `onboard` records the answer with `eff setup
// --seeding …`; plan 03 §2.1 `--seeding`, §3 precedence; Stage C finding services-seeding-read-once).
// `eff setup --seeding` records EFF_SEEDING_MODE and seeding_confirmed_at in config.json while the
// server runs — the onboard Skill runs it mid-session and then asks for the weekly plan — so the
// composition root re-reads them at the start of every tool call and resource read (src/services/
// index.ts `beforeCall`) and resolves them exactly as a server started now would
// (src/config/schema.ts `loadConfig`): the mode env > config.json > `espn_rule`, the confirmation
// config.json's alone. A config.json start would refuse in what this reads — unreadable or not JSON,
// not a JSON object, a credential-shaped value or secret-looking key anywhere, a seeding value that
// is not a string of at most 4096 characters, a mode that is not one of the two, a confirmation that
// is not an ISO-8601 instant — is never followed: the reading in use stays, and one value-free
// warning says why (the same rule as src/auth/stores.ts `recordedCredentialFile`). config.json is
// read only, never echoed; no network, no credential store.
// The reading reaches the services object the call reads (`adoptSeedingReading`): the object the
// composition root builds reads the reader through accessors, but a copy spread from it holds the
// values the spread read once — and `eff serve` hands the server such a copy (src/cli/serve.ts adds
// its in-flight accounting so), so without this the stdio server kept its start reading until the
// client restarted (Stage C finding services-seeding-read-once, attempt 2).
import {
  SEEDING_MODES,
  isIsoInstant,
  isOneOf,
  readConfigFile,
  scanConfigFileForCredentials,
  type Config,
  type SeedingMode,
} from "../config/schema.js";
import type { McpLogger } from "../mcp/services.js";

/** The operator's seeding reading: the mode in use and when `eff setup --seeding` confirmed it. */
export interface SeedingReading {
  readonly mode: SeedingMode;
  /** config.json `seeding_confirmed_at`; null = unconfirmed (plan 07 C12). */
  readonly confirmedAt: string | null;
}

/** Why a config.json's seeding record is not followed (fixed, value-free codes). */
export const SEEDING_RECORD_REFUSALS = Object.freeze([
  "unreadable",
  "not_object",
  "credential_shaped",
  "mode_invalid",
  "confirmed_at_invalid",
] as const);
export type SeedingRecordRefusal = (typeof SEEDING_RECORD_REFUSALS)[number];

/** A config.json's seeding record: the reading a server started now would resolve, or why not. */
export type SeedingRecord =
  | { readonly ok: true; readonly reading: SeedingReading }
  | { readonly ok: false; readonly reason: SeedingRecordRefusal };

/** loadConfig's default reading (plan 07 C12: whatever `playoffSeedingRule` says). */
export const SEEDING_MODE_DEFAULT: SeedingMode = "espn_rule";

/** The longest config.json value startup accepts (src/config/schema.ts `loadConfig`). */
const RECORDED_VALUE_MAX = 4096;

/** A config.json key's value as startup reads it: trimmed; undefined = absent or blank; null = refused. */
function recordedValue(
  rec: Readonly<Record<string, unknown>>,
  key: string,
): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(rec, key)) return undefined;
  const v = rec[key];
  if (typeof v !== "string" || v.length > RECORDED_VALUE_MAX) return null;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/**
 * The seeding reading a server started now would resolve from `file` (config.json parsed;
 * `undefined` when absent) with `envMode` the EFF_SEEDING_MODE its environment set (null: none —
 * the environment is the process's own and never changes under it): `loadConfig`'s rules for these
 * keys exactly, and its file-level refusals (not an object; the credential rule).
 */
export function seedingRecordOf(file: unknown, envMode: SeedingMode | null): SeedingRecord {
  const ok = (mode: SeedingMode, confirmedAt: string | null): SeedingRecord => ({
    ok: true,
    reading: Object.freeze({ mode, confirmedAt }),
  });
  const refused = (reason: SeedingRecordRefusal): SeedingRecord => ({ ok: false, reason });
  if (file === undefined) return ok(envMode ?? SEEDING_MODE_DEFAULT, null);
  if (typeof file !== "object" || file === null || Array.isArray(file))
    return refused("not_object");
  if (scanConfigFileForCredentials(file).length > 0) return refused("credential_shaped");
  const rec = file as Readonly<Record<string, unknown>>;
  // startup checks every recorded value's shape before precedence picks one (an env value wins
  // over a well-formed file value, never over a malformed one)
  const fileMode = recordedValue(rec, "EFF_SEEDING_MODE");
  if (fileMode === null) return refused("mode_invalid");
  const at = recordedValue(rec, "seeding_confirmed_at");
  if (at === null) return refused("confirmed_at_invalid");
  let mode: SeedingMode = SEEDING_MODE_DEFAULT;
  if (envMode !== null) mode = envMode;
  else if (fileMode !== undefined) {
    if (!isOneOf(SEEDING_MODES, fileMode)) return refused("mode_invalid");
    mode = fileMode;
  }
  if (at !== undefined && !isIsoInstant(at)) return refused("confirmed_at_invalid");
  return ok(mode, at ?? null);
}

/** The services fields that carry the reading (src/mcp/services.ts `McpServices`). */
export const SEEDING_FIELDS = Object.freeze(["seedingMode", "seedingConfirmedAt"] as const);

/** The services fields' values for `reading`. */
export function seedingFieldsOf(reading: SeedingReading): {
  readonly seedingMode: SeedingMode;
  readonly seedingConfirmedAt: string | null;
} {
  return { seedingMode: reading.mode, seedingConfirmedAt: reading.confirmedAt };
}

/**
 * Brings `target` — the services object a tool call or resource read is about to read — to
 * `reading`, and says whether it now reads it. The object the composition root builds reads its
 * reader through accessors, so it is there already; a copy spread from that object (the serve CLI
 * adds its in-flight accounting so; the test worlds add a seed) holds plain values the spread read
 * once, and they are set here. The operator's record always wins: a value a copy set itself is
 * replaced at its next call (a test sets its reading through the environment or config.json). A
 * target that cannot take them (frozen; a getter of its own that reads something else) is left as
 * it is, and the answer is false. Reflect.set never throws for a read-only property; only a
 * throwing getter, setter or proxy trap of the target's own can throw.
 */
export function adoptSeedingReading(target: object, reading: SeedingReading): boolean {
  const want = seedingFieldsOf(reading);
  let held = true;
  for (const key of SEEDING_FIELDS) {
    if (Reflect.get(target, key) === want[key]) continue;
    Reflect.set(target, key, want[key]);
    if (Reflect.get(target, key) !== want[key]) held = false;
  }
  return held;
}

/** The reading a running server uses, re-read per call. */
export interface SeedingReader {
  /** The reading in use: the start configuration's until a refresh finds another. */
  current(): SeedingReading;
  /** Re-reads config.json (the start of every tool call and resource read). Never throws. */
  refresh(): void;
}

/** What the reader is built from: the start configuration (its config dir, reading and origins). */
export type SeedingReaderConfig = Pick<
  Config,
  "configDir" | "seedingMode" | "seedingConfirmedAt" | "origins"
>;

/**
 * The server's seeding reader. It starts on the reading the server started with (validated by
 * `loadConfig`); each refresh resolves config.json as a server started now would and adopts the
 * result (one `seeding.reading_changed` info line when it differs: the mode and whether it is
 * confirmed), or keeps the reading in use when that config.json cannot be followed (one
 * `seeding.record_refused` warning per run of the same reason — the reason code only). `read` is
 * config.json's reader (tests inject failures); an empty config dir (no config dir) never reads.
 */
export function createSeedingReader(
  config: SeedingReaderConfig,
  logger: McpLogger,
  read: (configDir: string) => unknown = readConfigFile,
): SeedingReader {
  const envMode = config.origins.EFF_SEEDING_MODE === "env" ? config.seedingMode : null;
  let reading: SeedingReading = Object.freeze({
    mode: config.seedingMode,
    confirmedAt: config.seedingConfirmedAt,
  });
  let refusing: SeedingRecordRefusal | null = null;
  const refresh = (): void => {
    if (config.configDir === "") return;
    let rec: SeedingRecord;
    try {
      rec = seedingRecordOf(read(config.configDir), envMode);
    } catch {
      rec = { ok: false, reason: "unreadable" };
    }
    if (!rec.ok) {
      const first = refusing !== rec.reason;
      refusing = rec.reason;
      if (first)
        logger.warn("seeding.record_refused", { reason: rec.reason, mode_kept: reading.mode });
      return;
    }
    refusing = null;
    const next = rec.reading;
    if (next.mode === reading.mode && next.confirmedAt === reading.confirmedAt) return;
    reading = next;
    logger.info("seeding.reading_changed", {
      mode: next.mode,
      confirmed: next.confirmedAt !== null,
    });
  };
  return {
    current: () => reading,
    refresh: () => {
      try {
        refresh();
      } catch {
        // a throwing log sink must not break the call that refreshed (the reading stays as it is)
      }
    },
  };
}
