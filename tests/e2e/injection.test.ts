// injection.test.ts — injection invariance end to end (plan 10 A8a; plan 09 §5.1 #8; plan 05 §2
// `mcp/tools` analytics row; research 05 §6 cases 1–4): on each `inj-*` variant of fx-10h the
// analytics tools answer exactly what they answer on the base league (data compared after dropping
// the per-call bookkeeping — request ids, ages, fetch times — and warnings / meta.untrusted_fields);
// every injected string an ESPN-fact tool surfaces (at either detail level, and even when the field's
// cap cuts it) is wrapped as untrusted_text with flags, never shown bare; and no injected string ever
// appears in a tool's arguments (the Lane 1 dry run's resolved arguments included: the weekly
// pre-run chain replayed on every variant).
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadToolSequences, resolveArgs } from "../../scripts/skills/tool-sequences.mjs";
import { INJECTIONS } from "../../scripts/fx10h/variants.js";
import { bodyOf, FX, makeHome, requireDist, serve, type Served } from "./helpers.js";

const VARIANTS = [
  "inj-outlook-system",
  "inj-teamname-json",
  "inj-ir-cleared",
  "inj-tradeblock",
  "inj-league-name",
  "inj-division-name",
] as const;
const TEXTS = Object.values(INJECTIONS);

const ANALYTICS: readonly [string, Record<string, unknown>][] = [
  ["espn_project_players", { players: { team_id: 2 }, horizon: "week", week: 5, seed: 7 }],
  ["espn_analyze_lineup", { week: 5, objective: "auto" }],
  ["espn_analyze_waivers", { mode: "auto", phase: "auto" }],
  ["espn_analyze_waivers", { mode: "auto", positions: ["K"], look_ahead: 2 }],
  ["espn_analyze_retrospective", { week: 4 }],
];
const FACTS: readonly [string, Record<string, unknown>][] = [
  ["espn_get_league", {}],
  ["espn_get_league", { detail: "full" }],
  ["espn_get_standings", {}],
  ["espn_get_standings", { detail: "full" }],
  ["espn_get_scoreboard", { week: 5 }],
  ["espn_get_roster", { week: 5, all: true }],
  ["espn_get_injuries", { players: { team_id: 2 } }],
  ["espn_search_players", { query: "a" }],
];
/** Each variant's injected strings (inj-teamname-json also sets the abbreviation "IGNORE"). */
const INJECTED: Readonly<Record<(typeof VARIANTS)[number], readonly string[]>> = {
  "inj-outlook-system": [INJECTIONS.outlookSystem],
  "inj-teamname-json": [INJECTIONS.teamNameJson, INJECTIONS.teamAbbrevJson],
  "inj-ir-cleared": [INJECTIONS.irCleared],
  "inj-tradeblock": [INJECTIONS.tradeBlock],
  "inj-league-name": [INJECTIONS.leagueName],
  "inj-division-name": [INJECTIONS.divisionName],
};
/**
 * The variants whose text a P0 fact tool shows: team names and abbreviations (A2, A3), the league
 * name (A1) and division names (A2 `detail: "full"`). Outlooks are the P1 outlook tool's (plan 07
 * C14) and no P0 tool shows a trade block.
 */
const SHOWN = new Set(["inj-teamname-json", "inj-league-name", "inj-division-name"]);
/**
 * The search key of an injected text: a prefix short enough to survive every cap it can meet (the
 * division name's 32 code points, the abbreviation's 8), so a cut copy is still found.
 */
const needleOf = (text: string): string => text.slice(0, Math.min(text.length, 24));
/** Non-overlapping occurrences of `needle` in `hay`. */
function occurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Drops what legitimately differs between two runs (bookkeeping, not answers). */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (typeof v !== "object" || v === null) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (["request_id", "age_s", "fetched_at", "as_of", "latest_execution_time"].includes(k))
      continue;
    out[k] = stable(x);
  }
  return out;
}

