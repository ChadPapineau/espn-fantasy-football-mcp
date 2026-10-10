// history.test.ts — plan 10 C4 (hard): the simulator's tiebreak chain reproduces `playoffSeed`
// EXACTLY on every finished season recorded in fixtures/espn/recorded/history (three probe leagues ×
// 2023–2025), under reading (a). Each season is read the way the product reads a previous season:
// the real provider in fixture mode over the history manifest (`getStandings`, `getMatchups`),
// keyless, no network; the rules and the bracket-edit flag through the provider's normalisers
// (`normalizeLeagueRules`, `normalizeLeague`) over the recorded `mSettings` — the provider's
// settings read asks for mSettings + mNav together and the history recorded mSettings alone. A season that
// does not reproduce fails here with its findings printed — never tolerated silently. The
// committed write-up is docs/evals/phase3-waivers-seeding.md (kept equal to this run).
import { describe, expect, it } from "vitest";
import {
  reproduceSeason,
  reproductionInputFrom,
  summarizeReproductions,
  type SeasonReproduction,
} from "../../../../src/domain/analytics/seeding-reproduce/index.js";
import { normalizeLeague, normalizeLeagueRules } from "../../../../src/providers/espn/normalize.js";
import { mSettingsSchema } from "../../../../src/providers/espn/views/league.schema.js";
import {
  historyBody,
  historyFixtureFetch,
  servedSeasons,
} from "../../../fixtures/helpers/history-fixtures.js";
import { makeWorld, type LeagueSlot } from "../../../providers/espn/helpers.js";
import { docSectionOf, writeOrCompare } from "./doc.js";

const SLOTS: readonly LeagueSlot[] = ["league-a", "league-b", "league-c"];

/** Reads one previous season through the provider in fixture mode and reproduces it. */
async function reproduceRecorded(slot: LeagueSlot, season: number): Promise<SeasonReproduction> {
  const w = makeWorld({ fetch: historyFixtureFetch(slot) });
  const ref = { ...w.ref, season };
  const standings = await w.provider.getStandings(ref);
  const matchups = await w.provider.getMatchups(ref);
  // the provider's settings read is mSettings+mNav; the history recorded mSettings alone, so the
  // rules and the bracket-edit flag come from the provider's own normalisers over that body
  const settings = mSettingsSchema.parse(historyBody(season, slot, "mSettings"));
  const rules = { value: normalizeLeagueRules(settings) };
  const league = normalizeLeague(settings, ref, null, null, false);
  return reproduceSeason(
    reproductionInputFrom({
      season,
      standings: standings.value.teams,
      matchups: matchups.value,
      rules: rules.value,
      league,
    }),
  );
}

const results = new Map<string, SeasonReproduction>();
async function all(): Promise<Map<string, SeasonReproduction>> {
  if (results.size > 0) return results;
  for (const slot of SLOTS)
    for (const [season] of servedSeasons(slot))
      results.set(`${slot}/${String(season)}`, await reproduceRecorded(slot, season));
  return results;
}

describe("C4 — seeding reproduction on the recorded finished seasons (hard)", () => {
  it("every recorded season of every probe league reproduces exactly under reading (a)", async () => {
    const r = await all();
    expect(r.size).toBe(9);
    const failures = [...r.entries()]
      .filter(([, s]) => !s.espn_rule.exact)
      .map(([k, s]) => `${k}: ${s.note} | ${s.findings.map((f) => f.detail).join(" | ")}`);
    expect(failures).toEqual([]);
  }, 60_000);

  it("the records ESPN seeds from equal the recomputed regular season; no coin flip; two bracket edits that left the seeds alone", async () => {
    // league-b's 2023 and 2025 seasons carry isPlayoffMatchupEdited: the commissioner edited the
    // bracket, yet every playoffSeed still follows the chain — the edit did not reorder the seeds
    const edited = new Set(["league-b/2023", "league-b/2025"]);
    for (const [k, s] of await all()) {
      expect(s.records_agree, k).toBe(true);
      expect(s.espn_rule.coin_flip_decides, k).toBe(false);
      expect(
        s.findings.map((f) => f.code),
        k,
      ).toEqual(edited.has(k) ? ["playoff_edited"] : []);
      expect(s.regular_games, k).toBeGreaterThan(0);
      expect(s.espn_rule.field_exact, k).toBe(true);
      expect(s.espn_rule.consistent_up_to_coin, k).toBe(true);
    }
  });

  it("division winners seed first in the four-division league; one-division leagues rank by win % then PF", async () => {
    for (const [k, s] of await all()) {
      if (s.divisions > 1) {
        expect(s.espn_rule.chain[0], k).toBe("division_winners_first");
        expect(s.rule_by, k).toBe(-1);
      } else expect(s.espn_rule.chain[0], k).toBe("win_pct");
      expect(s.rule, k).toBe("TOTAL_POINTS_SCORED");
      // no tie needed a level below points for (floats: points-for ties do not occur)
      expect(["win_pct", "points_for", null], k).toContain(s.espn_rule.deciding_level);
    }
  });

  it("reading (b) does not reproduce these seasons (their records, not points alone, seed them)", async () => {
    for (const [k, s] of await all()) {
      expect(s.points_only.exact, k).toBe(false);
      expect(s.reproduced_by, k).toBe("espn_rule");
    }
  });

  it("C4's verdict over the nine seasons is met, and the write-up matches this run", async () => {
    const summary = summarizeReproductions([...(await all()).values()]);
    expect(summary.reproduced_espn_rule).toBe(9);
    expect(summary.neither).toEqual([]);
    expect(summary.c4_met).toBe(true);
    writeOrCompare("seeding", docSectionOf(await all()));
  });
});
