// match-r86.test.ts — ruling R8-6 (docs/plan/changelog.md §R8): the news matcher fails closed for a
// name more than one universe player holds (src/sources/news/match.ts, labels.ts, positions.ts).
// (a) only a label written next to the name picks a holder; (b) the prominent holder takes the item
// at full_name only when the broad scan finds no team and no position anywhere; (c) nothing else
// picks or raises a holder; (d) otherwise no one takes the name, and the item is counted. Names one
// universe player holds match exactly as at f41e810 (the frozen oracle in ./f41e810/). Each clause has
// tests that fail on the code at dbe9686 where its behaviour changed, and on f41e810 where that
// differs; only exports f41e810 already had are read at the top level, so old code fails test by
// test. Every closed list is held word for word and entry by entry. No network.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { mergeName } from "../../../src/domain/crosswalk/normalize.js";
import type { NflTeam } from "../../../src/config/schema.js";
import { NFL_TEAMS } from "../../../src/config/schema.js";
import { playersRows } from "../../../src/sources/espn_season/index.js";
import * as news from "../../../src/sources/news/index.js";
import {
  buildPlayerMatcher,
  universeFromEspnPlayers,
  type NewsPlayerRef,
  type NewsUniversePlayer,
  type PlayerMatcher,
} from "../../../src/sources/news/index.js";
import * as f41e810 from "./f41e810/match.js";
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
const byId = new Map(universe.map((p) => [p.espn_id, p]));
const POS: Readonly<Record<number, string>> = {
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
/** A universe player as the batteries write him: "Justin Jefferson/CLE/LB". */
const tagOf = (id: number): string => {
  const p = byId.get(id);
  return p === undefined
    ? String(id)
    : `${p.full_name}/${p.team ?? "FA"}/${POS[p.position_id ?? -1] ?? "?"}`;
};
const show = (refs: readonly NewsPlayerRef[]): string =>
  refs.map((r) => `${tagOf(r.espn_id)}:${r.match_method}`).join(", ") || "∅";
/** An item's R8-6 outcome: its refs, then how many shared names no one took ("∅ u1"). */
const outcome = (text: string): string => {
  // the refs through `match` (f41e810 had it), so old code fails on its refs where they differ
  const counted = (m as Partial<PlayerMatcher>).matchItem?.(text).unresolved;
  return `${show(m.match(text))} u${counted === undefined ? "?" : String(counted)}`;
};

/** The universe player of `name` on `team` (null = a free agent). */
function idOf(name: string, team: string | null): number {
  const p = universe.filter((x) => x.full_name === name && x.team === team);
  if (p.length !== 1 || p[0] === undefined) throw new Error(`${name} ${String(team)}`);
  return p[0].espn_id;
}
const QB_LAMAR = idOf("Lamar Jackson", "BAL");
const WR_JEFFERSON = idOf("Justin Jefferson", "MIN");
const LB_JEFFERSON = idOf("Justin Jefferson", "CLE");

// -----------------------------------------------------------------------------------------------
describe("R8-6 (a): only a label written next to the name picks a holder", () => {
  it("a team or a position directly before it, in parentheses directly after it, in the name tag", () => {
    // the ruling's own forms
    expect(outcome("Browns LB Justin Jefferson: Records sack")).toBe(
      "Justin Jefferson/CLE/LB:full_name_team u0",
    );
    expect(outcome("LB Justin Jefferson: Records sack")).toBe(
      "Justin Jefferson/CLE/LB:full_name u0",
    );
    expect(outcome("Justin Jefferson (CLE - LB): Records sack")).toBe(
      "Justin Jefferson/CLE/LB:full_name_team u0",
    );
    expect(outcome("Justin Jefferson (LB, Browns): Records sack")).toBe(
      "Justin Jefferson/CLE/LB:full_name_team u0",
    );
    expect(outcome("Justin Jefferson LB: Records sack")).toBe(
      "Justin Jefferson/CLE/LB:full_name u0",
    );
    expect(outcome("Justin Jefferson, WR, Minnesota: Questionable")).toBe(
      "Justin Jefferson/MIN/WR:full_name_team u0",
    );
    expect(outcome("Baltimore QB Lamar Jackson questionable")).toBe(
      "Lamar Jackson/BAL/QB:full_name_team u0",
    );
    expect(outcome("Kansas City's Chris Jones: Records sack")).toBe(
      "Chris Jones/KC/DT:full_name_team u0",
    );
    // a hyphen with no space in a tag, and a dash before the name tag's items: no ref at dbe9686
    expect(outcome("Justin Jefferson (CLE-LB): Records sack")).toBe(
      "Justin Jefferson/CLE/LB:full_name_team u0",
    );
    expect(outcome("Justin Jefferson - LB: Records sack")).toBe(
      "Justin Jefferson/CLE/LB:full_name u0",
    );
  });

  it("any word that is no team and no position breaks the label; so does punctuation but the possessive", () => {
    // each was the Vikings WR at 0.95 at dbe9686 and at f41e810: a modifier, "of the", an
    // appositive, a list — none is a label form, the item names a team: no ref, counted
    for (const t of [
      "Vikings star Justin Jefferson ruled out",
      "Justin Jefferson of the Vikings: Ruled out",
      "Justin Jefferson, the Vikings' star receiver, is out Sunday",
    ])
      expect(outcome(t), t).toBe("∅ u1");
    expect(outcome("Vikings WRs Jordan Addison and Justin Jefferson: Ruled out")).toBe(
      "Jordan Addison/MIN/WR:full_name_team u1",
    );
    // the Browns LB at 0.60 at dbe9686: an appositive is no label
    expect(
      outcome("Jefferson, a second-year linebacker, will miss Sunday's game | Browns notes"),
    ).toBe("∅ u1");
    // "…the Vikings, Justin Jefferson…" is no label; the possessive is
    expect(outcome("Facing the Vikings, Justin Jefferson records sack")).toBe("∅ u1");
    expect(outcome("Rams' Byron Young: Two sacks")).toBe("Byron Young/LA/DE:full_name_team u0");
  });

  it("a label must fit exactly one holder: team from the universe, position from ESPN position_id", () => {
    // the Bengals list no Lamar Jackson: a free agent fits no team label (the CB at 0.80 at dbe9686)
    expect(outcome("Bengals CB Lamar Jackson: Signed to practice squad")).toBe("∅ u1");
    // the CB fits the free-agent CB alone; "Punter" the free-agent P alone
    expect(outcome("CB Lamar Jackson: Signs with Bengals")).toBe(
      "Lamar Jackson/FA/CB:full_name u0",
    );
    expect(outcome("Punter Chris Jones: Works out for Bears")).toBe(
      "Chris Jones/FA/P:full_name u0",
    );
    // no holder of either name is a TE or a kicker
    expect(outcome("TE Justin Jefferson: Catches TD")).toBe("∅ u1");
    expect(outcome("Lamar Jackson, K, free agent: Works out")).toBe("∅ u1");
    // ESPN's own position fits only its own id (R8-6 (a); R8-3 clause 4, choice 6(c)): "DE" is the
    // Rams DE's, "DT" the Eagles DT's, and the position rules the other out (both no ref at dbe9686,
    // where DT and DE fit both; the Rams DE at 0.80 at f41e810, the Eagles DT none)
    expect(outcome("DE Byron Young: Records sack")).toBe("Byron Young/LA/DE:full_name u0");
    expect(outcome("Byron Young (PHI - DT): Records sack")).toBe(
      "Byron Young/PHI/DT:full_name_team u0",
    );
    expect(outcome("Eagles DT Byron Young: Placed on IR")).toBe(
      "Byron Young/PHI/DT:full_name_team u0",
    );
    // a CB label is no S's, a DE label no DT's (each went to the other position at dbe9686)
    expect(outcome("Vikings CB Smith: Waived | The cornerback was let go Tuesday.")).toBe("∅ u1");
    expect(outcome("Chiefs DE Jones: Waived | The defensive end was let go Tuesday.")).toBe("∅ u1");
    expect(outcome("Patriots DT Jones: Waived")).toBe("DaQuan Jones/NE/DT:last_name_team u0");
    // a group form still spans its ids: "DL" fits both Byron Youngs, so it picks no one
    expect(outcome("DL Byron Young: Records sack")).toBe("∅ u1");
  });

  it("labels for one name that fit different holders pick none; so does a segment that writes it both labelled and not", () => {
    // the team fits the WR, the position the LB (the WR at 0.95 at f41e810)
    expect(outcome("Vikings LB Justin Jefferson: Records sack")).toBe("∅ u1");
    expect(
      outcome("Browns' Justin Jefferson: Records sack | Vikings' Justin Jefferson caught two TDs."),
    ).toBe("∅ u1");
    // a label on any mention picks (no first-mention reading): the title writes the name alone, the
    // blurb labels it (no ref at 6ba7bb1; 0.95 at dbe9686 and f41e810)
    expect(
      outcome("Lamar Jackson: Limited | Ravens QB Lamar Jackson (ankle) was limited Wednesday."),
    ).toBe("Lamar Jackson/BAL/QB:full_name_team u0");
    expect(
      outcome(
        "Justin Jefferson: Questionable | Vikings WR Justin Jefferson (hamstring) did not practice.",
      ),
    ).toBe("Justin Jefferson/MIN/WR:full_name_team u0");
    expect(
      outcome("Justin Jefferson: Out for season | Browns LB Justin Jefferson tore his ACL."),
    ).toBe("Justin Jefferson/CLE/LB:full_name_team u0");
    expect(
      outcome("Michael Carter II: Questionable | Eagles S Michael Carter II (ankle) was limited."),
    ).toBe("Michael Carter II/PHI/S:full_name_team u0");
    // one segment writing the name both labelled and not may speak of two holders: no one (the CB
    // at 0.80 and the WR at 0.95 at dbe9686)
    expect(outcome("Lamar Jackson: Throws pick to CB Lamar Jackson")).toBe("∅ u1");
    expect(outcome("Lamar Jackson, not the Ravens QB Lamar Jackson, signs with Bengals")).toBe(
      "∅ u1",
    );
    expect(
      outcome(
        "Vikings WR Justin Jefferson has a namesake, and Justin Jefferson the linebacker just made the Browns' roster",
      ),
    ).toBe("∅ u1");
    expect(
      outcome(
        "Justin Jefferson: Mistaken for Vikings' Justin Jefferson | The Browns linebacker took it in stride.",
      ),
    ).toBe("∅ u1");
    // the first mention's label, repeated name unlabelled in the blurb: his
    expect(
      outcome("Vikings WR Justin Jefferson ruled out | Justin Jefferson will miss Sunday's game."),
    ).toBe("Justin Jefferson/MIN/WR:full_name_team u0");
    // a spelling and a label that disagree pick none
    expect(outcome("Titans RB Michael Carter II: Questionable")).toBe("∅ u1");
    expect(outcome("Eagles' Michael Carter II: Questionable")).toBe(
      "Michael Carter II/PHI/S:full_name_team u0",
    );
  });

  it("choice 6 stands: a team label alone never takes a name from a prominent holder", () => {
    // after a trade of the star to his namesake's team the universe may lag: a team rules no
    // prominent holder out, a position does
    for (const t of [
      "Cleveland's Justin Jefferson: Placed on IR",
      "Browns' Justin Jefferson: Records sack",
      "Justin Jefferson (CLE): Records sack",
      "Justin Jefferson, CLE: Records sack",
      "Philadelphia's Byron Young: Two sacks",
      "Cleveland's Jefferson: Records sack",
      "Eagles' Young: Sacks Rams QB",
    ])
      expect(outcome(t), t).toBe("∅ u1");
    expect(outcome("Kansas City DT Marcus Harris: Records sack")).toBe(
      "Marcus Harris/KC/DT:full_name_team u0",
    );
  });

  it("the bare surname follows (a): a label next to it, every form, fits one sharer", () => {
    expect(outcome("Browns LB Jefferson: Records sack")).toBe(
      "Justin Jefferson/CLE/LB:last_name_team u0",
    );
    expect(outcome("LB Jefferson: Records sack")).toBe("Justin Jefferson/CLE/LB:last_name_team u0");
    expect(outcome("Ravens QB Jackson: Limited in practice")).toBe(
      "Lamar Jackson/BAL/QB:last_name_team u0",
    );
    // the name tag after a surname: no ref, uncounted at dbe9686 (and at f41e810)
    expect(outcome("Jefferson MLB: Records sack")).toBe(
      "Justin Jefferson/CLE/LB:last_name_team u0",
    );
    expect(outcome("Jackson QB2: Limited in practice")).toBe(
      "Lamar Jackson/BAL/QB:last_name_team u0",
    );
    // two sharers fit: none, counted
    expect(outcome("WR Jefferson: Questionable")).toBe("∅ u1");
    expect(outcome("Bengals CB Jackson: Signed to practice squad")).toBe("∅ u1");
  });

  it("adjacency as written: a preposition's object, a line or paragraph break, a closing quote are no label", () => {
    // each the WR (or the QB) at 0.95 at 6ba7bb1, dbe9686 and f41e810: a wrong holder outside the
    // residual. A team right after a blocker word is its object; a team ending a line or paragraph is
    // not written next to a name opening the next; an apostrophe closing a quotation is no possessive
    for (const t of [
      "Against the Vikings Justin Jefferson recorded 12 tackles",
      "Browns' defense holds firm | Against Minnesota Justin Jefferson posted 12 tackles and a sack.",
      "Against the Rams Byron Young recorded two sacks.",
      "Facing Baltimore Lamar Jackson recorded an interception in the preseason finale.",
      "Browns IDP notes | <p>Week 9 vs. the Vikings</p><p>Justin Jefferson led the team with 12 tackles.</p>",
      "Browns IDP notes | Week 9 at Vikings\nJustin Jefferson led the team with 12 tackles.",
      "Waiver wire, Week 9 | Released: Ravens\nLamar Jackson, cornerback, signed by the Bengals.",
      "'Beat the Vikings' Justin Jefferson tells Browns teammates",
      "'I want to play in Baltimore' Lamar Jackson says after tryout",
      "Browns' defense holds firm | Against the Vikings Jefferson had 12 tackles and a sack.",
    ])
      expect(outcome(t), t).toBe("∅ u1");
    // the label forms the first build dropped are labels again (no ref at 6ba7bb1; 0.95 at dbe9686)
    for (const [t, want] of [
      [
        "Justin Jefferson (Vikings wide receiver): Questionable",
        "Justin Jefferson/MIN/WR:full_name_team u0",
      ],
      [
        "Chris Jones (Chiefs defensive lineman): Questionable",
        "Chris Jones/KC/DT:full_name_team u0",
      ],
      [
        "Michael Carter (Eagles free safety): Questionable",
        "Michael Carter II/PHI/S:full_name_team u0",
      ],
      [
        "Justin Jefferson (Browns inside linebacker): Questionable",
        "Justin Jefferson/CLE/LB:full_name_team u0",
      ],
      ["Rams EDGE Byron Young: Two sacks", "Byron Young/LA/DE:full_name_team u0"],
      ["Vikings\u2018 Justin Jefferson: Questionable", "Justin Jefferson/MIN/WR:full_name_team u0"],
    ] as const)
      expect(outcome(t), t).toBe(want);
  });

  it("a word of another person's name is never a label word", () => {
    // Tyrie Cleveland (a person) right before the name labels no team; "Cleveland's" does
    const mm = buildPlayerMatcher([
      {
        espn_id: 9_200_001,
        full_name: "Sam Twin",
        team: "CLE",
        gsis_id: null,
        percent_owned: 0.5,
        position_id: 11,
      },
      {
        espn_id: 9_200_002,
        full_name: "Sam Twin",
        team: "MIN",
        gsis_id: null,
        percent_owned: 0.5,
        position_id: 3,
      },
      {
        espn_id: 9_200_003,
        full_name: "Tyrie Cleveland",
        team: "MIA",
        gsis_id: null,
        position_id: 3,
      },
    ]);
    expect(mm.match("Tyrie Cleveland Sam Twin: Out").map((r) => r.espn_id)).toEqual([9_200_003]);
    expect(mm.match("Cleveland's Sam Twin: Out").map((r) => r.espn_id)).toEqual([9_200_001]);
  });
});

// -----------------------------------------------------------------------------------------------
describe("R8-6 (b): the prominent holder takes the item only when no team and no position is named", () => {
  it("the residual: full_name 0.80, never 0.95; a holder of no prominence takes none", () => {
    for (const [t, want] of [
      [
        "Justin Jefferson: Placed on IR | Jefferson (knee) will miss at least four games.",
        "Justin Jefferson/MIN/WR:full_name u0",
      ],
      ["Lamar Jackson: Could miss multiple games", "Lamar Jackson/BAL/QB:full_name u0"],
      ["Lamar Jackson: No Timetable For Return", "Lamar Jackson/BAL/QB:full_name u0"],
      [
        "Lamar Jackson: Questionable | The game starts at 1 P.M.",
        "Lamar Jackson/BAL/QB:full_name u0",
      ],
      ["Michael Carter: Limited in practice", "∅ u1"],
    ] as const)
      expect(outcome(t), t).toBe(want);
  });

  it("the scan finds a team in every form and any case (each the star's at 0.80 at dbe9686)", () => {
    for (const t of [
      "Justin Jefferson: Out for season, per @Browns | Jefferson tore his ACL in practice.",
      "Lamar Jackson: Waived (via @RavensFlock)",
      "Justin Jefferson: Placed on IR by CLE | Jefferson (knee) will miss at least four games.",
      "Lamar Jackson: Signs with the browns",
      "Justin Jefferson: Former Viking signs elsewhere",
      "Lamar Jackson: Works out in Nashville",
      "LAMAR JACKSON: NO TIMETABLE FOR RETURN",
      "Justin Jefferson: Leads the pack in targets",
    ])
      expect(outcome(t), t).toBe("∅ u1");
  });

  it("…and a position in every written form, an ambiguous token counting as found", () => {
    // each the star's at 0.80 at dbe9686 (and at f41e810)
    for (const t of [
      "Lamar Jackson: Waived | The corner was released after two weeks on the practice squad.",
      "Lamar Jackson: Waived | The safety was released",
      "Byron Young: Waived | The edge was released Tuesday.",
      "Byron Young: Waived | The IDL was let go Tuesday.",
      "Justin Jefferson: Records 10 tackles",
      "Justin Jefferson: Catches TD | Jefferson beat the D-lineman.",
      "Justin Jefferson: Questionable | The edge-rusher will miss practice.",
    ])
      expect(outcome(t), t).toBe("∅ u1");
    // "OT": no ref at dbe9686 too; the WR at 0.80 at f41e810
    expect(outcome("Justin Jefferson: Scores winning TD in OT")).toBe("∅ u1");
  });

  it("the text is read normalised: lookalike letters, fullwidth forms, zero-width marks, curly apostrophes", () => {
    for (const t of [
      "Justin Jefferson: Placed on IR by \u0412rowns", // a Cyrillic capital Ve
      "Justin Jefferson: Placed on IR by \uFF22\uFF52\uFF4F\uFF57\uFF4E\uFF53", // fullwidth
      "Justin Jefferson: Placed on IR by Bro\u200Bwns", // a zero-width space
      "Justin Jefferson: Placed on IR by Br\u00F3wns", // an accent
      "Justin Jefferson: Placed on IR by Bro\u0301wns", // a combining accent
      "Justin Jefferson: Placed on IR | The Browns\u2019 decision", // a curly apostrophe
      "Justin Jefferson: Questionable | The edge\u2011rusher will miss practice.", // a non-breaking hyphen
    ])
      expect(outcome(t), JSON.stringify(t)).toBe("∅ u1");
  });

  it("…every form the attack on the first build found missing (each the star's at 0.80 at 6ba7bb1)", () => {
    // R8-6 (b): domains, ranks, units, techniques, depth labels, hyphenated and glued spellings,
    // roles, plurals in capitals, cities, singulars, other sites' and legacy abbreviations, hashtags,
    // short names, lower-case abbreviations; each a namesake's item, none naming a label
    for (const t of [
      "Justin Jefferson: Placed on IR | Jefferson (knee) was placed on injured reserve Tuesday, per ClevelandBrowns.com.",
      "Byron Young: Out for season | Young (knee) will miss the rest of the year, per PhiladelphiaEagles.com.",
      "Lamar Jackson: Promoted to CB2 | Jackson will start Sunday.",
      "Marcus Harris: Joins defensive line rotation | Harris played 22 snaps Sunday.",
      "Lamar Jackson: Bolsters secondary | Jackson signed Tuesday.",
      "Lamar Jackson: Plays dime in debut | Jackson saw 14 snaps.",
      "Byron Young: Lines up at 1-tech | Young played 30 snaps Sunday.",
      "Justin Jefferson: Starting at WILL | Jefferson will call the defense.",
      "Marcus Harris: Starting at LDT",
      "Justin Jefferson: Elite wide-out | Jefferson had 150 yards.",
      "Lamar Jackson: Signs as return man | Jackson will handle kick returns.",
      "Marcus Harris: Named starting iDL",
      "JUSTIN JEFFERSON: AMONG LBS RELEASED",
      "Justin Jefferson: Records sack in Minneapolis | Jefferson got home once in Sunday's loss.",
      "Marcus Harris: Works out in Paradise | Harris auditioned Tuesday.",
      "Justin Jefferson: Ex-Brown finds new home | Jefferson signed a one-year deal Tuesday.",
      "Justin Jefferson: Waived by LVR | Jefferson cleared waivers.",
      "Chris Jones: Works out | Jones punted for OAK in 2018.",
      "Lamar Jackson: Works out | Jackson spent 2019 with the Redskins.",
      "Lamar Jackson: Waived | #RaiderNation",
      "Justin Jefferson: Records sack #CLEvsMIN",
      "Byron Young: Strip-sack seals win for Birds",
      "Lamar Jackson: Works out for 'Boys",
      "Lamar Jackson: Waived | The cb was released Tuesday.",
      "Justin Jefferson: Cut | The olb was waived Tuesday.",
      "Justin Jefferson: Records sack | Jefferson got home once at Lambeau.",
      "Justin Jefferson: Records sack | Jefferson got home once in Titletown.",
      "Justin Jefferson: Records sack #HereWeGo",
    ])
      expect(outcome(t), t).toBe("∅ u1");
  });

  it("a person's name names no team ('Dallas Goedert'), and initials and times are no positions", () => {
    expect(outcome("Lamar Jackson: Catches up with Dallas Goedert")).toBe(
      "Lamar Jackson/BAL/QB:full_name, Dallas Goedert/PHI/TE:full_name u0",
    );
    expect(
      outcome("Justin Jefferson: Questionable | K.J. Osborn and P.J. Walker also practiced."),
    ).toBe("Justin Jefferson/MIN/WR:full_name, K.J. Osborn/FA/WR:full_name u0");
  });
});

// -----------------------------------------------------------------------------------------------
describe("R8-6 (c): nothing else picks or raises a holder for a shared name", () => {
  it("not cue wording, nor a game (each the star's at 0.80 at dbe9686 and at f41e810)", () => {
    for (const t of [
      "Lamar Jackson: Throws three TDs vs. Bengals",
      "Bengals vs. Vikings: Justin Jefferson questionable",
      "Justin Jefferson: Catches two touchdowns | Jefferson caught seven passes for 110 yards in Sunday's win over the Browns.",
      "Lamar Jackson: Sacked five times by Steelers",
    ])
      expect(outcome(t), t).toBe("∅ u1");
  });

  it("not a describing sentence, nor a headline topic's clause", () => {
    // the Rams DE at 0.80 and the Ravens QB at 0.80 at dbe9686 (0.95 at f41e810)
    expect(
      outcome("Byron Young: Records two sacks against Eagles | The Rams edge rusher was dominant."),
    ).toBe("∅ u1");
    expect(
      outcome(
        "Lamar Jackson injury update: Ravens QB dealing with ankle sprain; Week 5 status still unknown, per report",
      ),
    ).toBe("∅ u1");
    // the WR at 0.80 at f41e810
    expect(
      outcome(
        "Justin Jefferson: Dealing with knee injury | The linebacker did not practice Wednesday.",
      ),
    ).toBe("∅ u1");
  });

  it("not a roster move: a move with no label next to the name gets no ref (each 0.95 at dbe9686)", () => {
    for (const t of [
      "Ravens sign Lamar Jackson to practice squad",
      "Lamar Jackson: Signs with Ravens practice squad",
      "Justin Jefferson: Activated by Vikings",
      "Lamar Jackson: Joins Ravens on tryout basis",
    ])
      expect(outcome(t), t).toBe("∅ u1");
    // a label next to the name still decides
    expect(outcome("Ravens sign CB Lamar Jackson to practice squad")).toBe(
      "Lamar Jackson/FA/CB:full_name u0",
    );
  });
});

// -----------------------------------------------------------------------------------------------
describe("R8-6 (d): otherwise no one takes the name, and the item is counted", () => {
  it("matchItem counts each shared name left to no one; a decided or a unique one never", () => {
    expect(m.matchItem("Lamar Jackson: Throws three TDs vs. Bengals")).toEqual({
      refs: [],
      unresolved: 1,
    });
    expect(m.matchItem("Justin Jefferson and Lamar Jackson: Both limited vs. Bengals")).toEqual({
      refs: [],
      unresolved: 2,
    });
    expect(m.matchItem("LB Justin Jefferson: Records sack").unresolved).toBe(0);
    expect(m.matchItem("Bijan Robinson: Questionable vs. Bengals").unresolved).toBe(0);
  });

  it("a spelled name is a shared name still: no residual when a team or a position is named, counted", () => {
    // R8-6 (b), (c), (d): a generational suffix narrows the holders to those ESPN spells with it, and
    // the one spelled holder takes the residual only when the scan finds nothing (each 0.80 at
    // 6ba7bb1, where spelling alone gave it: "Byron Murphy II … Vikings CB" is the Vikings CB Byron
    // Murphy Jr.'s, misspelled)
    for (const t of [
      "Michael Carter II: Waived by Titans | The running back was released.",
      "Byron Murphy II: Vikings CB ruled out",
      "Michael Carter II: Waived by Eagles",
    ])
      expect(outcome(t), t).toBe("∅ u1");
    expect(
      outcome("Michael Carter II: Questionable | Michael Carter II (ankle) was limited."),
    ).toBe("Michael Carter II/PHI/S:full_name u0");
    expect(outcome("Eagles S Michael Carter II: Questionable")).toBe(
      "Michael Carter II/PHI/S:full_name_team u0",
    );
    // a label must fit the spelled holder: one that fits the other holder picks no one
    expect(outcome("Byron Murphy II (Vikings CB): Ruled out")).toBe("∅ u1");
  });

  it("the bare surname never takes the residual; one left to no one is counted when a team or a position is named", () => {
    expect(outcome("Jefferson: Catches TD")).toBe("∅ u0");
    // counted: the item names a position (uncounted at dbe9686), or a team; beside another ref too
    expect(outcome("Jefferson: Catches TD | The receiver had 100 yards.")).toBe("∅ u1");
    expect(outcome("Jefferson torches Browns in win")).toBe("∅ u1");
    expect(outcome("Ja'Marr Chase: Catches TD | Chase beat Jefferson MLB in coverage.")).toBe(
      "Ja'Marr Chase/CIN/WR:full_name u1",
    );
  });

  it("the news build keeps every item and counts the unmatched and the unresolved ones", () => {
    const xml = rss([
      { title: "Lamar Jackson: Throws three TDs vs. Bengals", guid: "a" },
      { title: "Ravens sign Lamar Jackson to practice squad", guid: "b" },
      { title: "Lamar Jackson: Could miss multiple games", guid: "c" },
      { title: "Ja'Marr Chase: Catches TD | Chase beat Jefferson MLB in coverage.", guid: "d" },
      { title: "Bengals sign veteran kicker", guid: "e" },
    ]);
    const b = news.buildNewsRows({
      format: news.NEWS_FILE_FORMAT,
      source: "rotowire",
      fetched_ms: NEWS_NOW_MS,
      xml,
      universe,
      previous: [],
      warnings: [],
    });
    expect(b.news).toHaveLength(5);
    expect(b.counts).toMatchObject({ unmatched: 3, unresolved: 3 });
    expect(b.refs.map((r) => Number(r.espn_id)).sort((x, y) => x - y)).toEqual(
      [QB_LAMAR, idOf("Ja'Marr Chase", "CIN")].sort((x, y) => x - y),
    );
  });
});

// -----------------------------------------------------------------------------------------------
// The closed lists, word for word (each literal below is the source's list), and entry by entry
// through a behaviour, from the same literal: a deleted entry fails both.

// prettier-ignore
const TEAM_NICKNAMES: Readonly<Record<string, NflTeam>> = {
  Cardinals: "ARI", Falcons: "ATL", Ravens: "BAL", Bills: "BUF", Panthers: "CAR", Bears: "CHI",
  Bengals: "CIN", Browns: "CLE", Cowboys: "DAL", Broncos: "DEN", Lions: "DET", Packers: "GB",
  Texans: "HOU", Colts: "IND", Jaguars: "JAX", Jags: "JAX", Chiefs: "KC", Rams: "LA",
  Chargers: "LAC", Raiders: "LV", Dolphins: "MIA", Vikings: "MIN", Patriots: "NE", Pats: "NE",
  Saints: "NO", Giants: "NYG", Jets: "NYJ", Eagles: "PHI", Steelers: "PIT", Seahawks: "SEA",
  "49ers": "SF", Niners: "SF", Buccaneers: "TB", Bucs: "TB", Titans: "TEN", Commanders: "WAS",
};
// prettier-ignore
const TEAM_HOMES: Readonly<Record<string, NflTeam>> = {
  Arizona: "ARI", Atlanta: "ATL", Baltimore: "BAL", Buffalo: "BUF", Carolina: "CAR",
  Chicago: "CHI", Cincinnati: "CIN", Cleveland: "CLE", Dallas: "DAL", Denver: "DEN",
  Detroit: "DET", "Green Bay": "GB", Houston: "HOU", Indianapolis: "IND", Indy: "IND",
  Jacksonville: "JAX", "Kansas City": "KC", "Las Vegas": "LV", Miami: "MIA", Minnesota: "MIN",
  "New England": "NE", "New Orleans": "NO", Philadelphia: "PHI", Philly: "PHI",
  Pittsburgh: "PIT", Seattle: "SEA", "San Francisco": "SF", "Tampa Bay": "TB", Tennessee: "TEN",
  Washington: "WAS",
};
const SHARED_HOMES: Readonly<Record<string, readonly NflTeam[]>> = {
  "Los Angeles": ["LA", "LAC"],
  "New York": ["NYG", "NYJ"],
};
// prettier-ignore
const TEAM_SHORT_NAMES: Readonly<Record<string, NflTeam>> = {
  Vikes: "MIN", Fins: "MIA", Phins: "MIA", Bolts: "LAC", Pack: "GB", Hawks: "SEA", Cards: "ARI",
  "G-Men": "NYG", Cincy: "CIN", Vegas: "LV", "Big Blue": "NYG", "Gang Green": "NYJ",
};
// prettier-ignore
const TEAM_ABBREVIATIONS: Readonly<Record<string, readonly NflTeam[]>> = {
  ARI: ["ARI"], ARZ: ["ARI"], ATL: ["ATL"], BAL: ["BAL"], BLT: ["BAL"], BUF: ["BUF"], CAR: ["CAR"],
  CHI: ["CHI"], CIN: ["CIN"], CLE: ["CLE"], CLV: ["CLE"], DAL: ["DAL"], DEN: ["DEN"], DET: ["DET"],
  GB: ["GB"], GNB: ["GB"], GBP: ["GB"], HOU: ["HOU"], HST: ["HOU"], IND: ["IND"], JAX: ["JAX"],
  JAC: ["JAX"], KC: ["KC"], KAN: ["KC"], KCC: ["KC"], LA: ["LA"], LAR: ["LA"], LAC: ["LAC"],
  LV: ["LV"], LVR: ["LV"], MIA: ["MIA"], MIN: ["MIN"], NE: ["NE"], NWE: ["NE"], NEP: ["NE"],
  NO: ["NO"], NOR: ["NO"], NOS: ["NO"], NYG: ["NYG"], NYJ: ["NYJ"], NY: ["NYG", "NYJ"],
  PHI: ["PHI"], PIT: ["PIT"], SEA: ["SEA"], SF: ["SF"], SFO: ["SF"], TB: ["TB"], TAM: ["TB"],
  TBB: ["TB"], TEN: ["TEN"], WAS: ["WAS"], WSH: ["WAS"],
};
// prettier-ignore
const SCAN_ONLY_TEAM_ABBREVIATIONS: Readonly<Record<string, readonly NflTeam[]>> = {
  OAK: ["LV"], SD: ["LAC"], SDG: ["LAC"], STL: ["LA"], PHX: ["ARI"], WFT: ["WAS"], DC: ["WAS"],
};
// prettier-ignore
const CAPS_ONLY_ABBREVIATIONS = [
  "ARI", "CAR", "CHI", "DAL", "DEN", "JAC", "LA", "LAC", "MIA", "MIN", "NE", "NO", "NOR", "NOS",
  "OAK", "PHI", "PIT", "SEA", "TAM", "TEN", "WAS",
];
// prettier-ignore
const TEAM_SINGULARS: Readonly<Record<string, NflTeam>> = {
  Cardinal: "ARI", Falcon: "ATL", Raven: "BAL", Bill: "BUF", Panther: "CAR", Bear: "CHI",
  Bengal: "CIN", Brown: "CLE", Cowboy: "DAL", Bronco: "DEN", Lion: "DET", Packer: "GB",
  Texan: "HOU", Colt: "IND", Jaguar: "JAX", Jag: "JAX", Chief: "KC", Ram: "LA", Charger: "LAC",
  Bolt: "LAC", Raider: "LV", Dolphin: "MIA", Fin: "MIA", Phin: "MIA", Viking: "MIN", Vike: "MIN",
  Patriot: "NE", Pat: "NE", Saint: "NO", Giant: "NYG", Jet: "NYJ", Eagle: "PHI", Steeler: "PIT",
  Seahawk: "SEA", "49er": "SF", Niner: "SF", Buccaneer: "TB", Buc: "TB", Titan: "TEN",
  Commander: "WAS",
};
// prettier-ignore
const TEAM_CITIES: Readonly<Record<string, readonly NflTeam[]>> = {
  Glendale: ["ARI"], Phoenix: ["ARI"], Tempe: ["ARI"], "Flowery Branch": ["ATL"],
  "Owings Mills": ["BAL"], "Charm City": ["BAL"], "Orchard Park": ["BUF"], Highmark: ["BUF"],
  Charlotte: ["CAR"], "Queen City": ["CAR", "CIN"], "Lake Forest": ["CHI"], "Windy City": ["CHI"],
  "Soldier Field": ["CHI"], Berea: ["CLE"], Arlington: ["DAL"], Frisco: ["DAL"], "Big D": ["DAL"],
  "Mile High": ["DEN"], "Allen Park": ["DET"], "Motor City": ["DET"], Motown: ["DET"],
  Titletown: ["GB"], Lambeau: ["GB"], "H-Town": ["HOU"], "Space City": ["HOU"], Duval: ["JAX"],
  Arrowhead: ["KC"], Inglewood: ["LA", "LAC"], SoFi: ["LA", "LAC"], "Thousand Oaks": ["LA"],
  "El Segundo": ["LAC"], "Costa Mesa": ["LAC"], Paradise: ["LV"], "Sin City": ["LV"],
  Allegiant: ["LV"], Davie: ["MIA"], "Magic City": ["MIA"], Minneapolis: ["MIN"], Eagan: ["MIN"],
  "Twin Cities": ["MIN"], Foxborough: ["NE"], Foxboro: ["NE"], Gillette: ["NE"], Metairie: ["NO"],
  "Big Easy": ["NO"], NOLA: ["NO"], Superdome: ["NO"], "East Rutherford": ["NYG", "NYJ"],
  MetLife: ["NYG", "NYJ"], "Big Apple": ["NYG", "NYJ"], "Florham Park": ["NYJ"], Latrobe: ["PIT"],
  "Steel City": ["PIT"], Acrisure: ["PIT"], Renton: ["SEA"], "Emerald City": ["SEA"], Lumen: ["SEA"],
  "Santa Clara": ["SF"], "Bay Area": ["SF"], Tampa: ["TB"], Nashville: ["TEN"],
  "Music City": ["TEN"], Landover: ["WAS"], Ashburn: ["WAS"],
};
// prettier-ignore
const SCAN_ONLY_TEAM_NAMES: Readonly<Record<string, readonly NflTeam[]>> = {
  Birds: ["ARI", "ATL", "BAL", "PHI", "SEA"], Boys: ["DAL"], "Big Red": ["ARI"],
  "Dawg Pound": ["CLE"], "Who Dey": ["CIN"], Skol: ["MIN"], "Who Dat": ["NO"], Iggles: ["PHI"],
  "Steel Curtain": ["PIT"], "12s": ["SEA"], "12th Man": ["SEA"],
  Skins: ["WAS"], Redskins: ["WAS"], "Football Team": ["WAS"], Oilers: ["TEN"], Oakland: ["LV"],
  "San Diego": ["LAC"], "St Louis": ["LA"], "Saint Louis": ["LA"],
};
// prettier-ignore
const TEAM_HASHTAGS: Readonly<Record<string, NflTeam>> = {
  RiseUp: "ATL", KeepPounding: "CAR", RuleTheJungle: "CIN", OnePride: "DET", ForTheShoe: "IND",
  DUUUVAL: "JAX", TogetherBlue: "NYG", TakeFlight: "NYJ", BirdGang: "PHI", HereWeGo: "PIT",
  FTTB: "SF", HTTC: "WAS", HTTR: "WAS",
};
// prettier-ignore
const CONFUSABLES: Readonly<Record<string, string>> = {
  "а": "a", "А": "A", "В": "B", "с": "c", "С": "C", "е": "e", "Е": "E", "Н": "H", "і": "i",
  "І": "I", "ј": "j", "Ј": "J", "К": "K", "к": "k", "М": "M", "о": "o", "О": "O", "р": "p",
  "Р": "P", "ѕ": "s", "Ѕ": "S", "Т": "T", "у": "y", "Х": "X", "х": "x", "ԁ": "d", "ԝ": "w",
  "ӏ": "l",
  "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N",
  "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X", "ο": "o", "ι": "i", "κ": "k", "ν": "v",
  "ρ": "p", "υ": "u", "χ": "x", "ϲ": "c",
  "օ": "o",
  "ø": "o", "Ø": "O", "ß": "ss", "đ": "d", "Đ": "D", "ð": "d", "ł": "l", "Ł": "L", "ı": "i",
  "ħ": "h", "þ": "th", "ɡ": "g", "ɑ": "a",
};
// prettier-ignore
const APOSTROPHES = ["’", "‘", "‛", "ʼ", "ʻ", "`", "´", "′"];
const DASHES = ["−"];
const LABEL_SEPARATORS = [",", "-", "/"];
// prettier-ignore
const LABEL_BLOCKERS = [
  "a", "about", "above", "across", "after", "against", "along", "amid", "among", "an", "around",
  "as", "at", "before", "behind", "beside", "between", "beyond", "by", "despite", "during",
  "facing", "for", "from", "in", "inside", "into", "like", "near", "of", "off", "on", "onto",
  "outside", "over", "past", "per", "since", "than", "the", "through", "to", "toward", "towards",
  "under", "until", "upon", "v", "versus", "via", "vs", "with", "within", "without",
];
const CLAUSE_ABBREVIATIONS = ["v", "vs"];
const HEADLINE_ORDINARY_WORDS = ["EDGE"];
const QB = [1];
const RB = [2];
const WR = [3];
const TE = [4];
const K = [5];
const P = [7];
const DT = [9];
const DE = [10];
const LB = [11];
const CB = [12];
const S = [13];
const DL = [9, 10];
const EDGE = [10, 11];
const RUSHER = [9, 10, 11];
const DB = [12, 13];
const DEFENSE = [9, 10, 11, 12, 13];
const OL: number[] = [];
// prettier-ignore
const POSITION_ABBREVIATIONS: Readonly<Record<string, readonly number[]>> = {
  QB, RB, HB: RB, FB: RB, WR, TE, K, PK: K, P,
  DT, NT: DT, LDT: DT, RDT: DT, DE, LDE: DE, RDE: DE, DL, IDL: DL,
  EDGE, OLB: EDGE, LOLB: EDGE, ROLB: EDGE,
  LB, ILB: LB, MLB: LB, WLB: LB, SLB: LB, LILB: LB, RILB: LB,
  CB, RCB: CB, LCB: CB, NCB: CB, S, FS: S, SS: S, NB: DB, DB,
  OL, OT: OL, OG: OL,
};
// prettier-ignore
const POSITION_WORDS: Readonly<Record<string, readonly number[]>> = {
  quarterback: QB, "signal caller": QB,
  "running back": RB, halfback: RB, tailback: RB, fullback: RB,
  receiver: WR, wideout: WR, "wide receiver": WR, "slot receiver": WR,
  "tight end": TE,
  kicker: K, placekicker: K, punter: P,
  "defensive tackle": DT, "nose tackle": DT, "d-tackle": DT,
  "defensive end": DE, "d-end": DE,
  lineman: DL, "d-lineman": DL, "defensive lineman": DL, "3-technique": DL,
  "edge rusher": EDGE, "outside linebacker": EDGE,
  linebacker: LB, "inside linebacker": LB, "middle linebacker": LB,
  "pass rusher": RUSHER,
  cornerback: CB, corner: CB, "slot corner": CB,
  safety: S, "free safety": S, "strong safety": S,
  "nickel back": DB, "defensive back": DB,
  defender: DEFENSE, "defensive player": DEFENSE,
  "offensive lineman": OL,
};
const AMBIGUOUS_LABEL_WORDS = ["corner", "safety"];
// prettier-ignore
const SCAN_ONLY_ABBREVIATIONS = [
  "LT", "RT", "LG", "RG", "C", "LS", "KR", "PR", "ST", "DI", "ATH", "MIKE", "WILL", "SAM",
];
// prettier-ignore
const SCAN_ONLY_WORDS = [
  "tackle", "guard", "center", "centre", "nose", "rusher", "backer", "off-ball", "rover",
  "returner", "return man", "snapper", "gunner", "holder", "specialist", "special teams",
  "special teamer", "tackler", "pass catcher", "flanker", "split end", "slot", "h-back",
  "wingback", "slotback", "scatback", "nickel", "dime", "dimeback",
  "secondary", "defensive line", "offensive line", "o-line", "d-line", "defensive front",
  "defensive interior", "front seven", "pass rush", "linebacking", "receiving corps", "backfield",
];
// prettier-ignore
const CAPS_ONLY_POSITION_ABBREVIATIONS = [
  "C", "DE", "DI", "K", "LB", "LT", "MIKE", "OL", "P", "S", "SAM", "ST", "WILL",
];

/** A list as a sorted copy, so the comparison is word for word, order aside. */
const sorted = (o: Readonly<Record<string, unknown>> | readonly string[]): unknown =>
  Array.isArray(o)
    ? [...(o as readonly string[])].sort()
    : Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** Each case of a word: as written, lower case, capitals, title case. */
const cases = (w: string): string[] => [
  ...new Set([w, w.toLowerCase(), w.toUpperCase(), w.replace(/\b\p{L}/gu, (c) => c.toUpperCase())]),
];
/** A form's spellings: as listed, a hyphen for each space, glued. */
const spellingsOf = (w: string): string[] => [
  ...new Set([w, w.replaceAll(" ", "-"), w.replace(/[\s-]/gu, "")]),
];
/** A residual item (the WR at 0.80) with `form` written in its blurb: the residual must go. */
const withForm = (form: string): string =>
  `Justin Jefferson: Questionable | Notes: ${form}, as of Wednesday.`;
const RESIDUAL = "Justin Jefferson/MIN/WR:full_name u0";
/**
 * Whether a residual item with `form` written in it lost the residual: no Justin Jefferson takes it,
 * and it is counted (a form may also be a shared surname, "STRONG SAFETY", counted too).
 */
const scanned = (form: string): string => {
  const r = m.matchItem(withForm(form));
  const jj = r.refs.filter((x) => x.espn_id === WR_JEFFERSON || x.espn_id === LB_JEFFERSON);
  return jj.length === 0 && r.unresolved >= 1 ? "∅ u1" : `${show(r.refs)} u${String(r.unresolved)}`;
};

/** One holder named "Sam Twin" on each team, none prominent: a team label picks the one on it. */
const twins = buildPlayerMatcher(
  NFL_TEAMS.map((t, i) => ({
    espn_id: 9_300_000 + i,
    full_name: "Sam Twin",
    team: t,
    gsis_id: null,
    percent_owned: 0.5,
    position_id: 3,
  })),
);
const twinOn = (t: NflTeam): number => 9_300_000 + NFL_TEAMS.indexOf(t);
/** The holders a label picks among the "Sam Twin"s. */
const picked = (label: string): number[] =>
  twins.match(`${label} Sam Twin: Out`).map((r) => r.espn_id);

/** Free agents named "Pat Twin", one of each ESPN position: a position label picks the one it fits. */
function positionTwins(ids: readonly number[]) {
  return buildPlayerMatcher(
    ids.map((id) => ({
      espn_id: 9_400_000 + id,
      full_name: "Pat Twin",
      team: null,
      gsis_id: null,
      position_id: id,
    })),
  );
}
const ALL_IDS = [1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13];
/**
 * A label of ids `ids` picks the holder of its first id beside a holder of each id it does not name
 * (ESPN's own position fits only itself: "DT" rules an ESPN DE out), and none beside another of its ids.
 */
function expectPositionLabel(written: string, ids: readonly number[]): void {
  const first = ids[0];
  if (first === undefined) {
    // an offensive-line label fits no universe player
    expect(positionTwins(ALL_IDS).match(`${written} Pat Twin: Out`), written).toEqual([]);
    return;
  }
  for (const other of ALL_IDS.filter((id) => !ids.includes(id)))
    expect(
      positionTwins([first, other])
        .match(`${written} Pat Twin: Out`)
        .map((r) => r.espn_id),
      `${written} beside ${String(other)}`,
    ).toEqual([9_400_000 + first]);
  for (const same of ids.slice(1))
    expect(positionTwins([first, same]).match(`${written} Pat Twin: Out`), written).toEqual([]);
}
/** Every Unicode dash punctuation character (Pd), enumerated here, beside the source's own list. */
const DASH_PUNCTUATION: readonly string[] = (() => {
  const out: string[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const c = String.fromCodePoint(cp);
    if (/^\p{Pd}$/u.test(c)) out.push(c);
  }
  return out;
})();

describe("the closed lists, word for word and entry by entry", () => {
  it("word for word", () => {
    expect(sorted(news.TEAM_NICKNAMES)).toEqual(sorted(TEAM_NICKNAMES));
    expect(sorted(news.TEAM_HOMES)).toEqual(sorted(TEAM_HOMES));
    expect(sorted(news.SHARED_HOMES)).toEqual(sorted(SHARED_HOMES));
    expect(sorted(news.TEAM_SHORT_NAMES)).toEqual(sorted(TEAM_SHORT_NAMES));
    expect(sorted(news.TEAM_ABBREVIATIONS)).toEqual(sorted(TEAM_ABBREVIATIONS));
    expect(sorted(news.SCAN_ONLY_TEAM_ABBREVIATIONS)).toEqual(sorted(SCAN_ONLY_TEAM_ABBREVIATIONS));
    expect(sorted(news.CAPS_ONLY_ABBREVIATIONS)).toEqual(sorted(CAPS_ONLY_ABBREVIATIONS));
    expect(sorted(news.TEAM_SINGULARS)).toEqual(sorted(TEAM_SINGULARS));
    expect(sorted(news.TEAM_CITIES)).toEqual(sorted(TEAM_CITIES));
    expect(sorted(news.SCAN_ONLY_TEAM_NAMES)).toEqual(sorted(SCAN_ONLY_TEAM_NAMES));
    expect(sorted(news.TEAM_HASHTAGS)).toEqual(sorted(TEAM_HASHTAGS));
    expect(sorted(news.CONFUSABLES)).toEqual(sorted(CONFUSABLES));
    expect(sorted(news.APOSTROPHES)).toEqual(sorted(APOSTROPHES));
    expect(sorted(news.DASHES)).toEqual(sorted(DASHES));
    expect(sorted(news.LABEL_SEPARATORS)).toEqual(sorted(LABEL_SEPARATORS));
    expect(sorted(news.LABEL_BLOCKERS)).toEqual(sorted(LABEL_BLOCKERS));
    expect(sorted(news.CLAUSE_ABBREVIATIONS)).toEqual(sorted(CLAUSE_ABBREVIATIONS));
    expect(sorted(news.HEADLINE_ORDINARY_WORDS)).toEqual(sorted(HEADLINE_ORDINARY_WORDS));
    expect(sorted(news.POSITION_ABBREVIATIONS)).toEqual(sorted(POSITION_ABBREVIATIONS));
    expect(sorted(news.POSITION_WORDS)).toEqual(sorted(POSITION_WORDS));
    expect(sorted(news.AMBIGUOUS_LABEL_WORDS)).toEqual(sorted(AMBIGUOUS_LABEL_WORDS));
    expect(sorted(news.SCAN_ONLY_ABBREVIATIONS)).toEqual(sorted(SCAN_ONLY_ABBREVIATIONS));
    expect(sorted(news.SCAN_ONLY_WORDS)).toEqual(sorted(SCAN_ONLY_WORDS));
    expect(sorted(news.CAPS_ONLY_POSITION_ABBREVIATIONS)).toEqual(
      sorted(CAPS_ONLY_POSITION_ABBREVIATIONS),
    );
  });

  it("a nickname, home or short name, in any case and spelling: the scan finds it, and as a label it is his team", () => {
    expect(scanned("none")).toBe(RESIDUAL);
    const one = { ...TEAM_NICKNAMES, ...TEAM_HOMES, ...TEAM_SHORT_NAMES };
    for (const [form, team] of Object.entries(one)) {
      for (const w of cases(form).flatMap(spellingsOf)) expect(scanned(w), w).toBe("∅ u1");
      for (const w of spellingsOf(form)) expect(picked(w), w).toEqual([twinOn(team)]);
      expect(picked(`${form}'`), `${form}'`).toEqual([twinOn(team)]);
    }
    // a home that holds two teams fits a holder on either: it picks no one between them
    for (const form of Object.keys(SHARED_HOMES)) {
      for (const w of cases(form).flatMap(spellingsOf)) expect(scanned(w), w).toBe("∅ u1");
      expect(picked(form), form).toEqual([]);
    }
  });

  it("an abbreviation: in capitals always; in other cases only when its lower case is no word", () => {
    for (const [form, teams] of Object.entries(TEAM_ABBREVIATIONS)) {
      expect(scanned(form), form).toBe("∅ u1");
      expect(picked(form), form).toEqual(teams.length === 1 ? teams.map(twinOn) : []);
      const caps = CAPS_ONLY_ABBREVIATIONS.includes(form);
      for (const w of [form.toLowerCase(), `${form.slice(0, 1)}${form.slice(1).toLowerCase()}`]) {
        if (w === form) continue;
        expect(scanned(w), w).toBe(caps ? RESIDUAL : "∅ u1");
        expect(picked(w), w).toEqual(caps || teams.length !== 1 ? [] : teams.map(twinOn));
      }
    }
    // a legacy abbreviation: found by the scan by the same case rule, never a label
    for (const form of Object.keys(SCAN_ONLY_TEAM_ABBREVIATIONS)) {
      expect(scanned(form), form).toBe("∅ u1");
      expect(picked(form), form).toEqual([]);
      const caps = CAPS_ONLY_ABBREVIATIONS.includes(form);
      expect(scanned(form.toLowerCase()), form).toBe(caps ? RESIDUAL : "∅ u1");
    }
  });

  it("a singular nickname, a city or a scan-only name: the scan finds it in any case; it never labels a name", () => {
    for (const form of [
      ...Object.keys(TEAM_SINGULARS),
      ...Object.keys(TEAM_CITIES),
      ...Object.keys(SCAN_ONLY_TEAM_NAMES),
    ]) {
      for (const w of cases(form).flatMap(spellingsOf)) expect(scanned(w), w).toBe("∅ u1");
      expect(picked(form), form).toEqual([]);
    }
    // the forms written as feeds write them
    for (const w of [
      "Ex-Brown",
      "ex-Bolt",
      "a former Raven",
      "'Boys",
      "St. Louis",
      "St.Louis",
      "D.C.",
    ])
      expect(scanned(w), w).toBe("∅ u1");
  });

  it("a team's own hashtag: found after '#' in any case, never as a plain word", () => {
    for (const tag of Object.keys(TEAM_HASHTAGS)) {
      for (const w of [`#${tag}`, `#${tag.toLowerCase()}`, `#${tag.toUpperCase()}`, `#${tag}2026`])
        expect(scanned(w), w).toBe("∅ u1");
      expect(picked(`#${tag}`), tag).toEqual([]);
    }
    // the plain words of a phrase hashtag name no team ("here we go", "rise up")
    for (const w of ["HereWeGo", "here we go", "RiseUp", "take flight"])
      expect(scanned(w), w).toBe(RESIDUAL);
  });

  it("a compound holding a team: a handle, a hashtag, a domain, a camel-cased word", () => {
    const words = [
      ...Object.keys(TEAM_NICKNAMES),
      ...Object.keys(TEAM_HOMES),
      ...Object.keys(SHARED_HOMES),
      ...Object.keys(TEAM_SHORT_NAMES),
      ...Object.keys(TEAM_SINGULARS),
      ...Object.keys(TEAM_CITIES),
      ...Object.keys(SCAN_ONLY_TEAM_NAMES),
    ];
    for (const form of words) {
      const glued = form.replace(/[\s'-]/gu, "");
      const lower = glued.toLowerCase();
      const title = glued.replace(/^\p{L}/u, (c) => c.toUpperCase());
      // a segment of a camel-cased compound ("#BearDown", "ClevelandBrowns.com") at any length; a
      // form of four letters or more inside a lower-case one ("kcchiefs.com", "@xbrownsNFL")
      for (const w of [`#${title}Up`, `@The${title}`, `per The${title}.com`, `per Go${title}Now`])
        expect(scanned(w), w).toBe("∅ u1");
      if (lower.length >= 4)
        for (const w of [`@x${lower}nfl`, `#${lower}nation`, `per www.the${lower}online.com`])
          expect(scanned(w), w).toBe("∅ u1");
      else expect(scanned(`#${lower}up`), `#${lower}up`).toBe("∅ u1");
    }
    for (const form of [
      ...Object.keys(TEAM_ABBREVIATIONS),
      ...Object.keys(SCAN_ONLY_TEAM_ABBREVIATIONS),
    ]) {
      // a game tag ("#CLEvsMIN"); a team site's ("KCChiefs.com"); in a lower-case hashtag, three
      // letters ("#clevsmin")
      expect(scanned(`#${form}vsXYZ`), form).toBe("∅ u1");
      expect(scanned(`per ${form}Online.com`), form).toBe("∅ u1");
      if (form.length === 3) expect(scanned(`#${form.toLowerCase()}vsxyz`), form).toBe("∅ u1");
    }
    // no form inside: no team ("@Jaxon…" names none in a handle; "Jax" alone does)
    for (const w of ["@JaxonFanClub", "per @AdamSchefter", "per McCaffrey.com", "LaPorta"])
      expect(scanned(w), w).toBe(RESIDUAL);
    expect(scanned("@Jax")).toBe("∅ u1");
  });

  it("a position abbreviation: in capitals, its rank, its plural; as a label it fits its ids", () => {
    for (const [form, ids] of Object.entries(POSITION_ABBREVIATIONS)) {
      for (const w of [form, `${form}s`, `${form}S`, `${form}1`, `${form}4`, `${form}10`])
        expect(scanned(w), w).toBe("∅ u1");
      expectPositionLabel(form, ids);
      expectPositionLabel(`${form}2`, ids);
      // in lower case it labels no one; the scan counts it unless its lower case is a word
      expect(positionTwins(ALL_IDS).match(`${form.toLowerCase()} Pat Twin: Out`), form).toEqual([]);
      if (!(form.toLowerCase() in POSITION_WORDS))
        expect(scanned(form.toLowerCase()), form).toBe(
          CAPS_ONLY_POSITION_ABBREVIATIONS.includes(form) ? RESIDUAL : "∅ u1",
        );
    }
  });

  it("a position word, one or two, in any case, spelling and its plural; as a label it fits its ids", () => {
    for (const [form, ids] of Object.entries(POSITION_WORDS)) {
      for (const w of cases(form).flatMap(spellingsOf)) expect(scanned(w), w).toBe("∅ u1");
      const plural = form.endsWith("man")
        ? `${form.slice(0, -3)}men`
        : /[^aeiou]y$/u.test(form)
          ? `${form.slice(0, -1)}ies`
          : `${form}s`;
      expect(scanned(plural), plural).toBe("∅ u1");
      for (const w of spellingsOf(form)) {
        expectPositionLabel(w, ids);
        expectPositionLabel(
          w.replace(/\b\p{L}/gu, (c) => c.toUpperCase()),
          ids,
        );
      }
    }
  });

  it("a scan-only form: the scan finds it (an ambiguous token counts); it never labels a name", () => {
    for (const form of SCAN_ONLY_ABBREVIATIONS) {
      for (const w of [form, `${form}s`, `${form}1`]) expect(scanned(w), w).toBe("∅ u1");
      expect(positionTwins(ALL_IDS).match(`${form} Pat Twin: Out`), form).toEqual([]);
      expect(scanned(form.toLowerCase()), form).toBe(
        CAPS_ONLY_POSITION_ABBREVIATIONS.includes(form) ? RESIDUAL : "∅ u1",
      );
    }
    for (const form of SCAN_ONLY_WORDS) {
      for (const w of cases(form).flatMap(spellingsOf)) expect(scanned(w), w).toBe("∅ u1");
      expect(positionTwins(ALL_IDS).match(`${form} Pat Twin: Out`), form).toEqual([]);
    }
    // the ruling's ambiguous tokens, in prose; techniques and ranks by rule
    for (const t of [
      "in OT",
      "around the corner",
      "for safety reasons",
      "an edge",
      "1-tech",
      "the 4i",
      "nine-technique",
      "QB12",
      "a WR4",
    ])
      expect(scanned(t), t).toBe("∅ u1");
  });

  it("an ambiguous label word right after a preposition or an article is the ordinary word", () => {
    for (const w of AMBIGUOUS_LABEL_WORDS) {
      const id = (POSITION_WORDS[w] ?? [])[0] ?? 0;
      const mm = positionTwins([id, 1]);
      const at = (t: string) => mm.match(t).map((r) => r.espn_id);
      // "After safety Lamar Jackson leads Ravens on winning drive" (the free-agent CB at 0.80 at dbe9686)
      for (const blocker of ["After", "in the", "for", "around the"])
        expect(at(`${blocker} ${w} Pat Twin scored`), `${blocker} ${w}`).toEqual([]);
      // a label still: at the start, after a modifier, beside a team
      expect(at(`${w} Pat Twin: Signs`), w).toEqual([9_400_000 + id]);
      expect(at(`Veteran ${w} Pat Twin: Signs`), w).toEqual([9_400_000 + id]);
      expect(at(`Pat Twin (${w}): Signs`), w).toEqual([9_400_000 + id]);
    }
    expect(outcome("After safety Lamar Jackson leads Ravens on winning drive")).toBe("∅ u1");
    expect(outcome("Free-agent corner Lamar Jackson visits")).toBe(
      "Lamar Jackson/FA/CB:full_name u0",
    );
  });

  it("each lookalike letter folds to its Latin letter before the scan", () => {
    const forms = [
      ...Object.keys(TEAM_NICKNAMES),
      ...Object.keys(TEAM_HOMES),
      ...Object.keys(TEAM_ABBREVIATIONS),
    ].flatMap((f) => [f, f.toUpperCase(), f.toLowerCase()]);
    for (const [look, latin] of Object.entries(CONFUSABLES)) {
      const form = forms.find(
        (f) =>
          f.includes(latin) &&
          (f === f.toUpperCase() || !CAPS_ONLY_ABBREVIATIONS.includes(f.toUpperCase())),
      );
      expect(form, `a team form holding ${latin}`).toBeDefined();
      const written = (form ?? "").replace(latin, look);
      expect(written).not.toBe(form);
      expect(scanned(written), `${look} for ${latin}: ${written}`).toBe("∅ u1");
    }
  });

  it("each apostrophe-like mark folds to an apostrophe: a possessive, in a label and in the scan", () => {
    for (const mark of APOSTROPHES) {
      expect(picked(`Browns${mark}`), mark).toEqual([twinOn("CLE")]);
      expect(picked(`Cleveland${mark}s`), mark).toEqual([twinOn("CLE")]);
      // the scan reads "TEAM'S" as one word, not "TEAM" and the S of a safety (the QB at 0.80;
      // no ref when the mark is not folded)
      expect(outcome(`LAMAR JACKSON: TEAM${mark}S DECISION LOOMS`), mark).toBe(
        "Lamar Jackson/BAL/QB:full_name u0",
      );
    }
    expect(outcome("LAMAR JACKSON: TEAM'S DECISION LOOMS")).toBe(
      "Lamar Jackson/BAL/QB:full_name u0",
    );
    // a mark that is no apostrophe is punctuation: no possessive, and the S counts
    for (const mark of ['"', "”", "^"]) {
      expect(picked(`Browns${mark}`), mark).toEqual([]);
      expect(outcome(`LAMAR JACKSON: TEAM${mark}S DECISION LOOMS`), mark).toBe("∅ u1");
    }
    // an apostrophe that closes a quotation opened in its segment is no possessive (the WR at 0.95
    // at dbe9686 and f41e810)
    for (const t of [
      "'Beat the Vikings' Justin Jefferson tells Browns teammates",
      "‘Beat the Vikings’ Justin Jefferson tells Browns teammates",
      "'I want to play in Baltimore' Lamar Jackson says after tryout",
    ])
      expect(outcome(t), t).toBe("∅ u1");
    expect(outcome("'Ready' | Vikings' Justin Jefferson: Questionable")).toBe(
      "Justin Jefferson/MIN/WR:full_name_team u0",
    );
  });

  it("each dash folds to a hyphen: every Unicode dash punctuation and the minus sign", () => {
    expect(DASH_PUNCTUATION.length).toBeGreaterThan(20);
    for (const dash of [...DASH_PUNCTUATION, ...DASHES]) {
      // the residual's star at 0.80 when the dash is not folded ("d" and "line" are no forms)
      expect(
        outcome(`Justin Jefferson: Waived | The d${dash}line reserve was cut.`),
        `U+${(dash.codePointAt(0) ?? 0).toString(16)}`,
      ).toBe("∅ u1");
      const mm = buildPlayerMatcher([
        { espn_id: 9_500_001, full_name: "Sam Twin", team: "CLE", gsis_id: null, position_id: 11 },
        { espn_id: 9_500_002, full_name: "Sam Twin", team: "CLE", gsis_id: null, position_id: 3 },
      ]);
      expect(
        mm.match(`Sam Twin (CLE ${dash} LB): Out`).map((r) => r.espn_id),
        `U+${(dash.codePointAt(0) ?? 0).toString(16)}`,
      ).toEqual([9_500_001]);
    }
  });

  it("each separator of a label's tag, and nothing else between the label and the name", () => {
    for (const sep of LABEL_SEPARATORS) {
      const mm = buildPlayerMatcher([
        { espn_id: 9_500_001, full_name: "Sam Twin", team: "CLE", gsis_id: null, position_id: 11 },
        { espn_id: 9_500_002, full_name: "Sam Twin", team: "CLE", gsis_id: null, position_id: 3 },
        { espn_id: 9_500_003, full_name: "Sam Twin", team: "MIN", gsis_id: null, position_id: 11 },
      ]);
      for (const t of [
        `Sam Twin (CLE ${sep} LB): Out`,
        `Sam Twin (CLE${sep}LB): Out`,
        `Sam Twin ${sep} CLE ${sep} LB: Out`,
      ])
        expect(
          mm.match(t).map((r) => r.espn_id),
          t,
        ).toEqual([9_500_001]);
    }
    // anything else between the label and the name breaks it
    for (const p of [",", ";", ":", "|", ".", "(", ")", "!", "?", '"'])
      expect(picked(`Browns${p}`), p).toEqual([]);
    // so do the joiners inside a word: "Ex-Browns" is no team, "vs.Vikings" and "Jo'Vikings" none
    expect(outcome("Ex-Browns LB Justin Jefferson: Signs")).toBe(
      "Justin Jefferson/CLE/LB:full_name u0",
    );
    expect(outcome("vs.Vikings Justin Jefferson: Questionable")).toBe("∅ u1");
    // (the joined word is no team, so the item names none: the residual, where "Vikings" alone
    // would have labelled the WR at 0.95)
    expect(outcome("Jo'Vikings Justin Jefferson: Questionable")).toBe(
      "Justin Jefferson/MIN/WR:full_name u0",
    );
  });

  it("a label of teams alone must open its clause: a word right before it makes it that word's object", () => {
    // "Against the Vikings Justin Jefferson recorded 12 tackles" (the WR at 0.95 at dbe9686 and f41e810)
    for (const w of [
      ...LABEL_BLOCKERS,
      "beat",
      "stun",
      "edges",
      "tops",
      "host",
      "Week 9",
      "Former",
      "rookie",
    ]) {
      for (const t of [
        `${w} Vikings Justin Jefferson recorded 12 tackles`,
        `${w.replace(/^\p{L}/u, (c) => c.toUpperCase())} Vikings Justin Jefferson recorded 12 tackles`,
      ])
        expect(outcome(t), t).toBe("∅ u1");
      // a possessive is a label still, and so is a team before a position
      expect(outcome(`${w} Vikings' Justin Jefferson recorded 12 tackles`), w).toBe(
        "Justin Jefferson/MIN/WR:full_name_team u0",
      );
      expect(outcome(`${w} Vikings WR Justin Jefferson recorded 12 tackles`), w).toBe(
        "Justin Jefferson/MIN/WR:full_name_team u0",
      );
    }
    // a period ends the clause, but after "vs" and "v"
    for (const w of CLAUSE_ABBREVIATIONS)
      for (const t of [
        `Week 9 ${w}. Vikings Justin Jefferson led`,
        `${w}. the Vikings Justin Jefferson led`,
      ])
        expect(outcome(t), t).toBe("∅ u1");
    // the clause opens: at the start, after punctuation, after a sentence's period
    for (const t of [
      "Vikings Justin Jefferson recorded 12 tackles",
      "Notes: Vikings Justin Jefferson recorded 12 tackles",
      "Notes. Vikings Justin Jefferson recorded 12 tackles",
      "Minnesota Vikings Justin Jefferson recorded 12 tackles",
    ])
      expect(outcome(t), t).toBe("Justin Jefferson/MIN/WR:full_name_team u0");
    expect(outcome("After the Eagles safety Michael Carter II left, the defense struggled")).toBe(
      "Michael Carter II/PHI/S:full_name_team u0",
    );
  });

  it("each blocker word: an ordinary-word position right after it is the ordinary word", () => {
    const mm = positionTwins([13, 1]);
    for (const w of LABEL_BLOCKERS) {
      // "After safety Lamar Jackson leads Ravens on winning drive" (the free-agent CB at 0.80 at dbe9686)
      for (const t of [`${w} safety Pat Twin scored`, `Notes: ${w} safety Pat Twin scored`])
        expect(mm.match(t), t).toEqual([]);
    }
    expect(mm.match("Veteran safety Pat Twin scored").map((r) => r.espn_id)).toEqual([9_400_013]);
  });

  it("in a segment written all in capitals, the forms that are ordinary words label no name before it", () => {
    for (const w of HEADLINE_ORDINARY_WORDS) {
      // "Browns edge Justin Jefferson's Vikings": the verb (the Browns LB at 0.95 at dbe9686)
      expect(outcome(`BROWNS ${w} JUSTIN JEFFERSON, VIKINGS IN OT`), w).toBe("∅ u1");
      expect(outcome(`Browns ${w} Justin Jefferson: Records sack`), w).toBe(
        "Justin Jefferson/CLE/LB:full_name_team u0",
      );
    }
    for (const form of CAPS_ONLY_ABBREVIATIONS) {
      const teams = TEAM_ABBREVIATIONS[form];
      if (teams?.length !== 1) continue;
      expect(twins.match(`${form} SAM TWIN: OUT`), form).toEqual([]);
      expect(
        twins.match(`${form} Sam Twin: Out`).map((r) => r.espn_id),
        form,
      ).toEqual(teams.map(twinOn));
      // in a tag the form is a label in any segment
      expect(
        twins.match(`SAM TWIN (${form}): OUT`).map((r) => r.espn_id),
        form,
      ).toEqual(teams.map(twinOn));
    }
  });

  it("a line or paragraph break the item writes is no adjacency (sanitizeText makes it a space)", () => {
    // "Opponent: Vikings" ends a line: the WR at 0.95 at dbe9686 and f41e810 for each
    expect(outcome("Browns IDP notes | Opponent: Vikings Justin Jefferson led the team.")).toBe(
      "Justin Jefferson/MIN/WR:full_name_team u0",
    );
    for (const br of [
      "\n",
      "\r",
      "\r\n",
      "\v",
      "\f",
      "\u0085",
      " ",
      " ",
      "<br>",
      "<br/>",
      "<BR />",
      "</p><p>",
      "<p>",
      "<div>",
      "</li><li>",
      "<b>",
      "&lt;br&gt;",
      "&#60;br&#62;",
      "&#x3C;br&#x3E;",
      "&amp;lt;br&amp;gt;",
      "&amp;amp;lt;p&amp;amp;gt;",
    ])
      expect(
        outcome(`Browns IDP notes | Opponent: Vikings${br}Justin Jefferson led the team.`),
        JSON.stringify(br),
      ).toBe("∅ u1");
    // and through the news build: the stored blurb keeps the line break (feeds.ts collapseLines)
    const b = news.buildNewsRows({
      format: news.NEWS_FILE_FORMAT,
      source: "rotowire",
      fetched_ms: NEWS_NOW_MS,
      xml: rss([
        {
          title: "Waiver wire, Week 9",
          description: "Released: Ravens\nLamar Jackson, cornerback, signed by the Bengals.",
          guid: "a",
        },
        {
          title: "Browns IDP notes",
          description: "<p>Week 9 vs. the Vikings</p><p>Justin Jefferson led the team.</p>",
          guid: "b",
        },
      ]),
      universe,
      previous: [],
      warnings: [],
    });
    expect(b.refs).toEqual([]);
    expect(b.counts).toMatchObject({ unmatched: 2, unresolved: 2 });
    expect(b.news.map((r) => r.blurb)).toContain(
      "Released: Ravens\nLamar Jackson, cornerback, signed by the Bengals.",
    );
  });

  it("every label form is a form the scan finds (a label is never a residual's)", () => {
    for (const w of [
      ...Object.keys(TEAM_NICKNAMES),
      ...Object.keys(TEAM_HOMES),
      ...Object.keys(SHARED_HOMES),
      ...Object.keys(TEAM_SHORT_NAMES),
      ...Object.keys(TEAM_ABBREVIATIONS),
      ...Object.keys(POSITION_ABBREVIATIONS),
      ...Object.keys(POSITION_WORDS),
    ].flatMap(spellingsOf))
      expect(news.scanFinds(w), w).toBe(true);
  });
});

// -----------------------------------------------------------------------------------------------
// Properties over the recorded universe's shared names.

/** The full-name keys more than one universe player holds, with the name as written (no suffix). */
const SHARED: readonly {
  readonly name: string;
  readonly holders: readonly NewsUniversePlayer[];
}[] = (() => {
  const byKey = new Map<string, NewsUniversePlayer[]>();
  for (const p of universe) {
    const k = mergeName(p.full_name);
    if (k === null || k.split(" ").length < 2) continue;
    byKey.set(k, [...(byKey.get(k) ?? []), p]);
  }
  return [...byKey.values()]
    .filter((hs) => hs.length > 1)
    .map((hs) => ({
      name: (hs[0]?.full_name ?? "").replace(/\s+(?:Jr\.?|Sr\.?|II|III|IV|V)$/u, ""),
      holders: hs,
    }));
})();
const owned = (p: NewsUniversePlayer): number => p.percent_owned ?? 0;
function prominentOf(hs: readonly NewsUniversePlayer[]): NewsUniversePlayer | null {
  const [top, ...rest] = [...hs].sort((a, b) => owned(b) - owned(a));
  return top !== undefined && owned(top) >= 1 && rest.every((p) => owned(top) >= 10 * owned(p))
    ? top
    : null;
}
/** Words that are no team and no position form in any case (and no universe name). */
// prettier-ignore
const NEUTRAL = [
  "limited", "questionable", "practice", "Wednesday", "Sunday", "ankle", "knee", "hamstring",
  "returns", "expected", "to", "play", "week", "game", "season", "status", "update", "per",
  "report", "sources", "say", "after", "missing", "time", "full", "participant", "listed",
  "doubtful", "yards", "touchdowns", "catches", "throws", "sprain", "injury", "notes", "with",
  "the", "a", "his", "and", "for", "in", "on", "last", "next", "two", "three", "No", "Timetable",
];
/** The words R8-3 read and R8-6 does not: cues, game words, moves, describing openings. */
// prettier-ignore
const NOT_LABELS = [
  "vs.", "against", "versus", "facing", "win over", "loss to", "beat", "host", "visits", "at",
  "sign", "signs", "waived by", "activated by", "joins", "claimed by", "traded to", "matchup",
  "The", "starter", "star", "veteran", "rookie", "former",
];
/** Every team form and position form of the closed lists (each found by the scan). */
const FORMS: readonly string[] = [
  ...Object.keys(TEAM_NICKNAMES),
  ...Object.keys(TEAM_HOMES),
  ...Object.keys(SHARED_HOMES),
  ...Object.keys(TEAM_SHORT_NAMES),
  ...Object.keys(TEAM_ABBREVIATIONS),
  ...Object.keys(SCAN_ONLY_TEAM_ABBREVIATIONS),
  ...Object.keys(TEAM_SINGULARS),
  ...Object.keys(TEAM_CITIES),
  ...Object.keys(SCAN_ONLY_TEAM_NAMES),
  ...Object.keys(POSITION_ABBREVIATIONS),
  ...Object.keys(POSITION_WORDS),
  ...SCAN_ONLY_ABBREVIATIONS,
  ...SCAN_ONLY_WORDS,
];
/** The abbreviations among them: written in capitals (a caps-only one counts only so). */
const ABBREVIATION_FORMS: ReadonlySet<string> = new Set([
  ...Object.keys(TEAM_ABBREVIATIONS),
  ...Object.keys(SCAN_ONLY_TEAM_ABBREVIATIONS),
  ...Object.keys(POSITION_ABBREVIATIONS),
  ...SCAN_ONLY_ABBREVIATIONS,
]);
/**
 * A form as it may be written: any case and spelling for a word, capitals for an abbreviation; bare,
 * with a possessive, as a handle or a hashtag, in parentheses, hyphenated to another word, ranked.
 */
const writeForm = (form: string, how: number): string => {
  if (ABBREVIATION_FORMS.has(form)) {
    const plural = form in POSITION_ABBREVIATIONS || SCAN_ONLY_ABBREVIATIONS.includes(form);
    const ws = [
      form,
      `${form}'s`,
      `@${form}`,
      `non-${form}`,
      `#${form}`,
      plural ? `${form}s` : form,
    ];
    return ws[how % ws.length] ?? form;
  }
  const c = cases(form).flatMap(spellingsOf);
  const w = c[how % c.length] ?? form;
  return [w, `${w}'s`, `(${w})`, `${w}-led`][Math.floor(how / 16) % 4] ?? w;
};

describe("properties over the recorded universe's shared names", () => {
  it("the universe's shared keys: 16, 5 with a prominent holder", () => {
    expect(SHARED).toHaveLength(16);
    expect(SHARED.filter((s) => prominentOf(s.holders) !== null)).toHaveLength(5);
  });

  it("property: with no label next to the name, a holder takes it only in the residual — the prominent one at 0.80", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SHARED),
        fc.array(fc.constantFrom(...NEUTRAL), { minLength: 1, maxLength: 8 }),
        fc.array(fc.constantFrom(...NEUTRAL, ...NOT_LABELS), { maxLength: 8 }),
        fc.option(fc.tuple(fc.constantFrom(...FORMS), fc.nat(), fc.boolean()), { nil: null }),
        fc.constantFrom(":", " -", ";"),
        fc.boolean(),
        (s, head, blurb, form, colon, nameFirst) => {
          // the name opens the item and is followed by punctuation, or follows punctuation: never a
          // label next to it; a team or a position form is written among the words, or none
          const words = [...blurb];
          if (form !== null)
            words.splice(form[1] % (words.length + 1), 0, writeForm(form[0], form[1]));
          const text = nameFirst
            ? `${s.name}${colon} ${head.join(" ")} | ${words.join(" ")}.`
            : `${head.join(" ")}. ${s.name}${colon} ${words.join(" ")}.`;
          const got = m.matchItem(text);
          const mine = got.refs.filter((r) => s.holders.some((h) => h.espn_id === r.espn_id));
          const top = prominentOf(s.holders);
          const scanFindsNothing = form === null && !blurb.some((w) => FORMS.includes(w));
          const want = scanFindsNothing && top !== null ? [[top.espn_id, "full_name", 0.8]] : [];
          expect(
            mine.map((r) => [r.espn_id, r.match_method, r.match_confidence]),
            text,
          ).toEqual(want);
          // counted when no one takes it (a form may be a shared surname too: "Strong Safety")
          if (want.length === 0) expect(got.unresolved, text).toBeGreaterThanOrEqual(1);
          else expect(got.unresolved, text).toBe(0);
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it("property: writing any team form or position form anywhere in a residual item takes the residual away", () => {
    const prominent = SHARED.filter((s) => prominentOf(s.holders) !== null);
    fc.assert(
      fc.property(
        fc.constantFrom(...prominent),
        fc.array(fc.constantFrom(...NEUTRAL), { minLength: 1, maxLength: 6 }),
        fc.array(fc.constantFrom(...NEUTRAL), { minLength: 1, maxLength: 6 }),
        fc.constantFrom(...FORMS),
        fc.nat(),
        fc.nat(),
        (s, head, blurb, form, how, where) => {
          const base = `${s.name}: ${head.join(" ")} | ${blurb.join(" ")}.`;
          const top = prominentOf(s.holders);
          expect(
            m.match(base).map((r) => r.espn_id),
            base,
          ).toContain(top?.espn_id);
          // never next to the name: in the headline after its first word, or in the blurb
          const inHead = where % 2 === 0;
          const ws = inHead ? [...head] : [...blurb];
          const at = inHead ? 1 + (where % ws.length) : where % (ws.length + 1);
          ws.splice(at, 0, writeForm(form, how));
          const text = inHead
            ? `${s.name}: ${ws.join(" ")} | ${blurb.join(" ")}.`
            : `${s.name}: ${head.join(" ")} | ${ws.join(" ")}.`;
          const got = m.matchItem(text);
          expect(
            got.refs.filter((r) => s.holders.some((h) => h.espn_id === r.espn_id)),
            text,
          ).toEqual([]);
          expect(got.unresolved, text).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: 2_000 },
    );
  });
});

// -----------------------------------------------------------------------------------------------
// Unique names, exactly as at f41e810: the refs a name one universe player holds gives (a full
// name, or a surname only one player holds) are the frozen oracle's, item by item.

const oracle = f41e810.buildPlayerMatcher(universe);
const keyOf = (p: NewsUniversePlayer): string => mergeName(p.full_name) ?? "";
const holdersOfKey = new Map<string, number>();
const sharersOfSurname = new Map<string, number>();
for (const p of universe) {
  const k = keyOf(p);
  holdersOfKey.set(k, (holdersOfKey.get(k) ?? 0) + 1);
  const s = k.split(" ").at(-1) ?? "";
  sharersOfSurname.set(s, (sharersOfSurname.get(s) ?? 0) + 1);
}
/** Whether a ref comes from a unique name: a unique full name, or a unique surname alone. */
function fromUniqueName(r: NewsPlayerRef): boolean {
  const p = byId.get(r.espn_id);
  if (p === undefined) return false;
  const k = keyOf(p);
  if ((holdersOfKey.get(k) ?? 0) > 1) return false;
  return (
    r.match_method !== "last_name_team" ||
    (sharersOfSurname.get(k.split(" ").at(-1) ?? "") ?? 0) === 1
  );
}
/** The unique-name refs of an item under both matchers (an item at the ref cap is left out). */
function uniqueRefs(text: string): { now: string; then: string } | null {
  const now = m.match(text);
  const then = oracle.match(text);
  if (now.length >= news.MAX_REFS_PER_ITEM || then.length >= news.MAX_REFS_PER_ITEM) return null;
  const key = (refs: readonly NewsPlayerRef[]): string =>
    refs
      .filter(fromUniqueName)
      .map((r) => `${String(r.espn_id)}:${r.match_method}:${String(r.match_confidence)}`)
      .sort()
      .join(", ");
  return { now: key(now), then: key(then) };
}

describe("names one universe player holds match exactly as at f41e810", () => {
  it("over the recorded fixture news (the captured feeds and the labelled titles)", () => {
    const texts: string[] = [];
    const dir = path.join(ROOT, "fixtures/news/captured");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".xml"))) {
      const doc = news.parseRss(readFileSync(path.join(dir, f), "utf8"));
      for (const it of doc.items)
        texts.push(`${news.collapse(it.title) ?? ""} | ${news.collapse(it.description) ?? ""}`);
    }
    for (const f of ["items.json", "holdout.json"]) {
      const doc = JSON.parse(
        readFileSync(path.join(ROOT, "fixtures/news/labelled", f), "utf8"),
      ) as { items: { title: string }[] };
      for (const it of doc.items) texts.push(it.title);
    }
    expect(texts.length).toBeGreaterThan(100);
    let compared = 0;
    for (const t of texts) {
      const u = uniqueRefs(t);
      if (u === null) continue;
      compared++;
      expect(u.now, t).toBe(u.then);
    }
    expect(compared).toBeGreaterThan(100);
  });

  it("property: over a generated corpus of unique and shared names, teams, positions, cues and moves", () => {
    const unique = universe.filter(
      (p) => (holdersOfKey.get(keyOf(p)) ?? 0) === 1 && !/['’.-]/u.test(p.full_name),
    );
    const surnames = unique
      .filter(
        (p) =>
          p.team !== null && (sharersOfSurname.get(keyOf(p).split(" ").at(-1) ?? "") ?? 0) === 1,
      )
      .map((p) => p.full_name.split(" ").at(-1) ?? "");
    const words = [
      ...NEUTRAL,
      ...NOT_LABELS,
      ...FORMS.flatMap((f) => [f, f.toLowerCase()]),
      "QB",
      "WR",
      "LB",
      "Ravens'",
      "matchup",
    ];
    const piece = fc.oneof(
      fc.constantFrom(...unique).map((p) => p.full_name),
      fc.constantFrom(...SHARED).map((s) => s.name),
      fc.constantFrom(...surnames),
      fc.constantFrom(...words),
      fc.constantFrom(":", ",", ".", "|", "(", ")", "-", "vs.", "&"),
    );
    fc.assert(
      fc.property(fc.array(piece, { minLength: 2, maxLength: 14 }), (pieces) => {
        const text = pieces.join(" ");
        const u = uniqueRefs(text);
        if (u === null) return;
        expect(u.now, text).toBe(u.then);
      }),
      { numRuns: 3_000 },
    );
  });
});
