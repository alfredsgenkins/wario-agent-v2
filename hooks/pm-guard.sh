#!/bin/bash
# PM Guard — warns the PM when it tries to code instead of dispatching the coder.
# Registered as a PreToolUse hook for Edit and Write tools.

set -euo pipefail

HOOK_INPUT=$(cat)

# Only active in wario sessions
if [[ ! -f ".claude/wario-loop.json" ]]; then
  exit 0
fi

cat << 'EOF'
⚠️ You are the PM — you don't write code. Dispatch wario-coder to make this change instead. Tell the coder exactly what to change and why.
EOF
