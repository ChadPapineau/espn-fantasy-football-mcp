// credential.ts — `credential_state`, the credential's state and observations, never the secret
// (plan 02 §2.1 "recorded by whichever process makes the observation"; changelog V5; C1-8). One row
// (single-league posture). `transition` is a read-modify-write under ONE BEGIN IMMEDIATE, so a
// concurrent `validated` from the daily job and a `rejected` from the server serialise instead of
// overwriting each other (M2). Required writes.
import {
  CREDENTIAL_STATES,
  CREDENTIAL_STORE_KINDS,
  ESPN_LEAGUE_ID_RE,
} from "../../config/schema.js";
import type {
  CredentialObserver,
  CredentialStateRepository,
  CredentialStateRow,
} from "../types.js";
import {
  boolOrNull,
  bitOrNull,
  isoMs,
  isoMsOrNull,
  matching,
  oneOf,
  type RepoDeps,
} from "./common.js";

/** Who may record an observation. */
export const CREDENTIAL_OBSERVERS: readonly CredentialObserver[] = Object.freeze([
  "setup",
  "server",
  "doctor",
  "check_auth",
  "daily_job",
]);
/** An ESPN view name as `rejected_view` holds it (a fixed vocabulary — never upstream text). */
export const REJECTED_VIEW_RE = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;

interface Row {
  league_id: string;
  state: string;
  store: string;
  stored_at: string | null;
  last_accepted_at: string | null;
  last_rejected_at: string | null;
  rejected_since: string | null;
  next_probe_at: string | null;
  rejected_view: string | null;
  board_probe_discriminates: number | null;
  updated_at: string;
  updated_by: string;
}

/** Validates a row before it is written (RangeError on anything malformed). */
export function checkCredentialRow(row: CredentialStateRow): void {
  const u: unknown = row;
  if (typeof u !== "object" || u === null) throw new RangeError("store: credential row required");
  matching(row.league_id, ESPN_LEAGUE_ID_RE, "league_id");
  oneOf(row.state, CREDENTIAL_STATES, "credential state");
  oneOf(row.store, CREDENTIAL_STORE_KINDS, "credential store");
  isoMsOrNull(row.stored_at, "stored_at");
  isoMsOrNull(row.last_accepted_at, "last_accepted_at");
  isoMsOrNull(row.last_rejected_at, "last_rejected_at");
  isoMsOrNull(row.rejected_since, "rejected_since");
  isoMsOrNull(row.next_probe_at, "next_probe_at");
  if (row.rejected_view !== null) matching(row.rejected_view, REJECTED_VIEW_RE, "rejected_view");
  if (row.board_probe_discriminates !== null && typeof row.board_probe_discriminates !== "boolean")
    throw new RangeError("store: board_probe_discriminates must be a boolean or null");
  isoMs(row.updated_at, "updated_at");
  oneOf(row.updated_by, CREDENTIAL_OBSERVERS, "credential observer");
}

const toRow = (r: Row): CredentialStateRow => ({
  league_id: r.league_id,
  state: r.state as CredentialStateRow["state"],
  store: r.store as CredentialStateRow["store"],
  stored_at: r.stored_at,
  last_accepted_at: r.last_accepted_at,
  last_rejected_at: r.last_rejected_at,
  rejected_since: r.rejected_since,
  next_probe_at: r.next_probe_at,
  rejected_view: r.rejected_view,
  board_probe_discriminates: boolOrNull(r.board_probe_discriminates),
  updated_at: r.updated_at,
  updated_by: r.updated_by as CredentialObserver,
});

export function credentialStateRepository({ db, writes }: RepoDeps): CredentialStateRepository {
  const read = (): CredentialStateRow | null => {
    const r = db.prepare("SELECT * FROM credential_state WHERE id = 1").get() as Row | undefined;
    return r === undefined ? null : toRow(r);
  };
  const write = (row: CredentialStateRow): void => {
    db.prepare(
      `INSERT OR REPLACE INTO credential_state (id, league_id, state, store, stored_at, last_accepted_at,
         last_rejected_at, rejected_since, next_probe_at, rejected_view, board_probe_discriminates,
         updated_at, updated_by)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.league_id,
      row.state,
      row.store,
      row.stored_at,
      row.last_accepted_at,
      row.last_rejected_at,
      row.rejected_since,
      row.next_probe_at,
      row.rejected_view,
      bitOrNull(row.board_probe_discriminates),
      row.updated_at,
      row.updated_by,
    );
  };
  return {
    get: read,
    put(row) {
      checkCredentialRow(row);
      writes.required("credential_state", () => {
        write(row);
      });
    },
    transition(fn) {
      return writes.requiredTx("credential_state", () => {
        const next = fn(read());
        if (next === null) {
          db.prepare("DELETE FROM credential_state WHERE id = 1").run();
          return null;
        }
        checkCredentialRow(next); // a malformed row rolls the whole transition back
        write(next);
        return next;
      });
    },
    clear() {
      writes.required("credential_state", () => {
        db.prepare("DELETE FROM credential_state WHERE id = 1").run();
      });
    },
  };
}
