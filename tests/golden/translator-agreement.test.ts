// translator-agreement.test.ts — ESPN vs nflverse on the fixture roster (plan 08 E8, §3.2 cross-check,
// P15): every fixture player-week both sources report is translated twice (statLineFromEspn on the
// recorded box score, statLineFromPlayerWeek / statLineFromTeamDefense on the committed nflverse
// excerpt) and scored under each recorded league's settings. Scores agree within 0.01 on the stats
// whose raw values agree; every raw difference is listed by name, and none exceeds one yard or one
// event (the record of ESPN-vs-nflverse conventions — fumble attribution is the expected offender).
// Plan 10 A2a: the list of raw differences > 1 yard / > 1 event and the conventions are written to
// docs/evals/1a-translator-agreement.md, which this test keeps equal to the run (UPDATE_EVALS=1).
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  canonicalDef,
  normalizeSettings,
  type PointsAllowedInput,
  type ScoreResult,
  score,
  type ScoringSettings,
  type StatLine,
  statLineFromEspn,
  statLineFromPlayerWeek,
  statLineFromTeamDefense,
} from "../../src/domain/scoring/index.js";
import {
  finalWeeks,
  LEAGUES,
  recordedScoringSettings,
  recordedTeamWeeks,
  ROOT,
} from "./recorded.js";
import { evalsSection, writeEvalsSection } from "./evals-doc.js";

interface Excerpt {
  readonly sources: readonly { url: string; sha256: string }[];
  readonly player_rows: readonly Record<string, unknown>[];
  readonly team_defense_rows: readonly {
    espn_id: number;
    row: Record<string, unknown>;
    points_allowed: PointsAllowedInput;
  }[];
}
interface RosterEntry {
  readonly espn_id: number;
  readonly gsis_id?: string;
  readonly espn_position_id: number;
  readonly position?: string;
}

const excerpt = JSON.parse(
  readFileSync(path.join(ROOT, "fixtures/golden/nflverse-crosscheck.json"), "utf8"),
) as Excerpt;
const roster = JSON.parse(
  readFileSync(path.join(ROOT, "fixtures/players/fixture-roster.json"), "utf8"),
) as { players: RosterEntry[]; team_units: RosterEntry[] };

const settings: ScoringSettings[] = LEAGUES.map((l) =>
  normalizeSettings(recordedScoringSettings(l)),
);

/** ESPN's raw stats per (player, week) — league-independent, so any league's box score will do. */
const espnRaw = new Map<string, { position: number; stats: Readonly<Record<string, number>> }>();
for (const league of LEAGUES) {
  for (const week of finalWeeks(league)) {
    for (const team of recordedTeamWeeks(league, week)) {
      for (const p of team.players) {
        if (p.actual === undefined) continue;
        const key = `${String(p.player_id)}:${String(week)}`;
        const prior = espnRaw.get(key);
        if (prior !== undefined) expect(prior.stats).toEqual(p.actual.stats);
        espnRaw.set(key, { position: p.position, stats: p.actual.stats });
      }
    }
  }
}

interface Pair {
  readonly label: string;
  readonly week: number;
  /** QB/RB/WR/TE/K from the fixture roster, D/ST for a team unit (the report's column). */
  readonly position: string;
  readonly espn: StatLine;
  readonly nflverse: StatLine;
}

const byGsis = new Map(roster.players.map((p) => [p.gsis_id, p]));
const pairs: Pair[] = [];
for (const row of excerpt.player_rows) {
  const p = byGsis.get(row.player_id as string);
  if (p === undefined) continue;
  const e = espnRaw.get(`${String(p.espn_id)}:${String(row.week)}`);
  if (e === undefined) continue;
  pairs.push({
    label: `${String(p.espn_id)} w${String(row.week)}`,
    week: Number(row.week),
    position: p.position ?? "?",
    espn: statLineFromEspn({ raw: e.stats }, e.position).line,
    nflverse: statLineFromPlayerWeek(row, { position: p.espn_position_id }),
  });
}
for (const d of excerpt.team_defense_rows) {
  const e = espnRaw.get(`${String(d.espn_id)}:${String(d.row.week)}`);
  if (e === undefined) continue;
  pairs.push({
    label: `${String(d.espn_id)} w${String(d.row.week)}`,
    week: Number(d.row.week),
    position: "D/ST",
    espn: statLineFromEspn({ raw: e.stats }, e.position).line,
    nflverse: statLineFromTeamDefense(d.row, { pointsAllowed: d.points_allowed }),
  });
}

