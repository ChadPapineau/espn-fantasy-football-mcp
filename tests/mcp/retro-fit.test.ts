// retro-fit.test.ts — changelog §R10, R10-20 (plan 07 C8: the 10 000-character analytics budget is
// the contract; "arrays halved with a warning" is its floor, not a limit on how many whole items may
// be kept, as for E14 under plan 01 §4.2): espn_analyze_retrospective keeps the longest prefix of
// whole calls[] that fits, in the tool's own order, after any trims (the keepMost fit 0f57f34 built),
// with `truncated: true` and a warning naming `kinds` — E13 does not page. Every other analytics tool
// keeps halving. Held here on E13's own fit options (define.ts fitOptionsOf over the registered
// definition): a property over call lists (it fits; it is maximal — one more call would not fit; the
// order is kept; truncated only when over), trims run first, and the registry's fit per tool. The
// measured bound (100 worst-case calls through the tool) is in retro-note.test.ts.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fitOptionsOf } from "../../src/mcp/define.js";
import {
  ANALYTICS_BUDGET_CHARS,
  TRUNCATION_HINTS,
  buildEnvelope,
  fitToBudget,
  serializeEnvelope,
  type Envelope,
} from "../../src/mcp/envelope.js";
import { REGISTRY } from "../../src/mcp/registry.js";
import { analyzeRetrospective } from "../../src/mcp/tools/reclog.js";

const NOW = Date.parse("2026-10-06T18:00:00Z");
const RID = "r-0123456789ab";

/** A call row shaped as E13's (its texts at `textChars`, a note or none), numbered `i`. */
function callRow(i: number, textChars: number, note: boolean) {
  const text = '"\\'.repeat(Math.ceil(textChars / 2)).slice(0, textChars);
  return {
    log_id: `rec-${String(i).padStart(4, "0")}`,
    kind: "lineup",
    action: text,
    note: note ? text : null,
    followed: "unknown",
    regret: { value: i % 7, p10: 0, p90: 9 },
    decisive: i % 3 === 0,
  };
}

interface Data {
  week: number;
  calls: ReturnType<typeof callRow>[];
  summary: string;
}

function retroEnv(calls: ReturnType<typeof callRow>[], summaryChars = 300): Envelope<Data> {
  return buildEnvelope({
    data: { week: 3, calls, summary: "s".repeat(summaryChars) },
    requestId: RID,
    nowMs: NOW,
    inputs: [],
  });
}

const options = fitOptionsOf(analyzeRetrospective, {});
const warningFor = (kept: number, total: number): string =>
  `result truncated to ${String(kept)} of ${String(total)} calls to fit the ${String(ANALYTICS_BUDGET_CHARS)}-character budget; ${TRUNCATION_HINTS.retrospective}`;

describe("E13 keeps the longest prefix of whole calls that fits C8's budget (R10-20)", () => {
  it("the registered definition: keepMost, not pageable, the hint naming kinds", () => {
    expect(analyzeRetrospective.budget).toBe("analytics");
    expect(analyzeRetrospective.fit).toBe("most");
    expect(options).toEqual({
      pageable: false,
      hint: TRUNCATION_HINTS.retrospective,
      keepMost: true,
    });
    expect(TRUNCATION_HINTS.retrospective).toContain("kinds");
    expect(TRUNCATION_HINTS.retrospective).toContain("does not page");
  });

  it("property: it fits; it is maximal (one more call would not fit); the order is kept; truncated only when over", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 200 }),
        fc.boolean(),
        fc.integer({ min: 0, max: 3000 }),
        (n, textChars, note, summaryChars) => {
          const calls = Array.from({ length: n }, (_, i) => callRow(i, textChars, note));
          const env = retroEnv(calls, summaryChars);
          const before = serializeEnvelope(env).length;
          const r = fitToBudget(env, ANALYTICS_BUDGET_CHARS, "calls", options);
          if (!r.ok) return false;
          const out = r.envelope;
          const size = serializeEnvelope(out).length;
          const kept = out.data.calls;
          // fits
          if (size > ANALYTICS_BUDGET_CHARS) return false;
          // truncated exactly when the whole answer is over the budget
          if (out.truncated !== before > ANALYTICS_BUDGET_CHARS) return false;
          if (!out.truncated) return kept.length === n && out === env;
          // the tool's own order: a prefix, every kept call whole
          if (JSON.stringify(kept) !== JSON.stringify(calls.slice(0, kept.length))) return false;
          // said, naming the narrowing input; never a paging promise
          if (out.warnings.at(-1) !== warningFor(kept.length, n)) return false;
          if (out.page !== undefined) return false;
          // maximal: the same answer one call longer is over the budget
          const oneMore = serializeEnvelope({
            ...out,
            data: { ...out.data, calls: calls.slice(0, kept.length + 1) },
            warnings: [...env.warnings, warningFor(kept.length + 1, n)],
          }).length;
          return kept.length < n && oneMore > ANALYTICS_BUDGET_CHARS;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("keeps more whole calls than halving where halving overshoots (100 worst-case calls)", () => {
    const calls = Array.from({ length: 100 }, (_, i) => callRow(i, 200, true));
    const env = retroEnv(calls);
    const halved = fitToBudget(env, ANALYTICS_BUDGET_CHARS, "calls", {
      pageable: false,
      hint: TRUNCATION_HINTS.retrospective,
    });
    const most = fitToBudget(env, ANALYTICS_BUDGET_CHARS, "calls", options);
    expect(halved.ok && most.ok).toBe(true);
    if (!halved.ok || !most.ok) return;
    expect(most.envelope.data.calls.length).toBeGreaterThan(halved.envelope.data.calls.length);
    expect(serializeEnvelope(most.envelope).length).toBeLessThanOrEqual(ANALYTICS_BUDGET_CHARS);
  });

  it("trims run first, and the longest prefix follows them", () => {
    const calls = Array.from({ length: 80 }, (_, i) => callRow(i, 120, true));
    const env = retroEnv(calls, 6000);
    const dropSummary = (d: unknown) => {
      const data = d as Data;
      return data.summary === ""
        ? null
        : { data: { ...data, summary: "" }, warning: "summary dropped to fit the budget" };
    };
    const r = fitToBudget(env, ANALYTICS_BUDGET_CHARS, "calls", {
      ...fitOptionsOf(analyzeRetrospective, {}, [dropSummary]),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.data.summary).toBe("");
    expect(r.envelope.warnings).toContain("summary dropped to fit the budget");
    const k = r.envelope.data.calls.length;
    expect(k).toBeGreaterThan(0);
    expect(k).toBeLessThan(80);
    const oneMore = serializeEnvelope({
      ...r.envelope,
      data: { ...r.envelope.data, calls: calls.slice(0, k + 1) },
      warnings: [...r.envelope.warnings.slice(0, -1), warningFor(k + 1, 80)],
    }).length;
    expect(oneMore).toBeGreaterThan(ANALYTICS_BUDGET_CHARS);
  });

  it("every other analytics tool keeps halving; the most-that-fit is E13's and E14's alone", () => {
    const tools = REGISTRY.flatMap((e) => (e.tool === null ? [] : [e.tool]));
    const most = tools.filter((t) => t.fit === "most").map((t) => t.name);
    expect(most.sort()).toEqual(["espn_analyze_retrospective", "espn_list_recommendations"]);
    const halving = tools.filter((t) => t.budget === "analytics" && t.fit !== "most");
    expect(halving.length).toBeGreaterThan(5);
    for (const t of halving) expect(fitOptionsOf(t, {}).keepMost, t.name).toBeUndefined();
  });
});
