// match-r88.test.ts — ruling R8-8 (1) (docs/plan/changelog.md §R8): the news matcher's one targeted
// round, against the 19 violations the attack on 08524ff left open (src/sources/news/match.ts,
// labels.ts, positions.ts). Each violation has a test here with every text it quoted, and each test
// whose behaviour changed fails at 08524ff on refs or counts: a suffix written after a surname mention
// (R8-7 (5)); the forms R8-7 (1)'s categories lacked (facilities, positions, a stadium in one case, city
// short names, ESPN's team-unit positions); the label and count losses of round 3's guards (an
// ordinary-word abbreviation after a game or move word, the possessive home and nickname, a capitalised
// word after a surname, the first-name reading, a team-word surname); the label reader's period and
// compound hashtag (R8-7 (3)); the all-caps possessive; and behaviour tests for every closed-list and
// code entry the attack found untested (LEAD_WORDS, STAFF_WORDS, the multi-team forms, 28 code entries).
// The crafted item's cost is held by match.perf.test.ts, spellingsOf's bound by positions.test.ts. Names
// one universe player holds still match exactly as at f41e810 (match-r86.test.ts). No network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { NflTeam } from "../../../src/config/schema.js";
import { NFL_TEAMS } from "../../../src/config/schema.js";
import { mergeName } from "../../../src/domain/crosswalk/normalize.js";
import { playersRows } from "../../../src/sources/espn_season/index.js";
import * as news from "../../../src/sources/news/index.js";
import {
  buildNewsRows,
  buildPlayerMatcher,
  NEWS_FILE_FORMAT,
  universeFromEspnPlayers,
  type NewsPlayerRef,
} from "../../../src/sources/news/index.js";
import * as F from "./forms.js";
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
// prettier-ignore
const POS: Readonly<Record<number, string>> = {
  1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 7: "P", 9: "DT", 10: "DE", 11: "LB", 12: "CB", 13: "S",
};
const tagOf = (id: number): string => {
  const p = byId.get(id);
  return p === undefined
    ? String(id)
    : `${p.full_name}/${p.team ?? "FA"}/${POS[p.position_id ?? -1] ?? "?"}`;
};
const show = (refs: readonly NewsPlayerRef[]): string =>
  refs.map((r) => `${tagOf(r.espn_id)}:${r.match_method}`).join(", ") || "∅";
/** An item's outcome: its refs, then how many shared names no one took ("∅ u1"). */
const outcome = (text: string): string => {
  const r = m.matchItem(text);
  return `${show(r.refs)} u${String(r.unresolved)}`;
};
/** Each text at its outcome. */
const expectEach = (rows: readonly (readonly [string, string])[]): void => {
  for (const [t, want] of rows) expect(outcome(t), t).toBe(want);
};
/** The holders of a full name, its suffix aside ("Byron Murphy II" and "Byron Murphy Jr."). */
const holdersOf = (name: string): Set<number> => {
  const key = name.replace(/\s+(?:Jr\.|II)$/u, "");
  return new Set(
    universe
      .filter((p) => p.full_name.replace(/\s+(?:Jr\.|II)$/u, "") === key)
      .map((p) => p.espn_id),
  );
};
/** Whether no holder of the full name `name` takes the item, and it is counted. */
const failsClosed = (text: string, name: string): boolean => {
  const ids = holdersOf(name);
  const r = m.matchItem(text);
  return r.refs.every((x) => !ids.has(x.espn_id)) && r.unresolved >= 1;
};
const RESIDUAL = "Justin Jefferson/MIN/WR:full_name u0";

