// @ts-check
// on1-patterns.mjs — the two format graders of onboard's ON-1 Lane 2 case (plan 09 §3.1 onboard,
// §5.2 "every free grader passes"), built from named parts (Stage C finding eval-on1-regex-too-narrow).
// skills/onboard/evals/evals.json carries the built patterns verbatim (the plugin-eval runner reads
// them from there); tests/skills/on1-graders.test.ts holds the file to this builder and the patterns
// to a corpus of correct and wrong restatements.
//
// Three earlier attempts widened one directional grammar layout by layout, and each round's verifier
// found the siblings of the layouts just added still rejected. This is a different structure: a value
// counts where it stands NEXT TO its stat's marker, in either order —
//   • label first ("Passing TD (stat 4): 5", "passing touchdowns, which are worth 5"),
//   • value first ("5-point passing TDs", "0.5 per catch", "| 5 | PTD |"),
//   • under a category ("Passing: TD 5", "TDs: passing 5", "| Passing | … · TD 5 · … |"),
//   • as the first of a respectively-list ("Pass/Rush/Rec TD: 5/6/6", "Receptions and passing TDs:
//     0.5 and 5"), or in the same column of a horizontal table —
// with only FILLER between: no digit (but the stat's own id), no line break, no other stat's word.
// Precision comes from the value itself (never part of a longer number, never negated, never a week
// or a seed), from the filler, and from a trailing veto that reads the words right after the value —
// "0.5 per completion", "5 bench", "5-point rushing TDs" — up to the next item boundary only (a
// spaced slash, a pipe, a comma …), so the next item's own label never vetoes it. Every filler and
// veto is bounded, so a hostile reply costs linear time. The patterns compile with flags "i" only
// (the runner's): no `u` flag, so \p{…} is not used; a backtick is written \x60 (the evals.json tag
// is delimited by backticks).

/** @param {readonly string[]} parts */
const alt = (parts) => `(?:${parts.join("|")})`;

/** Characters a markdown reply puts around a cell or a word: emphasis, code, quotes. */
const DECOR = "[ \\t*_\\x60'\"\\u2019]";

/** Conjunctions that end the trailing veto's scan ("0.5 and rushing yards 0.1"). */
const CONJ = "\\b(?:and|or|but|while|whereas|with|plus|vs|versus|instead|rather|than|not)\\b";

/** A negation or a comparison right before a value: it is not the league's value. */
const NEGATED =
  "(?<!\\b(?:not|no|non|isn't|isn\\u2019t|aren't|aren\\u2019t|never|than|of|vs\\.?|versus|instead[ \\t]+of|rather[ \\t]+than)[ \\t(\\-]+(?:an?[ \\t-]+)?)";

/**
 * One stat's grader from its parts.
 * @param {{
 *   label: string,        // the stat's full marker (it names the stat by itself)
 *   value: string,        // the league's value (bounded, never part of a longer number)
 *   first: string,        // what the value can start with (checked first: a cheap lookahead)
 *   unit: string,         // its optional unit ("points", "-pt", "a point")
 *   other: string,        // another stat's word: never filler, and a veto right after the value
 *   statId: string,       // the stat's ESPN id, which may stand between label and value
 *   respectively: readonly string[], // first-of-a-list forms
 *   context?: { pairs: readonly (readonly [string, string])[], header: string } // category forms
 *   tableLabel: string,   // a header cell of a horizontal table
 * }} p
 * @returns {string}
 */