/** Raw values the nflverse line reports that ESPN reports differently (ESPN omits zeros). */
function rawDiffs(pair: Pair): { canonical: string; espn: number; nflverse: number }[] {
  return Object.entries(pair.nflverse.values)
    .map(([canonical, nflverse]) => ({
      canonical,
      espn: pair.espn.values[canonical] ?? 0,
      nflverse,
    }))
    .filter((d) => d.espn !== d.nflverse);
}

/** Per-canonical points, skipping what the nflverse side cannot derive or reports differently. */
function sharedPoints(r: ScoreResult, skip: ReadonlySet<string>): Map<string, number> {
  return new Map(
    r.contributions
      .filter(
        (c) => !skip.has(c.canonical) && !skip.has(canonicalDef(c.canonical)?.family?.scalar ?? ""),
      )
      .map((c) => [c.canonical, c.points]),
  );
}

/** One pair scored under one league's settings: the largest per-stat and total gaps on shared stats. */
function compare(pair: Pair, s: ScoringSettings): { stat: number; total: number; worst: string } {
  const e = score(pair.espn, s);
  const n = score(pair.nflverse, s);
  const skip = new Set([...n.underivable, ...rawDiffs(pair).map((d) => d.canonical)]);
  const ep = sharedPoints(e, skip);
  const np = sharedPoints(n, skip);
  let stat = 0;
  let worst = "";
  for (const c of new Set([...ep.keys(), ...np.keys()])) {
    const gap = Math.abs((ep.get(c) ?? 0) - (np.get(c) ?? 0));
    if (gap > stat) [stat, worst] = [gap, c];
  }
  const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  return { stat, total: Math.abs(sum(ep) - sum(np)), worst };
}

/** Every raw difference on the paired player-weeks, with the week and position class. */
const allDiffs = pairs.flatMap((p) =>
  rawDiffs(p).map((d) => ({ ...d, label: p.label, week: p.week, pos: p.position })),
);

const EVALS_PAGE = "1a-translator-agreement.md";
const fmt = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(4));

/** The generated section of docs/evals/1a-translator-agreement.md (plan 10 A2a). */
function agreementSection(): string {
  const byPos = (c: string) => pairs.filter((p) => p.position === c).length;
  const lines = [
    "| quantity | value |",
    "|---|---:|",
    `| player-weeks both sources report (paired) | ${String(pairs.length)} |`,
    `| of which QB / RB / WR / TE / K / D/ST | ${["QB", "RB", "WR", "TE", "K", "D/ST"].map(byPos).join(" / ")} |`,
    `| weeks | ${[...new Set(pairs.map((p) => p.week))].sort((a, b) => a - b).join(", ")} |`,
  ];
  LEAGUES.forEach((l, i) => {
    const s = settings[i];
    if (s === undefined) return;
    const r = pairs.map((p) => compare(p, s));
    const stat = Math.max(0, ...r.map((x) => x.stat));
    const total = Math.max(0, ...r.map((x) => x.total));
    lines.push(
      `| ${l}: largest per-stat / per-total points gap on the shared stats (bounds 0.005 / 0.01) | ${fmt(stat)} / ${fmt(total)} |`,
    );
  });
  lines.push("", "**Raw differences greater than one yard or one event:**", "");
  const big = allDiffs.filter((d) => Math.abs(d.espn - d.nflverse) > 1);
  if (big.length === 0)
    lines.push("None — no raw value differs by more than 1 on any paired player-week.");
  else {
    lines.push("| week | position | stat | ESPN | nflverse |", "|---:|---|---|---:|---:|");
    for (const d of big)
      lines.push(
        `| ${String(d.week)} | ${d.pos} | \`${d.canonical}\` | ${fmt(d.espn)} | ${fmt(d.nflverse)} |`,
      );
  }
  lines.push(
    "",
    "**Every raw difference (the conventions, each at most 1):**",
    "",
    "| week | position | stat | ESPN | nflverse |",
    "|---:|---|---|---:|---:|",
  );
  const sorted = [...allDiffs].sort(
    (a, b) =>
      a.canonical.localeCompare(b.canonical) ||
      a.week - b.week ||
      a.pos.localeCompare(b.pos) ||
      a.espn - b.espn,
  );
  for (const d of sorted)
    lines.push(
      `| ${String(d.week)} | ${d.pos} | \`${d.canonical}\` | ${fmt(d.espn)} | ${fmt(d.nflverse)} |`,
    );
  return lines.join("\n");
}

