// evidence-steps.test.ts — espn_analyze_evidence reads its datasets in turns of their own and every
// text's claim in a cooperative step (market-p1.ts E10; plan 03 §1.2: the loop never blocks for more
// than one SQLite statement or one ≤ 20 ms CPU batch; changelog §R10 timing items: a cold call ran
// its dataset reads, its claim extraction and its assembly in one turn of 76 ms of CPU on the owner's
// Mac). Counted, never timed: every rules_v1 read of the call (a clause, an item, a text) runs inside
// a cooperative step; no step reads more than STEP_CHARS of text — a fixed ceiling, one outlook's
// cap — while the call reads many times that; and each bulk dataset read sits in a loop turn with no
// other bulk read and no claim read. The tool on league-a under EFF_TOOLSET=full with the news reader
// injected (eight items, multi-player ones among them); no network.
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as Claims from "../../src/domain/evidence/claims.js";
import type * as Cooperative from "../../src/domain/analytics/cooperative.js";
import type { DatasetStamp, NewsItem } from "../../src/domain/analytics/types.js";
import { wrapUntrusted } from "../../src/mcp/envelope.js";
import type { McpServices } from "../../src/mcp/services.js";
import { call, connect, makeWorld, type World } from "./helpers/world.js";

/** The most text one cooperative step may read for claims: a literal — one ESPN outlook's cap. */
const STEP_CHARS = 1200;

/** What the claim reads and the steps saw (shared with the module mocks, hoisted above them). */
const probe = vi.hoisted(() => ({
  on: false,
  /** Text read for claims in the step that is running; null between steps. */
  open: null as number | null,
  outside: 0,
  steps: [] as number[],
  /** The loop turn of each claim read (the turn counter's), while on. */
  claimTurns: [] as number[],
  turn: () => 0,
}));

vi.mock("../../src/domain/evidence/claims.js", async (importOriginal) => {
  const m = await importOriginal<typeof Claims>();
  const seen = (t: unknown): void => {
    if (!probe.on) return;
    const n = typeof t === "string" ? t.length : 0;
    if (probe.open === null) probe.outside += n;
    else probe.open += n;
    probe.claimTurns.push(probe.turn());
  };
  return {
    ...m,
    claimHit: (...a: Parameters<typeof m.claimHit>) => {
      seen(a[0]);
      return m.claimHit(...a);
    },
    extractClaim: (...a: Parameters<typeof m.extractClaim>) => {
      seen(a[0]);
      return m.extractClaim(...a);
    },
  };
});
vi.mock("../../src/domain/analytics/cooperative.js", async (importOriginal) => {
  const m = await importOriginal<typeof Cooperative>();
  return {
    ...m,
    runCooperative: (
      units: number,
      step: (i: number) => void,
      opts: Cooperative.CooperativeOptions,
    ) =>
      m.runCooperative(
        units,
        (i) => {
          const outer = probe.open;
          probe.open = 0;
          try {
            step(i);
          } finally {
            if (probe.on) probe.steps.push(probe.open);
            probe.open = outer;
          }
        },
        opts,
      ),
  };
});

/** One increment per event-loop iteration (an immediate queued inside an immediate runs next turn). */
function turnCounter(): { now: () => number; stop: () => void } {
  let turn = 0;
  let on = true;
  const tick = (): void => {
    turn += 1;
    if (on) setImmediate(tick);
  };
  setImmediate(tick);
  return {
    now: () => turn,
    stop: () => {
      on = false;
    },
  };
}

let world: World;
let client: Client;
let close: () => Promise<void>;
let subject: { id: number; name: string; gsis: string };
let mate: { name: string; gsis: string };

beforeAll(async () => {
  world = await makeWorld({ publishNflverse: true, env: { EFF_TOOLSET: "full" } });
  ({ client, close } = await connect(world, { options: { toolset: "full" } }));
  await call(client, "espn_get_league");
  const pool = await call(client, "espn_list_players", { status: "ONTEAM", limit: 100 });
  const rows = (
    pool.body.data as {
      players: { player_id: number; name: string; gsis_id: string | null; injury_status: string }[];
    }
  ).players;
  const pick = rows.find((r) => r.gsis_id !== null && r.player_id > 0);
  const other = rows.find(
    (r) =>
      r.gsis_id !== null &&
      r.player_id > 0 &&
      r.player_id !== pick?.player_id &&
      r.name.split(" ").at(-1) !== pick?.name.split(" ").at(-1),
  );
  if (pick?.gsis_id == null || other?.gsis_id == null) throw new Error("no crosswalked players");
  subject = { id: pick.player_id, name: pick.name, gsis: pick.gsis_id };
  mate = { name: other.name, gsis: other.gsis_id };
}, 180_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

/** The dataset reads that load a file's rows in bulk (each one a turn of its own). */
const BULK = new Set([
  "datasets.injuries.reports",
  "datasets.playerWeeks.lines",
  "datasets.epWeekly.rows",
  "datasets.proSchedule.games",
  "datasets.proSchedule.teams",
  "datasets.news.recent",
  "playerUniverse.all",
  "rosterWeekly.latest",
]);

/** `obj` with every method recording `name.method` and the loop turn it ran in. */
function recorded<T extends object>(
  obj: T,
  name: string,
  log: { read: string; turn: number }[],
): T {
  return new Proxy(obj, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r) as unknown;
      if (typeof v !== "function" || typeof p !== "string") return v;
      return (...a: unknown[]) => {
        if (probe.on) log.push({ read: `${name}.${p}`, turn: probe.turn() });
        return (v as (...x: unknown[]) => unknown).apply(t, a);
      };
    },
  });
}

