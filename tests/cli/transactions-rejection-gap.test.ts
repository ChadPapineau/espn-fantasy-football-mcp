// transactions-rejection-gap.test.ts — changelog §R10, R10-17 (plan 06 §1.4): under a rejected
// session every launchd job except the daily `credential check` reads `credential_state` first and
// exits 0 with no request, the transactions job included — on a private league and on one kept
// public alike (only the owner's `eff transactions --force` reads a known-public league's feed
// keyless: transactions-rejected-public.test.ts). The gap that rejection leaves in
// transactions_seen is filled by `eff transactions --backfill` after `eff setup`: the backfill
// reads the current season through its current scoring period (as well as the previous seasons),
// appends every missed row exactly once (dedup by transaction id), and leaves the transactions
// job's state caught up, so the job's next run neither re-reads the filled weeks nor reports them
// as a gap. `eff setup` itself is setup.test.ts's: here its outcome is planted — a new value stored
// and accepted (a 0600 session file and the credential_state row). A private stand-in of the
// recorded league-a (league id 0); placeholder cookies; no request leaves the process.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionFileBody } from "../../src/auth/file.js";
import { metaFor } from "../../src/auth/upgrade.js";
import { readJobState, updateJobState } from "../../src/cli/job-state.js";
import { JOBS } from "../../src/cli/launchd.js";
import { main } from "../../src/cli/main.js";
import { loadRuntime } from "../../src/cli/runtime.js";
import { gapPatch, transactionsAppend, unreadTransactionPeriods } from "../../src/cli/snapshot.js";
import { openStore } from "../../src/cli/store-access.js";
import { cachedPublicity } from "../../src/providers/espn/cache.js";
import { composeBodies } from "../../src/providers/espn/index.js";
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
const rec = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(REC, rel), "utf8")) as Record<string, unknown>;
const jsonRes = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const OLD = fakeCookies("r10-17-rejected");
const NEW = fakeCookies("r10-17-after-setup");
const OLD_AT = "2026-09-01T00:00:00.000Z";
const NEW_AT = "2026-11-04T09:00:00.000Z";
const SEASON = 2026;
const ENV = {
  ESPN_LEAGUE_ID: "0",
  EFF_CREDENTIAL_STORE: "file",
  ESPN_SEASON: String(SEASON),
  ESPN_TEAM_ID: "1",
};

/** A transaction id in the fake GUID range: one waiver claim per season and scoring period. */
const txId = (season: number, week: number): string =>
  `00000000-0000-4000-8000-${String(season % 100).padStart(4, "0")}${String(week).padStart(8, "0")}`;

function claim(season: number, week: number) {
  const at = Date.UTC(season, 8, 8) + (week - 1) * 7 * 86_400_000;
  return {
    id: txId(season, week),
    type: "WAIVER",
    status: "EXECUTED",
    teamId: 1,
    scoringPeriodId: week,
    proposedDate: at - 3_600_000,
    processDate: at,
    bidAmount: 0,
    isPending: false,
    items: [
      {
        type: "ADD",
        playerId: 1000 + week,
        fromTeamId: 0,
        toTeamId: 1,
        fromLineupSlotId: -1,
        toLineupSlotId: 20,
        isKeeper: false,
      },
    ],
  };
}

/** What the fake league saw: every request, and whether it carried a cookie (and whose). */
interface Seen {
  readonly url: string;
  readonly cookie: "none" | "old" | "new" | "other";
}

/** The fake league's clock and which stored value ESPN accepts. */
interface LeagueState {
  current: number;
  /** Whether ESPN still accepts the old value (before the rejection). */
  oldAccepted: boolean;
}

/**
 * The PRIVATE league at scoring period `league.current`: keyless league reads answer 401, the old
 * value's cookie 401 once ESPN rejects it, the value `eff setup` stored the recordings — each
 * season's settings and one claim per period of the transaction feed.
 */
