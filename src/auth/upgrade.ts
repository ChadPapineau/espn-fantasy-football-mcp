// upgrade.ts — the stored setup metadata (plan 02 §2.2: `storedAt`, `format_version`,
// `fingerprint`, written once at setup) parsed and migrated in memory (plan 03 §7: older shapes are
// upgraded here and rewritten on the next `eff setup`; the secret values are never transformed).
// Format version 1 is the only shape so far; a newer one is refused, never guessed at.
import {
  CREDENTIAL_FORMAT_VERSION,
  FINGERPRINT_RE,
  type EspnCookies,
  type StoredSecretMeta,
} from "./types.js";
import { fingerprintOf } from "./format.js";

/** An ISO-8601 UTC instant as `Date.prototype.toISOString` writes it (what setup records). */
const STORED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/** The outcome of parsing stored metadata. */
export type MetaParse =
  | { readonly ok: true; readonly meta: StoredSecretMeta; readonly upgraded: boolean }
  | { readonly ok: false; readonly reason: "corrupt" | "newer_format" };

/** Whether `s` is a real instant in the recorded grammar (no 2026-02-30). */
export function isStoredAt(s: unknown): s is string {
  if (typeof s !== "string" || !STORED_AT_RE.test(s)) return false;
  const ms = Date.parse(s);
  // Date.parse rolls 2026-02-30 over to March: the calendar date must survive a round trip
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === s.slice(0, 19);
}

/** Own-property read on a parsed JSON object (a `__proto__` key is just a key here). */
function own(o: object, k: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, k) ? (o as Record<string, unknown>)[k] : undefined;
}

/** Parses metadata from a parsed JSON value (keychain `meta` item, or the fields of session.json). */
export function parseMeta(raw: unknown): MetaParse {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { ok: false, reason: "corrupt" };
  const version = own(raw, "format_version");
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1)
    return { ok: false, reason: "corrupt" };
  if (version > CREDENTIAL_FORMAT_VERSION) return { ok: false, reason: "newer_format" };
  const storedAt = own(raw, "storedAt");
  const fingerprint = own(raw, "fingerprint");
  if (!isStoredAt(storedAt) || typeof fingerprint !== "string" || !FINGERPRINT_RE.test(fingerprint))
    return { ok: false, reason: "corrupt" };
  return {
    ok: true,
    meta: { storedAt, format_version: version, fingerprint },
    upgraded: version !== CREDENTIAL_FORMAT_VERSION,
  };
}

/** Parses the `meta` item's JSON text. */
export function parseMetaJson(text: string): MetaParse {
  try {
    return parseMeta(JSON.parse(text) as unknown);
  } catch {
    return { ok: false, reason: "corrupt" };
  }
}

/** The metadata `eff setup` writes for a value stored at `storedAt`. */
export function metaFor(cookies: EspnCookies, storedAt: string): StoredSecretMeta {
  return {
    storedAt,
    format_version: CREDENTIAL_FORMAT_VERSION,
    fingerprint: fingerprintOf(cookies.espn_s2),
  };
}

/** Whether the metadata belongs to these cookies (a partial write leaves a stale fingerprint). */
export function metaMatches(meta: StoredSecretMeta, cookies: EspnCookies): boolean {
  return meta.fingerprint === fingerprintOf(cookies.espn_s2);
}

/** The `meta` item's JSON text (fixed key order; no secret in it). */
export function metaJson(meta: StoredSecretMeta): string {
  return JSON.stringify({
    storedAt: meta.storedAt,
    format_version: meta.format_version,
    fingerprint: meta.fingerprint,
  });
}
