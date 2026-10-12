// engine-families.test.ts — plan 10 B13 / open decision D8 on the three recorded leagues: which
// bracket families (plan 08 §2, §4) reproduce ESPN, re-derived from fixtures/espn/recorded so the
// server-authored constants in src/domain/scoring/verification.ts cannot drift from the recordings:
// GOLDEN_COVERED_STAT_IDS (a recorded league scores the id and the golden compares ESPN's
// appliedStats for it), FAMILY_EVIDENCE (each family's derivation checked on ESPN's raw values:
// per-N floor, cumulative long-TD ids, FG bucket sums, D/ST tiers = bracketize(120/127), the
// yardage-game bonuses as exclusive tiers — plan 08 A-2, settled on every recorded weekly actual —
// and the HC tripwire), and familyVerification per recorded league. Reads ESPN data ONLY through the
// golden path guard. The member table goes to docs/evals/phase2-engine-families.md (UPDATE_EVALS=1).
import { describe, expect, it, beforeAll } from "vitest";
import {
  bracketize,
  buildFamilies,
  CANONICAL_DEFS,
  canonicalDef,
  espnIdOf,
  espnStat,
  FAMILY_EVIDENCE,
  FAMILY_KIND,
  familyVerification,
  GOLDEN_COVERED_STAT_IDS,
  normalizeSettings,
  score,
  scoresForClass,
  statLineFromEspn,
  verify,
  type ScoringRule,
  type ScoringSettings,
} from "../../src/domain/scoring/index.js";
import { evalsSection, writeEvalsSection } from "./evals-doc.js";
import {
  finalWeeks,
  GoldenPathError,
  LEAGUES,
  type LeagueSlot,
  type PlayerWeek,
  readAnyRecorded,
  recordedFiles,
  recordedScoringSettings,
  recordedTeamWeeks,
  type StatEntry,
} from "./recorded.js";
import { positionClassOf } from "../../src/domain/scoring/stat_map.js";

const settingsOf = new Map<LeagueSlot, ScoringSettings>(
  LEAGUES.map((l) => [l, normalizeSettings(recordedScoringSettings(l))]),
);
const allPlayers: PlayerWeek[] = LEAGUES.flatMap((l) =>
  finalWeeks(l).flatMap((w) => recordedTeamWeeks(l, w).flatMap((t) => t.players)),
);
/** Every recorded line: actual and projected entries of every rostered player-week. */
const lines = allPlayers.flatMap((p) =>
  [p.actual, p.projected].flatMap((e) =>
    e === undefined
      ? []
      : [
          {
            league: p.league,
            position: p.position,
            actual: e === p.actual,
            stats: e.stats,
            applied: e.appliedStats,
          },
        ],
  ),
);
const actual = lines.filter((l) => l.actual);
const g = (stats: Readonly<Record<string, number>>, id: string): number => stats[id] ?? 0;

/** Every registry family member with an ESPN id: [espn id, canonical, family, scalar, lower, upper]. */
const MEMBERS = CANONICAL_DEFS.flatMap((d) => {
  const id = espnIdOf(d.canonical);
  return d.family === null || id === undefined
    ? []
    : [{ id, canonical: d.canonical, ...d.family, cls: d.classes[0]! }];
});

/** Every recorded file of both manifests, read once through the golden path guard. */
const BODIES = new Map(recordedFiles().map((rel) => [rel, readAnyRecorded(rel)]));

/** One recorded weekly actual (statSourceId 0, statSplitTypeId 1) of one player-week. */
interface WeeklyActual {
  /** `<league>:<season>:<week>:<player id | anon#n>` — value-free, for messages only. */
  readonly key: string;
  readonly league: string | null;
  /** The player's `defaultPositionId` (from any recorded file), or null when none names it. */
  readonly position: number | null;
  readonly stats: Readonly<Record<string, number>>;
  readonly applied: Readonly<Record<string, number>> | null;
}

