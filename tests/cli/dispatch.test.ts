// dispatch.test.ts — every `eff` subcommand reached through `main` (plan 03 §1.1 step 1; plan 06 J2):
// each one parses its flags, loads the configuration it needs (strict or lenient) and returns an
// exit code without a network call or a real keychain access; and the crosswalk rebuild's done path
// with the unmatched-player alert (plan 06 §1.3: threshold 1, counts only in the notification; the
// rebuild lists the alerted ids and why, and names how an override is really made — Stage C finding
// crosswalk-alert-remediation-dead).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_ALERT_LINES,
  OVERRIDE_HOWTO,
  alertReason,
  diagnosticsLine,
  runCrosswalkRebuild,
} from "../../src/cli/crosswalk.js";
import { main } from "../../src/cli/main.js";
import { createNotifier } from "../../src/cli/notify.js";
import { loadLenientRuntime } from "../../src/cli/runtime.js";
import type { Store } from "../../src/store/types.js";
import { openStore } from "../../src/cli/store-access.js";
import { stateRow } from "../auth/helpers.js";
import {
  ROOT,
  fakeExec,
  fakePackage,
  makeIo,
  noNetwork,
  sandbox,
  type Sandbox,
} from "./helpers.js";

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
      // the daily probe is exempt from the gate; nothing is stored, so it sends nothing and exits 3
      // (plan 03 §1.3: credentials not configured)
      [["credential-check"], 3],
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
  it("check-auth with nothing stored: accepted null, no request, exit 3 (not configured) — and no minute spent", async () => {
    sb = sandbox();
    const env = { ESPN_LEAGUE_ID: "0", EFF_CREDENTIAL_STORE: "file" };
    const io = makeIo(sb, { env, fetch: noNetwork });
    // plan 03 §1.3: 3 = credentials not configured or rejected (doctor #16 maps it the same way)
    expect(await main(["check-auth", "--json"], io)).toBe(3);
    expect(JSON.parse(io.out.text)).toMatchObject({ accepted: null, reason: "not_configured" });
    // no probe was sent, so the once-a-minute allowance was not spent: a second call answers too
    const again = makeIo(sb, { env, fetch: noNetwork });
    expect(await main(["check-auth"], again)).toBe(3);
    expect(again.err.text).not.toContain("at most one probe per minute");
    expect(again.out.text).toContain("run `eff setup`");
  });
  it("selftest-read refuses a missing flag (usage)", async () => {
    sb = sandbox();
    const io = makeIo(sb);
    expect(await main(["selftest-read", "--service", "eff-test-x-selftest"], io)).toBe(2);
  });
});

