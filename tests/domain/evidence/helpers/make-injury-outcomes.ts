// make-injury-outcomes.ts — writes tests/domain/evidence/data/injury_outcomes/ (plan 10 §3.3 C8:
// "news-augmented P(active) Brier ≤ designation-only" on whatever labelled history exists; sib
// research 05 §10 Evaluation "whether merging news improves P(active) Brier over designation-only")
// from nflverse release files downloaded by hand. Not a test and never run by CI; the download is a
// grounding step (no agent or test fetches).
//
//   scripts/dev/with-node.sh npx tsx tests/domain/evidence/helpers/make-injury-outcomes.ts <dir>
//
// <dir> holds injuries_injuries_<s>.parquet and snap_counts_snap_counts_<s>.parquet for s = 2023,
// 2024, 2025 (the names the Phase 3 grounding used) and the release `*_timestamp.txt` files.
//
// The labelled history: every regular-season row of the official injury report (the game status
// — Questionable / Doubtful / Out / none — and the week's practice participation) joined to whether
// the player took a snap in that week's game (nflverse snap counts, by team, week and the
// crosswalk's `nameKey`). A row whose player never appears in his team's snap counts that season
// cannot be labelled and is dropped (counted in the manifest). Aggregated to counts per season,
// week, position bucket, status, practice label and outcome — no player identity is committed.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import { nameKey } from "../../../../src/domain/crosswalk/normalize.js";
import { encodeTsv } from "../../../sources/nflverse/helpers/tsv.js";
import {
  INJURY_OUTCOME_COLUMNS,
  INJURY_OUTCOMES_DIR,
  INJURY_OUTCOME_SEASONS,
  positionBucket,
  type InjuryOutcomesManifest,
} from "./injury-outcomes.js";

type Raw = Record<string, unknown>;
const src = process.argv[2];
if (src === undefined) throw new Error("usage: make-injury-outcomes.ts <download-dir>");
const dir: string = src;
const REL = "https://github.com/nflverse/nflverse-data/releases/download";
const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const num = (v: unknown): number | null =>
  typeof v === "bigint" ? Number(v) : typeof v === "number" && Number.isFinite(v) ? v : null;
const label = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t === "" ? null : t;
};

const upstream: InjuryOutcomesManifest["upstream"][number][] = [];
async function read(file: string, url: string, tag: string): Promise<Raw[]> {
  const b = readFileSync(join(dir, file));
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const md = parquetMetadata(ab);
  const rows = (await parquetReadObjects({ file: ab })) as Raw[];
  let ts: string | null = null;
  try {
    ts = readFileSync(join(dir, `${tag}_timestamp.txt`), "utf8").trim();
  } catch {
    ts = null;
  }
  upstream.push({
    file,
    url,
    bytes: b.byteLength,
    sha256: sha(b),
    rows: Number(md.num_rows),
    nflverse_timestamp: ts,
  });
  return rows;
}

const counts = new Map<string, number>();
const perSeason: InjuryOutcomesManifest["seasons"][number][] = [];
for (const season of INJURY_OUTCOME_SEASONS) {
  const s = String(season);
  const inj = await read(
    `injuries_injuries_${s}.parquet`,
    `${REL}/injuries/injuries_${s}.parquet`,
    "injuries",
  );
  const snaps = await read(
    `snap_counts_snap_counts_${s}.parquet`,
    `${REL}/snap_counts/snap_counts_${s}.parquet`,
    "snap_counts",
  );
  const played = new Set<string>();
  const known = new Set<string>();
  const gameWeeks = new Set<string>();
  for (const r of snaps) {
    if (r.game_type !== "REG") continue;
    const k = nameKey(r.player);
    const team = label(r.team);
    const week = num(r.week);
    if (k === null || team === null || week === null) continue;
    gameWeeks.add(`${String(week)}|${team}`);
    known.add(`${team}|${k}`);
    const total =
      (num(r.offense_snaps) ?? 0) + (num(r.defense_snaps) ?? 0) + (num(r.st_snaps) ?? 0);
    if (total > 0) played.add(`${String(week)}|${team}|${k}`);
  }
  let rows = 0;
  let kept = 0;
  let unlabelled = 0;
  let noGame = 0;
  for (const r of inj) {
    // 2023's file has game_type on every row; a missing value is read as the regular season
    if (r.game_type !== "REG" && r.game_type !== null && r.game_type !== undefined) continue;
    rows++;
    const week = num(r.week);
    const team = label(r.team);
    const k = nameKey(r.full_name);
    if (week === null || team === null || k === null) {
      unlabelled++;
      continue;
    }
    if (!gameWeeks.has(`${String(week)}|${team}`)) {
      noGame++;
      continue;
    }
    if (!known.has(`${team}|${k}`)) {
      unlabelled++;
      continue;
    }
    kept++;
    const cells = [
      season,
      week,
      positionBucket(label(r.position)),
      label(r.report_status),
      label(r.practice_status),
      played.has(`${String(week)}|${team}|${k}`) ? 1 : 0,
    ];
    const key = JSON.stringify(cells);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  perSeason.push({ season, report_rows: rows, labelled: kept, unlabelled, no_game: noGame });
}

const out: unknown[][] = [...counts]
  .map(([k, v]) => [...(JSON.parse(k) as unknown[]), v])
  .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const text = encodeTsv(
  INJURY_OUTCOME_COLUMNS.map((c) => ({ name: c })),
  out,
);
mkdirSync(INJURY_OUTCOMES_DIR, { recursive: true });
writeFileSync(join(INJURY_OUTCOMES_DIR, "outcomes.tsv"), text);
const manifest: InjuryOutcomesManifest = {
  $comment:
    "nflverse data (CC-BY 4.0, see README.md) aggregated for plan 10 §3.3 C8 by tests/domain/evidence/helpers/make-injury-outcomes.ts; read by tests/domain/evidence/helpers/injury-outcomes.ts, which re-hashes the file. `upstream` pins every release file it was cut from.",
  retrieved: "2026-10-10",
  outcome:
    "played = took at least one offensive, defensive or special-teams snap in that week's game",
  file: {
    path: "outcomes.tsv",
    rows: out.length,
    bytes: Buffer.byteLength(text),
    sha256: sha(text),
  },
  seasons: perSeason,
  upstream,
};
writeFileSync(join(INJURY_OUTCOMES_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.error(`outcomes.tsv ${String(out.length)} cells ${String(Buffer.byteLength(text))} B`);
console.error(JSON.stringify(perSeason));
