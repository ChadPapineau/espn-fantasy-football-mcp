// ros-window-recorded.test.ts — Stage C round 2 (finding projection-ros-includes-week18, attempt 2):
// where ESPN's rest-of-season total STARTS, held on the RECORDED leagues (fixtures/espn/recorded;
// research 04 §B.1.1; constants.ts ESPN_ROS). league-a and league-b were captured on 2026-10-06
// after every week-4 game was final (`statsOfficial`) with the scoring period still 4 — the days
// after a week's games, when waiver and trade analysis runs. There ESPN's (1,0) total counts a
// healthy player's games in weeks 5–18 only (stat 210 = 13), so E1 must spread it as ESPN does: the
// total over HIS games left, never "the total less week 4's projection" (which under-valued every
// later week by ≈ wk4 / 13: the verifier's −7.2 % / −5.7 % league means). Every player of the pool
// page is checked through the real provider normaliser and the recorded pro schedule, read in
// process: no network, no cookie, ids only in assertion messages.
import { describe, expect, it } from "vitest";
import { projectPlayers, targetOf } from "../../../src/domain/analytics/projection.js";
import { rosShareOptsOf, weeklyValues } from "../../../src/domain/analytics/waivers.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import type { PlatformPlayer, ProSchedule } from "../../../src/domain/league/types.js";
import {
  byeWeeksOf,
  newCounts,
  normalizePlayer,
  normalizeProSchedule,
} from "../../../src/providers/espn/normalize.js";
import {
  konaPlayerInfoSchema,
  proTeamSchedulesSchema,
} from "../../../src/providers/espn/views/index.js";
import { loadFixture, NOW_ISO, SEASON } from "../../providers/espn/helpers.js";
import { instantPacer, referenceSettings } from "./helpers.js";

/** The recorded clock: week 4 current, its games final (tests/providers/espn/helpers NOW_ISO). */
const WEEK = 4;
const FINAL = 17;
const DST = 16;

interface Row {
  readonly p: PlatformPlayer;
  /** ESPN's own count of the games in its (1,0) total (stat 210). */
  readonly gp: number;
}

const schedule: ProSchedule = normalizeProSchedule(
  proTeamSchedulesSchema.parse(loadFixture("recorded/season/proTeamSchedules_wl.json")),
  SEASON,
);
const byes = byeWeeksOf(schedule);

/** His scheduled games in weeks [from, to] (the recorded schedule). */
function gamesIn(team: number, from: number, to: number): number[] {
  const weeks = new Set<number>();
  for (const g of schedule.games)
    if (
      g.week >= from &&
      g.week <= to &&
      (g.home_pro_team_id === team || g.away_pro_team_id === team)
    )
      weeks.add(g.week);
  return [...weeks].sort((a, b) => a - b);
}

/** Every pool player of a recorded league with an ESPN ROS total, its stat 210 and a week-4 projection. */
function rows(slot: "league-a" | "league-b"): Row[] {
  const kona = konaPlayerInfoSchema.parse(loadFixture(`recorded/${slot}/kona_player_info.json`));
  const out: Row[] = [];
  for (const pe of kona.players) {
    const raw = (pe.player.stats ?? []) as readonly {
      statSourceId?: number;
      statSplitTypeId?: number;
      seasonId?: number;
      stats?: Record<string, number>;
    }[];
    const split = raw.find(
      (s) => s.statSourceId === 1 && s.statSplitTypeId === 0 && s.seasonId === SEASON,
    );
    const gp = split?.stats?.["210"];
    const p = normalizePlayer(
      pe.player,
      pe,
      { season: SEASON, week: WEEK, byeWeeks: byes },
      newCounts(),
    );
    if (p === null || gp === undefined || !Number.isInteger(gp)) continue;
    if (p.projection_ros_espn === null || p.projection_week_espn === null) continue;
    out.push({ p, gp });
  }
  return out;
}

/** E1 over the recorded rows at the recorded clock, as the tool asks it (week 4 → final 17). */
async function project(targets: ReturnType<typeof targetOf>[]) {
  return projectPlayers({
    targets,
    season: SEASON,
    horizon: "ros",
    week: WEEK,
    final_week: FINAL,
    settings: referenceSettings(),
    schedule,
    clock: fixedClock(NOW_ISO),
    rng: seededRng(5),
    pacer: instantPacer,
    deadline_ms: null,
    n_sims: 1000,
  });
}

