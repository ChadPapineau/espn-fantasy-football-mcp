// transactions-absent.test.ts — finding transactions-absent-key-red, end to end through the CLI (plan
// 06 §1.4 `transactions append`; plan 01 §7): the live install's hourly `eff transactions` read the
// scoring period that had just rolled (no move in it yet) and ESPN answered the cookie-bearing
// `mTransactions2` request with the recognised view's bare base and no `transactions` key; the job
// exited 1 with ESPN_DRIFT_DETECTED every hour (with --notify) and drift_state turned red. Here: such
// an answer is the empty week (exit 0, nothing appended, the drift row untouched, no failure said);
// the red row the live runs left clears on the next run, and `eff refresh espn:drift` re-reads the
// view and clears it too (its re-read asked for no transaction type at all — VALIDATION, never sent).
// What stays drift still fails the job. A private stand-in of the recorded league-a (league id 0),
// placeholder cookies in a 0600 file store; no request leaves the process.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionFileBody } from "../../src/auth/file.js";
import { metaFor } from "../../src/auth/upgrade.js";
import { DRIFT_REFRESH_TARGET } from "../../src/cli/drift-recheck.js";
import { readJobState, readNotifications, updateJobState } from "../../src/cli/job-state.js";
import { main } from "../../src/cli/main.js";
import type { DriftRefreshReport } from "../../src/cli/refresh-drift.js";
import { loadRuntime } from "../../src/cli/runtime.js";
import { transactionsAppend } from "../../src/cli/snapshot.js";
import { openStore } from "../../src/cli/store-access.js";
import { parseDiffs } from "../../src/drift/index.js";
import type { DriftStateRow } from "../../src/drift/types.js";
import { TRANSACTION_TYPES } from "../../src/domain/league/types.js";
import { composeBodies } from "../../src/providers/espn/index.js";
import { HEADER_TRANSACTION_COUNT } from "../../src/providers/espn/types.js";
import { fakeCookies } from "../auth/helpers.js";
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
const COOKIES = fakeCookies("cli-transactions-absent");
const ENV = {
  ESPN_LEAGUE_ID: "0",
  EFF_CREDENTIAL_STORE: "file",
  ESPN_SEASON: "2026",
  ESPN_TEAM_ID: "1",
};

/** The recognised view's bare base (research 03 P11 without its list; P17/P18): draftDetail etc. */
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

type Week9 = "absent" | "skeleton" | { count: string };

/**
 * The private league at scoring period 9: period 8 holds one move; period 9's answer is `week9` —
 * the recognised bare base without the key (`absent`, ESPN's count header `0`), the same with a
 * count above 0, or the unrecognised-view answer (the recorded P28 skeleton).
 */
function privateLeague(week9: Week9 = "absent") {
  return scriptedLeague((p) => {
    if (p === 8)
      return jsonRes(
        { ...bareBase(), transactions: [tx(1, 8, "2026-11-02T18:00:00.000Z")] },
        { [HEADER_TRANSACTION_COUNT]: "1" },
      );
    if (week9 === "skeleton") return jsonRes(rec("league-a/skeleton.json"));
    if (week9 === "absent") return jsonRes(bareBase(), { [HEADER_TRANSACTION_COUNT]: "0" });
    return jsonRes(bareBase(), { [HEADER_TRANSACTION_COUNT]: week9.count });
  });
}

/** The private league at scoring period `current`, each period's mTransactions2 answer scripted. */
function scriptedLeague(txns: (period: number) => Response, current = 9) {
  return fakeFetch((url) => {
    const u = new URL(url);
    const views = u.searchParams.getAll("view");
    if (views.includes("proTeamSchedules_wl"))
      return jsonRes(rec("season/proTeamSchedules_wl.json"));
    if (!u.pathname.includes("/leagues/0")) return new Response(null, { status: 404 });
    const s = structuredClone(rec("league-a/mSettings.json")) as {
      settings: Record<string, unknown>;
    };
    s.settings.isPublic = false;
    const settings = { ...s, scoringPeriodId: current };
    if (views.includes("mTransactions2"))
      return txns(Number(u.searchParams.get("scoringPeriodId") ?? "0"));
    let body: unknown = settings;
    if (views.includes("mNav")) body = composeBodies(body, rec("league-a/mNav.json"));
    if (views.includes("mTeam")) body = composeBodies(body, rec("league-a/mTeam.json"));
    return jsonRes(body);
  });
}

