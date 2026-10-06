// index.ts — one zod schema per whitelisted view (plan 01 §1.1 `views/*.schema.ts`; research 03
// §F.2) and the parse step that turns a schema failure into drift signals naming the JSON path and
// the view (plan 01 §7: "zod schema hard-fails, naming the JSON path and view"). Importable only from
// src/providers/espn/ (the lint zone, plan 04 R3).
import type { z } from "zod/v4";
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
