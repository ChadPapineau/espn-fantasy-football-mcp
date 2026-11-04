// unsent-budget.test.ts — changelog §R10, R10-19 ("the budget is charged only when a request is
// about to be sent"; plan 01 §5.6's ≤ 3 counts upstream requests) and the round-4 verifier's V4-M2.
// The call's budget was charged before the limiter, and given back only for the cookie gate's
// in-flight refusal on a first attempt: a read our own pipeline refused before anything went out —
// the limiter's full window (or its concurrency or daily cap), ESPN's Retry-After hold met inside the
// read, the TLS policy — still spent one of the three, and a later read of the call reported "the
// 3-request budget of this call was used" with no request made. Now a read that ends before any
// attempt was handed to the transport gives its charge back, whatever refused it; one that sent an
// attempt keeps it (a retry is not a new request). The fake transport and the in-memory ports; the
// cookies are synthetic test values. No network.
import { describe, expect, it } from "vitest";
import type { CookieHeaderResult } from "../../../src/auth/types.js";
import type { FetchLike } from "../../../src/providers/espn/index.js";
import { createUpstreamBudget, UpstreamBudgetExhausted } from "../../../src/providers/platform.js";
import { FakeAuthority, jsonResponse, makeWorld, testCookieHeader } from "./helpers.js";

const RID = "r-0123456789ab";
const SWID = "{00000000-0000-4000-8000-000000000051}";

/** What a read ended with: "ok", the budget signal's reason, or the error code. */
async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof UpstreamBudgetExhausted) return `budget:${e.missing.reason}`;
    return String((e as { effCode?: string }).effCode);
  }
}

describe("V4-M2: a read refused before anything is sent spends none of the call's budget", () => {
  it("a full 30/min window: every read is the limiter's RATE_LIMITED, never the budget's, nothing sent", async () => {
    const w = makeWorld();
    const now = w.clock.nowMs();
    // 30 rows in the last minute, the oldest freeing past the call's 20 s deadline
    for (let i = 0; i < 30; i++)
      w.limiter.rows.push({
        id: 1000 + i,
        at: now - 2000,
        keyless: true,
        origin: "server",
        outcome: "ok",
      });
    const budget = createUpstreamBudget(RID, now);
    const codes = [
      await code(w.provider.getLeague(w.ref, { budget })),
      await code(w.provider.getStandings(w.ref, { budget })),
      await code(w.provider.getMatchups(w.ref, { budget })),
      await code(w.provider.getRosters(w.ref, 3, { budget })),
    ];
    expect(codes).toEqual(["RATE_LIMITED", "RATE_LIMITED", "RATE_LIMITED", "RATE_LIMITED"]);
    expect(w.sent).toEqual([]);
    expect(budget.used()).toBe(0);
  });

  it("the TLS policy's refusal gives the charge back", async () => {
    const w = makeWorld({ over: { tlsVerificationDisabled: () => true } });
    const budget = createUpstreamBudget(RID, w.clock.nowMs());
    for (let i = 0; i < 4; i++) {
      const c = await code(w.provider.getLeague(w.ref, { budget }));
      expect(c).not.toMatch(/^budget:/);
    }
    expect(w.sent).toEqual([]);
    expect(budget.used()).toBe(0);
  });

  it("ESPN's Retry-After hold set while the read asked the cookie gate gives the charge back", async () => {
    let throttle = false;
    const fetch: FetchLike = (url) => {
      if (throttle && !url.includes("/leagues/"))
        return Promise.resolve(jsonResponse({ m: 1 }, 429, { "retry-after": "300" }));
      return Promise.resolve(jsonResponse({ messages: ["x"] }, 503));
    };
    // the gate's ask awaits another read of the process, whose answer sets ESPN's hold
    class HoldingAuthority extends FakeAuthority {
      hook: (() => Promise<void>) | null = null;
      override async getCookieHeader(): Promise<CookieHeaderResult> {
        const h = this.hook;
        this.hook = null;
        if (h !== null) await h();
        return super.getCookieHeader();
      }
    }
    const auth = new HoldingAuthority("stored", { ok: true, header: testCookieHeader(SWID) });
    const w = makeWorld({ credentials: auth, fetch });
    auth.hook = async () => {
      throttle = true;
      await code(w.provider.getProSchedule(2026));
    };
    const budget = createUpstreamBudget(RID, w.clock.nowMs());
    const n = () => w.sent.filter((s) => s.url.includes("/leagues/")).length;
    expect(await code(w.provider.getRosters(w.ref, 3, { budget }))).toBe("RATE_LIMITED");
    expect(n()).toBe(0);
    expect(budget.used()).toBe(0);
  });

  it("control: a read that sent an attempt keeps its charge, its retries included (one request)", async () => {
    // (three real requests and a 4th that gets the budget signal: refused-budget.test.ts)
    const w = makeWorld({ fetch: () => Promise.resolve(jsonResponse({ messages: ["x"] }, 503)) });
    const budget = createUpstreamBudget(RID, w.clock.nowMs());
    expect(await code(w.provider.getLeague(w.ref, { budget }))).toBe("ESPN_UPSTREAM_UNAVAILABLE");
    expect(w.sent.length).toBeGreaterThan(1);
    expect(budget.used()).toBe(1);
  });
});
