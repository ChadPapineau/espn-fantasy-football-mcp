// waivers.test.ts — plan 10 A9a's soft part: the hindsight replay of research 05 §1.6 over the
// nflverse 2024–2025 excerpt against the trending baseline (research 05 §8.4 #4), reported in
// docs/evals/1a-backtest.md. Hard here: the excerpt pipeline keeps the reference scoring (built from
// the committed 2026 excerpt's parquet, every part re-hashed on load, tampering refused); the replay's
// pieces on a constructed season (availability by prior per-game rank, the hindsight and forecast
// surpluses, the shipped strike — the rule never claims below Π(k, W) —, the move-to-last order,
// the baselines' picks, determinism). Reported: the numbers, or that the excerpt is not committed.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WAIVER_DP } from "../../src/domain/analytics/constants.js";
import { solvePremiumTable } from "../../src/domain/analytics/waiverDp.js";
import { roleHolds } from "../../src/domain/analytics/waivers.js";
import { seededRng } from "../../src/domain/clock.js";
import { FX, fixtureParquet, fixtureRows } from "../sources/nflverse/helpers/fixtures.js";
import { docSection, writeDocSection } from "./helpers/replay.js";
import {
  BACKTEST_COLUMNS,
  BACKTEST_RULE,
  buildWaiverExcerpt,
  keepRow,
  loadBacktestSeason,
  type BacktestPosition,
  type BuiltExcerpt,
} from "./helpers/waiver-excerpt.js";
import {
  POLICIES,
  REPLAY,
  candidatesAt,
  demand,
  forecastSurplus,
  hindsightSurplus,
  hindsightTable,
  loadSeason,
  poolsFor,
  quantile,
  referenceSettings,
  replayWaivers,
  rosteredAt,
  rowPoints,
  seasonFromPoints,
  simulateSeason,
  trailingPpg,
  waiversSection,
  type Season,
} from "./helpers/waivers.js";

const settings = referenceSettings();
const REPL = { QB: 18, RB: 10, WR: 10, TE: 8 } as const;

/** The seasons the report replays, or null while the excerpt is not committed. */
function committedSeasons(): Season[] | null {
  const out: Season[] = [];
  for (const season of [2024, 2025]) {
    const s = loadSeason(season, settings);
    if (s === null) return null;
    out.push(s);
  }
  return out;
}

let built: BuiltExcerpt;
let tmp: string;
beforeAll(async () => {
  built = await buildWaiverExcerpt(fixtureParquet(FX.stats), 2026);
  tmp = mkdtempSync(join(tmpdir(), "eff-waiver-excerpt-"));
  if (process.env.UPDATE_EVALS === "1")
    writeDocSection("waivers", waiversSection(committedSeasons()));
}, 120_000);
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeBuilt(dir: string, b: BuiltExcerpt): void {
  for (const p of b.parts) writeFileSync(join(dir, p.name), p.text);
  writeFileSync(join(dir, b.entry.path), JSON.stringify(b.header));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ $comment: "test", retrieved: "2026-10-06", files: [b.entry] }),
  );
}

