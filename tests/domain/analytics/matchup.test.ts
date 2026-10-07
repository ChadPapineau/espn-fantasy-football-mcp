// matchup.test.ts — E3 `pre` / `live` (src/domain/analytics/matchup.ts; plan 07 E3; plan 10 B9;
// sib research 05 §11.1–§11.2). Synthetic: pre-week P(win) agrees with the totals kernel and the
// Monte-Carlo copula agrees with the normal approximation; live conditioning (final = point mass at
// ESPN's actual, in progress = so far + the remaining fraction, pending = the full Dist); a decided
// game; the interval; seeds, deadlines and hostile inputs; properties — `actionable_slots` never
// names a seat whose occupant is locked, live or final; the remaining fraction is monotone; the
// copula's quantile function is monotone. Fixture (B9, hard): fx-10h `sunday-live` through the real
// provider — the final/live/pending split equals an independent read of the raw pro schedule, no
// locked seat is actionable; `all-locked` — nothing actionable.
import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { AnalyticsError } from "../../../src/domain/analytics/errors.js";
import type { LineupPlayer } from "../../../src/domain/analytics/lineup.js";
import {
  LIVE,
  actionableSlots,
  analyzeMatchupWin,
  canMove,
  cholesky,
  contributionOf,
  distQuantile,
  fractionRemaining,
  matchupPlayerOf,
  type MatchupPlayer,
  type MatchupWinRequest,
} from "../../../src/domain/analytics/matchup.js";
import { pairMoments, pWinNormal } from "../../../src/domain/analytics/totals.js";
import { seededRng } from "../../../src/domain/clock.js";
import { lockPlan } from "../../../src/domain/league/schedule.js";
import type { GameState } from "../../../src/domain/league/types.js";
import { applyJsonPatch, readDerivedManifest } from "../../../src/providers/espn/fixture-league.js";
import {
  bare,
  clockAndRng,
  dist,
  ELIGIBLE,
  instantPacer,
  referenceSlots,
  steppingPacer,
} from "./helpers.js";
import {
  FX10H,
  FX_WEEK,
  MY_TEAM,
  fxLeague,
  lineupPlayers,
  projectRosters,
  type FxLeague,
} from "./fx10h-world.js";

const NOW = Date.parse("2026-10-11T18:05:00.000Z");

function player(
  id: number,
  pos: string,
  mean: number,
  slot: number,
  over: Partial<LineupPlayer> = {},
): LineupPlayer {
  return {
    player_id: id,
    gsis_id: null,
    name: bare(`P${String(id)}`),
    position: pos,
    eligible_slot_ids: ELIGIBLE[pos] ?? [],
    injury_status: null,
    pro_team_id: id,
    slot_id: slot,
    locked: false,
    lock_at: null,
    points: dist(mean, 0.45),
    p_active: 1,
    espn_projection: mean,
    percent_started: null,
    role_games: 4,
    ...over,
  };
}

const mp = (
  p: LineupPlayer,
  game_state: GameState = "pre",
  points_so_far: number | null = null,
  kickoff_ms: number | null = null,
): MatchupPlayer => ({ player: p, game_state, points_so_far, kickoff_ms });

/** A full reference lineup (QB, 2 RB, 2 WR, TE, FLEX, D/ST, K) plus two bench players. */
function roster(base: number, scale = 1): LineupPlayer[] {
  return [
    player(base + 1, "QB", 20 * scale, 0),
    player(base + 2, "RB", 14 * scale, 2),
    player(base + 3, "RB", 12 * scale, 2),
    player(base + 4, "WR", 13 * scale, 4),
    player(base + 5, "WR", 11 * scale, 4),
    player(base + 6, "TE", 9 * scale, 6),
    player(base + 7, "WR", 10 * scale, 23),
    player(base + 8, "D/ST", 7 * scale, 16),
    player(base + 9, "K", 8 * scale, 17),
    player(base + 10, "RB", 9 * scale, 20),
    player(base + 11, "WR", 6 * scale, 20),
  ];
}

