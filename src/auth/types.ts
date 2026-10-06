// types.ts — the credential contract (plan 01 §10; plan 02 §2): the CredentialStore seam with its
// keychain and file backends (read-only after setup in both — changelog V5), the stored secret and
// its setup metadata (`storedAt`, `format_version`, `fingerprint`), the format rules (plan 02 §2.1,
// ADV OBJ-15), the cookie-header port the provider asks (plan 01 §10), and the credential state
// machine exactly as plan 02 §2.1's diagram draws it. Observations live in store.sqlite's
// `credential_state` row (types in src/store/types.ts, re-exported here), never in the store.
import type { CredentialState, CredentialStoreKind } from "../config/schema.js";
import type { CredentialObserver, CredentialStateRow } from "../store/types.js";

export type { CredentialState, CredentialStoreKind } from "../config/schema.js";
export type {
  CredentialObserver,
  CredentialStateRepository,
  CredentialStateRow,
} from "../store/types.js";

// --- identifiers and format (plan 01 §10; plan 02 §2.1, §2.2) ------------------------------------

/** The keychain service and accounts (plan 01 §10; changelog G13: `meta` = setup metadata only). */
export const KEYCHAIN_SERVICE = "espn-fantasy-football-mcp";
export const KEYCHAIN_ACCOUNTS = Object.freeze({
  espn_s2: "espn_s2",
  swid: "SWID",
  meta: "meta",
} as const);
/** The launchd-context self-test's throwaway item suffix (plan 03 §2.1 step 4). */
export const SELFTEST_SERVICE_SUFFIX = "-selftest";
/** `eff setup --service-name` is test-only and must start with this (changelog V8). */
export const TEST_SERVICE_PREFIX = "eff-test-";
/** The launchd-context self-test's read timeout (plan 02 §2.2; ADV OBJ-25). */
export const SELFTEST_TIMEOUT_MS = 10_000;

/** SWID: a braced GUID, braces kept (research 03 §C.1). Personal data, not a secret. */
export const SWID_RE = /^\{[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}\}$/;
/** espn_s2: the cookie alphabet, kept URL-encoded exactly as pasted (plan 02 §2.1). */
export const ESPN_S2_RE = /^[A-Za-z0-9%+/=._-]+$/;
/** Refuse below 40 chars; warn at 40–99 and proceed (ADV OBJ-15); refuse above 4096 (sanity bound). */
export const ESPN_S2_MIN_CHARS = 40;
export const ESPN_S2_WARN_BELOW_CHARS = 100;
export const ESPN_S2_MAX_CHARS = 4096;

/** The current shape of the stored metadata (plan 03 §7: migrated in memory by `upgrade.ts`). */
export const CREDENTIAL_FORMAT_VERSION = 1;
/** A credential is "stale" for the Skills' Step 0 at this age (research 06 §A.2; plan 07 G1). */
export const STALE_CREDENTIAL_DAYS = 30;
/** `espn_check_auth` at most once per minute (plan 02 §2.1). */
export const CHECK_AUTH_MIN_INTERVAL_MS = 60_000;
/** The daily `credential check` job: ≤ 1 probe/day off-season, ≤ 2/day in season (plan 06 §1.4). */
export const DAILY_PROBE_MAX = Object.freeze({ in_season: 2, off_season: 1 });

/** The two cookies. A JavaScript string cannot be zeroed — held only in the transport closure. */
export interface EspnCookies {
  /** The URL-encoded bearer secret — a password-equivalent; never logged, never returned. */
  readonly espn_s2: string;
  /** The braced member GUID. */
  readonly swid: string;
}

/**
 * The setup metadata written once, beside the secret (keychain `meta` item / inside session.json).
 * Field names as plan 02 §2.2 writes them.
 */
export interface StoredSecretMeta {
  /** When `eff setup` stored the value — the reload check compares this field (plan 03 §6; L6). */
  readonly storedAt: string;
  readonly format_version: number;
  /** 6 hex chars of sha256(espn_s2) — debug-level only; `eff status` shows none (plan 02 §2.3). */
  readonly fingerprint: string;
}

/** Fingerprint grammar. */
export const FINGERPRINT_RE = /^[0-9a-f]{6}$/;

/** The secret and its metadata, as read lazily on the first cookie-bearing call. */
export interface StoredCredential {
  readonly cookies: EspnCookies;
  readonly meta: StoredSecretMeta;
}

