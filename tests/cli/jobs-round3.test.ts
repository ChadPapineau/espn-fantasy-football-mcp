// jobs-round3.test.ts — the ESPN-credentialed jobs and the refreshes over an injected fetch serving
// the recorded, anonymised league-a (league id 0; plan 06 §1.3, §1.4, §2). Stage C findings:
//  - cli-snapshot-manual-charged-job-cap: a snapshot typed at a terminal was charged to the launchd
//    fleet's daily caps (the server's own hint tells the owner to run one);
//  - cli-backfill-no-cookie-exit-zero: `eff transactions --backfill` with no cookie on a private
//    league exited 0, recorded a successful run and claimed "fits its premium from them";
//  - jobs-transactions-period-rollover-gap: `eff transactions` read only the current scoring period,
//    so each week's last moves were never stored and nothing noticed;
//  - jobs-pool-anchor-cached-past-execution: after a working run the anchor refresh read the cached,
//    pre-execution settings, saw a passed waiverNextExecutionDate and fell back to the ET hour while
//    ESPN served the field; doctor #11 then said the field was absent;
//  - notify-text-not-recorded: no notification text was kept, so `eff status` — which the
//    notifications point to — could not show what was said;
//  - refresh-gameday-cadence-local-calendar: on a Mac outside US-Eastern the game-day cadence used the
//    local calendar while the TTLs judge the Eastern one.
// No request leaves the process; cookies are placeholders in a 0600 file store.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionFileBody } from "../../src/auth/file.js";
import { metaFor } from "../../src/auth/upgrade.js";
import { checkLaunchd } from "../../src/cli/doctor.js";
import {
  readJobState,
  readNotifications,
  recordNotification,
  updateJobState,
  NOTIFICATION_LOG_MAX,
} from "../../src/cli/job-state.js";
import { JOBS } from "../../src/cli/launchd.js";
import { main } from "../../src/cli/main.js";
import { createNotifier } from "../../src/cli/notify.js";
import { gameDayCadenceWorks } from "../../src/cli/refresh.js";
import { loadRuntime } from "../../src/cli/runtime.js";
import {
  snapshotPool,
  snapshotProjections,
  snapshotRoster,
  transactionPeriods,
  transactionsAppend,
} from "../../src/cli/snapshot.js";
import { collectStatus, renderStatus } from "../../src/cli/status.js";
import { openStore } from "../../src/cli/store-access.js";
import { ttlContextAt } from "../../src/config/freshness.js";
import { composeBodies } from "../../src/providers/espn/index.js";
import { utcDayStart } from "../../src/providers/espn/limiter.js";
import type { ProScheduleReader } from "../../src/domain/analytics/types.js";
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
const rec = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(REC, rel), "utf8")) as Record<string, unknown>;
const jsonRes = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const merge = (...bodies: Record<string, unknown>[]): unknown =>
  bodies.reduce<unknown>((acc, b) => (acc === null ? b : composeBodies(acc, b)), null);
const COOKIES = fakeCookies("cli-jobs-round3");

/** league-a, every view the jobs ask, keyless; `over` rewrites a settings answer (merged) per request. */
function leagueA(over: (settings: Record<string, unknown>) => Record<string, unknown> = (s) => s) {
  return fakeFetch((url) => {
    const u = new URL(url);
    const views = u.searchParams.getAll("view");
    if (views.includes("proTeamSchedules_wl"))
      return jsonRes(rec("season/proTeamSchedules_wl.json"));
    if (!u.pathname.includes("/leagues/0")) return new Response(null, { status: 404 });
    const parts: Record<string, unknown>[] = [];
    for (const v of views) {
      if (v === "mSettings") parts.push(rec("league-a/mSettings.json"));
      else if (v === "mNav") parts.push(rec("league-a/mNav.json"));
      else if (v === "mTeam" || v === "mStandings") parts.push(rec("league-a/mTeam.json"));
      else if (v === "mRoster") {
        const a = rec("league-a/mRoster.sp3.p1.json");
        const b = rec("league-a/mRoster.sp3.p2.json");
        parts.push({ ...a, teams: [...(a.teams as unknown[]), ...(b.teams as unknown[])] });
      } else if (v === "mBoxscore") parts.push(rec("league-a/mBoxscore.sp3.json"));
      else if (v === "kona_player_info") parts.push(rec("league-a/kona_player_info.json"));
      else return jsonRes({ messages: ["no fixture"] }, 404);
    }
    const body = merge(...parts) as Record<string, unknown>;
    return jsonRes(views.includes("mSettings") ? over(body) : body);
  });
}

