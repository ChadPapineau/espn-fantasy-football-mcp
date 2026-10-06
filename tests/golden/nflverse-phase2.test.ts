// nflverse-phase2.test.ts — plan 10 B13 on recorded evidence: the D/ST points-allowed derivation
// pinned by the recorded weeks that contain a return TD against the offence (plan 08 §3.2 U-6, §11
// U-6; DST_POINTS_ALLOWED_EVIDENCE), the Phase-2 adapters from ds_stats_team_week / ds_pbp rows,
// and the long-TD families' pbp derivation (plan 08 §4.3). ESPN's side (stats 120, 127, 15/16/35/36/
// 45/46 and their appliedStats) is read ONLY through the golden path guard (./recorded.ts); the
// nflverse side is fixtures/golden/nflverse-phase2-evidence.json (sha256-pinned release files, made
// by ./extract-nflverse-evidence.ts). Reported numbers go to docs/evals/phase2-engine-families.md,
// which this test keeps equal to the run (UPDATE_EVALS=1 rewrites it).
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  canonicalDef,
  defenseScoresFromPlays,
  DST_POINTS_ALLOWED_EVIDENCE,
  espnIdOf,
  espnStat,
  LONG_TD_CANONICALS,
  longTdCounts,
  normalizeSettings,
  type NflverseRow,
  pointsAllowed,
  pointsAllowedFromTeamWeek,
  type PointsAllowedInput,
  score,
  type ScoringSettings,
  statLineFromPlayerWeek,
  statLineFromTeamDefense,
  yardsAllowedFromTeamWeek,
} from "../../src/domain/scoring/index.js";
import { isKeptPlayType } from "../../src/store/datasets/derive.js";
import { evalsSection, writeEvalsSection } from "./evals-doc.js";
import {
  finalWeeks,
  LEAGUES,
  type PlayerWeek,
  recordedScoringSettings,
  recordedTeamWeeks,
  ROOT,
} from "./recorded.js";

interface Unit {
  readonly espn_id: number;
  readonly week: number;
  readonly game_id: string;
  readonly team: string;
  readonly opponent: string;
  readonly opponent_score: number;
  readonly opponent_team_week: NflverseRow;
}
interface Evidence {
  readonly sources: readonly { url: string; bytes: number; sha256: string }[];
  readonly dst_units: readonly Unit[];
  readonly scoring_plays: readonly NflverseRow[];
  readonly players: readonly (readonly [number, string])[];
}

const evidence = JSON.parse(
  readFileSync(path.join(ROOT, "fixtures/golden/nflverse-phase2-evidence.json"), "utf8"),
) as Evidence;

const allPlayers: PlayerWeek[] = LEAGUES.flatMap((l) =>
  finalWeeks(l).flatMap((w) => recordedTeamWeeks(l, w).flatMap((t) => t.players)),
);
/** ESPN's raw stats per (player, week) — league-independent (asserted), the first copy kept. */
const espnRaw = new Map<string, { position: number; stats: Readonly<Record<string, number>> }>();
for (const p of allPlayers) {
  if (p.actual === undefined) continue;
  const key = `${String(p.player_id)}:${String(p.week)}`;
  const prior = espnRaw.get(key);
  if (prior !== undefined) expect(prior.stats).toEqual(p.actual.stats);
  else espnRaw.set(key, { position: p.position, stats: p.actual.stats });
}
const raw = (key: string, id: string): number => espnRaw.get(key)?.stats[id] ?? 0;
const unitKey = (u: Unit): string => `${String(u.espn_id)}:${String(u.week)}`;
const playsOf = (gameId: string): NflverseRow[] =>
  evidence.scoring_plays.filter((p) => p.game_id === gameId);

/** pbp-exact facts for one unit: what the OPPONENT's defence scored, every play row included. */
function factsOf(u: Unit, plays: readonly NflverseRow[] = playsOf(u.game_id)): PointsAllowedInput {
  const s = defenseScoresFromPlays(plays, u.opponent);
  return {
    score: u.opponent_score,
    opponent_int_tds: s.int_return_tds,
    opponent_fumble_tds: s.fumble_return_tds,
    opponent_safeties: s.safeties,
  };
}

/** The opponent's special-teams TDs against this unit (punt / kickoff plays). */
function returnTdsAgainst(u: Unit): { punt: number; kickoff: number } {
  const tds = playsOf(u.game_id).filter((p) => p.touchdown === 1 && p.td_team === u.opponent);
  return {
    punt: tds.filter((p) => p.play_type === "punt").length,
    kickoff: tds.filter((p) => p.play_type === "kickoff").length,
  };
}

