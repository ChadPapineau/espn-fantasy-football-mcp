// evidence-scope.test.ts — espn_analyze_evidence reads a news item's claims only about the player the
// claim names (plan 07 E10; plan 10 C8: the logged claims calibrate each source's reliability).
// Stage C finding evidence-item-claims-misattributed: E10 loaded every item whose refs held the
// subject and passed its WHOLE title and blurb as texts about him; the matcher attaches one item to
// every player it names, so the commonest injury headline — "<starter> (ankle) ruled out; <the
// subject> to start" — gave a healthy subject availability_conflict and logged an 'out' claim against
// him that the retrospective would score "not borne out", lowering the source's measured reliability.
// Attempt 1 read only the clauses naming the subject, which held for that exact headline alone: a
// comma, "and", "with … out" or "so" kept the teammate's claim in a clause that also named him, and
// an item whose other player had no gsis pair was read as his. Now an item naming other players (any
// ref) is read only in the parts naming him ALONE — a clause naming another splits into phrases, each
// kept only when it names him and nobody else — and an item whose other players cannot be named is
// not read for him at all. Units, then the tool on league-a under EFF_TOOLSET=full with the news
// reader injected and the claim log observed (no network).
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatasetStamp, NewsItem } from "../../src/domain/analytics/types.js";
import { extractClaim } from "../../src/domain/evidence/index.js";
import { wrapUntrusted } from "../../src/mcp/envelope.js";
import type { McpServices } from "../../src/mcp/services.js";
import { nameKeysOf, partsAbout, type NameKeys } from "../../src/mcp/tools/market-p1.js";
import { call, connect, makeWorld, SEASON, type World } from "./helpers/world.js";

describe("partsAbout (Stage C evidence-item-claims-misattributed)", () => {
  const t = (v: string) => wrapUntrusted(v, "rss.rotowire.title");
  const keys = (n: string): NameKeys => {
    const k = nameKeysOf(n);
    if (k === null) throw new Error(n);
    return k;
  };
  const him = keys("Malik Ostrander");
  const quist = [keys("Dorian Quist")];
  const about = (v: string, others: readonly NameKeys[] = quist) =>
    partsAbout(t(v), him, others)?.untrusted_text.value ?? null;

  it("keeps the clauses naming him alone, under the original source; none → null", () => {
    const got = partsAbout(
      t("Bengals' Dorian Quist (ankle) ruled out; Malik Ostrander to start"),
      him,
      quist,
    );
    expect(got?.untrusted_text.value).toBe("Malik Ostrander to start");
    expect(got?.untrusted_text.source).toBe("rss.rotowire.title");
    expect(about("Quist will not play.")).toBeNull();
    expect(about("He will not play.")).toBeNull();
    expect(about("Quist is out. Ostrander gets the start — Quist sits")).toBe(
      "Ostrander gets the start",
    );
  });

  it("a clause naming both splits into phrases; only a phrase naming him alone is kept", () => {
    expect(about("Quist (ankle) ruled out for Sunday, Ostrander to start")).toBe(
      "Ostrander to start",
    );
    expect(about("Quist (ankle) ruled out and Ostrander to start")).toBe("Ostrander to start");
    expect(about("Quist will not play Sunday, so Ostrander draws the start.")).toBe(
      "so Ostrander draws the start.",
    );
    expect(about("Ostrander starts with Quist's ankle injury ruling him out")).toBe(
      "Ostrander starts",
    );
    // no phrase is his alone: nothing is read
    expect(about("With Quist ruled out Sunday Ostrander gets the start")).toBeNull();
    expect(about("Ostrander replaces the injured Quist")).toBeNull();
    // his own phrase still reads as his (the claim is kept)
    expect(about("Quist to start, Ostrander (ankle) ruled out for Sunday")).toBe(
      "Ostrander (ankle) ruled out for Sunday",
    );
    // pieces are joined so no claim pattern straddles two of them
    const joined = about("Ostrander is, Quist says, out Ostrander-style");
    expect(joined).toBe("Ostrander is; out Ostrander-style");
    expect(extractClaim(joined)).toBeNull();
    expect(extractClaim("Ostrander is out Ostrander-style")?.designation).toBe("out");
  });

  it("a period after an initial or a name suffix ends no clause (the claim keeps its name)", () => {
    const pitts = [keys("Kyle Pitts Sr.")];
    expect(
      partsAbout(t("Kyle Pitts Sr. (ankle) ruled out, Ostrander to start"), him, pitts)
        ?.untrusted_text.value,
    ).toBe("Ostrander to start");
    expect(
      partsAbout(t("D.J. Quist ruled out. Ostrander to start."), him, quist)?.untrusted_text.value,
    ).toBe("Ostrander to start.");
    expect(about("Quist is out. Ostrander starts.")).toBe("Ostrander starts.");
  });

  it("another player named by his first name only still counts (not a shared or a word-like one)", () => {
    expect(about("Ostrander starts in place of Dorian, who is out")).toBeNull();
    expect(about("Ostrander starts in place of Dorian")).toBeNull();
    // the subject's own first name, shared with the other player, names nobody else
    const josh = keys("Josh Ostrander");
    const jacobs = [keys("Josh Jacobs")];
    expect(
      partsAbout(t("Josh Ostrander (ankle) ruled out"), josh, jacobs)?.untrusted_text.value,
    ).toBe("Josh Ostrander (ankle) ruled out");
    // a first name that is an English word too is no key ("will" is in every other clause)
    expect(nameKeysOf("Will Quist")?.given).toBeNull();
    expect(
      partsAbout(t("Ostrander will start"), him, [keys("Will Quist")])?.untrusted_text.value,
    ).toBe("Ostrander will start");
  });

  it("names are read as the matcher folds them: possessive, hyphen, spacing, suffix, case", () => {
    const jsn = keys("Jaxon Smith-Njigba");
    expect(nameKeysOf("James Cook III")).toEqual({
      surname: "cook",
      whole: "jamescook",
      given: "james",
      tokens: ["james", "cook"],
    });
    expect(
      partsAbout(t("SMITH NJIGBA OUT, Ostrander to start"), him, [jsn])?.untrusted_text.value,
    ).toBe("Ostrander to start");
    expect(
      partsAbout(t("Smith-Njigba's ankle; Ostrander's day"), him, [jsn])?.untrusted_text.value,
    ).toBe("Ostrander's day");
    expect(partsAbout(t("Quist/Ostrander ruled out"), him, quist)).toBeNull();
    expect(nameKeysOf("X")).toBeNull();
    expect(nameKeysOf("Игорь Петров")).toBeNull();
  });
});

