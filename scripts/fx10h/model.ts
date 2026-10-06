// model.ts — the fx-10h league as a model (research 06 §D.0 "Fixture league fx-10h"; plan 09 §4,
// [A-2]): 10 teams, H2H points, the reference format (half-PPR, 5-point passing TD — 05 §0), lineup
// QB / 2 RB / 2 WR / TE / FLEX / D/ST / K with 5 BE and 2 IR, rolling (move-to-last) waivers with no
// budget, 14 regular-season matchup periods, 6 playoff teams seeded TOTAL_POINTS_SCORED, trade
// deadline 2026-12-02; teams Team 01–Team 10, members in the fake GUID range, league id 0, the user
// Team 02 with waiver rank 2; clock Tuesday of week 5, 21:00 ET. Rosters, lineups and the schedule
// come from league-b's recordings (the 10-team half-PPR league); every scoring field is re-derived
// by the renderer under the reference settings. Variants mutate this model (variants.ts).
import { arr, clone, FixtureGenError, num, obj, type Obj } from "./json.js";
import {
  byeWeeks,
  collectPlayers,
  fillDerivedWeeks,
  recorded,
  recordedParts,
  type PlayerRecord,
} from "./inputs.js";

/** ESPN lineup slot ids (research 03 §B.1). */
export const SLOT = Object.freeze({
  QB: 0,
  RB: 2,
  WR: 4,
  TE: 6,
  DST: 16,
  K: 17,
  BE: 20,
  IR: 21,
  FLEX: 23,
});
/** The fx-10h lineup (05 §0 reference format). */
export const LINEUP_SLOT_COUNTS: Readonly<Record<number, number>> = Object.freeze({
  [SLOT.QB]: 1,
  [SLOT.RB]: 2,
  [SLOT.WR]: 2,
  [SLOT.TE]: 1,
  [SLOT.FLEX]: 1,
  [SLOT.DST]: 1,
  [SLOT.K]: 1,
  [SLOT.BE]: 5,
  [SLOT.IR]: 2,
});

/** The weeks the model holds: 1–4 final, 5 the current (pre-kickoff) week. */
export const FINAL_WEEKS = [1, 2, 3, 4] as const;
export const CURRENT_WEEK = 5;
export const ALL_WEEKS = [1, 2, 3, 4, 5] as const;
export const REGULAR_SEASON_PERIODS = 14;
export const PLAYOFF_TEAMS = 6;
export const LAST_WEEK = 17;
/** The user's team (D.0: Team 02 with waiver rank 2). */
export const MY_TEAM_ID = 2;

/** Epoch ms of an ISO instant. */
export const ms = (iso: string): number => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw new FixtureGenError(`fx-10h: bad instant ${iso}`);
  return t;
};

/** The clocks (all US Eastern Daylight Time, UTC−4, in October 2026). */
export const CLOCKS = Object.freeze({
  /** Tuesday of week 5, 21:00 ET (D.0). */
  base: "2026-10-07T01:00:00.000Z",
  /** Wednesday 06:00 ET, just after the Wednesday 03:30 ET waiver run (post-run). */
  postRun: "2026-10-07T10:00:00.000Z",
  /** Sunday of week 5, 14:05 ET: the 13:00 ET games under way, the late games not (sunday-live). */
  sundayLive: "2026-10-11T18:05:00.000Z",
  /** Monday of week 5, 23:00 ET: every week-5 game has kicked off (all-locked). */
  allLocked: "2026-10-13T03:00:00.000Z",
});

/** The waiver runs (Wednesdays 03:30 ET, the run that clears the week's players — 05 §1.5). */
export const WAIVER_RUNS = Object.freeze({
  previous: "2026-09-30T07:30:00.000Z",
  next: "2026-10-07T07:30:00.000Z",
  following: "2026-10-14T07:30:00.000Z",
});

/** A roster seat of one week. */
export interface Seat {
  readonly playerId: number;
  lineupSlotId: number;
}

/** One fx-10h team. */
export interface TeamModel {
  readonly id: number;
  name: string;
  abbrev: string;
  readonly owners: readonly string[];
  waiverRank: number;
  /** Free text ESPN shows on the team (the injection variants write here). */
  tradeBlockNote: string | null;
  /** The recorded team object (non-scoring fields reused as the template). */
  readonly template: Obj;
}

/** One regular-season matchup. */
export interface MatchupModel {
  readonly id: number;
  readonly period: number;
  readonly home: number;
  readonly away: number;
}

