// views.test.ts — src/providers/espn/views/* (plan 05 §2 `providers/espn/views/*`, §3.3): every view
// schema parses every recorded fixture of its view (composites and split responses included); the
// schemas' required keys contain the drift seed and are a SUBSET of the manifest's observed keys (a
// schema never demands a key ESPN has never sent); removing any required key fails naming the JSON
// path and the view; the P28 skeleton fails every known view; passthrough keeps unknown fields; a
// bye parses; `__proto__` never reaches a parsed object.
import { describe, expect, it } from "vitest";
import type { z } from "zod/v4";
import { REQUIRED_PATHS_BY_VIEW } from "../../../src/drift/types.js";
import { parseJsonSafe } from "../../../src/providers/espn/request.js";
import { ESPN_VIEWS, isEspnView, type EspnView } from "../../../src/providers/espn/types.js";
import {
  issuePattern,
  mMatchupSchema,
  parseView,
  VIEW_SCHEMAS,
} from "../../../src/providers/espn/views/index.js";
import { loadFixture } from "./helpers.js";

interface ManifestFile {
  path: string;
  views: string[];
  status: number;
  request: { path: string; query: string };
  part: { index: number; array: string } | null;
}
const manifest = loadFixture("manifest.json") as { files: ManifestFile[] };
const driftManifest = loadFixture("../drift/manifest.json") as {
  views: Record<string, { observed: Record<string, string[]> }>;
};

