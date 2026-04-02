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
CHECKLIST="Answer each question honestly. If the answer is NO, fix it before continuing.

## Functionality
- Did you actually RUN the feature you built (not just compile it)? If the task was to sync data, did you run the sync? If it was to add a UI field, did you open the page?
- Did real data flow through your code? Not zero items, not empty responses — actual data processed, actual output visible.
- Can you point to specific evidence (DB rows, command output, screenshot) that proves each acceptance criterion is met?

## Completeness
- Re-read the JIRA issue. Is every acceptance criterion implemented? Is anything missing or half-done?
- Are there placeholders, TODOs, hardcoded values, or empty handlers in your code?
- Are new files/components actually wired in (imported, registered, called) — or do they exist but nothing uses them?

## Reporting
- If something doesn't work or you can't test it — did you post to JIRA explaining exactly what's blocked and what a human needs to provide?
- If QA found issues — did you understand the root cause (not just retry)?

## Code Quality
- Read the diff. Is there dead code, unused imports, scope creep, or over-engineering beyond what was asked?
- Does your code follow the project's existing patterns, or did you introduce new ones where existing patterns work?
- Can any of it be simplified without changing behavior? Reduce nesting, consolidate logic, remove unnecessary abstractions."

if [[ $NEXT -eq 1 ]]; then
  # After first implementation — assume everything is broken
  PROMPT="Iteration $NEXT/$MAX_ITERATIONS. Your implementation is not verified yet. Assume it doesn't work until you prove otherwise.

Your task was described in the JIRA issue. Re-read it now. Then ask yourself: did you actually DO the thing it asked for, or did you just write code that should theoretically do it?

If your validation contract only has compilation/syntax/config checks — rewrite it. You need tests that prove the feature works with real data.

Dispatch wario-qa with the contract. If QA reports BLOCKED, try to unblock it yourself (check configs, start the env, find test data). Only report \"blocked\" if you truly need something external.

$CHECKLIST"

elif [[ $NEXT -ge $((MAX_ITERATIONS)) ]]; then
  # Final iteration — ship or block, no middle ground
  PROMPT="Iteration $NEXT/$MAX_ITERATIONS (FINAL). Ship it or block it. No middle ground.

If QA validated the core feature with real evidence — open a PR (if not already open), make sure it's pushed with latest fixes, and the description honestly lists what was validated and what wasn't.

If QA could NOT validate the core feature — do NOT open a PR pretending it works. Write turn-result.json \"blocked\", post the blocker to JIRA with exactly what a human needs to provide.

$CHECKLIST"

else
  # Middle iterations — act on QA results + improve
  PROMPT="Iteration $NEXT/$MAX_ITERATIONS. Read the QA results from your last wario-qa dispatch.

For each FAIL: understand WHY it failed (read what QA tried, what happened). Fix the root cause, don't just retry.
For each BLOCKED: can you unblock it? Check env, credentials, test data. Try to make the test runnable, then re-dispatch wario-qa.
If all passed: is the evidence real? 'Processed: 0 items' is not a pass. 'No errors' is not a pass.

Commit and push fixes. If you need something external, write turn-result.json \"blocked\" and post to JIRA.

$CHECKLIST"
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
