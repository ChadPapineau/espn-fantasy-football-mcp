// credential.test.ts — credential_state (plan 02 §2.1; changelog V5; C1-8; M2): the state and its
// observations, never the secret; one row; `transition` is one BEGIN IMMEDIATE read-modify-write, so
// observations from two processes serialise (no lost update); malformed rows are refused and roll a
// transition back; `clear` removes the row (setup --reset, uninstall).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATION_001_SQL } from "../../src/store/migrations/001_initial.js";
import { checkCredentialRow } from "../../src/store/repos/credential.js";
import type { CredentialStateRow, Store } from "../../src/store/types.js";
import { openStore, tempCache, type TempCache } from "./helpers/env.js";
import { run } from "./helpers/spawn.js";

let t: TempCache;
let s: Store;
beforeEach(() => {
  t = tempCache();
  s = openStore(t);
});
afterEach(() => {
  s.close();
  t.cleanup();
});

const base: CredentialStateRow = {
  league_id: "0",
  state: "stored",
  store: "keychain",
  stored_at: "2026-10-05T10:00:00.000Z",
  last_accepted_at: null,
  last_rejected_at: null,
  rejected_since: null,
  next_probe_at: null,
  rejected_view: null,
  board_probe_discriminates: null,
  updated_at: "2026-10-05T10:00:00.000Z",
  updated_by: "setup",
};

describe("credential_state", () => {
  it("starts empty; put/get round-trips; booleans and nulls survive", () => {
    expect(s.repos.credentialState.get()).toBeNull();
    s.repos.credentialState.put(base);
    expect(s.repos.credentialState.get()).toEqual(base);
    const rejected: CredentialStateRow = {
      ...base,
      state: "rejected",
      last_rejected_at: "2026-10-06T09:00:00.000Z",
      rejected_since: "2026-10-06T09:00:00.000Z",
      next_probe_at: "2026-10-07T09:00:00.000Z",
      rejected_view: "mRoster",
      board_probe_discriminates: false,
      updated_at: "2026-10-06T09:00:00.000Z",
      updated_by: "server",
    };
    s.repos.credentialState.put(rejected);
    expect(s.repos.credentialState.get()).toEqual(rejected);
    s.repos.credentialState.put({ ...rejected, board_probe_discriminates: true });
    expect(s.repos.credentialState.get()?.board_probe_discriminates).toBe(true);
  });

  it("no column can hold a secret: the table has no value/cookie/token column", () => {
    const ddl = MIGRATION_001_SQL.find((d) => d.startsWith("CREATE TABLE credential_state")) ?? "";
    expect(ddl).not.toMatch(/espn_s2|swid|cookie|secret|token|value|fingerprint/i);
  });

  it("transition reads the current row and writes the next; null deletes", () => {
    s.repos.credentialState.put(base);
    const next = s.repos.credentialState.transition((row) =>
      row === null
        ? null
        : {
            ...row,
            state: "validated",
            last_accepted_at: "2026-10-06T10:00:00.000Z",
            updated_by: "check_auth",
          },
    );
    expect(next?.state).toBe("validated");
    expect(s.repos.credentialState.get()).toEqual(next);
    expect(s.repos.credentialState.transition(() => null)).toBeNull();
    expect(s.repos.credentialState.get()).toBeNull();
    // a transition on an empty table sees null
    let seen: CredentialStateRow | null | undefined;
    s.repos.credentialState.transition((row) => {
      seen = row;
      return row;
    });
    expect(seen).toBeNull();
  });

  it("a throwing fn or a malformed next row rolls the transition back", () => {
    s.repos.credentialState.put(base);
    expect(() =>
      s.repos.credentialState.transition(() => {
        throw new Error("observer crashed");
      }),
    ).toThrow(/observer crashed/);
    expect(() =>
      s.repos.credentialState.transition((row) => ({ ...row!, state: "haunted" as never })),
    ).toThrow(RangeError);
    expect(s.repos.credentialState.get()).toEqual(base);
  });

  it("clear removes the row", () => {
    s.repos.credentialState.put(base);
    s.repos.credentialState.clear();
    expect(s.repos.credentialState.get()).toBeNull();
    s.repos.credentialState.clear();
  });

  it("refuses malformed rows (identifiers, enums, instants, booleans)", () => {
    const bad: Partial<CredentialStateRow>[] = [
      { league_id: "abc" },
      { league_id: "012" }, // a leading zero
      { league_id: "1".repeat(13) },
      { state: "expired" as never },
      { store: "env" as never },
      { stored_at: "last tuesday" },
      { next_probe_at: "" },
      { rejected_view: "mRoster; DROP" },
      { rejected_view: "x".repeat(49) },
      { board_probe_discriminates: 1 as never },
      { updated_at: null as never },
      { updated_by: "model" as never },
    ];
    for (const b of bad)
      expect(() => {
        s.repos.credentialState.put({ ...base, ...b });
      }).toThrow(RangeError);
    expect(() => {
      checkCredentialRow(null as never);
    }).toThrow(RangeError);
    expect(s.repos.credentialState.get()).toBeNull();
  });
});

describe("two processes observing at once (M2)", () => {
  it("transitions serialise: no lost update across processes", async () => {
    s.repos.credentialState.put({ ...base, next_probe_at: "2026-10-06T00:00:00.000Z" });
    const N = 150;
    const args = [t.storePath, t.datasetDir, t.backupDir, String(N)];
    const a = run("credential-child.mjs", args, { tsx: true });
    const b = run("credential-child.mjs", args, { tsx: true });
    // this process observes too
    for (let i = 0; i < N; i++) {
      s.repos.credentialState.transition((row) => ({
        ...row!,
        next_probe_at: new Date(Date.parse(row!.next_probe_at!) + 1).toISOString(),
        updated_by: "server",
      }));
      if (i % 10 === 0) await new Promise((r) => setTimeout(r, 1));
    }
    await Promise.all([a.waitFor(/^DONE/, 60_000), b.waitFor(/^DONE/, 60_000)]);
    expect(await a.exited()).toBe(0);
    expect(await b.exited()).toBe(0);
    const final = s.repos.credentialState.get();
    expect(Date.parse(final!.next_probe_at!) - Date.parse("2026-10-06T00:00:00.000Z")).toBe(3 * N);
  });
});
