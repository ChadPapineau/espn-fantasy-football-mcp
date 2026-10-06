# fixtures/news/labelled — the hand-labelled news items (plan 10 B8, A-4)

Plan 10 B8: "the `rules_v1` claim extractor scores ≥ 0.8 precision on a hand-labelled set of 50 real
items [A-4]". Checked by `tests/domain/evidence/labelled.test.ts`; the matcher's precision on the same
titles by `tests/sources/news/match.test.ts`.

## The sets

| File | Items | Source | Labelled claims | Relation to the rules |
|---|---|---|---|---|
| `items.json` | 65 | every item of the three 2026-10-06 19:53 UTC captures (`../captured/{rotowire,espn,cbs}.xml`) except one removed for privacy | 14 | **in-sample**: the `rules_v1` table was drafted with these titles in view, so this set shows the rules fit the phrasing they were written for — not how they generalise |
| `holdout.json` | 6 | every item that was new in three later fetches (20:39–21:24 UTC, `../captured/holdout-{rotowire,cbs}.xml`) except one removed for privacy | 2 | **held out**: labelled before `rules_v1` was run on them. Too small to estimate precision — a generalisation sanity check; the feeds turn over slowly (7 new items in 90 minutes) and the capture was kept to a few requests |

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
| `holdout.json`, as first run (held out) | 6 | 2 | 1 | 1 | 1.00 | 0.50 |
| `holdout.json`, after the one change it prompted | 6 | 2 | 2 | 2 | 1.00 | 1.00 |
| both, pooled (current rules) | 71 | 16 | 16 | 16 | 1.00 | 1.00 |

The held-out miss was RotoWire's "Viewed as 'unlikely' for Week 5": the rules read "unlikely to play"
but not "unlikely for Week N", and a quoting mark split the phrase. The change that followed is
general — quoting marks are folded away before matching (an apostrophe inside a word such as
"won't" stays) and "unlikely / not expected / not likely for <game>" reads as availability/down —
and it leaves the in-sample result unchanged. After it the held-out sample is no longer held out;
the next capture is the next out-of-sample check. No item was ever emitted with a wrong label in
either set, so the plan's ≥ 0.8 gate holds with margin, but on 16 claims the estimate is coarse:
one more false positive costs ~6 points.

Matcher (fixture-roster universe, the same titles): 7 refs emitted, 7 correct (precision 1.00); 9
labelled mentions, 7 found — the two misses are by design: "RB Mixon" (a free agent's bare surname:
a surname needs the player's team named in the item) and "Burrow is wrong" (his team is not named).
