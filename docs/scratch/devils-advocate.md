# devils-advocate — working notes

Role: attack the plan (docs/plan/01–10) for the from-scratch ESPN Fantasy
Football MCP server. Deliverable: `docs/plan/adversarial-log.md` (one
section per round) plus these notes. I own only those two paths.

## RESUME HERE

- **State:** round 1 started. Scratch file created; no objections written yet.
- **Next:** read docs/plan/01→10, then docs/research/02→06 + 01 verdict
  table, then the mcp-builder best-practices reference, then the sibling
  Yahoo adversarial log (read-only via `git -C ... show origin/main:...`).
  Then write `docs/plan/adversarial-log.md` `## Round 1 — objections`.
- **Round-1 additions from the orchestrator:** (a) treat T-01…T-16 in
  plan 10 §4 as pre-filed objections — adopt / sharpen / merge / dismiss
  each with a reason; (b) do not repeat objections already ruled in the
  Yahoo adversarial log for platform-agnostic decisions this plan cites as
  adopted; spend budget on ESPN-specific, format-specific, or newly
  introduced material.
- **Discipline:** explicit-path staging only; `git pull --rebase origin
  main` before push; never force-push; verify HEAD == origin/main after
  each push; WIP as patch file if torn down mid-round.

## Reading log

(filled in as I go)

## Objection candidates

(filled in as I go — id, target, severity, one line)

## Tension triage (T-01…T-16)

(adopt / sharpen / merge / dismiss, one line each)
