// injury-outcomes.ts — plan 10 §3.3 C8 on history: the labelled injury-report history (official game
// status + the week's practice participation → did he take a snap; nflverse 2023–2025, committed
// aggregated in tests/domain/evidence/data/injury_outcomes, re-hashed on read) scored three ways —
// designation-only (the shipped P_ACTIVE_BY_STATUS base rates), the base rates re-fitted on the
// training seasons, and E10's evidence-augmented P(active): the calibration table (src/domain/
// evidence/calibration.ts) fed by the training seasons' scored practice-report claims, merged by
// `mergePActive` — held out by season (2023 → 2024; 2023–2024 → 2025). The official practice
// report is the only evidence channel with labelled history; the news (text) rows accrue in season.
// Pure; nothing is fetched.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { P_ACTIVE_BY_STATUS } from "../../../../src/domain/analytics/constants.js";
import {
  buildCalibrationTable,
  claimOutcome,
  mergePActive,
  type CalibrationTable,
  type Designation,
  type ScoredClaim,
} from "../../../../src/domain/evidence/index.js";
import type { InjuryStatus } from "../../../../src/domain/league/types.js";
import { decodeTsv } from "../../../sources/nflverse/helpers/tsv.js";

const ROOT = new URL("../../../../", import.meta.url).pathname;
export const INJURY_OUTCOMES_DIR = join(ROOT, "tests/domain/evidence/data/injury_outcomes");
export const INJURY_OUTCOME_SEASONS = Object.freeze([2023, 2024, 2025] as const);
export const INJURY_OUTCOME_COLUMNS = Object.freeze([
  "season",
  "week",
  "position",
  "report_status",
  "practice_status",
  "played",
  "n",
] as const);

/** The fantasy positions reported apart (every other position is `OTHER`). */
export const FANTASY_POSITIONS = Object.freeze(["QB", "RB", "WR", "TE", "K"] as const);

/** The committed position bucket of an nflverse position. */
export function positionBucket(position: string | null): string {
  return position !== null && (FANTASY_POSITIONS as readonly string[]).includes(position)
    ? position
    : "OTHER";
}

export interface InjuryOutcomesManifest {
  readonly $comment: string;
  readonly retrieved: string;
  readonly outcome: string;
  readonly file: {
    readonly path: string;
    readonly rows: number;
    readonly bytes: number;
    readonly sha256: string;
  };
  readonly seasons: readonly {
    readonly season: number;
    readonly report_rows: number;
    readonly labelled: number;
    readonly unlabelled: number;
    readonly no_game: number;
  }[];
  readonly upstream: readonly {
    readonly file: string;
    readonly url: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly rows: number;
    readonly nflverse_timestamp: string | null;
  }[];
}

/** One aggregated cell of the labelled history. */
export interface OutcomeCell {
  readonly season: number;
  readonly week: number;
  readonly position: string;
  readonly report_status: string | null;
  readonly practice_status: string | null;
  readonly played: boolean;
  readonly n: number;
}

export function injuryOutcomesManifest(): InjuryOutcomesManifest {
  return JSON.parse(
    readFileSync(join(INJURY_OUTCOMES_DIR, "manifest.json"), "utf8"),
  ) as InjuryOutcomesManifest;
}

let cached: OutcomeCell[] | null = null;
/** The committed cells, the file re-hashed against the manifest. */
export function loadInjuryOutcomes(): readonly OutcomeCell[] {
  if (cached !== null) return cached;
  const m = injuryOutcomesManifest();
  const text = readFileSync(join(INJURY_OUTCOMES_DIR, m.file.path), "utf8");
  if (createHash("sha256").update(text).digest("hex") !== m.file.sha256)
    throw new Error("injury_outcomes: outcomes.tsv does not hash to its manifest entry");
  const rows = decodeTsv(
    INJURY_OUTCOME_COLUMNS.map((c) => ({ name: c })),
    text,
  );
  if (rows.length !== m.file.rows) throw new Error("injury_outcomes: row count differs");
  cached = rows.map((r) => ({
    season: r[0] as number,
    week: r[1] as number,
    position: r[2] as string,
    report_status: r[3] as string | null,
    practice_status: r[4] as string | null,
    played: r[5] === 1,
    n: r[6] as number,
  }));
  return cached;
}

