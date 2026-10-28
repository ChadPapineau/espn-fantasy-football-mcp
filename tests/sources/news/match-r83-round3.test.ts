// match-r83-round3.test.ts — ruling R8-3 (docs/plan/changelog.md §R8), the independent attack on fix
// round 2 (7b9572c) and the fixes of round 3 (src/sources/news/match.ts, cues.ts, positions.ts;
// changelog §B9 "Fix round 3"). One describe per violation the attack found, each with the attack's
// own texts (public NFL names of the recorded fixture; no league, owner or member identifier); then
// every list that decides whether a cue, a label or a roster move holds, word for word and entry by
// entry; then fast-check properties over the recorded universe's shared names. Each violation's
// tests fail at 7b9572c, and each R8-3 clause has tests that fail at f41e810. No network. Only
// exports f41e810 already had are read at the top level, so the old code fails test by test.
import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { mergeName } from "../../../src/domain/crosswalk/normalize.js";
import type { NflTeam } from "../../../src/config/schema.js";
import { playersRows } from "../../../src/sources/espn_season/index.js";
import * as news from "../../../src/sources/news/index.js";
import {
  buildPlayerMatcher,
  TEAM_NICKNAMES,
  universeFromEspnPlayers,
  type NewsUniversePlayer,
} from "../../../src/sources/news/index.js";

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
/** The universe player of `name` on `team` at ESPN position `position` (several free agents). */
function idAt(name: string, team: string | null, position: number): number {
  const p = universe.find(
    (x) => x.full_name === name && x.team === team && x.position_id === position,
  );
  if (p === undefined) throw new Error(`${name} ${String(team)} ${String(position)}`);
  return p.espn_id;
}
const refs = (text: string) => m.match(text).map((r) => [r.espn_id, r.match_method]);
/** The refs and the count (R8-3 clause 5); `matchItem` is new since f41e810. */
const item = (text: string) => {
  const r = m.matchItem(text);
  return { refs: r.refs.map((x) => [x.espn_id, x.match_method]), unresolved: r.unresolved };
};
/** No ref, and the shared name counted (R8-3 clause 5). */
const NONE = { refs: [], unresolved: 1 };
/** A list the source exports (read lazily: f41e810 exported none of them). */
const list = (name: string): readonly string[] => {
  const v = (news as Record<string, unknown>)[name];
  if (!Array.isArray(v)) throw new Error(`no list ${name}`);
  return v as readonly string[];
};

const QB_LAMAR = idOf("Lamar Jackson", "BAL");
const CB_LAMAR = idOf("Lamar Jackson", null);
const WR_JEFFERSON = idOf("Justin Jefferson", "MIN");
const LB_JEFFERSON = idOf("Justin Jefferson", "CLE");
const DE_YOUNG = idOf("Byron Young", "LA");
const DT_YOUNG = idOf("Byron Young", "PHI");
const CB_HARRIS = idOf("Marcus Harris", "TEN");
const DT_HARRIS = idOf("Marcus Harris", "KC");
const DT_JONES = idOf("Chris Jones", "KC");
/** The free-agent CB Chris Jones (read lazily: f41e810's universe carries no position). */
const cbJones = (): number => idAt("Chris Jones", null, 12);
const MURPHY_JR = idOf("Byron Murphy Jr.", "MIN");
const MURPHY_II = idOf("Byron Murphy II", "SEA");
const RB_CARTER = idOf("Michael Carter", "TEN");
const S_CARTER = idOf("Michael Carter II", "PHI");

describe("R3-V1 (clause 4): a topic's clause is his label only when it names one player", () => {
  it("a clause that labels another player is no label: no ref, counted (the other holder at 7b9572c)", () => {
    for (const [title, wrong] of [
      ["Lamar Jackson injury update: Steelers cornerback fined for hit on Ravens QB", CB_LAMAR],
      ["Lamar Jackson injury update: Ravens' top cornerback also ruled out for Week 9", CB_LAMAR],
      ["Lamar Jackson news: Cornerback fined for hit on Ravens QB", CB_LAMAR],
      [
        "Justin Jefferson injury update: Linebacker suspended for hit on Vikings receiver",
        LB_JEFFERSON,
      ],
      ["Justin Jefferson status: Linebacker ejected for hit on Vikings star", LB_JEFFERSON],
      [
        "Justin Jefferson injury update: Browns linebacker fined for hit on Vikings star",
        LB_JEFFERSON,
      ],
      [
        "Marcus Harris injury update: Chiefs defensive tackle fined for hit on Titans corner",
        DT_HARRIS,
      ],
      ["Chris Jones injury update: Broncos cornerback fined for low hit on Chiefs DT", -1],
      ["Lamar Jackson injury update: Cornerback limited after a late hit on him", CB_LAMAR],
    ] as const) {
      expect(item(title), title).toEqual(NONE);
      expect(
        m.match(title).map((r) => r.espn_id),
        title,
      ).not.toContain(wrong === -1 ? cbJones() : wrong);
    }
  });

  it("the real captured title stays on the QB, and a clause about him keeps his label", () => {
    expect(
      refs(
        "Lamar Jackson injury update: Ravens QB dealing with ankle sprain; Week 5 status still unknown, per report",
      ),
    ).toEqual([[QB_LAMAR, "full_name"]]);
    expect(refs("Lamar Jackson injury update: Bengals CB dealing with ankle sprain")).toEqual([
      [CB_LAMAR, "full_name"],
    ]);
    expect(refs("Lamar Jackson injury update: Cornerback limited in practice Wednesday")).toEqual([
      [CB_LAMAR, "full_name"],
    ]);
    expect(refs("Lamar Jackson status: Ravens QB questionable, per John Harbaugh")).toEqual([
      [QB_LAMAR, "full_name"],
    ]);
    expect(refs("Chris Jones injury update: Chiefs DT dealing with knee soreness")).toEqual([
      [DT_JONES, "full_name"],
    ]);
    // the cost, as built: a clause about him that names the player he hit is no label either
    expect(item("Chris Jones injury update: Chiefs DT fined for hit on Broncos QB")).toEqual(NONE);
  });

  it("positionPhrasesNextTo marks the topic's clause; the rest of its sentence names no one else", () => {
    const at = (text: string, name: string) => {
      const start = text.indexOf(name);
      return news
        .positionPhrasesNextTo(text, start, start + name.length)
        .map((p) => text.slice(p.start, p.end));
    };
    expect(
      at("Lamar Jackson injury update: Ravens QB dealing with ankle sprain", "Lamar Jackson"),
    ).toEqual(["QB"]);
    for (const text of [
      "Lamar Jackson injury update: Steelers cornerback fined for hit on Ravens QB",
      "Lamar Jackson injury update: Ravens' top cornerback also ruled out",
      "Lamar Jackson injury update: Cornerback fined for hit on BAL QB",
      "Lamar Jackson injury update: CORNERBACK FINED FOR HIT ON RAVENS STAR",
      `Lamar Jackson injury update: Cornerback limited ${"and more ".repeat(30)}`,
    ])
      expect(at(text, "Lamar Jackson"), text).toEqual([]);
  });
});

