// weekly-invalid-ir.test.ts — an invalid roster leads every answer that sees it, whichever read shows
// it (Stage C finding skills-weekly-invalid-ir-not-surfaced; research 05 §4.3: "If you have a healthy
// player in an IR/IL slot, you cannot add any new players to your roster" and "clear your IR/IL
// before you can make a claim"; HANDOFF finding 8). Orient's "say it first" routing keyed only on a
// status `checks[]` row `ir_invalid`, which only the optional nightly `eff snapshot` job raises, and
// weekly reads the roster with `all: true` — whose only signal is the user's row's bare
// `ir_invalid` field (the "every add is blocked" warning is the one-team read's) — and never told
// the model to read it, so on the owner's two-IR-slot format a briefing presented claims, a scramble
// and K/D-ST streams ESPN refuses, and never led with the fix. Held here: orient's rule names every
// signal and the fix — who must leave IR exactly as `auditIr` rules it (an untagged, ACTIVE or
// suspended occupant, or one too many; never a Questionable or Doubtful one, who may stay and could
// not go back in); the signals are fields the roster tool's own output schema has; weekly reads
// the field, the one-team read and the lead line; the other Skills that add players route to the
// rule; and on fx-10h/ir-invalid (core, fixture mode, no network, no cookie) the status has no check
// to key on, the all-teams read flags the user's row, and the one-team read is the same cached read.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { z } from "zod/v4";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditIr, irStayStatus, type RosterSeat } from "../../src/domain/league/roster.js";
import { ESPN_INJURY_STATUSES, type RosterSlots } from "../../src/domain/league/types.js";
import { REGISTRY } from "../../src/mcp/registry.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "../mcp/helpers/world.js";
import { ROOT, readSequence } from "./helpers.js";

const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");
const ORIENT = read("skills/_shared/references/orient.md");
/** The paragraph of a Markdown text that opens with `**<title>.**`. */
function paragraph(text: string, title: string): string {
  const at = text.indexOf(`**${title}.**`);
  if (at === -1) throw new Error(`no "${title}" paragraph`);
  const end = text.indexOf("\n\n", at);
  return text.slice(at, end === -1 ? text.length : end);
}
const RULE = paragraph(ORIENT, "An invalid roster");
/** A SKILL.md body without its frontmatter and generated blocks. */
function ownBody(skill: string): string {
  const text = read(`skills/${skill}/SKILL.md`);
  const body = text.slice(text.indexOf("\n---\n", 4) + 5);
  return body.replace(/<!-- BEGIN GENERATED[\s\S]*?<!-- END GENERATED[^\n]*\n?/g, "");
}

/** Whether a JSON Schema has the property path (`[]` steps into array items; unions are searched). */
function hasPath(schema: unknown, steps: readonly string[]): boolean {
  if (steps.length === 0) return true;
  if (typeof schema !== "object" || schema === null) return false;
  const o = schema as Record<string, unknown>;
  for (const k of ["anyOf", "oneOf", "allOf"])
    if (Array.isArray(o[k]) && (o[k] as unknown[]).some((s) => hasPath(s, steps))) return true;
  const [head = "", ...rest] = steps;
  if (head === "[]") return hasPath(o.items, rest);
  const props = o.properties as Record<string, unknown> | undefined;
  return props !== undefined && head in props && hasPath(props[head], rest);
}
const rosterSchema = (() => {
  const def = REGISTRY.find((e) => e.name === "espn_get_roster")?.tool;
  if (def === undefined || def === null) throw new Error("espn_get_roster is not built");
  return z.toJSONSchema(def.data, { unrepresentable: "any", io: "output" });
})();

