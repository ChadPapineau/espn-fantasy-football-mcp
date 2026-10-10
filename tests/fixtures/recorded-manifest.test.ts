// recorded-manifest.test.ts — the COMMITTED recorded fixtures against fixtures/espn/manifest.json:
// plan 05 §3.1 step 4 (a fixture whose hash differs from the manifest fails — a hand edit is a
// deliberate, reviewed change), plan 10 §3.0 Z7 / §3.1a (≥ 3 recorded final mBoxscore weeks per
// league with its own mSettings; every scoring field hashes to the recorded original — ADV OBJ-01;
// recorded = evidence, `derived: false` — ADV OBJ-21), research 03 §F.3 step 3 (no identifier in any
// committed fixture), the B1 views (plan 05 §3.1; plan 07 A4/B2/C1) and their cross-view agreement
// (mMatchupScore = mBoxscore totals; kona_playercard weekly actuals = mBoxscore lines), and the
// synthetic error bodies (fixture law: error bodies only). Hermetic: in-process scanner rules, no
// local deny-list, no network.
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
import { leagueFormat } from "../../scripts/espn-fixture/league-format.js";
import {
  KEEP_HEADERS,
  MAX_FIXTURE_BYTES,
  deriveIncomplete,
  type FixtureManifest,
  type ManifestEntry,
} from "../../scripts/espn-fixture/pipeline.js";
import {
  FAKE_GUID_RE,
  SCRUB_RULES_VERSION,
  letters,
  scoringProjection,
} from "../../scripts/espn-fixture/scrub.js";
import { ROOT } from "../lint/helpers.js";

const ESPN = path.join(ROOT, "fixtures", "espn");
const manifest = JSON.parse(
  readFileSync(path.join(ESPN, "manifest.json"), "utf8"),
) as FixtureManifest;
const files = manifest.files;
const read = (e: { path: string }): { text: string; body: Json } => {
  const text = readFileSync(path.join(ESPN, e.path), "utf8");
  return { text, body: parseJsonStrict(text) };
};
const keysOf = (b: Json): string[] => (Array.isArray(b) ? [] : Object.keys(b as JsonObject).sort());
/** The whole response of an entry: a split one re-assembled from its parts in index order. */
function wholeBody(e: ManifestEntry): Json {
  if (e.part === null) return read(e).body;
  const base = e.path.replace(/\.p\d+\.json$/, "");
  const parts = files
    .filter((f) => f.part !== null && f.path.replace(/\.p\d+\.json$/, "") === base)
    .sort((a, b) => (a.part?.index ?? 0) - (b.part?.index ?? 0));
  const bodies = parts.map((p) => read(p).body);
  const array = e.part.array;
  if (array === "$") return bodies.flatMap((b) => (Array.isArray(b) ? b : []));
  const objs = bodies as JsonObject[];
  return { ...objs[0], [array]: objs.flatMap((b) => (b[array] as Json[] | undefined) ?? []) };
}
const entryAt = (p: string): ManifestEntry => {
  const e = files.find((f) => f.path === p);
  if (!e) throw new Error(`no manifest entry ${p}`);
  return e;
};
const LEAGUES = Object.keys(manifest.leagues).sort();
const GUID_ANY = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g;

