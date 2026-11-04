// index.ts — one zod schema per whitelisted view (plan 01 §1.1 `views/*.schema.ts`; research 03
// §F.2) and the parse step that turns a schema failure into drift signals naming the JSON path and
// the view (plan 01 §7: "zod schema hard-fails, naming the JSON path and view"). Importable only from
// src/providers/espn/ (the lint zone, plan 04 R3).
import { z } from "zod/v4";
import type { DriftSignal } from "../../../drift/types.js";
import type { EspnView } from "../types.js";
import { mNavSchema, mSettingsSchema, mStandingsSchema, mTeamSchema } from "./league.schema.js";
import {
  konaPlayerInfoSchema,
  konaPlayercardSchema,
  mPositionalRatingsSchema,
  playersWlSchema,
  proTeamSchedulesSchema,
} from "./players.schema.js";
import {
  mBoxscoreSchema,
  mMatchupSchema,
  mMatchupScoreSchema,
  mRosterSchema,
  mScoreboardSchema,
} from "./schedule.schema.js";
import {
  konaCommunicationSchema,
  mDraftDetailSchema,
  mPendingTransactionsSchema,
  mTransactions2Schema,
} from "./transactions.schema.js";

export * from "./common.schema.js";
export * from "./league.schema.js";
export * from "./players.schema.js";
export * from "./schedule.schema.js";
export * from "./transactions.schema.js";

/** View → its wire schema. */
export const VIEW_SCHEMAS: Readonly<Record<EspnView, z.ZodType>> = Object.freeze({
  mSettings: mSettingsSchema,
  mNav: mNavSchema,
  mTeam: mTeamSchema,
  mStandings: mStandingsSchema,
  mRoster: mRosterSchema,
  mMatchup: mMatchupSchema,
  mMatchupScore: mMatchupScoreSchema,
  mBoxscore: mBoxscoreSchema,
  mScoreboard: mScoreboardSchema,
  mDraftDetail: mDraftDetailSchema,
  mTransactions2: mTransactions2Schema,
  mPendingTransactions: mPendingTransactionsSchema,
  mPositionalRatings: mPositionalRatingsSchema,
  kona_player_info: konaPlayerInfoSchema,
  kona_playercard: konaPlayercardSchema,
  kona_league_communication: konaCommunicationSchema,
  proTeamSchedules_wl: proTeamSchedulesSchema,
  players_wl: playersWlSchema,
});

/** The drift pattern of a zod issue path: indices become `[]` (`$.teams[].roster.entries[].playerId`). */
export function issuePattern(path: readonly PropertyKey[]): string {
  let out = "$";
  for (const seg of path) {
    if (typeof seg === "number") out += "[]";
    else if (typeof seg === "string" && /^[A-Za-z_$][\w$]*$/.test(seg)) out += `.${seg}`;
    else out += "{}";
  }
  return out;
}

/** A view's parse result: the typed body, or the signals naming each failing path (≤ 8, distinct). */
export type ViewParse<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly signals: readonly DriftSignal[] };

/** Parses `body` as `view` (loose: unknown keys pass through). Never throws on bad input. */
export function parseView<T>(view: EspnView, schema: z.ZodType<T>, body: unknown): ViewParse<T> {
  const r = schema.safeParse(body);
  if (r.success) return { ok: true, value: r.data };
  const seen = new Set<string>();
  const signals: DriftSignal[] = [];
  for (const issue of r.error.issues) {
    const path = issuePattern(issue.path);
    if (seen.has(path)) continue;
    seen.add(path);
    signals.push({ kind: "missing_required_key", view, path, value: null });
    if (signals.length >= 8) break;
  }
  return { ok: false, signals };
}

/**
 * parseView as resumable work for a body whose bulk is one array field of an object schema (`split`:
 * mRoster's `teams`): the array's elements are parsed `per` a step against the field's element
 * schema, then the rest of the body in one more step, and the elements' outputs put in the field —
 * league-c's 1 MB week-3 roster parsed in one turn of about 12–14 ms of CPU, round 3's profile on
 * the owner's Mac (plan 03 §1.2's ≤ 20 ms batch; changelog §R10 timing items). The same value as parseView: the object's own output with the field
 * in its place. Any failure returns parseView of the whole body, so the signals name the same paths
 * in the same order; a schema the split cannot read exactly the same way (not an object without
 * checks, the field not a plain array without checks) and a short array are parsed whole.
 */
export function* parseViewSteps<T>(
  view: EspnView,
  schema: z.ZodType<T>,
  body: unknown,
  split: string,
  per: number,
): Generator<void, ViewParse<T>, undefined> {
  const element = splitElementOf(schema, split);
  const record =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  const list = record === null ? undefined : record[split];
  const n = Math.max(1, Math.trunc(per));
  if (element === null || record === null || !Array.isArray(list) || list.length <= n)
    return parseView(view, schema, body);
  const items: unknown[] = [];
  for (let i = 0; i < list.length; i++) {
    const r = element.safeParse(list[i]);
    if (!r.success) return parseView(view, schema, body);
    items.push(r.data);
    if ((i + 1) % n === 0) yield;
  }
  const shell = parseView(view, schema, { ...record, [split]: [] });
  if (!shell.ok) return parseView(view, schema, body);
  (shell.value as Record<string, unknown>)[split] = items;
  return shell;
}

/**
 * The element schema of `schema`'s `split` field when parsing that field element by element reads
 * exactly as parsing the object whole: an object schema with no checks of its own whose field is a
 * plain array (no optional, no default, no length checks). Null otherwise.
 */
function splitElementOf(schema: z.ZodType, split: string): z.ZodType | null {
  if (!(schema instanceof z.ZodObject)) return null;
  if ((schema._zod.def.checks ?? []).length > 0) return null;
  const field = (schema.shape as Record<string, z.ZodType | undefined>)[split];
  if (!(field instanceof z.ZodArray)) return null;
  if ((field._zod.def.checks ?? []).length > 0) return null;
  return field.element as z.ZodType;
}