async function runtime(
  at: string,
  f: ReturnType<typeof fakeFetch>,
  extra: Record<string, string> = {},
) {
  const { exec, calls } = fakeExec();
  const io = makeIo(sb, {
    fetch: f.fetch,
    clock: movingClock(at),
    platform: "darwin",
    exec,
    packageRoot: fakePackage(sb),
    env: { ESPN_LEAGUE_ID: "0", EFF_CREDENTIAL_STORE: "file", ESPN_SEASON: "2026", ...extra },
  });
  const { config, log } = await loadRuntime(io);
  return { io, config, log, calls };
}

function plantCookies(): void {
  mkdirSync(sb.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(sb.configDir, "session.json"),
    sessionFileBody(COOKIES, metaFor(COOKIES, "2026-10-01T00:00:00.000Z")),
    { mode: 0o600 },
  );
}

/** Today's limiter counts, read from the store (server vs job, cookie vs keyless). */
async function countsAt(at: string) {
  const { io, config, log } = await runtime(at, leagueA());
  const store = openStore(config, io.clock, log, { migrate: true });
  try {
    return store.repos.limiter.countToday(new Date(utcDayStart(io.clock.nowMs())).toISOString());
  } finally {
    store.close();
  }
}

describe("a job typed at a terminal is the owner's, never the fleet's cap (cli-snapshot-manual-charged-job-cap)", () => {
  it("snapshot roster and projections without --notify are charged as server; with it (launchd) as job", async () => {
    sb = sandbox();
    const hand = await runtime("2026-10-06T18:00:00.000Z", leagueA(), { ESPN_TEAM_ID: "1" });
    expect(
      await snapshotRoster(hand.io, hand.config, hand.log, { notify: false, preKickoff: false }),
    ).toBe(0);
    const hand2 = await runtime("2026-10-06T18:20:00.000Z", leagueA(), { ESPN_TEAM_ID: "1" });
    expect(await snapshotProjections(hand2.io, hand2.config, hand2.log, { notify: false })).toBe(0);
    const c = await countsAt("2026-10-06T18:40:00.000Z");
    expect(c.job).toEqual({ cookie: 0, keyless: 0 });
    expect(c.server.keyless).toBeGreaterThan(0);
    const launchd = await runtime("2026-10-06T19:00:00.000Z", leagueA(), { ESPN_TEAM_ID: "1" });
    expect(
      await snapshotProjections(launchd.io, launchd.config, launchd.log, { notify: true }),
    ).toBe(0);
    expect((await countsAt("2026-10-06T19:20:00.000Z")).job.keyless).toBeGreaterThan(0);
  });

  it("every launchd job that reads ESPN with cookies carries --notify, the launchd mark", () => {
    for (const j of JOBS.filter((x) => x.cookies)) expect(j.argv, j.name).toContain("--notify");
  });
});

/** A private league: every keyless league read answers ESPN's 401. */
function privateLeague() {
  return fakeFetch((url) => {
    const u = new URL(url);
    if (u.searchParams.getAll("view").includes("proTeamSchedules_wl"))
      return jsonRes(rec("season/proTeamSchedules_wl.json"));
    if (u.pathname.includes("/leagues/0"))
      return jsonRes(rec("errors/401-communication-not-visible.json"), 401);
    return new Response(null, { status: 404 });
  });
}

