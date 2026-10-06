// state.test.ts — src/auth/state.ts, the CredentialAuthority (plan 05 §2 `auth/state`; plan 02
// §2.1 state machine and "Short-circuit" row; plan 03 §1.1 step 4, §6; plan 10 A2b): lazy (nothing
// read at construction), the plan 02 §2.1 transitions recorded through the repository, `rejected`
// short-circuits without reading the secret, a new `storedAt` reloads without a restart, another
// process's later acceptance reloads to `validated`, an earlier one does not; the daily probe edge;
// the value is registered with the redactor on load and dropped on rejection.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CredentialStoreError } from "../../src/auth/errors.js";
import { buildCookieHeader } from "../../src/auth/format.js";
import { createCredentialAuthority, deriveStartupState } from "../../src/auth/state.js";
import type { CredentialObservation, CredentialState } from "../../src/auth/types.js";
import {
  MemoryStateRepo,
  MemoryStore,
  RecordingRegistrar,
  fakeCookies,
  stateRow,
} from "./helpers.js";

const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-02T00:00:00.000Z";
const T2 = "2026-10-03T00:00:00.000Z";
const T3 = "2026-10-04T00:00:00.000Z";

function world(
  opts: {
    row?: ReturnType<typeof stateRow> | null;
    stored?: boolean;
    kind?: "keychain" | "file";
  } = {},
) {
  const store = new MemoryStore(opts.kind ?? "keychain");
  const repo = new MemoryStateRepo();
  const reg = new RecordingRegistrar();
  const c = fakeCookies("state");
  if (opts.stored !== false) store.set(c, T0);
  repo.row = opts.row === undefined ? stateRow({ stored_at: T0 }) : opts.row;
  let clock = T1;
  const warnings: string[] = [];
  const make = (over: Partial<Parameters<typeof createCredentialAuthority>[0]> = {}) =>
    createCredentialAuthority({
      store,
      repo,
      leagueId: "0",
      registrar: reg,
      now: () => clock,
      onWarning: (w) => warnings.push(w),
      ...over,
    });
  return {
    store,
    repo,
    reg,
    c,
    warnings,
    make,
    setNow: (t: string) => {
      clock = t;
    },
  };
}

const obs = (over: Partial<CredentialObservation> = {}): CredentialObservation => ({
  kind: "accepted",
  at: T2,
  by: "server",
  upstream_status: 200,
  view: "mRoster",
  ...over,
});

describe("laziness (plan 01 §2; plan 05 §2: the store is not touched at construction)", () => {
  it("construction reads only the store.sqlite row — never the credential store", () => {
    const w = world();
    const auth = w.make();
    expect(w.store.reads + w.store.metaReads + w.store.existsCalls).toBe(0);
    expect(auth.state()).toBe("stored");
    expect(auth.holdsSecret()).toBe(false);
    expect(w.reg.registered).toEqual([]);
  });
  it("the first cookie-bearing call loads the secret once and registers it with the redactor", async () => {
    const w = world();
    const auth = w.make();
    const r = await auth.getCookieHeader();
    expect(r).toEqual({ ok: true, header: buildCookieHeader(w.c) });
    expect(w.store.reads).toBe(1);
    expect(w.reg.registered.some((x) => x.kind === "espn_s2" && x.value === w.c.espn_s2)).toBe(
      true,
    );
    expect(w.reg.registered.some((x) => x.value === decodeURIComponent(w.c.espn_s2))).toBe(true);
    expect(auth.holdsSecret()).toBe(true);
    // later calls compare storedAt only (meta), no second secret read
    await auth.getCookieHeader();
    expect(w.store.reads).toBe(1);
    expect(w.store.metaReads).toBe(1);
  });
  it("concurrent first calls share one load", async () => {
    const w = world();
    const auth = w.make();
    const rs = await Promise.all([
      auth.getCookieHeader(),
      auth.getCookieHeader(),
      auth.getCookieHeader(),
    ]);
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(w.store.reads).toBe(1);
  });
});

