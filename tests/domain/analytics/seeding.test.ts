// seeding.test.ts — the seeding simulator as a domain unit test (plan 10 A10a as ruled in changelog
// R5-2; research 05 §2.4). A10a's hard parts: a 3-team toy league whose P(playoffs) is computed by
// hand (quadrature, independent of the simulator) under both readings at 20 000 paths (±0.02); the
// marginal-values table populated and `pf_per_win` finite under (a), null under (b); the research's
// qualitative claims (the variance sign flips with the cutoff; T2 a favourite under (a), a bubble
// team under (b)) on a ten-team state that carries every recorded fact of that run (T4/T8/T2 4-4,
// PF ranks 3/5/7, T4's PF 908). SOFT (reported in docs/evals/1a-analytics.md): the ten-team table's
// cells — the research drew the other seven teams' weeks 1–8 once from an unpublished seeded run
// (seeding_mc.py, never committed; a Python RNG cannot be reproduced from JS), so those checks are a
// reconstruction sanity bound (0.05), not the plan's tolerance. Also: the exact tiebreak chains,
// division winners first, the bracket's bye rule; determinism by seed, pathwise monotone marginal
// values (common random numbers), partial runs, hostile inputs.
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import {
  bracketOrder,
  coldStartMeanSd,
  simulateSeason,
  tiebreakChain,
  type SeasonSimRequest,
  type SeasonTeam,
} from "../../../src/domain/analytics/seeding.js";
import { normalCdf, normalPdf } from "../../../src/domain/analytics/math.js";
import { AnalyticsError } from "../../../src/domain/analytics/errors.js";
import { clockAndRng, instantPacer, steppingPacer } from "./helpers.js";

const team = (
  team_id: number,
  wins: number,
  losses: number,
  points_for: number,
  weekly: { mu: number; sigma: number } | null = null,
  division_id: number | null = null,
): SeasonTeam => ({
  team_id,
  division_id,
  wins,
  losses,
  ties: 0,
  points_for,
  points_against: 0,
  weekly,
});

function base(over: Partial<SeasonSimRequest> = {}): SeasonSimRequest {
  const { clock, rng } = clockAndRng();
  return {
    teams: [],
    played: [],
    remaining: [],
    me: 1,
    playoff: { team_count: 2, seeding_rule: "TOTAL_POINTS_SCORED", reseed: false, rounds: [] },
    seeding_mode: "both",
    seeding_config: { mode: "espn_rule", confirmed_at: null },
    clock,
    rng,
    pacer: instantPacer,
    deadline_ms: null,
    ...over,
  };
}

/** ∫ f over (lo, hi) by Simpson's rule (the hand computation). */
function integrate(f: (x: number) => number, lo: number, hi: number, n = 4000): number {
  const h = (hi - lo) / n;
  let s = f(lo) + f(hi);
  for (let i = 1; i < n; i++) s += (i % 2 === 1 ? 4 : 2) * f(lo + i * h);
  return (s * h) / 3;
}

describe("A10a: a 3-team toy league, P(playoffs) by hand under both readings (hard, ±0.02)", () => {
  // A 1-1 PF 200 ~ N(110, 20); B 1-1 PF 300 (bye); C 2-0 PF 200 ~ N(100, 20); one game left, A v C;
  // two playoff spots. (a): A is in iff A beats C (then A and C are 2-1, B 1-1). (b): PF only —
  // A is out iff it finishes below both B (300) and C.
  const req = base({
    teams: [
      team(1, 1, 1, 200, { mu: 110, sigma: 20 }),
      team(2, 1, 1, 300, { mu: 100, sigma: 20 }),
      team(3, 2, 0, 200, { mu: 100, sigma: 20 }),
    ],
    remaining: [{ period: 3, home: 1, away: 3 }],
    n_sims: 20_000,
  });
  const pA = normalCdf(10 / Math.sqrt(800));
  const pBOut = integrate(
    (a) => (normalPdf((a - 310) / 20) / 20) * (1 - normalCdf((a - 300) / 20)),
    150,
    300,
  );

  it("reading (a): P(A in) = Φ(10/√800) = 0.638", async () => {
    const out = await simulateSeason(req);
    const a = out.data.readings.find((r) => r.seeding_mode === "espn_rule");
    expect(Math.abs((a?.p_playoffs ?? 0) - pA)).toBeLessThan(0.02);
  });

  it("reading (b): P(A in) = 1 − ∫ P(A < 300, A < C)", async () => {
    const out = await simulateSeason(req);
    const b = out.data.readings.find((r) => r.seeding_mode === "points_only");
    expect(Math.abs((b?.p_playoffs ?? 0) - (1 - pBOut))).toBeLessThan(0.02);
    expect(out.data.divergence?.p_playoffs_delta_between_readings).toBeCloseTo(
      (out.data.readings[0]?.p_playoffs ?? 0) - (out.data.readings[1]?.p_playoffs ?? 0),
      6,
    );
  });

  it("the other teams: C is in for certain under (a); B's chance is the complement of A's", async () => {
    const forC = await simulateSeason({ ...req, me: 3, seeding_mode: "espn_rule" });
    expect(forC.data.readings[0]?.p_playoffs).toBe(1);
    expect(forC.data.readings[0]?.clinch.clinched).toBe(true);
    const forB = await simulateSeason({ ...req, me: 2, seeding_mode: "espn_rule" });
    expect(Math.abs((forB.data.readings[0]?.p_playoffs ?? 0) - (1 - pA))).toBeLessThan(0.02);
  });
});