// -----------------------------------------------------------------------------------------------
describe("violation 1 (R8-7 (5)): a suffix written after a surname mention is the name's spelling", () => {
  it("it excludes every holder ESPN spells otherwise: no residual, no label among them (each a ref at 08524ff)", () => {
    expectEach([
      // the prominent holder is excluded: the residual goes (TEN CB, BAL QB at 0.80 at 08524ff)
      ["Marcus Harris: Placed on IR | Harris II (knee) will miss the rest of the season.", "∅ u1"],
      ["Lamar Jackson: Questionable | Jackson Jr. (knee) was limited.", "∅ u1"],
      // a label fits no holder the suffix leaves (MIN CB, TEN RB at 0.95 at 08524ff)
      ["Vikings CB Murphy II: Questionable | Byron Murphy (hamstring) was limited.", "∅ u1"],
      ["Michael Carter: Questionable | Titans RB Carter II (ankle) was limited.", "∅ u1"],
      ["Byron Murphy: Questionable | Murphy II (Vikings CB) was limited.", "∅ u1"],
      // the controls that already behaved this way
      ["Marcus Harris II: Placed on IR | Harris (knee) will miss the rest of the season.", "∅ u1"],
      ["Titans RB Michael Carter II: Waived", "∅ u1"],
    ]);
  });

  it("…and a bare shared surname's: the sharers its label can fit", () => {
    expectEach([
      ["Vikings CB Murphy II: Questionable", "∅ u1"],
      ["Seahawks DT Murphy II: Records sack", "Byron Murphy II/SEA/DT:last_name_team u0"],
      ["Vikings CB Murphy Jr.: Questionable", "Byron Murphy Jr./MIN/CB:last_name_team u0"],
      // a tag after the suffix is the mention's label
      ["Murphy II (Seahawks DT): Records sack", "Byron Murphy II/SEA/DT:last_name_team u0"],
    ]);
  });

  it("…past choice 6's prominent holder when the suffix excludes him", () => {
    // "Twin" is shared; the prominent "Sam Twin II" would block a team-only label for his namesake
    const mm = buildPlayerMatcher([
      {
        espn_id: 9_700_011,
        full_name: "Sam Twin II",
        team: "MIN",
        gsis_id: null,
        percent_owned: 60,
      },
      {
        espn_id: 9_700_012,
        full_name: "Sam Twin Jr.",
        team: "CLE",
        gsis_id: null,
        percent_owned: 0.2,
      },
    ]);
    const r = (t: string): string => {
      const x = mm.matchItem(t);
      const refs = x.refs.map((y) => `${String(y.espn_id)}:${y.match_method}`).join(",");
      return `${refs || "∅"} u${String(x.unresolved)}`;
    };
    expect(r("Browns' Twin Jr.: Out")).toBe("9700012:last_name_team u0");
    expect(r("Browns' Twin: Out")).toBe("∅ u1");
  });

  it("through the news build: counted, no ref", () => {
    const b = buildNewsRows({
      format: NEWS_FILE_FORMAT,
      source: "rotowire",
      fetched_ms: NEWS_NOW_MS,
      xml: rss([
        {
          title: "Marcus Harris: Placed on IR",
          description: "Harris II (knee) will miss the rest of the season.",
          guid: "a",
        },
      ]),
      universe,
      previous: [],
      warnings: [],
    });
    expect(b.refs).toEqual([]);
    expect(b.counts).toMatchObject({ unresolved: 1 });
  });
});

// -----------------------------------------------------------------------------------------------
describe("violations 2-6 (R8-7 (1)): the forms the attack named inside the categories", () => {
  it("violation 2: the current training facilities and the camp town (each the star's at 0.80 at 08524ff)", () => {
    for (const [t, name] of [
      [
        "Byron Young: Back at practice | Young was spotted at the Jefferson Health Training Complex on Wednesday.",
        "Byron Young",
      ],
      [
        "Marcus Harris: Works out at Kettering Health Practice Fields | Harris auditioned Tuesday.",
        "Marcus Harris",
      ],
      [
        "Lamar Jackson: Tryout at IEL Indoor Facility | Jackson auditioned Tuesday.",
        "Lamar Jackson",
      ],
      [
        "Chris Jones: Works out at New Balance Practice Fields | Jones auditioned Tuesday.",
        "Chris Jones",
      ],
      [
        "Chris Jones: Visits Atrium Health Training Facility | Jones met with the coaches.",
        "Chris Jones",
      ],
      ["Chris Jones: Reports to camp in Rochester | Jones signed Monday.", "Chris Jones"],
      // the ones the attack found by accident (only through "Center" at 08524ff, or not at all)
      [
        "Lamar Jackson: Works out at Meijer Performance | Jackson auditioned Tuesday.",
        "Lamar Jackson",
      ],
      [
        "Lamar Jackson: Works out at Vanderbilt Health | Jackson auditioned Tuesday.",
        "Lamar Jackson",
      ],
      ["Lamar Jackson: Works out at CommonSpirit | Jackson auditioned Tuesday.", "Lamar Jackson"],
    ] as const)
      expect(failsClosed(t, name), t).toBe(true);
    // "Jefferson" in "Jefferson Health" is a word of the form, no surname
    expect(
      outcome(
        "Byron Young: Back at practice | Young was spotted at the Jefferson Health Training Complex on Wednesday.",
      ),
    ).toBe("∅ u1");
  });

  it("violation 3: the nose guard glued, NG, SE and ED (each the star's at 0.80 at 08524ff); as labels", () => {
    for (const [t, name] of [
      ["Marcus Harris: Released | The noseguard was let go Tuesday.", "Marcus Harris"],
      ["Marcus Harris: Released | The Noseguards were let go Tuesday.", "Marcus Harris"],
      ["Lamar Jackson: Released | The NG was let go Tuesday.", "Lamar Jackson"],
      ["Justin Jefferson: Moves to SE | Jefferson takes over the spot.", "Justin Jefferson"],
      ["Justin Jefferson: Released | The ED was let go Tuesday.", "Justin Jefferson"],
    ] as const)
      expect(failsClosed(t, name), t).toBe(true);
    expectEach([
      ["NG Byron Young: Two sacks", "Byron Young/PHI/DT:full_name u0"],
      ["Byron Young (NG): Two sacks", "Byron Young/PHI/DT:full_name u0"],
      ["ED Byron Young: Two sacks", "Byron Young/LA/DE:full_name u0"],
      ["SE Justin Jefferson: Questionable", "Justin Jefferson/MIN/WR:full_name u0"],
      // "Ed" is a name: in lower or title case ED is an ordinary word (R8-7 (2))
      ["Justin Jefferson: Released | Ed was let go Tuesday.", RESIDUAL],
    ]);
  });

  it("violation 4: FedExField in one case, capitals or lower (each the star's at 0.80 at 08524ff)", () => {
    for (const t of [
      "LAMAR JACKSON: WORKS OUT AT FEDEXFIELD",
      "Lamar Jackson: Works out at fedexfield | Jackson auditioned Tuesday.",
      "Lamar Jackson: Works out at FedExField | Jackson auditioned Tuesday.",
    ])
      expect(failsClosed(t, "Lamar Jackson"), t).toBe(true);
  });

  it("violation 5: the city short names (each the star's at 0.80 at 08524ff)", () => {
    for (const w of ["Phila.", "Phila", "PGH", "Pgh", "MSP", "PHL", "the Valley"]) {
      const t = `Lamar Jackson: Works out in ${w} | Jackson auditioned Tuesday.`;
      expect(failsClosed(t, "Lamar Jackson"), t).toBe(true);
    }
  });

  it("violation 6: ESPN's team-unit positions HC, TQB and D/ST (each the star's at 0.80 at 08524ff)", () => {
    for (const [t, name] of [
      ["Lamar Jackson: Released | The HC said the team moved on.", "Lamar Jackson"],
      ["Lamar Jackson: Released | The head coach said the team moved on.", "Lamar Jackson"],
      ["Lamar Jackson: Released | The head coaches were let go.", "Lamar Jackson"],
      ["Justin Jefferson: Released | The TQB was let go.", "Justin Jefferson"],
      ["Justin Jefferson: Burned by the DST", "Justin Jefferson"],
      ["Justin Jefferson: Burned by the d/st", "Justin Jefferson"],
      ["Lamar Jackson: Released | The D-ST was let go.", "Lamar Jackson"],
      ["Lamar Jackson: Released | The D ST was let go.", "Lamar Jackson"],
    ] as const)
      expect(failsClosed(t, name), t).toBe(true);
    // as a label they fit no universe player (ESPN lists its team units under negative ids)
    expect(outcome("TQB Justin Jefferson: Released")).toBe("∅ u1");
  });
});

