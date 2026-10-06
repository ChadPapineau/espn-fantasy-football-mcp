// pbp.ts — `nflverse:pbp`, the projected play-by-play subset, and its history twin (plan 10 §3.2: RZ/GL
// flags, `kick_distance`, `yards_gained` on TD plays, `defteam`, `xpass`, `pass_oe`, `epa`; plan 01
// §5.2 "ds_pbp (projected columns)", §5.8 ~10 MB a season [A-11]; plan 06 §1.3 `refresh
// nflverse:stats`; tables.ts DS_PBP). `pbp/play_by_play_{season}.parquet` carries 372 columns and
// ~21 MB a season (observed 2026-10-06): the season file is downloaded (cap PBP_MAX_FILE_BYTES),
// and ONLY the contract's ~49 upstream columns are decoded (base.ts `eachRowOf` reads the asserted
// columns alone — the projection happens before a row is built; `desc` and every other free-text
// column are never read). Kept plays: PBP_KEPT_PLAY_TYPES (period/timeout markers with a null
// `play_type` and penalty-nullified `no_play` rows are dropped and counted — with that filter the
// pbp-derived targets, carries, TDs and FG attempts equal nflverse's stats_player_week, research in
// docs/evals/phase2-datasets.md). `rz` / `gl` derive from `yardline_100`.
import { goalLineFlag, isKeptPlayType, redZoneFlag } from "../../store/datasets/derive.js";
import { DS_PBP } from "../../store/datasets/tables.js";
import { NFLVERSE_RELEASE_BASE, PBP_MAX_FILE_BYTES } from "./release.js";
import {
  eachContractRow,
  makePhase2Sources,
  rowBuilder,
  rowInFileSeason,
  tableOf,
  type Phase2SourcePair,
} from "./phase2.js";
import { TableLoader, asInt, type RawRow } from "./rows.js";

/** The drop reason a non-kept play type is counted under. */
export const PBP_NOT_KEPT = "play_type not in PBP_KEPT_PLAY_TYPES (markers, no_play)";

const build = rowBuilder(DS_PBP, {
  rz: (r: RawRow) => redZoneFlag(r.yardline_100),
  gl: (r: RawRow) => goalLineFlag(r.yardline_100),
});

/** `nflverse:pbp` + `nflverse:pbp_history`. */
export const pbpSources: Phase2SourcePair = makePhase2Sources({
  id: "nflverse:pbp",
  release: { base: NFLVERSE_RELEASE_BASE, tag: "pbp", label: "nflverse pbp" },
  file: (season) => `play_by_play_${String(season)}.parquet`,
  seasonGate: "in_season",
  maxBytes: PBP_MAX_FILE_BYTES,
  async publish(files, into, target) {
    const plays = new TableLoader(into, tableOf(target, DS_PBP.name));
    await eachContractRow(target, files, (raw, file) => {
      if (!rowInFileSeason(plays, asInt(raw.season), file)) return;
      if (!isKeptPlayType(raw.play_type)) {
        plays.drop(PBP_NOT_KEPT);
        return;
      }
      plays.add(build(raw));
    });
    return { loaders: [plays], warnings: [] };
  },
});

/** The play-by-play subset DataSource. */
export const pbpSource = pbpSources.current;
