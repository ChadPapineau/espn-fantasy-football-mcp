// waiver-verdicts.test.ts — every Skill that renders espn_analyze_waivers' verdicts knows all of them
// and times each as the tool means it (Stage C finding skills-fa-add-now-undocumented; plan 07 E5's
// five verdicts; plan 09 §3.2, §3.4, §3.8, §3.10). E5 gives `fa_add_now` to every FREEAGENT candidate
// with s > 0 (src/domain/analytics/waivers.ts) — after the waiver run every candidate, and in a real
// league most K and D/ST streamers on any day — yet no Skill or shared reference named it, and
// stream-kdef's "How to act" mapped every free-agent add to "after `next_run_at`": after the run that
// is the FOLLOWING run, a day or more away, while a rival can add the player now (research 05 §1.5:
// the post-run scramble is the larger market). The verdict set is read from the registry's own output
// schema, so a verdict the tool gains fails here until the Skills say what to do with it; the timing
// is held clause by clause where a Skill tells the user how to act. No network, no cookie.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { z } from "zod/v4";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REGISTRY } from "../../src/mcp/registry.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "../mcp/helpers/world.js";
import { ROOT, SKILLS } from "./helpers.js";

const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");
/** A SKILL.md without its frontmatter and without the generated blocks (the Skill's own text). */
function ownBody(skill: string): string {
  const text = read(`skills/${skill}/SKILL.md`);
  const body = text.slice(text.indexOf("\n---\n", 4) + 5);
  return body.replace(/<!-- BEGIN GENERATED[\s\S]*?<!-- END GENERATED[^\n]*\n?/g, "");
}

/** The string enum values of one property schema (a nullable enum is an `anyOf`). */
function enumValues(schema: unknown): string[] {
  const out: string[] = [];
  const go = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(go);
      return;
    }
    if (typeof v !== "object" || v === null) return;
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.enum)) for (const e of o.enum) if (typeof e === "string") out.push(e);
    for (const k of ["anyOf", "oneOf", "allOf"]) if (k in o) go(o[k]);
  };
  go(schema);
  return out;
}

/** Every value of every `verdict` property's enum in a tool's output schema (JSON Schema walk). */
function verdictsOf(tool: string): string[] {
  const def = REGISTRY.find((e) => e.name === tool)?.tool;
  if (def === undefined || def === null) throw new Error(`${tool} is not built`);
  const schema = z.toJSONSchema(def.data, { unrepresentable: "any", io: "output" });
  const out = new Set<string>();
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (typeof v !== "object" || v === null) return;
    const o = v as Record<string, unknown>;
    if (typeof o.properties === "object" && o.properties !== null)
      for (const [name, s] of Object.entries(o.properties as Record<string, unknown>)) {
        if (name === "verdict") for (const e of enumValues(s)) out.add(e);
        visit(s);
      }
    for (const k of ["items", "anyOf", "oneOf", "allOf", "prefixItems", "additionalProperties"])
      if (k in o) visit(o[k]);
    if (typeof o.$defs === "object" && o.$defs !== null) visit(Object.values(o.$defs));
  };
  visit(schema);
  return [...out].sort();
}

const VERDICTS = verdictsOf("espn_analyze_waivers");
/** The two verdicts that are no claim: a free-agent add now, or after the run. */
const FREE_AGENT_VERDICTS = ["fa_add_after_run", "fa_add_now"];

/**
 * The clauses of one line, split at its backticked verdicts: each verdict with the text up to the
 * next verdict — the words a Skill gives for acting on that verdict.
 */
function clausesOf(line: string): Map<string, string> {
  const re = new RegExp(`\`(${VERDICTS.join("|")})\``, "g");
  const hits = [...line.matchAll(re)];
  const out = new Map<string, string>();
  hits.forEach((m, i) => {
    const end = hits[i + 1]?.index ?? line.length;
    const v = m[1] ?? "";
    out.set(v, `${out.get(v) ?? ""}${line.slice(m.index, end)}`);
  });
  return out;
}
/** The one line of `text` that holds `marker`. */
function lineWith(text: string, marker: string): string {
  const lines = text.split("\n").filter((l) => l.includes(marker));
  if (lines.length !== 1)
    throw new Error(`expected one line with "${marker}", got ${String(lines.length)}`);
  return lines[0] ?? "";
}
/** An add now: "now" and first come, first served — and no waiver time at all. */
function expectAddNow(clause: string | undefined, where: string): void {
  expect(clause, `${where}: no fa_add_now clause`).toBeDefined();
  expect(clause, where).toMatch(/\bnow\b/);
  expect(clause, where).toMatch(/first come, first served/);
  expect(clause, `${where}: an add now is never timed by the run`).not.toMatch(
    /next_run_at|next_execution/,
  );
}
/** An add after the run: once the run clears, after `next_run_at`. */
function expectAddAfterRun(clause: string | undefined, where: string): void {
  expect(clause, `${where}: no fa_add_after_run clause`).toBeDefined();
  expect(clause, where).toMatch(/once the run clears|after the (waiver )?run/);
}

