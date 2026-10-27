// value-weeks-as-of.test.ts — a player's value for a week never depends on which other weeks are
// valued (p1-common.ts valueWeeks; plan 07 E6 TradeRequest.weeks, E8 `weeks`). ESPN's numbers are as
// of the call's week: its weekly projection is that week's and its rest-of-season total is shared
// from it. Stage C finding trade-locked-week-counted, attempt 2 (the verifier): once E6 left out a
// current week the trade cannot reach, weeklyValues read the as-of week as `weeks[0]`, so week 6 was
// valued with ESPN's week-5 projection and the total was shared from week 6; E8's asked weeks did the
// same. A spy on weeklyValues (the one function those tools price a player week with) records every
// call, and each answer must equal the reading of every week from the as-of week, restricted to the
// weeks valued; a positive control shows the old reading differs on this fixture. fx-10h (week 5),
// its `sunday-live` variant for E6; EFF_TOOLSET=full; fixture mode, no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import type { WeeklyValuesOpts } from "../../src/domain/analytics/waivers.js";
import { envelopeViolations } from "./helpers/walk.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

interface Seen {
  weeks: number[];
  espnWeek: number | null;
  espnRos: number | null;
  bye: number | null;
  opts: WeeklyValuesOpts;
  got: (number | null)[];
}

const rec = vi.hoisted(() => ({ calls: [] as Seen[] }));

vi.mock("../../src/domain/analytics/waivers.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/domain/analytics/waivers.js")>();
  return {
    ...mod,
    weeklyValues: (...args: Parameters<typeof mod.weeklyValues>) => {
      const got = mod.weeklyValues(...args);
      rec.calls.push({
        weeks: [...args[0]],
        espnWeek: args[1],
        espnRos: args[2],
        bye: args[3],
        opts: args[4] ?? {},
        got,
      });
      return got;
    },
  };
});

const { weeklyValues } =
  await vi.importActual<typeof import("../../src/domain/analytics/waivers.js")>(
    "../../src/domain/analytics/waivers.js",
  );

const FX = path.join(ESPN_FIXTURES, "fx-10h");
/** The finder's offer: my RB for team 10's RB, both locked in the 13:00 ET Sunday games. */
const OFFER = { partner_team_id: 10, give: [4890973], get: [4242335] };
const AS_OF = 5;

async function fxWorld(
  variant: string,
): Promise<{ world: World; client: Client; close: () => Promise<void> }> {
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
  return { world, client: c.client, close: c.close };
}

/** The reading of every week from the as-of week, restricted to the weeks the call valued. */
function reference(s: Seen): (number | null)[] {
  const { from_week: _drop, ...rest } = s.opts;
  const all: number[] = [];
  const last = Math.max(AS_OF, ...s.weeks);
  for (let w = AS_OF; w <= last; w++) all.push(w);
  const full = weeklyValues(all, s.espnWeek, s.espnRos, s.bye, rest);
  return s.weeks.map((w) => (w < AS_OF ? null : (full[all.indexOf(w)] ?? null)));
}

/** The reading the code used before the fix: the as-of week taken as the first value week. */
function firstWeekReading(s: Seen): (number | null)[] {
  const { from_week: _drop, ...rest } = s.opts;
  return weeklyValues(s.weeks, s.espnWeek, s.espnRos, s.bye, rest);
}

function checkCalls(calls: readonly Seen[]): { later: number; differs: number } {
  let later = 0;
  let differs = 0;
  for (const s of calls) {
    const want = reference(s);
    for (const [i, w] of s.weeks.entries())
      expect(s.got[i] ?? null, `week ${String(w)} of [${s.weeks.join(",")}]`).toBe(want[i] ?? null);
    if ((s.weeks[0] ?? AS_OF) > AS_OF) {
      later++;
      const old = firstWeekReading(s);
      if (old.some((v, i) => v !== (want[i] ?? null))) differs++;
    }
  }
  return { later, differs };
}

describe("valueWeeks prices every week from the as-of week (Stage C trade-locked-week-counted)", () => {
  it("E6 mid-Sunday leaves week 5 out and still values week 6 as week 6 (never with week 5's projection)", async () => {
    const fx = await fxWorld("sunday-live");
    try {
      await call(fx.client, "espn_get_league");
      await call(fx.client, "espn_get_standings");
      rec.calls.length = 0;
      const r = await call(fx.client, "espn_analyze_trade", { offer: OFFER, seed: 7 });
      expect(r.isError, JSON.stringify(r.body).slice(0, 400)).toBe(false);
      expect(envelopeViolations(r.body as never)).toEqual([]);
      const data = r.body.data as { weekly_impact: { week: number }[] };
      // the case the verifier named: the current week is not a value week
      expect(data.weekly_impact[0]?.week).toBe(6);
      const trade = rec.calls.filter((s) => s.weeks[0] === 6);
      expect(trade.length).toBeGreaterThan(20);
      const { later, differs } = checkCalls(rec.calls);
      expect(later).toBe(trade.length);
      // positive control: on this fixture the old reading prices most of these players differently
      expect(differs).toBeGreaterThan(later / 2);
    } finally {
      await fx.close();
      fx.world.cleanup();
    }
  }, 180_000);

  it("E8 with asked weeks after the as-of week values them as those weeks", async () => {
    const fx = await fxWorld("");
    try {
      await call(fx.client, "espn_get_league");
      rec.calls.length = 0;
      const r = await call(fx.client, "espn_analyze_schedule", { weeks: [7, 8], seed: 3 });
      expect(r.isError, JSON.stringify(r.body).slice(0, 400)).toBe(false);
      expect(envelopeViolations(r.body as never)).toEqual([]);
      const asked = rec.calls.filter((s) => s.weeks[0] === 7);
      expect(asked.length).toBeGreaterThan(0);
      const { differs } = checkCalls(rec.calls);
      expect(differs).toBeGreaterThan(0);
    } finally {
      await fx.close();
      fx.world.cleanup();
    }
  }, 180_000);

  it("control: Tuesday night E6 values week 5 first, and the readings agree", async () => {
    const fx = await fxWorld("");
    try {
      await call(fx.client, "espn_get_league");
      await call(fx.client, "espn_get_standings");
      rec.calls.length = 0;
      const r = await call(fx.client, "espn_analyze_trade", { offer: OFFER, seed: 7 });
      expect(r.isError).toBe(false);
      expect((r.body.data as { weekly_impact: { week: number }[] }).weekly_impact[0]?.week).toBe(5);
      const { later } = checkCalls(rec.calls);
      expect(later).toBe(0);
    } finally {
      await fx.close();
      fx.world.cleanup();
    }
  }, 180_000);
});
