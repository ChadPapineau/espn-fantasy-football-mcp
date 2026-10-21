// roster-audit-deadline-tool.test.ts — Stage C round 2, finding roster-audit-deadline-by-week,
// through the tool (plan 07 E9 "after the trade deadline"; research 03 §B.4: ESPN rolls the scoring
// period to the new week by Tuesday). fx-10h's deadline is the reference format's, Wednesday
// 2026-12-02T17:00Z; week 13 kicks off on Thursday, so tradeDeadlineWeeks puts the first week after
// it at 13. E9 decided its phase by that week number: from Tuesday's roll-over to Wednesday noon
// ET, trades still open, it answered `late`, dropped the consolidation trade ideas and called
// stashes "past the trade deadline … drop for a streamer", while espn_analyze_trade
// (tradeDeadlineStatus, the instant) said the deadline was ahead. The engine judges the instant
// when the caller passes it (tests/domain/analytics/roster-audit.test.ts); this holds the tool to
// pass it: E9 is late exactly when tradeDeadlineStatus says the league's own deadline has passed.
// fx-10h in fixture mode, the clock and the scoring period set per instant (rosters past the
// recording are week 5's). No network, no cookie.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tradeDeadlineStatus } from "../../src/domain/league/rules.js";
import type { League, Stamped } from "../../src/providers/platform.js";
import { faulty } from "./helpers/faults.js";
import { ESPN_FIXTURES, call, connect, makeWorld } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
/** fx-10h's own deadline (mSettings tradeSettings.deadlineDate), the reference format's. */
const DEADLINE = "2026-12-02T17:00:00.000Z";

interface RosterData {
  readonly phase: string;
  readonly consolidation_candidates: readonly unknown[];
  readonly stash_values: readonly { readonly playoff_horizon_note?: string | null }[];
}

/** [label, clock, the scoring period ESPN reports then, past the deadline]. */
const INSTANTS = [
  ["Monday 30 Nov 22:00 ET, week 12", "2026-12-01T03:00:00.000Z", 12, false],
  ["Tuesday 1 Dec 22:00 ET, week 13 already (15 h before)", "2026-12-02T03:00:00.000Z", 13, false],
  ["Wednesday 2 Dec 11:00 ET, an hour before", "2026-12-02T16:00:00.000Z", 13, false],
  ["Wednesday 2 Dec 12:00 ET, the instant itself", "2026-12-02T17:00:00.000Z", 13, true],
  ["Wednesday 2 Dec 13:00 ET, an hour after", "2026-12-02T18:00:00.000Z", 13, true],
] as const;

describe("E9 after the trade deadline: the league's instant, not the week (fx-10h)", () => {
  for (const [label, clock, week, past] of INSTANTS)
    it(`${label}: ${past ? "late" : "trades still open"}, as espn_analyze_trade's rule says`, async () => {
      const world = await makeWorld({
        env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: "full" },
        teamId: 2,
        clock,
      });
      try {
        const s = faulty(world.services, {
          getLeague: async (real, ...args) => {
            const got = (await real(...args)) as Stamped<League>;
            return {
              ...got,
              value: {
                ...got.value,
                clock: {
                  ...got.value.clock,
                  current_matchup_period: week,
                  current_scoring_period: week,
                  latest_scoring_period: week,
                },
              },
            };
          },
          // fx-10h records rosters through week 5: week 12's and 13's are week 5's
          getRosters: (real, ref, w, opts) => real(ref, Math.min(Number(w), 5), opts),
        });
        const c = await connect(world, { options: { toolset: "full" }, services: s });
        try {
          const lg = await call(c.client, "espn_get_league", {});
          expect(lg.isError, JSON.stringify(lg.body).slice(0, 300)).toBe(false);
          const deadline = (lg.body.data as { rules: { trade: { deadline: string | null } } }).rules
            .trade.deadline;
          expect(deadline).toBe(DEADLINE);
          // E6's rule at this instant (the precondition of the case's label)
          expect(tradeDeadlineStatus({ deadline }, Date.parse(clock)).passed).toBe(past);

          const r = await call(c.client, "espn_analyze_roster", {});
          expect(r.isError, JSON.stringify(r.body).slice(0, 400)).toBe(false);
          const d = r.body.data as RosterData;
          const pastNotes = d.stash_values.filter((x) =>
            (x.playoff_horizon_note ?? "").includes("past the trade deadline"),
          );
          if (past) {
            expect(d.phase).toBe("late");
            expect(d.consolidation_candidates).toEqual([]);
          } else {
            expect(d.phase).not.toBe("late");
            // the season's last trade window: the 2-for-1 idea and the stashes' trade value stay
            expect(d.consolidation_candidates.length).toBeGreaterThan(0);
            expect(pastNotes).toEqual([]);
          }
        } finally {
          await c.close();
        }
      } finally {
        world.cleanup();
      }
    }, 240_000);
});
