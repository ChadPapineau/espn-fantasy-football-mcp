// gen-tool-docs.ts — the tool documentation held to the registry (plan 04 §6: "The tool reference ←
// tools/list in fixture mode (scripts/gen-tool-docs.ts); docs-writer owns the prose around it";
// plan 09 §2, §4: the Skills read the per-tool field lists of the cheat-sheet; Stage C finding
// docs-current-check-missing). From src/mcp/registry.ts — the definitions `tools/list` is built
// from (name, toolset, family, description, output schema):
// - README.md region `tools`: every registered read tool, generated (catalog id, name, toolset,
//   annotation family, description);
// - README.md's hand-written catalog tables: a row's Status is ✅ exactly when its tool is
//   registered (the declared, unbuilt write tools of PHASE W stay 📋);
// - skills/_shared/references/tool-outputs.md (served as espn-ff://docs/tool-outputs, copied into
//   every Skill by build-skills): every field name its "fields a Skill reads" column puts in
//   backticks must exist in that tool's output schema (a property name, or one of its enum values),
//   so a renamed or removed field fails here before a Skill reads a field that is gone; every
//   registered tool has a row.
//
// Usage:  npx tsx scripts/gen-tool-docs.ts [--check | --write] [--root <dir>]
// Exit: 0 current · 1 not current (or a problem) · 2 usage.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod/v4";
import { UNTRUSTED_SOURCES } from "../src/domain/league/types.js";
import { ATTRIBUTION_KEY_RE, ATTRIBUTION_LAYERS } from "../src/domain/reclog/attribution.js";
import { REGISTRY } from "../src/mcp/registry.js";
import type { AnyToolDefinition } from "../src/mcp/define.js";
import { cell, cli, withRegion, type DocTarget } from "./docs/regions.js";

/** The built read tools in registry order, with their catalog id and toolset. */
export function builtTools(): { id: string; tool: AnyToolDefinition; toolset: "core" | "full" }[] {
  return REGISTRY.flatMap((e) =>
    e.tool === null
      ? []
      : [
          {
            id: e.id,
            tool: e.tool,
            toolset: e.priority === "P0" ? ("core" as const) : ("full" as const),
          },
        ],
  );
}

/** README region `tools`. */
export function toolsTable(): string {
  const rows = builtTools().map(
    ({ id, tool, toolset }) =>
      `| ${id} | \`${tool.name}\` | ${toolset === "core" ? "core · full" : "full"} | ${tool.family} | ${cell(tool.description)} |`,
  );
  return ["| Id | Tool | Toolset | Family | Description |", "|---|---|---|---|---|", ...rows].join(
    "\n",
  );
}

/**
 * README catalog rows whose Status contradicts the registry: a row whose first cell starts with a
 * tool name (`| \`espn_…\` … | … | <status> |`) of a hand-written table must end in ✅ exactly
 * when the tool is registered, and every registered tool has such a row.
 */
export function statusProblems(readme: string): string[] {
  const built = new Set(builtTools().map((t) => t.tool.name));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of readme.split("\n")) {
    // the first cell names the tool first: `espn_x`, `espn_x` ★, `espn_x` tool · …, `espn_x` / `espn_y`
    const m = /^\| `(espn_[a-z_]+)`[^|]*\|.*\| ([^|]*) \|$/.exec(line);
    if (m === null) continue;
    const name = m[1] ?? "";
    const status = (m[2] ?? "").trim();
    if (!/[✅📋🚧]/u.test(status)) continue; // not a catalog row (another table naming a tool)
    seen.add(name);
    const want = built.has(name) ? "✅" : "📋";
    if (!status.includes(want))
      out.push(
        `${name}: Status ${status}, but the tool is ${built.has(name) ? "registered (✅)" : "not built (📋)"}`,
      );
  }
  for (const name of built)
    if (!seen.has(name)) out.push(`${name}: registered but no catalog row names it`);
  return out;
}

type Json = Record<string, unknown>;

