// prompt-free-text.test.ts — a free-text prompt argument that may have been cut to its first word is
// never asserted as the user's argument (plan 07 §4.2 names Claude Code as a client of the prompts).
// Stage C finding prompts-multiword-arg-truncated: Claude Code 2.1.238 runs an MCP prompt's slash
// command as `getPrompt({ name, arguments: zipObject(argNames, typed.trim().split(/\s+/)) })` — one
// word per declared argument, the rest dropped — so the four free-text prompts (espn.apply what,
// espn.trade offer, espn.injury player, espn.check claim) received only the first word, and the
// prompt rendered it as the authoritative `Arguments:` line the Skill then used verbatim.
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_PROMPTS, FREE_TEXT_ONE_WORD_NOTE, promptText } from "../../src/mcp/prompts/index.js";
import { connect, makeWorld, type World } from "./helpers/world.js";

let world: World;
let client: Client;
let close: () => Promise<void>;

beforeAll(async () => {
  world = await makeWorld({ publishEspn: false });
  ({ client, close } = await connect(world, { options: { toolset: "full" } }));
}, 120_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

/** Claude Code 2.1.238's mapping of the typed text onto the declared arguments. */
function claudeCodeArgs(argNames: readonly string[], typed: string): Record<string, string> {
  const words = typed.trim() === "" ? [] : typed.trim().split(/\s+/);
  const out: Record<string, string> = {};
  argNames.forEach((n, i) => {
    const w = words[i];
    if (w !== undefined) out[n] = w;
  });
  return out;
}

const textOf = (r: { messages: { content: { type: string; text?: string } }[] }): string =>
  r.messages[0]?.content.text ?? "";

const FREE_TEXT: readonly [string, string, string][] = [
  ["espn.check", "claim", "Beat writer: the backup gets more work"],
  ["espn.injury", "player", "Christian McCaffrey"],
  ["espn.apply", "what", "start Rice at FLEX"],
  ["espn.trade", "offer", "my WR2 for their RB1"],
];

describe("free-text prompt arguments (Stage C prompts-multiword-arg-truncated)", () => {
  it("the four free-text prompts declare their argument as free text", () => {
    for (const [name, arg] of FREE_TEXT)
      expect(ALL_PROMPTS.find((p) => p.name === name)?.freeText, name).toEqual([arg]);
  });

  it.each(FREE_TEXT)(
    "%s: the first word Claude Code sends is flagged, never asserted as the user's %s",
    async (name, arg, sentence) => {
      const sent = claudeCodeArgs([arg], sentence);
      expect(sent[arg]).toBe(sentence.split(" ")[0]); // the repro: one word arrives
      const r = await client.getPrompt({ name, arguments: sent });
      const text = textOf(r);
      expect(text).toContain(`Arguments: ${arg}=${JSON.stringify(sent[arg])}`);
      expect(text).toContain(`The \`${arg}\` argument ${FREE_TEXT_ONE_WORD_NOTE}`);
      // a client that sends the whole sentence needs no note
      const whole = textOf(await client.getPrompt({ name, arguments: { [arg]: sentence } }));
      expect(whole).toContain(`Arguments: ${arg}=${JSON.stringify(sentence)}`);
      expect(whole).not.toContain(FREE_TEXT_ONE_WORD_NOTE);
    },
  );

  it("a week or a position is never a free-text argument (no note)", async () => {
    const week = textOf(await client.getPrompt({ name: "espn.weekly", arguments: { week: "7" } }));
    expect(week).not.toContain(FREE_TEXT_ONE_WORD_NOTE);
    const stream = textOf(
      await client.getPrompt({ name: "espn.stream", arguments: { position: "K" } }),
    );
    expect(stream).not.toContain(FREE_TEXT_ONE_WORD_NOTE);
  });

  // Stage C finding prompts-one-word-note-blocks-complete-args: the note fired on word count alone
  // and ended "Never use that one word alone as what the user asked", so a prompt-only client
  // (Claude Desktop / claude.ai, plan 09 §6), which sends the whole form field, was told never to use
  // espn.trade's documented partner search "RB", an espn.injury surname or player id, or
  // espn.apply's "claim" — and to ask again
  it("the note never forbids the value: the user's own message decides, else the word as given", () => {
    expect(FREE_TEXT_ONE_WORD_NOTE).not.toMatch(/never use|do not use|don't use/i);
    expect(FREE_TEXT_ONE_WORD_NOTE).toContain("otherwise use the word as given");
  });

  it.each([
    ["espn.trade", "offer", "RB", "RB"],
    ["espn.trade", "offer", "rb", "RB"],
    ["espn.trade", "offer", "WR", "WR"],
    ["espn.trade", "offer", "DST", "D/ST"],
    ["espn.trade", "offer", "D/ST", "D/ST"],
    ["espn.injury", "player", "4361050", "4361050"],
    ["espn.injury", "player", "00-0036389", "00-0036389"],
    ["espn.apply", "what", "claim", "claim"],
    ["espn.apply", "what", "lineup", "lineup"],
    ["espn.apply", "what", "trade", "trade"],
  ])("%s %s=%s is a complete argument: used as given, no note", async (name, arg, sent, shown) => {
    const text = textOf(await client.getPrompt({ name, arguments: { [arg]: sent } }));
    expect(text).toContain(`Arguments: ${arg}=${JSON.stringify(shown)}`);
    expect(text).not.toContain(FREE_TEXT_ONE_WORD_NOTE);
    expect(text).not.toMatch(/never use that one word/i);
  });

  it("a one-word name (espn.injury 'Kamara') may be whole or cut short: the note lets it be used as given", async () => {
    const text = textOf(
      await client.getPrompt({ name: "espn.injury", arguments: { player: "Kamara" } }),
    );
    expect(text).toContain('Arguments: player="Kamara"');
    expect(text).toContain(`The \`player\` argument ${FREE_TEXT_ONE_WORD_NOTE}`);
    expect(text).not.toMatch(/never use that one word/i);
  });

  it("promptText: a complete one-word form takes no note; any other one word still does", () => {
    const texts = { skills: { x: "Body." }, references: {} } as never;
    const forms = { offer: /^RB$/ };
    expect(promptText(texts, "x", { offer: "RB" }, ["offer"], forms)).not.toContain(
      FREE_TEXT_ONE_WORD_NOTE,
    );
    expect(promptText(texts, "x", { offer: "my" }, ["offer"], forms)).toContain(
      FREE_TEXT_ONE_WORD_NOTE,
    );
    // a form of another argument never exempts this one
    expect(promptText(texts, "x", { claim: "RB" }, ["claim"], forms)).toContain(
      FREE_TEXT_ONE_WORD_NOTE,
    );
  });

  it("promptText: the note follows the arguments line, only for one-word free text", () => {
    const texts = { skills: { x: "Body." }, references: {} } as never;
    const base = promptText(texts, "x", {}).trimEnd(); // the guardrails and the body
    expect(promptText(texts, "x", { claim: "Beat" }, ["claim"])).toBe(
      `${base}\n\nArguments: claim="Beat"\n\nThe \`claim\` argument ${FREE_TEXT_ONE_WORD_NOTE}\n`,
    );
    expect(promptText(texts, "x", { claim: "two words" }, ["claim"])).not.toContain(
      FREE_TEXT_ONE_WORD_NOTE,
    );
    expect(promptText(texts, "x", { claim: "Beat" })).not.toContain(FREE_TEXT_ONE_WORD_NOTE);
  });
});
