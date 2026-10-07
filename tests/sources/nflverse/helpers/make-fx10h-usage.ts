// make-fx10h-usage.ts — regenerates fixtures/fx10h-usage/** (plan 10 B2: `espn_get_player_usage`
// returns trailing summaries for ≥ 95 % of rostered players ON THE FIXTURE LEAGUE): the usage rows of
// every fx-10h rostered QB/RB/WR/TE/K that the shared excerpts (fixtures/nflverse/**, fixtures/
// ffopportunity/**, cut around the 24 fixture-roster players) do not already carry, from the real
// release files downloaded by hand. The seed (tests/integration/helpers/seed.ts) serves each shared
// excerpt UNION its supplement at the release URL, so the fixture league the e2e suites, the plugin
// evals and `eff`'s fixture mode see has the usage a live league's refresh would load; every other
// test keeps reading the shared excerpts unchanged. Not a test and never run by CI; reads local files
// only (no network). Same text format as the shared excerpts (a JSON header — the SHARED excerpt's
// schema, so the union is one table — and TSV parts of JSON cells, ≤ 240 KB each).
//
//   scripts/dev/with-node.sh npx tsx tests/sources/nflverse/helpers/make-fx10h-usage.ts <dir>
//
// <dir> holds roster_weekly_2026.parquet, stats_player_week_2026.parquet, snap_counts_2026.parquet
// (nflverse) and ep_weekly_2026.parquet (ffverse/ffopportunity `latest-data`). Rows mirror each
// shared excerpt's week range (roster weeks 1–4; stats, snaps and expected points weeks 1–3, REG).
// D/ST has no player row in any of them (D1: "no usage model for D/ST"). Run prettier on the JSON
// afterwards, then review the diff (the secret scanner runs at commit).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import type { FileMetaData } from "hyparquet";
import { fixtureRows, loadFixture, REL, tsvRow, encodeTsv, type Row } from "./fixtures.js";
import { FFO_REL, p2Fixture } from "./phase2-fixtures.js";
import { FX10H_USAGE_DIR, FX10H_USAGE_POSITIONS, type SupplementSpec } from "./fx10h-usage.js";

const ROOT = new URL("../../../../", import.meta.url).pathname;
const MAX_PART_BYTES = 240 * 1024;
const RETRIEVED = "2026-10-06";

const srcArg = process.argv[2];
if (srcArg === undefined) throw new Error("usage: make-fx10h-usage.ts <download-dir>");
const SRC: string = srcArg;

const toAb = (b: Buffer): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const kv = (md: FileMetaData, key: string): string | null =>
  md.key_value_metadata?.find((k) => k.key === key)?.value ?? null;

function jsonValue(v: unknown, column: string): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`${column}: non-finite number cannot be JSON`);
    return v;
  }
  if (typeof v === "string" || typeof v === "boolean") return v;
  // a DATE column, as the shared excerpts commit it (make-fixtures.ts)
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  throw new Error(`${column}: unsupported value ${typeof v}`);
}

// --- the fixture league's rostered players -----------------------------------------------------------

interface WireEntry {
  readonly playerPoolEntry: { readonly player: { id: number; defaultPositionId: number } };
}
const FX_LEAGUE = join(ROOT, "fixtures/espn/fx-10h/league");
const rostered = new Set<number>();
for (const f of readdirSync(FX_LEAGUE).filter((x) => /^mRoster\.sp\d+\.json$/.test(x))) {
  const body = JSON.parse(readFileSync(join(FX_LEAGUE, f), "utf8")) as {
    teams: { roster: { entries: WireEntry[] } }[];
  };
  for (const t of body.teams)
    for (const e of t.roster.entries) {
      const p = e.playerPoolEntry.player;
      if (FX10H_USAGE_POSITIONS.includes(p.defaultPositionId)) rostered.add(p.id);
    }
}

async function readAll(local: string): Promise<{ rows: Row[]; md: FileMetaData; bytes: Buffer }> {
  const bytes = readFileSync(join(SRC, local));
  const md = parquetMetadata(toAb(bytes));
  const rows = (await parquetReadObjects({ file: toAb(bytes) })) as Row[];
  return { rows, md, bytes };
}

// espn_id → gsis_id / pfr_id from the full weekly rosters (research 04 §C: the crosswalk's lookup)
const rosterFull = await readAll("roster_weekly_2026.parquet");
const gsisOf = new Map<number, string>();
const pfrOf = new Map<string, string>();
for (const r of rosterFull.rows) {
  const espn = Number(r.espn_id);
  if (!Number.isInteger(espn) || typeof r.gsis_id !== "string") continue;
  if (rostered.has(espn)) gsisOf.set(espn, r.gsis_id);
  if (typeof r.pfr_id === "string" && r.pfr_id !== "") pfrOf.set(r.gsis_id, r.pfr_id);
}
const GSIS = new Set(gsisOf.values());
const PFR = new Set([...GSIS].flatMap((g) => (pfrOf.has(g) ? [pfrOf.get(g) ?? ""] : [])));

