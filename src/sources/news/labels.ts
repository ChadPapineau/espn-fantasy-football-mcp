// labels.ts — the reading of a name several universe players hold (a shared name), for the news
// player matcher (ruling R8-6, changelog §R8: the matcher fails closed for a shared name; ruling R8-7
// bounds what its label and scan read; ruling R8-8 fixes them as built and freezes them for Stage C; plan
// 07 D6; plan 02 §6.4 — rules over closed, tested lists, never a model). It reads two things, and nothing
// else about a shared name's holders is read anywhere (R8-6 (c)), both with ONE set of forms (R8-7 (3):
// any form the scan reads as a team or a position is a label form where a label stands):
//
//   the LABEL written next to the name (R8-6 (a), `SharedReading.label`, `surnameSides`) — a team or a
//     position directly before it, whitespace only between ("Browns LB Justin Jefferson", "Browns'
//     Justin Jefferson", "L.A.'s Byron Young", "Nashville's Marcus Harris", "Chiefs Defensive Tackle
//     Jones", "#ChiefsKingdom Chris Jones"); in parentheses directly after it ("(CLE)", "(L.A.)", "(CLE -
//     LB)", "(LB, Browns)", "(Tenn.)", "(#TitanUp)"); or in the headline's name tag before the colon
//     ("Justin Jefferson, CLE:", "Jefferson MLB:", "Justin Jefferson, Minn.:"). A form is one word or up
//     to four ("Green Bay", "wide receiver", "Bank of America"), its words joined by spaces (a period may
//     end a word inside it: "St. Louis", "U.S. Bank"); an initialism keeps its periods and is read in
//     any case ("L.A.'S BYRON YOUNG"); a state's abbreviation may carry its period where a possessive or
//     another label word follows it ("Tenn.'s", "Tenn. CB") and in a tag ("(Md.)", "Minn.:"), but right
//     before the name, or on any other word, a period is punctuation ("…traded to MIN. Justin
//     Jefferson", "…the Vikings. Justin Jefferson"); a hashtag's teams are a label part, as the scan
//     reads them. Adjacency is broken by any punctuation but the possessive ("…the Vikings, Justin
//     Jefferson…" is no label), by a closing quotation mark ("'Beat the Vikings' Justin Jefferson tells
//     …": an apostrophe that closes a quote opened in its segment is no possessive), by a line or a
//     paragraph break the raw item writes (a newline, or any HTML tag, an opening or a closing one:
//     sanitizeText turns both into a space, `markBreaks` keeps where they were), and by any word that is
//     no form ("Vikings star Justin Jefferson" labels no team). Four more rules only take labels away: a
//     label of teams alone with no possessive must open its clause, so a word right before it makes it
//     that word's object or modifier ("Against the Vikings Justin Jefferson recorded 12 tackles", "Week 9
//     at Vikings Justin Jefferson …"; "the Kansas City Chiefs' Chris Jones" labels him); a word of
//     positions.ts AMBIGUOUS_LABEL_WORDS right after a LABEL_BLOCKERS or a GAME_MOVE_WORDS word is the
//     ordinary word ("After safety Lamar Jackson leads …"; "Veteran safety …" and "the Eagles safety …"
//     label him); an ordinary-word abbreviation labels in capitals only, where R8-7 (2) counts it: in a
//     segment of mixed case, and in one written all in capitals inside a tag or right after a game or
//     move word ("for MIN WR Justin Jefferson", "INJURY UPDATE FOR MIA DT …", "SAM TWIN (NO): OUT";
//     "BROWNS EDGE JUSTIN JEFFERSON, VIKINGS" labels no one, and in lower or title case it is the
//     ordinary word or a first name: "to Will Smith"); and before a surname, a one-word singular or
//     place (a city, a town, a facility, a stadium) written without a possessive may be a person's first
//     name ("Bill Johnson", "Charlotte Jones"), so it labels no one there (a nickname, a home, a short
//     name, a fans' or a legacy name does: "Vikes Jefferson"). A tag that holds anything else is no label
//     ("(knee)", "(vs. CLE)", "(TEN.)");
//   the broad SCAN (R8-6 (b), `SharedReading.namesTeamOrPosition`) — whether the title or the blurb
//     names any team or any position anywhere, the persons' full names left out ("Dallas Goedert"; a
//     surname standing alone may be a team, "Washington", and is read): every form of the lists below,
//     in any case, as a word, two to four words in a row (a slash may join them: "D/ST"), the parts a
//     hyphen or a period joins, and a compound that holds one (a handle, a hashtag, a domain, a
//     camel-cased word: "@Browns", "#RaiderNation", "#CLEvsMIN", "ClevelandBrowns.com", "kcchiefs.com").
//     The scan only ever takes the residual away, so it errs toward finding: an ambiguous token costs
//     recall, never precision.
//
// The case of an abbreviation (R8-7 (2)). One whose lower case is an ordinary English word or part of a
// name (ORDINARY_WORD_ABBREVIATIONS: "NO", "WAS", "TEN", "MIN", "SEA", "WILL", "EDGE", "ED" …) counts in
// capitals outside a segment written all in capitals, and in any case directly after a game or move
// word (GAME_MOVE_WORDS: "vs. Sea", "by Den", "at Will", "@ Min"): "Jackson was limited", "No
// timetable" and "He will play" name nothing. Every other abbreviation counts in any case ("cle",
// "olb"), and so does every abbreviation written with periods ("L.A.", "K.C.", "N.O."). A segment is
// the title or the blurb, or a part a "|" or a line or paragraph break separates.
//
// The forms (R8-7 (1): complete when they hold, for each of the 32 teams, every category below; a form
// outside them leaves the accepted residual, R8-3 clause 6, a known limitation under R8-8 (3)). Each list
// is closed and held entry by entry by the tests: teams.ts' nicknames and homes (exactly the unique
// names' own) and SHARED_HOMES; TEAM_SHORT_NAMES and TEAM_SINGULARS (the nickname's short forms and its
// singular); TEAM_CITIES (the city or state, its short names and nicknames: "Phila.", "PGH", "MSP", "the
// Valley"); TEAM_STADIUMS (the current stadium by every name it has had since 2015, by the words a writer
// keeps: "Lincoln Financial", "the Linc", "Huntington Bank", "FedEx Field"; and some former homes);
// TEAM_FACILITIES (the training facility, its town and the camp town: "Jefferson Health", "Kettering
// Health", "Rochester"); TEAM_HASHTAGS (the official hashtags no other form finds; read after "#" only);
// TEAM_FAN_NAMES (the fans' names and nicknames: every form an attack has reported, and more);
// TEAM_LEGACY_NAMES; TEAM_ABBREVIATIONS (ESPN's, nflverse's, PFR's and PFF's, MyFantasyLeague's, the
// feeds'), TEAM_LEGACY_ABBREVIATIONS and TEAM_STATE_ABBREVIATIONS (the home state's postal and AP
// abbreviations: "MN", "Minn."; Louisiana's "LA" and "La." read as the Rams' LA, and New York's "NY" as
// either New York team: one form, one reading). Each word form is read in each spelling: its words
// joined by a space, a hyphen or nothing ("G-Men", "G Men", "Gmen"; a spaced spelling never opens with
// the article "a": "A-Town"), its possessive "'s" written or not ("America's Team"). A label's team is
// the universe's: it fits only a holder on one of the teams it names (match.ts).
//
// The item is read FOLDED (`foldText`), one code point at a time, with a map back to the sanitised
// text's offsets: an apostrophe-like mark (APOSTROPHES) to "'", a lookalike letter (CONFUSABLES) to its
// Latin letter, else NFKD with the combining marks stripped (accents, fullwidth and compatibility
// forms), each piece's dash punctuation (Unicode's Pd, and DASHES) to "-". sanitizeText (plan 02 §6.2)
// has already removed controls and zero-width characters and collapsed whitespace. Every reading is
// linear in the item: the fold, the breaks, the quotes and the scan are one pass each (the scan reads
// each word once, a compound up to MAX_COMPOUND letters through a trie of the forms), a label reads a
// bounded window around each name and each form in it once per item (the windows of adjacent names
// share their words: "Houston Houston …"), and the forms of several words a surname may stand in are
// one pass over the item, read when the first surname near a form's first word asks. A form of several
// words is looked up only after a word that opens one, and past it only after two that do; a written
// form's lookups are remembered (bounded).
import type { NflTeam } from "../../config/schema.js";
import {
  isAmbiguousLabelWord,
  MAX_POSITION_WORDS,
  opensPositionPhrase,
  POSITION_PHRASE_HEADS,
  positionAbbreviation,
  positionWordIds,
} from "./positions.js";
import { TEAM_HOMES, TEAM_NICKNAMES } from "./teams.js";

/** The homes that hold two teams: a team of either ("the Los Angeles Rams", "New York's"). */
export const SHARED_HOMES: Readonly<Record<string, readonly NflTeam[]>> = Object.freeze({
  "Los Angeles": Object.freeze(["LA", "LAC"] as const),
  "New York": Object.freeze(["NYG", "NYJ"] as const),
});

/** The short names feeds write for a team, beside teams.ts' nicknames ("Vikes", "Jints"). */
// prettier-ignore
export const TEAM_SHORT_NAMES: Readonly<Record<string, NflTeam>> = Object.freeze({
  Vikes: "MIN", Fins: "MIA", Phins: "MIA", Bolts: "LAC", Pack: "GB", Hawks: "SEA", Cards: "ARI",
  "G-Men": "NYG", Cincy: "CIN", Vegas: "LV", "Big Blue": "NYG", "Gang Green": "NYJ", Jints: "NYG",
  Brownies: "CLE", Stillers: "PIT", Commies: "WAS", Donkeys: "DEN", Bungles: "CIN",
});

/**
 * Singular nicknames ("a former Raven", "Ex-Brown", "ex-Bolt"). Those that are ordinary words or names
 * (Brown, Bill, Chief, Giant, Jet, Saint, Ram, Colt, Lion, Bear, Pat) are forms too: an ambiguous token
 * counts as found (R8-6 (b)), and a label of teams alone must open its clause.
 */
// prettier-ignore
export const TEAM_SINGULARS: Readonly<Record<string, NflTeam>> = Object.freeze({
  Cardinal: "ARI", Falcon: "ATL", Raven: "BAL", Bill: "BUF", Panther: "CAR", Bear: "CHI",
  Bengal: "CIN", Brown: "CLE", Cowboy: "DAL", Bronco: "DEN", Lion: "DET", Packer: "GB",
  Texan: "HOU", Colt: "IND", Jaguar: "JAX", Jag: "JAX", Chief: "KC", Ram: "LA", Charger: "LAC",
  Bolt: "LAC", Raider: "LV", Dolphin: "MIA", Fin: "MIA", Phin: "MIA", Viking: "MIN", Vike: "MIN",
  Patriot: "NE", Pat: "NE", Saint: "NO", Giant: "NYG", Jet: "NYJ", Eagle: "PHI", Steeler: "PIT",
  Seahawk: "SEA", "49er": "SF", Niner: "SF", Buccaneer: "TB", Buc: "TB", Titan: "TEN",
  Commander: "WAS",
});

