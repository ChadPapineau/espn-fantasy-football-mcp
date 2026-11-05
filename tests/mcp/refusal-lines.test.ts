// refusal-lines.test.ts — the fixed session-refusal lines (changelog §R10, R10-11 and R10-12's house
// form; the round-4c product account): E11's league-reads line over every combination of refused
// reads, word for word (one read: "needs" / "it was"; two: "and"; three: "a, b and c"; the
// consequence names only what those reads carry), the generic line runTool adds for a refusal a
// tool absorbed and did not say (refusals.ts), the per-call record, and the recording platform —
// a refusal is recorded against the budget its read carried, never another call's, and a read with
// no registered budget (espn_get_status's own zero-request reads) is not recorded.
import { describe, expect, it } from "vitest";
import { activityLeagueReadsWarning, type ActivityLeagueRead } from "../../src/mcp/tools/common.js";
import {
  andList,
  createSessionRefusals,
  rawPlatform,
  rawServices,
  recordingPlatform,
  recordingServices,
  registerRefusals,
  sayRefusals,
  sessionReadsWarning,
} from "../../src/mcp/refusals.js";
import type { McpServices } from "../../src/mcp/services.js";
import { createUpstreamBudget, type FantasyPlatform } from "../../src/providers/platform.js";

const R = "partial: the stored ESPN session was rejected, and ";
const R_END = "; run `eff setup` in a terminal to replace it";
const N_END = "; run `eff setup` in a terminal to add one";

/** Every non-empty subset of E11's league reads, with its exact lines. */
const E11_LINES: readonly (readonly [readonly ActivityLeagueRead[], string, string])[] = [
  [
    ["standings"],
    `${R}ESPN's standings need one on a league not known to be public: they were not read (waiver-order movement goes without them)${R_END}`,
    `partial: ESPN's standings need an ESPN session on a league not known to be public, and none is stored: they were not read (waiver-order movement goes without them)${N_END}`,
  ],
  [
    ["rosters"],
    `${R}ESPN's rosters need one on a league not known to be public: they were not read (rival needs go without them)${R_END}`,
    `partial: ESPN's rosters need an ESPN session on a league not known to be public, and none is stored: they were not read (rival needs go without them)${N_END}`,
  ],
  [
    ["free-agent pool"],
    `${R}ESPN's free-agent pool needs one on a league not known to be public: it was not read (rival needs go without it)${R_END}`,
    `partial: ESPN's free-agent pool needs an ESPN session on a league not known to be public, and none is stored: it was not read (rival needs go without it)${N_END}`,
  ],
  [
    ["standings", "rosters"],
    `${R}ESPN's standings and rosters need one on a league not known to be public: they were not read (by-team activity, waiver-order movement and rival needs go without them)${R_END}`,
    `partial: ESPN's standings and rosters need an ESPN session on a league not known to be public, and none is stored: they were not read (by-team activity, waiver-order movement and rival needs go without them)${N_END}`,
  ],
  [
    ["standings", "free-agent pool"],
    `${R}ESPN's standings and free-agent pool need one on a league not known to be public: they were not read (waiver-order movement and rival needs go without them)${R_END}`,
    `partial: ESPN's standings and free-agent pool need an ESPN session on a league not known to be public, and none is stored: they were not read (waiver-order movement and rival needs go without them)${N_END}`,
  ],
  [
    ["rosters", "free-agent pool"],
    `${R}ESPN's rosters and free-agent pool need one on a league not known to be public: they were not read (rival needs go without them)${R_END}`,
    `partial: ESPN's rosters and free-agent pool need an ESPN session on a league not known to be public, and none is stored: they were not read (rival needs go without them)${N_END}`,
  ],
  [
    ["standings", "rosters", "free-agent pool"],
    `${R}ESPN's standings, rosters and free-agent pool need one on a league not known to be public: they were not read (by-team activity, waiver-order movement and rival needs go without them)${R_END}`,
    `partial: ESPN's standings, rosters and free-agent pool need an ESPN session on a league not known to be public, and none is stored: they were not read (by-team activity, waiver-order movement and rival needs go without them)${N_END}`,
  ],
];

