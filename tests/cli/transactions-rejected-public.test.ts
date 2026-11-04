// transactions-rejected-public.test.ts — changelog §R10, R10-10, the launchd half (plan 06 §1.4
// `transactions append`; src/cli/espn-jobs.ts `keylessOnPublicWhenRejected`): ESPN serves a public
// league's transaction feed to anyone, so under a rejected session the transactions job still runs
// on a league the provider's publicity row keeps public — every request keyless, the rejected
// cookie never sent — while on a league not known to be public it exits 0 with no request, as every
// other job does (and every other job still does on a public one). The job's tripwire and the drift
// rules judge a keyless answer exactly as a cookie-bearing one: a period whose previous read listed
// executed moves answering without the list is still drift (ESPN_DRIFT_DETECTED, red). A public
// stand-in of the recorded league-a (league id 0), placeholder cookies in a 0600 file store; no
// request leaves the process.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionFileBody } from "../../src/auth/file.js";
import { metaFor } from "../../src/auth/upgrade.js";
import { readJobState, updateJobState } from "../../src/cli/job-state.js";
import { loadRuntime } from "../../src/cli/runtime.js";
import { snapshotPool, transactionsAppend } from "../../src/cli/snapshot.js";
import { openStore } from "../../src/cli/store-access.js";
import { parseDiffs } from "../../src/drift/index.js";
import { cachedPublicity, publicityKey } from "../../src/providers/espn/cache.js";
import { composeBodies } from "../../src/providers/espn/index.js";
import { HEADER_TRANSACTION_COUNT } from "../../src/providers/espn/types.js";
import { fakeCookies, stateRow } from "../auth/helpers.js";
import {
  ROOT,
  fakeExec,
  fakeFetch,
  fakePackage,
  makeIo,
  movingClock,
  sandbox,
  type Sandbox,
} from "./helpers.js";

let sb: Sandbox;
afterEach(() => {
  sb.cleanup();
});

