// activity-lines.test.ts — E11's warning lines say only what is true, one line per fact (the round-4c
// product account; changelog §R10, R10-11): the history line names the feed weeks read, and says the
// window holds no transaction when the feed was refused (or unavailable) and nothing is persisted —
// never "the window shows this week's feed only" then; the teams line is printed only for team reads
// that failed for another reason than the session (a refused one is said by the reads line, with
// what the digest goes without), and never when both were refused. Every combination of the feed,
// the standings and the rosters: refused, unavailable (an outage), or read. fx-10h, fixture mode,
// an empty transaction history; no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_READ_WARNINGS, activityLeagueReadsWarning } from "../../src/mcp/tools/common.js";
import { coded, faulty, type Fault } from "./helpers/faults.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
interface Body {
  warnings: string[];
  partial: boolean;
  data: unknown;
}

const NO_HISTORY_FEED =
  "no persisted transaction history yet: the window shows this week's feed only";
const NO_HISTORY_NONE =
  "no persisted transaction history yet, and ESPN's feed was not read: the window holds no transactions";
const teamsLine = (what: string): string =>
  `partial: the league's teams were not read (${what} unavailable): by-team activity, waiver-order movement and rival needs are omitted`;

let world: World;
let client: Client;
let close: () => Promise<void>;
let week: number;
const twoWeeks = (): string =>
  `no persisted transaction history yet: the window shows ESPN's feed of weeks ${String(week - 1)}–${String(week)} only`;

beforeAll(async () => {
  const m = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
    clock: string;
    my_team_id: number;
  };
  world = await makeWorld({
    env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: "full" },
    teamId: m.my_team_id,
    clock: m.clock,
    publishEspn: true,
  });
  ({ client, close } = await connect(world, { options: { toolset: "full" } }));
  const lg = await call(client, "espn_get_league", { include: ["clock"] });
  week = (lg.body.data as { clock: { current_week: number } }).clock.current_week;
  expect(week).toBeGreaterThan(1);
  expect(world.store.repos.transactionsSeen.oldestSeen()).toBeNull();
}, 120_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

type How = "refused" | "unavailable" | "read";
const HOWS: readonly How[] = ["refused", "unavailable", "read"];
const fault = (how: How): Fault | undefined =>
  how === "refused"
    ? coded("ESPN_AUTH_REJECTED")
    : how === "unavailable"
      ? coded("ESPN_UPSTREAM_UNAVAILABLE")
      : undefined;

async function activity(feed: How, standings: How, rosters: How, sinceDays: number): Promise<Body> {
  const faults: Parameters<typeof faulty>[1] = {};
  const f = fault(feed);
  const st = fault(standings);
  const ro = fault(rosters);
  if (f !== undefined) faults.listTransactions = f;
  if (st !== undefined) faults.getStandings = st;
  if (ro !== undefined) faults.getRosters = ro;
  const c = await connect(world, {
    options: { toolset: "full" },
    services: faulty(world.services, faults),
  });
  const r = await call(c.client, "espn_analyze_league_activity", { since_days: sinceDays });
  await c.close();
  expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
  return r.body as unknown as Body;
}

describe("E11's lines, every combination of the feed, standings and rosters (the round-4c account)", () => {
  it.each(HOWS.flatMap((feed) => HOWS.flatMap((st) => HOWS.map((ro) => [feed, st, ro] as const))))(
    "feed %s, standings %s, rosters %s",
    async (feed, st, ro) => {
      const b = await activity(feed, st, ro, 1);
      const w = b.warnings;
      // the history line: only what is true
      const history = w.filter((x) => x.startsWith("no persisted transaction history yet"));
      // (`since_days: 1` spans two scoring periods: this one and the one before)
      expect(history).toEqual([feed === "read" ? twoWeeks() : NO_HISTORY_NONE]);
      // the feed's own lines
      expect(w.includes(SESSION_READ_WARNINGS.feed_rejected)).toBe(feed === "refused");
      expect(
        w.includes("espn:mTransactions2 unavailable: the server's persisted history only"),
      ).toBe(feed === "unavailable");
      // the reads line: exactly the refused reads
      const refused = (
        [
          ["standings", st],
          ["rosters", ro],
        ] as const
      )
        .filter(([, h]) => h === "refused")
        .map(([r]) => r);
      const reads = w.filter((x) =>
        x.includes("need one on a league not known to be public: they"),
      );
      expect(reads).toEqual(
        refused.length === 0 ? [] : [activityLeagueReadsWarning("rejected", refused)],
      );
      // the teams line: no team named, and only for the reads not refused — none when both were
      const teamsUnread = st !== "read" && ro !== "read";
      const unsaid = (
        [
          ["standings", st],
          ["rosters", ro],
        ] as const
      )
        .filter(([, h]) => h === "unavailable")
        .map(([r]) => r);
      const teams = w.filter((x) => x.startsWith("partial: the league's teams were not read"));
      expect(teams).toEqual(
        teamsUnread && unsaid.length > 0 ? [teamsLine(unsaid.join(" and "))] : [],
      );
      // a refused read is never "unavailable"; one line per fact: no line twice
      for (const x of w) expect(x).not.toMatch(/^(?:standings|rosters) unavailable/);
      expect(new Set(w).size).toBe(w.length);
      // partial whenever the session refused a read (an outage keeps E11's own rule)
      if (feed === "refused" || st === "refused" || ro === "refused") expect(b.partial).toBe(true);
    },
    60_000,
  );

  it("one feed week read (the next one over the budget): 'this week's feed only'; two: the weeks named", async () => {
    let n = 0;
    const once: Fault = (real, ...args) =>
      n++ === 0 ? real(...args) : Promise.reject(coded("ESPN_UPSTREAM_UNAVAILABLE"));
    const c = await connect(world, {
      options: { toolset: "full" },
      services: faulty(world.services, { listTransactions: once }),
    });
    const r = await call(c.client, "espn_analyze_league_activity", { since_days: 7 });
    await c.close();
    const w = (r.body as unknown as Body).warnings;
    expect(w).toContain(NO_HISTORY_FEED);
    expect((await activity("read", "read", "read", 7)).warnings).toContain(twoWeeks());
  }, 60_000);
});
