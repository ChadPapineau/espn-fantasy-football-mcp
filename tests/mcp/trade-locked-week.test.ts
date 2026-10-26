// trade-locked-week.test.ts — E6 espn_analyze_trade values a trade from the first week it can still
// change (TradeRequest.weeks: "the first week the traded players can play first"; plan 07 E6). A trade
// accepted now processes no sooner than the league's review period (tradeSettings.revisionHours →
// rules.trade.revision_hours), and a player locked — or locking before it processes — plays the week
// for his current team (market-p1.ts tradeReachesWeek). Stage C finding trade-locked-week-counted:
// mid-Sunday, with both traded RBs `lineup_locked`, the current week still added L(after) − L(before)
// to the delta, the weekly impact and ΔU's regular-season scaling (about 11 % of the delta in the
// repro). fx-10h's `sunday-live` variant (Sunday of week 5, 14:05 ET, the 13:00 games under way) and
// the base (Tuesday night of week 5) as the control; EFF_TOOLSET=full; fixture mode, no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import type { Roster } from "../../src/domain/league/types.js";
import { tradeReachesWeek } from "../../src/mcp/tools/market-p1.js";
import { envelopeViolations } from "./helpers/walk.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
/** The finder's offer: my RB for team 10's RB, both in the 13:00 ET Sunday games. */
const OFFER = { partner_team_id: 10, give: [4890973], get: [4242335] };

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

interface Evaluation {
  kind: string;
  weekly_impact: { week: number; me: number; partner: number }[];
  rec: { assumptions: { text: string }[] } | null;
}

async function evaluate(
  client: Client,
  offer: Record<string, unknown> | null,
): Promise<{ data: Evaluation; warnings: string[] }> {
  await call(client, "espn_get_league");
  await call(client, "espn_get_standings");
  const r = await call(
    client,
    "espn_analyze_trade",
    offer === null
      ? { find_partners: { need_position: "RB", max_partners: 2 } }
      : { offer, seed: 7 },
  );
  expect(r.isError, JSON.stringify(r.body).slice(0, 400)).toBe(false);
  expect(envelopeViolations(r.body as never)).toEqual([]);
  return { data: r.body.data as Evaluation, warnings: r.body.warnings as string[] };
}

describe("E6 counts no week a trade accepted now cannot reach (Stage C trade-locked-week-counted)", () => {
  it("mid-Sunday with both RBs locked: week 5 is not a value week; the impact starts at week 6, said", async () => {
    const fx = await fxWorld("sunday-live");
    try {
      const rows: { player_id: number; lineup_locked: boolean }[] = [];
      for (const team_id of [undefined, OFFER.partner_team_id]) {
        const r = await call(fx.client, "espn_get_roster", {
          week: 5,
          ...(team_id === undefined ? {} : { team_id }),
        });
        rows.push(...(r.body.data as { players: typeof rows }).players);
      }
      for (const id of [...OFFER.give, ...OFFER.get])
        expect(rows.find((p) => p.player_id === id)?.lineup_locked, String(id)).toBe(true);
      const got = await evaluate(fx.client, OFFER);
      expect(got.data.kind).toBe("evaluation");
      expect(got.data.weekly_impact.map((x) => x.week)).not.toContain(5);
      expect(got.data.weekly_impact[0]?.week).toBe(6);
      expect(got.warnings.some((w) => w.startsWith("week 5 not counted:"))).toBe(true);
      expect(
        got.data.rec?.assumptions.some((a) =>
          a.text.startsWith("week 5 not counted: 2 of the traded players are locked"),
        ),
      ).toBe(true);
    } finally {
      await fx.close();
      fx.world.cleanup();
    }
  }, 180_000);

  it("a partner search mid-Sunday: the week's games have locked, so week 5 is left out too", async () => {
    const fx = await fxWorld("sunday-live");
    try {
      const got = await evaluate(fx.client, null);
      expect(got.data.kind).toBe("partners");
      expect(got.warnings.some((w) => w.startsWith("week 5 not counted:"))).toBe(true);
    } finally {
      await fx.close();
      fx.world.cleanup();
    }
  }, 180_000);

  it("control: the same offer on Tuesday night counts week 5 (it can process before the games)", async () => {
    const fx = await fxWorld("");
    try {
      const got = await evaluate(fx.client, OFFER);
      expect(got.data.weekly_impact[0]?.week).toBe(5);
      expect(got.warnings.some((w) => w.includes("not counted"))).toBe(false);
    } finally {
      await fx.close();
      fx.world.cleanup();
    }
  }, 180_000);
});

