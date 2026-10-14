// bye-seeds.test.ts — Stage C remediation, round 1 (finding league-bye-seeds-always-null; plan 07 A1
// `rules.playoffs.bye_seeds`, A2 `playoff_line.bye_seeds`, E8 `playoff_weeks.bye_seeds`; research
// 05 §2.3 [V-docs]: "Any BYEs replace the seed starting with the highest number"): the provider's
// normaliser — the production path — derives the seeds idle in round one from the bracket size
// (`byeSeedsOf`, the domain rule), so the owner's 6-of-10 playoff reports 2, a 4- or 8-team field 0,
// and only a field it cannot size stays null and listed unverified. Checked on every recorded league,
// on the derived 6-team fixture league through the real provider, and over every field size.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { byeSeedsOf } from "../../../src/domain/league/rules.js";
import { createDerivedLeagueFetch, derivedLeagueClock } from "../../../src/providers/espn/index.js";
import { normalizeLeagueRules, normalizeStandings } from "../../../src/providers/espn/normalize.js";
import {
  mSettingsSchema,
  mTeamSchema,
  type WireSettingsBody,
} from "../../../src/providers/espn/views/index.js";
import { fixedClock } from "../../../src/domain/clock.js";
import { FIXTURES, LEAGUES, loadFixture, makeWorld } from "./helpers.js";

const FX = path.join(FIXTURES, "fx-10h");

const settingsOf = (rel: string): WireSettingsBody => mSettingsSchema.parse(loadFixture(rel));
const withCount = (n: unknown): WireSettingsBody => {
  const s = structuredClone(settingsOf("fx-10h/league/mSettings.json")) as unknown as {
    settings: { scheduleSettings: Record<string, unknown> };
  };
  s.settings.scheduleSettings.playoffTeamCount = n;
  return s as unknown as WireSettingsBody;
};

describe("rules.playoffs.bye_seeds from the bracket size", () => {
  it("the 6-of-10 fixture league: seeds 1 and 2 idle → 2, not unverified", () => {
    const rules = normalizeLeagueRules(settingsOf("fx-10h/league/mSettings.json"));
    expect(rules.playoffs.team_count).toBe(6);
    expect(rules.playoffs.bye_seeds).toBe(2);
    expect(rules.unverified_fields).not.toContain("playoffs.bye_seeds");
    expect(rules.unverified_fields).toEqual(["waiver.type", "waiver.order_reset"]);
  });

  it("every recorded league (4, 4 and 8 teams) has no byes: 0, not null", () => {
    for (const slot of LEAGUES) {
      const rules = normalizeLeagueRules(settingsOf(`recorded/${slot}/mSettings.json`));
      expect(rules.playoffs.bye_seeds, slot).toBe(byeSeedsOf(rules.playoffs.team_count));
      expect(rules.playoffs.bye_seeds, slot).toBe(0);
      expect(rules.unverified_fields, slot).not.toContain("playoffs.bye_seeds");
    }
  });

  it("every field size 1–20: the next power of two minus the field; an unusable count stays null and unverified", () => {
    const expected: Record<number, number> = { 1: 0, 2: 0, 3: 1, 4: 0, 5: 3, 6: 2, 7: 1, 8: 0 };
    for (let n = 1; n <= 20; n++) {
      let bracket = 1;
      while (bracket < n) bracket *= 2;
      const rules = normalizeLeagueRules(withCount(n));
      expect(rules.playoffs.bye_seeds, String(n)).toBe(bracket - n);
      if (expected[n] !== undefined) expect(rules.playoffs.bye_seeds).toBe(expected[n]);
      expect(rules.unverified_fields).not.toContain("playoffs.bye_seeds");
    }
    for (const bad of [0, 21, -1, 2.5, null, "6"]) {
      const rules = normalizeLeagueRules(withCount(bad));
      expect(rules.playoffs.bye_seeds, String(bad)).toBeNull();
      expect(rules.unverified_fields).toContain("playoffs.bye_seeds");
    }
  });
});

describe("standings' playoff_line.bye_seeds", () => {
  it("the fixture league's standings report the same 2", () => {
    const team = mTeamSchema.parse(loadFixture("fx-10h/league/mTeam.json"));
    const settings = settingsOf("fx-10h/league/mSettings.json");
    const st = normalizeStandings(team, settings, null);
    expect(st.playoff_line).toMatchObject({ team_count: 6, bye_seeds: 2 });
  });
});

describe("through the real provider on the derived 6-team fixture league", () => {
  it("getLeagueRules and getStandings both carry bye_seeds 2", async () => {
    const at = derivedLeagueClock(FX);
    expect(at).not.toBeNull();
    const w = makeWorld({
      fetch: createDerivedLeagueFetch({ dir: FX }),
      clock: fixedClock(new Date(at!).toISOString()),
    });
    const rules = await w.provider.getLeagueRules(w.ref);
    expect(rules.value.playoffs).toMatchObject({ team_count: 6, bye_seeds: 2 });
    expect(rules.value.unverified_fields).not.toContain("playoffs.bye_seeds");
    const standings = await w.provider.getStandings(w.ref);
    expect(standings.value.playoff_line).toMatchObject({ team_count: 6, bye_seeds: 2 });
  });
});
