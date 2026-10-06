// state.ts — the CredentialAuthority the ESPN provider's transport holds (plan 01 §10; plan 02
// §2.1 state machine, "Short-circuit" row; plan 03 §1.1 step 4, §6; changelog V5, C1-7). The label
// comes from the store.sqlite `credential_state` row at construction — never a credential-store
// read; the secret is read lazily on the first cookie-bearing call, registered with the redactor,
// and held only here; every call compares the stored `storedAt` field and reloads after a new
// `eff setup`; `rejected` short-circuits with no request until setup stores a new value or another
// process records an acceptance later than this process's rejection (no restart either way).
import type { CredentialStoreKind } from "../config/schema.js";
import { cookieUnavailableFor } from "./errors.js";
import { buildCookieHeader } from "./format.js";
import { registerCredentialRedaction } from "./redact.js";
import {
  applyObservation,
  nextCredentialState,
  observationEvent,
  type CookieHeader,
  type CookieHeaderResult,
  type CredentialAuthority,
  type CredentialObserver,
  type CredentialState,
  type CredentialStateRepository,
  type CredentialStateRow,
  type CredentialStoreReader,
  type SecretRegistrar,
  type StoredCredential,
  type StoredSecretMeta,
} from "./types.js";

/** Fixed warning codes (the authority never logs; the caller decides). */
export type AuthWarningCode = "credential_state_read_failed" | "credential_state_write_failed";

/** What the authority is built from (all injected; nothing ambient). */
export interface CredentialAuthorityOptions {
  /** The one store recorded for this install (constructing it must not touch the keychain). */
  readonly store: CredentialStoreReader;
  /** store.sqlite's `credential_state` repository. */
  readonly repo: CredentialStateRepository;
  /** The configured league (observations for another league read as `stored`). */
  readonly leagueId: string;
  /** The logger (structurally): the secret is registered on every load. */
  readonly registrar: SecretRegistrar;
  /** Who this process records as (default `server`). */
  readonly observer?: CredentialObserver;
  /** ISO-8601 now (default: the wall clock). */
  readonly now?: () => string;
  /** File store only: whether a stat found session.json at startup (plan 03 §1.1 step 4). */
  readonly fileStoreExists?: boolean;
  /** The next daily credential-check run after a rejection at `at` (plan 06 §1.4), or null. */
  readonly nextProbeAt?: (at: string) => string | null;
  readonly onWarning?: (code: AuthWarningCode) => void;
}

/** The authority plus the shutdown and introspection hooks the CLI needs. */
export interface CredentialAuthorityHandle extends CredentialAuthority {
  /** Shutdown: drop the in-memory value (a JavaScript string cannot be zeroed — plan 03 §1.3). */
  dropSecret(): void;
  /** Whether a value is held in memory right now (never the value). */
  holdsSecret(): boolean;
}

/**
 * The startup label (plan 03 §1.1 step 4): the row's state; a row for another league reads as
 * `stored`; no row → `not_configured`, except the file store, where a stat that finds session.json
 * gives `stored`. Never reads the credential store.
 */
export function deriveStartupState(input: {
  readonly row: CredentialStateRow | null;
  readonly leagueId: string;
  readonly storeKind: CredentialStoreKind;
  readonly fileStoreExists: boolean;
}): CredentialState {
  const row = input.row;
  if (row !== null) {
    if (row.league_id === input.leagueId) return row.state;
    return row.state === "not_configured" ? "not_configured" : "stored";
  }
  return input.storeKind === "file" && input.fileStoreExists ? "stored" : "not_configured";
}