describe("no cookie on a private league, typed by hand, is exit 3 (cli-backfill-no-cookie-exit-zero)", () => {
  it("transactions --backfill --seasons: exit 3, the eff setup line, no claim, no successful run recorded", async () => {
    sb = sandbox();
    const f = privateLeague();
    const io = makeIo(sb, {
      fetch: f.fetch,
      clock: movingClock("2026-10-06T18:00:00.000Z"),
      packageRoot: fakePackage(sb),
      env: { ESPN_LEAGUE_ID: "0", EFF_CREDENTIAL_STORE: "file", ESPN_SEASON: "2026" },
    });
    expect(await main(["transactions", "--backfill", "--seasons", "2024,2025"], io)).toBe(3);
    expect(io.out.text).toContain("run `eff setup`");
    expect(io.out.text).not.toContain("fits its premium");
    expect(io.out.text).not.toContain("not served");
    expect(readJobState(sb.cacheDir)["run.transactions-backfill.ok"]).not.toBe(1);
    const io2 = makeIo(sb, {
      fetch: f.fetch,
      clock: movingClock("2026-10-06T18:10:00.000Z"),
      packageRoot: fakePackage(sb),
      env: { ESPN_LEAGUE_ID: "0", EFF_CREDENTIAL_STORE: "file", ESPN_SEASON: "2026" },
    });
    expect(await main(["transactions", "--backfill"], io2)).toBe(3);
    expect(io2.out.text).toContain("needs cookies and none are stored");
  });

  it("the launchd rule is unchanged: snapshot roster --notify stays quiet (exit 0); typed by hand it is 3", async () => {
    sb = sandbox();
    const l = await runtime("2026-10-06T18:00:00.000Z", privateLeague());
    expect(await snapshotRoster(l.io, l.config, l.log, { notify: true, preKickoff: false })).toBe(
      0,
    );
    const h = await runtime("2026-10-06T18:10:00.000Z", privateLeague());
    expect(await snapshotRoster(h.io, h.config, h.log, { notify: false, preKickoff: false })).toBe(
      3,
    );
  });

  it("seasons ESPN does not serve: said, nothing claimed, no worked run", async () => {
    sb = sandbox();
    plantCookies();
    const f = fakeFetch((url) => {
      const u = new URL(url);
      if (u.pathname.includes("/leagues/0"))
        return jsonRes(rec("errors/404-league-not-found.json"), 404);
      return new Response(null, { status: 404 });
    });
    const io = makeIo(sb, {
      fetch: f.fetch,
      clock: movingClock("2026-10-06T18:00:00.000Z"),
      packageRoot: fakePackage(sb),
      env: { ESPN_LEAGUE_ID: "0", EFF_CREDENTIAL_STORE: "file", ESPN_SEASON: "2026" },
    });
    expect(await main(["transactions", "--backfill", "--seasons", "2024,2025"], io)).toBe(0);
    expect(io.out.text).toContain("season 2024: not served");
    expect(io.out.text).toContain("no season could be read — nothing stored");
    expect(io.out.text).not.toContain("fits its premium");
    expect(readJobState(sb.cacheDir)["run.transactions-backfill.ok"]).toBeUndefined();
  });
});

const txId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function tx(n: number, period: number, at: string, type = "WAIVER") {
  return {
    id: txId(n),
    type,
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
        playerId: 1000 + n,
        fromTeamId: 0,
        toTeamId: 1,
        fromLineupSlotId: -1,
        toLineupSlotId: 20,
        isKeeper: false,
      },
    ],
  };
}