function privateLeague(league: LeagueState) {
  const seen: Seen[] = [];
  const f = fakeFetch((url, init) => {
    const header = new Headers(init.headers).get("cookie");
    const cookie: Seen["cookie"] =
      header === null
        ? "none"
        : header.includes(NEW.espn_s2)
          ? "new"
          : header.includes(OLD.espn_s2)
            ? "old"
            : "other";
    seen.push({ url, cookie });
    const u = new URL(url);
    const views = u.searchParams.getAll("view");
    if (views.includes("proTeamSchedules_wl"))
      return jsonRes(rec("season/proTeamSchedules_wl.json"));
    if (!u.pathname.includes("/leagues/0")) return new Response(null, { status: 404 });
    if (cookie !== "new" && !(cookie === "old" && league.oldAccepted))
      return jsonRes({ messages: ["not authorized"] }, 401);
    const season = Number(/\/seasons\/(\d{4})\//.exec(u.pathname)?.[1] ?? "0");
    const s = structuredClone(rec("league-a/mSettings.json")) as {
      settings: Record<string, unknown>;
      status: Record<string, unknown>;
    };
    s.settings.isPublic = false;
    const current = season === SEASON ? league.current : 17;
    s.status.currentMatchupPeriod = current;
    s.status.latestScoringPeriod = current;
    const base = { ...s, seasonId: season, scoringPeriodId: current };
    if (views.includes("mTransactions2")) {
      const week = Number(u.searchParams.get("scoringPeriodId") ?? "0");
      return jsonRes({ ...base, scoringPeriodId: week, transactions: [claim(season, week)] });
    }
    let body: unknown = base;
    if (views.includes("mNav")) body = composeBodies(body, rec("league-a/mNav.json"));
    if (views.includes("mTeam")) body = composeBodies(body, rec("league-a/mTeam.json"));
    return jsonRes(body);
  });
  return { ...f, seen };
}

function ioAt(at: string, f: { fetch: ReturnType<typeof fakeFetch>["fetch"] }) {
  const clock = movingClock(at);
  return makeIo(sb, {
    fetch: f.fetch,
    clock,
    platform: "darwin",
    exec: fakeExec().exec,
    packageRoot: fakePackage(sb),
    env: ENV,
    // fake time for every wait (the limiter's and the backfill's pacing): nothing sleeps
    sleep: (ms) => {
      clock.advance(Math.max(0, ms));
      return Promise.resolve();
    },
  });
}

async function withStore<T>(
  at: string,
  f: { fetch: ReturnType<typeof fakeFetch>["fetch"] },
  use: (store: ReturnType<typeof openStore>, io: ReturnType<typeof ioAt>) => T,
): Promise<T> {
  const io = ioAt(at, f);
  const { config, log } = await loadRuntime(io);
  const store = openStore(config, io.clock, log, { migrate: true });
  try {
    return use(store, io);
  } finally {
    store.close();
  }
}

/**
 * The install before the rejection: the old value stored and accepted, the transactions job run in
 * weeks 1 and 2 (weeks 1 and 2 in transactions_seen, its state at period 2); then ESPN rejects that
 * value (the row records it, as the next cookie-bearing 401 would).
 */
async function rejectedAfterWeek2(f: ReturnType<typeof privateLeague>, league: LeagueState) {
  mkdirSync(sb.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(sb.configDir, "session.json"),
    sessionFileBody(OLD, metaFor(OLD, OLD_AT)),
    { mode: 0o600 },
  );
  await withStore(OLD_AT, f, (store) => {
    store.repos.credentialState.put(
      stateRow({ store: "file", state: "validated", stored_at: OLD_AT, last_accepted_at: OLD_AT }),
    );
  });
  const was = league.current;
  league.oldAccepted = true;
  for (const [week, at] of [
    [1, "2026-09-09T11:30:00.000Z"],
    [2, "2026-09-16T11:30:00.000Z"],
  ] as const) {
    league.current = week;
    const w = await jobWake(new Date(at), f);
    expect(w.code, `${w.io.out.text} ${w.io.err.text}`).toBe(0);
  }
  expect(await storedWeeks(f)).toEqual([1, 2]);
  expect(readJobState(sb.cacheDir)).toMatchObject({ "transactions.period": 2 });
  league.oldAccepted = false;
  league.current = was;
  await withStore("2026-09-22T09:00:00.000Z", f, (store) => {
    store.repos.credentialState.put(
      stateRow({
        store: "file",
        state: "rejected",
        stored_at: OLD_AT,
        last_accepted_at: OLD_AT,
        last_rejected_at: "2026-09-22T09:00:00.000Z",
        rejected_since: "2026-09-22T09:00:00.000Z",
        rejected_view: "mRoster",
      }),
    );
  });
  f.seen.length = 0;
}

/** `eff setup`'s outcome (setup.test.ts covers the command): a new value stored and accepted. */
async function setupDone(f: { fetch: ReturnType<typeof fakeFetch>["fetch"] }) {
  writeFileSync(
    path.join(sb.configDir, "session.json"),
    sessionFileBody(NEW, metaFor(NEW, NEW_AT)),
    { mode: 0o600 },
  );
  await withStore(NEW_AT, f, (store) => {
    store.repos.credentialState.put(
      stateRow({
        store: "file",
        state: "validated",
        stored_at: NEW_AT,
        last_accepted_at: NEW_AT,
        updated_by: "setup",
      }),
    );
  });
}

/**
 * The scoring period of every stored row of this season, ascending — one claim per period was
 * served, so a period listed twice is a row stored twice (the stored id is the provider's own, not
 * ESPN's).
 */
async function storedWeeks(f: { fetch: ReturnType<typeof fakeFetch>["fetch"] }): Promise<number[]> {
  return withStore("2026-11-04T12:00:00.000Z", f, (store) =>
    store.repos.transactionsSeen
      .list(null, 1000)
      .filter((t) => (t.process_date ?? "").startsWith(String(SEASON)))
      .map((t) => t.scoring_period ?? -1)
      .sort((a, b) => a - b),
  );
}

/** The transactions job's wake 30 min after a pool run (`--notify`, no `--force`: launchd's). */
async function jobWake(at: Date, f: ReturnType<typeof privateLeague>) {
  updateJobState(sb.cacheDir, { "pool.worked_at": at.getTime() - 30 * 60_000 });
  const io = ioAt(at.toISOString(), f);
  const { config, log } = await loadRuntime(io);
  const code = await transactionsAppend(io, config, log, { notify: true, force: false });
  return { code, io };
}

const CREDENTIALED = JOBS.filter((j) => j.cookies && j.name !== "credential-check");

describe("R10-17: every launchd job but the credential check exits 0 with no request while rejected", () => {
  it("the credentialed jobs are the ones plan 06 §1.4 lists (the transactions job included)", () => {
    sb = sandbox();
    expect(CREDENTIALED.map((j) => j.name).sort()).toEqual([
      "pre-kickoff",
      "snapshot-pool",
      "snapshot-projections",
      "snapshot-roster",
      "snapshot-roster-gameday",
      "transactions",
    ]);
    // launchd never forces the transactions job (only the owner's `eff transactions --force` reads
    // a known-public league keyless under a rejected session)
    for (const j of JOBS) expect(j.argv).not.toContain("--force");
  });

  it.each([
    ["a private league", false],
    ["a league kept public", true],
  ] as const)("%s: each job as launchd runs it — exit 0, no request", async (_name, kept) => {
    sb = sandbox();
    const league = { current: 5, oldAccepted: false };
    const f = privateLeague(league);
    await rejectedAfterWeek2(f, league);
    if (kept)
      await withStore("2026-10-11T11:00:00.000Z", f, (store, io) => {
        cachedPublicity(store.repos.espnCache, "0", io.clock).save(true);
      });
    // the pool's run is due for the transactions job (it would read were it not for the rejection)
    updateJobState(sb.cacheDir, { "pool.worked_at": Date.parse("2026-10-11T11:00:00.000Z") });
    for (const job of CREDENTIALED) {
      const io = ioAt("2026-10-11T11:30:00.000Z", f);
      const code = await main([...job.argv], io);
      expect(code, `${job.name}: ${io.out.text} ${io.err.text}`).toBe(0);
      expect(io.out.text, job.name).toContain("rejected — waiting for the daily credential check");
      expect(io.out.text, job.name).not.toContain("read keyless");
    }
    expect(f.seen, "no request of any kind").toEqual([]);
  });
});

describe("R10-17: the gap a rejection leaves is filled by `eff transactions --backfill` after `eff setup`", () => {
  it("rejection, a gap, setup, backfill: the missed rows appended exactly once, the job caught up", async () => {
    sb = sandbox();
    const league = { current: 2, oldAccepted: false };
    const f = privateLeague(league);
    await rejectedAfterWeek2(f, league);
    // the rejection holds the transactions job week after week: exit 0, no request, nothing stored
    for (const [week, at] of [
      [3, "2026-09-23T11:30:00.000Z"],
      [5, "2026-10-07T11:30:00.000Z"],
      [7, "2026-10-21T11:30:00.000Z"],
      [9, "2026-11-04T08:30:00.000Z"],
    ] as const) {
      league.current = week;
      const w = await jobWake(new Date(at), f);
      expect(w.code).toBe(0);
      expect(w.io.out.text).toContain("rejected — waiting for the daily credential check");
    }
    expect(f.seen).toEqual([]);
    // the gap: weeks 3–9 were never read
    expect(await storedWeeks(f)).toEqual([1, 2]);
    expect(readJobState(sb.cacheDir)).toMatchObject({ "transactions.period": 2 });
    league.current = 9;

    await setupDone(f);
    const io = ioAt("2026-11-04T10:00:00.000Z", f);
    expect(await main(["transactions", "--backfill"], io), io.err.text).toBe(0);
    // the periods the job left unread first (from its last read, re-read), through the current
    // one, then the newest two previous seasons
    expect(io.out.text).toContain(
      "season 2026: 8 week(s) read, 8 transaction(s), 7 new (this season, weeks 2–9)",
    );
    expect(io.out.text).toContain("season 2025: 17 week(s) read");
    expect(io.out.text).toContain("season 2024: 17 week(s) read");
    // only the value `eff setup` stored is ever sent, never the rejected one
    expect(f.seen.length).toBeGreaterThan(0);
    expect(f.seen.filter((s) => s.cookie !== "new" && s.url.includes("/leagues/"))).toEqual([]);
    // every missed week once, the weeks stored before the rejection not again
    expect(await storedWeeks(f)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // the job's state reads as caught up through the current period (the tripwire's record too)
    expect(readJobState(sb.cacheDir)).toMatchObject({
      "transactions.season": SEASON,
      "transactions.period": 9,
      "transactions.period_executed": 1,
    });

    // the job's next run re-reads only the current period: nothing new, no gap reported
    const n = f.seen.length;
    const next = await jobWake(new Date("2026-11-04T12:30:00.000Z"), f);
    expect(next.code, next.io.err.text).toBe(0);
    expect(next.io.out.text).toContain("0 new transaction(s) appended (week 9)");
    expect(next.io.out.text).not.toContain("warning");
    expect(
      f.seen
        .slice(n)
        .filter((s) => s.url.includes("view=mTransactions2"))
        .map((s) => s.url),
    ).toHaveLength(1);
    // a re-run of the backfill stores nothing twice (and has no period of this season left)
    const again = ioAt("2026-11-04T13:00:00.000Z", f);
    expect(await main(["transactions", "--backfill"], again)).toBe(0);
    expect(again.out.text).not.toContain("season 2026");
    expect(again.out.text).toContain("0 new transaction(s) stored");
    expect(await storedWeeks(f)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  }, 120_000);

  it("the job ran first after setup: it says and keeps the gap and names the backfill, which fills only what is missing", async () => {
    sb = sandbox();
    const league = { current: 9, oldAccepted: false };
    const f = privateLeague(league);
    await rejectedAfterWeek2(f, league);
    await setupDone(f);
    const first = await jobWake(new Date("2026-11-04T11:30:00.000Z"), f);
    expect(first.code, first.io.err.text).toBe(0);
    expect(first.io.out.text).toContain("4 new transaction(s) appended (weeks 6, 7, 8, 9)");
    expect(first.io.out.text).toContain(
      "warning: scoring period(s) 2–5 were not read (the job did not run then): the moves made in them since the last run are missing from transactions_seen; `eff transactions --backfill` reads them",
    );
    // the gap is kept until a backfill reads it
    expect(readJobState(sb.cacheDir)).toMatchObject({
      "transactions.period": 9,
      "transactions.gap_season": SEASON,
      "transactions.gap_from": 2,
    });
    const io = ioAt("2026-11-04T12:00:00.000Z", f);
    expect(await main(["transactions", "--backfill"], io), io.err.text).toBe(0);
    expect(io.out.text).toContain(
      "season 2026: 8 week(s) read, 8 transaction(s), 3 new (this season, weeks 2–9)",
    );
    expect(await storedWeeks(f)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // the job's own record of week 9 stands (it read as far); the gap the backfill read is cleared
    const state = readJobState(sb.cacheDir);
    expect(state).toMatchObject({ "transactions.period": 9 });
    expect(state["transactions.gap_from"]).toBeUndefined();
    // a second backfill has nothing of this season left to read
    const again = ioAt("2026-11-04T13:00:00.000Z", f);
    expect(await main(["transactions", "--backfill"], again)).toBe(0);
    expect(again.out.text).not.toContain("season 2026");
    expect(again.out.text).toContain("0 new transaction(s) stored");
    // --seasons naming the current season reads it whole, storing nothing twice; no previous
    // season was read, so no claim about the waiver fit's premium
    const whole = ioAt("2026-11-04T14:00:00.000Z", f);
    expect(await main(["transactions", "--backfill", "--seasons", "2026"], whole)).toBe(0);
    expect(whole.out.text).toContain(
      "season 2026: 9 week(s) read, 9 transaction(s), 0 new (this season, weeks 1–9)",
    );
    expect(whole.out.text).toContain("0 new transaction(s) stored\n");
    expect(await storedWeeks(f)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  }, 120_000);

  it("--seasons refuses a season after the configured one (usage)", async () => {
    sb = sandbox();
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0", ESPN_SEASON: "2026" } });
    expect(await main(["transactions", "--backfill", "--seasons", "2027"], io)).toBe(2);
    expect(io.err.text).toContain("this season or previous ones (up to 2026)");
  });
});

describe("R10-17: the unread periods a backfill reads (unreadTransactionPeriods, gapPatch)", () => {
  const S = SEASON;
  it.each([
    ["never read this season", {}, 9, null],
    [
      "another season's record",
      { "transactions.season": S - 1, "transactions.period": 3 },
      9,
      null,
    ],
    [
      "read through the current period",
      { "transactions.season": S, "transactions.period": 9 },
      9,
      null,
    ],
    [
      "behind the current period: from the last read",
      { "transactions.season": S, "transactions.period": 2 },
      9,
      2,
    ],
    [
      "a kept gap wins over a later last read",
      {
        "transactions.season": S,
        "transactions.period": 9,
        "transactions.gap_season": S,
        "transactions.gap_from": 3,
      },
      9,
      3,
    ],
    [
      "another season's gap is not this season's",
      {
        "transactions.season": S,
        "transactions.period": 9,
        "transactions.gap_season": S - 1,
        "transactions.gap_from": 3,
      },
      9,
      null,
    ],
    [
      "a non-integer period proves nothing",
      { "transactions.season": S, "transactions.period": 2.5 },
      9,
      null,
    ],
  ] as const)("%s", (_name, state, current, want) => {
    expect(unreadTransactionPeriods(state, S, current)).toBe(want);
  });

  it("gapPatch keeps the older of two gaps of one season, and a new season's gap replaces the old", () => {
    expect(gapPatch({}, S, 5)).toEqual({
      "transactions.gap_season": S,
      "transactions.gap_from": 5,
    });
    const kept = { "transactions.gap_season": S, "transactions.gap_from": 3 };
    expect(gapPatch(kept, S, 5)).toEqual(kept);
    expect(gapPatch(kept, S, 2)).toEqual({
      "transactions.gap_season": S,
      "transactions.gap_from": 2,
    });
    expect(gapPatch(kept, S + 1, 6)).toEqual({
      "transactions.gap_season": S + 1,
      "transactions.gap_from": 6,
    });
  });
});
