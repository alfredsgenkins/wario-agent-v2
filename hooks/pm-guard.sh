#!/bin/bash
# PM Guard — warns the PM when it tries to code instead of dispatching the coder.
# Only active for the main session (PM), not for subagents (coder/QA).

set -euo pipefail

HOOK_INPUT=$(cat)

# Only active in wario sessions
if [[ ! -f ".claude/wario-loop.json" ]]; then
  exit 0
fi

# Check if this is a subagent call — subagents have a parent_tool_use_id
# The hook input JSON has a "tool_input" field but no direct subagent indicator.
# However, we can check if the session has an active agent by looking at the
# hook input's session context.
#
# Simpler approach: subagents are named agents (wario-coder, wario-qa).
# The PreToolUse hook input includes the agent_name if called from a subagent.
AGENT_NAME=$(echo "$HOOK_INPUT" | jq -r '.agent_name // empty' 2>/dev/null || true)

# If there's an agent name, this is a subagent — let it work
if [[ -n "$AGENT_NAME" ]]; then
  exit 0
fi

# Main session (PM) is trying to edit files — warn it
cat << 'EOF'
⚠️ You are the PM — you don't write code. Dispatch wario-coder to make this change instead. Tell the coder exactly what to change and why.
EOF