function graderOf(p) {
  // the stat's own id between label and value: "(stat 53)", "(53)", ", stat 4", "| 4 |", "[stat 53]"
  const id = alt([
    `\\((?:[^()\\n\\d]{0,30})?\\b${p.statId}\\b[^()\\n\\d]{0,20}\\)`,
    `\\[[^\\]\\n\\d]{0,30}\\b${p.statId}\\b[^\\]\\n\\d]{0,20}\\]`,
    `,?[ \\t]*(?:\\bstat(?:[_ \\t]*id)?|\\bid|#)[ \\t]*[:#]?[ \\t]*${p.statId}\\b`,
    `\\|[ \\t]*${p.statId}[ \\t]*(?=\\|)`,
  ]);
  // filler between a label and its value (label first): commas and pipes allowed, a semicolon (the
  // next item) and a digit never
  const fill = `(?:(?!${p.other}|;)[^\\n\\d]|${id}){0,80}?`;
  // filler between a value and its label (value first): a preposition or a separator, never a
  // comma, a semicolon, a dot, a spaced slash or a conjunction — a value-first statement is one
  // phrase ("0.5 per catch", "5 | Passing TD", "5 — passing TDs"); "FG 50+: 5 and passing TDs are
  // worth 4" gives the 5 to the field goal
  const fillB = `(?:(?!${p.other}|${CONJ}|[,;\\u00b7\\u2022]|[ \\t]/[ \\t]|\\.[ \\t])[^\\n\\d]|${id}){0,60}?`;
  // the trailing veto: the next words, up to an item boundary, are not another stat's — past the
  // unit too, whether or not the value took it ("5-point rushing TDs" never reads as "5")
  const veto = `(?!(?:${p.unit})?${DECOR}*(?:(?!${CONJ})[a-z]+${DECOR}+){0,2}${p.other})`;
  // a label that carries its own value right after it is label-first: not this value's
  const ownValue = "(?![ \\t]*[:=][ \\t]*[+\\-\\u2212]?\\d)";
  const value = `(?=${p.first})${NEGATED}${p.value}(?:${p.unit})?`;
  const forms = [
    `${p.label}${fill}${value}${veto}`,
    `${value}${fillB}${p.label}${ownValue}`,
    ...p.respectively,
  ];
  if (p.context !== undefined) {
    // a category head, then (no other category's header between) the sub-marker next to the value;
    // a pair names the stat only together (passing + a TD, or TDs + passing)
    const span = `(?:(?!${p.context.header})[^\\n]){0,80}?`;
    for (const [head, sub] of p.context.pairs)
      forms.push(
        `${head}${span}${sub}${fill}${value}${veto}`,
        `${head}${span}${value}${fillB}${sub}${ownValue}`,
        `${value}${fillB}${sub}${span}${head}`,
      );
  }
  // a horizontal table: the label's header cell and the value's cell in the same column (≤ 12)
  /** @param {number} k */
  const cell = (k) => `(?:[^|\\n]*\\|){${String(k)}}`;
  for (let k = 0; k < 12; k++)
    forms.push(
      `(?:^|\\n)[ \\t]*\\|${cell(k)}${DECOR}*${p.tableLabel}${DECOR}*\\|[^\\n]*(?:\\n[^\\n]*){0,2}?\\n[ \\t]*\\|${cell(k)}${DECOR}*${p.value}(?:${p.unit})?${DECOR}*\\|`,
    );
  return alt(forms);
}

/**
 * The parts of a respectively-list ("Receptions and passing TDs: 0.5 and 5"): its other label is a
 * stat — never the bench, a slot, the teams or the playoffs — its values are joined by "and", "&" or
 * "/" (a comma or a semicolon ends the item), and its first label carries no value of its own ("4-point
 * passing TDs and bench: 5" is a 4-point passing TD) (Stage C finding eval-on1-regex-too-narrow).
 */
const LIST_LABEL =
  "(?:(?!\\b(?:bench|slots?|spots?|teams?|playoffs?|weeks?|roster|IR\\b|FLEX|waivers?|trade|seeds?|byes?)\\b)[^\\n\\d:;|,]){1,40}";
const LIST_AND = "[ \\t]*(?:and|&|\\/)[ \\t]*";
const NO_VALUE_BEFORE =
  "(?<![\\d\\u00bd][- \\t\\u2010\\u2011]*(?:(?:pts?|points?)[- \\t\\u2010\\u2011]*)?)";

// --- receptions: half a point (stat 53) -----------------------------------------------------------