describe("R3-V2 (clause 3): a result word in an idiom for a team's loss of its own player is no cue", () => {
  it("in any case, at a clause's opening, before 'until', or a passive's demand (each went to the other holder)", () => {
    for (const title of [
      "Byron Young: Injury a big loss to Eagles | Young (knee) will miss the rest of the season.",
      "Justin Jefferson: A big loss to Browns | Jefferson (knee) is out for the season.",
      "Justin Jefferson: Season-ending injury a big loss to Browns",
      "Justin Jefferson out for year - a big loss to Cleveland",
      "Justin Jefferson: Big loss to Browns as LB lands on IR",
      "Justin Jefferson: Lost to Browns until December | Jefferson (knee) underwent surgery Tuesday.",
      "Justin Jefferson: Pressured by Browns to take pay cut",
      "Marcus Harris: Injury a big loss to Chiefs | Harris (knee) is out for the season.",
      "Marcus Harris: Pressured by Chiefs to accept pay cut",
      "Byron Murphy: Injury a big loss to Vikings secondary | Murphy (hamstring) will miss four weeks.",
      "Byron Murphy: Injury a big loss to Seattle | Murphy (ankle) is out for the season.",
      "Michael Carter: Injury a big loss to Titans | Carter (ankle) will miss four weeks.",
      "Michael Carter: Injury a big loss to Eagles secondary",
      "Justin Jefferson Injury Is A Big Loss To Browns",
      "Justin Jefferson Is Lost To Browns With Torn ACL",
      "Justin Jefferson's Injury Is A Huge Loss To Cleveland",
      "Byron Young Injury Is A Big Loss To Eagles",
      "Marcus Harris Is Lost To Chiefs With Torn ACL",
      "JUSTIN JEFFERSON: KNEE INJURY IS A BIG LOSS TO BROWNS",
      "Justin Jefferson injury is a big loss to Browns",
      "Justin Jefferson is lost to Browns with torn ACL",
      // a dispute with his own side, before "against" (the fixer's own: each went to the WR)
      "Justin Jefferson: Holds out against Browns | Jefferson wants a new contract.",
      "Justin Jefferson: Arbitrator rules against Browns | Jefferson will receive his injury guarantee.",
      "NFL rules against Browns in Justin Jefferson appeal",
    ])
      expect(item(title), title).toEqual(NONE);
    // the holder off the team named never takes it, whichever holder that team is
    for (const [title, wrong] of [
      [
        "Byron Young: Injury a big loss to Eagles | Young (knee) will miss the rest of the season.",
        DE_YOUNG,
      ],
      [
        "Byron Murphy: Injury a big loss to Vikings secondary | Murphy (hamstring) will miss four weeks.",
        MURPHY_II,
      ],
      [
        "Byron Murphy: Injury a big loss to Seattle | Murphy (ankle) is out for the season.",
        MURPHY_JR,
      ],
      [
        "Michael Carter: Injury a big loss to Titans | Carter (ankle) will miss four weeks.",
        S_CARTER,
      ],
      ["Michael Carter: Injury a big loss to Eagles secondary", RB_CARTER],
    ] as const)
      expect(
        m.match(title).map((r) => r.espn_id),
        title,
      ).not.toContain(wrong);
  });

  it("a game stays a game: a preposition, a score or a possessive before 'loss to', in any case", () => {
    for (const title of [
      "Justin Jefferson: Catches TD | Jefferson caught two passes in a big loss to the Browns.",
      "Justin Jefferson: Catches TD | Jefferson caught two passes, a 24-20 loss to the Browns.",
      "Justin Jefferson: Catches TD | Jefferson caught two passes in Sunday's loss to the Browns.",
      "Justin Jefferson Catches Two TDs In Loss To Browns",
      "JUSTIN JEFFERSON: CATCHES TD IN LOSS TO BROWNS",
    ])
      expect(refs(title), title).toEqual([[WR_JEFFERSON, "full_name"]]);
  });
});

describe("R3-V2 (clause 2): 'injured' before a name is a label only before another label word", () => {
  it("the opponent's hit is no label (it was the WR at 0.95, as at f41e810)", () => {
    for (const title of [
      "Justin Jefferson: Carted off | A hit by the Vikings injured Justin Jefferson in the third quarter.",
      "Vikings injured Justin Jefferson's teammate",
    ]) {
      expect(refs(title), title).toEqual([]);
      expect(item(title), title).toEqual(NONE);
    }
    // as a label: before a position, or after a possessive
    expect(refs("Vikings injured WR Justin Jefferson: Out")).toEqual([
      [WR_JEFFERSON, "full_name_team"],
    ]);
    expect(refs("Minnesota's injured Justin Jefferson: Out")).toEqual([
      [WR_JEFFERSON, "full_name_team"],
    ]);
  });
});

describe("R3-V3 (clause 2): a roster move by his own team ties it, in every voice", () => {
  it("activated, placed on a reserve list, reinstated (no ref at 7b9572c)", () => {
    for (const [title, id] of [
      ["Justin Jefferson: Activated by Vikings", WR_JEFFERSON],
      ["Lamar Jackson: Activated by Ravens", QB_LAMAR],
      ["Byron Young: Activated by Rams", DE_YOUNG],
      ["Marcus Harris: Activated by Titans", CB_HARRIS],
      ["Justin Jefferson: Activated off IR by Vikings", WR_JEFFERSON],
      ["Justin Jefferson: Placed on IR by Vikings", WR_JEFFERSON],
      ["Lamar Jackson: Placed on injured reserve by Ravens", QB_LAMAR],
      ["Vikings place Justin Jefferson on injured reserve", WR_JEFFERSON],
      ["Ravens place Lamar Jackson on IR", QB_LAMAR],
      ["Justin Jefferson: Reinstated by Vikings", WR_JEFFERSON],
      ["Vikings reinstate Justin Jefferson", WR_JEFFERSON],
    ] as const)
      expect(refs(title), title).toEqual([[id, "full_name_team"]]);
  });

  it("the namesake's team's move is blocked by the star (choice 6), and a place that is no list is no move", () => {
    for (const title of [
      "Justin Jefferson: Placed on IR by Browns",
      "Browns place Justin Jefferson on IR",
      "Justin Jefferson: Activated by Browns",
      "Vikings place Justin Jefferson among top receivers",
    ])
      expect(item(title), title).toEqual(NONE);
  });
});