describe("orient: An invalid roster (Stage C finding skills-weekly-invalid-ir-not-surfaced)", () => {
  it("names every signal — the status check, the one-team read and the all-teams read — and leads with the line", () => {
    expect(RULE).toContain("a `checks[]` row `ir_invalid`");
    expect(RULE).toContain("`ir.invalid: true` from `espn_get_roster` for the user's team");
    expect(RULE).toContain(
      "`ir_invalid: true` on the user's row (`is_mine: true`) of an `all: true` read",
    );
    expect(RULE).toMatch(
      /open the answer with \*\*"Roster INVALID — every add is blocked"\*\*, whatever the question/,
    );
    // the routing row hands the status check to the same rule
    const row =
      ORIENT.split("\n").find((l) => l.startsWith("| a `checks[]` row `ir_invalid` |")) ?? "";
    expect(row).toMatch(/Say it first, whatever the question — \*\*An invalid roster\*\*/);
  });

  it("says who must leave IR exactly as the IR audit rules it — never a Questionable or Doubtful player", () => {
    // who must leave: the occupants irStayStatus calls invalid (no tag, ACTIVE, SUSPENSION) …
    const mustLeave = [null, ...ESPN_INJURY_STATUSES].filter((s) => irStayStatus(s) === "invalid");
    expect(mustLeave).toEqual([null, "ACTIVE", "SUSPENSION"]);
    expect(RULE).toContain(
      "Each player in `ir.invalid_players[]` — in IR with no injury tag, `ACTIVE` or `SUSPENSION` — must leave the IR slot first",
    );
    // … or, with none of them, an IR holding more players than its seats
    expect(RULE).toContain(
      "when that list is empty, IR holds more players than its seats (`ir.slots`) and one of them must leave",
    );
    // who may stay: a Questionable or Doubtful occupant, who cannot go back in once moved out — a
    // rule that sent every occupant without an OUT or INJURY_RESERVE tag out of IR told the user to
    // make exactly that irreversible move
    const mayStay = ESPN_INJURY_STATUSES.filter((s) => irStayStatus(s) === "may_stay");
    expect(mayStay).toEqual(["QUESTIONABLE", "DOUBTFUL"]);
    expect(RULE).toMatch(
      /A `QUESTIONABLE` or `DOUBTFUL` player may stay in IR: never tell the user to move him out, because he cannot go back in while he carries that tag/,
    );
    expect(RULE).not.toMatch(/without an `OUT` or `INJURY_RESERVE` tag/);
  });

  it("the audit behind the rule: a Questionable occupant is valid; an ACTIVE one or an overflow is invalid", () => {
    // the owner's format: 9 starters, 5 bench, 2 IR (slot 20 = BE, 21 = IR)
    const slots: RosterSlots = {
      slots: [],
      starters: 9,
      bench: 5,
      ir: 2,
      total: 16,
      lineup_lock_type: null,
      undroppable_list: null,
      position_limits: {},
      move_limit: null,
    };
    const seat = (id: number, slot: number, status: string | null): RosterSeat => ({
      player_id: id,
      slot_id: slot,
      eligible_slot_ids: [2, 20, 21],
      injury_status: status,
      position: "RB",
      pro_team_id: 1,
    });
    const active = Array.from({ length: 13 }, (_, i) => seat(100 + i, 20, null));
    const questionable = auditIr(
      [...active, seat(1, 21, "QUESTIONABLE"), seat(2, 21, "OUT")],
      slots,
    );
    expect(questionable.invalid).toBe(false);
    expect(questionable.invalid_players).toEqual([]);
    const healthy = auditIr([...active, seat(1, 21, "ACTIVE"), seat(2, 21, "OUT")], slots);
    expect(healthy).toMatchObject({ invalid: true, invalid_players: [1], blocked: ["adds"] });
    const overflow = auditIr(
      [...active, seat(1, 21, "OUT"), seat(2, 21, "OUT"), seat(3, 21, "INJURY_RESERVE")],
      slots,
    );
    expect(overflow).toMatchObject({ invalid: true, invalid_players: [], blocked: ["adds"] });
  });

  it("says what the fix forces, why it comes first and by when; every add waits for it", () => {
    expect(RULE).toContain("(`ir.forced_drop_needed`)");
    expect(RULE).toMatch(/ESPN refuses every claim and free-agent add until it is done/);
    expect(RULE).toMatch(/due before the next waiver run \(`rules\.waiver\.next_execution`\)/);
    expect(RULE).toMatch(
      /Every claim, free-agent add or stream in the answer is shown as blocked until then/,
    );
  });

  it("every field the rule keys on is in espn_get_roster's own output schema", () => {
    for (const p of [
      ["ir", "invalid"],
      ["ir", "invalid_players"],
      ["ir", "forced_drop_needed"],
      ["rosters", "[]", "is_mine"],
      ["rosters", "[]", "ir_invalid"],
    ])
      expect(hasPath(rosterSchema, p), p.join(".")).toBe(true);
  });

  it("the guardrail and the never-re-fetch row agree with it", () => {
    expect(read("skills/_shared/references/guardrails.md")).toMatch(
      /blocks every add — say so first \(\*\*An invalid roster\*\* in references\/orient\.md\)/,
    );
    const refetch = ORIENT.split("\n").find((l) => l.startsWith("| `espn_get_roster` |")) ?? "";
    expect(refetch).toMatch(
      /one team's read after an `all: true` read of the same week is the same cached read/,
    );
  });
});