/** 0.5, .5, 0.50, 1/2, ½, half (a point), one-half: never part of a longer number or negative. */
const HALF = alt([
  "(?<![\\d.\\/\\u2212-])\\+?(?:0?\\.50*(?!\\.?\\d)|1\\/2(?![\\d\\/]))",
  "\\u00bd",
  "\\b(?:one[- \\t])?half\\b",
]);
/** HALF's optional unit ("0.5 points", "half a point", "½ pt", "0.5 fantasy points"). */
const HALF_UNIT = "[- \\t\\u2010\\u2011]?(?:an?[- \\t])?(?:fantasy[ \\t]+)?(?:pts?|points?)\\b";
const HALF_VALUE = `${HALF}(?:${HALF_UNIT})?`;
/** A reception: never a receiving yard or TD ("Rec yds", "Rec TD"). */
const REC_LABEL = `(?:\\brec(?:eption)?s?\\b|\\bcatch(?:es)?\\b|(?<![a-z])PPR\\b)(?![ \\t]*(?:yds?|yards?|TDs?|touchdowns?)\\b)`;
/** Another stat's word, or a word that says the value is not the reception value. */
const REC_OTHER = alt([
  "\\b(?:rush|pass|throw|return|kick|punt|field|FG\\b|defen|D\\/ST|DST\\b|fumble|sack|safet|interception|INT\\b|completion|attempt|carr(?:y|ies)\\b|first[- ]downs?|yards?\\b|yds?\\b|TDs?\\b|touchdown|bench|IR\\b|FLEX|week|playoff|team|seed|slot|spot|roster|bonus|conversion|bye\\b|starter|full\\b|whole\\b|standard\\b|premium|extra\\b|additional\\b)",
]);

/** The ON-1 reception grader. */
export const RECEPTION_PATTERN = graderOf({
  label: REC_LABEL,
  value: HALF,
  first: "[+.01\\u00bd]|half|one",
  unit: HALF_UNIT,
  other: REC_OTHER,
  statId: "53",
  respectively: [
    // "Receptions and receiving yards: 0.5 and 0.1" — the first label's value is the first value
    `(?=${REC_LABEL})${NO_VALUE_BEFORE}${REC_LABEL}[ \\t]+(?:and|&)[ \\t]+${LIST_LABEL}:[ \\t]*${HALF_VALUE}${LIST_AND}[+\\-\\u2212]?\\.?\\d`,
    // "Receiving yards and receptions: 0.1 and 0.5"
    `(?=[ \\t]+(?:and|&)[ \\t]+${REC_LABEL}[ \\t]*:)(?<=[a-z][ \\t\\/'a-z-]{0,40})[ \\t]+(?:and|&)[ \\t]+${REC_LABEL}[ \\t]*:[ \\t]*\\+?[\\d.]+(?:[ \\t]*(?:pts?|points?))?${LIST_AND}${HALF_VALUE}`,
  ],
  tableLabel: alt([REC_LABEL, "\\bpoints[ \\t]+per[ \\t]+reception\\b"]),
});

// --- passing touchdowns: five points (stat 4) -----------------------------------------------------

/** 5 or five (5.0 too): never part of a longer number, negative, a week, a seed, a bonus … */
const FIVE = alt([
  "(?=\\+?5)(?<![\\d.\\/\\u2212-])(?<!\\b(?:weeks?|wk|round|game|period|seed|top|day|matchup|team|rank|no\\.?|#|bonus|extra|additional|bench|slots?|spots?)[ \\t]*)\\+?5(?:\\.0+)?(?!\\.?\\d)",
  "\\bfive\\b",
]);
const FIVE_UNIT = "[- \\t\\u2010\\u2011]?(?:fantasy[ \\t]+)?(?:pts?|points?)\\b";
const FIVE_VALUE = `${FIVE}(?:${FIVE_UNIT})?`;
const TD = "(?:TD|touchdown)s?";
/** A passing touchdown by itself: passing TD, PTD, pass_td, TD pass, TD thrown, throwing a TD … */
const PASS_TD = alt([
  `\\bpass(?:ing)?[-_ \\t]?${TD}\\b`,
  "\\bPTDs?\\b",
  `\\b(?:TD|touchdown)[- \\t]?pass(?:es)?\\b`,
  `\\b${TD}[- \\t]thrown\\b`,
  `\\bthrown[- \\t]${TD}\\b`,
  `\\bthrow(?:ing|s|n)?[- \\t](?:an?[- \\t])?${TD}\\b`,
  `\\b(?:TD|touchdown)[- \\t]?throws?\\b`,
  `\\b${TD}[ \\t]+through[ \\t]+the[ \\t]+air\\b`,
  `\\b${TD}[ \\t]*\\([ \\t]*pass(?:ing|es)?[ \\t]*\\)`,
]);
/** Passing alone (the category or the sub-item): never passing yards, attempts or completions. */
const PASS_ONLY = `(?:\\bpass(?:ing|er|es)?\\b(?![-_ \\t]?(?:yds?|yards?|attempts?|completions?|${TD}|int)\\b)|\\bQBs?\\b|\\bquarterbacks?\\b|\\bthrow(?:s|ing|n)?\\b)`;
/** A touchdown that is no other kind ("Rush TD", "TD (rush)" are rushing touchdowns). */
const TD_ONLY = `(?=TD|touchdown)(?<!\\b(?:rush\\w*|rec\\w*|receiv\\w*|return\\w*|kick\\w*|punt\\w*|defen\\w*|DST|D\\/ST|fumble\\w*|INT|interception\\w*|special[ \\t]+teams?)[ \\t:/|-]{0,3})\\b${TD}\\b(?![ \\t]*\\([ \\t]*(?:rush|rec|receiv|return|kick|defen))`;
/** Another stat's word. */
const PASS_OTHER = alt([
  "\\b(?:rush|rec(?:eption)?s?\\b|receiv|catch|return|kick|punt|field|FG\\b|defen|D\\/ST|DST\\b|fumble|sack|safet|interception|INT\\b|completion|attempt|carr(?:y|ies)\\b|first[- ]downs?|yards?\\b|yds?\\b|bench|IR\\b|FLEX|week|playoff|team|seed|slot|spot|roster|bonus|conversion|bye\\b|starter|PPR\\b|RBs?\\b|WRs?\\b|TEs?\\b|Ks?\\b|running[ \\t]+backs?|wide[ \\t]+receivers?|tight[ \\t]+ends?)",
]);
/** Another category's header ("Rushing:", "| D/ST |", "Returns —"): a category head ends at it. */
const OTHER_HEADER = `\\b(?:rush\\w*|rec\\w*|receiv\\w*|return\\w*|kick\\w*|punt\\w*|defen\\w*|D\\/ST|DST|DEF|special[ \\t]+teams?|RBs?|WRs?|TEs?|Ks?|running[ \\t]+backs?|wide[ \\t]+receivers?|tight[ \\t]+ends?|bench|roster|waiver\\w*|playoff\\w*)[ \\t*_]*(?::|\\||=|\\u2013|\\u2014)`;

