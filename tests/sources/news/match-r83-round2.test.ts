// match-r83-round2.test.ts — ruling R8-3 (docs/plan/changelog.md §R8), the independent attack on its
// first build (52796bf) and the fixes of round 2 (src/sources/news/match.ts, cues.ts, positions.ts,
// teams.ts; changelog §B9). One describe per violation the attack found, each with the attack's own
// texts (public NFL names of the recorded fixture; no league, owner or member identifier), then the
// cue lists entry by entry in both readings, the fixer's own further attacks, and fast-check
// properties over the recorded universe's shared names. Every violation test fails at 52796bf.
// No network.
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
  NEWS_FILE_FORMAT,
  POSITION_WORDS,
  RESULT_CUES,
  TEAM_NICKNAMES,
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
/** The universe player of `name` on `team` at ESPN position `position` (several free agents). */
function idAt(name: string, team: string | null, position: number): number {
  const p = universe.find(
    (x) => x.full_name === name && x.team === team && x.position_id === position,
  );
  if (p === undefined) throw new Error(`${name} ${String(team)} ${String(position)}`);
  return p.espn_id;
}
const refs = (text: string) => m.match(text).map((r) => [r.espn_id, r.match_method]);
/** No ref, and the shared name counted (R8-3 clause 5). */
const NONE = { refs: [], unresolved: 1 };

const QB_LAMAR = idOf("Lamar Jackson", "BAL");
const CB_LAMAR = idOf("Lamar Jackson", null);
const WR_JEFFERSON = idOf("Justin Jefferson", "MIN");
const LB_JEFFERSON = idOf("Justin Jefferson", "CLE");
const DE_YOUNG = idOf("Byron Young", "LA");
const DT_YOUNG = idOf("Byron Young", "PHI");
const CB_HARRIS = idOf("Marcus Harris", "TEN");
const DT_HARRIS = idOf("Marcus Harris", "KC");
const DT_JONES = idOf("Chris Jones", "KC");

describe("V1 (clauses 2, 3): a loose mention never cancels a cue, nor counts for the star", () => {
  it("the namesake's item with the star's team named again loosely, or in full: no ref (was the star)", () => {
    for (const title of [
      "Justin Jefferson: Out for season | Jefferson tore his ACL in Sunday's win over the Minnesota Vikings, the team announced Monday.",
      "Justin Jefferson: Out for season | Jefferson tore his ACL in Sunday's win over the Vikings. Minnesota fell to 3-5.",
      "Lamar Jackson: Carted off with ankle injury | Jackson was hurt covering a punt in Sunday's loss to the Baltimore Ravens.",
      "Lamar Jackson: Carted off with ankle injury | Jackson was hurt covering a punt in Sunday's loss to the Ravens. Baltimore led throughout.",
      "Lamar Jackson: Intercepts a pass against the Baltimore Ravens",
      "Justin Jefferson: Leads team in tackles | Jefferson recorded 11 tackles (seven solo) in Sunday's 24-20 loss to the Vikings. Minnesota converted 8 of 13 third downs.",
      "Marcus Harris: Sack in win over the Tennessee Titans",
      "Byron Young: Sacks Rams QB | The Rams struggled to protect all game.",
      "Justin Jefferson: Sacks Vikings QB twice | The Vikings managed just 10 points.",
      "Lamar Jackson: Picks off Ravens pass | Jackson beat the Ravens' tight end on the play.",
      "Byron Young: Placed on IR | Young (knee) got hurt in Sunday's win over the Rams. The Rams rallied late but fell short.",
      "Marcus Harris: Placed on IR | Harris (knee) was hurt in Sunday's loss to the Titans. Tennessee won 21-14.",
      "Chris Jones: Picks off Chiefs pass | Kansas City still won.",
    ])
      expect(m.matchItem(title), title).toEqual(NONE);
  });

  it("and the star keeps his own clear-cue item (was no ref)", () => {
    for (const title of [
      "Justin Jefferson: Catches TD | Jefferson caught seven passes in a win over the Browns. The Browns fell to 2-6.",
      "Justin Jefferson: Catches TD in win over the Cleveland Browns",
    ])
      expect(refs(title), title).toEqual([[WR_JEFFERSON, "full_name"]]);
  });
});

