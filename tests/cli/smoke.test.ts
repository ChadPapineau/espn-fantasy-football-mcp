// smoke.test.ts — `eff smoke` (plan 05 §1, §5; plan 06 §1.5; plan 10 A1b; Stage C finding
// cli-smoke-command-missing: the documented live gate did not exist). Over an injected fetch that
// answers from the recorded, anonymised league-a fixtures (league id 0, keyless, a public league):
// settings, one roster, one pool page, the last final week scored per stat against ESPN's applied
// points, and the keyless probe diff — counts only, exit 0; a scoring mismatch fails (exit 1); a
// rejected cookie is exit 3; a skeleton answer from the probe is drift (exit 4). No request leaves
// the process.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { USAGE, main } from "../../src/cli/main.js";
import { loadRuntime } from "../../src/cli/runtime.js";
import { smoke, smokeExit } from "../../src/cli/smoke.js";
import { composeBodies } from "../../src/providers/espn/index.js";
import { ESPN_FIXTURES } from "../mcp/helpers/world.js";
import {
  ROOT,
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

/** league-a, keyless; `tamper` edits the week's box score body; `probe` overrides the host probe. */
function leagueA(
  opts: { tamper?: (box: Record<string, unknown>) => void; skeleton?: boolean } = {},
) {
  return fakeFetch((url) => {
    const u = new URL(url);
    const views = u.searchParams.getAll("view");
    if (views.includes("proTeamSchedules_wl"))
      return jsonRes(opts.skeleton === true ? {} : rec("season/proTeamSchedules_wl.json"));
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
      } else if (v === "mBoxscore") {
        const box = rec("league-a/mBoxscore.sp3.json");
        opts.tamper?.(box);
        parts.push(box);
      } else if (v === "mMatchupScore") parts.push(rec("league-a/mMatchupScore.sp4.json"));
      else if (v === "mMatchup") parts.push(rec("league-a/mMatchup.json"));
      else if (v === "kona_player_info") parts.push(rec("league-a/kona_player_info.json"));
      else return jsonRes({ messages: ["no fixture"] }, 404);
    }
    return jsonRes(merge(...parts));
  });
}

async function run(f: ReturnType<typeof fakeFetch>, extra: string[] = []) {
  const io = makeIo(sb, {
    fetch: f.fetch,
    clock: movingClock("2026-10-06T18:00:00.000Z"),
    packageRoot: fakePackage(sb),
    env: { ESPN_LEAGUE_ID: "0", EFF_CREDENTIAL_STORE: "file", ESPN_SEASON: "2026" },
  });
  const code = await main(["smoke", "--week", "3", ...extra], io);
  return { code, io };
}

describe("eff smoke (the live smoke, run by the owner)", () => {
  it("exists, is documented, and passes on a league whose week scores match ESPN per stat", async () => {
    sb = sandbox();
    expect(USAGE).toContain("smoke [--week N] [--json]");
    const f = leagueA();
    const { code, io } = await run(f, ["--json"]);
    const out = JSON.parse(io.out.text) as {
      checks: { check: string; status: string; detail: string }[];
    };
    expect(out.checks.map((c) => [c.check, c.status])).toEqual([
      ["settings", "ok"],
      ["roster", "ok"],
      ["pool", "ok"],
      ["golden", "ok"],
      ["probe", "ok"],
    ]);
    expect(out.checks.find((c) => c.check === "golden")?.detail).toMatch(
      /^week 3: (\d+)\/\1 player-week\(s\) match ESPN per stat and in total$/,
    );
    expect(code).toBe(0);
    // keyless on a public league: no Cookie header, read host only, never the write host
    for (const init of f.inits) expect(new Headers(init.headers).has("cookie")).toBe(false);
    expect(f.urls.every((u) => new URL(u).hostname === "lm-api-reads.fantasy.espn.com")).toBe(true);
  });

  it("a scoring mismatch fails the golden check (exit 1), counts only", async () => {
    sb = sandbox();
    const f = leagueA({
      tamper: (box) => {
        const sched = box.schedule as {
          home: {
            rosterForCurrentScoringPeriod?: {
              entries: {
                playerPoolEntry: {
                  player: { stats: { appliedTotal?: number; statSourceId: number }[] };
                };
              }[];
            };
          };
        }[];
        for (const m of sched)
          for (const e of m.home.rosterForCurrentScoringPeriod?.entries ?? [])
            for (const st of e.playerPoolEntry.player.stats)
              if (st.statSourceId === 0 && typeof st.appliedTotal === "number")
                st.appliedTotal += 7;
      },
    });
    const { code, io } = await run(f);
    expect(io.out.text).toMatch(/golden\s+fail\s+week 3: \d+\/\d+ player-week\(s\) match/);
    expect(io.out.text).toContain("smoke: FAILED (exit 1)");
    expect(code).toBe(1);
  });

  it("a skeleton answer from the host probe is drift (exit 4)", async () => {
    sb = sandbox();
    const { code, io } = await run(leagueA({ skeleton: true }));
    expect(io.out.text).toMatch(/probe\s+fail/);
    expect(code).toBe(4);
  });

  it("the exit code: a rejected cookie is 3, drift 4, a failure 1, else 0", () => {
    const ok = { check: "settings" as const, status: "ok" as const, detail: "", code: null };
    expect(smokeExit([ok], [])).toBe(0);
    expect(smokeExit([{ ...ok, status: "fail", code: "ESPN_AUTH_REJECTED" }], [])).toBe(3);
    expect(smokeExit([{ ...ok, status: "fail" }], [])).toBe(1);
  });

  it("fixture mode skips the probe (no network); --week is validated", async () => {
    sb = sandbox();
    const io = makeIo(sb, {
      clock: movingClock("2026-10-06T18:00:00.000Z"),
      packageRoot: fakePackage(sb),
      env: { ESPN_LEAGUE_ID: "0", EFF_FIXTURE_DIR: ESPN_FIXTURES },
    });
    const { config, log } = await loadRuntime(io);
    await smoke(io, config, log, { json: false, week: undefined });
    expect(io.out.text).toMatch(/probe\s+skip\s+fixture mode/);
    const bad = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } });
    expect(await main(["smoke", "--week", "x"], bad)).toBe(2);
  });
});