// The research run's facts (research 05 §2.4; docs/scratch notes): true means 122…100 (T0…T9), σ 20,
// a 14-week round-robin (9 rounds + rounds 1–5), state after week 8; T4 (μ 112) 4-4 with PF 908 (3rd),
// T8 (μ 103) 4-4 (7th in PF), T2 (μ 116) 4-4 (5th in PF). The run's other teams were not recorded —
// the state after week 8 was one seeded draw of seeding_mc.py, which was never committed (changelog
// R5-2): this state carries every recorded fact and was found by search (docs/evals/1a-analytics.md),
// so the table's cells are a reconstruction sanity bound here, never A10a's hard tolerance.
const MU = [122, 119, 116, 114, 112, 110, 108, 106, 103, 100];
const WINS = [7, 3, 4, 0, 4, 7, 1, 6, 4, 4];
const PF = [937.4, 1128.5, 846.3, 840.7, 908, 845.5, 907.9, 836.5, 841.4, 812.6];
function circleRounds(): [number, number][][] {
  let l = Array.from({ length: 10 }, (_, i) => i);
  const out: [number, number][][] = [];
  for (let r = 0; r < 9; r++) {
    out.push(Array.from({ length: 5 }, (_, i) => [l[i] ?? 0, l[9 - i] ?? 0] as [number, number]));
    l = [l[0] ?? 0, l[9] ?? 0, ...l.slice(1, 9)];
  }
  return out;
}
function tenTeam(me: number, mode: "espn_rule" | "points_only"): SeasonSimRequest {
  const rounds = circleRounds();
  const remaining = [8, 0, 1, 2, 3, 4].flatMap((r, wk) =>
    (rounds[r] ?? []).map(([h, a]) => ({ period: 9 + wk, home: h + 1, away: a + 1 })),
  );
  return base({
    teams: MU.map((mu, i) =>
      team(i + 1, WINS[i] ?? 0, 8 - (WINS[i] ?? 0), PF[i] ?? 0, { mu, sigma: 20 }),
    ),
    remaining,
    me: me + 1,
    playoff: {
      team_count: 6,
      seeding_rule: "TOTAL_POINTS_SCORED",
      reseed: false,
      rounds: [{ weeks: [15] }, { weeks: [16] }, { weeks: [17] }],
    },
    seeding_mode: mode,
    regular_weeks: [9, 10, 11, 12, 13, 14],
    n_sims: 20_000,
  });
}

