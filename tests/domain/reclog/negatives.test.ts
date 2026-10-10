// negatives.test.ts — plan 10 §3.3 C10: research 05 §8.3's negatives re-checked with the product's
// own numbers (src/domain/reclog/negatives.ts) — every check's verdict rule on synthetic data (each
// branch), then the run over the committed history (nflverse 2024–2025 through the shipped engine
// under the reference league's scoring; the 2025 schedule; nine finished probe-league seasons),
// which must equal the generated sections of docs/evals/phase3-negatives.md (`UPDATE_EVALS=1`
// rewrites them) and reproduce research 05's own transcribed numbers where the method is the same.
import { describe, expect, it } from "vitest";
import {
  NEG_VARIANTS,
  NOT_RECHECKED,
  RESEARCH_PF_CUTOFF_SHARE,
  backupCheck,
  dvpChecks,
  intPenaltyCheck,
  negativesReport,
  pearson,
  pfCutoffCheck,
  qbScarcityCheck,
  seasonLines,
  stackCheck,
  waiverChecks,
  waiverResetCheck,
  type NegLeagueSeason,
  type NegPlayerWeek,
  type NegPosition,
  type NegativeCheck,
  type NegativesInput,
} from "../../../src/domain/reclog/negatives.js";
import { RESEARCH_05_TABLE } from "../../backtest/helpers/replacement-data.js";
import {
  NEG_SEASONS,
  negDocSection,
  negativesInput,
  referencePlan,
  writeNegDocSection,
} from "./negatives-data.js";

// --- synthetic builders ------------------------------------------------------------------------------

const pts = (
  reference: number,
  over: Partial<Record<(typeof NEG_VARIANTS)[number], number>> = {},
) => ({
  reference,
  pass_td_4: over.pass_td_4 ?? reference,
  int_minus_1: over.int_minus_1 ?? reference,
});

function weeks(
  id: string,
  position: NegPosition,
  team: string,
  perWeek: (w: number) => ReturnType<typeof pts>,
  n = 10,
  season = 2025,
): NegPlayerWeek[] {
  return Array.from({ length: n }, (_, i) => ({
    player_id: id,
    position,
    team,
    season,
    week: i + 1,
    points: perWeek(i + 1),
  }));
}

function synth(rows: NegPlayerWeek[], over: Partial<NegativesInput> = {}): NegativesInput {
  return {
    rows,
    seasons: [2025],
    plan: referencePlan(),
    league_size: 10,
    min_games: 8,
    schedule: [],
    league_seasons: [],
    ...over,
  };
}

/** A position's depth: player k scores `top − k·step` every week. */
function depth(
  pos: NegPosition,
  n: number,
  top: number,
  step: number,
  team = (k: number) => `T${String(k)}`,
) {
  return Array.from({ length: n }, (_, k) =>
    weeks(`${pos}${String(k)}`, pos, team(k), () => pts(top - k * step)),
  ).flat();
}

