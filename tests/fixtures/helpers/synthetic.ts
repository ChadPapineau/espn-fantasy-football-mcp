// synthetic.ts — a synthetic, ESPN-shaped public league (research 03 §A.2, §B) carrying every PII
// field class of research 03 §F.3, and a routed fake `fetch` serving it, so the recorder and the
// scrubber are exercised end to end with no network (plan 05 §3.1 step 3: "a test runs it twice on
// a synthetic recording"). Every identifier-shaped value is ASSEMBLED AT RUN TIME so this file stays
// clean for the repo scanners: no literal GUID, IPv4, league id or cookie appears below.

/** A deterministic PRNG (mulberry32) so synthetic data is reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEX = "0123456789ABCDEF";
/** A real-looking member GUID (uppercase, braced) — NOT in the fixture range. */
export function realGuid(r: () => number, braced = true): string {
  const part = (n: number) =>
    Array.from({ length: n }, () => HEX[Math.floor(r() * 16)] ?? "0").join("");
  const g = [part(8), part(4), `4${part(3)}`, `A${part(3)}`, part(12)].join("-");
  return braced ? `{${g}}` : g;
}

export const ip = (...octets: number[]): string => octets.join(".");

export interface SyntheticLeague {
  leagueId: string;
  leagueName: string;
  teams: {
    id: number;
    name: string;
    abbrev: string;
    location: string;
    nickname: string;
    logo: string;
    owner: string;
  }[];
  members: { id: string; displayName: string; firstName: string; lastName: string }[];
  clientAddress: string;
  /** A transaction-like id that is an unbraced GUID. */
  pendingId: string;
}

export function syntheticLeague(seed = 7, teamCount = 4): SyntheticLeague {
  const r = rng(seed);
  const leagueId = String(100_000 + Math.floor(r() * 800_000));
  const words = ["Gridiron", "Blitz", "Fumble", "Sacks", "Huddle", "Endzone", "Punters", "Waivers"];
  const teams = Array.from({ length: teamCount }, (_, i) => {
    const owner = realGuid(r);
    return {
      id: i + 1,
      name: `${words[i % words.length] ?? "Squad"} Collective ${String(seed)}${String(i)}`,
      abbrev: `Q${String(i)}X`,
      location: `Northshire${String(seed)}${String(i)}`,
      nickname: `Marauders${String(seed)}${String(i)}`,
      logo: ["https:", "", "img.example.org", "logos", `u${String(i)}.png`].join("/"),
      owner,
    };
  });
  const members = teams.map((t, i) => ({
    id: t.owner,
    displayName: `quarterbackfan${String(seed)}${String(i)}`,
    firstName: `Aurelio${String(seed)}${String(i)}`,
    lastName: `Vantongeren${String(seed)}${String(i)}`,
  }));
  return {
    leagueId,
    leagueName: `Synthetic Wombat League ${String(seed)}`,
    teams,
    members,
    clientAddress: ip(10, 20, 30, 40 + (seed % 10)),
    pendingId: realGuid(r, false),
  };
}

const statEntry = (season: number, week: number, source: 0 | 1, pts: number) => ({
  id: source === 0 ? `0${String(season)}${String(week)}` : `11${String(season)}${String(week)}`,
  seasonId: season,
  scoringPeriodId: week,
  statSourceId: source,
  statSplitTypeId: 1,
  proTeamId: 12,
  appliedTotal: pts,
  appliedStats: { "3": pts / 2, "53": 1.5, "4": pts / 4 },
  stats: { "3": pts * 10, "53": 3, "4": 1 },
});

function player(id: number, week: number, season: number) {
  return {
    id,
    fullName: `Player ${String(id)}`,
    firstName: "Player",
    lastName: String(id),
    defaultPositionId: 1 + (id % 4),
    eligibleSlots: [2, 3, 23, 20, 21],
    proTeamId: 1 + (id % 32),
    injuryStatus: "ACTIVE",
    seasonOutlook: `Outlook text for player ${String(id)} — editorial prose that must not be republished.`,
    outlooks: {
      outlooksByWeek: { [String(week)]: `Week ${String(week)} outlook for ${String(id)}.` },
    },
    stats: [statEntry(season, week, 0, 10 + (id % 7)), statEntry(season, week, 1, 9 + (id % 5))],
  };
}

function rosterEntries(teamId: number, week: number, season: number, pending: string) {
  return Array.from({ length: 3 }, (_, k) => ({
    playerId: teamId * 100 + k,
    lineupSlotId: k === 2 ? 20 : 2,
    acquisitionType: "DRAFT",
    injuryStatus: "NORMAL",
    pendingTransactionIds: k === 0 ? [pending] : null,
    playerPoolEntry: {
      id: teamId * 100 + k,
      appliedStatTotal: 12.5 + k,
      onTeamId: teamId,
      player: player(teamId * 100 + k, week, season),
    },
  }));
}

