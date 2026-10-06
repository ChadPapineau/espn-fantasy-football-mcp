// slots.test.ts — src/domain/league/slots.ts: the slot table (parity with the provider's ESPN_SLOTS
// and ESPN_POSITIONS — research 03 §B.2), the roster digest from `rosterSettings` (plan 07 A1
// `roster`), per-player eligibility from `eligibleSlots` incl. every flex variant and TQB, IR
// eligibility (research 05 §4.3), the greedy seat order, and hostile settings bodies.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BENCH_SLOT_ID,
  IR_SLOT_ID,
  MAX_SETTINGS_KEYS,
  MAX_SLOT_COUNT,
  POSITION_NAMES,
  SLOT_DISPLAY_ORDER,
  SLOT_TABLE,
  buildRosterSlots,
  canOccupySlot,
  enumToken,
  isFlexSlot,
  isStartingSlot,
  leagueSlot,
  positionLimitOf,
  positionNameOf,
  slotClassOf,
  slotDefinition,
  slotNameOf,
  slotRefusal,
  sortSlotIds,
  startingSeats,
  startingSlotsFor,
  type SlotSubject,
} from "../../../src/domain/league/slots.js";
import type { RosterSettingsInput } from "../../../src/domain/league/types.js";
import {
  ESPN_POSITIONS,
  ESPN_SLOTS,
  LINEUP_LOCKTIME_TYPES,
  SLOT_BENCH,
  SLOT_IR,
} from "../../../src/providers/espn/types.js";
import { LEAGUES, recordedSettings, referenceSettings } from "./helpers.js";

const base: RosterSettingsInput = {
  slot_counts: {},
  position_limits: {},
  lineup_lock_type: "INDIVIDUAL_GAME",
  undroppable_list: false,
  move_limit: -1,
};

// eligibleSlots exactly as the recorded rosters carry them (fixtures/espn/recorded/*/mRoster)
const QB: SlotSubject = { eligible_slot_ids: [0, 7, 20, 21], injury_status: "ACTIVE" };
const RB: SlotSubject = { eligible_slot_ids: [2, 3, 23, 7, 20, 21], injury_status: "ACTIVE" };
const WR: SlotSubject = { eligible_slot_ids: [3, 4, 5, 23, 7, 20, 21], injury_status: null };
const TE: SlotSubject = { eligible_slot_ids: [5, 6, 23, 7, 20, 21], injury_status: "QUESTIONABLE" };
const K: SlotSubject = { eligible_slot_ids: [17, 20, 21], injury_status: null };
const DST: SlotSubject = { eligible_slot_ids: [16, 20, 21], injury_status: null };
const TQB: SlotSubject = { eligible_slot_ids: [1, 20, 21], injury_status: null };
const TWO_WAY: SlotSubject = {
  eligible_slot_ids: [3, 4, 5, 23, 7, 20, 21, 12, 14, 15],
  injury_status: null,
};