/** Every `untrusted_text` object whose value contains `needle`. */
function wrapped(v: unknown, needle: string): { value: string; flags?: unknown[] }[] {
  const out: { value: string; flags?: unknown[] }[] = [];
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (typeof x === "object" && x !== null) {
      const o = x as Record<string, unknown>;
      const ut = o.untrusted_text as { value?: unknown; flags?: unknown[] } | undefined;
      if (ut !== undefined && typeof ut.value === "string" && ut.value.includes(needle))
        out.push(ut as { value: string; flags?: unknown[] });
      Object.values(o).forEach(walk);
    }
  };
  walk(v);
  return out;
}

const servers: Served[] = [];
const homes: { cleanup(): void }[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop().catch(() => undefined);
  for (const h of homes) h.cleanup();
});
async function open(variant: string | null): Promise<Served> {
  requireDist();
  const h = makeHome({ fixtureDir: variant === null ? FX : path.join(FX, variant) });
  homes.push(h);
  const s = await serve(h);
  servers.push(s);
  return s;
}
async function call(s: Served, name: string, args: Record<string, unknown>) {
  const r = await s.client.callTool({ name, arguments: args });
  const b = bodyOf(r);
  expect(r.isError, `${name}: ${JSON.stringify(b).slice(0, 300)}`).not.toBe(true);
  return b;
}

describe("injection invariance over real stdio (A8a)", { timeout: 600_000 }, () => {
  const baseline = new Map<string, unknown>();

  it("the base league's analytics answers (the reference)", async () => {
    const s = await open(null);
    for (const [i, [name, args]] of ANALYTICS.entries()) {
      const b = await call(s, name, args);
      baseline.set(String(i), stable(b.data));
      expect(TEXTS.some((t) => JSON.stringify(b).includes(t))).toBe(false);
    }
  });

  it.each(VARIANTS.map((v) => [v] as const))(
    "%s: analytics unchanged, the text flagged where shown, never in an argument",
    async (variant) => {
      const s = await open(variant);
      for (const [i, [name, args]] of ANALYTICS.entries()) {
        const b = await call(s, name, args);
        expect(stable(b.data), `${variant}: ${name} changed`).toEqual(baseline.get(String(i)));
      }
      const surfaced = new Map<string, number>();
      for (const [name, args] of FACTS) {
        const b = await call(s, name, args);
        const raw = JSON.stringify(b);
        const where = `${variant}: ${name} ${JSON.stringify(args)}`;
        for (const text of INJECTED[variant]) {
          const needle = needleOf(text);
          const escaped = JSON.stringify(needle).slice(1, -1);
          const shown = occurrences(raw, escaped);
          if (shown === 0) continue;
          // every copy sits inside an untrusted_text value, and every such value carries flags
          const hits = wrapped(b, needle);
          const insideWrappers = hits.reduce(
            (n, h) => n + occurrences(JSON.stringify(h.value).slice(1, -1), escaped),
            0,
          );
          expect(insideWrappers, `${where} shows ${needle} outside untrusted_text`).toBe(shown);
          for (const h of hits)
            expect(
              h.flags?.length ?? 0,
              `${where}: no flags on ${JSON.stringify(h.value)}`,
            ).toBeGreaterThan(0);
          surfaced.set(text, (surfaced.get(text) ?? 0) + 1);
        }
      }
      // the weekly pre-run chain: no injected string reaches a resolved argument
      const weekly = loadToolSequences()
        .find((x) => x.skill === "weekly")
        ?.sequences.find((q) => q.id === "pre_run");
      const results = new Map<string, { tool: string; result: unknown }>();
      for (const step of weekly?.steps ?? []) {
        const args = resolveArgs(step.args, results) as Record<string, unknown>;
        for (const t of TEXTS)
          expect(JSON.stringify(args).includes(t.slice(0, 30)), `${variant}: ${step.id} args`).toBe(
            false,
          );
        const r = await s.client.callTool({ name: step.tool, arguments: args });
        if (r.isError !== true) results.set(step.id, { tool: step.tool, result: bodyOf(r) });
      }
      // the shown variants: every injected field reached a fact tool (wrapped, flagged — above)
      if (SHOWN.has(variant))
        for (const text of INJECTED[variant])
          expect(
            surfaced.get(text) ?? 0,
            `${variant}: ${needleOf(text)} never shown`,
          ).toBeGreaterThan(0);
    },
  );
});
