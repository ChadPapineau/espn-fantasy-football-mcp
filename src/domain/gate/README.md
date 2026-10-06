# `src/domain/gate` — PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; owner decision D11)

This directory holds the **types and markers only** for the confirmation gate of the optional
write module. Nothing here runs. The product is read-only: no code in this build evaluates a
registration gate, mints a ticket, sends a code, writes a journal row, or sends a request to the
ESPN write host (`ESPN_WRITE_HOST`, spelled once, in `src/config/schema.ts`, where the read-host
override refuses it). The owner decided not to build writes (D11);
plan 10 §3.W's verdict is "recommended: do not build yet".

Specification: plan 02 §3.2 (the four registration gates), §4 (prepare → human channel → commit,
the three channels, the HMAC ticket and precondition hash, journal states), plan 07 §3.F (the seven
F-tools), plan 03 §2.1 (`eff setup --enable-writes`), plan 10 §3.W (prerequisites (a)–(d), W1–W11).

## What exists today (declared, inert)

| Item | Where | State |
|---|---|---|
| Gate types: `PreparedWrite`, `CommitTicket`, `JournalState` (incl. `voided_code`, `voided_cancelled`), `LineupPreconditionInput`, `ConfirmationEvidence`, `PrepareResult`, `CommitResult`, `GateService` | `src/domain/gate/types.ts` | types and constants only |
| `FantasyPlatformWrites` (the write methods) | `src/providers/platform.ts` | interface only; no implementation; `writes: false` is a literal type |
| `capabilities().write` all `false` | `src/providers/platform.ts` (`NO_WRITES`) | literal `false` types — no code can set them `true` |
| `EFF_ENABLE_WRITES` | `src/config/schema.ts` | parsed and reported; `Config.writesEnabled` is the literal `false` |
| The write host constant | `src/config/schema.ts` (`ESPN_WRITE_HOST`) | named only so the read-host override can refuse it |
| `gate_key` path | `src/config/paths.ts` (`gateKeyPath`) | never created |
| `write_journal` table | `src/store/types.ts` (`MIGRATION_001_TABLES`) | created empty by migration 001 (plan 01 §9.2); read only for `espn_get_status.journal` counts (`null` today) |
| Gate error codes | `src/mcp/errors.ts` | in the error table so the contract is complete; nothing raises them |

## Where the write module would integrate (if the owner ever decides to build it)

1. **Gate service** — `src/domain/gate/service.ts` implementing `GateService` from `types.ts`: the
   `prepare_*` pre-flight (locks, slot counts, eligibility, the 15-minute kickoff freeze, the daily
   cap), the precondition hash, the HMAC ticket over `TICKET_HMAC_FIELDS`, the keyed one-time code
   (`HMAC-SHA256(gate_key, code)`, never stored in plaintext — changelog V1), compare-and-set
   commit, and the journal transitions in `JOURNAL_TRANSITIONS`. It is in the coverage gate's
   100 % list (`scripts/ci/coverage-gate.json`: `src/domain/gate/**`).
2. **The seven F-tools' registration point** — `src/mcp/registry.ts`: one conditional block that
   registers `WRITE_TOOL_NAMES` only when all four registration gates (`WRITE_REGISTRATION_GATES`)
   hold **at process start from persisted evidence** (`WriteRegistrationEvidence`; no network, no
   keychain read; no late registration and no `list_changed` — plan 02 §3.2, changelog V4).
3. **EspnProvider write methods** — `src/providers/espn/provider.ts` implementing
   `FantasyPlatformWrites` (`setLineup`, `submitTransaction`, `submitTrade`): one atomic POST per
   commit, own-team pinned (plan 02 S5), `isLeagueManager`/`isActingAsTeamOwner` always `false`,
   read-back of `mRoster` as the outcome; the write host added to `src/http/client.ts`'s allow-list
   **only in write mode**.
4. **`eff setup --enable-writes`** — `src/cli/setup.ts`: the typed acknowledgement written to
   `config.json` (`writes_acknowledged_at`, `acknowledged_text_sha256` — already parsed by
   `src/config/schema.ts`), refusing a non-TTY stdin (plan 10 §3.W prerequisite (c)).
5. **`eff confirm <prepared_id>`** — `src/cli/confirm.ts`: channel 3, printing the diff and asking
   `y/N`, refusing a non-TTY stdin; and **`eff journal reconcile`** — `src/cli/journal.ts`
   (`sent_unknown → confirmed_*`, plan 06 §1.4).

The write-only files (`src/domain/gate/service.ts`, `src/cli/confirm.ts`, `src/cli/journal.ts`) do
not exist. The shared files (`registry.ts`, `provider.ts`, `client.ts`, `setup.ts`) exist for the
read-only product and contain no write code: the seven write tool names appear nowhere in `src/`
outside `types.ts`, and the write host appears only in `src/config/schema.ts`, where the read-host
override refuses it. Every declared seam above carries the marker `PHASE W SEAM — NOT IMPLEMENTED
(plan 10 §3.W; owner decision D11)` (or its short form `PHASE W SEAM`), and
`tests/domain/gate/types.test.ts` asserts all of this stays true.