/** A format verdict (plan 02 §2.1): a value that fails is never stored and never logged. */
export type FormatVerdict =
  | { readonly ok: true; readonly warning: "espn_s2_short" | null }
  | {
      readonly ok: false;
      readonly field: "espn_s2" | "swid";
      readonly reason:
        | "missing_braces"
        | "not_a_guid"
        | "too_short"
        | "too_long"
        | "whitespace_or_quote"
        | "bad_characters"
        /** Additive (B1): the pasted value starts with its cookie name (`espn_s2=…`, `SWID=…`). */
        | "includes_cookie_name";
    };

/**
 * Additive (B1): what the credential code needs from the logger (src/cli/log.ts `Logger` satisfies
 * it structurally; src/auth may not import src/cli). Registered values are redacted in every form.
 */
export interface SecretRegistrar {
  registerSecret(kind: string, value: string): void;
}

// --- the store seam (plan 02 §2.2) -------------------------------------------------------------

/**
 * The read side every process uses (server, jobs, doctor). Reads are lazy — never on the startup
 * path (plan 01 §2) — and the stores are read-only after setup.
 */
export interface CredentialStoreReader {
  readonly kind: CredentialStoreKind;
  /** The secret and metadata, or null when nothing is stored. */
  read(): Promise<StoredCredential | null>;
  /** Only the metadata — the reload check compares `storedAt` without touching the secret. */
  readMeta(): Promise<StoredSecretMeta | null>;
  /** Whether something is stored without reading the secret (file: a stat; keychain: the meta item). */
  exists(): Promise<boolean>;
}

/** The write side — `eff setup` and `eff uninstall` only. */
export interface CredentialStoreWriter {
  /** Writes the secret then the metadata (keychain: `meta` last; file: wx + fsync + rename). */
  write(cookies: EspnCookies, meta: StoredSecretMeta): Promise<void>;
  /** Deletes every item (setup --reset, a failed setup, uninstall). */
  delete(): Promise<void>;
}

/** A backend: the keychain (`@napi-rs/keyring`, only in src/auth/keychain.ts) or the 0600 file. */
export type CredentialStore = CredentialStoreReader & CredentialStoreWriter;

// --- the cookie-header port (plan 01 §10) ------------------------------------------------------

/** A Cookie header value (`espn_s2=…; SWID=…`). Branded; never logged (the logger redacts it). */
export type CookieHeader = string & { readonly __cookieHeader: true };

/** Why no header is available (the provider maps these to plan 01 §4.3 codes). */
export type CookieUnavailable =
  /** → ESPN_REQUIRES_COOKIES */
  | "not_configured"
  /** → ESPN_AUTH_REJECTED (the short-circuit: zero requests). */
  | "rejected"
  /** → INTERNAL (the store could not be read; `eff doctor` #6/#7). */
  | "unreadable"
  /** → INTERNAL (a stored value fails the format rules; `eff doctor` #8). */
  | "invalid_format";

/** The result of asking for the Cookie header. */
export type CookieHeaderResult =
  | { readonly ok: true; readonly header: CookieHeader }
  | { readonly ok: false; readonly reason: CookieUnavailable };

/**
 * A credential observation to record (plan 02 §2.1: only discriminating observations count).
 * `league_not_found` is setup-only (mSettings 404: the league id is wrong — not a credential
 * verdict); any other observer's 404 is never recorded (plan 07 G2: ESPN_LEAGUE_NOT_FOUND).
 */
export interface CredentialObservation {
  readonly kind: "accepted" | "rejected" | "league_not_found";
  readonly at: string;
  readonly by: CredentialObserver;
  readonly upstream_status: number | null;
  /** The view the observation came from (the rejected view becomes the daily discriminating probe). */
  readonly view: string | null;
}

/**
 * What the provider's transport holds (plan 01 §10): a header or a typed failure, plus the
 * observation recorder that persists to `credential_state`. Implemented in src/auth/state.ts.
 */
export interface CredentialAuthority {
  /** The current state label (from the store.sqlite row at startup; never a keychain read). */
  state(): CredentialState;
  /**
   * The header for a cookie-bearing request. In `rejected` it returns the typed failure WITHOUT
   * touching the network — after re-checking `storedAt` and the `credential_state` row (plan 02
   * §2.1 short-circuit; changelog C1-7).
   */
  getCookieHeader(): Promise<CookieHeaderResult>;
  /** Records a discriminating observation and applies the transition. */
  observe(o: CredentialObservation): Promise<CredentialState>;
}

// --- the state machine (plan 02 §2.1 diagram) --------------------------------------------------

