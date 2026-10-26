// waiver-feed-weekly.test.ts — the league's own waiver feed, which re-solves the priority premium Π
// at 13 observations (plan 10 C5: "13 logged runs (one regular season)"; research 05 §1.2: the
// weekly DP's surplus rate of the best weekly claim), holds ONE observation per fantasy week — the
// week's main claim run, the run whose best claimable surplus is the largest — and only the
// claimable (WAIVERS) players' surplus of a priced claim run, never a post-run free-agent scramble.
// Stage C finding waivers-surplus-feed-per-run: one row per processing run, every candidate's `s`
// included, so a daily-processing league (fx-10h processes six days a week) reached the threshold in
// about two weeks with a rate biased low by the leftovers of the daily runs, and the post-run call
// logged free agents' surplus as an observation of the NEXT run. Unit cases on weeklyRunFeed and
// feedWeekOf; the tool on fx-10h (core) with the clock moved a day per call, and on its post-run
// variant; fixture mode, no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WaiverRunRecord } from "../../src/domain/analytics/types.js";
import type { ToolContext } from "../../src/mcp/define.js";
import { feedWeekOf, logWaiverRun, weeklyRunFeed } from "../../src/mcp/tools/analytics.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
const DAY = 86_400_000;

/** A two-week schedule: week 5 Thu 2026-10-08 → Mon 10-12, week 6 Thu 10-15 → Mon 10-19 (UTC). */
const schedule = {
  games: [
    game(1, 5, "2026-10-09T00:15:00.000Z"),
    game(2, 5, "2026-10-13T00:15:00.000Z"),
    game(3, 6, "2026-10-16T00:15:00.000Z"),
    game(4, 6, "2026-10-20T00:15:00.000Z"),
  ],
};
function game(id: number, week: number, kickoff: string) {
  return {
    season: 2026,
    espn_game_id: id,
    week,
    kickoff,
    start_time_tbd: false,
    valid_for_locking: true,
    stats_official: false,
    home_pro_team_id: id,
    away_pro_team_id: id + 10,
  } as never;
}
const run = (at: string, surplus: number[]): WaiverRunRecord => ({
  season: 2026,
  run_at: at,
  W: 12,
  surplus,
});

describe("weeklyRunFeed: one observation per fantasy week (Stage C waivers-surplus-feed-per-run)", () => {
  it("six daily runs of one week are one observation: the main run's best claim, never the leftovers", () => {
    const main = run("2026-10-07T07:30:00.000Z", [2.5, 1.2, -0.3]); // Wednesday, after week 4
    const daily = [8, 9, 10, 11, 12].map((d) =>
      run(`2026-10-${String(d).padStart(2, "0")}T07:30:00.000Z`, [0.5, 0.2]),
    );
    const next = run("2026-10-14T07:30:00.000Z", [3.1]); // the next Wednesday: week 6
    const feed = weeklyRunFeed([...daily, next, main], schedule);
    expect(feed).toEqual([main, next]);
  });

  it("without the pro schedule the Tuesday-to-Tuesday weeks group the runs", () => {
    const runs = [
      run("2026-10-07T07:30:00.000Z", [1]),
      run("2026-10-09T07:30:00.000Z", [4]),
      run("2026-10-14T07:30:00.000Z", [2]),
    ];
    expect(weeklyRunFeed(runs, null).map((r) => r.run_at)).toEqual([
      "2026-10-09T07:30:00.000Z",
      "2026-10-14T07:30:00.000Z",
    ]);
  });

  it("a run is a week's: Tuesday after Monday night serves the coming week, Saturday its own", () => {
    const last: [number, number][] = [
      [5, Date.parse("2026-10-13T00:15:00.000Z")],
      [6, Date.parse("2026-10-20T00:15:00.000Z")],
    ];
    const first = Date.parse("2026-10-09T00:15:00.000Z");
    expect(feedWeekOf(Date.parse("2026-10-10T15:00:00.000Z"), last, first)).toBe("w5");
    expect(feedWeekOf(Date.parse("2026-10-13T09:00:00.000Z"), last, first)).toBe("w6");
    // before the season's first week, and after its last: calendar weeks
    expect(feedWeekOf(Date.parse("2026-08-20T09:00:00.000Z"), last, first)).toMatch(/^t\d+$/);
    expect(feedWeekOf(Date.parse("2026-10-27T09:00:00.000Z"), last, first)).toMatch(/^t\d+$/);
  });

  it("an empty or unparseable run never becomes an observation", () => {
    expect(weeklyRunFeed([run("not a date", [9])], schedule)).toEqual([]);
  });
});

