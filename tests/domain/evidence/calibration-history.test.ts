// calibration-history.test.ts — plan 10 §3.3 C8 on the labelled history that exists: "news-augmented
// P(active) Brier ≤ designation-only" (sib research 05 §10 Evaluation "whether merging news improves
// P(active) Brier over designation-only"), scored on the nflverse injury report 2023–2025 joined to
// snap counts (tests/domain/evidence/data/injury_outcomes, re-hashed on read). The evidence merged is
// E10's own: the calibration table (src/domain/evidence/calibration.ts) fed by the earlier seasons'
// scored practice-report claims and `mergePActive`, held out by season (2023 → 2024; 2023–2024 →
// 2025). The official practice report is the only evidence channel with labelled history; the news
// (text) rows accrue during the season, so `table_n` — and with it E10's shown posterior and the
// dropped "priors are hand-set" line — is needs_time (the code path: calibration.test.ts). Soft per
// plan 10's exit gate (C8 "soft with numbers"); the inequality is asserted because it holds.
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildCalibrationTable,
  calibrationStateOf,
  HAND_SET_NOTE,
  PRACTICE_REPORT_HISTORY,
  practiceHistoryClaims,
} from "../../../src/domain/evidence/index.js";
import { evalDocSection, writeEvalDocSection } from "../../backtest/helpers/kdst-history.js";
import {
  brierRow,
  brierSection,
  designationOnly,
  injuryOutcomesManifest,
  loadInjuryOutcomes,
  practiceDesignation,
  rateRows,
  rateSection,
  scoredPracticeClaims,
  statusOfReport,
  type BrierRow,
  type RateRow,
} from "./helpers/injury-outcomes.js";

let briers: BrierRow[];
let rates: RateRow[];

beforeAll(() => {
  briers = [];
  for (const s of [2024, 2025])
    for (const p of ["all", "fantasy"] as const) briers.push(brierRow(s, p));
  rates = rateRows();
  if (process.env.UPDATE_EVALS === "1") {
    writeEvalDocSection("c8-brier", brierSection(briers));
    writeEvalDocSection("c8-rates", rateSection(rates));
  }
}, 60_000);

describe("the labelled history (tests/domain/evidence/data/injury_outcomes)", () => {
  it("holds three seasons; ≥ 97 % of report rows labelled; counts add up to the manifest", () => {
    const m = injuryOutcomesManifest();
    expect(m.seasons.map((s) => s.season)).toEqual([2023, 2024, 2025]);
    const cells = loadInjuryOutcomes();
    for (const s of m.seasons) {
      expect(s.labelled + s.unlabelled + s.no_game).toBe(s.report_rows);
      expect(s.labelled / s.report_rows).toBeGreaterThan(0.97);
      const n = cells.filter((c) => c.season === s.season).reduce((a, c) => a + c.n, 0);
      expect(n).toBe(s.labelled);
    }
  });

  it("reads the official labels as E10 does", () => {
    expect(statusOfReport("Questionable")).toBe("QUESTIONABLE");
    expect(statusOfReport("Doubtful")).toBe("DOUBTFUL");
    expect(statusOfReport("Out")).toBe("OUT");
    expect(statusOfReport("Note")).toBeNull();
    expect(statusOfReport(null)).toBeNull();
    expect(practiceDesignation("Did Not Participate In Practice")).toBe("practice_dnp");
    expect(practiceDesignation("Limited Participation in Practice")).toBe("practice_limited");
    expect(practiceDesignation("Full Participation in Practice")).toBe("practice_full");
    expect(practiceDesignation("Note")).toBeNull();
    expect(practiceDesignation(null)).toBeNull();
    expect(designationOnly(null)).toBe(1);
    expect(designationOnly("QUESTIONABLE")).toBe(0.71);
  });

  it("PRACTICE_REPORT_HISTORY (the product's seed) equals the excerpt's pooled counts", () => {
    const agg = new Map<string, [number, number]>();
    for (const c of loadInjuryOutcomes()) {
      const d = practiceDesignation(c.practice_status);
      if (d === null) continue;
      const k = `${statusOfReport(c.report_status) ?? "ACTIVE"}|${d}`;
      const a = agg.get(k) ?? [0, 0];
      a[0] += c.n;
      a[1] += c.played ? c.n : 0;
      agg.set(k, a);
    }
    expect(agg.size).toBe(PRACTICE_REPORT_HISTORY.length);
    for (const h of PRACTICE_REPORT_HISTORY)
      expect(agg.get(`${h.status}|${h.practice}`), `${h.status} ${h.practice}`).toEqual([
        h.n,
        h.played,
      ]);
    // the seed, built as claims, is the same table the excerpt's claims build
    const a = buildCalibrationTable(practiceHistoryClaims());
    const b = buildCalibrationTable(scoredPracticeClaims(loadInjuryOutcomes()));
    expect(a.rows.map((r) => [r.key, r.n, r.k, r.m])).toEqual(
      b.rows.map((r) => [r.key, r.n, r.k, r.m]),
    );
    for (const [i, r] of a.rows.entries()) expect(r.llr).toBeCloseTo(b.rows[i]?.llr ?? 0, 9);
  });
});

describe("C8 (soft, measured) — E10's evidence-augmented P(active) vs designation-only", () => {
  it("Brier(augmented) ≤ Brier(designation-only) on both held-out seasons, all and fantasy positions", () => {
    expect(briers).toHaveLength(4);
    for (const r of briers) {
      const label = `${String(r.test_season)} ${r.positions}`;
      expect(r.brier_augmented, label).toBeLessThanOrEqual(r.brier_designation);
      expect(r.diff.hi, label).toBeLessThan(0);
      expect(r.n).toBeGreaterThan(1500);
    }
  });

  it("the gain is the evidence's, not only re-fitted base rates: augmented ≤ re-fitted too", () => {
    for (const r of briers) expect(r.brier_augmented).toBeLessThanOrEqual(r.brier_refit);
  });

  it("the history alone never shows E10's posterior: table_n counts news claims, still 0", () => {
    const t = buildCalibrationTable(scoredPracticeClaims(loadInjuryOutcomes()));
    expect(t.n_total).toBeGreaterThan(16_000);
    expect(calibrationStateOf(t)).toEqual({ table_n: 0, note: HAND_SET_NOTE });
  });

  it("(reported) docs/evals/phase3-kdst-news.md holds these numbers", () => {
    expect(evalDocSection("c8-brier")).toBe(brierSection(briers));
    expect(evalDocSection("c8-rates")).toBe(rateSection(rates));
  });
});
