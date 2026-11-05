// fixture-credential.ts — fixture mode's credential-state test seam (changelog §R9, ruling R9-3;
// plan 09 §5.2's variants auth-rejected and public-league; plan 05 §3.1 step 5, §4.4).
// A derived fx-10h variant names the server state fixture mode cannot hold in its manifest's
// `harness` block (scripts/fx10h/variants.ts, written by scripts/gen-fixtures.ts): the
// `credential_state` the case stands for and, for espn_check_auth, the scripted `probe` result.
// Fixture mode — and only fixture mode: the composition root reads this in its fixture branch, and
// `readScriptedCredential(null)` is null — reports that state through espn_get_status and answers
// the one probe with the scripted result. Both are a label and a fixed, value-free result: nothing
// here holds, builds or logs a cookie or a Cookie header, and no request is made (the provider is
// still built with no credential authority, so every `auto` and feed read stays keyless and is
// served, as in fixture mode before). The one exception is the user's own pending claims, which are
// never read keyless (changelog §R10, R10-10): for them alone the cookie gate gets this label
// (changelog §R10, R10-21, amending R9-3; auth-gate.ts fixtureOwnLabel) — `rejected` answers
// ESPN_AUTH_REJECTED and `stored`/`validated` serve the variant's recorded mPendingTransactions, as
// a session read would, with zero network either way and still no Cookie header; the label moves
// with espn_check_auth's verdict. On the one variant whose recorded league is private
// (`private-league`, changelog §R10, R10-27) the label governs every `auto` and feed read too
// (auth-gate.ts fixturePrivateLeague, set by createEspnProvider from the recorded settings): a
// variant scripting nothing reads as `not_configured` there. Fixture mode's guard runs first and is unchanged: with a real
// credential stored, fixture mode does not start at all (src/services/index.ts fixtureModeIssues).
// A variant that scripts nothing (or `not_configured`) keeps the old path exactly. One more scripted
// state (changelog §R10, R10-28) is a session ESPN rejects mid-procedure — `credential_state:
// "stored"` with `rejects: "first_uncached_read"`, so the label it scripts is the one espn_get_status
// reports at Step 0 (`stored`, the eval harness's own state list unchanged): the first read on that
// server the cache does not serve (a fresh entry is
// served first, as the real pipeline serves it; a read is the one about to go out, its budget paid —
// never a cache-only check, and never espn_check_auth's probe, which answers the scripted result as
// on every variant) is answered as ESPN's 401 to a cookie-bearing read is: the label moves to
// `rejected`, recorded as the real pipeline records a 401 (`last_rejected_at` and `rejected_since` at
// that instant, in memory only — never the store's credential row, which the fixture guard reads),
// so espn_get_status and espn_check_auth say `rejected` from then on, and every later read follows
// the rejected label (R10-27). Still a label: no value, no Cookie header, nothing sent. New here.
import path from "node:path";
import { readSecureFile } from "../config/paths.js";
import { ConfigError, type CredentialState } from "../config/schema.js";
import type { Clock } from "../domain/clock.js";
import type { CredentialView } from "../mcp/services.js";
import type { CredentialProbeResult } from "../providers/platform.js";

/** The `credential_state` values a variant may script (the plan's auth-rejected and public-league). */
export const SCRIPTED_CREDENTIAL_STATES = Object.freeze(["stored", "rejected"] as const);
export type ScriptedCredentialState = (typeof SCRIPTED_CREDENTIAL_STATES)[number];

/**
 * What a `stored` session's `harness.rejects` may script (changelog §R10, R10-28): ESPN rejects it at
 * the first read on the server that the cache does not serve.
 */
export const SCRIPTED_REJECTIONS = Object.freeze(["first_uncached_read"] as const);
export type ScriptedRejection = (typeof SCRIPTED_REJECTIONS)[number];

/** The manifest `kind` of a derived fixture league (scripts/fx10h/generate.ts). */
const DERIVED_KIND = "derived_league";
/** A derived manifest is a few KB; anything this large is not one. */
const MANIFEST_MAX_BYTES = 1024 * 1024;

/** The scripted probe of a variant's `harness.probe` (CredentialProbeResult's own vocabulary). */
export interface ScriptedProbe {
  readonly accepted: boolean | null;
  readonly reason: CredentialProbeResult["reason"];
  readonly probe: CredentialProbeResult["probe"];
}

/** What a variant scripts: the state espn_get_status reports and the one probe's answer. */
export interface ScriptedCredential {
  readonly state: ScriptedCredentialState;
  readonly probe: ScriptedProbe;
  /** A `stored` session ESPN rejects mid-procedure (R10-28); absent: never. */
  readonly rejects?: ScriptedRejection;
}

/** Why a variant's harness block is refused (fixed, value-free texts). */
export const SCRIPTED_CREDENTIAL_REFUSALS = Object.freeze({
  manifest: "the fixture directory's manifest.json could not be read as a derived fixture league",
  state: `harness.credential_state must be "not_configured" or one of ${SCRIPTED_CREDENTIAL_STATES.join(", ")}`,
  probe:
    'a scripted credential state needs harness.probe { accepted: true | false | null, reason: null | "not_configured" | "board_not_discriminating" (null exactly when accepted is not), probe: "settings" | "board" }',
  rejects: `harness.rejects must be ${SCRIPTED_REJECTIONS.join(", ")}, beside credential_state "stored" only`,
} as const);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const refuse = (reason: string): never => {
  throw new ConfigError([{ key: "EFF_FIXTURE_DIR", reason }]);
};