// -----------------------------------------------------------------------------------------------
describe("violations 7-11: the label and count losses of round 3's guards", () => {
  it("violation 7: an ordinary-word abbreviation in capitals labels after a game or move word (each ∅ u1 at 08524ff)", () => {
    expectEach([
      ["Injury update for MIN WR Justin Jefferson", "Justin Jefferson/MIN/WR:full_name_team u0"],
      [
        "The latest on TEN CB Marcus Harris: Questionable",
        "Marcus Harris/TEN/CB:full_name_team u0",
      ],
      ["Two sacks for LA DE Byron Young", "Byron Young/LA/DE:full_name_team u0"],
      ["Good news for SEA DT Byron Murphy II", "Byron Murphy II/SEA/DT:full_name_team u0"],
      ["Status of PHI DT Byron Young uncertain", "Byron Young/PHI/DT:full_name_team u0"],
      ["Injury update for TEN RB Michael Carter", "Michael Carter/TEN/RB:full_name_team u0"],
      ["Injury update for L.A. DE Byron Young", "Byron Young/LA/DE:full_name_team u0"],
      ["Two sacks from DE Byron Young", "Byron Young/LA/DE:full_name u0"],
      ["Big day for DE Byron Young", "Byron Young/LA/DE:full_name u0"],
      ["Injury update for MIN WR Jefferson", "Justin Jefferson/MIN/WR:last_name_team u0"],
      [
        "Justin Jefferson: Questionable | Injury update for MIN WR Jefferson.",
        "Justin Jefferson/MIN/WR:full_name_team u0",
      ],
      ["INJURY UPDATE FOR MIA DT JORDAN PHILLIPS", "Jordan Phillips/MIA/DT:full_name_team u0"],
      [
        "Browns CB Denzel Ward vs. MIN WR Justin Jefferson: Week 9 matchup",
        "Denzel Ward/CLE/CB:full_name_team, Justin Jefferson/MIN/WR:full_name_team u0",
      ],
      ["Injury update for MIA WR Washington", "Malik Washington/MIA/WR:last_name_team u0"],
    ]);
  });

  it("…but in lower or title case there it is the ordinary word or a first name: counted, no label", () => {
    expectEach([
      ["Kyler Murray: Throws TD to Will Jefferson", "Kyler Murray/MIN/QB:full_name u1"],
      [
        "Kyler Murray: Throws TD to WILL Jefferson",
        "Kyler Murray/MIN/QB:full_name, Justin Jefferson/CLE/LB:last_name_team u0",
      ],
      // the scan reads both (R8-7 (2)): no residual
      ["Justin Jefferson: Notes | Traded to Will Smith's team", "∅ u2"],
    ]);
  });

  it("violation 8: the possessive home-and-nickname label after a word (each ∅ at 08524ff)", () => {
    expectEach([
      ["NFL fines the Kansas City Chiefs' Chris Jones", "Chris Jones/KC/DT:full_name_team u0"],
      ["Fine looms for Kansas City Chiefs' Chris Jones", "Chris Jones/KC/DT:full_name_team u0"],
      [
        "Questions surround the Minnesota Vikings' Justin Jefferson",
        "Justin Jefferson/MIN/WR:full_name_team u0",
      ],
      ["Two sacks for the Los Angeles Rams' Byron Young", "Byron Young/LA/DE:full_name_team u0"],
      [
        "Lamar Jackson: Sacked | The Pittsburgh Steelers sacked the Baltimore Ravens' Lamar Jackson five times.",
        "Lamar Jackson/BAL/QB:full_name_team u0",
      ],
      [
        "Marcus Harris: Fined | The NFL fined the Tennessee Titans' Marcus Harris on Friday.",
        "Marcus Harris/TEN/CB:full_name_team u0",
      ],
      // the coach's own surname is counted (violation 10)
      [
        "Justin Jefferson: Questionable | Coach Kevin O'Connell said the Minnesota Vikings' Justin Jefferson is day-to-day.",
        "Justin Jefferson/MIN/WR:full_name_team u1",
      ],
      [
        "Justin Jefferson: Questionable | The Minnesota Vikings' Jefferson was limited.",
        "Justin Jefferson/MIN/WR:full_name_team u0",
      ],
      ["NFL fines the Kansas City Chiefs' Jones on Friday.", "Chris Jones/KC/DT:last_name_team u0"],
      [
        "Fine for Washington | The NFL fined the Jacksonville Jaguars' Washington on Friday.",
        "Parker Washington/JAX/WR:last_name_team u0",
      ],
      // without the possessive, teams alone after a word are its object still
      ["NFL fines the Kansas City Chiefs Chris Jones", "∅ u1"],
    ]);
  });

  it("violation 9: a capitalised word after a bare surname leaves it a mention; its label picks (each ∅ u0 at 08524ff)", () => {
    expectEach([
      [
        "Vikings WR Jefferson Still Limited At Practice",
        "Justin Jefferson/MIN/WR:last_name_team u0",
      ],
      ["Ravens QB Jackson Likely To Play Sunday", "Lamar Jackson/BAL/QB:last_name_team u0"],
      ["Titans CB Harris Still Sidelined", "Marcus Harris/TEN/CB:last_name_team u0"],
      ["Vikings' Jefferson Still Limited", "Justin Jefferson/MIN/WR:last_name_team u0"],
      // the next capitalised word is a shared surname too: it is counted, no label before it
      ["Rams DE Young Key In Win Over 49ers", "Byron Young/LA/DE:last_name_team u1"],
      [
        "Vikings WR Jefferson Long Shot To Play Sunday",
        "Justin Jefferson/MIN/WR:last_name_team u1",
      ],
      ["Chiefs DT Jones Key In Win Over Raiders", "Chris Jones/KC/DT:last_name_team u1"],
      ["Rams DE Young Strong In Win", "Byron Young/LA/DE:last_name_team u1"],
      [
        "Justin Jefferson: Questionable | Vikings WR Jefferson Still Limited.",
        "Justin Jefferson/MIN/WR:full_name_team u0",
      ],
      // beside other refs (each that ref alone at 08524ff)
      [
        "Ravens QB Jackson Still Limited | Zay Flowers (ankle) was a full participant.",
        "Zay Flowers/BAL/WR:full_name_team, Lamar Jackson/BAL/QB:last_name_team u0",
      ],
      [
        "Chiefs DT Jones Still Out | Patrick Mahomes threw two touchdowns.",
        "Patrick Mahomes/KC/QB:full_name_team, Chris Jones/KC/DT:last_name_team u0",
      ],
      [
        "Patrick Mahomes: Scores twice | Jones Still Limited.",
        "Patrick Mahomes/KC/QB:full_name u1",
      ],
      [
        "Puka Nacua, Vikings WR Jefferson Still Questionable",
        "Puka Nacua/LA/WR:full_name, Justin Jefferson/MIN/WR:last_name_team u0",
      ],
    ]);
  });

  it("violation 10: a capitalised word before a shared surname makes it no first name's word (each u0 at 08524ff)", () => {
    expectEach([
      [
        "Vikings Place Jefferson On IR | Jordan Addison will start Sunday.",
        "Jordan Addison/MIN/WR:full_name_team u1",
      ],
      [
        "Ravens Sign Jackson To Practice Squad | Zay Flowers (ankle) was limited.",
        "Zay Flowers/BAL/WR:full_name_team u1",
      ],
      [
        "Is Jackson playing tonight? | Zay Flowers (ankle) is also questionable.",
        "Zay Flowers/BAL/WR:full_name u1",
      ],
      [
        "Should Jefferson play Sunday? | Jordan Addison (ankle) is also questionable.",
        "Jordan Addison/MIN/WR:full_name u1",
      ],
      [
        "Jordan Addison: Expected to play | Expect Jefferson to draw the coverage.",
        "Jordan Addison/MIN/WR:full_name u1",
      ],
      [
        "Joe Burrow: Throws two TDs | Burrow found Pro Bowler Jefferson twice.",
        "Joe Burrow/CIN/QB:full_name u1",
      ],
      [
        "Jordan Addison: Two TDs | Addison and All-Pro Jefferson combined for 200 yards.",
        "Jordan Addison/MIN/WR:full_name u1",
      ],
      [
        "Bijan Robinson: Runs for 150 | Robinson outshone MVP Jackson on Sunday.",
        "Bijan Robinson/ATL/RB:full_name u1",
      ],
      ["Ravens MVP Jackson: Limited in practice", "∅ u1"],
      ["Chiefs All-Pro Jones: Fined for hit", "∅ u1"],
      // a team's one-word short name directly before it is a label
      ["Vikes Jefferson: Questionable", "Justin Jefferson/MIN/WR:last_name_team u0"],
      ["Pack Johnson: Questionable", "Kaleb Johnson/GB/RB:last_name_team u0"],
      ["Cincy Taylor: Questionable", "Ja'Sir Taylor/CIN/CB:last_name_team u0"],
      // a one-word singular or place without a possessive may be a first name: counted, no label (the
      // BUF RB and the CAR DE are each the one sharer on its team)
      ["Bill Johnson: Signs with team", "∅ u1"],
      ["Charlotte Jones: Cowboys executive speaks", "∅ u1"],
      ["Bill's Johnson: Questionable", "Ty Johnson/BUF/RB:last_name_team u0"],
      // a town, a stadium (the one MIN Smith, the one KC Jones); a form of several words labels
      ["Eagan Smith: Questionable", "∅ u1"],
      ["Eagan's Smith: Questionable", "Harrison Smith/MIN/S:last_name_team u0"],
      ["Arrowhead Jones: Questionable", "∅ u1"],
      ["Arrowhead's Jones: Questionable", "Chris Jones/KC/DT:last_name_team u0"],
      ["Orchard Park Johnson: Questionable", "Ty Johnson/BUF/RB:last_name_team u0"],
    ]);
  });

  it("violation 11: a team-word surname with no label is counted, beside other refs too (each u0 at 08524ff)", () => {
    expectEach([
      [
        "Terry McLaurin: Scores twice | Washington (ankle) did not return.",
        "Terry McLaurin/WAS/WR:full_name_team u1",
      ],
      [
        "Jalen Hurts: Scores twice | Green (hamstring) did not return.",
        "Jalen Hurts/PHI/QB:full_name u1",
      ],
      [
        "Travis Kelce: Two TDs | Kelce and Houston combined for 200 yards.",
        "Travis Kelce/KC/TE:full_name u1",
      ],
      // followed by its team's own name it is the team; its own team in a tag after it labels nothing
      ["Washington Commanders sign veteran", "∅ u0"],
      ["Houston Texans: Sign veteran", "∅ u0"],
      ["Washington (WAS): Questionable", "∅ u1"],
    ]);
  });
});

