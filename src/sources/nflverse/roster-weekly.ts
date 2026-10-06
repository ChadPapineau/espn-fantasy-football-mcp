// roster-weekly.ts — `nflverse:roster_weekly` (research 04 §C: the crosswalk's id source — the ESPN id
// is a LOOKUP; plan 10 §3.1a): `weekly_rosters/roster_weekly_{season}.parquet` → `ds_roster_weekly`
// with gsis_id, the ESPN id (decimal text → INTEGER, so it joins ESPN's numeric ids) and the Sleeper /
// PFR / other ids. Empty ids become NULL (an empty id must never match a lookup); a malformed ESPN id
// becomes NULL and is counted; rows without a gsis_id are dropped and counted (5 in the 2026 file).
// Ported from sibling @521f9f3, adapted (espn_id parsed; yahoo_id not kept).
import { isoDate } from "../../store/datasets/derive.js";
import { DS_ROSTER_WEEKLY } from "../../store/datasets/tables.js";
import type { DataSource } from "../source.js";
import { eachRow, inFileSeason, makeNflverseSource } from "./base.js";
import { TableLoader, asInt, buildRow, decimalIdOf, type Derivation, type RawRow } from "./rows.js";

/** The derived ds_roster_weekly columns; malformed ESPN ids are noted on `loader`. */
export function rosterDerivations(loader: TableLoader): Readonly<Record<string, Derivation>> {
  return Object.freeze({
    espn_id: (r: RawRow) => decimalIdOf(loader, "espn_id", r.espn_id),
    birth_date: (r: RawRow) => isoDate(r.birth_date),
  });
}

/** The weekly-roster DataSource. */
export const rosterWeeklySource: DataSource = makeNflverseSource({
  id: "nflverse:roster_weekly",
  tag: "weekly_rosters",
  file: (season) => `roster_weekly_${String(season)}.parquet`,
  seasonGate: "always",
  async publish(files, into) {
    const roster = new TableLoader(into, DS_ROSTER_WEEKLY);
    const derived = rosterDerivations(roster);
    await eachRow("nflverse:roster_weekly", files, (raw, file) => {
      if (inFileSeason(roster, asInt(raw.season), file)) {
        roster.add(buildRow(DS_ROSTER_WEEKLY, raw, derived));
      }
    });
    return { loaders: [roster], warnings: [] };
  },
});
