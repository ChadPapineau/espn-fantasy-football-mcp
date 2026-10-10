// history.test.ts — the held-out replay's data door (helpers/history.ts) holds its rules: the
// held-out seasons are the ones whose box scores the manifest lists; a box score lists a player's
// NFL team at RECORDING time, so each week's team is the team of that week's game (else the nearest
// earlier, then later, game that season) and differs from the listed team for some player-weeks;
// a withheld entry marks its team-week incomplete (from the manifest), and a side's starters sum to
// its total except on those team-weeks and a two-week final.
import { describe, expect, it } from "vitest";
import { heldOutSeasons, historySeason, historyWeek } from "./helpers/history.js";
import { historyEntries } from "../../../fixtures/helpers/history-fixtures.js";

describe("the held-out history (league-b)", () => {
  it("holds two seasons of 17 box-score weeks, ten teams each", () => {
    expect(heldOutSeasons()).toEqual([2024, 2025]);
    for (const season of heldOutSeasons()) {
      const s = historySeason(season);
      expect(s.final_week).toBe(17);
      expect(s.weeks).toHaveLength(17);
      for (const w of s.weeks) expect(w.teams).toHaveLength(10);
      expect(s.roster.slots.length).toBeGreaterThan(0);
      expect(s.schedule.games.length).toBeGreaterThan(250);
    }
  });

  it("reads each week's NFL team from that week's game, not from the recording-time listing", () => {
    let differs = 0;
    for (const season of heldOutSeasons()) {
      const s = historySeason(season);
      for (const w of s.weeks) {
        const listed = new Map(
          historyWeek(season, w.week).teams.flatMap((t) =>
            t.entries.map((e) => [e.player_id, e.pro_team_id] as const),
          ),
        );
        for (const t of w.teams)
          for (const e of t.entries) {
            if (e.game_pro_team_id !== null) expect(e.pro_team_id).toBe(e.game_pro_team_id);
            if (listed.get(e.player_id) !== e.pro_team_id) differs += 1;
          }
      }
    }
    // players who changed teams (or left the league) since those seasons
    expect(differs).toBeGreaterThan(0);
  });

  it("marks a team-week with a withheld entry incomplete, as the manifest says", () => {
    for (const season of heldOutSeasons())
      for (let week = 1; week <= 17; week++) {
        const flagged = new Set(
          historyEntries(season, "league-b", `mBoxscore.sp${String(week)}`).flatMap(
            (f) => (f as { incomplete?: { team_ids?: number[] } }).incomplete?.team_ids ?? [],
          ),
        );
        for (const t of historyWeek(season, week).teams) {
          expect(t.complete).toBe(!flagged.has(t.team_id));
          // a complete single-week side sums to its total; the exceptions are withheld entries
          // and a matchup spanning two scoring periods (the 2025 final)
          if (t.complete && !t.starters_sum_total) {
            expect(season).toBe(2025);
            expect(week).toBeGreaterThanOrEqual(16);
          }
        }
      }
  });

  it("parses actual lines through the translator and keeps ESPN's projection beside each actual", () => {
    const w = historyWeek(2024, 5);
    const entries = w.teams.flatMap((t) => t.entries);
    expect(entries.filter((e) => e.projected !== null).length).toBeGreaterThan(
      entries.length * 0.95,
    );
    const withLine = entries.filter((e) => e.actual_line !== null);
    expect(withLine.length).toBeGreaterThan(100);
    for (const e of withLine) expect(e.actual_line?.source).toBe("espn");
  });
});