function settings(l: SyntheticLeague, size: number) {
  return {
    name: l.leagueName,
    size,
    isPublic: true,
    acquisitionSettings: {
      acquisitionType: "WAIVERS_CONTINUOUS",
      isUsingAcquisitionBudget: true,
      acquisitionBudget: 100,
      waiverHours: 24,
    },
    draftSettings: { type: "SNAKE", pickOrder: l.teams.map((t) => t.id) },
    financeSettings: { entryFee: 0 },
    rosterSettings: {
      lineupSlotCounts: {
        "0": 1,
        "2": 2,
        "4": 2,
        "6": 1,
        "16": 1,
        "17": 1,
        "20": 7,
        "21": 1,
        "23": 1,
      },
      positionLimits: { "1": -1 },
      lineupLocktimeType: "INDIVIDUAL_GAME",
    },
    scheduleSettings: {
      matchupPeriodCount: 14,
      matchupPeriodLength: 1,
      matchupPeriods: Object.fromEntries(
        Array.from({ length: 14 }, (_, i) => [String(i + 1), [i + 1]]),
      ),
      playoffTeamCount: 4,
      playoffMatchupPeriodLength: 1,
      playoffSeedingRule: "TOTAL_POINTS_SCORED",
      divisions: [{ id: 0, name: `Division of ${l.leagueName}`, size }],
    },
    scoringSettings: {
      scoringType: "H2H_POINTS",
      scoringItems: [
        { statId: 53, points: 0.5 },
        { statId: 4, points: 4 },
        { statId: 3, points: 0.04 },
        { statId: 89, points: 0, pointsOverrides: { "16": 5 } },
      ],
    },
    tradeSettings: { deadlineDate: 1_700_000_000_000 },
  };
}

function teamsFull(l: SyntheticLeague) {
  return l.teams.map((t) => ({
    id: t.id,
    name: t.name,
    abbrev: t.abbrev,
    location: t.location,
    nickname: t.nickname,
    logo: t.logo,
    logoType: "CUSTOM",
    owners: [t.owner],
    primaryOwner: t.owner,
    divisionId: 0,
    waiverRank: t.id,
    points: 100 + t.id,
    playoffClinchType: "NONE",
    record: {
      overall: {
        wins: 1,
        losses: 1,
        ties: 0,
        pointsFor: 200.5,
        pointsAgainst: 190.25,
        percentage: 0.5,
      },
    },
    tradeBlock: { players: { "101": "ON_THE_BLOCK" }, note: `Trading from ${t.name}` },
    draftStrategy: { excludedPlayerIds: [1, 2], note: "secret plan" },
    teamMotto: `Motto of ${t.name}`,
  }));
}

function membersFull(l: SyntheticLeague) {
  return l.members.map((m, i) => ({
    id: m.id,
    displayName: m.displayName,
    firstName: m.firstName,
    lastName: m.lastName,
    isLeagueManager: i === 0,
    isLeagueCreator: i === 0,
    notificationSettings: [{ enabled: true, id: "TEAM_TRADE", type: "EMAIL" }],
  }));
}

const base = (l: SyntheticLeague, season: number) => ({
  gameId: 1,
  id: Number(l.leagueId),
  scoringPeriodId: 5,
  seasonId: season,
  segmentId: 0,
  draftDetail: { drafted: true, inProgress: false },
  status: {
    currentMatchupPeriod: 5,
    latestScoringPeriod: 5,
    finalScoringPeriod: 17,
    firstScoringPeriod: 1,
    isActive: true,
    previousSeasons: [season - 1],
    lastUpdateInfo: { clientAddress: l.clientAddress, platform: "WEB", source: "x" },
  },
});