describe("the slot table (research 03 §B.2)", () => {
  it("equals the provider's ESPN_SLOTS id for id: name, class, positions (through ESPN_POSITIONS)", () => {
    expect(Object.keys(SLOT_TABLE)).toEqual(Object.keys(ESPN_SLOTS));
    for (const [id, espn] of Object.entries(ESPN_SLOTS)) {
      const mine = SLOT_TABLE[Number(id)];
      expect(mine?.id, id).toBe(espn.id);
      expect(mine?.name, id).toBe(espn.name);
      expect(mine?.class, id).toBe(espn.class);
      expect(mine?.eligible_positions, id).toEqual(
        espn.eligible.map((p) => ESPN_POSITIONS[p]?.name),
      );
    }
    expect(BENCH_SLOT_ID).toBe(SLOT_BENCH);
    expect(IR_SLOT_ID).toBe(SLOT_IR);
  });
  it("position names equal the provider's ESPN_POSITIONS names", () => {
    expect(Object.keys(POSITION_NAMES)).toEqual(Object.keys(ESPN_POSITIONS));
    for (const [id, p] of Object.entries(ESPN_POSITIONS))
      expect(POSITION_NAMES[Number(id)]).toBe(p.name);
    expect(positionNameOf(15)).toBe("TQB");
    for (const bad of [0, 6, 8, 17, -1, 1.5, Number.NaN]) expect(positionNameOf(bad)).toBeNull();
  });
  it("the display order is a permutation of the table, FLEX right after TE", () => {
    expect([...SLOT_DISPLAY_ORDER].sort((a, b) => a - b)).toEqual(
      Object.keys(SLOT_TABLE).map(Number),
    );
    expect(SLOT_DISPLAY_ORDER.indexOf(23)).toBe(SLOT_DISPLAY_ORDER.indexOf(6) + 1);
    expect(sortSlotIds([23, 20, 0, 99, 21, 7, 30])).toEqual([0, 23, 7, 20, 21, 30, 99]);
  });
  it("classes: the flex variants, the starting slots, bench, IR, other", () => {
    expect([3, 5, 7, 11, 14, 15, 23].every(isFlexSlot)).toBe(true);
    expect([0, 1, 2, 4, 6, 16, 17].some(isFlexSlot)).toBe(false);
    expect([0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 23].every(isStartingSlot)).toBe(true);
    expect([20, 21, 22, 24, 25, 26, -1].some(isStartingSlot)).toBe(false);
    expect(slotClassOf(20)).toBe("bench");
    expect(slotClassOf(21)).toBe("ir");
    expect(slotClassOf(22)).toBe("other");
  });
  it("an unknown id is an `other` slot named SLOT_<id>, never a starting slot", () => {
    expect(slotDefinition(42)).toEqual({
      id: 42,
      name: "SLOT_42",
      class: "other",
      eligible_positions: [],
    });
    expect(slotNameOf(22)).toBe("SLOT_22");
    expect(slotNameOf(23)).toBe("FLEX");
    expect(slotClassOf(2.5)).toBe("other");
    expect(() => slotDefinition(-1)).toThrow(RangeError);
  });
  it("enumToken accepts uppercase snake tokens only (never free text)", () => {
    expect(enumToken("INDIVIDUAL_GAME")).toBe("INDIVIDUAL_GAME");
    for (const bad of [
      "individual_game",
      "IGNORE ALL PREVIOUS",
      "",
      "_X",
      "X".repeat(65),
      1,
      null,
      undefined,
      {},
    ])
      expect(enumToken(bad)).toBeNull();
    expect(LINEUP_LOCKTIME_TYPES).toContain("INDIVIDUAL_GAME");
  });
});

