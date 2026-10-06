// make-phase2-fixtures.ts — regenerates fixtures/nflverse/phase2/** and fixtures/ffopportunity/** from
// the real release files downloaded by hand (plan 05 §3: small real excerpts ≤ 300 KB a part, with
// ATTRIBUTION; plan 10 §3.2 Phase-2 sources and B1; plan 08 §6 step 5: the upstream sha256 pinned
// beside the excerpt). Not a test and never run by CI. Same text format as the Phase-1 excerpts
// (make-fixtures.ts / fixtures.ts / tsv.ts): a JSON header — the upstream schema (names, order,
// physical + logical types), nflverse's key-value stamps, the row count, the parts — and TSV parts,
// one JSON literal per cell. Every column is kept EXCEPT for pbp (372 upstream columns: the contract's
// upstream columns plus a few the contract does not read, `desc` among them — the projection the
// source performs is then visible in the fixture) and the 2024 injuries file's `date_modified`
// (an INT64 TIMESTAMP the test writer cannot write; the contract does not read it).
//
//   scripts/dev/with-node.sh npx tsx tests/sources/nflverse/helpers/make-phase2-fixtures.ts <dir>
//
// <dir> holds `<tag>_<file>` and `<tag>_timestamp.txt` for the tags stats_team, pbp, snap_counts,
// depth_charts, stats_player and injuries (nflverse) and `ffopportunity_ep_weekly_<season>.parquet`
// + `ffopportunity_timestamp.txt` (ffverse/ffopportunity `latest-data`). Run prettier on the JSON
// afterwards like the rest of the tree, then review the diff (the secret scanner runs at commit).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import type { FileMetaData } from "hyparquet";
import { phase2RequiredUpstreamColumns } from "../../../../src/store/datasets/tables.js";
import { encodeTsv, tsvRow, type FixtureColumn } from "./fixtures.js";
import type { PhysicalType } from "./parquet-writer.js";

const ROOT = new URL("../../../../", import.meta.url).pathname;
const NFL_OUT = join(ROOT, "fixtures/nflverse/phase2");
const FFO_OUT = join(ROOT, "fixtures/ffopportunity");
const NFL_REL = "https://github.com/nflverse/nflverse-data/releases/download";
const FFO_REL = "https://github.com/ffverse/ffopportunity/releases/download/latest-data";
const MAX_PART_BYTES = 240 * 1024;
const RETRIEVED = "2026-10-06";

const srcArg = process.argv[2];
if (srcArg === undefined) throw new Error("usage: make-phase2-fixtures.ts <download-dir>");
const SRC: string = srcArg;

type Row = Record<string, unknown>;
const toAb = (b: Buffer): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const kv = (md: FileMetaData, key: string): string | null =>
  md.key_value_metadata?.find((k) => k.key === key)?.value ?? null;

interface RosterFile {
  players: { gsis_id: string; espn_id: number; pfr_id: string | null; team: string }[];
  team_units: { team: string }[];
}
const roster = JSON.parse(
  readFileSync(join(ROOT, "fixtures/players/fixture-roster.json"), "utf8"),
) as RosterFile;
const GSIS = new Set(roster.players.map((p) => p.gsis_id));
const ESPN = new Set(roster.players.map((p) => String(p.espn_id)));
const PFR = new Set(roster.players.flatMap((p) => (p.pfr_id ? [p.pfr_id] : [])));
const ROSTER_TEAMS = new Set([
  ...roster.players.map((p) => p.team),
  ...roster.team_units.map((u) => u.team),
]);

/** The three complete 2026 games (one a week, six teams), and one complete game per prior season. */
export const GAMES_2026 = ["2026_01_NO_DET", "2026_02_LV_LAC", "2026_03_LA_DEN"] as const;
export const GAME_2025 = "2025_07_WAS_DAL";
export const GAME_2024 = "2024_04_SEA_DET";
/** pbp columns the contract does not read, kept so the fixture shows the projection. */
export const PBP_EXTRA = ["home_team", "away_team", "game_date", "drive", "time", "desc"] as const;

const teamsOf = (game: string): string[] => game.split("_").slice(2);
const weekOf = (game: string): number => Number(game.split("_")[1]);
const TEAMS_2026 = new Set([...ROSTER_TEAMS, ...GAMES_2026.flatMap(teamsOf)]);

function jsonValue(v: unknown, column: string): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`${column}: non-finite number cannot be JSON`);
    return v;
  }
  if (typeof v === "string" || typeof v === "boolean") return v;
  throw new Error(`${column}: unsupported value ${typeof v}`);
}

