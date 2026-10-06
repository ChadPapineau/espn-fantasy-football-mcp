// define.ts — the one registration helper (plan 01 §4: `defineTool()` forces annotations by family
// §4.1, an in-code zod outputSchema around the §4.2 envelope, `.strict()` input, the §4.3 coded
// errors through deferred validation + wrapHandler, the 40-char untrusted-text pointer ending every
// description; plan 07 C3/C10/§5.1: definitions are paid every turn, so the advertised schemas are
// compacted and the WIRE output schema is an outline or omitted while the full zod contract
// validates every result in code), plus the per-call budget (plan 01 §5.6) and the result step
// (budget halving, rounding, validation, structuredContent iff a schema is on the wire — T-06).
// Ported from sibling @5daa625 (src/mcp/define.ts), adapted (families from envelope.ts, the
// upstream budget, wire modes).
import type {
  McpServer,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { createUpstreamBudget, type UpstreamBudget } from "../providers/platform.js";
import {
  ANALYTICS_BUDGET_CHARS,
  RESULT_BUDGET_CHARS,
  TOOL_FAMILY_OF,
  TRUNCATION_HINTS,
  UNTRUSTED_POINTER,
  bareFieldsFromSchema,
  buildEnvelope,
  envelopeSchema,
  fitToBudget,
  isUntrustedText,
  serializeEnvelope,
  toolAnnotations,
  validatedToolResult,
  type BudgetTrim,
  type InputStamp,
  type PageInfo,
  type ToolFamily,
  type ToolSuccessResult,
  type UntrustedField,
} from "./envelope.js";
import { EffError, describeForLog, wrapHandler, type HandlerContext } from "./errors.js";
import type { McpLogger, McpServerOptions, McpServices } from "./services.js";

/** The tool-name grammar (plan 01 §4.1): `espn_<verb>_<resource>`, ≤ 40 characters. */
export const TOOL_NAME_GRAMMAR = /^espn_[a-z][a-z0-9_]{1,34}$/;

/**
 * How a tool's output schema appears in `tools/list` (plan 07 C10; plan 01 §4): `outline` — the
 * envelope with `data`'s top-level field names (a superset of the zod contract; structuredContent
 * is sent and the SDK validates it with the FULL zod schema); `none` — no outputSchema on the wire
 * (`wireOutputSchema: false`; text block only, validated in code). The zod schema always stays in code.
 */
export type WireOutputMode = "outline" | "none";

/** What a tool implementation hands back: the envelope's inputs, not the envelope itself. */
export interface ToolOutput<D> {
  readonly data: D;
  /** Contributing inputs (platform + dataset stamps), converted with stampToInput. */
  readonly inputs: readonly InputStamp[];
  readonly extraSources?: readonly string[];
  readonly provisional?: boolean;
  readonly correctionsWindowOpen?: boolean;
  readonly estimate?: boolean;
  /** Path-listed bare text beyond what the data schema marks (rarely needed). */
  readonly bareFields?: readonly UntrustedField[];
  readonly page?: PageInfo;
  readonly partial?: boolean;
  readonly warnings?: readonly string[];
  /** The array under `data` the budget may halve (list tools, analytics candidate lists). */
  readonly listKey?: string;
  /** Tool-specific budget steps tried before `listKey` is halved. */
  readonly trims?: readonly BudgetTrim[];
  /** The week the result is about (remembered for E12's source_calls check). */
  readonly week?: number;
}

/** What this server remembers of one successful call. */
export interface CallRecord {
  readonly tool: string;
  readonly week: number | null;
}

/** How many recent calls one server remembers (oldest forgotten first). */
export const CALL_LEDGER_MAX = 1024;

const LEDGERS = new WeakMap<McpServices, Map<string, CallRecord>>();

function rememberCall(services: McpServices, requestId: string, rec: CallRecord): void {
  let ledger = LEDGERS.get(services);
  if (ledger === undefined) {
    ledger = new Map();
    LEDGERS.set(services, ledger);
  }
  ledger.set(requestId, rec);
  while (ledger.size > CALL_LEDGER_MAX) {
    const oldest = ledger.keys().next();
    if (oldest.done === true) break;
    ledger.delete(oldest.value);
  }
}

/** The successful call this server answered under `requestId`, or null (unknown or forgotten). */
export function recentCall(services: McpServices, requestId: string): CallRecord | null {
  return LEDGERS.get(services)?.get(requestId) ?? null;
}

/** Per-call context a tool implementation receives. */
export interface ToolContext extends HandlerContext {
  /** The call's instant, read once from the injected Clock. */
  readonly nowMs: number;
  readonly services: McpServices;
  readonly options: McpServerOptions;
  readonly log: McpLogger;
  /** Per-call memo (league, settings, schedule …) so one call never reads a port twice. */
  readonly memo: Map<string, unknown>;
  /** This call's ESPN budget: ≤ 3 new requests, ≤ 20 s (plan 01 §5.6, §6). */
  readonly budget: UpstreamBudget;
}

/** One tool's definition. */
export interface ToolDefinition<S extends z.ZodType, D> {
  readonly name: string;
  /** The static description (no dynamic text — plan 07 §5.4); the pointer is appended here. */
  readonly description: string;
  readonly input: S;
  /** The `data` schema — the in-code outputSchema (always present; plan 01 §4). */
  readonly data: z.ZodType;
  /** Which budget applies (plan 01 §4.2 20 000 chars; plan 07 C8 10 000 for analytics). */
  readonly budget: "list" | "analytics";
  /** Whether the list under `listKey` pages with offset (list tools) or is only halved. */
  readonly pageable?: boolean;
  /** The truncation warning's fixed advice. */
  readonly hint?: string;
  /** The output schema's wire form (default `outline`). */
  readonly wire?: WireOutputMode;
  /**
   * Top-level arguments advertised as opaque objects/arrays with a pointer to where the value comes
   * from (plan 07 §5.1: definitions are paid every turn). The full strict zod schema still validates
   * every call — an invalid value is a coded VALIDATION naming the field.
   */
  readonly opaqueInput?: Readonly<Record<string, string>>;
  readonly run: (args: z.output<S>, ctx: ToolContext) => Promise<ToolOutput<D>>;
}

/** A definition with its generics erased (the registry's element type). */
export interface AnyToolDefinition {
  readonly name: string;
  readonly family: ToolFamily;
  readonly description: string;
  readonly input: z.ZodType;
  readonly data: z.ZodType;
  readonly budget: "list" | "analytics";
  readonly pageable?: boolean;
  readonly hint?: string;
  readonly wire: WireOutputMode;
  readonly opaqueInput?: Readonly<Record<string, string>>;
  /** The bare-text paths the data schema marks (derived once at definition time). */
  readonly bareFields: readonly UntrustedField[];
  readonly run: (args: never, ctx: ToolContext) => Promise<ToolOutput<unknown>>;
}

/**
 * Validates a definition and erases its generics: the name grammar, a family in the plan 01 §4.1
 * table, a `.strict()` object input, a description that carries no mandatory sentence. The marked
 * bare-text paths of the data schema are derived here, so a forgotten path cannot happen.
 */
export function defineTool<S extends z.ZodType, D>(def: ToolDefinition<S, D>): AnyToolDefinition {
  if (!TOOL_NAME_GRAMMAR.test(def.name)) throw new RangeError("define: invalid tool name");
  const entry = Object.prototype.hasOwnProperty.call(TOOL_FAMILY_OF, def.name)
    ? TOOL_FAMILY_OF[def.name]
    : undefined;
  if (entry === undefined) throw new RangeError("define: tool has no family (plan 01 §4.1)");
  const inputDef = (def.input as unknown as { _zod: { def: { type: string; catchall?: unknown } } })
    ._zod.def;
  if (inputDef.type !== "object")
    throw new RangeError("define: tool input must be a strict object");
  return {
    name: def.name,
    family: entry.family,
    description: def.description,
    input: def.input,
    data: def.data,
    budget: def.budget,
    ...(def.pageable === undefined ? {} : { pageable: def.pageable }),
    ...(def.hint === undefined ? {} : { hint: def.hint }),
    wire: def.wire ?? "outline",
    ...(def.opaqueInput === undefined ? {} : { opaqueInput: def.opaqueInput }),
    bareFields: bareFieldsFromSchema(def.data),
    run: def.run,
  };
}

/** The description as registered: static text + one space + the pointer (always last). */
export function fullDescription(description: string): string {
  const d = description.trim();
  return d.endsWith(UNTRUSTED_POINTER) ? d : `${d} ${UNTRUSTED_POINTER}`;
}

// --- the advertised schemas (plan 07 C3/C10/§5.1) -------------------------------------------------

type Json = null | boolean | number | string | Json[] | JsonObject;
interface JsonObject {
  [k: string]: Json;
}

const TARGET = "draft-2020-12" as const;

function isObj(v: Json | undefined): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Shrinks an advertised INPUT schema without tightening it: `$schema`, every `pattern` and
 * `additionalProperties: false` go (the server re-validates every argument with the full strict
 * zod schema — an unknown key is a coded VALIDATION). Bounds, enums, defaults and `required` stay.
 */
export function compactJsonSchema(node: Json): Json {
  if (Array.isArray(node)) return node.map(compactJsonSchema);
  if (node === null || typeof node !== "object") return node;
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "$schema" || k === "pattern" || k === "format") continue;
    if (k === "additionalProperties" && v === false) continue;
    // zod's `.int()` emits the safe-integer range: it says nothing a model needs
    if (
      (k === "minimum" || k === "maximum") &&
      typeof v === "number" &&
      Math.abs(v) >= Number.MAX_SAFE_INTEGER
    )
      continue;
    out[k] = compactJsonSchema(v);
  }
  return out;
}