/**
 * The city or state of a team where teams.ts names neither, its common short names and its nicknames
 * ("in Nashville", "Chi-Town", "the Big Apple", "Mpls"); New Jersey, where both New York teams play.
 */
// prettier-ignore
export const TEAM_CITIES: Readonly<Record<string, readonly NflTeam[]>> = Object.freeze({
  Phoenix: ["ARI"], Zona: ["ARI"], "Valley of the Sun": ["ARI"], "the Valley": ["ARI"],
  "A-Town": ["ATL"], Hotlanta: ["ATL"],
  "Charm City": ["BAL"], "B'more": ["BAL"],
  "Queen City": ["BUF", "CAR", "CIN"], "Nickel City": ["BUF"], WNY: ["BUF"],
  Charlotte: ["CAR"], Carolinas: ["CAR"],
  "Windy City": ["CHI"], "Chi-Town": ["CHI"], "Second City": ["CHI"], Chicagoland: ["CHI"],
  Nati: ["CIN"],
  "the Land": ["CLE"], "C-Town": ["CLE"], Believeland: ["CLE"],
  "Big D": ["DAL"], Metroplex: ["DAL"], DFW: ["DAL"], Frisco: ["DAL", "SF"],
  "Mile High": ["DEN"],
  "Motor City": ["DET"], Motown: ["DET"],
  Titletown: ["GB"],
  "H-Town": ["HOU"], "Space City": ["HOU"], "Bayou City": ["HOU"],
  Naptown: ["IND"], "Circle City": ["IND"],
  Duval: ["JAX"], "River City": ["JAX"],
  KCMO: ["KC"],
  SoCal: ["LA", "LAC"], "City of Angels": ["LA", "LAC"], Tinseltown: ["LA", "LAC"],
  "Sin City": ["LV"],
  "Magic City": ["MIA"], "South Beach": ["MIA"], "South Florida": ["MIA"],
  Minneapolis: ["MIN"], Mpls: ["MIN"], "Twin Cities": ["MIN"], Minny: ["MIN"], "St Paul": ["MIN"],
  "Saint Paul": ["MIN"], MSP: ["MIN"],
  Boston: ["NE"], Beantown: ["NE"],
  NOLA: ["NO"], "Big Easy": ["NO"], "Crescent City": ["NO"],
  NYC: ["NYG", "NYJ"], "Big Apple": ["NYG", "NYJ"], Gotham: ["NYG", "NYJ"],
  "New Jersey": ["NYG", "NYJ"],
  "Brotherly Love": ["PHI"], Phila: ["PHI"], PHL: ["PHI"],
  "Steel City": ["PIT"], Burgh: ["PIT"], Pitt: ["PIT"], PGH: ["PIT"],
  "San Fran": ["SF"], "Bay Area": ["SF"],
  "Emerald City": ["SEA"], "Rain City": ["SEA"], PNW: ["SEA"], "Pacific Northwest": ["SEA"],
  Tampa: ["TB"], "Cigar City": ["TB"], "St Pete": ["TB"], "St Petersburg": ["TB"],
  Nashville: ["TEN"], "Music City": ["TEN"], Nashvegas: ["TEN"],
  DMV: ["WAS"], "the District": ["WAS"],
});

/**
 * Each team's current stadium by every name it has had since 2015, by the words a writer keeps
 * ("Lincoln Financial" of Lincoln Financial Field, "US Bank" of U.S. Bank Stadium), its nicknames ("the
 * Linc", "Jerry World") and the former homes of some.
 */
// prettier-ignore
export const TEAM_STADIUMS: Readonly<Record<string, readonly NflTeam[]>> = Object.freeze({
  "State Farm": ["ARI"], "University of Phoenix": ["ARI"],
  "Mercedes-Benz": ["ATL", "NO"], "Georgia Dome": ["ATL"],
  "M&T Bank": ["BAL"], "M&T": ["BAL"],
  Highmark: ["BUF"], "New Era Field": ["BUF"], "Ralph Wilson": ["BUF"],
  "Bank of America": ["CAR"], BofA: ["CAR"],
  "Soldier Field": ["CHI"],
  Paycor: ["CIN"], "Paul Brown Stadium": ["CIN"], "the Jungle": ["CIN"],
  "Huntington Bank": ["CLE"], FirstEnergy: ["CLE"],
  "AT&T": ["DAL"], "Jerry World": ["DAL"],
  "Empower Field": ["DEN"], "Sports Authority": ["DEN"],
  "Ford Field": ["DET"],
  Lambeau: ["GB"],
  NRG: ["HOU"],
  "Lucas Oil": ["IND"],
  EverBank: ["JAX"], TIAA: ["JAX"],
  Arrowhead: ["KC"], GEHA: ["KC"],
  SoFi: ["LA", "LAC"], "Edward Jones": ["LA"], Qualcomm: ["LAC"], StubHub: ["LAC"],
  Allegiant: ["LV"], "Death Star": ["LV"],
  "Hard Rock": ["MIA"], "Sun Life": ["MIA"],
  "US Bank": ["MIN"], "TCF Bank": ["MIN"],
  Gillette: ["NE"],
  Superdome: ["NO"],
  MetLife: ["NYG", "NYJ"], Meadowlands: ["NYG", "NYJ"],
  "Lincoln Financial": ["PHI"], Linc: ["PHI"],
  Acrisure: ["PIT"], "Heinz Field": ["PIT"],
  "Levi's Stadium": ["SF"],
  Lumen: ["SEA"], CenturyLink: ["SEA"],
  "Raymond James": ["TB"], "Ray Jay": ["TB"],
  "Nissan Stadium": ["TEN"], "LP Field": ["TEN"],
  "Northwest Stadium": ["WAS"], FedEx: ["WAS"], "FedEx Field": ["WAS"],
});

/** Each team's training facility, the town it stands in, and its training camp's town. */
// prettier-ignore
export const TEAM_FACILITIES: Readonly<Record<string, readonly NflTeam[]>> = Object.freeze({
  Tempe: ["ARI"], Glendale: ["ARI"], "Dignity Health": ["ARI", "LAC"],
  "Flowery Branch": ["ATL"], "IBM Performance": ["ATL"],
  "Owings Mills": ["BAL"], "Armour Performance": ["BAL"],
  "Orchard Park": ["BUF"], ADPRO: ["BUF"], Pittsford: ["BUF"], "John Fisher": ["BUF"],
  Rochester: ["BUF"],
  Spartanburg: ["CAR"], Wofford: ["CAR"], "Atrium Health": ["CAR"],
  "Halas Hall": ["CHI"], "Lake Forest": ["CHI"], Bourbonnais: ["CHI"], Olivet: ["CHI"],
  "Kettering Health": ["CIN"], IEL: ["CIN"],
  Berea: ["CLE"], CrossCountry: ["CLE"],
  Arlington: ["DAL"], "the Star": ["DAL"], "Ford Center": ["DAL"], Oxnard: ["DAL"],
  "River Ridge": ["DAL"],
  "Dove Valley": ["DEN"], UCHealth: ["DEN"], Englewood: ["DEN"], CommonSpirit: ["DEN"],
  "Allen Park": ["DET"], "Meijer Performance": ["DET"],
  "Don Hutson": ["GB"], Nitschke: ["GB"],
  "Methodist Training": ["HOU"], Greenbrier: ["HOU", "NO"], "White Sulphur": ["HOU", "NO"],
  "Farm Bureau": ["IND"], Westfield: ["IND"], "Grand Park": ["IND"], "Anderson University": ["IND"],
  "Miller Electric": ["JAX"],
  "Kansas Health": ["KC"], "St Joseph": ["KC"], "Saint Joseph": ["KC"], "Missouri Western": ["KC"],
  Inglewood: ["LA", "LAC"], "Thousand Oaks": ["LA"], "Cal Lutheran": ["LA"],
  "Woodland Hills": ["LA"], "Warner Center": ["LA"], "Agoura Hills": ["LA"], Irvine: ["LA", "NO"],
  "El Segundo": ["LAC"], "Costa Mesa": ["LAC"], "Jack Hammett": ["LAC"],
  Henderson: ["LV"], Intermountain: ["LV"], Napa: ["LV"], Paradise: ["LV"],
  Davie: ["MIA"], "Miami Gardens": ["MIA"], "Baptist Health": ["MIA"], "Nova Southeastern": ["MIA"],
  Eagan: ["MIN"], TCO: ["MIN"], Mankato: ["MIN"],
  Foxborough: ["NE"], Foxboro: ["NE"], "New Balance": ["NE"],
  Metairie: ["NO"], Ochsner: ["NO"],
  "East Rutherford": ["NYG", "NYJ"], "Quest Diagnostics": ["NYG"],
  "Florham Park": ["NYJ"], "Atlantic Health": ["NYJ"],
  NovaCare: ["PHI"], "Jefferson Health": ["PHI"],
  Latrobe: ["PIT"], "Saint Vincent": ["PIT"], "St Vincent": ["PIT"], "UPMC Rooney": ["PIT"],
  "Rooney Sports": ["PIT"],
  "Santa Clara": ["SF"], "SAP Performance": ["SF"],
  Renton: ["SEA"], VMAC: ["SEA"], "Virginia Mason": ["SEA"],
  AdventHealth: ["TB"],
  "Saint Thomas": ["TEN"], "St Thomas": ["TEN"], "Vanderbilt Health": ["TEN"],
  Ashburn: ["WAS"], Landover: ["WAS"], Inova: ["WAS"], OrthoVirginia: ["WAS"], Richmond: ["WAS"],
  "Bon Secours": ["WAS"],
});

/**
 * The teams' own hashtags that no other form finds inside them ("#HereWeGo", "#KeepPounding"): read
 * after "#" only, in any case. ("#OnePride", "#DUUUVAL", "#BirdGang" and "#RuleTheJungle" hold a fans'
 * name or a stadium's, so those forms find them.)
 */
