// waivers-budget-room.test.ts — E5's budget room at the schema's adversarial limits (plan 07 E5 and
// C8's 10 000-character analytics budget; changelog §R16, R16-6; the §R16 gate's open question 11).
// When the budget cuts every candidate row, espn_analyze_waivers still names each listed player in
// data.truncated_names, so the answer with no row left must fit: were E5's other fields to grow past
// the room it leaves, an answer whose 25 listed candidates carry the costliest names the schema
// accepts would fail the fit and answer INTERNAL (define.ts runTool). For each real answer on fx-10h —
// core, full and the faab variant; a cold server and a warm one; compact and full detail — its rows
// are made the schema's worst (25 of them, every one listed, ids of the widest person id's 8 digits,
// names of 64 characters that each serialise to two), and the least budget the server's own fit
// meets is found: the room is the budget less it. The tightest room is held at the floor measured
// when the test was written, so the test fails, saying what shrank, the moment a change eats into it.
// Fixture mode, in process, no network; the tool runs through runTool, its output before the budget
// captured.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bareUntrusted } from "../../src/domain/league/types.js";
import {
  envelopeOf,
  fitOptionsOf,
  outputSchemaOf,
  runTool,
  type AnyToolDefinition,
  type ToolOutput,
} from "../../src/mcp/define.js";
import {
  ANALYTICS_BUDGET_CHARS,
  PLAYER_ID_MAX,
  fitLengthOf,
  fitToBudget,
  isEspnPlayerId,
  serializeEnvelope,
  type Envelope,
} from "../../src/mcp/envelope.js";
import { analyzeWaiversTool, waiverTrims } from "../../src/mcp/tools/analytics.js";
import { playerName } from "../../src/mcp/tools/schemas.js";
import { waiverNameProblems } from "./helpers/waiver-names.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

type J = Record<string, unknown>;
const FX = path.join(ESPN_FIXTURES, "fx-10h");

/**
 * The tightest room measured when this test was written (characters, 2026-11-25): `full` on the faab
 * variant, mode faab with the playoff reserve, on a cold server, whose answer with every row cut
 * takes 9 532 of the 10 000 (the same under coverage and on every run: its clock-derived fields are
 * ISO times of a fixed width, and `age_s`, which the fit counts at a fixed width). Lowered only on
 * purpose, with the reason.
 */
const ROOM_FLOOR = 468;

/** The costliest name the schema accepts: 64 code units, each a `"` that serialises to two. */
const WORST_NAME = bareUntrusted('"'.repeat(64), "player_name");
/** 25 ids of the widest person id (8 digits), the schema's widest. */
const WORST_IDS = Array.from({ length: 25 }, (_, i) => PLAYER_ID_MAX - 24 + i);

interface Row extends J {
  readonly player_id: number;
  readonly name: string;
}
interface Data extends J {
  readonly candidates: readonly Row[];
  readonly claim_list: readonly number[];
  readonly marginal: readonly number[];
  readonly scramble_list: readonly number[];
  readonly truncated_names: readonly { readonly player_id: number; readonly name: string }[];
}
type Body = Envelope<Data>;

/** One captured call: its label and arguments, the tool's output before the budget, the clock. */
interface Captured {
  readonly label: string;
  readonly args: J;
  readonly out: ToolOutput<Data>;
  readonly sent: Body;
  readonly nowMs: number;
}

/** WV-1's call (skills/waivers step 5): every mode auto, no player named. */
const AUTO = { mode: "auto", phase: "auto", value_source: "auto" } as const;
/** WV-3-E's kind of call: FAAB bids with the playoff reserve held back. */
const FAAB = { mode: "faab", reserve: "playoff_reserve" } as const;

async function fxWorld(variant: "" | "faab", toolset: "core" | "full"): Promise<World> {
  const dir = variant === "" ? FX : path.join(FX, variant);
  const m = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as {
    clock: string;
    my_team_id: number;
  };
  return makeWorld({
    env: { EFF_FIXTURE_DIR: dir, EFF_TOOLSET: toolset },
    teamId: m.my_team_id,
    clock: m.clock,
  });
}

