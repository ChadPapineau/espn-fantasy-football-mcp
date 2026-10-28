// match-r83.test.ts — ruling R8-3 (docs/plan/changelog.md §R8: the news matcher's shared names;
// src/sources/news/match.ts, teams.ts, positions.ts; plan 07 D6), clause by clause, over the WHOLE
// recorded ESPN universe built as the refresh wiring builds it (universeFromEspnPlayers over
// fixtures/espn/recorded/season/players_wl.json, ESPN's position_id joined in). Then the final gate's
// four repro batteries of its fourth run (at f41e810: gk-homonyms*.mts, kept outside the repo), every
// title with its label — the gate's own for battery 1, the batteries' stated intent for 2–4 — and
// the outcome R8-3 gives it. Then fast-check properties over the universe's 16 shared full-name keys
// and its unique names. The names are public NFL players of the recorded fixture; no league, owner or
// member identifier. No network.
import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { mergeName } from "../../../src/domain/crosswalk/normalize.js";
import type { NflTeam } from "../../../src/config/schema.js";
import { playersRows } from "../../../src/sources/espn_season/index.js";
import {
  buildNewsRows,
  buildPlayerMatcher,
  GAME_CUES,
  LEGACY_CUES,
  MATCH_CONFIDENCE,
  NEWS_FILE_FORMAT,
  NOT_DESCRIBING,
  PLAY_CUES,
  POSITION_WORDS,
  RESULT_CUES,
  TEAM_NICKNAMES,
  teamMentions,
  UNIVERSE_SQL,
  universeFromEspnPlayers,
  type NewsUniversePlayer,
} from "../../../src/sources/news/index.js";
import { NEWS_NOW_MS, rss } from "./helpers.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const universe = universeFromEspnPlayers(
  playersRows(
    JSON.parse(
      readFileSync(path.join(ROOT, "fixtures/espn/recorded/season/players_wl.json"), "utf8"),
    ) as unknown,
    2026,
  ).rows,
  () => null,
);
const m = buildPlayerMatcher(universe);

/** The universe player of `name` on `team` (null = a free agent). */
function idOf(name: string, team: string | null): number {
  const p = universe.filter((x) => x.full_name === name && x.team === team);
  if (p.length !== 1 || p[0] === undefined) throw new Error(`${name} ${String(team)}`);
  return p[0].espn_id;
}
const refs = (text: string) => m.match(text).map((r) => [r.espn_id, r.match_method]);

const QB_LAMAR = idOf("Lamar Jackson", "BAL"); // 99.87 % owned
const CB_LAMAR = idOf("Lamar Jackson", null); // a free agent, 0.11 %
const WR_JEFFERSON = idOf("Justin Jefferson", "MIN"); // 99.86 %
const LB_JEFFERSON = idOf("Justin Jefferson", "CLE"); // 0.35 %
const DE_YOUNG = idOf("Byron Young", "LA"); // 20.13 %
const DT_YOUNG = idOf("Byron Young", "PHI"); // 0.08 %
const CB_HARRIS = idOf("Marcus Harris", "TEN"); // 2.08 %
const DT_HARRIS = idOf("Marcus Harris", "KC"); // 0.02 %

describe("the universe carries ESPN's position_id (R8-3 clause 4: joined into the matcher's universe)", () => {
  it("universeFromEspnPlayers keeps position_id; UNIVERSE_SQL selects it", () => {
    const pos = (id: number) => universe.find((p) => p.espn_id === id)?.position_id;
    expect([pos(QB_LAMAR), pos(CB_LAMAR), pos(WR_JEFFERSON), pos(LB_JEFFERSON)]).toEqual([
      1, 12, 3, 11,
    ]);
    expect([pos(DE_YOUNG), pos(DT_YOUNG), pos(CB_HARRIS), pos(DT_HARRIS)]).toEqual([10, 9, 12, 9]);
    expect(universe.every((p) => typeof p.position_id === "number")).toBe(true);
    expect(UNIVERSE_SQL).toMatch(/\bposition_id\b/);
  });
});

describe("R8-3 clause 1: backlog choices 1–5 stand as built, under the new evidence too", () => {
  it("choice 1: evidence that contradicts every holder — now a position neither plays — gives no one", () => {
    // neither Justin Jefferson is a TE, neither Lamar Jackson a kicker (each went to the star at 0.80)
    expect(refs("TE Justin Jefferson: Catches TD")).toEqual([]);
    expect(refs("Lamar Jackson, K, free agent: Works out")).toEqual([]);
    expect(refs("Lamar Jackson: Intercepts a pass against the Ravens")).toEqual([]);
  });

  it("choice 2: a cue word between two teams names a game the subject plays in — result wording too", () => {
    // neither holder plays in a Bengals–Steelers game (went to the Ravens QB by prominence)
    expect(refs("Lamar Jackson: Bengals beat Steelers | Jackson was limited.")).toEqual([]);
    expect(refs("Justin Jefferson: Vikings fall to Lions | Jefferson caught five passes.")).toEqual(
      [[WR_JEFFERSON, "full_name"]],
    );
    expect(refs("Bills vs. Ravens: Lamar Jackson limited Wednesday")).toEqual([
      [QB_LAMAR, "full_name"],
    ]);
  });

  it("choices 3–5 as built: a roster move ties its team; '<team> matchup' is weak; a namesake's loose team blocks", () => {
    expect(refs("Lamar Jackson: Signs with Ravens")).toEqual([[QB_LAMAR, "full_name_team"]]);
    expect(refs("Justin Jefferson: Expected to play in Vikings matchup")).toEqual([]);
    expect(refs("Justin Jefferson: Records 10 tackles in Browns win")).toEqual([]);
    expect(
      refs(
        "Justin Jefferson: Lands on injured reserve | The Browns placed Jefferson on IR with a knee injury.",
      ),
    ).toEqual([]);
  });
});

