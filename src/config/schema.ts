// schema.ts — every key the code reads, with its scope (server | launcher | test), default and
// precedence: env > <config>/config.json > defaults, except EFF_CREDENTIAL_STORE/EFF_CREDENTIAL_FILE
// where the value `eff setup` recorded wins (plan 03 §3; changelog V2, G18, C1-11). Also the shared
// leaf vocabularies (config is the one layer auth, store, drift and mcp may all import — plan 01
// §1.1), the read-host override rule (plan 02 S12), and the CLI exit codes (plan 03 §1.3).
// Ported from sibling @d72e03b, adapted (EFF_ keys, scopes, ESPN ids; Yahoo/manual keys dropped).
import {
  PathSecurityError,
  configFilePath,
  defaultCredentialFilePath,
  locationRefusals,
  readSecureFile,
  resolveAbsolute,
  resolveCacheDir,
  resolveConfigDir,
  systemXattrReader,
  type Env,
  type XattrReader,
} from "./paths.js";

// --- exit codes (plan 03 §1.3, shared by serve and every eff subcommand) ------------------------

/** Process exit codes: clean, error, usage/config, credentials, drift (`probe`/`doctor`), forced. */
export const EXIT_CODES = Object.freeze({
  ok: 0,
  error: 1,
  usage: 2,
  credentials: 3,
  drift: 4,
  forced: 5,
} as const);
/** One exit code. */
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

// --- shared leaf vocabularies ------------------------------------------------------------------

/** stderr log levels, most severe first (plan 01 §8). */
export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
/** Registered tool sets (plan 07 C3): `core` = the 18 P0 tools, `full` = all 34 read tools. */
export const TOOLSETS = ["core", "full"] as const;
export type Toolset = (typeof TOOLSETS)[number];
/** The operator's seeding reading (plan 07 C12; HANDOFF D1). Never model-set. */
export const SEEDING_MODES = ["espn_rule", "points_only"] as const;
export type SeedingMode = (typeof SEEDING_MODES)[number];
/** Weather sources for outdoor games (plan 03 §3). */
export const WEATHER_SOURCES = ["open-meteo", "nws"] as const;
export type WeatherSource = (typeof WEATHER_SOURCES)[number];
/** The credential store backends (plan 02 §2.2): one per install. */
export const CREDENTIAL_STORE_KINDS = ["keychain", "file"] as const;
export type CredentialStoreKind = (typeof CREDENTIAL_STORE_KINDS)[number];
/** The credential state machine's states (plan 02 §2.1; plan 07 G1 `credential.state`). */
export const CREDENTIAL_STATES = ["not_configured", "stored", "validated", "rejected"] as const;
export type CredentialState = (typeof CREDENTIAL_STATES)[number];
/** Drift detector status (plan 01 §7; plan 07 G1 `drift.status`). */
export const DRIFT_STATUSES = ["green", "additive", "red", "host_moved"] as const;
export type DriftStatus = (typeof DRIFT_STATUSES)[number];
/** Outcome of `eff setup`'s launchd-context keychain test (plan 02 §2.2; ADV OBJ-25). */
export const KEYCHAIN_SELFTEST_OUTCOMES = ["ok", "timeout", "error"] as const;
export type KeychainSelftestOutcome = (typeof KEYCHAIN_SELFTEST_OUTCOMES)[number];

/** Whether `v` is one of `list` (a typed membership check for the vocabularies above). */
export function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

// --- ESPN identity grammar ---------------------------------------------------------------------

/**
 * An ESPN league id: digits, no leading zero, ≤ 12 digits; `0` is the fixture league (CLAUDE.md).
 * Never logged (plan 01 §8 `[league]`), never a tool argument (plan 02 §5).
 */
export const ESPN_LEAGUE_ID_RE = /^(?:0|[1-9][0-9]{0,11})$/;
/** Whether `s` is a syntactically valid ESPN league id. */
export function isLeagueId(s: string): boolean {
  return ESPN_LEAGUE_ID_RE.test(s);
}
/** The first season the modern league route serves (research 03 §A.1; plan 02 §5). */
export const SEASON_MIN = 2018;
/** Team ids accepted anywhere (plan 02 §5, A-2: widened on evidence). */
export const TEAM_ID_MIN = 1;
export const TEAM_ID_MAX = 20;
/** The optional setup page's default port and fallback range (plan 03 §2.2, A-5). */
export const SETUP_PORT_DEFAULT = 8790;
export const SETUP_PORT_RANGE = Object.freeze({ min: 8790, max: 8799 });

/**
 * The season a call means when none is given: the calendar year from July on, else the previous
 * year (ESPN `seasonId` is the year the NFL season starts; plan 03 §7 re-records each August).
 */