// prettier-ignore
export const TEAM_HASHTAGS: Readonly<Record<string, NflTeam>> = Object.freeze({
  BirdCityFootball: "ARI", BeRedSeeRed: "ARI", RiseUp: "ATL", InBrotherhood: "ATL",
  KeepPounding: "CAR", ForTheShoe: "IND", WhoseHouse: "LA", TogetherBlue: "NYG", TakeFlight: "NYJ",
  HereWeGo: "PIT", FTTB: "SF", SiegeTheDay: "TB", HTTC: "WAS", HTTR: "WAS", RaiseHail: "WAS",
});

/**
 * The fans' names and the nicknames fans and writers give a team, those several teams share among them
 * ("Birds", "Cats"): every form an attack on the matcher has reported ("Jints", "the Fish", "the Cats",
 * "the Dawgs", "America's Team", "Factory of Sadness"), and the common others.
 */
// prettier-ignore
export const TEAM_FAN_NAMES: Readonly<Record<string, readonly NflTeam[]>> = Object.freeze({
  Birds: ["ARI", "ATL", "BAL", "PHI", "SEA"], Cats: ["CAR", "CIN", "DET", "JAX"],
  "Big Red": ["ARI"], "Red Sea": ["ARI"],
  "Dirty Birds": ["ATL"], "Dirty Bird": ["ATL"],
  "Roaring Riot": ["CAR"],
  "Monsters of the Midway": ["CHI"],
  "Who Dey": ["CIN"],
  "Dawg Pound": ["CLE"], Dawgs: ["CLE"], "Factory of Sadness": ["CLE"],
  Boys: ["DAL"], Boyz: ["DAL"], "America's Team": ["DAL"],
  "Orange Crush": ["DEN"],
  "One Pride": ["DET"],
  Cheeseheads: ["GB"], Cheesehead: ["GB"],
  "Bulls on Parade": ["HOU"],
  Duuuval: ["JAX"],
  "Black Hole": ["LV"], "Silver and Black": ["LV"],
  "the Fish": ["MIA"], Dolfans: ["MIA"],
  Skol: ["MIN"], "Purple People Eaters": ["MIN"],
  "Who Dat": ["NO"], "Black and Gold": ["NO", "PIT"],
  Iggles: ["PHI"], "Bird Gang": ["PHI"],
  "Steel Curtain": ["PIT"], "Terrible Towel": ["PIT"], Yinzers: ["PIT"], Yinzer: ["PIT"],
  Yinz: ["PIT"],
  "the Faithful": ["SF"],
  "12s": ["SEA"], "12th Man": ["SEA"], "Legion of Boom": ["SEA"],
  "Burgundy and Gold": ["WAS"],
});

/** The names of moved and renamed teams ("Oilers", "Football Team", "St. Louis"). */
// prettier-ignore
export const TEAM_LEGACY_NAMES: Readonly<Record<string, readonly NflTeam[]>> = Object.freeze({
  Oilers: ["TEN"], Redskins: ["WAS"], Skins: ["WAS"], "Football Team": ["WAS"], Oakland: ["LV"],
  "San Diego": ["LAC"], "St Louis": ["LA"], "Saint Louis": ["LA"],
});

/**
 * The team abbreviations feeds write: nflverse's; ESPN's LAR and WSH; the JAC some feeds use; PFF's
 * ARZ, BLT, CLV and HST; Pro Football Reference's GNB, KAN, LVR, NOR, NWE, SFO and TAM and its franchise
 * codes CRD, RAV, HTX, CLT, OTI and RAI; MyFantasyLeague's GBP, KCC, NEP, NOS and TBB; and NY (either New
 * York team).
 */
// prettier-ignore
export const TEAM_ABBREVIATIONS: Readonly<Record<string, readonly NflTeam[]>> = Object.freeze({
  ARI: ["ARI"], ARZ: ["ARI"], CRD: ["ARI"], ATL: ["ATL"], BAL: ["BAL"], BLT: ["BAL"], RAV: ["BAL"],
  BUF: ["BUF"], CAR: ["CAR"], CHI: ["CHI"], CIN: ["CIN"], CLE: ["CLE"], CLV: ["CLE"], DAL: ["DAL"],
  DEN: ["DEN"], DET: ["DET"], GB: ["GB"], GNB: ["GB"], GBP: ["GB"], HOU: ["HOU"], HST: ["HOU"],
  HTX: ["HOU"], IND: ["IND"], CLT: ["IND"], JAX: ["JAX"], JAC: ["JAX"], KC: ["KC"], KAN: ["KC"],
  KCC: ["KC"], LA: ["LA"], LAR: ["LA"], LAC: ["LAC"], LV: ["LV"], LVR: ["LV"], RAI: ["LV"],
  MIA: ["MIA"], MIN: ["MIN"], NE: ["NE"], NWE: ["NE"], NEP: ["NE"], NO: ["NO"], NOR: ["NO"],
  NOS: ["NO"], NYG: ["NYG"], NYJ: ["NYJ"], NY: ["NYG", "NYJ"], PHI: ["PHI"], PIT: ["PIT"],
  SEA: ["SEA"], SF: ["SF"], SFO: ["SF"], TB: ["TB"], TAM: ["TB"], TBB: ["TB"], TEN: ["TEN"],
  OTI: ["TEN"], WAS: ["WAS"], WSH: ["WAS"],
});

/** The abbreviations of moved and renamed teams (OAK, SD, SDG, STL, PHX, PHO, WFT, BOS). */
// prettier-ignore
export const TEAM_LEGACY_ABBREVIATIONS: Readonly<Record<string, readonly NflTeam[]>> = Object.freeze({
  OAK: ["LV"], SD: ["LAC"], SDG: ["LAC"], STL: ["LA"], PHX: ["ARI"], PHO: ["ARI"], WFT: ["WAS"],
  BOS: ["NE"],
});

/**
 * The postal and AP abbreviations of each team's home state ("MN", "Minn.", "TN", "Tenn."; the AP's
 * period is the word's punctuation), and D.C.'s. Louisiana's LA and La. are TEAM_ABBREVIATIONS' LA, New
 * York's NY and N.Y. its NY, Indiana's Ind. its IND.
 */
// prettier-ignore
export const TEAM_STATE_ABBREVIATIONS: Readonly<Record<string, readonly NflTeam[]>> = Object.freeze({
  AZ: ["ARI"], ARIZ: ["ARI"], GA: ["ATL"], MD: ["BAL", "WAS"], NC: ["CAR"], IL: ["CHI"],
  ILL: ["CHI"], OH: ["CIN", "CLE"], TX: ["DAL", "HOU"], CO: ["DEN"], COLO: ["DEN"], MI: ["DET"],
  MICH: ["DET"], WI: ["GB"], WIS: ["GB"], IN: ["IND"], FL: ["JAX", "MIA", "TB"],
  FLA: ["JAX", "MIA", "TB"], MO: ["KC"], CA: ["LA", "LAC", "SF"], CALIF: ["LA", "LAC", "SF"],
  NV: ["LV"], NEV: ["LV"], MN: ["MIN"], MINN: ["MIN"], MA: ["NE"], MASS: ["NE"],
  NJ: ["NYG", "NYJ"], PA: ["PHI", "PIT"], WA: ["SEA"], WASH: ["SEA"], TN: ["TEN"], TENN: ["TEN"],
  VA: ["WAS"], DC: ["WAS"],
});

/**
 * R8-7 (2): the abbreviations whose lower case is an ordinary English word or part of a name — teams',
 * states' and positions' (positions.ts POSITION_ABBREVIATIONS) — counted in capitals outside a segment
 * written all in capitals, and in any case directly after a GAME_MOVE_WORDS word.
 */
// prettier-ignore
export const ORDINARY_WORD_ABBREVIATIONS: readonly string[] = Object.freeze([
  "ARI", "CAR", "CHI", "DAL", "DEN", "JAC", "LA", "LAC", "MIA", "MIN", "NO", "NOR", "NOS", "OAK",
  "PHI", "PHO", "PIT", "RAI", "SEA", "TAM", "TEN", "WAS",
  "CO", "ILL", "IN", "MA", "MASS", "MI", "MO", "OH", "PA", "WASH", "WI",
  "C", "DE", "DI", "ED", "EDGE", "G", "K", "LT", "MIKE", "OL", "P", "S", "SAM", "ST", "WILL",
]);

/**
 * R8-7 (2): the game and move words after which an ordinary-word abbreviation counts in any case ("vs.
 * Sea", "by Den", "at Will"). "v" counts with its period only; "@" may be written glued ("@Min").
 */
// prettier-ignore
export const GAME_MOVE_WORDS: readonly string[] = Object.freeze([
  "vs", "vs.", "v.", "@", "at", "against", "by", "from", "for", "to", "with", "visits", "hosts",
  "faces",
]);

/** What may stand between the items of a tag (a space too): "(CLE - LB)", "(LB, Browns)", "(QB/RB)". */
export const LABEL_SEPARATORS: readonly string[] = Object.freeze([",", "-", "/"]);

/**
 * The articles and prepositions an ordinary-word position (AMBIGUOUS_LABEL_WORDS) is the object of
 * right after them, beside GAME_MOVE_WORDS: "After safety Lamar Jackson leads …", "in the corner
 * Justin Jefferson …" — no label ("Veteran safety …" is one). A label of teams alone needs no list: it
 * must open its clause.
 */
// prettier-ignore
export const LABEL_BLOCKERS: readonly string[] = Object.freeze([
  "a", "about", "above", "across", "after", "along", "amid", "among", "an", "around", "as",
  "before", "behind", "beside", "between", "beyond", "despite", "during", "facing", "in", "inside",
  "into", "like", "near", "of", "off", "on", "onto", "outside", "over", "past", "per", "since",
  "than", "the", "through", "toward", "towards", "under", "until", "upon", "v", "versus", "via",
  "within", "without",
]);

/**
 * The words whose period does not end the clause: a team right after "vs." or "v." is that word's
 * object ("Week 9 vs. Vikings Justin Jefferson …").
 */
export const CLAUSE_ABBREVIATIONS: readonly string[] = Object.freeze(["v", "vs"]);

/**
 * The letters folded to Latin ones: some Cyrillic, Greek and Armenian lookalikes (each listed one, not
 * every lookalike), and the Latin letters NFKD does not decompose (accents are stripped as combining
 * marks).
 */
// prettier-ignore
export const CONFUSABLES: Readonly<Record<string, string>> = Object.freeze({
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
});

/**
 * The marks folded to an apostrophe ("'"): the curly and reversed single quotes, the modifier letters
 * apostrophe and turned comma, the grave and acute accents, and the prime.
 */
// prettier-ignore
export const APOSTROPHES: readonly string[] = Object.freeze([
  "\u2019", "\u2018", "\u201B", "\u02BC", "\u02BB", "`", "\u00B4", "\u2032",
]);