describe("deriveStartupState (plan 03 §1.1 step 4)", () => {
  it.each([
    [
      { row: stateRow({ state: "validated" }), storeKind: "keychain", fileStoreExists: false },
      "validated",
    ],
    [
      { row: stateRow({ state: "rejected" }), storeKind: "keychain", fileStoreExists: false },
      "rejected",
    ],
    [
      {
        row: stateRow({ state: "validated", league_id: "1" }),
        storeKind: "keychain",
        fileStoreExists: false,
      },
      "stored",
    ],
    [
      {
        row: stateRow({ state: "not_configured", league_id: "1" }),
        storeKind: "keychain",
        fileStoreExists: false,
      },
      "not_configured",
    ],
    [{ row: null, storeKind: "keychain", fileStoreExists: true }, "not_configured"],
    [{ row: null, storeKind: "file", fileStoreExists: true }, "stored"],
    [{ row: null, storeKind: "file", fileStoreExists: false }, "not_configured"],
  ] as const)("%j → %s", (input, want) => {
    expect(deriveStartupState({ ...input, leagueId: "0" })).toBe(want);
  });
  it("the file-store stat is honoured by the authority's startup label", () => {
    const w = world({ row: null, kind: "file" });
    expect(w.make({ fileStoreExists: true }).state()).toBe("stored");
    expect(w.make().state()).toBe("not_configured");
  });
});

describe("typed failures (plan 01 §10 CookieUnavailable)", () => {
  it("nothing stored → not_configured, and a stale row describing the vanished value is cleared", async () => {
    const w = world({ stored: false, row: stateRow({ state: "validated", stored_at: T0 }) });
    const auth = w.make();
    expect(await auth.getCookieHeader()).toEqual({ ok: false, reason: "not_configured" });
    expect(auth.state()).toBe("not_configured");
    expect(w.repo.row).toBeNull();
  });
  it("nothing stored and no row → not_configured without a write", async () => {
    const w = world({ stored: false, row: null });
    expect(await w.make().getCookieHeader()).toEqual({ ok: false, reason: "not_configured" });
    expect(w.repo.writes).toBe(0);
  });
  it("a row for another league is left alone when nothing is stored", async () => {
    const other = stateRow({ league_id: "7", state: "validated" });
    const w = world({ stored: false, row: other });
    await w.make().getCookieHeader();
    expect(w.repo.row).toBe(other);
  });
  it("an unreadable store → unreadable; an invalid stored value → invalid_format", async () => {
    const w = world();
    w.store.failRead = new CredentialStoreError("keychain", "timeout");
    expect(await w.make().getCookieHeader()).toEqual({ ok: false, reason: "unreadable" });
    w.store.failRead = new CredentialStoreError("keychain", "invalid_format");
    expect(await w.make().getCookieHeader()).toEqual({ ok: false, reason: "invalid_format" });
    w.store.failRead = new Error("anything else");
    expect(await w.make().getCookieHeader()).toEqual({ ok: false, reason: "unreadable" });
  });
  it("the value vanishing between the meta check and the reload → not_configured", async () => {
    const w = world();
    const auth = w.make();
    await auth.getCookieHeader();
    w.store.set(fakeCookies("next"), T3);
    const realRead = w.store.read.bind(w.store);
    w.store.read = () => {
      w.store.stored = null;
      return realRead();
    };
    expect(await auth.getCookieHeader()).toEqual({ ok: false, reason: "not_configured" });
    expect(auth.holdsSecret()).toBe(false);
  });
});

describe("the row: items without a row are recreated as stored; a row without items is cleared", () => {
  it("a wiped cache (no row) → stored, and the row is recreated with the storedAt just read", async () => {
    const w = world({ row: null });
    const auth = w.make({ observer: "doctor" });
    expect(auth.state()).toBe("not_configured");
    expect((await auth.getCookieHeader()).ok).toBe(true);
    expect(auth.state()).toBe("stored");
    expect(w.repo.row).toMatchObject({
      league_id: "0",
      state: "stored",
      stored_at: T0,
      updated_by: "doctor",
      updated_at: T1,
    });
  });
  it("a row for another league reads as stored and is replaced for this league", async () => {
    const w = world({ row: stateRow({ league_id: "9", state: "validated", stored_at: T0 }) });
    const auth = w.make();
    expect(auth.state()).toBe("stored");
    await auth.getCookieHeader();
    expect(w.repo.row).toMatchObject({ league_id: "0", state: "stored" });
  });
  it("a validated row for this value keeps the label validated", async () => {
    const w = world({ row: stateRow({ state: "validated", stored_at: T0, last_accepted_at: T0 }) });
    const auth = w.make();
    await auth.getCookieHeader();
    expect(auth.state()).toBe("validated");
  });
  it("a store.sqlite failure degrades to the in-memory label with a warning (never a crash)", async () => {
    const w = world({ row: null });
    w.repo.failGet = true;
    w.repo.failWrite = true;
    const auth = w.make();
    expect((await auth.getCookieHeader()).ok).toBe(true);
    expect(auth.state()).toBe("stored");
    expect(w.warnings).toContain("credential_state_read_failed");
    expect(w.warnings).toContain("credential_state_write_failed");
  });
  it("a throwing warning sink is contained", async () => {
    const w = world({ row: null });
    w.repo.failGet = true;
    const auth = w.make({
      onWarning: () => {
        throw new Error("sink down");
      },
    });
    expect((await auth.getCookieHeader()).ok).toBe(true);
  });
});

