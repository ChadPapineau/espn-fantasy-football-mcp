// cascade.test.ts — E7 (plan 07 E7; plan 10 B6 hard parts; research 05 §5 Injury cascade, §4.3; sib
// research 05 §6.1–§6.4): role affinity sends an RB1's carries to the RB2 and his targets toward the
// pass-down back (more so with reception points); the hard parts as properties — beneficiaries'
// shares never sum above the vacated share (component by component, with or without team evidence),
// `hypothesis_only` is true whenever team_games = 0 ∧ usage_confirmed = false ∧ market_move = null,
// `ir_consequence.ir_eligible` is true only for OUT / INJURY_RESERVE (the structured status, never
// text); E5's verdicts reach the available beneficiaries only; a backup QB inherits the role.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  analyzeInjuryCascade,
  expectedWeeks,
  redistribute,
  stillOut,
  type CascadeRequest,
  type CascadeTeammate,
} from "../../../src/domain/analytics/cascade.js";
import { CASCADE } from "../../../src/domain/analytics/marketConstants.js";
import {
  ESPN_INJURY_STATUSES,
  IR_ELIGIBLE_INJURY_STATUSES,
} from "../../../src/domain/league/types.js";
import type { RosterSeat } from "../../../src/domain/league/roster.js";
import { bare, clockAndRng, ELIGIBLE, referenceSlots } from "./helpers.js";

const WEEKS = [5, 6, 7, 8, 9, 10];

function mate(
  id: number,
  position: string,
  usage: { t: number; c: number; rz: number; snap?: number },
  over: Partial<CascadeTeammate> = {},
): CascadeTeammate {
  return {
    player_id: id,
    gsis_id: null,
    name: bare(`Player ${String(id)}`),
    position,
    injury_status: null,
    usage: {
      target_share: usage.t,
      carry_share: usage.c,
      rz_share: usage.rz,
      snap_pct: usage.snap ?? 0.5,
    },
    percent_change: null,
    availability: { status: "WAIVERS", waiver_process_date: "2026-10-07T07:00:00.000Z" },
    ...over,
  };
}

const TEAMMATES: CascadeTeammate[] = [
  mate(201, "RB", { t: 0.03, c: 0.2, rz: 0.1, snap: 0.3 }), // the early-down RB2
  mate(202, "RB", { t: 0.09, c: 0.04, rz: 0.03, snap: 0.25 }), // the pass-down back
  mate(
    203,
    "WR",
    { t: 0.24, c: 0.01, rz: 0.15, snap: 0.9 },
    { availability: { status: "ONTEAM", waiver_process_date: null } },
  ),
  mate(204, "WR", { t: 0.16, c: 0, rz: 0.08, snap: 0.8 }),
  mate(205, "TE", { t: 0.12, c: 0, rz: 0.1, snap: 0.75 }),
  mate(
    206,
    "QB",
    { t: 0, c: 0.08, rz: 0.06, snap: 1 },
    { availability: { status: "ONTEAM", waiver_process_date: null } },
  ),
];

function req(over: Partial<CascadeRequest> = {}): CascadeRequest {
  return {
    injured: {
      player_id: 100,
      gsis_id: null,
      name: bare("Player 100"),
      nfl_team: "T1",
      position: "RB",
      injury_status: "OUT",
      usage: { target_share: 0.12, carry_share: 0.62, rz_share: 0.4 },
    },
    teammates: TEAMMATES,
    team_volume: { targets: 34, carries: 26, rz: 8 },
    team_games_without: 0,
    weeks: WEEKS,
    reception_points: 0.5,
    clock: clockAndRng("2026-10-06T20:00:00.000Z").clock,
    ...over,
  };
}

const sum = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0);