describe("crosswalk rebuild — done path and the alert", () => {
  it("the override advice names what the runtime reads; reasons and diagnostics carry ids and codes only", () => {
    sb = sandbox();
    // the runtime reads the compiled CHECKED_IN_OVERRIDES (the package ships no data/): the advice
    // names it beside the JSON file a test holds it equal to — both exist in a checkout
    expect(OVERRIDE_HOWTO).toContain("data/crosswalk/overrides.json");
    expect(OVERRIDE_HOWTO).toContain("CHECKED_IN_OVERRIDES in src/domain/crosswalk/overrides.ts");
    expect(existsSync(path.join(ROOT, "data", "crosswalk", "overrides.json"))).toBe(true);
    expect(
      readFileSync(path.join(ROOT, "src", "domain", "crosswalk", "overrides.ts"), "utf8"),
    ).toContain("export const CHECKED_IN_OVERRIDES");
    const pair = {
      espn_id: 1,
      gsis_id: "00-0012345",
      method: "match" as const,
      source: "matcher" as never,
      confidence: 0.8,
      first_seen: "t",
      last_seen: "t",
    };
    expect(alertReason({ status: "matched", pair, evidence: [], changed: false })).toBe(
      "paired by match only (confidence 0.8) with 00-0012345",
    );
    const cand = (g: string) =>
      ({
        gsis_id: g,
        team: "ATL",
        position: "RB",
        jersey_number: 1,
        evidence: [],
        score: 1,
      }) as never;
    expect(
      alertReason({
        status: "ambiguous",
        candidates: [
          cand("00-0000001"),
          cand("00-0000002"),
          cand("00-0000003"),
          cand("00-0000004"),
        ],
      }),
    ).toBe(
      "ambiguous between 4 nflverse player(s) — candidates 00-0000001, 00-0000002, 00-0000003 (+1)",
    );
    expect(
      alertReason({
        status: "unmatched",
        reason: "name_only",
        candidates: [cand("00-0000001")],
      }),
    ).toBe("no nflverse pair (name_only) — candidates 00-0000001");
    expect(alertReason({ status: "unmatched", reason: "no_candidate", candidates: [] })).toBe(
      "no nflverse pair (no_candidate)",
    );
    expect(alertReason({ status: "team_unit", nfl_team: null })).toBe(
      "a team unit (paired by its team)",
    );
    expect(
      diagnosticsLine(
        [1, 2, 3, 4, 5, 6].map((i) => ({
          code: "persisted_id_conflict" as const,
          espn_id: i,
          gsis_ids: [],
        })),
      ),
    ).toBe("  diagnostics: persisted_id_conflict ×6 (espn 1, espn 2, espn 3, espn 4, espn 5, …)");
    expect(diagnosticsLine([])).toBeNull();
    expect(
      diagnosticsLine([
        { code: "duplicate_gsis", espn_id: 5, gsis_ids: ["00-0000009"] },
        { code: "duplicate_gsis", espn_id: 6, gsis_ids: ["00-0000009"] },
        { code: "stale_override_pair", espn_id: null, gsis_ids: [] },
      ]),
    ).toBe("  diagnostics: duplicate_gsis ×2 (espn 5, espn 6); stale_override_pair ×1");
  });
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
    // Stage C finding crosswalk-alert-remediation-dead: the alert lists WHICH ids and why (never a
    // name), says how an override is really made, and the notification names this very command
    expect(r.lines).toContain("    espn 9000002 (rostered): no nflverse pair (no_candidate)");
    expect(r.lines.join("\n")).not.toContain("Nomatch");
    expect(r.lines).toContain(`  ${OVERRIDE_HOWTO}`);
    expect(calls[0]?.args[1]).toContain("run `eff crosswalk rebuild` for the list");
    expect(calls[0]?.args[1]).not.toContain("eff status");
    const broken = {
      ...store,
      rosterWeekly: {
        latest: () => {
          throw new Error("db");
        },
      },
    } as unknown as Store;
    expect((await runCrosswalkRebuild(io, config, broken, log, notifier)).code).toBe(1);
    // more alerted players than MAX_ALERT_LINES: the first are listed, the rest counted
    const many = {
      ...store,
      playerUniverse: {
        all: () => ({
          rows: Array.from({ length: MAX_ALERT_LINES + 3 }, (_, i) => ({
            espn_id: 9100001 + i,
            full_name: `Nobody ${String(i)}`,
            position_id: 3,
            pro_team_id: 1,
            pro_team: "Atl",
            percent_owned: 40,
            jersey: "80",
          })),
          stamp: { ...stamp, source: "espn:players" },
        }),
        byIds: () => ({ rows: [], stamp: null }),
      },
    } as unknown as Store;
    const big = await runCrosswalkRebuild(io, config, many, log, null);
    expect(big.lines.filter((l) => l.startsWith("    espn "))).toHaveLength(MAX_ALERT_LINES);
    expect(big.lines).toContain("    … 3 more");
    expect(big.lines.join("\n")).toContain("(≥ 1 % owned): no nflverse pair (");
    expect(big.lines.join("\n")).not.toContain("Nobody");
    expect(path.isAbsolute(sb.cacheDir)).toBe(true);
  });
});