function req(over: Partial<MatchupWinRequest> = {}): MatchupWinRequest {
  const { clock } = clockAndRng("2026-10-11T18:05:00.000Z");
  return {
    mode: "pre",
    roster: referenceSlots(),
    me: roster(100).map((p) => mp(p)),
    opponent: roster(200, 0.95).map((p) => mp(p)),
    method: "normal",
    n_sims: 4000,
    clock,
    rng: seededRng(3),
    pacer: instantPacer,
    deadline_ms: null,
    ...over,
  };
}

describe("pre-week P(win)", () => {
  it("normal: equals the totals kernel on my lineup as set vs the opponent's best lineup", async () => {
    const out = await analyzeMatchupWin(req());
    const starters = (ps: readonly LineupPlayer[]) =>
      ps
        .filter((p) => p.slot_id !== 20)
        .map((p) => ({
          player_id: p.player_id,
          position: p.position,
          pro_team_id: p.pro_team_id,
          points: p.points,
        }));
    const pm = pairMoments(starters(roster(100)), starters(roster(200, 0.95)));
    expect(out.data.p_win).toBeCloseTo(pWinNormal(pm), 3);
    expect(out.data.mu_m).toBeCloseTo(pm.mu_m, 3);
    expect(out.data.live).toBeNull();
    expect(out.data.mode).toBe("pre");
    expect(out.data.rec.decision_metric).toBe("p_win");
    expect(out.data.rec.no_move).toBe(true);
    expect(out.completed_paths).toBe(0);
  });

  it("the opponent is assumed to start his best legal lineup (a better bench player is promoted)", async () => {
    const opp = roster(200, 0.95).map((p) => (p.player_id === 210 ? player(210, "RB", 40, 20) : p));
    const out = await analyzeMatchupWin(req({ opponent: opp.map((p) => mp(p)) }));
    const base = await analyzeMatchupWin(req());
    expect(out.data.mu_o).toBeGreaterThan(base.data.mu_o + 20);
    expect(out.data.rec.assumptions[0]?.text).toMatch(/highest-projected legal lineup/);
  });

  it("Monte Carlo agrees with the normal approximation within 0.03 and is deterministic by seed", async () => {
    const n = await analyzeMatchupWin(req());
    const a = await analyzeMatchupWin(req({ method: "mc", n_sims: 8000 }));
    const b = await analyzeMatchupWin(req({ method: "mc", n_sims: 8000 }));
    expect(Math.abs(a.data.p_win - n.data.p_win)).toBeLessThan(0.03);
    expect(a.data).toEqual(b.data);
    expect(a.completed_paths).toBe(8000);
    expect(a.data.interval[0]).toBeLessThanOrEqual(a.data.p_win);
    expect(a.data.interval[1]).toBeGreaterThanOrEqual(a.data.p_win);
  });

  it("method defaults to Monte Carlo; an all-player_sim lineup reports basis player_sim", async () => {
    const { method: _m, ...noMethod } = req();
    const out = await analyzeMatchupWin({ ...noMethod, n_sims: 1000 });
    expect(out.data.method).toBe("mc");
    expect(out.completed_paths).toBe(1000);
    expect(out.data.basis).toBe("position_cv");
    const sim = roster(100).map((p) => mp({ ...p, points: { ...p.points, basis: "player_sim" } }));
    expect((await analyzeMatchupWin(req({ me: sim }))).data.basis).toBe("player_sim");
  });

  it("the CPU deadline stops the sampler: partial, the completed count, a warning", async () => {
    const out = await analyzeMatchupWin(
      req({ method: "mc", n_sims: 20_000, pacer: steppingPacer(1), deadline_ms: 30 }),
    );
    expect(out.partial).toBe(true);
    expect(out.completed_paths).toBeLessThan(20_000);
    expect(out.completed_paths).toBeGreaterThan(0);
    expect(out.warnings.some((w) => w.startsWith("partial:"))).toBe(true);
  });
});

