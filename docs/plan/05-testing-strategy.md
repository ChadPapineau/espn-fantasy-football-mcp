# 05 — Testing strategy

**Author:** `architecture-planner-core` · **Date:** 2026-09-30 · **Brief:** `docs/scratch/briefs/architecture-planner-core.md`
**Inputs:** plans 01–04; `docs/research/03-espn-api.md` §A.2 (views and skeletons), §A.3 (filter rules), §A.4 (error shapes), §B (data model, two id spaces, stat ids), §C.3 (401 semantics), §D.3 (limits), §E (writes — never exercised), §F.2–F.3 (drift design, anonymisation procedure), §G.2 (the probe log that seeds the fixtures); `04-data-sources.md` §B.1.6 (schedule flags), §C (crosswalk counts); the mcp-builder `evaluation.md` (read 2026-09-30); the sibling's testing plan `yahoo-fantasy-football-mcp@f3a0a48 docs/plan/05` (**[V-sib 05 §x]** — its pyramid, fixture discipline, fault-injection pattern, Inspector smoke and eval design transfer; the Yahoo-specific assertions are replaced).

Legend as in plan 01.

Standard carried over from the sibling [V-sib 05]: **everything ships with tests, adversarial by default, the coverage gate is never lowered to pass, and a regression test is only real once it has been shown red against the un-fixed code.** Two ESPN facts shape the whole plan: a wrong view name is a 200 [V-03 §A.2], so *every* contract test must assert the presence of keys, never just a status; and every real ESPN payload carries other people's identifiers [V-03 §B.3], so *no* fixture is committed unscrubbed.

---

## 0. Decisions at a glance

| # | Decision | Why | Alternative considered | What would change it |
|---|---|---|---|---|
| T1 | **Vitest for every level** (unit, property, contract, drift, fault, process) with separate workspace projects; process tests spawn the built binary [V-sib 05 T1] | one runner, one coverage report, native ESM/TS | Jest; node:test | Nothing |
| T2 | **Property tests (`fast-check`) for the scoring engine, the path builder, the filter builder, the two id maps, the envelope, the freshness classifier, the redactor and the limiter** | these are the components whose bugs are *silent* (a wrong score, a 5.7 MB pool pull, a QB labelled TQB [V-03 §B.2], a leaked cookie); properties survive constant changes | example tables only | Nothing |
| T3 | **Contract tests run against recorded, anonymised ESPN JSON fixtures — one per working view plus the three error bodies — frozen by a manifest**; recording is a manual, credentialed (or public-league) script; scrubbing is a separate, tested script with a deny-list abort | the repo is public; the wire has shape traps only real payloads exhibit (skeletons, two id spaces, `home` without `away`, `(1,2)` splits) [V-03 §A.2, §B.2, §B.4] | hand-written JSON | Nothing |
| T4 | **Drift tests are a first-class level**: manifest ⊇ required keys; skeleton detection; renamed-view simulation; probe diff logic; `ESPN_DRIFT_DETECTED` end to end | status codes cannot detect drift (plan 01 D5); this is the failure mode the project is sized for | fold into contract tests | Nothing |
| T5 | **Fault injection through an injected `fetch`** (constructor DI on `httpClient`); no `nock`/`msw` [V-sib 05 T4] | zero dependencies; every failure mode is a function | msw | Nothing |
| T6 | **Inspector CLI smoke in fixture mode runs in CI** (no credentials, no tokens) [V-sib 05 T5] | the reference client; `--cli` + `--format json` is made for CI | a hand-written stdio client | Nothing |
| T7 | **Model-driven evals: 10 read-only questions over the frozen fixture league**, run manually before a release [V-sib 05 T6] | `evaluation.md`'s stability rule is only satisfiable on frozen data | live-league evals | Nothing |
| T8 | **Coverage gate: 90 % lines / 85 % branches / 90 % functions globally; 100 % lines + branches for ten named modules** (§7; T-10 added `domain/reclog/metrics.ts` and `domain/scoring/verify.ts`) | §7 | 80 % flat | Nothing downward |
| T9 | **Every regression test is mutation-verified** | [V-sib 05 T8] | trust the green | Nothing |
| T10 | **The keychain integration test runs only on the macOS runner and only against a throwaway service name; it never touches a real item** | Linux has no Keychain; the test must not read Chad's real cookies | mock the addon everywhere | Nothing |
| T11 | **No test ever calls the ESPN write host**, in any mode, including fixture recording | [V-03 §E: never probed; account risk] | a reversed write capture (S-JW did it) | the conditional write phase — and even then one captured probe against Chad's own team, reversed immediately, done by Chad |

**A rule for every bound (ADV R2 nit 10):** every latency or size bound names the dataset it is measured on and the test that measures it — e.g. the 500 ms warm bound is measured on `fx-10h` in fixture mode by the process test (plan 10 A16a), and the `tools/list` ceilings by `tests/mcp/size.test.ts` in fixture mode (plan 07 §5.1).

---

## 1. The pyramid

