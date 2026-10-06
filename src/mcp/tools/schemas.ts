// schemas.ts — output building blocks every tool's in-code `data` schema composes (plan 01 §4.2
// "zod-typed"; plan 02 §6.2: an untrusted position admits only the `untrusted_text` wrapper, a bare
// third-party string only where the schema MARKS it with its source so `meta.untrusted_fields` is
// derived from the schema; code fields are grammar-checked so they cannot carry prose).
// Ported from sibling @5daa625 (src/mcp/tools/schemas.ts), adapted (ESPN ids and vocabularies).
import { z } from "zod/v4";
import { GSIS_ID_RE } from "../../config/schema.js";
import { LOG_ID_RE } from "../../domain/reclog/types.js";
import {
  SLOT_NAME_RE,
  bareTextSchema,
  distSchema,
  inputFreshnessSchema,
  playerIdSchema,
  recSchema,
  untrustedTextSchema,
} from "../envelope.js";

/** An ISO-8601 instant (≤ 40 chars). */
export const iso = z.iso.datetime({ offset: true }).max(40);
/** A nullable instant. */
export const isoNull = iso.nullable();
/** A wrapped untrusted value (never a bare string). */
export const ut = untrustedTextSchema;
export const utOrNull = ut.nullable();
/** A bare, path-listed ESPN player name (plan 01 §4.4 after A7a). */
export const playerName = bareTextSchema("espn.player.name");
/** A bare, path-listed recommendation-log text read back (plan 07 C15). */
export const recLogText = bareTextSchema("store.recommendation_log");
/** An ESPN player id (persons and team units). */
export const playerId = playerIdSchema;
export const gsisId = z.string().regex(GSIS_ID_RE);
export const gsisOrNull = gsisId.nullable();
export const logId = z.string().regex(LOG_ID_RE);
/** An ESPN team id (a grammar bound; membership is checked by the tool). */
export const teamId = z.number().int().min(1).max(999);
/** A scoring period (0 preseason … 22). */
export const week = z.number().int().min(0).max(22);
export const season = z.number().int().min(1990).max(2100);
export const points = z.number().min(-10_000).max(10_000);
export const pointsNull = points.nullable();
export const prob = z.number().min(0).max(1);
export const probNull = prob.nullable();
export const count = z.number().int().min(0).max(1_000_000);
export const dist = distSchema;
export const distNull = distSchema.nullable();
export const inputs = z.array(inputFreshnessSchema).max(25);
export const rec = recSchema;
/** An ESPN slot name (`QB`, `FLEX`, `D/ST`, `RB/WR`, `BE`, `IR`, `SLOT_99`). */
export const slotName = z.string().regex(/^(?:[A-Za-z][A-Za-z/]{0,9}|SLOT_[0-9]{1,2})$/);
export const slotNameLoose = z.string().regex(SLOT_NAME_RE);
/** A display position (`QB`, `D/ST`, `TQB`, `HC`, `POS_99`). */
export const position = z.string().regex(/^(?:[A-Za-z][A-Za-z/]{0,9}|POS_[0-9]{1,2})$/);
/** An ESPN pro-team abbreviation (`KC`, `WSH`, `FA`). */
export const proTeam = z.string().regex(/^[A-Z]{2,4}$/);
export const proTeamNull = proTeam.nullable();
/** An enum-like ESPN token (`INJURY_RESERVE`, `WAIVERS_TRADITIONAL`, `UNKNOWN`). */
export const token = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
export const tokenNull = token.nullable();
/** A lowercase code the server derived (`priority_move_to_last`, `cold_start_table`). */
export const code = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
/** An ESPN stat id. */
export const statId = z.string().regex(/^[0-9]{1,4}$/);
/** A canonical stat name. */
export const canonical = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
/** Engine/server-authored fixed text (assumptions, notes): printable, bounded. */
export const serverText = z.string().max(400);
/** A stat map `{ statId: number }`. */
export const statMap = z.record(statId, z.number());
/** A week-keyed map `{ "3": n }`. */
export const weekMap = <T extends z.ZodType>(v: T) => z.record(z.string().regex(/^[0-9]{1,2}$/), v);
export const gameState = z.enum(["pre", "in", "final", "bye", "tbd"]);
export const slotClass = z.enum(["starter", "flex", "bench", "ir", "other"]);
export const poolStatus = z.enum(["FREEAGENT", "WAIVERS", "ONTEAM"]);
export const injuryStatus = token.nullable();

/** Ownership as a row shows it (plan 07 B1). */
export const ownershipRow = z
  .strictObject({
    percent_owned: z.number().min(0).max(100).nullable(),
    percent_started: z.number().min(0).max(100).nullable(),
    percent_change: z.number().min(-100).max(100).nullable(),
    competition_signal: z.literal(true),
  })
  .nullable();

/** The crosswalk block (plan 07 C1). */
export const crosswalkStatus = z.strictObject({
  method: z.enum(["id", "match", "override", "none"]),
  confidence: z.number().min(0).max(1),
});

/** A C1 row (plan 07 C1). */
export const playerSearchRow = z.strictObject({
  player_id: playerId,
  gsis_id: gsisOrNull,
  name: playerName,
  position,
  eligible_slots: z.array(slotName).max(40),
  pro_team: proTeamNull,
  jersey: z
    .string()
    .regex(/^[0-9]{1,3}$/)
    .nullable(),
  status: poolStatus.nullable(),
  on_team_id: teamId.nullable(),
  on_team_name: utOrNull,
  waiver_process_date: isoNull,
  injury_status: injuryStatus,
  droppable: z.boolean().nullable(),
  ownership: ownershipRow,
  projection_week_espn: pointsNull,
  projection_ros_espn: pointsNull,
  last_news_at: isoNull,
  has_outlook: z.boolean(),
  crosswalk: crosswalkStatus,
});
