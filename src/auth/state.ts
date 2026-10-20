// state.ts — the CredentialAuthority the ESPN provider's transport holds (plan 01 §10; plan 02
// §2.1 state machine, "Short-circuit" row; plan 02 §2.2 "One store per install", "Multiple
// processes"; plan 03 §1.1 step 4, §6, L6; changelog V5, C1-7). The label comes from the
// store.sqlite `credential_state` row at construction — never a credential-store read — and, while
// `not_configured`, from a row another process writes later; the secret is read lazily on the first
// cookie-bearing call, registered with the redactor, and held only here; every call compares the
// stored `storedAt` field and reloads after a new `eff setup`; an install store follows the backend
// the row records (`eff setup --storage …`) and, for the file store, the session.json path
// config.json records (plan 03 §3; src/auth/stores.ts); `rejected` short-circuits with no request
// until setup stores a new value or another process records an acceptance later than this
// process's rejection (no restart in any of these). The row is shared with setup, status and the
// daily job: this process recreates it only for the value it read, and clears it only when its
// read proves the value the row describes gone — the row in effect when the read started, naming
// the backend read, where that value lives: the keychain, the file at the path config.json records
// (an install store opened with `configDir`), or the file this process read that very value from
// (Stage C findings auth-store-switch-deletes-credential-row, auth-file-path-switch-deletes-row).
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
  type FollowingCredentialStoreReader,
  type SecretRegistrar,
  type StoredCredential,
  type StoredSecretMeta,
} from "./types.js";

/** Fixed warning codes (the authority never logs; the caller decides). */
export type AuthWarningCode = "credential_state_read_failed" | "credential_state_write_failed";

