// espn-recorded.test.ts — the recorded golden (plan 08 §6 step 1, E4, E6, E9; plan 10 A1a; plan 05
// §2 domain/scoring): every rostered player-week of league-a/b/c's recorded final weeks matches
// ESPN per stat (≤ 0.005 against appliedStats) and per total (≤ 0.01 against appliedTotal), on the
// actual AND the projected entries; the starters sum to the team total; ESPN's rounding rule is
// pinned; E9's 103/104 order is settled; the engine's output equals the frozen fixtures/golden.
// Reads ONLY fixtures/espn/recorded through the path guard in ./recorded.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contentSha256, type Json } from "../../scripts/espn-fixture/canonical.js";
import { formatJson } from "../../scripts/espn-fixture/format-json.js";
import {
  E9_EVIDENCE,
  ESPN_ROUNDING,
  espnStat,
  normalizeSettings,
  roundingCandidates,
  score,
  type ScoringSettings,
  statLineFromEspn,
  sumPoints,
  verify,
} from "../../src/domain/scoring/index.js";
import { buildGolden, GOLDEN_MANIFEST_PATH, GOLDEN_PATH, goldenManifest } from "./build.js";
import {
  finalWeeks,
  GoldenPathError,
  LEAGUES,
  type LeagueSlot,
  NON_STARTER_SLOTS,
  type PlayerWeek,
  readRecorded,
  recordedScoringSettings,
  recordedTeamWeeks,
  type StatEntry,
} from "./recorded.js";

const settingsOf = new Map<LeagueSlot, ScoringSettings>(
  LEAGUES.map((l) => [l, normalizeSettings(recordedScoringSettings(l))]),
);
const settings = (l: LeagueSlot): ScoringSettings => settingsOf.get(l)!;

const allTeams = LEAGUES.flatMap((l) => finalWeeks(l).flatMap((w) => recordedTeamWeeks(l, w)));
const allPlayers: PlayerWeek[] = allTeams.flatMap((t) => t.players);

function check(p: PlayerWeek, entry: StatEntry) {
  const { line, unregistered } = statLineFromEspn({ raw: entry.stats }, p.position);
  const s = settings(p.league);
  return {
    line,
    unregistered,
    result: score(line, s),
    verdict: verify(line, s, { total: entry.appliedTotal, by_stat: entry.appliedStats }),
  };
}

describe("the golden path guard (ADV OBJ-01/OBJ-21: the golden never reads a derived field)", () => {
  it.each([
    "../manifest.json",
    "../synthetic/errors/401-league-not-visible.json",
    "../../players/fixture-roster.json",
    "/etc/passwd",
    "league-a/../../manifest.json",
  ])("refuses %s (outside recorded/)", (rel) => {
    expect(() => readRecorded(rel)).toThrow(GoldenPathError);
  });
  it("refuses a recorded-looking path the manifest does not list", () => {
    expect(() => readRecorded("league-a/mBoxscore.sp9.json")).toThrow(/not in the manifest/);
    expect(() => readRecorded("README.md")).toThrow(/not in the manifest/);
  });
  it("reads a listed file whose body and scoring fields hash to the recording", () => {
    expect(readRecorded("league-b/mSettings.json")).toHaveProperty("settings");
  });
});

describe("recorded golden: ≥ 3 final weeks per league (plan 10 A1a)", () => {
  it.each(LEAGUES)("%s has weeks 1–3 final", (league) => {
    expect(finalWeeks(league)).toEqual([1, 2, 3]);
  });
  it("covers every rostered player-week of the three leagues", () => {
    expect(allPlayers).toHaveLength(1394);
    expect(allTeams).toHaveLength(84);
    expect(allPlayers.every((p) => p.actual !== undefined && p.projected !== undefined)).toBe(true);
  });
});