function plantCookies(): void {
  mkdirSync(sb.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(sb.configDir, "session.json"),
    sessionFileBody(COOKIES, metaFor(COOKIES, "2026-10-01T00:00:00.000Z")),
    { mode: 0o600 },
  );
}

async function runtime(at: string, f: ReturnType<typeof fakeFetch>) {
  const { exec, calls } = fakeExec();
  const io = makeIo(sb, {
    fetch: f.fetch,
    clock: movingClock(at),
    platform: "darwin",
    exec,
    packageRoot: fakePackage(sb),
    env: ENV,
  });
  const { config, log } = await loadRuntime(io);
  return { io, config, log, calls };
}

/** Opens the sandbox's store for `fn` (migrated on first use). */
async function withStore<T>(
  fn: (s: ReturnType<typeof openStore>) => T,
  at = "2026-11-03T10:00:00.000Z",
): Promise<T> {
  const { io, config, log } = await runtime(at, privateLeague());
  const store = openStore(config, io.clock, log, { migrate: true });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/** The live install's row: `$.transactions` removed since 11:30:02, beside additive keys and enums. */
function liveRedRow(): DriftStateRow {
  return {
    status: "red",
    since: "2026-11-03T11:30:02.000Z",
    last_probe_at: null,
    manifest_hash: null,
    manifest_version: null,
    host: "lm-api-reads.fantasy.espn.com",
    host_moved_at: null,
    diff_json: JSON.stringify([
      { view: "mTransactions2", removed: ["$.transactions"], added: [], enums: [] },
      { view: "mSettings", removed: [], added: [], enums: ["$.status.waiverProcessStatus{}=7"] },
    ]),
    additive_json: JSON.stringify([
      { view: "mSettings", removed: [], added: ["$.settings.someNewKey"], enums: [] },
    ]),
    updated_at: "2026-11-03T12:30:03.000Z",
  };
}

const period9Reads = (urls: readonly string[]) =>
  urls.filter(
    (u) =>
      u.includes("view=mTransactions2") && new URL(u).searchParams.get("scoringPeriodId") === "9",
  );

describe("`eff transactions` on a period nobody has moved in yet (transactions-absent-key-red)", () => {
  it("the job works: exit 0, nothing appended, the drift row unchanged, no failure said", async () => {
    sb = sandbox();
    plantCookies();
    updateJobState(sb.cacheDir, { "transactions.season": 2026, "transactions.period": 9 });
    const f = privateLeague("absent");
    const r = await runtime("2026-11-03T12:30:00.000Z", f);
    const seeded = await withStore((s) => {
      s.repos.driftState.put({ ...liveRedRow(), status: "additive", since: null, diff_json: "[]" });
      return s.repos.driftState.get();
    });
    const code = await transactionsAppend(r.io, r.config, r.log, { notify: true, force: true });
    expect(code, `${r.io.out.text} | ${r.io.err.text}`).toBe(0);
    expect(r.io.out.text).toContain("transactions: 0 new transaction(s) appended (week 9)");
    expect(r.io.err.text).not.toContain("ESPN_DRIFT_DETECTED");
    expect(period9Reads(f.urls)).toHaveLength(1);
    for (const init of f.inits.filter((_, i) => f.urls[i]?.includes("mTransactions2")))
      expect(new Headers(init.headers).get("cookie")).toContain("SWID=");
    await withStore((s) => {
      expect(s.repos.transactionsSeen.list(null, 100)).toEqual([]);
      expect(s.repos.driftState.get()).toEqual(seeded);
    });
    expect(readNotifications(sb.cacheDir).filter((n) => n.kind === "failure")).toEqual([]);
    expect(r.calls.some((c) => c.args.join(" ").includes("ESPN_DRIFT_DETECTED"))).toBe(false);
    expect(readJobState(sb.cacheDir)).toMatchObject({
      "transactions.period": 9,
      "transactions.season": 2026,
    });
  });

  it("the live install's red row clears on the next run (the rollover's weeks 8 and 9 read), additive left", async () => {
    sb = sandbox();
    plantCookies();
    updateJobState(sb.cacheDir, { "transactions.season": 2026, "transactions.period": 8 });
    await withStore((s) => {
      s.repos.driftState.put(liveRedRow());
    });
    const f = privateLeague("absent");
    const r = await runtime("2026-11-03T13:30:00.000Z", f);
    expect(await transactionsAppend(r.io, r.config, r.log, { notify: true, force: true })).toBe(0);
    expect(r.io.out.text).toContain("1 new transaction(s) appended (weeks 8, 9)");
    await withStore((s) => {
      const row = s.repos.driftState.get();
      expect(row?.status).toBe("additive");
      expect(row?.since).toBeNull();
      expect(parseDiffs(row?.diff_json ?? "[]")).toEqual([
        { view: "mSettings", removed: [], added: [], enums: ["$.status.waiverProcessStatus{}=7"] },
      ]);
      expect(s.repos.transactionsSeen.list(null, 100)).toHaveLength(1);
    });
  });

  it("what is still drift still fails the job: the unrecognised-view answer, or a count ESPN did not send", async () => {
    for (const week9 of ["skeleton", { count: "3" }] as const) {
      sb = sandbox();
      plantCookies();
      updateJobState(sb.cacheDir, { "transactions.season": 2026, "transactions.period": 9 });
      const r = await runtime("2026-11-03T12:30:00.000Z", privateLeague(week9));
      expect(await transactionsAppend(r.io, r.config, r.log, { notify: true, force: true })).toBe(
        1,
      );
      expect(r.io.err.text).toContain("eff transactions: ESPN_DRIFT_DETECTED");
      await withStore((s) => {
        const row = s.repos.driftState.get();
        expect(row?.status).toBe("red");
        expect(parseDiffs(row?.diff_json ?? "[]")).toEqual([
          { view: "mTransactions2", removed: ["$.transactions"], added: [], enums: [] },
        ]);
      });
      sb.cleanup();
    }
    sb = sandbox();
  });
});

describe("`eff refresh espn:drift` re-reads a red mTransactions2 and clears it", () => {
  it("one read of the current period, every transaction type asked; cleared, exit 0", async () => {
    sb = sandbox();
    plantCookies();
    await withStore((s) => {
      s.repos.driftState.put(liveRedRow());
    });
    const f = privateLeague("absent");
    const { exec } = fakeExec();
    const io = makeIo(sb, {
      fetch: f.fetch,
      clock: movingClock("2026-11-03T13:00:00.000Z"),
      platform: "darwin",
      exec,
      packageRoot: fakePackage(sb),
      env: ENV,
    });
    const code = await main(["refresh", DRIFT_REFRESH_TARGET, "--json"], io);
    expect(code, `${io.out.text} | ${io.err.text}`).toBe(0);
    const report = JSON.parse(io.out.text.trim().split("\n").pop() ?? "{}") as DriftRefreshReport;
    expect(report).toMatchObject({ target: "espn:drift", before: "red", after: "additive" });
    expect(report.views).toEqual([
      { view: "mTransactions2", outcome: "cleared", removed: [], reason: null },
    ]);
    const reads = f.urls
      .map((u, i) => ({ u, init: f.inits[i] }))
      .filter((x) => x.u.includes("view=mTransactions2"));
    expect(reads).toHaveLength(1);
    expect(new URL(reads[0]?.u ?? "x:").searchParams.get("scoringPeriodId")).toBe("9");
    const filter = JSON.parse(
      new Headers(reads[0]?.init?.headers).get("x-fantasy-filter") ?? "{}",
    ) as { transactions: { filterType: { value: string[] } } };
    expect(filter.transactions.filterType.value).toEqual([...TRANSACTION_TYPES]);
  });
});

// verifier finding F2 on ec68d08: an answer without the list reads as the empty week, so a view that
// stopped serving the list would read the same, every week, silently. The job's tripwire: the period
// it recorded, whose read listed executed moves, answering without the list is drift.
describe("`eff transactions`: a period that listed executed moves answering without the list is drift (F2)", () => {
  /** Every period answered with the bare base and no count header: the view serving nothing. */
  const noop = () => scriptedLeague(() => jsonRes(bareBase()));

  it("run 1 stores a week-8 move and records it; ESPN then serves no list: run 2 fails ESPN_DRIFT_DETECTED, red, state unmoved", async () => {
    sb = sandbox();
    plantCookies();
    updateJobState(sb.cacheDir, { "transactions.season": 2026, "transactions.period": 8 });
    const week8 = scriptedLeague(
      (p) =>
        p === 8
          ? jsonRes(
              { ...bareBase(), transactions: [tx(1, 8, "2026-11-02T18:00:00.000Z")] },
              { [HEADER_TRANSACTION_COUNT]: "1" },
            )
          : jsonRes(bareBase()),
      8,
    );
    const r1 = await runtime("2026-11-02T20:30:00.000Z", week8);
    expect(await transactionsAppend(r1.io, r1.config, r1.log, { notify: true, force: true })).toBe(
      0,
    );
    expect(readJobState(sb.cacheDir)).toMatchObject({
      "transactions.period": 8,
      "transactions.period_executed": 1,
    });
    const f = noop();
    const r2 = await runtime("2026-11-03T12:30:00.000Z", f);
    const code = await transactionsAppend(r2.io, r2.config, r2.log, { notify: true, force: true });
    expect(code, `${r2.io.out.text} | ${r2.io.err.text}`).toBe(1);
    expect(r2.io.err.text).toContain("eff transactions: ESPN_DRIFT_DETECTED");
    expect(r2.io.err.text).toContain('"event":"transactions.absent_contradicted"');
    expect(r2.io.out.text).not.toContain("appended");
    // the contradicted period is the first read; nothing after it is read
    expect(
      f.urls
        .filter((u) => u.includes("view=mTransactions2"))
        .map((u) => new URL(u).searchParams.get("scoringPeriodId")),
    ).toEqual(["8"]);
    await withStore((s) => {
      const row = s.repos.driftState.get();
      expect(row?.status).toBe("red");
      expect(parseDiffs(row?.diff_json ?? "[]")).toEqual([
        { view: "mTransactions2", removed: ["$.transactions"], added: [], enums: [] },
      ]);
      expect(s.repos.transactionsSeen.list(null, 100)).toHaveLength(1);
    });
    expect(readJobState(sb.cacheDir)).toMatchObject({
      "transactions.period": 8,
      "transactions.period_executed": 1,
    });
    expect(readNotifications(sb.cacheDir).some((n) => n.kind === "failure")).toBe(true);
    // the next run re-reads the same period and fails again: the drift stays said, never flaps
    const r3 = await runtime("2026-11-03T13:30:00.000Z", noop());
    expect(await transactionsAppend(r3.io, r3.config, r3.log, { notify: false, force: true })).toBe(
      1,
    );
    await withStore((s) => {
      expect(s.repos.driftState.get()?.status).toBe("red");
    });
  });

  it("cannot fire on a period nobody moved in, another season's period, or a list ESPN sends (even empty)", async () => {
    const cases: [string, Record<string, number>, () => ReturnType<typeof fakeFetch>][] = [
      [
        "no executed move recorded",
        {
          "transactions.season": 2026,
          "transactions.period": 8,
          "transactions.period_executed": 0,
        },
        noop,
      ],
      [
        "no count recorded (a run of an older build)",
        { "transactions.season": 2026, "transactions.period": 8 },
        noop,
      ],
      [
        "another season's period",
        {
          "transactions.season": 2025,
          "transactions.period": 9,
          "transactions.period_executed": 4,
        },
        noop,
      ],
      [
        "the list sent, empty",
        {
          "transactions.season": 2026,
          "transactions.period": 8,
          "transactions.period_executed": 2,
        },
        () =>
          scriptedLeague((p) =>
            p === 8 ? jsonRes({ ...bareBase(), transactions: [] }) : jsonRes(bareBase()),
          ),
      ],
    ];
    for (const [name, state, league] of cases) {
      sb = sandbox();
      plantCookies();
      updateJobState(sb.cacheDir, state);
      const r = await runtime("2026-11-03T12:30:00.000Z", league());
      const code = await transactionsAppend(r.io, r.config, r.log, { notify: true, force: true });
      expect(code, `${name}: ${r.io.err.text}`).toBe(0);
      expect(r.io.err.text, name).not.toContain("absent_contradicted");
      await withStore((s) => {
        expect(s.repos.driftState.get()?.status ?? "green", name).not.toBe("red");
      });
      expect(readJobState(sb.cacheDir), name).toMatchObject({
        "transactions.period": 9,
        "transactions.period_executed": 0,
      });
      sb.cleanup();
    }
    sb = sandbox();
  });

  it("records the executed moves of the current period only (pending and failed entries are not counted)", async () => {
    sb = sandbox();
    plantCookies();
    updateJobState(sb.cacheDir, { "transactions.season": 2026, "transactions.period": 9 });
    const at = "2026-11-03T09:00:00.000Z";
    const league = scriptedLeague(() =>
      jsonRes({
        ...bareBase(),
        transactions: [
          tx(1, 9, at),
          tx(2, 9, at),
          { ...tx(3, 9, at), status: "PENDING" },
          { ...tx(4, 9, at), type: "WAIVER_ERROR", status: "FAILED_INVALIDPLAYERSOURCE" },
        ],
      }),
    );
    const r = await runtime("2026-11-03T12:30:00.000Z", league);
    expect(await transactionsAppend(r.io, r.config, r.log, { notify: true, force: true })).toBe(0);
    expect(readJobState(sb.cacheDir)).toMatchObject({ "transactions.period_executed": 2 });
  });
});

describe("`eff refresh espn:drift` on an answer without the list (F3)", () => {
  async function refresh(f: ReturnType<typeof fakeFetch>, json: boolean) {
    const { exec } = fakeExec();
    const io = makeIo(sb, {
      fetch: f.fetch,
      clock: movingClock("2026-11-03T13:00:00.000Z"),
      platform: "darwin",
      exec,
      packageRoot: fakePackage(sb),
      env: ENV,
    });
    const code = await main(["refresh", DRIFT_REFRESH_TARGET, ...(json ? ["--json"] : [])], io);
    return { code, io };
  }

  it("no count beside the absent list: still red, said as an answer without the list — never 'has every key'", async () => {
    for (const json of [true, false]) {
      sb = sandbox();
      plantCookies();
      await withStore((s) => {
        s.repos.driftState.put(liveRedRow());
      });
      const { code, io } = await refresh(
        scriptedLeague(() => jsonRes(bareBase())),
        json,
      );
      expect(code, io.err.text).toBe(4);
      if (json) {
        const report = JSON.parse(
          io.out.text.trim().split("\n").pop() ?? "{}",
        ) as DriftRefreshReport;
        expect(report).toMatchObject({ before: "red", after: "red" });
        expect(report.views).toEqual([
          {
            view: "mTransactions2",
            outcome: "red",
            removed: ["$.transactions"],
            reason: "list_absent",
          },
        ]);
      } else {
        expect(io.out.text).toContain(
          "mTransactions2: still red — ESPN answered without the list (read as none)",
        );
        expect(io.out.text).not.toContain("has every key");
      }
      sb.cleanup();
    }
    sb = sandbox();
  });

  it("re-reads the job's recorded period first: its moves show the key, and the row clears", async () => {
    sb = sandbox();
    plantCookies();
    updateJobState(sb.cacheDir, { "transactions.season": 2026, "transactions.period": 8 });
    await withStore((s) => {
      s.repos.driftState.put(liveRedRow());
    });
    const f = scriptedLeague((p) =>
      p === 8
        ? jsonRes({ ...bareBase(), transactions: [tx(1, 8, "2026-11-02T18:00:00.000Z")] })
        : jsonRes(bareBase()),
    );
    const { code, io } = await refresh(f, true);
    expect(code, io.err.text).toBe(0);
    const report = JSON.parse(io.out.text.trim().split("\n").pop() ?? "{}") as DriftRefreshReport;
    expect(report).toMatchObject({ before: "red", after: "additive" });
    expect(report.views).toEqual([
      { view: "mTransactions2", outcome: "cleared", removed: [], reason: null },
    ]);
    expect(
      f.urls
        .filter((u) => u.includes("view=mTransactions2"))
        .map((u) => new URL(u).searchParams.get("scoringPeriodId")),
    ).toEqual(["8", "9"]);
  });

  it("another season's recorded period is not read", async () => {
    sb = sandbox();
    plantCookies();
    updateJobState(sb.cacheDir, { "transactions.season": 2025, "transactions.period": 8 });
    await withStore((s) => {
      s.repos.driftState.put(liveRedRow());
    });
    const f = scriptedLeague(() => jsonRes(bareBase()));
    await refresh(f, true);
    expect(
      f.urls
        .filter((u) => u.includes("view=mTransactions2"))
        .map((u) => new URL(u).searchParams.get("scoringPeriodId")),
    ).toEqual(["9"]);
  });
});
