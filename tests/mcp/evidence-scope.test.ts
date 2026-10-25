// evidence-scope.test.ts — espn_analyze_evidence reads a claim of a news item or an outlook as the
// subject's only when it is about him (plan 07 E10; plan 10 C8: the logged claims calibrate each
// source's reliability). Stage C finding evidence-item-claims-misattributed: E10 loaded every item
// whose refs held the subject and passed its WHOLE title and blurb as texts about him; the matcher
// attaches one item to every player it names, so the commonest injury headline — "<starter> (ankle)
// ruled out; <the subject> to start" — gave a healthy subject availability_conflict and logged an
// 'out' claim against him that the retrospective would score "not borne out". Three rounds of smarter
// parsing each left a wording that still carried the teammate's claim onto him (a comma, a pronoun, a
// noun phrase). Ruling R7-4 (fail safe): in a text that names more than one player a claim is his
// only where its clause opens with his name, states the claim of him directly and names no other
// player (src/domain/evidence/attribution.ts, held word by word in
// tests/domain/evidence/attribution.test.ts); every other claim is listed under
// `ambiguous_multi_player`, wrapped, and is never logged, scored or weighed as his. The tool on
// league-a under EFF_TOOLSET=full with the news reader (and the outlook, the weekly roster) injected
// and the claim log observed; no network.
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatasetStamp, NewsItem } from "../../src/domain/analytics/types.js";
import type { NflRosterPlayer } from "../../src/domain/crosswalk/types.js";
import { wrapUntrusted } from "../../src/mcp/envelope.js";
import type { McpServices } from "../../src/mcp/services.js";
import { MULTI_PLAYER_RULE } from "../../src/mcp/tools/market-p1.js";
import { envelopeViolations } from "./helpers/walk.js";
import { call, connect, makeWorld, SEASON, type World } from "./helpers/world.js";

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

interface Ambiguous {
  source: string;
  claim: { untrusted_text: { value: string; source: string } };
  type: string;
  direction: string;
}

async function evidence(services: McpServices): Promise<{
  flag: string;
  claims: string[];
  warnings: string[];
  evidence: { source: string; type: string; claim: { untrusted_text: { value: string } } }[];
  ambiguous: Ambiguous[];
}> {
  const c = await connect(world, { options: { toolset: "full" }, services });
  logged = [];
  try {
    const r = await call(c.client, "espn_analyze_evidence", {
      player: { player_ids: [subject.id] },
    });
    expect(r.isError, JSON.stringify(r.body).slice(0, 400)).toBe(false);
    // every third-party string of the answer is wrapped or listed (the A6 walk), the label's too
    expect(envelopeViolations(r.body as never)).toEqual([]);
    const data = r.body.data as {
      flag: string;
      evidence: { source: string; type: string; claim: { untrusted_text: { value: string } } }[];
      ambiguous_multi_player: Ambiguous[];
    };
    return {
      flag: data.flag,
      // this call's logged claims (every one is about the subject: E10 logs only for him)
      claims: logged.map((x) => {
        expect(x.player_id).toBe(subject.id);
        return `${x.type}:${x.signal}`;
      }),
      warnings: r.body.warnings as string[],
      evidence: data.evidence,
      ambiguous: data.ambiguous_multi_player,
    };
  } finally {
    await c.close();
  }
}

const T = (s: string) => wrapUntrusted(s, "rss.rotowire.title");
const B = (s: string) => wrapUntrusted(s, "rss.rotowire.blurb");
const surname = (n: string) => n.split(" ").at(-1) ?? n;
/** The claims that would move his availability or health (a role claim of his own may stand). */
const health = (claims: readonly string[]) =>
  claims.filter((c) => c.startsWith("availability:") || c.startsWith("health:"));
/** His news evidence items (the fixture's own ESPN outlook is an item of his too). */
const newsItems = (e: Awaited<ReturnType<typeof evidence>>["evidence"]) =>
  e.filter((x) => x.source.startsWith("rss."));
/** The evidence items (his) that carry an availability or health claim. */
const healthItems = (e: Awaited<ReturnType<typeof evidence>>["evidence"]) =>
  e.filter((x) => x.type === "availability" || x.type === "health");

