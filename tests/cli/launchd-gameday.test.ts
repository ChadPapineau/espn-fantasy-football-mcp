// launchd-gameday.test.ts — the kickoff- and game-day-relative launchd jobs over the recorded 2026 pro
// schedule (plan 06 §1.3/§1.4: the game-day cadence comes from the schedule itself; §2: fixed wakes
// that self-select; Stage C findings launchd-gameday-calendar-hardcoded and
// jobs-prekickoff-window-boundary). Every wake of the REAL job calendars is simulated in the owner's
// time zone (America/New_York), each starting 300 ms after its minute as launchd starts a job, and
// judged with the jobs' own selectors: every game day — Wednesday, Friday and Saturday ones included
// (opening week, Thanksgiving week, the late-season Saturdays, Christmas) — gets exactly one
// pre-kickoff run, an hour before an on-the-hour first kickoff (not two); every week gets exactly one
// pre-week roster/scoreboard snapshot; the schedule refreshes run every wake on a game day and only
// the 6-hourly wakes otherwise. No network: the schedule is the recorded keyless fixture.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isWorkingRun, nextDayFirstKickoff, weekFirstKickoff } from "../../src/cli/espn-jobs.js";
import { JOBS, type CalendarEntry } from "../../src/cli/launchd.js";
import { gameDayCadenceWorks } from "../../src/cli/refresh.js";
import { PRE_KICKOFF_MS, ROSTER_PRE_KICKOFF_MS } from "../../src/cli/snapshot.js";
import type { ProScheduleReader } from "../../src/domain/analytics/types.js";
import type { ProSchedule } from "../../src/providers/platform.js";
import { normalizeProSchedule } from "../../src/providers/espn/normalize.js";
import { ROOT } from "./helpers.js";

const LAUNCH_LATENCY_MS = 300;
let savedTz: string | undefined;
let schedule: ProSchedule;

beforeAll(() => {
  savedTz = process.env.TZ;
  process.env.TZ = "America/New_York";
  const body = JSON.parse(
    readFileSync(
      path.join(ROOT, "fixtures", "espn", "recorded", "season", "proTeamSchedules_wl.json"),
      "utf8",
    ),
  ) as Parameters<typeof normalizeProSchedule>[0];
  schedule = normalizeProSchedule(body, 2026);
});
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

function calendarOf(name: string): readonly CalendarEntry[] {
  const job = JOBS.find((j) => j.name === name);
  if (job === undefined) throw new Error(`no job ${name}`);
  return job.calendar;
}

/** Every wake of `calendar` between two instants (local time, like launchd), latency included. */
function wakes(calendar: readonly CalendarEntry[], fromMs: number, toMs: number): number[] {
  const out = new Set<number>();
  const d0 = new Date(fromMs);
  for (
    let d = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate());
    d.getTime() < toMs;
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
  ) {
    for (const e of calendar) {
      if (e.Weekday !== undefined && e.Weekday !== d.getDay()) continue;
      const hours = e.Hour === undefined ? [...Array(24).keys()] : [e.Hour];
      for (const h of hours)
        out.add(
          new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, e.Minute ?? 0).getTime() +
            LAUNCH_LATENCY_MS,
        );
    }
  }
  return [...out].sort((a, b) => a - b);
}

function kickoffs(): number[] {
  return schedule.games
    .filter((g) => g.kickoff !== null && !g.start_time_tbd)
    .map((g) => Date.parse(g.kickoff ?? ""))
    .filter((k) => Number.isFinite(k))
    .sort((a, b) => a - b);
}

/** Each local day's first kickoff. */
function dayFirsts(): number[] {
  const byDay = new Map<string, number>();
  for (const k of kickoffs()) {
    const d = new Date(k);
    const key = `${String(d.getFullYear())}-${String(d.getMonth())}-${String(d.getDate())}`;
    if (!byDay.has(key)) byDay.set(key, k);
  }
  return [...byDay.values()].sort((a, b) => a - b);
}

const reader = (): ProScheduleReader => ({
  games: () => ({
    rows: schedule.games,
    stamp: { as_of: "2026-09-01T00:00:00.000Z" } as never,
  }),
  teams: () => ({ rows: schedule.teams, stamp: null }),
});

describe("the recorded 2026 schedule has game days outside Thu/Sun/Mon", () => {
  it("Wednesday, Friday and Saturday game days exist (the cadence cannot come from weekday names)", () => {
    const days = new Set(dayFirsts().map((k) => new Date(k).getDay()));
    expect(days.has(3) || days.has(5) || days.has(6)).toBe(true);
  });
});