const REC = path.join(ROOT, "fixtures", "espn", "recorded");
const FX = path.join(ROOT, "fixtures", "espn", "fx-10h");
const rec = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(REC, rel), "utf8")) as Record<string, unknown>;
const jsonRes = (b: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
const COOKIES = fakeCookies("cli-transactions-rejected-public");
const STORED_AT = "2026-10-01T00:00:00.000Z";
const ENV = {
  ESPN_LEAGUE_ID: "0",
  EFF_CREDENTIAL_STORE: "file",
  ESPN_SEASON: "2026",
  ESPN_TEAM_ID: "1",
};

/** The recognised view's bare base (draftDetail etc.), without its list. */
function bareBase(): Record<string, unknown> {
  const b = JSON.parse(
    readFileSync(path.join(FX, "league", "mTransactions2.json"), "utf8"),
  ) as Record<string, unknown>;
  delete b.transactions;
  return b;
}

const txId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function tx(n: number, period: number, at: string) {
  return {
    id: txId(n),
    type: "WAIVER",
    status: "EXECUTED",
    teamId: 1,
    scoringPeriodId: period,
    proposedDate: Date.parse(at) - 60_000,
    processDate: Date.parse(at),
    bidAmount: 0,
    isPending: false,
    items: [
      {
        type: "ADD",
        playerId: 2000 + n,
        fromTeamId: 0,
        toTeamId: 1,
        fromLineupSlotId: -1,
        toLineupSlotId: 20,
        isKeeper: false,
      },
    ],
  };
}

/**
 * The PUBLIC league at scoring period 9, answering keyless requests only (a cookie-bearing one is
 * a test failure: 500, and recorded): each period's mTransactions2 answer scripted.
 */
function publicLeague(txns: (period: number) => Response, current = 9) {
  return fakeFetch((url, init) => {
    if (new Headers(init.headers).has("cookie"))
      return new Response("cookie sent", { status: 500 });
    const u = new URL(url);
    const views = u.searchParams.getAll("view");
    if (views.includes("proTeamSchedules_wl"))
      return jsonRes(rec("season/proTeamSchedules_wl.json"));
    if (!u.pathname.includes("/leagues/0")) return new Response(null, { status: 404 });
    const s = structuredClone(rec("league-a/mSettings.json")) as {
      settings: Record<string, unknown>;
    };
    s.settings.isPublic = true;
    if (views.includes("mTransactions2"))
      return txns(Number(u.searchParams.get("scoringPeriodId") ?? "0"));
    let body: unknown = { ...s, scoringPeriodId: current };
    if (views.includes("mNav")) body = composeBodies(body, rec("league-a/mNav.json"));
    if (views.includes("mTeam")) body = composeBodies(body, rec("league-a/mTeam.json"));
    return jsonRes(body);
  });
}

const oneMove = () =>
  publicLeague((p) =>
    jsonRes(
      { ...bareBase(), transactions: [tx(p, p, "2026-11-02T18:00:00.000Z")] },
      { [HEADER_TRANSACTION_COUNT]: "1" },
    ),
  );

async function runtime(at: string, f: ReturnType<typeof fakeFetch>) {
  const { exec } = fakeExec();
  const io = makeIo(sb, {
    fetch: f.fetch,
    clock: movingClock(at),
    platform: "darwin",
    exec,
    packageRoot: fakePackage(sb),
    env: ENV,
  });
  const { config, log } = await loadRuntime(io);
  return { io, config, log };
}

/**
 * A rejected install: the session file (placeholder cookies) and a row recording that very value
 * rejected; `kept` is the league's publicity another process kept (null: none kept).
 */
async function rejectedInstall(kept: boolean | null): Promise<void> {
  mkdirSync(sb.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(sb.configDir, "session.json"),
    sessionFileBody(COOKIES, metaFor(COOKIES, STORED_AT)),
    { mode: 0o600 },
  );
  const r = await runtime(
    "2026-11-03T12:00:00.000Z",
    publicLeague(() => jsonRes(bareBase())),
  );
  const store = openStore(r.config, r.io.clock, r.log, { migrate: true });
  try {
    store.repos.credentialState.put(
      stateRow({
        store: "file",
        state: "rejected",
        stored_at: STORED_AT,
        last_rejected_at: "2026-11-01T09:00:00.000Z",
        rejected_since: "2026-11-01T09:00:00.000Z",
        rejected_view: "mRoster",
      }),
    );
    if (kept !== null) cachedPublicity(store.repos.espnCache, "0", r.io.clock).save(kept);
  } finally {
    store.close();
  }
}

const cookieSent = (f: ReturnType<typeof fakeFetch>): boolean =>
  f.inits.some((init) => new Headers(init.headers).has("cookie"));

describe("the transactions job under a rejected session (changelog §R10, R10-10)", () => {
  it("a league kept public: the job runs, every request keyless, the moves appended", async () => {
    sb = sandbox();
    await rejectedInstall(true);
    updateJobState(sb.cacheDir, { "transactions.season": 2026, "transactions.period": 8 });
    const f = oneMove();
    const r = await runtime("2026-11-03T12:30:00.000Z", f);
    const code = await transactionsAppend(r.io, r.config, r.log, { notify: true, force: true });
    expect(code, `${r.io.out.text} | ${r.io.err.text}`).toBe(0);
    expect(r.io.out.text).toContain("this league is public, so it is read keyless");
    expect(r.io.out.text).toContain("2 new transaction(s) appended (weeks 8, 9)");
    expect(f.urls.filter((u) => u.includes("view=mTransactions2"))).toHaveLength(2);
    expect(cookieSent(f)).toBe(false);
    const { io, config, log } = await runtime("2026-11-03T12:40:00.000Z", f);
    const store = openStore(config, io.clock, log, { migrate: false });
    try {
      expect(store.repos.transactionsSeen.list(null, 100)).toHaveLength(2);
      // keyless 200s on a public league prove nothing: the session is still rejected
      expect(store.repos.credentialState.get()?.state).toBe("rejected");
    } finally {
      store.close();
    }
  });

  it.each([
    ["no publicity kept", null],
    ["a league kept private", false],
  ] as const)("%s: exit 0 with no request, as before", async (_name, kept) => {
    sb = sandbox();
    await rejectedInstall(kept);
    const f = oneMove();
    const r = await runtime("2026-11-03T12:30:00.000Z", f);
    expect(await transactionsAppend(r.io, r.config, r.log, { notify: true, force: true })).toBe(0);
    expect(r.io.out.text).toContain("rejected — waiting for the daily credential check");
    expect(f.urls).toEqual([]);
  });

  it("R3B-CS-3: launchd's wakes (no --force) keep plan 06 §1.4's rule — exit 0, no request, never a 'read keyless' line — and a forced run then reads keyless", async () => {
    // the pool job is held by the rejection (exit 0, no request, pool.worked_at never advances):
    // before, the transactions job's exception appended at most once per rejection and printed
    // "read keyless" on every wake that read nothing
    sb = sandbox();
    await rejectedInstall(true);
    const poolAt = new Date(2026, 10, 2, 10, 0).getTime();
    // the last pool run's append is still due: a wake would have read once, and only once, before
    updateJobState(sb.cacheDir, {
      "pool.worked_at": poolAt,
      "transactions.season": 2026,
      "transactions.period": 8,
    });
    for (const at of [
      new Date(2026, 10, 2, 10, 30),
      new Date(2026, 10, 2, 18, 30),
      new Date(2026, 10, 3, 6, 30),
      new Date(2026, 10, 4, 9, 30),
    ]) {
      const pool = oneMove();
      const rp = await runtime(new Date(at.getTime() - 30 * 60_000).toISOString(), pool);
      expect(await snapshotPool(rp.io, rp.config, rp.log, { notify: true })).toBe(0);
      expect(pool.urls).toEqual([]);
      const f = oneMove();
      const r = await runtime(at.toISOString(), f);
      const code = await transactionsAppend(r.io, r.config, r.log, { notify: true, force: false });
      const label = `${at.toString()} ${r.io.out.text}`;
      expect(code, label).toBe(0);
      expect(f.urls, label).toEqual([]);
      expect(r.io.out.text, label).toContain("rejected — waiting for the daily credential check");
      expect(r.io.out.text, label).not.toContain("read keyless");
    }
    expect(readJobState(sb.cacheDir)).toMatchObject({
      "pool.worked_at": poolAt,
      "transactions.period": 8,
    });
    // the owner's `eff transactions --force`: keyless, the periods since the last read appended
    const f = oneMove();
    const r = await runtime(new Date(2026, 10, 4, 12, 0).toISOString(), f);
    expect(await transactionsAppend(r.io, r.config, r.log, { notify: false, force: true })).toBe(0);
    expect(r.io.out.text).toContain("this league is public, so it is read keyless");
    expect(r.io.out.text).toContain("2 new transaction(s) appended (weeks 8, 9)");
    expect(cookieSent(f)).toBe(false);
  });

  it("R3B-CS-3: a wake with nothing to do never says it reads keyless", async () => {
    // a forced run says it once it reads; a wake under a working session says the pool's rule
    sb = sandbox();
    mkdirSync(sb.configDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(sb.configDir, "session.json"),
      sessionFileBody(COOKIES, metaFor(COOKIES, STORED_AT)),
      { mode: 0o600 },
    );
    const poolAt = new Date(2026, 10, 2, 10, 0).getTime();
    updateJobState(sb.cacheDir, { "pool.worked_at": poolAt, "transactions.after": poolAt });
    const f = oneMove();
    const r = await runtime(new Date(2026, 10, 3, 6, 30).toISOString(), f);
    expect(await transactionsAppend(r.io, r.config, r.log, { notify: true, force: false })).toBe(0);
    expect(r.io.out.text).toContain("not 30 min after a pool run — nothing to do");
    expect(r.io.out.text).not.toContain("read keyless");
    expect(f.urls).toEqual([]);
  });

  it("R3B-M3: a publicity row that cannot be read proves nothing — under a rejected session the job exits 0 with no request", async () => {
    sb = sandbox();
    await rejectedInstall(null);
    // the kept publicity row, corrupt (its JSON unreadable): keptPublic's catch must fail closed
    const r0 = await runtime("2026-11-03T12:00:00.000Z", oneMove());
    const store = openStore(r0.config, r0.io.clock, r0.log, { migrate: false });
    try {
      store.repos.espnCache.put({
        key: publicityKey("0"),
        parsed_json: "{not json",
        fetched_at: r0.io.clock.nowIso(),
        server_time: null,
        etag: null,
        http_status: 200,
        raw_body: null,
      });
      expect(() => cachedPublicity(store.repos.espnCache, "0", r0.io.clock).load()).toThrow();
    } finally {
      store.close();
    }
    const f = oneMove();
    const r = await runtime("2026-11-03T12:30:00.000Z", f);
    expect(await transactionsAppend(r.io, r.config, r.log, { notify: true, force: true })).toBe(0);
    expect(r.io.out.text).toContain("rejected — waiting for the daily credential check");
    expect(r.io.out.text).not.toContain("read keyless");
    expect(f.urls).toEqual([]);
  });

  it("every other job still exits 0 with no request on the public league", async () => {
    sb = sandbox();
    await rejectedInstall(true);
    const f = oneMove();
    const r = await runtime("2026-11-03T12:30:00.000Z", f);
    expect(await snapshotPool(r.io, r.config, r.log, { notify: false })).toBe(0);
    expect(r.io.out.text).toContain("rejected — waiting for the daily credential check");
    expect(f.urls).toEqual([]);
  });

  it("the tripwire holds on a keyless answer: a period that listed moves answering without the list is drift", async () => {
    sb = sandbox();
    await rejectedInstall(true);
    updateJobState(sb.cacheDir, {
      "transactions.season": 2026,
      "transactions.period": 8,
      "transactions.period_executed": 1,
    });
    // ESPN now answers period 8 without the list (and counts nothing): read as none — contradicted
    const f = publicLeague((p) =>
      p === 8 ? jsonRes(bareBase()) : jsonRes({ ...bareBase(), transactions: [] }),
    );
    const r = await runtime("2026-11-03T12:30:00.000Z", f);
    const code = await transactionsAppend(r.io, r.config, r.log, { notify: false, force: true });
    expect(code, `${r.io.out.text} | ${r.io.err.text}`).toBe(1);
    expect(r.io.err.text).toContain("eff transactions: ESPN_DRIFT_DETECTED");
    expect(r.io.err.text).toContain('"event":"transactions.absent_contradicted"');
    expect(cookieSent(f)).toBe(false);
    const { io, config, log } = await runtime("2026-11-03T12:40:00.000Z", f);
    const store = openStore(config, io.clock, log, { migrate: false });
    try {
      const row = store.repos.driftState.get();
      expect(row?.status).toBe("red");
      expect(parseDiffs(row?.diff_json ?? "[]")).toEqual([
        { view: "mTransactions2", removed: ["$.transactions"], added: [], enums: [] },
      ]);
    } finally {
      store.close();
    }
    // the job's state did not move: the next run re-reads the same period
    expect(readJobState(sb.cacheDir)).toMatchObject({
      "transactions.period": 8,
      "transactions.period_executed": 1,
    });
  });

  it("a keyless answer drift-checks like any other: an unrecognised-view answer fails the job", async () => {
    sb = sandbox();
    await rejectedInstall(true);
    updateJobState(sb.cacheDir, { "transactions.season": 2026, "transactions.period": 9 });
    const f = publicLeague(() => jsonRes(rec("league-a/skeleton.json")));
    const r = await runtime("2026-11-03T12:30:00.000Z", f);
    const code = await transactionsAppend(r.io, r.config, r.log, { notify: false, force: true });
    expect(code).toBe(1);
    expect(r.io.err.text).toContain("ESPN_DRIFT_DETECTED");
    expect(cookieSent(f)).toBe(false);
  });
});
