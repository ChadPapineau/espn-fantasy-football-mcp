// helpers.ts — shared builders for the analytics tests: a reference-format league (research 05 §0:
// 10 teams, half-PPR, 5-pt pass TD, QB/2RB/2WR/TE/FLEX/D/ST/K, 5 BE, 2 IR — built through the
// scoring and league modules exactly as the tools will), players and Dists, and pacers. Synthetic
// data only: no recorded id, name or league value.
import { fixedClock, seededRng, type FixedClock, type Rng } from "../../../src/domain/clock.js";
import type { Pacer } from "../../../src/domain/analytics/cooperative.js";
import { buildRosterSlots } from "../../../src/domain/league/slots.js";
import type {
  BareText,
  ProGame,
  ProSchedule,
  ProTeam,
  RosterSlots,
} from "../../../src/domain/league/types.js";
import { normalizeSettings } from "../../../src/domain/scoring/settings.js";
import type { Dist, ScoringSettings } from "../../../src/domain/scoring/types.js";
import { REFERENCE_SCORING_SETTINGS } from "../scoring/helpers.js";

/** A BareText for tests (the real ones come from bareUntrusted at the provider). */
export const bare = (s: string): BareText => s as BareText;

/** Reference scoring (research 05 §0; the scoring module's hand-written reference S), pass TD varied. */
export function referenceSettings(passTd = 5): ScoringSettings {
  return normalizeSettings({
    ...REFERENCE_SCORING_SETTINGS,
    scoringItems: REFERENCE_SCORING_SETTINGS.scoringItems.map((i) =>
      i.statId === 4 ? { ...i, points: passTd } : i,
    ),
  });
}

/** The reference roster: QB, 2 RB, 2 WR, TE, FLEX, D/ST, K, 5 BE, 2 IR (slot ids per research 03 §B.2). */
export function referenceSlots(extra: Record<string, number> = {}): RosterSlots {
  return buildRosterSlots({
    slot_counts: {
      "0": 1,
      "2": 2,
      "4": 2,
      "6": 1,
      "23": 1,
      "16": 1,
      "17": 1,
      "20": 5,
      "21": 2,
      ...extra,
    },
    position_limits: {},
    lineup_lock_type: "INDIVIDUAL_GAME",
    undroppable_list: false,
    move_limit: null,
  }).roster;
}

/** Eligible slots by display position (ESPN's eligibleSlots shape: own slot, flexes, BE, IR). */
export const ELIGIBLE: Readonly<Record<string, readonly number[]>> = Object.freeze({
  QB: [0, 7, 20, 21],
  RB: [2, 3, 23, 7, 20, 21],
  WR: [4, 3, 5, 23, 7, 20, 21],
  TE: [6, 5, 23, 7, 20, 21],
  K: [17, 20, 21],
  "D/ST": [16, 20, 21],
});

/** ESPN position ids by display position. */
export const POSITION_ID: Readonly<Record<string, number>> = Object.freeze({
  QB: 1,
  RB: 2,
  WR: 3,
  TE: 4,
  K: 5,
  "D/ST": 16,
});

/** A Dist with a normal-ish spread around `mean` (sd = cv × mean). */
export function dist(mean: number, cv = 0.5): Dist {
  const sd = Math.abs(mean) * cv;
  const z = 1.2815515655446004;
  return {
    mean,
    p10: mean - z * sd,
    p25: mean - 0.674 * sd,
    p50: mean,
    p75: mean + 0.674 * sd,
    p90: mean + z * sd,
    p_zero: 0,
    basis: "position_cv",
  };
}

/** A 32-team pro league (ids 1..32) with week games pairing 1v2, 3v4, … at fixed kickoffs. */
export function proSchedule(
  season: number,
  weeks: readonly number[],
  opts: {
    readonly byes?: Readonly<Record<string, readonly number[]>>;
    readonly kickoffMs?: (week: number, home: number) => number | null;
  } = {},
): ProSchedule {
  const teams: ProTeam[] = Array.from({ length: 32 }, (_, i) => ({
    id: i + 1,
    abbrev: `T${String(i + 1)}`,
    bye_week: null,
  }));
  const games: ProGame[] = [];
  let id = 1;
  for (const w of weeks) {
    const off = new Set(opts.byes?.[String(w)] ?? []);
    const playing = teams.map((t) => t.id).filter((t) => !off.has(t));
    for (let i = 0; i + 1 < playing.length; i += 2) {
      const home = playing[i] ?? 0;
      const away = playing[i + 1] ?? 0;
      const base = Date.UTC(season, 8, 6 + 7 * (w - 1), 17, 0, 0);
      const k = opts.kickoffMs === undefined ? base : opts.kickoffMs(w, home);
      games.push({
        espn_game_id: id++,
        season,
        week: w,
        kickoff: k === null ? null : new Date(k).toISOString(),
        start_time_tbd: k === null,
        valid_for_locking: k !== null,
        stats_official: false,
        home_pro_team_id: home,
        away_pro_team_id: away,
      });
    }
  }
  return { season, teams, games };
}

/** A pacer whose clock never moves (one batch, never a deadline) — deterministic. */
export const instantPacer: Pacer = Object.freeze({
  nowMs: () => 0,
  yieldToLoop: () => Promise.resolve(),
});

/** A pacer whose clock advances `stepMs` per read (drives batches and deadlines deterministically). */
export function steppingPacer(stepMs: number): Pacer & { yields: number } {
  let t = 0;
  const p = {
    yields: 0,
    nowMs: () => (t += stepMs),
    yieldToLoop: () => {
      p.yields += 1;
      return Promise.resolve();
    },
  };
  return p;
}

/** A standard test clock and rng. */
export function clockAndRng(
  iso = "2026-10-06T12:00:00.000Z",
  seed = 7,
): { clock: FixedClock; rng: Rng } {
  return { clock: fixedClock(iso), rng: seededRng(seed) };
}