// -----------------------------------------------------------------------------------------------
describe("violation 12 (R8-7 (3)): the label reader reads a period and a compound hashtag as the scan does", () => {
  it("a state's period, an initialism's in a segment all in capitals (each ∅ or the team lost at 08524ff)", () => {
    expectEach([
      ["Tenn.'s Marcus Harris: Placed on IR", "Marcus Harris/TEN/CB:full_name_team u0"],
      ["Marcus Harris (Tenn.): Placed on IR", "Marcus Harris/TEN/CB:full_name_team u0"],
      ["Justin Jefferson, Minn.: Placed on IR", "Justin Jefferson/MIN/WR:full_name_team u0"],
      ["Justin Jefferson (Minn.): Questionable", "Justin Jefferson/MIN/WR:full_name_team u0"],
      ["Byron Young (Calif.): Two sacks", "Byron Young/LA/DE:full_name_team u0"],
      ["Lamar Jackson (Md.): Limited", "Lamar Jackson/BAL/QB:full_name_team u0"],
      ["Chris Jones (MO.): Fined for hit", "Chris Jones/KC/DT:full_name_team u0"],
      ["Byron Young (St. Louis): Two sacks", "Byron Young/LA/DE:full_name_team u0"],
      ["Tenn. CB Marcus Harris: Questionable for Sunday", "Marcus Harris/TEN/CB:full_name_team u0"],
      ["L.A.'S BYRON YOUNG: TWO SACKS", "Byron Young/LA/DE:full_name_team u0"],
      ["N.O.'S DAVID LONG JR.: QUESTIONABLE", "David Long Jr./NO/CB:full_name_team u0"],
      ["N.O. CB DAVID LONG JR.: BREAKS UP PASS", "David Long Jr./NO/CB:full_name_team u0"],
      ["L.A.'S YOUNG: TWO SACKS", "Byron Young/LA/DE:last_name_team u0"],
    ]);
  });

  it("…and only those: a team code's stray period, or one right before the name, is punctuation", () => {
    expectEach([
      ["Marcus Harris, TEN.: Out", "∅ u1"],
      ["Marcus Harris (TEN.): Out", "∅ u1"],
      ["Justin Jefferson (Rams. CB): Out", "∅ u1"],
      ["Justin Jefferson: Notes | Traded to MIN. Justin Jefferson said he is happy.", "∅ u1"],
      ["MIN. WR Justin Jefferson: Questionable", "Justin Jefferson/MIN/WR:full_name u0"],
      // a state's period right before the name may end a sentence: no label
      ["Tenn. Marcus Harris: Questionable", "∅ u1"],
    ]);
  });

  it("a compound hashtag's teams: before the name and in its tag (each ∅ or the team lost at 08524ff)", () => {
    expectEach([
      ["#ChiefsKingdom Chris Jones: Two sacks", "Chris Jones/KC/DT:full_name_team u0"],
      ["#TitanUp Marcus Harris: Placed on IR", "Marcus Harris/TEN/CB:full_name_team u0"],
      ["Chris Jones (#ChiefsKingdom): Two sacks", "Chris Jones/KC/DT:full_name_team u0"],
      ["Chris Jones (DT, #ChiefsKingdom): Two sacks", "Chris Jones/KC/DT:full_name_team u0"],
      ["Chris Jones (DT #ChiefsKingdom): Two sacks", "Chris Jones/KC/DT:full_name_team u0"],
      [
        "#ChiefsKingdom DT Chris Jones: Questionable for Sunday",
        "Chris Jones/KC/DT:full_name_team u0",
      ],
      [
        "#TitanUp CB Marcus Harris: Questionable for Sunday",
        "Marcus Harris/TEN/CB:full_name_team u0",
      ],
      // a hashtag naming two teams fits neither alone
      ["#CLEvsMIN Justin Jefferson: Out", "∅ u1"],
    ]);
  });
});