describe("live conditioning", () => {
  it("final = a point mass at the actual; live = so far + f·μ with variance × f; pending = the full Dist", () => {
    const p = player(1, "WR", 12, 4);
    const fin = contributionOf(mp(p, "final", 17.5, NOW - 4 * 3600_000), "me", "live", NOW);
    expect(fin).toMatchObject({
      status: "final",
      so_far: 17.5,
      rem_mean: 0,
      rem_sd: 0,
      fraction_remaining: 0,
    });
    const kick = NOW - 0.5 * LIVE.gameMs;
    const live = contributionOf(mp(p, "in", 6, kick), "me", "live", NOW);
    expect(live.status).toBe("live");
    expect(live.fraction_remaining).toBeCloseTo(0.5, 9);
    expect(live.rem_mean).toBeCloseTo(6, 9);
    const pend = contributionOf(mp(p, "pre"), "me", "live", NOW);
    expect(pend).toMatchObject({
      status: "pending",
      so_far: 0,
      rem_mean: 12,
      fraction_remaining: 1,
    });
    expect(live.rem_sd).toBeCloseTo(Math.sqrt(0.5) * pend.rem_sd, 9);
    // a bye is final at 0; pre mode ignores every live fact
    expect(contributionOf(mp(p, "bye"), "me", "live", NOW)).toMatchObject({
      status: "final",
      so_far: 0,
    });
    expect(contributionOf(mp(p, "final", 30, kick), "me", "pre", NOW).status).toBe("pending");
  });

  it("matchupPlayerOf: the lock plan's game state and kickoff, ESPN's actual; no lock row → tbd, never a bye", () => {
    const p = player(1, "WR", 12, 4);
    const k = new Date(NOW - 3600_000).toISOString();
    expect(matchupPlayerOf(p, { game_state: "in", kickoff: k }, 7.5)).toEqual({
      player: p,
      game_state: "in",
      points_so_far: 7.5,
      kickoff_ms: NOW - 3600_000,
    });
    // an unknown game is not a bye: a live call keeps his whole distribution (never final at 0)
    expect(matchupPlayerOf(p, null, null)).toMatchObject({ game_state: "tbd", kickoff_ms: null });
    expect(contributionOf(matchupPlayerOf(p, null, null), "me", "live", NOW)).toMatchObject({
      status: "pending",
      rem_mean: 12,
      fraction_remaining: 1,
    });
    expect(
      matchupPlayerOf(p, { game_state: "tbd", kickoff: "nonsense" }, null).kickoff_ms,
    ).toBeNull();
  });

  it("fractionRemaining: clamps to [minRemaining, 1], unknown kickoff → half, monotone in elapsed time", () => {
    expect(fractionRemaining(NOW, NOW)).toBe(1);
    expect(fractionRemaining(NOW + 3600_000, NOW)).toBe(1);
    expect(fractionRemaining(NOW - 10 * LIVE.gameMs, NOW)).toBe(LIVE.minRemaining);
    expect(fractionRemaining(null, NOW)).toBe(LIVE.unknownRemaining);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 6 * 3600_000 }),
        fc.integer({ min: 0, max: 3600_000 }),
        (e, d) => fractionRemaining(NOW - e - d, NOW) <= fractionRemaining(NOW - e, NOW),
      ),
    );
  });

  it("live splits both lineups' starters; points so far are summed per side; a decided game is 1 / 0", async () => {
    const kick = NOW - 0.5 * LIVE.gameMs;
    const me = roster(100).map((p, i) =>
      i < 3
        ? mp({ ...p, locked: true }, "final", 20, kick - 3 * 3600_000)
        : i < 5
          ? mp({ ...p, locked: true }, "in", 5, kick)
          : mp(p),
    );
    const opp = roster(200).map((p) => mp(p));
    const out = await analyzeMatchupWin(req({ mode: "live", me, opponent: opp }));
    const live = out.data.live;
    expect(live?.players_final).toEqual([101, 102, 103]);
    expect(live?.players_live.map((x) => x.player_id)).toEqual([104, 105]);
    expect(live?.players_live.every((x) => x.fraction_remaining === 0.5)).toBe(true);
    expect(live?.players_pending).toEqual([
      106, 107, 108, 109, 201, 202, 203, 204, 205, 206, 207, 208, 209,
    ]);
    expect(live?.points_so_far).toEqual({ me: 70, opp: 0 });
    // every starter final: the result is decided
    const done = (ps: LineupPlayer[], pts: number) =>
      ps.map((p) => mp({ ...p, locked: true }, "final", pts, kick - 4 * 3600_000));
    const won = await analyzeMatchupWin(
      req({
        mode: "live",
        method: "mc",
        me: done(roster(100), 12),
        opponent: done(roster(200), 10),
      }),
    );
    expect(won.data.p_win).toBe(1);
    expect(won.data.interval).toEqual([1, 1]);
    expect(won.data.actionable_slots).toEqual([]);
    expect(won.data.rec.action).toMatch(/^nothing actionable/);
    const tie = await analyzeMatchupWin(
      req({ mode: "live", me: done(roster(100), 10), opponent: done(roster(200), 10) }),
    );
    expect(tie.data.p_win).toBe(0.5);
  });

  it("a big lead with little left to play is near-certain; ESPN's numbers pass through, labelled", async () => {
    const kick = NOW - 0.95 * LIVE.gameMs;
    const me = roster(100).map((p) => mp({ ...p, locked: true }, "in", 15, kick));
    const opp = roster(200).map((p) => mp({ ...p, locked: true }, "in", 8, kick));
    const cross = { win_probability_espn: 0.97, projected_live_espn: { me: 140, opp: 80 } };
    const out = await analyzeMatchupWin(
      req({ mode: "live", me, opponent: opp, espn_cross_check: cross }),
    );
    expect(out.data.p_win).toBeGreaterThan(0.99);
    expect(out.data.espn_cross_check).toEqual(cross);
  });

  it("live facts unread: nothing conditioned — the pre-game P(win) of the lineups as set, live null, partial, said", async () => {
    // the gate's cold call: the box score unread (no actuals) while the schedule says the games
    // are final or under way — before the fix every one of them scored 0
    const kick = NOW - 0.5 * LIVE.gameMs;
    const asSet = (base: number, scale: number) =>
      roster(base, scale).map((p, i) =>
        i < 4 ? mp({ ...p, locked: true }, i < 2 ? "final" : "in", null, kick) : mp(p),
      );
    const me = asSet(100, 1);
    const opp = asSet(200, 0.95);
    const unread = ["the box score's points so far (espn:mBoxscore)"];
    for (const method of ["normal", "mc"] as const) {
      const out = await analyzeMatchupWin(
        req({ mode: "live", method, me, opponent: opp, live_unread: unread }),
      );
      // the same number as the pre-game read of the SAME lineups (live: the opponent's lineup as set)
      const pre = await analyzeMatchupWin(
        req({
          mode: "live",
          method,
          me: me.map((x) => mp(x.player)),
          opponent: opp.map((x) => mp(x.player)),
        }),
      );
      expect(out.data.p_win).toBe(pre.data.p_win);
      expect(out.data.interval).toEqual(pre.data.interval);
      expect(out.data.mu_m).toBe(pre.data.mu_m);
      expect(out.data.sigma_m).toBeGreaterThan(0);
      expect(out.data.interval[1]).toBeGreaterThan(out.data.interval[0]);
      expect(out.data.live).toBeNull();
      expect(out.partial).toBe(true);
      expect(out.data.mode).toBe("live");
      expect(out.data.rec.action).toMatch(/pre-game win probability.*live facts not read/);
      expect(out.data.rec.drivers.map((d) => d.name)).toEqual(["projected_margin"]);
      expect(out.data.rec.assumptions.map((a) => a.text).join("\n")).toContain(
        "live facts not read (the box score's points so far (espn:mBoxscore))",
      );
      expect(out.warnings).toContain(
        "live conditioning unavailable: the box score's points so far (espn:mBoxscore) not read; p_win is the pre-game number for the lineups as set (live: null) — call again for the live one",
      );
      // no conditioned-only warning leaks in ("scored 0" would be the fabrication)
      expect(out.warnings.some((w) => w.includes("scored 0"))).toBe(false);
      // locked seats stay unactionable: the lock facts are not live facts
      expect(out.data.actionable_slots).toEqual(pre.data.actionable_slots);
    }
    // both missing are named once each, deduplicated; pre ignores the field
    const both = await analyzeMatchupWin(
      req({ mode: "live", me, opponent: opp, live_unread: [...unread, "x", "x"] }),
    );
    expect(both.warnings.filter((w) => w.startsWith("live conditioning unavailable"))).toEqual([
      `live conditioning unavailable: ${unread[0] ?? ""} and x not read; p_win is the pre-game number for the lineups as set (live: null) — call again for the live one`,
    ]);
    const pre = await analyzeMatchupWin(req({ mode: "pre", live_unread: unread }));
    expect(pre.partial).toBe(false);
    expect(pre.warnings.some((w) => w.startsWith("live conditioning"))).toBe(false);
    // an empty list is a read: conditioned as before
    const read = await analyzeMatchupWin(req({ mode: "live", me, opponent: opp, live_unread: [] }));
    expect(read.data.live?.players_final.length).toBe(4);
    expect(read.partial).toBe(false);
  });

  it("warnings: a live player without a kickoff, a final player without an actual", async () => {
    const me = roster(100).map((p, i) =>
      i === 0
        ? mp({ ...p, locked: true }, "in", 3, null)
        : i === 1
          ? mp({ ...p, locked: true }, "final", null, NOW - 5 * 3600_000)
          : mp(p),
    );
    const out = await analyzeMatchupWin(req({ mode: "live", me }));
    expect(out.warnings).toContain(
      "1 live players without a kickoff: half the game assumed to remain",
    );
    expect(out.warnings).toContain("1 finished players without an ESPN actual: scored 0");
  });
});

