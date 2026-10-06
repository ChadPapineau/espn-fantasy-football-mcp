// phase2-grounding.test.ts — the Phase-2 contract on REAL rows (plan 10 §3.2, B1–B2; plan 01 §5.5;
// plan 08 §3.2/§4.3): the fixture-roster excerpts of the 2026-10-06 release files
// (fixtures/players/phase2/, CC-BY 4.0 / ffopportunity CC-BY-SA 4.0) carry exactly the contract's
// upstream columns and come from the observed files; loaded through the reference loader they fill the
// contract tables, and the reader SQL reproduces nflverse's own stats_player_week excerpt
// (fixtures/nflverse/stats_player) for every fixture player-week — targets, receptions, carries,
// passing/receiving/rushing TDs, FG attempts and makes — which pins the pbp counting definitions;
// snap counts join through the roster's pfr ids, expected points drop the unattributed rows, the
// depth snapshots compress into runs that rebuild every snapshot, and the ≤ 2024 layout drops,
// collapses and falls back exactly as the contract says.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { depthChartRuns } from "../../../src/store/datasets/derive.js";
import {
  DS_DEPTH_CHARTS_LEGACY,
  DS_EP_WEEKLY,
  DS_PBP,
  DS_SNAP_COUNTS,
  DS_STATS_TEAM_WEEK,
  PHASE_2_READER_QUERIES,
  ddlFor,
  phase2RequiredUpstreamColumns,
  quoteIdentifier,
  type ContractSourceId,
  type Phase2ReaderMethod,
  type Phase2TableContract,
} from "../../../src/store/datasets/tables.js";
import type { DatasetRow } from "../../../src/store/types.js";
import { OBSERVED_PHASE2 } from "./observed-phase2.js";
import {
  depthRows,
  depthSnapshot,
  epWeeklyRow,
  legacyDepthRow,
  pbpRow,
  snapRow,
  statsTeamWeekRow,
} from "./phase2-loaders.js";

const FIX = new URL("../../../fixtures/players/", import.meta.url);

interface Header {
  readonly source: ContractSourceId;
  readonly upstream: {
    url: string;
    updated_at: string;
    bytes: number;
    rows: number;
    sha256: string;
  };
  readonly rows: number;
  readonly columns: readonly string[];
}
type Raw = Record<string, unknown>;

/** A header line of column names, then one JSON literal per cell (the fixtures' TSV convention). */
function tsv(url: URL): Raw[] {
  const lines = readFileSync(url, "utf8")
    .split("\n")
    .filter((l) => l !== "");
  const cols = (lines[0] ?? "").split("\t");
  return lines.slice(1).map((l) => {
    const cells = l.split("\t");
    expect(cells).toHaveLength(cols.length);
    return Object.fromEntries(cols.map((c, i) => [c, JSON.parse(cells[i] ?? "null") as unknown]));
  });
}

function excerpt(name: string): { header: Header; rows: Raw[] } {
  const header = JSON.parse(
    readFileSync(new URL(`phase2/${name}.excerpt.json`, FIX), "utf8"),
  ) as Header;
  const rows = tsv(new URL(`phase2/${name}.excerpt.tsv`, FIX));
  return { header, rows };
}

interface RosterPlayer {
  readonly espn_id: number;
  readonly gsis_id: string;
  readonly pfr_id: string;
  readonly team: string;
  readonly position: string;
  readonly stat_weeks: readonly number[];
}
const ROSTER = (
  JSON.parse(readFileSync(new URL("fixture-roster.json", FIX), "utf8")) as {
    players: RosterPlayer[];
  }
).players;
const GSIS = ROSTER.map((p) => p.gsis_id);

/** nflverse's own weekly stat lines of the fixture roster (the B1 excerpt, every fixture player row). */
const STATS: Raw[] = [1, 2, 3].flatMap((i) =>
  tsv(new URL(`../nflverse/stats_player/stats_player_week_2026.excerpt.${String(i)}.tsv`, FIX)),
);

