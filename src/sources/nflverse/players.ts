// players.ts — `nflverse:players` (research 04 §C step 2: the crosswalk's fallback for an ESPN id the
// season's roster_weekly lacks — free agents, retired / inactive players still on IR):
// `players/players.parquet` (ONE season-less file) → `ds_nfl_players`. Rows whose gsis_id is not a
// GSIS id (6,079 legacy `ABC123456` ids in 2026 — no nflverse stats row can join them) are dropped and
// counted; `espn_id` decimal text → INTEGER; `jersey_number` is TEXT here (an INT32 in roster_weekly).
import { GSIS_ID_RE } from "../../config/schema.js";
import { isoDate, jerseyNumber } from "../../store/datasets/derive.js";
import { DS_NFL_PLAYERS } from "../../store/datasets/tables.js";
import type { DataSource } from "../source.js";
import { eachRow, makeNflverseSource } from "./base.js";
import {
  TableLoader,
  asText,
  buildRow,
  decimalIdOf,
  type Derivation,
  type RawRow,
} from "./rows.js";

/** The derived ds_nfl_players columns; malformed ESPN ids are noted on `loader`. */
export function playerDerivations(loader: TableLoader): Readonly<Record<string, Derivation>> {
  return Object.freeze({
    espn_id: (r: RawRow) => decimalIdOf(loader, "espn_id", r.espn_id),
    jersey_number: (r: RawRow) => jerseyNumber(r.jersey_number),
    birth_date: (r: RawRow) => isoDate(r.birth_date),
  });
}

/** The nflverse players DataSource. */
export const playersSource: DataSource = makeNflverseSource({
  id: "nflverse:players",
  tag: "players",
  file: { all: "players.parquet", seasonless: true },
  seasonGate: "always",
  async publish(files, into) {
    const players = new TableLoader(into, DS_NFL_PLAYERS);
    const derived = playerDerivations(players);
    await eachRow("nflverse:players", files, (raw) => {
      const gsis = asText(raw.gsis_id);
      if (gsis !== null && !GSIS_ID_RE.test(gsis)) {
        players.drop("gsis_id is not a GSIS id");
        return;
      }
      players.add(buildRow(DS_NFL_PLAYERS, raw, derived));
    });
    return { loaders: [players], warnings: [] };
  },
});
