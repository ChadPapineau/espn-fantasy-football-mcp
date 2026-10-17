// jobs-fixture.test.ts — the ESPN jobs' WORKING runs end to end (plan 06 §1.4; T-07, T-08) over an
// injected fetch that answers from the recorded, anonymised league-a fixtures (league id 0): the
// roster snapshot stores every team, diffs the user's team, runs the IR and golden checks; the
// pre-kickoff run stores the scoreboard; the pool, projections and transactions jobs store their
// rows; the pre-kickoff check judges the newest snapshot. No request leaves the process; the
// scoring period of a recording is served for the week a job asks (the fixture has weeks 1–4).
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildEspnStack } from "../../src/cli/espn-stack.js";
import { dayFirstKickoff, weekFirstKickoff } from "../../src/cli/espn-jobs.js";
import { checkHealthChecks } from "../../src/cli/doctor.js";
import { readJobState, updateJobState } from "../../src/cli/job-state.js";
import { call, connect, makeWorld, type World } from "../mcp/helpers/world.js";
import { loadRuntime } from "../../src/cli/runtime.js";
import {
  preKickoff,
  snapshotPool,
  snapshotProjections,
  snapshotRoster,
  transactionsAppend,
} from "../../src/cli/snapshot.js";
import { openStore } from "../../src/cli/store-access.js";
import type { ProSchedule } from "../../src/providers/platform.js";
import { composeBodies } from "../../src/providers/espn/index.js";
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

function merge(...bodies: Record<string, unknown>[]): unknown {
  // ESPN views compose additively (the provider's own fixture composer)
  return bodies.reduce<unknown>((acc, b) => (acc === null ? b : composeBodies(acc, b)), null);
}

/** The league-a stand-in: every view the jobs ask, keyless (a public league). */
function leagueA() {
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
      else if (v === "mMatchupScore") parts.push(rec("league-a/mMatchupScore.sp4.json"));
      else if (v === "mMatchup") parts.push(rec("league-a/mMatchup.json"));
      else if (v === "kona_player_info") parts.push(rec("league-a/kona_player_info.json"));
      else if (v === "mTransactions2")
        parts.push({ ...rec("league-a/mSettings.json"), transactions: [] });
      else return jsonRes({ messages: ["no fixture"] }, 404);
    }
    return jsonRes(merge(...parts));
  });
}

async function runtime(clockAt: string, extraEnv: Record<string, string> = {}) {
  const f = leagueA();
  const { exec, calls } = fakeExec();
  const io = makeIo(sb, {
    fetch: f.fetch,
    clock: movingClock(clockAt),
    platform: "darwin",
    exec,
    packageRoot: fakePackage(sb),
    env: { ESPN_LEAGUE_ID: "0", EFF_CREDENTIAL_STORE: "file", ESPN_SEASON: "2026", ...extraEnv },
  });
  const { config, log } = await loadRuntime(io);
  return { io, config, log, f, calls };
}

async function schedule(): Promise<ProSchedule> {
  const { io, config, log } = await runtime("2026-10-06T18:00:00.000Z");
  const store = openStore(config, io.clock, log, { migrate: true });
  const stack = buildEspnStack(io, config, store, log, { origin: "server", observer: "server" });
  try {
    return (await stack.provider.getProSchedule(2026)).value;
  } finally {
    stack.close();
    store.close();
  }
}

