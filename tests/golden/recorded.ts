// recorded.ts — the golden's only door to fixtures (plan 08 §6 step 1; plan 05 §3 fixture law line 3;
// ADV OBJ-01/OBJ-21): a path guard keeps every read inside fixtures/espn/recorded/, refuses a file
// the manifest does not list as `derived: false`, and re-hashes the body and its scoring fields
// against the manifest — so the golden can never compare the engine with itself.
import { readFileSync } from "node:fs";
import path from "node:path";
import { contentSha256, parseJsonStrict, type Json } from "../../scripts/espn-fixture/canonical.js";
import { scoringProjection } from "../../scripts/espn-fixture/scrub.js";

export const ROOT = path.resolve(import.meta.dirname, "../..");
export const RECORDED = path.join(ROOT, "fixtures/espn/recorded");
const MANIFEST_PATH = path.join(ROOT, "fixtures/espn/manifest.json");

interface ManifestFile {
  readonly path: string;
  readonly derived: boolean;
  readonly sha256: string;
  readonly scoring: { readonly entries: number; readonly sha256: string };
}
interface Manifest {
  readonly season: number;
  readonly files: readonly ManifestFile[];
  readonly leagues: Readonly<Record<string, { readonly final_boxscore_weeks: readonly number[] }>>;
}

export const MANIFEST = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;

/** Thrown when a golden read would leave the recorded class or fail its provenance. */
export class GoldenPathError extends Error {
  override readonly name = "GoldenPathError";
}

/**
 * Reads one recorded fixture by its path under fixtures/espn/recorded/ — the ONLY way the golden,
 * verify's tests and the translator cross-check read ESPN data. Refuses: a path resolving outside
 * recorded/ (`..`, absolute, symlink-style tricks by resolution), a file absent from the manifest or
 * marked derived, and a body or scoring projection whose sha256 differs from the manifest.
 */
export function readRecorded(rel: string): Json {
  const abs = path.resolve(RECORDED, rel);
  if (!abs.startsWith(RECORDED + path.sep)) {
    throw new GoldenPathError(`golden path guard: ${rel} is outside fixtures/espn/recorded`);
  }
  const key = `recorded/${path.relative(RECORDED, abs).split(path.sep).join("/")}`;
  const entry = MANIFEST.files.find((f) => f.path === key);
  if (entry === undefined)
    throw new GoldenPathError(`golden path guard: ${key} is not in the manifest`);
  if (entry.derived) throw new GoldenPathError(`golden path guard: ${key} is derived`);
  const body = parseJsonStrict(readFileSync(abs, "utf8"));
  if (contentSha256(body) !== entry.sha256) {
    throw new GoldenPathError(`golden path guard: ${key} does not hash to its recording`);
  }
  if (scoringProjection(body).sha256 !== entry.scoring.sha256) {
    throw new GoldenPathError(`golden path guard: ${key} scoring fields differ from the recording`);
  }
  return body;
}

export const LEAGUES = ["league-a", "league-b", "league-c"] as const;
export type LeagueSlot = (typeof LEAGUES)[number];

/** The recorded ESPN `scoringSettings` of a league slot. */
export function recordedScoringSettings(league: LeagueSlot): unknown {
  const body = readRecorded(`${league}/mSettings.json`) as {
    settings: { scoringSettings: unknown };
  };
  return body.settings.scoringSettings;
}

/** One ESPN `stats[]` entry (the fields the golden reads). */
export interface StatEntry {
  readonly statSourceId: number;
  readonly statSplitTypeId: number;
  readonly seasonId: number;
  readonly scoringPeriodId: number;
  readonly stats: Readonly<Record<string, number>>;
  readonly appliedStats: Readonly<Record<string, number>>;
  readonly appliedTotal: number;
}

/** One rostered player-week of a recorded box score. */
export interface PlayerWeek {
  readonly league: LeagueSlot;
  readonly week: number;
  readonly matchup_id: number;
  readonly side: "home" | "away";
  readonly team_id: number;
  readonly slot_id: number;
  readonly player_id: number;
  readonly position: number;
  readonly actual: StatEntry | undefined;
  readonly projected: StatEntry | undefined;
}

/** One team side of a recorded box score. */
export interface TeamWeek {
  readonly league: LeagueSlot;
  readonly week: number;
  readonly team_id: number;
  readonly total_points: number;
  readonly points_by_period: number | undefined;
  readonly players: readonly PlayerWeek[];
}

interface RawSide {
  teamId: number;
  totalPoints: number;
  pointsByScoringPeriod?: Record<string, number>;
  rosterForCurrentScoringPeriod: {
    entries: {
      lineupSlotId: number;
      playerId: number;
      playerPoolEntry: { player: { id: number; defaultPositionId: number; stats: StatEntry[] } };
    }[];
  };
}

/** Every team side of one league's recorded final box score for `week`. */
export function recordedTeamWeeks(league: LeagueSlot, week: number): TeamWeek[] {
  const body = readRecorded(`${league}/mBoxscore.sp${String(week)}.json`) as unknown as {
    seasonId: number;
    schedule: { id: number; home: RawSide; away?: RawSide }[];
  };
  const out: TeamWeek[] = [];
  for (const m of body.schedule) {
    for (const side of ["home", "away"] as const) {
      const s = m[side];
      if (s === undefined) continue;
      const pick = (stats: StatEntry[], source: number) =>
        stats.find(
          (e) =>
            e.statSourceId === source &&
            e.statSplitTypeId === 1 &&
            e.seasonId === body.seasonId &&
            e.scoringPeriodId === week,
        );
      out.push({
        league,
        week,
        team_id: s.teamId,
        total_points: s.totalPoints,
        points_by_period: s.pointsByScoringPeriod?.[String(week)],
        players: s.rosterForCurrentScoringPeriod.entries.map((e) => ({
          league,
          week,
          matchup_id: m.id,
          side,
          team_id: s.teamId,
          slot_id: e.lineupSlotId,
          player_id: e.playerPoolEntry.player.id,
          position: e.playerPoolEntry.player.defaultPositionId,
          actual: pick(e.playerPoolEntry.player.stats, 0),
          projected: pick(e.playerPoolEntry.player.stats, 1),
        })),
      });
    }
  }
  return out;
}

/** The final box-score weeks of a league, from the manifest (≥ 3 per league — plan 10 A1a). */
export function finalWeeks(league: LeagueSlot): readonly number[] {
  const l = MANIFEST.leagues[league];
  if (l === undefined) throw new GoldenPathError(`no league ${league} in the manifest`);
  return l.final_boxscore_weeks;
}

/** ESPN's bench and IR slot ids (research 03 §B.2): not starters. */
export const NON_STARTER_SLOTS: ReadonlySet<number> = new Set([20, 21]);
