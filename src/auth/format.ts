// format.ts — the credential format rules (plan 02 §2.1 "Format validation"; plan 01 §10; ADV
// OBJ-15: espn_s2 refused under 40 chars, warned at 40–99; SWID a braced GUID, braces kept —
// research 03 §C.1), the 6-hex fingerprint (plan 02 §2.3: debug-only, never shown by status) and
// the Cookie header. Values are kept exactly as pasted (URL-encoded); a verdict never carries one.
import { createHash } from "node:crypto";
import {
  ESPN_S2_MAX_CHARS,
  ESPN_S2_MIN_CHARS,
  ESPN_S2_RE,
  ESPN_S2_WARN_BELOW_CHARS,
  SWID_RE,
  type CookieHeader,
  type EspnCookies,
  type FormatVerdict,
} from "./types.js";

/** A GUID without its braces (the common paste mistake — research 03 §C.1). */
const BARE_GUID_RE = /^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/;
/** Any whitespace (Unicode included) or a quote character: the `.env`/shell mangling pitfall. */
const WHITESPACE_OR_QUOTE_RE = /[\s"'` ‘’“”]/;
/** A pasted `name=` prefix (`espn_s2=…`, `SWID=…`, any case, optional spaces). */
const COOKIE_NAME_PREFIX_RE = /^\s*(?:espn[_-]?s2|swid)\s*[=:]/i;
/** Longest SWID input examined (a SWID is 38 chars; longer input is not a GUID). */
const SWID_MAX_INPUT = 256;

const OK: FormatVerdict = Object.freeze({ ok: true, warning: null });
const SHORT: FormatVerdict = Object.freeze({ ok: true, warning: "espn_s2_short" });

function refuse(
  field: "espn_s2" | "swid",
  reason: Extract<FormatVerdict, { ok: false }>["reason"],
): FormatVerdict {
  return { ok: false, field, reason };
}

/**
 * Removes what a terminal paste adds around a value — surrounding whitespace and line breaks only.
 * Neither cookie can contain whitespace, so this never changes a valid value (setup only).
 */
export function normalizePastedValue(raw: string): string {
  return raw.trim();
}

/** SWID: a braced GUID; lowercase hex accepted; braces kept (plan 02 §2.1). */
export function validateSwid(v: string): FormatVerdict {
  if (v.length <= SWID_MAX_INPUT && SWID_RE.test(v)) return OK;
  if (COOKIE_NAME_PREFIX_RE.test(v)) return refuse("swid", "includes_cookie_name");
  if (v.length > SWID_MAX_INPUT) return refuse("swid", "not_a_guid");
  if (WHITESPACE_OR_QUOTE_RE.test(v)) return refuse("swid", "whitespace_or_quote");
  const inner = v.replace(/^\{/, "").replace(/\}$/, "");
  return BARE_GUID_RE.test(inner) ? refuse("swid", "missing_braces") : refuse("swid", "not_a_guid");
}

/**
 * espn_s2: the cookie alphabet, exactly as pasted; refused < 40 chars and > 4096; warned at 40–99
 * ("shorter than expected; the ESPN check will decide" — ADV OBJ-15).
 */
export function validateEspnS2(v: string): FormatVerdict {
  if (v.length > ESPN_S2_MAX_CHARS) return refuse("espn_s2", "too_long");
  if (COOKIE_NAME_PREFIX_RE.test(v)) return refuse("espn_s2", "includes_cookie_name");
  if (WHITESPACE_OR_QUOTE_RE.test(v)) return refuse("espn_s2", "whitespace_or_quote");
  if (v.length > 0 && !ESPN_S2_RE.test(v)) return refuse("espn_s2", "bad_characters");
  if (v.length < ESPN_S2_MIN_CHARS) return refuse("espn_s2", "too_short");
  return v.length < ESPN_S2_WARN_BELOW_CHARS ? SHORT : OK;
}

/** Both cookies, SWID first (the order `eff setup` asks for them). */
export function validateCookies(c: EspnCookies): FormatVerdict {
  const swid = validateSwid(c.swid);
  return swid.ok ? validateEspnS2(c.espn_s2) : swid;
}

/** 6 hex chars of sha256(espn_s2) — the only credential identifier ever logged (debug level). */
export function fingerprintOf(espnS2: string): string {
  return createHash("sha256").update(espnS2, "utf8").digest("hex").slice(0, 6);
}

/**
 * The Cookie header value (`espn_s2=…; SWID=…` — research 03 §C.1: sent verbatim). Refuses values
 * that fail the format rules, so a header can never smuggle `;`, a line break or a second cookie.
 */
export function buildCookieHeader(c: EspnCookies): CookieHeader {
  if (!validateCookies(c).ok) throw new TypeError("cookie values fail the format rules");
  return `espn_s2=${c.espn_s2}; SWID=${c.swid}` as CookieHeader;
}

/** The human sentence for a refusal (fixed text; names the field, never the value). */
export function formatRefusalText(v: Extract<FormatVerdict, { ok: false }>): string {
  const name = v.field === "swid" ? "SWID" : "espn_s2";
  switch (v.reason) {
    case "missing_braces":
      return "SWID must keep its braces: {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}.";
    case "not_a_guid":
      return "SWID is not a GUID: copy the whole SWID value, braces included.";
    case "too_short":
      return `espn_s2 is shorter than ${String(ESPN_S2_MIN_CHARS)} characters: it was cut off; copy the whole value.`;
    case "too_long":
      return `espn_s2 is longer than ${String(ESPN_S2_MAX_CHARS)} characters: that is not one cookie value.`;
    case "whitespace_or_quote":
      return `${name} contains a space, a line break or a quote: copy the value alone, exactly as DevTools shows it.`;
    case "bad_characters":
      return "espn_s2 contains characters a cookie value cannot have: copy it exactly as DevTools shows it (URL-encoded).";
    case "includes_cookie_name":
      return `paste the ${name} value only, without the "${name}=" name in front.`;
  }
}

/** The warning for a 40–99 char espn_s2 (ADV OBJ-15). */
export const ESPN_S2_SHORT_WARNING =
  "espn_s2 is shorter than expected (under 100 characters); the ESPN check will decide.";
