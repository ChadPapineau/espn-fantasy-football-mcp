// replay.test.ts — one team-week through calibration/replay.ts (plan 10 C2): each rule's starters
// and their realised points (hindsight ≥ every rule; ESPN's projection and last week's points as the
// same exact assignment by those numbers; the manager's lineup as played), the head-to-head facts
// (the as-played P(win) is the model's normal approximation of the two lineups as played, the auto
// lineup's counterfactual against the opponent's best-by-mean lineup, ties null), the switch record
// passed through to E2, and refusals (an empty roster, a locked player).
import { describe, expect, it } from "vitest";
import {
  replayStartSit,
  type StartSitTeamWeek,
} from "../../../../src/domain/analytics/calibration/index.js";
import { AnalyticsError } from "../../../../src/domain/analytics/errors.js";
import { bestLineup, type LineupPlayer } from "../../../../src/domain/analytics/lineup.js";
import { pairMoments, pWinNormal } from "../../../../src/domain/analytics/totals.js";
import { slotClassOf } from "../../../../src/domain/league/slots.js";
import { clockAndRng, referenceSlots } from "../helpers.js";
import { roster } from "./helpers/roster.js";

const starts = (p: LineupPlayer): boolean => {
  const c = slotClassOf(p.slot_id);
  return c === "starter" || c === "flex";
};

function teamWeek(over: Partial<StartSitTeamWeek> = {}): StartSitTeamWeek {
  const me = roster(0);
  const opp = roster(100);
  // realised: the bench RB (id 10) explodes, the FLEX WR (id 7) busts
  const realised = new Map<number, number>([
    ...me.map((p) => [p.player_id, p.points.mean] as const),
    ...opp.map((p) => [p.player_id, p.points.mean] as const),
  ]);
  realised.set(10, 30);
  realised.set(7, 1);
  const espn = new Map(me.map((p) => [p.player_id, p.points.mean] as const));
  espn.set(12, 25); // ESPN loves the bench TE
  const last = new Map<number, number>(me.map((p) => [p.player_id, 0] as const));
  last.set(11, 40); // the bench WR scored 40 last week
  return {
    season: 2025,
    week: 5,
    team_id: 1,
    roster: referenceSlots(),
    players: me,
    opponent: opp,
    realised,
    espn_projection: espn,
    last_week: last,
    h2h: true,
    seeding_config: { mode: "espn_rule", confirmed_at: null },
    clock: clockAndRng("2026-10-08T12:00:00.000Z").clock,
    ...over,
  };
}