/** The try after each TD the opponent's defence scored on a scrimmage play: good / failed. */
function triesAfterNetted(u: Unit): { good: number; failed: number } {
  const plays = playsOf(u.game_id);
  const out = { good: 0, failed: 0 };
  plays.forEach((p, i) => {
    const netted =
      p.touchdown === 1 &&
      p.td_team === u.opponent &&
      p.defteam === u.opponent &&
      ["pass", "run", "qb_kneel", "qb_spike"].includes(String(p.play_type));
    if (!netted) return;
    const next = plays[i + 1];
    expect(next?.play_type === "extra_point" || next?.two_point_attempt === 1, u.game_id).toBe(
      true,
    );
    const ok = next?.extra_point_result === "good" || next?.two_point_conv_result === "success";
    if (ok) out.good += 1;
    else out.failed += 1;
  });
  return out;
}

const units = evidence.dst_units;
const espn120 = (u: Unit): number => raw(unitKey(u), "120");

describe("the evidence fixture (plan 10 B13: sources pinned, every recorded D/ST week covered)", () => {
  it("names four sha256-pinned nflverse release files", () => {
    expect(evidence.sources.map((s) => s.url.split("/").pop())).toEqual([
      "games.parquet",
      "play_by_play_2026.parquet",
      "stats_team_week_2026.parquet",
      "roster_weekly_2026.parquet",
    ]);
    for (const s of evidence.sources) {
      expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(s.bytes).toBeGreaterThan(0);
    }
  });
  it("holds exactly the 70 recorded D/ST weeks, each once", () => {
    const recorded = [...espnRaw.entries()]
      .filter(([, v]) => v.position === 16)
      .map(([k]) => k)
      .sort();
    expect(units.map(unitKey).sort()).toEqual(recorded);
    expect(units).toHaveLength(DST_POINTS_ALLOWED_EVIDENCE.recorded_dst_weeks);
    for (const u of units) expect(u.opponent_team_week.team).toBe(u.opponent);
  });
});

describe("U-6 pinned: ESPN's stat 120 is the opponent's score net of its defence's scores", () => {
  it("net_of_defense with pbp-exact facts equals ESPN on every recorded D/ST week", () => {
    const misses = units.filter((u) => pointsAllowed(factsOf(u)) !== espn120(u)).map(unitKey);
    expect(misses).toEqual([]);
    expect(units.length).toBe(DST_POINTS_ALLOWED_EVIDENCE.net_of_defense_matches);
  });

  it("final_score fails on exactly the weeks with an opponent's defensive score", () => {
    const scored = (u: Unit) => {
      const f = factsOf(u);
      return (f.opponent_int_tds ?? 0) + (f.opponent_fumble_tds ?? 0) + (f.opponent_safeties ?? 0);
    };
    const finalMisses = units.filter(
      (u) => pointsAllowed(factsOf(u), "final_score") !== espn120(u),
    );
    expect(finalMisses.map(unitKey)).toEqual(units.filter((u) => scored(u) > 0).map(unitKey));
    expect(units.length - finalMisses.length).toBe(DST_POINTS_ALLOWED_EVIDENCE.final_score_matches);
  });

  it("the discriminating weeks are what DST_POINTS_ALLOWED_EVIDENCE says (a return TD against the offence among them)", () => {
    const count = (pred: (u: Unit) => boolean) => units.filter(pred).length;
    expect({
      int_return_td: count((u) => (factsOf(u).opponent_int_tds ?? 0) > 0),
      fumble_return_td: count((u) => (factsOf(u).opponent_fumble_tds ?? 0) > 0),
      safety: count((u) => (factsOf(u).opponent_safeties ?? 0) > 0),
      punt_return_td: count((u) => returnTdsAgainst(u).punt > 0),
    }).toEqual(DST_POINTS_ALLOWED_EVIDENCE.weeks_with);
    expect(count((u) => returnTdsAgainst(u).kickoff > 0)).toBe(0); // unobserved, so [U]
    expect(DST_POINTS_ALLOWED_EVIDENCE.unobserved).toContain("kickoff_return_td");
  });

  it("mutation: netting the punt-return TD too fails on that week — special-teams TDs count against the D/ST", () => {
    const st = units.filter((u) => returnTdsAgainst(u).punt + returnTdsAgainst(u).kickoff > 0);
    expect(st.length).toBeGreaterThan(0);
    for (const u of st) {
      const f = factsOf(u);
      const r = returnTdsAgainst(u);
      const netAll = pointsAllowed({
        ...f,
        opponent_fumble_tds: (f.opponent_fumble_tds ?? 0) + r.punt + r.kickoff,
      });
      expect(netAll, unitKey(u)).not.toBe(espn120(u));
      expect(pointsAllowed(f), unitKey(u)).toBe(espn120(u));
    }
  });

  it("mutation: netting the try after a netted TD fails — the extra point still counts against the D/ST", () => {
    const tries = units.map((u) => ({ u, t: triesAfterNetted(u) }));
    const total = tries.reduce(
      (a, { t }) => ({ good: a.good + t.good, failed: a.failed + t.failed }),
      { good: 0, failed: 0 },
    );
    expect(total).toEqual(DST_POINTS_ALLOWED_EVIDENCE.tries_after_netted_td);
    for (const { u, t } of tries.filter((x) => x.t.good > 0)) {
      expect(pointsAllowed(factsOf(u)) - t.good, unitKey(u)).not.toBe(espn120(u));
    }
  });
});

