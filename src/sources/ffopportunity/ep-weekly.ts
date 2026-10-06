// ep-weekly.ts — `ffopportunity:ep_weekly` and its history twin (plan 10 §3.2 sources and B2's
// `xfp_gap`; plan 01 §5.2 "Expected fantasy points … ffopportunity `ep_weekly` (CC-BY-SA)"; plan 06
// §1.3 `refresh ffopportunity`; research 04 §B.3, §E; tables.ts DS_EP_WEEKLY):
// `ffverse/ffopportunity` release `latest-data`, `ep_weekly_{season}.parquet` (159 columns, observed
// 2026-10-06) → `ds_ep_weekly`: per player-week actuals AND model expectations per component, so xFP
// can be re-scored under the league's scoring. Upstream `season` is TEXT ("2026" → seasonFromText)
// and `week` a DOUBLE (wholeNumber); a team-level row without a `player_id` (unattributed opportunity)
// is dropped and counted. LICENCE: CC-BY-SA 4.0 (share-alike attaches to the data — the dataset file
// stays separable and attributed per SOURCE_REGISTRY; the code is not a derivative of it).
//
// Version: the release's own `timestamp.txt` (`2026-10-06 12:14:46.831507` — NO zone; the asset of
// that build is dated 2026-10-06T12:14:49Z, so the stamp is the GitHub Actions runner's UTC clock:
// `parseFfopportunityTimestamp`). Plan 01 §5.2 names "release `updated_at`", which needs the GitHub
// API (not on the host allow-list, and plan 01 §6 keeps it out of the hot path); the release's stamp
// file moves with every rebuild of the same assets, which is what `updated_at` would have told us.
import { seasonFromText } from "../../store/datasets/derive.js";
import { DS_EP_WEEKLY } from "../../store/datasets/tables.js";
import {
  eachContractRow,
  makePhase2Sources,
  rowBuilder,
  rowInFileSeason,
  tableOf,
  type Phase2SourcePair,
} from "../nflverse/phase2.js";
import { TIMESTAMP_MAX_BYTES, parseNflverseTimestamp } from "../nflverse/release.js";
import { TableLoader, asText, type RawRow } from "../nflverse/rows.js";
import type { IsoInstant } from "../../domain/league/types.js";

/** Where the ffopportunity release assets live (research 04 §B.3). */
export const FFOPPORTUNITY_RELEASE_BASE =
  "https://github.com/ffverse/ffopportunity/releases/download";
/** The release tag the data is published under (rebuilt in place, daily ~07:35 ET). */
export const FFOPPORTUNITY_TAG = "latest-data";
/** The drop reason of a team-level row. */
export const EP_NO_PLAYER = "team-level row without a player_id (unattributed opportunity)";

const ZONELESS_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/;

/**
 * ffopportunity's `timestamp.txt` → an ISO-8601 UTC instant (whole seconds): a zone-less
 * `YYYY-MM-DD HH:MM:SS[.ffffff]` is UTC (the runner's clock — observed against the asset's own
 * date); a stamp WITH a zone is read as nflverse's form. Anything else → null (the run fails as a
 * format change, never as an outage).
 */
export function parseFfopportunityTimestamp(text: unknown): IsoInstant | null {
  if (typeof text !== "string" || text.length > TIMESTAMP_MAX_BYTES) return null;
  const t = text.trim();
  const zoned = parseNflverseTimestamp(t);
  if (zoned !== null) return zoned;
  return ZONELESS_RE.test(t) ? parseNflverseTimestamp(`${t} UTC`) : null;
}

const build = rowBuilder(DS_EP_WEEKLY, {
  season: (r: RawRow) => seasonFromText(r.season),
});

/** `ffopportunity:ep_weekly` + `ffopportunity:ep_weekly_history`. */
export const epWeeklySources: Phase2SourcePair = makePhase2Sources({
  id: "ffopportunity:ep_weekly",
  release: {
    base: FFOPPORTUNITY_RELEASE_BASE,
    tag: FFOPPORTUNITY_TAG,
    label: "ffopportunity latest-data",
    parse: parseFfopportunityTimestamp,
  },
  file: (season) => `ep_weekly_${String(season)}.parquet`,
  seasonGate: "in_season",
  async publish(files, into, target) {
    const ep = new TableLoader(into, tableOf(target, DS_EP_WEEKLY.name));
    await eachContractRow(target, files, (raw, file) => {
      if (!rowInFileSeason(ep, seasonFromText(raw.season), file)) return;
      if (asText(raw.player_id) === null) {
        ep.drop(EP_NO_PLAYER);
        return;
      }
      ep.add(build(raw));
    });
    return { loaders: [ep], warnings: [] };
  },
});

/** The expected-fantasy-points DataSource. */
export const epWeeklySource = epWeeklySources.current;
/** Its history twin (the two prior seasons). */
export const epWeeklyHistorySource = epWeeklySources.history;