describe("A10a: the research run's ten-team state (research 05 §2.4; R5-2)", () => {
  const TABLE = {
    espn_rule: { 4: 0.826, 8: 0.331, 2: 0.857 },
    points_only: { 4: 0.969, 8: 0.133, 2: 0.757 },
  } as const;
  type Readings = Awaited<ReturnType<typeof simulateSeason>>["data"];
  const runs = new Map<number, Readings>();
  const reading = (t: number, mode: "espn_rule" | "points_only") =>
    runs.get(t)?.readings.find((r) => r.seeding_mode === mode);
  beforeAll(async () => {
    for (const t of [4, 8, 2])
      runs.set(
        t,
        (await simulateSeason({ ...tenTeam(t, "espn_rule"), seeding_mode: "both" })).data,
      );
    // three 20 000-path runs under both readings: ~5 s locally, ~3× that under coverage on CI
  }, 120_000);

  it.each([4, 8, 2] as const)(
    "soft — reconstruction sanity bound, not the plan tolerance: T%i's P(playoffs) within 0.05 of the table under both readings",
    (t) => {
      for (const mode of ["espn_rule", "points_only"] as const)
        expect(Math.abs((reading(t, mode)?.p_playoffs ?? 0) - TABLE[mode][t]), mode).toBeLessThan(
          0.05,
        );
    },
  );

  it("soft — reconstruction sanity bound: marginal values the state search never targeted within 0.05 of the table", () => {
    // cells are ΔP(playoffs) / ΔP(bye) from research 05 §2.4's table
    const cells: [
      number,
      "espn_rule" | "points_only",
      "plus_1_win" | "plus_pf_80" | "sigma_x1_4",
      "d_p_playoffs" | "d_p_bye",
      number,
    ][] = [
      [4, "espn_rule", "plus_1_win", "d_p_playoffs", 0.117],
      [8, "espn_rule", "plus_1_win", "d_p_playoffs", 0.255],
      [2, "espn_rule", "plus_1_win", "d_p_playoffs", 0.097],
      [4, "points_only", "plus_pf_80", "d_p_bye", 0.376],
      [8, "points_only", "plus_pf_80", "d_p_playoffs", 0.486],
      [2, "points_only", "plus_pf_80", "d_p_playoffs", 0.225],
      [4, "points_only", "sigma_x1_4", "d_p_playoffs", -0.049],
      [8, "points_only", "sigma_x1_4", "d_p_playoffs", 0.06],
      [2, "points_only", "sigma_x1_4", "d_p_playoffs", -0.055],
    ];
    for (const [t, mode, key, field, want] of cells)
      expect(
        Math.abs((reading(t, mode)?.marginal_values[key][field] ?? 9) - want),
        `T${String(t)} ${mode} ${key}`,
      ).toBeLessThan(0.05);
  });

  it("hard: the marginal-values table is populated; pf_per_win is finite under (a) and null under (b)", () => {
    for (const mode of ["espn_rule", "points_only"] as const)
      expect(Object.keys(reading(4, mode)?.marginal_values ?? {}).sort()).toEqual([
        "plus_1_win",
        "plus_3_ppw",
        "plus_pf_20",
        "plus_pf_40",
        "plus_pf_80",
        "sigma_x0_7",
        "sigma_x1_4",
      ]);
    expect(Number.isFinite(reading(4, "espn_rule")?.pf_per_win)).toBe(true);
    expect(reading(4, "points_only")?.pf_per_win).toBeNull();
  });

  it("hard: the research's qualitative findings, which do not depend on the unrecorded teams", () => {
    const t4a = reading(4, "espn_rule");
    const t4b = reading(4, "points_only");
    // (a): a past win is worth far more than 40 PF — one win is many PF of exchange rate
    expect(t4a?.marginal_values.plus_1_win.d_p_playoffs).toBeGreaterThan(0.05);
    expect(t4a?.marginal_values.plus_1_win.d_p_playoffs ?? 0).toBeGreaterThan(
      2 * (t4a?.marginal_values.plus_pf_40.d_p_playoffs ?? 0),
    );
    expect(t4a?.pf_per_win ?? 0).toBeGreaterThan(90);
    // (b): wins are worth nothing; PF is everything
    expect(Math.abs(t4b?.marginal_values.plus_1_win.d_p_playoffs ?? 1)).toBeLessThan(0.005);
    expect(t4b?.marginal_values.plus_pf_80.d_p_bye ?? 0).toBeGreaterThan(0.1);
    // the variance sign flips with the position relative to the cutoff under (b)
    expect(t4b?.marginal_values.sigma_x1_4.d_p_playoffs ?? 0).toBeLessThan(0);
    expect(reading(8, "points_only")?.marginal_values.sigma_x1_4.d_p_playoffs ?? 0).toBeGreaterThan(
      0,
    );
    // the same roster is a favourite under (a) and a bubble team under (b)
    expect(
      (reading(2, "espn_rule")?.p_playoffs ?? 0) - (reading(2, "points_only")?.p_playoffs ?? 0),
    ).toBeGreaterThan(0.05);
    expect(runs.get(4)?.divergence?.p_playoffs_delta_between_readings).toBeCloseTo(
      (t4a?.p_playoffs ?? 0) - (t4b?.p_playoffs ?? 0),
      6,
    );
  });

  it("outputs are probabilities and ordered: p_bye ≤ p_playoffs, p_champion ≤ p_playoffs, Σ seeds = 1", () => {
    const out = runs.get(4);
    const r = reading(4, "espn_rule");
    expect(r?.p_bye ?? 1).toBeLessThanOrEqual(r?.p_playoffs ?? 0);
    expect(r?.p_champion ?? 1).toBeLessThanOrEqual(r?.p_playoffs ?? 0);
    expect((r?.seed_distribution ?? []).reduce((s, x) => s + x.p, 0)).toBeCloseTo(1, 3);
    // byes for seeds 1–2: round 1 is played only by seeds 3–6
    const w15 = r?.p_alive_by_week.find((x) => x.week === 15)?.p ?? 0;
    expect(w15).toBeCloseTo((r?.p_playoffs ?? 0) - (r?.p_bye ?? 0), 3);
    expect(r?.p_alive_by_week.filter((x) => x.week < 15).every((x) => x.p === 1)).toBe(true);
    expect(r?.tiebreak_chain).toEqual([
      "win_pct",
      "points_for",
      "head_to_head",
      "division_record",
      "points_against",
      "coin_flip",
    ]);
    expect(out?.n_sims).toBe(20_000);
    expect(out?.division_aware).toBe(false);
    expect(out?.seeding).toEqual({ mode_used: "both", confirmed: false });
    expect(out?.rec.no_move).toBe(true);
    expect(out?.rec.log_id).toBeNull();
  });
});