let world: World;
let client: Client;
let close: () => Promise<void>;
let subject: { id: number; name: string; gsis: string };
/** A second crosswalked player (the teammate a multi-player item also names). */
let other: { id: number; name: string; gsis: string };

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
  const surnameOf = (n: string) => n.split(" ").at(-1) ?? n;
  const mate = rows.find(
    (r) =>
      r.gsis_id !== null &&
      r.player_id > 0 &&
      r.player_id !== pick.player_id &&
      surnameOf(r.name) !== surnameOf(pick.name),
  );
  const mateGsis = mate?.gsis_id ?? null;
  if (mate === undefined || mateGsis === null) throw new Error("no second crosswalked player");
  other = { id: mate.player_id, name: mate.name, gsis: mateGsis };
}, 180_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

/** The claims E10 logged during one call (`log` wrapped: the repository is idempotent per key). */
let logged: { type: string; signal: string; player_id: number }[] = [];

/** The services with the news reader answering one item (fresh) and the claim log observed. */
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
  const repo = world.store.repos.scoredClaims;
  return {
    ...world.services,
    datasets: {
      ...world.services.datasets,
      news: { recent: () => ({ rows: [row], stamp }) },
    },
    scoredClaims: {
      pending: (l, s, w) => repo.pending(l, s, w),
      score: (k, o, t) => repo.score(k, o, t),
      scored: (l, n) => repo.scored(l, n),
      log: (l, c, t) => {
        logged.push({ type: c.claim.type, signal: c.claim.signal, player_id: c.player_id });
        return repo.log(l, c, t);
      },
    },
  };
}

