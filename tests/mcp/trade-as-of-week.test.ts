// trade-as-of-week.test.ts — E6 tells the trade engine which week its players were read for
// (TradeRequest.as_of_week; plan 07 E6; src/domain/analytics/trade.ts `availability`): every ESPN
// injury status describes the call's week, so value week `w` is judged `w − as_of_week` weeks out.
// Stage C finding trade-locked-week-counted, attempt 3 (the verifier): once E6 left out a current
// week a trade cannot reach (mid-Sunday, the traded players locked), the engine judged the first
// value week — week 6 — as the week the statuses describe, its index 0: a doubtful player at his
// status's 6 % and no weekly miss. A spy on the engine records each request: mid-Sunday it must
// carry as-of week 5 with value weeks from 6, and the Tuesday control as-of 5 with weeks from 5.
// The engine's own rule is held in tests/domain/analytics/trade.test.ts. fx-10h (week 5) and its
// `sunday-live` variant; EFF_TOOLSET=full; fixture mode, no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ESPN_FIXTURES, call, connect, makeWorld } from "./helpers/world.js";

const rec = vi.hoisted(() => ({ requests: [] as { as_of_week: number; weeks: number[] }[] }));

vi.mock("../../src/domain/analytics/trade.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/domain/analytics/trade.js")>();
  return {
    ...mod,
    analyzeTrade: (req: Parameters<typeof mod.analyzeTrade>[0]) => {
      rec.requests.push({ as_of_week: req.as_of_week, weeks: [...req.weeks] });
      return mod.analyzeTrade(req);
    },
  };
});

const FX = path.join(ESPN_FIXTURES, "fx-10h");
/** The finder's offer: my RB for team 10's RB, both in the 13:00 ET Sunday games. */
const OFFER = { partner_team_id: 10, give: [4890973], get: [4242335] };

async function engineRequest(variant: string): Promise<{ as_of_week: number; weeks: number[] }> {
  const dir = variant === "" ? FX : path.join(FX, variant);
  const m = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as {
    clock: string;
    my_team_id: number;
  };
  const world = await makeWorld({
    env: { EFF_FIXTURE_DIR: dir, EFF_TOOLSET: "full" },
    teamId: m.my_team_id,
    clock: m.clock,
    publishEspn: false,
  });
  const c = await connect(world, { options: { toolset: "full" } });
  try {
    await call(c.client, "espn_get_league");
    rec.requests.length = 0;
    const r = await call(c.client, "espn_analyze_trade", { offer: OFFER, seed: 7 });
    expect(r.isError, JSON.stringify(r.body).slice(0, 400)).toBe(false);
    expect(rec.requests).toHaveLength(1);
    const got = rec.requests[0];
    if (got === undefined) throw new Error("the engine was not called");
    return got;
  } finally {
    await c.close();
    world.cleanup();
  }
}

describe("E6 hands the engine the week its players were read for (Stage C trade-locked-week-counted)", () => {
  it("mid-Sunday: value weeks from 6, judged from as-of week 5 (the statuses' week), never from 6", async () => {
    const got = await engineRequest("sunday-live");
    expect(got.weeks[0]).toBe(6);
    expect(got.as_of_week).toBe(5);
  }, 180_000);

  it("control: Tuesday night the value weeks start at the as-of week 5 itself", async () => {
    const got = await engineRequest("");
    expect(got.weeks[0]).toBe(5);
    expect(got.as_of_week).toBe(5);
  }, 180_000);
});