function load(spec: Phase2TableContract, rows: readonly (DatasetRow | null)[]): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const sql of ddlFor(spec)) db.exec(sql);
  const kept = rows.filter((r): r is DatasetRow => r !== null);
  for (const r of kept) {
    const cols = Object.keys(r);
    db.prepare(
      `INSERT INTO ${quoteIdentifier(spec.name)} (${cols.map(quoteIdentifier).join(",")}) VALUES (${cols.map((c) => `:${c}`).join(",")})`,
    ).run(r);
  }
  return db;
}

const sqlOf = (m: Phase2ReaderMethod, i = 0): string =>
  PHASE_2_READER_QUERIES[m].statements[i]?.sql ?? "";

describe("the excerpts are faithful to the observed files and to the contract", () => {
  it.each([
    ["pbp_2026", "nflverse:pbp@2026", 2026],
    ["snap_counts_2026", "nflverse:snap_counts@2026", 2026],
    ["ep_weekly_2026", "ffopportunity:ep_weekly@2026", 2026],
    ["depth_charts_2026", "nflverse:depth_charts@2026", 2026],
    ["stats_team_week_2026", "nflverse:stats_team_week@2026", 2026],
    ["depth_charts_2024", "nflverse:depth_charts@2024", 2024],
  ] as const)("%s: contract columns only, from the observed file", (name, key, season) => {
    const { header, rows } = excerpt(name);
    const o = OBSERVED_PHASE2[key];
    expect(o).toBeDefined();
    expect(header.upstream.sha256).toBe(o?.sha256);
    expect(header.upstream.rows).toBe(o?.rows);
    expect(header.upstream.bytes).toBe(o?.bytes);
    expect(header.upstream.url).toBe(o?.url);
    expect([...header.columns].sort()).toEqual([
      ...phase2RequiredUpstreamColumns(header.source, season),
    ]);
    expect(header.columns.filter((c) => !(o?.columns ?? []).includes(c))).toEqual([]);
    expect(rows).toHaveLength(header.rows);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(Object.keys(r).sort()).toEqual([...header.columns].sort());
  });
});