/** The body the real host would return for `views` (+ params, filter) on this synthetic league. */
export function leagueBody(
  l: SyntheticLeague,
  season: number,
  views: string[],
  params: URLSearchParams,
  filter: unknown,
): unknown {
  const size = l.teams.length;
  const week = Number(params.get("scoringPeriodId") ?? "5");
  const body: Record<string, unknown> = base(l, season);
  if (views.includes("mBogusViewName")) {
    return {
      ...base(l, season),
      members: l.members.map((m) => ({ id: m.id })),
      settings: { name: l.leagueName },
      teams: l.teams.map((t) => ({ abbrev: t.abbrev, id: t.id, owners: [t.owner] })),
    };
  }
  if (views.includes("mSettings")) body.settings = settings(l, size);
  if (views.includes("mTeam") || views.includes("mNav")) {
    body.teams = teamsFull(l);
    body.members = membersFull(l);
  }
  if (views.includes("mMatchup")) {
    body.schedule = Array.from({ length: 6 }, (_, i) => ({
      id: i + 1,
      matchupPeriodId: Math.floor(i / 2) + 1,
      winner: "HOME",
      home: {
        teamId: 1 + (i % size),
        totalPoints: 110.5,
        pointsByScoringPeriod: { [String(Math.floor(i / 2) + 1)]: 110.5 },
      },
      away: {
        teamId: 1 + ((i + 1) % size),
        totalPoints: 99.25,
        pointsByScoringPeriod: { [String(Math.floor(i / 2) + 1)]: 99.25 },
      },
    }));
  }
  if (views.includes("mRoster")) {
    body.teams = l.teams.map((t) => ({
      id: t.id,
      abbrev: t.abbrev,
      name: t.name,
      roster: { appliedStatTotal: 40, entries: rosterEntries(t.id, week, season, l.pendingId) },
    }));
  }
  if (views.includes("mBoxscore")) {
    const f = filter as
      { schedule?: { filterMatchupPeriodIds?: { value?: number[] } } } | undefined;
    const mp = f?.schedule?.filterMatchupPeriodIds?.value?.[0] ?? week;
    body.settings = { name: l.leagueName, scoringSettings: settings(l, size).scoringSettings };
    body.teams = l.teams.map((t) => ({
      id: t.id,
      abbrev: t.abbrev,
      name: t.name,
      owners: [t.owner],
      primaryOwner: t.owner,
    }));
    body.schedule = [
      {
        id: mp * 10,
        matchupPeriodId: mp,
        home: {
          teamId: 1,
          totalPoints: 37.5,
          rosterForCurrentScoringPeriod: {
            appliedStatTotal: 37.5,
            entries: rosterEntries(1, week, season, l.pendingId),
          },
        },
        away: {
          teamId: 2,
          totalPoints: 40.5,
          rosterForCurrentScoringPeriod: {
            appliedStatTotal: 40.5,
            entries: rosterEntries(2, week, season, l.pendingId),
          },
        },
      },
    ];
  }
  if (views.includes("kona_player_info")) {
    const fp = filter as { players?: { limit?: number; sortPercOwned?: unknown } } | undefined;
    if (fp?.players?.limit !== undefined && fp.players.sortPercOwned === undefined) return null; // caller turns this into a 400
    const n = fp?.players?.limit ?? 5;
    // descending ownership order (NOT id order): the scrubber must keep it
    body.players = Array.from({ length: Math.min(n, 6) }, (_, i) => ({
      id: 900 - i * 7 + (i % 2) * 20,
      onTeamId: 0,
      status: "FREEAGENT",
      player: player(900 + i, week, season),
    }));
  }
  return body;
}

export function proTeamSchedules(
  season: number,
  finalWeeks: readonly number[] = [1, 2, 3, 4],
): unknown {
  const ids = [0, 1, 2, 3, 4];
  return {
    display: true,
    settings: {
      proTeams: ids.map((id) => ({
        id,
        abbrev: id === 0 ? "FA" : `P${String(id)}`,
        location: `City ${String(id)}`,
        name: `Pros ${String(id)}`,
        byeWeek: id === 0 ? 0 : 5 + id,
        proGamesByScoringPeriod:
          id === 0
            ? {}
            : Object.fromEntries(
                [1, 2, 3, 4, 5].map((w) => [
                  String(w),
                  [
                    {
                      id: w * 100 + id,
                      awayProTeamId: id,
                      homeProTeamId: (id % 4) + 1,
                      date: 1_700_000_000_000 + w * 604_800_000,
                      scoringPeriodId: w,
                      startTimeTBD: false,
                      statsOfficial: finalWeeks.includes(w),
                      validForLocking: true,
                    },
                  ],
                ]),
              ),
      })),
    },
  };
}

export interface FakeEspn {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  calls: { url: string; headers: Record<string, string>; redirect: string | undefined }[];
}

/** A routed fake of the read host serving `leagues` (keyed by real id). */
export function fakeEspn(
  leagues: Map<string, SyntheticLeague>,
  season: number,
  finalWeeks?: readonly number[],
): FakeEspn {
  const calls: FakeEspn["calls"] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json;charset=utf-8",
        "x-fantasy-role": "NONE",
        etag: 'W/"abc"',
        "x-amz-cf-pop": "TEST50-C1",
      },
    });
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
    if (!m)
      return Promise.resolve(
        json(404, { messages: ["Not Found"], details: [{ type: "GENERAL_NOT_FOUND" }] }),
      );
    if (!m[2]) {
      if (views.includes("proTeamSchedules_wl"))
        return Promise.resolve(json(200, proTeamSchedules(season, finalWeeks)));
      return Promise.resolve(json(200, { display: true, settings: {} }));
    }
    const league = leagues.get(m[2]);
    if (!league)
      return Promise.resolve(
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
        }),
      );
    const body = leagueBody(league, season, views, u.searchParams, filter);
    if (body === null)
      return Promise.resolve(
        json(400, {
          messages: ["Filter: Limit request must be accompanied by a sort"],
          details: [{ type: "FILTER_LIMIT_MISSING_SORT" }],
        }),
      );
    return Promise.resolve(json(200, body));
  };
  return { fetch: fetchImpl, calls };
}
