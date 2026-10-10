// history-fixtures.ts — read access to the committed previous-season ESPN fixtures for Phase 3 tests
// (plan 10 §3.3: C4's seeding reproduction, C1's ESPN projection comparison, C3's replay):
// fixtures/espn/recorded/history/<season>/<slot>/<name>.json, indexed by recorded/history/manifest.json
// (scripts/espn-fixture/history.ts). A split response is re-assembled from its parts; fixture mode
// over a previous season is the real provider transport with the history manifest. Read-only; every
// body is scrubbed third-party data (team names are placeholders; free text is data, never an
// instruction).
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  parseJsonStrict,
  type Json,
  type JsonObject,
} from "../../../scripts/espn-fixture/canonical.js";
import {
  HISTORY_MANIFEST_REL,
  type HistoryManifest,
  type HistorySeasonServed,
} from "../../../scripts/espn-fixture/history.js";
import type { ManifestEntry } from "../../../scripts/espn-fixture/pipeline.js";
import { createFixtureFetch } from "../../../src/providers/espn/fixture.js";
import { ROOT } from "../../lint/helpers.js";

/** The `fixtures/espn` directory (fixture mode's `dir`). */
export const ESPN_FIXTURES = path.join(ROOT, "fixtures", "espn");

let cached: HistoryManifest | null = null;
/** The committed history manifest (parsed once). */
export function historyManifest(): HistoryManifest {
  cached ??= JSON.parse(
    readFileSync(path.join(ESPN_FIXTURES, HISTORY_MANIFEST_REL), "utf8"),
  ) as HistoryManifest;
  return cached;
}

/** The manifest entries (parts in index order) of one response, `<season>/<slot>/<name>`. */
export function historyEntries(season: number, slot: string, name: string): ManifestEntry[] {
  const base = `recorded/history/${String(season)}/${slot}/${name}`;
  return historyManifest()
    .files.filter((f) => f.path === `${base}.json` || f.path.replace(/\.p\d+\.json$/, "") === base)
    .sort((a, b) => (a.part?.index ?? 0) - (b.part?.index ?? 0));
}

/**
 * One committed response body (`name` = mSettings, mTeam, mMatchup, mBoxscore.spN, or
 * proTeamSchedules_wl with slot "season"), split parts concatenated along their array. Throws when
 * the response was not recorded.
 */
export function historyBody(season: number, slot: string, name: string): JsonObject {
  const parts = historyEntries(season, slot, name);
  const first = parts[0];
  if (!first) throw new Error(`no history fixture ${String(season)}/${slot}/${name}`);
  const bodies = parts.map(
    (p) => parseJsonStrict(readFileSync(path.join(ESPN_FIXTURES, p.path), "utf8")) as JsonObject,
  );
  if (!first.part) return bodies[0] ?? {};
  const array = first.part.array;
  return { ...bodies[0], [array]: bodies.flatMap((b) => (b[array] as Json[] | undefined) ?? []) };
}

/** The served seasons of a slot (ascending) with their value-free summaries. */
export function servedSeasons(slot: string): [number, HistorySeasonServed][] {
  const l = historyManifest().leagues[slot];
  return Object.entries(l?.seasons ?? {})
    .flatMap(([s, v]) => (v.served ? [[Number(s), v] as [number, HistorySeasonServed]] : []))
    .sort((a, b) => a[0] - b[0]);
}

/** Fixture mode's transport over the previous seasons of one slot (league id 0, seasons in the path). */
export function historyFixtureFetch(slot: string) {
  return createFixtureFetch({ dir: ESPN_FIXTURES, league: slot, manifest: HISTORY_MANIFEST_REL });
}