describe("fixtures/espn/manifest.json", () => {
  it("lists exactly the files on disk under recorded/ (no orphan, no ghost)", () => {
    // recorded/history/ (previous seasons) has its own manifest: tests/fixtures/history-manifest.test.ts
    const onDisk = readdirSync(path.join(ESPN, "recorded"), {
      recursive: true,
      withFileTypes: true,
    })
      .filter((d) => d.isFile() && d.name.endsWith(".json"))
      .map((d) => path.relative(ESPN, path.join(d.parentPath, d.name)).split(path.sep).join("/"))
      .filter((p) => !p.startsWith("recorded/history/"))
      .sort();
    expect(files.map((f) => f.path).sort()).toEqual(onDisk);
    expect(manifest.withheld_files).toEqual([]);
  });

  it("is recorded evidence: read host, one season, current scrub rules, never derived", () => {
    expect(manifest.version).toBe(1);
    expect(manifest.host).toBe("lm-api-reads.fantasy.espn.com");
    expect(manifest.scrub_rules_version).toBe(SCRUB_RULES_VERSION);
    for (const f of files) {
      expect(f.derived).toBe(false);
      expect(f.scrub_rules_version).toBe(SCRUB_RULES_VERSION);
      expect(f.path.startsWith("recorded/")).toBe(true);
      expect(f.request.path).toMatch(
        /^\/apis\/v3\/games\/ffl\/seasons\/\d{4}(?:\/players|\/segments\/0\/leagues\/0(?:\/communication\/)?)?$/,
      );
      // the route names the path (research 03 §A.1): league, season, players, communication
      expect(f.request.path.endsWith("/players")).toBe(f.request.route === "players");
      expect(f.request.path.endsWith("/communication/")).toBe(f.request.route === "communication");
      expect(f.request.path).toContain(`/seasons/${String(manifest.season)}`);
      for (const h of Object.keys(f.headers))
        expect(KEEP_HEADERS as readonly string[]).toContain(h);
      for (const w of f.withheld) expect(w).toMatch(/^\$(?:\.[A-Za-z_]\w*|\[\d+\])+$/);
      for (const p of f.pruned) expect(p).toMatch(/^[A-Za-z_]\w*$/);
    }
  });

  it("each league: its own mSettings, ≥ 3 final (statsOfficial) mBoxscore weeks, the three probe formats", () => {
    const leagues = Object.entries(manifest.leagues);
    expect(leagues).toHaveLength(3);
    for (const [slot, l] of leagues) {
      expect(files.some((f) => f.path === `recorded/${slot}/mSettings.json`)).toBe(true);
      expect(l.final_boxscore_weeks.length).toBeGreaterThanOrEqual(3);
      for (const w of l.final_boxscore_weeks) {
        const box = files.filter(
          (f) => f.league === slot && f.views[0] === "mBoxscore" && f.scoringPeriodId === w,
        );
        expect(box.length).toBeGreaterThan(0);
        for (const b of box) {
          expect(b.stats_official).toBe(true);
          expect(b.matchupPeriodId).toBe(w);
        }
      }
    }
    const formats = leagues.map(([, l]) => l.format);
    // D2 (HANDOFF 2026-10-05): one 10-team half-PPR FAAB, one 12-team 6-pt-pass-TD rolling, one 10-team five-FLEX
    expect(formats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ teams: 10, reception_points: 0.5, waivers: "faab" }),
        expect.objectContaining({ teams: 12, pass_td_points: 6, waivers: "rolling" }),
        expect.objectContaining({ teams: 10, flex_slots: 5 }),
      ]),
    );
  });

  it("the format summary re-derives from each committed mSettings", () => {
    for (const [slot, l] of Object.entries(manifest.leagues)) {
      const e = files.find((f) => f.path === `recorded/${slot}/mSettings.json`);
      if (!e) throw new Error(`no mSettings for ${slot}`);
      expect(leagueFormat(read(e).body)).toEqual(l.format);
      for (const f of files.filter((x) => x.league === slot)) expect(f.format).toEqual(l.format);
    }
  });

  it("CAT-12: `incomplete` re-derives from the committed bodies and the withheld paths", () => {
    for (const e of files) {
      expect(e.incomplete, e.path).toEqual(deriveIncomplete(wholeBody(e), e.withheld));
      expect(e.incomplete === null, e.path).toBe(e.withheld.length === 0);
      for (const r of e.replaced)
        expect(r).toMatch(/(?:\.player|^\$\[\d+\])\.(?:fullName|firstName|lastName)$/);
      // a replaced leaf never sits inside a withheld unit (it would be gone, not replaced)
      for (const r of e.replaced)
        for (const w of e.withheld)
          expect(r === w || r.startsWith(`${w}.`) || r.startsWith(`${w}[`)).toBe(false);
    }
    // the artefacts are visible: some box-score weeks are missing a matchup, some rosters an entry
    expect(files.some((f) => (f.incomplete?.matchups_missing ?? 0) > 0)).toBe(true);
    expect(files.some((f) => (f.incomplete?.team_ids.length ?? 0) > 0)).toBe(true);
  });

  it("split responses are contiguous parts 1..n sharing every non-array top-level key", () => {
    const groups = new Map<string, ManifestEntry[]>();
    for (const f of files.filter((x) => x.part !== null)) {
      const key = f.path.replace(/\.p\d+\.json$/, "");
      groups.set(key, [...(groups.get(key) ?? []), f]);
    }
    for (const [, parts] of groups) {
      parts.sort((a, b) => (a.part?.index ?? 0) - (b.part?.index ?? 0));
      expect(parts.map((p) => p.part?.index)).toEqual(parts.map((_, i) => i + 1));
      for (const p of parts) expect(p.part?.of).toBe(parts.length);
      const array = parts[0]?.part?.array ?? "";
      const bodies = parts.map((p) => read(p).body);
      if (array === "$") {
        for (const b of bodies) expect(Array.isArray(b)).toBe(true);
      } else {
        const rest = (b: Json) =>
          JSON.stringify(
            Object.fromEntries(Object.entries(b as JsonObject).filter(([k]) => k !== array)),
          );
        for (const b of bodies) expect(rest(b)).toBe(rest(bodies[0] ?? {}));
      }
      // each part's id_range is its first and last element id (canonical order: by id)
      parts.forEach((p, i) => {
        const items = (
          array === "$" ? bodies[i] : (bodies[i] as JsonObject)[array]
        ) as JsonObject[];
        if (p.part?.id_range)
          expect(p.part.id_range).toEqual({
            first: items[0]?.id,
            last: items[items.length - 1]?.id,
          });
      });
    }
  });
});

