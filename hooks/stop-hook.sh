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

# Also check common misplaced paths (agent sometimes writes to wario root or cwd)
for candidate in "$TURN_RESULT" "$WARIO_ROOT/turn-result.json" "./turn-result.json"; do
  if [[ -f "$candidate" ]] && [[ "$candidate" != "$TURN_RESULT" ]]; then
    # Move misplaced file to correct location
    mkdir -p "$(dirname "$TURN_RESULT")"
    mv "$candidate" "$TURN_RESULT"
    break
  fi
done

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

# --- Build iteration-specific prompt for the PM ---

read -r -d '' CHECKLIST << 'CHECKLIST_EOF' || true
Review your coordination so far. Answer honestly:

## Critique — challenge your results
- **Assume previous results might be wrong.** If QA reported "no data found" or "empty response" — that is more likely a code bug (wrong field names, wrong response parsing, wrong query) than genuinely empty data. Dispatch the coder to verify the API response structure matches what the code expects.
- If the feature "works" but produces zero output — that's a bug, not a success. Real integrations produce real data.
- Re-read the JIRA issue with fresh eyes. What would a skeptical human ask about your results? Ask that question now.

## QA Results
- Did QA actually run the feature (not just compilation checks)?
- Does QA have positive evidence (DB rows, real output, screenshots) — or just "no errors"?
- If QA reported BLOCKED — did you try to unblock it before accepting? (start env, set config, find test data)
- If QA reported ISSUES — did you send them to the coder with specific details?

## Completeness
- Re-read the JIRA issue. Is every acceptance criterion covered by QA evidence?
- Did the coder implement everything, or are there gaps, stubs, or TODOs?

## JIRA Status
- If the core feature can't be tested — did you post the blocker to JIRA with exactly what a human needs to provide?
- Is the JIRA ticket in the right status? ("In Review" if shipping, "PM Action" if blocked)
CHECKLIST_EOF

if [[ $NEXT -eq 1 ]]; then
  read -r -d '' PROMPT << PROMPT_EOF || true
Iteration $NEXT/$MAX_ITERATIONS. The coder finished their first pass. Now verify the work is real.

1. Dispatch wario-qa to test the actual feature — not compilation, not config checks. The real feature with real data.
2. If QA reports VALIDATED with evidence → review the diff yourself (Phase 4), then finalize.
3. If QA reports ISSUES → send the failures to the coder to fix, then re-dispatch QA.
4. If QA reports BLOCKED → can you help unblock? (start env, set config, find test data). If it truly needs something external, write turn-result.json "blocked" and post to JIRA.

$CHECKLIST
PROMPT_EOF

elif [[ $NEXT -ge $MAX_ITERATIONS ]]; then
  read -r -d '' PROMPT << PROMPT_EOF || true
Iteration $NEXT/$MAX_ITERATIONS (FINAL). Make a decision now.

If QA validated the core feature with positive evidence:
→ Open the PR (Phase 5). Include QA evidence in the PR body. Transition JIRA to "In Review". Write turn-result.json "done".

If QA could NOT validate the core feature:
→ Do NOT open a PR. Post the blocker to JIRA with exactly what a human needs to provide. Transition to "PM Action". Write turn-result.json "blocked".

$CHECKLIST
PROMPT_EOF

else
  read -r -d '' PROMPT << PROMPT_EOF || true
Iteration $NEXT/$MAX_ITERATIONS. Be the skeptic. Assume the previous iteration's results are incomplete or wrong until proven otherwise.

Read the QA report from last iteration:
- FAIL items: send specific failure details to the coder. When coder fixes, re-dispatch QA.
- BLOCKED items: can you unblock? Check env, credentials, test data. If unblockable, re-dispatch QA. If truly external, write turn-result.json "blocked" and post to JIRA.
- PASS items: is the evidence real? "No errors" with zero data processed is not a pass. Zero results from an API that should return data means the code is wrong, not the data.

Also read the diff (git diff). Check the actual API response parsing — are field names correct? Is the response nested when the code assumes flat? Are there type mismatches?

$CHECKLIST
PROMPT_EOF
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
