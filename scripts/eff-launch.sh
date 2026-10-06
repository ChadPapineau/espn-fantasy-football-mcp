#!/bin/sh
# eff-launch.sh — the plugin's launch shim, run as `/bin/sh eff-launch.sh serve` by .mcp.json (plan
# 09 §4, K8; plan 03 §4; ADV OBJ-12, OBJ-23). POSIX sh: no PATH, no executable bit and no login
# shell are assumed (a GUI-launched client has none of them). It resolves a Node >= 24.15
# deterministically, in this order, and execs `<node> <root>/dist/cli.js "$@"`:
#   1. $EFF_NODE (an explicit override; if set it MUST be a valid node — no silent fallback)
#   2. the fnm default   ($FNM_DIR, ~/.local/share/fnm, ~/Library/Application Support/fnm, ~/.fnm)
#   3. the nvm default   ($NVM_DIR or ~/.nvm; alias/default resolved through nvm's alias files)
#   4. /opt/homebrew/bin/node   (Homebrew, Apple silicon)
#   5. /usr/local/bin/node      (Homebrew, Intel — the plan's order, plus this one path)
#   6. `command -v node`
# On failure it prints the exact fix to stderr and exits 1. `eff doctor` #2 runs the same order.
# <root> is $CLAUDE_PLUGIN_ROOT, or the directory above this script when that is unset.
set -u

MIN_MAJOR=24
MIN_MINOR=15
tried=""

note() { tried="${tried}${tried:+, }$1"; }

# is_uint <s>: a non-empty run of digits
is_uint() {
  case "$1" in '' | *[!0-9]*) return 1 ;; *) return 0 ;; esac
}

# node_ok <path>: an executable regular file whose `process.versions.node` is >= MIN_MAJOR.MIN_MINOR
node_ok() {
  [ -n "$1" ] && [ -f "$1" ] && [ -x "$1" ] || return 1
  nv=$("$1" -p 'process.versions.node' 2>/dev/null) || return 1
  # a real node prints MAJOR.MINOR.PATCH (a pre-release suffix may follow the patch)
  case "$nv" in [0-9]*.[0-9]*.[0-9]*) ;; *) return 1 ;; esac
  nmaj=${nv%%.*}
  nrest=${nv#*.}
  nmin=${nrest%%.*}
  is_uint "$nmaj" && is_uint "$nmin" || return 1
  [ "$nmaj" -gt "$MIN_MAJOR" ] && return 0
  [ "$nmaj" -eq "$MIN_MAJOR" ] && [ "$nmin" -ge "$MIN_MINOR" ] && return 0
  return 1
}

# ver_gt <a> <b>: version a (vX.Y.Z or X.Y.Z) is greater than b
ver_gt() {
  va=${1#v}
  vb=${2#v}
  for _ in 1 2 3; do
    ha=${va%%.*}
    hb=${vb%%.*}
    is_uint "$ha" || ha=0
    is_uint "$hb" || hb=0
    [ "$ha" -gt "$hb" ] && return 0
    [ "$ha" -lt "$hb" ] && return 1
    case "$va" in *.*) va=${va#*.} ;; *) va=0 ;; esac
    case "$vb" in *.*) vb=${vb#*.} ;; *) vb=0 ;; esac
  done
  return 1
}

# fnm_default: the node of fnm's `default` alias, first fnm directory that has one
fnm_default() {
  for d in "${FNM_DIR:-}" "${HOME:-}/.local/share/fnm" "${HOME:-}/Library/Application Support/fnm" "${HOME:-}/.fnm"; do
    [ -n "$d" ] || continue
    if [ -f "$d/aliases/default/bin/node" ]; then
      printf '%s\n' "$d/aliases/default/bin/node"
      return 0
    fi
  done
  return 1
}

# nvm_default: resolve $NVM_DIR/alias/default (through nvm's alias files, at most 5 hops) to the
# highest installed version matching it
nvm_default() {
  nd=${NVM_DIR:-${HOME:-}/.nvm}
  [ -f "$nd/alias/default" ] || return 1
  want=$(sed -n '1p' "$nd/alias/default" 2>/dev/null | tr -d ' \t\r')
  hops=0
  while [ "$hops" -lt 5 ] && [ -n "$want" ] && [ -f "$nd/alias/$want" ]; do
    want=$(sed -n '1p' "$nd/alias/$want" 2>/dev/null | tr -d ' \t\r')
    hops=$((hops + 1))
  done
  case "$want" in node | stable) want="" ;; esac
  want=${want#v}
  case "$want" in '' | [0-9]*) ;; *) return 1 ;; esac
  best=""
  for vdir in "$nd"/versions/node/v*; do
    [ -f "$vdir/bin/node" ] || continue
    ver=${vdir##*/}
    # "24" matches 24.x.y and "24.1" matches 24.1.y — at a component boundary, never 24.15.0
    if [ -n "$want" ]; then
      case "${ver#v}." in "$want".*) ;; *) continue ;; esac
    fi
    if [ -z "$best" ] || ver_gt "$ver" "${best##*/}"; then best=$vdir; fi
  done
  [ -n "$best" ] || return 1
  printf '%s\n' "$best/bin/node"
}

fail() {
  {
    printf 'eff-launch: %s\n' "$1"
    printf 'eff-launch: tried: %s\n' "${tried:-nothing}"
    printf 'eff-launch: fix: install Node 24 (>= %s.%s) with  fnm install 24 && fnm default 24  — or set EFF_NODE\n' "$MIN_MAJOR" "$MIN_MINOR"
    printf 'eff-launch:      to the absolute path of such a node in your MCP client config — then restart the client.\n'
  } >&2
  exit 1
}

root=${CLAUDE_PLUGIN_ROOT:-}
if [ -z "$root" ]; then
  case "$0" in */*) here=${0%/*} ;; *) here=. ;; esac
  root=$(CDPATH='' cd -- "$here/.." 2>/dev/null && pwd) || fail "cannot locate the plugin root"
fi

node=""
if [ -n "${EFF_NODE:-}" ]; then
  note "EFF_NODE"
  node_ok "$EFF_NODE" || fail "EFF_NODE is set but is not an executable Node >= $MIN_MAJOR.$MIN_MINOR"
  node=$EFF_NODE
fi
if [ -z "$node" ]; then
  note "fnm default"
  c=$(fnm_default) && node_ok "$c" && node=$c
fi
if [ -z "$node" ]; then
  note "nvm default"
  c=$(nvm_default) && node_ok "$c" && node=$c
fi
if [ -z "$node" ]; then
  for c in /opt/homebrew/bin/node /usr/local/bin/node; do
    note "$c"
    if node_ok "$c"; then
      node=$c
      break
    fi
  done
fi
if [ -z "$node" ]; then
  note "PATH (command -v node)"
  c=$(command -v node 2>/dev/null) && node_ok "$c" && node=$c
fi
[ -n "$node" ] || fail "no Node.js >= $MIN_MAJOR.$MIN_MINOR found"

cli="$root/dist/cli.js"
if [ ! -f "$cli" ]; then
  printf 'eff-launch: %s is missing — build it first:  cd "%s" && npm ci && npm run build\n' "$cli" "$root" >&2
  exit 1
fi
exec "$node" "$cli" "$@"