export function defaultSeason(nowMs: number): number {
  if (!Number.isFinite(nowMs)) throw new RangeError("config: now must be finite");
  const d = new Date(nowMs);
  return d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

/** The read host used unless the operator overrides it (research 03 §A.1). */
export const ESPN_READ_HOST_DEFAULT = "lm-api-reads.fantasy.espn.com";
/**
 * PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; owner decision D11). The ESPN write host. No
 * request is ever sent to it (CLAUDE.md); it is named here only so the read-host override can
 * refuse it and the allow-list tests can assert its absence.
 */
export const ESPN_WRITE_HOST = "lm-api-writes.fantasy.espn.com";
/** The API path prefix on the read host (research 03 §A.1). */
export const ESPN_API_BASE_PATH = "/apis/v3/games/ffl";
/** The read-host override grammar (plan 02 S12; ADV OBJ-06): one label under `fantasy.espn.com`. */
export const ESPN_READ_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.fantasy\.espn\.com$/;

/**
 * Whether `host` may be the read host: the grammar above and never the write host — a GET to the
 * write host is still a request to it, which the project never makes (decision recorded).
 */
export function isAllowedReadHost(host: string): boolean {
  return (
    ESPN_READ_HOST_RE.test(host) && host !== ESPN_WRITE_HOST && !host.startsWith("lm-api-writes")
  );
}

// --- nflverse identity grammar (research 04 §C; plan 05 §2 domain/crosswalk) ----------------------

/** nflverse team abbreviations (`LA` = Rams, `WAS` = Washington — ESPN spells LAR/WSH). */
// prettier-ignore
export const NFL_TEAMS = [
  "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB", "HOU", "IND",
  "JAX", "KC", "LA", "LAC", "LV", "MIA", "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SEA", "SF",
  "TB", "TEN", "WAS",
] as const;
export type NflTeam = (typeof NFL_TEAMS)[number];
/** Whether `s` is an nflverse team abbreviation. */
export function isNflTeam(s: string): s is NflTeam {
  return (NFL_TEAMS as readonly string[]).includes(s);
}
/** nflverse gsis id grammar (`00-0012345`). */
export const GSIS_ID_RE = /^00-[0-9]{7}$/;

// --- keys -------------------------------------------------------------------------------------

/** Where a key is read (changelog V2): the server and CLI, the launch shim only, or tests only. */
export const CONFIG_SCOPES = ["server", "launcher", "test"] as const;
export type ConfigScope = (typeof CONFIG_SCOPES)[number];

/** Every key the code reads (plan 03 §3). */
export const CONFIG_KEYS = [
  "ESPN_LEAGUE_ID",
  "ESPN_SEASON",
  "ESPN_TEAM_ID",
  "EFF_CONFIG_DIR",
  "EFF_CACHE_DIR",
  "EFF_CREDENTIAL_STORE",
  "EFF_CREDENTIAL_FILE",
  "EFF_LOG_LEVEL",
  "EFF_TOOLSET",
  "EFF_SEEDING_MODE",
  "EFF_WEATHER_SOURCE",
  "EFF_SETUP_PORT",
  "EFF_PROBE_LEAGUE_ID",
  "EFF_ESPN_READ_HOST",
  "EFF_ENABLE_WRITES",
  "ODDS_API_KEY",
  "WEATHER_API_KEY",
  "EFF_NODE",
  "EFF_FIXTURE_DIR",
  "EFF_FIXTURE_RECORD",
  "EFF_TEST_STUBS",
] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

/** Documentation row for one key — the single source of the README tables and `.env.example`. */
export interface ConfigKeySpec {
  readonly key: ConfigKey;
  readonly scope: ConfigScope;
  /** One-line description (no values). */
  readonly description: string;
  /** The default as text; null = unset by default. */
  readonly default: string | null;
  /** Holds a secret: env only, never logged, never enumerable on Config. */
  readonly secret: boolean;
  /** May appear in `<config>/config.json`. */
  readonly fileSettable: boolean;
  /** `now` = read by this build; `writes` = inert until Phase W; `reserved` = accepted, unused. */
  readonly status: "now" | "writes" | "reserved";
}

const spec = (
  key: ConfigKey,
  scope: ConfigScope,
  description: string,
  def: string | null,
  o: { secret?: boolean; file?: boolean; status?: ConfigKeySpec["status"] } = {},
): ConfigKeySpec =>
  Object.freeze({
    key,
    scope,
    description,
    default: def,
    secret: o.secret ?? false,
    fileSettable: o.file ?? false,
    status: o.status ?? "now",
  });

/** The key table, in README order. */
// prettier-ignore
export const CONFIG_KEY_SPECS: readonly ConfigKeySpec[] = Object.freeze([
  spec("ESPN_LEAGUE_ID", "server", "Numeric ESPN league id from the league URL. Required; personal — never commit a real value.", null, { file: true }),
  spec("ESPN_SEASON", "server", "Season year to read (2018 or later).", "the current NFL season", { file: true }),
  spec("ESPN_TEAM_ID", "server", "Your team id in the league; recorded by `eff setup` from the stored SWID.", null, { file: true }),
  spec("EFF_CONFIG_DIR", "server", "Config directory (0700; config.json, session.json). Env only; client-config installs only.", "~/.config/espn-fantasy-football-mcp"),
  spec("EFF_CACHE_DIR", "server", "Cache directory (0700; store.sqlite, datasets/, backups/). Env only; client-config installs only.", "~/.cache/espn-fantasy-football-mcp"),
  spec("EFF_CREDENTIAL_STORE", "server", "keychain | file. One store per install, recorded by `eff setup`; the recorded value wins over env.", "keychain", { file: true }),
  spec("EFF_CREDENTIAL_FILE", "server", "Path of the 0600 file store (file store only); recorded by `eff setup`, which wins over env.", "<config>/session.json", { file: true }),
  spec("EFF_LOG_LEVEL", "server", "stderr log level: error | warn | info | debug.", "info", { file: true }),
  spec("EFF_TOOLSET", "server", "Registered tools: core (the 18 P0 tools) | full (all 34 read tools).", "core", { file: true }),
  spec("EFF_SEEDING_MODE", "server", "Playoff seeding reading: espn_rule | points_only. Set by `eff setup --seeding`.", "espn_rule", { file: true }),
  spec("EFF_WEATHER_SOURCE", "server", "Weather source for outdoor games: open-meteo (non-commercial) | nws.", "open-meteo", { file: true }),
  spec("EFF_SETUP_PORT", "server", "Exact port for `eff setup --page` (no fallback when set). Unset: 8790, then 8790-8799.", null, { file: true }),
  spec("EFF_PROBE_LEAGUE_ID", "server", "A public ESPN league id for the keyless drift probe. Local only; never commit a real value.", null, { file: true }),
  spec("EFF_ESPN_READ_HOST", "server", "Emergency read-host override; must match ^[a-z0-9-]+\\.fantasy\\.espn\\.com$ and is never the write host.", ESPN_READ_HOST_DEFAULT, { file: true }),
  spec("EFF_ENABLE_WRITES", "server", "Inert: the write module is not built (plan 10 §3.W; D11). Exactly true or false; env only.", "false", { status: "writes" }),
  spec("ODDS_API_KEY", "server", "Optional The Odds API key (secondary lines). Env only; never logged.", null, { secret: true }),
  spec("WEATHER_API_KEY", "server", "Reserved; unused by Open-Meteo and NWS. Env only; never logged.", null, { secret: true, status: "reserved" }),
  spec("EFF_NODE", "launcher", "Absolute Node path for scripts/eff-launch.sh (the plugin shim). Unset: resolved automatically.", null),
  spec("EFF_FIXTURE_DIR", "test", "Fixture mode: serve recorded, anonymised fixtures from this absolute directory.", null),
  spec("EFF_FIXTURE_RECORD", "test", "Raw-body recording for fixture capture (1 | 0); raw bodies stay outside the repo.", "0"),
  spec("EFF_TEST_STUBS", "test", "Startup test stubs (1 | 0): any network call or keychain read exits 99.", "0"),
]);

/** The keys of one scope, in table order. */
export function configKeysByScope(scope: ConfigScope): readonly ConfigKeySpec[] {
  return CONFIG_KEY_SPECS.filter((s) => s.scope === scope);
}

/** The keys `.env.example` documents: server and launcher scopes (changelog V2). */
export function envExampleKeys(): readonly ConfigKey[] {
  return CONFIG_KEY_SPECS.filter((s) => s.scope !== "test").map((s) => s.key);
}

/**
 * Non-env fields `eff setup` records in config.json (plan 02 §3.2, plan 03 §2.1, plan 07 C12):
 * the seeding confirmation, the Phase W acknowledgement (inert today) and the keychain self-test.
 */
export const SETUP_RECORD_KEYS = [
  "seeding_confirmed_at",
  "writes_acknowledged_at",
  "acknowledged_text_sha256",
  "keychain_selftest_outcome",
  "keychain_selftest_at",
] as const;
export type SetupRecordKey = (typeof SETUP_RECORD_KEYS)[number];

/** The two keys whose recorded config.json value is authoritative over env (plan 03 §3). */
export const CREDENTIAL_RECORD_KEYS = ["EFF_CREDENTIAL_STORE", "EFF_CREDENTIAL_FILE"] as const;
export type CredentialRecordKey = (typeof CREDENTIAL_RECORD_KEYS)[number];

// --- errors -----------------------------------------------------------------------------------

/** One configuration problem. `reason` never contains the offending value. */
export interface ConfigIssue {
  readonly key: string;
  readonly reason: string;
}

/**
 * Configuration is invalid: startup exits 2 with one stderr line per issue (plan 03 §1.1). Inside a
 * tool call it maps to INTERNAL, never VALIDATION — the model's arguments are not at fault.
 */
export class ConfigError extends Error {
  readonly effCode = "INTERNAL" as const;
  readonly exitCode = EXIT_CODES.usage;
  readonly issues: readonly ConfigIssue[];
  constructor(issues: readonly ConfigIssue[]) {
    super(`invalid configuration: ${issues.map((i) => `${i.key}: ${i.reason}`).join("; ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

// --- credential-shaped content (plan 03 §3 "no secrets allowed in config.json"; §5 #3) ------------

function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const COOKIE_ALPHABET_RE = /^[A-Za-z0-9%+/=._-]+$/;
const GUID_IN_TEXT_RE =
  /(?:\{|%7B)[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}(?:\}|%7D)/i;
const NAMED_COOKIE_RE = /\b(?:espn[_-]?s2|swid)\s*[=:]/i;

/**
 * Whether a string value looks like an ESPN credential: a named `espn_s2=`/`SWID=` assignment, a
 * brace-GUID (raw or URL-encoded — a SWID is personal data, not config), or a bare espn_s2-shaped
 * run (the scanner's shape: ≥ 40 cookie-alphabet chars with ≥ 2 percent-escapes, or ≥ 100 starting
 * `AE`, mixed case with digits and high entropy). Paths (`/`, `~`) are never cookie-shaped here.
 */
export function looksLikeCredentialValue(v: string): boolean {
  if (NAMED_COOKIE_RE.test(v) || GUID_IN_TEXT_RE.test(v)) return true;
  const t = v.trim();
  if (t.length < 40 || t.length > 8192 || t.startsWith("/") || t.startsWith("~")) return false;
  if (!COOKIE_ALPHABET_RE.test(t)) return false;
  const escapes = (t.match(/%[0-9A-Fa-f]{2}/g) ?? []).length;
  const shaped = escapes >= 2 || (t.length >= 100 && t.startsWith("AE"));
  return shaped && /[A-Z]/.test(t) && /[a-z]/.test(t) && /\d/.test(t) && shannonEntropy(t) >= 3.5;
}

/** A key name that suggests a secret (only checked on keys that are not known keys). */
const SECRETISH_KEY_RE =
  /espn[_-]?s2|swid|cookie|secret|token|passw(?:or)?d|api[_-]?key|credential/i;

/** The fixed issue texts (never echo a key or value — either might be a secret). */
// prettier-ignore
export const CONFIG_FILE_ISSUES = Object.freeze({
  secretKey: "a secret-looking key is not allowed in config.json (cookies live only in the credential store; API keys only in the environment)",
  credentialValue: "a value in config.json looks like an ESPN credential (espn_s2, SWID or a member GUID); remove it and run `eff setup`",
  notObject: "must be a JSON object",
  notString: "value must be a string of at most 4096 characters",
});

/** The warning for unknown config.json keys (plan 03 §7: additive; never echoes the key). */
export const UNKNOWN_FILE_KEYS_WARNING = "unknown key(s) in config.json are ignored";

const MAX_VALUE_LEN = 4096;
const FILE_KEYS: readonly string[] = CONFIG_KEY_SPECS.filter((s) => s.fileSettable).map(
  (s) => s.key,
);
const SECRET_KEYS: ReadonlySet<string> = new Set(
  CONFIG_KEY_SPECS.filter((s) => s.secret).map((s) => s.key),
);

/**
 * The credential rule over a parsed config.json (startup and `eff doctor` share it): secret-looking
 * unknown keys, secret keys, and credential-shaped values anywhere (nested values included).
 */
export function scanConfigFileForCredentials(raw: unknown): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const add = (reason: string): void => {
    if (!issues.some((i) => i.reason === reason)) issues.push({ key: "config.json", reason });
  };
  const walk = (v: unknown, depth: number): void => {
    if (depth > 8) return;
    if (typeof v === "string") {
      if (looksLikeCredentialValue(v)) add(CONFIG_FILE_ISSUES.credentialValue);
      return;
    }
    if (typeof v !== "object" || v === null) return;
    for (const child of Array.isArray(v) ? v : Object.values(v)) walk(child, depth + 1);
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return issues;
  for (const [k, v] of Object.entries(raw)) {
    const known = FILE_KEYS.includes(k) || (SETUP_RECORD_KEYS as readonly string[]).includes(k);
    if (SECRET_KEYS.has(k) || (!known && SECRETISH_KEY_RE.test(k)))
      add(CONFIG_FILE_ISSUES.secretKey);
    walk(v, 0);
  }
  return issues;
}

// --- the resolved configuration ----------------------------------------------------------------

/** Where a resolved value came from. */
export type ValueOrigin = "env" | "file" | "default";

/** Secrets held by the config: non-enumerable on `Config`, so serialisation omits them. */
export interface ConfigSecrets {
  readonly oddsApiKey: string | null;
  readonly weatherApiKey: string | null;
}

/** The recorded Phase W acknowledgement (inert: plan 02 §3.2 Acknowledgement gate). */
export interface WritesAcknowledgement {
  readonly at: string;
  readonly textSha256: string;
}

/** The recorded launchd-context keychain test (plan 02 §2.2; `doctor` #7). */
export interface KeychainSelftestRecord {
  readonly outcome: KeychainSelftestOutcome;
  readonly at: string | null;
}

/** The validated, fully resolved configuration. */
export interface Config {
  /** ESPN_LEAGUE_ID (canonical digits). Register with the logger as an identifier. */
  readonly leagueId: string;
  readonly probeLeagueId: string | null;
  readonly season: number;
  readonly teamId: number | null;
  readonly credentialStore: CredentialStoreKind;
  /** Absolute file-store path (used only when `credentialStore === "file"`). */
  readonly credentialFile: string;
  readonly configDir: string;
  readonly cacheDir: string;
  readonly logLevel: LogLevel;
  readonly toolset: Toolset;
  readonly seedingMode: SeedingMode;
  /** When `eff setup --seeding` recorded the reading; null = unconfirmed (plan 07 C12). */
  readonly seedingConfirmedAt: string | null;
  readonly weatherSource: WeatherSource;
  readonly setupPort: number | null;
  readonly espnReadHost: string;
  /** The Env registration gate's raw value (EFF_ENABLE_WRITES === "true"). Reported, never honoured. */
  readonly writesRequested: boolean;
  /** PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; D11): always false in this build. */
  readonly writesEnabled: false;
  readonly writesAcknowledgement: WritesAcknowledgement | null;
  readonly keychainSelftest: KeychainSelftestRecord | null;
  readonly fixtureDir: string | null;
  readonly fixtureRecord: boolean;
  readonly testStubs: boolean;
  readonly origins: Readonly<Record<ConfigKey, ValueOrigin>>;
  /** Env values ignored because config.json recorded a different one (`doctor` #6 fails on these). */
  readonly credentialEnvConflicts: readonly CredentialRecordKey[];
  /** Non-fatal notices (never contain values). */
  readonly warnings: readonly string[];
  readonly secrets: ConfigSecrets;
}

/** A config resolved without requiring a league id (CLI paths such as `doctor`, `print-config`). */
export type LenientConfig = Omit<Config, "leagueId"> & { readonly leagueId: string | null };

/** Everything `loadConfig` reads, injected (no ambient process state). */
export interface ConfigInput {
  readonly env: Env;
  /** Parsed config.json, or undefined when absent. */
  readonly file: unknown;
  readonly home: string;
  /** The package checkout root; config, cache and credential paths must not be inside it. */
  readonly repoRoot: string;
  /** The current instant (season default and bound). */
  readonly nowMs: number;
  /** The file-provider xattr reader (tests stub it). */
  readonly xattr?: XattrReader;
}

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** A real ISO-8601 instant: the grammar AND a calendar date that exists (no 2026-02-30). */
export function isIsoInstant(s: string): boolean {
  const m = ISO_RE.exec(s);
  if (m === null) return false;
  const [y, mo, d, h, mi, sec, oh, om] = m
    .slice(1)
    .map((x: string | undefined) => (x === undefined ? 0 : Number(x)));
  const date = new Date(Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 0));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === (mo ?? 1) - 1 &&
    date.getUTCDate() === d &&
    (h ?? 0) <= 23 &&
    (mi ?? 0) <= 59 &&
    (sec ?? 0) <= 59 &&
    (oh ?? 0) <= 23 &&
    (om ?? 0) <= 59
  );
}

function envStr(env: Env, key: string): string | undefined {
  const v = env[key];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

function pathReason(e: unknown): string {
  return e instanceof PathSecurityError ? e.detail : "path could not be checked";
}

/** Resolves the configuration; throws one ConfigError listing every issue. */
export function loadConfig(input: ConfigInput): Config;
export function loadConfig(input: ConfigInput, opts: { requireLeagueId: false }): LenientConfig;
export function loadConfig(
  input: ConfigInput,
  opts: { requireLeagueId: boolean } = { requireLeagueId: true },
): Config | LenientConfig {
  const { env, home, repoRoot, nowMs } = input;
  const xattr = input.xattr ?? systemXattrReader;
  const issues: ConfigIssue[] = [];
  const warnings: string[] = [];
  const origins = {} as Record<ConfigKey, ValueOrigin>;
  const issue = (key: string, reason: string): void => {
    if (!issues.some((i) => i.key === key && i.reason === reason)) issues.push({ key, reason });
  };

  // config.json shape + credential rule
  const fileVals = new Map<string, string>();
  if (input.file !== undefined) {
    if (typeof input.file !== "object" || input.file === null || Array.isArray(input.file)) {
      issue("config.json", CONFIG_FILE_ISSUES.notObject);
    } else {
      for (const i of scanConfigFileForCredentials(input.file)) issue(i.key, i.reason);
      let unknownKeys = 0;
      for (const [k, v] of Object.entries(input.file as Record<string, unknown>)) {
        const known = FILE_KEYS.includes(k) || (SETUP_RECORD_KEYS as readonly string[]).includes(k);
        if (!known) {
          if ((CONFIG_KEYS as readonly string[]).includes(k) && !SECRET_KEYS.has(k))
            warnings.push(`${k} is env-only; its config.json value is ignored`);
          else if (!SECRET_KEYS.has(k)) unknownKeys++;
          continue;
        }
        if (typeof v !== "string" || v.length > MAX_VALUE_LEN)
          issue(k, CONFIG_FILE_ISSUES.notString);
        else if (v.trim() !== "") fileVals.set(k, v.trim());
      }
      if (unknownKeys > 0) warnings.push(UNKNOWN_FILE_KEYS_WARNING);
    }
  }

  for (const k of Object.keys(env)) {
    if (
      (k.startsWith("EFF_") || k.startsWith("ESPN_")) &&
      !(CONFIG_KEYS as readonly string[]).includes(k) &&
      !k.startsWith("EFF_SCAN_")
    ) {
      warnings.push(`unknown environment variable ${k.slice(0, 64)} (typo?) is ignored`);
    }
  }

  const pick = (key: ConfigKey): string | undefined => {
    const e = envStr(env, key);
    if (e !== undefined) {
      origins[key] = "env";
      if (e.length > MAX_VALUE_LEN) {
        issue(key, "value is too long");
        return undefined;
      }
      return e;
    }
    const f = fileVals.get(key);
    if (f !== undefined) {
      origins[key] = "file";
      return f;
    }
    origins[key] = "default";
    return undefined;
  };
  const oneOf = <T extends string>(key: ConfigKey, allowed: readonly T[], def: T): T => {
    const v = pick(key);
    if (v === undefined) return def;
    if (isOneOf(allowed, v)) return v;
    issue(key, `must be one of: ${allowed.join(" | ")}`);
    return def;
  };
  const intIn = (key: ConfigKey, min: number, max: number): number | null => {
    const v = pick(key);
    if (v === undefined) return null;
    const n = /^[0-9]{1,6}$/.test(v) ? Number(v) : NaN;
    if (Number.isInteger(n) && n >= min && n <= max) return n;
    issue(key, `must be an integer ${String(min)}-${String(max)}`);
    return null;
  };
  const flag = (key: ConfigKey): boolean => {
    const v = pick(key);
    if (v === undefined || v === "0" || v === "false") return false;
    if (v === "1" || v === "true") return true;
    issue(key, "must be 1, 0, true or false");
    return false;
  };

  // directories (env only) and their location rule
  let configDir = "";
  try {
    configDir = resolveConfigDir(env, home);
  } catch (e) {
    issue("EFF_CONFIG_DIR", pathReason(e));
  }
  origins.EFF_CONFIG_DIR = envStr(env, "EFF_CONFIG_DIR") !== undefined ? "env" : "default";
  let cacheDir = "";
  try {
    cacheDir = resolveCacheDir(env, home);
  } catch (e) {
    issue("EFF_CACHE_DIR", pathReason(e));
  }
  origins.EFF_CACHE_DIR = envStr(env, "EFF_CACHE_DIR") !== undefined ? "env" : "default";
  const guard = (key: string, p: string): void => {
    for (const r of locationRefusals(p, { home, repoRoot, xattr, what: key })) issue(key, r.detail);
  };
  if (configDir) guard("EFF_CONFIG_DIR", configDir);
  if (cacheDir) guard("EFF_CACHE_DIR", cacheDir);

  // league identity
  const leagueRaw = pick("ESPN_LEAGUE_ID");
  let leagueId: string | null = null;
  if (leagueRaw === undefined) {
    if (opts.requireLeagueId)
      issue("ESPN_LEAGUE_ID", "is required (the numeric id from your ESPN league URL)");
  } else if (isLeagueId(leagueRaw)) leagueId = leagueRaw;
  else issue("ESPN_LEAGUE_ID", "must be the numeric league id (digits only, no leading zero)");

  const probeRaw = pick("EFF_PROBE_LEAGUE_ID");
  let probeLeagueId: string | null = null;
  if (probeRaw !== undefined) {
    if (isLeagueId(probeRaw)) probeLeagueId = probeRaw;
    else issue("EFF_PROBE_LEAGUE_ID", "must be a numeric league id (digits only, no leading zero)");
  }

  const current = defaultSeason(nowMs);
  const seasonRaw = pick("ESPN_SEASON");
  let season = current;
  if (seasonRaw !== undefined) {
    const n = /^[0-9]{4}$/.test(seasonRaw) ? Number(seasonRaw) : NaN;
    if (Number.isInteger(n) && n >= SEASON_MIN && n <= current + 1) season = n;
    else
      issue("ESPN_SEASON", `must be a year from ${String(SEASON_MIN)} to ${String(current + 1)}`);
  }
  const teamId = intIn("ESPN_TEAM_ID", TEAM_ID_MIN, TEAM_ID_MAX);

  // credential store + file: the recorded config.json value is authoritative (plan 03 §3)
  const credentialEnvConflicts: CredentialRecordKey[] = [];
  const recorded = (key: CredentialRecordKey): string | undefined => {
    const f = fileVals.get(key);
    const e = envStr(env, key);
    if (f !== undefined && e !== undefined && e !== f) credentialEnvConflicts.push(key);
    return f;
  };
  let credentialStore: CredentialStoreKind = "keychain";
  const storeRec = recorded("EFF_CREDENTIAL_STORE");
  const storeRaw = storeRec ?? envStr(env, "EFF_CREDENTIAL_STORE");
  origins.EFF_CREDENTIAL_STORE =
    storeRec !== undefined ? "file" : storeRaw !== undefined ? "env" : "default";
  if (storeRaw !== undefined) {
    if (isOneOf(CREDENTIAL_STORE_KINDS, storeRaw)) credentialStore = storeRaw;
    else issue("EFF_CREDENTIAL_STORE", "must be one of: keychain | file");
  }
  const fileRec = recorded("EFF_CREDENTIAL_FILE");
  const fileRaw = fileRec ?? envStr(env, "EFF_CREDENTIAL_FILE");
  origins.EFF_CREDENTIAL_FILE =
    fileRec !== undefined ? "file" : fileRaw !== undefined ? "env" : "default";
  let credentialFile = configDir ? defaultCredentialFilePath(configDir) : "";
  if (fileRaw !== undefined) {
    try {
      credentialFile = resolveAbsolute(fileRaw, home, "EFF_CREDENTIAL_FILE");
    } catch (e) {
      issue("EFF_CREDENTIAL_FILE", pathReason(e));
      credentialFile = "";
    }
  }
  if (credentialFile && credentialStore === "file") guard("EFF_CREDENTIAL_FILE", credentialFile);
  for (const k of credentialEnvConflicts)
    warnings.push(
      `${k} in the environment disagrees with the value eff setup recorded; the recorded value is used`,
    );

  const logLevel = oneOf("EFF_LOG_LEVEL", LOG_LEVELS, "info");
  const toolset = oneOf("EFF_TOOLSET", TOOLSETS, "core");
  const seedingMode = oneOf("EFF_SEEDING_MODE", SEEDING_MODES, "espn_rule");
  const weatherSource = oneOf("EFF_WEATHER_SOURCE", WEATHER_SOURCES, "open-meteo");
  const setupPort = intIn("EFF_SETUP_PORT", 1024, 65535);

  const hostRaw = pick("EFF_ESPN_READ_HOST");
  let espnReadHost = ESPN_READ_HOST_DEFAULT;
  if (hostRaw !== undefined) {
    if (isAllowedReadHost(hostRaw)) espnReadHost = hostRaw;
    else
      issue(
        "EFF_ESPN_READ_HOST",
        "must match ^[a-z0-9-]+\\.fantasy\\.espn\\.com$ and must not be the write host",
      );
  }
  if (espnReadHost !== ESPN_READ_HOST_DEFAULT)
    warnings.push(
      "EFF_ESPN_READ_HOST overrides the ESPN read host (the emergency path; the permanent fix is a release)",
    );

  // EFF_ENABLE_WRITES: env only, exactly true|false, inert (plan 02 §3.2; PHASE W SEAM)
  const writesRaw = envStr(env, "EFF_ENABLE_WRITES");
  origins.EFF_ENABLE_WRITES = writesRaw === undefined ? "default" : "env";
  let writesRequested = false;
  if (writesRaw !== undefined) {
    if (writesRaw === "true") writesRequested = true;
    else if (writesRaw !== "false") issue("EFF_ENABLE_WRITES", "must be exactly true or false");
  }
  if (writesRequested)
    warnings.push(
      "EFF_ENABLE_WRITES=true is inert: the write module is not built (plan 10 §3.W; D11)",
    );

  // setup records
  const seedingAt = fileVals.get("seeding_confirmed_at");
  let seedingConfirmedAt: string | null = null;
  if (seedingAt !== undefined) {
    if (isIsoInstant(seedingAt)) seedingConfirmedAt = seedingAt;
    else issue("seeding_confirmed_at", "must be an ISO-8601 instant");
  }
  const ackAt = fileVals.get("writes_acknowledged_at");
  const ackSha = fileVals.get("acknowledged_text_sha256");
  let writesAcknowledgement: WritesAcknowledgement | null = null;
  if (ackAt !== undefined || ackSha !== undefined) {
    if (
      ackAt !== undefined &&
      ackSha !== undefined &&
      isIsoInstant(ackAt) &&
      SHA256_HEX_RE.test(ackSha)
    )
      writesAcknowledgement = Object.freeze({ at: ackAt, textSha256: ackSha });
    else
      issue("writes_acknowledged_at", "acknowledgement must have an ISO-8601 instant and a sha256");
  }
  const stOutcome = fileVals.get("keychain_selftest_outcome");
  const stAt = fileVals.get("keychain_selftest_at");
  let keychainSelftest: KeychainSelftestRecord | null = null;
  if (stOutcome !== undefined) {
    if (
      isOneOf(KEYCHAIN_SELFTEST_OUTCOMES, stOutcome) &&
      (stAt === undefined || isIsoInstant(stAt))
    )
      keychainSelftest = Object.freeze({ outcome: stOutcome, at: stAt ?? null });
    else
      issue("keychain_selftest_outcome", "must be ok | timeout | error with an ISO-8601 instant");
  }

  // test scope
  const fixtureRaw = envStr(env, "EFF_FIXTURE_DIR");
  origins.EFF_FIXTURE_DIR = fixtureRaw === undefined ? "default" : "env";
  let fixtureDir: string | null = null;
  if (fixtureRaw !== undefined) {
    try {
      fixtureDir = resolveAbsolute(fixtureRaw, home, "EFF_FIXTURE_DIR");
    } catch (e) {
      issue("EFF_FIXTURE_DIR", pathReason(e));
    }
  }
  const fixtureRecord = flag("EFF_FIXTURE_RECORD");
  const testStubs = flag("EFF_TEST_STUBS");
  origins.EFF_NODE = envStr(env, "EFF_NODE") === undefined ? "default" : "env";

  // secrets: env only
  const oddsApiKey = envStr(env, "ODDS_API_KEY") ?? null;
  const weatherApiKey = envStr(env, "WEATHER_API_KEY") ?? null;
  origins.ODDS_API_KEY = oddsApiKey === null ? "default" : "env";
  origins.WEATHER_API_KEY = weatherApiKey === null ? "default" : "env";
  for (const [key, v] of [
    ["ODDS_API_KEY", oddsApiKey],
    ["WEATHER_API_KEY", weatherApiKey],
  ] as const) {
    if (v !== null && v.length > MAX_VALUE_LEN) issue(key, "value is too long");
  }

  if (issues.length > 0) throw new ConfigError(issues);

  const config = {
    leagueId,
    probeLeagueId,
    season,
    teamId,
    credentialStore,
    credentialFile,
    configDir,
    cacheDir,
    logLevel,
    toolset,
    seedingMode,
    seedingConfirmedAt,
    weatherSource,
    setupPort,
    espnReadHost,
    writesRequested,
    writesEnabled: false as const,
    writesAcknowledgement,
    keychainSelftest,
    fixtureDir,
    fixtureRecord,
    testStubs,
    origins: Object.freeze(origins),
    credentialEnvConflicts: Object.freeze(credentialEnvConflicts),
    warnings: Object.freeze(warnings),
  };
  Object.defineProperty(config, "secrets", {
    value: Object.freeze({ oddsApiKey, weatherApiKey }),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(config) as LenientConfig;
}

/** Every secret value the config holds — the logger registers these for redaction (plan 01 §8). */
export function secretValues(
  config: Pick<Config, "secrets">,
): readonly { kind: string; value: string }[] {
  const out: { kind: string; value: string }[] = [];
  if (config.secrets.oddsApiKey !== null)
    out.push({ kind: "api_key", value: config.secrets.oddsApiKey });
  if (config.secrets.weatherApiKey !== null)
    out.push({ kind: "api_key", value: config.secrets.weatherApiKey });
  return out;
}

/** The identifiers the logger must replace with `[league]` (plan 01 §8): the configured ids. */
export function identifierValues(
  config: Pick<LenientConfig, "leagueId" | "probeLeagueId">,
): readonly { kind: "league"; value: string }[] {
  const out: { kind: "league"; value: string }[] = [];
  for (const v of [config.leagueId, config.probeLeagueId])
    if (v !== null && !out.some((o) => o.value === v)) out.push({ kind: "league", value: v });
  return out;
}

/**
 * Reads `<config>/config.json`: missing → undefined; never follows a symlink; ≤ 64 KiB; malformed
 * JSON is a ConfigError (the content is never echoed).
 */
export function readConfigFile(configDir: string): unknown {
  const text = readSecureFile(configFilePath(configDir), {
    requirePrivate: false,
    maxBytes: 64 * 1024,
    what: "config.json",
  });
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConfigError([{ key: "config.json", reason: "is not valid JSON" }]);
  }
}

/** Options of `loadConfigFromProcess`. */
export interface ProcessConfigOptions {
  readonly env: Env;
  readonly home: string;
  readonly repoRoot: string;
  readonly nowMs: number;
  readonly xattr?: XattrReader;
}

/** config dir → config.json → loadConfig. An unusable config dir is reported by loadConfig. */
export function loadConfigFromProcess(opts: ProcessConfigOptions): Config;
export function loadConfigFromProcess(
  opts: ProcessConfigOptions,
  mode: { requireLeagueId: false },
): LenientConfig;
export function loadConfigFromProcess(
  opts: ProcessConfigOptions,
  mode: { requireLeagueId: boolean } = { requireLeagueId: true },
): Config | LenientConfig {
  let configDir: string | null;
  try {
    configDir = resolveConfigDir(opts.env, opts.home);
  } catch {
    configDir = null;
  }
  let file: unknown;
  if (configDir !== null) {
    try {
      file = readConfigFile(configDir);
    } catch (e) {
      if (e instanceof ConfigError) throw e;
      throw new ConfigError([{ key: "config.json", reason: pathReason(e) }]);
    }
  }
  const input: ConfigInput = { ...opts, file };
  return mode.requireLeagueId ? loadConfig(input) : loadConfig(input, { requireLeagueId: false });
}

/** The `.env.example` text's variable names (`NAME=` or `# NAME=`), for the sync test. */
export function envExampleNames(text: string): readonly string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line.trim());
    if (m?.[1] !== undefined && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}
