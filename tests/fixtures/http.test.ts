// http.test.ts — the one keyless GET used by the probe and the recorder (scripts/espn-fixture/
// http.ts): read host only (never the write host — CLAUDE.md; plan 10 §3.W not built), never a
// cookie, redirects returned not followed (plan 05 §2 http/client), ≥ 1.2 s spacing and a hard cap
// (research 03 §D.3), timeouts and body caps. No network: every fetch is injected.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MIN_INTERVAL_FLOOR_MS,
  READ_HOST,
  RequestRefused,
  TransportError,
  WRITE_HOST,
  defaultSeason,
  isLeagueId,
  leagueUrl,
  politeClient,
  repoUrl,
  seasonUrl,
  userAgent,
} from "../../scripts/espn-fixture/http.js";

function recorder(
  make: (url: string) => Response | Error = () => new Response("{}", { status: 200 }),
) {
  const calls: { url: string; init: RequestInit }[] = [];
  let t = 0;
  const waits: number[] = [];
  return {
    calls,
    waits,
    opts: {
      fetch: (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const r = make(url);
        return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
      },
      now: () => t,
      sleep: (ms: number) => {
        waits.push(ms);
        t += ms;
        return Promise.resolve();
      },
    },
  };
}

const OK = `https://${READ_HOST}/apis/v3/games/ffl/seasons/2026?view=proTeamSchedules_wl`;

describe("politeClient — refusals before any I/O", () => {
  const refused = [
    `https://${WRITE_HOST}/apis/v3/games/ffl/seasons/2026/segments/0/leagues/0/transactions/`,
    "http://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026",
    "https://fantasy.espn.com/apis/v3/games/ffl/seasons/2026",
    "https://www.espn.com/fantasy/",
    `https://${READ_HOST}.evil.example/x`,
    `https://${READ_HOST}:8443/x`,
    `https://user:pw@${READ_HOST}/x`,
    "not a url",
    "file:///etc/passwd",
  ];
  it.each(refused)("refuses %s", async (url) => {
    const r = recorder();
    await expect(politeClient(r.opts).get(url)).rejects.toBeInstanceOf(RequestRefused);
    expect(r.calls).toHaveLength(0);
  });

  it("the write host is refused by name, unconditionally", async () => {
    const r = recorder();
    await expect(politeClient(r.opts).get(`https://${WRITE_HOST}/`)).rejects.toThrow(
      /write host is never contacted/,
    );
  });

  it("enforces the hard request cap", async () => {
    const r = recorder();
    const c = politeClient({ ...r.opts, maxRequests: 2 });
    await c.get(OK);
    await c.get(OK);
    await expect(c.get(OK)).rejects.toThrow(/request cap reached/);
    expect(r.calls).toHaveLength(2);
    expect(c.count()).toBe(2);
  });
});