/** What the authority is built from (all injected; nothing ambient). */
export interface CredentialAuthorityOptions {
  /**
   * The one store recorded for this install (constructing it must not touch the keychain). An
   * install store (src/auth/stores.ts `openCredentialStore`) is bound to the row's `store`, so it
   * follows a later `eff setup --storage …`; a fixed backend stays where it is.
   */
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

/** Whether `store` follows a bound record (an install store — src/auth/stores.ts). */
function followsRecord(store: CredentialStoreReader): store is FollowingCredentialStoreReader {
  return typeof (store as Partial<FollowingCredentialStoreReader>).followRecord === "function";
}

/** The stored value a row describes: the backend it names and the `storedAt` it copies. */
function valueKey(row: CredentialStateRow): string {
  return `${row.store}\u0000${row.stored_at ?? ""}`;
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
  /** The row without a warning (the label and the store's record read it on every use). */
  const quietRow = (): CredentialStateRow | null => {
    try {
      return opts.repo.get();
    } catch {
      return null;
    }
  };
  const ownRow = (row: CredentialStateRow | null): CredentialStateRow | null =>
    row !== null && row.league_id === leagueId ? row : null;
  const forValue = (row: CredentialStateRow | null, storedAt: string): row is CredentialStateRow =>
    row !== null && row.league_id === leagueId && row.stored_at === storedAt;

  // the install's store follows the backend the row records: `eff setup --storage …` writes the row
  // naming the store it moved to, so this process — and the probe read through the same store —
  // reads where setup wrote, no restart (plan 02 §2.2; plan 03 L6). Binding reads nothing.
  if (followsRecord(opts.store)) opts.store.followRecord(() => ownRow(quietRow())?.store ?? null);

  let state: CredentialState = "not_configured";
  let loaded: StoredCredential | null = null;
  /** The backend `loaded` was read from. */
  let loadedKind: CredentialStoreKind | null = null;
  let header: CookieHeader | null = null;
  /** The `storedAt` of the value this process saw rejected, and when. */
  let rejectedStoredAt: string | null = null;
  let rejectedAtMs: number | null = null;
  /** The value of the row this process last found describing nothing its store held. */
  let vanished: string | null = null;

  /** Takes a row's label (at startup, and a row another process writes while not_configured). */
  const adopt = (row: CredentialStateRow | null, label: CredentialState): void => {
    state = label;
    rejectedStoredAt = null;
    rejectedAtMs = null;
    if (label === "rejected" && row !== null) {
      rejectedStoredAt = row.stored_at;
      rejectedAtMs = msOf(row.last_rejected_at ?? row.rejected_since ?? row.updated_at);
    }
  };

  const startRow = readRow();
  adopt(
    startRow,
    deriveStartupState({
      row: startRow,
      leagueId,
      storeKind: opts.store.kind,
      fileStoreExists: opts.fileStoreExists ?? false,
    }),
  );

  const drop = (): void => {
    loaded = null;
    loadedKind = null;
    header = null;
  };

  /**
   * One store operation, the backend that served it (an install store picks it at the call) and
   * the value this league's row described when it started (`valueKey`; null: none, or unreadable).
   */
  const served = async <T>(
    op: () => Promise<T>,
  ): Promise<{
    readonly value: T;
    readonly kind: CredentialStoreKind;
    readonly before: string | null;
  }> => {
    const startRow = ownRow(quietRow());
    const before = startRow === null ? null : valueKey(startRow);
    const pending = op();
    const kind = opts.store.kind;
    return { value: await pending, kind, before };
  };

  const markRejected = (storedAt: string | null, atMs: number | null): void => {
    state = "rejected";
    rejectedStoredAt = storedAt;
    rejectedAtMs = atMs ?? msOf(now());
    drop();
  };

  const freshRow = (storedAt: string, from: CredentialStoreKind): CredentialStateRow => {
    const at = now();
    return {
      league_id: leagueId,
      state: "stored",
      store: from,
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

  /**
   * Whether `kind`'s backend is where a row naming it keeps the value: the keychain (the install's
   * one service), or the file an install store reads at the path config.json records. Any other
   * file — the start path of an install store opened without `configDir`, a fixed backend — may
   * not be the one `eff setup` wrote (plan 03 §3: setup records the path it used, and a shell's
   * EFF_CREDENTIAL_FILE need not be this process's).
   */
  const placesValue = (kind: CredentialStoreKind): boolean => {
    if (kind === "keychain") return true;
    try {
      return followsRecord(opts.store) && opts.store.followsRecordedPath;
    } catch {
      return false; // a store that cannot say proves nothing
    }
  };

  /**
   * `kind`'s backend holds nothing: drop the value, and clear the row only when this read proves
   * the value it describes gone (plan 03 §1.1 step 4: a row without items → not_configured): the
   * row names `kind` — a row naming the other backend describes the value `eff setup --storage …`
   * moved there; it is the row in effect when the read started (`before`) — a row written during
   * the read (setup records config.json, writes the value, then the row) describes a value the read
   * may have missed; and the read looked where that value lives (`placesValue`), or the value is
   * the one this process read from this very backend. Any other row stays: clearing it would blank
   * `eff status`, stop the daily credential check (plan 06 §1.4) and undo the setup that wrote it.
   * The label is `not_configured` either way; a row written during the read can still re-arm it.
   */
  const nothingStored = (kind: CredentialStoreKind, before: string | null): CookieHeaderResult => {
    const held = loadedKind === kind ? (loaded?.meta.storedAt ?? null) : null;
    drop();
    const row = ownRow(readRow());
    if (
      row !== null &&
      row.state !== "not_configured" &&
      row.store === kind &&
      valueKey(row) === before &&
      (placesValue(kind) || (held !== null && row.stored_at === held))
    ) {
      const seen = valueKey(row);
      persist((cur) =>
        cur !== null && cur.league_id === leagueId && valueKey(cur) === seen ? null : cur,
      );
    }
    vanished = before;
    adopt(null, "not_configured");
    return { ok: false, reason: "not_configured" };
  };

  /** Another process's record a value read from `from` must not replace. */
  const recordsAnother = (
    cur: CredentialStateRow | null,
    storedAt: string,
    from: CredentialStoreKind,
  ): boolean => {
    if (cur?.league_id !== leagueId) return false;
    // the row names the other backend (the store moved), or a value stored after this one
    if (cur.store !== from) return true;
    const curMs = msOf(cur.stored_at);
    const ms = msOf(storedAt);
    return curMs !== null && ms !== null && curMs > ms;
  };

  /**
   * The row that describes `storedAt` (recreated as `stored` when none does — a wiped cache — but
   * never over a row naming the other backend or a later value).
   */
  const settle = (storedAt: string, from: CredentialStoreKind): CredentialStateRow | null => {
    const row = readRow();
    if (forValue(row, storedAt)) return row;
    const r = persist((cur) =>
      forValue(cur, storedAt) || recordsAnother(cur, storedAt, from)
        ? cur
        : freshRow(storedAt, from),
    );
    return r.ok && forValue(r.row, storedAt) ? r.row : null;
  };

  const resolve = async (): Promise<CookieHeaderResult> => {
    let meta: StoredSecretMeta | null;
    let fresh: StoredCredential | null = null;
    let kind: CredentialStoreKind;
    /** The row's value when the last store operation started. */
    let before: string | null;
    try {
      if (loaded === null && state !== "rejected") {
        const r = await served(() => opts.store.read());
        fresh = r.value;
        kind = r.kind;
        before = r.before;
        meta = fresh?.meta ?? null;
      } else {
        const r = await served(() => opts.store.readMeta());
        meta = r.value;
        kind = r.kind;
        before = r.before;
      }
    } catch (e) {
      return { ok: false, reason: cookieUnavailableFor(e) };
    }
    // the install moved to the other backend: the value held came from the one setup emptied
    if (loadedKind !== null && loadedKind !== kind) drop();
    if (meta === null) return nothingStored(kind, before);

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
        const r = await served(() => opts.store.read());
        fresh = r.value;
        kind = r.kind;
        before = r.before;
      } catch (e) {
        return { ok: false, reason: cookieUnavailableFor(e) };
      }
      if (fresh === null) return nothingStored(kind, before);
    }
    if (fresh !== null) {
      registerCredentialRedaction(opts.registrar, fresh.cookies);
      loaded = fresh;
      loadedKind = kind;
      header = buildCookieHeader(fresh.cookies);
    }
    const value = loaded;
    const from = loadedKind;
    if (value === null || header === null || from === null) return nothingStored(kind, before);

    const row = settle(value.meta.storedAt, from);
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
    state: () => {
      // a value `eff setup` stored since (another terminal) — the provider gates on this label, so
      // without this a server that had nothing would answer ESPN_REQUIRES_COOKIES until restarted
      if (state === "not_configured") {
        const row = ownRow(quietRow());
        if (row !== null && row.state !== "not_configured" && valueKey(row) !== vanished)
          adopt(row, row.state);
      }
      return state;
    },
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
