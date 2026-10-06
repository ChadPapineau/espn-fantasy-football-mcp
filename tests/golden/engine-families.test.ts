// engine-families.test.ts — plan 10 B13 / open decision D8 on the three recorded leagues: which
// bracket families (plan 08 §2, §4) reproduce ESPN, re-derived from fixtures/espn/recorded so the
// server-authored constants in src/domain/scoring/verification.ts cannot drift from the recordings:
// GOLDEN_COVERED_STAT_IDS (a recorded league scores the id and the golden compares ESPN's
// appliedStats for it), FAMILY_EVIDENCE (each family's derivation checked on ESPN's raw values:
// per-N floor, cumulative long-TD ids, FG bucket sums, D/ST tiers = bracketize(120/127), the A-2
// and HC tripwires), and familyVerification per recorded league. Reads ESPN data ONLY through the
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
  familyVerification,
  GOLDEN_COVERED_STAT_IDS,
  normalizeSettings,
  scoresForClass,
  type ScoringRule,
  type ScoringSettings,
} from "../../src/domain/scoring/index.js";
import { evalsSection, writeEvalsSection } from "./evals-doc.js";
import {
  finalWeeks,
  LEAGUES,
  type LeagueSlot,
  type PlayerWeek,
  recordedScoringSettings,
  recordedTeamWeeks,
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

  it("yardage_bonus: indicators fire at the lower bound; A-2 tripwire — no recorded 400-yard pass or 200-yard rush/rec game", () => {
    for (const m of MEMBERS.filter((x) => x.name === "yardage_bonus")) {
      const base = espnIdOf(m.scalar)!;
      for (const l of actual.filter((x) => positionClassOf(x.position) === "O")) {
        const y = g(l.stats, base);
        expect(
          y < (m.upper ?? Infinity) + 1 || m.upper === null,
          "a game above a bounded member's upper bound",
        ).toBe(true);
        expect(g(l.stats, m.id), m.id).toBe(y >= m.lower ? 1 : 0);
      }
    }
    // when a re-recording holds such a game, settle A-2 and drop the ids from derivation_open_stat_ids
    expect(FAMILY_EVIDENCE.yardage_bonus.derivation_open_stat_ids).toEqual(["17", "37", "56"]);
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
  it("league-c (B13): long_td_bonus and per_n_yards verified; yardage_bonus open on A-2", () => {
    expect(table("league-c")).toEqual([
      ["long_td_bonus:pass_td", true, ""],
      ["long_td_bonus:rec_td", true, ""],
      ["long_td_bonus:rush_td", true, ""],
      ["per_n_yards:pass_yd", true, ""],
      ["per_n_yards:rec_yd", true, ""],
      ["per_n_yards:rush_yd", true, ""],
      ["yardage_bonus:pass_yd", false, "17"],
      ["yardage_bonus:rec_yd", false, "56"],
      ["yardage_bonus:rush_yd", false, "37"],
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