function schemaOf(md: FileMetaData, keep: (name: string) => boolean): FixtureColumn[] {
  const out: FixtureColumn[] = [];
  for (const el of md.schema.slice(1)) {
    if (!keep(el.name)) continue;
    if (el.num_children) throw new Error(`${el.name}: nested column`);
    const type = el.type as PhysicalType;
    const logical = el.logical_type?.type ?? el.converted_type;
    if (logical !== undefined && logical !== "STRING" && logical !== "UTF8")
      throw new Error(`${el.name}: logical type ${logical} not supported by the writer`);
    out.push({ name: el.name, type, ...(logical ? { logical: "STRING" as const } : {}) });
  }
  return out;
}

interface Spec {
  readonly out: string; // fixtures root
  readonly dir: string; // sub-directory
  readonly dataset: string; // the current-season source id
  readonly season: number;
  readonly local: string; // file in SRC
  readonly url: string;
  readonly excerpt: string;
  readonly select: (rows: Row[]) => Row[];
  readonly keep?: (name: string) => boolean;
  readonly licence: string;
}

interface Written {
  readonly path: string;
  readonly url: string;
  readonly dataset: string;
  readonly season: number;
  readonly rows: number;
  readonly parts: { path: string; rows: number; bytes: number; sha256: string }[];
  readonly excerpt: string;
  readonly columns_kept: number;
  readonly upstream: Record<string, unknown>;
}

async function cut(s: Spec): Promise<Written> {
  const bytes = readFileSync(join(SRC, s.local));
  const md = parquetMetadata(toAb(bytes));
  const all = (await parquetReadObjects({ file: toAb(bytes) })) as Row[];
  const rows = s.select(all);
  const schema = schemaOf(md, s.keep ?? (() => true));
  const values = rows.map((r) => schema.map((c) => jsonValue(r[c.name], c.name)));
  const name = (s.url.split("/").pop() ?? "").replace(/\.parquet$/, "");
  const stem = join(s.dir, `${name}.excerpt`);
  const parts: { path: string; rows: number; bytes: number; sha256: string }[] = [];
  let chunk: unknown[][] = [];
  let size = 0;
  const flush = (): void => {
    if (chunk.length === 0) return;
    const rel = `${stem}.${String(parts.length + 1)}.tsv`;
    const text = encodeTsv(schema, chunk);
    const buf = Buffer.from(text, "utf8");
    mkdirSync(dirname(join(s.out, rel)), { recursive: true });
    writeFileSync(join(s.out, rel), buf);
    parts.push({ path: rel, rows: chunk.length, bytes: buf.length, sha256: sha(buf) });
    chunk = [];
    size = 0;
  };
  const headerBytes = Buffer.byteLength(`${schema.map((c) => c.name).join("\t")}\n`);
  for (const v of values) {
    const line = Buffer.byteLength(`${tsvRow(v)}\n`);
    if (size + line + headerBytes > MAX_PART_BYTES) flush();
    chunk.push(v);
    size += line;
  }
  flush();
  const keyValue: Record<string, string> = {};
  for (const k of ["nflverse_type", "nflverse_timestamp"]) {
    const v = kv(md, k);
    if (v !== null) keyValue[k] = v;
  }
  const header = {
    $comment: `${s.licence} Excerpt of ${s.url} (${s.excerpt}); generated by tests/sources/nflverse/helpers/make-phase2-fixtures.ts on ${RETRIEVED}. Rows are in the .tsv part(s) beside this file: a header line of column names, then one row per line, one JSON literal per cell, in upstream order.`,
    schema,
    key_value: keyValue,
    rows: rows.length,
    parts: parts.map((p) => p.path.split("/").pop()),
  };
  writeFileSync(join(s.out, `${stem}.json`), `${JSON.stringify(header, null, 2)}\n`);
  const codecs = [
    ...new Set(md.row_groups.flatMap((g) => g.columns.map((c) => c.meta_data?.codec))),
  ];
  const encodings = [
    ...new Set(
      md.row_groups.flatMap((g) => g.columns.flatMap((c) => c.meta_data?.encodings ?? [])),
    ),
  ].sort();
  return {
    path: `${stem}.json`,
    url: s.url,
    dataset: s.dataset,
    season: s.season,
    rows: rows.length,
    parts,
    excerpt: s.excerpt,
    columns_kept: schema.length,
    upstream: {
      bytes: bytes.length,
      rows: Number(md.num_rows),
      sha256: sha(bytes),
      columns: md.schema.length - 1,
      created_by: md.created_by ?? null,
      codecs,
      encodings,
      nflverse_timestamp: kv(md, "nflverse_timestamp"),
    },
  };
}