describe("actionable slots (sib research 05 §11 pitfall: a locked slot is never actionable)", () => {
  it("only seats whose occupant can still move; an empty seat only with an unlocked eligible reserve", () => {
    const slots = referenceSlots();
    const me = roster(100).map((p) => mp(p));
    const all = actionableSlots(slots, me, NOW);
    expect(all.map((a) => a.slot)).toEqual([
      "QB",
      "RB",
      "RB",
      "WR",
      "WR",
      "TE",
      "FLEX",
      "D/ST",
      "K",
    ]);
    const lockedQb = me.map((x, i) => (i === 0 ? mp({ ...x.player, locked: true }) : x));
    expect(actionableSlots(slots, lockedQb, NOW).map((a) => a.slot)).not.toContain("QB");
    // the TE seat empty: no reserve TE/flex-eligible unlocked → not actionable; with one → actionable
    const noTe = me.filter((x) => x.player.position !== "TE");
    const bench = noTe.map((x) =>
      x.player.slot_id === 20 ? mp({ ...x.player, locked: true }, "in") : x,
    );
    expect(actionableSlots(slots, bench, NOW).map((a) => a.slot)).not.toContain("TE");
    const withTe = [...bench, mp(player(150, "TE", 5, 20))];
    expect(actionableSlots(slots, withTe, NOW).filter((a) => a.slot === "TE")).toEqual([
      { slot: "TE", lock_at: null },
    ]);
  });

  it("canMove: never once ESPN locks him, his game starts or ends, or his lock instant passes", () => {
    const p = player(1, "WR", 10, 4);
    expect(canMove(mp(p), NOW)).toBe(true);
    expect(canMove(mp({ ...p, locked: true }), NOW)).toBe(false);
    expect(canMove(mp(p, "in"), NOW)).toBe(false);
    expect(canMove(mp(p, "final"), NOW)).toBe(false);
    expect(canMove(mp({ ...p, lock_at: new Date(NOW - 1).toISOString() }), NOW)).toBe(false);
    expect(canMove(mp({ ...p, lock_at: new Date(NOW + 1).toISOString() }), NOW)).toBe(true);
  });

  it("property: no actionable seat is held by a locked, live or final player, in any lineup state", () => {
    const states: GameState[] = ["pre", "in", "final", "bye", "tbd"];
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            locked: fc.boolean(),
            state: fc.constantFrom(...states),
            lockOffset: fc.option(fc.integer({ min: -7200_000, max: 7200_000 }), { nil: null }),
          }),
          { minLength: 11, maxLength: 11 },
        ),
        (flags) => {
          const me = roster(100).map((p, i) => {
            const f = flags[i] ?? { locked: false, state: "pre" as GameState, lockOffset: null };
            const lock_at =
              f.lockOffset === null ? null : new Date(NOW + f.lockOffset).toISOString();
            return mp({ ...p, locked: f.locked, lock_at }, f.state);
          });
          const slots = referenceSlots();
          const act = actionableSlots(slots, me, NOW);
          // every occupied actionable seat maps to a movable occupant of that slot name
          for (const a of act) {
            const slotId = slots.slots.find((s) => s.name === a.slot)?.slot_id;
            const occ = me.filter((x) => x.player.slot_id === slotId);
            const movable = occ.filter((x) => canMove(x, NOW));
            const reserves = me.filter((x) => x.player.slot_id === 20 && canMove(x, NOW));
            if (movable.length === 0 && reserves.length === 0) return false;
          }
          const lockedSeats = me.filter((x) => x.player.slot_id !== 20 && !canMove(x, NOW)).length;
          const movableSeats = me.filter((x) => x.player.slot_id !== 20 && canMove(x, NOW)).length;
          return act.length === movableSeats && lockedSeats + movableSeats === 9;
        },
      ),
    );
  });
});