describe("small statistics", () => {
  it("pearson", () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
    expect(pearson([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1, 12);
    expect(pearson([1, 2], [1, 2])).toBeNull();
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
  });

  it("seasonLines: games, points under a variant, the majority position, the season filter", () => {
    const rows = [
      ...weeks("p", "RB", "AA", () => pts(10, { pass_td_4: 7 }), 3),
      ...weeks("p", "WR", "AA", () => pts(10), 1),
      ...weeks("p", "RB", "AA", () => pts(99), 2, 2024),
    ];
    expect(seasonLines(rows, 2025, "reference")).toEqual([
      { player_id: "p", position: "RB", games: 4, points: 40 },
    ]);
    expect(seasonLines(rows, 2025, "pass_td_4")[0]?.points).toBe(31);
  });
});

describe("verdict rules (synthetic)", () => {
  it("waiver: the shipped DP's own numbers", () => {
    const [hoard, never] = waiverChecks(10);
    expect(hoard.product).toMatchObject({
      v_1_16: 95.8,
      v_n_16: 48.5,
      threshold_k1_10_weeks_left: 2.5,
    });
    expect(hoard.verdict).toBe("holds");
    expect(never.verdict).toBe("holds");
    expect(never.product.p_clear_r4_5).toBeLessThan(0.05);
    // a 2-team league: the one rival rarely claims — the threshold is tiny, nothing changes
    expect(waiverChecks(2)[1].verdict).toBe("overturned");
  });

  it("QB scarcity: overturned when QB1 − QB12 exceeds both RB1's and WR1's VOR", () => {
    const flat = [
      ...depth("RB", 40, 15, 0.1),
      ...depth("WR", 40, 15, 0.1),
      ...depth("TE", 15, 10, 0.1),
    ];
    const scarce = synth([...depth("QB", 14, 40, 2), ...flat]);
    expect(qbScarcityCheck(scarce).verdict).toBe("overturned");
    const ok = synth([
      ...depth("QB", 14, 20, 0.05),
      ...depth("RB", 40, 25, 0.5),
      ...depth("WR", 40, 20, 0.3),
      ...depth("TE", 15, 10, 0.1),
    ]);
    const c = qbScarcityCheck(ok);
    expect(c.verdict).toBe("holds");
    expect(c.product["2025.qb10_minus_qb12_ppg"]).toBeCloseTo(0.1, 9);
  });

  it("−2 INT: holds / revised / overturned by the largest top-24 rank move", () => {
    const qbs = (swap: number) =>
      synth(
        Array.from({ length: 30 }, (_, k) =>
          // QB k: 300 − 2k under −2; the first one loses `swap`·2.01 points less under −1 (moves down)
          weeks(`Q${String(k)}`, "QB", `T${String(k)}`, () =>
            pts((300 - 2 * k) / 10, {
              int_minus_1: (300 - 2 * k) / 10 + (k === 0 ? -0.201 * swap : 0),
            }),
          ),
        ).flat(),
      );
    expect(intPenaltyCheck(qbs(0)).verdict).toBe("holds");
    expect(intPenaltyCheck(qbs(2)).verdict).toBe("holds_revised");
    expect(intPenaltyCheck(qbs(6)).verdict).toBe("overturned");
  });

  it("stack: any r holds; revised when it moves > 0.1 from 0.35", () => {
    const r1 = synth([
      ...weeks("q", "QB", "AA", (w) => pts(10 + w)),
      ...weeks("w", "WR", "AA", (w) => pts(5 + 2 * w)),
      ...weeks("w2", "WR", "AA", () => pts(1)),
    ]);
    const c = stackCheck(r1);
    expect(c.product["2025.r"]).toBe(1);
    expect(c.verdict).toBe("holds_revised");
    const none = stackCheck(synth(weeks("q", "QB", "AA", (w) => pts(w))));
    expect(none.product.pooled_r).toBeNull();
    expect(none.verdict).toBe("holds");
  });

  it("backup QB: overturned when QB10 − QB12 ≥ 1 pt/game", () => {
    const tight = synth([
      ...depth("QB", 14, 20, 0.2),
      ...depth("TE", 15, 10, 0.5),
      ...depth("RB", 30, 15, 0.2),
      ...depth("WR", 30, 15, 0.2),
    ]);
    expect(backupCheck(tight).verdict).toBe("holds");
    const wide = synth([
      ...depth("QB", 14, 30, 1),
      ...depth("TE", 15, 10, 0.5),
      ...depth("RB", 30, 15, 0.2),
      ...depth("WR", 30, 15, 0.2),
    ]);
    expect(backupCheck(wide).verdict).toBe("overturned");
  });

  it("DvP: not re-checked without a schedule; overturned when defences are perfectly persistent", () => {
    expect(dvpChecks(synth([])).every((c) => c.verdict === "not_rechecked")).toBe(true);
    // four offences, each facing its own defence every week; offence k scores 10 + k at every position
    const rows: NegPlayerWeek[] = [];
    const schedule = [];
    for (let k = 0; k < 4; k++)
      for (const pos of ["QB", "RB", "WR", "TE"] as const)
        rows.push(...weeks(`${pos}${String(k)}`, pos, `O${String(k)}`, () => pts(10 + k), 17));
    for (let w = 1; w <= 17; w++)
      for (let k = 0; k < 4; k++)
        schedule.push({ season: 2025, week: w, team: `O${String(k)}`, opponent: `D${String(k)}` });
    const [dvp, sos] = dvpChecks(synth(rows, { schedule }));
    expect(dvp.product.mean_r).toBe(1);
    expect(dvp.verdict).toBe("overturned");
    expect(sos.verdict).toBe("overturned");
  });

  const league = (
    lastInWins: number,
    firstOutWins: number,
    over: Partial<NegLeagueSeason> = {},
  ): NegLeagueSeason => ({
    playoff_team_count: 2,
    waiver_order_reset: false,
    uses_faab: false,
    teams: [
      { wins: 9, losses: 1, ties: 0, points_for: 1500, playoff_seed: 1 },
      { wins: lastInWins, losses: 10 - lastInWins, ties: 0, points_for: 1400, playoff_seed: 2 },
      { wins: firstOutWins, losses: 10 - firstOutWins, ties: 0, points_for: 1300, playoff_seed: 3 },
    ],
    ...over,
  });

  it("the PF cutoff: holds near 56 %, revised far from it, overturned at 0, not re-checked without data", () => {
    expect(pfCutoffCheck([league(6, 6), league(6, 5)]).verdict).toBe("holds");
    expect(pfCutoffCheck([league(6, 6), league(6, 5), league(7, 5), league(7, 4)]).verdict).toBe(
      "holds_revised",
    );
    expect(pfCutoffCheck([league(6, 5)]).verdict).toBe("overturned");
    expect(pfCutoffCheck([]).verdict).toBe("not_rechecked");
    // a league without a seed after the cutoff is skipped, not counted
    expect(pfCutoffCheck([league(6, 6, { playoff_team_count: 3 })]).verdict).toBe("not_rechecked");
    expect(RESEARCH_PF_CUTOFF_SHARE).toBe(0.56);
  });

  it("waiver order: rolling priority leagues exist → holds", () => {
    expect(waiverResetCheck([league(6, 6)]).verdict).toBe("holds");
    expect(
      waiverResetCheck([league(6, 6, { uses_faab: true, waiver_order_reset: true })]).verdict,
    ).toBe("holds_revised");
    expect(waiverResetCheck([]).verdict).toBe("not_rechecked");
  });
});

describe("sparse data never throws", () => {
  it("missing ranks read as 0, an empty pool or level shift is n/a, an empty range has no r", () => {
    const rows = [
      ...weeks("q1", "QB", "AA", () => pts(0), 9),
      ...weeks("q2", "QB", "BB", () => pts(0), 9),
      ...weeks("t1", "TE", "AA", () => pts(3), 2),
    ];
    const input = synth(rows, {
      schedule: [
        { season: 2025, week: 1, team: "AA", opponent: "BB" },
        { season: 2025, week: 20, team: "CC", opponent: "DD" },
      ],
    });
    const q = qbScarcityCheck(input);
    expect(q.product["2025.qb_vor_pool_change_pct"]).toBeNull();
    expect(q.product["2025.qb1_minus_qb12"]).toBe(0);
    const i = intPenaltyCheck(input);
    expect(i.product["2025.level_shift_pct"]).toBeNull();
    expect(i.product["2025.penalty_share_pct"]).toBeNull();
    expect(i.verdict).toBe("holds");
    expect(backupCheck(input).product["2025.qb10_minus_qb12_ppg"]).toBe(0);
    const [dvp, sos] = dvpChecks(input);
    expect(dvp.product.mean_r).toBeNull();
    expect(dvp.verdict).toBe("overturned");
    expect(sos.product["2025.QB"]).toBeNull();
    expect(stackCheck(input).product["2025.n_pairs"]).toBe(0);
    expect(() => negativesReport(input)).not.toThrow();
  });

  it("a tie for a team's WR1 goes to the smaller key", () => {
    const rows = [
      ...weeks("q", "QB", "AA", (w) => pts(w)),
      ...weeks("b", "WR", "AA", (w) => pts(w)),
      ...weeks("a", "WR", "AA", () => pts(55 / 10)),
    ];
    // both WRs total 55: "a" (the constant one) wins on the smaller key, so r has no variance
    expect(stackCheck(synth(rows)).product["2025.r"]).toBeNull();
  });
});

// --- the committed history and the eval document --------------------------------------------------------

/** Research 05 §8.3's claim and its number, per check (transcribed; the doc's left columns). */
const CLAIMS: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  hoard_first_slot: [
    "Hoard the #1 waiver slot for the league-winner",
    "V(1,16) = 96; Π(1, W) ≈ 2.5 pts/week with 10 weeks left",
  ],
  never_claim_high_slot: [
    "Never claim from a high slot — wait for free agency",
    "a player worth claiming clears with probability near zero",
  ],
  five_point_td_qb_early: [
    "5-pt passing TDs mean draft a QB early",
    "QB1 − QB12 = 160.0 / 105.9 vs RB1 176 / 224, WR1 158 / 140; +6–18 % QB VOR pool; 0–1 pt/game QB1 edge",
  ],
  int_minus_two_unstartable: [
    "−2 INT makes turnover-prone QBs unstartable",
    "no top-24 QB moves > 1 rank; a 7–12 % level shift",
  ],
  stack_scores_more: [
    "Stack QB–WR to score more",
    "correlation 0.35 (this format, 2024–2025): variance, not the mean",
  ],
  decided_matchup_rest_irrelevant: [
    "When the matchup is decided, the rest of the week doesn't matter",
    "PF decides the 6th seed in 56 % of simulated seasons (6 of 10)",
  ],
  carry_backup_qb_te: [
    "Carry a backup QB/TE for the bye",
    "QB10 − QB12 < 1 pt/game; TE5+ is replacement",
  ],
  espn_dvp_ranks_matchups: [
    "ESPN's position-vs-opponent ratings rank the matchups",
    "near noise (YoY r 0.15–0.27); regress toward 1",
  ],
  september_sos_for_playoffs: [
    "Plan playoff-week lineups by strength of schedule in September",
    "YoY r 0.15–0.27 — a negative",
  ],
  waiver_order_resets: [
    "The waiver order resets weekly, so priority doesn't matter",
    "wrong for a rolling league; ESPN offers both",
  ],
});