describe("`eff transactions` reads the rollover's last moves (jobs-transactions-period-rollover-gap)", () => {
  it("a move made in week 8 after the last week-8 read is stored by the next run, after the period rolled", async () => {
    sb = sandbox();
    plantCookies();
    const state = { period: 8, byPeriod: new Map<number, unknown[]>() };
    state.byPeriod.set(8, [tx(1, 8, "2026-11-02T08:00:00.000Z")]);
    const f = fakeFetch((url) => {
      const u = new URL(url);
      if (u.searchParams.getAll("view").includes("proTeamSchedules_wl"))
        return jsonRes(rec("season/proTeamSchedules_wl.json"));
      if (!u.pathname.includes("/leagues/0")) return new Response(null, { status: 404 });
      const settings = { ...rec("league-a/mSettings.json"), scoringPeriodId: state.period };
      const views = u.searchParams.getAll("view");
      if (views.includes("mTransactions2")) {
        const p = Number(u.searchParams.get("scoringPeriodId") ?? "0");
        return jsonRes({
          ...settings,
          scoringPeriodId: p,
          transactions: state.byPeriod.get(p) ?? [],
        });
      }
      let body: unknown = settings;
      if (views.includes("mNav")) body = composeBodies(body, rec("league-a/mNav.json"));
      if (views.includes("mTeam")) body = composeBodies(body, rec("league-a/mTeam.json"));
      return jsonRes(body);
    });
    const r1 = await runtime("2026-11-02T09:30:00.000Z", f);
    expect(await transactionsAppend(r1.io, r1.config, r1.log, { notify: true, force: true })).toBe(
      0,
    );
    // Monday 18:00Z: a free-agent add in week 8; then ESPN rolls to week 9 and a claim lands there
    state.byPeriod.set(8, [
      tx(1, 8, "2026-11-02T08:00:00.000Z"),
      tx(2, 8, "2026-11-02T18:00:00.000Z", "FREEAGENT"),
    ]);
    state.byPeriod.set(9, [tx(3, 9, "2026-11-04T08:00:00.000Z")]);
    state.period = 9;
    const before = f.urls.length;
    const r2 = await runtime("2026-11-04T09:30:00.000Z", f);
    expect(await transactionsAppend(r2.io, r2.config, r2.log, { notify: true, force: true })).toBe(
      0,
    );
    const asked = f.urls
      .slice(before)
      .filter((u) => u.includes("mTransactions2"))
      .map((u) => new URL(u).searchParams.get("scoringPeriodId"));
    expect(asked).toEqual(["8", "9"]);
    expect(r2.io.out.text).toContain("appended (weeks 8, 9)");
    const store = openStore(r2.config, r2.io.clock, r2.log, { migrate: false });
    try {
      // the claim of run 1, the week-8 add made after it, the week-9 claim: three distinct rows
      // (ids are stored pseudonymised, never as ESPN sent them)
      const ids = new Set(
        store.repos.transactionsSeen.list(null, 100).map((t) => t.transaction_id),
      );
      expect(ids.size).toBe(3);
    } finally {
      store.close();
    }
    expect(readJobState(sb.cacheDir)).toMatchObject({
      "transactions.period": 9,
      "transactions.season": 2026,
    });
  });

  it("which periods a run reads: the last one again through the current, at most four; an older span is the gap, said", () => {
    const st = (season: number, period: number) => ({
      "transactions.season": season,
      "transactions.period": period,
    });
    expect(transactionPeriods({}, 2026, 1, 9)).toEqual({ read: [9], gap: null });
    expect(transactionPeriods(st(2026, 9), 2026, 1, 9)).toEqual({ read: [9], gap: null });
    expect(transactionPeriods(st(2026, 8), 2026, 1, 9)).toEqual({ read: [8, 9], gap: null });
    expect(transactionPeriods(st(2026, 2), 2026, 1, 9)).toEqual({
      read: [6, 7, 8, 9],
      gap: { from: 2, to: 5 },
    });
    // another season, or a recorded period ahead of ESPN's: the current period alone
    expect(transactionPeriods(st(2025, 17), 2026, 1, 1)).toEqual({ read: [1], gap: null });
    expect(transactionPeriods(st(2026, 12), 2026, 1, 9)).toEqual({ read: [9], gap: null });
    expect(transactionPeriods(st(2026, 0), 2026, 1, 3)).toEqual({ read: [1, 2, 3], gap: null });
  });

  it("a gap is warned on stdout and in the log", async () => {
    sb = sandbox();
    plantCookies();
    const f = fakeFetch((url) => {
      const u = new URL(url);
      if (!u.pathname.includes("/leagues/0"))
        return jsonRes(rec("season/proTeamSchedules_wl.json"));
      const settings = { ...rec("league-a/mSettings.json"), scoringPeriodId: 9 };
      if (u.searchParams.getAll("view").includes("mTransactions2"))
        return jsonRes({ ...settings, transactions: [] });
      return jsonRes(merge(settings, rec("league-a/mNav.json")));
    });
    updateJobState(sb.cacheDir, { "transactions.season": 2026, "transactions.period": 2 });
    const r = await runtime("2026-11-04T09:30:00.000Z", f);
    expect(await transactionsAppend(r.io, r.config, r.log, { notify: true, force: true })).toBe(0);
    expect(r.io.out.text).toContain("warning: scoring period(s) 2–5 were not read");
    expect(r.io.err.text).toContain('"event":"transactions.gap"');
  });
});