describe("E10 on a multi-player item (the tool)", () => {
  it("a teammate's 'ruled out' is no claim about him: no conflict, nothing logged — listed ambiguous", async () => {
    const got = await evidence(
      withNews({
        title: T(`Teammate Quist (ankle) ruled out for Sunday; ${surname(subject.name)} to start`),
        blurb: B("Quist will not play."),
        gsis_ids: [subject.gsis, "00-0099998"],
      }),
    );
    expect(got.flag).not.toBe("availability_conflict");
    expect(got.claims).toEqual([]);
    expect(newsItems(got.evidence)).toEqual([]);
    // its other player's name cannot be read (no crosswalk pair): nothing in it is tied to him —
    // every claim of it is shown, wrapped under its own source, under the label
    expect(got.ambiguous.map((a) => [a.source, a.claim.untrusted_text.value, a.type])).toEqual([
      ["rss.rotowire.title", "Teammate Quist (ankle) ruled out for Sunday;", "availability"],
      ["rss.rotowire.title", `${surname(subject.name)} to start`, "role"],
      ["rss.rotowire.blurb", "Quist will not play.", "availability"],
    ]);
    for (const a of got.ambiguous) expect(a.claim.untrusted_text.source).toBe(a.source);
    expect(got.warnings).toContain(`1 news item(s) also name other players: ${MULTI_PLAYER_RULE}`);
  }, 60_000);

  it("control: the same words about him alone are his claim (availability_conflict, logged)", async () => {
    const got = await evidence(
      withNews({
        title: T(`${subject.name} (ankle) ruled out for Sunday`),
        blurb: B("He will not play."),
        gsis_ids: [subject.gsis],
      }),
    );
    expect(got.flag).toBe("availability_conflict");
    expect(got.claims).toContain("availability:out");
    expect(got.ambiguous).toEqual([]);
  }, 60_000);
});

