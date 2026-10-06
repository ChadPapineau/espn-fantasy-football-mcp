// types.ts — PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; owner decision D11).
// The confirmation gate's types and markers only (plan 02 §3.2 the four registration gates, §4.1
// prepare → human channel → commit, §4.2 the three channels incl. the keyed one-time code (V1),
// §4.3 HMAC ticket + precondition hash incl. the current scoring period, §4.4 journal states incl.
// `voided_code` and `voided_cancelled`; plan 07 §3.F the seven F-tools' inputs/outputs). Nothing
// here runs: no function evaluates a gate, mints a ticket or writes a journal row. See README.md.
import type { CredentialState } from "../../config/schema.js";
import type { BareText, IsoInstant, SlotId, TeamRef } from "../league/types.js";

/** The marker every Phase W seam carries (a test greps for it). */
export const PHASE_W_SEAM = "PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; owner decision D11)";

/** The write families: one prepare/commit pair each (plan 07 §3.F; research 03 §E.2). */
export const WRITE_KINDS = ["lineup", "transaction", "trade"] as const;
export type WriteKind = (typeof WRITE_KINDS)[number];

/** The seven conditional tool names (plan 07 §3.F) — registered by nothing in this build. */
export const WRITE_TOOL_NAMES = [
  "espn_prepare_lineup",
  "espn_commit_lineup",
  "espn_prepare_transaction",
  "espn_commit_transaction",
  "espn_prepare_trade",
  "espn_commit_trade",
  "espn_cancel_prepared",
] as const;
export type WriteToolName = (typeof WRITE_TOOL_NAMES)[number];

/** The four registration gates, evaluated at process start from persisted evidence (plan 02 §3.2). */
export const WRITE_REGISTRATION_GATES = [
  "env",
  "acknowledgement",
  "own_team",
  "credential",
] as const;
export type WriteRegistrationGate = (typeof WRITE_REGISTRATION_GATES)[number];
/** The per-write limits enforced by the registry and by `prepare_*` (not registration gates). */
export const WRITE_LIMITS = ["scope", "cap"] as const;
export type WriteLimit = (typeof WRITE_LIMITS)[number];

/** The persisted evidence the registration gates would read (plan 02 S4, §3.2; changelog V4). */
export interface WriteRegistrationEvidence {
  /** Env: `EFF_ENABLE_WRITES` is exactly "true". */
  readonly env_enable_writes: boolean;
  /** Acknowledgement: the typed acknowledgement recorded in config.json. */
  readonly acknowledgement: { readonly at: IsoInstant; readonly text_sha256: string } | null;
  /** The sha256 of the current acknowledgement sentence (a new sentence voids old ones). */
  readonly current_acknowledgement_sha256: string;
  /** Credential: the store.sqlite `credential_state` row. */
  readonly credential_state: CredentialState;
  /** Own team: `ESPN_TEAM_ID` recorded in config.json by `eff setup`. */
  readonly own_team_id: number | null;
}

/** The three human confirmation channels, in priority order (plan 02 §4.2). */
export const CONFIRMATION_CHANNELS = ["elicitation", "code", "cli"] as const;
export type ConfirmationChannel = (typeof CONFIRMATION_CHANNELS)[number];

/** Gate constants (plan 02 §3.2 Cap, §4.1–§4.3; plan 10 §3.W prerequisite (d)). */
export const GATE_CONSTANTS = Object.freeze({
  /** A prepared write expires 10 minutes after `prepare` (plan 02 S7; A-5). */
  preparedTtlMs: 10 * 60 * 1000,
  /** Three wrong one-time codes void the prepared write (`voided_code`). */
  maxWrongCodes: 3,
  /** At most 5 writes per day. */
  dailyWriteCap: 5,
  /** No write within 15 minutes before any kickoff of a player in the diff. */
  kickoffFreezeMs: 15 * 60 * 1000,
  /** The one-time code is 6 digits, kept only as HMAC-SHA256(gate_key, code) (changelog V1). */
  codeDigits: 6,
  /** `gate_key`: 32 random bytes in a 0600 file. */
  gateKeyBytes: 32,
  /** Elicitation decline/cancel within ~2 s falls back to the one-time code. */
  elicitationFallbackMs: 2000,
  /** F1 `moves[1..20]`; F5 `give`/`get` `[1..6]` (plan 07 §3.F). */
  maxLineupMoves: 20,
  maxTradeSide: 6,
});

