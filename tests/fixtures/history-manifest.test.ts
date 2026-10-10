// history-manifest.test.ts — the COMMITTED previous-season fixtures against
// fixtures/espn/recorded/history/manifest.json: plan 10 §3.3 (≥ 3 historical seasons [A-3]; C4's
// inputs — playoffSeed on every finished season, the full schedule results; C1's — ESPN's weekly
// projections, statSourceId 1, statSplitTypeId 1, under the league's scoring; C3's replay), plan 05
// §3.1 step 4 (a fixture whose hash differs from its manifest fails), ADV OBJ-01 (every scoring field
// hashes to the recorded original), ADV OBJ-21 (recorded = evidence, `derived: false`), research 03
// §F.3 step 3 (no identifier in any committed fixture). Hermetic: in-process scanner rules, no local
// deny-list, no network.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanText } from "../../scripts/dev/scan-secrets.mjs";
import {
  contentSha256,
  parseJsonStrict,
  type Json,
  type JsonObject,
} from "../../scripts/espn-fixture/canonical.js";
import { formatJson } from "../../scripts/espn-fixture/format-json.js";
import {
  HISTORY_MANIFEST_REL,
  seasonFinished,
  type HistoryManifest,
} from "../../scripts/espn-fixture/history.js";
import { leagueFormat } from "../../scripts/espn-fixture/league-format.js";
import {
  KEEP_HEADERS,
  MAX_FIXTURE_BYTES,
  deriveIncomplete,
  type ManifestEntry,
} from "../../scripts/espn-fixture/pipeline.js";
import {
  FAKE_GUID_RE,
  SCRUB_RULES_VERSION,
  letters,
  scoringProjection,
} from "../../scripts/espn-fixture/scrub.js";
import { createFixtureFetch } from "../../src/providers/espn/fixture.js";
import {
  historyBody,
  historyEntries,
  historyFixtureFetch,
  servedSeasons,
} from "./helpers/history-fixtures.js";
import { ROOT } from "../lint/helpers.js";

