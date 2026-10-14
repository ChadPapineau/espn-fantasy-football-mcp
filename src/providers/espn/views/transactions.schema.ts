// transactions.schema.ts — `mTransactions2`, `mPendingTransactions`, the board probe view and
// `mDraftDetail` (research 03 §A.2, §B.6; plan 07 A6; plan 02 §2.1). The view-level seed paths are
// required (drift) — except the pending list on an answer to a recognised view, whose absence means
// none (ABSENT_MEANS_EMPTY; Stage C finding drift-pending-transactions-absent-key-red); each
// transaction is parsed LENIENTLY per entry against the community shape, grounded on the
// transactions `kona_playercard` embeds (recorded): a mismatch there is NOT drift (plan 07 A6, ADV
// OBJ-19(c)) — the entry is skipped and counted. `memberId` is never read.
import { z } from "zod/v4";
import type { EspnView } from "../types.js";
import { int, optBool, optInt, optNum, optStr } from "./common.schema.js";

/** One transaction item (`type` ADD | DROP | LINEUP | DRAFT; slot −1 = none). */
export const transactionItemSchema = z.looseObject({
  type: z.string(),
  playerId: int,
  fromTeamId: optInt,
  toTeamId: optInt,
  fromLineupSlotId: optInt,
  toLineupSlotId: optInt,
  isKeeper: optBool,
});

/** One transaction (community shape; `id` is ESPN's transaction id, never a member id). */
export const transactionSchema = z.looseObject({
  id: z.union([z.string().min(1).max(64), int]),
  type: z.string().min(1).max(40),
  status: optStr,
  teamId: optInt,
  scoringPeriodId: optInt,
  processDate: optNum,
  proposedDate: optNum,
  acceptedDate: optNum,
  bidAmount: optNum,
  relatedTransactionId: z.union([z.string().max(64), int]).nullish(),
  items: z.array(transactionItemSchema).nullish(),
});
export type WireTransaction = z.infer<typeof transactionSchema>;

/** `mTransactions2` (+scoringPeriodId, filter): the list itself is the seed path. */
export const mTransactions2Schema = z.looseObject({ transactions: z.array(z.unknown()) });
/**
 * `mPendingTransactions`: the list itself is the seed path. Its ABSENCE on an answer to a
 * recognised view is read by the provider as the empty list before this schema runs
 * (`absentAsEmpty`); present, it must be a list.
 */
export const mPendingTransactionsSchema = z.looseObject({
  pendingTransactions: z.array(z.unknown()),
});

/**
 * Root keys (`$.<key>`) whose ABSENCE on an answer to a RECOGNISED view is ESPN's "none", not drift.
 * Plan 01 §7 reads an answer without a view's seed keys as a skeleton, because a renamed view
 * answers 200 with one (research 03 §A.2 P28); for these keys an answer that shows ESPN recognised
 * the view (`isUnrecognizedViewAnswer` false) reads the absent key as the empty list
 * (`absentAsEmpty`), and the provider's in-call check excuses exactly that signal — it never reaches
 * `drift_state`. The unrecognised-view answer itself stays a skeleton (drift), so a renamed view is
 * still detected. Present with a non-list value the key still fails the schema (drift).
 *
 * `$.pendingTransactions`: the owner's private league answered `view=mPendingTransactions` with the
 * cookie and no such key (Stage C live run, 2026-10-11), where research 03 P10 recorded
 * `pendingTransactions: []` anonymously on a public league; no fixture verifies the view's required
 * set (src/drift REQUIRED_PATHS_UNVERIFIED), and only a recorded key's drift is
 * ESPN_DRIFT_DETECTED (plan 07 A6, ADV OBJ-19(c)). Not verified on a recorded cookie-bearing answer:
 * that an absent list there means nothing pending rather than a request the view no longer serves
 * (plan 10 §3.1b's private-view recording of `mPendingTransactions` from the owner's league settles
 * it).
 */
export const ABSENT_MEANS_EMPTY: Readonly<Partial<Record<EspnView, readonly string[]>>> =
  Object.freeze({ mPendingTransactions: Object.freeze(["$.pendingTransactions"]) });

function ownKey(o: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

/**
 * Whether `body` is ESPN's answer to a view name it does not recognise: the league's default
 * summary — `members[]` and `teams[]` (with `settings{name}`) — WITHOUT the `draftDetail` every
 * recognised league view's answer carries. Research 03 §A.2 P28 (`?view=mBogusViewName`, recorded as
 * `fixtures/espn/recorded/<league>/skeleton.json`, the only recorded league body without
 * `draftDetail`); every other recorded league-route body (mSettings, mNav, mTeam, mRoster, mMatchup,
 * mMatchupScore, mBoxscore, the shape probe, three leagues) carries it. A recognised view with
 * nothing to add answers the bare base (P17/P18, 939 bytes); P10's `mPendingTransactions` answer was
 * that base plus `"pendingTransactions":[]` (964 bytes).
 */
export function isUnrecognizedViewAnswer(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const o = body as Record<string, unknown>;
  return !ownKey(o, "draftDetail") && Array.isArray(o.members) && Array.isArray(o.teams);
}

/**
 * The ABSENT_MEANS_EMPTY paths of `view` that `body` lacks and that read as the empty list: none
 * for a body that is not a plain object or that is an unrecognised-view answer. The provider's
 * in-call check and its parse use this one rule, so they never disagree.
 */
export function absentMeansEmptyPaths(view: EspnView, body: unknown): readonly string[] {
  const paths = ABSENT_MEANS_EMPTY[view];
  if (paths === undefined || typeof body !== "object" || body === null || Array.isArray(body))
    return [];
  if (isUnrecognizedViewAnswer(body)) return [];
  return paths.filter((p) => !ownKey(body, p.slice(2)));
}

/**
 * `body` with every `absentMeansEmptyPaths` key set to the empty list (a copy; the body itself is
 * never changed). Anything else — a key present with any value, an unrecognised-view answer, a
 * value that is not a plain object — is left for the schema to judge.
 */
export function absentAsEmpty(view: EspnView, body: unknown): unknown {
  const absent = absentMeansEmptyPaths(view, body);
  if (absent.length === 0) return body;
  const out: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const p of absent) out[p.slice(2)] = [];
  return out;
}
/** The board probe (`kona_league_communication`): the body is discarded — only the key is checked. */
export const konaCommunicationSchema = z.looseObject({ topics: z.array(z.unknown()) });
/** `mDraftDetail` (later phase): the picks list is the seed path. */
export const mDraftDetailSchema = z.looseObject({
  draftDetail: z.looseObject({ picks: z.array(z.unknown()) }),
});
