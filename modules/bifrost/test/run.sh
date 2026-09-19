#!/usr/bin/env bash
# Bifrost test harness — zero dependencies, just bash. `bats` would be nicer but
# it is one more thing to install on every realm; this runs anywhere bifrost does.
#
# Bifrost is 1900 lines that will soon be load-bearing for unattended overnight
# work. A bug there is the whole workspace down with nobody watching, so the
# parts that decide WHERE a command runs and WHAT it connects to are pinned here:
# realm-name validation (an injection surface — it becomes an ssh target and a
# tmux session name), config round-tripping, session naming, and the dispatcher.
set -uo pipefail   # deliberately NOT -e: a tested rc must not abort the harness

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Isolate every side effect: bifrost reads and writes ~/.config/bifrost, so give
# it a throwaway HOME. Without this the suite would read Franco's real realms.
export HOME
HOME="$(mktemp -d)"
export BIFROST_CONFIG_DIR="$HOME/.config/bifrost"
mkdir -p "$BIFROST_CONFIG_DIR/realms"

PASS=0; FAIL=0; FAILED=()
ok()   { PASS=$((PASS+1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
no()   { FAIL=$((FAIL+1)); FAILED+=("$1"); printf "  \033[31m✗\033[0m %s\n     %s\n" "$1" "$2"; }

# eq EXPECTED ACTUAL NAME
eq() { [[ "$2" == "$1" ]] && ok "$3" || no "$3" "expected [$1], got [$2]"; }
# okrc RC NAME  — expect success
okrc() { [[ "$1" -eq 0 ]] && ok "$2" || no "$2" "expected rc 0, got $1"; }
# failrc RC NAME — expect failure
failrc() { [[ "$1" -ne 0 ]] && ok "$2" || no "$2" "expected non-zero rc, got 0"; }
# run a function, capture its rc into $RC, never let it abort the harness
run_rc() { RC=0; "$@" >/dev/null 2>&1 || RC=$?; }

# Source bifrost for its functions (guard added in the script keeps the
# dispatcher from firing). BIFROST_REALMS_DIR is computed at source time from
# BIFROST_CONFIG_DIR, so it already points at our sandbox.
# shellcheck source=/dev/null
source "$ROOT/bifrost"

echo "── realm name validation (this string becomes an ssh target + tmux name) ──"
run_rc validate_realm_name "asgard";        okrc   $RC "plain name accepted"
run_rc validate_realm_name "tatooine-1";    okrc   $RC "hyphens and digits accepted"
run_rc validate_realm_name "home_server";   okrc   $RC "underscores accepted"
run_rc validate_realm_name "";              failrc $RC "empty name refused"
run_rc validate_realm_name "a b";           failrc $RC "spaces refused"
run_rc validate_realm_name 'a;rm -rf';      failrc $RC "shell metacharacters refused (injection guard)"
run_rc validate_realm_name 'a$(whoami)';    failrc $RC "command substitution refused"
run_rc validate_realm_name '../escape';     failrc $RC "path traversal refused"

echo "── realm color assignment (drives the iTerm grid tint) ──"
c0="$(get_realm_color 0)"; c_wrap="$(get_realm_color "${#REALM_COLORS[@]}")"
eq "$c0" "$c_wrap" "color index wraps modulo the palette"
[[ -n "$c0" ]] && ok "index 0 yields a color" || no "index 0 yields a color" "empty"

echo "── realm config round-trip ──"
cat > "$BIFROST_REALMS_DIR/asgard" <<EOF
REALM_HOST="asgard.example"
REALM_USER="odin"
EOF
( load_realm "asgard" >/dev/null 2>&1; [[ "$REALM_HOST" == "asgard.example" && "$REALM_USER" == "odin" ]] ) \
  && ok "load_realm reads host and user" || no "load_realm reads host and user" "vars not set"

# Backwards compat: old configs used DEVICE_* before the realm rename.
cat > "$BIFROST_REALMS_DIR/legacy" <<EOF
DEVICE_HOST="old.example"
DEVICE_USER="thor"
EOF
( load_realm "legacy" >/dev/null 2>&1; [[ "$REALM_HOST" == "old.example" && "$REALM_USER" == "thor" ]] ) \
  && ok "load_realm falls back to legacy DEVICE_* vars" || no "load_realm falls back to legacy DEVICE_* vars" "fallback failed"

echo "── list_realms (only well-formed names; junk ignored) ──"
: > "$BIFROST_REALMS_DIR/.DS_Store"          # the classic macOS turd
: > "$BIFROST_REALMS_DIR/bad name"           # space → invalid
realms="$(list_realms | sort | tr '\n' ' ')"
eq "asgard legacy " "$realms" "lists valid realms, skips .DS_Store and malformed names"

echo "── dispatcher wiring (summon rename + back-comat aliases) ──"
grep -qE '^\s+summon\)' "$ROOT/bifrost"                      && ok "summon is a command" || no "summon is a command" "missing"
grep -qE '^\s+workspace\)' "$ROOT/bifrost"                   && ok "workspace kept as alias (muscle memory + Termux widget)" || no "workspace alias" "missing"
grep -qE '^\s+device\)' "$ROOT/bifrost"                      && ok "device kept as alias for realm" || no "device alias" "missing"

echo "── the iTerm quote fix from #10 stays fixed (regression guard) ──"
if grep -q '^BIFROST_REMOTE_PATH=' "$ROOT/bifrost"; then
  line="$(grep -m1 '^BIFROST_REMOTE_PATH=' "$ROOT/bifrost")"
  [[ "$line" != *'"'* ]] && ok "BIFROST_REMOTE_PATH has no double-quotes (would break AppleScript)" \
                         || no "BIFROST_REMOTE_PATH quote-free" "a double-quote here reintroduces the iTerm crash"
else
  no "BIFROST_REMOTE_PATH present" "variable vanished"
fi


echo "── agent-state classifier (mirrors apiary's detectors) ──"
eq "working" "$(classify_agent_state 'esc to interrupt')"                 "interrupt hint → working"
eq "working" "$(classify_agent_state 'Working (12s')"                     "Working timer → working"
eq "working" "$(classify_agent_state 'thinking hard ⠹ still going')"      "spinner braille → working"
eq "blocked" "$(classify_agent_state 'Do you want to approve this edit?')" "approval prompt → blocked"
eq "blocked" "$(classify_agent_state 'Allow the apiary MCP server to run tool')" "MCP tool prompt → blocked"
eq "blocked" "$(classify_agent_state 'Do you trust the files in this folder')" "trust prompt → blocked"
eq "blocked" "$(classify_agent_state 'Sign in with ChatGPT to continue')"  "sign-in → blocked"
eq "idle"    "$(classify_agent_state 'Ask Codex to do anything')"          "empty composer → idle"
eq "idle"    "$(classify_agent_state '')"                                  "blank screen → idle"
# order: a human-gating prompt outranks a spinner on the same screen
eq "blocked" "$(classify_agent_state 'Working (3s ... Do you want to approve?')" "blocked outranks working"

echo "── state glyphs ──"
[[ -n "$(agent_state_glyph working)" ]] && ok "working has a glyph" || no "working glyph" "empty"
[[ "$(agent_state_glyph working)" != "$(agent_state_glyph blocked)" ]] && ok "states render distinctly" || no "distinct glyphs" "same"

echo "── list_agent_sessions filters to apiary_* ──"
# pure string check: the filter regex only accepts apiary_ prefix
grep -q "grep -E '\^apiary_'" "$ROOT/bifrost" && ok "list_agent_sessions scoped to apiary_ prefix" || no "agent-session scope" "filter changed"

echo
echo "──────────────────────────────────────"
if [[ $FAIL -eq 0 ]]; then
  printf "  \033[32m%d passed, 0 failed\033[0m\n" "$PASS"
else
  printf "  \033[31m%d passed, %d FAILED\033[0m\n" "$PASS" "$FAIL"
fi
rm -rf "$HOME"
exit $(( FAIL > 0 ? 1 : 0 ))
