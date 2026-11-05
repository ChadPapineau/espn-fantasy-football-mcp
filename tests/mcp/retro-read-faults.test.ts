// retro-read-faults.test.ts — espn_analyze_retrospective's optional reads absorb only what an
// optional read may lose (the round-4d product account's backlog item): an outage, a session
// refusal (said by the call's session line), fixture mode's fixture_missing, or a dataset past its
// hard limit. A bug in one of those reads — any other error — fails the call as INTERNAL, as every
// other tool's optional reads do; before, every error there read as null ("unavailable").
// Fixture mode, fake clock; no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EffError } from "../../src/mcp/errors.js";
import { retroReadAbsorbed } from "../../src/mcp/tools/reclog.js";
import { coded, faulty } from "./helpers/faults.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
interface Body {
  warnings?: string[];
  partial?: boolean;
  error?: { code?: string };
  code?: string;
}

let world: World;
let client: Client;
let close: () => Promise<void>;

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
    publishNflverse: true,
  });
  ({ client, close } = await connect(world, { options: { toolset: "full" } }));
}, 120_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

const codeOf = (b: Body): unknown => b.error?.code ?? b.code;

describe("retroReadAbsorbed: what E13's optional reads may lose", () => {
  it("absorbs an outage, a session refusal, fixture_missing and a stale dataset as null", () => {
    for (const code of [
      "ESPN_UPSTREAM_UNAVAILABLE",
      "ESPN_DRIFT_DETECTED",
      "ESPN_HOST_MOVED",
      "RATE_LIMITED",
      "ESPN_AUTH_REJECTED",
      "ESPN_REQUIRES_COOKIES",
    ])
      expect(retroReadAbsorbed(coded(code)), code).toBeNull();
    const missing = Object.assign(new Error("fixture"), {
      name: "FixtureError",
      effDetails: { reason: "fixture_missing" },
    });
    expect(retroReadAbsorbed(missing)).toBeNull();
    expect(retroReadAbsorbed(new EffError("STALE_ONLY"))).toBeNull();
  });

  it("rethrows anything else: a bug, an unknown code, a non-error", () => {
    const bug = new TypeError("Cannot read properties of undefined");
    expect(() => retroReadAbsorbed(bug)).toThrow(bug);
    expect(() => retroReadAbsorbed(coded("VALIDATION"))).toThrow(/VALIDATION/);
    expect(() => retroReadAbsorbed(coded("INTERNAL"))).toThrow(/INTERNAL/);
    expect(() => retroReadAbsorbed("boom")).toThrow();
    // a FixtureError for another reason is a bug in fixture mode, not a missing read
    const refused = Object.assign(new Error("fixture"), {
      name: "FixtureError",
      effDetails: { reason: "fixture_refused" },
    });
    expect(() => retroReadAbsorbed(refused)).toThrow(refused);
  });
});

describe("espn_analyze_retrospective: a bug in an optional read fails the call", () => {
  it("the clean call answers (the harness works)", async () => {
    const r = await call(client, "espn_analyze_retrospective", { week: 4 });
    expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
  }, 120_000);

  it("an outage of an earlier week's box scores still degrades (unchanged)", async () => {
    const s = faulty(world.services, {
      getBoxScores: (real, ref, week, opts) =>
        week === 4 ? real(ref, week, opts) : Promise.reject(coded("ESPN_UPSTREAM_UNAVAILABLE")),
    });
    const c = await connect(world, { options: { toolset: "full" }, services: s });
    const r = await call(c.client, "espn_analyze_retrospective", { week: 4 });
    await c.close();
    expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
    expect((r.body as Body).warnings).toContain(
      "last week's box scores unavailable: the last-week baseline is unknown",
    );
  }, 120_000);

  it("a TypeError from an earlier week's box scores is INTERNAL, never 'unavailable'", async () => {
    const s = faulty(world.services, {
      getBoxScores: (real, ref, week, opts) =>
        week === 4 ? real(ref, week, opts) : Promise.reject(new TypeError("injected bug")),
    });
    const c = await connect(world, { options: { toolset: "full" }, services: s });
    const r = await call(c.client, "espn_analyze_retrospective", { week: 4 });
    await c.close();
    expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(true);
    expect(codeOf(r.body as Body)).toBe("INTERNAL");
    // the injected message is never echoed
    expect(JSON.stringify(r.body)).not.toContain("injected bug");
  }, 120_000);

  it("a TypeError from the league settings read is INTERNAL", async () => {
    const s = faulty(world.services, {
      getScoringSettings: Object.assign(new TypeError("injected bug"), {}),
    });
    const c = await connect(world, { options: { toolset: "full" }, services: s });
    const r = await call(c.client, "espn_analyze_retrospective", { week: 4 });
    await c.close();
    expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(true);
    expect(codeOf(r.body as Body)).toBe("INTERNAL");
  }, 120_000);
});
