// helpers.ts — test-side adapters for the league model: the recorded ESPN bodies (fixtures/espn/
// recorded, scrubbed public leagues) mapped onto the wire-free league-model inputs exactly as the
// provider's normaliser is expected to map them (research 03 §B.1 paths), plus the hand-written
// reference-format settings (research 05 "the reference league": 10 teams, half-PPR, 5-pt pass TD,
// QB/2RB/2WR/TE/FLEX/D/ST/K + 5 BE + 2 IR, rolling move-to-last, 6 playoff teams,
// TOTAL_POINTS_SCORED, 14 regular-season matchups, deadline 2026-12-02). Placeholders only.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { RosterSeat } from "../../../src/domain/league/roster.js";
import type { SeasonStandingInput } from "../../../src/domain/league/seeding.js";
import { POSITION_NAMES } from "../../../src/domain/league/slots.js";
import type {
  LeagueSettingsInput,
  ProGame,
  ProSchedule,
  ProTeam,
} from "../../../src/domain/league/types.js";

export const REPO = path.resolve(import.meta.dirname, "..", "..", "..");
export const RECORDED = path.join(REPO, "fixtures", "espn", "recorded");
export type RecordedLeague = "league-a" | "league-b" | "league-c";
export const LEAGUES: readonly RecordedLeague[] = ["league-a", "league-b", "league-c"];

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
const num = (o: Obj, k: string): number | null => (typeof o[k] === "number" ? o[k] : null);
const bool = (o: Obj, k: string): boolean | null => (typeof o[k] === "boolean" ? o[k] : null);
const str = (o: Obj, k: string): string | null => (typeof o[k] === "string" ? o[k] : null);
const numRecord = (v: unknown): Record<string, number> =>
  Object.fromEntries(
    Object.entries(obj(v)).filter((e): e is [string, number] => typeof e[1] === "number"),
  );

/** Reads one recorded JSON body. */
export function readRecorded(rel: string): unknown {
  return JSON.parse(readFileSync(path.join(RECORDED, rel), "utf8")) as unknown;
}

/** camelCase → snake_case (financeSettings keys; an acronym stays one word: `playerMoveToIR`). */
const snake = (k: string): string => k.replace(/([a-z0-9])([A-Z]+)/g, "$1_$2").toLowerCase();

/**
 * An `mSettings`-shaped body (`{ settings, status }`) → LeagueSettingsInput: the mapping the
 * provider's normaliser performs (one field per research 03 §B.1 path).
 */
export function settingsInputFromWire(body: unknown): LeagueSettingsInput {
  const b = obj(body);
  const s = obj(b.settings);
  const status = obj(b.status);
  const acq = obj(s.acquisitionSettings);
  const roster = obj(s.rosterSettings);
  const sched = obj(s.scheduleSettings);
  const trade = obj(s.tradeSettings);
  const scoring = obj(s.scoringSettings);
  const fin = s.financeSettings;
  const days = acq.waiverProcessDays;
  const periods = sched.matchupPeriods;
  return {
    roster: {
      slot_counts: numRecord(roster.lineupSlotCounts),
      position_limits: numRecord(roster.positionLimits),
      lineup_lock_type: str(roster, "lineupLocktimeType"),
      undroppable_list: bool(roster, "isUsingUndroppableList"),
      move_limit: num(roster, "moveLimit"),
    },
    acquisition: {
      acquisition_type: str(acq, "acquisitionType"),
      uses_budget: bool(acq, "isUsingAcquisitionBudget"),
      budget: num(acq, "acquisitionBudget"),
      order_reset: bool(acq, "waiverOrderReset"),
      acquisition_limit: num(acq, "acquisitionLimit"),
      matchup_acquisition_limit: num(acq, "matchupAcquisitionLimit"),
      min_bid: num(acq, "minimumBid"),
      waiver_hours: num(acq, "waiverHours"),
      process_days: Array.isArray(days)
        ? days.filter((d): d is string => typeof d === "string")
        : null,
      process_hour: num(acq, "waiverProcessHour"),
      matchup_limit_per_period: bool(acq, "matchupLimitPerScoringPeriod"),
      next_execution_ms: num(status, "waiverNextExecutionDate"),
      last_execution_ms: num(status, "waiverLastExecutionDate"),
    },
    schedule: {
      regular_season_matchups: num(sched, "matchupPeriodCount"),
      matchup_periods:
        typeof periods === "object" && periods !== null
          ? Object.fromEntries(
              Object.entries(periods).map(([k, v]) => [
                k,
                Array.isArray(v) ? v.filter((w): w is number => typeof w === "number") : [],
              ]),
            )
          : null,
      playoff_team_count: num(sched, "playoffTeamCount"),
      playoff_matchup_period_length: num(sched, "playoffMatchupPeriodLength"),
      variable_playoff_length: bool(sched, "variablePlayoffMatchupPeriodLength"),
      playoff_reseed: bool(sched, "playoffReseed"),
      playoff_seeding_rule: str(sched, "playoffSeedingRule"),
      playoff_seeding_rule_by: num(sched, "playoffSeedingRuleBy"),
      consolation_ladder_disabled: bool(sched, "consolationLadderDisabled"),
    },
    trade: {
      deadline_ms: num(trade, "deadlineDate"),
      revision_hours: num(trade, "revisionHours"),
      veto_votes_required: num(trade, "vetoVotesRequired"),
      max: num(trade, "max"),
    },
    ties: {
      matchup_tie_rule: str(scoring, "matchupTieRule"),
      playoff_tie_rule: str(scoring, "playoffMatchupTieRule"),
    },
    fees:
      typeof fin === "object" && fin !== null
        ? Object.fromEntries(Object.entries(numRecord(fin)).map(([k, v]) => [snake(k), v]))
        : null,
  };
}

