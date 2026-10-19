// evidence-scope.test.ts — espn_analyze_evidence reads a news item's claims only about the player the
// claim names (plan 07 E10; plan 10 C8: the logged claims calibrate each source's reliability).
// Stage C finding evidence-item-claims-misattributed: E10 loaded every item whose refs held the
// subject and passed its WHOLE title and blurb as texts about him; the matcher attaches one item to
// every player it names, so the commonest injury headline — "<starter> (ankle) ruled out; <the
// subject> to start" — gave a healthy subject availability_conflict and logged an 'out' claim against
// him that the retrospective would score "not borne out", lowering the source's measured reliability.
// Now an item naming other players too is read only in the clauses that name the subject (units),
// and at the tool level on league-a under EFF_TOOLSET=full with the news reader injected (no network).
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatasetStamp, NewsItem } from "../../src/domain/analytics/types.js";
import { wrapUntrusted } from "../../src/mcp/envelope.js";
import type { McpServices } from "../../src/mcp/services.js";
import { clausesNaming } from "../../src/mcp/tools/market-p1.js";
import { call, connect, makeWorld, type World } from "./helpers/world.js";

describe("clausesNaming (Stage C evidence-item-claims-misattributed)", () => {
  const t = (v: string) => wrapUntrusted(v, "rss.rotowire.title");
  it("keeps the clauses naming him, under the original source; none → null", () => {
    const got = clausesNaming(
      t("Bengals' Dorian Quist (ankle) ruled out; Malik Ostrander to start"),
      "Malik Ostrander",
    );
    expect(got?.untrusted_text.value).toBe("Malik Ostrander to start");
    expect(got?.untrusted_text.source).toBe("rss.rotowire.title");
    expect(clausesNaming(t("Quist will not play."), "Malik Ostrander")).toBeNull();
    expect(
      clausesNaming(t("Quist is out. Ostrander gets the start — Quist sits"), "Malik Ostrander")
        ?.untrusted_text.value,
    ).toBe("Ostrander gets the start");
  });
});

let world: World;
let client: Client;
let close: () => Promise<void>;
let subject: { id: number; name: string; gsis: string };

beforeAll(async () => {
  world = await makeWorld({ publishNflverse: true, env: { EFF_TOOLSET: "full" } });
  ({ client, close } = await connect(world, { options: { toolset: "full" } }));
  await call(client, "espn_get_league");
  // a rostered player of the recorded pool page (E10 reads him by id through it)
  const pool = await call(client, "espn_list_players", { status: "ONTEAM", limit: 100 });
  const rows = (
    pool.body.data as {
      players: { player_id: number; name: string; gsis_id: string | null; injury_status: string }[];
    }
  ).players;
  const pick = rows.find(
    (r) => r.gsis_id !== null && r.injury_status === "ACTIVE" && r.player_id > 0,
  );
  const gsis = pick?.gsis_id ?? null;
  if (pick === undefined || gsis === null) throw new Error("no ACTIVE crosswalked player");
  subject = { id: pick.player_id, name: pick.name, gsis };
}, 180_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

/** The services with the news reader answering one item (fresh). */
function withNews(item: Omit<NewsItem, "id" | "source" | "published_at" | "url">): McpServices {
  const at = world.clock.nowIso();
  const stamp = {
    source: "news:rotowire",
    as_of: at,
    fetched_at: at,
    checked_at: at,
    freshness_class: "news",
    file_version: "test",
  } as unknown as DatasetStamp;
  const row: NewsItem = {
    id: "c".repeat(32),
    source: "rotowire",
    published_at: at,
    url: wrapUntrusted("https://www.rotowire.com/x", "rss.rotowire.url"),
    ...item,
  };
  return {
    ...world.services,
    datasets: {
      ...world.services.datasets,
      news: { recent: () => ({ rows: [row], stamp }) },
    },
  };
}

async function evidence(
  services: McpServices,
): Promise<{ flag: string; claims: string[]; warnings: string[] }> {
  const c = await connect(world, { options: { toolset: "full" }, services });
  try {
    const r = await call(c.client, "espn_analyze_evidence", {
      player: { player_ids: [subject.id] },
    });
    expect(r.isError, JSON.stringify(r.body).slice(0, 400)).toBe(false);
    const pending = world.store.repos.scoredClaims
      .pending(world.services.league.league_id, world.services.league.season, 4)
      .filter((p) => p.player_id === subject.id)
      .map((p) => `${p.claim.type}:${p.claim.signal}`);
    return {
      flag: (r.body.data as { flag: string }).flag,
      claims: pending,
      warnings: r.body.warnings as string[],
    };
  } finally {
    await c.close();
  }
}

describe("E10 on a multi-player item (the tool)", () => {
  it("a teammate's 'ruled out' is no claim about him: no availability_conflict, no 'out' logged", async () => {
    const surname = subject.name.split(" ").at(-1) ?? subject.name;
    const got = await evidence(
      withNews({
        title: wrapUntrusted(
          `Teammate Quist (ankle) ruled out for Sunday; ${surname} to start`,
          "rss.rotowire.title",
        ),
        blurb: wrapUntrusted("Quist will not play.", "rss.rotowire.blurb"),
        gsis_ids: [subject.gsis, "00-0099998"],
      }),
    );
    expect(got.flag).not.toBe("availability_conflict");
    expect(got.claims.filter((c) => c.endsWith(":out"))).toEqual([]);
    expect(got.warnings).toContain(
      "1 news item(s) also name other players: only their clauses naming this player are read",
    );
  }, 60_000);

  it("control: the same words about him alone are his claim (availability_conflict)", async () => {
    const got = await evidence(
      withNews({
        title: wrapUntrusted(`${subject.name} (ankle) ruled out for Sunday`, "rss.rotowire.title"),
        blurb: wrapUntrusted("He will not play.", "rss.rotowire.blurb"),
        gsis_ids: [subject.gsis],
      }),
    );
    expect(got.flag).toBe("availability_conflict");
  }, 60_000);
});