describe("the Phase-2 adapters reproduce ESPN from store-shaped rows", () => {
  it("pointsAllowedFromTeamWeek (the opponent's ds_stats_team_week row) = ESPN 120 on 70/70, with and without plays", () => {
    for (const u of units) {
      const row = pointsAllowedFromTeamWeek(u.opponent_team_week, u.opponent_score);
      expect(row, unitKey(u)).not.toBeNull();
      expect(pointsAllowed(row!), unitKey(u)).toBe(espn120(u));
      const exact = pointsAllowedFromTeamWeek(
        u.opponent_team_week,
        u.opponent_score,
        playsOf(u.game_id),
      );
      expect(pointsAllowed(exact!), unitKey(u)).toBe(espn120(u));
    }
  });

  it("yardsAllowedFromTeamWeek = ESPN 127 on 70/70", () => {
    for (const u of units) {
      expect(yardsAllowedFromTeamWeek(u.opponent_team_week), unitKey(u)).toBe(
        raw(unitKey(u), "127"),
      );
    }
  });

  it("ds_pbp's row filter (no_play dropped) loses the one penalty safety: pbp-only safeties miss 1 week", () => {
    const misses = units.filter((u) => {
      const kept = playsOf(u.game_id).filter((p) => isKeptPlayType(p.play_type));
      return pointsAllowed(factsOf(u, kept)) !== espn120(u);
    });
    expect(misses).toHaveLength(1);
    const lost = playsOf(misses[0]!.game_id).filter((p) => p.safety === 1);
    expect(lost.map((p) => p.play_type)).toEqual(["no_play"]);
  });

  it.each(LEAGUES)(
    "%s: a derived D/ST line (statLineFromTeamDefense) pays the PA and YA tiers ESPN applied",
    (league) => {
      const s = normalizeSettings(recordedScoringSettings(league));
      let compared = 0;
      for (const p of allPlayers.filter((x) => x.league === league && x.position === 16)) {
        const u = units.find((x) => x.espn_id === p.player_id && x.week === p.week)!;
        const tw = u.opponent_team_week;
        const line = statLineFromTeamDefense(
          {
            opp_passing_yards: tw.passing_yards,
            opp_rushing_yards: tw.rushing_yards,
            opp_sack_yards_lost: tw.sack_yards_lost,
          },
          { pointsAllowed: pointsAllowedFromTeamWeek(tw, u.opponent_score) },
        );
        const pts = new Map(score(line, s).contributions.map((c) => [c.platform_id, c.points]));
        for (const [id, applied] of Object.entries(p.actual!.appliedStats)) {
          const fam = canonicalDef(espnStat(id)?.canonical ?? "")?.family?.name;
          if (fam !== "dst_points_allowed" && fam !== "dst_yards_allowed") continue;
          expect(
            Math.abs((pts.get(id) ?? 0) - applied),
            `${league} ${String(p.player_id)} ${id}`,
          ).toBeLessThanOrEqual(0.005);
          compared += 1;
        }
      }
      expect(compared).toBeGreaterThan(0);
    },
  );
});

// --- long-TD lengths from pbp (plan 08 §4.3) ------------------------------------------------------

const gsisOf = new Map(evidence.players.map(([e, g]) => [e, g]));
const LONG_IDS = LONG_TD_CANONICALS.map((c) => espnIdOf(c)!);
/** Recorded QB/RB/WR/TE player-weeks (deduplicated across leagues). */
const offence = [...espnRaw.entries()].filter(([, v]) => [1, 2, 3, 4].includes(v.position));
const weekPlays = (week: number) => evidence.scoring_plays.filter((p) => p.week === week);