describe("observations → transitions (plan 02 §2.1), persisted through transition()", () => {
  it("stored + cookie-bearing 200 → validated (lastAcceptedAt recorded)", async () => {
    const w = world();
    const auth = w.make();
    await auth.getCookieHeader();
    expect(await auth.observe(obs())).toBe("validated");
    expect(w.repo.row).toMatchObject({
      state: "validated",
      last_accepted_at: T2,
      updated_by: "server",
    });
  });
  it("any cookie-bearing 401 → rejected; the value is dropped; no retry possible", async () => {
    const w = world({ row: stateRow({ state: "validated", stored_at: T0 }) });
    const auth = w.make({ nextProbeAt: () => T3 });
    await auth.getCookieHeader();
    expect(await auth.observe(obs({ kind: "rejected", upstream_status: 401, view: "mTeam" }))).toBe(
      "rejected",
    );
    expect(auth.holdsSecret()).toBe(false);
    expect(w.repo.row).toMatchObject({
      state: "rejected",
      last_rejected_at: T2,
      rejected_since: T2,
      rejected_view: "mTeam",
      next_probe_at: T3,
    });
  });
  it("a repeated rejection keeps rejected_since and refreshes next_probe_at", async () => {
    const w = world({ row: stateRow({ state: "validated", stored_at: T0 }) });
    let next = T3;
    const auth = w.make({ nextProbeAt: () => next });
    await auth.observe(obs({ kind: "rejected", at: T1 }));
    next = "2026-10-05T09:00:00.000Z";
    await auth.observe(obs({ kind: "rejected", at: T2, by: "daily_job" }));
    expect(w.repo.row).toMatchObject({
      rejected_since: T1,
      last_rejected_at: T2,
      next_probe_at: next,
    });
  });
  it("no nextProbeAt hook → next_probe_at is left as the row had it", async () => {
    const w = world({ row: stateRow({ state: "validated", stored_at: T0, next_probe_at: null }) });
    await w.make().observe(obs({ kind: "rejected" }));
    expect(w.repo.row?.next_probe_at).toBeNull();
  });
  it("a 404 outside setup is not a credential event: nothing recorded (plan 07 G2)", async () => {
    const w = world({ row: stateRow({ state: "validated", stored_at: T0 }) });
    const auth = w.make();
    const writes = w.repo.writes;
    expect(await auth.observe(obs({ kind: "league_not_found", upstream_status: 404 }))).toBe(
      "validated",
    );
    expect(w.repo.writes).toBe(writes);
  });
  it("setup's own rejection (by: setup) lands in not_configured and drops the value", async () => {
    const w = world();
    const auth = w.make({ observer: "setup" });
    await auth.getCookieHeader();
    expect(await auth.observe(obs({ kind: "rejected", by: "setup" }))).toBe("not_configured");
    expect(auth.holdsSecret()).toBe(false);
  });
  it("without a row (persist failed earlier) the in-memory machine still moves", async () => {
    const w = world({ row: null });
    w.repo.failWrite = true;
    const auth = w.make();
    await auth.getCookieHeader();
    expect(await auth.observe(obs({ kind: "rejected" }))).toBe("rejected");
    expect(await auth.getCookieHeader()).toEqual({ ok: false, reason: "rejected" });
  });
  it("an observation while a row for another league exists changes only memory", async () => {
    const w = world({ row: stateRow({ league_id: "5", state: "validated" }) });
    const auth = w.make();
    expect(auth.state()).toBe("stored");
    expect(await auth.observe(obs({ kind: "rejected" }))).toBe("rejected");
    expect(w.repo.row?.league_id).toBe("5");
    expect(w.repo.row?.state).toBe("validated");
  });
});