describe("the pool's waiver anchor after a working run (jobs-pool-anchor-cached-past-execution)", () => {
  it("one working run per waiver run, 1 h after it, while ESPN states the next execution; doctor #11 warns of the ET disagreement, never 'absent'", async () => {
    sb = sandbox();
    // ESPN states the next execution after the moment it answers: Thu 16:00Z, Sun 16:00Z, Thu …
    const runs = [
      "2026-10-08T16:00:00.000Z",
      "2026-10-11T16:00:00.000Z",
      "2026-10-15T16:00:00.000Z",
    ].map(Date.parse);
    let wake = 0;
    const settingsFetches: number[] = [];
    const f = leagueA((s) => {
      settingsFetches.push(wake);
      const next = runs.find((t) => t > wake) ?? runs[runs.length - 1]!;
      const status = { ...(s.status as Record<string, unknown>), waiverNextExecutionDate: next };
      const settings = s.settings as Record<string, unknown>;
      const acq = {
        ...(settings.acquisitionSettings as Record<string, unknown>),
        waiverProcessHour: 3,
      };
      return { ...s, status, settings: { ...settings, acquisitionSettings: acq } };
    });
    const start = Date.parse("2026-10-08T10:00:00.000Z");
    const worked: string[] = [];
    let last: Awaited<ReturnType<typeof runtime>> | null = null;
    for (let h = 0; h <= 81; h++) {
      wake = start + h * 3_600_000;
      const r = await runtime(new Date(wake).toISOString(), f);
      expect(await snapshotPool(r.io, r.config, r.log, { notify: false })).toBe(0);
      if (r.io.out.text.includes("(waivers)")) worked.push(new Date(wake).toISOString());
      last = r;
    }
    expect(worked).toEqual(["2026-10-08T17:00:00.000Z", "2026-10-11T17:00:00.000Z"]);
    const st = readJobState(sb.cacheDir);
    expect(st).toMatchObject({
      "pool.anchor": runs[2],
      "pool.anchor_basis": "status",
      "pool.anchor_field": "served",
      "pool.anchor_et": "disagrees",
    });
    const row = await checkLaunchd(
      makeIo(sb, { platform: "darwin", exec: fakeExec().exec }),
      last!.config,
      null,
    );
    expect(row.details.join("\n")).toContain("disagrees with waiverProcessHour read as ET");
    expect(row.details.join("\n")).not.toContain("is absent");
  }, 120_000);

  it("a league whose hour agrees: no warning; a league without the field: 'absent' is said", async () => {
    sb = sandbox();
    const f = leagueA();
    const r = await runtime("2026-10-08T10:00:00.000Z", f);
    expect(await snapshotPool(r.io, r.config, r.log, { notify: false })).toBe(0);
    expect(readJobState(sb.cacheDir)).toMatchObject({
      "pool.anchor_basis": "status",
      "pool.anchor_et": "agrees",
    });
    let row = await checkLaunchd(
      makeIo(sb, { platform: "darwin", exec: fakeExec().exec }),
      r.config,
      null,
    );
    expect(row.details.join("\n")).not.toMatch(/waiverNextExecutionDate/);
    // the field gone: the ET hour is the fallback, said as absent
    updateJobState(sb.cacheDir, { "pool.anchor": null });
    const g = leagueA((s) => {
      const status = { ...(s.status as Record<string, unknown>) };
      delete status.waiverNextExecutionDate;
      return { ...s, status };
    });
    const r2 = await runtime("2026-10-09T10:00:00.000Z", g);
    // the cached body states a passed instant: read fresh, and the field is gone
    expect(await snapshotPool(r2.io, r2.config, r2.log, { notify: false })).toBe(0);
    expect(readJobState(sb.cacheDir)).toMatchObject({
      "pool.anchor_basis": "process_days_et",
      "pool.anchor_field": "absent",
    });
    row = await checkLaunchd(
      makeIo(sb, { platform: "darwin", exec: fakeExec().exec }),
      r2.config,
      null,
    );
    expect(row.details.join("\n")).toContain("waiverNextExecutionDate is absent");
  });
});

