// history-moves.ts — a probe league's previous season, read the way the product reads one, turned
// into the league's own transaction feed (changelog R6-3). The probe leagues' finished seasons carry
// no mTransactions2 keylessly, but every team's weekly roster is recorded for league-b 2024–2025
// (box scores through the REAL provider in fixture mode over the history manifest). The roster
// changes between week w and w + 1 ARE the season's moves; they are written as the transactions
// ESPN would have served: a player who left team T is a DROP (an executed FREEAGENT row by T, the
// evening after week w), a player who joined T is an ADD — a WAIVER claim when another team dropped
// him in the same change (the claim processed the next morning), else a FREEAGENT add. That is the
// reading research 05's calibration used (claimed = rostered by another team the next week); a
// re-add after the player cleared therefore counts as a claim (the doc says so). A team whose
// roster had an entry withheld by the scrub in either week makes no moves in that change. League
// ids are 0, teams are ids, every player is an id: no identifier, nothing third-party is read as
// text. Test-only.
import type {
  BoxScoreMatchup,
  Standing,
  Transaction,
} from "../../../../../src/domain/league/types.js";
import {
  historyEntries,
  historyFixtureFetch,
} from "../../../../fixtures/helpers/history-fixtures.js";
import { makeWorld, type LeagueSlot } from "../../../../providers/espn/helpers.js";

/** Position id → its dedicated starting slot id (QB 0, RB 2, WR 4, TE 6, K 17, D/ST 16). */
const POS_SLOT: Readonly<Record<number, string>> = {
  1: "0",
  2: "2",
  3: "4",
  4: "6",
  5: "17",
  16: "16",
};

/** One rostered player in one week: his position and ESPN's projection for that week. */
export interface Seat {
  readonly position_id: number;
  readonly proj: number | null;
}
/** team id → player id → seat. */
export type Rosters = Map<number, Map<number, Seat>>;

/** One previous season as the product's provider reads it. */
export interface PreviousSeason {
  readonly slot: LeagueSlot;
  readonly season: number;
  /** Team ids from the season's standings. */
  readonly teams: readonly number[];
  /** The regular season's last scoring period (matchupPeriodCount; one period per matchup). */
  readonly regular: number | null;
  /** The weekly rosters (null when the season's box scores were not recorded/served). */
  readonly weeks: ReadonlyMap<number, Rosters> | null;
  /** Teams with a withheld entry, by week. */
  readonly incomplete: ReadonlyMap<number, ReadonlySet<number>>;
  /** The lineup seat counts (replacement level). */
  readonly slot_counts: Readonly<Record<string, number>>;
  /** Per-team acquisition totals by matchup period (ESPN's counters; keyless). */
  readonly standings: readonly Standing[];
}

function rostersOf(box: readonly BoxScoreMatchup[]): Rosters {
  const out: Rosters = new Map();
  for (const m of box)
    for (const side of [m.home, m.away]) {
      if (side === null) continue;
      const seats = new Map<number, Seat>();
      for (const e of side.entries)
        seats.set(e.player.ref.id, {
          position_id: e.player.position_id,
          proj: e.projected?.applied_total ?? null,
        });
      out.set(side.team_id, seats);
    }
  return out;
}

/**
 * Reads one previous season through the real provider in fixture mode (keyless, no network): its
 * league clock, rules and roster slots (a previous season's settings read asks for mSettings alone),
 * standings, and every week's box score when the season has them. The limiter is the product's own
 * (the test clock moves 2.5 s between reads, so its 30-a-minute cap is never the reason a read fails).
 */
export async function readPreviousSeason(
  slot: LeagueSlot,
  season: number,
): Promise<PreviousSeason> {
  const w = makeWorld({ fetch: historyFixtureFetch(slot) });
  const ref = { ...w.ref, season };
  const league = (await w.provider.getLeague(ref)).value;
  const rules = (await w.provider.getLeagueRules(ref)).value;
  const slots = (await w.provider.getRosterSlots(ref)).value;
  w.clock.advance(2500);
  const standings = (await w.provider.getStandings(ref)).value.teams;
  const regMatchups = rules.playoffs.regular_season_matchups;
  let regular: number | null = null;
  if (regMatchups !== null)
    for (const [k, ws] of Object.entries(rules.playoffs.matchup_periods))
      if (Number(k) <= regMatchups) for (const x of ws) regular = Math.max(regular ?? 0, x);
  const finalPeriod = league.clock.final_scoring_period;
  const weeks = new Map<number, Rosters>();
  const incomplete = new Map<number, Set<number>>();
  let served = true;
  for (let wk = 1; wk <= finalPeriod; wk++) {
    if (historyEntries(season, slot, `mBoxscore.sp${String(wk)}`).length === 0) {
      served = false;
      break;
    }
    // the product's limiter governs these reads too (≤ 30 a minute): the test clock moves on
    w.clock.advance(2500);
    const box = await w.provider.getBoxScores(ref, wk);
    weeks.set(wk, rostersOf(box.value));
    const inc = new Set<number>();
    for (const e of historyEntries(season, slot, `mBoxscore.sp${String(wk)}`))
      for (const t of e.incomplete?.team_ids ?? []) inc.add(t);
    incomplete.set(wk, inc);
  }
  return {
    slot,
    season,
    teams: standings.map((t) => t.team_id).sort((a, b) => a - b),
    regular,
    weeks: served && weeks.size > 0 ? weeks : null,
    incomplete,
    slot_counts: Object.fromEntries(slots.slots.map((x) => [String(x.slot_id), x.count])),
    standings,
  };
}

