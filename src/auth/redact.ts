// redact.ts — gives the logger's redactor the loaded secret (plan 02 §2.3; plan 01 §8; ADV
// OBJ-15): espn_s2 in its pasted (URL-encoded) form and its decodeURIComponent form, plus a
// case-changed copy of each (lower/upper — the Stage A carried item: a header normaliser or a
// careless `.toLowerCase()` must not leak it). The registrar adds the encoded/escape-case spellings
// and fragment matching itself. SWID is deliberately not registered: every brace-GUID is already
// pseudonymised to `{guid:<6 hex>}` by pattern (plan 02 §2.3), which keeps it correlatable.
import type { EspnCookies, SecretRegistrar } from "./types.js";

/** The registry kind the secret is redacted as (`[redacted:espn_s2]`). */
export const ESPN_S2_SECRET_KIND = "espn_s2";

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** Every spelling of espn_s2 registered: pasted, decoded, and a lower/upper-case copy of each. */
export function espnS2Spellings(espnS2: string): readonly string[] {
  const out = new Set<string>();
  for (const form of [espnS2, safeDecode(espnS2)]) {
    out.add(form);
    out.add(form.toLowerCase());
    out.add(form.toUpperCase());
  }
  return [...out];
}

/** Registers the loaded secret with the redactor (call on every load, before any request). */
export function registerCredentialRedaction(
  registrar: SecretRegistrar,
  cookies: EspnCookies,
): void {
  for (const v of espnS2Spellings(cookies.espn_s2))
    registrar.registerSecret(ESPN_S2_SECRET_KIND, v);
}
