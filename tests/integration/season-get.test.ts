// season-get.test.ts — the GET `eff refresh` hands the keyless ESPN season sources
// (src/cli/espn-http.ts seasonGet; plan 06 §1.4 the jobs' keyless cap; plan 01 §6 the
// cross-process limiter): every request is one limiter row recorded as a keyless JOB request with
// its outcome; the players_wl filter is forwarded; no cookie is ever sent; a non-2xx answer or a
// limiter refusal becomes the HttpError the refresh runner classifies, and a limiter that cannot
// record sends nothing.
import { describe, expect, it } from "vitest";
import { seasonGet } from "../../src/cli/espn-http.js";
import { fixedClock } from "../../src/domain/clock.js";
import { HttpError } from "../../src/http/errors.js";
import { MemoryLimiterRepo } from "../providers/espn/helpers.js";

const URL0 =
  "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026?view=proTeamSchedules_wl";
const opts = { signal: new AbortController().signal, maxBytes: 1024 };

type Answer = { status: number; body?: string } | Error;
function makeGet(answer: Answer, limiter = new MemoryLimiterRepo()) {
  const sent: { url: string; cookie: unknown; filter: unknown }[] = [];
  const http = {
    espnGet: (url: string, o: { cookie: unknown; fantasyFilter?: string }) => {
      sent.push({ url, cookie: o.cookie, filter: o.fantasyFilter });
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve({
        status: answer.status,
        body: new TextEncoder().encode(answer.body ?? "{}"),
        headers: { "content-type": "application/json" },
        final_url: url,
        cookie_sent: false,
      });
    },
  };
  const get = seasonGet({
    http: http as never,
    limiter,
    clock: fixedClock("2026-10-06T12:00:00.000Z"),
    origin: "job",
    sleep: () => Promise.resolve(),
  });
  return { get, sent, limiter };
}

describe("seasonGet", () => {
  it("a 200: one keyless job row recorded ok; the filter forwarded; no cookie", async () => {
    const { get, sent, limiter } = makeGet({ status: 200, body: '{"a":1}' });
    const r = await get(URL0, { ...opts, fantasyFilter: '{"filterActive":{"value":true}}' });
    expect(r.status).toBe(200);
    expect(new TextDecoder().decode(r.body)).toBe('{"a":1}');
    expect(sent).toEqual([{ url: URL0, cookie: null, filter: '{"filterActive":{"value":true}}' }]);
    expect(limiter.rows).toMatchObject([{ keyless: true, origin: "job", outcome: "ok" }]);
  });

  it.each<[number, string]>([
    [404, "http_4xx"],
    [429, "rate_limited"],
    [503, "http_5xx"],
  ])("a %s answer is an ESPN HttpError (%s) carrying its status", async (status, kind) => {
    const { get } = makeGet({ status });
    const e = await get(URL0, opts).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect(e).toMatchObject({ kind, status, espn: true });
  });

  it("the jobs' daily keyless cap refuses before anything is sent (RATE_LIMITED)", async () => {
    const { get, sent, limiter } = makeGet({ status: 200 });
    for (let i = 0; i < 30; i++)
      limiter.rows.push({
        id: 1000 + i,
        at: Date.parse("2026-10-06T01:00:00.000Z") + i * 61_000,
        keyless: true,
        origin: "job",
        outcome: "ok",
      });
    const e = await get(URL0, opts).catch((x: unknown) => x);
    expect(e).toMatchObject({ kind: "quota_exhausted", effCode: "RATE_LIMITED" });
    expect(sent).toEqual([]);
  });

  it("a limiter that cannot record sends nothing (a plain error → INTERNAL in the runner)", async () => {
    const limiter = new MemoryLimiterRepo();
    limiter.failWrites = true;
    const { get, sent } = makeGet({ status: 200 }, limiter);
    const e = await get(URL0, opts).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(HttpError);
    expect(sent).toEqual([]);
  });

  it("transport failures keep their kind; a redirect is a host move; anything else is a network failure", async () => {
    const dns = makeGet(
      new HttpError({ kind: "dns", host: "lm-api-reads.fantasy.espn.com", espn: true }),
    );
    expect(await dns.get(URL0, opts).catch((x: unknown) => x)).toMatchObject({
      kind: "dns",
      espn: true,
    });
    const moved = makeGet(
      new HttpError({
        kind: "redirect_refused",
        host: "lm-api-reads.fantasy.espn.com",
        espn: true,
      }),
    );
    expect(await moved.get(URL0, opts).catch((x: unknown) => x)).toMatchObject({
      kind: "redirect_refused",
      effCode: "ESPN_HOST_MOVED",
    });
    const other = makeGet(new TypeError("fetch failed"));
    expect(await other.get(URL0, opts).catch((x: unknown) => x)).toMatchObject({
      kind: "network",
      espn: true,
    });
    expect(other.limiter.rows[0]?.outcome).toBe("network_error");
  });

  it("the per-second window: a second request waits, a third over the window is refused as rate limited", async () => {
    const { get, limiter } = makeGet({ status: 200 });
    await get(URL0, opts);
    // the in-memory limiter's clock does not advance: the second request in the same second waits once, then is refused
    const e = await get(URL0, opts).catch((x: unknown) => x);
    expect(e).toMatchObject({ kind: "rate_limited", effCode: "RATE_LIMITED" });
    expect(limiter.rows).toHaveLength(1);
  });
});