describe("pre-kickoff: one working run per game day, about an hour before the first kickoff", () => {
  it("every game day gets exactly one working wake; on-the-hour kickoffs are checked 60 min before", () => {
    const firsts = dayFirsts();
    const all = wakes(
      calendarOf("pre-kickoff"),
      firsts[0]! - 86_400_000,
      firsts.at(-1)! + 86_400_000,
    );
    // each wake judged once, as the job judges itself
    const working = new Map<number, number[]>();
    for (const w of all) {
      const first = nextDayFirstKickoff(schedule, w);
      if (first !== null && isWorkingRun(w, first - PRE_KICKOFF_MS))
        working.set(first, [...(working.get(first) ?? []), w]);
    }
    const missed: string[] = [];
    for (const k of firsts) {
      const runs = working.get(k) ?? [];
      if (runs.length !== 1) {
        missed.push(`${new Date(k).toString()}: ${String(runs.length)} working wake(s)`);
        continue;
      }
      const leadMin = (k - runs[0]!) / 60_000;
      expect(leadMin).toBeGreaterThan(54);
      expect(leadMin).toBeLessThanOrEqual(115);
      if (new Date(k).getMinutes() === 0) expect(leadMin).toBeLessThanOrEqual(60);
    }
    expect(missed).toEqual([]);
  });
});

describe("snapshot roster --pre-kickoff: one pre-week snapshot every week", () => {
  it("every week with a kickoff gets exactly one working wake before its first kickoff", () => {
    const ks = kickoffs();
    const all = wakes(calendarOf("snapshot-roster-gameday"), ks[0]! - 7 * 86_400_000, ks.at(-1)!);
    // every week with a confirmed kickoff (the recorded schedule's week 18 is still all TBD)
    const weeks = [
      ...new Set(
        schedule.games.filter((g) => g.kickoff !== null && !g.start_time_tbd).map((g) => g.week),
      ),
    ].sort((a, b) => a - b);
    expect(weeks.length).toBeGreaterThanOrEqual(17);
    const byWeek = new Map<number, number>();
    for (const w of all) {
      const first = weekFirstKickoff(schedule, w);
      if (first !== null && isWorkingRun(w, first.at - ROSTER_PRE_KICKOFF_MS))
        byWeek.set(first.week, (byWeek.get(first.week) ?? 0) + 1);
    }
    for (const wk of weeks) expect([wk, byWeek.get(wk) ?? 0]).toEqual([wk, 1]);
  });
});

describe("the schedule refreshes follow the schedule's game days", () => {
  it("espn:schedule and nflverse:schedules work every wake on a game day, every 6 h otherwise", () => {
    const firsts = dayFirsts();
    const offDay = (() => {
      for (let t = firsts[0]!; t < firsts.at(-1)!; t += 86_400_000) {
        const d = new Date(t);
        if (!firsts.some((k) => new Date(k).toDateString() === d.toDateString())) return t;
      }
      throw new Error("no off day");
    })();
    const satOrWedOrFri = firsts.find((k) => [3, 5, 6].includes(new Date(k).getDay()));
    expect(satOrWedOrFri).toBeDefined();
    for (const [job, perGameDay] of [
      ["refresh-espn-schedule", 24],
      ["refresh-nflverse-schedules", 48],
    ] as const) {
      expect(JOBS.find((j) => j.name === job)?.argv).toContain("--game-day-cadence");
      const day = (t: number): number[] => {
        const d = new Date(t);
        const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        return wakes(calendarOf(job), start, start + 86_400_000 - 1);
      };
      const gameDayWakes = day(satOrWedOrFri!).filter((w) =>
        gameDayCadenceWorks(reader(), 2026, w),
      );
      expect(gameDayWakes).toHaveLength(perGameDay);
      const offDayWorking = day(offDay)
        .filter((w) => gameDayCadenceWorks(reader(), 2026, w))
        .map((w) => new Date(w).getHours());
      expect(offDayWorking).toEqual([0, 6, 12, 18]);
    }
    // a schedule never loaded works every wake (the refresh is what loads it)
    const empty: ProScheduleReader = {
      games: () => ({ rows: [], stamp: null }),
      teams: () => ({ rows: [], stamp: null }),
    };
    expect(gameDayCadenceWorks(empty, 2026, offDay + 3 * 3_600_000 + 1_800_000)).toBe(true);
  });
});
