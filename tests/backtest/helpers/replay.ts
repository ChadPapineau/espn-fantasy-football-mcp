// replay.ts — the backtest harness skeleton (plan 10 A11a start/sit, A12a K/D-ST; research 05 §8.4
// #7–#8): replays the recorded final weeks with the shipped engines — E1 v1-ensemble Dists, the E2
// lineup at `objective: mean`, the K/D-ST bracket model — against the baselines the plan names
// ("start by last week's points", "start by ESPN's projection", "lowest opponent implied total",
// "most points last week") and the hindsight best; and keeps docs/evals/1a-backtest.md equal to what
// the replay computes (UPDATE_EVALS=1 rewrites a section; the tests assert equality otherwise).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  analyzeLineup,
  bestLineup,
  type LineupPlayer,
} from "../../../src/domain/analytics/lineup.js";
import { kdstExpectation } from "../../../src/domain/analytics/kdst.js";
import { spearman } from "../../../src/domain/analytics/math.js";
import { projectPlayers } from "../../../src/domain/analytics/projection.js";
import type { LineupData } from "../../../src/domain/analytics/types.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import { opponentOf, teamGame } from "../../../src/domain/league/schedule.js";
import { slotClassOf } from "../../../src/domain/league/slots.js";
import type { BareText } from "../../../src/domain/league/types.js";
import type { Dist } from "../../../src/domain/scoring/types.js";
import { instantPacer } from "../../domain/analytics/helpers.js";
import {
  impliedTotals,
  leagueOf,
  LEAGUES,
  replayTeams,
  schedule,
  weeksOf,
  type LeagueSlot,
  type ReplayEntry,
  type ReplayTeam,
} from "./fixture.js";

const point = (mean: number): Dist => ({
  mean,
  p10: mean,
  p25: mean,
  p50: mean,
  p75: mean,
  p90: mean,
  p_zero: mean === 0 ? 1 : 0,
  basis: "position_cv",
});

function asPlayer(e: ReplayEntry, points: Dist): LineupPlayer {
  return {
    player_id: e.player_id,
    gsis_id: null,
    name: `Player ${String(e.player_id)}` as BareText,
    position: e.position,
    eligible_slot_ids: e.eligible_slot_ids,
    injury_status: null,
    pro_team_id: e.pro_team_id,
    slot_id: e.slot_id,
    locked: false,
    lock_at: null,
    points,
    p_active: null,
    espn_projection: e.projected,
    percent_started: null,
    role_games: 0,
  };
}

/** One replayed team-week: realised points of each decision rule and their regrets. */
export interface LineupRow {
  readonly league: LeagueSlot;
  readonly week: number;
  readonly team_id: number;
  readonly hindsight: number;
  readonly mean: number;
  readonly espn: number;
  readonly last_week: number | null;
  readonly manager: number;
  readonly mode_consistent: boolean;
}

export interface LineupReplay {
  readonly rows: readonly LineupRow[];
  readonly outputs: readonly LineupData[];
}

const actualOf = (e: ReplayEntry): number => e.actual ?? 0;
const realised = (
  starters: readonly LineupPlayer[],
  byId: ReadonlyMap<number, ReplayEntry>,
): number =>
  starters.reduce(
    (s, p) => s + actualOf(byId.get(p.player_id) ?? ({ actual: 0 } as ReplayEntry)),
    0,
  );

/** E1 v1-ensemble Dists for a team's entries (ESPN's weekly projection as the mean). */
async function e1Dists(
  team: ReplayTeam,
  settings: ReturnType<typeof leagueOf>["settings"],
): Promise<Map<number, Dist>> {
  const out = await projectPlayers({
    targets: team.entries.map((e) => ({
      player_id: e.player_id,
      gsis_id: null,
      name: `Player ${String(e.player_id)}` as BareText,
      position: e.position,
      position_id: e.position_id,
      pro_team_id: e.pro_team_id,
      injury_status: null,
      espn_week: e.projected,
      espn_ros: null,
      trailing: [],
    })),
    season: 2026,
    horizon: "week",
    week: team.week,
    final_week: team.week,
    settings,
    schedule: schedule(),
    clock: fixedClock("2026-09-01T12:00:00.000Z"),
    rng: seededRng(team.team_id * 100 + team.week),
    pacer: instantPacer,
    deadline_ms: null,
    n_sims: 1000,
  });
  return new Map(out.players.map((p) => [p.target.player_id ?? 0, p.weeks[0]?.dist ?? point(0)]));
}