// --- one supplement ----------------------------------------------------------------------------------

interface Cut {
  readonly spec: SupplementSpec;
  readonly local: string;
  /** The shared excerpt's rows (what the supplement must not repeat). */
  readonly base: readonly Row[];
  readonly baseSchema: readonly { name: string }[];
  readonly baseKeyValue: Readonly<Record<string, string>>;
  readonly keep: (r: Row) => boolean;
  readonly key: (r: Row) => string;
  readonly excerpt: string;
  readonly licence: string;
}

async function cut(c: Cut) {
  const { rows: all, md, bytes } = await readAll(c.local);
  const upstreamNames = new Set(md.schema.slice(1).map((e) => e.name));
  for (const col of c.baseSchema)
    if (!upstreamNames.has(col.name)) throw new Error(`${c.local}: no column ${col.name}`);
  const seen = new Set(c.base.map(c.key));
  const picked: Row[] = [];
  for (const r of all) {
    if (!c.keep(r)) continue;
    const k = c.key(r);
    if (seen.has(k)) continue;
    seen.add(k);
    picked.push(r);
  }
  picked.sort((a, b) => (c.key(a) < c.key(b) ? -1 : c.key(a) > c.key(b) ? 1 : 0));
  const values = picked.map((r) => c.baseSchema.map((col) => jsonValue(r[col.name], col.name)));
  const stem = c.spec.path.replace(/\.json$/, "");
  const parts: { path: string; rows: number; bytes: number; sha256: string }[] = [];
  let chunk: unknown[][] = [];
  let size = 0;
  const flush = (): void => {
    if (chunk.length === 0) return;
    const rel = `${stem}.${String(parts.length + 1)}.tsv`;
    const buf = Buffer.from(encodeTsv(c.baseSchema, chunk), "utf8");
    mkdirSync(dirname(join(FX10H_USAGE_DIR, rel)), { recursive: true });
    writeFileSync(join(FX10H_USAGE_DIR, rel), buf);
    parts.push({ path: rel, rows: chunk.length, bytes: buf.length, sha256: sha(buf) });
    chunk = [];
    size = 0;
  };
  const headerBytes = Buffer.byteLength(`${c.baseSchema.map((x) => x.name).join("\t")}\n`);
  for (const v of values) {
    const line = Buffer.byteLength(`${tsvRow(v)}\n`);
    if (size + line + headerBytes > MAX_PART_BYTES) flush();
    chunk.push(v);
    size += line;
  }
  flush();
  const header = {
    $comment: `${c.licence} Supplement to ${c.spec.url} (${c.excerpt}); generated by tests/sources/nflverse/helpers/make-fx10h-usage.ts on ${RETRIEVED}. The schema and key-value stamps are the shared excerpt's (${c.spec.base}), so the seed serves the union as one file. Rows are in the .tsv part(s) beside this file: a header line of column names, then one row per line, one JSON literal per cell.`,
    schema: c.baseSchema,
    key_value: c.baseKeyValue,
    rows: picked.length,
    parts: parts.map((p) => p.path.split("/").pop()),
  };
  writeFileSync(join(FX10H_USAGE_DIR, c.spec.path), `${JSON.stringify(header, null, 2)}\n`);
  return {
    path: c.spec.path,
    url: c.spec.url,
    base: c.spec.base,
    dataset: c.spec.dataset,
    season: 2026,
    rows: picked.length,
    parts,
    excerpt: c.excerpt,
    upstream: {
      bytes: bytes.length,
      rows: Number(md.num_rows),
      sha256: sha(bytes),
      nflverse_timestamp: kv(md, "nflverse_timestamp"),
    },
  };
}

const NFLVERSE = "nflverse data, (c) the nflverse contributors, CC-BY 4.0 (see ATTRIBUTION.md).";
const FFO =
  "ffopportunity data, (c) the ffverse contributors, CC-BY-SA 4.0 — shared under the same licence (see ATTRIBUTION.md).";
const week = (r: Row): number => Number(r.week);
const rosterBase = loadFixture("weekly_rosters/roster_weekly_2026.excerpt.json");
const statsBase = loadFixture("stats_player/stats_player_week_2026.excerpt.json");
const snaps = p2Fixture("nflverse:snap_counts@2026");
const ep = p2Fixture("ffopportunity:ep_weekly@2026");

