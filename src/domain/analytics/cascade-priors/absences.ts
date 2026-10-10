// absences.ts — the historical absence set (plan 10 §3.3 C6 "on the historical absence set"; B6 "≥ 10
// historical starter absences"; sib research 05 §6 Evaluation "for every starter absence of ≥ 2 games
// in history … over the next 1–4 weeks"): from team-game usage rows, every absence of a team's RB1
// (by carries), WR1/WR2 (by targets) or TE1 (by targets) — named over the team's last ≤ 4 games, he
// played the last of them and ≥ 2 in all, then had no opportunity in ≥ 2 consecutive team games —
// with his vacated shares (over the pre-window games he played), the team's volume before and
// during, and every teammate the cascade would see: the skill players with an opportunity in those
// games or listed on the first absence week's depth chart, less any other starter also absent
// throughout (he is a co-absence, not a beneficiary). Byes are skipped (a team game is a week the
// team had an opportunity). Pure. New here.
import { ensure } from "../errors.js";
import { mainComponent, rolesOf, type RoleRule } from "./predict.js";
import type {
  AbsenceEvent,
  AbsenceRules,
  AbsenceTeammate,
  ComponentShares,
  ComponentVolume,
  InjuredPosition,
  SkillPosition,
  StarterRole,
  UsageRow,
} from "./types.js";

/** The absence rules C6 and the shipped table use (fixed before any evaluation was run). */
export const DEFAULT_ABSENCE_RULES: AbsenceRules = Object.freeze({
  first_week: 1,
  last_week: 17,
  pre_games: 4,
  min_pre_games_played: 2,
  min_games_missed: 2,
  max_post_games: 4,
  min_starter_share: Object.freeze({ RB: 0.35, WR: 0.15, TE: 0.12 }),
});

const SKILL = new Set<string>(["QB", "RB", "WR", "TE"]);
const opp = (r: UsageRow | undefined): number => (r === undefined ? 0 : r.targets + r.carries);

interface Totals {
  targets: number;
  carries: number;
  rz: number;
}
const zero = (): Totals => ({ targets: 0, carries: 0, rz: 0 });
const addRow = (t: Totals, r: UsageRow): void => {
  t.targets += r.targets;
  t.carries += r.carries;
  t.rz += r.rz_targets + r.rz_carries;
};
const sharesOf = (p: Totals, team: Totals): ComponentShares => ({
  targets: team.targets > 0 ? p.targets / team.targets : 0,
  carries: team.carries > 0 ? p.carries / team.carries : 0,
  rz: team.rz > 0 ? p.rz / team.rz : 0,
});
const perGame = (t: Totals, games: number): ComponentVolume => ({
  targets: games > 0 ? t.targets / games : 0,
  carries: games > 0 ? t.carries / games : 0,
  rz: games > 0 ? t.rz / games : 0,
});
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One team-season's games: week → player → row (every row of the team-week, OTHER included). */
type Games = Map<number, Map<string, UsageRow>>;

function teamSeasons(rows: readonly UsageRow[]): Map<string, Games> {
  const out = new Map<string, Games>();
  for (const r of rows) {
    const k = `${String(r.season)}|${r.team}`;
    let g = out.get(k);
    if (g === undefined) {
      g = new Map();
      out.set(k, g);
    }
    let w = g.get(r.week);
    if (w === undefined) {
      w = new Map();
      g.set(r.week, w);
    }
    w.set(r.player, r);
  }
  return out;
}

/** The starters named over the pre window: RB1 by carries, WR1–WR2 and TE1 by targets. */
function startersOf(
  games: Games,
  weeks: readonly number[],
): { role: StarterRole; player: string; position: InjuredPosition }[] {
  const tot = new Map<string, { pos: string; targets: number; carries: number }>();
  for (const w of weeks)
    for (const r of games.get(w)?.values() ?? []) {
      const t = tot.get(r.player) ?? { pos: r.position, targets: 0, carries: 0 };
      t.targets += r.targets;
      t.carries += r.carries;
      tot.set(r.player, t);
    }
  const ranked = (pos: string, by: "targets" | "carries") =>
    [...tot.entries()]
      .filter(([, t]) => t.pos === pos && t[by] > 0)
      .sort(([a, x], [b, y]) => y[by] - x[by] || cmp(a, b))
      .map(([id]) => id);
  const out: { role: StarterRole; player: string; position: InjuredPosition }[] = [];
  const rb = ranked("RB", "carries");
  const wr = ranked("WR", "targets");
  const te = ranked("TE", "targets");
  if (rb[0] !== undefined) out.push({ role: "RB1", player: rb[0], position: "RB" });
  if (wr[0] !== undefined) out.push({ role: "WR1", player: wr[0], position: "WR" });
  if (wr[1] !== undefined) out.push({ role: "WR2", player: wr[1], position: "WR" });
  if (te[0] !== undefined) out.push({ role: "TE1", player: te[0], position: "TE" });
  return out;
}

const posInt = (x: number): boolean => Number.isInteger(x) && x >= 1;
/** Whether absence rules are usable (whole, positive windows; shares in [0, 1]). */
export function rulesValid(r: AbsenceRules): boolean {
  return (
    posInt(r.first_week) &&
    posInt(r.last_week) &&
    r.first_week <= r.last_week &&
    posInt(r.pre_games) &&
    posInt(r.min_pre_games_played) &&
    r.min_pre_games_played <= r.pre_games &&
    posInt(r.min_games_missed) &&
    posInt(r.max_post_games) &&
    Object.values(r.min_starter_share).every((x) => Number.isFinite(x) && x >= 0 && x <= 1)
  );
}