/** A pre-season-derived last-season standings row (the seeding evidence, ADV OBJ-13). */
export interface LastSeasonRow {
  readonly teamId: number;
  readonly wins: number;
  readonly losses: number;
  readonly pointsFor: number;
  readonly pointsAgainst: number;
  readonly seed: number;
}

/** The whole league. */
export interface Model {
  /** `fx-10h` or `fx-10h/<variant>`. */
  name: string;
  leagueName: string;
  divisionName: string;
  clock: string;
  isPublic: boolean;
  usesBudget: boolean;
  budget: number;
  waiverLast: string;
  waiverNext: string;
  playoffMatchupEdited: boolean;
  /** Free-agent pool status in the current week: WAIVERS before the run, FREEAGENT after. */
  poolStatus: "WAIVERS" | "FREEAGENT";
  teams: TeamModel[];
  members: { id: string; displayName: string }[];
  schedule: MatchupModel[];
  /** week → team id → seats. */
  rosters: Map<number, Map<number, Seat[]>>;
  players: Map<number, PlayerRecord>;
  /** Per-player overrides of the recorded injury status (variants). */
  injury: Map<number, string>;
  /** Per-player multiplier of ESPN's week-5 projection (espn-proj-disagree, underdog-9). */
  projectionScale: Map<number, number>;
  /** Players whose week-5 slot ESPN reports locked (sunday-live, all-locked). */
  locked: Set<number>;
  /** Week-5 actual raw stats of players whose game has started (sunday-live, all-locked). */
  live: Map<number, Obj>;
  /** Free text written into a player's season outlook (inj-outlook-system). */
  outlook: Map<number, string>;
  /** Free text written into a player's weekly outlook, by week (inj-ir-cleared). */
  weeklyOutlook: Map<number, Record<string, string>>;
  /** FAAB spent per team (faab). */
  budgetSpent: Map<number, number>;
  /** State fixture mode cannot hold (a credential, a gate), for harnesses — written to the manifest. */
  harness: Obj;
  /** Last season's final standings (null → no previous season: seeding-unknown). */
  lastSeason: LastSeasonRow[] | null;
  /** Synthesised transactions (mTransactions2) and pending claims. */
  transactions: Obj[];
  pending: Obj[];
  /** The derived pro schedule (week 4 final). */
  proSchedule: Obj;
  /** Harness hints a variant needs (written to the manifest's `env`; null removes a key). */
  env: Record<string, string | null>;
  /** One line per variant mutation, for the manifest. */
  notes: string[];
}

const FAKE_GUID = (n: number): string =>
  `{00000000-0000-4000-8000-${n.toString(16).toUpperCase().padStart(12, "0")}}`;

/** Team 01 … Team 10 (D.0). */
export const teamName = (id: number): string => `Team ${String(id).padStart(2, "0")}`;

function seatsOf(body: Obj): Map<number, Seat[]> {
  const out = new Map<number, Seat[]>();
  for (const t of arr(body.teams, "teams")) {
    const team = obj(t, "team");
    const id = num(team.id, "team.id");
    const seats = arr(obj(team.roster, "roster").entries, "entries").map((e) => {
      const entry = obj(e, "entry");
      return {
        playerId: num(entry.playerId, "entry.playerId"),
        lineupSlotId: num(entry.lineupSlotId, "entry.lineupSlotId"),
      };
    });
    out.set(id, seats);
  }
  return out;
}

const isStarter = (slot: number): boolean => slot !== SLOT.BE && slot !== SLOT.IR;

/**
 * The 6-BE league-b rosters fitted to 5 BE + 2 IR: a benched OUT / INJURY_RESERVE player moves to
 * IR (research 05 §4.3: the only IR-eligible statuses); otherwise the least-owned player who never
 * started in weeks 1–3 is released to the pool. Applied to every week, so the box scores are the
 * recorded lineups (a bench player scores nothing — totals are unchanged by the move).
 */