/** The probe of a `harness.probe` block, or null when it is not one. */
function probeOf(raw: unknown): ScriptedProbe | null {
  if (!isRecord(raw)) return null;
  const keys = Object.keys(raw).sort().join(",");
  if (keys !== "accepted,probe,reason") return null;
  const { accepted, reason, probe } = raw;
  if (accepted !== null && typeof accepted !== "boolean") return null;
  if (reason !== null && reason !== "not_configured" && reason !== "board_not_discriminating")
    return null;
  if (probe !== "settings" && probe !== "board") return null;
  // the provider's own rule: a reason exactly when nothing was decided (platform.ts)
  if ((accepted === null) !== (reason !== null)) return null;
  return { accepted, reason, probe };
}

/**
 * The credential state a fixture variant scripts, or null — fixture mode off (`fixtureDir` null),
 * a fixture directory that is not a derived league (the recorded fixtures), or a variant scripting
 * nothing or `not_configured` (the default path). A derived manifest whose harness block is not
 * understood throws a ConfigError (fail loud: a case must never run against a state it did not
 * ask for).
 */
export function readScriptedCredential(fixtureDir: string | null): ScriptedCredential | null {
  if (fixtureDir === null) return null;
  let text: string | null;
  try {
    text = readSecureFile(path.join(fixtureDir, "manifest.json"), {
      requirePrivate: false,
      maxBytes: MANIFEST_MAX_BYTES,
      what: "fixture manifest",
    });
  } catch {
    // a manifest that cannot be read safely (a symlink, oversized) scripts nothing: the default path
    text = null;
  }
  // no manifest: a recorded fixture directory, which scripts nothing
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return refuse(SCRIPTED_CREDENTIAL_REFUSALS.manifest);
  }
  if (!isRecord(raw) || raw.kind !== DERIVED_KIND) return null;
  const harness = raw.harness;
  if (harness === undefined) return null;
  if (!isRecord(harness)) return refuse(SCRIPTED_CREDENTIAL_REFUSALS.state);
  const state = harness.credential_state;
  if (state === undefined || state === "not_configured") {
    if (harness.rejects !== undefined) return refuse(SCRIPTED_CREDENTIAL_REFUSALS.rejects);
    return null;
  }
  if (state !== "stored" && state !== "rejected") return refuse(SCRIPTED_CREDENTIAL_REFUSALS.state);
  const probe = probeOf(harness.probe);
  if (probe === null) return refuse(SCRIPTED_CREDENTIAL_REFUSALS.probe);
  const rejects = harness.rejects;
  if (rejects === undefined) return { state, probe };
  if (state !== "stored" || rejects !== "first_uncached_read")
    return refuse(SCRIPTED_CREDENTIAL_REFUSALS.rejects);
  return { state, probe, rejects };
}

/** The status view and the auth port over a scripted credential (one per server process). */
export interface ScriptedAuth {
  /** The state label espn_get_status and espn_check_auth report. */
  state(): CredentialState;
  /**
   * espn_get_status's credential block: a label only (no store; time stamps only for the 401 a
   * session scripted `rejects: "first_uncached_read"` met — R10-28).
   */
  view(): CredentialView;
  /**
   * The one probe: the scripted result; no request (`upstream_status` null), no value. It is the
   * explicit credential check, not a data read, so a scripted rejection's 401 is never its
   * answer (R10-28): an accepting probe moves the label to `validated` — the user re-ran setup —
   * and a validated session is never rejected after it (how a seed fills the cache).
   */
  probe(): Promise<CredentialProbeResult>;
  /**
   * Asked by the cookie gate when the label would serve a read about to go out (a read the cache
   * did not serve — R10-28): true exactly once for a session scripted `rejects:
   * "first_uncached_read"` while it is still `stored`, which
   * is then rejected as a 401 records it (the label `rejected`, `last_rejected_at` and
   * `rejected_since` now). False for every other state and every later read.
   */
  rejectsRead(): boolean;
}

/**
 * The scripted authority. The probe's verdict moves the label as a real probe would (plan 02 §2.1:
 * accepted → `validated`, rejected → `rejected`; an undecided probe leaves it), in memory only.
 */
export function scriptedAuth(scripted: ScriptedCredential, clock: Clock): ScriptedAuth {
  let state: CredentialState = scripted.state;
  // the session ESPN rejects at its first uncached read (changelog §R10, R10-28): `stored` until then
  let expiring = scripted.rejects === "first_uncached_read";
  let rejectedAt: string | null = null;
  /** The scripted 401: the label moves to `rejected`, recorded as the pipeline records a 401. */
  const expire = (): boolean => {
    if (!expiring || state !== "stored") return false;
    expiring = false;
    state = "rejected";
    rejectedAt = clock.nowIso();
    return true;
  };
  return {
    state: () => state,
    view: () => ({
      state,
      // no backend holds a value in fixture mode, so none is named (as the default path)
      store: null,
      present: true,
      stored_at: null,
      last_accepted_at: null,
      last_rejected_at: rejectedAt,
      rejected_since: state === "rejected" ? rejectedAt : null,
      next_probe_at: null,
    }),
    probe: () => {
      const p = scripted.probe;
      if (p.accepted === true) state = "validated";
      else if (p.accepted === false) state = "rejected";
      return Promise.resolve({
        accepted: p.accepted,
        probe: p.probe,
        upstream_status: null,
        reason: p.reason,
        checked_at: clock.nowIso(),
      });
    },
    rejectsRead: expire,
  };
}