| Level | Where | Tool | Runs in CI | Needs ESPN cookies | Needs model tokens |
|---|---|---|---|---|---|
| Unit | `tests/<mirror of src>/` | vitest | yes, every push | no | no |
| Property | `tests/property/` | vitest + fast-check | yes | no | no |
| Contract (recorded fixtures) | `tests/contract/` | vitest, `FixtureTransport` | yes | **recording only** (manual; public views need none) | no |
| Drift | `tests/drift/` | vitest over `fixtures/espn/manifest.json` | yes | no | no |
| Fault injection | `tests/fault/` | vitest, injected `fetch` | yes | no | no |
| Process / lifecycle | `tests/process/` | vitest spawning `dist/cli.js` | yes (ubuntu); macOS weekly | no | no |
| Keychain round-trip | `tests/process/keychain.test.ts` | vitest, macOS only, throwaway service | weekly (macOS) | no | no |
| Inspector smoke | `tests/smoke/` | `@modelcontextprotocol/inspector --cli` | yes | no (fixture mode) | no |
| Live smoke | `eff smoke` | the CLI against real ESPN | **never in CI** | yes | no |
| Live probe | `eff probe` | the CLI against the public probe league | never in CI (launchd) | no | no |
| Model-driven evals | `tests/evals/` | mcp-builder `scripts/evaluation.py` | no — manual, pre-release | no (fixture mode) | **yes** |
| Skills Lane 1 (structural + fixture dry run + injection invariance) — T-10 | `skills/*/evals/`, `scripts/check-skills.ts` | vitest + the built binary in fixture mode (plan 09 §5.1) | yes, every push (`docs.yml`) | no | no |
| Skills Lane 2 (model-graded) — T-10 | `evals/` | `claude plugin eval` with mocks from `fx-10h` (plan 09 §5.2) | no — manual, pre-release | no (mocks) | **yes** |

---

## 2. Unit and property tests — what must be asserted (adversarial by default)