/** Replays every recorded final week of every league with the shipped E1 + E2. */
export async function replayLineups(): Promise<LineupReplay> {
  const rows: LineupRow[] = [];
  const outputs: LineupData[] = [];
  for (const league of LEAGUES) {
    const { settings, roster } = leagueOf(league);
    const weeks = weeksOf(league);
    let prev: Map<number, number> | null = null;
    for (const week of weeks) {
      const teams = replayTeams(league, week);
      const dists = new Map<number, Map<number, Dist>>();
      for (const t of teams) dists.set(t.team_id, await e1Dists(t, settings));
      for (const t of teams) {
        const byId = new Map(t.entries.map((e) => [e.player_id, e]));
        const d = dists.get(t.team_id) ?? new Map<number, Dist>();
        const players = t.entries.map((e) => asPlayer(e, d.get(e.player_id) ?? point(0)));
        const opp = teams.find((x) => x.team_id === t.opponent_id);
        const oppPlayers =
          opp === undefined
            ? null
            : opp.entries.map((e) =>
                asPlayer(e, dists.get(opp.team_id)?.get(e.player_id) ?? point(0)),
              );
        const base = {
          roster,
          players,
          seeding_config: { mode: "espn_rule" as const, confirmed_at: null },
          clock: fixedClock("2026-09-01T12:00:00.000Z"),
        };
        const mean = analyzeLineup({ ...base, opponent: null, objective: "mean" });
        const withOpp = analyzeLineup({ ...base, opponent: oppPlayers });
        outputs.push(withOpp);
        const dm = withOpp.mode_basis.mu_m - withOpp.mode_basis.mu_o;
        const consistent =
          withOpp.mode === "protect" ? dm > 0 : withOpp.mode === "chase" ? dm < 0 : true;
        const meanStarters = players.filter(
          (p) => mean.rec.lineup?.some((s) => s.player_id === p.player_id) === true,
        );
        const espn = bestLineup(
          roster,
          t.entries.map((e) => asPlayer(e, point(e.projected ?? 0))),
        );
        const hind = bestLineup(
          roster,
          t.entries.map((e) => asPlayer(e, point(actualOf(e)))),
        );
        const last =
          prev === null
            ? null
            : bestLineup(
                roster,
                t.entries.map((e) => asPlayer(e, point(prev?.get(e.player_id) ?? 0))),
              );
        const manager = t.entries
          .filter((e) => {
            const c = slotClassOf(e.slot_id);
            return c === "starter" || c === "flex";
          })
          .reduce((s, e) => s + actualOf(e), 0);
        rows.push({
          league,
          week,
          team_id: t.team_id,
          hindsight: realised(hind, byId),
          mean: realised(meanStarters, byId),
          espn: realised(espn, byId),
          last_week: last === null ? null : realised(last, byId),
          manager,
          mode_consistent: consistent,
        });
      }
      prev = new Map(
        teams.flatMap((t) => t.entries.map((e) => [e.player_id, actualOf(e)] as const)),
      );
    }
  }
  return { rows, outputs };
}

const f2 = (x: number | null): string => (x === null ? "—" : x.toFixed(2));