describe("the B1 views (plan 05 §3.1; plan 07 A4, B2, C1)", () => {
  it("every league has mMatchupScore for its current week and its last final box-score week", () => {
    for (const slot of LEAGUES) {
      const settings = read(entryAt(`recorded/${slot}/mSettings.json`)).body as JsonObject;
      const status = settings.status as JsonObject;
      const finalWeek = Math.max(...(manifest.leagues[slot]?.final_boxscore_weeks ?? []));
      const score = files.filter((f) => f.league === slot && f.views[0] === "mMatchupScore");
      expect(score.map((f) => f.scoringPeriodId).sort()).toEqual(
        [finalWeek, status.latestScoringPeriod as number].sort(),
      );
      for (const f of score) {
        expect(f.views).toEqual(["mMatchupScore"]);
        expect(f.request.filter).toBeNull(); // as the live scoreboard asks (plan 07 A4)
        const body = read(f).body as JsonObject;
        const rows = body.schedule as JsonObject[];
        expect(rows.every((r) => typeof r.playoffTierType === "string")).toBe(true);
        // the league's CURRENT period carries the live fields whatever period was asked for;
        // the requested period's rows carry its roster lines (research 03 §B.4 — observed here:
        // a past week has rosterForCurrentScoringPeriod and totalProjectedPoints, never the live set)
        const current = status.currentMatchupPeriod as number;
        for (const r of rows.filter((x) => x.matchupPeriodId === current)) {
          const home = r.home as JsonObject;
          for (const k of ["totalPointsLive", "totalProjectedPointsLive", "winProbability"])
            expect(typeof home[k], `${f.path} ${k}`).toBe("number");
        }
        const asked = rows.filter((r) => r.matchupPeriodId === f.scoringPeriodId);
        expect(asked.length).toBeGreaterThan(0);
        for (const r of asked) {
          const home = r.home as JsonObject;
          expect(Array.isArray((home.rosterForCurrentScoringPeriod as JsonObject).entries)).toBe(
            true,
          );
          if (f.scoringPeriodId !== current) expect(home).not.toHaveProperty("totalPointsLive");
        }
      }
      expect(
        entryAt(`recorded/${slot}/mMatchupScore.sp${String(finalWeek)}.json`).stats_official,
      ).toBe(true);
    }
  });

  it("solo mNav: every member carries both commissioner flags; exactly one creator", () => {
    for (const slot of LEAGUES) {
      const e = entryAt(`recorded/${slot}/mNav.json`);
      expect(e.views).toEqual(["mNav"]);
      const members = (read(e).body as JsonObject).members as JsonObject[];
      expect(members.length).toBeGreaterThan(0);
      for (const m of members) {
        expect(typeof m.isLeagueCreator).toBe("boolean");
        expect(typeof m.isLeagueManager).toBe("boolean");
      }
      expect(members.filter((m) => m.isLeagueCreator === true)).toHaveLength(1);
    }
  });

  it("the filterIds captures return exactly the ≤ 25 requested ids, incl. rostered players", () => {
    for (const slot of LEAGUES) {
      for (const name of ["kona_player_info.ids", "kona_playercard"]) {
        const e = entryAt(`recorded/${slot}/${name}.json`);
        const want = ((e.request.filter as JsonObject).players as JsonObject).filterIds as {
          value: number[];
        };
        expect(want.value.length).toBeGreaterThan(0);
        expect(want.value.length).toBeLessThanOrEqual(25);
        const got = ((read(e).body as JsonObject).players as JsonObject[]).map((p) => p.id);
        expect([...got].sort((a, b) => (a as number) - (b as number))).toEqual(want.value);
        expect(e.headers["x-fantasy-filter-player-count"]).toBe(String(want.value.length));
        expect(e.pruned).toEqual([]); // the player shape is kept whole
      }
      const players = (
        read(entryAt(`recorded/${slot}/kona_player_info.ids.json`)).body as JsonObject
      ).players as JsonObject[];
      expect(players.filter((p) => p.status === "ONTEAM").length).toBeGreaterThan(10);
      expect(players.some((p) => p.status !== "ONTEAM")).toBe(true);
    }
  });

  it("players_wl: the season index as a root array in id order; the count header accounts for every row", () => {
    const e = entryAt("recorded/season/players_wl.json");
    expect(e.request).toMatchObject({
      route: "players",
      filter: { filterActive: { value: true } },
    });
    const rows = wholeBody(e) as JsonObject[];
    expect(Array.isArray(rows)).toBe(true);
    const ids = rows.map((r) => r.id as number);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
    expect(rows.length + (e.incomplete?.rows_missing ?? 0)).toBe(
      Number(e.headers["x-fantasy-filter-player-count"]),
    );
    for (const r of rows.slice(0, 50))
      for (const k of ["defaultPositionId", "eligibleSlots", "fullName", "id", "proTeamId"])
        expect(r, k).toHaveProperty(k);
    for (const f of files.filter((x) => x.path.startsWith("recorded/season/players_wl")))
      expect(f.bytes).toBeLessThanOrEqual(MAX_FIXTURE_BYTES);
  });

  it("the keyless 401 is recorded with ESPN's typed envelope; the private-league 401 is synthetic", () => {
    const e = entryAt("recorded/errors/401-communication-not-visible.json");
    expect(e.status).toBe(401);
    expect(e.request.route).toBe("communication");
    const body = read(e).body as { details: { type: string }[]; messages: string[] };
    expect(body.details.map((d) => d.type)).toEqual(["AUTH_COMMUNICATION_NOT_VISIBLE"]);
    expect(Object.keys(body).sort()).toEqual(["details", "messages"]);
  });
});

