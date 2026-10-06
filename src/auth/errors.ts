// errors.ts — the one typed error every credential-store backend throws (plan 02 §2.2: "refuse
// (typed error)"; §2.3: an error message is never built from a value). Messages are fixed texts:
// never a cookie value, a length, a fingerprint, a path or an upstream/native error message.
import type { PathRefusal } from "../config/paths.js";
import type { CredentialStoreKind } from "../config/schema.js";
import type { CookieUnavailable } from "./types.js";

/** Why a credential-store operation failed. */
export type CredentialStoreErrorReason =
  /** The backend cannot be reached at all (the keychain addon failed to load; no platform store). */
  | "unavailable"
  /** A read failed (keychain access refused, an I/O error). */
  | "read_failed"
  /** The operation did not finish in time (a hidden Keychain prompt, a hang). */
  | "timeout"
  /** The stored data is malformed: bad JSON, missing items, fingerprint mismatch. */
  | "corrupt"
  /** The metadata was written by a newer version (plan 03 §7). */
  | "newer_format"
  /** A value fails the plan 02 §2.1 format rules (never stored; a stored one is reported). */
  | "invalid_format"
  /** The file store's location or mode failed a safety rule (see `refusal`). */
  | "insecure_location"
  /** A write failed. */
  | "write_failed"
  /** A delete failed. */
  | "delete_failed"
  /** The keychain service name is neither the real one nor a test name (`eff-test-…`). */
  | "invalid_service";

const TEXT: Readonly<Record<CredentialStoreErrorReason, string>> = Object.freeze({
  unavailable: "the credential store is not available on this machine",
  read_failed: "the credential store could not be read",
  timeout: "the credential store did not answer in time (a Keychain prompt may be waiting)",
  corrupt: "the stored credential is incomplete or malformed; run `eff setup` again",
  newer_format: "the stored credential was written by a newer version; upgrade the package",
  invalid_format: "the stored credential fails the format rules; run `eff setup` again",
  insecure_location: "the credential file location or permissions are unsafe",
  write_failed: "the credential could not be written",
  delete_failed: "the stored credential could not be deleted",
  invalid_service: "the keychain service name is not allowed",
});

/** A credential-store failure. Safe to log and to show: it carries no value and no path. */
export class CredentialStoreError extends Error {
  /** Cross-layer code (plan 01 §4.3): an operator/environment problem, never the model's fault. */
  readonly effCode = "INTERNAL" as const;
  readonly reason: CredentialStoreErrorReason;
  readonly store: CredentialStoreKind;
  /** The path rule that refused the file store (only with `insecure_location`). */
  readonly refusal: PathRefusal | null;
  constructor(
    store: CredentialStoreKind,
    reason: CredentialStoreErrorReason,
    refusal: PathRefusal | null = null,
  ) {
    super(`${store} store: ${TEXT[reason]}${refusal === null ? "" : ` (${refusal})`}`);
    this.name = "CredentialStoreError";
    this.store = store;
    this.reason = reason;
    this.refusal = refusal;
  }
}

/** What the provider is told when the store fails (plan 01 §10: a typed failure, never a value). */
export function cookieUnavailableFor(e: unknown): CookieUnavailable {
  return e instanceof CredentialStoreError && e.reason === "invalid_format"
    ? "invalid_format"
    : "unreadable";
}

/** A fixed-vocabulary code from an untrusted string (a port's error code): never echoes it. */
export function safeCode(s: unknown): string {
  return typeof s === "string" && /^[a-z0-9_.-]{1,40}$/i.test(s) ? s : "error";
}
