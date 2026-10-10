// negatives-data.ts — the committed history the C10 re-check reads (plan 10 §3.3 C10; research 05
// §8.3): the nflverse 2024 and 2025 player-weeks of tests/backtest/data/stats_player_week (re-hashed
// on every read by loadBacktestSeason), each scored through the shipped translator and engine under
// the reference league's settings (fx-10h) and two variants (5 → 4 pt pass TD, −2 → −1 INT); the
// 2025 pro schedule (fixtures/nflverse/schedules); the reference league's allocation plan; and the
// nine finished probe-league seasons (fixtures/espn/recorded/history — placeholders only). Nothing
// is fetched. Also the docs/evals/phase3-negatives.md generated-section reader/writer.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  allocationPlanOf,
  type AllocationPlan,
} from "../../../src/domain/analytics/replacement.js";
import { buildRosterSlots } from "../../../src/domain/league/slots.js";
import type {
  NegGameSide,
  NegLeagueSeason,
  NegPlayerWeek,
  NegPosition,
  NegativesInput,
} from "../../../src/domain/reclog/negatives.js";
import type { ScoringSettings } from "../../../src/domain/scoring/index.js";
import { MIN_GAMES, REPLACEMENT_DATA_DIR } from "../../backtest/helpers/replacement-data.js";
import { ROOT, loadBacktestSeason } from "../../backtest/helpers/waiver-excerpt.js";
import { referenceSettings, rowPoints } from "../../backtest/helpers/waivers.js";
import {
  historyBody,
  historyManifest,
  servedSeasons,
} from "../../fixtures/helpers/history-fixtures.js";
import { FX, fixtureRows } from "../../sources/nflverse/helpers/fixtures.js";

/** The seasons committed in full (QB/RB/WR/TE, weeks 1–17). */
export const NEG_SEASONS = Object.freeze([2024, 2025] as const);

/** The league's settings with one rule's points replaced (a scoring variant). */
export function withRulePoints(
  s: ScoringSettings,
  canonical: string,
  points: number,
): ScoringSettings {
  return {
    ...s,
    rules: s.rules.map((r) => (r.canonical === canonical ? { ...r, points, overrides: {} } : r)),
  };
}

/** fx-10h's own roster settings → the allocation plan (research 05 §0's format). */
export function referencePlan(): AllocationPlan {
  const body = JSON.parse(
    readFileSync(path.join(ROOT, "fixtures/espn/fx-10h/league/mSettings.json"), "utf8"),
  ) as { settings: { rosterSettings: { lineupSlotCounts: Record<string, number> } } };
  return allocationPlanOf(
    buildRosterSlots({
      slot_counts: body.settings.rosterSettings.lineupSlotCounts,
      position_limits: {},
      lineup_lock_type: "INDIVIDUAL_GAME",
      undroppable_list: false,
      move_limit: null,
    }).roster,
  );
}

/** Every committed player-week under the three variants. */
export function negRows(): NegPlayerWeek[] {
  const ref = referenceSettings();
  const td4 = withRulePoints(ref, "pass_td", 4);
  const int1 = withRulePoints(ref, "pass_int", -1);
  const out: NegPlayerWeek[] = [];
  for (const season of NEG_SEASONS) {
    const rows = loadBacktestSeason(season, REPLACEMENT_DATA_DIR);
    if (rows === null) throw new Error(`the ${String(season)} excerpt is not committed`);
    for (const r of rows)
      out.push({
        player_id: String(r.player_id),
        position: r.position_group as NegPosition,
        team: String(r.team),
        season,
        week: Number(r.week),
        points: {
          reference: rowPoints(r, ref),
          pass_td_4: rowPoints(r, td4),
          int_minus_1: rowPoints(r, int1),
        },
      });
  }
  return out;
}

/** Both sides of every regular-season game of the committed schedule seasons. */
export function negSchedule(): NegGameSide[] {
  const out: NegGameSide[] = [];
  for (const g of fixtureRows(FX.games)) {
    if (g.game_type !== "REG") continue;
    const season = Number(g.season);
    const week = Number(g.week);
    const home = String(g.home_team);
    const away = String(g.away_team);
    out.push({ season, week, team: home, opponent: away });
    out.push({ season, week, team: away, opponent: home });
  }
  return out;
}

/** The finished probe-league seasons (records, seeds, playoff size, waiver mode). */
export function negLeagueSeasons(): NegLeagueSeason[] {
  const out: NegLeagueSeason[] = [];
  for (const slot of Object.keys(historyManifest().leagues).sort()) {
    for (const [season] of servedSeasons(slot)) {
      const settings = historyBody(season, slot, "mSettings") as {
        settings: {
          scheduleSettings: { playoffTeamCount: number };
          acquisitionSettings: { waiverOrderReset: boolean; isUsingAcquisitionBudget: boolean };
        };
      };
      const team = historyBody(season, slot, "mTeam") as {
        teams: {
          playoffSeed: number;
          record: {
            overall: { wins: number; losses: number; ties: number; pointsFor: number };
          };
        }[];
      };
      out.push({
        playoff_team_count: settings.settings.scheduleSettings.playoffTeamCount,
        waiver_order_reset: settings.settings.acquisitionSettings.waiverOrderReset,
        uses_faab: settings.settings.acquisitionSettings.isUsingAcquisitionBudget,
        teams: team.teams.map((t) => ({
          wins: t.record.overall.wins,
          losses: t.record.overall.losses,
          ties: t.record.overall.ties,
          points_for: t.record.overall.pointsFor,
          playoff_seed: t.playoffSeed,
        })),
      });
    }
  }
  return out;
}

/** The report's input over the committed history. */
export function negativesInput(): NegativesInput {
  return {
    rows: negRows(),
    seasons: [...NEG_SEASONS],
    plan: referencePlan(),
    league_size: 10,
    min_games: MIN_GAMES,
    schedule: negSchedule(),
    league_seasons: negLeagueSeasons(),
  };
}

// --- docs/evals/phase3-negatives.md generated sections ------------------------------------------------

/** The eval document. */
export const NEG_DOC = path.join(ROOT, "docs/evals/phase3-negatives.md");
const marker = (name: string, edge: "start" | "end"): string => `<!-- ${name}:${edge} -->`;

/** The committed text of a generated section. */
export function negDocSection(name: string): string {
  const text = readFileSync(NEG_DOC, "utf8");
  const a = text.indexOf(marker(name, "start"));
  const b = text.indexOf(marker(name, "end"));
  if (a < 0 || b < 0) throw new Error(`docs/evals/phase3-negatives.md has no ${name} section`);
  return text.slice(a + marker(name, "start").length, b).trim();
}

/** Rewrites a generated section (UPDATE_EVALS=1 only). */
export function writeNegDocSection(name: string, body: string): void {
  const text = readFileSync(NEG_DOC, "utf8");
  const a = text.indexOf(marker(name, "start"));
  const b = text.indexOf(marker(name, "end"));
  if (a < 0 || b < 0) throw new Error(`docs/evals/phase3-negatives.md has no ${name} section`);
  writeFileSync(
    NEG_DOC,
    `${text.slice(0, a + marker(name, "start").length)}\n${body}\n${text.slice(b)}`,
  );
}