/** How a product key reads in the doc (keys without a label print as they are). */
const LABELS: Readonly<Record<string, string>> = Object.freeze({
  v_1_16: "V(1,16)",
  v_n_16: "V(10,16)",
  threshold_k1_10_weeks_left: "#1-slot threshold, 10 weeks left (pts/week)",
  p_clear_r2_5: "P(clears 9 rivals) at 2.5 pts/week",
  p_clear_r4_5: "at 4.5",
  p_clear_r7: "at 7",
  qb1_minus_qb12: "QB1 − QB12",
  rb1_vor: "RB1 VOR",
  wr1_vor: "WR1 VOR",
  qb_vor_pool_change_pct: "QB VOR pool 4 → 5 pt (%)",
  qb1_edge_change_ppg: "QB1 edge 4 → 5 pt (pts/game)",
  qb10_minus_qb12_ppg: "QB10 − QB12 (pts/game)",
  max_rank_move_top24: "largest top-24 rank move",
  level_shift_pct: "−1 → −2 level shift (%)",
  penalty_share_pct: "−2 penalty share (%)",
  r: "r",
  n_pairs: "QB–WR1 weeks",
  pooled_r: "pooled r",
  league_seasons: "league-seasons",
  pf_decided_last_seat: "PF decided the last seat",
  share: "share",
  te5_vor_ppg: "TE5 VOR (pts/game)",
  mean_r: "mean r",
  priority_leagues: "priority (non-FAAB) league-seasons",
  rolling: "rolling",
});

