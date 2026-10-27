// user-agent.test.ts — Stage C remediation, round 3 (finding espn-user-agent-two-policies; plan 01 §6
// "Identification: User-Agent: espn-fantasy-football-mcp/<version> (+<repo URL>), fixed and honest";
// plan 05 §4.1 "the User-Agent is the fixed string"). Before, one install showed ESPN two identities:
// the provider sent "… (personal read-only local MCP server)" — the repository URL left out by a
// decision recorded nowhere — while every CLI request (`eff setup`'s cookie-bearing probes included)
// sent src/http's DEFAULT_USER_AGENT with it. Now the provider sends that one string: the same bytes
// on the wire from the server and from the CLI, on keyless and cookie-bearing reads alike. Injected
// fetches only; no network, no cookie leaves the process.
import { describe, expect, it } from "vitest";
import { createHttpClient, DEFAULT_USER_AGENT, REPO_URL } from "../../../src/http/client.js";
import { ESPN_USER_AGENT } from "../../../src/providers/espn/transport.js";
import { VERSION } from "../../../src/version.js";
import {
  FakeAuthority,
  fixturesIgnoringCookies,
  makeWorld,
  SEASON,
  testCookieHeader,
} from "./helpers.js";

describe("one User-Agent for every request to ESPN (plan 01 §6)", () => {
  it("the provider's string IS src/http's: name, version and the public repository", () => {
    expect(ESPN_USER_AGENT).toBe(DEFAULT_USER_AGENT);
    expect(ESPN_USER_AGENT).toBe(`espn-fantasy-football-mcp/${VERSION} (+${REPO_URL})`);
    expect(ESPN_USER_AGENT).not.toMatch(/@|Mozilla|Chrome|Safari/);
  });

  it("the server's reads and the CLI's read of the same view carry the same header bytes", async () => {
    const auth = new FakeAuthority("validated", {
      ok: true,
      header: testCookieHeader("{00000000-0000-4000-8000-000000000001}"),
    });
    const w = makeWorld({ fetch: fixturesIgnoringCookies("league-a"), credentials: auth });
    await w.provider.getLeague(w.ref); // cookie-bearing (publicity unknown until it answers)
    w.clock.advance(1_000);
    await w.provider.getRosters(w.ref, 3); // keyless (the league proved public)
    w.clock.advance(1_000);
    await w.provider.getProSchedule(SEASON); // the season route
    expect(w.sent.length).toBe(3);
    expect(w.sent.some((s) => s.headers.cookie !== undefined)).toBe(true);
    for (const s of w.sent) expect(s.headers["user-agent"], s.url).toBe(DEFAULT_USER_AGENT);

    // the CLI's client (what `eff setup`, doctor and `eff probe` build) on the same URL
    const cli: string[] = [];
    const client = createHttpClient({
      fetch: (_url, init) => {
        const h = new Headers(init.headers);
        cli.push(h.get("user-agent") ?? "");
        return Promise.resolve(
          new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
        );
      },
    });
    await client.espnGet(w.sent[0]!.url, { signal: new AbortController().signal });
    expect(cli).toEqual([w.sent[0]!.headers["user-agent"]]);
  });
});