describe("R8-3 clause 2: a team named loosely is never evidence FOR a holder of a shared name", () => {
  it("it never raises a holder to full_name_team (each was 0.95)", () => {
    for (const title of [
      "Justin Jefferson: Leads Vikings to win | Jefferson caught nine passes.",
      "Justin Jefferson: Notches 100 yards as Vikings roll",
    ])
      expect(refs(title), title).toEqual([[WR_JEFFERSON, "full_name"]]);
    for (const title of [
      "Lamar Jackson: Signs extension with Ravens",
      "Ravens' John Harbaugh: Lamar Jackson day-to-day",
      "Lamar Jackson: Ravens vs. Steelers moved to Monday",
    ])
      expect(refs(title), title).toEqual([[QB_LAMAR, "full_name"]]);
  });

  it("full_name_team needs a team written next to the name or tied to it by a roster move", () => {
    expect(refs("Ravens QB Lamar Jackson has ankle sprain")).toEqual([
      [QB_LAMAR, "full_name_team"],
    ]);
    expect(refs("Ravens activate QB Lamar Jackson")).toEqual([[QB_LAMAR, "full_name_team"]]);
    expect(refs("Browns LB Justin Jefferson: Records sack vs. Vikings")).toEqual([
      [LB_JEFFERSON, "full_name_team"],
    ]);
  });

  it("it never supports a holder left by elimination (the game alone was the Browns LB's 0.95)", () => {
    expect(refs("Browns vs. Bengals: Justin Jefferson records two sacks")).toEqual([]);
    // nor does the namesake's own team named loosely support him (choice 5 blocks the star)
    expect(refs("Justin Jefferson: Records sack | The Browns rallied late.")).toEqual([]);
  });

  it("the bare surname follows it: a shared surname needs a team attached to it or moved to (was 0.60)", () => {
    expect(refs("Jefferson: Questionable for Vikings")).toEqual([]);
    expect(refs("Jefferson: Records sack in Vikings loss")).toEqual([]);
    expect(refs("Vikings WR Jefferson: Catches TD")).toEqual([[WR_JEFFERSON, "last_name_team"]]);
    expect(refs("Browns waive LB Jefferson")).toEqual([[LB_JEFFERSON, "last_name_team"]]);
  });
});

describe("R8-3 clause 3: a team named as the other side of a game or a play is the opponent", () => {
  it("the gate's items: result and play wording rules the star out (each went to him at 0.95)", () => {
    for (const title of [
      "Justin Jefferson: Out for season | Jefferson tore his ACL in Sunday's win over the Vikings, the team announced Monday.",
      "Justin Jefferson: Leads team in tackles | Jefferson recorded 11 tackles (seven solo) in Sunday's 24-20 loss to the Vikings.",
      "Justin Jefferson: Sacks Vikings QB twice",
      "Justin Jefferson: Records first career sack | Jefferson brought down the Vikings' quarterback in the third quarter Sunday.",
      "Lamar Jackson: Picks off Ravens pass | Jackson returned the interception 30 yards.",
      "Lamar Jackson: Carted off with ankle injury | Jackson was hurt covering a punt in Sunday's loss to the Ravens.",
      "Byron Young: Sacks Rams QB",
      "Marcus Harris: Sacks Titans QB",
    ])
      expect(refs(title), title).toEqual([]);
  });

  it("and rules the namesake out of the star's own item (each was no ref)", () => {
    expect(
      refs(
        "Justin Jefferson: Catches two touchdowns | Jefferson caught seven passes for 110 yards in Sunday's win over the Browns.",
      ),
    ).toEqual([[WR_JEFFERSON, "full_name"]]);
    expect(refs("Justin Jefferson: Torches Browns for 150 yards")).toEqual([
      [WR_JEFFERSON, "full_name"],
    ]);
    expect(refs("Byron Young: Sacks Eagles QB twice")).toEqual([[DE_YOUNG, "full_name"]]);
    expect(refs("Marcus Harris: Picks off Chiefs pass")).toEqual([[CB_HARRIS, "full_name"]]);
  });

  it("the closed list, word by word: each names the opponent, the star's team or the namesake's", () => {
    for (const cue of [...RESULT_CUES, ...PLAY_CUES]) {
      const star = `Justin Jefferson: Big day | Jefferson made his mark ${cue} the Browns.`;
      const namesake = `Justin Jefferson: Big day | Jefferson made his mark ${cue} the Vikings.`;
      expect(refs(star), star).toEqual([[WR_JEFFERSON, "full_name"]]);
      expect(refs(namesake), namesake).toEqual([]);
    }
  });

  it("a result word before a team's possessive names that team's own thing, not an opponent", () => {
    for (const title of [
      "Justin Jefferson: Beats Browns' franchise sack record",
      "Justin Jefferson: Fell to Browns' third string",
    ])
      expect(refs(title), title).toEqual([]);
    // a play word keeps its object's team the opponent: "sacks the Vikings' QB"
    expect(refs("Justin Jefferson: Burns Browns' secondary for two scores")).toEqual([
      [WR_JEFFERSON, "full_name"],
    ]);
  });

  it("words outside the list stay no evidence either way (no verb parsing: R7-4's precedent)", () => {
    // "at", "tops", "visits" and "faces" may name the subject's own team: loose, so choice 5 blocks
    for (const title of [
      "Justin Jefferson: Questionable for Sunday's game at Cleveland",
      "Justin Jefferson: Tops Browns' depth chart at linebacker",
      "Justin Jefferson: Faces Browns' fine for the hit",
    ])
      expect(refs(title), title).toEqual([]);
  });
});