/** The HMAC input order of the commit ticket (plan 02 §4.3, S7; changelog C2-15 adds `period`). */
export const TICKET_HMAC_FIELDS = [
  "prepared_id",
  "kind",
  "diff_hash",
  "precondition_hash",
  "period",
  "expires_at",
  "nonce",
] as const;

/** `prepared_id` grammar: `pw-` + a 26-char Crockford-base32 ULID. */
export const PREPARED_ID_RE = /^pw-[0-9A-HJKMNP-TV-Z]{26}$/;

/** Journal states (plan 02 §4.4; changelog G9 `voided_code`, L7 `voided_cancelled`). */
export const JOURNAL_STATES = [
  "prepared",
  "denied",
  "expired",
  "voided_precondition",
  "voided_code",
  "voided_cancelled",
  "sent",
  "applied",
  "applied_mismatch",
  "rejected_transaction",
  "rejected_auth",
  "sent_unknown",
  "confirmed_applied",
  "confirmed_not_applied",
] as const;
export type JournalState = (typeof JOURNAL_STATES)[number];

/**
 * The allowed transitions (plan 02 §4.4): `prepared → (denied | expired | voided_precondition |
 * voided_code | voided_cancelled | sent)`; `sent → (applied | applied_mismatch |
 * rejected_transaction | rejected_auth | sent_unknown)`; `sent_unknown → (confirmed_applied |
 * confirmed_not_applied)` by the reconciliation job. Writes are never automatically retried.
 */
export const JOURNAL_TRANSITIONS: Readonly<Record<JournalState, readonly JournalState[]>> =
  Object.freeze({
    prepared: [
      "denied",
      "expired",
      "voided_precondition",
      "voided_code",
      "voided_cancelled",
      "sent",
    ],
    denied: [],
    expired: [],
    voided_precondition: [],
    voided_code: [],
    voided_cancelled: [],
    sent: ["applied", "applied_mismatch", "rejected_transaction", "rejected_auth", "sent_unknown"],
    applied: [],
    applied_mismatch: [],
    rejected_transaction: [],
    rejected_auth: [],
    sent_unknown: ["confirmed_applied", "confirmed_not_applied"],
    confirmed_applied: [],
    confirmed_not_applied: [],
  });

/** One lineup move (plan 07 F1 `moves[]`): the week is always the current period, never an argument. */
export interface LineupMove {
  readonly player_id: number;
  readonly to_slot_id: SlotId;
}

/** F3 `espn_prepare_transaction` input (no `claim_edit`: ESPN has CANCEL only). */
export interface TransactionRequest {
  readonly kind: "add" | "drop" | "add_drop" | "claim" | "claim_cancel";
  readonly add_player_id?: number;
  readonly drop_player_id?: number;
  /** FAAB leagues only. */
  readonly bid?: number;
  readonly pending_transaction_id?: string;
}

/** F5 `espn_prepare_trade` input (no free-text note field). */
export interface TradeRequest {
  readonly kind: "propose" | "accept" | "decline" | "cancel";
  readonly partner_team_id?: number;
  readonly give?: readonly number[];
  readonly get?: readonly number[];
  readonly pending_transaction_id?: string;
}

/** One structured diff item (plan 07 §3.F `diff.structured[]`). */
export type StructuredDiffItem =
  | {
      readonly player_id: number;
      readonly name: BareText;
      readonly from_slot: string;
      readonly to_slot: string;
    }
  | { readonly action: string; readonly player_id: number; readonly bid: number | null };

/** One roster entry of the lineup precondition (plan 02 §4.3) — field names as hashed. */
export interface LineupPreconditionEntry {
  readonly playerId: number;
  readonly lineupSlotId: number;
  readonly lineupLocked: boolean;
}

/** The lineup precondition: canonical JSON of this, sha256 → `precondition_hash` (plan 02 §4.3). */
export interface LineupPreconditionInput {
  readonly entries: readonly LineupPreconditionEntry[];
  readonly current_scoring_period: number;
  readonly is_transaction_locked: boolean;
}

/** A journal row for one prepared write (plan 02 §4.1–§4.4). The code itself is never stored. */
export interface PreparedWrite {
  readonly prepared_id: string;
  readonly kind: WriteKind;
  /** The SWID-resolved own team (plan 02 S5) — never an argument. */
  readonly team: TeamRef;
  readonly scoring_period: number;
  readonly diff_human: string;
  readonly diff: readonly StructuredDiffItem[];
  readonly diff_hash: string;
  readonly precondition_hash: string;
  /** HMAC-SHA256(gate_key, code) hex — never an unkeyed hash (changelog V1); null until channel 2. */
  readonly code_hmac: string | null;
  readonly wrong_code_attempts: number;
  readonly nonce: string;
  readonly created_at: IsoInstant;
  readonly expires_at: IsoInstant;
  readonly status: JournalState;
}

