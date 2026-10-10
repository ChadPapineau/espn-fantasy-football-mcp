// make-history-fixtures.ts — regenerates fixtures/history/** (the third backtest season, 2023) from the
// real release files downloaded by hand (plan 10 §3.3 "≥ 3 historical seasons" [A-3], D9; plan 05 §3:
// small real excerpts ≤ 300 KB a part, with ATTRIBUTION; plan 08 §6 step 5: the upstream sha256
// pinned beside the excerpt). Not a test and never run by CI. Same text format and the same cut rules
// as make-phase2-fixtures.ts (a JSON header — upstream schema, nflverse key-value stamps, row count,
// parts — and TSV parts of JSON literals): one complete 2023 game per per-season dataset, the
// legacy depth-chart edge rows 2023 adds (labels outside DEPTH_LABELS, an ungrammatical label), and
// that game's week of `games.parquet` (served merged with the Phase-1 games excerpt — one URL holds
// every season).
//
//   scripts/dev/with-node.sh npx tsx tests/sources/nflverse/helpers/make-history-fixtures.ts <dir>
//
// <dir> holds `<tag>_<file>` for stats_player, stats_team, pbp, snap_counts, depth_charts and
// injuries 2023, `schedules_games.parquet` and `ffopportunity_ep_weekly_2023.parquet` (the names
// tests/sources/nflverse/phase3-real.test.ts reads). Run prettier on the JSON afterwards, update
// fixtures/history/ATTRIBUTION.md from manifest.json, and review the diff (the scanner runs at commit).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import type { FileMetaData } from "hyparquet";
import { DEPTH_LABELS } from "../../../../src/store/datasets/derive.js";
import { phase2RequiredUpstreamColumns } from "../../../../src/store/datasets/tables.js";
import { encodeTsv, tsvRow, type FixtureColumn, type FixtureHeader } from "./fixtures.js";
import type { PhysicalType } from "./parquet-writer.js";

const ROOT = new URL("../../../../", import.meta.url).pathname;
const OUT = join(ROOT, "fixtures/history");
const NFL_REL = "https://github.com/nflverse/nflverse-data/releases/download";
const FFO_REL = "https://github.com/ffverse/ffopportunity/releases/download/latest-data";
const MAX_PART_BYTES = 240 * 1024;
const RETRIEVED = "2026-10-10";

/** The 2023 game every per-season excerpt is cut around (week 9, outdoors; five fixture-roster rows). */
export const GAME_2023 = "2023_09_BUF_CIN";
/** pbp columns the contract does not read, kept so the fixture shows the projection (as Phase 2). */
export const PBP_EXTRA = ["home_team", "away_team", "game_date", "drive", "time", "desc"] as const;

const srcArg = process.argv[2];
if (srcArg === undefined) throw new Error("usage: make-history-fixtures.ts <download-dir>");
const SRC: string = srcArg;

type Row = Record<string, unknown>;
const toAb = (b: Buffer): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const kv = (md: FileMetaData, key: string): string | null =>
  md.key_value_metadata?.find((k) => k.key === key)?.value ?? null;
