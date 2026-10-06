// helpers.ts — fakes for the auth tests: an in-memory keyring (with failure injection and a call
// log that records service/account only, never values), an in-memory credential_state repository
// with the real read-modify-write contract, an in-memory CredentialStore, a recording redactor and
// fake cookies derived at run time (scripts/ci/secret-fixtures.mjs — no flaggable literal).
import { fakeEspnS2, fakeGuid } from "../../scripts/ci/secret-fixtures.mjs";
import type { KeyringPort } from "../../src/auth/keychain.js";
import type {
  CredentialStateRepository,
  CredentialStateRow,
  CredentialStore,
  EspnCookies,
  SecretRegistrar,
  StoredCredential,
  StoredSecretMeta,
} from "../../src/auth/types.js";
import { metaFor } from "../../src/auth/upgrade.js";

/** Fake cookies for `label` (a 220-char URL-encoded espn_s2 and a braced fake GUID). */
export function fakeCookies(label: string, s2Length = 220): EspnCookies {
  return { espn_s2: fakeEspnS2(`auth-${label}`, s2Length), swid: `{${fakeGuid(`auth-${label}`)}}` };
}

/** One logged keyring call (never the value). */
export interface KeyringCall {
  readonly op: "get" | "set" | "delete";
  readonly service: string;
  readonly account: string;
}

/** An in-memory keyring with failure injection. */
export class FakeKeyring implements KeyringPort {
  readonly items = new Map<string, string>();
  readonly calls: KeyringCall[] = [];
  /** Throw (with the given message) on the next matching op. */
  failOn: { op: KeyringCall["op"]; account?: string; message?: string; times?: number } | null =
    null;
  /** Never settle the next matching op until aborted. */
  hangOn: { op: KeyringCall["op"]; account?: string } | null = null;

  private key(s: string, a: string): string {
    return `${s}\u0000${a}`;
  }

  private gate(
    op: KeyringCall["op"],
    service: string,
    account: string,
    signal: AbortSignal,
  ): Promise<void> {
    this.calls.push({ op, service, account });
    const f = this.failOn;
    if (f !== null && f.op === op && (f.account === undefined || f.account === account)) {
      const left = (f.times ?? 1) - 1;
      this.failOn = left > 0 ? { ...f, times: left } : null;
      return Promise.reject(new Error(f.message ?? "native keyring failure"));
    }
    const h = this.hangOn;
    if (h !== null && h.op === op && (h.account === undefined || h.account === account)) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    }
    return Promise.resolve();
  }

  async getPassword(service: string, account: string, signal: AbortSignal): Promise<string | null> {
    await this.gate("get", service, account, signal);
    return this.items.get(this.key(service, account)) ?? null;
  }
  async setPassword(
    service: string,
    account: string,
    value: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.gate("set", service, account, signal);
    this.items.set(this.key(service, account), value);
  }
  async deletePassword(service: string, account: string, signal: AbortSignal): Promise<boolean> {
    await this.gate("delete", service, account, signal);
    return this.items.delete(this.key(service, account));
  }
  /** Direct read for assertions. */
  peek(service: string, account: string): string | undefined {
    return this.items.get(this.key(service, account));
  }
  /** Direct write for planting states. */
  plant(service: string, account: string, value: string): void {
    this.items.set(this.key(service, account), value);
  }
}

/** An in-memory credential_state repository honouring the transition contract. */
export class MemoryStateRepo implements CredentialStateRepository {
  row: CredentialStateRow | null = null;
  writes = 0;
  failGet = false;
  failWrite = false;
  /** Run before each transition's fn sees the row (simulates another process writing first). */
  beforeTransition: (() => void) | null = null;

  get(): CredentialStateRow | null {
    if (this.failGet) throw new Error("SQLITE_BUSY");
    return this.row;
  }
  put(row: CredentialStateRow): void {
    if (this.failWrite) throw new Error("SQLITE_BUSY");
    this.writes++;
    this.row = row;
  }
  transition(
    fn: (row: CredentialStateRow | null) => CredentialStateRow | null,
  ): CredentialStateRow | null {
    if (this.failWrite) throw new Error("SQLITE_BUSY");
    this.beforeTransition?.();
    const next = fn(this.row);
    this.writes++;
    this.row = next;
    return next;
  }
  clear(): void {
    if (this.failWrite) throw new Error("SQLITE_BUSY");
    this.writes++;
    this.row = null;
  }
}

/** An in-memory CredentialStore with read counters (to prove laziness and the short-circuit). */
export class MemoryStore implements CredentialStore {
  readonly kind: "keychain" | "file";
  readonly service: string;
  stored: StoredCredential | null = null;
  reads = 0;
  metaReads = 0;
  existsCalls = 0;
  writes = 0;
  deletes = 0;
  failRead: Error | null = null;
  failWrite: Error | null = null;
  failDelete: Error | null = null;

  constructor(kind: "keychain" | "file" = "keychain", service = "espn-fantasy-football-mcp") {
    this.kind = kind;
    this.service = service;
  }
  /** Stores a value as `eff setup` would (another process, for the authority tests). */
  set(cookies: EspnCookies, storedAt: string): StoredSecretMeta {
    const meta = metaFor(cookies, storedAt);
    this.stored = { cookies, meta };
    return meta;
  }
  read(): Promise<StoredCredential | null> {
    this.reads++;
    return this.failRead ? Promise.reject(this.failRead) : Promise.resolve(this.stored);
  }
  readMeta(): Promise<StoredSecretMeta | null> {
    this.metaReads++;
    return this.failRead
      ? Promise.reject(this.failRead)
      : Promise.resolve(this.stored?.meta ?? null);
  }
  exists(): Promise<boolean> {
    this.existsCalls++;
    return this.failRead ? Promise.reject(this.failRead) : Promise.resolve(this.stored !== null);
  }
  write(cookies: EspnCookies, meta: StoredSecretMeta): Promise<void> {
    this.writes++;
    if (this.failWrite) return Promise.reject(this.failWrite);
    this.stored = { cookies, meta };
    return Promise.resolve();
  }
  delete(): Promise<void> {
    this.deletes++;
    if (this.failDelete) return Promise.reject(this.failDelete);
    this.stored = null;
    return Promise.resolve();
  }
}

/** A redactor that records what was registered (kinds and values, for assertions only). */
export class RecordingRegistrar implements SecretRegistrar {
  readonly registered: { kind: string; value: string }[] = [];
  registerSecret(kind: string, value: string): void {
    this.registered.push({ kind, value });
  }
}

/** A `credential_state` row for league "0" (the fixture league) with overrides. */
export function stateRow(over: Partial<CredentialStateRow> = {}): CredentialStateRow {
  return {
    league_id: "0",
    state: "stored",
    store: "keychain",
    stored_at: "2026-10-01T00:00:00.000Z",
    last_accepted_at: null,
    last_rejected_at: null,
    rejected_since: null,
    next_probe_at: null,
    rejected_view: null,
    board_probe_discriminates: null,
    updated_at: "2026-10-01T00:00:00.000Z",
    updated_by: "setup",
    ...over,
  };
}

/** Every substring of `secret` of `len` chars appears nowhere in `text`. */
export function containsFragment(text: string, secret: string, len = 16): boolean {
  for (let i = 0; i + len <= secret.length; i += 4)
    if (text.includes(secret.slice(i, i + len))) return true;
  return false;
}