describe("V2 (clause 4): a sentence describing someone never decides; one plainly another's is no evidence", () => {
  it("another player's position, read as the subject's, gave the star's item to a namesake or back", () => {
    // each went to the other holder at 52796bf
    for (const [title, wrong] of [
      ["Lamar Jackson: Throws pick-six | The cornerback jumped the route.", CB_LAMAR],
      ["Lamar Jackson throws pick-six: Bengals cornerback returns it 80 yards", CB_LAMAR],
      ["Lamar Jackson outlook: Cornerback injuries leave Bengals thin", CB_LAMAR],
      [
        "Lamar Jackson: Throws three TDs | Jackson torched the secondary. The cornerback was benched.",
        CB_LAMAR,
      ],
      ["Justin Jefferson outlook: Linebacker coverage could open up a big day", LB_JEFFERSON],
      [
        "Justin Jefferson: Shadowed all game | The Browns linebacker held him to two catches.",
        LB_JEFFERSON,
      ],
      [
        "Chris Jones: Two sacks in win | The punter pinned Buffalo deep four times.",
        idAt("Chris Jones", null, 7),
      ],
      [
        "Byron Murphy: Picks off pass | The defensive tackle tipped it at the line.",
        idOf("Byron Murphy II", "SEA"),
      ],
      ["Marcus Harris: Picks off pass | The defensive tackle tipped it at the line.", DT_HARRIS],
      [
        "Justin Jefferson: Forces fumble | Jefferson punched the ball loose in the Browns' win. The receiver was carted off.",
        WR_JEFFERSON,
      ],
      [
        "Justin Jefferson: Fined for hit | Jefferson was fined for a hit in the Browns' loss. The receiver suffered a concussion.",
        WR_JEFFERSON,
      ],
      [
        "Justin Jefferson: Records interception | Jefferson picked off a deep ball in the Browns' win. The wideout he was covering was benched.",
        WR_JEFFERSON,
      ],
      ["Lamar Jackson: Picks off pass | The Ravens QB threw it into double coverage.", QB_LAMAR],
    ] as const) {
      const got = m.match(title).map((r) => r.espn_id);
      expect(got, title).not.toContain(wrong);
      expect(m.matchItem(title).unresolved, title).toBe(1);
    }
    // the Chris Jones namesake who is a cornerback: no ref either
    expect(
      m.matchItem("Chris Jones: Strip-sack in win | The cornerback scooped up the fumble."),
    ).toEqual(NONE);
  });

  it("a pronoun gives the position to another player: no evidence, the item a residual (was the namesake)", () => {
    for (const title of [
      "Justin Jefferson: Goes over 100 yards | The defender assigned to him left with a hamstring injury.",
      "Justin Jefferson: Catches two touchdowns | The linebacker covering him was benched.",
      "Justin Jefferson: Catches TD | The linebacker covering him slipped.",
      "Justin Jefferson: Catches two TDs | The defender covering him was flagged for interference.",
      // R8-3 clause 6's residual the attack found lost (no ref at 52796bf)
      "Justin Jefferson: Catches two TDs | Jefferson caught seven passes. The quarterback found him twice in the red zone.",
    ])
      expect(refs(title), title).toEqual([[WR_JEFFERSON, "full_name"]]);
    expect(
      refs("Marcus Harris: Breaks up two passes | The defensive tackle covering him slipped."),
    ).toEqual([[CB_HARRIS, "full_name"]]);
    expect(
      m.matchItem(
        "Michael Carter: Rushes for 100 yards | The cornerback chasing him pulled up lame.",
      ),
    ).toEqual(NONE);
    expect(
      m.matchItem(
        "Byron Murphy: Records two sacks | The cornerback across from him was flagged twice.",
      ),
    ).toEqual(NONE);
  });

  it("a team or a position written next to the name is never outweighed by one (no ref at 52796bf)", () => {
    for (const [title, id] of [
      [
        "Ravens' Lamar Jackson: Picked off twice | The cornerback returned one for a touchdown.",
        QB_LAMAR,
      ],
      [
        "Lamar Jackson (Ravens) picked off twice | The cornerback returned one for a touchdown.",
        QB_LAMAR,
      ],
      [
        "Vikings WR Justin Jefferson: Catches TD | The Browns linebacker covering him was flagged.",
        WR_JEFFERSON,
      ],
      [
        "Vikings' Justin Jefferson: Catches TD | The cornerback covering him was benched.",
        WR_JEFFERSON,
      ],
      [
        "Ravens QB Lamar Jackson: Picked off twice | The cornerback returned one for a touchdown.",
        QB_LAMAR,
      ],
      ["Ravens QB Lamar Jackson: Sacked twice | The linebacker got home twice.", QB_LAMAR],
      ["Rams' Byron Young: Two sacks | The quarterback he sacked twice left the game.", DE_YOUNG],
      ["Rams OLB Byron Young: Two sacks | The quarterback went down twice.", DE_YOUNG],
      [
        "Titans' Marcus Harris: Picks off pass | The receiver he covered was held to one catch.",
        CB_HARRIS,
      ],
      ["Chiefs' Chris Jones: Two sacks | The quarterback he sacked left the game.", DT_JONES],
      [
        "Vikings WR Justin Jefferson: Catches two TDs | Jefferson caught seven passes. The quarterback found him twice in the red zone.",
        WR_JEFFERSON,
      ],
    ] as const)
      expect(refs(title), title).toEqual([[id, "full_name_team"]]);
    expect(
      refs(
        "Justin Jefferson: Catches two TDs vs. Browns | The quarterback found him twice in the red zone.",
      ),
    ).toEqual([[WR_JEFFERSON, "full_name"]]);
    expect(refs("Vikings WR Jefferson: Catches TD | The quarterback found him twice.")).toEqual([
      [WR_JEFFERSON, "last_name_team"],
    ]);
  });
});