/** Every property name and string enum value anywhere in a JSON Schema. */
export function vocabularyOf(schema: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    for (const s of schema) vocabularyOf(s, into);
    return into;
  }
  if (typeof schema !== "object" || schema === null) return into;
  const s = schema as Json;
  if (typeof s.properties === "object" && s.properties !== null)
    for (const [k, v] of Object.entries(s.properties as Json)) {
      into.add(k);
      vocabularyOf(v, into);
    }
  for (const key of [
    "items",
    "additionalProperties",
    "anyOf",
    "oneOf",
    "allOf",
    "prefixItems",
    "not",
  ])
    if (key in s) vocabularyOf(s[key], into);
  if (Array.isArray(s.enum)) for (const v of s.enum) if (typeof v === "string") into.add(v);
  if (typeof s.const === "string") into.add(s.const);
  if (typeof s.$defs === "object" && s.$defs !== null)
    vocabularyOf(Object.values(s.$defs as Json), into);
  return into;
}

/** A tool's output-schema vocabulary (property names and enum values of its `data`). */
export function toolVocabulary(tool: AnyToolDefinition): Set<string> {
  return vocabularyOf(z.toJSONSchema(tool.data, { unrepresentable: "any", io: "output" }));
}

/** The envelope's own names (plan 01 §4.2) — a field list may name them beside the data's. */
const ENVELOPE = new Set([
  "data",
  "meta",
  "page",
  "truncated",
  "partial",
  "warnings",
  "total",
  "offset",
  "limit",
  "next_offset",
  "provisional",
  "corrections_window_open",
  "estimate",
  "as_of",
  "age_s",
  "freshness",
  "source",
  "attribution",
  "untrusted_fields",
  "request_id",
  "drift",
  "schema_version",
  "fetched_at",
]);

/**
 * Names a field list may use beside the output schema's: the toolsets, and E13's attribution map —
 * its keys are server-composed (ATTRIBUTION_KEY_RE), so the schema is a record and the cheat-sheet
 * names the key grammar's words (the layers, the call fields, a call index `i`).
 */
const KNOWN_WORDS = new Set<string>([
  "core",
  "full",
  ...ATTRIBUTION_LAYERS,
  "n_player_weeks",
  "projection_backed",
  "complete",
  "unbacked",
  "i",
]);

/** A backticked token that reads as a field path: `a`, `a.b`, `a[]`, `a.*`, `a.b[].c`. */
const FIELD_PATH_RE = /^[a-z_][a-z0-9_]*(?:\[\])?(?:\.(?:[a-z_][a-z0-9_]*|\*)(?:\[\])?)*$/;

/**
 * The cheat-sheet's field names that the tool's output schema does not have, per row of its tool
 * tables, and the registered tools without a row.
 */
export function cheatSheetProblems(sheet: string): string[] {
  const byName = new Map(builtTools().map((t) => [t.tool.name, t.tool]));
  const out: string[] = [];
  const rows = new Set<string>();
  for (const line of sheet.split("\n")) {
    const m = /^\| (?:\(P1\) )?`(espn_[a-z_]+)` \|/.exec(line);
    if (m === null) continue;
    const name = m[1] ?? "";
    const tool = byName.get(name);
    if (tool === undefined) {
      out.push(`${name}: a row for a tool the registry does not build`);
      continue;
    }
    rows.add(name);
    const cols = line.split(/(?<!\\)\|/).map((c) => c.trim());
    const fields = cols[3] ?? "";
    const vocab = toolVocabulary(tool);
    for (const t of fields.matchAll(/`([^`]+)`/g)) {
      const token = t[1] ?? "";
      if (!FIELD_PATH_RE.test(token)) continue;
      // a provenance tag (meta.untrusted_fields `source`) or an attribution key is not a path
      if (
        (UNTRUSTED_SOURCES as readonly string[]).includes(token) ||
        ATTRIBUTION_KEY_RE.test(token)
      )
        continue;
      for (const part of token.split(".")) {
        const n = part.replace(/\[\]$/, "");
        if (n === "*" || ENVELOPE.has(n) || KNOWN_WORDS.has(n) || vocab.has(n)) continue;
        out.push(`${name}: \`${token}\` — the output schema has no field or value "${n}"`);
      }
    }
  }
  for (const name of byName.keys())
    if (!rows.has(name)) out.push(`${name}: registered, but the cheat-sheet has no row for it`);
  return out;
}

export const TARGETS: readonly DocTarget[] = [
  {
    file: "README.md",
    build: (current) => {
      const text = withRegion(current, "tools", toolsTable());
      return { text, problems: statusProblems(text) };
    },
  },
  {
    file: "skills/_shared/references/tool-outputs.md",
    build: (current) => ({ text: current, problems: cheatSheetProblems(current) }),
  },
];

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  process.exitCode = cli("gen-tool-docs", TARGETS, process.argv.slice(2));