describe("E7 — role affinity, not next man up (sib §6.1)", () => {
  it("the RB2 gets most carries; the pass-down back most of the RB targets; the note says so", async () => {
    const { data } = await analyzeInjuryCascade(req());
    const b = new Map(data.beneficiaries.map((x) => [x.player_id, x]));
    expect(b.get(201)?.delta_opportunity.carries).toBeGreaterThan(
      b.get(202)?.delta_opportunity.carries ?? 0,
    );
    expect(b.get(202)?.delta_opportunity.targets).toBeGreaterThan(
      b.get(201)?.delta_opportunity.targets ?? 0,
    );
    expect(data.pass_down_back_note).toMatch(
      /player 202 inherits most targets, player 201 most carries/,
    );
    expect(data.expected_weeks).toEqual({ p25: 1, p50: 2, p75: 4, basis: "prior" });
    expect(data.returning_ramp).toEqual({ weeks: 1, factor: 0.85 });
    expect(data.team_volume_change.implied_total_delta).toBeNull();
    expect(data.injured.position).toBe("RB");
  });
  it("reception points raise the pass-down back's share of the targets", async () => {
    const std = await analyzeInjuryCascade(req({ reception_points: 0 }));
    const ppr = await analyzeInjuryCascade(req({ reception_points: 1 }));
    const t = (d: typeof std.data, id: number) =>
      d.beneficiaries.find((x) => x.player_id === id)?.delta_opportunity.targets ?? 0;
    expect(t(ppr.data, 202)).toBeGreaterThan(t(std.data, 202));
    expect(std.data.pass_down_back_note).toBeNull();
  });
  it("the projection delta follows P(still out) by week; a reported timeline replaces the prior", async () => {
    const { data } = await analyzeInjuryCascade(req({ assume_weeks_out: 2 }));
    expect(data.expected_weeks).toEqual({ p25: 2, p50: 2, p75: 2, basis: "report" });
    const top = data.beneficiaries[0];
    const d = top?.delta_proj_by_week.map((x) => x.delta) ?? [];
    expect(d[0]).toBeGreaterThan(0);
    expect(d[1]).toBeCloseTo(d[0] ?? 0, 6);
    expect(d[2]).toBeCloseTo((d[0] ?? 0) * CASCADE.tailAfterP75, 3);
    expect(d[3]).toBe(0);
  });
  it("a line move sets the team-volume factor and is reported", async () => {
    const { data } = await analyzeInjuryCascade(req({ implied_total: { before: 25, now: 22 } }));
    expect(data.team_volume_change.implied_total_delta).toBe(-3);
    expect(data.vacated.carries).toBeCloseTo(0.62 * 26 * (22 / 25), 3);
  });
});

