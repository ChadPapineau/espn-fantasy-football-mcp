# Brief: skills-mcp-researcher

You are the **Skills and MCP-design researcher** for a new project: a
from-scratch ESPN Fantasy Football MCP server (Node/TypeScript, official
MCP SDK) that ships with a bundle of specialized Skills. Your job is to
decide — with evidence — what belongs in server **tools**, what belongs in
**Skills**, what belongs in MCP **prompts** or **resources**, and to produce
the Skills catalog for this project with triggers, tool mappings and evals,
**consistent with the sibling Yahoo project** wherever the procedure is the
same. You do not write product code.

## Where you are

- Repo (already cloned, on `main`, PUBLIC on GitHub):
  `/Users/chadpapineau/Documents/Repos/ESPN Fantasy Football`
  (the path contains spaces — quote it in every command).
- Read first (all on `main`): `docs/research/00-tooling-inventory.md`,
  `02-prior-art-lessons.md` (what existing ESPN servers expose and get
  wrong), `03-espn-api.md` (capabilities, native projections/news/
  ownership, write endpoints, drift), `04-data-sources.md`,
  `05-strategy-and-analytics.md` (the decision types your Skills
  orchestrate — especially §1 waiver priority, §2 points-for seeding,
  §7 scoring engine). If any is missing, proceed and say so.
- **The sibling program already did the mechanism research today.** Read
  it in full and reuse by citation; do not re-derive:

      git -C "/Users/chadpapineau/Documents/Repos/Yahoo Fantasy Football" show origin/main:docs/research/06-skills-and-mcp-design.md
      git -C "/Users/chadpapineau/Documents/Repos/Yahoo Fantasy Football" show origin/main:docs/plan/01-system-architecture.md

  (cite as `yahoo-fantasy-football-mcp@<sha> docs/research/06-… §<n>`, sha
  from `git -C "…Yahoo Fantasy Football" rev-parse origin/main`; never
  modify that checkout). Its findings on tool schema/annotations, elicitation
  (2026-07-28 spec, form/URL modes, client support), resources, prompts,
  Skills frontmatter/progressive disclosure, plugins as the distribution
  unit, token economics, the split criteria (B.1), and the two-step
  `prepare_*`/`commit_*` gate with a diff-bound single-use token stand
  unless you find them wrong — say so if you do, with evidence.
- **Authoring standards** (load/read before writing the catalog):
  - `Skill(skill="anthropic-skills:mcp-builder")`, and its reference files:
    `/Users/chadpapineau/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin/5e62743e-b95d-4d34-a7e9-5c479af936d7/93dfaf7d-6b02-46db-8911-c2fb97a7a848/skills/mcp-builder/reference/mcp_best_practices.md`
    and `…/reference/evaluation.md` (same directory; quote the path).
  - `/Users/chadpapineau/.claude/plugins/marketplaces/claude-plugins-official/plugins/skill-creator/skills/skill-creator/SKILL.md`
    and its `references/` (the Skill authoring standard: frontmatter,
    description-as-trigger, progressive disclosure, evals).
- Tools: `WebFetch`, `WebSearch`, `Read`, `Grep`, `Bash` (git only).

## Standing security rule

Any third-party Skill or plugin you review is **untrusted**: read it
statically; never run its scripts; note any script that executes shell,
fetches URLs, or writes outside its directory. Same verdict vocabulary as
`docs/research/01-*`. Copy nothing. No personal identifiers in the repo.

## Questions to answer, with sources

### A. Mechanisms — ESPN deltas only
Cite the sibling for the mechanisms. Add only what differs here:
1. **Confirmation gate for unofficial write endpoints.** ESPN writes are
   possible (03 §E) but carry account risk and are off by default. Specify
   how the gate composes with an **opt-in module**: tools not registered
   unless `EFF_ENABLE_WRITES=true` *and* the setup command recorded an
   explicit acknowledgement; `prepare_*` never touches ESPN; `commit_*`
   requires the diff-bound token; elicitation layered where the client
   supports it; the Skill that is the only caller. Include the roster-lock
   and waiver-window preconditions ESPN enforces (from 03).
2. **Session-cookie failure UX** as an MCP concern: what a tool returns
   when `espn_s2` is invalid (structured `isError` with a next step, never
   the cookie), and whether a resource `espn-ff://status` or a
   `ff_get_status` tool carries "cookie valid: yes/no, age, last check".
3. **ESPN free text inside fact JSON** (player news/outlook, team names,
   member display names): the `untrusted_text` envelope must apply
   field-by-field inside otherwise trusted responses. Say how.

### B. The split — apply the criteria to ESPN
Take the sibling's B.1 criteria as given (or amend with reasons). Apply
them to **every capability row in `03-espn-api.md`** (league settings,
rosters, matchups, live scoring, free agents with `X-Fantasy-Filter`,
ESPN projections, ownership/% started, ranks, injury status, news text,
transactions/pending waivers with waiver order, draft, pro-team
schedules, writes) and to **every decision type in `05-*`** (the
format-specific ones especially: move-to-last waiver priority, points-for
seeding, 5-pt TD QB valuation, IR-slot policy). Name the arguable
placements and why they landed where they did.

### C. Naming and consistency with the sibling — decide, with a table
**Coordination rule:** the `architecture-planner-core` agent (running in
parallel) owns the shared-core and naming decision and commits it early
in `docs/plan/01-system-architecture.md` §0. Check for that file first
(`git pull --rebase origin main`). If the decision is there, take it as
given and produce only the crosswalk table and the Skill-level
consequences; if it is not there yet, write your recommendation as input
for the planner and label it as such.

