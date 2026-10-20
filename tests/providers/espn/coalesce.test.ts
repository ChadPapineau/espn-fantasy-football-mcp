// coalesce.test.ts — concurrent identical ESPN reads share ONE request (plan 01 §5.3) while every call
// keeps its own deadline and cancellation (plan 01 §6, ADV OBJ-20). Stage C finding
// espn-coalesced-read-leader-budget: the shared read ran under the first caller's budget, so
// cancelling that call — or that call being near its deadline — failed a parallel call that was
// never cancelled. Real (short) timers; an injected fetch; no network.
import { describe, expect, it } from "vitest";
import {
  createUpstreamBudget,
  isUpstreamBudgetExhausted,
  PER_CALL_DEADLINE_MS,
} from "../../../src/providers/platform.js";
import type { FetchLike } from "../../../src/providers/espn/transport.js";
import { jsonResponse, loadFixture, makeWorld, SEASON } from "./helpers.js";

const body = (): unknown => loadFixture("recorded/season/proTeamSchedules_wl.json");

/** ESPN answering after `ms` of real time, honouring the request's abort (as fetch does). */
function slow(ms: number): FetchLike & { calls: number; aborted: number } {
  const f = Object.assign(
    (_url: string, init: RequestInit): Promise<Response> =>
      new Promise<Response>((resolve, reject) => {
        f.calls++;
        const t = setTimeout(() => {
          resolve(jsonResponse(body()));
        }, ms);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          f.aborted++;
          reject(new DOMException("This operation was aborted", "AbortError"));
        });
      }),
    { calls: 0, aborted: 0 },
  );
  return f;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const RID = "r-0123456789ab";