describe("replayStartSit", () => {
  it("realises every rule and keeps the hindsight best on top", () => {
    const tw = teamWeek();
    const r = replayStartSit(tw);
    expect(r).toMatchObject({
      season: 2025,
      week: 5,
      team_id: 1,
      objective_auto: "mean",
      basis: "position_cv",
    });
    for (const v of Object.values(r.realised))
      if (v !== null) expect(r.realised.hindsight ?? 0).toBeGreaterThanOrEqual(v);
    const real = (ids: readonly number[]): number =>
      Math.round(ids.reduce((s, id) => s + (tw.realised.get(id) ?? 0), 0) * 100) / 100;
    const manager = tw.players.filter(starts).map((p) => p.player_id);
    expect(r.realised.manager).toBe(real(manager));
    expect(r.lineup_key.manager).toBe([...manager].sort((a, b) => a - b).join(","));
    // auto/mean start the bench RB (12 > the FLEX WR's 7) and the bench WR (11 > 8)
    expect(r.lineup_key.auto).toBe(r.lineup_key.mean);
    expect(r.lineup_key.auto?.split(",").map(Number)).toEqual(expect.arrayContaining([10, 11]));
    // ESPN's numbers start the bench TE; last week's start the bench WR
    expect(r.lineup_key.espn_projection?.split(",").map(Number)).toContain(12);
    expect(r.lineup_key.last_week?.split(",").map(Number)).toContain(11);
    const hind = bestLineup(
      tw.roster,
      tw.players.map((p) => ({
        ...p,
        points: { ...p.points, mean: tw.realised.get(p.player_id) ?? 0 },
      })),
    ).map((p) => p.player_id);
    expect(r.realised.hindsight).toBe(real(hind));
    expect(r.player_sim_share).toBe(0);
  });

  it("carries the head-to-head facts: as-played P(win), the auto counterfactual, the opponent's total", () => {
    const tw = teamWeek();
    const r = replayStartSit(tw);
    const h = r.h2h;
    expect(h).not.toBeNull();
    const mine = tw.players.filter(starts);
    const theirs = (tw.opponent ?? []).filter(starts);
    const member = (p: LineupPlayer) => ({
      player_id: p.player_id,
      position: p.position,
      pro_team_id: p.pro_team_id,
      points: p.points,
    });
    expect(h?.p_win_played).toBeCloseTo(
      pWinNormal(pairMoments(mine.map(member), theirs.map(member))),
      6,
    );
    const oppTotal = theirs.reduce((s, p) => s + (tw.realised.get(p.player_id) ?? 0), 0);
    expect(h?.opponent_total).toBeCloseTo(oppTotal, 6);
    expect(h?.outcome_played).toBe((r.realised.manager ?? 0) > oppTotal);
    expect(h?.p_win_auto).toBeGreaterThan(0);
    expect(typeof h?.outcome_auto).toBe("boolean");
  });

  it("a tie reads null; no h2h flag or no opponent → no head-to-head facts; no last week → null rule", () => {
    const tw = teamWeek();
    const me = new Map(tw.realised);
    // make the as-played totals equal: copy my starters' values onto the opponent's starters
    const mine = tw.players.filter(starts);
    const theirs = (tw.opponent ?? []).filter(starts);
    const sumMine = mine.reduce((s, p) => s + (me.get(p.player_id) ?? 0), 0);
    theirs.forEach((p, i) => me.set(p.player_id, i === 0 ? sumMine : 0));
    expect(replayStartSit({ ...tw, realised: me }).h2h?.outcome_played).toBeNull();
    expect(replayStartSit({ ...tw, h2h: false }).h2h).toBeNull();
    const alone = replayStartSit({ ...tw, opponent: null });
    expect(alone.h2h).toBeNull();
    expect(replayStartSit({ ...tw, opponent: [] }).h2h).toBeNull();
    const first = replayStartSit({ ...tw, last_week: null });
    expect(first.realised.last_week).toBeNull();
    expect(first.lineup_key.last_week).toBeNull();
  });

  it("passes the switch record to E2 and reports the player_sim share of the auto starters", () => {
    const tw = teamWeek({ players: roster(0, "player_sim"), opponent: roster(100, "player_sim") });
    const switching = {
      evidence: { basis: "player_sim" as const, player_sim_share: 1, seasons: [] },
      decision: { status: "switch" as const, switch: true, reasons: [] },
      source: "test",
    };
    const r = replayStartSit({ ...tw, objective_switch: switching });
    expect(r.basis).toBe("player_sim");
    expect(r.objective_auto).toBe("pwin");
    expect(r.player_sim_share).toBe(1);
    expect(replayStartSit(tw).objective_auto).toBe("mean");
  });

  it("refuses an empty roster and any locked player (the replay is pre-week)", () => {
    expect(() => replayStartSit(teamWeek({ players: [] }))).toThrow(AnalyticsError);
    const locked = roster(0).map((p, i) => (i === 0 ? { ...p, locked: true } : p));
    expect(() => replayStartSit(teamWeek({ players: locked }))).toThrow(AnalyticsError);
    const oppLocked = roster(100).map((p, i) => (i === 3 ? { ...p, locked: true } : p));
    expect(() => replayStartSit(teamWeek({ opponent: oppLocked }))).toThrow(AnalyticsError);
  });

  it("non-finite realised or projected numbers read as 0", () => {
    const tw = teamWeek();
    const realised = new Map(tw.realised);
    realised.set(1, Number.NaN);
    const espn = new Map(tw.espn_projection);
    espn.set(1, Number.POSITIVE_INFINITY);
    const r = replayStartSit({ ...tw, realised, espn_projection: espn });
    for (const v of Object.values(r.realised))
      if (v !== null) expect(Number.isFinite(v)).toBe(true);
  });
});