describe("buildRosterSlots over the three recorded leagues and the reference format", () => {
  it("league-a: TQB + 5 FLEX + D/ST + K, 7 BE, 2 IR; QB unlimited, RB 10, TQB 2", () => {
    const { roster, unverified } = buildRosterSlots(recordedSettings("league-a").roster);
    expect(roster.slots.map((s) => [s.name, s.count, s.class])).toEqual([
      ["TQB", 1, "starter"],
      ["FLEX", 5, "flex"],
      ["D/ST", 1, "starter"],
      ["K", 1, "starter"],
      ["BE", 7, "bench"],
      ["IR", 2, "ir"],
    ]);
    expect([roster.starters, roster.bench, roster.ir, roster.total]).toEqual([8, 7, 2, 17]);
    expect(roster.position_limits).toEqual({
      QB: null,
      RB: 10,
      WR: 10,
      TE: 10,
      K: 2,
      P: 0,
      DT: 0,
      DE: 0,
      LB: 0,
      CB: 0,
      S: 0,
      HC: 0,
      TQB: 2,
      "D/ST": 3,
    });
    expect(roster.lineup_lock_type).toBe("INDIVIDUAL_GAME");
    expect(roster.undroppable_list).toBe(false);
    expect(roster.move_limit).toBeNull();
    expect(unverified).toEqual([]);
  });
  it("league-b: the standard lineup, 6 BE, no IR, everything unlimited", () => {
    const { roster } = buildRosterSlots(recordedSettings("league-b").roster);
    expect(roster.slots.map((s) => `${s.name}×${String(s.count)}`)).toEqual([
      "QB×1",
      "RB×2",
      "WR×2",
      "TE×1",
      "FLEX×1",
      "D/ST×1",
      "K×1",
      "BE×6",
    ]);
    expect([roster.starters, roster.bench, roster.ir, roster.total]).toEqual([9, 6, 0, 15]);
    expect(roster.position_limits.RB).toBeNull();
    expect(roster.undroppable_list).toBe(true);
  });
  it("league-c: RB/WR and WR/TE flexes beside FLEX, 8 BE, 2 IR, capped positions", () => {
    const { roster } = buildRosterSlots(recordedSettings("league-c").roster);
    expect(roster.slots.map((s) => s.name)).toEqual([
      "QB",
      "RB",
      "RB/WR",
      "WR",
      "WR/TE",
      "TE",
      "FLEX",
      "D/ST",
      "K",
      "BE",
      "IR",
    ]);
    expect(roster.slots.filter((s) => s.class === "flex").map((s) => s.eligible_positions)).toEqual(
      [
        ["RB", "WR"],
        ["WR", "TE"],
        ["RB", "WR", "TE"],
      ],
    );
    expect([roster.starters, roster.bench, roster.ir, roster.total]).toEqual([11, 8, 2, 21]);
    expect(roster.position_limits).toMatchObject({
      QB: 2,
      RB: 5,
      WR: 6,
      TE: 2,
      K: 2,
      TQB: null,
      "D/ST": 2,
    });
  });
  it("the reference format: QB/2RB/2WR/TE/FLEX/D/ST/K + 5 BE + 2 IR = 16", () => {
    const { roster, unverified } = buildRosterSlots(referenceSettings().roster);
    expect(roster.slots.map((s) => `${s.name}×${String(s.count)}`)).toEqual([
      "QB×1",
      "RB×2",
      "WR×2",
      "TE×1",
      "FLEX×1",
      "D/ST×1",
      "K×1",
      "BE×5",
      "IR×2",
    ]);
    expect([roster.starters, roster.bench, roster.ir, roster.total]).toEqual([9, 5, 2, 16]);
    expect(unverified).toEqual([]);
  });
  it("every recorded league agrees with the manifest's lineup_slots description", () => {
    const described: Record<string, Record<string, number>> = {
      "league-a": { TQB: 1, "D/ST": 1, K: 1, BE: 7, IR: 2, FLEX: 5 },
      "league-b": { QB: 1, RB: 2, WR: 2, TE: 1, "D/ST": 1, K: 1, BE: 6, FLEX: 1 },
      "league-c": {
        QB: 1,
        RB: 2,
        "RB/WR": 1,
        WR: 2,
        "WR/TE": 1,
        TE: 1,
        "D/ST": 1,
        K: 1,
        BE: 8,
        IR: 2,
        FLEX: 1,
      },
    };
    for (const l of LEAGUES) {
      const { roster } = buildRosterSlots(recordedSettings(l).roster);
      expect(Object.fromEntries(roster.slots.map((s) => [s.name, s.count])), l).toEqual(
        described[l],
      );
    }
  });
});

