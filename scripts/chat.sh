#!/bin/bash
# Usage: ./scripts/chat.sh ISSUE-KEY
# Opens an interactive Claude Code session that resumes the agent's conversation.
# The orchestrator queues incoming webhook events while you're chatting.
set -e

cd "$(dirname "$0")/.."
ROOT=$(pwd)

ISSUE_KEY="$1"
if [ -z "$ISSUE_KEY" ]; then
  echo "Usage: ./scripts/chat.sh ISSUE-KEY"
  echo ""
  echo "Active sessions:"
  if [ -f .wario-sessions.json ]; then
    node -e "
      const s = JSON.parse(require('fs').readFileSync('.wario-sessions.json','utf-8'));
      for (const [k,v] of Object.entries(s)) {
        console.log('  ' + k + ' (' + v.status + ')');
      }
      if (!Object.keys(s).length) console.log('  (none)');
    "
  else
    echo "  (none)"
  fi
  exit 1
fi

# Read session info
if [ ! -f .wario-sessions.json ]; then
  echo "No sessions found (.wario-sessions.json missing)"
  exit 1
fi

SESSION_ID=$(node -e "
  const s = JSON.parse(require('fs').readFileSync('.wario-sessions.json','utf-8'));
  const rec = s['$ISSUE_KEY'];
  if (!rec) { console.error('No session for $ISSUE_KEY'); process.exit(1); }
  console.log(rec.sessionId);
")

PROJECT_KEY=$(node -e "
  const s = JSON.parse(require('fs').readFileSync('.wario-sessions.json','utf-8'));
  console.log(s['$ISSUE_KEY'].projectKey);
")

# Find localRepoPath from projects.yaml
REPO_PATH=$(node -e "
  const yaml = require('yaml');
  const fs = require('fs');
  const parsed = yaml.parse(fs.readFileSync('projects.yaml','utf-8'));
  const proj = (parsed.projects || []).find(p => p.jiraProjectKey === '$PROJECT_KEY');
  if (!proj) { console.error('Project $PROJECT_KEY not in projects.yaml'); process.exit(1); }
  console.log(proj.localRepoPath);
")

echo "Session: $ISSUE_KEY (id: $SESSION_ID)"
echo "Project: $PROJECT_KEY (repo: $REPO_PATH)"

# Wait if agent is busy
while true; do
  STATUS=$(node -e "
    const s = JSON.parse(require('fs').readFileSync('.wario-sessions.json','utf-8'));
    console.log(s['$ISSUE_KEY']?.status || 'unknown');
  ")
  if [ "$STATUS" = "active" ]; then
    echo "Agent is busy (status: active), waiting..."
    sleep 5
  else
    break
  fi
done

# Create lock file — orchestrator will queue events while this exists
LOCK_FILE="$ROOT/.human-chat-$ISSUE_KEY"

cleanup() {
  rm -f "$LOCK_FILE"
  echo ""
  echo "Human chat ended. Orchestrator will post JIRA summary within ~30s."
}
trap cleanup EXIT

touch "$LOCK_FILE"
echo ""
echo "Lock created. Orchestrator will queue events while you chat."
echo "Exit with Ctrl+C or /exit when done."
echo ""

# Check MCP config exists
MCP_CONFIG="$ROOT/mcp-configs/.generated-mcp.json"
if [ ! -f "$MCP_CONFIG" ]; then
  echo "Warning: MCP config not found at $MCP_CONFIG"
  echo "JIRA tools may not be available. Start the orchestrator first."
fi

# Launch interactive Claude session from the same cwd the orchestrator uses
cd "$REPO_PATH"
claude --resume "$SESSION_ID" \
  --name "wario-$ISSUE_KEY" \
  --dangerously-skip-permissions \
  --mcp-config "$MCP_CONFIG" \
  --add-dir "$ROOT"
