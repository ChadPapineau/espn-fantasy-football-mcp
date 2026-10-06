// snap-counts.ts — `nflverse:snap_counts` and its history twin (plan 10 §3.2 sources; plan 06 §1.3
// `refresh nflverse:snaps`; tables.ts DS_SNAP_COUNTS): `snap_counts/snap_counts_{season}.parquet`
// (PFR via nflverse; 16 columns, observed 2026-10-06) → `ds_snap_counts` keyed by `pfr_player_id`
// (there is NO gsis id upstream — readers map gsis_id → pfr_id through the roster tables). Snaps are
// whole DOUBLEs (`wholeNumber`), shares fractions 0–1 (`fraction01`; anything else → NULL). The
// upstream `player` name column is not read (joins are by id; one less third-party text surface).
import { DS_SNAP_COUNTS } from "../../store/datasets/tables.js";
import { NFLVERSE_RELEASE_BASE } from "./release.js";
import {
  eachContractRow,
  makePhase2Sources,
  rowBuilder,
  rowInFileSeason,
  tableOf,
  type Phase2SourcePair,
} from "./phase2.js";
import { TableLoader, asInt } from "./rows.js";

const build = rowBuilder(DS_SNAP_COUNTS);

/** `nflverse:snap_counts` + `nflverse:snap_counts_history`. */
export const snapCountsSources: Phase2SourcePair = makePhase2Sources({
  id: "nflverse:snap_counts",
  release: { base: NFLVERSE_RELEASE_BASE, tag: "snap_counts", label: "nflverse snap_counts" },
  file: (season) => `snap_counts_${String(season)}.parquet`,
  seasonGate: "in_season",
  async publish(files, into, target) {
    const snaps = new TableLoader(into, tableOf(target, DS_SNAP_COUNTS.name));
    await eachContractRow(target, files, (raw, file) => {
      if (rowInFileSeason(snaps, asInt(raw.season), file)) snaps.add(build(raw));
    });
    return { loaders: [snaps], warnings: [] };
  },
});

/** The snap counts DataSource. */
export const snapCountsSource = snapCountsSources.current;