describe("V3 (clauses 5, 6): the residual names no team, no position and no cue; else no ref, counted", () => {
  it("a team named that rules no holder out leaves two holders: no ref (each was the star at 0.80)", () => {
    for (const title of [
      "Lamar Jackson: Works out for Bengals",
      "Lamar Jackson: Visits Bears",
      "Lamar Jackson: Works out for Ravens",
      "Justin Jefferson: Records sack against Lions",
      "Lamar Jackson: Limited ahead of Bengals game",
      "Justin Jefferson: Busy in loss | Jefferson recorded 12 tackles in Sunday's loss to Minnesota's high-powered offense.",
      "Chris Jones: Pins Chiefs deep three times | Jones averaged 47 yards per punt.",
    ])
      expect(m.matchItem(title), title).toEqual(NONE);
    // the residual itself, as accepted
    expect(refs("Lamar Jackson: Inks reserve/future contract")).toEqual([[QB_LAMAR, "full_name"]]);
  });
});

describe("V4 (clause 3): 'win at', 'loss at' and the strip, the forced fumble, the blocked kick", () => {
  it("each names the other side (each went to the star)", () => {
    for (const title of [
      "Justin Jefferson: Out for season | Jefferson tore his ACL in Sunday's win at Minnesota, the team announced Monday.",
      "Justin Jefferson: Exits with knee injury | Jefferson left Sunday's 24-20 loss at Minnesota in the third quarter and did not return.",
      "Lamar Jackson: Carted off with ankle injury | Jackson was hurt covering a punt in Sunday's loss at Baltimore.",
      "Byron Young: Out for season | Young tore his ACL in Sunday's loss at the Rams.",
      "Marcus Harris: Out for season | Harris tore his ACL in Sunday's win at Tennessee.",
      "Justin Jefferson: Strips Vikings QB in fourth quarter",
      "Justin Jefferson: Forces fumble | Jefferson forced a Vikings fumble in the fourth quarter of Sunday's win.",
      "Justin Jefferson: Blocks Vikings punt",
      "Lamar Jackson: Forces Ravens fumble on special teams",
      "Lamar Jackson: Blocks Ravens punt",
    ])
      expect(m.matchItem(title), title).toEqual(NONE);
    // the star's own: the namesake on the team named is ruled out
    expect(
      refs("Justin Jefferson: Catches TD | Jefferson caught seven passes in a win at Cleveland."),
    ).toEqual([[WR_JEFFERSON, "full_name"]]);
  });
});

describe("V5: the cue words in idioms that name a team's own loss or thing", () => {
  it("each names the namesake's own team, never his opponent: no ref (each went to the star)", () => {
    for (const title of [
      "Justin Jefferson: Lost for season | Jefferson is lost to the Browns for the season with a torn ACL.",
      "Justin Jefferson: Lands on IR | The knee injury is a significant loss to the Browns.",
      "Justin Jefferson: Placed on IR | The knee injury shreds the Browns' linebacker depth.",
      "Justin Jefferson: Out for season | Injuries have gashed the Browns' linebacker corps.",
      "Justin Jefferson: Rookie profile | Jefferson fell to the Browns in the fifth round of the draft.",
      "Justin Jefferson: Beats Browns teammate for starting job",
      "Marcus Harris: Lost for season | Harris is lost to the Chiefs for the year.",
      "Byron Young: Out for year | The pectoral tear is a big loss to the Eagles.",
      "Justin Jefferson: Facing Browns-imposed suspension",
      "Byron Young: Facing Eagles discipline after ejection",
    ])
      expect(m.matchItem(title), title).toEqual(NONE);
  });
});