describe("plan 10 B6 hard: beneficiary shares never sum above the vacated share", () => {
  const share = fc.double({ min: 0, max: 1, noNaN: true });
  const mateArb = fc.record({
    position: fc.constantFrom("QB", "RB", "WR", "TE"),
    t: share,
    c: share,
    rz: share,
    wt: fc.option(share, { nil: null }),
    wc: fc.option(share, { nil: null }),
    wrz: fc.option(share, { nil: null }),
    status: fc.constantFrom(null, "ACTIVE", "QUESTIONABLE", "OUT"),
  });
  it("property: for any teammates, injured shares, team evidence and reception points", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(mateArb, { minLength: 1, maxLength: 8 }),
        fc.constantFrom("QB", "RB", "WR", "TE", "K"),
        share,
        share,
        share,
        fc.integer({ min: 0, max: 6 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        async (ms, pos, t, c, rz, games, rp) => {
          const teammates = ms.map((m, i) =>
            mate(
              300 + i,
              m.position,
              { t: m.t, c: m.c, rz: m.rz },
              {
                injury_status: m.status,
                without_starter:
                  m.wt === null && m.wc === null
                    ? null
                    : { target_share: m.wt, carry_share: m.wc, rz_share: m.wrz },
              },
            ),
          );
          const injured = {
            position: pos,
            usage: { target_share: t, carry_share: c, rz_share: rz },
          };
          const { vacated, allocs } = redistribute(injured, teammates, games, rp);
          for (const k of ["targets", "carries", "rz"] as const)
            expect(sum(allocs.map((a) => a.delta[k]))).toBeLessThanOrEqual(vacated[k] + 1e-9);
          const { data } = await analyzeInjuryCascade(
            req({
              injured: { ...req().injured, position: pos, usage: injured.usage },
              teammates,
              team_games_without: games,
              reception_points: rp,
            }),
          );
          for (const k of ["targets", "carries", "rz"] as const)
            expect(sum(data.beneficiaries.map((b) => b.delta_opportunity[k]))).toBeLessThanOrEqual(
              data.vacated[k] + 1e-3 * (data.beneficiaries.length + 1),
            );
        },
      ),
      { numRuns: 150 },
    );
  });
  it("without team evidence a retained fraction is redistributed, never the whole share", () => {
    const { vacated, allocs } = redistribute(req().injured, TEAMMATES, 0, 0.5);
    expect(sum(allocs.map((a) => a.delta.carries))).toBeCloseTo(
      vacated.carries * CASCADE.retention.carries,
      9,
    );
  });
  it("team evidence (≥ 2 games) is blended in and capped at the vacated share", () => {
    const greedy = TEAMMATES.map((m) => ({
      ...m,
      without_starter: { target_share: 0.9, carry_share: 0.9, rz_share: 0.9 },
    }));
    const { vacated, allocs } = redistribute(req().injured, greedy, 4, 0.5);
    expect(sum(allocs.map((a) => a.delta.carries))).toBeCloseTo(vacated.carries, 9);
    const one = redistribute(req().injured, greedy, 1, 0.5);
    expect(sum(one.allocs.map((a) => a.delta.carries))).toBeCloseTo(
      vacated.carries * CASCADE.retention.carries,
      9,
    );
  });
});

