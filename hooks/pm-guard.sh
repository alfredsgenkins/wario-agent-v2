#!/bin/bash
# PM Guard Hook — blocks Edit/Write/Grep/Glob on main thread (PM).
# Subagent calls pass through because agent_id is present.
#
# Hook input (JSON on stdin):
#   { "tool_name": "Edit", "agent_id": null, ... }     → BLOCK (PM)
#   { "tool_name": "Edit", "agent_id": "abc-123", ... } → ALLOW (subagent)

set -euo pipefail

HOOK_INPUT=$(cat)
AGENT_ID=$(echo "$HOOK_INPUT" | jq -r '.agent_id // empty')
TOOL_NAME=$(echo "$HOOK_INPUT" | jq -r '.tool_name')

# If agent_id is set, this is a subagent call — allow everything
if [[ -n "$AGENT_ID" ]]; then
  exit 0
fi

# Main thread (PM) — block code tools
case "$TOOL_NAME" in
  Edit|Write|Grep|Glob)
    jq -n --arg tool "$TOOL_NAME" '{
      "decision": "block",
      "reason": ("PM cannot use " + $tool + ". Dispatch wario-coder or wario-qa instead.")
    }'
    exit 0
    ;;
esac

# Allow everything else (Read, Bash, Agent, MCP tools)
exit 0