describe("tiebreak chains and the bracket", () => {
  it("names ESPN's three chains; an unknown rule reads TOTAL_POINTS_SCORED, flagged", () => {
    expect(tiebreakChain("points_only", "H2H_RECORD").chain).toEqual(["points_for", "coin_flip"]);
    expect(tiebreakChain("espn_rule", "H2H_RECORD").chain.slice(0, 3)).toEqual([
      "win_pct",
      "head_to_head",
      "points_for",
    ]);
    expect(tiebreakChain("espn_rule", "INTRA_DIVISION_RECORD").chain[0]).toBe("division_record");
    expect(tiebreakChain("espn_rule", "SOMETHING_NEW")).toMatchObject({ known: false });
  });

  it("the standard bracket order", () => {
    expect(bracketOrder(1)).toEqual([1]);
    expect(bracketOrder(2)).toEqual([1, 2]);
    expect(bracketOrder(4)).toEqual([1, 4, 2, 3]);
    expect(bracketOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });

  // Deterministic ties (σ 0): A and B finish 2-1; B outscored A but A beat B head to head.
  const tied = (rule: string) =>
    base({
      teams: [
        team(1, 1, 1, 200, { mu: 100, sigma: 0 }),
        team(2, 1, 1, 260, { mu: 100, sigma: 0 }),
        team(3, 0, 2, 150, { mu: 50, sigma: 0 }),
      ],
      played: [
        { period: 1, home: 1, away: 2, home_points: 110, away_points: 100 },
        { period: 2, home: 2, away: 3, home_points: 160, away_points: 50 },
        { period: 2, home: 1, away: 3, home_points: 90, away_points: 100 },
      ],
      remaining: [
        { period: 3, home: 1, away: 3 },
        { period: 4, home: 2, away: 3 },
      ],
      playoff: { team_count: 1, seeding_rule: rule, reseed: false, rounds: [] },
      seeding_mode: "espn_rule",
      marginal: false,
    });
  it("TOTAL_POINTS_SCORED breaks a win-% tie by PF; H2H_RECORD by head to head", async () => {
    expect((await simulateSeason(tied("TOTAL_POINTS_SCORED"))).data.readings[0]?.p_playoffs).toBe(
      0,
    );
    expect((await simulateSeason(tied("H2H_RECORD"))).data.readings[0]?.p_playoffs).toBe(1);
  });

  it("division winners seed first under (a) with more than one division; PF only under (b)", async () => {
    // team 4 leads division 2 at 1-3 and takes a playoff seed over two 3-1 teams of division 1
    const req = base({
      teams: [
        team(1, 4, 0, 400, { mu: 100, sigma: 0 }, 1),
        team(2, 3, 1, 390, { mu: 100, sigma: 0 }, 1),
        team(3, 3, 1, 380, { mu: 100, sigma: 0 }, 1),
        team(4, 1, 3, 300, { mu: 100, sigma: 0 }, 2),
        team(5, 0, 4, 200, { mu: 100, sigma: 0 }, 2),
      ],
      me: 4,
      playoff: { team_count: 2, seeding_rule: "TOTAL_POINTS_SCORED", reseed: false, rounds: [] },
      seeding_mode: "both",
      marginal: false,
    });
    const out = await simulateSeason(req);
    expect(out.data.division_aware).toBe(true);
    expect(out.data.readings[0]).toMatchObject({ seeding_mode: "espn_rule", p_playoffs: 1 });
    expect(out.data.readings[0]?.tiebreak_chain[0]).toBe("division_winners_first");
    expect(out.data.readings[1]).toMatchObject({ seeding_mode: "points_only", p_playoffs: 0 });
  });

  it("the bracket: a 6-team field gives seeds 1–2 a bye; a champion only when every round is known", async () => {
    const teams = Array.from({ length: 6 }, (_, i) =>
      team(i + 1, 6 - i, i, 1000 - 10 * i, { mu: 100, sigma: 15 }),
    );
    const out = await simulateSeason(
      base({
        teams,
        me: 1,
        playoff: {
          team_count: 6,
          seeding_rule: "TOTAL_POINTS_SCORED",
          reseed: true,
          rounds: [{ weeks: [15] }, { weeks: [16] }, { weeks: [17] }],
        },
        seeding_mode: "espn_rule",
      }),
    );
    const r = out.data.readings[0];
    expect(r).toMatchObject({ p_playoffs: 1, p_bye: 1 });
    expect(r?.p_alive_by_week.find((x) => x.week === 15)?.p).toBe(0);
    expect(r?.p_alive_by_week.find((x) => x.week === 16)?.p).toBe(1);
    expect(r?.p_champion ?? 0).toBeGreaterThan(0.2);
    const partialRounds = await simulateSeason(
      base({
        teams,
        me: 1,
        playoff: {
          team_count: 6,
          seeding_rule: "TOTAL_POINTS_SCORED",
          reseed: false,
          rounds: [{ weeks: [15] }],
        },
        seeding_mode: "espn_rule",
        marginal: false,
      }),
    );
    expect(partialRounds.data.readings[0]?.p_champion).toBeNull();
    expect(partialRounds.warnings.some((w) => w.includes("playoff rounds"))).toBe(true);
  });
});

describe("clinch, elimination, cutoff and scenarios", () => {
  const league = (over: Partial<SeasonSimRequest> = {}) =>
    base({
      teams: [team(1, 8, 0, 900), team(2, 6, 2, 850), team(3, 2, 6, 700), team(4, 0, 8, 600)],
      remaining: [
        { period: 9, matchup_id: 41, home: 1, away: 2 },
        { period: 9, matchup_id: 42, home: 3, away: 4 },
      ],
      playoff: { team_count: 2, seeding_rule: "TOTAL_POINTS_SCORED", reseed: false, rounds: [] },
      seeding_mode: "espn_rule",
      ...over,
    });
  it("an 8-0 team with one game left has clinched (magic 0); a 0-8 team is eliminated", async () => {
    const top = (await simulateSeason(league({ me: 1 }))).data.readings[0];
    expect(top?.clinch).toEqual({ clinched: true, eliminated: false, magic_number: 0 });
    const bottom = (await simulateSeason(league({ me: 4 }))).data.readings[0];
    expect(bottom?.clinch.eliminated).toBe(true);
    expect(bottom?.clinch.magic_number).toBeNull();
    expect(bottom?.p_playoffs).toBe(0);
  });

  it("the cutoff names the gap to the seed line; points_only needs the PF rank of the line", async () => {
    const r = (await simulateSeason(league({ me: 3, seeding_mode: "both" }))).data.readings;
    expect(r[0]?.cutoff).toMatchObject({ seed_line: 2, wins_gap: -4 });
    expect(r[1]?.cutoff.pf_rank_needed).toBe(2);
    expect(r[1]?.clinch).toEqual({ clinched: false, eliminated: false, magic_number: null });
  });

  it("scenarios: a forced winner and a PF delta are applied and listed", async () => {
    const out = await simulateSeason(
      league({
        me: 2,
        scenarios: [
          { week: 9, matchup_id: 41, winner: "me" },
          { team_id: 3, pf_delta: 25 },
        ],
      }),
    );
    expect(out.data.readings[0]?.scenarios_applied).toEqual([
      "matchup 41 (period 9): team 2 wins",
      "team 3: points for +25",
    ]);
    await expect(
      simulateSeason(league({ scenarios: [{ week: 9, matchup_id: 99, winner: 1 }] })),
    ).rejects.toBeInstanceOf(AnalyticsError);
    await expect(
      simulateSeason(league({ scenarios: [{ week: 9, matchup_id: 41, winner: 3 }] })),
    ).rejects.toBeInstanceOf(AnalyticsError);
    await expect(
      simulateSeason(league({ scenarios: [{ team_id: 77, pf_delta: 5 }] })),
    ).rejects.toBeInstanceOf(AnalyticsError);
  });
});

// Stage C finding seeding-clinch-ignores-ties (round 3): the paths rank by win % with a tie as half a
// win, but the deterministic clinch counted wins only — a team with two H2H ties read `eliminated`
// while every path put it in, and a team a tied rival passes on PF read `clinched`. The clinch now
// reads the ranking's own win %; once no game remains the final standings decide through the chain.
describe("clinch and the cutoff read win % with ties as half wins (Stage C seeding-clinch-ignores-ties)", () => {
  const rec = (id: number, w: number, l: number, t: number, pf: number): SeasonTeam => ({
    ...team(id, w, l, pf),
    ties: t,
  });
  // ten teams, six in, the regular season over (the finding's repro (a))
  const final = (me: SeasonTeam, rival: SeasonTeam) =>
    base({
      teams: [
        rec(1, 10, 4, 0, 1700),
        rec(2, 10, 4, 0, 1690),
        rec(3, 10, 4, 0, 1680),
        rec(4, 10, 4, 0, 1670),
        rec(5, 10, 4, 0, 1660),
        rival,
        me,
        rec(8, 4, 10, 0, 1300),
        rec(9, 4, 10, 0, 1290),
        rec(10, 4, 10, 0, 1280),
      ],
      me: me.team_id,
      playoff: { team_count: 6, seeding_rule: "TOTAL_POINTS_SCORED", reseed: false, rounds: [] },
      seeding_mode: "espn_rule",
      marginal: false,
    });

  it("6-6-2 level with a 7-7-0 rival on win %, ahead on PF: in on every path, clinched, never eliminated", async () => {
    const r = (await simulateSeason(final(rec(7, 6, 6, 2, 1600), rec(6, 7, 7, 0, 1500)))).data
      .readings[0];
    expect(r?.p_playoffs).toBe(1);
    expect(r?.seed_distribution).toEqual([{ seed: 6, p: 1 }]);
    expect(r?.clinch).toEqual({ clinched: true, eliminated: false, magic_number: 0 });
    // level with the line on win %: no win between them (a tie counts half), PF ahead
    expect(r?.cutoff).toMatchObject({ seed_line: 6, wins_gap: 0, pf_gap: 100 });
  });

  it("the mirror — 7-7-0 behind a 6-6-2 rival on PF: out on every path, eliminated, never clinched", async () => {
    const r = (await simulateSeason(final(rec(7, 7, 7, 0, 1500), rec(6, 6, 6, 2, 1600)))).data
      .readings[0];
    expect(r?.p_playoffs).toBe(0);
    expect(r?.clinch).toEqual({ clinched: false, eliminated: true, magic_number: null });
    expect(r?.cutoff).toMatchObject({ wins_gap: 0, pf_gap: -100 });
  });

  // four teams, two in, one game left each: me v D, B v C
  const oneLeft = (me: SeasonTeam, b: SeasonTeam, c: SeasonTeam) =>
    base({
      teams: [me, b, c, rec(4, 0, 5, 0, 400)],
      me: 1,
      remaining: [
        { period: 6, matchup_id: 61, home: 1, away: 4 },
        { period: 6, matchup_id: 62, home: 2, away: 3 },
      ],
      playoff: { team_count: 2, seeding_rule: "TOTAL_POINTS_SCORED", reseed: false, rounds: [] },
      seeding_mode: "espn_rule",
      marginal: false,
    });

  it("games left: four ties keep a team alive that two rivals lead on wins alone", async () => {
    // me 1-0-4 (3 of 5 in half wins); B and C 3-2-0 play each other, so one finishes 3-3 (.500)
    // while a win takes me to 2-0-4 (.667): alive, and the paths agree
    const r = (
      await simulateSeason(
        oneLeft(rec(1, 1, 0, 4, 560), rec(2, 3, 2, 0, 520), rec(3, 3, 2, 0, 510)),
      )
    ).data.readings[0];
    expect(r?.clinch.eliminated).toBe(false);
    expect(r?.p_playoffs).toBeGreaterThan(0.2);
  });

  it("games left: a rival's ties can still catch a 3-2-0 team, so it has not clinched", async () => {
    // B and C 1-0-4 play each other: the winner reaches 2-0-4 (.667), the loser 1-1-4 (.500) —
    // level with me at 3-3 if I lose, the PF tiebreak to come
    const r = (
      await simulateSeason(
        oneLeft(rec(1, 3, 2, 0, 500), rec(2, 1, 0, 4, 520), rec(3, 1, 0, 4, 510)),
      )
    ).data.readings[0];
    expect(r?.clinch.clinched).toBe(false);
    // losing out does not clinch (the bounds read each rival's best case, not who plays whom)
    expect(r?.clinch.magic_number).not.toBe(0);
    expect(r?.p_playoffs).toBeLessThan(1);
  });

  it("property: clinched ⇒ in on every path, eliminated ⇒ out on every path; with no game left both are exact", async () => {
    const W = fc.record({ w: fc.nat(6), t: fc.nat(2), pf: fc.integer({ min: 400, max: 700 }) });
    await fc.assert(
      fc.asyncProperty(
        fc.array(W, { minLength: 4, maxLength: 6 }),
        fc.integer({ min: 0, max: 2 }),
        fc.nat(5),
        fc.nat(5),
        fc.constantFrom("TOTAL_POINTS_SCORED", "H2H_RECORD", "INTRA_DIVISION_RECORD"),
        fc.boolean(),
        async (rows, left, meIdx, pIdx, rule, divisions) => {
          const n = rows.length - (rows.length % 2);
          const G = 8;
          const teams = rows.slice(0, n).map((x, i) => ({
            ...rec(i + 1, Math.min(x.w, G - x.t), 0, x.t, x.pf),
            losses: G - Math.min(x.w, G - x.t) - x.t,
            division_id: divisions ? (i % 2) + 1 : null,
          }));
          const remaining = Array.from({ length: left }, (_, k) =>
            Array.from({ length: n / 2 }, (_, j) => ({
              period: 9 + k,
              matchup_id: 100 * k + j,
              home: ((j + k) % n) + 1,
              away: ((n - 1 - j + k) % n) + 1,
            })),
          )
            .flat()
            .filter((g) => g.home !== g.away);
          const me = (meIdx % n) + 1;
          const P = (pIdx % (n - 1)) + 1;
          const out = await simulateSeason(
            base({
              teams,
              me,
              remaining,
              playoff: { team_count: P, seeding_rule: rule, reseed: false, rounds: [] },
              seeding_mode: "espn_rule",
              marginal: false,
              n_sims: 1000,
            }),
          );
          const r = out.data.readings[0];
          if (r === undefined) return false;
          if (r.clinch.clinched && r.p_playoffs !== 1) return false;
          if (r.clinch.eliminated && r.p_playoffs !== 0) return false;
          if (r.clinch.clinched && r.clinch.eliminated) return false;
          if (remaining.length === 0)
            return (
              r.clinch.clinched === (r.p_playoffs === 1) &&
              r.clinch.eliminated === (r.p_playoffs === 0)
            );
          return true;
        },
      ),
      { numRuns: 120 },
    );
  });
});

describe("determinism, monotone marginal values, partial runs, hostile input", () => {
  const small = (seed: number) => {
    const { clock, rng } = clockAndRng("2026-10-06T12:00:00.000Z", seed);
    return base({
      clock,
      rng,
      teams: [team(1, 2, 2, 420), team(2, 3, 1, 450), team(3, 1, 3, 380), team(4, 2, 2, 410)],
      played: [
        { period: 4, home: 1, away: 2, home_points: 95, away_points: 101 },
        { period: 4, home: 3, away: 4, home_points: 90, away_points: 99 },
      ],
      remaining: [
        { period: 5, home: 1, away: 3 },
        { period: 5, home: 2, away: 4 },
        { period: 6, home: 1, away: 4 },
        { period: 6, home: 2, away: 3 },
      ],
      n_sims: 2000,
    });
  };

  it("the same seed gives byte-identical output; another seed differs", async () => {
    const a = JSON.stringify((await simulateSeason(small(3))).data);
    const b = JSON.stringify((await simulateSeason(small(3))).data);
    const c = JSON.stringify((await simulateSeason(small(4))).data);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("property: +win and +PF never lower P(playoffs) or P(bye) (common random numbers)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.tuple(
            fc.integer({ min: 0, max: 6 }),
            fc.integer({ min: 300, max: 700 }),
            fc.integer({ min: 80, max: 130 }),
          ),
          { minLength: 4, maxLength: 6 },
        ),
        fc.integer({ min: 1, max: 3 }),
        async (rows, P) => {
          const teams = rows.map(([w, pf, mu], i) => team(i + 1, w, 6 - w, pf, { mu, sigma: 18 }));
          const remaining = teams
            .slice(1)
            .map((t, i) => ({ period: 7 + i, home: 1, away: t.team_id }));
          const out = await simulateSeason(
            base({
              teams,
              remaining,
              n_sims: 1000,
              playoff: {
                team_count: Math.min(P, teams.length),
                seeding_rule: "TOTAL_POINTS_SCORED",
                reseed: false,
                rounds: [],
              },
            }),
          );
          return out.data.readings.every((r) =>
            ["plus_1_win", "plus_pf_20", "plus_pf_40", "plus_pf_80"].every((k) => {
              const m = r.marginal_values[k as "plus_1_win"];
              return m.d_p_playoffs >= -1e-12 && m.d_p_bye >= -1e-12;
            }),
          );
        },
      ),
      { numRuns: 25 },
    );
  });

  it("the cold-start model shrinks toward the league mean and pools σ from played scores", async () => {
    const out = await simulateSeason(small(1));
    const m = out.models;
    expect(m.get(2)?.mu ?? 0).toBeLessThan(450 / 4);
    expect(m.get(3)?.mu ?? 0).toBeGreaterThan(380 / 4);
    expect(out.data.rec.assumptions.some((a) => a.text.includes("cold-start"))).toBe(true);
    const none = await simulateSeason(
      base({
        teams: [team(1, 0, 0, 0), team(2, 0, 0, 0)],
        remaining: [{ period: 1, home: 1, away: 2 }],
        playoff: { team_count: 1, seeding_rule: "TOTAL_POINTS_SCORED", reseed: null, rounds: [] },
      }),
    );
    expect(none.models.get(1)).toEqual({ mu: 100, sigma: 20 });
  });

  it("the cold start draws each team's mean from its posterior, sd σ/√(n+4): the same run as E1 models carrying that mean_sd, and less sure than a known mean (B2b)", async () => {
    const cold = await simulateSeason(small(1));
    expect(coldStartMeanSd(20, 0)).toBe(10);
    expect(coldStartMeanSd(20, 12)).toBe(5);
    expect(coldStartMeanSd(0, 4)).toBe(0);
    expect(coldStartMeanSd(Number.NaN, 4)).toBe(0);
    expect(coldStartMeanSd(20, Number.NaN)).toBe(10);
    expect(
      cold.data.rec.assumptions.some((a) => a.text.includes("uncertainty drawn per path")),
    ).toBe(true);
    // the cold models as explicit weekly models carrying the cold start's posterior sd → identical
    const req = small(1);
    const withSd = req.teams.map((t) => {
      const m = cold.models.get(t.team_id) ?? { mu: 0, sigma: 0 };
      const n = t.wins + t.losses + t.ties;
      return { ...t, weekly: { ...m, mean_sd: coldStartMeanSd(m.sigma, n) } };
    });
    const same = await simulateSeason({ ...req, teams: withSd });
    for (const [i, r] of same.data.readings.entries()) {
      const c = cold.data.readings[i];
      expect(Math.abs(r.p_playoffs - (c?.p_playoffs ?? -1))).toBeLessThan(0.002);
      expect(Math.abs(r.p_bye - (c?.p_bye ?? -1))).toBeLessThan(0.002);
    }
    // the same means taken as known (mean_sd absent, 0 or hostile) → a sharper, different outlook
    // for the leader; a hostile mean_sd reads as 0, never NaN
    const known = (ms: number | undefined) =>
      simulateSeason({
        ...req,
        me: 2,
        teams: withSd.map((t) => ({
          ...t,
          weekly: {
            mu: t.weekly.mu,
            sigma: t.weekly.sigma,
            ...(ms === undefined ? {} : { mean_sd: ms }),
          },
        })),
      });
    const leaderCold = await simulateSeason({ ...req, me: 2 });
    const a = (await known(undefined)).data.readings[0]?.p_playoffs ?? -1;
    for (const ms of [0, -3, Number.NaN, Number.POSITIVE_INFINITY])
      expect((await known(ms)).data.readings[0]?.p_playoffs).toBe(a);
    expect(a).toBeGreaterThan(leaderCold.data.readings[0]?.p_playoffs ?? 2);
  });

  it("a CPU deadline stops the run: partial with the completed path count", async () => {
    const out = await simulateSeason({ ...small(1), pacer: steppingPacer(5), deadline_ms: 40 });
    expect(out.partial).toBe(true);
    expect(out.data.n_sims).toBeGreaterThan(0);
    expect(out.data.n_sims).toBeLessThan(2000);
    expect(out.warnings.some((w) => w.startsWith("partial:"))).toBe(true);
  });

  it("refuses malformed leagues", async () => {
    const ok = small(1);
    await expect(simulateSeason({ ...ok, teams: ok.teams.slice(0, 1) })).rejects.toBeInstanceOf(
      AnalyticsError,
    );
    await expect(simulateSeason({ ...ok, me: 99 })).rejects.toBeInstanceOf(AnalyticsError);
    await expect(
      simulateSeason({ ...ok, teams: [...ok.teams, team(1, 0, 0, 0)] }),
    ).rejects.toBeInstanceOf(AnalyticsError);
    await expect(
      simulateSeason({ ...ok, teams: [team(1, -1, 0, 0), team(2, 0, 0, 0)] }),
    ).rejects.toBeInstanceOf(AnalyticsError);
    await expect(
      simulateSeason({ ...ok, remaining: [{ period: 1, home: 1, away: 1 }] }),
    ).rejects.toBeInstanceOf(AnalyticsError);
    await expect(
      simulateSeason({
        ...ok,
        played: [{ period: 1, home: 1, away: 2, home_points: Number.NaN, away_points: 1 }],
      }),
    ).rejects.toBeInstanceOf(AnalyticsError);
    await expect(simulateSeason({ ...ok, n_sims: 10 })).rejects.toBeInstanceOf(AnalyticsError);
    await expect(
      simulateSeason({ ...ok, playoff: { ...ok.playoff, team_count: 9 } }),
    ).rejects.toBeInstanceOf(AnalyticsError);
    await expect(
      simulateSeason({
        ...ok,
        scenarios: Array.from({ length: 11 }, () => ({ team_id: 1, pf_delta: 1 })),
      }),
    ).rejects.toBeInstanceOf(AnalyticsError);
  });
});