const teamsOf = (game: string): string[] => game.split("_").slice(2);
const weekOf = (game: string): number => Number(game.split("_")[1]);
const TEAMS = new Set(teamsOf(GAME_2023));
const WEEK = weekOf(GAME_2023);

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
  readonly dir: string; // sub-directory of fixtures/history
  readonly dataset: string; // the current-season source id
  readonly season: number;
  readonly local: string; // file in SRC
  readonly url: string;
  readonly excerpt: string;
  readonly select: (rows: Row[]) => Row[];
  readonly keep?: (name: string) => boolean;
  readonly licence: string;
  /** The schema the excerpt must equal (the schedules excerpt is merged with Phase 1's). */
  readonly sameSchemaAs?: string;
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
  if (rows.length === 0) throw new Error(`${s.local}: the selection is empty`);
  const schema = schemaOf(md, s.keep ?? (() => true));
  if (s.sameSchemaAs !== undefined) {
    const other = JSON.parse(readFileSync(join(ROOT, s.sameSchemaAs), "utf8")) as FixtureHeader;
    if (JSON.stringify(other.schema) !== JSON.stringify(schema))
      throw new Error(`${s.local}: schema differs from ${s.sameSchemaAs}`);
  }
  const values = rows.map((r) => schema.map((c) => jsonValue(r[c.name], c.name)));
  const name = (s.url.split("/").pop() ?? "").replace(/\.parquet$/, "");
  const stem = join(s.dir, `${name === "games" ? `games_${String(s.season)}` : name}.excerpt`);
  const parts: { path: string; rows: number; bytes: number; sha256: string }[] = [];
  let chunk: unknown[][] = [];
  let size = 0;
  const flush = (): void => {
    if (chunk.length === 0) return;
    const rel = `${stem}.${String(parts.length + 1)}.tsv`;
    const buf = Buffer.from(encodeTsv(schema, chunk), "utf8");
    mkdirSync(dirname(join(OUT, rel)), { recursive: true });
    writeFileSync(join(OUT, rel), buf);
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
    $comment: `${s.licence} Excerpt of ${s.url} (${s.excerpt}); generated by tests/sources/nflverse/helpers/make-history-fixtures.ts on ${RETRIEVED}. Rows are in the .tsv part(s) beside this file: a header line of column names, then one row per line, one JSON literal per cell, in upstream order.`,
    schema,
    key_value: keyValue,
    rows: rows.length,
    parts: parts.map((p) => p.path.split("/").pop()),
  };
  writeFileSync(join(OUT, `${stem}.json`), `${JSON.stringify(header, null, 2)}\n`);
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
const nfl = (tag: string, dataset: string, file: string) => ({
  dir: `nflverse/${tag}`,
  dataset,
  season: 2023,
  local: `${tag}_${file}`,
  url: `${NFL_REL}/${tag}/${file}`,
  licence: NFLVERSE,
});
const ofGame = (rows: Row[]): Row[] => rows.filter((r) => r.game_id === GAME_2023);

/**
 * The pre-2025 layout's edge rows of the 2023 file: a real exact-duplicate pair, two blank
 * `depth_position` rows, three week-less `SBBYE` rows (as 2024's excerpt), plus what 2023 adds — the
 * first row of each well-formed label outside DEPTH_LABELS (stored as 'OTHER') and two rows whose
 * label fails the grammar (the row is invalid: dropped and counted).
 */
function legacyEdges2023(rows: Row[]): Row[] {
  const seen = new Map<string, Row>();
  let pair: Row[] = [];
  for (const r of rows) {
    const k = JSON.stringify(r, (_, v: unknown) => (typeof v === "bigint" ? Number(v) : v));
    const prior = seen.get(k);
    if (prior && pair.length === 0 && r.week !== null) pair = [prior, r];
    seen.set(k, r);
  }
  const label = (r: Row): string | null => {
    const d = typeof r.depth_position === "string" ? r.depth_position.trim() : "";
    return d !== "" ? d : typeof r.position === "string" ? r.position : null;
  };
  const blanks = rows
    .filter((r) => typeof r.depth_position === "string" && r.depth_position.trim() === "")
    .slice(0, 2);
  const byes = rows.filter((r) => r.week === null).slice(0, 3);
  const outside = new Map<string, Row>();
  const ungrammatical: Row[] = [];
  for (const r of rows) {
    const l = label(r);
    if (l === null || DEPTH_LABELS.has(l)) continue;
    if (/^[A-Za-z0-9][A-Za-z0-9 ./&+-]{0,31}$/.test(l)) {
      if (!outside.has(l)) outside.set(l, r);
    } else if (ungrammatical.length < 2) ungrammatical.push(r);
  }
  return [...pair, ...blanks, ...byes, ...outside.values(), ...ungrammatical];
}