async function evidence(
  services: McpServices,
): Promise<{ flag: string; claims: string[]; warnings: string[] }> {
  const c = await connect(world, { options: { toolset: "full" }, services });
  logged = [];
  try {
    const r = await call(c.client, "espn_analyze_evidence", {
      player: { player_ids: [subject.id] },
    });
    expect(r.isError, JSON.stringify(r.body).slice(0, 400)).toBe(false);
    return {
      flag: (r.body.data as { flag: string }).flag,
      // this call's logged claims (every one is about the subject: E10 logs only for him)
      claims: logged.map((x) => {
        expect(x.player_id).toBe(subject.id);
        return `${x.type}:${x.signal}`;
      }),
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
    // its other player's name cannot be read (no crosswalk pair): not read for him at all
    expect(got.warnings).toContain(
      "1 news item(s) also name other players: only their parts naming this player alone are read (1 with none, or whose other players cannot be named, skipped)",
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

// Attempt 2 (the verifier: the clause fix held only for the exact repro). A teammate's claim and the
// subject's name in ONE clause — a comma, "and", "after", "so" — was still read as his; and an item
// whose other player has no gsis pair (named by ESPN id only in its refs) was read as his alone.
describe("E10 on a multi-player item: the wording does not move a teammate's claim onto him", () => {
  const T = (s: string) => wrapUntrusted(s, "rss.rotowire.title");
  const B = (s: string) => wrapUntrusted(s, "rss.rotowire.blurb");
  const variants: readonly [string, (s: string, o: string) => [string, string]][] = [
    ["a comma", (s, o) => [`${o} (ankle) ruled out for Sunday, ${s} to start`, ""]],
    ["'and'", (s, o) => [`${o} (ankle) ruled out and ${s} to start`, ""]],
    ["one clause", (s, o) => [`With ${o} ruled out Sunday ${s} gets the start`, ""]],
    [
      "the blurb",
      (s, o) => [`Injury update`, `${o} will not play Sunday, so ${s} draws the start.`],
    ],
    ["a possessive", (s, o) => [`${s} starts with ${o}'s ankle injury ruling him out`, ""]],
  ];
  /** The claims that would move his availability or health (a role claim of his own may stand). */
  const health = (claims: readonly string[]) =>
    claims.filter((c) => c.startsWith("availability:") || c.startsWith("health:"));
  it.each(variants)(
    "%s",
    async (_label, make) => {
      const [title, blurb] = make(subject.name, other.name);
      const got = await evidence(
        withNews({ title: T(title), blurb: B(blurb), gsis_ids: [subject.gsis, other.gsis] }),
      );
      expect(got.flag, title).not.toBe("availability_conflict");
      expect(health(got.claims), title).toEqual([]);
    },
    60_000,
  );

  it("the other player named only by his ESPN id in the item's refs (no gsis pair)", async () => {
    const item = {
      title: T(`${other.name} (ankle) ruled out, ${subject.name} to start`),
      blurb: B(""),
      gsis_ids: [subject.gsis],
      refs: [
        { espn_id: subject.id, gsis_id: subject.gsis, match_confidence: 0.95 },
        { espn_id: other.id, gsis_id: null, match_confidence: 0.95 },
      ],
    };
    const got = await evidence(withNews(item));
    expect(got.flag).not.toBe("availability_conflict");
    expect(health(got.claims)).toEqual([]);
  }, 60_000);

  it("a teammate the matcher did not ref (his surname alone, no team named) counts too", async () => {
    // a real NFL teammate of the subject from the local player index; the item refs the subject only
    const index = world.services.playerUniverse.all(SEASON).rows;
    const team = index.find((r) => r.espn_id === subject.id)?.pro_team_id ?? 0;
    const surname = (n: string) => n.split(" ").at(-1) ?? n;
    const mate = index.find(
      (r) =>
        r.pro_team_id === team &&
        r.espn_id > 0 &&
        r.espn_id !== subject.id &&
        surname(r.full_name) !== surname(subject.name) &&
        /^[A-Z][a-z]{3,}$/.test(surname(r.full_name)),
    );
    expect(team).toBeGreaterThan(0);
    if (mate === undefined) throw new Error("no teammate in the index");
    const got = await evidence(
      withNews({
        title: T(`${surname(mate.full_name)} (ankle) ruled out; ${subject.name} to start`),
        blurb: B(`${surname(mate.full_name)} will not play.`),
        gsis_ids: [subject.gsis],
      }),
    );
    expect(got.flag).not.toBe("availability_conflict");
    expect(health(got.claims)).toEqual([]);
  }, 60_000);

  it("an item whose other player's name cannot be read is not read for him at all", async () => {
    const got = await evidence(
      withNews({
        title: T(`Quist (ankle) ruled out, ${subject.name} to start`),
        blurb: B(""),
        gsis_ids: [subject.gsis, "00-0099998"],
      }),
    );
    expect(got.flag).not.toBe("availability_conflict");
    expect(got.claims).toEqual([]);
  }, 60_000);

  it.each([
    [
      "his own clause",
      (s: string, o: string) => `${o} to start; ${s} (ankle) ruled out for Sunday`,
    ],
    [
      "his own phrase",
      (s: string, o: string) => `${o} to start, ${s} (ankle) ruled out for Sunday`,
    ],
  ])(
    "control — %s in a multi-player item is still his claim",
    async (_label, make) => {
      const got = await evidence(
        withNews({
          title: T(make(subject.name, other.name)),
          blurb: B(""),
          gsis_ids: [subject.gsis, other.gsis],
        }),
      );
      expect(got.flag).toBe("availability_conflict");
      expect(got.claims).toContain("availability:out");
    },
    60_000,
  );
});