// -----------------------------------------------------------------------------------------------
describe("violation 13: the all-caps possessive of a shared name", () => {
  it("is read as the name, a shared one only (each uncounted at 08524ff)", () => {
    // as the same name written with "'s" in lower case: the residual, or the label
    expect(
      outcome("JUSTIN JEFFERSON'S STATUS UNCLEAR | Jordan Addison (ankle) is expected to play."),
    ).toBe(
      outcome("Justin Jefferson's status unclear | Jordan Addison (ankle) is expected to play."),
    );
    expectEach([
      [
        "JUSTIN JEFFERSON'S STATUS UNCLEAR | Jordan Addison (ankle) is expected to play.",
        "Justin Jefferson/MIN/WR:full_name, Jordan Addison/MIN/WR:full_name u0",
      ],
      ["VIKINGS WR JUSTIN JEFFERSON'S STATUS UNCLEAR", "Justin Jefferson/MIN/WR:full_name_team u0"],
      [
        "JEFFERSON'S STATUS UNCLEAR | Jordan Addison (ankle) is expected to play.",
        "Jordan Addison/MIN/WR:full_name u1",
      ],
      ["Justin Jefferson’S status unclear", "Justin Jefferson/MIN/WR:full_name u0"],
      // each apostrophe-like mark of the kept possessive
      [
        "JEFFERSON’S STATUS UNCLEAR | Jordan Addison (ankle) is expected to play.",
        "Jordan Addison/MIN/WR:full_name u1",
      ],
      [
        "JEFFERSONʼS STATUS UNCLEAR | Jordan Addison (ankle) is expected to play.",
        "Jordan Addison/MIN/WR:full_name u1",
      ],
      [
        "Lamar Jackson: Questionable | JEFFERSON'S STATUS UNCLEAR.",
        "Lamar Jackson/BAL/QB:full_name u1",
      ],
      // the kept possessive of a surname the item's full name ends with is that name's mention
      [
        "Justin Jefferson: Questionable | Vikings WR JEFFERSON'S status unclear.",
        "Justin Jefferson/MIN/WR:full_name_team u0",
      ],
      // a possessive before a period (f41e810's cuts leave it)
      [
        "Justin Jefferson's. | Jordan Addison (ankle) is expected to play.",
        "Justin Jefferson/MIN/WR:full_name, Jordan Addison/MIN/WR:full_name u0",
      ],
      // a name one universe player holds stays as at f41e810: unmatched
      ["PATRICK MAHOMES'S STATUS UNCLEAR", "∅ u0"],
    ]);
  });
});