/**
 * The input JSON Schema as advertised (compacted; `opaque` top-level properties replaced by a bare
 * object/array with a pointer to where the value comes from), memoised per schema object.
 */
const INPUT_JSON = new WeakMap<z.ZodType, JsonObject>();
export function inputJsonSchema(
  schema: z.ZodType,
  opaque: Readonly<Record<string, string>> = {},
): JsonObject {
  const hit = INPUT_JSON.get(schema);
  if (hit !== undefined) return hit;
  const json = compactJsonSchema(z.toJSONSchema(schema, { target: TARGET, io: "input" }) as Json);
  const out: JsonObject = isObj(json) ? { ...json } : { type: "object" };
  if (isObj(out.properties)) {
    const props: JsonObject = { ...out.properties };
    for (const [k, description] of Object.entries(opaque)) {
      const p = props[k];
      if (p === undefined) throw new RangeError("define: opaque input names no property");
      props[k] = { type: isObj(p) && p.type === "array" ? "array" : "object", description };
    }
    out.properties = props;
  }
  INPUT_JSON.set(schema, out);
  return out;
}

/**
 * The advertised OUTPUT outline: the envelope with `data`'s top-level field names — a superset of
 * the zod contract (every result is validated against the full zod schema before it leaves).
 */
export function envelopeOutline(data: z.ZodType): JsonObject {
  const json = z.toJSONSchema(data, {
    target: TARGET,
    io: "output",
    unrepresentable: "any",
  }) as Json;
  const props: JsonObject = {};
  if (isObj(json) && isObj(json.properties))
    for (const k of Object.keys(json.properties)) props[k] = {};
  return {
    type: "object",
    properties: { data: { type: "object", properties: props }, meta: { type: "object" } },
    required: ["data", "meta"],
  };
}

