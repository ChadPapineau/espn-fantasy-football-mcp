// prompt-references.test.ts — a prompt carries what its Skill body links (plan 09 §6: the
// espn.<workflow> prompts are the Skill delivery path for clients without a Skill loader, and §4:
// the two paths cannot drift). Stage C finding `prompts-skill-references-unreachable`: promptText
// sent SKILL.md alone, so a prompt-only client met 5–7 links to files it cannot open — orient's Step
// 0 and routing table (credential rejected → stop, host_moved → allow_stale, tool_contract,
// ir_invalid first) and onboard's exact log entry (whose fields the server requires). The prompt now
// appends every linked reference under a `### references/<file>` heading its link resolves to
// (except the blocks the body already inlines), embeds references/tool-outputs.md as the
// espn-ff://docs/tool-outputs resource, and names a file the installation lacks as missing.
// The reference texts reach the server through ServerTexts.references (the composition root's
// loader — injected here exactly as it reads them: skills/<skill>/references/<file>.md).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServerTexts } from "../../src/mcp/services.js";
import { ALL_PROMPTS, linkedReferences, promptText } from "../../src/mcp/prompts/index.js";
import { ROOT, connect, makeWorld, type World } from "./helpers/world.js";

/** Every prompt Skill's references, read the way the composition root's loader reads them. */
function referencesFromPackage(): NonNullable<ServerTexts["references"]> {
  const out: Record<string, Record<string, string>> = {};
  for (const p of ALL_PROMPTS) {
    const dir = path.join(ROOT, "skills", p.skill, "references");
    const files: Record<string, string> = {};
    for (const f of readdirSync(dir))
      if (f.endsWith(".md")) files[f] = readFileSync(path.join(dir, f), "utf8");
    out[p.skill] = files;
  }
  return out;
}

let world: World;
let client: Client;
let close: () => Promise<void>;
let texts: ServerTexts;
beforeAll(async () => {
  world = await makeWorld({ publishEspn: false });
  texts = { ...world.options.texts, references: referencesFromPackage() };
  ({ client, close } = await connect(world, { options: { toolset: "full", texts } }));
}, 120_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

const textOf = (r: { messages: { content: { type: string; text?: string } }[] }): string =>
  r.messages[0]?.content.text ?? "";

function argsFor(name: string): Record<string, string> {
  const m: Record<string, Record<string, string>> = {
    "espn.stream": { position: "K" },
    "espn.apply": { what: "start player 4361050" },
    "espn.trade": { offer: "my WR for their RB" },
    "espn.injury": { player: "my RB1" },
    "espn.check": { claim: "the backup will get more of the work" },
  };
  return m[name] ?? {};
}

describe("every prompt resolves every reference its body links (plan 09 §4, §6)", () => {
  it.each(ALL_PROMPTS.map((p) => [p.name]))("%s", async (name) => {
    const r = await client.getPrompt({ name, arguments: argsFor(name) });
    const text = textOf(r);
    const linked = new Set(
      [...text.matchAll(/references\/([a-z0-9-]+\.md)/g)].map((m) => m[1] ?? ""),
    );
    const uris = r.messages
      .filter((m) => m.content.type === "resource")
      .map((m) => (m.content as { resource: { uri: string } }).resource.uri);
    for (const file of linked) {
      if (file === "tool-outputs.md") {
        expect(uris, `${name}: ${file}`).toContain("espn-ff://docs/tool-outputs");
        continue;
      }
      const inlined = text.includes(`BEGIN GENERATED FROM _shared/references/${file}`);
      const carried = text.includes(`### references/${file}\n\n`);
      expect(inlined || carried, `${name}: references/${file}`).toBe(true);
      expect(text, `${name}: ${file}`).not.toContain(`### references/${file}\n\n(not installed`);
    }
  });

  it("espn.onboard carries the exact onboarding log entry and orient's routing", async () => {
    const text = textOf(await client.getPrompt({ name: "espn.onboard" }));
    expect(text).toContain("### references/onboard-log-entry.md");
    expect(text).toContain("golden_mismatch_share");
    expect(text).toContain("### references/orient.md");
    for (const k of ["allow_stale", "host_moved", "tool_contract", "ir_invalid"])
      expect(text, k).toContain(k);
  });

  it("espn.weekly carries orient's Step 0 and routing (it never did before)", async () => {
    const text = textOf(await client.getPrompt({ name: "espn.weekly" }));
    const orient = readFileSync(
      path.join(ROOT, "skills", "weekly", "references", "orient.md"),
      "utf8",
    );
    expect(text).toContain(orient.trim().slice(0, 300));
  });
});

describe("linkedReferences / promptText", () => {
  it("skips the inlined blocks and tool-outputs; keeps the order of first link", () => {
    const body =
      "See [o](references/orient.md) and references/log.md, again references/orient.md; " +
      "fields in references/tool-outputs.md.\n<!-- BEGIN GENERATED FROM _shared/references/guardrails.md -->\n" +
      "references/guardrails.md";
    expect(linkedReferences(body)).toEqual(["orient.md", "log.md"]);
  });

  it("a reference the installation lacks is named as missing, never guessed", () => {
    const t: ServerTexts = {
      skills: { x: "Step 0 in references/orient.md." },
      tool_outputs: null,
      references: { x: { "orient.md": null } },
    };
    expect(promptText(t, "x", {})).toContain(
      "### references/orient.md\n\n(not installed with this server",
    );
    expect(promptText({ skills: t.skills, tool_outputs: null }, "x", {})).toContain(
      "(not installed",
    );
  });

  it("a missing Skill body carries no references section", () => {
    const t: ServerTexts = { skills: {}, tool_outputs: null, references: {} };
    expect(promptText(t, "nope", {})).not.toContain("## References");
  });
});
