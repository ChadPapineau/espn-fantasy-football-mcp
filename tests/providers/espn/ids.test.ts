// ids.test.ts — src/providers/espn/ids.ts, a 100 %-coverage module (plan 05 §2 `providers/espn/ids`):
// the slot map and the position map are DIFFERENT (slot(1) = TQB, position(1) = QB — the S-JS bug,
// research 03 §B.2); every lineupSlotId and defaultPositionId in every recorded fixture decodes;
// unknown ids produce a typed `unknown`, never a crash; positionalRatings keys decode to positions.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decodePosition,
  decodeSlot,
  isIdInteger,
  proTeamAbbrev,
  slotIdsForName,
  teamUnitPosition,
} from "../../../src/providers/espn/ids.js";
import { POSITIONAL_RATING_POSITION_IDS } from "../../../src/providers/espn/types.js";
import { loadFixture } from "./helpers.js";

describe("two id spaces (research 03 §B.2 trap)", () => {
  it("slot 1 is TQB, position 1 is QB; slot 2 is RB, position 2 is RB; slot 4 WR vs position 4 TE", () => {
    expect(decodeSlot(1).name).toBe("TQB");
    expect(decodePosition(1).name).toBe("QB");
    expect(decodeSlot(4).name).toBe("WR");
    expect(decodePosition(4).name).toBe("TE");
    expect(decodeSlot(16).name).toBe("D/ST");
    expect(decodePosition(16)).toMatchObject({ name: "D/ST", class: "DST", known: true });
    expect(decodePosition(15)).toMatchObject({ name: "TQB", class: "O" });
  });
  it("slot classes and flex", () => {
    expect(decodeSlot(20)).toMatchObject({
      name: "BE",
      class: "bench",
      is_flex: false,
      known: true,
    });
    expect(decodeSlot(21)).toMatchObject({ name: "IR", class: "ir" });
    expect(decodeSlot(23)).toMatchObject({ name: "FLEX", class: "flex", is_flex: true });
  });
  it("unknown ids are typed unknowns", () => {
    expect(decodeSlot(77)).toEqual({
      id: 77,
      name: "slot_77",
      class: "other",
      is_flex: false,
      known: false,
    });
    expect(decodePosition(8)).toEqual({ id: 8, name: "pos_8", class: null, known: false });
    expect(() => decodeSlot(-1)).toThrow(RangeError);
    expect(() => decodePosition(100)).toThrow(RangeError);
  });
  it("isIdInteger bounds", () => {
    for (const ok of [0, 25, 99]) expect(isIdInteger(ok)).toBe(true);
    for (const bad of [-1, 100, 1.5, "1", null, Number.NaN]) expect(isIdInteger(bad)).toBe(false);
  });
});

describe("name lookups and pro teams", () => {
  it("slot names → slot ids; position names → their single-position slot", () => {
    expect(slotIdsForName("FLEX")).toEqual([23]);
    expect(slotIdsForName("D/ST")).toEqual([16]);
    expect(slotIdsForName("QB")).toEqual([0]);
    expect(slotIdsForName("")).toBeNull();
    expect(slotIdsForName("Quarterback")).toBeNull();
    expect(slotIdsForName("K")).toEqual([17]);
    expect(slotIdsForName("TQB")).toEqual([1]);
  });
  it("pro teams and team units", () => {
    expect(proTeamAbbrev(0)).toBe("FA");
    expect(proTeamAbbrev(28)).toBe("WSH");
    expect(proTeamAbbrev(31)).toBeNull();
    expect(teamUnitPosition(-16034)).toBe(16);
    expect(teamUnitPosition(-15002)).toBe(15);
    expect(teamUnitPosition(4242335)).toBeNull();
  });
  it("positionalRatings keys decode to positions", () => {
    for (const p of POSITIONAL_RATING_POSITION_IDS) expect(decodePosition(p).known).toBe(true);
  });
});

describe("every id in the recorded fixtures decodes with its own map", () => {
  const leagues = ["league-a", "league-b", "league-c"];
  it("lineupSlotId / eligibleSlots via the slot map; defaultPositionId via the position map", () => {
    const slots = new Set<number>();
    const positions = new Set<number>();
    const walk = (v: unknown, key: string | null): void => {
      if (Array.isArray(v)) {
        for (const x of v) {
          if (key === "eligibleSlots" && typeof x === "number") slots.add(x);
          walk(x, key);
        }
        return;
      }
      if (typeof v !== "object" || v === null) return;
      for (const [k, x] of Object.entries(v)) {
        if (k === "lineupSlotId" && typeof x === "number") slots.add(x);
        if (k === "defaultPositionId" && typeof x === "number") positions.add(x);
        walk(x, k);
      }
    };
    for (const l of leagues) {
      walk(loadFixture(`recorded/${l}/mRoster.sp1.p1.json`), null);
      walk(loadFixture(`recorded/${l}/kona_player_info.json`), null);
      walk(loadFixture(`recorded/${l}/mBoxscore.sp3.json`), null);
    }
    walk(loadFixture("recorded/season/players_wl.json"), null);
    expect(slots.size).toBeGreaterThan(5);
    for (const s of slots) expect(decodeSlot(s).known, `slot ${String(s)}`).toBe(true);
    for (const p of positions) expect(decodePosition(p).known, `position ${String(p)}`).toBe(true);
  });
  it("property: decode never throws on 0..99 and names never cross maps for an unknown id", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 99 }), (n) => {
        const s = decodeSlot(n);
        const p = decodePosition(n);
        if (!s.known) expect(s.name).toBe(`slot_${String(n)}`);
        if (!p.known) expect(p.name).toBe(`pos_${String(n)}`);
      }),
    );
  });
});
