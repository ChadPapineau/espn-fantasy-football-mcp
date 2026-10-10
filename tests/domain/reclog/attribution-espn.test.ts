// attribution-espn.test.ts — plan 10 C9's attribution on recorded ESPN data (the code path E13 runs,
// proven on fixtures while the season's own projection snapshots accrue — needs_time): every box-score
// entry of league-b (current season sp1–3, and the finished 2024 and 2025 seasons' weeks 1–17 with
// ESPN's weekly projections, fixtures/espn/recorded/history) becomes an AttributionRow through
// `attributionRowFromEspn`, with ESPN's own projected line as the "model" expectation. The layers sum
// to the error on every row; the `scoring` layer is the golden's residual (≤ 0.01 — the engine is
// ESPN's scorer); a did-not-play entry is all availability. The aggregate — ESPN's own weekly
// projection error by layer under league-b's scoring — is a soft number written to
// docs/evals/phase3-negatives.md (`UPDATE_EVALS=1` rewrites it). Scrubbed fixtures only.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_LAYERS,
  ESPN_GP_STAT_ID,
  attributePlayerWeek,
  attributionMap,
  attributionRowFromEspn,
  playedFromEspn,
  type AttributionRow,
  type PlayerWeekAttribution,
} from "../../../src/domain/reclog/attribution.js";
import {
  normalizeSettings,
  statLineFromEspn,
  type ScoringSettings,
} from "../../../src/domain/scoring/index.js";
import { ROOT } from "../../backtest/helpers/waiver-excerpt.js";
import { historyBody } from "../../fixtures/helpers/history-fixtures.js";
import { negDocSection, writeNegDocSection } from "./negatives-data.js";

/** ESPN default position ids → display positions (research 03 §B.2). */
const DISPLAY: Readonly<Record<number, string>> = Object.freeze({
  1: "QB",
  2: "RB",
  3: "WR",
  4: "TE",
  5: "K",
  16: "D/ST",
});

interface RawStat {
  statSourceId: number;
  statSplitTypeId: number;
  scoringPeriodId: number;
  appliedTotal?: number;
  stats?: Record<string, number>;
}
interface RawEntry {
  playerPoolEntry: { player: { id: number; defaultPositionId: number; stats?: RawStat[] } };
}
interface RawBox {
  schedule: {
    home?: { rosterForCurrentScoringPeriod?: { entries?: RawEntry[] } };
    away?: { rosterForCurrentScoringPeriod?: { entries?: RawEntry[] } };
  }[];
}

/** league-b's scoring for a season (`mSettings` through the shipped normaliser). */
function scoringOf(body: unknown): ScoringSettings {
  return normalizeSettings(
    (body as { settings: { scoringSettings: unknown } }).settings.scoringSettings,
  );
}

/** One box score's rows: ESPN's projected line as the expectation, the actual line as realised. */
function rowsOf(box: RawBox, week: number): AttributionRow[] {
  const out: AttributionRow[] = [];
  for (const m of box.schedule)
    for (const side of [m.home, m.away])
      for (const e of side?.rosterForCurrentScoringPeriod?.entries ?? []) {
        const p = e.playerPoolEntry.player;
        const pick = (src: number): RawStat | undefined =>
          (p.stats ?? []).find(
            (s) => s.statSourceId === src && s.statSplitTypeId === 1 && s.scoringPeriodId === week,
          );
        const proj = pick(1);
        const act = pick(0);
        const position = DISPLAY[p.defaultPositionId];
        if (proj === undefined || act === undefined || position === undefined) continue;
        const r = attributionRowFromEspn({
          week,
          player_id: p.id,
          gsis_id: null,
          position,
          position_id: p.defaultPositionId,
          model_version: "v1-ensemble",
          expectation: statLineFromEspn({ raw: proj.stats ?? {} }, p.defaultPositionId).line.values,
          reported_mean: proj.appliedTotal ?? 0,
          p_active: null,
          actual_raw: act.stats ?? {},
          applied_total: act.appliedTotal ?? null,
          espn_mean: proj.appliedTotal ?? null,
          trace: null,
        });
        if (r !== null) out.push(r);
      }
  return out;
}

function attributeAll(
  rows: readonly AttributionRow[],
  s: ScoringSettings,
): PlayerWeekAttribution[] {
  return rows.map((r) => {
    const a = attributePlayerWeek(r, s);
    if (!a.ok) throw new Error(`refused ${a.reason} (week ${String(r.week)})`);
    return a.value;
  });
}

const sum = (a: PlayerWeekAttribution): number =>
  ATTRIBUTION_LAYERS.reduce((t, l) => t + a.layers[l], 0);

describe("playedFromEspn", () => {
  it("gp decides; without gp any non-zero stat; an empty or missing line did not play", () => {
    expect(playedFromEspn({ [ESPN_GP_STAT_ID]: 1, "42": 0 })).toBe(true);
    expect(playedFromEspn({ [ESPN_GP_STAT_ID]: 0, "42": 12 })).toBe(false);
    expect(playedFromEspn({ "42": 12 })).toBe(true);
    expect(playedFromEspn({ "42": 0 })).toBe(false);
    expect(playedFromEspn({})).toBe(false);
    expect(playedFromEspn(null)).toBe(false);
  });

  it("attributionRowFromEspn: no applied total or drifted stats → no row", () => {
    const base = {
      week: 3,
      player_id: 1,
      gsis_id: null,
      position: "WR",
      position_id: 3,
      model_version: "v1-ensemble" as const,
      expectation: {},
      reported_mean: 0,
      p_active: null,
      actual_raw: { [ESPN_GP_STAT_ID]: 1, "42": 10 },
      applied_total: 1,
      espn_mean: null,
      trace: null,
    };
    expect(attributionRowFromEspn({ ...base, applied_total: null })).toBeNull();
    expect(
      attributionRowFromEspn({ ...base, actual_raw: { [ESPN_GP_STAT_ID]: 1, "42": Number.NaN } }),
    ).toBeNull();
    expect(attributionRowFromEspn(base)?.realised).toEqual({ gp: 1, rec_yd: 10 });
    expect(attributionRowFromEspn({ ...base, actual_raw: null })).toMatchObject({
      active: false,
      realised: {},
    });
  });
});

