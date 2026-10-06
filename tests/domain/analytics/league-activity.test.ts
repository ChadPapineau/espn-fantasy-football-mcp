// league-activity.test.ts — E11 (plan 07 E11; research 05 §1.3, §1.6 evals 3–4, §4.3): the window's
// counts by team on fx-10h's own feed (through the provider's normaliser), waiver-order movement and
// its cause, claims by rank, the most added / dropped, rival needs with likely targets and the IR
// block, trades as traded_in / traded_out, team names kept as untrusted_text, and `learned.*`
// flipping from null only when the feed and the stored orders show the case.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  analyzeLeagueActivity,
  type ActivityRequest,
  type ActivityTeam,
} from "../../../src/domain/analytics/leagueActivity.js";
import { claimRuns } from "../../../src/domain/analytics/demand.js";
import {
  isUntrustedText,
  wrapUntrusted,
  type Transaction,
} from "../../../src/domain/league/types.js";
import { newCounts, normalizeTransaction } from "../../../src/providers/espn/normalize.js";
import { clockAndRng, referenceSlots } from "./helpers.js";
import { SLOT, tradeRoster } from "./p1-helpers.js";

function fx10h(): Transaction[] {
  const raw = JSON.parse(
    readFileSync(
      new URL("../../../fixtures/espn/fx-10h/league/mTransactions2.json", import.meta.url),
      "utf8",
    ),
  ) as { transactions: unknown[] };
  const counts = newCounts();
  return raw.transactions
    .map((t) => normalizeTransaction(t, null, counts))
    .filter((t): t is Transaction => t !== null);
}

const TEAMS: ActivityTeam[] = Array.from({ length: 10 }, (_, i) => ({
  team_id: i + 1,
  name: wrapUntrusted(`Team ${String(i + 1).padStart(2, "0")}`, "espn.team.name"),
  rank_before: i + 1,
  rank_now: ((i + 3) % 10) + 1,
  waiver_rank_before: i + 1,
  waiver_rank_now: i + 1,
  ir_blocked: i === 6,
}));

function req(over: Partial<ActivityRequest> = {}): ActivityRequest {
  return {
    since_days: 30,
    transactions: fx10h(),
    teams: TEAMS,
    my_team_id: 2,
    roster: referenceSlots(),
    // fx-10h's clock: Tuesday of week 5
    clock: clockAndRng("2026-10-07T01:00:00.000Z").clock,
    ...over,
  };
}

describe("E11 on fx-10h's feed", () => {
  it("counts claims won and lost, adds and drops, by team", () => {
    const { data } = analyzeLeagueActivity(req());
    expect(data.transactions.claims).toBe(12);
    expect(data.transactions.losing_claims).toBe(1);
    expect(data.transactions.trades).toBe(0);
    expect(data.transactions.adds).toBe(24);
    expect(data.transactions.drops).toBe(24);
    const t2 = data.transactions.by_team.find((t) => t.team_id === 2);
    expect(t2).toMatchObject({ claims_won: 1, claims_lost: 1 });
    expect(t2?.notable.some((n) => n.action === "claim_failed")).toBe(true);
    expect(data.transactions.by_team.every((t) => isUntrustedText(t.name))).toBe(true);
    expect(data.transactions.by_team.every((t) => t.notable.length <= 5)).toBe(true);
  });
  it("a short window excludes older runs; names default to 'Player <id>' (the feed carries none)", () => {
    // 14 days back from week 5's Tuesday: the week-3 run (8 claims) only
    const { data } = analyzeLeagueActivity(req({ since_days: 14 }));
    expect(data.transactions.claims).toBe(8);
    expect(data.transactions.losing_claims).toBe(0);
    expect(data.top_added[0]?.name).toMatch(/^Player -?\d+$/);
    expect(data.window.to).toBe("2026-10-07T01:00:00.000Z");
  });
  it("claims by the claimant's rank before the window", () => {
    const { data } = analyzeLeagueActivity(req());
    const r2 = data.claims_by_rank.find((r) => r.rank === 2);
    expect(r2).toEqual({ rank: 2, won: 1, lost: 1 });
    expect(data.claims_by_rank.map((r) => r.rank)).toEqual(
      [...data.claims_by_rank.map((r) => r.rank)].sort((a, b) => a - b),
    );
  });
  it("learned stays null without stored orders, and says why", () => {
    const { data } = analyzeLeagueActivity(req());
    expect(data.learned).toEqual({
      second_claim_at_new_position: null,
      waiver_rank_moves_on_success: null,
    });
    expect(data.rec?.assumptions.some((a) => a.text.startsWith("no stored waiver order"))).toBe(
      true,
    );
    expect(data.rec?.no_move).toBe(true);
    expect(data.rec?.action).toMatch(
      /^league digest: 12 claims won, 1 lost, 0 trades in 30 days; my waiver rank 2 → 2/,
    );
  });
  it("with the stored orders, a conclusive same-run pair flips learned (plan 10 B4)", () => {
    const pair: Transaction[] = [
      { ...base(9001, "WAIVER", 1, 777), process_date: "2026-10-05T07:30:00.000Z" },
      { ...base(9002, "WAIVER_ERROR", 1, 778), process_date: "2026-10-05T07:30:00.000Z" },
      { ...base(9003, "WAIVER", 3, 778), process_date: "2026-10-05T07:30:00.000Z" },
    ];
    const run = claimRuns(pair)[0]?.run ?? "";
    const out = analyzeLeagueActivity(
      req({
        transactions: [...fx10h(), ...pair],
        order_before: new Map([
          [
            run,
            new Map([
              [1, 1],
              [2, 2],
              [3, 3],
            ]),
          ],
        ]),
        order_after: new Map([
          [
            run,
            new Map([
              [2, 1],
              [1, 3],
              [3, 2],
            ]),
          ],
        ]),
      }),
    );
    expect(out.data.learned.second_claim_at_new_position).toBe(true);
    expect(out.data.learned.waiver_rank_moves_on_success).toBe(true);
    expect(out.mechanics.evidence.new_position_cases).toBe(1);
  });
});