describe.each(LEAGUES)("%s: per stat ≤ 0.005 and per total ≤ 0.01 against ESPN", (league) => {
  const players = allPlayers.filter((p) => p.league === league);
  it("actual lines (statSourceId 0) match, complete, with no unmapped id carrying points", () => {
    const failures: string[] = [];
    for (const p of players) {
      const entry = p.actual!;
      const { result, verdict, unregistered } = check(p, entry);
      if (!verdict.match)
        failures.push(
          `w${String(p.week)} ${String(p.player_id)} ${verdict.mismatch_stat_ids.join(",")} Δ${String(verdict.delta_total)}`,
        );
      expect(result.complete).toBe(true);
      expect(Math.abs(verdict.delta_total)).toBeLessThanOrEqual(0.01);
      for (const id of Object.keys(entry.appliedStats)) {
        expect(unregistered, `applied id ${id} must be registered`).not.toContain(id);
        expect(espnStat(id), id).toBeDefined();
      }
    }
    expect(failures).toEqual([]);
    expect(settings(league).rules.every((r) => r.canonical !== null)).toBe(true);
  });
  it("projected lines (statSourceId 1) match: the item map on lines with many non-zero stats", () => {
    const failures: string[] = [];
    for (const p of players) {
      const { verdict } = check(p, p.projected!);
      if (!verdict.match)
        failures.push(
          `w${String(p.week)} ${String(p.player_id)} ${verdict.mismatch_stat_ids.join(",")}`,
        );
    }
    expect(failures).toEqual([]);
  });
  it("per stat, explicitly: every ESPN appliedStats value equals the engine's contribution", () => {
    let compared = 0;
    for (const p of players) {
      for (const entry of [p.actual, p.projected] as StatEntry[]) {
        const { result } = check(p, entry);
        const engine = new Map(result.contributions.map((c) => [c.platform_id, c.points]));
        for (const [id, pts] of Object.entries(entry.appliedStats)) {
          expect(
            Math.abs((engine.get(id) ?? 0) - pts),
            `${String(p.player_id)} stat ${id}`,
          ).toBeLessThanOrEqual(0.005);
          compared += 1;
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
  });
});

describe("matchup level: the starters sum to the team total (plan 08 §6 step 1, §4.5)", () => {
  it.each(
    allTeams.map((t) => [`${t.league} w${String(t.week)} team ${String(t.team_id)}`, t] as const),
  )("%s", (_label, team) => {
    const starters = team.players
      .filter((p) => !NON_STARTER_SLOTS.has(p.slot_id))
      .map((p) => (p.actual === undefined ? 0 : check(p, p.actual).result.points));
    const total = sumPoints(starters);
    expect(Math.abs(total - team.total_points)).toBeLessThanOrEqual(0.01);
    expect(team.points_by_period).toBe(team.total_points);
  });
});

describe("E4: ESPN's rounding rule, pinned by the fixture (plan 08 §4.6)", () => {
  const actuals = allPlayers.map((p) => p.actual!);
  const projected = allPlayers.map((p) => p.projected!);
  it("actual totals equal the exact sum to 1e-9 (and both 2-dp candidates, every product being ≤ 2 dp)", () => {
    for (const e of actuals) {
      const c = roundingCandidates(Object.values(e.appliedStats));
      expect(Math.abs(c.exact - e.appliedTotal)).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(c.per_stat_2dp - e.appliedTotal)).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(c.per_total_2dp - e.appliedTotal)).toBeLessThanOrEqual(1e-9);
    }
  });
  it("projected totals refute both 2-dp modes and equal the exact sum within ESPN's 8-dp storage", () => {
    let refuted2dp = 0;
    for (const e of projected) {
      const c = roundingCandidates(Object.values(e.appliedStats));
      expect(Math.abs(c.exact - e.appliedTotal)).toBeLessThanOrEqual(1e-8);
      if (
        Math.abs(c.per_total_2dp - e.appliedTotal) > 1e-9 &&
        Math.abs(c.per_stat_2dp - e.appliedTotal) > 1e-9
      )
        refuted2dp += 1;
    }
    expect(refuted2dp).toBeGreaterThan(1000);
    expect(ESPN_ROUNDING).toEqual({ mode: "exact", verified: true });
  });
  it("appliedStats is the plain double product points × raw (bit-identical, not rounded)", () => {
    let exactProducts = 0;
    for (const p of allPlayers.slice(0, 200)) {
      const entry = p.actual!;
      const s = settings(p.league);
      for (const [id, applied] of Object.entries(entry.appliedStats)) {
        const rule = s.rules.find((r) => r.platform_id === id);
        const raw = entry.stats[id];
        if (rule === undefined || raw === undefined) continue;
        const pts = rule.overrides[String(p.position)] ?? rule.points;
        // `===` (JSON carries no −0; −2 × 0 is −0)
        expect(pts * raw === applied, `stat ${id}`).toBe(true);
        exactProducts += 1;
      }
    }
    expect(exactProducts).toBeGreaterThan(500);
  });
});

describe("E9 settled: 103 = interception-return TD, 104 = fumble-return TD", () => {
  const dst = new Map<string, Readonly<Record<string, number>>>();
  for (const p of allPlayers)
    if (p.position === 16) dst.set(`${String(p.player_id)}:${String(p.week)}`, p.actual!.stats);
  const g = (s: Readonly<Record<string, number>>, id: string): number => s[id] ?? 0;
  /** A return TD needs its turnover: INT-return TDs ≤ INTs, fumble-return TDs ≤ fumble recoveries. */
  const consistent = (intTd: string, frTd: string) =>
    [...dst.values()].every((s) => g(s, intTd) <= g(s, "95") && g(s, frTd) <= g(s, "96"));
  it("the shipped orientation is consistent on every recorded D/ST week", () => {
    expect(dst.size).toBe(70);
    expect(consistent(E9_EVIDENCE.int_return_td, E9_EVIDENCE.fumble_return_td)).toBe(true);
    const decisive = [...dst.values()].filter((s) => g(s, "103") > 0 && g(s, "96") === 0);
    expect(decisive.length).toBe(E9_EVIDENCE.recorded_weeks_with_103_and_no_fumble_recovery);
    expect(espnStat("103")?.canonical).toBe("dst_int_td");
    expect(espnStat("104")?.canonical).toBe("dst_fr_td");
    expect(espnStat("103")?.disputed).toBe(false);
  });
  it("mutation: the swapped orientation (S-JS's) fails on the recorded weeks", () => {
    expect(consistent("104", "103")).toBe(false);
  });
});

describe("frozen engine outputs (plan 08 §6 step 1: fixtures/golden with a manifest hash)", () => {
  const golden = buildGolden();
  it("the engine reproduces fixtures/golden/espn-recorded.json exactly", async () => {
    const text = readFileSync(GOLDEN_PATH, "utf8");
    expect(JSON.parse(text)).toEqual(golden);
    expect(text).toBe(await formatJson(golden as unknown as Json));
  });
  it("the manifest pins the frozen file and the recorded sources it was built from", async () => {
    const text = readFileSync(GOLDEN_MANIFEST_PATH, "utf8");
    const manifest = goldenManifest(golden);
    expect(JSON.parse(text)).toEqual(manifest);
    expect(text).toBe(await formatJson(manifest));
    expect((manifest as { files: { sha256: string }[] }).files[0]?.sha256).toBe(
      contentSha256(golden as unknown as Json),
    );
  });
  it("every frozen actual equals ESPN's appliedTotal within 0.01 (the freeze never pinned a mismatch)", () => {
    for (const p of allPlayers) {
      const rows = golden.leagues[p.league].weeks[String(p.week)] ?? [];
      const row = rows.find((r) => r[0] === p.player_id);
      expect(row).toBeDefined();
      expect(Math.abs((row?.[1] ?? Number.NaN) - p.actual!.appliedTotal)).toBeLessThanOrEqual(0.01);
      expect(Math.abs((row?.[2] ?? Number.NaN) - p.projected!.appliedTotal)).toBeLessThanOrEqual(
        0.01,
      );
    }
  });
});
