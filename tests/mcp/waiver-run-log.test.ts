// waiver-run-log.test.ts — only a whole-wire priority analysis of my own team joins the league's
// waiver feed (plan 10 C5; research 05 §1.2 and §1.6 eval 3: each logged run's best `s` is "the best
// claimable player's surplus", which fitLeaguePremium re-solves Π from after 13 runs). Stage C
// finding `waivers-run-log-overwritten`: logWaiverRun stored every priority call's candidates, and the
// store upserts on (league, season, run), so the stream-kdef K-only call, injury-cascade's
// `candidates` list or a rival's team_id replaced the whole-wire row and biased the fitted Π. Now a
// narrower call never writes; a later whole-wire call of my team still replaces the row (newest
// before the run wins). In process on fx-10h (the owner's format; move-to-last priority).
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WaiverRunRecord } from "../../src/domain/analytics/types.js";
import { pricesWholeWireRun } from "../../src/mcp/tools/analytics.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
const manifest = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
  clock: string;
  my_team_id: number;
};

let world: World;
let client: Client;
let close: () => Promise<void>;
beforeAll(async () => {
  world = await makeWorld({
    env: { EFF_FIXTURE_DIR: FX },
    teamId: manifest.my_team_id,
    clock: manifest.clock,
  });
  ({ client, close } = await connect(world));
}, 120_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

type Run = WaiverRunRecord;
const runs = (): Run[] => [...world.store.repos.waiverRuns.list("0", 2026)];

async function waivers(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await call(client, "espn_analyze_waivers", { mode: "priority", ...args });
  expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
  return r.body.data as Record<string, unknown>;
}

describe("the waiver-run log keeps the whole-wire run of my team (plan 10 C5)", () => {
  let whole: Run;
  let rival = 0;
  let someIds: number[] = [];

  beforeAll(async () => {
    const d = await waivers({});
    expect(d.mode_used).toBe("priority");
    expect(runs()).toHaveLength(1);
    whole = runs()[0]!;
    expect(whole.run_at).toBe(d.next_run_at);
    expect(whole.surplus.length).toBeGreaterThan(1);
    someIds = (d.candidates as { player_id: number }[]).slice(0, 2).map((c) => c.player_id);
    const st = await call(client, "espn_get_standings");
    rival =
      (st.body.data as { teams: { team_id: number }[] }).teams.find(
        (t) => t.team_id !== manifest.my_team_id,
      )?.team_id ?? 0;
    expect(rival).toBeGreaterThan(0);
  }, 120_000);

  it.each([
    ["a K-only slice (stream-kdef)", { positions: ["K"], look_ahead: 2 }],
    ["a D/ST-only slice", { positions: ["D/ST"] }],
    ["a hand-picked candidates list (injury-cascade)", () => ({ candidates: someIds })],
    ["a rival's team", () => ({ team_id: rival })],
    ["a shorter horizon", { horizon_weeks: 3 }],
    ["a forced phase", { phase: "pre_run" }],
    ["an explicit value source", { value_source: "espn_ros" }],
    ["no drop", { include_drop: false }],
  ] as const)("%s never replaces the row", async (_label, a) => {
    const args = typeof a === "function" ? a() : a;
    await waivers(args);
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toEqual(whole);
  });

  it("a later whole-wire call of my team (team_id given or not) still writes the run", async () => {
    world.store.repos.waiverRuns.put(
      "0",
      { season: 2026, run_at: whole.run_at, W: 1, surplus: [0] },
      "2026-10-01T00:00:00.000Z",
    );
    await waivers({ team_id: manifest.my_team_id });
    expect(runs()).toHaveLength(1);
    expect(runs()[0]?.surplus).toEqual(whole.surplus);
  });
});

describe("pricesWholeWireRun", () => {
  const base = { phase: "auto", value_source: "auto", include_drop: true } as const;
  it("true only for my team, the whole wire and the defaults", () => {
    expect(pricesWholeWireRun(base, 2, 2)).toBe(true);
    expect(pricesWholeWireRun(base, 3, 2)).toBe(false);
    expect(pricesWholeWireRun(base, 2, null)).toBe(false);
    expect(pricesWholeWireRun({ ...base, positions: [] }, 2, 2)).toBe(false);
    expect(pricesWholeWireRun({ ...base, candidates: [1] }, 2, 2)).toBe(false);
    expect(pricesWholeWireRun({ ...base, horizon_weeks: 17 }, 2, 2)).toBe(false);
    expect(pricesWholeWireRun({ ...base, look_ahead: 1 }, 2, 2)).toBe(false);
    expect(pricesWholeWireRun({ ...base, phase: "post_run" }, 2, 2)).toBe(false);
    expect(pricesWholeWireRun({ ...base, value_source: "ensemble" }, 2, 2)).toBe(false);
    expect(pricesWholeWireRun({ ...base, include_drop: false }, 2, 2)).toBe(false);
  });
});