describe("R3-V4 (clause 2): a team attached to the name, in every label form", () => {
  it("'of the <team>', role nouns, a rank, 'top' after a possessive, a plural label's list (no ref or 0.80 at 7b9572c)", () => {
    for (const [title, id] of [
      ["Justin Jefferson of the Vikings: Questionable", WR_JEFFERSON],
      ["Justin Jefferson of the Minnesota Vikings is questionable for Sunday", WR_JEFFERSON],
      ["Lamar Jackson of the Ravens: Questionable", QB_LAMAR],
      ["Vikings superstar Justin Jefferson: Questionable", WR_JEFFERSON],
      ["Vikings playmaker Justin Jefferson: Questionable", WR_JEFFERSON],
      ["Vikings pass-catcher Justin Jefferson: Questionable", WR_JEFFERSON],
      ["Ravens superstar Lamar Jackson: Questionable", QB_LAMAR],
      ["Ravens MVP Lamar Jackson: Questionable", QB_LAMAR],
      ["Vikings' No. 1 receiver Justin Jefferson: Questionable", WR_JEFFERSON],
      ["Vikings' top receiver Justin Jefferson: Questionable", WR_JEFFERSON],
    ] as const)
      expect(refs(title), title).toEqual([[id, "full_name_team"]]);
    const addison = idOf("Jordan Addison", "MIN");
    expect(refs("Vikings WRs Jordan Addison and Justin Jefferson limited")).toEqual([
      [addison, "full_name_team"],
      [WR_JEFFERSON, "full_name_team"],
    ]);
    expect(refs("Vikings receivers Justin Jefferson and Jordan Addison limited")).toEqual([
      [WR_JEFFERSON, "full_name_team"],
      [addison, "full_name_team"],
    ]);
  });

  it("never across a verb, a clause, or a singular label before a list", () => {
    for (const title of [
      "Justin Jefferson, out of the Vikings' lineup, is day-to-day",
      "Vikings top Justin Jefferson: Questionable",
    ])
      expect(item(title), title).toEqual(NONE);
    // the singular "LB" labels Hicks alone; the plural attaches the Browns, and the star blocks
    // the namesake's item (choice 6): no ref for him either way, never the WR
    for (const title of [
      "Browns LB Jordan Hicks and Justin Jefferson limited",
      "Browns linebackers Jordan Hicks and Justin Jefferson limited",
    ])
      expect(item(title), title).toEqual({
        refs: [[idOf("Jordan Hicks", "CLE"), "full_name_team"]],
        unresolved: 1,
      });
  });
});

describe("R3-V5 (clause 3): 'at' between two teams names a game", () => {
  it("the star's game (no ref at 7b9572c; 0.95 at f41e810)", () => {
    for (const [title, id] of [
      ["Vikings at Bears: Justin Jefferson questionable", WR_JEFFERSON],
      ["Bears at Vikings: Justin Jefferson questionable", WR_JEFFERSON],
      ["Ravens at Steelers: Lamar Jackson questionable", QB_LAMAR],
    ] as const)
      expect(refs(title), title).toEqual([[id, "full_name"]]);
  });

  it("a game neither or both play in, or 'at' after one team, gives no ref", () => {
    for (const title of [
      "Bears at Lions: Justin Jefferson questionable",
      "Vikings at Browns: Justin Jefferson questionable",
      "Lamar Jackson: Questionable for Sunday's game at Pittsburgh",
    ])
      expect(item(title), title).toEqual(NONE);
  });
});

describe("R3-V6 (clause 3): a cue in a sentence is about its subject", () => {
  it("the subject, and the persons joined to him, keep their game past a teammate named after (no ref at 7b9572c)", () => {
    expect(
      refs(
        "Lamar Jackson: Three TDs | Jackson found Zay Flowers twice in the win over the Bengals.",
      ),
    ).toEqual([
      [QB_LAMAR, "full_name"],
      [idOf("Zay Flowers", "BAL"), "full_name"],
    ]);
    expect(
      refs(
        "Lamar Jackson: Three TDs | Jackson and Derrick Henry ran wild in the win over the Bengals.",
      ),
    ).toEqual([
      [QB_LAMAR, "full_name"],
      [idOf("Derrick Henry", "BAL"), "full_name"],
    ]);
    expect(
      refs(
        "Justin Jefferson: Catches TD | Jefferson and Jordan Addison combined for 200 yards in the win over the Browns.",
      ),
    ).toEqual([
      [WR_JEFFERSON, "full_name"],
      [idOf("Jordan Addison", "MIN"), "full_name"],
    ]);
  });

  it("a person named after the subject never takes his cue (the WR at 7b9572c: the Browns LB's item)", () => {
    expect(
      item(
        "Justin Jefferson: Struggles | Bijan Robinson ran past Justin Jefferson in the win over the Browns.",
      ),
    ).toEqual({ refs: [[idOf("Bijan Robinson", "ATL"), "full_name"]], unresolved: 1 });
    // a possessive one with another person after him is that person's
    expect(
      item(
        "Justin Jefferson: Released | Jefferson's former teammate Kirk Cousins threw two TDs in the win over the Browns.",
      ),
    ).toEqual({ refs: [[idOf("Kirk Cousins", "LV"), "full_name"]], unresolved: 1 });
    expect(
      refs("Justin Jefferson: Big day | Jefferson's two touchdowns led the win over the Browns."),
    ).toEqual([[WR_JEFFERSON, "full_name"]]);
  });

  it("another person between him and the cue anchors the game: that person's team's against the cued one", () => {
    const bijan = idOf("Bijan Robinson", "ATL");
    // the game is the Falcons' against the Browns, whichever side he is on: the WR is ruled out,
    // and the Browns LB left is outshone — no ref, never the WR (the WR at 0.80 before the anchor)
    for (const title of [
      "Justin Jefferson: Struggles | Justin Jefferson was no match for Bijan Robinson in the win over the Browns.",
      "Justin Jefferson: Struggles | Unlike Justin Jefferson, Bijan Robinson starred in the win over the Browns.",
    ])
      expect(item(title), title).toEqual({ refs: [[bijan, "full_name"]], unresolved: 1 });
    // a person of the cued team is that team's own player: the cue stands
    expect(
      refs("Lamar Jackson: Big day | Jackson outdueled Joe Burrow in the win over the Bengals."),
    ).toEqual([
      [idOf("Joe Burrow", "CIN"), "full_name_team"],
      [QB_LAMAR, "full_name"],
    ]);
    // a list ("A, B and C") is one subject; a person of no known team leaves the cue no evidence
    expect(
      refs(
        "Lamar Jackson: Big day | Jackson, Derrick Henry and Zay Flowers ran wild in the win over the Bengals.",
      ),
    ).toContainEqual([QB_LAMAR, "full_name"]);
    expect(
      item(
        "Lamar Jackson: Big day | Jackson found Van Jefferson twice in the win over the Bengals.",
      ),
    ).toEqual({ refs: [[idOf("Van Jefferson", null), "full_name"]], unresolved: 1 });
    // a bare comma is no list: the plural label attaches no team past it
    expect(item("Vikings WRs Jordan Addison, Justin Jefferson limited")).toEqual({
      refs: [[idOf("Jordan Addison", "MIN"), "full_name_team"]],
      unresolved: 1,
    });
  });
});

