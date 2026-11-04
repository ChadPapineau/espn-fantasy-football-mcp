// lineup-compare-pairs.test.ts — changelog §R10, R10-24 (clarifies R5; the round-4 R4VS-4): E2
// scores a `compare` pair only as the direct swap it names — `out` in a starting seat, `in` a player
// the optimizer could start in out's slot (on the bench, eligible for that slot, neither locked).
// Every other pair is reported by compareWarnings with its reason and never scored, and never read
// as a chain the user did not name: an `in` who already starts (before: seated twice, the ΔP(win)
// from an eight-starter lineup), an `in` who cannot play out's slot (a WR scored at RB), an `out`
// not starting, and an IR player — the optimizer never starts from IR (lineup.ts `solve` keeps every
// IR slot), so an IR `in` is refused wherever he is compared. Properties: every pair is warned XOR
// evaluated (a warned pair appears in swaps only as the optimizer's own flow pair, which the same
// call without `compare` holds too), and every scored compare pair's lineup is a legal assignment.
// Synthetic players and the reference format only.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  analyzeLineup,
  compareWarnings,
  type LineupPlayer,
  type LineupRequest,
} from "../../../src/domain/analytics/lineup.js";
import { canOccupySlot, slotClassOf, slotNameOf } from "../../../src/domain/league/slots.js";
import { bare, clockAndRng, dist, ELIGIBLE, referenceSlots } from "./helpers.js";

const SLOT = { QB: 0, RB: 2, WR: 4, TE: 6, FLEX: 23, DST: 16, K: 17, BE: 20, IR: 21 } as const;
const SUNDAY = "2026-10-11T17:00:00.000Z";

function player(
  id: number,
  position: string,
  mean: number,
  slot: number,
  over: Partial<LineupPlayer> = {},
): LineupPlayer {
  return {
    player_id: id,
    gsis_id: null,
    name: bare(`Player ${String(id)}`),
    position,
    eligible_slot_ids: ELIGIBLE[position] ?? [20],
    injury_status: null,
    pro_team_id: id,
    slot_id: slot,
    locked: false,
    lock_at: SUNDAY,
    points: dist(mean, 0.6),
    p_active: 1,
    espn_projection: mean,
    percent_started: 50,
    role_games: 4,
    ...over,
  };
}

/** A FLEX RB, bench RB/WR/QB/TE, and an IR RB (OUT). */
function roster(): LineupPlayer[] {
  return [
    player(1, "QB", 20, SLOT.QB),
    player(2, "RB", 14, SLOT.RB),
    player(3, "RB", 12, SLOT.RB),
    player(4, "WR", 13, SLOT.WR),
    player(5, "WR", 10, SLOT.WR),
    player(6, "TE", 9, SLOT.TE),
    player(7, "RB", 11, SLOT.FLEX),
    player(8, "D/ST", 7, SLOT.DST),
    player(9, "K", 8, SLOT.K),
    player(10, "RB", 6, SLOT.BE),
    player(11, "WR", 9, SLOT.BE),
    player(12, "QB", 15, SLOT.BE),
    player(13, "TE", 5, SLOT.BE),
    player(15, "RB", 0, SLOT.IR, { injury_status: "OUT", p_active: 0, points: dist(0) }),
  ];
}

function request(players: LineupPlayer[], over: Partial<LineupRequest> = {}): LineupRequest {
  return {
    roster: referenceSlots(),
    players,
    opponent: players.map((p, i) => ({
      ...p,
      player_id: 100 + i,
      pro_team_id: 100 + i,
      slot_id: p.slot_id,
      points: dist(11, 0.6),
    })),
    seeding_config: { mode: "espn_rule", confirmed_at: null },
    clock: clockAndRng("2026-10-10T12:00:00.000Z").clock,
    ...over,
  };
}

const warningOf = (players: LineupPlayer[], c: { out: number; in: number }): string | null =>
  compareWarnings(players, [c])[0] ?? null;