describe("league-b's current season (sp1–3): ESPN's projection as the expectation", () => {
  const dir = path.join(ROOT, "fixtures/espn/recorded/league-b");
  const s = scoringOf(JSON.parse(readFileSync(path.join(dir, "mSettings.json"), "utf8")));
  const rows = [1, 2, 3].flatMap((w) =>
    rowsOf(
      JSON.parse(readFileSync(path.join(dir, `mBoxscore.sp${String(w)}.json`), "utf8")) as RawBox,
      w,
    ),
  );
  const att = attributeAll(rows, s);

  it("every entry attributes; the layers sum to the error; the scoring layer is the golden's residual", () => {
    expect(att.length).toBeGreaterThan(300);
    for (const a of att) {
      expect(Math.abs(sum(a) - a.error)).toBeLessThan(1e-6);
      expect(Math.abs(a.layers.scoring)).toBeLessThanOrEqual(0.011);
    }
  });

  it("a did-not-play entry is all availability (and anchor), nothing else", () => {
    const dnp = att.filter((a) => !a.active);
    expect(dnp.length).toBeGreaterThan(0);
    for (const a of dnp) {
      expect(a.layers.opportunity + a.layers.efficiency + a.layers.touchdowns).toBe(0);
      expect(a.layers.availability).toBeCloseTo(-a.expected_points, 9);
    }
  });
});

describe("league-b 2024–2025 (weeks 1–17): ESPN's own weekly projection error by layer (soft)", () => {
  const all: PlayerWeekAttribution[] = [];
  for (const season of [2024, 2025]) {
    const s = scoringOf(historyBody(season, "league-b", "mSettings"));
    for (let w = 1; w <= 17; w++)
      all.push(
        ...attributeAll(
          rowsOf(
            historyBody(season, "league-b", `mBoxscore.sp${String(w)}`) as unknown as RawBox,
            w,
          ),
          s,
        ),
      );
  }

  it("thousands of player-weeks, the identity on every one, the scoring residual ≤ 0.011 but one", () => {
    expect(all.length).toBeGreaterThan(4000);
    for (const a of all) expect(Math.abs(sum(a) - a.error)).toBeLessThan(1e-6);
    // the one engine-vs-ESPN gap in two seasons lands where it belongs — the `scoring` layer: a
    // kicker's 6 rushing yards (ESPN stat 24) in 2025 week 15, which ESPN scores (0.6) and the
    // engine's class gating does not (rush_yd applies to offence only) — reported to the scoring owner
    const off = all.filter((a) => Math.abs(a.layers.scoring) > 0.011);
    expect(off.map((a) => [a.week, a.position, Number(a.layers.scoring.toFixed(2))])).toEqual([
      [15, "K", 0.6],
    ]);
  });

  it("docs/evals/phase3-negatives.md shows the aggregate (UPDATE_EVALS=1 rewrites)", () => {
    const agg = attributionMap(all, [], 30).map;
    const pct = (l: string): string => {
      const total = ATTRIBUTION_LAYERS.reduce((t, x) => t + (agg[`${x}.mae`] ?? 0), 0);
      return total > 0 ? ((100 * (agg[`${l}.mae`] ?? 0)) / total).toFixed(0) : "0";
    };
    const rows = ATTRIBUTION_LAYERS.map(
      (l) => `| ${l} | ${String(agg[`${l}.mean`])} | ${String(agg[`${l}.mae`])} | ${pct(l)} % |`,
    );
    const positions = ["QB", "RB", "WR", "TE", "K", "D/ST"].filter(
      (p) => agg[`${p}.n`] !== undefined,
    );
    const byPos = positions.map(
      (p) =>
        `| ${p} | ${String(agg[`${p}.n`])} | ${String(agg[`${p}.error.mae`])} | ${["availability", "opportunity", "efficiency", "touchdowns"].map((l) => String(agg[`${p}.${l}.mae`])).join(" | ")} |`,
    );
    const section = [
      `${String(agg.n_player_weeks)} player-weeks; error = ESPN appliedTotal − ESPN's projected appliedTotal: mean ${String(agg["error.mean"])}, MAE ${String(agg["error.mae"])}.`,
      "",
      "| Layer | Mean | MAE | Share of Σ MAE |",
      "|---|---|---|---|",
      ...rows,
      "",
      "| Position | n | Error MAE | Availability MAE | Opportunity MAE | Efficiency MAE | Touchdowns MAE |",
      "|---|---|---|---|---|---|---|",
      ...byPos,
    ].join("\n");
    if (process.env.UPDATE_EVALS === "1") writeNegDocSection("espn-attribution", section);
    expect(negDocSection("espn-attribution")).toBe(section);
  });
});