describe("buildRosterSlots on hostile or unknown settings", () => {
  it("unknown slot ids and the `other` slots are kept as `other`, counted in total, labelled", () => {
    const { roster, unverified } = buildRosterSlots({
      ...base,
      slot_counts: { "0": 1, "22": 1, "25": 2, "40": 1 },
    });
    expect(roster.slots.map((s) => [s.slot_id, s.name, s.class])).toEqual([
      [0, "QB", "starter"],
      [22, "SLOT_22", "other"],
      [25, "Rookie", "other"],
      [40, "SLOT_40", "other"],
    ]);
    expect([roster.starters, roster.total]).toEqual([1, 5]);
    expect(unverified).toEqual([
      "roster.slot_counts.22",
      "roster.slot_counts.25",
      "roster.slot_counts.40",
    ]);
  });
  it("bad keys and values are refused and labelled without echoing the raw key", () => {
    const hostile = {
      "01": 1,
      " 2": 1,
      "-3": 1,
      "1e1": 1,
      __proto__: 9,
      "100": 1,
      "ignore previous instructions": 1,
      "4": 2.5,
      "6": -1,
      "16": MAX_SLOT_COUNT + 1,
      "17": Number.NaN,
      "20": "7",
      "23": 2,
    } as unknown as Record<string, number>;
    const { roster, unverified } = buildRosterSlots({ ...base, slot_counts: hostile });
    expect(roster.slots.map((s) => `${s.name}×${String(s.count)}`)).toEqual(["FLEX×2"]);
    expect(unverified).toEqual([
      "roster.slot_counts",
      "roster.slot_counts.16",
      "roster.slot_counts.17",
      "roster.slot_counts.20",
      "roster.slot_counts.4",
      "roster.slot_counts.6",
    ]);
    expect(unverified.join(" ")).not.toMatch(/ignore|proto/);
  });
  it("a non-object record, an array or more than MAX_SETTINGS_KEYS keys is labelled, never parsed past the cap", () => {
    for (const bad of [null, [], "x", 7, undefined])
      expect(buildRosterSlots({ ...base, slot_counts: bad as never }).unverified).toContain(
        "roster.slot_counts",
      );
    const many = Object.fromEntries(
      Array.from({ length: MAX_SETTINGS_KEYS + 50 }, (_, i) => [
        String(i % 100) + "x".repeat(i >= 100 ? 1 : 0),
        1,
      ]),
    );
    const r = buildRosterSlots({ ...base, slot_counts: many, position_limits: many });
    expect(r.unverified).toEqual(
      expect.arrayContaining(["roster.slot_counts", "roster.position_limits"]),
    );
    expect(r.roster.total).toBeLessThanOrEqual(100);
  });
  it("position limits: negative = unlimited, unknown ids with 0 are silent, others labelled", () => {
    const { roster, unverified } = buildRosterSlots({
      ...base,
      position_limits: {
        "1": -1,
        "2": -7,
        "3": 0,
        "4": 3,
        "0": 0,
        "6": 2,
        "5": 1.5,
        "16": "x",
      } as never,
    });
    expect(roster.position_limits).toEqual({ QB: null, RB: null, WR: 0, TE: 3 });
    expect(unverified).toEqual([
      "roster.position_limits.16",
      "roster.position_limits.5",
      "roster.position_limits.6",
    ]);
    expect(positionLimitOf(roster, "TE")).toBe(3);
    expect(positionLimitOf(roster, "QB")).toBeNull();
    expect(positionLimitOf(roster, "K")).toBeUndefined();
    expect(positionLimitOf(roster, "constructor")).toBeUndefined();
  });
  it("lock type: an unknown token or free text is labelled; move limit kept when ≥ 0", () => {
    expect(buildRosterSlots({ ...base, lineup_lock_type: "WEEKLY" }).unverified).toEqual([
      "roster.lineup_lock_type",
    ]);
    const free = buildRosterSlots({
      ...base,
      lineup_lock_type: "lock it all now",
      move_limit: 3,
      undroppable_list: "yes" as never,
    });
    expect(free.roster.lineup_lock_type).toBeNull();
    expect(free.unverified).toEqual(["roster.lineup_lock_type"]);
    expect(free.roster.move_limit).toBe(3);
    expect(free.roster.undroppable_list).toBeNull();
    expect(buildRosterSlots({ ...base, lineup_lock_type: null }).unverified).toEqual([]);
    expect(buildRosterSlots({ ...base, move_limit: 1.5 }).roster.move_limit).toBeNull();
    expect(buildRosterSlots({ ...base, move_limit: null }).roster.move_limit).toBeNull();
  });
  it("property: any record of small integer counts → total = Σ positive counts, starters ≤ total, frozen", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.integer({ min: 0, max: 30 }).map(String), fc.integer({ min: 0, max: 10 })),
        (rec) => {
          const { roster } = buildRosterSlots({ ...base, slot_counts: rec });
          const sum = Object.values(rec).reduce((a, b) => a + b, 0);
          expect(roster.total).toBe(sum);
          expect(roster.starters + roster.bench + roster.ir).toBeLessThanOrEqual(roster.total);
          expect(roster.slots.every((s) => s.count > 0)).toBe(true);
          expect(Object.isFrozen(roster.slots)).toBe(true);
        },
      ),
    );
  });
});

