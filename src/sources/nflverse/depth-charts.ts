// depth-charts.ts — `nflverse:depth_charts` (ESPN-keyed) and its history twin (plan 10 §3.2 sources;
// plan 01 §5.2 depth charts — "joins on espn_id directly"; plan 06 §1.3 `refresh nflverse:daily`;
// research 04 §A #7; tables.ts DS_DEPTH_CHARTS / DS_DEPTH_CHARTS_LEGACY):
// `depth_charts/depth_charts_{season}.parquet` in TWO layouts (observed 2026-10-06):
//   * 2025+ (DEPTH_CHARTS_SNAPSHOT_SCHEMA_FROM): one full snapshot of all 32 teams per day (`dt`),
//     no season/week column, ~600 k rows a season → `ds_depth_charts` as occupancy RUNS
//     (derive.ts `depthChartRuns`: an occupant's unbroken stay in a slot; 2026: 613,196 rows → 12,046
//     runs), so the chart as of any instant is one range predicate and the current chart is
//     `valid_to_ms IS NULL`;
//   * ≤ 2024 (the history file only): weekly, gsis-keyed → `ds_depth_charts_legacy`; `SBBYE` rows
//     (no week) dropped, exact duplicates collapse, two DIFFERENT rows under one key fail the publish.
// Labels (`pos_grp`, `pos_abb`, `formation`) are held to the closed vocabulary DEPTH_LABELS: readers
// emit them unwrapped, so a well-formed label outside it is stored as 'OTHER' (the row kept, the
// text not — counted), and anything else makes the row invalid (dropped, counted). Player names are
// third-party text (stored capped; readers wrap them). One season file is processed at a time.
import {
  DEPTH_LABEL_OTHER,
  capText,
  depthChartRuns,
  depthLabel,
  depthSnapshotMs,
  emptyToNull,
  jerseyNumber,
  legacyDepthRank,
  nonNegativeDecimal,
  parseDecimalId,
  wholeNumber,
  type DepthSnapshotRow,
} from "../../store/datasets/derive.js";
import {
  DEPTH_CHARTS_SNAPSHOT_SCHEMA_FROM,
  DS_DEPTH_CHARTS,
  DS_DEPTH_CHARTS_LEGACY,
} from "../../store/datasets/tables.js";
import type { TempFile } from "../source.js";
import { NFLVERSE_RELEASE_BASE, NflverseSourceError } from "./release.js";
import {
  eachContractRow,
  makePhase2Sources,
  rowInFileSeason,
  tableOf,
  type Phase2SourcePair,
  type PublishTarget,
} from "./phase2.js";
import { TableLoader, type RawRow } from "./rows.js";

/** The longest player name stored (code points; the wrapper caps again at output). */
export const DEPTH_NAME_MAX = 256;
/** Drop reasons and notes (counts only, never values). */
export const DEPTH_INVALID =
  "invalid snapshot row (malformed dt, espn_id, team, position id, slot, rank or label)";
export const DEPTH_DUPLICATE_SLOT = "a second occupant of one slot in one snapshot";
export const DEPTH_OTHER_LABEL = `label outside DEPTH_LABELS stored as '${DEPTH_LABEL_OTHER}'`;
export const LEGACY_NO_WEEK = "week null (SBBYE rows)";
export const LEGACY_DUPLICATE = "exact duplicate row collapsed";

/** One validated 2025+ snapshot row (derive.ts conventions); null when the row is invalid. */
export function depthSnapshotOf(raw: RawRow): DepthSnapshotRow | null {
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
    player_name: capText(raw.player_name, DEPTH_NAME_MAX),
    pos_grp_id: grpId,
    pos_grp: grp,
    pos_id: posId,
    pos_abb: abb,
    pos_slot: slot,
    pos_rank: rank,
    dt_ms: dt,
  };
}

/** A `ds_depth_charts_legacy` row before the NOT NULL check. */
export interface LegacyDepthRow {
  readonly season: number | null;
  readonly week: number | null;
  readonly game_type: string | null;
  readonly team: string | null;
  readonly gsis_id: string | null;
  readonly full_name: string | null;
  readonly position: string | null;
  readonly formation: string | null;
  readonly pos_abb: string | null;
  readonly depth_team: number | null;
  readonly jersey_number: number | null;
}