/**
 * Every starter absence in the rows under the rules, sorted (season, team, week, role). Rows of
 * several seasons may be mixed; each (season, team) is read on its own. Throws AnalyticsError
 * `invalid_request` on unusable rules.
 */
export function findAbsences(
  rows: readonly UsageRow[],
  rules: AbsenceRules = DEFAULT_ABSENCE_RULES,
  roleRule: RoleRule = "successor",
): AbsenceEvent[] {
  ensure(rulesValid(rules), "absence rules out of range", "rules");
  const events: AbsenceEvent[] = [];
  for (const [key, games] of teamSeasons(rows)) {
    const [seasonText, team = ""] = key.split("|");
    const season = Number(seasonText);
    const weeks = [...games.keys()]
      .filter((w) => {
        if (w < rules.first_week || w > rules.last_week) return false;
        let o = 0;
        for (const r of games.get(w)?.values() ?? []) o += opp(r);
        return o > 0;
      })
      .sort((a, b) => a - b);
    for (let g = 1; g < weeks.length; g++) {
      const pre = weeks.slice(Math.max(0, g - rules.pre_games), g);
      const starters = startersOf(games, pre);
      const absentThrough = (player: string, post: readonly number[]) =>
        post.every((w) => opp(games.get(w)?.get(player)) === 0);
      for (const s of starters) {
        const last = pre[pre.length - 1];
        if (last === undefined || opp(games.get(last)?.get(s.player)) === 0) continue;
        const withWeeks = pre.filter((w) => opp(games.get(w)?.get(s.player)) > 0);
        if (withWeeks.length < rules.min_pre_games_played) continue;
        let missed = 0;
        for (let k = g; k < weeks.length; k++) {
          const w = weeks[k];
          if (w === undefined || opp(games.get(w)?.get(s.player)) > 0) break;
          missed += 1;
        }
        if (missed < rules.min_games_missed) continue;
        const post = weeks.slice(g, g + Math.min(missed, rules.max_post_games));
        const teamPre = zero();
        const teamPost = zero();
        for (const w of withWeeks) for (const r of games.get(w)?.values() ?? []) addRow(teamPre, r);
        for (const w of post) for (const r of games.get(w)?.values() ?? []) addRow(teamPost, r);
        const playerTotals = (player: string, ws: readonly number[]): Totals => {
          const t = zero();
          for (const w of ws) {
            const r = games.get(w)?.get(player);
            if (r !== undefined) addRow(t, r);
          }
          return t;
        };
        const injuredPre = sharesOf(playerTotals(s.player, withWeeks), teamPre);
        if (injuredPre[mainComponent(s.position)] < rules.min_starter_share[s.position]) continue;
        // the teammates the cascade sees: an opportunity with him, or listed on the week's chart
        const first = post[0] ?? 0;
        const coAbsent = new Set(
          starters
            .filter((o) => o.player !== s.player && absentThrough(o.player, post))
            .map((o) => o.player),
        );
        const ids = new Set<string>();
        for (const w of withWeeks)
          for (const r of games.get(w)?.values() ?? [])
            if (SKILL.has(r.position) && opp(r) > 0) ids.add(r.player);
        for (const r of games.get(first)?.values() ?? [])
          if (SKILL.has(r.position) && r.depth !== null) ids.add(r.player);
        ids.delete(s.player);
        for (const c of coAbsent) ids.delete(c);
        const sorted = [...ids].sort(cmp);
        const info = sorted.map((id) => {
          const t = playerTotals(id, withWeeks);
          const anyRow =
            games.get(first)?.get(id) ??
            withWeeks.map((w) => games.get(w)?.get(id)).find((r) => r !== undefined);
          return {
            id,
            position: (anyRow?.position ?? "OTHER") as SkillPosition,
            depth: games.get(first)?.get(id)?.depth ?? null,
            opportunities: (t.targets + t.carries) / withWeeks.length,
            main: t[mainComponent(s.position)] / withWeeks.length,
            pre: sharesOf(t, teamPre),
            post: sharesOf(playerTotals(id, post), teamPost),
          };
        });
        const roles = rolesOf(
          info.map((m) => ({
            position: m.position,
            opportunities: m.opportunities,
            main: m.main,
            depth: m.depth,
            key: m.id,
          })),
          s.position,
          roleRule,
        );
        const teammates: AbsenceTeammate[] = [];
        info.forEach((m, i) => {
          const role = roles[i];
          if (role === null || role === undefined) return;
          teammates.push({
            player: m.id,
            position: m.position,
            role,
            depth: m.depth,
            pre_opportunities: m.opportunities,
            pre: m.pre,
            post: m.post,
          });
        });
        events.push({
          season,
          team,
          week: first,
          injured: { player: s.player, position: s.position, role: s.role, pre: injuredPre },
          team_pre: perGame(teamPre, withWeeks.length),
          team_post: perGame(teamPost, post.length),
          pre_weeks: withWeeks,
          post_weeks: post,
          games_missed: missed,
          teammates,
        });
      }
    }
  }
  const order: Readonly<Record<StarterRole, number>> = { RB1: 0, WR1: 1, WR2: 2, TE1: 3 };
  return events.sort(
    (a, b) =>
      a.season - b.season ||
      cmp(a.team, b.team) ||
      a.week - b.week ||
      order[a.injured.role] - order[b.injured.role],
  );
}