function fitBench(
  rosters: Map<number, Map<number, Seat[]>>,
  players: Map<number, PlayerRecord>,
): void {
  const sp3 = rosters.get(3);
  if (sp3 === undefined) throw new FixtureGenError("fx-10h: no week-3 rosters");
  for (const [teamId, seats] of sp3) {
    const bench = seats.filter((s) => s.lineupSlotId === SLOT.BE);
    if (bench.length <= 5) continue;
    const everStarted = (pid: number): boolean =>
      [1, 2, 3].some((w) =>
        (rosters.get(w)?.get(teamId) ?? []).some(
          (s) => s.playerId === pid && isStarter(s.lineupSlotId),
        ),
      );
    const statusOf = (pid: number): string => {
      const v = players.get(pid)?.player.injuryStatus;
      return typeof v === "string" ? v : "ACTIVE";
    };
    const owned = (pid: number): number => {
      const o = players.get(pid)?.player.ownership;
      const p =
        o !== undefined && typeof o === "object" && o !== null && !Array.isArray(o)
          ? o.percentOwned
          : null;
      return typeof p === "number" ? p : 0;
    };
    const irCandidates = bench.filter((s) =>
      ["OUT", "INJURY_RESERVE"].includes(statusOf(s.playerId)),
    );
    const toIr = irCandidates.slice(0, Math.min(2, bench.length - 5));
    for (const w of [1, 2, 3]) {
      for (const s of rosters.get(w)?.get(teamId) ?? []) {
        if (toIr.some((t) => t.playerId === s.playerId) && s.lineupSlotId === SLOT.BE)
          s.lineupSlotId = SLOT.IR;
      }
    }
    let excess = bench.length - toIr.length - 5;
    const releasable = bench
      .filter((s) => !toIr.includes(s) && !everStarted(s.playerId))
      .sort((a, b) => owned(a.playerId) - owned(b.playerId) || a.playerId - b.playerId);
    for (const r of releasable) {
      if (excess <= 0) break;
      for (const w of [1, 2, 3]) {
        const list = rosters.get(w)?.get(teamId);
        if (list === undefined) continue;
        const i = list.findIndex((s) => s.playerId === r.playerId && !isStarter(s.lineupSlotId));
        if (i >= 0) list.splice(i, 1);
      }
      excess--;
    }
    if (excess > 0) throw new FixtureGenError(`fx-10h: team ${String(teamId)} cannot fit 5 BE`);
  }
}

/** Which slots a player may fill (the recorded eligibleSlots). */
export function eligible(players: Map<number, PlayerRecord>, pid: number): readonly number[] {
  const e = players.get(pid)?.player.eligibleSlots;
  return Array.isArray(e) ? e.filter((x): x is number => typeof x === "number") : [];
}

/** The pro team a player plays for this season (0 = none). */
export function proTeamOf(players: Map<number, PlayerRecord>, pid: number): number {
  const t = players.get(pid)?.player.proTeamId;
  return typeof t === "number" ? t : 0;
}

/**
 * A week's lineup copied from week 3, with any starter whose pro team is on bye that week swapped
 * for the bench player eligible for the slot with the highest projection (what a manager does on
 * Tuesday). Week 4 is final (derived), week 5 is the current week.
 */
function deriveWeek(
  week: number,
  base: Map<number, Seat[]>,
  players: Map<number, PlayerRecord>,
  byes: Map<number, number>,
): Map<number, Seat[]> {
  const out = new Map<number, Seat[]>();
  const onBye = (pid: number): boolean => byes.get(proTeamOf(players, pid)) === week;
  const proj = (pid: number): number => {
    const raw = players.get(pid)?.projected.get(week);
    return raw === undefined ? -1 : Object.keys(raw).length;
  };
  for (const [teamId, seats] of base) {
    const list = seats.map((s) => ({ ...s }));
    for (const s of list) {
      if (!isStarter(s.lineupSlotId) || !onBye(s.playerId)) continue;
      const sub = list
        .filter((b) => b.lineupSlotId === SLOT.BE && !onBye(b.playerId))
        .filter((b) => eligible(players, b.playerId).includes(s.lineupSlotId))
        .sort((a, b) => proj(b.playerId) - proj(a.playerId) || a.playerId - b.playerId)[0];
      if (sub === undefined) continue;
      sub.lineupSlotId = s.lineupSlotId;
      s.lineupSlotId = SLOT.BE;
    }
    out.set(teamId, list);
  }
  return out;
}

/** The pro schedule with week 4 final (derived from the recorded view; nothing else changes). */
function deriveProSchedule(): Obj {
  const body = clone(recorded("season/proTeamSchedules_wl.json"));
  for (const t of arr(obj(body.settings, "settings").proTeams, "proTeams")) {
    const games = obj(t, "proTeam").proGamesByScoringPeriod;
    if (games === undefined || games === null || typeof games !== "object" || Array.isArray(games))
      continue;
    for (const g of arr(games["4"] ?? [], "week 4 games")) obj(g, "game").statsOfficial = true;
  }
  return body;
}

