// mutation.test.ts — plan 08 §6 step 4 (research 05 §7 step 2) on the RECORDED weeks: perturb one
// item's points by δ → every total moves by exactly δ × stat; remove a tier row → only games in that
// tier change; swap the 103/104 items → the golden fails exactly on the D/ST return-TD weeks; set
// overrides["16"] to 0 on a tier → only D/ST lines change. Reads only fixtures/espn/recorded.
import { describe, expect, it } from "vitest";
import {
  normalizeSettings,
  score,
  type ScoringSettings,
  type StatLine,
  statLineFromEspn,
  verify,
} from "../../src/domain/scoring/index.js";
import {
  finalWeeks,
  type LeagueSlot,
  type PlayerWeek,
  recordedScoringSettings,
  recordedTeamWeeks,
} from "./recorded.js";

interface Item {
  statId: number;
  points: number;
  pointsOverrides?: Record<string, number>;
}
const itemsOf = (league: LeagueSlot): Item[] =>
  structuredClone((recordedScoringSettings(league) as { scoringItems: Item[] }).scoringItems);
const settingsFrom = (items: Item[]): ScoringSettings => normalizeSettings({ scoringItems: items });

const players = (league: LeagueSlot): PlayerWeek[] =>
  finalWeeks(league).flatMap((w) => recordedTeamWeeks(league, w).flatMap((t) => t.players));
const lineOf = (p: PlayerWeek): StatLine =>
  statLineFromEspn({ raw: p.actual!.stats }, p.position).line;
const pts = (p: PlayerWeek, s: ScoringSettings): number => score(lineOf(p), s).points;

describe("perturb one item by δ → every recorded total moves by exactly δ × stat", () => {
  it("league-b's half-PPR item 53: 0.5 → 0.6 moves each line by 0.1 × receptions", () => {
    const items = itemsOf("league-b");
    const base = settingsFrom(items);
    const moved = settingsFrom(items.map((i) => (i.statId === 53 ? { ...i, points: 0.6 } : i)));
    let movedLines = 0;
    for (const p of players("league-b")) {
      const rec = p.actual!.stats["53"] ?? 0;
      expect(pts(p, moved) - pts(p, base)).toBeCloseTo(0.1 * rec, 9);
      if (rec > 0) movedLines += 1;
    }
    expect(movedLines).toBeGreaterThan(100);
  });
  it("an override shields its position: league-a's item 24 base (0) moves nobody with an override", () => {
    const items = itemsOf("league-a");
    const base = settingsFrom(items);
    const moved = settingsFrom(items.map((i) => (i.statId === 24 ? { ...i, points: 1 } : i)));
    for (const p of players("league-a")) {
      const overridden = [1, 2, 3, 4, 15].includes(p.position);
      const ry = p.actual!.stats["24"] ?? 0;
      expect(pts(p, moved) - pts(p, base)).toBeCloseTo(overridden ? 0 : ry, 9);
    }
  });
});

describe("remove a tier row → only games in that tier change", () => {
  it("league-a without PA tier 91 (7–13): exactly the D/ST weeks in that tier lose its points", () => {
    const items = itemsOf("league-a");
    const base = settingsFrom(items);
    const fewer = settingsFrom(items.filter((i) => i.statId !== 91));
    let inTier = 0;
    for (const p of players("league-a")) {
      const hit = (p.actual!.stats["91"] ?? 0) === 1;
      if (hit) inTier += 1;
      expect(pts(p, fewer) - pts(p, base)).toBeCloseTo(hit ? -3 : 0, 9);
    }
    expect(inTier).toBeGreaterThan(0);
  });
});

describe("swap the 103/104 items → the golden fails exactly on the D/ST return-TD weeks (E9)", () => {
  it("league-c (103 → 0, 104 → 3 for D/ST): swapping the items breaks only weeks with a return TD", () => {
    const items = itemsOf("league-c");
    const swapped = settingsFrom(
      items.map((i) =>
        i.statId === 103 ? { ...i, statId: 104 } : i.statId === 104 ? { ...i, statId: 103 } : i,
      ),
    );
    const base = settingsFrom(items);
    let broken = 0;
    for (const p of players("league-c")) {
      const e = p.actual!;
      const applied = { total: e.appliedTotal, by_stat: e.appliedStats };
      const hasReturnTd = (e.stats["103"] ?? 0) + (e.stats["104"] ?? 0) > 0;
      expect(verify(lineOf(p), base, applied).match).toBe(true);
      const v = verify(lineOf(p), swapped, applied);
      expect(v.match, `${String(p.player_id)} w${String(p.week)}`).toBe(!hasReturnTd);
      if (!v.match) {
        broken += 1;
        expect(v.mismatch_stat_ids.every((id) => id === "103" || id === "104")).toBe(true);
      }
    }
    expect(broken).toBeGreaterThan(0);
  });
});

describe('overrides["16"] → 0 on a tier → only D/ST lines change', () => {
  it.each([
    ["league-a", 89],
    ["league-a", 92],
    ["league-b", 91],
  ] as const)("%s item %s", (league, statId) => {
    const items = itemsOf(league);
    const base = settingsFrom(items);
    const zeroed = settingsFrom(
      items.map((i) =>
        i.statId === statId ? { ...i, pointsOverrides: { ...i.pointsOverrides, "16": 0 } } : i,
      ),
    );
    for (const p of players(league)) {
      const d = pts(p, zeroed) - pts(p, base);
      if (p.position !== 16) expect(d).toBe(0);
      else if ((p.actual!.stats[String(statId)] ?? 0) === 0) expect(d).toBe(0);
      else expect(d).not.toBe(0);
    }
  });
});
