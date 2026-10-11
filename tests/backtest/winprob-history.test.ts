// winprob-history.test.ts — plan 10 C3 (`P(win)` and `P(playoffs)` vs ESPN) on what the fixtures
// hold. ESPN's pre-week `winProbability` lives only in scoreboard snapshots taken before kickoff and
// its `playoffPct` only in in-season mTeam bodies; the recorded finished seasons carry neither (held
// here by scanning every history fixture), so both comparisons are `needs_time` — the code path is
// proven: our forecasts on every replayed week (the held-out start/sit replay's P(win) of the lineups
// as played) and on every finished league-season at weeks 4, 8 and 12 (the shipped seeding simulator's
// P(playoffs)), joined to ESPN's numbers through preWeekSnapshot → espnNumbersOf → attachEspn, and
// the recorded 2026 snapshots shown to be post-kickoff (excluded — never compared as pre-week).
// Hard: no comparison reports a pass without an ESPN number; our P(playoffs) beats the base-rate
// forecast at every checkpoint; drawing each cold-start team's mean from its posterior (the B2b
// fix) beats the same models with the mean taken as known, at every checkpoint. Reported
// (docs/evals/phase3-startsit.md, held equal): the tables, the inconsistent deciles, and how much
// team strength persisted in each recorded league-season (the shrinkage constant's evidence).
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  attachEspn,
  compareWithEspn,
  espnNumbersOf,
  preWeekSnapshot,
  reliabilityByDecile,
  type ComparatorRow,
  type EspnComparison,
} from "../../src/domain/analytics/calibration/index.js";
import type { ScoreboardSnapshot } from "../../src/domain/league/types.js";
import { normalizeLiveMatchups, normalizeStandings } from "../../src/providers/espn/normalize.js";
import { mMatchupScoreSchema, mTeamSchema } from "../../src/providers/espn/views/index.js";
import {
  playoffRows,
  playoffSeasons,
  seasonPersistence,
  PLAYOFF_CHECKPOINTS,
} from "../domain/analytics/calibration/helpers/playoffs-history.js";
import {
  replayHistory,
  type HistoryReplay,
} from "../domain/analytics/calibration/helpers/replay-history.js";
import {
  comparatorSection,
  docSection,
  writeDocSection,
} from "../domain/analytics/calibration/helpers/startsit-report.js";
import { ESPN_FIXTURES, historyManifest } from "../fixtures/helpers/history-fixtures.js";
import { recordedSchedule } from "../domain/league/helpers.js";
import { LEAGUES, MANIFEST, readRecorded } from "../golden/recorded.js";

let cv: HistoryReplay;
let playoffs: ComparatorRow[];
let knownMeans: ComparatorRow[];

/** Our weekly P(win) rows from the replay: the lineups as played, ESPN's number absent. */
const weeklyRows = (rp: HistoryReplay): ComparatorRow[] =>
  rp.rows.flatMap((r) =>
    r.h2h?.outcome_played == null
      ? []
      : [
          {
            group: "league-b",
            season: r.season,
            period: r.week,
            team_id: r.team_id,
            ours: r.h2h.p_win_played,
            espn: null,
            outcome: r.h2h.outcome_played,
          },
        ],
  );

/** The recorded 2026 week-4 scoreboard of each league as the store would hold it. */
function recordedSnapshots(): { league: string; snapshot: ScoreboardSnapshot }[] {
  return LEAGUES.map((league) => {
    const rel = `${league}/mMatchupScore.sp4.json`;
    const body = mMatchupScoreSchema.parse(readRecorded(rel));
    const standings = normalizeStandings(
      mTeamSchema.parse(readRecorded(`${league}/mTeam.json`)),
      null,
      null,
    );
    const entry = MANIFEST.files.find((f) => f.path === `recorded/${rel}`) as
      { recorded_at?: string } | undefined;
    const pct: Record<string, number | null> = {};
    for (const t of standings.teams) pct[String(t.team_id)] = t.playoff_pct_espn;
    return {
      league,
      snapshot: {
        week: 4,
        taken_at: entry?.recorded_at ?? "",
        matchups: normalizeLiveMatchups(body, 4, null, null),
        playoff_pct_espn: pct,
      },
    };
  });
}

const firstKickoffMs = (week: number): number | null => {
  const ks = recordedSchedule()
    .games.filter((g) => g.week === week && g.kickoff !== null)
    .map((g) => Date.parse(g.kickoff ?? ""));
  return ks.length === 0 ? null : Math.min(...ks);
};