describe("cross-view agreement of the recorded evidence", () => {
  it("mMatchupScore team totals equal the box score's for the same final week (every recorded row)", () => {
    for (const slot of LEAGUES) {
      const w = Math.max(...(manifest.leagues[slot]?.final_boxscore_weeks ?? []));
      const score = read(entryAt(`recorded/${slot}/mMatchupScore.sp${String(w)}.json`))
        .body as JsonObject;
      const box = read(entryAt(`recorded/${slot}/mBoxscore.sp${String(w)}.json`))
        .body as JsonObject;
      const rows = box.schedule as JsonObject[];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const m = (score.schedule as JsonObject[]).find((r) => r.id === row.id);
        expect(m, `${slot} row ${JSON.stringify(row.id)}`).toBeDefined();
        for (const side of ["home", "away"]) {
          const b = row[side] as JsonObject | undefined;
          if (!b) continue;
          const s = m?.[side] as JsonObject;
          expect(s.teamId).toBe(b.teamId);
          expect(s.totalPoints).toBe(b.totalPoints);
        }
      }
    }
  });

  it("kona_playercard weekly actuals equal the box-score lines of the same player-weeks (B2 evidence)", () => {
    for (const slot of LEAGUES) {
      const card = (read(entryAt(`recorded/${slot}/kona_playercard.json`)).body as JsonObject)
        .players as JsonObject[];
      let compared = 0;
      for (const w of manifest.leagues[slot]?.final_boxscore_weeks ?? []) {
        const box = read(entryAt(`recorded/${slot}/mBoxscore.sp${String(w)}.json`))
          .body as JsonObject;
        const lines = new Map<number, JsonObject>();
        for (const row of box.schedule as JsonObject[])
          for (const side of ["home", "away"]) {
            const roster = (row[side] as JsonObject | undefined)?.rosterForCurrentScoringPeriod as
              JsonObject | undefined;
            for (const e of (roster?.entries as JsonObject[] | undefined) ?? []) {
              const stats = ((e.playerPoolEntry as JsonObject).player as JsonObject)
                .stats as JsonObject[];
              const actual = stats.find(
                (x) => x.statSourceId === 0 && x.statSplitTypeId === 1 && x.scoringPeriodId === w,
              );
              if (actual) lines.set(e.playerId as number, actual);
            }
          }
        for (const p of card) {
          const actual = ((p.player as JsonObject).stats as JsonObject[]).find(
            (x) =>
              x.statSourceId === 0 &&
              x.statSplitTypeId === 1 &&
              x.scoringPeriodId === w &&
              x.seasonId === manifest.season,
          );
          const line = lines.get(p.id as number);
          if (!actual || !line) continue;
          compared++;
          expect(actual.id).toBe(line.id);
          expect(actual.appliedTotal).toBe(line.appliedTotal);
          expect(actual.appliedStats).toEqual(line.appliedStats);
          expect(actual.stats).toEqual(line.stats);
        }
      }
      expect(compared, slot).toBeGreaterThan(20);
    }
  });
});