describe("the short-circuit (plan 02 §2.1; plan 10 A2b: zero requests while rejected)", () => {
  it("rejected → every call returns `rejected` without reading the secret", async () => {
    const w = world({
      row: stateRow({ state: "rejected", stored_at: T0, last_rejected_at: T1, rejected_since: T1 }),
    });
    const auth = w.make();
    for (let i = 0; i < 5; i++)
      expect(await auth.getCookieHeader()).toEqual({ ok: false, reason: "rejected" });
    expect(w.store.reads).toBe(0);
    expect(w.store.metaReads).toBe(5);
    expect(auth.holdsSecret()).toBe(false);
  });
  it("`eff setup` in another terminal (a new storedAt) is picked up: reload, no restart", async () => {
    const w = world({ row: stateRow({ state: "rejected", stored_at: T0, last_rejected_at: T1 }) });
    const auth = w.make();
    expect((await auth.getCookieHeader()).ok).toBe(false);
    // setup stores a new value and writes a fresh `stored` row
    const fresh = fakeCookies("rerun");
    w.store.set(fresh, T3);
    w.repo.row = stateRow({ state: "stored", stored_at: T3 });
    const r = await auth.getCookieHeader();
    expect(r).toEqual({ ok: true, header: buildCookieHeader(fresh) });
    expect(auth.state()).toBe("stored");
    expect(w.reg.registered.some((x) => x.value === fresh.espn_s2)).toBe(true);
  });
  it("a later acceptance recorded by another process (daily job / doctor / check_auth) → validated", async () => {
    const w = world({ row: stateRow({ state: "rejected", stored_at: T0, last_rejected_at: T1 }) });
    const auth = w.make();
    expect((await auth.getCookieHeader()).ok).toBe(false);
    w.repo.row = stateRow({
      state: "validated",
      stored_at: T0,
      last_rejected_at: T1,
      last_accepted_at: T2,
      updated_by: "daily_job",
    });
    expect((await auth.getCookieHeader()).ok).toBe(true);
    expect(auth.state()).toBe("validated");
    expect(w.store.reads).toBe(1);
  });
  it("an acceptance OLDER than this process's rejection does not lift the short-circuit", async () => {
    const w = world({ row: stateRow({ state: "validated", stored_at: T0, last_accepted_at: T1 }) });
    const auth = w.make();
    await auth.getCookieHeader();
    await auth.observe(obs({ kind: "rejected", at: T2 }));
    // a racing writer restores an old validated row (acceptance at T1 < rejection at T2)
    w.repo.row = stateRow({ state: "validated", stored_at: T0, last_accepted_at: T1 });
    expect(await auth.getCookieHeader()).toEqual({ ok: false, reason: "rejected" });
  });
  it("a validated row for a DIFFERENT storedAt does not lift it (meta unchanged)", async () => {
    const w = world({ row: stateRow({ state: "rejected", stored_at: T0, last_rejected_at: T1 }) });
    const auth = w.make();
    w.repo.row = stateRow({
      state: "validated",
      stored_at: "2026-09-01T00:00:00.000Z",
      last_accepted_at: T3,
    });
    expect(await auth.getCookieHeader()).toEqual({ ok: false, reason: "rejected" });
  });
  it("another process's rejection of the same value is adopted: no doomed request", async () => {
    const w = world({ row: stateRow({ state: "stored", stored_at: T0 }) });
    const auth = w.make();
    expect((await auth.getCookieHeader()).ok).toBe(true);
    w.repo.row = stateRow({
      state: "rejected",
      stored_at: T0,
      last_rejected_at: T2,
      rejected_since: T2,
    });
    expect(await auth.getCookieHeader()).toEqual({ ok: false, reason: "rejected" });
    expect(auth.state()).toBe("rejected");
    expect(auth.holdsSecret()).toBe(false);
    // and a later acceptance by the daily job lifts it again
    w.repo.row = stateRow({ state: "validated", stored_at: T0, last_accepted_at: T3 });
    expect((await auth.getCookieHeader()).ok).toBe(true);
  });
  it("startup in rejected with an unparseable rejection time: any validated row lifts it", async () => {
    const w = world({
      row: stateRow({
        state: "rejected",
        stored_at: T0,
        last_rejected_at: null,
        rejected_since: null,
        updated_at: "garbage",
      }),
    });
    const auth = w.make();
    expect((await auth.getCookieHeader()).ok).toBe(false);
    w.repo.row = stateRow({ state: "validated", stored_at: T0, last_accepted_at: T2 });
    expect((await auth.getCookieHeader()).ok).toBe(true);
  });
});

