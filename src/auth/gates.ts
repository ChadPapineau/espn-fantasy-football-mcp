// gates.ts — the four registration gates (plan 02 S4, §3.2; plan 03 §1.1 step 6, §5 #13;
// changelog V4; plan 10 W2): Env, Acknowledgement, Own team and Credential, evaluated at process
// start from persisted evidence only — the environment, config.json and the store.sqlite
// `credential_state` row; no network, no keychain read. Computed and reported (`eff doctor` #13,
// `espn_get_status.capabilities.write_gate_failing`); nothing registers a write tool.
//
// PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; owner decision D11). This is where the registry
// would learn whether the write module may be registered. In this build no write tool exists, the
// acknowledgement sentence does not exist (so the Acknowledgement gate can never hold), and
// `writeToolsRegistered` is the literal `false` whatever the gates say.
import type { ValueOrigin, WritesAcknowledgement } from "../config/schema.js";
import type { CredentialStateRow } from "./types.js";

/** The gates in plan 02 §3.2's order — `firstFailing` names the first false one. */
export const REGISTRATION_GATES = ["env", "acknowledgement", "own_team", "credential"] as const;
export type RegistrationGate = (typeof REGISTRATION_GATES)[number];

/** The persisted evidence (read at process start; nothing here is fetched). */
export interface RegistrationGateInput {
  /** `EFF_ENABLE_WRITES` is exactly "true" (`Config.writesRequested`). */
  readonly writesRequested: boolean;
  /** The acknowledgement `eff setup --enable-writes` recorded in config.json, if any. */
  readonly acknowledgement: WritesAcknowledgement | null;
  /**
   * sha256 of the CURRENT acknowledgement sentence. PHASE W SEAM — NOT IMPLEMENTED: there is no
   * sentence in this build, so callers pass null and the gate is false.
   */
  readonly currentAcknowledgementSha256: string | null;
  /** `ESPN_TEAM_ID` and where it came from — only a value `eff setup` recorded in config.json counts. */
  readonly teamId: number | null;
  readonly teamIdOrigin: ValueOrigin;
  /** The store.sqlite `credential_state` row (null = none). */
  readonly credentialRow: CredentialStateRow | null;
  /** The configured league: a row for another league is not this league's evidence. */
  readonly leagueId: string;
}

/** The gates' values and the registration decision. */
export interface RegistrationGateReport {
  readonly gates: Readonly<Record<RegistrationGate, boolean>>;
  readonly allHold: boolean;
  readonly firstFailing: RegistrationGate | null;
  /** PHASE W SEAM — NOT IMPLEMENTED: always false; the write module is not built (D11). */
  readonly writeToolsRegistered: false;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** Evaluates the four gates from persisted evidence (pure). */
export function evaluateRegistrationGates(input: RegistrationGateInput): RegistrationGateReport {
  const ack = input.acknowledgement;
  const current = input.currentAcknowledgementSha256;
  const row = input.credentialRow;
  const gates: Record<RegistrationGate, boolean> = {
    env: input.writesRequested,
    acknowledgement:
      ack !== null && current !== null && SHA256_HEX_RE.test(current) && ack.textSha256 === current,
    own_team:
      input.teamId !== null &&
      Number.isSafeInteger(input.teamId) &&
      input.teamId > 0 &&
      input.teamIdOrigin === "file",
    credential: row !== null && row.league_id === input.leagueId && row.state === "validated",
  };
  const firstFailing = REGISTRATION_GATES.find((g) => !gates[g]) ?? null;
  return {
    gates: Object.freeze(gates),
    allHold: firstFailing === null,
    firstFailing,
    writeToolsRegistered: false,
  };
}