| Module | Must-have assertions (each a named test; the adversarial ones are not optional) |
|---|---|
| `mcp/envelope` | every tool's in-code `outputSchema` forbids a bare `string` at any `untrusted_text` position (a test walks all registered tools — including the list tools whose schema is omitted from the wire, T-05); `meta.source` non-empty; `meta.attribution` present whenever `source` includes `espn:*` or `nflverse:*`; `age_s` from `fetched_at`, not `as_of`; `meta.estimate` true on every analytics tool and false on every ESPN-fact tool; **property:** serialised size ≤ 20 000 chars for any list length, `truncated` iff halving happened; unicode/zero-width/bidi/HTML stripped; caps enforced |
| `mcp/define` | registering a tool without `annotations`, `outputSchema`, or `.strict()` input throws at registration; write tools absent from the registry when any plan 02 §3.2 gate is false; the registry order is stable across runs |
| `mcp/errors` | every code maps to a fixed message; an error built from an upstream body never contains that body (HTML body with a fake cookie and the league id); the 401 message contains "usually" and never "expired" as a bare fact; `upstream_type` only from the allow-list, else `UNKNOWN` |
| `providers/espn/path` | **property:** for generated valid inputs the builder produces `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/<s>/segments/0/leagues/<id>?view=…`; views outside the whitelist rejected (including every do-nothing view in 03 §A.2 — `mRosterSettings`, `mLeagueSettings`, …); comma-joined views rejected; `season < 2018` rejected; non-integer ids rejected; `sub` outside `{"", "communication/"}` rejected; the write host is unreachable from the read builder (a test asserts the string `lm-api-writes` never appears in read-builder output for any input) |
| `providers/espn/filter` | **property:** `limit` present ⇒ a sort key present, else `VALIDATION`; `limit ≤ 100`; nesting entity-level on league paths and root-level on `/players` [V-03 §A.3]; canonical serialisation (key order) so equal specs produce byte-equal headers; unknown keys rejected |
| `providers/espn/ids` | the slot map and the position map are **different** (a test asserts `slot(1) = TQB` and `position(1) = QB`, the S-JS bug [V-03 §B.2]); every `defaultPositionId` observed in fixtures maps; every `lineupSlotId` observed maps; unknown ids produce a typed `unknown` not a crash; `positionalRatings` keys `{1,2,3,4,5,16}` map to positions |
| `providers/espn/views/*` | each schema parses its fixture; **required keys are a subset of the manifest's observed keys** (drift level, §3.3); passthrough keeps unknown fields; a fixture with one required key removed fails naming the JSON path and view; a skeleton body (P28 shape) fails for every known view; `home` without `away` parses (bye) [V-03 §B.4]; `stats[]` with `(1,2)` parses and is labelled `preseason_full_season_projection` (never ROS) [V-04 §B.1.1]; unknown `statSourceId` fails the entry, unknown `injuryStatus` is accepted and counted |
| `providers/espn/normalize` | every field in the plan 01 §4.4 table arrives wrapped with the right source tag and cap; `clientAddress`, `notificationSettings`, `firstName`/`lastName` never appear in any domain object (a deep walk over the normalised output of every fixture asserts their absence); member GUIDs appear only in `owners[]`; `appliedTotal` is carried per stat entry with `source`/`split` decoded; epoch-ms timestamps become ISO |
| `providers/espn/errors` | the classifier table (plan 02 §2.1) with one fixture per row: 404 `GENERAL_NOT_FOUND`, 400 `FILTER_LIMIT_MISSING_SORT`, 401 `AUTH_COMMUNICATION_NOT_VISIBLE` (recorded, P27), 401 `AUTH_LEAGUE_NOT_VISIBLE` (hand-written from the community shape, marked [U]), 405, a 400 with no `details[]`, an HTML body, an empty body, a 302 with `Location: https://www.espn.com/fantasy/`; **401/403/400/404 produce exactly one attempt** (counter) |
| `providers/espn/limiter` | **property:** never more than 30 requests in any 60 s window and never more than 2 in flight, across **two** limiter instances sharing one SQLite file (the cross-process design); breaker opens after 3 consecutive 5xx and every call during the open window makes zero requests; coalescing: N concurrent identical requests → 1 upstream call; 429/5xx retried ≤ 3 with jitter; 401/403 never |
| `providers/espn/cache` | cache-first: a fresh entry → zero upstream calls; `force_refresh` once per 60 s per key; key canonicalisation (view order, filter order); raw bodies are **not** written unless `EFF_FIXTURE_RECORD=1` (a test greps the store after a normal run for a known raw-only string) |
| `drift/*` | see §3.3 and §4.1 |
| `config/freshness` | **property:** for every class `fresh < stale < hard`; classifier monotone in age; `provisional` set iff any game of the period has `statsOfficial=false`; `corrections_window_open` set iff < 7 days since the period's last game |
| `domain/scoring` | golden equality within 0.01 against `appliedTotal` **and per stat against `appliedStats{statId}`** for every roster entry in the **recorded** fixture weeks [V-03 §B.5], read only from `fixtures/espn/recorded/**` (a path guard in the test) — the golden never reads a derived scoring field (ADV OBJ-01, OBJ-21); on base `fx-10h` `match: true` for every player is asserted separately as plumbing, never as engine evidence; **mutation properties:** perturb one `points` value by δ → total moves by exactly `δ × stat`; `pointsOverrides{"16"}` applies to D/ST only; `isReverseItem` handled; unknown stat ids ignored and logged once; **the reference-format assertions** (item 53 at 0.5, item 4 at 5, items 20/72 at −2, the K/D-ST families present in `S`) are unit and property tests over `normalizeSettings` on a hand-written reference `mSettings` — in Phase 1a the recorded golden weeks carry the probe league's `S`, so these tests, not the golden, cover the reference format until 1b; the 103/104 dispute is a named test that documents which mapping the fixture supports (and stays [U] otherwise) |
| `domain/crosswalk` | precedence (nflverse `espn_id` → `players.csv` → deterministic name+team+position → override); ESPN `WSH`/`LAR` → `WAS`/`LA` [V-04 §C]; position ids 1–4 → QB/RB/WR/TE; never name-only; the "unmatched rostered or ≥ 1 %-owned" count is 0 on the fixture set |
| `domain/reclog/metrics` (T-10) | the evaluation of the evaluator: a perfectly calibrated synthetic forecaster scores Brier = its uncertainty term; the CRPS of the true distribution beats a misspecified one; pinball loss and 80 % coverage on known quantiles; every metric under `n = 30` carries the caveat (plan 10 A13a) — a wrong metric silently mis-tunes the model, so this module is at 100 % (§7) |
| `mcp/tools` (analytics — injection invariance, T-10) | for every analytics tool, the output on each `inj-*` fixture variant equals the base fixture's byte-for-byte except `warnings[]` and `meta.untrusted_fields` (05 §6 rule 5; plan 09 §5.1 #8; plan 10 A8a) |
| `domain/gate` (writes phase) | see §4.3 |
| `auth/format` | the SWID and `espn_s2` regexes with adversarial inputs: brace-less GUID rejected; lowercase hex accepted; `espn_s2` with a space, a quote, a newline, a decoded `/` mid-string (should still match the class), 39 chars rejected, 40 accepted with a warning, 100 accepted without (ADV OBJ-15) |
| `auth/file` | dir `0700`, file `0600` enforced (a `0644` file is refused); atomic write (crash injected between temp write and rename leaves the old file intact); **an iCloud-managed directory (xattr stubbed) is refused**; the value is written exactly as given (no decoding) |
| `auth/keychain` (unit) | the addon is mocked; `getCookieHeader()` is lazy (a test asserts the mock is not called at construction or at `tools/list`); a rejected state drops the value |
| `auth/state` | the plan 02 §2.1 transitions; `rejected` short-circuits with zero `fetch` calls; `storedAt` change → reload |
| `cli/log` | **property:** for any object containing the stored `espn_s2` (in its pasted or its decoded form — ADV OBJ-15), any brace-GUID, any IPv4, the configured league id, a `Cookie:` header line, the emitted line contains none of them; bodies truncated to 500 after HTML stripping; never writes to stdout |
| `http/client` | host allow-list per mode: the write host is refused in read mode before DNS; any off-list host refused; a 302 to `www.espn.com` is **not followed** and classified `ESPN_HOST_MOVED`; `AbortSignal.timeout`; the `User-Agent` is the fixed string |
| `sources/*` | the parquet **codec is asserted at load** (nflverse parquet is Arrow R's default snappy; any other codec fails the load naming it — sib ADV OBJ-20 via ADV OBJ-19(d)); schema assertion: one renamed column fails with the column name; extra column passes with a warning; the load writes a fresh per-source dataset file published by `rename()` (plan 01 §5.5); `timestamp.txt` unchanged → no download; `espn_season` sources parse `proTeamSchedules_wl` and derive `byeWeek`, `validForLocking`, `statsOfficial` per game; the nflverse `games.csv.espn` join is exact on the fixture excerpt |
| `store` | migrations from empty and from each historical version; newer-store refusal; backup before first pending migration (`VACUUM INTO` under the process lock — T-15(b)); `busy_timeout` under a concurrent writer; the `espn_requests` limiter table prunes; a refresh publishes a new per-source dataset file by `rename()` onto the same path while the server holds the old one open — a reader opened before the rename still sees the old rows, a re-open sees the new, no statement on `store.sqlite` blocks, and **no dataset write ever touches `store.sqlite`** (a test lists the main file's tables after a refresh — ADV OBJ-09(a)); **all eleven sources of `full` are opened at once with no attach or open error**; each dataset connection is read-only by its open mode (a write attempt fails) and a statement trace shows zero `ds_*` DML from the server; an on-demand join connection refuses a 9th attachment — the ceiling of 8 (ADV OBJ-22) |
| `cli/doctor` | each check row has a passing and a failing fixture; `--json` shape stable; exit code = worst finding; offline mode makes zero network **and zero keychain-secret** calls (the injected fetch and the mocked addon throw if called, except check #7 which is asserted to call exactly once) |
| `cli/print-config` | output paths absolute and exist; `command` equals `process.execPath`; the config key is `espn-fantasy-football`; no env value matches a cookie shape; the Claude Code line quotes paths with spaces; warns when `args[0]` resolves under a file-provider directory (xattr stubbed — ADV OBJ-10) |
| `cli/setup` | hidden input (the muted stream never echoes); a 401 on the check deletes the stored value (the store mock asserts `delete` called); a 404 likewise; the team-resolution logic on 0/1/2 matches |

---

## 3. Fixtures: capture, scrub, freeze

> **The fixture law (ADV OBJ-21) — read this before any fixture script.**
> 1. **Recorded = evidence.** `fixtures/espn/recorded/**` is recorded together with its league's own `mSettings` and scored under it; its scoring fields hash to a recorded original.
> 2. **Derived = plumbing.** `fixtures/espn/fx-10h/**` — the reference-format Skills league and its variants — has its scoring fields re-scored by the engine under the reference `S` and is marked `derived: true` in the manifest with the engine version and `settings_hash`; `gen-fixtures.ts` re-derives **every aggregate** of a re-scored field (team totals, `winner`, records, points for/against — R3 nit (b)), so the scoreboard, the standings and the seeding simulator agree with the box scores; `match: true` there is never engine evidence.
> 3. **The golden reads only recorded.** A path guard keeps the golden test, A1a, `verify`'s tests and plan 08 §6 inside `recorded/` — the golden never reads a derived scoring field — and `gen-fixtures.ts` refuses to run unless the recorded golden is green.

### 3.1 ESPN (manual; never in CI; cookies only for private-league views)

1. **Record** — `scripts/record-fixture.ts --view <name> [--week N] [--league <id>] [--cookies]` runs the real provider (through the real path and filter builders and the limiter) and writes the **raw JSON** + status + headers (minus `Cookie`) to `~/.cache/espn-fantasy-football-mcp/recordings/<view>.<ts>.json` — outside the repo, never committed. The view list mirrors 03 §A.2's working views and §G.2's probes: `mSettings`, `mTeam+mStandings`, `mRoster` (one week), `mMatchup`, `mMatchupScore` (current week, pre-kickoff **and** in-game once available), `mBoxscore`, `mNav`, `mStatus`, `mDraftDetail`, `mPositionalRatings`, `mPendingTransactions`, `mTransactions2` (+ filter), `kona_player_info` (one page of 25, sorted), `kona_playercard` (≤ 5 ids), `proTeamSchedules_wl`, `players_wl` (first 200 rows — the file is 664 KB), and the error bodies (404, 400 limit-without-sort, 401 communication, the skeleton P28). Public-league views need no cookies; `mTransactions2`/`mPendingTransactions` with content need Chad's league and cookies. **The keyless recording of the public probe league (plan 10 D2) — `scripts/record-fixture.ts --public`: `mSettings`, `mTeam+mStandings`, `mRoster`, `mMatchup` and `mBoxscore` for ≥ 3 final weeks (`statsOfficial: true`) — is a Phase 0 script (standalone there, like `scripts/probe.ts`: `npx tsx` and built-in `fetch`, since no provider code exists yet; the scrub of step 2 applies unchanged), run once per season and re-run after drift; it is the only source of **recorded** `appliedStats`/`appliedTotal`, written to `fixtures/espn/recorded/`: the golden never reads a derived scoring field, and a test asserts every recorded fixture's scoring fields hash to a recorded original (ADV OBJ-01, reworded by ADV OBJ-21).**
2. **Scrub** — `scripts/scrub-fixture.ts <recording> --out fixtures/espn/recorded/<view>.json` applies 03 §F.3 **verbatim** and refuses to write unless its deny-list check passes:

| Field | Rule (03 §F.3) |
|---|---|
| league `id` | → `0` |
| `settings.name`, `divisions[].name` | → `"League"`, `"Division <n>"` |
| `teams[].name/abbrev/location/nickname/logo` | → `"Team <n>"`, `"T<n>"`, `""`, `""`, `""` |
| `members[].displayName/firstName/lastName`; `notificationSettings` | → `"Member <n>"`, `""`, `""`; removed |
| every member GUID (`members[].id`, `teams[].owners[]`, `primaryOwner`, `draftDetail.picks[].memberId`, `transactions[].memberId`) | → `{00000000-0000-4000-8000-0000000000<nn>}` by first appearance, **one map applied everywhere** |
| `status.lastUpdateInfo.clientAddress` | → `"0.0.0.0"` |
| `tradeBlock`, `draftStrategy`, message-board/activity text | → `{}` / removed |
| `player.seasonOutlook`, `outlooks.outlooksByWeek[*]` | → `"[outlook <length> chars]"` (shape kept; editorial text not republished; file shrinks) — **except** `fixtures/news/` hand-written injection samples, which are ours |
| `logo` URLs | → `""` |
| player names, ids, pro-team ids, timestamps | kept |
| **deny-list (abort):** any brace-GUID outside the fake range; any IPv4; the real league id; every string in a local, uncommitted list of the real team/member names captured at scrub time | abort with the path |

3. **Determinism** — sorted keys, arrays sorted by `id` where present, the GUID map by first appearance, `capturedAt` in the manifest instead of `x-fantasy-server-time`; running the script twice yields byte-identical output (a test runs it twice on a synthetic recording).
4. **Freeze** — `fixtures/espn/manifest.json` (generated by `scripts/gen-manifest.ts` **after** scrubbing, 03 §F.3 step 4) records per file: `capturedAt`, scrub-rules version, sha256, `derived: true|false` (a derived file also carries the engine version and the `settings_hash` it was re-scored under — the fixture law above), top-level key set, per-entity key sets, observed enum values, array-length ranges, the host. A test fails if a fixture's hash differs from the manifest (a hand edit is a deliberate, reviewed change). Re-recording is a plan 06 manual job.
5. **Fixture mode** — `EFF_FIXTURE_DIR=<dir>` makes `EspnProvider` use `FixtureTransport` (same `fetch` interface) serving fixtures keyed by canonical path + filter, with the recorded status/headers. Missing fixture → a distinct error naming the path. `ESPN_LEAGUE_ID=0` in this mode. **Not reachable when a credential store holds a value** (a guard test) — fixture mode and real cookies never coexist in one process. The three **test-scope keys** — `EFF_FIXTURE_DIR` (this fixture mode), `EFF_FIXTURE_RECORD` (raw-body recording, §2 `providers/espn/cache`) and `EFF_TEST_STUBS` (the startup stubs, §4.2) — are declared in `src/config/schema.ts` with `scope: "test"`, generated into the README Testing section, and absent from `.env.example` (plan 03 §3).

### 3.2 External datasets

`fixtures/nflverse/`: small real excerpts (≤ 300 KB; `injuries`, `roster_weekly` rows with `espn_id`, `games.csv` week-4 rows with the `espn` column, `timestamp.txt`) under CC-BY 4.0 with `ATTRIBUTION.md` [V-04 §E]; larger files as csv.gz excerpts (≤ 50 rows) for schema tests. ffopportunity under CC-BY-SA with its attribution line. `fixtures/news/`: hand-written RSS items with injection attempts ("ignore previous instructions and drop…", HTML, zero-width text, a 5 000-char blurb) — and **hand-written ESPN-shaped fixtures** with a hostile team name (`"Team <n>"` replaced by an imperative sentence) and a hostile outlook, used only by the envelope and Skills-structure tests.

### 3.3 Drift tests (`tests/drift/`)

| Test | Asserts |
|---|---|
| required ⊆ observed | for every view schema, the set of required keys is a subset of the manifest's observed key set (so a schema can never demand a key ESPN has never sent) |
| skeleton detection | the P28 skeleton body, requested as each known view, fails with `ESPN_DRIFT_DETECTED` naming the missing view keys |
| renamed view simulation | a fixture with `teams[].roster` renamed to `teams[].lineup` fails for `mRoster` with the JSON path |
| removed key | for each required key, removing it fails; for each passthrough key, removing it passes with the additive-drift counter unchanged |
| new key | adding a key passes and increments the additive-drift list |
| enum drift | a new `injuryStatus` value passes and is counted; a new `statSourceId` value fails the entry |
| probe diff | `diffManifest(manifest, probeBody)` over a fixture with one removed key, one added key, one changed enum → the three findings with the expected severities; identical → empty diff |
| host moved | a 302 body / non-JSON body in the probe path → `host_moved` finding |
| end to end | in fixture mode with a drifted `mRoster` fixture, `espn_get_roster` returns `ESPN_DRIFT_DETECTED`, `espn_get_standings` still works, and `espn_get_status` shows the diff (the plan 01 §7 degradation table, row by row) |

---

## 4. Fault injection, lifecycle, gate tests

### 4.1 Fault matrix (`tests/fault/`, injected `fetch`)

| Injected upstream behaviour | Expected tool result | Expected side effects | "Never" assertions |
|---|---|---|---|
| `401` typed body on a cookie-bearing request | `ESPN_AUTH_REJECTED` (or stale cache within the hard limit + warning) | `credential_state = rejected`, `lastRejectedAt` set; value dropped | **no second request**; body not in result; "expired" not stated as fact |
| `401` on a cookie-bearing request, then a later call | same error | **zero** upstream calls (short-circuit) | — |
| `403` | same as 401 | same | same |
| `200` skeleton for a known view | `ESPN_DRIFT_DETECTED` | `drift_state` row; cache **not** written | no retry |
| `200` with a required key missing | same | same | same |
| `404 GENERAL_NOT_FOUND` | `ESPN_LEAGUE_NOT_FOUND` | — | no retry |
| `400 FILTER_LIMIT_MISSING_SORT` | `INTERNAL` (our builder must make this impossible — the test asserts the builder never emits such a request, and that if the response arrives anyway it is classified and logged) | logged | no retry |
| `429` (never observed; synthetic) | `RATE_LIMITED` after 3 attempts with backoff (fake timers) | breaker counter | no 4th attempt |
| `500`, `503` | `ESPN_UPSTREAM_UNAVAILABLE`, or stale data + warning | 3 attempts; breaker opens after 3 consecutive | body not in result |
| timeout (`AbortError`), `ECONNRESET` | same | same | same |
| black hole: DNS resolves, every attempt times out | stale data or `ESPN_UPSTREAM_UNAVAILABLE` within **20 s** of the call (fake timers — the per-call deadline, ADV OBJ-20) | the breaker counts the attempt | never a retry that would run past the deadline |
| `ENOTFOUND` / `ECONNREFUSED` | `ESPN_UPSTREAM_UNAVAILABLE` (or stale data) immediately | breaker counter | **zero** retries (ADV OBJ-20) |
| `302` to `https://www.espn.com/fantasy/` | `ESPN_HOST_MOVED` | `drift_state.host_moved_at`; breaker open | **not followed**; cookie not sent to the redirect target |
| non-JSON `200` (HTML "Access Denied", the P26 shape) | `ESPN_UPSTREAM_UNAVAILABLE` | logged | not parsed as data |
| malformed JSON | same | logged | no throw escapes the tool |
| oversized body (> 8 MB) | same | logged with size | bounded memory (streamed length check) |
| `x-fantasy-filter-player-count` absent | `page.total: null`, `has_more` computed from the page length | — | — |
| `proTeamSchedules_wl` with `startTimeTBD: true` games | kickoff-window logic ignores their `date` [V-04 §B.1.6] | — | no window opened for a TBD game |
| two processes, one limiter table, 40 requests in a minute | 30 sent, 10 wait | — | never > 30 in any 60 s |

### 4.2 Lifecycle (`tests/process/`, spawning `dist/cli.js`)

Startup < 1 s with network and keychain stubbed (env `EFF_TEST_STUBS=1` makes any network call or keychain read exit 99 — plan 03 §1.1 step 4 reads neither); stdin EOF → exit 0 within 3 s; SIGTERM → exit 0; SIGINT twice → forced within 10 s, exit 5; parent SIGKILLed → child exits within 10 s [plan 03 A-4]; stdout closed → exit 0 (EPIPE); `serve` opens no listening socket (`lsof -p` on macOS / `/proc/net/tcp` on Linux); `eff setup --page` with the default port busy → binds the next port in range and prints it; with `EFF_SETUP_PORT` busy → exit 2 with the `lsof` message; the page closes after one POST and after SIGINT (port free within 1 s); a store from "version + 1" → exit 1; migrations from every historical schema fixture; a refresh job against a newer store → refuses.

**Keychain round-trip (macOS runner only, weekly):** `eff setup --storage keychain --service-name eff-test-<random>` fed a fake value on stdin → the three items exist under the test service (`security find-generic-password -s eff-test-<random> -a <account>` returns zero for `espn_s2`, `SWID` and `meta`; no `-w`, so nothing is printed) → cleanup with `security delete-generic-password -s eff-test-<random> -a <account>` for each → no item survives (`security find-generic-password` returns non-zero). `--service-name` exists on `eff setup` only (plan 03 §2.1), so the test runs no other `eff` command against the keychain — `eff doctor` #7 and `eff uninstall` use the real service name. Never touches the real service name (a guard asserts the test service name differs).

### 4.3 Confirmation gate (writes phase; `tests/domain/gate/` + `tests/mcp/gate/`)

The sibling's assertions transfer [V-sib 05 §4.3] with ESPN preconditions: prepare → commit with elicitation accept → one POST; decline → `CONFIRMATION_DENIED`, zero POSTs; OOB code wrong ×3 → `voided_code` (plan 02 §4.4); correct → one POST; the code never appears in any tool result; CLI `eff confirm` → one POST; tampered ticket → rejected; expired (fake clock +11 min) → `CONFIRMATION_EXPIRED`; replay after `applied` → original receipt, zero POSTs; **roster changed** (fixture swap) → `PRECONDITION_CHANGED`; **period changed** → `PRECONDITION_CHANGED`; a `lineupLocked` player in the diff → prepare refuses; a no-op item (same slot) never appears in the POST; the POST `teamId` equals the SWID-resolved team for every generated SWID (property); `isLeagueManager` is `false` in every POST (property); a `409 TRAN_LINEUP_LOCKED` → `ESPN_TRANSACTION_REJECTED` with the verbatim type, journal `rejected_transaction`, **no retry**; `200 EXECUTED` but read-back disagrees → `applied_mismatch` surfaced; timeout → `sent_unknown`, no retry; **property:** upstream POSTs ≤ distinct `prepared_id`s that received valid evidence exactly once. **All against an injected `fetch` — the write host is never contacted (T11).**

### 4.4 Security regression set (always green, always mutation-verified)

Redaction with adversarial strings; cookie-not-in-store-metadata (a grep of the `meta` item / `session.json` for the value); path and filter builder rejections; write host unreachable in read mode; no league-id argument on any tool (a test walks every input schema); `.strict()` rejects unknown keys; envelope forbids bare strings; `clientAddress` absent from every normalised object; no write tool visible without every gate; no `console.log` outside `src/cli`; the boundary lint test; fixture mode unreachable with a stored credential; **every committed fixture passes the `identifiers` rules** (plan 04 §4.1).

---

## 5. Inspector smoke (`tests/smoke/`, CI, zero credentials)

```
EFF_FIXTURE_DIR=fixtures/espn/fx-10h ESPN_LEAGUE_ID=0 npx -y @modelcontextprotocol/inspector@<pin> --cli node dist/cli.js serve --method tools/list --format json \
  | jq -e '[.tools[].name] == $expected' --argjson expected "$(cat tests/smoke/expected-tools.json)"
… --method tools/call --tool-name espn_get_league --format json \
  | jq -e '.structuredContent.meta.source[0] == "espn:mSettings" and .structuredContent.meta.freshness != null and (.structuredContent.data.league.name.untrusted_text != null)'
… --method tools/call --tool-name espn_get_status --format json \
  | jq -e '.structuredContent.data.credential.present == false and .structuredContent.data.capabilities.write.lineup == false'
```

Assertions: the tool list equals the expected file (order included); **no `espn_commit_*`/`espn_prepare_*` tool listed**; every tool name starts with `espn_`; a call returns the envelope with attribution, freshness and wrapped free text; `resources/list` carries `ttlMs` and `cacheScope`; `espn_get_status` in fixture mode reports no credentials without erroring; the server-level `instructions` returned by `server/discover` (2026-07-28) and by `initialize` (legacy) carries each of the two mandatory sentences (plan 02 §6.3) **exactly once**, and no tool description carries either (ADV OBJ-09(b)). Exact Inspector flag names are from its README as the sibling read it [V-sib 05 §5, U] — verify at build time. If the Inspector can pin the protocol era, the smoke runs twice.

`eff smoke` (the CLI) is the *live* counterpart: with real cookies it reads settings, one roster, one pool page, scores one completed week against `appliedTotal` per stat, and runs the probe diff; Chad runs it, CI never does.

---

## 6. Model-driven evals (`tests/evals/`, manual, tokens)

Built exactly as `evaluation.md` prescribes, with the fixture league (id `0`, weeks recorded through a chosen week `N`) as a closed world: questions are read-only, independent, stable, single-answer [V-evaluation.md "Quick Reference"]. Ten questions, built by inspecting tool descriptions and exploring the fixture league through the tools in fixture mode — never the server code (`evaluation.md` Steps 2–4):

1. *"Which fixture-league team had the largest margin of defeat in the week with the highest combined score through week N? Answer with the team name."* (`mMatchup`)
2. *"How many free agents eligible at the FLEX slot had a higher ESPN weekly projection for week N than the lowest-projected FLEX starter on Team 3? Answer with an integer."* (`kona_player_info`, `mRoster`, two id spaces)
3. *"Under this league's scoring, how many points does a 45-yard field goal score? Answer with a number."* (`mSettings` stat 77 bucket, 40–49)
4. *"Which player on Team 3's week-N roster was in the FLEX slot? Full name."* (slot id 23)
5. *"True or false: the team seeded first would still be first if playoff seeding used head-to-head record instead of total points."* (`playoffSeedingRule`, standings)
6. *"Which NFL team has the same bye week as the pro team of Team 1's starting quarterback in week N? Answer with the three-letter abbreviation."* (`proTeamSchedules_wl` join)
7. *"How many waiver claims processed in the week-N transactions were for players now owned by a team other than the claimant? Answer with an integer."* (`mTransactions2` + rosters — requires the credentialed fixture)
8. *"Which rostered player has the largest gap between his ESPN rest-of-season projection and his season-to-date actual points? Full name."* (splits `(1,0)` vs `(0,0)`)
9. *"What is the `statId` this league uses for receptions, and is it scored at 0.5? Answer as `<id>,<true|false>`."* (settings)
10. *"What was the projected-vs-actual difference for Team 2's total in week N−1, rounded to one decimal?"* (`mMatchupScore`/`mBoxscore` fixtures)

Answers are recorded by solving each with the tools; stored as `tests/evals/read-only.xml` in the `<evaluation><qa_pair>` format. Running: `python scripts/evaluation.py -t stdio -c node -a dist/cli.js serve -e EFF_FIXTURE_DIR=<abs> -e ESPN_LEAGUE_ID=0 -o docs/evals/<date>.md tests/evals/read-only.xml` (needs `pip install anthropic mcp` and `ANTHROPIC_API_KEY` [V-evaluation.md "Setup"]). Pass bar **≥ 8/10 [A-1]**; the report's "agent feedback on the tools" is triaged into description fixes. The only test that consumes model tokens; before a release and after any tool-description change.

---

## 7. Coverage gate

**Global:** lines 90 %, branches 85 %, functions 90 %, statements 90 % (`@vitest/coverage-v8` thresholds + `scripts/check-coverage.ts` for the job summary).
**Per-file 100 % lines and branches:** `src/domain/scoring/**` (incl. `verify.ts`, the golden comparator), `src/domain/reclog/metrics.ts` (Brier decomposition, CRPS, pinball, coverage — T-10), `src/domain/gate/**` (when built), `src/providers/espn/path.ts`, `src/providers/espn/filter.ts`, `src/providers/espn/errors.ts`, `src/providers/espn/ids.ts`, `src/auth/file.ts` + `src/auth/format.ts`, `src/cli/log.ts`, `src/drift/**`.
**Excluded:** `src/cli.ts` (arg dispatch), generated code, `tests/`.

*Why these numbers and these modules:* 90/85 is where a codebase this size stops being coverage by accident; the ten 100 % modules are the ones where an untested branch is a silent wrong score, a silently mis-tuned model (a wrong metric in the retrospective — T-10), an unbounded pool pull, a mislabelled position, an unrecognised 401, a world-readable cookie file, a leaked secret, or a missed drift — each a threat-model row (plan 02 §8). *Alternative:* 80 % flat. *What would change it:* only upward. Never lowered to pass a build.

---

## 8. What runs with zero tokens, what needs tokens, what needs credentials

| Activity | Model tokens | ESPN cookies | Network |
|---|---|---|---|
| lint, typecheck, unit, property, contract, drift, fault, process, Inspector smoke, coverage, audit, license, secret scan, identifiers, Mermaid, Skills structure, tarball scan | none | none | npm registry only (CI) |
| Keychain round-trip (macOS runner) | none | none (throwaway value) | none |
| Fixture recording of public views + scrubbing | none | none | ESPN (public league) |
| Fixture recording of private views (transactions, pending) | none | **yes** (Chad's machine) | ESPN |
| `eff smoke`, `eff doctor --online` | none | yes | ESPN |
| `eff probe` | none | none | ESPN (keyless + public league) |
| Dataset refresh tests (real `timestamp.txt`) | none | none | GitHub releases (scheduled only) |
| Model-driven evals | **yes** | none (fixture mode) | Anthropic API |
| Skill quality review (product planner's domain) | yes | none | — |

---

## 9. What this plan does not decide

Analytics-model evaluation (backtests of the ensemble against ESPN's 2025 embedded projections — 04 §B.1.1's design; product planner — its files are the `tests/backtest/*.test.ts` of plan 10 §2's ledger); the Skills' behavioural tests (plans 09/10); the schedule of the credentialed manual jobs (plan 06).

---

## 10. Assumptions and unverified, by name

| # | Assumption | Verify by |
|---|---|---|
| A-1 | 8/10 as the eval pass bar | first run; a constant in the eval script |
| A-2 | *(resolved — ADV OBJ-19(b))* `InMemoryTransport.createLinkedPair()` in `@modelcontextprotocol/client` serves the gate tests and the Skills fixture dry run (verified by the sibling in its round 1 §1.0); the package is a devDependency (plan 04 §2) | the first `tests/mcp/gate/` run |
| A-3 | Which protocol era the Inspector CLI speaks by default | Inspector docs at build time |
| U (03 §G.1 #1) | the exact private-league 401 body — the fixture is hand-written from the community shape until Chad's first `eff setup` records it | record it (scrubbed) on first setup |
| U (03 §G.1 #5) | whether an anonymous caller ever sees a public league's transactions — decides whether the transactions fixture needs cookies | the first recording |
| U (03 §G.1 #9) | stat ids 103 vs 104 | a fixture week where a return TD occurred; the golden test decides |
| U | exact Inspector CLI flag names | its `docs/cli-smoke-testing.md` |