/** The ESPN status an official game status reads as (none and "Note" → no designation). */
export function statusOfReport(report: string | null): InjuryStatus | null {
  if (report === "Questionable") return "QUESTIONABLE";
  if (report === "Doubtful") return "DOUBTFUL";
  if (report === "Out") return "OUT";
  return null;
}

/** The practice designation of an official practice label (E10's reading of the same enum). */
export function practiceDesignation(label: string | null): Designation | null {
  if (label === null) return null;
  const s = label.toLowerCase();
  if (/\b(did not participate|did not practice|dnp)\b/.test(s)) return "practice_dnp";
  if (/\blimited\b/.test(s)) return "practice_limited";
  if (/\bfull\b/.test(s)) return "practice_full";
  return null;
}

/** Designation-only P(active): the shipped base rate of the status (none → ACTIVE = 1). */
export function designationOnly(status: InjuryStatus | null): number {
  return P_ACTIVE_BY_STATUS[status ?? "ACTIVE"] ?? 1;
}

/** The training seasons' practice-report cells as scored claims (one counted record per cell). */
export function scoredPracticeClaims(cells: readonly OutcomeCell[]): ScoredClaim[] {
  const out: ScoredClaim[] = [];
  for (const c of cells) {
    const d = practiceDesignation(c.practice_status);
    if (d === null) continue;
    const status = statusOfReport(c.report_status);
    const o = claimOutcome("health", d, { played: c.played });
    out.push({
      source: "official.practice",
      type: "health",
      signal: d,
      prior_status: status,
      prior_p: designationOnly(status),
      active: o.active,
      borne_out: o.borne_out,
      count: c.n,
    });
  }
  return out;
}

/** Base rates re-fitted per status on the training cells (a status never seen keeps the shipped rate). */
export function refitBaseRates(cells: readonly OutcomeCell[]): (s: InjuryStatus | null) => number {
  const agg = new Map<string, [number, number]>();
  for (const c of cells) {
    const k = statusOfReport(c.report_status) ?? "ACTIVE";
    const a = agg.get(k) ?? [0, 0];
    a[0] += c.played ? c.n : 0;
    a[1] += c.n;
    agg.set(k, a);
  }
  return (s) => {
    const a = agg.get(s ?? "ACTIVE");
    return a === undefined || a[1] === 0 ? designationOnly(s) : a[0] / a[1];
  };
}

/** E10's evidence-augmented P(active) of a cell under a table. */
export function augmented(c: OutcomeCell, table: CalibrationTable): number {
  const status = statusOfReport(c.report_status);
  const prior = designationOnly(status);
  const d = practiceDesignation(c.practice_status);
  const p = mergePActive(
    prior,
    status,
    d === null ? [] : [{ source: "official.practice", type: "health", signal: d, time_ms: null }],
    table,
  );
  return p ?? prior;
}

/** A Brier score with the paired difference's 95 % interval (normal, over player-weeks). */
export interface BrierRow {
  readonly test_season: number;
  readonly train: string;
  readonly positions: "all" | "fantasy";
  readonly n: number;
  readonly brier_designation: number;
  readonly brier_refit: number;
  readonly brier_augmented: number;
  /** augmented − designation-only: mean and 95 % interval. */
  readonly diff: { readonly mean: number; readonly lo: number; readonly hi: number };
}

