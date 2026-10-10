// history-fake.ts — a routed fake of the read host serving synthetic leagues' FINISHED previous
// seasons (scripts/espn-fixture/history.ts; research 03 §A.1: one league object per season, the
// same id every season; §B.5: a box score's roster entries carry that week's actual and ESPN's
// weekly projection). Built on synthetic.ts's PII-laden league bodies (names, GUIDs, IPs, outlooks)
// so the history scrub is exercised against every field class; identifier-shaped values are
// assembled at run time, so this file stays clean for the repo scanners.
import { leagueBody, realGuid, rng, type SyntheticLeague } from "./synthetic.js";

export interface HistoryFakeOptions {
  /** Every previous season each league lists in its CURRENT season (ascending). */
  previousSeasons: number[];
  /** The last scoring period of every previous season (small keeps tests fast). */
  finalScoringPeriod?: number;
  /** league id → seasons answered with a typed 404 (not served keylessly). */
  notServed?: Map<string, number[]>;
  /** league id → seasons whose previousSeasons are wrong (another league's list). */
  wrongHistory?: Map<string, number[]>;
  /** A player id rostered in every box score (to trip a deny-list match on its id). */
  extraPlayerId?: number;
}

export interface HistoryFake {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  calls: { url: string; headers: Record<string, string>; redirect: string | undefined }[];
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json;charset=utf-8",
      "x-fantasy-role": "NONE",
      etag: 'W/"abc"',
    },
  });

const notFound = () =>
  json(404, {
    messages: ["Not Found"],
    details: [
      {
        message: "Not Found",
        shortMessage: "Not Found",
        resolution: null,
        type: "GENERAL_NOT_FOUND",
        metaData: null,
      },
    ],
  });

/** A previous season's status block: the clock past the final period, the list cut below it. */
function historyStatus(l: SyntheticLeague, season: number, prev: number[], final: number) {
  return {
    currentMatchupPeriod: final,
    latestScoringPeriod: final + 2,
    finalScoringPeriod: final,
    firstScoringPeriod: 1,
    isActive: true,
    isExpired: false,
    previousSeasons: prev.filter((s) => s < season),
    lastUpdateInfo: { clientAddress: l.clientAddress, platform: "WEB", source: "x" },
  };
}

function statLine(season: number, week: number, source: 0 | 1, pts: number, proTeamId: number) {
  return {
    id: source === 1 ? `11${String(season)}${String(week)}` : `0${String(season)}${String(week)}`,
    externalId: `${String(season)}${String(week)}`,
    seasonId: season,
    scoringPeriodId: week,
    statSourceId: source,
    statSplitTypeId: 1,
    proTeamId,
    appliedTotal: pts,
    appliedStats: { "53": pts / 4, "42": pts / 2 },
    stats: { "53": pts / 2, "42": pts * 5, "58": 3 },
  };
}

function boxEntry(playerId: number, season: number, week: number, slot: number) {
  return {
    playerId,
    lineupSlotId: slot,
    playerPoolEntry: {
      id: playerId,
      appliedStatTotal: 10 + (Math.abs(playerId) % 9),
      onTeamId: 1,
      player: {
        id: playerId,
        fullName: `Player ${String(playerId)}`,
        firstName: "Player",
        lastName: String(playerId),
        defaultPositionId: 1 + (Math.abs(playerId) % 4),
        eligibleSlots: [2, 3, 23, 20, 21],
        proTeamId: 1 + (Math.abs(playerId) % 32),
        injuryStatus: "ACTIVE",
        seasonOutlook: `Season outlook for ${String(playerId)}, editorial prose.`,
        stats: [
          statLine(season, week, 0, 8 + (Math.abs(playerId) % 7), 3),
          statLine(season, week, 1, 9.25 + (Math.abs(playerId) % 5), 3),
        ],
      },
    },
  };
}

