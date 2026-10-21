// reproduce.test.ts — the seeding reproduction on constructed seasons (plan 10 C4; research 05
// §2.1 chain, §2.4 "Evaluation"): every tiebreak level exercised (the recorded seasons never go
// below points for), division winners first, both readings, every finding (an undecided row, a
// missing period count, unknown teams, incomplete seeds, records that disagree, a bracket edit, an
// unknown rule, a coin flip, invalid standings), ties and byes and playoff rows, the C4 summary, the
// provider-shaped input, and fast-check properties against an independent reference chain.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  C4_MIN_SEASONS,
  isExplained,
  reproduceSeason,
  reproductionInputFrom,
  summarizeReproductions,
  type ReproduceTeam,
  type SeasonReproduction,
} from "../../../../src/domain/analytics/seeding-reproduce/index.js";
import {
  referenceOrder,
  roundRobin,
  row,
  seasonOf,
  seeded,
  standingsOf,
  type G,
} from "./helpers.js";

const codes = (s: SeasonReproduction): string[] => s.findings.map((f) => f.code);

describe("reproduceSeason — the chain, level by level (reading (a), TOTAL_POINTS_SCORED)", () => {
  it("win % alone: a clean season reproduces, deciding level win_pct, (b) differs", () => {
    // 1 beats everyone, 2 beats 3 and 4, 3 beats 4 — but 4 scores the most points
    const games: G[] = [
      [1, 2, 101, 100],
      [1, 3, 101, 100],
      [1, 4, 101, 100],
      [2, 3, 101, 100],
      [2, 4, 101, 100],
      [3, 4, 101, 100],
      [4, 1, 300, 1],
    ];
    const teams = seeded(standingsOf([1, 2, 3, 4], games), [1, 2, 3, 4]);
    // 1 is 3-1, 2 is 2-1, 3 is 1-2, 4 is 1-3: distinct win % everywhere
    const s = reproduceSeason(seasonOf({ teams, games }));
    expect(s.espn_rule.exact).toBe(true);
    expect(s.espn_rule.deciding_level).toBe("win_pct");
    expect(s.points_only.exact).toBe(false);
    expect(s.reproduced_by).toBe("espn_rule");
    expect(s.records_agree).toBe(true);
    expect(codes(s)).toEqual([]);
    expect(s.note).toMatch(/reproduced exactly under espn_rule/);
  });

  it("points for breaks a win % tie", () => {
    const games: G[] = [
      [1, 2, 120, 100],
      [3, 4, 110, 100],
      [2, 3, 130, 90],
      [4, 1, 105, 100],
    ];
    // 1: 1-1 PF 220; 2: 1-1 PF 230; 3: 1-1 PF 200; 4: 1-1 PF 205 → by PF 2, 1, 4, 3
    const teams = seeded(standingsOf([1, 2, 3, 4], games), [2, 1, 4, 3]);
    const s = reproduceSeason(seasonOf({ teams, games }));
    expect(s.espn_rule.exact).toBe(true);
    expect(s.espn_rule.deciding_level).toBe("points_for");
    // here the PF order is the seed order, so reading (b) agrees too
    expect(s.points_only.exact).toBe(true);
    expect(s.reproduced_by).toBe("both");
    expect(s.note).toMatch(/both readings/);
  });

  it("head-to-head breaks an equal win % and equal PF", () => {
    const games: G[] = [
      [1, 2, 100, 110], // 2 beats 1
      [1, 3, 120, 90], // 1 beats 3
      [2, 4, 110, 115], // 4 beats 2
      [3, 4, 100, 80], // 3 beats 4
    ];
    // 1: 1-1 PF 220; 2: 1-1 PF 220; 3: 1-1 PF 190; 4: 1-1 PF 195 → 2 (beat 1), 1, 4, 3
    const teams = seeded(standingsOf([1, 2, 3, 4], games), [2, 1, 4, 3]);
    const s = reproduceSeason(seasonOf({ teams, games }));
    expect(s.espn_rule.exact).toBe(true);
    expect(s.espn_rule.deciding_level).toBe("head_to_head");
  });

  it("division record breaks a tie that win %, PF and head-to-head leave (below the division winners)", () => {
    const div = (id: number) => ([1, 2, 5].includes(id) ? 10 : 20);
    const games: G[] = [
      [5, 2, 150, 100], // A division game
      [6, 4, 150, 90], // B division game
      [1, 2, 110, 100], // A division game: 1 is 1-0 in the division
      [3, 4, 100, 110], // B division game: 3 is 0-1 in the division
      [1, 6, 100, 110],
      [3, 5, 110, 100],
    ];
    // winners 6 (2-0) and 5 (1-1, PF 250); then 1 and 3 (1-1, PF 210, never met) → 1 on division
    // record; then 4 (1-1, PF 200), 2 (0-2)
    const t = standingsOf([1, 2, 3, 4, 5, 6], games, div);
    const expected = [6, 5, 1, 3, 4, 2];
    expect(referenceOrder(t, games, "espn_rule")).toEqual(expected);
    const s = reproduceSeason(seasonOf({ teams: seeded(t, expected), games }));
    expect(s.espn_rule.exact).toBe(true);
    expect(s.espn_rule.deciding_level).toBe("division_record");
    expect(s.espn_rule.chain[0]).toBe("division_winners_first");
  });

  it("fewer points against breaks a tie the division record leaves; the other way is a mismatch", () => {
    // 1 and 2 never met, same win %, same PF, no division (null): fewer PA wins
    const g4: G[] = [
      [1, 3, 110, 100],
      [2, 4, 110, 105],
      [3, 4, 50, 40],
    ];
    const t4 = standingsOf([1, 2, 3, 4], g4, () => null);
    const s4 = reproduceSeason(seasonOf({ teams: seeded(t4, [1, 2, 3, 4]), games: g4 }));
    expect(s4.espn_rule.exact).toBe(true);
    expect(s4.espn_rule.deciding_level).toBe("points_against");
    // ESPN seeding them the other way is a mismatch (the [U] PA direction would show here)
    const s4b = reproduceSeason(seasonOf({ teams: seeded(t4, [2, 1, 3, 4]), games: g4 }));
    expect(s4b.espn_rule.exact).toBe(false);
    expect(codes(s4b)).toContain("seed_mismatch");
    expect(isExplained(s4b)).toBe(false);
    expect(s4b.note).toMatch(/unexplained seed mismatch/);
  });

  it("a tie that survives to the coin flip: not exact, explained, consistent up to the coin either way", () => {
    // 1 and 2 are identical in every respect and never met
    const games: G[] = [
      [1, 3, 110, 100],
      [2, 4, 110, 100],
      [3, 4, 100, 90],
    ];
    const t = standingsOf([1, 2, 3, 4], games, () => null);
    for (const order of [
      [1, 2, 3, 4],
      [2, 1, 3, 4],
    ]) {
      const s = reproduceSeason(seasonOf({ teams: seeded(t, order), games }));
      expect(s.espn_rule.coin_flip_decides).toBe(true);
      expect(s.espn_rule.exact).toBe(false);
      expect(s.espn_rule.field_exact).toBe(false);
      expect(s.espn_rule.consistent_up_to_coin).toBe(true);
      expect(s.espn_rule.deciding_level).toBe("coin_flip");
      expect(codes(s)).toContain("coin_flip_decides");
      expect(isExplained(s)).toBe(true);
      expect(s.reproduced_by).toBe("neither");
      expect(s.findings.find((f) => f.code === "coin_flip_decides")?.detail).toMatch(
        / consistent with the chain/,
      );
    }
    // seeds that break the chain above the coin are not consistent
    const bad = reproduceSeason(seasonOf({ teams: seeded(t, [3, 1, 2, 4]), games }));
    expect(bad.espn_rule.consistent_up_to_coin).toBe(false);
    expect(bad.findings.find((f) => f.code === "coin_flip_decides")?.detail).toMatch(
      /not consistent/,
    );
    // a coin flip explains a non-reproduction only when the seeds follow the chain above it
    expect(isExplained(bad)).toBe(false);
    expect(bad.note).toMatch(/unexplained seed mismatch/);
  });
});