function label(key: string): string {
  const bare = key.replace(/^\d{4}\./, "");
  return LABELS[bare] ?? bare;
}

/** One check's numbers: season-prefixed keys grouped by season, the rest after. */
function numbers(c: NegativeCheck): string {
  const bySeason = new Map<string, string[]>();
  const rest: string[] = [];
  for (const [k, v] of Object.entries(c.product)) {
    const shown = v === null ? "n/a" : String(v);
    const m = /^(\d{4})\./.exec(k);
    if (m?.[1] !== undefined)
      bySeason.set(m[1], [...(bySeason.get(m[1]) ?? []), `${label(k)} ${shown}`]);
    else rest.push(`${label(k)} ${shown}`);
  }
  const parts = [...bySeason.entries()].map(([s, xs]) => `**${s}:** ${xs.join(", ")}`);
  if (rest.length > 0) parts.push(rest.join(", "));
  return parts.join("; ");
}

/** The generated results table (one row per check, research 05 §8.3's order). */
function resultsSection(report: readonly NegativeCheck[]): string {
  const rows = report.map((c, i) => {
    const [claim, research] = CLAIMS[c.id] ?? [c.id, "—"];
    return `| ${String(i + 1)} | ${claim} | ${research} | ${numbers(c)} | **${c.verdict.replace("_", " ")}** — ${c.rule} |`;
  });
  return [
    "| # | Claim (research 05 §8.3) | Research 05 said | The product's numbers | Verdict — rule |",
    "|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

/** The generated not-re-checked list. */
function notRecheckedSection(): string {
  return Object.entries(NOT_RECHECKED)
    .map(([id, why]) => `- \`${id}\` — ${why}`)
    .join("\n");
}

describe("C10 over the committed history", () => {
  const report = negativesReport(negativesInput());
  const byId = new Map(report.map((c) => [c.id, c]));
  const n = (id: string, key: string): number => {
    const v = byId.get(id)?.product[key];
    if (typeof v !== "number") throw new Error(`${id}.${key} missing`);
    return v;
  };

  it("checks every computable negative, in research 05's order, on both committed seasons", () => {
    expect(report.map((c) => c.id)).toEqual(Object.keys(CLAIMS));
    expect(NEG_SEASONS).toEqual([2024, 2025]);
  });

  it("reproduces research 05's own numbers where the method is the same (hard)", () => {
    for (const s of [2024, 2025] as const) {
      const t = RESEARCH_05_TABLE[s].totals.qb;
      expect(
        Math.abs(n("five_point_td_qb_early", `${String(s)}.qb1_minus_qb12`) - (t.qb1 - t.qb12)),
      ).toBeLessThan(0.15);
      expect(
        n("int_minus_two_unstartable", `${String(s)}.max_rank_move_top24`),
      ).toBeLessThanOrEqual(1);
      expect(n("carry_backup_qb_te", `${String(s)}.qb10_minus_qb12_ppg`)).toBeLessThan(1);
    }
    expect(n("hoard_first_slot", "v_1_16")).toBe(95.8);
    expect(n("hoard_first_slot", "threshold_k1_10_weeks_left")).toBe(2.5);
    expect(Math.abs(n("stack_scores_more", "pooled_r") - 0.35)).toBeLessThanOrEqual(0.1);
    expect(n("decided_matchup_rest_irrelevant", "league_seasons")).toBe(9);
    expect(n("waiver_order_resets", "rolling")).toBeGreaterThan(0);
  });

  it("no negative is overturned on this history", () => {
    expect(report.filter((c) => c.verdict === "overturned").map((c) => c.id)).toEqual([]);
  });

  it("docs/evals/phase3-negatives.md shows exactly these numbers (UPDATE_EVALS=1 rewrites)", () => {
    const results = resultsSection(report);
    const skipped = notRecheckedSection();
    if (process.env.UPDATE_EVALS === "1") {
      writeNegDocSection("negatives-results", results);
      writeNegDocSection("negatives-not-rechecked", skipped);
    }
    expect(negDocSection("negatives-results")).toBe(results);
    expect(negDocSection("negatives-not-rechecked")).toBe(skipped);
  });
});
