// dedup-contract.ts — the RecommendationLogRepository deduplication contract (plan 07 E12
// `idempotentHint: true` on `client_ref`; src/domain/reclog/types.ts RECORD_DEDUP_SCOPE; sib
// QA-1-061), framework-free so ANY implementation can be held to it: the in-memory reference
// (tests/domain/reclog/dedup.test.ts) and the SQLite store (tests/store). Returns every violation as a
// line of text; [] means it holds. Ported from sibling @cf3b015, adapted (the port is synchronous;
// league_id; the log is never pruned).
//
// The property: a record is deduplicated onto an earlier one only when their whole scope — league,
// season, week, kind AND client_ref — matches. A retry is idempotent; a new season, week or kind
// under the same client_ref is a new recommendation and must be stored (the Skills reuse refs like
// `start-sit-w4-flex` every season).
import type {
  RecommendationLogRepository,
  RecordRecommendationInput,
  RecordResult,
} from "../../../src/domain/reclog/types.js";
import { input, rec } from "./helpers.js";

/** Opens a fresh, empty repository (and how to close it). */
export type OpenRepo = () => { repo: RecommendationLogRepository; close: () => void };

const REF = "start-sit-w4-flex";
const t = (m: number): string =>
  new Date(Date.parse("2026-09-30T18:00:00.000Z") + m * 60_000).toISOString();

type Scenario = (repo: RecommendationLogRepository, fail: (msg: string) => void) => void;

const base = (over: Partial<RecordRecommendationInput> = {}): RecordRecommendationInput =>
  input({ client_ref: REF, ...over });

function expectNew(
  repo: RecommendationLogRepository,
  first: RecordResult,
  over: Partial<RecordRecommendationInput>,
  at: string,
  what: string,
  fail: (msg: string) => void,
): RecordResult {
  const r = repo.record(base({ rec: rec({ action: `the ${what} call` }), ...over }), at);
  if (r.deduplicated) fail(`${what}: deduplicated onto an earlier row (log_id ${first.log_id})`);
  if (r.log_id === first.log_id) fail(`${what}: returned the earlier log_id`);
  if (r.recorded_at !== at) fail(`${what}: recorded_at ${r.recorded_at}, expected ${at}`);
  const got = repo.get(r.log_id);
  if (got?.rec.action !== `the ${what} call`)
    fail(`${what}: the new recommendation was not stored`);
  return r;
}

/** The named scenarios; each runs on a fresh repository. */
export const DEDUP_SCENARIOS: Readonly<Record<string, Scenario>> = Object.freeze({
  "a retry with the same scope returns the first row": (repo, fail) => {
    const a = repo.record(base(), t(0));
    const b = repo.record(base({ rec: rec({ action: "a retried call" }) }), t(1));
    if (a.deduplicated) fail("retry: the first record reported deduplicated");
    if (!b.deduplicated || b.log_id !== a.log_id || b.recorded_at !== a.recorded_at)
      fail("retry: the second record did not resolve to the first row");
    if (repo.forWeek(base().league_id, 2026, 4).length !== 1)
      fail("retry: more than one row stored for one scope");
    if (repo.get(a.log_id)?.rec.action !== rec().action)
      fail("retry: the stored row was overwritten by the retry (the log is immutable)");
  },

  "the same client_ref next season is a new row": (repo, fail) => {
    const a = repo.record(base(), t(0));
    const at = "2027-09-29T18:00:00.000Z";
    const b = expectNew(repo, a, { season: 2027 }, at, "next-season", fail);
    if (b.week !== 4) fail(`next-season: week ${String(b.week)}, expected 4`);
    const rows = repo.forWeek(base().league_id, 2027, 4);
    if (rows.length !== 1 || rows[0]?.season !== 2027)
      fail(`next-season: forWeek(2027, 4) holds ${String(rows.length)} rows, expected the new one`);
    const page = repo.list({
      league_id: base().league_id,
      season: 2027,
      week: null,
      kind: null,
      limit: 10,
      offset: 0,
    });
    if (page.items.length !== 1 || page.items[0]?.log_id !== b.log_id || page.total !== 1)
      fail("next-season: list(season 2027) does not show exactly the new row");
    // and a retry of the 2027 call is idempotent onto the 2027 row, not the 2026 one
    const c = repo.record(base({ season: 2027 }), "2027-09-29T18:05:00.000Z");
    if (!c.deduplicated || c.log_id !== b.log_id)
      fail("next-season: a retry of the 2027 call did not resolve to the 2027 row");
  },

  "the same client_ref in another week is a new row": (repo, fail) => {
    const a = repo.record(base(), t(0));
    const b = expectNew(repo, a, { week: 5 }, t(1), "other-week", fail);
    if (b.week !== 5) fail(`other-week: result week ${String(b.week)}, expected 5`);
  },

  "the same client_ref under another kind is a new row": (repo, fail) => {
    const a = repo.record(base(), t(0));
    const b = expectNew(repo, a, { kind: "stream" }, t(1), "other-kind", fail);
    if (b.kind !== "stream") fail(`other-kind: result kind ${b.kind}, expected stream`);
  },

  "the same client_ref in another league is a new row": (repo, fail) => {
    const a = repo.record(base(), t(0));
    expectNew(repo, a, { league_id: "1" }, t(1), "other-league", fail);
  },

  "a null client_ref is never deduplicated": (repo, fail) => {
    const a = repo.record(base({ client_ref: null }), t(0));
    const b = repo.record(base({ client_ref: null }), t(1));
    if (a.deduplicated || b.deduplicated || a.log_id === b.log_id)
      fail("null client_ref: two records collapsed into one");
  },

  "repeated records of one scope store exactly one row": (repo, fail) => {
    const outs = Array.from({ length: 12 }, (_, i) => repo.record(base({ season: 2028 }), t(i)));
    if (
      new Set(outs.map((o) => o.log_id)).size !== 1 ||
      outs.filter((o) => !o.deduplicated).length !== 1
    )
      fail("repeated: one scope produced more than one row");
  },
});

/** Runs every scenario on a fresh repository; returns the violations (`<scenario>: <what>`). */
export function checkRecordDedupContract(open: OpenRepo): string[] {
  const out: string[] = [];
  for (const [name, run] of Object.entries(DEDUP_SCENARIOS)) {
    const { repo, close } = open();
    try {
      run(repo, (msg) => out.push(`${name}: ${msg}`));
    } catch (e) {
      out.push(`${name}: threw ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      close();
    }
  }
  return out;
}