describe("V6 (clause 4): a position written next to the name, at every mention and in every label form", () => {
  it("the namesake's IR, release and injury items never go to the star (they did)", () => {
    for (const [title, wrong] of [
      [
        "Justin Jefferson: Placed on IR | The 24-year-old linebacker will miss at least four games.",
        WR_JEFFERSON,
      ],
      [
        "Lamar Jackson: Waived with injury designation | The 27-year-old cornerback reverts to injured reserve.",
        QB_LAMAR,
      ],
      [
        "Lamar Jackson: Works out for Bengals | The former Ravens cornerback is seeking a roster spot.",
        QB_LAMAR,
      ],
      [
        "Marcus Harris: Out for season | The 25-year-old defensive tackle suffered a torn pectoral.",
        CB_HARRIS,
      ],
    ] as const) {
      expect(
        m.match(title).map((r) => r.espn_id),
        title,
      ).not.toContain(wrong);
      expect(m.matchItem(title).unresolved, title).toBe(1);
    }
    // written next to a mention of him — the surname alone, an appositive, a tag, after the name
    expect(
      refs(
        "Justin Jefferson: Placed on IR | Jefferson, a second-year linebacker, will miss at least four games.",
      ),
    ).toEqual([[LB_JEFFERSON, "full_name"]]);
    expect(
      refs("Lamar Jackson, the Ravens' newest cornerback, impresses in first practice"),
    ).toEqual([[CB_LAMAR, "full_name"]]);
    expect(refs("Corner Lamar Jackson visits Bengals")).toEqual([[CB_LAMAR, "full_name"]]);
    expect(refs("Free-agent corner Lamar Jackson works out for Bengals")).toEqual([
      [CB_LAMAR, "full_name"],
    ]);
    expect(refs("Justin Jefferson (CLE - LB): Records 10 tackles")).toEqual([
      [LB_JEFFERSON, "full_name_team"],
    ]);
    expect(refs("Justin Jefferson LB: Records sack")).toEqual([[LB_JEFFERSON, "full_name"]]);
  });

  it("the star's own labels keep his items (no ref at 52796bf)", () => {
    expect(
      refs(
        "Justin Jefferson: Questionable for Browns game | Jefferson, the Vikings' top receiver, was limited Wednesday.",
      ),
    ).toEqual([[WR_JEFFERSON, "full_name_team"]]);
    for (const [title, id] of [
      ["Rams edge rusher Byron Young: Two sacks", DE_YOUNG],
      ["Rams outside linebacker Byron Young: Two sacks", DE_YOUNG],
      ["Chiefs defensive lineman Chris Jones: Two sacks", DT_JONES],
      ["Vikings slot receiver Justin Jefferson: Questionable", WR_JEFFERSON],
      ["Ravens signal-caller Lamar Jackson: Questionable", QB_LAMAR],
      ["Justin Jefferson (WR, Vikings) questionable", WR_JEFFERSON],
      ["Justin Jefferson, the Vikings' star receiver, is questionable", WR_JEFFERSON],
    ] as const)
      expect(refs(title), title).toEqual([[id, "full_name_team"]]);
  });
});