const NFLVERSE = "nflverse data, (c) the nflverse contributors, CC-BY 4.0 (see ATTRIBUTION.md).";
const FFO =
  "ffopportunity data, (c) the ffverse contributors, CC-BY-SA 4.0 — shared under the same licence (see ATTRIBUTION.md).";
const nfl = (dir: string, dataset: string, season: number, tag: string, file: string) => ({
  out: NFL_OUT,
  dir,
  dataset,
  season,
  local: `${tag}_${file}`,
  url: `${NFL_REL}/${tag}/${file}`,
  licence: NFLVERSE,
});

const firstPost = (rows: Row[]): Row[] => rows.filter((r) => r.season_type === "POST").slice(0, 1);
const pbpKeep = (season: number) => {
  const want = new Set<string>([
    ...phase2RequiredUpstreamColumns("nflverse:pbp", season),
    ...PBP_EXTRA,
  ]);
  return (n: string) => want.has(n);
};

/** Real exact duplicates and blank depth_position rows of the 2024 layout (as the contract notes). */
function legacyEdges(rows: Row[]): Row[] {
  const seen = new Map<string, Row>();
  let pair: Row[] = [];
  for (const r of rows) {
    const k = JSON.stringify(r);
    const prior = seen.get(k);
    if (prior && pair.length === 0 && r.week !== null) pair = [prior, r];
    seen.set(k, r);
  }
  const blanks = rows
    .filter((r) => typeof r.depth_position === "string" && r.depth_position.trim() === "")
    .slice(0, 2);
  const byes = rows.filter((r) => r.week === null).slice(0, 3);
  return [...pair, ...blanks, ...byes];
}