/** TD counts per role from the excerpt (completeness: they must equal ESPN's 4/43/25). */
function tdCounts(gsis: string, week: number): { pass: number; rec: number; rush: number } {
  const tds = weekPlays(week);
  return {
    pass: tds.filter((p) => p.pass_touchdown === 1 && p.passer_player_id === gsis).length,
    rec: tds.filter((p) => p.pass_touchdown === 1 && p.td_player_id === gsis).length,
    rush: tds.filter((p) => p.rush_touchdown === 1 && p.td_player_id === gsis).length,
  };
}

describe("long_td_bonus from ds_pbp TD lengths equals ESPN's raw ids (plan 08 §4.3)", () => {
  it("every recorded QB/RB/WR/TE has a gsis id; the excerpt holds all of their TDs", () => {
    expect(offence.length).toBe(530);
    for (const [key, v] of offence) {
      const [espnId, week] = key.split(":").map(Number) as [number, number];
      const gsis = gsisOf.get(espnId);
      expect(gsis, key).toBeDefined();
      const c = tdCounts(gsis!, week);
      expect([c.pass, c.rec, c.rush], key).toEqual([
        v.stats["4"] ?? 0,
        v.stats["43"] ?? 0,
        v.stats["25"] ?? 0,
      ]);
    }
  });

  it("longTdCounts = ESPN's 15/16/35/36/45/46 on 530/530 player-weeks (24 with a long TD)", () => {
    let withLong = 0;
    for (const [key] of offence) {
      const [espnId, week] = key.split(":").map(Number) as [number, number];
      const counts = longTdCounts(weekPlays(week), gsisOf.get(espnId)!);
      expect(counts, key).not.toBeNull();
      const espn = Object.fromEntries(LONG_TD_CANONICALS.map((c) => [c, raw(key, espnIdOf(c)!)]));
      expect(counts, key).toEqual(espn);
      if (Object.values(espn).some((n) => n > 0)) withLong += 1;
    }
    expect(withLong).toBe(24);
  });

  it("league-c: a derived line with the pbp counts pays the long-TD items ESPN applied, complete", () => {
    const s: ScoringSettings = normalizeSettings(recordedScoringSettings("league-c"));
    let compared = 0;
    for (const p of allPlayers.filter(
      (x) => x.league === "league-c" && [1, 2, 3, 4].includes(x.position),
    )) {
      const gsis = gsisOf.get(p.player_id)!;
      const c = tdCounts(gsis, p.week);
      const line = statLineFromPlayerWeek(
        { passing_tds: c.pass, receiving_tds: c.rec, rushing_tds: c.rush },
        { position: p.position, long_tds: longTdCounts(weekPlays(p.week), gsis) },
      );
      const r = score(line, s);
      expect(r.underivable.filter((u) => LONG_TD_CANONICALS.includes(u))).toEqual([]);
      const pts = new Map(r.contributions.map((x) => [x.platform_id, x.points]));
      for (const id of LONG_IDS) {
        const applied = p.actual!.appliedStats[id] ?? 0;
        expect(
          Math.abs((pts.get(id) ?? 0) - applied),
          `${String(p.player_id)} w${String(p.week)} ${id}`,
        ).toBeLessThanOrEqual(0.005);
        if (applied !== 0) compared += 1;
      }
    }
    expect(compared).toBe(33);
  });
});

// --- the docs/evals page (plan 10 §3.2: reported numbers live in docs/evals/) ---------------------

const EVALS_PAGE = "phase2-engine-families.md";

