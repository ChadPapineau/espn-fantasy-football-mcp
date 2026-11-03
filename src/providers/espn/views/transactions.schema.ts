// transactions.schema.ts — `mTransactions2`, `mPendingTransactions`, the board probe view and
// `mDraftDetail` (research 03 §A.2, §B.6; plan 07 A6; plan 02 §2.1). The view-level seed paths are
// required (drift) — except the transactions and pending lists on an answer to a recognised view,
// whose absence means none (ABSENT_MEANS_EMPTY; Stage C finding
// drift-pending-transactions-absent-key-red, finding transactions-absent-key-red); each transaction
// is parsed LENIENTLY per entry against the community shape, grounded on the transactions
// `kona_playercard` embeds (recorded): a mismatch there is NOT drift (plan 07 A6, ADV OBJ-19(c)) —
// the entry is skipped and counted. `memberId` is never read.
import { z } from "zod/v4";
import { HEADER_TRANSACTION_COUNT, type EspnView } from "../types.js";
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

/**
 * `mTransactions2` (+scoringPeriodId, filter): the list itself is the seed path. Its ABSENCE on an
 * answer to a recognised view that ESPN's count header does not contradict is read by the provider
 * as the empty list before this schema runs (`absentAsEmpty`); present, it must be a list.
 */
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
 *
 * `$.transactions` (finding transactions-absent-key-red): the same private league answered
 * `view=mTransactions2&scoringPeriodId=<the current period>` with the cookie and no such key at the
 * hourly job's two runs after ESPN rolled the scoring period, before anyone had moved in the new one
 * (live, 2026-11-03): the job failed ESPN_DRIFT_DETECTED and drift_state turned red until the period's
 * first transaction, every week. Research 03 P11 recorded `transactions: []` with
 * `x-fantasy-filter-transaction-count: 0` anonymously only; S-PY's package reads the key with an
 * empty default (its baseball league's `transactions()`, the same view and filter); the previous
 * night's backfill read every period of two previous seasons — each with transactions — through
 * this view with the cookie and no drift. Not verified on a recorded cookie-bearing answer either
 * (plan 10 §3.1b). The belt against reading a real removal as an empty week: ESPN's own count
 * (ABSENT_LIST_COUNT_HEADER) above 0 beside the absent list keeps the signal (drift).
 */
export const ABSENT_MEANS_EMPTY: Readonly<Partial<Record<EspnView, readonly string[]>>> =
  Object.freeze({
    mTransactions2: Object.freeze(["$.transactions"]),
    mPendingTransactions: Object.freeze(["$.pendingTransactions"]),
  });

/**
 * The count header ESPN sends beside an ABSENT_MEANS_EMPTY view's list, per view (research 03 §A.3:
 * `x-fantasy-filter-transaction-count` on every `mTransactions2` answer; P11 sent `0` beside
 * `transactions: []` on a league whose transactions anonymous callers do not see — it counts what
 * the answer serves). A count above 0 beside an ABSENT list is ESPN counting entries it did not
 * send: that answer is not "none", so its absent key is not excused (a removal stays drift). An
 * absent, zero or unreadable count leaves the rule as it is (whether ESPN sends the header beside a
 * cookie-bearing absent list is unrecorded). `mPendingTransactions` has no count header.
 */
export const ABSENT_LIST_COUNT_HEADER: Readonly<Partial<Record<EspnView, string>>> = Object.freeze({
  mTransactions2: HEADER_TRANSACTION_COUNT,
});

/** ESPN's count for `view`'s list on these (lower-cased) headers; null when absent or not a count. */
export function absentListCount(
  view: EspnView,
  headers: Readonly<Record<string, string>>,
): number | null {
  const name = ABSENT_LIST_COUNT_HEADER[view];
  const v = name === undefined ? undefined : headers[name];
  return v !== undefined && /^\s*\d{1,9}\s*$/.test(v) ? Number(v) : null;
}

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
 * for a body that is not a plain object or that is an unrecognised-view answer, and — given the
 * answer's `headers` — none when ESPN's count for the list is above 0 (`absentListCount`). The
 * provider's in-call check (with the headers) and its parse (`absentAsEmpty`, without them) use this
 * one rule: the parse only ever runs on an answer the check passed, or on the cached copy of one.
 */
export function absentMeansEmptyPaths(
  view: EspnView,
  body: unknown,
  headers?: Readonly<Record<string, string>>,
): readonly string[] {
  const paths = ABSENT_MEANS_EMPTY[view];
  if (paths === undefined || typeof body !== "object" || body === null || Array.isArray(body))
    return [];
  if (isUnrecognizedViewAnswer(body)) return [];
  if (headers !== undefined && (absentListCount(view, headers) ?? 0) > 0) return [];
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