/** The reads WV-1's procedure makes before the waivers call (a warm server). */
async function warm(world: World): Promise<void> {
  const c = await connect(world);
  try {
    const steps: readonly [string, J][] = [
      ["espn_get_league", {}],
      ["espn_get_roster", { week: 5 }],
      ["espn_get_standings", {}],
      ["espn_list_players", { status: "WAIVERS", sort: "percOwned", week: 5, limit: 25 }],
    ];
    for (const [name, args] of steps) {
      const r = await call(c.client, name, args);
      expect(r.isError, `${name}: ${JSON.stringify(r.body).slice(0, 300)}`).toBe(false);
    }
  } finally {
    await c.close();
  }
}

/** One espn_analyze_waivers call through runTool, the tool's own output (before the budget) kept. */
async function waiversCall(world: World, label: string, args: J): Promise<Captured> {
  const seen: { out?: ToolOutput<unknown> } = {};
  const spy: AnyToolDefinition = {
    ...analyzeWaiversTool,
    run: async (a, ctx) => {
      const out = await analyzeWaiversTool.run(a, ctx);
      seen.out = out;
      return out;
    },
  };
  const nowMs = world.clock.nowMs();
  const r = await runTool(
    spy,
    analyzeWaiversTool.input.parse(args),
    { requestId: "r-00000000b001" },
    world.services,
    world.options,
  );
  if (seen.out === undefined) throw new Error(`${label}: the tool did not run`);
  const sent = JSON.parse(r.content[0].text) as Body;
  return { label, args, out: seen.out as ToolOutput<Data>, sent, nowMs };
}

/**
 * The answer's data at the schema's limits: 25 rows cloned from its own (their fields as the engine
 * gave them), each with a worst id and the worst name, every one in scramble_list and in claim_list
 * or marginal by turns (the engine never lists one id in both).
 */
function atLimits(d: Data): Data {
  if (d.candidates.length === 0) throw new Error("the answer has no candidate row to clone");
  const candidates = WORST_IDS.map((id, i) => {
    const base = d.candidates[i % d.candidates.length];
    if (base === undefined) throw new Error("no row");
    return { ...base, player_id: id, name: WORST_NAME };
  });
  return {
    ...d,
    candidates,
    claim_list: WORST_IDS.filter((_, i) => i % 2 === 0),
    marginal: WORST_IDS.filter((_, i) => i % 2 === 1),
    scramble_list: WORST_IDS,
    truncated_names: [],
  };
}

/** One answer's room: the budget less the least budget the server's fit meets at the limits. */
interface Room {
  readonly label: string;
  readonly room: number;
  readonly least: number;
  readonly kept: Body;
}

function roomOf(c: Captured): Room {
  const data = atLimits(c.out.data);
  const env = envelopeOf(
    { ...c.out, data },
    { requestId: "r-00000000b002", nowMs: c.nowMs },
    analyzeWaiversTool,
  );
  const opts = fitOptionsOf(analyzeWaiversTool, c.args, waiverTrims(data.candidates.length));
  const fits = (budget: number) => fitToBudget(env, budget, c.out.listKey, opts);
  // the fit meets a budget exactly when some step of its fixed sequence of cuts does, so the least
  // budget it meets is found by bisection
  let lo = 0;
  let hi = 4 * ANALYTICS_BUDGET_CHARS;
  if (!fits(hi).ok) throw new Error(`${c.label}: no fit even at ${String(hi)} characters`);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid).ok) hi = mid;
    else lo = mid + 1;
  }
  const f = fits(lo);
  if (!f.ok) throw new Error(`${c.label}: the bisection's budget does not fit`);
  const kept = JSON.parse(serializeEnvelope(f.envelope)) as Body;
  return { label: c.label, room: ANALYTICS_BUDGET_CHARS - lo, least: lo, kept };
}

const worlds: World[] = [];
const captured: Captured[] = [];