/** Roster moves between recorded weeks, as FREEAGENT / WAIVER transactions (synthetic ids). */
function deriveTransactions(rosters: Map<number, Map<number, Seat[]>>): Obj[] {
  const out: Obj[] = [];
  let n = 0x80;
  const proc = (week: number): number =>
    ms(week === 2 ? "2026-09-16T07:30:00.000Z" : "2026-09-23T07:30:00.000Z");
  for (const week of [2, 3]) {
    const before = rosters.get(week - 1);
    const after = rosters.get(week);
    if (before === undefined || after === undefined) continue;
    for (const [teamId, seats] of after) {
      const had = new Set((before.get(teamId) ?? []).map((s) => s.playerId));
      const added = seats.filter((s) => !had.has(s.playerId));
      const now = new Set(seats.map((s) => s.playerId));
      const dropped = [...had].filter((p) => !now.has(p));
      added.forEach((a, i) => {
        const drop = dropped[i];
        const type = (n & 1) === 0 ? "WAIVER" : "FREEAGENT";
        const items: Obj[] = [
          {
            type: "ADD",
            playerId: a.playerId,
            fromTeamId: 0,
            toTeamId: teamId,
            fromLineupSlotId: -1,
            toLineupSlotId: SLOT.BE,
            isKeeper: false,
          },
        ];
        if (drop !== undefined)
          items.push({
            type: "DROP",
            playerId: drop,
            fromTeamId: teamId,
            toTeamId: 0,
            fromLineupSlotId: SLOT.BE,
            toLineupSlotId: -1,
            isKeeper: false,
          });
        out.push({
          id: FAKE_GUID(n++).slice(1, -1),
          type,
          status: "EXECUTED",
          teamId,
          scoringPeriodId: week,
          proposedDate: proc(week) - 36 * 3600_000,
          processDate: proc(week),
          bidAmount: 0,
          isPending: false,
          items,
        });
      });
    }
  }
  // one losing claim (a WAIVER_ERROR row) for the user's team: the claimed player went elsewhere
  const winner = out.find((t) => t.type === "WAIVER" && t.teamId !== MY_TEAM_ID);
  if (winner !== undefined) {
    const items = arr(winner.items, "items");
    const add = obj(items[0], "item");
    out.push({
      id: FAKE_GUID(n++).slice(1, -1),
      type: "WAIVER_ERROR",
      status: "FAILED_INVALIDPLAYERSOURCE",
      teamId: MY_TEAM_ID,
      scoringPeriodId: winner.scoringPeriodId ?? 2,
      proposedDate: num(winner.proposedDate, "proposedDate") + 3600_000,
      processDate: winner.processDate ?? 0,
      bidAmount: 0,
      isPending: false,
      items: [{ ...add, toTeamId: MY_TEAM_ID }],
    });
  }
  if (n > 0xbf)
    throw new FixtureGenError("fx-10h: too many synthetic transactions for the id range");
  return out;
}