describe("logWaiverRun logs a priced claim run's claimable players only", () => {
  /** A context whose run repository records what is put. */
  function ctxWith(put: WaiverRunRecord[]): ToolContext {
    return {
      services: {
        league: { platform: "espn", league_id: "0", season: 2026 },
        clock: { nowMs: () => 0, nowIso: () => "2026-10-07T01:00:00.000Z" },
        waiverRuns: {
          put: (_l: string, r: WaiverRunRecord) => {
            put.push(r);
            return { written: true };
          },
          list: () => [],
        },
      },
      pacer: { throwIfCancelled: () => undefined },
    } as unknown as ToolContext;
  }
  const data = (phase: string, candidates: { status: string; s: number }[]) => ({
    mode_used: "priority",
    phase,
    next_run_at: "2026-10-07T07:30:00.000Z",
    W: 12,
    candidates,
  });

  it("pre-run: the WAIVERS candidates' surplus only — a free agent costs no priority", () => {
    const put: WaiverRunRecord[] = [];
    logWaiverRun(
      ctxWith(put),
      2026,
      data("pre_run", [
        { status: "WAIVERS", s: 3.5 },
        { status: "FREEAGENT", s: 9.9 },
        { status: "WAIVERS", s: 1.25 },
      ]),
    );
    expect(put).toEqual([
      { season: 2026, run_at: "2026-10-07T07:30:00.000Z", W: 12, surplus: [3.5, 1.25] },
    ]);
  });

  it("post-run, or no claimable player: nothing is logged", () => {
    const put: WaiverRunRecord[] = [];
    logWaiverRun(ctxWith(put), 2026, data("post_run", [{ status: "WAIVERS", s: 4 }]));
    logWaiverRun(ctxWith(put), 2026, data("pre_run", [{ status: "FREEAGENT", s: 4 }]));
    expect(put).toEqual([]);
  });
});

describe("the tool logs claim runs only and counts weeks (Stage C waivers-surplus-feed-per-run)", () => {
  async function world(
    variant = "",
  ): Promise<{ w: World; client: Client; close: () => Promise<void> }> {
    const dir = variant === "" ? FX : path.join(FX, variant);
    const m = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as {
      clock: string;
      my_team_id: number;
    };
    const w = await makeWorld({
      env: { EFF_FIXTURE_DIR: dir },
      teamId: m.my_team_id,
      clock: m.clock,
    });
    const c = await connect(w);
    return { w, client: c.client, close: c.close };
  }
  const priority = async (client: Client) => {
    const r = await call(client, "espn_analyze_waivers", { mode: "priority" });
    expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
    return r.body as {
      data: {
        phase: string;
        next_run_at: string | null;
        candidates: { status: string; s: number }[];
      };
      warnings: string[];
    };
  };

  let fx: Awaited<ReturnType<typeof world>>;
  beforeAll(async () => {
    fx = await world();
  }, 120_000);
  afterAll(async () => {
    await fx.close();
    fx.w.cleanup();
  });

  it("a week of daily calls: the store keeps its runs, the feed counts one or two weeks, never seven", async () => {
    const seen = new Set<string>();
    let last: Awaited<ReturnType<typeof priority>> | null = null;
    for (let d = 0; d < 7; d++) {
      if (d > 0) fx.w.clock.advance(DAY);
      last = await priority(fx.client);
      if (last.data.next_run_at !== null) seen.add(last.data.next_run_at);
    }
    // the repro's precondition: several distinct processing runs were priced
    expect(seen.size).toBeGreaterThan(2);
    const line = last?.warnings.find((w) => w.includes("weeks of priced waiver runs logged")) ?? "";
    const n = Number(/; (\d+) of 13 weeks of priced waiver runs logged/.exec(line)?.[1] ?? "-1");
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(2);
    expect(n).toBeLessThan(seen.size);
  }, 120_000);

  it("a post-run call (every candidate a free agent) logs nothing", async () => {
    const post = await world("post-run");
    try {
      const got = await priority(post.client);
      expect(got.data.phase).toBe("post_run");
      expect(got.data.candidates.every((c) => c.status === "FREEAGENT")).toBe(true);
      expect(post.w.store.repos.waiverRuns.list("0", 2026)).toEqual([]);
    } finally {
      await post.close();
      post.w.cleanup();
    }
  }, 120_000);
});