beforeAll(async () => {
  const plan: readonly {
    readonly variant: "" | "faab";
    readonly toolset: "core" | "full";
    readonly cold: J;
    readonly warm: readonly J[];
  }[] = [
    { variant: "", toolset: "core", cold: AUTO, warm: [AUTO, { ...AUTO, detail: "full" }] },
    { variant: "", toolset: "full", cold: AUTO, warm: [AUTO, { ...AUTO, detail: "full" }] },
    {
      variant: "faab",
      toolset: "full",
      cold: FAAB,
      warm: [FAAB, { ...FAAB, detail: "full" }, { mode: "faab" }],
    },
  ];
  for (const p of plan) {
    const world = await fxWorld(p.variant, p.toolset);
    worlds.push(world);
    const name = `${p.variant === "" ? "fx-10h" : p.variant} ${p.toolset}`;
    captured.push(await waiversCall(world, `${name}, cold, ${JSON.stringify(p.cold)}`, p.cold));
    await warm(world);
    for (const args of p.warm)
      captured.push(await waiversCall(world, `${name}, warm, ${JSON.stringify(args)}`, args));
  }
}, 600_000);
afterAll(() => {
  for (const w of worlds) w.cleanup();
});

describe("E5's budget room at the schema's limits (the §R16 gate's open question 11)", () => {
  it("the worst rows are valid: ids and names the schema accepts at its widest", () => {
    expect(WORST_NAME).toHaveLength(64);
    expect(JSON.stringify(WORST_NAME)).toHaveLength(2 + 128);
    expect(playerName.safeParse(WORST_NAME).success).toBe(true);
    for (const id of WORST_IDS) expect(isEspnPlayerId(id)).toBe(true);
    expect(isEspnPlayerId(PLAYER_ID_MAX + 1)).toBe(false);
    expect(String(PLAYER_ID_MAX)).toHaveLength(8);
    expect(captured.map((c) => c.out.data.candidates.length).every((n) => n > 0)).toBe(true);
  });

  it("every real answer, made the schema's worst, still fits with every row cut and every listed player named", () => {
    for (const c of captured) {
      const r = roomOf(c);
      const d = r.kept.data;
      // measured where the risk is: no row kept, the 25 listed players named by truncated_names
      expect(d.candidates, r.label).toEqual([]);
      expect(
        d.truncated_names.map((t) => t.player_id),
        r.label,
      ).toEqual(WORST_IDS);
      for (const t of d.truncated_names) expect(t.name, r.label).toBe(WORST_NAME);
      expect(waiverNameProblems(d), r.label).toEqual([]);
      expect(fitLengthOf(serializeEnvelope(r.kept)), r.label).toBe(r.least);
      expect(outputSchemaOf(analyzeWaiversTool).safeParse(r.kept).success, r.label).toBe(true);
      // and the server's own fit at the real budget answers inside it
      const real = fitToBudget(
        envelopeOf(
          { ...c.out, data: atLimits(c.out.data) },
          { requestId: "r-00000000b003", nowMs: c.nowMs },
          analyzeWaiversTool,
        ),
        ANALYTICS_BUDGET_CHARS,
        c.out.listKey,
        fitOptionsOf(analyzeWaiversTool, c.args, waiverTrims(25)),
      );
      expect(
        real.ok,
        `${r.label}: the server's fit fails at ${String(ANALYTICS_BUDGET_CHARS)}`,
      ).toBe(true);
    }
  });

  it("the tightest room holds its floor, and the test says what shrank when it does not", () => {
    const rooms = captured.map(roomOf).sort((a, b) => a.room - b.room);
    for (const r of rooms)
      console.log(
        `[size] E5 room at the schema's limits: ${String(r.room)} characters (all rows cut at ${String(r.least)}) — ${r.label}`,
      );
    const tight = rooms[0];
    if (tight === undefined) throw new Error("no answer measured");
    expect(
      tight.room,
      `E5's budget room at the schema's limits is ${String(tight.room)} characters on ${tight.label}, under the ${String(ROOM_FLOOR)} this test holds (the §R16 gate's open question 11): a change grew E5's fields outside the candidate rows. At 0 an answer whose 25 listed candidates carry the costliest names the schema accepts no longer fits with every row cut, and answers INTERNAL. Shrink what grew; if the growth is meant, lower ROOM_FLOOR to the new room and say why.`,
    ).toBeGreaterThanOrEqual(ROOM_FLOOR);
    expect(tight.room).toBeGreaterThan(0);
  });
});
