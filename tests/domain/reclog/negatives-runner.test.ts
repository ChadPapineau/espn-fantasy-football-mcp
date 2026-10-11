// negatives-runner.test.ts — Stage C (docs/evals/phase3-summary.md "Open"; plan 06 §1.5 "Pre-season
// negatives re-check"): the C10 re-check gains a runner over the store's read ports
// (src/domain/reclog/negatives-runner.ts). Held here: (1) over ports serving exactly the committed
// history (the nflverse 2024–2025 player-weeks as PlayerWeekLines through the shipped translator,
// the committed schedule, the nine finished probe-league seasons read through the provider), the
// runner's report EQUALS the committed run's (`negativesInput` → docs/evals/phase3-negatives.md) —
// so the store-backed job reproduces the doc; (2) what it read is counted and a season the store
// lacks is listed, never silent; (3) the universe and league-season adapters. Pure ports; no file
// of the store is opened and nothing is fetched.
import { describe, expect, it } from "vitest";
import type {
  DatasetResult,
  DepthChartRow,
  NflGame,
  PlayerWeekLine,
} from "../../../src/domain/analytics/types.js";
import type { NflPlayerRecord } from "../../../src/domain/crosswalk/types.js";
import type { NflTeam } from "../../../src/config/schema.js";
import { negativesReport } from "../../../src/domain/reclog/negatives.js";
import {
  leagueSeasonFrom,
  NEG_RUN_ID_CHUNK,
  negPositionOf,
  negativesInputFromStore,
  runNegativesFromStore,
  universeFromDepthCharts,
  withRulePoints,
  type NegativesStorePorts,
} from "../../../src/domain/reclog/negatives-runner.js";
import { statLineFromPlayerWeek } from "../../../src/domain/scoring/index.js";
import { REPLACEMENT_DATA_DIR } from "../../backtest/helpers/replacement-data.js";
import { loadBacktestSeason } from "../../backtest/helpers/waiver-excerpt.js";
import { referenceSettings } from "../../backtest/helpers/waivers.js";
import { historyFixtureFetch, servedSeasons } from "../../fixtures/helpers/history-fixtures.js";
import { makeWorld, type LeagueSlot } from "../../providers/espn/helpers.js";
import { FX, fixtureRows } from "../../sources/nflverse/helpers/fixtures.js";
import { NEG_SEASONS, negLeagueSeasons, negativesInput, referencePlan } from "./negatives-data.js";

const STAMP = Object.freeze({
  source: "nflverse:stats_player_week_history",
  file_version: "v-test",
  as_of: "2026-08-15T00:00:00.000Z",
}) as unknown as NonNullable<DatasetResult<PlayerWeekLine>["stamp"]>;

/** The committed player-weeks of a season as the store's reader returns them. */
function linesOf(season: number): PlayerWeekLine[] {
  const rows = loadBacktestSeason(season, REPLACEMENT_DATA_DIR) ?? [];
  return rows.map((r) => ({
    gsis_id: String(r.player_id),
    season,
    week: Number(r.week),
    nfl_team: String(r.team) as NflTeam,
    opponent: null,
    position: String(r.position),
    line: statLineFromPlayerWeek(r),
    usage: null,
  }));
}

/** Ports over the committed history, recording every `lines` call. */
function committedPorts(): { ports: NegativesStorePorts; calls: number[] } {
  const bySeason = new Map<number, PlayerWeekLine[]>(NEG_SEASONS.map((s) => [s, linesOf(s)]));
  const games = fixtureRows(FX.games).filter((g) => g.game_type === "REG");
  const calls: number[] = [];
  const ports: NegativesStorePorts = {
    universe: (season) => {
      const rows = bySeason.get(season);
      return rows === undefined ? null : [...new Set(rows.map((l) => l.gsis_id))];
    },
    playerWeeks: {
      lines: (ids, season, weeks) => {
        calls.push(ids.length);
        const want = new Set(ids);
        const ws = new Set(weeks);
        const rows = (bySeason.get(season) ?? []).filter(
          (l) => want.has(l.gsis_id) && ws.has(l.week),
        );
        return { rows, stamp: rows.length === 0 ? null : STAMP };
      },
    },
    nflGames: {
      games: (season, weeks) => ({
        rows: games
          .filter((g) => Number(g.season) === season && weeks.includes(Number(g.week)))
          .map(
            (g) =>
              ({
                season: Number(g.season),
                week: Number(g.week),
                home: String(g.home_team),
                away: String(g.away_team),
              }) as unknown as NflGame,
          ),
        stamp: null,
      }),
    },
  };
  return { ports, calls };
}