/** The ON-1 passing-TD grader. */
export const PASSING_PATTERN = graderOf({
  label: PASS_TD,
  value: FIVE,
  first: "\\+?5|five",
  unit: FIVE_UNIT,
  other: PASS_OTHER,
  statId: "4",
  respectively: [
    // "Pass/Rush/Rec TD: 5/6/6", "TDs (pass/rush/rec): 5/6/6" — the first slot is passing
    `\\bpass(?:ing)?\\b(?:[ \\t]*\\/[ \\t]*[a-z]+){1,3}[ \\t]+${TD}\\b[ \\t:=|\\u2013\\u2014-]*${FIVE}[ \\t]*\\/`,
    `\\b${TD}[ \\t]*\\([ \\t]*pass(?:ing)?(?:[ \\t]*\\/[ \\t]*[a-z]+){1,3}[ \\t]*\\)[ \\t:=|\\u2013\\u2014-]*${FIVE}[ \\t]*\\/`,
    // "Passing TDs and passing yards: 5 and 0.04"
    `(?=${PASS_TD})${NO_VALUE_BEFORE}${PASS_TD}[ \\t]+(?:and|&)[ \\t]+${LIST_LABEL}:[ \\t]*${FIVE_VALUE}${LIST_AND}[+\\-\\u2212]?\\.?\\d`,
    // "Receptions and passing TDs: 0.5 and 5"
    `(?=[ \\t]+(?:and|&)[ \\t]+${PASS_TD}[ \\t]*:)(?<=[a-z][ \\t\\/'a-z-]{0,40})[ \\t]+(?:and|&)[ \\t]+${PASS_TD}[ \\t]*:[ \\t]*\\+?[\\d.]+(?:[ \\t]*(?:pts?|points?))?${LIST_AND}${FIVE_VALUE}`,
  ],
  context: {
    // "Passing: TD 5" / "| Passing | … · TD 5 · …" (head pass, sub TD) and "TDs: passing 5" (head
    // TD, sub pass); the head's span ends at another category's header
    pairs: [
      [PASS_ONLY, TD_ONLY],
      [`\\b${TD}\\b`, PASS_ONLY],
    ],
    header: OTHER_HEADER,
  },
  tableLabel: alt([PASS_TD, "\\bpoints[ \\t]+per[ \\t]+passing[ \\t]+TD\\b"]),
});
