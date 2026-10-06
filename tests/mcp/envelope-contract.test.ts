// envelope-contract.test.ts — the contract-revision additions to src/mcp/envelope.ts: every
// recorded player id passes playerIdSchema (CAT-01; plan 02 §5 A-2), schema-marked bare text and
// the derived `meta.untrusted_fields` path list (CAT-05; plan 01 §4.4, plan 07 C15, plan 05 §2),
// structuredContent tied to wireOutputSchema with in-code validation in both modes through a REAL
// SDK 2.2.0 server (M4; plan 01 §4, T-06), degraded reads warned by the envelope (B3; plan 01
// §4.3), the tool-family annotation table (CAT-16; plan 01 §4.1, plan 07 §2), and the resource
// payload types — no tool or resource payload carries `league_id` (CAT-09; plan 07 §4.1).
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import fc from "fast-check";
import { z } from "zod/v4";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  EvidenceData,
  InjuriesData,
  InjuryCascadeData,
  LeagueActivityData,
  LineupData,
  MatchupAnalysisData,
  NewsData,
  PlayerUsageData,
  ProjectionData,
  ReplacementData,
  RosterAnalysisData,
  ScheduleAnalysisData,
  ScheduleData,
  TradeData,
  WaiversData,
  DefenseProfileData,
  DepthChartData,
} from "../../src/domain/analytics/types.js";
import type {
  BoxScoreData,
  LeagueDigestData,
  LiveScoreboardData,
  PlayerListData,
  PlayerOutlookData,
  PlayerSearchData,
  PlayerStatsData,
  RosterToolData,
  ScoreboardData,
  Standings,
  TransactionsData,
  EspnProjectionsData,
  PlatformStamp,
} from "../../src/domain/league/types.js";
import type {
  RecommendationListData,
  RecordResult,
  RetrospectiveData,
} from "../../src/domain/reclog/types.js";
import {
  BARE_TEXT_META_KEY,
  FIELD_PATH_RE,
  TEXT_CAPS,
  TOOL_FAMILIES,
  TOOL_FAMILY_OF,
  UNTRUSTED_SOURCES,
  UNTRUSTED_SOURCE_CLASS,
  bareFieldsFromSchema,
  bareTextSchema,
  buildEnvelope,
  envelopeSchema,
  playerIdSchema,
  stampToInput,
  toToolResult,
  toolAnnotations,
  validatedToolResult,
  type ResourcePayloads,
} from "../../src/mcp/envelope.js";
import type { CheckAuthData, StatusData } from "../../src/providers/platform.js";

const NOW = Date.parse("2026-10-05T18:00:00Z");
const RID = "r-0123456789ab";
const REPO = path.resolve(import.meta.dirname, "..", "..");

// --- CAT-01: every recorded player id ------------------------------------------------------------

function jsonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...jsonFiles(p));
    else if (name.endsWith(".json")) out.push(p);
  }
  return out;
}

/** Every ESPN player id a recorded body carries (`playerId` keys and `player.id`). */
function playerIds(v: unknown, out: Set<number>, depth = 0): void {
  if (depth > 64 || typeof v !== "object" || v === null) return;
  if (Array.isArray(v)) {
    for (const x of v) playerIds(x, out, depth + 1);
    return;
  }
  const o = v as Record<string, unknown>;
  if (typeof o.playerId === "number") out.add(o.playerId);
  const pl = o.player;
  if (typeof pl === "object" && pl !== null && typeof (pl as { id?: unknown }).id === "number")
    out.add((pl as { id: number }).id);
  for (const x of Object.values(o)) playerIds(x, out, depth + 1);
}

describe("CAT-01: every player id in fixtures/espn/recorded passes playerIdSchema", () => {
  const files = jsonFiles(path.join(REPO, "fixtures", "espn", "recorded"));
  const ids = new Set<number>();
  for (const f of files) playerIds(JSON.parse(readFileSync(f, "utf8")) as unknown, ids);
  it("the corpus is non-trivial and holds both verified team-unit families", () => {
    expect(files.length).toBeGreaterThan(40);
    expect(ids.size).toBeGreaterThan(250);
    expect([...ids].some((i) => i <= -16_001 && i >= -16_999)).toBe(true);
    expect([...ids].some((i) => i <= -15_001 && i >= -15_999)).toBe(true);
  });
  it("no recorded id is refused (an E2 Rec holding the TQB starter validates)", () => {
    const refused = [...ids].filter((i) => !playerIdSchema.safeParse(i).success);
    expect(refused).toEqual([]);
  });
});