describe("weekly reads the all-teams row and leads with an invalid roster", () => {
  const body = ownBody("weekly");
  const step =
    body.split("\n").find((l) => l.startsWith("2. `espn_get_roster` with `all: true`")) ?? "";

  it("step 2 reads ir_invalid on the user's row, reads the user's team once more, and follows the rule", () => {
    expect(step).toContain("Read `ir_invalid` on the user's row");
    expect(step).toContain("(its row has `is_mine: true`)");
    expect(step).toMatch(
      /call `espn_get_roster` for the user's team once \(the same cached read, no new ESPN request\)/,
    );
    expect(step).toContain("`ir.invalid_players[]`");
    expect(step).toContain("`ir.forced_drop_needed`");
    expect(step).toContain("**An invalid roster** in [orient](references/orient.md)");
    expect(step).toMatch(/every claim, free-agent add and stream below is shown as blocked/);
  });

  it("the page opens with the line before Last week, and the guardrail says so", () => {
    expect(body).toMatch(
      /On an invalid roster \(step 2\) the page opens, before Last week, with \*\*"Roster INVALID — every add is blocked"\*\*/,
    );
    expect(body).toMatch(
      /- An invalid roster \(`ir_invalid` on the user's row\) leads the briefing/,
    );
  });

  it("Lane 1: the ir_invalid sequence reads all teams, then the user's team, before any waiver call", () => {
    const seq = readSequence("weekly").sequences.find((q) => q.id === "ir_invalid");
    expect(seq?.fixture_variant).toBe("ir-invalid");
    const steps = seq?.steps ?? [];
    const all = steps.findIndex((x) => x.tool === "espn_get_roster" && x.args.all === true);
    const mine = steps.findIndex(
      (x) =>
        x.tool === "espn_get_roster" && x.args.all === undefined && x.args.team_id === undefined,
    );
    const waivers = steps.findIndex((x) => x.tool === "espn_analyze_waivers");
    expect(all).toBeGreaterThan(-1);
    expect(mine).toBeGreaterThan(all);
    expect(waivers).toBeGreaterThan(mine);
  });

  it("every other Skill that adds players routes its roster read's ir.invalid to the rule", () => {
    for (const s of ["waivers", "stream-kdef", "injury-cascade"]) {
      const b = ownBody(s);
      const line = b
        .split("\n")
        .find((l) => l.includes("`ir.invalid`") || l.includes("`ir.invalid: true`"));
      expect(line, `${s}: reads ir.invalid`).toBeDefined();
      expect(line, s).toContain("**An invalid roster** in [orient](references/orient.md)");
    }
  });
});

describe("fx-10h/ir-invalid: the signals the Skill must read (core, fixture mode)", () => {
  const DIR = path.join(ESPN_FIXTURES, "fx-10h", "ir-invalid");
  const manifest = JSON.parse(readFileSync(path.join(DIR, "manifest.json"), "utf8")) as {
    clock: string;
    my_team_id: number;
    current_week: number;
  };
  let world: World;
  let client: Client;
  let close: () => Promise<void>;
  beforeAll(async () => {
    world = await makeWorld({
      env: { EFF_FIXTURE_DIR: DIR },
      teamId: manifest.my_team_id,
      clock: manifest.clock,
    });
    ({ client, close } = await connect(world));
  }, 120_000);
  afterAll(async () => {
    await close();
    world.cleanup();
  });

  it("no status check to key on; the all-teams row says invalid; the one-team read is the same cached read and names the fix", async () => {
    const status = await call(client, "espn_get_status", { include_checks: true });
    expect(status.isError).toBe(false);
    const checks = (status.body.data as { checks?: { id: string }[] }).checks ?? [];
    expect(checks.map((c) => c.id)).not.toContain("ir_invalid");

    const week = manifest.current_week;
    const all = await call(client, "espn_get_roster", { all: true, week });
    expect(all.isError).toBe(false);
    const mineRow = (
      all.body.data as { rosters: { team_id: number; is_mine: boolean; ir_invalid: boolean }[] }
    ).rosters.find((r) => r.is_mine);
    expect(mineRow?.team_id).toBe(manifest.my_team_id);
    expect(mineRow?.ir_invalid, "the all-teams read's only signal").toBe(true);

    const requests = world.requests.length;
    const one = await call(client, "espn_get_roster", { week });
    expect(one.isError).toBe(false);
    expect(world.requests.length, "the one-team read asks ESPN for nothing new").toBe(requests);
    const ir = (
      one.body.data as {
        ir: {
          invalid: boolean;
          invalid_players: number[];
          forced_drop_needed: boolean;
          blocked: string[];
        };
      }
    ).ir;
    expect(ir.invalid).toBe(true);
    expect(ir.invalid_players.length).toBeGreaterThan(0);
    expect(ir.blocked).toEqual(["adds"]);
    expect(typeof ir.forced_drop_needed).toBe("boolean");
  }, 120_000);
});