describe("deterministic edges (σ 0): ties, multi-week matchups, the deep tiebreak levels", () => {
  const flat = (
    id: number,
    w: number,
    l: number,
    pf: number,
    div: number | null = null,
    pa = 0,
  ): SeasonTeam => ({
    team_id: id,
    division_id: div,
    wins: w,
    losses: l,
    ties: 0,
    points_for: pf,
    points_against: pa,
    weekly: { mu: 100, sigma: 0 },
  });
  const run = (over: Partial<SeasonSimRequest>) =>
    simulateSeason(base({ marginal: false, seeding_mode: "espn_rule", n_sims: 1000, ...over }));

  it("an exact tie counts as a tie for both teams (a half win each)", async () => {
    const out = await run({
      teams: [flat(1, 1, 1, 200), flat(2, 1, 1, 200), flat(3, 0, 2, 100)],
      remaining: [{ period: 3, home: 1, away: 2, weeks: 2 }],
      playoff: { team_count: 1, seeding_rule: "TOTAL_POINTS_SCORED", reseed: null, rounds: [] },
    });
    // 1.5-1.5 each and equal PF: head to head is the tie itself, division and PA equal → coin
    const p = out.data.readings[0]?.p_playoffs ?? 0;
    expect(p).toBeGreaterThan(0.4);
    expect(p).toBeLessThan(0.6);
  });

  it("points against decides once win %, PF, head to head and division all tie (fewer ranks higher)", async () => {
    const out = await run({
      teams: [
        flat(1, 1, 1, 200, null, 150),
        flat(2, 1, 1, 200, null, 180),
        flat(3, 1, 1, 200, null, 160),
      ],
      playoff: { team_count: 1, seeding_rule: "TOTAL_POINTS_SCORED", reseed: null, rounds: [] },
    });
    expect(out.data.readings[0]?.p_playoffs).toBe(1);
    const second = await run({
      me: 2,
      teams: [
        flat(1, 1, 1, 200, null, 150),
        flat(2, 1, 1, 200, null, 180),
        flat(3, 1, 1, 200, null, 160),
      ],
      playoff: { team_count: 1, seeding_rule: "TOTAL_POINTS_SCORED", reseed: null, rounds: [] },
    });
    expect(second.data.readings[0]?.p_playoffs).toBe(0);
  });

  it("INTRA_DIVISION_RECORD seeds by the division record first", async () => {
    const played = [
      { period: 1, home: 1, away: 2, home_points: 100, away_points: 90 },
      { period: 2, home: 3, away: 4, home_points: 90, away_points: 100 },
      { period: 3, home: 1, away: 4, home_points: 80, away_points: 120 },
      { period: 4, home: 3, away: 2, home_points: 130, away_points: 70 },
    ];
    const teams = [
      flat(1, 1, 1, 180, 1),
      flat(2, 0, 2, 160, 1),
      flat(3, 1, 1, 220, 2),
      flat(4, 2, 0, 220, 2),
    ];
    const out = await run({
      me: 1,
      teams,
      played,
      playoff: { team_count: 2, seeding_rule: "INTRA_DIVISION_RECORD", reseed: null, rounds: [] },
    });
    // team 1 is its division's winner (1-0 inside it) and seeds in ahead of team 3 (0-1 inside its division)
    expect(out.data.readings[0]?.p_playoffs).toBe(1);
    expect(out.data.readings[0]?.tiebreak_chain.slice(0, 2)).toEqual([
      "division_winners_first",
      "division_record",
    ]);
  });

  it("a tied playoff game goes to the higher seed; without reseeding the bracket keeps its slots", async () => {
    const teams = Array.from({ length: 4 }, (_, i) => flat(i + 1, 4 - i, i, 500 - i));
    const top = await run({
      me: 1,
      teams,
      playoff: {
        team_count: 4,
        seeding_rule: "TOTAL_POINTS_SCORED",
        reseed: false,
        rounds: [{ weeks: [15] }, { weeks: [16, 17] }],
      },
    });
    expect(top.data.readings[0]?.p_champion).toBe(1);
    const fourth = await run({
      me: 4,
      teams,
      playoff: {
        team_count: 4,
        seeding_rule: "TOTAL_POINTS_SCORED",
        reseed: false,
        rounds: [{ weeks: [15] }, { weeks: [16, 17] }],
      },
    });
    expect(fourth.data.readings[0]?.p_champion).toBe(0);
    expect(fourth.data.readings[0]?.p_alive_by_week).toEqual([
      { week: 15, p: 1 },
      { week: 16, p: 0 },
      { week: 17, p: 0 },
    ]);
  });

  it("an unknown seeding rule is read as TOTAL_POINTS_SCORED and named", async () => {
    const out = await run({
      teams: [flat(1, 2, 0, 200), flat(2, 0, 2, 100)],
      playoff: { team_count: 1, seeding_rule: "SOMETHING_NEW", reseed: null, rounds: [] },
    });
    expect(
      out.data.rec.assumptions.some((a) => a.text.includes("not one ESPN is known to send")),
    ).toBe(true);
    expect(out.data.readings[0]?.p_playoffs).toBe(1);
  });

  it("without marginal values the table is zero and pf_per_win null", async () => {
    const out = await run({
      teams: [flat(1, 2, 0, 200), flat(2, 0, 2, 100)],
      playoff: { team_count: 1, seeding_rule: "TOTAL_POINTS_SCORED", reseed: null, rounds: [] },
    });
    const r = out.data.readings[0];
    expect(r?.marginal_values.plus_pf_40).toEqual({ d_p_playoffs: 0, d_p_bye: 0 });
    expect(r?.pf_per_win).toBeNull();
  });
});