describe("teamMentions' shared-name reading (R8-3 clause 3): the closed, tested cue lists", () => {
  const read = (text: string) =>
    teamMentions(text).map((t) => ({
      team: t.team,
      legacy: [t.cue, t.pair?.team ?? null],
      shared: [t.shared.cue, t.shared.pair?.team ?? null],
    }));

  it("the lists, word for word", () => {
    expect(LEGACY_CUES).toEqual(["against", "vs", "vs.", "versus", "facing"]);
    // prettier-ignore
    expect(RESULT_CUES).toEqual([
      "win over", "wins over", "victory over", "victories over", "triumph over", "rout of",
      "loss to", "losses to", "lost to", "lose to", "loses to", "losing to",
      "fell to", "falls to", "fall to", "falling to",
      "beat", "beats", "beating", "defeat", "defeats", "defeated", "defeating",
      "past", "matchup with", "matchups with",
    ]);
    // prettier-ignore
    expect(PLAY_CUES).toEqual([
      "sack", "sacks", "sacked", "sacking", "strip-sack", "strip-sacks", "strip-sacked",
      "intercept", "intercepts", "intercepted", "intercepting",
      "pick off", "picks off", "picked off", "picking off",
      "tackle", "tackles", "tackled", "tackling",
      "bring down", "brings down", "brought down", "bringing down",
      "torch", "torches", "torched", "torching", "burn", "burns", "burned",
      "gash", "gashes", "gashed", "shred", "shreds", "shredded",
    ]);
    expect(GAME_CUES).toEqual([
      ...LEGACY_CUES,
      ...RESULT_CUES,
      ...PLAY_CUES,
      "host",
      "hosts",
      "hosted",
      "hosting",
      "visit",
      "visits",
      "visited",
      "visiting",
      "face",
      "faces",
      "faced",
    ]);
  });

  it("each result and play word names the team after it, in the shared reading only", () => {
    for (const cue of [...RESULT_CUES, ...PLAY_CUES]) {
      for (const text of [`Jefferson ${cue} the Browns`, `Jefferson ${cue} Browns`]) {
        const [t] = read(text);
        expect(t, text).toEqual({ team: "CLE", legacy: [null, null], shared: ["before", null] });
      }
    }
    // the legacy words are read alike in both; "matchup" after a team in both
    expect(read("Out against the Browns")).toEqual([
      { team: "CLE", legacy: ["before", null], shared: ["before", null] },
    ]);
    expect(read("Questionable for Browns matchup")).toEqual([
      { team: "CLE", legacy: ["after", null], shared: ["after", null] },
    ]);
  });

  it("a result word before a team's possessive is no cue; a play word is", () => {
    expect(read("Beats Browns' franchise sack record")[0]?.shared).toEqual([null, null]);
    expect(read("Fell to the Browns' third string")[0]?.shared).toEqual([null, null]);
    expect(read("Brought down the Vikings' quarterback")[0]?.shared).toEqual(["before", null]);
    expect(read("Picks off a Ravens pass")[0]?.shared).toEqual(["before", null]);
  });

  it("game words between two teams name a game; after a single team they name no opponent", () => {
    expect(read("Vikings host Browns on Sunday")).toEqual([
      { team: "MIN", legacy: [null, null], shared: [null, "CLE"] },
      { team: "CLE", legacy: [null, null], shared: [null, "MIN"] },
    ]);
    expect(read("in the Browns' loss to the Vikings")).toEqual([
      { team: "CLE", legacy: [null, null], shared: [null, "MIN"] },
      { team: "MIN", legacy: [null, null], shared: ["before", "CLE"] },
    ]);
    expect(read("the Vikings' 24-20 win over the Browns").map((t) => t.shared)).toEqual([
      [null, "CLE"],
      ["before", "MIN"],
    ]);
    expect(read("Bills vs. Ravens")).toEqual([
      { team: "BUF", legacy: [null, "BAL"], shared: [null, "BAL"] },
      { team: "BAL", legacy: ["before", "BUF"], shared: ["before", "BUF"] },
    ]);
    for (const text of ["Visits Bears", "Hosts Bears", "Faces Bears", "Top Bears", "at Bears"])
      expect(read(text)[0]?.shared, text).toEqual([null, null]);
  });
});