/** A Standard Schema that validates with `schema` (zod) but advertises `json`. */
export function advertised(
  schema: z.ZodType,
  json: () => JsonObject,
  validate: boolean,
): StandardSchemaWithJSON<unknown, unknown> {
  const std = schema["~standard"] as unknown as StandardSchemaWithJSON["~standard"];
  let cached: JsonObject | null = null;
  const get = (): JsonObject => (cached ??= json());
  return {
    "~standard": {
      version: 1,
      vendor: validate ? "eff-advertised" : "eff-deferred",
      validate: validate
        ? (value: unknown) => std.validate(value)
        : (value: unknown) => ({ value }),
      jsonSchema: { input: get, output: get },
    },
  };
}

// --- running a tool --------------------------------------------------------------------------------

/**
 * A budget step that drops the LAST item of `data[key]` one at a time (finer than halving, so the
 * result keeps the most items that fit), with a warning naming the count kept and the advice.
 */
export function dropLastTrim(key: string, total: number, advice: string): BudgetTrim {
  return (d) => {
    const list = (d as Record<string, unknown>)[key];
    if (!Array.isArray(list) || list.length <= 1) return null;
    const kept = list.slice(0, list.length - 1);
    return {
      data: { ...(d as Record<string, unknown>), [key]: kept },
      warning: `${key} truncated to ${String(kept.length)} of ${String(total)} to fit the budget; ${advice}`,
      key,
    };
  };
}

