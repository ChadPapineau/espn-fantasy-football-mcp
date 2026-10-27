// session-check-auth.test.ts — a null espn_check_auth answer is reported by its `reason` (Stage C
// finding skills-session-check-not-configured-branch; plan 07 G2; plan 09 §3.7). G2 answers
// `accepted: null` for two reasons: `not_configured` (the server holds no cookies it can use — none
// stored, or the store unreadable — so nothing was probed) and `board_not_discriminating` (a public
// league's board answers anyone the same). session-check §4 had a null case only under "A public
// league" and the cheat-sheet called null "the probe cannot tell on this league", so after an
// `eff setup` that aborted, refused a value or ran under another configuration, a private-league user
// was told the board cannot be tested instead of "no cookies are stored yet". The reasons are read
// from the registry's own output schema, so a reason G2 gains fails here until the Skill says what
// it means; and on a fixture-mode server (no credential, no network) G2 does answer
// `not_configured`, with zero ESPN requests — the case this branch now handles.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { z } from "zod/v4";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REGISTRY } from "../../src/mcp/registry.js";
import { call, connect, makeWorld, type World } from "../mcp/helpers/world.js";
import { ROOT } from "./helpers.js";

const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");
const BODY = read("skills/session-check/SKILL.md");
/** A `### N. …` step of a body, up to the next heading. */
function step(body: string, heading: string): string {
  const at = body.indexOf(`\n${heading}\n`);
  if (at === -1) throw new Error(`no "${heading}"`);
  const rest = body.slice(at + heading.length + 2);
  const next = rest.search(/\n#{2,3} /);
  return next === -1 ? rest : rest.slice(0, next);
}
const VERIFY = step(BODY, "### 4. Verify — once");
const BOARD_SENTENCE =
  "this league's board answers the same to anyone, so the session cannot be tested on this league";

/** G2's `reason` values, from its output schema (a nullable enum). */
const REASONS = (() => {
  const def = REGISTRY.find((e) => e.name === "espn_check_auth")?.tool;
  if (def === undefined || def === null) throw new Error("espn_check_auth is not built");
  const schema = z.toJSONSchema(def.data, { unrepresentable: "any", io: "output" }) as {
    properties: Record<string, { anyOf?: { enum?: unknown[] }[]; enum?: unknown[] }>;
  };
  const reason = schema.properties.reason;
  const values = [...(reason?.enum ?? []), ...(reason?.anyOf ?? []).flatMap((s) => s.enum ?? [])];
  return values.filter((v): v is string => typeof v === "string").sort();
})();

/** §4's bullet for one reason of a null answer. */
const branch = (reason: string): string =>
  VERIFY.split("\n").find((l) =>
    l.startsWith(`- **\`accepted: null\`, \`reason: ${reason}\`:**`),
  ) ?? "";

describe("session-check §4 reports a null probe by its reason (Stage C skills-session-check-not-configured-branch)", () => {
  it("G2's null reasons are read from its schema: not_configured and board_not_discriminating", () => {
    expect(REASONS).toEqual(["board_not_discriminating", "not_configured"]);
  });

  it("has one bullet per reason, plus accepted true and false", () => {
    for (const r of REASONS) expect(branch(r), r).not.toBe("");
    expect(VERIFY).toMatch(/^- \*\*`accepted: true`:\*\*/m);
    expect(VERIFY).toMatch(/^- \*\*`accepted: false`:\*\*/m);
    expect(VERIFY).toMatch(/report by `accepted` and, when it is null, by `reason`/);
    // still one probe, never a loop
    expect(VERIFY).toMatch(
      /call `espn_check_auth` \*\*once\*\* — never twice in a turn, never in a loop/,
    );
  });

  it("not_configured: no cookies are stored yet — eff setup again in a terminal, eff doctor if it said stored — never the board sentence", () => {
    const b = branch("not_configured");
    expect(b).toMatch(/nothing was probed — the server found no cookies it can use/);
    expect(b).toContain('**"no cookies are stored yet"**');
    expect(b).toMatch(/run `eff setup` again in a terminal and read how it ends/);
    expect(b).toMatch(/`eff doctor` in a terminal says why it cannot read them/);
    expect(b).toMatch(/Never call this a board that cannot be tested/);
    expect(b).not.toContain(BOARD_SENTENCE);
    // never asks for the command's output (the Skill's own guardrail)
    expect(b).not.toMatch(/paste (the|its) output|send me the output/i);
  });

  it("the board sentence belongs to board_not_discriminating alone", () => {
    expect(branch("board_not_discriminating")).toContain(BOARD_SENTENCE);
    const uses = VERIFY.split("\n").filter((l) => l.includes(BOARD_SENTENCE));
    expect(uses).toEqual([branch("board_not_discriminating")]);
  });

  it("the cheat-sheet says what each reason means; onboard's one probe branches the same way", () => {
    const row =
      read("skills/_shared/references/tool-outputs.md")
        .split("\n")
        .find((l) => l.startsWith("| `espn_check_auth` |")) ?? "";
    expect(row).toMatch(/null when the probe cannot tell — `reason` says why/);
    expect(row).toMatch(
      /`not_configured`: the server holds no cookies it can use — none stored, or the store unreadable — so nothing was probed/,
    );
    expect(row).toMatch(
      /`board_not_discriminating`: a public league's message board answers anyone the same/,
    );
    const onboard = read("skills/onboard/SKILL.md");
    const probe =
      onboard.split("\n").find((l) => l.includes("call `espn_check_auth` **once**")) ?? "";
    for (const r of REASONS) expect(probe, `onboard §7: ${r}`).toContain(`\`${r}\``);
    expect(probe).toMatch(
      /`not_configured`: the server could not read the stored cookies, so nothing was tested/,
    );
  });
});

describe("a fixture-mode server with no credential answers G2 with reason not_configured", () => {
  let world: World;
  let client: Client;
  let close: () => Promise<void>;
  beforeAll(async () => {
    world = await makeWorld({ publishEspn: false });
    ({ client, close } = await connect(world));
  }, 120_000);
  afterAll(async () => {
    await close();
    world.cleanup();
  });

  it("accepted null, reason not_configured, state not_configured — and no ESPN request", async () => {
    const before = world.requests.length;
    const r = await call(client, "espn_check_auth", {});
    expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
    const d = r.body.data as { accepted: unknown; reason: unknown; state: unknown; probe: unknown };
    expect(d).toMatchObject({ accepted: null, reason: "not_configured", state: "not_configured" });
    expect(world.requests.length).toBe(before);
  }, 60_000);
});
