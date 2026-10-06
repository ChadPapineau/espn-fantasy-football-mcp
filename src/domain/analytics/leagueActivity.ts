// leagueActivity.ts — E11 `espn_analyze_league_activity` (plan 07 E11; research 05 §1.3 rival
// activity and roster room, §1.6 evals 3–4 — the league's own claim history and the [U] mechanics;
// sib research 05 §4.3, §5.7, §12): the window's adds, drops, claims won and lost, trades, by team;
// waiver-order movement and its cause; claims by the claimant's rank; standings movement; the most
// added and dropped players; each rival's weakest starting positions, the free agents who would fill
// them and whether a healthy player in IR blocks his adds (research 05 §4.3); and `learned.*` from
// the whole persisted feed (demand.ts — null until the feed shows the case, plan 07 §6). Team names
// stay `untrusted_text` (they come wrapped); player names stay BareText (path-listed). Pure. New.
import type { Clock } from "../clock.js";
import {
  bareUntrusted,
  type BareText,
  type IsoInstant,
  type RosterSlots,
  type Transaction,
  type UntrustedText,
} from "../league/types.js";
import {
  claimRuns,
  learnWaiverMechanics,
  type LearnedMechanics,
  type WaiverOrder,
} from "./demand.js";
import { ensure } from "./errors.js";
import { newestAsOf } from "./inputs.js";
import { ACTIVITY } from "./marketConstants.js";
import { zeroDist } from "./math.js";
import { positionGaps, type DepthPlayer } from "./trade.js";
import type { Assumption, InputFreshness, LeagueActivityData, Rec } from "./types.js";

/** A team as the digest reads it. */
export interface ActivityTeam {
  readonly team_id: number;
  readonly name: UntrustedText;
  /** Standings rank at the window's start (a stored snapshot) and now. */
  readonly rank_before: number | null;
  readonly rank_now: number | null;
  /** Waiver rank at the window's start and now. */
  readonly waiver_rank_before: number | null;
  readonly waiver_rank_now: number | null;
  /** A healthy player in IR blocks every add (research 05 §4.3). */
  readonly ir_blocked: boolean;
  /** Active players with near-term weekly values (rival needs); absent → no needs for him. */
  readonly players?: readonly (DepthPlayer & { readonly player_id: number })[];
}

/** An E11 request. */
export interface ActivityRequest {
  readonly since_days?: number;
  /** The persisted feed (A6 + `transactions_seen`), any order, any age. */
  readonly transactions: readonly Transaction[];
  readonly teams: readonly ActivityTeam[];
  readonly my_team_id: number | null;
  readonly roster: RosterSlots;
  /** The best free agents (rival needs' likely targets), weekly values aligned with the teams'. */
  readonly pool?: readonly (DepthPlayer & { readonly player_id: number })[];
  readonly include_rival_needs?: boolean;
  /** Waiver orders before / after each run (stored standings snapshots), keyed by the run's ISO. */
  readonly order_before?: ReadonlyMap<IsoInstant, WaiverOrder>;
  readonly order_after?: ReadonlyMap<IsoInstant, WaiverOrder>;
  readonly clock: Clock;
  readonly inputs?: readonly InputFreshness[];
}

/** E11's outcome (with the full mechanics evidence for E5). */
export interface ActivityOutcome {
  readonly data: LeagueActivityData;
  readonly mechanics: LearnedMechanics;
  readonly warnings: readonly string[];
}

const DAY_MS = 24 * 3600 * 1000;
const TRADE_TYPES: ReadonlySet<string> = new Set(["TRADE_ACCEPT", "TRADE_ACCEPTED"]);
const A = (text: string, revisit_trigger: string): Assumption => ({ text, revisit_trigger });
type Notable = LeagueActivityData["transactions"]["by_team"][number]["notable"][number];

const executed = (t: Transaction): boolean => t.status === null || t.status === "EXECUTED";
const instantOf = (t: Transaction): number => {
  const ms = Date.parse(t.process_date ?? t.proposed_date ?? "");
  return Number.isFinite(ms) ? ms : Number.NaN;
};
const nameOf = (id: number, name: BareText | null): BareText =>
  name ?? bareUntrusted(`Player ${String(id)}`, "player_name");

