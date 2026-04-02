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
  # After first implementation — assume everything is broken
  PROMPT="Iteration $NEXT/$MAX_ITERATIONS. Your implementation is not verified yet. Assume it's broken until you prove otherwise.

Your task was described in the JIRA issue. Re-read it now. Then ask yourself: did you actually DO the thing it asked for, or did you just write code that theoretically does it?

For example: if the task was 'sync prices from SAP', did you actually run the sync and check that prices appeared in the database? If the task was 'add an admin config field', did you open the admin page and see the field? If you only ran DI compilation and syntax checks, you validated nothing.

1. Re-read your validation contract. If it only has compilation/syntax/config checks, it's useless. Rewrite it with tests that prove the feature works: run the command and check the output, query the database for real data, open the page in the browser.
2. Dispatch wario-qa with the rewritten contract. The QA agent will try to actually run your feature.
3. If QA reports BLOCKED — can you unblock it? Check configs, credentials, env status. Try before giving up.
4. If QA reports ISSUES — fix them, commit, push.
5. If you truly need something external (credentials, API access, test data you can't create), write turn-result.json with status \"blocked\", explain exactly what's needed, and post to JIRA."

elif [[ $NEXT -ge $((MAX_ITERATIONS)) ]]; then
  # Final iteration — ship or block, no middle ground
  PROMPT="Iteration $NEXT/$MAX_ITERATIONS (FINAL). This is your last pass. Ship it or report what's blocking you.

1. Read the QA results. If the core feature was validated with real data — open a PR if you haven't already.
2. If QA couldn't validate the core feature and reported BLOCKED — do NOT open a PR pretending it works. Write turn-result.json with status \"blocked\", post the QA blocker details to JIRA, and explain exactly what a human needs to provide.
3. If the PR is already open, make sure it's pushed with your latest fixes and the description honestly reflects what was validated and what wasn't."

else
  # Middle iterations — act on specific QA findings
  PROMPT="Iteration $NEXT/$MAX_ITERATIONS. Read the QA results from your last wario-qa dispatch.

For each FAIL or BLOCKED item:
- FAIL: the QA agent tried and it didn't work. Read what they tried, what happened, and fix the root cause. Don't just re-run — understand WHY it failed.
- BLOCKED: the QA agent couldn't test it. Can YOU unblock it? Check if the env is running, if credentials are configured, if there's test data you can create or query for. Try to make the test runnable, then re-dispatch wario-qa.

If all items passed: look at the QA evidence. Is the evidence real? 'Processed: 0 items' is not a pass. 'No errors' is not a pass. You need positive evidence — actual data, actual output, actual visible results.

Commit and push any fixes. If you need something external, write turn-result.json \"blocked\" and post to JIRA."
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
