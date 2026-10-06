#!/bin/zsh
# with-node.sh — run a command under this repo's Node version (.nvmrc) via fnm, without changing
# the machine's default Node (other projects rely on it). CLAUDE.md "Workflow"; plan 04 §1.
# Ported from sibling @d72e03b, adapted.
#
# Usage:  scripts/dev/with-node.sh <command> [args…]
#   e.g.  scripts/dev/with-node.sh npm test -- tests/lint
set -euo pipefail
ROOT=${0:A:h:h:h}
(( $# >= 1 )) || { print -u2 "usage: with-node.sh <command> [args…]"; exit 64; }
command -v fnm >/dev/null 2>&1 || { print -u2 "with-node: fnm is not on PATH — install fnm, then: fnm install \"\$(cat .nvmrc)\""; exit 69; }
ver=$(<"$ROOT/.nvmrc")
ver=${ver//[[:space:]]/}
[[ $ver =~ '^[0-9]+(\.[0-9]+){0,2}$' ]] || { print -u2 "with-node: .nvmrc does not hold a plain version: refusing"; exit 65; }
exec fnm exec --using="$ver" -- "$@"
