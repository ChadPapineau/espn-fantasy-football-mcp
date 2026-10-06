// p1-helpers.ts — builders shared by the Phase-2 market-engine tests: the reference-format E5
// scenario (the same roster and candidates as waivers.test.ts, so P0 and P1 compare like for like),
// rivals' rosters, and trade players. Synthetic data only (fake ids, "Player N" names).
import type {
  WaiverCandidateInput,
  WaiverPlayer,
  WaiverRequest,
} from "../../../src/domain/analytics/waivers.js";
import type { TradePlayer } from "../../../src/domain/analytics/trade.js";
import {
  bare,
  clockAndRng,
  ELIGIBLE,
  instantPacer,
  POSITION_ID,
  referenceRules,
  referenceSlots,
} from "./helpers.js";

export const WEEK = 4;
/** 4..17 → W = 13 after this week (research 05 §1.2; changelog R5-1). */
export const WEEKS: readonly number[] = Array.from({ length: 14 }, (_, i) => WEEK + i);
export const SLOT = {
  QB: 0,
  RB: 2,
  WR: 4,
  TE: 6,
  FLEX: 23,
  DST: 16,
  K: 17,
  BE: 20,
  IR: 21,
} as const;

export function wp(
  id: number,
  position: string,
  perWeek: number,
  slot: number,
  over: Partial<WaiverPlayer> = {},
): WaiverPlayer {
  return {
    player_id: id,
    gsis_id: null,
    name: bare(`Player ${String(id)}`),
    position,
    position_id: POSITION_ID[position] ?? 1,
    eligible_slot_ids: ELIGIBLE[position] ?? [20],
    injury_status: null,
    pro_team_id: (id % 32) + 1,
    slot_id: slot,
    locked: false,
    droppable: true,
    weekly: WEEKS.map(() => perWeek),
    percent_owned: 10,
    ...over,
  };
}

export function wc(
  id: number,
  position: string,
  perWeek: number,
  status: "FREEAGENT" | "WAIVERS" = "WAIVERS",
  over: Partial<WaiverCandidateInput> = {},
): WaiverCandidateInput {
  return {
    ...wp(id, position, perWeek, SLOT.BE),
    status,
    waiver_process_date: null,
    percent_change: 1.5,
    ...over,
  };
}

/** A full reference roster: 9 starters + 5 bench and one OUT player in IR. */
export function myRoster(): WaiverPlayer[] {
  return [
    wp(1, "QB", 18, SLOT.QB),
    wp(2, "RB", 14, SLOT.RB),
    wp(3, "RB", 10, SLOT.RB),
    wp(4, "WR", 12, SLOT.WR),
    wp(5, "WR", 8, SLOT.WR),
    wp(6, "TE", 8, SLOT.TE),
    wp(7, "RB", 7.5, SLOT.FLEX),
    wp(8, "D/ST", 7, SLOT.DST),
    wp(9, "K", 8, SLOT.K),
    wp(10, "RB", 6, SLOT.BE),
    wp(11, "WR", 5, SLOT.BE),
    wp(12, "WR", 4, SLOT.BE),
    wp(13, "TE", 3, SLOT.BE),
    wp(14, "RB", 2, SLOT.BE),
    wp(15, "WR", 0, SLOT.IR, { injury_status: "OUT" }),
  ];
}

export const CANDIDATES: readonly WaiverCandidateInput[] = [
  wc(101, "WR", 14), // a clear upgrade
  wc(102, "RB", 10.5), // ~ the premium: inside the band
  wc(103, "WR", 8.5), // a small upgrade that will not clear
  wc(104, "QB", 18.3), // a tiny upgrade that probably clears
  wc(105, "RB", 9, "FREEAGENT"),
  wc(106, "K", 6), // worse than my K
];

export const RIVALS = Array.from({ length: 9 }, (_, i) => ({
  team_id: i + 2,
  waiver_rank: i < 1 ? 1 : i + 2,
  ir_blocked: false,
}));