describe("synthetic error bodies (fixture law: error bodies only, never evidence)", () => {
  const synthetic = manifest.synthetic_files ?? [];
  it("lists exactly the files on disk under synthetic/, apart from recorded/", () => {
    const onDisk = readdirSync(path.join(ESPN, "synthetic"), {
      recursive: true,
      withFileTypes: true,
    })
      .filter((d) => d.isFile() && d.name.endsWith(".json"))
      .map((d) => path.relative(ESPN, path.join(d.parentPath, d.name)).split(path.sep).join("/"))
      .sort();
    expect(synthetic.map((s) => s.path).sort()).toEqual(onDisk);
    expect(onDisk.length).toBeGreaterThan(0);
    for (const s of synthetic) expect(files.some((f) => f.path === s.path)).toBe(false);
  });
  it.each(synthetic.map((s) => [s.path, s] as const))(
    "%s: error-only, hashed, no scoring field, clean",
    async (_p, s) => {
      const { text, body } = read(s);
      expect(s.synthetic).toBe(true);
      expect(s.kind).toBe("error");
      expect(s.status).toBeGreaterThanOrEqual(400);
      expect(s.path.startsWith("synthetic/errors/")).toBe(true);
      expect(s.basis).toMatch(/research 03/);
      expect(contentSha256(body)).toBe(s.sha256);
      expect(scoringProjection(body)).toEqual(s.scoring);
      expect(s.scoring.entries).toBe(0);
      expect(keysOf(body)).toEqual(s.top_level_keys);
      expect(s.top_level_keys).toEqual(["details", "messages"]);
      expect(statSync(path.join(ESPN, s.path)).size).toBe(s.bytes);
      expect(await formatJson(body)).toBe(text);
      expect(scanText(s.path, text, [])).toEqual([]);
    },
  );
});

