// recorded-manifest.test.ts — the COMMITTED recorded fixtures against fixtures/espn/manifest.json:
// plan 05 §3.1 step 4 (a fixture whose hash differs from the manifest fails — a hand edit is a
// deliberate, reviewed change), plan 10 §3.0 Z7 / §3.1a (≥ 3 recorded final mBoxscore weeks per
// league with its own mSettings; every scoring field hashes to the recorded original — ADV OBJ-01;
// recorded = evidence, `derived: false` — ADV OBJ-21), research 03 §F.3 step 3 (no identifier in any
// committed fixture). Hermetic: in-process scanner rules, no local deny-list, no network.
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
const read = (e: ManifestEntry): { text: string; body: Json } => {
  const text = readFileSync(path.join(ESPN, e.path), "utf8");
  return { text, body: parseJsonStrict(text) };
};
const GUID_ANY = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g;

describe("fixtures/espn/manifest.json", () => {
  it("lists exactly the files on disk under recorded/ (no orphan, no ghost)", () => {
    const onDisk = readdirSync(path.join(ESPN, "recorded"), {
      recursive: true,
      withFileTypes: true,
    })
      .filter((d) => d.isFile() && d.name.endsWith(".json"))
      .map((d) => path.relative(ESPN, path.join(d.parentPath, d.name)).split(path.sep).join("/"))
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
        /^\/apis\/v3\/games\/ffl\/seasons\/\d{4}(?:\/segments\/0\/leagues\/0)?$/,
      );
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
      let whole: Json;
      if (e.part === null) whole = read(e).body;
      else {
        const base = e.path.replace(/\.p\d+\.json$/, "");
        const parts = files
          .filter((f) => f.part !== null && f.path.replace(/\.p\d+\.json$/, "") === base)
          .sort((a, b) => (a.part?.index ?? 0) - (b.part?.index ?? 0));
        const bodies = parts.map((p) => read(p).body as JsonObject);
        const array = e.part.array;
        whole = {
          ...bodies[0],
          [array]: bodies.flatMap((b) => (b[array] as Json[] | undefined) ?? []),
        };
      }
      expect(e.incomplete, e.path).toEqual(deriveIncomplete(whole, e.withheld));
      expect(e.incomplete === null, e.path).toBe(e.withheld.length === 0);
      for (const r of e.replaced) expect(r).toMatch(/\.player\.(?:fullName|firstName|lastName)$/);
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
      const bodies = parts.map((p) => read(p).body as JsonObject);
      const rest = (b: JsonObject) =>
        JSON.stringify(Object.fromEntries(Object.entries(b).filter(([k]) => k !== array)));
      for (const b of bodies) expect(rest(b)).toBe(rest(bodies[0] ?? {}));
    }
  });
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
    expect(Object.keys(body as JsonObject).sort()).toEqual(entry.top_level_keys);
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