describe("E5's verdicts in the Skills (Stage C finding skills-fa-add-now-undocumented)", () => {
  it("the tool's own verdict set is read from its output schema, fa_add_now among them", () => {
    expect(VERDICTS).toEqual(
      expect.arrayContaining(["claim", "pass", "marginal", "fa_add_now", "fa_add_after_run"]),
    );
    // E7 prices the cascade's beneficiaries with E5, so its verdicts are E5's
    for (const v of verdictsOf("espn_analyze_injury_cascade")) expect(VERDICTS).toContain(v);
  });

  it("priority-waivers.md defines every verdict in one table, with how to act and when", () => {
    const ref = read("skills/_shared/references/priority-waivers.md");
    const at = ref.indexOf("### The five verdicts");
    expect(at, "the verdicts section").toBeGreaterThan(-1);
    const section = ref.slice(at);
    // the table's body rows: after its header and separator
    const body = section.slice(section.indexOf("|---|"));
    const rows = new Map(
      [...body.matchAll(/^\| `([a-z_]+)` \|([^\n]*)$/gm)].map((m) => [m[1] ?? "", m[2] ?? ""]),
    );
    expect([...rows.keys()].sort()).toEqual(VERDICTS);
    expectAddNow(rows.get("fa_add_now"), "priority-waivers fa_add_now row");
    expect(rows.get("fa_add_now")).toMatch(/already a free agent/);
    expect(rows.get("fa_add_now")).toMatch(/no claim/);
    expectAddAfterRun(rows.get("fa_add_after_run"), "priority-waivers fa_add_after_run row");
    expect(rows.get("fa_add_after_run")).toMatch(/after `next_run_at`/);
    expect(rows.get("claim")).toMatch(/claim list for the run at `next_run_at`/);
    expect(rows.get("marginal")).toMatch(/the user's call/);
    // and why the run never times an add now: after the run it is the following run
    expect(section).toMatch(
      /never a `fa_add_now`: after the run \(`phase: post_run`\) it is the \*following\* run/,
    );
    // the scramble brief's free agents are the add-now verdict
    expect(lineWith(ref, "**the scramble brief**")).toContain("`fa_add_now`");
  });

  it("every Skill that calls espn_analyze_waivers names both free-agent verdicts and links the table", () => {
    const callers = SKILLS.filter((s) => ownBody(s).includes("espn_analyze_waivers"));
    expect(callers.sort()).toEqual(["injury-cascade", "stream-kdef", "waivers", "weekly"]);
    for (const s of callers) {
      const body = ownBody(s);
      for (const v of FREE_AGENT_VERDICTS) expect(body, `${s}: ${v}`).toContain(`\`${v}\``);
      expect(body, `${s}: links the verdict table`).toContain(
        "[priority waivers](references/priority-waivers.md)",
      );
    }
  });

  it("no Skill text names one free-agent verdict without the other", () => {
    const sources = [
      ...SKILLS.map((s) => `skills/${s}/SKILL.md`),
      "skills/_shared/references/priority-waivers.md",
      "skills/_shared/references/tool-outputs.md",
      "skills/injury-cascade/references/injury-cascade-roles.md",
    ];
    for (const f of sources) {
      const text = read(f);
      const named = FREE_AGENT_VERDICTS.filter((v) => text.includes(`\`${v}\``));
      expect(named.length === 0 || named.length === 2, `${f} names only ${named.join(", ")}`).toBe(
        true,
      );
    }
    // the cheat-sheet lists every verdict on the tool's row
    const row = lineWith(
      read("skills/_shared/references/tool-outputs.md"),
      "| `espn_analyze_waivers` |",
    );
    for (const v of VERDICTS) expect(row, v).toContain(`\`${v}\``);
  });

  it("stream-kdef's How to act: an add now for fa_add_now, after next_run_at only for fa_add_after_run", () => {
    const body = ownBody("stream-kdef");
    const line = lineWith(body, "- How to act");
    const c = clausesOf(line);
    expectAddNow(c.get("fa_add_now"), "stream-kdef fa_add_now");
    expectAddAfterRun(c.get("fa_add_after_run"), "stream-kdef fa_add_after_run");
    expect(c.get("fa_add_after_run")).toMatch(/after `next_run_at`/);
    expect(c.get("claim"), "a claim only when s ≥ Π").toMatch(/s ≥ Π/);
    // after the run, next_run_at is the following run: never a reason to wait
    expect(line).toMatch(
      /After the run \(`phase: post_run`\) `next_run_at` is the \*following\* run/,
    );
    // the opening says both ways a streamer is added
    const intro = lineWith(body, "Never more than two weeks out.");
    expect(intro).toContain("`fa_add_now`");
    expect(intro).toContain("`fa_add_after_run`");
    expect(intro).not.toMatch(/almost always a \*\*free-agent add after the waiver run\*\*/);
  });

  it("weekly's K and D/ST step and its waiver briefs time each free-agent verdict the same way", () => {
    const body = ownBody("weekly");
    const kdst = clausesOf(lineWith(body, "one position per call"));
    expectAddNow(kdst.get("fa_add_now"), "weekly K/D-ST fa_add_now");
    expectAddAfterRun(kdst.get("fa_add_after_run"), "weekly K/D-ST fa_add_after_run");
    expect(kdst.get("fa_add_after_run")).toMatch(/after `next_run_at`/);
    const pre = clausesOf(lineWith(body, "- **Before the run**"));
    expect(pre.get("fa_add_now")).toMatch(/add him now/);
    const post = lineWith(body, "- **After the run**");
    expect(post).toContain("`fa_add_now`");
    expect(post).toMatch(/never times a `fa_add_now`/);
  });

  it("waivers and injury-cascade list every verdict where they render them", () => {
    const waivers = lineWith(ownBody("waivers"), "- Per candidate:");
    const w = clausesOf(waivers);
    expectAddNow(w.get("fa_add_now"), "waivers fa_add_now");
    expectAddAfterRun(w.get("fa_add_after_run"), "waivers fa_add_after_run");
    for (const v of VERDICTS)
      expect(waivers, `waivers lists ${v}`).toMatch(new RegExp(`\`${v}\`|\\*\\*${v}\\*\\*`));
    const cascade = lineWith(
      ownBody("injury-cascade"),
      "and `candidates` = the available beneficiaries",
    );
    const ic = clausesOf(cascade);
    expect(ic.get("fa_add_now"), "injury-cascade fa_add_now").toMatch(/add him now/);
    expectAddAfterRun(ic.get("fa_add_after_run"), "injury-cascade fa_add_after_run");
  });
});

describe("fx-10h/post-run: the case the Skills now time right (core, fixture mode)", () => {
  // the finding's repro on the real tool: just after the run every unclaimed kicker is a free agent,
  // E5 calls the streamer fa_add_now, and next_run_at is the FOLLOWING run — the time the old
  // "after `next_run_at`" wording told the user to wait for
  const DIR = path.join(ESPN_FIXTURES, "fx-10h", "post-run");
  const manifest = JSON.parse(readFileSync(path.join(DIR, "manifest.json"), "utf8")) as {
    clock: string;
    my_team_id: number;
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

  it("a K stream after the run: verdict fa_add_now, an add now, and next_run_at a day or more away", async () => {
    const r = await call(client, "espn_analyze_waivers", { positions: ["K"], look_ahead: 2 });
    expect(r.isError, JSON.stringify(r.body).slice(0, 400)).toBe(false);
    const d = r.body.data as {
      phase: string;
      next_run_at: string | null;
      candidates: { status: string; s: number; verdict: string }[];
      rec: { action: string };
    };
    expect(d.phase).toBe("post_run");
    const now = d.candidates.filter((c) => c.verdict === "fa_add_now");
    expect(now.length, "a free-agent streamer to add now").toBeGreaterThan(0);
    // fa_add_now is exactly a free agent with a positive surplus (waivers.ts), never a claim
    for (const c of now) expect(c).toMatchObject({ status: "FREEAGENT" });
    for (const c of now) expect(c.s).toBeGreaterThan(0);
    expect(d.rec.action).toMatch(/\bnow\b/);
    // after the run, next_run_at is the next run: waiting for it would hand a rival the kicker
    expect(d.next_run_at).not.toBeNull();
    const ahead = Date.parse(d.next_run_at ?? "") - Date.parse(manifest.clock);
    expect(ahead).toBeGreaterThanOrEqual(12 * 3_600_000);
    // and every Skill that renders this verdict says "now", never "after `next_run_at`"
    expect(VERDICTS).toContain("fa_add_now");
  }, 120_000);
});