/** One `ds_depth_charts_legacy` row from a ≤ 2024 row (the contract's derivations; may hold NULLs). */
export function legacyDepthRowOf(raw: RawRow): LegacyDepthRow {
  return {
    season: wholeNumber(raw.season),
    week: wholeNumber(raw.week),
    game_type: emptyToNull(raw.game_type),
    team: emptyToNull(raw.club_code),
    gsis_id: emptyToNull(raw.gsis_id),
    full_name: capText(raw.full_name, DEPTH_NAME_MAX),
    position: emptyToNull(raw.position),
    formation: depthLabel(raw.formation),
    pos_abb: depthLabel(emptyToNull(raw.depth_position) ?? raw.position),
    depth_team: legacyDepthRank(raw.depth_team),
    jersey_number: jerseyNumber(raw.jersey_number),
  };
}

async function publishSnapshots(
  target: PublishTarget,
  file: TempFile,
  charts: TableLoader,
): Promise<void> {
  const snaps: DepthSnapshotRow[] = [];
  await eachContractRow(target, [file], (raw) => {
    const s = depthSnapshotOf(raw);
    if (s === null) {
      charts.drop(DEPTH_INVALID);
      return;
    }
    if (s.pos_grp === DEPTH_LABEL_OTHER) charts.note(`pos_grp ${DEPTH_OTHER_LABEL}`);
    if (s.pos_abb === DEPTH_LABEL_OTHER) charts.note(`pos_abb ${DEPTH_OTHER_LABEL}`);
    snaps.push(s);
  });
  const { runs, duplicates } = depthChartRuns(snaps);
  for (let i = 0; i < duplicates; i++) charts.drop(DEPTH_DUPLICATE_SLOT);
  // the 2025+ layout has no season column: a run belongs to its file's season
  for (const run of runs) charts.add({ season: file.season, ...run });
}

async function publishLegacy(
  target: PublishTarget,
  file: TempFile,
  legacy: TableLoader,
): Promise<void> {
  const seen = new Map<string, string>();
  const pk = legacy.spec.primary_key ?? [];
  await eachContractRow(target, [file], (raw) => {
    if (wholeNumber(raw.week) === null) {
      legacy.drop(LEGACY_NO_WEEK);
      return;
    }
    const row = legacyDepthRowOf(raw);
    if (!rowInFileSeason(legacy, row.season, file)) return;
    if (row.formation === DEPTH_LABEL_OTHER) legacy.note(`formation ${DEPTH_OTHER_LABEL}`);
    if (row.pos_abb === DEPTH_LABEL_OTHER) legacy.note(`pos_abb ${DEPTH_OTHER_LABEL}`);
    const cells: Readonly<Record<string, string | number | null>> = { ...row };
    if (legacy.spec.columns.some((c) => !c.nullable && (cells[c.name] ?? null) === null)) {
      legacy.add(cells); // dropped and counted by the NOT NULL check
      return;
    }
    const key = JSON.stringify(pk.map((k) => cells[k] ?? null));
    const whole = JSON.stringify(legacy.spec.columns.map((c) => cells[c.name] ?? null));
    const prior = seen.get(key);
    if (prior === undefined) {
      seen.set(key, whole);
      legacy.add(cells);
    } else if (prior === whole) legacy.drop(LEGACY_DUPLICATE);
    else {
      throw new NflverseSourceError(
        "schema",
        `${target.id}: ${DS_DEPTH_CHARTS_LEGACY.name} season ${String(file.season)} has two different rows under one key`,
      );
    }
  });
}

/** `nflverse:depth_charts` + `nflverse:depth_charts_history`. */
export const depthChartsSources: Phase2SourcePair = makePhase2Sources({
  id: "nflverse:depth_charts",
  release: { base: NFLVERSE_RELEASE_BASE, tag: "depth_charts", label: "nflverse depth_charts" },
  file: (season) => `depth_charts_${String(season)}.parquet`,
  seasonGate: "in_season",
  async publish(files, into, target) {
    // every contract table of the file is created (the columns hash covers all of them)
    const charts = new TableLoader(into, tableOf(target, DS_DEPTH_CHARTS.name));
    const legacy = target.tables.some((t) => t.name === DS_DEPTH_CHARTS_LEGACY.name)
      ? new TableLoader(into, tableOf(target, DS_DEPTH_CHARTS_LEGACY.name))
      : null;
    const loaders = legacy === null ? [charts] : [charts, legacy];
    for (const f of files) {
      if (f.season !== null && f.season >= DEPTH_CHARTS_SNAPSHOT_SCHEMA_FROM)
        await publishSnapshots(target, f, charts);
      else if (legacy !== null) await publishLegacy(target, f, legacy);
      else
        throw new NflverseSourceError(
          "schema",
          `${target.id}: season ${String(f.season)} has no layout in this source`,
        );
    }
    return { loaders, warnings: [] };
  },
});

/** The depth charts DataSource (2025+ snapshot layout). */
export const depthChartsSource = depthChartsSources.current;