/** The commit ticket (plan 02 §4.3); it never authorises a write by itself — evidence does. */
export interface CommitTicket {
  readonly prepared_id: string;
  readonly kind: WriteKind;
  readonly diff_hash: string;
  readonly precondition_hash: string;
  readonly period: number;
  readonly expires_at: IsoInstant;
  readonly nonce: string;
  /** base64url(HMAC-SHA256(gate_key, TICKET_HMAC_FIELDS joined)). */
  readonly ticket: string;
}

/** Evidence of a human confirmation (plan 02 §4.2); only channel 2 arrives as a tool argument. */
export type ConfirmationEvidence =
  | { readonly kind: "elicitation"; readonly action: "accept" | "decline" | "cancel" }
  | { readonly kind: "code"; readonly code: string }
  | { readonly kind: "cli" };

/** `espn_prepare_*` output (plan 07 §3.F). */
export interface PrepareResult {
  readonly prepared_id: string;
  readonly kind: WriteKind;
  readonly diff: { readonly human: string; readonly structured: readonly StructuredDiffItem[] };
  readonly precondition: {
    readonly hash: string;
    readonly observed_at: IsoInstant;
    readonly scoring_period: number;
  };
  readonly expires_at: IsoInstant;
  readonly ticket: string;
  readonly how_to_confirm: {
    readonly channels: readonly ConfirmationChannel[];
    readonly cli: string;
  };
  readonly consequences: {
    readonly ir: string | null;
    readonly slot_counts: string | null;
    readonly acquisitions_after: number | null;
    readonly lock_warnings: readonly string[];
    readonly kickoff_freeze: IsoInstant | null;
  };
  readonly latest_execution_time: IsoInstant | null;
}

/** What a write did (plan 02 §4.1 receipt; plan 07 §3.F `receipt`). */
export interface WriteReceipt {
  readonly prepared_id: string;
  readonly applied: boolean | "unknown";
  readonly espn_status: "EXECUTED" | "PENDING" | null;
  readonly journal_id: string;
  readonly applied_at: IsoInstant | null;
  readonly transaction_id: string | null;
  readonly upstream_status: number | null;
}

/** `espn_commit_*` output (plan 07 §3.F); idempotent on `prepared_id`. */
export interface CommitResult {
  readonly applied: boolean | "unknown";
  readonly receipt: WriteReceipt;
  readonly diff: { readonly human: string; readonly structured: readonly StructuredDiffItem[] };
  /** The read-back is the outcome — `EXECUTED` alone is not (plan 02 §4.1). */
  readonly readback: { readonly matches: boolean; readonly actual_slots: readonly string[] } | null;
  readonly reconcile: "pending" | "confirmed";
}

/** The error codes only the gate produces (plan 01 §4.3). */
export const GATE_ERROR_CODES = [
  "WRITES_DISABLED",
  "CONFIRMATION_REQUIRED",
  "CONFIRMATION_EXPIRED",
  "PRECONDITION_CHANGED",
  "CONFIRMATION_DENIED",
  "ESPN_TRANSACTION_REJECTED",
] as const;
export type GateErrorCode = (typeof GATE_ERROR_CODES)[number];

/**
 * PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; owner decision D11).
 * The gate service a write module would provide (`src/domain/gate/service.ts`, not built). Its
 * signatures are fixed here so the seam is honest; no implementation exists and nothing calls it.
 */
export interface GateService {
  prepareLineup(team: TeamRef, moves: readonly LineupMove[]): Promise<PrepareResult>;
  prepareTransaction(team: TeamRef, request: TransactionRequest): Promise<PrepareResult>;
  prepareTrade(team: TeamRef, request: TradeRequest): Promise<PrepareResult>;
  commit(preparedId: string, evidence: ConfirmationEvidence | null): Promise<CommitResult>;
  cancel(preparedId: string): Promise<{ readonly voided: boolean }>;
}

/** write_journal reads for `espn_get_status.journal` (null in this build — no module). */
export interface WriteJournalRepository {
  countByStatus(): Readonly<Partial<Record<JournalState, number>>>;
  oldestPendingAgeSeconds(nowIso: IsoInstant): number | null;
}
