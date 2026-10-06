## Priority waivers — why a claim has a price

**A successful claim costs the position; a failed claim is free.** In a move-to-last league the only cost of claiming is the place in the order the user gives up *if the claim wins* — they drop to last. So the question is never "is this player good?" but "is this player worth more than my current spot?" The server prices the spot as the **premium** `Π(k, W)`: the rest-of-season points the user expects to gain from holding position `k` for the `W` usable weeks left, minus what the last spot is worth. The rule is a strike price: **claim ⇔ s ≥ Π(k, W)**, where `s` (the surplus) is the candidate's weeks of usable value on *this* roster minus the drop's value. How likely the claim is to win (`p_k_win`) changes what it is worth, never whether to make it.

**The premium falls as the season runs down and regenerates as rivals claim.** With many weeks left the top spot is expensive (at `k = 2` with 13 weeks left the cold-start premium is about 29.5 points); in the last four weeks even the first spot should take a small upgrade; after the last run before the playoffs unspent priority is worth exactly zero — claim anything positive. Every rival who wins a claim drops below the user, so priority comes back on its own; that is why a priority league rewards claiming whenever `s ≥ Π`, never hoarding "for the league-winner", and never passing "to keep priority" when `s > Π`. A candidate whose `s` falls inside the premium band (`premium_band`: the premium recomputed at half and one-and-a-half times the league's surplus) is **marginal** — the user's call, listed apart from the claim list, never presented as a crisp claim or pass.

**Because failing is free, submit the long ordered list.** Every candidate with `s ≥ Π`, ordered by `s`, goes in for the next run — a long list costs nothing when the claims fail. The drop for each claim is named with its re-add risk; when an IR slot is open and a rostered player is IR-eligible (`OUT` or `INJURY_RESERVE`), moving him to IR is the drop alternative, which raises `s` (both values are shown: `s` and `s_with_ir_move`) — but activate players only after the run, never the night before a pending claim, or the claim fails.

### The two briefs

| When | Brief | Source of the timing |
|---|---|---|
| before the run (`phase: pre_run`) | **the claim brief**: per candidate `s`, `s_with_ir_move`, the premium and its band, a claim, pass or marginal verdict, the ordered claim list, the drop per claim, `p_clears_to_fa` ("will probably clear") | `rules.waiver.next_execution` |
| after the run (`phase: post_run`) | **the scramble brief**: every unclaimed target is now a free agent — the list filtered to `FREEAGENT`, re-ranked by `s`, to add at once; a team deep in the order spends its claims on contested players and its attention on this list | `rules.waiver.last_execution` just passed; the following run's `next_execution` |

A target whose game kicks off before the run clears must be rostered before kickoff — a claim that clears after his game is no help this week.

### What the server does not know yet

Two waiver mechanics are unconfirmed on ESPN: whether a team's second claim in the same run is processed at its new (last) position, and how the order resets (`order_reset`). Until the league's own transaction feed shows them, the premium is a league-average estimate (`premium_basis: "cold_start_table"`) and the `learned.*` fields are null. Say so in one line — "the server learns these from your league's own feed" — and print the `learned` line once a mechanic is confirmed.
