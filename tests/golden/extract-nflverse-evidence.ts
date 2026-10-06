// extract-nflverse-evidence.ts — the one-off extraction of fixtures/golden/nflverse-phase2-evidence.json
// (plan 10 B13: the D/ST points-allowed derivation pinned, the long-TD families' pbp derivation;
// plan 08 §3.2 U-6, §4.3). Run by hand on LOCAL copies of the nflverse release files — it never
// fetches; tests never run it:
//
//   scripts/dev/with-node.sh npx tsx tests/golden/extract-nflverse-evidence.ts \
//     games=<games.parquet>@"<nflverse timestamp>" pbp=<play_by_play_2026.parquet>@"<ts>" \
//     team_week=<stats_team_week_2026.parquet>@"<ts>" rosters=<roster_weekly_2026.parquet>@"<ts>"
//
// What it keeps (values unchanged, rows and columns selected): for every D/ST week of the recorded
// box scores, the game, both teams, the opponent's final score and the opponent's stats_team_week
// counts points/yards allowed read; every pbp play of 2026 weeks 1–3 with touchdown = 1 or
// safety = 1 (a no_play row included — ds_pbp's filter would drop it) plus the try after each TD
// the team without the ball scored (td_team ≠ posteam: defensive and punt-return TDs), in ds_pbp
// column names; and the espn_id → gsis_id pair of every recorded QB/RB/WR/TE (roster_weekly). The
// ESPN side is read through the golden path guard. Nothing imports this file (it runs on load).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import type { Json } from "../../scripts/espn-fixture/canonical.js";
import { formatJson } from "../../scripts/espn-fixture/format-json.js";
import { finalWeeks, LEAGUES, readRecorded, recordedTeamWeeks, ROOT } from "./recorded.js";

const EVIDENCE_PATH = path.join(ROOT, "fixtures/golden/nflverse-phase2-evidence.json");

const RELEASES = "https://github.com/nflverse/nflverse-data/releases/download";
const URLS = {
  games: `${RELEASES}/schedules/games.parquet`,
  pbp: `${RELEASES}/pbp/play_by_play_2026.parquet`,
  team_week: `${RELEASES}/stats_team/stats_team_week_2026.parquet`,
  rosters: `${RELEASES}/weekly_rosters/roster_weekly_2026.parquet`,
} as const;
type SourceKey = keyof typeof URLS;

/** The ds_pbp columns kept for each play (src/store/datasets/tables.ts DS_PBP names). */
const PLAY_COLUMNS = [
  "week",
  "game_id",
  "play_id",
  "play_type",
  "posteam",
  "defteam",
  "yards_gained",
  "touchdown",
  "pass_touchdown",
  "rush_touchdown",
  "return_touchdown",
  "interception",
  "safety",
  "two_point_attempt",
  "td_team",
  "td_player_id",
  "passer_player_id",
  "extra_point_result",
  "two_point_conv_result",
] as const;

/** The opponent's stats_team_week columns kept (ds_stats_team_week names). */
const TEAM_WEEK_COLUMNS = [
  "team",
  "def_tds",
  "fumble_recovery_tds",
  "fumble_recovery_opp",
  "fumble_recovery_own",
  "def_safeties",
  "special_teams_tds",
  "passing_yards",
  "rushing_yards",
  "sack_yards_lost",
] as const;

type Row = Record<string, unknown>;

async function readParquet(file: string, columns: readonly string[]): Promise<Row[]> {
  const b = readFileSync(file);
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
  const rows = await parquetReadObjects({
    file: buf,
    metadata: parquetMetadata(buf),
    columns: [...columns],
  });
  return rows.map((r) =>
    Object.fromEntries(
      Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : (v ?? null)]),
    ),
  );
}

function args(): Record<SourceKey, { file: string; ts: string }> {
  const out: Partial<Record<SourceKey, { file: string; ts: string }>> = {};
  for (const a of process.argv.slice(2)) {
    const m = /^(games|pbp|team_week|rosters)=(.+)@(.+)$/.exec(a);
    if (m === null) throw new Error(`bad argument: ${a}`);
    out[m[1] as SourceKey] = { file: m[2]!, ts: m[3]! };
  }
  for (const k of Object.keys(URLS) as SourceKey[]) {
    if (out[k] === undefined) throw new Error(`missing ${k}=<file>@<timestamp>`);
  }
  return out as Record<SourceKey, { file: string; ts: string }>;
}

