// forms.ts — the news matcher's closed lists, written out once for the tests (src/sources/news/
// labels.ts, positions.ts, teams.ts, match.ts; rulings R8-6, R8-7 and R8-8, docs/plan/changelog.md
// §R8). Each literal
// is the source's list word for word (match-r86.test.ts and positions.test.ts compare them), and the
// behaviour tests iterate these literals, so an entry deleted from the source fails a behaviour test as
// well as the word-for-word one. Not a test file: it is imported.
import type { NflTeam } from "../../../src/config/schema.js";

// prettier-ignore
export const TEAM_NICKNAMES: Readonly<Record<string, NflTeam>> = {
  Cardinals: "ARI", Falcons: "ATL", Ravens: "BAL", Bills: "BUF", Panthers: "CAR", Bears: "CHI",
  Bengals: "CIN", Browns: "CLE", Cowboys: "DAL", Broncos: "DEN", Lions: "DET", Packers: "GB",
  Texans: "HOU", Colts: "IND", Jaguars: "JAX", Jags: "JAX", Chiefs: "KC", Rams: "LA",
  Chargers: "LAC", Raiders: "LV", Dolphins: "MIA", Vikings: "MIN", Patriots: "NE", Pats: "NE",
  Saints: "NO", Giants: "NYG", Jets: "NYJ", Eagles: "PHI", Steelers: "PIT", Seahawks: "SEA",
  "49ers": "SF", Niners: "SF", Buccaneers: "TB", Bucs: "TB", Titans: "TEN", Commanders: "WAS",
};
// prettier-ignore
export const TEAM_HOMES: Readonly<Record<string, NflTeam>> = {
  Arizona: "ARI", Atlanta: "ATL", Baltimore: "BAL", Buffalo: "BUF", Carolina: "CAR",
  Chicago: "CHI", Cincinnati: "CIN", Cleveland: "CLE", Dallas: "DAL", Denver: "DEN",
  Detroit: "DET", "Green Bay": "GB", Houston: "HOU", Indianapolis: "IND", Indy: "IND",
  Jacksonville: "JAX", "Kansas City": "KC", "Las Vegas": "LV", Miami: "MIA", Minnesota: "MIN",
  "New England": "NE", "New Orleans": "NO", Philadelphia: "PHI", Philly: "PHI",
  Pittsburgh: "PIT", Seattle: "SEA", "San Francisco": "SF", "Tampa Bay": "TB", Tennessee: "TEN",
  Washington: "WAS",
};
export const SHARED_HOMES: Readonly<Record<string, readonly NflTeam[]>> = {
  "Los Angeles": ["LA", "LAC"],
  "New York": ["NYG", "NYJ"],
};
// prettier-ignore
export const TEAM_SHORT_NAMES: Readonly<Record<string, NflTeam>> = {
  Vikes: "MIN", Fins: "MIA", Phins: "MIA", Bolts: "LAC", Pack: "GB", Hawks: "SEA", Cards: "ARI",
  "G-Men": "NYG", Cincy: "CIN", Vegas: "LV", "Big Blue": "NYG", "Gang Green": "NYJ", Jints: "NYG",
  Brownies: "CLE", Stillers: "PIT", Commies: "WAS", Donkeys: "DEN", Bungles: "CIN",
};
// prettier-ignore
export const TEAM_SINGULARS: Readonly<Record<string, NflTeam>> = {
  Cardinal: "ARI", Falcon: "ATL", Raven: "BAL", Bill: "BUF", Panther: "CAR", Bear: "CHI",
  Bengal: "CIN", Brown: "CLE", Cowboy: "DAL", Bronco: "DEN", Lion: "DET", Packer: "GB",
  Texan: "HOU", Colt: "IND", Jaguar: "JAX", Jag: "JAX", Chief: "KC", Ram: "LA", Charger: "LAC",
  Bolt: "LAC", Raider: "LV", Dolphin: "MIA", Fin: "MIA", Phin: "MIA", Viking: "MIN", Vike: "MIN",
  Patriot: "NE", Pat: "NE", Saint: "NO", Giant: "NYG", Jet: "NYJ", Eagle: "PHI", Steeler: "PIT",
  Seahawk: "SEA", "49er": "SF", Niner: "SF", Buccaneer: "TB", Buc: "TB", Titan: "TEN",
  Commander: "WAS",
};
// prettier-ignore
export const TEAM_CITIES: Readonly<Record<string, readonly NflTeam[]>> = {
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
};
// prettier-ignore
export const TEAM_STADIUMS: Readonly<Record<string, readonly NflTeam[]>> = {
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
};
// prettier-ignore
export const TEAM_FACILITIES: Readonly<Record<string, readonly NflTeam[]>> = {
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
};
// prettier-ignore
export const TEAM_HASHTAGS: Readonly<Record<string, NflTeam>> = {
  BirdCityFootball: "ARI", BeRedSeeRed: "ARI", RiseUp: "ATL", InBrotherhood: "ATL",
  KeepPounding: "CAR", ForTheShoe: "IND", WhoseHouse: "LA", TogetherBlue: "NYG", TakeFlight: "NYJ",
  HereWeGo: "PIT", FTTB: "SF", SiegeTheDay: "TB", HTTC: "WAS", HTTR: "WAS", RaiseHail: "WAS",
};
// prettier-ignore
export const TEAM_FAN_NAMES: Readonly<Record<string, readonly NflTeam[]>> = {
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
};
// prettier-ignore
export const TEAM_LEGACY_NAMES: Readonly<Record<string, readonly NflTeam[]>> = {
  Oilers: ["TEN"], Redskins: ["WAS"], Skins: ["WAS"], "Football Team": ["WAS"], Oakland: ["LV"],
  "San Diego": ["LAC"], "St Louis": ["LA"], "Saint Louis": ["LA"],
};
// prettier-ignore
export const TEAM_ABBREVIATIONS: Readonly<Record<string, readonly NflTeam[]>> = {
  ARI: ["ARI"], ARZ: ["ARI"], CRD: ["ARI"], ATL: ["ATL"], BAL: ["BAL"], BLT: ["BAL"], RAV: ["BAL"],
  BUF: ["BUF"], CAR: ["CAR"], CHI: ["CHI"], CIN: ["CIN"], CLE: ["CLE"], CLV: ["CLE"], DAL: ["DAL"],
  DEN: ["DEN"], DET: ["DET"], GB: ["GB"], GNB: ["GB"], GBP: ["GB"], HOU: ["HOU"], HST: ["HOU"],
  HTX: ["HOU"], IND: ["IND"], CLT: ["IND"], JAX: ["JAX"], JAC: ["JAX"], KC: ["KC"], KAN: ["KC"],
  KCC: ["KC"], LA: ["LA"], LAR: ["LA"], LAC: ["LAC"], LV: ["LV"], LVR: ["LV"], RAI: ["LV"],
  MIA: ["MIA"], MIN: ["MIN"], NE: ["NE"], NWE: ["NE"], NEP: ["NE"], NO: ["NO"], NOR: ["NO"],
  NOS: ["NO"], NYG: ["NYG"], NYJ: ["NYJ"], NY: ["NYG", "NYJ"], PHI: ["PHI"], PIT: ["PIT"],
  SEA: ["SEA"], SF: ["SF"], SFO: ["SF"], TB: ["TB"], TAM: ["TB"], TBB: ["TB"], TEN: ["TEN"],
  OTI: ["TEN"], WAS: ["WAS"], WSH: ["WAS"],
};
// prettier-ignore
export const TEAM_LEGACY_ABBREVIATIONS: Readonly<Record<string, readonly NflTeam[]>> = {
  OAK: ["LV"], SD: ["LAC"], SDG: ["LAC"], STL: ["LA"], PHX: ["ARI"], PHO: ["ARI"], WFT: ["WAS"],
  BOS: ["NE"],
};
// prettier-ignore
export const TEAM_STATE_ABBREVIATIONS: Readonly<Record<string, readonly NflTeam[]>> = {
  AZ: ["ARI"], ARIZ: ["ARI"], GA: ["ATL"], MD: ["BAL", "WAS"], NC: ["CAR"], IL: ["CHI"],
  ILL: ["CHI"], OH: ["CIN", "CLE"], TX: ["DAL", "HOU"], CO: ["DEN"], COLO: ["DEN"], MI: ["DET"],
  MICH: ["DET"], WI: ["GB"], WIS: ["GB"], IN: ["IND"], FL: ["JAX", "MIA", "TB"],
  FLA: ["JAX", "MIA", "TB"], MO: ["KC"], CA: ["LA", "LAC", "SF"], CALIF: ["LA", "LAC", "SF"],
  NV: ["LV"], NEV: ["LV"], MN: ["MIN"], MINN: ["MIN"], MA: ["NE"], MASS: ["NE"],
  NJ: ["NYG", "NYJ"], PA: ["PHI", "PIT"], WA: ["SEA"], WASH: ["SEA"], TN: ["TEN"], TENN: ["TEN"],
  VA: ["WAS"], DC: ["WAS"],
};
// prettier-ignore
export const ORDINARY_WORD_ABBREVIATIONS: readonly string[] = [
  "ARI", "CAR", "CHI", "DAL", "DEN", "JAC", "LA", "LAC", "MIA", "MIN", "NO", "NOR", "NOS", "OAK",
  "PHI", "PHO", "PIT", "RAI", "SEA", "TAM", "TEN", "WAS",
  "CO", "ILL", "IN", "MA", "MASS", "MI", "MO", "OH", "PA", "WASH", "WI",
  "C", "DE", "DI", "ED", "EDGE", "G", "K", "LT", "MIKE", "OL", "P", "S", "SAM", "ST", "WILL",
];
// prettier-ignore
export const GAME_MOVE_WORDS: readonly string[] = [
  "vs", "vs.", "v.", "@", "at", "against", "by", "from", "for", "to", "with", "visits", "hosts",
  "faces",
];
// prettier-ignore
export const CONFUSABLES: Readonly<Record<string, string>> = {
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
export const APOSTROPHES = ["’", "‘", "‛", "ʼ", "ʻ", "`", "´", "′"];
export const DASHES = ["−"];
export const LABEL_SEPARATORS = [",", "-", "/"];
// prettier-ignore
export const LABEL_BLOCKERS = [
  "a", "about", "above", "across", "after", "along", "amid", "among", "an", "around", "as",
  "before", "behind", "beside", "between", "beyond", "despite", "during", "facing", "in", "inside",
  "into", "like", "near", "of", "off", "on", "onto", "outside", "over", "past", "per", "since",
  "than", "the", "through", "toward", "towards", "under", "until", "upon", "v", "versus", "via",
  "within", "without",
];
export const CLAUSE_ABBREVIATIONS = ["v", "vs"];

export const QB = [1];
export const RB = [2];
export const WR = [3];
export const TE = [4];
export const K = [5];
export const P = [7];
export const DT = [9];
export const DE = [10];
export const LB = [11];
export const CB = [12];
export const S = [13];
export const DL = [9, 10];
export const EDGE = [10, 11];
export const FRONT = [9, 10, 11];
export const DB = [12, 13];
export const ROVER = [11, 12, 13];
export const DEFENSE = [9, 10, 11, 12, 13];
export const RETURNER = [2, 3, 12, 13];
export const GUNNER = [3, 12, 13];
export const CATCHER = [2, 3, 4];
export const BACK = [2, 3];
export const H_BACK = [2, 4];
export const SLOT = [3, 12];
export const CORPS = [3, 4];
export const BACKFIELD = [1, 2, 12, 13];
export const HOLDER = [1, 7];
export const SPECIALIST = [5, 7];
export const ANY = [1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13];
export const OL: number[] = [];
export const TEAM_UNIT: number[] = [];
// prettier-ignore
export const POSITION_ABBREVIATIONS: Readonly<Record<string, readonly number[]>> = {
  QB, RB, HB: RB, FB: RB, WR, SE: WR, TE, K, PK: K, P,
  DT, NT: DT, NG: DT, LDT: DT, RDT: DT, DE, LDE: DE, RDE: DE, DL, IDL: DL, DI: DL,
  EDGE, ED: EDGE, OLB: EDGE, LOLB: EDGE, ROLB: EDGE, WILL: EDGE, SAM: EDGE,
  LB, ILB: LB, MLB: LB, WLB: LB, SLB: LB, LILB: LB, RILB: LB, MIKE: LB,
  CB, RCB: CB, LCB: CB, NCB: CB, S, FS: S, SS: S, SAF: S, NB: DB, DB,
  KR: RETURNER, PR: RETURNER, ST: ANY, ATH: ANY,
  OL, OT: OL, OG: OL, G: OL, C: OL, LT: OL, RT: OL, LG: OL, RG: OL, IOL: OL, LS: OL,
  HC: TEAM_UNIT, TQB: TEAM_UNIT,
};
// prettier-ignore
export const POSITION_WORDS: Readonly<Record<string, readonly number[]>> = {
  "quarter back": QB, "signal caller": QB,
  "running back": RB, "half back": RB, "tail back": RB, "full back": RB,
  receiver: WR, "wide out": WR, "wide receiver": WR, "slot receiver": WR, flanker: WR,
  "split end": WR,
  "tight end": TE,
  kicker: K, "place kicker": K, punter: P,
  "defensive tackle": DT, "nose tackle": DT, "nose guard": DT, "d tackle": DT, nose: DT,
  "defensive end": DE, "d end": DE,
  "line man": DL, "d line man": DL, "defensive line man": DL, tackle: DL,
  "d line": DL, "defensive line": DL, "defensive interior": DL,
  "edge rusher": EDGE, "outside line backer": EDGE, backer: EDGE, "line backing": EDGE,
  "line backer": LB, "inside line backer": LB, "middle line backer": LB, "off ball": LB,
  "pass rusher": FRONT, rusher: FRONT, "pass rush": FRONT, "defensive front": FRONT,
  "front seven": FRONT, "weak side": FRONT, "strong side": FRONT,
  "corner back": CB, corner: CB, "slot corner": CB,
  safety: S, "free safety": S, "strong safety": S,
  "nickel back": DB, "defensive back": DB, nickel: DB, dime: DB, "dime back": DB, secondary: DB,
  rover: ROVER,
  defender: DEFENSE, "defensive player": DEFENSE, tackler: DEFENSE,
  returner: RETURNER, "return man": RETURNER, gunner: GUNNER,
  "pass catcher": CATCHER, "wing back": BACK, "slot back": BACK, "scat back": BACK,
  "h back": H_BACK, slot: SLOT, "receiving corps": CORPS, "back field": BACKFIELD,
  holder: HOLDER, specialist: SPECIALIST, "special teams": ANY, "special teamer": ANY,
  "offensive line man": OL, "offensive line": OL, "o line": OL, guard: OL, center: OL,
  centre: OL, snapper: OL, "long snapper": OL,
  "head coach": TEAM_UNIT, "d st": TEAM_UNIT,
};
// prettier-ignore
export const AMBIGUOUS_LABEL_WORDS = [
  "back field", "corner", "dime", "gunner", "holder", "nickel", "nose", "rover", "safety",
  "secondary", "slot", "specialist", "tackle",
];

/** match.ts' LEAD_WORDS: capitalised words that may stand next to a surname one universe player holds. */
// prettier-ignore
export const LEAD_WORDS: readonly string[] = [
  "qb", "rb", "wr", "te", "k", "p", "fb", "lb", "ilb", "olb", "cb", "s", "de", "dt", "edge", "ol", "ot",
  "og", "ls", "star", "rookie", "veteran", "receiver", "quarterback", "kicker", "sources", "source",
  "report", "reports", "nfl", "afc", "nfc", "the", "and", "with", "as", "at", "for", "from", "of", "on",
  "to", "in", "after", "before", "but", "while", "when", "why", "how", "rb1", "wr1", "qb1", "te1", "rb2",
  "wr2", "backup", "starter",
];
/** match.ts' STAFF_WORDS: a surname right after one is a staff member's. */
export const STAFF_WORDS: readonly string[] = [
  "coach",
  "coaches",
  "hc",
  "oc",
  "dc",
  "stc",
  "coordinator",
  "coordinators",
];

/** Every team word form list (one word or several), keyed by the source's list name. */
export const TEAM_WORD_LISTS: Readonly<
  Record<string, Readonly<Record<string, NflTeam | readonly NflTeam[]>>>
> = {
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
};
/** Every team abbreviation list. */
export const TEAM_ABBREVIATION_LISTS: Readonly<
  Record<string, Readonly<Record<string, readonly NflTeam[]>>>
> = { TEAM_ABBREVIATIONS, TEAM_LEGACY_ABBREVIATIONS, TEAM_STATE_ABBREVIATIONS };
/** A list entry's teams. */
export const teamsOf = (t: NflTeam | readonly NflTeam[]): readonly NflTeam[] =>
  typeof t === "string" ? [t] : t;

/**
 * A form's spellings as the matcher reads them: its possessive "'s" written or not, its words joined by
 * a space, a hyphen or nothing (a spaced spelling never opens with the article "a").
 */
export function spellingsOf(form: string): string[] {
  const out = new Set<string>();
  for (const base of new Set([form, form.replace(/'s\b/gu, "")])) {
    const words = base.split(/[\s-]+/u);
    let joins = [words[0] ?? ""];
    for (const w of words.slice(1))
      joins = joins.flatMap((s) => [`${s} ${w}`, `${s}-${w}`, `${s}${w}`]);
    for (const j of joins) if (!/^a /iu.test(j)) out.add(j);
  }
  return [...out];
}
/** Each case of a word: as written, lower case, capitals, title case. */
export const cases = (w: string): string[] => [
  ...new Set([w, w.toLowerCase(), w.toUpperCase(), w.replace(/\b\p{L}/gu, (c) => c.toUpperCase())]),
];