/** A recorded league's settings input. */
export function recordedSettings(league: RecordedLeague): LeagueSettingsInput {
  return settingsInputFromWire(readRecorded(`${league}/mSettings.json`));
}

/** The recorded `proTeamSchedules_wl` → the domain ProSchedule (keeps the TBD placeholder date). */
export function proScheduleFromWire(body: unknown, season = 2026): ProSchedule {
  const teams: ProTeam[] = [];
  const games = new Map<number, ProGame>();
  const pts = obj(obj(body).settings).proTeams;
  for (const t of Array.isArray(pts) ? pts : []) {
    const team = obj(t);
    const id = num(team, "id");
    if (id === null) continue;
    teams.push({ id, abbrev: str(team, "abbrev") ?? "", bye_week: num(team, "byeWeek") });
    for (const [week, list] of Object.entries(obj(team.proGamesByScoringPeriod)))
      for (const g of Array.isArray(list) ? list : []) {
        const game = obj(g);
        const gid = num(game, "id");
        const date = num(game, "date");
        if (gid === null) continue;
        games.set(gid, {
          espn_game_id: gid,
          season,
          week: Number(week),
          kickoff: date === null ? null : new Date(date).toISOString(),
          start_time_tbd: bool(game, "startTimeTBD") === true,
          valid_for_locking: bool(game, "validForLocking") === true,
          stats_official: bool(game, "statsOfficial") === true,
          home_pro_team_id: num(game, "homeProTeamId") ?? -1,
          away_pro_team_id: num(game, "awayProTeamId") ?? -1,
        });
      }
  }
  return {
    season,
    teams,
    games: [...games.values()].sort((a, b) => a.espn_game_id - b.espn_game_id),
  };
}

let cachedSchedule: ProSchedule | null = null;
/** The recorded 2026 pro schedule (272 games, 33 teams incl. FA). */
export function recordedSchedule(): ProSchedule {
  cachedSchedule ??= proScheduleFromWire(readRecorded("season/proTeamSchedules_wl.json"));
  return cachedSchedule;
}

interface ManifestFile {
  readonly path: string;
  readonly incomplete?: { readonly team_ids?: readonly number[] } | null;
  readonly part?: unknown;
}

/** The manifest's file entries. */
function manifestFiles(): ManifestFile[] {
  const m = JSON.parse(
    readFileSync(path.join(REPO, "fixtures", "espn", "manifest.json"), "utf8"),
  ) as {
    files: ManifestFile[] | Record<string, ManifestFile>;
  };
  return Array.isArray(m.files) ? m.files : Object.values(m.files);
}