async function main(): Promise<void> {
  const src = args();
  const sources = (Object.keys(URLS) as SourceKey[]).map((k) => {
    const bytes = readFileSync(src[k].file);
    return {
      url: URLS[k],
      nflverse_timestamp: src[k].ts,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });

  // ESPN side (recorded, through the path guard): the D/ST weeks and the offensive players.
  const dst = new Map<string, { espn_id: number; week: number }>();
  const offence = new Set<number>();
  for (const league of LEAGUES) {
    for (const week of finalWeeks(league)) {
      for (const team of recordedTeamWeeks(league, week)) {
        for (const p of team.players) {
          if (p.actual === undefined) continue;
          if (p.position === 16)
            dst.set(`${String(p.player_id)}:${String(week)}`, { espn_id: p.player_id, week });
          if ([1, 2, 3, 4].includes(p.position)) offence.add(p.player_id);
        }
      }
    }
  }
  const sched = readRecorded("season/proTeamSchedules_wl.json") as unknown as {
    settings: {
      proTeams: {
        id: number;
        proGamesByScoringPeriod: Record<string, { id: number; homeProTeamId: number }[]>;
      }[];
    };
  };
  const proTeams = new Map(sched.settings.proTeams.map((t) => [t.id, t]));

  const games = (
    await readParquet(src.games.file, [
      "game_id",
      "season",
      "week",
      "home_team",
      "away_team",
      "home_score",
      "away_score",
      "espn",
    ])
  ).filter((g) => g.season === 2026 && Number(g.week) <= 3);
  const byEspn = new Map(games.map((g) => [String(g.espn), g]));
  const teamWeek = await readParquet(src.team_week.file, ["week", ...TEAM_WEEK_COLUMNS]);

  const units = [...dst.values()]
    .sort((a, b) => a.week - b.week || b.espn_id - a.espn_id)
    .map((u) => {
      const pro = -u.espn_id - 16000;
      const game = proTeams.get(pro)?.proGamesByScoringPeriod[String(u.week)]?.[0];
      if (game === undefined) throw new Error(`no pro game for D/ST ${String(u.espn_id)}`);
      const g = byEspn.get(String(game.id));
      if (g === undefined) throw new Error(`no nflverse game for ESPN game ${String(game.id)}`);
      const home = game.homeProTeamId === pro;
      const team = String(home ? g.home_team : g.away_team);
      const opponent = String(home ? g.away_team : g.home_team);
      const row = teamWeek.find((r) => r.week === u.week && r.team === opponent);
      if (row === undefined) throw new Error(`no team-week row for ${opponent}`);
      return {
        espn_id: u.espn_id,
        week: u.week,
        game_id: String(g.game_id),
        team,
        opponent,
        opponent_score: Number(home ? g.away_score : g.home_score),
        opponent_team_week: Object.fromEntries(TEAM_WEEK_COLUMNS.map((c) => [c, row[c] ?? null])),
      };
    });

  const pbp = (await readParquet(src.pbp.file, PLAY_COLUMNS)).filter((p) => Number(p.week) <= 3);
  const kept: Row[] = [];
  let afterDefensiveTd = false;
  let lastGame: unknown = null;
  for (const p of pbp) {
    if (p.game_id !== lastGame) [afterDefensiveTd, lastGame] = [false, p.game_id];
    const score = p.touchdown === 1 || p.safety === 1;
    const isTry = p.play_type === "extra_point" || p.two_point_attempt === 1;
    if (score || (afterDefensiveTd && isTry)) {
      kept.push(Object.fromEntries(PLAY_COLUMNS.map((c) => [c, p[c] ?? null])));
    }
    if (isTry) afterDefensiveTd = false;
    if (p.touchdown === 1) afterDefensiveTd = p.td_team !== null && p.td_team !== p.posteam;
  }

  const rosters = await readParquet(src.rosters.file, ["espn_id", "gsis_id"]);
  const pairs = new Map<number, string>();
  for (const r of rosters) {
    const e = Number(r.espn_id);
    if (offence.has(e) && typeof r.gsis_id === "string") pairs.set(e, r.gsis_id);
  }
  const missing = [...offence].filter((e) => !pairs.has(e));
  if (missing.length > 0)
    throw new Error(`${String(missing.length)} recorded players have no gsis id`);

  const out = {
    $comment:
      "nflverse evidence for plan 10 B13 (plan 08 §3.2 U-6, §4.3): per recorded D/ST week the game, the opponent's final score and the opponent's stats_team_week counts; every 2026 week 1-3 pbp play with touchdown = 1 or safety = 1 (no_play included) and the try after each TD the team without the ball scored, in ds_pbp column names; the espn_id -> gsis_id pair of every recorded QB/RB/WR/TE. nflverse data, (c) the nflverse contributors, CC-BY 4.0 (see README.md). Values unchanged; rows and columns selected. Made by tests/golden/extract-nflverse-evidence.ts.",
    season: 2026,
    weeks: [1, 2, 3],
    sources,
    retrieved: "2026-10-06",
    dst_units: units,
    scoring_plays: kept,
    players: [...pairs.entries()].sort((a, b) => a[0] - b[0]),
  };
  writeFileSync(EVIDENCE_PATH, await formatJson(out as unknown as Json));
  process.stderr.write(
    `wrote ${EVIDENCE_PATH}: ${String(units.length)} D/ST weeks, ${String(kept.length)} plays, ${String(pairs.size)} players\n`,
  );
}

await main();
