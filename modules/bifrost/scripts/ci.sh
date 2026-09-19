#!/usr/bin/env bash
# bifrost local CI — replaces the GitHub Actions workflows so releases can be
# cut entirely from a dev machine (the repo's Actions are billing-blocked).
#
# Mirrors:
#   .github/workflows/version-check.yml  →  ci.sh check
#   .github/workflows/release.yml        →  ci.sh release
#
# Usage:
#   scripts/ci.sh check     # verify BIFROST_VERSION is bumped vs origin/main
#   scripts/ci.sh release   # create the v<version> GitHub release (idempotent)
#   scripts/ci.sh           # runs 'check'

set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # repo root

C='\033[36m' G='\033[32m' Y='\033[33m' R='\033[31m' N='\033[0m'
info() { echo -e "  ${G}✓${N} $1"; }
warn() { echo -e "  ${Y}⚠${N} $1"; }
err()  { echo -e "  ${R}✗${N} $1" >&2; }

version_in() {
  # $1 = git ref (or empty for working tree). Prints BIFROST_VERSION or "".
  if [[ -z "${1:-}" ]]; then
    grep -m1 '^BIFROST_VERSION=' bifrost | cut -d'"' -f2
  else
    git show "$1:bifrost" 2>/dev/null | grep -m1 '^BIFROST_VERSION=' | cut -d'"' -f2 || echo ""
  fi
}

# Returns 0 if $1 (new) is strictly greater than $2 (old) in semver.
semver_gt() {
  local IFS=.
  read -r na nb nc <<< "$1"
  read -r oa ob oc <<< "$2"
  (( na > oa )) && return 0
  (( na < oa )) && return 1
  (( nb > ob )) && return 0
  (( nb < ob )) && return 1
  (( nc > oc )) && return 0
  return 1
}

cmd_test() {
  echo -e "${C}Tests${N}"
  # bash -n on both scripts first — a syntax error is the cheapest bug to catch.
  bash -n bifrost && info "bifrost: syntax clean" || { err "bifrost: syntax error"; exit 1; }
  bash -n install.sh && info "install.sh: syntax clean" || { err "install.sh: syntax error"; exit 1; }
  bash test/run.sh || { err "test suite failed"; exit 1; }
}

cmd_check() {
  echo -e "${C}Version check${N}"
  git fetch -q origin main 2>/dev/null || warn "could not fetch origin/main (using cached ref)"

  local current main
  current=$(version_in "")
  main=$(version_in "origin/main")

  echo "  working tree: ${current:-<none>}"
  echo "  origin/main:  ${main:-<none>}"

  if [[ -z "$current" ]]; then
    err "no BIFROST_VERSION found in ./bifrost"; exit 1
  fi
  if [[ -z "$main" ]]; then
    info "no version on origin/main yet — treating as first release"; return 0
  fi
  if [[ "$current" == "$main" ]]; then
    err "version not bumped. Update BIFROST_VERSION in ./bifrost (current: $main)."
    err "  patch (x.x.+1) | minor (x.+1.0) | major (+1.0.0)"
    exit 1
  fi
  if ! semver_gt "$current" "$main"; then
    err "version must increase. $current is not higher than $main."
    exit 1
  fi
  info "version bump OK: $main → $current"
}

cmd_release() {
  echo -e "${C}Release${N}"
  command -v gh >/dev/null || { err "gh CLI not found"; exit 1; }

  local current tag
  current=$(version_in "")
  tag="v$current"

  if [[ -z "$current" ]]; then err "no BIFROST_VERSION in ./bifrost"; exit 1; fi

  if gh release view "$tag" >/dev/null 2>&1; then
    info "release $tag already exists — nothing to do"
    return 0
  fi

  # Previous version: from HEAD~1's bifrost (mirrors release.yml).
  local previous prevtag bump emoji label
  previous=$(version_in "HEAD~1")
  prevtag="v$previous"

  if [[ -z "$previous" || "$previous" == "$current" ]]; then
    bump="patch"
  else
    local IFS=.
    read -r ca cb _ <<< "$current"; read -r pa pb _ <<< "$previous"
    if   [[ "$ca" != "$pa" ]]; then bump="major"
    elif [[ "$cb" != "$pb" ]]; then bump="minor"
    else bump="patch"; fi
  fi
  case "$bump" in
    major) emoji="🚀"; label="Major release" ;;
    minor) emoji="✨"; label="Feature release" ;;
    *)     emoji="🔧"; label="Patch" ;;
  esac

  local commits
  if [[ -n "$previous" ]] && git rev-parse "$prevtag" >/dev/null 2>&1; then
    commits=$(git log "$prevtag"..HEAD --pretty=format:"- %s" --no-merges | grep -v "^- Release" || true)
  else
    commits=$(git log -10 --pretty=format:"- %s" --no-merges | grep -v "^- Release" || true)
  fi

  local notes="$emoji **$label** — $tag

### Changes

$commits"

  echo "  creating $tag ($bump) at $(git rev-parse --short HEAD)..."
  gh release create "$tag" --target "$(git rev-parse HEAD)" --title "$tag" --notes "$notes"
  info "released $tag"
}

case "${1:-check}" in
  check)   cmd_check ;;
  test)    cmd_test ;;
  release) cmd_test && cmd_release ;;
  *) echo "Usage: scripts/ci.sh [check|test|release]"; exit 1 ;;
esac
