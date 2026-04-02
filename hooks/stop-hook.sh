#!/bin/bash
# Wario Stop Hook — forces iteration within a single Claude session.
# Blocks exit and re-feeds an iteration prompt until:
#   - Agent writes turn-result.json with status "blocked"
#   - Max iterations reached
#
# State file: .claude/wario-loop.json (written by orchestrator before spawn)
# Turn result: {warioRoot}/task-state/{issueKey}/turn-result.json (written by agent)

set -euo pipefail

HOOK_INPUT=$(cat)

# Check for wario loop state file (written by orchestrator in the repo cwd)
STATE_FILE=".claude/wario-loop.json"
if [[ ! -f "$STATE_FILE" ]]; then
  exit 0  # Not a wario session — allow exit
fi

ISSUE_KEY=$(jq -r '.issueKey' "$STATE_FILE")
WARIO_ROOT=$(jq -r '.warioRoot' "$STATE_FILE")
MAX_ITERATIONS=$(jq -r '.maxIterations // 3' "$STATE_FILE")
ITERATION=$(jq -r '.iteration // 0' "$STATE_FILE")

TURN_RESULT="$WARIO_ROOT/task-state/$ISSUE_KEY/turn-result.json"

# Check if agent reported blocked
if [[ -f "$TURN_RESULT" ]]; then
  TURN_STATUS=$(jq -r '.status // "done"' "$TURN_RESULT" 2>/dev/null || echo "done")
  if [[ "$TURN_STATUS" == "blocked" ]]; then
    TURN_MSG=$(jq -r '.message // "waiting for input"' "$TURN_RESULT" 2>/dev/null || echo "")
    echo "🛑 Wario: Agent blocked — $TURN_MSG" >&2
    rm -f "$STATE_FILE"
    exit 0  # Allow exit
  fi
fi

# Check max iterations
NEXT=$((ITERATION + 1))
if [[ $MAX_ITERATIONS -gt 0 ]] && [[ $NEXT -gt $MAX_ITERATIONS ]]; then
  echo "🛑 Wario: All $MAX_ITERATIONS iterations complete for $ISSUE_KEY." >&2
  rm -f "$STATE_FILE"
  exit 0  # Allow exit
fi

# Update iteration count in state file
jq --argjson n "$NEXT" '.iteration = $n' "$STATE_FILE" > "${STATE_FILE}.tmp"
mv "${STATE_FILE}.tmp" "$STATE_FILE"

# Build iteration-specific prompt
if [[ $NEXT -eq 1 ]]; then
  # Just finished first implementation pass → force QA
  PROMPT="Iteration $NEXT/$MAX_ITERATIONS. You just finished your first pass. Now validate for real.

1. Re-read your validation contract. If every item is a compilation/syntax/config check, REWRITE it. You need tests that prove the feature works with real data.
2. Dispatch wario-qa with the contract and environment info. The QA agent will try to actually run the feature.
3. If QA finds issues, fix them. If QA reports BLOCKED, check if you can unblock it (start env, set config). If it truly needs external input, write turn-result.json with status \"blocked\" and post to JIRA.
4. Commit and push fixes."

elif [[ $NEXT -ge $((MAX_ITERATIONS)) ]]; then
  # Final iteration
  PROMPT="Iteration $NEXT/$MAX_ITERATIONS (FINAL). Wrap up and ship.

1. Read the git diff one last time. Any hollow implementations, orphaned code, missing acceptance criteria?
2. If no PR exists yet, open it now (Phase 8: gh pr create, jira_add_comment, jira_transition_issue).
3. If PR already exists, verify it's up to date with your latest commits.
4. Write turn-result.json with status \"done\"."

else
  # Middle iterations — keep improving
  PROMPT="Iteration $NEXT/$MAX_ITERATIONS. Keep improving.

1. Check QA results from last iteration. What failed? What's still untested?
2. Run the actual feature with real data. Does it work end-to-end?
3. Fix issues, improve validation, commit and push.
4. If you need something external (credentials, access, test data), write turn-result.json with status \"blocked\" and post to JIRA."
fi

# Block exit and re-feed the iteration prompt
jq -n \
  --arg reason "$PROMPT" \
  --arg msg "🔄 Wario iteration $NEXT/$MAX_ITERATIONS for $ISSUE_KEY" \
  '{
    "decision": "block",
    "reason": $reason
  }'

exit 0
