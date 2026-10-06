# fixtures/news/labelled — the hand-labelled news items (plan 10 B8, A-4)

Plan 10 B8: "the `rules_v1` claim extractor scores ≥ 0.8 precision on a hand-labelled set of 50 real
items [A-4]". Checked by `tests/domain/evidence/labelled.test.ts`; the matcher's precision on the same
titles by `tests/sources/news/match.test.ts`.

## The sets

| File | Items | Source | Labelled claims | Relation to the rules |
|---|---|---|---|---|
| `items.json` | 65 | every item of the three 2026-10-06 19:53 UTC captures (`../captured/*.xml`) except one removed for privacy | 14 | **in-sample**: the `rules_v1` table was drafted with these titles in view, so this set shows the rules fit the phrasing they were written for — not how they generalise |

Each item records `feed`, `guid` and `title` (held equal to the committed capture by the test), the
`claim` label (`{ type, direction }` or `null`), the fixture-roster ESPN ids the title names
(`players`, for the matcher check) and `why`, a one-line reason for the label.

## Labelling rules (applied to the title only — descriptions are not committed)

1. **Unit.** One RSS item, judged on its title.
2. **What a claim is.** A statement about a specific NFL player (named or not) on one of: future
   **availability**, **health**, **role**, a coach's stated **intent** for his usage, or a **roster
   transaction**. Not claims: team, coach or official conduct; games, recaps and stat lines
   ("dominates", "stays busy", "uptick in production" — output, not usage); rankings, grades,
   picks, betting lines and promotions; draft and college items; features, opinion and speculation
   ("why a reunion makes sense"); retrospectives on past moves.
3. **One label per item: the first claim in reading order.** When a title makes several claims
   ("has ankle sprain, slim chance to play"), the label is the first one (health/down here).
4. **Types.**
   - `availability` — whether or when he plays or practises: designations (out, doubtful,
     questionable, game-time decision, status unknown), will play / will miss, IR placement and
     activation, return to practice or play, week-to-week, a player's suspension, practice
     participation.
   - `health` — the nature or severity of an injury, surgery or test results, without a statement
     of availability ("has MCL sprain", "to have surgery", "avoids long-term injury").
   - `role` — usage and depth: named starter, lead role, benched, backup, more or fewer snaps,
     touches or targets.
   - `coaching_intent` — a coach's plan for his usage, stated as intent rather than fact.
   - `transaction` — signing, not signing, release or waiver, trade, claim, promotion or elevation,
     retirement.
5. **Direction**, from the player's fantasy value: `up` = more likely to play, a bigger role,
   signed, healthier; `down` = the opposite; `neutral` = genuinely uncertain (game-time decision,
   status unknown) or value-neutral (traded).
6. **Hedges** ("could miss", "slim chance to play") take the hedge's direction.

## Scoring

Precision = emitted claims whose `type` **and** `direction` equal the label ÷ emitted claims. An
emitted claim on an item labelled `null` is a false positive. Recall is reported, not gated.

## Results (rules_v1)

| Set | Items | Labelled claims | Emitted | Correct | Precision | Recall |
|---|---|---|---|---|---|---|
| `items.json` (in-sample) | 65 | 14 | 14 | 14 | 1.00 | 1.00 |

Matcher (fixture-roster universe, the same titles): 7 refs emitted, 7 correct (precision 1.00); 9
labelled mentions, 7 found — the two misses are by design: "RB Mixon" (a free agent's bare surname:
a surname needs the player's team named in the item) and "Burrow is wrong" (his team is not named).
