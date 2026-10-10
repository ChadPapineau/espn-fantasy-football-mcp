// excerpt.ts — the committed team-game usage excerpt behind plan 10 C6 (data/usage-<season>.tsv +
// data/manifest.json, written by ../make-usage-excerpt.ts from nflverse pbp 2023–2025): its columns,
// the TSV codec (pure: rows ↔ text) and the loader, which re-hashes every file against the manifest
// on every read so a changed excerpt fails loudly instead of moving the numbers.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  UsagePosition,
  UsageRow,
} from "../../../../../src/domain/analytics/cascade-priors/types.js";

export const DATA_DIR = new URL("../data/", import.meta.url).pathname;
/** The backtest seasons (plan 10 §3.3: ≥ 3 historical seasons [A-3]). */
export const EXCERPT_SEASONS = Object.freeze([2023, 2024, 2025] as const);
/** The TSV columns (the season is the file's, in the manifest). */
export const EXCERPT_COLUMNS = Object.freeze([
  "week",
  "team",
  "player",
  "position",
  "depth",
  "targets",
  "carries",
  "rz_targets",
  "rz_carries",
] as const);
export const EXCERPT_RULE =
  "regular-season team games of nflverse pbp: per (week, team, player) the targets (pass_attempt=1, sack=0, two_point_attempt=0, a receiver), carries (rush_attempt=1, two_point_attempt=0, a rusher) and their red-zone subsets (yardline_100 <= 20) over the store's kept play types, the player's position group (stats_player_week; else OTHER) and his rank on that week's depth chart (<= 2024 weekly charts; 2025 the last snapshot before game day 12:00 UTC); depth-listed skill players of a team-week that played get a zero row; players pseudonymised per (season, team) as p1, p2, ... in sorted-id order";
export const TABLE_PROVENANCE_NOTE =
  "built from the committed excerpt tests/domain/analytics/cascade-priors/data (nflverse pbp, stats_player_week, depth_charts, schedules; CC-BY-4.0)";

const POSITIONS = new Set<string>(["QB", "RB", "WR", "TE", "OTHER"]);

/** The manifest's shape. */
export interface UsageManifest {
  readonly schema: "cascade-usage-excerpt-v1";
  readonly rule: string;
  readonly columns: readonly string[];
  readonly licence: string;
  readonly files: readonly {
    readonly path: string;
    readonly season: number;
    readonly rows: number;
    readonly sha256: string;
  }[];
  readonly upstream: { url: string; bytes: number; sha256: string }[];
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** One season's rows → TSV text (a header line, then one line per row; unlisted depth empty). */
export function encodeUsage(rows: readonly UsageRow[]): string {
  const lines = [EXCERPT_COLUMNS.join("\t")];
  const season = rows[0]?.season;
  for (const r of rows) {
    if (r.season !== season) throw new Error("usage excerpt: one season per file");
    lines.push(
      [
        r.week,
        r.team,
        r.player,
        r.position,
        r.depth ?? "",
        r.targets,
        r.carries,
        r.rz_targets,
        r.rz_carries,
      ].join("\t"),
    );
  }
  return `${lines.join("\n")}\n`;
}

const int = (s: string | undefined, what: string): number => {
  const n = Number(s);
  if (s === undefined || s === "" || !Number.isInteger(n) || n < 0)
    throw new Error(`bad ${what}: ${String(s)}`);
  return n;
};

/** TSV text of one season → rows; throws on a wrong header or a malformed cell. */
export function decodeUsage(text: string, season: number): UsageRow[] {
  const lines = text.split("\n").filter((l) => l !== "");
  if (lines[0] !== EXCERPT_COLUMNS.join("\t")) throw new Error("usage excerpt: unexpected header");
  return lines.slice(1).map((line) => {
    const c = line.split("\t");
    if (c.length !== EXCERPT_COLUMNS.length)
      throw new Error(`usage excerpt: ${String(c.length)} cells`);
    const [week, team, player, position, depth, t, ca, rzt, rzc] = c;
    if (team === undefined || !/^[A-Z]{2,3}$/.test(team))
      throw new Error(`bad team: ${String(team)}`);
    if (player === undefined || !/^p[0-9]+$/.test(player))
      throw new Error(`bad player: ${String(player)}`);
    if (position === undefined || !POSITIONS.has(position))
      throw new Error(`bad position: ${String(position)}`);
    return {
      season,
      week: int(week, "week"),
      team,
      player,
      position: position as UsagePosition,
      depth: depth === "" ? null : int(depth, "depth"),
      targets: int(t, "targets"),
      carries: int(ca, "carries"),
      rz_targets: int(rzt, "rz_targets"),
      rz_carries: int(rzc, "rz_carries"),
    };
  });
}

/** A manifest entry for an excerpt file. */
export function manifestFileOf(
  path: string,
  season: number,
  rows: number,
  text: string,
): UsageManifest["files"][number] {
  return { path, season, rows, sha256: sha(text) };
}

/** The manifest. */
export function loadManifest(): UsageManifest {
  return JSON.parse(readFileSync(join(DATA_DIR, "manifest.json"), "utf8")) as UsageManifest;
}

/** Every season's rows, each file verified against the manifest (hash and row count). */
export function loadUsageExcerpt(): UsageRow[] {
  const m = loadManifest();
  const out: UsageRow[] = [];
  for (const f of m.files) {
    const text = readFileSync(join(DATA_DIR, f.path), "utf8");
    if (sha(text) !== f.sha256) throw new Error(`usage excerpt ${f.path}: sha256 mismatch`);
    const rows = decodeUsage(text, f.season);
    if (rows.length !== f.rows) throw new Error(`usage excerpt ${f.path}: row count mismatch`);
    out.push(...rows);
  }
  return out;
}
