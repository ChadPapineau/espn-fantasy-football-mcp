// phase2-loaders.ts — a test-side REFERENCE loader for the Phase-2 dataset contract
// (src/store/datasets/tables.ts, the Phase-2 section; plan 01 §5.5; plan 10 §3.2): one function per
// table mapping an upstream row, exactly as the contract's `derivation` fields describe, to a
// DatasetRow (or null when the row is invalid). The sources layer owns the production loaders; this
// one exists so the tests (and the 2026-10-06 grounding run over the real release files) load
// contract-shaped rows without guessing. Every input is untrusted data: nothing here interprets text.
import {
  NEWS_STORAGE_CAPS,
  SLEEPER_TRENDING_REQUEST,
  type Phase2TableContract,
} from "../../../src/store/datasets/tables.js";
import {
  capText,
  depthChartRuns,
  depthLabel,
  depthSnapshotMs,
  emptyToNull,
  finiteOrNull,
  flag01,
  fraction01,
  goalLineFlag,
  httpUrlOrNull,
  isKeptPlayType,
  jerseyNumber,
  legacyDepthRank,
  newsItemId,
  nonNegativeDecimal,
  nonNegativeInt,
  parseDecimalId,
  redZoneFlag,
  rssDateMs,
  seasonFromText,
  sleeperPlayerId,
  wholeNumber,
  type DepthRun,
  type DepthSnapshotRow,
  type NewsSource,
} from "../../../src/store/datasets/derive.js";
import type { DatasetRow } from "../../../src/store/types.js";

type Raw = Readonly<Record<string, unknown>>;
type Out = Record<string, string | number | null>;

/** Applies the type conventions to a verbatim column: TEXT → emptyToNull, REAL → finiteOrNull. */
function verbatim(spec: Phase2TableContract, raw: Raw, out: Out): void {
  for (const c of spec.columns) {
    if (c.derivation !== null || c.name in out) continue;
    const v = raw[c.from[0] ?? c.name];
    if (c.type === "TEXT") out[c.name] = emptyToNull(v);
    else if (c.type === "REAL") out[c.name] = finiteOrNull(v);
    else
      out[c.name] =
        typeof v === "bigint" ? Number(v) : Number.isSafeInteger(v) ? (v as number) : null;
  }
}

/** Null when a NOT NULL column of the spec is null (the contract's "the row is invalid"). */
function valid(spec: Phase2TableContract, out: Out): DatasetRow | null {
  for (const c of spec.columns) {
    if (!(c.name in out)) out[c.name] = null;
    if (!c.nullable && out[c.name] === null) return null;
  }
  return out;
}

/** `ds_stats_team_week` from a stats_team_week parquet row. */
export function statsTeamWeekRow(spec: Phase2TableContract, raw: Raw): DatasetRow | null {
  const out: Out = {};
  verbatim(spec, raw, out);
  return valid(spec, out);
}

function applyNumeric(spec: Phase2TableContract, raw: Raw, out: Out): void {
  for (const c of spec.columns) {
    const d = c.derivation ?? "";
    const v = raw[c.from[0] ?? c.name];
    if (d.startsWith("wholeNumber(")) out[c.name] = wholeNumber(v);
    else if (d.startsWith("flag01(")) out[c.name] = flag01(v);
    else if (d.startsWith("fraction01(")) out[c.name] = fraction01(v);
  }
}

/** `ds_pbp` from a play_by_play parquet row; null for a dropped play type or an invalid row. */
export function pbpRow(spec: Phase2TableContract, raw: Raw): DatasetRow | null {
  if (!isKeptPlayType(raw.play_type)) return null;
  const out: Out = {};
  applyNumeric(spec, raw, out);
  out.rz = redZoneFlag(raw.yardline_100);
  out.gl = goalLineFlag(raw.yardline_100);
  verbatim(spec, raw, out);
  return valid(spec, out);
}

/** `ds_snap_counts` from a snap_counts parquet row (the player name is not kept). */
export function snapRow(spec: Phase2TableContract, raw: Raw): DatasetRow | null {
  const out: Out = {};
  applyNumeric(spec, raw, out);
  verbatim(spec, raw, out);
  return valid(spec, out);
}

