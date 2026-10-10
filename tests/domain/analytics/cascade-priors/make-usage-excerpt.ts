// make-usage-excerpt.ts — writes the committed team-game usage excerpt behind plan 10 C6 and the
// shipped redistribution prior table (plan 10 §3.3 "the redistribution prior table from pbp
// history"). NOT a test file (vitest never runs it) and never part of CI: it reads nflverse release
// files from a local directory the caller names (downloaded outside the repo; never committed).
//
//   scripts/dev/with-node.sh npx tsx tests/domain/analytics/cascade-priors/make-usage-excerpt.ts <dir> [--report]
//
// <dir> holds, per season s in 2023–2025, pbp_play_by_play_<s>.parquet,
// stats_player_stats_player_week_<s>.parquet and depth_charts_depth_charts_<s>.parquet, plus
// schedules_games.parquet (the release names prefixed with their tag, as the Phase-3 grounding
// downloaded them). It writes:
//   * tests/domain/analytics/cascade-priors/data/usage-<s>.tsv — one row per (week, team, player)
//     of the regular season: position group, depth-chart rank, targets, carries and their red-zone
//     subsets (src/domain/analytics/cascade-priors/usage.ts — the store's own pbp definitions),
//     players PSEUDONYMISED per (season, team) as p1, p2, … in sorted-id order (no NFL id is needed
//     to find absences, and none is committed);
//   * tests/domain/analytics/cascade-priors/data/manifest.json — every file's sha256 and rows, and
//     each upstream file's URL, bytes and sha256;
//   * src/domain/analytics/cascade-priors/generated/table.ts — the shipped table, built from the
//     excerpt itself (`buildPriorTable(findAbsences(rows))`), so a test can rebuild it byte for byte.
// --report prints the inputs' tilt / hold distributions and the leave-one-season-out C6 numbers.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import {
  DEFAULT_ABSENCE_RULES,
  findAbsences,
} from "../../../../src/domain/analytics/cascade-priors/absences.js";
import {
  crossValidateCascade,
  pairedHits,
} from "../../../../src/domain/analytics/cascade-priors/evaluate.js";
import { buildPriorTable } from "../../../../src/domain/analytics/cascade-priors/table.js";
import type {
  CascadeEvaluation,
  UsageRow,
} from "../../../../src/domain/analytics/cascade-priors/types.js";
import {
  usageFromPlays,
  usagePosition,
  type DepthListing,
  type PbpPlay,
} from "../../../../src/domain/analytics/cascade-priors/usage.js";
import {
  EXCERPT_COLUMNS,
  EXCERPT_RULE,
  EXCERPT_SEASONS,
  TABLE_PROVENANCE_NOTE,
  encodeUsage,
  manifestFileOf,
  type UsageManifest,
} from "./helpers/excerpt.js";

type Row = Record<string, unknown>;
const ROOT = new URL("../../../../", import.meta.url).pathname;
const DATA = join(ROOT, "tests/domain/analytics/cascade-priors/data");
const TABLE_TS = join(ROOT, "src/domain/analytics/cascade-priors/generated/table.ts");
const REL = "https://github.com/nflverse/nflverse-data/releases/download";