const sections = (): Record<string, string> => {
  const weekly = compareWithEspn("win_probability", weeklyRows(cv));
  const season = compareWithEspn("playoff_pct", playoffs);
  const rows: { label: string; c: EspnComparison }[] = [
    {
      label: "P(win) vs `winProbability`, every replayed week (league-b 2024–2025, position_cv)",
      c: weekly,
    },
    { label: "P(playoffs) vs `playoffPct`, 9 finished league-seasons × weeks 4/8/12", c: season },
  ];
  const lines = [
    comparatorSection(rows),
    "",
    "Our P(playoffs) per checkpoint (the seeding simulator, cold-start weekly models with each team's mean drawn from its posterior per path):",
    "",
  ];
  lines.push(
    "| checkpoint week | team-seasons | our Brier | base-rate Brier | calibration status | deciles inconsistent with their forecasts (n, mean forecast → made) |",
    "|---:|---:|---:|---:|---|---|",
  );
  for (const k of PLAYOFF_CHECKPOINTS) {
    const xs = playoffs.filter((r) => r.period === k);
    const rate = xs.filter((r) => r.outcome).length / xs.length;
    const b = xs.reduce((s, r) => s + (r.ours - (r.outcome ? 1 : 0)) ** 2, 0) / xs.length;
    const base = xs.reduce((s, r) => s + (rate - (r.outcome ? 1 : 0)) ** 2, 0) / xs.length;
    const rel = reliabilityByDecile(xs.map((r) => ({ p: r.ours, outcome: r.outcome })));
    const off = rel.bins
      .filter((x) => x.consistent === false)
      .map(
        (x) =>
          `${x.lo.toFixed(1)}–${x.hi.toFixed(1)} (${String(x.n)}, ${(x.mean_p ?? 0).toFixed(3)} → ${(x.rate ?? 0).toFixed(3)})`,
      );
    lines.push(
      `| ${String(k)} | ${String(xs.length)} | ${b.toFixed(4)} | ${base.toFixed(4)} | \`${rel.status}\` | ${off.length === 0 ? "none" : off.join("; ")} |`,
    );
  }
  const snaps = recordedSnapshots();
  const wp = snaps.flatMap((s) => [...espnNumbersOf(s.snapshot).win_probability.values()]);
  const pct = snaps.flatMap((s) => [...espnNumbersOf(s.snapshot).playoff_pct.values()]);
  const pre = snaps.filter((s) => preWeekSnapshot([s.snapshot], 4, firstKickoffMs(4)) !== null);
  lines.push(
    "",
    `The recorded 2026 scoreboards (three leagues, matchup period 4): ${String(wp.length)} ESPN \`winProbability\` values, ${String(wp.filter((p) => p === 0 || p === 1).length)} of them exactly 0 or 1; ${String(pct.length)} \`playoffPct\` values. Taken after week 4's first kickoff: ${String(snaps.length - pre.length)} of ${String(snaps.length)} — not pre-week numbers, so the comparator reads none of them; week 4's results are not recorded either.`,
  );
  const persistence = [
    "| league | season | teams | regular-season weeks | weekly σ | between-team τ of true means | implied k = σ²/τ² (shipped: 4) | first-half vs second-half correlation |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...playoffSeasons().map((ps) => {
      const p = seasonPersistence(ps);
      return `| ${p.slot} | ${String(p.season)} | ${String(p.teams)} | ${String(p.games)} | ${p.sigma.toFixed(1)} | ${p.tau.toFixed(1)} | ${p.k === null ? "— (τ² ≤ 0)" : p.k.toFixed(1)} | ${p.half_corr.toFixed(2)} |`;
    }),
  ];
  return { comparator: lines.join("\n"), persistence: persistence.join("\n") };
};

beforeAll(async () => {
  cv = await replayHistory("position_cv");
  playoffs = [];
  knownMeans = [];
  for (const ps of playoffSeasons())
    for (const k of PLAYOFF_CHECKPOINTS) {
      playoffs.push(...(await playoffRows(ps, k)));
      knownMeans.push(...(await playoffRows(ps, k, { known_means: true })));
    }
  if (process.env.UPDATE_EVALS === "1")
    for (const [name, body] of Object.entries(sections())) writeDocSection(name, body);
}, 900_000);