const DAY = 24 * 3600 * 1000;
/** The evening after week w's games (a Tuesday-like instant), deterministic per season. */
function dropInstant(season: number, week: number): number {
  return Date.UTC(season, 8, 3, 23, 0, 0) + week * 7 * DAY;
}

function tx(
  id: string,
  type: "FREEAGENT" | "WAIVER",
  team: number,
  week: number,
  ms: number,
  item: { type: "ADD" | "DROP"; player: number },
): Transaction {
  return {
    transaction_id: id,
    type,
    status: "EXECUTED",
    team_id: team,
    team_name: null,
    scoring_period: week,
    process_date: new Date(ms).toISOString(),
    proposed_date: null,
    bid_amount: null,
    items: [
      {
        type: item.type,
        player_id: item.player,
        name: null,
        from_team_id: item.type === "DROP" ? team : null,
        to_team_id: item.type === "ADD" ? team : null,
        from_slot: null,
        to_slot: null,
      },
    ],
    related_transaction_id: null,
    note: null,
  };
}

/** The season's moves as transactions (see the header). Empty when its rosters were not recorded. */
export function movesFromRosters(s: PreviousSeason): Transaction[] {
  const weeks = s.weeks;
  if (weeks === null) return [];
  const out: Transaction[] = [];
  const last = Math.max(...weeks.keys());
  for (let w = 1; w < last; w++) {
    const now = weeks.get(w);
    const next = weeks.get(w + 1);
    if (now === undefined || next === undefined) continue;
    const skip = new Set([...(s.incomplete.get(w) ?? []), ...(s.incomplete.get(w + 1) ?? [])]);
    const dropMs = dropInstant(s.season, w);
    const droppedBy = new Map<number, number[]>();
    for (const [team, seats] of now) {
      if (skip.has(team)) continue;
      for (const player of seats.keys())
        if (!(next.get(team)?.has(player) ?? false)) {
          droppedBy.set(player, [...(droppedBy.get(player) ?? []), team]);
          out.push(
            tx(
              `h${String(s.season)}-${String(w)}-d-${String(team)}-${String(player)}`,
              "FREEAGENT",
              team,
              w,
              dropMs,
              {
                type: "DROP",
                player,
              },
            ),
          );
        }
    }
    for (const [team, seats] of next) {
      if (skip.has(team)) continue;
      for (const player of seats.keys()) {
        if (now.get(team)?.has(player) ?? false) continue;
        const claim = (droppedBy.get(player) ?? []).some((t) => t !== team);
        out.push(
          tx(
            `h${String(s.season)}-${String(w)}-a-${String(team)}-${String(player)}`,
            claim ? "WAIVER" : "FREEAGENT",
            team,
            w,
            dropMs + (claim ? 0.5 * DAY : DAY),
            { type: "ADD", player },
          ),
        );
      }
    }
  }
  return out;
}

/**
 * A player's value in a week as research 05's calibration read it: ESPN's projection for that week
 * over the league's replacement projection at his position (the last dedicated starter, every
 * rostered player ranked; the worst rostered when fewer are rostered than there are seats). Null
 * when the player was not rostered that week (no projection is recorded for him).
 */
export function valueAtFromRosters(
  s: PreviousSeason,
): (player: number, week: number) => number | null {
  const weeks = s.weeks;
  const repl = new Map<number, Map<number, number>>();
  const teams = s.teams.length;
  return (player, week) => {
    const rosters = weeks?.get(week);
    if (rosters === undefined) return null;
    let seat: Seat | undefined;
    for (const seats of rosters.values()) {
      const hit = seats.get(player);
      if (hit !== undefined) {
        seat = hit;
        break;
      }
    }
    if (seat === undefined) return null;
    const proj = seat.proj;
    if (proj === null || !Number.isFinite(proj)) return null;
    let byPos = repl.get(week);
    if (byPos === undefined) {
      byPos = new Map<number, number>();
      const projs = new Map<number, number[]>();
      for (const seats of rosters.values())
        for (const x of seats.values())
          if (x.proj !== null && Number.isFinite(x.proj))
            projs.set(x.position_id, [...(projs.get(x.position_id) ?? []), x.proj]);
      for (const [pos, ps] of projs) {
        const slot = POS_SLOT[pos];
        const starters = slot === undefined ? 0 : (s.slot_counts[slot] ?? 0);
        const sorted = [...ps].sort((a, b) => b - a);
        byPos.set(
          pos,
          starters > 0 ? (sorted[Math.min(teams * starters, sorted.length) - 1] ?? 0) : 0,
        );
      }
      repl.set(week, byPos);
    }
    return Math.max(0, proj - (byPos.get(seat.position_id) ?? 0));
  };
}
