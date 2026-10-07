#!/bin/sh
# Capture every process's command line FIRST, then search the snapshot, so the search tool's own argv is never in it.
snap=$(ps axww -o args=)
pat=$(printf 'sk-ant-%s' oat)
n=$(printf '%s\n' "$snap" | grep -c -F -- "$pat")
echo "processes whose command line holds the token: $n"
echo "token present in this script's environment:   $( [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && echo yes || echo no )"