describe("reproduceSeason — divisions, readings and the field", () => {
  it("division winners seed first even with a worse record; reading (b) and a one-division read disagree", () => {
    // division 1: {1, 2}; division 2: {3, 4}; 3 wins its weak division at 1-2 while 2 is 2-1
    const games: G[] = [
      [1, 2, 120, 110],
      [1, 3, 120, 100],
      [1, 4, 120, 100],
      [2, 3, 120, 100],
      [2, 4, 120, 100],
      [3, 4, 101, 100],
    ];
    const div = (id: number) => (id <= 2 ? 1 : 2);
    const t = standingsOf([1, 2, 3, 4], games, div);
    // 1: 3-0; 2: 2-1; 3: 1-2; 4: 0-3 → winners 1 and 3 first: 1, 3, 2, 4
    const s = reproduceSeason(seasonOf({ teams: seeded(t, [1, 3, 2, 4]), games, team_count: 2 }));
    expect(s.espn_rule.exact).toBe(true);
    expect(s.divisions).toBe(2);
    expect(s.espn_rule.chain).toEqual([
      "division_winners_first",
      "win_pct",
      "points_for",
      "head_to_head",
      "division_record",
      "points_against",
      "coin_flip",
    ]);
    expect(s.points_only.chain).toEqual(["points_for", "coin_flip"]);
    expect(s.points_only.exact).toBe(false);
    expect(s.note).toMatch(/division winners first/);
  });

  it("a points-only season: (b) reproduces, (a) does not → points_only", () => {
    const games: G[] = [
      [1, 2, 90, 100],
      [1, 3, 90, 100],
      [1, 4, 200, 100],
      [2, 3, 101, 100],
      [2, 4, 101, 100],
      [3, 4, 101, 100],
    ];
    // PF: 1 = 380, 2 = 302, 3 = 301, 4 = 300; wins: 1 = 1, 2 = 3, 3 = 2, 4 = 0
    const t = standingsOf([1, 2, 3, 4], games);
    const s = reproduceSeason(seasonOf({ teams: seeded(t, [1, 2, 3, 4]), games }));
    expect(s.points_only.exact).toBe(true);
    expect(s.espn_rule.exact).toBe(false);
    expect(s.reproduced_by).toBe("points_only");
    expect(s.note).toMatch(/under points_only/);
  });

  it("field_exact holds while the non-playoff seeds are swapped; team_count null compares every team", () => {
    const games: G[] = roundRobin([1, 2, 3, 4, 5, 6], 1).map(([a, b], i): G => [
      a,
      b,
      100 + (a < b ? 10 : 0) + i,
      100,
    ]);
    const t = standingsOf([1, 2, 3, 4, 5, 6], games);
    const order = referenceOrder(t, games, "espn_rule");
    const swapped = [...order.slice(0, 4), order[5] ?? 0, order[4] ?? 0];
    const s = reproduceSeason(seasonOf({ teams: seeded(t, swapped), games, team_count: 4 }));
    expect(s.espn_rule.field_exact).toBe(true);
    expect(s.espn_rule.exact).toBe(false);
    expect(s.espn_rule.mismatches.map((m) => m.team_id).sort()).toEqual(
      [order[4] ?? 0, order[5] ?? 0].sort(),
    );
    const all = reproduceSeason(seasonOf({ teams: seeded(t, swapped), games, team_count: null }));
    expect(all.espn_rule.field_exact).toBe(false);
    const big = reproduceSeason(seasonOf({ teams: seeded(t, order), games, team_count: 99 }));
    expect(big.espn_rule.exact && big.espn_rule.field_exact).toBe(true);
  });
});