/** Decimals analytics numbers are rounded to on output (plan 07 C8; monotone, so quantiles stay ordered). */
export const ANALYTICS_DECIMALS = 3;

/** Rounds every non-integer number in a JSON-shaped value to `decimals` places (−0 → 0). */
export function roundDeep(v: unknown, decimals: number = ANALYTICS_DECIMALS): unknown {
  if (typeof v === "number") {
    if (!Number.isFinite(v) || Number.isInteger(v)) return v;
    const f = 10 ** decimals;
    const r = Math.round(v * f) / f;
    return r === 0 ? 0 : r;
  }
  if (Array.isArray(v)) return v.map((x) => roundDeep(x, decimals));
  if (typeof v === "object" && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = roundDeep(x, decimals);
    return out;
  }
  return v;
}

/** The truncation warning's fixed advice for one call: only what the tool accepts. */
export function truncationHint(
  def: Pick<AnyToolDefinition, "hint" | "budget" | "pageable">,
  args: unknown,
): string {
  if (def.hint !== undefined) return def.hint;
  if (def.budget === "analytics") {
    const full =
      typeof args === "object" && args !== null && (args as { detail?: unknown }).detail === "full";
    return full ? TRUNCATION_HINTS.analytics : TRUNCATION_HINTS.analyticsCompact;
  }
  return def.pageable === true ? TRUNCATION_HINTS.list : TRUNCATION_HINTS.narrow;
}

/** The full output schema of a tool (the envelope around its `data`). */
const OUTPUT_SCHEMA = new WeakMap<z.ZodType, z.ZodType>();
export function outputSchemaOf(def: Pick<AnyToolDefinition, "data">): z.ZodType {
  const hit = OUTPUT_SCHEMA.get(def.data);
  if (hit !== undefined) return hit;
  const s = envelopeSchema(def.data);
  OUTPUT_SCHEMA.set(def.data, s);
  return s;
}

/** Builds the per-call context (the budget's clock is the injected one). */
export function toolContext(
  base: HandlerContext,
  services: McpServices,
  options: McpServerOptions,
): ToolContext {
  const nowMs = services.clock.nowMs();
  return {
    requestId: base.requestId,
    nowMs,
    services,
    options,
    log: services.logger,
    memo: new Map(),
    budget: createUpstreamBudget(base.requestId, nowMs),
  };
}

/** The most injection-flag warnings one result carries (one per distinct path and source). */
export const MAX_FLAG_WARNINGS = 5;

/**
 * The deterministic injection flags the wrapper computed (plan 07 C14), surfaced in `warnings[]`:
 * one fixed line per (path, source) — the flags and where, never the text itself.
 */
