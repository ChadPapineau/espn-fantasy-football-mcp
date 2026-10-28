// skew.ts — stored instants written under a clock that has since been set back (Stage C finding
// store-future-stamped-rows-block). Every process stamps the store's rows with the injected clock
// (src/domain/clock.ts; one wall clock on this Mac). When that clock runs fast and is then set back —
// NTP stepping a wrong RTC date at boot, a manual date change; fixture mode's derived clock starts at
// the same instant on every launch — the rows written meanwhile carry instants after "now". Such an
// instant is UNKNOWN: the row was written at some moment no later than now. Read as written, it was
// never in the past: a limiter window with no upper bound held each of those requests "inside the
// window" until real time passed its stamp (ESPN blocked for the size of the skew — plan 01 §6 is a
// rate, never a blackout), the jobs' daily caps and the in-flight cap counted it the same way, prune
// (`< now − TTL`) never removed it, a check raised then could not be acknowledged, and the newest
// settings or snapshot stayed the one stamped ahead while later ones were filed behind it.
//
// The store's rule, applied where each table is written (repos/limiter, repos/league, prune):
//  - a COUNT that must never under-count (the limiter's windows, daily caps and in-flight cap)
//    re-stamps such a row to its own request's instant inside its write transaction, once: the
//    request counts as made just now — the latest it can have been made, so the bucket never admits
//    more than its rate whatever the clock did — and then ages normally;
//  - prune re-stamps such request rows to its instant (they then age out by their TTL; one may still
//    count against a window or today's cap) and deletes cached copies of unknown age;
//  - an ORDERING (the newest settings of a league-season, the newest snapshots) is re-stamped just
//    below the next write of its kind made under the store's clock — written later, after the clock
//    was corrected — so that write is the newest;
//  - an acknowledgement made under the store's clock covers a check raised then (it was raised
//    before the human, or the snapshot, looked).
// Reads that take no instant (the breaker's outcome scan, a cache entry's age) hand rows out as
// stamped and read no clock: the judgement of an instant past now belongs to the code doing the
// time arithmetic, which already holds the instant it compares against — the in-flight pre-check's
// request instant (providers/espn/limiter.ts inFlightOf), the derived breaker's now (platform.ts
// breakerFromOutcomes), a cached copy's freshness (config/freshness.ts storedCopyState, from the
// provider). Such a row is left out of the arithmetic: it is no evidence of a request in flight
// now, nor of a breaker to hold, and the send that follows reaches tryRecord, which re-stamps it —
// from then it holds a slot 30 s, or counts as a failure 5 min, never the skew. A copy fetched
// past now has an unknown age: never `fresh` for an age-based class (an immutable copy, and a fact
// the provider keeps, may be read whatever its age). Judged here instead, every read would need a
// fresh clock read (a reading kept from earlier is itself ahead once the clock is set back), and
// the cache could not tell an immutable copy or a kept fact from an age-based copy.
import { FUTURE_STAMP_TOLERANCE_MS } from "../../config/freshness.js";
import { BUSY_TIMEOUT_MS } from "../types.js";

/**
 * How far past the store's clock a stored instant may lie and still be read as written: every
 * legitimate row is stamped no later than now — a row is stamped before it is inserted, and an
 * insert another process made is visible only once committed — so this only absorbs a sub-second
 * clock adjustment. A stamp further ahead was written under a clock that has since been set back.
 * Defined beside the freshness rules (config/freshness.ts), which the readers judge by too.
 */
export { FUTURE_STAMP_TOLERANCE_MS };

/** The largest stamp read as written at `nowMs` (the store's clock); a later one is skewed. */
export function latestTrustedMs(nowMs: number): number {
  return nowMs + FUTURE_STAMP_TOLERANCE_MS;
}

/**
 * How far past a REQUEST's own instant another row may lie and still be read as written. The
 * instant is taken before the limiter's BEGIN IMMEDIATE, which may wait up to BUSY_TIMEOUT_MS (5 s)
 * for another process's writer lock, and that process stamps its rows meanwhile: up to the full wait
 * plus the clock tolerance after this one. A row further ahead than that was written under a clock
 * since set back. (The limiter judges from its request's instant — never a clock read inside the
 * transaction — so the cost of a request is unchanged.)
 */
export const REQUEST_SKEW_TOLERANCE_MS = BUSY_TIMEOUT_MS + FUTURE_STAMP_TOLERANCE_MS;