// -----------------------------------------------------------------------------------------------
describe("violation 15: every LEAD_WORDS and STAFF_WORDS entry, word for word and by a behaviour", () => {
  const cap = (w: string): string => `${w.slice(0, 1).toUpperCase()}${w.slice(1)}`;
  const surnameHolders = (s: string): number =>
    universe.filter((p) => (mergeName(p.full_name) ?? "").split(" ").at(-1) === s).length;

  it("word for word", () => {
    expect([...news.LEAD_WORDS].sort()).toEqual([...F.LEAD_WORDS].sort());
    expect([...news.STAFF_WORDS].sort()).toEqual([...F.STAFF_WORDS].sort());
  });

  it("a lead word before a surname one universe player holds leaves it his, on the f41e810 path", () => {
    expect(surnameHolders("addison")).toBe(1);
    for (const w of F.LEAD_WORDS) {
      // "Vikings notes: Sources Addison caught two passes" (no ref with the entry deleted: the word is
      // read as a first name)
      const t = `Vikings notes: ${cap(w)} Addison caught two passes.`;
      expect(outcome(t), t).toBe("Jordan Addison/MIN/WR:last_name_team u0");
    }
    // any other capitalised word before it is another name's (f41e810)
    expect(outcome("Vikings notes: Morgan Addison caught two passes.")).toBe("∅ u0");
  });

  it("a staff word before a surname makes it a staff member's, a unique or a shared one", () => {
    expect(surnameHolders("burrow")).toBe(1);
    for (const w of F.STAFF_WORDS) {
      // "Bengals coaches Burrow …" (Joe Burrow at 0.60 with the entry deleted), "Vikings oc Jefferson …"
      // (counted with the entry deleted)
      expect(outcome(`Bengals ${w} Burrow said the offense is fine.`), w).toBe("∅ u0");
      expect(outcome(`Vikings ${w} Jefferson said the offense is fine.`), w).toBe("∅ u0");
    }
    expect(outcome("Bengals notes Burrow said the offense is fine.")).toBe(
      "Joe Burrow/CIN/QB:last_name_team u0",
    );
  });
});