describe("reproduceSeason — the schedule: ties, byes, playoff rows", () => {
  it("a tie (winner TIE, as the provider serves it) counts half a win; playoff rows and byes are not read", () => {
    const games: G[] = [
      [1, 2, 100, 100],
      [3, 4, 120, 100],
      [1, 3, 110, 100],
      [2, 4, 105, 100],
    ];
    const t = standingsOf([1, 2, 3, 4], games);
    expect(t.find((x) => x.team_id === 1)?.ties).toBe(1);
    const extra = [
      // a playoff row (period beyond the regular season): never read
      row([4, 1, 500, 1], 99),
      // a bye
      {
        matchup_period: 1,
        winner: "HOME" as const,
        is_bye: true,
        home: { team_id: 1, points: 77 },
        away: null,
      },
    ];
    const s = reproduceSeason(
      seasonOf({
        teams: seeded(t, referenceOrder(t, games, "espn_rule")),
        games,
        periods: [1, 1, 2, 2],
        regular: 2,
        extra,
      }),
    );
    expect(s.regular_games).toBe(4);
    expect(s.records_agree).toBe(true);
    expect(s.espn_rule.exact).toBe(true);
  });

  it("a finished tie read as TIE equals the legacy null-winner row with equal points (Stage C finding matchup-tie-winner-null)", () => {
    const games: G[] = [
      [1, 2, 100, 100],
      [3, 4, 120, 100],
      [1, 3, 110, 100],
      [2, 4, 105, 100],
    ];
    const t = standingsOf([1, 2, 3, 4], games);
    const input = seasonOf({
      teams: seeded(t, referenceOrder(t, games, "espn_rule")),
      games,
      periods: [1, 1, 2, 2],
      regular: 2,
    });
    expect(input.matchups[0]?.winner).toBe("TIE");
    const legacy = {
      ...input,
      matchups: input.matchups.map((m) => (m.winner === "TIE" ? { ...m, winner: null } : m)),
    };
    for (const s of [reproduceSeason(input), reproduceSeason(legacy)]) {
      expect(codes(s)).not.toContain("season_unfinished");
      expect(s.regular_games).toBe(4);
      expect(s.records_agree).toBe(true);
      expect(s.espn_rule.exact).toBe(true);
    }
  });

  it("an undecided row: season_unfinished; a null-winner row with unequal points is undecided too", () => {
    const games: G[] = [
      [1, 2, 120, 100],
      [3, 4, 110, 100],
    ];
    const t = seeded(standingsOf([1, 2, 3, 4], games), [1, 3, 4, 2]);
    const undecided = {
      matchup_period: 2,
      winner: "UNDECIDED" as const,
      is_bye: false,
      home: { team_id: 1, points: 0 },
      away: { team_id: 3, points: 0 },
    };
    const odd = {
      ...undecided,
      winner: null,
      home: { team_id: 2, points: 10 },
      away: { team_id: 4, points: 9 },
    };
    const nullPts = {
      ...undecided,
      winner: null,
      home: { team_id: 2, points: null },
      away: { team_id: 4, points: null },
    };
    const s = reproduceSeason(
      seasonOf({ teams: t, games, periods: [1, 1], regular: 2, extra: [undecided, odd, nullPts] }),
    );
    expect(codes(s)).toContain("season_unfinished");
    expect(s.findings.find((f) => f.code === "season_unfinished")?.detail).toMatch(
      /3 regular-season row/,
    );
    expect(s.regular_games).toBe(2);
  });

  it("matchupPeriodCount missing: regular_season_unknown, no game read, records cannot agree", () => {
    const games: G[] = [[1, 2, 120, 100]];
    const t = seeded(standingsOf([1, 2], games), [1, 2]);
    for (const regular of [null, 0, 1.5]) {
      const s = reproduceSeason(seasonOf({ teams: t, games, regular, team_count: 2 }));
      expect(codes(s)).toContain("regular_season_unknown");
      expect(s.regular_games).toBe(0);
      expect(s.records_agree).toBe(false);
      // the ranking still runs on the standings: win % separates them
      expect(s.espn_rule.exact).toBe(true);
    }
  });

  it("rows naming an unknown team, or a team against itself, are skipped and reported", () => {
    const games: G[] = [[1, 2, 120, 100]];
    const t = seeded(standingsOf([1, 2], games), [1, 2]);
    const s = reproduceSeason(
      seasonOf({
        teams: t,
        games,
        team_count: 2,
        extra: [row([1, 9, 1, 2], 1), row([2, 2, 3, 1], 1)],
      }),
    );
    expect(codes(s)).toContain("schedule_unknown_team");
    expect(s.findings.find((f) => f.code === "schedule_unknown_team")?.detail).toMatch(/^2 /);
    expect(s.espn_rule.exact).toBe(true);
    // rows with an out-of-range period are not regular-season rows
    const s2 = reproduceSeason(
      seasonOf({ teams: t, games, team_count: 2, extra: [row([1, 2, 1, 9], 0)] }),
    );
    expect(s2.regular_games).toBe(1);
  });
});

