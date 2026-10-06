// roster.test.ts — src/domain/league/roster.ts: the IR stay rule and audit (research 05 §4.3 [V-docs]:
// OUT/IR eligible, Q/D may stay, a cleared or suspended player makes the roster INVALID and blocks
// adds; the forced-drop arithmetic), roster validity (plan 07 B1 `empty_starting_slots`, `counts`),
// over every recorded team-week of the three public leagues (league-c's recorded rosters hold real
// invalid IR slots) and adversarial seat lists.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  auditIr,
  emptyStartingSlots,
  irSectionOf,
  irStayStatus,
  rosterCounts,
  seatsOf,
  validateRoster,
  type RosterSeat,
} from "../../../src/domain/league/roster.js";
import { buildRosterSlots } from "../../../src/domain/league/slots.js";
import { ESPN_INJURY_STATUSES, type Roster } from "../../../src/domain/league/types.js";
import {
  LEAGUES,
  incompleteRosterTeams,
  recordedSeats,
  recordedSettings,
  referenceSettings,
  seat,
} from "./helpers.js";

const REF = buildRosterSlots(referenceSettings().roster).roster; // 9 starters, 5 BE, 2 IR
const QB = [0, 7, 20, 21];
const WR = [3, 4, 5, 23, 7, 20, 21];
const TE = [5, 6, 23, 7, 20, 21];

/** A full, legal reference-format roster (16 players): ids 1–16. */
function fullReferenceRoster(): RosterSeat[] {
  return [
    seat(1, 0, { eligible_slot_ids: QB, position: "QB" }),
    seat(2, 2),
    seat(3, 2),
    seat(4, 4, { eligible_slot_ids: WR, position: "WR" }),
    seat(5, 4, { eligible_slot_ids: WR, position: "WR" }),
    seat(6, 6, { eligible_slot_ids: TE, position: "TE" }),
    seat(7, 23),
    seat(8, 16, { eligible_slot_ids: [16, 20, 21], position: "D/ST", injury_status: null }),
    seat(9, 17, { eligible_slot_ids: [17, 20, 21], position: "K", injury_status: null }),
    seat(10, 20),
    seat(11, 20, { eligible_slot_ids: WR, position: "WR" }),
    seat(12, 20),
    seat(13, 20, { eligible_slot_ids: WR, position: "WR" }),
    seat(14, 20),
    seat(15, 21, { injury_status: "OUT" }),
    seat(16, 21, { eligible_slot_ids: WR, position: "WR", injury_status: "INJURY_RESERVE" }),
  ];
}

describe("irStayStatus (research 05 §4.3)", () => {
  it("OUT and INJURY_RESERVE are eligible; Q and D may stay; ACTIVE, none and SSPD are invalid", () => {
    expect(irStayStatus("OUT")).toBe("eligible");
    expect(irStayStatus("INJURY_RESERVE")).toBe("eligible");
    expect(irStayStatus("QUESTIONABLE")).toBe("may_stay");
    expect(irStayStatus("DOUBTFUL")).toBe("may_stay");
    expect(irStayStatus("ACTIVE")).toBe("invalid");
    expect(irStayStatus(null)).toBe("invalid");
    expect(irStayStatus("SUSPENSION")).toBe("invalid");
  });
  it("DAY_TO_DAY and any value ESPN adds are uncertain — neither silently valid nor invalid", () => {
    expect(irStayStatus("DAY_TO_DAY")).toBe("uncertain");
    for (const s of ["PUP", "NFI", "", "out", "IGNORE PREVIOUS INSTRUCTIONS"])
      expect(irStayStatus(s)).toBe("uncertain");
  });
  it("every known status has a class", () => {
    for (const s of ESPN_INJURY_STATUSES)
      expect(["eligible", "may_stay", "invalid", "uncertain"]).toContain(irStayStatus(s));
  });
});