describe("working runs over the recorded league", () => {
  it("snapshot roster (nightly): every team stored, the golden check counted once per week, cookie-free", async () => {
    sb = sandbox();
    const { io, config, log, f } = await runtime("2026-10-06T18:00:00.000Z", { ESPN_TEAM_ID: "1" });
    const code = await snapshotRoster(io, config, log, { notify: true, preKickoff: false });
    expect(
      io.err.text
        .split("\n")
        .filter((l) => l.startsWith("eff "))
        .join("\n"),
    ).toBe("");
    expect(code).toBe(0);
    expect(io.out.text).toMatch(/snapshot-roster: \d+ roster\(s\) stored for week \d+/);
    const store = openStore(config, io.clock, log, { migrate: false });
    expect(store.repos.rosterSnapshots.latestTwo(1).length).toBe(1);
    store.close();
    expect(typeof readJobState(config.cacheDir)["golden.week"]).toBe("number");
    for (const init of f.inits) expect(new Headers(init.headers).has("cookie")).toBe(false);
    // a second nightly run diffs against the first (no change → no notification)
    const again = await runtime("2026-10-07T18:00:00.000Z", { ESPN_TEAM_ID: "1" });
    expect(
      await snapshotRoster(again.io, again.config, again.log, { notify: true, preKickoff: false }),
    ).toBe(0);
    expect(
      again.calls.filter((c) => (c.args[1] ?? "").includes("Your roster changed")),
    ).toHaveLength(0);
  });
  it("snapshot roster --pre-kickoff in its working run stores the scoreboard snapshot", async () => {
    sb = sandbox();
    const s = await schedule();
    const first = weekFirstKickoff(s, Date.parse("2026-10-06T18:00:00Z"));
    expect(first).not.toBeNull();
    const at = new Date((first?.at ?? 0) - 30 * 60_000 - 20 * 60_000).toISOString();
    const { io, config, log } = await runtime(at);
    expect(await snapshotRoster(io, config, log, { notify: false, preKickoff: true })).toBe(0);
    expect(io.out.text).toContain("scoreboard snapshot stored");
    const store = openStore(config, io.clock, log, { migrate: false });
    expect(
      store.repos.scoreboardSnapshots.forWeek(Number(/week (\d+)/.exec(io.out.text)?.[1] ?? 0))
        .length,
    ).toBe(1);
    store.close();
  });
  it("snapshot pool after waivers, projections, transactions after the pool run, the pre-kickoff check", async () => {
    sb = sandbox();
    const now = "2026-10-07T18:00:00.000Z";
    updateJobState(sb.cacheDir, { "pool.anchor": Date.parse(now) - 2 * 3_600_000 });
    const pool = await runtime(now);
    const pc = await snapshotPool(pool.io, pool.config, pool.log, { notify: true });
    expect(pc).toBe(0);
    expect(pool.io.out.text).toMatch(/snapshot-pool: \d+ pool player\(s\) stored .*\(waivers\)/);
    const state = readJobState(pool.config.cacheDir);
    expect(state["pool.worked"]).toBe(Date.parse(now) - 2 * 3_600_000);
    // each run starts later than the previous one's limiter rows (one clock per process, as in life)
    const proj = await runtime("2026-10-07T18:10:00.000Z", { ESPN_TEAM_ID: "1" });
    const prc = await snapshotProjections(proj.io, proj.config, proj.log, { notify: false });
    expect(prc).toBe(0);
    expect(proj.io.out.text).toMatch(/ESPN projection row\(s\) stored/);
    const tx = await runtime("2026-10-07T19:00:00.000Z");
    const txc = await transactionsAppend(tx.io, tx.config, tx.log, { notify: false, force: false });
    expect(txc).toBe(0);
    // mTransactions2 always needs cookies; with none stored the job says so and sends nothing more
    expect(tx.io.out.text).toContain("needs cookies and none are stored");
    // the pre-kickoff check, 61 min before a game day's first kickoff, over the newest snapshot
    const s = await schedule();
    const sunday = s.games
      .map((g) => (g.kickoff === null || g.start_time_tbd ? null : Date.parse(g.kickoff)))
      .filter((k): k is number => k !== null && k > Date.parse(now))
      .sort((a, b) => a - b)
      .find((k) => dayFirstKickoff(s, k) === k);
    expect(sunday).toBeDefined();
    const roster = await runtime(new Date((sunday ?? 0) - 3 * 3_600_000).toISOString(), {
      ESPN_TEAM_ID: "1",
    });
    expect(
      await snapshotRoster(roster.io, roster.config, roster.log, {
        notify: false,
        preKickoff: false,
      }),
    ).toBe(0);
    const pk = await runtime(new Date((sunday ?? 0) - 61 * 60_000 - 30_000).toISOString(), {
      ESPN_TEAM_ID: "1",
    });
    expect(await preKickoff(pk.io, pk.config, pk.log, { notify: true })).toBe(0);
    expect(pk.io.out.text).toMatch(/Before kickoff|no problems found/);
  });
});

describe("snapshot pool over launchd's hourly wakes (plan 06 §1.4, ADV OBJ-16)", () => {
  it("each waiver run gets its working run 1 h later; the anchor is kept until that run fires", async () => {
    sb = sandbox();
    // league-a's waivers process on Thu and Sun (waiverNextExecutionDate 2026-10-08T16:00Z): the
    // hourly wakes from Thu 10:00Z to Sun 19:00Z, a fresh process (and clock) per wake
    const start = Date.parse("2026-10-08T10:00:00.000Z");
    const worked: string[] = [];
    for (let h = 0; h <= 81; h++) {
      const at = new Date(start + h * 3_600_000).toISOString();
      const r = await runtime(at);
      expect(await snapshotPool(r.io, r.config, r.log, { notify: false })).toBe(0);
      if (r.io.out.text.includes("(waivers)")) worked.push(at);
    }
    expect(worked).toEqual(["2026-10-08T17:00:00.000Z", "2026-10-11T17:00:00.000Z"]);
  }, 60_000);
});

