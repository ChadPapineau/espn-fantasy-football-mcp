// probe-access.ts — the authority plus probe access, the ONE wrapper both composition roots use
// (src/services/index.ts for `eff serve`, src/cli/espn-stack.ts for every other `eff` command and the
// launchd jobs; plan 02 §2.1 "The definitive check", ADV OBJ-04). It forwards EVERY member of the
// handle, rejectedNow included: the two copies the roots each kept forwarded state, getCookieHeader,
// observe, dropSecret and holdsSecret but not the optional rejectedNow, so the provider's cookie gate
// fell back to this process's label and a read in flight sent a cookie another process had got
// rejected (plan 02 §2.1 "Short-circuit": zero requests once rejected; the round-4b review's CS-1 of
// the round-4 V4-S1 fix), and a refused read under an open breaker came back as stale settings
// labelled an outage (changelog §R10, R10-18). rejectedNow is required on CredentialAuthorityHandle
// now, so tsc refuses a wrapper that drops it.
import { cookieUnavailableFor } from "./errors.js";
import { buildCookieHeader } from "./format.js";
import { registerCredentialRedaction } from "./redact.js";
import type { CredentialAuthorityHandle } from "./state.js";
import type { CookieHeaderResult, CredentialStore, SecretRegistrar } from "./types.js";

/** The authority plus probe access (the provider's CredentialProbeAccess — plan 02 §2.1). */
export type ProbingAuthority = CredentialAuthorityHandle & {
  getCookieHeaderForProbe(): Promise<CookieHeaderResult>;
};

/**
 * Adds probe access: the definitive check (espn_check_auth, the daily `credential check`, `eff
 * doctor --online`) reads the stored value directly — even while `rejected` — so the one explicit
 * probe can flip `rejected → validated` (plan 02 §2.1, ADV OBJ-04). The value is registered with the
 * redactor before it is used; it is never returned or logged. Every other member is the authority's
 * own, forwarded.
 */
export function withProbeAccess(
  authority: CredentialAuthorityHandle,
  store: CredentialStore,
  registrar: SecretRegistrar,
): ProbingAuthority {
  return {
    state: () => authority.state(),
    getCookieHeader: () => authority.getCookieHeader(),
    observe: (o) => authority.observe(o),
    rejectedNow: () => authority.rejectedNow(),
    dropSecret: () => {
      authority.dropSecret();
    },
    holdsSecret: () => authority.holdsSecret(),
    getCookieHeaderForProbe: async (): Promise<CookieHeaderResult> => {
      try {
        const stored = await store.read();
        if (stored === null) return { ok: false, reason: "not_configured" };
        registerCredentialRedaction(registrar, stored.cookies);
        return { ok: true, header: buildCookieHeader(stored.cookies) };
      } catch (e) {
        return { ok: false, reason: cookieUnavailableFor(e) };
      }
    },
  };
}
