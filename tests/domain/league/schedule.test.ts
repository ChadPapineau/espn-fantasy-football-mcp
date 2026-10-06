// schedule.test.ts — src/domain/league/schedule.ts over the recorded 2026 pro schedule
// (fixtures/espn/recorded/season/proTeamSchedules_wl.json: 272 games, Wednesday openers, Thanksgiving
// and Christmas slates, Saturday games, six 09:30 ET international games, 24 TBD games in weeks
// 16–18) and hand-made schedules: byes, kickoff windows, game states, the per-player lock plan
// (plan 07 B1 `lock_at`, `lock_schedule[]`, `latest_execution_time`), the TBD rule (research 04
// §B.1.6: the placeholder date is never displayed nor used) and the week's game flags.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  FREE_AGENT_PRO_TEAM_ID,
  byeWeekOf,
  byesByWeek,
  easternDayHour,
  gameStateOf,
  gamesOfWeek,
  instantMs,
  isOnBye,
  kickoffOf,
  kickoffWindowOf,
  latestExecutionTime,
  lockPlan,
  lockRuleOf,
  opponentOf,
  proTeamIds,
  scheduledWeeks,
  teamGame,
  weekGameState,
  type KickoffWindow,
} from "../../../src/domain/league/schedule.js";
import type { ProSchedule } from "../../../src/domain/league/types.js";
import { game, recordedSchedule } from "./helpers.js";

const S = recordedSchedule();
const at = (iso: string): number => Date.parse(iso);
const RECORDED_AT = at("2026-10-06T06:20:00Z");