describe("R8-3 clause 4: a position written next to the name, or describing the subject (choice 6(c))", () => {
  it("next to the name: it rules out every holder of another position (each went to the star at 0.80)", () => {
    expect(refs("LB Justin Jefferson: Records sack")).toEqual([[LB_JEFFERSON, "full_name"]]);
    expect(refs("Free-agent cornerback Lamar Jackson visits Bengals")).toEqual([
      [CB_LAMAR, "full_name"],
    ]);
    expect(refs("Justin Jefferson (LB) questionable")).toEqual([[LB_JEFFERSON, "full_name"]]);
    expect(refs("Lamar Jackson, CB, free agent: Works out for Bears")).toEqual([
      [CB_LAMAR, "full_name"],
    ]);
    expect(refs("DT Marcus Harris: Records sack")).toEqual([[DT_HARRIS, "full_name"]]);
  });

  it("describing the subject: a sentence opening 'The [<team>] <position>' about him", () => {
    expect(
      refs(
        "Justin Jefferson: Dealing with knee injury | The linebacker did not practice Wednesday.",
      ),
    ).toEqual([[LB_JEFFERSON, "full_name"]]);
    expect(
      refs(
        "Justin Jefferson: Questionable for Sunday | Jefferson (ankle) was limited. The defender has started every game.",
      ),
    ).toEqual([[LB_JEFFERSON, "full_name"]]);
    expect(refs("Lamar Jackson injury update: Bengals CB dealing with ankle sprain")).toEqual([
      [CB_LAMAR, "full_name"],
    ]);
    expect(
      refs("Justin Jefferson: Practices fully | The Vikings wideout faces Cleveland on Sunday."),
    ).toEqual([[WR_JEFFERSON, "full_name"]]);
  });

  it("a sentence describing someone else is not the subject's", () => {
    // another person named before it, or one named after it in its sentence
    expect(
      refs(
        "Justin Jefferson: Catches TD | Denzel Ward covered him. The linebacker was beaten twice.",
      ),
    ).toContainEqual([WR_JEFFERSON, "full_name"]);
    expect(
      refs("Justin Jefferson: Catches TD | The linebacker who covered Jefferson was benched."),
    ).toEqual([[WR_JEFFERSON, "full_name"]]);
    // a word that is also a common noun there describes no one
    expect(refs("Lamar Jackson: Safety concerns linger after hit")).toEqual([
      [QB_LAMAR, "full_name"],
    ]);
  });

  it("with the namesake's team attached, the position decides past the star (choice 6(c))", () => {
    expect(refs("Browns LB Justin Jefferson: Records sack")).toEqual([
      [LB_JEFFERSON, "full_name_team"],
    ]);
    expect(refs("Kansas City DT Marcus Harris: Records sack")).toEqual([
      [DT_HARRIS, "full_name_team"],
    ]);
    // the post-trade case: a WR on the Browns is neither holder — no ref on either path
    expect(refs("Browns WR Justin Jefferson: Catches TD")).toEqual([]);
    expect(refs("Browns WR Jefferson: Catches TD")).toEqual([]);
  });

  it("several position words must all fit; one holder's name written twice in an item is one person", () => {
    expect(
      refs("LB Justin Jefferson: Records sack | The linebacker led the team in tackles."),
    ).toEqual([[LB_JEFFERSON, "full_name"]]);
    // they contradict each other: no holder plays both (choice 1)
    expect(
      refs("WR Justin Jefferson: Questionable | The linebacker did not practice Wednesday."),
    ).toEqual([]);
    // the evidence of every occurrence is pooled: the second, bare one is the same LB (it went to
    // the WR by prominence), and a suffix written once spells the name for the whole item
    expect(refs("LB Justin Jefferson: Records sack | Justin Jefferson added two tackles.")).toEqual(
      [[LB_JEFFERSON, "full_name"]],
    );
    expect(
      refs("Michael Carter II: Records interception | Michael Carter also forced a fumble."),
    ).toEqual([[idOf("Michael Carter II", "PHI"), "full_name"]]);
  });

  it("the bare-surname path follows the same rule", () => {
    // the LB's surname ref is kept, and a position breaks a tie on the attached team (was no ref)
    expect(refs("Browns LB Jefferson: Records sack")).toEqual([[LB_JEFFERSON, "last_name_team"]]);
    expect(refs("Ravens QB Jackson: Limited in practice")).toEqual([[QB_LAMAR, "last_name_team"]]);
    expect(refs("Sources: Ravens QB Jackson has ankle sprain, slim chance to play Week 5")).toEqual(
      [[QB_LAMAR, "last_name_team"]],
    );
    // the namesake's attached team alone never gives him the surname past the star (was the LB)
    expect(refs("Cleveland's Jefferson: Placed on IR")).toEqual([]);
    // a sentence describing the surname when it is the item's subject (it holds no full name)
    expect(
      refs("Cleveland's Jefferson: Placed on IR | The linebacker will miss four games."),
    ).toEqual([[LB_JEFFERSON, "last_name_team"]]);
    // … not when another person is named between them
    expect(
      refs("Cleveland's Jefferson: Placed on IR | Ward was beaten. The linebacker will miss time."),
    ).toEqual([]);
  });
});

describe("R8-3 clause 5: evidence that leaves no single holder gives no ref, and the item is counted", () => {
  it("a position several holders fit tells none of them apart (went to the Rams DE at 0.80)", () => {
    expect(refs("DL Byron Young: Records sack")).toEqual([]);
    expect(m.matchItem("DL Byron Young: Records sack")).toEqual({ refs: [], unresolved: 1 });
    expect(m.matchItem("Michael Carter: Limited in practice")).toEqual({ refs: [], unresolved: 1 });
    // a decided name is not counted; a unique one never is
    expect(m.matchItem("LB Justin Jefferson: Records sack").unresolved).toBe(0);
    expect(m.matchItem("Bijan Robinson: Questionable").unresolved).toBe(0);
    // a shared surname is counted only when a team is tied to it
    expect(m.matchItem("Ravens' Jackson: Limited").unresolved).toBe(1);
    expect(m.matchItem("Jackson: Limited").unresolved).toBe(0);
  });

  it("the news build counts the items without a ref and those a shared name was left out of", () => {
    const xml = rss([
      { title: "DL Byron Young: Records sack", guid: "a" },
      { title: "Justin Jefferson: Sacks Vikings QB twice", guid: "b" },
      { title: "LB Justin Jefferson: Records sack", guid: "c" },
      { title: "Bengals sign veteran kicker", guid: "d" },
      { title: "Michael Carter: Limited | Ja'Marr Chase caught 10 passes.", guid: "e" },
    ]);
    const b = buildNewsRows({
      format: NEWS_FILE_FORMAT,
      source: "rotowire",
      fetched_ms: NEWS_NOW_MS,
      xml,
      universe,
      previous: [],
      warnings: [],
    });
    // every item is kept: none is dropped because a name was left to no one
    expect(b.news).toHaveLength(5);
    expect(b.counts).toMatchObject({ unmatched: 3, unresolved: 3 });
    expect(b.warnings).toContain(
      "3 item(s) carry no player ref (kept; espn_get_news shows them with players_matched empty)",
    );
    expect(b.warnings).toContain(
      "3 item(s) name a player several universe players share, and the evidence picks none of them: no ref for that name",
    );
    // the item that matched Chase still names the unresolved Michael Carter: counted, not unmatched
    expect(b.refs.map((r) => r.espn_id)).toContain(idOf("Ja'Marr Chase", "CIN"));
  });
});