/** Every recorded 200 response, split parts re-assembled. */
function recordedResponses(): { views: EspnView[]; body: unknown; source: string }[] {
  const groups = new Map<string, ManifestFile[]>();
  for (const f of manifest.files) {
    if (f.status !== 200 || !f.path.startsWith("recorded/")) continue;
    const key = f.path.replace(/\.p\d+\.json$/, "");
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const out: { views: EspnView[]; body: unknown; source: string }[] = [];
  for (const [key, files] of groups) {
    const views = files[0]!.views.filter(isEspnView);
    if (views.length === 0) continue;
    const parts = files
      .sort((a, b) => (a.part?.index ?? 0) - (b.part?.index ?? 0))
      .map((f) => loadFixture(f.path));
    const arr = files[0]!.part?.array;
    let body: unknown = parts[0];
    if (arr !== undefined && parts.length > 1) {
      body =
        arr === "$"
          ? parts.flat()
          : {
              ...(parts[0] as object),
              [arr]: parts.flatMap((p) => (p as Record<string, unknown[]>)[arr]),
            };
    }
    out.push({ views, body, source: key });
  }
  return out;
}

interface Def {
  type: string;
  shape?: Record<string, z.ZodType>;
  innerType?: z.ZodType;
  element?: z.ZodType;
  valueType?: z.ZodType;
}
const defOf = (s: z.ZodType): Def => (s as unknown as { def: Def }).def;

/**
 * The schema's required paths (`$.settings.scoringSettings`), in the drift pattern language;
 * `conditional` when an ancestor is optional (required only where that ancestor is present).
 */
function requiredEntries(
  schema: z.ZodType,
  pattern = "$",
  conditional = false,
): { path: string; conditional: boolean }[] {
  const d = defOf(schema);
  if (d.type === "object") {
    const out: { path: string; conditional: boolean }[] = [];
    for (const [k, v] of Object.entries(d.shape ?? {})) {
      const vd = defOf(v);
      const optional = vd.type === "optional" || vd.type === "nullable";
      if (!optional) out.push({ path: `${pattern}.${k}`, conditional });
      out.push(...requiredEntries(v, `${pattern}.${k}`, conditional || optional));
    }
    return out;
  }
  if (d.type === "optional" || d.type === "nullable")
    return requiredEntries(d.innerType!, pattern, true);
  if (d.type === "array") return requiredEntries(d.element!, `${pattern}[]`, conditional);
  if (d.type === "record") return requiredEntries(d.valueType!, `${pattern}{}`, conditional);
  return [];
}
const requiredPaths = (schema: z.ZodType): string[] => requiredEntries(schema).map((e) => e.path);

describe("every recorded fixture parses with its view schema(s)", () => {
  const responses = recordedResponses();
  it("finds the corpus (every league view, the season views, composites)", () => {
    const seen = new Set(responses.flatMap((r) => r.views));
    for (const v of [
      "mSettings",
      "mNav",
      "mTeam",
      "mStandings",
      "mRoster",
      "mMatchup",
      "mMatchupScore",
      "mBoxscore",
      "kona_player_info",
      "kona_playercard",
      "proTeamSchedules_wl",
      "players_wl",
    ])
      expect(seen.has(v as EspnView), v).toBe(true);
    expect(responses.length).toBeGreaterThan(40);
  });
  it.each(responses.map((r) => [r.source, r] as const))("%s", (_s, r) => {
    for (const v of r.views) {
      const p = parseView(v, VIEW_SCHEMAS[v], r.body);
      expect(p.ok ? [] : p.signals, `${r.source} as ${v}`).toEqual([]);
    }
  });
});

describe("required keys: the seed ⊆ the schema ⊆ the manifest's observed keys (plan 05 §3.3)", () => {
  it("each schema's required set contains the drift seed (REQUIRED_PATHS_BY_VIEW)", () => {
    for (const v of ESPN_VIEWS) {
      const req = new Set(requiredPaths(VIEW_SCHEMAS[v]));
      for (const p of REQUIRED_PATHS_BY_VIEW[v]) {
        const want = p.endsWith("[]") ? p.slice(0, -2) : p;
        if (want === "$") expect(defOf(VIEW_SCHEMAS[v]).type).toBe("array");
        else expect(req.has(want), `${v}: ${p}`).toBe(true);
      }
    }
  });
  it("every required key of a recorded view is a key the manifest observed there", () => {
    for (const [view, vm] of Object.entries(driftManifest.views)) {
      if (!isEspnView(view)) continue;
      for (const { path: p, conditional } of requiredEntries(VIEW_SCHEMAS[view])) {
        const dot = p.lastIndexOf(".");
        const parent = p.slice(0, dot);
        const observed = vm.observed[parent];
        if (conditional && observed === undefined) continue;
        expect(observed, `${view}: no observation at ${parent}`).toBeDefined();
        expect(observed, `${view}: ${p}`).toContain(p.slice(dot + 1));
      }
    }
  });
});

describe("drift by schema", () => {
  const responses = recordedResponses();
  it("removing each required key (on its first node) fails naming that path and view", () => {
    let checked = 0;
    for (const r of responses.filter(
      (x) => x.source.includes("league-a") || x.source.includes("season"),
    )) {
      for (const v of r.views) {
        for (const p of requiredPaths(VIEW_SCHEMAS[v])) {
          const body: unknown = structuredClone(r.body);
          const segs = p.slice(2).split(".");
          let node: unknown = body;
          let ok = true;
          for (const seg of segs.slice(0, -1)) {
            const name = seg.replace(/(\[\]|\{\})+$/, "");
            node = (node as Record<string, unknown> | undefined)?.[name];
            for (const _ of seg.match(/\[\]|\{\}/g) ?? [])
              node = Array.isArray(node)
                ? node[0]
                : node && typeof node === "object"
                  ? Object.values(node)[0]
                  : undefined;
            if (node === undefined || node === null) ok = false;
          }
          if (!ok || typeof node !== "object" || node === null) continue;
          Reflect.deleteProperty(node, segs.at(-1)!.replace(/(\[\]|\{\})+$/, ""));
          const res = parseView(v, VIEW_SCHEMAS[v], body);
          expect(res.ok, `${r.source} ${v} ${p}`).toBe(false);
          if (!res.ok)
            expect(
              res.signals.some((s) => s.path === p && s.view === v),
              `${p} in ${JSON.stringify(res.signals)}`,
            ).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
  it("the recorded skeleton fails every league view's schema; the season skeleton every season view's", () => {
    const league = loadFixture("recorded/league-a/skeleton.json");
    const season = loadFixture("recorded/season/skeleton.json");
    for (const v of ESPN_VIEWS) {
      const body = v === "proTeamSchedules_wl" || v === "players_wl" ? season : league;
      expect(parseView(v, VIEW_SCHEMAS[v], body).ok, v).toBe(false);
    }
  });
  it("signals are distinct and capped at 8", () => {
    const r = parseView("mRoster", VIEW_SCHEMAS.mRoster, {
      teams: Array.from({ length: 20 }, () => ({})),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.signals.length).toBeLessThanOrEqual(8);
      expect(new Set(r.signals.map((s) => s.path)).size).toBe(r.signals.length);
    }
  });
});

describe("passthrough, byes, prototype safety", () => {
  it("unknown keys pass through a parse untouched", () => {
    const body = structuredClone(loadFixture("recorded/league-a/mMatchup.json")) as Record<
      string,
      unknown
    >;
    body.someNewKey = { nested: true };
    const r = parseView("mMatchup", mMatchupSchema, body);
    expect(r.ok && (r.value as Record<string, unknown>).someNewKey).toEqual({ nested: true });
  });
  it("a bye (home without away) parses", () => {
    const r = parseView("mMatchup", mMatchupSchema, {
      id: 0,
      seasonId: 2026,
      scoringPeriodId: 1,
      schedule: [{ id: 1, matchupPeriodId: 1, home: { teamId: 3 } }],
    });
    expect(r.ok).toBe(true);
  });
  it("`__proto__` is dropped at parse time and never sets a prototype (plan 02 §5 A-3)", () => {
    const text =
      '{"id":0,"seasonId":2026,"scoringPeriodId":1,"schedule":[],"__proto__":{"polluted":1},"x":{"__proto__":{"p":2}}}';
    const body = parseJsonSafe(text) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(body, "__proto__")).toBe(false);
    const r = parseView("mMatchup", mMatchupSchema, JSON.parse(text) as unknown);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.getPrototypeOf(r.value)).toBe(Object.prototype);
    expect(({} as { polluted?: number }).polluted).toBeUndefined();
  });
  it("issuePattern renders zod paths in the pattern language", () => {
    expect(issuePattern(["teams", 3, "roster", "entries", 0, "playerId"])).toBe(
      "$.teams[].roster.entries[].playerId",
    );
    expect(issuePattern(["settings", "lineupSlotCounts", "odd key"])).toBe(
      "$.settings.lineupSlotCounts{}",
    );
    expect(issuePattern([Symbol("s")])).toBe("${}");
    expect(issuePattern([])).toBe("$");
  });
});
