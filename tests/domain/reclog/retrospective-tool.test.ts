// retrospective-tool.test.ts — Stage C reclog-retrospective-scores-own-retro through the real
// composition root (fixture mode, keyless, no network; recorded league-a at the recording instant,
// week 3 final). The retro Skill's sequence asked twice (plan 09 §3 retro: E13, then E12 with
// `kind: "retro"` and the retrospective's own rec): the second E13 lists exactly the calls the first
// did — never the first retrospective's own entry, so no `followed: null` of its own sends the Skill
// to the transactions (plan 07 E13 scores "last week's calls"). The onboarding entry and an executed
// record are notes too (KIND_ROLES). Every note stays in the log, gets no outcome row, and a `kinds`
// filter naming one is answered with a warning. The domain rule is in retrospective.test.ts.
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, connect, makeWorld, SEASON, type World } from "../../mcp/helpers/world.js";

let world: World;
let client: Client;
let close: () => Promise<void>;
beforeAll(async () => {
  world = await makeWorld({});
  ({ client, close } = await connect(world));
}, 120_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

interface Env {
  data: Record<string, unknown>;
  meta: { request_id: string; as_of: string };
  warnings: string[];
}
interface ScoredCall {
  log_id: string;
  kind: string;
  followed: boolean | null;
}

async function ok(name: string, args: Record<string, unknown> = {}): Promise<Env> {
  const r = await call(client, name, args);
  expect(r.isError, `${name}: ${JSON.stringify(r.body).slice(0, 400)}`).toBe(false);
  return r.body as unknown as Env;
}
const callsOf = (e: Env): ScoredCall[] => e.data.calls as ScoredCall[];
const logIdOf = (e: Env): string => e.data.log_id as string;
const outcome = (logId: string) => world.store.repos.recommendationLog.outcome(logId);

describe("E13 scores decisions only: the retro Skill asked twice (Stage C)", () => {
  const WEEK = 3;
  let hash = "";
  let leagueCall = { request_id: "", as_of: "" };
  let lineup: Env;
  let decisionId = "";
  let first: Env;
  let retroId = "";

  beforeAll(async () => {
    const league = await ok("espn_get_league", { include: ["scoring"] });
    hash = (league.data.scoring as { settings_hash: string }).settings_hash;
    leagueCall = { request_id: league.meta.request_id, as_of: league.meta.as_of };
    // one decision of the week: the lineup call, logged as the start-sit Skill logs it
    lineup = await ok("espn_analyze_lineup", { week: WEEK });
    decisionId = logIdOf(
      await ok("espn_record_recommendation", {
        kind: "lineup",
        week: WEEK,
        rec: lineup.data.rec,
        alternatives: [],
        source_calls: [{ tool: "espn_analyze_lineup", request_id: lineup.meta.request_id }],
        settings_hash: hash,
        client_ref: "retro-tool-lineup",
      }),
    );
  }, 120_000);

  it("asked twice, the second answer lists the first one's calls, never its own entry", async () => {
    first = await ok("espn_analyze_retrospective", { week: WEEK });
    expect(callsOf(first).map((c) => c.log_id)).toEqual([decisionId]);
    // the retro Skill's step 5: log the retrospective's rec under the scored week
    retroId = logIdOf(
      await ok("espn_record_recommendation", {
        kind: "retro",
        week: WEEK,
        rec: first.data.rec,
        alternatives: [],
        source_calls: [{ tool: "espn_analyze_retrospective", request_id: first.meta.request_id }],
        settings_hash: hash,
        followed_hint: "unknown",
        client_ref: "retro-tool-w3",
      }),
    );
    const second = await ok("espn_analyze_retrospective", { week: WEEK });
    expect(callsOf(second).map((c) => c.kind)).not.toContain("retro");
    expect(callsOf(second).map((c) => c.log_id)).not.toContain(retroId);
    expect(second.data.calls).toEqual(first.data.calls);
    // so the Skill's "followed is null for any call" step is not set off by its own entry
    expect(callsOf(second).filter((c) => c.followed === null)).toEqual(
      callsOf(first).filter((c) => c.followed === null),
    );
    expect(outcome(decisionId)).not.toBeNull();
    expect(outcome(retroId)).toBeNull();
  });

  it("the onboarding entry and an executed record are notes too; every note stays in the log", async () => {
    // skills/onboard/references/onboard-log-entry.md, its placeholders filled
    const onboardingId = logIdOf(
      await ok("espn_record_recommendation", {
        kind: "onboarding",
        week: WEEK,
        rec: {
          action:
            "Onboarding: league format restated, scoring self-check shown for the last final week, seeding reading recorded or asked",
          subjects: [],
          lineup: null,
          point_estimate: 0,
          distribution: {
            mean: 0,
            p10: 0,
            p25: 0,
            p50: 0,
            p75: 0,
            p90: 0,
            p_zero: 1,
            basis: "position_cv",
          },
          delta_vs_next: { value: 0, p10: 0, p90: 0 },
          decision_metric: "golden_mismatch_share",
          drivers: [],
          assumptions: [
            {
              text: "The scoring self-check covers the sampled players of the checked weeks only",
              revisit_trigger:
                "the league's settings_hash changes or a later week shows a mismatch",
            },
          ],
          confidence: { role_games: 0, inputs: [] },
          as_of: leagueCall.as_of,
          latest_execution_time: null,
          no_move: true,
          log_id: null,
        },
        alternatives: [],
        source_calls: [{ tool: "espn_get_league", request_id: leagueCall.request_id }],
        settings_hash: hash,
        followed_hint: "unknown",
        client_ref: "onboard-setup",
      }),
    );
    // plan 09 §3 apply's write path (never this build): the decision's rec, its log id as client_ref
    const executedId = logIdOf(
      await ok("espn_record_recommendation", {
        kind: "executed",
        week: WEEK,
        rec: lineup.data.rec,
        alternatives: [],
        source_calls: [{ tool: "espn_analyze_lineup", request_id: lineup.meta.request_id }],
        settings_hash: hash,
        followed_hint: "user_said_yes",
        client_ref: decisionId,
      }),
    );
    const third = await ok("espn_analyze_retrospective", { week: WEEK });
    expect(third.data.calls).toEqual(first.data.calls);
    const logged = world.store.repos.recommendationLog.forWeek("0", SEASON, WEEK);
    expect(logged.map((r) => r.kind).sort()).toEqual(["executed", "lineup", "onboarding", "retro"]);
    for (const id of [retroId, onboardingId, executedId]) expect(outcome(id), id).toBeNull();
  });

  it("a kinds filter naming a note scores nothing for it and says so", async () => {
    const r = await ok("espn_analyze_retrospective", { week: WEEK, kinds: ["retro"] });
    expect(r.data.calls).toEqual([]);
    expect(r.warnings).toContain("retrospective: kind retro is not a decision and is never scored");
    const both = await ok("espn_analyze_retrospective", { week: WEEK, kinds: ["retro", "lineup"] });
    expect(callsOf(both).map((c) => c.log_id)).toEqual([decisionId]);
  });
});
