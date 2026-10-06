// pipeline.test.ts — the league model composed the way `espn_get_league` (plan 07 A1) and
// `espn_get_roster` (B1) use it, over the recorded leagues and the recorded pro schedule: one
// settings digest, then a recorded roster's IR audit, validity, byes and lock plan for a week.
import { describe, expect, it } from "vitest";
import {
  auditIr,
  buildLeagueSettings,
  byesByWeek,
  irSectionOf,
  lockPlan,
  seedingDigest,
  startingSlotsFor,
  validateRoster,
  weekGameState,
} from "../../../src/domain/league/index.js";
import { slotClassOf } from "../../../src/domain/league/slots.js";
import {
  LEAGUES,
  recordedSchedule,
  recordedSeats,
  recordedSettings,
  referenceSettings,
} from "./helpers.js";

const S = recordedSchedule();

describe("A1: the settings digest + seeding section for every league", () => {
  it("each recorded league and the reference format produce a complete digest", () => {
    for (const input of [...LEAGUES.map(recordedSettings), referenceSettings()]) {
      const d = buildLeagueSettings(input);
      expect(d.roster.total).toBeGreaterThan(0);
      expect(d.rules.playoffs.playoff_weeks.length).toBeGreaterThan(0);
      expect(d.rules.trade.deadline).not.toBeNull();
      const seeding = seedingDigest(d.rules.playoffs.seeding_rule, {
        seeding_mode: "espn_rule",
        seeding_confirmed_at: null,
      });
      expect(seeding).toMatchObject({
        rule: "TOTAL_POINTS_SCORED",
        mode_in_use: "espn_rule",
        confirmed: false,
      });
      expect(Object.isFrozen(d.rules.waiver)).toBe(true);
    }
  });
});

describe("B1: a recorded roster through IR, validity, byes and locks", () => {
  it("league-b week 3 rosters checked against week 5's byes and Sunday locks", () => {
    const { roster, rules } = buildLeagueSettings(recordedSettings("league-b"));
    const onBye = new Set(byesByWeek(S)["5"] ?? []);
    expect([...onBye].sort((a, b) => a - b)).toEqual([12, 29]);
    const now = Date.parse("2026-10-11T16:00:00Z"); // week 5, Sunday 12:00 ET
    for (const [team, seats] of recordedSeats("league-b", 3)) {
      const v = validateRoster(seats, roster, { on_bye: onBye });
      const expectedOnBye = seats
        .filter(
          (s) =>
            (slotClassOf(s.slot_id) === "starter" || slotClassOf(s.slot_id) === "flex") &&
            s.pro_team_id !== null &&
            onBye.has(s.pro_team_id),
        )
        .map((s) => s.player_id)
        .sort((a, b) => a - b);
      expect(v.starters_on_bye, `team ${String(team)}`).toEqual(expectedOnBye);
      const plan = lockPlan(seats, S, 5, roster.lineup_lock_type, now);
      expect(plan.rule).toBe("per_game");
      expect(plan.bye_player_ids).toEqual(
        seats
          .filter((s) => s.pro_team_id !== null && onBye.has(s.pro_team_id))
          .map((s) => s.player_id)
          .sort((a, b) => a - b),
      );
      // the Thursday-night players are locked, Sunday's are not yet
      for (const p of plan.players) if (p.window === "thursday") expect(p.locked).toBe(true);
      for (const p of plan.players) if (p.window === "sunday_early") expect(p.locked).toBe(false);
      if (plan.latest_execution_time !== null)
        expect(Date.parse(plan.latest_execution_time)).toBeGreaterThan(now);
      expect(irSectionOf(auditIr(seats, roster)).slots).toBe(0);
    }
    expect(rules.waiver_system).toBe("faab");
    expect(weekGameState(S, 5, now).provisional).toBe(true);
  });
  it("league-c week 3: invalid IR rosters block adds; eligible starting slots come from eligibleSlots", () => {
    const { roster } = buildLeagueSettings(recordedSettings("league-c"));
    let blocked = 0;
    for (const [, seats] of recordedSeats("league-c", 3)) {
      const ir = auditIr(seats, roster);
      if (ir.invalid) blocked++;
      for (const s of seats)
        for (const slot of startingSlotsFor(s, roster)) expect(s.eligible_slot_ids).toContain(slot);
    }
    expect(blocked).toBe(3);
  });
});