function dstSection(): string {
  const f = (u: Unit) => factsOf(u);
  const lines = [
    "| definition of points allowed (ESPN stat 120) | recorded D/ST weeks reproduced |",
    "|---|---:|",
    `| net of the opponent defence's INT-/fumble-return TDs (6 each) and safeties (2 each) — shipped | ${String(units.filter((u) => pointsAllowed(f(u)) === espn120(u)).length)} / ${String(units.length)} |`,
    `| the opponent's final score | ${String(units.filter((u) => pointsAllowed(f(u), "final_score") === espn120(u)).length)} / ${String(units.length)} |`,
    `| net of every non-offensive TD (kick/punt returns too) | ${String(
      units.filter((u) => {
        const r = returnTdsAgainst(u);
        return (
          pointsAllowed({
            ...f(u),
            opponent_fumble_tds: (f(u).opponent_fumble_tds ?? 0) + r.punt + r.kickoff,
          }) === espn120(u)
        );
      }).length,
    )} / ${String(units.length)} |`,
    `| net of the TD and the try after it (7 on a good extra point) | ${String(units.filter((u) => pointsAllowed(f(u)) - triesAfterNetted(u).good === espn120(u)).length)} / ${String(units.length)} |`,
    "",
    "**The discriminating weeks** (every recorded D/ST week whose opponent scored without its offence):",
    "",
    "| D/ST | week | opponent scored | final score | ESPN 120 | shipped |",
    "|---:|---:|---|---:|---:|---:|",
  ];
  for (const u of units) {
    const x = f(u);
    const r = returnTdsAgainst(u);
    const t = triesAfterNetted(u);
    const kinds = [
      ...Array.from({ length: x.opponent_int_tds ?? 0 }, () => "INT-return TD"),
      ...Array.from({ length: x.opponent_fumble_tds ?? 0 }, () => "fumble-return TD"),
      ...Array.from({ length: x.opponent_safeties ?? 0 }, () => "safety"),
      ...Array.from({ length: r.punt }, () => "punt-return TD (not netted)"),
      ...Array.from({ length: r.kickoff }, () => "kickoff-return TD (not netted)"),
    ];
    if (kinds.length === 0) continue;
    const tries = t.good + t.failed > 0 ? `; try ${t.good > 0 ? "good" : "failed"}` : "";
    lines.push(
      `| ${String(u.espn_id)} | ${String(u.week)} | ${kinds.join(", ")}${tries} | ${String(u.opponent_score)} | ${String(espn120(u))} | ${String(pointsAllowed(x))} |`,
    );
  }
  const kept = units.filter(
    (u) =>
      pointsAllowed(
        factsOf(
          u,
          playsOf(u.game_id).filter((p) => isKeptPlayType(p.play_type)),
        ),
      ) === espn120(u),
  ).length;
  lines.push(
    "",
    "**Where the facts come from** (the same 70 weeks):",
    "",
    "| source of the netted events | reproduced |",
    "|---|---:|",
    `| \`pointsAllowedFromTeamWeek\` on the opponent's \`ds_stats_team_week\` row | ${String(units.filter((u) => pointsAllowed(pointsAllowedFromTeamWeek(u.opponent_team_week, u.opponent_score)!) === espn120(u)).length)} / ${String(units.length)} |`,
    `| full pbp (every row) | ${String(units.filter((u) => pointsAllowed(f(u)) === espn120(u)).length)} / ${String(units.length)} |`,
    `| pbp after \`ds_pbp\`'s row filter (\`no_play\` dropped) | ${String(kept)} / ${String(units.length)} |`,
    `| yards allowed (stat 127) by \`yardsAllowedFromTeamWeek\` | ${String(units.filter((u) => yardsAllowedFromTeamWeek(u.opponent_team_week) === raw(unitKey(u), "127")).length)} / ${String(units.length)} |`,
  );
  return lines.join("\n");
}

function longTdSection(): string {
  let agree = 0;
  let withLong = 0;
  const perId = new Map<string, number>(LONG_IDS.map((id) => [id, 0]));
  for (const [key] of offence) {
    const [espnId, week] = key.split(":").map(Number) as [number, number];
    const counts = longTdCounts(weekPlays(week), gsisOf.get(espnId)!);
    const espn = Object.fromEntries(LONG_TD_CANONICALS.map((c) => [c, raw(key, espnIdOf(c)!)]));
    if (JSON.stringify(counts) === JSON.stringify(espn)) agree += 1;
    if (Object.values(espn).some((n) => n > 0)) withLong += 1;
    for (const id of LONG_IDS) if (raw(key, id) > 0) perId.set(id, (perId.get(id) ?? 0) + 1);
  }
  return [
    "| quantity | value |",
    "|---|---:|",
    `| recorded QB/RB/WR/TE player-weeks (deduplicated across leagues) | ${String(offence.length)} |`,
    `| of which \`longTdCounts\` equals ESPN's raw 15/16/35/36/45/46 | ${String(agree)} |`,
    `| of which ESPN records a long TD | ${String(withLong)} |`,
    `| player-weeks with ESPN ${LONG_IDS.join(" / ")} non-zero | ${LONG_IDS.map((id) => String(perId.get(id))).join(" / ")} |`,
  ].join("\n");
}

beforeAll(() => {
  if (process.env.UPDATE_EVALS === "1") {
    writeEvalsSection(EVALS_PAGE, "dst", dstSection());
    writeEvalsSection(EVALS_PAGE, "long_td", longTdSection());
  }
});

describe("(B13, reported) docs/evals/phase2-engine-families.md is this run's numbers", () => {
  it("the D/ST points-allowed section", () => {
    expect(evalsSection(EVALS_PAGE, "dst")).toBe(dstSection());
  });
  it("the long-TD section", () => {
    expect(evalsSection(EVALS_PAGE, "long_td")).toBe(longTdSection());
  });
});