describe("C3 P(win) and P(playoffs) against ESPN", () => {
  it("the finished seasons carry no winProbability, playoffPct or currentSimulationResults", () => {
    const files = historyManifest().files.map((f) => f.path);
    expect(files.length).toBeGreaterThan(50);
    for (const rel of files) {
      const text = readFileSync(path.join(ESPN_FIXTURES, rel), "utf8");
      expect(text.includes('"winProbability"'), rel).toBe(false);
      expect(text.includes('"playoffPct"'), rel).toBe(false);
      expect(text.includes('"currentSimulationResults"'), rel).toBe(false);
    }
  });

  it("(hard) P(win): no replayed week has a pre-week snapshot → needs_time over every week, never a pass", () => {
    // the finished seasons hold no scoreboard snapshot: the chain attaches nothing
    const snapshots: ScoreboardSnapshot[] = [];
    const rows = attachEspn(
      weeklyRows(cv),
      (r) => espnNumbersOf(preWeekSnapshot(snapshots, r.period, null)).win_probability,
    );
    expect(rows.every((r) => r.espn === null)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(250);
    const c = compareWithEspn("win_probability", rows);
    expect(c.status).toBe("needs_time");
    expect(c.periods).toEqual([]);
    expect(c.periods_without_espn).toBe(
      new Set(rows.map((r) => `${String(r.season)}:${String(r.period)}`)).size,
    );
    expect(c.brier_ours_all).not.toBeNull();
    expect(c.brier_ours_all ?? 1).toBeLessThan(0.25);
  });

  it("(hard) P(playoffs): every finished league-season at weeks 4, 8 and 12 → needs_time; ours beats the base rate", () => {
    expect(playoffSeasons().length).toBe(9);
    const c = compareWithEspn("playoff_pct", playoffs);
    expect(c.status).toBe("needs_time");
    expect(c.periods_without_espn).toBe(9 * PLAYOFF_CHECKPOINTS.length);
    for (const k of PLAYOFF_CHECKPOINTS) {
      const xs = playoffs.filter((r) => r.period === k);
      const rate = xs.filter((r) => r.outcome).length / xs.length;
      const b = xs.reduce((s, r) => s + (r.ours - (r.outcome ? 1 : 0)) ** 2, 0) / xs.length;
      const base = xs.reduce((s, r) => s + (rate - (r.outcome ? 1 : 0)) ** 2, 0) / xs.length;
      expect(b).toBeLessThan(base);
    }
    // the field sizes: every team-season once per checkpoint, the playoff field's share of outcomes
    for (const ps of playoffSeasons())
      expect(
        playoffs.filter((r) => r.group === ps.slot && r.season === ps.season && r.outcome).length,
      ).toBe(PLAYOFF_CHECKPOINTS.length * ps.team_count);
  });

  it("(hard) drawing each cold-start team's mean from its posterior beats taking it as known, at every checkpoint (Brier; the B2b fix)", () => {
    const brier = (rows: readonly ComparatorRow[]): number =>
      rows.reduce((s, r) => s + (r.ours - (r.outcome ? 1 : 0)) ** 2, 0) / rows.length;
    for (const k of PLAYOFF_CHECKPOINTS) {
      const drawn = playoffs.filter((r) => r.period === k);
      const known = knownMeans.filter((r) => r.period === k);
      expect(drawn.length).toBe(known.length);
      expect(brier(drawn)).toBeLessThan(brier(known));
    }
    // the known-mean run is more extreme: further from ½ on average where the order is uncertain
    const spread = (rows: readonly ComparatorRow[]): number =>
      rows.reduce((s, r) => s + Math.abs(r.ours - 0.5), 0) / rows.length;
    expect(spread(playoffs.filter((r) => r.period === 4))).toBeLessThan(
      spread(knownMeans.filter((r) => r.period === 4)),
    );
  });

  it("(hard) the snapshot path on the recorded 2026 scoreboards: ESPN's numbers read, a post-kickoff snapshot never used as pre-week", () => {
    const k4 = firstKickoffMs(4);
    expect(k4).not.toBeNull();
    for (const { snapshot } of recordedSnapshots()) {
      const nums = espnNumbersOf(snapshot);
      expect(nums.skipped).toBe(0);
      expect(nums.win_probability.size).toBeGreaterThanOrEqual(8);
      expect(nums.playoff_pct.size).toBeGreaterThanOrEqual(8);
      // recorded after week 4 kicked off → not a pre-week number; with no kickoff known it would be
      expect(Date.parse(snapshot.taken_at)).toBeGreaterThan(k4 ?? 0);
      expect(preWeekSnapshot([snapshot], 4, k4)).toBeNull();
      expect(preWeekSnapshot([snapshot], 4, null)).toBe(snapshot);
    }
    expect(compareWithEspn("win_probability", []).status).toBe("needs_time");
  });

  it("(soft, reported) the comparator section of docs/evals/phase3-startsit.md is this replay's", () => {
    for (const [name, body] of Object.entries(sections()))
      expect(docSection(name), `section ${name}: rerun with UPDATE_EVALS=1 and review`).toBe(body);
  });
});