describe("V7 (clause 4: the same rule on both paths): the surname path reads the cues about it", () => {
  it("each surname title is the namesake's at 0.60, as its full-name twin is his at 0.95 (was no ref)", () => {
    for (const [surname, full, id] of [
      [
        "Cleveland's Jefferson: Sacks Vikings QB twice",
        "Cleveland's Justin Jefferson: Sacks Vikings QB twice",
        LB_JEFFERSON,
      ],
      [
        "Browns' Jefferson: Records sack vs. Vikings",
        "Browns' Justin Jefferson: Records sack vs. Vikings",
        LB_JEFFERSON,
      ],
      [
        "Browns' Jefferson: Records sack in loss to Vikings",
        "Browns' Justin Jefferson: Records sack in loss to Vikings",
        LB_JEFFERSON,
      ],
      [
        "Browns' Jefferson: Records sack in win over Vikings",
        "Browns' Justin Jefferson: Records sack in win over Vikings",
        LB_JEFFERSON,
      ],
      [
        "Jefferson, Browns: Records sack vs. Vikings",
        "Justin Jefferson, Browns: Records sack vs. Vikings",
        LB_JEFFERSON,
      ],
      [
        "Jefferson (Browns) records sack vs. Vikings",
        "Justin Jefferson (Browns) records sack vs. Vikings",
        LB_JEFFERSON,
      ],
      ["Eagles' Young: Sacks Rams QB", "Eagles' Byron Young: Sacks Rams QB", DT_YOUNG],
    ] as const) {
      expect(refs(surname), surname).toEqual([[id, "last_name_team"]]);
      expect(refs(full), full).toEqual([[id, "full_name_team"]]);
    }
    // without the cue, the prominent sharer still blocks on both paths (choice 6)
    for (const title of [
      "Cleveland's Jefferson: Records sack",
      "Cleveland's Justin Jefferson: Records sack",
    ])
      expect(m.matchItem(title), title).toEqual(NONE);
  });
});

describe("V8 (clause 3): a cue before a team's full name ('the Los Angeles Rams')", () => {
  it("is read before its first word (was the Rams DE)", () => {
    expect(m.matchItem("Byron Young: Two sacks against the Los Angeles Rams")).toEqual(NONE);
    expect(m.matchItem("Byron Young: Two sacks against the Rams")).toEqual(NONE);
    expect(refs("Byron Young: Two sacks against the Philadelphia Eagles")).toEqual([
      [DE_YOUNG, "full_name"],
    ]);
  });
});

describe("V9 (clause 4): a pass rusher may be an interior lineman (ESPN's DT Chris Jones)", () => {
  it("'pass rusher' rules out no one of the front (no ref at 52796bf)", () => {
    expect(refs("Chiefs pass rusher Chris Jones: Two sacks")).toEqual([
      [DT_JONES, "full_name_team"],
    ]);
    expect(refs("Pass rusher Chris Jones: Questionable")).toEqual([[DT_JONES, "full_name"]]);
    expect(refs("Chiefs pass rusher Jones: Two sacks")).toEqual([[DT_JONES, "last_name_team"]]);
    expect(refs("Chiefs DT Chris Jones: Two sacks")).toEqual([[DT_JONES, "full_name_team"]]);
  });
});