export function brierRow(
  testSeason: number,
  positions: "all" | "fantasy",
  cells: readonly OutcomeCell[] = loadInjuryOutcomes(),
): BrierRow {
  const train = cells.filter((c) => c.season < testSeason);
  const test = cells.filter(
    (c) =>
      c.season === testSeason &&
      (positions === "all" || (FANTASY_POSITIONS as readonly string[]).includes(c.position)),
  );
  const table = buildCalibrationTable(scoredPracticeClaims(train));
  const refit = refitBaseRates(train);
  let n = 0;
  let bd = 0;
  let br = 0;
  let ba = 0;
  let sd = 0;
  let sd2 = 0;
  for (const c of test) {
    const y = c.played ? 1 : 0;
    const status = statusOfReport(c.report_status);
    const pd = designationOnly(status);
    const pr = refit(status);
    const pa = augmented(c, table);
    const d = (pa - y) ** 2 - (pd - y) ** 2;
    n += c.n;
    bd += c.n * (pd - y) ** 2;
    br += c.n * (pr - y) ** 2;
    ba += c.n * (pa - y) ** 2;
    sd += c.n * d;
    sd2 += c.n * d * d;
  }
  const mean = sd / n;
  const se = Math.sqrt(Math.max(0, sd2 / n - mean * mean) / n);
  return {
    test_season: testSeason,
    train: [...new Set(train.map((c) => c.season))].sort().join("–"),
    positions,
    n,
    brier_designation: bd / n,
    brier_refit: br / n,
    brier_augmented: ba / n,
    diff: { mean, lo: mean - 1.96 * se, hi: mean + 1.96 * se },
  };
}

/** The pooled table of P(played) by status × practice (all three seasons), beside the shipped rates. */
export interface RateRow {
  readonly status: string;
  readonly practice: string;
  readonly n: number;
  readonly played: number;
  readonly shipped: number;
}

export function rateRows(cells: readonly OutcomeCell[] = loadInjuryOutcomes()): RateRow[] {
  const agg = new Map<string, [number, number, number]>();
  for (const c of cells) {
    const status = statusOfReport(c.report_status);
    const practice = practiceDesignation(c.practice_status) ?? "none";
    const k = `${status ?? "ACTIVE"}|${practice}`;
    const a = agg.get(k) ?? [0, 0, designationOnly(status)];
    a[0] += c.n;
    a[1] += c.played ? c.n : 0;
    agg.set(k, a);
  }
  return [...agg]
    .map(([k, [n, p, shipped]]) => {
      const [status = "", practice = ""] = k.split("|");
      return { status, practice, n, played: p / n, shipped };
    })
    .sort((a, b) => a.status.localeCompare(b.status) || a.practice.localeCompare(b.practice));
}

const f3 = (x: number): string => x.toFixed(3);
const f4 = (x: number): string => x.toFixed(4);

/** The C8 Brier table (docs/evals/phase3-kdst-news.md). */
export function brierSection(rows: readonly BrierRow[]): string {
  const lines = [
    "| test season | trained on | positions | player-weeks | Brier: designation-only (shipped) | Brier: base rates re-fitted | Brier: E10 evidence-augmented | augmented − designation-only [95 % CI] |",
    "|---|---|---|---:|---:|---:|---:|---|",
  ];
  for (const r of rows)
    lines.push(
      `| ${String(r.test_season)} | ${r.train} | ${r.positions} | ${String(r.n)} | ${f4(r.brier_designation)} | ${f4(r.brier_refit)} | ${f4(r.brier_augmented)} | ${f4(r.diff.mean)} [${f4(r.diff.lo)}, ${f4(r.diff.hi)}] |`,
    );
  return lines.join("\n");
}

/** The pooled rate table. */
export function rateSection(rows: readonly RateRow[]): string {
  const lines = [
    "| official status | final practice | player-weeks | played | shipped designation-only P(active) |",
    "|---|---|---:|---:|---:|",
  ];
  for (const r of rows)
    lines.push(
      `| ${r.status} | ${r.practice} | ${String(r.n)} | ${f3(r.played)} | ${f3(r.shipped)} |`,
    );
  return lines.join("\n");
}