describe("what the notifications said is kept, and shown by eff status (notify-text-not-recorded)", () => {
  it("a roster-change alert is in eff status's notifications, with its text", async () => {
    sb = sandbox();
    // two nightly runs; the second sees team 1's roster changed (another recorded week)
    const f1 = leagueA();
    const n1 = await runtime("2026-10-06T06:00:00.000Z", f1, { ESPN_TEAM_ID: "1" });
    expect(
      await snapshotRoster(n1.io, n1.config, n1.log, { notify: true, preKickoff: false }),
    ).toBe(0);
    const f2 = fakeFetch((url) => {
      const u = new URL(url);
      if (u.searchParams.getAll("view").includes("mRoster")) {
        const a = rec("league-a/mRoster.sp2.p1.json");
        const b = rec("league-a/mRoster.sp2.p2.json");
        return jsonRes(
          merge(rec("league-a/mSettings.json"), {
            ...a,
            teams: [...(a.teams as unknown[]), ...(b.teams as unknown[])],
          }),
        );
      }
      return f1.fetch(url, {});
    });
    const n2 = await runtime("2026-10-07T06:00:00.000Z", f2, { ESPN_TEAM_ID: "1" });
    expect(
      await snapshotRoster(n2.io, n2.config, n2.log, { notify: true, preKickoff: false }),
    ).toBe(0);
    const said = n2.calls.find((c) => c.args.join(" ").includes("Your roster changed"));
    expect(said).toBeDefined();
    const logged = readNotifications(sb.cacheDir);
    expect(logged[0]).toMatchObject({ kind: "info", shown: "shown" });
    expect(logged[0]?.text).toMatch(/^Your roster changed since the last snapshot: /);
    const report = collectStatus(n2.io, n2.config, n2.log);
    expect(report.notifications[0]?.text).toBe(logged[0]?.text);
    expect(renderStatus(report).join("\n")).toMatch(
      /notifications \(newest first[\s\S]*Your roster changed/,
    );
  });

  it("an alarm a platform cannot show is kept as not shown; a rate-limited failure is not said, not kept", async () => {
    sb = sandbox({ create: true });
    const clock = movingClock("2026-10-06T06:00:00.000Z");
    const linux = createNotifier({
      platform: "linux",
      exec: fakeExec().exec,
      clock,
      cacheDir: sb.cacheDir,
    });
    expect(await linux.alarm("ESPN drift: mSettings: removed $.settings.x")).toBe("unsupported");
    expect(readNotifications(sb.cacheDir)[0]).toMatchObject({ kind: "alarm", shown: "not_shown" });
    const mac = createNotifier({
      platform: "darwin",
      exec: fakeExec().exec,
      clock,
      cacheDir: sb.cacheDir,
    });
    expect(await mac.failure("snapshot-pool", "ESPN_UPSTREAM_UNAVAILABLE")).toBe("shown");
    expect(await mac.failure("snapshot-pool", "ESPN_UPSTREAM_UNAVAILABLE")).toBe("rate_limited");
    expect(readNotifications(sb.cacheDir).filter((n) => n.kind === "failure")).toHaveLength(1);
    // the text is the one sent: redacted, control-free (a GUID never reaches the log)
    await mac.info(`x {00000000-0000-4000-8000-000000000001}\u0007 y`);
    expect(readNotifications(sb.cacheDir)[0]?.text).not.toContain("00000000-0000-4000-8000");
    expect(readNotifications(sb.cacheDir)[0]?.text).not.toMatch(/\p{Cc}/u);
  });

  it("the log keeps the newest NOTIFICATION_LOG_MAX; a malformed file or entry reads as nothing", () => {
    sb = sandbox({ create: true });
    for (let i = 0; i < NOTIFICATION_LOG_MAX + 5; i++)
      recordNotification(sb.cacheDir, {
        at: new Date(Date.UTC(2026, 9, 6, 0, i)).toISOString(),
        kind: "info",
        text: `n${String(i)}`,
        shown: "shown",
      });
    const all = readNotifications(sb.cacheDir);
    expect(all).toHaveLength(NOTIFICATION_LOG_MAX);
    expect(all[0]?.text).toBe(`n${String(NOTIFICATION_LOG_MAX + 4)}`);
    expect(
      recordNotification(sb.cacheDir, { at: "yesterday", kind: "info", text: "x", shown: "shown" }),
    ).toBe(false);
    expect(
      recordNotification(sb.cacheDir, {
        at: "2026-10-06T00:00:00.000Z",
        kind: "info",
        text: "a\u0000b",
        shown: "shown",
      }),
    ).toBe(false);
    writeFileSync(path.join(sb.cacheDir, "notifications.json"), "{", { mode: 0o600 });
    expect(readNotifications(sb.cacheDir)).toEqual([]);
    writeFileSync(
      path.join(sb.cacheDir, "notifications.json"),
      JSON.stringify({
        items: [
          { at: "2026-10-06T00:00:00.000Z", kind: "evil", text: "x", shown: "shown" },
          { at: "2026-10-06T00:00:00.000Z", kind: "info", text: "ok", shown: "shown" },
        ],
      }),
      { mode: 0o600 },
    );
    expect(readNotifications(sb.cacheDir).map((n) => n.text)).toEqual(["ok"]);
  });
});

describe("the game-day cadence follows the Eastern calendar, as the TTLs do (refresh-gameday-cadence-local-calendar)", () => {
  it("on a Mac in Europe/Berlin, every wake of ET Thursday (a TNF game day) refreshes; the schedule never reads stale under its game-day TTL", () => {
    const tz = process.env.TZ;
    process.env.TZ = "Europe/Berlin";
    try {
      const games = (
        rec("season/proTeamSchedules_wl.json").settings as {
          proTeams: {
            id: number;
            proGamesByScoringPeriod?: Record<string, { date: number; homeProTeamId: number }[]>;
          }[];
        }
      ).proTeams.flatMap((t) =>
        Object.values(t.proGamesByScoringPeriod ?? {})
          .flat()
          .map((g) => ({ kickoff: new Date(g.date).toISOString() })),
      );
      const rows = [...new Map(games.map((g) => [g.kickoff, g])).values()].map((g) => ({
        ...g,
        start_time_tbd: false,
        valid_for_locking: true,
        stats_official: false,
        week: 0,
      }));
      const reader = {
        games: () => ({ rows, stamp: { version: "x" } }),
        teams: () => ({ rows: [], stamp: null }),
      } as unknown as ProScheduleReader;
      // the week-5 TNF kickoff (Thu 2026-10-08 ET; Fri 02:15 in Berlin)
      const tnf = Date.parse("2026-10-09T00:15:00.000Z");
      expect(rows.some((r) => Date.parse(r.kickoff) === tnf)).toBe(true);
      // every hourly wake of ET Thursday (04:00Z Thu → 04:00Z Fri) works
      const etThursday = Date.parse("2026-10-08T04:00:00.000Z");
      for (let h = 0; h < 24; h++) {
        const w = etThursday + h * 3_600_000;
        expect(gameDayCadenceWorks(reader, 2026, w), new Date(w).toISOString()).toBe(true);
        // and the TTL judges that same instant a game day (one definition)
        expect(ttlContextAt(rows, w).gameDay).toBe(true);
      }
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});