/** The recorded mRoster part files of a league-week, in part order. */
export function rosterParts(league: RecordedLeague, week: number): string[] {
  return manifestFiles()
    .map((f) => f.path)
    .filter((p) => p.startsWith(`recorded/${league}/mRoster.sp${String(week)}.`))
    .sort()
    .map((p) => p.slice("recorded/".length));
}

/**
 * Team ids a withheld unit left incomplete in a league-week's roster (fixtures/espn/recorded/
 * README: an empty slot there is an artefact of withholding, not ESPN data).
 */
export function incompleteRosterTeams(league: RecordedLeague, week: number): Set<number> {
  const out = new Set<number>();
  for (const f of manifestFiles())
    if (f.path.startsWith(`recorded/${league}/mRoster.sp${String(week)}.`))
      for (const id of f.incomplete?.team_ids ?? []) out.add(id);
  return out;
}

/** Every team's seats in a recorded league-week (parts concatenated along `teams`). */
export function recordedSeats(league: RecordedLeague, week: number): Map<number, RosterSeat[]> {
  const out = new Map<number, RosterSeat[]>();
  for (const part of rosterParts(league, week)) {
    const teams = obj(readRecorded(part)).teams;
    for (const t of Array.isArray(teams) ? teams : []) {
      const team = obj(t);
      const id = num(team, "id");
      if (id === null) continue;
      const seats = out.get(id) ?? [];
      const entries = obj(team.roster).entries;
      for (const e of Array.isArray(entries) ? entries : []) {
        const entry = obj(e);
        const player = obj(obj(entry.playerPoolEntry).player);
        const pos = num(player, "defaultPositionId");
        const elig = player.eligibleSlots;
        seats.push({
          player_id: num(entry, "playerId") ?? 0,
          slot_id: num(entry, "lineupSlotId") ?? -1,
          eligible_slot_ids: Array.isArray(elig)
            ? elig.filter((x): x is number => typeof x === "number")
            : [],
          injury_status: str(player, "injuryStatus"),
          position: pos === null ? null : (POSITION_NAMES[pos] ?? null),
          pro_team_id: num(player, "proTeamId"),
        });
      }
      out.set(id, seats);
    }
  }
  return out;
}

/** A recorded `mTeam` body → final-standing inputs (this season's, as a stand-in for last season's). */
export function standingsFromWire(body: unknown): SeasonStandingInput[] {
  const teams = obj(body).teams;
  return (Array.isArray(teams) ? teams : []).map((t) => {
    const team = obj(t);
    const overall = obj(obj(team.record).overall);
    return {
      team_id: num(team, "id") ?? 0,
      seed: num(team, "playoffSeed"),
      division_id: num(team, "divisionId"),
      wins: num(overall, "wins") ?? 0,
      losses: num(overall, "losses") ?? 0,
      ties: num(overall, "ties") ?? 0,
      points_for: num(overall, "pointsFor") ?? 0,
    };
  });
}

const periods17 = Object.fromEntries(
  Array.from({ length: 17 }, (_, i) => [String(i + 1), [i + 1]]),
);
const slotCounts = (over: Record<number, number>): Record<string, number> =>
  Object.fromEntries(Array.from({ length: 25 }, (_, i) => [String(i), over[i] ?? 0]));

/**
 * The reference-format league, hand-written as an `mSettings` body (research 05 "The reference
 * league"; HANDOFF D1): 10 teams, H2H points, half-PPR (stat 53 at 0.5) with 5-pt passing TDs and
 * −2/−2 turnovers, QB/2RB/2WR/TE/FLEX/D/ST/K + 5 BE + 2 IR, no budget on WAIVERS_TRADITIONAL with
 * `waiverOrderReset: false` (rolling move-to-last), 24-hour waivers, 14 regular-season matchups,
 * 6 playoff teams in 1-week rounds (weeks 15–17), reseeding off, consolation on,
 * TOTAL_POINTS_SCORED, trade deadline Wednesday 2026-12-02. Not a recording: placeholder names only.
 */