describe("R8-3 clause 6: the accepted residual — no team, no position, no cue → the prominent holder at 0.80", () => {
  it("as built, and never 0.95", () => {
    for (const [title, id] of [
      [
        "Justin Jefferson: Placed on IR | Jefferson (knee) will miss at least four games.",
        WR_JEFFERSON,
      ],
      ["Byron Young: Placed on IR | Young (knee) will miss the rest of the season.", DE_YOUNG],
      ["Marcus Harris: Placed on IR | Harris (knee) will miss the rest of the season.", CB_HARRIS],
      ["Lamar Jackson: Inks reserve/future contract", QB_LAMAR],
    ] as const)
      expect(refs(title), title).toEqual([[id, "full_name"]]);
    // the star's own team named loosely, in wording no cue knows, is no evidence: the residual's
    // 0.80, never the 0.95 it was (clause 2)
    expect(refs("Justin Jefferson: Catches TD as Vikings rally late")).toEqual([
      [WR_JEFFERSON, "full_name"],
    ]);
    expect(m.match("Justin Jefferson: Catches TD as Vikings rally late")[0]?.match_confidence).toBe(
      MATCH_CONFIDENCE.full_name,
    );
  });
});

// ---------------------------------------------------------------------------------------------------
// The final gate's batteries (fourth run, at f41e810). Labels: "star" / "namesake" — whose item it is
// (never the other holder's ref); "either" — genuinely ambiguous; "residual" — the namesake's by its
// words, but naming no holder's team, no position and no cue, so R8-3 clause 6 gives the prominent
// holder at full_name, as accepted; "open" — the one item R8-3's ruled evidence still gives the star
// (choice 3 stands as built: a roster move to his own team ties it to him; docs/evals/stage-c-backlog.md).

type Who = "star" | "namesake";
type Label = Who | "either" | "residual" | "open";
const HOLDERS = {
  LJ: { star: QB_LAMAR, namesake: CB_LAMAR },
  JJ: { star: WR_JEFFERSON, namesake: LB_JEFFERSON },
  BY: { star: DE_YOUNG, namesake: DT_YOUNG },
  MH: { star: CB_HARRIS, namesake: DT_HARRIS },
} as const;
type Case = readonly [
  keyof typeof HOLDERS,
  Label,
  string,
  readonly (readonly [Who, "full_name_team" | "full_name" | "last_name_team"])[],
];

/** Checks each case's exact outcome and that no labelled item reaches the other holder. */
function battery(cases: readonly Case[]): { misattributed: number; refd: number } {
  let misattributed = 0;
  let refd = 0;
  for (const [k, label, title, want] of cases) {
    const h = HOLDERS[k];
    expect(refs(title), `${label}: ${title}`).toEqual(
      want.map(([who, method]) => [h[who], method]),
    );
    const got = m.match(title).map((r) => r.espn_id);
    if (got.length > 0) refd++;
    if (label === "star" && got.includes(h.namesake)) misattributed++;
    if (label === "namesake" && got.includes(h.star)) misattributed++;
    if (label === "residual") expect(want, title).toEqual([["star", "full_name"]]);
    if (label === "either") expect(got.length, title).toBeLessThanOrEqual(1);
  }
  return { misattributed, refd };
}