describe("R3-V7 (clause 1, choice 2 as built): a game in a sentence that names no one is the item's subject's", () => {
  it("whatever the punctuation (no ref at 7b9572c; 0.95 at f41e810)", () => {
    for (const [title, id] of [
      [
        "Lamar Jackson: Limited | Jackson (ankle) was limited; the Ravens visit the Bengals Sunday.",
        QB_LAMAR,
      ],
      [
        "Lamar Jackson: Limited | Jackson (ankle) was limited, and the Ravens visit the Bengals Sunday.",
        QB_LAMAR,
      ],
      [
        "Justin Jefferson: Questionable | Jefferson (hamstring) did not practice. Vikings vs. Bengals kicks off at noon.",
        WR_JEFFERSON,
      ],
      [
        "Justin Jefferson: Questionable | Jefferson (hamstring) is questionable; the Vikings host the Bengals Sunday.",
        WR_JEFFERSON,
      ],
    ] as const)
      expect(refs(title), title).toEqual([[id, "full_name"]]);
    // a team named before the cue in that sentence is its subject, as in any sentence
    expect(
      item(
        "Justin Jefferson: Out for season | Jefferson tore his ACL. Minnesota's offense struggled in the loss to the Browns.",
      ),
    ).toEqual(NONE);
  });
});

describe("R3-V8 (clause 3): play wording, its plain variants", () => {
  it("'for' and a number word, a singular defender, 'burned by' (no ref at 7b9572c)", () => {
    for (const [title, id] of [
      ["Lamar Jackson: Torches Bengals for three touchdowns", QB_LAMAR],
      ["Justin Jefferson: Torches Browns for two touchdowns", WR_JEFFERSON],
      ["Justin Jefferson: Burns Browns cornerback for 60-yard TD", WR_JEFFERSON],
      ["Justin Jefferson: Torches Browns CB for two touchdowns", WR_JEFFERSON],
      ["Justin Jefferson: Beats Browns safety for long touchdown", WR_JEFFERSON],
      ["Marcus Harris: Burned by Chiefs receiver for touchdown", CB_HARRIS],
    ] as const)
      expect(
        m
          .match(title)
          .filter((r) => r.espn_id === id)
          .map((r) => r.match_method),
        title,
      ).toEqual(["full_name"]);
  });

  it("never a word that is no number, nor a player that only modifies a noun", () => {
    for (const title of [
      "Justin Jefferson: Torches Browns for a lack of support",
      "Justin Jefferson: Torches Browns' linebacker depth",
    ])
      expect(item(title), title).toEqual(NONE);
  });
});

describe("R3-V10 (clause 6): a letter before a period is an initial or a time, never a position", () => {
  it("the residual is kept past '1 P.M.', 'P.J.', 'K.J.', 'S.' (no ref at 7b9572c)", () => {
    for (const title of [
      "Lamar Jackson: Questionable for Sunday's 1 P.M. kickoff | Jackson (ankle) was limited.",
      "Lamar Jackson: Throws three touchdowns | Jackson found P.J. Walker twice.",
      "Lamar Jackson: Ruled out | Jackson (knee) will not play, coach John Harbaugh said at a 2 P.M. news conference.",
      "Lamar Jackson: Throws TD to S. Smith",
    ])
      expect(
        m.match(title).filter((r) => r.espn_id === QB_LAMAR || r.espn_id === CB_LAMAR),
        title,
      ).toEqual([expect.objectContaining({ espn_id: QB_LAMAR, match_method: "full_name" })]);
    expect(
      refs(
        "Justin Jefferson: Placed on IR | Jefferson (knee) will miss at least four games, per P.J. Smith.",
      ),
    ).toContainEqual([WR_JEFFERSON, "full_name"]);
    expect(
      refs("Lamar Jackson: Throws two TDs | Jackson hit K.J. Osborn and Isaiah Likely for scores."),
    ).toContainEqual([QB_LAMAR, "full_name"]);
    expect(news.positionWordSpans("Sunday's 1 P.M. kickoff, per P.J. Smith and S. Smith")).toEqual(
      [],
    );
  });

  it("…and a team named loosely still makes the item no residual (0.95 at f41e810)", () => {
    for (const title of [
      "Lamar Jackson: Questionable for Sunday's 1 P.M. kickoff | The Ravens are thin at receiver.",
      "Lamar Jackson: Questionable for Sunday's 1 P.M. kickoff | Baltimore travels to Pittsburgh.",
    ]) {
      expect(refs(title), title).toEqual([]);
      expect(item(title), title).toEqual(NONE);
    }
  });
});

describe("R3-V11 (clause 4): writing a holder's own position never costs him a ref", () => {
  it("the surname's prominence is judged over every sharer (no ref at 7b9572c)", () => {
    for (const [withPosition, without, id] of [
      [
        "Vikings S Smith: Out for Sunday",
        "Vikings' Smith: Out for Sunday",
        idOf("Harrison Smith", "MIN"),
      ],
      [
        "Vikings safety Smith: Out for Sunday",
        "Vikings' Smith: Out for Sunday",
        idOf("Harrison Smith", "MIN"),
      ],
      ["Broncos LB Bailey: Out", "Broncos' Bailey: Out", idOf("Levelle Bailey", "DEN")],
      [
        "Chiefs WR Allen: Out for Sunday",
        "Chiefs' Allen: Out for Sunday",
        idOf("Cyrus Allen", "KC"),
      ],
      [
        "Giants TE Johnson: Out for Sunday",
        "Giants' Johnson: Out for Sunday",
        idOf("Theo Johnson", "NYG"),
      ],
      [
        "Lions WR Robinson: Out for Sunday",
        "Lions' Robinson: Out for Sunday",
        idOf("Allen Robinson", "DET"),
      ],
    ] as const) {
      expect(refs(without), without).toEqual([[id, "last_name_team"]]);
      expect(refs(withPosition), withPosition).toEqual([[id, "last_name_team"]]);
    }
  });
});

describe("R3-V12 (clause 4): the surname never gives what the full name refuses", () => {
  it("his own full name's prominent holder blocks him on both paths (the namesake at 0.60 at 7b9572c)", () => {
    for (const [surname, full] of [
      ["Eagles' Young: Two sacks", "Eagles' Byron Young: Two sacks"],
      ["Philadelphia's Young: Placed on IR", "Philadelphia's Byron Young: Placed on IR"],
      ["Eagles DT Young: Records sack", "Eagles DT Byron Young: Records sack"],
      ["Eagles DE Young: Two sacks", "Eagles DE Byron Young: Two sacks"],
      ["Chiefs' Harris: Records sack", "Chiefs' Marcus Harris: Records sack"],
      ["Kansas City's Harris: Placed on IR", "Kansas City's Marcus Harris: Placed on IR"],
    ] as const) {
      expect(item(full), full).toEqual(NONE);
      expect(item(surname), surname).toEqual(NONE);
    }
    // a cue that rules his prominent namesake out lifts the block on both paths (fix round 2)
    expect(refs("Eagles' Young: Sacks Rams QB")).toEqual([[DT_YOUNG, "last_name_team"]]);
    expect(refs("Eagles' Byron Young: Sacks Rams QB")).toEqual([[DT_YOUNG, "full_name_team"]]);
  });
});

