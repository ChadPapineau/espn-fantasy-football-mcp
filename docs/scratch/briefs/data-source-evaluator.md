# Brief: data-source-evaluator

You are the **NFL data-source evaluator** for a new project: a from-scratch
ESPN Fantasy Football MCP server (Node/TypeScript, official MCP SDK). Your
job is to decide, with evidence gathered **today**, which data sources beyond
ESPN's league data the server should use for each analytic need, graded for
coverage, freshness, reliability, rate limits, licensing/ToS and cost — and
to settle the ESPN-specific questions the sibling program could not. You
produce a research document. You do not write product code.

## Where you are

- Repo (already cloned, on `main`, PUBLIC on GitHub):
  `<repo>`
  (the path contains spaces — quote it in every command).
- Tools: `WebFetch`, `WebSearch`, `curl`, `jq`, `python3` (standard library
  only — `csv`, `gzip`, `json`; install nothing), `Read`, `gh`.
- Read first: `docs/research/03-espn-api.md` (what ESPN itself returns —
  projections, ownership, ranks, injury status, news text, pro-team
  schedules). If it is not there yet, proceed with the wrapper clones under
  `<session-scratch>/eff-research/vendor/`
  as untrusted static reference, and say so.

## What is already known — reuse by citation, do not re-derive

The sibling program (Yahoo Fantasy Football MCP, same owner, public repo
`ChadPapineau/yahoo-fantasy-football-mcp`) evaluated 16 needs across ~25
sources on 2026-09-29, with live probes. Read it in full:

    git -C "<sibling-repo>" show origin/main:docs/research/04-data-sources.md
    git -C "<sibling-repo>" show origin/main:docs/scratch/data-source-evaluator.md

Never modify that checkout. Cite it as
`yahoo-fantasy-football-mcp@<sha> docs/research/04-data-sources.md §<n>` with
`git -C "…Yahoo Fantasy Football" rev-parse origin/main` for the sha. Its
verdicts on nflverse (pbp, stats_player, snap_counts, injuries,
depth_charts, schedules with betting lines, roster_weekly), ffopportunity,
The Odds API, Open-Meteo/NWS, Sleeper trending, RSS news feeds, and
FantasyPros pricing stand unless you observe otherwise today. Re-verify only
the **freshness** of the three load-bearing nflverse files (`curl -I` on
`stats_player_week_2026`, `injuries_2026`, `games.csv`) and anything you rely
on that the sibling tagged [U].

## What is different for ESPN — this is your real work

1. **ESPN-native data changes the matrix.** The server already reads the
   unofficial ESPN API for league data with the user's own session; the
   marginal ToS/risk cost of also reading ESPN's player pool
   (`kona_player_info` with `X-Fantasy-Filter`: weekly/season projections
   `statSourceId=1`, actuals, `ownership.percentOwned/percentChange/
   percentStarted`, `draftRanksByRankType`, `injuryStatus`, player
   news/outlook text) is near zero — but its **quality** is not established.
   For each of: projections, ownership/start %, ranks, injury status, news
   text, pro-team bye/schedule — grade ESPN's own data as Primary /
   Secondary / Fallback with evidence: any published projection-accuracy
   comparisons (FantasyPros accuracy contest results, independent
   backtests — cite, note methodology and year), community experience
   with update cadence (when do ESPN weekly projections first appear and
   how often do they change?), and the free-text fields that must be
   treated as untrusted. State plainly what remains unverified.
2. **Player-ID crosswalk for ESPN.** The sibling found nflverse
   `roster_weekly_2026` `yahoo_id` covers only 362/532 active skill players.
   Measure `espn_id` coverage the same way (download the 2026 CSV, count
   non-null `espn_id` for active QB/RB/WR/TE, list how many 2026 rookies
   are missing), and cross-check against DynastyProcess `db_playerids.csv`
   and Sleeper `players/nfl` (`espn_id` field). Report exact counts, the
   file `updated_at`, and the recommended join strategy (which key, which
   fallback, name+team+position fuzzy match as last resort with a
   confidence flag).
3. **Bye weeks / schedule from ESPN vs nflverse**: ESPN exposes
   `proTeamSchedules_wl` (byes, matchups) — is it complete and does it
   agree with nflverse `schedules` for 2026? Probe a public-league-free
   endpoint only if it needs no cookie; otherwise rely on 03 and mark [U].
4. **Live scoring during games**: ESPN `mBoxscore`/`mLiveScoring` vs
   nflverse (post-game only) vs Sleeper `stats` — which gives in-game
   updates, how fresh, at what request cost.
