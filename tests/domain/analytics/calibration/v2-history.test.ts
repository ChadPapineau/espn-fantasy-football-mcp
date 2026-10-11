// v2-history.test.ts — the `full` replay's v2 door (helpers/v2-history.ts) holds the store's rules
// and never looks ahead (plan 10 C2 on the shipped Phase 3 model): a player's games are this
// season's weeks before the target (with usage) and the prior season's (without usage), never the
// per-location TD counts; team-games stop before the target week (no target-week volume) and carry
// red-zone plays only for this season; every served mean is ESPN's projection (weight_espn 1.0),
// an inactive player (ESPN's game-day 0) is served 0, and QBs are served (Phase 2's basis never
// served one); players without a GSIS id, an NFL team or a game are skipped with runV2's reason.
import { describe, expect, it } from "vitest";
import { historySeason } from "./helpers/history.js";
import {
  espnToGsis,
  leagueBWorld,
  storeGames,
  storeTeamGames,
  v2WeekOverlay,
} from "./helpers/v2-history.js";

const SEASON = 2025;
const WEEK = 9;

describe("the full replay's v2 overlay (league-b)", () => {
  it("hands v2 only games before the target week, usage only for this season, no location TDs", () => {
    const world = leagueBWorld();
    let checked = 0;
    for (const p of world.players.slice(0, 400)) {
      const gs = storeGames(world, p.gsis_id, SEASON, WEEK);
      for (const g of gs) {
        const current = g.season === SEASON;
        expect(current ? g.week < WEEK : g.season === SEASON - 1 && g.week <= 18).toBe(true);
        if (!current) {
          expect(g.snap_pct).toBeNull();
          expect(g.rz_targets).toBeNull();
          expect(g.rz_carries).toBeNull();
          expect(g.gl_carries).toBeNull();
        }
        expect(g.rz_rec_td).toBeNull();
        expect(g.rz_rush_td).toBeNull();
        expect(g.gl_rush_td).toBeNull();
        expect(g.sack_fum_lost).toBe(0);
        expect(g.rec_fum_lost).toBe(0);
        checked += 1;
      }
      // the fumbles lost survive as one sum
      const src = p.games.filter((g) => g.season === SEASON && g.week < WEEK);
      const sum = (xs: readonly { rush_fum_lost: number }[]): number =>
        xs.reduce((a, g) => a + g.rush_fum_lost, 0);
      expect(sum(gs.filter((g) => g.season === SEASON))).toBe(
        src.reduce((a, g) => a + g.sack_fum_lost + g.rush_fum_lost + g.rec_fum_lost, 0),
      );
    }
    expect(checked).toBeGreaterThan(1000);
    expect(storeGames(world, "no-such-player", SEASON, WEEK)).toEqual([]);
  });

  it("hands v2 no team-game of the target week or later; red-zone plays only for this season", () => {
    const tgs = storeTeamGames(leagueBWorld(), SEASON, WEEK);
    expect(tgs.length).toBeGreaterThan(500);
    for (const t of tgs) {
      if (t.season === SEASON) expect(t.week).toBeLessThan(WEEK);
      else {
        expect(t.season).toBe(SEASON - 1);
        expect(t.rz_plays).toBeNull();
      }
    }
    expect(tgs.some((t) => t.season === SEASON && t.rz_plays !== null)).toBe(true);
  });

  it("serves ESPN's mean exactly, 0 for an inactive player, QBs included; skips with runV2's reasons", async () => {
    const s = historySeason(SEASON);
    const wk = s.weeks.find((w) => w.week === WEEK);
    expect(wk).toBeDefined();
    const entries = (wk?.teams ?? []).flatMap((t) => t.entries);
    const byes = new Set<number>([entries.find((e) => e.position === "WR")?.player_id ?? -1]);
    // a QB/RB/WR/TE with no GSIS id and one with no NFL team are skipped, never projected
    const base = entries.find((e) => e.position === "RB");
    expect(base).toBeDefined();
    if (base === undefined) return;
    const unknown = { ...base, player_id: 999_999_901 };
    const teamless = { ...base, player_id: base.player_id, pro_team_id: 0 };
    const out = await v2WeekOverlay(s, WEEK, [...entries, unknown], byes, 200);
    expect(out.skipped.get(999_999_901)).toBe("no_gsis_id");
    for (const id of byes) if (id !== -1) expect(out.skipped.get(id)).toBe("bye");
    const teamOnly = await v2WeekOverlay(s, WEEK, [teamless], new Set(), 200);
    expect(teamOnly.skipped.get(base.player_id)).toBe("no_nfl_team");
    expect(teamOnly.dists.size).toBe(0);
    let qbs = 0;
    let zeros = 0;
    for (const e of entries) {
      const d = out.dists.get(e.player_id);
      if (d === undefined) continue;
      expect(d.basis).toBe("player_sim");
      expect(Math.abs(d.mean - (e.projected ?? d.mean))).toBeLessThanOrEqual(0.01);
      if (e.projected === 0) {
        expect(d.mean).toBe(0);
        expect(d.p_zero).toBe(1);
        zeros += 1;
      }
      if (e.position === "QB") qbs += 1;
      expect(espnToGsis().has(e.player_id)).toBe(true);
    }
    expect(out.dists.size).toBeGreaterThan(80);
    expect(qbs).toBeGreaterThanOrEqual(8);
    expect(zeros).toBeGreaterThanOrEqual(5);
    // no position v2 does not model is ever served
    for (const e of entries)
      if (!["QB", "RB", "WR", "TE"].includes(e.position))
        expect(out.dists.has(e.player_id)).toBe(false);
  }, 120_000);
});