describe("pbp → the reader SQL reproduces nflverse's own weekly counts (fixture roster, weeks 1–3)", () => {
  const { rows } = excerpt("pbp_2026");
  const loaded = rows.map((r) => pbpRow(DS_PBP, r));
  const db = load(DS_PBP, loaded);
  const p = { season: 2026, weeks: "[1,2,3]", gsis_ids: JSON.stringify(GSIS) };

  it("drops exactly the nullified (no_play) rows and keeps every snap", () => {
    const dropped = rows.filter((_, i) => loaded[i] === null);
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped).toHaveLength(5);
    expect(dropped.every((r) => r.play_type === "no_play" || r.play_type === null)).toBe(true);
    for (const r of loaded) if (r !== null) expect(r.rz === 1).toBe(Number(r.yardline_100) <= 20);
  });

  it("targets, receptions and carries per player-week equal stats_player_week", () => {
    const targets = new Map(
      db
        .prepare(sqlOf("PbpReader.playerUsage", 0))
        .all(p)
        .map((r) => [`${String(r.gsis_id)}|${String(r.week)}`, r]),
    );
    const carries = new Map(
      db
        .prepare(sqlOf("PbpReader.playerUsage", 1))
        .all(p)
        .map((r) => [`${String(r.gsis_id)}|${String(r.week)}`, r]),
    );
    let compared = 0;
    for (const s of STATS) {
      if (!GSIS.includes(String(s.player_id))) continue;
      const k = `${String(s.player_id)}|${String(s.week)}`;
      expect(Number(targets.get(k)?.targets ?? 0), `targets ${k}`).toBe(Number(s.targets ?? 0));
      expect(Number(targets.get(k)?.receptions ?? 0), `receptions ${k}`).toBe(
        Number(s.receptions ?? 0),
      );
      expect(Number(carries.get(k)?.carries ?? 0), `carries ${k}`).toBe(Number(s.carries ?? 0));
      compared++;
    }
    expect(compared).toBeGreaterThan(50);
  });

  it("TDs and FG kicks from scoringPlays equal stats_player_week", () => {
    const plays = db.prepare(sqlOf("PbpReader.scoringPlays")).all(p);
    const count = (
      pred: (r: Record<string, unknown>) => boolean,
      id: (r: Record<string, unknown>) => unknown,
    ) => {
      const m = new Map<string, number>();
      for (const r of plays.filter(pred)) {
        const k = `${String(id(r))}|${String(r.week)}`;
        m.set(k, (m.get(k) ?? 0) + 1);
      }
      return m;
    };
    const passTd = count(
      (r) => r.pass_touchdown === 1,
      (r) => r.passer_player_id,
    );
    const recTd = count(
      (r) => r.pass_touchdown === 1,
      (r) => r.td_player_id,
    );
    const rushTd = count(
      (r) => r.rush_touchdown === 1,
      (r) => r.td_player_id,
    );
    const fga = count(
      (r) => r.play_type === "field_goal",
      (r) => r.kicker_player_id,
    );
    const fgm = count(
      (r) => r.play_type === "field_goal" && r.field_goal_result === "made",
      (r) => r.kicker_player_id,
    );
    let kicks = 0;
    for (const s of STATS) {
      if (!GSIS.includes(String(s.player_id))) continue;
      const k = `${String(s.player_id)}|${String(s.week)}`;
      expect(passTd.get(k) ?? 0, `pass td ${k}`).toBe(Number(s.passing_tds ?? 0));
      expect(recTd.get(k) ?? 0, `rec td ${k}`).toBe(Number(s.receiving_tds ?? 0));
      expect(rushTd.get(k) ?? 0, `rush td ${k}`).toBe(Number(s.rushing_tds ?? 0));
      expect(fga.get(k) ?? 0, `fg att ${k}`).toBe(Number(s.fg_att ?? 0));
      expect(fgm.get(k) ?? 0, `fg made ${k}`).toBe(Number(s.fg_made ?? 0));
      kicks += Number(s.fg_att ?? 0);
    }
    expect(kicks).toBeGreaterThan(5);
    // every FG carries its distance; every TD its length (plan 08 §3.2 brackets, §4.3 long TDs)
    for (const r of plays) {
      if (r.play_type === "field_goal") expect(Number(r.kick_distance)).toBeGreaterThan(0);
      if (r.touchdown === 1 && r.return_touchdown !== 1) expect(r.yards_gained).not.toBeNull();
    }
  });
});

describe("snap counts, expected points and team weeks on real rows", () => {
  it("snap rows join the fixture roster through pfr ids (no gsis upstream)", () => {
    const { rows } = excerpt("snap_counts_2026");
    const db = load(
      DS_SNAP_COUNTS,
      rows.map((r) => snapRow(DS_SNAP_COUNTS, r)),
    );
    const got = db.prepare(sqlOf("SnapCountReader.counts", 2)).all({
      season: 2026,
      weeks: "[1,2,3]",
      pfr_ids: JSON.stringify(ROSTER.map((r) => r.pfr_id)),
    });
    expect(got).toHaveLength(rows.length);
    const byPfr = new Set(got.map((r) => String(r.pfr_player_id)));
    const skill = ROSTER.filter(
      (r) => ["QB", "RB", "WR", "TE"].includes(r.position) && r.stat_weeks.length > 0,
    );
    expect(skill.filter((r) => !byPfr.has(r.pfr_id)).map((r) => r.pfr_id)).toEqual([]);
    for (const r of got) {
      expect(Number.isInteger(r.offense_snaps)).toBe(true);
      expect(Number(r.offense_pct) >= 0 && Number(r.offense_pct) <= 1).toBe(true);
    }
  });

  it("expected points: unattributed rows dropped, TEXT seasons and DOUBLE weeks parsed", () => {
    const { rows } = excerpt("ep_weekly_2026");
    const loaded = rows.map((r) => epWeeklyRow(DS_EP_WEEKLY, r));
    expect(rows.filter((_, i) => loaded[i] === null).every((r) => r.player_id === null)).toBe(true);
    expect(loaded.filter((r) => r === null)).toHaveLength(2);
    expect(typeof rows[0]?.season).toBe("string");
    const db = load(DS_EP_WEEKLY, loaded);
    const got = db
      .prepare(sqlOf("EpWeeklyReader.rows"))
      .all({ season: 2026, weeks: "[1,2,3]", gsis_ids: JSON.stringify(GSIS) });
    expect(got).toHaveLength(rows.length - 2);
    for (const r of got) {
      expect(r.season).toBe(2026);
      expect(Number.isFinite(Number(r.total_fantasy_points_exp))).toBe(true);
    }
  });

  it("team weeks load and read back", () => {
    const { rows } = excerpt("stats_team_week_2026");
    const db = load(
      DS_STATS_TEAM_WEEK,
      rows.map((r) => statsTeamWeekRow(DS_STATS_TEAM_WEEK, r)),
    );
    const teams = [...new Set(rows.map((r) => String(r.team)))];
    const got = db
      .prepare(sqlOf("TeamWeekReader.lines"))
      .all({ season: 2026, weeks: "[1,2,3]", teams: JSON.stringify(teams) });
    expect(got).toHaveLength(rows.length);
    for (const r of got) expect(Number(r.carries)).toBeGreaterThan(0);
  });
});

