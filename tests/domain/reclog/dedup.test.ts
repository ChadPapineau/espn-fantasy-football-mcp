// dedup.test.ts — the RecommendationLogRepository deduplication contract (plan 07 E12
// `idempotentHint: true`; src/domain/reclog/types.ts RECORD_DEDUP_SCOPE): an in-memory reference
// repository built on sameRecordDedupScope and buildRecord holds the port contract
// (dedup-contract.ts), and the contract is shown not to be vacuous by running it against a
// (league_id, client_ref) scope and a never-deduplicating store, which it must reject. The store
// owner runs checkRecordDedupContract against SQLite. Ported from sibling @cf3b015, adapted.
import { describe, expect, it } from "vitest";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import { buildRecord } from "../../../src/domain/reclog/record.js";
import { toListItem } from "../../../src/domain/reclog/retrospective.js";
import {
  RECORD_DEDUP_SCOPE,
  sameRecordDedupScope,
  type RecommendationLogRepository,
  type RecommendationOutcome,
  type RecommendationRecord,
  type RecordRecommendationInput,
} from "../../../src/domain/reclog/types.js";
import { checkRecordDedupContract, DEDUP_SCENARIOS } from "./dedup-contract.js";
import { input } from "./helpers.js";

/** An in-memory repository whose dedup lookup is `match(existing, incoming)`. */
function memoryLog(
  match: (a: RecordRecommendationInput, b: RecordRecommendationInput) => boolean,
): RecommendationLogRepository {
  const rows: RecommendationRecord[] = [];
  const outcomes = new Map<string, RecommendationOutcome>();
  let seed = 0;
  return {
    record(inp, recordedAt) {
      const prior = inp.client_ref === null ? undefined : rows.find((r) => match(r, inp));
      if (prior !== undefined)
        return {
          log_id: prior.log_id,
          recorded_at: prior.recorded_at,
          week: prior.week,
          kind: prior.kind,
          deduplicated: true,
        };
      const row = buildRecord(inp, { clock: fixedClock(recordedAt), rng: seededRng(++seed) });
      rows.push(row);
      return {
        log_id: row.log_id,
        recorded_at: row.recorded_at,
        week: row.week,
        kind: row.kind,
        deduplicated: false,
      };
    },
    get: (id) => rows.find((r) => r.log_id === id) ?? null,
    list(q) {
      const all = rows
        .filter(
          (r) =>
            r.league_id === q.league_id &&
            (q.season === null || r.season === q.season) &&
            (q.week === null || r.week === q.week) &&
            (q.kind === null || r.kind === q.kind),
        )
        .reverse();
      return {
        items: all
          .slice(q.offset, q.offset + q.limit)
          .map((r) => toListItem(r, outcomes.get(r.log_id) ?? null)),
        total: all.length,
      };
    },
    forWeek: (league, season, week) =>
      rows.filter((r) => r.league_id === league && r.season === season && r.week === week),
    recordOutcome: (o) => {
      outcomes.set(o.log_id, o);
    },
    outcome: (id) => outcomes.get(id) ?? null,
  };
}

const open = (match: Parameters<typeof memoryLog>[0]) => () => ({
  repo: memoryLog(match),
  close: () => undefined,
});

describe("RECORD_DEDUP_SCOPE", () => {
  it("names only fields every record carries", () => {
    const rec = input({ client_ref: "x" });
    for (const f of RECORD_DEDUP_SCOPE) expect(Object.keys(rec)).toContain(f);
  });
});

describe("the repository dedup contract (dedup-contract.ts)", () => {
  it("holds for a repository that deduplicates on sameRecordDedupScope", () => {
    expect(checkRecordDedupContract(open(sameRecordDedupScope))).toEqual([]);
  });

  it("rejects a (league_id, client_ref) scope, with the season, week and kind scenarios named", () => {
    const legacy = (a: RecordRecommendationInput, b: RecordRecommendationInput): boolean =>
      a.league_id === b.league_id && a.client_ref === b.client_ref;
    const v = checkRecordDedupContract(open(legacy));
    expect(v.some((m) => m.startsWith("the same client_ref next season is a new row"))).toBe(true);
    expect(v.some((m) => m.startsWith("the same client_ref in another week"))).toBe(true);
    expect(v.some((m) => m.startsWith("the same client_ref under another kind"))).toBe(true);
    // what stays true under the defect stays green: retries, leagues, null refs, repetition
    expect(v.some((m) => m.startsWith("a retry with the same scope"))).toBe(false);
    expect(v.some((m) => m.startsWith("the same client_ref in another league"))).toBe(false);
    expect(v.some((m) => m.startsWith("a null client_ref"))).toBe(false);
  });

  it("rejects a repository that never deduplicates (idempotency is part of the contract)", () => {
    const v = checkRecordDedupContract(open(() => false));
    expect(v.some((m) => m.startsWith("a retry with the same scope"))).toBe(true);
    expect(v.some((m) => m.startsWith("repeated records of one scope"))).toBe(true);
  });

  it("rejects a repository that overwrites the stored row on a retry", () => {
    const v = checkRecordDedupContract(() => {
      const repo = memoryLog(sameRecordDedupScope);
      const get = repo.get.bind(repo);
      return {
        repo: {
          ...repo,
          get: (id: string) => {
            const r = get(id);
            return r === null ? null : { ...r, rec: { ...r.rec, action: "overwritten" } };
          },
        },
        close: () => undefined,
      };
    });
    expect(v.some((m) => m.includes("overwritten by the retry"))).toBe(true);
  });

  it("reports a throwing repository instead of crashing, and covers every scenario", () => {
    const v = checkRecordDedupContract(() => ({
      repo: {
        ...memoryLog(sameRecordDedupScope),
        record: () => {
          throw new Error("busy");
        },
      },
      close: () => undefined,
    }));
    expect(v).toHaveLength(Object.keys(DEDUP_SCENARIOS).length);
    expect(v.every((m) => m.endsWith("threw busy"))).toBe(true);
    const odd = checkRecordDedupContract(() => ({
      repo: {
        ...memoryLog(sameRecordDedupScope),
        record: () => {
          throw "not an error" as unknown as Error;
        },
      },
      close: () => undefined,
    }));
    expect(odd.every((m) => m.endsWith("threw not an error"))).toBe(true);
  });

  it("the reference repository round-trips outcomes into list items (E14 `followed`)", () => {
    const repo = memoryLog(sameRecordDedupScope);
    const r = repo.record(input(), "2026-10-01T12:00:00.000Z");
    const q = { league_id: "0", season: null, week: null, kind: null, limit: 25, offset: 0 };
    expect(repo.list(q).items[0]!.followed).toBeNull();
    repo.recordOutcome({
      log_id: r.log_id,
      followed: true,
      realised: 20,
      regret: -12,
      decisive: false,
      scored_at: "2026-10-06T12:00:00.000Z",
      week_final: true,
    });
    expect(repo.outcome(r.log_id)?.regret).toBe(-12);
    expect(repo.list(q)).toMatchObject({ total: 1, items: [{ log_id: r.log_id, followed: true }] });
    expect(repo.list({ ...q, league_id: "1" })).toEqual({ items: [], total: 0 });
  });
});