// -----------------------------------------------------------------------------------------------
describe("violation 16: every team of every form that names several, by a behaviour", () => {
  /** Two holders named "Sam Twin", on `a` and on `b`, none prominent. */
  const pair = (a: NflTeam, b: NflTeam) =>
    buildPlayerMatcher([
      { espn_id: 9_800_001, full_name: "Sam Twin", team: a, gsis_id: null, percent_owned: 0.5 },
      { espn_id: 9_800_002, full_name: "Sam Twin", team: b, gsis_id: null, percent_owned: 0.5 },
    ]);
  const several = [
    ...Object.values(F.TEAM_WORD_LISTS).flatMap((l) => Object.entries(l)),
    ...Object.values(F.TEAM_ABBREVIATION_LISTS).flatMap((l) => Object.entries(l)),
  ]
    .map(([form, t]) => [form, F.teamsOf(t)] as const)
    .filter(([, teams]) => teams.length > 1);

  it("the forms that name several teams", () => {
    // "Queen City", "Birds", "Cats", FL, CA … (each team's deletion survived every behaviour test)
    expect(several.length).toBeGreaterThan(30);
    expect(several.map(([f]) => f)).toEqual(
      expect.arrayContaining(["Queen City", "Birds", "Cats", "FL", "FLA", "CA", "CALIF"]),
    );
  });

  it("each team of each: its possessive picks the holder on that team beside one on a team it does not name", () => {
    for (const [form, teams] of several) {
      const other = NFL_TEAMS.find((t) => !teams.includes(t));
      expect(other, form).toBeDefined();
      for (const team of teams) {
        const mm = pair(team, other ?? "ARI");
        const text = `${form}'s Sam Twin: Out`;
        expect(
          mm.match(text).map((r) => r.espn_id),
          `${form} → ${team}`,
        ).toEqual([9_800_001]);
      }
    }
  });
});

