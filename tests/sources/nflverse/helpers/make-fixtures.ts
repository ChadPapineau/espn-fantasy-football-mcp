// make-fixtures.ts — regenerates fixtures/nflverse/** from real nflverse release files downloaded by
// hand (plan 05 §3: small real excerpts ≤ 300 KB under CC-BY 4.0 with ATTRIBUTION.md; plan 10
// §3.1a: ≥ 3 final weeks for the fixture league's players; plan 08 §6 step 5: the upstream sha256 is
// pinned beside the excerpt). Not a test and never run by CI. Ported from sibling @521f9f3, adapted:
// the excerpts are TEXT — gzipped columnar JSON — because scripts/dev/scan-secrets.mjs refuses binary
// parquet (it decompresses and scans gzip) and prettier-formatted JSON would exceed the 300 KB cap;
// the tests rebuild parquet from them (fixtures.ts + parquet-writer.ts). The manifest is then
// prettier-formatted like the rest of the tree.
//
//   scripts/dev/with-node.sh npx tsx tests/sources/nflverse/helpers/make-fixtures.ts <download-dir>
//
// <download-dir> holds `<tag>_<file>` and `<tag>_timestamp.txt` for the tags schedules, injuries,
// weekly_rosters, stats_player and players (e.g. `weekly_rosters_roster_weekly_2026.parquet`).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import type { FileMetaData } from "hyparquet";
import type { FixtureColumn, FixtureFile, FixtureManifest, ManifestFile } from "./fixtures.js";
import type { PhysicalType } from "./parquet-writer.js";

const PHYSICAL: readonly PhysicalType[] = [
  "BOOLEAN",
  "INT32",
  "INT64",
  "FLOAT",
  "DOUBLE",
  "BYTE_ARRAY",
];

const ROOT = new URL("../../../../", import.meta.url).pathname;
const OUT = join(ROOT, "fixtures/nflverse");
const REL = "https://github.com/nflverse/nflverse-data/releases/download";
const MAX_FIXTURE_BYTES = 300 * 1024;

const src = process.argv[2];
if (src === undefined) throw new Error("usage: make-fixtures.ts <download-dir>");
const dir: string = src;

type Row = Record<string, unknown>;
const toAb = (b: Buffer): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const kv = (md: FileMetaData, key: string): string | null =>
  md.key_value_metadata?.find((k) => k.key === key)?.value ?? null;

interface RosterFile {
  players: { gsis_id: string; last_name: string; tags: string[] }[];
  decoys: { gsis_id: string }[];
  team_units: { team: string }[];
}
const roster = JSON.parse(
  readFileSync(join(ROOT, "fixtures/players/fixture-roster.json"), "utf8"),
) as RosterFile;
const ids = new Set([
  ...roster.players.map((p) => p.gsis_id),
  ...roster.decoys.map((d) => d.gsis_id),
]);
const units = new Set(roster.team_units.map((u) => u.team));
const surnames = new Set(
  roster.players.filter((p) => p.tags.includes("same_surname")).map((p) => p.last_name),
);

function jsonValue(v: unknown, column: string): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`${column}: non-finite number cannot be JSON`);
    return v;
  }
  if (typeof v === "string" || typeof v === "boolean") return v;
  throw new Error(`${column}: unsupported value type ${typeof v}`);
}

const files: ManifestFile[] = [];

let cachedGames: Set<string> | null = null;
function unitGames(all: readonly Row[]): Set<string> {
  if (cachedGames) return cachedGames;
  cachedGames = new Set(
    all
      .filter((r) => (r.week as number) <= 3 && units.has(r.team as string))
      .map((r) => r.game_id as string),
  );
  return cachedGames;
}

async function excerpt(
  tag: string,
  upstreamFile: string,
  dataset: string,
  season: number | null,
  rel: string,
  keep: (row: Row, all: readonly Row[]) => boolean,
  rule: string,
): Promise<void> {
  const b = readFileSync(join(dir, `${tag}_${upstreamFile}`));
  const ab = toAb(b);
  const md = parquetMetadata(ab);
  const all = (await parquetReadObjects({ file: ab })) as Row[];
  const rows = all.filter((r) => keep(r, all));
  const schema = md.schema.slice(1).map((el): FixtureColumn => {
    const logical = el.logical_type?.type;
    const type = el.type;
    if (type === undefined || !(PHYSICAL as readonly string[]).includes(type)) {
      throw new Error(`${upstreamFile}: column ${el.name} has an unsupported type`);
    }
    return {
      name: el.name,
      type: type as PhysicalType,
      ...(logical === "STRING" || logical === "DATE" ? { logical } : {}),
    };
  });
  const codecs = new Set<string>();
  const encodings = new Set<string>();
  for (const rg of md.row_groups) {
    for (const c of rg.columns) {
      if (!c.meta_data) continue;
      codecs.add(c.meta_data.codec);
      for (const e of c.meta_data.encodings) encodings.add(e);
    }
  }
  const key_value: Record<string, string> = {};
  for (const k of ["nflverse_type", "nflverse_timestamp"]) {
    const v = kv(md, k);
    if (v !== null) key_value[k] = v;
  }
  const fixture: FixtureFile = {
    $comment: `nflverse data, CC-BY 4.0 (see ../ATTRIBUTION.md): an excerpt of ${REL}/${tag}/${upstreamFile} — ${rule}. Columnar: columns[name][i] is row i. Generated by tests/sources/nflverse/helpers/make-fixtures.ts.`,
    schema,
    key_value,
    rows: rows.length,
    columns: Object.fromEntries(
      schema.map((s) => [s.name, rows.map((r) => jsonValue(r[s.name], s.name))]),
    ),
  };
  const text = `${JSON.stringify(fixture)}\n`;
  const bytes = gzipSync(Buffer.from(text), { level: 9 });
  if (bytes.length > MAX_FIXTURE_BYTES) {
    throw new Error(`${rel}: ${String(bytes.length)} bytes > 300 KB`);
  }
  mkdirSync(join(OUT, rel, ".."), { recursive: true });
  writeFileSync(join(OUT, rel), bytes);
  files.push({
    path: rel,
    url: `${REL}/${tag}/${upstreamFile}`,
    dataset,
    season,
    rows: rows.length,
    bytes: bytes.length,
    sha256: sha(bytes),
    excerpt: rule,
    upstream: {
      bytes: b.length,
      rows: Number(md.num_rows),
      sha256: sha(b),
      columns: schema.length,
      created_by: md.created_by ?? null,
      codecs: [...codecs].sort(),
      encodings: [...encodings].sort(),
      nflverse_timestamp: kv(md, "nflverse_timestamp"),
    },
  });
}