describe("E11's league-reads line, every combination (the round-4c product account)", () => {
  it.each(E11_LINES)("%j", (reads, rejected, noSession) => {
    expect(activityLeagueReadsWarning("rejected", reads)).toBe(rejected);
    expect(activityLeagueReadsWarning("no_session", reads)).toBe(noSession);
    // the order the reads were refused in never changes the line
    const reversed = [...reads].reverse();
    expect(activityLeagueReadsWarning("rejected", reversed)).toBe(rejected);
    expect(activityLeagueReadsWarning("no_session", reversed)).toBe(noSession);
  });

  it("never the ungrammatical forms the round-4c account found", () => {
    for (const [reads] of E11_LINES)
      for (const refusal of ["rejected", "no_session"] as const) {
        const line = activityLeagueReadsWarning(refusal, reads);
        // the pool alone is singular; "ESPN's free-agent pool need one" was the defect
        expect(line).not.toContain("ESPN's free-agent pool need ");
        expect(line).not.toMatch(/, free-agent pool need/);
        expect(line).not.toMatch(/standings, rosters, /);
      }
  });
});

describe("the generic session line (refusals.ts sessionReadsWarning)", () => {
  it("names the reads with and, agrees with them, and ends in the one command", () => {
    expect(sessionReadsWarning("rejected", ["box scores"])).toBe(
      `${R}ESPN's box scores need one on a league not known to be public: they were not read${R_END}`,
    );
    expect(sessionReadsWarning("rejected", ["player pool"])).toBe(
      `${R}ESPN's player pool needs one on a league not known to be public: it was not read${R_END}`,
    );
    expect(sessionReadsWarning("no_session", ["league settings", "box scores"])).toBe(
      `partial: ESPN's league settings and box scores need an ESPN session on a league not known to be public, and none is stored: they were not read${N_END}`,
    );
    expect(sessionReadsWarning("rejected", ["2025 transaction feed"])).toBe(
      `${R}ESPN's 2025 transaction feed needs one on a league not known to be public: it was not read${R_END}`,
    );
    // pending claims are the user's own: never "a league not known to be public"
    expect(sessionReadsWarning("rejected", ["pending claims"])).toBe(
      `partial: your pending claims are read only with your ESPN session, and the stored session was rejected: they were not read${R_END}`,
    );
    expect(sessionReadsWarning("no_session", ["standings", "pending claims"])).toBe(
      `partial: ESPN's standings need an ESPN session on a league not known to be public, and none is stored: they were not read; your pending claims are read only with your ESPN session, and none is stored: they were not read${N_END}`,
    );
    // never the words of a data outage
    for (const r of ["rejected", "no_session"] as const)
      expect(sessionReadsWarning(r, ["box scores", "standings"])).not.toMatch(/unavailable/);
  });

  it("andList", () => {
    expect(andList([])).toBe("");
    expect(andList(["a"])).toBe("a");
    expect(andList(["a", "b"])).toBe("a and b");
    expect(andList(["a", "b", "c"])).toBe("a, b and c");
  });
});

describe("one call's record (refusals.ts createSessionRefusals)", () => {
  it("keeps the stronger reason, orders the reads, and leaves out what the tool said", () => {
    const r = createSessionRefusals();
    expect(r.unsaid()).toBeNull();
    expect(r.any()).toBe(false);
    r.record("box scores", "no_session");
    r.record("2025 standings", "no_session");
    r.record("standings", "rejected");
    r.record("box scores", "rejected");
    r.record("box scores", "no_session");
    expect(r.any()).toBe(true);
    expect(r.unsaid()).toEqual({
      refusal: "rejected",
      reads: ["box scores", "standings", "2025 standings"],
    });
    r.said("standings", "box scores");
    expect(r.unsaid()).toEqual({ refusal: "no_session", reads: ["2025 standings"] });
    r.said("2025 standings");
    expect(r.unsaid()).toBeNull();
    expect(r.any()).toBe(true);
  });

  it("sayRefusals: partial and one line for the unsaid, the output unchanged otherwise", () => {
    const r = createSessionRefusals();
    const out = { data: 1, warnings: ["x"], partial: false };
    expect(sayRefusals(out, r)).toBe(out);
    r.record("box scores", "rejected");
    expect(sayRefusals(out, r)).toEqual({
      data: 1,
      partial: true,
      warnings: ["x", sessionReadsWarning("rejected", ["box scores"])],
    });
    r.said("box scores");
    expect(sayRefusals(out, r)).toBe(out);
  });
});

