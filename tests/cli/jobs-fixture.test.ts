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
import { readJobState, updateJobState } from "../../src/cli/job-state.js";
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