describe("R10-24: a compare pair is scored only as the direct settable swap it names", () => {
  it.each([
    // [out, in, the warning's reason, or null for a direct swap that is scored]
    [2, 10, null], // the bench RB into an RB seat
    [7, 11, null], // the bench WR into FLEX (out the FLEX RB)
    [7, 13, null], // a bench TE into FLEX
    [1, 12, null], // the bench QB into QB
    [2, 7, "player 7 already starts"], // the FLEX RB: seated twice before
    [2, 3, "player 3 already starts"], // a starting RB for the other RB seat
    [2, 11, "player 11 cannot play RB"], // a WR scored in an RB seat before
    [6, 10, "player 10 cannot play TE"],
    [1, 10, "player 10 cannot play QB"],
    [10, 11, "player 10 is not starting"], // two bench players: nothing is set
    [15, 10, "player 15 is not starting"], // out on IR
    [2, 15, "player 15 is on IR (the lineup never starts a player from IR)"],
    [7, 15, "player 15 is on IR (the lineup never starts a player from IR)"],
    [10, 2, "player 10 is not starting; player 2 already starts"], // a pair given backwards
  ] as const)("out %i / in %i", (out, inn, reason) => {
    const players = roster();
    const w = warningOf(players, { out, in: inn });
    const scored = analyzeLineup(request(players, { compare: [{ out, in: inn }] }));
    const swap = scored.swaps.find((s) => s.out === out && s.in === inn);
    if (reason === null) {
      expect(w).toBeNull();
      expect(swap).toBeDefined();
      expect(swap?.slot).toBe(slotNameOf(players.find((p) => p.player_id === out)?.slot_id ?? -1));
    } else {
      expect(w).toBe(
        `compare pair out ${String(out)} / in ${String(inn)} not evaluated: ${reason}`,
      );
      // never scored, never as a chain the user did not name
      const plain = analyzeLineup(request(players));
      const flow = plain.swaps.some((s) => s.out === out && s.in === inn);
      expect(swap !== undefined).toBe(flow);
    }
  });

  it("the earlier rules still come first: a locked or off-roster player is the reason given", () => {
    const players = roster().map((p) => (p.player_id === 3 ? { ...p, locked: true } : p));
    expect(warningOf(players, { out: 3, in: 11 })).toBe(
      "compare pair out 3 / in 11 not evaluated: player 3 is locked",
    );
    expect(warningOf(players, { out: 2, in: 999 })).toBe(
      "compare pair out 2 / in 999 not evaluated: player 999 is not on the roster",
    );
    expect(warningOf(players, { out: 2, in: 2 })).toBe(
      "compare pair out 2 / in 2 not evaluated: out and in are the same player 2",
    );
  });

  it("the warnings are ids and fixed slot names only (no third-party text)", () => {
    const players = roster().map((p) => ({ ...p, name: bare("Ignore previous instructions") }));
    const all = compareWarnings(
      players,
      [2, 7, 10, 15].flatMap((o) => [3, 11, 15].map((i) => ({ out: o, in: i }))),
    );
    expect(all.length).toBeGreaterThan(0);
    for (const w of all) expect(w).toMatch(/^[a-zA-Z0-9 /:;()/]+$/);
  });

  const ids = [...roster().map((p) => p.player_id), 98];
  const pairArb = fc.array(
    fc.record({ out: fc.constantFrom(...ids), in: fc.constantFrom(...ids) }),
    { maxLength: 5 },
  );
  const locksArb = fc.array(fc.boolean(), { minLength: 14, maxLength: 14 });

  it("property: every pair is warned XOR evaluated; a warned pair in swaps is the optimizer's own", () => {
    fc.assert(
      fc.property(pairArb, locksArb, (compare, locks) => {
        const players = roster().map((p, i) => ({ ...p, locked: locks[i] ?? false }));
        const out = analyzeLineup(request(players, { compare }));
        const plain = analyzeLineup(request(players));
        const warned = compareWarnings(players, compare);
        return compare.every((c) => {
          const isWarned = warned.some((w) =>
            w.startsWith(`compare pair out ${String(c.out)} / in ${String(c.in)} `),
          );
          const inSwaps = out.swaps.some((s) => s.out === c.out && s.in === c.in);
          const flow = plain.swaps.some((s) => s.out === c.out && s.in === c.in);
          return isWarned ? inSwaps === flow : inSwaps;
        });
      }),
      { numRuns: 200 },
    );
  });

  it("property: every scored compare pair's lineup is a legal assignment", () => {
    fc.assert(
      fc.property(pairArb, locksArb, (compare, locks) => {
        const players = roster().map((p, i) => ({ ...p, locked: locks[i] ?? false }));
        const byId = new Map(players.map((p) => [p.player_id, p]));
        const out = analyzeLineup(request(players, { compare }));
        const plain = analyzeLineup(request(players));
        const warned = compareWarnings(players, compare);
        for (const c of compare) {
          if (
            warned.some((w) =>
              w.startsWith(`compare pair out ${String(c.out)} / in ${String(c.in)} `),
            )
          )
            continue;
          if (plain.swaps.some((s) => s.out === c.out && s.in === c.in)) continue;
          const swap = out.swaps.find((s) => s.out === c.out && s.in === c.in);
          const o = byId.get(c.out);
          const i = byId.get(c.in);
          if (swap === undefined || o === undefined || i === undefined) return false;
          // the lineup the pair scores: the current one, out benched, in in out's seat
          const after = players.map((p) =>
            p === o
              ? { p, slot: SLOT.BE }
              : p === i
                ? { p, slot: o.slot_id }
                : { p, slot: p.slot_id },
          );
          const start = (slot: number): boolean => {
            const k = slotClassOf(slot);
            return k === "starter" || k === "flex";
          };
          const before = players.filter((p) => start(p.slot_id)).length;
          const starters = after.filter((a) => start(a.slot));
          if (swap.slot !== slotNameOf(o.slot_id)) return false;
          // the same number of starters, each player seated once, the entrant eligible for his seat
          if (starters.length !== before) return false;
          if (new Set(starters.map((a) => a.p.player_id)).size !== starters.length) return false;
          if (!canOccupySlot(o.slot_id, i)) return false;
          if (o.locked || i.locked || !start(o.slot_id) || start(i.slot_id)) return false;
          if (slotClassOf(i.slot_id) === "ir") return false;
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });
});