function read(path: string, columns: readonly string[]): Promise<Row[]> {
  const buf = readFileSync(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return parquetReadObjects({ file: ab, metadata: parquetMetadata(ab), columns: [...columns] });
}
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const num = (v: unknown): number =>
  typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : Number.NaN;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** nflverse depth-chart / ESPN team codes → the pbp `posteam` codes. */
const TEAM_ALIAS: Readonly<Record<string, string>> = { LAR: "LA", WSH: "WAS", JAC: "JAX" };
const team = (t: string): string => TEAM_ALIAS[t] ?? t;
const SKILL = new Set(["QB", "RB", "WR", "TE"]);

async function seasonRows(dir: string, s: number, upstream: UsageManifest["upstream"]) {
  const files = {
    pbp: {
      local: `pbp_play_by_play_${String(s)}.parquet`,
      url: `${REL}/pbp/play_by_play_${String(s)}.parquet`,
    },
    stats: {
      local: `stats_player_stats_player_week_${String(s)}.parquet`,
      url: `${REL}/stats_player/stats_player_week_${String(s)}.parquet`,
    },
    depth: {
      local: `depth_charts_depth_charts_${String(s)}.parquet`,
      url: `${REL}/depth_charts/depth_charts_${String(s)}.parquet`,
    },
  };
  for (const f of Object.values(files)) {
    const b = readFileSync(join(dir, f.local));
    upstream.push({ url: f.url, bytes: b.length, sha256: sha(b) });
  }
  const plays = (await read(join(dir, files.pbp.local), [
    "season",
    "week",
    "season_type",
    "posteam",
    "play_type",
    "pass_attempt",
    "rush_attempt",
    "sack",
    "two_point_attempt",
    "receiver_player_id",
    "rusher_player_id",
    "yardline_100",
  ])) as unknown as PbpPlay[];
  const stats = await read(join(dir, files.stats.local), [
    "player_id",
    "position_group",
    "season_type",
  ]);
  const counts = new Map<string, Map<string, number>>();
  for (const r of stats) {
    const id = str(r.player_id);
    if (id === "") continue;
    const m = counts.get(id) ?? new Map<string, number>();
    const g = str(r.position_group);
    m.set(g, (m.get(g) ?? 0) + 1);
    counts.set(id, m);
  }
  const positions = new Map(
    [...counts].map(([id, m]) => [
      id,
      usagePosition([...m].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))[0]?.[0]),
    ]),
  );
  const depth: DepthListing[] = [];
  if (s <= 2024) {
    const dc = await read(join(dir, files.depth.local), [
      "season",
      "week",
      "game_type",
      "club_code",
      "formation",
      "position",
      "depth_team",
      "gsis_id",
    ]);
    for (const r of dc) {
      const pos = str(r.position);
      const rank = Number.parseInt(str(r.depth_team), 10);
      if (str(r.game_type) !== "REG" || str(r.formation) !== "Offense" || !SKILL.has(pos)) continue;
      if (str(r.gsis_id) === "" || !Number.isInteger(rank)) continue;
      depth.push({
        season: s,
        week: num(r.week),
        team: team(str(r.club_code)),
        player: str(r.gsis_id),
        position: pos as DepthListing["position"],
        rank,
      });
    }
  } else {
    // snapshots: each team-week reads the last snapshot before its game day's 12:00 UTC
    const games = await read(join(dir, "schedules_games.parquet"), [
      "season",
      "game_type",
      "week",
      "gameday",
      "home_team",
      "away_team",
    ]);
    const kick = new Map<string, string>();
    for (const g of games) {
      if (num(g.season) !== s || str(g.game_type) !== "REG") continue;
      const at = `${str(g.gameday)}T12:00:00Z`;
      kick.set(`${str(g.home_team)}|${String(num(g.week))}`, at);
      kick.set(`${str(g.away_team)}|${String(num(g.week))}`, at);
    }
    const dc = await read(join(dir, files.depth.local), [
      "dt",
      "team",
      "gsis_id",
      "pos_abb",
      "pos_rank",
    ]);
    const byTeam = new Map<string, Row[]>();
    for (const r of dc) {
      if (!SKILL.has(str(r.pos_abb)) || str(r.gsis_id) === "") continue;
      const t = team(str(r.team));
      byTeam.set(t, [...(byTeam.get(t) ?? []), r]);
    }
    for (const [k, at] of kick) {
      const [t = "", w] = k.split("|");
      const rows = byTeam.get(t) ?? [];
      const dts = [...new Set(rows.map((r) => str(r.dt)))].filter((d) => d < at).sort();
      const dt = dts[dts.length - 1];
      if (dt === undefined) continue;
      for (const r of rows)
        if (str(r.dt) === dt)
          depth.push({
            season: s,
            week: Number(w),
            team: t,
            player: str(r.gsis_id),
            position: str(r.pos_abb) as DepthListing["position"],
            rank: num(r.pos_rank),
          });
    }
  }
  const rows = usageFromPlays(plays, positions, depth);
  // pseudonymise per (season, team): sorted ids → p1, p2, …
  const ids = new Map<string, string[]>();
  for (const r of rows) ids.set(r.team, [...(ids.get(r.team) ?? []), r.player]);
  const alias = new Map<string, string>();
  for (const [t, list] of ids)
    [...new Set(list)].sort().forEach((id, i) => alias.set(`${t}|${id}`, `p${String(i + 1)}`));
  const pbpTeams = new Set(rows.map((r) => r.team));
  const unmatched = [...new Set(depth.map((d) => d.team))].filter((t) => !pbpTeams.has(t));
  return {
    rows: rows.map((r): UsageRow => ({ ...r, player: alias.get(`${r.team}|${r.player}`) ?? "" })),
    unmatched,
    depthListings: depth.length,
  };
}