// Every wording the three verification rounds produced, through the tool: two crosswalked refs, the
// teammate's claim in the subject's clause (a comma, "and", one clause, "so", a possessive), the
// teammate as a pronoun (round 2), the teammate as a noun phrase in the subject's own phrase (round 3).
describe("E10 on a multi-player item: no wording moves a teammate's claim onto him", () => {
  // [label, the item, whether the teammate's part carries a status claim of its own to list]
  const variants: readonly [string, (s: string, o: string) => [string, string], boolean?][] = [
    ["a comma", (s, o) => [`${o} (ankle) ruled out for Sunday, ${s} to start`, ""]],
    ["'and'", (s, o) => [`${o} (ankle) ruled out and ${s} to start`, ""]],
    ["one clause", (s, o) => [`With ${o} ruled out Sunday ${s} gets the start`, ""]],
    [
      "the blurb",
      (s, o) => [`Injury update`, `${o} will not play Sunday, so ${s} draws the start.`],
    ],
    ["a possessive", (s, o) => [`${s} starts with ${o}'s ankle injury ruling him out`, ""]],
    // round 2: the teammate is a pronoun in the subject's own clause
    [
      "'with him sidelined'",
      (s, o) => [
        `${surname(s)} in line for start`,
        `${o} (ankle) was ruled out for Sunday's game against the opponent. With him sidelined, ${s} figures to start.`,
      ],
    ],
    [
      "'if he is ruled out'",
      (s, o) => [`${o} limited at practice; if he is ruled out, ${s} would start`, ""],
    ],
    [
      "'now that he is sidelined'",
      (s, o) => [`${o} was ruled out. ${s} steps in now that he is sidelined.`, ""],
    ],
    [
      "A3 'will start with him sidelined'",
      (s, o) => [`${o} (ankle) won't play Sunday`, `${surname(s)} will start with him sidelined.`],
    ],
    [
      "A5 'because he was placed on IR'",
      (s, o) => [
        `${o} (knee) hurt Sunday`,
        `${surname(s)} will start because he was placed on injured reserve.`,
      ],
      // "hurt" is no rule: the teammate's part has no claim to list
      false,
    ],
    // round 3: the teammate is a noun phrase in the subject's own phrase
    [
      "T1 'steps in for the sidelined starter'",
      (s, o) => [
        `${o} (ankle) ruled out for Sunday`,
        `${surname(s)} steps in for the sidelined starter.`,
      ],
    ],
    [
      "T2 'takes over for the ruled out lead back'",
      (s, o) => [
        `${o} (ankle) won't play Sunday`,
        `${surname(s)} takes over for the ruled out lead back.`,
      ],
    ],
    [
      "T3 'replaces the back who was ruled out'",
      (s, o) => [
        `${o} (ankle) limited Thursday`,
        `${surname(s)} replaces the back who was ruled out.`,
      ],
    ],
    [
      "T4 'starts for the starter placed on injured reserve'",
      (s, o) => [
        `${o} (knee) hurt Sunday`,
        `${surname(s)} starts for the starter placed on injured reserve.`,
      ],
    ],
    [
      "T5 title only",
      (s, o) => [`${surname(o)} (ankle) out; ${surname(s)} replaces sidelined veteran`, ""],
    ],
    [
      "the pipeline's noun blurb",
      (s, o) => [
        `${o}: Ruled out for Week 5`,
        `${surname(o)} (ankle) was ruled out for Sunday's game against the opponent. ${s} steps in for the sidelined starter.`,
      ],
    ],
    [
      "the pipeline's noun title",
      (s, o) => [`${o} won't play Sunday; ${s} takes over for the ruled out veteran`, ""],
    ],
  ];
  it.each(variants)(
    "%s",
    async (_label, make, listed = true) => {
      const [title, blurb] = make(subject.name, other.name);
      const got = await evidence(
        withNews({ title: T(title), blurb: B(blurb), gsis_ids: [subject.gsis, other.gsis] }),
      );
      expect(got.flag, title).not.toBe("availability_conflict");
      expect(health(got.claims), title).toEqual([]);
      expect(healthItems(got.evidence), title).toEqual([]);
      // the teammate's status claim is shown, under the label
      expect(
        got.ambiguous.some((a) => a.type === "availability" || a.type === "health"),
        title,
      ).toBe(listed);
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
    expect(got.ambiguous.length).toBeGreaterThan(0);
  }, 60_000);

  /** A real NFL teammate of the subject from the local player index, by surname. */
  function teammate(): string {
    const index = world.services.playerUniverse.all(SEASON).rows;
    const team = index.find((r) => r.espn_id === subject.id)?.pro_team_id ?? 0;
    expect(team).toBeGreaterThan(0);
    const mate = index.find(
      (r) =>
        r.pro_team_id === team &&
        r.espn_id > 0 &&
        r.espn_id !== subject.id &&
        surname(r.full_name) !== surname(subject.name) &&
        /^[A-Z][a-z]{3,}$/.test(surname(r.full_name)),
    );
    if (mate === undefined) throw new Error("no teammate in the index");
    return surname(mate.full_name);
  }

  it("a teammate the matcher did not ref (his surname alone, no team named) counts too", async () => {
    const m = teammate();
    const got = await evidence(
      withNews({
        title: T(`${m} (ankle) ruled out; ${subject.name} to start`),
        blurb: B(`${m} will not play.`),
        gsis_ids: [subject.gsis],
      }),
    );
    expect(got.flag).not.toBe("availability_conflict");
    expect(health(got.claims)).toEqual([]);
    // his own clause stays his (the role claim), the teammate's are listed
    expect(got.claims).toEqual(["role:up"]);
    expect(got.ambiguous.map((a) => a.claim.untrusted_text.value)).toEqual([
      `${m} (ankle) ruled out;`,
      `${m} will not play.`,
    ]);
  }, 60_000);

  it("B1: a teammate outside ESPN's index (a lineman on the weekly roster) counts too", async () => {
    // the subject's NFL team as nflverse spells it, and a lineman of that team on its weekly roster
    const own = world.services.rosterWeekly.byEspnId(subject.id).rows[0];
    if (own === undefined) throw new Error("the subject has no weekly-roster row");
    const real = world.services.rosterWeekly;
    const lineman: NflRosterPlayer = {
      gsis_id: "00-0099997",
      season: SEASON,
      week: own.week,
      full_name: "Orlando Fenwick",
      team: own.team,
      position: "T",
      jersey_number: 71,
      espn_id: null,
      sleeper_id: null,
      status: "ACT",
    };
    const base = withNews({
      title: T(`${surname(subject.name)} faces tougher sledding`),
      blurb: B(
        `Left tackle Orlando Fenwick (knee) was ruled out, so ${surname(subject.name)} may see stacked boxes.`,
      ),
      gsis_ids: [subject.gsis],
    });
    const services: McpServices = {
      ...base,
      rosterWeekly: {
        latest: (season) => {
          const r = real.latest(season);
          return { ...r, rows: [...r.rows, lineman] };
        },
        byEspnId: (id) => real.byEspnId(id),
      },
    };
    const got = await evidence(services);
    expect(got.flag).not.toBe("availability_conflict");
    expect(health(got.claims)).toEqual([]);
    expect(got.ambiguous.map((a) => a.claim.untrusted_text.value)).toEqual([
      `Left tackle Orlando Fenwick (knee) was ruled out, so ${surname(subject.name)} may see stacked boxes.`,
    ]);
    // control: without the roster row the item names no other player, so it is read whole as his
    const bare = await evidence(base);
    expect(bare.flag).toBe("availability_conflict");
  }, 60_000);

  it("his own ESPN outlook naming a teammate: the teammate's claim is not his (the control is)", async () => {
    const outlook = (text: string): McpServices => {
      const base = withNews({ title: T("League notes"), blurb: B(""), gsis_ids: [] });
      const inner = base.platform;
      const platform = new Proxy(inner, {
        get(target, key) {
          if (key === "getPlayerOutlooks")
            return async (...a: Parameters<typeof inner.getPlayerOutlooks>) => {
              const got = await target.getPlayerOutlooks(...a);
              const week = String(a[2][0]);
              return {
                ...got,
                value: [
                  {
                    player: { platform: "espn", id: subject.id },
                    season: null,
                    weekly: { [week]: wrapUntrusted(text, "espn.player.outlook") },
                  },
                ],
              };
            };
          const v: unknown = Reflect.get(target, key);
          return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(target) : v;
        },
      });
      return { ...base, platform };
    };
    const m = teammate();
    const s = surname(subject.name);
    for (const text of [
      `With ${m} sidelined, ${s} should see more work.`,
      // round 2: the teammate as a pronoun in the outlook's sentence about him
      `${m} (ankle) is out for the week. With him sidelined, ${s} should see more work.`,
      `${m} was ruled out. ${s} steps in now that he is sidelined.`,
      // round 3: the teammate as a noun phrase in the subject's own sentence
      `${m} (ankle) is out for the week. ${s} replaces the sidelined veteran.`,
      `${m} was ruled out. ${s} fills in for the ruled out starter.`,
    ]) {
      const got = await evidence(outlook(text));
      expect(got.flag, text).not.toBe("availability_conflict");
      expect(health(got.claims), text).toEqual([]);
      expect(got.ambiguous.length, text).toBeGreaterThan(0);
      for (const a of got.ambiguous) expect(a.source, text).toBe("espn.player.outlook");
      expect(got.warnings, text).toContain(
        `1 ESPN outlook text(s) also name other players: ${MULTI_PLAYER_RULE}`,
      );
    }
    // control: the same claim about him alone is his
    const own = await evidence(outlook(`${s} was ruled out for Sunday.`));
    expect(own.flag).toBe("availability_conflict");
    expect(own.ambiguous).toEqual([]);
  }, 120_000);

  it("an item whose other player's name cannot be read ties nothing to him", async () => {
    const got = await evidence(
      withNews({
        title: T(`Quist (ankle) ruled out, ${subject.name} to start`),
        blurb: B(""),
        gsis_ids: [subject.gsis, "00-0099998"],
      }),
    );
    expect(got.flag).not.toBe("availability_conflict");
    expect(got.claims).toEqual([]);
    expect(got.ambiguous.map((a) => a.claim.untrusted_text.value)).toEqual([
      `Quist (ankle) ruled out, ${subject.name} to start`,
    ]);
  }, 60_000);

  it("control — his own clause in a multi-player item is still his claim", async () => {
    const got = await evidence(
      withNews({
        title: T(`${other.name} to start; ${subject.name} (ankle) ruled out for Sunday`),
        blurb: B(""),
        gsis_ids: [subject.gsis, other.gsis],
      }),
    );
    expect(got.flag).toBe("availability_conflict");
    expect(got.claims).toContain("availability:out");
    expect(newsItems(got.evidence).map((e) => e.claim.untrusted_text.value)).toEqual([
      `${subject.name} (ankle) ruled out for Sunday`,
    ]);
    expect(got.ambiguous.map((a) => a.claim.untrusted_text.value)).toEqual([
      `${other.name} to start;`,
    ]);
  }, 60_000);

  it("fail safe — his own claim in a clause that also names the other is not tied to him", async () => {
    // attempt 3 kept this as his ("his own phrase"); under R7-4 a clause naming another player is
    // never certain, so it is listed, never weighed
    const got = await evidence(
      withNews({
        title: T(`${other.name} to start, ${subject.name} (ankle) ruled out for Sunday`),
        blurb: B(""),
        gsis_ids: [subject.gsis, other.gsis],
      }),
    );
    expect(got.flag).not.toBe("availability_conflict");
    expect(got.claims).toEqual([]);
    expect(got.ambiguous.map((a) => a.claim.untrusted_text.value)).toEqual([
      `${other.name} to start, ${subject.name} (ankle) ruled out for Sunday`,
    ]);
  }, 60_000);
});