const runOpts = () => ({
  seasons: [...NEG_SEASONS],
  settings: referenceSettings(),
  plan: referencePlan(),
  league_size: 10,
  league_seasons: negLeagueSeasons(),
});

describe("the store-backed C10 runner", () => {
  it("over ports serving the committed history it reproduces the committed run exactly", () => {
    const { ports } = committedPorts();
    const run = runNegativesFromStore(ports, runOpts());
    expect(run.report).toEqual(negativesReport(negativesInput()));
    expect(run.coverage.missing_seasons).toEqual([]);
    expect(run.coverage.league_seasons).toBe(9);
    for (const c of run.coverage.seasons) {
      const committed = loadBacktestSeason(c.season, REPLACEMENT_DATA_DIR)?.length ?? 0;
      expect(c.player_weeks, String(c.season)).toBe(committed);
      expect(c.skipped_position + c.skipped_unscorable).toBe(0);
      expect(c.file_version).toBe("v-test");
    }
    // the 2025 schedule is committed, the 2024 one is not: both counted as read
    expect(run.coverage.seasons.map((c) => c.schedule_sides > 0)).toEqual([false, true]);
  });

  it("reads the universe in bounded id chunks and keeps a repeated row once", () => {
    const { ports, calls } = committedPorts();
    // the universe padded past one chunk (ids the store holds no row for), every row served twice
    const pad = Array.from(
      { length: NEG_RUN_ID_CHUNK + 500 },
      (_, i) => `00-9${String(i).padStart(6, "0")}`,
    );
    const doubled: NegativesStorePorts = {
      ...ports,
      universe: (season) => [...(ports.universe(season) ?? []), ...pad],
      playerWeeks: {
        lines: (ids, season, weeks, o) => {
          const r = ports.playerWeeks.lines(ids, season, weeks, o);
          return { rows: [...r.rows, ...r.rows], stamp: r.stamp };
        },
      },
    };
    const { input, coverage } = negativesInputFromStore(doubled, runOpts());
    expect(calls.every((n) => n <= NEG_RUN_ID_CHUNK)).toBe(true);
    expect(calls.length).toBe(NEG_SEASONS.length * 2);
    expect(input.rows.length).toBe(negativesInput().rows.length);
    expect(coverage.seasons.reduce((a, c) => a + c.player_weeks, 0)).toBe(input.rows.length);
  });

  it("lists a season the store does not hold and leaves it out of the checks", () => {
    const { ports } = committedPorts();
    const { input, coverage } = negativesInputFromStore(ports, {
      ...runOpts(),
      seasons: [2023, ...NEG_SEASONS],
    });
    expect(coverage.missing_seasons).toEqual([2023]);
    expect(input.seasons).toEqual([...NEG_SEASONS]);
    expect(coverage.seasons[0]).toMatchObject({ season: 2023, universe: 0, player_weeks: 0 });
  });

  it("counts what it skips: positions it does not model and lines the engine refuses", () => {
    const base = linesOf(2025).slice(0, 3);
    const k = { ...base[0]!, gsis_id: "00-0000001", position: "K" };
    const bad = {
      ...base[1]!,
      gsis_id: "00-0000002",
      line: { ...base[1]!.line, position_class: "NOPE" },
    } as unknown as PlayerWeekLine;
    const rows = [base[2]!, k, bad];
    const ports: NegativesStorePorts = {
      universe: () => rows.map((r) => r.gsis_id),
      playerWeeks: { lines: () => ({ rows, stamp: null }) },
      nflGames: { games: () => ({ rows: [], stamp: null }) },
    };
    const { coverage } = negativesInputFromStore(ports, { ...runOpts(), seasons: [2025] });
    expect(coverage.seasons[0]).toMatchObject({
      player_weeks: 1,
      skipped_position: 1,
      skipped_unscorable: 1,
      file_version: null,
    });
  });

  it("nflverse positions map as E1 reads them (FB plays RB); others are not modelled", () => {
    expect(["QB", "RB", "FB", "WR", "TE", "K", "OL", ""].map(negPositionOf)).toEqual([
      "QB",
      "RB",
      "RB",
      "WR",
      "TE",
      null,
      null,
      null,
    ]);
  });

  it("a scoring variant changes one rule's points and clears its position overrides", () => {
    const s = referenceSettings();
    const v = withRulePoints(s, "pass_td", 4);
    const td = v.rules.find((r) => r.canonical === "pass_td");
    expect(td?.points).toBe(4);
    expect(td?.overrides).toEqual({});
    expect(v.rules.filter((r) => r.canonical !== "pass_td")).toEqual(
      s.rules.filter((r) => r.canonical !== "pass_td"),
    );
    expect(s.rules.find((r) => r.canonical === "pass_td")?.points).not.toBe(4);
  });
});