describe("R3-V13 (clauses 4, 5): a position written next to a shared surname is evidence", () => {
  it("it places the one sharer it leaves (no ref at 7b9572c and at f41e810)", () => {
    expect(refs("LB Jefferson: Records sack")).toEqual([[LB_JEFFERSON, "last_name_team"]]);
    expect(refs("Linebacker Jefferson: Placed on IR")).toEqual([[LB_JEFFERSON, "last_name_team"]]);
    expect(refs("QB Jackson: Limited in practice")).toEqual([[QB_LAMAR, "last_name_team"]]);
    // its full-name twins, for the record
    expect(refs("LB Justin Jefferson: Records sack")).toEqual([[LB_JEFFERSON, "full_name"]]);
    expect(refs("QB Lamar Jackson: Limited in practice")).toEqual([[QB_LAMAR, "full_name"]]);
  });

  it("one several sharers fit picks none, and is counted (unresolved 0 at 7b9572c)", () => {
    for (const title of ["DT Harris: Records sack", "Edge Young: Two sacks"])
      expect(item(title), title).toEqual(NONE);
    expect(item("Ja'Marr Chase: Catches two TDs | WR Jefferson added 100 yards.")).toEqual({
      refs: [[idOf("Ja'Marr Chase", "CIN"), "full_name"]],
      unresolved: 1,
    });
    expect(item("Ja'Marr Chase: Catches two TDs | DT Harris added a sack.")).toEqual({
      refs: [[idOf("Ja'Marr Chase", "CIN"), "full_name"]],
      unresolved: 1,
    });
    // the one sharer LB fits takes it, beside another ref
    expect(item("Myles Garrett: Two sacks | LB Jefferson added one.")).toEqual({
      refs: [
        [idOf("Myles Garrett", "LA"), "full_name"],
        [LB_JEFFERSON, "last_name_team"],
      ],
      unresolved: 0,
    });
    expect(item("Kirk Cousins: Sacked by LB Jefferson")).toEqual({
      refs: [
        [idOf("Kirk Cousins", "LV"), "full_name"],
        [LB_JEFFERSON, "last_name_team"],
      ],
      unresolved: 0,
    });
    // a surname with no team, no position and no team in the item is no mention evidence could resolve
    expect(item("Jackson: Limited").unresolved).toBe(0);
  });

  it("the news build counts such an item, beside its other ref", () => {
    const b = news.buildNewsRows({
      format: news.NEWS_FILE_FORMAT,
      source: "rotowire",
      fetched_ms: Date.parse("2026-10-06T20:00:00.000Z"),
      xml: `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><item><title>Ja'Marr Chase: Catches two TDs</title><description>WR Jefferson added 100 yards.</description><guid>a</guid><link>https://www.rotowire.com/football/player/x-1</link><pubDate>Tue, 06 Oct 2026 18:00:00 GMT</pubDate></item></channel></rss>`,
      universe,
      previous: [],
      warnings: [],
    });
    expect(b.counts).toMatchObject({ unmatched: 0, unresolved: 1 });
  });
});

/**
 * Every list that decides whether a cue, a label or a roster move holds, as the tests hold it:
 * compared word for word with the source, and each entry run through a behaviour below, so
 * deleting one fails both (the attack deleted 120 entries of two lists, and no test failed).
 */