describe.each(["league-a", "league-b"] as const)(
  "Stage C round 2 on the recorded %s (after week 4's games, period 4)",
  (slot) => {
    const all = rows(slot);
    const healthy = all.filter(
      (r) => r.p.position_id !== DST && r.gp === gamesIn(r.p.pro_team_id, WEEK + 1, 18).length,
    );

    it("the recording is the post-game state the finding names: every week-4 game final, every healthy count = his games in weeks 5–18", () => {
      expect(schedule.games.filter((g) => g.week === WEEK).every((g) => g.stats_official)).toBe(
        true,
      );
      // most of the page is healthy; no healthy count equals his games in weeks 4–18
      expect(healthy.length).toBeGreaterThanOrEqual(15);
      for (const r of all.filter((x) => x.p.position_id !== DST))
        expect(r.gp, `player ${String(r.p.ref.id)}`).not.toBe(
          gamesIn(r.p.pro_team_id, WEEK, 18).length,
        );
    });

    it("by the clock alone (no count given): every healthy player's later weeks are ESPN's per-game value, ros ÷ gp — week 4 keeps his projection", async () => {
      // regression: E1 subtracted week 4's projection from a total that no longer held it —
      // (ros − wk4) ÷ 13 a game, ≈ 7 % short (the verifier's league means −7.2 % / −5.7 %)
      const out = await project(healthy.map((r) => targetOf(r.p, null)));
      healthy.forEach((r, i) => {
        const weeks = out.players[i]?.weeks ?? [];
        const per = (r.p.projection_ros_espn ?? 0) / r.gp;
        const games = new Set(gamesIn(r.p.pro_team_id, WEEK + 1, FINAL));
        const id = `player ${String(r.p.ref.id)}`;
        expect(weeks[0]?.espn, id).toBe(r.p.projection_week_espn);
        for (const w of weeks.slice(1))
          if (games.has(w.week)) expect(w.espn ?? Number.NaN, id).toBeCloseTo(per, 9);
          else expect(w.dist.mean, id).toBe(0);
      });
    });

    it("with ESPN's own count, every non-D/ST player — injured ones too — sums to ESPN's total over the weeks it covers; his next games beyond the count read 0", async () => {
      const players = all.filter((r) => r.p.position_id !== DST);
      const out = await project(
        players.map((r) => targetOf({ ...r.p, projection_ros_games_espn: r.gp }, null)),
      );
      let injured = 0;
      players.forEach((r, i) => {
        const id = `player ${String(r.p.ref.id)}`;
        const left = gamesIn(r.p.pro_team_id, WEEK + 1, 18);
        const covered = new Set(left.slice(Math.max(0, left.length - r.gp)));
        if (covered.size < left.length) injured += 1;
        const per = (r.p.projection_ros_espn ?? 0) / Math.max(1, covered.size);
        let sum = 0;
        for (const w of out.players[i]?.weeks.slice(1) ?? []) {
          if (covered.has(w.week)) {
            expect(w.espn ?? Number.NaN, id).toBeCloseTo(per, 9);
            sum += w.espn ?? 0;
          } else if (left.includes(w.week)) expect(w.espn, id).toBe(0);
        }
        // the league's weeks end at 17: week 18's covered game is the rest of ESPN's total
        if (covered.has(18)) sum += per;
        if (covered.size > 0) expect(sum, id).toBeCloseTo(r.p.projection_ros_espn ?? 0, 6);
      });
      // the recordings carry injured counts (12, 11, 10, 3): the case is exercised
      expect(injured).toBeGreaterThanOrEqual(1);
    });

    it("weeklyValues (E4–E9's helper), given the schedule at the clock, reads every player exactly as E1 does — with and without ESPN's count", async () => {
      const weeks = Array.from({ length: FINAL - WEEK + 1 }, (_, i) => WEEK + i);
      const now = Date.parse(NOW_ISO);
      for (const counted of [false, true]) {
        const ps = all.map((r) => (counted ? { ...r.p, projection_ros_games_espn: r.gp } : r.p));
        const out = await project(ps.map((p) => targetOf(p, null)));
        ps.forEach((p, i) => {
          const v = weeklyValues(
            weeks,
            p.projection_week_espn,
            p.projection_ros_espn,
            p.bye_week,
            rosShareOptsOf(p, schedule, SEASON, now),
          );
          const e1 = out.players[i]?.weeks.map((w) => w.espn ?? (w.bye ? 0 : null)) ?? [];
          v.forEach((x, k) => {
            expect(
              x ?? Number.NaN,
              `player ${String(p.ref.id)} week ${String(weeks[k])}`,
            ).toBeCloseTo(e1[k] ?? Number.NaN, 9);
          });
        });
      }
    });

    it("a D/ST's total spans its whole season: (ros − week 4) ÷ 16 a game, with or without its count of 17", async () => {
      const dst = all.filter((r) => r.p.position_id === DST);
      expect(dst.length).toBeGreaterThanOrEqual(1);
      for (const r of dst) expect(r.gp).toBe(gamesIn(r.p.pro_team_id, 1, 18).length);
      for (const withCount of [false, true]) {
        const out = await project(
          dst.map((r) =>
            targetOf(withCount ? { ...r.p, projection_ros_games_espn: r.gp } : r.p, null),
          ),
        );
        dst.forEach((r, i) => {
          const per = ((r.p.projection_ros_espn ?? 0) - (r.p.projection_week_espn ?? 0)) / 16;
          const games = new Set(gamesIn(r.p.pro_team_id, WEEK + 1, FINAL));
          for (const w of out.players[i]?.weeks.slice(1) ?? [])
            if (games.has(w.week))
              expect(w.espn ?? Number.NaN, `D/ST ${String(r.p.ref.id)}`).toBeCloseTo(per, 9);
        });
      }
    });
  },
);