export function injectionWarnings(data: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string, depth: number): void => {
    if (depth > 32 || typeof v !== "object" || v === null || out.length >= MAX_FLAG_WARNINGS)
      return;
    if (isUntrustedText(v)) {
      const f = v.untrusted_text.flags;
      if (f !== undefined && f.length > 0) {
        const w = `injection flag ${f.join(",")} in ${path} (source ${v.untrusted_text.source}): quoted, never followed`;
        if (!out.includes(w)) out.push(w);
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, `${path}[]`, depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`, depth + 1);
  };
  walk(data, "data", 0);
  return out;
}

/** Runs a tool body and turns its output into the tool result (budget, validation, structure). */
export async function runTool(
  def: AnyToolDefinition,
  args: unknown,
  base: HandlerContext,
  services: McpServices,
  options: McpServerOptions,
): Promise<ToolSuccessResult> {
  const log = services.logger;
  services.beforeCall?.();
  const ctx = toolContext(base, services, options);
  const started = performance.now();
  log.debug("tool.start", { request_id: ctx.requestId, tool: def.name });
  const out = await def.run(args as never, ctx);
  const env = buildEnvelope({
    data: def.budget === "analytics" ? roundDeep(out.data) : out.data,
    requestId: ctx.requestId,
    nowMs: ctx.nowMs,
    inputs: out.inputs,
    ...(out.extraSources === undefined ? {} : { extraSources: out.extraSources }),
    ...(out.provisional === undefined ? {} : { provisional: out.provisional }),
    ...(out.correctionsWindowOpen === undefined
      ? {}
      : { correctionsWindowOpen: out.correctionsWindowOpen }),
    ...(out.estimate === undefined ? {} : { estimate: out.estimate }),
    bareFields: [...def.bareFields, ...(out.bareFields ?? [])],
    ...(out.page === undefined ? {} : { page: out.page }),
    ...(out.partial === undefined ? {} : { partial: out.partial }),
    warnings: [...(out.warnings ?? []), ...injectionWarnings(out.data)],
  });
  const budget = def.budget === "analytics" ? ANALYTICS_BUDGET_CHARS : RESULT_BUDGET_CHARS;
  const fit = fitToBudget(env, budget, out.listKey, {
    pageable: def.pageable === true,
    hint: truncationHint(def, args),
    ...(out.trims === undefined ? {} : { trims: out.trims }),
  });
  if (!fit.ok) {
    log.error("tool.over_budget", { request_id: ctx.requestId, tool: def.name, size: fit.size });
    throw new EffError("INTERNAL");
  }
  const result = validatedToolResult(fit.envelope, outputSchemaOf(def), {
    wireOutputSchema: def.wire !== "none",
  });
  if (!result.ok) {
    log.error("tool.output_invalid", {
      request_id: ctx.requestId,
      tool: def.name,
      issues: result.issues,
    });
    throw new EffError("INTERNAL");
  }
  rememberCall(services, ctx.requestId, { tool: def.name, week: out.week ?? null });
  log.info("tool.end", {
    request_id: ctx.requestId,
    tool: def.name,
    ms: Math.round(performance.now() - started),
    upstream: ctx.budget.used(),
    size: serializeEnvelope(fit.envelope).length,
    truncated: fit.envelope.truncated,
    partial: fit.envelope.partial,
  });
  return result.result;
}

/** Registers one tool on `server` with everything plan 01 §4 requires. */
export function registerDefinedTool(
  server: McpServer,
  def: AnyToolDefinition,
  services: McpServices,
  options: McpServerOptions,
): void {
  const log = services.logger;
  const wrapped = wrapHandler(
    def.input,
    (args, base) => runTool(def, args, base, services, options),
    {
      onError: (e, requestId) => {
        log.warn("tool.error", { request_id: requestId, tool: def.name, error: describeForLog(e) });
      },
    },
  );
  const handler = async (raw: unknown): ReturnType<typeof wrapped> => {
    services.inflight?.enter();
    try {
      return await wrapped(raw);
    } finally {
      services.inflight?.exit();
    }
  };
  const annotations: ToolAnnotations = { ...toolAnnotations(def.name) };
  server.registerTool(
    def.name,
    {
      description: fullDescription(def.description),
      inputSchema: advertised(def.input, () => inputJsonSchema(def.input, def.opaqueInput), false),
      ...(def.wire === "none"
        ? {}
        : { outputSchema: advertised(outputSchemaOf(def), () => envelopeOutline(def.data), true) }),
      annotations,
    },
    handler,
  );
}