describe("the nightly IR-validity check: a fixed IR closes the check, a new healthy player in IR is a new alert (plan 06 §1.4, T-08; plan 03 §5 #23)", () => {
  /** league-a with team 1's IR-slot (21) player in `status` this night. */
  function leagueWithIr(status: string) {
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
          const a = rec("league-a/mRoster.sp3.p1.json") as { teams: Record<string, unknown>[] };
          const b = rec("league-a/mRoster.sp3.p2.json") as { teams: Record<string, unknown>[] };
          for (const t of a.teams as {
            id: number;
            roster: {
              entries: {
                lineupSlotId: number;
                playerPoolEntry: { player: { injuryStatus: string; injured: boolean } };
              }[];
            };
          }[])
            if (t.id === 1)
              for (const e of t.roster.entries)
                if (e.lineupSlotId === 21) {
                  e.playerPoolEntry.player.injuryStatus = status;
                  e.playerPoolEntry.player.injured = status !== "ACTIVE";
                }
          parts.push({ ...a, teams: [...a.teams, ...b.teams] });
        } else if (v === "mBoxscore") parts.push(rec("league-a/mBoxscore.sp3.json"));
        else return jsonRes({ messages: ["no fixture"] }, 404);
      }
      return jsonRes(merge(...parts));
    });
  }

  /** One nightly run; `cacheDir` puts the store elsewhere (an MCP world's, to read it as Claude does). */
  async function night(at: string, status: string, cacheDir?: string) {
    const f = leagueWithIr(status);
    const { exec, calls } = fakeExec();
    const io = makeIo(sb, {
      fetch: f.fetch,
      clock: movingClock(at),
      platform: "darwin",
      exec,
      packageRoot: fakePackage(sb),
      env: {
        ESPN_LEAGUE_ID: "0",
        EFF_CREDENTIAL_STORE: "file",
        ESPN_SEASON: "2026",
        ESPN_TEAM_ID: "1",
        ...(cacheDir === undefined ? {} : { EFF_CACHE_DIR: cacheDir }),
      },
    });
    const { config, log } = await loadRuntime(io);
    expect(await snapshotRoster(io, config, log, { notify: true, preKickoff: false })).toBe(0);
    const notified = calls.some((c) => c.args.join(" ").includes("IR slot holds"));
    const line = io.out.text.split("\n").some((l) => l.startsWith("IR invalid"));
    // doctor #23 exactly as `eff doctor` computes it, and the open rows themselves
    const store = openStore(config, io.clock, log, { migrate: false });
    let row23;
    let open;
    try {
      row23 = checkHealthChecks(store).find((r) => r.id === "ir_invalid");
      open = store.repos.leagueSettings.openChecks().filter((c) => c.id === "ir_invalid").length;
    } finally {
      store.close();
    }
    return { notified, line, text: io.out.text, doctor23: row23?.status, open };
  }

  it("healthy-in-IR → alert; fixed → the check closed; healthy-in-IR again → a new check, alerted again", async () => {
    sb = sandbox();
    const n1 = await night("2026-10-06T06:00:00.000Z", "ACTIVE");
    expect([n1.line, n1.notified, n1.doctor23, n1.open]).toEqual([true, true, "fail", 1]);
    const n2 = await night("2026-10-07T06:00:00.000Z", "INJURY_RESERVE");
    expect([n2.line, n2.notified]).toEqual([false, false]);
    expect(n2.text).toContain("IR valid again — 1 ir_invalid check(s) closed");
    // the fixed IR closes the row itself: nothing is left open for doctor #23 to describe
    expect([n2.doctor23, n2.open]).toEqual(["ok", 0]);
    const n3 = await night("2026-10-08T06:00:00.000Z", "ACTIVE");
    expect([n3.line, n3.notified, n3.doctor23, n3.open]).toEqual([true, true, "fail", 1]);
    // a night that stays invalid does not repeat the alert or the row
    const n4 = await night("2026-10-09T06:00:00.000Z", "ACTIVE");
    expect([n4.line, n4.notified, n4.doctor23, n4.open]).toEqual([false, false, "fail", 1]);
    // a valid night with no open check closes nothing and says nothing
    const n5 = await night("2026-10-10T06:00:00.000Z", "INJURY_RESERVE");
    expect(n5.text).toContain("IR valid again — 1 ir_invalid check(s) closed");
    const n6 = await night("2026-10-11T06:00:00.000Z", "INJURY_RESERVE");
    expect(n6.text).not.toContain("IR valid again");
    expect([n6.line, n6.notified, n6.doctor23, n6.open]).toEqual([false, false, "ok", 0]);
  });

  it("espn_get_status's checks[] — what the Skills read first — follows the nightly IR state", async () => {
    sb = sandbox();
    const world: World = await makeWorld({ publishEspn: false });
    const { client, close } = await connect(world);
    try {
      const irRows = async () => {
        const r = await call(client, "espn_get_status", { include_checks: true });
        expect(r.isError).toBe(false);
        const checks = (r.body.data as { checks: { id: string; status: string }[] }).checks;
        return checks.filter((c) => c.id === "ir_invalid").map((c) => c.status);
      };
      await night("2026-10-06T06:00:00.000Z", "ACTIVE", world.cache);
      expect(await irRows()).toEqual(["fail"]);
      await night("2026-10-07T06:00:00.000Z", "INJURY_RESERVE", world.cache);
      expect(await irRows()).toEqual([]);
      await night("2026-10-08T06:00:00.000Z", "ACTIVE", world.cache);
      expect(await irRows()).toEqual(["fail"]);
    } finally {
      await close();
      world.cleanup();
    }
  }, 60_000);
});