function msOf(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Creates the authority. Construction reads the store.sqlite row only. */
export function createCredentialAuthority(
  opts: CredentialAuthorityOptions,
): CredentialAuthorityHandle {
  const leagueId = opts.leagueId;
  const observer = opts.observer ?? "server";
  const now = opts.now ?? (() => new Date().toISOString());
  const warn = (code: AuthWarningCode): void => {
    try {
      opts.onWarning?.(code);
    } catch {
      // a throwing warning sink must not break a tool call
    }
  };
  const readRow = (): CredentialStateRow | null => {
    try {
      return opts.repo.get();
    } catch {
      warn("credential_state_read_failed");
      return null;
    }
  };
  const persist = (
    fn: (row: CredentialStateRow | null) => CredentialStateRow | null,
  ): { readonly ok: true; readonly row: CredentialStateRow | null } | { readonly ok: false } => {
    try {
      return { ok: true, row: opts.repo.transition(fn) };
    } catch {
      warn("credential_state_write_failed");
      return { ok: false };
    }
  };
  const forValue = (row: CredentialStateRow | null, storedAt: string): row is CredentialStateRow =>
    row !== null && row.league_id === leagueId && row.stored_at === storedAt;

  const startRow = readRow();
  let state: CredentialState = deriveStartupState({
    row: startRow,
    leagueId,
    storeKind: opts.store.kind,
    fileStoreExists: opts.fileStoreExists ?? false,
  });
  let loaded: StoredCredential | null = null;
  let header: CookieHeader | null = null;
  /** The `storedAt` of the value this process saw rejected, and when. */
  let rejectedStoredAt: string | null = null;
  let rejectedAtMs: number | null = null;
  if (state === "rejected" && startRow !== null) {
    rejectedStoredAt = startRow.stored_at;
    rejectedAtMs = msOf(
      startRow.last_rejected_at ?? startRow.rejected_since ?? startRow.updated_at,
    );
  }

  const drop = (): void => {
    loaded = null;
    header = null;
  };

  const markRejected = (storedAt: string | null, atMs: number | null): void => {
    state = "rejected";
    rejectedStoredAt = storedAt;
    rejectedAtMs = atMs ?? msOf(now());
    drop();
  };

  const freshRow = (storedAt: string): CredentialStateRow => {
    const at = now();
    return {
      league_id: leagueId,
      state: "stored",
      store: opts.store.kind,
      stored_at: storedAt,
      last_accepted_at: null,
      last_rejected_at: null,
      rejected_since: null,
      next_probe_at: null,
      rejected_view: null,
      board_probe_discriminates: null,
      updated_at: at,
      updated_by: observer,
    };
  };

  /** Nothing is stored: drop the value, clear a row that still describes the vanished one. */
  const nothingStored = (): CookieHeaderResult => {
    drop();
    const row = readRow();
    if (row !== null && row.league_id === leagueId && row.state !== "not_configured") {
      const seen = row.stored_at;
      persist((cur) =>
        cur !== null && cur.league_id === leagueId && cur.stored_at === seen ? null : cur,
      );
    }
    state = "not_configured";
    rejectedStoredAt = null;
    rejectedAtMs = null;
    return { ok: false, reason: "not_configured" };
  };

  /** The row that describes `storedAt` (recreated as `stored` when none does — a wiped cache). */
  const settle = (storedAt: string): CredentialStateRow | null => {
    const row = readRow();
    if (forValue(row, storedAt)) return row;
    const r = persist((cur) => (forValue(cur, storedAt) ? cur : freshRow(storedAt)));
    return r.ok && forValue(r.row, storedAt) ? r.row : null;
  };

  const resolve = async (): Promise<CookieHeaderResult> => {
    let meta: StoredSecretMeta | null;
    let fresh: StoredCredential | null = null;
    try {
      if (loaded === null && state !== "rejected") {
        fresh = await opts.store.read();
        meta = fresh?.meta ?? null;
      } else {
        meta = await opts.store.readMeta();
      }
    } catch (e) {
      return { ok: false, reason: cookieUnavailableFor(e) };
    }
    if (meta === null) return nothingStored();

    // a rejection whose value is unknown (a row without stored_at) is taken to be the stored one:
    // never send a cookie that may be the rejected one; a later `eff setup` still lifts it
    if (state === "rejected") rejectedStoredAt ??= meta.storedAt;
    if (state === "rejected" && meta.storedAt === rejectedStoredAt) {
      // the short-circuit: zero requests unless another process accepted this value since
      const row = readRow();
      const acceptedMs =
        forValue(row, meta.storedAt) && row.state === "validated"
          ? msOf(row.last_accepted_at)
          : null;
      if (acceptedMs === null || (rejectedAtMs !== null && acceptedMs <= rejectedAtMs))
        return { ok: false, reason: "rejected" };
    }

    if (fresh === null && loaded?.meta.storedAt !== meta.storedAt) {
      try {
        fresh = await opts.store.read();
      } catch (e) {
        return { ok: false, reason: cookieUnavailableFor(e) };
      }
      if (fresh === null) return nothingStored();
    }
    if (fresh !== null) {
      registerCredentialRedaction(opts.registrar, fresh.cookies);
      loaded = fresh;
      header = buildCookieHeader(fresh.cookies);
    }
    const value = loaded;
    if (value === null || header === null) return nothingStored();

    const row = settle(value.meta.storedAt);
    const next: CredentialState =
      row === null || row.state === "not_configured" ? "stored" : row.state;
    if (next === "rejected") {
      // another process already saw this very value rejected: adopt it, send nothing
      markRejected(value.meta.storedAt, msOf(row?.last_rejected_at ?? null));
      return { ok: false, reason: "rejected" };
    }
    state = next;
    return { ok: true, header };
  };

  let inflight: Promise<CookieHeaderResult> | null = null;

  return {
    state: () => state,
    getCookieHeader: () => {
      inflight ??= resolve().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    observe: (o) => {
      const event = observationEvent(o);
      // not a credential event (a 404 seen outside setup — plan 07 G2): nothing is recorded
      if (event === null) return Promise.resolve(state);
      let next: CredentialState = nextCredentialState(state, event) ?? state;
      const r = persist((cur) => {
        if (cur?.league_id !== leagueId) return cur;
        const applied = applyObservation(cur, o);
        if (applied === cur || applied.state !== "rejected" || opts.nextProbeAt === undefined)
          return applied;
        return { ...applied, next_probe_at: opts.nextProbeAt(o.at) };
      });
      if (r.ok && r.row !== null && r.row.league_id === leagueId) next = r.row.state;
      if (next === "rejected") {
        const rowStoredAt = r.ok ? (r.row?.stored_at ?? null) : null;
        markRejected(loaded?.meta.storedAt ?? rowStoredAt ?? rejectedStoredAt, msOf(o.at));
      } else {
        if (next === "not_configured") drop();
        state = next;
      }
      return Promise.resolve(state);
    },
    dropSecret: drop,
    holdsSecret: () => loaded !== null,
  };
}