describe("the final gate's batteries, every labelled title (fourth run, at f41e810)", () => {
  it("battery 1 (gk-homonyms.mts, the gate's labels): 10 misattributions there, none now", () => {
    // prettier-ignore
    const cases: readonly Case[] = [
      // the star's news, phrased in ways the tests did not use
      ["JJ", "star", "Justin Jefferson: Practices fully Wednesday | The Vikings wideout faces Cleveland on Sunday.", [["star", "full_name"]]],
      ["JJ", "star", "Justin Jefferson catches two touchdowns as Minnesota beats Cleveland", []],
      ["JJ", "star", "Browns' secondary must slow Justin Jefferson", []],
      ["JJ", "star", "Cleveland defense prepares for Justin Jefferson", []],
      ["JJ", "star", "Justin Jefferson (hamstring) questionable for Sunday vs. CLE", [["star", "full_name"]]],
      ["JJ", "star", "Justin Jefferson, WR, Minnesota: Questionable", [["star", "full_name"]]],
      ["JJ", "star", "Minnesota Vikings star Justin Jefferson ruled out", [["star", "full_name_team"]]],
      ["JJ", "star", "Justin Jefferson: Torches Browns for 150 yards", [["star", "full_name"]]],
      ["JJ", "star", "Justin Jefferson: Leads Vikings to win | Jefferson caught nine passes.", [["star", "full_name"]]],
      ["JJ", "star", "Kevin O'Connell: Justin Jefferson will play Sunday", [["star", "full_name"]]],
      ["JJ", "star", "Justin Jefferson: Questionable, Browns next | Jefferson (hamstring) did not practice.", []],
      ["JJ", "star", "Justin Jefferson and the Vikings visit the Browns in Week 9", []],
      ["JJ", "star", "Justin Jefferson: Traded to Browns", []],
      ["JJ", "star", "Vikings trade Justin Jefferson to Browns", []],
      // the namesake's news
      ["JJ", "namesake", "Justin Jefferson: Records 12 tackles in loss to Vikings | The Browns linebacker led the team.", [["namesake", "full_name"]]],
      ["JJ", "namesake", "Browns linebacker Justin Jefferson suspended", [["namesake", "full_name_team"]]],
      ["JJ", "namesake", "Justin Jefferson, LB, Cleveland: Out with knee injury", [["namesake", "full_name"]]],
      ["JJ", "namesake", "Cleveland's Justin Jefferson: Placed on IR", []],
      ["JJ", "namesake", "Justin Jefferson: Released by Browns", []],
      ["JJ", "namesake", "Vikings sign LB Justin Jefferson off Browns practice squad", []],
      ["JJ", "namesake", "Justin Jefferson: Sacks Vikings QB twice", []],
      ["JJ", "namesake", "Justin Jefferson: Forces fumble vs. Vikings", []],
      ["JJ", "namesake", "Justin Jefferson: Tackles Vikings' running back for a loss", []],
      ["LJ", "namesake", "Ravens sign CB Lamar Jackson to practice squad", [["namesake", "full_name"]]],
      ["LJ", "open", "Lamar Jackson: Signs with Ravens practice squad", [["star", "full_name_team"]]],
      ["LJ", "namesake", "Cornerback Lamar Jackson: Works out for Ravens", [["namesake", "full_name"]]],
      ["LJ", "namesake", "Lamar Jackson: Claimed off waivers by Ravens | The cornerback joins Baltimore's secondary.", [["namesake", "full_name"]]],
      ["LJ", "namesake", "Free-agent cornerback Lamar Jackson visits Bengals", [["namesake", "full_name"]]],
      ["LJ", "namesake", "Lamar Jackson: Intercepts Ravens QB", []],
      // the star's own (Ravens QB)
      ["LJ", "star", "Lamar Jackson: Throws three TDs vs. Bengals", [["star", "full_name"]]],
      ["LJ", "star", "Baltimore QB Lamar Jackson questionable", [["star", "full_name_team"]]],
      ["LJ", "star", "Lamar Jackson: Signs extension with Ravens", [["star", "full_name"]]],
      ["LJ", "star", "Lamar Jackson (ankle) limited | The Ravens quarterback was limited.", [["star", "full_name"]]],
      ["LJ", "star", "Ravens' John Harbaugh: Lamar Jackson day-to-day", [["star", "full_name"]]],
      ["LJ", "star", "Lamar Jackson: Sacked five times by Steelers", [["star", "full_name"]]],
      // Byron Young / Marcus Harris
      ["BY", "star", "Byron Young: Records two sacks against Eagles | The Rams edge rusher was dominant.", [["star", "full_name"]]],
      ["BY", "namesake", "Byron Young: Records two sacks against Rams | The Eagles defensive tackle was dominant.", [["namesake", "full_name"]]],
      ["BY", "star", "Rams' Byron Young: Two sacks", [["star", "full_name_team"]]],
      ["BY", "namesake", "Philadelphia's Byron Young: Two sacks", []],
      ["MH", "star", "Marcus Harris: Breaks up two passes vs. Chiefs | The Titans cornerback had a strong game.", [["star", "full_name"]]],
      ["MH", "namesake", "Marcus Harris: Records sack vs. Titans | The Chiefs defensive tackle got home.", [["namesake", "full_name"]]],
      ["MH", "namesake", "Kansas City DT Marcus Harris: Records sack", [["namesake", "full_name_team"]]],
      // a namesake's team with the star's in a game, plus position words
      ["JJ", "namesake", "Browns LB Justin Jefferson: Records sack vs. Vikings", [["namesake", "full_name_team"]]],
      ["JJ", "star", "Vikings WR Justin Jefferson: Questionable vs. Browns", [["star", "full_name_team"]]],
      ["JJ", "namesake", "LB Justin Jefferson: Records sack", [["namesake", "full_name"]]],
      ["JJ", "star", "WR Justin Jefferson: Records 100 yards", [["star", "full_name"]]],
      ["LJ", "namesake", "CB Lamar Jackson: Signs with Bengals", [["namesake", "full_name"]]],
      // surname-only paths
      ["JJ", "namesake", "Browns LB Jefferson: Records sack", [["namesake", "last_name_team"]]],
      ["JJ", "star", "Vikings WR Jefferson: Catches TD", [["star", "last_name_team"]]],
      ["JJ", "star", "Jefferson: Questionable for Vikings", []],
      ["LJ", "star", "Ravens QB Jackson: Limited in practice", [["star", "last_name_team"]]],
      ["LJ", "namesake", "Bengals CB Jackson: Signed to practice squad", []],
    ];
    expect(cases).toHaveLength(52);
    // 35 refs: the gate's 34 ok and the open item (it counted 20 ok and 10 misattributions)
    expect(battery(cases)).toEqual({ misattributed: 0, refd: 35 });
  });

  it("battery 2 (gk-homonyms2.mts, 'more realistic namesake items')", () => {
    // prettier-ignore
    const cases: readonly Case[] = [
      ["LJ", "namesake", "Lamar Jackson: Intercepts Ravens QB", []],
      ["LJ", "namesake", "Lamar Jackson: Picks off Ravens pass | Jackson returned the interception 30 yards.", []],
      ["LJ", "residual", "Lamar Jackson: Works out for Bengals", [["star", "full_name"]]],
      ["LJ", "residual", "Lamar Jackson: Visits Bears", [["star", "full_name"]]],
      ["LJ", "residual", "Lamar Jackson: Inks reserve/future contract", [["star", "full_name"]]],
      ["LJ", "residual", "Lamar Jackson: Waived with injury designation | Jackson (hamstring) reverts to injured reserve.", [["star", "full_name"]]],
      ["JJ", "namesake", "Justin Jefferson: Sacks Vikings QB twice", []],
      ["JJ", "namesake", "Justin Jefferson: Notches 11 tackles in Vikings loss | The linebacker led all defenders.", [["namesake", "full_name"]]],
      ["JJ", "residual", "Justin Jefferson: Placed on IR | Jefferson (knee) will miss at least four games.", [["star", "full_name"]]],
      ["JJ", "namesake", "Justin Jefferson: Dealing with knee injury | The linebacker did not practice Wednesday.", [["namesake", "full_name"]]],
      ["JJ", "namesake", "Justin Jefferson: Questionable for Sunday | Jefferson (ankle) was limited. The defender has started every game.", [["namesake", "full_name"]]],
      ["BY", "namesake", "Byron Young: Sacks Rams QB", []],
      ["MH", "namesake", "Marcus Harris: Sacks Titans QB", []],
      ["MH", "residual", "Marcus Harris: Placed on IR | Harris (knee) will miss the rest of the season.", [["star", "full_name"]]],
      ["BY", "residual", "Byron Young: Placed on IR | Young (knee) will miss the rest of the season.", [["star", "full_name"]]],
    ];
    expect(battery(cases)).toEqual({ misattributed: 0, refd: 10 });
  });

  it("battery 3 (gk-homonyms3.mts, RotoWire IDP blurbs naming only the opponent, and two controls)", () => {
    // prettier-ignore
    const cases: readonly Case[] = [
      ["JJ", "namesake", "Justin Jefferson: Leads team in tackles | Jefferson recorded 11 tackles (seven solo) in Sunday's 24-20 loss to the Vikings.", []],
      ["JJ", "namesake", "Justin Jefferson: Leads team in tackles | Jefferson recorded 11 tackles (seven solo) in Sunday's 24-20 win over the Vikings.", []],
      ["JJ", "namesake", "Justin Jefferson: Records first career sack | Jefferson brought down the Vikings' quarterback in the third quarter Sunday.", []],
      ["LJ", "namesake", "Lamar Jackson: Snags interception | Jackson picked off the Ravens' quarterback in the fourth quarter of Sunday's loss.", []],
      ["BY", "namesake", "Byron Young: Two sacks in win | Young sacked the Rams' quarterback twice in Sunday's 27-17 win.", []],
      ["JJ", "star", "Justin Jefferson: Catches two touchdowns | Jefferson caught seven passes for 110 yards in Sunday's win over the Browns.", [["star", "full_name"]]],
      ["LJ", "star", "Lamar Jackson: Accounts for three scores | Jackson threw two touchdowns and ran for another in Sunday's win over the Bengals.", [["star", "full_name"]]],
    ];
    expect(battery(cases)).toEqual({ misattributed: 0, refd: 2 });
  });

  it("battery 4 (gk-homonyms4.mts, the finding's injury items)", () => {
    // prettier-ignore
    const cases: readonly Case[] = [
      ["JJ", "namesake", "Justin Jefferson: Exits with knee injury | Jefferson left Sunday's loss to the Vikings in the third quarter and did not return.", []],
      ["JJ", "namesake", "Justin Jefferson: Out for season | Jefferson tore his ACL in Sunday's win over the Vikings, the team announced Monday.", []],
      ["LJ", "namesake", "Lamar Jackson: Carted off with ankle injury | Jackson was hurt covering a punt in Sunday's loss to the Ravens.", []],
    ];
    expect(battery(cases)).toEqual({ misattributed: 0, refd: 0 });
  });
});