describe("reproduceSeason — findings that explain a non-reproduction", () => {
  const games: G[] = [
    [1, 2, 120, 100],
    [3, 4, 110, 100],
    [1, 3, 105, 100],
    [2, 4, 101, 100],
  ];
  const base = standingsOf([1, 2, 3, 4], games);
  const order = referenceOrder(base, games, "espn_rule");

  it("seeds missing, duplicated or out of range: seeds_incomplete, never exact", () => {
    const variants: ReproduceTeam[][] = [
      base.map((t) => ({ ...t, playoff_seed: null })),
      seeded(base, order).map((t, i) => (i === 0 ? { ...t, playoff_seed: 2 } : t)),
      seeded(base, order).map((t, i) => (i === 0 ? { ...t, playoff_seed: 9 } : t)),
      seeded(base, order).map((t, i) => (i === 0 ? { ...t, playoff_seed: 1.5 } : t)),
    ];
    for (const teams of variants) {
      const s = reproduceSeason(seasonOf({ teams, games }));
      expect(codes(s)).toContain("seeds_incomplete");
      expect(s.espn_rule.exact).toBe(false);
      expect(s.espn_rule.consistent_up_to_coin).toBe(false);
      expect(s.reproduced_by).toBe("neither");
      expect(isExplained(s)).toBe(true);
      expect(codes(s)).not.toContain("seed_mismatch");
    }
  });

  it("standings that differ from the schedule: records_disagree, listing the teams", () => {
    for (const change of [
      { wins: 9 },
      { losses: 9 },
      { ties: 1 },
      { points_for: 1000 },
      { points_against: 1000 },
    ]) {
      const teams = seeded(base, order).map((t) => (t.team_id === 3 ? { ...t, ...change } : t));
      const s = reproduceSeason(seasonOf({ teams, games }));
      expect(codes(s)).toContain("records_disagree");
      expect(s.records_agree).toBe(false);
      expect(s.findings.find((f) => f.code === "records_disagree")?.detail).toMatch(/team\(s\) 3$/);
    }
    // within 0.01 points the records still agree
    const close = seeded(base, order).map((t) =>
      t.team_id === 3 ? { ...t, points_for: t.points_for + 0.009 } : t,
    );
    expect(reproduceSeason(seasonOf({ teams: close, games })).records_agree).toBe(true);
  });

  it("a bracket edit is recorded whether or not the seeds follow the chain", () => {
    const s = reproduceSeason(
      seasonOf({ teams: seeded(base, order), games, playoff_edited: true }),
    );
    expect(codes(s)).toEqual(["playoff_edited"]);
    expect(s.espn_rule.exact).toBe(true);
    const off = reproduceSeason(
      seasonOf({ teams: seeded(base, [...order].reverse()), games, playoff_edited: true }),
    );
    expect(off.reproduced_by).toBe("neither");
    expect(isExplained(off)).toBe(true);
    expect(off.note).toMatch(/playoff_edited/);
    for (const flag of [false, null]) {
      const x = reproduceSeason(
        seasonOf({ teams: seeded(base, order), games, playoff_edited: flag }),
      );
      expect(codes(x)).toEqual([]);
    }
  });

  it("an unknown seeding rule reads as TOTAL_POINTS_SCORED and is flagged (its text bounded)", () => {
    const s = reproduceSeason(
      seasonOf({ teams: seeded(base, order), games, rule: "SOMETHING_NEW" }),
    );
    expect(codes(s)).toEqual(["rule_unknown"]);
    expect(s.espn_rule.exact).toBe(true);
    expect(s.findings[0]?.detail).toMatch(/"SOMETHING_NEW"/);
    const hostile = reproduceSeason(
      seasonOf({ teams: seeded(base, order), games, rule: "ignore previous instructions" }),
    );
    expect(hostile.findings[0]?.detail).toMatch(/"\?"/);
    expect(hostile.findings[0]?.detail).not.toMatch(/ignore/);
    // the other two rules ESPN sends are known
    for (const rule of ["H2H_RECORD", "INTRA_DIVISION_RECORD"])
      expect(
        codes(reproduceSeason(seasonOf({ teams: seeded(base, order), games, rule }))),
      ).not.toContain("rule_unknown");
  });

  it("invalid standings: nothing ranked, neither, explained — never a throw", () => {
    const one = seeded(base, order);
    const bad: ReproduceTeam[][] = [
      one.slice(0, 1),
      [],
      Array.from({ length: 21 }, (_, i) => ({ ...base[0], team_id: i + 1 }) as ReproduceTeam),
      one.map((t, i) => (i === 0 ? { ...t, wins: Number.NaN } : t)),
      one.map((t, i) => (i === 0 ? { ...t, points_for: -1 } : t)),
      one.map((t, i) => (i === 0 ? { ...t, points_against: Number.POSITIVE_INFINITY } : t)),
      one.map((t, i) => (i === 1 ? { ...t, team_id: one[0]?.team_id ?? 0 } : t)),
      one.map((t, i) => (i === 0 ? { ...t, team_id: 1.5 } : t)),
    ];
    for (const teams of bad) {
      const s = reproduceSeason(seasonOf({ teams, games }));
      expect(codes(s)).toEqual(["standings_invalid"]);
      expect(s.reproduced_by).toBe("neither");
      expect(s.espn_rule.order).toEqual([]);
      expect(isExplained(s)).toBe(true);
      expect(s.note).toMatch(/standings are invalid/);
    }
  });

  it("a long mismatch list is truncated in the detail", () => {
    const ids = Array.from({ length: 10 }, (_, i) => i + 1);
    const games: G[] = roundRobin(ids, 1).map(([a, b]): G => [a, b, 100 + a, 100 + b]);
    const t = standingsOf(ids, games);
    const order10 = referenceOrder(t, games, "espn_rule");
    const s = reproduceSeason(
      seasonOf({ teams: seeded(t, [...order10].reverse()), games, team_count: 4 }),
    );
    const d = s.findings.find(
      (f) => f.code === "seed_mismatch" && f.reading === "espn_rule",
    )?.detail;
    expect(d).toMatch(/10 of 10 seeds differ/);
    expect(d).toMatch(/…\)$/);
  });
});

