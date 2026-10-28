// prompt-args.test.ts — prompt arguments as MCP and the tools see them (plan 07 §4.2):
//  - Stage C finding `prompts-optional-args-omitted-refused`: GetPromptRequest makes `arguments`
//    optional, but a prompt whose only argument is optional (espn.weekly, espn.start_sit,
//    espn.retro [week]) answered -32602 "expected object, received undefined" when a client sent no
//    arguments object; omitted now reads as {} and a required argument still fails on itself;
//  - Stage C finding `prompts-stream-dst-spelling`: espn.stream took `DST` only and handed the model
//    `position="DST"`, which espn_list_players and espn_analyze_waivers refuse (VALIDATION
//    unknown_position); both spellings are accepted and the prompt carries the tools' `D/ST`;
//  - the Stage C final gate: an argument key a prompt does not take was stripped and the prompt
//    rendered (`__proto__` too, which tools/call answers VALIDATION for); every prompt's object is
//    strict now, the key refused -32602 and never quoted (the stdio `__proto__` leg:
//    tests/mcp/serve.test.ts).
// Both eras: the legacy initialize session and the 2026-07-28 stateless one (serveStdio).
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod/v4";
import {
  ALL_PROMPTS,
  PROMPTS,
  promptArgsSchema,
  toToolVocabulary,
  unknownArgumentMessage,
} from "../../src/mcp/prompts/index.js";
import { call, connect, makeWorld, type World } from "./helpers/world.js";

let world: World;
const sessions: { era: string; client: Client; close: () => Promise<void> }[] = [];

beforeAll(async () => {
  world = await makeWorld({ publishEspn: false });
  const legacy = await connect(world, { options: { toolset: "full" } });
  const modern = await connect(world, { modern: true, options: { toolset: "full" } });
  sessions.push({ era: "legacy", ...legacy }, { era: "modern", ...modern });
}, 120_000);
afterAll(async () => {
  for (const s of sessions) await s.close();
  world.cleanup();
});

const textOf = (r: { messages: { content: { type: string; text?: string } }[] }): string =>
  r.messages[0]?.content.text ?? "";

describe.each([0, 1])("prompt arguments (session %i)", (i) => {
  const client = (): Client => {
    const s = sessions[i];
    if (s === undefined) throw new Error("no session");
    return s.client;
  };

  it.each(["espn.weekly", "espn.start_sit", "espn.retro"])(
    "%s answers with `arguments` omitted, exactly as with {}",
    async (name) => {
      const omitted = await client().getPrompt({ name });
      const empty = await client().getPrompt({ name, arguments: {} });
      expect(textOf(omitted)).toBe(textOf(empty));
      expect(textOf(omitted)).not.toContain("Arguments:");
      expect(omitted.messages.length).toBe(empty.messages.length);
    },
  );

  it("a week given still reaches the prompt; an invalid one is still refused", async () => {
    const r = await client().getPrompt({ name: "espn.weekly", arguments: { week: "7" } });
    expect(textOf(r)).toContain('week="7"');
    const e = await client()
      .getPrompt({ name: "espn.weekly", arguments: { week: "19" } })
      .then(
        () => null,
        (x: unknown) => x,
      );
    expect(e).not.toBeNull();
  });

  it("a required argument omitted is refused on the argument (espn.stream, espn.apply)", async () => {
    for (const [name, arg] of [
      ["espn.stream", "position"],
      ["espn.apply", "what"],
      ["espn.trade", "offer"],
    ] as const) {
      const e = await client()
        .getPrompt({ name })
        .then(
          () => null,
          (x: unknown) => x,
        );
      expect(e, name).not.toBeNull();
      const message = String((e as { message?: unknown }).message);
      expect(message).toContain(`${arg}:`);
      expect(message).not.toContain("expected object");
    }
  });

  it.each([
    ["DST", "D/ST"],
    ["D/ST", "D/ST"],
    ["K", "K"],
  ])("espn.stream position %s → the prompt carries position=%s", async (given, carried) => {
    const r = await client().getPrompt({ name: "espn.stream", arguments: { position: given } });
    const text = textOf(r);
    expect(text).toContain(`position=${JSON.stringify(carried)}`);
    if (given === "DST") expect(text).not.toContain('position="DST"');
  });

  it("the carried D/ST is a value both tools the Skill calls accept (DST is refused by them)", async () => {
    const list = await call(client(), "espn_list_players", {
      position: "D/ST",
      status: "AVAILABLE",
    });
    expect(list.isError, JSON.stringify(list.body).slice(0, 200)).toBe(false);
    const refused = await call(client(), "espn_list_players", { position: "DST" });
    expect(refused.isError).toBe(true);
  });

  it("prompts/list still advertises each argument and whether it is required", async () => {
    const list = (await client().listPrompts()).prompts;
    const weekly = list.find((p) => p.name === "espn.weekly");
    const stream = list.find((p) => p.name === "espn.stream");
    expect(weekly?.arguments).toEqual([{ name: "week", required: false }]);
    expect(stream?.arguments).toEqual([{ name: "position", required: true }]);
    // an argument-less prompt registers its (empty, strict) schema too: it lists no argument
    expect(list.find((p) => p.name === "espn.onboard")?.arguments).toEqual([]);
  });

  it.each(ALL_PROMPTS.map((p) => [p.name, p] as const))(
    "%s refuses an argument key it does not take, never quoting it; the same call without it renders",
    async (name, spec) => {
      const declared = Object.keys(spec.args.shape);
      const valid = Object.fromEntries(declared.map((k) => [k, VALID_VALUE[k] ?? ""]));
      const e = await client()
        .getPrompt({ name, arguments: { ...valid, zz_undeclared: "7" } })
        .then(
          () => null,
          (x: unknown) => x,
        );
      expect(e, name).not.toBeNull();
      const message = String((e as { message?: unknown }).message);
      expect((e as { code?: unknown }).code).toBe(-32602);
      expect(message).toContain(unknownArgumentMessage(spec.args));
      expect(message).not.toContain("zz_undeclared");
      const r = await client().getPrompt({ name, arguments: valid });
      expect(r.messages.length).toBeGreaterThan(0);
    },
  );
});