// ---------------------------------------------------------------------------------------------------
// Properties over the recorded universe's shared names.

/** The full-name keys more than one universe player holds (the matcher's own `mergeName` keys). */
const SHARED: readonly (readonly NewsUniversePlayer[])[] = (() => {
  const byKey = new Map<string, NewsUniversePlayer[]>();
  for (const p of universe) {
    const k = mergeName(p.full_name);
    if (k === null || k.split(" ").length < 2) continue;
    byKey.set(k, [...(byKey.get(k) ?? []), p]);
  }
  return [...byKey.values()].filter((hs) => hs.length > 1);
})();
const NICK: ReadonlyMap<NflTeam, string> = new Map(
  Object.entries(TEAM_NICKNAMES)
    .filter(([n]) => !["Jags", "Pats", "Niners", "Bucs"].includes(n))
    .map(([n, t]): [NflTeam, string] => [t, n]),
);
const nick = (t: NflTeam): string => NICK.get(t) ?? "";
/** The name as written with no suffix: no spelling evidence. */
const plain = (p: NewsUniversePlayer): string =>
  p.full_name.replace(/\s+(?:Jr\.?|Sr\.?|II|III|IV|V)$/u, "");
/** Headlines that name no team, no position, no cue and no other universe player. */
const NEUTRAL = [
  "Limited at practice",
  "Questionable for Sunday",
  "Out for the week",
  "Placed on IR",
  "Returns to practice",
  "Expected to play",
] as const;
const owned = (p: NewsUniversePlayer): number => p.percent_owned ?? 0;
/** The holder ESPN leagues roster at least 1 % and 10 times each other holder (the matcher's rule). */
function prominentOf(hs: readonly NewsUniversePlayer[]): NewsUniversePlayer | null {
  const [top, ...rest] = [...hs].sort((a, b) => owned(b) - owned(a));
  return top !== undefined && owned(top) >= 1 && rest.every((p) => owned(top) >= 10 * owned(p))
    ? top
    : null;
}
/** Position words that name the holder's ESPN position and no other holder's. */
function positionWordsFor(h: NewsUniversePlayer, hs: readonly NewsUniversePlayer[]): string[] {
  return Object.entries(POSITION_WORDS)
    .filter(
      ([, ids]) =>
        h.position_id != null &&
        ids.includes(h.position_id) &&
        hs.every((o) => o === h || o.position_id == null || !ids.includes(o.position_id)),
    )
    .map(([w]) => w);
}
const ABBREVIATION = /^[a-z]{1,3}\d?$/u;