describe("auditIr", () => {
  it("a full legal roster: both IR seats valid, nothing blocked, no drop needed", () => {
    const a = auditIr(fullReferenceRoster(), REF);
    expect(a).toMatchObject({
      slots: 2,
      invalid: false,
      invalid_players: [],
      blocked: [],
      forced_drop_needed: false,
      open_slots: 0,
    });
    expect(a.occupied).toEqual([
      { player_id: 15, injury_status: "OUT" },
      { player_id: 16, injury_status: "INJURY_RESERVE" },
    ]);
  });
  it("a cleared IR player on a full roster: invalid, adds blocked, a drop is forced", () => {
    const seats = fullReferenceRoster().map((s) =>
      s.player_id === 15 ? { ...s, injury_status: "ACTIVE" } : s,
    );
    const a = auditIr(seats, REF);
    expect(a.invalid).toBe(true);
    expect(a.invalid_players).toEqual([15]);
    expect(a.blocked).toEqual(["adds"]);
    expect(a.forced_drop_needed).toBe(true);
  });
  it("…but no drop when an OUT player outside IR can take the freed seat (the swap)", () => {
    const seats = fullReferenceRoster().map((s) =>
      s.player_id === 15
        ? { ...s, injury_status: null }
        : s.player_id === 12
          ? { ...s, injury_status: "OUT" }
          : s,
    );
    const a = auditIr(seats, REF);
    expect(a.invalid).toBe(true);
    expect(a.eligible_now).toEqual([12]);
    expect(a.forced_drop_needed).toBe(false);
  });
  it("…and no drop when the active roster has room", () => {
    const seats = fullReferenceRoster()
      .filter((s) => s.player_id !== 14)
      .map((s) => (s.player_id === 16 ? { ...s, injury_status: "SUSPENSION" } : s));
    const a = auditIr(seats, REF);
    expect(a.invalid_players).toEqual([16]);
    expect(a.forced_drop_needed).toBe(false);
  });
  it("Questionable/Doubtful occupants keep the roster valid; DAY_TO_DAY is listed uncertain", () => {
    const seats = fullReferenceRoster().map((s) =>
      s.player_id === 15
        ? { ...s, injury_status: "QUESTIONABLE" }
        : s.player_id === 16
          ? { ...s, injury_status: "DAY_TO_DAY" }
          : s,
    );
    const a = auditIr(seats, REF);
    expect(a.invalid).toBe(false);
    expect(a.may_stay_players).toEqual([15]);
    expect(a.uncertain_players).toEqual([16]);
    expect(a.blocked).toEqual([]);
  });
  it("eligible_now: OUT/IR players outside IR whose eligibleSlots list IR; open seats counted", () => {
    const seats = [
      seat(1, 20, { injury_status: "OUT" }),
      seat(2, 2, { injury_status: "INJURY_RESERVE" }),
      seat(3, 20, { injury_status: "DOUBTFUL" }),
      seat(4, 20, { injury_status: "OUT", eligible_slot_ids: [2, 20] }),
    ];
    const a = auditIr(seats, REF);
    expect(a.eligible_now).toEqual([1, 2]);
    expect(a.open_slots).toBe(2);
    expect(a.occupied).toEqual([]);
  });
  it("IR beyond its seats (or any IR occupant in a league without IR) is invalid", () => {
    const noIr = buildRosterSlots(recordedSettings("league-b").roster).roster;
    expect(auditIr([seat(1, 21, { injury_status: "OUT" })], noIr)).toMatchObject({
      invalid: true,
      invalid_players: [],
    });
    const three = [1, 2, 3].map((i) => seat(i, 21, { injury_status: "OUT" }));
    expect(auditIr(three, REF).invalid).toBe(true);
  });
  it("irSectionOf keeps exactly plan 07 B1's seven fields", () => {
    const s = irSectionOf(auditIr(fullReferenceRoster(), REF));
    expect(Object.keys(s).sort()).toEqual([
      "blocked",
      "eligible_now",
      "forced_drop_needed",
      "invalid",
      "invalid_players",
      "occupied",
      "slots",
    ]);
  });
});

