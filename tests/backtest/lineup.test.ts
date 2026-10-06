// lineup.test.ts — plan 10 A11a replayed on the recorded fixture weeks (three public leagues ×
// three final weeks) with v1-ensemble: hard — `mode` follows sign(μ_m − μ_o) under reading (a) on
// every matchup, every Dist carries basis position_cv and ΔP(win) is the {sign, band} form, the
// shipped weight_espn is 1.0 (the gating rule) so the ESPN-projection baseline is identical to
// `objective: mean` and reported "not informative in v1", and no swap benches a locked starter;
// soft (reported in docs/evals/1a-backtest.md) — mean regret against "last week's points".
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeLineup } from "../../src/domain/analytics/lineup.js";
import { SHIPPED_WEIGHT_ESPN, espnBaselineInformative } from "../../src/domain/analytics/rec.js";
import { fixedClock } from "../../src/domain/clock.js";
import { LEAGUES, leagueOf, replayTeams, weeksOf } from "./helpers/fixture.js";
import {
  docSection,
  lineupSection,
  replayLineups,
  writeDocSection,
  type LineupReplay,
} from "./helpers/replay.js";

let replay: LineupReplay;

beforeAll(async () => {
  replay = await replayLineups();
  if (process.env.UPDATE_EVALS === "1") writeDocSection("lineup", lineupSection(replay.rows));
}, 120_000);

describe("A11a start/sit replay (recorded fixture weeks)", () => {
  it("replays every recorded team-week of the three leagues", () => {
    expect(replay.rows.length).toBeGreaterThanOrEqual(60);
    expect(new Set(replay.rows.map((r) => r.league)).size).toBe(3);
    for (const r of replay.rows) {
      expect(r.hindsight).toBeGreaterThanOrEqual(r.mean - 1e-9);
      expect(r.hindsight).toBeGreaterThanOrEqual(r.espn - 1e-9);
      expect(r.hindsight).toBeGreaterThanOrEqual(r.manager - 1e-9);
    }
  });

  it("(hard) the mode follows sign(μ_m − μ_o) on every matchup under reading (a)", () => {
    for (const r of replay.rows) expect(r.mode_consistent).toBe(true);
  });

  it("(hard) every Dist is position_cv and every ΔP(win) the coarse {sign, band} form", () => {
    for (const o of replay.outputs) {
      expect(o.basis).toBe("position_cv");
      expect(o.p_win_reporting).toBe("sign_and_band");
      for (const s of o.swaps) expect(Object.keys(s.delta_pwin).sort()).toEqual(["band", "sign"]);
      for (const s of o.recommended_lineup) expect(s.points.basis).toBe("position_cv");
    }
  });

  it("(hard) weight_espn ships at 1.0: the ESPN-projection baseline equals mean and is not informative", () => {
    expect(SHIPPED_WEIGHT_ESPN).toBe(1);
    expect(espnBaselineInformative()).toBe(false);
    for (const r of replay.rows) expect(r.mean).toBeCloseTo(r.espn, 6);
  });

  it("(hard) no swap benches a locked starter", () => {
    for (const league of LEAGUES) {
      const { roster } = leagueOf(league);
      const week = weeksOf(league)[0] ?? 1;
      for (const t of replayTeams(league, week)) {
        const players = t.entries.map((e, i) => ({
          player_id: e.player_id,
          gsis_id: null,
          name: `Player ${String(e.player_id)}` as never,
          position: e.position,
          eligible_slot_ids: e.eligible_slot_ids,
          injury_status: null,
          pro_team_id: e.pro_team_id,
          slot_id: e.slot_id,
          locked: i % 2 === 0,
          lock_at: null,
          points: {
            mean: e.projected ?? 0,
            p10: 0,
            p25: 0,
            p50: 0,
            p75: 0,
            p90: 0,
            p_zero: 0,
            basis: "position_cv" as const,
          },
          p_active: null,
          espn_projection: e.projected,
          percent_started: null,
          role_games: 0,
        }));
        const out = analyzeLineup({
          roster,
          players,
          opponent: null,
          seeding_config: { mode: "espn_rule", confirmed_at: null },
          clock: fixedClock("2026-09-01T12:00:00.000Z"),
        });
        const locked = new Set(players.filter((p) => p.locked).map((p) => p.player_id));
        for (const s of out.swaps) expect(locked.has(s.out ?? -1)).toBe(false);
        for (const p of players.filter((x) => x.locked)) {
          const now = out.recommended_lineup.find((s) => s.player_id === p.player_id)?.slot;
          const was = out.current_lineup.find((s) => s.player_id === p.player_id)?.slot;
          expect(now).toBe(was);
        }
      }
    }
  });

  it("(soft, reported) the numbers in docs/evals/1a-backtest.md are this replay's", () => {
    expect(docSection("lineup")).toBe(lineupSection(replay.rows));
  });
});