describe("the daily probe edge (plan 06 §1.4; ADV OBJ-04: rejected → validated without a human)", () => {
  it("the daily job's own authority: its probe 200 flips rejected → validated in the row", async () => {
    const w = world({
      row: stateRow({
        state: "rejected",
        stored_at: T0,
        last_rejected_at: T1,
        rejected_view: "mRoster",
        next_probe_at: T2,
      }),
    });
    const job = w.make({ observer: "daily_job" });
    expect(job.state()).toBe("rejected");
    expect(await job.observe(obs({ by: "daily_job", at: T2, view: "mSettings" }))).toBe(
      "validated",
    );
    expect(w.repo.row).toMatchObject({
      state: "validated",
      last_accepted_at: T2,
      rejected_since: null,
      rejected_view: null,
      next_probe_at: null,
      updated_by: "daily_job",
    });
    // …and a running server (rejected since T1) picks it up on its next call
    const server = createCredentialAuthority({
      store: w.store,
      repo: w.repo,
      leagueId: "0",
      registrar: w.reg,
    });
    expect((await server.getCookieHeader()).ok).toBe(true);
    expect(server.state()).toBe("validated");
  });
  it("the daily job's probe 401 keeps rejected (rejected_since unchanged) and the server stays paused", async () => {
    const w = world({
      row: stateRow({ state: "rejected", stored_at: T0, last_rejected_at: T1, rejected_since: T1 }),
    });
    const job = w.make({ observer: "daily_job", nextProbeAt: () => T3 });
    expect(
      await job.observe(obs({ kind: "rejected", by: "daily_job", at: T2, upstream_status: 401 })),
    ).toBe("rejected");
    expect(w.repo.row).toMatchObject({
      rejected_since: T1,
      last_rejected_at: T2,
      next_probe_at: T3,
    });
  });
  it("an ordinary server 200 can never lift rejected (only a probe can)", async () => {
    const w = world({ row: stateRow({ state: "rejected", stored_at: T0, last_rejected_at: T1 }) });
    const server = w.make();
    expect(await server.observe(obs({ by: "server" }))).toBe("rejected");
    expect(w.repo.row?.state).toBe("rejected");
  });
});

describe("dropSecret (shutdown — plan 03 §1.3)", () => {
  it("drops the in-memory value; the next call reloads", async () => {
    const w = world();
    const auth = w.make();
    await auth.getCookieHeader();
    auth.dropSecret();
    expect(auth.holdsSecret()).toBe(false);
    expect((await auth.getCookieHeader()).ok).toBe(true);
    expect(w.store.reads).toBe(2);
  });
});

describe("property: the authority never hands out a header in rejected or not_configured", () => {
  it("random interleavings of calls, observations and other-process writes", async () => {
    const steps = fc.array(
      fc.oneof(
        fc.constant({ t: "call" as const }),
        fc.record({
          t: fc.constant("obs" as const),
          kind: fc.constantFrom<CredentialObservation["kind"]>(
            "accepted",
            "rejected",
            "league_not_found",
          ),
          by: fc.constantFrom<CredentialObservation["by"]>(
            "server",
            "doctor",
            "check_auth",
            "daily_job",
          ),
        }),
        fc.record({
          t: fc.constant("row" as const),
          state: fc.constantFrom<CredentialState>("stored", "validated", "rejected"),
        }),
        fc.constant({ t: "unstore" as const }),
      ),
      { maxLength: 25 },
    );
    await fc.assert(
      fc.asyncProperty(steps, async (ss) => {
        const w = world();
        const auth = w.make();
        let tick = Date.parse(T1);
        for (const s of ss) {
          tick += 60_000;
          const at = new Date(tick).toISOString();
          if (s.t === "call") {
            const before = auth.state();
            const r = await auth.getCookieHeader();
            if (r.ok && (auth.state() === "rejected" || auth.state() === "not_configured"))
              return false;
            if (!r.ok && r.reason === "rejected" && auth.state() !== "rejected") return false;
            if (before === "rejected" && r.ok && w.store.stored?.meta.storedAt === T0) {
              // lifted only by a later validated row for the same value
              const row = w.repo.row;
              if (row?.state !== "validated") return false;
            }
          } else if (s.t === "obs") {
            await auth.observe(obs({ kind: s.kind, by: s.by, at }));
            if (auth.state() === "rejected" && auth.holdsSecret()) return false;
          } else if (s.t === "row") {
            const cur = w.repo.row ?? stateRow({ stored_at: T0 });
            w.repo.row = {
              ...cur,
              state: s.state,
              last_accepted_at: s.state === "validated" ? at : cur.last_accepted_at,
              last_rejected_at: s.state === "rejected" ? at : cur.last_rejected_at,
            };
          } else {
            w.store.stored = null;
          }
        }
        return true;
      }),
      { numRuns: 150 },
    );
  });
});