/** The lineup section of docs/evals/1a-backtest.md (regret = hindsight best − realised, summed). */
export function lineupSection(rows: readonly LineupRow[]): string {
  const lines = [
    "| league | week | teams | regret: mean (v1-ensemble) | regret: ESPN projection | regret: last week's points | regret: the manager's lineup |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];
  const groups = new Map<string, LineupRow[]>();
  for (const r of rows)
    groups.set(`${r.league}|${String(r.week)}`, [
      ...(groups.get(`${r.league}|${String(r.week)}`) ?? []),
      r,
    ]);
  const sum = (xs: readonly LineupRow[], k: (r: LineupRow) => number | null): number | null =>
    xs.some((r) => k(r) === null) ? null : xs.reduce((s, r) => s + (r.hindsight - (k(r) ?? 0)), 0);
  for (const [key, xs] of groups) {
    const [league, week] = key.split("|");
    lines.push(
      `| ${league ?? ""} | ${week ?? ""} | ${String(xs.length)} | ${f2(sum(xs, (r) => r.mean))} | ${f2(sum(xs, (r) => r.espn))} | ${f2(sum(xs, (r) => r.last_week))} | ${f2(sum(xs, (r) => r.manager))} |`,
    );
  }
  const later = rows.filter((r) => r.last_week !== null);
  lines.push(
    `| **all** | | ${String(rows.length)} | ${f2(sum(rows, (r) => r.mean))} | ${f2(sum(rows, (r) => r.espn))} | — | ${f2(sum(rows, (r) => r.manager))} |`,
    `| **weeks with a last week** | | ${String(later.length)} | ${f2(sum(later, (r) => r.mean))} | ${f2(sum(later, (r) => r.espn))} | ${f2(sum(later, (r) => r.last_week))} | ${f2(sum(later, (r) => r.manager))} |`,
  );
  return lines.join("\n");
}

/** One replayed K or D/ST league-week: candidates and rank correlations with realised points. */
export interface KdstRow {
  readonly league: LeagueSlot;
  readonly week: number;
  readonly position: "K" | "D/ST";
  readonly n: number;
  readonly implied_populated: boolean;
  readonly rho_model: number | null;
  readonly rho_implied: number | null;
  readonly rho_last_week: number | null;
}

/** Replays every rostered K and D/ST of every recorded final week with the bracket model. */
export function replayKdst(): KdstRow[] {
  const implied = new Map(
    impliedTotals().map((r) => [`${String(r.week)}:${String(r.pro_team_id)}`, r.implied]),
  );
  const sched = schedule();
  const rows: KdstRow[] = [];
  for (const league of LEAGUES) {
    const { settings } = leagueOf(league);
    let prev: Map<number, number> | null = null;
    for (const week of weeksOf(league)) {
      const entries = new Map<number, ReplayEntry>();
      for (const t of replayTeams(league, week))
        for (const e of t.entries) entries.set(e.player_id, e);
      for (const pos of ["K", "D/ST"] as const) {
        const cands = [...entries.values()].filter((e) => e.position === pos && e.actual !== null);
        const model: number[] = [];
        const naive: number[] = [];
        const last: number[] = [];
        const real: number[] = [];
        let populated = true;
        for (const e of cands) {
          const g = teamGame(
            sched.games.filter((x) => x.week === week),
            e.pro_team_id,
          );
          const opp = g === null ? null : opponentOf(g, e.pro_team_id);
          const team = implied.get(`${String(week)}:${String(e.pro_team_id)}`) ?? null;
          const against =
            opp === null ? null : (implied.get(`${String(week)}:${String(opp)}`) ?? null);
          if (team === null || against === null) populated = false;
          model.push(kdstExpectation(pos, settings, team, against).e);
          naive.push(pos === "K" ? (team ?? 0) : -(against ?? 0));
          last.push(prev?.get(e.player_id) ?? 0);
          real.push(actualOf(e));
        }
        rows.push({
          league,
          week,
          position: pos,
          n: cands.length,
          implied_populated: populated,
          rho_model: spearman(model, real),
          rho_implied: spearman(naive, real),
          rho_last_week: prev === null ? null : spearman(last, real),
        });
      }
      prev = new Map([...entries.values()].map((e) => [e.player_id, actualOf(e)]));
    }
  }
  return rows;
}

/** The K/D-ST section of docs/evals/1a-backtest.md. */
export function kdstSection(rows: readonly KdstRow[]): string {
  const lines = [
    "| league | week | position | candidates | ρ: bracket model | ρ: lowest opponent implied total | ρ: most points last week |",
    "|---|---:|---|---:|---:|---:|---:|",
  ];
  for (const r of rows)
    lines.push(
      `| ${r.league} | ${String(r.week)} | ${r.position} | ${String(r.n)} | ${f2(r.rho_model)} | ${f2(r.rho_implied)} | ${f2(r.rho_last_week)} |`,
    );
  const avg = (k: (r: KdstRow) => number | null, pos: string): string => {
    const xs = rows
      .filter((r) => r.position === pos)
      .map(k)
      .filter((x): x is number => x !== null);
    return xs.length === 0 ? "—" : (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2);
  };
  for (const pos of ["K", "D/ST"])
    lines.push(
      `| **mean** | | ${pos} | | ${avg((r) => r.rho_model, pos)} | ${avg((r) => r.rho_implied, pos)} | ${avg((r) => r.rho_last_week, pos)} |`,
    );
  return lines.join("\n");
}

// --- docs/evals/1a-backtest.md sections ------------------------------------------------------------

const DOC = path.resolve(import.meta.dirname, "../../../docs/evals/1a-backtest.md");
const marker = (name: string, edge: "start" | "end"): string => `<!-- ${name}:${edge} -->`;

/** The committed text of a generated section. */
export function docSection(name: string): string {
  const text = readFileSync(DOC, "utf8");
  const a = text.indexOf(marker(name, "start"));
  const b = text.indexOf(marker(name, "end"));
  if (a < 0 || b < 0) throw new Error(`docs/evals/1a-backtest.md has no ${name} section`);
  return text.slice(a + marker(name, "start").length, b).trim();
}

/** Rewrites a generated section (UPDATE_EVALS=1 only). */
export function writeDocSection(name: string, body: string): void {
  const text = readFileSync(DOC, "utf8");
  const a = text.indexOf(marker(name, "start"));
  const b = text.indexOf(marker(name, "end"));
  if (a < 0 || b < 0) throw new Error(`docs/evals/1a-backtest.md has no ${name} section`);
  writeFileSync(
    DOC,
    `${text.slice(0, a + marker(name, "start").length)}\n${body}\n${text.slice(b)}`,
  );
}
