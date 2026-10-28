// clock-step-back.test.ts — the in-process holds after a backward clock correction, at the tool level
// (Stage C finding store-future-stamped-rows-block, its in-process residual; plan 01 §6: the limiter
// is a rate, never a blackout; plan 07 G2: espn_check_auth at most once a minute). The store's rows
// were already re-stamped (src/store/repos/skew.ts); three instants a process holds in memory were
// not: the breaker's open window (`Breaker.isOpen` tested only `now < openUntil`), ESPN's Retry-After
// hold (`holdLeftMs` returned `until − now`), and the credential check's last run. Set while the
// Mac's clock ran 3 h fast, each held for the size of the skew after NTP stepped it back: the
// verifier's repro showed the breaker still open 60 min after the correction (control: 5 min) and a
// 120 s Retry-After read back as 10 921 s. Fixture world on league-b with a fault-injecting fetch;
// no network, no cookie.
import { describe, expect, it } from "vitest";
import { ESPN_BREAKER } from "../../src/config/schema.js";
import type { FetchLike } from "../../src/http/client.js";
import { call, connect, makeWorld } from "./helpers/world.js";

const HOUR = 3_600_000;
const MIN = 60_000;

type Mode = "ok" | "503" | "429";

function faulty(state: { mode: Mode }) {
  return (inner: FetchLike): FetchLike =>
    async (url, init) => {
      if (state.mode === "503")
        return new Response("down", { status: 503, headers: { "content-type": "text/plain" } });
      if (state.mode === "429")
        return new Response("slow", {
          status: 429,
          headers: { "content-type": "text/plain", "retry-after": "120" },
        });
      return inner(url, init);
    };
}

interface ErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly reason?: string;
    readonly retry_after_s?: number;
  };
}

describe("holds set while the clock ran 3 h fast, after the clock is set back", () => {
  it("the breaker: open its own 5 min from the correction at the most, then ESPN is read again", async () => {
    const state = { mode: "ok" as Mode };
    const world = await makeWorld({ league: "league-b", wrapFetch: faulty(state) });
    const { client, close } = await connect(world);
    try {
      const base = world.clock.nowMs();
      world.clock.set(base + 3 * HOUR);
      state.mode = "503";
      for (let i = 0; i < 4; i++) await call(client, "espn_get_league", { force_refresh: true });
      const open = await call(client, "espn_get_league", { force_refresh: true });
      expect((open.body as ErrorBody).error?.code).toBe("ESPN_UPSTREAM_UNAVAILABLE");
      state.mode = "ok";
      world.clock.set(base); // NTP steps the clock back
      const st = await call(client, "espn_get_status", {});
      expect(st.isError).toBe(false);
      expect((st.body.data as { limiter: { breaker_open: boolean } }).limiter.breaker_open).toBe(
        true,
      );
      // open from the correction for its own window at the most (it read 3 h 5 min before)
      const until = Date.parse(world.services.transport().breaker_open_until ?? "");
      expect(until).toBeLessThanOrEqual(world.clock.nowMs() + ESPN_BREAKER.openMs);
      world.clock.set(base + ESPN_BREAKER.openMs + MIN);
      const r0 = world.requests.length;
      const after = await call(client, "espn_get_league", {});
      expect(after.isError, JSON.stringify(after.body).slice(0, 300)).toBe(false);
      expect(world.requests.length).toBeGreaterThan(r0);
    } finally {
      await close();
      world.cleanup();
    }
  }, 120_000);

  it("ESPN's Retry-After: 120 s from the correction at the most, then ESPN is read again", async () => {
    const state = { mode: "ok" as Mode };
    const world = await makeWorld({ league: "league-b", wrapFetch: faulty(state) });
    const { client, close } = await connect(world);
    try {
      const base = world.clock.nowMs();
      world.clock.set(base + 3 * HOUR);
      state.mode = "429";
      const fast = await call(client, "espn_get_league", { force_refresh: true });
      expect((fast.body as ErrorBody).error?.code).toBe("RATE_LIMITED");
      state.mode = "ok";
      world.clock.set(base);
      const held = await call(client, "espn_get_league", { force_refresh: true });
      const e = (held.body as ErrorBody).error;
      expect(e?.code).toBe("RATE_LIMITED");
      expect(e?.reason).toBe("retry_after");
      // the verifier read 10 921 s here
      expect(e?.retry_after_s).toBeLessThanOrEqual(120);
      world.clock.set(base + 3 * MIN);
      const r0 = world.requests.length;
      const after = await call(client, "espn_get_league", { force_refresh: true });
      expect(after.isError, JSON.stringify(after.body).slice(0, 300)).toBe(false);
      expect(world.requests.length).toBeGreaterThan(r0);
    } finally {
      await close();
      world.cleanup();
    }
  }, 120_000);

  it("espn_check_auth: the next check is at most a minute after the correction, never 3 h", async () => {
    const world = await makeWorld({ publishEspn: false });
    const { client, close } = await connect(world);
    try {
      const base = world.clock.nowMs();
      world.clock.set(base + 3 * HOUR);
      expect((await call(client, "espn_check_auth", {})).isError).toBe(false);
      world.clock.set(base);
      const again = await call(client, "espn_check_auth", {});
      const e = (again.body as ErrorBody).error;
      expect(e?.code).toBe("RATE_LIMITED");
      expect(e?.retry_after_s).toBeLessThanOrEqual(60);
      world.clock.advance(61_000);
      expect((await call(client, "espn_check_auth", {})).isError).toBe(false);
    } finally {
      await close();
      world.cleanup();
    }
  }, 60_000);
});