describe("the backtest excerpt keeps the reference scoring (built from the committed 2026 excerpt)", () => {
  it("keeps exactly the rule's rows and columns, in parts ≤ 240 KB whose hashes the manifest pins", () => {
    const full = fixtureRows(FX.stats);
    const kept = full.filter((r) => keepRow(r) && r.season === 2026);
    expect(kept.length).toBeGreaterThan(200);
    expect(built.entry.rows).toBe(kept.length);
    expect(built.header.schema.map((c) => c.name)).toEqual([...BACKTEST_COLUMNS]);
    expect(built.entry.columns).toEqual([...BACKTEST_COLUMNS]);
    expect(built.entry.excerpt).toBe(BACKTEST_RULE);
    expect(built.entry.url).toMatch(/\/stats_player\/stats_player_week_2026\.parquet$/);
    expect(built.entry.upstream.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(built.entry.parts.reduce((a, p) => a + p.rows, 0)).toBe(kept.length);
    for (const p of built.entry.parts) expect(p.bytes).toBeLessThanOrEqual(240 * 1024);
    // the rule: regular season, weeks 1..17, QB/RB/WR/TE, a player id
    expect(keepRow({ season_type: "POST", week: 1, position_group: "RB", player_id: "x" })).toBe(
      false,
    );
    expect(keepRow({ season_type: "REG", week: 18, position_group: "RB", player_id: "x" })).toBe(
      false,
    );
    expect(keepRow({ season_type: "REG", week: 0, position_group: "RB", player_id: "x" })).toBe(
      false,
    );
    expect(keepRow({ season_type: "REG", week: 3, position_group: "SPEC", player_id: "x" })).toBe(
      false,
    );
    expect(keepRow({ season_type: "REG", week: 3, position_group: "TE", player_id: null })).toBe(
      false,
    );
    expect(keepRow({ season_type: "REG", week: "3", position_group: "TE", player_id: "x" })).toBe(
      false,
    );
    expect(keepRow({ season_type: "REG", week: 17, position_group: "QB", player_id: "x" })).toBe(
      true,
    );
  });

  it("the excerpt's columns score every row exactly as the full row does, and match nflverse's own points", () => {
    writeBuilt(tmp, built);
    const rows = loadBacktestSeason(2026, tmp);
    expect(rows).not.toBeNull();
    const full = new Map(
      fixtureRows(FX.stats)
        .filter((r) => keepRow(r) && r.season === 2026)
        .map((r) => [`${String(r.player_id)}:${String(r.week)}`, r] as const),
    );
    let crossChecked = 0;
    for (const r of rows ?? []) {
      const whole = full.get(`${String(r.player_id)}:${String(r.week)}`);
      expect(whole).toBeDefined();
      const pts = rowPoints(r, settings);
      expect(pts).toBeCloseTo(rowPoints(whole ?? {}, settings), 9);
      // the reference league = half-PPR with 5-point passing TDs: nflverse's (standard + PPR) / 2
      // plus one point per passing TD (return TDs are split by type only when there are none)
      if (r.special_teams_tds === 0 || r.special_teams_tds === null) {
        const half = ((r.fantasy_points as number) + (r.fantasy_points_ppr as number)) / 2;
        expect(pts, `${String(r.player_id)} w${String(r.week)}`).toBeCloseTo(
          half + ((r.passing_tds as number | null) ?? 0),
          6,
        );
        crossChecked++;
      }
    }
    expect(crossChecked).toBeGreaterThan(200);
  });

  it("the loader re-hashes every part: a missing manifest or season is null, an edited part throws", () => {
    expect(loadBacktestSeason(2026, join(tmp, "absent"))).toBeNull();
    writeBuilt(tmp, built);
    expect(loadBacktestSeason(2025, tmp)).toBeNull();
    const first = built.parts[0];
    if (first === undefined) throw new Error("no part");
    writeFileSync(join(tmp, first.name), first.text.replace(/\t0\t/, "\t1\t"));
    expect(() => loadBacktestSeason(2026, tmp)).toThrow(/does not hash/);
  });
});

/** `[position, points of weeks 1..17 (null = not played)]` per player id. */
type Players = Record<string, readonly [BacktestPosition, readonly (number | null)[]]>;

/** A constructed season from per-player weekly points. */
function constructed(season: number, players: Players): Season {
  const entries = Object.entries(players).flatMap(([id, [pos, weeks]]) =>
    weeks.flatMap((p, i) => (p === null ? [] : [{ id, pos, week: i + 1, points: p }])),
  );
  return seasonFromPoints(season, entries, REPL);
}

const flat = (p: number | null, n = 17): (number | null)[] => Array.from({ length: n }, () => p);

describe("the replay's pieces on a constructed season", () => {
  // 40 RBs ranked by their week-1 points (RB01 best); RBX never played before week 6; RBY scores in
  // weeks 1–3 only; a QB, a WR and a TE below their rostered counts are available too
  const players: Players = {};
  for (let i = 1; i <= 40; i++)
    players[`RB${String(i).padStart(2, "0")}`] = ["RB", flat(30 - i * 0.5)];
  players.RBX = [
    "RB",
    [null, null, null, null, null, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25],
  ];
  players.RBY = [
    "RB",
    [
      40,
      40,
      40,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ],
  ];
  players.QB1 = ["QB", flat(20)];
  players.WR1 = ["WR", [5, 30, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5]];
  players.TE1 = ["TE", flat(9)];
  const s = constructed(2099, players);

  it("availability: the top `rostered[pos]` by prior points per game are rostered; never-played players are available", () => {
    const r2 = rosteredAt(s, 2);
    // week 1: RBY (40) and RB01..RB35 make the 36 rostered RBs; RB36..RB40 and RBX are available
    expect(r2.has("RBY")).toBe(true);
    expect(r2.has("RB35")).toBe(true);
    expect(r2.has("RB36")).toBe(false);
    expect(r2.has("RBX")).toBe(false);
    // every QB/WR/TE here is within its rostered count (14 / 38 / 14)
    expect(r2.has("QB1") && r2.has("WR1") && r2.has("TE1")).toBe(true);
    const ids = candidatesAt(s, 2).map((c) => c.id);
    expect(ids).toEqual(["RB36", "RB37", "RB38", "RB39", "RB40", "RBX"]);
    // ties break by id, so the ranking is total
    expect(REPLAY.rostered).toEqual({ QB: 14, RB: 36, WR: 38, TE: 14 });
  });

  it("hindsight surplus = Σ_{w=t}^{17} max(0, pts − replacement); unplayed weeks count 0", () => {
    expect(hindsightSurplus(s, "RBX", 2)).toBeCloseTo(12 * (25 - REPL.RB), 9);
    expect(hindsightSurplus(s, "RBX", 14)).toBeCloseTo(4 * (25 - REPL.RB), 9);
    expect(hindsightSurplus(s, "RBY", 2)).toBeCloseTo(2 * (40 - REPL.RB), 9);
    expect(hindsightSurplus(s, "RB40", 2)).toBe(0); // 10 points a week = replacement
    expect(hindsightSurplus(s, "nobody", 2)).toBe(0);
  });

  it("the forecast: trailing ≤ 4 games played, over replacement, held with the shipped P(role holds)", () => {
    expect(trailingPpg(s, "RBX", 6)).toBeNull();
    expect(trailingPpg(s, "RBY", 10)).toBe(40);
    expect(trailingPpg(s, "WR1", 3)).toBe(17.5);
    expect(trailingPpg(s, "WR1", 7)).toBe(5);
    expect(forecastSurplus(s, "RBX", 6)).toBe(0);
    let expected = 0;
    for (let j = 0; j <= 17 - 3; j++) expected += roleHolds("WR", null, j) * (17.5 - REPL.WR);
    expect(forecastSurplus(s, "WR1", 3)).toBeCloseTo(expected, 9);
    expect(forecastSurplus(s, "TE1", 5)).toBeCloseTo(
      Array.from({ length: 13 }, (_, j) => roleHolds("TE", null, j) * (9 - REPL.TE)).reduce(
        (a, b) => a + b,
        0,
      ),
      9,
    );
  });

  it("quantiles (type 7) and the demand curve (the DP's, capped)", () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 9);
    expect(quantile([7], 0.75)).toBe(7);
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
    expect(demand(0, 9)).toBeCloseTo(WAIVER_DP.q0, 9);
    expect(demand(10 * 4.5, 9)).toBeCloseTo(WAIVER_DP.q0 + WAIVER_DP.q1 * 4.5, 9);
    expect(demand(1e6, 9)).toBe(WAIVER_DP.qCap);
  });

  // a season with a real wire: 60 WRs at 9 ppg (rostered 38, the rest at replacement − 1) and
  // breakouts at weeks 4, 7 and 10 whose trailing rate then clears the premium
  const wire: Players = {};
  for (let i = 1; i <= 60; i++)
    wire[`W${String(i).padStart(2, "0")}`] = ["WR", flat(i <= 38 ? 15 : 9)];
  for (const [id, from] of [
    ["B4", 4],
    ["B7", 7],
    ["B10", 10],
  ] as const)
    wire[id] = ["WR", Array.from({ length: 17 }, (_, i) => (i + 1 < from ? 2 : 24))];
  wire.HOT = ["WR", Array.from({ length: 17 }, (_, i) => (i + 1 === 5 ? 35 : 3))];
  const sw = constructed(2098, wire);
  const table = solvePremiumTable({ teams: REPLAY.teams });
  const pools = poolsFor(sw);

  it("the rule claims only at or above the shipped premium Π(k, W), never a zero forecast", () => {
    let attempts = 0;
    for (let startK = 1; startK <= REPLAY.teams; startK++)
      for (let p = 0; p < 20; p++) {
        const r = simulateSeason("rule", startK, seededRng(p), table, pools);
        for (const e of r.events) {
          expect(e.f).toBeGreaterThan(0);
          expect(e.f).toBeGreaterThanOrEqual(e.premium);
          expect(e.premium).toBeCloseTo(table.premium(e.k, e.W), 12);
          expect(e.W).toBe(REPLAY.finalWeek - e.week);
          attempts++;
        }
        expect(r.claims).toBe(r.events.length);
        expect(r.successes).toBe(r.events.filter((e) => e.won).length);
      }
    expect(attempts).toBeGreaterThan(0);
  });

  it("order mechanics: k = 1 always wins; a win sends me to N; a week without one never moves me down", () => {
    for (const policy of POLICIES)
      for (let startK = 1; startK <= REPLAY.teams; startK++)
        for (let p = 0; p < 20; p++) {
          const r = simulateSeason(policy, startK, seededRng(1000 + p), table, pools);
          expect(r.positions[0]).toBe(startK);
          r.positions.forEach((k, i) => {
            expect(k).toBeGreaterThanOrEqual(1);
            expect(k).toBeLessThanOrEqual(REPLAY.teams);
            const next = r.positions[i + 1];
            if (next === undefined) return;
            const week = REPLAY.claimWeeks[i];
            const won = r.events.some((e) => e.week === week && e.won);
            if (won) expect(next).toBe(REPLAY.teams);
            else expect(next).toBeLessThanOrEqual(k);
          });
          for (const e of r.events) if (e.k === 1) expect(e.won).toBe(true);
          // one success per run at most; a player is never won twice
          const wins = r.events.filter((e) => e.won);
          expect(new Set(wins.map((e) => e.week)).size).toBe(wins.length);
          expect(new Set(wins.map((e) => e.id)).size).toBe(wins.length);
        }
  });

  it("the baselines: trending claims last week's top scorer, hindsight the top surplus; same seed, same season", () => {
    const tr = simulateSeason("trending", 1, seededRng(7), table, pools);
    // from k = 1 the first claim wins: week 2's top last-week scorer among the available
    // (an independent sort of the week's candidates, not the pool's own order)
    const w2 = candidatesAt(sw, 2).sort(
      (a, b) => b.last - a.last || b.f - a.f || a.id.localeCompare(b.id),
    );
    expect(tr.events[0]?.id).toBe(w2[0]?.id);
    const hi = simulateSeason("hindsight", 1, seededRng(7), table, pools);
    const best = candidatesAt(sw, 2).sort((a, b) => b.h - a.h || a.id.localeCompare(b.id));
    expect(hi.events[0]?.id).toBe(best[0]?.id);
    expect(hi.events[0]?.won).toBe(true);
    // the week-5 one-week wonder is what trending chases in week 6
    expect(pools.get(6)?.byLast[0]?.id).toBe("HOT");
    expect(pools.get(6)?.byLast[0]?.last).toBe(35);
    // each order is a permutation of the week's candidates, sorted by its key
    for (const [t, pool] of pools) {
      const ids = candidatesAt(sw, t)
        .map((c) => c.id)
        .sort();
      for (const order of [pool.byForecast, pool.byLast, pool.byHindsight])
        expect(order.map((c) => c.id).sort()).toEqual(ids);
      for (let i = 1; i < pool.byForecast.length; i++)
        expect(pool.byForecast[i - 1]?.f ?? 0).toBeGreaterThanOrEqual(pool.byForecast[i]?.f ?? 0);
    }
    for (const policy of POLICIES)
      expect(simulateSeason(policy, 5, seededRng(3), table, pools)).toEqual(
        simulateSeason(policy, 5, seededRng(3), table, pools),
      );
  });

  it("the replay aggregates three policies per season, deterministically", () => {
    const rows = replayWaivers([sw], 20);
    expect(rows.map((r) => r.policy)).toEqual([...POLICIES]);
    for (const r of rows) {
      expect(r.season).toBe(2098);
      expect(r.successes).toBeLessThanOrEqual(r.claims);
      expect(r.per_season).toBeCloseTo(r.per_claim * r.successes, 6);
    }
    const maxH = Math.max(...[...pools.values()].flatMap((p) => p.byHindsight.map((c) => c.h)));
    for (const r of rows) expect(r.per_claim).toBeLessThanOrEqual(maxH);
    expect(rows.find((r) => r.policy === "rule")?.successes ?? 0).toBeGreaterThan(0);
    expect(replayWaivers([sw], 20)).toEqual(rows);
    const ht = hindsightTable([sw]);
    expect(ht.weeks).toBe(REPLAY.claimWeeks.length);
    expect(ht.best[3]).toBeGreaterThanOrEqual(ht.best[0] ?? 0);
    expect(ht.best[1] ?? 0).toBeGreaterThanOrEqual(ht.second[1] ?? 0);
  });

  it("the report renders numbers for any committed seasons", () => {
    const text = waiversSection([sw]);
    expect(text).toContain("| 2098 | rule |");
    expect(text).toContain("| 2098 | trending |");
    expect(text).toContain("| 2098 | hindsight |");
    expect(text).toContain("research p25 / p50 / p75 / max");
    expect(text).toMatch(/Rule vs trending, surplus per successful claim .*2098: /);
    expect(waiversSection(null)).toMatch(/^\*\*Not run yet/);
  });
});

describe("A9a (soft, reported)", () => {
  it("docs/evals/1a-backtest.md's waivers section is this replay's (or says the excerpt is not committed)", () => {
    expect(docSection("waivers")).toBe(waiversSection(committedSeasons()));
  });
});