// --- CAT-05: schema-marked bare text --------------------------------------------------------------

describe("CAT-05: bareTextSchema marks positions; bareFieldsFromSchema derives the path list", () => {
  const name = bareTextSchema("espn.player.name");
  const rowSchema = z.strictObject({
    player_id: playerIdSchema,
    name,
    nick: bareTextSchema("espn.player.name").nullable(),
  });
  const dataSchema = z.strictObject({
    players: z.array(rowSchema),
    calls: z
      .array(
        z.strictObject({
          recommended: bareTextSchema("store.recommendation_log"),
          best_alternative: bareTextSchema("store.recommendation_log").optional(),
        }),
      )
      .default([]),
    pick: z.union([z.strictObject({ name }), z.null()]),
    nested: z.lazy(() => z.strictObject({ inner: z.tuple([name]) })),
    count: z.number(),
  });

  it("caps at the source's class cap, refuses unprintable text, carries the marker", () => {
    expect(name.meta()).toEqual({ [BARE_TEXT_META_KEY]: "espn.player.name" });
    expect(name.safeParse("x".repeat(TEXT_CAPS.player_name)).success).toBe(true);
    expect(name.safeParse("x".repeat(TEXT_CAPS.player_name + 1)).success).toBe(false);
    for (const bad of ["a‮b", "a​b", "a\u0000b", "a\nb", "\u{E0041}"])
      expect(name.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(() => bareTextSchema("espn.nope" as never)).toThrow(RangeError);
    for (const src of UNTRUSTED_SOURCES)
      expect(
        bareTextSchema(src).safeParse("x".repeat(TEXT_CAPS[UNTRUSTED_SOURCE_CLASS[src]])).success,
      ).toBe(true);
  });

  it("derives every marked path through arrays, nullable, optional, default, unions, lazies and tuples", () => {
    expect(bareFieldsFromSchema(dataSchema)).toEqual([
      { path: "data.players[].name", source: "espn.player.name" },
      { path: "data.players[].nick", source: "espn.player.name" },
      { path: "data.calls[].recommended", source: "store.recommendation_log" },
      { path: "data.calls[].best_alternative", source: "store.recommendation_log" },
      { path: "data.pick.name", source: "espn.player.name" },
      { path: "data.nested.inner[]", source: "espn.player.name" },
    ]);
    for (const f of bareFieldsFromSchema(dataSchema)) expect(f.path).toMatch(FIELD_PATH_RE);
  });

  it("walks intersections, pipes (transforms), tuple rests, readonly and catch wrappers", () => {
    const n = bareTextSchema("espn.player.name");
    const s = z.strictObject({
      both: z.intersection(z.object({ a: n }), z.object({ b: n })),
      piped: n.transform((x) => x.trim()),
      piped2: z.string().pipe(n),
      rest: z.tuple([z.number()], n),
      ro: z.strictObject({ r: n }).readonly(),
      caught: n.catch("x"),
      deep: z.lazy(() => z.lazy(() => z.strictObject({ d: n }))),
      // a record of unmarked values is fine (only a MARKED position under a record is refused)
      counts: z.record(z.string(), z.number()),
    });
    expect(bareFieldsFromSchema(s).map((f) => f.path)).toEqual([
      "data.both.a",
      "data.both.b",
      "data.piped",
      "data.piped2",
      "data.rest[]",
      "data.ro.r",
      "data.caught",
      "data.deep.d",
    ]);
  });

  it("refuses a marked position under a record (dynamic keys cannot be path-listed)", () => {
    expect(() => bareFieldsFromSchema(z.strictObject({ by: z.record(z.string(), name) }))).toThrow(
      /record/,
    );
  });

  it("every meta-tagged path appears in meta.untrusted_fields of a sample output", () => {
    const data = dataSchema.parse({
      players: [{ player_id: 4_362_628, name: "Player One", nick: null }],
      calls: [{ recommended: "start Player One" }],
      pick: { name: "Player Two" },
      nested: { inner: ["Player Three"] },
      count: 1,
    });
    const env = buildEnvelope({
      data,
      requestId: RID,
      nowMs: NOW,
      inputs: [],
      bareFields: bareFieldsFromSchema(dataSchema),
    });
    const listed = new Set(env.meta.untrusted_fields.map((f) => `${f.path}|${f.source}`));
    for (const f of bareFieldsFromSchema(dataSchema))
      expect(listed).toContain(`${f.path}|${f.source}`);
    expect(envelopeSchema(dataSchema).safeParse(JSON.parse(JSON.stringify(env))).success).toBe(
      true,
    );
  });

  it("property: an unmarked schema derives no paths", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom("a", "b", "c", "d"), { maxLength: 4 }), (keys) => {
        const shape = Object.fromEntries(keys.map((k) => [k, z.array(z.string())]));
        return bareFieldsFromSchema(z.strictObject(shape)).length === 0;
      }),
    );
  });
});