describe("depth charts on real rows", () => {
  it("14 daily snapshots compress into runs that rebuild every snapshot", () => {
    const { rows } = excerpt("depth_charts_2026");
    const snaps = rows.map((r) => depthSnapshot(r));
    expect(snaps.filter((s) => s === null)).toEqual([]);
    const { rows: runs, invalid, duplicates } = depthRows(2026, rows);
    expect([invalid, duplicates]).toEqual([0, 0]);
    expect(runs.length).toBeLessThan(rows.length);
    const all = depthChartRuns(snaps.filter((s) => s !== null));
    for (const s of snaps) {
      if (s === null) continue;
      const at = all.runs.filter(
        (r) =>
          r.team === s.team &&
          r.pos_grp_id === s.pos_grp_id &&
          r.pos_slot === s.pos_slot &&
          r.pos_rank === s.pos_rank &&
          r.valid_from_ms <= s.dt_ms &&
          (r.valid_to_ms === null || s.dt_ms < r.valid_to_ms),
      );
      expect(at.map((r) => r.espn_id)).toEqual([s.espn_id]);
    }
    // every fixture player in the newest snapshot holds a current run, keyed by the ESPN id directly
    const newest = Math.max(...snaps.map((s) => s?.dt_ms ?? 0));
    const current = new Set(all.runs.filter((r) => r.valid_to_ms === null).map((r) => r.espn_id));
    for (const s of snaps)
      if (s !== null && s.dt_ms === newest) expect(current.has(s.espn_id)).toBe(true);
    expect(ROSTER.some((p) => current.has(p.espn_id))).toBe(true);
  });

  it("the ≤ 2024 layout: SBBYE rows dropped, exact duplicates collapse, blank positions fall back", () => {
    const { rows } = excerpt("depth_charts_2024");
    const loaded = rows.map((r) => legacyDepthRow(DS_DEPTH_CHARTS_LEGACY, r));
    expect(rows.filter((_, i) => loaded[i] === null).every((r) => r.week === null)).toBe(true);
    expect(loaded.filter((r) => r === null)).toHaveLength(3);
    const keyOf = (r: DatasetRow) =>
      JSON.stringify(DS_DEPTH_CHARTS_LEGACY.primary_key?.map((c) => r[c]));
    const byKey = new Map<string, string>();
    let collapsed = 0;
    for (const r of loaded) {
      if (r === null) continue;
      const prior = byKey.get(keyOf(r));
      if (prior !== undefined) {
        expect(JSON.stringify(r)).toBe(prior); // a collision is always an exact duplicate
        collapsed++;
      } else byKey.set(keyOf(r), JSON.stringify(r));
    }
    expect(collapsed).toBe(1);
    const blanks = rows.filter(
      (r) => typeof r.depth_position === "string" && r.depth_position.trim() === "",
    );
    expect(blanks).toHaveLength(2);
    for (const b of blanks)
      expect(legacyDepthRow(DS_DEPTH_CHARTS_LEGACY, b)?.pos_abb).toBe(b.position);
  });
});
