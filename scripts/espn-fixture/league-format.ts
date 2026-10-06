// league-format.ts — the format summary recorded per fixture in fixtures/espn/manifest.json: team
// count, PPR value, pass-TD value, FAAB or rolling waivers, slot structure. Paths from research 03
// §B.1; slot ids from §B.2; stat ids 53 (each reception) and 4 (passing TD) from §B.2.
import { isObject, type Json } from "./canonical.js";

/** Lineup slot ids → names (research 03 §B.2; four community maps agree). */
export const SLOT_NAMES: Readonly<Record<string, string>> = {
  "0": "QB",
  "1": "TQB",
  "2": "RB",
  "3": "RB/WR",
  "4": "WR",
  "5": "WR/TE",
  "6": "TE",
  "7": "OP",
  "8": "DT",
  "9": "DE",
  "10": "LB",
  "11": "DL",
  "12": "CB",
  "13": "S",
  "14": "DB",
  "15": "DP",
  "16": "D/ST",
  "17": "K",
  "18": "P",
  "19": "HC",
  "20": "BE",
  "21": "IR",
  "22": "(unnamed)",
  "23": "FLEX",
  "24": "ER",
  "25": "Rookie",
};

export interface LeagueFormat {
  teams: number;
  scoring_type: string | null;
  reception_points: number;
  ppr: "standard" | "half" | "full" | "custom";
  pass_td_points: number | null;
  waivers: "faab" | "rolling";
  acquisition_type: string | null;
  faab_budget: number | null;
  flex_slots: number;
  /** Slot name → count for every slot with a non-zero count (starters, bench, IR). */
  lineup_slots: Record<string, number>;
  playoff_teams: number | null;
  playoff_seeding_rule: string | null;
  regular_season_matchups: number | null;
}

const num = (v: Json | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: Json | undefined): string | null =>
  typeof v === "string" && /^[A-Z0-9_]{1,64}$/.test(v) ? v : null;

/** The scoring item `points` for `statId` (no position override), or null when the league has none. */
function itemPoints(items: Json | undefined, statId: number): number | null {
  if (!Array.isArray(items)) return null;
  for (const it of items) if (isObject(it) && it.statId === statId) return num(it.points);
  return null;
}

/** Summarises an mSettings body; throws when the body has no `settings` (not an mSettings response). */
export function leagueFormat(body: Json): LeagueFormat {
  if (!isObject(body) || !isObject(body.settings))
    throw new Error("not an mSettings body: no settings");
  const s = body.settings;
  const scoring = isObject(s.scoringSettings) ? s.scoringSettings : {};
  const acq = isObject(s.acquisitionSettings) ? s.acquisitionSettings : {};
  const roster = isObject(s.rosterSettings) ? s.rosterSettings : {};
  const sched = isObject(s.scheduleSettings) ? s.scheduleSettings : {};
  const size = num(s.size);
  if (size === null) throw new Error("mSettings body has no settings.size");
  const rec = itemPoints(scoring.scoringItems, 53) ?? 0;
  const slots: Record<string, number> = {};
  const counts = isObject(roster.lineupSlotCounts) ? roster.lineupSlotCounts : {};
  for (const id of Object.keys(counts).sort((a, b) => Number(a) - Number(b))) {
    const n = num(counts[id]);
    if (n !== null && n > 0) slots[SLOT_NAMES[id] ?? `slot ${id}`] = n;
  }
  const faab = acq.isUsingAcquisitionBudget === true;
  return {
    teams: size,
    scoring_type: str(scoring.scoringType),
    reception_points: rec,
    ppr: rec === 0 ? "standard" : rec === 0.5 ? "half" : rec === 1 ? "full" : "custom",
    pass_td_points: itemPoints(scoring.scoringItems, 4),
    waivers: faab ? "faab" : "rolling",
    acquisition_type: str(acq.acquisitionType),
    faab_budget: faab ? num(acq.acquisitionBudget) : null,
    flex_slots: num(counts["23"]) ?? 0,
    lineup_slots: slots,
    playoff_teams: num(sched.playoffTeamCount),
    playoff_seeding_rule: str(sched.playoffSeedingRule),
    regular_season_matchups: num(sched.matchupPeriodCount),
  };
}

/** The matchup period whose weeks include scoring period `week` (research 03 §A.4). */
export function matchupPeriodOf(body: Json, week: number): number | null {
  if (!isObject(body) || !isObject(body.settings)) return null;
  const sched = body.settings.scheduleSettings;
  if (!isObject(sched) || !isObject(sched.matchupPeriods)) return null;
  for (const [mp, weeks] of Object.entries(sched.matchupPeriods))
    if (Array.isArray(weeks) && weeks.includes(week) && /^\d+$/.test(mp)) return Number(mp);
  return null;
}
