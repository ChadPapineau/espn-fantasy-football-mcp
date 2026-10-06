// helpers.ts — builders for the scoring unit tests (plan 08 §8: hand-built engine inputs, never
// golden evidence). The reference-format mSettings is HAND-WRITTEN from plan 08 §6's reference `S`
// and research 05 §0 (half-PPR, 5-pt pass TD, INT −2, fumble lost −2, ESPN-default yardage, K
// distance items, D/ST tiers) — the reference-format golden itself waits for the live league (1b).
import {
  asPositionId,
  type EspnScoringItem,
  normalizeSettings,
  positionClassOf,
  type ScoringSettings,
  type StatLine,
  statLineFromEspn,
} from "../../../src/domain/scoring/index.js";

/** One ESPN scoring item. */
export function item(
  statId: number,
  points: number,
  pointsOverrides?: Record<string, number>,
): EspnScoringItem {
  return pointsOverrides === undefined ? { statId, points } : { statId, points, pointsOverrides };
}

/** Normalised settings from a list of items. */
export function settingsOf(
  items: readonly EspnScoringItem[],
  extra: Record<string, unknown> = {},
): ScoringSettings {
  return normalizeSettings({ scoringItems: items, ...extra });
}

/** An ESPN line from `stats{statId: raw}` (numeric keys as numbers for brevity). */
export function espnLine(
  raw: Record<number, number>,
  position: number,
  provisional = false,
): StatLine {
  const stats: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) stats[k] = v;
  return statLineFromEspn({ raw: stats, provisional }, position).line;
}

/** A hand-built canonical line (any source; class from the ESPN position table). */
export function line(
  values: Record<string, number>,
  position: number,
  source = "nflverse",
  provisional = false,
): StatLine {
  return Object.freeze({
    values: Object.freeze({ ...values }),
    present: Object.freeze(Object.keys(values).sort()),
    position: asPositionId(position),
    position_class: positionClassOf(position),
    provisional,
    source,
  });
}

/** The reference league's `scoringSettings`, hand-written (plan 08 §6 table; research 05 §0). */
export const REFERENCE_SCORING_SETTINGS = Object.freeze({
  scoringType: "H2H_POINTS",
  matchupTieRule: "NONE",
  playoffMatchupTieRule: "NONE",
  homeTeamBonus: 0,
  playoffHomeTeamBonus: 0,
  scoringItems: [
    // passing: ESPN-default yardage 0.04/yd, 5-pt TD, INT −2, 2-pt 2
    item(3, 0.04),
    item(4, 5),
    item(20, -2),
    item(19, 2),
    // rushing / receiving: 0.1/yd, 6-pt TDs, 2-pt 2, half-PPR item 53
    item(24, 0.1),
    item(25, 6),
    item(26, 2),
    item(42, 0.1),
    item(43, 6),
    item(44, 2),
    item(53, 0.5),
    // turnovers and returns
    item(72, -2),
    item(63, 6),
    item(101, 6, { "16": 6 }),
    item(102, 6, { "16": 6 }),
    // kicker: distance items made 0–39 / 40–49 / 50–59 / 60+, missed 40–49, PATs
    item(80, 3),
    item(77, 4),
    item(198, 5),
    item(201, 5),
    item(79, -1),
    item(86, 1),
    item(88, -1),
    // D/ST (override "16" only): PA tiers, YA tiers, counting stats, return TDs
    item(89, 0, { "16": 5 }),
    item(90, 0, { "16": 4 }),
    item(91, 0, { "16": 3 }),
    item(92, 0, { "16": 1 }),
    item(121, 0, { "16": 0 }),
    item(122, 0, { "16": -1 }),
    item(123, 0, { "16": -3 }),
    item(124, 0, { "16": -5 }),
    item(125, 0, { "16": -7 }),
    item(131, 0, { "16": 0 }),
    item(99, 0, { "16": 1 }),
    item(95, 0, { "16": 2 }),
    item(96, 0, { "16": 2 }),
    item(97, 0, { "16": 2 }),
    item(98, 0, { "16": 2 }),
    item(94, 0, { "16": 6 }),
    item(93, 6, { "16": 6 }),
  ],
});

export const reference = (): ScoringSettings => normalizeSettings(REFERENCE_SCORING_SETTINGS);
