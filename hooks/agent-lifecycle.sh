#!/bin/bash
# Agent Lifecycle Hook — logs SubagentStart/SubagentStop events.
# Output goes to stderr so the orchestrator's stderr reader can detect it.
#
# The orchestrator parses these lines to track subagent timing and
# improve stuck detection (shorter timeout after subagent completes).

set -euo pipefail

HOOK_INPUT=$(cat)
EVENT=$(echo "$HOOK_INPUT" | jq -r '.hook_event_name')
AGENT_TYPE=$(echo "$HOOK_INPUT" | jq -r '.agent_type // "unknown"')
AGENT_ID=$(echo "$HOOK_INPUT" | jq -r '.agent_id // "unknown"')

TS=$(date +%H:%M:%S)
case "$EVENT" in
  SubagentStart)
    echo "[$TS] [agent-lifecycle] Started: $AGENT_TYPE ($AGENT_ID)" >&2
    ;;
  SubagentStop)
    echo "[$TS] [agent-lifecycle] Stopped: $AGENT_TYPE ($AGENT_ID)" >&2
    ;;
esac
exit 0