export const REFERENCE_MSETTINGS = Object.freeze({
  id: 0,
  seasonId: 2026,
  scoringPeriodId: 5,
  status: {
    currentMatchupPeriod: 5,
    finalScoringPeriod: 17,
    firstScoringPeriod: 1,
    isActive: true,
    isPlayoffMatchupEdited: false,
    latestScoringPeriod: 5,
    previousSeasons: [2024, 2025],
    waiverLastExecutionDate: Date.UTC(2026, 9, 7, 7, 30),
  },
  settings: {
    name: "Example League",
    size: 10,
    isPublic: false,
    acquisitionSettings: {
      acquisitionBudget: 100,
      acquisitionLimit: -1,
      acquisitionType: "WAIVERS_TRADITIONAL",
      isUsingAcquisitionBudget: false,
      matchupAcquisitionLimit: 0,
      matchupLimitPerScoringPeriod: false,
      minimumBid: 0,
      waiverHours: 24,
      waiverOrderReset: false,
      waiverProcessDays: [],
      waiverProcessHour: 3,
    },
    rosterSettings: {
      isUsingUndroppableList: true,
      lineupLocktimeType: "INDIVIDUAL_GAME",
      lineupSlotCounts: slotCounts({ 0: 1, 2: 2, 4: 2, 6: 1, 16: 1, 17: 1, 20: 5, 21: 2, 23: 1 }),
      moveLimit: -1,
      positionLimits: {
        "0": 0,
        "1": -1,
        "2": -1,
        "3": -1,
        "4": -1,
        "5": -1,
        "6": 0,
        "7": 0,
        "16": -1,
        "17": 0,
      },
    },
    scheduleSettings: {
      consolationLadderDisabled: false,
      divisions: [{ id: 0, name: "Division 1", size: 10 }],
      matchupPeriodCount: 14,
      matchupPeriodLength: 1,
      matchupPeriods: periods17,
      playoffMatchupPeriodLength: 1,
      playoffReseed: false,
      playoffSeedingRule: "TOTAL_POINTS_SCORED",
      playoffSeedingRuleBy: 0,
      playoffTeamCount: 6,
      variablePlayoffMatchupPeriodLength: false,
    },
    scoringSettings: {
      scoringType: "H2H_POINTS",
      matchupTieRule: "NONE",
      playoffMatchupTieRule: "NONE",
      scoringItems: [
        { statId: 3, points: 0.04, pointsOverrides: {} },
        { statId: 4, points: 5, pointsOverrides: {} },
        { statId: 20, points: -2, pointsOverrides: {} },
        { statId: 24, points: 0.1, pointsOverrides: {} },
        { statId: 25, points: 6, pointsOverrides: {} },
        { statId: 42, points: 0.1, pointsOverrides: {} },
        { statId: 43, points: 6, pointsOverrides: {} },
        { statId: 53, points: 0.5, pointsOverrides: {} },
        { statId: 72, points: -2, pointsOverrides: {} },
      ],
    },
    tradeSettings: {
      deadlineDate: Date.UTC(2026, 11, 2, 18),
      max: -1,
      revisionHours: 24,
      vetoVotesRequired: 0,
    },
    financeSettings: { entryFee: 0, playerMoveToIR: 0 },
  },
});

/** The reference league's settings input. */
export function referenceSettings(): LeagueSettingsInput {
  return settingsInputFromWire(REFERENCE_MSETTINGS);
}

/** One game for a hand-made schedule. */
export function game(
  id: number,
  week: number,
  away: number,
  home: number,
  kickoff: string | null,
  over: Partial<ProGame> = {},
): ProGame {
  return {
    espn_game_id: id,
    season: 2026,
    week,
    kickoff,
    start_time_tbd: false,
    valid_for_locking: kickoff !== null,
    stats_official: false,
    home_pro_team_id: home,
    away_pro_team_id: away,
    ...over,
  };
}

/** A seat with defaults (an RB on the bench). */
export function seat(
  player_id: number,
  slot_id: number,
  over: Partial<RosterSeat> = {},
): RosterSeat {
  return {
    player_id,
    slot_id,
    eligible_slot_ids: [2, 3, 23, 7, 20, 21],
    injury_status: "ACTIVE",
    position: "RB",
    pro_team_id: 1,
    ...over,
  };
}
