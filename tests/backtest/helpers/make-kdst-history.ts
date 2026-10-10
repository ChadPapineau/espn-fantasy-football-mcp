// make-kdst-history.ts — writes tests/backtest/data/kdst_history/ (plan 10 §3.3 C7: the K/D-ST
// evaluation on history; research 05 §8.4 #8 "rank correlation versus 'lowest opponent implied
// total' and 'most points last week'", over "stats_player_week + stats_team_week for D/ST"; sib
// research 05 §8 Evaluation "weekly rank correlation and MAE … report the share of DEF variance
// explained by the rare-event constant") from nflverse release files downloaded by hand. Not a test
// and never run by CI; the download is a grounding step (no agent or test fetches).
//
//   scripts/dev/with-node.sh npx tsx tests/backtest/helpers/make-kdst-history.ts <download-dir>
//
// <download-dir> holds (the names the Phase 3 grounding used): schedules_games.parquet,
// stats_player_stats_player_week_<s>.parquet, stats_team_stats_team_week_<s>.parquet and
// pbp_play_by_play_<s>.parquet for s = 2023, 2024, 2025, plus the release `*_timestamp.txt` files.
//
// Every derived number comes from the product's own code over the upstream rows, so the replay
// scores exactly what the store would hold: the D/ST week is `TeamDefenseAggregator` over every
// stats_player_week row (src/sources/nflverse/team-defense.ts — the `ds_team_defense_week`
// derivation), points allowed are `pointsAllowedFromTeamWeek` (plan 08 §3.2 U-6, 70/70 against
// ESPN) from the opponent's stats_team_week row, the final score and that game's pbp plays, and the
// special-teams TD split is `returnTdKind` (src/store/datasets/derive.ts) plus the blocked-kick
// returns. Only public NFL data; no fantasy league data.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import { pointsAllowedFromTeamWeek } from "../../../src/domain/scoring/nflverse.js";
import { TeamDefenseAggregator } from "../../../src/sources/nflverse/team-defense.js";
import { returnTdKind } from "../../../src/store/datasets/derive.js";
import { encodeTsv } from "../../sources/nflverse/helpers/tsv.js";
import {
  DST_COLUMNS,
  GAME_COLUMNS,
  K_COLUMNS,
  KDST_HISTORY_DIR,
  KDST_HISTORY_FINAL_WEEK,
  KDST_HISTORY_SEASONS,
  type KdstHistoryManifest,
} from "./kdst-history.js";

type Raw = Record<string, unknown>;

const src = process.argv[2];
if (src === undefined) throw new Error("usage: make-kdst-history.ts <download-dir>");
const dir: string = src;
const REL = "https://github.com/nflverse/nflverse-data/releases/download";

const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const num = (v: unknown): number | null =>
  typeof v === "bigint" ? Number(v) : typeof v === "number" && Number.isFinite(v) ? v : null;
const txt = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

interface Upstream {
  readonly file: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly rows: number;
  readonly nflverse_timestamp: string | null;
}
const upstream: Upstream[] = [];