describe("E10's slices: turns for the reads, a cooperative step per text (counted)", () => {
  it("every claim read inside a step, none past STEP_CHARS; each bulk read alone in its turn", async () => {
    const at = world.clock.nowIso();
    const stamp = {
      source: "news:rotowire",
      as_of: at,
      fetched_at: at,
      checked_at: at,
      freshness_class: "news",
      file_version: "test",
    } as unknown as DatasetStamp;
    const surname = subject.name.split(" ").at(-1) ?? subject.name;
    const long = (k: number): string =>
      `${subject.name} was limited in practice on day ${String(k)}. ${"He is expected to play through it. ".repeat(10)}`;
    const items: NewsItem[] = Array.from({ length: 8 }, (_, k) => ({
      id: String(k).repeat(32).slice(0, 32),
      source: "rotowire",
      published_at: at,
      url: wrapUntrusted("https://www.rotowire.com/x", "rss.rotowire.url"),
      title: wrapUntrusted(
        k % 2 === 0
          ? `${subject.name} (ankle) questionable for Sunday`
          : `${mate.name} ruled out; ${surname} to start`,
        "rss.rotowire.title",
      ),
      blurb: wrapUntrusted(long(k), "rss.rotowire.blurb"),
      gsis_ids: k % 2 === 0 ? [subject.gsis] : [subject.gsis, mate.gsis],
    }));
    const log: { read: string; turn: number }[] = [];
    const ds = world.services.datasets;
    const datasets = Object.fromEntries(
      Object.entries({ ...ds, news: { recent: () => ({ rows: items, stamp }) } }).map(([k, v]) => [
        k,
        recorded(v as object, `datasets.${k}`, log),
      ]),
    ) as unknown as McpServices["datasets"];
    const services: Partial<McpServices> = {
      datasets,
      playerUniverse: recorded(world.services.playerUniverse, "playerUniverse", log),
      rosterWeekly: recorded(world.services.rosterWeekly, "rosterWeekly", log),
    };
    const c = await connect(world, { options: { toolset: "full" }, services });
    const turns = turnCounter();
    Object.assign(probe, { on: true, outside: 0, steps: [], claimTurns: [], turn: turns.now });
    let r: Awaited<ReturnType<typeof call>>;
    try {
      r = await call(c.client, "espn_analyze_evidence", { player: { player_ids: [subject.id] } });
    } finally {
      probe.on = false;
      turns.stop();
      await c.close();
    }
    expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
    // every claim read of the call ran in a cooperative step, none past the ceiling
    expect(probe.outside).toBe(0);
    expect(probe.steps.length).toBeGreaterThan(8);
    expect(Math.max(...probe.steps)).toBeLessThanOrEqual(STEP_CHARS);
    // the split is not vacuous: the call read many steps' worth of text
    expect(probe.steps.reduce((a, b) => a + b, 0)).toBeGreaterThan(2 * STEP_CHARS);
    // each bulk read alone in its turn: no other bulk read and no claim read beside it
    const bulk = log.filter((x) => BULK.has(x.read));
    expect(bulk.map((x) => x.read)).toEqual(
      expect.arrayContaining([
        "datasets.playerWeeks.lines",
        "playerUniverse.all",
        "rosterWeekly.latest",
        "datasets.news.recent",
      ]),
    );
    for (const b of bulk) {
      const beside = bulk.filter((x) => x !== b && x.turn === b.turn).map((x) => x.read);
      expect(beside, `${b.read} shares turn ${String(b.turn)}`).toEqual([]);
      expect(
        probe.claimTurns.filter((t) => t === b.turn),
        b.read,
      ).toEqual([]);
    }
  }, 120_000);
});