describe("summarizeReproductions — C4's verdict", () => {
  const games: G[] = [
    [1, 2, 120, 100],
    [3, 4, 110, 100],
    [1, 3, 105, 100],
    [2, 4, 101, 100],
  ];
  const t = standingsOf([1, 2, 3, 4], games);
  const order = referenceOrder(t, games, "espn_rule");
  const ok = (season: number) =>
    reproduceSeason(seasonOf({ teams: seeded(t, order), games, season }));
  const unexplained = (season: number) =>
    reproduceSeason(seasonOf({ teams: seeded(t, [...order].reverse()), games, season }));
  const explained = (season: number) =>
    reproduceSeason(
      seasonOf({ teams: seeded(t, [...order].reverse()), games, season, playoff_edited: true }),
    );

  it("met with ≥ 2 exact seasons under (a) and every other season explained", () => {
    const s = summarizeReproductions([ok(2025), explained(2023), ok(2024)]);
    expect(s.c4_met).toBe(true);
    expect(s.reproduced_espn_rule).toBe(2);
    expect(s.neither).toEqual([2023]);
    expect(s.seasons.map((x) => x.season)).toEqual([2023, 2024, 2025]);
    expect(s.min_seasons).toBe(C4_MIN_SEASONS);
  });

  it("not met with one exact season, or with an unexplained mismatch", () => {
    expect(summarizeReproductions([ok(2024)]).c4_met).toBe(false);
    expect(summarizeReproductions([ok(2024), ok(2025), unexplained(2023)]).c4_met).toBe(false);
    expect(summarizeReproductions([ok(2024)], 1).c4_met).toBe(true);
    expect(summarizeReproductions([]).c4_met).toBe(false);
  });
});