/** A valid value of every declared prompt argument (the controls above). */
const VALID_VALUE: Readonly<Record<string, string>> = {
  week: "7",
  position: "K",
  what: "start the kicker",
  offer: "my WR for your RB",
  player: "12345",
  claim: "the backup gets more work",
};

describe("the argument helpers", () => {
  it("promptArgsSchema reads undefined as {} and validates everything else unchanged", async () => {
    const spec = PROMPTS.find((p) => p.name === "espn.weekly");
    if (spec === undefined) throw new Error("no espn.weekly");
    const s = promptArgsSchema(spec.args);
    expect(await s["~standard"].validate(undefined)).toEqual({ value: {} });
    expect(await s["~standard"].validate({ week: "3" })).toEqual({ value: { week: "3" } });
    const bad = await s["~standard"].validate({ week: "x" });
    expect("issues" in bad && bad.issues !== undefined && bad.issues.length > 0).toBe(true);
    const bad2 = await s["~standard"].validate("not an object");
    expect("issues" in bad2 && bad2.issues !== undefined && bad2.issues.length > 0).toBe(true);
  });

  it("promptArgsSchema refuses undeclared keys with one fixed issue and keeps the others", async () => {
    const weekly = PROMPTS.find((p) => p.name === "espn.weekly");
    const onboard = PROMPTS.find((p) => p.name === "espn.onboard");
    if (weekly === undefined || onboard === undefined) throw new Error("no prompt");
    expect(unknownArgumentMessage(weekly.args)).toBe(
      "unknown argument key (this prompt takes: week)",
    );
    expect(unknownArgumentMessage(onboard.args)).toBe(
      "unknown argument key (this prompt takes no arguments)",
    );
    // an own `__proto__` key (what JSON.parse builds) and a plain one: one issue, no key quoted
    const hostile = JSON.parse('{"week":"x","__proto__":"a","b\\"c":"d"}') as unknown;
    const r = await promptArgsSchema(weekly.args)["~standard"].validate(hostile);
    const issues = "issues" in r ? (r.issues ?? []) : [];
    expect(issues.map((i) => i.message)).toContain(unknownArgumentMessage(weekly.args));
    expect(issues.find((i) => i.message === unknownArgumentMessage(weekly.args))?.path).toEqual([]);
    // the invalid declared value is still reported on its own path
    expect(issues.some((i) => (i.path ?? []).map(String).join(".") === "week")).toBe(true);
    expect(JSON.stringify(issues)).not.toMatch(/__proto__|b\\"c/);
    expect(await promptArgsSchema(onboard.args)["~standard"].validate({})).toEqual({ value: {} });
  });

  it("every prompt's argument object is strict (an undeclared key never passes)", () => {
    for (const p of ALL_PROMPTS) expect(p.args.safeParse({ zz: "x" }).success, p.name).toBe(false);
  });

  it("an asynchronous argument schema's issues are coded the same way", async () => {
    const asyncArgs = z.strictObject({
      week: z.string().refine((v) => Promise.resolve(v !== "x")),
    });
    const s = promptArgsSchema(asyncArgs);
    const pending = s["~standard"].validate({ week: "3", zz: "y" });
    expect(pending).toBeInstanceOf(Promise);
    const r = await pending;
    expect("issues" in r ? r.issues?.map((i) => i.message) : []).toEqual([
      "unknown argument key (this prompt takes: week)",
    ]);
    expect(await s["~standard"].validate({ week: "3" })).toEqual({ value: { week: "3" } });
  });

  it("toToolVocabulary maps only the listed values of the listed argument", () => {
    const spec = { toolVocabulary: { position: { DST: "D/ST" } } };
    expect(toToolVocabulary(spec, { position: "DST" })).toEqual({ position: "D/ST" });
    expect(toToolVocabulary(spec, { position: "K", other: "DST" })).toEqual({
      position: "K",
      other: "DST",
    });
    // an inherited key is never a mapping
    expect(toToolVocabulary(spec, { position: "toString" })).toEqual({ position: "toString" });
    expect(toToolVocabulary({}, { week: undefined })).toEqual({ week: undefined });
  });
});