/** One validated depth snapshot row from a 2025+ depth_charts parquet row; null when invalid. */
export function depthSnapshot(raw: Raw): DepthSnapshotRow | null {
  const team = emptyToNull(raw.team);
  const espn = parseDecimalId(raw.espn_id);
  const grpId = nonNegativeDecimal(raw.pos_grp_id);
  const grp = depthLabel(raw.pos_grp);
  const posId = nonNegativeDecimal(raw.pos_id);
  const abb = depthLabel(raw.pos_abb);
  const slot = wholeNumber(raw.pos_slot);
  const rank = wholeNumber(raw.pos_rank);
  const dt = depthSnapshotMs(raw.dt);
  if (
    team === null ||
    espn === null ||
    grpId === null ||
    grp === null ||
    posId === null ||
    abb === null ||
    slot === null ||
    rank === null ||
    dt === null
  )
    return null;
  return {
    team,
    espn_id: espn,
    gsis_id: emptyToNull(raw.gsis_id),
    player_name: capText(raw.player_name, 256),
    pos_grp_id: grpId,
    pos_grp: grp,
    pos_id: posId,
    pos_abb: abb,
    pos_slot: slot,
    pos_rank: rank,
    dt_ms: dt,
  };
}

/** `ds_depth_charts` rows of one season file (snapshots → runs). */
export function depthRows(
  season: number,
  raws: Iterable<Raw>,
): { rows: DatasetRow[]; invalid: number; duplicates: number } {
  const snaps: DepthSnapshotRow[] = [];
  let invalid = 0;
  for (const r of raws) {
    const s = depthSnapshot(r);
    if (s === null) invalid++;
    else snaps.push(s);
  }
  const { runs, duplicates } = depthChartRuns(snaps);
  return { rows: runs.map((run: DepthRun) => ({ season, ...run })), invalid, duplicates };
}

/** `ds_depth_charts_legacy` from a ≤ 2024 depth_charts parquet row; null when invalid. */
export function legacyDepthRow(spec: Phase2TableContract, raw: Raw): DatasetRow | null {
  const week = wholeNumber(raw.week);
  const out: Out = {
    season: wholeNumber(raw.season),
    week,
    game_type: emptyToNull(raw.game_type),
    team: emptyToNull(raw.club_code),
    gsis_id: emptyToNull(raw.gsis_id),
    full_name: capText(raw.full_name, 256),
    position: emptyToNull(raw.position),
    formation: depthLabel(raw.formation),
    pos_abb: depthLabel(emptyToNull(raw.depth_position) ?? raw.position),
    depth_team: legacyDepthRank(raw.depth_team),
    jersey_number: jerseyNumber(raw.jersey_number),
  };
  return valid(spec, out);
}

/** `ds_ep_weekly` from an ffopportunity ep_weekly parquet row; null for an unattributed row. */
export function epWeeklyRow(spec: Phase2TableContract, raw: Raw): DatasetRow | null {
  const out: Out = { season: seasonFromText(raw.season), week: wholeNumber(raw.week) };
  verbatim(spec, raw, out);
  return valid(spec, out);
}

/** `ds_trending` rows of one Sleeper trending response (`kind` from the request path). */
export function trendingRows(kind: "add" | "drop", body: unknown, asOfIso: string): DatasetRow[] {
  if (!Array.isArray(body)) return [];
  const seen = new Set<string>();
  const out: DatasetRow[] = [];
  body.forEach((e: unknown, i: number) => {
    if (e === null || typeof e !== "object") return;
    const o = e as Raw;
    const id = sleeperPlayerId(o.player_id);
    const count = nonNegativeInt(o.count);
    if (id === null || count === null || seen.has(id)) return;
    seen.add(id);
    out.push({
      kind,
      sleeper_id: id,
      rank: i + 1,
      count,
      lookback_hours: SLEEPER_TRENDING_REQUEST.lookback_hours,
      as_of: asOfIso,
    });
  });
  return out;
}

/** One parsed RSS item (the XML parser's job; strings as found). */
export interface RssItem {
  readonly title?: unknown;
  readonly link?: unknown;
  readonly guid?: unknown;
  readonly pubDate?: unknown;
  readonly description?: unknown;
}

/** `ds_news` from one RSS item; null when invalid. */
export function newsRow(source: NewsSource, item: RssItem, firstSeenMs: number): DatasetRow | null {
  const id = newsItemId(source, item.guid, item.link);
  const published = rssDateMs(item.pubDate);
  const title = capText(item.title, NEWS_STORAGE_CAPS.title);
  if (id === null || published === null || title === null) return null;
  return {
    item_id: id,
    source,
    published_ms: published,
    first_seen_ms: firstSeenMs,
    title,
    blurb: capText(item.description, NEWS_STORAGE_CAPS.blurb),
    link: httpUrlOrNull(item.link),
  };
}