function base(id: number, type: string, team: number, player: number): Transaction {
  return {
    transaction_id: String(id),
    type,
    status: type === "WAIVER_ERROR" ? "FAILED_INVALIDPLAYERSOURCE" : "EXECUTED",
    team_id: team,
    team_name: null,
    scoring_period: 5,
    process_date: "2026-10-05T07:30:00.000Z",
    proposed_date: null,
    bid_amount: 0,
    items: [
      {
        type: "ADD",
        player_id: player,
        name: null,
        from_team_id: null,
        to_team_id: team,
        from_slot: null,
        to_slot: null,
      },
    ],
    related_transaction_id: null,
    note: null,
  };
}

describe("order movement, trades, rival needs", () => {
  it("a winner moving down is a successful claim; everyone moving with no claim is a reset", () => {
    const moved = TEAMS.map((t) => (t.team_id === 1 ? { ...t, waiver_rank_now: 10 } : t));
    const a = analyzeLeagueActivity(req({ teams: moved, since_days: 30 }));
    expect(a.data.waiver_order_movement.find((m) => m.team_id === 1)?.cause).toBe(
      "successful_claim",
    );
    const reset = TEAMS.map((t) => ({ ...t, waiver_rank_now: 11 - t.team_id }));
    const b = analyzeLeagueActivity(req({ teams: reset, transactions: [] }));
    expect(b.data.waiver_order_movement.filter((m) => m.cause === "reset").length).toBeGreaterThan(
      5,
    );
    expect(b.data.standings_movement.find((m) => m.team_id === 1)).toEqual({
      team_id: 1,
      rank_before: 1,
      rank_after: 4,
    });
  });
  it("a trade lists traded_in and traded_out for both teams", () => {
    const trade: Transaction = {
      ...base(9100, "TRADE_ACCEPT", 4, 0),
      items: [
        {
          type: "TRADE",
          player_id: 801,
          name: null,
          from_team_id: 4,
          to_team_id: 5,
          from_slot: null,
          to_slot: null,
        },
        {
          type: "TRADE",
          player_id: 802,
          name: null,
          from_team_id: 5,
          to_team_id: 4,
          from_slot: null,
          to_slot: null,
        },
      ],
    };
    const { data } = analyzeLeagueActivity(req({ transactions: [trade] }));
    expect(data.transactions.trades).toBe(1);
    const t4 = data.transactions.by_team
      .find((t) => t.team_id === 4)
      ?.notable.map((n) => n.action)
      .sort();
    expect(t4).toEqual(["traded_in", "traded_out"]);
  });
  it("rival needs: the weakest positions, free agents who beat their worst starter there, the IR block", () => {
    const withPlayers = TEAMS.map((t) => ({
      ...t,
      players: tradeRoster(t.team_id, 10, t.team_id === 5 ? "rb_rich" : "balanced"),
    }));
    const pool = [
      {
        player_id: 990,
        position: "WR",
        slot_id: SLOT.BE,
        weekly: Array.from({ length: 14 }, () => 12),
      },
      {
        player_id: 991,
        position: "WR",
        slot_id: SLOT.BE,
        weekly: Array.from({ length: 14 }, () => 2),
      },
    ];
    const { data } = analyzeLeagueActivity(req({ teams: withPlayers, pool }));
    expect(data.rival_needs.some((r) => r.team_id === 2)).toBe(false);
    const five = data.rival_needs.find((r) => r.team_id === 5);
    expect(five?.weakest_slots[0]).toBe("WR");
    expect(five?.likely_targets).toEqual([990]);
    expect(data.rival_needs.find((r) => r.team_id === 7)?.ir_blocked).toBe(true);
    const off = analyzeLeagueActivity(
      req({ teams: withPlayers, pool, include_rival_needs: false }),
    );
    expect(off.data.rival_needs).toEqual([]);
  });
  it("unreadable rosters are warned; bounds refused", () => {
    expect(analyzeLeagueActivity(req()).warnings[0]).toMatch(/rosters unreadable/);
    expect(() => analyzeLeagueActivity(req({ since_days: 0 }))).toThrow();
    expect(() => analyzeLeagueActivity(req({ since_days: 31 }))).toThrow();
  });
});