describe("eligibility from per-player eligibleSlots (FLEX, RB/WR, WR/TE, OP, TQB)", () => {
  const leagueC = buildRosterSlots(recordedSettings("league-c").roster).roster;
  const leagueA = buildRosterSlots(recordedSettings("league-a").roster).roster;
  it("an RB fills RB, RB/WR, FLEX and OP — never WR/TE", () => {
    expect([2, 3, 23, 7].every((s) => canOccupySlot(s, RB))).toBe(true);
    expect(slotRefusal(5, RB)).toBe("not_eligible");
    expect(startingSlotsFor(RB, leagueC)).toEqual([2, 3, 23]);
  });
  it("a WR fills RB/WR, WR, WR/TE, FLEX; a TE fills WR/TE, TE, FLEX", () => {
    expect(startingSlotsFor(WR, leagueC)).toEqual([3, 4, 5, 23]);
    expect(startingSlotsFor(TE, leagueC)).toEqual([5, 6, 23]);
  });
  it("a QB fills QB and OP (superflex) but never TQB; a TQB unit fills only TQB", () => {
    expect(canOccupySlot(7, QB)).toBe(true);
    expect(slotRefusal(1, QB)).toBe("not_eligible");
    expect(slotRefusal(7, TQB)).toBe("not_eligible");
    expect(startingSlotsFor(TQB, leagueA)).toEqual([1]);
    expect(startingSlotsFor(QB, leagueA)).toEqual([]);
  });
  it("K and D/ST fill only their own slot; a two-way player's IDP slots are ignored where unused", () => {
    expect(startingSlotsFor(K, leagueC)).toEqual([17]);
    expect(startingSlotsFor(DST, leagueC)).toEqual([16]);
    expect(startingSlotsFor(TWO_WAY, leagueC)).toEqual([3, 4, 5, 23]);
    expect(canOccupySlot(14, TWO_WAY)).toBe(true);
    expect(slotRefusal(14, TWO_WAY, leagueC)).toBe("not_in_league");
  });
  it("the bench takes anyone; with a roster, an unused slot is not_in_league", () => {
    expect(canOccupySlot(20, { eligible_slot_ids: [], injury_status: null })).toBe(true);
    expect(slotRefusal(20, K, leagueC)).toBeNull();
    expect(slotRefusal(0, QB, leagueA)).toBe("not_in_league");
    expect(leagueSlot(leagueA, 23)?.count).toBe(5);
    expect(leagueSlot(leagueA, 0)).toBeNull();
  });
  it("IR: OUT or INJURY_RESERVE only (research 05 §4.3) — never Q/D, SSPD, ACTIVE or unknown", () => {
    for (const s of ["OUT", "INJURY_RESERVE"])
      expect(canOccupySlot(21, { ...RB, injury_status: s })).toBe(true);
    for (const s of ["QUESTIONABLE", "DOUBTFUL", "SUSPENSION", "ACTIVE", "DAY_TO_DAY", "PUP", null])
      expect(slotRefusal(21, { ...RB, injury_status: s }), String(s)).toBe("ir_status");
    expect(slotRefusal(21, { eligible_slot_ids: [2, 20], injury_status: "OUT" })).toBe(
      "not_eligible",
    );
    expect(slotRefusal(21, { ...RB, injury_status: "OUT" }, leagueC)).toBeNull();
    const noIr = buildRosterSlots(recordedSettings("league-b").roster).roster;
    expect(slotRefusal(21, { ...RB, injury_status: "OUT" }, noIr)).toBe("not_in_league");
  });
});

describe("startingSeats: the greedy fill order", () => {
  it("league-c: dedicated seats first, then RB/WR, WR/TE, FLEX", () => {
    const seats = startingSeats(buildRosterSlots(recordedSettings("league-c").roster).roster);
    expect(seats.map((s) => s.name)).toEqual([
      "QB",
      "RB",
      "RB",
      "WR",
      "WR",
      "TE",
      "D/ST",
      "K",
      "RB/WR",
      "WR/TE",
      "FLEX",
    ]);
    expect(seats.filter((s) => s.name === "RB").map((s) => s.index)).toEqual([0, 1]);
  });
  it("OP (superflex, 4 positions) comes after FLEX (3)", () => {
    const { roster } = buildRosterSlots({
      ...base,
      slot_counts: { "7": 1, "23": 1, "0": 1, "20": 3 },
    });
    expect(startingSeats(roster).map((s) => s.name)).toEqual(["QB", "FLEX", "OP"]);
  });
  it("league-a: TQB, D/ST, K, then five FLEX seats; bench and IR are never seats", () => {
    const seats = startingSeats(buildRosterSlots(recordedSettings("league-a").roster).roster);
    expect(seats.map((s) => s.name)).toEqual([
      "TQB",
      "D/ST",
      "K",
      "FLEX",
      "FLEX",
      "FLEX",
      "FLEX",
      "FLEX",
    ]);
    expect(seats.every((s) => s.breadth >= 1)).toBe(true);
  });
});