/** The body a previous season's league route returns for `views` on this synthetic league. */
export function historyLeagueBody(
  l: SyntheticLeague,
  season: number,
  views: string[],
  params: URLSearchParams,
  filter: unknown,
  o: HistoryFakeOptions,
): unknown {
  const final = o.finalScoringPeriod ?? 4;
  const wrong = o.wrongHistory?.get(l.leagueId)?.includes(season) === true;
  const prev = wrong ? [2001, 2002] : o.previousSeasons;
  const size = l.teams.length;
  const base = leagueBody(l, season, views, params, filter) as Record<string, unknown>;
  base.status = historyStatus(l, season, prev, final);
  base.scoringPeriodId = final;
  const settings = base.settings as Record<string, unknown> | undefined;
  if (settings && typeof settings.scheduleSettings === "object") {
    const sched = settings.scheduleSettings as Record<string, unknown>;
    sched.matchupPeriodCount = final;
    sched.matchupPeriods = Object.fromEntries(
      Array.from({ length: final }, (_, i) => [String(i + 1), [i + 1]]),
    );
  }
  if (views.includes("mTeam")) {
    base.teams = (base.teams as Record<string, unknown>[]).map((t) => ({
      ...t,
      playoffSeed: t.id,
      rankCalculatedFinal: t.id,
    }));
    base.schedule = Array.from({ length: final }, (_, i) => ({
      id: i + 1,
      matchupPeriodId: i + 1,
      winner: "HOME",
      home: { teamId: 1 + (i % size), totalPoints: 101.5 },
      away: { teamId: 1 + ((i + 1) % size), totalPoints: 88.25 },
    }));
  }
  if (views.includes("mMatchup")) {
    base.schedule = Array.from({ length: final }, (_, i) => ({
      id: i + 1,
      matchupPeriodId: i + 1,
      playoffTierType: "NONE",
      winner: i % 3 === 2 ? "AWAY" : "HOME",
      home: { teamId: 1 + (i % size), totalPoints: 101.5 },
      away: { teamId: 1 + ((i + 1) % size), totalPoints: 88.25 },
    }));
  }
  if (views.includes("mBoxscore")) {
    const week = Number(params.get("scoringPeriodId") ?? "1");
    const rows = (base.schedule as Record<string, unknown>[]).map((row) => {
      const side = (key: "home" | "away", teamId: number) => {
        const ids = [teamId * 100, teamId * 100 + 1, teamId * 100 + 2];
        if (o.extraPlayerId !== undefined && key === "home") ids.push(o.extraPlayerId);
        return {
          ...(row[key] as Record<string, unknown>),
          rosterForCurrentScoringPeriod: {
            appliedStatTotal: 30,
            entries: ids.map((id, k) => boxEntry(id, season, week, k === 0 ? 2 : 20)),
          },
        };
      };
      return { ...row, home: side("home", 1), away: side("away", 2) };
    });
    base.schedule = rows;
  }
  return base;
}

/** A proTeamSchedules_wl body for a finished season: every game of weeks 1–18 statsOfficial. */
export function finishedSchedule(): unknown {
  return {
    display: true,
    settings: {
      proTeams: [1, 2, 3].map((id) => ({
        id,
        abbrev: `P${String(id)}`,
        location: `City ${String(id)}`,
        name: `Pros ${String(id)}`,
        byeWeek: 6 + id,
        proGamesByScoringPeriod: Object.fromEntries(
          Array.from({ length: 18 }, (_, i) => [
            String(i + 1),
            [
              {
                id: (i + 1) * 100 + id,
                awayProTeamId: id,
                homeProTeamId: (id % 3) + 1,
                date: 1_600_000_000_000 + i * 604_800_000,
                scoringPeriodId: i + 1,
                statsOfficial: true,
                validForLocking: true,
              },
            ],
          ]),
        ),
      })),
    },
  };
}

/** The routed fake: previous seasons of `leagues` (keyed by real id) on the read host. */
export function historyFake(
  leagues: Map<string, SyntheticLeague>,
  o: HistoryFakeOptions,
): HistoryFake {
  const calls: HistoryFake["calls"] = [];
  const fetchImpl = (input: string, init: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({ url: input, headers, redirect: init.redirect });
    const u = new URL(input);
    const views = u.searchParams.getAll("view");
    const filterText = headers["x-fantasy-filter"];
    const filter: unknown = filterText ? JSON.parse(filterText) : undefined;
    const m = /^\/apis\/v3\/games\/ffl\/seasons\/(\d{4})(?:\/segments\/0\/leagues\/(\d+))?$/.exec(
      u.pathname,
    );
    if (!m) return Promise.resolve(notFound());
    const season = Number(m[1]);
    if (!m[2])
      return Promise.resolve(
        views.includes("proTeamSchedules_wl")
          ? json(200, finishedSchedule())
          : json(200, { display: true, settings: {} }),
      );
    const league = leagues.get(m[2]);
    if (!league || o.notServed?.get(m[2])?.includes(season) === true)
      return Promise.resolve(notFound());
    return Promise.resolve(
      json(200, historyLeagueBody(league, season, views, u.searchParams, filter, o)),
    );
  };
  return { fetch: fetchImpl, calls };
}

/** A committed current-season mSettings anchor for a slot (what the history binds to). */
export function anchorSettings(season: number, previousSeasons: number[]): unknown {
  return {
    id: 0,
    seasonId: season,
    status: { previousSeasons, latestScoringPeriod: 5, finalScoringPeriod: 17 },
    settings: { name: "Example League 1", size: 4 },
  };
}

/** A member GUID that is NOT in the fixture range (for negative checks). */
export const someRealGuid = (seed: number): string => realGuid(rng(seed));
