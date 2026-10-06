// phase2-soft-backtest.ts — the soft (reported, never gated) Phase-2 analytics numbers of plan 10
// B3, B4 and B6, written to docs/evals/phase2-analytics.md. NOT a test file (vitest never runs it)
// and never part of CI: it reads nflverse / ffopportunity release files from a local directory the
// caller names (downloaded by the sources engineer; never committed), and fx-10h's own feed.
//
//   scripts/dev/with-node.sh npx tsx tests/domain/analytics/phase2-soft-backtest.ts <dir>
//
// <dir> holds stats_player_week_{2024,2025}.parquet, snap_counts_{2024,2025}.parquet,
// ep_weekly_{2024,2025}.parquet and players.parquet. Prints one JSON object.
//
// B3 (research 05 §8.4 #3; sib research 05 §4 Evaluation): for each decision week t = 5..14 of the
// 2024 and 2025 regular seasons, the "available" RB/WR/TE (season-to-date points per game below the
// rostered ranks of research 05 §1.6: RB36 / WR38 / TE14) are scanned by the usage detector on games
// ≤ t−1; a pick is a HIT when the player finishes top-24 (RB/WR) / top-12 (TE) at his position over
// weeks t..t+3. The points-only detector takes, each week, the same number of picks (equal recall
// budget) as the top available scorers of week t−1. Half-PPR points = mean of nflverse's standard and
// PPR fantasy points (the 5-pt pass TD does not touch RB/WR/TE); xFP from ffopportunity (its own PPR
// scoring for both sides of the gap); no red-zone, depth-chart or line inputs here (rz_shift,
// depth_chart and implied_total are not backtested).
//
// B6 (sib research 05 §6 Evaluation): every 2024–2025 absence of a team's RB1 (carries) or WR1/TE1
// (targets) — he played week t−1 and none of weeks t, t+1 while the team played — the cascade's top
// predicted beneficiary (redistribute on the four games before, no team evidence) vs the next man up
// (the same-position teammate with the most of the starter's main component) against the realised
// top gainer in (targets + carries) per game over the two absence games.
//
// B4 (research 05 §1.6 eval 2): q_i fitted on fx-10h's own WAIVER / WAIVER_ERROR rows; the Brier of
// the fit and of the cold-start curve on the same rows (in sample; two runs only).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import { redistribute, type CascadeTeammate } from "../../../src/domain/analytics/cascade.js";
import {
  brier,
  claimRuns,
  demandObservations,
  fitDemand,
} from "../../../src/domain/analytics/demand.js";
import { detectSignals, type UsageWeek } from "../../../src/domain/analytics/usageSignals.js";
import { demandOf } from "../../../src/domain/analytics/waiverDp.js";
import type { BareText, Transaction } from "../../../src/domain/league/types.js";
import { newCounts, normalizeTransaction } from "../../../src/providers/espn/normalize.js";

type Row = Record<string, unknown>;