const SPECS: Spec[] = [
  {
    ...nfl(
      "stats_team",
      "nflverse:stats_team_week",
      2026,
      "stats_team",
      "stats_team_week_2026.parquet",
    ),
    excerpt:
      "weeks 1–3: every row of the fixture-roster teams, the team units and the three complete fixture games' teams; all 138 columns",
    select: (rows) => rows.filter((r) => Number(r.week) <= 3 && TEAMS_2026.has(String(r.team))),
  },
  ...([2025, 2024] as const).map((season) => {
    const game = season === 2025 ? GAME_2025 : GAME_2024;
    return {
      ...nfl(
        "stats_team",
        "nflverse:stats_team_week",
        season,
        "stats_team",
        `stats_team_week_${String(season)}.parquet`,
      ),
      excerpt: `both rows of ${game} and the season's first POST row; all 138 columns`,
      select: (rows: Row[]) => [...rows.filter((r) => r.game_id === game), ...firstPost(rows)],
    };
  }),
  {
    ...nfl("pbp", "nflverse:pbp", 2026, "pbp", "play_by_play_2026.parquet"),
    excerpt: `every play (markers and no_play included) of ${GAMES_2026.join(", ")}; the contract's upstream columns plus ${PBP_EXTRA.join(", ")} of 372`,
    select: (rows) =>
      rows.filter((r) => (GAMES_2026 as readonly string[]).includes(String(r.game_id))),
    keep: pbpKeep(2026),
  },
  ...([2025, 2024] as const).map((season) => {
    const game = season === 2025 ? GAME_2025 : GAME_2024;
    return {
      ...nfl("pbp", "nflverse:pbp", season, "pbp", `play_by_play_${String(season)}.parquet`),
      excerpt: `every play of ${game}; the contract's upstream columns plus ${PBP_EXTRA.join(", ")} of 372`,
      select: (rows: Row[]) => rows.filter((r) => r.game_id === game),
      keep: pbpKeep(season),
    };
  }),
  {
    ...nfl("snap_counts", "nflverse:snap_counts", 2026, "snap_counts", "snap_counts_2026.parquet"),
    excerpt:
      "every row of the three complete fixture games, and the fixture-roster players' rows of weeks 1–3; all 16 columns",
    select: (rows) =>
      rows.filter(
        (r) =>
          (GAMES_2026 as readonly string[]).includes(String(r.game_id)) ||
          (Number(r.week) <= 3 && PFR.has(String(r.pfr_player_id))),
      ),
  },
  ...([2025, 2024] as const).map((season) => {
    const game = season === 2025 ? GAME_2025 : GAME_2024;
    return {
      ...nfl(
        "snap_counts",
        "nflverse:snap_counts",
        season,
        "snap_counts",
        `snap_counts_${String(season)}.parquet`,
      ),
      excerpt: `every row of ${game}; all 16 columns`,
      select: (rows: Row[]) => rows.filter((r) => r.game_id === game),
    };
  }),
  {
    ...nfl(
      "depth_charts",
      "nflverse:depth_charts",
      2026,
      "depth_charts",
      "depth_charts_2026.parquet",
    ),
    excerpt:
      "the fixture-roster players' rows (by espn_id) of the newest 21 daily snapshots, and every DET row of the newest snapshot; all 12 columns",
    select: (rows) => {
      const dts = [...new Set(rows.map((r) => String(r.dt)))].sort();
      const recent = new Set(dts.slice(-21));
      const newest = dts.at(-1);
      return rows.filter(
        (r) =>
          (recent.has(String(r.dt)) && ESPN.has(String(r.espn_id))) ||
          (r.dt === newest && r.team === "DET" && !ESPN.has(String(r.espn_id))),
      );
    },
  },
  {
    ...nfl(
      "depth_charts",
      "nflverse:depth_charts",
      2025,
      "depth_charts",
      "depth_charts_2025.parquet",
    ),
    excerpt: `every WAS and DAL row of the two daily snapshots bracketing ${GAME_2025}'s kickoff (2025-10-19); all 12 columns`,
    select: (rows) => {
      const dts = [...new Set(rows.map((r) => String(r.dt)))].sort();
      const before = dts.filter((d) => d < "2025-10-19T17:00:00Z").at(-1);
      const after = dts.find((d) => d > "2025-10-19T17:00:00Z");
      return rows.filter(
        (r) => (r.dt === before || r.dt === after) && (r.team === "WAS" || r.team === "DAL"),
      );
    },
  },
  {
    ...nfl(
      "depth_charts",
      "nflverse:depth_charts",
      2024,
      "depth_charts",
      "depth_charts_2024.parquet",
    ),
    excerpt: `the pre-2025 layout: every SEA and DET row of week ${String(weekOf(GAME_2024))}, plus a real exact-duplicate pair, two blank depth_position rows and three week-less SBBYE rows; all 15 columns`,
    select: (rows) => [
      ...rows.filter(
        (r) => r.week === weekOf(GAME_2024) && (r.club_code === "SEA" || r.club_code === "DET"),
      ),
      ...legacyEdges(rows),
    ],
  },
  ...([2025, 2024] as const).map((season) => {
    const game = season === 2025 ? GAME_2025 : GAME_2024;
    const teams = new Set(teamsOf(game));
    return {
      ...nfl(
        "stats_player",
        "nflverse:stats_player_week",
        season,
        "stats_player",
        `stats_player_week_${String(season)}.parquet`,
      ),
      excerpt: `week ${String(weekOf(game))}: every row of ${[...teams].join(" and ")} (the ${game} players) and every team-level row (null player_id) of that week; all 150 columns`,
      select: (rows: Row[]) =>
        rows.filter(
          (r) => r.week === weekOf(game) && (teams.has(String(r.team)) || r.player_id === null),
        ),
    };
  }),
  ...([2025, 2024] as const).map((season) => {
    const game = season === 2025 ? GAME_2025 : GAME_2024;
    const teams = new Set(teamsOf(game));
    return {
      ...nfl(
        "injuries",
        "nflverse:injuries",
        season,
        "injuries",
        `injuries_${String(season)}.parquet`,
      ),
      excerpt:
        season === 2024
          ? `week ${String(weekOf(game))}: every ${[...teams].join(" and ")} report; every column but date_modified (INT64 TIMESTAMP, not read by the contract). The 2024 file has no season_type column`
          : `week ${String(weekOf(game))}: every ${[...teams].join(" and ")} report; all 16 columns`,
      select: (rows: Row[]) =>
        rows.filter((r) => r.week === weekOf(game) && teams.has(String(r.team))),
      keep: (n: string) => n !== "date_modified",
    };
  }),
  {
    out: FFO_OUT,
    dir: "ep_weekly",
    dataset: "ffopportunity:ep_weekly",
    season: 2026,
    local: "ffopportunity_ep_weekly_2026.parquet",
    url: `${FFO_REL}/ep_weekly_2026.parquet`,
    licence: FFO,
    excerpt:
      "every row of the three complete fixture games, the fixture-roster players' rows of weeks 1–3, and the first two team-level rows (null player_id); all 159 columns",
    select: (rows) => {
      const nulls = rows.filter((r) => r.player_id === null).slice(0, 2);
      return [
        ...rows.filter(
          (r) =>
            r.player_id !== null &&
            ((GAMES_2026 as readonly string[]).includes(String(r.game_id)) ||
              (Number(r.week) <= 3 && typeof r.player_id === "string" && GSIS.has(r.player_id))),
        ),
        ...nulls,
      ];
    },
  },
  ...([2025, 2024] as const).map((season) => {
    const game = season === 2025 ? GAME_2025 : GAME_2024;
    return {
      out: FFO_OUT,
      dir: "ep_weekly",
      dataset: "ffopportunity:ep_weekly",
      season,
      local: `ffopportunity_ep_weekly_${String(season)}.parquet`,
      url: `${FFO_REL}/ep_weekly_${String(season)}.parquet`,
      licence: FFO,
      excerpt: `every row of ${game} (its team-level rows included); all 159 columns`,
      select: (rows: Row[]) => rows.filter((r) => r.game_id === game),
    };
  }),
];