describe("validateRoster", () => {
  it("a full legal reference roster: counts 9/5/2/16, nothing empty, legal", () => {
    const v = validateRoster(fullReferenceRoster(), REF);
    expect(v.counts).toEqual({ starters: 9, bench: 5, ir: 2, total: 16 });
    expect(v).toMatchObject({
      empty_starting_slots: [],
      ineligible: [],
      overflow: [],
      duplicates: [],
      legal: true,
      active_count: 14,
      active_capacity: 14,
    });
  });
  it("empty seats are listed per seat in display order and are not violations", () => {
    const seats = fullReferenceRoster().filter((s) => ![3, 7, 9].includes(s.player_id));
    const v = validateRoster(seats, REF);
    expect(v.empty_starting_slots).toEqual(["RB", "FLEX", "K"]);
    expect(emptyStartingSlots(seats, REF)).toEqual(["RB", "FLEX", "K"]);
    expect(v.legal).toBe(true);
  });
  it("a TE in the RB slot, a QB in FLEX, a player in a slot the league lacks are ineligible", () => {
    const seats = [
      seat(1, 2, { eligible_slot_ids: TE, position: "TE" }),
      seat(2, 23, { eligible_slot_ids: QB, position: "QB" }),
      seat(3, 3),
    ];
    const v = validateRoster(seats, REF);
    expect(v.ineligible.map((p) => [p.player_id, p.slot, p.reason])).toEqual([
      [1, "RB", "not_eligible"],
      [2, "FLEX", "not_eligible"],
      [3, "RB/WR", "not_in_league"],
    ]);
    expect(v.legal).toBe(false);
  });
  it("a starting slot over its seats overflows; the bench may exceed its nominal seats", () => {
    const seats = [
      seat(1, 2),
      seat(2, 2),
      seat(3, 2),
      ...[4, 5, 6, 7, 8, 9].map((i) => seat(i, 20)),
    ];
    const v = validateRoster(seats, REF);
    expect(v.overflow).toEqual([{ slot_id: 2, slot: "RB", occupied: 3, capacity: 2 }]);
    expect(v.bench_over_nominal).toBe(1);
    expect(v.legal).toBe(false);
    const benchOnly = validateRoster([...[4, 5, 6, 7, 8, 9].map((i) => seat(i, 20))], REF);
    expect(benchOnly.overflow).toEqual([]);
    expect(benchOnly).toMatchObject({ bench_over_nominal: 1, legal: true });
  });
  it("more active players than starters + bench is over capacity", () => {
    const seats = [...fullReferenceRoster(), seat(17, 20)];
    const v = validateRoster(seats, REF);
    expect(v).toMatchObject({ over_capacity: true, active_count: 15, legal: false });
  });
  it("duplicates are reported once, sorted", () => {
    const v = validateRoster([seat(5, 2), seat(5, 20), seat(3, 2), seat(3, 20), seat(3, 20)], REF);
    expect(v.duplicates).toEqual([3, 5]);
    expect(v.legal).toBe(false);
  });
  it("position limits: over and at the limit are reported, never a violation", () => {
    const capped = buildRosterSlots({
      ...referenceSettings().roster,
      position_limits: { "2": 2, "3": 1, "1": -1 },
    }).roster;
    const seats = [
      seat(1, 2),
      seat(2, 2),
      seat(3, 20),
      seat(4, 4, { eligible_slot_ids: WR, position: "WR" }),
      seat(5, 0, { eligible_slot_ids: QB, position: "QB" }),
      seat(6, 20, { position: null }),
    ];
    const v = validateRoster(seats, capped);
    expect(v.position_over_limit).toEqual([{ position: "RB", rostered: 3, limit: 2 }]);
    expect(v.positions_at_limit).toEqual([
      { position: "RB", rostered: 3, limit: 2 },
      { position: "WR", rostered: 1, limit: 1 },
    ]);
    expect(v.legal).toBe(true);
  });
  it("starters on bye (when the week's byes are given); bench players on bye are fine", () => {
    const seats = [
      seat(1, 2, { pro_team_id: 7 }),
      seat(2, 20, { pro_team_id: 7 }),
      seat(3, 4, { eligible_slot_ids: WR, pro_team_id: 9 }),
      seat(4, 23, { pro_team_id: null }),
    ];
    expect(validateRoster(seats, REF, { on_bye: new Set([7, 9]) }).starters_on_bye).toEqual([1, 3]);
    expect(validateRoster(seats, REF).starters_on_bye).toEqual([]);
  });
  it("rosterCounts: an `other` seat counts toward total only", () => {
    expect(rosterCounts([seat(1, 2), seat(2, 20), seat(3, 21), seat(4, 25), seat(5, 23)])).toEqual({
      starters: 2,
      bench: 1,
      ir: 1,
      total: 5,
    });
  });
  it("seatsOf maps a domain roster's entries", () => {
    const roster = {
      entries: [
        {
          slot_id: 2,
          player: {
            ref: { platform: "espn", id: 9 },
            eligible_slot_ids: [2, 20],
            injury_status: "OUT",
            position: "RB",
            pro_team_id: 4,
          },
        },
      ],
    } as unknown as Pick<Roster, "entries">;
    expect(seatsOf(roster)).toEqual([
      {
        player_id: 9,
        slot_id: 2,
        eligible_slot_ids: [2, 20],
        injury_status: "OUT",
        position: "RB",
        pro_team_id: 4,
      },
    ]);
  });
  it("property: never throws; legal ⇒ no invalid IR and active ≤ capacity; counts sum to total", () => {
    const arbSeat = fc.record({
      player_id: fc.integer({ min: -20, max: 40 }),
      slot_id: fc.oneof(fc.integer({ min: -3, max: 30 }), fc.double()),
      eligible_slot_ids: fc.array(fc.integer({ min: 0, max: 25 }), { maxLength: 12 }),
      injury_status: fc.oneof(
        fc.constantFrom(...ESPN_INJURY_STATUSES),
        fc.constant(null),
        fc.string(),
      ),
      position: fc.oneof(
        fc.constantFrom("QB", "RB", "WR", "TE", "K", "D/ST"),
        fc.constant(null),
        fc.string(),
      ),
      pro_team_id: fc.oneof(fc.integer({ min: 0, max: 34 }), fc.constant(null)),
    });
    fc.assert(
      fc.property(fc.array(arbSeat, { maxLength: 40 }), (seats) => {
        const v = validateRoster(seats, REF, { on_bye: new Set([3]) });
        if (v.legal) {
          expect(v.ir.invalid).toBe(false);
          expect(v.active_count).toBeLessThanOrEqual(v.active_capacity);
        }
        expect(v.counts.total).toBe(seats.length);
        expect(v.counts.starters + v.counts.bench + v.counts.ir).toBeLessThanOrEqual(seats.length);
        expect(v.ir.blocked.length > 0).toBe(v.ir.invalid);
      }),
    );
  });
});