describe("the recorded schedule: games, weeks, byes", () => {
  it("272 games over weeks 1–18; 32 NFL teams plus the free-agent team", () => {
    expect(S.games.length).toBe(272);
    expect(scheduledWeeks(S)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    expect(proTeamIds(S).length).toBe(32);
    expect(proTeamIds(S)).not.toContain(FREE_AGENT_PRO_TEAM_ID);
  });
  it("byes derived from the games equal ESPN's byeWeek for every team, one bye each", () => {
    const byes = byesByWeek(S);
    const derived = new Map<number, number[]>();
    for (const [w, ids] of Object.entries(byes))
      for (const id of ids) derived.set(id, [...(derived.get(id) ?? []), Number(w)]);
    for (const t of S.teams.filter((x) => x.id !== 0)) {
      expect(derived.get(t.id), t.abbrev).toEqual([t.bye_week]);
      expect(byeWeekOf(S, t.id), t.abbrev).toBe(t.bye_week);
      expect(isOnBye(S, t.id, t.bye_week ?? 0), t.abbrev).toBe(true);
    }
    expect(Object.keys(byes).map(Number)).toEqual([5, 6, 7, 8, 9, 10, 11, 13, 14]);
    expect(byes["9"]).toEqual([10, 23]);
  });
  it("the free-agent team is never on bye and has no bye week", () => {
    expect(byeWeekOf(S, 0)).toBeNull();
    expect(isOnBye(S, 0, 9)).toBe(false);
    expect(isOnBye(S, 10, 19)).toBe(false); // a week without games is nobody's bye
    expect(byeWeekOf(S, 99)).toBeNull();
  });
  it("a missing or implausible byeWeek falls back to the games", () => {
    const patched: ProSchedule = {
      ...S,
      teams: S.teams.map((t) =>
        t.id === 10 ? { ...t, bye_week: null } : t.id === 23 ? { ...t, bye_week: 40 } : t,
      ),
    };
    expect(byeWeekOf(patched, 10)).toBe(9);
    expect(byeWeekOf(patched, 23)).toBe(9);
    const neverIdle: ProSchedule = {
      season: 2026,
      teams: [{ id: 1, abbrev: "ATL", bye_week: null }],
      games: [game(1, 1, 1, 2, "2026-09-13T17:00:00Z")],
    };
    expect(byeWeekOf(neverIdle, 1)).toBeNull();
  });
  it("gamesOfWeek orders by kickoff with TBD games last", () => {
    const w16 = gamesOfWeek(S, 16);
    expect(w16.length).toBe(16);
    const tbd = w16.filter((g) => g.start_time_tbd);
    expect(tbd.length).toBe(4);
    expect(w16.slice(-4).every((g) => g.start_time_tbd)).toBe(true);
    const known = w16.filter((g) => !g.start_time_tbd).map((g) => instantMs(g.kickoff) ?? 0);
    expect(known).toEqual([...known].sort((a, b) => a - b));
  });
});

describe("kickoffs, windows and TBD games", () => {
  it("every one of the 24 TBD games hides its placeholder: kickoffOf null, state tbd", () => {
    const tbd = S.games.filter((g) => g.start_time_tbd);
    expect(tbd.length).toBe(24);
    expect(new Set(tbd.map((g) => g.week))).toEqual(new Set([16, 17, 18]));
    for (const g of tbd) {
      expect(g.kickoff).not.toBeNull(); // the placeholder is in the data …
      expect(kickoffOf(g)).toBeNull(); // … and never leaves the model
      expect(gameStateOf(g, RECORDED_AT)).toBe("tbd");
    }
  });
  it("the windows of all 248 timed games (ET): Wed/Thu/Fri/Sat/Mon, Sunday split, six international mornings", () => {
    const tally: Partial<Record<KickoffWindow, number>> = {};
    for (const g of S.games) {
      const w = kickoffWindowOf(kickoffOf(g));
      if (w !== null) tally[w] = (tally[w] ?? 0) + 1;
    }
    expect(tally).toEqual({
      wednesday: 2,
      thursday: 19,
      friday: 4,
      saturday: 2,
      sunday_morning: 6,
      sunday_early: 124,
      sunday_late: 57,
      sunday_night: 17,
      monday: 17,
    });
  });
  it("window boundaries in ET across both DST regimes", () => {
    expect(kickoffWindowOf("2026-10-04T13:30:00Z")).toBe("sunday_morning"); // 09:30 EDT
    expect(kickoffWindowOf("2026-11-08T14:30:00Z")).toBe("sunday_morning"); // 09:30 EST
    expect(kickoffWindowOf("2026-11-08T16:59:00Z")).toBe("sunday_morning"); // 11:59 EST
    expect(kickoffWindowOf("2026-11-08T17:00:00Z")).toBe("sunday_early");
    expect(kickoffWindowOf("2026-11-08T21:00:00Z")).toBe("sunday_late");
    expect(kickoffWindowOf("2026-11-09T01:00:00Z")).toBe("sunday_night");
    expect(kickoffWindowOf("2026-11-10T01:15:00Z")).toBe("monday");
    expect(kickoffWindowOf("2026-11-11T01:15:00Z")).toBe("tuesday");
    expect(kickoffWindowOf("2026-09-10T00:20:00Z")).toBe("wednesday");
    expect(kickoffWindowOf(null)).toBeNull();
    expect(kickoffWindowOf("not a date")).toBeNull();
    expect(easternDayHour(at("2026-12-25T18:00:00Z"))).toEqual({ day: "friday", hour: 13 });
  });
  it("gameStateOf: final once official, else tbd / in / pre; no game = bye", () => {
    const g = game(1, 5, 1, 2, "2026-10-11T17:00:00Z");
    expect(gameStateOf(g, at("2026-10-11T16:59:59Z"))).toBe("pre");
    expect(gameStateOf(g, at("2026-10-11T17:00:00Z"))).toBe("in");
    expect(gameStateOf({ ...g, stats_official: true }, at("2026-10-11T17:00:00Z"))).toBe("final");
    expect(gameStateOf({ ...g, start_time_tbd: true }, at("2026-12-31T00:00:00Z"))).toBe("tbd");
    expect(gameStateOf({ ...g, kickoff: "garbage" }, 0)).toBe("tbd");
    expect(gameStateOf({ ...g, start_time_tbd: true, stats_official: true }, 0)).toBe("final");
    expect(gameStateOf(null, 0)).toBe("bye");
    expect(gameStateOf(gamesOfWeek(S, 3)[0] ?? null, RECORDED_AT)).toBe("final");
  });
  it("teamGame picks the earliest known kickoff; opponentOf both ways", () => {
    const a = game(1, 1, 1, 2, "2026-09-13T20:00:00Z");
    const b = game(2, 1, 3, 1, "2026-09-13T17:00:00Z");
    const t = game(3, 1, 1, 4, null, { start_time_tbd: true });
    expect(teamGame([a, b, t], 1)?.espn_game_id).toBe(2);
    expect(teamGame([t, a], 1)?.espn_game_id).toBe(1);
    expect(teamGame([a], 9)).toBeNull();
    expect(opponentOf(a, 1)).toBe(2);
    expect(opponentOf(a, 2)).toBe(1);
  });
});

describe("lockPlan on the recorded slates", () => {
  it("week 12 (Wednesday night, Thanksgiving, Black Friday): each player at his own kickoff", () => {
    const now = at("2026-11-26T19:00:00Z"); // Thanksgiving, 14:00 ET
    const plan = lockPlan(
      [
        { player_id: 1, pro_team_id: 9 }, // GB @ LAR, Wednesday 20:00 ET
        { player_id: 2, pro_team_id: 8 }, // CHI @ DET, Thursday 13:00 ET
        { player_id: 3, pro_team_id: 21 }, // PHI @ DAL, Thursday 16:30 ET
        { player_id: 4, pro_team_id: 2 }, // KC @ BUF, Thursday 20:20 ET
        { player_id: 5, pro_team_id: 23 }, // DEN @ PIT, Friday 15:00 ET
        { player_id: 6, pro_team_id: 1 }, // ATL @ MIN, Sunday 13:00 ET
        { player_id: 7, pro_team_id: 24 }, // NE @ LAC, Sunday night
        { player_id: 8, pro_team_id: 29 }, // CAR @ TB, Monday night
        { player_id: 9, pro_team_id: 21 }, // a second Eagle: same lock instant
      ],
      S,
      12,
      "INDIVIDUAL_GAME",
      now,
    );
    expect(plan).toMatchObject({
      rule: "per_game",
      rule_verified: true,
      bye_player_ids: [],
      tbd_player_ids: [],
      locked_player_ids: [1, 2],
    });
    expect(plan.players.map((p) => p.window)).toEqual([
      "wednesday",
      "thursday",
      "thursday",
      "thursday",
      "friday",
      "sunday_early",
      "sunday_night",
      "monday",
      "thursday",
    ]);
    expect(plan.players.map((p) => p.game_state)).toEqual([
      "in",
      "in",
      "pre",
      "pre",
      "pre",
      "pre",
      "pre",
      "pre",
      "pre",
    ]);
    expect(plan.schedule.map((e) => [e.lock_at, e.player_ids])).toEqual([
      ["2026-11-26T01:00:00.000Z", [1]],
      ["2026-11-26T18:00:00.000Z", [2]],
      ["2026-11-26T21:30:00.000Z", [3, 9]],
      ["2026-11-27T01:20:00.000Z", [4]],
      ["2026-11-27T20:00:00.000Z", [5]],
      ["2026-11-29T18:00:00.000Z", [6]],
      ["2026-11-30T01:20:00.000Z", [7]],
      ["2026-12-01T01:15:00.000Z", [8]],
    ]);
    expect(plan.latest_execution_time).toBe("2026-11-26T21:30:00.000Z");
    expect(latestExecutionTime(plan.schedule, now)).toBe("2026-11-26T21:30:00.000Z");
    const eagle = plan.players[2];
    expect(eagle).toMatchObject({
      opponent_pro_team_id: 6,
      is_home: false,
      espn_game_id: expect.any(Number) as number,
    });
    expect(plan.all_locked).toBe(false);
  });
  it("week 9: the 09:30 ET international game, the Thursday game, two byes, a free agent", () => {
    const now = at("2026-11-08T12:00:00Z");
    const plan = lockPlan(
      [
        { player_id: 1, pro_team_id: 4 }, // CIN @ ATL, 09:30 ET
        { player_id: 2, pro_team_id: 33 }, // JAX @ BAL, Thursday — already locked
        { player_id: 3, pro_team_id: 23 }, // PIT bye
        { player_id: 4, pro_team_id: 10 }, // TEN bye
        { player_id: 5, pro_team_id: 0 }, // free agent
        { player_id: 6, pro_team_id: null },
        { player_id: 7, pro_team_id: 16 }, // BUF @ MIN, Monday
      ],
      S,
      9,
      "INDIVIDUAL_GAME",
      now,
    );
    expect(plan.players[0]).toMatchObject({
      window: "sunday_morning",
      kickoff: "2026-11-08T14:30:00.000Z",
      lock_at: "2026-11-08T14:30:00.000Z",
      locked: false,
    });
    expect(plan.players[1]).toMatchObject({ window: "thursday", locked: true, game_state: "in" });
    expect(plan.bye_player_ids).toEqual([3, 4]);
    expect(plan.no_team_player_ids).toEqual([5, 6]);
    for (const p of plan.players.filter((x) => x.bye || x.no_team))
      expect(p).toMatchObject({ lock_at: null, kickoff: null, game_state: "bye", locked: false });
    expect(plan.latest_execution_time).toBe("2026-11-08T14:30:00.000Z");
    expect(plan.schedule.flatMap((e) => e.player_ids)).toEqual([2, 1, 7]);
  });
  it("week 16: TBD games get no lock instant (never the placeholder), Christmas games lock on time", () => {
    const now = at("2026-12-20T12:00:00Z");
    const plan = lockPlan(
      [
        { player_id: 1, pro_team_id: 27 }, // TB @ ATL, TBD
        { player_id: 2, pro_team_id: 3 }, // GB @ CHI, Christmas 13:00 ET
        { player_id: 3, pro_team_id: 34 }, // HOU @ PHI, Christmas Eve 20:15 ET
      ],
      S,
      16,
      "INDIVIDUAL_GAME",
      now,
    );
    expect(plan.tbd_player_ids).toEqual([1]);
    expect(plan.players[0]).toMatchObject({
      kickoff: null,
      lock_at: null,
      window: null,
      game_state: "tbd",
      tbd: true,
      locked: false,
    });
    expect(plan.players[1]?.window).toBe("friday");
    expect(plan.players[2]?.window).toBe("thursday");
    expect(plan.schedule.map((e) => e.lock_at)).toEqual([
      "2026-12-25T01:15:00.000Z",
      "2026-12-25T18:00:00.000Z",
    ]);
    expect(plan.schedule.some((e) => e.lock_at.startsWith("2026-12-27T08:01"))).toBe(false);
    // even with every timed lock passed, a TBD player keeps the lineup open
    const late = lockPlan(
      [
        { player_id: 1, pro_team_id: 27 },
        { player_id: 2, pro_team_id: 3 },
      ],
      S,
      16,
      "INDIVIDUAL_GAME",
      at("2026-12-26T00:00:00Z"),
    );
    expect(late).toMatchObject({
      all_locked: false,
      latest_execution_time: null,
      locked_player_ids: [2],
    });
  });
  it("an unknown lock type locks everyone at the week's first KNOWN kickoff (conservative, unverified)", () => {
    expect(lockRuleOf("INDIVIDUAL_GAME")).toEqual({ rule: "per_game", verified: true });
    for (const t of ["WEEKLY", null, "individual_game", "lock all"])
      expect(lockRuleOf(t)).toEqual({ rule: "first_kickoff", verified: false });
    const plan = lockPlan(
      [
        { player_id: 1, pro_team_id: 27 },
        { player_id: 2, pro_team_id: 25 },
        { player_id: 3, pro_team_id: 0 },
      ],
      S,
      16,
      "WEEKLY",
      at("2026-12-20T12:00:00Z"),
    );
    expect(plan).toMatchObject({ rule: "first_kickoff", rule_verified: false });
    expect(plan.schedule).toEqual([{ lock_at: "2026-12-25T01:15:00.000Z", player_ids: [1, 2, 3] }]);
    expect(plan.players[0]).toMatchObject({
      tbd: true,
      kickoff: null,
      lock_at: "2026-12-25T01:15:00.000Z",
    });
  });
});

describe("lockPlan on hand-made schedules", () => {
  const weekly = (games: ProSchedule["games"]) => ({ games });
  it("a TBD placeholder earlier than every real kickoff is never the week's first kickoff", () => {
    const sched = weekly([
      game(1, 1, 1, 2, "2026-09-13T08:00:00Z", { start_time_tbd: true }),
      game(2, 1, 3, 4, "2026-09-13T17:00:00Z"),
    ]);
    const plan = lockPlan([{ player_id: 1, pro_team_id: 1 }], sched, 1, null, 0);
    expect(plan.schedule).toEqual([{ lock_at: "2026-09-13T17:00:00.000Z", player_ids: [1] }]);
  });
  it("ESPN's lineupLocked locks a player before kickoff; locks are inclusive at the instant", () => {
    const sched = weekly([game(1, 1, 1, 2, "2026-09-13T17:00:00Z")]);
    const early = lockPlan(
      [
        { player_id: 1, pro_team_id: 1, lineup_locked: true },
        { player_id: 2, pro_team_id: 2 },
      ],
      sched,
      1,
      "INDIVIDUAL_GAME",
      at("2026-09-13T12:00:00Z"),
    );
    expect(early.locked_player_ids).toEqual([1]);
    expect(early.latest_execution_time).toBe("2026-09-13T17:00:00.000Z");
    const atKick = lockPlan(
      [{ player_id: 2, pro_team_id: 2 }],
      sched,
      1,
      "INDIVIDUAL_GAME",
      at("2026-09-13T17:00:00Z"),
    );
    expect(atKick).toMatchObject({
      locked_player_ids: [2],
      all_locked: true,
      latest_execution_time: null,
    });
  });
  it("a week without games: nobody is on bye, nothing locks, nothing is all-locked", () => {
    const plan = lockPlan([{ player_id: 1, pro_team_id: 1 }], weekly([]), 3, "INDIVIDUAL_GAME", 0);
    expect(plan).toMatchObject({
      bye_player_ids: [],
      schedule: [],
      all_locked: false,
      latest_execution_time: null,
    });
    expect(plan.players[0]?.game_state).toBe("bye");
  });
  it("latestExecutionTime skips passed and invalid instants", () => {
    expect(
      latestExecutionTime(
        [
          { lock_at: "x", player_ids: [1] },
          { lock_at: "2026-01-01T00:00:00Z", player_ids: [2] },
        ],
        at("2026-06-01T00:00:00Z"),
      ),
    ).toBeNull();
    expect(
      latestExecutionTime(
        [
          { lock_at: "2026-09-14T00:00:00Z", player_ids: [1] },
          { lock_at: "2026-09-13T00:00:00Z", player_ids: [2] },
        ],
        0,
      ),
    ).toBe("2026-09-13T00:00:00.000Z");
  });
  it("property: every lock instant is a known non-TBD kickoff; the next execution lies ahead; a TBD player never locks by time", () => {
    const arbGame = fc.record({
      id: fc.integer({ min: 1, max: 1e6 }),
      away: fc.integer({ min: 1, max: 6 }),
      home: fc.integer({ min: 1, max: 6 }),
      ms: fc.integer({ min: at("2026-09-10T00:00:00Z"), max: at("2026-09-16T00:00:00Z") }),
      tbd: fc.boolean(),
    });
    fc.assert(
      fc.property(
        fc.array(arbGame, { maxLength: 6 }),
        fc.array(
          fc.record({
            player_id: fc.integer({ min: 1, max: 50 }),
            pro_team_id: fc.oneof(fc.integer({ min: 0, max: 7 }), fc.constant(null)),
          }),
          { maxLength: 12 },
        ),
        fc.integer({ min: at("2026-09-09T00:00:00Z"), max: at("2026-09-17T00:00:00Z") }),
        (gs, subjects, now) => {
          const games = gs.map((g) =>
            game(g.id, 1, g.away, g.home, new Date(g.ms).toISOString(), { start_time_tbd: g.tbd }),
          );
          const plan = lockPlan(subjects, { games }, 1, "INDIVIDUAL_GAME", now);
          const known = new Set(
            games.filter((g) => !g.start_time_tbd).map((g) => instantMs(g.kickoff)),
          );
          for (const e of plan.schedule) expect(known.has(instantMs(e.lock_at))).toBe(true);
          const next = instantMs(plan.latest_execution_time);
          if (next !== null) expect(next).toBeGreaterThan(now);
          for (const p of plan.players) if (p.tbd) expect(p.lock_at).toBeNull();
        },
      ),
    );
  });
});

describe("weekGameState", () => {
  it("week 3 at recording time: final, not provisional, corrections window closed (7 days after MNF)", () => {
    const w = weekGameState(S, 3, RECORDED_AT);
    expect(w).toMatchObject({
      games: 16,
      provisional: false,
      final: true,
      corrections_window_open: false,
      game_window_open: false,
      has_tbd: false,
    });
    expect(w.last_kickoff).toBe("2026-09-29T00:15:00.000Z");
  });
  it("week 4 at recording time: final, corrections still open, no game in progress", () => {
    expect(weekGameState(S, 4, RECORDED_AT)).toMatchObject({
      final: true,
      corrections_window_open: true,
      game_window_open: false,
      next_kickoff: null,
    });
  });
  it("week 5 before it starts: provisional, next kickoff = Thursday night", () => {
    const w = weekGameState(S, 5, RECORDED_AT);
    expect(w).toMatchObject({ provisional: true, final: false, game_window_open: false });
    expect(w.next_kickoff).toBe(w.first_kickoff);
    expect(kickoffWindowOf(w.next_kickoff)).toBe("thursday");
  });
  it("week 16: a TBD game keeps the corrections window conservatively open", () => {
    expect(weekGameState(S, 16, at("2027-02-01T00:00:00Z"))).toMatchObject({
      has_tbd: true,
      corrections_window_open: true,
    });
  });
  it("a game in progress opens the window and is listed; an empty week is neither final nor in progress", () => {
    const games = [
      game(7, 1, 1, 2, "2026-09-13T17:00:00Z"),
      game(8, 1, 3, 4, "2026-09-13T20:25:00Z"),
      game(9, 1, 5, 6, "2026-09-12T17:00:00Z", { stats_official: true }),
    ];
    const w = weekGameState({ games }, 1, at("2026-09-13T18:00:00Z"));
    expect(w).toMatchObject({
      game_window_open: true,
      games_in_progress: [7],
      next_kickoff: "2026-09-13T20:25:00.000Z",
      provisional: true,
    });
    expect(weekGameState({ games: [] }, 1, 0)).toMatchObject({
      games: 0,
      final: false,
      provisional: false,
      first_kickoff: null,
      game_window_open: false,
    });
  });
});