describe("the copula's pieces (ported)", () => {
  it("distQuantile is monotone and honours p_zero; cholesky reproduces a correlation matrix", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 40, noNaN: true }),
        fc.double({ min: 0.1, max: 1.2, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (mean, cv, u, v) => {
          const d = dist(mean, cv);
          const [lo, hi] = u <= v ? [u, v] : [v, u];
          return distQuantile(d, lo) <= distQuantile(d, hi) + 1e-9;
        },
      ),
    );
    expect(distQuantile({ ...dist(10), p_zero: 0.3 }, 0.2)).toBe(0);
    const c = [
      [1, 0.35, 0],
      [0.35, 1, 0.28],
      [0, 0.28, 1],
    ];
    const l = cholesky(c);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        let s = 0;
        for (let k = 0; k < 3; k++) s += (l[i]?.[k] ?? 0) * (l[j]?.[k] ?? 0);
        expect(s).toBeCloseTo(c[i]?.[j] ?? 0, 9);
      }
  });
});

describe("hostile inputs", () => {
  it("no opponent, an empty opponent, n_sims out of range, a duplicated player, an empty lineup", async () => {
    await expect(analyzeMatchupWin(req({ opponent: null }))).rejects.toBeInstanceOf(AnalyticsError);
    await expect(analyzeMatchupWin(req({ opponent: [] }))).rejects.toBeInstanceOf(AnalyticsError);
    await expect(analyzeMatchupWin(req({ n_sims: 10 }))).rejects.toThrow(/n_sims/);
    await expect(analyzeMatchupWin(req({ n_sims: 1500.5 }))).rejects.toThrow(/n_sims/);
    const dup = roster(100).map((p) => mp(p));
    await expect(
      analyzeMatchupWin(req({ opponent: [...dup.slice(0, 2), ...roster(200).map((p) => mp(p))] })),
    ).rejects.toThrow(/twice/);
    const benchOnly = roster(100).map((p) => mp({ ...p, slot_id: 20 }));
    await expect(analyzeMatchupWin(req({ me: benchOnly }))).rejects.toThrow(/no starter/);
    await expect(
      analyzeMatchupWin(
        req({
          mode: "live",
          opponent: benchOnly.map((x) => ({
            ...x,
            player: { ...x.player, player_id: x.player.player_id + 1000 },
          })),
        }),
      ),
    ).rejects.toThrow(/opponent's lineup has no starter/);
    await expect(analyzeMatchupWin(req({ me: [] }))).rejects.toThrow(/roster size/);
  });

  it("NaN points so far read as 0; a NaN Dist never yields a NaN P(win)", async () => {
    const me = roster(100).map((p, i) =>
      i === 0 ? mp({ ...p, locked: true }, "final", Number.NaN, NOW - 9e6) : mp(p),
    );
    const out = await analyzeMatchupWin(req({ mode: "live", me }));
    expect(Number.isFinite(out.data.p_win)).toBe(true);
    expect(out.data.live?.points_so_far.me).toBe(0);
  });
});

// --- plan 10 B9 on fx-10h (hard) ----------------------------------------------------------------------

/** An independent read of a variant's raw pro schedule: each pro team's week-5 game. */
function rawWeekGames(variant: string): Map<number, { kickoff: number; official: boolean }> {
  const dir = path.join(FX10H, variant);
  const m = readDerivedManifest(dir);
  const v = m?.views.find((x) => x.views.includes("proTeamSchedules_wl"));
  if (v === undefined) throw new Error("no pro schedule view");
  const root = path.resolve(FX10H, "..");
  const read = (rel: string): unknown =>
    JSON.parse(readFileSync(path.join(root, rel), "utf8")) as unknown;
  const body = (
    v.patch === undefined ? read(v.path) : applyJsonPatch(read(v.path), read(v.patch))
  ) as {
    settings: {
      proTeams: {
        id: number;
        proGamesByScoringPeriod?: Record<string, { date: number; statsOfficial: boolean }[]>;
      }[];
    };
  };
  const out = new Map<number, { kickoff: number; official: boolean }>();
  for (const t of body.settings.proTeams) {
    const g = t.proGamesByScoringPeriod?.[String(FX_WEEK)]?.[0];
    if (g !== undefined) out.set(t.id, { kickoff: g.date, official: g.statsOfficial });
  }
  return out;
}

async function liveInputs(fx: FxLeague): Promise<{ me: MatchupPlayer[]; opp: MatchupPlayer[] }> {
  const box = fx.box.find((b) => b.home.team_id === MY_TEAM || b.away?.team_id === MY_TEAM);
  if (box === undefined) throw new Error("no week-5 box score for my team");
  const away = box.away;
  if (away === null) throw new Error("my team is on a bye in week 5");
  const oppId = box.home.team_id === MY_TEAM ? away.team_id : box.home.team_id;
  const rosters = fx.rosters.filter((r) => r.team.team_id === MY_TEAM || r.team.team_id === oppId);
  const projected = await projectRosters(fx, rosters, { from: FX_WEEK, horizon: "week" });
  const sides = [box.home, away];
  const build = (teamId: number): MatchupPlayer[] => {
    const r = rosters.find((x) => x.team.team_id === teamId);
    const side = sides.find((s) => s.team_id === teamId);
    if (r === undefined || side === undefined) throw new Error("missing side");
    const plan = lockPlan(
      r.entries.map((e) => ({
        player_id: e.player.ref.id,
        pro_team_id: e.player.pro_team_id,
        lineup_locked: e.lineup_locked,
      })),
      fx.schedule,
      FX_WEEK,
      fx.slots.lineup_lock_type,
      fx.clock.nowMs(),
    );
    return lineupPlayers(fx, r, projected).map((p) =>
      matchupPlayerOf(
        p,
        plan.players.find((x) => x.player_id === p.player_id) ?? null,
        side.entries.find((x) => x.player.ref.id === p.player_id)?.actual?.applied_total ?? null,
      ),
    );
  };
  return { me: build(MY_TEAM), opp: build(oppId) };
}

describe("plan 10 B9 (hard): fx-10h sunday-live and all-locked through the provider", () => {
  let fx: FxLeague;
  let inputs: { me: MatchupPlayer[]; opp: MatchupPlayer[] };
  let out: Awaited<ReturnType<typeof analyzeMatchupWin>>;
  beforeAll(async () => {
    fx = await fxLeague("sunday-live");
    inputs = await liveInputs(fx);
    const mine = fx.live.find((l) => l.is_mine);
    const meSide = mine?.home.team_id === MY_TEAM ? mine.home : mine?.away;
    const oppSide = mine?.home.team_id === MY_TEAM ? mine.away : mine?.home;
    out = await analyzeMatchupWin({
      mode: "live",
      roster: fx.slots,
      me: inputs.me,
      opponent: inputs.opp,
      method: "mc",
      n_sims: 4000,
      espn_cross_check: {
        win_probability_espn: meSide?.win_probability_espn ?? null,
        projected_live_espn: {
          me: meSide?.projected_live_espn ?? null,
          opp: oppSide?.projected_live_espn ?? null,
        },
      },
      clock: fx.clock,
      rng: seededRng(9),
      pacer: instantPacer,
      deadline_ms: null,
    });
  });

  it("the split equals the raw schedule's: official → final, kicked off → live, later → pending, no game → final", () => {
    const raw = rawWeekGames("sunday-live");
    const now = fx.clock.nowMs();
    const expected = { final: [] as number[], live: [] as number[], pending: [] as number[] };
    for (const p of [...inputs.me, ...inputs.opp]) {
      if (p.player.slot_id === 20 || p.player.slot_id === 21) continue;
      const g = raw.get(p.player.pro_team_id ?? -1);
      const k =
        g === undefined ? "final" : g.official ? "final" : g.kickoff <= now ? "live" : "pending";
      expected[k].push(p.player.player_id);
    }
    const live = out.data.live;
    expect(live?.players_final).toEqual(expected.final.sort((a, b) => a - b));
    expect(live?.players_live.map((x) => x.player_id)).toEqual(expected.live.sort((a, b) => a - b));
    expect(live?.players_pending).toEqual(expected.pending.sort((a, b) => a - b));
    expect(expected.live.length).toBeGreaterThan(0);
    expect(expected.pending.length).toBeGreaterThan(0);
  });

  it("points so far are ESPN's actuals; the 13:00 ET games are about a third through", () => {
    const sum = (ps: MatchupPlayer[]) =>
      ps
        .filter((p) => p.player.slot_id !== 20 && p.player.slot_id !== 21)
        .reduce((s, p) => s + (p.points_so_far ?? 0), 0);
    expect(out.data.live?.points_so_far.me).toBeCloseTo(sum(inputs.me), 2);
    expect(out.data.live?.points_so_far.opp).toBeCloseTo(sum(inputs.opp), 2);
    const early = out.data.live?.players_live.filter((x) => x.fraction_remaining > 0.5) ?? [];
    expect(early.length).toBeGreaterThan(0);
    expect(early.every((x) => Math.abs(x.fraction_remaining - (1 - 65 / 190)) < 0.01)).toBe(true);
  });

  it("never a locked slot as actionable; ESPN's live probability is the labelled cross-check", () => {
    for (const a of out.data.actionable_slots) {
      const slotId = fx.slots.slots.find((s) => s.name === a.slot)?.slot_id;
      const occ = inputs.me.filter((p) => p.player.slot_id === slotId);
      expect(occ.some((p) => !p.player.locked && p.game_state === "pre")).toBe(true);
    }
    const lockedSlots = new Set(
      inputs.me
        .filter((p) => p.player.locked && p.player.slot_id !== 20)
        .map((p) => p.player.slot_id),
    );
    const actionableIds = new Set<number>(
      out.data.actionable_slots.map(
        (a) => fx.slots.slots.find((s) => s.name === a.slot)?.slot_id ?? -1,
      ),
    );
    for (const id of lockedSlots) {
      const seats = fx.slots.slots.find((s) => s.slot_id === id)?.count ?? 0;
      const occupants = inputs.me.filter((p) => p.player.slot_id === id);
      if (occupants.every((p) => p.player.locked) && occupants.length === seats)
        expect(actionableIds.has(id)).toBe(false);
    }
    expect(out.data.espn_cross_check?.win_probability_espn).toBeCloseTo(0.4853, 4);
    expect(out.data.p_win).toBeGreaterThan(0);
    expect(out.data.p_win).toBeLessThan(1);
  });

  it("all-locked: nothing actionable, and the rec says so", async () => {
    const fxl = await fxLeague("all-locked");
    const inp = await liveInputs(fxl);
    const res = await analyzeMatchupWin({
      mode: "live",
      roster: fxl.slots,
      me: inp.me,
      opponent: inp.opp,
      method: "normal",
      clock: fxl.clock,
      rng: seededRng(9),
      pacer: instantPacer,
      deadline_ms: null,
    });
    expect(res.data.actionable_slots).toEqual([]);
    expect(res.data.rec.action).toMatch(/^nothing actionable/);
    expect(res.data.rec.latest_execution_time).toBeNull();
  });
});