describe.each(files.map((f) => [f.path, f] as const))("%s", (_p, entry) => {
  const { text, body } = read(entry);

  it("hash, scoring provenance (ADV OBJ-01), size and byte-exact layout match the manifest", async () => {
    expect(contentSha256(body)).toBe(entry.sha256);
    expect(scoringProjection(body)).toEqual(entry.scoring);
    const bytes = statSync(path.join(ESPN, entry.path)).size;
    expect(bytes).toBe(entry.bytes);
    expect(bytes).toBeLessThanOrEqual(MAX_FIXTURE_BYTES);
    expect(await formatJson(body, "recorded")).toBe(text); // exactly what the scrubber writes
    expect(keysOf(body)).toEqual(entry.top_level_keys);
  });

  it("carries no identifier: scanner rules clean, every GUID fake, placeholders only", () => {
    expect(scanText(entry.path, text, [])).toEqual([]);
    for (const m of text.matchAll(GUID_ANY)) expect(m[0]).toMatch(FAKE_GUID_RE);
    expect(text).not.toMatch(/"(?:notificationSettings|topics)"\s*:/);
    for (const m of text.matchAll(/"(?:seasonOutlook)"\s*:\s*"([^"]*)"/g))
      expect(m[1]).toMatch(/^\[outlook \d+ chars\]$/);
    for (const m of text.matchAll(/"logo"\s*:\s*"([^"]*)"/g)) expect(m[1]).toBe("");
    for (const m of text.matchAll(/"clientAddress"\s*:\s*"([^"]*)"/g)) expect(m[1]).toBe("0.0.0.0");
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

  if (entry.views[0] === "mBoxscore") {
    it("is usable by the golden: rostered player-weeks with appliedStats, appliedTotal, raw stats and slots", () => {
      let entries = 0;
      let actual = 0;
      for (const row of ((body as JsonObject).schedule as JsonObject[] | undefined) ?? []) {
        for (const side of ["home", "away"]) {
          const s = row[side] as JsonObject | undefined;
          const roster = s?.rosterForCurrentScoringPeriod as JsonObject | undefined;
          for (const e of (roster?.entries as JsonObject[] | undefined) ?? []) {
            entries++;
            expect(typeof e.lineupSlotId).toBe("number");
            const player = (e.playerPoolEntry as JsonObject).player as JsonObject;
            expect(typeof player.defaultPositionId).toBe("number");
            expect(Array.isArray(player.eligibleSlots)).toBe(true);
            for (const st of (player.stats as JsonObject[] | undefined) ?? []) {
              if (st.statSourceId === 0 && st.scoringPeriodId === entry.scoringPeriodId) {
                actual++;
                expect(typeof st.appliedTotal).toBe("number");
                expect(typeof st.appliedStats).toBe("object");
                expect(typeof st.stats).toBe("object");
              }
            }
          }
        }
      }
      expect(entries).toBeGreaterThan(30);
      expect(actual).toBeGreaterThan(20);
    });
  }
});