beforeAll(() => {
  if (process.env.UPDATE_EVALS === "1")
    writeEvalsSection(EVALS_PAGE, "agreement", agreementSection());
});

describe("ESPN vs nflverse on the fixture roster (plan 08 E8, P15)", () => {
  it("pairs every fixture player-week both sources report, D/ST included", () => {
    expect(pairs.length).toBeGreaterThanOrEqual(60);
    // 4 fixture D/ST units × 3 weeks, less the one week a unit sits in no recorded box score
    expect(pairs.filter((p) => p.espn.position_class === "DST")).toHaveLength(11);
    expect(pairs.filter((p) => p.espn.position_class === "K").length).toBeGreaterThanOrEqual(9);
    expect(excerpt.sources.every((s) => /^[0-9a-f]{64}$/.test(s.sha256))).toBe(true);
  });

  it("no raw difference exceeds one yard or one event; the conventions list is exactly this", () => {
    const diffs = allDiffs;
    for (const d of diffs)
      expect(Math.abs(d.espn - d.nflverse), `${d.label} ${d.canonical}`).toBeLessThanOrEqual(1);
    // ESPN-vs-nflverse conventions observed on the excerpt (stat → number of player-weeks)
    const byStat: Record<string, number> = {};
    for (const d of diffs) byStat[d.canonical] = (byStat[d.canonical] ?? 0) + 1;
    expect(byStat).toEqual(EXPECTED_CONVENTIONS);
  });

  it.each(LEAGUES.map((l, i) => [l, i] as const))(
    "%s: scores agree within 0.01 on the shared stats",
    (_l, i) => {
      const s = settings[i]!;
      for (const pair of pairs) {
        const r = compare(pair, s);
        expect(r.stat, `${pair.label} ${r.worst}`).toBeLessThanOrEqual(0.005);
        expect(r.total, pair.label).toBeLessThanOrEqual(0.01);
      }
    },
  );

  it("(A2a, reported) docs/evals/1a-translator-agreement.md is this run's list", () => {
    expect(evalsSection(EVALS_PAGE, "agreement")).toBe(agreementSection());
  });

  it("D/ST points and yards allowed agree with ESPN's raw 120/127 (U-6 settled on the excerpt)", () => {
    for (const pair of pairs.filter((p) => p.espn.position_class === "DST")) {
      expect(pair.nflverse.values.dst_pa_raw, pair.label).toBe(pair.espn.values.dst_pa_raw ?? 0);
      expect(pair.nflverse.values.dst_ya_raw, pair.label).toBe(pair.espn.values.dst_ya_raw ?? 0);
    }
  });
});

/**
 * The conventions observed on the excerpt (stat → player-weeks). A regenerated excerpt that changes
 * it is reviewed, never widened blindly. `two_pt_total` (ESPN 62): ESPN leaves 62 off some lines
 * whose 19/26/44 record a conversion (8 recorded lines league-wide); nflverse's union is complete.
 */
const EXPECTED_CONVENTIONS: Record<string, number> = { two_pt_total: 2 };