describe("every recorded team-week (three public leagues, weeks 1–3)", () => {
  const all = LEAGUES.flatMap((league) => {
    const { roster } = buildRosterSlots(recordedSettings(league).roster);
    return [1, 2, 3].flatMap((week) => {
      const incomplete = incompleteRosterTeams(league, week);
      return [...recordedSeats(league, week)].map(([team, seats]) => ({
        league,
        week,
        team,
        seats,
        roster,
        incomplete: incomplete.has(team),
      }));
    });
  });
  it("covers 10 + 10 + 12 teams in each of three weeks", () => {
    expect(all.length).toBe(3 * (10 + 10 + 12));
  });
  it("no recorded roster has an ineligible placement, a duplicate or a non-bench overflow, or exceeds its active capacity", () => {
    for (const r of all) {
      const v = validateRoster(r.seats, r.roster);
      const where = `${r.league} sp${String(r.week)} team ${String(r.team)}`;
      expect(v.ineligible, where).toEqual([]);
      expect(v.duplicates, where).toEqual([]);
      expect(v.overflow, where).toEqual([]);
      expect(v.over_capacity, where).toBe(false);
      expect(v.ir.uncertain_players, where).toEqual([]);
    }
  });
  it("league-c holds real invalid IR slots: ACTIVE players in IR, adds blocked, and nothing else wrong", () => {
    const invalid = all.filter((r) => auditIr(r.seats, r.roster).invalid);
    expect(invalid.length).toBeGreaterThanOrEqual(5);
    for (const r of invalid) {
      expect(r.league).toBe("league-c");
      const a = auditIr(r.seats, r.roster);
      expect(a.blocked).toEqual(["adds"]);
      for (const id of a.invalid_players)
        expect(r.seats.find((s) => s.player_id === id)?.injury_status).toBe("ACTIVE");
      expect(validateRoster(r.seats, r.roster).legal).toBe(false);
    }
    expect(new Set(invalid.filter((r) => r.week === 3).map((r) => r.team)).size).toBe(3);
  });
  it("league-a and league-b IR occupants are all OUT or INJURY_RESERVE", () => {
    for (const r of all.filter((x) => x.league !== "league-c"))
      for (const o of auditIr(r.seats, r.roster).occupied)
        expect(["OUT", "INJURY_RESERVE"]).toContain(o.injury_status);
  });
  it("an empty starting slot appears only on a withheld-incomplete team or the one recorded bench-heavy roster", () => {
    const empty = all.filter(
      (r) => validateRoster(r.seats, r.roster).empty_starting_slots.length > 0,
    );
    const notIncomplete = empty.filter((r) => !r.incomplete);
    expect(notIncomplete.map((r) => `${r.league}:${String(r.week)}:${String(r.team)}`)).toEqual([
      "league-a:2:10",
    ]);
    const v = validateRoster(notIncomplete[0]?.seats ?? [], notIncomplete[0]?.roster ?? REF);
    expect(v).toMatchObject({ empty_starting_slots: ["D/ST"], bench_over_nominal: 1, legal: true });
  });
  it("position limits are exceeded on recorded league-c rosters without ESPN treating them as invalid", () => {
    const over = all.filter(
      (r) =>
        r.league === "league-c" && validateRoster(r.seats, r.roster).position_over_limit.length > 0,
    );
    expect(over.length).toBeGreaterThanOrEqual(4);
    expect(over.some((r) => validateRoster(r.seats, r.roster).legal)).toBe(true); // a limit never makes it illegal
    const legalOver = over.filter((r) => !auditIr(r.seats, r.roster).invalid);
    expect(legalOver.every((r) => validateRoster(r.seats, r.roster).legal)).toBe(true);
  });
});