const SPECS: Spec[] = [
  {
    ...nfl("stats_player", "nflverse:stats_player_week", "stats_player_week_2023.parquet"),
    excerpt: `week ${String(WEEK)}: every row of ${[...TEAMS].join(" and ")} (the ${GAME_2023} players) and every team-level row (null player_id) of that week; all 150 columns`,
    select: (rows) =>
      rows.filter((r) => r.week === WEEK && (TEAMS.has(String(r.team)) || r.player_id === null)),
  },
  {
    ...nfl("stats_team", "nflverse:stats_team_week", "stats_team_week_2023.parquet"),
    excerpt: `both rows of ${GAME_2023} and the season's first POST row; all 138 columns`,
    select: (rows) => [
      ...ofGame(rows),
      ...rows.filter((r) => r.season_type === "POST").slice(0, 1),
    ],
  },
  {
    ...nfl("pbp", "nflverse:pbp", "play_by_play_2023.parquet"),
    excerpt: `every play (markers and no_play included) of ${GAME_2023}; the contract's upstream columns plus ${PBP_EXTRA.join(", ")} of 372 (goal_to_go is INT32 in this file, DOUBLE from 2024)`,
    select: ofGame,
    keep: (() => {
      const want = new Set<string>([
        ...phase2RequiredUpstreamColumns("nflverse:pbp", 2023),
        ...PBP_EXTRA,
      ]);
      return (n: string) => want.has(n);
    })(),
  },
  {
    ...nfl("snap_counts", "nflverse:snap_counts", "snap_counts_2023.parquet"),
    excerpt: `every row of ${GAME_2023}; all 16 columns`,
    select: ofGame,
  },
  {
    ...nfl("depth_charts", "nflverse:depth_charts", "depth_charts_2023.parquet"),
    excerpt: `the pre-2025 layout: every ${[...TEAMS].join(" and ")} row of week ${String(WEEK)}, plus a real exact-duplicate pair, two blank depth_position rows, three week-less SBBYE rows, the first row of each label outside DEPTH_LABELS and two rows whose label fails the grammar; all 15 columns`,
    // the same row object never twice (an artificial duplicate would change the collapse counts)
    select: (rows) => [
      ...new Set([
        ...rows.filter((r) => r.week === WEEK && TEAMS.has(String(r.club_code))),
        ...legacyEdges2023(rows),
      ]),
    ],
  },
  {
    ...nfl("injuries", "nflverse:injuries", "injuries_2023.parquet"),
    excerpt: `week ${String(WEEK)}: every ${[...TEAMS].join(" and ")} report; every column but date_modified (INT64 TIMESTAMP, not read by the contract). The 2023 file has no season_type column, as 2024's`,
    select: (rows) => rows.filter((r) => r.week === WEEK && TEAMS.has(String(r.team))),
    keep: (n) => n !== "date_modified",
  },
  {
    ...nfl("schedules", "nflverse:schedules", "games.parquet"),
    excerpt: `every 2023 week-${String(WEEK)} game (${GAME_2023} among them; lines, roof, scores); all 46 columns — served merged with the Phase-1 games excerpt at the one games.parquet URL`,
    select: (rows) => rows.filter((r) => r.season === 2023 && r.week === WEEK),
    sameSchemaAs: "fixtures/nflverse/schedules/games.excerpt.json",
  },
  {
    dir: "ffopportunity/ep_weekly",
    dataset: "ffopportunity:ep_weekly",
    season: 2023,
    local: "ffopportunity_ep_weekly_2023.parquet",
    url: `${FFO_REL}/ep_weekly_2023.parquet`,
    licence: FFO,
    excerpt: `every row of ${GAME_2023} (its team-level rows included); all 159 columns`,
    select: ofGame,
  },
];

const written: Written[] = [];
for (const s of SPECS) {
  written.push(await cut(s));
  process.stderr.write(`${s.local}: ${String(written.at(-1)?.rows)} rows\n`);
}
const manifest = {
  $comment:
    "The third backtest season (2023) of the history twins and nflverse:schedules (nflverse CC-BY 4.0; ffopportunity CC-BY-SA 4.0 under ffopportunity/ — see ATTRIBUTION.md). Generated by tests/sources/nflverse/helpers/make-history-fixtures.ts from the release files downloaded on the `retrieved` date. `url` = the release asset an excerpt stands in for; tests rebuild a parquet file from each excerpt (same schema, SNAPPY) and serve it there through a fake HttpGet — the schedules excerpt merged with fixtures/nflverse/schedules/games.excerpt.json, since one games.parquet holds every season. `upstream.sha256` pins the exact upstream file (plan 08 §6 step 5; = tests/sources/nflverse/helpers/observed-history.ts).",
  retrieved: RETRIEVED,
  game: GAME_2023,
  backtest_seasons: [2023, 2024, 2025],
  files: written,
};
writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
for (const w of written) {
  process.stderr.write(
    `${w.path}: ${String(w.rows)} rows, ${String(w.columns_kept)} cols, ${w.parts.map((p) => String(p.bytes)).join(" + ")} B\n`,
  );
}
