// schemas.ts — the expected upstream columns of each nflverse release file and the kind each must
// decode to (plan 01 §5.5: "the expected columns live in one file per source … so an off-season rename
// is a one-line fix with a failing test"; D9 schema assertion). DERIVED from the dataset contract
// (src/store/datasets/tables.ts `requiredUpstreamColumns` + each verbatim column's type), so the
// loader and the tables can never disagree; the kinds were checked against the real 2026 files.
// Ported from sibling @521f9f3, adapted (five sources incl. nflverse players; per-source kinds).
import type { DatasetSourceId } from "../../config/freshness.js";
import {
  DATASET_TABLES,
  TEAM_DEFENSE_SUM_COLUMNS,
  requiredUpstreamColumns,
} from "../../store/datasets/tables.js";

/** The nflverse sources this module implements (tables.ts PARQUET_SOURCES). */
export const NFLVERSE_SOURCE_IDS = [
  "nflverse:schedules",
  "nflverse:injuries",
  "nflverse:roster_weekly",
  "nflverse:stats_player_week",
  "nflverse:players",
] as const satisfies readonly DatasetSourceId[];
/** One of them. */
export type NflverseSourceId = (typeof NFLVERSE_SOURCE_IDS)[number];

/** Whether `s` is one of the nflverse source ids. */
export function isNflverseSourceId(s: string): s is NflverseSourceId {
  return (NFLVERSE_SOURCE_IDS as readonly string[]).includes(s);
}

/**
 * What a column must decode to (parquet.ts `kindMatches`): `string` = BYTE_ARRAY; `int` = INT32/INT64;
 * `double` = DOUBLE/FLOAT (an integer column is accepted); `date` = INT32 DATE or a string.
 */
export type ColumnKind = "string" | "int" | "double" | "date";

/**
 * Upstream inputs that are not stored verbatim, per source (so their kind is not a stored column's
 * type): ids written as text and parsed to INTEGER, the roof normalised, dates, the team-defence sums.
 */
const DERIVED_INPUT_KINDS: Readonly<
  Record<NflverseSourceId, Readonly<Record<string, ColumnKind>>>
> = Object.freeze({
  "nflverse:schedules": { espn: "string", roof: "string" },
  "nflverse:injuries": {},
  "nflverse:roster_weekly": { espn_id: "string", birth_date: "date" },
  "nflverse:stats_player_week": {
    def_sacks: "double",
    ...Object.fromEntries(
      TEAM_DEFENSE_SUM_COLUMNS.filter((c) => c !== "def_sacks").map((c) => [c, "int" as const]),
    ),
  },
  "nflverse:players": { espn_id: "string", jersey_number: "string", birth_date: "date" },
});

/** The kinds of one source's required columns; throws on a contract column it cannot type. */
export function kindsFor(source: NflverseSourceId): Readonly<Record<string, ColumnKind>> {
  const verbatim = new Map<string, ColumnKind>();
  for (const t of DATASET_TABLES[source]) {
    for (const c of t.columns) {
      if (c.derivation !== null || c.from.length !== 1 || c.from[0] !== c.name) continue;
      const kind: ColumnKind =
        c.type === "TEXT" ? "string" : c.type === "INTEGER" ? "int" : "double";
      const prior = verbatim.get(c.name);
      if (prior !== undefined && prior !== kind)
        throw new Error(`nflverse schemas: ${source} column ${c.name} has two kinds`);
      verbatim.set(c.name, kind);
    }
  }
  const derived = DERIVED_INPUT_KINDS[source];
  const out: Record<string, ColumnKind> = {};
  for (const name of requiredUpstreamColumns(source)) {
    const kind = (Object.hasOwn(derived, name) ? derived[name] : undefined) ?? verbatim.get(name);
    if (kind === undefined)
      throw new Error(`nflverse schemas: no kind for ${source} column ${name}`);
    out[name] = kind;
  }
  return Object.freeze(out);
}

/** Every required upstream column of each source → its expected kind. Extra columns are tolerated. */
export const EXPECTED_COLUMNS: Readonly<
  Record<NflverseSourceId, Readonly<Record<string, ColumnKind>>>
> = Object.freeze({
  "nflverse:schedules": kindsFor("nflverse:schedules"),
  "nflverse:injuries": kindsFor("nflverse:injuries"),
  "nflverse:roster_weekly": kindsFor("nflverse:roster_weekly"),
  "nflverse:stats_player_week": kindsFor("nflverse:stats_player_week"),
  "nflverse:players": kindsFor("nflverse:players"),
});