function stamp(out: string, dir: string, local: string, url: string) {
  const text = readFileSync(join(SRC, local));
  mkdirSync(join(out, dir), { recursive: true });
  writeFileSync(join(out, dir, "timestamp.txt"), text);
  return { path: `${dir}/timestamp.txt`, url, text: text.toString("utf8").trim() };
}

const written: Written[] = [];
for (const s of SPECS) {
  written.push(await cut(s));
  process.stderr.write(`${s.local}: ${String(written.at(-1)?.rows)} rows\n`);
}
const nflManifest = {
  $comment:
    "nflverse Phase-2 fixtures (CC-BY 4.0, see ATTRIBUTION.md). Generated by tests/sources/nflverse/helpers/make-phase2-fixtures.ts from the release files downloaded on the `retrieved` date. `url` = the release asset an excerpt stands in for; tests rebuild a parquet file from each excerpt (same schema, SNAPPY) and serve it there through a fake HttpGet. `upstream.sha256` pins the exact upstream file (plan 08 §6 step 5; = tests/store/datasets/observed-phase2.ts).",
  retrieved: RETRIEVED,
  timestamps: Object.fromEntries(
    ["stats_team", "pbp", "snap_counts", "depth_charts"].map((t) => [
      t,
      stamp(NFL_OUT, t, `${t}_timestamp.txt`, `${NFL_REL}/${t}/timestamp.txt`),
    ]),
  ),
  default_seasons: {
    "nflverse:stats_team_week": [2026],
    "nflverse:pbp": [2026],
    "nflverse:snap_counts": [2026],
    "nflverse:depth_charts": [2026],
    "nflverse:stats_team_week_history": [2024, 2025],
    "nflverse:pbp_history": [2024, 2025],
    "nflverse:snap_counts_history": [2024, 2025],
    "nflverse:depth_charts_history": [2024, 2025],
    "nflverse:stats_player_week_history": [2024, 2025],
    "nflverse:injuries_history": [2024, 2025],
  },
  files: written.filter((w) => w.dataset.startsWith("nflverse:")),
};
const ffoManifest = {
  $comment:
    "ffopportunity fixtures (CC-BY-SA 4.0 — shared under the same licence, see ATTRIBUTION.md). Generated by tests/sources/nflverse/helpers/make-phase2-fixtures.ts from the release files downloaded on the `retrieved` date; same layout as fixtures/nflverse/manifest.json.",
  retrieved: RETRIEVED,
  timestamps: {
    "latest-data": stamp(
      FFO_OUT,
      "ep_weekly",
      "ffopportunity_timestamp.txt",
      `${FFO_REL}/timestamp.txt`,
    ),
  },
  default_seasons: {
    "ffopportunity:ep_weekly": [2026],
    "ffopportunity:ep_weekly_history": [2024, 2025],
  },
  files: written.filter((w) => w.dataset.startsWith("ffopportunity:")),
};
writeFileSync(join(NFL_OUT, "manifest.json"), `${JSON.stringify(nflManifest, null, 2)}\n`);
writeFileSync(join(FFO_OUT, "manifest.json"), `${JSON.stringify(ffoManifest, null, 2)}\n`);
for (const w of written) {
  process.stderr.write(
    `${w.path}: ${String(w.rows)} rows, ${String(w.columns_kept)} cols, ${w.parts.map((p) => String(p.bytes)).join(" + ")} B\n`,
  );
}