/** A platform stand-in whose reads refuse with a coded error (no network, no value). */
function refusingPlatform(code: string): FantasyPlatform {
  const fail = (): Promise<never> =>
    Promise.reject(Object.assign(new Error("refused"), { effCode: code }));
  return {
    id: "espn",
    getBoxScores: fail,
    getStandings: fail,
    probeCredential: fail,
    getLeague: () => Promise.resolve({ value: 1 }),
    syncThrow: () => {
      throw Object.assign(new Error("refused"), { effCode: code });
    },
  } as unknown as FantasyPlatform;
}

describe("the recording platform (refusals.ts recordingPlatform)", () => {
  const season = () => 2026;
  const ref = { platform: "espn", league_id: "0", season: 2026 } as const;

  it("records a refusal against the budget its read carried, with its label and season", async () => {
    const p = recordingPlatform(refusingPlatform("ESPN_AUTH_REJECTED"), season);
    const mine = createUpstreamBudget("r-000000000001", 0);
    const theirs = createUpstreamBudget("r-000000000002", 0);
    const a = createSessionRefusals();
    const b = createSessionRefusals();
    registerRefusals(mine, a);
    registerRefusals(theirs, b);
    await expect(p.getBoxScores(ref, 3, { budget: mine })).rejects.toMatchObject({
      effCode: "ESPN_AUTH_REJECTED",
    });
    await expect(p.getStandings({ ...ref, season: 2025 }, { budget: mine })).rejects.toBeInstanceOf(
      Error,
    );
    expect(a.unsaid()).toEqual({ refusal: "rejected", reads: ["box scores", "2025 standings"] });
    // another call's record is untouched; a read with an unregistered budget is not recorded
    expect(b.unsaid()).toBeNull();
    await expect(
      p.getBoxScores(ref, 3, { budget: createUpstreamBudget("r-000000000003", 0, 0) }),
    ).rejects.toBeInstanceOf(Error);
    expect(a.unsaid()?.reads).toEqual(["box scores", "2025 standings"]);
    // the explicit probe is the session check itself, never a read the line names
    await expect(
      (p as unknown as { probeCredential: (o: unknown) => Promise<unknown> }).probeCredential({
        budget: theirs,
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(b.unsaid()).toBeNull();
    // a synchronous throw is recorded too; a success records nothing
    expect(() =>
      (p as unknown as { syncThrow: (o: unknown) => unknown }).syncThrow({ budget: theirs }),
    ).toThrow();
    expect(b.unsaid()).toEqual({ refusal: "rejected", reads: ["league data"] });
    await expect(p.getLeague(ref, { budget: mine })).resolves.toEqual({ value: 1 });
    expect(rawPlatform(p)).not.toBe(p);
    expect(rawPlatform(rawPlatform(p))).toBe(rawPlatform(p));
  });

  it("anything but a session refusal is not recorded", async () => {
    const p = recordingPlatform(refusingPlatform("ESPN_UPSTREAM_UNAVAILABLE"), season);
    const budget = createUpstreamBudget("r-000000000004", 0);
    const a = createSessionRefusals();
    registerRefusals(budget, a);
    await expect(p.getBoxScores(ref, 3, { budget })).rejects.toBeInstanceOf(Error);
    expect(a.any()).toBe(false);
  });

  it("recordingServices: one stable wrapper per bundle; the bundle as configured stays reachable", () => {
    const platform = refusingPlatform("ESPN_REQUIRES_COOKIES");
    const s = { league: { season: 2026 }, platform, configuredTeamId: 2 } as unknown as McpServices;
    const w = recordingServices(s);
    expect(recordingServices(s)).toBe(w);
    expect(recordingServices(w)).toBe(w);
    expect(rawServices(w)).toBe(s);
    expect(rawServices(s)).toBe(s);
    expect(w.platform).toBe(w.platform);
    expect(rawPlatform(w.platform)).toBe(platform);
    expect(w.configuredTeamId).toBe(2);
    // a frozen platform property is answered as it is (the Proxy invariant), never wrapped
    const frozen = Object.freeze({ ...s }) as McpServices;
    expect(recordingServices(frozen).platform).toBe(platform);
    // a bundle with no platform reads as it is
    const bare = { league: { season: 2026 } } as unknown as McpServices;
    expect(recordingServices(bare).platform).toBeUndefined();
  });
});
