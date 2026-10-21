// settings-changed-snapshot.test.ts — Stage C remediation, round 2 (finding league-settings-changed-
// never-raised, its repro (a), through the jobs' composition root: src/cli/espn-stack.ts hands the
// provider `store.repos`, league_settings among them). Two nightly `snapshot roster` runs over the
// recorded league-a stand-in (league id 0, keyless): between them the commissioner switches the league
// to FAAB. The second run records the new settings and opens one `settings_changed` warn (rules
// changed, the scoring hash unchanged), which doctor #22 reports (plan 03 §5 #22; T-08) until a human
// acknowledges it. Before, the store's league_settings stayed empty and doctor #22 said "ok". Two runs
// of the unchanged league open nothing. No request leaves the process; no cookie is sent.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkHealthChecks } from "../../src/cli/doctor.js";
import { loadRuntime } from "../../src/cli/runtime.js";
import { snapshotRoster } from "../../src/cli/snapshot.js";
import { openStore } from "../../src/cli/store-access.js";
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

/** league-a's mSettings, switched to FAAB when `faab` (the commissioner's edit). */
function settings(faab: boolean): Record<string, unknown> {
  const s = rec("league-a/mSettings.json") as {
    settings: { acquisitionSettings: Record<string, unknown> };
  };
  if (faab)
    Object.assign(s.settings.acquisitionSettings, {
      isUsingAcquisitionBudget: true,
      acquisitionBudget: 100,
      minimumBid: 1,
    });
  return s;
}

/** The league-a stand-in: every view `snapshot roster` asks, keyless (a public league). */
function leagueA(faab: boolean) {
  return fakeFetch((url) => {
    const u = new URL(url);
    const views = u.searchParams.getAll("view");
    if (views.includes("proTeamSchedules_wl"))
      return jsonRes(rec("season/proTeamSchedules_wl.json"));
    if (!u.pathname.includes("/leagues/0")) return new Response(null, { status: 404 });
    const parts: Record<string, unknown>[] = [];
    for (const v of views) {
      if (v === "mSettings") parts.push(settings(faab));
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
      else return jsonRes({ messages: ["no fixture"] }, 404);
    }
    return jsonRes(
      parts.reduce<unknown>((acc, b) => (acc === null ? b : composeBodies(acc, b)), null),
    );
  });
}

/** One nightly run (its own process: its own clock, provider and store connection). */
async function nightly(at: string, faab: boolean) {
  const f = leagueA(faab);
  const { exec } = fakeExec();
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
    },
  });
  const { config, log } = await loadRuntime(io);
  const code = await snapshotRoster(io, config, log, { notify: false, preKickoff: false });
  for (const init of f.inits) expect(new Headers(init.headers).has("cookie")).toBe(false);
  return { code, io, config, log };
}

describe("snapshot roster records the league settings; a commissioner's edit opens settings_changed", () => {
  it("an unchanged league opens nothing; a switch to FAAB opens one warn that doctor #22 reports", async () => {
    sb = sandbox();
    expect((await nightly("2026-10-06T18:00:00.000Z", false)).code).toBe(0);
    // a day later (past the settings TTL: ESPN is asked again), the same league: nothing opens
    const same = await nightly("2026-10-07T20:00:00.000Z", false);
    expect(same.code).toBe(0);
    const before = openStore(same.config, same.io.clock, same.log, { migrate: false });
    try {
      // the second run's answer is recorded (its clock runs from 20:00): the row moved to it
      expect(
        Date.parse(before.repos.leagueSettings.latest("0", 2026)?.fetched_at ?? ""),
      ).toBeGreaterThanOrEqual(Date.parse("2026-10-07T20:00:00.000Z"));
      expect(checkHealthChecks(before).find((r) => r.id === "settings_changed")?.status).toBe("ok");
    } finally {
      before.close();
    }
    // the commissioner switches the league to FAAB
    const faab = await nightly("2026-10-08T22:00:00.000Z", true);
    expect(faab.code).toBe(0);
    const store = openStore(faab.config, faab.io.clock, faab.log, { migrate: false });
    try {
      const open = store.repos.leagueSettings
        .openChecks()
        .filter((c) => c.id === "settings_changed");
      expect(open).toHaveLength(1);
      expect(open[0]?.detail).toMatchObject({
        season: 2026,
        scoring_changed: false,
        slots_changed: false,
        rules_changed: true,
      });
      const row = checkHealthChecks(store).find((r) => r.id === "settings_changed");
      expect(row?.status).toBe("warn");
      expect(row?.n).toBe(22);
    } finally {
      store.close();
    }
  });
});