const HELD: Readonly<Record<string, readonly string[]>> = {
  // prettier-ignore
  PLAY_OBJECTS: [
      "qb", "qbs", "quarterback", "quarterbacks", "passer", "passers", "signal-caller", "pass",
      "passes", "throw", "throws", "rb", "running back", "running backs", "runner", "runners",
      "rusher", "rushers", "ball carrier", "ball carriers", "back", "backs", "wr", "receiver",
      "receivers", "wideout", "wideouts", "te", "tight end", "tight ends", "offense",
      "offensive line", "o-line", "line", "front", "front seven", "defense", "defensive line",
      "d-line", "secondary", "cornerbacks", "corners", "safeties", "linebackers", "defensive backs",
      "pass rush", "pass defense", "run defense", "coverage", "punt", "punts", "punter", "kick",
      "kicks", "kicker", "field goal", "field-goal", "extra point", "fumble", "snap", "snaps",
      "returner", "starter", "starters", "star",
      "cornerback", "corner", "cb", "cbs", "safety", "linebacker", "lb", "lbs", "db", "dbs",
      "defensive back", "defender", "defenders", "nickelback", "nickel back", "pass rusher",
      "pass rushers", "edge rusher", "edge rushers", "defensive end", "defensive ends",
      "defensive tackle", "defensive tackles", "defensive lineman", "defensive linemen",
      "left tackle", "right tackle", "rbs", "wrs", "tes", "returners", "punters", "kickers", "stars",
    ],
  // prettier-ignore
  CUE_CONTINUATIONS: [
      "a", "an", "the", "on", "in", "at", "by", "with", "without", "to", "for", "from", "of", "into",
      "over", "under", "after", "before", "during", "despite", "behind", "since", "until", "through",
      "throughout", "amid", "via", "following", "as", "and", "or", "but", "nor", "while", "when",
      "where", "which", "who", "whose", "that", "this", "these", "if", "because", "although",
      "though", "so", "yet", "then", "again", "twice", "once", "thrice", "too", "also", "even",
      "only", "just", "now", "here", "there", "last", "next", "earlier", "later", "early", "late",
      "yesterday", "today", "tonight", "week", "weekend", "season", "night", "thanks", "en", "home",
      "away", "times", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
      "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
    ],
  // prettier-ignore
  NUMBER_WORDS: [
      "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    ],
  // prettier-ignore
  DURATION_WORDS: ["for", "until", "till"],
  // prettier-ignore
  DRAFT_WORDS: ["round", "draft", "pick", "overall", "selection"],
  // prettier-ignore
  DISPUTE_WORDS: [
      "grievance", "grievances", "lawsuit", "lawsuits", "suit", "complaint", "complaints", "appeal",
      "claim", "claims", "case", "charge", "charges", "ruling", "decision", "fine", "discipline",
      "action", "motion", "protest", "arbitration", "hearing", "testimony", "holds out", "held out",
      "holding out", "hold out", "rules", "ruled", "decides", "decided", "sides", "sided",
      "testifies", "testified",
    ],
  // prettier-ignore
  COPULAS: [
      "is", "was", "are", "were", "be", "been", "being", "remains", "remained", "represents",
      "represented", "becomes", "became",
    ],
  // prettier-ignore
  GAME_PREPOSITIONS: [
      "in", "after", "during", "despite", "following", "since", "before", "from", "off", "with",
      "without", "amid", "through", "into", "on", "of", "by", "over", "under", "at", "to", "for",
      "upon", "behind", "until", "around", "against", "via", "within", "throughout", "toward",
      "towards",
    ],
  // prettier-ignore
  LOSS_DEGREE_WORDS: [
      "big", "bigger", "biggest", "huge", "major", "massive", "significant", "serious", "tough",
      "crushing", "devastating", "brutal", "costly", "key", "notable", "sizable", "considerable",
      "substantial", "enormous", "real", "potential", "possible", "early", "season-long", "long-term",
      "short-term", "temporary",
    ],
  // prettier-ignore
  PAIR_GAME_WORDS: [
      "game", "matchup", "contest", "meeting", "clash", "showdown", "tilt",
    ],
  // prettier-ignore
  PASSIVE_PURPOSE_WORDS: ["to", "into"],
  // prettier-ignore
  LABEL_ROLE_NOUNS: [
      "superstar", "playmaker", "pass-catcher", "pass catcher", "mvp", "captain",
    ],
  // prettier-ignore
  LABEL_PLURALS: [
      "qbs", "rbs", "wrs", "tes", "lbs", "olbs", "ilbs", "cbs", "dbs", "des", "dts", "dls",
      "quarterbacks", "running backs", "receivers", "wide receivers", "wideouts", "tight ends",
      "linebackers", "cornerbacks", "corners", "safeties", "defensive ends", "defensive tackles",
      "defensive backs", "defensive linemen", "pass rushers", "edge rushers", "kickers", "punters",
      "stars", "starters", "rookies", "veterans", "backups", "teammates", "playmakers",
      "pass-catchers", "captains",
    ],
  // prettier-ignore
  VERB_LIKE_LABELS: ["lead", "top", "injured"],
  // prettier-ignore
  RESERVE_LISTS: [
      "IR", "injured reserve", "reserve/injured", "reserve/PUP", "reserve/NFI", "reserve/suspended",
      "PUP", "PUP list", "NFI", "NFI list", "non-football injury list",
      "physically unable to perform list", "exempt list", "commissioner's exempt list",
      "practice squad injured list", "waivers",
    ],
  // prettier-ignore
  SHARED_TEAM_MOVE_WORDS: ["reinstate", "reinstates", "reinstated"],
  // prettier-ignore
  PLACE_WORDS: ["place", "places", "placed", "put", "puts"],
  // prettier-ignore
  SHARED_PLAYER_MOVE_WORDS: ["activated", "reinstated"],
  // prettier-ignore
  SECOND_PLAYER_WORDS: [
      "also", "too", "another", "other", "fellow", "teammate", "teammates", "opponent", "opponents",
      "rival", "rivals", "counterpart", "replacement", "star", "stars", "superstar", "starter",
      "starters", "backup", "backups", "rookie", "veteran", "him",
    ],
  // prettier-ignore
  PLAY_GAP_WORDS: [
      "has", "had", "have", "was", "were", "is", "also", "again", "then", "later", "nearly", "almost",
      "just", "once", "twice", "both",
    ],
  // the position lists a cue or a label reads (positions.ts)
  // prettier-ignore
  POSITION_COMPOUND_HEADS: [
      "injury", "injuries", "coverage", "depth", "corps", "room", "group", "groups", "unit", "units",
      "play", "position", "positions", "spot", "spots", "battle", "battles", "competition",
      "rotation", "rotations", "duties", "coach", "coaches", "market", "class", "classes",
      "prospect", "prospects", "ranking", "rankings", "stats", "matchup", "matchups", "help",
      "need", "needs", "upgrade", "upgrades", "situation", "carousel", "controversy", "chart",
      "charts", "pool", "pools", "trade", "trades", "options", "landscape",
    ],
  // prettier-ignore
  HEADLINE_TOPICS: [
      "injury update", "injury news", "injury status", "injury report", "update", "status",
      "status update", "outlook", "news", "latest", "health update", "contract update",
      "practice update", "practice report",
    ],
  // prettier-ignore
  POSITION_MODIFIERS: [
      "star", "rookie", "veteran", "backup", "starting", "reserve", "former", "free-agent",
      "free agent", "undrafted", "young", "standout", "All-Pro", "Pro Bowl", "top", "new", "newest",
      "longtime", "talented", "versatile", "reigning", "injured", "promising", "primary", "lead",
      "first-year", "second-year", "third-year", "fourth-year", "fifth-year", "sixth-year",
      "seventh-year", "eighth-year", "ninth-year", "tenth-year", "two-time", "three-time",
      "four-time", "five-time", "six-time",
    ],
};
/** One held list (a name not held is a test's own error). */
const held = (name: string): readonly string[] => {
  const words = HELD[name];
  if (words === undefined) throw new Error(`no held list ${name}`);
  return words;
};

describe("R3-V9 (clause 3: a closed, tested list): every list that decides a cue, a label or a move", () => {
  // each list word for word, so deleting an entry fails here; then entry by entry, so it fails a
  // behaviour too wherever an entry alone decides one
  it("word for word", () => {
    for (const [name, words] of Object.entries(HELD)) expect(list(name), name).toEqual(words);
  });

  it("entry by entry: a play's object, a cue's continuation, a play's number", () => {
    const WR = [[WR_JEFFERSON, "full_name"]];
    for (const obj of held("PLAY_OBJECTS")) {
      const star = `Justin Jefferson: Big day | Jefferson torched the Browns ${obj} twice.`;
      expect(refs(star), star).toEqual(WR);
      const namesake = `Justin Jefferson: Big day | Jefferson torched the Vikings ${obj} twice.`;
      expect(item(namesake), namesake).toEqual(NONE);
    }
    for (const w of held("CUE_CONTINUATIONS")) {
      const star = `Justin Jefferson: Big day | Jefferson caught two passes against the Browns ${w} xyz.`;
      expect(refs(star), star).toEqual(WR);
      const namesake = `Justin Jefferson: Big day | Jefferson caught two passes against the Vikings ${w} xyz.`;
      expect(item(namesake), namesake).toEqual(NONE);
    }
    for (const n of held("NUMBER_WORDS")) {
      expect(refs(`Justin Jefferson: Torches Browns for ${n} touchdowns`), n).toEqual(WR);
      expect(item(`Justin Jefferson: Torches Vikings for ${n} touchdowns`), n).toEqual(NONE);
    }
    for (const gap of held("PLAY_GAP_WORDS")) {
      const star = `Justin Jefferson: Big day | Jefferson ${gap} torched the Browns secondary.`;
      expect(refs(star), star).toEqual(WR);
    }
  });

  it("entry by entry: the idioms and the disputes that name his own side", () => {
    const WR = [[WR_JEFFERSON, "full_name"]];
    for (const w of ["for", "until"]) {
      const text = `Justin Jefferson: Big day | Jefferson caught two passes in the win over the Browns ${w} the season.`;
      expect(item(text), text).toEqual(NONE);
    }
    for (const w of held("DRAFT_WORDS")) {
      const text = `Justin Jefferson: Big day | Jefferson beat the Browns in the ${w} race.`;
      expect(item(text), text).toEqual(NONE);
    }
    for (const w of held("DISPUTE_WORDS")) {
      const text = `Justin Jefferson: Big day | Jefferson ${w} against the Browns.`;
      expect(item(text), text).toEqual(NONE);
    }
    for (const c of held("COPULAS")) {
      const loss = `Justin Jefferson: Out | The injury ${c} the biggest loss to the Browns.`;
      expect(item(loss), loss).toEqual(NONE);
      const lost = `Justin Jefferson: Out | Jefferson ${c} lost to the Browns.`;
      expect(item(lost), lost).toEqual(NONE);
    }
    for (const p of held("GAME_PREPOSITIONS")) {
      const text = `Justin Jefferson: Catches TD | Jefferson caught two passes ${p} a big loss to the Browns.`;
      expect(refs(text), text).toEqual(WR);
    }
    for (const d of held("LOSS_DEGREE_WORDS")) {
      const text = `Justin Jefferson out for year - ${d} loss to Browns as Jefferson lands on IR`;
      expect(item(text), text).toEqual(NONE);
    }
    for (const w of held("PASSIVE_PURPOSE_WORDS")) {
      const text = `Justin Jefferson: Pressured by Browns ${w} taking pay cut`;
      expect(item(text), text).toEqual(NONE);
    }
    for (const w of held("PAIR_GAME_WORDS")) {
      const text = `Justin Jefferson: Questionable | Jefferson (hamstring) is questionable ahead of the Bengals' ${w} versus the Vikings.`;
      expect(refs(text), text).toEqual(WR);
    }
  });

  it("entry by entry: the labels, the lists and the roster moves", () => {
    const WR = [[WR_JEFFERSON, "full_name_team"]];
    for (const n of held("LABEL_ROLE_NOUNS")) {
      const text = `Vikings ${n} Justin Jefferson: Questionable`;
      expect(refs(text), text).toEqual(WR);
    }
    const addison = idOf("Jordan Addison", "MIN");
    for (const pl of held("LABEL_PLURALS")) {
      const text = `Vikings ${pl} Jordan Addison and Justin Jefferson limited`;
      expect(refs(text), text).toEqual([[addison, "full_name_team"], ...WR]);
    }
    for (const w of held("VERB_LIKE_LABELS")) {
      expect(refs(`Vikings' ${w} receiver Justin Jefferson: Questionable`), w).toEqual(WR);
      expect(item(`A hit by the Vikings ${w} Justin Jefferson: Questionable`), w).toEqual(NONE);
    }
    for (const l of held("RESERVE_LISTS")) {
      expect(refs(`Justin Jefferson: Placed on ${l} by Vikings`), l).toEqual(WR);
      expect(refs(`Justin Jefferson: Activated off ${l} by Vikings`), l).toEqual(WR);
      expect(refs(`Vikings place Justin Jefferson on ${l}`), l).toEqual(WR);
    }
    for (const w of held("SHARED_TEAM_MOVE_WORDS"))
      expect(refs(`Vikings ${w} Justin Jefferson`), w).toEqual(WR);
    for (const w of held("PLACE_WORDS"))
      expect(refs(`Vikings ${w} Justin Jefferson on injured reserve`), w).toEqual(WR);
    for (const w of held("SHARED_PLAYER_MOVE_WORDS")) {
      const word = w.charAt(0).toUpperCase() + w.slice(1);
      expect(refs(`Justin Jefferson: ${word} by Vikings`), w).toEqual(WR);
    }
    for (const w of held("SECOND_PLAYER_WORDS")) {
      const text = `Lamar Jackson injury update: Cornerback limited in practice Wednesday ${w}`;
      expect(item(text), text).toEqual(NONE);
    }
  });
});

describe("R3-V14 (robustness): the shared-name reading is linear in an item's teams", () => {
  it("the attack's item keeps every abbreviation and team, read once each", () => {
    // the work is timed in match.perf.test.ts (the process project); here, what it reads
    const cap = (s: string, n: number) => s.slice(0, n);
    const text = `${cap(`Justin Jefferson ${"NE ".repeat(400)}`, 1000)} | ${cap("Jets ".repeat(900), 4000)}`;
    const ms = news.sharedMentions(text);
    expect(ms.every((x) => x.team === "NYJ")).toBe(true);
    expect(ms).toHaveLength(800);
    expect(item(text)).toEqual(NONE);
    // a game's first side is read against the next team only ("MIN vs. CLE")
    expect(
      news.sharedMentions("MIN NE vs. CLE").map((x) => [x.team, x.pair?.team ?? null]),
    ).toEqual([
      ["NE", "CLE"],
      ["CLE", "NE"],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------
// Properties over the recorded universe's shared names (R8-3: an item whose evidence points to one
// holder never goes to another holder; an item with no evidence follows clause 6).

const SHARED: readonly (readonly NewsUniversePlayer[])[] = (() => {
  const byKey = new Map<string, NewsUniversePlayer[]>();
  for (const p of universe) {
    const k = mergeName(p.full_name);
    if (k === null || k.split(" ").length < 2) continue;
    byKey.set(k, [...(byKey.get(k) ?? []), p]);
  }
  return [...byKey.values()].filter((hs) => hs.length > 1);
})();
const SURNAMES: readonly (readonly NewsUniversePlayer[])[] = (() => {
  const bySurname = new Map<string, NewsUniversePlayer[]>();
  for (const p of universe) {
    const k = mergeName(p.full_name);
    const s = k?.split(" ");
    if (s === undefined || s.length < 2) continue;
    const last = s[s.length - 1] ?? "";
    bySurname.set(last, [...(bySurname.get(last) ?? []), p]);
  }
  return [...bySurname.values()].filter((hs) => hs.length > 1);
})();
const NICK: ReadonlyMap<NflTeam, string> = new Map(
  Object.entries(TEAM_NICKNAMES)
    .filter(([n]) => !["Jags", "Pats", "Niners", "Bucs"].includes(n))
    .map(([n, t]): [NflTeam, string] => [t, n]),
);
const nick = (t: NflTeam | null): string => (t === null ? "" : (NICK.get(t) ?? ""));
const plain = (p: NewsUniversePlayer): string =>
  p.full_name.replace(/\s+(?:Jr\.?|Sr\.?|II|III|IV|V)$/u, "");
const surnameOf = (p: NewsUniversePlayer): string => plain(p).split(" ").at(-1) ?? "";
/** ESPN's position abbreviation (src/domain/league/slots.ts POSITION_NAMES), as a writer labels him. */
const ABBREVIATION: Readonly<Record<number, string>> = {
  1: "QB",
  2: "RB",
  3: "WR",
  4: "TE",
  5: "K",
  7: "P",
  9: "DT",
  10: "DE",
  11: "LB",
  12: "CB",
  13: "S",
};
/** A word only his position fits among the holders (the position's evidence points to him). */
const ownWord = (h: NewsUniversePlayer, hs: readonly NewsUniversePlayer[]): string | null => {
  const a = h.position_id == null ? undefined : ABBREVIATION[h.position_id];
  if (a === undefined) return null;
  const ids = (news.POSITION_WORDS as Record<string, readonly number[]>)[a.toLowerCase()] ?? [];
  return hs.every((o) => o === h || o.position_id == null || !ids.includes(o.position_id))
    ? a
    : null;
};
const owned = (p: NewsUniversePlayer): number => p.percent_owned ?? 0;
function prominentOf(hs: readonly NewsUniversePlayer[]): NewsUniversePlayer | null {
  const [top, ...rest] = [...hs].sort((a, b) => owned(b) - owned(a));
  return top !== undefined && owned(top) >= 1 && rest.every((p) => owned(top) >= 10 * owned(p))
    ? top
    : null;
}
const idsOf = (text: string): number[] => m.match(text).map((r) => r.espn_id);

describe("properties (fix round 3)", () => {
  it("property: an item whose round-3 evidence points to one holder never goes to another holder", () => {
    // his team in a roster move, "of the", a role noun, a rank or a list; a game at his team's; his
    // own cue as the sentence's subject past a unique teammate; his position in a topic's clause
    const teammates = new Map<NflTeam, string>();
    for (const p of universe)
      if (p.team !== null && !teammates.has(p.team) && !/['’.-]/u.test(p.full_name)) {
        const k = mergeName(p.full_name);
        if (k !== null && universe.filter((q) => mergeName(q.full_name) === k).length === 1)
          teammates.set(p.team, p.full_name);
      }
    const pairs = SHARED.flatMap((hs) => hs.map((h) => ({ h, hs })));
    const away = (taken: readonly (NflTeam | null)[]): NflTeam | undefined =>
      [...NICK.keys()].find((t) => !taken.includes(t));
    fc.assert(
      fc.property(fc.constantFrom(...pairs), fc.nat(), ({ h, hs }, pick) => {
        const others = hs.filter((o) => o !== h);
        const name = plain(h);
        const sn = surnameOf(h);
        const forms: string[] = [];
        const T = h.team;
        if (T !== null && others.every((o) => o.team !== T)) {
          const t = nick(T);
          forms.push(
            `${name}: Activated by ${t}`,
            `${name}: Placed on IR by ${t}`,
            `${name}: Reinstated by ${t}`,
            `${t} place ${name} on injured reserve`,
            `${name} of the ${t}: Questionable`,
            `${t} superstar ${name}: Questionable`,
            `${t}' No. 1 starter ${name}: Questionable`,
          );
          const mate = teammates.get(T);
          if (mate !== undefined) forms.push(`${t} stars ${mate} and ${name} limited`);
          const x = away([T, ...others.map((o) => o.team)]);
          if (x !== undefined) forms.push(`${t} at ${nick(x)}: ${name} questionable`);
          const cued = [...new Set(others.map((o) => o.team))];
          const only = cued.length === 1 ? cued[0] : undefined;
          if (only !== undefined && only !== null && mate !== undefined)
            forms.push(
              `${name}: Big day | ${sn} found ${mate} twice in the win over the ${nick(only)}.`,
            );
        }
        const w = ownWord(h, hs);
        if (w !== null) forms.push(`${name} injury update: ${w} dealing with ankle sprain`);
        if (forms.length === 0) return;
        const text = forms[pick % forms.length] ?? "";
        const got = idsOf(text);
        for (const o of others) expect(got, text).not.toContain(o.espn_id);
      }),
      { numRuns: 1_000 },
    );
  });

  it("property: a team in an idiom for its loss of a player, or a demand, is evidence for no holder off it", () => {
    const teams = [...NICK.keys()];
    fc.assert(
      fc.property(
        fc.constantFrom(...SHARED),
        fc.constantFrom(...teams),
        fc.constantFrom(
          (n: string, t: string) =>
            `${n}: Injury a big loss to ${t} | The knee injury ends his season.`,
          (n: string, t: string) => `${n}: A big loss to ${t}`,
          (n: string, t: string) => `${n} Injury Is A Big Loss To ${t}`,
          (n: string, t: string) => `${n} Is Lost To ${t} With Torn ACL`,
          (n: string, t: string) => `${n}: Lost to ${t} until December`,
          (n: string, t: string) => `${n}: Pressured by ${t} to take pay cut`,
          (n: string, t: string) => `${n}: Holds out against ${t}`,
          (n: string, t: string) => `${n} injury update: Linebacker fined for hit on ${t} QB`,
        ),
        (hs, team, form) => {
          const first = hs[0];
          if (first === undefined) return;
          const text = form(plain(first), nick(team));
          const got = idsOf(text);
          for (const h of hs) if (h.team !== team) expect(got, text).not.toContain(h.espn_id);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("property: an item with no evidence follows clause 6 past an initial or a time", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SHARED),
        fc.constantFrom(
          "Questionable for Sunday's 1 P.M. kickoff",
          "Limited, per P.J. Smith",
          "Throws to K.J. Osborn",
          "Out for the 4 P.M. game",
        ),
        (hs, headline) => {
          const first = hs[0];
          if (first === undefined) return;
          const text = `${plain(first)}: ${headline} | ${surnameOf(first)} was limited.`;
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
      { numRuns: 200 },
    );
  });

  it("exhaustive: writing a sharer's own position next to his surname or name never costs his ref", () => {
    // every shared surname and full name, every holder on a team: what "<team>' <name>" gives him,
    // "<team> <his position> <name>" gives him too (the attack's sweep found 78 such losses)
    let checked = 0;
    for (const hs of [...SURNAMES, ...SHARED])
      for (const h of hs) {
        const pos = h.position_id == null ? undefined : ABBREVIATION[h.position_id];
        if (h.team === null || pos === undefined) continue;
        const name = SURNAMES.includes(hs) ? surnameOf(h) : plain(h);
        const without = `${nick(h.team)}' ${name}: Out for Sunday`;
        if (!idsOf(without).includes(h.espn_id)) continue;
        checked++;
        const written = `${nick(h.team)} ${pos} ${name}: Out for Sunday`;
        expect(idsOf(written), written).toContain(h.espn_id);
      }
    expect(checked).toBeGreaterThan(500);
  });

  it("exhaustive: a surname never gives a sharer what his full name refuses him", () => {
    let refused = 0;
    for (const hs of SURNAMES)
      for (const h of hs) {
        if (h.team === null) continue;
        const kin = universe.filter((q) => mergeName(q.full_name) === mergeName(h.full_name));
        if (kin.length < 2) continue;
        for (const tail of ["Records sack", "Placed on IR", "Two sacks"]) {
          const full = `${nick(h.team)}' ${plain(h)}: ${tail}`;
          if (idsOf(full).includes(h.espn_id)) continue;
          refused++;
          const bare = `${nick(h.team)}' ${surnameOf(h)}: ${tail}`;
          expect(idsOf(bare), bare).not.toContain(h.espn_id);
        }
      }
    // the Browns LB, the Eagles DT and the Chiefs DT among them
    expect(refused).toBeGreaterThanOrEqual(9);
  });
});