const written = [
  await cut({
    spec: {
      path: "weekly_rosters/roster_weekly_2026.supplement.json",
      url: `${REL}/weekly_rosters/roster_weekly_2026.parquet`,
      base: "fixtures/nflverse/weekly_rosters/roster_weekly_2026.excerpt.json",
      dataset: "nflverse:roster_weekly",
    },
    local: "roster_weekly_2026.parquet",
    base: fixtureRows("weekly_rosters/roster_weekly_2026.excerpt.json"),
    baseSchema: rosterBase.schema,
    baseKeyValue: rosterBase.key_value,
    keep: (r) => typeof r.gsis_id === "string" && GSIS.has(r.gsis_id) && week(r) <= 4,
    key: (r) => `${String(r.gsis_id)}|${String(r.week)}`,
    excerpt:
      "weeks 1–4: every row of the fx-10h rostered QB/RB/WR/TE/K the shared excerpt lacks (by espn_id → gsis_id); all 36 columns",
    licence: NFLVERSE,
  }),
  await cut({
    spec: {
      path: "stats_player/stats_player_week_2026.supplement.json",
      url: `${REL}/stats_player/stats_player_week_2026.parquet`,
      base: "fixtures/nflverse/stats_player/stats_player_week_2026.excerpt.json",
      dataset: "nflverse:stats_player_week",
    },
    local: "stats_player_week_2026.parquet",
    base: fixtureRows("stats_player/stats_player_week_2026.excerpt.json"),
    baseSchema: statsBase.schema,
    baseKeyValue: statsBase.key_value,
    keep: (r) =>
      typeof r.player_id === "string" &&
      GSIS.has(r.player_id) &&
      r.season_type === "REG" &&
      week(r) <= 3,
    key: (r) => `${String(r.player_id)}|${String(r.week)}|${String(r.season_type)}`,
    excerpt:
      "weeks 1–3 (REG): every row of the fx-10h rostered QB/RB/WR/TE/K the shared excerpt lacks; all 150 columns",
    licence: NFLVERSE,
  }),
  await cut({
    spec: {
      path: "snap_counts/snap_counts_2026.supplement.json",
      url: `${REL}/snap_counts/snap_counts_2026.parquet`,
      base: "fixtures/nflverse/phase2/snap_counts/snap_counts_2026.excerpt.json",
      dataset: "nflverse:snap_counts",
    },
    local: "snap_counts_2026.parquet",
    base: snaps.objects,
    baseSchema: snaps.schema,
    baseKeyValue: snaps.key_value,
    keep: (r) => typeof r.pfr_player_id === "string" && PFR.has(r.pfr_player_id) && week(r) <= 3,
    key: (r) => `${String(r.game_id)}|${String(r.pfr_player_id)}`,
    excerpt:
      "weeks 1–3: every row of the fx-10h rostered QB/RB/WR/TE/K the shared excerpt lacks (by pfr_id); all 16 columns",
    licence: NFLVERSE,
  }),
  await cut({
    spec: {
      path: "ep_weekly/ep_weekly_2026.supplement.json",
      url: `${FFO_REL}/latest-data/ep_weekly_2026.parquet`,
      base: "fixtures/ffopportunity/ep_weekly/ep_weekly_2026.excerpt.json",
      dataset: "ffopportunity:ep_weekly",
    },
    local: "ep_weekly_2026.parquet",
    base: ep.objects,
    baseSchema: ep.schema,
    baseKeyValue: ep.key_value,
    keep: (r) => typeof r.player_id === "string" && GSIS.has(r.player_id) && week(r) <= 3,
    key: (r) => `${String(r.player_id)}|${String(r.week)}`,
    excerpt:
      "weeks 1–3: every row of the fx-10h rostered QB/RB/WR/TE/K the shared excerpt lacks; all 159 columns",
    licence: FFO,
  }),
];

const manifest = {
  $comment:
    "Usage supplements for the fx-10h fixture league (plan 10 B2). Generated by tests/sources/nflverse/helpers/make-fx10h-usage.ts from the release files downloaded on the `retrieved` date; `url` = the release asset a supplement adds rows to, `base` = the shared excerpt it extends (its schema), `upstream.sha256` = the exact file the rows were cut from. The seed serves base ∪ supplement there; nothing else reads these files.",
  retrieved: RETRIEVED,
  rostered_players: rostered.size,
  resolved_gsis: GSIS.size,
  files: written,
};
writeFileSync(join(FX10H_USAGE_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(
  `fx10h-usage: ${String(rostered.size)} rostered QB/RB/WR/TE/K, ${String(GSIS.size)} resolved; ${written
    .map((w) => `${w.path} ${String(w.rows)} rows`)
    .join("; ")}\n`,
);
