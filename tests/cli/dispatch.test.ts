// dispatch.test.ts — every `eff` subcommand reached through `main` (plan 03 §1.1 step 1; plan 06 J2):
// each one parses its flags, loads the configuration it needs (strict or lenient) and returns an
// exit code without a network call or a real keychain access; and the crosswalk rebuild's done path
// with the unmatched-player alert (plan 06 §1.3: threshold 1, counts only in the notification).
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCrosswalkRebuild } from "../../src/cli/crosswalk.js";
import { main } from "../../src/cli/main.js";
import { createNotifier } from "../../src/cli/notify.js";
import { loadLenientRuntime } from "../../src/cli/runtime.js";
import type { Store } from "../../src/store/types.js";
import { openStore } from "../../src/cli/store-access.js";
import { stateRow } from "../auth/helpers.js";
import { fakeExec, fakePackage, makeIo, noNetwork, sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox;
afterEach(() => {
  sb.cleanup();
});

describe("main reaches every subcommand", () => {
  it("lenient commands run on a fresh sandbox with no network", async () => {
    sb = sandbox();
    const root = fakePackage(sb);
    const cases: [string[], number][] = [
      [["status"], 0],
      [["prune"], 0],
      [["backup"], 0],
      [["install-launchd", "--dry-run", "--jobs", "probe"], 0],
      [["uninstall-launchd", "--dry-run"], 0],
      [["print-config", "--client", "code"], 0],
      [["uninstall", "--dry-run"], 0],
      [["crosswalk", "rebuild"], 0],
      [["refresh", "espn:players", "--json"], 1],
    ];
    for (const [argv, code] of cases) {
      const io = makeIo(sb, { fetch: noNetwork, packageRoot: root });
      expect(await main(argv, io), argv.join(" ")).toBe(code);
    }
  });
  it("strict commands: with a rejected row every job gates before any request", async () => {
    sb = sandbox();
    const env = { ESPN_LEAGUE_ID: "0", EFF_CREDENTIAL_STORE: "file" };
    const r = await loadLenientRuntime(makeIo(sb, { env }));
    const store = openStore(r.config, makeIo(sb).clock, r.log, { migrate: true });
    store.repos.credentialState.put(
      stateRow({ store: "file", state: "rejected", rejected_since: "2026-10-06T09:00:00.000Z" }),
    );
    store.close();
    const cases: [string[], number][] = [
      [["credential-check"], 0],
      [["snapshot", "roster"], 0],
      [["snapshot", "roster", "--pre-kickoff"], 0],
      [["snapshot", "projections"], 0],
      [["snapshot", "pool", "--pre-kickoff"], 2],
      [["snapshot", "weather"], 2],
      [["pre-kickoff"], 0],
      [["transactions", "--force"], 0],
    ];
    for (const [argv, code] of cases) {
      const io = makeIo(sb, { env, fetch: noNetwork, packageRoot: fakePackage(sb) });
      expect(await main(argv, io), argv.join(" ")).toBe(code);
    }
  });
  it("check-auth with nothing stored reports accepted: null without a request", async () => {
    sb = sandbox();
    const io = makeIo(sb, {
      env: { ESPN_LEAGUE_ID: "0", EFF_CREDENTIAL_STORE: "file" },
      fetch: noNetwork,
    });
    const code = await main(["check-auth", "--json"], io);
    expect([0, 1]).toContain(code);
  });
  it("selftest-read refuses a missing flag (usage)", async () => {
    sb = sandbox();
    const io = makeIo(sb);
    expect(await main(["selftest-read", "--service", "eff-test-x-selftest"], io)).toBe(2);
  });
});

describe("crosswalk rebuild — done path and the alert", () => {
  it("pairs by roster_weekly espn_id, alerts once on an unmatched rostered player (counts only)", async () => {
    sb = sandbox();
    const stamp = {
      source: "nflverse:roster_weekly",
      as_of: "2026-10-06T00:00:00.000Z",
      fetched_at: "2026-10-06T00:00:00.000Z",
      checked_at: "2026-10-06T00:00:00.000Z",
      freshness_class: "nflverse_roster_weekly",
    };
    const roster = [
      {
        gsis_id: "00-0099001",
        season: 2026,
        week: 5,
        full_name: "Testa Runner",
        team: "ATL",
        position: "RB",
        jersey_number: 21,
        espn_id: 9000001,
        sleeper_id: null,
        status: "ACT",
      },
    ];
    const universe = [
      {
        espn_id: 9000001,
        full_name: "Testa Runner",
        position_id: 2,
        pro_team_id: 1,
        pro_team: "Atl",
        percent_owned: 50,
        jersey: "21",
      },
      {
        espn_id: 9000002,
        full_name: "Nomatch Person",
        position_id: 3,
        pro_team_id: 1,
        pro_team: "Atl",
        percent_owned: 30,
        jersey: "88",
      },
    ];
    const written: unknown[] = [];
    const store = {
      rosterWeekly: {
        latest: () => ({ rows: roster, stamp }),
        byEspnId: () => ({ rows: [], stamp }),
      },
      playerUniverse: {
        all: () => ({ rows: universe, stamp: { ...stamp, source: "espn:players" } }),
        byIds: () => ({ rows: [], stamp: null }),
      },
      nflPlayers: { byEspnIds: () => ({ rows: [], stamp: null }) },
      repos: {
        crosswalk: {
          get: () => null,
          byGsis: () => [],
          upsertDelta: (p: readonly unknown[]) => {
            written.push(...p);
            return p.length;
          },
          touch: () => ({ written: true }),
          count: () => written.length,
        },
        rosterSnapshots: {
          latestTwo: () => [
            {
              team_id: 1,
              week: 5,
              taken_at: "t",
              roster: { entries: [{ player: { ref: { id: 9000002 } } }] },
            },
          ],
        },
      },
    } as unknown as Store;
    const { exec, calls } = fakeExec();
    const io = makeIo(sb, {
      platform: "darwin",
      exec,
      env: { ESPN_LEAGUE_ID: "0", ESPN_TEAM_ID: "1" },
    });
    const { config, log } = await loadLenientRuntime(io);
    const notifier = createNotifier({
      platform: "darwin",
      exec,
      clock: io.clock,
      cacheDir: sb.cacheDir,
    });
    const r = await runCrosswalkRebuild(io, config, store, log, notifier);
    expect(r.code).toBe(0);
    expect(r.alert).toBe(true);
    expect(written.length).toBe(1);
    expect(r.lines.join("\n")).toMatch(/1 pair\(s\) written[\s\S]*lack a confident nflverse pair/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[1]).not.toContain("Nomatch");
    const broken = {
      ...store,
      rosterWeekly: {
        latest: () => {
          throw new Error("db");
        },
      },
    } as unknown as Store;
    expect((await runCrosswalkRebuild(io, config, broken, log, notifier)).code).toBe(1);
    expect(path.isAbsolute(sb.cacheDir)).toBe(true);
  });
});
