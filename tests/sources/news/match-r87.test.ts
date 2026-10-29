// match-r87.test.ts — ruling R8-7 (docs/plan/changelog.md §R8): what ruling R8-6's scan and labels
// cover for a name several universe players hold (src/sources/news/labels.ts, positions.ts, match.ts).
// (1) the scan's lists are complete for each of the 32 teams in every category the ruling names; (2) an
// abbreviation that is an ordinary word counts in capitals outside an all-capitals segment, and in any
// case right after a game or move word; (3) one set of forms: every form the scan reads is a label form
// where a label stands; (4) a surname of a full name in the item is that name's mention, and a bare
// shared surname reads its labels in every form and is counted when none picks it, beside other refs
// too; (5) a written suffix narrows the holders a label can fit and never makes the spelled holder the
// residual's taker. Each of the 11 violations the attack on 66bb2a2 left open has a test here, with the
// variants it named, and each clause has tests that fail at 66bb2a2 on refs or counts: only exports
// 66bb2a2 already had are read. No network.
import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { NflTeam } from "../../../src/config/schema.js";
import { NFL_TEAMS } from "../../../src/config/schema.js";
import { playersRows } from "../../../src/sources/espn_season/index.js";
import {
  buildNewsRows,
  buildPlayerMatcher,
  NEWS_FILE_FORMAT,
  universeFromEspnPlayers,
  type NewsPlayerRef,
  type NewsUniversePlayer,
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
/** The holders of each shared full name, by any of their ids. */
const holdersOf = (id: number): Set<number> => {
  const key = (byId.get(id)?.full_name ?? "").replace(/\s+(?:Jr\.|II)$/u, "");
  return new Set(
    universe
      .filter((p) => p.full_name.replace(/\s+(?:Jr\.|II)$/u, "") === key)
      .map((p) => p.espn_id),
  );
};
const JEFFERSONS = holdersOf(
  universe.find((p) => p.full_name === "Justin Jefferson")?.espn_id ?? 0,
);
/**
 * The residual item of the star WR with `form` written in its blurb: "∅ u1" when the residual went
 * (no Justin Jefferson takes it, and it is counted: a form may be a shared surname too, "Brown"),
 * else the outcome.
 */
const scanned = (form: string): string => {
  const r = m.matchItem(`Justin Jefferson: Questionable | Notes: ${form}, as of Wednesday.`);
  return r.refs.every((x) => !JEFFERSONS.has(x.espn_id)) && r.unresolved >= 1
    ? "∅ u1"
    : `${show(r.refs)} u${String(r.unresolved)}`;
};
const RESIDUAL = "Justin Jefferson/MIN/WR:full_name u0";
/** Whether no holder of the named shared name takes the item, and it is counted. */
const failsClosed = (text: string, name: string): boolean => {
  const ids = holdersOf(universe.find((p) => p.full_name === name)?.espn_id ?? 0);
  const r = m.matchItem(text);
  return r.refs.every((x) => !ids.has(x.espn_id)) && r.unresolved >= 1;
};

// -----------------------------------------------------------------------------------------------
describe("R8-7 (1): the scan's lists are complete for every team, in every category", () => {
  // each team's forms as writers write them, one category per column: the nickname plural and
  // singular; the city or state and a short name or nickname of it; the abbreviations; a dotted
  // abbreviation; the home state's postal and AP abbreviations (AP spells Ohio and Texas out, and an
  // AP abbreviation that is an ordinary word, "Wash.", counts in capitals: R8-7 (2)); the current
  // stadium by its names since 2015; the training facility, its town and the camp town; the official
  // hashtag; the fans' names and nicknames
  // prettier-ignore
  const TEAMS: Readonly<Record<NflTeam, readonly (readonly string[])[]>> = {
    ARI: [["Cardinals", "Cardinal"], ["Arizona", "Phoenix", "Zona", "Cards"], ["ARI", "ARZ", "CRD", "PHX"], ["A.R.I."], ["AZ", "Ariz."], ["State Farm Stadium", "University of Phoenix Stadium"], ["Dignity Health Arizona Cardinals Training Center", "Tempe", "Glendale"], ["#BirdCityFootball", "#BeRedSeeRed"], ["Big Red", "Red Sea", "the Birds"]],
    ATL: [["Falcons", "Falcon"], ["Atlanta", "A-Town", "Hotlanta"], ["ATL"], ["A.T.L."], ["GA", "Ga."], ["Mercedes-Benz Stadium", "Georgia Dome"], ["IBM Performance Field", "Flowery Branch"], ["#RiseUp", "#InBrotherhood"], ["Dirty Birds", "Dirty Bird"]],
    BAL: [["Ravens", "Raven"], ["Baltimore", "Charm City", "B'more"], ["BAL", "BLT", "RAV"], ["B.A.L."], ["MD", "Md."], ["M&T Bank Stadium"], ["Under Armour Performance Center", "Owings Mills"], ["#RavensFlock"], ["the Birds"]],
    BUF: [["Bills", "Bill"], ["Buffalo", "Queen City", "Nickel City", "WNY"], ["BUF"], ["B.U.F."], ["NY", "N.Y."], ["Highmark Stadium", "New Era Field", "Ralph Wilson Stadium"], ["ADPRO Sports Training Center", "Orchard Park", "Pittsford", "St. John Fisher"], ["#BillsMafia"], ["Bills Mafia"]],
    CAR: [["Panthers", "Panther"], ["Carolina", "Charlotte", "the Carolinas"], ["CAR"], ["C.A.R."], ["NC", "N.C."], ["Bank of America Stadium"], ["Charlotte", "Spartanburg", "Wofford"], ["#KeepPounding"], ["Roaring Riot", "the Cats"]],
    CHI: [["Bears", "Bear"], ["Chicago", "Windy City", "Chi-Town", "Second City", "Chicagoland"], ["CHI"], ["C.H.I."], ["IL", "ILL."], ["Soldier Field"], ["Halas Hall", "Lake Forest", "Bourbonnais", "Olivet Nazarene"], ["#BearDown", "#DaBears"], ["Da Bears", "Monsters of the Midway"]],
    CIN: [["Bengals", "Bengal"], ["Cincinnati", "Cincy", "the Nati", "Queen City"], ["CIN"], ["C.I.N."], ["OH"], ["Paycor Stadium", "Paul Brown Stadium", "the Jungle"], ["Cincinnati"], ["#WhoDey"], ["Who Dey", "Bungles"]],
    CLE: [["Browns", "Brown"], ["Cleveland", "the Land", "C-Town", "Believeland"], ["CLE", "CLV"], ["C.L.E."], ["OH"], ["Huntington Bank Field", "FirstEnergy Stadium", "Cleveland Browns Stadium"], ["CrossCountry Mortgage Campus", "Berea"], ["#DawgPound"], ["Dawg Pound", "the Dawgs", "Factory of Sadness", "Brownies"]],
    DAL: [["Cowboys", "Cowboy"], ["Dallas", "Big D", "the Metroplex", "DFW"], ["DAL"], ["D.A.L."], ["TX"], ["AT&T Stadium", "Jerry World"], ["The Star", "Ford Center", "Frisco", "Arlington", "Oxnard", "River Ridge"], ["#DallasCowboys"], ["America's Team", "'Boys", "Dem Boyz"]],
    DEN: [["Broncos", "Bronco"], ["Denver", "Mile High City"], ["DEN"], ["D.E.N."], ["CO", "Colo."], ["Empower Field at Mile High", "Sports Authority Field", "Broncos Stadium at Mile High"], ["UCHealth Training Center", "Dove Valley", "Englewood"], ["#BroncosCountry"], ["Orange Crush", "Donkeys"]],
    DET: [["Lions", "Lion"], ["Detroit", "Motor City", "Motown"], ["DET"], ["D.E.T."], ["MI", "Mich."], ["Ford Field"], ["Allen Park"], ["#OnePride"], ["One Pride"]],
    GB: [["Packers", "Packer"], ["Green Bay", "Titletown", "Pack"], ["GB", "GNB", "GBP"], ["G.B."], ["WI", "Wis."], ["Lambeau Field"], ["Don Hutson Center", "Ray Nitschke Field", "Green Bay"], ["#GoPackGo"], ["Cheeseheads", "Cheesehead"]],
    HOU: [["Texans", "Texan"], ["Houston", "H-Town", "Space City", "Bayou City"], ["HOU", "HST", "HTX"], ["H.O.U."], ["TX"], ["NRG Stadium"], ["Houston Methodist Training Center", "Houston", "The Greenbrier", "White Sulphur Springs"], ["#WeAreTexans"], ["Bulls on Parade"]],
    IND: [["Colts", "Colt"], ["Indianapolis", "Indy", "Naptown", "Circle City"], ["IND", "CLT"], ["I.N.D."], ["IN", "Ind."], ["Lucas Oil Stadium"], ["Indiana Farm Bureau Football Center", "Westfield", "Grand Park", "Anderson University"], ["#ForTheShoe"], ["Colts Nation"]],
    JAX: [["Jaguars", "Jaguar", "Jags", "Jag"], ["Jacksonville", "Duval", "River City", "Jax"], ["JAX", "JAC"], ["J.A.X."], ["FL", "Fla."], ["EverBank Stadium", "TIAA Bank Field", "EverBank Field"], ["Miller Electric Center", "Jacksonville"], ["#DUUUVAL"], ["Duuuval", "the Cats"]],
    KC: [["Chiefs", "Chief"], ["Kansas City", "KCMO"], ["KC", "KAN", "KCC"], ["K.C."], ["MO", "MO."], ["GEHA Field at Arrowhead Stadium", "Arrowhead"], ["University of Kansas Health System Training Complex", "St. Joseph", "Missouri Western"], ["#ChiefsKingdom"], ["Chiefs Kingdom"]],
    LA: [["Rams", "Ram"], ["Los Angeles", "SoCal", "City of Angels", "Tinseltown"], ["LA", "LAR", "STL"], ["L.A."], ["CA", "Calif."], ["SoFi Stadium", "Edward Jones Dome"], ["Cal Lutheran", "Thousand Oaks", "Woodland Hills", "Warner Center", "Agoura Hills", "Irvine"], ["#WhoseHouse", "#RamsHouse"], ["Rams House"]],
    LAC: [["Chargers", "Charger", "Bolts", "Bolt"], ["Los Angeles", "SoCal", "San Diego"], ["LAC", "SD", "SDG"], ["L.A.C."], ["CA", "Calif."], ["SoFi Stadium", "Qualcomm Stadium", "StubHub Center", "Dignity Health Sports Park"], ["The Bolt", "El Segundo", "Costa Mesa", "Jack Hammett Sports Complex"], ["#BoltUp"], ["Bolt Up"]],
    LV: [["Raiders", "Raider"], ["Las Vegas", "Vegas", "Sin City", "Oakland"], ["LV", "LVR", "RAI", "OAK"], ["L.V."], ["NV", "Nev."], ["Allegiant Stadium", "the Death Star"], ["Intermountain Health Performance Center", "Henderson", "Napa", "Paradise"], ["#RaiderNation"], ["Raider Nation", "Black Hole", "Silver and Black"]],
    MIA: [["Dolphins", "Dolphin", "Fins", "Phins"], ["Miami", "Magic City", "South Beach", "South Florida"], ["MIA"], ["M.I.A."], ["FL", "Fla."], ["Hard Rock Stadium", "Sun Life Stadium"], ["Baptist Health Training Complex", "Miami Gardens", "Davie", "Nova Southeastern"], ["#FinsUp"], ["the Fish", "Dolfans"]],
    MIN: [["Vikings", "Viking", "Vikes", "Vike"], ["Minnesota", "Minneapolis", "Mpls", "Twin Cities", "St. Paul"], ["MIN"], ["M.I.N."], ["MN", "Minn."], ["U.S. Bank Stadium", "TCF Bank Stadium"], ["TCO Performance Center", "Eagan", "Mankato"], ["#Skol"], ["Skol", "Purple People Eaters"]],
    NE: [["Patriots", "Patriot", "Pats", "Pat"], ["New England", "Boston", "Beantown"], ["NE", "NWE", "NEP", "BOS"], ["N.E."], ["MA", "MASS."], ["Gillette Stadium"], ["Foxborough", "Foxboro"], ["#GoPats", "#ForeverNE"], ["Pats Nation"]],
    NO: [["Saints", "Saint"], ["New Orleans", "NOLA", "Big Easy", "Crescent City"], ["NO", "NOR", "NOS"], ["N.O."], ["LA", "LA."], ["Caesars Superdome", "Mercedes-Benz Superdome"], ["Ochsner Sports Performance Center", "Metairie", "The Greenbrier", "Irvine"], ["#WhoDat"], ["Who Dat", "Black and Gold"]],
    NYG: [["Giants", "Giant", "G-Men", "Big Blue", "Jints"], ["New York", "NYC", "Big Apple", "Gotham", "New Jersey"], ["NYG", "NY"], ["N.Y.G."], ["NJ", "N.J."], ["MetLife Stadium", "the Meadowlands"], ["Quest Diagnostics Training Center", "East Rutherford"], ["#TogetherBlue"], ["Big Blue", "Jints"]],
    NYJ: [["Jets", "Jet", "Gang Green"], ["New York", "NYC", "Big Apple", "Gotham", "New Jersey"], ["NYJ", "NY"], ["N.Y.J."], ["NJ", "N.J."], ["MetLife Stadium", "the Meadowlands"], ["Atlantic Health Jets Training Center", "Florham Park"], ["#TakeFlight"], ["Gang Green", "J-E-T-S"]],
    PHI: [["Eagles", "Eagle"], ["Philadelphia", "Philly", "City of Brotherly Love"], ["PHI"], ["P.H.I."], ["PA", "PA."], ["Lincoln Financial Field", "the Linc"], ["NovaCare Complex", "Philadelphia"], ["#FlyEaglesFly", "#BirdGang"], ["Iggles", "Bird Gang", "the Birds"]],
    PIT: [["Steelers", "Steeler", "Stillers"], ["Pittsburgh", "Steel City", "the Burgh", "Pitt"], ["PIT"], ["P.I.T."], ["PA", "PA."], ["Acrisure Stadium", "Heinz Field"], ["UPMC Rooney Sports Complex", "Latrobe", "Saint Vincent College"], ["#HereWeGo"], ["Steel Curtain", "Terrible Towel", "Yinzers", "Black and Gold"]],
    SF: [["49ers", "49er", "Niners", "Niner"], ["San Francisco", "San Fran", "Bay Area", "Frisco"], ["SF", "SFO"], ["S.F."], ["CA", "Calif."], ["Levi's Stadium"], ["SAP Performance Facility", "Santa Clara"], ["#FTTB"], ["the Faithful", "Niner Faithful"]],
    SEA: [["Seahawks", "Seahawk", "Hawks"], ["Seattle", "Emerald City", "Rain City", "PNW"], ["SEA"], ["S.E.A."], ["WA", "WASH."], ["Lumen Field", "CenturyLink Field"], ["Virginia Mason Athletic Center", "VMAC", "Renton"], ["#GoHawks"], ["12s", "12th Man", "Legion of Boom"]],
    TB: [["Buccaneers", "Buccaneer", "Bucs", "Buc"], ["Tampa Bay", "Tampa", "Cigar City", "St. Pete"], ["TB", "TAM", "TBB"], ["T.B."], ["FL", "Fla."], ["Raymond James Stadium", "the Ray Jay"], ["AdventHealth Training Center", "Tampa"], ["#SiegeTheDay", "#GoBucs"], ["Bucs Nation"]],
    TEN: [["Titans", "Titan", "Oilers"], ["Tennessee", "Nashville", "Music City", "Nashvegas"], ["TEN", "OTI"], ["T.E.N."], ["TN", "Tenn."], ["Nissan Stadium", "LP Field"], ["Ascension Saint Thomas Sports Park", "Nashville"], ["#TitanUp"], ["Titan Up"]],
    WAS: [["Commanders", "Commander", "Commies"], ["Washington", "D.C.", "the DMV", "the District"], ["WAS", "WSH", "WFT", "DC"], ["D.C."], ["MD", "Md.", "VA", "Va."], ["Northwest Stadium", "FedExField", "FedEx Field"], ["OrthoVirginia Training Center at Inova Sports Performance Center", "Ashburn", "Landover", "Richmond", "Bon Secours Training Center"], ["#HTTC", "#RaiseHail"], ["Burgundy and Gold", "Redskins", "Skins", "Football Team"]],
  };

  it("each of the 32 teams, each category: every form takes the star's residual away", () => {
    expect(Object.keys(TEAMS).sort()).toEqual([...NFL_TEAMS].sort());
    expect(scanned("the week ahead")).toBe(RESIDUAL);
    for (const [team, categories] of Object.entries(TEAMS)) {
      expect(categories, team).toHaveLength(9);
      for (const forms of categories)
        for (const f of forms) expect(scanned(f), `${team}: ${f}`).toBe("∅ u1");
    }
  });

  it("violation 6: the towns, facilities and stadiums the attack found missing (each the star's at 0.80 at 66bb2a2)", () => {
    for (const [t, name] of [
      [
        "Lamar Jackson: Signs | HENDERSON, Nev. — Jackson inked a one-year deal Tuesday.",
        "Lamar Jackson",
      ],
      [
        "Justin Jefferson: Carted off at Huntington Bank Field | Jefferson (knee) did not return.",
        "Justin Jefferson",
      ],
      [
        "Justin Jefferson: Notches first career sack | Jefferson got home in the third quarter Sunday at U.S. Bank Stadium.",
        "Justin Jefferson",
      ],
      ["Lamar Jackson: Released after tryout at Halas Hall", "Lamar Jackson"],
      [
        "Byron Young: Carted off at Lincoln Financial Field | Young (knee) did not return.",
        "Byron Young",
      ],
      [
        "Lamar Jackson: Works out at M&T Bank Stadium | Jackson auditioned Tuesday.",
        "Lamar Jackson",
      ],
      [
        "Justin Jefferson: Injured at the Meadowlands | Jefferson (ankle) left in the third quarter.",
        "Justin Jefferson",
      ],
      [
        "Marcus Harris: Hurt at Nissan Stadium | Harris (ankle) left Sunday's game.",
        "Marcus Harris",
      ],
    ] as const)
      expect(failsClosed(t, name), t).toBe(true);
    // every form of the triage's scan.out the scan missed at 66bb2a2
    // prettier-ignore
    for (const f of ["Henderson", "Englewood", "Westfield", "Oxnard", "Pittsford", "St. Joseph", "Mankato",
      "Halas Hall", "NovaCare", "Dove Valley", "U.S. Bank Stadium", "Huntington Bank Field",
      "FirstEnergy Stadium", "M&T Bank Stadium", "Paycor Stadium", "Hard Rock Stadium",
      "Lincoln Financial Field", "the Linc", "AT&T Stadium", "Northwest Stadium", "FedExField", "Ford Field",
      "Lucas Oil Stadium", "NRG Stadium", "EverBank Stadium", "Nissan Stadium", "Levi's Stadium",
      "State Farm Stadium", "Mercedes-Benz Stadium", "Bank of America Stadium", "Raymond James Stadium",
      "GEHA Field", "Empower Field", "the Meadowlands", "New Jersey", "America's Team"])
      expect(scanned(f), f).toBe("∅ u1");
  });

  it("violation 7: the nicknames, fans' names, city names and home-state abbreviations the attack found missing", () => {
    for (const t of [
      "Justin Jefferson: Released by the Jints",
      "Lamar Jackson: Works out for the Fish",
      "Marcus Harris: Claimed by the Cats",
      "Justin Jefferson: Re-signs with the Dawgs",
      "Lamar Jackson: Signs practice-squad deal in NYC",
      "Lamar Jackson: Heads to Chi-Town for tryout",
      "Justin Jefferson: Visits San Fran",
      "Byron Young: Visits Mpls",
      "Lamar Jackson: Works out in Mankato, Minn.",
      "Justin Jefferson: Back in the Factory of Sadness",
    ])
      expect(outcome(t), t).toBe("∅ u1");
    // "Wash." is an ordinary word too ("wash"): R8-7 (2) counts it in capitals or after a game word
    for (const f of ["Minn.", "Tenn.", "Ariz.", "WASH.", "to Wash.", "America's Team"])
      expect(scanned(f), f).toBe("∅ u1");
    expect(scanned("Wash. state")).toBe(RESIDUAL);
  });

  it("violations 9 and 10: the alignment words, and each position form written with a space", () => {
    for (const t of [
      "Justin Jefferson: Takes over at Will | Jefferson replaces the injured starter.",
      "Justin Jefferson: Takes over at Mike | Jefferson replaces the injured starter.",
      "Justin Jefferson: Takes over at Sam | Jefferson replaces the injured starter.",
      "Justin Jefferson: Takes over at weakside | Jefferson replaces the injured starter.",
      "Justin Jefferson: Moves to strongside | Jefferson replaces the injured starter.",
      "Marcus Harris: Waived | The D line reserve was let go Tuesday.",
      "Marcus Harris: Waived | The O line reserve was let go Tuesday.",
      "Chris Jones: Released | The half back was let go Tuesday.",
      "Chris Jones: Released | The full back was let go Tuesday.",
      "Chris Jones: Released | The tail back was let go Tuesday.",
      "Justin Jefferson: Released | The wide out was let go Tuesday.",
    ])
      expect(outcome(t), t).toBe("∅ u1");
    for (const f of [
      "wing back",
      "scat back",
      "off ball",
      "h back",
      "weak side",
      "strong-side",
      "WILLS",
      "at Wills",
    ])
      expect(scanned(f), f).toBe("∅ u1");
    // "Wills" in title case is the name or the verb: R8-7 (2)
    expect(scanned("Wills")).toBe(RESIDUAL);
  });

  it("a form outside the categories leaves the accepted residual (R8-3 clause 6)", () => {
    for (const t of [
      "Lamar Jackson: Works out in Topeka | Jackson auditioned Tuesday.",
      "Justin Jefferson: Questionable | Jefferson (hamstring) was limited Wednesday.",
      "Chris Jones: Signs with the Birmingham Stallions",
    ])
      expect(outcome(t), t).toBe(
        t.startsWith("Lamar")
          ? "Lamar Jackson/BAL/QB:full_name u0"
          : t.startsWith("Chris")
            ? "Chris Jones/KC/DT:full_name u0"
            : RESIDUAL,
      );
  });
});

// -----------------------------------------------------------------------------------------------
describe("R8-7 (2): an abbreviation whose lower case is an ordinary word", () => {
  it("violation 8: in title or lower case right after a game or move word it counts (each 0.80 at 66bb2a2)", () => {
    for (const t of [
      "Chris Jones: Punts six times vs. Sea",
      "Justin Jefferson: Records sack vs. Phi",
      "Justin Jefferson: Records sack vs. phi",
      "Marcus Harris: Released | Harris was let go by Den on Tuesday.",
      "Byron Young: Two sacks vs. Dal",
      "Justin Jefferson: Records sack @ Min",
      "Justin Jefferson: Records sack @Min",
      "Lamar Jackson: Works out for Pit",
      "Byron Young: Traded to Ten",
      "Justin Jefferson: Takes over at Will | Jefferson replaces the injured starter.",
    ])
      expect(outcome(t), t).toBe("∅ u1");
  });

  it("the ruling's own: 'Jackson was limited', 'No timetable', 'He will play' keep the residual", () => {
    expect(outcome("Lamar Jackson: Limited | Jackson was limited Wednesday.")).toBe(
      "Lamar Jackson/BAL/QB:full_name u0",
    );
    expect(outcome("Lamar Jackson: No timetable for return")).toBe(
      "Lamar Jackson/BAL/QB:full_name u0",
    );
    expect(outcome("Lamar Jackson: Questionable | He will play Sunday.")).toBe(
      "Lamar Jackson/BAL/QB:full_name u0",
    );
    // in an all-capitals segment, only right after a game or move word (both found at 66bb2a2)
    expect(outcome("LAMAR JACKSON: NO TIMETABLE FOR RETURN")).toBe(
      "Lamar Jackson/BAL/QB:full_name u0",
    );
    expect(outcome("WILL JUSTIN JEFFERSON PLAY SUNDAY?")).toBe(RESIDUAL);
    expect(outcome("LAMAR JACKSON: TRADED TO NO")).toBe("∅ u1");
  });

  it("each listed abbreviation: caps outside an all-caps segment, any case after each game or move word", () => {
    for (const a of F.ORDINARY_WORD_ABBREVIATIONS) {
      const lower = a.toLowerCase();
      const title = `${a.slice(0, 1)}${a.slice(1).toLowerCase()}`;
      // in its lower case or title case alone it names nothing (found at 66bb2a2 for those it did not
      // list as caps-only: "edge", "lb" …)
      for (const w of [lower, title])
        if (w !== a) expect(scanned(`the ${w} of it`), `${a}: ${w}`).toBe(RESIDUAL);
      // in capitals in a segment of mixed case it counts
      expect(scanned(`the ${a} of it`), a).toBe("∅ u1");
      // in a segment all in capitals it names nothing, but right after a game or move word
      expect(outcome(`JUSTIN JEFFERSON: THE ${a} OF IT`), a).toBe(RESIDUAL);
      expect(outcome(`JUSTIN JEFFERSON: TRADED TO ${a}`), a).toBe("∅ u1");
      for (const g of F.GAME_MOVE_WORDS)
        for (const w of [lower, title, a])
          expect(scanned(g === "@" ? `@ ${w}` : `${g} ${w}`), `${g} ${w}`).toBe("∅ u1");
    }
  });

  it("each game or move word, and no other word before it", () => {
    for (const g of F.GAME_MOVE_WORDS) {
      expect(scanned(`${g} sea`), g).toBe("∅ u1");
      expect(scanned(`${g.toUpperCase()} den`), g).toBe("∅ u1");
    }
    // "v" counts with its period only; other words never ("the sea", "in den")
    for (const t of ["v sea", "the sea", "in den", "into will", "per mike", "sees pit"])
      expect(scanned(t), t).toBe(RESIDUAL);
  });

  it("as a label: in capitals, right after a game or move word too; never in lower or title case", () => {
    expect(outcome("WILL Justin Jefferson: Starts")).toBe("Justin Jefferson/CLE/LB:full_name u0");
    // R8-8 (1), violation 7: in capitals it labels after a game or move word as anywhere (∅ u1 at
    // 08524ff); in lower or title case there it counts for the scan only ("to Will Smith")
    expect(outcome("at WILL Justin Jefferson: Starts")).toBe(
      "Justin Jefferson/CLE/LB:full_name u0",
    );
    expect(outcome("at Will Justin Jefferson: Starts")).toBe("∅ u1");
    expect(outcome("Will Justin Jefferson play Sunday?")).toBe(RESIDUAL);
  });

  it("every other abbreviation counts in any case (each the residual's at 66bb2a2 where caps-only)", () => {
    // "NE" and "LB" are no ordinary words; "lbs" of a weight, "ne" counted too
    for (const w of [
      "ne",
      "Ne",
      "lb",
      "Lb",
      "lbs",
      "cle",
      "olb",
      "nyj",
      "minn",
      "tenn",
      "mn",
      "tx",
    ])
      expect(scanned(`the ${w} of it`), w).toBe("∅ u1");
  });

  it("property: an ordinary-word abbreviation counts exactly where R8-7 (2) says", () => {
    const quiet = ["notes", "the", "week", "ahead", "of", "it", "and", "his"];
    fc.assert(
      fc.property(
        fc.constantFrom(...F.ORDINARY_WORD_ABBREVIATIONS),
        fc.constantFrom("lower", "title", "caps"),
        fc.option(fc.constantFrom(...F.GAME_MOVE_WORDS), { nil: null }),
        fc.boolean(),
        fc.array(fc.constantFrom(...quiet), { minLength: 1, maxLength: 4 }),
        (a, how, game, allCaps, words) => {
          const w =
            how === "caps"
              ? a
              : how === "lower"
                ? a.toLowerCase()
                : `${a.slice(0, 1)}${a.slice(1).toLowerCase()}`;
          const phrase = [...words, ...(game === null ? [] : [game]), w, ...words].join(" ");
          const blurb = allCaps ? phrase.toUpperCase() : phrase;
          const text = `Justin Jefferson: Questionable | ${blurb}.`;
          const counts = game !== null || (!allCaps && w === a);
          expect(outcome(text), text).toBe(counts ? "∅ u1" : RESIDUAL);
        },
      ),
      { numRuns: 2_000 },
    );
  });
});

// -----------------------------------------------------------------------------------------------
describe("R8-7 (3): one set of forms — every form the scan reads labels a name where a label stands", () => {
  it("violation 4: a dotted abbreviation is a label (each no ref or 0.80 at 66bb2a2)", () => {
    for (const [t, want] of [
      ["L.A.'s Byron Young: Two sacks", "Byron Young/LA/DE:full_name_team u0"],
      ["Byron Young (L.A.): Two sacks", "Byron Young/LA/DE:full_name_team u0"],
      ["Byron Young, L.A.: Two sacks", "Byron Young/LA/DE:full_name_team u0"],
      ["K.C.'s Chris Jones: Fined for hit", "Chris Jones/KC/DT:full_name_team u0"],
      ["Chris Jones (K.C.): Fined for hit", "Chris Jones/KC/DT:full_name_team u0"],
      ["L.A. DE Byron Young: Two sacks", "Byron Young/LA/DE:full_name_team u0"],
      ["K.C. DT Chris Jones: Fined for hit", "Chris Jones/KC/DT:full_name_team u0"],
    ] as const)
      expect(outcome(t), t).toBe(want);
  });

  it("a place, a singular, a fans' name, a stadium, a scan-only position: each a label next to the name", () => {
    for (const [t, want] of [
      ["Nashville's Marcus Harris: Questionable", "Marcus Harris/TEN/CB:full_name_team u0"],
      ["Arrowhead's Chris Jones: Two sacks", "Chris Jones/KC/DT:full_name_team u0"],
      [
        "Vikings pass-catcher Justin Jefferson: Questionable",
        "Justin Jefferson/MIN/WR:full_name_team u0",
      ],
      [
        "Vikings receivers Justin Jefferson and Jordan Addison limited",
        "Justin Jefferson/MIN/WR:full_name_team, Jordan Addison/MIN/WR:full_name_team u0",
      ],
      [
        "QBs Lamar Jackson and Joe Burrow: Limited",
        "Lamar Jackson/BAL/QB:full_name, Joe Burrow/CIN/QB:full_name u0",
      ],
      ["returner Lamar Jackson: Signs with Bengals", "Lamar Jackson/FA/CB:full_name u0"],
      ["lb Justin Jefferson: Signs", "Justin Jefferson/CLE/LB:full_name u0"],
      ["WILL Justin Jefferson: Signs", "Justin Jefferson/CLE/LB:full_name u0"],
    ] as const)
      expect(outcome(t), t).toBe(want);
  });

  it("property: any one-team word form, any spelling, with a possessive before a shared name picks its team's holder", () => {
    const twins = buildPlayerMatcher(
      NFL_TEAMS.map((t, i) => ({
        espn_id: 9_600_000 + i,
        full_name: "Sam Twin",
        team: t,
        gsis_id: null,
        percent_owned: 0.5,
        position_id: 3,
      })),
    );
    const one = Object.values(F.TEAM_WORD_LISTS)
      .flatMap((l) => Object.entries(l))
      .map(([k, t]) => [k, F.teamsOf(t)] as const)
      .filter(([, ts]) => ts.length === 1);
    fc.assert(
      fc.property(
        fc.constantFrom(...one),
        fc.nat(),
        fc.boolean(),
        ([form, teams], how, possessive) => {
          const sp = F.spellingsOf(form);
          const w = sp[how % sp.length] ?? form;
          const team: NflTeam | undefined = teams[0];
          const text = `${w}${possessive ? "'s" : ""} Sam Twin: Out`;
          expect(
            twins.match(text).map((r) => r.espn_id),
            text,
          ).toEqual([9_600_000 + NFL_TEAMS.indexOf(team ?? "ARI")]);
        },
      ),
      { numRuns: 2_000 },
    );
  });
});

// -----------------------------------------------------------------------------------------------
describe("R8-7 (4): a surname", () => {
  it("violation 1: a surname of a full name in the item carries that name's label; labels fitting different holders pick none", () => {
    // each gave a wrong holder at 66bb2a2: the subject surname's label was never read
    for (const t of [
      "Chiefs DT Harris: Placed on IR | Harris is no relation to Titans CB Marcus Harris.",
      "Browns release LB Jefferson, not to be confused with Vikings WR Justin Jefferson",
      "Bengals sign CB Jackson | Jackson is not to be confused with Ravens QB Lamar Jackson.",
      "Bills sign P Jones | Jones is not to be confused with Chiefs DT Chris Jones.",
      "Vikings CB Murphy: Questionable | Murphy (hamstring) is no relation to Seahawks DT Byron Murphy.",
      "Titans CB Harris: Ruled out | Harris (ankle) won't play; Chiefs DT Marcus Harris is unrelated.",
      "Ravens QB Jackson: Throws three TDs | Jackson's namesake, CB Lamar Jackson, is a free agent.",
      "Rams DE Young: Two sacks | Young's namesake, Eagles DT Byron Young, was inactive.",
      "Chiefs DT Jones: Two sacks | Jones's namesake, P Chris Jones, remains unsigned.",
    ])
      expect(outcome(t), t).toBe("∅ u1");
    expect(
      outcome(
        "Vikings' Jefferson: Burns namesake for TD | Jefferson beat Browns LB Justin Jefferson deep for a 40-yard score.",
      ),
    ).toMatch(/^∅ u[12]$/u);
    // the recall side: one label, fitting one holder (each no ref at 66bb2a2)
    for (const [t, want] of [
      [
        "Justin Jefferson: Questionable | Vikings WR Jefferson (hamstring) was limited Wednesday.",
        "Justin Jefferson/MIN/WR:full_name_team u0",
      ],
      [
        "Lamar Jackson: Limited | Ravens QB Jackson (ankle) was limited Wednesday.",
        "Lamar Jackson/BAL/QB:full_name_team u0",
      ],
      [
        "Byron Young: Two sacks | Rams DE Young got home twice Sunday.",
        "Byron Young/LA/DE:full_name_team u0",
      ],
      [
        "Vikings WR Jefferson: Questionable | Justin Jefferson (hamstring) was limited Wednesday.",
        "Justin Jefferson/MIN/WR:full_name_team u0",
      ],
      [
        "Justin Jefferson: Records sack | Browns LB Jefferson recorded his first career sack Sunday.",
        "Justin Jefferson/CLE/LB:full_name_team u0",
      ],
      [
        "Lamar Jackson: Signs with Bengals | CB Jackson will join the practice squad.",
        "Lamar Jackson/FA/CB:full_name u0",
      ],
    ] as const)
      expect(outcome(t), t).toBe(want);
  });

  it("a labelled surname two full names of the item end with may be either's: neither takes its label", () => {
    expect(outcome("Chris Jones: Two sacks | Chiefs DT Jones got home twice.")).toBe(
      "Chris Jones/KC/DT:full_name_team u0",
    );
    expect(
      outcome(
        "Chris Jones: Two sacks | Chiefs DT Jones got home twice; Jaylon Jones intercepted a pass.",
      ),
    ).toBe("∅ u2");
    // "P Jones" may be the punter Chris Jones: the DT's own label picks no one beside it (the KC DT at
    // 0.95 were it read as Jaylon Jones's only)
    expect(
      outcome(
        "Chiefs DT Chris Jones: Two sacks | P Jones punted twice; Jaylon Jones intercepted a pass.",
      ),
    ).toBe("∅ u2");
  });

  it("a surname written alone before a labelled mention in its segment may be the other holder; one after refers back", () => {
    expect(
      outcome(
        "Justin Jefferson: Catches TD | Jefferson beat Browns LB Jefferson, his namesake, deep.",
      ),
    ).toBe("∅ u1");
    expect(
      outcome(
        "Justin Jefferson: Questionable | Vikings WR Justin Jefferson (hamstring) was limited; Jefferson is expected to play.",
      ),
    ).toBe("Justin Jefferson/MIN/WR:full_name_team u0");
  });

  it("violation 3: a bare shared surname reads its label in every form (each no ref, uncounted, at 66bb2a2)", () => {
    for (const [t, want] of [
      ["MIN's Jefferson: Questionable", "Justin Jefferson/MIN/WR:last_name_team u0"],
      ["LA's Young: Two sacks", "Byron Young/LA/DE:last_name_team u0"],
      ["TEN's Harris: Placed on IR", "Marcus Harris/TEN/CB:last_name_team u0"],
      ["KC's Jones: Fined for hit", "Chris Jones/KC/DT:last_name_team u0"],
      ["Los Angeles' Young: Two sacks", "Byron Young/LA/DE:last_name_team u0"],
      // a short name's or a city's possessive: a label, though the word alone may be a first name
      ["Pack's Johnson: Questionable", "Kaleb Johnson/GB/RB:last_name_team u0"],
      ["Cincy's Taylor: Questionable", "Ja'Sir Taylor/CIN/CB:last_name_team u0"],
      ["New York's Wilson: Questionable", "Garrett Wilson/NYJ/WR:last_name_team u0"],
      ["Nashville's Harris: Questionable", "Marcus Harris/TEN/CB:last_name_team u0"],
      ["Chiefs Defensive Tackle Jones: Fined for hit", "Chris Jones/KC/DT:last_name_team u0"],
      ["Rams Defensive End Young: Two sacks", "Byron Young/LA/DE:last_name_team u0"],
      ["Ravens Signal Caller Jackson: Limited", "Lamar Jackson/BAL/QB:last_name_team u0"],
      ["Rams DE Young Records Two Sacks", "Byron Young/LA/DE:last_name_team u0"],
      ["Vikings WR Jefferson Questionable For Sunday", "Justin Jefferson/MIN/WR:last_name_team u0"],
      ["Jaguars WR Washington: Questionable", "Parker Washington/JAX/WR:last_name_team u0"],
      ["Steelers TE Washington: Questionable", "Darnell Washington/PIT/TE:last_name_team u0"],
      ["49ers CB Green: Questionable", "Renardo Green/SF/CB:last_name_team u0"],
      ["Cowboys DE Houston: Placed on IR", "James Houston/DAL/DE:last_name_team u0"],
    ] as const)
      expect(outcome(t), t).toBe(want);
    // with another ref beside it, read and counted alike (uncounted at 66bb2a2)
    expect(outcome("MIN's Jefferson: Questionable | Puka Nacua (ankle) is also listed.")).toBe(
      "Puka Nacua/LA/WR:full_name, Justin Jefferson/MIN/WR:last_name_team u0",
    );
    expect(outcome("Bears' Jefferson: Questionable | Puka Nacua (ankle) is also listed.")).toBe(
      "Puka Nacua/LA/WR:full_name u1",
    );
    // a team word followed by its team's own name is the team; a word of a form ("Allen Park", "Gang
    // Green") is no surname
    for (const t of [
      "Washington Commanders: Sign veteran",
      "Lions' Allen Park facility hosts workouts",
      "Jets fans: Gang Green rolls on",
    ])
      expect(outcome(t), t).toBe("∅ u0");
    // R8-8 (1), violations 9-11 (each ∅ u0 at 08524ff): a team word with no label, a surname after
    // a first name ("Bill Johnson": a one-word singular or place without a possessive is no label
    // there) and one before another surname ("Lane Johnson") are counted, no label picking
    for (const [t, want] of [
      ["Washington thin at RB | Commanders sign veteran", "∅ u1"],
      ["Bill Johnson: Signs with team", "∅ u1"],
      ["Charlotte Jones: Cowboys executive speaks", "∅ u1"],
      ["Eagles' Lane Johnson retires from NFL due to personal reasons", "∅ u2"],
    ] as const)
      expect(outcome(t), t).toBe(want);
    expect(
      outcome(
        "Justin Jefferson: Burns Denzel Ward | Jefferson beat Ward for a 60-yard TD in the win over the Browns.",
      ),
    ).toBe("Denzel Ward/CLE/CB:full_name_team u1");
  });

  it("violation 5: an unlabelled shared surname is counted, beside other refs too (u0 at 66bb2a2)", () => {
    for (const [t, want] of [
      [
        "Jordan Addison: Two TDs | Addison and Jefferson combined for 200 yards.",
        "Jordan Addison/MIN/WR:full_name u1",
      ],
      [
        "Ja'Marr Chase: Catches TD | Chase beat Jefferson in coverage.",
        "Ja'Marr Chase/CIN/WR:full_name u1",
      ],
      [
        "Kyler Murray: Throws two TDs | Murray found Jefferson twice.",
        "Kyler Murray/MIN/QB:full_name u1",
      ],
      ["Jefferson: Catches TD", "∅ u1"],
      ["Jackson: Limited at practice", "∅ u1"],
    ] as const)
      expect(outcome(t), t).toBe(want);
    // and through the news build
    const b = buildNewsRows({
      format: NEWS_FILE_FORMAT,
      source: "rotowire",
      fetched_ms: NEWS_NOW_MS,
      xml: rss([
        {
          title: "Jordan Addison: Two TDs | Addison and Jefferson combined for 200 yards.",
          guid: "a",
        },
        { title: "Ja'Marr Chase: Catches TD | Chase beat Jefferson in coverage.", guid: "b" },
        { title: "MIN's Jefferson: Questionable", guid: "c" },
      ]),
      universe,
      previous: [],
      warnings: [],
    });
    expect(b.counts).toMatchObject({ unmatched: 0, unresolved: 2 });
  });

  it("property: a team's possessive before a shared surname picks the one sharer on it, or none (counted)", () => {
    const bySurname = new Map<string, NewsUniversePlayer[]>();
    for (const p of universe) {
      const s =
        p.full_name
          .split(/\s+/u)
          .filter((w) => !/^(?:Jr\.?|Sr\.?|II|III|IV|V)$/u.test(w))
          .at(-1) ?? "";
      if (/^[A-Z][a-z]+$/u.test(s)) bySurname.set(s, [...(bySurname.get(s) ?? []), p]);
    }
    const shared = [...bySurname.entries()].filter(
      ([s, ps]) => ps.length > 1 && !(s.toLowerCase() in TEAM_WORD_SET),
    );
    fc.assert(
      fc.property(
        fc.constantFrom(...shared),
        fc.constantFrom(...Object.entries(F.TEAM_NICKNAMES)),
        ([surname, sharers], [nick, team]) => {
          const text = `${nick}' ${surname}: Questionable`;
          const got = m.matchItem(text);
          const on = sharers.filter((p) => p.team === team);
          const ids = got.refs.map((r) => r.espn_id);
          // never a sharer on another team; one on it at most, else counted
          for (const id of ids) {
            const p = byId.get(id);
            if (p !== undefined && sharers.includes(p)) expect(p.team, text).toBe(team);
          }
          if (on.length !== 1) expect(got.unresolved, text).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: 1_000 },
    );
  });
});
const TEAM_WORD_SET: Readonly<Record<string, true>> = Object.fromEntries(
  [...Object.keys(F.TEAM_NICKNAMES), ...Object.keys(F.TEAM_HOMES)].flatMap((k) =>
    k
      .toLowerCase()
      .split(" ")
      .map((w) => [w, true] as const),
  ),
);

// -----------------------------------------------------------------------------------------------
describe("R8-7 (5): a written suffix narrows the holders a label can fit, never the residual", () => {
  it("violation 2: no spelled holder takes the residual (each the spelled holder at 0.80 at 66bb2a2)", () => {
    for (const t of [
      "Byron Murphy II: Ruled out for Sunday | Murphy (hamstring) did not practice all week.",
      "Michael Carter II: Questionable",
      "DJ Turner II: Placed on IR | Turner (knee) will miss at least four games.",
      "Chris Smith II: Released",
      "Tony Brown II: Released",
      // a suffix on another occurrence re-spells nothing
      "Byron Murphy: Ruled out Sunday | Murphy (hamstring) won't play. He is not to be confused with Byron Murphy II.",
      "Michael Carter: Released | Carter was let go Tuesday; Michael Carter II was unaffected.",
      "DJ Turner: Signs one-year deal | Turner is not to be confused with DJ Turner II.",
      "Byron Murphy: Two sacks | Murphy, not Byron Murphy Jr., got home twice Sunday.",
      "Michael Carter II: Waived by Eagles",
    ])
      expect(outcome(t), t).toBe("∅ u1");
  });

  it("a label among the holders the spelling leaves: one that fits only another spelling picks none", () => {
    expect(outcome("Eagles S Michael Carter II: Questionable")).toBe(
      "Michael Carter II/PHI/S:full_name_team u0",
    );
    expect(outcome("Seahawks DT Byron Murphy II: Records sack")).toBe(
      "Byron Murphy II/SEA/DT:full_name_team u0",
    );
    expect(outcome("Byron Murphy II (Vikings CB): Ruled out")).toBe("∅ u1");
    expect(outcome("Byron Murphy Jr. (Vikings CB): Ruled out")).toBe(
      "Byron Murphy Jr./MIN/CB:full_name_team u0",
    );
  });

  it("the prominent holder keeps the residual when no spelling excludes him, and only then", () => {
    const mm = buildPlayerMatcher([
      {
        espn_id: 9_700_001,
        full_name: "Sam Twin II",
        team: "MIN",
        gsis_id: null,
        percent_owned: 60,
        position_id: 3,
      },
      {
        espn_id: 9_700_002,
        full_name: "Sam Twin",
        team: "CLE",
        gsis_id: null,
        percent_owned: 0.2,
        position_id: 11,
      },
    ]);
    const r = (t: string) => {
      const x = mm.matchItem(t);
      return `${x.refs.map((y) => `${String(y.espn_id)}:${y.match_method}`).join(",") || "∅"} u${String(x.unresolved)}`;
    };
    expect(r("Sam Twin II: Questionable")).toBe("9700001:full_name u0");
    expect(r("Sam Twin: Questionable")).toBe("9700001:full_name u0");
    // a spelling that excludes him: no one (the namesake is no prominent holder)
    expect(r("Sam Twin Jr.: Questionable")).toBe("∅ u1");
    // a suffix that spells him excludes no prominent holder
    expect(r("Sam Twin: Questionable | Not Sam Twin II, a different player.")).toBe(
      "9700001:full_name u0",
    );
  });
});

// -----------------------------------------------------------------------------------------------
describe("violation 11 (the closing tag): a closing tag alone breaks a label", () => {
  it("'</p>' between a team and the name (the WR at 0.95 with TAG_RE's closing alternative deleted)", () => {
    for (const t of [
      "Browns IDP notes | Opponent: Vikings</p>Justin Jefferson led the team with 12 tackles.",
      "Justin Jefferson: Records sack | Vikings</p>Justin Jefferson posted 12 tackles.",
      "Browns IDP notes | Opponent: Vikings</li>Justin Jefferson led the team.",
    ])
      expect(outcome(t), t).toBe("∅ u1");
    expect(outcome("Browns IDP notes | Opponent: Vikings Justin Jefferson led the team.")).toBe(
      "Justin Jefferson/MIN/WR:full_name_team u0",
    );
  });
});
