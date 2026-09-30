# devils-advocate — working notes

Role: attack the plan (docs/plan/01–10) for the from-scratch ESPN Fantasy
Football MCP server. Deliverable: `docs/plan/adversarial-log.md` (one
section per round) plus these notes. I own only those two paths.

## RESUME HERE

- **State: CLOSED.** Round 3 and `## Closing verdict` are written to
  `docs/plan/adversarial-log.md`: OBJ-21..26 all conceded-by-defence, the
  ten round-2 nits taken, nothing pressed; five line-level nits left in
  §3.1 (dataset `journal_mode=DELETE`; re-derive aggregates in the derived
  fixture class; the probe for a public league whose board probe does not
  discriminate; `informative: false` on E13's ESPN-baseline regret; a
  sentence before the launchd-context test). The remainder is marginal and
  the log says so.
- **Totals:** 26 objections over three rounds (1 blocking, 10 significant,
  15 marginal) — all conceded-by-defence (6 with accepted modifications),
  0 withdrawn, 0 pressed; 16 tensions triaged; sibling log carried through
  its round 3.
- **If resumed:** only to verify that the §3.1 nits were taken (a diff of
  `docs/plan/*` against `b4e0588`); no new round is expected. No WIP patch
  exists; nothing of mine is uncommitted.
- **Discipline:** explicit-path staging only; `git pull --rebase origin
  main` before push; never force-push; verify HEAD == origin/main. Do not
  touch `README.md`, `SECURITY.md`, `docs/README.md`, `docs/plan/00-index.md`
  (docs-writer's) or any plan file.

## Reading log

- plans 01–10: read in full (2026-09-30).
- Things to verify in research/primary: (1) HANDOFF says keyring "Safe"?
  plan 02 §7.2 says review "could not be performed"; (2) 03: is `mBoxscore`
  readable anonymously on a public league (golden fixture source)? (3) 03
  §B.6 transactions fields are [V-community] — two-hop for the demand model;
  (4) 04 §B.1.1 the "averaging wins 63 %" claim — what was averaged?; (5) 05
  §1.2 Π table provenance; (6) 03 §C.2 cookie lifetime; (7) 03 §D.3 limits.

## Objection candidates (pre-research; refine after)

- credential-check job deadlock: every job (incl. `credential check`) exits
  without a request while `rejected` → one transient 401 silences the fleet
  until a human acts (plan 06 §1.4 vs plan 02 §2.1). significant.
- keychain-under-launchd fallback → two stores (keychain for server, file for
  jobs) → two `storedAt`s; reload logic undefined; at-rest surface doubled
  (plan 06 §2 A-2). significant.
- `ESPN_HOST_MOVED` "a human updates config" — no host config key exists
  (plan 03 §3; plan 02 S12 constant) → product is a brick after the 24 h hard
  limit until a release; say so (plan 01 §4.3, §7). significant.
- probe covers 3 views; `mBoxscore`/`mMatchupScore`/`kona_playercard` are
  in-call only; manifest has no numeric-range sentinels (plan 01 §7). marginal.
- event loop: 5 s Monte Carlo in-process contradicts plan 03 §1.2 "never
  blocks longer than one SQLite statement" (plan 10 A-2). significant.
- v1 ensemble = 50/50 ESPN mean + trailing nflverse line; the "63 %" cite is
  about averaging *experts*; at P0 no evidence for the weight (plan 07 E1,
  plan 01 D15). significant — verify 04 §B.1.1.
- Π(k,W) both sides hand-set at P0; A9a tests reproduction of the research
  table (circular); no sensitivity/interval on Π (plan 07 E5, plan 10 A9a).
  significant.
- golden gate vacuous if `fx-10h` is *generated from rules* (plan 09 A-2,
  plan 10 A-1) — A1a needs recorded `mBoxscore`; verify anonymous access.
  significant/blocking.
- seeding auto-detection: operator must answer anyway (D1); detection adds a
  request + `both` doubles P0 output by default (plan 07 C12). marginal.
- P0 surface has documented twins: E14↔resource, C3↔row fields, G2↔G1,
  A4↔A3, E3-season deferrable (D15); Desktop pays tools/list per turn
  (plan 07 C3/§5.1). significant.
- A6 transactions fields [V-community] feed the flagship demand model —
  two-hop evidence (plan 07 A6). significant.
- iCloud-managed checkout: `dist/cli.js` + `node_modules` under ~/Documents;
  eviction/dataless files break launch; doctor checks config/cache dirs but
  not `args[0]` (plan 03 §5 #2/#4, §7). significant.
- fnm versioned node path in config; node upgrade → stale absolute path;
  doctor should warn `command != process.execPath` (plan 03 §4.1). marginal.
- redactor: register decoded form of `espn_s2` too (plan 02 §2.3). marginal.
- `espn_s2 ≥ 100` chars refuses a shorter valid cookie [U] (plan 02 §2.1).
  marginal.
- two bundles: "ask only if roster contexts differ" — they always differ;
  wording resolves to always-ask or never-ask (plan 09 §2 orient). marginal.
- `session-check` Skill = the error hint restated (plan 09 §3.7). marginal.
- P1 Skills vs `EFF_TOOLSET=core` default: Skills promise tools the default
  hides (plan 10 D3). marginal.
- format-regression constants (QB1 364.6 …) pinned to revisable nflverse
  data (plan 08 §6 step 5). marginal.

## Tension triage (T-01…T-16) — draft

- T-01 adopt + sharpen (`.mcp.json` uses bare `command: "node"`).
- T-02 adopt. T-03 adopt (+merge T-13 housekeeping). T-04 adopt.
- T-05 adopt + sharpen (keep zod schema in code; omit only from the wire).
- T-06 adopt. T-07 adopt. T-08 adopt.
- T-09 adopt + sharpen (non-TTY refusal is bypassable with a pty; the
  sibling's "unsupported in Claude Code" ruling is the real control).
- T-10 adopt. T-11 dismiss as a non-tension (a note, not a change).
- T-12 adopt. T-13 merge into T-03. T-14 adopt.
- T-15 adopt (a)–(e); (a) carries a cost line (this Mac runs 22.23.2).
- T-16 adopt.