/** Beside Unicode's dash punctuation (Pd), the marks folded to a hyphen ("-"): the minus sign. */
export const DASHES: readonly string[] = Object.freeze(["\u2212"]);

// ---------------------------------------------------------------------------------------------------
// The forms, keyed once.

/** A word or several of the folded text as the lists key them: lower case, no apostrophe, one space. */
function formKey(written: string): string {
  return written.toLowerCase().replaceAll("'", "").replace(/\s+/gu, " ").trim();
}

/**
 * A listed word form's spellings: its possessive "'s" written or not, then its words (split at a space
 * or a hyphen) joined by a space, a hyphen or nothing, each join chosen apart; a spaced spelling never
 * opens with the article "a" ("A-Town" is "a-town" and "atown", never "a town").
 */
function spellings(form: string): string[] {
  const out = new Set<string>();
  for (const base of new Set([form, form.replace(/'s\b/gu, "")])) {
    const words = formKey(base).split(/[\s-]+/u);
    let joins = [words[0] ?? ""];
    for (const w of words.slice(1))
      joins = joins.flatMap((s) => [`${s} ${w}`, `${s}-${w}`, `${s}${w}`]);
    for (const j of joins) if (!j.startsWith("a ")) out.add(j);
  }
  return [...out];
}

const freezeTeams = (teams: readonly NflTeam[]): readonly NflTeam[] => Object.freeze([...teams]);
const entriesOf = (
  o: Readonly<Record<string, NflTeam | readonly NflTeam[]>>,
): (readonly [string, readonly NflTeam[]])[] =>
  Object.entries(o).map(([k, t]) => [k, freezeTeams(typeof t === "string" ? [t] : t)] as const);

/** Keys their teams, a key listed twice naming the teams of both ("Queen City", "Irvine"). */
function teamMap(
  entries: readonly (readonly [string, readonly NflTeam[]])[],
): ReadonlyMap<string, readonly NflTeam[]> {
  const out = new Map<string, readonly NflTeam[]>();
  for (const [k, ts] of entries)
    out.set(k, freezeTeams([...new Set([...(out.get(k) ?? []), ...ts])]));
  return out;
}

/** Every word form of a team, each spelling: one word or up to four. */
const WORD_TEAMS: ReadonlyMap<string, readonly NflTeam[]> = teamMap(
  [
    TEAM_NICKNAMES,
    TEAM_HOMES,
    SHARED_HOMES,
    TEAM_SHORT_NAMES,
    TEAM_SINGULARS,
    TEAM_CITIES,
    TEAM_STADIUMS,
    TEAM_FACILITIES,
    TEAM_FAN_NAMES,
    TEAM_LEGACY_NAMES,
  ]
    .flatMap(entriesOf)
    .flatMap(([k, ts]) => spellings(k).map((s) => [s, ts] as const)),
);
/** The hashtags, lower case (read after "#" only). */
const HASHTAG_TEAMS: ReadonlyMap<string, readonly NflTeam[]> = teamMap(
  entriesOf(TEAM_HASHTAGS).map(([k, ts]) => [k.toLowerCase(), ts] as const),
);
/** Every team abbreviation, in capitals. */
const ABBREVIATION_TEAMS: ReadonlyMap<string, readonly NflTeam[]> = teamMap(
  [TEAM_ABBREVIATIONS, TEAM_LEGACY_ABBREVIATIONS, TEAM_STATE_ABBREVIATIONS].flatMap(entriesOf),
);
const ORDINARY: ReadonlySet<string> = new Set(ORDINARY_WORD_ABBREVIATIONS);
/** The home states' abbreviations, in capitals: a period may end one in a label ("Tenn.", "Md."). */
const STATE_ABBREVIATIONS: ReadonlySet<string> = new Set(Object.keys(TEAM_STATE_ABBREVIATIONS));
/**
 * The one-word singulars and places (a city, a town, a facility, a stadium) that may be a person's first
 * name ("Bill Johnson", "Charlotte Jones"): written right before a surname without a possessive they label
 * it not (the surname is counted). A nickname, a home, a short name, a fans' name or a legacy name labels
 * it there ("Vikes Jefferson"), as every form labels a full name; no key is in both groups.
 */
const FIRST_NAME_FORMS: ReadonlySet<string> = new Set(
  [TEAM_SINGULARS, TEAM_CITIES, TEAM_FACILITIES, TEAM_STADIUMS]
    .flatMap((o) => Object.keys(o))
    .filter((k) => !/[\s-]/u.test(k))
    .flatMap(spellings),
);
/** The longest form, in words (a reader tries forms of up to this many words). */
const MAX_FORM_WORDS = Math.max(
  MAX_POSITION_WORDS,
  ...[...WORD_TEAMS.keys()].map((k) => k.split(" ").length),
);

/** A trie of forms and their teams, for the forms inside a compound (bounded: a walk per offset). */
interface Trie {
  readonly next: Map<string, Trie>;
  /** The teams of the form that ends here, or null. */
  teams: readonly NflTeam[] | null;
}
function trieOf(entries: Iterable<readonly [string, readonly NflTeam[]]>): Trie {
  const root: Trie = { next: new Map(), teams: null };
  for (const [w, teams] of entries) {
    let node = root;
    for (const c of w) {
      let n = node.next.get(c);
      if (n === undefined) {
        n = { next: new Map(), teams: null };
        node.next.set(c, n);
      }
      node = n;
    }
    node.teams = freezeTeams([...new Set([...(node.teams ?? []), ...teams])]);
  }
  return root;
}
/** Adds the teams of every trie form standing anywhere in `s` to `out`. */
function trieTeams(trie: Trie, s: string, out: Set<NflTeam>): void {
  for (let i = 0; i < s.length; i++) {
    let node: Trie | undefined = trie;
    for (let j = i; j < s.length; j++) {
      node = node.next.get(s[j] ?? "");
      if (node === undefined) break;
      for (const t of node.teams ?? []) out.add(t);
    }
  }
}
/** The longest compound read (bounded work): "www.philadelphiaeagles.com" fits. */
const MAX_COMPOUND = 64;
/** The team word forms searched for inside a compound: glued, four letters or more. */
const COMPOUND_TRIE: Trie = trieOf(
  [...WORD_TEAMS.entries()]
    .filter(([k]) => !/[\s-]/u.test(k))
    .map(([k, ts]) => [k.replaceAll(/[^\p{L}\p{N}]/gu, ""), ts] as const)
    .filter(([k]) => k.length >= 4),
);
/**
 * Inside a hashtag only, the team's own hashtags, and the shorter forms too: the three-letter
 * abbreviations that are no ordinary word (R8-7 (2)) and the three-letter words ("#clevsmin", "#jetup").
 */
const HASHTAG_TRIE: Trie = trieOf([
  ...HASHTAG_TEAMS.entries(),
  ...[...ABBREVIATION_TEAMS.entries()]
    .filter(([a]) => a.length === 3 && !ORDINARY.has(a))
    .map(([a, ts]) => [a.toLowerCase(), ts] as const),
  ...[...WORD_TEAMS.entries()].filter(([k]) => !/[\s-]/u.test(k) && k.length === 3),
]);

// ---------------------------------------------------------------------------------------------------
// A form as it stands: its case read where it is written (R8-7 (2)).

/** One part of a label written next to a name: the teams it may name, or the position ids it names. */
export type LabelPart =
  | { readonly kind: "team"; readonly teams: readonly NflTeam[] }
  | { readonly kind: "position"; readonly ids: ReadonlySet<number> };

/** Where a form stands, for the case of an ordinary-word abbreviation. */
interface Place {
  /** Its segment is written all in capitals. */
  readonly caps: boolean;
  /** Whether it stands directly after a game or move word (read only when an abbreviation asks). */
  readonly after: () => boolean;
  /** It stands inside a label's tag (parentheses, the name tag). */
  readonly tag: boolean;
  /** It is a hashtag's word. */
  readonly hash: boolean;
}

/** A place's game-word context where none applies. */
const NEVER = (): boolean => false;
/** Letters joined by periods: an initialism ("L.A", "K.C"), read as one word. */
const INITIALISM_RE = /^(?:\p{L}\.)+\p{L}$/u;
/** A word of a form as the lists key it: an initialism without its periods ("U.S" → "US"). */
const wordOf = (w: string): string => (INITIALISM_RE.test(w) ? w.replaceAll(".", "") : w);
const isLower = (c: string): boolean => c !== c.toUpperCase();
const isUpper = (c: string): boolean => c !== c.toLowerCase();
/** Whether a written token is all capitals (at least one letter, no lower-case letter). */
const isCaps = (written: string): boolean => /\p{Lu}/u.test(written) && !/\p{Ll}/u.test(written);

/** Whether an abbreviation written as `stem` counts where it stands (R8-7 (2)). */
function counts(stem: string, place: Place): boolean {
  if (!ORDINARY.has(stem.toUpperCase())) return true;
  return (isCaps(stem) && (!place.caps || place.tag)) || place.after();
}

const ID_SETS = new Map<readonly number[], ReadonlySet<number>>();
const idSet = (ids: readonly number[]): ReadonlySet<number> => {
  let s = ID_SETS.get(ids);
  if (s === undefined) {
    s = new Set(ids);
    ID_SETS.set(ids, s);
  }
  return s;
};

/** What a written form keys in the word lists, whatever its case and place. */
interface Keyed {
  /** Its key: lower case, no apostrophe, single spaces, an initialism without its periods. */
  readonly key: string;
  /** The teams of the word form it is, or undefined. */
  readonly teams: readonly NflTeam[] | undefined;
  /** The position ids of the position word it is, or null. */
  readonly ids: readonly number[] | null;
}
const KEYED_CACHE = new Map<string, Keyed>();
const KEYED_CACHE_MAX = 65_536;
/** A written form's lookups, remembered (an item repeats its words; bounded work, bounded memory). */
function keyedOf(written: string): Keyed {
  const hit = KEYED_CACHE.get(written);
  if (hit !== undefined) return hit;
  const key = formKey(written.split(" ").map(wordOf).join(" "));
  const keyed: Keyed = { key, teams: WORD_TEAMS.get(key), ids: positionWordIds(key) };
  if (KEYED_CACHE.size < KEYED_CACHE_MAX) KEYED_CACHE.set(written, keyed);
  return keyed;
}

/**
 * What a written form (folded; one word, or several with single spaces; an initialism with its periods,
 * "L.A", "U.S Bank") names where it stands: a team (a word form in any case and spelling, a hashtag
 * after "#", an abbreviation by its case, an initialism in any case) or a position (positions.ts), else
 * null.
 */
function formAt(written: string, place: Place): LabelPart | null {
  const { key, teams: word, ids } = keyedOf(written);
  const teams = word ?? (place.hash ? HASHTAG_TEAMS.get(key) : undefined);
  if (teams !== undefined) return { kind: "team", teams };
  if (ids !== null) return { kind: "position", ids: idSet(ids) };
  if (written.includes(" ")) return null;
  const dotted = INITIALISM_RE.test(written);
  if (!dotted && written.includes(".")) return null;
  const bare = dotted ? written.replaceAll(".", "") : written;
  const abbreviation = ABBREVIATION_TEAMS.get(bare.toUpperCase());
  if (abbreviation !== undefined)
    return dotted || counts(bare, place) ? { kind: "team", teams: abbreviation } : null;
  const position = positionAbbreviation(bare);
  if (position === null) return null;
  return dotted || counts(position.stem, place)
    ? { kind: "position", ids: idSet(position.ids) }
    : null;
}

/**
 * Whether a written label form is an ordinary word there: a word of AMBIGUOUS_LABEL_WORDS ("safety"), or
 * an ordinary-word abbreviation written in lower or title case, which counts only right after a game or
 * move word (R8-7 (2)) and there is the ordinary word or a first name ("to Will Smith"). Right after a
 * blocker or a game or move word it labels no one; in capitals the abbreviation labels ("for MIN WR").
 */
function ambiguousForm(written: string): boolean {
  if (isAmbiguousLabelWord(written)) return true;
  const stem = positionAbbreviation(written)?.stem ?? written;
  return ORDINARY.has(stem.toUpperCase()) && !isCaps(stem);
}

/** Whether the scan finds a team or a position in a written form where it stands. */
const found = (written: string, place: Place): boolean => formAt(written, place) !== null;

/** Whether the scan finds a team or a position in a written word or several (folded), in mixed text. */
export function scanFinds(written: string): boolean {
  return scanText(foldText(written).text, null);
}

// ---------------------------------------------------------------------------------------------------
// The fold.

const APOSTROPHE_SET: ReadonlySet<string> = new Set(APOSTROPHES);
const DASH_SET: ReadonlySet<string> = new Set(DASHES);
const CONFUSABLE_MAP: ReadonlyMap<string, string> = new Map(Object.entries(CONFUSABLES));
const DASH_PUNCTUATION_RE = /^\p{Pd}$/u;
const MARK_RE = /\p{M}/gu;
const FOLD_CACHE = new Map<string, string>();
const FOLD_CACHE_MAX = 65_536;

/**
 * One code point folded: an apostrophe or a lookalike first (NFKD would decompose some lookalikes to
 * other letters: the lunate sigma to a final sigma), else NFKD with the marks stripped, then each
 * piece's apostrophe, dash or lookalike.
 */
function foldChar(c: string): string {
  const hit = FOLD_CACHE.get(c);
  if (hit !== undefined) return hit;
  let v = "";
  const look = CONFUSABLE_MAP.get(c);
  if (APOSTROPHE_SET.has(c)) v = "'";
  else if (look !== undefined) v = look;
  else
    for (const d of c.normalize("NFKD").replace(MARK_RE, ""))
      v += APOSTROPHE_SET.has(d)
        ? "'"
        : DASH_PUNCTUATION_RE.test(d) || DASH_SET.has(d)
          ? "-"
          : (CONFUSABLE_MAP.get(d) ?? d);
  if (FOLD_CACHE.size < FOLD_CACHE_MAX) FOLD_CACHE.set(c, v);
  return v;
}

/** A text folded, and where each offset of the original text lands in it. */
interface Folded {
  readonly text: string;
  /** `at[i]`: the folded offset of the original offset i (0 ≤ i ≤ the original's length). */
  readonly at: Int32Array;
}

/** The (sanitised) text folded one code point at a time, with its offset map. */
function foldText(text: string): Folded {
  const at = new Int32Array(text.length + 1);
  const out: string[] = [];
  let len = 0;
  for (let i = 0; i < text.length;) {
    const n = (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
    const f = foldChar(text.slice(i, i + n));
    at[i] = len;
    if (n === 2) at[i + 1] = len;
    out.push(f);
    len += f.length;
    i += n;
  }
  at[text.length] = len;
  return { text: out.join(""), at };
}

// ---------------------------------------------------------------------------------------------------
// Line and paragraph breaks: where the raw item had them before sanitizeText made them spaces.

/** The mark standing for a break in the marked copy of the raw text. */
const BREAK_MARK = "\u00B6";
const AMP_RE = /&amp;/giu;
const LT_RE = /&(?:lt|#0*60|#x0*3c);/giu;
const GT_RE = /&(?:gt|#0*62|#x0*3e);/giu;
/** A tag, opening or closing, as sanitizeText removes it (an attribute run of at most 512 characters). */
const TAG_RE = /<\/?[A-Za-z][^<>]{0,512}>/gu;
const LINE_RE = /\r\n?|[\n\v\f\u0085\u2028\u2029]/gu;
/** Levels of `&amp;` decoded before the tags are marked (sanitizeText's own bound). */
const MAX_DECODE = 8;

/**
 * The raw item with each line break and each HTML tag (as written, or entity-encoded) replaced by a
 * break mark, for sanitizeText; `breakOffsets` aligns its output with the sanitised text's.
 */
export function markBreaks(raw: string): string {
  let s = raw;
  for (let k = 0; k < MAX_DECODE && /&amp;/iu.test(s); k++) s = s.replace(AMP_RE, "&");
  s = s.replace(LT_RE, "<").replace(GT_RE, ">");
  return s.replace(TAG_RE, ` ${BREAK_MARK} `).replace(LINE_RE, ` ${BREAK_MARK} `);
}

/**
 * Where a break sits in the sanitised `text`: `out[i]` is 1 when one stands right before offset i.
 * `marked` is sanitizeText's output over `markBreaks(raw)`; the two are walked together, and the walk
 * stops where they part (past that, no break is known: as if none were written).
 */
function breakOffsets(text: string, marked: string): Uint8Array {
  const out = new Uint8Array(text.length + 1);
  let i = 0;
  let j = 0;
  while (j < marked.length) {
    const m = marked[j];
    if (m === BREAK_MARK && text[i] !== BREAK_MARK) {
      out[i] = 1;
      j++;
    } else if (i < text.length && text[i] === m) {
      i++;
      j++;
    } else if (m === " ") j++;
    else if (text[i] === " ") i++;
    else break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// The reading of one item.

/** Sorted, non-overlapping [start, end) spans of the sanitised text: persons' names. */
export type Spans = readonly (readonly [number, number])[];

/** At most this many words of a label are read on either side of a name (bounded work). */
const MAX_LABEL_WORDS = 6;
const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);
/** The characters that join the parts of one word in the folded text ("G-Men", "O'Connell", "L.A", "M&T"). */
const isJoiner = (c: string | undefined): boolean =>
  c === "'" || c === "." || c === "-" || c === "&";

/** The start of the word that ends at `end` (exclusive), or -1 when none does. */
function wordStartBefore(s: string, end: number): number {
  let i = end;
  while (i > 0) {
    if (isWordChar(s[i - 1])) i--;
    else if (isJoiner(s[i - 1]) && i < end && isWordChar(s[i]) && isWordChar(s[i - 2])) i--;
    else break;
  }
  return i < end ? i : -1;
}

/** The end of the word that starts at `start`, or -1 when none does. */
function wordEndAfter(s: string, start: number): number {
  let i = start;
  while (i < s.length) {
    if (isWordChar(s[i])) i++;
    else if (isJoiner(s[i]) && i > start && isWordChar(s[i - 1]) && isWordChar(s[i + 1])) i++;
    else break;
  }
  return i > start ? i : -1;
}

/** Whether [a, b) overlaps one of the sorted spans (a binary search). */
function overlaps(spans: Spans, a: number, b: number): boolean {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((spans[mid]?.[1] ?? 0) <= a) lo = mid + 1;
    else hi = mid;
  }
  const s = spans[lo];
  return s !== undefined && s[0] < b;
}

/** A form read before a name: its part, where it starts, as written, whether it is an ordinary word. */
interface FormHit {
  readonly part: LabelPart;
  readonly from: number;
  /** As written (folded: its words joined by single spaces, a period ending one cut). */
  readonly written: string;
  readonly ambiguous: boolean;
}

/** One item of a tag: its parts (a form, or the forms a hyphen joins) and the offset after it. */
interface TagItem {
  readonly parts: readonly LabelPart[];
  readonly end: number;
}

/** A label word or form read before a name, and where it starts. */
interface ReadPart {
  readonly part: LabelPart;
  readonly from: number;
  /** As written (folded: its words joined by single spaces, a period ending one cut). */
  readonly written: string;
  readonly possessive: boolean;
  readonly ambiguous: boolean;
}

/** How one item is read for its shared names (R8-6 (a), (b); R8-7; R8-8 (1)). */
export interface SharedReading {
  /** The label parts written next to the full name at [start, end) of the sanitised text (R8-6 (a)). */
  label(start: number, end: number): readonly LabelPart[];
  /**
   * The label parts of a surname's mention at [start, end) of the sanitised text (R8-7 (4)), apart: those
   * before it, and those in parentheses or the name tag after it. Every form labels it as it labels a
   * full name, but a one-word singular or place written without a possessive right before it, which may
   * be a person's first name ("Bill Johnson", "Charlotte Jones"): no label.
   */
  surnameSides(
    start: number,
    end: number,
  ): { readonly before: readonly LabelPart[]; readonly after: readonly LabelPart[] };
  /**
   * Whether [start, end) of the sanitised text lies inside a form of two words or more ("Allen Park",
   * "Halas Hall", "Gang Green", "Strong Safety"): a word of it is no surname.
   */
  inForm(start: number, end: number): boolean;
  /**
   * The segment the sanitised offset `at` lies in: the title and the blurb (joined by " | ") and the
   * parts a "|" or a line or paragraph break separates are numbered in order.
   */
  segment(at: number): number;
  /** Whether the item names any team or any position outside the spared spans (R8-6 (b)). */
  namesTeamOrPosition(): boolean;
}

/**
 * The reading of one item: `text` is its sanitised text; `marked` sanitizeText's output over
 * `markBreaks(raw)` (null when the raw text is not at hand: no break is known); `names` the persons'
 * full names in it (a word of one is never a label word); `spared` the spans the scan leaves out (the
 * matcher's: those names). All spans are sorted offsets of `text`.
 */
export function sharedReading(
  text: string,
  marked: string | null,
  names: Spans,
  spared: Spans,
): SharedReading {
  const { text: s, at } = foldText(text);
  const span = ([a, b]: readonly [number, number]): readonly [number, number] => [
    at[a] ?? 0,
    at[b] ?? 0,
  ];
  const nameSpans = names.map(span);
  // the breaks, in folded offsets
  const brk = new Uint8Array(s.length + 1);
  if (marked !== null) {
    const raw = breakOffsets(text, marked);
    for (let i = 0; i < raw.length; i++) if (raw[i] === 1) brk[at[i] ?? 0] = 1;
  }
  const { closes, caps, segments } = passOf(s, brk);
  /** Whether a break sits in the gap (a, b]. */
  const breakIn = (a: number, b: number): boolean => {
    for (let k = a + 1; k <= b; k++) if (brk[k] === 1) return true;
    return false;
  };
  const inName = (a: number, b: number): boolean => overlaps(nameSpans, a, b);
  const after = (from: number): boolean => afterGameWord(s, from);
  /**
   * The word right before offset `from`, lower case, or null when the clause opens there: at the
   * start, after a break or punctuation, after a period (one after CLAUSE_ABBREVIATIONS' "vs" and "v"
   * continues it).
   */
  const wordBefore = (from: number): string | null => {
    let e = from;
    while (e > 0 && s[e - 1] === " ") e--;
    if (e === from || breakIn(e, from)) return null;
    if (s[e - 1] === "@") return "@";
    const period = s[e - 1] === ".";
    if (period) e--;
    const b = wordStartBefore(s, e);
    if (b < 0) return null;
    const w = s.slice(b, e).toLowerCase();
    return period && !CLAUSE_ABBREVIATIONS.includes(w) ? null : w;
  };
  /**
   * The start of the word that ends at `end`, or -1. A period may end it when it is an initialism
   * ("L.A.'s Byron Young"), any word inside a form (`inner`: "St. Louis", "U.S. Bank"), or a state's
   * abbreviation that a possessive or another label word follows (`period`: "Tenn.'s Marcus Harris",
   * "Tenn. CB Marcus Harris"; right before the name its period may end the sentence: "…in Tenn.
   * Marcus Harris said"); any other word's period is punctuation ("…the Vikings. Justin Jefferson").
   */
  const startOf = (end: number, inner: boolean, period: boolean): number => {
    if (s[end - 1] !== ".") return wordStartBefore(s, end);
    const b = wordStartBefore(s, end - 1);
    if (b < 0) return -1;
    const w = s.slice(b, end - 1);
    return inner || INITIALISM_RE.test(w) || (period && STATE_ABBREVIATIONS.has(w.toUpperCase()))
      ? b
      : -1;
  };
  /** The word of [b, e) as written, a period ending it cut (an initialism keeps its inner ones). */
  const wordAt = (b: number, e: number): string =>
    s[e - 1] === "." ? s.slice(b, e - 1) : s.slice(b, e);
  /**
   * The words ending at `end` (whitespace, or a period and whitespace, between them; no break, no
   * name), last first, at most MAX_FORM_WORDS.
   */
  const wordsBefore = (
    end: number,
    period: boolean,
  ): { readonly start: number; readonly end: number }[] => {
    const out: { start: number; end: number }[] = [];
    let e = end;
    for (let n = 0; n < MAX_FORM_WORDS; n++) {
      const b = startOf(e, n > 0, period);
      if (b < 0 || inName(b, e)) break;
      out.push({ start: b, end: e });
      let g = b;
      while (g > 0 && s[g - 1] === " ") g--;
      if (g === b || g === 0 || breakIn(g, b)) break;
      e = g;
    }
    return out;
  };

  /**
   * The longest form ending at `end` (possessive cut), or null: its part, where it starts, as written,
   * and whether it is an ordinary word there (`ambiguousForm`).
   */
  const readFormEndingAt = (end: number, possessive: boolean, period: boolean): FormHit | null => {
    const words = wordsBefore(end, period);
    for (let n = words.length; n >= 1; n--) {
      const first = words[n - 1];
      if (first === undefined) continue;
      // a form of several words opens with a head, and its first two words with a pair (bounded work:
      // no lookup otherwise)
      if (n > 1) {
        const head = wordAt(first.start, first.end);
        const second = words[n - 2];
        if (!isHead(wordOf(head)) || second === undefined) continue;
        if (!opensPair(head, wordAt(second.start, second.end))) continue;
      }
      const from = first.start;
      const written = words
        .slice(0, n)
        .reverse()
        .map((w) => wordAt(w.start, w.end))
        .join(" ");
      const place: Place = {
        caps: caps[from] === 1,
        after: () => after(from),
        tag: false,
        hash: from > 0 && s[from - 1] === "#",
      };
      const part = labelFormAt(written, place);
      if (part === null || (possessive && part.kind === "position")) continue;
      return { part, from, written, ambiguous: ambiguousForm(written) };
    }
    return null;
  };
  /**
   * The forms read before names, by where they end (and how): each is read once per item. Adjacent
   * mentions read the same words, and a run of surnames that are each a form ("Brown Brown …", "Houston
   * Houston …") re-read its whole window per mention (ruling R8-8 (1): 20 times a benign item). The
   * index (allocated on first use) holds 0 for a read not yet made, else its place in the list, plus 1.
   */
  let endingIndex: Int32Array | null = null;
  const endings: (FormHit | null)[] = [];
  const formEndingAt = (end: number, possessive: boolean, period: boolean): FormHit | null => {
    // `period` is read only where the last word ends with one (`startOf`)
    const dotted = period && s[end - 1] === ".";
    const key = end * 4 + (possessive ? 2 : 0) + (dotted ? 1 : 0);
    endingIndex ??= new Int32Array(4 * (s.length + 1));
    const k = endingIndex[key] ?? 0;
    if (k > 0) return endings[k - 1] ?? null;
    const hit = readFormEndingAt(end, possessive, dotted);
    endingIndex[key] = endings.push(hit);
    return hit;
  };

  /** Where the label's last word ends before `pos`: its possessive cut. Null when no word ends there. */
  const labelEnd = (pos: number): { end: number; possessive: boolean } | null => {
    let end = pos;
    while (end > 0 && s[end - 1] === " ") end--;
    if (end === pos || end === 0 || breakIn(end, pos)) return null;
    // a possessive on the label's last word ("Browns'", "Cleveland's", "L.A.'S"); a quotation's
    // closing mark is punctuation
    if (s[end - 1] === "'") {
      if (closes[end - 1] === 1) return null;
      return { end: end - 1, possessive: true };
    }
    if ((s[end - 1] === "s" || s[end - 1] === "S") && s[end - 2] === "'")
      return { end: end - 2, possessive: true };
    return { end, possessive: false };
  };

  /**
   * The label parts directly before offset `start`, nearest first; `surname`: before a surname's
   * mention. Three rules only take a label away: a one-word singular or place without a possessive
   * right before a surname may be a person's first name ("Bill Johnson"); a label of teams alone with
   * no possessive must open its clause; an ordinary word right after a blocker or a game or move word
   * is the ordinary word.
   */
  const partsBefore = (start: number, surname: boolean): LabelPart[] => {
    const read: ReadPart[] = [];
    let pos = start;
    for (let n = 0; n < MAX_LABEL_WORDS; n++) {
      const le = labelEnd(pos);
      if (le === null) break;
      const hit = formEndingAt(le.end, le.possessive, le.possessive || n > 0);
      if (hit === null) break;
      read.push({
        part: hit.part,
        from: hit.from,
        written: hit.written,
        possessive: le.possessive,
        ambiguous: hit.ambiguous,
      });
      pos = hit.from;
    }
    const near = read[0];
    const left = read[read.length - 1];
    if (near === undefined || left === undefined) return [];
    // a first name ("Bill Johnson", "Charlotte Jones"): no label, and the surname is counted
    if (surname && !near.possessive && FIRST_NAME_FORMS.has(formKey(near.written))) return [];
    // teams alone (no possessive in the label, no position) must open their clause: a word right
    // before them makes them its object or its modifier ("Against the Vikings Justin Jefferson …",
    // "Browns beat Vikings Justin Jefferson …"); "the Kansas City Chiefs' Chris Jones" labels him
    const w = wordBefore(left.from);
    if (!read.some((x) => x.possessive) && read.every((x) => x.part.kind === "team") && w !== null)
      return [];
    // an ordinary word right after a blocker or a game or move word is the ordinary word ("After safety
    // …", "in the corner …", "to Will Smith"): no label
    if (left.ambiguous && w !== null && (LABEL_BLOCKERS.includes(w) || GAME_MOVE_WORDS.includes(w)))
      return [];
    return read.map((x) => x.part);
  };

  /** Where a possessive ("'s", "'") ends right after offset `end`; `end` itself when none follows. */
  const possessiveEnd = (end: number): number => {
    if (s[end] !== "'") return end;
    return (s[end + 1] === "s" || s[end + 1] === "S") && !isWordChar(s[end + 2])
      ? end + 2
      : end + 1;
  };
  /** Whether the period after the tag word [b, e) is the word's: an initialism's, a state's ("(Tenn.)"). */
  const ownPeriod = (b: number, e: number): boolean =>
    s[e] === "." &&
    (INITIALISM_RE.test(s.slice(b, e)) || STATE_ABBREVIATIONS.has(s.slice(b, e).toUpperCase()));

  /**
   * The tag item at offset `at` (a hashtag's "#" there): a form that is a team or a position (a
   * hashtag's teams among them), ending with its last word's own period and a possessive (a position
   * takes none), or forms a hyphen joins with no space ("(CLE-LB)"); null when none stands there.
   */
  const readItem = (at: number): TagItem | null => {
    const hash = s[at] === "#";
    const i = hash ? at + 1 : at;
    // the words starting here (spaces, or a period and spaces, only between: "St. Louis"; no break,
    // no name), at most MAX_FORM_WORDS: a second only when the first two may open a form of several
    // words (`isHead`, `opensPair`)
    const words: { readonly start: number; readonly end: number }[] = [];
    let b = i;
    for (let k = 0; k < MAX_FORM_WORDS; k++) {
      const e = wordEndAfter(s, b);
      if (e < 0 || inName(b, e)) break;
      const head = words[0];
      if (k === 1 && head !== undefined && !opensPair(s.slice(head.start, head.end), s.slice(b, e)))
        break;
      words.push({ start: b, end: e });
      if (k === 0 && !isHead(wordOf(s.slice(b, e)))) break;
      const d = s[e] === "." ? e + 1 : e;
      let g = d;
      while (s[g] === " ") g++;
      if (g === d || breakIn(e, g) || !isWordChar(s[g])) break;
      b = g;
    }
    if (words.length === 0) return null;
    for (let k = words.length; k >= 1; k--) {
      const last = words[k - 1];
      if (last === undefined) continue;
      // the item ends with its last word, and with that word's own period
      const end = ownPeriod(last.start, last.end) ? last.end + 1 : last.end;
      const pe = possessiveEnd(end);
      const written = words
        .slice(0, k)
        .map((w) => s.slice(w.start, w.end))
        .join(" ");
      const part = labelFormAt(written, {
        caps: caps[i] === 1,
        after: () => after(i),
        tag: true,
        hash,
      });
      if (part !== null && !(pe > end && part.kind === "position"))
        return { parts: [part], end: pe };
    }
    // items a hyphen joins with no space ("(CLE-LB)"): each a form
    const e = wordEndAfter(s, i);
    const written = s.slice(i, e);
    const pieces = written.includes("-") ? written.split("-") : [];
    const place: Place = { caps: caps[i] === 1, after: NEVER, tag: true, hash: false };
    const split = pieces.map((w) => formAt(w, place));
    if (split.length === 0 || !split.every((x) => x !== null)) return null;
    return { parts: split, end: possessiveEnd(e) };
  };
  /**
   * The tag items read, by offset: each is read once per item, as the forms before names are (the
   * tags after adjacent mentions read the same words; ruling R8-8 (1)). Indexed as `endings` is.
   */
  let itemIndex: Int32Array | null = null;
  const items: (TagItem | null)[] = [];
  const itemAt = (at: number): TagItem | null => {
    itemIndex ??= new Int32Array(s.length + 1);
    const k = itemIndex[at] ?? 0;
    if (k > 0) return items[k - 1] ?? null;
    const item = readItem(at);
    itemIndex[at] = items.push(item);
    return item;
  };

  /**
   * The items of a tag that opens at `from`, up to `close` (")" or ":"): forms that are each a team or
   * a position (a hashtag's teams among them), a separator or a space between them. Null when anything
   * else stands in it (a break too), or no item does.
   */
  const tagItems = (from: number, close: string): LabelPart[] | null => {
    const out: LabelPart[] = [];
    let i = from;
    for (let n = 0; n < MAX_LABEL_WORDS; n++) {
      const startGap = i;
      while (s[i] === " ") i++;
      if (breakIn(startGap, i)) return null;
      const item = itemAt(i);
      if (item === null) return null;
      out.push(...item.parts);
      i = item.end;
      let j = i;
      while (s[j] === " ") j++;
      if (breakIn(i, j)) return null;
      if (s[j] === close) return out;
      if (LABEL_SEPARATORS.includes(s[j] ?? "_")) {
        i = j + 1;
        continue;
      }
      if (j > i && (isWordChar(s[j]) || s[j] === "#")) {
        i = j;
        continue;
      }
      return null;
    }
    return null;
  };

  /** The label parts in parentheses directly after offset `end` ("(CLE - LB)", "(LB, Browns)"). */
  const partsInParentheses = (end: number): LabelPart[] => {
    let i = end;
    while (i < s.length && i - end < 2 && s[i] === " ") i++;
    if (s[i] !== "(" || breakIn(end, i)) return [];
    return tagItems(i + 1, ")") ?? [];
  };

  /** The label parts of the headline's name tag after offset `end`, before its colon. */
  const partsInNameTag = (end: number): LabelPart[] => {
    let i = end;
    while (s[i] === " ") i++;
    if (breakIn(end, i)) return [];
    if (LABEL_SEPARATORS.includes(s[i] ?? "_")) i++;
    else if (i === end) return [];
    return tagItems(i, ":") ?? [];
  };

  let scanned: boolean | null = null;
  const scan = (): boolean => {
    // the folded text with the spared spans (persons' names) blanked, offsets kept
    const chars = s.split("");
    for (const [a, b] of spared.map(span)) for (let k = a; k < b; k++) chars[k] = " ";
    return scanText(chars.join(""), { s, caps });
  };
  /** A word's last part as the multi-word reading keys it ("U.S" → "US", "Mercedes-Benz" → "Benz"). */
  const lastPart = (w: string): string =>
    INITIALISM_RE.test(w)
      ? wordOf(w)
      : (w
          .split(/[.-]/u)
          .filter((x) => x.length > 0)
          .at(-1) ?? "");
  /**
   * Whether a form of several words may hold [a, b): the word's last part, or one of the words right
   * before it, may open one (a form's first word is its own or one of the MAX_FORM_WORDS - 1 before).
   * A pre-check for speed: where it fails, no form holds the word.
   */
  const opens = (w: string): boolean => isHead(wordOf(w)) || isHead(lastPart(w));
  const headNear = (a: number, b: number): boolean => {
    if (opens(s.slice(a, b))) return true;
    let e = a;
    for (let n = 1; n < MAX_FORM_WORDS; n++) {
      let g = e;
      while (g > 0 && s[g - 1] === " ") g--;
      if (g === e || g === 0) return false;
      if (s[g - 1] === ".") g--;
      const st = wordStartBefore(s, g);
      if (st < 0) return false;
      if (opens(s.slice(st, g))) return true;
      e = st;
    }
    return false;
  };
  /** Which offsets lie inside a form of several words: one pass over the item, read when first asked. */
  let phrases: Uint8Array | null = null;
  const sides = (start: number, end: number, surname: boolean) => {
    const [a, b] = span([start, end]);
    return {
      before: partsBefore(a, surname),
      after: [...partsInParentheses(b), ...partsInNameTag(b)],
    };
  };
  return {
    label: (start, end) => {
      const { before, after: behind } = sides(start, end, false);
      return [...before, ...behind];
    },
    surnameSides: (start, end) => sides(start, end, true),
    inForm: (start, end) => {
      const [a, b] = span([start, end]);
      if (!headNear(a, b)) return false;
      phrases ??= phraseSpans(s);
      for (let k = a; k < b; k++) if (phrases[k] === 1) return true;
      return false;
    },
    segment: (pos) => segments[at[pos] ?? 0] ?? 0,
    namesTeamOrPosition: () => (scanned ??= scan()),
  };
}

/**
 * One pass over the folded text: which apostrophes close a quotation opened in their segment, which
 * offsets lie in a segment written all in capitals, and each offset's segment.
 */
function passOf(
  s: string,
  brk: Uint8Array,
): { closes: Uint8Array; caps: Uint8Array; segments: Int32Array } {
  const boundary = (k: number): boolean => brk[k] === 1 || s[k] === "|";
  const closes = new Uint8Array(s.length);
  const caps = new Uint8Array(s.length + 1);
  const segments = new Int32Array(s.length + 1);
  let seg = 0;
  let open = 0;
  let segStart = 0;
  let lower = false;
  let upper = false;
  const flush = (end: number): void => {
    if (upper && !lower) caps.fill(1, segStart, end);
  };
  for (let k = 0; k < s.length; k++) {
    if (boundary(k)) {
      open = 0;
      flush(k);
      segStart = k;
      lower = false;
      upper = false;
      seg++;
    }
    segments[k] = seg;
    const c = s[k] ?? "";
    const code = c.charCodeAt(0);
    if (code < 128) {
      // ASCII, the common case, by its code
      if (code >= 97 && code <= 122) lower = true;
      else if (code >= 65 && code <= 90) upper = true;
    } else if (isLower(c)) lower = true;
    else if (isUpper(c)) upper = true;
    if (c !== "'") continue;
    const prevW = isWordChar(s[k - 1]);
    const nextW = isWordChar(s[k + 1]);
    if (!prevW && nextW) open++;
    else if (prevW && !nextW && open > 0) {
      closes[k] = 1;
      open--;
    }
  }
  flush(s.length);
  segments[s.length] = seg;
  return { closes, caps, segments };
}

/**
 * Whether the word at offset `i` of the folded text stands directly after a game or move word
 * (GAME_MOVE_WORDS; whitespace between, "vs" and "v" with their period, "@" glued or spaced).
 */
function afterGameWord(s: string, i: number): boolean {
  let k = i;
  while (k > 0 && s[k - 1] === " ") k--;
  if (k === 0) return false;
  if (s[k - 1] === "@") return GAME_MOVE_WORDS.includes("@");
  const period = s[k - 1] === ".";
  const e = period ? k - 1 : k;
  const b = wordStartBefore(s, e);
  if (b < 0) return false;
  const w = `${s.slice(b, e).toLowerCase()}${period ? "." : ""}`;
  return GAME_MOVE_WORDS.includes(w);
}

// ---------------------------------------------------------------------------------------------------
// The scan.

/** One word as the scan reads it: letters and digits, joined inside by an apostrophe, a period, an ampersand or a hyphen. */
const SCAN_WORD_RE = /[\p{L}\p{N}]+(?:['.&-][\p{L}\p{N}]+)*/gu;
/**
 * What may stand between the words of a form: whitespace, a period before it ("St. Louis"), or a slash
 * ("D/ST").
 */
const PAIR_GAP_RE = /^(?:\.?\s+|\/)$/u;
/** A lower-case letter followed by a capital: a camel-cased word ("ClevelandBrowns", "CLEvsMIN"). */
const CAMEL_RE = /\p{Ll}\p{Lu}/u;

/**
 * The pieces of a compound read as words: each run of two capitals or more ("CLE", "MIN"), that run
 * less its last capital when a lower-case letter follows it ("KC" of "KCChiefs"), each capital with
 * the lower-case letters after it ("Chiefs", "Bear" of "BearDown"), and each number with them ("12s").
 */
function segmentsOf(piece: string): string[] {
  const out: string[] = [];
  const runs = [...piece.matchAll(/\p{Lu}+|\p{Ll}+|\p{N}+/gu)].map((m) => m[0]);
  for (let k = 0; k < runs.length; k++) {
    const r = runs[k] ?? "";
    const next = runs[k + 1] ?? "";
    const lowerNext = next !== "" && isLower(next.slice(0, 1));
    if (/^\p{N}/u.test(r)) {
      if (lowerNext) out.push(`${r}${next}`);
      continue;
    }
    if (!isUpper(r.slice(0, 1))) continue;
    if (r.length >= 2) out.push(r);
    if (r.length >= 3 && lowerNext) out.push(r.slice(0, -1));
    if (lowerNext) out.push(`${r.slice(-1)}${next}`);
  }
  return out;
}

/** What a compound holds: the teams it names, and whether a segment of it is a position. */
interface CompoundRead {
  readonly teams: ReadonlySet<NflTeam>;
  readonly position: boolean;
}

/**
 * What a compound (a handle, a hashtag, a domain, a camel-cased word) holds: each segment of it read as
 * a word where it stands (the first right after "@" stands after a game word: "@Min"), and each team
 * word form of four letters or more anywhere in it ("kcchiefs.com"); inside a hashtag, a team's own
 * hashtag and the three-letter forms too ("#clevsmin"). The scan finds what it holds; a hashtag's teams
 * label a name (R8-7 (3): "#ChiefsKingdom Chris Jones").
 */
function compoundRead(word: string, hashtag: boolean, place: Place): CompoundRead {
  const teams = new Set<NflTeam>();
  let position = false;
  const w = word.slice(0, MAX_COMPOUND);
  let first = true;
  for (const piece of w.split(/[.&-]/u))
    for (const seg of segmentsOf(piece)) {
      const part = formAt(seg, { ...place, after: first ? place.after : NEVER, hash: hashtag });
      if (part?.kind === "team") for (const t of part.teams) teams.add(t);
      else if (part !== null) position = true;
      first = false;
    }
  const lower = w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  trieTeams(COMPOUND_TRIE, lower, teams);
  if (hashtag) trieTeams(HASHTAG_TRIE, lower, teams);
  return { teams, position };
}

/**
 * A label form where it stands: what `formAt` reads, or a hashtag's teams (one word after "#", as the
 * scan reads it).
 */
function labelFormAt(written: string, place: Place): LabelPart | null {
  const part = formAt(written, place);
  if (part !== null || !place.hash || written.includes(" ")) return part;
  const { teams } = compoundRead(written, true, place);
  return teams.size > 0 ? { kind: "team", teams: freezeTeams([...teams]) } : null;
}

/** The first words of every form of several words: a run opening with any other word is none. */
const PHRASE_HEADS: ReadonlySet<string> = new Set([
  ...[...WORD_TEAMS.keys()].filter((k) => k.includes(" ")).map((k) => k.split(" ")[0] ?? ""),
  ...POSITION_PHRASE_HEADS,
]);

const HEAD_CACHE = new Map<string, boolean>();
/** Whether a word may open a form of several words (remembered, bounded). */
const isHead = (word: string | undefined): boolean => {
  if (word === undefined) return false;
  const hit = HEAD_CACHE.get(word);
  if (hit !== undefined) return hit;
  const head = PHRASE_HEADS.has(word.toLowerCase().replaceAll("'", ""));
  if (HEAD_CACHE.size < KEYED_CACHE_MAX) HEAD_CACHE.set(word, head);
  return head;
};

/** The first two words of every team form of several words ("green bay", "valley of"). */
const TEAM_PHRASE_PAIRS: ReadonlySet<string> = new Set(
  [...WORD_TEAMS.keys()]
    .filter((k) => k.includes(" "))
    .map((k) => k.split(" ").slice(0, 2).join(" ")),
);
const PAIR_CACHE = new Map<string, boolean>();
/**
 * Whether two written words (folded, as a reader joins them) may open a form of several words: their
 * key is the first two words of a team's or a position's (remembered, bounded). A pre-check for speed,
 * as `isHead` is (ruling R8-8 (1): a run of form heads, "Ford Ford …", tried every longer form at each
 * word): a form's key opens with its first two words' key, so where they open none, no form of several
 * words opens with them.
 */
const opensPair = (first: string, second: string): boolean => {
  const written = `${first} ${second}`;
  const hit = PAIR_CACHE.get(written);
  if (hit !== undefined) return hit;
  const { key } = keyedOf(written);
  const opens = TEAM_PHRASE_PAIRS.has(key) || opensPositionPhrase(key);
  if (PAIR_CACHE.size < KEYED_CACHE_MAX) PAIR_CACHE.set(written, opens);
  return opens;
};

/** Whether words in a row (folded) are a word form of several words: a team's or a position's. */
function phraseFound(words: readonly string[]): boolean {
  const { teams, ids } = keyedOf(words.join(" "));
  return teams !== undefined || ids !== null;
}

/**
 * The ways a word may end a form of several words: each run of its parts from the first, hyphenated
 * ("people-eaters" of "people-eaters-led"), and itself whole.
 */
const headsOf = (base: string, parts: readonly string[]): string[] =>
  parts.length === 1
    ? [parts[0] ?? ""]
    : [
        ...new Set([
          ...parts.slice(0, MAX_FORM_WORDS - 1).map((_, k) => parts.slice(0, k + 1).join("-")),
          ...(parts.length < MAX_FORM_WORDS ? [base] : []),
        ]),
      ];
/** The ways a word may open one: itself whole, and each run of its parts to the last ("ex-Green"). */
const leadsOf = (whole: string, parts: readonly string[]): string[] =>
  (parts.length === 1
    ? [whole]
    : [
        ...new Set([
          ...(parts.length < MAX_FORM_WORDS ? [whole] : []),
          ...parts.slice(-(MAX_FORM_WORDS - 1)).map((_, k, tail) => tail.slice(k).join("-")),
        ]),
      ]
  ).filter(isHead);

/** A word the multi-word reading remembers: as written (a hyphenated one whole), its leads, where. */
interface Recent {
  readonly whole: string;
  /** The ways it may open a form (`leadsOf`: only those that open one). */
  readonly leads: readonly string[];
  readonly start: number;
}

/**
 * How many remembered words open a form of several words that ends with one of `heads` (the next word,
 * whole or by its first part: "Valley of the-Sun", "Bank of America-led"), the longest first; 0 when
 * none. A form's middle words are read whole ("Monsters-of the Midway"), its first word whole or by a
 * run of its last parts ("ex-Green Bay").
 */
function windowFound(recent: readonly Recent[], heads: readonly string[]): number {
  for (let n = recent.length; n >= 1; n--) {
    const first = recent[recent.length - n];
    if (first === undefined || first.leads.length === 0) continue;
    const rest = recent.slice(recent.length - n + 1).map((r) => r.whole);
    const second = rest[0];
    for (const lead of first.leads) {
      if (second !== undefined && !opensPair(lead, second)) continue;
      if (heads.some((h) => phraseFound([lead, ...rest, h]))) return n;
    }
  }
  return 0;
}

/** The context of a scan: the folded text with nothing blanked, and its all-capitals segments. */
interface ScanContext {
  readonly s: string;
  readonly caps: Uint8Array;
}

/**
 * Whether the scan finds a team or a position in a folded text (`t`: names blanked, offsets kept;
 * `ctx`: the unblanked text and its all-capitals segments, null for a text of mixed case): each word
 * whole where it stands, a compound's segments and the team forms inside it, the parts a hyphen, a
 * period or an ampersand joins (each alone, each run of two to four, and glued: "wide-out",
 * "full-back", "new-era-field-led"), and the forms of two to four words in a row ("Green Bay", "running
 * back", "St. Louis", "Bank of America").
 */
function scanText(t: string, ctx: ScanContext | null): boolean {
  const s = ctx?.s ?? t;
  const placeAt = (i: number, lead: string): Place => ({
    caps: ctx?.caps[i] === 1,
    after: () => afterGameWord(s, i),
    tag: false,
    hash: lead === "#",
  });
  let prevEnd = 0;
  const recent: Recent[] = [];
  for (const m of t.matchAll(SCAN_WORD_RE)) {
    const w = m[0];
    const i = m.index;
    const lead = i > 0 ? (t[i - 1] ?? "") : "";
    // a possessive ("Jefferson's", "RAVEN'S") is the word without it
    const base = w.length > 2 && /'[sS]$/u.test(w) ? w.slice(0, -2) : w;
    const initialism = INITIALISM_RE.test(base);
    const place = placeAt(i, lead);
    if (found(base, place)) return true;
    const hashtag = lead === "#";
    const compound =
      hashtag || lead === "@" || (!initialism && base.includes(".")) || CAMEL_RE.test(base);
    if (compound) {
      const read = compoundRead(base, hashtag, place);
      if (read.teams.size > 0 || read.position) return true;
    }
    const parts =
      !initialism && /[.-]/u.test(base)
        ? base.split(/[.-]/u).filter((p) => p.length > 0)
        : [wordOf(base)];
    const quiet: Place = { ...place, after: NEVER };
    for (let k = 0; parts.length > 1 && k < parts.length; k++) {
      const p = parts[k] ?? "";
      const q = parts[k - 1];
      const here =
        k === 0
          ? place
          : { ...quiet, after: () => GAME_MOVE_WORDS.includes(q?.toLowerCase() ?? "") };
      if (found(p, here)) return true;
      if (
        q !== undefined &&
        (found(`${q}-${p}`, quiet) || found(`${q} ${p}`, quiet) || found(`${q}${p}`, quiet))
      )
        return true;
    }
    for (const p of parts)
      if (p.includes("&") && p.split("&").some((x) => x.length > 0 && found(x, quiet))) return true;
    if (parts.length > 2 && found(parts.join(""), quiet)) return true;
    // a run of three or four parts inside one word ("new-era-field-led", "city-of-angels")
    for (let len = 3; len <= Math.min(MAX_FORM_WORDS, parts.length); len++)
      for (let k = 0; k + len <= parts.length; k++)
        if (found(parts.slice(k, k + len).join("-"), quiet)) return true;
    // a form of two to four words across the gaps ("Green Bay", "running back", "St. Louis")
    if (!PAIR_GAP_RE.test(t.slice(prevEnd, i))) recent.length = 0;
    if (windowFound(recent, headsOf(base, parts)) !== 0) return true;
    const whole = parts.length > 1 ? base : wordOf(base);
    recent.push({ whole, leads: leadsOf(whole, parts), start: i });
    if (recent.length >= MAX_FORM_WORDS) recent.shift();
    prevEnd = i + w.length;
  }
  return false;
}

/**
 * Which offsets of the folded text lie inside a form of two words or more (`SharedReading.inForm`):
 * one pass, each word tried as the last of a form of up to MAX_FORM_WORDS words.
 */
function phraseSpans(s: string): Uint8Array {
  const out = new Uint8Array(s.length + 1);
  let prevEnd = 0;
  const recent: Recent[] = [];
  for (const m of s.matchAll(SCAN_WORD_RE)) {
    const w = m[0];
    const i = m.index;
    const base = w.length > 2 && /'[sS]$/u.test(w) ? w.slice(0, -2) : w;
    const initialism = INITIALISM_RE.test(base);
    const parts =
      !initialism && /[.-]/u.test(base)
        ? base.split(/[.-]/u).filter((p) => p.length > 0)
        : [wordOf(base)];
    if (!PAIR_GAP_RE.test(s.slice(prevEnd, i))) recent.length = 0;
    const n = windowFound(recent, headsOf(base, parts));
    const from = recent[recent.length - n];
    if (n !== 0 && from !== undefined) out.fill(1, from.start, i + w.length);
    const whole = parts.length > 1 ? base : wordOf(base);
    recent.push({ whole, leads: leadsOf(whole, parts), start: i });
    if (recent.length >= MAX_FORM_WORDS) recent.shift();
    prevEnd = i + w.length;
  }
  return out;
}