// -----------------------------------------------------------------------------------------------
describe("violation 17: the code entries no test held, each by a behaviour", () => {
  it("the scan: a possessive's capital S, a period's and an ampersand's parts, a later part's game word, a dotted form in capitals, a spelling's article, a technique's number", () => {
    expectEach([
      // scanText's possessive [sS]
      ["JUSTIN JEFFERSON: QUESTIONABLE | NOTES: CARDINALS'S STATUS, AS OF WEDNESDAY.", "∅ u1"],
      ["Justin Jefferson: Questionable | Notes: Cardinals'S status.", "∅ u1"],
      // scanText's "." split; the "&" parts rule
      ["Byron Young: Two sacks | Green Bay.Green Bay", "∅ u1"],
      ["Lamar Jackson: Limited | Cardinals&Cardinals notes", "∅ u1"],
      // the game-word context of a word's later part
      ["Justin Jefferson: Out | vs.Sea", "∅ u1"],
      ["Justin Jefferson: Out | to-Den", "∅ u1"],
      // formAt's `dotted ||`: an initialism counts in a segment all in capitals
      ["LAMAR JACKSON: N.O. BOUND", "∅ u1"],
      ["JUSTIN JEFFERSON: L.A. NEXT", "∅ u1"],
      // a spaced spelling never opens with "a" ("A-Town" is no "a town")
      [
        "Lamar Jackson: Signs | He visited a town hall Tuesday.",
        "Lamar Jackson/BAL/QB:full_name u0",
      ],
      // POSITION_PHRASE_HEADS' digits and number words
      ["Justin Jefferson: Out | He plays the 3 technique spot.", "∅ u1"],
      ["Justin Jefferson: Out | He plays the three technique spot.", "∅ u1"],
      ["Byron Young: Two sacks | The five technique held.", "∅ u1"],
      // positionKey's apostrophe
      ["Justin Jefferson: Out | The d'line reserve was cut", "∅ u1"],
    ]);
  });

  it("the labels: a possessive's capital S, a possessive position, a break between segments", () => {
    expectEach([
      // labelEnd's "'S"
      ["ST. LOUIS'S BYRON YOUNG: TWO SACKS", "Byron Young/LA/DE:full_name_team u0"],
      ["K.C.'S CHRIS JONES: FINED", "Chris Jones/KC/DT:full_name_team u0"],
      // formEndingAt's rule: a position with a possessive is no label
      ["P's Jones: Out", "∅ u1"],
      ["S's Jones: Out", "∅ u1"],
      // passOf's break: a line break opens a segment, so the title's bare name is no contrast
      [
        "Justin Jefferson: Out\r\nVikings WR Jefferson (hamstring) was limited.",
        "Justin Jefferson/MIN/WR:full_name_team u0",
      ],
    ]);
  });

  it("the tokenizer: the curly apostrophes, the leading punctuation, a digit, the possessive and trailing marks", () => {
    expectEach([
      // CHUNK_RE's ’ and ʼ (a name one universe player holds, as at f41e810)
      ["Ja’Marr Chase: Catches TD", "Ja'Marr Chase/CIN/WR:full_name u0"],
      ["JaʼMarr Chase: Catches TD", "Ja'Marr Chase/CIN/WR:full_name u0"],
      // the possessive's ’ and ʼ on a surname one player holds (f41e810's path)
      ["Bengals QB Burrow’s status: Questionable", "Joe Burrow/CIN/QB:last_name_team u0"],
      ["Bengals QB Burrowʼs status: Questionable", "Joe Burrow/CIN/QB:last_name_team u0"],
      // the possessive's ’ and ʼ
      ["Vikings WR Jefferson’s status: Questionable", "Justin Jefferson/MIN/WR:last_name_team u0"],
      ["Vikings WR Jeffersonʼs status: Questionable", "Justin Jefferson/MIN/WR:last_name_team u0"],
      ["Vikings WR Jefferson' status: Questionable", "Justin Jefferson/MIN/WR:last_name_team u0"],
      // the leading "." "’" "-", and the trailing "." "-"
      [".Jefferson: Questionable", "∅ u1"],
      ["Vikings WR .Jefferson: Questionable", "Justin Jefferson/MIN/WR:last_name_team u0"],
      ["’Jefferson: Questionable", "∅ u1"],
      ["Vikings WR ’Jefferson: Questionable", "Justin Jefferson/MIN/WR:last_name_team u0"],
      ["ʼJefferson: Questionable", "∅ u1"],
      ["Vikings WR ʼJefferson: Questionable", "Justin Jefferson/MIN/WR:last_name_team u0"],
      ["-Jefferson: Questionable", "∅ u1"],
      ["Vikings WR -Jefferson: Questionable", "Justin Jefferson/MIN/WR:last_name_team u0"],
      ["Vikings WR Jefferson.: Questionable", "Justin Jefferson/MIN/WR:last_name_team u0"],
      ["Vikings WR Jefferson-: Questionable", "Justin Jefferson/MIN/WR:last_name_team u0"],
      // the trailing cut runs before the kept possessive is read ("Jefferson's-")
      ["Vikings WR Jefferson's- status: Questionable", "Justin Jefferson/MIN/WR:last_name_team u0"],
      // CHUNK_RE's \p{N}: "49ER" is a word, so "JONES" is counted; a digit glued to a first name makes
      // the word no name ("2Joe Burrow", as at f41e810)
      ["49ER JONES: OUT", "∅ u1"],
      ["2Joe Burrow: Questionable", "∅ u0"],
      ["2Lamar Jackson: Questionable", "∅ u1"],
    ]);
  });

  it("the shared-name guards: a bare surname before a label in another segment; a segment both labelled and not", () => {
    expectEach([
      [
        "Jefferson: Questionable | Vikings WR Justin Jefferson (hamstring) was limited.",
        "Justin Jefferson/MIN/WR:full_name_team u0",
      ],
      ["Vikings WR Jefferson: Questionable; Jefferson (hamstring) did not practice.", "∅ u1"],
    ]);
  });

  it("the forms of several words a surname stands in: joined by a period, a hyphen, before a capital S", () => {
    expectEach([
      // phraseSpans' possessive [sS], its "." and "-" parts: "Ford", "Wilson" no surname there
      ["Justin Jefferson: Questionable | Notes: Ford Center'S status.", "∅ u1"],
      ["Byron Young: Two sacks | Ford Field.Ford Field", "∅ u1"],
      ["Byron Young: Two sacks | ex-Ralph Wilson notes", "∅ u1"],
      // the head pre-check reads a word's last part after a hyphen or a period ("Love" no surname)
      ["Byron Young: Two sacks | ex-Brotherly Love notes", "∅ u1"],
      ["Byron Young: Two sacks | Notes.Brotherly Love notes", "∅ u1"],
    ]);
  });
});