describe("reproductionInputFrom — the provider's normalised shapes", () => {
  it("maps Standing / Matchup / LeagueRules picks and the bracket-edit flag", () => {
    const input = reproductionInputFrom({
      season: 2025,
      standings: [
        {
          team_id: 1,
          division_id: 0,
          playoff_seed: 1,
          wins: 1,
          losses: 0,
          ties: 0,
          points_for: 120,
          points_against: 100,
        },
        {
          team_id: 2,
          division_id: 0,
          playoff_seed: 2,
          wins: 0,
          losses: 1,
          ties: 0,
          points_for: 100,
          points_against: 120,
        },
      ],
      matchups: [
        {
          matchup_period: 1,
          winner: "HOME",
          is_bye: false,
          home: { team_id: 1, points: 120, name: {} as never, points_by_week: {}, is_mine: false },
          away: { team_id: 2, points: 100, name: {} as never, points_by_week: {}, is_mine: false },
        },
        {
          matchup_period: 1,
          winner: null,
          is_bye: true,
          home: { team_id: 3, points: null, name: {} as never, points_by_week: {}, is_mine: false },
          away: null,
        },
      ],
      rules: {
        playoffs: {
          team_count: 1,
          seeding_rule: "TOTAL_POINTS_SCORED",
          seeding_rule_by: 0,
          reseed: false,
          matchup_period_length: 1,
          variable_length: false,
          consolation: true,
          regular_season_matchups: 1,
          matchup_periods: {},
          playoff_weeks: [],
          bye_seeds: null,
        },
      },
      league: { playoff_matchup_edited: false },
    });
    expect(input.matchups[0]?.home).toEqual({ team_id: 1, points: 120 });
    expect(input.matchups[1]?.away).toBeNull();
    expect(input.playoff).toEqual({
      team_count: 1,
      seeding_rule: "TOTAL_POINTS_SCORED",
      seeding_rule_by: 0,
      regular_season_matchups: 1,
    });
    expect(input.playoff_edited).toBe(false);
    expect(reproduceSeason(input).espn_rule.exact).toBe(true);
    const noLeague = reproductionInputFrom({
      ...input,
      standings: input.teams,
      rules: {
        playoffs: {
          ...input.playoff,
          reseed: null,
          matchup_period_length: null,
          variable_length: null,
          consolation: null,
          matchup_periods: {},
          playoff_weeks: [],
          bye_seeds: null,
        },
      },
      matchups: [],
    });
    expect(noLeague.playoff_edited).toBeNull();
  });
});