describe("plan 10 B6 hard: hypothesis_only", () => {
  it("true with no team games, no usage confirmation and no market move", async () => {
    const { data } = await analyzeInjuryCascade(req());
    expect(data.hypothesis_only).toBe(true);
    expect(data.rec.action).toBe("no move: the cascade is a hypothesis only");
    expect(
      data.beneficiaries.every(
        (b) =>
          b.evidence.team_games === 0 &&
          !b.evidence.usage_confirmed &&
          b.evidence.market_move === null,
      ),
    ).toBe(true);
  });
  it("false once any evidence exists: team games, a usage jump, a material market move", async () => {
    expect((await analyzeInjuryCascade(req({ team_games_without: 2 }))).data.hypothesis_only).toBe(
      false,
    );
    const confirmed = TEAMMATES.map((m) =>
      m.player_id === 201
        ? { ...m, recent: { target_share: 0.03, carry_share: 0.5, rz_share: 0.3, snap_pct: 0.7 } }
        : m,
    );
    expect((await analyzeInjuryCascade(req({ teammates: confirmed }))).data.hypothesis_only).toBe(
      false,
    );
    const moved = TEAMMATES.map((m) => (m.player_id === 201 ? { ...m, percent_change: 24.5 } : m));
    expect((await analyzeInjuryCascade(req({ teammates: moved }))).data.hypothesis_only).toBe(
      false,
    );
    // a market reading below the noise floor is not a move
    const tiny = TEAMMATES.map((m) => ({ ...m, percent_change: 0.1 }));
    expect((await analyzeInjuryCascade(req({ teammates: tiny }))).data.hypothesis_only).toBe(true);
  });
  it("property: the antecedent always implies hypothesis_only", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.double({ min: 0, max: 0.5, noNaN: true }), { minLength: 1, maxLength: 6 }),
        async (shares) => {
          const teammates = shares.map((s, i) =>
            mate(400 + i, i % 2 === 0 ? "RB" : "WR", { t: s, c: s, rz: s }),
          );
          const { data } = await analyzeInjuryCascade(req({ teammates }));
          const antecedent = data.beneficiaries.every(
            (b) =>
              b.evidence.team_games === 0 &&
              !b.evidence.usage_confirmed &&
              b.evidence.market_move === null,
          );
          if (antecedent) expect(data.hypothesis_only).toBe(true);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe("plan 10 B6 hard: ir_consequence.ir_eligible only for OUT / INJURY_RESERVE", () => {
  const seats: RosterSeat[] = [
    {
      player_id: 100,
      slot_id: 2,
      eligible_slot_ids: ELIGIBLE.RB ?? [],
      injury_status: "OUT",
      position: "RB",
      pro_team_id: 1,
    },
    {
      player_id: 1,
      slot_id: 0,
      eligible_slot_ids: ELIGIBLE.QB ?? [],
      injury_status: null,
      position: "QB",
      pro_team_id: 2,
    },
  ];
  const mine = { slot_id: 2, eligible_slot_ids: ELIGIBLE.RB ?? [] };
  it("for every ESPN status and unknown strings, from the structured status only", async () => {
    for (const status of [...ESPN_INJURY_STATUSES, null, "PUP", "NFI", "out"]) {
      const { data } = await analyzeInjuryCascade(
        req({
          injured: { ...req().injured, injury_status: status, mine },
          my_roster: {
            roster: referenceSlots(),
            seats: seats.map((s) => (s.player_id === 100 ? { ...s, injury_status: status } : s)),
          },
        }),
      );
      const eligible = (IR_ELIGIBLE_INJURY_STATUSES as readonly (string | null)[]).includes(status);
      expect(data.ir_consequence?.ir_eligible).toBe(eligible);
      expect(data.ir_consequence?.on_my_roster).toBe(true);
      expect(data.ir_consequence?.move !== null).toBe(eligible);
      expect(data.ir_consequence?.frees_bench_slot).toBe(eligible);
    }
  });
  it("an open IR seat and an eligible player: the move from his slot, an ir_move subject", async () => {
    const { data } = await analyzeInjuryCascade(
      req({ injured: { ...req().injured, mine }, my_roster: { roster: referenceSlots(), seats } }),
    );
    expect(data.ir_consequence).toEqual({
      on_my_roster: true,
      ir_eligible: true,
      move: { from_slot: "RB", to: "IR" },
      frees_bench_slot: true,
    });
    expect(data.rec.subjects).toContainEqual({
      player_id: 100,
      gsis_id: null,
      role: "ir_move",
      slot: "IR",
    });
    expect(data.rec.no_move).toBe(false);
  });
  it("already in IR, or no open seat: eligible but no move", async () => {
    const inIr = await analyzeInjuryCascade(
      req({
        injured: { ...req().injured, mine: { slot_id: 21, eligible_slot_ids: ELIGIBLE.RB ?? [] } },
        my_roster: { roster: referenceSlots(), seats },
      }),
    );
    expect(inIr.data.ir_consequence).toMatchObject({
      ir_eligible: true,
      move: null,
      frees_bench_slot: false,
    });
    const full: RosterSeat[] = [
      ...seats,
      {
        player_id: 50,
        slot_id: 21,
        eligible_slot_ids: [21],
        injury_status: "OUT",
        position: "WR",
        pro_team_id: 3,
      },
      {
        player_id: 51,
        slot_id: 21,
        eligible_slot_ids: [21],
        injury_status: "OUT",
        position: "WR",
        pro_team_id: 3,
      },
    ];
    const noSeat = await analyzeInjuryCascade(
      req({
        injured: { ...req().injured, mine },
        my_roster: { roster: referenceSlots(), seats: full },
      }),
    );
    expect(noSeat.data.ir_consequence?.move).toBeNull();
    expect(
      noSeat.data.rec.assumptions.some((a) => a.text.startsWith("IR-eligible, but no IR seat")),
    ).toBe(true);
  });
  it("not on my roster → null", async () => {
    expect((await analyzeInjuryCascade(req())).data.ir_consequence).toBeNull();
  });
});

describe("E5 verdicts, the QB case, timing helpers", () => {
  it("only available beneficiaries are sent to E5, and only they carry a verdict", async () => {
    const seen: number[] = [];
    const { data } = await analyzeInjuryCascade(
      req({
        team_games_without: 3,
        evaluate_claims: (bs) => {
          seen.push(...bs.map((b) => b.player_id));
          return Promise.resolve(
            new Map(bs.map((b) => [b.player_id, b.player_id === 201 ? "claim" : "pass"] as const)),
          );
        },
      }),
    );
    expect(seen).not.toContain(203);
    expect(seen).toContain(201);
    expect(data.beneficiaries.find((b) => b.player_id === 203)?.verdict ?? null).toBeNull();
    expect(data.beneficiaries.find((b) => b.player_id === 201)?.verdict).toBe("claim");
    expect(data.rec.action).toBe("claim player 201");
    expect(data.rec.latest_execution_time).toBe("2026-10-07T07:00:00.000Z");
  });
  it("without the evaluator every verdict is null and the assumption says so", async () => {
    const { data } = await analyzeInjuryCascade(req({ team_games_without: 3 }));
    expect(data.beneficiaries.every((b) => b.verdict === null)).toBe(true);
    expect(data.rec.assumptions.some((a) => a.text.startsWith("no claim verdicts"))).toBe(true);
  });
  it("a QB's backup inherits the role from the starter's projection", async () => {
    const backup = mate(501, "QB", { t: 0, c: 0.02, rz: 0.01 }, { weekly: WEEKS.map(() => 6) });
    const { data } = await analyzeInjuryCascade(
      req({
        injured: {
          ...req().injured,
          position: "QB",
          injury_status: "INJURY_RESERVE",
          usage: { target_share: 0, carry_share: 0.1, rz_share: 0.1 },
          weekly: WEEKS.map(() => 20),
        },
        teammates: [backup, ...TEAMMATES.filter((m) => m.position !== "QB")],
      }),
    );
    const b = data.beneficiaries.find((x) => x.player_id === 501);
    expect(b?.delta_proj_by_week[0]?.delta).toBeCloseTo(20 * CASCADE.qbBackupFactor - 6, 3);
    expect(data.expected_weeks.basis).toBe("prior");
    expect(data.expected_weeks.p50).toBe(6);
  });
  it("expectedWeeks / stillOut", () => {
    expect(expectedWeeks("QUESTIONABLE", null)).toEqual({ p25: 0, p50: 0, p75: 1, basis: "prior" });
    expect(expectedWeeks("SOMETHING_NEW", undefined)).toEqual({
      p25: 1,
      p50: 1,
      p75: 2,
      basis: "prior",
    });
    expect(expectedWeeks("OUT", -1).basis).toBe("prior");
    const w = { p25: 1, p50: 2, p75: 4, basis: "prior" as const };
    expect([0, 1, 2, 3, 4, 5].map((i) => stillOut(w, i))).toEqual([
      1,
      0.75,
      0.5,
      0.5,
      CASCADE.tailAfterP75,
      0,
    ]);
  });
  it("refuses an out-of-range horizon", async () => {
    await expect(analyzeInjuryCascade(req({ weeks: [] }))).rejects.toMatchObject({
      code: "invalid_request",
    });
  });
  it("the injured player himself is never his own beneficiary", async () => {
    const self = mate(100, "RB", { t: 0.12, c: 0.62, rz: 0.4 });
    const { data } = await analyzeInjuryCascade(req({ teammates: [self, ...TEAMMATES] }));
    expect(data.beneficiaries.some((b) => b.player_id === 100)).toBe(false);
  });
});