/**
 * Every distinct recorded weekly actual player-week of every recorded file of both manifests (box
 * scores, rosters, matchup scores, player cards, the player pages, and the previous seasons' box
 * scores), read through the golden path guard: plan 08 A-2's evidence, which the rostered final
 * weeks above do not hold (no 400-yard game). A player object carries its id and position; an
 * mMatchupScore roster entry carries neither (its line is kept unless a line with the same stats
 * was already seen for that league-season-week). Where one player-week is in several files, the
 * copy carrying ESPN's appliedStats is kept.
 */
function weeklyActuals(): WeeklyActual[] {
  interface Found {
    readonly league: string | null;
    readonly id: number | null;
    readonly e: StatEntry;
  }
  const found: Found[] = [];
  const positions = new Map<number, number>();
  const leagueOf = (rel: string): string | null => /(league-[abc])\//.exec(rel)?.[1] ?? null;
  const visit = (node: unknown, league: string | null): void => {
    if (Array.isArray(node)) {
      for (const x of node) visit(x, league);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (
      Array.isArray(o.stats) &&
      o.stats.some((e) => typeof (e as StatEntry).statSourceId === "number")
    ) {
      const id = typeof o.id === "number" ? o.id : null;
      if (id !== null && typeof o.defaultPositionId === "number")
        positions.set(id, o.defaultPositionId);
      for (const e of o.stats as StatEntry[])
        if (e.statSourceId === 0 && e.statSplitTypeId === 1) found.push({ league, id, e });
      return;
    }
    for (const v of Object.values(o)) visit(v, league);
  };
  for (const [rel, body] of BODIES) visit(body, leagueOf(rel));
  const period = (f: Found) =>
    `${f.league ?? "season"}:${String(f.e.seasonId)}:${String(f.e.scoringPeriodId)}`;
  const content = (f: Found) => `${period(f)}:${JSON.stringify(Object.entries(f.e.stats).sort())}`;
  const out = new Map<string, WeeklyActual>();
  const seenContent = new Set<string>();
  let anon = 0;
  for (const f of [...found.filter((x) => x.id !== null), ...found.filter((x) => x.id === null)]) {
    if (f.id === null && seenContent.has(content(f))) continue;
    seenContent.add(content(f));
    const key = `${period(f)}:${f.id === null ? `anon#${String((anon += 1))}` : String(f.id)}`;
    const applied = (f.e.appliedStats as Record<string, number> | undefined) ?? null;
    const seen = out.get(key);
    if (seen !== undefined && (seen.applied !== null || applied === null)) continue;
    const position = f.id === null ? null : (positions.get(f.id) ?? null);
    out.set(key, { key, league: f.league, position, stats: f.e.stats, applied });
  }
  return [...out.values()];
}
const WEEKLY_ACTUALS = weeklyActuals();

/** The yardage-game bonus pairs (plan 08 §4.2): [scalar, lower tier id, top tier id]. */
const YARDAGE_TIERS = [
  ["pass_yd", "17", "18"],
  ["rush_yd", "37", "38"],
  ["rec_yd", "56", "57"],
] as const;

/** The tier family of one yardage pair, as a league scoring both members builds it. */
function tierFamily(lo: string, hi: string) {
  const f = settingsOf
    .get("league-c")!
    .families.find((x) => x.members.some((m) => m.platform_id === lo));
  const fam = buildFamilies(
    [lo, hi].map((id): ScoringRule => ({
      canonical: espnStat(id)!.canonical,
      platform_id: id,
      abbr: espnStat(id)!.abbr,
      points: 1,
      overrides: {},
      is_reverse: false,
      applies_to: ["O"],
      disputed: false,
    })),
  )[0]!;
  expect(fam).toMatchObject({ family: "yardage_bonus", exclusive: true });
  expect(f?.exclusive).toBe(true);
  return fam;
}

/** The evidence counts the yardage tests recompute (distinct player-weeks; FAMILY_EVIDENCE quotes them). */
const YARDAGE_EVIDENCE = {
  checked: { pass_yd: 912, rush_yd: 3505, rec_yd: 5018 },
  above_top: { pass_yd: 15, rush_yd: 8, rec_yd: 3 },
  league_c_bonus_games: 109,
  league_c_top_paid: ["18", "18", "18", "38"],
};

/** Golden coverage, recomputed: a league scores the member and ESPN applied a non-zero value for it. */
function coverage(): Map<string, { leagues: LeagueSlot[]; nonzero: number }> {
  const out = new Map<string, { leagues: LeagueSlot[]; nonzero: number }>();
  for (const m of MEMBERS) {
    for (const league of LEAGUES) {
      const rule = settingsOf.get(league)!.rules.find((r) => r.platform_id === m.id);
      if (rule === undefined || !scoresForClass(rule, m.cls)) continue;
      const nonzero = lines.filter(
        (l) =>
          l.league === league &&
          positionClassOf(l.position) === m.cls &&
          (l.applied[m.id] ?? 0) !== 0,
      ).length;
      if (nonzero === 0) continue;
      const c = out.get(m.id) ?? { leagues: [], nonzero: 0 };
      c.leagues.push(league);
      c.nonzero += nonzero;
      out.set(m.id, c);
    }
  }
  return out;
}
const COVERED = coverage();

describe("GOLDEN_COVERED_STAT_IDS is what the recordings cover (plan 10 B13)", () => {
  it("equals the members a recorded league scores and the golden compares", () => {
    const ids = [...COVERED.keys()].sort((a, b) => Number(a) - Number(b));
    expect(GOLDEN_COVERED_STAT_IDS).toEqual(ids);
  });
  it("B13: league-c carries every long_td_bonus member and three per_n_yards members", () => {
    for (const id of ["15", "16", "35", "36", "45", "46", "8", "28", "48"]) {
      expect(COVERED.get(id)?.leagues, id).toEqual(["league-c"]);
      expect(COVERED.get(id)?.nonzero, id).toBeGreaterThan(0);
    }
  });
  it("D8: stat 74 (fg_50p legacy), the attempt buckets, 121, 128 and the HC margins are not covered", () => {
    for (const id of ["74", "75", "76", "78", "81", "199", "200", "202", "203", "121", "128"]) {
      expect(COVERED.has(id), id).toBe(false);
    }
    for (let id = 155; id <= 172; id += 1) expect(COVERED.has(String(id))).toBe(false);
  });
});

describe("FAMILY_EVIDENCE: each family's derivation, on ESPN's raw values", () => {
  it("per_n_yards: every per-N value is max(0, ⌊scalar / N⌋), actual and projected; a negative scalar omits the id", () => {
    let checked = 0;
    let omitted = 0;
    for (const m of MEMBERS.filter((x) => x.name === "per_n_yards")) {
      const base = espnIdOf(m.scalar)!;
      for (const l of lines) {
        const v = l.stats[m.id];
        const b = l.stats[base];
        if (l.actual && b !== undefined && b < 0) {
          expect(v, `${m.id} with ${base} < 0`).toBeUndefined();
          omitted += 1;
        }
        if (v === undefined) continue;
        expect(b, m.id).toBeDefined();
        expect(Math.abs(v - Math.max(0, Math.floor(b! / m.lower))), m.id).toBeLessThan(1e-9);
        checked += 1;
      }
    }
    expect(checked).toBe(15_434);
    expect(omitted).toBeGreaterThan(0);
    expect(FAMILY_EVIDENCE.per_n_yards.derivation).toBe("verified");
  });

  it("long_td_bonus: cumulative on every actual line — 50+ ≤ 40+ ≤ the TD count, and a 50+ TD sets 40+", () => {
    let fiftyPlus = 0;
    for (const scalar of ["pass_td", "rush_td", "rec_td"]) {
      const [forty, fifty] = MEMBERS.filter(
        (x) => x.name === "long_td_bonus" && x.scalar === scalar,
      )
        .sort((a, b) => a.lower - b.lower)
        .map((x) => x.id) as [string, string];
      const base = espnIdOf(scalar)!;
      for (const l of actual) {
        expect(g(l.stats, fifty)).toBeLessThanOrEqual(g(l.stats, forty));
        expect(g(l.stats, forty)).toBeLessThanOrEqual(g(l.stats, base));
        if (g(l.stats, fifty) > 0) fiftyPlus += 1;
      }
    }
    expect(fiftyPlus).toBeGreaterThan(0);
    expect(FAMILY_EVIDENCE.long_td_bonus.derivation).toBe("verified");
  });

  it("fg families: 74 = 198 + 201, 75 = 199 + 202, 76 = 200 + 203, attempts = made + missed per bucket", () => {
    const k = actual.filter((l) => l.position === 5);
    expect(k.length).toBeGreaterThan(100);
    for (const l of k) {
      const s = l.stats;
      expect(g(s, "74")).toBe(g(s, "198") + g(s, "201"));
      expect(g(s, "75")).toBe(g(s, "199") + g(s, "202"));
      expect(g(s, "76")).toBe(g(s, "200") + g(s, "203"));
      for (const [att, made, miss] of [
        ["81", "80", "82"],
        ["78", "77", "79"],
        ["199", "198", "200"],
        ["202", "201", "203"],
        ["75", "74", "76"],
      ]) {
        expect(g(s, att!)).toBe(g(s, made!) + g(s, miss!));
      }
    }
    expect(k.filter((l) => g(l.stats, "74") > 0).length).toBeGreaterThan(0);
  });

  it("D/ST tiers: every PA and YA indicator equals bracketize(120) / bracketize(127) on all 70 recorded weeks", () => {
    const tierRules = MEMBERS.filter(
      (m) => m.name === "dst_points_allowed" || m.name === "dst_yards_allowed",
    ).map((m): ScoringRule => ({
      canonical: m.canonical,
      platform_id: m.id,
      abbr: espnStat(m.id)!.abbr,
      points: 0,
      overrides: { "16": 1 },
      is_reverse: false,
      applies_to: ["DST"],
      disputed: false,
    }));
    const fams = buildFamilies(tierRules);
    const weeks = new Map<string, Readonly<Record<string, number>>>();
    for (const p of allPlayers)
      if (p.position === 16) weeks.set(`${String(p.player_id)}:${String(p.week)}`, p.actual!.stats);
    expect(weeks.size).toBe(70);
    for (const stats of weeks.values()) {
      for (const f of fams) {
        const vec = bracketize(f, g(stats, espnIdOf(f.scalar)!))!;
        f.members.forEach((m, i) => {
          expect(g(stats, m.platform_id), m.platform_id).toBe(vec[i]);
        });
      }
    }
  });

  it("yardage_bonus (A-2 settled): every recorded weekly actual sets the one tier holding its yardage — bracketize, exclusive", () => {
    const checked: Record<string, number> = {};
    const aboveTop: Record<string, number> = {};
    for (const [scalar, lo, hi] of YARDAGE_TIERS) {
      const fam = tierFamily(lo, hi);
      const base = espnIdOf(scalar)!;
      for (const l of WEEKLY_ACTUALS) {
        const y = l.stats[base];
        if (y === undefined) continue;
        expect([g(l.stats, lo), g(l.stats, hi)], `${l.key} ${scalar} ${String(y)}`).toEqual(
          bracketize(fam, y),
        );
        checked[scalar] = (checked[scalar] ?? 0) + 1;
        if (y >= fam.members[1]!.lower) aboveTop[scalar] = (aboveTop[scalar] ?? 0) + 1;
      }
    }
    // distinct recorded player-weeks (current season and the previous seasons' box scores)
    expect(checked).toEqual(YARDAGE_EVIDENCE.checked);
    // the games that decide A-2: at or above the top tier, the lower tier is never set
    expect(aboveTop).toEqual(YARDAGE_EVIDENCE.above_top);
    expect(FAMILY_EVIDENCE.yardage_bonus).toMatchObject({
      derivation: "verified",
      derivation_open_stat_ids: [],
    });
    // the server-authored basis quotes what this run counts
    const sum = (r: Record<string, number>) => Object.values(r).reduce((x, y) => x + y, 0);
    const basis = FAMILY_EVIDENCE.yardage_bonus.basis;
    expect(basis).toContain(`${sum(checked).toLocaleString("en-US")} recorded weekly lines`);
    expect(basis).toContain(
      `the ${String(sum(aboveTop))} games over the top tier (${String(aboveTop.pass_yd)} pass 400+, ${String(aboveTop.rush_yd)} rush, ${String(aboveTop.rec_yd)} rec 200+)`,
    );
  });

  it("yardage_bonus: ESPN pays only the top tier above it — league-c's appliedStats on its 400+ passing and 200+ rushing games", () => {
    const s = settingsOf.get("league-c")!;
    const paid: string[] = [];
    for (const [scalar, lo, hi] of YARDAGE_TIERS) {
      const top = tierFamily(lo, hi).members[1]!.lower;
      const base = espnIdOf(scalar)!;
      const hiRule = s.rules.find((r) => r.platform_id === hi)!;
      expect(hiRule.overrides).toEqual({});
      for (const l of WEEKLY_ACTUALS.filter((x) => x.league === "league-c" && x.applied !== null)) {
        if ((l.stats[base] ?? 0) < top) continue;
        expect(l.applied![lo], `${l.key} ${lo}`).toBeUndefined();
        expect(l.applied![hi], `${l.key} ${hi}`).toBe(hiRule.points);
        paid.push(hi);
      }
    }
    expect(paid.sort()).toEqual(YARDAGE_EVIDENCE.league_c_top_paid);
  });

  it("yardage_bonus: the engine on a DERIVED line of every recorded league-c game pays ESPN's applied bonus (no double pay)", () => {
    const s = settingsOf.get("league-c")!;
    const ids = YARDAGE_TIERS.flatMap(([, lo, hi]) => [lo, hi]);
    const canon = new Map(ids.map((id) => [espnStat(id)!.canonical, id]));
    // league-c carries no position override on a yardage bonus, so an mMatchupScore line (no
    // position) is scored as a QB's: the bonuses are class O only and every O position pays the same
    for (const id of ids) expect(s.rules.find((r) => r.platform_id === id)?.overrides).toEqual({});
    let bonusGames = 0;
    let topGames = 0;
    for (const l of WEEKLY_ACTUALS.filter((x) => x.league === "league-c" && x.applied !== null)) {
      if (l.position !== null && positionClassOf(l.position) !== "O") continue;
      const espnLine = statLineFromEspn({ raw: l.stats }, l.position ?? 1).line;
      // what an nflverse or simulated line carries: the yardage, never ESPN's indicators
      const values = Object.fromEntries(
        Object.entries(espnLine.values).filter(([c]) => !canon.has(c)),
      );
      const derived = {
        ...espnLine,
        values,
        present: Object.keys(values).sort(),
        source: "nflverse",
      };
      const got = new Map(
        score(derived, s)
          .contributions.filter((c) => canon.has(c.canonical))
          .map((c) => [canon.get(c.canonical)!, c.points]),
      );
      for (const id of ids) {
        expect(got.get(id) ?? 0, `${l.key} ${id}`).toBe(l.applied![id] ?? 0);
      }
      if (ids.some((id) => (l.applied![id] ?? 0) !== 0)) bonusGames += 1;
      if (["18", "38", "57"].some((id) => (l.applied![id] ?? 0) !== 0)) topGames += 1;
    }
    expect(bonusGames).toBe(YARDAGE_EVIDENCE.league_c_bonus_games);
    expect(topGames).toBe(YARDAGE_EVIDENCE.league_c_top_paid.length);
  });

  it("readAnyRecorded keeps the golden path guard and reads the previous seasons' manifest too", () => {
    for (const rel of [
      "../manifest.json",
      "history/manifest.json",
      "../fx-10h/league/mBoxscore.sp3.json",
    ])
      expect(() => readAnyRecorded(rel)).toThrow(GoldenPathError);
    expect(() => readAnyRecorded("history/2024/league-b/mBoxscore.sp99.json")).toThrow(
      /not in the manifest/,
    );
    expect(readAnyRecorded("history/2024/league-b/mBoxscore.sp10.json")).toHaveProperty("schedule");
    expect(recordedFiles().some((f) => f.startsWith("history/"))).toBe(true);
  });

  it("exclusivity is per game (plan 08 §4.1): a recorded SEASON split scores its tier members as game counts, as ESPN does", () => {
    // the exclusive families' members: D/ST PA and YA tiers, HC margins, the yardage-game bonuses
    const tierIds = new Set(MEMBERS.filter((m) => FAMILY_KIND[m.name] === "tier").map((m) => m.id));
    const leagueOf = (rel: string) => /^(league-[abc])\//.exec(rel)?.[1] as LeagueSlot | undefined;
    const seen = new Set<string>();
    const counts = { checked: 0, dst_tier_counts: 0, yardage_tier_counts: 0 };
    for (const rel of recordedFiles()) {
      const league = leagueOf(rel);
      if (league === undefined) continue;
      const s = settingsOf.get(league)!;
      const visit = (node: unknown): void => {
        if (Array.isArray(node)) {
          node.forEach(visit);
          return;
        }
        if (node === null || typeof node !== "object") return;
        const o = node as Record<string, unknown>;
        if (
          typeof o.id === "number" &&
          typeof o.defaultPositionId === "number" &&
          Array.isArray(o.stats)
        ) {
          for (const e of o.stats as StatEntry[]) {
            if (e.statSourceId !== 0 || e.statSplitTypeId !== 0) continue;
            // the player pages carry appliedTotal without the per-stat map: compare a copy with it
            const applied = e.appliedStats as Readonly<Record<string, number>> | undefined;
            if (applied === undefined || Object.keys(applied).length === 0) continue;
            const key = `${league}:${String(e.seasonId)}:${String(o.id)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const { line } = statLineFromEspn(
              {
                raw: e.stats,
                split: { source_id: 0, split_type: 0, season: e.seasonId, week: null },
              },
              o.defaultPositionId,
            );
            // scores without bracket_exclusivity, and every tier member matches ESPN's points
            const v = verify(line, s, { total: e.appliedTotal, by_stat: applied });
            expect(
              v.mismatch_stat_ids.filter((id) => tierIds.has(id)),
              key,
            ).toEqual([]);
            counts.checked += 1;
            const many = (ids: readonly string[]) => ids.some((id) => (e.stats[id] ?? 0) > 1);
            if (many(["89", "90", "91", "92", "121", "122", "123", "124", "125"]))
              counts.dst_tier_counts += 1;
            if (many(["17", "18", "37", "38", "56", "57"])) counts.yardage_tier_counts += 1;
          }
          return;
        }
        Object.values(o).forEach(visit);
      };
      visit(BODIES.get(rel));
    }
    // each line with a tier count above 1 threw bracket_exclusivity before "per game" was honoured
    expect(counts).toEqual({ checked: 1113, dst_tier_counts: 107, yardage_tier_counts: 230 });
  });

  it("margin tripwire: no head-coach line is recorded and no line carries a margin stat", () => {
    expect(lines.some((l) => l.position === 14)).toBe(false);
    for (const l of lines)
      for (let id = 161; id <= 172; id += 1) expect(l.stats[String(id)]).toBeUndefined();
    expect(FAMILY_EVIDENCE.margin.derivation).toBe("unverified");
  });
});

describe("familyVerification on the recorded leagues (what espn_get_league reports per family)", () => {
  const table = (l: LeagueSlot) =>
    familyVerification(settingsOf.get(l)!).map((v) => [
      `${v.family}:${v.scalar}`,
      v.verified,
      v.unverified_stat_ids.join(","),
    ]);
  it("league-a: FG misses and PA tiers verified; YA open on 128 (no game under 100 yards); HC margins not", () => {
    expect(table("league-a")).toEqual([
      ["fg_miss:kick_distance", true, ""],
      ["dst_points_allowed:dst_pa_raw", true, ""],
      ["dst_yards_allowed:dst_ya_raw", false, "128"],
      ["margin:team_win_margin", false, ""],
    ]);
  });
  it("league-b: FG made buckets and PA tiers verified", () => {
    expect(table("league-b")).toEqual([
      ["fg_distance:kick_distance", true, ""],
      ["dst_points_allowed:dst_pa_raw", true, ""],
    ]);
  });
  it("league-c (B13): long_td_bonus, per_n_yards and yardage_bonus (A-2 settled) verified", () => {
    expect(table("league-c")).toEqual([
      ["long_td_bonus:pass_td", true, ""],
      ["long_td_bonus:rec_td", true, ""],
      ["long_td_bonus:rush_td", true, ""],
      ["per_n_yards:pass_yd", true, ""],
      ["per_n_yards:rec_yd", true, ""],
      ["per_n_yards:rush_yd", true, ""],
      ["yardage_bonus:pass_yd", true, ""],
      ["yardage_bonus:rec_yd", true, ""],
      ["yardage_bonus:rush_yd", true, ""],
      ["fg_distance:kick_distance", true, ""],
      ["fg_miss:kick_distance", true, ""],
      ["dst_points_allowed:dst_pa_raw", true, ""],
    ]);
  });
  it("D8: league-b with the legacy 50+ item 74 in place of 198/201 reports fg_distance unverified [74]", () => {
    const raw = recordedScoringSettings("league-b") as {
      scoringItems: { statId: number; points: number }[];
    };
    const legacy = normalizeSettings({
      ...raw,
      scoringItems: [
        ...raw.scoringItems.filter((i) => i.statId !== 198 && i.statId !== 201),
        { statId: 74, points: 5 },
      ],
    });
    const fg = familyVerification(legacy).find((v) => v.family === "fg_distance");
    expect(fg).toMatchObject({ verified: false, unverified_stat_ids: ["74"] });
  });
});

// --- the docs/evals page --------------------------------------------------------------------------

const EVALS_PAGE = "phase2-engine-families.md";

function familiesSection(): string {
  const out = [
    "| family | ESPN id | canonical | bounds | scored by | golden values ≠ 0 (actual + projected) | raw ≠ 0 (actual) | verified |",
    "|---|---:|---|---|---|---:|---:|---|",
  ];
  for (const m of [...MEMBERS].sort(
    (a, b) => a.name.localeCompare(b.name) || Number(a.id) - Number(b.id),
  )) {
    const c = COVERED.get(m.id);
    const open = FAMILY_EVIDENCE[m.name].derivation_open_stat_ids.includes(m.id);
    const derivation = FAMILY_EVIDENCE[m.name].derivation === "verified";
    const scored = LEAGUES.some((l) => {
      const r = settingsOf.get(l)!.rules.find((x) => x.platform_id === m.id);
      return r !== undefined && scoresForClass(r, m.cls);
    });
    const verdict =
      c !== undefined
        ? !derivation
          ? "no — derivation unevidenced"
          : open
            ? "no — A-2 open"
            : "yes"
        : scored
          ? "no — scored, but never non-zero in a recorded line"
          : "no — no recorded league scores it (D8)";
    const bounds =
      m.name === "per_n_yards"
        ? `every ${String(m.lower)}`
        : `${m.lower <= -1e8 ? "−∞" : String(m.lower)}–${m.upper === null ? "∞" : String(m.upper)}`;
    const rawNz = actual.filter((l) => g(l.stats, m.id) !== 0).length;
    out.push(
      `| ${m.name} | ${m.id} | \`${m.canonical}\` | ${bounds} | ${c === undefined ? "—" : c.leagues.join(", ")} | ${c === undefined ? "—" : String(c.nonzero)} | ${String(rawNz)} | ${verdict} |`,
    );
  }
  out.push("", "| family | derivation | basis |", "|---|---|---|");
  for (const [name, e] of Object.entries(FAMILY_EVIDENCE)) {
    out.push(
      `| ${name} | ${e.derivation}${e.derivation_open_stat_ids.length > 0 ? ` (open: ${e.derivation_open_stat_ids.join(", ")})` : ""} | ${e.basis} |`,
    );
  }
  return out.join("\n");
}

beforeAll(() => {
  if (process.env.UPDATE_EVALS === "1")
    writeEvalsSection(EVALS_PAGE, "families", familiesSection());
});

describe("(B13, reported) docs/evals/phase2-engine-families.md lists every member", () => {
  it("the families section equals this run's table", () => {
    expect(evalsSection(EVALS_PAGE, "families")).toBe(familiesSection());
  });
  it("canonicalDef agrees with the member table", () => {
    for (const m of MEMBERS) expect(canonicalDef(m.canonical)?.family?.name).toBe(m.name);
  });
});
