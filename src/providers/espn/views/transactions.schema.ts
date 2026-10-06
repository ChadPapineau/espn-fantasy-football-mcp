// transactions.schema.ts — `mTransactions2`, `mPendingTransactions`, the board probe view and
// `mDraftDetail` (research 03 §A.2, §B.6; plan 07 A6; plan 02 §2.1). The view-level seed paths are
// required (drift); each transaction is parsed LENIENTLY per entry against the community shape,
// grounded on the transactions `kona_playercard` embeds (recorded): a mismatch there is NOT drift
// (plan 07 A6, ADV OBJ-19(c)) — the entry is skipped and counted. `memberId` is never read.
import { z } from "zod/v4";
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
/** `mPendingTransactions`: the list itself is the seed path. */
export const mPendingTransactionsSchema = z.looseObject({
  pendingTransactions: z.array(z.unknown()),
});
/** The board probe (`kona_league_communication`): the body is discarded — only the key is checked. */
export const konaCommunicationSchema = z.looseObject({ topics: z.array(z.unknown()) });
/** `mDraftDetail` (later phase): the picks list is the seed path. */
export const mDraftDetailSchema = z.looseObject({
  draftDetail: z.looseObject({ picks: z.array(z.unknown()) }),
});