async function read(path: string, columns: readonly string[]): Promise<Row[]> {
  const buf = readFileSync(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const metadata = parquetMetadata(ab);
  return parquetReadObjects({ file: ab, metadata, columns: [...columns] });
}
const num = (v: unknown): number =>
  typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : Number.NaN;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const SKILL = new Set(["RB", "WR", "TE"]);
const ROSTERED: Readonly<Record<string, number>> = { RB: 36, WR: 38, TE: 14 };
const TOP: Readonly<Record<string, number>> = { RB: 24, WR: 24, TE: 12 };
const KINDS = ["snap_jump", "target_share_jump", "xfp_gap"] as const;

interface PW {
  readonly id: string;
  readonly pos: string;
  readonly team: string;
  readonly week: number;
  readonly pts: number;
  readonly targets: number;
  readonly carries: number;
  readonly tshare: number | null;
}

async function season(dir: string, s: number, pfrToGsis: ReadonlyMap<string, string>) {
  const stats = await read(join(dir, `stats_player_week_${String(s)}.parquet`), [
    "player_id",
    "position",
    "team",
    "week",
    "season_type",
    "fantasy_points",
    "fantasy_points_ppr",
    "targets",
    "carries",
    "target_share",
  ]);
  const pw: PW[] = stats
    .filter((r) => str(r.season_type) === "REG" && SKILL.has(str(r.position)))
    .map((r) => ({
      id: str(r.player_id),
      pos: str(r.position),
      team: str(r.team),
      week: num(r.week),
      pts: (num(r.fantasy_points) + num(r.fantasy_points_ppr)) / 2,
      targets: num(r.targets) || 0,
      carries: num(r.carries) || 0,
      tshare: Number.isFinite(num(r.target_share)) ? num(r.target_share) : null,
    }));
  const snaps = await read(join(dir, `snap_counts_${String(s)}.parquet`), [
    "pfr_player_id",
    "week",
    "offense_pct",
    "game_type",
  ]);
  const snapOf = new Map<string, number>();
  for (const r of snaps) {
    if (str(r.game_type) !== "REG") continue;
    const g = pfrToGsis.get(str(r.pfr_player_id));
    if (g !== undefined) snapOf.set(`${g}|${String(num(r.week))}`, num(r.offense_pct));
  }
  const ep = await read(join(dir, `ep_weekly_${String(s)}.parquet`), [
    "player_id",
    "week",
    "total_fantasy_points_exp",
    "total_fantasy_points",
  ]);
  const epOf = new Map<string, { xfp: number; pts: number }>();
  for (const r of ep)
    epOf.set(`${str(r.player_id)}|${String(num(r.week))}`, {
      xfp: num(r.total_fantasy_points_exp),
      pts: num(r.total_fantasy_points),
    });
  return { pw, snapOf, epOf };
}

function b3(data: Awaited<ReturnType<typeof season>>) {
  const { pw, snapOf, epOf } = data;
  const byPlayer = new Map<string, PW[]>();
  for (const r of pw) byPlayer.set(r.id, [...(byPlayer.get(r.id) ?? []), r]);
  const out: Record<string, { picks: number; usage_hits: number; points_hits: number }> = {};
  for (const k of [...KINDS, "any"]) out[k] = { picks: 0, usage_hits: 0, points_hits: 0 };
  for (let t = 5; t <= 14; t++) {
    // availability: season-to-date points per game through t−1, ranked by position
    const ppg = new Map<string, { pos: string; ppg: number }>();
    for (const [id, rows] of byPlayer) {
      const past = rows.filter((r) => r.week < t);
      if (past.length === 0) continue;
      ppg.set(id, {
        pos: past[0]?.pos ?? "",
        ppg: past.reduce((a, r) => a + r.pts, 0) / past.length,
      });
    }
    const rankOf = new Map<string, number>();
    for (const pos of SKILL) {
      [...ppg.entries()]
        .filter(([, v]) => v.pos === pos)
        .sort(([, a], [, b]) => b.ppg - a.ppg)
        .forEach(([id], i) => rankOf.set(id, i + 1));
    }
    // outcome: top finishers over t..t+3
    const future = new Map<string, number>();
    for (const r of pw)
      if (r.week >= t && r.week <= t + 3) future.set(r.id, (future.get(r.id) ?? 0) + r.pts);
    const hit = new Set<string>();
    for (const pos of SKILL) {
      [...future.entries()]
        .filter(([id]) => ppg.get(id)?.pos === pos || byPlayer.get(id)?.[0]?.pos === pos)
        .sort(([, a], [, b]) => b - a)
        .slice(0, TOP[pos] ?? 24)
        .forEach(([id]) => hit.add(id));
    }
    const available = [...ppg.entries()].filter(
      ([id, v]) => (rankOf.get(id) ?? 0) > (ROSTERED[v.pos] ?? 99),
    );
    const lastWeekPts = (id: string): number =>
      byPlayer.get(id)?.find((r) => r.week === t - 1)?.pts ?? 0;
    for (const kind of [...KINDS, "any"] as const) {
      const picks: string[] = [];
      for (const [id, v] of available) {
        const games: UsageWeek[] = (byPlayer.get(id) ?? [])
          .filter((r) => r.week < t)
          .map((r) => {
            const e = epOf.get(`${id}|${String(r.week)}`);
            return {
              week: r.week,
              snap_pct: snapOf.get(`${id}|${String(r.week)}`) ?? null,
              target_share: r.tshare,
              rz_share: null,
              xfp: e?.xfp ?? null,
              points: e?.pts ?? null,
            };
          });
        const s = detectSignals({ position: v.pos, games });
        if (kind === "any" ? s.length > 0 : s.some((x) => x.kind === kind)) picks.push(id);
      }
      const pointsPicks = [...available]
        .sort(([a], [b]) => lastWeekPts(b) - lastWeekPts(a))
        .slice(0, picks.length)
        .map(([id]) => id);
      const o = out[kind];
      if (o === undefined) continue;
      o.picks += picks.length;
      o.usage_hits += picks.filter((id) => hit.has(id)).length;
      o.points_hits += pointsPicks.filter((id) => hit.has(id)).length;
    }
  }
  return Object.fromEntries(
    Object.entries(out).map(([k, v]) => [
      k,
      {
        picks: v.picks,
        usage_precision: v.picks === 0 ? null : Math.round((1000 * v.usage_hits) / v.picks) / 1000,
        points_precision:
          v.picks === 0 ? null : Math.round((1000 * v.points_hits) / v.picks) / 1000,
      },
    ]),
  );
}

function b6(data: Awaited<ReturnType<typeof season>>) {
  const { pw } = data;
  const byTeamWeek = new Map<string, PW[]>();
  for (const r of pw)
    byTeamWeek.set(`${r.team}|${String(r.week)}`, [
      ...(byTeamWeek.get(`${r.team}|${String(r.week)}`) ?? []),
      r,
    ]);
  const teams = [...new Set(pw.map((r) => r.team))];
  let n = 0;
  let cascadeHits = 0;
  let nextHits = 0;
  for (const team of teams)
    for (let t = 5; t <= 17; t++) {
      const before = [t - 4, t - 3, t - 2, t - 1].map(
        (w) => byTeamWeek.get(`${team}|${String(w)}`) ?? [],
      );
      const after = [t, t + 1].map((w) => byTeamWeek.get(`${team}|${String(w)}`) ?? []);
      if (
        after.some((rows) => rows.length === 0) ||
        before.filter((rows) => rows.length > 0).length < 3
      )
        continue;
      const teamTot = (rows: readonly PW[][]) => {
        let tg = 0;
        let cr = 0;
        for (const g of rows)
          for (const r of g) {
            tg += r.targets;
            cr += r.carries;
          }
        return { tg, cr, games: rows.filter((g) => g.length > 0).length };
      };
      const tb = teamTot(before);
      const ta = teamTot(after);
      for (const pos of ["RB", "WR", "TE"] as const) {
        const comp = pos === "RB" ? "carries" : "targets";
        const totals = new Map<string, { tg: number; cr: number; games: number }>();
        for (const g of before)
          for (const r of g) {
            const cur = totals.get(r.id) ?? { tg: 0, cr: 0, games: 0 };
            totals.set(r.id, {
              tg: cur.tg + r.targets,
              cr: cur.cr + r.carries,
              games: cur.games + 1,
            });
          }
        const posIds = [...totals.entries()].filter(
          ([id]) => before.flat().find((r) => r.id === id)?.pos === pos,
        );
        const starter = posIds.sort(([, a], [, b]) =>
          comp === "carries" ? b.cr - a.cr : b.tg - a.tg,
        )[0];
        if (starter === undefined || starter[1].games < 3) continue;
        const sid = starter[0];
        const playedLast = (before[3] ?? []).some((r) => r.id === sid);
        const absent = after.every((g) => !g.some((r) => r.id === sid));
        if (!playedLast || !absent) continue;
        const posOf = (id: string): string => before.flat().find((r) => r.id === id)?.pos ?? "";
        const mates = [...totals.entries()].filter(([id]) => id !== sid);
        if (mates.length === 0) continue;
        const share = (v: { tg: number; cr: number }) => ({
          target_share: tb.tg > 0 ? v.tg / tb.tg : 0,
          carry_share: tb.cr > 0 ? v.cr / tb.cr : 0,
          rz_share: null,
        });
        const teammates: CascadeTeammate[] = mates.map(([id, v]) => ({
          player_id: null,
          gsis_id: id,
          name: id as BareText,
          position: posOf(id),
          injury_status: null,
          usage: { ...share(v), snap_pct: null },
          percent_change: null,
          availability: { status: null, waiver_process_date: null },
        }));
        const { allocs } = redistribute(
          { position: pos, usage: share(starter[1]) },
          teammates,
          0,
          0.5,
        );
        const predicted = [...allocs].sort(
          (a, b) =>
            b.delta.targets * tb.tg +
            b.delta.carries * tb.cr -
            (a.delta.targets * tb.tg + a.delta.carries * tb.cr),
        )[0]?.mate.gsis_id;
        const next = mates
          .filter(([id]) => posOf(id) === pos)
          .sort(([, a], [, b]) => (comp === "carries" ? b.cr - a.cr : b.tg - a.tg))[0]?.[0];
        // realised: the largest gain in opportunities per game over the absence games
        const afterOf = new Map<string, number>();
        for (const g of after)
          for (const r of g) afterOf.set(r.id, (afterOf.get(r.id) ?? 0) + r.targets + r.carries);
        const realised = mates
          .map(([id, v]) => ({
            id,
            gain:
              (afterOf.get(id) ?? 0) / Math.max(1, ta.games) - (v.tg + v.cr) / Math.max(1, v.games),
          }))
          .sort((a, b) => b.gain - a.gain)[0]?.id;
        if (realised === undefined) continue;
        n += 1;
        if (predicted === realised) cascadeHits += 1;
        if (next === realised) nextHits += 1;
      }
    }
  return {
    absences: n,
    cascade_hit_rate: n === 0 ? null : Math.round((1000 * cascadeHits) / n) / 1000,
    next_man_up_hit_rate: n === 0 ? null : Math.round((1000 * nextHits) / n) / 1000,
  };
}

function b4() {
  const raw = JSON.parse(
    readFileSync(
      new URL("../../../fixtures/espn/fx-10h/league/mTransactions2.json", import.meta.url),
      "utf8",
    ),
  ) as { transactions: unknown[] };
  const counts = newCounts();
  const txs = raw.transactions
    .map((t) => normalizeTransaction(t, null, counts))
    .filter((t): t is Transaction => t !== null);
  const runs = claimRuns(txs);
  const pool = JSON.parse(
    readFileSync(
      new URL("../../../fixtures/espn/fx-10h/league/pool.json", import.meta.url),
      "utf8",
    ),
  ) as {
    entries: {
      id: number;
      onTeamId: number;
      player: {
        defaultPositionId: number;
        stats: {
          statSourceId: number;
          statSplitTypeId: number;
          scoringPeriodId: number;
          appliedTotal: number;
        }[];
      };
    }[];
  };
  const REPL: Readonly<Record<number, number>> = { 1: 14, 2: 8, 3: 8, 4: 6, 5: 7, 16: 6 };
  const proj = new Map<string, number>();
  for (const e of pool.entries)
    for (const s of e.player.stats)
      if (s.statSourceId === 1 && s.statSplitTypeId === 1)
        proj.set(
          `${String(e.id)}|${String(s.scoringPeriodId)}`,
          Math.max(0, s.appliedTotal - (REPL[e.player.defaultPositionId] ?? 7)),
        );
  const periodOf = new Map(
    runs.map((r) => [r.run, txs.find((t) => t.process_date === r.run)?.scoring_period ?? 0]),
  );
  const unowned = pool.entries.filter((e) => e.onTeamId === 0).map((e) => e.id);
  const features = (run: string, _team: number, player: number) => {
    const r = proj.get(`${String(player)}|${String(periodOf.get(run) ?? 0)}`);
    return { r: r ?? 0, upgrade: null, trend: null };
  };
  const teams = Array.from({ length: 10 }, (_, i) => i + 1);
  const summary = (rows: ReturnType<typeof demandObservations>) => {
    const fit = fitDemand(rows);
    return {
      rows: rows.length,
      claims: rows.filter((r) => r.claimed).length,
      brier_cold:
        Math.round(brier(rows.map((r) => ({ p: demandOf(r.r), y: r.claimed }))) * 1e5) / 1e5,
      brier_fitted: fit?.brier_fitted ?? null,
      coef: fit?.coef.map((c) => Math.round(c * 1000) / 1000) ?? null,
    };
  };
  return {
    runs: runs.length,
    // (a) every currently unowned pool player was claimable in both runs (base rate dominates)
    all_pool: summary(
      demandObservations({
        runs,
        teams,
        pool_by_run: new Map(runs.map((r) => [r.run, unowned])),
        features,
      }),
    ),
    // (b) only the players someone claimed: who among the ten teams claims a contested player
    contested: summary(demandObservations({ runs, teams, features })),
  };
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (dir === undefined)
    throw new Error("usage: phase2-soft-backtest.ts <dir with the release files>");
  const players = await read(join(dir, "players.parquet"), ["gsis_id", "pfr_id"]);
  const pfrToGsis = new Map<string, string>();
  for (const p of players)
    if (str(p.pfr_id) !== "" && str(p.gsis_id) !== "") pfrToGsis.set(str(p.pfr_id), str(p.gsis_id));
  const result: Record<string, unknown> = { b4_fx10h: b4() };
  for (const s of [2024, 2025]) {
    const d = await season(dir, s, pfrToGsis);
    result[`b3_${String(s)}`] = b3(d);
    result[`b6_${String(s)}`] = b6(d);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

void main();