describe("politeClient — every request is keyless, honest and polite", () => {
  it("sends only accept, user-agent and (when given) x-fantasy-filter; GET; redirect manual", async () => {
    const r = recorder();
    const c = politeClient({ ...r.opts, userAgent: userAgent("test") });
    await c.get(OK);
    await c.get(OK, {
      filter: { players: { limit: 5, sortPercOwned: { sortPriority: 1, sortAsc: false } } },
    });
    for (const call of r.calls) {
      const h = new Headers(call.init.headers);
      const names = [...h.keys()].sort();
      expect(names.every((n) => ["accept", "user-agent", "x-fantasy-filter"].includes(n))).toBe(
        true,
      );
      expect(h.has("cookie")).toBe(false);
      expect(h.has("authorization")).toBe(false);
      expect(call.init.method).toBe("GET");
      expect(call.init.redirect).toBe("manual");
      expect(call.init.credentials).toBe("omit");
    }
    expect(new Headers(r.calls[1]?.init.headers).get("x-fantasy-filter")).toBe(
      JSON.stringify({ players: { limit: 5, sortPercOwned: { sortPriority: 1, sortAsc: false } } }),
    );
  });

  it("spaces request starts ≥ 1200 ms, and a lower minIntervalMs cannot go under the floor", async () => {
    const r = recorder();
    const c = politeClient({ ...r.opts, minIntervalMs: 10 });
    await c.get(OK);
    await c.get(OK);
    await c.get(OK);
    expect(r.waits).toEqual([MIN_INTERVAL_FLOOR_MS, MIN_INTERVAL_FLOOR_MS]);
    const s = recorder();
    const slow = politeClient({ ...s.opts, minIntervalMs: 3000 });
    await slow.get(OK);
    await slow.get(OK);
    expect(s.waits).toEqual([3000]);
  });

  it("returns a 3xx as-is (never followed) with its headers lower-cased", async () => {
    const r = recorder(
      () =>
        new Response("Redirecting", {
          status: 302,
          headers: { Location: "https://www.espn.com/fantasy/" },
        }),
    );
    const res = await politeClient(r.opts).get(OK);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://www.espn.com/fantasy/");
    expect(res.bodyText).toBe("Redirecting");
    expect(res.url).toBe(OK);
  });

  it("the User-Agent names the tool, its version and the public repo — never a browser", () => {
    const ua = userAgent("drift probe");
    expect(ua).toMatch(
      /^espn-fantasy-football-mcp\/\d+\.\d+\.\d+ \(drift probe; \+https:\/\/github\.com\/[\w-]+\/espn-fantasy-football-mcp\)$/,
    );
    expect(ua).not.toMatch(/Mozilla|Chrome|Safari/);
    expect(repoUrl()).toMatch(/^https:\/\/github\.com\//);
  });
});

describe("politeClient — transport failures are typed", () => {
  it("timeout and network errors", async () => {
    const t = recorder(() => Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    await expect(politeClient(t.opts).get(OK)).rejects.toMatchObject({ kind: "timeout" });
    const a = recorder(() => Object.assign(new Error("aborted"), { name: "AbortError" }));
    await expect(politeClient(a.opts).get(OK)).rejects.toMatchObject({ kind: "timeout" });
    const n = recorder(() => new TypeError("fetch failed"));
    const e = await politeClient(n.opts)
      .get(OK)
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TransportError);
    expect((e as TransportError).kind).toBe("network");
  });

  it("a body over the cap is refused — declared or streamed", async () => {
    const declared = recorder(
      () => new Response("x", { status: 200, headers: { "content-length": "999999999" } }),
    );
    await expect(
      politeClient({ ...declared.opts, maxBodyBytes: 1024 }).get(OK),
    ).rejects.toMatchObject({ kind: "too_large" });
    const big = "x".repeat(5000);
    const streamed = recorder(() => new Response(new Blob([big]).stream(), { status: 200 }));
    await expect(
      politeClient({ ...streamed.opts, maxBodyBytes: 1024 }).get(OK),
    ).rejects.toMatchObject({ kind: "too_large" });
    const fits = recorder(() => new Response(big, { status: 200 }));
    expect((await politeClient({ ...fits.opts, maxBodyBytes: 5000 }).get(OK)).bytes).toBe(5000);
  });

  it("a body-less response reads as empty; invalid UTF-8 does not throw", async () => {
    const r = recorder(() => new Response(null, { status: 204 }));
    expect((await politeClient(r.opts).get(OK)).bodyText).toBe("");
    const bad = recorder(() => new Response(new Uint8Array([0xff, 0xfe, 0x7b]), { status: 200 }));
    expect((await politeClient(bad.opts).get(OK)).bytes).toBe(3);
  });
});

describe("URL builders and validators", () => {
  it("builds the two routes with repeated view params", () => {
    expect(seasonUrl(2026, ["proTeamSchedules_wl"])).toBe(
      `https://${READ_HOST}/apis/v3/games/ffl/seasons/2026?view=proTeamSchedules_wl`,
    );
    const u = new URL(leagueUrl(2026, "0", ["mTeam", "mStandings"], { scoringPeriodId: "3" }));
    expect(u.pathname).toBe("/apis/v3/games/ffl/seasons/2026/segments/0/leagues/0");
    expect(u.searchParams.getAll("view")).toEqual(["mTeam", "mStandings"]);
    expect(u.searchParams.get("scoringPeriodId")).toBe("3");
  });

  it("a league id is digits only — no path or query injection", () => {
    for (const bad of ["../1", "1?view=x", "1/../../x", "-1", "1e5", " 1", ""])
      expect(() => leagueUrl(2026, bad, ["mSettings"])).toThrow();
    fc.assert(
      fc.property(fc.string(), (s) => {
        if (!/^\d{1,12}$/.test(s)) expect(() => leagueUrl(2026, s, ["mSettings"])).toThrow();
      }),
    );
    expect(isLeagueId("0")).toBe(false);
    expect(isLeagueId("0123")).toBe(false);
    expect(isLeagueId("1".repeat(13))).toBe(false);
    expect(isLeagueId("4")).toBe(true);
  });

  it("the default season rolls over in June", () => {
    expect(defaultSeason(new Date("2026-05-31T23:00:00Z"))).toBe(2025);
    expect(defaultSeason(new Date("2026-06-01T00:00:00Z"))).toBe(2026);
    expect(defaultSeason(new Date("2027-01-15T00:00:00Z"))).toBe(2026);
  });
});
