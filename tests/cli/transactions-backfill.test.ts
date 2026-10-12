// transactions-backfill.test.ts — `eff transactions --backfill` (changelog R6-3: a league's previous
// seasons are "the league's own feed", plan 07 E5; Stage C finding
// waivers-previous-season-feed-not-populated: no command stored them, so E5 stayed cold_start). Over
// an injected fetch serving league-a's recorded settings as each previous season and one crafted
// waiver transaction per scoring period: each previous season's every week is read, the rows land in
// transactions_seen (season-attributable by their process date, as E5 reads them), a re-run adds
// nothing, a season ESPN does not serve is skipped and said, and the requests are origin `server`
// (never the launchd jobs' daily cookie cap). No request leaves the process.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionFileBody } from "../../src/auth/file.js";
import { metaFor } from "../../src/auth/upgrade.js";
import { USAGE, main } from "../../src/cli/main.js";
import { loadRuntime } from "../../src/cli/runtime.js";
import { openStore } from "../../src/cli/store-access.js";
import { composeBodies } from "../../src/providers/espn/index.js";
import { transactionsBySeason } from "../../src/domain/analytics/waiver-fit/history.js";
import { fakeCookies } from "../auth/helpers.js";
import {
  ROOT,
  fakeFetch,
  fakePackage,
  makeIo,
  movingClock,
  sandbox,
  type Sandbox,
} from "./helpers.js";

let sb: Sandbox;
afterEach(() => {
  sb.cleanup();
});

const REC = path.join(ROOT, "fixtures", "espn", "recorded");
const rec = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(REC, rel), "utf8")) as Record<string, unknown>;
const jsonRes = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const COOKIES = fakeCookies("cli-backfill");

/** A transaction id in the fake GUID range (never a real id). */
const txId = (season: number, week: number): string =>
  `00000000-0000-4000-8000-${String(season % 100).padStart(4, "0")}${String(week).padStart(8, "0")}`;

/** league-a as season `season` (`missing` seasons answer 404), one waiver claim per week. */
function history(missing: readonly number[] = []) {
  return fakeFetch((url) => {
    const u = new URL(url);
    const season = Number(/\/seasons\/(\d{4})\//.exec(u.pathname)?.[1] ?? "0");
    if (!u.pathname.includes("/leagues/0")) return new Response(null, { status: 404 });
    // ESPN's own answer for a league-season it does not serve (the recorded error body)
    if (missing.includes(season)) return jsonRes(rec("errors/404-league-not-found.json"), 404);
    const settings = { ...rec("league-a/mSettings.json"), seasonId: season };
    const views = u.searchParams.getAll("view");
    const week = Number(u.searchParams.get("scoringPeriodId") ?? "1");
    if (views.includes("mTransactions2")) {
      const at = Date.UTC(season, 8, 8) + (week - 1) * 7 * 86_400_000;
      return jsonRes({
        ...settings,
        scoringPeriodId: week,
        transactions: [
          {
            id: txId(season, week),
            type: "WAIVER",
            status: "EXECUTED",
            teamId: 1,
            scoringPeriodId: week,
            proposedDate: at - 3_600_000,
            processDate: at,
            bidAmount: 0,
            isPending: false,
            items: [
              {
                type: "ADD",
                playerId: 1000 + week,
                fromTeamId: 0,
                toTeamId: 1,
                fromLineupSlotId: -1,
                toLineupSlotId: 20,
                isKeeper: false,
              },
              {
                type: "DROP",
                playerId: 2000 + week,
                fromTeamId: 1,
                toTeamId: 0,
                fromLineupSlotId: 20,
                toLineupSlotId: -1,
                isKeeper: false,
              },
            ],
          },
        ],
      });
    }
    let body: unknown = settings;
    if (views.includes("mNav")) body = composeBodies(body, rec("league-a/mNav.json"));
    if (views.includes("mTeam")) body = composeBodies(body, rec("league-a/mTeam.json"));
    return jsonRes(body);
  });
}

function plantCookies(): void {
  mkdirSync(sb.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(sb.configDir, "session.json"),
    sessionFileBody(COOKIES, metaFor(COOKIES, "2026-10-01T00:00:00.000Z")),
    { mode: 0o600 },
  );
}

async function runBackfill(f: ReturnType<typeof fakeFetch>, argv: string[] = []) {
  const io = makeIo(sb, {
    fetch: f.fetch,
    clock: movingClock("2026-10-06T18:00:00.000Z"),
    packageRoot: fakePackage(sb),
    env: { ESPN_LEAGUE_ID: "0", EFF_CREDENTIAL_STORE: "file", ESPN_SEASON: "2026" },
  });
  const code = await main(["transactions", "--backfill", ...argv], io);
  return { code, io };
}

describe("eff transactions --backfill (R6-3: the league's previous seasons are its own feed)", () => {
  it("reads every week of the newest two previous seasons into transactions_seen, idempotently", async () => {
    sb = sandbox();
    plantCookies();
    expect(USAGE).toContain("transactions --backfill [--seasons 2024,2025]");
    const f = history();
    const { code, io } = await runBackfill(f);
    expect(io.err.text.split("\n").filter((l) => l.startsWith("eff "))).toEqual([]);
    expect(code).toBe(0);
    expect(io.out.text).toContain("season 2025: 17 week(s) read, 17 transaction(s), 17 new");
    expect(io.out.text).toContain("season 2024: 17 week(s) read, 17 transaction(s), 17 new");
    // every scoring period of both seasons was asked, on the read host
    for (const season of [2024, 2025])
      for (let w = 1; w <= 17; w++)
        expect(
          f.urls.some(
            (u) =>
              u.includes(`/seasons/${String(season)}/`) &&
              u.includes("view=mTransactions2") &&
              u.includes(`scoringPeriodId=${String(w)}`),
          ),
          `${String(season)} week ${String(w)}`,
        ).toBe(true);
    const { config, log } = await loadRuntime(io);
    const store = openStore(config, io.clock, log, { migrate: false });
    try {
      const bySeason = transactionsBySeason(store.repos.transactionsSeen.list(null, 1000));
      expect(bySeason.get(2025)).toHaveLength(17);
      expect(bySeason.get(2024)).toHaveLength(17);
      // an interactive run: origin server, never the launchd jobs' daily cookie cap
      const today = store.repos.limiter.countToday("2026-10-06T00:00:00.000Z");
      expect(today.job.cookie + today.job.keyless).toBe(0);
      expect(today.server.cookie).toBeGreaterThanOrEqual(34);
    } finally {
      store.close();
    }
    // a re-run stores nothing new (dedup by transaction id)
    const again = await runBackfill(history());
    expect(again.code).toBe(0);
    expect(again.io.out.text).toContain("0 new transaction(s) stored");
  }, 60_000);

  it("--seasons picks the seasons; a season ESPN does not serve is skipped and said", async () => {
    sb = sandbox();
    plantCookies();
    const { code, io } = await runBackfill(history([2023]), ["--seasons", "2023,2025"]);
    expect(code).toBe(0);
    expect(io.out.text).toContain("season 2023: not served");
    expect(io.out.text).toContain("season 2025: 17 week(s) read");
  }, 60_000);

  it("refuses the current season and a --seasons without --backfill (usage)", async () => {
    sb = sandbox();
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0", ESPN_SEASON: "2026" } });
    expect(await main(["transactions", "--backfill", "--seasons", "2026"], io)).toBe(2);
    expect(io.err.text).toContain("previous seasons only");
    const io2 = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0", ESPN_SEASON: "2026" } });
    expect(await main(["transactions", "--seasons", "2025"], io2)).toBe(2);
  });
});
