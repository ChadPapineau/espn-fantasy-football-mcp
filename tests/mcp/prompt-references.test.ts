// prompt-references.test.ts — a prompt carries what its Skill body links (plan 09 §6: the
// espn.<workflow> prompts are the Skill delivery path for clients without a Skill loader, and §4:
// the two paths cannot drift). Stage C finding `prompts-skill-references-unreachable`: promptText
// sent SKILL.md alone, so a prompt-only client met 5–7 links to files it cannot open — orient's Step
// 0 and routing table (credential rejected → stop, host_moved → allow_stale, tool_contract,
// ir_invalid first) and onboard's exact log entry (whose fields the server requires). The prompt now
// appends every linked reference under a `### references/<file>` heading its link resolves to
// (except the blocks the body already inlines), embeds references/tool-outputs.md as the
// espn-ff://docs/tool-outputs resource, and names a file the installation lacks as missing.
// Attempt 2: the references a carried reference links are carried too (the closure — a carried
// file's own link was otherwise left for the client to open), and the texts reach the server
// through ONE loader contract, `referenceTextsFor(skills, read)`: the composition root's call with
// its bounded package read of skills/<skill>/references/<file> — exercised here with that exact
// read over this package, so every link in all 13 prompts is shown to resolve once it is wired.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServerTexts } from "../../src/mcp/services.js";
import {
  ALL_PROMPTS,
  REFERENCE_FILE_RE,
  TOOL_OUTPUTS_URI,
  carriedReferences,
  linkedReferences,
  linksToolOutputs,
  promptText,
  referenceTextsFor,
} from "../../src/mcp/prompts/index.js";
import { ROOT, connect, makeWorld, type World } from "./helpers/world.js";

/** The composition root's read: skills/<skill>/references/<file> of this package, or null. */
function packageRead(skill: string, file: string): string | null {
  try {
    return readFileSync(path.join(ROOT, "skills", skill, "references", file), "utf8");
  } catch {
    return null;
  }
}

let world: World;
let client: Client;
let close: () => Promise<void>;
let texts: ServerTexts;
beforeAll(async () => {
  world = await makeWorld({ publishEspn: false });
  texts = {
    ...world.options.texts,
    references: referenceTextsFor(world.options.texts.skills, packageRead),
  };
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

describe("every prompt resolves every reference its text links (plan 09 §4, §6)", () => {
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

describe("referenceTextsFor — the composition root's loader contract", () => {
  it("over this package: every file a prompt carries is read, exactly once, nothing else", () => {
    const calls: string[] = [];
    const refs = referenceTextsFor(texts.skills, (skill, file) => {
      calls.push(`${skill}/${file}`);
      return packageRead(skill, file);
    });
    expect(new Set(calls).size).toBe(calls.length);
    for (const p of ALL_PROMPTS) {
      const body = texts.skills[p.skill];
      if (typeof body !== "string") throw new Error(`no body for ${p.skill}`);
      const files = carriedReferences(body, (f) => refs[p.skill]?.[f]);
      expect(Object.keys(refs[p.skill] ?? {}).sort(), p.skill).toEqual([...files].sort());
      for (const f of files)
        expect(refs[p.skill]?.[f], `${p.skill}/${f}`).toEqual(expect.any(String));
    }
    for (const c of calls) expect(REFERENCE_FILE_RE.test(c.split("/")[1] ?? ""), c).toBe(true);
  });

  it("a read that throws or returns nothing is null — the prompt names it missing", () => {
    const skills = { a: "Step 0 in references/orient.md and references/log.md." };
    const refs = referenceTextsFor(skills, (_skill, file) => {
      if (file === "orient.md") throw new Error("EACCES");
      return "   ";
    });
    expect(refs).toEqual({ a: { "orient.md": null, "log.md": null } });
    const t = promptText({ skills, tool_outputs: null, references: refs }, "a", {});
    expect(t).toContain("### references/orient.md\n\n(not installed");
    expect(t).toContain("### references/log.md\n\n(not installed");
  });

  it("reads only one-component names under a Skill directory name, never a path", () => {
    const seen: string[] = [];
    const refs = referenceTextsFor(
      {
        ok: "see references/../secret.md, references/sub/x.md, references/X.md, references/a.md",
        "../up": "references/orient.md",
        Bad: "references/orient.md",
        none: null,
      },
      (skill, file) => {
        seen.push(`${skill}|${file}`);
        return "text";
      },
    );
    expect(seen).toEqual(["ok|a.md"]);
    expect(refs).toEqual({ ok: { "a.md": "text" } });
  });
});

describe("carriedReferences / linkedReferences / promptText", () => {
  it("skips the inlined blocks and tool-outputs; keeps the order of first link", () => {
    const body =
      "See [o](references/orient.md) and references/log.md, again references/orient.md; " +
      "fields in references/tool-outputs.md.\n<!-- BEGIN GENERATED FROM _shared/references/guardrails.md -->\n" +
      "references/guardrails.md";
    expect(linkedReferences(body)).toEqual(["orient.md", "log.md"]);
  });

  it("carries the references a carried reference links, transitively, each once", () => {
    // body → a.md → b.md → c.md (and back to a.md); b.md also links the cheat-sheet and the
    // guardrails the body inlines: the prompt carries a, b, c, embeds the cheat-sheet, and never
    // re-carries an inlined block
    const skills = {
      x:
        "Start with references/a.md.\n<!-- BEGIN GENERATED FROM _shared/references/guardrails.md -->\n" +
        "guardrails inline\n<!-- END GENERATED FROM _shared/references/guardrails.md -->",
    };
    const files: Record<string, string> = {
      "a.md": "A: then references/b.md",
      "b.md":
        "B: fields in references/tool-outputs.md, rules in references/guardrails.md, then references/c.md",
      "c.md": "C: back to references/a.md",
    };
    const refs = referenceTextsFor(skills, (_s, f) => files[f] ?? null);
    expect(refs).toEqual({ x: files });
    const t: ServerTexts = { skills, tool_outputs: null, references: refs };
    expect(carriedReferences(skills.x, (f) => refs.x?.[f])).toEqual(["a.md", "b.md", "c.md"]);
    const text = promptText(t, "x", {});
    for (const [f, body] of Object.entries(files))
      expect(text, f).toContain(`### references/${f}\n\n${body}`);
    expect(text).not.toContain("### references/guardrails.md");
    expect(text).toContain(`Embedded below as the ${TOOL_OUTPUTS_URI} resource.`);
    expect(linksToolOutputs(t, "x", skills.x)).toBe(true);
    expect(linksToolOutputs({ ...t, references: {} }, "x", skills.x)).toBe(false);
  });

  it("the prompt embeds the cheat-sheet a carried reference links (the body does not)", async () => {
    const skills = { ...texts.skills, onboard: "Step 0 is in references/orient.md." };
    const references = { onboard: { "orient.md": "Fields: references/tool-outputs.md." } };
    const c = await connect(world, {
      options: { texts: { skills, tool_outputs: texts.tool_outputs, references } },
    });
    const r = await c.client.getPrompt({ name: "espn.onboard" });
    await c.close();
    const uris = r.messages
      .filter((m) => m.content.type === "resource")
      .map((m) => (m.content as { resource: { uri: string } }).resource.uri);
    expect(uris).toContain(TOOL_OUTPUTS_URI);
    expect(textOf(r)).toContain("### references/orient.md\n\nFields: references/tool-outputs.md.");
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