/** Last season (2025): seeds follow the record (ESPN's rule), points-for disagreeing in the field. */
export function lastSeasonRows(mode: "espn_rule" | "points_only"): LastSeasonRow[] {
  // [team id, wins, points for] — ten teams, 14 games; PF ordered differently from the record
  const table: readonly [number, number, number][] = [
    [4, 11, 1612.4],
    [7, 10, 1688.9],
    [2, 9, 1540.2],
    [9, 9, 1702.6],
    [1, 8, 1575.8],
    [5, 7, 1598.1],
    [3, 6, 1490.3],
    [10, 5, 1655.0],
    [6, 4, 1433.7],
    [8, 1, 1380.5],
  ];
  const rows = table.map(([teamId, wins, pf]) => ({
    teamId,
    wins,
    losses: 14 - wins,
    pointsFor: pf,
    pointsAgainst: Math.round((3100 - pf) * 10) / 10,
  }));
  const order =
    mode === "espn_rule"
      ? [...rows].sort((a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor)
      : [...rows].sort((a, b) => b.pointsFor - a.pointsFor);
  return order.map((r, i) => ({ ...r, seed: i + 1 }));
}

/** Builds the base fx-10h model from the recordings. */
export function baseModel(): Model {
  const players = collectPlayers();
  // DAY_TO_DAY (recorded on a few pool entries of the other leagues) is read as QUESTIONABLE by the
  // analytics [U]; the base league states it as QUESTIONABLE so its drift stays green.
  for (const p of players.values())
    if (p.player.injuryStatus === "DAY_TO_DAY") p.player.injuryStatus = "QUESTIONABLE";
  const byes = byeWeeks();
  fillDerivedWeeks(players, byes);
  const rosters = new Map<number, Map<number, Seat[]>>();
  for (const w of [1, 2, 3])
    rosters.set(w, seatsOf(recordedParts(`league-b/mRoster.sp${String(w)}`)));
  fitBench(rosters, players);
  const sp3 = rosters.get(3);
  if (sp3 === undefined) throw new FixtureGenError("fx-10h: no week-3 rosters");
  rosters.set(4, deriveWeek(4, sp3, players, byes));
  rosters.set(5, deriveWeek(5, sp3, players, byes));

  const teamBody = recorded("league-b/mTeam.json");
  const teams: TeamModel[] = arr(teamBody.teams, "teams").map((t) => {
    const team = obj(t, "team");
    const id = num(team.id, "team.id");
    return {
      id,
      name: teamName(id),
      abbrev: `T${String(id).padStart(2, "0")}`,
      owners: id === 10 ? [FAKE_GUID(10), FAKE_GUID(11)] : [FAKE_GUID(id)],
      waiverRank: 0,
      tradeBlockNote: null,
      template: clone(team),
    };
  });
  teams.sort((a, b) => a.id - b.id);
  if (teams.length !== 10) throw new FixtureGenError("fx-10h: league-b must have 10 teams");
  const members = Array.from({ length: 11 }, (_, i) => ({
    id: FAKE_GUID(i + 1),
    displayName: `Member ${String(i + 1).padStart(2, "0")}`,
  }));

  const matchupBody = recorded("league-b/mMatchup.json");
  const schedule: MatchupModel[] = arr(matchupBody.schedule, "schedule")
    .map((m) => {
      const mm = obj(m, "matchup");
      return {
        id: num(mm.id, "matchup.id"),
        period: num(mm.matchupPeriodId, "matchupPeriodId"),
        home: num(obj(mm.home, "home").teamId, "home.teamId"),
        away: num(obj(mm.away, "away").teamId, "away.teamId"),
      };
    })
    .filter((m) => m.period <= REGULAR_SEASON_PERIODS)
    .sort((a, b) => a.id - b.id);

  return {
    name: "fx-10h",
    leagueName: "Example League",
    divisionName: "Division 1",
    clock: CLOCKS.base,
    // public: fixture mode never holds a cookie, so the Skills league answers every view keylessly
    // (a private league would answer ESPN_REQUIRES_COOKIES on mTransactions2 — decision recorded)
    isPublic: true,
    usesBudget: false,
    budget: 0,
    waiverLast: WAIVER_RUNS.previous,
    waiverNext: WAIVER_RUNS.next,
    playoffMatchupEdited: false,
    poolStatus: "WAIVERS",
    teams,
    members,
    schedule,
    rosters,
    players,
    injury: new Map(),
    projectionScale: new Map(),
    locked: new Set(),
    live: new Map(),
    outlook: new Map(),
    weeklyOutlook: new Map(),
    budgetSpent: new Map(),
    harness: { credential_state: "not_configured" },
    lastSeason: lastSeasonRows("espn_rule"),
    transactions: deriveTransactions(rosters),
    pending: [],
    proSchedule: deriveProSchedule(),
    env: { ESPN_LEAGUE_ID: "0", ESPN_TEAM_ID: String(MY_TEAM_ID), EFF_TOOLSET: "core" },
    notes: [],
  };
}

/** The players rostered in a week (any team). */
export function rosteredIn(model: Model, week: number): Set<number> {
  const out = new Set<number>();
  for (const seats of model.rosters.get(week)?.values() ?? [])
    for (const s of seats) out.add(s.playerId);
  return out;
}

/** The team a player is on in a week, or 0. */
export function teamOf(model: Model, week: number, pid: number): number {
  for (const [teamId, seats] of model.rosters.get(week) ?? new Map<number, Seat[]>())
    if (seats.some((s) => s.playerId === pid)) return teamId;
  return 0;
}

/** The kickoff (epoch ms) of a pro team's game in a week, or null (bye / TBD). */
export function kickoffOf(model: Model, week: number, proTeamId: number): number | null {
  for (const t of arr(obj(model.proSchedule.settings, "settings").proTeams, "proTeams")) {
    const team = obj(t, "proTeam");
    if (team.id !== proTeamId) continue;
    const games = team.proGamesByScoringPeriod;
    if (games === undefined || games === null || typeof games !== "object" || Array.isArray(games))
      return null;
    const list = arr(games[String(week)] ?? [], "games");
    const g = list[0];
    if (g === undefined) return null;
    const game = obj(g, "game");
    if (game.startTimeTBD === true) return null;
    return typeof game.date === "number" ? game.date : null;
  }
  return null;
}