describe("leagueSeasonFrom — a finished league-season from the platform's reads", () => {
  it("over the nine recorded seasons read through the provider it equals the committed input", async () => {
    const out = [];
    for (const slot of ["league-a", "league-b", "league-c"] as LeagueSlot[])
      for (const [season] of servedSeasons(slot)) {
        const w = makeWorld({ fetch: historyFixtureFetch(slot) });
        const ref = { ...w.ref, season };
        out.push(
          leagueSeasonFrom(
            (await w.provider.getStandings(ref)).value,
            (await w.provider.getLeagueRules(ref)).value,
          ),
        );
      }
    expect(out).toEqual(negLeagueSeasons());
  }, 60_000);

  it("is null without a playoff size, a seed or the waiver mode", () => {
    const team = { wins: 1, losses: 0, ties: 0, points_for: 100, playoff_seed: 1 };
    const rules = {
      playoffs: { team_count: 4 },
      waiver: { order_reset: false, uses_budget: false },
    } as unknown as Parameters<typeof leagueSeasonFrom>[1];
    const st = { teams: [team] } as unknown as Parameters<typeof leagueSeasonFrom>[0];
    expect(leagueSeasonFrom(st, rules)).toMatchObject({ playoff_team_count: 4, uses_faab: false });
    expect(
      leagueSeasonFrom({ teams: [{ ...team, playoff_seed: null }] } as unknown as typeof st, rules),
    ).toBeNull();
    for (const over of [
      { playoffs: { team_count: null } },
      { waiver: { order_reset: null, uses_budget: false } },
      { waiver: { order_reset: false, uses_budget: null } },
    ])
      expect(leagueSeasonFrom(st, { ...rules, ...over } as typeof rules)).toBeNull();
  });
});

describe("universeFromDepthCharts — the store-backed universe", () => {
  const row = (over: Partial<DepthChartRow>): DepthChartRow =>
    ({
      season: 2025,
      week: 1,
      nfl_team: "KC",
      pos_grp: "Offense",
      pos_abb: "WR",
      rank: 1,
      gsis_id: null,
      espn_id: null,
      name: "x",
      ...over,
    }) as DepthChartRow;

  it("takes every modelled depth-chart player, crossing an ESPN-only row to its GSIS id", () => {
    const rows = [
      row({ gsis_id: "00-0000003" }),
      row({ gsis_id: "00-0000001", pos_abb: "QB" }),
      row({ espn_id: 4242, pos_abb: "TE" }),
      row({ espn_id: 777, pos_abb: "HB" }),
      row({ gsis_id: "00-0000009", pos_abb: "LT" }),
      row({ gsis_id: "00-0000008", season: 2024 }),
      row({ gsis_id: "00-0000003", week: 2 }),
    ];
    const asked: number[][] = [];
    const u = universeFromDepthCharts(
      { chart: () => ({ rows, stamp: STAMP }) },
      {
        byEspnIds: (ids) => {
          asked.push([...ids]);
          return {
            rows: [{ gsis_id: "00-0000004", espn_id: 4242 } as NflPlayerRecord],
            stamp: null,
          };
        },
      },
      ["KC"],
      2025,
    );
    expect(u).toEqual(["00-0000001", "00-0000003", "00-0000004"]);
    expect(asked).toEqual([[4242, 777]]);
  });

  it("is null when the store holds no depth chart for the season", () => {
    expect(
      universeFromDepthCharts(
        { chart: () => ({ rows: [], stamp: null }) },
        { byEspnIds: () => ({ rows: [], stamp: null }) },
        ["KC"],
        2023,
      ),
    ).toBeNull();
  });
});