5. **Weather and odds** for the ESPN product: same conclusions as the
   sibling unless the ESPN core API (`site.api.espn.com`, `sports.core.api`)
   offers weather/odds on the same terms as the fantasy API — grade it
   honestly as unofficial.
6. **Licensing for this repo**: the sibling flagged non-commercial
   (Sleeper, Open-Meteo) and share-alike (FTN charting, ffopportunity)
   terms. Restate the constraints for a personal, single-league tool and
   what changes if the project is ever distributed commercially.

## Method rules

- Tag every claim **[V-observed]** (you fetched it today; report status,
  size, `updated_at`, row counts, field names), **[V-docs]** (quoted from
  the provider), **[V-community]**, or **[U]**.
- Budget: ≤ 40 HTTP requests total; samples ≤ 5 MB; nflverse release
  assets via the GitHub releases API where possible; a normal `User-Agent`;
  no keys, no cookies.
- Install nothing; execute nothing from third-party repos; python3 stdlib
  only for counting rows.
- Anonymize: no league ids, team names or member ids of anyone in the repo.
- **A clean negative is a real result.** If ESPN projections' accuracy has
  no credible published measurement, say so and give the backtest design
  the plan should include instead.

## Deliverables (you own these paths; touch nothing else)

1. `docs/research/04-data-sources.md` — a **complete** document for this
   repo (not a diff): (A) evaluation matrix — need → Primary / Secondary /
   Fallback / Do-not-use, now including the ESPN-native column; (B)
   per-source evidence (reused rows cite the sibling sha; new rows carry
   your probes); (C) the ESPN player-ID crosswalk study with counts; (D)
   freshness map (when each source updates, in ET, in-season); (E) the
   licensing/ToS table and the personal-vs-commercial constraints; (F)
   delta vs the sibling (what changed because this is ESPN); (G) unverified
   list; (H) probe log (≤ 40 rows, anonymized).
2. `docs/scratch/data-source-evaluator.md` — working notes with `## RESUME HERE`.

**Do NOT touch**: `README.md`, `.gitignore`, `.env.example`,
`docs/research/00-*` … `03-*`, `05-*` or later (`fantasy-strategy-analyst`
is writing `05-*` in parallel), `docs/scratch/roster.md`,
`docs/scratch/program.md`, `docs/scratch/briefs/`. Leave any file you did
not create exactly as you find it.

## What a FAILED report looks like

- Re-probing everything the sibling already verified instead of citing it.
- Grading ESPN projections "Primary" with no evidence of accuracy or cadence.
- A crosswalk section without exact counts and the file date.
- Any claim without a source tag; any request beyond the budget.
- Findings that exist only in your reply and not in the pushed file.
- A reply without the pushed SHAs.

## COMMIT/PUSH DISCIPLINE — Chad's standing rule, non-negotiable

**No work you do may be lost.**
- **Your FIRST action is** `docs/scratch/data-source-evaluator.md` with a
  `## RESUME HERE` section — commit and push it before any real work, and
  keep it current.
- **Commit and push to `origin/main` at every natural checkpoint** — after
  each section A–H lands, not once at the end.
- **Before you are torn down, blocked, or run low on context, COMMIT AND
  PUSH FIRST, then reply.**
- **Track your remaining budget.** At roughly **20% context remaining**, stop
  taking on new scope: commit, push, update `## RESUME HERE`, reply.
- **Preserve unfinished work on `origin` as a PATCH, never as broken files**:
  `git diff -- <your paths> > docs/scratch/data-source-evaluator.wip.patch`
  (untracked files: `git diff --no-index /dev/null <file> >> …`), commit and
  push only that file. Refresh it every ~15 minutes of work. Retire it in
  your final commit.
- **Stage EXPLICIT PATHS ONLY.** Never `git add -A`, `git add -u`, or
  `git add <directory>`; never `git stash`; never `git checkout` a file with
  uncommitted work. Another agent shares this tree. If `git` reports an
  `index.lock`, wait a few seconds and retry — do not delete the lock.
- `git pull --rebase origin main` before every push. Never force-push. After
  each push run `git fetch && git rev-parse HEAD origin/main` and confirm they
  match.
- Commit messages: conventional style, e.g.
  `docs(research): data sources — ESPN-native grades and crosswalk (A, C)`,
  ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Commit identity is already configured locally in this repo. Do not change
  git config.

## Reply format

When done: (1) the pushed SHAs, (2) the matrix as one compact table
(need → primary), (3) the ESPN crosswalk counts in one line, (4) the three
findings that most change the plan versus the sibling, (5) the unverified
list, by name.