/** E11. Throws AnalyticsError `invalid_request` on bounds. */
export function analyzeLeagueActivity(req: ActivityRequest): ActivityOutcome {
  const days = req.since_days ?? 7;
  ensure(
    Number.isInteger(days) && days >= 1 && days <= 30,
    "since_days must be 1..30",
    "since_days",
  );
  ensure(
    req.transactions.length <= ACTIVITY.maxTransactions,
    "too many transactions",
    "since_days",
  );
  const now = req.clock.nowMs();
  const from = now - days * DAY_MS;
  const window = { from: new Date(from).toISOString(), to: new Date(now).toISOString() };
  const inWindow = req.transactions
    .filter((t) => {
      const ms = instantOf(t);
      return Number.isFinite(ms) && ms >= from && ms <= now;
    })
    .sort((a, b) => instantOf(a) - instantOf(b) || (a.transaction_id < b.transaction_id ? -1 : 1));

  interface TeamAgg {
    adds: number;
    drops: number;
    won: number;
    lost: number;
    notable: Notable[];
  }
  const agg = new Map<number, TeamAgg>();
  const teamOf = (id: number): TeamAgg => {
    let a = agg.get(id);
    if (a === undefined) {
      a = { adds: 0, drops: 0, won: 0, lost: 0, notable: [] };
      agg.set(id, a);
    }
    return a;
  };
  const added = new Map<number, { name: BareText | null; count: number }>();
  const dropped = new Map<number, { name: BareText | null; count: number }>();
  const bump = (
    m: Map<number, { name: BareText | null; count: number }>,
    id: number,
    name: BareText | null,
  ): void => {
    const cur = m.get(id);
    m.set(id, { name: cur?.name ?? name, count: (cur?.count ?? 0) + 1 });
  };
  let adds = 0;
  let drops = 0;
  let claims = 0;
  let losing = 0;
  let trades = 0;
  const wonInWindow = new Set<number>();
  for (const t of inWindow) {
    const team = t.team_id;
    if (TRADE_TYPES.has(t.type) && executed(t)) {
      trades += 1;
      for (const it of t.items) {
        const to = it.to_team_id;
        const fromTeam = it.from_team_id;
        if (to === null || fromTeam === null || to <= 0 || fromTeam <= 0 || to === fromTeam)
          continue;
        const name = nameOf(it.player_id, it.name);
        teamOf(to).notable.push({ player_id: it.player_id, name, action: "traded_in" });
        teamOf(fromTeam).notable.push({ player_id: it.player_id, name, action: "traded_out" });
      }
      continue;
    }
    if (team === null || team <= 0) continue;
    const a = teamOf(team);
    if (t.type === "WAIVER_ERROR") {
      losing += 1;
      a.lost += 1;
      for (const it of t.items)
        if (it.type === "ADD")
          a.notable.push({
            player_id: it.player_id,
            name: nameOf(it.player_id, it.name),
            action: "claim_failed",
          });
      continue;
    }
    if ((t.type !== "WAIVER" && t.type !== "FREEAGENT") || !executed(t)) continue;
    if (t.type === "WAIVER") {
      claims += 1;
      a.won += 1;
      wonInWindow.add(team);
    }
    for (const it of t.items) {
      if (it.type === "ADD") {
        adds += 1;
        a.adds += 1;
        bump(added, it.player_id, it.name);
        a.notable.push({
          player_id: it.player_id,
          name: nameOf(it.player_id, it.name),
          action: t.type === "WAIVER" ? "claimed" : "added",
        });
      } else if (it.type === "DROP") {
        drops += 1;
        a.drops += 1;
        bump(dropped, it.player_id, it.name);
        a.notable.push({
          player_id: it.player_id,
          name: nameOf(it.player_id, it.name),
          action: "dropped",
        });
      }
    }
  }

  const teams = [...req.teams].sort((a, b) => a.team_id - b.team_id);
  const by_team = teams.map((t) => {
    const a = agg.get(t.team_id) ?? { adds: 0, drops: 0, won: 0, lost: 0, notable: [] };
    return {
      team_id: t.team_id,
      name: t.name,
      adds: a.adds,
      drops: a.drops,
      claims_won: a.won,
      claims_lost: a.lost,
      notable: a.notable.slice(-ACTIVITY.maxNotable),
    };
  });

  // waiver order movement: down after a won claim = the claim; every team moving with no claim = a reset
  const moved = teams.filter(
    (t) =>
      t.waiver_rank_before !== null &&
      t.waiver_rank_now !== null &&
      t.waiver_rank_before !== t.waiver_rank_now,
  );
  const allMovedNoClaims = moved.length >= Math.max(2, teams.length - 1) && wonInWindow.size === 0;
  const waiver_order_movement = teams.map((t) => {
    const b = t.waiver_rank_before;
    const n = t.waiver_rank_now;
    const cause: "successful_claim" | "reset" | null =
      b !== null && n !== null && n > b && wonInWindow.has(t.team_id)
        ? "successful_claim"
        : b !== null && n !== null && b !== n && allMovedNoClaims
          ? "reset"
          : null;
    return { team_id: t.team_id, rank_before: b, rank_after: n, cause };
  });

  // claims by the claimant's rank before the window
  const rankOf = new Map(teams.map((t) => [t.team_id, t.waiver_rank_before]));
  const byRank = new Map<number, { won: number; lost: number }>();
  for (const t of inWindow) {
    if (t.team_id === null || (t.type !== "WAIVER" && t.type !== "WAIVER_ERROR")) continue;
    if (t.type === "WAIVER" && !executed(t)) continue;
    const r = rankOf.get(t.team_id);
    if (r === null || r === undefined) continue;
    const cur = byRank.get(r) ?? { won: 0, lost: 0 };
    if (t.type === "WAIVER") cur.won += 1;
    else cur.lost += 1;
    byRank.set(r, cur);
  }
  const claims_by_rank = [...byRank.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rank, c]) => ({ rank, won: c.won, lost: c.lost }));

  const top = (m: Map<number, { name: BareText | null; count: number }>) =>
    [...m.entries()]
      .sort(([ia, a], [ib, b]) => b.count - a.count || ia - ib)
      .slice(0, ACTIVITY.maxTop)
      .map(([player_id, v]) => ({ player_id, name: nameOf(player_id, v.name), count: v.count }));

  // rival needs: the weakest starting positions and the free agents who fill them
  const warnings: string[] = [];
  const assumptions: Assumption[] = [];
  let rival_needs: LeagueActivityData["rival_needs"] = [];
  if (req.include_rival_needs !== false) {
    const withPlayers = teams.filter((t) => t.players !== undefined);
    const league = withPlayers.map((t) => t.players ?? []);
    if (withPlayers.length < teams.length)
      warnings.push(
        `${String(teams.length - withPlayers.length)} rosters unreadable: no needs for them`,
      );
    const pool = req.pool ?? [];
    const total = (p: DepthPlayer): number =>
      p.weekly.reduce<number>(
        (s, v) => s + (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0),
        0,
      );
    rival_needs = withPlayers
      .filter((t) => t.team_id !== req.my_team_id)
      .map((t) => {
        const gaps = positionGaps(t.players ?? [], league, req.roster)
          .filter((g) => g.gap > 0)
          .slice(0, ACTIVITY.maxWeakSlots);
        const weak = gaps.map((g) => g.position);
        const worstStarter = (pos: string): number => {
          const vals = (t.players ?? [])
            .filter((p) => p.position === pos)
            .map(total)
            .sort((a, b) => b - a);
          const seats = req.roster.slots
            .filter(
              (s) =>
                s.class === "starter" &&
                s.eligible_positions.length === 1 &&
                s.eligible_positions[0] === pos,
            )
            .reduce((s, x) => s + x.count, 0);
          return vals[Math.max(0, seats - 1)] ?? 0;
        };
        const likely = pool
          .filter((p) => weak.includes(p.position) && total(p) > worstStarter(p.position))
          .sort((a, b) => total(b) - total(a) || a.player_id - b.player_id)
          .slice(0, ACTIVITY.maxTargets)
          .map((p) => p.player_id);
        return {
          team_id: t.team_id,
          weakest_slots: weak,
          likely_targets: likely,
          ir_blocked: t.ir_blocked,
        };
      });
  }

  // the [U] mechanics from the whole feed
  const mechanics = learnWaiverMechanics({
    runs: claimRuns(req.transactions),
    ...(req.order_before === undefined ? {} : { order_before: req.order_before }),
    ...(req.order_after === undefined ? {} : { order_after: req.order_after }),
  });
  if (req.order_before === undefined)
    assumptions.push(
      A(
        "no stored waiver order before each run: the second-claim mechanics stay unlearned",
        "standings snapshots before each run are stored",
      ),
    );

  const me = teams.find((t) => t.team_id === req.my_team_id) ?? null;
  const blocked = rival_needs.filter((r) => r.ir_blocked).map((r) => r.team_id);
  const parts = [
    `${String(claims)} claim${claims === 1 ? "" : "s"} won, ${String(losing)} lost, ${String(trades)} trade${trades === 1 ? "" : "s"} in ${String(days)} days`,
  ];
  const myBefore = me?.waiver_rank_before ?? null;
  const myNow = me?.waiver_rank_now ?? null;
  if (myBefore !== null && myNow !== null)
    parts.push(`my waiver rank ${String(myBefore)} → ${String(myNow)}`);
  if (blocked.length > 0)
    parts.push(
      `${String(blocked.length)} rival${blocked.length === 1 ? "" : "s"} blocked from adding (IR)`,
    );
  const inputs = [...(req.inputs ?? [])];
  const rec: Rec = {
    action: `league digest: ${parts.join("; ")}`,
    subjects: [],
    lineup: null,
    point_estimate: 0,
    distribution: zeroDist("position_cv"),
    delta_vs_next: { value: 0, p10: 0, p90: 0 },
    decision_metric: "activity",
    drivers: [],
    assumptions,
    confidence: { role_games: 0, inputs },
    as_of: newestAsOf(inputs, req.clock.nowIso()),
    latest_execution_time: null,
    no_move: true,
    log_id: null,
  };
  return {
    data: {
      window,
      transactions: { adds, drops, claims, losing_claims: losing, trades, by_team },
      waiver_order_movement,
      claims_by_rank,
      standings_movement: teams.map((t) => ({
        team_id: t.team_id,
        rank_before: t.rank_before,
        rank_after: t.rank_now,
      })),
      top_added: top(added),
      top_dropped: top(dropped),
      rival_needs,
      learned: {
        second_claim_at_new_position: mechanics.second_claim_at_new_position,
        waiver_rank_moves_on_success: mechanics.waiver_rank_moves_on_success,
      },
      rec,
      inputs,
    },
    mechanics,
    warnings,
  };
}