async function read(file: string, url: string, tag: string, columns?: string[]): Promise<Raw[]> {
  const b = readFileSync(join(dir, file));
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const md = parquetMetadata(ab);
  const rows = (await parquetReadObjects({
    file: ab,
    ...(columns === undefined ? {} : { columns }),
  })) as Raw[];
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

// --- games: every regular-season game of weeks 1..FINAL with its line and final score -------------
const games = (
  await read("schedules_games.parquet", `${REL}/schedules/games.parquet`, "schedules", [
    ...GAME_COLUMNS,
    "game_type",
  ])
).filter(
  (g) =>
    g.game_type === "REG" &&
    (KDST_HISTORY_SEASONS as readonly number[]).includes(num(g.season) ?? -1) &&
    (num(g.week) ?? 99) <= KDST_HISTORY_FINAL_WEEK,
);
games.sort(
  (a, b) =>
    (num(a.season) ?? 0) - (num(b.season) ?? 0) ||
    (num(a.week) ?? 0) - (num(b.week) ?? 0) ||
    String(a.game_id).localeCompare(String(b.game_id)),
);
const gameRows = games.map((g) =>
  GAME_COLUMNS.map((c) => (c === "espn" ? txt(g[c]) : (num(g[c]) ?? txt(g[c])))),
);
const gameById = new Map(games.map((g) => [String(g.game_id), g]));

const dstRows: unknown[][] = [];
const kRows: unknown[][] = [];
const notes: string[] = [];

for (const season of KDST_HISTORY_SEASONS) {
  const s = String(season);
  const players = await read(
    `stats_player_stats_player_week_${s}.parquet`,
    `${REL}/stats_player/stats_player_week_${s}.parquet`,
    "stats_player",
  );
  const teams = await read(
    `stats_team_stats_team_week_${s}.parquet`,
    `${REL}/stats_team/stats_team_week_${s}.parquet`,
    "stats_team",
  );
  const plays = await read(
    `pbp_play_by_play_${s}.parquet`,
    `${REL}/pbp/play_by_play_${s}.parquet`,
    "pbp",
    [
      "game_id",
      "season_type",
      "week",
      "posteam",
      "defteam",
      "td_team",
      "td_player_id",
      "touchdown",
      "return_touchdown",
      "interception",
      "safety",
      "play_type",
      "punt_blocked",
      "field_goal_result",
      "kickoff_returner_player_id",
      "punt_returner_player_id",
    ],
  );

  // the D/ST week, exactly as the store derives it (team-level rows add defence credits only)
  const agg = new TeamDefenseAggregator();
  for (const r of players) {
    const w = num(r.week);
    const team = txt(r.team);
    if (num(r.season) !== season || w === null || team === null) continue;
    if (txt(r.player_id) === null) agg.addTeamRow(season, w, team, r);
    else agg.add(season, w, team, r);
  }
  const teamWeek = new Map<string, Raw>();
  for (const t of teams) teamWeek.set(`${String(num(t.week))}|${String(txt(t.team))}`, t);
  const playsByGame = new Map<string, Raw[]>();
  for (const p of plays) {
    const g = String(p.game_id);
    const list = playsByGame.get(g) ?? [];
    list.push(p);
    playsByGame.set(g, list);
  }

  for (const row of agg.rows()) {
    const week = row.week as number;
    if (row.season_type !== "REG" || week > KDST_HISTORY_FINAL_WEEK) continue;
    const team = row.team as string;
    const gameId = row.game_id as string | null;
    const g = gameId === null ? undefined : gameById.get(gameId);
    if (g === undefined) {
      notes.push(`${s} wk ${String(week)} ${team}: no REG game in the schedule (row skipped)`);
      continue;
    }
    const home = g.home_team === team;
    const opp = String(home ? g.away_team : g.home_team);
    const oppScore = num(home ? g.away_score : g.home_score);
    const oppRow = teamWeek.get(`${String(week)}|${opp}`);
    const gamePlays = playsByGame.get(gameId ?? "") ?? [];
    const pa = oppRow === undefined ? null : pointsAllowedFromTeamWeek(oppRow, oppScore, gamePlays);
    // special-teams TDs this team scored in the game, by kind
    let kr = 0;
    let pr = 0;
    let blk = 0;
    let other = 0;
    for (const p of gamePlays) {
      if (txt(p.td_team) !== team || num(p.touchdown) !== 1) continue;
      const type = txt(p.play_type);
      if (type !== "kickoff" && type !== "punt" && type !== "field_goal" && type !== "extra_point")
        continue;
      const kind = returnTdKind({
        return_touchdown: num(p.return_touchdown),
        td_player_id: txt(p.td_player_id),
        play_type: type,
        kickoff_returner_player_id: txt(p.kickoff_returner_player_id),
        punt_returner_player_id: txt(p.punt_returner_player_id),
      });
      if (kind === "kr") kr++;
      else if (kind === "pr") pr++;
      else if (
        (type === "punt" && num(p.punt_blocked) === 1) ||
        (type === "field_goal" && p.field_goal_result === "blocked")
      )
        blk++;
      else other++;
    }
    const stTds = row.special_teams_tds as number;
    if (kr + pr + blk + other !== stTds)
      notes.push(
        `${s} wk ${String(week)} ${team}: pbp special-teams TDs ${String(kr + pr + blk + other)} vs stats ${String(stTds)}`,
      );
    const values: Record<string, unknown> = {
      ...row,
      opponent_team: opp,
      home: home ? 1 : 0,
      opp_score: pa?.score ?? null,
      opp_int_tds: pa?.opponent_int_tds ?? null,
      opp_fumble_tds: pa?.opponent_fumble_tds ?? null,
      opp_safeties: pa?.opponent_safeties ?? null,
      st_kr_td: kr,
      st_pr_td: pr,
      st_blk_td: blk,
      st_other_td: other,
    };
    dstRows.push(DST_COLUMNS.map((c) => values[c] ?? null));
  }

  // kickers: every position-K row of a regular-season week (a team may use two)
  for (const r of players) {
    const w = num(r.week);
    if (r.position !== "K" || r.season_type !== "REG" || w === null) continue;
    if (w > KDST_HISTORY_FINAL_WEEK || txt(r.player_id) === null) continue;
    kRows.push(K_COLUMNS.map((c) => (typeof r[c] === "string" ? r[c] : num(r[c]))));
  }
}

const out = KDST_HISTORY_DIR;
mkdirSync(out, { recursive: true });
const files: KdstHistoryManifest["files"][number][] = [];
for (const [name, columns, rows] of [
  ["games.tsv", GAME_COLUMNS, gameRows],
  ["dst.tsv", DST_COLUMNS, dstRows],
  ["k.tsv", K_COLUMNS, kRows],
] as const) {
  const text = encodeTsv(
    columns.map((c) => ({ name: c })),
    rows,
  );
  writeFileSync(join(out, name), text);
  files.push({ path: name, rows: rows.length, bytes: Buffer.byteLength(text), sha256: sha(text) });
}
const manifest: KdstHistoryManifest = {
  $comment:
    "nflverse data (CC-BY 4.0, see README.md) derived for plan 10 §3.3 C7 by tests/backtest/helpers/make-kdst-history.ts; read by tests/backtest/helpers/kdst-history.ts, which re-hashes every file. `upstream` pins every release file it was cut from.",
  retrieved: "2026-10-10",
  seasons: [...KDST_HISTORY_SEASONS],
  final_week: KDST_HISTORY_FINAL_WEEK,
  files,
  upstream: upstream.map((u) => ({ ...u })),
  notes,
};
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.error(files.map((f) => `${f.path} ${String(f.rows)} rows ${String(f.bytes)} B`).join("\n"));
console.error(`${String(notes.length)} notes`);
for (const n of notes.slice(0, 40)) console.error(n);