export function waiverRequest(over: Partial<WaiverRequest> = {}): WaiverRequest {
  return {
    roster: referenceSlots(),
    rules: referenceRules(),
    league_size: 10,
    week: WEEK,
    weeks: WEEKS,
    mine: myRoster(),
    candidates: CANDIDATES,
    k: 2,
    rivals: RIVALS,
    clock: clockAndRng("2026-10-06T20:00:00.000Z").clock,
    pacer: instantPacer,
    ...over,
  };
}

/** A rival roster: a standard lineup at `level` points a starter, thin at `thin` (low there). */
export function rivalRoster(teamId: number, level: number, thin: string | null): WaiverPlayer[] {
  const at = (pos: string, base: number): number => (pos === thin ? base * 0.4 : base);
  const id = (k: number): number => teamId * 100 + k;
  return [
    wp(id(1), "QB", at("QB", level + 6), SLOT.QB),
    wp(id(2), "RB", at("RB", level + 2), SLOT.RB),
    wp(id(3), "RB", at("RB", level), SLOT.RB),
    wp(id(4), "WR", at("WR", level + 2), SLOT.WR),
    wp(id(5), "WR", at("WR", level), SLOT.WR),
    wp(id(6), "TE", at("TE", level - 3), SLOT.TE),
    wp(id(7), "WR", at("WR", level - 2), SLOT.FLEX),
    wp(id(8), "D/ST", 7, SLOT.DST),
    wp(id(9), "K", 8, SLOT.K),
    wp(id(10), "RB", level - 4, SLOT.BE),
    wp(id(11), "WR", level - 4, SLOT.BE),
  ];
}

/** A trade player with constant weekly value. */
export function tp(
  id: number,
  position: string,
  perWeek: number,
  slot: number,
  over: Partial<TradePlayer> = {},
): TradePlayer {
  return {
    player_id: id,
    gsis_id: null,
    name: bare(`Player ${String(id)}`),
    position,
    eligible_slot_ids: ELIGIBLE[position] ?? [20],
    injury_status: null,
    slot_id: slot,
    droppable: true,
    weekly: WEEKS.map(() => perWeek),
    bye_week: null,
    auction_value_average: null,
    ...over,
  };
}

/** A full 14-active + 1-IR trade roster for team `t` at a scoring level. */
export function tradeRoster(
  t: number,
  level: number,
  shape: "balanced" | "rb_rich" | "wr_rich" = "balanced",
): TradePlayer[] {
  const id = (k: number): number => t * 100 + k;
  const rb = shape === "rb_rich" ? 4 : shape === "wr_rich" ? -3 : 0;
  const wr = shape === "wr_rich" ? 4 : shape === "rb_rich" ? -3 : 0;
  return [
    tp(id(1), "QB", level + 6, SLOT.QB),
    tp(id(2), "RB", level + 3 + rb, SLOT.RB),
    tp(id(3), "RB", level + rb, SLOT.RB),
    tp(id(4), "WR", level + 3 + wr, SLOT.WR),
    tp(id(5), "WR", level + wr, SLOT.WR),
    tp(id(6), "TE", level - 3, SLOT.TE),
    tp(id(7), "RB", level - 1 + rb, SLOT.FLEX),
    tp(id(8), "D/ST", 7, SLOT.DST),
    tp(id(9), "K", 8, SLOT.K),
    tp(id(10), "RB", level - 3 + rb, SLOT.BE),
    tp(id(11), "WR", level - 3 + wr, SLOT.BE),
    tp(id(12), "WR", level - 5 + wr, SLOT.BE),
    tp(id(13), "RB", level - 6 + rb, SLOT.BE),
    tp(id(14), "TE", level - 7, SLOT.BE),
    tp(id(15), "WR", 0, SLOT.IR, { injury_status: "OUT" }),
  ];
}