describe("properties over the recorded universe's shared full names", () => {
  it("the universe's shared keys are those the backlog measured (16, 5 with a prominent holder)", () => {
    expect(SHARED).toHaveLength(16);
    expect(SHARED.filter((hs) => prominentOf(hs) !== null)).toHaveLength(5);
  });

  it("property: an item whose evidence points to one holder never goes to another holder", () => {
    // the evidence: his position (a word no other holder's position fits), his team attached, or a
    // cue that rules every other holder out — alone or together
    const pairs = SHARED.flatMap((hs) => hs.map((h) => ({ h, hs })));
    fc.assert(
      fc.property(
        fc.constantFrom(...pairs),
        fc.constantFrom(...NEUTRAL),
        fc.nat(),
        fc.nat(),
        fc.boolean(),
        ({ h, hs }, headline, pick, form, withCue) => {
          const others = hs.filter((o) => o !== h);
          const words = positionWordsFor(h, hs);
          const ownTeam = h.team !== null && others.every((o) => o.team !== h.team);
          // a cue ruling out every other holder: each is a free agent (no games) or on the cue's team
          const teamsOfOthers = [
            ...new Set(others.flatMap((o) => (o.team === null ? [] : [o.team]))),
          ];
          const cueTeam: NflTeam | undefined =
            teamsOfOthers.length === 0
              ? h.team === "BUF"
                ? "MIA"
                : "BUF"
              : teamsOfOthers.length === 1
                ? teamsOfOthers[0]
                : undefined;
          const cue =
            withCue && h.team !== null && cueTeam !== undefined && cueTeam !== h.team
              ? ` against the ${nick(cueTeam)}`
              : "";
          if (words.length === 0 && !ownTeam && cue === "") return; // no evidence for him
          const name = h.full_name;
          const w = words.length > 0 ? words[pick % words.length] : undefined;
          const W = w === undefined ? "" : ABBREVIATION.test(w) ? w.toUpperCase() : w;
          const team = ownTeam ? `${nick(h.team)} ` : "";
          const text =
            w === undefined
              ? `${team}${name}: ${headline}${cue}`
              : [
                  `${team}${W} ${name}: ${headline}${cue}`,
                  `${name} (${team}${W}) ${headline}${cue}`,
                  // a describing sentence, with a word that describes there (not "safety", "edge" …)
                  NOT_DESCRIBING.has(w)
                    ? `${team}${W} ${name}: ${headline}${cue}`
                    : `${team}${name}: ${headline}${cue} | The ${W} was limited.`,
                ][form % 3];
          if (text === undefined) return;
          const got = m.match(text).map((r) => r.espn_id);
          for (const o of others) expect(got, text).not.toContain(o.espn_id);
        },
      ),
      { numRuns: 1_000 },
    );
  });

  it("property: an item with no evidence follows clause 6 — the prominent holder at full_name, or no one", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SHARED),
        fc.constantFrom(...NEUTRAL),
        fc.boolean(),
        (hs, headline, blurb) => {
          const first = hs[0];
          if (first === undefined) return;
          const surname = plain(first).split(" ").at(-1) ?? "";
          const text = `${plain(first)}: ${headline}${blurb ? ` | ${surname} was limited Wednesday.` : ""}`;
          const top = prominentOf(hs);
          const got = m.matchItem(text);
          const mine = got.refs.filter((r) => hs.some((p) => p.espn_id === r.espn_id));
          expect(
            mine.map((r) => [r.espn_id, r.match_method]),
            text,
          ).toEqual(top === null ? [] : [[top.espn_id, "full_name"]]);
          expect(got.unresolved, text).toBe(top === null ? 1 : 0);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("unique names are matched exactly as before R8-3", () => {
  // a name one universe player holds never reads the shared-name evidence: R8-3's cue words, its
  // game words and its position words leave his ref as a neutral word in their place does
  const UNIQUE = universe.filter((p) => {
    const k = mergeName(p.full_name);
    return (
      p.team !== null &&
      k !== null &&
      universe.filter((q) => mergeName(q.full_name) === k).length === 1 &&
      !/['’.-]/u.test(p.full_name)
    );
  });

  it("property: a new cue, game or position word is read as a neutral word for a unique name", () => {
    const NEW_WORDS = [
      ...RESULT_CUES,
      ...PLAY_CUES,
      "host",
      "visits",
      "faces",
      ...Object.keys(POSITION_WORDS).filter((w) => !ABBREVIATION.test(w)),
    ];
    const teams = [...NICK.values()];
    fc.assert(
      fc.property(
        fc.constantFrom(...UNIQUE),
        fc.constantFrom(...NEW_WORDS),
        fc.constantFrom(...teams),
        fc.boolean(),
        (p, word, other, own) => {
          const team = own && p.team !== null ? nick(p.team) : other;
          const ref = (text: string) =>
            m
              .match(text)
              .filter((r) => r.espn_id === p.espn_id)
              .map((r) => r.match_method);
          const withWord = `${p.full_name}: Big day | He made his mark ${word} the ${team}.`;
          const neutral = `${p.full_name}: Big day | He made his mark and the ${team}.`;
          expect(ref(withWord), withWord).toEqual(ref(neutral));
          expect(ref(`${word} ${p.full_name}: Limited`)).toEqual(ref(`${p.full_name}: Limited`));
        },
      ),
      { numRuns: 400 },
    );
  });
});