describe("a coalesced read keeps every caller's own limits", () => {
  it("cancelling the first call does not fail a parallel call: one request, the other gets the data", async () => {
    const fetch = slow(60);
    const w = makeWorld({ fetch });
    const a = createUpstreamBudget(RID, w.clock.nowMs());
    const b = createUpstreamBudget(RID, w.clock.nowMs());
    const pa = w.provider.getProSchedule(SEASON, { budget: a }).catch((e: unknown) => e);
    const pb = w.provider.getProSchedule(SEASON, { budget: b });
    await sleep(10);
    a.abort();
    expect(await pa).toMatchObject({
      effCode: "ESPN_UPSTREAM_UNAVAILABLE",
      effDetails: { reason: "aborted" },
    });
    const rb = await pb;
    expect(rb.stamp.cache).toBe("coalesced");
    expect(rb.value.teams.length).toBeGreaterThan(0);
    expect(fetch.calls).toBe(1);
    expect(fetch.aborted).toBe(0);
    // the request was paid once, by the call that started it
    expect(a.used()).toBe(1);
    expect(b.used()).toBe(0);
    expect(w.limiter.rows.map((r) => r.outcome)).toEqual(["ok"]);
  });

  it("the first call near its deadline does not cut the request short for a parallel call", async () => {
    const fetch = slow(300);
    const w = makeWorld({ fetch });
    // 100 ms left of the first call's 20 s; the second has the whole window
    const a = createUpstreamBudget(RID, w.clock.nowMs() - (PER_CALL_DEADLINE_MS - 100));
    const b = createUpstreamBudget(RID, w.clock.nowMs());
    const t0 = Date.now();
    const pa = w.provider.getProSchedule(SEASON, { budget: a }).catch((e: unknown) => ({
      e,
      at: Date.now() - t0,
    }));
    const pb = w.provider.getProSchedule(SEASON, { budget: b });
    const ra = await pa;
    // the first call stops at ITS deadline, with what it would have had alone
    expect((ra as { e: unknown }).e).toMatchObject({
      effCode: "ESPN_UPSTREAM_UNAVAILABLE",
      effDetails: { reason: "attempt_timeout" },
    });
    expect((ra as { at: number }).at).toBeLessThan(290);
    const rb = await pb;
    expect(rb.value.teams.length).toBeGreaterThan(0);
    expect(fetch.calls).toBe(1);
    expect(fetch.aborted).toBe(0);
    // the attempt had the second call's time, not the first call's 100 ms: it was answered
    expect(w.limiter.rows.map((r) => r.outcome)).toEqual(["ok"]);
  });

  it("a joiner's cancellation does not fail the call that started the read", async () => {
    const fetch = slow(60);
    const w = makeWorld({ fetch });
    const a = createUpstreamBudget(RID, w.clock.nowMs());
    const b = createUpstreamBudget(RID, w.clock.nowMs());
    const pa = w.provider.getProSchedule(SEASON, { budget: a });
    const pb = w.provider.getProSchedule(SEASON, { budget: b }).catch((e: unknown) => e);
    await sleep(10);
    b.abort();
    expect(await pb).toMatchObject({ effDetails: { reason: "aborted" } });
    const ra = await pa;
    expect(ra.stamp.cache).toBe("miss");
    expect(fetch.calls).toBe(1);
  });

  it("a joiner whose deadline comes first stops at its own deadline; the read goes on", async () => {
    const fetch = slow(300);
    const w = makeWorld({ fetch });
    const a = createUpstreamBudget(RID, w.clock.nowMs());
    const b = createUpstreamBudget(RID, w.clock.nowMs() - (PER_CALL_DEADLINE_MS - 100));
    const pa = w.provider.getProSchedule(SEASON, { budget: a });
    const t0 = Date.now();
    const pb = w.provider
      .getProSchedule(SEASON, { budget: b })
      .catch((e: unknown) => ({ e, at: Date.now() - t0 }));
    const rb = (await pb) as { e: unknown; at: number };
    expect(rb.e).toMatchObject({ effDetails: { reason: "attempt_timeout" } });
    expect(rb.at).toBeLessThan(290);
    await expect(pa).resolves.toBeTruthy();
    expect(fetch.calls).toBe(1);
  });

  it("every caller gone: the request is aborted, its row is no verdict, and the next call starts its own", async () => {
    let delay = 5_000;
    const inner = slow(0);
    const fetch = Object.assign(
      (url: string, init: RequestInit): Promise<Response> => {
        const f = slow(delay);
        const p = f(url, init);
        inner.calls += f.calls;
        // count the abort the moment it happens
        init.signal?.addEventListener("abort", () => {
          inner.aborted++;
        });
        return p;
      },
      { inner },
    );
    const w = makeWorld({ fetch });
    const a = createUpstreamBudget(RID, w.clock.nowMs());
    const b = createUpstreamBudget(RID, w.clock.nowMs());
    const pa = w.provider.getProSchedule(SEASON, { budget: a }).catch((e: unknown) => e);
    const pb = w.provider.getProSchedule(SEASON, { budget: b }).catch((e: unknown) => e);
    await sleep(10);
    a.abort();
    await sleep(5);
    expect(fetch.inner.aborted).toBe(0);
    b.abort();
    await pa;
    await pb;
    await sleep(5);
    expect(fetch.inner.aborted).toBe(1);
    expect(w.limiter.rows.map((r) => r.outcome)).toEqual(["client_error"]);
    expect(w.sleeps).toEqual([]);
    expect(w.provider.transportStatus().consecutive_failures).toBe(0);
    // the same provider's next call is never handed the aborted read: it starts its own
    delay = 5;
    w.clock.advance(1000);
    const again = await w.provider.getProSchedule(SEASON);
    expect(again.stamp.cache).toBe("miss");
    expect(fetch.inner.calls).toBe(2);
  });

  it("a call already past its deadline takes part in no read (partial), and pays nothing", async () => {
    const fetch = slow(60);
    const w = makeWorld({ fetch });
    const a = createUpstreamBudget(RID, w.clock.nowMs());
    const late = createUpstreamBudget(RID, w.clock.nowMs() - PER_CALL_DEADLINE_MS - 1);
    const pa = w.provider.getProSchedule(SEASON, { budget: a });
    const e = await w.provider.getProSchedule(SEASON, { budget: late }).catch((x: unknown) => x);
    expect(isUpstreamBudgetExhausted(e)).toBe(true);
    expect((e as { missing: unknown }).missing).toEqual({
      view: "proTeamSchedules_wl",
      reason: "deadline",
    });
    expect(late.used()).toBe(0);
    await expect(pa).resolves.toBeTruthy();
    expect(fetch.calls).toBe(1);
  });

  it("a joiner needs no budget of its own to spare: only the call that starts a read pays", async () => {
    const fetch = slow(30);
    const w = makeWorld({ fetch });
    const a = createUpstreamBudget(RID, w.clock.nowMs());
    const spent = createUpstreamBudget(RID, w.clock.nowMs(), 0);
    const pa = w.provider.getProSchedule(SEASON, { budget: a });
    const rb = await w.provider.getProSchedule(SEASON, { budget: spent });
    expect(rb.stamp.cache).toBe("coalesced");
    await pa;
    // alone, the same spent budget cannot start a read
    const w2 = makeWorld({ fetch: slow(1) });
    const alone = await w2.provider
      .getProSchedule(SEASON, { budget: createUpstreamBudget(RID, w2.clock.nowMs(), 0) })
      .catch((x: unknown) => x);
    expect((alone as { missing: unknown }).missing).toEqual({
      view: "proTeamSchedules_wl",
      reason: "budget",
    });
  });
});