const ESPN = path.join(ROOT, "fixtures", "espn");
const manifest = JSON.parse(
  readFileSync(path.join(ESPN, HISTORY_MANIFEST_REL), "utf8"),
) as HistoryManifest;
const files = manifest.files;
const read = (p: string): { text: string; body: Json } => {
  const text = readFileSync(path.join(ESPN, p), "utf8");
  return { text, body: parseJsonStrict(text) };
};
const GUID_ANY = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g;
const SLOTS = Object.keys(manifest.leagues).sort();
const seasonOfPath = (p: string): number => Number(/^recorded\/history\/(\d{4})\//.exec(p)?.[1]);

/** One response's body (a split one re-assembled from its parts in index order). */
function whole(base: string): JsonObject {
  const parts = files
    .filter((f) => f.path === `${base}.json` || f.path.replace(/\.p\d+\.json$/, "") === base)
    .sort((a, b) => (a.part?.index ?? 0) - (b.part?.index ?? 0));
  if (!parts.length) throw new Error(`no manifest entry for ${base}`);
  const bodies = parts.map((p) => read(p.path).body as JsonObject);
  const first = parts[0];
  if (!first?.part) return bodies[0] ?? {};
  const array = first.part.array;
  return { ...bodies[0], [array]: bodies.flatMap((b) => (b[array] as Json[] | undefined) ?? []) };
}
const entryOf = (base: string): ManifestEntry => {
  const e = files.find((f) => f.path === `${base}.json` || f.path === `${base}.p1.json`);
  if (!e) throw new Error(`no manifest entry for ${base}`);
  return e;
};

interface Team {
  id: number;
  divisionId: number;
  playoffSeed: number;
  record: {
    overall: { wins: number; losses: number; ties: number; percentage: number; pointsFor: number };
  };
}
interface Side {
  teamId: number;
  totalPoints: number;
  pointsByScoringPeriod?: Record<string, number>;
  rosterForCurrentScoringPeriod?: { entries: RosterEntry[] };
}
interface Row {
  id: number;
  matchupPeriodId: number;
  winner: string;
  home?: Side;
  away?: Side;
}
interface Stat {
  id: string;
  seasonId: number;
  scoringPeriodId: number;
  statSourceId: number;
  statSplitTypeId: number;
  appliedTotal: number;
  appliedStats: Record<string, number>;
  stats: Record<string, number>;
}
interface RosterEntry {
  playerId: number;
  lineupSlotId: number;
  playerPoolEntry: { player: { id: number; stats: Stat[] } };
}

/** The served league-seasons: [slot, season]. */
const served: [string, number][] = SLOTS.flatMap((slot) =>
  Object.entries(manifest.leagues[slot]?.seasons ?? {})
    .filter(([, s]) => s.served)
    .map(([season]) => [slot, Number(season)] as [string, number]),
);

describe("fixtures/espn/recorded/history/manifest.json", () => {
  it("lists exactly the files on disk under recorded/history/ (no orphan, no ghost)", () => {
    const onDisk = readdirSync(path.join(ESPN, "recorded", "history"), {
      recursive: true,
      withFileTypes: true,
    })
      .filter((d) => d.isFile() && d.name.endsWith(".json"))
      .map((d) => path.relative(ESPN, path.join(d.parentPath, d.name)).split(path.sep).join("/"))
      .filter((p) => p !== HISTORY_MANIFEST_REL)
      .sort();
    expect(files.map((f) => f.path).sort()).toEqual(onDisk);
    expect(manifest.withheld_files).toEqual([]);
  });

  it("is recorded evidence of finished previous seasons: read host, current scrub rules, never derived", () => {
    expect(manifest.version).toBe(1);
    expect(manifest.kind).toBe("history");
    expect(manifest.host).toBe("lm-api-reads.fantasy.espn.com");
    expect(manifest.scrub_rules_version).toBe(SCRUB_RULES_VERSION);
    // ≥ 3 historical seasons [A-3], including 2024 and 2025 (the Phase 3 brief)
    expect(manifest.seasons.length).toBeGreaterThanOrEqual(3);
    expect(manifest.seasons).toEqual(expect.arrayContaining([2024, 2025]));
    for (const f of files) {
      expect(f.derived).toBe(false);
      expect(f.scrub_rules_version).toBe(SCRUB_RULES_VERSION);
      expect(f.path).toMatch(/^recorded\/history\/20\d\d\/(?:season|league-[a-e])\/[\w.-]+\.json$/);
      const season = seasonOfPath(f.path);
      expect(manifest.seasons).toContain(season);
      expect(f.request.path).toBe(
        f.request.route === "season"
          ? `/apis/v3/games/ffl/seasons/${String(season)}`
          : `/apis/v3/games/ffl/seasons/${String(season)}/segments/0/leagues/0`,
      );
      expect(f.status).toBe(200);
      for (const h of Object.keys(f.headers))
        expect(KEEP_HEADERS as readonly string[]).toContain(h);
      for (const w of f.withheld) expect(w).toMatch(/^\$(?:\.[A-Za-z_]\w*|\[\d+\])+$/);
      expect(f.league === null).toBe(f.path.split("/")[3] === "season");
    }
  });

  it("every probe league is bound to its committed slot: previous_seasons = the current fixture's list", () => {
    expect(SLOTS).toEqual(["league-a", "league-b", "league-c"]);
    for (const slot of SLOTS) {
      const current = read(`recorded/${slot}/mSettings.json`).body as {
        status: { previousSeasons: number[] };
      };
      const l = manifest.leagues[slot];
      expect(l?.previous_seasons).toEqual(
        [...current.status.previousSeasons].sort((a, b) => a - b),
      );
      const attempted = Object.keys(l?.seasons ?? {}).map(Number);
      expect(l?.not_attempted).toEqual(
        (l?.previous_seasons ?? []).filter((s) => !attempted.includes(s)),
      );
      // 2024 and 2025 served keylessly for every league (a refused season would be written up)
      for (const s of [2024, 2025])
        expect(l?.seasons[String(s)]?.served, `${slot} ${String(s)}`).toBe(true);
    }
  });

  it("each served league-season: its own mSettings, mTeam and mMatchup; the format re-derives", () => {
    for (const [slot, season] of served) {
      const base = `recorded/history/${String(season)}/${slot}`;
      const settings = whole(`${base}/mSettings`);
      const s = manifest.leagues[slot]?.seasons[String(season)];
      if (!s?.served) throw new Error("unreachable");
      expect(leagueFormat(settings)).toEqual(s.format);
      for (const f of files.filter((x) => x.league === slot && seasonOfPath(x.path) === season))
        expect(f.format).toEqual(s.format);
      expect(settings.seasonId).toBe(season);
      expect(entryOf(`${base}/mTeam`).views).toEqual(["mTeam", "mStandings"]);
      expect(entryOf(`${base}/mMatchup`).views).toEqual(["mMatchup"]);
      expect(s.finished).toBe(true);
      expect(seasonFinished(settings, whole(`${base}/mMatchup`)).finished).toBe(true);
      expect(s.teams).toBe((whole(`${base}/mTeam`).teams as Json[]).length);
    }
  });

  it("CAT-12: `incomplete` re-derives; a box score loses roster entries only, never a matchup row", () => {
    for (const e of files) {
      const body = whole(e.path.replace(/(?:\.p\d+)?\.json$/, ""));
      expect(e.incomplete, e.path).toEqual(deriveIncomplete(body, e.withheld));
      if (e.views[0] === "mBoxscore") {
        for (const w of e.withheld)
          expect(w).toMatch(/^\$\.schedule\[\d+\]\.(?:home|away)\.roster\w*\.entries\[\d+\]$/);
        expect(e.incomplete?.matchups_missing ?? 0).toBe(0);
      }
    }
  });

  it("split responses are contiguous parts 1..n sharing every non-array top-level key", () => {
    const groups = new Map<string, ManifestEntry[]>();
    for (const f of files.filter((x) => x.part !== null)) {
      const key = f.path.replace(/\.p\d+\.json$/, "");
      groups.set(key, [...(groups.get(key) ?? []), f]);
    }
    expect(groups.size).toBeGreaterThan(0);
    for (const [, parts] of groups) {
      parts.sort((a, b) => (a.part?.index ?? 0) - (b.part?.index ?? 0));
      expect(parts.map((p) => p.part?.index)).toEqual(parts.map((_, i) => i + 1));
      for (const p of parts) expect(p.part?.of).toBe(parts.length);
      const array = parts[0]?.part?.array ?? "";
      const rest = (b: Json) =>
        JSON.stringify(
          Object.fromEntries(Object.entries(b as JsonObject).filter(([k]) => k !== array)),
        );
      const bodies = parts.map((p) => read(p.path).body);
      for (const b of bodies) expect(rest(b)).toBe(rest(bodies[0] ?? {}));
    }
  });
});

describe("C4's inputs: playoff seeds and complete schedule results on every finished season", () => {
  it.each(served)(
    "%s %i: playoffSeed is a permutation 1..N; every row decided; the regular season complete",
    (slot, season) => {
      const base = `recorded/history/${String(season)}/${slot}`;
      const sched = (whole(`${base}/mSettings`).settings as JsonObject).scheduleSettings as {
        matchupPeriodCount: number;
      };
      const teams = whole(`${base}/mTeam`).teams as unknown as Team[];
      const rows = whole(`${base}/mMatchup`).schedule as unknown as Row[];
      expect(teams.map((t) => t.playoffSeed).sort((a, b) => a - b)).toEqual(
        teams.map((_, i) => i + 1),
      );
      expect(rows.every((r) => ["HOME", "AWAY", "TIE"].includes(r.winner))).toBe(true);
      const regular = rows.filter((r) => r.matchupPeriodId <= sched.matchupPeriodCount);
      expect(regular).toHaveLength((sched.matchupPeriodCount * teams.length) / 2);
      for (let mp = 1; mp <= sched.matchupPeriodCount; mp++) {
        const ids = regular
          .filter((r) => r.matchupPeriodId === mp)
          .flatMap((r) => [r.home?.teamId, r.away?.teamId]);
        expect(new Set(ids).size, `period ${String(mp)}`).toBe(teams.length);
      }
    },
  );

  it.each(served)(
    "%s %i: each team's record and points-for equal the regular-season results (cross-view)",
    (slot, season) => {
      const base = `recorded/history/${String(season)}/${slot}`;
      const sched = (whole(`${base}/mSettings`).settings as JsonObject).scheduleSettings as {
        matchupPeriodCount: number;
      };
      const teams = whole(`${base}/mTeam`).teams as unknown as Team[];
      const rows = (whole(`${base}/mMatchup`).schedule as unknown as Row[]).filter(
        (r) => r.matchupPeriodId <= sched.matchupPeriodCount,
      );
      for (const t of teams) {
        let pf = 0;
        let wins = 0;
        let ties = 0;
        let losses = 0;
        for (const r of rows)
          for (const side of ["home", "away"] as const) {
            const s = r[side];
            if (s?.teamId !== t.id) continue;
            pf += s.totalPoints;
            if (r.winner === "TIE") ties++;
            else if (r.winner === side.toUpperCase()) wins++;
            else losses++;
          }
        expect(pf).toBeCloseTo(t.record.overall.pointsFor, 2);
        expect([wins, losses, ties]).toEqual([
          t.record.overall.wins,
          t.record.overall.losses,
          t.record.overall.ties,
        ]);
      }
    },
  );

  it.each(served)(
    "%s %i: observed — division winners first when playoffSeedingRuleBy is -1, then win %% with points-for as the tiebreak, reproduces every playoffSeed",
    (slot, season) => {
      // A fact about the recorded data (ESPN's TOTAL_POINTS_SCORED reading (a), research 05 §2),
      // not the C4 simulator itself: it shows the inputs suffice for an exact reproduction.
      const base = `recorded/history/${String(season)}/${slot}`;
      const sched = (whole(`${base}/mSettings`).settings as JsonObject).scheduleSettings as {
        playoffSeedingRule: string;
        playoffSeedingRuleBy: number;
        divisions: unknown[];
      };
      expect(sched.playoffSeedingRule).toBe("TOTAL_POINTS_SCORED");
      const teams = whole(`${base}/mTeam`).teams as unknown as Team[];
      const key = (a: Team, b: Team) =>
        b.record.overall.percentage - a.record.overall.percentage ||
        b.record.overall.pointsFor - a.record.overall.pointsFor;
      let order: Team[];
      if (sched.playoffSeedingRuleBy === -1 && sched.divisions.length > 1) {
        const byDiv = new Map<number, Team[]>();
        for (const t of teams) byDiv.set(t.divisionId, [...(byDiv.get(t.divisionId) ?? []), t]);
        const winners = [...byDiv.values()]
          .flatMap((ts) => [...ts].sort(key).slice(0, 1))
          .sort(key);
        const ids = new Set(winners.map((t) => t.id));
        order = [...winners, ...teams.filter((t) => !ids.has(t.id)).sort(key)];
      } else order = [...teams].sort(key);
      expect(order.map((t) => t.playoffSeed)).toEqual(teams.map((_, i) => i + 1));
    },
  );
});

describe("C1's inputs: ESPN's weekly projections in the projections league's box scores", () => {
  const slot = manifest.projections.slot ?? "";
  it("league-b, the 2024 and 2025 seasons, every scoring period 1 … finalScoringPeriod", () => {
    expect(manifest.projections).toEqual({ slot: "league-b", seasons: [2024, 2025] });
    for (const season of manifest.projections.seasons) {
      const s = manifest.leagues[slot]?.seasons[String(season)];
      if (!s?.served) throw new Error(`${slot} ${String(season)} not served`);
      const final = s.final_scoring_period ?? 0;
      expect(s.box_score_weeks).toEqual(Array.from({ length: final }, (_, i) => i + 1));
      for (const w of s.box_score_weeks) {
        const e = entryOf(`recorded/history/${String(season)}/${slot}/mBoxscore.sp${String(w)}`);
        expect(e.stats_official).toBe(true);
        expect(e.scoringPeriodId).toBe(w);
        expect(e.matchupPeriodId).toBe(w);
        expect(e.request.filter).toEqual({ schedule: { filterMatchupPeriodIds: { value: [w] } } });
      }
    }
  });

  it.each(manifest.projections.seasons)(
    "%i: ≥ 95 %% of roster entries carry that week's projection (appliedTotal, appliedStats, raw stats); the count is the manifest's",
    (season) => {
      const s = manifest.leagues[slot]?.seasons[String(season)];
      if (!s?.served) throw new Error("unreachable");
      let entries = 0;
      let projections = 0;
      for (const w of s.box_score_weeks) {
        const box = whole(`recorded/history/${String(season)}/${slot}/mBoxscore.sp${String(w)}`);
        for (const r of box.schedule as unknown as Row[])
          for (const side of [r.home, r.away]) {
            for (const e of side?.rosterForCurrentScoringPeriod?.entries ?? []) {
              entries++;
              const p = e.playerPoolEntry.player.stats.filter(
                (x) => x.statSourceId === 1 && x.statSplitTypeId === 1 && x.scoringPeriodId === w,
              );
              expect(p.length).toBeLessThanOrEqual(1);
              const proj = p[0];
              if (!proj) continue;
              projections++;
              expect(proj.seasonId).toBe(season);
              expect(proj.id).toBe(`11${String(season)}${String(w)}`); // research 03 §B.5
              expect(Number.isFinite(proj.appliedTotal)).toBe(true);
              expect(typeof proj.appliedStats).toBe("object");
              expect(typeof proj.stats).toBe("object");
            }
          }
      }
      expect(projections).toBe(s.projection_entries);
      expect(projections / entries).toBeGreaterThanOrEqual(0.95);
      expect(projections).toBeGreaterThan(2000);
    },
  );

  it.each(manifest.projections.seasons)(
    "%i: starters' actual appliedTotal sums to the team's points for that period; box-score totals equal mMatchup's (cross-view)",
    (season) => {
      const s = manifest.leagues[slot]?.seasons[String(season)];
      if (!s?.served) throw new Error("unreachable");
      const matchup = whole(`recorded/history/${String(season)}/${slot}/mMatchup`)
        .schedule as unknown as Row[];
      let compared = 0;
      for (const w of s.box_score_weeks) {
        const base = `recorded/history/${String(season)}/${slot}/mBoxscore.sp${String(w)}`;
        const missing = new Set(entryOf(base).incomplete?.team_ids ?? []);
        for (const r of whole(base).schedule as unknown as Row[]) {
          const m = matchup.find((x) => x.id === r.id);
          for (const key of ["home", "away"] as const) {
            const side = r[key];
            if (!side) continue;
            expect(m?.[key]?.teamId).toBe(side.teamId);
            expect(m?.[key]?.totalPoints).toBe(side.totalPoints);
            if (missing.has(side.teamId)) continue; // a withheld entry: the sum cannot be complete
            const sum = (side.rosterForCurrentScoringPeriod?.entries ?? [])
              .filter((e) => e.lineupSlotId !== 20 && e.lineupSlotId !== 21) // BE, IR
              .reduce((acc, e) => {
                const a = e.playerPoolEntry.player.stats.find(
                  (x) => x.statSourceId === 0 && x.statSplitTypeId === 1 && x.scoringPeriodId === w,
                );
                return acc + (a?.appliedTotal ?? 0);
              }, 0);
            expect(sum).toBeCloseTo(side.pointsByScoringPeriod?.[String(w)] ?? Number.NaN, 2);
            compared++;
          }
        }
      }
      expect(compared).toBeGreaterThan(140);
    },
  );
});

describe("fixture mode serves a previous season from the history manifest", () => {
  it("2025 league-b: mSettings, a box score with its filter, the season schedule; 2026 is not here", async () => {
    const f = createFixtureFetch({ dir: ESPN, league: "league-b", manifest: HISTORY_MANIFEST_REL });
    const base =
      "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2025/segments/0/leagues/0";
    const settings = (await (await f(`${base}?view=mSettings`, {})).json()) as { seasonId: number };
    expect(settings.seasonId).toBe(2025);
    const box = await f(`${base}?view=mBoxscore&scoringPeriodId=9`, {
      headers: {
        "x-fantasy-filter": JSON.stringify({
          schedule: { filterMatchupPeriodIds: { value: [9] } },
        }),
      },
    });
    expect(box.status).toBe(200);
    const mm = (await (await f(`${base}?view=mMatchup`, {})).json()) as { schedule: unknown[] };
    expect(mm.schedule.length).toBeGreaterThan(50); // the split parts re-assembled
    const sched = await f(
      "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2025?view=proTeamSchedules_wl",
      {},
    );
    expect(sched.status).toBe(200);
    await expect(f(`${base.replace("/2025/", "/2026/")}?view=mSettings`, {})).rejects.toThrow(
      /fixture_missing/,
    );
  });
});

describe.each(files.map((f) => [f.path, f] as const))("%s", (_p, entry) => {
  const { text, body } = read(entry.path);

  it("hash, scoring provenance (ADV OBJ-01), size and byte-exact layout match the manifest", async () => {
    expect(contentSha256(body)).toBe(entry.sha256);
    expect(scoringProjection(body)).toEqual(entry.scoring);
    const bytes = statSync(path.join(ESPN, entry.path)).size;
    expect(bytes).toBe(entry.bytes);
    expect(bytes).toBeLessThanOrEqual(MAX_FIXTURE_BYTES);
    expect(await formatJson(body, "recorded")).toBe(text);
    expect(Array.isArray(body) ? [] : Object.keys(body as JsonObject).sort()).toEqual(
      entry.top_level_keys,
    );
  });

  it("carries no identifier: scanner rules clean, every GUID fake, placeholders only", () => {
    expect(scanText(entry.path, text, [])).toEqual([]);
    for (const m of text.matchAll(GUID_ANY)) expect(m[0]).toMatch(FAKE_GUID_RE);
    expect(text).not.toMatch(/"(?:notificationSettings|topics)"\s*:/);
    for (const m of text.matchAll(/"seasonOutlook"\s*:\s*"([^"]*)"/g))
      expect(m[1]).toMatch(/^\[outlook \d+ chars\]$/);
    for (const m of text.matchAll(/"logo"\s*:\s*"([^"]*)"/g)) expect(m[1]).toBe("");
    const b = body as JsonObject;
    if (entry.league) {
      if ("id" in b) expect(b.id).toBe(0);
      const ordinal = (/league-([a-e])/.exec(entry.league)?.[1] ?? "a").charCodeAt(0) - 96;
      const settings = b.settings as JsonObject | undefined;
      if (settings && "name" in settings)
        expect(settings.name).toBe(`Example League ${String(ordinal)}`);
      for (const t of (b.teams as JsonObject[] | undefined) ?? []) {
        const L = letters(t.id as number);
        if ("name" in t) expect(t.name).toBe(`Team ${L}`);
        if ("abbrev" in t) expect(t.abbrev).toBe(`T${L}`);
        for (const k of ["location", "nickname"]) if (k in t) expect(t[k]).toBe("");
      }
      for (const m of (b.members as JsonObject[] | undefined) ?? []) {
        expect(m.displayName).toMatch(/^Member \d{1,3}$/);
        for (const k of ["firstName", "lastName"]) if (k in m) expect(m[k]).toBe("");
      }
    }
  });
});

describe("helpers/history-fixtures.ts (the read API for Phase 3 tests)", () => {
  it("historyBody re-assembles a split response exactly as the manifest describes it", () => {
    const split = files.find((f) => f.part !== null && f.views[0] === "mMatchup");
    if (!split) throw new Error("no split mMatchup recorded");
    const [, , season, slot] = split.path.split("/");
    const body = historyBody(Number(season), slot ?? "", "mMatchup");
    expect(body).toEqual(whole(split.path.replace(/\.p\d+\.json$/, "")));
    expect(
      historyEntries(Number(season), slot ?? "", "mMatchup").map((e) => e.part?.index),
    ).toEqual([1, 2]);
    expect(() => historyBody(2019, "league-a", "mTeam")).toThrow(/no history fixture/);
  });

  it("servedSeasons lists each slot's served seasons ascending; historyFixtureFetch serves them", async () => {
    for (const slot of SLOTS) {
      const seasons = servedSeasons(slot).map(([s]) => s);
      expect(seasons).toEqual([...manifest.seasons]);
      const f = historyFixtureFetch(slot);
      const res = await f(
        `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${String(seasons[0])}/segments/0/leagues/0?view=mTeam&view=mStandings`,
        {},
      );
      const body = (await res.json()) as { teams: { playoffSeed: number }[] };
      expect(body.teams.length).toBeGreaterThanOrEqual(10);
    }
  });
});