describe("tradeReachesWeek", () => {
  const NOW = Date.parse("2026-10-09T12:00:00.000Z"); // a Friday
  const SUNDAY = "2026-10-11T17:00:00.000Z";
  const THURSDAY = "2026-10-09T00:15:00.000Z"; // already kicked off
  const schedule = {
    games: [
      // pro teams 1 v 2 on Sunday, 3 v 4 on the Thursday just gone
      game(1, 1, 2, SUNDAY),
      game(2, 3, 4, THURSDAY),
    ],
  };
  function game(id: number, home: number, away: number, kickoff: string) {
    return {
      season: 2026,
      espn_game_id: id,
      week: 5,
      kickoff,
      start_time_tbd: false,
      valid_for_locking: true,
      stats_official: false,
      home_pro_team_id: home,
      away_pro_team_id: away,
    } as never;
  }
  function roster(...players: [id: number, team: number, locked?: boolean][]): Roster {
    return {
      entries: players.map(([id, team, locked]) => ({
        player: { ref: { platform: "espn", id }, pro_team_id: team },
        lineup_locked: locked === true,
      })),
    } as unknown as Roster;
  }
  const base = { schedule, week: 5, lineupLockType: "INDIVIDUAL_GAME", nowMs: NOW };

  it("an offer reaches the week when every moved player locks after it processes", () => {
    const r = tradeReachesWeek({
      ...base,
      rosters: [roster([10, 1], [11, 3])],
      moved: [10],
      revisionHours: 24,
    });
    expect(r).toEqual({
      reaches: true,
      process_at_ms: NOW + 24 * 3_600_000,
      review_hours: 24,
      blocked: [],
    });
  });

  it("a moved player whose game kicked off, who is flagged locked, or locks inside the review period blocks it", () => {
    // 11 played Thursday (lock passed)
    expect(
      tradeReachesWeek({
        ...base,
        rosters: [roster([10, 1], [11, 3])],
        moved: [10, 11],
        revisionHours: 0,
      }).blocked,
    ).toEqual([11]);
    // ESPN's lineupLocked alone
    expect(
      tradeReachesWeek({ ...base, rosters: [roster([10, 1, true])], moved: [10], revisionHours: 0 })
        .blocked,
    ).toEqual([10]);
    // a 72 h review processes after Sunday's kickoff
    const r = tradeReachesWeek({
      ...base,
      rosters: [roster([10, 1])],
      moved: [10],
      revisionHours: 72,
    });
    expect(r.reaches).toBe(false);
    expect(r.blocked).toEqual([10]);
  });

  it("an unknown review period reads as none; a player not moved never blocks", () => {
    const r = tradeReachesWeek({
      ...base,
      rosters: [roster([10, 1], [11, 3, true])],
      moved: [10],
      revisionHours: null,
    });
    expect(r.review_hours).toBe(0);
    expect(r.reaches).toBe(true);
  });

  it("a partner search reaches the week only before its first lock", () => {
    const search = (hours: number, nowMs: number) =>
      tradeReachesWeek({
        ...base,
        nowMs,
        rosters: [roster([10, 1]), roster([20, 2])],
        moved: null,
        revisionHours: hours,
      });
    // Friday, with Thursday's game in the schedule (it locked): out — but only the Sunday teams
    // are rostered here, so the week's first lock is Sunday's
    expect(search(24, NOW).reaches).toBe(true);
    expect(search(72, NOW).reaches).toBe(false);
    // a rostered player already locked: the week has started
    const started = tradeReachesWeek({
      ...base,
      rosters: [roster([10, 1]), roster([21, 3])],
      moved: null,
      revisionHours: 0,
    });
    expect(started.reaches).toBe(false);
    expect(started.blocked).toEqual([21]);
  });

  it("without the pro schedule only ESPN's lineupLocked decides", () => {
    expect(
      tradeReachesWeek({
        ...base,
        schedule: { games: [] },
        rosters: [roster([10, 1]), roster([11, 3, true])],
        moved: [10],
        revisionHours: 168,
      }).reaches,
    ).toBe(true);
    expect(
      tradeReachesWeek({
        ...base,
        schedule: { games: [] },
        rosters: [roster([10, 1]), roster([11, 3, true])],
        moved: [10, 11],
        revisionHours: 0,
      }).blocked,
    ).toEqual([11]);
  });
});
