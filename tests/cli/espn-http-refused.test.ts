// espn-http-refused.test.ts — a body the http client REFUSES is an unanswered request (plan 01 §6:
// bounded bodies; plan 01 §7: only a 3xx or a non-JSON answer is a host move; plan 03 §2.1 steps 5–6:
// setup's checks). Stage C finding cli-espn-refused-body-reads-as-200: espnRequest returned every
// HttpError carrying a status as an answered request with an empty body, so a 200 over the 8 MB cap
// (`too_large`) or a gzip that does not decode (`decode`) read as host_moved to the probe, as
// accepted cookies to setup, as no owned team to the team resolution, and as a schema mismatch to
// the season source. No request leaves the process: an injected fetch answers.
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { HttpError } from "../../src/http/errors.js";
import { createHttpClient } from "../../src/http/client.js";
import { createSetupNetwork, espnRequest, seasonGet } from "../../src/cli/espn-http.js";
import { hostProbe } from "../../src/cli/probe.js";
import { loadLenientRuntime } from "../../src/cli/runtime.js";
import { openStore } from "../../src/cli/store-access.js";
import type { CookieHeader } from "../../src/auth/types.js";
import { fakeFetch, makeIo, movingClock, sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox;
afterEach(() => {
  sb.cleanup();
});

const URL_S =
  "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026?view=proTeamSchedules_wl";

/** ≈ 9 MB of valid JSON, answered 200 (over the client's 8 MB cap). */
function oversized(): Response {
  const body = JSON.stringify({ settings: { proTeams: [], pad: "x".repeat(9 * 1024 * 1024) } });
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

/** A 200 declared gzip whose bytes start with the gzip magic but do not decode. */
function undecodable(): Response {
  const good = gzipSync(Buffer.from(JSON.stringify({ settings: { proTeams: [] } })));
  const broken = Buffer.concat([good.subarray(0, 10), Buffer.alloc(64, 0xff)]);
  return new Response(broken, {
    status: 200,
    headers: { "content-type": "application/json", "content-encoding": "gzip" },
  });
}

async function world(answer: () => Response) {
  sb = sandbox();
  const f = fakeFetch(() => answer());
  const io = makeIo(sb, { fetch: f.fetch, clock: movingClock() });
  const { config, log } = await loadLenientRuntime(io);
  const store = openStore(config, io.clock, log, { migrate: true });
  const deps = {
    http: createHttpClient({ fetch: f.fetch }),
    limiter: store.repos.limiter,
    clock: io.clock,
    origin: "server" as const,
  };
  return { io, store, deps };
}

describe("a refused body is an unanswered request, never an empty 200", () => {
  for (const [name, answer, kind] of [
    ["over the size cap", oversized, "too_large"],
    ["a gzip that does not decode", undecodable, "decode"],
  ] as const)
    it(`${name}: espnRequest, the probe, setup's checks and the season source all see '${kind}'`, async () => {
      const { store, deps, io } = await world(answer);
      try {
        expect(await espnRequest(deps, { url: URL_S, cookie: null })).toEqual({ error: kind });
        // the limiter row records no answer (the breaker view never reads it as a success)
        const probe = await hostProbe(
          { ...deps, host: "lm-api-reads.fantasy.espn.com", observations: undefined },
          2026,
        );
        expect([probe.status, probe.reason]).toEqual(["unreachable", kind]);
        const net = createSetupNetwork(deps, {
          host: "lm-api-reads.fantasy.espn.com",
          season: 2026,
          leagueId: "0",
        });
        const header = "SWID={00000000-0000-4000-8000-000000000001}" as unknown as CookieHeader;
        expect(await net.settingsWithCookies(header)).toEqual({ error: kind });
        expect(await net.anonymousSettings()).toEqual({ error: kind });
        expect(await net.boardWithCookies(header)).toEqual({ error: kind });
        expect(await net.resolveTeam(header, "{00000000-0000-4000-8000-000000000001}")).toEqual({
          kind: "error",
          code: kind,
        });
        const get = seasonGet({ ...deps, clock: io.clock });
        const err = await get(URL_S, {
          maxBytes: 8 * 1024 * 1024,
          signal: new AbortController().signal,
        }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).kind).toBe(kind);
      } finally {
        store.close();
      }
    });

  it("an error status ESPN answered is still an answered request (its body not kept)", async () => {
    const { store, deps } = await world(() => new Response("{}", { status: 503 }));
    try {
      expect(await espnRequest(deps, { url: URL_S, cookie: null })).toMatchObject({ status: 503 });
    } finally {
      store.close();
    }
  });
});