function quantiles(xs: number[]): string {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]?.toFixed(3) ?? "-";
  return `n=${String(s.length)} p25=${q(0.25)} p50=${q(0.5)} p75=${q(0.75)}`;
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (dir === undefined) throw new Error("usage: make-usage-excerpt.ts <dir> [--report]");
  const report = process.argv.includes("--report");
  mkdirSync(DATA, { recursive: true });
  const upstream: UsageManifest["upstream"] = [];
  const g = readFileSync(join(dir, "schedules_games.parquet"));
  upstream.push({ url: `${REL}/schedules/games.parquet`, bytes: g.length, sha256: sha(g) });
  const all: UsageRow[] = [];
  const files: UsageManifest["files"][number][] = [];
  for (const s of EXCERPT_SEASONS) {
    const { rows, unmatched, depthListings } = await seasonRows(dir, s, upstream);
    if (unmatched.length > 0)
      throw new Error(`unmatched depth-chart teams ${String(s)}: ${unmatched.join(",")}`);
    const text = encodeUsage(rows);
    const path = `usage-${String(s)}.tsv`;
    writeFileSync(join(DATA, path), text);
    files.push(manifestFileOf(path, s, rows.length, text));
    all.push(...rows);
    if (report)
      process.stderr.write(
        `${String(s)}: ${String(rows.length)} rows, ${String(depthListings)} depth listings\n`,
      );
  }
  const manifest: UsageManifest = {
    schema: "cascade-usage-excerpt-v1",
    rule: EXCERPT_RULE,
    columns: [...EXCERPT_COLUMNS],
    licence: "CC-BY-4.0 (nflverse; adapted: per-player team-game counts, players pseudonymised)",
    files,
    upstream: upstream.sort((a, b) => (a.url < b.url ? -1 : 1)),
  };
  writeFileSync(join(DATA, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const events = findAbsences(all, DEFAULT_ABSENCE_RULES);
  const table = buildPriorTable(events, {
    rules: DEFAULT_ABSENCE_RULES,
    provenance: [
      TABLE_PROVENANCE_NOTE,
      ...manifest.upstream.map((u) => `${u.url} sha256:${u.sha256}`),
    ],
  });
  mkdirSync(join(TABLE_TS, ".."), { recursive: true });
  writeFileSync(
    TABLE_TS,
    `// table.ts — GENERATED by tests/domain/analytics/cascade-priors/make-usage-excerpt.ts; do not edit.\n` +
      `// The redistribution prior table (plan 10 §3.3, C6; sib research 05 §6.2) built from nflverse pbp\n` +
      `// 2023–2025 (CC-BY-4.0): \`buildPriorTable(findAbsences(<the committed usage excerpt>))\`.\n` +
      `// tests/domain/analytics/cascade-priors/table.test.ts rebuilds it from the excerpt and compares.\n` +
      `import type { CascadePriorTable } from "../types.js";\n\n` +
      `/** The shipped redistribution prior table. */\n` +
      `export const CASCADE_PRIOR_TABLE_DATA: CascadePriorTable = ${JSON.stringify(table)};\n`,
  );
  if (!report) return;
  for (const pos of ["RB", "WR", "TE"] as const) {
    const es = events.filter((e) => e.injured.position === pos);
    const main = pos === "RB" ? "carries" : "targets";
    process.stderr.write(
      `${pos}: ${String(es.length)} absences; hold ${quantiles(es.map((e) => e.injured.pre[main]))}\n`,
    );
  }
  process.stderr.write(
    `tilt ${quantiles(events.map((e) => e.team_pre.targets / (e.team_pre.targets + e.team_pre.carries)))}\n`,
  );
  const cv = crossValidateCascade(all);
  const strip = (ev: CascadeEvaluation) => ({ ...ev, event_hits: undefined });
  const out = {
    absences: events.length,
    shipped_shrink_events: table.shrink_events,
    folds: cv.folds.map((f) => ({ ...f, evaluation: strip(f.evaluation) })),
    pooled: strip(cv.pooled),
    paired: {
      v2_vs_next_man_up_usage: pairedHits(cv.pooled, "v2_table", "next_man_up_usage"),
      v2_vs_next_man_up_depth: pairedHits(cv.pooled, "v2_table", "next_man_up_depth"),
      v2_vs_v1: pairedHits(cv.pooled, "v2_table", "v1_affinity"),
    },
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

void main();
