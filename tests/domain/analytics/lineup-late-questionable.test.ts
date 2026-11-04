// lineup-late-questionable.test.ts — the round-3b Skills verifier's V-6, read at source (plan 07 E2
// `conditionals[]: { if: { player_id, event: "inactive", decided_by }, then: { slot, in } }` and
// `swaps[].option_value: { kind, value, verdict } | null`; research 05 §5 Start/sit and sibling §3.4:
// the option value of a later game is (1 − P(active)) × the best reserve still open once his status
// is decided). On fx-10h's questionable-late variant the QUESTIONABLE starter plays Monday night and
// his only replacement chain (the FLEX RB into his RB seat, a bench WR into FLEX) locks on Sunday.
// The specified answer: a conditional is one move that can still be made when the inactives are
// known (`decided_by`, 90 min before his kickoff); every player who could take his seat, or move in a
// chain, is locked by then, so there is NO conditional — conditionals [] is right, not a missing
// output. The option value belongs to a swap row: a swap involving him (a compare pair) carries
// { kind: "monday", value: 0 } — an option that exists and is worth nothing, because no reserve opens
// after the decision — and a swap that involves no Thursday, Monday or late questionable game
// carries null (no option at all). Controls: a bench RB with a Monday game makes the conditional and a
// positive option value. The domain engine only; tests/mcp/questionable-late.test.ts runs the tool on
// the committed variant.
import { describe, expect, it } from "vitest";
import {
  analyzeLineup,
  type LineupPlayer,
  type LineupRequest,
} from "../../../src/domain/analytics/lineup.js";
import { bare, clockAndRng, dist, ELIGIBLE, referenceSlots } from "./helpers.js";

const SLOT = { QB: 0, RB: 2, WR: 4, TE: 6, FLEX: 23, DST: 16, K: 17, BE: 20, IR: 21 } as const;
const SUNDAY_EARLY = "2026-10-11T13:30:00.000Z";
const SUNDAY = "2026-10-11T17:00:00.000Z";
const MONDAY = "2026-10-13T00:15:00.000Z";
const INACTIVES_LEAD_MS = 90 * 60_000;

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
    points: dist(mean, position === "QB" ? 0.4 : 0.6),
    p_active: 1,
    espn_projection: mean,
    percent_started: 50,
    role_games: 4,
    ...over,
  };
}

/**
 * questionable-late's shape: RB 2 QUESTIONABLE on Monday night; the FLEX is an RB (7) whose game is
 * Sunday's first; the bench RB (10) and WR (11) play Sunday; a bench RB (14) is OUT.
 */
function lateRoster(benchRbAt: string = SUNDAY): LineupPlayer[] {
  return [
    player(1, "QB", 20, SLOT.QB),
    player(2, "RB", 14, SLOT.RB, { lock_at: MONDAY, p_active: 0.6, injury_status: "QUESTIONABLE" }),
    player(3, "RB", 12, SLOT.RB),
    player(4, "WR", 13, SLOT.WR),
    player(5, "WR", 10, SLOT.WR),
    player(6, "TE", 9, SLOT.TE),
    player(7, "RB", 11, SLOT.FLEX, { lock_at: SUNDAY_EARLY }),
    player(8, "D/ST", 7, SLOT.DST, { lock_at: MONDAY }),
    player(9, "K", 8, SLOT.K, { lock_at: SUNDAY_EARLY }),
    player(10, "RB", 6, SLOT.BE, { lock_at: benchRbAt }),
    player(11, "WR", 9, SLOT.BE),
    player(12, "QB", 15, SLOT.BE),
    player(14, "RB", 4, SLOT.BE, { p_active: 0, injury_status: "OUT", points: dist(0) }),
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
      p_active: 1,
      lock_at: SUNDAY,
      points: dist(11, 0.6),
    })),
    seeding_config: { mode: "espn_rule", confirmed_at: null },
    // Saturday: nothing has locked yet
    clock: clockAndRng("2026-10-10T12:00:00.000Z").clock,
    ...over,
  };
}

describe("V-6: a QUESTIONABLE Monday-night starter whose every replacement locks on Sunday", () => {
  it("no conditional: nothing can still move when his status is decided", () => {
    const out = analyzeLineup(request(lateRoster()));
    expect(out.conditionals.filter((c) => c.if.player_id === 2)).toEqual([]);
  });

  it("a swap involving him carries the Monday option, worth 0 (no reserve opens after the decision)", () => {
    const out = analyzeLineup(request(lateRoster(), { compare: [{ out: 2, in: 10 }] }));
    const swap = out.swaps.find((s) => s.out === 2 && s.in === 10);
    expect(swap?.option_value).toMatchObject({ kind: "monday", value: 0 });
    // the verdict says why, never the option as the reason to hold (the round-4 F7 / R4VS-5): the
    // swap loses points, and waiting is worth nothing because nothing opens after Monday's news
    expect(swap?.option_value?.verdict).toBe(
      "hold: the swap loses expected points; waiting has no option value (nothing opens after his status is known)",
    );
    // a swap with no Thursday, Monday or late questionable game has no option at all: null
    for (const s of out.swaps.filter((x) => x.out !== 2 && x.in !== 2 && x.out !== 8))
      expect(s.option_value, `${String(s.out)}→${String(s.in)}`).toBeNull();
  });

  it("control: a bench RB with a Monday game is the conditional, and the option is worth (1 − p) × his mean", () => {
    const players = lateRoster(MONDAY);
    // the direct settable swap (changelog §R10, R10-24): the Sunday bench RB 14 for RB 2 — the
    // starting RB 3 is no `in` (he already starts; that pair is warned, never scored)
    const out = analyzeLineup(request(players, { compare: [{ out: 2, in: 14 }] }));
    const c = out.conditionals.find((x) => x.if.player_id === 2);
    expect(c).toEqual({
      if: {
        player_id: 2,
        event: "inactive",
        decided_by: new Date(Date.parse(MONDAY) - INACTIVES_LEAD_MS).toISOString(),
      },
      then: { slot: "RB", in: 10 },
    });
    const swap = out.swaps.find((s) => s.out === 2 && s.in === 14);
    expect(swap?.option_value?.kind).toBe("monday");
    expect(swap?.option_value?.value).toBeCloseTo((1 - 0.6) * 6, 3);
    expect(swap?.option_value?.verdict).toBe(
      "hold: the swap loses expected points and gives up the option value of the later game",
    );
  });
});