const TAGS = ["schedules", "injuries", "weekly_rosters", "stats_player", "players"] as const;
const timestamps: Record<string, { path: string; url: string; text: string }> = {};
for (const tag of TAGS) {
  const text = readFileSync(join(dir, `${tag}_timestamp.txt`), "utf8");
  mkdirSync(join(OUT, tag), { recursive: true });
  writeFileSync(join(OUT, tag, "timestamp.txt"), text);
  timestamps[tag] = {
    path: `${tag}/timestamp.txt`,
    url: `${REL}/${tag}/timestamp.txt`,
    text: text.trim(),
  };
}

await excerpt(
  "schedules",
  "games.parquet",
  "nflverse:schedules",
  null,
  "schedules/games.excerpt.json.gz",
  (r) => r.season === 2025 || r.season === 2026,
  "every game of seasons 2025 and 2026; all 46 columns",
);
await excerpt(
  "injuries",
  "injuries_2026.parquet",
  "nflverse:injuries",
  2026,
  "injuries/injuries_2026.excerpt.json.gz",
  () => true,
  "every row (weeks 1-4); all 16 columns",
);
await excerpt(
  "weekly_rosters",
  "roster_weekly_2026.parquet",
  "nflverse:roster_weekly",
  2026,
  "weekly_rosters/roster_weekly_2026.excerpt.json.gz",
  (r) =>
    ids.has(r.gsis_id as string) ||
    surnames.has(r.last_name as string) ||
    r.position === "K" ||
    r.gsis_id === null ||
    r.gsis_id === "00-0031484" || // its espn_id differs in players.parquet (the precedence case)
    (r.espn_id === null &&
      r.status === "ACT" &&
      ["QB", "RB", "WR", "TE"].includes(r.position as string)),
  "every row (weeks 1-4) of the fixture-roster players and the decoy; every row sharing a same_surname last name (Allen, Love, Henry); every kicker row; the rows with a null gsis_id; the active QB/RB/WR/TE rows without an espn_id; the one player whose espn_id differs in players.parquet; all 36 columns",
);
await excerpt(
  "stats_player",
  "stats_player_week_2026.parquet",
  "nflverse:stats_player_week",
  2026,
  "stats_player/stats_player_week_2026.excerpt.json.gz",
  (r, all) => {
    if (r.player_id === null) return true; // the all-null placeholder rows (every week)
    if ((r.week as number) > 3) return false;
    if (ids.has(r.player_id as string) || r.position === "K") return true;
    // both teams' rows of every game a fixture team unit (D/ST, TQB) played in weeks 1-3
    const games = unitGames(all);
    return games.has(r.game_id as string);
  },
  "weeks 1-3: every row of both teams in the 14 games the fixture team units (PHI, DET, LA, WAS D/ST; LAC TQB) played, every fixture-roster player row, every kicker row; plus the rows with a null player_id (all weeks); all 150 columns",
);
await excerpt(
  "players",
  "players.parquet",
  "nflverse:players",
  null,
  "players/players.excerpt.json.gz",
  (r) =>
    ids.has(r.gsis_id as string) ||
    r.gsis_id === "00-0031484" ||
    ["ABB498348", "ABE498348", "ABR083058"].includes(r.gsis_id as string),
  "the fixture-roster players and the decoy, the one player whose espn_id differs from roster_weekly, and three legacy rows whose gsis_id is not a GSIS id; all 39 columns",
);

const manifest: FixtureManifest = {
  $comment:
    "nflverse fixtures (CC-BY 4.0, see ATTRIBUTION.md). Generated by tests/sources/nflverse/helpers/make-fixtures.ts from the release files downloaded on the `retrieved` date. `url` = the release asset an excerpt stands in for; tests rebuild a parquet file from each excerpt (same schema, SNAPPY) and serve it there through a fake HttpGet. `upstream.sha256` pins the exact upstream file (plan 08 §6 step 5).",
  retrieved: "2026-10-06",
  timestamps,
  default_seasons: {
    "nflverse:schedules": [2025, 2026],
    "nflverse:injuries": [2026],
    "nflverse:roster_weekly": [2026],
    "nflverse:stats_player_week": [2026],
    "nflverse:players": [2026],
  },
  files,
};
writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.error(files.map((m) => `${m.path} ${String(m.bytes)} B ${String(m.rows)} rows`).join("\n"));