/** The events that move the credential state. */
export const CREDENTIAL_EVENTS = [
  /** eff setup: format validation passed, value written to the store. */
  "setup_stored",
  /** setup probe accepted (200, or 404 on an informative board probe). */
  "setup_probe_accepted",
  /** setup probe 401/403 — value deleted, user told. */
  "setup_probe_rejected",
  /** setup mSettings 404 — league id wrong, value deleted. */
  "setup_league_not_found",
  /** espn_check_auth, eff doctor --online, or the daily credential-check probe accepted. */
  "probe_accepted",
  /** A discriminating cookie-bearing 200 on an ordinary request (plan 02 §2.1 acceptance rule). */
  "cookie_accepted",
  /** Any cookie-bearing 401/403 after setup — value kept, no retry. */
  "cookie_rejected",
  /** eff setup re-run with a new value. */
  "setup_rerun",
  /** eff setup --reset or eff uninstall. */
  "reset",
] as const;
export type CredentialEvent = (typeof CREDENTIAL_EVENTS)[number];

/**
 * The transition table. A missing entry is not a transition (the event is ignored in that state).
 * One recorded reading: `stored + cookie_accepted → validated` — plan 02 §2.1's acceptance rule
 * covers ordinary calls "for every process and every request"; the diagram draws the edge only
 * from `validated`.
 */
export const CREDENTIAL_TRANSITIONS: Readonly<
  Record<CredentialState, Readonly<Partial<Record<CredentialEvent, CredentialState>>>>
> = Object.freeze({
  not_configured: Object.freeze({ setup_stored: "stored" }),
  stored: Object.freeze({
    setup_probe_accepted: "validated",
    probe_accepted: "validated",
    cookie_accepted: "validated",
    setup_probe_rejected: "not_configured",
    setup_league_not_found: "not_configured",
    cookie_rejected: "rejected",
    setup_rerun: "stored",
    reset: "not_configured",
  }),
  validated: Object.freeze({
    cookie_accepted: "validated",
    probe_accepted: "validated",
    cookie_rejected: "rejected",
    setup_rerun: "stored",
    reset: "not_configured",
  }),
  rejected: Object.freeze({
    probe_accepted: "validated",
    cookie_rejected: "rejected",
    setup_rerun: "stored",
    reset: "not_configured",
  }),
});

/** The next state, or null when `event` is not a transition from `state`. */
export function nextCredentialState(
  state: CredentialState,
  event: CredentialEvent,
): CredentialState | null {
  return CREDENTIAL_TRANSITIONS[state][event] ?? null;
}

/**
 * The event an observation is: an ordinary request (server) vs a probe (setup, doctor, tool, job).
 * Setup's own probe is special (plan 02 §2.1 diagram): its 401/403 deletes the value
 * (`setup_probe_rejected` → not_configured) and its mSettings 404 means a wrong league id
 * (`setup_league_not_found` → not_configured). A `league_not_found` from anyone but setup is not
 * an event at all (null — the caller records nothing).
 */
export function observationEvent(
  o: Pick<CredentialObservation, "kind" | "by">,
): CredentialEvent | null {
  if (o.kind === "league_not_found") return o.by === "setup" ? "setup_league_not_found" : null;
  if (o.kind === "rejected") return o.by === "setup" ? "setup_probe_rejected" : "cookie_rejected";
  if (o.by === "server") return "cookie_accepted";
  return o.by === "setup" ? "setup_probe_accepted" : "probe_accepted";
}

/**
 * The row after an observation (pure; the store writes it through
 * `CredentialStateRepository.transition`). An observation that is not a transition from the row's
 * state leaves the row unchanged — e.g. no acceptance is recorded while `rejected` except by a
 * probe (the short-circuit makes ordinary calls impossible there). A transition to
 * `not_configured` (setup's rejected probe or wrong league — the value was deleted) clears every
 * observation of the deleted value: `stored_at`, `last_*`, `rejected_*`, `next_probe_at`.
 */
export function applyObservation(
  row: CredentialStateRow,
  o: CredentialObservation,
): CredentialStateRow {
  const event = observationEvent(o);
  const next = event === null ? null : nextCredentialState(row.state, event);
  if (next === null) return row;
  if (next === "not_configured") {
    return {
      ...row,
      state: next,
      stored_at: null,
      last_accepted_at: null,
      last_rejected_at: null,
      rejected_since: null,
      rejected_view: null,
      next_probe_at: null,
      board_probe_discriminates: null,
      updated_at: o.at,
      updated_by: o.by,
    };
  }
  if (o.kind === "accepted") {
    return {
      ...row,
      state: next,
      last_accepted_at: o.at,
      rejected_since: null,
      rejected_view: null,
      next_probe_at: null,
      updated_at: o.at,
      updated_by: o.by,
    };
  }
  return {
    ...row,
    state: next,
    last_rejected_at: o.at,
    rejected_since: row.state === "rejected" ? row.rejected_since : o.at,
    rejected_view: o.view ?? row.rejected_view,
    updated_at: o.at,
    updated_by: o.by,
  };
}