describe("V10 (clause 5): a shared surname left to no one is counted, even beside another ref", () => {
  it("matchItem counts it (was 0)", () => {
    for (const title of [
      "Jefferson: Questionable for Vikings | Jordan Addison was limited too.",
      "Blake Cashman: Records 12 tackles in Vikings win | Jefferson caught two touchdowns.",
      "Kyler Murray: Throws three TDs to Jefferson | The Vikings beat the Bears.",
      "Jordan Addison: Steps up | Addison and Jefferson combined for 200 yards for the Vikings.",
    ]) {
      const got = m.matchItem(title);
      expect(got.unresolved, title).toBe(1);
      expect(
        got.refs.map((r) => r.espn_id),
        title,
      ).not.toContain(WR_JEFFERSON);
    }
    // a surname alone, with no team in the item, is no mention that evidence could resolve
    expect(m.matchItem("Jackson: Limited").unresolved).toBe(0);
  });

  it("the news build counts each such item, the one with another ref included", () => {
    const xml = rss([
      {
        title: "Jefferson: Questionable for Vikings",
        description: "Jordan Addison was limited too.",
        guid: "a",
      },
      {
        title: "Henry: Limited for Ravens",
        description: "Zay Flowers was limited too.",
        guid: "b",
      },
      {
        title: "Kyler Murray: Throws three TDs to Jefferson",
        description: "The Vikings beat the Bears.",
        guid: "c",
      },
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
    expect(b.counts).toMatchObject({ unmatched: 0, unresolved: 3 });
    expect(b.warnings).toContain(
      "3 item(s) name a player several universe players share, and the evidence picks none of them: no ref for that name",
    );
  });
});

describe("V11 (clause 3): a cue is about the person it is written about, whoever the item's subject is", () => {
  it("a shared name later in the item reads its own sentence's cue (was the star at 0.80)", () => {
    const got = m.matchItem(
      "Denzel Ward: Picks off pass | Justin Jefferson added a sack in the win over the Vikings.",
    );
    expect(got.refs.map((r) => [r.espn_id, r.match_method])).toEqual([
      [idOf("Denzel Ward", "CLE"), "full_name"],
    ]);
    expect(got.unresolved).toBe(1);
    for (const title of [
      "Matthew Stafford: Sacked three times | Byron Young got to the Rams quarterback twice.",
      "Cam Ward: Sacked four times | Marcus Harris dropped the Titans quarterback twice.",
    ]) {
      const r = m.match(title).map((x) => x.espn_id);
      expect(r, title).not.toContain(DE_YOUNG);
      expect(r, title).not.toContain(CB_HARRIS);
    }
  });
});

describe("V12 (clause 2): a roster move ties a team only where it is one", () => {
  it("a workout or a radar is no move: never 0.95 (both were 0.95)", () => {
    for (const title of [
      "Lamar Jackson: Joins Ravens for workout",
      "Justin Jefferson: Lands on Vikings' radar",
    ])
      expect(m.matchItem(title), title).toEqual(NONE);
    expect(refs("Lamar Jackson: Signs with Ravens")).toEqual([[QB_LAMAR, "full_name_team"]]);
    expect(refs("Lamar Jackson: Lands on Bengals practice squad")).toEqual([]);
  });
});

describe("V13 (clauses 2, 3): a team written as an abbreviation", () => {
  it("attached in a tag, or after a cue word (each went to the star)", () => {
    expect(refs("Justin Jefferson, CLE: Placed on IR")).toEqual([]);
    for (const title of [
      "Justin Jefferson, CLE: Placed on IR",
      "Byron Young (PHI) placed on IR",
      "Marcus Harris (KC) placed on IR",
      "Justin Jefferson: Sacks MIN QB twice",
      "Justin Jefferson: Records 8 tackles vs. MIN",
      "Justin Jefferson: Records 12 tackles @ MIN",
      "Lamar Jackson: Picks off pass vs. BAL",
    ])
      expect(m.matchItem(title), title).toEqual(NONE);
    expect(refs("Justin Jefferson (hamstring) questionable for Sunday vs. CLE")).toEqual([
      [WR_JEFFERSON, "full_name"],
    ]);
    expect(refs("Byron Young (LAR) questionable")).toEqual([[DE_YOUNG, "full_name_team"]]);
  });
});

describe("V14: an all-caps headline", () => {
  it("names its teams and cues in capitals too (was the star)", () => {
    expect(m.matchItem("JUSTIN JEFFERSON: SACKS VIKINGS QB TWICE")).toEqual(NONE);
    expect(
      m.matchItem(
        "JUSTIN JEFFERSON: OUT FOR SEASON | JEFFERSON TORE HIS ACL IN SUNDAY'S WIN OVER THE VIKINGS.",
      ),
    ).toEqual(NONE);
    expect(refs("JUSTIN JEFFERSON: CATCHES TD IN WIN OVER BROWNS")).toEqual([
      [WR_JEFFERSON, "full_name"],
    ]);
  });
});

describe("V15 (clause 3: a closed, tested list): every game word names a game between two teams", () => {
  it("entry by entry: the star's team's game leaves him, a namesake elsewhere ruled out", () => {
    for (const cue of GAME_CUES) {
      const title = `Justin Jefferson: Big day | Jefferson caught two passes as the Vikings ${cue} the Bengals.`;
      expect(refs(title), title).toEqual([[WR_JEFFERSON, "full_name"]]);
      const other = `Justin Jefferson: Big day | Jefferson caught two passes as the Lions ${cue} the Bengals.`;
      expect(m.matchItem(other), other).toEqual(NONE);
    }
  });
});

describe("the fixer's own round-2 attacks: never the wrong holder", () => {
  it("a cue written about no one, a team as its actor, an idiom", () => {
    for (const title of [
      "Justin Jefferson: Out for season | Jefferson tore his ACL in practice, a big loss to the Browns.",
      "Justin Jefferson: Out | Jefferson, lost to the Browns in free agency, tore his ACL.",
      "Justin Jefferson: Out for season | Jefferson was lost to the Browns.",
      "Justin Jefferson: Out for season | Jefferson lost to the Browns for the season with a torn ACL.",
      "Justin Jefferson: Rookie profile | Jefferson fell to the Browns.",
      "Justin Jefferson: Rookie profile | Jefferson slid past the Browns to the fifth round of the draft.",
      "Justin Jefferson: Rookie profile | Jefferson fell to the Browns at No. 150 overall.",
      "Justin Jefferson: Fined | Jefferson torched the Browns on social media after his release.",
      "Justin Jefferson: Files grievance against Browns",
      "Justin Jefferson: Files grievance against the Browns' front office",
      "Justin Jefferson: Out for season | Jefferson tore his ACL, and injuries have gashed the Browns' secondary.",
      "Justin Jefferson: Busy day | Jefferson made 12 tackles as Minnesota's offense torched the Browns' secondary.",
      "Justin Jefferson: Out for season | Jefferson's injury shreds the Browns' secondary.",
      "Justin Jefferson: Out | Losing Jefferson is a big loss to the Browns.",
      "Justin Jefferson: Lands on IR | It is a significant loss to the Browns.",
      "Justin Jefferson: Out for season | Jefferson tore his ACL in Sunday's win over the Vikes.",
      "Justin Jefferson: Out | The linebacker's knee gave out on him Sunday.",
      "Justin Jefferson: Out for season | Linebackers coach Jim Leonhard said the injury is serious.",
      "Byron Young: Out for season | Young tore his pectoral, a blow to the Eagles.",
      // a team named between him and a result cue is its subject, not his opponent's
      "Justin Jefferson: Out for season | Jefferson tore his ACL as Minnesota's offense rolled to a win over the Browns.",
    ])
      expect(m.matchItem(title), title).toEqual(NONE);
    // the star's own items in the same forms
    for (const title of [
      "Justin Jefferson: Catches two TDs | Jefferson caught seven passes for 110 yards, including two touchdowns, in a 27-20 win over the Browns.",
      "Justin Jefferson: Catches TD | Jefferson torched the Browns' secondary for 150 yards.",
      "Justin Jefferson: Torches Browns for 150 yards",
    ])
      expect(refs(title), title).toEqual([[WR_JEFFERSON, "full_name"]]);
  });

  it("a describing sentence about him keeps a holder left by elimination from taking it", () => {
    // the cue may be misread ("against the Browns' starters" in practice is his own team): the LB's
    // season-ending item, which the WR left by elimination would take
    expect(
      m.matchItem(
        "Justin Jefferson: Out for season | Jefferson tore his ACL in practice against the Browns' starters. The linebacker will miss the season.",
      ),
    ).toEqual(NONE);
    // with no such sentence the elimination stands
    expect(
      refs(
        "Justin Jefferson: Catches TD | Jefferson caught two passes against the Browns' starters.",
      ),
    ).toEqual([[WR_JEFFERSON, "full_name"]]);
  });

  it("a cued team named between the name and a cue is no actor ('vs. Bills, vs. Dolphins')", () => {
    const twins = buildPlayerMatcher([
      { espn_id: 9_100_001, full_name: "Sam Twin", team: "BUF", gsis_id: null, percent_owned: 40 },
      { espn_id: 9_100_002, full_name: "Sam Twin", team: "MIA", gsis_id: null, percent_owned: 40 },
    ]);
    expect(twins.match("Sam Twin: Out vs. Bills, vs. Dolphins")).toEqual([]);
    expect(twins.match("Sam Twin, Dolphins: Out vs. Bills").map((r) => r.espn_id)).toEqual([
      9_100_002,
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------
// Properties over the recorded universe's shared full names.

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
const owned = (p: NewsUniversePlayer): number => p.percent_owned ?? 0;
function prominentOf(hs: readonly NewsUniversePlayer[]): NewsUniversePlayer | null {
  const [top, ...rest] = [...hs].sort((a, b) => owned(b) - owned(a));
  return top !== undefined && owned(top) >= 1 && rest.every((p) => owned(top) >= 10 * owned(p))
    ? top
    : null;
}
/** The shared names with a prominent holder and a namesake on a team (the three choice 5 acts on). */
const PAIRS = SHARED.flatMap((hs) => {
  const star = prominentOf(hs);
  const starTeam = star?.team ?? null;
  if (star === null || starTeam === null) return [];
  return hs.flatMap((namesake) =>
    namesake === star || namesake.team === null || namesake.team === starTeam
      ? []
      : [
          {
            name: star.full_name.replace(/\s+(?:Jr\.?|Sr\.?|II|III|IV|V)$/u, ""),
            star,
            starTeam,
            namesake,
            namesakeTeam: namesake.team,
          },
        ],
  );
});
const NEUTRAL = [
  "Limited at practice",
  "Placed on IR",
  "Out for the week",
  "Questionable",
] as const;
const LOOSE = [
  (t: string) => `The ${t} were thin all day.`,
  (t: string) => `${t} fans booed late.`,
  (t: string) => `The ${t} rallied but fell short.`,
] as const;

describe("properties (fix round 2)", () => {
  it("the recorded universe holds three such pairs (the Browns LB, the Eagles DT, the Chiefs DT)", () => {
    expect(PAIRS.map((p) => [p.name, p.namesake.team]).sort()).toEqual([
      ["Byron Young", "PHI"],
      ["Justin Jefferson", "CLE"],
      ["Marcus Harris", "KC"],
    ]);
  });

  it("property: a cue about him rules the cued team's holder out, whatever loose mentions follow (V1)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PAIRS),
        fc.constantFrom(...NEUTRAL),
        fc.constantFrom(...RESULT_CUES.filter((c) => c !== "past")),
        fc.constantFrom(...LOOSE),
        fc.boolean(),
        ({ name, star, starTeam, namesake, namesakeTeam }, headline, cue, loose, starsTeam) => {
          const surname = name.split(" ").at(-1) ?? "";
          const cued = starsTeam ? starTeam : namesakeTeam;
          const nick = NICK.get(cued) ?? "";
          const text = `${name}: ${headline} | ${surname} was hurt in Sunday's ${cue} the ${nick}. ${loose(nick)}`;
          const got = m.match(text).map((r) => r.espn_id);
          // the cued team's holder is never the subject; the star never takes his namesake's item
          expect(got, text).not.toContain(starsTeam ? star.espn_id : namesake.espn_id);
          if (starsTeam) expect(m.matchItem(text).unresolved, text).toBe(1);
          else expect(got, text).toContain(star.espn_id);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("property: a describing sentence alone never picks a holder of a shared name (V2)", () => {
    const words = Object.keys(POSITION_WORDS).filter(
      (w) => !["safety", "edge", "kicker", "corner"].includes(w) && w.length > 3,
    );
    fc.assert(
      fc.property(
        fc.constantFrom(...SHARED),
        fc.constantFrom(...NEUTRAL),
        fc.constantFrom(...words),
        fc.constantFrom(
          "did not practice Wednesday.",
          "will miss at least four games.",
          "was benched.",
        ),
        (hs, headline, word, rest) => {
          const first = hs[0];
          if (first === undefined) return;
          const name = first.full_name.replace(/\s+(?:Jr\.?|Sr\.?|II|III|IV|V)$/u, "");
          const text = `${name}: ${headline} | The ${word} ${rest}`;
          const got = m.matchItem(text);
          expect(
            got.refs.filter((r) => hs.some((p) => p.espn_id === r.espn_id)),
            text,
          ).toEqual([]);
          expect(got.unresolved, text).toBe(1);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("property: a team named loosely, and no other evidence, gives no ref and counts it (V3)", () => {
    const teams = [...NICK.values()];
    fc.assert(
      fc.property(
        fc.constantFrom(...SHARED),
        fc.constantFrom(...NEUTRAL),
        fc.constantFrom(...teams),
        fc.constantFrom(...LOOSE),
        (hs, headline, team, loose) => {
          const first = hs[0];
          if (first === undefined) return;
          const name = first.full_name.replace(/\s+(?:Jr\.?|Sr\.?|II|III|IV|V)$/u, "");
          const text = `${name}: ${headline} | ${loose(team)}`;
          const got = m.matchItem(text);
          expect(
            got.refs.filter((r) => hs.some((p) => p.espn_id === r.espn_id)),
            text,
          ).toEqual([]);
          expect(got.unresolved, text).toBe(1);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("property: the two paths agree — a surname never goes to another sharer than its full name (V7)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PAIRS),
        fc.constantFrom("vs.", "against the", "in a loss to the", "in a win over the"),
        fc.boolean(),
        ({ name, star, starTeam, namesake, namesakeTeam }, cue, ofStar) => {
          const surname = name.split(" ").at(-1) ?? "";
          const own = NICK.get(ofStar ? starTeam : namesakeTeam) ?? "";
          const other = NICK.get(ofStar ? namesakeTeam : starTeam) ?? "";
          const full = m
            .match(`${own}' ${name}: Records sack ${cue} ${other}`)
            .map((r) => r.espn_id);
          const bare = m
            .match(`${own}' ${surname}: Records sack ${cue} ${other}`)
            .map((r) => r.espn_id);
          const holder = ofStar ? star.espn_id : namesake.espn_id;
          expect(full).toEqual([holder]);
          expect(bare.every((id) => id === holder)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});