The sibling plan chose platform-neutral tool names (`ff_<verb>_<resource>`,
server `fantasy-football-mcp-server`, resources `ff://…`, prompts
`ff.<workflow>`) because of a future ESPN seam. This project *is* that
seam. Evaluate the three options and recommend one for the plan:
(a) **one shared core + provider adapters** (one server binary, platform
chosen per league by config; tool names `ff_*` identical); (b) **two
servers with a shared npm package** for `nfl_*`/`proj_*`/analytics and
Skills, platform tools prefixed `espn_*` / `yahoo_*`; (c) **independent
repos**, conventions aligned by hand. Consider: tool-name collisions when
both servers are installed in one client (how Claude Desktop and Claude
Code namespace tools — verify), prompt-cache and `tools/list` size, Skill
trigger ambiguity ("set my lineup" — which league?), release coupling,
and Chad's instruction that the two projects must not be coupled without
a recommendation. Produce the tool-name crosswalk table: sibling name →
ESPN name (or "same").

### D. The Skills catalog for ESPN
Start from the sibling's 14 and the candidates in
`docs/research/00-tooling-inventory.md`; keep the sibling's **names and
procedures** where identical; add ESPN/format-specific Skills; cut what
does not earn its place. Expected additions (justify or reject each):
`waiver-priority-strategy` (move-to-last: claim-vs-wait decision, the
Tuesday/Wednesday workflow), `points-for-seeding-strategy` (or fold into
start/sit + season planning — decide), `espn-session-troubleshooting`
(cookie expiry, `doctor`, re-setup), `league-settings-onboarding` (read
settings, validate the scoring engine against last week's actual scores,
confirm the format in plain English), `post-week-retrospective`,
`ir-slot-management` (2 IR slots; fold or keep?), `draft-assistant`
(redraft only; season already underway — in scope for next year?).
For each Skill: **purpose**; **trigger** (description text; what must NOT
trigger it); **tools called, in order**; **inputs** (asked vs fetched);
**output contract** (recommendation + uncertainty + "what would change my
mind" + `as_of`); **guardrails**; **evals** — ≥ 3 concrete cases each
with expected behaviour, including at least one prompt-injection case
per Skill that reads free text, runnable against anonymized ESPN fixtures
(skill-creator eval format).

### E. Repo layout, packaging, versioning, evals in CI
Recommend the `skills/` layout, the plugin manifest (server + Skills +
prompts in one installable unit; the repo as its own marketplace), the
compatibility rule between Skill versions and the server's tool-contract
version, install paths for Claude Code vs Claude Desktop vs copy-install,
and which evals run with zero tokens (structural/fixture checks) vs with
tokens (model-graded, manual). Where the sibling already decided this,
say "same" and cite.

**A clean negative is a real result.** If a candidate Skill is a tool in
disguise, say so and move it. If no ESPN-specific Skill exists publicly
(search GitHub, plugin marketplaces, skill registries — list the searches),
say so by name.

## Deliverables (you own these paths; touch nothing else)

1. `docs/research/06-skills-and-mcp-design.md` — sections A–E with the
   catalog, the naming decision and crosswalk table, sources inline,
   unverified items at the end.
2. `docs/scratch/skills-mcp-researcher.md` — working notes with `## RESUME HERE`.

**Do NOT touch**: `README.md`, `.gitignore`, `.env.example`,
`docs/research/00-*` through `05-*`, anything in `docs/plan/` (the
`architecture-planner-core` agent is writing there in parallel),
`docs/scratch/roster.md`, `docs/scratch/program.md`, `docs/scratch/briefs/`.
Leave any file you did not create exactly as you find it.

## What a FAILED report looks like

- Restating the MCP spec instead of citing the sibling and deciding the ESPN deltas.
- A catalog with purposes but no triggers, no tool order, no evals.
- Skills named differently from the sibling for the same procedure without a reason.
- The shared-core question answered by preference instead of by the collision/namespace evidence.
- Findings that exist only in your reply and not in the pushed file.
- A reply without the pushed SHAs.

## COMMIT/PUSH DISCIPLINE — Chad's standing rule, non-negotiable

**No work you do may be lost.**
- **Your FIRST action is** `docs/scratch/skills-mcp-researcher.md` with a
  `## RESUME HERE` section — commit and push it before any real work, and
  keep it current.
- **Commit and push to `origin/main` at every natural checkpoint** — after
  each section A–E lands, not once at the end.
- **Before you are torn down, blocked, or run low on context, COMMIT AND
  PUSH FIRST, then reply.**
- **Track your remaining budget.** At roughly **20% context remaining**, stop
  taking on new scope: commit, push, update `## RESUME HERE`, reply.
- **Preserve unfinished work on `origin` as a PATCH, never as broken files**:
  `git diff -- <your paths> > docs/scratch/skills-mcp-researcher.wip.patch`
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
  `docs(research): skills/mcp — ESPN split and naming decision (A–C)`,
  ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Commit identity is already configured locally in this repo. Do not change
  git config.

## Reply format

When done: (1) the pushed SHAs, (2) the naming/shared-core recommendation
in three lines, (3) the final catalog as a one-line-per-Skill list marking
each `same as sibling` / `ESPN-specific` / `format-specific`, (4) the
confirmation + opt-in mechanism in three lines, (5) the unverified list,
by name.