// --- properties ----------------------------------------------------------------------------------

/** A random finished season: 4–12 teams, 1–3 divisions, a round robin with random integer scores. */
const seasonArb = fc
  .record({
    n: fc.integer({ min: 4, max: 12 }),
    divisions: fc.integer({ min: 1, max: 3 }),
    rounds: fc.integer({ min: 1, max: 2 }),
    // narrow score range → frequent ties at every level
    seed: fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 200, maxLength: 200 }),
  })
  .map(({ n, divisions, rounds, seed }) => {
    const ids = Array.from({ length: n }, (_, i) => (i + 1) * 3);
    const pairs = roundRobin(ids, rounds).slice(0, 150);
    const games: G[] = pairs.map(([a, b], i) => [
      a,
      b,
      100 + (seed[(2 * i) % 200] ?? 0),
      100 + (seed[(2 * i + 1) % 200] ?? 0),
    ]);
    const div = (id: number) => (divisions === 1 ? 0 : (id / 3) % divisions);
    return { ids, games, teams: standingsOf(ids, games, div) };
  });

describe("properties (fast-check) — the shipped chain against an independent reading of the rule", () => {
  it("seeds made by the reference chain reproduce exactly unless a coin flip decides", () => {
    fc.assert(
      fc.property(seasonArb, ({ games, teams }) => {
        for (const mode of ["espn_rule", "points_only"] as const) {
          const order = referenceOrder(teams, games, mode);
          const s = reproduceSeason(seasonOf({ teams: seeded(teams, order), games }));
          const r = mode === "espn_rule" ? s.espn_rule : s.points_only;
          if (r.coin_flip_decides) {
            expect(r.exact).toBe(false);
            expect(r.consistent_up_to_coin).toBe(true);
          } else {
            expect(r.exact).toBe(true);
            expect(r.order).toEqual(order);
          }
          expect(s.records_agree).toBe(true);
        }
      }),
      { numRuns: 150 },
    );
  });

  it("the result does not depend on the order the standings arrive in (absent a coin flip)", () => {
    fc.assert(
      fc.property(seasonArb, fc.integer({ min: 0, max: 1000 }), ({ games, teams }, k) => {
        const order = referenceOrder(teams, games, "espn_rule");
        const a = reproduceSeason(seasonOf({ teams: seeded(teams, order), games }));
        const rotated = seeded(teams, order);
        const shift = k % rotated.length;
        const b = reproduceSeason(
          seasonOf({ teams: [...rotated.slice(shift), ...rotated.slice(0, shift)], games }),
        );
        if (!a.espn_rule.coin_flip_decides) {
          expect(b.espn_rule.exact).toBe(a.espn_rule.exact);
          expect(b.espn_rule.order).toEqual(a.espn_rule.order);
          expect(b.espn_rule.deciding_level).toBe(a.espn_rule.deciding_level);
        }
        expect(b.espn_rule.coin_flip_decides).toBe(a.espn_rule.coin_flip_decides);
      }),
      { numRuns: 100 },
    );
  });

  it("swapping two adjacent seeds that the chain separated is always caught", () => {
    fc.assert(
      fc.property(seasonArb, fc.nat(), ({ games, teams }, k) => {
        const order = referenceOrder(teams, games, "espn_rule");
        const s0 = reproduceSeason(seasonOf({ teams: seeded(teams, order), games }));
        fc.pre(!s0.espn_rule.coin_flip_decides);
        const i = k % (order.length - 1);
        const sw = [...order];
        [sw[i], sw[i + 1]] = [sw[i + 1] ?? 0, sw[i] ?? 0];
        const s = reproduceSeason(seasonOf({ teams: seeded(teams, sw), games }));
        expect(s.espn_rule.exact).toBe(false);
        expect(s.espn_rule.mismatches).toHaveLength(2);
      }),
      { numRuns: 100 },
    );
  });
});