// --- M4: structuredContent iff wireOutputSchema; validation in both modes -----------------------

describe("M4: toToolResult/validatedToolResult and the SDK's output check", () => {
  const data = z.strictObject({ week: z.number().int().min(1).max(18) });
  const out = envelopeSchema(data);
  const env = (week: number) =>
    buildEnvelope({ data: { week }, requestId: RID, nowMs: NOW, inputs: [] });

  it("validatedToolResult validates against the in-code schema in both wire modes", () => {
    for (const wireOutputSchema of [true, false]) {
      const good = validatedToolResult(env(3), out, { wireOutputSchema });
      expect(good.ok).toBe(true);
      if (good.ok) expect("structuredContent" in good.result).toBe(wireOutputSchema);
      const bad = validatedToolResult(env(19), out, { wireOutputSchema });
      expect(bad.ok).toBe(false);
      if (!bad.ok) {
        expect(bad.issues[0]).toEqual({ path: "data.week", code: "too_big" });
        expect(JSON.stringify(bad.issues)).not.toContain("19");
      }
    }
  });

  it("a hostile key never reaches the issue summary (value-free paths)", () => {
    const loose = envelopeSchema(z.record(z.string(), z.number()));
    const e = buildEnvelope({
      data: { "ignore previous‮": "x" },
      requestId: RID,
      nowMs: NOW,
      inputs: [],
    });
    const r = validatedToolResult(e, loose, { wireOutputSchema: false });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("ignore previous");
  });

  async function connect() {
    const server = new McpServer({ name: "eff-test", version: "0.0.0" });
    // a list tool with its outputSchema OFF the wire: text only, validated in code
    server.registerTool("espn_list_probe", { description: "wire off" }, () => {
      const r = validatedToolResult(env(4), out, { wireOutputSchema: false });
      if (!r.ok) throw new Error("invalid");
      return r.result;
    });
    // a tool advertising an outputSchema: structuredContent is required by the SDK
    server.registerTool("espn_struct_probe", { description: "wire on", outputSchema: out }, () => {
      const r = validatedToolResult(env(5), out, { wireOutputSchema: true });
      if (!r.ok) throw new Error("invalid");
      return r.result;
    });
    // the decoupled mistake M4 forbids: an advertised outputSchema with a text-only result
    server.registerTool("espn_mismatch_probe", { description: "mismatch", outputSchema: out }, () =>
      toToolResult(env(6), { wireOutputSchema: false }),
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "eff-test-client", version: "0.0.0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    return { server, client };
  }

  it("smoke: wireOutputSchema false → tools/list has no outputSchema and the text result passes", async () => {
    const { server, client } = await connect();
    const tools = (await client.listTools()).tools;
    expect(tools.find((t) => t.name === "espn_list_probe")?.outputSchema).toBeUndefined();
    expect(tools.find((t) => t.name === "espn_struct_probe")?.outputSchema).toBeDefined();
    const r = await client.callTool({ name: "espn_list_probe", arguments: {} });
    expect(r.isError).not.toBe(true);
    expect(r.structuredContent).toBeUndefined();
    const text = (r.content as { text: string }[])[0]?.text ?? "";
    expect((JSON.parse(text) as { data: unknown }).data).toEqual({ week: 4 });
    const s = await client.callTool({ name: "espn_struct_probe", arguments: {} });
    expect((s.structuredContent as { data: unknown }).data).toEqual({ week: 5 });
    await client.close();
    await server.close();
  });

  it("smoke: an advertised outputSchema without structuredContent is refused by SDK 2.2.0", async () => {
    const { server, client } = await connect();
    const r = await client.callTool({ name: "espn_mismatch_probe", arguments: {} }).then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    // either a protocol error or an error result — never a silent success
    if (r.ok) expect(r.v.isError).toBe(true);
    else expect(r.e).toBeInstanceOf(Error);
    await client.close();
    await server.close();
  });
});

// --- B3: a degraded read is warned by the envelope ----------------------------------------------

describe("B3: PlatformStamp.degraded → a warning naming the code, freshness stale", () => {
  const stamp = (over: Partial<PlatformStamp>): PlatformStamp => ({
    source: "espn:mRoster",
    as_of: "2026-10-05T17:58:00Z",
    fetched_at: "2026-10-05T17:58:00Z",
    freshness: "espn_roster",
    provisional: false,
    cache: "stale",
    drift: null,
    degraded: null,
    ...over,
  });
  it("adds the code once per input; a clean stamp adds nothing", () => {
    const degraded = stampToInput(
      stamp({
        degraded: {
          code: "ESPN_UPSTREAM_UNAVAILABLE",
          served: "stale_cache",
          hard_limit_suspended: false,
        },
      }),
      NOW,
    );
    const env = buildEnvelope({
      data: {},
      requestId: RID,
      nowMs: NOW,
      inputs: [degraded, degraded],
    });
    expect(env.warnings).toEqual([
      "ESPN_UPSTREAM_UNAVAILABLE: espn:mRoster served from stale cache",
    ]);
    expect(env.meta.freshness).toBe("stale");
    const clean = buildEnvelope({
      data: {},
      requestId: RID,
      nowMs: NOW,
      inputs: [stampToInput(stamp({}), NOW)],
    });
    expect(clean.warnings).toEqual([]);
    expect(clean.meta.freshness).toBe("fresh");
  });
  it("names the suspended hard limit while ESPN's host is moved", () => {
    const i = stampToInput(
      stamp({
        degraded: { code: "ESPN_HOST_MOVED", served: "stale_cache", hard_limit_suspended: true },
      }),
      NOW,
    );
    const env = buildEnvelope({ data: {}, requestId: RID, nowMs: NOW, inputs: [i] });
    expect(env.warnings[0]).toMatch(
      /^ESPN_HOST_MOVED: espn:mRoster served from stale cache \(hard limit suspended/,
    );
  });
});

// --- CAT-16: families and annotations -------------------------------------------------------------

describe("CAT-16: TOOL_FAMILIES and TOOL_FAMILY_OF (plan 01 §4.1; plan 07 §2, C3)", () => {
  const entries = Object.entries(TOOL_FAMILY_OF);
  it("34 read tools: 18 P0 + 16 P1, unique catalog ids, names in the plan 01 §4.1 grammar", () => {
    expect(entries).toHaveLength(34);
    expect(entries.filter(([, e]) => e.priority === "P0")).toHaveLength(18);
    expect(entries.filter(([, e]) => e.priority === "P1")).toHaveLength(16);
    expect(new Set(entries.map(([, e]) => e.id)).size).toBe(34);
    for (const [n] of entries) expect(n).toMatch(/^espn_[a-z][a-z0-9_]{1,34}$/);
    for (const [n] of entries) expect(n.length).toBeLessThanOrEqual(40);
  });
  it("families carry plan 01 §4.1's annotations", () => {
    expect(TOOL_FAMILIES.espn_fact).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(TOOL_FAMILIES.analytics).toEqual({
      readOnlyHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(TOOL_FAMILIES.dataset_read.openWorldHint).toBe(false);
    expect(TOOL_FAMILIES.local_write).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(TOOL_FAMILIES.ops).toEqual({ readOnlyHint: true, openWorldHint: false });
  });
  it("the plan's named exceptions: D2/D3/D5 and G2 are openWorld; E12 is an idempotent local write", () => {
    for (const n of [
      "espn_get_injuries",
      "espn_get_schedule",
      "espn_get_defense_profile",
      "espn_check_auth",
    ])
      expect(toolAnnotations(n).openWorldHint, n).toBe(true);
    for (const n of [
      "espn_get_player_usage",
      "espn_get_depth_chart",
      "espn_get_status",
      "espn_list_recommendations",
    ])
      expect(toolAnnotations(n).openWorldHint, n).toBe(false);
    expect(toolAnnotations("espn_record_recommendation")).toMatchObject({
      readOnlyHint: false,
      idempotentHint: true,
    });
    for (const [n, e] of entries)
      if (n !== "espn_record_recommendation")
        expect(toolAnnotations(n).readOnlyHint, `${n} ${e.id}`).toBe(true);
    expect(() => toolAnnotations("espn_commit_lineup")).toThrow(RangeError);
    expect(() => toolAnnotations("__proto__")).toThrow(RangeError);
  });
  it("is frozen", () => {
    expect(Object.isFrozen(TOOL_FAMILY_OF)).toBe(true);
    expect(Object.isFrozen(TOOL_FAMILIES)).toBe(true);
  });
});

// --- CAT-09: no payload carries league_id --------------------------------------------------------

/** The literal (non-index-signature) keys of T: a `Record<string, X>` contributes none. */
type LiteralKeys<T> = {
  [K in keyof T]-?: string extends K ? never : number extends K ? never : K;
}[keyof T];
/** Every literal object key reachable in T (arrays walked; index-signature values walked too). */
type DeepKeys<T, D extends unknown[] = []> = D["length"] extends 12
  ? never
  : T extends readonly (infer U)[]
    ? DeepKeys<U, [...D, 0]>
    : T extends object
      ? LiteralKeys<T> | { [K in keyof T]-?: DeepKeys<T[K], [...D, 0]> }[keyof T]
      : never;
type HasLeagueId<T> = "league_id" extends DeepKeys<T> ? true : false;

describe("CAT-09: no tool or resource payload has a `league_id` key (type level)", () => {
  it("tool data types", () => {
    expectTypeOf<HasLeagueId<LeagueDigestData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<Standings>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<ScoreboardData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<LiveScoreboardData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<BoxScoreData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<TransactionsData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<RosterToolData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<PlayerStatsData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<PlayerSearchData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<PlayerListData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<EspnProjectionsData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<PlayerOutlookData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<PlayerUsageData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<InjuriesData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<ScheduleData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<DepthChartData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<DefenseProfileData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<NewsData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<ProjectionData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<LineupData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<MatchupAnalysisData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<ReplacementData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<WaiversData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<TradeData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<InjuryCascadeData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<ScheduleAnalysisData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<RosterAnalysisData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<EvidenceData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<LeagueActivityData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<RecordResult>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<RetrospectiveData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<RecommendationListData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<StatusData>>().toEqualTypeOf<false>();
    expectTypeOf<HasLeagueId<CheckAuthData>>().toEqualTypeOf<false>();
  });
  it("resource payloads", () => {
    expectTypeOf<HasLeagueId<ResourcePayloads[keyof ResourcePayloads]>>().toEqualTypeOf<false>();
  });
  it("the walker itself sees a nested league_id (it is not vacuous), also under a record", () => {
    expectTypeOf<
      HasLeagueId<{ a: readonly { b: { league_id: string } }[] }>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      HasLeagueId<{ m: Readonly<Record<string, { league_id: 1 }>> }>
    >().toEqualTypeOf<true>();
    expectTypeOf<HasLeagueId<{ m: Readonly<Record<string, number>> }>>().toEqualTypeOf<false>();
  });
});
